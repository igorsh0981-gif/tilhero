/**
 * TelegramOidc (src/web/oidc.ts) отдельно от маршрутов: кеш JWKS и ротация ключей, неизвестный kid, PKCE, таймаут
 * обмена кода, разбор claim `id`, причины отказа без значений токенов.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OIDC_SCOPE, OidcFailure, TelegramOidc, newPkce, safeEqual, telegramIdOf } from "../../src/web/oidc.js";
import { CLIENT_ID, CLIENT_SECRET, MockOidc } from "./mockOidc.js";

const REDIRECT = "https://pay.tilhero.test/api/auth/callback";
let mock: MockOidc;
beforeEach(async () => {
  mock = await new MockOidc().start();
});
afterEach(async () => {
  await mock.close();
});

const client = (o: Partial<ConstructorParameters<typeof TelegramOidc>[0]> = {}) =>
  new TelegramOidc({ base: mock.base, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, ...o });

async function codeFor(c: TelegramOidc, telegramId: number) {
  const p = newPkce();
  const { code } = mock.approve(c.authorizeUrl(p.state, p.challenge), telegramId);
  return { code, verifier: p.verifier };
}

describe("TelegramOidc", () => {
  it("PKCE: verifier 64 символа base64url, challenge = S256(verifier), state 256 бит", () => {
    const p = newPkce();
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(p.challenge).toBe(createHash("sha256").update(p.verifier).digest("base64url"));
    expect(p.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.flowId).toBe(createHash("sha256").update(p.state).digest("base64url"));
    expect(OIDC_SCOPE).toBe("openid profile");
  });

  it("вход: Telegram ID из claim id", async () => {
    const c = client();
    const { code, verifier } = await codeFor(c, 900042);
    expect(await c.login(code, verifier)).toBe(900042);
  });

  it("ротация ключей: новый kid после кулдауна — JWKS перезагружается; в кулдауне — отказ без лавины запросов", async () => {
    const c = client({ jwksCooldownMs: 0 });
    let x = await codeFor(c, 1);
    await c.login(x.code, x.verifier);
    expect(mock.jwksCalls).toBe(1);
    await mock.rotate("ES256");
    x = await codeFor(c, 2);
    expect(await c.login(x.code, x.verifier)).toBe(2);
    expect(mock.jwksCalls).toBe(2);

    const slow = client({ jwksCooldownMs: 60_000 });
    x = await codeFor(slow, 3);
    await slow.login(x.code, x.verifier);
    const before = mock.jwksCalls;
    for (let i = 0; i < 3; i++) {
      const forged = await mock.sign(mock.claimsFor(4), { kid: `bogus-${i}` });
      await expect(slow.verify(forged)).rejects.toMatchObject({ reason: "id_token_unknown_kid" });
    }
    expect(mock.jwksCalls - before).toBeLessThanOrEqual(1);
  });

  it("кеш JWKS истёк (1 ч) — ключи загружаются заново", async () => {
    const c = client({ jwksCacheMs: 1, jwksCooldownMs: 0 });
    let x = await codeFor(c, 1);
    await c.login(x.code, x.verifier);
    await new Promise((r) => setTimeout(r, 5));
    x = await codeFor(c, 1);
    await c.login(x.code, x.verifier);
    expect(mock.jwksCalls).toBe(2);
  });

  it("обмен кода: таймаут → token_unreachable; повтор кода → token_http_400", async () => {
    const c = client({ timeoutMs: 300 });
    const x = await codeFor(c, 1);
    await c.login(x.code, x.verifier);
    await expect(c.login(x.code, x.verifier)).rejects.toMatchObject({ reason: "token_http_400" });
    mock.tokenMode = "hang";
    const y = await codeFor(c, 1);
    await expect(c.login(y.code, y.verifier)).rejects.toMatchObject({ reason: "token_unreachable" });
  });

  it("неверный секрет клиента → token_http_401; причина ошибки не содержит значений", async () => {
    const c = client({ clientSecret: "wrong-secret-value-000000" });
    const x = await codeFor(c, 1);
    const err = (await c.login(x.code, x.verifier).catch((e: unknown) => e)) as OidcFailure;
    expect(err).toBeInstanceOf(OidcFailure);
    expect(err.reason).toBe("token_http_401");
    for (const secret of [x.code, x.verifier, CLIENT_SECRET, "wrong-secret-value-000000"]) expect(err.message).not.toContain(secret);
  });

  it("claim id: число или строка цифр; иначе отказ", () => {
    expect(telegramIdOf({ id: 123 })).toBe(123);
    expect(telegramIdOf({ id: "987654321" })).toBe(987654321);
    for (const bad of [0, -1, 1.5, "12a", "", null, undefined, 2 ** 60, "0123"]) {
      expect(() => telegramIdOf({ id: bad } as never)).toThrow(OidcFailure);
    }
  });

  it("safeEqual — постоянное время, разная длина — false", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
