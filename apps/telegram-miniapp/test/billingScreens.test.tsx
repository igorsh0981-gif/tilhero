/**
 * Sprint 8 screens: «Подписка» (status, minutes, trial, plans, the Stars subscription and its auto-renew), the purchase
 * sheet (what is included before the payment, the offer, the trial forfeit, openInvoice → the poll), «История платежей»,
 * a child profile without prices and buttons, the plaque of a lesson without AI, «Уроки вдвоём — в подписке», «Вопрос по
 * оплате» in support.
 */
import type { BillingCatalog, LearningPlan, SessionResponse, StarsOrder, SubscriptionView } from "@tilhero/contracts/bff";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createBff } from "../src/api/bff";
import { ApiClient } from "../src/api/client";
import { ApiError } from "../src/api/errors";
import { FALLBACK_CONFIG } from "../src/config/experience";
import { socialErrorText } from "../src/domain/social";
import { I18nProvider, makeI18n } from "../src/i18n";
import { AiPlanPlaque, PairSubscriptionSheet } from "../src/screens/billing/parts";
import { PaymentsScreen } from "../src/screens/billing/Payments";
import { SubscriptionScreen } from "../src/screens/billing/Subscription";
import { TilShopScreen } from "../src/screens/billing/TilShop";
import { Support } from "../src/screens/support/Support";
import { AppProvider, type AppCtx } from "../src/state/app";
import { useNav } from "../src/state/nav";
import { resetInvoiceForTests } from "../src/tg";
import { PopupHost, ToastHost } from "../src/ui/overlays";
import { installTg, uninstallTg } from "./tgFake";

const ME = "11111111-1111-4111-8111-111111111111";
const KID = "22222222-2222-4222-8222-222222222222";
const L = (ru: string) => ({ ru, uz: `${ru} uz` });

type Reply = [number, unknown] | ((body: unknown) => [number, unknown]) | "network";
const err = (status: number, code: string, details: Record<string, unknown> = {}): [number, unknown] => [status, { code, message: code, trace_id: "t", details }];

function fakeBff(routes: Record<string, Reply | Reply[]>) {
  const calls: Array<{ key: string; body: unknown; headers: Record<string, string> }> = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) && typeof v[0] !== "number" ? [...(v as Reply[])] : [v as Reply]]));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ key, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const q = queues.get(key);
    const r = q ? (q.length > 1 ? q.shift()! : q[0]!) : err(404, "NOT_FOUND");
    if (r === "network") throw new TypeError("Failed to fetch");
    const [status, payload] = typeof r === "function" ? r(body) : r;
    return new Response(status === 204 ? null : JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new ApiClient({ baseUrl: "", fetchImpl, storage: null, timezone: () => "Asia/Tashkent" });
  return { calls, bff: createBff(client), of: (key: string) => calls.filter((c) => c.key === key) };
}

function makeSession(kid: boolean, age: "18+" | "14-17" = "18+"): SessionResponse {
  const self = { learner_id: ME, kind: "self" as const, display_name: "Азиз", age_band: age, is_active: !kid, onboarding_completed: true, voice_consent: false };
  const child = { learner_id: KID, kind: "child" as const, display_name: "Мадина", age_band: "6-9" as const, is_active: kid, onboarding_completed: true, voice_consent: false };
  return {
    access_token: "acc",
    expires_in: 900,
    refresh_token: "ref",
    account: { user_id: ME, display_name: "Азиз", username: null, locale: "ru", status: "ACTIVE", is_new: false, age_band: age, guardian_consent: age === "14-17" ? "pending" : "not_required" },
    learner: kid ? child : self,
    learners: [self, child],
    security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null, pin_reset_effective_at: null },
    consent: { accepted: true, policy_version: "1.2", current_policy_version: "1.2", accepted_at: "2026-11-10T08:00:00Z", evidence_hash: "sha256:x", purposes: ["terms", "privacy", "learning"] },
    onboarding_completed: true,
    start_param: null,
  };
}

