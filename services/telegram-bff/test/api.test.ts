import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { ProfileSchema, SessionResponseSchema, TicketSchema } from "../src/schemas.js";
import { deriveSeed } from "@tilhero/ts-common";
import { INTERNAL_SECRET, ORIGIN, bearer, closeRedis, domainError, json, login, makeHarness, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
beforeEach(async () => {
  h = await makeHarness();
  s = await login(h);
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const auth = () => bearer(s.access);
const get = (url: string, headers: Record<string, string> = auth()) => h.app.inject({ url, headers });
const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = auth()) =>
  h.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("contract coverage", () => {
  it("every endpoint documented in packages/contracts/src/bff.ts is routed", () => {
    const src = readFileSync(new URL("../../../packages/contracts/src/bff.ts", import.meta.url), "utf8");
    const found = new Set<string>();
    for (const m of src.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/[A-Za-z0-9_\-/{}]+)/g)) {
      found.add(`${m[1]} ${m[2]!.replace(/\{(\w+)\}/g, ":$1")}`);
    }
    expect(found.size).toBeGreaterThanOrEqual(35); // спринт 1: 33 эндпоинта + спринт 3: /v1/events, /v1/events/{eventId}
    const missing = [...found].filter((e) => {
      const [method, url] = e.split(" ") as [string, string];
      return !h.app.hasRoute({ method: method as "GET", url });
    });
    expect(missing).toEqual([]);
  });

  it("SessionResponse and Profile match the contract schemas", async () => {
    expect(Value.Check(SessionResponseSchema, s.body)).toBe(true);
    const p = await get("/v1/profile");
    expect(Value.Check(ProfileSchema, p.json())).toBe(true);
  });
});

describe("profile", () => {
  it("GET /v1/profile aggregates identity /me + preferences in parallel, user_id only from the session", async () => {
    h.fake.delays.set("identity", 150);
    h.fake.delays.set("preferences", 150);
    const before = h.fake.calls.length;
    const t0 = performance.now();
    const res = await get("/v1/profile");
    const elapsed = performance.now() - t0;
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["consent", "notifications", "preferences", "security", "user"]);
    expect(body.user.user_id).toBe(s.userId);
    expect(body.user.telegram_user_id).toBeUndefined();
    expect(body.security.pin_required).toBe(false);
    expect(body.preferences.search_horizon_months).toBe(12);
    expect(body.notifications.timezone).toBe("Asia/Tashkent");

    const calls = h.fake.calls.slice(before);
    const me = calls.find((c) => c.service === "identity" && c.path === "/internal/v1/me")!;
    const pr = calls.find((c) => c.service === "preferences" && c.path === "/internal/v1/me/preferences")!;
    expect(me.subject).toBe(s.userId);
    expect(pr.subject).toBe(s.userId);
    expect(Math.abs(me.startedAt - pr.startedAt)).toBeLessThan(50);
    expect(elapsed).toBeLessThan(290);
  });

  it("any domain failing in the aggregation → its error, never a partial profile", async () => {
    h.fake.down.add("preferences");
    const res = await get("/v1/profile");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "preferences" } });
  });

  it("PATCH /v1/profile/settings → Profile", async () => {
    const res = await send("PATCH", "/v1/profile/settings", { locale: "en", notifications: { quiet_hours: { start: "23:00", end: "08:00" } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.locale).toBe("en");
    expect(res.json().notifications.quiet_hours).toEqual({ start: "23:00", end: "08:00" });
    expect((await send("PATCH", "/v1/profile/settings", { notifications: { digest_time: "25:00" } })).statusCode).toBe(422);
  });

  it("disable/enable → Profile with status", async () => {
    expect((await send("POST", "/v1/profile/disable")).json().user.status).toBe("DISABLED");
    expect((await send("POST", "/v1/profile/enable")).json().user.status).toBe("ACTIVE");
  });
});

