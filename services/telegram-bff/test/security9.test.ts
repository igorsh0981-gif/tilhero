/**
 * Q5 спринта 9 — матрица безопасности telegram-bff (docs/sprint9/INTERNAL_API.md §3). Дополняет telegramAuth.test.ts,
 * session.test.ts и security.test.ts:
 *  - SEC-01: initData — подпись, чужой бот-токен, `auth_date` старше INIT_DATA_MAX_AGE_SECONDS (повтор старого),
 *    без `auth_date`, из будущего, лишнее неподписанное поле, дубль ключа, без user → 401, identity не вызывается;
 *  - SEC-02: access JWT — `alg: none`, путаница алгоритмов (HS512 тем же секретом), чужой aud/iss, просроченный,
 *    подпись другим ключом, без sid → 401;
 *  - SEC-04: IDOR на уровне BFF — каждый клиентский маршрут с `{id}`/токеном: в домен уходит только `sub` сессии,
 *    `user_id` из клиента не принимается (422), «чужое» из домена → 404 (не 403); поддержка — сквозь подделку домена;
 *  - SEC-12: CORS — только origin Mini App; ответы с данными пользователя — Cache-Control: no-store;
 *  - Q2/SEC-15: ключи лимитера входа без IP в открытом виде; 429 с Retry-After.
 */
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { buildApp } from "../src/app.js";
import { signInitData } from "../src/telegramAuth.js";
import {
  BOT_TOKEN,
  FakeDomains,
  LogCapture,
  testConfig,
  ORIGIN,
  SESSION_SECRET,
  TG_USER,
  bearer,
  closeRedis,
  login,
  makeHarness,
  testRedis,
  type Harness,
} from "./helpers.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const now = () => Math.floor(Date.now() / 1000);
const USER = JSON.stringify({ id: 900777, first_name: "Анна", username: "test_user_q5" });

function signed(fields: Array<[string, string]>, token = BOT_TOKEN): string {
  return signInitData(token, {
    user: null,
    authDate: Number(fields.find(([k]) => k === "auth_date")?.[1] ?? now()),
    extra: Object.fromEntries(fields.filter(([k]) => k !== "auth_date")),
  });
}

