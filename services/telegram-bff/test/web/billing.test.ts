/**
 * Сайт оплаты → billing (канал web, INTERNAL_API §3, §1.3, §1.17): sub = lrn = аккаунт, chn = web; только сумы и
 * Payme/Click/Uzum; заказы только сайта; плательщик (дети не платят, подростки — с согласием родителя), получатель тилов;
 * Idempotency-Key; billing недоступен → 503 BILLING_UNAVAILABLE.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeRedis, domainError, json } from "../helpers.js";
import { P, login, makeWebHarness, writeHeaders, type WebHarness } from "./harness.js";

let h: WebHarness;
beforeEach(async () => {
  h = await makeWebHarness();
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const order = { product_code: "plus_30d", provider: "payme", start_mode: "after_current", offer_version: "2026-11-22" } as const;
const idem = () => ({ "idempotency-key": randomUUID() });

describe("каталог и подписка", () => {
  it("GET /catalog: только сумы (тийины) и Payme/Click/Uzum; товар только со Stars и пробный не попадают; claims chn web", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    const r = await h.app.inject({ url: `${P}/catalog`, headers: { cookie: l.cookie } });
    expect(r.statusCode).toBe(200);
    const c = r.json();
    expect(c.providers).toEqual(["payme", "click"]);
    expect(c.products.map((p: { code: string }) => p.code)).toEqual(["plus_30d", "til_100"]);
    expect(c.products[0].price).toEqual({ tiyin: 4_900_000 });
    expect(c).not.toHaveProperty("trial");
    expect(JSON.stringify(c)).not.toMatch(/stars|telegram_stars|XTR/i);
    const call = h.fake.billingCalls()[0]!;
    expect(call.path).toBe("/internal/v1/me/billing/catalog");
    expect(call.subject).toBe(acc.accountId);
    expect(call.claims).toMatchObject({ iss: "telegram-bff", aud: "billing", sub: acc.accountId, lrn: acc.accountId, chn: "web" });
  });

  it("цена не целая / вне 100..10¹¹ тийинов — товар не показывается", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    const base = { kind: "til_pack", title: { ru: "x", uz: "x" }, description: null, days: null, minutes: null, features: [], til: 1 };
    h.fake.override("billing", "GET", "/internal/v1/me/billing/catalog", () =>
      json(200, {
        sales_enabled: true,
        providers: ["click"],
        offer: { version: "v1", url: "javascript:alert(1)" },
        products: [
          { ...base, code: "a", price: { tiyin: 4_900_000.5 } },
          { ...base, code: "b", price: { tiyin: 99 } },
          { ...base, code: "c", price: { tiyin: 100_000_000_001 } },
          { ...base, code: "d", price: { tiyin: "4900000" } },
          { ...base, code: "e", price: { tiyin: 100 } },
        ],
        payer_required: false,
        can_pay: true,
        consent_required: false,
      }),
    );
    const c = (await h.app.inject({ url: `${P}/catalog`, headers: { cookie: l.cookie } })).json();
    expect(c.products.map((p: { code: string }) => p.code)).toEqual(["e"]);
    // ссылка оферты — только https
    expect(c.offer.url).toBe("");
  });

  it("GET /subscription: без подписки Stars и пробного", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    const s = (await h.app.inject({ url: `${P}/subscription`, headers: { cookie: l.cookie } })).json();
    expect(s.status).toBe("active");
    expect(s.period.minutes_left).toBe(255);
    expect(s).not.toHaveProperty("stars_subscription");
    expect(s).not.toHaveProperty("trial_available");
  });

  it("billing недоступен / BILLING_URL не задан → 503 BILLING_UNAVAILABLE; неожиданная форма ответа → 503", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    h.fake.down.add("billing");
    const r = await h.app.inject({ url: `${P}/catalog`, headers: { cookie: l.cookie } });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: "BILLING_UNAVAILABLE" });
    h.fake.down.delete("billing");
    h.fake.override("billing", "GET", "/internal/v1/me/billing/subscription", () => json(200, { status: "weird" }));
    const bad = await h.app.inject({ url: `${P}/subscription`, headers: { cookie: l.cookie } });
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toMatchObject({ code: "BILLING_UNAVAILABLE" });
    h.fake.override("billing", "GET", "/internal/v1/me/billing/orders", () => domainError(500, "INTERNAL_ERROR"));
    expect((await h.app.inject({ url: `${P}/orders`, headers: { cookie: l.cookie } })).json()).toMatchObject({ code: "BILLING_UNAVAILABLE" });
    // billing отказал во внутренней авторизации — клиенту не 403, а 503
    h.fake.override("billing", "GET", "/internal/v1/me/billing/catalog", () => domainError(403, "CALLER_NOT_ALLOWED"));
    expect((await h.app.inject({ url: `${P}/catalog`, headers: { cookie: l.cookie } })).statusCode).toBe(503);

    await h.close();
    h = await makeWebHarness({ BILLING_URL: "" });
    const acc2 = h.fake.addAccount({ telegramId: 1 });
    const l2 = await login(h, acc2);
    const r2 = await h.app.inject({ url: `${P}/catalog`, headers: { cookie: l2.cookie } });
    expect(r2.statusCode).toBe(503);
    expect(r2.json()).toMatchObject({ code: "BILLING_UNAVAILABLE" });
  });
});

describe("заказы", () => {
  it("POST /orders → 201, Idempotency-Key сквозной (повтор — 200 тот же заказ), тело — как от сайта", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    const key = randomUUID();
    const r = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l, { "idempotency-key": key }), payload: order });
    expect(r.statusCode).toBe(201);
    const o = r.json();
    expect(o).toMatchObject({ status: "pending", currency: "UZS", amount_tiyin: 4_900_000, provider: "payme" });
    expect(o.checkout_url).toMatch(/^https:\/\/checkout\.paycom\.uz\//);
    expect(o).not.toHaveProperty("invoice_link");
    expect(o).not.toHaveProperty("amount_stars");
    const call = h.fake.billingCalls().find((c) => c.method === "POST")!;
    expect(call.headers["idempotency-key"]).toBe(key);
    expect(call.body).toEqual(order);
    expect(call.claims).toMatchObject({ chn: "web", lrn: acc.accountId, sub: acc.accountId });
    const again = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l, { "idempotency-key": key }), payload: order });
    expect(again.statusCode).toBe(200);
    expect(again.json().order_no).toBe(o.order_no);
  });

  it("POST /orders: без Idempotency-Key → 422; лишнее поле / telegram_stars / сумма в теле → 422, billing не вызывается", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    const noKey = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l), payload: order });
    expect(noKey.statusCode).toBe(422);
    expect(noKey.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    for (const payload of [
      { ...order, provider: "telegram_stars" },
      { ...order, amount_tiyin: 100 },
      { ...order, product_code: "PLUS 30" },
      { ...order, beneficiary_id: "not-a-uuid" },
      { product_code: "plus_30d", provider: "payme" },
    ]) {
      const r = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l, idem()), payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect(h.fake.billingCalls()).toEqual([]);
  });

  it("плательщик: подросток без согласия → 403 GUARDIAN_CONSENT_REQUIRED; возраст не выбран → 403 PAYER_REQUIRED; billing не вызывается", async () => {
    const teen = h.fake.addAccount({ telegramId: 1, ageBand: "14-17", guardianConsent: "pending" });
    const l = await login(h, teen);
    const me = (await h.app.inject({ url: `${P}/me`, headers: { cookie: l.cookie } })).json();
    expect(me.account).toEqual({ age_band: "14-17", can_pay: false, consent_required: true });
    const r = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l, idem()), payload: order });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ code: "GUARDIAN_CONSENT_REQUIRED" });

    teen.guardianConsent = "declined";
    expect((await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l, idem()), payload: order })).json()).toMatchObject({
      code: "GUARDIAN_CONSENT_REQUIRED",
    });

    const unknown = h.fake.addAccount({ telegramId: 2, ageBand: null });
    const u = await login(h, unknown);
    expect((await h.app.inject({ url: `${P}/me`, headers: { cookie: u.cookie } })).json().account).toEqual({
      age_band: null,
      can_pay: false,
      consent_required: false,
    });
    const r2 = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(u, idem()), payload: order });
    expect(r2.statusCode).toBe(403);
    expect(r2.json()).toMatchObject({ code: "PAYER_REQUIRED" });
    expect(h.fake.billingCalls().filter((c) => c.method === "POST")).toEqual([]);

    // согласие дали — подросток платит
    teen.guardianConsent = "granted";
    const ok = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l, idem()), payload: order });
    expect(ok.statusCode).toBe(201);
  });

  it("аккаунт с возрастом ребёнка в сессии (возраст изменён поддержкой) → 401 (сессия отозвана), оплаты нет", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    acc.ageBand = "10-13";
    const r = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l, idem()), payload: order });
    expect(r.statusCode).toBe(401);
    expect(h.fake.billingCalls()).toEqual([]);
  });

  it("получатель тилов: свой детский профиль — да; чужой — 403 BENEFICIARY_NOT_ALLOWED без вызова billing", async () => {
    const child = "7f2c1d1e-0000-4000-8000-0000000000aa";
    const acc = h.fake.addAccount({ telegramId: 1, children: [{ learner_id: child, display_name: "Малыш", age_band: "6-9" }] });
    const l = await login(h, acc);
    const til = { product_code: "til_100", provider: "click", beneficiary_id: child.toUpperCase(), offer_version: "2026-11-22" };
    const ok = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l, idem()), payload: til });
    expect(ok.statusCode).toBe(201);
    expect((h.fake.billingCalls().at(-1)!.body as { beneficiary_id: string }).beneficiary_id).toBe(child);
    const self = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l, idem()), payload: { ...til, beneficiary_id: acc.accountId } });
    expect(self.statusCode).toBe(201);
    const n = h.fake.billingCalls().length;
    const foreign = await h.app.inject({
      method: "POST",
      url: `${P}/orders`,
      headers: writeHeaders(l, idem()),
      payload: { ...til, beneficiary_id: randomUUID() },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: "BENEFICIARY_NOT_ALLOWED" });
    expect(h.fake.billingCalls()).toHaveLength(n);
  });

  it("ошибки billing приходят клиенту с кодом и details (409 FORFEIT_CONFIRMATION_REQUIRED, 422 PROVIDER_NOT_ALLOWED, 429 ORDERS_LIMIT)", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    for (const [status, code, details] of [
      [409, "FORFEIT_CONFIRMATION_REQUIRED", { minutes_left: 120, days_left: 9 }],
      [409, "OFFER_VERSION_MISMATCH", { current: "2026-12-01" }],
      [409, "PAYMENTS_DISABLED", {}],
      [422, "PROVIDER_NOT_ALLOWED", {}],
      [429, "ORDERS_LIMIT", {}],
    ] as const) {
      h.fake.override("billing", "POST", "/internal/v1/me/billing/orders", () => domainError(status, code, details));
      const r = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l, idem()), payload: { ...order, start_mode: "now" } });
      expect(r.statusCode).toBe(status);
      expect(r.json()).toMatchObject({ code, details });
    }
  });

  it("история и заказ: только заказы сайта; заказ Stars → 404; чужой → 404; cancel", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const other = h.fake.addAccount({ telegramId: 2 });
    const l = await login(h, acc);
    const mine = h.fake.webOrder(acc.accountId);
    const paid = h.fake.webOrder(acc.accountId, { status: "fulfilled", paid_at: "2026-11-22T12:05:00Z", receipt_url: "https://ofd.soliq.uz/check?t=1" });
    const stars = h.fake.webOrder(acc.accountId, { currency: "XTR", amount_tiyin: null, amount_stars: 250, provider: "telegram_stars" });
    const foreign = h.fake.webOrder(other.accountId);

    const list = (await h.app.inject({ url: `${P}/orders`, headers: { cookie: l.cookie } })).json();
    expect(list.items.map((o: { order_no: number }) => o.order_no)).toEqual([paid.order_no, mine.order_no]);
    expect(list.items[0]).toMatchObject({ checkout_url: null, receipt_url: "https://ofd.soliq.uz/check?t=1" });
    expect(JSON.stringify(list)).not.toMatch(/telegram_stars|XTR|amount_stars|invoice_link/);

    expect((await h.app.inject({ url: `${P}/orders/${stars.order_no}`, headers: { cookie: l.cookie } })).json()).toMatchObject({ code: "ORDER_NOT_FOUND" });
    const f = await h.app.inject({ url: `${P}/orders/${foreign.order_no}`, headers: { cookie: l.cookie } });
    expect(f.statusCode).toBe(404);
    expect(f.json()).toMatchObject({ code: "ORDER_NOT_FOUND" });
    expect((await h.app.inject({ url: `${P}/orders/0`, headers: { cookie: l.cookie } })).statusCode).toBe(422);
    expect((await h.app.inject({ url: `${P}/orders/abc`, headers: { cookie: l.cookie } })).statusCode).toBe(422);

    const one = (await h.app.inject({ url: `${P}/orders/${mine.order_no}`, headers: { cookie: l.cookie } })).json();
    expect(one).toMatchObject({ order_no: mine.order_no, status: "pending", provider: "payme" });

    const c = await h.app.inject({ method: "POST", url: `${P}/orders/${mine.order_no}/cancel`, headers: writeHeaders(l) });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({ status: "cancelled", checkout_url: null });
    const again = await h.app.inject({ method: "POST", url: `${P}/orders/${mine.order_no}/cancel`, headers: writeHeaders(l) });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "ORDER_STATE", details: { status: "cancelled" } });
    const fc = await h.app.inject({ method: "POST", url: `${P}/orders/${foreign.order_no}/cancel`, headers: writeHeaders(l) });
    expect(fc.statusCode).toBe(404);
    expect(other.accountId).not.toBe(acc.accountId);
  });

  it("ссылки заказа: checkout_url / receipt_url не https → null (на сайте нет перехода на javascript:/http)", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    const o = h.fake.webOrder(acc.accountId, { checkout_url: "javascript:alert(1)", receipt_url: "http://ofd.example/check" });
    const r = (await h.app.inject({ url: `${P}/orders/${o.order_no}`, headers: { cookie: l.cookie } })).json();
    expect(r.checkout_url).toBeNull();
    expect(r.receipt_url).toBeNull();
  });

  it("cursor пробрасывается в billing; лишний query → 422", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    await h.app.inject({ url: `${P}/orders?cursor=abc`, headers: { cookie: l.cookie } });
    expect(h.fake.billingCalls().at(-1)!.query).toEqual({ cursor: "abc" });
    expect((await h.app.inject({ url: `${P}/orders?account_id=${randomUUID()}`, headers: { cookie: l.cookie } })).statusCode).toBe(422);
  });
});
