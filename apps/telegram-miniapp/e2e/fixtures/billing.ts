import type {
  BillingCatalog,
  BillingOrderRequest,
  BillingProduct,
  MinuteEntry,
  StarsOrder,
  StarsSubscriptionStatus,
  SubscriptionRequiredReason,
  SubscriptionStatus,
  SubscriptionView,
} from "@tilhero/contracts/bff";
import type { Localized } from "@tilhero/contracts/content";

/**
 * Sprint 8 — the billing of the mock BFF (bff.ts «Спринт 8», channel miniapp): the catalogue for Telegram Stars only,
 * the subscription and the AI minutes, the trial, Stars orders and their invoices, the auto-renew of the Stars subscription,
 * the history of minutes. The fake Telegram (fixtures/telegram.ts) «pays» an invoice by POST /__bff/__e2e/invoice {link,
 * status}: the order becomes paid at the next read(s) (`settleAfterReads`), as after successful_payment.
 * Shapes follow the contract; the mock never answers anything but Stars (anti-steering).
 */
export interface BillingScenario {
  /** down — 503 BILLING_UNAVAILABLE on /v1/billing/* (learning works) */
  mode?: "ok" | "down";
  salesEnabled?: boolean;
  status?: SubscriptionStatus;
  trialUsed?: boolean;
  /** a Stars subscription of the account (with status active/trial) */
  stars?: { status: StarsSubscriptionStatus; auto_renew: boolean } | null;
  /** minutes left of the period (default: 285 of 300; the trial — 45 of 60) */
  minutesLeft?: number;
  /** a teen 14–17 without the parent's consent (the mock BFF sets it from the account too) */
  consentRequired?: boolean;
  /** seeded history: orders of the Mini App */
  orders?: Array<Partial<StarsOrder> & { order_no: number; status: StarsOrder["status"] }>;
  /** a paid invoice becomes paid in billing at this read of the order (default 2: the first poll still says pending) */
  settleAfterReads?: number;
  /** a til pack: paid → fulfilled (gamification credited) at this read after paid (default 1) */
  fulfilAfterReads?: number;
  /** POST /v1/billing/orders answers 503 STARS_UNAVAILABLE once (the order is pending, no link yet) */
  starsUnavailableOnce?: boolean;
  /** POST /v1/pair-rooms (lessons) answers 403 SUBSCRIPTION_REQUIRED {feature: pair_lessons, reason} */
  pairInvite?: SubscriptionRequiredReason | "billing_down";
  /** the offer version of the catalogue changes after the first order attempt (409 OFFER_VERSION_MISMATCH once) */
  offerChangesOnce?: boolean;
}

export interface BillingCtx {
  /** the active learner is a child profile */
  kid: boolean;
  /** the account may pay (18+, or 14–17 with the parent's consent) */
  canPay: boolean;
  consentRequired: boolean;
  /** learners of the account: own id first, then children (a til pack recipient) */
  account: string;
  children: Array<{ id: string; name: string }>;
}

export type BillingReply = { status: number; body?: unknown; code?: string; details?: Record<string, unknown> };

const L = (ru: string, uz: string): Localized => ({ ru, uz });
const DAY = 24 * 3600_000;
const FEATURES: BillingProduct["features"] = ["ai_lessons", "pair_lessons"];
export const OFFER = { version: "1.0", url: "https://miniapp.tilhero.test/legal/offer" };

export const PRODUCTS: BillingProduct[] = [
  { code: "plus_30d", kind: "subscription", title: L("TilHero Плюс — 30 дней", "TilHero Plus — 30 kun"), description: L("Уроки с ИИ и уроки вдвоём, 300 ИИ-минут в месяц", "SI bilan darslar va juftlikda darslar, oyiga 300 SI daqiqasi"), days: 30, minutes: 300, features: FEATURES, til: null, price: { stars: 250, mode: "subscription" } },
  { code: "plus_90d", kind: "subscription", title: L("TilHero Плюс — 90 дней", "TilHero Plus — 90 kun"), description: L("Три месяца разом, 900 ИИ-минут", "Uch oy birdaniga, 900 SI daqiqasi"), days: 90, minutes: 900, features: FEATURES, til: null, price: { stars: 650, mode: "one_time" } },
  { code: "til_100", kind: "til_pack", title: L("100 тилов", "100 til"), description: null, days: null, minutes: null, features: [], til: 100, price: { stars: 25, mode: "one_time" } },
  { code: "til_550", kind: "til_pack", title: L("550 тилов", "550 til"), description: null, days: null, minutes: null, features: [], til: 550, price: { stars: 120, mode: "one_time" } },
  { code: "til_1200", kind: "til_pack", title: L("1 200 тилов", "1 200 til"), description: null, days: null, minutes: null, features: [], til: 1200, price: { stars: 240, mode: "one_time" } },
];