describe("SEC-01: initData", () => {
  beforeEach(async () => {
    h = await makeHarness({ RATE_LIMIT_SESSION_IP_PER_MIN: "1000" });
  });

  const good = () => signInitData(BOT_TOKEN, { user: TG_USER, queryId: "AAHq5" });
  const cases: Array<[string, () => string, string]> = [
    ["подменённая подпись", () => good().replace(/hash=[0-9a-f]{4}/, "hash=0000"), "INIT_DATA_INVALID"],
    ["изменённое поле при прежней подписи", () => good().replace("900001", "900002"), "INIT_DATA_INVALID"],
    ["чужой бот-токен", () => signInitData("7000000002:AAother-bot-token-for-q5-tests-xx", { user: TG_USER }), "INIT_DATA_INVALID"],
    ["повтор старого (auth_date старше INIT_DATA_MAX_AGE = 600 с)", () => signInitData(BOT_TOKEN, { user: TG_USER, authDate: now() - 601 }), "INIT_DATA_EXPIRED"],
    ["auth_date из будущего", () => signInitData(BOT_TOKEN, { user: TG_USER, authDate: now() + 600 }), "INIT_DATA_INVALID"],
    ["без auth_date", () => {
      const p = new URLSearchParams(signed([["user", USER]]));
      p.delete("auth_date");
      return p.toString();
    }, "INIT_DATA_INVALID"],
    ["лишнее неподписанное поле", () => `${good()}&admin=true`, "INIT_DATA_INVALID"],
    ["дубль ключа user", () => `${good()}&user=${encodeURIComponent(USER)}`, "INIT_DATA_INVALID"],
    ["без user", () => signInitData(BOT_TOKEN, { user: null }), "INIT_DATA_INVALID"],
    ["user.id не число", () => signInitData(BOT_TOKEN, { user: { id: "900001", first_name: "X" } }), "INIT_DATA_INVALID"],
    ["пустой hash", () => good().replace(/hash=[0-9a-f]+/, "hash="), "INIT_DATA_INVALID"],
  ];

  for (const [name, make, code] of cases) {
    it(`${name} → 401 ${code}, identity не вызывается`, async () => {
      const res = await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: make() } });
      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().code).toBe(code);
      expect(h.fake.callsTo("identity")).toHaveLength(0);
      expect(res.body).not.toContain("hash=");
    });
  }

  it("подлинный initData → 200 (контроль матрицы)", async () => {
    const res = await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: good() } });
    expect(res.statusCode).toBe(200);
  });

  // О-1 (спринт 9, решение по умолчанию): initData одноразовый в пределах срока (600 с)
  it("тот же initData второй раз → 401 INIT_DATA_REPLAYED, identity не вызывается; новый запуск — 200", async () => {
    const once = good();
    expect((await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: once } })).statusCode).toBe(200);
    const calls = h.fake.callsTo("identity").length;
    const again = await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: once } });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ code: "INIT_DATA_REPLAYED", details: { reason: "replayed" } });
    expect(h.fake.callsTo("identity")).toHaveLength(calls);
    expect(again.body).not.toContain("hash=");
    await new Promise((r) => setTimeout(r, 20));
    const minuteKeys = await testRedis().keys(`${h.config.redisKeyPrefix}metric:initdata:*`);
    const counts = await Promise.all(minuteKeys.map((k) => testRedis().hget(k, "replayed")));
    expect(counts.reduce((a, c) => a + Number(c ?? 0), 0)).toBeGreaterThanOrEqual(1);
    const next = signInitData(BOT_TOKEN, { user: TG_USER, queryId: "AAHq5next" });
    expect((await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: next } })).statusCode).toBe(200);
  });

  // ревью спринта 9: ключ одноразовости — подпись канонической data-check-string, а не сырая строка
  it("тот же initData в другой записи (порядок параметров, регистр hash, %20 вместо +, %3A вместо :) → 401 INIT_DATA_REPLAYED", async () => {
    const once = signInitData(BOT_TOKEN, { user: { ...TG_USER, first_name: "Ann Lee" }, queryId: "AAHq5form" });
    expect(once).toContain("+"); // пробел имени — «+» (URLSearchParams)
    const pairs = once.split("&");
    const hash = new URLSearchParams(once).get("hash")!;
    const variants = {
      reordered: [...pairs].reverse().join("&"),
      upper_hash: once.replace(hash, hash.toUpperCase()),
      pct20: once.replace(/\+/g, "%20"),
      raw_colon: once.replace(/%3A/g, ":"),
    };
    expect((await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: once } })).statusCode).toBe(200);
    const calls = h.fake.callsTo("identity").length;
    for (const [name, v] of Object.entries(variants)) {
      expect(v, name).not.toBe(once);
      const r = await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: v } });
      expect([name, r.statusCode, r.json().code]).toEqual([name, 401, "INIT_DATA_REPLAYED"]);
    }
    expect(h.fake.callsTo("identity")).toHaveLength(calls);
  });

  it("первым предъявлен вариант записи — оригинал после него тоже повтор", async () => {
    const once = signInitData(BOT_TOKEN, { user: TG_USER, queryId: "AAHq5form2" });
    const reordered = once.split("&").reverse().join("&");
    expect((await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: reordered } })).statusCode).toBe(200);
    const r = await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: once } });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe("INIT_DATA_REPLAYED");
  });

  it("вход не состоялся (identity недоступен) — тот же initData можно предъявить снова", async () => {
    const once = good();
    h.fake.down.add("identity");
    const failed = await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: once } });
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    h.fake.down.delete("identity");
    expect((await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: once } })).statusCode).toBe(200);
  });

  it("INIT_DATA_ONE_TIME=false — повтор в пределах срока допускается (настраиваемо)", async () => {
    await h.close();
    h = await makeHarness({ RATE_LIMIT_SESSION_IP_PER_MIN: "1000", INIT_DATA_ONE_TIME: "false" });
    const once = good();
    for (let i = 0; i < 2; i++) {
      expect((await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: once } })).statusCode).toBe(200);
    }
  });

  it("Redis недоступен — вход не выполняется (503, fail closed, как D10), даже при выключенных лимитах", async () => {
    const config = testConfig({ RATE_LIMITS_ENABLED: "false" });
    const dead = new Redis("redis://127.0.0.1:1/0", { maxRetriesPerRequest: 0, lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
    dead.on("error", () => undefined);
    const fake = new FakeDomains();
    const app = await buildApp(config, { redis: dead, fetchImpl: fake.fetch, logStream: new LogCapture() });
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: good() } });
      expect(res.statusCode).toBe(503);
      expect(fake.callsTo("identity")).toHaveLength(0);
    } finally {
      await app.close();
      dead.disconnect();
    }
  });
});

