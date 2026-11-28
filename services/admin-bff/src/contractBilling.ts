/**
 * Кодеки ответов billing по admin.ts «Деньги» (спринт 8) — как contractGame.ts / contractSocial.ts: проверка значения
 * домена (испорченное, неизвестное значение перечисления, время без зоны → 503 UPSTREAM_UNAVAILABLE {service: billing},
 * в лог — путь поля без значения) и схема ответа admin-bff (лишние поля отбрасываются). `C.obj<T>()` требует ровно
 * ключи типа admin.ts — поле, добавленное в контракт или удалённое из него, ломает `tsc`; списки перечислений входа
 * (schemas.ts) сверяются с типами admin.ts / bff.ts / web.ts тоже при компиляции.
 *
 * Деньги (ADR-0001) — только целые: тийины (1 сум = 100 тийинов) и Stars. В заказе, транзакции и возврате заполнено
 * ровно одно из amount_tiyin / amount_stars и оно совпадает с валютой (UZS ↔ тийины, XTR ↔ Stars); канал совпадает с
 * провайдером (miniapp и renewal — только telegram_stars, web — payme | click | uzum). Нарушение — испорченный ответ
 * (503): админка не показывает «смешанные» деньги.
 *
 * Особенности:
 *  - `StaffRef` — `{staff_id, name}`: имя приходит от billing (actor.name при команде); пустое имя дописывает admin-bff
 *    (admin-identity staff/lookup, `withBillingNames`), «system» — «Система»;
 *  - `payload` версии каталога: у `active` и `archived` — строго `CatalogPayload` (прошли валидатор); у черновика — JSON
 *    как есть (≤ 256 КБ): черновик ещё не проверен, ошибки показывает `validate` (422 CATALOG_INVALID с путями полей);
 *  - подсказки UI `Adjustment.can_decide` / `can_cancel` и `AdminOrderCard.can_refund` вычисляет admin-bff (по правам
 *    сессии и состоянию), значение домена не берётся — «автор не видит «Подтвердить»» не зависит от домена;
 *  - `AdminLedgerEntry.actor_name` — как отдал billing («Система», имя решившего заявку); пустое для `staff:<id>` —
 *    lookup admin-bff;
 *  - ключи провайдеров админка не показывает никогда: `BillingProviderStatus` — только «включён / задан ключ».
 */
import type {
  AdminBillingAccount,
  AdminBillingPeriod,
  AdminFiscalReceipt,
  AdminLedgerEntry,
  AdminMinuteHold,
  AdminOrderCard,
  AdminOrderRow,
  AdminProviderCall,
  AdminProviderTxn,
  AdminRefund,
  AdminStarsSubscription,
  Adjustment,
  AdjustmentKind,
  AdjustmentStatus,
  BillingAudience,
  BillingChannel,
  BillingCurrency,
  BillingDailyRow,
  BillingMinutesTotals,
  BillingPeriodStatus,
  BillingProvider,
  BillingProviderStatus,
  BillingSummary,
  CatalogPayload,
  CatalogProduct,
  CatalogProductFiscal,
  CatalogStatus,
  CatalogValidation,
  CatalogVersion,
  CatalogVersionSummary,
  FxRate,
  FxRateRef,
  LearnerTier,
  Localized,
  ProviderTxnState,
  ReconItem,
  ReconItemKind,
  ReconRun,
  RefundStatus,
  StarRate,
  StarRateRef,
  TrialsGrantAllResult,
} from "@tilhero/contracts/admin";
import type {
  BillingFeature,
  BillingOrderStatus,
  BillingProductKind,
  MinuteEntryKind,
  MinuteRefKind,
  StarsMode,
  StarsSubscriptionStatus,
  SubscriptionStatus,
} from "@tilhero/contracts/bff";
import type { WebProvider } from "@tilhero/contracts/web";
import { C, UUID_RE, bad, itemsOf, pageOf, safeHttps, type Codec, type Schema } from "./codec.js";
import { STAFF_REF } from "./contractGame.js";
import {
  ADJUSTMENT_KINDS,
  ADJUSTMENT_STATUSES,
  BILLING_AUDIENCES,
  BILLING_CHANNELS,
  BILLING_CURRENCIES,
  BILLING_FEATURES,
  BILLING_PROVIDERS,
  CATALOG_STATUSES,
  LEARNER_TIERS,
  MINUTE_ENTRY_KINDS,
  MINUTE_REF_KINDS,
  ORDER_STATUSES,
  PERIOD_STATUSES,
  PRODUCT_KINDS,
  RECON_ITEM_KINDS,
  REFUND_STATUSES,
  STARS_MODES,
  STARS_SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUSES,
  TXN_STATES,
  WEB_PROVIDERS,
} from "./schemas.js";

