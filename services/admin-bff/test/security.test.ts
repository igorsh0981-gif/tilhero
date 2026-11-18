/**
 * Безопасность admin-bff: A30 (все защищённые маршруты без cookie → 401), A31 (billing refund), A43 (редакция
 * AI-контента), CSRF/Origin, fail-closed регистрация маршрутов, RBAC до вызова домена, actor-токен,
 * имперсонация (dev) и 404 в prod, rate limit входа, отсутствие секретов в логах.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoginStep, Me } from "@tilhero/contracts/admin";
import { verifyInternalToken } from "@tilhero/ts-common";
import { buildApp } from "../src/app.js";
import { requirePermission } from "../src/rbac.js";
import { sha256hex } from "../src/sessions.js";
import {
  INTERNAL_SECRET,
  ORIGIN,
  PASSWORD_OK,
  TOTP_OK,
  UA,
  USER_ID,
  avoidWindowEdge,
  browser,
  stepUp,
  closeRedis,
  json,
  loginAs,
  makeHarness,
  redis,
  testConfig,
  type Harness,
} from "./helpers.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

/** Подставить значения параметров пути (валидные по схеме). */
function concrete(url: string): string {
  return url
    .replace("::", "~") // буквальное двоеточие (content::reveal)
    .replace(":app", "admin")
    .replace(":code", "support")
    .replace(":version", "1.0.0")
    .replace(":paymentId", "pay_1")
    .replace(/:[A-Za-z]+/g, "5b1f0d0e-1111-4c2b-9a51-0d6c7a1e2f30")
    .replace("~", ":");
}

