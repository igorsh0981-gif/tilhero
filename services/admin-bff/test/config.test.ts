import { describe, expect, it } from "vitest";
import { ConfigError, DEV_DEFAULTS, DOMAIN_URL_VARS, loadConfig } from "../src/config.js";

const KEY = Buffer.alloc(32, 7).toString("base64url");
const PUB = JSON.stringify({ "admin-identity": Buffer.alloc(32, 1).toString("base64url") });

const PROD = {
  ENV: "prod",
  INTERNAL_JWT_PRIVATE_KEY: KEY,
  INTERNAL_JWT_PUBLIC_KEYS: PUB,
  REDIS_URL: "redis://redis.railway.internal:6379",
  ADMIN_ORIGIN: "https://admin.tilhero.app",
  ADMIN_IDENTITY_URL: "http://admin-identity.railway.internal:8120",
  USER_ADMIN_URL: "http://user-admin.railway.internal:8121",
  IDENTITY_URL: "http://identity-consent.railway.internal:8101",
  SUPPORT_URL: "http://support.railway.internal:8103",
  NOTIFICATIONS_URL: "http://notifications.railway.internal:8104",
  AUDIT_URL: "http://audit.railway.internal:8105",
  EXPERIENCE_URL: "http://experience-config.railway.internal:8106",
  CATALOG_URL: "http://catalog.railway.internal:8110",
  DIAGNOSTICS_URL: "http://diagnostics.railway.internal:8111",
};

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
}