// ---------------------------------------------------------------- перечисления: вход (schemas.ts) = admin.ts / bff.ts / web.ts

type Exact<T, L extends readonly unknown[]> = [Exclude<T, L[number]>] extends [never] ? true : Exclude<T, L[number]>;
const PROVIDERS = BILLING_PROVIDERS satisfies readonly BillingProvider[];
const WEB = WEB_PROVIDERS satisfies readonly WebProvider[];
const CHANNELS = BILLING_CHANNELS satisfies readonly BillingChannel[];
const CURRENCIES = BILLING_CURRENCIES satisfies readonly BillingCurrency[];
const AUDIENCES = BILLING_AUDIENCES satisfies readonly BillingAudience[];
const FEATURES = BILLING_FEATURES satisfies readonly BillingFeature[];
const KINDS = PRODUCT_KINDS satisfies readonly BillingProductKind[];
const MODES = STARS_MODES satisfies readonly StarsMode[];
const ORDER_ST = ORDER_STATUSES satisfies readonly BillingOrderStatus[];
const STARS_SUB_ST = STARS_SUBSCRIPTION_STATUSES satisfies readonly StarsSubscriptionStatus[];
const SUB_ST = SUBSCRIPTION_STATUSES satisfies readonly SubscriptionStatus[];
const ENTRY_KINDS = MINUTE_ENTRY_KINDS satisfies readonly MinuteEntryKind[];
const REF_KINDS = MINUTE_REF_KINDS satisfies readonly MinuteRefKind[];
const CATALOG_ST = CATALOG_STATUSES satisfies readonly CatalogStatus[];
const TXN_ST = TXN_STATES satisfies readonly ProviderTxnState[];
const REFUND_ST = REFUND_STATUSES satisfies readonly RefundStatus[];
const PERIOD_ST = PERIOD_STATUSES satisfies readonly BillingPeriodStatus[];
const ADJ_KINDS = ADJUSTMENT_KINDS satisfies readonly AdjustmentKind[];
const ADJ_ST = ADJUSTMENT_STATUSES satisfies readonly AdjustmentStatus[];
const RECON_KINDS = RECON_ITEM_KINDS satisfies readonly ReconItemKind[];
const TIERS = LEARNER_TIERS satisfies readonly LearnerTier[];
const _exact: [
  Exact<BillingProvider, typeof PROVIDERS>,
  Exact<WebProvider, typeof WEB>,
  Exact<BillingChannel, typeof CHANNELS>,
  Exact<BillingCurrency, typeof CURRENCIES>,
  Exact<BillingAudience, typeof AUDIENCES>,
  Exact<BillingFeature, typeof FEATURES>,
  Exact<BillingProductKind, typeof KINDS>,
  Exact<StarsMode, typeof MODES>,
  Exact<BillingOrderStatus, typeof ORDER_ST>,
  Exact<StarsSubscriptionStatus, typeof STARS_SUB_ST>,
  Exact<SubscriptionStatus, typeof SUB_ST>,
  Exact<MinuteEntryKind, typeof ENTRY_KINDS>,
  Exact<MinuteRefKind, typeof REF_KINDS>,
  Exact<CatalogStatus, typeof CATALOG_ST>,
  Exact<ProviderTxnState, typeof TXN_ST>,
  Exact<RefundStatus, typeof REFUND_ST>,
  Exact<BillingPeriodStatus, typeof PERIOD_ST>,
  Exact<AdjustmentKind, typeof ADJ_KINDS>,
  Exact<AdjustmentStatus, typeof ADJ_ST>,
  Exact<ReconItemKind, typeof RECON_KINDS>,
  Exact<LearnerTier, typeof TIERS>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
void _exact;

// ---------------------------------------------------------------- общие

const COUNT = C.int(0);
const N_TIME = C.nullable(C.time);
/** Сумма в тийинах одной операции (заказ, транзакция, возврат): целое 0..10¹¹ (ADR-0001). */
export const TIYIN = C.int(0, 100_000_000_000);
/** Цена в Stars: целое 0..100 000 (валидатор каталога: 1..100 000). */
export const STARS = C.int(0, 100_000);
/** Итоги отчётов: целые ≥ 0 без верхней границы суммы (сумма многих заказов). */
const TOTAL = C.int(0);
/** Нетто (выручка − возвраты) может быть отрицательным в периоде. */
const SIGNED = C.int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
/** Номер заказа — целое ≥ 1. */
const ORDER_NO = C.int(1);
const LOCALIZED = C.obj<Localized>({ ru: C.str(1000), uz: C.str(1000) });
const PRODUCT_CODE = C.id(/^[a-z0-9_]{2,40}$/, 40);
/** Идентификатор транзакции провайдера (Payme id, Click click_trans_id, Stars telegram_payment_charge_id) — как есть,
 *  без пробелов и управляющих символов. */
const PROVIDER_TXN_ID = C.id(/^[A-Za-z0-9._:\-]{1,255}$/, 255);
/** Короткий код (причина отмены, код отказа): буквы, цифры, «_ . : -»; коды Payme и Click отрицательные («-31050»),
 *  Uzum — «FAILED:-…». */
const SHORT_CODE = C.id(/^[A-Za-z0-9+-][A-Za-z0-9_.:+-]{0,63}$/, 64);
/** Статус пред-проверки тилов (gamification by-order) — как пришёл, может быть пустым. */
const TILS_STATUS = C.id(/^[A-Za-z0-9_.:-]{0,64}$/, 64);
const ISSUE = C.obj<CatalogValidation["errors"][number]>({ path: C.str(300), code: C.id(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, 64) });
const FEATURE_LIST = C.arr(C.oneOf(FEATURES), 2);
/** JSON-объект как есть (схема — любой объект: сериализатор не урезает и не приводит значения). */
const JSON_OBJECT_SCHEMA: Schema = { type: "object", additionalProperties: true };
/** Ссылка https обязательна (оферта): не https — испорченный ответ. */
const HTTPS_REQUIRED = C.custom<string>({ type: "string" }, (v, p) => safeHttps(v) ?? bad(p));

/** Любое JSON-значение ≤ maxBytes (было / стало в diff версии каталога); нет поля → null. */
const jsonValue = (maxBytes: number): Codec<unknown> =>
  C.custom<unknown>({}, (v, p) => {
    if (v === undefined || v === null) return null;
    if (!["string", "number", "boolean", "object"].includes(typeof v)) return bad(p);
    const s = JSON.stringify(v);
    return s !== undefined && s.length <= maxBytes ? v : bad(p);
  });

/** Канал и провайдер не смешиваются: Mini App и продление — только Stars, сайт — только Payme, Click, Uzum. */
export function channelAllows(channel: BillingChannel, provider: BillingProvider): boolean {
  return channel === "web" ? provider !== "telegram_stars" : provider === "telegram_stars";
}

/**
 * Ровно одна сумма и она — в валюте объекта (UZS ↔ amount_tiyin, XTR ↔ amount_stars; у транзакции и возврата валюту
 * задаёт провайдер). Иначе — испорченный ответ.
 */
function oneAmount<T extends { amount_tiyin: number | null; amount_stars: number | null }>(c: Codec<T>, stars: (v: T) => boolean): Codec<T> {
  return C.map(c, c.schema, (v, p) => {
    const tiyin = v.amount_tiyin !== null;
    if (tiyin === (v.amount_stars !== null)) return bad(`${p}.amount_tiyin`);
    if (tiyin === stars(v)) return bad(`${p}.amount_stars`);
    return v;
  });
}

// ---------------------------------------------------------------- каталог

const FISCAL = C.obj<CatalogProductFiscal>({
  // в dev/test реквизиты — предупреждение валидатора: формат не навязывается, только тип и длина
  ikpu: C.nullable(C.str(32)),
  package_code: C.nullable(C.str(32)),
  units: C.nullable(C.int(0, 10_000_000)),
  vat_percent: C.nullable(C.num(0, 100)),
  receipt_title: C.nullable(C.str(128)),
});

const PRODUCT = C.obj<CatalogProduct>(
  {
    code: PRODUCT_CODE,
    kind: C.oneOf(KINDS),
    status: C.oneOf(["on_sale", "hidden"] as const),
    sort: C.int(-1_000_000, 1_000_000),
    title: LOCALIZED,
    description: LOCALIZED,
    days: C.int(0, 10_000),
    minutes: C.int(0, 1_000_000),
    features: FEATURE_LIST,
    til: C.int(0, 1_000_000),
    audiences: C.arr(C.oneOf(AUDIENCES), 3),
    price_tiyin: C.nullable(TIYIN),
    providers: C.arr(C.oneOf(WEB), 3),
    price_stars: C.nullable(STARS),
    stars_mode: C.oneOf(MODES),
    stars_title: C.nullable(LOCALIZED),
    fiscal: C.nullable(FISCAL),
  },
  "description",
  "days",
  "minutes",
  "features",
  "til",
);

/** Payload версии каталога (INTERNAL_API §1.2) строго: ровно ключи admin.ts, целые суммы. */
export const CATALOG_PAYLOAD: Codec<CatalogPayload> = C.obj<CatalogPayload>({
  merchant: C.obj<CatalogPayload["merchant"]>({ tin: C.nullable(C.str(32)) }),
  offer: C.obj<CatalogPayload["offer"]>({ version: C.str(32, 1), url: HTTPS_REQUIRED }),
  trial: C.obj<CatalogPayload["trial"]>({ enabled: C.bool, days: C.int(0, 366), minutes: C.int(0, 100_000), features: FEATURE_LIST }),
  limits: C.obj<CatalogPayload["limits"]>({
    min_start_minutes: COUNT,
    pair_min_minutes: COUNT,
    low_minutes_percent: C.int(0, 100),
    expiring_days: COUNT,
    order_ttl_minutes: COUNT,
    stars_order_ttl_minutes: COUNT,
    pending_orders_max: COUNT,
    hold_ttl_hours: COUNT,
  }),
  products: C.arr(PRODUCT, 200),
});

const SUMMARY_PROPS = {
  version: C.int(1),
  status: C.oneOf(CATALOG_ST),
  comment: C.optText(500),
  created_by: STAFF_REF,
  created_at: C.time,
  validated: C.bool,
  activated_by: C.nullable(STAFF_REF),
  activated_at: N_TIME,
};
export const CATALOG_SUMMARY: Codec<CatalogVersionSummary> = C.obj<CatalogVersionSummary>(SUMMARY_PROPS);
/** Список версий без payload, новые первыми (как отдал домен). */
export const CATALOG_LIST = itemsOf(CATALOG_SUMMARY, 1000);

const DIFF_ITEM = C.obj<CatalogVersion["diff"][number]>({ path: C.str(300, 1), from: jsonValue(16_384), to: jsonValue(16_384) });
const versionCodec = (payload: Codec<CatalogPayload>): Codec<CatalogVersion> =>
  C.obj<CatalogVersion>({ ...SUMMARY_PROPS, payload, diff: C.arr(DIFF_ITEM, 4000), updated_at: C.time });
const STRICT_PAYLOAD = C.custom<CatalogPayload>(JSON_OBJECT_SCHEMA, (v, p) => CATALOG_PAYLOAD.parse(v, p));
// черновик — объект как есть (тип контракта — для формы admin-web; проверяет `validate` billing)
const DRAFT_PAYLOAD = C.custom<CatalogPayload>(JSON_OBJECT_SCHEMA, (v, p) => C.json(262_144).parse(v, p) as unknown as CatalogPayload);
const CATALOG_VERSION_STRICT = versionCodec(STRICT_PAYLOAD);
const CATALOG_VERSION_DRAFT = versionCodec(DRAFT_PAYLOAD);
/** Версия каталога + diff с активной: payload активной и архивной — строго, черновика — как есть. */
export const CATALOG_VERSION: Codec<CatalogVersion> = C.custom<CatalogVersion>(CATALOG_VERSION_STRICT.schema, (v, p) =>
  ((v as { status?: unknown } | null)?.status === "draft" ? CATALOG_VERSION_DRAFT : CATALOG_VERSION_STRICT).parse(v, p),
);

export const CATALOG_VALIDATION: Codec<CatalogValidation> = C.obj<CatalogValidation>({ ok: C.bool, errors: C.arr(ISSUE, 2000), warnings: C.arr(ISSUE, 2000) });

// ---------------------------------------------------------------- заказы и платежи

/** Название товара из снимка заказа; у старого снимка без названия billing отдаёт `{}` — тогда пусто (экран
 *  показывает код товара). */
const SNAPSHOT_TITLE = C.custom<Localized>(LOCALIZED.schema, (v, p) => {
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) return { ru: "", uz: "" };
  return LOCALIZED.parse(v, p);
});