const PLAN = { learner_id: ME, goal: "travel", level_self: "some", topics: [], ui_lang: "ru", explain_lang: "ru", course_pair: "ru-en", schedule: { preset: "three_per_week", days: [1, 3, 5], preferred_time: "19:00", duration_min: 20, reminders_enabled: true, timezone: "Asia/Tashkent" }, onboarding_completed_at: "2026-11-10T08:00:00Z", updated_at: "2026-11-10T08:00:00Z", version: 3 } as unknown as LearningPlan;

function Shell({ kid, age, bff, children }: { kid: boolean; age?: "18+" | "14-17"; bff: ReturnType<typeof createBff>; children: ReactNode }) {
  const [session] = useState(() => makeSession(kid, age));
  const [plan, setPlan] = useState<LearningPlan>(PLAN);
  const nav = useNav();
  const ctx: AppCtx = {
    bff,
    session,
    applySession: async () => undefined,
    syncProfile: () => undefined,
    patchSession: () => undefined,
    plan,
    setPlan,
    reloadPlan: async () => plan,
    config: FALLBACK_CONFIG,
    nav,
    unread: 0,
    setUnread: () => undefined,
    refreshUnread: () => undefined,
    openLink: () => undefined,
    endSession: () => undefined,
    deviceTz: "Asia/Tashkent",
    online: true,
  };
  return (
    <AppProvider value={ctx}>
      <div className="app">
        {nav.top ? <p data-testid="pushed">{JSON.stringify(nav.top)}</p> : null}
        {children}
        <PopupHost />
        <ToastHost />
      </div>
    </AppProvider>
  );
}

function mount(ui: ReactNode, routes: Record<string, Reply | Reply[]>, o: { kid?: boolean; age?: "18+" | "14-17" } = {}) {
  const f = fakeBff(routes);
  render(
    <I18nProvider initial="ru">
      <Shell kid={!!o.kid} age={o.age} bff={f.bff}>
        {ui}
      </Shell>
    </I18nProvider>,
  );
  return f;
}

const PERIOD = { starts_at: "2026-11-20T09:00:00Z", ends_at: "2026-12-20T09:00:00Z", minutes_granted: 300, minutes_spent: 12, minutes_held: 3, minutes_left: 285, overage: 0 };
const SUB = (o: Partial<SubscriptionView> = {}): SubscriptionView => ({
  status: "none",
  plan: null,
  period: null,
  next_period: null,
  features: [],
  expiring: false,
  minutes_exhausted: false,
  payer_required: false,
  can_pay: true,
  trial_available: true,
  sales_enabled: true,
  stars_subscription: null,
  ...o,
});
const ACTIVE = SUB({ status: "active", plan: { code: "plus_30d", title: L("TilHero Плюс") }, period: PERIOD, features: ["ai_lessons", "pair_lessons"], trial_available: false });
const CATALOG = (o: Partial<BillingCatalog> = {}): BillingCatalog => ({
  sales_enabled: true,
  providers: ["telegram_stars"],
  offer: { version: "1.0", url: "https://miniapp.tilhero.test/legal/offer" },
  trial: { available: true, days: 7, minutes: 60 },
  products: [
    { code: "plus_30d", kind: "subscription", title: L("TilHero Плюс — 30 дней"), description: null, days: 30, minutes: 300, features: ["ai_lessons", "pair_lessons"], til: null, price: { stars: 250, mode: "subscription" } },
    { code: "plus_90d", kind: "subscription", title: L("TilHero Плюс — 90 дней"), description: null, days: 90, minutes: 900, features: ["ai_lessons", "pair_lessons"], til: null, price: { stars: 650, mode: "one_time" } },
    { code: "til_100", kind: "til_pack", title: L("100 тилов"), description: null, days: null, minutes: null, features: [], til: 100, price: { stars: 25, mode: "one_time" } },
  ],
  payer_required: false,
  can_pay: true,
  consent_required: false,
  ...o,
});
const ORDER = (status: StarsOrder["status"], o: Partial<StarsOrder> = {}): StarsOrder => ({
  order_no: 1001,
  status,
  channel: "miniapp",
  product: { code: "plus_30d", kind: "subscription", title: L("TilHero Плюс — 30 дней") },
  currency: "XTR",
  amount_stars: 250,
  provider: "telegram_stars",
  invoice_link: status === "pending" ? "https://t.me/$inv1001" : null,
  expires_at: "2026-11-22T10:00:00Z",
  created_at: "2026-11-22T09:00:00Z",
  paid_at: status === "pending" ? null : "2026-11-22T09:01:00Z",
  refund: null,
  ...o,
});

