/**
 * Авторизация запросов admin-web (onRequest — до разбора тела, валидации и вызова домена):
 *
 *   public  (шаги входа до сессии) — проверка Origin/Sec-Fetch-Site (только ADMIN_WEB_ORIGIN) → лимит по IP;
 *   session — cookie → сессия в Redis → бездействие 30 мин / абсолют 8 ч (401 SESSION_EXPIRED) → привязка к
 *             User-Agent → CSRF (не-GET: Origin + X-CSRF-Token) → лимиты adm.staff (300/мин), для команд
 *             (не-GET) adm.command (60/мин) и для команд DLQ / повтора удаления adm.dlq (10/мин) → principal
 *             (кэш ≤ 30 с; статус ≠ ACTIVE или другая session_version → 401 SESSION_REVOKED и удаление сессии)
 *             → продление (кроме X-Background: 1 и замещённого ротацией id) → право маршрута (403 PERMISSION_DENIED) → step-up (403 STEP_UP_REQUIRED).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError, currentContext, pseudonymize } from "@tilhero/ts-common";
import { clearSessionCookie, readSessionCookie } from "./cookies.js";
import type { BffContext } from "./context.js";
import type { App, Principal, StaffAuth } from "./http.js";
import { effectiveAccess, guardAllows, guardLabel, type Guard, type RateClass } from "./rbac.js";
import { commandPolicies, rateLimited } from "./rateLimit.js";
import { isSessionId, publicSessionId, sha256hex, type SessionData } from "./sessions.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const unauthorized = () => new AppError(401, "UNAUTHORIZED", "Требуется вход");
export const sessionExpired = () => new AppError(401, "SESSION_EXPIRED", "Сессия истекла, войдите заново");
export const sessionRevoked = () => new AppError(401, "SESSION_REVOKED", "Сессия завершена, войдите заново");
/** id сессии уже заменён ротацией (step-up/смена пароля в другой вкладке): повторить запрос с новой cookie. */
export const sessionRotated = () =>
  new AppError(409, "SESSION_ROTATED", "Сессия обновлена в другой вкладке, повторите действие");
export const csrfInvalid = () => new AppError(403, "CSRF_INVALID", "Запрос отклонён: неверный CSRF-токен или источник");

export function uaHash(req: FastifyRequest): string {
  return sha256hex(`ua:${req.headers["user-agent"] ?? ""}`);
}

