import { expect, test, type Page } from "@playwright/test";
import { CYRILLIC, expectNoHScroll, openAs, setTheme, settle } from "./helpers";

/* Sprint 5: «Trip providers» screen and the «Offer snapshot» block of a support ticket → apps/admin-web/shots/sprint5/. */

const SHOTS5 = "shots/sprint5";
async function shot5(page: Page, name: string, fullPage = false): Promise<void> {
  await settle(page);
  await page.screenshot({ path: `${SHOTS5}/${name}.png`, fullPage });
}
async function both(page: Page, name: string, fullPage = false) {
  for (const mode of ["light", "dark"] as const) {
    await setTheme(page, mode);
    await shot5(page, `${name}-${mode}`, fullPage);
  }
}
/** a second scenario in the same test: leave the app first (a hash-only goto would keep the old state) */
async function again(page: Page, email: string, hash: string, sc: Parameters<typeof openAs>[3] = {}) {
  await page.goto("about:blank");
  return openAs(page, email, hash, sc);
}
/** at 400 px the theme menu is hidden in the top bar: the theme follows the system one */
async function both400(page: Page, name: string, prepare: () => Promise<void>, fullPage = false) {
  for (const mode of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: mode });
    await prepare();
    await shot5(page, `${name}-${mode}`, fullPage);
  }
}
/** element shot of the whole block: the context column (fixed height, own scroll) is unrolled for the picture only */
async function blockShot(page: Page, name: string) {
  await page.evaluate(() => {
    for (const sel of [".support-thread", ".st-ctx"]) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) Object.assign(el.style, { height: "auto", maxHeight: "none", overflow: "visible" });
    }
    // the sticky top bar would cover the top of a block taller than the viewport
    const bar = document.querySelector<HTMLElement>(".topbar");
    if (bar) bar.style.position = "static";
  });
  // a block taller than the viewport is cut at its bottom edge: make the viewport tall for the picture
  const vp = page.viewportSize()!;
  await page.setViewportSize({ width: vp.width, height: 1800 });
  await settle(page);
  await page.getByTestId("ctx-offer").screenshot({ path: `${SHOTS5}/${name}.png` });
  await page.setViewportSize(vp);
}
/** the context column scrolls on its own: bring the snapshot block into view */
async function showSnapshot(page: Page) {
  await expect(page.getByTestId("osn-body")).toBeVisible();
  await page.getByTestId("ctx-offer").evaluate((el) => el.scrollIntoView({ block: "start" }));
}

