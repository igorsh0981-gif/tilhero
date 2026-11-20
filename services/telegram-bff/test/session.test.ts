import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { Value } from "typebox/value";
import { SecurityStateSchema, SessionResponseSchema } from "../src/schemas.js";
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from "../src/tokens.js";
import {
  BOT_TOKEN,
  RESET_EFFECTIVE_AT,
  SESSION_SECRET,
  TG_OTHER,
  TG_USER,
  bearer,
  closeRedis,
  initDataFor,
  login,
  makeHarness,
  switchTo,
  testRedis,
  type Harness,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method: "POST", url, ...(payload !== undefined ? { payload: payload as object } : {}), headers });

const sign = (claims: Record<string, unknown>, sub: string, secret = SESSION_SECRET, exp: number | string = "10m") =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ACCESS_ISSUER)
    .setAudience(ACCESS_AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));

describe("POST /v1/session/telegram", () => {
  it("genuine initData → SessionResponse (account, learner = self, learners), identity with Telegram snapshot, no internal fields", async () => {
    const res = await post("/v1/session/telegram", { init_data: initDataFor() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(Value.Check(SessionResponseSchema, body)).toBe(true);
    expect(Object.keys(body).sort()).toEqual(
      ["access_token", "account", "consent", "expires_in", "learner", "learners", "onboarding_completed", "refresh_token", "security", "start_param"].sort(),
    );
    expect(body.expires_in).toBe(900);
    expect(body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.account).toEqual({
      user_id: expect.any(String),
      display_name: "Игорь",
      username: "test_user_1",
      locale: "ru",
      status: "ACTIVE",
      is_new: true,
      age_band: null,
      guardian_consent: "not_required",
    });
    expect(body.learner).toEqual({
      learner_id: body.account.user_id,
      kind: "self",
      display_name: "Игорь",
      age_band: null,
      is_active: true,
      onboarding_completed: false,
      voice_consent: false,
    });
    expect(body.learners).toEqual([body.learner]);
    expect(JSON.stringify(body)).not.toContain("telegram_user_id");
    expect(body.consent.purposes).toEqual([]);
    expect(body.start_param).toBeNull();

    const [call] = h.fake.callsTo("identity", "POST", "/internal/v1/users/telegram-login");
    expect(call?.body).toEqual({ telegram_user_id: 900001, first_name: "Игорь", username: "test_user_1", language_code: "ru" });
    expect(call?.subject).toBeUndefined();
    // первый вход (is_new): плана ещё нет — learning-plan не вызывается, чтобы план не создался в зоне по умолчанию (D-03)
    expect(h.fake.callsTo("learningPlan")).toHaveLength(0);
    expect(call?.headers["x-trace-id"]).toBe(res.headers["x-trace-id"]);

    // дальше онбординг ученика — из learning-plan, внутренний JWT с sub = ученик (здесь = аккаунт)
    const me = await h.app.inject({ url: "/v1/profile", headers: bearer(body.access_token) });
    expect(me.statusCode).toBe(200);
    expect(h.fake.callsTo("learningPlan", "GET", "/internal/v1/me/plan").map((c) => c.subject)).toEqual([body.account.user_id]);
  });

  it("start_param из initData возвращается (inv_/gc_/route_), мусор → null", async () => {
    const s = await login(h, TG_USER, "203.0.113.10", "inv_AbCdEfGhIjKlMnOpQrStUvWxYz012345");
    expect(s.body.start_param).toBe("inv_AbCdEfGhIjKlMnOpQrStUvWxYz012345");
    const bad = await login(h, TG_USER, "203.0.113.10", "x".repeat(65));
    expect(bad.body.start_param).toBeNull();
    const weird = await login(h, TG_USER, "203.0.113.10", "route_home<script>");
    expect(weird.body.start_param).toBeNull();
    // токен приглашения в лог не попадает
    expect(h.logs.text).not.toContain("AbCdEfGhIjKlMnOp");
  });

  it("повторный вход возвращает тот же профиль и план (AT-01); onboarding_completed — из learning-plan", async () => {
    const first = await login(h);
    h.fake.onboard(first.userId);
    const second = await login(h);
    expect(second.userId).toBe(first.userId);
    expect(second.body.onboarding_completed).toBe(true);
    expect(second.body.learner.onboarding_completed).toBe(true);
    expect(second.body.account.is_new).toBe(false);
  });

  it("tampered hash / modified field / expired / no user / foreign token → 401 INIT_DATA_* (AT-01)", async () => {
    const good = initDataFor();
    const tamperedHash = new URLSearchParams(good);
    tamperedHash.set("hash", "0".repeat(64));
    const modified = new URLSearchParams(good);
    modified.set("user", JSON.stringify({ ...TG_USER, id: 1 }));
    const cases: Array<[string, string, string]> = [
      ["hash", tamperedHash.toString(), "INIT_DATA_INVALID"],
      ["field", modified.toString(), "INIT_DATA_INVALID"],
      ["expired", initDataFor(TG_USER, { authDate: Math.floor(Date.now() / 1000) - 3700 }), "INIT_DATA_EXPIRED"],
      ["future", initDataFor(TG_USER, { authDate: Math.floor(Date.now() / 1000) + 600 }), "INIT_DATA_INVALID"],
      ["no user", initDataFor(null), "INIT_DATA_INVALID"],
      ["foreign bot", initDataFor(TG_USER, { token: "1:" + BOT_TOKEN.slice(2) }), "INIT_DATA_INVALID"],
      ["garbage", "%%%not-init-data", "INIT_DATA_INVALID"],
    ];
    for (const [name, initData, code] of cases) {
      const res = await post("/v1/session/telegram", { init_data: initData });
      expect(res.statusCode, name).toBe(401);
      const b = res.json();
      expect(b.code, name).toBe(code);
      expect(b.trace_id).toBeTruthy();
      expect(JSON.stringify(b)).not.toContain(initData.slice(0, 40));
    }
    expect(h.fake.callsTo("identity")).toHaveLength(0);
  });

  it("422 on missing init_data or extra fields", async () => {
    expect((await post("/v1/session/telegram", {})).json().code).toBe("VALIDATION_ERROR");
    const extra = await post("/v1/session/telegram", { init_data: initDataFor(), user_id: "x" });
    expect(extra.statusCode).toBe(422);
    expect(extra.json().details.field).toBe("user_id");
  });

  it("user who requested deletion → 410 USER_DELETED, no session issued", async () => {
    const s = await login(h);
    h.fake.account(s.userId).summary.status = "DELETION_REQUESTED";
    const res = await post("/v1/session/telegram", { init_data: initDataFor() });
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe("USER_DELETED");
  });

  it("identity errors are passed through; outage of identity or learning-plan → 503, initData can be reused", async () => {
    h.fake.override("identity", "POST", "/internal/v1/users/telegram-login", () =>
      new Response(JSON.stringify({ code: "USER_BLOCKED", message: "blocked", trace_id: "t", details: { reason: "abuse" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    const blocked = await post("/v1/session/telegram", { init_data: initDataFor() });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: "USER_BLOCKED", details: { reason: "abuse" } });

    h.fake.down.add("identity");
    const down = await post("/v1/session/telegram", { init_data: initDataFor() });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "identity-consent" } });
  });

  it("learning-plan down at login → 503 and no live session is left behind", async () => {
    const first = await login(h);
    h.fake.down.add("learningPlan");
    const initData = initDataFor();
    const res = await post("/v1/session/telegram", { init_data: initData });
    expect(res.statusCode).toBe(503);
    expect(res.json().details.service).toBe("learning-plan");
    const sids = await testRedis().smembers(`${h.config.redisKeyPrefix}usid:${first.userId}`);
    expect(sids).toHaveLength(1); // только сессия первого входа
    h.fake.down.delete("learningPlan");
    expect((await post("/v1/session/telegram", { init_data: initData })).statusCode).toBe(200);
  });
});

describe("access token", () => {
  it("401 without token, with garbage, with foreign signature, expired, without lrn", async () => {
    const s = await login(h);
    expect((await h.app.inject({ url: "/v1/profile" })).json().code).toBe("UNAUTHORIZED");
    expect((await h.app.inject({ url: "/v1/profile", headers: { authorization: "Bearer nope" } })).json().code).toBe("TOKEN_INVALID");
    expect((await h.app.inject({ url: "/v1/profile", headers: { authorization: `Basic ${s.access}` } })).json().code).toBe("TOKEN_INVALID");
    const sid = randomUUID();
    const forged = await sign({ sid, lrn: s.userId, pin: true }, s.userId, "another-secret-" + "q".repeat(32));
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(forged) })).json().code).toBe("TOKEN_INVALID");
    const now = Math.floor(Date.now() / 1000);
    const expired = await sign({ sid, lrn: s.userId, pin: true }, s.userId, SESSION_SECRET, now - 100);
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(expired) })).json().code).toBe("TOKEN_EXPIRED");
    const noLrn = await sign({ sid, pin: true }, s.userId);
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(noLrn) })).json().code).toBe("TOKEN_INVALID");
    const badLrn = await sign({ sid, lrn: "not-a-uuid", pin: true }, s.userId);
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(badLrn) })).json().code).toBe("TOKEN_INVALID");
  });

  it("a valid JWT for an unknown/revoked sid is rejected with SESSION_REVOKED", async () => {
    const s = await login(h);
    const ghost = await sign({ sid: "00000000-0000-0000-0000-000000000000", lrn: s.userId, pin: true }, s.userId);
    const res = await h.app.inject({ url: "/v1/profile", headers: bearer(ghost) });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("SESSION_REVOKED");
  });
});

