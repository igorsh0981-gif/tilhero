/**
 * Сборка telegram-bff: buildApp(config, deps) — для main.ts и тестов (Redis и fetch подменяются).
 */
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Ajv } from "ajv";
import { LogController, type FastifyReply } from "fastify";
import { Redis } from "ioredis";
import { AppError, KeyRing, buildBase, errorBody } from "@tilhero/ts-common";
import { registerAuth } from "./auth.js";
import type { Config } from "./config.js";
import { makeStoreGuard, type BffContext } from "./context.js";
import { AudienceResolver, AudioCache, PairsCache, SnapshotCache } from "./content.js";
import { ExperienceCache } from "./experience.js";
import { schemaErrors, type App } from "./http.js";
import { EXTRA_REDACT_PATHS, scrub, type LogSink } from "./logging.js";
import { createLimiter } from "./rateLimit.js";
import { familyRoutes } from "./routes/family.js";
import { lessonsRoutes } from "./routes/lessons.js";
import { contentRoutes } from "./routes/content.js";
import { diagnosticsRoutes } from "./routes/diagnostics.js";
import { notificationsRoutes } from "./routes/notifications.js";
import { planRoutes } from "./routes/plan.js";
import { profileRoutes } from "./routes/profile.js";
import { sessionRoutes } from "./routes/session.js";
import { speechRoutes } from "./routes/speech.js";
import { supportRoutes } from "./routes/support.js";
import { whatsNewRoutes } from "./routes/whatsNew.js";
import { SessionStore } from "./sessions.js";
import { AccessTokens } from "./tokens.js";
import { SERVICE_NAME, createDomains, createTts } from "./upstream.js";

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
      // Ошибки роутера (битый URL, слишком длинный параметр) — в формате ErrorBody и без эха пути: в пути бывают
      // токены (согласие родителя). Слишком длинный id/токен не может существовать → 404.
      frameworkErrors: (err, _req, reply) => {
        const tooLong = (err as { code?: string }).code === "FST_ERR_MAX_PARAM_LENGTH";
        const r = reply as unknown as FastifyReply;
        void r
          .code(tooLong ? 404 : 400)
          .header("cache-control", "no-store")
          .send(tooLong ? errorBody("NOT_FOUND", "Не найдено") : errorBody("BAD_REQUEST", "Некорректный адрес запроса"));
      },
    },
  });
  const app = base.withTypeProvider<TypeBoxTypeProvider>();
  // Тело запроса — JSON с настоящими типами, приведение типов к нему не применяется (null в nullable-полях не
  // становится 0, "30" не становится 30 — урок aievent BFF-1). Приведение — только для querystring/params/headers.
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
    allowedHeaders: ["authorization", "content-type", "idempotency-key", "if-match", "if-none-match", "x-timezone", "x-trace-id", "x-correlation-id"],
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
          { name: "learners" },
          { name: "guardian" },
          { name: "security" },
          { name: "consent" },
          { name: "account" },
          { name: "plan" },
          { name: "directory" },
          { name: "notifications" },
          { name: "invites" },
          { name: "whats-new" },
          { name: "experience" },
          { name: "support" },
          { name: "languages" },
          { name: "diagnostics" },
          { name: "skills" },
          { name: "scenarios" },
          { name: "media" },
          { name: "lessons" },
          { name: "assessment" },
          { name: "speech" },
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
      learningPlan: config.learningPlanUrl,
      support: config.supportUrl,
      notifications: config.notificationsUrl,
      experience: config.experienceUrl,
      social: config.socialUrl,
      catalog: config.catalogUrl,
      diagnostics: config.diagnosticsUrl,
      lessons: config.lessonsUrl,
      assessment: config.assessmentUrl,
    },
    timeoutMs: config.upstreamTimeoutMs,
    lessonsTimeoutMs: config.lessonsTimeoutMs,
    retries: config.upstreamRetries,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    onFailure: (info) =>
      log.warn({ upstream: info.service, upstream_status: info.status, upstream_code: info.code }, "domain unavailable"),
  });
  const ctx: BffContext = {
    config,
    redis,
    sessions,
    limiter: createLimiter(redis, config, log),
    tokens: new AccessTokens(config.sessionJwtSecret, config.accessTtlSeconds),
    domains,
    experience: new ExperienceCache(domains.experience, config.experienceCacheSeconds * 1000, () =>
      log.warn({ upstream: "experience-config" }, "experience-config unavailable, serving stale config"),
    ),
    audience: new AudienceResolver(config.audienceCacheSeconds * 1000),
    pairs: new PairsCache(domains.catalog, config.pairsCacheSeconds * 1000, log),
    snapshots: new SnapshotCache(domains.catalogRaw, config.courseSnapshotRevalidateSeconds * 1000, log),
    audio: new AudioCache(config.audioCacheBytes),
    tts: createTts({
      url: config.ttsUrl,
      key: keyRing,
      timeoutMs: config.ttsTimeoutMs,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      onFailure: (info) =>
        log.warn({ upstream: info.service, upstream_status: info.status, upstream_code: info.code }, "domain unavailable"),
    }),
    log,
    store: makeStoreGuard(log),
  };
  // tts необязателен (BFF выкладывается раньше него): одно предупреждение при старте, маршрут отвечает 503
  if (!ctx.tts) log.warn({ upstream: "tts" }, "TTS_URL is not set: POST /v1/speech answers 503 SPEECH_UNAVAILABLE");

  registerAuth(app, ctx);

  app.addHook("onSend", async (_req, reply, payload) => {
    void reply.header("x-content-type-options", "nosniff");
    if (!reply.hasHeader("cache-control")) void reply.header("cache-control", "no-store");
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
  familyRoutes(app, ctx);
  planRoutes(app, ctx);
  notificationsRoutes(app, ctx);
  whatsNewRoutes(app, ctx);
  supportRoutes(app, ctx);
  diagnosticsRoutes(app, ctx);
  contentRoutes(app, ctx);
  lessonsRoutes(app, ctx);
  speechRoutes(app, ctx);

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
