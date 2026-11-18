/**
 * Спринт 9 (INTERNAL_API §2): единый лимитер в admin-bff — политики adm.*, значения по умолчанию = прежние env,
 * новые adm.command (60/мин, команды) и adm.dlq (10/мин, команды DLQ и повтор удаления), 429 {policy, retry_after},
 * сбой Redis: вход (closed) → 503 RATE_LIMIT_UNAVAILABLE; e-mail и IP в ключах — только хешем.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { RATE_LIMIT_POLICIES } from "@tilhero/ts-common";
import { buildApp } from "../src/app.js";
import { adminPolicies, commandPolicies } from "../src/rateLimit.js";
import { FakeDomains, LogCapture, browser, closeRedis, loginAs, makeHarness, redis, testConfig, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
afterAll(closeRedis);

describe("спринт 9: лимиты admin-bff", () => {
  it("значения по умолчанию = прежние config.ts / env; политики сервиса — из каталога", () => {
    const pol = adminPolicies(testConfig());
    const own = RATE_LIMIT_POLICIES.filter((p) => p.service === "admin-bff");
    expect(Object.keys(pol).sort()).toEqual(own.map((p) => p.policy).sort());
    for (const p of own) expect(pol[p.policy], p.policy).toMatchObject({ limit: p.limit, window_s: p.window_s, fail: p.fail });
    expect(adminPolicies(testConfig({ RATE_LIMIT_STAFF_PER_MIN: "50", RATE_LIMIT_MFA_PER_MIN: "3" }))).toMatchObject({
      "adm.staff": { limit: 50 },
      "adm.mfa": { limit: 3 },
      "adm.command": { limit: 60, fail: "closed" },
      "adm.dlq": { limit: 10, fail: "closed" },
    });
  });

  it("политики команды по маршруту: GET — нет; POST/PUT/PATCH/DELETE — adm.command; DLQ и повтор удаления — ещё adm.dlq", () => {
    expect(commandPolicies("GET", "/admin/v1/ops/dlq")).toEqual([]);
    expect(commandPolicies("POST", "/admin/v1/alerts/:source/:id/ack")).toEqual(["adm.command"]);
    expect(commandPolicies("DELETE", "/admin/v1/staff/:id")).toEqual(["adm.command"]);
    expect(commandPolicies("POST", "/admin/v1/ops/dlq/replay")).toEqual(["adm.command", "adm.dlq"]);
    expect(commandPolicies("POST", "/admin/v1/ops/dlq/delete")).toEqual(["adm.command", "adm.dlq"]);
    expect(commandPolicies("POST", "/admin/v1/deletions/:request_id::retry")).toEqual(["adm.command", "adm.dlq"]);
  });

  it("adm.command: 60 команд в минуту на сотрудника, 61-я → 429 {policy: adm.command}; чтения не затронуты", async () => {
    h = await makeHarness();
    const { s } = await loginAs(h, "read_only");
    const ack = () => h!.app.inject({ method: "POST", url: "/admin/v1/alerts/ops/00000000-0000-4000-8000-000000000001/ack", headers: browser(s), payload: { comment: "x" } });
    for (let i = 0; i < 60; i++) expect((await ack()).statusCode, String(i)).toBe(403); // нет права — но команда учтена
    const r = await ack();
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ code: "RATE_LIMITED", details: { policy: "adm.command" } });
    expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect((await h.app.inject({ url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
  });

  it("adm.dlq: 10 команд DLQ в минуту, 11-я → 429 {policy: adm.dlq}; прочие команды идут", async () => {
    h = await makeHarness();
    const { s } = await loginAs(h, "operations");
    const replay = () =>
      h!.app.inject({ method: "POST", url: "/admin/v1/ops/dlq/replay", headers: browser(s), payload: { ids: ["dlq:1"], reason: "тест" } });
    for (let i = 0; i < 10; i++) expect((await replay()).statusCode, String(i)).not.toBe(429);
    const r = await replay();
    expect(r.statusCode).toBe(429);
    expect(r.json().details).toMatchObject({ policy: "adm.dlq" });
    const other = await h.app.inject({ method: "POST", url: "/admin/v1/alerts/ops/00000000-0000-4000-8000-000000000001/ack", headers: browser(s), payload: { comment: "x" } });
    expect(other.statusCode).not.toBe(429);
  });

  it("вход: e-mail и IP в ключах лимита — только хеш; 6-я попытка на e-mail → 429 adm.login_email", async () => {
    h = await makeHarness();
    const attempt = (ip: string) =>
      h!.app.inject({ method: "POST", url: "/admin/v1/auth/login", headers: browser(null), payload: { email: "Boss@Example.com", password: "wrong-password" }, remoteAddress: ip });
    for (let i = 0; i < 5; i++) expect((await attempt(`198.51.100.${20 + i}`)).statusCode).not.toBe(429);
    const r = await attempt("198.51.100.99");
    expect(r.statusCode).toBe(429);
    expect(r.json().details).toMatchObject({ policy: "adm.login_email" });
    const keys = (await redis().keys(`${h.config.rateLimiting.keyPrefix}rl*`)).join(" ");
    expect(keys).toContain("rl:adm.login_email:");
    expect(keys.toLowerCase()).not.toContain("example.com");
    expect(keys).not.toContain("198.51.100");
  });

  it("Redis недоступен: вход сотрудника (closed) → 503 RATE_LIMIT_UNAVAILABLE", async () => {
    const config = testConfig();
    const fake = new FakeDomains();
    const logs = new LogCapture();
    const dead = new Redis("redis://127.0.0.1:1/0", { maxRetriesPerRequest: 0, lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
    dead.on("error", () => undefined);
    const app = await buildApp(config, { redis: dead, fetchImpl: fake.fetch, logStream: logs });
    await app.ready();
    try {
      const r = await app.inject({ method: "POST", url: "/admin/v1/auth/login", headers: browser(null), payload: { email: "a@b.test", password: "x" }, remoteAddress: "198.51.100.5" });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE", details: { policy: "adm.login_ip" } });
      expect(fake.callsTo("adminIdentity", "POST", "/internal/v1/auth/login")).toHaveLength(0);
      expect(logs.text).toContain("rate limit store unavailable");
    } finally {
      await app.close();
      dead.disconnect();
    }
  });
});
