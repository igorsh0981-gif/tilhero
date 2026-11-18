import { expect, test } from "@playwright/test";
import { openAs, shot, typeOtp } from "./helpers";

test("add a staff member: step-up modal (TOTP) → temporary password shown once", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/roles");
  await page.getByTestId("roles-tab-staff").click();
  await expect(page.getByTestId("staff-table")).toBeVisible();
  await shot(page, "13-roles-staff");
  await page.getByTestId("staff-add").click();
  await page.locator("#sn-email").fill("karina@tilhero.local");
  await page.locator("#sn-name").fill("Карина");
  await page.getByTestId("staff-create").click();

  // 403 STEP_UP_REQUIRED → the TOTP dialog; a wrong code keeps it open, the right one retries the command once
  await expect(page.getByTestId("stepup")).toBeVisible();
  await shot(page, "13s-step-up");
  await typeOtp(page, "stepup", "111111");
  await expect(page.getByTestId("stepup")).toContainText("Осталось попыток");
  await typeOtp(page, "stepup", "123456");
  await expect(page.getByTestId("staff-created")).toBeVisible();
  await expect(page.getByTestId("new-temp-password")).toHaveText("Tmp-9xQ2-mK7v-Lp4w-Zr8");
  await shot(page, "13c-staff-added");
  const posts = bff.calls("POST", "/staff");
  expect(posts).toHaveLength(2);
  expect(posts[1]!.headers["idempotency-key"]).toBe(posts[0]!.headers["idempotency-key"]);
  expect(posts[1]!.body).toEqual({ email: "karina@tilhero.local", display_name: "Карина", role: "support" });
  await page.getByTestId("staff-add-close").click();
  await expect(page.getByTestId("new-temp-password")).toHaveCount(0);
  await expect(page.locator('[data-staff="karina@tilhero.local"]')).toContainText("смена при входе");
});

test("block a staff member through an in-page confirmation with a reason; last super admin is protected by the backend", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/roles");
  await page.getByTestId("roles-tab-staff").click();
  await page.getByTestId("staff-menu-ops@tilhero.local").click();
  await page.getByTestId("staff-block").click();
  const dlg = page.getByTestId("staff-confirm");
  await expect(dlg).toBeVisible();
  await page.getByTestId("confirm-ok").click();
  await expect(dlg).toContainText("не короче 5");
  await dlg.locator("textarea").fill("Ушёл из команды");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", "123456");
  await expect(page.locator('[data-staff="ops@tilhero.local"]')).toContainText("Доступ отозван");
  expect(bff.calls("PATCH", /\/staff\//).at(-1)!.body).toEqual({ status: "DISABLED", reason: "Ушёл из команды" });
});

test("permission matrix: a change is a four-eyes request; the second super admin approves it with step-up", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/roles");
  await expect(page.getByTestId("matrix")).toBeVisible();
  await expect(page.getByTestId("pm-super_admin-roles.manage")).toBeDisabled();
  await page.getByTestId("pm-support-export.csv").click();
  await page.getByTestId("perm-confirm").locator("textarea").fill("Выгрузка очереди для отчёта");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", "123456");
  await expect(page.getByTestId("approvals")).toContainText("Права роли");
  await expect(page.getByTestId("approvals")).toContainText("+export.csv");
  // own request — cannot be approved by the author
  await expect(page.getByTestId("approval-row").first()).toContainText("ваша заявка");
  await expect(page.getByTestId("pm-support-export.csv")).toBeDisabled();
  expect(bff.matrix.support).not.toContain("export.csv");

  // a request of the other super admin can be approved
  bff.seedApproval();
  await page.reload();
  await expect(page.getByTestId("apr-approve")).toBeVisible();
  await shot(page, "13-roles-matrix");
  await page.getByTestId("apr-approve").click();
  await page.getByTestId("apr-confirm").locator("textarea").fill("Согласовано с безопасностью");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("toasts")).toContainText("одобрена");
  expect(bff.matrix.support).toContain("export.csv");
});

test("reset password: the temporary password is shown with a 60 s countdown and leaves the DOM when the tab is left", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/roles");
  await page.getByTestId("roles-tab-staff").click();
  await page.getByTestId("staff-menu-support@tilhero.local").click();
  await page.getByTestId("staff-reset").click();
  await page.getByTestId("staff-confirm").locator("textarea").fill("Сотрудник забыл пароль");
  await page.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", "123456");
  await expect(page.getByTestId("temp-password")).toHaveText("Rst-4bN8-qW2e-Ty6u-Io0");
  await expect(page.getByTestId("temp-countdown")).toHaveText(/^0[01]:\d\d$/);
  await page.getByTestId("roles-tab-matrix").click();
  await page.getByTestId("roles-tab-staff").click();
  await expect(page.getByTestId("temp-banner")).toHaveCount(0);
  expect(await page.content()).not.toContain("Rst-4bN8-qW2e-Ty6u-Io0");
});

test("privileged reset is a four-eyes request: the author never sees the password, the approver gets it once", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/roles");
  await page.getByTestId("roles-tab-staff").click();
  await page.getByTestId("staff-menu-ops@tilhero.local").click();
  await page.getByTestId("staff-reset").click();
  await page.getByTestId("staff-confirm").locator("textarea").fill("Подозрение на компрометацию");
  await page.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", "123456");
  await expect(page.getByTestId("reset-requested")).toContainText("нужен второй администратор");
  await expect(page.getByTestId("toasts")).toContainText("нужен второй администратор");
  await expect(page.getByTestId("temp-banner")).toHaveCount(0);
  await expect(page.getByTestId("approvals")).toContainText("Тимур: сброс пароля");
  await expect(page.getByTestId("approval-row").first()).toContainText("ваша заявка");
  expect(await page.content()).not.toMatch(/Rst-|Apr-7cV3/);

  // the second super admin signs in and approves (with step-up) → the password is shown to them, once
  bff.switchTo("security@tilhero.local");
  await page.reload();
  await expect(page.getByTestId("apr-approve")).toBeVisible();
  await page.getByTestId("apr-approve").click();
  await page.getByTestId("apr-confirm").locator("textarea").fill("Подтверждаю сброс");
  await page.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", "123456");
  await expect(page.getByTestId("issued-password")).toHaveText("Apr-7cV3-pZ9k-Wq2m-Hx5");
  await expect(page.getByTestId("issued-banner")).toContainText("ops@tilhero.local");
  expect(bff.staffById(bff.account("ops@tilhero.local")!.staff.staff_id)!.must_change_password).toBe(true);
  // hidden on demand (and after 60 s / when the tab is hidden — unit-tested)
  await page.getByTestId("issued-banner").getByRole("button", { name: "Скрыть" }).click();
  await expect(page.getByTestId("issued-password")).toHaveCount(0);
});
