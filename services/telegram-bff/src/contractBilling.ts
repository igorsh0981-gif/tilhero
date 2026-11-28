/**
 * Спринт 8 — кодеки billing для Mini App (канал `miniapp`, bff.ts «Спринт 8», INTERNAL_API §1.3, §1.5, §1.11, §1.17, §12).
 *
 * Два слоя схем:
 *  - **домен** (`*Domain`) — что принимаем от billing: типы и перечисления проверяются, лишние поля допустимы (ответ не по
 *    схеме → 503 BILLING_UNAVAILABLE, в лог — проверка, путь, правило, без значений);
 *  - **Mini App** (`*Schema`) — ответ BFF ровно по контракту (assertSame с bff.ts): сериализация по ним отбрасывает всё
 *    лишнее (fast-json-stringify).
 *
 * Анти-стиринг (решение владельца В1, PLAN решение 3): в Mini App продаётся только за Telegram Stars. Кодеки сверх
 * схемы ответа явно отбрасывают всё, что не Stars, даже если billing ошибся каналом:
 *  - товар каталога без цены в Stars (`price.stars`) — не показывается; способы оплаты — только `telegram_stars`;
 *  - заказ не Stars (`provider ≠ telegram_stars`, `currency ≠ XTR`, есть `amount_tiyin`, канал не `miniapp | renewal`)
 *    — в списке пропускается, по номеру — 404 ORDER_NOT_FOUND; ссылка на счёт — только `https://t.me/…`;
 *  - оферта на домене сайта оплаты (`WEB_PAY_ORIGIN`) — ответ не по контракту (503);
 *  - сведения об источнике и цене периодов (покупка вне Mini App) в SubscriptionView не попадают — только статус и минуты.
 * Детский профиль (защита в глубину): каталог — `products: []`, `trial: null`, `payer_required: true`, `can_pay: false`;
 * подписка — без `stars_subscription` (цена) и без права платить.
 *
 * Деньги — целые числа (ADR-0001): `amount_stars` и `price.stars` — целые звёзды; тийинов в ответах Mini App нет.
 */
import { Type, type Static, type TLiteral, type TSchema, type TSchemaOptions, type TUnion } from "@fastify/type-provider-typebox";
import type * as C from "@tilhero/contracts/bff";
import type { FastifyBaseLogger } from "fastify";
import { matches } from "./check.js";

// ---------- compile-time сверка с контрактом (как schemas.ts) ----------
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertSame<T extends true>(_?: T): void {}

const strict = { additionalProperties: false } as const;
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const IsoTime = Type.String({ minLength: 10, maxLength: 40, description: "ISO-8601 UTC" });
const Localized = Type.Object({ ru: Type.String(), uz: Type.String() });

type ToLiterals<T extends readonly string[]> = T extends readonly [infer H extends string, ...infer R extends readonly string[]]
  ? [TLiteral<H>, ...ToLiterals<R>]
  : [];
function Enum<const T extends readonly [string, ...string[]]>(values: T, opts: TSchemaOptions = {}): TUnion<ToLiterals<T>> {
  return Type.Union(values.map((v) => Type.Literal(v)), opts) as unknown as TUnion<ToLiterals<T>>;
}

/** Провайдер и валюта Mini App — единственные допустимые (bff.ts BillingOrderRequest.provider, StarsOrder.currency). */
export const STARS_PROVIDER = "telegram_stars";
export const STARS_CURRENCY = "XTR";
/** Цена в Stars: 1..100 000 (подписка Stars — ≤ 10 000; проверяет валидатор каталога billing). */
export const STARS_MAX = 100_000;
/** Номер заказа в пути: целое без ведущих нулей (≤ 10¹⁵ — безопасное целое JS). */
export const ORDER_NO_PATTERN = "^[1-9][0-9]{0,14}$";
/** Ссылка на счёт Stars (createInvoiceLink): только t.me; иное — не показываем (null). */
const INVOICE_LINK_RE = /^https:\/\/t\.me\/[A-Za-z0-9_$+\-/=]{1,512}$/;
const PRODUCT_CODE_PATTERN = "^[a-z0-9_]{2,40}$";
const OFFER_VERSION_PATTERN = "^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$";