describe("refresh rotation and reuse detection", () => {
  it("rotates on every use; reuse of a used token revokes the whole session", async () => {
    const s = await login(h);
    const r1 = await post("/v1/session/refresh", { refresh_token: s.refresh });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(Value.Check(SessionResponseSchema, b1)).toBe(true);
    expect(b1.refresh_token).not.toBe(s.refresh);
    expect(b1.account.user_id).toBe(s.userId);
    expect(b1.start_param).toBeNull();

    const r2 = await post("/v1/session/refresh", { refresh_token: b1.refresh_token });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json();

    const replay = await post("/v1/session/refresh", { refresh_token: s.refresh });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe("REFRESH_INVALID");
    expect((await post("/v1/session/refresh", { refresh_token: b2.refresh_token })).json().code).toBe("REFRESH_INVALID");
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(b2.access_token) })).json().code).toBe("SESSION_REVOKED");
    expect(h.logs.text).toContain("refresh_token_reuse");
  });

  it("unknown / malformed refresh token → 401 REFRESH_INVALID", async () => {
    for (const t of ["x", "A".repeat(43), "../../etc"]) {
      const res = await post("/v1/session/refresh", { refresh_token: t });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("REFRESH_INVALID");
    }
  });

  it("identity or learning-plan outage during refresh does not burn the refresh token", async () => {
    const s = await login(h);
    for (const svc of ["identity", "learningPlan"] as const) {
      h.fake.down.add(svc);
      expect((await post("/v1/session/refresh", { refresh_token: s.refresh })).statusCode).toBe(503);
      h.fake.down.delete(svc);
    }
    expect((await post("/v1/session/refresh", { refresh_token: s.refresh })).statusCode).toBe(200);
  });

  it("refresh token is stored only as sha256 hash with TTL", async () => {
    const s = await login(h);
    const redis = testRedis();
    const keys = await redis.keys(`${h.config.redisKeyPrefix}*`);
    expect(keys.some((k) => k.includes(s.refresh))).toBe(false);
    const rt = keys.find((k) => k.includes(":rt:"))!;
    expect(rt).toMatch(/:rt:[0-9a-f]{64}$/);
    const ttl = await redis.ttl(rt);
    expect(ttl).toBeGreaterThan(43_000);
    expect(ttl).toBeLessThanOrEqual(43_200);
    expect(await redis.get(rt)).not.toContain(s.refresh);
  });

  it("logout revokes refresh and access immediately (204)", async () => {
    const s = await login(h);
    const out = await post("/v1/session/logout", undefined, bearer(s.access));
    expect(out.statusCode).toBe(204);
    expect(out.body).toBe("");
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(s.access) })).json().code).toBe("SESSION_REVOKED");
    expect((await post("/v1/session/refresh", { refresh_token: s.refresh })).json().code).toBe("REFRESH_INVALID");
    expect((await post("/v1/session/logout")).statusCode).toBe(401);
  });
});

