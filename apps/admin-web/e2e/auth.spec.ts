/** AT-16: sign-in with password + TOTP (6 cells), first sign-in (new password + MFA enrolment with a QR), lock. */
import { expect, test } from "@playwright/test";
import { open, signIn, typeOtp } from "./helpers";
import { PASSWORD, TOTP } from "./fixtures/data";

test("no session → sign-in screen; password + TOTP → the shell with the role's start screen", async ({ page }) => {
  const bff = await open(page, {}, "#/audit");
  await expect(page.getByTestId("login-creds")).toBeVisible();
  await signIn(page, "admin@tilhero.local");
  await expect(page.getByTestId("login-mfa")).toBeVisible();
  // six one-digit cells, filled by typing; the code is sent when the 6th digit is entered
  await expect(page.locator(".otp input")).toHaveCount(6);
  await typeOtp(page, "otp", "000000");
  await expect(page.getByTestId("login-error")).toContainText("Осталось попыток: 4");
  await typeOtp(page, "otp", TOTP);
  await expect(page.getByTestId("shell")).toBeVisible();
  await expect(page.getByTestId("page-audit")).toBeVisible();
  // the password and the code never travel outside the sign-in calls; the challenge is one-time
  const mfa = bff.calls("POST", "/auth/mfa");
  expect(mfa.at(-1)!.body).toMatchObject({ code: TOTP });
  // the admin theme is requested right after the phase change (async): poll instead of a one-shot read (review T2-4)
  await expect.poll(() => bff.calls("GET", "/experience/admin/current").length).toBe(1);
});

test("wrong password counts down and 5 failures lock the sign-in for 15 minutes", async ({ page }) => {
  await open(page);
  for (let n = 4; n >= 1; n--) {
    await signIn(page, "support@tilhero.local", "wrong-password-1");
    await expect(page.getByTestId("login-error")).toContainText(`Осталось попыток: ${n}`);
  }
  await signIn(page, "support@tilhero.local", "wrong-password-1");
  await expect(page.getByTestId("login-locked")).toBeVisible();
  await expect(page.getByTestId("lock-countdown")).toHaveText(/1[45]:\d\d/);
});

test("first sign-in: temporary password → new password → MFA enrolment with a QR → shell", async ({ page }) => {
  const bff = await open(page);
  await signIn(page, "newbie@tilhero.local", "Temp-Pass-0001");
  await expect(page.getByTestId("login-password")).toBeVisible();
  await page.locator("#pwd-new").fill("short1");
  await page.locator("#pwd-rep").fill("short1");
  await page.getByTestId("pwd-submit").click();
  await expect(page.getByTestId("pwd-error")).toBeVisible();
  await page.locator("#pwd-new").fill("Orbit-Tulip-2026");
  await page.locator("#pwd-rep").fill("Orbit-Tulip-2026");
  await page.getByTestId("pwd-submit").click();
  await expect(page.getByTestId("login-enroll")).toBeVisible();
  // the QR is drawn locally (no external QR service: the secret never leaves the page)
  await expect(page.getByTestId("mfa-qr")).toBeVisible();
  await expect(page.getByTestId("mfa-secret")).toContainText("JBSW");
  await typeOtp(page, "enr", TOTP);
  await expect(page.getByTestId("shell")).toBeVisible();
  expect(bff.account("newbie@tilhero.local")!.staff.mfa_enabled).toBe(true);
});

test("sign-out the server did not confirm (503 SESSION_NOT_REVOKED, review T2-10): the sign-in screen warns to close the browser", async ({ page }) => {
  await open(page, { signedInAs: "support@tilhero.local", logoutNotRevoked: true });
  await expect(page.getByTestId("shell")).toBeVisible();
  await page.getByTestId("avatar").click();
  await page.getByTestId("menu-logout").click();
  await expect(page.getByTestId("login-creds")).toBeVisible();
  await expect(page.getByTestId("login-notice")).toContainText("Выход не подтверждён сервером");
  await expect(page.getByTestId("login-notice")).toContainText("закройте браузер");
});

test("sign-out returns to the sign-in screen and the session is gone", async ({ page }) => {
  const bff = await open(page, { signedInAs: "support@tilhero.local" });
  await expect(page.getByTestId("shell")).toBeVisible();
  await page.getByTestId("avatar").click();
  await page.getByTestId("menu-logout").click();
  await expect(page.getByTestId("login-creds")).toBeVisible();
  await expect(page.getByTestId("login-notice")).toHaveCount(0);
  expect(bff.session).toBeNull();
  await signIn(page, "support@tilhero.local", PASSWORD);
  await expect(page.getByTestId("shell")).toBeVisible();
});
