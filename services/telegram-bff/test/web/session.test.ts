/**
 * Сайт оплаты: cookie-сессия `__Host-wp_session` (подпись, 30 мин скользящая, ≤ 2 ч, отзыв при выходе), CSRF-токен и
 * Origin у изменяющих запросов (INTERNAL_API §3, AT-86).
 */
import { SignJWT } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeRedis, testRedis } from "../helpers.js";
import { P, SITE, WEB_SESSION_SECRET, login, makeWebHarness, setCookies, writeHeaders, type WebHarness } from "./harness.js";

let h: WebHarness;
beforeEach(async () => {
  h = await makeWebHarness();
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const key = new TextEncoder().encode(WEB_SESSION_SECRET);
async function craft(o: { sub: string; iat: number; exp: number; ath: number; jti?: string; secret?: Uint8Array; aud?: string }) {
  return new SignJWT({ ath: o.ath })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("telegram-bff")
    .setAudience(o.aud ?? "web-pay")
    .setSubject(o.sub)
    .setJti(o.jti ?? "0123456789abcdef0123456789abcdef")
    .setIssuedAt(o.iat)
    .setExpirationTime(o.exp)
    .sign(o.secret ?? key);
}
const now = () => Math.floor(Date.now() / 1000);
const order = { product_code: "plus_30d", provider: "payme", start_mode: "after_current", offer_version: "2026-11-22" };

describe("сессия", () => {
  it("нет cookie → 401 SESSION_EXPIRED на всех маршрутах с сессией", async () => {
    for (const url of ["/me", "/catalog", "/subscription", "/orders", "/orders/1001"]) {
      const r = await h.app.inject({ url: `${P}${url}` });
      expect(r.statusCode, url).toBe(401);
      expect(r.json()).toMatchObject({ code: "SESSION_EXPIRED" });
    }
    expect(h.fake.calls).toEqual([]);
  });

  it("подделанная, просроченная, старше 2 ч, чужой aud, мусор → 401, cookie удаляется", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const t = now();
    const bad = [
      await craft({ sub: acc.accountId, iat: t, exp: t + 1800, ath: t, secret: new TextEncoder().encode("x".repeat(48)) }),
      await craft({ sub: acc.accountId, iat: t - 3600, exp: t - 60, ath: t - 3600 }),
      await craft({ sub: acc.accountId, iat: t - 60, exp: t + 600, ath: t - 7300 }),
      await craft({ sub: acc.accountId, iat: t, exp: t + 1800, ath: t, aud: "telegram-miniapp" }),
      await craft({ sub: "not-a-uuid", iat: t, exp: t + 1800, ath: t }),
      "garbage.token.value",
    ];
    for (const token of bad) {
      const r = await h.app.inject({ url: `${P}/me`, headers: { cookie: `__Host-wp_session=${token}` } });
      expect(r.statusCode).toBe(401);
      expect(setCookies(r).get("__Host-wp_session")?.raw).toContain("Max-Age=0");
    }
  });

  it("токен Mini App (SESSION_JWT_SECRET) сессией сайта не является", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const t = now();
    const miniapp = await craft({ sub: acc.accountId, iat: t, exp: t + 600, ath: t, secret: new TextEncoder().encode(h.config.sessionJwtSecret) });
    expect((await h.app.inject({ url: `${P}/me`, headers: { cookie: `__Host-wp_session=${miniapp}` } })).statusCode).toBe(401);
  });

  it("скользящий срок: старая cookie продлевается (тот же jti), но не дальше 2 ч от входа", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const t = now();
    const token = await craft({ sub: acc.accountId, iat: t - 600, exp: t + 1200, ath: t - 600 });
    const r = await h.app.inject({ url: `${P}/me`, headers: { cookie: `__Host-wp_session=${token}` } });
    expect(r.statusCode).toBe(200);
    const renewed = setCookies(r).get("__Host-wp_session")!;
    expect(renewed.raw).toContain("SameSite=Strict");
    const p = JSON.parse(Buffer.from(renewed.value.split(".")[1]!, "base64url").toString()) as Record<string, number | string>;
    expect(p.jti).toBe("0123456789abcdef0123456789abcdef");
    expect(p.ath).toBe(t - 600);
    expect(Number(p.exp)).toBeGreaterThanOrEqual(t + 1790);

    // близко к 2 ч: exp упирается в абсолютный предел
    const late = await craft({ sub: acc.accountId, iat: t - 600, exp: t + 150, ath: t - 7000 });
    const r2 = await h.app.inject({ url: `${P}/me`, headers: { cookie: `__Host-wp_session=${late}` } });
    expect(r2.statusCode).toBe(200);
    const p2 = JSON.parse(Buffer.from(setCookies(r2).get("__Host-wp_session")!.value.split(".")[1]!, "base64url").toString()) as Record<string, number>;
    expect(p2.exp).toBe(t - 7000 + 7200);
    // свежая cookie не переписывается на каждый запрос
    const fresh = await login(h, acc);
    const r3 = await h.app.inject({ url: `${P}/me`, headers: { cookie: fresh.cookie } });
    expect(setCookies(r3).has("__Host-wp_session")).toBe(false);
  });

  it("GET /me: CSRF-токен привязан к сессии; профиль без ПДн Telegram; дети — для выбора получателя тилов", async () => {
    const acc = h.fake.addAccount({
      telegramId: 1,
      children: [{ learner_id: "7f2c1d1e-0000-4000-8000-000000000001", display_name: "Малыш", age_band: "6-9" }],
    });
    const a = await login(h, acc);
    const b = await login(h, acc);
    expect(a.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.csrf).not.toBe(b.csrf);
    const me = (await h.app.inject({ url: `${P}/me`, headers: { cookie: a.cookie } })).json();
    expect(me).toEqual({
      account: { age_band: "18+", can_pay: true, consent_required: false },
      learners: [
        { learner_id: acc.accountId, kind: "self", display: "Игорь" },
        { learner_id: "7f2c1d1e-0000-4000-8000-000000000001", kind: "child", display: "Малыш" },
      ],
      csrf_token: a.csrf,
    });
    expect(JSON.stringify(me)).not.toContain("secret_tg_username");
  });

  it("аккаунт удалили (identity 404) или он удаляется → сессия отозвана, 401", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    acc.status = "DELETION_REQUESTED";
    expect((await h.app.inject({ url: `${P}/me`, headers: { cookie: l.cookie } })).statusCode).toBe(401);
    acc.status = "ACTIVE";
    // отозвана: даже вернувшийся статус не возвращает сессию
    expect((await h.app.inject({ url: `${P}/catalog`, headers: { cookie: l.cookie } })).statusCode).toBe(401);

    // cookie продлевалась в том же запросе, но аккаунт удалён — в ответе только удаление cookie
    const gone = h.fake.addAccount({ telegramId: 3 });
    const t = now();
    const old = await craft({ sub: gone.accountId, iat: t - 600, exp: t + 1200, ath: t - 600, jti: "fedcba9876543210fedcba9876543210" });
    gone.status = "DELETION_REQUESTED";
    const r = await h.app.inject({ url: `${P}/me`, headers: { cookie: `__Host-wp_session=${old}` } });
    expect(r.statusCode).toBe(401);
    const c = setCookies(r);
    expect([...c.keys()]).toEqual(["__Host-wp_session"]);
    expect(c.get("__Host-wp_session")!.value).toBe("");
    expect(c.get("__Host-wp_session")!.raw).toContain("Max-Age=0");
  });
});