// ---------- перечисления (= bff.ts) ----------
export const BILLING_FEATURES = ["ai_lessons", "pair_lessons"] as const;
const Feature = Enum(BILLING_FEATURES);
assertSame<Same<Static<typeof Feature>, C.BillingFeature>>();
const ProductKind = Enum(["subscription", "til_pack"]);
assertSame<Same<Static<typeof ProductKind>, C.BillingProductKind>>();
const StarsModeSchema = Enum(["one_time", "subscription"]);
assertSame<Same<Static<typeof StarsModeSchema>, C.StarsMode>>();
const SubscriptionStatus = Enum(["none", "trial", "active", "expired"]);
assertSame<Same<Static<typeof SubscriptionStatus>, C.SubscriptionStatus>>();
export const ORDER_STATUSES = ["pending", "paid", "fulfilled", "expired", "cancelled", "refunded"] as const;
const OrderStatus = Enum(ORDER_STATUSES);
assertSame<Same<Static<typeof OrderStatus>, C.BillingOrderStatus>>();
const StarsSubscriptionStatus = Enum(["active", "canceled", "failed", "refunded", "ended"]);
assertSame<Same<Static<typeof StarsSubscriptionStatus>, C.StarsSubscriptionStatus>>();
const MinuteKind = Enum(["grant", "debit", "expire", "revoke", "adjust"]);
assertSame<Same<Static<typeof MinuteKind>, C.MinuteEntryKind>>();
const MinuteRefKind = Enum(["order", "trial", "grant", "session", "room", "period", "hold", "refund", "adjustment", "deletion"]);
assertSame<Same<Static<typeof MinuteRefKind>, C.MinuteRefKind>>();
const RefundStatus = Enum(["awaiting_provider", "completed", "failed"]);
const Minutes = Type.Integer({ minimum: 0, maximum: 1_000_000 });

// =====================================================================================================================
// Ответы Mini App (строго по контракту)
// =====================================================================================================================
export const StarsPriceSchema = Type.Object({ stars: Type.Integer({ minimum: 1, maximum: STARS_MAX }), mode: StarsModeSchema });
assertSame<Same<Static<typeof StarsPriceSchema>, C.StarsPrice>>();

export const BillingProductSchema = Type.Object({
  code: Type.String({ pattern: PRODUCT_CODE_PATTERN }),
  kind: ProductKind,
  title: Localized,
  description: Nullable(Localized),
  days: Nullable(Type.Integer({ minimum: 1 })),
  minutes: Nullable(Type.Integer({ minimum: 1 })),
  features: Type.Array(Feature),
  til: Nullable(Type.Integer({ minimum: 1 })),
  price: StarsPriceSchema,
});
assertSame<Same<Static<typeof BillingProductSchema>, C.BillingProduct>>();

export const BillingCatalogSchema = Type.Object({
  sales_enabled: Type.Boolean(),
  providers: Type.Array(Type.Literal(STARS_PROVIDER)),
  offer: Type.Object({ version: Type.String(), url: Type.String() }),
  trial: Nullable(Type.Object({ available: Type.Boolean(), days: Type.Integer({ minimum: 1 }), minutes: Type.Integer({ minimum: 1 }) })),
  products: Type.Array(BillingProductSchema),
  payer_required: Type.Boolean(),
  can_pay: Type.Boolean(),
  consent_required: Type.Boolean(),
});
assertSame<Same<Static<typeof BillingCatalogSchema>, C.BillingCatalog>>();

const PeriodSchema = Type.Object({
  starts_at: IsoTime,
  ends_at: IsoTime,
  minutes_granted: Minutes,
  minutes_spent: Minutes,
  minutes_held: Minutes,
  minutes_left: Minutes,
  overage: Minutes,
});
assertSame<Same<Static<typeof PeriodSchema>, C.SubscriptionPeriodView>>();

export const StarsSubscriptionViewSchema = Type.Object({
  status: StarsSubscriptionStatus,
  auto_renew: Type.Boolean(),
  expires_at: IsoTime,
  amount_stars: Type.Integer({ minimum: 1, maximum: STARS_MAX }),
});
assertSame<Same<Static<typeof StarsSubscriptionViewSchema>, C.StarsSubscriptionView>>();

export const SubscriptionViewSchema = Type.Object({
  status: SubscriptionStatus,
  plan: Nullable(Type.Object({ code: Type.String(), title: Localized })),
  period: Nullable(PeriodSchema),
  next_period: Nullable(Type.Object({ days: Type.Integer({ minimum: 1 }), minutes_granted: Minutes, starts_at: Nullable(IsoTime) })),
  features: Type.Array(Feature),
  expiring: Type.Boolean(),
  minutes_exhausted: Type.Boolean(),
  payer_required: Type.Boolean(),
  can_pay: Type.Boolean(),
  trial_available: Type.Boolean(),
  sales_enabled: Type.Boolean(),
  stars_subscription: Nullable(StarsSubscriptionViewSchema),
});
assertSame<Same<Static<typeof SubscriptionViewSchema>, C.SubscriptionView>>();

