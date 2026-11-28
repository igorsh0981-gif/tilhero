/**
 * Sprint 8 logic of «Деньги»: integer money (tiyin, Stars, micro-dollars — no float), the catalogue form (two prices,
 * the paths of the billing validator, Stars limits of the Bot API, fiscal requisites of a site product), the
 * activation gate, the order filters (channels never mix: the site — sums, the Mini App — Stars), the refund (the
 * method by provider, the Click window, the Idempotency-Key signature of the command), the adjustment request («four
 * eyes»), the degradation form, routes; plus the screens: the author never sees «Подтвердить», a refund refused for
 * spent tils is forced with a second confirmation, a lost answer repeats with the same key, the overview block «Деньги».
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Adjustment, AdminOrderCard, AdminRefund, CatalogPayload, Dashboard, Permission } from "@tilhero/contracts/admin";
import { api } from "../src/api/client";
import { I18nProvider } from "../src/i18n";
import { SessionCtx, type Session } from "../src/state/session";
import { ToastProvider } from "../src/ui/toasts";
import { Overview } from "../src/screens/overview/Overview";
import { AdjustmentsPage, parseAdjustmentsRoute } from "../src/screens/money/AdjustmentsPage";
import { PaymentsPage, parsePayRoute } from "../src/screens/money/PaymentsPage";
import { parseTariffRoute } from "../src/screens/money/TariffsPage";
import * as M from "../src/screens/money/model";

const ORDER = "f8000000-0000-4000-8000-000000000001";
const TXN = "f8000000-0000-4000-8000-000000000002";
const ACC = "a1000000-0000-4000-8000-000000000005";
const PERIOD = "f8000000-0000-4000-8000-000000000003";
const ME = "e1000000-0000-4000-8000-000000000001";
const OTHER = "e1000000-0000-4000-8000-000000000002";
const REASON = "Обращение в поддержку №1042, двойное списание";
const codes = (xs: readonly M.Issue[]) => xs.map((x) => `${x.path}:${x.code}`);

describe("integer money", () => {
  it("tiyin → sums with tiyin only when there are any; Stars and micro-dollars without float", () => {
    expect(M.fmtTiyin(4_900_000, "en-US")).toBe("49,000");
    expect(M.fmtTiyin(4_900_005, "en-US")).toBe("49,000.05");
    expect(M.fmtTiyin(-150, "en-US")).toBe("−1.50");
    expect(M.fmtTiyin(Number.MAX_SAFE_INTEGER + 2, "en-US")).toBe("—");
    expect(M.fmtStars(12_500, "en-US")).toBe("12,500");
    expect(M.fmtMicroUsd(3_250_000, "en-US")).toBe("$3.25");
    expect(M.fmtMicroUsd(1_615, "en-US")).toBe("$0.001615");
    expect(M.fmtMicroUsd(0, "en-US")).toBe("$0.00");
  });
  it("sums as typed → tiyin; a fraction, a sign or letters are refused", () => {
    expect(M.parseSums("49 000")).toBe(4_900_000);
    expect(M.parseSums("49 000")).toBe(4_900_000);
    expect(M.parseSums("49000,50")).toBeNull();
    expect(M.parseSums("-5")).toBeNull();
    expect(M.parseSums("")).toBeNull();
    expect(M.parseSigned("−20")).toBe(-20);
    expect(M.parseSigned("+30")).toBe(30);
    expect(M.parseSigned("2.5")).toBeNull();
    expect(M.parseCount("1 200")).toBe(1200);
    expect(M.parseCount("101", 100)).toBeNull();
  });
  it("the currency of a channel: the site — sums, the Mini App and renewals — Stars", () => {
    expect(M.channelCurrency("web")).toBe("UZS");
    expect(M.channelCurrency("miniapp")).toBe("XTR");
    expect(M.channelCurrency("renewal")).toBe("XTR");
  });
});

/** the example catalogue of INTERNAL_API §1.10 (v1: site prices, no Stars prices, empty fiscal requisites) */
const V1: CatalogPayload = {
  merchant: { tin: "123456789" },
  offer: { version: "1.0", url: "https://app.tilhero.uz/legal/offer" },
  trial: { enabled: true, days: 7, minutes: 60, features: ["ai_lessons", "pair_lessons"] },
  limits: { min_start_minutes: 1, pair_min_minutes: 10, low_minutes_percent: 10, expiring_days: 3, order_ttl_minutes: 1440, stars_order_ttl_minutes: 60, pending_orders_max: 5, hold_ttl_hours: 80 },
  products: [
    {
      code: "plus_30d", kind: "subscription", status: "on_sale", sort: 10, title: { ru: "TilHero Плюс — 30 дней", uz: "TilHero Plus — 30 kun" }, days: 30, minutes: 300, features: ["ai_lessons", "pair_lessons"],
      audiences: ["teens", "adults"], price_tiyin: 4_900_000, providers: ["payme", "click", "uzum"], price_stars: null, stars_mode: "subscription", stars_title: { ru: "TilHero Плюс", uz: "TilHero Plus" },
      fiscal: { ikpu: "10305008002000000", package_code: "1500391", units: null, vat_percent: 12, receipt_title: "TilHero Plus 30" },
    },
    {
      code: "til_100", kind: "til_pack", status: "on_sale", sort: 50, title: { ru: "100 тилов", uz: "100 til" }, til: 100, audiences: ["kids", "teens", "adults"],
      price_tiyin: 500_000, providers: ["payme", "click", "uzum"], price_stars: null, stars_mode: "one_time", stars_title: { ru: "100 тилов", uz: "100 til" }, fiscal: null,
    },
  ],
};

