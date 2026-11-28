/**
 * Sprint 8 data of the mock admin-bff («Деньги», admin.ts «Деньги»): two catalogue versions (v1 archived — the site
 * prices of INTERNAL_API §1.10 without Stars prices; v2 active — with Stars prices), orders of both channels (the site
 * in sums via Payme / Click / Uzum, the Mini App in Telegram Stars, a Stars renewal), refunds, billing accounts of
 * learners (Мадина — a paid period, Ботир — a trial shared with his children, Аня — a Stars subscription), the minutes
 * ledger, an adjustment request of another staff member, reconciliation items, rates and providers (no keys — only
 * «настроено / не настроено»). Every amount is an integer: tiyin (1 sum = 100), Stars, micro-dollars.
 */
import type {
  AdminBillingAccount,
  AdminBillingPeriod,
  AdminLedgerEntry,
  AdminOrderCard,
  AdminProviderTxn,
  AdminRefund,
  Adjustment,
  BillingProviderStatus,
  CatalogPayload,
  CatalogProduct,
  FxRate,
  ReconItem,
  StaffRef,
  StarRate,
} from "@tilhero/contracts/admin";
import { DAY, HOUR, ID, iso, LEARNER, MIN } from "./data";

const id = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const ORDER = {
  /** № 1041 — Мадина, сайт, Payme, подписка, выполнен (возврат — в кабинете Payme) */
  payme: id("f8000000", 1041),
  /** № 1042 — Аня, Mini App, Stars, подписка Telegram (возврат — сразу через Telegram) */
  stars: id("f8000000", 1042),
  /** № 1043 — Мадина, сайт, Click, пакет 100 тилов, проведён сегодня; тилы уже потрачены */
  clickTils: id("f8000000", 1043),
  /** № 1044 — Ботир, сайт, Uzum, ожидает оплаты */
  uzumPending: id("f8000000", 1044),
  /** № 1040 — Мадина, сайт, Payme, возвращён по инициативе провайдера */
  refunded: id("f8000000", 1040),
  /** № 1039 — Аня, продление подписки Stars */
  renewal: id("f8000000", 1039),
  /** № 1038 — Ботир, сайт, Uzum, оплачен; возврат ждёт отмены в кабинете Uzum четвёртые сутки */
  uzumAwaiting: id("f8000000", 1038),
};
export const TXN = {
  payme: id("f8010000", 1041),
  stars: id("f8010000", 1042),
  clickTils: id("f8010000", 1043),
  uzumPending: id("f8010000", 1044),
  refunded: id("f8010000", 1040),
  renewal: id("f8010000", 1039),
  uzumAwaiting: id("f8010000", 1038),
};
export const REFUND = { providerInitiated: id("f8200000", 1), awaiting: id("f8200000", 2) };
export const PERIOD = { madina: id("f8300000", 1), madinaOld: id("f8300000", 2), botirTrial: id("f8300000", 3), anya: id("f8300000", 4) };
export const ADJ = { byNodira: id("f8100000", 1) };
export const RECON = { stuck: id("f8400000", 1), fiscal: id("f8400000", 2), done: id("f8400000", 3) };
export const STARS_SUB = id("f8500000", 1);

export const NODIRA: StaffRef = { staff_id: ID.admin2, name: "Нодира" };
export const IGOR: StaffRef = { staff_id: ID.admin, name: "Игорь Ш." };
export const SYSTEM: StaffRef = { staff_id: "00000000-0000-4000-8000-000000000000", name: "Система" };

/* ---------------------------------------------------------------- catalogue */

