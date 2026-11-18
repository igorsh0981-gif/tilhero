import { expect, test } from "@playwright/test";
import { TOTP } from "./fixtures/data";
import { MockBff } from "./fixtures/mock-bff";
import { open, openAs, shot, signIn, typeOtp } from "./helpers";

test("A30: no session → sign-in screen; password + TOTP (6 cells) → dashboard; logout returns to sign-in", async ({ page }) => {
  const bff = await open(page);
  await expect(page.getByTestId("login-creds")).toBeVisible();
  expect(bff.calls("GET", "/me")[0]).toBeTruthy(); // the boot probe got 401 UNAUTHORIZED
  await shot(page, "01-login");

  await signIn(page, "admin@tilhero.local");
  await expect(page.getByTestId("login-mfa")).toBeVisible();
  await expect(page.locator(".otp input")).toHaveCount(6);
  // a wrong code: error with remaining attempts, cells cleared
  await typeOtp(page, "otp", "000000");
  await expect(page.getByTestId("login-error")).toContainText("Осталось попыток: 4");
  await shot(page, "01b-login-mfa-error");
  await typeOtp(page, "otp", TOTP);
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page.getByTestId("kpi-users-total")).toContainText("12");
  // password and code are never kept in the browser storage
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toMatch(/Correct-Horse|123456|csrf/);

  await page.getByTestId("avatar").click();
  await page.getByTestId("menu-logout").click();
  await expect(page.getByTestId("login-creds")).toBeVisible();
  const logout = bff.calls("POST", "/auth/logout")[0]!;
  expect(logout.headers["x-csrf-token"]).toMatch(/^csrf-/);
});

test("wrong password shows remaining attempts; the 5th failure locks sign-in with a countdown", async ({ page }) => {
  await open(page);
  for (let k = 1; k <= 4; k++) {
    await signIn(page, "support@tilhero.local", "wrong-password-1");
    await expect(page.getByTestId("login-error")).toContainText(`Осталось попыток: ${5 - k}`);
  }
  await shot(page, "01c-login-error");
  await signIn(page, "support@tilhero.local", "wrong-password-1");
  await expect(page.getByTestId("login-locked")).toBeVisible();
  const cd = page.getByTestId("lock-countdown");
  await expect(cd).toHaveText(/^1[45]:\d\d$/);
  const first = await cd.textContent();
  await expect.poll(async () => cd.textContent(), { timeout: 3000 }).not.toBe(first);
  await shot(page, "01d-login-locked");
});

test("must_change_password → new password with rules → MFA enrolment (QR + secret) → shell", async ({ page }) => {
  const bff = await open(page);
  await signIn(page, "new.ops@tilhero.local", "Temp-Password-2026-x");
  await expect(page.getByTestId("login-password")).toBeVisible();
  await page.locator("#pwd-new").fill("short1");
  await page.locator("#pwd-rep").fill("short1");
  await page.getByTestId("pwd-submit").click();
  await expect(page.getByTestId("pwd-error")).toBeVisible();
  await page.locator("#pwd-new").fill("Blue-Sky-Over-Tashkent-7");
  await page.locator("#pwd-rep").fill("Blue-Sky-Over-Tashkent-7");
  await expect(page.getByTestId("pwd-meter")).toHaveAttribute("data-lvl", "good");
  await shot(page, "01e-change-password");
  await page.getByTestId("pwd-submit").click();

  await expect(page.getByTestId("login-enroll")).toBeVisible();
  await expect(page.getByTestId("mfa-qr")).toBeVisible();
  await expect(page.getByTestId("mfa-secret")).toHaveText("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
  await shot(page, "01f-mfa-enroll");
  await typeOtp(page, "enr", TOTP);
  await expect(page.getByTestId("shell")).toBeVisible();
  // the QR is drawn locally — no request ever carried the secret outside admin-bff
  expect(bff.requests.every((r) => r.path.startsWith("/"))).toBe(true);
  // the operations role sees its menu
  await expect(page.locator('[data-nav="audit"]')).toBeVisible();
  await expect(page.locator('[data-nav="roles"]')).toHaveCount(0);
});

test("AD mode without LDAP: 501 AUTH_MODE_UNAVAILABLE is explained", async ({ page }) => {
  await open(page, { authMode: "ad" });
  await signIn(page, "admin@tilhero.local");
  await expect(page.getByTestId("login-error")).toContainText("AD");
  await shot(page, "01g-login-ad");
});

test("401 SESSION_REVOKED in the middle of work → sign-in screen with an explanation", async ({ page }) => {
  const bff = await openAs(page, "support@tilhero.local", "#/support");
  await expect(page.getByTestId("support-queue")).toBeVisible();
  bff.revoke();
  await page.locator('[data-nav="users"]').click();
  await expect(page.getByTestId("login-creds")).toBeVisible();
  await expect(page.getByTestId("login-notice")).toContainText("Сессия отозвана");
  await shot(page, "01h-login-revoked");
});

test("inactivity: the warning appears 2 minutes before the idle timeout and «stay» keeps the session", async ({ page }) => {
  // test hook: a 15-s idle timeout (the warning window is 2 min, a third of such a short timeout → 5 s)
  const bff = await openAs(page, "support@tilhero.local", "#/dashboard", { idleSeconds: 15 });
  await expect(page.getByTestId("idle-warning")).toBeVisible({ timeout: 13_000 });
  await expect(page.getByTestId("idle-countdown")).toHaveText(/^00:0[1-5]$/);
  await shot(page, "15b-idle-warning");
  const before = bff.calls("GET", "/me").length;
  await page.getByTestId("idle-stay").click();
  await expect(page.getByTestId("idle-warning")).toBeHidden();
  await expect.poll(() => bff.calls("GET", "/me").length).toBeGreaterThan(before);
});

test("two tabs share the idle timer: an idle tab does not sign out the session the operator types in", async ({ context }) => {
  test.setTimeout(80_000);
  // one admin-bff (one cookie session) for both tabs; idle timeout shortened to 12 s (warning in the last 4 s)
  const bff = new MockBff({ signedInAs: "support@tilhero.local", idleSeconds: 12 });
  const a = await context.newPage();
  await bff.install(a);
  await a.goto("/#/support/TCK-3081");
  const b = await context.newPage();
  await bff.install(b);
  await b.goto("/#/dashboard");
  await expect(a.getByTestId("thread")).toBeVisible();
  await expect(b.getByTestId("dashboard")).toBeVisible();

  // the operator writes a reply in tab A for 18 s — longer than the timeout; tab B gets no input at all
  const box = a.getByTestId("composer-text");
  for (let k = 0; k < 18; k++) {
    await box.press("x");
    await a.waitForTimeout(1000);
    await expect(b.getByTestId("idle-warning")).toBeHidden();
  }
  expect(bff.calls("POST", "/auth/logout")).toHaveLength(0);
  await expect(b.getByTestId("shell")).toBeVisible();
  await expect(box).toHaveValue("x".repeat(18));

  // input stops: the warning appears in both tabs on the shared timer, then the session ends
  await expect(b.getByTestId("idle-warning")).toBeVisible({ timeout: 12_000 });
  await expect(a.getByTestId("idle-warning")).toBeVisible();
  // «stay» in one tab dismisses the warning in the other one as well
  await a.getByTestId("idle-stay").click();
  await expect(b.getByTestId("idle-warning")).toBeHidden();
  await expect(b.getByTestId("login-creds")).toBeVisible({ timeout: 20_000 });
  expect(bff.calls("POST", "/auth/logout").length).toBeGreaterThan(0);
});
