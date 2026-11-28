/**
 * Кодеки ответов billing (`/internal/v1/me/billing/*`, канал `web`) → контракт сайта (web.ts). Строят объекты контракта
 * поле за полем (лишнее не проходит), проверяя форму и деньги:
 *  - цена и сумма — только целые тийины 100..10¹¹ (ADR-0001); товар без цены в сумах (например, только Stars) на сайт
 *    не попадает; способы оплаты — только payme / click / uzum;
 *  - заказ не сайта (Stars, другая валюта) в ответ сайта не попадает: список — пропуск, одиночный — 404 ORDER_NOT_FOUND;
 *  - ссылки (оплата, чек, оферта) — только https (иначе null) — на сайте нет перехода на javascript:/http-адрес.
 * Неожиданная форма ответа billing → BadUpstream (маршрут отвечает 503 BILLING_UNAVAILABLE).
 */
import type { Localized } from "@tilhero/contracts/content";
import type { BillingFeature, BillingOrderStatus, BillingProductKind, SubscriptionStatus } from "@tilhero/contracts/bff";
import type {
  Page,
  WebCatalog,
  WebOrder,
  WebProduct,
  WebProvider,
  WebSubscriptionView,
} from "@tilhero/contracts/web";
import { BILLING_FEATURES, ORDER_STATUSES, PRODUCT_KINDS, REFUND_STATUSES, SUBSCRIPTION_STATUSES, WEB_PROVIDERS } from "./schemas.js";

export class BadUpstream extends Error {
  constructor(public readonly field: string) {
    super(`billing: unexpected response (${field})`);
    this.name = "BadUpstream";
  }
}

/** Сумма в тийинах: целое 100..10¹¹ (1 сум .. 1 млрд сумов). */
export const MIN_TIYIN = 100;
export const MAX_TIYIN = 100_000_000_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function obj(v: unknown, field: string): Obj {
  if (!isObj(v)) throw new BadUpstream(field);
  return v;
}
function str(v: unknown, field: string): string {
  if (typeof v !== "string") throw new BadUpstream(field);
  return v;
}
function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new BadUpstream(field);
  return v;
}
function int(v: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new BadUpstream(field);
  return v;
}
function intOrNull(v: unknown, field: string, min = 0): number | null {
  return v === null || v === undefined ? null : int(v, field, min);
}
function strOrNull(v: unknown, field: string): string | null {
  return v === null || v === undefined ? null : str(v, field);
}
function oneOf<T extends string>(v: unknown, values: readonly T[], field: string): T {
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw new BadUpstream(field);
  return v as T;
}
function localized(v: unknown, field: string): Localized {
  const o = obj(v, field);
  return { ru: str(o.ru, `${field}.ru`), uz: str(o.uz, `${field}.uz`) };
}
function features(v: unknown, field: string): BillingFeature[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new BadUpstream(field);
  return v.filter((f): f is BillingFeature => (BILLING_FEATURES as readonly string[]).includes(f as string));
}

/** https-адрес (оплата провайдера, чек, оферта) или null. */
export function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 4096) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Цена сайта: целые тийины 100..10¹¹. Нет цены в сумах — null (товар не для сайта). */
function webPrice(v: unknown): { tiyin: number } | null {
  if (!isObj(v)) return null;
  const t = v.tiyin;
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < MIN_TIYIN || t > MAX_TIYIN) return null;
  return { tiyin: t };
}

export function webProduct(v: unknown): WebProduct | null {
  const p = obj(v, "products[]");
  const price = webPrice(p.price);
  if (!price) return null;
  return {
    code: str(p.code, "product.code"),
    kind: oneOf<BillingProductKind>(p.kind, PRODUCT_KINDS, "product.kind"),
    title: localized(p.title, "product.title"),
    description: p.description === null || p.description === undefined ? null : localized(p.description, "product.description"),
    days: intOrNull(p.days, "product.days", 1),
    minutes: intOrNull(p.minutes, "product.minutes"),
    features: features(p.features, "product.features"),
    til: intOrNull(p.til, "product.til", 1),
    price,
  };
}