describe("выход", () => {
  it("POST /auth/logout → 204, jti в списке отзыва, cookie удалены; старая cookie больше не действует", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    const r = await h.app.inject({ method: "POST", url: `${P}/auth/logout`, headers: writeHeaders(l) });
    expect(r.statusCode).toBe(204);
    const c = setCookies(r);
    expect(c.get("__Host-wp_session")!.raw).toContain("Max-Age=0");
    expect(c.get("__Host-wp_oidc")!.raw).toContain("Max-Age=0");
    const p = JSON.parse(Buffer.from(l.sessionToken.split(".")[1]!, "base64url").toString()) as { jti: string };
    const ttl = await testRedis().ttl(`${h.config.redisKeyPrefix}web:revoked:${p.jti}`);
    expect(ttl).toBeGreaterThan(7000);
    expect((await h.app.inject({ url: `${P}/me`, headers: { cookie: l.cookie } })).statusCode).toBe(401);
    // повтор выхода — 204 (сессии уже нет)
    expect((await h.app.inject({ method: "POST", url: `${P}/auth/logout`, headers: writeHeaders(l) })).statusCode).toBe(204);
  });

  it("выход без CSRF или с чужим Origin → 403, сессия жива", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const l = await login(h, acc);
    const noCsrf = await h.app.inject({ method: "POST", url: `${P}/auth/logout`, headers: { cookie: l.cookie, origin: SITE } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ code: "CSRF_INVALID" });
    const evil = await h.app.inject({ method: "POST", url: `${P}/auth/logout`, headers: writeHeaders(l, { origin: "https://evil.example" }) });
    expect(evil.statusCode).toBe(403);
    expect((await h.app.inject({ url: `${P}/me`, headers: { cookie: l.cookie } })).statusCode).toBe(200);
  });
});