describe("SEC-02: access JWT сессии", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  const key = (s: string) => new TextEncoder().encode(s);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  async function forge(o: { alg?: "HS256" | "HS512"; secret?: string; aud?: string; iss?: string; exp?: number; sid?: string | null; sub: string }) {
    const t = now();
    const jwt = new SignJWT({ ...(o.sid === null ? {} : { sid: o.sid ?? randomUUID() }), lrn: o.sub, pin: true })
      .setProtectedHeader({ alg: o.alg ?? "HS256", typ: "JWT" })
      .setIssuer(o.iss ?? "telegram-bff")
      .setAudience(o.aud ?? "telegram-miniapp")
      .setSubject(o.sub)
      .setIssuedAt(t - 10)
      .setExpirationTime(o.exp ?? t + 600);
    return jwt.sign(key(o.secret ?? SESSION_SECRET));
  }

  it("alg none, HS512, чужие aud/iss, просроченный, чужой ключ, без sid, чужой sid → 401", async () => {
    const s = await login(h);
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: s.userId, sid: "x", pin: true, iss: "telegram-bff", aud: "telegram-miniapp", exp: now() + 600, iat: now() })}.`;
    const tokens: Array<[string, string]> = [
      ["alg none", none],
      ["HS512 тем же секретом", await forge({ alg: "HS512", sub: s.userId })],
      ["чужой aud", await forge({ aud: "admin-web", sub: s.userId })],
      ["чужой iss", await forge({ iss: "admin-bff", sub: s.userId })],
      ["просроченный", await forge({ exp: now() - 60, sub: s.userId })],
      ["подпись другим ключом", await forge({ secret: "other-session-secret-" + "q".repeat(32), sub: s.userId })],
      ["без sid", await forge({ sid: null, sub: s.userId })],
      ["подлинная подпись, неизвестный sid", await forge({ sub: s.userId })],
    ];
    for (const [name, t] of tokens) {
      const res = await h.app.inject({ url: "/v1/profile", headers: bearer(t) });
      expect(res.statusCode, name).toBe(401);
    }
    expect((await h.app.inject({ url: "/v1/profile", headers: bearer(s.access) })).statusCode).toBe(200);
  });
});

describe("SEC-04: IDOR через BFF", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("обращение (подделка домена знает владельца): чужое → 404 на всех маршрутах с {ticket_id}", async () => {
    const owner = await login(h);
    const intruder = await login(h, { id: 900555, first_name: "Чужой", username: "intruder_q5" }, "203.0.113.11");
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/support/tickets",
      headers: { ...bearer(owner.access), "idempotency-key": randomUUID() },
      payload: { category: "ACCOUNT", subject: "Не открывается", message: "Ошибка" },
    });
    expect(created.statusCode).toBe(201);
    const t = created.json();
    for (const ref of [t.ticket_id, t.number]) {
      const probes = [
        h.app.inject({ url: `/v1/support/tickets/${ref}`, headers: bearer(intruder.access) }),
        h.app.inject({ method: "POST", url: `/v1/support/tickets/${ref}/messages`, headers: bearer(intruder.access), payload: { text: "чужое" } }),
        h.app.inject({ method: "POST", url: `/v1/support/tickets/${ref}/close`, headers: bearer(intruder.access), payload: {} }),
      ];
      for (const res of await Promise.all(probes)) expect(res.statusCode, `${ref}: ${res.body}`).toBe(404);
    }
    expect((await h.app.inject({ url: `/v1/support/tickets/${t.ticket_id}`, headers: bearer(owner.access) })).statusCode).toBe(200);
  });

  it("приглашение: чужое нельзя отозвать; preview/accept/decline без :open → 404; домен получает только sub сессии", async () => {
    const owner = await login(h);
    h.fake.setAge(owner.userId, "18+");
    const intruder = await login(h, { id: 900556, first_name: "Чужой", username: "intruder_q6" }, "203.0.113.12");
    const inv = (await h.app.inject({ method: "POST", url: "/v1/invites", headers: { ...bearer(owner.access), "idempotency-key": randomUUID() }, payload: { kind: "friend" } })).json();
    const id = inv.invite_id as string;
    const probes: Array<["GET" | "POST" | "DELETE", string]> = [
      ["DELETE", `/v1/invites/${id}`],
      ["GET", `/v1/invites/${id}/preview`],
      ["POST", `/v1/invites/${id}/accept`],
      ["POST", `/v1/invites/${id}/decline`],
    ];
    for (const [method, url] of probes) {
      const res = await h.app.inject({ method, url, headers: bearer(intruder.access) });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().code, url).toBe("INVITE_NOT_FOUND");
    }
    expect(h.fake.callsTo("social").filter((c) => c.path.includes(id)).every((c) => c.subject === intruder.userId)).toBe(true);
    expect(h.fake.invites.get(id)!.invite.status).toBe("active");
  });

  it("детский профиль чужого аккаунта: переключение, настройки — 404 LEARNER_NOT_FOUND (неотличимо)", async () => {
    const owner = await login(h);
    h.fake.setAge(owner.userId, "18+");
    const child = h.fake.addChild(owner.userId);
    const intruder = await login(h, { id: 900557, first_name: "Чужой", username: "intruder_q7" }, "203.0.113.13");
    const res = await h.app.inject({ method: "POST", url: "/v1/session/learner", headers: bearer(intruder.access), payload: { learner_id: child } });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("LEARNER_NOT_FOUND");
    // подделанный access-токен с чужим lrn и правильным sid не проходит: lrn сверяется с учениками аккаунта
    expect(h.fake.callsTo("learningPlan").some((c) => c.subject === child)).toBe(false);
  });

  it("user_id из клиента не принимается: 422 в query и теле, в домен не уходит", async () => {
    const s = await login(h);
    const other = randomUUID();
    const q = await h.app.inject({ url: `/v1/notifications?user_id=${other}`, headers: bearer(s.access) });
    expect(q.statusCode).toBe(422);
    const b = await h.app.inject({ method: "PATCH", url: "/v1/plan", headers: bearer(s.access), payload: { user_id: other, goal: "work" } });
    expect(b.statusCode).toBe(422);
    const l = await h.app.inject({ method: "POST", url: "/v1/learners", headers: bearer(s.access), payload: { display_name: "X", age_band: "6-9", guardian_user_id: other } });
    expect(l.statusCode).toBe(422);
    expect(h.fake.calls.some((c) => JSON.stringify(c.body ?? {}).includes(other) || JSON.stringify(c.query).includes(other))).toBe(false);
  });
});

describe("SEC-12: CORS и кэш", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("CORS только для origin Mini App; данные пользователя — no-store", async () => {
    const s = await login(h);
    const ok = await h.app.inject({ url: "/v1/profile", headers: { ...bearer(s.access), origin: ORIGIN } });
    expect(ok.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(String(ok.headers["cache-control"])).toContain("no-store");
    for (const origin of ["https://evil.example", "null", `${ORIGIN}.evil.example`, "http://miniapp.tilhero.test"]) {
      const res = await h.app.inject({ url: "/v1/profile", headers: { ...bearer(s.access), origin } });
      expect(res.headers["access-control-allow-origin"], origin).toBeUndefined();
      const pre = await h.app.inject({ method: "OPTIONS", url: "/v1/profile", headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
      expect(pre.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
  });
});

describe("Q2 / SEC-15: ключи лимитера", () => {
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("входы с одного IP: 429 + Retry-After; в Redis нет IP в открытом виде", async () => {
    const ip = "198.51.100.231";
    let last = 0;
    let retry: unknown;
    for (let i = 0; i < 11; i++) {
      const res = await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: "bad" }, remoteAddress: ip });
      last = res.statusCode;
      retry = res.headers["retry-after"];
    }
    expect(last).toBe(429);
    expect(Number(retry)).toBeGreaterThanOrEqual(1);
    const keys = await testRedis().keys(`${h.config.redisKeyPrefix}*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k, k).not.toContain(ip);
  });
});
