import type {
  AiLockReason,
  BillingCatalog,
  BillingOrderRequest,
  BillingProduct,
  StarsOrder,
  StarsSubscriptionView,
  SubscriptionRequiredReason,
  SubscriptionView,
} from "@tilhero/contracts/bff";
import { ApiError } from "../api/errors";

/**
 * Sprint 8 — the subscription and purchases for Telegram Stars in the Mini App (APP-BILL-01…04, APP-LESS-01, APP-SOC-03):
 * pure logic of the screens. Prices are whole Stars from the server catalogue only — the client never computes or sends a
 * sum (the order carries the product code; the price is the server's). There is no other way to pay in the Mini App and
 * the client knows of none (anti-steering, owner decision В1).
 */

/* ---------------------------------------------------------------- Stars */

/** «⭐ 300», «⭐ 1 200» — whole Stars, groups by a no-break space (the same in RU and UZ). */
export function starsText(n: number): string {
  const v = Math.max(0, Math.floor(n));
  return `⭐ ${String(v).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0")}`;
}

/* ---------------------------------------------------------------- the subscription */

/** A Stars subscription still gives a period (renewing, or switched off but paid until `expires_at`). */
export function starsLive(s: StarsSubscriptionView | null | undefined, now = Date.now()): boolean {
  if (!s) return false;
  if (s.status !== "active" && s.status !== "canceled" && s.status !== "failed") return false;
  const t = Date.parse(s.expires_at);
  return Number.isFinite(t) && t > now;
}

/** The auto-renew switch is shown only for a Stars subscription that can still renew or be renewed again. */
export function canToggleAutoRenew(s: StarsSubscriptionView | null | undefined, now = Date.now()): boolean {
  return !!s && (s.status === "active" || s.status === "canceled") && starsLive(s, now);
}

/** 0..100 of the minutes left (the bar of the counter); no period — 0. */
export function minutesLeftPct(v: Pick<SubscriptionView, "period">): number {
  const p = v.period;
  if (!p || p.minutes_granted <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((p.minutes_left / p.minutes_granted) * 100)));
}

/** The subscription gives AI now (a trial or a paid / granted period). */
export const hasAccess = (v: Pick<SubscriptionView, "status">): boolean => v.status === "trial" || v.status === "active";

/** Whole days left until `iso` (rounded up, ≥ 0). */
export function daysLeft(iso: string, now = Date.now()): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 86_400_000));
}

/* ---------------------------------------------------------------- the purchase */

export type StartMode = "after_current" | "now";

/** What the purchase sheet asks before the payment, for this product and this subscription. */
export interface PurchasePlan {
  /** the product cannot be bought now (the server would answer 409): why and until when */
  blocked: null | { reason: "stars_exists" | "active_period"; until: string | null };
  /** a one-off period while another one is running: when to start it (after_current — default) */
  startModes: StartMode[] | null;
  /** buying ends the trial at once: its minutes and days are lost — a confirmation is needed (confirm_forfeit) */
  forfeitsTrial: boolean;
}

export function purchasePlan(p: BillingProduct, v: SubscriptionView | null, now = Date.now()): PurchasePlan {
  const none: PurchasePlan = { blocked: null, startModes: null, forfeitsTrial: false };
  if (p.kind !== "subscription" || !v) return none;
  const endsAt = v.period?.ends_at ?? null;
  if (p.price.mode === "subscription") {
    // a native Stars subscription starts at the payment (decision 5): not over a live one, not over a paid period
    if (starsLive(v.stars_subscription, now)) return { ...none, blocked: { reason: "stars_exists", until: v.stars_subscription!.expires_at } };
    if (v.status === "active") return { ...none, blocked: { reason: "active_period", until: endsAt } };
    return { ...none, forfeitsTrial: v.status === "trial" };
  }
  // one-off period («Плюс 90 дней»): after the current one by default, or now — its rest is lost (confirmation)
  if (hasAccess(v)) return { ...none, startModes: ["after_current", "now"] };
  return none;
}