export function webCatalog(v: unknown): WebCatalog {
  const c = obj(v, "catalog");
  const offer = obj(c.offer, "offer");
  const providers = Array.isArray(c.providers)
    ? c.providers.filter((p): p is WebProvider => (WEB_PROVIDERS as readonly string[]).includes(p as string))
    : [];
  if (!Array.isArray(c.products)) throw new BadUpstream("products");
  return {
    sales_enabled: bool(c.sales_enabled, "sales_enabled") && providers.length > 0,
    providers,
    offer: { version: str(offer.version, "offer.version"), url: httpsUrl(offer.url) ?? "" },
    products: c.products.map(webProduct).filter((p): p is WebProduct => p !== null),
    payer_required: bool(c.payer_required, "payer_required"),
    can_pay: bool(c.can_pay, "can_pay"),
    consent_required: bool(c.consent_required, "consent_required"),
  };
}

export function webSubscription(v: unknown): WebSubscriptionView {
  const s = obj(v, "subscription");
  const plan = s.plan === null || s.plan === undefined ? null : obj(s.plan, "plan");
  const period = s.period === null || s.period === undefined ? null : obj(s.period, "period");
  const next = s.next_period === null || s.next_period === undefined ? null : obj(s.next_period, "next_period");
  return {
    status: oneOf<SubscriptionStatus>(s.status, SUBSCRIPTION_STATUSES, "status"),
    plan: plan ? { code: str(plan.code, "plan.code"), title: localized(plan.title, "plan.title") } : null,
    period: period
      ? {
          starts_at: str(period.starts_at, "period.starts_at"),
          ends_at: str(period.ends_at, "period.ends_at"),
          minutes_granted: int(period.minutes_granted, "period.minutes_granted"),
          minutes_spent: int(period.minutes_spent, "period.minutes_spent"),
          minutes_held: int(period.minutes_held, "period.minutes_held"),
          minutes_left: int(period.minutes_left, "period.minutes_left"),
          overage: int(period.overage, "period.overage"),
        }
      : null,
    next_period: next
      ? {
          days: int(next.days, "next_period.days", 1),
          minutes_granted: int(next.minutes_granted, "next_period.minutes_granted"),
          starts_at: strOrNull(next.starts_at, "next_period.starts_at"),
        }
      : null,
    features: features(s.features, "features"),
    expiring: bool(s.expiring, "expiring"),
    minutes_exhausted: bool(s.minutes_exhausted ?? false, "minutes_exhausted"),
    payer_required: bool(s.payer_required, "payer_required"),
    can_pay: bool(s.can_pay, "can_pay"),
    sales_enabled: bool(s.sales_enabled, "sales_enabled"),
  };
}

/** Заказ сайта; заказ не сайта (не UZS, не payme/click/uzum, без суммы в тийинах) — null. */
export function webOrder(v: unknown): WebOrder | null {
  const o = obj(v, "order");
  if (o.currency !== "UZS" || !(WEB_PROVIDERS as readonly string[]).includes(o.provider as string)) return null;
  if (o.amount_stars !== undefined && o.amount_stars !== null) return null;
  const amount = o.amount_tiyin;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < MIN_TIYIN || amount > MAX_TIYIN) return null;
  const product = obj(o.product, "order.product");
  const refund = o.refund === null || o.refund === undefined ? null : obj(o.refund, "order.refund");
  const status = oneOf<BillingOrderStatus>(o.status, ORDER_STATUSES, "order.status");
  return {
    order_no: int(o.order_no, "order.order_no", 1),
    status,
    product: {
      code: str(product.code, "order.product.code"),
      kind: oneOf<BillingProductKind>(product.kind, PRODUCT_KINDS, "order.product.kind"),
      title: localized(product.title, "order.product.title"),
    },
    currency: "UZS",
    amount_tiyin: amount,
    provider: o.provider as WebProvider,
    // ссылка на оплату имеет смысл только у pending (контракт: после оплаты — null)
    checkout_url: status === "pending" ? httpsUrl(o.checkout_url) : null,
    expires_at: str(o.expires_at, "order.expires_at"),
    created_at: str(o.created_at, "order.created_at"),
    paid_at: strOrNull(o.paid_at, "order.paid_at"),
    receipt_url: httpsUrl(o.receipt_url),
    refund: refund
      ? { status: oneOf(refund.status, REFUND_STATUSES, "order.refund.status"), receipt_url: httpsUrl(refund.receipt_url) }
      : null,
  };
}

export function webOrderPage(v: unknown): Page<WebOrder> {
  const p = obj(v, "page");
  if (!Array.isArray(p.items)) throw new BadUpstream("page.items");
  return {
    items: p.items.map(webOrder).filter((o): o is WebOrder => o !== null),
    next_cursor: strOrNull(p.next_cursor, "page.next_cursor"),
  };
}