const plus30 = (stars: number | null): CatalogProduct => ({
  code: "plus_30d",
  kind: "subscription",
  status: "on_sale",
  sort: 10,
  title: { ru: "TilHero Плюс — 30 дней", uz: "TilHero Plus — 30 kun" },
  description: { ru: "300 минут уроков с ИИ и уроки вдвоём", uz: "AI bilan 300 daqiqa darslar va juftlikdagi darslar" },
  days: 30,
  minutes: 300,
  features: ["ai_lessons", "pair_lessons"],
  audiences: ["teens", "adults"],
  price_tiyin: 4_900_000,
  providers: ["payme", "click", "uzum"],
  price_stars: stars,
  stars_mode: "subscription",
  stars_title: { ru: "TilHero Плюс", uz: "TilHero Plus" },
  fiscal: { ikpu: "10305008002000000", package_code: "1500391", units: 1, vat_percent: 12, receipt_title: "TilHero Plus 30" },
});
const plus90: CatalogProduct = {
  code: "plus_90d",
  kind: "subscription",
  status: "on_sale",
  sort: 20,
  title: { ru: "TilHero Плюс — 90 дней", uz: "TilHero Plus — 90 kun" },
  days: 90,
  minutes: 900,
  features: ["ai_lessons", "pair_lessons"],
  audiences: ["teens", "adults"],
  price_tiyin: 12_900_000,
  providers: ["payme", "click", "uzum"],
  price_stars: null,
  stars_mode: "one_time",
  stars_title: null,
  fiscal: { ikpu: "10305008002000000", package_code: "1500391", units: 1, vat_percent: 12, receipt_title: "TilHero Plus 90" },
};
const til100 = (stars: number | null): CatalogProduct => ({
  code: "til_100",
  kind: "til_pack",
  status: "on_sale",
  sort: 50,
  title: { ru: "100 тилов", uz: "100 til" },
  til: 100,
  audiences: ["kids", "teens", "adults"],
  price_tiyin: 500_000,
  providers: ["payme", "click"],
  price_stars: stars,
  stars_mode: "one_time",
  stars_title: { ru: "100 тилов", uz: "100 til" },
  fiscal: { ikpu: "10305008002000000", package_code: "1500392", units: 1, vat_percent: 12, receipt_title: "TilHero 100 til" },
});
const base = (): Omit<CatalogPayload, "products"> => ({
  merchant: { tin: "123456789" },
  offer: { version: "1.0", url: "https://app.tilhero.uz/legal/offer" },
  trial: { enabled: true, days: 7, minutes: 60, features: ["ai_lessons", "pair_lessons"] },
  limits: { min_start_minutes: 1, pair_min_minutes: 10, low_minutes_percent: 10, expiring_days: 3, order_ttl_minutes: 1440, stars_order_ttl_minutes: 60, pending_orders_max: 5, hold_ttl_hours: 80 },
});
/** v1 (migration 0001): site prices of В2 and В5, Stars prices empty (О1) */
export const catalogV1 = (): CatalogPayload => ({ ...base(), products: [plus30(null), plus90, til100(null)] });
/** v2 (finance set the Stars prices): plus_30d — 250 ⭐ by a Telegram subscription, til_100 — 50 ⭐ */
export const catalogV2 = (): CatalogPayload => ({ ...base(), products: [plus30(250), plus90, til100(50)] });

/* ---------------------------------------------------------------- orders */

function txn(t: string, seq: number, provider: AdminProviderTxn["provider"], ptid: string, state: AdminProviderTxn["state"], amount: { tiyin?: number; stars?: number }, at: number, extra: Partial<AdminProviderTxn> = {}): AdminProviderTxn {
  return {
    txn_id: t,
    seq,
    provider,
    provider_txn_id: ptid,
    state,
    cancel_reason: null,
    provider_reason: null,
    amount_tiyin: amount.tiyin ?? null,
    amount_stars: amount.stars ?? null,
    provider_time: iso(at),
    created_at: iso(at - 40_000),
    performed_at: state === "created" ? null : iso(at),
    cancelled_at: null,
    ...extra,
  };
}

const card = (x: Partial<AdminOrderCard> & Pick<AdminOrderCard, "order_id" | "order_no" | "status" | "channel" | "provider" | "product_code" | "product_kind" | "product_title" | "currency">): AdminOrderCard => ({
  amount_tiyin: null,
  amount_stars: null,
  account_id: LEARNER.madina,
  beneficiary_id: LEARNER.madina,
  created_at: iso(-DAY),
  expires_at: iso(0),
  paid_at: null,
  fulfilled_at: null,
  closed_at: null,
  offer_version: "1.0",
  locale: "ru",
  start_mode: null,
  stars_mode: null,
  product_snapshot: {},
  transactions: [],
  receipts: [],
  refunds: [],
  stars_subscription: null,
  provider_calls: [],
  can_refund: false,
  ...x,
});

const PLUS = { ru: "TilHero Плюс — 30 дней", uz: "TilHero Plus — 30 kun" };
const TIL = { ru: "100 тилов", uz: "100 til" };