describe("the catalogue form", () => {
  it("round-trips the payload of billing: numbers as text, sums from tiyin", () => {
    const f = M.catalogForm(V1);
    expect(f.products[0]!.price_sums).toBe("49000");
    expect(f.products[0]!.price_stars).toBe("");
    const r = M.checkCatalog(f);
    expect(r.errors).toEqual([]);
    expect(r.payload!.products[0]!.price_tiyin).toBe(4_900_000);
    expect(r.payload!.products[0]!.price_stars).toBeNull();
    expect(r.payload!.products[1]!.til).toBe(100);
    // a site product without fiscal requisites — a warning here, an error of billing in stage/prod
    expect(codes(r.warnings)).toEqual(["products[1].fiscal:fiscal_missing"]);
  });
  it("two prices: a Stars price sells in the Mini App, a sums price with a provider — on the site", () => {
    expect(M.salesOf({ ...V1.products[0]!, price_stars: 250 })).toEqual({ web: true, miniapp: true });
    expect(M.salesOf({ ...V1.products[0]!, providers: [] })).toEqual({ web: false, miniapp: false });
    expect(M.salesOf({ ...V1.products[0]!, price_tiyin: null, price_stars: 250 })).toEqual({ web: false, miniapp: true });
    expect(M.salesOf({ ...V1.products[0]!, status: "hidden", price_stars: 250 })).toEqual({ web: false, miniapp: false });
  });
  it("Bot API limits: a Telegram subscription is 30 days and ≤ 10 000 Stars; a til pack is a one-time invoice; title ≤ 32", () => {
    const f = M.catalogForm(V1);
    const p = (i: number, x: Partial<M.ProductForm>) => ({ ...f, products: f.products.map((y, j) => (j === i ? { ...y, ...x } : y)) });
    expect(codes(M.checkCatalog(p(0, { days: "31" })).errors)).toEqual(["products[0].stars_mode:stars_sub_days"]);
    expect(codes(M.checkCatalog(p(0, { price_stars: "10001" })).errors)).toEqual(["products[0].price_stars:stars_sub_max"]);
    expect(M.checkCatalog(p(0, { price_stars: "10001", stars_mode: "one_time" })).errors).toEqual([]);
    expect(codes(M.checkCatalog(p(1, { stars_mode: "subscription" })).errors)).toEqual(["products[1].stars_mode:til_one_time"]);
    expect(codes(M.checkCatalog(p(0, { price_stars: "250", stars_title: { ru: "x".repeat(33), uz: "TilHero Plus" } })).errors)).toEqual(["products[0].stars_title.ru:too_long"]);
    expect(codes(M.checkCatalog(p(0, { price_stars: "100001", stars_mode: "one_time" })).errors)).toEqual(["products[0].price_stars:range"]);
  });
  it("a product on sale needs a price; a value that is not a number blocks the save; bounds are left to billing", () => {
    const f = M.catalogForm(V1);
    const p = (x: Partial<M.ProductForm>) => ({ ...f, products: [{ ...f.products[0]!, ...x }, f.products[1]!] });
    expect(codes(M.checkCatalog(p({ price_sums: "", price_stars: "" })).errors)).toEqual(["products[0].price_tiyin:no_price"]);
    const frac = M.checkCatalog(p({ price_sums: "49000,50" }));
    expect(codes(frac.errors)).toEqual(["products[0].price_tiyin:sums_format"]);
    expect(frac.payload).toBeNull();
    const big = M.checkCatalog(p({ minutes: "100001" }));
    expect(codes(big.errors)).toEqual(["products[0].minutes:range"]);
    expect(big.payload).not.toBeNull();
    expect(codes(M.checkCatalog(p({ providers: [] })).warnings)).toContain("products[0].providers:no_providers");
    expect(codes(M.checkCatalog({ ...f, products: [{ ...f.products[0]!, status: "hidden" }, f.products[1]!] }).errors)).toEqual(["products:no_subscription"]);
  });
  it("requisites and texts: TIN or PINFL, https offer, codes unique, Uzbek in Latin", () => {
    const f = M.catalogForm(V1);
    expect(codes(M.checkCatalog({ ...f, merchant_tin: "12345" }).errors)).toEqual(["merchant.tin:tin_format"]);
    expect(M.checkCatalog({ ...f, merchant_tin: "12345678901234" }).errors).toEqual([]);
    expect(codes(M.checkCatalog({ ...f, offer_url: "http://app.tilhero.uz/offer" }).errors)).toEqual(["offer.url:https"]);
    const dup = { ...f, products: [f.products[0]!, { ...f.products[1]!, code: "plus_30d" }] };
    expect(codes(M.checkCatalog(dup).errors)).toEqual(["products[1].code:duplicate"]);
    const cyr = { ...f, products: [{ ...f.products[0]!, title: { ru: "Плюс", uz: "Плюс" } }, f.products[1]!] };
    expect(codes(M.checkCatalog(cyr).warnings)).toContain("products[0].title.uz:uz_script");
    const fz = { ...f, products: [{ ...f.products[0]!, fiscal: { ...f.products[0]!.fiscal, ikpu: "12a" } }, f.products[1]!] };
    expect(codes(M.checkCatalog(fz).errors)).toEqual(["products[0].fiscal.ikpu:ikpu_format"]);
  });
  it("activation: only a saved draft checked after its last change", () => {
    expect(M.activationGate(null, false, 0)).toBe("no_draft");
    expect(M.activationGate({ validated: true }, true, 0)).toBe("unsaved");
    expect(M.activationGate({ validated: true }, false, 2)).toBe("invalid");
    expect(M.activationGate({ validated: false }, false, 0)).toBe("not_validated");
    expect(M.activationGate({ validated: true }, false, 0)).toBeNull();
  });
});