describe("config", () => {
  it("dev: значения локального стенда (порты как у telegram-bff и ARCHITECTURE.md), PORT 8002, HOST ::, имперсонация доступна", () => {
    const c = loadConfig({});
    expect(c.env).toBe("dev");
    expect(c.isSecure).toBe(false);
    expect(c.devTools).toBe(true);
    expect(c.port).toBe(8002);
    expect(c.host).toBe("::");
    expect(c.trustProxy).toBe(2);
    expect(c.adminOrigin).toBe("http://localhost:5174");
    expect(c.session).toEqual({ idleSeconds: 1800, absoluteSeconds: 28_800, stepUpSeconds: 300, principalCacheSeconds: 30 });
    expect(c.rateLimits).toMatchObject({ loginPerIpPerMinute: 10, loginPerEmailPerMinute: 5, mfaPerMinute: 5, staffPerMinute: 300 });
    expect(c.urls).toEqual({
      adminIdentity: "http://127.0.0.1:8120",
      userAdmin: "http://127.0.0.1:8121",
      identity: "http://127.0.0.1:8101",
      support: "http://127.0.0.1:8103",
      audit: "http://127.0.0.1:8105",
      experience: "http://127.0.0.1:8106",
      notifications: "http://127.0.0.1:8104",
      catalog: "http://127.0.0.1:8110",
      diagnostics: "http://127.0.0.1:8111",
    });
  });

  it("имена переменных адресов — как у telegram-bff (IDENTITY_URL, SUPPORT_URL, NOTIFICATIONS_URL, EXPERIENCE_URL)", () => {
    expect(Object.values(DOMAIN_URL_VARS).sort()).toEqual(
      [
        "ADMIN_IDENTITY_URL", "AUDIT_URL", "EXPERIENCE_URL", "IDENTITY_URL", "NOTIFICATIONS_URL", "SUPPORT_URL", "USER_ADMIN_URL",
        "CATALOG_URL", "DIAGNOSTICS_URL",
      ].sort(),
    );
    for (const v of Object.values(DOMAIN_URL_VARS)) expect(DEV_DEFAULTS[v]).toMatch(/^http:\/\/127\.0\.0\.1:81\d\d$/);
  });

  it("prod: все обязательные переменные перечислены разом", () => {
    const p = problems({ ENV: "prod" });
    for (const name of ["INTERNAL_JWT_PRIVATE_KEY", "INTERNAL_JWT_PUBLIC_KEYS", "REDIS_URL", "ADMIN_ORIGIN", ...Object.values(DOMAIN_URL_VARS)]) {
      expect(p.some((x) => x.startsWith(name)), name).toBe(true);
    }
    expect(p.some((x) => x.includes("SESSION_SECRET"))).toBe(false);
  });

  it("спринт 3: CATALOG_URL и DIAGNOSTICS_URL обязательны в stage/prod (порты 8110/8111 в dev)", () => {
    for (const env of ["stage", "prod"]) {
      const { CATALOG_URL: _c, DIAGNOSTICS_URL: _d, ...rest } = PROD;
      const p = problems({ ...rest, ENV: env });
      expect(p, env).toEqual([expect.stringMatching(/^CATALOG_URL не задана/), expect.stringMatching(/^DIAGNOSTICS_URL не задана/)]);
    }
    expect(loadConfig(PROD).urls).toMatchObject({ catalog: PROD.CATALOG_URL, diagnostics: PROD.DIAGNOSTICS_URL });
    expect(problems({ ...PROD, DIAGNOSTICS_URL: "diagnostics:8111" })).toEqual([expect.stringMatching(/^DIAGNOSTICS_URL=/)]);
  });

  it("prod: полный набор — ок, без dev-деривации и без имперсонации; NODE_ENV=production тоже защищённое", () => {
    const c = loadConfig(PROD);
    expect(c.isSecure).toBe(true);
    expect(c.devTools).toBe(false);
    expect(c.internalJwtSecret).toBeUndefined();
    expect(c.urls.notifications).toBe(PROD.NOTIFICATIONS_URL);
    const s = loadConfig({ ...PROD, ENV: "dev", NODE_ENV: "production" });
    expect(s.isSecure).toBe(true);
    expect(s.devTools).toBe(false);
    // stage — тоже защищённое: имперсонации нет
    expect(loadConfig({ ...PROD, ENV: "stage" }).devTools).toBe(false);
  });

  it("адрес домена: только http(s), завершающий / отбрасывается", () => {
    expect(problems({ ...PROD, SUPPORT_URL: "ftp://support" })).toEqual([expect.stringMatching(/^SUPPORT_URL=/)]);
    expect(loadConfig({ ...PROD, SUPPORT_URL: "http://support.railway.internal:8103/" }).urls.support).toBe("http://support.railway.internal:8103");
  });

  it("prod: origin только https и только один", () => {
    expect(problems({ ...PROD, ADMIN_ORIGIN: "http://admin.tilhero.app" }).join()).toContain("https");
    expect(problems({ ...PROD, ADMIN_ORIGIN: "https://a.app,https://b.app" }).join()).toContain("ADMIN_ORIGIN");
    expect(problems({ ...PROD, ADMIN_ORIGIN: "https://admin.tilhero.app/path" }).join()).toContain("ADMIN_ORIGIN");
  });

  it("LOG_LEVEL без учёта регистра, WARNING → warn; неизвестный — ошибка", () => {
    expect(loadConfig({ LOG_LEVEL: "INFO" }).logLevel).toBe("info");
    expect(loadConfig({ LOG_LEVEL: "Warning" }).logLevel).toBe("warn");
    expect(problems({ LOG_LEVEL: "verbose" }).join()).toContain("LOG_LEVEL");
  });

  it("сроки сессии не длиннее политики (30 мин / 8 ч), step-up ≤ 5 мин, кэш principal ≤ 30 с", () => {
    expect(problems({ SESSION_IDLE_SECONDS: "3600" }).join()).toContain("SESSION_IDLE_SECONDS");
    expect(problems({ SESSION_ABSOLUTE_SECONDS: "86400" }).join()).toContain("SESSION_ABSOLUTE_SECONDS");
    expect(problems({ STEP_UP_SECONDS: "600" }).join()).toContain("STEP_UP_SECONDS");
    expect(problems({ PRINCIPAL_CACHE_SECONDS: "60" }).join()).toContain("PRINCIPAL_CACHE_SECONDS");
    expect(problems({ ENV: "qa" }).join()).toContain("ENV");
    expect(problems({ INTERNAL_JWT_PRIVATE_KEY: "short" }).join()).toContain("INTERNAL_JWT_PRIVATE_KEY");
    expect(problems({ TRUST_PROXY_HOPS: "x" }).join()).toContain("TRUST_PROXY_HOPS");
  });
});
