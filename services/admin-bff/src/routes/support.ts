/**
 * Поддержка: прокси staff API support + имена операторов (admin-identity lookup) + безопасная сводка
 * пользователя (user-admin, если у сотрудника есть users.read) + шаблоны ответов и AI-черновик-заглушка.
 * Idempotency-Key сообщений (обязателен) и эскалаций пробрасывается в support.
 */
import type {
  AdminUserRow,
  AiDraft,
  Page,
  ReplyTemplate,
  StaffTicket,
  StaffTicketSummary,
} from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { hasPermission, idempotencyKeyOf, staffOf, type App, type StaffAuth } from "../http.js";
import { requirePermission } from "../rbac.js";
import {
  CURSOR_Q,
  LIMIT_Q,
  REASON,
  TICKET_REF,
  UUID,
  enumOf,
  nullable,
  obj,
  pageQuery,
  params,
  query,
  str,
} from "../schemas.js";
import { REPLY_TEMPLATES, stubDraft } from "../templates.js";
import { ok, AI_DRAFT, CLIENT_TICKET, ESCALATION as ESCALATION_OUT, SLA_POLICIES, STAFF_TICKET, SUPPORT_STATS, TEMPLATES, TICKET_PAGE } from "../responses.js";

const TICKET_STATUS = enumOf(["NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"]);
const PRIORITY = enumOf(["low", "normal", "high", "urgent"]);
const ESCALATION = enumOf(["billing_review", "provider_issue", "content_review", "security_privacy"]);
const STAFF_REF = str(1, 64, { pattern: "^[A-Za-z0-9][A-Za-z0-9._@:-]{0,63}$" });
const TICKET_PARAMS = params({ id: TICKET_REF });

interface ListQuery {
  status?: string;
  category?: string;
  priority?: string;
  assignee?: string;
  sla?: string;
  user_id?: string;
  sort?: string;
  cursor?: string;
  limit?: string;
}

type DomainTicket = Omit<StaffTicket, "assignee_name" | "user"> & Partial<Pick<StaffTicket, "assignee_name" | "user">>;
type DomainSummary = Omit<StaffTicketSummary, "assignee_name"> & { assignee_name?: string | null };

