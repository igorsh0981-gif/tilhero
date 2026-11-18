/**
 * Вход и сессия: /admin/v1/auth/*, /admin/v1/me, /admin/v1/dev/impersonate (только ENV=dev).
 *
 * Шаги до сессии (login, mfa, enroll, password с challenge) — publicAuth: Origin обязателен, лимит по IP;
 * плюс 5/мин на email (login) и 5/мин на challenge (коды). Пароли, коды, challenge и секрет MFA не логируются
 * (redact + scrub), секрет MFA и challenge возвращаются только в ответе своего шага.
 */
import type { LoginStep, Me, MfaEnrollStart, RoleCode, StepUpResult } from "@tilhero/contracts/admin";
import { AppError } from "@tilhero/ts-common";
import type { FastifyReply } from "fastify";
import { authenticate, sessionRevoked, sessionRotated, unauthorized } from "../auth.js";
import { clearSessionCookie, sessionCookie } from "../cookies.js";
import { writeAudit, type BffContext } from "../context.js";
import { staffOf, validationError, type App, type Principal } from "../http.js";
import { authenticated, canImpersonate, publicAuth } from "../rbac.js";
import { CHALLENGE, ROLE, TOTP, nullable, obj, str } from "../schemas.js";
import { buildMe, finishStep, iso, ROTATION_GRACE_MS, type AuthStep } from "../session.js";
import { ok, ME, LOGIN_STEP, MFA_ENROLL_START, NO_CONTENT, STEP_UP_RESULT } from "../responses.js";

const PASSWORD = str(1, 256);