const ROW_PROPS = {
  order_id: C.uuid,
  order_no: ORDER_NO,
  status: C.oneOf(ORDER_ST),
  channel: C.oneOf(CHANNELS),
  provider: C.oneOf(PROVIDERS),
  product_code: PRODUCT_CODE,
  product_kind: C.oneOf(KINDS),
  product_title: SNAPSHOT_TITLE,
  currency: C.oneOf(CURRENCIES),
  amount_tiyin: C.nullable(TIYIN),
  amount_stars: C.nullable(STARS),
  // null — обезличен после удаления аккаунта (В15)
  account_id: C.nullable(C.uuid),
  beneficiary_id: C.nullable(C.uuid),
  created_at: C.time,
  expires_at: C.time,
  paid_at: N_TIME,
  fulfilled_at: N_TIME,
  closed_at: N_TIME,
};

/** Заказ: одна сумма в валюте заказа, канал и провайдер не смешиваются. */
function orderChecks<T extends AdminOrderRow>(c: Codec<T>): Codec<T> {
  const amounts = oneAmount(c, (o) => o.currency === "XTR");
  return C.map(amounts, c.schema, (o, p) => {
    if (!channelAllows(o.channel, o.provider)) return bad(`${p}.provider`);
    if ((o.currency === "XTR") !== (o.provider === "telegram_stars")) return bad(`${p}.currency`);
    return o;
  });
}