describe("A30: каждый сессионный маршрут без cookie → 401", () => {
  beforeEach(async () => {
    h = await makeHarness({ ENV: "dev", NODE_ENV: "development" });
  });

  it("перебор всех зарегистрированных маршрутов (в т.ч. dev) — 401 UNAUTHORIZED, домены не вызываются", async () => {
    const routes = h.app.adminRoutes.filter((r) => r.access === "session");
    expect(routes.length).toBeGreaterThanOrEqual(40);
    for (const r of routes) {
      for (const headers of [browser(), browser({ id: "Z".repeat(43), csrf: "x" }), browser(null, { cookie: "__Host-tilhero_admin=garbage" })]) {
        const res = await h.app.inject({ method: r.method as "GET", url: concrete(r.url), headers, payload: r.method === "GET" ? undefined : {} });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
        expect(res.json().code).toBe("UNAUTHORIZED");
      }
    }
    expect(h.fake.calls).toHaveLength(0);
  });

  it("публичные маршруты — только шаги входа", () => {
    const pub = h.app.adminRoutes.filter((r) => r.access === "public").map((r) => r.url).sort();
    expect(pub).toEqual([
      "/admin/v1/auth/login",
      "/admin/v1/auth/mfa",
      "/admin/v1/auth/mfa/enroll/confirm",
      "/admin/v1/auth/mfa/enroll/start",
      "/admin/v1/auth/password",
    ]);
  });

  it("покрыты все маршруты контракта admin.ts", () => {
    const have = new Set(h.app.adminRoutes.map((r) => `${r.method} ${r.url}`));
    const expected = [
      "POST /admin/v1/auth/step-up",
      "POST /admin/v1/auth/logout",
      "GET /admin/v1/me",
      "GET /admin/v1/dashboard",
      "GET /admin/v1/users",
      "GET /admin/v1/users/:id",
      "POST /admin/v1/users/:id/reveal",
      "GET /admin/v1/support/tickets",
      "GET /admin/v1/support/tickets/:id",
      "GET /admin/v1/support/tickets/:id/client-view",
      "POST /admin/v1/support/tickets/:id/messages",
      "PATCH /admin/v1/support/tickets/:id",
      "POST /admin/v1/support/tickets/:id/take",
      "POST /admin/v1/support/tickets/:id/escalations",
      "POST /admin/v1/support/tickets/:id/ai-draft",
      "GET /admin/v1/support/templates",
      "GET /admin/v1/support/sla-policies",
      "GET /admin/v1/support/stats",
      "PUT /admin/v1/support/sla-policies",
      "GET /admin/v1/staff",
      "POST /admin/v1/staff",
      "PATCH /admin/v1/staff/:id",
      "POST /admin/v1/staff/:id/reset-password",
      "POST /admin/v1/staff/:id/reset-mfa",
      "GET /admin/v1/roles",
      "PUT /admin/v1/roles/:code",
      "GET /admin/v1/approvals",
      "POST /admin/v1/approvals/:id/approve",
      "POST /admin/v1/approvals/:id/reject",
      "GET /admin/v1/audit/records",
      "GET /admin/v1/audit/records/:id",
      "GET /admin/v1/audit/verify",
      "GET /admin/v1/experience/:app/state",
      "GET /admin/v1/experience/admin/current",
      "GET /admin/v1/experience/miniapp/current",
      "GET /admin/v1/experience/:app/versions",
      "GET /admin/v1/experience/:app/versions/:version",
      "GET /admin/v1/experience/:app/activations",
      "POST /admin/v1/experience/:app/versions",
      "POST /admin/v1/experience/:app/activate",
      "POST /admin/v1/experience/:app/rollback",
      "POST /admin/v1/billing/payments/:paymentId/refunds",
      "POST /admin/v1/dev/impersonate",
      // спринт 4 (admin.ts «Спринт 4»)
      "GET /admin/v1/review",
      "GET /admin/v1/review/:id",
      "POST /admin/v1/review/:id/accept",
      "POST /admin/v1/review/:id/reject",
      "POST /admin/v1/review/:id/correct",
      "GET /admin/v1/sources",
      "GET /admin/v1/sources/:id",
      "GET /admin/v1/sources/crawl-stats",
      "POST /admin/v1/sources",
      "PATCH /admin/v1/sources/:id",
      "POST /admin/v1/sources/json-api/preview", // исправление 9.3
      "GET /admin/v1/discovery/runs",
      "GET /admin/v1/discovery/runs/:id",
      "POST /admin/v1/discovery/runs",
      "GET /admin/v1/discovery/budget",
      "PUT /admin/v1/discovery/pause",
    ];
    for (const e of expected) expect(have.has(e), e).toBe(true);
  });

  it("step-up объявлен на всех изменениях сотрудников/ролей/заявок, источников и kill switch AI", () => {
    const stepUp = h.app.adminRoutes.filter((r) => r.stepUp).map((r) => `${r.method} ${r.url}`).sort();
    expect(stepUp).toEqual(
      [
        "POST /admin/v1/staff",
        "PATCH /admin/v1/staff/:id",
        "POST /admin/v1/staff/:id/reset-password",
        "POST /admin/v1/staff/:id/reset-mfa",
        "PUT /admin/v1/roles/:code",
        "POST /admin/v1/approvals/:id/approve",
        "POST /admin/v1/approvals/:id/reject",
        // спринт 4: создание источника, kill switch AI (PATCH источника — условный step-up в обработчике)
        "POST /admin/v1/sources",
        "PUT /admin/v1/discovery/pause",
        // исправление 6.1: лимиты AI из админки
        "PUT /admin/v1/discovery/limits",
        "DELETE /admin/v1/discovery/limits",
        // спринт 7: лимиты и kill switch агентов/провайдера, конфиг агента, активация каталога цен, уровни доступа,
        // публикация и откат skill, раскрытие содержимого AI-запроса
        "PUT /admin/v1/ai/limits",
        "DELETE /admin/v1/ai/limits",
        "PUT /admin/v1/ai/agents/:agentId/pause",
        "PUT /admin/v1/ai/providers/anthropic/pause",
        "PATCH /admin/v1/ai/agents/:agentId",
        "POST /admin/v1/ai/pricing/versions/:ref",
        "PUT /admin/v1/ai/access-levels/:code",
        "DELETE /admin/v1/ai/access-levels/:code",
        "POST /admin/v1/ops/dlq/replay",
        "POST /admin/v1/ops/dlq/delete",
        "POST /admin/v1/skills/:skillId/versions/:v/publish",
        "POST /admin/v1/skills/:skillId/rollback",
        "POST /admin/v1/usage/requests/:requestId/content::reveal",
        // спринт 9: повтор удаления профиля, переопределение и сброс лимита
        "POST /admin/v1/deletions/:request_id::retry",
        "PUT /admin/v1/ops/ratelimits/:policy/override",
        "DELETE /admin/v1/ops/ratelimits/:policy/override",
      ].sort(),
    );
  });
});

