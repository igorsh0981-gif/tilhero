/**
 * Вход, сессия и её жизненный цикл: шаги входа, cookie, ротация id, бездействие/абсолют, отзыв по
 * session_version и статусу, привязка к User-Agent, step-up, смена пароля в сессии, logout.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";
import type { LoginStep, Me } from "@tilhero/contracts/admin";
import { SessionStore } from "../src/sessions.js";
import {
  PASSWORD_OK,
  TEST_REDIS_URL,
  TOTP_OK,
  browser,
  json,
  stepUp,
  closeRedis,
  cookieOf,
  domainError,
  login,
  loginAs,
  makeHarness,
  redis,
  type Harness,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const post = (url: string, payload: unknown, headers: Record<string, string> = browser()) =>
  h.app.inject({ method: "POST", url, payload: payload as object, headers });

describe("login flow", () => {
  it("password_change → mfa_enroll → done: cookie __Host-, Me без секретов", async () => {
    const staff = h.fake.addStaff({ role: "super_admin", must_change_password: true, mfa_required: true });
    const r1 = await post("/admin/v1/auth/login", { email: staff.email.toUpperCase(), password: PASSWORD_OK });
    expect(r1.statusCode).toBe(200);
    const s1 = r1.json() as LoginStep;
    expect(s1).toMatchObject({ next: "password_change", me: null });
    expect(s1.challenge).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(r1.headers["set-cookie"]).toBeUndefined();

    const r2 = await post("/admin/v1/auth/password", { challenge: s1.challenge, new_password: "New-Password-2026" });
    expect(r2.statusCode).toBe(200);
    const s2 = r2.json() as LoginStep;
    expect(s2.next).toBe("mfa_enroll");
    expect(r2.headers["set-cookie"]).toBeUndefined();

    const r3 = await post("/admin/v1/auth/mfa/enroll/start", { challenge: s2.challenge });
    expect(r3.statusCode).toBe(200);
    expect(r3.json()).toMatchObject({ issuer: "TilHero Admin", secret: expect.any(String), otpauth_uri: expect.stringMatching(/^otpauth:/) });

    const bad = await post("/admin/v1/auth/mfa/enroll/confirm", { challenge: s2.challenge, code: "000000" });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe("MFA_INVALID");

    const r4 = await post("/admin/v1/auth/mfa/enroll/confirm", { challenge: s2.challenge, code: TOTP_OK });
    expect(r4.statusCode).toBe(200);
    const done = r4.json() as LoginStep;
    expect(done.next).toBe("done");
    expect(done.challenge).toBeNull();
    expect(done.me?.staff.staff_id).toBe(staff.staff_id);
    expect(done.me?.csrf_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(done.me?.session.idle_timeout_seconds).toBe(1800);
    expect(done.me?.env).toBe("test");
    expect(done.me?.impersonating).toBeNull();

    const sc = String(r4.headers["set-cookie"]);
    expect(sc).toMatch(/^__Host-tilhero_admin=[A-Za-z0-9_-]{43}; /);
    for (const attr of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"]) expect(sc).toContain(attr);
    expect(sc).not.toMatch(/Domain=/i);

    // сессия работает
    const id = cookieOf(r4.headers["set-cookie"]);
    const me = await h.app.inject({ url: "/admin/v1/me", headers: browser({ id, csrf: done.me!.csrf_token }) });
    expect(me.statusCode).toBe(200);
    expect((me.json() as Me).staff.email).toBe(staff.email);
  });

  it("MFA подключена: login → mfa → done; неверный код → MFA_INVALID", async () => {
    const staff = h.fake.addStaff({ role: "operations", mfa_enabled: true, mfa_required: true });
    const r1 = await post("/admin/v1/auth/login", { email: staff.email, password: PASSWORD_OK });
    const s1 = r1.json() as LoginStep;
    expect(s1.next).toBe("mfa");
    const wrong = await post("/admin/v1/auth/mfa", { challenge: s1.challenge, code: "111111" });
    expect(wrong.json()).toMatchObject({ code: "MFA_INVALID", details: { remaining: 4 } });
    const ok = await post("/admin/v1/auth/mfa", { challenge: s1.challenge, code: TOTP_OK });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as LoginStep).next).toBe("done");
    expect(ok.headers["set-cookie"]).toBeDefined();
  });

  it("ошибки домена пробрасываются с кодом: INVALID_CREDENTIALS {remaining}, ACCOUNT_LOCKED", async () => {
    const staff = h.fake.addStaff({ role: "support" });
    const bad = await post("/admin/v1/auth/login", { email: staff.email, password: "wrong-password" });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ code: "INVALID_CREDENTIALS", details: { remaining: 4 } });
    h.fake.on("adminIdentity", "POST", "/internal/v1/auth/login", () =>
      new Response(JSON.stringify({ code: "ACCOUNT_LOCKED", message: "x", details: { retry_after: 900 } }), { status: 423 }),
    );
    const locked = await post("/admin/v1/auth/login", { email: staff.email, password: "x" });
    expect(locked.statusCode).toBe(423);
    expect(locked.headers["retry-after"]).toBe("900");
  });

  it("5xx admin-identity → 503 UPSTREAM_UNAVAILABLE {service}, cookie нет; испорченный principal шага — тоже 503", async () => {
    const staff = h.fake.addStaff({ role: "support" });
    h.fake.on("adminIdentity", "POST", "/internal/v1/auth/login", () => domainError(500, "INTERNAL_ERROR"));
    const res = await post("/admin/v1/auth/login", { email: staff.email, password: PASSWORD_OK });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "admin-identity" } });
    expect(res.headers["set-cookie"]).toBeUndefined();
    h.fake.on("adminIdentity", "POST", "/internal/v1/auth/login", () =>
      json(200, { next: "done", principal: { ...h.fake.principal(staff), session_version: "1" } }),
    );
    const broken = await post("/admin/v1/auth/login", { email: staff.email, password: PASSWORD_OK });
    expect(broken.statusCode).toBe(503);
    expect(broken.headers["set-cookie"]).toBeUndefined();
    h.fake.on("adminIdentity", "POST", "/internal/v1/auth/login", () => json(200, { next: "mfa", challenge: "short" }));
    expect((await post("/admin/v1/auth/login", { email: staff.email, password: PASSWORD_OK })).statusCode).toBe(503);
  });

  it("admin-identity недоступен → 503 UPSTREAM_UNAVAILABLE", async () => {
    const staff = h.fake.addStaff({ role: "support" });
    h.fake.down.add("adminIdentity");
    const res = await post("/admin/v1/auth/login", { email: staff.email, password: PASSWORD_OK });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "admin-identity" } });
  });

  it("лишнее поле в теле → 422 VALIDATION_ERROR", async () => {
    const res = await post("/admin/v1/auth/login", { email: "a@b.c", password: "x", remember: true });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { field: "remember" } });
  });

  it("передаёт ip и user_agent в admin-identity", async () => {
    const staff = h.fake.addStaff({ role: "support" });
    await login(h, staff, "203.0.113.9");
    const call = h.fake.callsTo("adminIdentity", "POST", "/internal/v1/auth/login")[0]!;
    expect(call.body).toMatchObject({ ip: "203.0.113.9", user_agent: expect.stringContaining("AdminTest") });
    expect(call.actor).toBeUndefined();
  });
});

describe("session lifecycle", () => {
  it("ротация id при входе (session fixation): прежняя cookie этого браузера удаляется", async () => {
    const staff = h.fake.addStaff({ role: "support" });
    const first = await login(h, staff);
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/v1/auth/login",
      headers: browser(null, { cookie: `__Host-tilhero_admin=${first.id}` }),
      payload: { email: staff.email, password: PASSWORD_OK },
    });
    expect(res.statusCode).toBe(200);
    const second = cookieOf(res.headers["set-cookie"]);
    expect(second).not.toBe(first.id);
    const old = await h.app.inject({ url: "/admin/v1/me", headers: browser(first) });
    expect(old.statusCode).toBe(401);
    expect(old.json().code).toBe("UNAUTHORIZED");
    // подсунутый атакующим id (несуществующий) тоже не принимается
    const forged = await h.app.inject({ url: "/admin/v1/me", headers: browser({ id: "A".repeat(43), csrf: "x" }) });
    expect(forged.statusCode).toBe(401);
  });

  it("в Redis нет самого id сессии (ключ — хеш), значения без пароля", async () => {
    const { s } = await loginAs(h, "support");
    const keys = await redis().keys(`${h.config.redisKeyPrefix}sess:*`);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(s.id);
    const data = await redis().hgetall(keys[0]!);
    expect(Object.keys(data).sort()).toEqual(
      ["created_at", "csrf_token", "impersonating", "ip_hash", "last_seen_at", "session_version", "staff_id", "step_up_until", "superseded_until", "ua_hash"].sort(),
    );
    expect(JSON.stringify(data)).not.toContain(PASSWORD_OK);
  });

  it("бездействие 30 мин → 401 SESSION_EXPIRED и cookie стирается; активность продлевает", async () => {
    const { s } = await loginAs(h, "support");
    h.clock.advance(29 * 60_000);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
    h.clock.advance(29 * 60_000); // продлено предыдущим запросом
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
    h.clock.advance(30 * 60_000 + 1000);
    const res = await h.app.inject({ url: "/admin/v1/me", headers: browser(s) });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("SESSION_EXPIRED");
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).json().code).toBe("UNAUTHORIZED");
  });

  it("абсолютный срок 8 ч даже при активности", async () => {
    const { s } = await loginAs(h, "support");
    for (let i = 0; i < 16; i++) {
      h.clock.advance(29 * 60_000);
      const r = await h.app.inject({ url: "/admin/v1/me", headers: browser(s) });
      expect(r.statusCode).toBe(200);
      const me = r.json() as Me;
      expect(Date.parse(me.session.expires_at)).toBeLessThanOrEqual(Date.parse(s.me.session.expires_at) + 8 * 3600_000);
    }
    h.clock.advance(29 * 60_000); // 17 × 29 мин = 8 ч 13 мин
    const res = await h.app.inject({ url: "/admin/v1/me", headers: browser(s) });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("SESSION_EXPIRED");
  });

  it("рост session_version (смена пароля/роли в admin-identity) → 401 SESSION_REVOKED, сессия удалена", async () => {
    const h0 = h;
    h = await makeHarness({ PRINCIPAL_CACHE_SECONDS: "0" });
    await h0.close();
    const { staff, s } = await loginAs(h, "support");
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
    staff.session_version += 1;
    const res = await h.app.inject({ url: "/admin/v1/me", headers: browser(s) });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("SESSION_REVOKED");
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");
    expect(await redis().keys(`${h.config.redisKeyPrefix}sess:*`)).toHaveLength(0);
  });

  it("сотрудник заблокирован (DISABLED/LOCKED) → SESSION_REVOKED", async () => {
    const h0 = h;
    h = await makeHarness({ PRINCIPAL_CACHE_SECONDS: "0" });
    await h0.close();
    const a = await loginAs(h, "support");
    const b = await loginAs(h, "support");
    a.staff.status = "DISABLED"; // admin-identity: 403 ACCOUNT_DISABLED
    b.staff.status = "LOCKED"; // principal.status ≠ ACTIVE
    for (const s of [a.s, b.s]) {
      const res = await h.app.inject({ url: "/admin/v1/me", headers: browser(s) });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("SESSION_REVOKED");
    }
  });

  it("principal кэшируется ≤ 30 с: повторные запросы не ходят в admin-identity; изменение через BFF сбрасывает кэш", async () => {
    const { staff, s } = await loginAs(h, "super_admin");
    const before = h.fake.callsTo("adminIdentity", "GET", "/internal/v1/staff/").length;
    for (let i = 0; i < 3; i++) await h.app.inject({ url: "/admin/v1/me", headers: browser(s) });
    expect(h.fake.callsTo("adminIdentity", "GET", "/internal/v1/staff/").length).toBe(before);
    expect(await redis().ttl(`${h.config.redisKeyPrefix}principal:${staff.staff_id}`)).toBeLessThanOrEqual(30);

    // другой super_admin блокирует сотрудника через BFF → кэш сброшен → отзыв сразу
    const victim = await loginAs(h, "support");
    await h.app.inject({ url: "/admin/v1/me", headers: browser(victim.s) });
    await stepUp(h, s);
    const patch = await h.app.inject({
      method: "PATCH",
      url: `/admin/v1/staff/${victim.staff.staff_id}`,
      headers: browser(s),
      payload: { status: "DISABLED", reason: "увольнение" },
    });
    expect(patch.statusCode).toBe(200);
    const res = await h.app.inject({ url: "/admin/v1/me", headers: browser(victim.s) });
    expect(res.json().code).toBe("SESSION_REVOKED");
  });

  it("cookie с другим User-Agent → SESSION_REVOKED (кража сессии)", async () => {
    const { s } = await loginAs(h, "support");
    const res = await h.app.inject({ url: "/admin/v1/me", headers: browser(s, { "user-agent": "curl/8.0" }) });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("SESSION_REVOKED");
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(401);
  });

  it("logout: сессия удалена, cookie стёрта, аудит auth.logout через admin-identity (без id сессии из cookie)", async () => {
    const { staff, s } = await loginAs(h, "support");
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(s) });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers["set-cookie"])).toMatch(/^__Host-tilhero_admin=; Path=\/; Max-Age=0/);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(401);
    const call = h.fake.callsTo("adminIdentity", "POST", "/internal/v1/auth/logout")[0]!;
    expect(call.body.staff_id).toBe(staff.staff_id);
    expect(call.body.session_id).toMatch(/^[0-9a-f]{32}$/);
    expect(call.body.session_id).not.toBe(s.id);
  });

  it("logout при недоступном admin-identity — всё равно выход + резервная запись в audit", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("adminIdentity", "POST", "/internal/v1/auth/logout", () => new Response("boom", { status: 500 }));
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(s) });
    expect(res.statusCode).toBe(204);
    const rec = h.fake.callsTo("audit", "POST", "/internal/v1/records")[0]!;
    expect(rec.body.action).toBe("auth.logout");
    expect(rec.actor?.id).toBe(s.me.staff.staff_id);
  });
});

describe("выход безотказный (ревью T2-1)", () => {
  it("admin-identity недоступен и кэш principal истёк → 204, cookie стёрта, сессия удалена; та же cookie потом → 401", async () => {
    const { staff, s } = await loginAs(h, "support");
    await redis().del(`${h.config.redisKeyPrefix}principal:${staff.staff_id}`); // кэш principal истёк (> 30 с)
    h.fake.down.add("adminIdentity");
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(s) });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers["set-cookie"])).toMatch(/^__Host-tilhero_admin=; Path=\/; Max-Age=0/);
    expect(await redis().keys(`${h.config.redisKeyPrefix}sess:*`)).toHaveLength(0);
    // резервная запись auth.logout в audit — с actor сотрудника (из сессии: principal недоступен)
    const rec = h.fake.callsTo("audit", "POST", "/internal/v1/records").at(-1)!;
    expect(rec.body).toMatchObject({ action: "auth.logout", object_type: "staff", object_id: staff.staff_id });
    expect(rec.actor?.id).toBe(staff.staff_id);
    h.fake.down.delete("adminIdentity");
    h.clock.advance(5 * 60_000);
    const me = await h.app.inject({ url: "/admin/v1/me", headers: browser(s) });
    expect(me.statusCode).toBe(401);
    expect(me.json().code).toBe("UNAUTHORIZED");
  });

  it("и admin-identity, и audit недоступны → всё равно 204 и сессии нет", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.down.add("adminIdentity");
    h.fake.down.add("audit");
    expect((await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(s) })).statusCode).toBe(204);
    h.fake.down.clear();
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(401);
  });

  it("лимит команд (adm.command) и лимит сотрудника выход не блокируют; admin-identity при выходе не опрашивается о principal", async () => {
    await h.close();
    h = await makeHarness({ RATE_LIMIT_STAFF_PER_MIN: "3", PRINCIPAL_CACHE_SECONDS: "0" });
    const { s } = await loginAs(h, "support");
    for (let i = 0; i < 3; i++) await h.app.inject({ url: "/admin/v1/me", headers: browser(s) });
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(429);
    const principalCalls = h.fake.callsTo("adminIdentity", "GET", "/internal/v1/staff/").length;
    expect((await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(s) })).statusCode).toBe(204);
    expect(h.fake.callsTo("adminIdentity", "GET", "/internal/v1/staff/")).toHaveLength(principalCalls);
  });

  it("CSRF и Origin по-прежнему обязательны: без токена → 403, сессия жива", async () => {
    const { s } = await loginAs(h, "support");
    const { "x-csrf-token": _drop, ...noToken } = browser(s);
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: noToken });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("CSRF_INVALID");
    expect((await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(s, { origin: "https://evil.example" }) })).statusCode).toBe(403);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
  });
});

describe("выход при сбое Redis (ревью T2-10)", () => {
  const CLEARED = /^__Host-tilhero_admin=; Path=\/; Max-Age=0; Secure; HttpOnly; SameSite=Strict$/;

  it("Redis недоступен при чтении сессии → 503 SESSION_NOT_REVOKED, cookie всё равно стёрта; аудит выхода не пишется", async () => {
    // отдельный клиент Redis этого процесса — его и «роняем»; сервер Redis и общий клиент тестов живы
    const own = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 0 });
    await h.close();
    h = await makeHarness({}, { redis: own });
    try {
      const { s } = await loginAs(h, "support");
      own.disconnect();
      const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(s) });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "SESSION_NOT_REVOKED", details: { service: "session-store" } });
      expect(String(res.headers["set-cookie"])).toMatch(CLEARED);
      // ответ честный: сессия на сервере осталась (её дочистит бездействие)
      expect(await redis().keys(`${h.config.redisKeyPrefix}sess:*`)).toHaveLength(1);
      expect(h.fake.callsTo("adminIdentity", "POST", "/internal/v1/auth/logout")).toHaveLength(0);
      expect(h.fake.callsTo("audit", "POST", "/internal/v1/records")).toHaveLength(0);
      expect(h.logs.text).toContain("logout_session_not_revoked");
      expect(h.logs.text).not.toContain(s.id);
      // чужой Origin проверяется до Redis: 403 CSRF_INVALID и cookie не трогается
      const evil = await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(s, { origin: "https://evil.example" }) });
      expect(evil.statusCode).toBe(403);
      expect(evil.json().code).toBe("CSRF_INVALID");
      expect(evil.headers["set-cookie"]).toBeUndefined();
      // прочие маршруты при сбое Redis — прежний 503 UPSTREAM_UNAVAILABLE без стирания cookie
      const me = await h.app.inject({ url: "/admin/v1/me", headers: browser(s) });
      expect(me.statusCode).toBe(503);
      expect(me.json().code).toBe("UPSTREAM_UNAVAILABLE");
      expect(me.headers["set-cookie"]).toBeUndefined();
    } finally {
      await h.close();
      own.disconnect();
    }
  });

  it("сбой Redis при удалении сессии → 503 SESSION_NOT_REVOKED со стёртой cookie; повторный выход после восстановления → 204", async () => {
    const { s } = await loginAs(h, "support");
    const del = vi.spyOn(SessionStore.prototype, "delete").mockRejectedValueOnce(new Error("READONLY You can't write against a read only replica"));
    try {
      const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(s) });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("SESSION_NOT_REVOKED");
      expect(String(res.headers["set-cookie"])).toMatch(CLEARED);
      expect(h.fake.callsTo("adminIdentity", "POST", "/internal/v1/auth/logout")).toHaveLength(0);
      expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
      const again = await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(s) });
      expect(again.statusCode).toBe(204);
      expect(String(again.headers["set-cookie"])).toMatch(CLEARED);
      expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(401);
    } finally {
      del.mockRestore();
    }
  });

  it("CSRF-токен по-прежнему сверяется, когда Redis доступен: без токена → 403 без стирания cookie", async () => {
    const { s } = await loginAs(h, "support");
    const { "x-csrf-token": _drop, ...noToken } = browser(s);
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: noToken });
    expect(res.statusCode).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

describe("step-up", () => {
  it("маршрут с requireStepUp: 403 STEP_UP_REQUIRED → step-up → проходит → через 5 мин снова 403", async () => {
    const { s } = await loginAs(h, "super_admin");
    const create = () =>
      h.app.inject({
        method: "POST",
        url: "/admin/v1/staff",
        headers: { ...browser(s), "idempotency-key": "create-staff-0001" },
        payload: { email: "new@tilhero.test", display_name: "Новый", role: "support" },
      });
    const r1 = await create();
    expect(r1.statusCode).toBe(403);
    expect(r1.json()).toMatchObject({ code: "STEP_UP_REQUIRED", details: { permission: "staff.manage" } });
    expect(h.fake.callsTo("adminIdentity", "POST", "/admin/v1/staff")).toHaveLength(0); // домен не вызывался

    const wrong = await h.app.inject({ method: "POST", url: "/admin/v1/auth/step-up", headers: browser(s), payload: { code: "000000" } });
    expect(wrong.json().code).toBe("MFA_INVALID");
    const oldId = s.id;
    const su = await stepUp(h, s);
    expect(su.statusCode).toBe(200);
    const until = Date.parse(su.json().step_up_until);
    expect(until - h.clock.t).toBe(300_000);
    // step-up ротирует id: новая cookie __Host-, повышенный доступ — только у нового id
    expect(s.id).not.toBe(oldId);
    expect(String(su.headers["set-cookie"])).toMatch(/^__Host-tilhero_admin=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/);
    const viaOld = await h.app.inject({
      method: "POST",
      url: "/admin/v1/staff",
      headers: { ...browser({ id: oldId, csrf: s.csrf }), "idempotency-key": "create-staff-0002" },
      payload: { email: "old@tilhero.test", display_name: "Старый", role: "support" },
    });
    expect(viaOld.json().code).toBe("STEP_UP_REQUIRED");

    const r2 = await create();
    expect(r2.statusCode).toBe(201);
    expect(r2.json().temporary_password).toBeDefined(); // разовая выдача по контракту
    const me = (await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).json() as Me;
    expect(me.session.step_up_until).toBe(su.json().step_up_until);

    h.clock.advance(300_001);
    expect((await create()).json().code).toBe("STEP_UP_REQUIRED");
  });

  it("старый id после step-up: ещё 15 с работает без step-up и не продлевается; потом 401; logout по нему завершает и новую", async () => {
    const { s } = await loginAs(h, "super_admin");
    const oldId = s.id;
    const old = { id: oldId, csrf: s.csrf };
    await stepUp(h, s);
    // запрос, ушедший со старой cookie до ответа step-up, не выбрасывает на вход
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(old) })).statusCode).toBe(200);
    const me = (await h.app.inject({ url: "/admin/v1/me", headers: browser(old) })).json() as Me;
    expect(me.session.step_up_until).toBeNull();
    // повторный step-up по замещённому id: 409 SESSION_ROTATED без Set-Cookie (новая cookie вкладки не стирается)
    const callsBefore = h.fake.callsTo("adminIdentity", "POST", "/internal/v1/auth/step-up").length;
    const again = await h.app.inject({ method: "POST", url: "/admin/v1/auth/step-up", headers: browser(old), payload: { code: TOTP_OK } });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("SESSION_ROTATED");
    expect(again.headers["set-cookie"]).toBeUndefined();
    expect(h.fake.callsTo("adminIdentity", "POST", "/internal/v1/auth/step-up")).toHaveLength(callsBefore); // код не потрачен
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
    // logout по старому id (гонка) завершает и новую сессию
    expect((await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(old) })).statusCode).toBe(204);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(401);

    // по истечении окна старый id — 401
    const b = await loginAs(h, "super_admin");
    const bOld = { id: b.s.id, csrf: b.s.csrf };
    await stepUp(h, b.s);
    h.clock.advance(15_001);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(bOld) })).statusCode).toBe(401);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(b.s) })).statusCode).toBe(200);

    // logout по новому id завершает и ещё живой старый
    const c = await loginAs(h, "super_admin");
    const cOld = { id: c.s.id, csrf: c.s.csrf };
    await stepUp(h, c.s);
    expect((await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(c.s) })).statusCode).toBe(204);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(cOld) })).statusCode).toBe(401);
  });

  it("две вкладки: вторая ротация того же id (гонка) → 409 SESSION_ROTATED без Set-Cookie, новая сессия жива", async () => {
    const { s } = await loginAs(h, "super_admin");
    const old = { id: s.id, csrf: s.csrf };
    const tabA = { ...s };
    // вкладка B уже прошла authenticate и ждёт admin-identity, а вкладка A в это время завершает step-up
    h.fake.on("adminIdentity", "POST", "/internal/v1/auth/step-up", async () => {
      h.fake.overrides.delete("adminIdentity POST /internal/v1/auth/step-up");
      const a = await stepUp(h, tabA);
      expect(a.statusCode).toBe(200);
      return json(200, { ok: true });
    });
    const b = await h.app.inject({ method: "POST", url: "/admin/v1/auth/step-up", headers: browser(old), payload: { code: TOTP_OK } });
    expect(b.statusCode).toBe(409);
    expect(b.json().code).toBe("SESSION_ROTATED");
    expect(b.headers["set-cookie"]).toBeUndefined();
    // браузер теперь шлёт cookie вкладки A — сессия с step-up жива, повтор действия проходит
    expect(((await h.app.inject({ url: "/admin/v1/me", headers: browser(tabA) })).json() as Me).session.step_up_until).not.toBeNull();
  });

  it("смена пароля по замещённому id → 409 SESSION_ROTATED без Set-Cookie, admin-identity не вызывается", async () => {
    const { s } = await loginAs(h, "support");
    const old = { id: s.id, csrf: s.csrf };
    await stepUp(h, s);
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/v1/auth/password",
      headers: browser(old),
      payload: { current_password: PASSWORD_OK, new_password: "Another-Passw0rd-1" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("SESSION_ROTATED");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(h.fake.callsTo("adminIdentity", "POST", "/internal/v1/auth/password")).toHaveLength(0);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
  });

  it("step-up одновременно с logout: новая сессия не создаётся (атомарная ротация)", async () => {
    const { s } = await loginAs(h, "super_admin");
    h.fake.on("adminIdentity", "POST", "/internal/v1/auth/step-up", async () => {
      // пока admin-identity проверяет код, сотрудник выходит в другой вкладке
      await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(s) });
      return json(200, { ok: true });
    });
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/step-up", headers: browser(s), payload: { code: TOTP_OK } });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");
    const keys = await redis().keys(`${h.config.redisKeyPrefix}sess:*`);
    expect(keys).toHaveLength(0);
  });

  it("step-up: 5 попыток в минуту на сотрудника → 429", async () => {
    const { s } = await loginAs(h, "super_admin");
    for (let i = 0; i < 5; i++) {
      const r = await h.app.inject({ method: "POST", url: "/admin/v1/auth/step-up", headers: browser(s), payload: { code: "000000" } });
      expect(r.statusCode).toBe(401);
    }
    const r = await h.app.inject({ method: "POST", url: "/admin/v1/auth/step-up", headers: browser(s), payload: { code: TOTP_OK } });
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe("RATE_LIMITED");
  });
});

describe("фоновые запросы", () => {
  it("X-Background: 1 не продлевает сессию: опрос 31 мин → SESSION_EXPIRED", async () => {
    const { s } = await loginAs(h, "support");
    const bg = browser(s, { "x-background": "1" });
    for (let i = 0; i < 5; i++) {
      h.clock.advance(5 * 60_000);
      const r = await h.app.inject({ url: "/admin/v1/me", headers: bg });
      expect(r.statusCode).toBe(200);
      // expires_at не сдвигается фоновыми запросами
      expect(Date.parse((r.json() as Me).session.expires_at)).toBe(h.clock.t - (i + 1) * 5 * 60_000 + 30 * 60_000);
    }
    h.clock.advance(6 * 60_000); // 31 мин без действий сотрудника
    const r = await h.app.inject({ url: "/admin/v1/me", headers: bg });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe("SESSION_EXPIRED");
  });

  it("обычный запрос продлевает, X-Background с другим значением — тоже обычный", async () => {
    const { s } = await loginAs(h, "support");
    h.clock.advance(20 * 60_000);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s, { "x-background": "0" }) })).statusCode).toBe(200);
    h.clock.advance(20 * 60_000);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
  });
});

describe("password change in session", () => {
  it("с current_password: новый id сессии, session_version обновлена, старая cookie не работает", async () => {
    const { staff, s } = await loginAs(h, "support");
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/v1/auth/password",
      headers: browser(s),
      payload: { current_password: PASSWORD_OK, new_password: "Another-Passw0rd-1" },
    });
    expect(res.statusCode).toBe(200);
    const step = res.json() as LoginStep;
    expect(step.next).toBe("done");
    const id = cookieOf(res.headers["set-cookie"]);
    expect(id).not.toBe(s.id);
    expect(staff.session_version).toBe(2);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(401);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser({ id, csrf: step.me!.csrf_token }) })).statusCode).toBe(200);
  });

  it("principal после смены пароля не кладётся в кэш из ответа шага — только сброс", async () => {
    const { staff, s } = await loginAs(h, "support");
    const key = `${h.config.redisKeyPrefix}principal:${staff.staff_id}`;
    expect(await redis().exists(key)).toBe(1); // заполнен при входе
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/v1/auth/password",
      headers: browser(s),
      payload: { current_password: PASSWORD_OK, new_password: "Another-Passw0rd-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(await redis().exists(key)).toBe(0);
  });

  it("смена пароля одновременно с logout: новая сессия не создаётся, 401 SESSION_REVOKED", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("adminIdentity", "POST", "/internal/v1/auth/password", async (c) => {
      await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(s) });
      const st = h.fake.staff.get(c.body.staff_id)!;
      st.session_version += 1;
      return json(200, { next: "done", principal: h.fake.principal(st) });
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/v1/auth/password",
      headers: browser(s),
      payload: { current_password: PASSWORD_OK, new_password: "Another-Passw0rd-1" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("SESSION_REVOKED");
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");
    expect(await redis().keys(`${h.config.redisKeyPrefix}sess:*`)).toHaveLength(0);
  });

  it("без challenge и без сессии → 401; без current_password → 422; без CSRF → 403", async () => {
    const anon = await post("/admin/v1/auth/password", { new_password: "Another-Passw0rd-1" });
    expect(anon.statusCode).toBe(401);
    const { s } = await loginAs(h, "support");
    const noCurrent = await h.app.inject({ method: "POST", url: "/admin/v1/auth/password", headers: browser(s), payload: { new_password: "Another-Passw0rd-1" } });
    expect(noCurrent.statusCode).toBe(422);
    const noCsrf = await h.app.inject({
      method: "POST",
      url: "/admin/v1/auth/password",
      headers: browser(s, { "x-csrf-token": "nope" }),
      payload: { current_password: PASSWORD_OK, new_password: "Another-Passw0rd-1" },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().code).toBe("CSRF_INVALID");
  });
});
