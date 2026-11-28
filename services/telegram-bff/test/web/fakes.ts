/**
 * Подделки доменов для /web/v1 (через fetchImpl buildApp): identity-consent (поток D: Telegram ID → аккаунт, /me) и
 * billing (поток A: /internal/v1/me/billing/*). Как настоящие домены, проверяют внутренний JWT (aud, iss telegram-bff) и
 * записывают каждый вызов (путь, sub, claims, заголовки, тело) — тесты проверяют канал `chn: "web"` и субъекта.
 */
import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { verifyInternalToken } from "@tilhero/ts-common";
import { INTERNAL_SECRET, domainError, json } from "../helpers.js";

export const IDENTITY_ORIGIN = "http://identity.test";
export const BILLING_ORIGIN = "http://billing.test";

export interface WebCall {
  service: "identity" | "billing";
  method: string;
  path: string;
  query: Record<string, string>;
  subject: string | undefined;
  claims: Record<string, unknown>;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeAccount {
  telegramId: number;
  accountId: string;
  displayName: string;
  ageBand: "6-9" | "10-13" | "14-17" | "18+" | null;
  guardianConsent: "not_required" | "pending" | "granted" | "declined";
  status: "ACTIVE" | "DISABLED" | "DELETION_REQUESTED";
  children: Array<{ learner_id: string; display_name: string; age_band: "6-9" | "10-13" }>;
}

type Handler = (c: WebCall) => Response | Promise<Response>;

const loc = (ru: string, uz: string) => ({ ru, uz });

/** Каталог billing канала web (форма INTERNAL_API §1.17): сумы — тийины; «чужой» товар только со Stars — для фильтра. */
export function billingCatalog(): Record<string, unknown> {
  return {
    sales_enabled: true,
    providers: ["payme", "click", "telegram_stars"],
    offer: { version: "2026-11-22", url: "https://miniapp.tilhero.test/offer" },
    products: [
      {
        code: "plus_30d",
        kind: "subscription",
        title: loc("Плюс на 30 дней", "Plus 30 kun"),
        description: loc("Уроки с ИИ и уроки вдвоём", "SI bilan darslar"),
        days: 30,
        minutes: 300,
        features: ["ai_lessons", "pair_lessons"],
        til: null,
        price: { tiyin: 4_900_000 },
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
        code: "stars_only",
        kind: "til_pack",
        title: loc("Только Stars", "Faqat Stars"),
        description: null,
        days: null,
        minutes: null,
        features: [],
        til: 50,
        price: { stars: 250, mode: "one_time" },
      },
    ],
    payer_required: false,
    can_pay: true,
    consent_required: false,
    trial: { available: true, days: 7, minutes: 60 },
  };
}

export function billingSubscription(): Record<string, unknown> {
  return {
    status: "active",
    plan: { code: "plus_30d", title: loc("Плюс на 30 дней", "Plus 30 kun") },
    period: {
      starts_at: "2026-11-01T00:00:00Z",
      ends_at: "2026-12-01T00:00:00Z",
      minutes_granted: 300,
      minutes_spent: 40,
      minutes_held: 5,
      minutes_left: 255,
      overage: 0,
    },
    next_period: null,
    features: ["ai_lessons", "pair_lessons"],
    expiring: false,
    minutes_exhausted: false,
    payer_required: false,
    can_pay: true,
    trial_available: false,
    sales_enabled: true,
    stars_subscription: { status: "active", auto_renew: true, expires_at: "2026-12-01T00:00:00Z", amount_stars: 500 },
  };
}

export class FakeWebDomains {
  readonly calls: WebCall[] = [];
  readonly byTg = new Map<number, FakeAccount>();
  readonly byId = new Map<string, FakeAccount>();
  readonly orders = new Map<number, Record<string, unknown> & { owner: string }>();
  readonly idem = new Map<string, number>();
  readonly down = new Set<"identity" | "billing">();
  private readonly overrides = new Map<string, Handler>();
  private orderSeq = 1000;

  addAccount(o: Partial<FakeAccount> & { telegramId: number }): FakeAccount {
    const a: FakeAccount = {
      accountId: randomUUID(),
      displayName: "Игорь",
      ageBand: "18+",
      guardianConsent: "not_required",
      status: "ACTIVE",
      children: [],
      ...o,
    };
    this.byTg.set(a.telegramId, a);
    this.byId.set(a.accountId, a);
    return a;
  }

  /** Подмена обработчика: key = "service METHOD /path". */
  override(service: "identity" | "billing", method: string, path: string, h: Handler): void {
    this.overrides.set(`${service} ${method} ${path}`, h);
  }

  billingCalls(): WebCall[] {
    return this.calls.filter((c) => c.service === "billing");
  }

