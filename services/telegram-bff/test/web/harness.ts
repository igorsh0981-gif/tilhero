/**
 * Обвязка тестов сайта оплаты (/web/v1): приложение с WEB_PAY_ENABLED=true, мок OIDC Telegram (HTTP на 127.0.0.1,
 * TELEGRAM_OIDC_BASE — подмена разрешена только в dev/test), подделки identity-consent и billing, реальный Redis
 * (DB 14, свой префикс ключей). Значения секретов — заведомо тестовые.
 */
import type { LightMyRequestResponse } from "fastify";
import type { Redis } from "ioredis";
import { buildApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import type { App } from "../../src/http.js";
import { LogCapture, testConfig, testRedis } from "../helpers.js";
import { BILLING_ORIGIN, FakeWebDomains, IDENTITY_ORIGIN, type FakeAccount } from "./fakes.js";
import { CLIENT_ID, CLIENT_SECRET, MockOidc } from "./mockOidc.js";

export const SITE = "https://pay.tilhero.test";
// заведомо тестовое значение (не секрет)
export const WEB_SESSION_SECRET = "test-web-session-secret-" + "w".repeat(32);
export const P = "/web/v1";
/** Адрес клиента, как его видит telegram-bff за Railway edge и Caddy web-pay: «клиент, edge». */
export const XFF = { "x-forwarded-for": "198.51.100.23, 10.0.0.2" };

export interface WebHarness {
  app: App;
  oidc: MockOidc;
  fake: FakeWebDomains;
  logs: LogCapture;
  config: Config;
  close(): Promise<void>;
}

export async function makeWebHarness(
  env: Record<string, string> = {},
  o: { config?: (c: Config) => Config; redis?: Redis } = {},
): Promise<WebHarness> {
  const oidc = await new MockOidc().start();
  let config = testConfig({
    WEB_PAY_ENABLED: "true",
    WEB_PAY_ORIGIN: SITE,
    TELEGRAM_LOGIN_CLIENT_ID: CLIENT_ID,
    TELEGRAM_LOGIN_CLIENT_SECRET: CLIENT_SECRET,
    WEB_SESSION_SECRET,
    TELEGRAM_OIDC_BASE: oidc.base,
    BILLING_URL: BILLING_ORIGIN,
    IDENTITY_URL: IDENTITY_ORIGIN,
    ...env,
  });
  if (o.config) config = o.config(config);
  const fake = new FakeWebDomains();
  const logs = new LogCapture();
  const redis = testRedis();
  let app: App;
  try {
    app = await buildApp(config, { redis: o.redis ?? redis, fetchImpl: fake.fetch, logStream: logs });
    await app.ready();
  } catch (err) {
    await oidc.close();
    throw err;
  }
  return {
    app,
    oidc,
    fake,
    logs,
    config,
    async close() {
      await app.close();
      await oidc.close();
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, "MATCH", `${config.redisKeyPrefix}*`, "COUNT", 500);
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== "0");
    },
  };
}

/** Set-Cookie ответа: имя → {value, attrs (строка целиком)}. */
export function setCookies(res: LightMyRequestResponse): Map<string, { value: string; raw: string }> {
  const raw = res.headers["set-cookie"];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
  const out = new Map<string, { value: string; raw: string }>();
  for (const c of list) {
    const first = c.split(";")[0] ?? "";
    const i = first.indexOf("=");
    out.set(first.slice(0, i), { value: first.slice(i + 1), raw: c });
  }
  return out;
}

export interface WebLogin {
  account: FakeAccount;
  /** заголовок Cookie с сессией */
  cookie: string;
  sessionToken: string;
  csrf: string;
  callback: LightMyRequestResponse;
}

/** Начало входа: 302 на /auth мока + cookie попытки. */
export async function startLogin(h: WebHarness, headers: Record<string, string> = XFF) {
  const res = await h.app.inject({ url: `${P}/auth/start`, headers });
  const flow = setCookies(res).get("__Host-wp_oidc")?.value ?? "";
  return { res, location: String(res.headers.location ?? ""), flow };
}

/** Путь callback сайта (/api/…) → путь telegram-bff (/web/v1/…), как Caddy web-pay. */
export const viaCaddy = (sitePath: string) => sitePath.replace(/^\/api\//, `${P}/`);

/** Полный вход: start → «пользователь подтвердил» в моке → callback → сессия → GET /me (CSRF). */
export async function login(h: WebHarness, account: FakeAccount): Promise<WebLogin> {
  const s = await startLogin(h);
  const { callbackPath } = h.oidc.approve(s.location, account.telegramId);
  const callback = await h.app.inject({ url: viaCaddy(callbackPath), headers: { ...XFF, cookie: `__Host-wp_oidc=${s.flow}` } });
  const sessionToken = setCookies(callback).get("__Host-wp_session")?.value ?? "";
  if (!sessionToken) throw new Error(`login failed: ${String(callback.headers.location)}`);
  const cookie = `__Host-wp_session=${sessionToken}`;
  const me = await h.app.inject({ url: `${P}/me`, headers: { cookie } });
  return { account, cookie, sessionToken, csrf: (me.json() as { csrf_token: string }).csrf_token, callback };
}

/** Заголовки изменяющего запроса сайта: cookie, Origin, CSRF. */
export const writeHeaders = (l: WebLogin, extra: Record<string, string> = {}) => ({
  cookie: l.cookie,
  origin: SITE,
  "x-csrf-token": l.csrf,
  ...extra,
});
