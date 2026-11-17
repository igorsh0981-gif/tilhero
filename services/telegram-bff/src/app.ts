/**
 * Сборка telegram-bff: buildApp(config, deps) — для main.ts и тестов (Redis и fetch подменяются).
 */
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Ajv } from "ajv";
import { LogController } from "fastify";
import { Redis } from "ioredis";
import { AppError, KeyRing, buildBase } from "@tilhero/ts-common";
import { registerAuth } from "./auth.js";
import type { Config } from "./config.js";
import { makeStoreGuard, type BffContext } from "./context.js";
import { EventsCatalog } from "./events.js";
import { ExperienceCache } from "./experience.js";
import { FacetsService } from "./facets.js";
import { HomeService } from "./home.js";
import { OffersService } from "./offers.js";
import { LastTripStore, NewsService, RecommendationsService, WatchService } from "./personal.js";
import { personalRoutes } from "./routes/personal.js";
import { aiRoutes } from "./routes/ai.js";
import { ConciergeService } from "./ai.js";
import { schemaErrors, type App } from "./http.js";
import { EXTRA_REDACT_PATHS, scrub, type LogSink } from "./logging.js";
import { createLimiter } from "./rateLimit.js";
import { eventsRoutes } from "./routes/events.js";
import { offersRoutes } from "./routes/offers.js";
import { profileRoutes } from "./routes/profile.js";
import { referenceRoutes } from "./routes/reference.js";
import { sessionRoutes } from "./routes/session.js";
import { supportRoutes } from "./routes/support.js";
import { SessionStore } from "./sessions.js";
import { AccessTokens } from "./tokens.js";
import { whatsNewRoutes } from "./routes/whatsNew.js";
import { ReleaseNotesFeed } from "./whatsNew.js";
import { SERVICE_NAME, createDomains } from "./upstream.js";

export interface AppDeps {
  /** Внешний Redis (тесты); иначе создаётся по REDIS_URL и закрывается вместе с приложением. */
  redis?: Redis;
  /** fetch для вызовов доменов (тесты — мок-домены). */
  fetchImpl?: typeof fetch;
  /** Поток логов (тесты перехватывают строки). */
  logStream?: LogSink;
}

export function createRedis(url: string): Redis {
  return new Redis(url, {
    family: 0, // IPv4 и IPv6: приватная сеть Railway (в старых окружениях — только IPv6)
    maxRetriesPerRequest: 1,
    enableAutoPipelining: true,
    connectTimeout: 3000,
    commandTimeout: 2000,
  });
}

