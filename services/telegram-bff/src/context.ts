/**
 * Зависимости обработчиков BFF (собираются в buildApp, в тестах подменяются Redis/fetch).
 */
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import { AppError } from "@tilhero/ts-common";
import type { Config } from "./config.js";
import type { AudienceResolver, AudioCache, PairsCache, SnapshotCache } from "./content.js";
import type { ExperienceCache } from "./experience.js";
import type { RateLimiter } from "./rateLimit.js";
import type { SessionStore } from "./sessions.js";
import type { AccessTokens } from "./tokens.js";
import { upstreamUnavailable, type Domains, type RawClient } from "./upstream.js";

export interface BffContext {
  config: Config;
  redis: Redis;
  sessions: SessionStore;
  limiter: RateLimiter;
  tokens: AccessTokens;
  domains: Domains;
  experience: ExperienceCache;
  /** Спринт 3: сегмент ученика для контента и кеши catalog (content.ts). */
  audience: AudienceResolver;
  pairs: PairsCache;
  snapshots: SnapshotCache;
  audio: AudioCache;
  /** Release 4.1: tts (озвучка фраз, байты MP3); null — TTS_URL не задан, POST /v1/speech → 503 SPEECH_UNAVAILABLE. */
  tts: RawClient | null;
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