export interface PurchaseChoice {
  startMode: StartMode | null;
  /** the learner confirmed that the rest of the trial / the current period is lost */
  forfeit: boolean;
  /** recipient of a til pack: a child profile of the account; null — myself */
  beneficiaryId: string | null;
}

/** The body of POST /v1/billing/orders — the product, Stars, the offer version; never a sum. */
export function orderBody(p: BillingProduct, offerVersion: string, plan: PurchasePlan, c: PurchaseChoice): BillingOrderRequest {
  const body: BillingOrderRequest = { product_code: p.code, provider: "telegram_stars", offer_version: offerVersion };
  if (p.kind === "til_pack") return c.beneficiaryId ? { ...body, beneficiary_id: c.beneficiaryId } : body;
  if (p.price.mode === "subscription") return plan.forfeitsTrial || c.forfeit ? { ...body, confirm_forfeit: true } : body;
  // one-off: start_mode is required; with nothing running «now» and «after the current» are the same
  const mode: StartMode = plan.startModes ? (c.startMode ?? "after_current") : "now";
  return mode === "now" && plan.startModes ? { ...body, start_mode: mode, confirm_forfeit: true } : { ...body, start_mode: mode };
}

/** The purchase can be sent: the offer is accepted and, where the rest is lost, that is confirmed. */
export function canSubmit(plan: PurchasePlan, c: PurchaseChoice, offerAccepted: boolean): boolean {
  if (!offerAccepted || plan.blocked) return false;
  if (plan.forfeitsTrial && !c.forfeit) return false;
  if (plan.startModes && c.startMode === "now" && !c.forfeit) return false;
  return true;
}

/** Products of the catalogue for the screen: subscriptions and til packs, in the server's order. */
export const subscriptionsOf = (c: BillingCatalog): BillingProduct[] => c.products.filter((p) => p.kind === "subscription");
export const tilPacksOf = (c: BillingCatalog): BillingProduct[] => c.products.filter((p) => p.kind === "til_pack");

/** The profile may pay now (owner of the account, 18+ or 14–17 with the parent's consent) and sales are on. */
export const canBuy = (c: Pick<BillingCatalog, "sales_enabled" | "can_pay" | "payer_required">): boolean => c.sales_enabled && c.can_pay && !c.payer_required;

/* ---------------------------------------------------------------- after the invoice: the poll of the order */

/** A paid order is done: a subscription — fulfilled (the period is there); tils — paid (credited a moment later) or fulfilled. */
export function orderSettled(o: Pick<StarsOrder, "status">): boolean {
  return o.status === "paid" || o.status === "fulfilled";
}
/** The order can no longer be paid. */
export function orderClosed(o: Pick<StarsOrder, "status">): boolean {
  return o.status === "expired" || o.status === "cancelled" || o.status === "refunded";
}

/** Poll timing: right away, then every 1.5–3 s, at most 60 s in all (contract: «опрос заказа до 60 с»). */
export const POLL_LIMIT_MS = 60_000;
/** A til pack is paid — the tils come with the confirmation of gamification (paid → fulfilled): a short follow-up poll. */
export const CREDIT_POLL_MS = 15_000;
const POLL_STEPS_MS = [0, 1000, 1500, 2000, 2000, 2500, 3000];

export interface PollDeps {
  read: () => Promise<StarsOrder>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** the screen went away — stop */
  signal?: AbortSignal;
}

export type PollResult = { kind: "settled" | "closed" | "pending"; order: StarsOrder } | { kind: "timeout"; order: StarsOrder | null } | { kind: "aborted" };

/**
 * Polls the order until it is paid (or fulfilled) or closed, for at most `limitMs`. `untilSettled = false` — one check
 * only (the invoice was cancelled or failed: the payment may still have gone through, the billing knows). A lost poll is
 * retried by the next one; the last order seen comes back on timeout.
 */