describe("POST /v1/session/learner — активный ученик", () => {
  async function parentWithChild() {
    const s = await login(h);
    h.fake.setAge(s.userId, "18+");
    const childId = h.fake.addChild(s.userId, "Мадина", "6-9");
    return { s, childId };
  }

  it("родитель → свой ребёнок: новые токены с lrn = ребёнок; учебные домены получают sub = ребёнок, аккаунтные — аккаунт", async () => {
    const { s, childId } = await parentWithChild();
    h.fake.onboard(childId);
    const c = await switchTo(h, s, childId);
    expect(Value.Check(SessionResponseSchema, c.body)).toBe(true);
    expect(c.body.learner).toEqual({ learner_id: childId, kind: "child", display_name: "Мадина", age_band: "6-9", is_active: true, onboarding_completed: true, voice_consent: false });
    expect(c.body.account.user_id).toBe(s.userId);
    expect(c.body.onboarding_completed).toBe(true);
    expect(c.body.learners.map((l: { learner_id: string; is_active: boolean }) => [l.learner_id, l.is_active])).toEqual([
      [s.userId, false],
      [childId, true],
    ]);
    // проверка опекунства — identity /me/learners/{id} от имени аккаунта
    const check = h.fake.callsTo("identity", "GET", `/internal/v1/me/learners/${childId}`);
    expect(check.map((x) => x.subject)).toEqual([s.userId]);

    h.fake.calls.length = 0;
    expect((await h.app.inject({ url: "/v1/plan", headers: bearer(c.access) })).json().learner_id).toBe(childId);
    expect(h.fake.callsTo("learningPlan").map((x) => x.subject)).toEqual([childId]);
    // прежний refresh заменён, новый сохраняет ученика
    expect((await post("/v1/session/refresh", { refresh_token: s.refresh })).json().code).toBe("REFRESH_INVALID");
    const r = await post("/v1/session/refresh", { refresh_token: c.refresh });
    expect(r.json().learner.learner_id).toBe(childId);
    expect((await h.app.inject({ url: "/v1/plan", headers: bearer(r.json().access_token) })).json().learner_id).toBe(childId);
    // access-токен, выданный до переключения, больше не действует (401 TOKEN_EXPIRED → refresh)
    const stale = await h.app.inject({ url: "/v1/plan", headers: bearer(s.access) });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ code: "TOKEN_EXPIRED", details: { reason: "learner_switched" } });
    // логи: псевдоним аккаунта, без имени ребёнка
    expect(h.logs.text).toContain("active learner switched");
    expect(h.logs.text).not.toContain("Мадина");
  });

  it("нельзя переключиться на чужого ребёнка (404 LEARNER_NOT_FOUND, неотличимо от несуществующего); сессия не меняется", async () => {
    const { s } = await parentWithChild();
    const other = await login(h, TG_OTHER, "203.0.113.11");
    h.fake.setAge(other.userId, "18+");
    const foreignChild = h.fake.addChild(other.userId, "Чужой", "10-13");
    for (const id of [foreignChild, randomUUID(), other.userId]) {
      const res = await post("/v1/session/learner", { learner_id: id }, bearer(s.access));
      expect(res.statusCode, id).toBe(404);
      expect(res.json().code).toBe("LEARNER_NOT_FOUND");
    }
    // identity спрашивали от имени своего аккаунта
    expect(h.fake.callsTo("identity", "GET", `/internal/v1/me/learners/${foreignChild}`).every((c) => c.subject === s.userId)).toBe(true);
    // refresh и lrn прежние
    const r = await post("/v1/session/refresh", { refresh_token: s.refresh });
    expect(r.json().learner.learner_id).toBe(s.userId);
    // не-UUID → 422
    expect((await post("/v1/session/learner", { learner_id: "abc" }, bearer(s.access))).statusCode).toBe(422);
    expect((await post("/v1/session/learner", { learner_id: s.userId })).statusCode).toBe(401);
  });

  it("identity вернул не того ученика или не ребёнка → 404 (ответ домена сверяется)", async () => {
    const { s, childId } = await parentWithChild();
    h.fake.override("identity", "GET", `/internal/v1/me/learners/${childId}`, () =>
      new Response(JSON.stringify({ learner_id: randomUUID(), kind: "child", display_name: "X", age_band: "6-9" }), { status: 200 }),
    );
    expect((await post("/v1/session/learner", { learner_id: childId }, bearer(s.access))).statusCode).toBe(404);
  });

  it("выход ИЗ детского профиля при заданном коде родителя: без pin → 401 PIN_INVALID, неверный → remaining, верный → профиль родителя", async () => {
    const { s, childId } = await parentWithChild();
    h.fake.enablePin(s.userId, "4826");
    const verified = await post("/v1/session/pin/verify", { pin: "4826" }, bearer(s.access));
    const parent = { access: verified.json().access_token, refresh: verified.json().refresh_token, userId: s.userId, body: verified.json() };
    // вход в детский профиль — без кода
    const child = await switchTo(h, parent, childId);
    expect(child.body.security.pin_required).toBe(false);

    const missing = await post("/v1/session/learner", { learner_id: s.userId }, bearer(child.access));
    expect(missing.statusCode).toBe(401);
    expect(missing.json().code).toBe("PIN_INVALID");
    const wrong = await post("/v1/session/learner", { learner_id: s.userId, pin: "0000" }, bearer(child.access));
    expect(wrong.json()).toMatchObject({ code: "PIN_INVALID", details: { remaining: 4 } });
    const badFormat = await post("/v1/session/learner", { learner_id: s.userId, pin: "12" }, bearer(child.access));
    expect(badFormat.json().code).toBe("PIN_FORMAT");
    // в другой детский профиль — тоже выход из детского
    const sibling = h.fake.addChild(s.userId, "Тимур", "10-13");
    expect((await post("/v1/session/learner", { learner_id: sibling }, bearer(child.access))).statusCode).toBe(401);
    // остаться в своём детском профиле (тот же ученик) — без кода
    expect((await post("/v1/session/learner", { learner_id: childId }, bearer(child.access))).statusCode).toBe(200);

    const back = await post("/v1/session/learner", { learner_id: s.userId, pin: "4826" }, bearer(child.access));
    expect(back.statusCode).toBe(200);
    expect(back.json().learner).toMatchObject({ learner_id: s.userId, kind: "self", is_active: true });
    const verifies = h.fake.callsTo("identity", "POST", "/internal/v1/me/pin/verify");
    expect(verifies.every((c) => c.subject === s.userId)).toBe(true);
  });

  it("выход из детского профиля новым кодом после срока сброса: сброс вступает в силу, остальные сессии отозваны (T-8)", async () => {
    const { s, childId } = await parentWithChild();
    h.fake.onboard(childId);
    h.fake.enablePin(s.userId, "4826");
    const verified = (await post("/v1/session/pin/verify", { pin: "4826" }, bearer(s.access))).json();
    const parent = { access: verified.access_token, refresh: verified.refresh_token, userId: s.userId, body: verified };
    const otherDevice = (await post("/v1/session/pin/verify", { pin: "4826" }, bearer((await login(h)).access))).json();
    await post("/v1/profile/security/pin/reset-confirm", { code: "246810", new_pin: "739104" }, bearer(parent.access));
    const child = await switchTo(h, parent, childId);
    // до срока новый код не выпускает из детского профиля
    const early = await post("/v1/session/learner", { learner_id: s.userId, pin: "739104" }, bearer(child.access));
    expect(early.json().code).toBe("PIN_INVALID");
    h.fake.makeResetDue(s.userId);
    const back = await post("/v1/session/learner", { learner_id: s.userId, pin: "739104" }, bearer(child.access));
    expect(back.statusCode).toBe(200);
    expect(back.json().learner).toMatchObject({ learner_id: s.userId, kind: "self" });
    expect(back.json().security).toMatchObject({ pin_length: 6, pin_reset_effective_at: null });
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(back.json().access_token) })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(otherDevice.access_token) })).json().code).toBe("SESSION_REVOKED");
  });

  it("подтверждение кода родителя в детском профиле сохраняет ученика (refresh после reissue — тот же lrn)", async () => {
    const { s, childId } = await parentWithChild();
    const child = await switchTo(h, s, childId);
    h.fake.enablePin(s.userId, "4826");
    const ok = await post("/v1/session/pin/verify", { pin: "4826" }, bearer(child.access));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().learner.learner_id).toBe(childId);
    const r = await post("/v1/session/refresh", { refresh_token: ok.json().refresh_token });
    expect(r.json().learner.learner_id).toBe(childId);
  });

  it("без кода родителя выход из детского профиля свободный; проверки кода ограничены 5/мин", async () => {
    const { s, childId } = await parentWithChild();
    const child = await switchTo(h, s, childId);
    const back = await switchTo(h, child, s.userId);
    expect(back.body.learner.kind).toBe("self");

    h.fake.enablePin(s.userId, "4826");
    const again = await switchTo(h, back, childId);
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await post("/v1/session/learner", { learner_id: s.userId, pin: "1111" }, bearer(again.access))).statusCode;
    expect(last).toBe(429);
  });

  it("сессия с непроверенным кодом родителя не переключается (423 PIN_REQUIRED)", async () => {
    const { s, childId } = await parentWithChild();
    h.fake.enablePin(s.userId, "4826");
    const gated = await login(h);
    const res = await post("/v1/session/learner", { learner_id: childId }, bearer(gated.access));
    expect(res.statusCode).toBe(423);
    expect(res.json().code).toBe("PIN_REQUIRED");
  });

  it("детский профиль удалён — refresh возвращает в профиль аккаунта", async () => {
    const { s, childId } = await parentWithChild();
    const child = await switchTo(h, s, childId);
    const acc = h.fake.account(s.userId);
    acc.children = [];
    h.fake.children.delete(childId);
    // access-токен с удалённым учеником → 404 LEARNER_NOT_FOUND на профиле
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(child.access) })).json().code).toBe("LEARNER_NOT_FOUND");
    const r = await post("/v1/session/refresh", { refresh_token: child.refresh });
    expect(r.statusCode).toBe(200);
    expect(r.json().learner.learner_id).toBe(s.userId);
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(r.json().access_token) })).statusCode).toBe(200);
    // прежний access-токен (lrn удалённого ребёнка) больше не действует
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(child.access) })).json().code).toBe("TOKEN_EXPIRED");
  });

  it("learning-plan недоступен при переключении → 503, прежний refresh остаётся рабочим", async () => {
    const { s, childId } = await parentWithChild();
    h.fake.down.add("learningPlan");
    expect((await post("/v1/session/learner", { learner_id: childId }, bearer(s.access))).statusCode).toBe(503);
    h.fake.down.delete("learningPlan");
    expect((await post("/v1/session/refresh", { refresh_token: s.refresh })).statusCode).toBe(200);
  });
});

