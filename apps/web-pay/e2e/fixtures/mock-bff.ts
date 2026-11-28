/**
 * Mock BFF сайта оплаты (/api/* → telegram-bff /web/v1/*) через page.route: сессия (cookie изображается флагом),
 * CSRF, каталог в тийинах, подписка, заказы с опросом статуса, страницы провайдеров (Payme, Click) — заглушки.
 * Типы — только packages/contracts/src/web.ts. Все данные — тестовые.
 */
import type { Page, Route } from "@playwright/test";
import type { Page as ApiPage, WebCatalog, WebLoginError, WebMe, WebOrder, WebOrderRequest, WebSubscriptionView } from "@tilhero/contracts/web";

export const CSRF = "csrf_test_token_0123456789abcdefghijklmnopq";
export const SELF_ID = "11111111-1111-4111-8111-111111111111";
export const CHILD_ID = "22222222-2222-4222-8222-222222222222";
export const PROVIDER_HOSTS = ["checkout.paycom.uz", "my.click.uz", "www.uzumbank.uz"];

const loc = (ru: string, uz: string) => ({ ru, uz });

export function meFixture(o: Partial<WebMe["account"]> = {}): WebMe {
  return {
    account: { age_band: "18+", can_pay: true, consent_required: false, ...o },
    learners: [
      { learner_id: SELF_ID, kind: "self", display: "Игорь" },
      { learner_id: CHILD_ID, kind: "child", display: "Малыш" },
    ],
    csrf_token: CSRF,
  };
}

export function catalogFixture(): WebCatalog {
  return {
    sales_enabled: true,
    providers: ["payme", "click", "uzum"],
    offer: { version: "2026-11-22", url: "https://miniapp.tilhero.test/offer" },
    products: [
      {
        code: "plus_30d",
        kind: "subscription",
        title: loc("Плюс на 30 дней", "Plus — 30 kun"),
        description: loc("Уроки с ИИ и уроки вдвоём", "SI bilan va juftlikda darslar"),
        days: 30,
        minutes: 300,
        features: ["ai_lessons", "pair_lessons"],
        til: null,
        price: { tiyin: 4_900_000 },
      },
      {
        code: "plus_90d",
        kind: "subscription",
        title: loc("Плюс на 90 дней", "Plus — 90 kun"),
        description: null,
        days: 90,
        minutes: 900,
        features: ["ai_lessons", "pair_lessons"],
        til: null,
        price: { tiyin: 12_900_000 },
      },
      {
        code: "til_100",
        kind: "til_pack",
        title: loc("100 тилов", "100 til"),
        description: null,
        days: null,
        minutes: null,
        features: [],
        til: 100,
        price: { tiyin: 500_000 },
      },
      {
        code: "til_1200",
        kind: "til_pack",
        title: loc("1 200 тилов", "1 200 til"),
        description: null,
        days: null,
        minutes: null,
        features: [],
        til: 1200,
        price: { tiyin: 5_000_000 },
      },
    ],
    payer_required: false,
    can_pay: true,
    consent_required: false,
  };
}

export function activeSubscription(): WebSubscriptionView {
  return {
    status: "active",
    plan: { code: "plus_30d", title: loc("Плюс на 30 дней", "Plus — 30 kun") },
    period: {
      starts_at: "2026-11-10T00:00:00Z",
      ends_at: "2026-12-10T00:00:00Z",
      minutes_granted: 300,
      minutes_spent: 120,
      minutes_held: 0,
      minutes_left: 180,
      overage: 0,
    },
    next_period: null,
    features: ["ai_lessons", "pair_lessons"],
    expiring: false,
    minutes_exhausted: false,
    payer_required: false,
    can_pay: true,
    sales_enabled: true,
  };
}

