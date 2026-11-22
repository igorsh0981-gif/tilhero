/**
 * Спринт 8, поток 0: ключи конфигурации billing и сайта оплаты (INTERNAL_API §13, §3), регистрация плагинов
 * routes/billing.ts и web/index.ts, клиент billing. Маршруты пишут потоки E (/v1/billing/*) и H (/web/v1/*).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ConfigError, TELEGRAM_OIDC_BASE, WEB_PAY_DEV_DEFAULTS, loadConfig } from "../src/config.js";
import { BILLING_SERVICE } from "../src/upstream.js";
import { WEB_PREFIX } from "../src/web/index.js";
import { closeRedis, makeHarness, type Harness } from "./helpers.js";

const PROD = {
  NODE_ENV: "production",
  BOT_TOKEN: "7000000001:AAprodTokenValueAbcdefghijklmnopqrstuv",
  SESSION_JWT_SECRET: "p".repeat(48),
  INTERNAL_JWT_PRIVATE_KEY: Buffer.alloc(32, 7).toString("base64url"),
  REDIS_URL: "redis://default:pw@redis.railway.internal:6379",
  MINIAPP_ORIGIN: "https://miniapp.tilhero.app",
  TELEGRAM_APP_LINK: "https://t.me/tilhero_bot/app",
  IDENTITY_URL: "http://identity-consent.railway.internal:8101",
  LEARNING_PLAN_URL: "http://learning-plan.railway.internal:8102",
  SUPPORT_URL: "http://support.railway.internal:8103",
  NOTIFICATIONS_URL: "http://notifications.railway.internal:8104",
  EXPERIENCE_URL: "http://experience-config.railway.internal:8106",
  SOCIAL_URL: "http://social.railway.internal:8109",
  CATALOG_URL: "http://catalog.railway.internal:8110",
  DIAGNOSTICS_URL: "http://diagnostics.railway.internal:8111",
  LESSONS_URL: "http://lessons.railway.internal:8112",
  ASSESSMENT_URL: "http://assessment.railway.internal:8113",
  MEMORY_URL: "http://memory.railway.internal:8116",
};
// заведомо тестовые значения (не секреты)
const WEB_ON = {
  WEB_PAY_ENABLED: "true",
  WEB_PAY_ORIGIN: "https://pay.tilhero.app",
  TELEGRAM_LOGIN_CLIENT_ID: "7000000001",
  TELEGRAM_LOGIN_CLIENT_SECRET: "test-client-secret-value-0001",
  WEB_SESSION_SECRET: "w".repeat(48),
};

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
afterAll(closeRedis);

describe("спринт 8: конфигурация billing и сайта оплаты", () => {
  it("dev: сайт оплаты выключен, dev-значения фиктивные; billing необязателен, таймаут 5 с", () => {
    const c = loadConfig({});
    expect(c.billingUrl).toBeUndefined();
    expect(c.billingTimeoutMs).toBe(5000);
    expect(c.webPay).toEqual({
      enabled: false,
      origin: WEB_PAY_DEV_DEFAULTS.WEB_PAY_ORIGIN,
      clientId: WEB_PAY_DEV_DEFAULTS.TELEGRAM_LOGIN_CLIENT_ID,
      clientSecret: WEB_PAY_DEV_DEFAULTS.TELEGRAM_LOGIN_CLIENT_SECRET,
      oidcBase: TELEGRAM_OIDC_BASE,
      sessionSecret: WEB_PAY_DEV_DEFAULTS.WEB_SESSION_SECRET,
    });
    for (const v of Object.values(WEB_PAY_DEV_DEFAULTS)) expect(v).toMatch(/dev|localhost|^1000000001$/);
    expect(loadConfig({ BILLING_URL: "http://127.0.0.1:8118/", WEB_PAY_ENABLED: "1" })).toMatchObject({
      billingUrl: "http://127.0.0.1:8118",
      webPay: { enabled: true },
    });
    // dev/test: мок OIDC стенда
    expect(loadConfig({ TELEGRAM_OIDC_BASE: "http://127.0.0.1:9911" }).webPay.oidcBase).toBe("http://127.0.0.1:9911");
    expect(problems({ WEB_PAY_ENABLED: "maybe" })).toEqual(['WEB_PAY_ENABLED="maybe": допустимо true|false']);
    expect(problems({ BILLING_URL: "billing:8118" })).toEqual(['BILLING_URL="billing:8118": ожидается http(s) URL']);
  });

  it("prod: выключенный сайт ничего не требует; включённый — https-origin, ID бота, секреты; OIDC — только Telegram", () => {
    const off = loadConfig(PROD);
    expect(off.webPay).toMatchObject({ enabled: false, origin: "", clientSecret: "", sessionSecret: "", oidcBase: TELEGRAM_OIDC_BASE });
    expect(problems({ ...PROD, WEB_PAY_ENABLED: "true" })).toEqual([
      "WEB_PAY_ORIGIN не задана (обязательна в stage/prod при WEB_PAY_ENABLED=true)",
      "TELEGRAM_LOGIN_CLIENT_ID не задана (обязательна в stage/prod при WEB_PAY_ENABLED=true)",
      "TELEGRAM_LOGIN_CLIENT_SECRET не задана (обязательна в stage/prod при WEB_PAY_ENABLED=true)",
      "WEB_SESSION_SECRET не задана (обязательна в stage/prod при WEB_PAY_ENABLED=true)",
    ]);
    const on = loadConfig({ ...PROD, ...WEB_ON });
    expect(on.webPay).toMatchObject({ enabled: true, origin: "https://pay.tilhero.app", clientId: "7000000001" });
    expect(problems({ ...PROD, ...WEB_ON, WEB_PAY_ORIGIN: "http://pay.tilhero.app" })).toEqual([
      "WEB_PAY_ORIGIN: http://pay.tilhero.app — в stage/prod только https",
    ]);
    expect(problems({ ...PROD, ...WEB_ON, WEB_PAY_ORIGIN: "https://miniapp.tilhero.app" })).toEqual([
      "WEB_PAY_ORIGIN: сайт оплаты не может совпадать с origin Mini App",
    ]);
    expect(problems({ ...PROD, ...WEB_ON, TELEGRAM_OIDC_BASE: "https://evil.example" })).toEqual([
      "TELEGRAM_OIDC_BASE: в stage/prod только https://oauth.telegram.org (подмена — только dev/test)",
    ]);
    expect(problems({ ...PROD, ...WEB_ON, WEB_SESSION_SECRET: PROD.SESSION_JWT_SECRET })).toEqual([
      "WEB_SESSION_SECRET должен отличаться от SESSION_JWT_SECRET и INTERNAL_JWT_SECRET",
    ]);
    expect(problems({ ...PROD, ...WEB_ON, TELEGRAM_LOGIN_CLIENT_SECRET: PROD.BOT_TOKEN })).toEqual([
      "TELEGRAM_LOGIN_CLIENT_SECRET не может совпадать с BOT_TOKEN",
    ]);
    expect(problems({ ...PROD, ...WEB_ON, WEB_SESSION_SECRET: WEB_PAY_DEV_DEFAULTS.WEB_SESSION_SECRET })).toEqual([
      "WEB_SESSION_SECRET: dev-значение запрещено в stage/prod",
    ]);
    expect(problems({ ...PROD, ...WEB_ON, TELEGRAM_LOGIN_CLIENT_ID: "abc" })).toEqual(["TELEGRAM_LOGIN_CLIENT_ID: ожидается ID бота (цифры)"]);
    // ошибки конфигурации не печатают значения секретов
    const all = problems({ ...PROD, ...WEB_ON, WEB_PAY_ORIGIN: "x", WEB_SESSION_SECRET: "short-secret-value" }).join("\n");
    expect(all).not.toContain(WEB_ON.TELEGRAM_LOGIN_CLIENT_SECRET);
    expect(all).not.toContain("short-secret-value");
  });
});

describe("спринт 8: плагины маршрутов и клиент billing", () => {
  it("WEB_PAY_ENABLED=false — /web/v1/* → 404; клиент billing есть только с BILLING_URL", async () => {
    h = await makeHarness();
    const r = await h.app.inject({ url: `${WEB_PREFIX}/me` });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(h.logs.parsed().some((l) => l.upstream === "billing" && String(l.msg).includes("BILLING_URL is not set"))).toBe(true);
  });

  it("WEB_PAY_ENABLED=true — область /web/v1 регистрируется (маршруты — поток H); BILLING_URL — клиент billing", async () => {
    h = await makeHarness({ WEB_PAY_ENABLED: "true", BILLING_URL: "http://billing.test:8118" });
    expect((await h.app.inject({ url: `${WEB_PREFIX}/me` })).statusCode).toBe(404);
    expect(BILLING_SERVICE).toBe("billing");
    expect(h.logs.parsed().some((l) => String(l.msg).includes("BILLING_URL is not set"))).toBe(false);
  });
});
