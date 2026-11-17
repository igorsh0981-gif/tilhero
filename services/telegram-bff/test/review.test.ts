/**
 * Регрессия по код-ревью спринта 1 (docs/qa/sprint1-review-ts.md, решения T1–T5).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeProtectedHeader } from "jose";
import { ipRateKey } from "../src/rateLimit.js";
import { SessionStore } from "../src/sessions.js";
import { bearer, closeRedis, json, login, makeHarness, testRedis, type Harness } from "./helpers.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

async function avoidWindowEdge(): Promise<void> {
  const into = Date.now() % 60_000;
  if (into > 55_000) await new Promise((r) => setTimeout(r, 60_000 - into + 50));
}

describe("T1: перевыпуск сессии атомарен — отозванная сессия не оживает", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("гонка reissue ↔ revokeAllForUser (200 итераций): после обоих сессия всегда мертва", async () => {
    const store = new SessionStore(testRedis(), h.config.redisKeyPrefix, 3600);
    for (let i = 0; i < 200; i++) {
      const uid = randomUUID();
      const { sid } = await store.create(uid, false);
      const [reissued] = await Promise.all([store.reissue(sid, true), store.revokeAllForUser(uid)]);
      expect(await store.isAlive(sid), `iteration ${i}`).toBe(false);
      if (reissued) expect((await store.lookup(reissued)).status).toBe("missing");
    }
    expect(await store.reissue(randomUUID(), true)).toBeNull();
  });

  it("PIN verify, во время которого сессии отозваны (сброс PIN на другом устройстве) → 401 SESSION_REVOKED", async () => {
    const first = await login(h);
    h.fake.enablePin(first.userId, "4826");
    const s = await login(h);
    const store = new SessionStore(testRedis(), h.config.redisKeyPrefix, 3600);
    h.fake.override("identity", "POST", "/internal/v1/me/pin/verify", async () => {
      await store.revokeAllForUser(s.userId); // параллельный отзыв, пока identity проверяет PIN
      return json(200, { ok: true });
    });
    const res = await h.app.inject({ method: "POST", url: "/v1/session/pin/verify", headers: bearer(s.access), payload: { pin: "4826" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("SESSION_REVOKED");
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(s.access) })).json().code).toBe("SESSION_REVOKED");
    expect((await h.app.inject({ method: "POST", url: "/v1/session/refresh", payload: { refresh_token: s.refresh } })).json().code).toBe(
      "REFRESH_INVALID",
    );
  });
});

describe("T2: ответы сериализуются по схеме — служебные поля доменов не уходят в Mini App", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  /** Домены добавляют служебные поля в КАЖДЫЙ объект ответа (на любой глубине). */
  function leakEverywhere(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(leakEverywhere);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = leakEverywhere(x);
      return { ...out, internal_note: "LEAK-operator-only", assignee_id: "LEAK-staff-7", telegram_user_id: 777000, visibility: "internal" };
    }
    return v;
  }

  it("все клиентские маршруты: ни одно служебное поле не доходит до клиента", async () => {
    const s = await login(h);
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/support/tickets",
      headers: { ...bearer(s.access), "idempotency-key": randomUUID() },
      payload: { category: "BUG", subject: "Не грузится", message: "Пустой экран" },
    });
    const ticketId = created.json().ticket_id as string;
    await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: bearer(s.access), payload: { pin: "4826" } });
    h.fake.decorate = leakEverywhere;
    // домен support «по ошибке» отдаёт staff-представление тикета
    const ticket = h.fake.tickets.get(ticketId)!;
    (ticket as unknown as Record<string, unknown>).user_id = s.userId;

    const auth = bearer(s.access);
    const probes = [
      { url: "/v1/profile" },
      { url: "/v1/home" },
      { url: "/v1/legal/policy" },
      { url: "/v1/directory/airports?q=tash" },
      { url: "/v1/directory/interests" },
      { url: "/v1/directory/geographies" },
      { url: "/v1/support/categories" },
      { url: "/v1/support/tickets" },
      { url: `/v1/support/tickets/${ticketId}` },
      { url: `/v1/support/tickets/${ticketId}/messages`, method: "POST" as const, payload: { text: "ещё" } },
      { url: "/v1/profile/preferences", method: "PATCH" as const, payload: { strong_events_outside_geo: true } },
      { url: "/v1/profile/departures", method: "PUT" as const, payload: { airports: ["TAS"] } },
      { url: "/v1/profile/settings", method: "PATCH" as const, payload: { locale: "ru" } },
      { url: "/v1/profile/security/biometric", method: "PUT" as const },
      { url: "/v1/profile/consent", method: "POST" as const, payload: { policy_version: "2026-10-01", purposes: ["core"], age_confirmed_18_plus: true } },
      { url: "/v1/profile/security/pin/reset-request", method: "POST" as const },
      { url: "/v1/session/refresh", method: "POST" as const, payload: { refresh_token: s.refresh }, noAuth: true },
    ];
    for (const p of probes) {
      const res = await h.app.inject({
        method: p.method ?? "GET",
        url: p.url,
        ...(p.noAuth ? {} : { headers: auth }),
        ...(p.payload ? { payload: p.payload } : {}),
      });
      expect(res.statusCode, p.url).toBeLessThan(300);
      expect(res.body, p.url).not.toMatch(/LEAK|internal_note|assignee_id|telegram_user_id|visibility|777000/);
    }
    // Remote Config: flags — открытая карта по контракту; фиксированные объекты и tokens (только --css-var) — без лишнего
    const cfg = (await h.app.inject({ url: "/v1/experience/config" })).json();
    expect(Object.keys(cfg).sort()).toEqual(["app", "flags", "home", "hotel_rating_min", "theme", "version"]);
    expect(Object.keys(cfg.theme).sort()).toEqual(["id", "tokens", "version"]);
    expect(Object.keys(cfg.theme.tokens).every((k: string) => k.startsWith("--"))).toBe(true);
    expect(Object.keys(cfg.home).sort()).toEqual(["sections", "welcome_mode"]);
    expect(Object.keys(cfg.home.sections[0]).sort()).toEqual(["enabled", "key", "type", "variant"]);
    const t = (await h.app.inject({ url: `/v1/support/tickets/${ticketId}`, headers: auth })).json();
    expect(t.user_id).toBeUndefined();
    expect(Object.keys(t.messages[0]).sort()).toEqual(["author_name", "created_at", "message_id", "sender_type", "text"]);
  });
});