export function ipHash(req: FastifyRequest): string {
  return sha256hex(`ip:${req.ip}`);
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Источник запроса: Origin = ADMIN_WEB_ORIGIN; без Origin — только Sec-Fetch-Site: same-origin. */
export function checkOrigin(ctx: BffContext, req: FastifyRequest): void {
  const origin = req.headers.origin;
  if (typeof origin === "string") {
    if (origin !== ctx.config.adminWebOrigin) throw csrfInvalid();
    return;
  }
  if (req.headers["sec-fetch-site"] === "same-origin") return;
  throw csrfInvalid();
}

export interface SessionRequirement {
  guard: Guard;
  stepUp?: boolean | undefined;
  rate?: RateClass | undefined;
}

/** Завершить сессию: удалить из Redis и стереть cookie в ответе. */
async function drop(ctx: BffContext, reply: FastifyReply, id: string): Promise<void> {
  void reply.header("set-cookie", clearSessionCookie());
  await ctx.store(() => ctx.sessions.delete(id));
}

export async function authenticate(
  ctx: BffContext,
  req: FastifyRequest,
  reply: FastifyReply,
  need: SessionRequirement,
): Promise<StaffAuth> {
  const { config, sessions, limiter } = ctx;
  const id = readSessionCookie(req.headers.cookie);
  if (!isSessionId(id)) {
    if (id !== undefined) void reply.header("set-cookie", clearSessionCookie());
    throw unauthorized();
  }
  const s = await ctx.store(() => sessions.get(id));
  if (!s) {
    void reply.header("set-cookie", clearSessionCookie());
    throw unauthorized();
  }
  const now = ctx.now();
  if (now >= sessions.expiresAt(s)) {
    await drop(ctx, reply, id);
    throw sessionExpired();
  }
  // Замещённый ротацией id (step-up): действует до superseded_until без step-up и без продления
  const superseded = s.superseded_until > 0;
  if (superseded && now >= s.superseded_until) {
    void reply.header("set-cookie", clearSessionCookie());
    throw unauthorized();
  }
  // Привязка к браузеру: другой User-Agent с той же cookie — признак кражи сессии.
  if (s.ua_hash !== uaHash(req)) {
    ctx.log.warn({ event: "session_ua_mismatch" }, "session used from another user agent, revoked");
    await drop(ctx, reply, id);
    throw sessionRevoked();
  }

  if (!SAFE_METHODS.has(req.method)) {
    checkOrigin(ctx, req);
    const token = req.headers["x-csrf-token"];
    if (typeof token !== "string" || !sameSecret(token, s.csrf_token)) throw csrfInvalid();
  }

  // спринт 9: единый лимитер (ts-common) — 429 RATE_LIMITED {policy, retry_after}; сбой Redis — по режиму политики
  const rate = await limiter.check("adm.staff", s.staff_id);
  if (!rate.allowed) throw rateLimited(rate.retryAfter, "adm.staff");
  for (const policy of commandPolicies(req.method, req.routeOptions.url)) await limiter.enforce(policy, s.staff_id);
  if (need.rate === "step_up") await limiter.enforce("adm.mfa", s.staff_id);

  let principal: Principal;
  try {
    principal = await ctx.principals.get(s.staff_id);
  } catch (err) {
    // сотрудник удалён/отключён — сессия больше не действует; прочие сбои (503) — fail-closed без отзыва
    if (err instanceof AppError && (err.status === 404 || err.status === 403)) {
      await drop(ctx, reply, id);
      throw sessionRevoked();
    }
    throw err;
  }
  if (principal.status !== "ACTIVE" || principal.session_version !== s.session_version) {
    await ctx.principals.invalidate(s.staff_id);
    await drop(ctx, reply, id);
    throw sessionRevoked();
  }
  currentContext().userPid = pseudonymize(s.staff_id);

  if (s.ip_hash !== ipHash(req)) ctx.log.info({ event: "session_ip_changed" }, "session continues from another ip");
  // Фоновые запросы admin-web (X-Background: 1 — опрос дашборда/очереди) сессию не продлевают: иначе открытая
  // вкладка никогда не истечёт по бездействию. Замещённый id тоже не продлевается.
  const background = req.headers["x-background"] === "1";
  let touched: SessionData = s;
  if (!superseded && !background) {
    touched = { ...s, last_seen_at: now };
    const alive = await ctx.store(() => sessions.update(id, { last_seen_at: now }, sessions.ttlMs(touched, now)));
    if (!alive) {
      void reply.header("set-cookie", clearSessionCookie());
      throw unauthorized();
    }
  }

  // имперсонация — только ENV=dev (запись в сессии вне dev игнорируется) и только сужение прав
  const effective = effectiveAccess(
    { role: principal.staff.role, permissions: principal.permissions },
    config.devTools ? s.impersonating : null,
  );
  const auth: StaffAuth = {
    sessionId: id,
    publicSessionId: publicSessionId(id),
    session: touched,
    principal,
    effective,
    // actor: настоящая роль, эффективные (суженные) права
    actor: {
      id: principal.staff.staff_id,
      role: effective.role,
      name: principal.staff.display_name,
      permissions: effective.permissions,
    },
  };

  if (!guardAllows(need.guard, effective)) {
    ctx.log.info({ event: "permission_denied", permission: guardLabel(need.guard) }, "permission denied");
    throw new AppError(403, "PERMISSION_DENIED", "Недостаточно прав", { permission: guardLabel(need.guard) });
  }
  if (need.stepUp && !(s.step_up_until > now)) {
    throw stepUpRequired(need.guard.kind === "permission" ? need.guard.anyOf[0] : undefined);
  }
  return auth;
}

export function stepUpRequired(permission?: string): AppError {
  return new AppError(403, "STEP_UP_REQUIRED", "Подтвердите действие кодом из приложения-аутентификатора", {
    ...(permission ? { permission } : {}),
  });
}

/** Свежий step-up (окно 5 мин) у сессии запроса — для условного step-up в обработчике (PATCH источника). */
export function hasFreshStepUp(ctx: BffContext, auth: StaffAuth): boolean {
  return auth.session.step_up_until > ctx.now();
}

export function registerAuth(app: App, ctx: BffContext): void {
  app.addHook("onRequest", async (req, reply) => {
    const rc = req.routeOptions.config;
    if (!rc?.access) return;
    if (rc.access === "public") {
      checkOrigin(ctx, req);
      const policy = rc.rate === "login" ? "adm.login_ip" : "adm.auth_step_ip";
      await ctx.limiter.enforce(policy, () => ctx.limiter.hashedSubject("ip", req.ip));
      return;
    }
    if (!rc.guard) throw new AppError(500, "INTERNAL_ERROR", "Маршрут без объявленного права"); // недостижимо: onRoute
    req.staff = await authenticate(ctx, req, reply, { guard: rc.guard, stepUp: rc.stepUp, rate: rc.rate });
  });
}
