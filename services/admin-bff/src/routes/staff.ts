/**
 * Сотрудники, роли, заявки four-eyes — прокси в admin-identity (staff API, actor обязателен).
 * Step-up (повторный TOTP ≤ 5 мин) проверяет admin-bff ДО вызова — на всех командах (admin.ts): создание и
 * изменение сотрудника, сбросы, изменение роли, approve/reject. Статус ответа домена сохраняется
 * (201 создание, 202 заявка four-eyes; у PATCH — StaffPatchPending). Изменения сотрудника (в т. ч. применённые approve) сбрасывают кэш его
 * principal — отзыв сессий без ожидания 30 с. Временный пароль — только в ответе, no-store, не в логах.
 */
import type { FastifyReply } from "fastify";
import type { Codec } from "../codec.js";
import {
  APPROVAL_DECISION,
  APPROVAL_ENVELOPE,
  APPROVAL_PAGE,
  ROLES,
  STAFF,
  STAFF_CREATED,
  STAFF_PAGE,
  STAFF_PATCH_PENDING,
  TEMPORARY_PASSWORD,
} from "../contract.js";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, staffOf, type App, type StaffAuth } from "../http.js";
import { requirePermission, requireRole, requireStepUp } from "../rbac.js";
import { CURSOR_Q, LIMIT_Q, PERMISSION, REASON, ROLE, UUID, enumOf, obj, pageQuery, params, query, str } from "../schemas.js";
import { DOMAIN, type DomainResponse } from "../upstream.js";
import { out, relay, shaped } from "./common.js";

const SERVICE = DOMAIN.adminIdentity;
const STAFF_STATUS = enumOf(["ACTIVE", "LOCKED", "DISABLED"]);
const ID_PARAMS = params({ id: UUID });

