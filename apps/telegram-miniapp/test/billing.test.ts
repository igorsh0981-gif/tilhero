/**
 * Sprint 8 — the pure logic of the subscription and purchases for Telegram Stars (domain/billing) and the bridge to
 * Telegram.WebApp.openInvoice (src/tg/invoice).
 */
import type { BillingProduct, StarsOrder, SubscriptionView } from "@tilhero/contracts/bff";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors";
import {
  canSubmit,
  canToggleAutoRenew,
  daysLeft,
  keepOrderKey,
  minutesLeftPct,
  orderBody,
  pollOrder,
  purchasePlan,
  purchaseProblem,
  starsLive,
  starsText,
  subscriptionRequired,
} from "../src/domain/billing";
import { isInvoiceLink, openInvoice, resetInvoiceForTests } from "../src/tg";
import { installTg, uninstallTg } from "./tgFake";

const NOW = Date.parse("2026-11-22T09:00:00Z");
const L = (ru: string) => ({ ru, uz: ru });
const PLUS30: BillingProduct = { code: "plus_30d", kind: "subscription", title: L("Плюс 30"), description: null, days: 30, minutes: 300, features: ["ai_lessons", "pair_lessons"], til: null, price: { stars: 250, mode: "subscription" } };
const PLUS90: BillingProduct = { ...PLUS30, code: "plus_90d", days: 90, minutes: 900, price: { stars: 650, mode: "one_time" } };
const TIL100: BillingProduct = { code: "til_100", kind: "til_pack", title: L("100 тилов"), description: null, days: null, minutes: null, features: [], til: 100, price: { stars: 25, mode: "one_time" } };