describe("preferences", () => {
  it("PATCH passes through; version conflict → 409 from domain with details", async () => {
    const ok = await send("PATCH", "/v1/profile/preferences", {
      budget: { currency: "USD", preset: "custom", min: null, max: null, custom_amount: 1500 },
      search_horizon_months: 6,
      version: 1,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ search_horizon_months: 6, version: 2 });
    const conflict = await send("PATCH", "/v1/profile/preferences", { strong_events_outside_geo: true, version: 1 });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "PREFERENCES_VERSION_CONFLICT", details: { current_version: 2 } });
  });

  it("e2e regression: body is forwarded without type coercion (null stays null, '1500' is not a number)", async () => {
    // Mini App шлёт бюджет-пресет полным объектом с null — раньше Ajv (coerceTypes) превращал null в 0,
    // и preferences отвечал 422 budget.custom_amount not_allowed.
    const budget = { currency: "USD", preset: "1000_2000", min: null, max: null, custom_amount: null };
    const res = await send("PATCH", "/v1/profile/preferences", { budget });
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("preferences", "PATCH").at(-1)?.body).toEqual({ budget });
    const multi = { currency: "USD", preset: null, min: 500, max: 2000, custom_amount: null };
    expect((await send("PATCH", "/v1/profile/preferences", { budget: multi })).statusCode).toBe(200);
    expect(h.fake.callsTo("preferences", "PATCH").at(-1)?.body).toEqual({ budget: multi });
    const settings = await send("PATCH", "/v1/profile/settings", { notifications: { quiet_hours: null } });
    expect(settings.statusCode).toBe(200);
    expect(h.fake.callsTo("identity", "PATCH").at(-1)?.body).toEqual({ notifications: { quiet_hours: null } });
    const asString = await send("PATCH", "/v1/profile/preferences", {
      budget: { currency: "USD", preset: "custom", min: null, max: null, custom_amount: "1500" },
    });
    expect(asString.statusCode).toBe(422);
    expect(asString.json()).toMatchObject({ details: { field: "budget.custom_amount" } });
    // querystring по-прежнему приводится к числу
    expect((await get("/v1/directory/airports?q=tash&limit=5")).statusCode).toBe(200);
  });

  it("invalid patch → 422 PREFERENCES_INVALID {field}", async () => {
    const cases: Array<[unknown, string]> = [
      [{ search_horizon_months: 5 }, "search_horizon_months"],
      [{ budget: { currency: "EUR", preset: null, min: null, max: null, custom_amount: null } }, "budget.currency"],
      [{ budget: { currency: "USD", preset: null, min: null, max: null, custom_amount: 10.5 } }, "budget.custom_amount"],
      [{ departures: [] }, "departures"],
      [{ user_id: "someone-else" }, "user_id"],
    ];
    for (const [payload, field] of cases) {
      const res = await send("PATCH", "/v1/profile/preferences", payload);
      expect(res.statusCode, field).toBe(422);
      expect(res.json(), field).toMatchObject({ code: "PREFERENCES_INVALID", details: { field } });
    }
    expect(h.fake.callsTo("preferences", "PATCH")).toHaveLength(0);
  });

  it("departures: upper-cases IATA, unknown airport → 422 AIRPORT_UNKNOWN {iata}, max 10", async () => {
    const ok = await send("PUT", "/v1/profile/departures", { airports: ["tas", "SKD"] });
    expect(ok.json().departures.map((d: { airport_iata: string }) => d.airport_iata)).toEqual(["TAS", "SKD"]);
    const unknown = await send("PUT", "/v1/profile/departures", { airports: ["XXX"] });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ code: "AIRPORT_UNKNOWN", details: { iata: "XXX" } });
    expect((await send("PUT", "/v1/profile/departures", { airports: Array(11).fill("TAS") })).statusCode).toBe(422);
  });

  it("onboarding complete and directories", async () => {
    expect((await send("POST", "/v1/profile/onboarding/complete")).json().onboarding_completed_at).toBeTruthy();
    const airports = await get("/v1/directory/airports?q=tash&limit=5");
    expect(airports.json().items[0].iata).toBe("TAS");
    expect(h.fake.callsTo("preferences", "GET", "/internal/v1/directory/airports").at(-1)?.query).toEqual({ q: "tash", limit: "5" });
    expect((await get("/v1/directory/airports?limit=500")).statusCode).toBe(422);
    expect((await get("/v1/directory/airports?foo=1")).statusCode).toBe(422);
    expect((await get("/v1/directory/interests")).json().items[0].code).toBe("sport.motorsport");
    expect((await get("/v1/directory/geographies")).json().items[0].level).toBe("world");
  });
});