export function orders(): AdminOrderCard[] {
  const t1 = -3 * DAY;
  const t2 = -9 * DAY;
  const t3 = -40 * MIN;
  return [
    card({
      order_id: ORDER.payme, order_no: 1041, status: "fulfilled", channel: "web", provider: "payme", product_code: "plus_30d", product_kind: "subscription", product_title: PLUS, currency: "UZS",
      amount_tiyin: 4_900_000, created_at: iso(t1 - 5 * MIN), expires_at: iso(t1 + DAY), paid_at: iso(t1), fulfilled_at: iso(t1 + 2_000), start_mode: "after_current",
      product_snapshot: { code: "plus_30d", days: 30, minutes: 300, price_tiyin: 4_900_000 },
      transactions: [txn(TXN.payme, 1, "payme", "6385a1b2c3d4e5f6a7b8c9d0", "performed", { tiyin: 4_900_000 }, t1)],
      receipts: [{ receipt_id: id("f8600000", 1), txn_id: TXN.payme, kind: "sale", source: "payme_set_fiscal_data", status: "registered", fiscal_receipt_id: "AB123456789", terminal_id: "EP000000000123", fiscal_sign: "123456789012", qr_code_url: "https://ofd.soliq.uz/check?t=EP000000000123&r=123", status_code: 0, message: null, attempts: 1, registered_at: iso(t1 + MIN), created_at: iso(t1 + 30_000) }],
      provider_calls: [
        { call_id: 9001, provider: "payme", direction: "in", method: "CheckPerformTransaction", result_code: "ok", latency_ms: 41, created_at: iso(t1 - 60_000) },
        { call_id: 9002, provider: "payme", direction: "in", method: "CreateTransaction", result_code: "ok", latency_ms: 38, created_at: iso(t1 - 40_000) },
        { call_id: 9003, provider: "payme", direction: "in", method: "PerformTransaction", result_code: "ok", latency_ms: 77, created_at: iso(t1) },
      ],
      can_refund: true,
    }),
    card({
      order_id: ORDER.stars, order_no: 1042, status: "fulfilled", channel: "miniapp", provider: "telegram_stars", product_code: "plus_30d", product_kind: "subscription", product_title: PLUS, currency: "XTR",
      amount_stars: 250, account_id: LEARNER.anya, beneficiary_id: LEARNER.anya, created_at: iso(t2 - 2 * MIN), expires_at: iso(t2 + HOUR), paid_at: iso(t2), fulfilled_at: iso(t2 + 1_000), stars_mode: "subscription", start_mode: "now",
      product_snapshot: { code: "plus_30d", days: 30, minutes: 300, price_stars: 250 },
      transactions: [txn(TXN.stars, 1, "telegram_stars", "stxn_9f8e7d6c5b4a", "performed", { stars: 250 }, t2)],
      stars_subscription: { subscription_id: STARS_SUB, product_code: "plus_30d", status: "active", amount_stars: 250, expires_at: iso(t2 + 30 * DAY), renewals: 0, first_order_no: 1042, created_at: iso(t2), updated_at: iso(t2) },
      provider_calls: [
        { call_id: 9101, provider: "telegram", direction: "out", method: "createInvoiceLink", result_code: "ok", latency_ms: 212, created_at: iso(t2 - 2 * MIN) },
        { call_id: 9102, provider: "telegram", direction: "in", method: "pre_checkout_query", result_code: "ok", latency_ms: 64, created_at: iso(t2 - 5_000) },
        { call_id: 9103, provider: "telegram", direction: "in", method: "successful_payment", result_code: "ok", latency_ms: 58, created_at: iso(t2) },
      ],
      can_refund: true,
    }),
    card({
      order_id: ORDER.clickTils, order_no: 1043, status: "fulfilled", channel: "web", provider: "click", product_code: "til_100", product_kind: "til_pack", product_title: TIL, currency: "UZS",
      amount_tiyin: 500_000, created_at: iso(t3 - 3 * MIN), expires_at: iso(t3 + DAY), paid_at: iso(t3), fulfilled_at: iso(t3 + 1_000),
      product_snapshot: { code: "til_100", til: 100, price_tiyin: 500_000 },
      transactions: [txn(TXN.clickTils, 1, "click", "click_2299001144", "performed", { tiyin: 500_000 }, t3)],
      receipts: [{ receipt_id: id("f8600000", 2), txn_id: TXN.clickTils, kind: "sale", source: "click_ofd", status: "pending", fiscal_receipt_id: null, terminal_id: null, fiscal_sign: null, qr_code_url: null, status_code: null, message: null, attempts: 2, registered_at: null, created_at: iso(t3 + 30_000) }],
      can_refund: true,
    }),
    card({
      order_id: ORDER.uzumPending, order_no: 1044, status: "pending", channel: "web", provider: "uzum", product_code: "plus_30d", product_kind: "subscription", product_title: PLUS, currency: "UZS",
      amount_tiyin: 4_900_000, account_id: LEARNER.botir, beneficiary_id: LEARNER.botir, created_at: iso(-20 * MIN), expires_at: iso(23 * HOUR), start_mode: "now",
      transactions: [txn(TXN.uzumPending, 1, "uzum", "uz-7731-0044", "created", { tiyin: 4_900_000 }, -19 * MIN)],
    }),
    card({
      order_id: ORDER.refunded, order_no: 1040, status: "refunded", channel: "web", provider: "payme", product_code: "plus_30d", product_kind: "subscription", product_title: PLUS, currency: "UZS",
      amount_tiyin: 4_900_000, created_at: iso(-32 * DAY), expires_at: iso(-31 * DAY), paid_at: iso(-32 * DAY), fulfilled_at: iso(-32 * DAY), closed_at: iso(-30 * DAY),
      transactions: [txn(TXN.refunded, 1, "payme", "6371ffee0011223344556677", "refunded", { tiyin: 4_900_000 }, -32 * DAY, { cancel_reason: "provider_cancel", provider_reason: 5, cancelled_at: iso(-30 * DAY) })],
    }),
    card({
      order_id: ORDER.renewal, order_no: 1039, status: "fulfilled", channel: "renewal", provider: "telegram_stars", product_code: "plus_30d", product_kind: "subscription", product_title: PLUS, currency: "XTR",
      amount_stars: 250, account_id: LEARNER.anya, beneficiary_id: LEARNER.anya, created_at: iso(-39 * DAY), expires_at: iso(-39 * DAY), paid_at: iso(-39 * DAY), fulfilled_at: iso(-39 * DAY), stars_mode: "subscription",
      transactions: [txn(TXN.renewal, 1, "telegram_stars", "stxn_11aa22bb33cc", "performed", { stars: 250 }, -39 * DAY)],
      can_refund: true,
    }),
    card({
      order_id: ORDER.uzumAwaiting, order_no: 1038, status: "paid", channel: "web", provider: "uzum", product_code: "plus_30d", product_kind: "subscription", product_title: PLUS, currency: "UZS",
      amount_tiyin: 4_900_000, account_id: LEARNER.botir, beneficiary_id: LEARNER.botir, created_at: iso(-6 * DAY), expires_at: iso(-5 * DAY), paid_at: iso(-6 * DAY), start_mode: "now",
      transactions: [txn(TXN.uzumAwaiting, 1, "uzum", "uz-7731-0038", "performed", { tiyin: 4_900_000 }, -6 * DAY)],
    }),
  ];
}