describe("orders and refunds", () => {
  const f = (x: Partial<M.OrderFilters>) => ({ ...M.emptyOrderFilters(), ...x });
  it("filters: the site never takes Stars, the Mini App never takes Payme / Click / Uzum", () => {
    expect(M.orderFiltersProblem(f({ channel: "web", provider: "telegram_stars" }))).toBe("channel_provider");
    expect(M.orderFiltersProblem(f({ channel: "miniapp", provider: "payme" }))).toBe("channel_provider");
    expect(M.orderFiltersProblem(f({ channel: "renewal", provider: "telegram_stars" }))).toBeNull();
    expect(M.orderFiltersProblem(f({ order_no: "0" }))).toBe("order_no");
    expect(M.orderFiltersProblem(f({ provider_txn_id: "a b" }))).toBe("txn");
    expect(M.orderFiltersProblem(f({ account_id: "nope" }))).toBe("account");
    expect(M.orderFiltersProblem(f({ from: "2026-11-20", to: "2026-11-19" }))).toBe("to_before_from");
    expect(M.providersOf("web")).toEqual(["payme", "click", "uzum"]);
    expect(M.providersOf("miniapp")).toEqual(["telegram_stars"]);
  });
  it("the method by provider: Stars and Click at once, Payme and Uzum in the cabinet", () => {
    expect(M.refundMethod("telegram_stars")).toBe("api");
    expect(M.refundMethod("click")).toBe("api");
    expect(M.refundMethod("payme")).toBe("cabinet");
    expect(M.refundMethod("uzum")).toBe("cabinet");
  });
  it("Click refunds a payment of the current month of Tashkent, on the 1st — the previous one too", () => {
    const now = Date.parse("2026-11-20T10:00:00Z");
    expect(M.clickWindowOpen("2026-11-02T08:00:00Z", now)).toBe(true);
    expect(M.clickWindowOpen("2026-10-31T20:00:00Z", now)).toBe(true); // 1 Nov 01:00 in Tashkent
    expect(M.clickWindowOpen("2026-10-30T10:00:00Z", now)).toBe(false);
    expect(M.clickWindowOpen("2026-10-30T10:00:00Z", Date.parse("2026-11-01T05:00:00Z"))).toBe(true);
    expect(M.clickWindowOpen("2026-09-30T10:00:00Z", Date.parse("2026-11-01T05:00:00Z"))).toBe(false);
    expect(M.clickWindowOpen(null, now)).toBe(false);
  });
  it("the Idempotency-Key signature of a refund: the order and the body, never a status or a version", () => {
    expect(M.refundSig(ORDER, REASON, false)).toBe(M.refundSig(ORDER, REASON, false));
    expect(M.refundSig(ORDER, REASON, true)).not.toBe(M.refundSig(ORDER, REASON, false));
  });
  it("routes: #/payments/orders/<uuid>, #/payments/refunds, #/tariffs/v/<n>", () => {
    expect(parsePayRoute(`orders/${ORDER.toUpperCase()}`)).toEqual({ tab: "orders", order: ORDER });
    expect(parsePayRoute("orders/<script>")).toEqual({ tab: "orders", order: null });
    expect(parsePayRoute("refunds")).toEqual({ tab: "refunds", order: null });
    expect(parsePayRoute(null)).toEqual({ tab: "orders", order: null });
    expect(parseTariffRoute("v/7")).toBe(7);
    expect(parseTariffRoute("v/-1")).toBeNull();
    expect(parseTariffRoute("v/1e3")).toBeNull();
    expect(parseTariffRoute(null)).toBeNull();
  });
});

