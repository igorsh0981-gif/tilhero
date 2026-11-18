/**
 * Сотрудники, роли, заявки four-eyes — прокси в admin-identity (staff API, actor обязателен).
 * Step-up (повторный TOTP ≤ 5 мин) проверяет admin-bff ДО вызова: создание/изменение сотрудника, сбросы,
 * изменение роли, approve/reject. Статус ответа домена сохраняется (201 создание, 202 заявка four-eyes).
 * Изменения сотрудника (в т. ч. применённые approve) сбрасывают кэш его principal — отзыв сессий без ожидания 30 с.
 * Временный пароль (POST staff, reset-password, approve staff.privileged_reset) — только в ответе, no-store, не в логах.
 */
import type { FastifyReply } from "fastify";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, staffOf, type App } from "../http.js";
import { requirePermission, requireRole, requireStepUp } from "../rbac.js";
import {
  CURSOR_Q,
  LIMIT_Q,
  PERMISSION,
  REASON,
  ROLE,
  UUID,
  enumOf,
  obj,
  pageQuery,
  params,
  query,
  str,
} from "../schemas.js";
import type { DomainResponse } from "../upstream.js";
import { ok, APPROVAL_DECISION, APPROVAL_ENVELOPE, APPROVAL_PAGE, ROLES, STAFF, STAFF_CREATED, STAFF_PAGE, TEMPORARY_PASSWORD } from "../responses.js";

const STAFF_STATUS = enumOf(["ACTIVE", "LOCKED", "DISABLED"]);
const ID_PARAMS = params({ id: UUID });

function relay(reply: FastifyReply, res: DomainResponse<unknown>) {
  if (res.status === 204) return reply.status(204).send();
  return reply.status(res.status).send(res.body);
}

