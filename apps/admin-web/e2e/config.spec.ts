import { expect, test } from "@playwright/test";
import { ADMIN_ACCENT_100, ADMIN_ACCENT_101 } from "./fixtures/data";
import { openAs, shot } from "./helpers";

const accent = (page: import("@playwright/test").Page) => page.evaluate(() => document.documentElement.style.getPropertyValue("--accent").trim().toUpperCase());

test("A46: the admin theme comes from experience-config and a rollback changes it without a rebuild", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/config");
  // the active admin version 1.0.1 (mint accent) is applied as CSS tokens at runtime
  await expect.poll(() => accent(page)).toBe(ADMIN_ACCENT_101);
  await expect(page.locator(".sn-ver")).toContainText("theme 1.0.1");
  await page.getByTestId("cfg-tab-admin").click();
  await expect(page.getByTestId("ver-1.0.1")).toContainText("активна");
  await shot(page, "11b-config-admin");

  await page.getByTestId("cfg-rollback").click();
  await page.getByTestId("cfg-confirm").locator("textarea").fill("Вернуть фирменный лайм");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("toasts")).toContainText("Активна версия 1.0.0");
  await expect.poll(() => accent(page)).toBe(ADMIN_ACCENT_100);
  await expect(page.locator(".sn-ver")).toContainText("theme 1.0.0");
  expect(bff.calls("POST", "/experience/admin/rollback")[0]!.body).toEqual({ reason: "Вернуть фирменный лайм" });
  expect(bff.calls("POST", "/experience/admin/rollback")[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByTestId("cfg-activations")).toContainText("откат");
});

test("miniapp: rollback 2.0.3 → 2.0.2, then a new version from the current one with a reordered home", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/config");
  await expect(page.getByTestId("ver-2.0.3")).toContainText("активна");
  await shot(page, "11-config");
  await page.getByTestId("cfg-rollback").click();
  await page.getByTestId("cfg-confirm").locator("textarea").fill("Контраст на тёмной теме");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("ver-2.0.2")).toContainText("активна");

  // edit: move «news» up, switch a flag → save as 2.0.4
  await page.getByRole("button", { name: "Выше: news" }).click();
  await page.locator("#flag-calendar_export").check({ force: true });
  await expect(page.getByTestId("cfg-changes")).toContainText("2 несохранённых изменения");
  await expect(page.locator('[data-testid="cfg-preview"] [data-sec]').nth(2)).toHaveAttribute("data-sec", "news");
  await page.getByTestId("cfg-save").click();
  await expect(page.locator("#cfg-ver")).toHaveValue("2.0.4");
  await page.locator("#cfg-note").fill("Новости выше скоро-продаж");
  await page.getByTestId("cfg-save-ok").click();
  await expect(page.getByTestId("ver-2.0.4")).toBeVisible();
  const created = bff.calls("POST", "/experience/miniapp/versions")[0]!.body as { version: string; payload: { home: { sections: Array<{ key: string }> }; flags: Record<string, boolean> } };
  expect(created.version).toBe("2.0.4");
  expect(created.payload.home.sections.map((s) => s.key)).toEqual(["best_for_you", "watch", "news", "sales_soon"]);
  expect(created.payload.flags.calendar_export).toBe(true);
  await page.getByTestId("activate-2.0.4").click();
  await page.getByTestId("cfg-confirm").locator("textarea").fill("Выпуск порядка секций");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("ver-2.0.4")).toContainText("активна");
});

test("operations (config.read only): read-only editor, locked publish buttons", async ({ page }) => {
  await openAs(page, "ops@tilhero.local", "#/config");
  await expect(page.getByTestId("cfg-versions")).toBeVisible();
  await expect(page.getByTestId("cfg-rollback")).toHaveClass(/is-locked/);
  await expect(page.locator("#flag-ai_concierge")).toBeDisabled();
});

test("A46 for every role: support (no config.read) gets the admin theme from /experience/admin/current", async ({ page }) => {
  const bff = await openAs(page, "support@tilhero.local");
  await expect.poll(() => accent(page)).toBe(ADMIN_ACCENT_101);
  await expect(page.locator(".sn-ver")).toContainText("theme 1.0.1");
  expect(bff.calls("GET", "/experience/admin/current").length).toBeGreaterThan(0);
  expect(bff.calls("GET", /\/experience\/admin\/(state|versions)/)).toHaveLength(0);
  // the operator's view follows a rollback made elsewhere on the next load — no rebuild
  bff.current.admin = "1.0.0";
  await page.reload();
  await expect.poll(() => accent(page)).toBe(ADMIN_ACCENT_100);
});
