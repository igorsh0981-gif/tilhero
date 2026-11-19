/**
 * Авторизация запросов admin-web (onRequest — до разбора тела, валидации и вызова домена):
 *
 *   public  (шаги входа до сессии) — проверка Origin/Sec-Fetch-Site (только ADMIN_ORIGIN) → лимит по IP;
 *   sessionOnly (logout) — Origin → cookie → сессия → срок → User-Agent → CSRF; без principal и лимитов (ревью T2-1);
 *             Redis недоступен → cookie стирается, 503 SESSION_NOT_REVOKED (ревью T2-10);
 *   session — cookie → сессия в Redis → бездействие 30 мин / абсолют 8 ч (401 SESSION_EXPIRED) → привязка к
 *             User-Agent → CSRF (не-GET: Origin + X-CSRF-Token) → лимиты adm.staff (300/мин), для команд
 *             (не-GET) adm.command (60/мин), для step-up adm.mfa (5/мин) → principal
 *             (кэш ≤ 30 с; статус ≠ ACTIVE или другая session_version → 401 SESSION_REVOKED и удаление сессии)
 *             → продление (кроме X-Background: 1 и замещённого ротацией id) → право маршрута (403 PERMISSION_DENIED) → step-up (403 STEP_UP_REQUIRED).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError, currentContext, pseudonymize } from "@tilhero/ts-common";
import { clearSessionCookie, readSessionCookie } from "./cookies.js";
import type { BffContext } from "./context.js";
import type { App, Principal, SessionAuth, StaffAuth } from "./http.js";
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

/** Источник запроса: Origin = ADMIN_ORIGIN; без Origin — только Sec-Fetch-Site: same-origin. */
export function checkOrigin(ctx: BffContext, req: FastifyRequest): void {
  const origin = req.headers.origin;
  if (typeof origin === "string") {
    if (origin !== ctx.config.adminOrigin) throw csrfInvalid();
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

/**
 * Первая часть проверки любого сессионного запроса — только cookie и Redis: id из cookie → сессия → срок →
 * замещённый id → User-Agent → CSRF/Origin (не-GET). Без principal и без лимитов.
 */
async function loadSession(
  ctx: BffContext,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ id: string; s: SessionData; now: number; superseded: boolean }> {
  const { sessions } = ctx;
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
  return { id, s, now, superseded };
}

/**
 * Выход не подтверждён: хранилище сессий (Redis) недоступно, сессия на сервере, возможно, жива. Cookie в ответе
 * всё равно стёрта (ревью T2-10) — admin-web предупреждает сотрудника, а не показывает обычный экран входа.
 */
export const sessionNotRevoked = () =>
  new AppError(503, "SESSION_NOT_REVOKED", "Выход не подтверждён сервером: cookie стёрта, но сессия могла остаться активной", {
    service: "session-store",
  });

/** Сбой хранилища сессий (ctx.store) — а не ответ домена. */
export function isSessionStoreFailure(err: unknown): boolean {
  return err instanceof AppError && err.code === "UPSTREAM_UNAVAILABLE" && err.details.service === "session-store";
}

/**
 * Уровень sessionOnly (logout, ревью T2-1): сессия и CSRF — без admin-identity и без лимитов.
 * Origin проверяется до Redis (чужой источник не стирает cookie). Redis недоступен (ревью T2-10) → cookie всё равно
 * стирается, ответ 503 SESSION_NOT_REVOKED: X-CSRF-Token без сессии не сверить, но стирание cookie собственного
 * браузера по запросу с нашего Origin вреда не несёт, а оставлять её после «Выйти» нельзя.
 */
export async function authenticateSession(ctx: BffContext, req: FastifyRequest, reply: FastifyReply): Promise<SessionAuth> {
  if (!SAFE_METHODS.has(req.method)) checkOrigin(ctx, req);
  try {
    const { id, s } = await loadSession(ctx, req, reply);
    return { sessionId: id, publicSessionId: publicSessionId(id), session: s };
  } catch (err) {
    if (!isSessionStoreFailure(err)) throw err;
    void reply.header("set-cookie", clearSessionCookie());
    ctx.log.warn({ event: "logout_session_not_revoked", stage: "load" }, "logout: session store unavailable, cookie cleared");
    throw sessionNotRevoked();
  }
}

export async function authenticate(
  ctx: BffContext,
  req: FastifyRequest,
  reply: FastifyReply,
  need: SessionRequirement,
): Promise<StaffAuth> {
  const { config, sessions, limiter } = ctx;
  const { id, s, now, superseded } = await loadSession(ctx, req, reply);

  // единый лимитер (ts-common) — 429 RATE_LIMITED {policy, retry_after}; сбой Redis — по режиму политики
  const rate = await limiter.check("adm.staff", s.staff_id);
  if (!rate.allowed) throw rateLimited(rate.retryAfter, "adm.staff");
  for (const policy of commandPolicies(req.method)) await limiter.enforce(policy, s.staff_id);
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
    if (rc.sessionOnly) {
      req.sessionAuth = await authenticateSession(ctx, req, reply);
      return;
    }
    req.staff = await authenticate(ctx, req, reply, { guard: rc.guard, stepUp: rc.stepUp, rate: rc.rate });
  });
}
