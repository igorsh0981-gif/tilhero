/**
 * Тарифы и покупка (AT-86, AT-87/88 — сторона сайта): цены в сумах целочисленно («49 000 сум» / «49 000 soʻm»), что
 * входит — до оплаты; «после текущего» / «начать сейчас» с подтверждением; получатель тилов; способ оплаты; оферта;
 * POST /api/orders с CSRF и Idempotency-Key → переход на страницу провайдера навигацией; подросток без согласия не
 * платит.
 */
import { expect, test } from "@playwright/test";
import { CHILD_ID, CSRF, NEVER, meFixture, noSubscription } from "./fixtures/mock-bff";
import { expectClean, expectCleanUrls, setup } from "./helpers";

test("тарифы: цены «49 000 сум» из тийинов, срок, минуты, функции; подписка ученика", async ({ page }) => {
  const w = await setup(page);
  await page.goto("/");
  const plus = page.getByTestId("product-plus_30d");
  await expect(plus.getByTestId("price")).toHaveText("49 000 сум");
  await expect(plus).toContainText("30 дней");
  await expect(plus).toContainText("300 ИИ-минут");
  await expect(plus).toContainText("Уроки с ИИ");
  await expect(plus).toContainText("Уроки вдвоём");
  await expect(page.getByTestId("product-plus_90d").getByTestId("price")).toHaveText("129 000 сум");
  await expect(page.getByTestId("product-til_100").getByTestId("price")).toHaveText("5 000 сум");
  await expect(page.getByTestId("product-til_1200")).toContainText("1200 тилов");
  await expect(page.getByTestId("subscription")).toContainText("«Плюс на 30 дней» — активна до 10 декабря 2026");
  await expect(page.getByTestId("subscription")).toContainText("ИИ-минуты: осталось 180 из 300");
  // в разметке нет встроенных стилей (CSP style-src 'self')
  expect(await page.locator("[style]").count()).toBe(0);
  expectClean(w);
});