export function noSubscription(): WebSubscriptionView {
  return {
    status: "none",
    plan: null,
    period: null,
    next_period: null,
    features: [],
    expiring: false,
    minutes_exhausted: false,
    payer_required: false,
    can_pay: true,
    sales_enabled: true,
  };
}

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Scenario {
  loggedIn?: boolean;
  me?: WebMe;
  catalog?: WebCatalog;
  subscription?: WebSubscriptionView;
  orders?: WebOrder[];
  /** итог входа: null — успех, иначе код ошибки в ?login_error= */
  loginOutcome?: WebLoginError | null;
  /** сколько опросов заказа до «оплачен», затем «выполнен» */
  pollsToPaid?: number;
  /** ответить ошибкой на ближайший «METHOD /path» */
  failOnce?: Record<string, { status: number; code: string; details?: Record<string, unknown> }>;
  /** размер страницы истории заказов */
  pageSize?: number;
}

export function orderFixture(o: Partial<WebOrder> & { order_no: number }): WebOrder {
  return {
    status: "pending",
    product: { code: "plus_30d", kind: "subscription", title: loc("Плюс на 30 дней", "Plus — 30 kun") },
    currency: "UZS",
    amount_tiyin: 4_900_000,
    provider: "payme",
    checkout_url: `https://checkout.paycom.uz/bT10ZXN0O2FjLm9yZGVyX25vPSR7b30=`,
    expires_at: "2026-11-22T13:00:00Z",
    created_at: "2026-11-22T12:00:00Z",
    paid_at: null,
    receipt_url: null,
    refund: null,
    ...o,
  };
}

export class MockBff {
  loggedIn: boolean;
  me: WebMe;
  catalog: WebCatalog;
  subscription: WebSubscriptionView;
  orders: WebOrder[];
  loginOutcome: WebLoginError | null;
  pollsToPaid: number;
  failOnce: NonNullable<Scenario["failOnce"]>;
  pageSize: number;
  readonly requests: Recorded[] = [];
  private readonly polls = new Map<number, number>();
  private readonly idem = new Map<string, number>();
  private seq = 2000;

  constructor(s: Scenario = {}) {
    this.loggedIn = s.loggedIn ?? true;
    this.me = s.me ?? meFixture();
    this.catalog = s.catalog ?? catalogFixture();
    this.subscription = s.subscription ?? activeSubscription();
    this.orders = s.orders ?? [];
    this.loginOutcome = s.loginOutcome ?? null;
    this.pollsToPaid = s.pollsToPaid ?? 1;
    this.failOnce = { ...(s.failOnce ?? {}) };
    this.pageSize = s.pageSize ?? 20;
  }

  posts(path?: string): Recorded[] {
    return this.requests.filter((r) => r.method === "POST" && (path === undefined || r.path === path));
  }

