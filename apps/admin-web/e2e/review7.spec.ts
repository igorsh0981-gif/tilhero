import { expect, test, type Page } from "@playwright/test";
import { USER } from "./fixtures/data";
import { openAs, settle, typeOtp } from "./helpers";
import type { MockBff } from "./fixtures/mock-bff";

/* Review 7 of stream G: M3 (agent / level checks, warnings with a confirmation, warnings[] of ai-control), M4 (a 6.1
   provider-gateway without the agent budgets), reason in the body, toasts vs the drawer, bell names, AI tile → shots/review7/. */

const SHOTS = "shots/review7";
async function shot(page: Page, name: string) {
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
async function block(page: Page, testId: string, name: string) {
  await page.getByTestId(testId).first().scrollIntoViewIfNeeded();
  await settle(page);
  await page.getByTestId(testId).first().screenshot({ path: `${SHOTS}/${name}.png` });
}
async function lastCall(bff: MockBff, method: string, path: string) {
  await expect.poll(() => bff.calls(method, path).length).toBeGreaterThan(0);
  return bff.calls(method, path).at(-1)!;
}
async function totp(page: Page) {
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", "123456");
  await expect(page.getByTestId("stepup")).toHaveCount(0);
}
const concierge = (page: Page) => page.locator('[data-testid="bdg-agent-row"][data-agent="concierge"]');

test.describe("width 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("agent config: per request below a skill version is blocked; month ≥ day; auto-pause is confirmed; warnings[] stay", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/budgets");
    await concierge(page).getByTestId("bdg-config").click();
    const cfg = page.getByTestId("cfg-drawer");
    // skill versions of the agent: concierge.event v2 (active) / v3 (DRAFT) allow $0.05 per request
    await cfg.getByTestId("cfg-per_request_max_usd").fill("0,04");
    await expect(cfg.locator('[data-field="per_request_max_usd"]')).toContainText("concierge.event v");
    await expect(cfg.getByTestId("cfg-save")).toBeDisabled();
    await shot(page, "01-agent-below-skill-light");
    await cfg.getByTestId("cfg-per_request_max_usd").fill("0.05");
    await cfg.getByTestId("cfg-monthly_cap_usd").fill("0.5");
    await expect(cfg.locator('[data-field="monthly_cap_usd"]')).toContainText("Месячный лимит меньше дневного ($1.00 в сутки)");
    await expect(cfg.getByTestId("cfg-save")).toBeDisabled();
    // 12 ≤ spent this month 12.418 → auto-pause: allowed, but confirmed
    await cfg.getByTestId("cfg-monthly_cap_usd").fill("12");
    await expect(cfg.getByTestId("cfg-warn")).toContainText("автопауза");
    await expect(cfg.getByTestId("cfg-save")).toHaveText("Сохранить всё равно");
    await expect(cfg.getByTestId("cfg-save")).toBeDisabled();
    await cfg.getByTestId("cfg-reason").fill("Срезаем расход до конца месяца");
    await cfg.getByTestId("cfg-warn-ok").check();
    await shot(page, "02-agent-warn-confirm-light");
    await cfg.getByTestId("cfg-save").click();
    await totp(page);
    await expect(cfg).toHaveCount(0);
    expect((await lastCall(bff, "PATCH", "/ai/agents/concierge")).body).toEqual({ monthly_cap_usd: "12", reason: "Срезаем расход до конца месяца", expected_version: 4 });
    await expect(page.getByTestId("cfg-saved-warn")).toContainText("автопауза");
    await expect(concierge(page).getByTestId("bdg-state")).toHaveText("Остановлен");
    await shot(page, "03-agent-saved-warning-light");
    await page.getByTestId("cfg-saved-warn-close").click();
    await expect(page.getByTestId("cfg-saved-warn")).toHaveCount(0);
  });

  test("agent config: the toast of a kill switch does not cover the drawer footer", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/budgets");
    await concierge(page).getByTestId("bdg-kill").click();
    await page.getByTestId("kill-reason").fill("Проверка тостов");
    await page.getByTestId("kill-type").fill("concierge");
    await page.getByTestId("kill-ok").click();
    await totp(page);
    await expect(page.getByTestId("toasts").locator(".toast")).toHaveCount(1);
    await concierge(page).getByTestId("bdg-config").click();
    await expect(page.getByTestId("toasts")).toHaveClass(/at-left/);
    const save = await page.getByTestId("cfg-save").boundingBox();
    const toast = await page.getByTestId("toasts").locator(".toast").first().boundingBox();
    expect(save && toast).toBeTruthy();
    const overlap = toast!.x < save!.x + save!.width && toast!.x + toast!.width > save!.x && toast!.y < save!.y + save!.height && toast!.y + toast!.height > save!.y;
    expect(overlap).toBe(false);
    await shot(page, "04-toast-left-of-drawer-light");
  });

  test("access levels: default > 0; plus below basic is confirmed; ai-control warnings[] after the save", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/budgets");
    await page.locator('[data-level="basic"]').getByTestId("lvl-edit").click();
    const lv = page.getByTestId("lvl-dialog");
    await lv.getByTestId("lvl-n").fill("0");
    await expect(lv).toContainText("У уровня по умолчанию должно быть больше 0 сообщений в сутки");
    await lv.getByTestId("lvl-reason").fill("Проверка");
    await lv.getByTestId("lvl-ok").click();
    await expect(bff.calls("PUT", "/ai/access-levels/basic")).toHaveLength(0);
    await lv.getByRole("button", { name: "Отмена" }).click();

    await page.locator('[data-level="plus"]').getByTestId("lvl-edit").click();
    await lv.getByTestId("lvl-n").fill("5");
    await expect(lv.getByTestId("lvl-warn")).toContainText("меньше, чем у уровня по умолчанию «Базовый» (10)");
    await expect(lv.getByTestId("lvl-ok")).toBeDisabled();
    await lv.getByTestId("lvl-reason").fill("Пробный тариф на неделю");
    await lv.getByTestId("lvl-warn-ok").check();
    await shot(page, "05-level-warn-light");
    await lv.getByTestId("lvl-ok").click();
    await totp(page);
    await expect(lv).toHaveCount(0);
    await expect(page.getByTestId("lvl-saved-warn")).toContainText("Расширенный");
    await expect(page.locator('[data-level="plus"]').getByTestId("lvl-messages")).toHaveText("5");
    await block(page, "bdg-levels", "06-levels-saved-warning-light");
  });

  test("limits: the concierge daily budget below its per-request limit is confirmed in the dialog", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/budgets");
    await expect(concierge(page)).toBeVisible();
    await page.getByTestId("lim-concierge").fill("0.03");
    await expect(page.getByTestId("lim-agent-warn")).toContainText("меньше лимита агента на запрос ($0.05)");
    await page.getByTestId("lim-save").click();
    const lc = page.getByTestId("lim-confirm");
    await expect(lc.getByTestId("lim-confirm-agent-warn")).toBeVisible();
    await block(page, "lim-confirm", "07-limits-agent-warn-light");
  });

  test("M4: provider-gateway 6.1 — the limits work, agent budgets «unavailable until the update»", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/budgets", { gateway61: true });
    await expect(page.getByTestId("lim-ai")).toBeVisible();
    await expect(page.getByTestId("lim-concierge")).toHaveCount(0);
    await expect(page.getByTestId("lim-missing")).toContainText("недоступны до обновления provider-gateway");
    await block(page, "dsc-limits", "08-limits-gateway61-light");
    await page.getByTestId("lim-ai").fill("2");
    await page.getByTestId("lim-save").click();
    const lc = page.getByTestId("lim-confirm");
    await lc.locator("textarea").fill("Сезон");
    await lc.getByTestId("confirm-ok").click();
    await totp(page);
    const put = await lastCall(bff, "PUT", "/ai/limits");
    expect(put.body).toEqual({ ai_daily_usd: "2", news_daily_usd: "0.20", pages_daily: 300, reason: "Сезон" });
  });

  test("user access level reset: the reason goes in the body, not in the URL", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", `#/users/${USER.igor}`, { manualLevel: true });
    await page.getByTestId("user-tab-ai").click();
    await page.getByTestId("uai-reset").click();
    const dlg = page.getByTestId("uai-reset-confirm");
    await dlg.locator("textarea").fill("Партнёрство закончилось");
    await dlg.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("uai-level")).toHaveText("Базовый");
    const del = await lastCall(bff, "DELETE", `/users/${USER.igor}/access-level`);
    // the mock answers 422 to a reason in the query: the level only resets when it is in the body
    expect(del.body).toMatchObject({ reason: "Партнёрство закончилось" });
  });

  test("dashboard AI tile: three stats fill the row; the bell names agents", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/dashboard");
    const band = page.getByTestId("dash-ai").locator(".statband");
    await expect(band.locator(".stat")).toHaveCount(3);
    // no empty fourth cell: the three stats take the whole row (polled — the grid may still be laying out)
    await expect
      .poll(() =>
        band.evaluate((x) => {
          const cells = [...x.querySelectorAll<HTMLElement>(".stat")].map((c) => c.getBoundingClientRect().width);
          return Math.round(Math.abs(cells.reduce((a, b) => a + b, 0) - x.getBoundingClientRect().width));
        }),
      )
      .toBeLessThan(3);
    await block(page, "dash-ai", "09-dashboard-ai-light");
    await page.getByTestId("bell").click();
    await expect(page.getByTestId("bell-list")).toContainText("AI-консьерж");
    await shot(page, "10-bell-names-light");
  });
});

test.describe("width 400", () => {
  test.use({ viewport: { width: 400, height: 860 } });

  test("agent warning and the dashboard AI tile fit 400 px", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/dashboard");
    await block(page, "dash-ai", "11-dashboard-ai-400");
    await page.goto("/#/budgets");
    await concierge(page).getByTestId("bdg-config").click();
    const cfg = page.getByTestId("cfg-drawer");
    await cfg.getByTestId("cfg-monthly_cap_usd").fill("12");
    await expect(cfg.getByTestId("cfg-warn")).toBeVisible();
    await cfg.getByTestId("cfg-warn").scrollIntoViewIfNeeded();
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "12-agent-warn-400-dark");
  });
});
