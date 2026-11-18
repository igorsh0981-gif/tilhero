/**
 * Поддержка: прокси staff API support + имена операторов (admin-identity lookup) + безопасная сводка ученика
 * (user-admin, только при users.read; без PII, кроме маскированного Telegram ID) + шаблоны ответов RU/UZ (support).
 * Внутренние заметки (visibility=internal) в «как видит ученик» не попадают никогда: client-view — форма bff.ts.
 * Idempotency-Key сообщений (обязателен) и эскалаций пробрасывается в support.
 */
import type { StaffTicket } from "@tilhero/contracts/admin";
import type { AppError } from "@tilhero/ts-common";
import { parseDomain, withNames } from "../codec.js";
import {
  CLIENT_TICKET,
  ESCALATION_CREATED,
  LEARNER_PAGE,
  REPLY_TEMPLATES,
  SLA_POLICIES,
  STAFF_TICKET,
  SUPPORT_STATS,
  TICKET_DOMAIN,
  TICKET_LEARNER,
  TICKET_PAGE,
} from "../contract.js";
import type { BffContext } from "../context.js";
import { hasPermission, idempotencyKeyOf, staffOf, type App, type StaffAuth } from "../http.js";
import { requirePermission } from "../rbac.js";
import {
  CURSOR_Q,
  ESCALATION_TYPE,
  LIMIT_Q,
  PERIOD,
  REASON,
  TICKET_CATEGORY,
  TICKET_PRIORITY,
  TICKET_REF,
  TICKET_STATUS,
  UUID,
  enumOf,
  nullable,
  obj,
  pageQuery,
  params,
  query,
  str,
} from "../schemas.js";
import { DOMAIN, type DomainResponse } from "../upstream.js";
import { out, relay, shaped } from "./common.js";

const SERVICE = DOMAIN.support;
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

