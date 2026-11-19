import { describe, expect, it } from "vitest";
import { ConfigError, DEV_DEFAULTS, loadConfig } from "../src/config.js";

const PROD_OK = {
  NODE_ENV: "production",
  BOT_TOKEN: "7000000001:AAprodTokenValueAbcdefghijklmnopqrstuv",
  SESSION_JWT_SECRET: "p".repeat(48),
  INTERNAL_JWT_PRIVATE_KEY: Buffer.alloc(32, 7).toString("base64url"),
  REDIS_URL: "redis://default:pw@redis.railway.internal:6379",
  MINIAPP_ORIGIN: "https://miniapp.tilhero.app, https://staging-miniapp.tilhero.app",
  TELEGRAM_APP_LINK: "https://t.me/tilhero_bot/app/",
  IDENTITY_URL: "http://identity-consent.railway.internal:8101",
  LEARNING_PLAN_URL: "http://learning-plan.railway.internal:8102",
  SUPPORT_URL: "http://support.railway.internal:8103",
  NOTIFICATIONS_URL: "http://notifications.railway.internal:8104",
  EXPERIENCE_URL: "http://experience-config.railway.internal:8106/",
  SOCIAL_URL: "http://social.railway.internal:8109",
  CATALOG_URL: "http://catalog.railway.internal:8110/",
  DIAGNOSTICS_URL: "http://diagnostics.railway.internal:8111",
  LESSONS_URL: "http://lessons.railway.internal:8112/",
  ASSESSMENT_URL: "http://assessment.railway.internal:8113",
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
    expect(c.rateLimits).toEqual({ userPerMinute: 120, sessionPerIpPerMinute: 10, pinPerMinute: 5, publicPerIpPerMinute: 120 });
    expect(c.telegramAppLink).toBe(DEV_DEFAULTS.TELEGRAM_APP_LINK);
    expect([c.identityUrl, c.learningPlanUrl, c.supportUrl, c.notificationsUrl, c.experienceUrl, c.socialUrl]).toEqual([
      "http://127.0.0.1:8101",
      "http://127.0.0.1:8102",
      "http://127.0.0.1:8103",
      "http://127.0.0.1:8104",
      "http://127.0.0.1:8106",
      "http://127.0.0.1:8109",
    ]);
  });

  it("production: accepts a complete env, parses origin list and trims URLs", () => {
    const c = loadConfig(PROD_OK);
    expect(c.isSecure).toBe(true);
    expect(c.env).toBe("prod");
    expect(c.miniappOrigins).toEqual(["https://miniapp.tilhero.app", "https://staging-miniapp.tilhero.app"]);
    expect(c.experienceUrl).toBe("http://experience-config.railway.internal:8106");
    expect(c.socialUrl).toBe("http://social.railway.internal:8109");
    expect(c.catalogUrl).toBe("http://catalog.railway.internal:8110");
    expect(c.diagnosticsUrl).toBe("http://diagnostics.railway.internal:8111");
    expect(c.audioCacheBytes).toBe(32 * 1024 * 1024);
    expect(c.telegramAppLink).toBe("https://t.me/tilhero_bot/app");
    // спринт 4
    expect(c.lessonsUrl).toBe("http://lessons.railway.internal:8112");
    expect(c.assessmentUrl).toBe("http://assessment.railway.internal:8113");
    expect(c.lessonsTimeoutMs).toBe(25_000);
    expect(c.lessonsFinishTimeoutMs).toBe(45_000);
  });

  it("R2-02: таймаут lessons больше таймаута ИИ в lessons (20 с); завершение — больше ожидания оценки (до 32 с)", () => {
    const LESSONS_AI_TIMEOUT_MS = 20_000; // services/lessons AI_TIMEOUT_SECONDS по умолчанию
    const LESSONS_FINISH_WAIT_MS = 32_000; // lessons → assessment при finish
    for (const c of [loadConfig({}), loadConfig(PROD_OK)]) {
      expect(c.lessonsTimeoutMs).toBe(25_000);
      expect(c.lessonsTimeoutMs).toBeGreaterThan(LESSONS_AI_TIMEOUT_MS);
      expect(c.lessonsFinishTimeoutMs).toBe(45_000);
      expect(c.lessonsFinishTimeoutMs).toBeGreaterThan(LESSONS_FINISH_WAIT_MS);
      expect(c.lessonsFinishTimeoutMs).toBeGreaterThan(c.lessonsTimeoutMs);
    }
    // переопределение переменной окружения по-прежнему работает
    expect(loadConfig({ LESSONS_TIMEOUT_MS: "30000" }).lessonsTimeoutMs).toBe(30_000);
  });

  it("production: lists every missing variable in one error", () => {
    const p = problems({ NODE_ENV: "production" });
    for (const name of [
      "BOT_TOKEN", "SESSION_JWT_SECRET", "INTERNAL_JWT_PRIVATE_KEY", "REDIS_URL", "MINIAPP_ORIGIN", "TELEGRAM_APP_LINK",
      "IDENTITY_URL", "LEARNING_PLAN_URL", "SUPPORT_URL", "NOTIFICATIONS_URL", "EXPERIENCE_URL", "SOCIAL_URL",
      "CATALOG_URL", "DIAGNOSTICS_URL", "LESSONS_URL", "ASSESSMENT_URL",
    ]) {
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
    for (const bad of ["http://t.me/bot_name/app", "https://evil.example/bot_name/app", "https://t.me/bot_name", "https://t.me/bot_name/app?x=1"]) {
      expect(problems({ TELEGRAM_APP_LINK: bad })[0], bad).toMatch(/TELEGRAM_APP_LINK/);
    }
    expect(problems({ LOG_LEVEL: "verbose" })[0]).toMatch(/LOG_LEVEL/);
    expect(loadConfig({ LOG_LEVEL: "INFO" }).logLevel).toBe("info"); // общая переменная Railway с Python-сервисами
    expect(loadConfig({ LOG_LEVEL: "WARNING" }).logLevel).toBe("warn");
  });
});