interface Ord {
  view: StarsOrder;
  key: string;
  beneficiary: string;
  /** the invoice was paid in Telegram; reads of the order since */
  paidInTelegram: boolean;
  reads: number;
  fulfilReads: number;
}

export class MockBilling {
  readonly sc: BillingScenario;
  status: SubscriptionStatus;
  trialUsed: boolean;
  stars: { status: StarsSubscriptionStatus; auto_renew: boolean } | null;
  periodEnds = new Date(Date.now() + 28 * DAY).toISOString();
  minutesGranted: number;
  minutesLeft: number;
  readonly orders: Ord[] = [];
  readonly minuteLog: MinuteEntry[] = [];
  readonly tilCredits: Array<{ owner: string; til: number }> = [];
  private seq = 1000;
  private offerVersion = OFFER.version;
  private offerOnce: boolean;
  private starsOnce: boolean;

  constructor(sc: BillingScenario, private readonly credit: (owner: string, til: number) => void) {
    this.sc = sc;
    this.status = sc.status ?? "none";
    this.trialUsed = sc.trialUsed ?? this.status === "trial";
    this.stars = sc.stars ?? null;
    this.minutesGranted = this.status === "trial" ? 60 : 300;
    this.minutesLeft = sc.minutesLeft ?? (this.status === "trial" ? 45 : 285);
    this.offerOnce = !!sc.offerChangesOnce;
    this.starsOnce = !!sc.starsUnavailableOnce;
    for (const o of sc.orders ?? []) {
      const p = PRODUCTS.find((x) => x.code === (o.product?.code ?? "plus_30d"))!;
      this.orders.push({ view: { ...this.orderView(p, o.order_no, o.status), ...o, product: o.product ?? { code: p.code, kind: p.kind, title: p.title } }, key: `seed-${o.order_no}`, beneficiary: "", paidInTelegram: false, reads: 0, fulfilReads: 0 });
      this.seq = Math.max(this.seq, o.order_no);
    }
    if (this.status === "active" || this.status === "trial") {
      this.minuteLog.push(
        { at: new Date(Date.now() - 2 * DAY).toISOString(), kind: "grant", minutes: this.minutesGranted, ref_kind: this.status === "trial" ? "trial" : "order", learner: null, period_id: "p-1" },
        { at: new Date(Date.now() - DAY).toISOString(), kind: "debit", minutes: -12, ref_kind: "session", learner: "self", period_id: "p-1" },
        { at: new Date(Date.now() - 3600_000).toISOString(), kind: "debit", minutes: -3, ref_kind: "room", learner: "self", period_id: "p-1" },
      );
    }
  }

  get down(): boolean {
    return this.sc.mode === "down";
  }

  /** «Купить тилы» за Stars доступно (как telegram-bff): sales ∧ can pay ∧ a til pack with a Stars price; a child — false. */
  purchaseAvailable(ctx: BillingCtx): boolean {
    return !this.down && !ctx.kid && (this.sc.salesEnabled ?? true) && ctx.canPay && PRODUCTS.some((p) => p.kind === "til_pack");
  }

  private orderView(p: BillingProduct, no: number, status: StarsOrder["status"] = "pending"): StarsOrder {
    const now = Date.now();
    return {
      order_no: no,
      status,
      channel: "miniapp",
      product: { code: p.code, kind: p.kind, title: p.title },
      currency: "XTR",
      amount_stars: p.price.stars,
      provider: "telegram_stars",
      invoice_link: status === "pending" ? `https://t.me/$e2eInvoice${no}` : null,
      expires_at: new Date(now + 3600_000).toISOString(),
      created_at: new Date(now - (status === "pending" ? 0 : 3 * DAY)).toISOString(),
      paid_at: status === "pending" || status === "expired" || status === "cancelled" ? null : new Date(now - 3 * DAY).toISOString(),
      refund: null,
    };
  }

  private catalog(ctx: BillingCtx): BillingCatalog {
    const sales = this.sc.salesEnabled ?? true;
    if (ctx.kid) return { sales_enabled: sales, providers: [], offer: { version: this.offerVersion, url: OFFER.url }, trial: null, products: [], payer_required: true, can_pay: false, consent_required: false };
    return {
      sales_enabled: sales,
      providers: sales ? ["telegram_stars"] : [],
      offer: { version: this.offerVersion, url: OFFER.url },
      trial: { available: !this.trialUsed, days: 7, minutes: 60 },
      products: PRODUCTS,
      payer_required: false,
      can_pay: ctx.canPay,
      consent_required: ctx.consentRequired,
    };
  }