test("UZ: «49 000 soʻm» (U+02BB), названия и функции на узбекском", async ({ page }) => {
  await setup(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Oʻzbekcha" }).click();
  const plus = page.getByTestId("product-plus_30d");
  await expect(plus.getByTestId("price")).toHaveText("49 000 soʻm");
  await expect(plus).toContainText("Plus — 30 kun");
  await expect(plus).toContainText("300 SI daqiqasi");
  await expect(page.getByRole("heading", { name: "Til paketlari" })).toBeVisible();
});

test("подписка при активном периоде: «после текущего» по умолчанию, Click, оферта → заказ и переход к провайдеру", async ({ page }) => {
  const w = await setup(page);
  await page.goto("/");
  await page.getByTestId("product-plus_30d").getByRole("button", { name: "Выбрать" }).click();
  await expect(page).toHaveURL(/\/buy\/plus_30d$/);
  await expect(page.getByTestId("buy-price")).toHaveText("49 000 сум");
  await expect(page.getByRole("radio", { name: /После текущего периода \(с 10 декабря 2026\)/ })).toBeChecked();
  const pay = page.getByRole("button", { name: "Оплатить 49 000 сум" });
  await expect(pay).toBeDisabled(); // оферта не принята
  await page.getByRole("radio", { name: "Click" }).check();
  await page.getByRole("checkbox", { name: "Принимаю условия оферты" }).check();
  await expect(page.getByRole("link", { name: /Читать оферту/ })).toHaveAttribute("rel", "noopener noreferrer");
  await pay.click();
  await page.waitForURL(/^https:\/\/my\.click\.uz\/services\/pay\?/);

  const post = w.bff.posts("/orders")[0]!;
  expect(post.body).toEqual({ product_code: "plus_30d", provider: "click", offer_version: "2026-11-22", start_mode: "after_current" });
  expect(post.headers["x-csrf-token"]).toBe(CSRF);
  expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(post.headers["origin"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  // сумма у провайдера — та же, из каталога (сайт её не вычисляет)
  expect(page.url()).toContain("amount=49000.00");
  expectClean(w);
  expectCleanUrls(w);
});

test("«начать сейчас»: без подтверждения сгорания остатка оплатить нельзя; с ним — confirm_forfeit: true", async ({ page }) => {
  const w = await setup(page);
  await page.goto("/buy/plus_90d");
  await page.getByRole("radio", { name: "Начать сейчас" }).check();
  await expect(page.getByText(/Остаток текущего периода сгорит: 180 мин/)).toBeVisible();
  await page.getByRole("checkbox", { name: "Принимаю условия оферты" }).check();
  const pay = page.getByRole("button", { name: "Оплатить 129 000 сум" });
  await expect(pay).toBeDisabled();
  await page.getByRole("checkbox", { name: "Понимаю, остаток сгорит" }).check();
  await pay.click();
  await page.waitForURL(/^https:\/\/checkout\.paycom\.uz\//);
  expect(w.bff.posts("/orders")[0]!.body).toMatchObject({ start_mode: "now", confirm_forfeit: true, provider: "payme" });
});

test("без активного периода — выбора «когда начать» нет; сервер требует подтверждения → форма спрашивает", async ({ page }) => {
  const w = await setup(page, {
    subscription: noSubscription(),
    failOnce: { "POST /orders": { status: 409, code: "FORFEIT_CONFIRMATION_REQUIRED", details: { minutes_left: 42, days_left: 3 } } },
  });
  await page.goto("/buy/plus_30d");
  await expect(page.getByRole("radio", { name: "Начать сейчас" })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Принимаю условия оферты" }).check();
  await page.getByRole("button", { name: "Оплатить 49 000 сум" }).click();
  await expect(page.getByText("Остаток текущего периода сгорит: 42 мин, 3 дн.")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Подтвердите, что остаток текущего периода сгорит");
  await page.getByRole("checkbox", { name: "Понимаю, остаток сгорит" }).check();
  await page.getByRole("button", { name: "Оплатить 49 000 сум" }).click();
  await page.waitForURL(/checkout\.paycom\.uz/);
  const posts = w.bff.posts("/orders");
  expect(posts[0]!.body).toEqual({ product_code: "plus_30d", provider: "payme", offer_version: "2026-11-22", start_mode: "now" });
  expect(posts[1]!.body).toMatchObject({ start_mode: "now", confirm_forfeit: true });
  // форма изменилась — новый ключ идемпотентности
  expect(posts[1]!.headers["idempotency-key"]).not.toBe(posts[0]!.headers["idempotency-key"]);
});

test("тилы детскому профилю: получатель — beneficiary_id ребёнка", async ({ page }) => {
  const w = await setup(page);
  await page.goto("/");
  await page.getByTestId("product-til_100").getByRole("button", { name: "Выбрать" }).click();
  await expect(page.getByRole("radio", { name: "Мне" })).toBeChecked();
  await page.getByRole("radio", { name: "Малыш" }).check();
  await page.getByRole("radio", { name: "Uzum" }).check();
  await page.getByRole("checkbox", { name: "Принимаю условия оферты" }).check();
  await page.getByRole("button", { name: "Оплатить 5 000 сум" }).click();
  await page.waitForURL(/uzumbank\.uz/);
  expect(w.bff.posts("/orders")[0]!.body).toEqual({ product_code: "til_100", provider: "uzum", offer_version: "2026-11-22", beneficiary_id: CHILD_ID });
});

test("оферта обновилась (409 OFFER_VERSION_MISMATCH) — каталог перечитан, согласие снова", async ({ page }) => {
  const w = await setup(page);
  await page.goto("/buy/til_100");
  await page.getByRole("checkbox", { name: "Принимаю условия оферты" }).check();
  w.bff.catalog = { ...w.bff.catalog, offer: { version: "2026-12-01", url: "https://miniapp.tilhero.test/offer2" } };
  await page.getByRole("button", { name: "Оплатить 5 000 сум" }).click();
  await expect(page.getByRole("alert")).toContainText("Условия оферты обновились");
  await expect(page.getByRole("checkbox", { name: "Принимаю условия оферты" })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Принимаю условия оферты" }).check();
  await page.getByRole("button", { name: "Оплатить 5 000 сум" }).click();
  await page.waitForURL(/checkout\.paycom\.uz/);
  expect(w.bff.posts("/orders").map((p) => (p.body as { offer_version: string }).offer_version)).toEqual(["2026-11-22", "2026-12-01"]);
});

test("подросток без согласия родителя: пояснение, кнопки выключены, заказ не создаётся", async ({ page }) => {
  const w = await setup(page, { me: meFixture({ age_band: "14-17", can_pay: false, consent_required: true }) });
  await page.goto("/");
  await expect(page.getByText("Для оплаты нужно согласие родителя")).toBeVisible();
  for (const b of await page.getByRole("button", { name: "Выбрать" }).all()) await expect(b).toBeDisabled();
  await page.goto("/buy/plus_30d");
  await page.getByRole("checkbox", { name: "Принимаю условия оферты" }).check();
  await expect(page.getByRole("button", { name: "Оплатить 49 000 сум" })).toBeDisabled();
  expect(w.bff.posts("/orders")).toEqual([]);
});

test("возраст не указан — подсказка открыть TilHero в Telegram", async ({ page }) => {
  await setup(page, { me: meFixture({ age_band: null, can_pay: false, consent_required: false }) });
  await page.goto("/");
  await expect(page.getByText("Укажите возраст в TilHero в Telegram")).toBeVisible();
});

test("продажи выключены — каталог виден, оплата недоступна", async ({ page }) => {
  const w = await setup(page);
  w.bff.catalog = { ...w.bff.catalog, sales_enabled: false };
  await page.goto("/");
  await expect(page.getByText("Оплата временно недоступна")).toBeVisible();
  for (const b of await page.getByRole("button", { name: "Выбрать" }).all()) await expect(b).toBeDisabled();
});

test("billing недоступен (503) — понятная ошибка и «Повторить»", async ({ page }) => {
  await setup(page, { failOnce: { "GET /catalog": { status: 503, code: "BILLING_UNAVAILABLE" } } });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Сервис оплаты временно недоступен");
  await page.getByRole("button", { name: "Повторить" }).click();
  await expect(page.getByTestId("product-plus_30d")).toBeVisible();
});

test("неизвестный товар в адресе — «Товар не найден»", async ({ page }) => {
  await setup(page);
  await page.goto("/buy/unknown_code");
  await expect(page.getByText("Товар не найден.")).toBeVisible();
});

test("ошибка создания заказа (лимит неоплаченных) — сообщение, переход не выполняется", async ({ page }) => {
  await setup(page, { failOnce: { "POST /orders": { status: 429, code: "ORDERS_LIMIT" } }, pollsToPaid: NEVER });
  await page.goto("/buy/plus_30d");
  await page.getByRole("checkbox", { name: "Принимаю условия оферты" }).check();
  await page.getByRole("button", { name: "Оплатить 49 000 сум" }).click();
  await expect(page.getByRole("alert")).toContainText("Много неоплаченных заказов");
  await expect(page).toHaveURL(/\/buy\/plus_30d$/);
});