export const ORDER_ROW: Codec<AdminOrderRow> = orderChecks(C.obj<AdminOrderRow>(ROW_PROPS));
export const ORDER_PAGE = pageOf(ORDER_ROW, 200);

const TXN: Codec<AdminProviderTxn> = oneAmount(
  C.obj<AdminProviderTxn>({
    txn_id: C.uuid,
    seq: C.int(0),
    provider: C.oneOf(PROVIDERS),
    provider_txn_id: PROVIDER_TXN_ID,
    state: C.oneOf(TXN_ST),
    cancel_reason: C.nullable(SHORT_CODE),
    // Payme reason как пришёл (1, 2, 3, 4, 5, 10)
    provider_reason: C.nullable(C.int(-1000, 1000)),
    amount_tiyin: C.nullable(TIYIN),
    amount_stars: C.nullable(STARS),
    provider_time: N_TIME,
    created_at: C.time,
    performed_at: N_TIME,
    cancelled_at: N_TIME,
  }),
  (t) => t.provider === "telegram_stars",
);

const RECEIPT = C.obj<AdminFiscalReceipt>({
  receipt_id: C.uuid,
  txn_id: C.uuid,
  kind: C.oneOf(["sale", "refund"] as const),
  source: C.oneOf(["payme_set_fiscal_data", "click_ofd", "uzum"] as const),
  status: C.oneOf(["pending", "registered", "failed"] as const),
  fiscal_receipt_id: C.nullable(C.str(128)),
  terminal_id: C.nullable(C.str(128)),
  fiscal_sign: C.nullable(C.str(128)),
  // ссылка на чек ОФД — только https (иначе ссылки нет)
  qr_code_url: C.https,
  status_code: C.nullable(C.int(-1_000_000, 1_000_000)),
  message: C.optText(500),
  attempts: COUNT,
  registered_at: N_TIME,
  created_at: C.time,
});