describe("consent & legal", () => {
  it("policy is public; consent requires 18+ confirmation; outdated version passes through", async () => {
    const policy = await h.app.inject({ url: "/v1/legal/policy?lang=en" });
    expect(policy.statusCode).toBe(200);
    expect(policy.json().text).toContain("en");
    expect(policy.headers["cache-control"]).toBe("public, max-age=300");
    expect((await h.app.inject({ url: "/v1/legal/policy?lang=de" })).statusCode).toBe(422);

    const noAge = await send("POST", "/v1/profile/consent", { policy_version: "2026-10-01", purposes: ["core"] });
    expect(noAge.json().code).toBe("AGE_CONFIRMATION_REQUIRED");
    const falseAge = await send("POST", "/v1/profile/consent", { policy_version: "2026-10-01", purposes: ["core"], age_confirmed_18_plus: false });
    expect(falseAge.statusCode).toBe(422);
    expect(falseAge.json().code).toBe("AGE_CONFIRMATION_REQUIRED");

    const outdated = await send("POST", "/v1/profile/consent", { policy_version: "2025-01-01", purposes: ["core"], age_confirmed_18_plus: true });
    expect(outdated.statusCode).toBe(409);
    expect(outdated.json().code).toBe("POLICY_VERSION_OUTDATED");

    const ok = await send("POST", "/v1/profile/consent", { policy_version: "2026-10-01", purposes: ["core"], age_confirmed_18_plus: true });
    expect(ok.json()).toMatchObject({ accepted: true, age_confirmed_18_plus: true });
    expect((await send("DELETE", "/v1/profile/consent")).json().accepted).toBe(false);
  });
});

describe("security endpoints", () => {
  it("biometric requires PIN (409 from domain); enable/disable; remove PIN", async () => {
    const noPin = await send("PUT", "/v1/profile/security/biometric");
    expect(noPin.statusCode).toBe(409);
    expect(noPin.json().code).toBe("PIN_REQUIRED");
    await send("PUT", "/v1/profile/security/pin", { pin: "4826" });
    const bio = await send("PUT", "/v1/profile/security/biometric");
    expect(bio.json()).toMatchObject({ biometric_token: expect.stringMatching(/^bio_/), security: { biometric_enabled: true } });
    expect(bio.headers["cache-control"]).toBe("no-store");
    expect((await send("DELETE", "/v1/profile/security/biometric")).json().biometric_enabled).toBe(false);
    expect((await send("DELETE", "/v1/profile/security/pin", { current_pin: "0000" })).json().code).toBe("PIN_INVALID");
    expect((await send("DELETE", "/v1/profile/security/pin", { current_pin: "4826" })).json().pin_enabled).toBe(false);
  });
});