  async install(page: Page): Promise<this> {
    await page.route("**/api/**", (route) => this.handle(route));
    // страницы провайдеров и Telegram — заглушки (реальная сеть в тестах не используется)
    await page.route(/^https:\/\/(checkout\.paycom\.uz|my\.click\.uz|www\.uzumbank\.uz|oauth\.telegram\.org)\//, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>provider</title><h1>Provider checkout (mock)</h1>" }),
    );
    return this;
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();
    let body: unknown = undefined;
    try {
      body = req.postData() ? JSON.parse(req.postData() ?? "") : undefined;
    } catch {
      body = req.postData();
    }
    const headers = await req.allHeaders();
    this.requests.push({ method, path: `${path}${url.search}`, headers, body });

    const json = (status: number, data: unknown) =>
      route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(data) });
    const error = (status: number, code: string, details: Record<string, unknown> = {}) =>
      json(status, { code, message: code, trace_id: "e2e", details });

    // вход: изображает весь путь OIDC (Telegram → callback → cookie) одним перенаправлением
    if (method === "GET" && path === "/auth/start") {
      if (this.loginOutcome === null) this.loggedIn = true;
      return route.fulfill({ status: 302, headers: { location: this.loginOutcome ? `/?login_error=${this.loginOutcome}` : "/" } });
    }
    if (method === "POST" && path === "/auth/logout") {
      if (this.loggedIn && headers["x-csrf-token"] !== CSRF) return error(403, "CSRF_INVALID");
      this.loggedIn = false;
      return route.fulfill({ status: 204 });
    }

    const fail = this.failOnce[`${method} ${path}`];
    if (fail) {
      delete this.failOnce[`${method} ${path}`];
      return error(fail.status, fail.code, fail.details ?? {});
    }
    if (!this.loggedIn) return error(401, "SESSION_EXPIRED");
    if (method === "POST" && (headers["x-csrf-token"] !== CSRF || headers["origin"] !== url.origin)) return error(403, "CSRF_INVALID");

    if (method === "GET" && path === "/me") return json(200, this.me);
    if (method === "GET" && path === "/catalog") return json(200, this.catalog);
    if (method === "GET" && path === "/subscription") return json(200, this.subscription);
    if (method === "GET" && path === "/orders") {
      const all = [...this.orders].sort((a, b) => b.order_no - a.order_no);
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const items = all.slice(start, start + this.pageSize);
      const next = start + this.pageSize < all.length ? String(start + this.pageSize) : null;
      return json(200, { items, next_cursor: next } satisfies ApiPage<WebOrder>);
    }
    const one = /^\/orders\/(\d+)$/.exec(path);
    if (method === "GET" && one) {
      const o = this.orders.find((x) => x.order_no === Number(one[1]));
      if (!o) return error(404, "ORDER_NOT_FOUND");
      this.advance(o);
      return json(200, o);
    }
    const cancel = /^\/orders\/(\d+)\/cancel$/.exec(path);
    if (method === "POST" && cancel) {
      const o = this.orders.find((x) => x.order_no === Number(cancel[1]));
      if (!o) return error(404, "ORDER_NOT_FOUND");
      if (o.status !== "pending") return error(409, "ORDER_STATE", { status: o.status });
      o.status = "cancelled";
      o.checkout_url = null;
      return json(200, o);
    }
    if (method === "POST" && path === "/orders") {
      const key = headers["idempotency-key"] ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(key)) return error(422, "IDEMPOTENCY_KEY_REQUIRED");
      const prev = this.idem.get(key);
      if (prev !== undefined) return json(200, this.orders.find((o) => o.order_no === prev));
      const r = body as WebOrderRequest;
      if (!this.me.account.can_pay) return error(403, this.me.account.consent_required ? "GUARDIAN_CONSENT_REQUIRED" : "PAYER_REQUIRED");
      if (r.offer_version !== this.catalog.offer.version) return error(409, "OFFER_VERSION_MISMATCH", { current: this.catalog.offer.version });
      const product = this.catalog.products.find((p) => p.code === r.product_code);
      if (!product) return error(404, "PRODUCT_NOT_FOUND");
      const order_no = ++this.seq;
      const checkout =
        r.provider === "click"
          ? `https://my.click.uz/services/pay?service_id=1&merchant_id=2&amount=${product.price.tiyin / 100}.00&transaction_param=${order_no}`
          : r.provider === "uzum"
            ? `https://www.uzumbank.uz/open-service?serviceId=1&order=${order_no}`
            : `https://checkout.paycom.uz/${Buffer.from(`m=test;ac.order_no=${order_no};a=${product.price.tiyin}`).toString("base64")}`;
      const o = orderFixture({
        order_no,
        product: { code: product.code, kind: product.kind, title: product.title },
        amount_tiyin: product.price.tiyin,
        provider: r.provider,
        checkout_url: checkout,
      });
      this.orders.push(o);
      this.idem.set(key, order_no);
      return json(201, o);
    }
    return error(404, "NOT_FOUND");
  }

  /** Опрос заказа: pending → paid (после pollsToPaid опросов) → fulfilled (следующий опрос). */
  private advance(o: WebOrder): void {
    if (o.status !== "pending" && o.status !== "paid") return;
    if (o.status === "pending" && o.checkout_url === null) return;
    const n = (this.polls.get(o.order_no) ?? 0) + 1;
    this.polls.set(o.order_no, n);
    if (o.status === "paid") {
      o.status = "fulfilled";
      o.receipt_url = "https://ofd.soliq.uz/check?t=TEST&r=1&c=20261122120500&s=1";
    } else if (n > this.pollsToPaid && this.pollsToPaid >= 0) {
      o.status = "paid";
      o.paid_at = "2026-11-22T12:05:00Z";
      o.checkout_url = null;
    }
  }
}

/** Порог «опрос никогда не подтвердит» для pending-заказов. */
export const NEVER = -1;