describe("PIN gate (код родителя)", () => {
  async function pinUser() {
    const first = await login(h);
    h.fake.enablePin(first.userId, "4826");
    const s = await login(h);
    expect(s.body.security).toMatchObject({ pin_enabled: true, pin_required: true });
    return s;
  }

  it("pin_required session: only /v1/session/*, pin reset, policy, config and guardian preview are allowed", async () => {
    const s = await pinUser();
    const blocked = ["/v1/profile", "/v1/plan", "/v1/plan/today", "/v1/notifications", "/v1/whats-new", "/v1/invites", "/v1/family", "/v1/support/categories", "/v1/learners"];
    for (const url of blocked) {
      const res = await h.app.inject({ url, headers: bearer(s.access) });
      expect(res.statusCode, url).toBe(423);
      expect(res.json().code, url).toBe("PIN_REQUIRED");
    }
    const del = await post("/v1/profile/delete-request", { confirm_word: "УДАЛИТЬ" }, bearer(s.access));
    expect(del.statusCode).toBe(423);
    expect(h.fake.callsTo("identity", "POST", "/internal/v1/me/deletion-request")).toHaveLength(0);

    expect((await h.app.inject({ url: "/v1/experience/config", headers: bearer(s.access) })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/v1/legal/policy?lang=uz" })).statusCode).toBe(200);
    expect((await post("/v1/profile/security/pin/reset-request", undefined, bearer(s.access))).json()).toEqual({ expires_in: 600 });
    const r = await post("/v1/session/refresh", { refresh_token: s.refresh });
    expect(r.json().security.pin_required).toBe(true);
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(r.json().access_token) })).statusCode).toBe(423);
  });

  it("wrong PIN → 401 PIN_INVALID {remaining}, correct PIN → new tokens with pin=true", async () => {
    const s = await pinUser();
    const bad = await post("/v1/session/pin/verify", { pin: "0000" }, bearer(s.access));
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ code: "PIN_INVALID", details: { remaining: 4 } });
    const ok = await post("/v1/session/pin/verify", { pin: "4826" }, bearer(s.access));
    expect(ok.statusCode).toBe(200);
    const b = ok.json();
    expect(b.security.pin_required).toBe(false);
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(b.access_token) })).statusCode).toBe(200);
    expect((await post("/v1/session/refresh", { refresh_token: s.refresh })).json().code).toBe("REFRESH_INVALID");
    const r = await post("/v1/session/refresh", { refresh_token: b.refresh_token });
    expect(r.json().security.pin_required).toBe(false);
    expect(h.fake.callsTo("identity", "POST", "/internal/v1/me/pin/verify")[0]?.subject).toBe(s.userId);
  });

  it("biometric verify unlocks the session; wrong token → 401 BIOMETRIC_INVALID", async () => {
    const s0 = await login(h);
    h.fake.enablePin(s0.userId, "4826");
    const bio = await h.app.inject({ method: "PUT", url: "/v1/profile/security/biometric", headers: bearer(s0.access) });
    expect(bio.statusCode).toBe(200);
    const token = bio.json().biometric_token as string;
    const s = await login(h);
    expect((await post("/v1/session/biometric/verify", { biometric_token: "bio_wrong" }, bearer(s.access))).json().code).toBe("BIOMETRIC_INVALID");
    const ok = await post("/v1/session/biometric/verify", { biometric_token: token }, bearer(s.access));
    expect(ok.statusCode).toBe(200);
    expect((await h.app.inject({ url: "/v1/plan", headers: bearer(ok.json().access_token) })).statusCode).toBe(200);
  });

  it("PIN reset-confirm (allowed while pin_required) → SecurityState: the new code waits 24 h, the session stays locked (T-8)", async () => {
    const other = await login(h);
    h.fake.enablePin(other.userId, "4826");
    const s = await login(h);
    const bad = await post("/v1/profile/security/pin/reset-confirm", { code: "000000", new_pin: "7391" }, bearer(s.access));
    expect(bad.json()).toMatchObject({ code: "RESET_CODE_INVALID", details: { remaining: 4 } });
    const ok = await post("/v1/profile/security/pin/reset-confirm", { code: "246810", new_pin: "7391" }, bearer(s.access));
    expect(ok.statusCode).toBe(200);
    expect(Value.Check(SecurityStateSchema, ok.json())).toBe(true);
    expect(ok.json()).toEqual({
      pin_enabled: true, pin_length: 4, biometric_enabled: false, pin_required: true, locked_until: null,
      pin_reset_effective_at: RESET_EFFECTIVE_AT,
    });
    // ни новой сессии, ни прав родителя: текущая сессия по-прежнему ждёт код, остальные живы
    expect(ok.json().access_token).toBeUndefined();
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(s.access) })).json().code).toBe("PIN_REQUIRED");
    expect((await h.app.inject({ url: "/v1/experience/config", headers: bearer(other.access) })).statusCode).toBe(200);
    // до срока новый код не подходит, прежний — подходит и отменяет сброс
    expect((await post("/v1/session/pin/verify", { pin: "7391" }, bearer(s.access))).json().code).toBe("PIN_INVALID");
    const old = await post("/v1/session/pin/verify", { pin: "4826" }, bearer(s.access));
    expect(old.statusCode).toBe(200);
    expect(old.json().security).toMatchObject({ pin_required: false, pin_reset_effective_at: null });
    expect((await post("/v1/session/refresh", { refresh_token: other.refresh })).statusCode).toBe(200);
  });

  it("due reset takes effect at the next PIN check: the checking session is unlocked, all other sessions are revoked (T-8)", async () => {
    const parent = await login(h);
    h.fake.enablePin(parent.userId, "4826");
    const unlocked = (await post("/v1/session/pin/verify", { pin: "4826" }, bearer(parent.access))).json();
    const s = await login(h);
    await post("/v1/profile/security/pin/reset-confirm", { code: "246810", new_pin: "739104" }, bearer(s.access));
    h.fake.makeResetDue(parent.userId);
    expect((await post("/v1/session/pin/verify", { pin: "4826" }, bearer(s.access))).json().code).toBe("PIN_INVALID");
    const ok = await post("/v1/session/pin/verify", { pin: "739104" }, bearer(s.access));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().security).toMatchObject({ pin_length: 6, pin_required: false, pin_reset_effective_at: null, biometric_enabled: false });
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(ok.json().access_token) })).statusCode).toBe(200);
    // сессия, открытая прежним кодом, отозвана (и её refresh)
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(unlocked.access_token) })).json().code).toBe("SESSION_REVOKED");
    expect((await post("/v1/session/refresh", { refresh_token: unlocked.refresh_token })).json().code).toBe("REFRESH_INVALID");
    // следующая проверка уже ничего не применяет — сессии не отзываются
    const again = await login(h);
    await post("/v1/session/pin/verify", { pin: "739104" }, bearer(again.access));
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(ok.json().access_token) })).statusCode).toBe(200);
  });

  it("POST /v1/profile/security/pin/reset-cancel: old code cancels the pending reset; wrong → 401 PIN_INVALID; allowed while pin_required", async () => {
    const parent = await login(h);
    h.fake.enablePin(parent.userId, "4826");
    const unlocked = (await post("/v1/session/pin/verify", { pin: "4826" }, bearer(parent.access))).json();
    await post("/v1/profile/security/pin/reset-confirm", { code: "246810", new_pin: "7391" }, bearer(unlocked.access_token));
    const profile = await h.app.inject({ url: "/v1/profile", headers: bearer(unlocked.access_token) });
    expect(profile.json().security.pin_reset_effective_at).toBe(RESET_EFFECTIVE_AT);

    const locked = await login(h);
    const wrong = await post("/v1/profile/security/pin/reset-cancel", { current_pin: "0000" }, bearer(locked.access));
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: "PIN_INVALID", details: { remaining: 4 } });
    const stranger = await login(h, TG_OTHER); // свой лимит проверок кода (5/мин на аккаунт)
    for (const body of [{}, { current_pin: "12" }, { current_pin: "4826", extra: 1 }]) {
      const r = await post("/v1/profile/security/pin/reset-cancel", body, bearer(stranger.access));
      expect(r.statusCode, JSON.stringify(body)).toBe(422);
    }
    const ok = await post("/v1/profile/security/pin/reset-cancel", { current_pin: "4826" }, bearer(unlocked.access_token));
    expect(ok.statusCode).toBe(200);
    expect(Value.Check(SecurityStateSchema, ok.json())).toBe(true);
    expect(ok.json()).toMatchObject({ pin_reset_effective_at: null, pin_length: 4, pin_required: false });
    const calls = h.fake.callsTo("identity", "POST", "/internal/v1/me/pin/reset-cancel");
    expect(calls.map((c) => [c.subject, c.body])).toEqual([
      [parent.userId, { current_pin: "0000" }],
      [parent.userId, { current_pin: "4826" }],
    ]);
    // отмена в ожидающей сессии не снимает блокировку сессии
    const lockedCancel = await post("/v1/profile/security/pin/reset-cancel", { current_pin: "4826" }, bearer(locked.access));
    expect(lockedCancel.json().pin_required).toBe(true);
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(locked.access) })).json().code).toBe("PIN_REQUIRED");
  });

  it("reset-cancel and reset-confirm in a child profile → 403 ADULT_REQUIRED; reset-cancel shares the 5/min PIN limit", async () => {
    const parent = await login(h);
    h.fake.setAge(parent.userId, "18+");
    const childId = h.fake.addChild(parent.userId);
    h.fake.onboard(childId);
    const child = await switchTo(h, parent, childId);
    for (const [url, body] of [
      ["/v1/profile/security/pin/reset-cancel", { current_pin: "4826" }],
      ["/v1/profile/security/pin/reset-confirm", { code: "246810", new_pin: "7391" }],
    ] as const) {
      const r = await post(url, body, bearer(child.access));
      expect(r.statusCode, url).toBe(403);
      expect(r.json().code).toBe("ADULT_REQUIRED");
    }
    expect(h.fake.callsTo("identity", "POST", "/internal/v1/me/pin/reset-cancel")).toHaveLength(0);

    h.fake.enablePin(parent.userId, "4826");
    const s = await login(h);
    for (let i = 0; i < 5; i++) await post("/v1/session/pin/verify", { pin: "0000" }, bearer(s.access));
    const limited = await post("/v1/profile/security/pin/reset-cancel", { current_pin: "4826" }, bearer(s.access));
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe("RATE_LIMITED");
  });

  it("setting/changing PIN revokes all OTHER sessions; the current one stays", async () => {
    const a = await login(h);
    const b = await login(h);
    const set = await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: bearer(a.access), payload: { pin: "4826" } });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ pin_enabled: true, pin_length: 4, pin_required: false });
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(a.access) })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(b.access) })).json().code).toBe("SESSION_REVOKED");
    const again = await login(h);
    expect(again.body.security.pin_required).toBe(true);
    const wrongCurrent = await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: bearer(a.access), payload: { pin: "5937", current_pin: "1111" } });
    expect(wrongCurrent.json()).toMatchObject({ code: "PIN_INVALID", details: { remaining: 4 } });
    const fmt = await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: bearer(a.access), payload: { pin: "12345" } });
    expect(fmt.json()).toMatchObject({ code: "PIN_FORMAT", details: { field: "pin" } });
  });

  it("sessions of different accounts are isolated (revoke-all touches only the owner)", async () => {
    const igor = await login(h);
    const other = await login(h, TG_OTHER, "203.0.113.11");
    expect(other.body.account.locale).toBe("uz");
    await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: bearer(igor.access), payload: { pin: "4826" } });
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(other.access) })).statusCode).toBe(200);
  });
});