export function staffRoutes(app: App, ctx: BffContext): void {
  const idp = ctx.domains.adminIdentity;
  /** Ответ команды по статусу домена: 202 → {approval}, иначе — кодек команды. */
  const send = (auth: StaffAuth, reply: FastifyReply, res: DomainResponse<unknown>, c: Codec<unknown>) =>
    relay(ctx, auth, reply, SERVICE, res.status === 202 ? APPROVAL_ENVELOPE : c, res);

  app.get<{ Querystring: { q?: string; role?: string; status?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/staff",
    {
      config: requirePermission("staff.manage"),
      schema: { response: out(STAFF_PAGE), querystring: query({ q: str(1, 120), role: ROLE, status: STAFF_STATUS, cursor: CURSOR_Q, limit: LIMIT_Q }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const { q, role, status } = req.query;
      const body = await idp.get<unknown>("/admin/v1/staff", { actor: auth.actor, query: { q, role, status, ...pageQuery(req.query) } });
      return shaped(ctx, auth, SERVICE, STAFF_PAGE, body);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/v1/staff/:id",
    { config: requirePermission("staff.manage"), schema: { response: out(STAFF), params: ID_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      const body = await idp.get<unknown>(`/admin/v1/staff/${req.params.id.toLowerCase()}`, { actor: auth.actor });
      return shaped(ctx, auth, SERVICE, STAFF, body);
    },
  );

  app.post<{ Body: { email: string; display_name: string; role: string } }>(
    "/admin/v1/staff",
    {
      config: { ...requirePermission("staff.manage"), ...requireStepUp() },
      schema: {
        response: out(STAFF_CREATED),
        body: obj({ email: str(3, 254), display_name: str(1, 120), role: ROLE }, ["email", "display_name", "role"]),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      // admin.ts: Idempotency-Key обязателен (admin-web хранит его и для повтора после step-up): повтор не создаёт
      // второго сотрудника, временный пароль в повторном ответе — null. Ответ не логируется (scrub: temporary_password).
      const res = await idp.call("POST", "/admin/v1/staff", {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, true),
      });
      return relay(ctx, auth, reply, SERVICE, STAFF_CREATED, res);
    },
  );

  app.patch<{ Params: { id: string }; Body: { role?: string; status?: string; display_name?: string; reason: string } }>(
    "/admin/v1/staff/:id",
    {
      config: { ...requirePermission("staff.manage"), ...requireStepUp() },
      schema: {
        // 202 StaffPatchPending: заявка four-eyes; temporary_password — если применилась сразу (single_super_admin)
        response: { 200: STAFF.schema, 202: STAFF_PATCH_PENDING.schema },
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
      if (res.status === 202) return relay(ctx, auth, reply, SERVICE, STAFF_PATCH_PENDING, res);
      return relay(ctx, auth, reply, SERVICE, STAFF, res);
    },
  );

  for (const action of ["reset-password", "reset-mfa"] as const) {
    const done = action === "reset-password" ? TEMPORARY_PASSWORD : STAFF;
    app.post<{ Params: { id: string }; Body: { reason: string } }>(
      `/admin/v1/staff/:id/${action}`,
      {
        config: { ...requirePermission("staff.manage"), ...requireStepUp() },
        // 200 — сброс применён (временный пароль ОДИН раз / Staff); 202 — привилегированная цель: заявка
        // staff.privileged_reset (four-eyes), пароль получит решающий в ответе approve (StaffResetResponse)
        schema: { response: { 200: done.schema, 202: APPROVAL_ENVELOPE.schema }, params: ID_PARAMS, body: obj({ reason: REASON }, ["reason"]) },
      },
      async (req, reply) => {
        const auth = staffOf(req);
        const id = req.params.id.toLowerCase();
        const res = await idp.call("POST", `/admin/v1/staff/${id}/${action}`, { actor: auth.actor, body: req.body });
        await ctx.principals.invalidate(id);
        return send(auth, reply, res, done as Codec<unknown>);
      },
    );
  }

  app.get("/admin/v1/roles", { config: requirePermission("staff.manage", "roles.manage"), schema: { response: out(ROLES) } }, async (req) => {
    const auth = staffOf(req);
    return shaped(ctx, auth, SERVICE, ROLES, await idp.get<unknown>("/admin/v1/roles", { actor: auth.actor }));
  });

  app.put<{ Params: { code: string }; Body: { permissions: string[]; reason: string } }>(
    "/admin/v1/roles/:code",
    {
      config: { ...requirePermission("roles.manage"), ...requireStepUp() },
      schema: {
        response: out(APPROVAL_ENVELOPE),
        params: params({ code: ROLE }),
        body: obj({ permissions: { type: "array", items: PERMISSION, uniqueItems: true, maxItems: 64 }, reason: REASON }, ["permissions", "reason"]),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await idp.call("PUT", `/admin/v1/roles/${req.params.code}`, { actor: auth.actor, body: req.body });
      return relay(ctx, auth, reply, SERVICE, APPROVAL_ENVELOPE, res);
    },
  );

  app.get<{ Querystring: { status?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/approvals",
    {
      config: requirePermission("staff.manage", "roles.manage"),
      schema: {
        response: out(APPROVAL_PAGE),
        querystring: query({ status: enumOf(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "APPLIED"]), cursor: CURSOR_Q, limit: LIMIT_Q }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await idp.get<unknown>("/admin/v1/approvals", { actor: auth.actor, query: { status: req.query.status, ...pageQuery(req.query) } });
      return shaped(ctx, auth, SERVICE, APPROVAL_PAGE, body);
    },
  );

  for (const decision of ["approve", "reject"] as const) {
    app.post<{ Params: { id: string }; Body: { note?: string } }>(
      `/admin/v1/approvals/:id/${decision}`,
      {
        config: { ...requireRole("super_admin"), ...requireStepUp() },
        schema: { response: out(APPROVAL_DECISION), params: ID_PARAMS, body: obj({ note: str(0, 500) }) },
      },
      async (req, reply) => {
        const auth = staffOf(req);
        const res = await idp.call("POST", `/admin/v1/approvals/${req.params.id.toLowerCase()}/${decision}`, {
          actor: auth.actor,
          body: { note: req.body?.note ?? null },
        });
        // применённая заявка меняет сотрудника (роль/статус/сброс) — кэш его principal сбрасывается сразу
        const target = ((res.body as { summary?: { staff?: { staff_id?: unknown }; staff_id?: unknown } } | undefined)?.summary ?? {}) as {
          staff?: { staff_id?: unknown };
          staff_id?: unknown;
        };
        const targetId = typeof target.staff?.staff_id === "string" ? target.staff.staff_id : target.staff_id;
        if (decision === "approve" && typeof targetId === "string") await ctx.principals.invalidate(targetId.toLowerCase());
        // ApprovalDecision: temporary_password — решающему у применённых privileged_reset, create_privileged,
        // role_grant, reactivate_privileged (null → ключа нет)
        return relay(ctx, auth, reply, SERVICE, APPROVAL_DECISION, res);
      },
    );
  }
}