export async function pollOrder(d: PollDeps, opts: { limitMs?: number; untilSettled?: boolean; done?: (o: StarsOrder) => boolean } = {}): Promise<PollResult> {
  const done = opts.done ?? orderSettled;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  const limit = opts.limitMs ?? POLL_LIMIT_MS;
  const start = now();
  let last: StarsOrder | null = null;
  for (let i = 0; ; i++) {
    const wait = POLL_STEPS_MS[Math.min(i, POLL_STEPS_MS.length - 1)]!;
    if (i > 0 && now() - start + wait > limit) return { kind: "timeout", order: last };
    if (wait) await sleep(wait);
    if (d.signal?.aborted) return { kind: "aborted" };
    try {
      last = await d.read();
    } catch {
      if (opts.untilSettled === false) return { kind: "timeout", order: last };
      continue;
    }
    if (d.signal?.aborted) return { kind: "aborted" };
    if (done(last)) return { kind: "settled", order: last };
    if (orderClosed(last)) return { kind: "closed", order: last };
    if (opts.untilSettled === false) return { kind: "pending", order: last };
  }
}

/* ---------------------------------------------------------------- errors of the purchase */

export type PurchaseProblem =
  | { kind: "forfeit"; minutesLeft: number | null; daysLeft: number | null }
  | { kind: "offer"; current: string | null }
  | { kind: "active"; until: string | null }
  | { kind: "starsExists" }
  | { kind: "salesOff" }
  | { kind: "consent" }
  | { kind: "gone" }
  | { kind: "starsRetry" }
  | { kind: "tooMany" }
  | { kind: "other" };

const nonNeg = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** 409 / 403 / 503 of POST /v1/billing/orders → what the sheet does next. */
export function purchaseProblem(e: unknown): PurchaseProblem {
  if (!(e instanceof ApiError)) return { kind: "other" };
  switch (e.code) {
    case "FORFEIT_CONFIRMATION_REQUIRED":
      return { kind: "forfeit", minutesLeft: nonNeg(e.details.minutes_left), daysLeft: nonNeg(e.details.days_left) };
    case "OFFER_VERSION_MISMATCH":
      return { kind: "offer", current: typeof e.details.current === "string" ? e.details.current : null };
    case "ACTIVE_PERIOD_EXISTS":
      return { kind: "active", until: typeof e.details.ends_at === "string" ? e.details.ends_at : null };
    case "STARS_SUBSCRIPTION_EXISTS":
      return { kind: "starsExists" };
    case "PAYMENTS_DISABLED":
    case "PROVIDER_NOT_AVAILABLE":
    case "BILLING_UNAVAILABLE":
      return { kind: "salesOff" };
    case "GUARDIAN_CONSENT_REQUIRED":
    case "PAYER_REQUIRED":
      return { kind: "consent" };
    case "PRODUCT_NOT_AVAILABLE":
    case "PRODUCT_NOT_FOUND":
      return { kind: "gone" };
    case "STARS_UNAVAILABLE":
      return { kind: "starsRetry" };
    case "ORDERS_LIMIT":
      return { kind: "tooMany" };
    default:
      return { kind: "other" };
  }
}

/** A failure whose outcome is unknown (network, 5xx, STARS_UNAVAILABLE): keep the Idempotency-Key — a retry gets the same
 *  order, never a second one. */
export function keepOrderKey(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return e.status === 0 || e.code === "STARS_UNAVAILABLE" || (e.status >= 500 && e.code !== "BILLING_UNAVAILABLE");
}

/* ---------------------------------------------------------------- AI locked by the plan, the pair lesson */

/** The plaque of a lesson that goes with ready replies because of the plan (not a failure of the AI). */
export function lockKey(r: AiLockReason): `bill.lock.${AiLockReason}` {
  return `bill.lock.${r}`;
}
/** «О подписке» under the plaque: only where a subscription would change it (not «billing unavailable»). */
export const lockLeadsToPlans = (r: AiLockReason): boolean => r !== "billing_unavailable";

/** 403 SUBSCRIPTION_REQUIRED {feature, reason} of POST /v1/pair-rooms → the reason (unknown — no_subscription). */
export function subscriptionRequired(e: unknown): SubscriptionRequiredReason | null {
  if (!(e instanceof ApiError) || e.code !== "SUBSCRIPTION_REQUIRED") return null;
  const r = e.details.reason;
  return r === "feature_not_in_plan" || r === "minutes_exhausted" || r === "kids" ? r : "no_subscription";
}
