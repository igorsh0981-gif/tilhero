/**
 * Сборка admin-bff: buildApp(config, deps) — для main.ts и тестов (Redis, fetch и часы подменяются).
 *
 * Публичного домена нет: admin-web (Caddy) проксирует /admin/v1/* на приватный адрес admin-bff — один origin,
 * поэтому CORS не включается (кросс-доменные запросы браузера отклоняются самим браузером).
 */
import { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { AppError, KeyRing, buildBase } from "@tilhero/ts-common";
import { registerAuth } from "./auth.js";
import type { Config } from "./config.js";
import { PrincipalCache, StaffNames, makeStoreGuard, type BffContext } from "./context.js";
import { schemaErrors, type App } from "./http.js";
import { EXTRA_REDACT_PATHS, scrub, type LogSink } from "./logging.js";
import { createLimiter } from "./rateLimit.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes } from "./routes/billing.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { experienceRoutes } from "./routes/experience.js";
import { reviewRoutes } from "./routes/review.js";
import { sourceRoutes } from "./routes/sources.js";
import { travelRoutes } from "./routes/travel.js";
import { newsRoutes } from "./routes/news.js";
import { limitsRoutes } from "./routes/limits.js";
import { watchRoutes } from "./routes/watch.js";
import { aiRoutes } from "./routes/ai.js";
import { usageRoutes } from "./routes/usage.js";
import { opsRoutes } from "./routes/ops.js";
import { alertRoutes } from "./routes/alerts.js";
import { deletionRoutes } from "./routes/deletions.js";
import { rateLimitRoutes } from "./routes/ratelimits.js";
import { skillRoutes } from "./routes/skills.js";
import { staffRoutes } from "./routes/staff.js";
import { supportRoutes } from "./routes/support.js";
import { userRoutes } from "./routes/users.js";
import { SessionStore } from "./sessions.js";
import { SERVICE_NAME, createDomains } from "./upstream.js";
import { setRunbookBase } from "./routes/opsCodecs.js";

export interface AppDeps {
  redis?: Redis;
  fetchImpl?: typeof fetch;
  logStream?: LogSink;
  /** Часы (мс epoch) — тесты бездействия/абсолютного срока/step-up. */
  now?: () => number;
  /** Только тесты: объект ответа ДО сериализации (строгая проверка схем контракта Ajv). */
  responseProbe?: (req: FastifyRequest, reply: FastifyReply, payload: unknown) => void;
}

/** Зарегистрированный маршрут /admin/v1/* и объявленный доступ (тест A30 перебирает их все). */
export interface RegisteredRoute {
  method: string;
  url: string;
  access: "public" | "session";
  guard: string;
  stepUp: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    adminRoutes: RegisteredRoute[];
  }
}

