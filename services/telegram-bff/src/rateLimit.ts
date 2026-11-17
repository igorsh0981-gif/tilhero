/**
 * Лимиты Mini App (спринт 9, INTERNAL_API §2.3) — единый лимитер ts-common (GCRA на Redis, общий для реплик,
 * переопределения из админки без деплоя, метрики для ops-monitor, fail open / closed по политике).
 * Значения по умолчанию — прежние env RATE_LIMIT_* (config.rateLimits); `tg.support_create` — из каталога.
 */
import type { Redis } from "ioredis";
import { RateLimiter, policyDefaults, type Logger } from "@tilhero/ts-common";
import type { Config } from "./config.js";

export { ipRateKey, RateLimiter } from "@tilhero/ts-common";

export function telegramPolicies(config: Config) {
  const r = config.rateLimits;
  return policyDefaults("telegram-bff", {
    "tg.user": r.userPerMinute,
    "tg.session_ip": r.sessionPerIpPerMinute,
    "tg.pin": r.pinPerMinute,
    "tg.public_ip": r.publicPerIpPerMinute,
    "tg.offers": r.offersPerMinute,
    "tg.reactions": r.reactionsPerMinute,
    "tg.watch": r.watchCommandsPerMinute,
    "tg.ai": r.aiTurnsPerMinute,
  });
}

export function createLimiter(redis: Redis, config: Config, log: Logger): RateLimiter {
  return new RateLimiter({
    redis,
    service: "telegram-bff",
    policies: telegramPolicies(config),
    enabled: config.rateLimiting.enabled,
    overrideRefreshSeconds: config.rateLimiting.overrideRefreshSeconds,
    keyPrefix: config.rateLimiting.keyPrefix,
    log,
  });
}
