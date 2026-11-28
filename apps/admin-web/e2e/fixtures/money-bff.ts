/**
 * Sprint 8 part of the mock admin-bff («Деньги», admin.ts «Деньги» + ai.ts degradation and unit costs):
 * - `/billing/catalog*` — versions; the draft with If-Match (409 DRAFT_CONFLICT), the check (a subset of the billing
 *   validator: paths and codes), the activation and the rollback with step-up (409 CATALOG_NOT_VALIDATED, CATALOG_STATE),
 *   `/billing/trials:grant-all` with step-up;
 * - `/billing/orders*`, `/billing/refunds*` — filters (channel ↔ provider), the order card, the refund with step-up and
 *   a required Idempotency-Key: Stars and Click at once, Payme and Uzum — awaiting the provider with an instruction;
 *   the Click window (409 REFUND_NOT_ALLOWED provider_window), spent tils (409 … tils_spent → `force`);
 * - `/learners/{id}/billing`, `/billing/accounts/{id}/ledger` — the «Тариф» tab (a child — the guardian's account);
 * - `/billing/accounts/{id}/adjustments`, `/billing/adjustments*` — «four eyes»: the author never decides (409
 *   SELF_APPROVAL), `can_decide` / `can_cancel` for the staff member of the session, the approval applies the minutes;
 * - `/billing/reconciliation/*`, `/billing/reports/*`, `/billing/fx`, `/billing/star-rate`, `/billing/providers` (only
 *   «enabled / configured», never a key), `/finance/overview`;
 * - `/ai/degradation` (PUT — costs.manage + step-up), `/ai/unit-costs`.
 * Every command checks the reason (10..500), is audited and answers a repeated Idempotency-Key with the stored answer.
 */
import type {
  AdminBillingAccount,
  AdminLearnerRow,
  AdminOrderCard,
  AdminRefund,
  Adjustment,
  AiDegradationView,
  BillingSummary,
  CatalogPayload,
  CatalogVersion,
  FinanceOverview,
  FxRate,
  MoneyStats,
  Permission,
  ReconItem,
  StaffRef,
  StarRate,
} from "@tilhero/contracts/admin";
import type { AiUnitCosts, DegradationLevel } from "@tilhero/contracts/ai";
import type { Ctx } from "./content-bff";
import { DAY, HOUR, iso } from "./data";
import * as D from "./money-data";

type P = Record<string, unknown>;

export interface MoneyScenario {
  /** billing did not answer: every /billing/* and /finance/overview → 503 UPSTREAM_UNAVAILABLE {service: billing} */
  billingDown?: boolean;
  /** start with a draft v3 (from v2, not checked) */
  draft?: boolean;
  /** another staff member saves the draft right after it is read: the next PUT gets 409 DRAFT_CONFLICT */
  draftConflictOnce?: boolean;
  /** the first refund is made, but its answer is lost (502): the outcome is unknown to the client */
  refundLostOnce?: boolean;
  /** no Star rate: the estimate in sums and the margin with Stars are not computed */
  noStarRate?: boolean;
  /** the share of the AI monthly cap spent (degradation) */
  aiSpentPercent?: number;
  /** billing without TRIAL_ON_ENFORCEMENT: the trial grant to everyone → 409 TRIAL_GRANT_DISABLED */
  trialGrantOff?: boolean;
}

const REASON = (s: unknown) => typeof s === "string" && s.trim().length >= 10 && s.trim().length <= 500;
const UUID = "[0-9a-f-]{36}";
const TZ = 5 * HOUR;

/** the start of the Tashkent day / week (7 calendar days) / month of `now` (UTC instants) */
function rangeOf(period: "day" | "week" | "month", now = Date.now()): { from: number; to: number } {
  const l = new Date(now + TZ);
  const midnight = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) - TZ;
  const from = period === "day" ? midnight : period === "week" ? midnight - 6 * DAY : Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), 1) - TZ;
  return { from, to: now };
}

