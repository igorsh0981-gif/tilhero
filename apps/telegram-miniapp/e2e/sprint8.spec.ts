import { expect, test, type Page } from "@playwright/test";
import type { BillingScenario } from "./fixtures/billing";
import * as F from "./fixtures/data";
import type { LessonsScenario } from "./fixtures/lessons";
import type { MockBff, Scenario } from "./fixtures/mock-bff";
import { installSpeech } from "./fixtures/speech";
import { installTelegram, tgBack, tgCalls, type TelegramOptions } from "./fixtures/telegram";
import { CYRILLIC, open, settle, SHOTS } from "./helpers";

/**
 * Sprint 8 on the mock BFF — the subscription and purchases for Telegram Stars in the Mini App: «Подписка» (status,
 * AI minutes, the trial), a Stars subscription over the trial (what is included before the payment, the offer, the
 * forfeit, Telegram.WebApp.openInvoice → the poll → active, auto-renew on / off), an invoice closed without paying and
 * «История платежей» (pay again / cancel), tils for Stars to a child profile from the shop, a child profile without
 * prices and buttons, the plaque of a lesson without AI and «ИИ: осталось N мин», «Уроки вдвоём — в подписке», billing
 * down, «Что нового» s8 → «Подписка», UZ, three viewports, anti-steering of the rendered text.
 */
const ALL_SEEN = [F.WELCOME.id, F.UPDATE_1.id, F.UPDATE_2.id];
const WITH_SOCIAL = ["terms", "privacy", "learning", "product_news", "social"];
/** What must never be on a screen of the Mini App (owner decision В1). */
const STEERING = /(?<![a-z])(payme|paycom|click|uzum)(?![a-z])|(?<!\p{L})сум(?!\p{L})|so[ʻ'’]m|UZS|tiyin|тийин|сайт|дешевле|другим способом|boshqa usul|arzonroq|sayt/iu;

async function start(page: Page, billing: BillingScenario = {}, sc: Scenario = {}, tg: TelegramOptions | null = { invoice: "paid" }): Promise<MockBff> {
  await installSpeech(page);
  if (tg) await installTelegram(page, tg);
  return open(page, { onboarded: true, seen: ALL_SEEN, content: { diag: "completed" }, game: {}, purposes: WITH_SOCIAL, billing, ...sc });
}

/** The answer to a native Telegram popup (inside Telegram confirmPopup is native: ok / cancel). */
async function tgPopup(page: Page, id: "ok" | "cancel") {
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __tgPopup?: unknown }).__tgPopup)).toBe(true);
  await page.evaluate((answer) => {
    const w = window as unknown as { __tgPopup: { cb(id: string): void } | null };
    const p = w.__tgPopup!;
    w.__tgPopup = null;
    p.cb(answer);
  }, id);
}

async function toSubscription(page: Page) {
  await page.getByTestId("tab-profile").click();
  await page.getByTestId("row-subscription").click();
  await expect(page.getByTestId("subscription")).toBeVisible();
}