export const MinuteEntrySchema = Type.Object({
  at: IsoTime,
  kind: MinuteKind,
  minutes: Type.Integer({ minimum: -1_000_000, maximum: 1_000_000 }),
  ref_kind: MinuteRefKind,
  learner: Nullable(Enum(["self", "child"])),
  period_id: Type.String({ minLength: 1, maxLength: 64 }),
});
assertSame<Same<Static<typeof MinuteEntrySchema>, C.MinuteEntry>>();
export const MinutePageSchema = Type.Object({ items: Type.Array(MinuteEntrySchema), next_cursor: Nullable(Type.String()) });

export const StarsOrderSchema = Type.Object({
  order_no: Type.Integer({ minimum: 1 }),
  status: OrderStatus,
  channel: Enum(["miniapp", "renewal"]),
  product: Type.Object({ code: Type.String(), kind: ProductKind, title: Localized }),
  currency: Type.Literal(STARS_CURRENCY),
  amount_stars: Type.Integer({ minimum: 1, maximum: STARS_MAX }),
  provider: Type.Literal(STARS_PROVIDER),
  invoice_link: Nullable(Type.String()),
  expires_at: IsoTime,
  created_at: IsoTime,
  paid_at: Nullable(IsoTime),
  refund: Nullable(Type.Object({ status: RefundStatus })),
});
assertSame<Same<Static<typeof StarsOrderSchema>, C.StarsOrder>>();
export const StarsOrderPageSchema = Type.Object({ items: Type.Array(StarsOrderSchema), next_cursor: Nullable(Type.String()) });

// =====================================================================================================================
// Запросы Mini App (additionalProperties: false — лишнее поле → 422)
// =====================================================================================================================
export const BillingOrderRequestSchema = Type.Object(
  {
    product_code: Type.String({ pattern: PRODUCT_CODE_PATTERN }),
    // в Mini App — только Stars: любой другой провайдер — 422 VALIDATION_ERROR без вызова billing
    provider: Type.Literal(STARS_PROVIDER),
    start_mode: Type.Optional(Enum(["after_current", "now"])),
    confirm_forfeit: Type.Optional(Type.Boolean()),
    beneficiary_id: Type.Optional(Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" })),
    offer_version: Type.String({ pattern: OFFER_VERSION_PATTERN }),
  },
  strict,
);
assertSame<Same<Static<typeof BillingOrderRequestSchema>, C.BillingOrderRequest>>();

export const StarsSubscriptionRequestSchema = Type.Object({ auto_renew: Type.Boolean() }, strict);
assertSame<Same<Static<typeof StarsSubscriptionRequestSchema>, C.StarsSubscriptionRequest>>();

export const OrderNoParamsSchema = Type.Object({ order_no: Type.String({ pattern: ORDER_NO_PATTERN }) });
export const BillingCursorQuerySchema = Type.Object({ cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) }, strict);

// =====================================================================================================================
// Ответы billing (домен): типы проверяются, лишние поля допустимы
// =====================================================================================================================
const ProductDomain = Type.Object({
  code: Type.String({ pattern: PRODUCT_CODE_PATTERN }),
  kind: ProductKind,
  title: Localized,
  description: Type.Optional(Nullable(Localized)),
  days: Type.Optional(Nullable(Type.Integer({ minimum: 1 }))),
  minutes: Type.Optional(Nullable(Type.Integer({ minimum: 1 }))),
  features: Type.Optional(Type.Array(Feature)),
  til: Type.Optional(Nullable(Type.Integer({ minimum: 1 }))),
  // форма цены — у каждого канала своя: в Mini App — только {stars, mode}; прочее — товар не показывается
  price: Type.Unknown(),
});
type ProductDomainT = Static<typeof ProductDomain>;