describe("fail-closed регистрация маршрутов", () => {
  it("маршрут /admin/v1 без объявленного права или схемы ответа не регистрируется", async () => {
    const app = await buildApp(testConfig(), { redis: redis(), fetchImpl: async () => json(200, {}), logStream: { write() {} } });
    try {
      expect(() => app.get("/admin/v1/secret", async () => ({ ok: true }))).toThrow(/без объявленного доступа/);
      expect(() => app.get("/admin/v1/secret2", { config: { access: "session" } }, async () => ({}))).toThrow(/без объявленного права/);
      expect(() => app.get("/internal/v1/x", { config: requirePermission("users.read") }, async () => ({}))).toThrow(/вне \/admin\/v1/);
      expect(() => app.get("/admin/v1/raw", { config: requirePermission("users.read") }, async () => ({}))).toThrow(/без схемы ответа/);
      expect(() =>
        app.get("/admin/v1/ok", { config: requirePermission("users.read"), schema: { response: { "2xx": { type: "object" } } } }, async () => ({})),
      ).not.toThrow();
    } finally {
      await app.close();
    }
  });
});

describe("A31: billing refund", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });
  const refund = (s: Parameters<typeof browser>[0]) =>
    h.app.inject({ method: "POST", url: "/admin/v1/billing/payments/pay_42/refunds", headers: browser(s), payload: { amount: "10.00" } });

  it("без billing.refund → 403 PERMISSION_DENIED {permission}", async () => {
    for (const role of ["support", "operations", "read_only", "auditor"] as const) {
      const { s } = await loginAs(h, role);
      const res = await refund(s);
      expect(res.statusCode, role).toBe(403);
      expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "billing.refund" } });
    }
  });

  it("с правом → 501 BILLING_NOT_AVAILABLE", async () => {
    for (const role of ["billing", "super_admin"] as const) {
      const { s } = await loginAs(h, role);
      const res = await refund(s);
      expect(res.statusCode, role).toBe(501);
      expect(res.json().code).toBe("BILLING_NOT_AVAILABLE");
    }
  });
});

describe("RBAC до вызова домена", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("нет права → 403, домен не вызывается (A31 на всех разделах)", async () => {
    const { s } = await loginAs(h, "read_only");
    const cases: Array<[string, string, unknown?]> = [
      ["GET", "/admin/v1/users"],
      ["GET", `/admin/v1/users/${USER_ID}`],
      ["POST", `/admin/v1/users/${USER_ID}/reveal`, { field: "telegram_user_id", reason: "проверка" }],
      ["GET", "/admin/v1/support/tickets"],
      ["GET", "/admin/v1/staff"],
      ["GET", "/admin/v1/roles"],
      ["GET", "/admin/v1/audit/records"],
      ["GET", "/admin/v1/experience/admin/state"],
      ["POST", "/admin/v1/experience/admin/rollback", { reason: "откат" }],
      ["POST", "/admin/v1/approvals/5b1f0d0e-1111-4c2b-9a51-0d6c7a1e2f30/approve", {}],
    ];
    const before = h.fake.calls.length;
    for (const [method, url, payload] of cases) {
      const res = await h.app.inject({ method: method as "GET", url, headers: browser(s), ...(payload ? { payload: payload as object } : {}) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe("PERMISSION_DENIED");
    }
    expect(h.fake.calls.length).toBe(before);
  });

  it("approve/reject — только роль super_admin (staff.manage недостаточно)", async () => {
    const { s } = await loginAs(h, "operations", { permissions: ["dashboard.read", "staff.manage", "roles.manage"] });
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/v1/approvals/5b1f0d0e-1111-4c2b-9a51-0d6c7a1e2f30/approve",
      headers: browser(s),
      payload: { note: "ok" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().details.permission).toBe("role:super_admin");
  });
});

describe("actor-токен в домены", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("{id, role, name, permissions} — эффективные права сессии, подпись admin-bff (verifyInternalToken)", async () => {
    const { staff, s } = await loginAs(h, "support", { display_name: "Мария Оператор" });
    let token = "";
    h.fake.on("userAdmin", "GET", "/admin/v1/users", (c) => {
      token = c.headers["x-internal-token"]!;
      return json(200, { items: [], next_cursor: null });
    });
    expect((await h.app.inject({ url: "/admin/v1/users?q=%40someone&limit=5", headers: browser(s) })).statusCode).toBe(200);
    const v = await verifyInternalToken(token, INTERNAL_SECRET, "user-admin", new Set(["admin-bff"]));
    expect(v.issuer).toBe("admin-bff");
    expect(v.subject).toBeUndefined();
    expect(v.actor).toEqual({
      id: staff.staff_id,
      role: "support",
      name: "Мария Оператор",
      permissions: ["dashboard.read", "support.read", "support.reply", "users.read"],
    });
    // токен для другого домена не принимается этим доменом
    await expect(verifyInternalToken(token, INTERNAL_SECRET, "support")).rejects.toMatchObject({ code: "INTERNAL_TOKEN_INVALID" });
    const call = h.fake.callsTo("userAdmin", "GET", "/admin/v1/users")[0]!;
    expect(call.query).toEqual({ q: "@someone", limit: "5" });
  });
});

