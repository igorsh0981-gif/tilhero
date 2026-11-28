/**
 * «Деньги» (sprint 8, ADM-MONEY-01…05, ADM-USR-02/04, ADM-DASH-04, AT-83, AT-94…AT-99): pure helpers of the five
 * sections — «Тарифы и товары», «Заказы и платежи», «Корректировки», «Сверка», «Финансовый обзор» — and of the «Тариф»
 * tab of the learner card.
 *
 * Money is integers only (ADR-0001): sums — tiyin (1 sum = 100 tiyin), Telegram Stars — whole stars, AI costs —
 * micro-dollars (1 USD = 1 000 000). Nothing here multiplies or divides money with floats: the formatters split
 * integers, the form parses whole sums into tiyin by digits. Two channels never mix: the site (Payme, Click, Uzum) — sums,
 * the Mini App (and its renewals) — Stars.
 *
 * The catalog form mirrors the billing validator (INTERNAL_API §1.2) so the staff member sees the problem at the
 * field before «Проверить»; billing stays the authority (422 CATALOG_INVALID {errors: [{path, code}]}).
 */
import type {
  AdjustmentKind,
  AdjustmentRequest,
  AdjustmentStatus,
  AdminOrderCard,
  BillingAudience,
  BillingChannel,
  BillingCurrency,
  BillingPeriodStatus,
  BillingProvider,
  CatalogPayload,
  CatalogProduct,
  CatalogStatus,
  DegradationLevel,
  DegradationMode,
  LearnerTier,
  ProviderTxnState,
  ReconItemKind,
  RefundStatus,
} from "@tilhero/contracts/admin";
import type { BillingFeature, BillingOrderStatus, BillingProductKind, MinuteEntryKind, StarsMode, StarsSubscriptionStatus, SubscriptionStatus } from "@tilhero/contracts/bff";
import type { WebProvider } from "@tilhero/contracts/web";
import type { Tone } from "../../ui/kit";
import type { Issue } from "../game/model";

export type { Issue };

/* ---------------------------------------------------------------- codes */

export const MONEY_PAGES = ["tariffs", "payments", "adjustments", "reconciliation", "finance"] as const;
export const PROVIDERS: readonly BillingProvider[] = ["telegram_stars", "payme", "click", "uzum"];
export const WEB_PROVIDERS: readonly WebProvider[] = ["payme", "click", "uzum"];
export const CHANNELS: readonly BillingChannel[] = ["miniapp", "web", "renewal"];
export const ORDER_STATUSES: readonly BillingOrderStatus[] = ["pending", "paid", "fulfilled", "expired", "cancelled", "refunded"];
export const PRODUCT_KINDS: readonly BillingProductKind[] = ["subscription", "til_pack"];
export const FEATURES: readonly BillingFeature[] = ["ai_lessons", "pair_lessons"];
export const AUDIENCES: readonly BillingAudience[] = ["kids", "teens", "adults"];
export const STARS_MODES: readonly StarsMode[] = ["subscription", "one_time"];
export const REFUND_STATUSES: readonly RefundStatus[] = ["awaiting_provider", "completed", "failed"];
export const TXN_STATES: readonly ProviderTxnState[] = ["created", "performed", "cancelled", "refunded"];
export const ADJ_KINDS: readonly AdjustmentKind[] = ["minutes", "grant_period", "revoke_period"];
export const ADJ_STATUSES: readonly AdjustmentStatus[] = ["pending", "applied", "rejected", "expired", "cancelled"];
export const RECON_KINDS: readonly ReconItemKind[] = [
  "paid_not_fulfilled", "stale_created", "provider_mismatch", "duplicate_payment", "refund_without_request", "refund_stuck", "fiscal_missing",
  "tils_spent_on_refund", "paid_after_deletion", "payer_mismatch", "stars_unmatched", "stars_subscription_desync", "hold_expired", "balance_drift",
  "unmatched_settlement",
];
export const RECON_STATUSES = ["open", "resolved", "ignored"] as const;
export const PERIOD_STATUSES: readonly BillingPeriodStatus[] = ["scheduled", "active", "ended", "superseded", "revoked"];
export const SUB_STATUSES: readonly SubscriptionStatus[] = ["none", "trial", "active", "expired"];
export const STARS_SUB_STATUSES: readonly StarsSubscriptionStatus[] = ["active", "canceled", "failed", "refunded", "ended"];
export const ENTRY_KINDS: readonly MinuteEntryKind[] = ["grant", "debit", "expire", "revoke", "adjust"];
export const CATALOG_STATUSES: readonly CatalogStatus[] = ["draft", "active", "archived"];
export const DEG_LEVELS: readonly DegradationLevel[] = ["normal", "economy", "paid_only", "off"];
export const DEG_MODES: readonly DegradationMode[] = ["auto", "manual"];
export const DEG_REASONS = ["threshold", "manual", "emergency_stop", "month_reset"] as const;
export const REPORT_PERIODS = ["day", "week", "month"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];
export const TIERS: readonly LearnerTier[] = ["free", "paid"];
export const PERIOD_SOURCES = ["order", "trial", "grant"] as const;
export const CLOSE_REASONS = ["ended", "superseded", "refund", "staff", "deletion"] as const;
export const PAY_TABS = ["orders", "refunds"] as const;
export type PayTab = (typeof PAY_TABS)[number];
export const TARIFF_TABS = ["editor", "diff", "history"] as const;
export type TariffTab = (typeof TARIFF_TABS)[number];

