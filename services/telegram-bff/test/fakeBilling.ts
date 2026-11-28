/**
 * Подделка billing для тестов BFF (INTERNAL_API спринта 8 §1.3, §1.5, §1.11, §1.17): API ученика
 * `/internal/v1/me/billing/*`. Аккаунт — из `sub`, ученик — из claim `lrn`, канал — claim `chn` (без него — 401
 * USER_CONTEXT_MISSING: отказ внутренней авторизации, BFF отвечает 503).
 *
 * Ответы — формы домена ПЛЮС поля, которых в Mini App быть не должно (анти-стиринг): цены сайта в тийинах, фиатные
 * провайдеры, ссылки оплаты вне Telegram, фискальные данные, источник периода, комментарии сотрудников, а в списке заказов
 * — заказ сайта (Payme, сумы). BFF обязан всё это отбросить (контрактный тест test/billing.test.ts). Переключатели — для
 * проверки строгости и веток ошибок.
 */
import type * as C from "@tilhero/contracts/bff";
import type { Req } from "./helpers.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, details: Record<string, unknown> = {}, message = `domain says ${code}`) =>
  json(status, { code, message, trace_id: "domain-trace", details });

/** Метки того, что не должно попасть в ответы Mini App ни в каком виде. */
export const WEB_PAY_HOST = "pay.tilhero-web.example";
export const FORBIDDEN_IN_MINIAPP =
  /(?<![a-z])(tiyin|payme|paycom|click|uzum|checkout|receipt|fiscal|ikpu|uzs)(?![a-z])|soʻm|(?<!\p{L})сум(?!\p{L})|pay\.tilhero|STAFF-NOTE|дешевле|на сайте/iu;
export const STAFF_NOTE = "BILLING-STAFF-NOTE-88";

const AT = "2026-11-22T09:00:00Z";
const ENDS = "2026-12-22T09:00:00Z";
export const OFFER = { version: "1.0", url: "https://miniapp.tilhero.test/legal/offer" };

interface Product {
  code: string;
  kind: "subscription" | "til_pack";
  days?: number;
  minutes?: number;
  til?: number;
  stars: number | null;
  mode: "one_time" | "subscription";
  tiyin: number | null;
  title: string;
}

export const PRODUCTS: Product[] = [
  { code: "plus_30d", kind: "subscription", days: 30, minutes: 300, stars: 250, mode: "subscription", tiyin: 4_900_000, title: "TilHero Плюс — 30 дней" },
  { code: "plus_90d", kind: "subscription", days: 90, minutes: 900, stars: 650, mode: "one_time", tiyin: 12_900_000, title: "TilHero Плюс — 90 дней" },
  { code: "til_100", kind: "til_pack", til: 100, stars: 25, mode: "one_time", tiyin: 500_000, title: "100 тилов" },
  // товар только сайта (цены в Stars нет) — в Mini App не показывается
  { code: "til_1200", kind: "til_pack", til: 1200, stars: null, mode: "one_time", tiyin: 5_000_000, title: "1 200 тилов" },
];

interface Order {
  order_no: number;
  account: string;
  status: C.BillingOrderStatus;
  channel: "miniapp" | "renewal" | "web";
  product: Product;
  beneficiary: string;
  provider: string;
  key: string;
  paid_at: string | null;
}

interface Account {
  trialUsed: boolean;
  status: C.SubscriptionStatus;
  stars: { status: C.StarsSubscriptionStatus; auto_renew: boolean } | null;
}

export class FakeBilling {
  // ---------------------------------------------------------------- переключатели
  salesEnabled = true;
  /** право платить у аккаунта (18+ или 14–17 с согласием) */
  canPay = true;
  consentRequired = false;
  /** billing вернул каталог с офертой на домене сайта оплаты (BFF — 503) */
  offerUrl = OFFER.url;
  /** в списке заказов — заказ сайта (Payme, сумы): BFF обязан отбросить */
  webOrderInList = true;
  /** следующий POST orders — 503 STARS_UNAVAILABLE (заказ создан, ссылки нет) */
  starsUnavailableOnce = false;
  /** следующий POST orders — ответ заказом сайта (ошибка billing: BFF — 503, а не утечка) */
  answerWebOrderOnce = false;
  /** ошибки с «грязными» details и текстом про другой способ оплаты — BFF оставляет только поля контракта */
  dirtyErrors = true;
  /** ссылка на счёт не t.me (BFF — null) */
  badInvoiceLink = false;
  /** подписка: ответ без minutes_exhausted (§16 добавил поле; BFF выводит его сам) */
  omitMinutesExhausted = false;

