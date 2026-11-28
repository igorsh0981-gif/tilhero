/**
 * Сайт оплаты — безопасность области /web/v1 (INTERNAL_API §3, §0.8, AT-86, AT-100): ни один ответ не перенаправляет
 * с ПДн в адресе; секреты и ПДн не попадают в лог; лимиты web.* (адрес клиента — глубина 2 в X-Forwarded-For);
 * stage/prod — только через Caddy web-pay (Host сайта); WEB_PAY_ENABLED=false — 404; Redis недоступен — fail-closed.
 */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { TELEGRAM_OIDC_BASE } from "../../src/config.js";
import { webClientIp } from "../../src/web/index.js";
import { closeRedis } from "../helpers.js";
import { CLIENT_SECRET } from "./mockOidc.js";
import { P, SITE, XFF, login, makeWebHarness, setCookies, startLogin, viaCaddy, writeHeaders, type WebHarness } from "./harness.js";

let h: WebHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
afterAll(closeRedis);

const ALLOWED_AUTH_PARAMS = ["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"];

describe("ПДн в адресах", () => {
  it("ни один ответ входа не перенаправляет с ПДн: /auth — только параметры OIDC, сайт — / или /?login_error=<код>", async () => {
    h = await makeWebHarness();
    const acc = h.fake.addAccount({ telegramId: 900001, displayName: "Игорь Секретов" });
    h.fake.addAccount({ telegramId: 900002, status: "DELETION_REQUESTED" });
    const locations: string[] = [];
    const run = async (telegramId: number) => {
      const s = await startLogin(h!);
      locations.push(s.location);
      const { callbackPath } = h!.oidc.approve(s.location, telegramId);
      const cb = await h!.app.inject({ url: viaCaddy(callbackPath), headers: { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` } });
      locations.push(String(cb.headers.location));
    };
    await run(900001); // успех
    await run(900002); // not_allowed
    await run(900404); // account_not_found
    h.oidc.forge = (c) => h!.oidc.sign({ ...c, aud: "1" });
    await run(900001); // auth_failed
    const bare = await h.app.inject({ url: `${P}/auth/callback?code=x&state=y`, headers: XFF });
    locations.push(String(bare.headers.location));

    const pii = ["900001", "900002", "900404", acc.accountId, "Игорь", encodeURIComponent("Игорь"), "secret_tg_username", "Test Person", "phone", "username"];
    for (const loc of locations) {
      for (const p of pii) expect(loc, loc).not.toContain(p);
      if (loc.startsWith("http")) {
        expect([...new URL(loc).searchParams.keys()].sort()).toEqual(ALLOWED_AUTH_PARAMS);
      } else {
        expect(loc).toMatch(/^\/(\?login_error=(auth_failed|account_not_found|not_allowed))?$/);
      }
    }
    expect(locations.filter((l) => l === "/")).toHaveLength(1);
  });
});

describe("секреты и ПДн в логах", () => {
  it("лог не содержит секрета клиента, code, state, code_verifier, id_token, cookie сессии, CSRF, Telegram ID, имени", async () => {
    h = await makeWebHarness();
    const acc = h.fake.addAccount({ telegramId: 987654321 });
    const s = await startLogin(h);
    const state = new URL(s.location).searchParams.get("state")!;
    const { callbackPath, code } = h.oidc.approve(s.location, acc.telegramId);
    const cb = await h.app.inject({ url: viaCaddy(callbackPath), headers: { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` } });
    const token = setCookies(cb).get("__Host-wp_session")!.value;
    const me = (await h.app.inject({ url: `${P}/me`, headers: { cookie: `__Host-wp_session=${token}` } })).json();
    // неудачи тоже пишутся в лог (причина — код, без значений)
    await h.app.inject({ url: viaCaddy(callbackPath), headers: { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` } });
    h.oidc.tokenMode = "http_400";
    const s2 = await startLogin(h);
    const second = h.oidc.approve(s2.location, acc.telegramId);
    await h.app.inject({ url: viaCaddy(second.callbackPath), headers: { ...XFF, cookie: `__Host-wp_oidc=${s2.flow}` } });
    await h.app.inject({ method: "POST", url: `${P}/orders`, headers: { cookie: `__Host-wp_session=${token}`, origin: SITE, "x-csrf-token": me.csrf_token, "idempotency-key": randomUUID() }, payload: { product_code: "plus_30d", provider: "payme", start_mode: "now", offer_version: "v" } });

    const verifiers = h.oidc.tokenCalls.map((t) => t.form.code_verifier!);
    const text = h.logs.text;
    expect(text).toContain("web_login");
    for (const secret of [CLIENT_SECRET, code, second.code, state, s.flow, token, me.csrf_token, ...verifiers, "987654321", "Test Person Name", "secret_tg_username", "eyJ"]) {
      expect(text, secret.slice(0, 12)).not.toContain(secret);
    }
    // access-лог — шаблон маршрута, без query
    expect(text).toContain('"route":"/web/v1/auth/callback"');
    expect(text).not.toContain("auth/callback?");
  });
});

describe("лимиты web.*", () => {
  it("web.auth_ip: 20 входов в минуту с одного адреса клиента (глубина 2 в XFF), подмена левых адресов не помогает", async () => {
    h = await makeWebHarness();
    const from = (client: string, spoof = "") => ({ "x-forwarded-for": `${spoof ? `${spoof}, ` : ""}${client}, 10.0.0.2` });
    for (let i = 0; i < 20; i++) {
      const r = await h.app.inject({ url: `${P}/auth/start`, headers: from("198.51.100.7", `203.0.113.${i}`) });
      expect(String(r.headers.location)).toContain("/auth?");
    }
    const limited = await h.app.inject({ url: `${P}/auth/start`, headers: from("198.51.100.7", "192.0.2.1") });
    expect(limited.statusCode).toBe(302);
    expect(limited.headers.location).toBe("/?login_error=auth_failed");
    expect(h.logs.text).toContain("rate_limited");
    // callback и выход — та же политика
    expect((await h.app.inject({ url: `${P}/auth/callback?code=a`, headers: from("198.51.100.7") })).headers.location).toBe("/?login_error=auth_failed");
    const lo = await h.app.inject({ method: "POST", url: `${P}/auth/logout`, headers: { ...from("198.51.100.7"), origin: SITE } });
    expect(lo.statusCode).toBe(429);
    expect(lo.json()).toMatchObject({ code: "RATE_LIMITED", details: { policy: "web.auth_ip" } });
    // другой клиент — свой бакет
    expect(String((await h.app.inject({ url: `${P}/auth/start`, headers: from("198.51.100.8") })).headers.location)).toContain("/auth?");
  });

  it("web.order: 10 команд за 10 минут на аккаунт → 429 RATE_LIMITED", async () => {
    h = await makeWebHarness();
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    const body = { product_code: "plus_30d", provider: "payme", start_mode: "now", offer_version: "v" };
    for (let i = 0; i < 10; i++) {
      const r = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l, { "idempotency-key": randomUUID() }), payload: body });
      expect(r.statusCode).toBe(201);
    }
    const r = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l, { "idempotency-key": randomUUID() }), payload: body });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ code: "RATE_LIMITED", details: { policy: "web.order" } });
    expect(r.headers["retry-after"]).toBeDefined();
    // чтение — своя политика
    expect((await h.app.inject({ url: `${P}/orders`, headers: { cookie: l.cookie } })).statusCode).toBe(200);
  });

  it("адрес клиента: глубина 2 справа; меньше двух адресов или не IP — req.ip", () => {
    const req = (xff: string | undefined) => ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, ip: "10.9.9.9" });
    expect(webClientIp(req("1.1.1.1, 198.51.100.7, 10.0.0.2"))).toBe("198.51.100.7");
    expect(webClientIp(req("198.51.100.7, 10.0.0.2"))).toBe("198.51.100.7");
    expect(webClientIp(req("2001:db8::1, fd12::2"))).toBe("2001:db8::1");
    expect(webClientIp(req("10.0.0.2"))).toBe("10.9.9.9");
    expect(webClientIp(req("evil, 10.0.0.2"))).toBe("10.9.9.9");
    expect(webClientIp(req(undefined))).toBe("10.9.9.9");
  });
});

describe("stage/prod: область только через Caddy web-pay", () => {
  it("Host ≠ домен сайта (прямой запрос к публичному домену telegram-bff) → 404 на всех маршрутах /web/v1", async () => {
    h = await makeWebHarness(
      {},
      {
        config: (c) => ({
          ...c,
          isSecure: true,
          env: "prod",
          internalJwtPrivateKey: Buffer.alloc(32, 9).toString("base64url"),
          webPay: { ...c.webPay, oidcBase: TELEGRAM_OIDC_BASE },
        }),
      },
    );
    for (const [method, url] of [
      ["GET", "/auth/start"],
      ["GET", "/auth/callback?code=a&state=b"],
      ["POST", "/auth/logout"],
      ["GET", "/me"],
      ["GET", "/catalog"],
      ["POST", "/orders"],
    ] as const) {
      const r = await h.app.inject({ method, url: `${P}${url}`, headers: { host: "telegram-bff-production.up.railway.app", origin: SITE, ...XFF } });
      expect(r.statusCode, url).toBe(404);
      expect(r.json()).toMatchObject({ code: "NOT_FOUND" });
    }
    const viaSite = await h.app.inject({ url: `${P}/auth/start`, headers: { host: "pay.tilhero.test", ...XFF } });
    expect(viaSite.statusCode).toBe(302);
    expect(String(viaSite.headers.location)).toMatch(/^https:\/\/oauth\.telegram\.org\/auth\?/);
    expect((await h.app.inject({ url: `${P}/me`, headers: { host: "pay.tilhero.test" } })).statusCode).toBe(401);
  });

  it("TELEGRAM_OIDC_BASE ≠ oauth.telegram.org в stage/prod — приложение не стартует", async () => {
    await expect(
      makeWebHarness({}, { config: (c) => ({ ...c, isSecure: true, internalJwtPrivateKey: Buffer.alloc(32, 9).toString("base64url") }) }),
    ).rejects.toThrow(/TELEGRAM_OIDC_BASE/);
  });
});

describe("флаг и отказ хранилища", () => {
  it("WEB_PAY_ENABLED=false → 404 NOT_FOUND на всех маршрутах сайта", async () => {
    h = await makeWebHarness({ WEB_PAY_ENABLED: "false" });
    for (const [method, url] of [
      ["GET", "/auth/start"],
      ["GET", "/auth/callback"],
      ["POST", "/auth/logout"],
      ["GET", "/me"],
      ["GET", "/catalog"],
      ["GET", "/subscription"],
      ["GET", "/orders"],
      ["GET", "/orders/1"],
      ["POST", "/orders"],
      ["POST", "/orders/1/cancel"],
    ] as const) {
      const r = await h.app.inject({ method, url: `${P}${url}` });
      expect(r.statusCode, url).toBe(404);
      expect(r.json()).toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("Redis недоступен: вход — auth_failed (web.auth_ip fail-closed), сессия — 503 (отзыв не проверить)", async () => {
    const broken = new Redis("redis://127.0.0.1:1/0", { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
    broken.on("error", () => undefined);
    h = await makeWebHarness({}, { redis: broken });
    const r = await h.app.inject({ url: `${P}/auth/start`, headers: XFF });
    expect(r.headers.location).toBe("/?login_error=auth_failed");
    const { SignJWT } = await import("jose");
    const t = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ ath: t })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("telegram-bff")
      .setAudience("web-pay")
      .setSubject(randomUUID())
      .setJti("0123456789abcdef0123456789abcdef")
      .setIssuedAt(t)
      .setExpirationTime(t + 600)
      .sign(new TextEncoder().encode(h.config.webPay.sessionSecret));
    const me = await h.app.inject({ url: `${P}/me`, headers: { cookie: `__Host-wp_session=${token}` } });
    expect(me.statusCode).toBe(503);
    broken.disconnect();
  });
});