export function staffRoutes(app: App, ctx: BffContext): void {
  const idp = ctx.domains.adminIdentity;

  app.get<{ Querystring: { q?: string; role?: string; status?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/staff",
    {
      config: requirePermission("staff.manage"),
      schema: { response: ok(STAFF_PAGE), querystring: query({ q: str(1, 120), role: ROLE, status: STAFF_STATUS, cursor: CURSOR_Q, limit: LIMIT_Q }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const { q, role, status } = req.query;
      return idp.get("/admin/v1/staff", { actor: auth.actor, query: { q, role, status, ...pageQuery(req.query) } });
    },
  );

  app.post<{ Body: { email: string; display_name: string; role: string } }>(
    "/admin/v1/staff",
    {
      config: { ...requirePermission("staff.manage"), ...requireStepUp() },
      schema: { response: ok(STAFF_CREATED), body: obj({ email: str(3, 254), display_name: str(1, 120), role: ROLE }, ["email", "display_name", "role"]) },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      // ответ содержит временный пароль (один раз) — не логируется (scrub: temporary_password).
      // Idempotency-Key (admin-web сохраняет его и для повтора после step-up) — в admin-identity: повтор не создаёт
      // второго сотрудника, временный пароль в повторном ответе — null.
      const res = await idp.call("POST", "/admin/v1/staff", {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relay(reply, res);
    },
  );

  app.patch<{ Params: { id: string }; Body: { role?: string; status?: string; display_name?: string; reason: string } }>(
    "/admin/v1/staff/:id",
    {
      config: { ...requirePermission("staff.manage"), ...requireStepUp() },
      schema: {
        response: { 200: STAFF, 202: APPROVAL_ENVELOPE, ...ok(STAFF) },
        params: ID_PARAMS,
        body: obj(
          { role: ROLE, status: enumOf(["ACTIVE", "DISABLED"]), display_name: str(1, 120), reason: REASON },
          ["reason"],
          { minProperties: 2 },
        ),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const id = req.params.id.toLowerCase();
      const res = await idp.call("PATCH", `/admin/v1/staff/${id}`, { actor: auth.actor, body: req.body });
      await ctx.principals.invalidate(id);
      return relay(reply, res);
    },
  );

  for (const action of ["reset-password", "reset-mfa"] as const) {
    app.post<{ Params: { id: string }; Body: { reason: string } }>(
      `/admin/v1/staff/:id/${action}`,
      {
        config: { ...requirePermission("staff.manage"), ...requireStepUp() },
        // 200 — сброс применён (временный пароль показывается ОДИН раз / Staff); 202 — привилегированная цель:
        // заявка staff.privileged_reset (four-eyes), пароль получит решающий в ответе approve (StaffResetResponse)
        schema: {
          response: {
            200: action === "reset-password" ? TEMPORARY_PASSWORD : STAFF,
            202: APPROVAL_ENVELOPE,
            ...ok(action === "reset-password" ? TEMPORARY_PASSWORD : STAFF),
          },
          params: ID_PARAMS,
          body: obj({ reason: REASON }, ["reason"]),
        },
      },
      async (req, reply) => {
        const auth = staffOf(req);
        const id = req.params.id.toLowerCase();
        const res = await idp.call("POST", `/admin/v1/staff/${id}/${action}`, { actor: auth.actor, body: req.body });
        await ctx.principals.invalidate(id);
        return relay(reply, res);
      },
    );
  }

  app.get("/admin/v1/roles", { config: requirePermission("staff.manage", "roles.manage"), schema: { response: ok(ROLES) } }, async (req) => {
    const auth = staffOf(req);
    return idp.get("/admin/v1/roles", { actor: auth.actor });
  });

  app.put<{ Params: { code: string }; Body: { permissions: string[]; reason: string } }>(
    "/admin/v1/roles/:code",
    {
      config: { ...requirePermission("roles.manage"), ...requireStepUp() },
      schema: {
        response: ok(APPROVAL_ENVELOPE),
        params: params({ code: ROLE }),
        body: obj(
          { permissions: { type: "array", items: PERMISSION, uniqueItems: true, maxItems: 64 }, reason: REASON },
          ["permissions", "reason"],
        ),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      return relay(reply, await idp.call("PUT", `/admin/v1/roles/${req.params.code}`, { actor: auth.actor, body: req.body }));
    },
  );

  app.get<{ Querystring: { status?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/approvals",
    {
      config: requirePermission("staff.manage", "roles.manage"),
      schema: {
        response: ok(APPROVAL_PAGE),
        querystring: query({
          status: enumOf(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "APPLIED"]),
          cursor: CURSOR_Q,
          limit: LIMIT_Q,
        }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      return idp.get("/admin/v1/approvals", { actor: auth.actor, query: { status: req.query.status, ...pageQuery(req.query) } });
    },
  );

  for (const decision of ["approve", "reject"] as const) {
    app.post<{ Params: { id: string }; Body: { note?: string } }>(
      `/admin/v1/approvals/:id/${decision}`,
      {
        config: { ...requireRole("super_admin"), ...requireStepUp() },
        schema: { response: ok(APPROVAL_DECISION), params: ID_PARAMS, body: obj({ note: str(0, 500) }) },
      },
      async (req, reply) => {
        const auth = staffOf(req);
        const res = await idp.call("POST", `/admin/v1/approvals/${req.params.id.toLowerCase()}/${decision}`, {
          actor: auth.actor,
          body: { note: req.body?.note ?? null },
        });
        // ApprovalDecision: temporary_password — только у примененной заявки staff.privileged_reset; домен отдаёт
        // null для прочих — поле опускается (иначе сериализатор превратил бы null в ""). Ответ — no-store, поле не
        // логируется (scrub: temporary_password).
        const body = res.body as Record<string, unknown> | undefined;
        if (body && body.temporary_password == null) delete body.temporary_password;
        // применённая заявка меняет сотрудника (роль/статус/сброс) — кэш его principal сбрасывается сразу
        const target = (body?.summary as { staff?: { staff_id?: unknown } } | undefined)?.staff?.staff_id;
        if (decision === "approve" && typeof target === "string") await ctx.principals.invalidate(target.toLowerCase());
        return relay(reply, res);
      },
    );
  }
}
