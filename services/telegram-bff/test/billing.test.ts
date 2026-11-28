/**
 * Спринт 8 через BFF — подписка и покупки за Telegram Stars в Mini App (bff.ts «Спринт 8», INTERNAL_API §1.3, §1.5,
 * §1.11, §1.17, §12): каталог, подписка, минуты, заказы Stars, пробный период, автопродление; claims `chn: miniapp`;
 * анти-стиринг (контрактный тест: ни в одном ответе нет тийинов, фиатных провайдеров, ссылок оплаты вне Telegram и
 * заказов сайта); детский профиль; ошибки billing (details — только поля контракта, текст — BFF); 503
 * BILLING_UNAVAILABLE; лимиты tg.billing.*; purchase_available игры.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORBIDDEN_IN_MINIAPP, OFFER, STAFF_NOTE, WEB_PAY_HOST } from "./fakeBilling.js";
import { OTHER_MEMBER } from "./fakeSocial.js";
import { BILLING_ENV, bearer, closeRedis, domainError, idem, login, makeHarness, switchTo, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
async function setup(env: Record<string, string> = {}): Promise<void> {
  h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "1000", ...BILLING_ENV, WEB_PAY_ORIGIN: `https://${WEB_PAY_HOST}`, ...env });
  s = await login(h);
  h.fake.setAge(s.userId, "18+");
  h.fake.onboard(s.userId);
}
beforeEach(() => setup());
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const get = (url: string, token = s.access, headers: Record<string, string> = {}) => h.app.inject({ url, headers: { ...bearer(token), ...headers } });
const post = (url: string, payload?: unknown, headers: Record<string, string> = {}, token = s.access) =>
  h.app.inject({ method: "POST", url, headers: { ...bearer(token), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const billingCalls = (method?: string, path?: string) => h.fake.callsTo("billing", method, path);
const ORDER = { product_code: "plus_90d", provider: "telegram_stars", offer_version: OFFER.version, start_mode: "now" } as const;

async function kid(): Promise<LoggedIn> {
  const child = h.fake.addChild(s.userId, "Мадина", "6-9");
  h.fake.onboard(child);
  return switchTo(h, s, child);
}

describe("каталог и вызов billing", () => {
  it("только товары с ценой в Stars и только telegram_stars; sub = аккаунт, claims lrn, age_band, chn = miniapp; язык счёта — Accept-Language", async () => {
    const res = await get("/v1/billing/catalog", s.access, { "accept-language": "uz" });
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.sales_enabled).toBe(true);
    expect(c.providers).toEqual(["telegram_stars"]);
    expect(c.offer).toEqual(OFFER);
    expect(c.trial).toEqual({ available: true, days: 7, minutes: 60 });
    expect(c.products.map((p: { code: string }) => p.code)).toEqual(["plus_30d", "plus_90d", "til_100"]);
    expect(c.products[0]).toEqual({
      code: "plus_30d",
      kind: "subscription",
      title: { ru: "TilHero Плюс — 30 дней", uz: "TilHero Плюс — 30 дней (uz)" },
      description: { ru: "Уроки с ИИ и уроки вдвоём", uz: "AI bilan darslar" },
      days: 30,
      minutes: 300,
      features: ["ai_lessons", "pair_lessons"],
      til: null,
      price: { stars: 250, mode: "subscription" },
    });
    expect(c.products[2]).toMatchObject({ kind: "til_pack", til: 100, days: null, minutes: null, features: [], price: { stars: 25, mode: "one_time" } });
    expect({ payer_required: c.payer_required, can_pay: c.can_pay, consent_required: c.consent_required }).toEqual({ payer_required: false, can_pay: true, consent_required: false });
    expect(res.body).not.toMatch(FORBIDDEN_IN_MINIAPP);
    expect(res.body).not.toContain(WEB_PAY_HOST);
    expect(res.headers["cache-control"]).toBe("no-store");

    const call = billingCalls("GET", "/internal/v1/me/billing/catalog")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ iss: "telegram-bff", aud: "billing", lrn: s.userId, age_band: "18+", chn: "miniapp" });
    expect(call.headers["accept-language"]).toBe("uz");
  });

  it("детский профиль: без цен, пробного и права платить (даже если billing ошибся); lrn ребёнка, sub — аккаунт", async () => {
    const k = await kid();
    h.fake.billing.canPay = true;
    const c = (await get("/v1/billing/catalog", k.access)).json();
    expect(c).toMatchObject({ products: [], trial: null, payer_required: true, can_pay: false, providers: [] });
    const call = billingCalls("GET", "/internal/v1/me/billing/catalog").at(-1)!;
    expect(call.subject).toBe(s.userId);
    expect(call.claims).toMatchObject({ lrn: k.body.learner.learner_id, age_band: "6-9", chn: "miniapp" });
  });

  it("продажи выключены — sales_enabled false, способов оплаты нет; оферта на сайте оплаты или не https — 503 BILLING_UNAVAILABLE", async () => {
    h.fake.billing.salesEnabled = false;
    expect((await get("/v1/billing/catalog")).json()).toMatchObject({ sales_enabled: false, providers: [] });
    h.fake.billing.salesEnabled = true;
    for (const url of [`${h.config.webPay.origin}/legal/offer`, "http://miniapp.tilhero.test/offer", "javascript:alert(1)"]) {
      h.fake.billing.offerUrl = url;
      const res = await get("/v1/billing/catalog");
      expect([res.statusCode, res.json().code, res.json().details], url).toEqual([503, "BILLING_UNAVAILABLE", { service: "billing" }]);
    }
    expect(h.logs.parsed().some((l) => l.rule === "offer_on_web_pay")).toBe(true);
  });
});

describe("подписка и минуты", () => {
  it("SubscriptionView: статус и минуты без источника и цены периодов вне Mini App; подписка Stars — плательщику", async () => {
    h.fake.billing.acc(s.userId).status = "active";
    h.fake.billing.acc(s.userId).stars = { status: "active", auto_renew: true };
    const res = await get("/v1/billing/subscription");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "active",
      plan: { code: "plus_30d", title: { ru: "TilHero Плюс", uz: "TilHero Plus" } },
      period: { starts_at: "2026-11-22T09:00:00Z", ends_at: "2026-12-22T09:00:00Z", minutes_granted: 300, minutes_spent: 12, minutes_held: 3, minutes_left: 285, overage: 0 },
      next_period: { days: 90, minutes_granted: 900, starts_at: null },
      features: ["ai_lessons", "pair_lessons"],
      expiring: false,
      minutes_exhausted: false,
      payer_required: false,
      can_pay: true,
      trial_available: false,
      sales_enabled: true,
      stars_subscription: { status: "active", auto_renew: true, expires_at: "2026-12-22T09:00:00Z", amount_stars: 250 },
    });
    expect(res.body).not.toMatch(FORBIDDEN_IN_MINIAPP);
    expect(res.body).not.toMatch(/telegram_user_id|first_charge_id|900001|source|web_pay/);
  });

  it("детский профиль: статус семьи без цены подписки Stars; minutes_exhausted выводится, если billing его не прислал", async () => {
    h.fake.billing.acc(s.userId).status = "trial";
    h.fake.billing.acc(s.userId).stars = { status: "active", auto_renew: true };
    h.fake.billing.omitMinutesExhausted = true;
    const k = await kid();
    const v = (await get("/v1/billing/subscription", k.access)).json();
    expect(v).toMatchObject({ status: "trial", stars_subscription: null, can_pay: false, payer_required: true, trial_available: false, minutes_exhausted: false });
    expect(v.period.ends_at).toBe("2026-12-22T09:00:00Z");
  });

  it("история минут: комментарии сотрудников и лишнее отброшены, элемент не по контракту — пропущен; cursor — в billing", async () => {
    const res = await get("/v1/billing/minutes?cursor=c1");
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.items).toEqual([
      { at: "2026-11-22T09:00:00Z", kind: "debit", minutes: -3, ref_kind: "session", learner: "self", period_id: "p-1" },
      { at: "2026-11-22T09:00:00Z", kind: "adjust", minutes: 30, ref_kind: "adjustment", learner: null, period_id: "p-1" },
      { at: "2026-11-22T09:00:00Z", kind: "grant", minutes: 300, ref_kind: "order", learner: null, period_id: "p-1" },
    ]);
    expect(p.next_cursor).toBeNull();
    expect(res.body).not.toContain(STAFF_NOTE);
    expect(res.body).not.toMatch(FORBIDDEN_IN_MINIAPP);
    expect(billingCalls("GET", "/internal/v1/me/billing/minutes")[0]!.query).toEqual({ cursor: "c1" });
    expect((await get("/v1/billing/minutes?limit=5")).statusCode).toBe(422);
  });
});

describe("заказы Stars", () => {
  it("POST: Idempotency-Key обязателен; provider — только telegram_stars; лишнее поле — 422; всё без вызова billing", async () => {
    const none = await post("/v1/billing/orders", ORDER);
    expect([none.statusCode, none.json().code]).toEqual([422, "IDEMPOTENCY_KEY_REQUIRED"]);
    for (const bad of [
      { ...ORDER, provider: "payme" },
      { ...ORDER, provider: "click" },
      { ...ORDER, provider: "uzum" },
      { ...ORDER, amount_stars: 1 },
      { ...ORDER, price_tiyin: 100 },
      { ...ORDER, product_code: "Plus 30" },
      { ...ORDER, beneficiary_id: "child" },
      { ...ORDER, start_mode: "later" },
      { product_code: "plus_30d", provider: "telegram_stars" },
    ]) {
      const res = await post("/v1/billing/orders", bad, idem());
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
    }
    expect(billingCalls()).toHaveLength(0);
  });

  it("заказ → 201 StarsOrder со ссылкой t.me; повтор ключа — 200 тот же заказ; ключ и тело — в billing; получатель — в нижнем регистре", async () => {
    const child = h.fake.addChild(s.userId);
    const key = randomUUID().toUpperCase();
    const body = { product_code: "til_100", provider: "telegram_stars", offer_version: "1.0", beneficiary_id: child.toUpperCase() };
    const a = await post("/v1/billing/orders", body, { "idempotency-key": key });
    expect(a.statusCode).toBe(201);
    const o = a.json();
    expect(o).toEqual({
      order_no: expect.any(Number),
      status: "pending",
      channel: "miniapp",
      product: { code: "til_100", kind: "til_pack", title: { ru: "100 тилов", uz: "100 тилов (uz)" } },
      currency: "XTR",
      amount_stars: 25,
      provider: "telegram_stars",
      invoice_link: `https://t.me/$inv${o.order_no}`,
      expires_at: "2026-11-22T10:00:00Z",
      created_at: "2026-11-22T09:00:00Z",
      paid_at: null,
      refund: null,
    });
    const b = await post("/v1/billing/orders", body, { "idempotency-key": key });
    expect([b.statusCode, b.json()]).toEqual([200, o]);
    const calls = billingCalls("POST", "/internal/v1/me/billing/orders");
    expect(calls.map((c) => c.headers["idempotency-key"])).toEqual([key.toLowerCase(), key.toLowerCase()]);
    expect(calls[0]!.body).toEqual({ product_code: "til_100", provider: "telegram_stars", offer_version: "1.0", beneficiary_id: child });
    expect(calls[0]!.claims).toMatchObject({ chn: "miniapp", lrn: s.userId });
    expect(a.body).not.toMatch(FORBIDDEN_IN_MINIAPP);
  });

  it("история — только заказы Stars: заказ сайта пропущен (лог), по номеру — 404; ссылка не t.me — null", async () => {
    const web = h.fake.billing.addWebOrder(s.userId);
    const o = (await post("/v1/billing/orders", ORDER, idem())).json();
    const list = await get("/v1/billing/orders");
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((x: { order_no: number }) => x.order_no)).toEqual([o.order_no]);
    expect(list.body).not.toMatch(FORBIDDEN_IN_MINIAPP);
    expect(h.logs.parsed().some((l) => l.rule === "stars_only" && l.dropped === 1)).toBe(true);
    const one = await get(`/v1/billing/orders/${web}`);
    expect([one.statusCode, one.json().code]).toEqual([404, "ORDER_NOT_FOUND"]);
    expect((await get(`/v1/billing/orders/${o.order_no}`)).json()).toEqual(o);

    h.fake.billing.badInvoiceLink = true;
    expect((await get(`/v1/billing/orders/${o.order_no}`)).json().invoice_link).toBeNull();
    // неверный номер — 404 без вызова billing
    const n = billingCalls().length;
    for (const bad of ["0", "01", "abc", "1e3", "-5", "9".repeat(16)]) {
      const r = await get(`/v1/billing/orders/${bad}`);
      expect([r.statusCode, r.json().code], bad).toEqual([404, "ORDER_NOT_FOUND"]);
    }
    expect(billingCalls()).toHaveLength(n);
  });

  it("billing ответил на заказ заказом сайта — 503 BILLING_UNAVAILABLE, а не утечка", async () => {
    h.fake.billing.answerWebOrderOnce = true;
    const res = await post("/v1/billing/orders", ORDER, idem());
    expect([res.statusCode, res.json().code]).toEqual([503, "BILLING_UNAVAILABLE"]);
    expect(res.body).not.toMatch(FORBIDDEN_IN_MINIAPP);
  });

  it("ошибки billing: код и статус — как есть, details — только поля контракта, текст — BFF (без «дешевле на сайте»)", async () => {
    h.fake.billing.acc(s.userId).status = "trial";
    const forfeit = await post("/v1/billing/orders", { ...ORDER, product_code: "plus_30d" }, idem());
    expect([forfeit.statusCode, forfeit.json().code, forfeit.json().details]).toEqual([409, "FORFEIT_CONFIRMATION_REQUIRED", { minutes_left: 45, days_left: 5 }]);
    expect(forfeit.json().message).toBe("Подтвердите замену пробного периода");
    h.fake.billing.acc(s.userId).status = "active";
    const active = await post("/v1/billing/orders", { ...ORDER, product_code: "plus_30d" }, idem());
    expect([active.statusCode, active.json().code, active.json().details]).toEqual([409, "ACTIVE_PERIOD_EXISTS", { ends_at: "2026-12-22T09:00:00Z" }]);
    const offer = await post("/v1/billing/orders", { ...ORDER, offer_version: "0.9" }, idem());
    expect([offer.statusCode, offer.json().code, offer.json().details]).toEqual([409, "OFFER_VERSION_MISMATCH", { current: "1.0" }]);
    const site = await post("/v1/billing/orders", { ...ORDER, product_code: "til_1200" }, idem());
    expect([site.statusCode, site.json().code, site.json().details]).toEqual([409, "PRODUCT_NOT_AVAILABLE", {}]);
    h.fake.billing.salesEnabled = false;
    const off = await post("/v1/billing/orders", ORDER, idem());
    expect([off.statusCode, off.json().code, off.json().details]).toEqual([409, "PAYMENTS_DISABLED", {}]);
    for (const r of [forfeit, active, offer, site, off]) {
      expect(r.body).not.toMatch(FORBIDDEN_IN_MINIAPP);
      expect(r.body).not.toContain(WEB_PAY_HOST);
    }
  });

  it("503 STARS_UNAVAILABLE — как есть (заказ pending): повтор тем же ключом даёт заказ со ссылкой", async () => {
    h.fake.billing.starsUnavailableOnce = true;
    const key = idem();
    const first = await post("/v1/billing/orders", ORDER, key);
    expect([first.statusCode, first.json().code, first.json().details]).toEqual([503, "STARS_UNAVAILABLE", {}]);
    expect(first.body).not.toMatch(FORBIDDEN_IN_MINIAPP);
    const again = await post("/v1/billing/orders", ORDER, key);
    expect(again.statusCode).toBe(200);
    expect(again.json().invoice_link).toMatch(/^https:\/\/t\.me\//);
  });

  it("отмена: pending → cancelled; повтор — 409 ORDER_STATE {status}; неверный номер — 404 без вызова", async () => {
    const o = (await post("/v1/billing/orders", ORDER, idem())).json();
    const c = await post(`/v1/billing/orders/${o.order_no}/cancel`);
    expect([c.statusCode, c.json().status, c.json().invoice_link]).toEqual([200, "cancelled", null]);
    const again = await post(`/v1/billing/orders/${o.order_no}/cancel`);
    expect([again.statusCode, again.json().code, again.json().details]).toEqual([409, "ORDER_STATE", { status: "cancelled" }]);
    const bad = await post("/v1/billing/orders/x1/cancel");
    expect([bad.statusCode, bad.json().code]).toEqual([404, "ORDER_NOT_FOUND"]);
  });
});

describe("пробный период и автопродление", () => {
  it("пробный: 201 SubscriptionView; Idempotency-Key обязателен; второй — 409 TRIAL_USED без лишнего", async () => {
    expect((await post("/v1/billing/trial")).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const t = await post("/v1/billing/trial", undefined, idem());
    expect([t.statusCode, t.json().status, t.json().period.minutes_granted]).toEqual([201, "trial", 60]);
    const used = await post("/v1/billing/trial", undefined, idem());
    expect([used.statusCode, used.json().code, used.json().details]).toEqual([409, "TRIAL_USED", {}]);
  });

  it("автопродление: выкл. / вкл.; нет подписки Stars — 404 STARS_SUBSCRIPTION_NOT_FOUND", async () => {
    const none = await post("/v1/billing/stars-subscription", { auto_renew: false });
    expect([none.statusCode, none.json().code]).toEqual([404, "STARS_SUBSCRIPTION_NOT_FOUND"]);
    h.fake.billing.acc(s.userId).status = "active";
    h.fake.billing.acc(s.userId).stars = { status: "active", auto_renew: true };
    const off = await post("/v1/billing/stars-subscription", { auto_renew: false });
    expect(off.json().stars_subscription).toMatchObject({ status: "canceled", auto_renew: false });
    expect(billingCalls("POST", "/internal/v1/me/billing/stars-subscription")[1]!.body).toEqual({ auto_renew: false });
    const on = await post("/v1/billing/stars-subscription", { auto_renew: true });
    expect(on.json().stars_subscription).toMatchObject({ status: "active", auto_renew: true });
    expect((await post("/v1/billing/stars-subscription", { auto_renew: "yes" })).statusCode).toBe(422);
    expect((await post("/v1/billing/stars-subscription", {})).statusCode).toBe(422);
  });
});

describe("детский профиль и недоступность billing", () => {
  it("детский профиль: команды оплаты и история заказов — 403 PAYER_REQUIRED без вызова billing", async () => {
    const k = await kid();
    const n = billingCalls().length;
    const probes = [
      post("/v1/billing/orders", ORDER, idem(), k.access),
      post("/v1/billing/trial", undefined, idem(), k.access),
      post("/v1/billing/orders/1001/cancel", undefined, {}, k.access),
      post("/v1/billing/stars-subscription", { auto_renew: false }, {}, k.access),
      get("/v1/billing/orders", k.access),
      get("/v1/billing/orders/1001", k.access),
    ];
    for (const res of await Promise.all(probes)) expect([res.statusCode, res.json().code]).toEqual([403, "PAYER_REQUIRED"]);
    expect(billingCalls()).toHaveLength(n);
  });

  it("нет BILLING_URL — каждый маршрут 503 BILLING_UNAVAILABLE {service: billing}; billing не отвечает — так же", async () => {
    await h.close();
    await setup({ BILLING_URL: "" });
    const routes = [
      () => get("/v1/billing/catalog"),
      () => get("/v1/billing/subscription"),
      () => get("/v1/billing/minutes"),
      () => get("/v1/billing/orders"),
      () => get("/v1/billing/orders/1001"),
      () => post("/v1/billing/trial", undefined, idem()),
      () => post("/v1/billing/orders", ORDER, idem()),
      () => post("/v1/billing/orders/1001/cancel"),
      () => post("/v1/billing/stars-subscription", { auto_renew: true }),
    ];
    for (const r of routes) {
      const res = await r();
      expect([res.statusCode, res.json().code, res.json().details]).toEqual([503, "BILLING_UNAVAILABLE", { service: "billing" }]);
    }
    await h.close();
    await setup();
    h.fake.down.add("billing");
    for (const r of routes) expect((await r()).json().code).toBe("BILLING_UNAVAILABLE");
    // учёба работает
    expect((await get("/v1/plan/today")).statusCode).toBe(200);
  });

  it("billing ответил не по контракту — 503 BILLING_UNAVAILABLE и строка лога без значений", async () => {
    h.fake.override("billing", "GET", "/internal/v1/me/billing/subscription", () =>
      new Response(JSON.stringify({ status: "gold", price_tiyin: 100 }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const res = await get("/v1/billing/subscription");
    expect([res.statusCode, res.json().code]).toEqual([503, "BILLING_UNAVAILABLE"]);
    const line = h.logs.parsed().find((l) => l.check === "subscription")!;
    expect(line).toMatchObject({ upstream: "billing", upstream_code: "UPSTREAM_BAD_RESPONSE" });
    expect(JSON.stringify(line)).not.toContain("gold");
  });
});

describe("лимиты tg.billing.*", () => {
  it("команды — 10 за 10 минут на аккаунт (детский профиль — тот же счётчик); чтение не тратит лимит команд", async () => {
    for (let i = 0; i < 5; i++) expect((await get("/v1/billing/subscription")).statusCode).toBe(200);
    for (let i = 0; i < 9; i++) expect((await post("/v1/billing/stars-subscription", { auto_renew: true })).statusCode).toBe(404);
    const k = await kid();
    expect((await post("/v1/billing/stars-subscription", { auto_renew: true }, {}, k.access)).json().code).toBe("PAYER_REQUIRED");
    const back = await switchTo(h, k, s.userId);
    const limited = await post("/v1/billing/stars-subscription", { auto_renew: true }, {}, back.access);
    expect([limited.statusCode, limited.json().code]).toEqual([429, "RATE_LIMITED"]);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("игра: purchase_available (спринт 8)", () => {
  it("сводка: true — продажи, право платить, пакет тилов за Stars; false — продажи выключены, детский профиль, billing недоступен", async () => {
    expect((await get("/v1/game/summary")).json().purchase_available).toBe(true);
    expect(billingCalls("GET", "/internal/v1/me/billing/catalog")[0]!.claims).toMatchObject({ chn: "miniapp" });
    h.fake.billing.salesEnabled = false;
    expect((await get("/v1/game/summary")).json().purchase_available).toBe(false);
    h.fake.billing.salesEnabled = true;
    h.fake.billing.canPay = false;
    expect((await get("/v1/game/summary")).json().purchase_available).toBe(false);
    h.fake.billing.canPay = true;
    h.fake.down.add("billing");
    const down = await get("/v1/game/summary");
    expect([down.statusCode, down.json().purchase_available]).toEqual([200, false]);
    h.fake.down.delete("billing");
    const k = await kid();
    const n = billingCalls().length;
    expect((await get("/v1/game/summary", k.access)).json().purchase_available).toBe(false);
    expect(billingCalls()).toHaveLength(n);
  });

  it("INSUFFICIENT_TILS {…, purchase_available} — по каталогу billing; выбор героя и экипировка — тоже со сводкой", async () => {
    const buy = (item_code: string) => post("/v1/game/shop/purchases", { item_code }, idem());
    expect((await buy("bg_forest")).statusCode).toBe(200);
    const poor = await buy("frame_gold");
    expect([poor.statusCode, poor.json().code, poor.json().details]).toEqual([409, "INSUFFICIENT_TILS", { price: 80, balance: 50, missing: 30, purchase_available: true }]);
    h.fake.billing.salesEnabled = false;
    expect((await buy("frame_gold")).json().details.purchase_available).toBe(false);
    h.fake.billing.salesEnabled = true;
    const hero = await h.app.inject({ method: "PUT", url: "/v1/game/hero", headers: bearer(s.access), payload: { hero_code: "robot_0" } });
    expect(hero.json().purchase_available).toBe(true);
  });
});

describe("lessons (поток C): пэйвол урока и урока вдвоём через BFF", () => {
  it("старт урока: ai_locked {reason} и ai_minutes_left — как есть, служебные поля удержания не уходят", async () => {
    h.fake.lessons.paywall = { ai_locked: { reason: "no_subscription" }, ai_minutes_left: null };
    const locked = await post("/v1/lessons/l-a1-01/sessions", undefined, idem());
    expect(locked.statusCode).toBe(201);
    expect(locked.json()).toMatchObject({ ai_locked: { reason: "no_subscription" }, ai_minutes_left: null });
    expect(locked.body).not.toContain("hold-leak");
    await post(`/v1/sessions/${locked.json().session_id}/cancel`);
    h.fake.lessons.paywall = { ai_locked: null, ai_minutes_left: 42 };
    const open = await post("/v1/lessons/l-a1-01/sessions", undefined, idem());
    expect(open.json()).toMatchObject({ ai_locked: null, ai_minutes_left: 42 });
  });

  it("приглашение в урок вдвоём: 403 SUBSCRIPTION_REQUIRED {feature, reason} и 503 BILLING_UNAVAILABLE — как есть", async () => {
    const invite = () =>
      post("/v1/pair-rooms", { partner_member_id: OTHER_MEMBER, pair_id: "ru-en", scenario_id: "sc-cafe-order", start: "now" }, idem());
    for (const reason of ["no_subscription", "feature_not_in_plan", "minutes_exhausted", "kids"]) {
      h.fake.override("lessons", "POST", "/internal/v1/me/pair-rooms", () => domainError(403, "SUBSCRIPTION_REQUIRED", { feature: "pair_lessons", reason }));
      const res = await invite();
      expect([res.statusCode, res.json().code, res.json().details], reason).toEqual([403, "SUBSCRIPTION_REQUIRED", { feature: "pair_lessons", reason }]);
    }
    h.fake.override("lessons", "POST", "/internal/v1/me/pair-rooms", () => domainError(503, "BILLING_UNAVAILABLE", { service: "billing" }));
    const down = await invite();
    expect([down.statusCode, down.json().code]).toEqual([503, "BILLING_UNAVAILABLE"]);
  });
});

describe("анти-стиринг: контрактный тест ответов канала Mini App", () => {
  it("ни один ответ /v1/billing/* (успех и ошибки) не содержит тийинов, фиатных провайдеров, адреса сайта оплаты, служебных данных", async () => {
    h.fake.billing.addWebOrder(s.userId);
    h.fake.billing.acc(s.userId).stars = { status: "active", auto_renew: true };
    const bodies: string[] = [];
    const o = await post("/v1/billing/orders", ORDER, idem());
    bodies.push(o.body);
    for (const url of ["/v1/billing/catalog", "/v1/billing/subscription", "/v1/billing/minutes", "/v1/billing/orders", `/v1/billing/orders/${o.json().order_no}`, "/v1/game/summary"]) {
      bodies.push((await get(url)).body);
    }
    bodies.push((await post("/v1/billing/trial", undefined, idem())).body);
    bodies.push((await post("/v1/billing/trial", undefined, idem())).body); // 409
    bodies.push((await post("/v1/billing/stars-subscription", { auto_renew: false })).body);
    bodies.push((await post(`/v1/billing/orders/${o.json().order_no}/cancel`)).body);
    bodies.push((await post(`/v1/billing/orders/${o.json().order_no}/cancel`)).body); // 409
    bodies.push((await post("/v1/billing/orders", { ...ORDER, offer_version: "0.1" }, idem())).body); // 409
    for (const b of bodies) {
      expect(b).not.toMatch(FORBIDDEN_IN_MINIAPP);
      expect(b).not.toContain(WEB_PAY_HOST);
      expect(b).not.toMatch(/"(amount_tiyin|price_tiyin|checkout_url|receipt_url|providers?)"\s*:\s*"?(payme|click|uzum)/i);
    }
  });
});
