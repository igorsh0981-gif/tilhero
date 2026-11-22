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
  /** Публичные эндпоинты (refresh, config, policy, просмотр согласия родителя) — с одного IP в минуту. */
  publicPerIpPerMinute: number;
}

export type AppEnv = "dev" | "test" | "stage" | "prod";

/** Спринт 8 — сайт оплаты вне Telegram (INTERNAL_API §3): маршруты /web/v1/* (src/web/, поток H). */
export interface WebPayConfig {
  /** WEB_PAY_ENABLED (false): false — маршруты /web/v1/* не регистрируются (404 NOT_FOUND). */
  enabled: boolean;
  /** WEB_PAY_ORIGIN — origin сайта оплаты (https в stage/prod; не origin Mini App): проверка Origin изменяющих запросов,
   *  redirect_uri OIDC = {origin}/api/auth/callback, возврат после входа. */
  origin: string;
  /** TELEGRAM_LOGIN_CLIENT_ID — Client ID «Log In with Telegram» = ID бота (цифры; BotFather → Login Widget). */
  clientId: string;
  /** TELEGRAM_LOGIN_CLIENT_SECRET — секрет клиента из BotFather (вводит владелец; только у telegram-bff). В лог, ответы и
   *  ошибки конфигурации не попадает. Токен бота для входа на сайт не используется. */
  clientSecret: string;
  /** TELEGRAM_OIDC_BASE (https://oauth.telegram.org): /auth, /token, /.well-known/jwks.json. Другое значение — только
   *  dev/test (мок OIDC стенда). */
  oidcBase: string;
  /** WEB_SESSION_SECRET — подпись cookie-сессии __Host-wp_session (JWT; ≥ 32, отличен от SESSION_JWT_SECRET). */
  sessionSecret: string;
}

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
  /** Прямая ссылка Mini App https://t.me/<bot>/<app> — из неё строится ссылка согласия родителя (?startapp=gc_<token>). */
  telegramAppLink: string;

  /** identity-consent (8101): аккаунт, ученики, возраст, согласия, PIN, удаление. */
  identityUrl: string;
  /** learning-plan (8102): план, график, занятия, справочники целей и тем. */
  learningPlanUrl: string;
  /** support (8103): обращения. */
  supportUrl: string;
  /** notifications (8104): центр уведомлений. */
  notificationsUrl: string;
  /** experience-config (8106): конфигурация Mini App, «Что нового», лента новостей. */
  experienceUrl: string;
  /** social (8109): приглашения и семья; спринт 7 — профиль сообщества, друзья, блокировки, жалобы, санкции, рефералы. */
  socialUrl: string;
  /** catalog (8110, спринт 3): языки и пары, снимок курса, сценарии, медиатека, заявки на песни и фильмы. */
  catalogUrl: string;
  /** diagnostics (8111, спринт 3): входная диагностика, результаты, карта навыков. */
  diagnosticsUrl: string;
  /** lessons (8112, спринт 4): карточка урока, сессии урока / сценария / медиа, шаги, итоги, история. */
  lessonsUrl: string;
  /** assessment (8113, спринт 4): оценка ученика, апелляции. */
  assessmentUrl: string;
  /** Таймаут вызовов lessons и assessment, мс (25 000). Должен быть больше таймаута ИИ в lessons (20 с): шаг ролевой
   *  ситуации и «проще» ждут ИИ; меньший таймаут даёт ученику 503, хотя lessons ответ уже сохранил (ревью R2-02). */
  lessonsTimeoutMs: number;
  /** Таймаут завершения урока, мс (45 000): lessons ждёт оценку assessment до 32 с плюс вспомогательные вызовы. */
  lessonsFinishTimeoutMs: number;
  /** Спринт 7: таймаут long-poll ленты парной комнаты (GET /v1/pair-rooms/{id}/state), мс (30 000): lessons держит запрос
   *  до 25 с — таймаут BFF обязан быть больше (в stage/prod — > 25 000), иначе пустой ответ ожидания станет 503. */
  pairRoomPollTimeoutMs: number;
  /** Спринт 7: таймаут команд парной комнаты, которые синхронно ждут ИИ-коуча (join, turns, leave), мс (30 000; в stage/prod
   *  ≥ 25 000), без повторов — иначе ученик получит 503, хотя lessons ход уже сохранил (как R2-02 уроков). */
  pairRoomCoachTimeoutMs: number;
  /** memory (8116, спринт 5): словарь, «Повторение дня», журнал ошибок, перевод по тапу, произношение. */
  memoryUrl: string;
  /** Таймаут вызовов memory, мс (10 000; INTERNAL_API §8). */
  memoryTimeoutMs: number;
  /** Таймаут перевода по тапу, мс (12 000): memory ждёт `gloss_word` ai-gateway до 8 с плюс catalog. */
  memoryTranslateTimeoutMs: number;
  /** Таймаут оценки произношения, мс (20 000): memory ждёт ai-gateway (Azure) до 15 с. */
  memoryPronunciationTimeoutMs: number;
  upstreamTimeoutMs: number;
  upstreamRetries: number;
  experienceCacheSeconds: number;
  /** Снимок курса catalog (названия навыков для карты): перепроверка по ETag не чаще раза в N секунд. */
  courseSnapshotRevalidateSeconds: number;
  /** Справочник языковых пар catalog: кеш в памяти, секунды. */
  pairsCacheSeconds: number;
  /** Кеш аудио медиатеки в памяти (байты всех файлов, LRU); 0 — без кеша. Каждый ответ всё равно перепроверяется в
   *  catalog (If-None-Match): права и аудитория проверяются при каждом запросе. */
  audioCacheBytes: number;
  /** Сегмент возраста ученика (kids/teens/adults) для контента: кеш в памяти, секунды. */
  audienceCacheSeconds: number;
  /** tts (release 4.1): серверная озвучка фраз (POST /v1/speech). Необязателен даже в stage/prod: без адреса маршрут
   *  отвечает 503 SPEECH_UNAVAILABLE (Mini App откатывается на синтез устройства) — BFF выкладывается раньше tts. */
  ttsUrl: string | undefined;
  /** Таймаут вызова tts, мс (15 000), без повторов: синтез длинной фразы — секунды, кеш у tts. */
  ttsTimeoutMs: number;
  /** gamification (8117, спринт 6): игра ученика и картинки героев/предметов. Необязателен даже в stage/prod: без адреса
   *  маршруты /v1/game/* отвечают 503 GAME_UNAVAILABLE (Mini App скрывает игровой блок, учёба работает). Таймаут и
   *  повторы GET — общие UPSTREAM_TIMEOUT_MS / UPSTREAM_RETRIES. */
  gamificationUrl: string | undefined;
  /** billing (8118, спринт 8): подписка, минуты, заказы Stars Mini App (/v1/billing/*, chn miniapp) и сайт оплаты
   *  (/web/v1/*, chn web). Необязателен даже в stage/prod: без адреса маршруты отвечают 503 BILLING_UNAVAILABLE
   *  (учёба работает). */
  billingUrl: string | undefined;
  /** Таймаут вызовов billing, мс (5000; INTERNAL_API §0.3), повторы GET — UPSTREAM_RETRIES. */
  billingTimeoutMs: number;
  /** Спринт 8: сайт оплаты (/web/v1/*). */
  webPay: WebPayConfig;

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
  TELEGRAM_APP_LINK: "https://t.me/tilhero_dev_bot/app",
  IDENTITY_URL: "http://127.0.0.1:8101",
  LEARNING_PLAN_URL: "http://127.0.0.1:8102",
  SUPPORT_URL: "http://127.0.0.1:8103",
  NOTIFICATIONS_URL: "http://127.0.0.1:8104",
  EXPERIENCE_URL: "http://127.0.0.1:8106",
  SOCIAL_URL: "http://127.0.0.1:8109",
  CATALOG_URL: "http://127.0.0.1:8110",
  DIAGNOSTICS_URL: "http://127.0.0.1:8111",
  LESSONS_URL: "http://127.0.0.1:8112",
  ASSESSMENT_URL: "http://127.0.0.1:8113",
  MEMORY_URL: "http://127.0.0.1:8116",
} as const;

