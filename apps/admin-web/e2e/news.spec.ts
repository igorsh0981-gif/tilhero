import { expect, test, type Page } from "@playwright/test";
import { FEED, NEWS } from "./fixtures/news";
import { CYRILLIC, expectNoHScroll, nav, openAs, setTheme, settle } from "./helpers";

/* Sprint 6: «Content» group — news feeds, news moderation, Watch statistics → apps/admin-web/shots/sprint6/. */

const SHOTS6 = "shots/sprint6";
async function shot6(page: Page, name: string, fullPage = false): Promise<void> {
  await settle(page);
  await page.screenshot({ path: `${SHOTS6}/${name}.png`, fullPage });
}
async function both(page: Page, name: string, fullPage = false) {
  for (const mode of ["light", "dark"] as const) {
    await setTheme(page, mode);
    await shot6(page, `${name}-${mode}`, fullPage);
  }
  await setTheme(page, "light");
}
async function again(page: Page, email: string, hash: string, sc: Parameters<typeof openAs>[3] = {}) {
  await page.goto("about:blank");
  return openAs(page, email, hash, sc);
}
/** drawer body scrolls on its own: bring an element of the form into view */
async function into(page: Page, testId: string) {
  await page.getByTestId(testId).evaluate((el) => el.scrollIntoView({ block: "center" }));
}
/** the whole drawer as one picture (the body scroll is unrolled for the shot only) */
async function drawerShot(page: Page, name: string) {
  const vp = page.viewportSize()!;
  await page.setViewportSize({ width: vp.width, height: 2400 });
  await settle(page);
  await page.screenshot({ path: `${SHOTS6}/${name}.png` });
  await page.setViewportSize(vp);
}
async function fillNewFeed(page: Page) {
  await page.getByTestId("ff-name").fill("UEFA — Champions League news");
  await page.getByTestId("ff-slug").fill("uefa-ucl");
  await page.getByTestId("ff-url").fill("https://www.uefa.com/rss/uefachampionsleague/rss.xml");
  await page.getByTestId("ff-domain-suggest").click();
  await expect(page.getByTestId("ff-domain")).toHaveValue("uefa.com");
  await page.getByTestId("ff-int-add").selectOption("sport.football");
  await page.getByTestId("ff-ent").locator("input").fill("UEFA, Champions League");
  await page.getByTestId("ff-ent").locator("input").press("Enter");
  await page.getByTestId("ff-reason").fill("Официальная лента Лиги чемпионов по интересу «Футбол»");
}