export function supportRoutes(app: App, ctx: BffContext): void {
  const support = ctx.domains.support;
  const path = (ref: string) => `/admin/v1/support/tickets/${encodeURIComponent(ref)}`;

  async function userSummary(auth: StaffAuth, userId: string | null): Promise<StaffTicket["user"]> {
    if (!userId || !hasPermission(auth, "users.read")) return null;
    try {
      const u = await ctx.domains.userAdmin.get<AdminUserRow>(`/admin/v1/users/${encodeURIComponent(userId)}`, {
        actor: auth.actor,
        timeoutMs: ctx.config.dashboardTimeoutMs,
        retries: 0,
      });
      return { user_id: u.user_id, username: u.username, telegram_id_masked: u.telegram_id_masked, locale: u.locale, status: u.status };
    } catch {
      ctx.log.warn({ upstream: "user-admin" }, "ticket user summary unavailable");
      return null;
    }
  }

  async function enrichTicket(auth: StaffAuth, t: DomainTicket): Promise<StaffTicket> {
    const authorIds = (t.messages ?? []).filter((m) => m.sender_type === "operator").map((m) => m.author_id);
    const [names, user] = await Promise.all([
      ctx.names.resolve([t.assignee_id, ...authorIds], auth),
      userSummary(auth, t.user_id),
    ]);
    return {
      ...t,
      assignee_name: t.assignee_id ? (names.get(t.assignee_id) ?? null) : null,
      messages: (t.messages ?? []).map((m) => ({
        ...m,
        // staff see the operator's full display name; the client API keeps only the first name (support domain)
        author_name: (m.author_id ? names.get(m.author_id) : undefined) ?? m.author_name ?? null,
      })),
      user,
    };
  }

  async function enrichPage(auth: StaffAuth, page: Page<DomainSummary>): Promise<Page<StaffTicketSummary>> {
    const names = await ctx.names.resolve(page.items.map((t) => t.assignee_id), auth);
    return {
      items: page.items.map((t) => ({ ...t, assignee_name: t.assignee_id ? (names.get(t.assignee_id) ?? null) : null })),
      next_cursor: page.next_cursor,
    };
  }

  app.get<{ Querystring: ListQuery }>(
    "/admin/v1/support/tickets",
    {
      config: requirePermission("support.read"),
      schema: {
        response: ok(TICKET_PAGE),
        querystring: query({
          status: str(1, 120, { pattern: "^[A-Za-z_,]+$" }),
          category: str(1, 40, { pattern: "^[A-Z_]+$" }),
          priority: PRIORITY,
          assignee: STAFF_REF,
          sla: enumOf(["breached", "soon", "ok"]),
          user_id: UUID,
          sort: enumOf(["created", "sla"]),
          cursor: CURSOR_Q,
          limit: LIMIT_Q,
        }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const q = req.query;
      // контракт admin.ts: assignee=me|none|<id>; support: _me|_none|<id>
      const assignee = q.assignee === "me" ? "_me" : q.assignee === "none" ? "_none" : q.assignee;
      const page = await support.get<Page<DomainSummary>>("/admin/v1/support/tickets", {
        actor: auth.actor,
        query: {
          status: q.status,
          category: q.category,
          priority: q.priority,
          assignee,
          sla: q.sla,
          user_id: q.user_id,
          sort: q.sort,
          ...pageQuery(q),
        },
      });
      return enrichPage(auth, page);
    },
  );

  /**
   * Сводка очереди (виджет «Поддержка» экрана Поддержки и Dashboard). В admin.ts маршрута нет, но admin-web его
   * вызывает (endpoints.ts Support.stats) — см. «Запросы к общему коду». Права — как у support: support.read
   * или dashboard.read.
   */
  app.get<{ Querystring: { period?: string } }>(
    "/admin/v1/support/stats",
    {
      config: requirePermission("support.read", "dashboard.read"),
      schema: { response: ok(SUPPORT_STATS), querystring: query({ period: enumOf(["today", "7d", "30d"]) }) },
    },
    async (req) => {
      const auth = staffOf(req);
      return support.get("/admin/v1/support/stats", { actor: auth.actor, query: { period: req.query.period ?? "today" } });
    },
  );

  app.get("/admin/v1/support/templates", { config: requirePermission("support.read"), schema: { response: ok(TEMPLATES) } }, async (): Promise<{ items: ReplyTemplate[] }> => ({
    items: [...REPLY_TEMPLATES],
  }));

  app.get<{ Params: { id: string } }>(
    "/admin/v1/support/tickets/:id",
    { config: requirePermission("support.read"), schema: { response: ok(STAFF_TICKET), params: TICKET_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return enrichTicket(auth, await support.get<DomainTicket>(path(req.params.id), { actor: auth.actor }));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/v1/support/tickets/:id/client-view",
    { config: requirePermission("support.read"), schema: { response: ok(CLIENT_TICKET), params: TICKET_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return support.get(`${path(req.params.id)}/client-view`, { actor: auth.actor });
    },
  );

  app.post<{ Params: { id: string }; Body: { text: string; visibility: "public" | "internal" } }>(
    "/admin/v1/support/tickets/:id/messages",
    {
      config: requirePermission("support.reply"),
      schema: {
        response: ok(STAFF_TICKET),
        params: TICKET_PARAMS,
        body: obj({ text: str(1, 4000), visibility: enumOf(["public", "internal"]) }, ["text", "visibility"]),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const key = idempotencyKeyOf(req, true);
      const t = await support.post<DomainTicket>(`${path(req.params.id)}/messages`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: key,
      });
      return enrichTicket(auth, t);
    },
  );

  app.patch<{ Params: { id: string }; Body: { status?: string; priority?: string; assignee_id?: string | null } }>(
    "/admin/v1/support/tickets/:id",
    {
      config: requirePermission("support.reply"),
      schema: {
        response: ok(STAFF_TICKET),
        params: TICKET_PARAMS,
        body: obj({ status: TICKET_STATUS, priority: PRIORITY, assignee_id: nullable(STAFF_REF) }, [], { minProperties: 1 }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const t = (await support.call<DomainTicket>("PATCH", path(req.params.id), { actor: auth.actor, body: req.body })).body;
      return enrichTicket(auth, t);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/v1/support/tickets/:id/take",
    { config: requirePermission("support.reply"), schema: { response: ok(STAFF_TICKET), params: TICKET_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return enrichTicket(auth, await support.post<DomainTicket>(`${path(req.params.id)}/take`, { actor: auth.actor }));
    },
  );

  app.post<{ Params: { id: string }; Body: { type: string; note: string } }>(
    "/admin/v1/support/tickets/:id/escalations",
    {
      config: requirePermission("support.reply"),
      schema: { response: ok(ESCALATION_OUT), params: TICKET_PARAMS, body: obj({ type: ESCALATION, note: str(3, 2000) }, ["type", "note"]) },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await support.call("POST", `${path(req.params.id)}/escalations`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return reply.status(res.status).send(res.body);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/v1/support/tickets/:id/ai-draft",
    { config: requirePermission("support.reply"), schema: { response: ok(AI_DRAFT), params: TICKET_PARAMS } },
    async (req): Promise<AiDraft> => {
      const auth = staffOf(req);
      const t = await support.get<DomainTicket>(path(req.params.id), { actor: auth.actor });
      const user = await userSummary(auth, t.user_id);
      return stubDraft(t, user?.locale);
    },
  );

  app.get("/admin/v1/support/sla-policies", { config: requirePermission("support.read"), schema: { response: ok(SLA_POLICIES) } }, async (req) => {
    const auth = staffOf(req);
    return support.get("/admin/v1/support/sla-policies", { actor: auth.actor });
  });

  app.put<{ Body: { items: unknown[]; reason: string } }>(
    "/admin/v1/support/sla-policies",
    {
      config: requirePermission("support.manage"),
      schema: {
        response: ok(SLA_POLICIES),
        body: obj(
          {
            items: {
              type: "array",
              minItems: 1,
              maxItems: 60,
              items: obj(
                {
                  category: str(1, 32),
                  priority: PRIORITY,
                  first_response_minutes: { type: "integer", minimum: 1, maximum: 43_200 },
                  resolution_minutes: { type: "integer", minimum: 2, maximum: 129_600 },
                },
                ["category", "priority", "first_response_minutes", "resolution_minutes"],
              ),
            },
            reason: REASON,
          },
          ["items", "reason"],
        ),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      return (await support.call("PUT", "/admin/v1/support/sla-policies", { actor: auth.actor, body: req.body })).body;
    },
  );
}
