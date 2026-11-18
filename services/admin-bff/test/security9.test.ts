/**
 * Q5 спринта 9 — матрица безопасности admin-bff (docs/sprint9/INTERNAL_API.md §3). Дополняет security.test.ts и
 * routes.test.ts (A30, A31, CSRF/Origin на одном маршруте, step-up всех маршрутов, имперсонация, логи):
 *  - SEC-07: реестр adminRoutes × 8 ролей матрицы по умолчанию — маршрут без права роли → 403 PERMISSION_DENIED
 *    {permission}, домен не вызывается (сверка самой матрицы с admin-identity — infra/security/test_sec07_rbac_catalog.py);
 *  - SEC-06: КАЖДЫЙ небезопасный маршрут без X-CSRF-Token / с токеном другой сессии / с чужим Origin → 403;
 *  - SEC-05: новая сессия после входа (cookie, подложенная до входа, не становится сессией), бездействие → 401,
 *    выход отзывает сессию во всех вкладках (та же cookie в другой вкладке → 401);
 *  - SEC-12: ответы с данными — Cache-Control: no-store; CORS нет (ни Access-Control-Allow-Origin, ни preflight);
 *  - Q2/SEC-15: ключи лимитера входа в Redis — без IP и e-mail в открытом виде (хеши), 429 с Retry-After.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Permission, RoleCode } from "@tilhero/contracts/admin";
import { DEFAULT_ROLE_MATRIX } from "../src/rbac.js";
import { ALL_PERMISSIONS } from "../src/rbac.js";
import { SESSION_COOKIE } from "../src/cookies.js";
import { ORIGIN, avoidWindowEdge, browser, closeRedis, cookieOf, loginAs, makeHarness, redis, type Harness } from "./helpers.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const ID = "5b1f0d0e-1111-4c2b-9a51-0d6c7a1e2f30";
function concrete(url: string): string {
  return url
    .replace("::", "~")
    .replace(":app", "admin")
    .replace(":code", "support")
    .replace(":version", "1.0.0")
    .replace(":paymentId", "pay_1")
    .replace(/:[A-Za-z]+/g, ID)
    .replace("~", ":");
}
const isPermission = (g: string): g is Permission => (ALL_PERMISSIONS as readonly string[]).includes(g);
const sessionRoutes = () => h.app.adminRoutes.filter((r) => r.access === "session");
const ROLES = Object.keys(DEFAULT_ROLE_MATRIX) as RoleCode[];

describe("SEC-07: реестр маршрутов × 8 ролей", () => {
  beforeEach(async () => {
    // вход каждого из ~20 сотрудников — с одного IP теста: лимит входа здесь не предмет проверки
    h = await makeHarness({ RATE_LIMIT_LOGIN_IP_PER_MIN: "1000", RATE_LIMIT_AUTH_STEP_IP_PER_MIN: "1000" });
    await avoidWindowEdge();
  });

  it("матрица ролей — 8 ролей, у каждой маршрута с правом вне её набора → 403 PERMISSION_DENIED", async () => {
    expect(ROLES).toHaveLength(8);
    const guarded = sessionRoutes().filter((r) => isPermission(r.guard));
    expect(guarded.length).toBeGreaterThanOrEqual(80);
    let checked = 0;
    for (const role of ROLES) {
      const own = new Set<string>(DEFAULT_ROLE_MATRIX[role]);
      const denied = guarded.filter((r) => !own.has(r.guard));
      // лимит adm.command (60/мин на сотрудника) считается до проверки права: свежий сотрудник на каждые 40 команд
      let session = (await loginAs(h, role)).s;
      let used = 0;
      const before = h.fake.calls.length;
      for (const r of denied) {
        if (used++ >= 40) {
          session = (await loginAs(h, role)).s;
          used = 1;
        }
        const res = await h.app.inject({
          method: r.method as "GET",
          url: concrete(r.url),
          headers: browser(session),
          ...(r.method === "GET" || r.method === "DELETE" ? {} : { payload: {} }),
        });
        expect(res.statusCode, `${role} ${r.method} ${r.url}`).toBe(403);
        expect(res.json(), `${role} ${r.method} ${r.url}`).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: r.guard } });
        checked++;
      }
      // кроме входа (admin-identity) домены не вызывались
      expect(h.fake.calls.slice(before).filter((c) => c.service !== "adminIdentity"), role).toEqual([]);
    }
    expect(checked).toBeGreaterThan(300);
  });

  it("у каждой роли есть хотя бы один разрешённый маршрут кроме /me (роль не «пустая»)", () => {
    const guarded = sessionRoutes().filter((r) => isPermission(r.guard));
    for (const role of ROLES) {
      const own = new Set<string>(DEFAULT_ROLE_MATRIX[role]);
      expect(guarded.some((r) => own.has(r.guard)), role).toBe(true);
    }
  });
});

describe("SEC-06: CSRF на каждом небезопасном маршруте", () => {
  beforeEach(async () => {
    h = await makeHarness();
    await avoidWindowEdge();
  });

  it("без X-CSRF-Token, с токеном другой сессии, с чужим Origin → 403, домен не вызывается", async () => {
    const unsafe = sessionRoutes().filter((r) => r.method !== "GET" && r.method !== "HEAD");
    expect(unsafe.length).toBeGreaterThanOrEqual(50);
    const { s } = await loginAs(h, "super_admin");
    const other = (await loginAs(h, "super_admin")).s;
    const before = h.fake.calls.length;
    const { "x-csrf-token": _drop, ...noToken } = browser(s);
    const variants: Array<[string, Record<string, string>]> = [
      ["без токена", noToken],
      ["токен другой сессии", browser(s, { "x-csrf-token": other.csrf })],
      ["чужой Origin", browser(s, { origin: "https://evil.example" })],
    ];
    for (const r of unsafe) {
      for (const [name, headers] of variants) {
        const res = await h.app.inject({ method: r.method as "POST", url: concrete(r.url), headers, payload: {} });
        expect(res.statusCode, `${name}: ${r.method} ${r.url}`).toBe(403);
        expect(["CSRF_INVALID", "PERMISSION_DENIED"], `${name}: ${r.method} ${r.url}`).toContain(res.json().code);
      }
    }
    expect(h.fake.calls.slice(before).filter((c) => c.service !== "adminIdentity")).toEqual([]);
  });
});

describe("SEC-05: сессия сотрудника", () => {
  beforeEach(async () => {
    h = await makeHarness();
    await avoidWindowEdge();
  });

  it("cookie: __Host-, Secure, HttpOnly, SameSite=Strict, Path=/, без Domain", async () => {
    const staff = h.fake.addStaff({ role: "support" });
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/login", headers: browser(), payload: { email: staff.email, password: staff.password } });
    const sc = String(res.headers["set-cookie"]);
    expect(sc.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    for (const attr of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"]) expect(sc).toContain(attr);
    expect(sc).not.toMatch(/Domain=/i);
  });

  it("фиксация: cookie, подложенная до входа, не становится сессией; вход выдаёт новый id", async () => {
    const planted = "A".repeat(43);
    const staff = h.fake.addStaff({ role: "support" });
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/v1/auth/login",
      headers: browser(null, { cookie: `${SESSION_COOKIE}=${planted}` }),
      payload: { email: staff.email, password: staff.password },
    });
    expect(res.statusCode).toBe(200);
    expect(cookieOf(res.headers["set-cookie"])).not.toBe(planted);
    const me = await h.app.inject({ url: "/admin/v1/me", headers: browser(null, { cookie: `${SESSION_COOKIE}=${planted}` }) });
    expect(me.statusCode).toBe(401);
  });

  it("бездействие дольше SESSION_IDLE_SECONDS → 401; активность продлевает", async () => {
    const { s } = await loginAs(h, "support");
    const idle = h.config.session.idleSeconds * 1000;
    h.clock.advance(idle - 5_000);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
    h.clock.advance(idle - 5_000);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
    h.clock.advance(idle + 1_000);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(401);
  });

  it("выход отзывает сессию во всех вкладках (та же cookie в другой вкладке → 401)", async () => {
    const { s } = await loginAs(h, "support");
    const tab2 = { ...s };
    const out = await h.app.inject({ method: "POST", url: "/admin/v1/auth/logout", headers: browser(s), payload: {} });
    expect([200, 204]).toContain(out.statusCode);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(tab2) })).statusCode).toBe(401);
  });
});

describe("SEC-12: заголовки ответов admin-bff", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("данные сотрудника — Cache-Control: no-store; CORS нет ни для чужого, ни для своего Origin", async () => {
    const { s } = await loginAs(h, "support");
    for (const origin of [ORIGIN, "https://evil.example"]) {
      const res = await h.app.inject({ url: "/admin/v1/me", headers: browser(s, { origin }) });
      expect(res.headers["cache-control"]).toContain("no-store");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
      const pre = await h.app.inject({
        method: "OPTIONS",
        url: "/admin/v1/me",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "x-csrf-token" },
      });
      expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });
});

describe("Q2 / SEC-15: ключи лимитера входа", () => {
  beforeEach(async () => {
    h = await makeHarness();
    await avoidWindowEdge();
  });

  it("в Redis нет IP и e-mail в открытом виде; 429 с Retry-After", async () => {
    const email = "Brute.Force.Target@tilhero.test";
    const ip = "203.0.113.77";
    let last = 0;
    let retryAfter: string | undefined;
    for (let i = 0; i < 7; i++) {
      const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/login", headers: browser(), remoteAddress: ip, payload: { email, password: "wrong-password-1" } });
      last = res.statusCode;
      retryAfter = res.headers["retry-after"] as string | undefined;
    }
    expect(last).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    const keys = await redis().keys(`${h.config.redisKeyPrefix}*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k.toLowerCase(), k).not.toContain(email.toLowerCase());
      expect(k, k).not.toContain(ip);
    }
  });
});
