/**
 * Сайт оплаты, вход «Log In with Telegram» (OIDC + PKCE S256, INTERNAL_API §3, AT-86): адрес авторизации, обмен кода с
 * Basic client_id:client_secret, проверка id_token по JWKS (подпись, iss, aud, exp, кеш ключей), одноразовый state,
 * привязка к cookie, вход только существующего аккаунта (дети не входят), адрес после входа очищен.
 */
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeRedis, testRedis } from "../helpers.js";
import { CLIENT_ID, CLIENT_SECRET } from "./mockOidc.js";
import { P, SITE, XFF, login, makeWebHarness, setCookies, startLogin, viaCaddy, type WebHarness } from "./harness.js";

let h: WebHarness;
beforeEach(async () => {
  h = await makeWebHarness();
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

/** Вход до callback с подменой id_token; → ответ callback. */
async function callbackWith(forge: ((claims: Record<string, unknown>) => Promise<string>) | null, telegramId = 900001) {
  h.fake.addAccount({ telegramId });
  h.oidc.forge = forge;
  const s = await startLogin(h);
  const { callbackPath } = h.oidc.approve(s.location, telegramId);
  return h.app.inject({ url: viaCaddy(callbackPath), headers: { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` } });
}

const loginError = (res: { statusCode: number; headers: Record<string, unknown> }) => {
  expect(res.statusCode).toBe(302);
  const loc = String(res.headers.location);
  const m = /^\/\?login_error=(auth_failed|account_not_found|not_allowed)$/.exec(loc);
  expect(m, loc).not.toBeNull();
  return m![1];
};

describe("GET /web/v1/auth/start", () => {
  it("302 на {oidcBase}/auth: client_id, redirect_uri сайта, code, scope, state, PKCE S256; cookie попытки; Redis 10 мин", async () => {
    const s = await startLogin(h);
    expect(s.res.statusCode).toBe(302);
    const u = new URL(s.location);
    expect(`${u.origin}${u.pathname}`).toBe(`${h.oidc.base}/auth`);
    const q = Object.fromEntries(u.searchParams);
    expect(Object.keys(q).sort()).toEqual(
      ["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"].sort(),
    );
    expect(q).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: `${SITE}/api/auth/callback`,
      response_type: "code",
      code_challenge_method: "S256",
    });
    // scope: openid + profile (claim id — только с profile; телефон не запрашивается)
    expect(q.scope!.split(" ").sort()).toEqual(["openid", "profile"]);
    expect(q.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // cookie: хеш state, HttpOnly, Secure, SameSite=Lax, Path=/, без Domain, 10 мин
    const c = setCookies(s.res).get("__Host-wp_oidc")!;
    expect(c.value).toBe(createHash("sha256").update(q.state!).digest("base64url"));
    expect(c.raw).toMatch(/; Path=\/;/);
    expect(c.raw).toContain("HttpOnly");
    expect(c.raw).toContain("Secure");
    expect(c.raw).toContain("SameSite=Lax");
    expect(c.raw).toContain("Max-Age=600");
    expect(c.raw).not.toMatch(/domain=/i);

    // Redis: ключ — хеш state (не сам state), code_verifier ↔ code_challenge, срок ≤ 10 мин
    const key = `${h.config.redisKeyPrefix}web:oidc:${c.value}`;
    const stored = JSON.parse((await testRedis().get(key))!) as { v: string };
    expect(createHash("sha256").update(stored.v).digest("base64url")).toBe(q.code_challenge);
    expect(stored.v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const ttl = await testRedis().ttl(key);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
    const keys = await testRedis().keys(`${h.config.redisKeyPrefix}*${q.state}*`);
    expect(keys).toEqual([]);
  });

  it("каждый старт — новые state и verifier", async () => {
    const a = new URL((await startLogin(h)).location).searchParams;
    const b = new URL((await startLogin(h)).location).searchParams;
    expect(a.get("state")).not.toBe(b.get("state"));
    expect(a.get("code_challenge")).not.toBe(b.get("code_challenge"));
  });
});

describe("GET /web/v1/auth/callback — успех", () => {
  it("code → token (Basic, PKCE) → id_token по JWKS → аккаунт → cookie сессии, 302 на / (адрес очищен)", async () => {
    const acc = h.fake.addAccount({ telegramId: 900001 });
    const l = await login(h, acc);
    expect(l.callback.statusCode).toBe(302);
    expect(l.callback.headers.location).toBe("/");

    // обмен кода: Basic client_id:client_secret, форма с code_verifier и redirect_uri
    expect(h.oidc.tokenCalls).toHaveLength(1);
    const t = h.oidc.tokenCalls[0]!;
    expect(t.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(t.contentType).toContain("application/x-www-form-urlencoded");
    expect(t.form).toMatchObject({ grant_type: "authorization_code", client_id: CLIENT_ID, redirect_uri: `${SITE}/api/auth/callback` });
    expect(t.form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(Object.keys(t.form)).not.toContain("client_secret");

    // identity: служебный вызов без sub (Telegram ID — только в пути внутреннего вызова)
    const idCall = h.fake.calls.find((c) => c.path === "/internal/v1/telegram-users/900001/account")!;
    expect(idCall.subject).toBeUndefined();
    expect(idCall.claims.iss).toBe("telegram-bff");

    // cookie: сессия __Host-, HttpOnly, Secure, SameSite=Strict, Path=/, 30 мин; cookie попытки удалена
    const cookies = setCookies(l.callback);
    const s = cookies.get("__Host-wp_session")!;
    expect(s.raw).toMatch(/; Path=\/;/);
    expect(s.raw).toContain("HttpOnly");
    expect(s.raw).toContain("Secure");
    expect(s.raw).toContain("SameSite=Strict");
    expect(s.raw).toContain("Max-Age=1800");
    expect(s.raw).not.toMatch(/domain=/i);
    expect(cookies.get("__Host-wp_oidc")!.raw).toContain("Max-Age=0");

    // в сессии нет Telegram ID и id_token: только sub = аккаунт, jti, сроки
    const payload = JSON.parse(Buffer.from(l.sessionToken.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["ath", "aud", "exp", "iat", "iss", "jti", "sub"]);
    expect(payload.sub).toBe(acc.accountId);
    expect(JSON.stringify(payload)).not.toContain("900001");

    const me = await h.app.inject({ url: `${P}/me`, headers: { cookie: l.cookie } });
    expect(me.statusCode).toBe(200);
  });

  it("JWKS кешируется: два входа — одна загрузка ключей (ротация kid — test/web/oidcClient.test.ts)", async () => {
    const a = h.fake.addAccount({ telegramId: 900001 });
    await login(h, a);
    await login(h, a);
    expect(h.oidc.jwksCalls).toBe(1);
  });

  it("state в redirect не вернулся (§14 L1) — вход держат cookie, одноразовая запись и PKCE", async () => {
    h.oidc.returnState = false;
    const acc = h.fake.addAccount({ telegramId: 900001 });
    const l = await login(h, acc);
    expect(l.callback.headers.location).toBe("/");
  });

  it("аккаунт DISABLED (TilHero выключен учеником) входит", async () => {
    const acc = h.fake.addAccount({ telegramId: 900001, status: "DISABLED" });
    expect((await login(h, acc)).callback.headers.location).toBe("/");
  });
});

describe("GET /web/v1/auth/callback — подделанный id_token", () => {
  it("чужая подпись (ключ не из JWKS, тот же kid) → auth_failed, сессии нет", async () => {
    const foreign = await h.oidc.foreignKey();
    const res = await callbackWith((c) => h.oidc.sign(c, { key: foreign }));
    expect(loginError(res)).toBe("auth_failed");
    expect(setCookies(res).has("__Host-wp_session")).toBe(false);
    expect(h.logs.text).toContain("id_token_signature");
  });

  it("aud — другой бот → auth_failed", async () => {
    const res = await callbackWith((c) => h.oidc.sign({ ...c, aud: "7000000002" }));
    expect(loginError(res)).toBe("auth_failed");
    expect(h.logs.text).toContain("id_token_claim_aud");
  });

  it("просрочен → auth_failed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await callbackWith((c) => h.oidc.sign({ ...c, iat: now - 7200, exp: now - 3600 }));
    expect(loginError(res)).toBe("auth_failed");
    expect(h.logs.text).toContain("id_token_expired");
  });

  it("iss — не Telegram → auth_failed", async () => {
    const res = await callbackWith((c) => h.oidc.sign({ ...c, iss: "https://evil.example" }));
    expect(loginError(res)).toBe("auth_failed");
    expect(h.logs.text).toContain("id_token_claim_iss");
  });

  it("alg none и HS256 (секрет клиента как ключ) → auth_failed", async () => {
    const none = async (c: Record<string, unknown>) =>
      `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(c)).toString("base64url")}.`;
    expect(loginError(await callbackWith(none))).toBe("auth_failed");
    await h.close();
    h = await makeWebHarness();
    const hs = (c: Record<string, unknown>) =>
      new SignJWT(c).setProtectedHeader({ alg: "HS256", kid: h.oidc.signingKey.kid }).sign(new TextEncoder().encode(CLIENT_SECRET));
    expect(loginError(await callbackWith(hs))).toBe("auth_failed");
    expect(h.logs.text).toContain("id_token_alg");
  });

  it("нет claim id (scope без profile) → auth_failed", async () => {
    const res = await callbackWith((c) => {
      const { id: _id, ...rest } = c;
      return h.oidc.sign(rest);
    });
    expect(loginError(res)).toBe("auth_failed");
    expect(h.logs.text).toContain("id_token_no_telegram_id");
  });

  it("неизвестный kid → перезагрузка JWKS, ключа нет → auth_failed", async () => {
    const res = await callbackWith((c) => h.oidc.sign(c, { kid: "unknown-kid" }));
    expect(loginError(res)).toBe("auth_failed");
  });
});

describe("GET /web/v1/auth/callback — state и cookie", () => {
  it("повтор того же возврата (state и code) → auth_failed: попытка одноразовая", async () => {
    const acc = h.fake.addAccount({ telegramId: 900001 });
    const s = await startLogin(h);
    const { callbackPath } = h.oidc.approve(s.location, acc.telegramId);
    const headers = { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` };
    const first = await h.app.inject({ url: viaCaddy(callbackPath), headers });
    expect(first.headers.location).toBe("/");
    const again = await h.app.inject({ url: viaCaddy(callbackPath), headers });
    expect(loginError(again)).toBe("auth_failed");
    expect(setCookies(again).has("__Host-wp_session")).toBe(false);
    expect(h.oidc.tokenCalls).toHaveLength(1);
  });

  it("нет cookie попытки → auth_failed, код не обменивается", async () => {
    const acc = h.fake.addAccount({ telegramId: 900001 });
    const s = await startLogin(h);
    const { callbackPath } = h.oidc.approve(s.location, acc.telegramId);
    const res = await h.app.inject({ url: viaCaddy(callbackPath), headers: XFF });
    expect(loginError(res)).toBe("auth_failed");
    expect(h.oidc.tokenCalls).toHaveLength(0);
  });

  it("state не от этой cookie (вход начат в другом браузере) → auth_failed, попытка сожжена", async () => {
    const acc = h.fake.addAccount({ telegramId: 900001 });
    const mine = await startLogin(h);
    const other = await startLogin(h);
    const { callbackPath } = h.oidc.approve(other.location, acc.telegramId);
    const res = await h.app.inject({ url: viaCaddy(callbackPath), headers: { ...XFF, cookie: `__Host-wp_oidc=${mine.flow}` } });
    expect(loginError(res)).toBe("auth_failed");
    expect(h.oidc.tokenCalls).toHaveLength(0);
    expect(await testRedis().exists(`${h.config.redisKeyPrefix}web:oidc:${mine.flow}`)).toBe(0);
  });

  it("код подменён (чужой code, своя cookie и state) → PKCE не сходится → auth_failed", async () => {
    const acc = h.fake.addAccount({ telegramId: 900001 });
    const victim = await startLogin(h);
    const attacker = await startLogin(h);
    const attackerCode = h.oidc.approve(attacker.location, acc.telegramId).code;
    const victimState = new URL(victim.location).searchParams.get("state")!;
    const res = await h.app.inject({
      url: `${P}/auth/callback?code=${encodeURIComponent(attackerCode)}&state=${victimState}`,
      headers: { ...XFF, cookie: `__Host-wp_oidc=${victim.flow}` },
    });
    expect(loginError(res)).toBe("auth_failed");
    expect(h.logs.text).toContain("token_http_400");
  });

  it("попытка истекла (запись Redis удалена по сроку) → auth_failed", async () => {
    const acc = h.fake.addAccount({ telegramId: 900001 });
    const s = await startLogin(h);
    await testRedis().del(`${h.config.redisKeyPrefix}web:oidc:${s.flow}`);
    const { callbackPath } = h.oidc.approve(s.location, acc.telegramId);
    const res = await h.app.inject({ url: viaCaddy(callbackPath), headers: { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` } });
    expect(loginError(res)).toBe("auth_failed");
  });

  it("пользователь отказался (?error=access_denied) → auth_failed", async () => {
    const s = await startLogin(h);
    const state = new URL(s.location).searchParams.get("state")!;
    const res = await h.app.inject({ url: `${P}/auth/callback?error=access_denied&state=${state}`, headers: { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` } });
    expect(loginError(res)).toBe("auth_failed");
  });

  it("нет code, повтор параметров массивом → auth_failed (не 422 JSON)", async () => {
    const s = await startLogin(h);
    const state = new URL(s.location).searchParams.get("state")!;
    const r1 = await h.app.inject({ url: `${P}/auth/callback?state=${state}`, headers: { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` } });
    expect(loginError(r1)).toBe("auth_failed");
    const s2 = await startLogin(h);
    const st2 = new URL(s2.location).searchParams.get("state")!;
    const r2 = await h.app.inject({ url: `${P}/auth/callback?code=a&code=b&state=${st2}`, headers: { ...XFF, cookie: `__Host-wp_oidc=${s2.flow}` } });
    expect(loginError(r2)).toBe("auth_failed");
  });
});

describe("GET /web/v1/auth/callback — аккаунт TilHero", () => {
  it("нет аккаунта → account_not_found, аккаунт не создаётся", async () => {
    const s = await startLogin(h);
    const { callbackPath } = h.oidc.approve(s.location, 900777);
    const res = await h.app.inject({ url: viaCaddy(callbackPath), headers: { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` } });
    expect(loginError(res)).toBe("account_not_found");
    expect(setCookies(res).has("__Host-wp_session")).toBe(false);
    expect(h.fake.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("профиль удаляется → not_allowed", async () => {
    h.fake.addAccount({ telegramId: 900002, status: "DELETION_REQUESTED" });
    const s = await startLogin(h);
    const { callbackPath } = h.oidc.approve(s.location, 900002);
    const res = await h.app.inject({ url: viaCaddy(callbackPath), headers: { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` } });
    expect(loginError(res)).toBe("not_allowed");
  });

  it("ребёнок (возраст 6–13 у аккаунта) не входит → not_allowed", async () => {
    h.fake.addAccount({ telegramId: 900003, ageBand: "10-13" });
    const s = await startLogin(h);
    const { callbackPath } = h.oidc.approve(s.location, 900003);
    const res = await h.app.inject({ url: viaCaddy(callbackPath), headers: { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` } });
    expect(loginError(res)).toBe("not_allowed");
  });

  it("identity-consent недоступен → auth_failed (понятная ошибка), сессии нет", async () => {
    h.fake.addAccount({ telegramId: 900001 });
    h.fake.down.add("identity");
    const s = await startLogin(h);
    const { callbackPath } = h.oidc.approve(s.location, 900001);
    const res = await h.app.inject({ url: viaCaddy(callbackPath), headers: { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` } });
    expect(loginError(res)).toBe("auth_failed");
    expect(setCookies(res).has("__Host-wp_session")).toBe(false);
  });
});

describe("GET /web/v1/auth/callback — oauth.telegram.org недоступен или ответил ошибкой", () => {
  for (const mode of ["http_400", "http_500", "no_id_token", "not_json"] as const) {
    it(`token: ${mode} → auth_failed`, async () => {
      h.oidc.tokenMode = mode;
      expect(loginError(await callbackWith(null))).toBe("auth_failed");
    });
  }

  it("JWKS недоступен (Telegram лежит) → auth_failed", async () => {
    await h.oidc.close();
    // мок закрыт целиком: и /token, и JWKS недоступны
    h.fake.addAccount({ telegramId: 900001 });
    const s = await startLogin(h);
    const { callbackPath } = h.oidc.approve(s.location, 900001);
    const res = await h.app.inject({ url: viaCaddy(callbackPath), headers: { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` } });
    expect(loginError(res)).toBe("auth_failed");
    expect(h.logs.text).toContain("token_unreachable");
  });
});