  readonly accounts = new Map<string, Account>();
  readonly orders: Order[] = [];
  private seq = 1000;
  private readonly idem = new Map<string, number>();

  acc(id: string): Account {
    let a = this.accounts.get(id);
    if (!a) {
      a = { trialUsed: false, status: "none", stars: null };
      this.accounts.set(id, a);
    }
    return a;
  }

  /** Заказ сайта (канал web) у аккаунта — не должен попасть в Mini App. */
  addWebOrder(account: string): number {
    const no = ++this.seq;
    this.orders.push({ order_no: no, account, status: "fulfilled", channel: "web", product: PRODUCTS[0]!, beneficiary: account, provider: "payme", key: `web-${no}`, paid_at: AT });
    return no;
  }

  private productDomain(p: Product) {
    return {
      code: p.code,
      kind: p.kind,
      status: "on_sale",
      sort: 10,
      title: { ru: p.title, uz: `${p.title} (uz)` },
      description: p.kind === "subscription" ? { ru: "Уроки с ИИ и уроки вдвоём", uz: "AI bilan darslar" } : null,
      ...(p.kind === "subscription" ? { days: p.days, minutes: p.minutes, features: ["ai_lessons", "pair_lessons"] } : { til: p.til }),
      // цена канала miniapp — {stars, mode}; у товара только сайта — форма канала web
      price: p.stars != null ? { stars: p.stars, mode: p.mode, tiyin: p.tiyin } : { tiyin: p.tiyin },
      price_tiyin: p.tiyin,
      providers: ["payme", "click", "uzum"],
      fiscal: { ikpu: "10305008002000000", package_code: "1500170", receipt_title: "TilHero Plus 30" },
      audiences: ["teens", "adults"],
    };
  }

  private orderDomain(o: Order) {
    const web = o.channel === "web";
    return {
      order_no: o.order_no,
      status: o.status,
      channel: o.channel,
      product: { code: o.product.code, kind: o.product.kind, title: { ru: o.product.title, uz: `${o.product.title} (uz)` } },
      currency: web ? "UZS" : "XTR",
      amount_tiyin: web ? o.product.tiyin : null,
      amount_stars: web ? null : o.product.stars,
      provider: o.provider,
      invoice_link: o.status === "pending" && !web ? (this.badInvoiceLink ? `https://${WEB_PAY_HOST}/orders/${o.order_no}` : `https://t.me/$inv${o.order_no}`) : null,
      checkout_url: web ? `https://checkout.paycom.uz/abc${o.order_no}` : null,
      receipt_url: web ? `https://ofd.soliq.uz/check?t=${o.order_no}` : null,
      expires_at: "2026-11-22T10:00:00Z",
      created_at: AT,
      paid_at: o.paid_at,
      refund: null,
      beneficiary_id: o.beneficiary,
      provider_txn_id: `tx-${o.order_no}`,
    };
  }