/** Спринт 8 — dev-значения сайта оплаты: явно фиктивные, только локальный стенд; в stage/prod запрещены. */
export const WEB_PAY_DEV_DEFAULTS = {
  WEB_PAY_ORIGIN: "http://localhost:5175",
  TELEGRAM_LOGIN_CLIENT_ID: "1000000001",
  TELEGRAM_LOGIN_CLIENT_SECRET: "dev-telegram-login-client-secret-change-me",
  WEB_SESSION_SECRET: "dev-web-session-secret-change-me-0123456789abcdef",
} as const;
/** Единственный допустимый в stage/prod адрес OIDC Telegram. */
export const TELEGRAM_OIDC_BASE = "https://oauth.telegram.org";

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

  // ---- ссылка Mini App (https://t.me/<bot>/<app>, без query): к ней добавляется ?startapp=gc_<token>
  const telegramAppLink = required("TELEGRAM_APP_LINK").replace(/\/+$/, "");
  if (telegramAppLink && !/^https:\/\/t\.me\/[A-Za-z0-9_]{5,64}\/[A-Za-z0-9_]{3,64}$/.test(telegramAppLink)) {
    problems.push(`TELEGRAM_APP_LINK=${JSON.stringify(telegramAppLink)}: ожидается https://t.me/<bot>/<app>`);
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

  /** Необязательный адрес домена: нет — функция недоступна (503 своим кодом), остальное работает. */
  const optionalUrl = (name: string): string | undefined => {
    const v = raw(name);
    if (v === undefined) return undefined;
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
      return v.replace(/\/+$/, "");
    } catch {
      problems.push(`${name}=${JSON.stringify(v)}: ожидается http(s) URL`);
      return undefined;
    }
  };
  // ---- tts (озвучка) и gamification (игра, спринт 6) — необязательны
  const ttsUrl = optionalUrl("TTS_URL");
  const gamificationUrl = optionalUrl("GAMIFICATION_URL");
  // ---- спринт 8: billing — необязателен (без адреса /v1/billing/* и /web/v1/* отвечают 503 BILLING_UNAVAILABLE)
  const billingUrl = optionalUrl("BILLING_URL");

  // ---- спринт 8: сайт оплаты (INTERNAL_API §3). Выключен — значения не обязательны (заданные всё равно проверяются)
  const webEnabledRaw = raw("WEB_PAY_ENABLED")?.toLowerCase();
  if (webEnabledRaw !== undefined && !["true", "false", "1", "0"].includes(webEnabledRaw)) {
    problems.push(`WEB_PAY_ENABLED=${JSON.stringify(webEnabledRaw)}: допустимо true|false`);
  }
  const webEnabled = webEnabledRaw === "true" || webEnabledRaw === "1";
  /** Значение сайта оплаты: задано — оно; в dev/test — фиктивное dev-значение; в stage/prod при WEB_PAY_ENABLED=true
   *  обязательно (выключенный сайт в stage/prod — пусто). */
  const webValue = (name: keyof typeof WEB_PAY_DEV_DEFAULTS): string => {
    const v = raw(name);
    if (v !== undefined) {
      if (isSecure && v === WEB_PAY_DEV_DEFAULTS[name]) problems.push(`${name}: dev-значение запрещено в stage/prod`);
      return v;
    }
    if (!isSecure) return WEB_PAY_DEV_DEFAULTS[name];
    if (webEnabled) problems.push(`${name} не задана (обязательна в stage/prod при WEB_PAY_ENABLED=true)`);
    return "";
  };
  const webOrigin = webValue("WEB_PAY_ORIGIN").replace(/\/+$/, "");
  if (webOrigin) {
    try {
      const u = new URL(webOrigin);
      if (u.origin !== webOrigin) throw new Error("not an origin");
      if (isSecure && u.protocol !== "https:") problems.push(`WEB_PAY_ORIGIN: ${webOrigin} — в stage/prod только https`);
      if (miniappOrigins.includes(u.origin)) problems.push("WEB_PAY_ORIGIN: сайт оплаты не может совпадать с origin Mini App");
    } catch {
      problems.push(`WEB_PAY_ORIGIN: ${JSON.stringify(webOrigin)} — ожидается origin вида https://host[:port]`);
    }
  }
  const clientId = webValue("TELEGRAM_LOGIN_CLIENT_ID");
  if (clientId && !/^\d{5,20}$/.test(clientId)) problems.push("TELEGRAM_LOGIN_CLIENT_ID: ожидается ID бота (цифры)");
  const clientSecret = webValue("TELEGRAM_LOGIN_CLIENT_SECRET");
  if (clientSecret && clientSecret.length < 16) problems.push("TELEGRAM_LOGIN_CLIENT_SECRET: минимум 16 символов");
  if (clientSecret && clientSecret === botToken) problems.push("TELEGRAM_LOGIN_CLIENT_SECRET не может совпадать с BOT_TOKEN");
  const webSessionSecret = webValue("WEB_SESSION_SECRET");
  if (webSessionSecret && webSessionSecret.length < 32) problems.push("WEB_SESSION_SECRET: минимум 32 символа");
  if (webSessionSecret && (webSessionSecret === sessionJwtSecret || webSessionSecret === internalJwtSecret)) {
    problems.push("WEB_SESSION_SECRET должен отличаться от SESSION_JWT_SECRET и INTERNAL_JWT_SECRET");
  }
  const oidcBase = (raw("TELEGRAM_OIDC_BASE") ?? TELEGRAM_OIDC_BASE).replace(/\/+$/, "");
  if (isSecure && oidcBase !== TELEGRAM_OIDC_BASE) {
    problems.push(`TELEGRAM_OIDC_BASE: в stage/prod только ${TELEGRAM_OIDC_BASE} (подмена — только dev/test)`);
  } else if (!/^https?:\/\/[^/\s]+$/.test(oidcBase)) {
    problems.push(`TELEGRAM_OIDC_BASE=${JSON.stringify(oidcBase)}: ожидается http(s)://host[:port]`);
  }

  const rlEnabledRaw = raw("RATE_LIMITS_ENABLED")?.toLowerCase();
  if (rlEnabledRaw !== undefined && !["true", "false", "1", "0"].includes(rlEnabledRaw)) {
    problems.push(`RATE_LIMITS_ENABLED=${JSON.stringify(rlEnabledRaw)}: допустимо true|false`);
  }
  // ---- спринт 7: long-poll парной комнаты — lessons ждёт до 25 с, BFF ждёт дольше (в dev/test меньше — для тестов)
  const pairRoomPollTimeoutMs = int("PAIR_ROOM_POLL_TIMEOUT_MS", 30_000, 1000, 120_000);
  if (isSecure && pairRoomPollTimeoutMs <= 25_000) {
    problems.push(`PAIR_ROOM_POLL_TIMEOUT_MS=${pairRoomPollTimeoutMs}: в stage/prod больше 25000 (long-poll lessons — до 25 с)`);
  }

  const pairRoomCoachTimeoutMs = int("PAIR_ROOM_COACH_TIMEOUT_MS", 30_000, 1000, 120_000);
  if (isSecure && pairRoomCoachTimeoutMs < 25_000) {
    problems.push(`PAIR_ROOM_COACH_TIMEOUT_MS=${pairRoomCoachTimeoutMs}: в stage/prod не меньше 25000 (вход и ход ждут ИИ-коуча)`);
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
    telegramAppLink,
    identityUrl: url("IDENTITY_URL"),
    learningPlanUrl: url("LEARNING_PLAN_URL"),
    supportUrl: url("SUPPORT_URL"),
    notificationsUrl: url("NOTIFICATIONS_URL"),
    experienceUrl: url("EXPERIENCE_URL"),
    socialUrl: url("SOCIAL_URL"),
    catalogUrl: url("CATALOG_URL"),
    diagnosticsUrl: url("DIAGNOSTICS_URL"),
    lessonsUrl: url("LESSONS_URL"),
    assessmentUrl: url("ASSESSMENT_URL"),
    lessonsTimeoutMs: int("LESSONS_TIMEOUT_MS", 25_000, 1000, 60_000),
    lessonsFinishTimeoutMs: int("LESSONS_FINISH_TIMEOUT_MS", 45_000, 5000, 120_000),
    pairRoomPollTimeoutMs,
    pairRoomCoachTimeoutMs,
    memoryUrl: url("MEMORY_URL"),
    memoryTimeoutMs: int("MEMORY_TIMEOUT_MS", 10_000, 1000, 60_000),
    memoryTranslateTimeoutMs: int("MEMORY_TRANSLATE_TIMEOUT_MS", 12_000, 1000, 60_000),
    memoryPronunciationTimeoutMs: int("MEMORY_PRONUNCIATION_TIMEOUT_MS", 20_000, 1000, 60_000),
    upstreamTimeoutMs: int("UPSTREAM_TIMEOUT_MS", 3000, 100, 60_000),
    upstreamRetries: int("UPSTREAM_RETRIES", 1, 0, 5),
    experienceCacheSeconds: int("EXPERIENCE_CACHE_SECONDS", 60, 0, 3600),
    courseSnapshotRevalidateSeconds: int("COURSE_SNAPSHOT_REVALIDATE_SECONDS", 60, 0, 3600),
    pairsCacheSeconds: int("PAIRS_CACHE_SECONDS", 60, 0, 3600),
    audioCacheBytes: int("AUDIO_CACHE_MB", 32, 0, 512) * 1024 * 1024,
    audienceCacheSeconds: int("AUDIENCE_CACHE_SECONDS", 30, 0, 600),
    ttsUrl,
    ttsTimeoutMs: int("TTS_TIMEOUT_MS", 15_000, 1000, 60_000),
    gamificationUrl,
    billingUrl,
    billingTimeoutMs: int("BILLING_TIMEOUT_MS", 5000, 500, 30_000),
    webPay: { enabled: webEnabled, origin: webOrigin, clientId, clientSecret, oidcBase, sessionSecret: webSessionSecret },
    rateLimits: {
      userPerMinute: int("RATE_LIMIT_USER_PER_MIN", 120, 1, 100_000),
      sessionPerIpPerMinute: int("RATE_LIMIT_SESSION_IP_PER_MIN", 10, 1, 100_000),
      pinPerMinute: int("RATE_LIMIT_PIN_PER_MIN", 5, 1, 1000),
      publicPerIpPerMinute: int("RATE_LIMIT_PUBLIC_IP_PER_MIN", 120, 1, 100_000),
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
