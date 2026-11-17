/**
 * Конфигурация telegram-bff из переменных окружения. Валидируется один раз при старте:
 * при ошибке процесс не поднимается, а в сообщении перечислены ВСЕ проблемные переменные.
 *
 * Окружение: ENV=dev|test|stage|prod (как у Python-сервисов). «Защищённое» окружение (stage/prod или
 * NODE_ENV=production): секреты и адреса обязательны и не могут совпадать с dev-значениями, внутренний JWT
 * подписывается только личным ключом INTERNAL_JWT_PRIVATE_KEY (dev-деривация из INTERNAL_JWT_SECRET запрещена),
 * /openapi.json выключен. В dev/test у секретов и адресов есть dev-значения (локальный стенд).
 */
import { readFileSync } from "node:fs";

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
  /** Запросов в минуту на пользователя (все авторизованные эндпоинты). */
  userPerMinute: number;
  /** POST /v1/session/telegram — с одного IP в минуту. */
  sessionPerIpPerMinute: number;
  /** Проверка PIN/биометрии и прочие операции с PIN/кодом — на пользователя в минуту. */
  pinPerMinute: number;
  /** Публичные эндпоинты (refresh, config, policy) — с одного IP в минуту. */
  publicPerIpPerMinute: number;
  /** Расчёт предложений (GET /v1/events/{id}/offers и …/recalculate) — на пользователя в минуту (спринт 5). */
  offersPerMinute: number;
  /** Реакции «Больше такого» / «Не интересно» — на пользователя в минуту (спринт 6). */
  reactionsPerMinute: number;
  /** Команды слежений (создание, изменение, удаление) — на пользователя в минуту (спринт 6). */
  watchCommandsPerMinute: number;
  /** Ходы AI-консьержа (сообщения и быстрые действия) — на пользователя в минуту (спринт 7, сверх суточной квоты). */
  aiTurnsPerMinute: number;
}

export type AppEnv = "dev" | "test" | "stage" | "prod";

export interface Config {
  nodeEnv: string;
  env: AppEnv;
  /** stage/prod или NODE_ENV=production: без dev-значений, без деривации ключей, без OpenAPI. */
  isSecure: boolean;
  serviceVersion: string;
  port: number;
  host: string;
  logLevel: string;
  /** Число доверенных прокси перед сервисом (Railway edge = 1) — для корректного req.ip. */
  trustProxy: number;

  botToken: string;
  sessionJwtSecret: string;
  /** Только dev/test: из него выводится Ed25519-ключ внутреннего JWT. */
  internalJwtSecret: string | undefined;
  /** base64url seed 32 байта (обязателен в stage/prod). */
  internalJwtPrivateKey: string | undefined;
  /** Открытые ключи издателей {issuer: base64url raw} — BFF только подписывает, поле для единообразия. */
  internalJwtPublicKeys: Record<string, string>;
  redisUrl: string;
  redisKeyPrefix: string;

  /** Спринт 9 (О-1): срок initData — 600 с по умолчанию (было 3600). */
  initDataMaxAgeSeconds: number;
  /** Спринт 9 (О-1): initData одноразовый (хеш в Redis SET NX на срок initData); повтор → 401 INIT_DATA_REPLAYED. */
  initDataOneTime: boolean;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;

  miniappOrigins: string[];

  identityUrl: string;
  preferencesUrl: string;
  supportUrl: string;
  experienceUrl: string;
  /** event-catalog (services/events): каталог событий, деталь, рельсы Home. */
  eventsUrl: string;
  upstreamTimeoutMs: number;
  upstreamRetries: number;
  experienceCacheSeconds: number;
  /** Home: «свежая» копия на пользователя (по умолчанию 60 с) — в течение этого времени каталог не вызывается. */
  homeFreshSeconds: number;
  /** Home: stale-копия (по умолчанию 24 ч) — отдаётся с state "stale", если каталог недоступен (AT-34). */
  homeStaleSeconds: number;
  /** Счётчики быстрых фильтров (GET /v1/events/facets): общий кэш в Redis по набору фильтров, по умолчанию 60 с; 0 — без кэша. */
  facetsCacheSeconds: number;
  /** offers (спринт 5): необязательная — без неё эндпоинты предложений отвечают 503 OFFERS_UNAVAILABLE,
   *  а offer_id в обращении в поддержку не принимается (убирается из контекста). */
  offersUrl: string | undefined;
  /** Таймаут сборки предложения (offers сам укладывается в OFFERS_BUILD_DEADLINE_SECONDS = 20 с). */
  offersTimeoutMs: number;
  /** Предел размера ответа offers (байт): больше — ответ отбрасывается, 503 OFFERS_UNAVAILABLE. */
  offersMaxResponseBytes: number;

