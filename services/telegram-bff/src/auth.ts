/**
 * Авторизация запросов Mini App (onRequest — до разбора и валидации тела):
 *   public — лимит по IP (tg.session_ip — вход, closed; tg.public_ip — прочие, open; IP только хешем);
 *   user   — Bearer access JWT → сессия не отозвана (Redis) → tg.user на пользователя →
 *            tg.pin для операций с PIN → гейт PIN (pin=false → только pinExempt-маршруты, иначе 423).
 * Лимиты — единый лимитер ts-common (спринт 9, INTERNAL_API §2): 429 RATE_LIMITED {policy, retry_after} + Retry-After,
 * при сбое Redis — по режиму политики (open — пропуск, closed — 503 RATE_LIMIT_UNAVAILABLE).
 * user_pid (псевдоним user_id) попадает в контекст и далее во все строки лога запроса.
 */
import { AppError, currentContext, pseudonymize, rateLimitedError } from "@tilhero/ts-common";
import type { BffContext } from "./context.js";
import type { App } from "./http.js";

const BEARER_RE = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*$/i;

export const pinRequired = () =>
  new AppError(423, "PIN_REQUIRED", "Подтвердите вход PIN-кодом или биометрией");
export const sessionRevoked = () => new AppError(401, "SESSION_REVOKED", "Сессия завершена, войдите заново");

export function registerAuth(app: App, ctx: BffContext): void {
  const { config, limiter, sessions, tokens } = ctx;

  app.addHook("onRequest", async (req) => {
    const rc = req.routeOptions.config;
    if (!rc?.access) return;

    if (rc.access === "public") {
      const policy = rc.ipLimit === "session" ? "tg.session_ip" : "tg.public_ip";
      await limiter.enforce(policy, () => limiter.hashedSubject("ip", req.ip));
      return;
    }

    const header = req.headers.authorization;
    if (!header) throw new AppError(401, "UNAUTHORIZED", "Требуется авторизация");
    const m = BEARER_RE.exec(header);
    if (!m?.[1]) throw new AppError(401, "TOKEN_INVALID", "Недействительный токен сессии");
    const claims = await tokens.verify(m[1]);

    const [alive, rate] = await ctx.store(() =>
      Promise.all([
        sessions.isAlive(claims.sid),
        limiter.check("tg.user", claims.userId),
      ]),
    );
    if (!alive) throw sessionRevoked();
    currentContext().userPid = pseudonymize(claims.userId);
    if (!rate.allowed) throw rateLimitedError("tg.user", rate.retryAfter);
    if (rc.pinLimited) {
      // сброс PIN — отдельный счётчик той же политики (как раньше: pin и pin_reset)
      await limiter.enforce("tg.pin", rc.pinLimited === "reset" ? `reset:${claims.userId}` : claims.userId);
    }
    if (!claims.pin && !rc.pinExempt) throw pinRequired();
    req.auth = claims;
  });
}