export function createRedis(url: string): Redis {
  return new Redis(url, {
    family: 0, // IPv4 и IPv6: приватная сеть Railway
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

/**
 * Fail-closed: маршрут /admin/v1/* без объявленного доступа (publicAuth / requirePermission / requireRole /
 * authenticated) или без схемы ответа не регистрируется — приложение не стартует. Вне /admin/v1 — только /health/*.
 */
export function assertRouteDeclared(
  method: string,
  url: string,
  config: Record<string, unknown> | undefined,
  schema?: { response?: Record<string, unknown> } | undefined,
): RegisteredRoute | null {
  if (url.startsWith("/health/")) return null;
  if (!url.startsWith("/admin/v1/")) throw new Error(`admin-bff: маршрут ${method} ${url} вне /admin/v1`);
  const access = config?.access;
  if (access !== "public" && access !== "session") {
    throw new Error(`admin-bff: маршрут ${method} ${url} без объявленного доступа (requirePermission/publicAuth)`);
  }
  const guard = config?.guard as { kind?: string; anyOf?: string[]; role?: string } | undefined;
  if (access === "session" && !guard?.kind) {
    throw new Error(`admin-bff: маршрут ${method} ${url} без объявленного права`);
  }
  if (access === "public" && (guard || config?.stepUp)) {
    throw new Error(`admin-bff: публичный маршрут ${method} ${url} не может требовать право/step-up`);
  }
  // ответ фильтруется схемой контракта (responses.ts): без неё тело домена ушло бы клиенту целиком
  if (!schema?.response || Object.keys(schema.response).length === 0) {
    throw new Error(`admin-bff: маршрут ${method} ${url} без схемы ответа (responses.ts)`);
  }
  const label = !guard
    ? "public"
    : guard.kind === "permission"
      ? (guard.anyOf ?? []).join("|")
      : guard.kind === "role"
        ? `role:${guard.role}`
        : "authenticated";
  return { method, url, access, guard: label, stepUp: config?.stepUp === true };
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<App> {
  setRunbookBase(config.runbookBaseUrl); // ссылки «Runbook» оповещений — только внутри раздела (ревью спринта 9)
  const ownRedis = !deps.redis;
  const redis = deps.redis ?? createRedis(config.redisUrl);
  const now = deps.now ?? (() => Date.now());

  const keyRing = KeyRing.fromConfig({
    issuer: SERVICE_NAME,
    privateKey: config.internalJwtPrivateKey,
    publicKeys: config.internalJwtPublicKeys,
    secret: config.internalJwtSecret,
    secure: config.isSecure,
  });

  const app = await buildBase({
    serviceName: SERVICE_NAME,
    version: config.serviceVersion,
    logLevel: config.logLevel,
    readiness: async () => ({ redis: await ping(redis) }),
    redactPaths: EXTRA_REDACT_PATHS,
    logFormatter: (obj) => scrub(obj) as Record<string, unknown>,
    ...(deps.logStream ? { logStream: deps.logStream } : {}),
    // edge Railway → Caddy admin-web → admin-bff: req.ip — адрес, добавленный edge (подмена клиентом не помогает)
    trustProxy: config.trustProxy,
    fastify: {
      logController: new LogController({ disableRequestLogging: true }),
      schemaErrorFormatter: schemaErrors(),
      exposeHeadRoutes: false,
      // тело — строгие типы: без приведения и без молчаливого удаления лишних полей (лишнее поле → 422)
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: true, allErrors: false } },
    },
  });
  const log = app.log;
  if (config.unconfigured.length > 0) {
    // порядок выкладки: код спринтов 4–7 мог выйти раньше переменных — разделы закрыты (503 FEATURE_UNAVAILABLE)
    log.warn({ missing: config.unconfigured }, "sprint 4-7 domain urls are not configured, these sections respond 503 FEATURE_UNAVAILABLE");
  }
  const onRedisError = (err: Error) => log.warn({ err_name: err.name, err_message: err.message }, "redis connection error");
  redis.on("error", onRedisError);

  app.decorate("adminRoutes", [] as RegisteredRoute[]);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      const r = assertRouteDeclared(
        String(m),
        route.url,
        route.config as Record<string, unknown> | undefined,
        route.schema as { response?: Record<string, unknown> } | undefined,
      );
      if (r) app.adminRoutes.push(r);
    }
  });

  // JSON: пустое тело у POST без параметров допустимо; ошибка разбора — без эха тела запроса.
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

  // POST без тела (approve без note, take, ai-draft) = пустой объект: схема тела проверяет обязательные поля
  app.addHook("preValidation", async (req) => {
    if (req.body === undefined && req.method !== "GET" && req.routeOptions.schema?.body) req.body = {};
  });

  const store = makeStoreGuard(log);
  const domains = createDomains({
    key: keyRing,
    urls: config.urls,
    timeoutMs: config.upstreamTimeoutMs,
    retries: config.upstreamRetries,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    onFailure: (info) =>
      log.warn({ upstream: info.service, upstream_status: info.status, upstream_code: info.code }, "domain unavailable"),
  });
  const ctx: BffContext = {
    config,
    redis,
    sessions: new SessionStore(redis, config.redisKeyPrefix, {
      idleMs: config.session.idleSeconds * 1000,
      absoluteMs: config.session.absoluteSeconds * 1000,
    }),
    limiter: createLimiter(redis, config, log),
    domains,
    principals: new PrincipalCache(redis, config.redisKeyPrefix, config.session.principalCacheSeconds, domains.adminIdentity, store),
    names: new StaffNames(domains.adminIdentity, log),
    log,
    now,
    store,
  };

  registerAuth(app, ctx);

  app.addHook("onSend", async (_req, reply, payload) => {
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("cache-control", "no-store");
    void reply.header("x-frame-options", "DENY");
    void reply.header("referrer-policy", "no-referrer");
    // спринт 9 (SEC-12): ответы API — данные, не документы: никаких ресурсов и встраивания; чужим origin не отдаются
    void reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    void reply.header("cross-origin-resource-policy", "same-origin");
    return payload;
  });

  if (deps.responseProbe) {
    const probe = deps.responseProbe;
    app.addHook("preSerialization", async (req, reply, payload) => {
      probe(req, reply, payload);
      return payload;
    });
  }

  app.addHook("onResponse", async (req, reply) => {
    if (!req.routeOptions.config?.access && reply.statusCode < 400) return; // health — без access-лога
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

  authRoutes(app, ctx);
  dashboardRoutes(app, ctx);
  userRoutes(app, ctx);
  supportRoutes(app, ctx);
  staffRoutes(app, ctx);
  auditRoutes(app, ctx);
  experienceRoutes(app, ctx);
  billingRoutes(app);
  reviewRoutes(app, ctx);
  sourceRoutes(app, ctx);
  discoveryRoutes(app, ctx);
  limitsRoutes(app, ctx);
  travelRoutes(app, ctx);
  newsRoutes(app, ctx);
  watchRoutes(app, ctx);
  // спринт 7: учёт и стоимость AI, бюджеты и kill switch, агенты и skills, Test Console, уровни доступа
  aiRoutes(app, ctx);
  usageRoutes(app, ctx);
  opsRoutes(app, ctx);
  alertRoutes(app, ctx);
  deletionRoutes(app, ctx);
  rateLimitRoutes(app, ctx);
  skillRoutes(app, ctx);

  app.addHook("onClose", async () => {
    redis.off("error", onRedisError);
    if (ownRedis) await redis.quit().catch(() => undefined);
  });

  return app;
}