function diffValues(a: unknown, b: unknown, path = ""): Array<{ path: string; from: unknown; to: unknown }> {
  if (a && b && typeof a === "object" && typeof b === "object") {
    const arr = Array.isArray(a) || Array.isArray(b);
    const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])];
    return keys.flatMap((k) => diffValues((a as P)[k], (b as P)[k], arr ? `${path}[${k}]` : path ? `${path}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, from: a ?? null, to: b ?? null }];
}

/** a subset of the billing validator (INTERNAL_API §1.10): the same paths and codes the editor knows */
function validate(p: CatalogPayload): { errors: Array<{ path: string; code: string }>; warnings: Array<{ path: string; code: string }> } {
  const errors: Array<{ path: string; code: string }> = [];
  const warnings: Array<{ path: string; code: string }> = [];
  const range = (path: string, v: unknown, lo: number, hi: number) => {
    if (typeof v !== "number" || !Number.isInteger(v)) errors.push({ path, code: "not_integer" });
    else if (v < lo || v > hi) errors.push({ path, code: "range" });
  };
  if (!/^https:\/\//.test(p.offer?.url ?? "")) errors.push({ path: "offer.url", code: "https_required" });
  else if (/\/\/pay\./.test(p.offer?.url ?? "")) errors.push({ path: "offer.url", code: "not_on_web_pay" });
  range("trial.days", p.trial?.days, 1, 30);
  range("trial.minutes", p.trial?.minutes, 1, 1000);
  range("limits.order_ttl_minutes", p.limits?.order_ttl_minutes, 60, 2880);
  range("limits.stars_order_ttl_minutes", p.limits?.stars_order_ttl_minutes, 10, 1440);
  const codes = new Set<string>();
  (p.products ?? []).forEach((x, i) => {
    const at = (k: string) => `products[${i}].${k}`;
    if (codes.has(x.code)) errors.push({ path: at("code"), code: "duplicate" });
    codes.add(x.code);
    if (x.price_tiyin != null && (x.price_tiyin < 100 || x.price_tiyin > 1e11)) errors.push({ path: at("price_tiyin"), code: "range" });
    else if (x.price_tiyin != null && x.price_tiyin % 100) errors.push({ path: at("price_tiyin"), code: "multiple_of_100" });
    if (x.price_stars != null) range(at("price_stars"), x.price_stars, 1, 100_000);
    if (x.status === "on_sale" && x.price_tiyin == null && x.price_stars == null) errors.push({ path: `products[${i}]`, code: "price_required" });
    if (x.kind === "subscription") {
      range(at("days"), x.days, 1, 366);
      range(at("minutes"), x.minutes, 1, 100_000);
      if (x.stars_mode === "subscription" && x.days !== 30) errors.push({ path: at("stars_mode"), code: "stars_subscription_days" });
      if (x.stars_mode === "subscription" && (x.price_stars ?? 0) > 10_000) errors.push({ path: at("price_stars"), code: "stars_subscription_price" });
    } else if (x.stars_mode !== "one_time") errors.push({ path: at("stars_mode"), code: "one_time_required" });
    if (x.price_stars != null && x.stars_title) for (const l of ["ru", "uz"] as const) if (!x.stars_title[l] || x.stars_title[l].length > 32) errors.push({ path: `${at("stars_title")}.${l}`, code: "length" });
    // dev / test: missing fiscal requisites of a site product — a warning (stage / prod — an error)
    if (x.price_tiyin != null && x.status === "on_sale" && (!x.fiscal?.ikpu || !x.fiscal?.package_code || x.fiscal?.vat_percent == null || !x.fiscal?.receipt_title)) warnings.push({ path: at("fiscal"), code: "fiscal_missing" });
  });
  if (!(p.products ?? []).some((x) => x.kind === "subscription" && x.status === "on_sale")) errors.push({ path: "products", code: "subscription_on_sale_required" });
  return { errors, warnings };
}

export class MoneyStore {
  versions: CatalogVersion[];
  orders: AdminOrderCard[] = D.orders();
  refunds: AdminRefund[] = D.refunds();
  accounts: Record<string, AdminBillingAccount> = D.accounts();
  ledger = D.ledger();
  adjustments: Adjustment[] = D.adjustments();
  recon: ReconItem[] = D.reconItems();
  fx: FxRate[] = D.fxRates();
  stars: StarRate[];
  providers = D.providers();
  degradation: { mode: "auto" | "manual"; manual_level: DegradationLevel | null; economy_at_percent: number; paid_only_at_percent: number; events: AiDegradationView["events"]; updated_at: string };
  readonly audit: Array<{ action: string; id: string; reason: string | null }> = [];
  private idem = new Map<string, { status: number; body: unknown }>();
  private seq = 0;
  private conflictArmed: boolean;
  private refundLost: boolean;

  constructor(
    private readonly sc: MoneyScenario = {},
    private readonly learnerOf: (id: string) => AdminLearnerRow | undefined = () => undefined,
    private readonly aiOf: (period: "day" | "week" | "month") => { spent_usd: number; monthly_cap_usd: number; cap_used_pct: number; ai_enabled: boolean } | null = () => null,
  ) {
    this.conflictArmed = !!sc.draftConflictOnce;
    this.refundLost = !!sc.refundLostOnce;
    this.stars = sc.noStarRate ? [] : D.starRates();
    const v = (version: number, status: CatalogVersion["status"], payload: CatalogPayload, at: number, comment: string, activated: boolean): CatalogVersion => ({
      version, status, comment, created_by: D.IGOR, created_at: iso(at), validated: true, activated_by: activated ? D.IGOR : null, activated_at: activated ? iso(at + HOUR) : null, payload, diff: [], updated_at: iso(at),
    });
    this.versions = [v(2, "active", D.catalogV2(), -20 * DAY, "Цены в Stars от финансов (О1)", true), v(1, "archived", D.catalogV1(), -60 * DAY, "Каталог v1 миграцией 0001", true)];
    if (sc.draft) this.versions.unshift({ ...v(3, "draft", D.catalogV2(), -HOUR, "Новая цена 90 дней", false), validated: false, created_by: D.NODIRA });
    this.degradation = {
      mode: "auto", manual_level: null, economy_at_percent: 80, paid_only_at_percent: 90, updated_at: iso(-12 * DAY),
      events: [{ seq: 1, from: "economy", to: "normal", mode: "auto", reason: "month_reset", spent_percent: 0, actor: null, actor_name: null, at: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString() }],
    };
  }

  /* ---------------------------------------------------------------- helpers */

  private stamp(): string {
    return new Date(Date.now() + ++this.seq).toISOString();
  }
  private uuid(prefix: string): string {
    return `${prefix}-0000-4000-8000-${String(900 + ++this.seq).padStart(12, "0")}`;
  }
  private active(): CatalogVersion {
    return this.versions.find((v) => v.status === "active")!;
  }
  private draft(): CatalogVersion | undefined {
    return this.versions.find((v) => v.status === "draft");
  }
  private view(v: CatalogVersion): CatalogVersion {
    const a = this.active();
    return { ...v, diff: v === a ? [] : diffValues(a.payload, v.payload) };
  }
  private summaryRow(v: CatalogVersion) {
    const { payload: _p, diff: _d, updated_at: _u, ...row } = v;
    return row;
  }
  private canRefund(o: AdminOrderCard): boolean {
    return (o.status === "paid" || o.status === "fulfilled") && o.transactions.some((t) => t.state === "performed") && !this.refunds.some((r) => r.order_id === o.order_id && r.status !== "failed");
  }
  private card(o: AdminOrderCard): AdminOrderCard {
    return { ...o, refunds: this.refunds.filter((r) => r.order_id === o.order_id), can_refund: this.canRefund(o) };
  }
  private row(o: AdminOrderCard) {
    const { offer_version: _o, locale: _l, start_mode: _s, stars_mode: _m, product_snapshot: _p, transactions: _t, receipts: _r, refunds: _f, stars_subscription: _ss, provider_calls: _c, can_refund: _cr, ...row } = o;
    return row;
  }
  private hints(a: Adjustment, me: StaffRef, perms: Set<Permission>): Adjustment {
    const pending = a.status === "pending";
    const author = a.requested_by.staff_id === me.staff_id;
    return { ...a, can_decide: pending && perms.has("billing.approve") && !author, can_cancel: pending && author };
  }
  private account(id: string): AdminBillingAccount {
    return (
      this.accounts[id] ?? {
        account_id: id, status: "none", tier: "free", features: [], expiring: false, minutes_exhausted: false, trial_used: false, current_period: null, periods: [], holds: [], stars_subscription: null, pending_adjustments: 0,
      }
    );
  }
  private accountView(id: string): AdminBillingAccount {
    const a = this.account(id);
    return { ...a, pending_adjustments: this.adjustments.filter((x) => x.account_id === id && x.status === "pending").length };
  }

  private level(): DegradationLevel {
    const ai = this.aiOf("month");
    if (ai && !ai.ai_enabled) return "off";
    if (this.degradation.mode === "manual" && this.degradation.manual_level) return this.degradation.manual_level;
    const pct = this.sc.aiSpentPercent ?? ai?.cap_used_pct ?? 0;
    return pct >= 100 ? "off" : pct >= this.degradation.paid_only_at_percent ? "paid_only" : pct >= this.degradation.economy_at_percent ? "economy" : "normal";
  }
  degradationView(nameOf: (id: string | null | undefined) => string | null): AiDegradationView {
    const ai = this.aiOf("month");
    const now = new Date();
    return {
      mode: this.degradation.mode,
      manual_level: this.degradation.manual_level,
      level: this.level(),
      economy_at_percent: this.degradation.economy_at_percent,
      paid_only_at_percent: this.degradation.paid_only_at_percent,
      spent_percent: this.sc.aiSpentPercent ?? ai?.cap_used_pct ?? 0,
      month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
      events: this.degradation.events.map((e) => ({ ...e, actor_name: e.actor ? (nameOf(e.actor) ?? null) : null })),
      updated_at: this.degradation.updated_at,
    };
  }

  /** the reports of billing for a period of Tashkent (site in sums, Mini App in Stars — never summed) */
  summary(period: "day" | "week" | "month"): BillingSummary {
    const { from, to } = rangeOf(period);
    const inRange = (s: string | null) => !!s && Date.parse(s) >= from && Date.parse(s) <= to;
    const paid = this.orders.filter((o) => inRange(o.paid_at) && (o.status === "paid" || o.status === "fulfilled" || o.status === "refunded"));
    const web = paid.filter((o) => o.channel === "web");
    const stars = paid.filter((o) => o.channel !== "web");
    const done = this.refunds.filter((r) => r.status === "completed" && inRange(r.completed_at));
    const sum = (xs: Array<number | null>) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);
    const revenue_tiyin = sum(web.map((o) => o.amount_tiyin));
    const refunds_tiyin = sum(done.map((r) => r.amount_tiyin));
    const revenue_stars = sum(stars.map((o) => o.amount_stars));
    const refunds_stars = sum(done.map((r) => r.amount_stars));
    const star = this.stars[0] ?? null;
    const by = (p: "payme" | "click" | "uzum") => ({ orders: web.filter((o) => o.provider === p).length, revenue_tiyin: sum(web.filter((o) => o.provider === p).map((o) => o.amount_tiyin)) });
    const by_product: BillingSummary["by_product"] = {};
    for (const o of paid) {
      const b = (by_product[o.product_code] ??= { orders: 0, revenue_tiyin: 0, revenue_stars: 0 });
      b.orders += 1;
      b.revenue_tiyin += o.amount_tiyin ?? 0;
      b.revenue_stars += o.amount_stars ?? 0;
    }
    const trials = { day: [1, 0], week: [3, 1], month: [9, 4] }[period] as [number, number];
    const k = period === "day" ? 1 : period === "week" ? 7 : 30;
    return {
      period,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      web: { revenue_tiyin, refunds_tiyin, net_tiyin: revenue_tiyin - refunds_tiyin, orders_paid: web.length, by_provider: { payme: by("payme"), click: by("click"), uzum: by("uzum") } },
      stars: {
        revenue_stars, refunds_stars, net_stars: revenue_stars - refunds_stars, orders_paid: stars.filter((o) => o.channel === "miniapp").length, renewals: stars.filter((o) => o.channel === "renewal").length,
        est_net_tiyin: star ? (revenue_stars - refunds_stars) * star.star_in_tiyin : null,
      },
      by_product,
      // billing api/admin.py: refunds_count — completed in the period, recon_open — open items now
      refunds_count: done.length,
      recon_open: this.recon.filter((r) => r.status === "open").length,
      active_subscriptions: Object.values(this.accounts).filter((a) => a.status === "active").length,
      stars_subscriptions_live: Object.values(this.accounts).filter((a) => a.stars_subscription?.status === "active").length,
      trials_started: trials[0],
      trials_converted: trials[1],
      conversion_pct: trials[0] ? Math.round((trials[1] / trials[0]) * 1000) / 10 : null,
      minutes: { granted: 360 * k, spent: 172 * k, expired: 12 * k, revoked: period === "day" ? 0 : 259, overage: 2 * k },
      fx: this.fx[0] ? { usd_in_tiyin: this.fx[0].usd_in_tiyin, valid_from: this.fx[0].valid_from } : null,
      star_rate: star ? { star_in_tiyin: star.star_in_tiyin, valid_from: star.valid_from } : null,
    };
  }

  /** the block «Деньги» of the overview (today, Tashkent) */
  stats(): MoneyStats | null {
    if (this.sc.billingDown) return null;
    const s = this.summary("day");
    const ai = this.aiOf("month");
    return {
      period: "today",
      web_revenue_tiyin: s.web.revenue_tiyin,
      stars_revenue_stars: s.stars.revenue_stars,
      orders_paid: s.web.orders_paid + s.stars.orders_paid + s.stars.renewals,
      refunds: s.refunds_count,
      active_subscriptions: s.active_subscriptions,
      trials_started: s.trials_started,
      recon_open: s.recon_open,
      ai_cap_used_pct: ai ? Math.min(ai.cap_used_pct, 1000) : null,
    };
  }

  private overview(period: "day" | "week" | "month"): FinanceOverview {
    const s = this.summary(period);
    const { period: _p, from, to, fx, star_rate, ...revenue } = s;
    const ai = this.aiOf(period);
    const month = this.aiOf("month");
    const micro = (usd: number) => Math.round(usd * 1_000_000);
    const toTiyin = (m: number) => (fx ? Math.floor((m * fx.usd_in_tiyin + 500_000) / 1_000_000) : null);
    const spent = ai ? micro(ai.spent_usd) : 0;
    const perMinute = 41_500; // $0.0415 of an AI minute (unit costs of the month)
    const aiBlock: FinanceOverview["ai"] = ai
      ? {
          spent_micro_usd: spent,
          spent_tiyin: toTiyin(spent),
          monthly_cap_micro_usd: micro(ai.monthly_cap_usd),
          cap_used_pct: month?.cap_used_pct ?? ai.cap_used_pct,
          cost_per_minute_micro_usd: perMinute,
          cost_per_minute_tiyin: toTiyin(perMinute),
          forecast_month_micro_usd: month ? Math.round(micro(month.spent_usd) * 1.62) : null,
          needed_cap_micro_usd: 448_000_000,
          level: this.level(),
        }
      : null;
    const estStars = s.stars.net_stars ? s.stars.est_net_tiyin : 0;
    const margin = fx && aiBlock?.spent_tiyin != null && estStars != null ? { net_tiyin: s.web.net_tiyin + estStars - aiBlock.spent_tiyin, estimated: s.stars.net_stars !== 0 } : null;
    return { period, from, to, generated_at: iso(0), revenue, ai: aiBlock, margin, fx, star_rate };
  }

  /* ---------------------------------------------------------------- routes */

  async handle(method: string, path: string, body: P, q: URLSearchParams, idemKey: string | undefined, headers: Record<string, string>, x: Ctx): Promise<boolean> {
    const mine = /^\/(billing|finance)\//.test(path) || new RegExp(`^/learners/${UUID}/billing$`).test(path) || path === "/ai/degradation" || path === "/ai/unit-costs";
    if (!mine) return false;
    const done = (p: Promise<void>) => p.then(() => true);
    const deny = (ps: Permission | Permission[], stepUp = false): Promise<boolean> | null => {
      const list = Array.isArray(ps) ? ps : [ps];
      if (!list.some((p) => x.perms.has(p))) return done(x.err(403, "PERMISSION_DENIED", { permission: list[0] }));
      if (stepUp && !x.stepUpOk()) return done(x.err(403, "STEP_UP_REQUIRED", { permission: list[0] }));
      return null;
    };
    const rec = (action: string, type: string, id: string, after: P | null, reason: string | null = null) => {
      this.audit.push({ action, id, reason });
      x.record(action, type, id, after, reason);
    };
    const idk = idemKey ? `${method} ${path} ${idemKey}` : null;
    const seen = idk ? this.idem.get(idk) : undefined;
    const answer = (status: number, data: unknown) => {
      if (idk) this.idem.set(idk, { status, body: data });
      return done(x.json(status, data));
    };
    const bad = (field: string) => done(x.err(422, "VALIDATION_ERROR", { in: "body", field, errors: ["invalid"] }));
    const me: StaffRef = { staff_id: x.me.staff_id, name: x.me.display_name };
    const key = `${method} ${path}`;
    let m: RegExpMatchArray | null;

    /* ---------- AI control (ai-gateway) ---------- */
    if (key === "GET /ai/degradation") return deny("costs.read") ?? done(x.json(200, this.degradationView(x.nameOf)));
    if (key === "PUT /ai/degradation") {
      const g = deny("costs.manage", true);
      if (g) return g;
      if (!REASON(body.reason)) return bad("reason");
      const mode = body.mode === "manual" ? "manual" : body.mode === "auto" ? "auto" : null;
      const e = Number(body.economy_at_percent);
      const p = Number(body.paid_only_at_percent);
      const lvl = body.manual_level as DegradationLevel | null;
      if (!mode || !Number.isInteger(e) || !Number.isInteger(p) || e < 1 || p > 100 || e > p || (mode === "manual") !== (lvl != null)) return done(x.err(422, "DEGRADATION_INVALID"));
      const before = this.level();
      Object.assign(this.degradation, { mode, manual_level: mode === "manual" ? lvl : null, economy_at_percent: e, paid_only_at_percent: p, updated_at: iso(0) });
      const after = this.level();
      if (after !== before) this.degradation.events.unshift({ seq: this.degradation.events.length + 1, from: before, to: after, mode, reason: mode === "manual" ? "manual" : "threshold", spent_percent: this.sc.aiSpentPercent ?? this.aiOf("month")?.cap_used_pct ?? 0, actor: me.staff_id, actor_name: null, at: iso(0) });
      rec("ai.degradation_updated", "ai_degradation", "degradation", { mode, manual_level: lvl, economy_at_percent: e, paid_only_at_percent: p }, String(body.reason).trim());
      return done(x.json(200, this.degradationView(x.nameOf)));
    }
    if (key === "GET /ai/unit-costs") {
      const g = deny(["costs.read", "dashboard.read"]);
      if (g) return g;
      const period = q.get("period") === "week" ? "week" : "month";
      const k = period === "week" ? 1 : 4;
      const { from, to } = rangeOf(period === "week" ? "week" : "month");
      const kind = (sessions: number, ai: number, cost: number, p50: string, p95: string, minutes: number) => ({
        sessions: sessions * k, ai_sessions: ai * k, cost_usd: (cost * k).toFixed(6), cost_per_ai_session_p50_usd: p50, cost_per_ai_session_p95_usd: p95, billable_minutes: minutes * k,
        cost_per_billable_minute_usd: minutes ? ((cost * k) / (minutes * k)).toFixed(6) : null,
      });
      const out: AiUnitCosts = {
        period, from: new Date(from).toISOString(), to: new Date(to).toISOString(),
        by_kind: { lesson: kind(412, 380, 3.91, "0.008900", "0.021400", 3_610), scenario: kind(126, 119, 1.62, "0.011200", "0.024800", 1_020), pair: kind(38, 36, 0.71, "0.017500", "0.031000", 410) },
        degraded_sessions_pct: 4.1,
      };
      return done(x.json(200, out));
    }

    /* ---------- billing down ---------- */
    if (this.sc.billingDown) {
      const g = deny(["billing.read", "dashboard.read"]);
      if (g) return g;
      return done(x.err(503, "UPSTREAM_UNAVAILABLE", { service: "billing" }));
    }

    /* ---------- the «Тариф» tab ---------- */
    if ((m = path.match(new RegExp(`^/learners/(${UUID})/billing$`))) && method === "GET") {
      const g = deny("billing.read");
      if (g) return g;
      const l = this.learnerOf(m[1]!);
      if (!l) return done(x.err(404, "LEARNER_NOT_FOUND"));
      const accountId = l.kind === "child" ? l.guardian_user_id : l.user_id;
      if (!accountId) return done(x.err(404, "ACCOUNT_NOT_FOUND"));
      return done(x.json(200, this.accountView(accountId)));
    }
    if ((m = path.match(new RegExp(`^/billing/accounts/(${UUID})$`))) && method === "GET") return deny("billing.read") ?? done(x.json(200, this.accountView(m[1]!)));
    if ((m = path.match(new RegExp(`^/billing/accounts/(${UUID})/ledger$`))) && method === "GET") {
      const g = deny("billing.read");
      if (g) return g;
      const items = (this.ledger[m[1]!] ?? []).map((e) => ({ ...e, actor_name: e.actor.startsWith("staff:") ? x.nameOf(e.actor.slice(6)) : null }));
      return done(x.json(200, { items, next_cursor: null }));
    }

    /* ---------- adjustments («four eyes») ---------- */
    if ((m = path.match(new RegExp(`^/billing/accounts/(${UUID})/adjustments$`))) && method === "POST") {
      const g = deny("subscriptions.override", true);
      if (g) return g;
      if (!idemKey) return done(x.err(422, "IDEMPOTENCY_KEY_REQUIRED"));
      if (seen) return done(x.json(seen.status, seen.body));
      if (!REASON(body.reason)) return bad("reason");
      const accountId = m[1]!;
      const acc = this.account(accountId);
      const kind = String(body.kind);
      const periodOk = (id: unknown) => acc.periods.find((p) => p.period_id === id && (p.status === "active" || p.status === "scheduled"));
      if (kind === "minutes") {
        const n = Number(body.minutes);
        const p = periodOk(body.period_id);
        if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 10_000 || !p) return done(x.err(422, "ADJUSTMENT_INVALID"));
        if (n < 0 && -n > (p.balance?.minutes_left ?? 0)) return done(x.err(409, "BALANCE_NEGATIVE", { minutes_left: p.balance?.minutes_left ?? 0 }));
      } else if (kind === "grant_period") {
        const d = Number(body.days);
        const n = Number(body.minutes);
        if (!Number.isInteger(d) || d < 1 || d > 90 || !Number.isInteger(n) || n < 1) return done(x.err(422, "ADJUSTMENT_INVALID"));
      } else if (kind === "revoke_period") {
        if (!periodOk(body.period_id)) return done(x.err(422, "ADJUSTMENT_INVALID"));
      } else return done(x.err(422, "ADJUSTMENT_INVALID"));
      const a: Adjustment = {
        adjustment_id: this.uuid("f8100000"), account_id: accountId, kind: kind as Adjustment["kind"], minutes: body.minutes == null ? null : Number(body.minutes), days: body.days == null ? null : Number(body.days),
        period_id: (body.period_id as string | undefined) ?? null, reason: String(body.reason).trim(), status: "pending", requested_by: me, requested_at: this.stamp(), decided_by: null, decided_at: null,
        decision_note: null, before_value: null, after_value: null, expires_at: iso(72 * HOUR), can_decide: false, can_cancel: false,
      };
      this.adjustments.unshift(a);
      rec("billing.adjustment_requested", "adjustment", a.adjustment_id, { kind, minutes: a.minutes, days: a.days, period_id: a.period_id }, a.reason);
      return answer(202, this.hints(a, me, x.perms));
    }
    if (key === "GET /billing/adjustments") {
      const g = deny("billing.read");
      if (g) return g;
      const st = q.get("status") ?? "";
      const acc = (q.get("account_id") ?? "").toLowerCase();
      const items = this.adjustments.filter((a) => (!st || a.status === st) && (!acc || a.account_id === acc)).map((a) => this.hints(a, me, x.perms));
      return done(x.json(200, { items, next_cursor: null }));
    }
    if ((m = path.match(new RegExp(`^/billing/adjustments/(${UUID})/(approve|reject|cancel)$`))) && method === "POST") {
      const action = m[2]!;
      const g = action === "cancel" ? deny("subscriptions.override") : deny("billing.approve", true);
      if (g) return g;
      const a = this.adjustments.find((y) => y.adjustment_id === m![1]);
      if (!a) return done(x.err(404, "ADJUSTMENT_NOT_FOUND"));
      if (seen) return done(x.json(seen.status, seen.body));
      const author = a.requested_by.staff_id === me.staff_id;
      if (action === "cancel") {
        if (!author || a.status !== "pending") return done(x.err(409, "ADJUSTMENT_STATE", { status: a.status }));
        Object.assign(a, { status: "cancelled", decided_at: this.stamp() });
        rec("billing.adjustment_cancelled", "adjustment", a.adjustment_id, null);
        return answer(200, this.hints(a, me, x.perms));
      }
      if (author) return done(x.err(409, "SELF_APPROVAL"));
      if (a.status !== "pending") return done(x.err(409, "ADJUSTMENT_STATE", { status: a.status }));
      const note = body.note == null ? null : String(body.note).trim();
      if (action === "reject" && !REASON(note)) return bad("note");
      if (action === "approve" && note != null && (note.length < 1 || note.length > 500)) return bad("note");
      if (action === "approve") {
        const acc = (this.accounts[a.account_id] ??= this.account(a.account_id));
        const p = acc.periods.find((y) => y.period_id === a.period_id);
        if (a.kind === "minutes" && p?.balance) {
          const before = p.balance.minutes_left;
          if (before + a.minutes! < 0) return done(x.err(409, "BALANCE_NEGATIVE", { minutes_left: before }));
          p.balance = { ...p.balance, granted: p.balance.granted + Math.max(a.minutes!, 0), removed: p.balance.removed + Math.max(-a.minutes!, 0), minutes_left: before + a.minutes! };
          a.before_value = { minutes_left: before };
          a.after_value = { minutes_left: p.balance.minutes_left };
          (this.ledger[a.account_id] ??= []).unshift({ entry_id: this.uuid("f8800000"), seq: 100 + this.seq, period_id: p.period_id, kind: "adjust", minutes: a.minutes!, overage: 0, learner_id: null, ref_kind: "adjustment", ref_id: a.adjustment_id, actor: `staff:${me.staff_id}`, actor_name: null, created_at: this.stamp() });
        }
        if (a.kind === "revoke_period" && p) {
          a.before_value = { status: p.status, minutes_left: p.balance?.minutes_left ?? 0 };
          Object.assign(p, { status: "revoked", closed_at: this.stamp(), close_reason: "staff", balance: p.balance && { ...p.balance, removed: p.balance.removed + p.balance.minutes_left, minutes_left: 0 } });
          if (acc.current_period?.period_id === p.period_id) acc.current_period = null;
          a.after_value = { status: "revoked", minutes_left: 0 };
        }
        if (a.kind === "grant_period") {
          const np = D.period({ period_id: this.uuid("f8300000"), product_code: "grant", source: "grant", days: a.days!, minutes_granted: a.minutes!, starts_at: iso(0), ends_at: iso(a.days! * DAY), created_at: iso(0), order_no: null, balance: { granted: a.minutes!, spent: 0, removed: 0, held: 0, overage: 0, minutes_left: a.minutes! }, status: acc.current_period ? "scheduled" : "active" });
          acc.periods.unshift(np);
          if (!acc.current_period) Object.assign(acc, { current_period: np, status: "active", tier: "paid" });
          a.after_value = { period_id: np.period_id, status: np.status };
        }
      }
      Object.assign(a, { status: action === "approve" ? "applied" : "rejected", decided_by: me, decided_at: this.stamp(), decision_note: note });
      rec(action === "approve" ? "billing.adjustment_approved" : "billing.adjustment_rejected", "adjustment", a.adjustment_id, a.after_value, note);
      return answer(200, this.hints(a, me, x.perms));
    }

    /* ---------- catalogue ---------- */
    if (key === "GET /billing/catalog") return deny("billing.read") ?? done(x.json(200, { items: this.versions.map((v) => this.summaryRow(v)) }));
    if ((m = path.match(/^\/billing\/catalog\/(\d+)$/)) && method === "GET") {
      const g = deny("billing.read");
      if (g) return g;
      const v = this.versions.find((y) => y.version === Number(m![1]));
      return done(v ? x.json(200, this.view(v)) : x.err(404, "NOT_FOUND"));
    }
    if (key === "PUT /billing/catalog/draft") {
      const g = deny("billing.manage");
      if (g) return g;
      const d = this.draft();
      const ifMatch = headers["if-match"] ?? null;
      if (d && this.conflictArmed && ifMatch) {
        this.conflictArmed = false;
        d.updated_at = this.stamp();
        d.payload = { ...d.payload, offer: { ...d.payload.offer, version: "1.1" } };
        return done(x.err(409, "DRAFT_CONFLICT", { updated_at: d.updated_at }));
      }
      if (d ? ifMatch !== d.updated_at : ifMatch != null) return done(x.err(409, "DRAFT_CONFLICT", { updated_at: d?.updated_at ?? null }));
      const payload = body.payload as CatalogPayload | undefined;
      if (!payload || !Array.isArray(payload.products)) return bad("payload");
      if (body.comment != null && (typeof body.comment !== "string" || body.comment.length > 500)) return bad("comment");
      const comment = (body.comment as string | null) ?? null;
      if (d) Object.assign(d, { payload, comment, validated: false, updated_at: this.stamp() });
      else this.versions.unshift({ version: Math.max(...this.versions.map((v) => v.version)) + 1, status: "draft", comment, created_by: me, created_at: this.stamp(), validated: false, activated_by: null, activated_at: null, payload, diff: [], updated_at: this.stamp() });
      const out = this.draft()!;
      rec("billing.catalog_draft_saved", "catalog_version", String(out.version), null);
      return done(x.json(200, this.view(out)));
    }
    if (key === "DELETE /billing/catalog/draft") {
      const g = deny("billing.manage");
      if (g) return g;
      const d = this.draft();
      if (!d) return done(x.err(404, "CATALOG_DRAFT_NOT_FOUND"));
      this.versions = this.versions.filter((v) => v !== d);
      rec("billing.catalog_draft_deleted", "catalog_version", String(d.version), null);
      return done(x.json(204));
    }
    if (key === "POST /billing/catalog/draft/validate") {
      const g = deny("billing.manage");
      if (g) return g;
      const d = this.draft();
      if (!d) return done(x.err(404, "CATALOG_DRAFT_NOT_FOUND"));
      const r = validate(d.payload);
      d.validated = r.errors.length === 0;
      return done(x.json(200, { ok: d.validated, ...r }));
    }
    const rollback = method === "POST" ? path.match(/^\/billing\/catalog\/(\d+)\/rollback$/) : null;
    if (key === "POST /billing/catalog/draft/activate" || rollback) {
      m = rollback;
      const g = deny("billing.publish", true);
      if (g) return g;
      if (seen) return done(x.json(seen.status, seen.body));
      if (!REASON(body.comment)) return bad("comment");
      const comment = String(body.comment).trim();
      const current = this.active();
      let next: CatalogVersion;
      if (m) {
        const src = this.versions.find((v) => v.version === Number(m![1]));
        if (!src) return done(x.err(404, "NOT_FOUND"));
        if (src.status !== "archived" || this.draft()) return done(x.err(409, "CATALOG_STATE", { status: src.status }));
        next = { ...src, version: Math.max(...this.versions.map((v) => v.version)) + 1, status: "active", comment, created_by: me, created_at: this.stamp(), validated: true, activated_by: me, activated_at: this.stamp(), payload: JSON.parse(JSON.stringify(src.payload)), diff: [], updated_at: this.stamp() };
        this.versions.unshift(next);
      } else {
        const d = this.draft();
        if (!d) return done(x.err(404, "CATALOG_DRAFT_NOT_FOUND"));
        if (!d.validated) return done(x.err(409, "CATALOG_NOT_VALIDATED"));
        next = Object.assign(d, { status: "active" as const, comment: d.comment ?? comment, activated_by: me, activated_at: this.stamp() });
      }
      current.status = "archived";
      rec(m ? "billing.catalog_rolled_back" : "billing.catalog_activated", "catalog_version", String(next.version), { from: current.version }, comment);
      return answer(200, this.view(next));
    }
    if (key === "POST /billing/trials:grant-all") {
      const g = deny("billing.publish", true);
      if (g) return g;
      if (seen) return done(x.json(seen.status, seen.body));
      if (!REASON(body.reason)) return bad("reason");
      if (this.sc.trialGrantOff) return done(x.err(409, "TRIAL_GRANT_DISABLED"));
      rec("billing.trials_granted", "billing", "trials", { granted: 214, skipped: 9 }, String(body.reason).trim());
      return answer(200, { granted: 214, skipped: 9 });
    }

    /* ---------- orders and refunds ---------- */
    if (key === "GET /billing/orders") {
      const g = deny("billing.read");
      if (g) return g;
      const f = (k: string) => q.get(k) ?? "";
      const ch = f("channel");
      const pr = f("provider");
      if (ch && pr && (ch === "web") === (pr === "telegram_stars")) return done(x.err(422, "VALIDATION_ERROR", { in: "query", field: "provider", errors: ["channel"] }));
      const from = f("from") ? Date.parse(`${f("from")}T00:00:00+05:00`) : -Infinity;
      const to = f("to") ? Date.parse(`${f("to")}T23:59:59+05:00`) : Infinity;
      const items = this.orders
        .filter(
          (o) =>
            (!f("status") || o.status === f("status")) &&
            (!ch || o.channel === ch) &&
            (!pr || o.provider === pr) &&
            (!f("product_kind") || o.product_kind === f("product_kind")) &&
            (!f("order_no") || String(o.order_no) === f("order_no")) &&
            (!f("provider_txn_id") || o.transactions.some((t) => t.provider_txn_id === f("provider_txn_id"))) &&
            (!f("account_id") || o.account_id === f("account_id").toLowerCase()) &&
            Date.parse(o.created_at) >= from &&
            Date.parse(o.created_at) <= to,
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((o) => this.row(o));
      return done(x.json(200, { items, next_cursor: null }));
    }
    if ((m = path.match(new RegExp(`^/billing/orders/(${UUID})$`))) && method === "GET") {
      const g = deny("billing.read");
      if (g) return g;
      const o = this.orders.find((y) => y.order_id === m![1]);
      return done(o ? x.json(200, this.card(o)) : x.err(404, "ORDER_NOT_FOUND"));
    }
    if ((m = path.match(new RegExp(`^/billing/orders/(${UUID})/refunds$`))) && method === "POST") {
      const g = deny("billing.refund", true);
      if (g) return g;
      if (!idemKey) return done(x.err(422, "IDEMPOTENCY_KEY_REQUIRED"));
      if (seen) return done(x.json(seen.status, seen.body));
      if (!REASON(body.reason)) return bad("reason");
      const o = this.orders.find((y) => y.order_id === m![1]);
      if (!o) return done(x.err(404, "ORDER_NOT_FOUND"));
      if (!this.canRefund(o)) return done(x.err(409, "REFUND_STATE", { status: o.status }));
      const t = o.transactions.find((y) => y.state === "performed")!;
      if (o.provider === "click") {
        const pl = new Date(Date.parse(t.performed_at!) + 5 * HOUR);
        const nl = new Date(Date.now() + 5 * HOUR);
        const same = pl.getUTCFullYear() === nl.getUTCFullYear() && pl.getUTCMonth() === nl.getUTCMonth();
        const prev = nl.getUTCDate() === 1 && (pl.getUTCMonth() + 1) % 12 === nl.getUTCMonth();
        if (!same && !prev) return done(x.err(409, "REFUND_NOT_ALLOWED", { reason: "provider_window" }));
      }
      const tils = o.product_kind === "til_pack" ? { til: 100, til_balance: 20, status: "spent" } : null;
      if (tils && tils.til_balance < tils.til && body.force !== true) return done(x.err(409, "REFUND_NOT_ALLOWED", { reason: "tils_spent", til: tils.til, til_balance: tils.til_balance }));
      const now = this.stamp();
      const api = o.provider === "telegram_stars" || o.provider === "click";
      const r: AdminRefund = {
        refund_id: this.uuid("f8200000"), order_id: o.order_id, order_no: o.order_no, txn_id: t.txn_id, provider: o.provider, amount_tiyin: o.amount_tiyin, amount_stars: o.amount_stars,
        status: api ? "completed" : "awaiting_provider", initiated_by: "staff", method: api ? "provider_api" : "provider_cabinet", reason: String(body.reason).trim(), requested_by: me, requested_at: now,
        completed_at: api ? now : null, failure_code: null, tils_check: tils, instruction: api ? null : { provider: o.provider, provider_txn_id: t.provider_txn_id, amount_tiyin: o.amount_tiyin },
      };
      this.refunds.unshift(r);
      if (api) {
        o.status = "refunded";
        o.closed_at = now;
        t.state = "refunded";
        if (o.stars_subscription) o.stars_subscription = { ...o.stars_subscription, status: "refunded", updated_at: now };
      }
      if (tils && body.force === true) this.recon.unshift({ item_id: this.uuid("f8400000"), run_id: null, kind: "tils_spent_on_refund", provider: o.provider, order_id: o.order_id, order_no: o.order_no, txn_id: t.txn_id, period_id: null, details: { til: tils.til, til_balance: tils.til_balance }, status: "open", created_at: now, resolved_by: null, resolved_at: null, note: null });
      rec("billing.refund_requested", "order", o.order_id, { refund_id: r.refund_id, status: r.status, force: body.force === true }, r.reason);
      if (idk) this.idem.set(idk, { status: 201, body: r });
      if (this.refundLost) {
        this.refundLost = false;
        return done(x.err(502, "UPSTREAM_UNAVAILABLE", { service: "billing" }));
      }
      return done(x.json(201, r));
    }
    if (key === "GET /billing/refunds") {
      const g = deny("billing.read");
      if (g) return g;
      const st = q.get("status") ?? "";
      return done(x.json(200, { items: this.refunds.filter((r) => !st || r.status === st).sort((a, b) => b.requested_at.localeCompare(a.requested_at)), next_cursor: null }));
    }
    if ((m = path.match(new RegExp(`^/billing/refunds/(${UUID})/fail$`))) && method === "POST") {
      const g = deny("billing.refund", true);
      if (g) return g;
      if (seen) return done(x.json(seen.status, seen.body));
      if (!REASON(body.note)) return bad("note");
      const r = this.refunds.find((y) => y.refund_id === m![1]);
      if (!r) return done(x.err(404, "REFUND_NOT_FOUND"));
      if (r.status !== "awaiting_provider") return done(x.err(409, "REFUND_STATE", { status: r.status }));
      Object.assign(r, { status: "failed", failure_code: "staff_closed", completed_at: this.stamp() });
      rec("billing.refund_failed", "refund", r.refund_id, null, String(body.note).trim());
      return answer(200, r);
    }

    /* ---------- reconciliation ---------- */
    if (key === "GET /billing/reconciliation/items") {
      const g = deny("billing.read");
      if (g) return g;
      const st = q.get("status") ?? "";
      const kind = q.get("kind") ?? "";
      return done(x.json(200, { items: this.recon.filter((r) => (!st || r.status === st) && (!kind || r.kind === kind)), next_cursor: null }));
    }
    if (key === "POST /billing/reconciliation/runs") {
      const g = deny("billing.manage");
      if (g) return g;
      if (seen) return done(x.json(seen.status, seen.body));
      const run = { run_id: this.uuid("f8900000"), kind: "manual", started_at: this.stamp(), finished_at: this.stamp(), checked: 412, found: 0, error: null };
      rec("billing.reconciliation_run", "recon_run", run.run_id, { checked: 412, found: 0 });
      return answer(200, run);
    }
    if ((m = path.match(new RegExp(`^/billing/reconciliation/items/(${UUID})/resolve$`))) && method === "POST") {
      const g = deny("billing.manage");
      if (g) return g;
      if (seen) return done(x.json(seen.status, seen.body));
      if (!REASON(body.note)) return bad("note");
      if (body.status !== "resolved" && body.status !== "ignored") return bad("status");
      const r = this.recon.find((y) => y.item_id === m![1]);
      if (!r) return done(x.err(404, "RECON_ITEM_NOT_FOUND"));
      if (r.status !== "open") return done(x.err(409, "RECON_ITEM_STATE", { status: r.status }));
      Object.assign(r, { status: body.status, resolved_by: me, resolved_at: this.stamp(), note: String(body.note).trim() });
      rec("billing.recon_resolved", "recon_item", r.item_id, { status: r.status }, r.note);
      return answer(200, r);
    }

    /* ---------- reports, rates, providers, the finance overview ---------- */
    if (key === "GET /billing/reports/summary") {
      const g = deny(["billing.read", "dashboard.read"]);
      if (g) return g;
      const p = q.get("period");
      return done(x.json(200, this.summary(p === "day" || p === "week" ? p : "month")));
    }
    if (key === "GET /finance/overview") {
      const g = deny(["billing.read", "dashboard.read"]);
      if (g) return g;
      const p = q.get("period");
      return done(x.json(200, this.overview(p === "day" || p === "week" ? p : "month")));
    }
    if (key === "GET /billing/fx") return deny("billing.read") ?? done(x.json(200, { items: this.fx }));
    if (key === "GET /billing/star-rate") return deny("billing.read") ?? done(x.json(200, { items: this.stars }));
    if (key === "PUT /billing/fx" || key === "PUT /billing/star-rate") {
      const g = deny("billing.manage");
      if (g) return g;
      if (!REASON(body.reason)) return bad("reason");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.valid_from ?? ""))) return bad("valid_from");
      const fx = key === "PUT /billing/fx";
      const v = Number(fx ? body.usd_in_tiyin : body.star_in_tiyin);
      if (!Number.isInteger(v) || (fx ? v < 100_000 || v > 100_000_000 : v < 1 || v > 10_000_000)) return done(x.err(422, "FX_INVALID"));
      const row = { valid_from: String(body.valid_from), set_by: me, reason: String(body.reason).trim(), created_at: this.stamp() };
      if (fx) this.fx.unshift({ usd_in_tiyin: v, ...row });
      else this.stars.unshift({ star_in_tiyin: v, ...row });
      rec(fx ? "billing.fx_updated" : "billing.star_rate_updated", "billing", fx ? "fx" : "star_rate", { value: v, valid_from: row.valid_from }, row.reason);
      return done(x.json(200, fx ? this.fx[0] : this.stars[0]));
    }
    if (key === "GET /billing/providers") return deny("billing.read") ?? done(x.json(200, { items: this.providers }));

    return done(x.err(404, "NOT_FOUND", { path }));
  }
}