describe("adjustments and degradation", () => {
  const form = (x: Partial<M.AdjustmentForm>) => ({ ...M.emptyAdjustment(PERIOD), reason: REASON, ...x });
  it("minutes ±1..10 000 to a period; a negative one not below the balance; the reason 10..500 after trimming", () => {
    expect(M.adjustmentBody(form({ minutes: "+30" }), 100).body).toEqual({ kind: "minutes", minutes: 30, period_id: PERIOD, reason: REASON });
    expect(M.adjustmentBody(form({ minutes: "−20", period_id: PERIOD.toUpperCase() }), 100).body).toEqual({ kind: "minutes", minutes: -20, period_id: PERIOD, reason: REASON });
    expect(codes(M.adjustmentBody(form({ minutes: "-120" }), 100).issues)).toEqual(["minutes:below_zero"]);
    expect(codes(M.adjustmentBody(form({ minutes: "0" }), 100).issues)).toEqual(["minutes:minutes_range"]);
    expect(codes(M.adjustmentBody(form({ minutes: "10001" }), null).issues)).toEqual(["minutes:minutes_range"]);
    expect(codes(M.adjustmentBody(form({ minutes: "5", period_id: "" }), null).issues)).toEqual(["period_id:period_required"]);
    expect(codes(M.adjustmentBody(form({ minutes: "5", reason: "  коротко " }), null).issues)).toEqual(["reason:reason_short"]);
  });
  it("a grant: days 1..90 and minutes > 0; a revocation: a period", () => {
    expect(M.adjustmentBody(form({ kind: "grant_period", days: "30", minutes: "300" }), null).body).toEqual({ kind: "grant_period", days: 30, minutes: 300, reason: REASON });
    expect(codes(M.adjustmentBody(form({ kind: "grant_period", days: "91", minutes: "0" }), null).issues)).toEqual(["days:days_range", "minutes:grant_minutes"]);
    expect(M.adjustmentBody(form({ kind: "revoke_period" }), null).body).toEqual({ kind: "revoke_period", period_id: PERIOD, reason: REASON });
  });
  it("the signature of a request: the same body after a lost answer — the same key", () => {
    const b = M.adjustmentBody(form({ minutes: "30" }), null).body!;
    expect(M.adjustmentSig(ACC, b)).toBe(M.adjustmentSig(ACC, { ...b }));
    expect(M.adjustmentSig(ACC, b)).not.toBe(M.adjustmentSig(ACC, { ...b, minutes: 31 }));
  });
  it("degradation: 1 ≤ economy ≤ paid_only ≤ 100", () => {
    const d = (x: Partial<M.DegradationForm>) => M.degradationProblem({ mode: "auto", manual_level: "normal", economy: "80", paid_only: "95", ...x });
    expect(d({})).toBeNull();
    expect(d({ economy: "0" })).toBe("economy");
    expect(d({ paid_only: "101" })).toBe("paid_only");
    expect(d({ economy: "96" })).toBe("order");
  });
  it("reconciliation details are one short line", () => {
    expect(M.detailsLine({ order_no: 1042, amount_tiyin: 4_900_000, nested: { a: 1 } })).toBe('order_no: 1042 · amount_tiyin: 4900000 · nested: {"a":1}');
    expect(M.detailsLine({ x: "y".repeat(400) }).length).toBe(300);
  });
});

