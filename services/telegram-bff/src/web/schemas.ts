/**
 * JSON Schema (TypeBox) API сайта оплаты /web/v1/* — типы только из packages/contracts/src/web.ts: каждая схема
 * сверяется с типом контракта на этапе tsc (assertSame). Ответы сериализуются по схеме (fast-json-stringify): на сайт
 * уходят только поля контракта. Вход — additionalProperties: false (лишние поля → 422).
 */
import { Type, type Static, type TLiteral, type TSchema, type TUnion } from "@fastify/type-provider-typebox";
import type * as W from "@tilhero/contracts/web";
import type * as C from "@tilhero/contracts/bff";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertSame<T extends true>(_?: T): void {}

type ToLiterals<T extends readonly string[]> = T extends readonly [infer H extends string, ...infer R extends readonly string[]]
  ? [TLiteral<H>, ...ToLiterals<R>]
  : [];
function Enum<const T extends readonly [string, ...string[]]>(values: T): TUnion<ToLiterals<T>> {
  return Type.Union(values.map((v) => Type.Literal(v))) as unknown as TUnion<ToLiterals<T>>;
}
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const strict = { additionalProperties: false } as const;
const IsoTime = Type.String({ description: "ISO-8601 UTC" });
const LocalizedSchema = Type.Object({ ru: Type.String(), uz: Type.String() });

export const WEB_PROVIDERS = ["payme", "click", "uzum"] as const;
export const WebProviderSchema = Enum(WEB_PROVIDERS);
assertSame<Same<Static<typeof WebProviderSchema>, W.WebProvider>>();

export const WEB_LOGIN_ERRORS = ["auth_failed", "account_not_found", "not_allowed"] as const;
const WebLoginErrorSchema = Enum(WEB_LOGIN_ERRORS);
assertSame<Same<Static<typeof WebLoginErrorSchema>, W.WebLoginError>>();

export const BILLING_FEATURES = ["ai_lessons", "pair_lessons"] as const;
const FeatureSchema = Enum(BILLING_FEATURES);
assertSame<Same<Static<typeof FeatureSchema>, C.BillingFeature>>();
export const PRODUCT_KINDS = ["subscription", "til_pack"] as const;
const ProductKindSchema = Enum(PRODUCT_KINDS);
assertSame<Same<Static<typeof ProductKindSchema>, C.BillingProductKind>>();
export const ORDER_STATUSES = ["pending", "paid", "fulfilled", "expired", "cancelled", "refunded"] as const;
const OrderStatusSchema = Enum(ORDER_STATUSES);
assertSame<Same<Static<typeof OrderStatusSchema>, C.BillingOrderStatus>>();
export const SUBSCRIPTION_STATUSES = ["none", "trial", "active", "expired"] as const;
const SubscriptionStatusSchema = Enum(SUBSCRIPTION_STATUSES);
assertSame<Same<Static<typeof SubscriptionStatusSchema>, C.SubscriptionStatus>>();
export const REFUND_STATUSES = ["awaiting_provider", "completed", "failed"] as const;

// ---------------------------------------------------------------- /me

export const WebMeSchema = Type.Object({
  account: Type.Object({
    age_band: Nullable(Enum(["14-17", "18+"])),
    can_pay: Type.Boolean(),
    consent_required: Type.Boolean(),
  }),
  learners: Type.Array(Type.Object({ learner_id: Type.String(), kind: Enum(["self", "child"]), display: Type.String() })),
  csrf_token: Type.String(),
});
assertSame<Same<Static<typeof WebMeSchema>, W.WebMe>>();

// ---------------------------------------------------------------- каталог

export const WebPriceSchema = Type.Object({ tiyin: Type.Integer() });
assertSame<Same<Static<typeof WebPriceSchema>, W.WebPrice>>();