export function supportRoutes(app: App, ctx: BffContext): void {
  const support = ctx.domains.support;
  const path = (ref: string) => `/admin/v1/support/tickets/${encodeURIComponent(ref)}`;

  /** Безопасная сводка ученика — строка реестра user-admin (поиск по UUID), только при users.read. */
  async function learnerOf(auth: StaffAuth, userId: string | null): Promise<StaffTicket["learner"]> {
    if (!userId || !hasPermission(auth, "users.read")) return null;
    try {
      const page = parseDomain(
        ctx,
        DOMAIN.userAdmin,
        LEARNER_PAGE,
        await ctx.domains.userAdmin.get<unknown>("/admin/v1/learners", {
          actor: auth.actor,
          query: { q: userId, limit: 1 },
          timeoutMs: ctx.config.dashboardTimeoutMs,
          retries: 0,
        }),
      );
      const row = page.items.find((r) => r.user_id === userId.toLowerCase());
      return row ? TICKET_LEARNER.parse(row, "$") : null;
    } catch (err) {
      ctx.log.warn({ upstream: DOMAIN.userAdmin, err_code: (err as AppError)?.code }, "ticket learner summary unavailable");
      return null;
    }
  }

  /** Тикет домена → StaffTicket: проверка формы, имена операторов, сводка ученика. */
  async function ticketOut(auth: StaffAuth, body: unknown): Promise<StaffTicket> {
    const t = parseDomain(ctx, SERVICE, TICKET_DOMAIN, body);
    const [named, learner] = await Promise.all([withNames(ctx, auth, t), learnerOf(auth, t.user_id)]);
    return { ...named, learner };
  }

  const ticketReply = async (auth: StaffAuth, reply: Parameters<typeof relay>[2], res: DomainResponse<unknown>) => {
    if (res.replayed) void reply.header("idempotent-replayed", "true");
    return reply.status(res.status).send(await ticketOut(auth, res.body));
  };

  app.get<{ Querystring: ListQuery }>(
    "/admin/v1/support/tickets",
    {
      config: requirePermission("support.read"),
      schema: {
        response: out(TICKET_PAGE),
        querystring: query({
          // open | all | NEW,IN_PROGRESS,… (разбор и проверка — support)
          status: str(1, 120, { pattern: "^[A-Za-z_,]+$" }),
          category: TICKET_CATEGORY,
          priority: TICKET_PRIORITY,
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
      // admin.ts: assignee=me|none|<id> — support принимает как есть (me — сотрудник из actor)
      const body = await support.get<unknown>("/admin/v1/support/tickets", {
        actor: auth.actor,
        query: { status: q.status, category: q.category, priority: q.priority, assignee: q.assignee, sla: q.sla, user_id: q.user_id, sort: q.sort, ...pageQuery(q) },
      });
      return shaped(ctx, auth, SERVICE, TICKET_PAGE, body, { names: true });
    },
  );

  app.get<{ Querystring: { period?: string } }>(
    "/admin/v1/support/stats",
    { config: requirePermission("support.read", "dashboard.read"), schema: { response: out(SUPPORT_STATS), querystring: query({ period: PERIOD }) } },
    async (req) => {
      const auth = staffOf(req);
      const body = await support.get<unknown>("/admin/v1/support/stats", { actor: auth.actor, query: { period: req.query.period ?? "today" } });
      return shaped(ctx, auth, SERVICE, SUPPORT_STATS, body);
    },
  );

  app.get("/admin/v1/support/templates", { config: requirePermission("support.read"), schema: { response: out(REPLY_TEMPLATES) } }, async (req) => {
    const auth = staffOf(req);
    return shaped(ctx, auth, SERVICE, REPLY_TEMPLATES, await support.get<unknown>("/admin/v1/support/templates", { actor: auth.actor }));
  });

  app.get<{ Params: { id: string } }>(
    "/admin/v1/support/tickets/:id",
    { config: requirePermission("support.read"), schema: { response: out(STAFF_TICKET), params: TICKET_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return ticketOut(auth, await support.get<unknown>(path(req.params.id), { actor: auth.actor }));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/v1/support/tickets/:id/client-view",
    { config: requirePermission("support.read"), schema: { response: out(CLIENT_TICKET), params: TICKET_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, CLIENT_TICKET, await support.get<unknown>(`${path(req.params.id)}/client-view`, { actor: auth.actor }));
    },
  );

  app.post<{ Params: { id: string }; Body: { text: string; visibility: "public" | "internal" } }>(
    "/admin/v1/support/tickets/:id/messages",
    {
      config: requirePermission("support.reply"),
      schema: {
        response: out(STAFF_TICKET),
        params: TICKET_PARAMS,
        body: obj({ text: str(1, 4000), visibility: enumOf(["public", "internal"]) }, ["text", "visibility"]),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await support.call("POST", `${path(req.params.id)}/messages`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, true),
      });
      return ticketReply(auth, reply, res);
    },
  );

  app.patch<{ Params: { id: string }; Body: { status?: string; priority?: string; assignee_id?: string | null } }>(
    "/admin/v1/support/tickets/:id",
    {
      config: requirePermission("support.reply"),
      schema: {
        response: out(STAFF_TICKET),
        params: TICKET_PARAMS,
        body: obj({ status: TICKET_STATUS, priority: TICKET_PRIORITY, assignee_id: nullable(STAFF_REF) }, [], { minProperties: 1 }),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      return ticketReply(auth, reply, await support.call("PATCH", path(req.params.id), { actor: auth.actor, body: req.body }));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/v1/support/tickets/:id/take",
    { config: requirePermission("support.reply"), schema: { response: out(STAFF_TICKET), params: TICKET_PARAMS, body: obj({}) } },
    async (req, reply) => {
      const auth = staffOf(req);
      return ticketReply(auth, reply, await support.call("POST", `${path(req.params.id)}/take`, { actor: auth.actor }));
    },
  );

  app.post<{ Params: { id: string }; Body: { type: string; note: string } }>(
    "/admin/v1/support/tickets/:id/escalations",
    {
      config: requirePermission("support.reply"),
      schema: { response: out(ESCALATION_CREATED), params: TICKET_PARAMS, body: obj({ type: ESCALATION_TYPE, note: str(3, 2000) }, ["type", "note"]) },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await support.call("POST", `${path(req.params.id)}/escalations`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relay(ctx, auth, reply, SERVICE, ESCALATION_CREATED, res);
    },
  );

  app.get("/admin/v1/support/sla-policies", { config: requirePermission("support.read", "support.manage"), schema: { response: out(SLA_POLICIES) } }, async (req) => {
    const auth = staffOf(req);
    return shaped(ctx, auth, SERVICE, SLA_POLICIES, await support.get<unknown>("/admin/v1/support/sla-policies", { actor: auth.actor }));
  });

  app.put<{ Body: { items: unknown[]; reason: string } }>(
    "/admin/v1/support/sla-policies",
    {
      config: requirePermission("support.manage"),
      schema: {
        response: out(SLA_POLICIES),
        body: obj(
          {
            items: {
              type: "array",
              minItems: 1,
              maxItems: 60,
              items: obj(
                {
                  category: { anyOf: [TICKET_CATEGORY, enumOf(["*"])] },
                  priority: TICKET_PRIORITY,
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
    async (req, reply) => {
      const auth = staffOf(req);
      return relay(ctx, auth, reply, SERVICE, SLA_POLICIES, await support.call("PUT", "/admin/v1/support/sla-policies", { actor: auth.actor, body: req.body }));
    },
  );
}
