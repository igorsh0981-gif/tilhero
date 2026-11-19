/**
 * Спринт 9 (INTERNAL_API §2): единый лимитер в telegram-bff — политики tg.*, значения по умолчанию = прежние env,
 * 429 RATE_LIMITED {policy, retry_after} + Retry-After, новая tg.support_create, переопределение без деплоя,
 * сбой Redis (tg.session_ip — closed, tg.public_ip — open), IP в ключах только хешем.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { RATE_LIMIT_POLICIES } from "@tilhero/ts-common";
import { buildApp } from "../src/app.js";
import { telegramPolicies } from "../src/rateLimit.js";
import { FakeDomains, LogCapture, bearer, closeRedis, login, makeHarness, testConfig, testRedis, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
afterAll(closeRedis);

const allKeys = async (prefix: string) => (await testRedis().keys(`${prefix}*`)).map((k) => k.slice(prefix.length));

describe("спринт 9: лимиты telegram-bff", () => {
  it("значения по умолчанию политик = прежние значения config.ts / env; env по-прежнему задаёт значение", () => {
    const cfg = testConfig();
    const pol = telegramPolicies(cfg);
    for (const p of RATE_LIMIT_POLICIES.filter((x) => x.service === "telegram-bff")) {
      expect(pol[p.policy], p.policy).toMatchObject({ limit: p.limit, window_s: p.window_s, fail: p.fail });
    }
    expect(Object.keys(pol).sort()).toEqual(RATE_LIMIT_POLICIES.filter((x) => x.service === "telegram-bff").map((x) => x.policy).sort());
    // release 4.1: POST /v1/speech
    expect(pol["tg.speech"]).toMatchObject({ limit: 120, window_s: 600, subject: "user", fail: "open" });
    expect(telegramPolicies(testConfig({ RATE_LIMIT_USER_PER_MIN: "3", RATE_LIMIT_PIN_PER_MIN: "2" }))).toMatchObject({
      "tg.user": { limit: 3 },
      "tg.pin": { limit: 2 },
    });
    expect(cfg.rateLimiting).toEqual({ enabled: true, overrideRefreshSeconds: 30, keyPrefix: cfg.redisKeyPrefix });
    expect(testConfig({ RATE_LIMITS_ENABLED: "false" }).rateLimiting.enabled).toBe(false);
    expect(() => testConfig({ RATE_LIMITS_ENABLED: "maybe" })).toThrow(/RATE_LIMITS_ENABLED/);
  });

  it("tg.user: 429 RATE_LIMITED {policy, retry_after} + Retry-After", async () => {
    h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "3" });
    const a = await login(h);
    for (let i = 0; i < 3; i++) expect((await h.app.inject({ url: "/v1/profile", headers: bearer(a.access) })).statusCode).toBe(200);
    const r = await h.app.inject({ url: "/v1/profile", headers: bearer(a.access) });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ code: "RATE_LIMITED", message: "Слишком много запросов, повторите позже", details: { policy: "tg.user" } });
    expect(Number(r.headers["retry-after"])).toBe(r.json().details.retry_after);
    expect(r.json().details.retry_after).toBeGreaterThanOrEqual(1);
  });

  it("tg.support_create (новая): 10 обращений в час, 11-е → 429, обращение не создаётся", async () => {
    h = await makeHarness();
    const a = await login(h);
    const body = { category: "BUG", subject: "Тема обращения", message: "Текст обращения" };
    const send = () =>
      h!.app.inject({ method: "POST", url: "/v1/support/tickets", payload: body, headers: { ...bearer(a.access), "idempotency-key": randomUUID() } });
    for (let i = 0; i < 10; i++) expect((await send()).statusCode, String(i)).toBe(201);
    const r = await send();
    expect(r.statusCode).toBe(429);
    expect(r.json().details).toMatchObject({ policy: "tg.support_create" });
    expect(r.json().details.retry_after).toBeGreaterThan(300); // интервал 6 мин
    expect(h.fake.callsTo("support", "POST")).toHaveLength(10);
  });

  it("ревью спринта 9: повтор того же Idempotency-Key лимит tg.support_create не тратит (после ответа support)", async () => {
    h = await makeHarness();
    const a = await login(h);
    const body = { category: "BUG", subject: "Тема обращения", message: "Текст обращения" };
    const send = (key: string) =>
      h!.app.inject({ method: "POST", url: "/v1/support/tickets", payload: body, headers: { ...bearer(a.access), "idempotency-key": key } });
    const same = randomUUID();
    for (let i = 0; i < 15; i++) expect((await send(same)).statusCode, `repeat ${i}`).toBe(201);
    for (let i = 0; i < 9; i++) expect((await send(randomUUID())).statusCode, `new ${i}`).toBe(201); // 1 + 9 = 10
    const r = await send(randomUUID());
    expect([r.statusCode, r.json().details?.policy]).toEqual([429, "tg.support_create"]);
    expect((await send(same)).statusCode).toBe(201); // повтор уже созданного — по-прежнему проходит
  });

  it("переопределение из Redis (rl:override:tg.user) действует ≤ периода перечитывания без деплоя", async () => {
    h = await makeHarness({ RATE_LIMIT_OVERRIDE_REFRESH_SECONDS: "1" });
    const a = await login(h);
    const prefix = h.config.rateLimiting.keyPrefix;
    await testRedis().set(
      `${prefix}rl:override:tg.user`,
      JSON.stringify({ v: 1, limit: 2, window_s: 60, burst: null, by: "staff-1", at: new Date().toISOString(), reason: "учения", expires_at: null }),
    );
    await new Promise((r) => setTimeout(r, 1100));
    await h.app.inject({ url: "/v1/profile", headers: bearer(a.access) }); // запускает перечитывание
    await new Promise((r) => setTimeout(r, 300));
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await h.app.inject({ url: "/v1/profile", headers: bearer(a.access) })).statusCode);
    expect(codes).toContain(429);
    const pub = JSON.parse((await testRedis().get(`${prefix}rl:policy:tg.user`))!);
    expect(pub).toMatchObject({ limit: 2, source: "override", service: "telegram-bff", subject: "user", fail: "open" });
  });

  it("IP в ключах лимита — только хеш; IPv6 считается по /64", async () => {
    h = await makeHarness();
    const hit = (ip: string) => h!.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: "bad" }, remoteAddress: ip });
    for (let i = 1; i <= 10; i++) expect((await hit(`2001:db8:aa:bb::${i.toString(16)}`)).statusCode).toBe(401);
    expect((await hit("2001:db8:aa:bb:ffff:ffff:ffff:ffff")).statusCode).toBe(429);
    await hit("198.51.100.77");
    const keys = (await allKeys(h.config.rateLimiting.keyPrefix)).filter((k) => k.startsWith("rl"));
    expect(keys.some((k) => k.startsWith("rl:tg.session_ip:"))).toBe(true);
    for (const k of keys) {
      expect(k).not.toContain("198.51.100");
      expect(k).not.toContain("2001:db8");
    }
  });

  it("Redis недоступен: вход (tg.session_ip, closed) → 503 RATE_LIMIT_UNAVAILABLE, публичные чтения (tg.public_ip, open) работают", async () => {
    const config = testConfig();
    const fake = new FakeDomains();
    const logs = new LogCapture();
    const dead = new Redis("redis://127.0.0.1:1/0", { maxRetriesPerRequest: 0, lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
    dead.on("error", () => undefined);
    const app = await buildApp(config, { redis: dead, fetchImpl: fake.fetch, logStream: logs });
    await app.ready();
    try {
      const login = await app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: "bad" }, remoteAddress: "198.51.100.8" });
      expect(login.statusCode).toBe(503);
      expect(login.json()).toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE", details: { policy: "tg.session_ip" } });
      const cfg = await app.inject({ url: "/v1/experience/config", remoteAddress: "198.51.100.8" });
      expect(cfg.statusCode).toBe(200);
      expect(logs.text).toContain("rate limit store unavailable");
      expect(logs.text).not.toContain("198.51.100.8");
    } finally {
      await app.close();
      dead.disconnect();
    }
  });
});
