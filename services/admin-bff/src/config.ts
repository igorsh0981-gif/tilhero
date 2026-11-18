/**
 * Конфигурация admin-bff из переменных окружения. Валидируется один раз при старте: при ошибке процесс
 * не поднимается, а в сообщении перечислены ВСЕ проблемные переменные (как в telegram-bff).
 *
 * Окружение: ENV=dev|test|stage|prod. «Защищённое» окружение (stage/prod или NODE_ENV=production):
 * ключи внутреннего JWT, Redis, origin admin-web и адреса доменов спринтов 2–3 обязательны, dev-деривация ключа
 * запрещена, имперсонация выключена. В dev/test у адресов есть значения локального стенда.
 *
 * Адреса доменов спринта 4 (SOURCE_REGISTRY_URL, DISCOVERY_URL, PROVIDER_GATEWAY_URL, EVENTS_URL), спринта 5 (OFFERS_URL)
 * спринта 6 (NEWS_URL, WATCH_URL) и спринта 7 (AI_CONTROL_URL, AI_CONCIERGE_URL)
 * необязательны и в prod: код может выкатиться раньше переменных. Без адреса маршруты раздела отвечают 503 FEATURE_UNAVAILABLE, остальная
 * админка работает; список ненастроенных переменных — `Config.unconfigured` (WARNING при старте).
 *
 * SESSION_SECRET не нужен: идентификатор сессии — непрозрачные 32 случайных байта, данные — в Redis.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_RUNBOOK_BASE_URL } from "./runbook.js";

export type AppEnv = "dev" | "test" | "stage" | "prod";

/** Единый лимитер (спринт 9, INTERNAL_API §2.1): выключатель, перечитывание переопределений, префикс ключей. */
export interface RateLimiting {
  /** RATE_LIMITS_ENABLED (true): false — лимитер пропускает всё и считает только метрики (авария). */
  enabled: boolean;
  /** RATE_LIMIT_OVERRIDE_REFRESH_SECONDS (30): как часто перечитывать rl:override:* из Redis. */
  overrideRefreshSeconds: number;
  /** RATE_LIMIT_KEY_PREFIX — только для тестов: в stage/prod ключи лимитера без префикса (namespace rl* читает ops-monitor). */
  keyPrefix: string;
}

export interface RateLimits {
  /** POST /auth/login — с одного IP (IPv6 — по /64) в минуту. */
  loginPerIpPerMinute: number;
  /** POST /auth/login — на один email (нормализованный, в Redis только хеш) в минуту. */
  loginPerEmailPerMinute: number;
  /** Шаги входа по challenge (mfa, enroll, password) — с одного IP в минуту. */
  authStepPerIpPerMinute: number;
  /** Ввод TOTP: на challenge (вход) и на сотрудника (step-up) в минуту. */
  mfaPerMinute: number;
  /** Все прочие маршруты — на сотрудника в минуту. */
  staffPerMinute: number;
}

export interface SessionPolicy {
  /** Бездействие (по умолчанию 30 мин). */
  idleSeconds: number;
  /** Абсолютный срок жизни (по умолчанию 8 ч). */
  absoluteSeconds: number;
  /** Окно step-up после повторного TOTP (5 мин). */
  stepUpSeconds: number;
  /** Кэш principal из admin-identity (≤ 30 с). */
  principalCacheSeconds: number;
}

export interface DomainUrls {
  adminIdentity: string;
  userAdmin: string;
  identity: string;
  support: string;
  audit: string;
  experience: string;
  /** Спринт 4: реестр источников, запуски поиска, бюджет/kill switch AI, очередь проверки событий.
   *  null — переменная не задана (stage/prod): маршруты раздела → 503 FEATURE_UNAVAILABLE. */
  sourceRegistry: string | null;
  discovery: string | null;
  providerGateway: string | null;
  events: string | null;
  /** Спринт 5: снимки предложений (offers). null — 503 FEATURE_UNAVAILABLE у GET /admin/v1/offers/:offerId. */
  offers: string | null;
  /** Спринт 6: ленты и модерация новостей (news), статистика слежений (watch). null — 503 FEATURE_UNAVAILABLE. */
  news: string | null;
  watch: string | null;
  /** Спринт 7: учёт и стоимость AI, бюджеты, агенты, skills, Test Console, уровни доступа (ai-control) и метаданные /
   *  раскрытие переписок (ai-concierge). null — 503 FEATURE_UNAVAILABLE. */
  aiControl: string | null;
  aiConcierge: string | null;
  /** Спринт 8: «Мониторинг» — здоровье поставщиков, очереди и DLQ, оповещения, сводка «Здоровье системы»
   *  (ops-monitor). null — 503 FEATURE_UNAVAILABLE; блок дашборда system — not_configured. */
  opsMonitor: string | null;
}