export const CatalogDomain = Type.Object({
  sales_enabled: Type.Boolean(),
  providers: Type.Array(Type.String()),
  offer: Type.Object({ version: Type.String({ pattern: OFFER_VERSION_PATTERN }), url: Type.String({ minLength: 9, maxLength: 512 }) }),
  trial: Type.Optional(Nullable(Type.Object({ available: Type.Boolean(), days: Type.Integer({ minimum: 1 }), minutes: Type.Integer({ minimum: 1 }) }))),
  products: Type.Array(Type.Unknown()),
  payer_required: Type.Boolean(),
  can_pay: Type.Boolean(),
  consent_required: Type.Boolean(),
});

export const SubscriptionDomain = Type.Object({
  status: SubscriptionStatus,
  plan: Nullable(Type.Object({ code: Type.String(), title: Localized })),
  period: Nullable(PeriodSchema),
  next_period: Type.Optional(Nullable(Type.Object({ days: Type.Integer({ minimum: 1 }), minutes_granted: Minutes, starts_at: Type.Optional(Nullable(IsoTime)) }))),
  features: Type.Array(Feature),
  expiring: Type.Boolean(),
  /** §16: поле добавлено к §1.11; нет — выводится из остатка периода */
  minutes_exhausted: Type.Optional(Type.Boolean()),
  payer_required: Type.Boolean(),
  can_pay: Type.Boolean(),
  trial_available: Type.Boolean(),
  sales_enabled: Type.Boolean(),
  stars_subscription: Type.Optional(Nullable(StarsSubscriptionViewSchema)),
});

/** Заказ billing (§1.3 Order + channel, paid_at — §16). Не Stars — отбрасывается кодеком (не 503). */
export const OrderDomain = Type.Object({
  order_no: Type.Integer({ minimum: 1 }),
  status: OrderStatus,
  channel: Type.Optional(Type.String()),
  product: Type.Object({ code: Type.String(), kind: ProductKind, title: Localized }),
  currency: Type.String(),
  amount_stars: Type.Optional(Nullable(Type.Integer())),
  amount_tiyin: Type.Optional(Nullable(Type.Integer())),
  provider: Type.String(),
  invoice_link: Type.Optional(Nullable(Type.String())),
  expires_at: IsoTime,
  created_at: IsoTime,
  paid_at: Type.Optional(Nullable(IsoTime)),
  refund: Type.Optional(Nullable(Type.Object({ status: RefundStatus }))),
});
type OrderDomainT = Static<typeof OrderDomain>;

// =====================================================================================================================
// Кодеки
// =====================================================================================================================

/** Товар для Mini App: только с ценой в Stars; null — не показывать (цена сайта, нет цены, иная форма). */
export function productView(p: ProductDomainT): C.BillingProduct | null {
  if (!matches(StarsPriceSchema, p.price)) return null;
  const price = p.price as C.StarsPrice;
  // разовый пакет тилов — только one_time (валидатор billing); подписка Stars — только у подписки
  if (p.kind === "til_pack" && price.mode !== "one_time") return null;
  const sub = p.kind === "subscription";
  if (sub && (p.days == null || p.minutes == null)) return null;
  if (!sub && p.til == null) return null;
  return {
    code: p.code,
    kind: p.kind,
    title: { ru: p.title.ru, uz: p.title.uz },
    description: p.description ? { ru: p.description.ru, uz: p.description.uz } : null,
    days: sub ? p.days! : null,
    minutes: sub ? p.minutes! : null,
    features: sub ? [...new Set(p.features ?? [])] : [],
    til: sub ? null : p.til!,
    price: { stars: price.stars, mode: price.mode },
  };
}

export interface CatalogViewOpts {
  /** детский профиль (lrn ≠ sub): без цен, пробного и права платить */
  childProfile: boolean;
  /** origin сайта оплаты (WEB_PAY_ORIGIN): оферта на нём — ответ не по контракту */
  webPayOrigin: string;
  log: FastifyBaseLogger;
}

/** Причина, по которой каталог billing не годится для Mini App (→ 503), или null. */
export function catalogProblem(d: Static<typeof CatalogDomain>, webPayOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(d.offer.url);
  } catch {
    return "offer_url";
  }
  if (webPayOrigin && url.origin === webPayOrigin) return "offer_on_web_pay";
  if (url.protocol !== "https:") return "offer_url";
  return null;
}