  /** Спринт 6 — необязательные домены (без URL: Home работает без секции/баллов, эндпоинты → 503 FEATURE_UNAVAILABLE). */
  recommendationsUrl: string | undefined;
  watchUrl: string | undefined;
  newsUrl: string | undefined;
  /** Спринт 7: ai-concierge (8118); не задан — /v1/ai/* → 503 FEATURE_UNAVAILABLE {feature: "ai"}. */
  aiConciergeUrl: string | undefined;
  /** Таймаут хода консьержа (стрим и запасной JSON-путь) и создания переписки, мс — больше дедлайна хода (60 с). */
  conciergeTimeoutMs: number;
  /** Предел размера ответов recommendations/watch/news (байт): больше — ответ отбрасывается как сбой домена. */
  personalMaxResponseBytes: number;
  /** AT-23: сводка «Пока вас не было», если прошлый визит был не раньше чем столько минут назад (30). */
  summaryGapMinutes: number;
  /** Сколько хранится время прошлого визита (дней, 90). */
  visitTtlDays: number;
  /** Сколько секунд после начала визита повторный запрос Home отдаёт ту же сводку (перерисовка, pull-to-refresh). */
  summaryHoldSeconds: number;
  /** Последний расчёт поездки по событию (для offer_params слежения и trip_per_person ранжирования), дней. */
  lastTripTtlDays: number;

  rateLimits: RateLimits;
  rateLimiting: RateLimiting;
}