export const ADMIN_REFUND: Codec<AdminRefund> = oneAmount(
  C.obj<AdminRefund>({
    refund_id: C.uuid,
    order_id: C.uuid,
    order_no: ORDER_NO,
    txn_id: C.uuid,
    provider: C.oneOf(PROVIDERS),
    amount_tiyin: C.nullable(TIYIN),
    amount_stars: C.nullable(STARS),
    status: C.oneOf(REFUND_ST),
    initiated_by: C.oneOf(["staff", "provider"] as const),
    method: C.oneOf(["provider_api", "provider_cabinet"] as const),
    reason: C.nullable(C.multiline(500, true)),
    requested_by: C.nullable(STAFF_REF),
    requested_at: C.time,
    completed_at: N_TIME,
    failure_code: C.nullable(SHORT_CODE),
    tils_check: C.nullable(C.obj<NonNullable<AdminRefund["tils_check"]>>({ til: COUNT, til_balance: COUNT, status: TILS_STATUS })),
    instruction: C.nullable(
      C.obj<NonNullable<AdminRefund["instruction"]>>({ provider: C.oneOf(PROVIDERS), provider_txn_id: PROVIDER_TXN_ID, amount_tiyin: C.nullable(TIYIN) }),
    ),
  }),
  (r) => r.provider === "telegram_stars",
);
export const REFUND_PAGE = pageOf(ADMIN_REFUND, 200);

export const STARS_SUBSCRIPTION: Codec<AdminStarsSubscription> = C.obj<AdminStarsSubscription>({
  subscription_id: C.uuid,
  product_code: PRODUCT_CODE,
  status: C.oneOf(STARS_SUB_ST),
  amount_stars: STARS,
  expires_at: C.time,
  renewals: COUNT,
  // 0 — заказ первого платежа не найден (billing: `first_order_no or 0`)
  first_order_no: COUNT,
  created_at: C.time,
  updated_at: C.time,
});

const PROVIDER_CALL = C.obj<AdminProviderCall>({
  call_id: C.int(0),
  // payme, click, uzum, telegram_stars, bot-gateway
  provider: C.id(/^[a-z][a-z0-9_-]{1,31}$/, 32),
  direction: C.oneOf(["in", "out"] as const),
  method: C.id(/^[A-Za-z][A-Za-z0-9_./:-]{0,63}$/, 64),
  result_code: SHORT_CODE,
  latency_ms: COUNT,
  created_at: C.time,
});

/** Живой возврат (ждёт провайдера или проведён) — второй оформить нельзя (409 REFUND_STATE). */
const LIVE_REFUND: ReadonlySet<RefundStatus> = new Set(["awaiting_provider", "completed"]);

/**
 * «Возврат» можно оформить сейчас: заказ оплачен (paid | fulfilled), есть проведённая транзакция и нет живого возврата
 * (admin.ts AdminOrderCard.can_refund). Окно провайдера и пред-проверку тилов проверяет billing (409 REFUND_NOT_ALLOWED).
 */