  subscription(ctx: BillingCtx): SubscriptionView {
    const on = this.status === "trial" || this.status === "active";
    const ends = this.periodEnds;
    return {
      status: this.status,
      plan: on ? { code: this.status === "trial" ? "trial" : "plus_30d", title: this.status === "trial" ? L("Пробный период", "Sinov davri") : L("TilHero Плюс", "TilHero Plus") } : null,
      period: on
        ? { starts_at: new Date(Date.now() - 2 * DAY).toISOString(), ends_at: ends, minutes_granted: this.minutesGranted, minutes_spent: this.minutesGranted - this.minutesLeft, minutes_held: 0, minutes_left: this.minutesLeft, overage: 0 }
        : this.status === "expired"
          ? { starts_at: new Date(Date.now() - 32 * DAY).toISOString(), ends_at: new Date(Date.now() - 2 * DAY).toISOString(), minutes_granted: 300, minutes_spent: 300, minutes_held: 0, minutes_left: 0, overage: 0 }
          : null,
      next_period: null,
      features: on ? FEATURES : [],
      expiring: false,
      minutes_exhausted: on && this.minutesLeft === 0,
      payer_required: ctx.kid,
      can_pay: !ctx.kid && ctx.canPay,
      trial_available: !ctx.kid && !this.trialUsed && this.status !== "active",
      sales_enabled: this.sc.salesEnabled ?? true,
      stars_subscription: !ctx.kid && this.stars ? { ...this.stars, expires_at: ends, amount_stars: 250 } : null,
    };
  }

  /** The fake Telegram paid / cancelled the invoice. */
  invoice(link: string, status: string): void {
    const o = this.orders.find((x) => x.view.invoice_link === link);
    if (o && status === "paid") o.paidInTelegram = true;
  }

  private read(o: Ord): StarsOrder {
    if (o.paidInTelegram && o.view.status === "pending") {
      o.reads += 1;
      if (o.reads >= (this.sc.settleAfterReads ?? 2)) this.settle(o);
    } else if (o.view.status === "paid") {
      o.fulfilReads += 1;
      if (o.fulfilReads >= (this.sc.fulfilAfterReads ?? 1)) {
        o.view = { ...o.view, status: "fulfilled" };
        const p = PRODUCTS.find((x) => x.code === o.view.product.code)!;
        this.credit(o.beneficiary, p.til ?? 0);
        this.tilCredits.push({ owner: o.beneficiary, til: p.til ?? 0 });
      }
    }
    return o.view;
  }

  private settle(o: Ord): void {
    const p = PRODUCTS.find((x) => x.code === o.view.product.code)!;
    const paidAt = new Date().toISOString();
    if (p.kind === "til_pack") {
      o.view = { ...o.view, status: "paid", invoice_link: null, paid_at: paidAt };
      return;
    }
    o.view = { ...o.view, status: "fulfilled", invoice_link: null, paid_at: paidAt };
    this.status = "active";
    this.minutesGranted = p.minutes ?? 300;
    this.minutesLeft = this.minutesGranted;
    this.periodEnds = new Date(Date.now() + (p.days ?? 30) * DAY).toISOString();
    if (p.price.mode === "subscription") this.stars = { status: "active", auto_renew: true };
    this.minuteLog.unshift({ at: paidAt, kind: "grant", minutes: this.minutesGranted, ref_kind: "order", learner: null, period_id: "p-2" });
  }