export const WebProductSchema = Type.Object({
  code: Type.String(),
  kind: ProductKindSchema,
  title: LocalizedSchema,
  description: Nullable(LocalizedSchema),
  days: Nullable(Type.Integer()),
  minutes: Nullable(Type.Integer()),
  features: Type.Array(FeatureSchema),
  til: Nullable(Type.Integer()),
  price: WebPriceSchema,
});
assertSame<Same<Static<typeof WebProductSchema>, W.WebProduct>>();

export const WebCatalogSchema = Type.Object({
  sales_enabled: Type.Boolean(),
  providers: Type.Array(WebProviderSchema),
  offer: Type.Object({ version: Type.String(), url: Type.String() }),
  products: Type.Array(WebProductSchema),
  payer_required: Type.Boolean(),
  can_pay: Type.Boolean(),
  consent_required: Type.Boolean(),
});
assertSame<Same<Static<typeof WebCatalogSchema>, W.WebCatalog>>();

// ---------------------------------------------------------------- подписка

export const WebSubscriptionSchema = Type.Object({
  status: SubscriptionStatusSchema,
  plan: Nullable(Type.Object({ code: Type.String(), title: LocalizedSchema })),
  period: Nullable(
    Type.Object({
      starts_at: IsoTime,
      ends_at: IsoTime,
      minutes_granted: Type.Integer(),
      minutes_spent: Type.Integer(),
      minutes_held: Type.Integer(),
      minutes_left: Type.Integer(),
      overage: Type.Integer(),
    }),
  ),
  next_period: Nullable(Type.Object({ days: Type.Integer(), minutes_granted: Type.Integer(), starts_at: Nullable(IsoTime) })),
  features: Type.Array(FeatureSchema),
  expiring: Type.Boolean(),
  minutes_exhausted: Type.Boolean(),
  payer_required: Type.Boolean(),
  can_pay: Type.Boolean(),
  sales_enabled: Type.Boolean(),
});
assertSame<Same<Static<typeof WebSubscriptionSchema>, W.WebSubscriptionView>>();

// ---------------------------------------------------------------- заказы

export const WebOrderSchema = Type.Object({
  order_no: Type.Integer(),
  status: OrderStatusSchema,
  product: Type.Object({ code: Type.String(), kind: ProductKindSchema, title: LocalizedSchema }),
  currency: Type.Literal("UZS"),
  amount_tiyin: Type.Integer(),
  provider: WebProviderSchema,
  checkout_url: Nullable(Type.String()),
  expires_at: IsoTime,
  created_at: IsoTime,
  paid_at: Nullable(IsoTime),
  receipt_url: Nullable(Type.String()),
  refund: Nullable(Type.Object({ status: Enum(REFUND_STATUSES), receipt_url: Nullable(Type.String()) })),
});
assertSame<Same<Static<typeof WebOrderSchema>, W.WebOrder>>();

export const WebOrderPageSchema = Type.Object({ items: Type.Array(WebOrderSchema), next_cursor: Nullable(Type.String()) });
assertSame<Same<Static<typeof WebOrderPageSchema>, W.Page<W.WebOrder>>>();

export const PRODUCT_CODE_PATTERN = "^[a-z0-9_]{2,40}$";

export const WebOrderRequestSchema = Type.Object(
  {
    product_code: Type.String({ pattern: PRODUCT_CODE_PATTERN }),
    provider: WebProviderSchema,
    start_mode: Type.Optional(Enum(["after_current", "now"])),
    confirm_forfeit: Type.Optional(Type.Boolean()),
    beneficiary_id: Type.Optional(Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" })),
    offer_version: Type.String({ minLength: 1, maxLength: 64 }),
  },
  strict,
);
assertSame<Same<Static<typeof WebOrderRequestSchema>, W.WebOrderRequest>>();

/** Номер заказа в пути: целое 1..10¹² (в пути — только номер заказа, без ПДн). */
export const OrderNoParamsSchema = Type.Object({ order_no: Type.String({ pattern: "^[1-9][0-9]{0,11}$" }) }, strict);
export const CursorQuerySchema = Type.Object({ cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) }, strict);