export function canRefund(o: Pick<AdminOrderCard, "status" | "transactions" | "refunds">): boolean {
  return (o.status === "paid" || o.status === "fulfilled") && o.transactions.some((t) => t.state === "performed") && !o.refunds.some((r) => LIVE_REFUND.has(r.status));
}

const CARD_OBJ = C.obj<AdminOrderCard>({
  ...ROW_PROPS,
  offer_version: C.str(32, 1),
  locale: C.oneOf(["ru", "uz"] as const),
  start_mode: C.nullable(C.oneOf(["after_current", "now"] as const)),
  stars_mode: C.nullable(C.oneOf(MODES)),
  product_snapshot: C.json(32_768),
  transactions: C.arr(TXN, 100),
  receipts: C.arr(RECEIPT, 100),
  refunds: C.arr(ADMIN_REFUND, 50),
  stars_subscription: C.nullable(STARS_SUBSCRIPTION),
  provider_calls: C.arr(PROVIDER_CALL, 50),
  // вычисляет admin-bff (canRefund), значение домена не берётся
  can_refund: C.custom<boolean>({ type: "boolean" }, () => false),
});
/** Карточка заказа: транзакции и возвраты — того же провайдера, что заказ; can_refund — по состоянию. */
export const ORDER_CARD: Codec<AdminOrderCard> = C.map(orderChecks(CARD_OBJ), CARD_OBJ.schema, (o, p) => {
  if (o.transactions.some((t) => t.provider !== o.provider)) return bad(`${p}.transactions`);
  if (o.refunds.some((r) => r.provider !== o.provider || r.order_id !== o.order_id)) return bad(`${p}.refunds`);
  return { ...o, can_refund: canRefund(o) };
});

// ---------------------------------------------------------------- вкладка «Тариф», реестр минут

const BALANCE = C.obj<NonNullable<AdminBillingPeriod["balance"]>>({
  granted: COUNT,
  spent: COUNT,
  removed: COUNT,
  held: COUNT,
  overage: COUNT,
  // баланс не бывает отрицательным (CHECK billing)
  minutes_left: COUNT,
});

export const BILLING_PERIOD: Codec<AdminBillingPeriod> = C.obj<AdminBillingPeriod>({
  period_id: C.uuid,
  product_code: PRODUCT_CODE,
  source: C.oneOf(["order", "trial", "grant"] as const),
  status: C.oneOf(PERIOD_ST),
  features: FEATURE_LIST,
  minutes_granted: COUNT,
  days: COUNT,
  starts_at: N_TIME,
  ends_at: N_TIME,
  created_at: C.time,
  closed_at: N_TIME,
  close_reason: C.nullable(C.oneOf(["ended", "superseded", "refund", "staff", "deletion"] as const)),
  order_no: C.nullable(ORDER_NO),
  balance: C.nullable(BALANCE),
});

const HOLD = C.obj<AdminMinuteHold>({
  hold_id: C.uuid,
  feature: C.oneOf(FEATURES),
  ref_kind: C.oneOf(["session", "room"] as const),
  ref_id: C.uuid,
  learner_id: C.nullable(C.uuid),
  minutes: COUNT,
  status: C.oneOf(["active", "settled", "expired"] as const),
  settled_minutes: C.nullable(COUNT),
  overage: C.nullable(COUNT),
  created_at: C.time,
  expires_at: C.time,
  settled_at: N_TIME,
});

export const BILLING_ACCOUNT: Codec<AdminBillingAccount> = C.obj<AdminBillingAccount>({
  account_id: C.uuid,
  status: C.oneOf(SUB_ST),
  tier: C.oneOf(TIERS),
  features: FEATURE_LIST,
  expiring: C.bool,
  minutes_exhausted: C.bool,
  trial_used: C.bool,
  current_period: C.nullable(BILLING_PERIOD),
  periods: C.arr(BILLING_PERIOD, 20),
  holds: C.arr(HOLD, 200),
  stars_subscription: C.nullable(STARS_SUBSCRIPTION),
  pending_adjustments: COUNT,
});

/** Кто сделал запись реестра: system | learner | staff:<uuid> (admin.ts). */
const LEDGER_ACTOR = C.custom<string>({ type: "string" }, (v, p) =>
  typeof v === "string" && /^(?:system|learner|staff:[0-9a-fA-F-]{36})$/.test(v) && (!v.startsWith("staff:") || UUID_RE.test(v.slice(6)))
    ? v.toLowerCase()
    : bad(p),
);
/** Минуты записи: знак — направление (списание, сгорание — минус; начисление — плюс; корректировка — любой). */
const MINUTES_SIGNED = C.int(-1_000_000, 1_000_000);
export const LEDGER_ENTRY: Codec<AdminLedgerEntry> = C.obj<AdminLedgerEntry>({
  entry_id: C.uuid,
  seq: C.int(0),
  period_id: C.uuid,
  kind: C.oneOf(ENTRY_KINDS),
  minutes: MINUTES_SIGNED,
  overage: COUNT,
  learner_id: C.nullable(C.uuid),
  ref_kind: C.oneOf(REF_KINDS),
  ref_id: C.str(128, 1),
  actor: LEDGER_ACTOR,
  // billing: «Система» | имя решившего заявку | null; пустое для staff:<id> дописывает маршрут (staff/lookup)
  actor_name: C.optText(120),
  created_at: C.time,
});
export const LEDGER_PAGE = pageOf(LEDGER_ENTRY, 200);

