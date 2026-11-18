/**
 * Журнал аудита (audit.read) — прокси в audit. Контракт admin.ts: from/to → audit: date_from/date_to.
 */
import { AUDIT_PAGE, AUDIT_RECORD, CHAIN_VERIFICATION } from "../contract.js";
import type { BffContext } from "../context.js";
import { staffOf, type App } from "../http.js";
import { requirePermission } from "../rbac.js";
import { CURSOR_Q, ISO_Q, LIMIT_Q, UUID, pageQuery, params, query, str } from "../schemas.js";
import { DOMAIN } from "../upstream.js";
import { out, shaped } from "./common.js";

const SERVICE = DOMAIN.audit;

interface AuditQuery {
  action?: string;
  actor_id?: string;
  object_type?: string;
  object_id?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string;
}

export function auditRoutes(app: App, ctx: BffContext): void {
  const audit = ctx.domains.audit;

  app.get<{ Querystring: AuditQuery }>(
    "/admin/v1/audit/records",
    {
      config: requirePermission("audit.read"),
      schema: {
        response: out(AUDIT_PAGE),
        querystring: query({
          action: str(1, 80, { pattern: "^[a-z][a-z0-9_.]*$" }),
          actor_id: str(1, 64, { pattern: "^[A-Za-z0-9._:@-]+$" }),
          object_type: str(1, 64, { pattern: "^[a-z][a-z0-9_.]*$" }),
          object_id: str(1, 128, { pattern: "^[A-Za-z0-9._:@-]+$" }),
          from: ISO_Q,
          to: ISO_Q,
          cursor: CURSOR_Q,
          limit: LIMIT_Q,
        }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const q = req.query;
      const body = await audit.get<unknown>("/admin/v1/audit/records", {
        actor: auth.actor,
        query: {
          action: q.action,
          actor_id: q.actor_id,
          object_type: q.object_type,
          object_id: q.object_id,
          date_from: q.from,
          date_to: q.to,
          ...pageQuery(q),
        },
      });
      return shaped(ctx, auth, SERVICE, AUDIT_PAGE, body);
    },
  );

  app.get("/admin/v1/audit/verify", { config: requirePermission("audit.read"), schema: { response: out(CHAIN_VERIFICATION) } }, async (req) => {
    const auth = staffOf(req);
    return shaped(ctx, auth, SERVICE, CHAIN_VERIFICATION, await audit.get<unknown>("/admin/v1/audit/verify", { actor: auth.actor }));
  });

  app.get<{ Params: { id: string } }>(
    "/admin/v1/audit/records/:id",
    { config: requirePermission("audit.read"), schema: { response: out(AUDIT_RECORD), params: params({ id: UUID }) } },
    async (req) => {
      const auth = staffOf(req);
      const body = await audit.get<unknown>(`/admin/v1/audit/records/${req.params.id.toLowerCase()}`, { actor: auth.actor });
      return shaped(ctx, auth, SERVICE, AUDIT_RECORD, body);
    },
  );
}