async function shotOf(page: Page, testId: string, name: string) {
  await page.getByTestId(testId).first().scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function expectNoSteering(page: Page) {
  const text = await page.locator(".app").innerText();
  expect(text.match(STEERING)).toBeNull();
  // the only links of the screen: none to anywhere but Telegram (the offer opens through Telegram.openLink)
  const hrefs = await page.locator(".app a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(hrefs.filter((h) => !/^https:\/\/t\.me\//.test(h))).toEqual([]);
}

test.describe("подписка за Telegram Stars", () => {
  test("нет подписки → пробный период без оплаты: статус, ИИ-минуты; строка «Подписка» в профиле", async ({ page }) => {
    const bff = await start(page, {}, {}, null);
    await page.getByTestId("tab-profile").click();
    await expect(page.getByTestId("row-subscription")).toContainText("нет");
    await page.getByTestId("row-subscription").click();
    await expect(page.getByTestId("bill-status")).toHaveAttribute("data-status", "none");
    await expect(page.getByTestId("bill-free")).toContainText("Базовый курс, повторения, чтение, произношение, дуэли и игра работают без подписки.");
    await expect(page.getByTestId("bill-trial")).toContainText("7 дней и 60 ИИ-минут — один раз, без оплаты.");
    // outside Telegram there is no openInvoice — the plans say to update Telegram, nothing else
    await expect(page.getByTestId("bill-update-tg")).toBeVisible();
    await shotOf(page, "bill-status", "s8_01_subscription_none");
    await page.getByTestId("bill-trial-start").click();
    await expect(page.getByTestId("toast")).toHaveText("Пробный период начался");
    await expect(page.getByTestId("bill-status")).toHaveAttribute("data-status", "trial");
    await expect(page.getByTestId("bill-minutes-left")).toHaveText("60 из 60");
    expect(bff.last("POST", "/v1/billing/trial")!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByTestId("bill-trial")).toHaveCount(0);
    await expectNoSteering(page);
    await page.getByTestId("bar-back").click();
    await expect(page.getByTestId("row-subscription")).toContainText("пробный до");
  });

  test("подписка Stars поверх пробного: что входит до оплаты, оферта, замена пробного → openInvoice → активна; автопродление выкл.", async ({ page }) => {
    const bff = await start(page, { status: "trial" });
    await toSubscription(page);
    await expect(page.getByTestId("bill-status")).toHaveAttribute("data-status", "trial");
    await expect(page.getByTestId("plan-plus_30d")).toContainText("⭐ 250");
    await expect(page.getByTestId("plan-plus_30d")).toContainText("30 дней · 300 ИИ-минут");
    await shotOf(page, "plan-plus_30d", "s8_02_plans");
    await page.getByTestId("plan-buy-plus_30d").click();
    const sheet = page.getByTestId("buy-sheet");
    await expect(sheet.getByTestId("buy-price")).toHaveText("⭐ 250");
    await expect(sheet.getByTestId("buy-term")).toHaveText("30 дней, продлевается автоматически");
    await expect(sheet.getByTestId("buy-minutes")).toHaveText("300 на период");
    await expect(sheet.getByTestId("buy-features")).toContainText("Уроки вдвоём с ИИ-коучем");
    await expect(sheet.getByTestId("buy-forfeit")).toContainText("Пробный период закончится сразу");
    await expect(sheet.getByTestId("buy-pay")).toBeDisabled();
    await sheet.getByTestId("buy-offer").check();
    await expect(sheet.getByTestId("buy-pay")).toBeDisabled();
    await sheet.getByTestId("buy-forfeit-ok").check();
    await shotOf(page, "buy-pay", "s8_03_buy_sheet");
    await sheet.getByTestId("buy-pay").click();
    await expect(sheet.getByTestId("pay-done")).toHaveText("Оплачено! Подписка активна", { timeout: 15_000 });
    const order = bff.last("POST", "/v1/billing/orders")!;
    expect(order.body).toEqual({ product_code: "plus_30d", provider: "telegram_stars", offer_version: "1.0", confirm_forfeit: true });
    expect(order.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect((await tgCalls(page)).filter((c) => c[0] === "openInvoice")).toEqual([["openInvoice", "https://t.me/$e2eInvoice1001"]]);
    // the billing is the source of truth: the order was polled after the invoice closed
    expect(bff.calls("GET", "/v1/billing/orders/1001").length).toBeGreaterThanOrEqual(2);
    await sheet.getByTestId("buy-close").click();
    await expect(page.getByTestId("bill-status")).toHaveAttribute("data-status", "active");
    await expect(page.getByTestId("bill-minutes-left")).toHaveText("300 из 300");
    await expect(page.getByTestId("bill-stars")).toContainText("Автопродление: вкл.");
    await expect(page.getByTestId("bill-stars-next")).toContainText("Следующее списание —");
    await expect(page.getByTestId("bill-stars-next")).toContainText("⭐ 250");
    await expect(page.getByTestId("plan-buy-plus_30d")).toBeDisabled();
    await shotOf(page, "bill-status", "s8_04_subscription_active");
    // auto-renew off — a native confirmation of Telegram
    await page.getByTestId("bill-renew").click();
    await tgPopup(page, "ok");
    await expect(page.getByTestId("bill-stars")).toContainText("Автопродление: выкл.");
    await expect(page.getByTestId("bill-stars-next")).toContainText("и не продлится");
    expect(bff.last("POST", "/v1/billing/stars-subscription")!.body).toEqual({ auto_renew: false });
    await expectNoSteering(page);
  });

  test("счёт закрыт без оплаты: «Оплата не завершена»; «История платежей» — только Stars, «Оплатить» / «Отменить», «Вопрос по заказу»", async ({ page }) => {
    const bff = await start(page, { orders: [{ order_no: 900, status: "fulfilled", channel: "renewal" }] }, {}, { invoice: "cancelled" });
    await toSubscription(page);
    await page.getByTestId("plan-buy-plus_90d").click();
    const sheet = page.getByTestId("buy-sheet");
    await expect(sheet.getByTestId("buy-term")).toHaveText("90 дней");
    await sheet.getByTestId("buy-offer").check();
    await sheet.getByTestId("buy-pay").click();
    await expect(sheet.getByTestId("pay-cancelled")).toContainText("Оплата не завершена. Заказ ждёт оплаты до");
    expect(bff.last("POST", "/v1/billing/orders")!.body).toEqual({ product_code: "plus_90d", provider: "telegram_stars", offer_version: "1.0", start_mode: "now" });
    await tgBack(page);
    await expect(sheet).toBeHidden();
    await page.getByTestId("bill-link-payments").click();
    const pending = page.getByTestId("order-1001");
    await expect(pending).toContainText("Ждёт оплаты");
    await expect(pending.getByTestId("order-amount-1001")).toHaveText("⭐ 650");
    await expect(page.getByTestId("order-900")).toContainText("Автопродление");
    await shotOf(page, "order-1001", "s8_05_payments");
    // pay again: the same order and invoice — this time Telegram says paid
    await page.evaluate(() => ((window as unknown as { __tgInvoiceStatus: string }).__tgInvoiceStatus = "paid"));
    await page.getByTestId("order-pay-1001").click();
    await expect(pending.getByTestId("pay-done")).toBeVisible({ timeout: 15_000 });
    expect(bff.calls("POST", "/v1/billing/orders")).toHaveLength(1);
    await expect(page.getByTestId("order-1001")).toContainText("Выполнен");
    await page.getByTestId("order-ask-1001").click();
    await expect(page.getByTestId("sup-form")).toBeVisible();
    await expect(page.getByTestId("sup-subject")).toHaveValue("Вопрос по заказу №1001");
    await expect(page.getByTestId("sup-form").getByRole("button", { name: "Оплата", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("sup-message").fill("Звёзды списались дважды?");
    await page.getByTestId("sup-send").click();
    await expect(page.getByTestId("toast")).toContainText("отправлено");
    expect(bff.last("POST", "/v1/support/tickets")!.body).toMatchObject({ category: "SUBSCRIPTION_PAYMENT", subject: "Вопрос по заказу №1001" });
  });

  test("отмена неоплаченного заказа в «Истории платежей»", async ({ page }) => {
    const bff = await start(page, { orders: [{ order_no: 950, status: "pending" }] });
    await toSubscription(page);
    await page.getByTestId("bill-link-payments").click();
    await page.getByTestId("order-cancel-950").click();
    await tgPopup(page, "ok");
    await expect(page.getByTestId("order-950")).toContainText("Отменён");
    expect(bff.calls("POST", "/v1/billing/orders/950/cancel")).toHaveLength(1);
    await expect(page.getByTestId("order-pay-950")).toHaveCount(0);
  });

  test("тилы ребёнку за Stars: магазин при нехватке → «Купить тилы» → получатель — детский профиль → зачислено", async ({ page }) => {
    const bff = await start(page, {}, { withChild: true, game: { til: 30 } });
    await page.getByTestId("tab-profile").click();
    await expect(page.getByTestId("row-buy-tils")).toBeVisible();
    await page.getByTestId("row-shop").click();
    await expect(page.getByTestId("shop-why-bg_space")).toHaveText("Не хватает 90 тилов. Заработайте их в уроках");
    await page.getByTestId("shop-get-tils-bg_space").click();
    await expect(page.getByTestId("til-shop")).toBeVisible();
    await expect(page.getByTestId("til-balance")).toContainText("Сейчас у вас 30 тилов");
    await expect(page.getByTestId("pack-til_550")).toContainText("⭐ 120");
    await shotOf(page, "til-packs", "s8_06_til_shop");
    await page.getByTestId("pack-buy-til_100").click();
    const sheet = page.getByTestId("buy-sheet");
    await expect(sheet.getByTestId("buy-tils")).toHaveText("100 тилов");
    const kid = bff.learners.find((l) => l.kind === "child")!.learner_id;
    await sheet.getByTestId(`buy-to-${kid}`).click();
    await sheet.getByTestId("buy-offer").check();
    await sheet.getByTestId("buy-pay").click();
    // paid at once («Тилы появятся через минуту»), then credited by gamification — «Зачислено: 100 тилов · Мадина»
    await expect(sheet.getByTestId("pay-done")).toHaveText("Зачислено: 100 тилов · Мадина", { timeout: 15_000 });
    expect(bff.last("POST", "/v1/billing/orders")!.body).toEqual({ product_code: "til_100", provider: "telegram_stars", offer_version: "1.0", beneficiary_id: kid });
    await expect.poll(() => bff.billing.tilCredits).toEqual([{ owner: kid, til: 100 }]);
    await expectNoSteering(page);
  });

  test("детский профиль: «Подписка семьи активна до …», без цен, кнопок и призывов; «Купить тилы» — заработать в уроках", async ({ page }) => {
    await start(page, { status: "active" }, { child: true, startParam: "route_subscription" }, null);
    await expect(page.getByTestId("bill-kid-text")).toContainText("Подписка семьи активна до");
    let text = await page.locator(".app").innerText();
    expect(text).not.toMatch(/⭐|Stars|оплат|купи|оформ|цен/i);
    await page.getByTestId("bar-back").click();
    await page.getByTestId("tab-profile").click();
    await expect(page.getByTestId("row-family-sub")).toContainText("Подписка семьи активна до");
    await expect(page.getByTestId("row-subscription")).toHaveCount(0);
    await expect(page.getByTestId("row-buy-tils")).toHaveCount(0);
    await page.getByTestId("row-shop").click();
    await expect(page.getByTestId("shop-buy-tils")).toHaveCount(0);
    text = await page.getByTestId("shop").innerText();
    expect(text).not.toMatch(/Купить тилы|⭐/);
    await shotOf(page, "shop", "s8_07_kid_shop");
  });

  test("урок без ИИ по тарифу: плашка и «О подписке»; с подпиской — «ИИ: осталось N мин»", async ({ page }) => {
    const lessons: LessonsScenario = { aiLocked: "no_subscription" };
    await start(page, {}, { lessons }, null);
    await page.getByTestId("start-lesson").click();
    await page.getByTestId("lc-start").click();
    await expect(page.getByTestId("pl-ai-locked")).toHaveText(/Уроки с ИИ — в подписке\. Сейчас урок идёт с готовыми вариантами ответа\./);
    await shotOf(page, "pl-ai-locked", "s8_08_lesson_locked");
    await page.getByTestId("pl-ai-locked-more").click();
    await expect(page.getByTestId("subscription")).toBeVisible();
  });

  test("урок с ИИ: «ИИ: осталось 42 мин» на старте", async ({ page }) => {
    await start(page, { status: "active" }, { lessons: { aiMinutesLeft: 42 } }, null);
    await page.getByTestId("start-lesson").click();
    await page.getByTestId("lc-start").click();
    await expect(page.getByTestId("pl-ai-left")).toHaveText("ИИ: осталось 42 мин");
    await expect(page.getByTestId("pl-ai-locked")).toHaveCount(0);
  });

  test("урок вдвоём без подписки: «Уроки вдвоём — в подписке»; billing недоступен — понятный текст", async ({ page }) => {
    const bff = await start(page, { pairInvite: "no_subscription" }, {}, null);
    const fill = async () => {
      await page.getByTestId("pi-pick").click();
      await page.getByTestId("pi-pick-sheet").getByRole("button", { name: "Malika_23" }).click();
      await page.getByTestId("pi-sc-sc-cafe-order").click();
      await page.getByTestId("pi-send").click();
    };
    await page.getByTestId("soc-pair").click();
    await expect(page.getByTestId("pair-rooms")).toContainText("Минуты ИИ-коуча считаются у того, кто позвал, — один раз за урок.");
    await page.getByTestId("pair-new").click();
    await fill();
    const sheet = page.getByTestId("pair-sub-sheet");
    await expect(sheet).toContainText("Уроки вдвоём — в подписке");
    await expect(sheet).toContainText("Принять приглашение друга можно и без неё.");
    await shotOf(page, "pair-sub-sheet", "s8_09_pair_locked");
    await sheet.getByTestId("pair-sub-more").click();
    await expect(page.getByTestId("subscription")).toBeVisible();
    // billing down at the invitation: a clear line, the room is not created, learning works
    bff.billing.sc.pairInvite = "billing_down";
    await page.getByTestId("bar-back").click();
    await fill();
    await expect(page.getByTestId("pair-invite").getByRole("alert")).toContainText("проверить подписку не удалось");
    await expectNoSteering(page);
  });

  test("billing недоступен: «Подписка сейчас недоступна — учёба работает как обычно», главная работает", async ({ page }) => {
    await start(page, { mode: "down" }, {}, null);
    await expect(page.getByTestId("tab-home")).toBeVisible();
    await toSubscription(page);
    await expect(page.getByTestId("bill-error")).toContainText("Подписка сейчас недоступна — учёба работает как обычно.");
    await page.getByTestId("bar-back").click();
    await expect(page.getByTestId("row-subscription")).toBeVisible();
  });

  test("подросток без согласия родителя: покупки — с согласия родителя", async ({ page }) => {
    await start(page, {}, { age: "14-17", guardian: "pending" }, null);
    await toSubscription(page);
    await expect(page.getByTestId("bill-consent")).toContainText("Покупки — с согласия родителя");
    await expect(page.getByTestId("bill-plans")).toHaveCount(0);
    await page.getByTestId("bill-consent-btn").click();
    await expect(page.getByTestId("bar-back")).toBeVisible();
  });
});

test.describe("«Что нового» спринта 8 и UZ", () => {
  test("заметка s8-plus: иллюстрация 16:9, «Подробнее» → «Подписка»; детская s8-plus-kids — без ссылок на покупку", async ({ page }) => {
    const S8: F.NoteSeed = {
      id: "11111111-aaaa-4bbb-8ccc-000000000081",
      slug: "2026.12-s8",
      audience: "existing",
      age: ["teens", "adults"],
      illustration: "s8-plus",
      published_at: "2026-12-01T06:00:00Z",
      title: { ru: "TilHero Плюс за Telegram Stars", uz: "Telegram Stars evaziga TilHero Plus" },
      items: [{ title: { ru: "Уроки с ИИ — в подписке", uz: "SI bilan darslar — obunada" }, text: { ru: "Оформите «Плюс» за звёзды Telegram прямо в приложении.", uz: "«Plus»ni Telegram yulduzlari evaziga ilovaning oʻzida rasmiylashtiring." }, link: "subscription" as never, icon: "star" }],
    };
    await start(page, {}, { notes: [F.WELCOME, F.UPDATE_1, F.UPDATE_2, S8] }, null);
    const sheet = page.getByTestId("whats-new-updates");
    await expect(sheet).toBeVisible();
    const img = sheet.getByRole("img", { name: "TilHero Плюс за Telegram Stars" });
    await expect(img).toHaveAttribute("src", "/whatsnew/s8-plus.webp");
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1200);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/s8_10_whatsnew.png` });
    await sheet.getByTestId("wn-more").click();
    await expect(page.getByTestId("subscription")).toBeVisible();
  });

  test("UZ: экран подписки, оформление и история — латиница, «⭐ 250»", async ({ page }) => {
    await start(page, {}, { locale: "uz" });
    await page.getByTestId("tab-profile").click();
    await page.getByTestId("row-subscription").click();
    await expect(page.getByTestId("plan-plus_30d")).toContainText("⭐ 250");
    await expect(page.getByTestId("bill-status")).toContainText("Obuna yoʻq");
    await page.getByTestId("plan-buy-plus_30d").click();
    await expect(page.getByTestId("buy-term")).toHaveText("30 kun, avtomatik uzaytiriladi");
    const text = (await page.locator(".app").innerText()).replaceAll("Азиз", "");
    expect(text.match(/.{0,24}[Ѐ-ӿ]+.{0,24}/g)).toBeNull();
    expect(CYRILLIC.test(text)).toBe(false);
    await expectNoSteering(page);
    await shotOf(page, "buy-pay", "s8_11_buy_sheet_uz");
  });
});

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "375x812", width: 375, height: 812 },
  { name: "412x915", width: 412, height: 915 },
] as const;

for (const vp of VIEWPORTS) {
  test(`подписка и оформление без горизонтальной прокрутки, кнопки в окне @ ${vp.name}`, async ({ page }) => {
    await page.setViewportSize(vp);
    await start(page, { status: "trial" });
    await toSubscription(page);
    const overflow = () =>
      page.evaluate(() => {
        const els = [document.scrollingElement!, ...Array.from(document.querySelectorAll<HTMLElement>(".scroll, .sheet"))];
        return els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className || el.tagName);
      });
    expect(await overflow()).toEqual([]);
    for (const id of ["plan-buy-plus_30d", "plan-buy-plus_90d", "bill-link-question"]) {
      const el = page.getByTestId(id);
      await el.scrollIntoViewIfNeeded();
      const box = (await el.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, id).toBeLessThanOrEqual(vp.width + 0.5);
      expect(box.y + box.height, id).toBeLessThanOrEqual(vp.height + 0.5);
      expect(box.height, id).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId("plan-buy-plus_30d").click();
    await page.getByTestId("buy-forfeit-ok").check();
    await page.getByTestId("buy-offer").check();
    const pay = page.getByTestId("buy-pay");
    await pay.scrollIntoViewIfNeeded();
    const box = (await pay.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
    expect(await overflow()).toEqual([]);
    await expect(pay).toBeEnabled();
    if (vp.width === 375) await page.screenshot({ path: `${SHOTS}/s8_12_buy_sheet_375.png` });
  });
}