  /** Заказ сайта (форма Order billing §1.3). */
  webOrder(owner: string, o: Partial<Record<string, unknown>> = {}): Record<string, unknown> & { owner: string } {
    const order_no = ++this.orderSeq;
    const order = {
      owner,
      order_no,
      status: "pending",
      product: { code: "plus_30d", kind: "subscription", title: loc("Плюс на 30 дней", "Plus 30 kun") },
      currency: "UZS",
      amount_tiyin: 4_900_000,
      amount_stars: null,
      provider: "payme",
      invoice_link: null,
      checkout_url: `https://checkout.paycom.uz/${Buffer.from(`m=test;ac.order_no=${order_no}`).toString("base64")}`,
      expires_at: "2026-11-22T13:00:00Z",
      created_at: "2026-11-22T12:00:00Z",
      paid_at: null,
      receipt_url: null,
      refund: null,
      ...o,
    };
    this.orders.set(order_no, order);
    return order;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const service = url.origin === IDENTITY_ORIGIN ? "identity" : url.origin === BILLING_ORIGIN ? "billing" : null;
    if (!service) throw new TypeError(`unknown upstream ${url.origin}`);
    if (this.down.has(service)) throw new TypeError("fetch failed: ECONNREFUSED");
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const token = headers["x-internal-token"] ?? "";
    let subject: string | undefined;
    try {
      const v = await verifyInternalToken(token, INTERNAL_SECRET, service === "identity" ? "identity-consent" : "billing", new Set(["telegram-bff"]));
      subject = v.subject;
    } catch (err) {
      const e = err as { status?: number; code?: string };
      return domainError(e.status ?? 401, e.code ?? "INTERNAL_TOKEN_INVALID");
    }
    const call: WebCall = {
      service,
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      subject,
      claims: decodeJwt(token) as Record<string, unknown>,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    this.calls.push(call);
    const ov = this.overrides.get(`${service} ${call.method} ${call.path}`);
    if (ov) return ov(call);
    return service === "identity" ? this.identity(call) : this.billing(call);
  };

  private identity(c: WebCall): Response {
    const m = /^\/internal\/v1\/telegram-users\/(\d+)\/account$/.exec(c.path);
    if (c.method === "GET" && m) {
      if (c.subject !== undefined) return domainError(403, "CALLER_NOT_ALLOWED");
      const a = this.byTg.get(Number(m[1]));
      if (!a) return domainError(404, "USER_NOT_FOUND");
      return json(200, { account_id: a.accountId, age_band: a.ageBand, guardian_consent: a.guardianConsent, status: a.status });
    }
    if (c.method === "GET" && c.path === "/internal/v1/me") {
      const a = c.subject ? this.byId.get(c.subject) : undefined;
      if (!a) return domainError(404, "USER_NOT_FOUND");
      return json(200, {
        user: {
          user_id: a.accountId,
          display_name: a.displayName,
          username: "secret_tg_username",
          locale: "ru",
          status: a.status,
          is_new: false,
          age_band: a.ageBand,
          guardian_consent: a.guardianConsent,
        },
        security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null },
        consent: {},
        settings: {},
        learners: [
          { learner_id: a.accountId, kind: "self", display_name: a.displayName, age_band: a.ageBand, is_active: true, onboarding_completed: true, voice_consent: false },
          ...a.children.map((ch) => ({ ...ch, kind: "child", is_active: false, onboarding_completed: true, voice_consent: false })),
        ],
      });
    }
    return domainError(404, "NOT_FOUND");
  }

  private billing(c: WebCall): Response {
    if (c.claims.chn !== "web" || c.claims.lrn !== c.subject) return domainError(403, "PROVIDER_NOT_ALLOWED");
    const owner = c.subject ?? "";
    if (c.method === "GET" && c.path === "/internal/v1/me/billing/catalog") return json(200, billingCatalog());
    if (c.method === "GET" && c.path === "/internal/v1/me/billing/subscription") return json(200, billingSubscription());
    if (c.method === "GET" && c.path === "/internal/v1/me/billing/orders") {
      const items = [...this.orders.values()].filter((o) => o.owner === owner).reverse();
      return json(200, { items: items.map(({ owner: _o, ...rest }) => rest), next_cursor: null });
    }
    const one = /^\/internal\/v1\/me\/billing\/orders\/(\d+)$/.exec(c.path);
    if (c.method === "GET" && one) {
      const o = this.orders.get(Number(one[1]));
      if (!o || o.owner !== owner) return domainError(404, "ORDER_NOT_FOUND");
      const { owner: _o, ...rest } = o;
      return json(200, rest);
    }
    const cancel = /^\/internal\/v1\/me\/billing\/orders\/(\d+)\/cancel$/.exec(c.path);
    if (c.method === "POST" && cancel) {
      const o = this.orders.get(Number(cancel[1]));
      if (!o || o.owner !== owner) return domainError(404, "ORDER_NOT_FOUND");
      if (o.status !== "pending") return domainError(409, "ORDER_STATE", { status: o.status });
      o.status = "cancelled";
      o.checkout_url = null;
      const { owner: _o, ...rest } = o;
      return json(200, rest);
    }
    if (c.method === "POST" && c.path === "/internal/v1/me/billing/orders") {
      const key = c.headers["idempotency-key"];
      if (!key) return domainError(422, "IDEMPOTENCY_KEY_REQUIRED");
      const prev = this.idem.get(key);
      if (prev !== undefined) {
        const { owner: _o, ...rest } = this.orders.get(prev)!;
        return json(200, rest);
      }
      const body = c.body as { product_code: string; provider: string };
      if (body.provider !== "payme" && body.provider !== "click" && body.provider !== "uzum") return domainError(422, "PROVIDER_NOT_ALLOWED");
      const o = this.webOrder(owner, { provider: body.provider, product: { code: body.product_code, kind: "subscription", title: loc("Плюс", "Plus") } });
      this.idem.set(key, o.order_no as number);
      const { owner: _o, ...rest } = o;
      return json(201, rest);
    }
    return domainError(404, "NOT_FOUND");
  }
}
