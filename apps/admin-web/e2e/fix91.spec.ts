import { expect, test } from "@playwright/test";
import type { Source } from "@tilhero/contracts/admin";
import { expectNoHScroll, openAs, setTheme, shot, typeOtp } from "./helpers";

/* Исправление 9.1: источник «Telegram-канал» — тип и приоритет страницы в форме, метка в списке, автоматическое
 * выключение по robots.txt (причина в списке и в карточке, включение сотрудником её снимает). Скриншоты — e2e/shots/fix91-*. */

const TG_ID = "5c000000-0000-4000-8000-000000000091";

function tgSource(base: Source): Source {
  return {
    ...base,
    source_id: TG_ID,
    slug: "tg-freedom-ticketon",
    name: "Freedom Афиша (Telegram)",
    country_code: "KZ",
    tier: "TRUSTED_MEDIA",
    event_domains: ["t.me", "ticketon.kz"],
    media_domains: [],
    listing_pages: [{ url: "https://t.me/s/freedom_ticketon", city: "Almaty", category: null, kind: "telegram", priority: "normal" }],
    enabled: false,
    disabled_reason: "robots",
    js_only: false,
    notes: "Официальный канал Freedom Ticketon: 9 городов, берём только Алматы.",
    version: 2,
  };
}

test("Telegram channel: tag and auto-off reason in the list, the page type in the form, turning on clears the reason", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/sources");
  bff.sources.push(tgSource(bff.sources[0]!));
  await page.reload();
  const row = page.locator('[data-source="tg-freedom-ticketon"]');
  await expect(row.getByTestId("src-tg-tag")).toHaveText("Telegram");
  await expect(row).toContainText("Выключен: robots.txt");
  await expect(page.locator('[data-source="iticket-uz"]').getByTestId("src-tg-tag")).toHaveCount(0);
  await expectNoHScroll(page);
  for (const mode of ["light", "dark"] as const) {
    await setTheme(page, mode);
    await shot(page, `fix91-sources-list-${mode}`);
  }
  await setTheme(page, "light");

  for (const mode of ["light", "dark"] as const) {
    await setTheme(page, mode);
    await page.locator('[data-source="tg-freedom-ticketon"]').click();
    await expect(page.getByTestId("sf-auto-disabled")).toBeVisible();
    await shot(page, `fix91-source-telegram-${mode}`);
    await page.getByTestId("drawer-close").click();
  }
  await setTheme(page, "light");
  await row.click();
  await expect(page.getByTestId("sf-auto-disabled")).toContainText("robots.txt сайта запрещает загрузку всех его страниц");
  await expect(page.getByTestId("sf-page-kind-0")).toHaveValue("telegram");
  await expect(page.getByTestId("sf-page-prio-0")).toHaveValue("normal");
  await page.getByTestId("sf-pages").scrollIntoViewIfNeeded();
  await shot(page, "fix91-source-telegram-pages-light");

  // страница t.me с типом «Сайт» и не предпросмотр канала — ошибки у поля
  await page.getByTestId("sf-page-kind-0").selectOption("html");
  await page.getByTestId("sf-reason").fill("Проверили robots.txt вручную");
  await page.getByTestId("sf-submit").click();
  await expect(page.getByTestId("src-form")).toContainText("Страница t.me — выберите тип «Telegram-канал»");
  await page.getByTestId("sf-page-kind-0").selectOption("telegram");
  await page.getByTestId("sf-page-url-0").fill("https://t.me/freedom_ticketon");
  await page.getByTestId("sf-submit").click();
  await expect(page.getByTestId("src-form")).toContainText("адрес вида https://t.me/s/имя_канала");
  expect(bff.calls("PATCH", `/sources/${TG_ID}`)).toHaveLength(0);

  // правильный адрес, низкий приоритет и включение: step-up, причина автовыключения снимается
  await page.getByTestId("sf-page-url-0").fill("https://t.me/s/freedom_ticketon");
  await page.getByTestId("sf-page-prio-0").selectOption("low");
  await page.locator('label[for="sf-enabled"]').click();
  const confirm = page.getByTestId("sf-enable-ok");
  if (await confirm.isVisible()) await confirm.click();
  await page.getByTestId("sf-submit").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", "123456");
  await expect(page.getByTestId("toasts")).toContainText("версия 3");
  expect(bff.calls("PATCH", `/sources/${TG_ID}`).at(-1)!.body).toEqual({
    expected_version: 2,
    listing_pages: [{ url: "https://t.me/s/freedom_ticketon", city: "Almaty", category: null, kind: "telegram", priority: "low" }],
    enabled: true,
    reason: "Проверили robots.txt вручную",
  });
  await expect(row).toContainText("Включён");
  await expect(row).not.toContainText("robots.txt");
});

test("new Telegram channel: t.me must be among the event domains; English labels", async ({ page }) => {
  const bff = await openAs(page, "admin@tilhero.local", "#/sources");
  await page.getByTestId("src-add").click();
  await page.getByTestId("sf-name").fill("Sxodim (Telegram)");
  await page.getByTestId("sf-slug").fill("tg-sxodim");
  await page.locator("#sf-country").selectOption("KZ");
  await page.locator("#sf-ev").fill("sxodim.com");
  await page.locator("#sf-ev").press("Enter");
  await page.getByTestId("sf-page-add").click();
  await page.getByTestId("sf-page-kind-0").selectOption("telegram");
  await expect(page.getByTestId("sf-page-url-0")).toHaveAttribute("placeholder", "https://t.me/s/channel_name");
  await page.getByTestId("sf-page-url-0").fill("https://t.me/s/sxodim");
  await page.getByTestId("sf-reason").fill("Канал афиши Алматы");
  await page.getByTestId("sf-submit").click();
  await expect(page.getByTestId("src-form")).toContainText("не на доменах событий источника");
  await page.locator("#sf-ev").fill("t.me");
  await page.locator("#sf-ev").press("Enter");
  await page.getByTestId("sf-submit").click();
  await expect(page.getByTestId("stepup")).toBeVisible();
  await typeOtp(page, "stepup", "123456");
  await expect(page.getByTestId("toasts")).toContainText("создан");
  const body = bff.calls("POST", "/sources").at(-1)!.body as { listing_pages: unknown[]; event_domains: string[] };
  expect(body.event_domains).toEqual(["sxodim.com", "t.me"]);
  expect(body.listing_pages).toEqual([{ url: "https://t.me/s/sxodim", city: null, category: null, kind: "telegram", priority: "normal" }]);
  await page.getByTestId("drawer-close").click();
  await page.getByTestId("lang-en").click();
  await page.locator('[data-source="tg-sxodim"]').click();
  await expect(page.getByTestId("sf-page-kind-0").locator("option:checked")).toHaveText("Telegram channel");
});

test.describe("width 400", () => {
  test.use({ viewport: { width: 400, height: 860 } });

  test("Telegram channel page row fits a narrow screen", async ({ page }) => {
    const bff = await openAs(page, "admin@tilhero.local", "#/sources");
    bff.sources.push(tgSource(bff.sources[0]!));
    await page.reload();
    await page.locator('[data-source="tg-freedom-ticketon"]').click();
    await page.getByTestId("sf-pages").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("sf-page-kind-0")).toBeVisible();
    await expect(page.getByTestId("sf-page-prio-0")).toBeVisible();
    const box = await page.getByTestId("sf-page-url-0").boundingBox();
    expect(box!.width).toBeGreaterThan(300); // адрес — во всю ширину
    await expectNoHScroll(page);
    await shot(page, "fix91-w400-source-telegram-pages-light");
  });
});
