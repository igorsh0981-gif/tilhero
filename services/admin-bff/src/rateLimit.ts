/**
 * Лимиты админки — единый лимитер ts-common (GCRA на Redis, общий для реплик, переопределения без деплоя,
 * fail open / closed по политике каталога `packages/contracts/rate-limit-policies.json`).
 * Значения по умолчанию — env RATE_LIMIT_* (config.rateLimits); `adm.command` — из каталога.
 */
import type { Redis } from "ioredis";
import { AppError, RateLimiter, policyDefaults, rateLimitedError, type Logger } from "@tilhero/ts-common";
import type { Config } from "./config.js";

export { ipRateKey, RateLimiter } from "@tilhero/ts-common";

export function rateLimited(retryAfter: number, policy = "adm.staff"): AppError {
  return rateLimitedError(policy, retryAfter);
}

export function adminPolicies(config: Config) {
  const r = config.rateLimits;
  return policyDefaults("admin-bff", {
    "adm.login_ip": r.loginPerIpPerMinute,
    "adm.login_email": r.loginPerEmailPerMinute,
    "adm.auth_step_ip": r.authStepPerIpPerMinute,
    "adm.mfa": r.mfaPerMinute,
    "adm.staff": r.staffPerMinute,
  });
}

export function createLimiter(redis: Redis, config: Config, log: Logger): RateLimiter {
  return new RateLimiter({
    redis,
    service: "admin-bff",
    policies: adminPolicies(config),
    enabled: config.rateLimiting.enabled,
    overrideRefreshSeconds: config.rateLimiting.overrideRefreshSeconds,
    keyPrefix: config.rateLimiting.keyPrefix,
    log,
  });
}

/** Политики команды сотрудника по методу: небезопасный метод → `adm.command` (60/мин на сотрудника). */
export function commandPolicies(method: string): string[] {
  return ["GET", "HEAD", "OPTIONS"].includes(method) ? [] : ["adm.command"];
}
