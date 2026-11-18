/**
 * Лимиты админки (спринт 9, INTERNAL_API §2.3) — единый лимитер ts-common (GCRA на Redis, общий для реплик,
 * переопределения без деплоя, метрики для ops-monitor, fail open / closed по политике).
 * Значения по умолчанию — прежние env RATE_LIMIT_* (config.rateLimits); `adm.command`, `adm.dlq` — из каталога.
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

/** Команды DLQ и повтор удаления профиля — сверх `adm.command` ещё `adm.dlq` (10/мин на сотрудника). */
const DLQ_ROUTES = [/^\/admin\/v1\/ops\/dlq\/(replay|delete)$/, /^\/admin\/v1\/deletions\/[^/]+retry$/];

/** Политики команды сотрудника по маршруту: небезопасный метод → `adm.command` (+ `adm.dlq`). */
export function commandPolicies(method: string, routeUrl: string | undefined): string[] {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return [];
  const url = routeUrl ?? "";
  return DLQ_ROUTES.some((re) => re.test(url)) ? ["adm.command", "adm.dlq"] : ["adm.command"];
}