describe("CSRF и Origin у изменяющих запросов", () => {
  it("POST /orders: без X-CSRF-Token, с чужим токеном, без Origin, с чужим Origin → 403 CSRF_INVALID; billing не вызывается", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const other = h.fake.addAccount({ telegramId: 2 });
    const l = await login(h, acc);
    const o = await login(h, other);
    const cases: Array<Record<string, string>> = [
      { cookie: l.cookie, origin: SITE },
      { cookie: l.cookie, origin: SITE, "x-csrf-token": o.csrf },
      { cookie: l.cookie, origin: SITE, "x-csrf-token": "x".repeat(43) },
      { cookie: l.cookie, "x-csrf-token": l.csrf },
      { cookie: l.cookie, origin: "https://evil.example", "x-csrf-token": l.csrf },
      { cookie: l.cookie, origin: "https://miniapp.tilhero.test", "x-csrf-token": l.csrf },
      { cookie: l.cookie, origin: "null", "x-csrf-token": l.csrf },
    ];
    for (const headers of cases) {
      const r = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: { ...headers, "idempotency-key": crypto.randomUUID() }, payload: order });
      expect(r.statusCode, JSON.stringify(Object.keys(headers))).toBe(403);
      expect(r.json()).toMatchObject({ code: "CSRF_INVALID" });
    }
    const cancel = await h.app.inject({ method: "POST", url: `${P}/orders/1001/cancel`, headers: { cookie: l.cookie, origin: SITE } });
    expect(cancel.statusCode).toBe(403);
    expect(h.fake.billingCalls()).toEqual([]);

    const ok = await h.app.inject({ method: "POST", url: `${P}/orders`, headers: writeHeaders(l, { "idempotency-key": crypto.randomUUID() }), payload: order });
    expect(ok.statusCode).toBe(201);
  });

  it("CSRF-токен не меняется при продлении cookie (привязан к jti)", async () => {
    const acc = h.fake.addAccount({ telegramId: 1 });
    const t = now();
    const token = await craft({ sub: acc.accountId, iat: t - 600, exp: t + 1200, ath: t - 600 });
    const r1 = await h.app.inject({ url: `${P}/me`, headers: { cookie: `__Host-wp_session=${token}` } });
    const renewed = setCookies(r1).get("__Host-wp_session")!.value;
    const r2 = await h.app.inject({ url: `${P}/me`, headers: { cookie: `__Host-wp_session=${renewed}` } });
    expect(r2.json().csrf_token).toBe(r1.json().csrf_token);
  });
});