  handle(method: string, path: string, b: Record<string, unknown>, headers: Record<string, string>, ctx: BillingCtx): BillingReply | null {
    if (!path.startsWith("/v1/billing/")) return null;
    if (this.down) return { status: 503, code: "BILLING_UNAVAILABLE", details: { service: "billing" } };
    const key = `${method} ${path}`;
    const payerOnly = (): BillingReply | null => (ctx.kid ? { status: 403, code: "PAYER_REQUIRED" } : null);
    if (key === "GET /v1/billing/catalog") return { status: 200, body: this.catalog(ctx) };
    if (key === "GET /v1/billing/subscription") return { status: 200, body: this.subscription(ctx) };
    if (key === "GET /v1/billing/minutes") return { status: 200, body: { items: this.minuteLog, next_cursor: null } };
    if (key === "GET /v1/billing/orders") return payerOnly() ?? { status: 200, body: { items: [...this.orders].reverse().map((o) => o.view), next_cursor: null } };
    let m = /^\/v1\/billing\/orders\/(\d+)$/.exec(path);
    if (m && method === "GET") {
      const no = payerOnly();
      if (no) return no;
      const o = this.orders.find((x) => x.view.order_no === Number(m![1]));
      return o ? { status: 200, body: this.read(o) } : { status: 404, code: "ORDER_NOT_FOUND" };
    }
    m = /^\/v1\/billing\/orders\/(\d+)\/cancel$/.exec(path);
    if (m && method === "POST") {
      const no = payerOnly();
      if (no) return no;
      const o = this.orders.find((x) => x.view.order_no === Number(m![1]));
      if (!o) return { status: 404, code: "ORDER_NOT_FOUND" };
      if (o.view.status !== "pending") return { status: 409, code: "ORDER_STATE", details: { status: o.view.status } };
      o.view = { ...o.view, status: "cancelled", invoice_link: null };
      return { status: 200, body: o.view };
    }
    if (key === "POST /v1/billing/trial") {
      const no = payerOnly();
      if (no) return no;
      if (!ctx.canPay) return { status: 403, code: "GUARDIAN_CONSENT_REQUIRED" };
      if (this.trialUsed) return { status: 409, code: "TRIAL_USED" };
      this.trialUsed = true;
      this.status = "trial";
      this.minutesGranted = 60;
      this.minutesLeft = 60;
      this.periodEnds = new Date(Date.now() + 7 * DAY).toISOString();
      this.minuteLog.unshift({ at: new Date().toISOString(), kind: "grant", minutes: 60, ref_kind: "trial", learner: null, period_id: "p-trial" });
      return { status: 201, body: this.subscription(ctx) };
    }
    if (key === "POST /v1/billing/orders") {
      const no = payerOnly();
      if (no) return no;
      const idem = headers["idempotency-key"];
      if (!idem) return { status: 422, code: "IDEMPOTENCY_KEY_REQUIRED" };
      const body = b as unknown as BillingOrderRequest;
      if (body.provider !== "telegram_stars") return { status: 422, code: "VALIDATION_ERROR", details: { field: "provider" } };
      if (!(this.sc.salesEnabled ?? true)) return { status: 409, code: "PAYMENTS_DISABLED" };
      if (!ctx.canPay) return { status: 403, code: "GUARDIAN_CONSENT_REQUIRED" };
      const p = PRODUCTS.find((x) => x.code === body.product_code);
      if (!p) return { status: 404, code: "PRODUCT_NOT_FOUND" };
      if (this.offerOnce) {
        this.offerOnce = false;
        this.offerVersion = "1.1";
        return { status: 409, code: "OFFER_VERSION_MISMATCH", details: { current: this.offerVersion } };
      }
      if (body.offer_version !== this.offerVersion) return { status: 409, code: "OFFER_VERSION_MISMATCH", details: { current: this.offerVersion } };
      const dup = this.orders.find((o) => o.key === idem);
      if (dup) return { status: 200, body: dup.view };
      if (p.price.mode === "subscription") {
        if (this.stars && (this.stars.status === "active" || this.stars.status === "canceled")) return { status: 409, code: "STARS_SUBSCRIPTION_EXISTS" };
        if (this.status === "active") return { status: 409, code: "ACTIVE_PERIOD_EXISTS", details: { ends_at: this.periodEnds } };
        if (this.status === "trial" && !body.confirm_forfeit) return { status: 409, code: "FORFEIT_CONFIRMATION_REQUIRED", details: { minutes_left: this.minutesLeft, days_left: 5 } };
      }
      if (p.kind === "til_pack" && body.beneficiary_id && !ctx.children.some((c) => c.id === body.beneficiary_id)) return { status: 403, code: "BENEFICIARY_NOT_ALLOWED" };
      const o: Ord = { view: this.orderView(p, ++this.seq), key: idem, beneficiary: body.beneficiary_id ?? ctx.account, paidInTelegram: false, reads: 0, fulfilReads: 0 };
      this.orders.push(o);
      if (this.starsOnce) {
        this.starsOnce = false;
        o.view = { ...o.view, invoice_link: null };
        const link = `https://t.me/$e2eInvoice${o.view.order_no}`;
        // the link is there at the next read of the order (billing asked Telegram again)
        setTimeout(() => (o.view = { ...o.view, invoice_link: link }), 0);
        return { status: 503, code: "STARS_UNAVAILABLE" };
      }
      return { status: 201, body: o.view };
    }
    if (key === "POST /v1/billing/stars-subscription") {
      const no = payerOnly();
      if (no) return no;
      if (!this.stars) return { status: 404, code: "STARS_SUBSCRIPTION_NOT_FOUND" };
      const on = b.auto_renew === true;
      this.stars = { status: on ? "active" : "canceled", auto_renew: on };
      return { status: 200, body: this.subscription(ctx) };
    }
    return { status: 404, code: "NOT_FOUND" };
  }
}