export function refunds(): AdminRefund[] {
  return [
    {
      refund_id: REFUND.awaiting, order_id: ORDER.uzumAwaiting, order_no: 1038, txn_id: TXN.uzumAwaiting, provider: "uzum", amount_tiyin: 4_900_000, amount_stars: null, status: "awaiting_provider",
      initiated_by: "staff", method: "provider_cabinet", reason: "Двойная оплата, обращение TCK-1031", requested_by: IGOR, requested_at: iso(-4 * DAY), completed_at: null, failure_code: null, tils_check: null,
      instruction: { provider: "uzum", provider_txn_id: "uz-7731-0038", amount_tiyin: 4_900_000 },
    },
    {
      refund_id: REFUND.providerInitiated, order_id: ORDER.refunded, order_no: 1040, txn_id: TXN.refunded, provider: "payme", amount_tiyin: 4_900_000, amount_stars: null, status: "completed",
      initiated_by: "provider", method: "provider_cabinet", reason: null, requested_by: null, requested_at: iso(-30 * DAY), completed_at: iso(-30 * DAY), failure_code: null, tils_check: null, instruction: null,
    },
  ];
}

/* ---------------------------------------------------------------- accounts, periods, ledger */

export function period(x: Partial<AdminBillingPeriod> & Pick<AdminBillingPeriod, "period_id">): AdminBillingPeriod {
  return {
    product_code: "plus_30d",
    source: "order",
    status: "active",
    features: ["ai_lessons", "pair_lessons"],
    minutes_granted: 300,
    days: 30,
    starts_at: iso(-3 * DAY),
    ends_at: iso(27 * DAY),
    created_at: iso(-3 * DAY),
    closed_at: null,
    close_reason: null,
    order_no: 1041,
    balance: { granted: 300, spent: 0, removed: 0, held: 0, overage: 0, minutes_left: 300 },
    ...x,
  };
}

