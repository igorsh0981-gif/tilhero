import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { pseudonymize } from "@tilhero/ts-common";
import { buildApp } from "../src/app.js";
import { scrub } from "../src/logging.js";
import { AccessTokens } from "../src/tokens.js";
import {
  FakeDomains,
  LogCapture,
  SESSION_SECRET,
  TG_USER,
  bearer,
  closeRedis,
  initDataFor,
  login,
  makeHarness,
  testConfig,
  type Harness,
} from "./helpers.js";

/** Фиксированное окно лимита — минута; не начинаем серию в последние секунды окна. */
async function avoidWindowEdge(): Promise<void> {
  const into = Date.now() % 60_000;
  if (into > 55_000) await new Promise((r) => setTimeout(r, 60_000 - into + 50));
}

let h: Harness;
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

describe("rate limits (Redis)", () => {
  beforeEach(async () => {
    h = await makeHarness({ RATE_LIMIT_USER_PER_MIN: "8" });
    await avoidWindowEdge();
  });

  it("10/min per IP on /v1/session/telegram → 429 RATE_LIMITED + Retry-After", async () => {
    const hit = (ip: string) =>
      h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: "bad" }, remoteAddress: ip });
    for (let i = 0; i < 10; i++) expect((await hit("198.51.100.7")).statusCode).toBe(401);
    const limited = await hit("198.51.100.7");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "RATE_LIMITED", details: { retry_after: expect.any(Number) } });
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // другой IP не затронут
    expect((await hit("198.51.100.8")).statusCode).toBe(401);
  });

  it("client-supplied X-Forwarded-For cannot dodge the IP limit (one trusted proxy hop)", async () => {
    for (let i = 0; i < 11; i++) {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/session/telegram",
        payload: { init_data: "bad" },
        remoteAddress: "10.0.0.2", // Railway edge
        headers: { "x-forwarded-for": `203.0.113.${i}, 192.0.2.44` }, // клиент подставил мусор, edge дописал реальный IP
      });
      expect(res.statusCode).toBe(i < 10 ? 401 : 429);
    }
  });

  it("per-user limit applies to all authenticated endpoints and is isolated per user", async () => {
    const a = await login(h);
    const b = await login(h, { id: 900321, first_name: "Анна", username: "test_user_4" });
    for (let i = 0; i < 8; i++) expect((await h.app.inject({ url: "/v1/plan", headers: bearer(a.access) })).statusCode).toBe(200);
    const limited = await h.app.inject({ url: "/v1/profile", headers: bearer(a.access) });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect((await h.app.inject({ url: "/v1/plan", headers: bearer(b.access) })).statusCode).toBe(200);
  });

  it("5/min on PIN verification (even with the right PIN after that)", async () => {
    const first = await login(h);
    h.fake.enablePin(first.userId, "583920");
    const s = await login(h);
    for (let i = 0; i < 5; i++) {
      const r = await h.app.inject({ method: "POST", url: "/v1/session/pin/verify", headers: bearer(s.access), payload: { pin: "000000" } });
      expect([401, 423]).toContain(r.statusCode);
    }
    const limited = await h.app.inject({ method: "POST", url: "/v1/session/pin/verify", headers: bearer(s.access), payload: { pin: "583920" } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe("RATE_LIMITED");
    // биометрия делит тот же лимит
    const bio = await h.app.inject({ method: "POST", url: "/v1/session/biometric/verify", headers: bearer(s.access), payload: { biometric_token: "x" } });
    expect(bio.statusCode).toBe(429);
    expect(h.fake.callsTo("identity", "POST", "/internal/v1/me/pin/verify")).toHaveLength(5);
  });

  it("e2e regression: lockout by 5 wrong PINs does not block recovery by the bot code in the same minute", async () => {
    const first = await login(h);
    h.fake.enablePin(first.userId, "583920");
    const s = await login(h);
    for (let i = 0; i < 5; i++) {
      await h.app.inject({ method: "POST", url: "/v1/session/pin/verify", headers: bearer(s.access), payload: { pin: "000000" } });
    }
    // PIN-лимит исчерпан…
    const pinLimited = await h.app.inject({ method: "POST", url: "/v1/session/pin/verify", headers: bearer(s.access), payload: { pin: "583920" } });
    expect(pinLimited.statusCode).toBe(429);
    // …а восстановление по коду из бота идёт до identity
    const req = await h.app.inject({ method: "POST", url: "/v1/profile/security/pin/reset-request", headers: bearer(s.access) });
    expect(req.statusCode).toBe(200);
    const ok = await h.app.inject({
      method: "POST", url: "/v1/profile/security/pin/reset-confirm", headers: bearer(s.access), payload: { code: "246810", new_pin: "1470" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().security.pin_required).toBe(false);
  });

  it("reset code entry has its own 5/min limit", async () => {
    const first = await login(h);
    h.fake.enablePin(first.userId, "583920");
    const s = await login(h);
    const confirm = () =>
      h.app.inject({
        method: "POST", url: "/v1/profile/security/pin/reset-confirm", headers: bearer(s.access), payload: { code: "000000", new_pin: "1470" },
      });
    for (let i = 0; i < 5; i++) expect((await confirm()).statusCode).toBe(401);
    const limited = await confirm();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe("RATE_LIMITED");
    expect(h.fake.callsTo("identity", "POST", "/internal/v1/me/pin/reset-confirm")).toHaveLength(5);
  });
});

describe("logs contain no PII or secrets", () => {
  beforeEach(async () => {
    h = await makeHarness({ LOG_LEVEL: "trace" });
  });

  it("initData, PIN, codes, tokens, message texts never reach the log stream", async () => {
    const initData = initDataFor();
    const secrets: string[] = [initData, new URLSearchParams(initData).get("hash")!, "583920", "246810", "917364"];

    const loginRes = await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: initData } });
    const s = loginRes.json();
    secrets.push(s.access_token, s.refresh_token);
    const refreshed = (await h.app.inject({ method: "POST", url: "/v1/session/refresh", payload: { refresh_token: s.refresh_token } })).json();
    secrets.push(refreshed.access_token, refreshed.refresh_token);
    const auth = bearer(refreshed.access_token);

    await h.app.inject({ method: "PUT", url: "/v1/profile/security/pin", headers: auth, payload: { pin: "583920" } });
    const bio = (await h.app.inject({ method: "PUT", url: "/v1/profile/security/biometric", headers: auth })).json();
    secrets.push(bio.biometric_token);
    const initData2 = initDataFor(); // новый запуск Mini App — новый initData (одноразовый, О-1)
    secrets.push(initData2);
    const s2 = (await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: initData2 } })).json();
    secrets.push(s2.access_token, s2.refresh_token);
    await h.app.inject({ method: "POST", url: "/v1/session/pin/verify", headers: bearer(s2.access_token), payload: { pin: "000111" } });
    await h.app.inject({ method: "POST", url: "/v1/session/pin/verify", headers: bearer(s2.access_token), payload: { pin: "583920" } });
    await h.app.inject({ method: "POST", url: "/v1/session/biometric/verify", headers: bearer(s2.access_token), payload: { biometric_token: bio.biometric_token } });
    await h.app.inject({ method: "POST", url: "/v1/profile/security/pin/reset-confirm", headers: bearer(s2.access_token), payload: { code: "246810", new_pin: "917364" } });

    // у первого пользователя теперь PIN — обращение пишет второй (без PIN)
    const fresh = await login(h, { id: 900888, first_name: "Анна", username: "test_user_9" });
    secrets.push(fresh.access, fresh.refresh);
    const text = "Мой паспорт AB1234567, перезвоните на +998901234567";
    secrets.push("AB1234567", "+998901234567");
    await h.app.inject({
      method: "POST",
      url: "/v1/support/tickets",
      headers: { ...bearer(fresh.access), "idempotency-key": randomUUID() },
      payload: { category: "ACCOUNT", subject: "Личные данные", message: text },
    });
    // неудачные пути тоже логируются: подделанный initData, битый JSON с initData внутри, ошибка домена
    await h.app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: initData.replace("hash=", "hash=0") } });
    await h.app.inject({
      method: "POST",
      url: "/v1/session/telegram",
      headers: { "content-type": "application/json" },
      payload: `{"init_data":"${initData}"`,
    });
    h.fake.override("identity", "GET", "/internal/v1/me", () => new Response("boom", { status: 500 }));
    await h.app.inject({ url: "/v1/profile", headers: bearer(fresh.access) });

    const lines = h.logs.parsed();
    expect(lines.length).toBeGreaterThan(10);
    // время записи (epoch мс) может случайно содержать цифры PIN/кода — его не проверяем
    const raw = h.logs.text.replace(/"time":\d+/g, '"time":0');
    for (const secret of secrets) expect(raw.includes(secret), `leaked: ${secret.slice(0, 12)}…`).toBe(false);
    // Telegram-идентификаторы и имя — тоже PII
    for (const pii of [String(TG_USER.id), TG_USER.username!, TG_USER.first_name, "900888", "test_user_9", "Анна"]) {
      expect(raw).not.toContain(pii);
    }
    // user_id в открытом виде не пишем — только псевдоним
    expect(raw).not.toContain(fresh.userId);

    // структура: JSON, trace_id всегда, user_pid у авторизованных запросов, access-лог с маршрутом и длительностью
    for (const l of lines) {
      expect(l.trace_id).toBeTruthy();
      expect(l.service).toBe("telegram-bff");
    }
    const access = lines.filter((l) => l.msg === "request completed");
    expect(access.length).toBeGreaterThan(5);
    const profileLine = access.find((l) => l.route === "/v1/profile")!;
    expect(profileLine).toMatchObject({ method: "GET", status_code: 503, outcome: "server_error", user_pid: pseudonymize(fresh.userId) });
    expect(typeof profileLine.duration_ms).toBe("number");
    expect(lines.some((l) => l.msg === "initData rejected" && l.reason === "hash_mismatch")).toBe(true);
  });

  it("TilHero: имя ребёнка, токены приглашений и согласия родителя, start_param, ссылки не попадают в лог", async () => {
    const startParam = "inv_SECRETinviteTOKEN0123456789ab";
    const s = await login(h, TG_USER, "203.0.113.10", startParam);
    h.fake.setAge(s.userId, "18+");
    const auth = bearer(s.access);
    const created = await h.app.inject({ method: "POST", url: "/v1/learners", headers: auth, payload: { display_name: "Мадинахон", age_band: "6-9" } });
    expect(created.statusCode).toBe(201);
    const inv = (await h.app.inject({ method: "POST", url: "/v1/invites", headers: { ...auth, "idempotency-key": randomUUID() }, payload: { kind: "friend" } })).json();
    const inviteToken = new URL(inv.link).searchParams.get("startapp")!.slice(4);
    // подросток просит согласие родителя
    const teen = await login(h, { id: 900999, first_name: "Подросток", username: "teen_user" }, "203.0.113.20");
    h.fake.setAge(teen.userId, "14-17");
    const gc = (await h.app.inject({ method: "POST", url: "/v1/profile/guardian-consent", headers: bearer(teen.access) })).json();
    const gcToken = new URL(gc.link).searchParams.get("startapp")!.slice(3);
    await h.app.inject({ url: `/v1/guardian-consents/${gcToken}` });
    await h.app.inject({ method: "POST", url: `/v1/guardian-consents/${gcToken}/accept`, headers: auth });
    await h.app.inject({ method: "POST", url: "/v1/invites/open", headers: bearer(teen.access), payload: { token: inviteToken } });
    // ошибки по токенам тоже логируются — без токенов
    await h.app.inject({ url: `/v1/guardian-consents/${"Z".repeat(40)}` });
    await h.app.inject({ url: `/v1/guardian-consents/${"Y".repeat(300)}` });
    await h.app.inject({ method: "POST", url: "/v1/session/learner", headers: auth, payload: { learner_id: created.json().learner_id } });

    const raw = h.logs.text;
    for (const secret of [startParam, "SECRETinviteTOKEN", inviteToken, gcToken, "Z".repeat(40), "Y".repeat(40), inv.link, gc.link, "Мадинахон", "Подросток", "teen_user"]) {
      expect(raw.includes(secret), `leaked: ${secret.slice(0, 16)}…`).toBe(false);
    }
    expect(raw).not.toContain(created.json().learner_id);
    expect(h.logs.parsed().some((l) => l.route === "/v1/guardian-consents/:token")).toBe(true);
  });

  it("scrub() redacts sensitive keys at any depth but keeps Error objects intact", () => {
    const err = new Error("boom");
    const out = scrub({ a: { init_data: "x", nested: [{ pin: "1", ok: 2 }] }, refresh_token: "r", err, code: "PIN_INVALID" }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.a.init_data).toBe("[redacted]");
    expect(out.a.nested[0]).toEqual({ pin: "[redacted]", ok: 2 });
    expect(out.refresh_token).toBe("[redacted]");
    expect(out.err).toBe(err);
    expect(out.code).toBe("PIN_INVALID");
  });
});

describe("session store outage", () => {
  it("Redis down → 503 (fail-closed), readiness degraded, no stack in body", async () => {
    const dead = new Redis("redis://127.0.0.1:6390", { maxRetriesPerRequest: 0, connectTimeout: 200, retryStrategy: () => 100 });
    const fake = new FakeDomains();
    const app = await buildApp(testConfig(), { redis: dead, fetchImpl: fake.fetch, logStream: new LogCapture() });
    try {
      const id = randomUUID();
      const token = await new AccessTokens(SESSION_SECRET, 900).issue({ accountId: id, learnerId: id, sid: randomUUID(), pin: true });
      const res = await app.inject({ url: "/v1/profile", headers: bearer(token) });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "session-store" } });
      const ready = await app.inject({ url: "/health/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toEqual({ status: "degraded", checks: { redis: "down" } });
      const pub = await app.inject({ method: "POST", url: "/v1/session/telegram", payload: { init_data: initDataFor() } });
      expect(pub.statusCode).toBe(503);
      expect(pub.body).not.toMatch(/ECONNREFUSED|at \w+ \(/);
    } finally {
      await app.close();
      dead.disconnect();
    }
  });
});
