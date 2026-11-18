/**
 * Журнал аудита (audit.read) — прокси в audit. Контракт admin.ts: from/to → audit: date_from/date_to.
 */
import type { AuditRecord, ChainVerification, Page } from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { staffOf, type App } from "../http.js";
import { requirePermission } from "../rbac.js";
import { CURSOR_Q, ISO_Q, LIMIT_Q, UUID, pageQuery, params, query, str } from "../schemas.js";
import { ok, AUDIT_PAGE, AUDIT_RECORD, CHAIN_VERIFICATION } from "../responses.js";

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
        response: ok(AUDIT_PAGE),
        querystring: query({
          action: str(1, 80, { pattern: "^[a-z][a-z0-9_.]*$" }),
          actor_id: str(1, 64),
          object_type: str(1, 64),
          object_id: str(1, 128),
          from: ISO_Q,
          to: ISO_Q,
          cursor: CURSOR_Q,
          limit: LIMIT_Q,
        }),
      },
    },
    async (req): Promise<Page<AuditRecord>> => {
      const auth = staffOf(req);
      const q = req.query;
      return audit.get<Page<AuditRecord>>("/admin/v1/audit/records", {
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
    },
  );

  app.get("/admin/v1/audit/verify", { config: requirePermission("audit.read"), schema: { response: ok(CHAIN_VERIFICATION) } }, async (req): Promise<ChainVerification> => {
    const auth = staffOf(req);
    return audit.get<ChainVerification>("/admin/v1/audit/verify", { actor: auth.actor });
  });

  app.get<{ Params: { id: string } }>(
    "/admin/v1/audit/records/:id",
    { config: requirePermission("audit.read"), schema: { response: ok(AUDIT_RECORD), params: params({ id: UUID }) } },
    async (req): Promise<AuditRecord> => {
      const auth = staffOf(req);
      return audit.get<AuditRecord>(`/admin/v1/audit/records/${req.params.id.toLowerCase()}`, { actor: auth.actor });
    },
  );
}