/** Dev-значения: годятся только для локального стенда, в production запрещены. */
export const DEV_DEFAULTS = {
  BOT_TOKEN: "123456789:dev-bot-token-change-me-0000000000",
  SESSION_JWT_SECRET: "dev-session-secret-change-me-0123456789abcdef",
  // совпадает с dev-секретом tilhero_common (Python-домены) — локальный стенд работает без настройки
  INTERNAL_JWT_SECRET: "dev-internal-secret-change-me",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  MINIAPP_ORIGIN: "http://localhost:5173",
  IDENTITY_URL: "http://127.0.0.1:8101",
  PREFERENCES_URL: "http://127.0.0.1:8102",
  SUPPORT_URL: "http://127.0.0.1:8103",
  EXPERIENCE_URL: "http://127.0.0.1:8106",
  EVENTS_URL: "http://127.0.0.1:8110",
} as const;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`telegram-bff: некорректная конфигурация окружения:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

/** Версия из package.json сервиса (работает и из src/, и из dist/). */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

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
    if (["dev", "test", "stage", "prod"].includes(envRaw)) appEnv = envRaw as AppEnv;
    else problems.push(`ENV=${JSON.stringify(envRaw)}: допустимо dev|test|stage|prod`);
  }
  const isSecure = nodeEnv === "production" || appEnv === "stage" || appEnv === "prod";

  /** Обязательная в stage/prod переменная; в dev/test — dev-значение. */
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

  /** Необязательный http(s) URL (без значения — функция выключена). */
  const optionalUrl = (name: string): string | undefined => {
    const v = raw(name);
    if (v === undefined) return undefined;
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
    } catch {
      problems.push(`${name}=${JSON.stringify(v)}: ожидается http(s) URL`);
      return undefined;
    }
    return v.replace(/\/+$/, "");
  };

  // ---- секреты
  const botToken = required("BOT_TOKEN");
  const sessionJwtSecret = required("SESSION_JWT_SECRET");
  // Внутренний JWT v2 (EdDSA): в stage/prod — только личный ключ; в dev/test — ключ (если задан) или деривация.
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
  }

  if (sessionJwtSecret && sessionJwtSecret.length < 32) {
    problems.push("SESSION_JWT_SECRET: минимум 32 символа");
  }
  if (isSecure) {
    if (botToken && !/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
      problems.push("BOT_TOKEN: неверный формат токена бота (<id>:<secret>)");
    }
    for (const name of ["BOT_TOKEN", "SESSION_JWT_SECRET"] as const) {
      if (raw(name) === DEV_DEFAULTS[name]) problems.push(`${name}: dev-значение запрещено в stage/prod`);
    }
  }
  if (sessionJwtSecret && sessionJwtSecret === internalJwtSecret) {
    problems.push("SESSION_JWT_SECRET и INTERNAL_JWT_SECRET должны различаться");
  }

  // ---- Redis
  const redisUrl = required("REDIS_URL");
  if (redisUrl && !/^rediss?:\/\//.test(redisUrl)) {
    problems.push("REDIS_URL: ожидается redis:// или rediss:// URL");
  }

  // ---- CORS
  const originsRaw = required("MINIAPP_ORIGIN");
  const miniappOrigins: string[] = [];
  for (const item of originsRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      const u = new URL(item);
      if (u.origin !== item.replace(/\/+$/, "")) throw new Error("not an origin");
      if (isSecure && u.protocol !== "https:") {
        problems.push(`MINIAPP_ORIGIN: ${item} — в stage/prod только https`);
      }
      miniappOrigins.push(u.origin);
    } catch {
      problems.push(`MINIAPP_ORIGIN: ${JSON.stringify(item)} — ожидается origin вида https://host[:port]`);
    }
  }
  if (originsRaw && miniappOrigins.length === 0 && !problems.some((p) => p.startsWith("MINIAPP_ORIGIN"))) {
    problems.push("MINIAPP_ORIGIN: пустой список");
  }

  // ---- сроки
  const initDataMaxAgeSeconds = int("INIT_DATA_MAX_AGE_SECONDS", 600, 60, 86_400);
  const oneTimeRaw = raw("INIT_DATA_ONE_TIME")?.toLowerCase();
  if (oneTimeRaw !== undefined && !["true", "false", "1", "0"].includes(oneTimeRaw)) {
    problems.push(`INIT_DATA_ONE_TIME=${JSON.stringify(oneTimeRaw)}: допустимо true|false`);
  }
  const initDataOneTime = oneTimeRaw === undefined || oneTimeRaw === "true" || oneTimeRaw === "1";
  const accessTtlSeconds = int("ACCESS_TTL_SECONDS", 900, 60, 3600);
  const refreshTtlSeconds = int("REFRESH_TTL_SECONDS", 43_200, 600, 30 * 86_400);
  if (refreshTtlSeconds <= accessTtlSeconds) {
    problems.push("REFRESH_TTL_SECONDS должен быть больше ACCESS_TTL_SECONDS");
  }

  const rlEnabledRaw = raw("RATE_LIMITS_ENABLED")?.toLowerCase();
  if (rlEnabledRaw !== undefined && !["true", "false", "1", "0"].includes(rlEnabledRaw)) {
    problems.push(`RATE_LIMITS_ENABLED=${JSON.stringify(rlEnabledRaw)}: допустимо true|false`);
  }
  const rlKeyPrefix = raw("RATE_LIMIT_KEY_PREFIX");
  const redisKeyPrefix = raw("REDIS_KEY_PREFIX") ?? "bff:";

  const cfg: Config = {
    nodeEnv,
    env: appEnv,
    isSecure,
    serviceVersion:
      raw("SERVICE_VERSION") ??
      packageVersion() + (raw("RAILWAY_GIT_COMMIT_SHA") ? `+${raw("RAILWAY_GIT_COMMIT_SHA")?.slice(0, 7)}` : ""),
    port: int("PORT", 8001, 1, 65_535),
    host: raw("HOST") ?? "::",
    logLevel: (raw("LOG_LEVEL") ?? "info").toLowerCase().replace(/^warning$/, "warn"),
    trustProxy: int("TRUST_PROXY_HOPS", 1, 0, 10),
    botToken,
    sessionJwtSecret,
    internalJwtSecret,
    internalJwtPrivateKey,
    internalJwtPublicKeys,
    redisUrl,
    redisKeyPrefix,
    initDataMaxAgeSeconds,
    initDataOneTime,
    accessTtlSeconds,
    refreshTtlSeconds,
    miniappOrigins,
    identityUrl: url("IDENTITY_URL"),
    preferencesUrl: url("PREFERENCES_URL"),
    supportUrl: url("SUPPORT_URL"),
    experienceUrl: url("EXPERIENCE_URL"),
    eventsUrl: url("EVENTS_URL"),
    upstreamTimeoutMs: int("UPSTREAM_TIMEOUT_MS", 3000, 100, 60_000),
    upstreamRetries: int("UPSTREAM_RETRIES", 1, 0, 5),
    experienceCacheSeconds: int("EXPERIENCE_CACHE_SECONDS", 60, 0, 3600),
    homeFreshSeconds: int("HOME_CACHE_SECONDS", 60, 0, 3600),
    homeStaleSeconds: int("HOME_STALE_SECONDS", 86_400, 60, 7 * 86_400),
    facetsCacheSeconds: int("FACETS_CACHE_SECONDS", 60, 0, 3600),
    offersUrl: optionalUrl("OFFERS_URL"),
    offersTimeoutMs: int("OFFERS_TIMEOUT_MS", 25_000, 1000, 120_000),
    offersMaxResponseBytes: int("OFFERS_MAX_RESPONSE_BYTES", 1_048_576, 16_384, 16_777_216),
    recommendationsUrl: optionalUrl("RECOMMENDATIONS_URL"),
    watchUrl: optionalUrl("WATCH_URL"),
    newsUrl: optionalUrl("NEWS_URL"),
    aiConciergeUrl: optionalUrl("AI_CONCIERGE_URL"),
    conciergeTimeoutMs: int("CONCIERGE_TIMEOUT_MS", 75_000, 5_000, 600_000),
    personalMaxResponseBytes: int("PERSONAL_MAX_RESPONSE_BYTES", 524_288, 16_384, 16_777_216),
    summaryGapMinutes: int("HOME_SUMMARY_GAP_MINUTES", 30, 1, 1440),
    visitTtlDays: int("VISIT_TTL_DAYS", 90, 1, 365),
    summaryHoldSeconds: int("HOME_SUMMARY_HOLD_SECONDS", 600, 0, 3600),
    lastTripTtlDays: int("LAST_TRIP_TTL_DAYS", 30, 1, 365),
    rateLimits: {
      userPerMinute: int("RATE_LIMIT_USER_PER_MIN", 120, 1, 100_000),
      sessionPerIpPerMinute: int("RATE_LIMIT_SESSION_IP_PER_MIN", 10, 1, 100_000),
      pinPerMinute: int("RATE_LIMIT_PIN_PER_MIN", 5, 1, 1000),
      publicPerIpPerMinute: int("RATE_LIMIT_PUBLIC_IP_PER_MIN", 120, 1, 100_000),
      offersPerMinute: int("RATE_LIMIT_OFFERS_PER_MIN", 20, 1, 10_000),
      reactionsPerMinute: int("RATE_LIMIT_REACTIONS_PER_MIN", 60, 1, 10_000),
      watchCommandsPerMinute: int("RATE_LIMIT_WATCH_PER_MIN", 30, 1, 10_000),
      aiTurnsPerMinute: int("AI_RATE_PER_MINUTE", 6, 1, 1_000),
    },
    rateLimiting: {
      enabled: rlEnabledRaw === undefined || rlEnabledRaw === "true" || rlEnabledRaw === "1",
      overrideRefreshSeconds: int("RATE_LIMIT_OVERRIDE_REFRESH_SECONDS", 30, 1, 600),
      keyPrefix: rlKeyPrefix ?? (appEnv === "test" ? redisKeyPrefix : ""),
    },
  };

  if (!["fatal", "error", "warn", "info", "debug", "trace", "silent"].includes(cfg.logLevel)) {
    problems.push(`LOG_LEVEL=${cfg.logLevel}: допустимо fatal|error|warn|info|debug|trace|silent`);
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}
