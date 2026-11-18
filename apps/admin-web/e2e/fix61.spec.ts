import { expect, test, type Page } from "@playwright/test";
import { FEED } from "./fixtures/news";
import { CYRILLIC, expectNoHScroll, openAs, settle, typeOtp } from "./helpers";

/* Fix 6.1: AI limits from the admin («Event search → Budget») and the auto-check of news feeds → shots/fix61/. */

const SHOTS = "shots/fix61";
async function shot(page: Page, name: string, fullPage = false) {
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}
async function block(page: Page, testId: string, name: string) {
  await page.getByTestId(testId).scrollIntoViewIfNeeded();
  await settle(page);
  await page.getByTestId(testId).screenshot({ path: `${SHOTS}/${name}.png` });
}
async function again(page: Page, email: string, hash: string, sc: Parameters<typeof openAs>[3] = {}) {
  await page.goto("about:blank");
  return openAs(page, email, hash, sc);
}

test.describe("width 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("limits: defaults from the settings; light and dark", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/discovery");
    const lim = page.getByTestId("dsc-limits");
    await expect(lim).toHaveAttribute("data-source", "env");
    await expect(page.getByTestId("lim-source")).toHaveText("По умолчанию из настроек");
    await expect(page.getByTestId("lim-ai")).toHaveValue("1.00");
    await expect(page.getByTestId("lim-news")).toHaveValue("0.20");
    await expect(page.getByTestId("lim-pages")).toHaveValue("300");
    await expect(lim).toContainText("0–50 USD, включая новости");
    await expect(lim).toContainText("сегодня $0.4213");
    await expect(page.getByTestId("lim-save")).toBeDisabled();
    await expect(page.getByTestId("lim-reset")).toHaveCount(0);
    await expectNoHScroll(page);
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await block(page, "dsc-limits", `01-limits-env-${mode}`);
    }
  });

  test("limits: bounds, «below spent» warning, confirmation with the diff, step-up, audit; restore defaults", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/discovery");
    await page.getByTestId("lim-ai").fill("60");
    await page.getByTestId("lim-news").fill("70");
    await page.getByTestId("lim-pages").fill("6000");
    const lim = page.getByTestId("dsc-limits");
    await expect(lim).toContainText("Не больше 50 USD в сутки");
    await expect(lim).toContainText("Не больше общего бюджета AI");
    await expect(lim).toContainText("Целое число от 0 до 5000");
    await page.getByTestId("lim-save").click();
    await expect(page.getByTestId("lim-confirm")).toHaveCount(0);
    await block(page, "dsc-limits", "02-limits-errors-light");

    // below what is already spent today (spent $0.4213, 71 pages): a warning, still allowed
    await page.getByTestId("lim-ai").fill("0,30");
    await page.getByTestId("lim-news").fill("0.10");
    await page.getByTestId("lim-pages").fill("50");
    await expect(page.getByTestId("lim-below")).toContainText("общий AI, страницы");
    await block(page, "dsc-limits", "03-limits-below-light");
    await page.getByTestId("lim-undo").click();
    await expect(page.getByTestId("lim-ai")).toHaveValue("1.00");

    await page.getByTestId("lim-ai").fill("2.5");
    await page.getByTestId("lim-news").fill("0.40");
    await page.getByTestId("lim-pages").fill("500");
    await page.getByTestId("lim-save").click();
    const dlg = page.getByTestId("lim-confirm");
    await expect(dlg.getByTestId("lim-diff")).toContainText("$1.00");
    await expect(dlg.getByTestId("lim-diff")).toContainText("$2.50");
    await dlg.locator("textarea").fill("ab");
    await dlg.getByTestId("confirm-ok").click();
    await expect(dlg).toContainText("Укажите причину");
    await dlg.locator("textarea").fill("Фестивальный сезон: больше афиш");
    await shot(page, "04-limits-confirm-light");
    await dlg.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("stepup")).toBeVisible();
    await typeOtp(page, "stepup", "123456");
    await expect(page.getByTestId("toasts")).toContainText("Лимиты AI изменены");
    expect(bff.calls("PUT", "/discovery/limits").at(-1)!.body).toEqual({ ai_daily_usd: "2.5", news_daily_usd: "0.40", pages_daily: 500, reason: "Фестивальный сезон: больше афиш" });
    await expect(page.getByTestId("lim-source")).toContainText("Из админки");
    await expect(page.getByTestId("lim-source")).toContainText("Admin Operator");
    await expect(page.getByTestId("dsc-budget-limit")).toHaveText("$2.50");
    await expect(page.getByTestId("dsc-news-value")).toContainText("0.40");
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await shot(page, `05-limits-admin-${mode}`, true);
    }
    await page.emulateMedia({ colorScheme: "light" });

    await page.getByTestId("lim-reset").click();
    await page.getByTestId("lim-confirm").locator("textarea").fill("Сезон закончился");
    await shot(page, "06-limits-reset-confirm-light");
    await page.getByTestId("lim-confirm").getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toasts")).toContainText("Лимиты AI возвращены по умолчанию");
    await expect(page.getByTestId("lim-source")).toHaveText("По умолчанию из настроек");
    await expect(page.getByTestId("lim-ai")).toHaveValue("1.00");
    expect(bff.calls("DELETE", "/discovery/limits").at(-1)!.body).toEqual({ reason: "Сезон закончился" });
  });

  test("limits: audit unavailable — nothing changed; read-only without ops.kill_switch; EN", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/discovery", { auditDown: true, limitsAdmin: true });
    await expect(page.getByTestId("lim-source")).toContainText("Тимур");
    await expect(page.getByTestId("lim-source")).toContainText("Фестивальный сезон");
    await page.getByTestId("lim-pages").fill("600");
    await page.getByTestId("lim-save").click();
    await page.getByTestId("lim-confirm").locator("textarea").fill("Больше страниц");
    await page.getByTestId("lim-confirm").getByTestId("confirm-ok").click();
    await typeOtp(page, "stepup", "123456");
    await expect(page.getByTestId("lim-confirm")).toContainText("Журнал аудита недоступен, поэтому лимиты не изменились");
    await shot(page, "07-limits-audit-down-light");

    await again(page, "ops@tilhero.local", "#/discovery", { matrix: { operations: ["dashboard.read", "discovery.manage"] }, limitsAdmin: true });
    await expect(page.getByTestId("lim-ro")).toContainText("ops.kill_switch");
    await expect(page.getByTestId("lim-ai")).toBeDisabled();
    await expect(page.getByTestId("lim-save")).toHaveCount(0);
    await block(page, "dsc-limits", "08-limits-readonly-light");

    await again(page, "admin@tilhero.local", "#/discovery", { limitsAdmin: true });
    await page.getByTestId("lang-en").click();
    await expect(page.getByTestId("lim-source")).toContainText("Set in the admin");
    expect(CYRILLIC.test((await page.getByTestId("dsc-limits").innerText()).replace(/«[^»]*»/g, "").replace("Тимур", ""))).toBe(false);
    await block(page, "dsc-limits", "09-limits-en-light");
  });

  test("feeds: reasons in «State», last auto-check, summary; switching on a «legal» feed needs a confirmation", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/feeds");
    const sum = page.getByTestId("feeds-summary");
    await expect(sum).toContainText("Включено 6 из 10");
    await expect(sum).toContainText("условия не проверены 1");
    await expect(page.locator('[data-feed="bbc-sport-tennis"]').getByTestId("feed-state-cell")).toContainText("условия издания не проверены");
    await expect(page.locator('[data-feed="bbc-sport-tennis"]').getByTestId("feed-probe")).toContainText("прошла");
    await expect(sum).toContainText("ждут проверки 1");
    await expect(sum).toContainText("нужно разрешение 1");
    await expect(sum).toContainText("устарели 1");
    await expect(page.locator('[data-feed="techcrunch"]').getByTestId("feed-state-cell")).toContainText("нужно разрешение издания");
    await expect(page.locator('[data-feed="kun-uz-en"]').getByTestId("feed-state-cell")).toContainText("лента устарела");
    await expect(page.locator('[data-feed="kun-uz-en"]').getByTestId("feed-probe")).toContainText("свежих записей нет больше 7 дней");
    await expect(page.locator('[data-feed="tengrinews-culture"]').getByTestId("feed-state-cell")).toContainText("ждёт автопроверки");
    await expect(page.locator('[data-feed="tengrinews-culture"]').getByTestId("feed-probe")).toContainText("у записей нет дат");
    await expect(page.locator('[data-feed="opera-am-news"]').getByTestId("feed-probe")).toContainText("прошла");
    await expectNoHScroll(page);
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await shot(page, `10-feeds-reasons-${mode}`, true);
    }
    await page.emulateMedia({ colorScheme: "light" });

    await page.locator('[data-feed="kun-uz-en"]').click();
    await expect(page.getByTestId("feed-probe-block")).toContainText("STALE");
    await expect(page.getByTestId("feed-probe-block")).toContainText("записей 20, на домене источника 20");
    await shot(page, "11-feed-stale-card-light");
    await page.getByTestId("drawer-close").click();

    await page.locator('[data-feed="techcrunch"]').click();
    await expect(page.getByTestId("ff-legal-note")).toContainText("письменного разрешения");
    await page.locator("label[for=ff-enabled]").click();
    const dlg = page.getByTestId("ff-legal-confirm");
    await expect(dlg).toContainText("Условия издания требуют письменного разрешения");
    await expect(dlg.getByTestId("ff-legal-ok")).toBeDisabled();
    await shot(page, "12-feed-legal-confirm-light");
    await dlg.getByRole("button", { name: "Отмена" }).click();
    await expect(page.locator("#ff-enabled")).not.toBeChecked();
    await page.locator("label[for=ff-enabled]").click();
    await page.getByTestId("ff-legal-ack").click();
    await page.getByTestId("ff-legal-ok").click();
    await expect(page.locator("#ff-enabled")).toBeChecked();
    await page.getByTestId("ff-reason").fill("Получено письменное разрешение TechCrunch");
    await page.getByTestId("ff-submit").click();
    await expect(page.getByTestId("toasts")).toContainText("Лента «TechCrunch» сохранена");
    expect(bff.calls("PATCH", `/news/sources/${FEED.techcrunch}`)[0]!.body).toMatchObject({ enabled: true });

    // terms: «read the reprint terms» with its own checkbox
    await page.getByTestId("drawer-close").click();
    await page.locator('[data-feed="bbc-sport-tennis"]').click();
    await expect(page.getByTestId("ff-legal-note")).toContainText("Условия перепечатки издания не проверены");
    await page.locator("label[for=ff-enabled]").click();
    const terms = page.getByTestId("ff-legal-confirm");
    await expect(terms).toContainText("Перед включением прочитайте условия перепечатки издания");
    await expect(terms.getByTestId("ff-legal-ack")).toContainText("Условия проверены");
    await expect(terms.getByTestId("ff-legal-ok")).toBeDisabled();
    await shot(page, "13-feed-terms-confirm-light");
    await terms.getByTestId("ff-legal-ack").click();
    await terms.getByTestId("ff-legal-ok").click();
    await expect(page.locator("#ff-enabled")).toBeChecked();
  });
});

test.describe("width 400", () => {
  test.use({ viewport: { width: 400, height: 860 }, hasTouch: true });

  test("limits and feed reasons at 400 px: no horizontal scroll", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/discovery", { limitsAdmin: true });
    await page.getByTestId("lim-ai").fill("0.30");
    await page.getByTestId("lim-news").fill("0.10");
    await expect(page.getByTestId("lim-below")).toBeVisible();
    await expectNoHScroll(page);
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await block(page, "dsc-limits", `20-w400-limits-${mode}`);
    }
    await again(page, "ops@tilhero.local", "#/feeds");
    await expect(page.getByTestId("feeds-summary")).toBeVisible();
    await expectNoHScroll(page);
    await shot(page, "21-w400-feeds-summary-light");
  });
});
