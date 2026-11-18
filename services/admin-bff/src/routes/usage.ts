/**
 * Спринт 7 — «Запросы и стоимость» (docs/sprint7/INTERNAL_API.md §2.4, §1.11, §6):
 *  - KPI, агенты, журнал AI-запросов и drill-down — ai-control (dashboard.read). Период: period=today|7d|30d или
 *    from/to (даты UTC, to включительно);
 *  - раскрытие содержимого запроса — ai-concierge `content:reveal` (ai.content.read + step-up + причина 3..300).
 *    Аудит ai.content.view ai-concierge пишет синхронно ДО выдачи: недоступен → 503 AUDIT_UNAVAILABLE, содержимое не
 *    выдаётся; удалено по сроку (30 дней) → 404 AI_CONTENT_EXPIRED. admin-bff содержимое не логирует и не кэширует
 *    (Cache-Control: no-store).
 */
import { AppError } from "@tilhero/ts-common";
import type { AiContentRevealInput } from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { staffOf, type App } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { CURSOR_Q, LIMIT_Q, UUID, enumOf, obj, pageQuery, params, query, str } from "../schemas.js";
import { ok } from "../responses.js";
import { AI_AGENT_USAGE, AI_KPI, AI_REQUEST_CONTENT, AI_REQUEST_DETAIL, AI_REQUEST_PAGE } from "./aiCodecs.js";
import { DATE_Q, PERIOD_Q, REASON_IN, auditDown, COMMAND_TIMEOUT_MS, periodQuery, reasonOf, respond } from "./aiCommon.js";

const CONTROL = "ai-control";
const CONCIERGE = "ai-concierge";

interface PeriodQ {
  period?: string;
  from?: string;
  to?: string;
}
const PERIOD_PROPS = { period: PERIOD_Q, from: DATE_Q, to: DATE_Q };

/** 404 ai-concierge без кода AI_CONTENT_EXPIRED (запрос не консьержа, ход не найден) — та же понятная причина. */
function revealError(err: AppError): never {
  if (err.status === 404 && err.code !== "AI_CONTENT_EXPIRED") {
    throw new AppError(404, "AI_CONTENT_EXPIRED", "Переписка удалена по сроку хранения или недоступна", {});
  }
  throw err;
}

export function usageRoutes(app: App, ctx: BffContext): void {
  const control = ctx.domains.aiControl;
  const concierge = ctx.domains.aiConcierge;

  app.get<{ Querystring: PeriodQ }>(
    "/admin/v1/usage/kpi",
    { config: requirePermission("dashboard.read"), schema: { response: ok(AI_KPI.schema), querystring: query(PERIOD_PROPS) } },
    async (req) => {
      const auth = staffOf(req);
      const body = await control.get<unknown>("/internal/v1/usage/kpi", { actor: auth.actor, query: periodQuery(ctx.now(), req.query) });
      return respond(ctx, auth, CONTROL, AI_KPI, body);
    },
  );

  app.get<{ Querystring: PeriodQ }>(
    "/admin/v1/usage/agents",
    { config: requirePermission("dashboard.read"), schema: { response: ok(AI_AGENT_USAGE.schema), querystring: query(PERIOD_PROPS) } },
    async (req) => {
      const auth = staffOf(req);
      const body = await control.get<unknown>("/internal/v1/usage/agents", { actor: auth.actor, query: periodQuery(ctx.now(), req.query) });
      return respond(ctx, auth, CONTROL, AI_AGENT_USAGE, body);
    },
  );

  app.get<{ Querystring: PeriodQ & { agent?: string; status?: string; model?: string; user_id?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/usage/requests",
    {
      config: requirePermission("dashboard.read"),
      schema: {
        response: ok(AI_REQUEST_PAGE.schema),
        querystring: query({
          ...PERIOD_PROPS,
          agent: str(2, 32, { pattern: "^[a-z][a-z0-9_]{1,31}$" }),
          status: enumOf(["SUCCESS", "PARTIAL", "FAILED", "ERROR"]),
          model: str(3, 64, { pattern: "^[a-z0-9][a-z0-9.\\-_]{2,63}$" }),
          user_id: UUID,
          cursor: CURSOR_Q,
          limit: LIMIT_Q,
        }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const { agent, status, model, user_id } = req.query;
      // журнал по умолчанию — 30 дней (как ai-control); пользователь в фильтре — весь срок хранения
      const range = req.query.period || req.query.from || req.query.to ? periodQuery(ctx.now(), req.query) : periodQuery(ctx.now(), { period: "30d" });
      const body = await control.get<unknown>("/internal/v1/usage/requests", {
        actor: auth.actor,
        query: { ...range, agent, status, model, user_id: user_id?.toLowerCase(), ...pageQuery(req.query) },
      });
      return respond(ctx, auth, CONTROL, AI_REQUEST_PAGE, body);
    },
  );

  app.get<{ Params: { requestId: string } }>(
    "/admin/v1/usage/requests/:requestId",
    { config: requirePermission("dashboard.read"), schema: { response: ok(AI_REQUEST_DETAIL.schema), params: params({ requestId: UUID }) } },
    async (req) => {
      const auth = staffOf(req);
      const body = await control.get<unknown>(`/internal/v1/usage/requests/${req.params.requestId.toLowerCase()}`, { actor: auth.actor });
      return respond(ctx, auth, CONTROL, AI_REQUEST_DETAIL, body);
    },
  );

  app.post<{ Params: { requestId: string }; Body: AiContentRevealInput }>(
    "/admin/v1/usage/requests/:requestId/content::reveal",
    {
      config: { ...requirePermission("ai.content.read"), ...requireStepUp() },
      schema: { response: ok(AI_REQUEST_CONTENT.schema), params: params({ requestId: UUID }), body: obj({ reason: REASON_IN }, ["reason"]) },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const reason = reasonOf(req.body.reason);
      const id = req.params.requestId.toLowerCase();
      let body: unknown;
      try {
        const res = await concierge.call<unknown>("POST", `/internal/v1/admin/requests/${id}/content:reveal`, {
          actor: auth.actor,
          body: { reason },
          timeoutMs: COMMAND_TIMEOUT_MS,
          retries: 0,
          mapServerError: auditDown,
        });
        body = res.body;
      } catch (e) {
        if (e instanceof AppError) revealError(e);
        throw e;
      }
      reply.header("cache-control", "no-store");
      return respond(ctx, auth, CONCIERGE, AI_REQUEST_CONTENT, body);
    },
  );
}
