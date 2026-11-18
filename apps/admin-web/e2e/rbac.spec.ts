import { expect, test } from "@playwright/test";
import { openAs, shot } from "./helpers";

const navIds = async (page: import("@playwright/test").Page) => page.locator("[data-nav]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav")));

test("menu by role: support sees ops sections only; «soon» sections carry the tag", async ({ page }) => {
  await openAs(page, "support@tilhero.local");
  await expect(page.getByTestId("dashboard")).toBeVisible();
  // sprint 7: «Requests and cost» is for AI / platform roles (support does not see AI content)
  expect(await navIds(page)).toEqual(["dashboard", "users", "support"]);
  await page.goto("about:blank");
  await openAs(page, "admin@tilhero.local");
  await expect(page.locator('[data-nav="billing"] .sn-tag')).toHaveText("скоро");
  await page.goto("about:blank");
  await openAs(page, "support@tilhero.local");
  await shot(page, "14c-rbac-support-dashboard");
});

test("menu by role: auditor sees dashboard and audit only; a forbidden deep link is refused", async ({ page }) => {
  await openAs(page, "audit@tilhero.local", "#/roles");
  expect(await navIds(page)).toEqual(["dashboard", "requests", "audit"]);
  // #/roles is not allowed → toast + the role's start screen
  await expect(page.getByTestId("toasts")).toContainText("недоступен");
  await expect(page.getByTestId("page-dashboard")).toBeVisible();
  await page.locator('[data-nav="audit"]').click();
  await expect(page.getByTestId("audit-table")).toBeVisible();
});

test("menu by role: super_admin sees every group, collapsed sidebar keeps icons", async ({ page }) => {
  await openAs(page, "admin@tilhero.local");
  expect(await navIds(page)).toEqual(["dashboard", "users", "requests", "budgets", "support", "review", "sources", "discovery", "travel", "feeds", "news", "watches", "subscriptions", "billing", "agents", "monitoring", "config", "audit", "roles"]);
  await page.locator(".sn-collapse").click();
  await expect(page.getByTestId("shell")).toHaveClass(/is-collapsed/);
  await expect(page.locator(".sn-label").first()).toBeHidden();
  await shot(page, "w1440-collapsed-nav");
  await page.locator('[data-nav="billing"]').click();
  await expect(page.getByTestId("soon")).toContainText("спринт 7");
});

test("403 PERMISSION_DENIED from the backend is explained (A31: hiding in the UI is not protection)", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "#/audit", { deny: { "GET /audit/records": "audit.read" } });
  await expect(page.getByTestId("load-denied")).toContainText("Нужно право audit.read");
  await shot(page, "14b-rbac-403");
  // a locked button (no permission in the session) answers with a clear toast instead of a silent no-op
  await page.locator('[data-nav="support"]').click();
});

test("locked action buttons for a role without the permission (support: no users.sensitive.read)", async ({ page }) => {
  await openAs(page, "support@tilhero.local", "#/users");
  await page.locator("tbody tr").first().click();
  await expect(page.getByTestId("user-card")).toBeVisible();
  const btn = page.getByTestId("reveal-start");
  await expect(btn).toHaveClass(/is-locked/);
  await expect(btn).toHaveAttribute("aria-disabled", "true");
  await btn.click({ force: true });
  await expect(page.getByTestId("toasts")).toContainText("users.sensitive.read");
});

test("dev impersonation (ENV=dev only) narrows the menu to the previewed role", async ({ page }) => {
  await openAs(page, "admin@tilhero.local", "", { env: "dev" });
  await page.getByTestId("imp-btn").click();
  await page.getByTestId("imp-support").click();
  await expect.poll(() => navIds(page)).toEqual(["dashboard", "users", "support"]);
  await shot(page, "15c-impersonation");
});