/** Необязательные адреса доменов (спринты 4–7). */
export const FEATURE_URL_VARS = ["SOURCE_REGISTRY_URL", "DISCOVERY_URL", "PROVIDER_GATEWAY_URL", "EVENTS_URL", "OFFERS_URL", "NEWS_URL", "WATCH_URL", "AI_CONTROL_URL", "AI_CONCIERGE_URL", "OPS_MONITOR_URL"] as const;

export interface Config {
  nodeEnv: string;
  env: AppEnv;
  /** спринт 9 (ревью): раздел runbook'ов — ссылка «Runbook» оповещения только внутри него (как у ops-monitor,
   *  notifications, bot-gateway: RUNBOOK_BASE_URL у всех одинаковый) */
  runbookBaseUrl: string;
  isSecure: boolean;
  /** Имперсонация (POST /admin/v1/dev/impersonate) — только ENV=dev и не в защищённом окружении. */
  devTools: boolean;
  serviceVersion: string;
  port: number;
  host: string;
  logLevel: string;
  /** Доверенные прокси перед сервисом: edge Railway → Caddy admin-web → admin-bff = 2. */
  trustProxy: number;

  internalJwtSecret: string | undefined;
  internalJwtPrivateKey: string | undefined;
  internalJwtPublicKeys: Record<string, string>;
  redisUrl: string;
  redisKeyPrefix: string;

  /** Origin admin-web (единственный разрешённый для не-GET и входа). */
  adminWebOrigin: string;

  urls: DomainUrls;
  /** Не заданные в stage/prod переменные адресов спринтов 4–7 (разделы отвечают 503 FEATURE_UNAVAILABLE). */
  unconfigured: string[];
  upstreamTimeoutMs: number;
  upstreamRetries: number;
  /** Таймаут вызовов дашборда (статистика доменов). */
  dashboardTimeoutMs: number;
  /** Таймаут проверки /health/ready доменов на дашборде. */
  healthTimeoutMs: number;
  /** Спринт 8 (§7.4): свежесть блока дашборда в Redis (users — ×5), stale-копия, ожидание блока. */
  dashboardCacheSeconds: number;
  dashboardStaleMaxSeconds: number;
  dashboardBlockTimeoutMs: number;

  session: SessionPolicy;
  rateLimits: RateLimits;
  rateLimiting: RateLimiting;
}