export function authRoutes(app: App, ctx: BffContext): void {
  const { config, domains, limiter } = ctx;
  const idp = domains.adminIdentity;
  /** Cookie нового id после ротации: срок — остаток абсолютного срока сессии. */
  const setRotatedCookie = (reply: FastifyReply, id: string, createdAt: number) => {
    const ageSeconds = Math.floor((ctx.now() - createdAt) / 1000);
    void reply.header("set-cookie", sessionCookie(id, config.session.absoluteSeconds - ageSeconds));
  };
  const limitChallenge = (challenge: string) =>
    limiter.enforce("adm.mfa", async () => `challenge:${await limiter.hashedSubject("challenge", challenge)}`);

  app.post<{ Body: { email: string; password: string } }>(
    "/admin/v1/auth/login",
    {
      config: publicAuth("login"),
      schema: { response: ok(LOGIN_STEP), body: obj({ email: str(3, 254), password: PASSWORD }, ["email", "password"]) },
    },
    async (req, reply): Promise<LoginStep> => {
      const email = req.body.email.trim().toLowerCase();
      await limiter.enforce("adm.login_email", () => limiter.hashedSubject("email", email));
      const step = await idp.post<AuthStep>("/internal/v1/auth/login", {
        body: {
          email: req.body.email,
          password: req.body.password,
          ip: req.ip,
          user_agent: String(req.headers["user-agent"] ?? "").slice(0, 512) || null,
        },
      });
      return finishStep(ctx, req, reply, step);
    },
  );

  app.post<{ Body: { challenge: string; code: string } }>(
    "/admin/v1/auth/mfa",
    { config: publicAuth("auth_step"), schema: { response: ok(LOGIN_STEP), body: obj({ challenge: CHALLENGE, code: TOTP }, ["challenge", "code"]) } },
    async (req, reply): Promise<LoginStep> => {
      await limitChallenge(req.body.challenge);
      const step = await idp.post<AuthStep>("/internal/v1/auth/mfa/verify", { body: req.body });
      return finishStep(ctx, req, reply, step);
    },
  );

  app.post<{ Body: { challenge: string } }>(
    "/admin/v1/auth/mfa/enroll/start",
    { config: publicAuth("auth_step"), schema: { response: ok(MFA_ENROLL_START), body: obj({ challenge: CHALLENGE }, ["challenge"]) } },
    async (req): Promise<MfaEnrollStart> => {
      await limitChallenge(req.body.challenge);
      const r = await idp.post<MfaEnrollStart>("/internal/v1/auth/mfa/enroll/start", { body: req.body });
      return { secret: r.secret, otpauth_uri: r.otpauth_uri, issuer: r.issuer, account: r.account };
    },
  );

  app.post<{ Body: { challenge: string; code: string } }>(
    "/admin/v1/auth/mfa/enroll/confirm",
    { config: publicAuth("auth_step"), schema: { response: ok(LOGIN_STEP), body: obj({ challenge: CHALLENGE, code: TOTP }, ["challenge", "code"]) } },
    async (req, reply): Promise<LoginStep> => {
      await limitChallenge(req.body.challenge);
      const step = await idp.post<AuthStep>("/internal/v1/auth/mfa/enroll/confirm", { body: req.body });
      return finishStep(ctx, req, reply, step);
    },
  );

  /**
   * С challenge — шаг входа (must_change_password). Без него — смена своего пароля в сессии: нужны cookie,
   * CSRF и current_password; session_version растёт → прочие сессии отзываются, текущая получает новый id.
   */
  app.post<{ Body: { challenge?: string; current_password?: string; new_password: string } }>(
    "/admin/v1/auth/password",
    {
      config: publicAuth("auth_step"),
      schema: {
        response: ok(LOGIN_STEP),
        body: obj({ challenge: CHALLENGE, current_password: PASSWORD, new_password: PASSWORD }, ["new_password"]),
      },
    },
    async (req, reply): Promise<LoginStep> => {
      const { challenge, current_password, new_password } = req.body;
      if (challenge !== undefined) {
        if (current_password !== undefined) throw validationError("current_password", "лишнее поле при входе по challenge");
        await limitChallenge(challenge);
        const step = await idp.post<AuthStep>("/internal/v1/auth/password", { body: { challenge, new_password } });
        return finishStep(ctx, req, reply, step);
      }
      const auth = await authenticate(ctx, req, reply, { guard: { kind: "authenticated" } });
      if (current_password === undefined) throw validationError("current_password", "обязательное поле");
      // замещённый id (другая вкладка уже ротировала сессию): 409 без Set-Cookie — до вызова домена
      if (auth.session.superseded_until > 0) throw sessionRotated();
      await limiter.enforce("adm.mfa", `password:${auth.principal.staff.staff_id}`);
      const step = await idp.post<AuthStep>("/internal/v1/auth/password", {
        body: { staff_id: auth.principal.staff.staff_id, current_password, new_password },
      });
      const staffId = auth.principal.staff.staff_id;
      // кэш principal только сбрасывается (не заполняется ответом шага): следующий запрос перечитает admin-identity
      await ctx.principals.invalidate(staffId);
      const principal: Principal =
        step.principal ?? (await idp.get<Principal>(`/internal/v1/staff/${encodeURIComponent(staffId)}/principal`));
      const rotated = await ctx.store(() =>
        ctx.sessions.rotate(auth.sessionId, auth.session, { session_version: principal.session_version }, ctx.now()),
      );
      await ctx.principals.invalidate(staffId);
      // ротацию параллельно сделала другая вкладка — её cookie не стираем (409, клиент повторит с новой cookie)
      if (rotated === "superseded") throw sessionRotated();
      if (rotated === "missing") {
        // сессию параллельно завершили (logout/отзыв) — новая не создаётся; пароль уже сменён, вход заново
        void reply.header("set-cookie", clearSessionCookie());
        throw sessionRevoked();
      }
      setRotatedCookie(reply, rotated.id, rotated.data.created_at);
      return { next: "done", challenge: null, me: buildMe(ctx, rotated.data, principal) };
    },
  );

  app.post<{ Body: { code: string } }>(
    "/admin/v1/auth/step-up",
    { config: authenticated("step_up"), schema: { response: ok(STEP_UP_RESULT), body: obj({ code: TOTP }, ["code"]) } },
    async (req, reply): Promise<StepUpResult> => {
      const auth = staffOf(req);
      // замещённый id: 409 SESSION_ROTATED без Set-Cookie и без траты TOTP-кода (повтор того же шага запрещён)
      if (auth.session.superseded_until > 0) throw sessionRotated();
      await idp.post("/internal/v1/auth/step-up", { body: { staff_id: auth.principal.staff.staff_id, code: req.body.code } });
      const now = ctx.now();
      const until = now + config.session.stepUpSeconds * 1000;
      // повышенный доступ привязывается к НОВОМУ id; старый ещё ROTATION_GRACE_MS работает без step-up
      const rotated = await ctx.store(() =>
        ctx.sessions.rotate(auth.sessionId, auth.session, { step_up_until: until }, now, ROTATION_GRACE_MS),
      );
      if (rotated === "superseded") throw sessionRotated();
      if (rotated === "missing") {
        void reply.header("set-cookie", clearSessionCookie());
        throw unauthorized();
      }
      setRotatedCookie(reply, rotated.id, rotated.data.created_at);
      return { step_up_until: iso(until) };
    },
  );

  app.post("/admin/v1/auth/logout", { config: authenticated(), schema: { response: NO_CONTENT } }, async (req, reply) => {
    const auth = staffOf(req);
    await ctx.store(() => ctx.sessions.delete(auth.sessionId));
    void reply.header("set-cookie", clearSessionCookie());
    try {
      // аудит auth.logout пишет admin-identity
      await idp.call("POST", "/internal/v1/auth/logout", {
        body: { staff_id: auth.principal.staff.staff_id, session_id: auth.publicSessionId },
      });
    } catch {
      try {
        await writeAudit(ctx, auth, { action: "auth.logout", object_type: "staff", object_id: auth.principal.staff.staff_id }, req.ip);
      } catch {
        ctx.log.warn({ event: "logout_audit_failed" }, "logout audit record was not written");
      }
    }
    return reply.status(204).send();
  });

  app.get("/admin/v1/me", { config: authenticated(), schema: { response: ok(ME) } }, async (req): Promise<Me> => {
    const auth = staffOf(req);
    return buildMe(ctx, auth.session, auth.principal);
  });

  // Имперсонация — только ENV=dev: в stage/prod маршрута нет (404).
  if (config.devTools) {
    app.post<{ Body: { role: RoleCode | null } }>(
      "/admin/v1/dev/impersonate",
      { config: authenticated(), schema: { response: ok(ME), body: obj({ role: nullable(ROLE) }, ["role"]) } },
      async (req): Promise<Me> => {
        const auth = staffOf(req);
        const role = req.body.role;
        // только сужение: роль, права которой ⊆ своих (иначе support «примерил» бы super_admin)
        if (role !== null && !canImpersonate(auth.principal.permissions, role)) {
          throw new AppError(403, "IMPERSONATION_NOT_ALLOWED", "Нельзя примерить роль с правами шире своих", { role });
        }
        // аудит до изменения: без записи в журнал режим не включается
        await writeAudit(
          ctx,
          auth,
          {
            action: "dev.impersonate",
            object_type: "staff",
            object_id: auth.principal.staff.staff_id,
            before: { impersonating: auth.session.impersonating },
            after: { impersonating: role },
          },
          req.ip,
        );
        const now = ctx.now();
        const alive = await ctx.store(() =>
          ctx.sessions.update(auth.sessionId, { impersonating: role }, ctx.sessions.ttlMs(auth.session, now)),
        );
        if (!alive) throw unauthorized();
        return buildMe(ctx, { ...auth.session, impersonating: role }, auth.principal);
      },
    );
  }
}