describe("home & experience config", () => {
  it("config is public and cached; home builds enabled sections (rails from the catalog, the rest pending_data)", async () => {
    const cfg = await h.app.inject({ url: "/v1/experience/config" });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json().version).toBe("2.0.3");
    expect(cfg.headers["cache-control"]).toBe("public, max-age=60");
    const home = await get("/v1/home");
    expect(home.json()).toEqual({
      summary: null,
      sections: [
        { type: "event_carousel", key: "best_for_you", variant: "large", state: "ready", items: [] },
        { type: "watch_changes", key: "watch", variant: "compact", state: "pending_data", items: [] },
        { type: "news_carousel", key: "news", variant: "compact", state: "pending_data", items: [] },
      ],
      generated_at: expect.any(String),
    });
    expect(h.fake.callsTo("experience")).toHaveLength(1); // второй вызов — из кэша
    expect(h.fake.callsTo("experience")[0]?.subject).toBeUndefined();
  });

  it("experience-config outage: stale config is served; nothing cached → config 503, Home still 200 (bundled layout)", async () => {
    const h2 = await makeHarness({ EXPERIENCE_CACHE_SECONDS: "0" });
    try {
      expect((await h2.app.inject({ url: "/v1/experience/config" })).statusCode).toBe(200);
      h2.fake.down.add("experience");
      const stale = await h2.app.inject({ url: "/v1/experience/config" });
      expect(stale.statusCode).toBe(200);
      expect(stale.json().version).toBe("2.0.3");
      expect(h2.logs.text).toContain("serving stale config");
    } finally {
      await h2.close();
    }
    h.fake.down.add("experience");
    const cfg = await h.app.inject({ url: "/v1/experience/config" });
    expect(cfg.statusCode).toBe(503);
    expect(cfg.json().code).toBe("UPSTREAM_UNAVAILABLE");
    const res = await get("/v1/home");
    expect(res.statusCode).toBe(200);
    expect(res.json().sections.map((x: { key: string }) => x.key)).toEqual(["best_for_you", "watch", "sales_soon", "news"]);
  });
});