export const DEV_DEFAULTS = {
  // совпадает с dev-секретом tilhero_common (Python-домены) — локальный стенд работает без настройки
  INTERNAL_JWT_SECRET: "dev-internal-secret-change-me",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  ADMIN_WEB_ORIGIN: "http://localhost:5174",
  ADMIN_IDENTITY_URL: "http://127.0.0.1:8120",
  USER_ADMIN_URL: "http://127.0.0.1:8121",
  IDENTITY_URL: "http://127.0.0.1:8101",
  SUPPORT_URL: "http://127.0.0.1:8103",
  AUDIT_URL: "http://127.0.0.1:8105",
  EXPERIENCE_URL: "http://127.0.0.1:8106",
  SOURCE_REGISTRY_URL: "http://127.0.0.1:8133",
  DISCOVERY_URL: "http://127.0.0.1:8112",
  PROVIDER_GATEWAY_URL: "http://127.0.0.1:8111",
  EVENTS_URL: "http://127.0.0.1:8110",
  OFFERS_URL: "http://127.0.0.1:8115",
  WATCH_URL: "http://127.0.0.1:8116",
  NEWS_URL: "http://127.0.0.1:8117",
  AI_CONCIERGE_URL: "http://127.0.0.1:8118",
  AI_CONTROL_URL: "http://127.0.0.1:8124",
  OPS_MONITOR_URL: "http://127.0.0.1:8129",
} as const;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`admin-bff: некорректная конфигурация окружения:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const nodeEnv = (env.NODE_ENV ?? "development").trim() || "development";

  const raw = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };

  const envRaw = raw("ENV");
  let appEnv: AppEnv = nodeEnv === "production" ? "prod" : nodeEnv === "test" ? "test" : "dev";
  if (envRaw !== undefined) {
    const v = envRaw.toLowerCase();
    if (["dev", "test", "stage", "prod"].includes(v)) appEnv = v as AppEnv;
    else problems.push(`ENV=${JSON.stringify(envRaw)}: допустимо dev|test|stage|prod`);
  }
  const isSecure = nodeEnv === "production" || appEnv === "stage" || appEnv === "prod";

  const required = (name: keyof typeof DEV_DEFAULTS): string => {
    const v = raw(name);
    if (v !== undefined) return v;
    if (isSecure) {
      problems.push(`${name} не задана (обязательна в stage/prod)`);
      return "";
    }
    return DEV_DEFAULTS[name];
  };

  const int = (name: string, def: number, min: number, max: number): number => {
    const v = raw(name);
    if (v === undefined) return def;
    if (!/^-?\d+$/.test(v)) {
      problems.push(`${name}=${JSON.stringify(v)}: ожидается целое число`);
      return def;
    }
    const n = Number(v);
    if (n < min || n > max) {
      problems.push(`${name}=${n}: допустимо от ${min} до ${max}`);
      return def;
    }
    return n;
  };

  const url = (name: keyof typeof DEV_DEFAULTS): string => {
    const v = required(name);
    if (!v) return v;
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
    } catch {
      problems.push(`${name}=${JSON.stringify(v)}: ожидается http(s) URL`);
    }
    return v.replace(/\/+$/, "");
  };

  const unconfigured: string[] = [];
  /** Адрес домена спринтов 4–7: в stage/prod может отсутствовать (→ null), формат проверяется, если задан. */
  const featureUrl = (name: (typeof FEATURE_URL_VARS)[number]): string | null => {
    if (raw(name) === undefined && isSecure) {
      unconfigured.push(name);
      return null;
    }
    return url(name);
  };

  // ---- внутренний JWT v2 (EdDSA): в stage/prod — только личный ключ и открытые ключи доменов
  const internalJwtPrivateKey = raw("INTERNAL_JWT_PRIVATE_KEY");
  const internalJwtSecret = isSecure ? undefined : (raw("INTERNAL_JWT_SECRET") ?? DEV_DEFAULTS.INTERNAL_JWT_SECRET);
  if (internalJwtPrivateKey !== undefined) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(internalJwtPrivateKey) || Buffer.from(internalJwtPrivateKey, "base64url").length !== 32) {
      problems.push("INTERNAL_JWT_PRIVATE_KEY: ожидается base64url 32-байтного seed (infra/scripts/gen_internal_keys.py)");
    }
  } else if (isSecure) {
    problems.push("INTERNAL_JWT_PRIVATE_KEY не задана (обязательна в stage/prod; dev-деривация ключа запрещена)");
  }
  const internalJwtPublicKeys: Record<string, string> = {};
  const pubRaw = raw("INTERNAL_JWT_PUBLIC_KEYS");
  if (pubRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(pubRaw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== "string" || Buffer.from(v, "base64url").length !== 32) throw new Error(k);
        internalJwtPublicKeys[k] = v;
      }
    } catch {
      problems.push("INTERNAL_JWT_PUBLIC_KEYS: ожидается JSON {issuer: base64url 32 байта}");
    }
  } else if (isSecure) {
    problems.push("INTERNAL_JWT_PUBLIC_KEYS не задана (обязательна в stage/prod)");
  }

  // ---- Redis
  const redisUrl = required("REDIS_URL");
  if (redisUrl && !/^rediss?:\/\//.test(redisUrl)) problems.push("REDIS_URL: ожидается redis:// или rediss:// URL");

  // ---- origin admin-web
  const originRaw = required("ADMIN_WEB_ORIGIN");
  let adminWebOrigin = "";
  if (originRaw) {
    try {
      const u = new URL(originRaw);
      if (u.origin !== originRaw.replace(/\/+$/, "") || originRaw.includes(",")) throw new Error("not an origin");
      if (isSecure && u.protocol !== "https:") problems.push("ADMIN_WEB_ORIGIN: в stage/prod только https");
      adminWebOrigin = u.origin;
    } catch {
      problems.push(`ADMIN_WEB_ORIGIN=${JSON.stringify(originRaw)}: ожидается один origin вида https://host[:port]`);
    }
  }

  const idleSeconds = int("SESSION_IDLE_SECONDS", 1800, 60, 1800);
  const absoluteSeconds = int("SESSION_ABSOLUTE_SECONDS", 28_800, 300, 28_800);
  if (absoluteSeconds < idleSeconds) problems.push("SESSION_ABSOLUTE_SECONDS должен быть не меньше SESSION_IDLE_SECONDS");

  const logLevel = (raw("LOG_LEVEL") ?? "info").toLowerCase().replace(/^warning$/, "warn");
  if (!LOG_LEVELS.includes(logLevel)) problems.push(`LOG_LEVEL=${logLevel}: допустимо ${LOG_LEVELS.join("|")}`);

  const rlEnabledRaw = raw("RATE_LIMITS_ENABLED")?.toLowerCase();
  if (rlEnabledRaw !== undefined && !["true", "false", "1", "0"].includes(rlEnabledRaw)) {
    problems.push(`RATE_LIMITS_ENABLED=${JSON.stringify(rlEnabledRaw)}: допустимо true|false`);
  }
  const rlKeyPrefix = raw("RATE_LIMIT_KEY_PREFIX");
  const redisKeyPrefix = raw("REDIS_KEY_PREFIX") ?? "admin-bff:";

  const runbookBaseUrl = raw("RUNBOOK_BASE_URL") ?? DEFAULT_RUNBOOK_BASE_URL;
  if (!/^https:\/\/[^\s/?#@]+\/[^\s?#]*$/.test(runbookBaseUrl)) problems.push("RUNBOOK_BASE_URL: нужен https-адрес раздела runbook'ов");
  const cfg: Config = {
    nodeEnv,
    env: appEnv,
    runbookBaseUrl,
    isSecure,
    devTools: appEnv === "dev" && !isSecure,
    serviceVersion:
      raw("SERVICE_VERSION") ??
      packageVersion() + (raw("RAILWAY_GIT_COMMIT_SHA") ? `+${raw("RAILWAY_GIT_COMMIT_SHA")?.slice(0, 7)}` : ""),
    port: int("PORT", 8002, 1, 65_535),
    // Railway: приватная сеть — IPv6; "::" в Node — dual-stack (IPv4 тоже)
    host: raw("HOST") ?? "::",
    logLevel,
    trustProxy: int("TRUST_PROXY_HOPS", 2, 0, 10),
    internalJwtSecret,
    internalJwtPrivateKey,
    internalJwtPublicKeys,
    redisUrl,
    redisKeyPrefix,
    adminWebOrigin,
    urls: {
      adminIdentity: url("ADMIN_IDENTITY_URL"),
      userAdmin: url("USER_ADMIN_URL"),
      identity: url("IDENTITY_URL"),
      support: url("SUPPORT_URL"),
      audit: url("AUDIT_URL"),
      experience: url("EXPERIENCE_URL"),
      sourceRegistry: featureUrl("SOURCE_REGISTRY_URL"),
      discovery: featureUrl("DISCOVERY_URL"),
      providerGateway: featureUrl("PROVIDER_GATEWAY_URL"),
      events: featureUrl("EVENTS_URL"),
      offers: featureUrl("OFFERS_URL"),
      news: featureUrl("NEWS_URL"),
      watch: featureUrl("WATCH_URL"),
      aiControl: featureUrl("AI_CONTROL_URL"),
      aiConcierge: featureUrl("AI_CONCIERGE_URL"),
      opsMonitor: featureUrl("OPS_MONITOR_URL"),
    },
    unconfigured,
    upstreamTimeoutMs: int("UPSTREAM_TIMEOUT_MS", 3000, 100, 60_000),
    upstreamRetries: int("UPSTREAM_RETRIES", 1, 0, 5),
    dashboardTimeoutMs: int("DASHBOARD_TIMEOUT_MS", 2000, 100, 30_000),
    healthTimeoutMs: int("HEALTH_TIMEOUT_MS", 1500, 100, 30_000),
    dashboardCacheSeconds: int("DASHBOARD_CACHE_SECONDS", 60, 0, 3600),
    dashboardStaleMaxSeconds: int("DASHBOARD_STALE_MAX_SECONDS", 3600, 0, 86_400),
    dashboardBlockTimeoutMs: int("DASHBOARD_BLOCK_TIMEOUT_MS", 1500, 100, 30_000),
    session: {
      idleSeconds,
      absoluteSeconds,
      stepUpSeconds: int("STEP_UP_SECONDS", 300, 30, 300),
      principalCacheSeconds: int("PRINCIPAL_CACHE_SECONDS", 30, 0, 30),
    },
    rateLimits: {
      loginPerIpPerMinute: int("RATE_LIMIT_LOGIN_IP_PER_MIN", 10, 1, 10_000),
      loginPerEmailPerMinute: int("RATE_LIMIT_LOGIN_EMAIL_PER_MIN", 5, 1, 1000),
      authStepPerIpPerMinute: int("RATE_LIMIT_AUTH_STEP_IP_PER_MIN", 30, 1, 10_000),
      mfaPerMinute: int("RATE_LIMIT_MFA_PER_MIN", 5, 1, 1000),
      staffPerMinute: int("RATE_LIMIT_STAFF_PER_MIN", 300, 1, 100_000),
    },
    rateLimiting: {
      enabled: rlEnabledRaw === undefined || rlEnabledRaw === "true" || rlEnabledRaw === "1",
      overrideRefreshSeconds: int("RATE_LIMIT_OVERRIDE_REFRESH_SECONDS", 30, 1, 600),
      keyPrefix: rlKeyPrefix ?? (appEnv === "test" ? redisKeyPrefix : ""),
    },
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}
