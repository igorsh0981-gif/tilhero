/**
 * Fastify-каркас BFF: контекст трассировки, формат ошибок, health, вычистка PII из логов.
 *
 *   const app = await buildBase({ serviceName: "telegram-bff", version, readiness: async () => ({redis: "ok"}) });
 */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import fp from "fastify-plugin";
import {
  CAUSATION_HEADER,
  CORRELATION_HEADER,
  TRACE_HEADER,
  runWithContext,
  newId,
  currentContext,
} from "./context.js";
import { AppError, errorBody } from "./errors.js";

export interface LogSink {
  write(msg: string): void;
}

export interface BaseOptions {
  serviceName: string;
  version: string;
  logLevel?: string;
  readiness?: () => Promise<Record<string, "ok" | "down">>;
  /** Дополнительные redact-пути pino (к REDACT_PATHS). */
  redactPaths?: string[];
  /** Пост-обработка объекта лога (например, рекурсивная вычистка ключей) — pino formatters.log. */
  logFormatter?: (obj: Record<string, unknown>) => Record<string, unknown>;
  /** Поток логов (тесты перехватывают строки); по умолчанию stdout. */
  logStream?: LogSink;
  /**
   * Доверенные прокси для req.ip (X-Forwarded-For). По умолчанию false — иначе клиент подменяет IP
   * своим заголовком. За Railway edge — 1 (число хопов) или функция.
   */
  trustProxy?: FastifyServerOptions["trustProxy"] | number;
  fastify?: FastifyServerOptions;
}

/** Принимаемый формат входящих x-trace-id / x-correlation-id (как в py-common); иначе генерируется новый. */
export const TRACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function cleanId(v: unknown): string | undefined {
  return typeof v === "string" && TRACE_ID_RE.test(v) ? v : undefined;
}

/** Пути, которые никогда не пишутся в лог (initData, PIN, токены, тексты). */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-internal-token"]',
  "req.body.initData",
  "req.body.init_data",
  "req.body.pin",
  "req.body.current_pin",
  "req.body.new_pin",
  "req.body.code",
  "req.body.refresh_token",
  "req.body.message",
  "req.body.text",
];

const contextPlugin = fp(async (app: FastifyInstance) => {
  // storage.run(ctx, done) — контекст гарантированно доходит до обработчика и всех его продолжений
  app.addHook("onRequest", (req, reply, done) => {
    const h = req.headers;
    const traceId = cleanId(h[TRACE_HEADER]) ?? newId();
    const causationId = cleanId(h[CAUSATION_HEADER]);
    const ctx = {
      traceId,
      correlationId: cleanId(h[CORRELATION_HEADER]) ?? traceId,
      ...(causationId ? { causationId } : {}),
    };
    reply.header(TRACE_HEADER, ctx.traceId);
    reply.header(CORRELATION_HEADER, ctx.correlationId);
    runWithContext(ctx, done);
  });
});

const errorPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError || (err as { name?: string }).name === "AppError") {
      const e = err as AppError;
      if ((e.status === 429 || e.status === 423) && typeof e.details.retry_after === "number") {
        void reply.header("retry-after", String(e.details.retry_after));
      }
      if (e.status >= 500) req.log.warn({ code: e.code, status: e.status }, "upstream error");
      return reply.status(e.status).send(e.toBody());
    }
    const fe = err as { validation?: unknown; statusCode?: number; code?: string; message: string };
    if (fe.validation) {
      return reply.status(422).send(errorBody("VALIDATION_ERROR", "Некорректные данные запроса", { errors: fe.validation }));
    }
    if (fe.statusCode && fe.statusCode < 500) {
      const code =
        fe.statusCode === 429
          ? "RATE_LIMITED"
          : fe.statusCode === 404
            ? "NOT_FOUND"
            : fe.statusCode === 413
              ? "PAYLOAD_TOO_LARGE"
              : "BAD_REQUEST";
      return reply.status(fe.statusCode).send(errorBody(code, fe.message));
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send(errorBody("INTERNAL_ERROR", "Внутренняя ошибка сервиса"));
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(errorBody("NOT_FOUND", "Маршрут не найден")));
});

export async function buildBase(opts: BaseOptions): Promise<FastifyInstance> {
  const tp = opts.trustProxy ?? false;
  const trustProxy: FastifyServerOptions["trustProxy"] =
    typeof tp === "number" ? (_addr: string, hop: number) => hop < tp : tp;
  const app = Fastify({
    logger: {
      level: opts.logLevel ?? process.env.LOG_LEVEL ?? "info",
      redact: { paths: [...REDACT_PATHS, ...(opts.redactPaths ?? [])], censor: "[redacted]" },
      base: { service: opts.serviceName, version: opts.version },
      mixin: () => {
        const c = currentContext();
        return { trace_id: c.traceId, correlation_id: c.correlationId, ...(c.userPid ? { user_pid: c.userPid } : {}) };
      },
      ...(opts.logFormatter ? { formatters: { log: opts.logFormatter } } : {}),
      ...(opts.logStream ? { stream: opts.logStream } : {}),
    },
    trustProxy,
    bodyLimit: 64 * 1024,
    ...opts.fastify,
  });
  await app.register(contextPlugin);
  await app.register(errorPlugin);

  app.get("/health/live", { logLevel: "silent" }, async () => ({ status: "ok" }));
  app.get("/health/ready", { logLevel: "silent" }, async (_req, reply) => {
    const checks = opts.readiness ? await opts.readiness() : {};
    const ok = Object.values(checks).every((v) => v === "ok");
    return reply.status(ok ? 200 : 503).send({ status: ok ? "ok" : "degraded", checks });
  });
  return app;
}