describe("CSRF и Origin", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });
  const take = (headers: Record<string, string>) =>
    h.app.inject({ method: "POST", url: "/admin/v1/support/tickets/TCK-3001/take", headers });

  it("не-GET без X-CSRF-Token / с чужим токеном → 403 CSRF_INVALID, домен не вызывается", async () => {
    const { s } = await loginAs(h, "support");
    const other = await loginAs(h, "support");
    const { "x-csrf-token": _drop, ...noToken } = browser(s);
    for (const headers of [noToken, browser(s, { "x-csrf-token": "" }), browser(s, { "x-csrf-token": other.s.csrf }), browser(s, { "x-csrf-token": s.csrf + "x" })]) {
      const res = await take(headers);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("CSRF_INVALID");
    }
    expect(h.fake.callsTo("support")).toHaveLength(0);
    expect((await take(browser(s))).statusCode).toBe(200);
  });

  it("чужой Origin / Origin: null / без Origin и без Sec-Fetch-Site → 403; Sec-Fetch-Site: same-origin — ок", async () => {
    const { s } = await loginAs(h, "support");
    for (const origin of ["https://evil.example", "null", "https://admin.tilhero.test.evil.example", "http://admin.tilhero.test"]) {
      expect((await take(browser(s, { origin }))).json().code, origin).toBe("CSRF_INVALID");
    }
    const { origin: _o, ...noOrigin } = browser(s);
    expect((await take(noOrigin)).statusCode).toBe(403);
    expect((await take({ ...noOrigin, "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    expect((await take({ ...noOrigin, "sec-fetch-site": "same-origin" })).statusCode).toBe(200);
  });

  it("GET не требует CSRF-токена", async () => {
    const { s } = await loginAs(h, "support");
    const { "x-csrf-token": _drop, origin: _o, ...plain } = browser(s);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: plain })).statusCode).toBe(200);
  });

  it("вход до сессии: без Origin или с чужим Origin → 403, admin-identity не вызывается", async () => {
    const staff = h.fake.addStaff({ role: "support" });
    for (const headers of [{ "user-agent": UA }, { "user-agent": UA, origin: "https://evil.example" }]) {
      for (const url of ["/admin/v1/auth/login", "/admin/v1/auth/mfa", "/admin/v1/auth/mfa/enroll/start", "/admin/v1/auth/mfa/enroll/confirm", "/admin/v1/auth/password"]) {
        const res = await h.app.inject({ method: "POST", url, headers, payload: { email: staff.email, password: PASSWORD_OK } });
        expect(res.statusCode, url).toBe(403);
        expect(res.json().code).toBe("CSRF_INVALID");
      }
    }
    expect(h.fake.calls).toHaveLength(0);
  });
});