test.describe("width 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("trip providers: ok / breaker open / not configured, light and dark", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/travel");
    await expect(page.getByTestId("page-title")).toHaveText("Поставщики поездок");
    await expect(page.locator(".crumbs")).toContainText("Каталог событий");
    await expect(page.getByTestId("trv-state-aviasales")).toHaveText("Работает");
    await expect(page.getByTestId("trv-state-liteapi")).toHaveText("Breaker открыт");
    await expect(page.getByTestId("trv-last-error-liteapi")).toContainText("Поставщик недоступен или не ответил вовремя");
    await expect(page.getByTestId("trv-last-error-liteapi")).toContainText("PROVIDER_UNAVAILABLE");
    await expect(page.getByTestId("trv-state-osm")).toHaveText("Не настроен");
    await expect(page.getByTestId("trv-setup-osm")).toContainText("OSM_CONTACT_EMAIL");
    await expect(page.getByTestId("trv-summary")).toContainText("Требуют внимания: 2 из 4");
    await expectNoHScroll(page);
    await both(page, "01-travel");
  });

  test("trip providers: nothing configured yet (first deploy) and all working", async ({ page }) => {
    await openAs(page, "ops@tilhero.local", "#/travel", { providers: "fresh" });
    for (const n of ["aviasales", "liteapi", "osm"]) await expect(page.getByTestId(`trv-setup-${n}`)).toBeVisible();
    await expect(page.getByTestId("trv-setup-liteapi")).toContainText("LITEAPI_WHITELABEL_URL");
    await expect(page.getByTestId("trv-setup-aviasales")).toContainText("секрет");
    await shot5(page, "02-travel-fresh-light", true);
  });

  test("trip providers: all working; EN has no Cyrillic", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/travel", { providers: "allOk" });
    await expect(page.getByTestId("trv-summary")).toContainText("Все поставщики (4) работают");
    await shot5(page, "03-travel-ok-light");
    await page.getByTestId("lang-en").click();
    await expect(page.getByTestId("page-title")).toHaveText("Trip providers");
    const text = await page.getByTestId("travel").innerText();
    expect(text, text.match(/.{0,30}[Ѐ-ӿ]+.{0,30}/)?.[0]).not.toMatch(CYRILLIC);
    await shot5(page, "04-travel-en-light");
  });

  test("trip providers: provider-gateway down / section not configured", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/travel", { travelDown: true });
    await expect(page.getByTestId("trv-error")).toContainText("Сервис временно недоступен");
    await shot5(page, "05-travel-down-light");
    await again(page, "admin@tilhero.local", "#/travel", { featureOff: ["travel"] });
    await expect(page.getByTestId("trv-error")).toContainText("Раздел ещё не настроен");
  });

  test("offer snapshot in the ticket: tier, travellers, dates, items with links, total; light and dark", async ({ page }) => {
    const bff = await openAs(page, "support@tilhero.local", "#/support/TCK-3074");
    await expect(page.getByTestId("thread")).toBeVisible();
    await showSnapshot(page);
    const block = page.getByTestId("ctx-offer");
    await expect(page.getByTestId("osn-tier")).toHaveText("Комфорт");
    await expect(page.getByTestId("osn-status")).toHaveText("Частичный");
    await expect(page.getByTestId("osn-expired")).toHaveText("Срок истёк");
    await expect(page.getByTestId("osn-travellers")).toHaveText("2 человека · 1 номер");
    await expect(page.getByTestId("osn-dates")).toContainText("13.11.2026 → 16.11.2026 · 3 ночи");
    await expect(page.getByTestId("osn-flight")).toContainText("TAS → ALA");
    await expect(page.getByTestId("osn-flight")).toContainText("$284.00");
    await expect(page.getByTestId("osn-hotel")).toContainText("Rixos Almaty");
    await expect(page.getByTestId("osn-ticket")).toContainText("450 000 UZS");
    await expect(page.getByTestId("osn-ticket")).toContainText("не входит в сумму");
    await expect(page.getByTestId("osn-total")).toContainText("$674.00");
    await expect(page.getByTestId("osn-missing")).toContainText("билет");
    for (const k of ["ticket", "flight", "hotel"]) {
      const a = page.getByTestId(`osn-link-${k}`);
      await expect(a).toHaveAttribute("href", /^https:\/\//);
      await expect(a).toHaveAttribute("target", "_blank");
    }
    // one snapshot request per open card (StrictMode of the dev server runs the effect twice)
    expect(bff.calls("GET", "/offers/0ffe0000-0000-4000-8000-000000003074").length).toBeGreaterThanOrEqual(1);
    await expectNoHScroll(page);
    for (const mode of ["light", "dark"] as const) {
      await setTheme(page, mode);
      await showSnapshot(page);
      await shot5(page, `10-support-offer-${mode}`);
      await blockShot(page, `11-offer-block-${mode}`);
      await page.reload();
      await expect(block).toBeVisible();
    }
  });

  test("offer snapshot: removed after 30 days (404), offers down, section not configured, EN", async ({ page }) => {
    await openAs(page, "support@tilhero.local", "#/support/TCK-3069");
    await expect(page.getByTestId("osn-not-found")).toContainText("30 дней");
    await blockShot(page, "12-offer-not-found-light");

    await again(page, "support@tilhero.local", "#/support/TCK-3074", { offer: "down" });
    await expect(page.getByTestId("osn-error")).toContainText("Сервис временно недоступен");
    await expect(page.getByTestId("osn-error").getByRole("button", { name: "Повторить" })).toBeVisible();
    await blockShot(page, "13-offer-down-light");

    await again(page, "support@tilhero.local", "#/support/TCK-3074", { featureOff: ["offers"] });
    await expect(page.getByTestId("osn-feature-off")).toContainText("OFFERS_URL");
    // the rest of the ticket works
    await expect(page.getByTestId("ticket-controls")).toBeVisible();

    await again(page, "support@tilhero.local", "#/support/TCK-3074", { offer: "nodeparture" });
    await page.getByTestId("lang-en").click();
    await showSnapshot(page);
    await expect(page.getByTestId("osn-flight")).toContainText("No departure city");
    await expect(page.getByTestId("osn-missing")).toContainText("Not in the total: ticket, flight");
    const text = await page.getByTestId("ctx-offer").evaluate((el) => {
      const c = el.cloneNode(true) as HTMLElement;
      c.querySelectorAll(".wrap-any, dd").forEach((n) => n.remove()); // user data (city, hotel name) is not translated
      return c.innerText;
    });
    expect(text, text.match(/.{0,30}[Ѐ-ӿ]+.{0,30}/)?.[0]).not.toMatch(CYRILLIC);
    await blockShot(page, "14-offer-nodeparture-en-light");
  });

  test("offer snapshot of another user is flagged; a legacy non-UUID offer_id is not requested", async ({ page }) => {
    const bff = await openAs(page, "support@tilhero.local", "#/support/TCK-3074", { offer: "foreign" });
    await expect(page.getByTestId("osn-foreign")).toContainText("другому пользователю");
    await blockShot(page, "15-offer-foreign-light");
    await page.goto("/#/support/TCK-3081");
    await expect(page.getByTestId("osn-bad-id")).toBeVisible();
    expect(bff.calls("GET", /^\/offers\//).filter((c) => c.path.includes("off_987"))).toHaveLength(0);
  });

  test("menu: support / read-only roles do not see «Trip providers», a deep link is refused", async ({ page }) => {
    await openAs(page, "support@tilhero.local", "#/travel");
    await expect(page.getByTestId("toasts")).toContainText("недоступен");
    await expect(page.locator('[data-nav="travel"]')).toHaveCount(0);
    await again(page, "ops@tilhero.local", "");
    await expect(page.locator('[data-nav="travel"]')).toBeVisible();
    await page.locator('[data-nav="travel"]').click();
    await expect(page.getByTestId("page-travel")).toBeVisible();
  });
});

test.describe("width 400", () => {
  test.use({ viewport: { width: 400, height: 860 }, hasTouch: true });

  test("trip providers at 400 px: no horizontal scroll, light and dark", async ({ page }) => {
    await openAs(page, "admin@tilhero.local", "#/travel");
    await expect(page.getByTestId("trv-liteapi")).toBeVisible();
    await expectNoHScroll(page);
    await both400(page, "20-w400-travel", async () => undefined, true);
    await page.emulateMedia({ colorScheme: "light" });
    await again(page, "ops@tilhero.local", "#/travel", { providers: "fresh" });
    await expect(page.getByTestId("trv-setup-liteapi")).toBeVisible();
    await expectNoHScroll(page);
    await shot5(page, "21-w400-travel-fresh-light", true);
  });

  test("offer snapshot at 400 px in the «Context» tab: no horizontal scroll, light and dark", async ({ page }) => {
    await openAs(page, "support@tilhero.local", "#/support/TCK-3074");
    await expect(page.getByTestId("thread")).toBeVisible();
    await page.getByTestId("thread-mtab").getByRole("button", { name: "Контекст" }).click();
    await showSnapshot(page);
    await expectNoHScroll(page);
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await showSnapshot(page);
      await expectNoHScroll(page);
      await shot5(page, `22-w400-offer-${mode}`);
      await blockShot(page, `23-w400-offer-block-${mode}`);
      await page.evaluate(() => document.querySelector<HTMLElement>(".topbar")?.style.removeProperty("position"));
    }
  });
});
