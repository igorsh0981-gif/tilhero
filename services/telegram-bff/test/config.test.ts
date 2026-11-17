import { describe, expect, it } from "vitest";
import { ConfigError, DEV_DEFAULTS, loadConfig } from "../src/config.js";

const PROD_OK = {
  NODE_ENV: "production",
  BOT_TOKEN: "7000000001:AAprodTokenValueAbcdefghijklmnopqrstuv",
  SESSION_JWT_SECRET: "p".repeat(48),
  INTERNAL_JWT_PRIVATE_KEY: Buffer.alloc(32, 7).toString("base64url"),
  REDIS_URL: "redis://default:pw@redis.railway.internal:6379",
  MINIAPP_ORIGIN: "https://miniapp.tilhero.app, https://staging-miniapp.tilhero.app",
  IDENTITY_URL: "http://identity-consent.railway.internal:8101",
  PREFERENCES_URL: "http://preferences.railway.internal:8102",
  SUPPORT_URL: "http://support.railway.internal:8103",
  EXPERIENCE_URL: "http://experience-config.railway.internal:8106/",
  EVENTS_URL: "http://events.railway.internal:8110",
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

describe("loadConfig", () => {
  it("dev: works without env, with documented defaults", () => {
    const c = loadConfig({});
    expect(c.isSecure).toBe(false);
    expect(c.env).toBe("dev");
    expect(c.port).toBe(8001);
    expect(c.host).toBe("::");
    expect(c.initDataMaxAgeSeconds).toBe(600);
    expect(c.initDataOneTime).toBe(true);
    expect(c.accessTtlSeconds).toBe(900);
    expect(c.refreshTtlSeconds).toBe(43_200);
    expect(c.botToken).toBe(DEV_DEFAULTS.BOT_TOKEN);
    expect(c.miniappOrigins).toEqual(["http://localhost:5173"]);
    expect(c.rateLimits).toEqual({ userPerMinute: 120, sessionPerIpPerMinute: 10, pinPerMinute: 5, publicPerIpPerMinute: 120, offersPerMinute: 20, reactionsPerMinute: 60, watchCommandsPerMinute: 30, aiTurnsPerMinute: 6 });
    expect([c.aiConciergeUrl, c.conciergeTimeoutMs]).toEqual([undefined, 75_000]); // спринт 7: без URL — /v1/ai/* → 503 FEATURE_UNAVAILABLE
    // спринт 6: необязательные домены — без них Home деградирует, эндпоинты → 503 FEATURE_UNAVAILABLE
    expect([c.recommendationsUrl, c.watchUrl, c.newsUrl]).toEqual([undefined, undefined, undefined]);
    expect(c.offersUrl).toBeUndefined(); // спринт 5: необязательная, без неё предложения → 503 OFFERS_UNAVAILABLE
  });

  it("production: accepts a complete env, parses origin list and trims URLs", () => {
    const c = loadConfig(PROD_OK);
    expect(c.isSecure).toBe(true);
    expect(c.env).toBe("prod");
    expect(c.miniappOrigins).toEqual(["https://miniapp.tilhero.app", "https://staging-miniapp.tilhero.app"]);
    expect(c.experienceUrl).toBe("http://experience-config.railway.internal:8106");
    expect(c.eventsUrl).toBe("http://events.railway.internal:8110");
    expect([c.homeFreshSeconds, c.homeStaleSeconds]).toEqual([60, 86_400]);
  });

  it("production: lists every missing variable in one error", () => {
    const p = problems({ NODE_ENV: "production" });
    for (const name of ["BOT_TOKEN", "SESSION_JWT_SECRET", "INTERNAL_JWT_PRIVATE_KEY", "REDIS_URL", "MINIAPP_ORIGIN", "IDENTITY_URL", "PREFERENCES_URL", "SUPPORT_URL", "EXPERIENCE_URL", "EVENTS_URL"]) {
      expect(p.some((x) => x.startsWith(name))).toBe(true);
    }
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/некорректная конфигурация/);
  });

  it("production: dev secrets, short secrets, http origin and equal secrets are rejected", () => {
    expect(problems({ ...PROD_OK, SESSION_JWT_SECRET: DEV_DEFAULTS.SESSION_JWT_SECRET })).toContain(
      "SESSION_JWT_SECRET: dev-значение запрещено в stage/prod",
    );
    expect(problems({ ...PROD_OK, BOT_TOKEN: DEV_DEFAULTS.BOT_TOKEN }).length).toBeGreaterThan(0);
    expect(problems({ ...PROD_OK, BOT_TOKEN: "not-a-token" })[0]).toMatch(/BOT_TOKEN/);
    expect(problems({ ...PROD_OK, MINIAPP_ORIGIN: "http://miniapp.tilhero.app" })[0]).toMatch(/https/);
    expect(problems({ SESSION_JWT_SECRET: "q".repeat(40), INTERNAL_JWT_SECRET: "q".repeat(40) })[0]).toMatch(/различаться/);
  });

  it("внутренний JWT v2: stage/prod — только INTERNAL_JWT_PRIVATE_KEY, без dev-деривации", () => {
    // явный режим stage (без NODE_ENV=production) — тоже защищённый
    const { NODE_ENV: _n, ...rest } = PROD_OK;
    const stage = loadConfig({ ...rest, ENV: "stage" });
    expect(stage).toMatchObject({ env: "stage", isSecure: true, internalJwtSecret: undefined });
    const { INTERNAL_JWT_PRIVATE_KEY: _k, ...noKey } = PROD_OK;
    // даже с INTERNAL_JWT_SECRET ключ не выводится
    expect(problems({ ...noKey, INTERNAL_JWT_SECRET: "i".repeat(48) })).toEqual([
      "INTERNAL_JWT_PRIVATE_KEY не задана (обязательна в stage/prod; dev-деривация ключа запрещена)",
    ]);
    expect(problems({ ...noKey, NODE_ENV: "development", ENV: "prod" })[0]).toMatch(/INTERNAL_JWT_PRIVATE_KEY/);
    expect(problems({ ...PROD_OK, INTERNAL_JWT_PRIVATE_KEY: "short" })[0]).toMatch(/32-байтного seed/);
    expect(problems({ ...PROD_OK, INTERNAL_JWT_PUBLIC_KEYS: "{bad" })[0]).toMatch(/INTERNAL_JWT_PUBLIC_KEYS/);
    expect(problems({ ...PROD_OK, INTERNAL_JWT_PUBLIC_KEYS: JSON.stringify({ support: "abc" }) })[0]).toMatch(/INTERNAL_JWT_PUBLIC_KEYS/);
    const pub = Buffer.alloc(32, 1).toString("base64url");
    expect(loadConfig({ ...PROD_OK, INTERNAL_JWT_PUBLIC_KEYS: JSON.stringify({ support: pub }) }).internalJwtPublicKeys).toEqual({ support: pub });
    expect(problems({ ENV: "production" })[0]).toMatch(/ENV/);
    // dev/test: деривация из INTERNAL_JWT_SECRET (по умолчанию — общий dev-секрет py-common)
    expect(loadConfig({}).internalJwtSecret).toBe(DEV_DEFAULTS.INTERNAL_JWT_SECRET);
    expect(loadConfig({ NODE_ENV: "test" }).env).toBe("test");
  });

  it("any env: SESSION_JWT_SECRET >= 32, numeric ranges, URL formats", () => {
    expect(problems({ SESSION_JWT_SECRET: "x".repeat(31) })).toEqual(["SESSION_JWT_SECRET: минимум 32 символа"]);
    expect(problems({ PORT: "abc" })[0]).toMatch(/PORT/);
    expect(problems({ ACCESS_TTL_SECONDS: "5" })[0]).toMatch(/ACCESS_TTL_SECONDS/);
    expect(problems({ ACCESS_TTL_SECONDS: "3600", REFRESH_TTL_SECONDS: "3000" })[0]).toMatch(/REFRESH_TTL_SECONDS/);
    expect(problems({ IDENTITY_URL: "ftp://x" })[0]).toMatch(/IDENTITY_URL/);
    expect(problems({ REDIS_URL: "http://x" })[0]).toMatch(/REDIS_URL/);
    expect(problems({ MINIAPP_ORIGIN: "https://a.app/path" })[0]).toMatch(/MINIAPP_ORIGIN/);
    expect(problems({ LOG_LEVEL: "verbose" })[0]).toMatch(/LOG_LEVEL/);
    expect(loadConfig({ LOG_LEVEL: "INFO" }).logLevel).toBe("info"); // общая переменная Railway с Python-сервисами
    expect(loadConfig({ LOG_LEVEL: "WARNING" }).logLevel).toBe("warn");
  });
});