export function accounts(): Record<string, AdminBillingAccount> {
  const madina = period({ period_id: PERIOD.madina, balance: { granted: 300, spent: 118, removed: 0, held: 12, overage: 0, minutes_left: 170 } });
  const madinaOld = period({ period_id: PERIOD.madinaOld, status: "revoked", starts_at: iso(-32 * DAY), ends_at: iso(-2 * DAY), created_at: iso(-32 * DAY), closed_at: iso(-30 * DAY), close_reason: "refund", order_no: 1040, balance: { granted: 300, spent: 41, removed: 259, held: 0, overage: 0, minutes_left: 0 } });
  const trial = period({ period_id: PERIOD.botirTrial, product_code: "trial", source: "trial", days: 7, minutes_granted: 60, starts_at: iso(-5 * DAY), ends_at: iso(2 * DAY), created_at: iso(-5 * DAY), order_no: null, balance: { granted: 60, spent: 54, removed: 0, held: 0, overage: 2, minutes_left: 6 } });
  const anya = period({ period_id: PERIOD.anya, starts_at: iso(-9 * DAY), ends_at: iso(21 * DAY), created_at: iso(-9 * DAY), order_no: 1042, balance: { granted: 300, spent: 64, removed: 0, held: 0, overage: 0, minutes_left: 236 } });
  return {
    [LEARNER.madina]: {
      account_id: LEARNER.madina, status: "active", tier: "paid", features: ["ai_lessons", "pair_lessons"], expiring: false, minutes_exhausted: false, trial_used: true, current_period: madina,
      periods: [madina, madinaOld],
      holds: [{ hold_id: id("f8700000", 1), feature: "ai_lessons", ref_kind: "session", ref_id: id("f8710000", 1), learner_id: LEARNER.madina, minutes: 12, status: "active", settled_minutes: null, overage: null, created_at: iso(-6 * MIN), expires_at: iso(80 * HOUR), settled_at: null }],
      stars_subscription: null, pending_adjustments: 1,
    },
    [LEARNER.botir]: {
      account_id: LEARNER.botir, status: "trial", tier: "paid", features: ["ai_lessons", "pair_lessons"], expiring: true, minutes_exhausted: false, trial_used: true, current_period: trial,
      periods: [trial], holds: [], stars_subscription: null, pending_adjustments: 0,
    },
    [LEARNER.anya]: {
      account_id: LEARNER.anya, status: "active", tier: "paid", features: ["ai_lessons", "pair_lessons"], expiring: false, minutes_exhausted: false, trial_used: false, current_period: anya,
      periods: [anya], holds: [], pending_adjustments: 0,
      stars_subscription: { subscription_id: STARS_SUB, product_code: "plus_30d", status: "active", amount_stars: 250, expires_at: iso(21 * DAY), renewals: 0, first_order_no: 1042, created_at: iso(-9 * DAY), updated_at: iso(-9 * DAY) },
    },
  };
}

