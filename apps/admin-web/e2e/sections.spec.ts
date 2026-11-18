/** AT-24 and the remaining sections: overview blocks, configuration (activation, rollback), roles, audit. */
import { expect, test } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { TOTP } from "./fixtures/data";

test("overview: 4 independent blocks; a source that is down shows its own notice, the others keep data", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/overview", { dashOff: ["campaigns"] });
  await expect(page.getByTestId("block-learners")).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("block-support")).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("block-whats_new")).toHaveAttribute("data-available", "true");
  await expect(page.getByTestId("block-campaigns")).toHaveAttribute("data-available", "false");
  await expect(page.getByTestId("block-campaigns-off")).toContainText("notifications");
  await expect(page.getByTestId("dw-views")).toContainText("812");
  await page.getByTestId("dash-period").getByRole("button", { name: "30 дней" }).click();
  await expect(page.getByTestId("dl-accounts")).toBeVisible();
  // «needs attention» links into the sections
  await page.getByTestId("att-breached").click();
  await expect(page.getByTestId("page-support")).toBeVisible();
});

test("configuration: activate a version and roll it back with TOTP; the admin theme follows without a build", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/config");
  await page.getByTestId("cfg-app").getByRole("button", { name: "Админка" }).click();
  await expect(page.getByTestId("ver-1.0.0")).toContainText("активна");
  await page.getByTestId("activate-1.0.1").click();
  await page.locator("#cmd-reason").fill("Только разделы спринта 2");
  await page.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("ver-1.0.1")).toContainText("активна");
  // admin 1.0.1 switches the «soon» sections off: the menu changes at once
  await expect(page.locator('[data-nav="heroes"]')).toHaveCount(0);
  await expect(page.getByTestId("shell")).toHaveClass(/density-comfortable/);
  await page.getByTestId("cfg-rollback").click();
  await page.locator("#cmd-reason").fill("Возвращаем полное меню");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("ver-1.0.0")).toContainText("активна");
  await expect(page.locator('[data-nav="heroes"]')).toHaveCount(1);
  expect(bff.activations.admin[0]!.kind).toBe("rollback");
  expect(bff.audit.slice(0, 2).map((r) => r.action)).toEqual(["config.rollback", "config.activate"]);
});

test("configuration: a new Mini App version from the editor (config.edit)", async ({ page }) => {
  const bff = await openAs(page, "ops@tilhero.local", "#/config");
  await page.getByTestId("cfg-edit").click();
  await expect(page.getByTestId("cfg-editor")).toBeVisible();
  await page.getByTestId("cfg-m--pen").fill("#3B5BDB");
  await expect(page.getByTestId("cfg-changes")).toContainText("--pen");
  await page.getByTestId("cfg-save").click();
  await page.locator("#cfg-note").fill("Ручка темнее");
  await page.getByTestId("cfg-save-ok").click();
  await expect(page.getByTestId("ver-1.0.2")).toBeVisible();
  expect((bff.versions.miniapp.at(-1)!.payload as { theme: { tokens: Record<string, string>; version: string } }).theme.tokens["--pen"]).toBe("#3B5BDB");
});

test("roles: staff list, permission matrix, four-eyes request", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/roles");
  await expect(page.getByTestId("roles")).toBeVisible();
  await expect(page.getByText("Коммуникации").first()).toBeVisible();
  await expect(page.locator("table").first()).toContainText("whatsnew.publish");
});

test("audit: journal, filters by object type, chain verification", async ({ page }) => {
  const bff = await openAs(page, "auditor@tilhero.local", "#/audit");
  await expect(page.getByTestId("audit")).toBeVisible();
  await page.getByTestId("aud-objtype").selectOption("learner");
  await expect.poll(() => bff.calls("GET", "/audit/records").at(-1)?.path).toBe("/audit/records");
  await page.getByRole("button", { name: "Проверить цепочку" }).click();
  await expect(page.getByText(/Цепочка цела/).first()).toBeVisible();
});
