/**
 * Единый лимитер (спринт 9, INTERNAL_API §2.1–2.3) на реальном Redis стенда (DB 14): общий тест-вектор и каталог с
 * py-common, две реплики, переопределения, метрики, сбой Redis по режиму политики, псевдонимы IP / e-mail.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildBase,
  epochMinute,
  GCRA_LUA,
  ipRateKey,
  parseOverride,
  policyDefaults,
  RATE_LIMIT_POLICIES,
  RateLimiter,
  type PolicySpec,
} from "../src/index.js";
import { RespClient } from "./resp.js";

const CONTRACTS = resolve(import.meta.dirname, "../../contracts");
const REDIS_URL = process.env.TEST_REDIS_URL_TS ?? "redis://127.0.0.1:6379/14";
const redis = new RespClient(REDIS_URL);
let prefix = "";

const spec = (name: string, limit: number, window_s: number, fail: "open" | "closed" = "open"): PolicySpec => ({
  policy: `t.${name}`,
  service: "svc-test",
  subject: "user",
  limit,
  window_s,
  burst: null,
  fail,
  env: null,
  description: "",
});
const make = (policies: PolicySpec[], extra: Partial<ConstructorParameters<typeof RateLimiter>[0]> = {}) =>
  new RateLimiter({ redis, service: "svc-test", policies: Object.fromEntries(policies.map((p) => [p.policy, p])), keyPrefix: prefix, ...extra });
const keys = async () => (await redis.call("KEYS", `${prefix}*`)) as string[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  prefix = `rltest:${randomUUID().slice(0, 8)}:`;
});
afterEach(async () => {
  const k = await keys();
  if (k.length) await redis.call("DEL", ...k);
});
afterAll(async () => {
  await redis.quit();
});

describe("контракт с py-common: скрипт, каталог, тест-вектор", () => {
  it("копия Lua совпадает с эталоном", () => {
    expect(GCRA_LUA).toBe(readFileSync(resolve(CONTRACTS, "rate-limit-gcra.lua"), "utf8"));
  });

  it("каталог политик совпадает с rate-limit-policies.json", () => {
    const doc = JSON.parse(readFileSync(resolve(CONTRACTS, "rate-limit-policies.json"), "utf8")) as { version: number; policies: PolicySpec[] };
    expect(doc.version).toBe(1);
    expect(RATE_LIMIT_POLICIES).toEqual(doc.policies);
  });

  it("тест-вектор GCRA", async () => {
    const doc = JSON.parse(readFileSync(resolve(CONTRACTS, "rate-limit-vectors.json"), "utf8")) as {
      t0_ms: number;
      cases: { name: string; limit: number; window_s: number; burst: number | null; emission_us: number; steps: { at_ms: number; expect: { allowed: boolean; retry_after_ms: number; remaining: number } }[] }[];
    };
    const sha = (await redis.call("SCRIPT", "LOAD", GCRA_LUA)) as string;
    for (const c of doc.cases) {
      const emission = Math.floor((c.window_s * 1_000_000) / c.limit);
      expect(emission).toBe(c.emission_us);
      const key = `${prefix}rl:vec:${randomUUID().slice(0, 6)}`;
      for (const s of c.steps) {
        const r = (await redis.call("EVALSHA", sha, 3, key, `${prefix}rlm:vec:1`, `${prefix}rlt:vec:1`, emission, c.burst ?? c.limit, (doc.t0_ms + s.at_ms) * 1000, "s", 60, 50)) as number[];
        expect({ allowed: r[0] === 1, retry_after_ms: r[1], remaining: r[2] }, `${c.name} @${s.at_ms}`).toEqual(s.expect);
      }
    }
  });
});

describe("лимитер", () => {
  it("две реплики делят лимит; 429 RATE_LIMITED {policy, retry_after} с Retry-After", async () => {
    const pol = [spec("share", 5, 60)];
    const a = make(pol);
    const b = make(pol);
    const user = randomUUID();
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).check("t.share", user)));
    expect(res.filter((d) => d.allowed)).toHaveLength(5);
    for (const d of res.filter((x) => !x.allowed)) expect(d.retryAfter).toBeGreaterThanOrEqual(1);
    expect((await b.check("t.share", randomUUID())).allowed).toBe(true);

    const app = await buildBase({ serviceName: "t", version: "0", logLevel: "silent" });
    app.get("/x", async () => {
      await a.enforce("t.share", user);
      return {};
    });
    const r = await app.inject({ url: "/x" });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ code: "RATE_LIMITED", message: "Слишком много запросов, повторите позже", details: { policy: "t.share" } });
    expect(Number(r.headers["retry-after"])).toBe(r.json().details.retry_after);
    expect(r.json().details.retry_after).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it("граница окна: после burst — по одному в интервал (нет второго burst на стыке минут)", async () => {
    const lim = make([spec("edge", 10, 60)]);
    const user = randomUUID();
    for (let i = 0; i < 10; i++) expect((await lim.check("t.edge", user)).allowed).toBe(true);
    const d = await lim.check("t.edge", user);
    expect(d.allowed).toBe(false);
    expect(d.retryAfter).toBeGreaterThanOrEqual(5);
    expect(d.retryAfter).toBeLessThanOrEqual(6);
  });

  it("метрики и топ отказов: только имя политики и псевдоним в ключах", async () => {
    const lim = make([spec("m", 2, 60)]);
    const users = [randomUUID(), randomUUID()];
    for (let i = 0; i < 3; i++) await lim.check("t.m", users[0]!);
    for (let i = 0; i < 4; i++) await lim.check("t.m", users[1]!);
    const minute = epochMinute(Date.now());
    const h = (await redis.call("HGETALL", lim.key("rlm", "t.m", minute))) as string[];
    expect(Object.fromEntries(h.reduce<[string, string][]>((acc, v, i, arr) => (i % 2 ? acc : [...acc, [v, arr[i + 1]!]]), []))).toEqual({ allowed: "4", rejected: "3" });
    const top = (await redis.call("ZREVRANGE", lim.key("rlt", "t.m", minute), 0, -1, "WITHSCORES")) as string[];
    expect(top).toEqual([users[1], "2", users[0], "1"]);
    expect(Number(await redis.call("TTL", lim.key("rlm", "t.m", minute)))).toBeGreaterThan(3 * 3600 - 10);
    for (const k of await keys()) expect(k.slice(prefix.length)).toMatch(/^(rl|rlm|rlt):t\.m:|^rl:policy:t\.m$/);
  });

  it("IP и e-mail — только хеш с суточной солью; IPv6 по /64; соль общая для реплик", async () => {
    const pol = [{ ...spec("ip", 2, 60, "closed"), subject: "ip" }];
    const a = make(pol);
    const b = make(pol);
    const ip = "2001:db8:aa:bb::1";
    const s1 = await a.hashedSubject("ip", ip);
    expect(s1).toMatch(/^[0-9a-f]{16}$/);
    expect(await b.hashedSubject("ip", "2001:db8:aa:bb:ffff::9")).toBe(s1);
    expect(await b.hashedSubject("ip", "2001:db8:aa:bc::1")).not.toBe(s1);
    expect(await a.hashedSubject("email", "boss@example.com")).not.toBe(await a.hashedSubject("ip", "boss@example.com"));
    await a.enforce("t.ip", () => a.hashedSubject("ip", "203.0.113.7"));
    await b.enforce("t.ip", () => b.hashedSubject("ip", "203.0.113.7"));
    await expect(a.enforce("t.ip", () => a.hashedSubject("ip", "203.0.113.7"))).rejects.toMatchObject({ status: 429 });
    const all = (await keys()).join(" ");
    expect(all).not.toContain("203.0.113.7");
    expect(all).not.toContain("2001:db8");
    expect(all).not.toContain("example.com");
    expect(ipRateKey("::ffff:198.51.100.4")).toBe("198.51.100.4");
  });

  it("переопределение действует ≤ периода перечитывания, сброс — назад к значению по умолчанию; публикация rl:policy", async () => {
    const lim = make([spec("ov", 2, 60)], { overrideRefreshSeconds: 1 });
    const user = randomUUID();
    expect([(await lim.check("t.ov", user)).allowed, (await lim.check("t.ov", user)).allowed, (await lim.check("t.ov", user)).allowed]).toEqual([true, true, false]);
    await redis.call("SET", lim.overrideKey("t.ov"), JSON.stringify({ v: 1, limit: 100, window_s: 60, burst: null, by: "staff-1", at: new Date().toISOString(), reason: "праздник", expires_at: null }));
    const deadline = Date.now() + 5000;
    while (!(await lim.check("t.ov", user)).allowed) {
      expect(Date.now()).toBeLessThan(deadline);
      await sleep(200);
    }
    expect(lim.effective("t.ov").source).toBe("override");
    const pub = JSON.parse((await redis.call("GET", lim.policyKey("t.ov"))) as string);
    expect(pub).toMatchObject({ limit: 100, source: "override", service: "svc-test", fail: "open", enabled: true });
    await redis.call("DEL", lim.overrideKey("t.ov"));
    await sleep(1100);
    await lim.check("t.ov", user);
    await lim.settle();
    expect(lim.effective("t.ov")).toMatchObject({ limit: 2, source: "default" });
  });

  it("повреждённое или истёкшее переопределение — значения по умолчанию + WARNING", async () => {
    const warns: string[] = [];
    const lim = make([spec("bad", 3, 60), spec("exp", 3, 60)], { log: { warn: (_o, m) => warns.push(m) } });
    await redis.call("SET", lim.overrideKey("t.bad"), "{not json");
    const past = new Date(Date.now() - 60_000).toISOString();
    await redis.call("SET", lim.overrideKey("t.exp"), JSON.stringify({ v: 1, limit: 999, window_s: 60, burst: null, by: "s", at: past, reason: "r", expires_at: past }));
    await lim.refresh();
    expect(lim.effective("t.bad").source).toBe("default");
    expect(lim.effective("t.exp").source).toBe("default");
    expect(warns).toEqual(["rate limit override invalid, defaults used"]);
    expect(() => parseOverride('{"v":1,"limit":5,"window_s":0}')).toThrow();
    expect(() => parseOverride('{"v":1,"limit":5,"window_s":60,"expires_at":"2030-01-01T00:00:00"}')).toThrow();
    expect(parseOverride(null)).toBeNull();
  });

  it("Redis недоступен: fail open пропускает (failopen), fail closed → 503 RATE_LIMIT_UNAVAILABLE; WARNING раз в минуту; счётчики дописываются после восстановления", async () => {
    const dead = new RespClient("redis://127.0.0.1:1/0");
    const warns: string[] = [];
    const pol = Object.fromEntries([spec("o", 5, 60), spec("c", 5, 60, "closed")].map((p) => [p.policy, p]));
    const down = new RateLimiter({ redis: dead, service: "svc-test", policies: pol, keyPrefix: prefix, log: { warn: (_o, m) => warns.push(m) } });
    for (let i = 0; i < 3; i++) expect(await down.check("t.o", "u1")).toMatchObject({ allowed: true, degraded: true });
    await expect(down.enforce("t.c", "u1")).rejects.toMatchObject({ status: 503, code: "RATE_LIMIT_UNAVAILABLE", details: { policy: "t.c" } });
    await expect(down.enforce("t.c", () => down.hashedSubject("ip", "203.0.113.9"))).rejects.toMatchObject({ status: 503 });
    expect(warns).toEqual(["rate limit store unavailable", "rate limit store unavailable"]);
    // тот же процесс, Redis вернулся
    (down as unknown as { redis: RespClient }).redis = redis;
    (down as unknown as { sha: string | null }).sha = null;
    await down.check("t.o", "u2");
    await down.settle();
    const minute = epochMinute(Date.now());
    expect(await redis.call("HGET", down.key("rlm", "t.o", minute), "failopen")).toBe("3");
    expect(await redis.call("HGET", down.key("rlm", "t.c", minute), "failclosed")).toBe("2");
  });

  it("зависший Redis: таймаут проверки — сбой по режиму политики, ответ не ждёт", async () => {
    const hung = { call: () => new Promise<unknown>(() => undefined) };
    const lim = new RateLimiter({ redis: hung, service: "s", policies: { "t.h": spec("h", 5, 60, "closed") }, timeoutMs: 100 });
    const t0 = Date.now();
    await expect(lim.enforce("t.h", "u")).rejects.toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE" });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("выключатель RATE_LIMITS_ENABLED=false: всё проходит, считается только allowed", async () => {
    const lim = make([spec("off", 1, 60, "closed")], { enabled: false });
    for (let i = 0; i < 5; i++) expect((await lim.check("t.off", "u")).allowed).toBe(true);
    await sleep(100);
    expect(await redis.call("HGET", lim.key("rlm", "t.off", epochMinute(Date.now())), "allowed")).toBe("5");
    expect(await redis.call("EXISTS", lim.key("rl", "t.off", "u"))).toBe(0);
  });

  it("policyDefaults: политики сервиса, значения из конфигурации; чужая политика — ошибка", () => {
    const d = policyDefaults("telegram-bff", { "tg.user": 77 });
    expect(Object.keys(d)).toEqual(RATE_LIMIT_POLICIES.filter((p) => p.service === "telegram-bff").map((p) => p.policy));
    expect(d["tg.user"]!.limit).toBe(77);
    expect(d["tg.offers"]!.limit).toBe(20);
    expect(() => policyDefaults("telegram-bff", { "adm.staff": 1 })).toThrow();
  });
});