describe("support", () => {
  const ticket = { category: "TICKET_SOURCE", subject: "Не открывается ссылка на билет", message: "При переходе получаю ошибку" };

  it("Idempotency-Key is required (UUID) → 422 IDEMPOTENCY_KEY_REQUIRED", async () => {
    for (const key of [undefined, "", "abc", "12345678-1234-1234-1234-1234567890zz"]) {
      const headers = { ...auth(), ...(key !== undefined ? { "idempotency-key": key } : {}) };
      const res = await send("POST", "/v1/support/tickets", ticket, headers);
      expect(res.statusCode, String(key)).toBe(422);
      expect(res.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
    expect(h.fake.callsTo("support", "POST")).toHaveLength(0);
  });

  it("creates a ticket (201), forwards the key, a repeat returns the same ticket", async () => {
    const key = randomUUID();
    // offer_id не передаём: с спринта 5 он проверяется в offers и цена/ссылка берутся из снимка (test/offers.test.ts);
    // здесь — сквозная передача контекста события
    const ctx = {
      event_id: "evt_123",
      provider_id: "provider_x",
      deeplink: "https://tickets.example.com/e/123",
      price_snapshot: { amount: "850.00", currency: "USD", fetched_at: "2026-10-08T09:00:00Z" },
      client_version: "telegram-miniapp-2.0",
    };
    const first = await send("POST", "/v1/support/tickets", { ...ticket, context: ctx }, { ...auth(), "idempotency-key": key });
    expect(first.statusCode).toBe(201);
    const t = first.json();
    expect(Value.Check(TicketSchema, t)).toBe(true);
    expect(t.number).toMatch(/^TCK-\d+$/);
    expect(t.context).toMatchObject({ event_id: "evt_123", deeplink: "https://tickets.example.com/e/123" });
    const call = h.fake.callsTo("support", "POST", "/internal/v1/me/tickets")[0]!;
    expect(call.headers["idempotency-key"]).toBe(key);
    expect(call.subject).toBe(s.userId);
    expect(call.body).toEqual({ ...ticket, context: ctx });

    const again = await send("POST", "/v1/support/tickets", { ...ticket, context: ctx }, { ...auth(), "idempotency-key": key.toUpperCase() });
    expect(again.statusCode).toBe(201);
    expect(again.json().ticket_id).toBe(t.ticket_id);

    const list = await get("/v1/support/tickets?limit=10");
    expect(list.json()).toMatchObject({ items: [{ ticket_id: t.ticket_id }], next_cursor: null });
    expect((await get(`/v1/support/tickets/${t.ticket_id}`)).json().messages).toHaveLength(1);
    const msg = await send("POST", `/v1/support/tickets/${t.ticket_id}/messages`, { text: "Ещё деталь" });
    expect(msg.json().messages).toHaveLength(2);
    expect((await send("POST", `/v1/support/tickets/${t.ticket_id}/close`)).json().status).toBe("CLOSED");
    const closed = await send("POST", `/v1/support/tickets/${t.ticket_id}/messages`, { text: "после закрытия" });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().code).toBe("SUPPORT_TICKET_CLOSED");
    expect((await get("/v1/support/categories")).json().items[0].code).toBe("BUG");
  });

  it("validation: category, lengths, https deeplink, no user_id in body", async () => {
    const key = () => ({ ...auth(), "idempotency-key": randomUUID() });
    const badCat = await send("POST", "/v1/support/tickets", { ...ticket, category: "REFUND" }, key());
    expect(badCat.statusCode).toBe(422);
    expect(badCat.json().code).toBe("SUPPORT_CATEGORY_INVALID");
    expect((await send("POST", "/v1/support/tickets", { ...ticket, subject: "ab" }, key())).json().code).toBe("VALIDATION_ERROR");
    expect((await send("POST", "/v1/support/tickets", { ...ticket, message: "x".repeat(4001) }, key())).json().code).toBe("VALIDATION_ERROR");
    const http = await send("POST", "/v1/support/tickets", { ...ticket, context: { deeplink: "http://evil.example", client_version: "x" } }, key());
    expect(http.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { field: "context.deeplink" } });
    const spoof = await send("POST", "/v1/support/tickets", { ...ticket, user_id: randomUUID() }, key());
    expect(spoof.statusCode).toBe(422);
    expect(h.fake.callsTo("support", "POST")).toHaveLength(0);
  });

  it("foreign / non-UUID ticket → 404 SUPPORT_TICKET_NOT_FOUND", async () => {
    const created = await send("POST", "/v1/support/tickets", ticket, { ...auth(), "idempotency-key": randomUUID() });
    const id = created.json().ticket_id as string;
    const other = await login(h, { id: 900555, first_name: "Анна", username: "test_user_3" });
    const foreign = await get(`/v1/support/tickets/${id}`, bearer(other.access));
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().code).toBe("SUPPORT_TICKET_NOT_FOUND");
    const foreignClose = await send("POST", `/v1/support/tickets/${id}/close`, undefined, bearer(other.access));
    expect(foreignClose.statusCode).toBe(404);
    for (const bad of ["..%2F..%2Fadmin", "TCK-", "tck-3000", "123"]) {
      const res = await get(`/v1/support/tickets/${bad}`);
      expect(res.statusCode, bad).toBe(404);
      expect(res.json().code).toBe("SUPPORT_TICKET_NOT_FOUND");
    }
    // deep link бота: startapp=ticket_TCK-NNNN — обращение открывается по номеру
    const byNumber = await get(`/v1/support/tickets/${created.json().number}`);
    expect(byNumber.json().ticket_id).toBe(id);
    expect((await get(`/v1/support/tickets/${created.json().number}`, bearer(other.access))).statusCode).toBe(404);
  });
});