/** Telegram 8.0 with openInvoice answering `status` (and recording the link). */
function telegramWithInvoice(status: string) {
  const tg = installTg();
  tg.wa.openInvoice = (url: string, cb: (s: string) => void) => {
    tg.calls.push(["openInvoice", url]);
    setTimeout(() => cb(status), 0);
  };
  return tg;
}

afterEach(() => {
  uninstallTg();
  resetInvoiceForTests();
});

const FORBIDDEN = /(?<![a-z])(payme|click|uzum)(?![a-z])|(?<!\p{L})сум(?!\p{L})|so[ʻ']m|сайт|дешевле|другим способом/iu;

describe("«Подписка»", () => {
  it("no subscription: status, what is free, the trial (Idempotency-Key) → trial with the minutes meter", async () => {
    const f = mount(<SubscriptionScreen />, {
      "GET /v1/billing/subscription": [200, SUB()],
      "GET /v1/billing/catalog": [200, CATALOG()],
      "POST /v1/billing/trial": [201, SUB({ status: "trial", period: { ...PERIOD, minutes_granted: 60, minutes_left: 60, minutes_spent: 0, minutes_held: 0 }, features: ["ai_lessons", "pair_lessons"], trial_available: false })],
    });
    expect(await screen.findByTestId("bill-status")).toHaveAttribute("data-status", "none");
    expect(screen.getByTestId("bill-free")).toHaveTextContent("Базовый курс, повторения, чтение");
    expect(screen.getByTestId("bill-trial")).toHaveTextContent("7 дней и 60 ИИ-минут — один раз, без оплаты.");
    await userEvent.click(screen.getByTestId("bill-trial-start"));
    await waitFor(() => expect(screen.getByTestId("bill-status")).toHaveAttribute("data-status", "trial"));
    expect(screen.getByTestId("bill-minutes-left")).toHaveTextContent("60 из 60");
    const call = f.of("POST /v1/billing/trial")[0]!;
    expect(call.headers["Idempotency-Key"] ?? call.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.queryByTestId("bill-trial")).toBeNull();
  });

  it("plans for Stars: the price «⭐ 250», 30 days · 300 AI minutes, auto-renew vs one-off; a live Stars subscription blocks a second one", async () => {
    mount(<SubscriptionScreen />, {
      "GET /v1/billing/subscription": [200, { ...ACTIVE, stars_subscription: { status: "active", auto_renew: true, expires_at: "2026-12-20T09:00:00Z", amount_stars: 250 } }],
      "GET /v1/billing/catalog": [200, CATALOG()],
    });
    const p30 = await screen.findByTestId("plan-plus_30d");
    expect(p30).toHaveTextContent("⭐ 250");
    expect(p30).toHaveTextContent("30 дней · 300 ИИ-минут");
    expect(p30).toHaveTextContent("Продлевается каждые 30 дней");
    expect(within(p30).getByTestId("plan-price-plus_30d")).toHaveAccessibleName("250 звёзд Telegram");
    expect(screen.getByTestId("plan-buy-plus_30d")).toBeDisabled();
    expect(screen.getByTestId("plan-why-plus_30d")).toHaveTextContent("Подписка Telegram Stars уже оформлена.");
    expect(screen.getByTestId("plan-plus_90d")).toHaveTextContent("Разовая оплата, без автопродления");
    expect(screen.getByTestId("plan-buy-plus_90d")).toBeEnabled();
    // the Stars subscription of the account: auto-renew and the next charge
    expect(screen.getByTestId("bill-stars")).toHaveTextContent("Автопродление: вкл.");
    expect(screen.getByTestId("bill-stars-next")).toHaveTextContent("Следующее списание — 20 декабря, ⭐ 250");
    expect(screen.getByTestId("bill-minutes")).toHaveTextContent("285 из 300");
    expect(screen.getByRole("progressbar", { name: "ИИ-минуты" })).toHaveAttribute("aria-valuetext", "ИИ-минуты: осталось 285 из 300");
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  it("auto-renew off: a confirmation, then POST /v1/billing/stars-subscription {auto_renew: false}", async () => {
    const stars = { status: "active" as const, auto_renew: true, expires_at: "2026-12-20T09:00:00Z", amount_stars: 250 };
    const f = mount(<SubscriptionScreen />, {
      "GET /v1/billing/subscription": [200, { ...ACTIVE, stars_subscription: stars }],
      "GET /v1/billing/catalog": [200, CATALOG()],
      "POST /v1/billing/stars-subscription": [200, { ...ACTIVE, stars_subscription: { ...stars, status: "canceled", auto_renew: false } }],
    });
    await userEvent.click(await screen.findByTestId("bill-renew"));
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg).toHaveTextContent("Подписка будет действовать до 20 декабря");
    await userEvent.click(within(dlg).getByRole("button", { name: "Отключить" }));
    await waitFor(() => expect(screen.getByTestId("bill-stars")).toHaveTextContent("Автопродление: выкл."));
    expect(screen.getByTestId("bill-stars-next")).toHaveTextContent("Подписка действует до 20 декабря и не продлится.");
    expect(f.of("POST /v1/billing/stars-subscription")[0]!.body).toEqual({ auto_renew: false });
    expect(screen.getByTestId("bill-renew")).toHaveTextContent("Включить автопродление");
  });

  it("sales off / a teen without the parent's consent / Telegram without openInvoice — words instead of buttons", async () => {
    mount(<SubscriptionScreen />, { "GET /v1/billing/subscription": [200, SUB()], "GET /v1/billing/catalog": [200, CATALOG({ sales_enabled: false, providers: [] })] });
    expect(await screen.findByTestId("bill-sales-off")).toHaveTextContent("Покупки временно недоступны. Учёба работает как обычно.");
    expect(screen.queryByTestId("bill-plans")).toBeNull();
  });

  it("a teen without consent: «Покупки — с согласия родителя» and the way to ask the parent; no plans, no trial", async () => {
    mount(<SubscriptionScreen />, { "GET /v1/billing/subscription": [200, SUB({ can_pay: false })], "GET /v1/billing/catalog": [200, CATALOG({ can_pay: false, consent_required: true })] }, { age: "14-17" });
    expect(await screen.findByTestId("bill-consent")).toHaveTextContent("Покупки — с согласия родителя");
    expect(screen.queryByTestId("bill-plans")).toBeNull();
    expect(screen.queryByTestId("bill-trial")).toBeNull();
    await userEvent.click(screen.getByTestId("bill-consent-btn"));
    expect(screen.getByTestId("pushed")).toHaveTextContent('"name":"guardian"');
  });

  it("billing down — «учёба работает как обычно» and «Повторить»", async () => {
    mount(<SubscriptionScreen />, { "GET /v1/billing/subscription": err(503, "BILLING_UNAVAILABLE", { service: "billing" }), "GET /v1/billing/catalog": err(503, "BILLING_UNAVAILABLE") });
    expect(await screen.findByTestId("bill-error")).toHaveTextContent("Подписка сейчас недоступна — учёба работает как обычно.");
  });

  it("a child profile: only the family status — no prices, no buttons, the catalogue is not asked", async () => {
    const f = mount(<SubscriptionScreen />, { "GET /v1/billing/subscription": [200, { ...ACTIVE, payer_required: true, can_pay: false }] }, { kid: true });
    expect(await screen.findByTestId("bill-kid-text")).toHaveTextContent("Подписка семьи активна до 20 декабря");
    expect(document.body.textContent).not.toMatch(/⭐|Stars|оплат|купи|оформ/i);
    expect(screen.queryAllByRole("button").filter((b) => b.dataset.testid !== "bar-back")).toHaveLength(0);
    expect(f.of("GET /v1/billing/catalog")).toHaveLength(0);
  });
});

describe("the purchase sheet and openInvoice", () => {
  it("before the payment: the price, the term, the minutes, what is included; the offer must be accepted; paid → polled until fulfilled", async () => {
    const tg = telegramWithInvoice("paid");
    const f = mount(<SubscriptionScreen />, {
      "GET /v1/billing/subscription": [[200, SUB()], [200, { ...ACTIVE, stars_subscription: { status: "active", auto_renew: true, expires_at: "2026-12-20T09:00:00Z", amount_stars: 250 } }]],
      "GET /v1/billing/catalog": [200, CATALOG()],
      "POST /v1/billing/orders": [201, ORDER("pending")],
      "GET /v1/billing/orders/1001": [[200, ORDER("pending")], [200, ORDER("fulfilled")]],
    });
    await userEvent.click(await screen.findByTestId("plan-buy-plus_30d"));
    const sheet = screen.getByTestId("buy-sheet");
    expect(within(sheet).getByTestId("buy-price")).toHaveTextContent("⭐ 250");
    expect(within(sheet).getByTestId("buy-term")).toHaveTextContent("30 дней, продлевается автоматически");
    expect(within(sheet).getByTestId("buy-minutes")).toHaveTextContent("300 на период");
    expect(within(sheet).getByTestId("buy-features")).toHaveTextContent("Уроки с ИИ");
    expect(within(sheet).getByTestId("buy-renews")).toHaveTextContent("Отключить можно здесь или в настройках Telegram.");
    const pay = within(sheet).getByTestId("buy-pay");
    expect(pay).toBeDisabled();
    expect(pay).toHaveAccessibleName("Оплатить 250 звёзд Telegram");
    await userEvent.click(within(sheet).getByTestId("buy-offer"));
    await userEvent.click(pay);
    expect(await within(sheet).findByTestId("pay-done", {}, { timeout: 4000 })).toHaveTextContent("Оплачено! Подписка активна");
    expect(f.of("POST /v1/billing/orders")[0]!.body).toEqual({ product_code: "plus_30d", provider: "telegram_stars", offer_version: "1.0" });
    expect(tg.calls.filter((c) => c[0] === "openInvoice")).toEqual([["openInvoice", "https://t.me/$inv1001"]]);
    expect(f.of("GET /v1/billing/orders/1001").length).toBeGreaterThanOrEqual(2);
    expect(sheet.textContent).not.toMatch(FORBIDDEN);
  });

  it("over a trial: the forfeit must be confirmed (confirm_forfeit); 409 FORFEIT_CONFIRMATION_REQUIRED shows the numbers", async () => {
    telegramWithInvoice("paid");
    const trial = SUB({ status: "trial", period: { ...PERIOD, minutes_granted: 60, minutes_left: 45 }, features: ["ai_lessons"], trial_available: false });
    const f = mount(<SubscriptionScreen />, {
      "GET /v1/billing/subscription": [200, trial],
      "GET /v1/billing/catalog": [200, CATALOG()],
      "POST /v1/billing/orders": [201, ORDER("pending")],
      "GET /v1/billing/orders/1001": [200, ORDER("fulfilled")],
    });
    await userEvent.click(await screen.findByTestId("plan-buy-plus_30d"));
    expect(screen.getByTestId("buy-forfeit")).toHaveTextContent("Пробный период закончится сразу");
    await userEvent.click(screen.getByTestId("buy-offer"));
    expect(screen.getByTestId("buy-pay")).toBeDisabled();
    await userEvent.click(screen.getByTestId("buy-forfeit-ok"));
    await userEvent.click(screen.getByTestId("buy-pay"));
    await screen.findByTestId("pay-done", {}, { timeout: 3000 });
    expect(f.of("POST /v1/billing/orders")[0]!.body).toMatchObject({ confirm_forfeit: true });
  });

  it("the invoice cancelled: one check of the order, «Оплата не завершена» and «Оплатить снова» (the same order)", async () => {
    const tg = telegramWithInvoice("cancelled");
    const f = mount(<SubscriptionScreen />, {
      "GET /v1/billing/subscription": [200, SUB()],
      "GET /v1/billing/catalog": [200, CATALOG()],
      "POST /v1/billing/orders": [201, ORDER("pending")],
      "GET /v1/billing/orders/1001": [200, ORDER("pending")],
    });
    await userEvent.click(await screen.findByTestId("plan-buy-plus_90d"));
    await userEvent.click(screen.getByTestId("buy-offer"));
    await userEvent.click(screen.getByTestId("buy-pay"));
    expect(await screen.findByTestId("pay-cancelled")).toHaveTextContent("Оплата не завершена. Заказ ждёт оплаты до");
    expect(f.of("GET /v1/billing/orders/1001")).toHaveLength(1);
    await userEvent.click(screen.getByTestId("pay-again"));
    await waitFor(() => expect(tg.calls.filter((c) => c[0] === "openInvoice")).toHaveLength(2));
    expect(f.of("POST /v1/billing/orders")).toHaveLength(1);
  });

  it("outside Telegram (no openInvoice) — no order is created, «Обновите Telegram»", async () => {
    const f = mount(<SubscriptionScreen />, { "GET /v1/billing/subscription": [200, SUB()], "GET /v1/billing/catalog": [200, CATALOG()] });
    expect(await screen.findByTestId("bill-update-tg")).toHaveTextContent("Обновите Telegram");
    await userEvent.click(screen.getByTestId("plan-buy-plus_90d"));
    await userEvent.click(screen.getByTestId("buy-offer"));
    await userEvent.click(screen.getByTestId("buy-pay"));
    expect(await within(screen.getByTestId("buy-sheet")).findByText(/Оплата звёздами работает в приложении Telegram/)).toBeInTheDocument();
    expect(f.of("POST /v1/billing/orders")).toHaveLength(0);
  });

  it("409 OFFER_VERSION_MISMATCH: the offer is unchecked, the catalogue re-read; 503 STARS_UNAVAILABLE — the retry keeps the key", async () => {
    telegramWithInvoice("paid");
    const f = mount(<SubscriptionScreen />, {
      "GET /v1/billing/subscription": [200, SUB()],
      "GET /v1/billing/catalog": [200, CATALOG()],
      "POST /v1/billing/orders": [err(409, "OFFER_VERSION_MISMATCH", { current: "1.1" }), err(503, "STARS_UNAVAILABLE"), [200, ORDER("pending")]],
      "GET /v1/billing/orders/1001": [200, ORDER("fulfilled")],
    });
    await userEvent.click(await screen.findByTestId("plan-buy-plus_90d"));
    await userEvent.click(screen.getByTestId("buy-offer"));
    await userEvent.click(screen.getByTestId("buy-pay"));
    expect(await screen.findByText("Условия обновились — откройте и примите их снова.")).toBeInTheDocument();
    expect(screen.getByTestId("buy-offer")).not.toBeChecked();
    await waitFor(() => expect(f.of("GET /v1/billing/catalog").length).toBeGreaterThanOrEqual(2));
    await userEvent.click(screen.getByTestId("buy-offer"));
    await userEvent.click(screen.getByTestId("buy-pay"));
    expect(await screen.findByTestId("buy-problem")).toHaveAttribute("data-kind", "starsRetry");
    await userEvent.click(screen.getByTestId("buy-pay"));
    await screen.findByTestId("pay-done", {}, { timeout: 3000 });
    const keys = f.of("POST /v1/billing/orders").map((c) => c.headers["Idempotency-Key"] ?? c.headers["idempotency-key"]);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[2]);
  });
});

describe("«История платежей», tils, support", () => {
  it("only Stars orders: status in words, «⭐ N», renewal; pending — «Оплатить» / «Отменить»; «Вопрос по заказу» → support", async () => {
    const f = mount(<PaymentsScreen />, {
      "GET /v1/billing/orders": [200, { items: [ORDER("pending", { order_no: 1003 }), ORDER("fulfilled", { order_no: 1002, channel: "renewal" }), ORDER("refunded", { order_no: 1001, refund: { status: "completed" } })], next_cursor: null }],
      "POST /v1/billing/orders/1003/cancel": [200, ORDER("cancelled", { order_no: 1003 })],
    });
    const pending = await screen.findByTestId("order-1003");
    expect(pending).toHaveTextContent("Ждёт оплаты");
    expect(within(pending).getByTestId("order-amount-1003")).toHaveTextContent("⭐ 250");
    expect(screen.getByTestId("order-1002")).toHaveTextContent("Автопродление");
    expect(screen.getByTestId("order-1001")).toHaveTextContent("Звёзды возвращены");
    expect(screen.queryByTestId("order-pay-1002")).toBeNull();
    await userEvent.click(screen.getByTestId("order-cancel-1003"));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Отменить" }));
    await waitFor(() => expect(f.of("POST /v1/billing/orders/1003/cancel")).toHaveLength(1));
    await userEvent.click(screen.getByTestId("order-ask-1001"));
    expect(screen.getByTestId("pushed")).toHaveTextContent('"category":"SUBSCRIPTION_PAYMENT"');
    expect(screen.getByTestId("pushed")).toHaveTextContent("Вопрос по заказу №1001");
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  it("«Купить тилы»: packs for Stars, the recipient — me or a child profile; a child profile — no prices", async () => {
    telegramWithInvoice("paid");
    const f = mount(<TilShopScreen />, {
      "GET /v1/billing/catalog": [200, CATALOG()],
      "GET /v1/game/summary": err(503, "GAME_UNAVAILABLE"),
      "POST /v1/billing/orders": [201, ORDER("pending", { product: { code: "til_100", kind: "til_pack", title: L("100 тилов") }, amount_stars: 25 })],
      "GET /v1/billing/orders/1001": [200, ORDER("fulfilled", { product: { code: "til_100", kind: "til_pack", title: L("100 тилов") }, amount_stars: 25 })],
    });
    expect(await screen.findByTestId("pack-til_100")).toHaveTextContent("100 тилов");
    expect(screen.queryByTestId("pack-plus_30d")).toBeNull();
    await userEvent.click(screen.getByTestId("pack-buy-til_100"));
    await userEvent.click(screen.getByTestId(`buy-to-${KID}`));
    await userEvent.click(screen.getByTestId("buy-offer"));
    await userEvent.click(screen.getByTestId("buy-pay"));
    expect(await screen.findByTestId("pay-done", {}, { timeout: 3000 })).toHaveTextContent("Зачислено: 100 тилов · Мадина");
    expect(f.of("POST /v1/billing/orders")[0]!.body).toEqual({ product_code: "til_100", provider: "telegram_stars", offer_version: "1.0", beneficiary_id: KID });
  });

  it("«Купить тилы» in a child profile: earn them in lessons — nothing to buy, nothing asked of billing", async () => {
    const f = mount(<TilShopScreen />, {}, { kid: true });
    expect(await screen.findByTestId("til-shop-kid")).toHaveTextContent("Тилы можно заработать в уроках");
    expect(document.body.textContent).not.toMatch(/⭐|Stars|купить за/i);
    expect(f.calls).toHaveLength(0);
  });

  it("«Вопрос по оплате»: the new request opens with SUBSCRIPTION_PAYMENT and the subject (even if the server list lacks it)", async () => {
    mount(<Support category="SUBSCRIPTION_PAYMENT" subject="Вопрос по заказу №1001" />, {
      "GET /v1/support/tickets": [200, { items: [], next_cursor: null }],
      "GET /v1/support/categories": [200, { items: [{ code: "OTHER", label: { ru: "Другое", uz: "Boshqa" }, available: true }] }],
    });
    const form = await screen.findByTestId("sup-form");
    await waitFor(() => expect(within(form).getByRole("button", { name: "Оплата" })).toHaveAttribute("aria-pressed", "true"));
    expect(within(form).getByTestId("sup-subject")).toHaveValue("Вопрос по заказу №1001");
  });
});

describe("a lesson without AI by the plan, the pair lesson", () => {
  it("ai_locked: the reason in words and «О подписке»; billing unavailable — no call to buy; with AI — «ИИ: осталось N мин»; a child — nothing", async () => {
    const f = fakeBff({});
    const { rerender } = render(
      <I18nProvider initial="ru">
        <Shell kid={false} bff={f.bff}>
          <AiPlanPlaque locked="no_subscription" minutesLeft={null} kid={false} />
        </Shell>
      </I18nProvider>,
    );
    expect(screen.getByTestId("pl-ai-locked")).toHaveTextContent("Уроки с ИИ — в подписке. Сейчас урок идёт с готовыми вариантами ответа.");
    await userEvent.click(screen.getByTestId("pl-ai-locked-more"));
    expect(screen.getByTestId("pushed")).toHaveTextContent('"name":"subscription"');
    const again = (locked: Parameters<typeof AiPlanPlaque>[0]["locked"], minutesLeft: number | null, kid = false) =>
      rerender(
        <I18nProvider initial="ru">
          <Shell kid={kid} bff={f.bff}>
            <AiPlanPlaque locked={locked} minutesLeft={minutesLeft} kid={kid} />
          </Shell>
        </I18nProvider>,
      );
    again("billing_unavailable", null);
    expect(screen.getByTestId("pl-ai-locked")).toHaveTextContent("Сейчас урок идёт с готовыми вариантами ответа.");
    expect(screen.queryByTestId("pl-ai-locked-more")).toBeNull();
    again("minutes_exhausted", null);
    expect(screen.getByTestId("pl-ai-locked")).toHaveTextContent("ИИ-минуты этого периода закончились");
    again(null, 42);
    expect(screen.getByTestId("pl-ai-left")).toHaveTextContent("ИИ: осталось 42 мин");
    again("no_subscription", 42, true);
    expect(screen.queryByTestId("pl-ai-locked")).toBeNull();
    expect(screen.queryByTestId("pl-ai-left")).toBeNull();
  });

  it("«Уроки вдвоём — в подписке»: accepting is free; «О подписке»; BILLING_UNAVAILABLE of the invitation — a clear text", async () => {
    const f = fakeBff({});
    render(
      <I18nProvider initial="ru">
        <Shell kid={false} bff={f.bff}>
          <PairSubscriptionSheet reason="no_subscription" onClose={() => undefined} />
        </Shell>
      </I18nProvider>,
    );
    expect(screen.getByTestId("pair-sub-sheet")).toHaveTextContent("Принять приглашение друга можно и без неё.");
    await userEvent.click(screen.getByTestId("pair-sub-more"));
    expect(screen.getByTestId("pushed")).toHaveTextContent('"name":"subscription"');
    const ru = makeI18n("ru");
    const fmt = { dateTime: ru.fmt.dateTime, mmss: ru.fmt.mmss };
    expect(socialErrorText(new ApiError(503, "BILLING_UNAVAILABLE", "x", { service: "billing" }), ru.t, fmt)).toMatch(/учёба работает как обычно/);
    expect(socialErrorText(new ApiError(503, "BILLING_UNAVAILABLE", "x"), ru.t, fmt)).not.toMatch(FORBIDDEN);
    expect(socialErrorText(new ApiError(403, "SUBSCRIPTION_REQUIRED", "x", { reason: "minutes_exhausted" }), ru.t, fmt)).toMatch(/минуты этого периода закончились/);
  });
});