/* ---------------------------------------------------------------- screens */

type Handler = (method: string, path: string, body: unknown) => { status: number; body?: unknown } | undefined;
let handler: Handler = () => undefined;
const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string>; query?: URLSearchParams }> = [];
beforeEach(() => {
  calls.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const path = url.pathname.replace("/admin/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body, headers: (init?.headers ?? {}) as Record<string, string>, query: url.searchParams });
    const r = handler(init?.method ?? "GET", path, body) ?? { status: 404, body: { code: "NOT_FOUND", message: "", trace_id: "", details: {} } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  });
  api.setCsrf("csrf-test");
  api.hooks = {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const session = (perms: Permission[]): Session => {
  const set = new Set(perms);
  return { me: null, can: (p) => set.has(p), canAny: (ps) => ps.some((p) => set.has(p)), refreshMe: async () => null, setMe: () => undefined, signOut: async () => undefined, reloadTheme: async () => undefined, themeVersion: null, adminLayout: null };
};
const ui = (node: ReactNode, perms: Permission[]) =>
  render(
    <I18nProvider initial="ru">
      <SessionCtx.Provider value={session(perms)}>
        <ToastProvider>{node}</ToastProvider>
      </SessionCtx.Provider>
    </I18nProvider>,
  );
const err = (status: number, code: string, details: Record<string, unknown> = {}) => ({ status, body: { code, message: "", trace_id: "", details } });

describe("«Корректировки» on the screen: four eyes", () => {
  const adj = (id: string, p: Partial<Adjustment>): Adjustment => ({
    adjustment_id: id, account_id: ACC, kind: "minutes", minutes: 30, days: null, period_id: PERIOD, reason: REASON, status: "pending",
    requested_by: { staff_id: ME, name: "Дилноза" }, requested_at: "2026-11-27T09:00:00Z", decided_by: null, decided_at: null, decision_note: null,
    before_value: null, after_value: null, expires_at: "2026-11-30T09:00:00Z", can_decide: false, can_cancel: false, ...p,
  });
  const mine = adj("f8100000-0000-4000-8000-000000000001", { can_cancel: true });
  const theirs = adj("f8100000-0000-4000-8000-000000000002", { requested_by: { staff_id: OTHER, name: "Тимур" }, can_decide: true });
  it("the author sees «Отозвать» and no «Подтвердить»; another staff member approves with a key, the repeat after a lost answer keeps it", async () => {
    let posts = 0;
    handler = (m, p) => {
      if (p === "/billing/adjustments" && m === "GET") return { status: 200, body: { items: [mine, theirs], next_cursor: null } };
      if (p === `/billing/adjustments/${theirs.adjustment_id}/approve`) return ++posts === 1 ? err(502, "UPSTREAM_UNAVAILABLE", { service: "billing" }) : { status: 200, body: { ...theirs, status: "applied", can_decide: false, decided_by: { staff_id: ME, name: "Дилноза" } } };
      return undefined;
    };
    ui(<AdjustmentsPage />, ["billing.read", "billing.approve", "subscriptions.override"]);
    await screen.findByTestId(`adj-${mine.adjustment_id}`);
    expect(screen.queryByTestId(`adj-approve-${mine.adjustment_id}`)).toBeNull();
    expect(screen.queryByTestId(`adj-reject-${mine.adjustment_id}`)).toBeNull();
    expect(screen.getByTestId(`adj-cancel-${mine.adjustment_id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`adj-own-${mine.adjustment_id}`)).toHaveTextContent("подтверждает другой");
    fireEvent.click(screen.getByTestId(`adj-approve-${theirs.adjustment_id}`));
    const dlg = await screen.findByTestId("adj-approve-dialog");
    expect(dlg).toHaveTextContent("+30 мин к периоду");
    fireEvent.click(within(dlg).getByTestId("adj-dialog-ok"));
    expect(await within(dlg).findByRole("alert")).toBeInTheDocument();
    fireEvent.click(within(dlg).getByTestId("adj-dialog-ok"));
    await waitFor(() => expect(screen.queryByTestId("adj-approve-dialog")).toBeNull());
    const keys = calls.filter((c) => c.method === "POST").map((c) => c.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({});
  });
  it("#/adjustments/<account_id>: the requests of one account (account_id goes to billing); «Все аккаунты» drops the filter", async () => {
    expect(parseAdjustmentsRoute(ACC.toUpperCase())).toBe(ACC);
    expect(parseAdjustmentsRoute("x")).toBeNull();
    handler = (m, p) => (p === "/billing/adjustments" && m === "GET" ? { status: 200, body: { items: [mine], next_cursor: null } } : undefined);
    ui(<AdjustmentsPage routeId={ACC} />, ["billing.read"]);
    expect(await screen.findByTestId("adj-account")).toHaveTextContent("Заявки аккаунта");
    await screen.findByTestId(`adj-${mine.adjustment_id}`);
    const get = calls.find((c) => c.path === "/billing/adjustments")!;
    expect(get.query?.get("account_id")).toBe(ACC);
    expect(get.query?.get("status")).toBe("pending");
  });
  it("without billing.approve a pending request of someone else waits for another staff member", async () => {
    handler = (m, p) => (p === "/billing/adjustments" && m === "GET" ? { status: 200, body: { items: [{ ...theirs, can_decide: false }], next_cursor: null } } : undefined);
    ui(<AdjustmentsPage />, ["billing.read"]);
    expect(await screen.findByTestId(`adj-wait-${theirs.adjustment_id}`)).toHaveTextContent("ждёт другого сотрудника");
    expect(screen.queryByTestId(`adj-approve-${theirs.adjustment_id}`)).toBeNull();
  });
});

describe("«Возврат» on the screen", () => {
  const card: AdminOrderCard = {
    order_id: ORDER, order_no: 1042, status: "fulfilled", channel: "web", provider: "payme", product_code: "til_100", product_kind: "til_pack", product_title: { ru: "100 тилов", uz: "100 til" },
    currency: "UZS", amount_tiyin: 500_000, amount_stars: null, account_id: ACC, beneficiary_id: ACC, created_at: "2026-11-27T09:00:00Z", expires_at: "2026-11-28T09:00:00Z",
    paid_at: "2026-11-27T09:01:00Z", fulfilled_at: "2026-11-27T09:01:01Z", closed_at: null, offer_version: "1.0", locale: "ru", start_mode: null, stars_mode: null, product_snapshot: {},
    transactions: [{ txn_id: TXN, seq: 1, provider: "payme", provider_txn_id: "6385a1b2c3", state: "performed", cancel_reason: null, provider_reason: null, amount_tiyin: 500_000, amount_stars: null, provider_time: null, created_at: "2026-11-27T09:00:30Z", performed_at: "2026-11-27T09:01:00Z", cancelled_at: null }],
    receipts: [], refunds: [], stars_subscription: null, provider_calls: [], can_refund: true,
  };
  const refund: AdminRefund = {
    refund_id: "f8200000-0000-4000-8000-000000000001", order_id: ORDER, order_no: 1042, txn_id: TXN, provider: "payme", amount_tiyin: 500_000, amount_stars: null, status: "awaiting_provider",
    initiated_by: "staff", method: "provider_cabinet", reason: REASON, requested_by: { staff_id: ME, name: "Дилноза" }, requested_at: "2026-11-28T10:00:00Z", completed_at: null, failure_code: null,
    tils_check: { til: 100, til_balance: 20, status: "spent" }, instruction: { provider: "payme", provider_txn_id: "6385a1b2c3", amount_tiyin: 500_000 },
  };
  it("a til pack with spent tils: billing refuses, the force needs a second confirmation; the cabinet instruction is shown", async () => {
    handler = (m, p, b) => {
      if (p === "/billing/orders" && m === "GET") return { status: 200, body: { items: [card], next_cursor: null } };
      if (p === `/billing/orders/${ORDER}` && m === "GET") return { status: 200, body: card };
      if (p === `/billing/orders/${ORDER}/refunds`) return (b as { force?: boolean }).force ? { status: 201, body: refund } : err(409, "REFUND_NOT_ALLOWED", { reason: "tils_spent", til: 100, til_balance: 20 });
      return undefined;
    };
    ui(<PaymentsPage routeId={`orders/${ORDER}`} />, ["billing.read", "billing.refund"]);
    fireEvent.click(await screen.findByTestId("pay-refund"));
    const dlg = await screen.findByTestId("pay-refund-dialog");
    expect(dlg).toHaveTextContent("в кабинете Payme");
    expect(within(dlg).getByTestId("pay-refund-tils")).toBeInTheDocument();
    expect(within(dlg).getByTestId("pay-refund-what")).toHaveTextContent("5 000 сум");
    fireEvent.change(within(dlg).getByLabelText(/Причина/), { target: { value: REASON } });
    fireEvent.click(within(dlg).getByTestId("confirm-ok"));
    expect(await within(dlg).findByTestId("pay-refund-spent")).toHaveTextContent("куплено 100, на балансе 20");
    expect(within(dlg).getByTestId("confirm-ok")).toBeDisabled();
    fireEvent.click(within(dlg).getByTestId("pay-refund-force"));
    expect(within(dlg).getByTestId("confirm-ok")).toHaveTextContent("Вернуть всё равно");
    fireEvent.click(within(dlg).getByTestId("confirm-ok"));
    expect(await screen.findByTestId("pay-refund-instruction")).toHaveTextContent("6385a1b2c3");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.body)).toEqual([{ reason: REASON }, { reason: REASON, force: true }]);
    // two different commands — two keys; each one a UUID
    expect(posts[0]!.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts[1]!.headers["Idempotency-Key"]).not.toBe(posts[0]!.headers["Idempotency-Key"]);
  });
  it("without billing.refund the card names the right instead of the button", async () => {
    handler = (_m, p) => (p === `/billing/orders/${ORDER}` ? { status: 200, body: card } : p === "/billing/orders" ? { status: 200, body: { items: [], next_cursor: null } } : undefined);
    ui(<PaymentsPage routeId={`orders/${ORDER}`} />, ["billing.read"]);
    expect(await screen.findByTestId("pay-refund-ro")).toHaveTextContent("billing.refund");
    expect(screen.queryByTestId("pay-refund")).toBeNull();
  });
});

describe("overview block «Деньги»", () => {
  const off = (service: string) => ({ available: false, data: null, service });
  const d: Dashboard = {
    period: "today", generated_at: "2026-11-28T10:00:00Z", learners: off("user-admin"), support: off("support"), whats_new: off("experience-config"), campaigns: off("notifications"),
    content: off("catalog"), diagnostics: off("diagnostics"), lessons: off("lessons"), ai: off("ai-gateway"), memory: off("memory"), game: off("gamification"), social: off("social"),
    money: { available: true, data: { period: "today", web_revenue_tiyin: 14_700_000, stars_revenue_stars: 1250, orders_paid: 4, refunds: 1, active_subscriptions: 37, trials_started: 6, recon_open: 2, ai_cap_used_pct: null } },
  };
  it("sums and Stars side by side, never summed; the AI cap without ai-gateway is «нет данных»; reconciliation links with billing.read", async () => {
    handler = (_m, p) => (p === "/dashboard" ? { status: 200, body: d } : undefined);
    ui(<Overview />, ["dashboard.read"]);
    expect(await screen.findByTestId("dmoney-web")).toHaveTextContent("147 000 сум");
    expect(screen.getByTestId("dmoney-stars")).toHaveTextContent("⭐ 1 250");
    expect(screen.getByTestId("dmoney-ai-na")).toHaveTextContent("нет данных");
    expect(screen.queryByTestId("dmoney-recon-link")).toBeNull();
    expect(screen.queryByTestId("dmoney-payments")).toBeNull();
    cleanup();
    ui(<Overview />, ["dashboard.read", "billing.read"]);
    expect(await screen.findByTestId("dmoney-recon-link")).toHaveTextContent("2");
    expect(screen.getByTestId("att-recon")).toBeInTheDocument();
  });
  it("the block is down alone", async () => {
    handler = (_m, p) => (p === "/dashboard" ? { status: 200, body: { ...d, money: off("billing") } } : undefined);
    ui(<Overview />, ["dashboard.read"]);
    expect(await screen.findByTestId("block-money-off")).toHaveTextContent("billing");
  });
});