async function ping(redis: Redis): Promise<"ok" | "down"> {
  try {
    const res = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000).unref()),
    ]);
    return res === "PONG" ? "ok" : "down";
  } catch {
    return "down";
  }
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<App> {
  const ownRedis = !deps.redis;
  const redis = deps.redis ?? createRedis(config.redisUrl);
  const version = config.serviceVersion;

  // Внутренний JWT v2: в stage/prod — личный ключ, в dev/test — деривация из INTERNAL_JWT_SECRET (ts-common).
  const keyRing = KeyRing.fromConfig({
    issuer: SERVICE_NAME,
    privateKey: config.internalJwtPrivateKey,
    publicKeys: config.internalJwtPublicKeys,
    secret: config.internalJwtSecret,
    secure: config.isSecure,
  });

  const base = await buildBase({
    serviceName: SERVICE_NAME,
    version,
    logLevel: config.logLevel,
    readiness: async () => ({ redis: await ping(redis) }),
    redactPaths: EXTRA_REDACT_PATHS,
    // рекурсивная вычистка известных ключей в любом месте объекта лога (как tilhero_common.logging)
    logFormatter: (obj) => scrub(obj) as Record<string, unknown>,
    ...(deps.logStream ? { logStream: deps.logStream } : {}),
    // Railway edge — один доверенный прокси: req.ip = адрес, добавленный им (подмена X-Forwarded-For клиентом не помогает)
    trustProxy: config.trustProxy,
    fastify: {
      // свои access-логи (onResponse) с route-шаблоном, duration_ms и outcome вместо стандартных
      logController: new LogController({ disableRequestLogging: true }),
      schemaErrorFormatter: schemaErrors(),
    },
  });
  const app = base.withTypeProvider<TypeBoxTypeProvider>();
  // Тело запроса — JSON с настоящими типами, приведение типов к нему не применяется. С общим coerceTypes Ajv
  // превращал null в 0 в nullable-полях (anyOf [integer, null]): budget {preset:"1000_2000", custom_amount:null}
  // от Mini App уходил в preferences как custom_amount:0 → 422, а "1500" молча становилось 1500 (e2e, дефект BFF-1).
  // Приведение остаётся только для querystring/params/headers — там все значения строки.
  app.setValidatorCompiler(bodyAwareValidatorCompiler());
  const log = app.log;
  const onRedisError = (err: Error) => log.warn({ err_name: err.name, err_message: err.message }, "redis connection error");
  redis.on("error", onRedisError);

  // Ответы сериализуются ПО СХЕМЕ (fast-json-stringify): в Mini App уходят только поля контракта bff.ts,
  // служебные поля доменов (user_id, внутренние заметки, assignee и т. п.) отбрасываются (ревью T2).
  // Каждый маршрут /v1 обязан объявить схему успешного ответа — иначе приложение не стартует.
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/v1/") || route.method === "HEAD") return;
    const response = (route.schema as { response?: Record<string, unknown> } | undefined)?.response ?? {};
    if (!Object.keys(response).some((s) => /^2\d\d$/.test(s))) {
      throw new Error(`telegram-bff: маршрут ${String(route.method)} ${route.url} без схемы ответа 2xx`);
    }
  });

  // JSON: пустое тело у POST без параметров — допустимо; ошибка разбора — без эха тела запроса в ответе.
  const defaultJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    defaultJson(req, text, (err, parsed) => {
      if (err) return done(new AppError(400, "INVALID_JSON", "Тело запроса — некорректный JSON"), undefined);
      done(null, parsed);
    });
  });

  await app.register(cors, {
    origin: config.miniappOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-trace-id", "x-correlation-id"],
    exposedHeaders: ["x-trace-id", "x-correlation-id", "retry-after"],
    credentials: false,
    maxAge: 600,
  });

  if (!config.isSecure) {
    await app.register(swagger, {
      openapi: {
        openapi: "3.1.0",
        info: {
          title: "TilHero telegram-bff",
          version,
          description:
            "Публичный API Mini App (контракт packages/contracts/src/bff.ts). Ошибки — ErrorBody {code, message, trace_id, details}.",
        },
        components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
        tags: [
          { name: "session" },
          { name: "profile" },
          { name: "preferences" },
          { name: "security" },
          { name: "consent" },
          { name: "account" },
          { name: "directory" },
          { name: "experience" },
          { name: "home" },
          { name: "events" },
          { name: "offers" },
          { name: "support" },
          { name: "recommendations" },
          { name: "watch" },
          { name: "news" },
          { name: "ai" },
          { name: "whats-new" },
        ],
      },
      hideUntagged: true,
    });
  }

  const sessions = new SessionStore(redis, config.redisKeyPrefix, config.refreshTtlSeconds);
  const domains = createDomains({
    key: keyRing,
    urls: {
      identity: config.identityUrl,
      preferences: config.preferencesUrl,
      support: config.supportUrl,
      experience: config.experienceUrl,
      events: config.eventsUrl,
      offers: config.offersUrl,
      recommendations: config.recommendationsUrl,
      watch: config.watchUrl,
      news: config.newsUrl,
      aiConcierge: config.aiConciergeUrl,
    },
    personalMaxResponseBytes: config.personalMaxResponseBytes,
    conciergeTimeoutMs: config.conciergeTimeoutMs,
    timeoutMs: config.upstreamTimeoutMs,
    offersTimeoutMs: config.offersTimeoutMs,
    offersMaxResponseBytes: config.offersMaxResponseBytes,
    retries: config.upstreamRetries,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    onFailure: (info) =>
      log.warn({ upstream: info.service, upstream_status: info.status, upstream_code: info.code }, "domain unavailable"),
  });
  const experience = new ExperienceCache(domains.experience, config.experienceCacheSeconds * 1000, () =>
    log.warn({ upstream: "experience-config" }, "experience-config unavailable, serving stale config"),
  );
  const catalog = new EventsCatalog(domains.events, log);
  const recommendations = new RecommendationsService(domains.recommendations, log);
  const watch = new WatchService(domains.watch, domains.watchCreate, log);
  const news = new NewsService(domains.news, log);
  const lastTrip = new LastTripStore(redis, config.redisKeyPrefix, config.lastTripTtlDays * 86_400, log);
  const ctx: BffContext = {
    config,
    redis,
    sessions,
    limiter: createLimiter(redis, config, log),
    tokens: new AccessTokens(config.sessionJwtSecret, config.accessTtlSeconds),
    domains,
    experience,
    whatsNew: new ReleaseNotesFeed(domains.experience, config.experienceCacheSeconds * 1000, () =>
      log.warn({ upstream: "experience-config" }, "experience-config unavailable, serving stale release notes"),
    ),
    catalog,
    facets: new FacetsService({ redis, catalog, keyPrefix: config.redisKeyPrefix, ttlSeconds: config.facetsCacheSeconds, log }),
    home: new HomeService({
      config,
      redis,
      catalog,
      preferences: domains.preferences,
      identity: domains.identity,
      experience,
      recommendations,
      watch,
      news,
      lastTrip,
      log,
    }),
    offers: new OffersService({
      offers: domains.offers,
      offersRead: domains.offersRead,
      preferences: domains.preferences,
      identity: domains.identity,
      lastTrip,
      log,
    }),
    recommendations,
    watch,
    news,
    lastTrip,
    concierge: new ConciergeService({
      ai: domains.ai,
      aiLong: domains.aiLong,
      baseUrl: config.aiConciergeUrl,
      key: keyRing,
      timeoutMs: config.conciergeTimeoutMs,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      log,
    }),
    log,
    store: makeStoreGuard(log),
  };

  registerAuth(app, ctx);

  app.addHook("onSend", async (_req, reply, payload) => {
    void reply.header("x-content-type-options", "nosniff");
    if (!reply.hasHeader("cache-control")) void reply.header("cache-control", "no-store");
    // 503 с details.retry_after (AI_BUSY, спринт 7) — Retry-After, как у 429 (общий обработчик ставит его только для 429/423)
    if (reply.statusCode === 503 && !reply.hasHeader("retry-after") && typeof payload === "string" && payload.includes('"retry_after"')) {
      try {
        const ra = (JSON.parse(payload) as { details?: { retry_after?: unknown } }).details?.retry_after;
        if (typeof ra === "number" && Number.isInteger(ra) && ra > 0 && ra <= 86_400) void reply.header("retry-after", String(ra));
      } catch {
        /* не JSON */
      }
    }
    return payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    if (!req.routeOptions.config?.access && reply.statusCode < 400) return; // health/openapi — без access-лога
    const status = reply.statusCode;
    req.log.info(
      {
        method: req.method,
        route: req.routeOptions.url ?? "unmatched",
        status_code: status,
        duration_ms: Math.round(reply.elapsedTime * 10) / 10,
        outcome: status >= 500 ? "server_error" : status >= 400 ? "client_error" : "success",
      },
      "request completed",
    );
  });

  sessionRoutes(app, ctx);
  profileRoutes(app, ctx);
  referenceRoutes(app, ctx);
  eventsRoutes(app, ctx);
  offersRoutes(app, ctx);
  supportRoutes(app, ctx);
  personalRoutes(app, ctx);
  aiRoutes(app, ctx);
  whatsNewRoutes(app, ctx);

  if (!config.isSecure) {
    app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  }

  app.addHook("onClose", async () => {
    redis.off("error", onRedisError);
    if (ownRedis) await redis.quit().catch(() => undefined);
  });

  return app;
}

/** Компилятор схем: тело — без приведения типов, остальные части запроса — как по умолчанию в Fastify. */
export function bodyAwareValidatorCompiler() {
  const common = { removeAdditional: false, useDefaults: true, allErrors: false, addUsedSchema: false } as const;
  const bodyAjv = new Ajv({ ...common, coerceTypes: false });
  const partsAjv = new Ajv({ ...common, coerceTypes: "array" });
  return ({ schema, httpPart }: { schema: object; httpPart?: string }) =>
    (httpPart === "body" ? bodyAjv : partsAjv).compile(schema);
}