export const ORDER_TONE: Record<BillingOrderStatus, Tone> = { pending: "info", paid: "warn", fulfilled: "good", expired: "neutral", cancelled: "neutral", refunded: "bad" };
export const REFUND_TONE: Record<RefundStatus, Tone> = { awaiting_provider: "warn", completed: "good", failed: "bad" };
export const TXN_TONE: Record<ProviderTxnState, Tone> = { created: "info", performed: "good", cancelled: "neutral", refunded: "bad" };
export const ADJ_TONE: Record<AdjustmentStatus, Tone> = { pending: "warn", applied: "good", rejected: "bad", expired: "neutral", cancelled: "neutral" };
export const RECON_TONE: Record<(typeof RECON_STATUSES)[number], Tone> = { open: "warn", resolved: "good", ignored: "neutral" };
export const PERIOD_TONE: Record<BillingPeriodStatus, Tone> = { scheduled: "info", active: "good", ended: "neutral", superseded: "neutral", revoked: "bad" };
export const SUB_TONE: Record<SubscriptionStatus, Tone> = { none: "neutral", trial: "info", active: "good", expired: "warn" };
export const STARS_SUB_TONE: Record<StarsSubscriptionStatus, Tone> = { active: "good", canceled: "warn", failed: "bad", refunded: "neutral", ended: "neutral" };
export const CATALOG_TONE: Record<CatalogStatus, Tone> = { draft: "info", active: "good", archived: "neutral" };
export const LEVEL_TONE: Record<DegradationLevel, Tone> = { normal: "good", economy: "info", paid_only: "warn", off: "bad" };

/** reason, comment, note of every command of «Деньги»: 10..500 (admin.ts) */
export const NOTE_MIN = 10;
export const NOTE_MAX = 500;
export const notePresent = (s: string) => s.trim().length >= NOTE_MIN && s.trim().length <= NOTE_MAX;

/* ---------------------------------------------------------------- integer money */

/** 1 sum = 100 tiyin */
export const TIYIN_PER_SUM = 100;
const group = (n: number, locale: string) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n);
const decimalSep = (locale: string) => (new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".");

/**
 * Tiyin → «49 000» (whole sums) or «49 000,05» (with tiyin): integer division and remainder — no float. The unit
 * («сум») is added by the caller's dictionary (money.sum).
 */