describe("upstream errors", () => {
  it("domain 4xx is passed through with code/status/details and BFF trace_id", async () => {
    h.fake.override("support", "GET", "/internal/v1/support/categories", () =>
      domainError(429, "SUPPORT_RATE_LIMITED", { retry_after: 30 }),
    );
    const res = await get("/v1/support/categories");
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.json()).toEqual({
      code: "SUPPORT_RATE_LIMITED",
      message: "domain says SUPPORT_RATE_LIMITED",
      trace_id: res.headers["x-trace-id"],
      details: { retry_after: 30 },
    });
  });

  it("domain 5xx, HTML error page, internal-auth failure → 503 UPSTREAM_UNAVAILABLE", async () => {
    const responses = [
      () => domainError(500, "INTERNAL_ERROR"),
      () => new Response("<html>Bad gateway</html>", { status: 502 }),
      () => domainError(401, "INTERNAL_TOKEN_INVALID"),
      () => domainError(403, "CALLER_NOT_ALLOWED", { caller: "telegram-bff" }),
      () => new Response("{not json", { status: 200 }),
    ];
    for (const r of responses) {
      h.fake.override("preferences", "GET", "/internal/v1/directory/interests", r);
      const res = await get("/v1/directory/interests");
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "preferences" } });
    }
  });

  it("unexpected failure inside BFF → 500 INTERNAL_ERROR without stack trace", async () => {
    h.fake.override("identity", "GET", "/internal/v1/me", () => json(200, null));
    const res = await get("/v1/profile");
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: "INTERNAL_ERROR", message: "Внутренняя ошибка сервиса", trace_id: expect.any(String), details: {} });
    expect(res.body).not.toMatch(/at \w+ \(|TypeError|\.ts:\d+/);
  });

  it("malformed JSON → 400 INVALID_JSON without echoing the body", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/session/telegram",
      headers: { "content-type": "application/json" },
      payload: '{"init_data": "query_id=SECRET-FRAGMENT',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_JSON");
    expect(res.body).not.toContain("SECRET-FRAGMENT");
  });
});

describe("CORS, OpenAPI, health", () => {
  it("CORS allows only MINIAPP_ORIGIN", async () => {
    const pre = await h.app.inject({
      method: "OPTIONS",
      url: "/v1/support/tickets",
      headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,idempotency-key" },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(String(pre.headers["access-control-allow-headers"])).toContain("idempotency-key");
    expect(pre.headers["access-control-allow-credentials"]).toBeUndefined();

    const evil = await h.app.inject({
      method: "OPTIONS",
      url: "/v1/support/tickets",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();

    const simple = await h.app.inject({ url: "/v1/experience/config", headers: { origin: ORIGIN } });
    expect(simple.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(String(simple.headers["access-control-expose-headers"])).toContain("x-trace-id");
    const simpleEvil = await h.app.inject({ url: "/v1/experience/config", headers: { origin: "https://evil.example" } });
    expect(simpleEvil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("GET /openapi.json outside production lists the contract paths", async () => {
    const res = await h.app.inject({ url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    for (const p of ["/v1/session/telegram", "/v1/profile", "/v1/support/tickets/{ticket_id}", "/v1/home", "/v1/experience/config", "/v1/events", "/v1/events/{eventId}"]) {
      expect(doc.paths[p], p).toBeDefined();
    }
    expect(doc.paths["/health/ready"]).toBeUndefined();
    expect(doc.paths["/v1/session/telegram"].post.requestBody.content["application/json"].schema.properties.init_data).toBeDefined();
  });

  it("no /openapi.json in production; health endpoints work", async () => {
    // stage/prod: внутренний JWT подписывается явным ключом (seed тот же, что у dev-деривации фейка → домены принимают)
    const prod = await makeHarness({
      NODE_ENV: "production",
      INTERNAL_JWT_PRIVATE_KEY: deriveSeed(INTERNAL_SECRET, "telegram-bff").toString("base64url"),
    });
    try {
      expect((await prod.app.inject({ url: "/openapi.json" })).statusCode).toBe(404);
      const ready = await prod.app.inject({ url: "/health/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: "ok", checks: { redis: "ok" } });
      expect((await prod.app.inject({ url: "/health/live" })).statusCode).toBe(200);
    } finally {
      await prod.close();
    }
  });
});