  private subscriptionDomain(account: string, lrn: string) {
    const a = this.acc(account);
    const has = a.status === "trial" || a.status === "active";
    const period = has
      ? { starts_at: AT, ends_at: ENDS, minutes_granted: a.status === "trial" ? 60 : 300, minutes_spent: 12, minutes_held: 3, minutes_left: a.status === "trial" ? 45 : 285, overage: 0, source: "web", price_tiyin: 4_900_000, provider: "payme" }
      : null;
    return {
      status: a.status,
      plan: has ? { code: a.status === "trial" ? "trial" : "plus_30d", title: { ru: "TilHero Плюс", uz: "TilHero Plus" }, price_tiyin: 4_900_000 } : null,
      period,
      next_period: a.status === "active" ? { days: 90, minutes_granted: 900, starts_at: null, source: "web", provider: "click", amount_tiyin: 12_900_000 } : null,
      features: has ? ["ai_lessons", "pair_lessons"] : [],
      expiring: false,
      ...(this.omitMinutesExhausted ? {} : { minutes_exhausted: false }),
      payer_required: lrn !== account,
      can_pay: lrn === account && this.canPay,
      trial_available: !a.trialUsed && a.status !== "active",
      sales_enabled: this.salesEnabled,
      stars_subscription: a.stars ? { ...a.stars, expires_at: ENDS, amount_stars: 250, first_charge_id: "stxCHARGE-1", telegram_user_id: 900001 } : null,
      web_pay_url: `https://${WEB_PAY_HOST}/`,
    };
  }

  private dirty(code: string, details: Record<string, unknown>, status: number) {
    if (!this.dirtyErrors) return err(status, code, details);
    return err(status, code, { ...details, price_tiyin: 4_900_000, alternative: "payme", url: `https://${WEB_PAY_HOST}/` }, `${code}: дешевле на сайте через Payme`);
  }