export function ledger(): Record<string, AdminLedgerEntry[]> {
  const e = (n: number, p: string, kind: AdminLedgerEntry["kind"], minutes: number, at: number, extra: Partial<AdminLedgerEntry> = {}): AdminLedgerEntry => ({
    entry_id: id("f8800000", n), seq: n, period_id: p, kind, minutes, overage: 0, learner_id: null, ref_kind: "order", ref_id: ORDER.payme, actor: "system", actor_name: null, created_at: iso(at), ...extra,
  });
  return {
    [LEARNER.madina]: [
      e(14, PERIOD.madina, "debit", -38, -2 * HOUR, { learner_id: LEARNER.madina, ref_kind: "session", ref_id: id("f8710000", 2), actor: "learner" }),
      e(13, PERIOD.madina, "debit", -80, -DAY, { learner_id: LEARNER.madina, ref_kind: "session", ref_id: id("f8710000", 3), actor: "learner" }),
      e(12, PERIOD.madina, "grant", 300, -3 * DAY),
      e(11, PERIOD.madinaOld, "revoke", -259, -30 * DAY, { ref_kind: "refund", ref_id: REFUND.providerInitiated }),
    ],
    [LEARNER.botir]: [
      e(22, PERIOD.botirTrial, "debit", -54, -3 * HOUR, { learner_id: LEARNER.lola, ref_kind: "session", ref_id: id("f8710000", 4), actor: "learner", overage: 2 }),
      e(21, PERIOD.botirTrial, "grant", 60, -5 * DAY, { ref_kind: "trial", ref_id: PERIOD.botirTrial }),
    ],
    [LEARNER.anya]: [e(31, PERIOD.anya, "grant", 300, -9 * DAY, { ref_id: ORDER.stars })],
  };
}

export function adjustments(): Adjustment[] {
  return [
    {
      adjustment_id: ADJ.byNodira, account_id: LEARNER.madina, kind: "minutes", minutes: 30, days: null, period_id: PERIOD.madina, reason: "Урок прервался по нашей вине, обращение TCK-1042",
      status: "pending", requested_by: NODIRA, requested_at: iso(-2 * HOUR), decided_by: null, decided_at: null, decision_note: null, before_value: null, after_value: null,
      expires_at: iso(70 * HOUR), can_decide: false, can_cancel: false,
    },
  ];
}

/* ---------------------------------------------------------------- reconciliation, rates, providers */

export function reconItems(): ReconItem[] {
  return [
    {
      item_id: RECON.stuck, run_id: id("f8900000", 1), kind: "refund_stuck", provider: "uzum", order_id: ORDER.uzumAwaiting, order_no: 1038, txn_id: TXN.uzumAwaiting, period_id: null,
      details: { refund_id: REFUND.awaiting, waiting_hours: 96, amount_tiyin: 4_900_000 }, status: "open", created_at: iso(-HOUR), resolved_by: null, resolved_at: null, note: null,
    },
    {
      item_id: RECON.fiscal, run_id: id("f8900000", 1), kind: "fiscal_missing", provider: "click", order_id: ORDER.clickTils, order_no: 1043, txn_id: TXN.clickTils, period_id: null,
      details: { receipt_attempts: 2, last_status_code: -5017 }, status: "open", created_at: iso(-20 * MIN), resolved_by: null, resolved_at: null, note: null,
    },
    {
      item_id: RECON.done, run_id: id("f8900000", 0), kind: "stale_created", provider: "payme", order_id: null, order_no: null, txn_id: null, period_id: null,
      details: { provider_txn_id: "63700000aabb", age_hours: 13 }, status: "resolved", created_at: iso(-8 * DAY), resolved_by: IGOR, resolved_at: iso(-7 * DAY), note: "Таймаут Payme, отменена провайдером",
    },
  ];
}

export const fxRates = (): FxRate[] => [
  { usd_in_tiyin: 1_265_000, valid_from: iso(-20 * DAY).slice(0, 10), set_by: IGOR, reason: "Курс ЦБ на начало месяца", created_at: iso(-20 * DAY) },
  { usd_in_tiyin: 1_258_000, valid_from: iso(-50 * DAY).slice(0, 10), set_by: IGOR, reason: "Курс ЦБ на начало месяца", created_at: iso(-50 * DAY) },
];
export const starRates = (): StarRate[] => [{ star_in_tiyin: 16_500, valid_from: iso(-20 * DAY).slice(0, 10), set_by: IGOR, reason: "Оценка: 0,013 USD за Star по отчёту Fragment", created_at: iso(-20 * DAY) }];

export const providers = (): BillingProviderStatus[] => [
  { provider: "telegram_stars", enabled: true, configured: true, last_callback_at: iso(-40 * MIN), last_error_code: null },
  { provider: "payme", enabled: true, configured: true, last_callback_at: iso(-3 * DAY), last_error_code: null },
  { provider: "click", enabled: true, configured: true, last_callback_at: iso(-40 * MIN), last_error_code: null },
  { provider: "uzum", enabled: false, configured: false, last_callback_at: null, last_error_code: null },
];
