/**
 * Исправление 6.1: лимиты AI из админки (provider-gateway ai_web/limits) — права, step-up, валидация, аудит,
 * нормализация ответа, имя сотрудника, AiBudget.limits.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { cents, checkLimits, normalizeLimits } from "../src/routes/limits.js";
import { browser, budgetRow, closeRedis, domainError, fakeLimits, fakeSprint4, json, limitsRow, loginAs, makeHarness, stepUp, type Harness, type Session } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  fakeSprint4(h.fake);
  fakeLimits(h.fake);
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const URL_ = "/admin/v1/discovery/limits";
const GW = "/internal/v1/providers/ai_web/limits";
const BODY = { ai_daily_usd: "2.5", news_daily_usd: "0.40", pages_daily: 500, reason: "Сезон фестивалей" };
type M = "GET" | "PUT" | "DELETE";
const call = (method: M, s: Session | null, payload?: unknown) =>
  h.app.inject({ method, url: URL_, headers: browser(s), ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("доступ", () => {
  it("GET: discovery.manage или ops.kill_switch; без них — 403; без сессии — 401", async () => {
    expect((await call("GET", null)).statusCode).toBe(401);
    const disc = await loginAs(h, "analyst", { permissions: ["dashboard.read", "discovery.manage"] });
    expect((await call("GET", disc.s)).statusCode).toBe(200);
    const kill = await loginAs(h, "analyst", { permissions: ["dashboard.read", "ops.kill_switch"] });
    expect((await call("GET", kill.s)).statusCode).toBe(200);
    const none = await loginAs(h, "analyst");
    const res = await call("GET", none.s);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "discovery.manage|ops.kill_switch" } });
  });

  it("PUT/DELETE: ops.kill_switch + step-up; discovery.manage без kill switch — 403; без step-up — STEP_UP_REQUIRED, домен не вызывается", async () => {
    const disc = await loginAs(h, "analyst", { permissions: ["dashboard.read", "discovery.manage"] });
    expect((await call("PUT", disc.s, BODY)).json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "ops.kill_switch" } });
    const { s } = await loginAs(h, "operations");
    for (const [m, b] of [["PUT", BODY], ["DELETE", {}]] as const) {
      const res = await call(m, s, b);
      expect(res.statusCode, m).toBe(403);
      expect(res.json().code, m).toBe("STEP_UP_REQUIRED");
    }
    expect(h.fake.callsTo("providerGateway", "PUT", GW)).toHaveLength(0);
    expect(h.fake.callsTo("providerGateway", "DELETE", GW)).toHaveLength(0);
  });
});

describe("изменение", () => {
  it("PUT: тело в provider-gateway с actor, без повторов; ответ — с именем сотрудника", async () => {
    const { staff, s } = await loginAs(h, "operations");
    await stepUp(h, s);
    const res = await call("PUT", s, { ...BODY, reason: "  Сезон фестивалей  " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ai_daily_usd: "2.50", news_daily_usd: "0.40", pages_daily: 500, source: "admin", updated_by: staff.staff_id, updated_by_name: staff.display_name, reason: "Сезон фестивалей" });
    const c = h.fake.callsTo("providerGateway", "PUT", GW)[0]!;
    expect(c.body).toEqual({ ...BODY, reason: "Сезон фестивалей" });
    expect(c.actor?.id).toBe(staff.staff_id);
  });

  it("PUT 422: формат денег, границы ai 0–50, news ≤ ai, страницы — целое 0–5000, лишнее поле, без причины", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ ai_daily_usd: 2.5 }, "ai_daily_usd"],
      [{ ai_daily_usd: "1e1" }, "ai_daily_usd"],
      [{ ai_daily_usd: "1,5" }, "ai_daily_usd"],
      [{ ai_daily_usd: "2.555" }, "ai_daily_usd"],
      [{ ai_daily_usd: "50.01" }, "ai_daily_usd"],
      [{ ai_daily_usd: "-1" }, "ai_daily_usd"],
      [{ news_daily_usd: "2.51" }, "news_daily_usd"],
      [{ pages_daily: 5001 }, "pages_daily"],
      [{ pages_daily: "500" }, "pages_daily"],
      [{ pages_daily: 1.5 }, "pages_daily"],
      [{ pages_daily: true }, "pages_daily"],
      [{ reason: "ab" }, "reason"],
      [{ reason: "   " }, "reason"],
      [{ extra: 1 }, "extra"],
    ];
    for (const [patch, field] of bad) {
      const res = await call("PUT", s, { ...BODY, ...patch });
      expect(res.statusCode, JSON.stringify(patch)).toBe(422);
      expect(res.json().details.field, JSON.stringify(patch)).toBe(field);
    }
    const { reason: _r, ...noReason } = BODY;
    expect((await call("PUT", s, noReason)).json().details.field).toBe("reason");
    // границы включительно: 50 и news = ai, 0 страниц
    expect((await call("PUT", s, { ...BODY, ai_daily_usd: "50", news_daily_usd: "50.00", pages_daily: 0 })).statusCode).toBe(200);
    expect(h.fake.callsTo("providerGateway", "PUT", GW)).toHaveLength(1);
  });

  it("DELETE «по умолчанию»: причина — в query (необязательна); ответ source env", async () => {
    const { s } = await loginAs(h, "operations");
    await stepUp(h, s);
    const res = await call("DELETE", s, { reason: "Сезон закончился" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: "env", updated_by_name: null });
    expect(h.fake.callsTo("providerGateway", "DELETE", GW)[0]!.query).toEqual({ reason: "Сезон закончился" });
    expect((await call("DELETE", s)).statusCode).toBe(200);
    expect(h.fake.callsTo("providerGateway", "DELETE", GW)[1]!.query).toEqual({});
    expect((await call("DELETE", s, { reason: "ab" })).statusCode).toBe(422);
  });

  it("аудит недоступен → 503 AUDIT_UNAVAILABLE (лимиты не изменены); 422 домена — как есть; без повторов", async () => {
    const h2 = await makeHarness({ UPSTREAM_RETRIES: "2" });
    try {
      fakeLimits(h2.fake);
      h2.fake.on("providerGateway", "PUT", GW, () => domainError(503, "AUDIT_UNAVAILABLE", { service: "audit" }));
      const { s } = await loginAs(h2, "operations");
      await stepUp(h2, s);
      const res = await h2.app.inject({ method: "PUT", url: URL_, headers: browser(s), payload: BODY });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "AUDIT_UNAVAILABLE", message: expect.stringContaining("лимиты AI не изменены") });
      expect(h2.fake.callsTo("providerGateway", "PUT", GW)).toHaveLength(1);
      h2.fake.on("providerGateway", "PUT", GW, () => domainError(422, "VALIDATION_ERROR", { field: "news_daily_usd" }));
      const v = await h2.app.inject({ method: "PUT", url: URL_, headers: browser(s), payload: BODY });
      expect(v.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { field: "news_daily_usd" } });
    } finally {
      await h2.close();
    }
  });

  it("испорченный ответ provider-gateway → 503 UPSTREAM_UNAVAILABLE; лишние поля не проходят", async () => {
    const { s } = await loginAs(h, "operations");
    h.fake.on("providerGateway", "GET", GW, () => json(200, limitsRow({ ai_daily_usd: 2.5 })));
    expect((await call("GET", s)).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "provider-gateway" } });
    h.fake.on("providerGateway", "GET", GW, () => json(200, { ...limitsRow(), secret: "s3cr3t", reason: "a\u0000b" }));
    const ok = await call("GET", s);
    expect(ok.body).not.toContain("s3cr3t");
    expect(ok.json().reason).toBe("a b");
  });
});

describe("AiBudget.limits", () => {
  it("бюджет несёт limits с именем; испорченные → null; старый gateway без поля — поля нет", async () => {
    const { staff, s } = await loginAs(h, "operations");
    const lim = limitsRow({ source: "admin", ai_daily_usd: "2.50", updated_by: staff.staff_id, updated_at: "2026-10-12T08:00:00Z", reason: "Сезон" });
    h.fake.on("providerGateway", "GET", "/internal/v1/providers/ai_web/budget", () => json(200, { ...budgetRow({ budget_usd: "2.50" }), limits: lim }));
    const res = await h.app.inject({ method: "GET", url: "/admin/v1/discovery/budget", headers: browser(s) });
    expect(res.json().limits).toMatchObject({ source: "admin", ai_daily_usd: "2.50", updated_by_name: staff.display_name });
    h.fake.on("providerGateway", "GET", "/internal/v1/providers/ai_web/budget", () => json(200, { ...budgetRow(), limits: { broken: true } }));
    expect((await h.app.inject({ method: "GET", url: "/admin/v1/discovery/budget", headers: browser(s) })).json().limits).toBeNull();
    h.fake.on("providerGateway", "GET", "/internal/v1/providers/ai_web/budget", () => json(200, budgetRow()));
    expect("limits" in (await h.app.inject({ method: "GET", url: "/admin/v1/discovery/budget", headers: browser(s) })).json()).toBe(false);
  });

  it("чистые функции: cents, checkLimits, normalizeLimits", () => {
    expect([cents("2"), cents("2.5"), cents("2.50"), cents("0.05")]).toEqual([200, 250, 250, 5]);
    expect(() => checkLimits({ ai_daily_usd: "0", news_daily_usd: "0", pages_daily: 0 })).not.toThrow();
    expect(() => checkLimits({ ai_daily_usd: "1", news_daily_usd: "1.01", pages_daily: 0 })).toThrow();
    expect(normalizeLimits(limitsRow({ source: "railway" }))).toBeNull();
    expect(normalizeLimits(limitsRow({ defaults: null }))).toBeNull();
    expect(normalizeLimits(limitsRow({ pages_daily: -1 }))).toBeNull();
    expect(normalizeLimits(limitsRow({ updated_at: "вчера" }))?.updated_at).toBeNull();
  });
});