describe("T3/T5: формат денег, PIN и кода сброса", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("price_snapshot.amount — строка-десятичное ≤ 2 знаков; число → 422", async () => {
    const s = await login(h);
    const post = (amount: unknown) =>
      h.app.inject({
        method: "POST",
        url: "/v1/support/tickets",
        headers: { ...bearer(s.access), "idempotency-key": randomUUID() },
        payload: {
          category: "PRICE",
          subject: "Цена изменилась",
          message: "Была другая",
          context: { client_version: "telegram-miniapp-2.0", price_snapshot: { amount, currency: "USD", fetched_at: "2026-10-08T09:00:00Z" } },
        },
      });
    for (const ok of ["850.00", "850.5", "0", "1200"]) expect((await post(ok)).statusCode, ok).toBe(201);
    for (const bad of [850, 850.25, "850.123", "-1.00", "1e3", "08.00", ""]) {
      const res = await post(bad);
      expect(res.statusCode, String(bad)).toBe(422);
      expect(res.json().details.field).toBe("context.price_snapshot.amount");
    }
    const sent = h.fake.callsTo("support", "POST", "/internal/v1/me/tickets")[0]!.body as { context: { price_snapshot: { amount: unknown } } };
    expect(sent.context.price_snapshot.amount).toBe("850.00");
  });

  it("PIN не 4/6 цифр → 422 PIN_FORMAT, до identity не доходит (попытка не тратится); код сброса — 6 цифр", async () => {
    const first = await login(h);
    h.fake.enablePin(first.userId, "4826");
    const s = await login(h);
    const cases: Array<[string, string, Record<string, string>]> = [
      ["POST", "/v1/session/pin/verify", { pin: "abc' OR 1=1" }],
      ["POST", "/v1/session/pin/verify", { pin: "12345" }],
      ["POST", "/v1/profile/security/pin/reset-confirm", { code: "246810", new_pin: "１２３４" }],
    ];
    for (const [method, url, payload] of cases) {
      const res = await h.app.inject({ method: method as "POST", url, headers: bearer(s.access), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      expect(res.json().code).toBe("PIN_FORMAT");
    }
    const badCode = await h.app.inject({
      method: "POST",
      url: "/v1/profile/security/pin/reset-confirm",
      headers: bearer(s.access),
      payload: { code: "abc", new_pin: "7391" },
    });
    expect(badCode.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { field: "code" } });
    expect(h.fake.callsTo("identity", "POST", "/internal/v1/me/pin/verify")).toHaveLength(0);
    expect(h.fake.callsTo("identity", "POST", "/internal/v1/me/pin/reset-confirm")).toHaveLength(0);

    const ok = await h.app.inject({ method: "POST", url: "/v1/session/pin/verify", headers: bearer(s.access), payload: { pin: "4826" } });
    const access = ok.json().access_token as string;
    const set = await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: bearer(access), payload: { pin: "73", current_pin: "4826" } });
    expect(set.json()).toMatchObject({ code: "PIN_FORMAT", details: { field: "pin" } });
    const del = await h.app.inject({ method: "POST", url: "/v1/profile/delete-request", headers: bearer(access), payload: { pin: "x" } });
    expect(del.json().code).toBe("PIN_FORMAT");
  });
});

