/**
 * Авторизация запросов Mini App (onRequest — до разбора и валидации тела):
 *   public — лимит по IP (tg.session_ip — вход, closed; tg.public_ip — прочие, open; IP только хешем);
 *   user   — Bearer access JWT → сессия не отозвана (Redis) и её активный ученик = lrn токена (иначе 401 TOKEN_EXPIRED:
 *            после переключения ученика прежний access-токен не действует) → tg.user на аккаунт →
 *            tg.pin для операций с кодом родителя → гейт PIN (pin=false → только pinExempt-маршруты, иначе 423).
 * Лимиты — единый лимитер ts-common (спринт 9, INTERNAL_API §2): 429 RATE_LIMITED {policy, retry_after} + Retry-After,
 * при сбое Redis — по режиму политики (open — пропуск, closed — 503 RATE_LIMIT_UNAVAILABLE).
 * user_pid (псевдоним user_id аккаунта) попадает в контекст и далее во все строки лога запроса.
 */
import { AppError, currentContext, pseudonymize, rateLimitedError } from "@tilhero/ts-common";
import type { BffContext } from "./context.js";
import type { App } from "./http.js";

const BEARER_RE = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*$/i;

export const pinRequired = () =>
  new AppError(423, "PIN_REQUIRED", "Подтвердите вход кодом родителя");
export const sessionRevoked = () => new AppError(401, "SESSION_REVOKED", "Сессия завершена, войдите заново");
/** Клиент обновляет токен (POST /v1/session/refresh) — как при истечении. */
export const learnerSwitched = () =>
  new AppError(401, "TOKEN_EXPIRED", "Активный профиль сменился, обновите токен", { reason: "learner_switched" });

export function registerAuth(app: App, ctx: BffContext): void {
  const { limiter, sessions, tokens } = ctx;

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

    const [learner, rate] = await ctx.store(() =>
      Promise.all([
        sessions.activeLearner(claims.sid),
        limiter.check("tg.user", claims.accountId),
      ]),
    );
    if (learner === null) throw sessionRevoked();
    // токен выдан до смены активного ученика (родитель → ребёнок и обратно): старый lrn больше не действует
    if (learner !== claims.learnerId) throw learnerSwitched();
    currentContext().userPid = pseudonymize(claims.accountId);
    if (!rate.allowed) throw rateLimitedError("tg.user", rate.retryAfter);
    if (rc.pinLimited) {
      // сброс PIN — отдельный счётчик той же политики (как раньше: pin и pin_reset)
      await limiter.enforce("tg.pin", rc.pinLimited === "reset" ? `reset:${claims.accountId}` : claims.accountId);
    }
    if (!claims.pin && !rc.pinExempt) throw pinRequired();
    req.auth = claims;
  });
}
