/**
 * Регрессия по код-ревью BFF aievent (решения T1–T5), перенесённая на маршруты TilHero.
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
      if (reissued) expect((await store.lookup(reissued.refreshToken)).status).toBe("missing");
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
    h.fake.setAge(s.userId, "18+");
    h.fake.onboard(s.userId);
    const childId = h.fake.addChild(s.userId);
    h.fake.addInbox(s.userId);
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/support/tickets",
      headers: { ...bearer(s.access), "idempotency-key": randomUUID() },
      payload: { category: "BUG", subject: "Не грузится", message: "Пустой экран" },
    });
    const ticketId = created.json().ticket_id as string;
    const invite = await h.app.inject({ method: "POST", url: "/v1/invites", headers: { ...bearer(s.access), "idempotency-key": randomUUID() }, payload: { kind: "family" } });
    const inviteId = invite.json().invite_id as string;
    await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: bearer(s.access), payload: { pin: "4826" } });
    h.fake.decorate = leakEverywhere;
    const ticket = h.fake.tickets.get(ticketId)!;
    (ticket as unknown as Record<string, unknown>).user_id = s.userId;

    const auth = bearer(s.access);
    const probes = [
      { url: "/v1/profile" },
      { url: "/v1/learners" },
      { url: "/v1/legal/policy" },
      { url: "/v1/plan" },
      { url: "/v1/plan/today" },
      { url: "/v1/directory/goals" },
      { url: "/v1/directory/topics" },
      { url: "/v1/notifications" },
      { url: "/v1/notifications/unread-count" },
      { url: "/v1/whats-new" },
      { url: "/v1/news" },
      { url: "/v1/invites" },
      { url: "/v1/support/categories" },
      { url: "/v1/support/tickets" },
      { url: `/v1/support/tickets/${ticketId}` },
      { url: `/v1/support/tickets/${ticketId}/messages`, method: "POST" as const, payload: { text: "ещё" } },
      { url: "/v1/plan", method: "PATCH" as const, payload: { goal: "travel" } },
      { url: "/v1/plan/activity", method: "POST" as const, payload: { kind: "practice", minutes: 5 }, idem: true },
      { url: "/v1/learners", method: "POST" as const, payload: { display_name: "Тимур", age_band: "10-13" } },
      { url: "/v1/profile/settings", method: "PATCH" as const, payload: { locale: "uz" } },
      { url: "/v1/profile/security/biometric", method: "PUT" as const },
      { url: "/v1/profile/consent", method: "POST" as const, payload: { policy_version: "2026-11-18", purposes: ["terms", "privacy", "learning"] } },
      { url: "/v1/profile/security/pin/reset-request", method: "POST" as const },
      { url: "/v1/invites", method: "POST" as const, payload: { kind: "friend" }, idem: true },
      { url: `/v1/invites/${inviteId}`, method: "DELETE" as const },
      { url: "/v1/notifications/read", method: "POST" as const, payload: { all: true } },
      { url: "/v1/session/refresh", method: "POST" as const, payload: { refresh_token: s.refresh }, noAuth: true },
    ];
    for (const p of probes) {
      const res = await h.app.inject({
        method: p.method ?? "GET",
        url: p.url,
        ...(p.noAuth ? {} : { headers: { ...auth, ...(p.idem ? { "idempotency-key": randomUUID() } : {}) } }),
        ...(p.payload ? { payload: p.payload } : {}),
      });
      expect(res.statusCode, p.url).toBeLessThan(300);
      expect(res.body, p.url).not.toMatch(/LEAK|internal_note|assignee_id|telegram_user_id|visibility|777000/);
    }
    const cfg = (await h.app.inject({ url: "/v1/experience/config" })).json();
    expect(Object.keys(cfg).sort()).toEqual(["app", "flags", "home", "theme", "version"]);
    expect(Object.keys(cfg.theme).sort()).toEqual(["id", "tokens", "version"]);
    expect(Object.keys(cfg.theme.tokens).every((k: string) => k.startsWith("--"))).toBe(true);
    expect(Object.keys(cfg.home).sort()).toEqual(["sections"]);
    expect(Object.keys(cfg.home.sections[0]).sort()).toEqual(["enabled", "key", "type", "variant"]);
    const t = (await h.app.inject({ url: `/v1/support/tickets/${ticketId}`, headers: auth })).json();
    expect(t.user_id).toBeUndefined();
    expect(Object.keys(t.messages[0]).sort()).toEqual(["author_name", "created_at", "message_id", "sender_type", "text"]);
    // переключение на ребёнка — последним (прежний access-токен после него не действует)
    const sw = await h.app.inject({ method: "POST", url: "/v1/session/learner", headers: auth, payload: { learner_id: childId } });
    expect(sw.statusCode).toBe(200);
    expect(sw.body).not.toMatch(/LEAK|internal_note|assignee_id|telegram_user_id|guardian_user_id|visibility|777000/);
  });
});

describe("T3/T5: формат денег, PIN и кода сброса", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("контекст обращения: deeplink только https, без лишних полей (offer_id/price_snapshot туризма → 422)", async () => {
    const s = await login(h);
    const post = (context: object) =>
      h.app.inject({
        method: "POST",
        url: "/v1/support/tickets",
        headers: { ...bearer(s.access), "idempotency-key": randomUUID() },
        payload: { category: "SCHEDULE_REMINDERS", subject: "Напоминание", message: "Не пришло", context },
      });
    expect((await post({ client_version: "telegram-miniapp-1.0", deeplink: "https://t.me/tilhero_bot/app?startapp=route_schedule" })).statusCode).toBe(201);
    for (const bad of [
      { client_version: "x", deeplink: "http://example.com" },
      { client_version: "x", deeplink: "javascript:alert(1)" },
      { client_version: "x", deeplink: "https://a b" },
      { client_version: "x", offer_id: randomUUID() },
      { client_version: "x", price_snapshot: { amount: "1.00", currency: "USD", fetched_at: "2026-11-18T00:00:00Z" } },
      { deeplink: "https://t.me/x" },
    ]) {
      expect((await post(bad)).statusCode, JSON.stringify(bad)).toBe(422);
    }
    expect(h.fake.callsTo("support", "POST", "/internal/v1/me/tickets")).toHaveLength(1);
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
    h.fake.override("learningPlan", "GET", "/internal/v1/directory/goals", () => new Response("", { status: 503 }));
    await h.app.inject({ url: "/v1/directory/goals", headers: bearer(s.access) });
    expect(h.fake.callsTo("learningPlan", "GET", "/internal/v1/directory/goals")).toHaveLength(3);
    // создающие команды с Idempotency-Key повторяются с тем же ключом
    h.fake.override("learningPlan", "POST", "/internal/v1/me/activities", () => new Response("", { status: 503 }));
    const key = randomUUID();
    await h.app.inject({ method: "POST", url: "/v1/plan/activity", headers: { ...bearer(s.access), "idempotency-key": key }, payload: { kind: "practice", minutes: 5 } });
    const tries = h.fake.callsTo("learningPlan", "POST", "/internal/v1/me/activities");
    expect(tries).toHaveLength(3);
    expect(new Set(tries.map((c) => c.headers["idempotency-key"]))).toEqual(new Set([key]));
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