const sub = (o: Partial<SubscriptionView> = {}): SubscriptionView => ({
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
const PERIOD = { starts_at: "2026-11-20T09:00:00Z", ends_at: "2026-12-20T09:00:00Z", minutes_granted: 300, minutes_spent: 12, minutes_held: 3, minutes_left: 285, overage: 0 };
const order = (status: StarsOrder["status"], o: Partial<StarsOrder> = {}): StarsOrder => ({
  order_no: 1001,
  status,
  channel: "miniapp",
  product: { code: "plus_30d", kind: "subscription", title: L("Плюс 30") },
  currency: "XTR",
  amount_stars: 250,
  provider: "telegram_stars",
  invoice_link: status === "pending" ? "https://t.me/$abc" : null,
  expires_at: "2026-11-22T10:00:00Z",
  created_at: "2026-11-22T09:00:00Z",
  paid_at: null,
  refund: null,
  ...o,
});

describe("Stars and the subscription", () => {
  it("«⭐ 250», «⭐ 1 200» — whole Stars, grouped by a no-break space", () => {
    expect(starsText(250)).toBe("⭐ 250");
    expect(starsText(1200)).toBe("⭐ 1 200");
    expect(starsText(10000)).toBe("⭐ 10 000");
    expect(starsText(12.9)).toBe("⭐ 12");
  });
  it("a live Stars subscription: active / canceled / failed until expires_at; the switch — active or canceled only", () => {
    const s = { status: "active" as const, auto_renew: true, expires_at: "2026-12-22T09:00:00Z", amount_stars: 250 };
    expect(starsLive(s, NOW)).toBe(true);
    expect(starsLive({ ...s, status: "canceled", auto_renew: false }, NOW)).toBe(true);
    expect(starsLive({ ...s, status: "refunded" }, NOW)).toBe(false);
    expect(starsLive({ ...s, expires_at: "2026-11-01T00:00:00Z" }, NOW)).toBe(false);
    expect(canToggleAutoRenew({ ...s, status: "failed" }, NOW)).toBe(false);
    expect(canToggleAutoRenew({ ...s, status: "canceled", auto_renew: false }, NOW)).toBe(true);
  });
  it("minutes left in per cent, days left rounded up", () => {
    expect(minutesLeftPct(sub({ period: PERIOD }))).toBe(95);
    expect(minutesLeftPct(sub())).toBe(0);
    expect(daysLeft("2026-11-24T08:00:00Z", NOW)).toBe(2);
    expect(daysLeft("bad", NOW)).toBe(0);
  });
});

describe("the purchase plan and the body of the order (never a sum)", () => {
  it("Stars subscription: starts at the payment; not over a live Stars subscription or a paid period; over a trial — a confirmation", () => {
    expect(purchasePlan(PLUS30, sub(), NOW)).toEqual({ blocked: null, startModes: null, forfeitsTrial: false });
    expect(purchasePlan(PLUS30, sub({ status: "trial", period: PERIOD }), NOW).forfeitsTrial).toBe(true);
    expect(purchasePlan(PLUS30, sub({ status: "active", period: PERIOD }), NOW).blocked).toEqual({ reason: "active_period", until: PERIOD.ends_at });
    const live = sub({ status: "active", period: PERIOD, stars_subscription: { status: "canceled", auto_renew: false, expires_at: "2026-12-22T09:00:00Z", amount_stars: 250 } });
    expect(purchasePlan(PLUS30, live, NOW).blocked).toEqual({ reason: "stars_exists", until: "2026-12-22T09:00:00Z" });
  });
  it("one-off period: after the current one by default; «now» only with the confirmation; nothing running — now", () => {
    const running = sub({ status: "active", period: PERIOD });
    const plan = purchasePlan(PLUS90, running, NOW);
    expect(plan.startModes).toEqual(["after_current", "now"]);
    expect(orderBody(PLUS90, "1.0", plan, { startMode: "after_current", forfeit: false, beneficiaryId: null })).toEqual({ product_code: "plus_90d", provider: "telegram_stars", offer_version: "1.0", start_mode: "after_current" });
    expect(canSubmit(plan, { startMode: "now", forfeit: false, beneficiaryId: null }, true)).toBe(false);
    expect(canSubmit(plan, { startMode: "now", forfeit: true, beneficiaryId: null }, true)).toBe(true);
    expect(orderBody(PLUS90, "1.0", plan, { startMode: "now", forfeit: true, beneficiaryId: null })).toMatchObject({ start_mode: "now", confirm_forfeit: true });
    const idle = purchasePlan(PLUS90, sub(), NOW);
    expect(orderBody(PLUS90, "1.0", idle, { startMode: null, forfeit: false, beneficiaryId: null })).toEqual({ product_code: "plus_90d", provider: "telegram_stars", offer_version: "1.0", start_mode: "now" });
  });
  it("Stars subscription over a trial: confirm_forfeit; til pack: the recipient (child), no start mode; the offer must be accepted", () => {
    const trial = purchasePlan(PLUS30, sub({ status: "trial", period: PERIOD }), NOW);
    expect(canSubmit(trial, { startMode: null, forfeit: false, beneficiaryId: null }, true)).toBe(false);
    expect(orderBody(PLUS30, "1.0", trial, { startMode: null, forfeit: true, beneficiaryId: null })).toEqual({ product_code: "plus_30d", provider: "telegram_stars", offer_version: "1.0", confirm_forfeit: true });
    const til = purchasePlan(TIL100, sub(), NOW);
    expect(orderBody(TIL100, "1.0", til, { startMode: null, forfeit: false, beneficiaryId: "kid-1" })).toEqual({ product_code: "til_100", provider: "telegram_stars", offer_version: "1.0", beneficiary_id: "kid-1" });
    expect(canSubmit(til, { startMode: null, forfeit: false, beneficiaryId: null }, false)).toBe(false);
    for (const body of [orderBody(TIL100, "1.0", til, { startMode: null, forfeit: false, beneficiaryId: null }), orderBody(PLUS30, "1.0", trial, { startMode: null, forfeit: true, beneficiaryId: null })]) {
      expect(Object.keys(body).filter((k) => /amount|price|stars|tiyin|sum/.test(k))).toEqual([]);
    }
  });
});

describe("the poll of the order after the invoice (≤ 60 s, billing is the source of truth)", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };
  it("paid: polls until fulfilled; a lost poll is retried", async () => {
    const c = clock();
    const answers: Array<StarsOrder | Error> = [order("pending"), new Error("net"), order("pending"), order("fulfilled")];
    const r = await pollOrder({ ...c, read: async () => { const a = answers.shift()!; if (a instanceof Error) throw a; return a; } });
    expect(r).toMatchObject({ kind: "settled", order: { status: "fulfilled" } });
  });
  it("a til pack is settled once paid (credited a moment later); expired — closed", async () => {
    expect(await pollOrder({ ...clock(), read: async () => order("paid") })).toMatchObject({ kind: "settled" });
    expect(await pollOrder({ ...clock(), read: async () => order("expired") })).toMatchObject({ kind: "closed" });
  });
  it("never longer than 60 s: the last order comes back on timeout", async () => {
    const c = clock();
    const r = await pollOrder({ ...c, read: async () => order("pending") });
    expect(r).toMatchObject({ kind: "timeout", order: { status: "pending" } });
    expect(c.now()).toBeLessThanOrEqual(60_000);
    expect(c.now()).toBeGreaterThan(55_000);
  });
  it("cancelled invoice: one check only; an aborted screen stops", async () => {
    let reads = 0;
    const r = await pollOrder({ ...clock(), read: async () => (reads++, order("pending")) }, { untilSettled: false });
    expect([r.kind, reads]).toEqual(["pending", 1]);
    const ac = new AbortController();
    ac.abort();
    expect(await pollOrder({ ...clock(), read: async () => order("pending"), signal: ac.signal })).toEqual({ kind: "aborted" });
  });
});