// ---------------------------------------------------------------- корректировки «четыре глаза»

const ADJUSTMENT_OBJ = C.obj<Adjustment>({
  adjustment_id: C.uuid,
  account_id: C.uuid,
  kind: C.oneOf(ADJ_KINDS),
  minutes: C.nullable(C.int(-10_000, 10_000)),
  days: C.nullable(C.int(0, 366)),
  period_id: C.nullable(C.uuid),
  // основание сотрудника — только в админке, ученику не показывается
  reason: C.multiline(500),
  status: C.oneOf(ADJ_ST),
  requested_by: STAFF_REF,
  requested_at: C.time,
  decided_by: C.nullable(STAFF_REF),
  decided_at: N_TIME,
  decision_note: C.nullable(C.multiline(500, true)),
  before_value: C.nullable(C.json(4096)),
  after_value: C.nullable(C.json(4096)),
  expires_at: C.time,
  // подсказки UI — вычисляет admin-bff (adjustmentHints) по правам сессии, значение домена не берётся
  can_decide: C.custom<boolean>({ type: "boolean" }, () => false),
  can_cancel: C.custom<boolean>({ type: "boolean" }, () => false),
});
/** «Четыре глаза»: решает не автор — у заявки автора и решающего разные сотрудники (иначе ответ испорчен). */
export const ADJUSTMENT: Codec<Adjustment> = C.map(ADJUSTMENT_OBJ, ADJUSTMENT_OBJ.schema, (a, p) =>
  a.decided_by && a.decided_by.staff_id === a.requested_by.staff_id && (a.status === "applied" || a.status === "rejected") ? bad(`${p}.decided_by`) : a,
);
export const ADJUSTMENT_PAGE = pageOf(ADJUSTMENT, 200);

/**
 * Подсказки UI заявки (admin.ts Adjustment.can_decide / can_cancel): подтвердить или отклонить может сотрудник с
 * billing.approve, который НЕ автор, пока заявка ждёт; отозвать — только автор. Домен проверяет то же (409
 * SELF_APPROVAL, CHECK в БД) — подсказка только убирает кнопки.
 */
export function adjustmentHints(a: Adjustment, staffId: string, canApprove: boolean): Adjustment {
  const pending = a.status === "pending";
  const author = a.requested_by.staff_id === staffId.toLowerCase();
  return { ...a, can_decide: pending && canApprove && !author, can_cancel: pending && author };
}

// ---------------------------------------------------------------- сверка

export const RECON_ITEM: Codec<ReconItem> = C.obj<ReconItem>({
  item_id: C.uuid,
  run_id: C.nullable(C.uuid),
  kind: C.oneOf(RECON_KINDS),
  provider: C.nullable(C.oneOf(PROVIDERS)),
  order_id: C.nullable(C.uuid),
  order_no: C.nullable(ORDER_NO),
  txn_id: C.nullable(C.uuid),
  period_id: C.nullable(C.uuid),
  // подробности без ПДн, Telegram ID и секретов (billing) — как есть, ≤ 8 КБ
  details: C.json(8192),
  status: C.oneOf(["open", "resolved", "ignored"] as const),
  created_at: C.time,
  resolved_by: C.nullable(STAFF_REF),
  resolved_at: N_TIME,
  note: C.nullable(C.multiline(500, true)),
});
export const RECON_PAGE = pageOf(RECON_ITEM, 200);

export const RECON_RUN: Codec<ReconRun> = C.obj<ReconRun>({
  run_id: C.uuid,
  kind: C.oneOf(["tick", "daily", "manual"] as const),
  started_at: C.time,
  finished_at: N_TIME,
  checked: COUNT,
  found: COUNT,
  error: C.optText(300),
});

// ---------------------------------------------------------------- отчёты, курсы, провайдеры

export const MINUTES_TOTALS: Codec<BillingMinutesTotals> = C.obj<BillingMinutesTotals>({ granted: TOTAL, spent: TOTAL, expired: TOTAL, revoked: TOTAL, overage: TOTAL });
export const FX_REF: Codec<FxRateRef> = C.obj<FxRateRef>({ usd_in_tiyin: C.int(1, 1_000_000_000), valid_from: C.date });
export const STAR_REF: Codec<StarRateRef> = C.obj<StarRateRef>({ star_in_tiyin: C.int(1, 100_000_000), valid_from: C.date });