describe("T4/T5: внутренний JWT v2, повторы, trace id, IPv6", () => {
  it("домены получают EdDSA-токен с kid = iss = telegram-bff", async () => {
    h = await makeHarness();
    await login(h);
    const token = h.fake.calls[0]!.headers["x-internal-token"]!;
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "EdDSA", kid: "telegram-bff" });
  });

  it("PUT/DELETE PIN не повторяются после 5xx/таймаута, GET — повторяется", async () => {
    h = await makeHarness({ UPSTREAM_RETRIES: "2" });
    const s = await login(h);
    h.fake.override("identity", "PUT", "/internal/v1/me/pin", () => new Response("", { status: 503 }));
    const res = await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: bearer(s.access), payload: { pin: "4826" } });
    expect(res.statusCode).toBe(503);
    expect(h.fake.callsTo("identity", "PUT", "/internal/v1/me/pin")).toHaveLength(1);
    h.fake.override("preferences", "GET", "/internal/v1/directory/interests", () => new Response("", { status: 503 }));
    await h.app.inject({ url: "/v1/directory/interests", headers: bearer(s.access) });
    expect(h.fake.callsTo("preferences", "GET", "/internal/v1/directory/interests")).toHaveLength(3);
  }, 20_000);

  it("x-trace-id клиента принимается только ^[A-Za-z0-9_-]{1,64}$ и пробрасывается в домены", async () => {
    h = await makeHarness();
    const bad = "x".repeat(100);
    const res = await h.app.inject({ url: "/v1/experience/config", headers: { "x-trace-id": bad } });
    expect(res.headers["x-trace-id"]).not.toBe(bad);
    expect(h.fake.calls.at(-1)!.headers["x-trace-id"]).toBe(res.headers["x-trace-id"]);
    const good = await h.app.inject({ url: "/v1/legal/policy", headers: { "x-trace-id": "mini-app_123" } });
    expect(good.headers["x-trace-id"]).toBe("mini-app_123");
    expect(h.fake.calls.at(-1)!.headers["x-trace-id"]).toBe("mini-app_123");
  });

  it("IPv6: лимит входа считается по /64, IPv4-mapped — как IPv4", async () => {
    expect(ipRateKey("2001:db8:1:2:3:4:5:6")).toBe(ipRateKey("2001:db8:1:2::9"));
    expect(ipRateKey("2001:db8:1:2::9")).not.toBe(ipRateKey("2001:db8:1:3::9"));
    expect(ipRateKey("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(ipRateKey("203.0.113.7")).toBe("203.0.113.7");
    h = await makeHarness();
    await avoidWindowEdge();
    const hit = (ip: string) => h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: "bad" }, remoteAddress: ip });
    for (let i = 1; i <= 10; i++) expect((await hit(`2001:db8:aa:bb::${i.toString(16)}`)).statusCode).toBe(401);
    expect((await hit("2001:db8:aa:bb:ffff:ffff:ffff:ffff")).statusCode).toBe(429);
    expect((await hit("2001:db8:aa:bc::1")).statusCode).toBe(401);
  });
});