export function fmtTiyin(tiyin: number, locale: string): string {
  if (!Number.isSafeInteger(tiyin)) return "—";
  const neg = tiyin < 0;
  const abs = Math.abs(tiyin);
  const sums = Math.trunc(abs / TIYIN_PER_SUM);
  const rest = abs % TIYIN_PER_SUM;
  return `${neg ? "−" : ""}${group(sums, locale)}${rest ? `${decimalSep(locale)}${String(rest).padStart(2, "0")}` : ""}`;
}

/** Whole Stars with group separators («1 250»). */
export function fmtStars(stars: number, locale: string): string {
  if (!Number.isSafeInteger(stars)) return "—";
  return `${stars < 0 ? "−" : ""}${group(Math.abs(stars), locale)}`;
}

/**
 * Micro-dollars → «$3.25», «$0.001615»: whole dollars with groups, the fraction trimmed of trailing zeros (at least two
 * digits). Integer arithmetic only.
 */
export function fmtMicroUsd(micro: number, locale: string): string {
  if (!Number.isSafeInteger(micro)) return "—";
  const neg = micro < 0;
  const abs = Math.abs(micro);
  const dollars = Math.trunc(abs / 1_000_000);
  let frac = String(abs % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "−" : ""}$${group(dollars, locale)}${decimalSep(locale)}${frac}`;
}

/** «49 000», «49000», «49 000» (no-break space) → 4 900 000 tiyin; anything else (fraction, sign, letters) → null. */
export function parseSums(text: string): number | null {
  const s = text.replace(/[\s  ]/g, "");
  if (!/^\d{1,9}$/.test(s)) return null;
  return Number(s) * TIYIN_PER_SUM;
}

/** A non-negative integer typed by the staff member («300», «1 200») or null. */
export function parseCount(text: string, max = 1_000_000_000): number | null {
  const s = text.replace(/[\s  ]/g, "");
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n <= max ? n : null;
}

/** Signed integer («-20», «+30», «−5») or null. */
export function parseSigned(text: string): number | null {
  const s = text.replace(/[\s  ]/g, "").replace(/^−/, "-");
  if (!/^[+-]?\d{1,6}$/.test(s)) return null;
  return Number(s);
}

/** The currency of a channel: the site — sums, the Mini App and renewals — Stars. */
export const channelCurrency = (c: BillingChannel): BillingCurrency => (c === "web" ? "UZS" : "XTR");

/* ---------------------------------------------------------------- catalog form */

export interface LocForm {
  ru: string;
  uz: string;
}
export interface ProductForm {
  code: string;
  kind: BillingProductKind;
  status: "on_sale" | "hidden";
  sort: string;
  title: LocForm;
  description: LocForm;
  days: string;
  minutes: string;
  features: BillingFeature[];
  til: string;
  audiences: BillingAudience[];
  /** whole sums as typed; "" — not sold on the site */
  price_sums: string;
  providers: WebProvider[];
  /** whole Stars as typed; "" — not sold in the Mini App */
  price_stars: string;
  stars_mode: StarsMode;
  stars_title: LocForm;
  fiscal: { ikpu: string; package_code: string; units: string; vat_percent: string; receipt_title: string };
}
export interface CatalogForm {
  merchant_tin: string;
  offer_version: string;
  offer_url: string;
  trial: { enabled: boolean; days: string; minutes: string; features: BillingFeature[] };
  limits: Record<keyof CatalogPayload["limits"], string>;
  products: ProductForm[];
}

export const LIMIT_KEYS = ["min_start_minutes", "pair_min_minutes", "low_minutes_percent", "expiring_days", "order_ttl_minutes", "stars_order_ttl_minutes", "pending_orders_max", "hold_ttl_hours"] as const;
/** limits in their bounds (billing validator; order TTL longer than the 12 h of Payme) */
export const LIMIT_RANGES: Record<(typeof LIMIT_KEYS)[number], [number, number]> = {
  min_start_minutes: [1, 60],
  pair_min_minutes: [1, 120],
  low_minutes_percent: [1, 50],
  expiring_days: [1, 14],
  order_ttl_minutes: [60, 2880],
  stars_order_ttl_minutes: [10, 1440],
  pending_orders_max: [1, 20],
  hold_ttl_hours: [1, 168],
};
/** The title of a Telegram Stars invoice: 1..32 characters (Bot API createInvoiceLink). */
export const STARS_TITLE_MAX = 32;
/** A Stars subscription: only 30 days (subscription_period = 2592000) and ≤ 10 000 Stars (Bot API). */
export const STARS_SUB_DAYS = 30;
export const STARS_SUB_MAX = 10_000;
export const STARS_MAX = 100_000;
export const TIYIN_MAX = 100_000_000_000;

const str = (v: unknown) => (v == null ? "" : String(v));
const loc = (v: { ru: string; uz: string } | null | undefined): LocForm => ({ ru: v?.ru ?? "", uz: v?.uz ?? "" });

/** A payload of billing (possibly a draft not checked yet) → the form (numbers as typed text). */
export function catalogForm(p: Partial<CatalogPayload> | null | undefined): CatalogForm {
  const limits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, str(p?.limits?.[k])])) as CatalogForm["limits"];
  return {
    merchant_tin: p?.merchant?.tin ?? "",
    offer_version: p?.offer?.version ?? "",
    offer_url: p?.offer?.url ?? "",
    trial: { enabled: p?.trial?.enabled ?? false, days: str(p?.trial?.days), minutes: str(p?.trial?.minutes), features: [...(p?.trial?.features ?? [])] },
    limits,
    products: (Array.isArray(p?.products) ? p!.products : []).map(productForm),
  };
}

export function productForm(x: Partial<CatalogProduct>): ProductForm {
  return {
    code: x.code ?? "",
    kind: x.kind ?? "subscription",
    status: x.status ?? "hidden",
    sort: str(x.sort ?? 0),
    title: loc(x.title),
    description: loc(x.description),
    days: str(x.days),
    minutes: str(x.minutes),
    features: [...(x.features ?? [])],
    til: str(x.til),
    audiences: [...(x.audiences ?? [])],
    price_sums: x.price_tiyin == null ? "" : String(Math.trunc(x.price_tiyin / TIYIN_PER_SUM)),
    providers: [...(x.providers ?? [])],
    price_stars: x.price_stars == null ? "" : String(x.price_stars),
    stars_mode: x.stars_mode ?? (x.kind === "til_pack" ? "one_time" : "subscription"),
    stars_title: loc(x.stars_title),
    fiscal: { ikpu: x.fiscal?.ikpu ?? "", package_code: x.fiscal?.package_code ?? "", units: str(x.fiscal?.units), vat_percent: str(x.fiscal?.vat_percent), receipt_title: x.fiscal?.receipt_title ?? "" },
  };
}

export const newProduct = (kind: BillingProductKind): ProductForm =>
  productForm({ kind, status: "hidden", sort: 100, audiences: kind === "subscription" ? ["teens", "adults"] : ["kids", "teens", "adults"], features: kind === "subscription" ? ["ai_lessons", "pair_lessons"] : [], stars_mode: kind === "til_pack" ? "one_time" : "subscription", providers: [] });

const UZ_CYRILLIC = /[\u0400-\u04FF]/;

/**
 * The form → CatalogPayload and the problems by path (the paths of the billing validator: `products[0].price_stars`).
 * `errors` block the save (a number that is not a number) or the activation (out of bounds); `warnings` are shown
 * (fiscal requisites of a site product — mandatory in stage/prod, the billing validator decides).
 */
export function checkCatalog(f: CatalogForm): { payload: CatalogPayload | null; errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const num = (path: string, text: string, lo: number, hi: number, required = true): number | null => {
    if (!text.trim()) {
      if (required) errors.push({ path, code: "required" });
      return null;
    }
    const n = parseCount(text, Number.MAX_SAFE_INTEGER);
    if (n == null) {
      errors.push({ path, code: "not_integer" });
      return null;
    }
    if (n < lo || n > hi) errors.push({ path, code: "range" });
    return n;
  };
  const text = (path: string, v: string, lo: number, hi: number) => {
    const n = v.trim().length;
    if (n < lo) errors.push({ path, code: "required" });
    else if (n > hi) errors.push({ path, code: "too_long" });
  };
  if (f.merchant_tin.trim() && !/^(\d{9}|\d{14})$/.test(f.merchant_tin.trim())) errors.push({ path: "merchant.tin", code: "tin_format" });
  text("offer.version", f.offer_version, 1, 32);
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/i.test(f.offer_url.trim())) errors.push({ path: "offer.url", code: "https" });
  const trialDays = num("trial.days", f.trial.days, 1, 30);
  const trialMinutes = num("trial.minutes", f.trial.minutes, 1, 1000);
  if (f.trial.enabled && !f.trial.features.length) errors.push({ path: "trial.features", code: "required" });
  const limits = {} as CatalogPayload["limits"];
  for (const k of LIMIT_KEYS) limits[k] = num(`limits.${k}`, f.limits[k], LIMIT_RANGES[k][0], LIMIT_RANGES[k][1]) ?? 0;

  const codes = new Set<string>();
  const products: CatalogProduct[] = f.products.map((p, i) => {
    const at = (k: string) => `products[${i}].${k}`;
    const code = p.code.trim();
    if (!/^[a-z0-9_]{2,40}$/.test(code)) errors.push({ path: at("code"), code: "code_format" });
    else if (codes.has(code)) errors.push({ path: at("code"), code: "duplicate" });
    codes.add(code);
    for (const l of ["ru", "uz"] as const) {
      text(`${at("title")}.${l}`, p.title[l], 1, 60);
      if (p.description[l].trim().length > 300) errors.push({ path: `${at("description")}.${l}`, code: "too_long" });
    }
    if (UZ_CYRILLIC.test(p.title.uz)) warnings.push({ path: `${at("title")}.uz`, code: "uz_script" });
    const sort = parseSigned(p.sort) ?? 0;
    const priceTiyin = p.price_sums.trim() ? parseSums(p.price_sums) : null;
    if (p.price_sums.trim() && priceTiyin == null) errors.push({ path: at("price_tiyin"), code: "sums_format" });
    else if (priceTiyin != null && (priceTiyin < 100 || priceTiyin > TIYIN_MAX)) errors.push({ path: at("price_tiyin"), code: "range" });
    const priceStars = p.price_stars.trim() ? parseCount(p.price_stars, Number.MAX_SAFE_INTEGER) : null;
    if (p.price_stars.trim() && priceStars == null) errors.push({ path: at("price_stars"), code: "not_integer" });
    else if (priceStars != null && (priceStars < 1 || priceStars > STARS_MAX)) errors.push({ path: at("price_stars"), code: "range" });
    // (a price typed wrong has its own message — one mistake, one message)
    if (p.status === "on_sale" && !p.price_sums.trim() && !p.price_stars.trim()) errors.push({ path: at("price_tiyin"), code: "no_price" });
    if (priceTiyin != null && p.status === "on_sale" && !p.providers.length) warnings.push({ path: at("providers"), code: "no_providers" });
    if (priceStars != null || p.stars_title.ru.trim() || p.stars_title.uz.trim()) {
      for (const l of ["ru", "uz"] as const) text(`${at("stars_title")}.${l}`, p.stars_title[l], 1, STARS_TITLE_MAX);
    }
    if (!p.audiences.length) errors.push({ path: at("audiences"), code: "required" });
    let days: number | undefined;
    let minutes: number | undefined;
    let til: number | undefined;
    if (p.kind === "subscription") {
      days = num(at("days"), p.days, 1, 366) ?? undefined;
      minutes = num(at("minutes"), p.minutes, 1, 100_000) ?? undefined;
      if (!p.features.length) errors.push({ path: at("features"), code: "required" });
      if (p.stars_mode === "subscription") {
        if (days !== undefined && days !== STARS_SUB_DAYS) errors.push({ path: at("stars_mode"), code: "stars_sub_days" });
        if (priceStars != null && priceStars > STARS_SUB_MAX) errors.push({ path: at("price_stars"), code: "stars_sub_max" });
      }
    } else {
      til = num(at("til"), p.til, 1, 100_000) ?? undefined;
      if (p.stars_mode !== "one_time") errors.push({ path: at("stars_mode"), code: "til_one_time" });
    }
    // fiscal requisites of a site product: the format is checked when filled; missing ones — a warning (stage/prod: error of billing)
    const fz = p.fiscal;
    const fiscalFilled = Object.values(fz).some((v) => v.trim());
    if (fz.ikpu.trim() && !/^\d{1,17}$/.test(fz.ikpu.trim())) errors.push({ path: at("fiscal.ikpu"), code: "ikpu_format" });
    if (fz.package_code.trim() && !/^\d{1,20}$/.test(fz.package_code.trim())) errors.push({ path: at("fiscal.package_code"), code: "package_format" });
    const vat = fz.vat_percent.trim() ? parseCount(fz.vat_percent, 100) : null;
    if (fz.vat_percent.trim() && vat == null) errors.push({ path: at("fiscal.vat_percent"), code: "range" });
    const units = fz.units.trim() ? parseCount(fz.units) : null;
    if (fz.units.trim() && units == null) errors.push({ path: at("fiscal.units"), code: "not_integer" });
    if (fz.receipt_title.trim().length > 63) errors.push({ path: at("fiscal.receipt_title"), code: "too_long" });
    if (priceTiyin != null && p.status === "on_sale" && (!fz.ikpu.trim() || !fz.package_code.trim() || !fz.vat_percent.trim() || !fz.receipt_title.trim())) {
      warnings.push({ path: at("fiscal"), code: "fiscal_missing" });
    }
    const out: CatalogProduct = {
      code,
      kind: p.kind,
      status: p.status,
      sort,
      title: { ru: p.title.ru.trim(), uz: p.title.uz.trim() },
      ...(p.description.ru.trim() || p.description.uz.trim() ? { description: { ru: p.description.ru.trim(), uz: p.description.uz.trim() } } : {}),
      ...(p.kind === "subscription" ? { days, minutes, features: [...p.features] } : { til }),
      audiences: [...p.audiences],
      price_tiyin: priceTiyin,
      providers: [...p.providers],
      price_stars: priceStars,
      stars_mode: p.stars_mode,
      stars_title: p.stars_title.ru.trim() || p.stars_title.uz.trim() ? { ru: p.stars_title.ru.trim(), uz: p.stars_title.uz.trim() } : null,
      fiscal: fiscalFilled
        ? { ikpu: fz.ikpu.trim() || null, package_code: fz.package_code.trim() || null, units, vat_percent: vat, receipt_title: fz.receipt_title.trim() || null }
        : null,
    };
    return out;
  });
  if (!f.products.some((p) => p.kind === "subscription" && p.status === "on_sale")) errors.push({ path: "products", code: "no_subscription" });
  const payload: CatalogPayload = {
    merchant: { tin: f.merchant_tin.trim() || null },
    offer: { version: f.offer_version.trim(), url: f.offer_url.trim() },
    trial: { enabled: f.trial.enabled, days: trialDays ?? 0, minutes: trialMinutes ?? 0, features: [...f.trial.features] },
    limits,
    products,
  };
  // a value that is not a number never reaches billing: the save is blocked; bounds — billing answers 422 with paths
  const blocking = errors.filter((e) => e.code === "not_integer" || e.code === "sums_format");
  return { payload: blocking.length ? null : payload, errors, warnings };
}

/** Where a product is sold: the site (a price in sums and a provider), the Mini App (a price in Stars). */
export function salesOf(p: Pick<CatalogProduct, "price_tiyin" | "providers" | "price_stars" | "status">): { web: boolean; miniapp: boolean } {
  return { web: p.status === "on_sale" && p.price_tiyin != null && p.providers.length > 0, miniapp: p.status === "on_sale" && p.price_stars != null };
}

/** The draft can be activated: it exists, is saved and checked after the last change. */
export function activationGate(draft: { validated: boolean } | null, dirty: boolean, clientErrors: number): "no_draft" | "unsaved" | "invalid" | "not_validated" | null {
  if (!draft) return "no_draft";
  if (dirty) return "unsaved";
  if (clientErrors > 0) return "invalid";
  if (!draft.validated) return "not_validated";
  return null;
}

/** Problems of one path or under it (a product, a group of fields). */
export const issuesAt = (xs: readonly Issue[], path: string) => xs.filter((x) => x.path === path);
export const issuesUnder = (xs: readonly Issue[], prefix: string) => xs.filter((x) => x.path === prefix || x.path.startsWith(`${prefix}.`) || x.path.startsWith(`${prefix}[`));

/* ---------------------------------------------------------------- orders, refunds */

export interface OrderFilters {
  status: BillingOrderStatus | "";
  channel: BillingChannel | "";
  provider: BillingProvider | "";
  product_kind: BillingProductKind | "";
  order_no: string;
  provider_txn_id: string;
  account_id: string;
  from: string;
  to: string;
}
export const emptyOrderFilters = (): OrderFilters => ({ status: "", channel: "", provider: "", product_kind: "", order_no: "", provider_txn_id: "", account_id: "", from: "", to: "" });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s.trim());

/** Problems of the order filters (no request is sent while there are any). */
export function orderFiltersProblem(f: OrderFilters): "order_no" | "txn" | "account" | "to_before_from" | "channel_provider" | null {
  if (f.order_no.trim() && !/^[1-9]\d{0,11}$/.test(f.order_no.trim())) return "order_no";
  if (f.provider_txn_id.trim() && !/^[A-Za-z0-9._:-]{1,128}$/.test(f.provider_txn_id.trim())) return "txn";
  if (f.account_id.trim() && !isUuid(f.account_id)) return "account";
  if (f.from && f.to && f.to < f.from) return "to_before_from";
  // the site never takes Stars, the Mini App never takes Payme / Click / Uzum
  if (f.channel && f.provider && (f.channel === "web") === (f.provider === "telegram_stars")) return "channel_provider";
  return null;
}

/** The providers that can go with a channel filter. */
export const providersOf = (c: BillingChannel | ""): readonly BillingProvider[] => (c === "" ? PROVIDERS : c === "web" ? WEB_PROVIDERS : ["telegram_stars"]);

/**
 * How a refund goes (INTERNAL_API §1.12): Stars and Click — at once through their API (completed | failed); Payme and
 * Uzum — the staff member returns the money in the provider's cabinet, billing waits for the provider's cancellation.
 */
export const refundMethod = (p: BillingProvider): "api" | "cabinet" => (p === "telegram_stars" || p === "click" ? "api" : "cabinet");

/** Click refunds only a payment of the current month (on the 1st — the previous one too). */
export function clickWindowOpen(performedAt: string | null, now: number): boolean {
  if (!performedAt) return false;
  const p = new Date(performedAt);
  const n = new Date(now + 5 * 3_600_000);
  const pl = new Date(p.getTime() + 5 * 3_600_000);
  const sameMonth = pl.getUTCFullYear() === n.getUTCFullYear() && pl.getUTCMonth() === n.getUTCMonth();
  if (sameMonth) return true;
  const prev = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1));
  return n.getUTCDate() === 1 && pl.getUTCFullYear() === prev.getUTCFullYear() && pl.getUTCMonth() === prev.getUTCMonth();
}

/** The performed transaction of an order (the one a refund returns). */
export const performedTxn = (o: Pick<AdminOrderCard, "transactions">) => o.transactions.find((t) => t.state === "performed") ?? null;

/** The Idempotency-Key signature of a refund: the order and the body — never its status or version (lesson of sprint 7). */
export const refundSig = (orderId: string, reason: string, force: boolean) => JSON.stringify(["refund", orderId, reason, force]);

/* ---------------------------------------------------------------- adjustments («four eyes») */

export interface AdjustmentForm {
  kind: AdjustmentKind;
  minutes: string;
  days: string;
  period_id: string;
  reason: string;
}
export const emptyAdjustment = (periodId: string | null): AdjustmentForm => ({ kind: "minutes", minutes: "", days: "30", period_id: periodId ?? "", reason: "" });

/** The form → AdjustmentRequest by kind (admin.ts): minutes ±1..10 000 to a period; a grant — days 1..90 and minutes 1..10 000; a revocation — a period. */
export function adjustmentBody(f: AdjustmentForm, available: number | null): { body: AdjustmentRequest | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const reason = f.reason.trim();
  if (reason.length < NOTE_MIN) issues.push({ path: "reason", code: "reason_short" });
  else if (reason.length > NOTE_MAX) issues.push({ path: "reason", code: "reason_long" });
  if (f.kind === "minutes") {
    const m = parseSigned(f.minutes);
    if (m == null || m === 0 || Math.abs(m) > 10_000) issues.push({ path: "minutes", code: "minutes_range" });
    else if (m < 0 && available != null && -m > available) issues.push({ path: "minutes", code: "below_zero" });
    if (!isUuid(f.period_id)) issues.push({ path: "period_id", code: "period_required" });
    return issues.length ? { body: null, issues } : { body: { kind: "minutes", minutes: m!, period_id: f.period_id.toLowerCase(), reason }, issues };
  }
  if (f.kind === "grant_period") {
    const d = parseCount(f.days, 90);
    // billing adjustments._check: grant_period — days 1..90, minutes 1..10 000
    const m = parseCount(f.minutes, 10_000);
    if (d == null || d < 1) issues.push({ path: "days", code: "days_range" });
    if (m == null || m < 1) issues.push({ path: "minutes", code: "grant_minutes" });
    return issues.length ? { body: null, issues } : { body: { kind: "grant_period", days: d!, minutes: m!, reason }, issues };
  }
  if (!isUuid(f.period_id)) issues.push({ path: "period_id", code: "period_required" });
  return issues.length ? { body: null, issues } : { body: { kind: "revoke_period", period_id: f.period_id.toLowerCase(), reason }, issues };
}

/** The signature of a request («four eyes»): the account and the body — the same request after a lost answer, the same key. */
export const adjustmentSig = (accountId: string, body: AdjustmentRequest) => JSON.stringify(["adjust", accountId, body]);

/* ---------------------------------------------------------------- degradation of AI */

export interface DegradationForm {
  mode: DegradationMode;
  manual_level: DegradationLevel;
  economy: string;
  paid_only: string;
}

/** 1 ≤ economy ≤ paid_only ≤ 100; manual — with a level. */
export function degradationProblem(f: DegradationForm): "economy" | "paid_only" | "order" | null {
  const e = parseCount(f.economy, 100);
  const p = parseCount(f.paid_only, 100);
  if (e == null || e < 1) return "economy";
  if (p == null || p < 1) return "paid_only";
  if (e > p) return "order";
  return null;
}

/* ---------------------------------------------------------------- reconciliation */

/** A short line of the details of a reconciliation item (no PII: billing sends ids, amounts and dates only). */
export function detailsLine(d: Record<string, unknown>): string {
  return Object.entries(d)
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ")
    .slice(0, 300);
}