type Web = BillingSummary["web"];
type Stars = BillingSummary["stars"];
const BY_PROVIDER = C.obj<Web["by_provider"]>({
  payme: C.obj<Web["by_provider"]["payme"]>({ orders: COUNT, revenue_tiyin: TOTAL }),
  click: C.obj<Web["by_provider"]["click"]>({ orders: COUNT, revenue_tiyin: TOTAL }),
  uzum: C.obj<Web["by_provider"]["uzum"]>({ orders: COUNT, revenue_tiyin: TOTAL }),
});
export const SUMMARY_WEB: Codec<Web> = C.obj<Web>({ revenue_tiyin: TOTAL, refunds_tiyin: TOTAL, net_tiyin: SIGNED, orders_paid: COUNT, by_provider: BY_PROVIDER });
export const SUMMARY_STARS: Codec<Stars> = C.obj<Stars>({
  revenue_stars: TOTAL,
  refunds_stars: TOTAL,
  net_stars: SIGNED,
  orders_paid: COUNT,
  renewals: COUNT,
  est_net_tiyin: C.nullable(SIGNED),
});
export const BY_PRODUCT = C.dict(/^[a-z0-9_]{2,40}$/, C.obj<BillingSummary["by_product"][string]>({ orders: COUNT, revenue_tiyin: TOTAL, revenue_stars: TOTAL }), 200);

export const BILLING_SUMMARY: Codec<BillingSummary> = C.obj<BillingSummary>({
  period: C.oneOf(["day", "week", "month"] as const),
  from: C.time,
  to: C.time,
  web: SUMMARY_WEB,
  stars: SUMMARY_STARS,
  by_product: BY_PRODUCT,
  refunds_count: COUNT,
  recon_open: COUNT,
  active_subscriptions: COUNT,
  stars_subscriptions_live: COUNT,
  trials_started: COUNT,
  trials_converted: COUNT,
  conversion_pct: C.nullable(C.num(0, 100)),
  minutes: MINUTES_TOTALS,
  fx: C.nullable(FX_REF),
  star_rate: C.nullable(STAR_REF),
});

export const DAILY_ROW: Codec<BillingDailyRow> = C.obj<BillingDailyRow>({
  date: C.date,
  web_revenue_tiyin: TOTAL,
  web_refunds_tiyin: TOTAL,
  stars_revenue_stars: TOTAL,
  stars_refunds_stars: TOTAL,
  orders_paid: COUNT,
  trials_started: COUNT,
  minutes_spent: TOTAL,
});
export const DAILY_LIST = itemsOf(DAILY_ROW, 92);

export const FX_RATE: Codec<FxRate> = C.obj<FxRate>({
  usd_in_tiyin: C.int(1, 1_000_000_000),
  valid_from: C.date,
  set_by: STAFF_REF,
  reason: C.multiline(500),
  created_at: C.time,
});
export const FX_LIST = itemsOf(FX_RATE, 500);
export const STAR_RATE: Codec<StarRate> = C.obj<StarRate>({
  star_in_tiyin: C.int(1, 100_000_000),
  valid_from: C.date,
  set_by: STAFF_REF,
  reason: C.multiline(500),
  created_at: C.time,
});
export const STAR_RATE_LIST = itemsOf(STAR_RATE, 500);

/** Провайдер: включён ли и задан ли ключ — сам ключ не приходит и не показывается никогда. */
export const PROVIDER_STATUS: Codec<BillingProviderStatus> = C.obj<BillingProviderStatus>({
  provider: C.oneOf(PROVIDERS),
  enabled: C.bool,
  configured: C.bool,
  last_callback_at: N_TIME,
  last_error_code: C.nullable(SHORT_CODE),
});
export const PROVIDER_LIST = itemsOf(PROVIDER_STATUS, 10);

export const TRIALS_RESULT: Codec<TrialsGrantAllResult> = C.obj<TrialsGrantAllResult>({ granted: COUNT, skipped: COUNT });

// ---------------------------------------------------------------- ученик → аккаунт (вкладка «Тариф»)

/** Карточка user-admin — только вид профиля и опекун: тариф детского профиля — тариф аккаунта опекуна. */
export const LEARNER_ACCOUNT_REF: Codec<{ user_id: string; kind: "account" | "child"; guardian_user_id: string | null }> = C.obj<{
  user_id: string;
  kind: "account" | "child";
  guardian_user_id: string | null;
}>({ user_id: C.uuid, kind: C.oneOf(["account", "child"] as const), guardian_user_id: C.nullable(C.uuid) });