  route(r: Req): Response | null {
    if (!r.path.startsWith("/internal/v1/me/billing")) return null;
    const account = r.subject;
    const lrn = r.claims.lrn;
    if (!account || typeof lrn !== "string") return err(401, "USER_CONTEXT_MISSING");
    if (r.claims.chn !== "miniapp" && r.claims.chn !== "web") return err(401, "USER_CONTEXT_MISSING");
    const childProfile = lrn !== account;
    const a = this.acc(account);
    const path = r.path.slice("/internal/v1/me/billing".length);

    if (r.method === "GET" && path === "/catalog") {
      return json(200, {
        sales_enabled: this.salesEnabled,
        providers: this.salesEnabled ? ["telegram_stars", "payme"] : [],
        offer: { version: OFFER.version, url: this.offerUrl },
        trial: childProfile ? null : { available: !a.trialUsed, days: 7, minutes: 60 },
        products: childProfile ? [] : PRODUCTS.map((p) => this.productDomain(p)),
        payer_required: childProfile,
        can_pay: !childProfile && this.canPay,
        consent_required: this.consentRequired,
        web_pay_url: `https://${WEB_PAY_HOST}/`,
        merchant: { tin: "123456789" },
      });
    }
    if (r.method === "GET" && path === "/subscription") return json(200, this.subscriptionDomain(account, lrn));
    if (r.method === "GET" && path === "/minutes") {
      const items = [
        { at: AT, kind: "debit", minutes: -3, ref_kind: "session", learner: "self", period_id: "p-1", comment: STAFF_NOTE, staff_id: "s-1" },
        { at: AT, kind: "adjust", minutes: 30, ref_kind: "adjustment", learner: null, period_id: "p-1", comment: STAFF_NOTE },
        { at: AT, kind: "grant", minutes: 300, ref_kind: "order", learner: null, period_id: "p-1", order_no: 5, provider: "click" },
        // не по контракту — элемент отбрасывается
        { at: AT, kind: "bonus", minutes: 1, ref_kind: "order", learner: null, period_id: "p-1" },
      ];
      return json(200, { items, next_cursor: r.query.cursor ? null : "c2" });
    }
    if (r.method === "GET" && path === "/orders") {
      const mine = this.orders.filter((o) => o.account === account && (this.webOrderInList || o.channel !== "web"));
      return json(200, { items: mine.map((o) => this.orderDomain(o)), next_cursor: null });
    }
    let m = /^\/orders\/(\d+)$/.exec(path);
    if (r.method === "GET" && m) {
      const o = this.orders.find((x) => x.order_no === Number(m![1]) && x.account === account);
      return o ? json(200, this.orderDomain(o)) : err(404, "ORDER_NOT_FOUND");
    }
    m = /^\/orders\/(\d+)\/cancel$/.exec(path);
    if (r.method === "POST" && m) {
      const o = this.orders.find((x) => x.order_no === Number(m![1]) && x.account === account);
      if (!o) return err(404, "ORDER_NOT_FOUND");
      if (o.status !== "pending") return this.dirty("ORDER_STATE", { status: o.status }, 409);
      o.status = "cancelled";
      return json(200, this.orderDomain(o));
    }
    if (r.method === "POST" && path === "/trial") {
      if (childProfile) return err(403, "PAYER_REQUIRED");
      if (!this.canPay) return err(403, "GUARDIAN_CONSENT_REQUIRED");
      const k = `trial:${r.headers["idempotency-key"]}`;
      if (this.idem.has(k)) return json(201, this.subscriptionDomain(account, lrn));
      if (a.trialUsed) return this.dirty("TRIAL_USED", {}, 409);
      a.trialUsed = true;
      a.status = "trial";
      this.idem.set(k, 1);
      return json(201, this.subscriptionDomain(account, lrn));
    }
    if (r.method === "POST" && path === "/orders") {
      if (childProfile) return err(403, "PAYER_REQUIRED");
      const b = r.body as C.BillingOrderRequest;
      if (b.provider !== "telegram_stars") return err(422, "PROVIDER_NOT_ALLOWED");
      if (!this.salesEnabled) return this.dirty("PAYMENTS_DISABLED", {}, 409);
      const p = PRODUCTS.find((x) => x.code === b.product_code);
      if (!p) return err(404, "PRODUCT_NOT_FOUND");
      if (p.stars == null) return this.dirty("PRODUCT_NOT_AVAILABLE", {}, 409);
      if (b.offer_version !== OFFER.version) return this.dirty("OFFER_VERSION_MISMATCH", { current: OFFER.version }, 409);
      if (p.mode === "subscription" && a.status === "trial" && !b.confirm_forfeit) {
        return this.dirty("FORFEIT_CONFIRMATION_REQUIRED", { minutes_left: 45, days_left: 5 }, 409);
      }
      if (p.mode === "subscription" && a.status === "active") return this.dirty("ACTIVE_PERIOD_EXISTS", { ends_at: ENDS }, 409);
      const key = String(r.headers["idempotency-key"] ?? "");
      const seen = this.idem.get(`order:${key}`);
      if (seen !== undefined) return json(200, this.orderDomain(this.orders.find((o) => o.order_no === seen)!));
      const order: Order = {
        order_no: ++this.seq,
        account,
        status: "pending",
        channel: "miniapp",
        product: p,
        beneficiary: b.beneficiary_id ?? account,
        provider: "telegram_stars",
        key,
        paid_at: null,
      };
      this.orders.push(order);
      this.idem.set(`order:${key}`, order.order_no);
      if (this.starsUnavailableOnce) {
        this.starsUnavailableOnce = false;
        return this.dirty("STARS_UNAVAILABLE", {}, 503);
      }
      if (this.answerWebOrderOnce) {
        this.answerWebOrderOnce = false;
        return json(201, this.orderDomain({ ...order, channel: "web", provider: "payme" }));
      }
      return json(201, this.orderDomain(order));
    }
    if (r.method === "POST" && path === "/stars-subscription") {
      if (!a.stars) return err(404, "STARS_SUBSCRIPTION_NOT_FOUND");
      const on = !!(r.body as { auto_renew?: unknown }).auto_renew;
      a.stars = { status: on ? "active" : "canceled", auto_renew: on };
      return json(200, this.subscriptionDomain(account, lrn));
    }
    return err(404, "NOT_FOUND");
  }

  /** Оплата заказа (как successful_payment): подписка — период и подписка Stars; тилы — paid. */
  pay(orderNo: number): void {
    const o = this.orders.find((x) => x.order_no === orderNo)!;
    o.status = o.product.kind === "til_pack" ? "paid" : "fulfilled";
    o.paid_at = AT;
    if (o.product.kind === "subscription") {
      const a = this.acc(o.account);
      a.status = "active";
      if (o.product.mode === "subscription") a.stars = { status: "active", auto_renew: true };
    }
  }
}