describe("rate limit входа", () => {
  beforeEach(async () => {
    h = await makeHarness();
    await avoidWindowEdge();
  });
  const attempt = (email: string, ip: string, extra: Record<string, string> = {}) =>
    h.app.inject({ method: "POST", url: "/admin/v1/auth/login", headers: browser(null, extra), remoteAddress: ip, payload: { email, password: "bad" } });

  it("10/мин с IP → 429 RATE_LIMITED + Retry-After; другой IP не затронут", async () => {
    for (let i = 0; i < 10; i++) expect((await attempt(`u${i}@x.test`, "198.51.100.7")).statusCode).toBe(401);
    const limited = await attempt("u99@x.test", "198.51.100.7");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "RATE_LIMITED", details: { retry_after: expect.any(Number) } });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect((await attempt("u99@x.test", "198.51.100.8")).statusCode).toBe(401);
  });

  it("5/мин на email (без учёта регистра) с разных IP", async () => {
    for (let i = 0; i < 5; i++) expect((await attempt(i % 2 ? "Victim@X.test" : "victim@x.test", `203.0.113.${i + 1}`)).statusCode).toBe(401);
    const r = await attempt("victim@x.test", "203.0.113.77");
    expect(r.statusCode).toBe(429);
    expect(h.fake.callsTo("adminIdentity", "POST", "/internal/v1/auth/login")).toHaveLength(5);
    const keys = await redis().keys(`${h.config.redisKeyPrefix}rl:login_email:*`);
    expect(keys.join()).not.toContain("victim");
  });

  it("IPv6 — лимит на /64 (перебор адресов в своей подсети не помогает)", async () => {
    for (let i = 0; i < 10; i++) expect((await attempt(`a${i}@x.test`, `2001:db8:1:2::${(i + 1).toString(16)}`)).statusCode).toBe(401);
    expect((await attempt("z@x.test", "2001:db8:1:2:ffff::1")).statusCode).toBe(429);
    expect((await attempt("z@x.test", "2001:db8:1:3::1")).statusCode).toBe(401);
  });

  it("2 доверенных прокси (edge → Caddy): X-Forwarded-For от клиента не обходит лимит", async () => {
    for (let i = 0; i < 11; i++) {
      const res = await attempt(`b${i}@x.test`, "10.0.0.5", { "x-forwarded-for": `203.0.113.${i}, 192.0.2.44, 10.0.0.9` });
      expect(res.statusCode).toBe(i < 10 ? 401 : 429);
    }
  });

  it("TRUST_PROXY_HOPS=2: XFF \"fake, real, edge\" от Caddy → req.ip = реальный клиент (в admin-identity и лимит)", async () => {
    // клиент подделал XFF «fake»; edge Railway дописал реальный адрес; Caddy (trusted_proxies 0.0.0.0/0) — адрес edge
    const xff = "203.0.113.66, 198.51.100.7, 100.64.0.9";
    const staff = h.fake.addStaff({ role: "support" });
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/v1/auth/login",
      headers: browser(null, { "x-forwarded-for": xff }),
      remoteAddress: "fd12::ca:1",
      payload: { email: staff.email, password: PASSWORD_OK },
    });
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("adminIdentity", "POST", "/internal/v1/auth/login")[0]!.body.ip).toBe("198.51.100.7");
    // смена подделанной части не меняет ключ лимита: 10/мин с реального адреса
    for (let i = 1; i < 11; i++) {
      const r = await attempt(`r${i}@x.test`, "fd12::ca:1", { "x-forwarded-for": `203.0.113.${i}, 198.51.100.7, 100.64.0.9` });
      expect(r.statusCode, String(i)).toBe(i < 10 ? 401 : 429);
    }
    // другой реальный клиент за тем же Caddy не затронут
    const other = await attempt("other@x.test", "fd12::ca:1", { "x-forwarded-for": "198.51.100.8, 100.64.0.9" });
    expect(other.statusCode).toBe(401);
  });

  it("коды по challenge: 5/мин на challenge", async () => {
    const staff = h.fake.addStaff({ role: "operations", mfa_enabled: true });
    const r = await h.app.inject({ method: "POST", url: "/admin/v1/auth/login", headers: browser(), payload: { email: staff.email, password: PASSWORD_OK } });
    const challenge = (r.json() as LoginStep).challenge!;
    for (let i = 0; i < 5; i++) {
      const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/mfa", headers: browser(), payload: { challenge, code: "000000" } });
      expect(res.statusCode).toBe(401);
    }
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/auth/mfa", headers: browser(), payload: { challenge, code: TOTP_OK } });
    expect(res.statusCode).toBe(429);
  });

  it("300/мин на сотрудника для прочих маршрутов", async () => {
    await h.close();
    h = await makeHarness({ RATE_LIMIT_STAFF_PER_MIN: "5" });
    const { s } = await loginAs(h, "support");
    const other = await loginAs(h, "support");
    for (let i = 0; i < 5; i++) expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(429);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(other.s) })).statusCode).toBe(200);
  });
});