export function catalogView(d: Static<typeof CatalogDomain>, o: CatalogViewOpts): C.BillingCatalog {
  const providers = d.providers.filter((p): p is typeof STARS_PROVIDER => p === STARS_PROVIDER);
  const products: C.BillingProduct[] = [];
  let dropped = 0;
  for (const raw of d.products) {
    const v = matches(ProductDomain, raw) ? productView(raw) : null;
    if (v) products.push(v);
    else dropped += 1;
  }
  if (dropped) o.log.info({ upstream: "billing", check: "catalog", dropped }, "billing products without a Stars price skipped");
  if (o.childProfile) {
    return {
      sales_enabled: d.sales_enabled && providers.length > 0,
      providers: [],
      offer: { version: d.offer.version, url: d.offer.url },
      trial: null,
      products: [],
      payer_required: true,
      can_pay: false,
      consent_required: false,
    };
  }
  return {
    sales_enabled: d.sales_enabled && providers.length > 0,
    providers,
    offer: { version: d.offer.version, url: d.offer.url },
    trial: d.trial ? { available: d.trial.available, days: d.trial.days, minutes: d.trial.minutes } : null,
    products,
    payer_required: d.payer_required,
    can_pay: d.can_pay,
    consent_required: d.consent_required,
  };
}

/** «Купить тилы» за Stars доступно: продажи включены, профиль может платить, есть пакет тилов с ценой в Stars. */
export function tilPurchaseAvailable(c: C.BillingCatalog): boolean {
  return c.sales_enabled && c.can_pay && !c.payer_required && c.products.some((p) => p.kind === "til_pack" && p.price.stars >= 1);
}

export function subscriptionView(d: Static<typeof SubscriptionDomain>, childProfile: boolean): C.SubscriptionView {
  const p = d.period;
  const stars = d.stars_subscription ?? null;
  return {
    status: d.status,
    plan: d.plan ? { code: d.plan.code, title: { ru: d.plan.title.ru, uz: d.plan.title.uz } } : null,
    period: p
      ? {
          starts_at: p.starts_at,
          ends_at: p.ends_at,
          minutes_granted: p.minutes_granted,
          minutes_spent: p.minutes_spent,
          minutes_held: p.minutes_held,
          minutes_left: p.minutes_left,
          overage: p.overage,
        }
      : null,
    next_period: d.next_period ? { days: d.next_period.days, minutes_granted: d.next_period.minutes_granted, starts_at: d.next_period.starts_at ?? null } : null,
    features: [...new Set(d.features)],
    expiring: d.expiring,
    minutes_exhausted: d.minutes_exhausted ?? (!!p && p.minutes_left === 0 && (d.status === "active" || d.status === "trial")),
    payer_required: childProfile ? true : d.payer_required,
    can_pay: childProfile ? false : d.can_pay,
    trial_available: childProfile ? false : d.trial_available,
    sales_enabled: d.sales_enabled,
    // цена подписки Stars — только плательщику (детскому профилю — нет)
    stars_subscription: !childProfile && stars ? { status: stars.status, auto_renew: stars.auto_renew, expires_at: stars.expires_at, amount_stars: stars.amount_stars } : null,
  };
}

/** Почему заказ billing не показывается в Mini App (не Stars), или null. */
export function orderProblem(d: OrderDomainT): string | null {
  if (d.provider !== STARS_PROVIDER) return "provider";
  if (d.currency !== STARS_CURRENCY) return "currency";
  if (d.amount_tiyin != null) return "amount_tiyin";
  if (d.amount_stars == null || d.amount_stars < 1 || d.amount_stars > STARS_MAX) return "amount_stars";
  if (d.channel !== undefined && d.channel !== "miniapp" && d.channel !== "renewal") return "channel";
  return null;
}

/** Заказ Stars для Mini App; null — заказ не Stars (в Mini App его нет). */
export function starsOrderView(d: OrderDomainT): C.StarsOrder | null {
  if (orderProblem(d)) return null;
  const link = d.status === "pending" && typeof d.invoice_link === "string" && INVOICE_LINK_RE.test(d.invoice_link) ? d.invoice_link : null;
  return {
    order_no: d.order_no,
    status: d.status,
    channel: d.channel === "renewal" ? "renewal" : "miniapp",
    product: { code: d.product.code, kind: d.product.kind, title: { ru: d.product.title.ru, uz: d.product.title.uz } },
    currency: STARS_CURRENCY,
    amount_stars: d.amount_stars!,
    provider: STARS_PROVIDER,
    invoice_link: link,
    expires_at: d.expires_at,
    created_at: d.created_at,
    paid_at: d.paid_at ?? null,
    refund: d.refund ? { status: d.refund.status } : null,
  };
}

