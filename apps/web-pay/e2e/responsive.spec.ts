/**
 * Адаптивность и строгая CSP: телефон, планшет, ПК — без горизонтальной прокрутки, главное видно; на всех страницах
 * нет нарушений CSP, встроенных стилей и запросов к сторонним адресам (шрифты, аналитика, SDK).
 */
import { expect, test, type Page } from "@playwright/test";
import { orderFixture } from "./fixtures/mock-bff";
import { expectClean, setup } from "./helpers";

const VIEWPORTS = [
  { name: "телефон", width: 360, height: 740 },
  { name: "планшет", width: 768, height: 1024 },
  { name: "ПК", width: 1440, height: 900 },
] as const;

async function noHorizontalScroll(page: Page): Promise<void> {
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(scroll).toBeLessThanOrEqual(inner);
}

for (const vp of VIEWPORTS) {
  test(`${vp.name} ${vp.width}×${vp.height}: вход, тарифы, оформление, заказ, история`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const w = await setup(page, { loggedIn: false, orders: [orderFixture({ order_no: 1201, status: "fulfilled", checkout_url: null })] });

    await page.goto("/");
    await expect(page.getByRole("button", { name: "Войти через Telegram" })).toBeInViewport();
    await noHorizontalScroll(page);
    await page.getByRole("button", { name: "Войти через Telegram" }).click();

    await expect(page.getByTestId("product-plus_30d")).toBeVisible();
    await noHorizontalScroll(page);
    // крупный экран — тарифы в несколько колонок, телефон — одна
    const boxes = await Promise.all(["plus_30d", "plus_90d"].map((c) => page.getByTestId(`product-${c}`).boundingBox()));
    if (vp.width >= 640) expect(boxes[0]!.y).toBe(boxes[1]!.y);
    else expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y);

    await page.getByTestId("product-plus_30d").getByRole("button", { name: "Выбрать" }).click();
    await expect(page.getByRole("button", { name: /Оплатить/ })).toBeVisible();
    await noHorizontalScroll(page);

    await page.goto("/orders/1201");
    await expect(page.getByTestId("order")).toBeVisible();
    await noHorizontalScroll(page);

    await page.getByRole("link", { name: "Мои заказы" }).first().click();
    await expect(page.getByTestId("orders")).toBeVisible();
    await noHorizontalScroll(page);

    // кнопки удобного размера на телефоне
    if (vp.width < 640) {
      const pay = await page.getByRole("link", { name: "Тарифы" }).boundingBox();
      expect(pay!.height).toBeGreaterThanOrEqual(36);
    }
    expect(await page.locator("[style]").count()).toBe(0);
    expectClean(w);
  });
}

test("тёмная тема системы — та же вёрстка, без нарушений CSP", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const w = await setup(page);
  await page.goto("/");
  await expect(page.getByTestId("product-plus_30d")).toBeVisible();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(17, 21, 43)");
  expectClean(w);
});

test("заголовки сборки как в Caddy: CSP, no-referrer, COOP, nosniff, запрет встраивания", async ({ page }) => {
  await setup(page);
  const resp = await page.goto("/");
  const h = resp!.headers();
  expect(h["content-security-policy"]).toBe(
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  expect(h["referrer-policy"]).toBe("no-referrer");
  expect(h["cross-origin-opener-policy"]).toBe("same-origin");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("DENY");
});
