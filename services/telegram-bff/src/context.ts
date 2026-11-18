/**
 * Зависимости обработчиков BFF (собираются в buildApp, в тестах подменяются Redis/fetch).
 */
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import { AppError } from "@tilhero/ts-common";
import type { Config } from "./config.js";
import type { ExperienceCache } from "./experience.js";
import type { RateLimiter } from "./rateLimit.js";
import type { SessionStore } from "./sessions.js";
import type { AccessTokens } from "./tokens.js";
import { upstreamUnavailable, type Domains } from "./upstream.js";

export interface BffContext {
  config: Config;
  redis: Redis;
  sessions: SessionStore;
  limiter: RateLimiter;
  tokens: AccessTokens;
  domains: Domains;
  experience: ExperienceCache;
  log: FastifyBaseLogger;
  /** Вызов хранилища сессий/лимитов: сбой Redis → 503 (fail-closed), без деталей наружу. */
  store<T>(fn: () => Promise<T>): Promise<T>;
}

export function makeStoreGuard(log: FastifyBaseLogger) {
  return async function store<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      log.error({ err_name: (err as Error)?.name, err_message: (err as Error)?.message }, "session store failure");
      throw upstreamUnavailable("session-store");
    }
  };
}
