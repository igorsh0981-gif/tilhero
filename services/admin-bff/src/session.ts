/**
 * Создание сессии после успешного входа и сборка Me.
 */
import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { LoginStep, Me } from "@tilhero/contracts/admin";
import { AppError } from "@tilhero/ts-common";
import { ipHash, uaHash } from "./auth.js";
import { readSessionCookie, sessionCookie } from "./cookies.js";
import type { BffContext } from "./context.js";
import type { Principal } from "./http.js";
import { effectiveAccess } from "./rbac.js";
import { isSessionId, type SessionData } from "./sessions.js";
import { upstreamUnavailable } from "./upstream.js";

/** Ответ admin-identity на шаг входа. */
export interface AuthStep {
  next: LoginStep["next"];
  challenge?: string | null;
  principal?: Principal | null;
}

/** Сколько старый id живёт после ротации по step-up (запросы, ушедшие до ответа step-up). */
export const ROTATION_GRACE_MS = 15_000;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function buildMe(ctx: BffContext, s: SessionData, principal: Principal): Me {
  const now = ctx.now();
  const eff = effectiveAccess(
    { role: principal.staff.role, permissions: principal.permissions },
    ctx.config.devTools ? s.impersonating : null,
  );
  return {
    staff: {
      staff_id: principal.staff.staff_id,
      email: principal.staff.email,
      display_name: principal.staff.display_name,
      role: principal.staff.role,
    },
    permissions: eff.permissions,
    mfa_enabled: principal.mfa_enabled,
    must_change_password: principal.must_change_password,
    session: {
      expires_at: iso(ctx.sessions.expiresAt(s)),
      idle_timeout_seconds: ctx.config.session.idleSeconds,
      step_up_until: s.step_up_until > now ? iso(s.step_up_until) : null,
    },
    csrf_token: s.csrf_token,
    env: ctx.config.env,
    runbook_base_url: ctx.config.runbookBaseUrl,
    impersonating: eff.impersonating,
  };
}

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Вход завершён: новая сессия с НОВЫМ id (защита от фиксации сессии — прежняя cookie этого браузера,
 * если была, удаляется), cookie __Host-, Me в ответе.
 */
export async function startSession(
  ctx: BffContext,
  req: FastifyRequest,
  reply: FastifyReply,
  principal: Principal,
): Promise<Me> {
  if (principal.status !== "ACTIVE") throw new AppError(403, "ACCOUNT_DISABLED", "Учётная запись отключена");
  const previous = readSessionCookie(req.headers.cookie);
  if (isSessionId(previous)) await ctx.store(() => ctx.sessions.delete(previous));
  const now = ctx.now();
  const data: SessionData = {
    staff_id: principal.staff.staff_id,
    session_version: principal.session_version,
    created_at: now,
    last_seen_at: now,
    step_up_until: 0,
    csrf_token: newCsrfToken(),
    ip_hash: ipHash(req),
    ua_hash: uaHash(req),
    impersonating: null,
    superseded_until: 0,
  };
  const id = await ctx.store(() => ctx.sessions.create(data));
  await ctx.principals.put(principal);
  void reply.header("set-cookie", sessionCookie(id, ctx.config.session.absoluteSeconds));
  ctx.log.info({ event: "session_started" }, "staff session started");
  return buildMe(ctx, data, principal);
}

/** Ответ шага входа: done → сессия + Me; иначе следующий шаг и challenge. */
export async function finishStep(
  ctx: BffContext,
  req: FastifyRequest,
  reply: FastifyReply,
  step: AuthStep,
): Promise<LoginStep> {
  if (step.next === "done") {
    if (!step.principal) throw upstreamUnavailable("admin-identity");
    return { next: "done", challenge: null, me: await startSession(ctx, req, reply, step.principal) };
  }
  if (!step.challenge) throw upstreamUnavailable("admin-identity");
  return { next: step.next, challenge: step.challenge, me: null };
}