describe("имперсонация", () => {
  it("ENV=dev: сужает права до роли (не расширяет), actor-токен с ролью и пересечением прав, аудит", async () => {
    h = await makeHarness({ ENV: "dev", NODE_ENV: "development" });
    const { staff, s } = await loginAs(h, "super_admin");
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(s), payload: { role: "support" } });
    expect(res.statusCode).toBe(200);
    const me = res.json() as Me;
    expect(me.impersonating).toBe("support");
    expect(me.staff.role).toBe("super_admin");
    expect(me.permissions).toEqual(["dashboard.read", "support.read", "support.reply", "users.read"]);
    const audit = h.fake.callsTo("audit", "POST", "/internal/v1/records")[0]!;
    expect(audit.body).toMatchObject({ action: "dev.impersonate", after: { impersonating: "support" } });

    // права сужены на backend
    expect((await h.app.inject({ url: "/admin/v1/staff", headers: browser(s) })).statusCode).toBe(403);
    await h.app.inject({ url: "/admin/v1/users", headers: browser(s) });
    const actor = h.fake.callsTo("userAdmin", "GET", "/admin/v1/users").at(-1)!.actor!;
    // actor-токен — с НАСТОЯЩЕЙ ролью и суженными правами
    expect(actor).toEqual({ id: staff.staff_id, role: "super_admin", name: staff.display_name, permissions: ["dashboard.read", "support.read", "support.reply", "users.read"] });

    // проверка по роли при имперсонации тоже сужается: super_admin, примеривший support, не утверждает заявки
    await stepUp(h, s);
    const approve = await h.app.inject({ method: "POST", url: `/admin/v1/approvals/${USER_ID}/approve`, headers: browser(s), payload: {} });
    expect(approve.statusCode).toBe(403);
    expect(approve.json().details.permission).toBe("role:super_admin");

    // сотрудник support не может «примерить» super_admin (права шире своих) — 403, аудита и режима нет
    const sup = await loginAs(h, "support");
    const auditBefore = h.fake.callsTo("audit", "POST", "/internal/v1/records").length;
    const up = await h.app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(sup.s), payload: { role: "super_admin" } });
    expect(up.statusCode).toBe(403);
    expect(up.json()).toMatchObject({ code: "IMPERSONATION_NOT_ALLOWED", details: { role: "super_admin" } });
    expect(h.fake.callsTo("audit", "POST", "/internal/v1/records")).toHaveLength(auditBefore);
    expect(((await h.app.inject({ url: "/admin/v1/me", headers: browser(sup.s) })).json() as Me).impersonating).toBeNull();

    // сброс
    const back = (await h.app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(s), payload: { role: null } })).json() as Me;
    expect(back.impersonating).toBeNull();
    expect(back.permissions).toContain("staff.manage");
  });

  it("подложенная в сессию роль шире своих игнорируется: approve у support не проходит, actor — настоящая роль", async () => {
    h = await makeHarness({ ENV: "dev", NODE_ENV: "development" });
    const { staff, s } = await loginAs(h, "support");
    // как если бы режим был включён до понижения роли (или запись в Redis подменена)
    await redis().hset(`${h.config.redisKeyPrefix}sess:${sha256hex(s.id)}`, "impersonating", "super_admin");
    expect((await stepUp(h, s)).statusCode).toBe(200);
    const res = await h.app.inject({ method: "POST", url: `/admin/v1/approvals/${USER_ID}/approve`, headers: browser(s), payload: {} });
    expect(res.statusCode).toBe(403);
    expect(h.fake.callsTo("adminIdentity", "POST", "/admin/v1/approvals/")).toHaveLength(0);
    const me = (await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).json() as Me;
    expect(me.impersonating).toBeNull();
    expect(me.permissions).toEqual(["dashboard.read", "support.read", "support.reply", "users.read"]);
    await h.app.inject({ url: "/admin/v1/users", headers: browser(s) });
    expect(h.fake.callsTo("userAdmin", "GET", "/admin/v1/users").at(-1)!.actor).toMatchObject({ id: staff.staff_id, role: "support" });
  });

  it("вне ENV=dev запись impersonating в сессии не действует", async () => {
    h = await makeHarness();
    const { s } = await loginAs(h, "super_admin");
    await redis().hset(`${h.config.redisKeyPrefix}sess:${sha256hex(s.id)}`, "impersonating", "read_only");
    const me = (await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).json() as Me;
    expect(me.impersonating).toBeNull();
    expect(me.permissions).toContain("staff.manage");
    expect((await h.app.inject({ url: "/admin/v1/staff", headers: browser(s) })).statusCode).toBe(200);
  });

  it("аудит недоступен → режим не включается (503)", async () => {
    h = await makeHarness({ ENV: "dev", NODE_ENV: "development" });
    const { s } = await loginAs(h, "super_admin");
    h.fake.down.add("audit");
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(s), payload: { role: "support" } });
    expect(res.statusCode).toBe(503);
    expect(((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).json() as Me).impersonating).toBeNull();
  });

  it.each(["test", "stage", "prod"])("ENV=%s → 404, маршрута нет", async (env) => {
    const extra: Record<string, string> =
      env === "test" ? {} : { ENV: env, INTERNAL_JWT_PRIVATE_KEY: "A".repeat(43), INTERNAL_JWT_PUBLIC_KEYS: "{}", ADMIN_WEB_ORIGIN: ORIGIN };
    if (env !== "test") {
      // в stage/prod нужен личный ключ; проверяем только регистрацию маршрутов
      const cfg = testConfig(extra);
      expect(cfg.devTools).toBe(false);
      const app = await buildApp(cfg, { redis: redis(), fetchImpl: async () => json(200, {}), logStream: { write() {} } });
      await app.ready();
      expect(app.adminRoutes.some((r) => r.url.startsWith("/admin/v1/dev/"))).toBe(false);
      const res = await app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(), payload: { role: "support" } });
      expect(res.statusCode).toBe(404);
      await app.close();
      return;
    }
    h = await makeHarness(extra);
    const { s } = await loginAs(h, "super_admin");
    const res = await h.app.inject({ method: "POST", url: "/admin/v1/dev/impersonate", headers: browser(s), payload: { role: "support" } });
    expect(res.statusCode).toBe(404);
    expect(((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).json() as Me).impersonating).toBeNull();
  });
});