test.describe("width 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("news feeds: list with health, kinds and display; light and dark", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/feeds");
    await expect(page.getByTestId("page-title")).toHaveText("Источники новостей");
    await expect(page.locator(".crumbs")).toContainText("Контент");
    await expect(page.locator('[data-nav="feeds"]')).toBeVisible();
    await expect(page.locator('[data-nav="news"]')).toBeVisible();
    await expect(page.locator('[data-nav="watches"]')).toBeVisible();
    const kun = page.locator(`[data-feed="kun-uz-culture"]`);
    await expect(kun.getByTestId("feed-health-cell")).toContainText("Не RSS / Atom");
    await expect(kun.locator("[data-health]")).toHaveAttribute("data-health", "error");
    await expect(page.locator(`[data-feed="gazeta-uz-afisha"] [data-health]`)).toHaveAttribute("data-health", "late");
    await expect(page.locator(`[data-feed="tengrinews-culture"] [data-health]`)).toHaveAttribute("data-health", "off");
    await expect(page.locator(`[data-feed="opera-am-news"] [data-health]`)).toHaveAttribute("data-health", "never");
    await expect(page.locator(`[data-feed="playbill-news"]`)).toContainText("Только заголовок");
    await expect(page.getByTestId("feeds-summary")).toContainText("Включено 6 из 10");
    await expect(page.getByTestId("feeds-summary")).toContainText("1 лента с ошибкой");
    await expectNoHScroll(page);
    await both(page, "01-feeds");
  });

  test("news feeds: filter by interest and country", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/feeds");
    await page.getByTestId("feed-interest").selectOption("culture.theatre");
    await expect(page.locator("[data-feed]")).toHaveCount(2);
    const req = page.waitForRequest((r) => r.url().includes("/admin/v1/news/sources?") && r.url().includes("interest=culture.theatre") && r.url().includes("country=UZ"));
    await page.getByTestId("feed-country").selectOption("UZ");
    await req;
    await expect(page.locator("[data-feed]")).toHaveCount(1);
    await expect(page.locator("[data-feed]")).toHaveAttribute("data-feed", "kun-uz-culture");
    await shot6(page, "02-feeds-filter-light");
  });

  test("feed card: health with the last error, form sections; light and dark", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", `#/feeds/${FEED.kun}`);
    await expect(page.getByTestId("feed-card")).toBeVisible();
    await expect(page.getByTestId("feed-health")).toHaveAttribute("data-health", "error");
    await expect(page.getByTestId("feed-last-error")).toContainText("FEED_INVALID");
    await expect(page.getByTestId("feed-last-error")).toContainText("защиты от ботов");
    await expect(page.getByTestId("ff-cat")).toHaveValue("/culture/");
    await expect(page.getByTestId("ff-changed")).toHaveText("Изменений нет");
    // the drawer is modal (the theme menu is behind it): the theme follows the system one
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await shot6(page, `03-feed-card-error-${mode}`);
    }
  });

  test("new feed: «Check» before saving, first entries and dropped ones; save creates the feed", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/feeds");
    await page.getByTestId("feed-add").click();
    await expect(page.getByTestId("feed-card")).toContainText("Новая лента");
    await fillNewFeed(page);
    await page.getByTestId("ff-check-btn").click();
    const res = page.getByTestId("ff-check-result");
    await expect(res).toHaveAttribute("data-ok", "true");
    await expect(res).toContainText("подходят 3 из 20");
    await expect(res).toContainText("не подходит под фильтр рубрики");
    await expect(res).toContainText("ссылка не на домене источника");
    const chk = bff.calls("POST", "/news/sources/check")[0]!;
    expect(chk.body).toEqual({ mode: "rss", feed_url: "https://www.uefa.com/rss/uefachampionsleague/rss.xml", page_url: null, site_domain: "uefa.com", extra_domains: [], category_filter: null });
    await into(page, "ff-check");
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await into(page, "ff-check");
      await shot6(page, `04-feed-new-check-${mode}`);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByTestId("ff-submit").click();
    await expect(page.getByTestId("toasts")).toContainText("Лента «UEFA — Champions League news» добавлена");
    const created = bff.calls("POST", "/news/sources")[0]!;
    expect(created.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.body).toMatchObject({ slug: "uefa-ucl", interests: ["sport.football"], entities: ["UEFA", "Champions League"], enabled: false, display: "summary" });
    await expect(page.locator('[data-feed="uefa-ucl"]')).toBeVisible();
  });

  test("new feed saved without a check asks first; check fails / unavailable", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/feeds/new");
    await fillNewFeed(page);
    await page.getByTestId("ff-submit").click();
    await expect(page.getByTestId("ff-unchecked")).toContainText("Сохранить без проверки ленты?");
    await shot6(page, "05-feed-unchecked-light");
    await page.getByTestId("ff-unchecked-check").click();
    await expect(page.getByTestId("ff-check-result")).toHaveAttribute("data-ok", "true");

    await again(page, "ops@tilhero.local", "#/feeds/new", { feedCheck: "fail" });
    await fillNewFeed(page);
    await page.getByTestId("ff-check-btn").click();
    await expect(page.getByTestId("ff-check-result")).toHaveAttribute("data-ok", "false");
    await expect(page.getByTestId("ff-check-result")).toContainText("FEED_INVALID");
    await into(page, "ff-check");
    await shot6(page, "06-feed-check-fail-light");
    // changing the URL after the check marks the result stale
    await page.getByTestId("ff-url").fill("https://www.uefa.com/rss/uefachampionsleague/news.xml");
    await expect(page.getByTestId("ff-check-stale")).toBeVisible();

    await again(page, "ops@tilhero.local", `#/feeds/${FEED.f1}`, { feedCheck: "unavailable" });
    await page.getByTestId("ff-check-btn").click();
    await expect(page.getByTestId("ff-check-error")).toContainText("Проверка ленты пока недоступна");
    await into(page, "ff-check");
    await shot6(page, "07-feed-check-unavailable-light");
  });

  test("feed edit: 409 conflict → «Reload»; delete with a reason", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", `#/feeds/${FEED.playbill}`, { feedConflict: true });
    await page.getByTestId("ff-display").getByText("Резюме", { exact: true }).click();
    await page.getByTestId("ff-reason").fill("Издание разрешило пересказ");
    await expect(page.getByTestId("ff-changed")).toContainText("показ");
    await page.getByTestId("ff-submit").click();
    await expect(page.getByTestId("feed-conflict")).toContainText("Ленту изменил другой сотрудник");
    await page.getByTestId("feed-conflict").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shot6(page, "08-feed-conflict-light");
    await page.getByTestId("feed-reload").click();
    await expect(page.getByTestId("feed-conflict")).toHaveCount(0);
    await expect(page.locator(".drawer-sub")).toContainText("v2");

    await page.getByTestId("ff-delete").click();
    const dlg = page.getByTestId("ff-delete-confirm");
    await expect(dlg).toContainText("Удалить ленту «Playbill — News»?");
    await dlg.locator("textarea").fill("Издание закрыло RSS");
    await shot6(page, "09-feed-delete-light");
    await dlg.getByTestId("confirm-ok").click();
    await expect(page.getByTestId("toasts")).toContainText("Лента «Playbill — News» удалена");
    await expect(page.locator('[data-feed="playbill-news"]')).toHaveCount(0);
    const del = bff.calls("DELETE", `/news/sources/${FEED.playbill}`)[0]!;
    expect(del.body).toEqual({ expected_version: 2, reason: "Издание закрыло RSS" });
  });

  test("news: significance, sources, links to events, below threshold, hidden; light and dark", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/news");
    await expect(page.getByTestId("page-title")).toHaveText("Новости");
    const rows = page.getByTestId("news-row");
    await expect(rows).toHaveCount(5);
    await expect(page.locator(`[data-news="${NEWS.event}"]`)).toContainText("Изменение события");
    await expect(page.locator(`[data-news="${NEWS.f1}"]`)).toContainText("Событий: 2");
    await expect(page.locator(`[data-news="${NEWS.playbill}"]`)).toContainText("Ниже порога");
    await expect(page.locator(`[data-news="${NEWS.playbill}"]`)).toContainText("Без резюме");
    await expect(page.locator(`[data-news="${NEWS.hidden}"]`).getByTestId("news-hidden")).toContainText("Скрыта: Тимур");
    await expect(page.locator(`[data-news="${NEWS.f1}"]`).getByTestId("news-link")).toHaveAttribute("href", /^https:\/\/www\.formula1\.com\//);
    await expectNoHScroll(page);
    await both(page, "10-news", true);
  });

  test("news: hide with a reason, then the «Hidden» filter and return", async ({ page }) => {
    const bff = await openAs(page, "ops@tilhero.local", "#/news");
    const row = page.locator(`[data-news="${NEWS.uefa}"]`);
    await row.getByTestId("news-hide").click();
    const dlg = page.getByTestId("news-confirm");
    await expect(dlg).toContainText("Скрыть новость из выдачи?");
    await dlg.locator("textarea").fill("Корпоративная новость, не про турниры");
    await shot6(page, "11-news-hide-dialog-light");
    await dlg.getByTestId("confirm-ok").click();
    await expect(row.getByTestId("news-hidden")).toContainText("Корпоративная новость");
    await expect(page.getByTestId("toasts")).toContainText("Новость скрыта");
    expect(bff.calls("POST", `/news/items/${NEWS.uefa}/hide`)[0]!.body).toEqual({ reason: "Корпоративная новость, не про турниры" });
    await page.getByTestId("news-shown").getByRole("button", { name: "Скрытые" }).click();
    await expect(page.getByTestId("news-row")).toHaveCount(2);
    await shot6(page, "12-news-hidden-light");
    await page.locator(`[data-news="${NEWS.hidden}"]`).getByTestId("news-unhide").click();
    await page.getByTestId("news-confirm").locator("textarea").fill("Проверили — это анонс фестиваля");
    await page.getByTestId("news-confirm").getByTestId("confirm-ok").click();
    await expect(page.getByTestId("news-row")).toHaveCount(1);
  });

  test("watches: KPI cards, changes and notifications in 24 h; light and dark", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/watches");
    await expect(page.getByTestId("page-title")).toHaveText("Слежения");
    await expect(page.getByTestId("wch-active")).toContainText("1 284");
    await expect(page.getByTestId("wch-active")).toContainText("на паузе: 96");
    await expect(page.getByTestId("wch-changes")).toContainText("161");
    await expect(page.getByTestId("wch-errors")).toHaveClass(/is-warn/);
    await expect(page.getByTestId("wch-errors")).toContainText("1,4 % перепроверок");
    await expect(page.getByTestId("wch-notify-panel").locator('[data-notify="digest"]')).toContainText("58");
    await expectNoHScroll(page);
    await both(page, "20-watches");
  });

  test("EN: feeds, news and watches without Russian interface text", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/feeds");
    await page.getByTestId("lang-en").click();
    await expect(page.getByTestId("page-title")).toHaveText("News feeds");
    await expect(page.locator(".crumbs")).toContainText("Content");
    for (const sel of [".page-head", ".toolbar", "thead", "[data-testid=feeds-summary]", ".sidenav"]) {
      expect(CYRILLIC.test((await page.locator(sel).first().innerText()) ?? ""), sel).toBe(false);
    }
    await shot6(page, "30-feeds-en-light");
    await page.locator(`[data-feed="formula1-latest"]`).click();
    await expect(page.getByTestId("feed-card")).toBeVisible();
    await page.getByTestId("ff-check-btn").click();
    await expect(page.getByTestId("ff-check-result")).toContainText("The feed reads");
    expect(CYRILLIC.test(await page.getByTestId("feed-card").innerText())).toBe(false);
    await drawerShot(page, "31-feed-card-en-light");
    await page.getByTestId("drawer-close").click();
    await nav(page, "news");
    await expect(page.locator(`[data-news="${NEWS.f1}"]`)).toContainText("Important");
    expect(CYRILLIC.test(await page.locator(`[data-news="${NEWS.f1}"]`).innerText())).toBe(false);
    await shot6(page, "32-news-en-light");
    await nav(page, "watches");
    await expect(page.getByTestId("wch-active")).toContainText("Active watches");
    expect(CYRILLIC.test(await page.getByTestId("watches").innerText())).toBe(false);
    await shot6(page, "33-watches-en-light");
  });

  test("NEWS_URL / WATCH_URL not set: a calm notice that names the service; the rest works", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/feeds", { newsOff: true, watchOff: true });
    await expect(page.getByTestId("feeds-error")).toContainText("Новости ещё не подключены к админке");
    await shot6(page, "40-feeds-off-light");
    await nav(page, "watches");
    await expect(page.getByTestId("wch-error")).toContainText("Слежения ещё не подключены к админке");
    await shot6(page, "41-watches-off-light");
    await nav(page, "travel");
    await expect(page.getByTestId("trv-aviasales")).toBeVisible();
  });

  test("country filter: feeds and news by country, empty state with «Reset filters»", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/feeds");
    await expect(page.locator("[data-feed]")).toHaveCount(10);
    await page.getByTestId("feed-country").selectOption("KG");
    await expect(page.getByTestId("feeds-empty-filtered")).toContainText("Нет лент этой страны");
    await shot6(page, "43-feeds-country-empty-light");
    await page.getByTestId("feeds-empty-reset").click();
    await expect(page.locator("[data-feed]")).toHaveCount(10);
    await expect(page.getByTestId("feed-country")).toHaveValue("");
    await expect(page.getByTestId("feeds-reset")).toBeDisabled();

    await nav(page, "news");
    await expect(page.getByTestId("news-row")).toHaveCount(5);
    const uz = page.waitForRequest((r) => r.url().includes("/admin/v1/news/items?") && r.url().includes("country=UZ"));
    await page.getByTestId("news-country").selectOption("UZ");
    await uz;
    await expect(page.getByTestId("news-row")).toHaveCount(1);
    await expect(page.locator(`[data-news="${NEWS.hidden}"]`)).toBeVisible();
    // the source list narrows to feeds of the country
    await expect(page.getByTestId("news-source").locator("option")).toHaveText(["Все источники", "Kun.uz — Маданият", "Gazeta.uz — Афиша", "Kun.uz — English"]);
    await page.getByTestId("news-country").selectOption("AM");
    await expect(page.getByTestId("news-empty-filtered")).toContainText("Нет новостей из лент этой страны");
    await expectNoHScroll(page);
    await shot6(page, "44-news-country-empty-light");
    await page.getByTestId("news-empty-reset").click();
    await expect(page.getByTestId("news-row")).toHaveCount(5);
    await expect(page.getByTestId("news-country")).toHaveValue("");
    await expect(page.getByTestId("news-reset")).toBeDisabled();
  });

  test("AI budget: «News: spent / limit» line; an older provider-gateway without it", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/discovery");
    const line = page.getByTestId("dsc-news-budget");
    await expect(line).toContainText("Новости");
    await expect(page.getByTestId("dsc-news-value")).toHaveText(/0\.0312\s*\/\s*\$?0\.20/);
    await expect(line).toContainText("потрачено / лимит");
    await expect(page.getByTestId("dsc-spent-incl-news")).toHaveText("(включая новости)");
    await line.scrollIntoViewIfNeeded();
    await shot6(page, "60-discovery-news-budget-light");
    await page.getByTestId("lang-en").click();
    await expect(line).toContainText("spent / limit");
    await expect(page.getByTestId("dsc-spent-incl-news")).toHaveText("(including news)");
    await again(page, "admin@tilhero.local", "#/discovery", { budgetNoNews: true });
    await expect(page.getByTestId("dsc-budget-limit")).toBeVisible();
    await expect(page.getByTestId("dsc-news-budget")).toHaveCount(0);
    await expect(page.getByTestId("dsc-spent-incl-news")).toHaveCount(0);
  });

  test("RBAC: the «Content» group only for news.manage; watches for platform roles; empty states", async ({ page }) => {
    await openAs(page, "support@tilhero.local", "#/dashboard");
    await expect(page.locator('[data-nav="feeds"]')).toHaveCount(0);
    await expect(page.locator('[data-nav="watches"]')).toHaveCount(0);
    await page.goto("/#/feeds");
    await expect(page.getByTestId("toasts")).toContainText("Источники новостей");
    await expect(page.getByTestId("page-feeds")).toHaveCount(0);
    await again(page, "audit@tilhero.local", "#/dashboard");
    await expect(page.locator('[data-nav="watches"]')).toHaveCount(0);
    await again(page, "ops@tilhero.local", "#/feeds", { emptyNews: true });
    await expect(page.getByTestId("feeds-table")).toContainText("Лент пока нет");
    await nav(page, "news");
    await expect(page.getByTestId("news")).toContainText("Новостей пока нет");
    await shot6(page, "42-news-empty-light");
  });
});

test.describe("width 400", () => {
  test.use({ viewport: { width: 400, height: 860 }, hasTouch: true });

  test("feeds, feed form, news and watches at 400 px: no horizontal scroll, light and dark", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/feeds");
    await expect(page.locator("[data-feed]")).toHaveCount(10);
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await expectNoHScroll(page);
      await shot6(page, `50-w400-feeds-${mode}`);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByTestId("feed-add").click();
    await fillNewFeed(page);
    await page.getByTestId("ff-check-btn").click();
    await expect(page.getByTestId("ff-check-result")).toBeVisible();
    await expectNoHScroll(page);
    await into(page, "ff-check");
    await shot6(page, "51-w400-feed-check-light");
    await page.getByTestId("drawer-close").click();

    await nav(page, "news");
    await expect(page.getByTestId("news-row")).toHaveCount(5);
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await expectNoHScroll(page);
      await shot6(page, `52-w400-news-${mode}`);
    }
    await nav(page, "watches");
    await expect(page.getByTestId("wch-active")).toBeVisible();
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await expectNoHScroll(page);
      await shot6(page, `53-w400-watches-${mode}`, true);
    }
  });
});
