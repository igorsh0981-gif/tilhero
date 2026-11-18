/**
 * Four-eyes for privileged accounts (review P2-1 / P2-2): the author of a privileged account never sees its
 * temporary password — the approver gets it, once; re-enabling a disabled privileged account is a request.
 */
import { expect, test, type Page } from "@playwright/test";
import { openAs, typeOtp } from "./helpers";
import { TOTP } from "./fixtures/data";

async function staffTab(page: Page): Promise<void> {
  await page.getByTestId("roles-tab-staff").click();
  await expect(page.getByTestId("staff-table")).toBeVisible();
}

async function approveAs(page: Page, bff: { switchTo(e: string): void }, email: string, who: string, kind: string): Promise<void> {
  bff.switchTo(email);
  await page.reload();
  const row = page.getByTestId("approval-row").filter({ hasText: who });
  await expect(row).toContainText(kind);
  await row.getByTestId("apr-approve").click();
  await expect(page.getByTestId("apr-issues-pwd")).toContainText("Пароль покажем вам один раз");
  await page.locator("#cmd-reason").fill("Согласовано с руководителем");
  await page.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", TOTP);
}

test("privileged account: the author gets no password; the approver gets it once", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/roles");
  await staffTab(page);
  await page.getByTestId("staff-add").click();
  await page.locator("#sn-email").fill("ghost@tilhero.local");
  await page.locator("#sn-name").fill("Гость Г.");
  await page.getByTestId("sn-role").selectOption("super_admin");
  await expect(page.getByTestId("staff-add-drawer")).toContainText("Временный пароль получит согласующий");
  await page.getByTestId("staff-create").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("staff-created")).toBeVisible();
  await expect(page.getByTestId("pwd-to-approver")).toHaveText("Временный пароль получит согласующий — вам он не показывается.");
  await expect(page.getByTestId("new-temp-password")).toHaveCount(0);
  await expect(page.getByText(/Temp-Pass/)).toHaveCount(0);
  await page.getByTestId("staff-add-close").click();
  // until approved the account works as Read Only and the row names the requested role
  await expect(page.locator('[data-staff="ghost@tilhero.local"]')).toContainText("заявка: → Super Admin");

  await approveAs(page, bff, "security@tilhero.local", "ghost@tilhero.local", "Новый сотрудник");
  await expect(page.getByTestId("issued-banner")).toContainText("ghost@tilhero.local");
  await expect(page.getByTestId("issued-password")).toHaveText("Temp-Pass-5555");
  expect(bff.account("ghost@tilhero.local")!.staff.role).toBe("super_admin");
});

test("re-enabling a disabled privileged account is sent for approval; the approver gets the new password", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/roles");
  await staffTab(page);
  await page.getByTestId("staff-menu-former@tilhero.local").click();
  await page.getByTestId("staff-unblock").click();
  await expect(page.getByTestId("staff-confirm")).toContainText("только по заявке");
  await expect(page.getByTestId("confirm-ok")).toHaveText("Отправить на подтверждение");
  await page.locator("#cmd-reason").fill("Вернулся из отпуска");
  await page.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("reactivate-requested")).toContainText("Отправлено на согласование: включение Бахром");
  await expect(page.locator('[data-staff="former@tilhero.local"]')).toContainText("ждёт согласования включения");
  await expect(page.getByTestId("approval-row").filter({ hasText: "Бахром" })).toContainText("Включение привилегированного");
  expect(bff.account("former@tilhero.local")!.staff.status).toBe("DISABLED");

  await approveAs(page, bff, "security@tilhero.local", "Бахром", "Включение привилегированного");
  await expect(page.getByTestId("issued-password")).toHaveText("Temp-Pass-5555");
  expect(bff.account("former@tilhero.local")!.staff.status).toBe("ACTIVE");
});

test("English UI names the new request kind", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/roles");
  await staffTab(page);
  await page.getByTestId("staff-menu-former@tilhero.local").click();
  await page.getByTestId("staff-unblock").click();
  await page.locator("#cmd-reason").fill("Back from leave");
  await page.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", TOTP);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.getByTestId("approval-row").filter({ hasText: "Бахром" })).toContainText("Privileged re-enable");
  expect(bff.calls("PATCH", /\/staff\//)[0]!.body).toMatchObject({ status: "ACTIVE" });
});

test("single super_admin: a waived request applies at once and its temporary password is shown once (StaffPatchPending)", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/roles", { singleSuperAdmin: true });
  await staffTab(page);
  await page.getByTestId("staff-menu-former@tilhero.local").click();
  await page.getByTestId("staff-unblock").click();
  await page.locator("#cmd-reason").fill("Вернулся из отпуска");
  await page.getByTestId("confirm-ok").click();
  await typeOtp(page, "stepup", TOTP);
  await expect(page.getByTestId("temp-banner")).toContainText("former@tilhero.local");
  await expect(page.getByTestId("temp-password")).toHaveText("Temp-Pass-5555");
  await expect(page.getByTestId("reactivate-requested")).toHaveCount(0);
  expect(bff.account("former@tilhero.local")!.staff.status).toBe("ACTIVE");

  // creating a privileged account: approval APPLIED (waived) + the password to the author himself, once
  await page.getByTestId("staff-add").click();
  await page.locator("#sn-email").fill("second@tilhero.local");
  await page.locator("#sn-name").fill("Второй администратор");
  await page.getByTestId("sn-role").selectOption("super_admin");
  await page.getByTestId("staff-create").click();
  await expect(page.getByTestId("staff-created-four-eyes")).toContainText("выдана сразу");
  await expect(page.getByTestId("pwd-to-approver")).toHaveCount(0);
  await expect(page.getByTestId("new-temp-password")).toHaveText("Temp-Pass-9999");
});