/** Список заказов: только Stars; прочее отбрасывается с предупреждением (канал miniapp не видит заказов сайта). */
export function starsOrdersView(items: unknown[], log: FastifyBaseLogger): C.StarsOrder[] {
  const out: C.StarsOrder[] = [];
  let malformed = 0;
  let foreign = 0;
  for (const raw of items) {
    if (!matches(OrderDomain, raw)) {
      malformed += 1;
      continue;
    }
    const v = starsOrderView(raw);
    if (v) out.push(v);
    else foreign += 1;
  }
  if (malformed) log.warn({ upstream: "billing", check: "orders", dropped: malformed, upstream_code: "UPSTREAM_BAD_RESPONSE" }, "list items dropped");
  if (foreign) log.warn({ upstream: "billing", check: "orders", dropped: foreign, rule: "stars_only" }, "non-Stars orders dropped from the Mini App history");
  return out;
}

// =====================================================================================================================
// Ошибки billing → Mini App: код и статус — как есть; details — только поля контракта; message — нейтральный текст BFF
// (Mini App переводит по коду; текст домена наружу не уходит — в нём не должно оказаться ничего о других способах оплаты)
// =====================================================================================================================
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})$/;
const SAFE_FIELD_RE = /^[a-z][a-z0-9_.]{0,63}$/;
const nonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000;

/** Разрешённые details ошибок billing (bff.ts «Спринт 8», общие коды). */
export function billingErrorDetails(code: string, status: number, d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  switch (code) {
    case "OFFER_VERSION_MISMATCH":
      if (typeof d.current === "string" && new RegExp(OFFER_VERSION_PATTERN).test(d.current)) out.current = d.current;
      break;
    case "FORFEIT_CONFIRMATION_REQUIRED":
      if (nonNegInt(d.minutes_left)) out.minutes_left = d.minutes_left;
      if (nonNegInt(d.days_left)) out.days_left = d.days_left;
      break;
    case "ACTIVE_PERIOD_EXISTS":
      if (typeof d.ends_at === "string" && ISO_RE.test(d.ends_at)) out.ends_at = d.ends_at;
      break;
    case "ORDER_STATE":
      if (typeof d.status === "string" && (ORDER_STATUSES as readonly string[]).includes(d.status)) out.status = d.status;
      break;
    case "VALIDATION_ERROR":
      if (typeof d.field === "string" && SAFE_FIELD_RE.test(d.field)) out.field = d.field;
      break;
  }
  if (status === 429 && typeof d.retry_after === "number" && d.retry_after > 0 && d.retry_after < 86_400) out.retry_after = Math.ceil(d.retry_after);
  return out;
}

const BILLING_MESSAGES: Record<string, string> = {
  PAYMENTS_DISABLED: "Покупки временно недоступны",
  PROVIDER_NOT_AVAILABLE: "Оплата через Telegram Stars временно недоступна",
  PROVIDER_NOT_ALLOWED: "В приложении оплата — только Telegram Stars",
  PAYER_REQUIRED: "Покупки доступны только владельцу аккаунта в своём профиле",
  GUARDIAN_CONSENT_REQUIRED: "Покупки — с согласия родителя",
  BENEFICIARY_NOT_ALLOWED: "Получатель — вы или детский профиль вашего аккаунта",
  PRODUCT_NOT_FOUND: "Товар не найден",
  PRODUCT_NOT_AVAILABLE: "Товар сейчас не продаётся",
  OFFER_VERSION_MISMATCH: "Условия обновились — ознакомьтесь с ними снова",
  FORFEIT_CONFIRMATION_REQUIRED: "Подтвердите замену пробного периода",
  ACTIVE_PERIOD_EXISTS: "Подписка уже активна",
  STARS_SUBSCRIPTION_EXISTS: "Подписка Telegram Stars уже оформлена",
  STARS_SUBSCRIPTION_NOT_FOUND: "Подписки Telegram Stars нет",
  STARS_UNAVAILABLE: "Telegram не выдал счёт — повторите",
  ORDERS_LIMIT: "Слишком много незавершённых заказов",
  ORDER_NOT_FOUND: "Заказ не найден",
  ORDER_STATE: "Заказ уже изменился",
  TRIAL_USED: "Пробный период уже был",
  TRIAL_NOT_AVAILABLE: "Пробный период недоступен",
};
export const billingMessage = (code: string): string => BILLING_MESSAGES[code] ?? "Покупка сейчас недоступна";