describe("логи без секретов и PII", () => {
  it("cookie, X-CSRF-Token, пароли, коды, challenge, секрет MFA, временный пароль, email — не попадают в лог", async () => {
    h = await makeHarness();
    const staff = h.fake.addStaff({ role: "super_admin", email: "secret.person@tilhero.test", must_change_password: true, mfa_required: true });
    const r1 = await h.app.inject({ method: "POST", url: "/admin/v1/auth/login", headers: browser(), payload: { email: staff.email, password: PASSWORD_OK } });
    const c1 = (r1.json() as LoginStep).challenge!;
    const r2 = await h.app.inject({ method: "POST", url: "/admin/v1/auth/password", headers: browser(), payload: { challenge: c1, new_password: "Brand-New-Secret-77" } });
    const c2 = (r2.json() as LoginStep).challenge!;
    const r3 = await h.app.inject({ method: "POST", url: "/admin/v1/auth/mfa/enroll/start", headers: browser(), payload: { challenge: c2 } });
    const secret = r3.json().secret as string;
    const r4 = await h.app.inject({ method: "POST", url: "/admin/v1/auth/mfa/enroll/confirm", headers: browser(), payload: { challenge: c2, code: TOTP_OK } });
    const me = (r4.json() as LoginStep).me!;
    const id = String(r4.headers["set-cookie"]).split(";")[0]!.split("=")[1]!;
    const s = { id, csrf: me.csrf_token };
    const su = await h.app.inject({ method: "POST", url: "/admin/v1/auth/step-up", headers: browser(s), payload: { code: TOTP_OK } });
    const id2 = String(su.headers["set-cookie"]).split(";")[0]!.split("=")[1]!; // step-up ротирует id
    s.id = id2;
    const created = await h.app.inject({
      method: "POST",
      url: "/admin/v1/staff",
      headers: browser(s),
      payload: { email: "new.hire@tilhero.test", display_name: "Новый Сотрудник", role: "support" },
    });
    const tmp = created.json().temporary_password as string;
    await h.app.inject({ method: "POST", url: `/admin/v1/users/${USER_ID}/reveal`, headers: browser(s), payload: { field: "telegram_user_id", reason: "проверка мошенничества" } });
    await h.app.inject({ url: "/admin/v1/users?q=secret.person", headers: browser(s) });
    // ошибка домена и сбой — тоже без секретов
    h.fake.down.add("support");
    await h.app.inject({ method: "POST", url: "/admin/v1/support/tickets/TCK-1/take", headers: browser(s) });

    const text = h.logs.text;
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("request completed");
    for (const leak of [id, id2, me.csrf_token, PASSWORD_OK, "Brand-New-Secret-77", c1, c2, secret, TOTP_OK, tmp, "777000123456789", "secret.person", "new.hire", "проверка мошенничества"]) {
      expect(text, `leak: ${leak.slice(0, 6)}…`).not.toContain(leak);
    }
  });
});
