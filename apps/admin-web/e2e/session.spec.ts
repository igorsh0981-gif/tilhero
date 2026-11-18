/** Contract handling of admin.ts: CSRF, 401 → sign-in, 409 SESSION_ROTATED → one repeat, STEP_UP_REQUIRED, X-Background. */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { TOTP } from "./fixtures/data";

test("every non-GET carries X-CSRF-Token = Me.csrf_token; GETs never do", async ({ page }) => {
  const bff = await openAs(page, "support@tilhero.local", "#/support");
  await page.getByTestId("take-TCK-1042").click();
  await expect(page.getByTestId("thread")).toBeVisible();
  const take = bff.calls("POST", /\/take$/)[0]!;
  expect(take.headers["x-csrf-token"]).toBe(bff.session!.csrf);
  expect(bff.requests.filter((r) => r.method === "GET").every((r) => !r.headers["x-csrf-token"])).toBe(true);
});

test("401 SESSION_REVOKED → back to the sign-in screen with a notice", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/overview");
  bff.revoke();
  await page.locator('[data-nav="audit"]').click();
  await expect(page.getByTestId("login-creds")).toBeVisible();
  await expect(page.getByTestId("login-notice")).toBeVisible();
});

test("409 SESSION_ROTATED: Me is re-read (new CSRF) and the command is repeated once with the same Idempotency-Key", async ({ page }) => {
  const bff = await openAs(page, "support@tilhero.local", "#/support/TCK-1042", { rotateOnce: "POST /support/tickets/b1000000-0000-4000-8000-000000001042/messages" });
  await page.getByTestId("composer-text").fill("Здравствуйте! Проверяем оценку.");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("msg-op").last()).toContainText("Проверяем оценку");
  const sends = bff.calls("POST", "/support/tickets/b1000000-0000-4000-8000-000000001042/messages");
  expect(sends).toHaveLength(2);
  expect(sends[1]!.headers["idempotency-key"]).toBe(sends[0]!.headers["idempotency-key"]);
  expect(sends[1]!.headers["x-csrf-token"]).toBe(bff.session!.csrf);
  expect(sends[1]!.headers["x-csrf-token"]).not.toBe(sends[0]!.headers["x-csrf-token"]);
});

test("a dismissed step-up cancels the command without an error toast; a wrong code is reported", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/config");
  await page.getByTestId("activate-1.0.1").click();
  await page.locator("#cmd-reason").fill("Тёмнее ручка для контраста");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", "000000");
  await expect(page.getByTestId("stepup")).toContainText("Осталось попыток");
  await page.getByTestId("stepup").getByRole("button", { name: "Отмена" }).click();
  await expect(page.getByTestId("cfg-confirm")).toContainText("Действие отменено");
  expect(bff.current.miniapp).toBe("1.0.0");
  // second try with the right code
  await page.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("ver-1.0.1")).toContainText("активна");
  expect(bff.current.miniapp).toBe("1.0.1");
});

test("polls of the overview are X-Background and do not touch the session", async ({ page }) => {
  await page.clock.install();
  const bff = await openAs(page, "admin@tilhero.local", "#/overview");
  await expect(page.getByTestId("block-learners")).toBeVisible();
  const before = bff.calls("GET", "/dashboard").length;
  await page.clock.runFor(61_000);
  await expect.poll(() => bff.calls("GET", "/dashboard").length).toBeGreaterThan(before);
  expect(bff.calls("GET", "/dashboard").at(-1)!.headers["x-background"]).toBe("1");
});