describe("errors of the purchase", () => {
  const e = (status: number, code: string, details: Record<string, unknown> = {}) => new ApiError(status, code, code, details);
  it("409 / 403 / 503 → what the sheet does", () => {
    expect(purchaseProblem(e(409, "FORFEIT_CONFIRMATION_REQUIRED", { minutes_left: 45, days_left: 5 }))).toEqual({ kind: "forfeit", minutesLeft: 45, daysLeft: 5 });
    expect(purchaseProblem(e(409, "OFFER_VERSION_MISMATCH", { current: "1.1" }))).toEqual({ kind: "offer", current: "1.1" });
    expect(purchaseProblem(e(409, "ACTIVE_PERIOD_EXISTS", { ends_at: "2026-12-20T09:00:00Z" }))).toEqual({ kind: "active", until: "2026-12-20T09:00:00Z" });
    expect(purchaseProblem(e(409, "PAYMENTS_DISABLED")).kind).toBe("salesOff");
    expect(purchaseProblem(e(503, "BILLING_UNAVAILABLE")).kind).toBe("salesOff");
    expect(purchaseProblem(e(403, "GUARDIAN_CONSENT_REQUIRED")).kind).toBe("consent");
    expect(purchaseProblem(e(503, "STARS_UNAVAILABLE")).kind).toBe("starsRetry");
    expect(purchaseProblem(e(429, "ORDERS_LIMIT")).kind).toBe("tooMany");
    expect(purchaseProblem(new Error("x")).kind).toBe("other");
  });
  it("the Idempotency-Key is kept when the outcome is unknown (network, 5xx, STARS_UNAVAILABLE)", () => {
    expect(keepOrderKey(e(0, "NETWORK"))).toBe(true);
    expect(keepOrderKey(e(503, "STARS_UNAVAILABLE"))).toBe(true);
    expect(keepOrderKey(e(502, "SERVICE_UNAVAILABLE"))).toBe(true);
    expect(keepOrderKey(e(503, "BILLING_UNAVAILABLE"))).toBe(false);
    expect(keepOrderKey(e(409, "OFFER_VERSION_MISMATCH"))).toBe(false);
  });
  it("403 SUBSCRIPTION_REQUIRED of the pair invitation → the reason", () => {
    expect(subscriptionRequired(e(403, "SUBSCRIPTION_REQUIRED", { feature: "pair_lessons", reason: "minutes_exhausted" }))).toBe("minutes_exhausted");
    expect(subscriptionRequired(e(403, "SUBSCRIPTION_REQUIRED", { reason: "weird" }))).toBe("no_subscription");
    expect(subscriptionRequired(e(403, "BLOCKED"))).toBeNull();
  });
});

describe("tg/invoice — Telegram.WebApp.openInvoice is the only way to pay", () => {
  afterEach(() => {
    uninstallTg();
    resetInvoiceForTests();
  });
  it("only t.me links; outside Telegram — unsupported (nothing opened)", async () => {
    expect(isInvoiceLink("https://t.me/$AbC-123_x")).toBe(true);
    expect(isInvoiceLink("https://t.me/invoice/abc")).toBe(true);
    for (const bad of ["http://t.me/$a", "https://pay.example.com/x", "https://t.me.evil.com/$a", "javascript:alert(1)", "https://t.me/$a b"]) expect(isInvoiceLink(bad), bad).toBe(false);
    expect(await openInvoice("https://t.me/$abc")).toBe("unsupported");
    installTg();
    expect(await openInvoice("https://example.com/pay")).toBe("invalid");
  });
  it("inside Telegram 6.1+: the status of the callback; a second call while open — busy; an unknown status — pending", async () => {
    const tg = installTg();
    let close: ((s: string) => void) | null = null;
    tg.wa.openInvoice = (url: string, cb: (s: string) => void) => {
      tg.calls.push(["openInvoice", url]);
      close = cb;
    };
    const first = openInvoice("https://t.me/$abc");
    expect(await openInvoice("https://t.me/$abc")).toBe("busy");
    close!("paid");
    expect(await first).toBe("paid");
    expect(tg.calls.filter((c) => c[0] === "openInvoice")).toEqual([["openInvoice", "https://t.me/$abc"]]);
    const second = openInvoice("https://t.me/$abc");
    close!("something");
    expect(await second).toBe("pending");
  });
  it("old Telegram (6.0) or no method — unsupported; a throwing client — failed", async () => {
    installTg({ version: "6.0" }).wa.openInvoice = () => undefined;
    expect(await openInvoice("https://t.me/$abc")).toBe("unsupported");
    uninstallTg();
    const tg = installTg();
    tg.wa.openInvoice = () => {
      throw new Error("boom");
    };
    expect(await openInvoice("https://t.me/$abc")).toBe("failed");
  });
});
