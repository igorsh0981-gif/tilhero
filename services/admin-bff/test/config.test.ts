import { describe, expect, it } from "vitest";
import { ConfigError, FEATURE_URL_VARS, loadConfig } from "../src/config.js";

const KEY = Buffer.alloc(32, 7).toString("base64url");
const PUB = JSON.stringify({ "admin-identity": Buffer.alloc(32, 1).toString("base64url") });

const PROD = {
  ENV: "prod",
  INTERNAL_JWT_PRIVATE_KEY: KEY,
  INTERNAL_JWT_PUBLIC_KEYS: PUB,
  REDIS_URL: "redis://redis.railway.internal:6379",
  ADMIN_WEB_ORIGIN: "https://admin.tilhero.app",
  ADMIN_IDENTITY_URL: "http://admin-identity.railway.internal:8120",
  USER_ADMIN_URL: "http://user-admin.railway.internal:8121",
  IDENTITY_URL: "http://identity-consent.railway.internal:8101",
  SUPPORT_URL: "http://support.railway.internal:8103",
  AUDIT_URL: "http://audit.railway.internal:8105",
  EXPERIENCE_URL: "http://experience-config.railway.internal:8106",
  SOURCE_REGISTRY_URL: "http://source-registry.railway.internal:8133",
  DISCOVERY_URL: "http://discovery.railway.internal:8112",
  PROVIDER_GATEWAY_URL: "http://provider-gateway.railway.internal:8111",
  EVENTS_URL: "http://events.railway.internal:8110",
  OFFERS_URL: "http://offers.railway.internal:8115",
  WATCH_URL: "http://watch.railway.internal:8116",
  NEWS_URL: "http://news.railway.internal:8117",
  AI_CONCIERGE_URL: "http://ai-concierge.railway.internal:8118",
  AI_CONTROL_URL: "http://ai-control.railway.internal:8124",
  OPS_MONITOR_URL: "http://ops-monitor.railway.internal:8129",
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
  it("dev: значения локального стенда, PORT 8002, HOST ::, 2 доверенных прокси, имперсонация доступна", () => {
    const c = loadConfig({});
    expect(c.env).toBe("dev");
    expect(c.isSecure).toBe(false);
    expect(c.devTools).toBe(true);
    expect(c.port).toBe(8002);
    expect(c.host).toBe("::");
    expect(c.trustProxy).toBe(2);
    expect(c.session).toEqual({ idleSeconds: 1800, absoluteSeconds: 28_800, stepUpSeconds: 300, principalCacheSeconds: 30 });
    expect(c.rateLimits).toMatchObject({ loginPerIpPerMinute: 10, loginPerEmailPerMinute: 5, mfaPerMinute: 5, staffPerMinute: 300 });
    expect(c.urls.adminIdentity).toBe("http://127.0.0.1:8120");
    // спринт 4: порты локального стенда
    expect(c.urls.sourceRegistry).toBe("http://127.0.0.1:8133");
    expect(c.urls.discovery).toBe("http://127.0.0.1:8112");
    expect(c.urls.providerGateway).toBe("http://127.0.0.1:8111");
    expect(c.urls.events).toBe("http://127.0.0.1:8110");
  });

  it("prod: все обязательные переменные перечислены разом", () => {
    const p = problems({ ENV: "prod" });
    for (const name of [
      "INTERNAL_JWT_PRIVATE_KEY",
      "INTERNAL_JWT_PUBLIC_KEYS",
      "REDIS_URL",
      "ADMIN_WEB_ORIGIN",
      "ADMIN_IDENTITY_URL",
      "USER_ADMIN_URL",
      "IDENTITY_URL",
      "SUPPORT_URL",
      "AUDIT_URL",
      "EXPERIENCE_URL",
    ]) {
      expect(p.some((x) => x.startsWith(name)), name).toBe(true);
    }
    // адреса спринта 4 необязательны (порядок выкладки: код может выйти раньше переменных)
    for (const name of FEATURE_URL_VARS) expect(p.some((x) => x.startsWith(name)), name).toBe(false);
    expect(p.some((x) => x.includes("SESSION_SECRET"))).toBe(false);
  });

  it("prod без адресов спринта 4: конфиг валиден, адреса null, список unconfigured; заданный — проверяется", () => {
    const env: Record<string, string> = { ...PROD };
    for (const name of FEATURE_URL_VARS) delete env[name];
    const c = loadConfig(env);
    expect(c.urls).toMatchObject({ sourceRegistry: null, discovery: null, providerGateway: null, events: null, offers: null, news: null, watch: null, aiControl: null, aiConcierge: null, opsMonitor: null });
    expect(c.unconfigured).toEqual([...FEATURE_URL_VARS]);
    expect(c.urls.adminIdentity).toBe(PROD.ADMIN_IDENTITY_URL);
    const partial = loadConfig({ ...env, EVENTS_URL: "http://events.railway.internal:8110/" });
    expect(partial.urls.events).toBe("http://events.railway.internal:8110");
    expect(partial.unconfigured).toEqual(["SOURCE_REGISTRY_URL", "DISCOVERY_URL", "PROVIDER_GATEWAY_URL", "OFFERS_URL", "NEWS_URL", "WATCH_URL", "AI_CONTROL_URL", "AI_CONCIERGE_URL", "OPS_MONITOR_URL"]);
    expect(problems({ ...env, DISCOVERY_URL: "ftp://discovery" })).toEqual([expect.stringMatching(/^DISCOVERY_URL=/)]);
    expect(loadConfig(PROD).unconfigured).toEqual([]);
    expect(loadConfig({}).unconfigured).toEqual([]); // dev: значения локального стенда
  });

  it("prod: полный набор — ок, без dev-деривации и без имперсонации; NODE_ENV=production тоже защищённое", () => {
    const c = loadConfig(PROD);
    expect(c.isSecure).toBe(true);
    expect(c.devTools).toBe(false);
    expect(c.internalJwtSecret).toBeUndefined();
    const s = loadConfig({ ...PROD, ENV: "dev", NODE_ENV: "production" });
    expect(s.isSecure).toBe(true);
    expect(s.devTools).toBe(false);
  });

  it("prod: origin только https и только один", () => {
    expect(problems({ ...PROD, ADMIN_WEB_ORIGIN: "http://admin.tilhero.app" }).join()).toContain("https");
    expect(problems({ ...PROD, ADMIN_WEB_ORIGIN: "https://a.app,https://b.app" }).join()).toContain("ADMIN_WEB_ORIGIN");
    expect(problems({ ...PROD, ADMIN_WEB_ORIGIN: "https://admin.tilhero.app/path" }).join()).toContain("ADMIN_WEB_ORIGIN");
  });

  it("LOG_LEVEL без учёта регистра, WARNING → warn; неизвестный — ошибка", () => {
    expect(loadConfig({ LOG_LEVEL: "INFO" }).logLevel).toBe("info");
    expect(loadConfig({ LOG_LEVEL: "Warning" }).logLevel).toBe("warn");
    expect(problems({ LOG_LEVEL: "verbose" }).join()).toContain("LOG_LEVEL");
  });

  it("сроки сессии не длиннее политики (30 мин / 8 ч), кэш principal ≤ 30 с", () => {
    expect(problems({ SESSION_IDLE_SECONDS: "3600" }).join()).toContain("SESSION_IDLE_SECONDS");
    expect(problems({ SESSION_ABSOLUTE_SECONDS: "86400" }).join()).toContain("SESSION_ABSOLUTE_SECONDS");
    expect(problems({ PRINCIPAL_CACHE_SECONDS: "60" }).join()).toContain("PRINCIPAL_CACHE_SECONDS");
    expect(problems({ ENV: "qa" }).join()).toContain("ENV");
    expect(problems({ INTERNAL_JWT_PRIVATE_KEY: "short" }).join()).toContain("INTERNAL_JWT_PRIVATE_KEY");
    expect(problems({ TRUST_PROXY_HOPS: "x" }).join()).toContain("TRUST_PROXY_HOPS");
  });
});
