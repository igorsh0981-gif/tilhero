/**
 * Поиск событий (docs/sprint4/INTERNAL_API.md §3.5, §4, §7):
 *  - запуски — discovery (`/internal/v1/runs`), право discovery.manage; ручной запуск — всегда `trigger: "manual"`
 *    и явный бюджет `max_provider_calls` ≤ 200 (не задан → 200): потолок admin.ts не зависит от настроек discovery;
 *  - бюджет AI дня — provider-gateway `ai_web/budget` (discovery.manage);
 *  - kill switch AI-поиска — provider-gateway `ai_web/pause` (ops.kill_switch + step-up); аудит пишет provider-gateway
 *    синхронно до смены состояния (таймаут audit 5 с + повтор), поэтому у вызова свой таймаут PAUSE_TIMEOUT_MS = 15 с:
 *    с общим 3 с оператор видел бы 503, а пауза включалась бы позже. Вызов без повторов (`retries: 0`): после таймаута
 *    повтор дал бы двойной аудит и ожидание около 30 с. Аудит недоступен → 503 домена {service: "audit"}
 *    (или код AUDIT_UNAVAILABLE) → 503 AUDIT_UNAVAILABLE: состояние не изменено, можно повторить.
 * «Остановил» (paused.by_name) — имя сотрудника через admin-identity staff/lookup (./staffNames.ts).
 * Статус ответа discovery сохраняется: 202 — новый запуск, 200 — повтор Idempotency-Key; 409 DISCOVERY_RUN_IN_PROGRESS
 * {run_id} — как есть.
 */
import { AppError, type UpstreamError } from "@tilhero/ts-common";
import type { AiBudget, DiscoveryRun, Page } from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, staffOf, type App } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { CURSOR_Q, LIMIT_Q, MAX_MANUAL_PROVIDER_CALLS, UUID, enumOf, obj, pageQuery, params, query, str } from "../schemas.js";
import { ok, AI_BUDGET, DISCOVERY_RUN, DISCOVERY_RUN_PAGE } from "../responses.js";
import { namedBudget as namedBudgetBase } from "./staffNames.js";
import { namedLimits, normalizeLimits } from "./limits.js";
import type { StaffAuth } from "../http.js";

/** Бюджет + исправление 6.1: limits нормализуются (испорченные → null, нет поля — нет и в ответе) и с именем. */
async function namedBudget(ctx: BffContext, auth: StaffAuth, raw: AiBudget): Promise<AiBudget> {
  const b = await namedBudgetBase(ctx, auth, raw);
  if (!("limits" in raw)) return b;
  const l = normalizeLimits(raw.limits);
  return { ...b, limits: l ? await namedLimits(ctx, auth, l) : null };
}

const AI_WEB = "/internal/v1/providers/ai_web";
/** Синхронный аудит provider-gateway (5 с + повтор) + смена состояния — с запасом. */
export const PAUSE_TIMEOUT_MS = 15_000;

/** 503 provider-gateway «журнал аудита недоступен: состояние не изменено» → AUDIT_UNAVAILABLE. */
export function auditUnavailable(err: UpstreamError): AppError | undefined {
  if (err.status !== 503) return undefined;
  if (err.code !== "AUDIT_UNAVAILABLE" && err.details?.service !== "audit") return undefined;
  return new AppError(503, "AUDIT_UNAVAILABLE", "Журнал аудита недоступен: состояние AI-поиска не изменено. Повторите позже", {
    service: "audit",
  });
}

function isBudget(v: unknown): v is AiBudget {
  return !!v && typeof v === "object" && "day" in v && "budget_usd" in v;
}

export function discoveryRoutes(app: App, ctx: BffContext): void {
  const discovery = ctx.domains.discovery;
  const gateway = ctx.domains.providerGateway;

  app.get<{ Querystring: { status?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/discovery/runs",
    {
      config: requirePermission("discovery.manage"),
      schema: {
        response: ok(DISCOVERY_RUN_PAGE),
        querystring: query({ status: enumOf(["RUNNING", "COMPLETED", "PARTIAL", "FAILED"]), cursor: CURSOR_Q, limit: LIMIT_Q }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      return discovery.get<Page<DiscoveryRun>>("/internal/v1/runs", {
        actor: auth.actor,
        query: { status: req.query.status, ...pageQuery(req.query) },
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/v1/discovery/runs/:id",
    { config: requirePermission("discovery.manage"), schema: { response: ok(DISCOVERY_RUN), params: params({ id: UUID }) } },
    async (req) => {
      const auth = staffOf(req);
      return discovery.get<DiscoveryRun>(`/internal/v1/runs/${req.params.id.toLowerCase()}`, { actor: auth.actor });
    },
  );

  app.post<{ Body: { max_provider_calls?: number } }>(
    "/admin/v1/discovery/runs",
    {
      config: requirePermission("discovery.manage"),
      schema: {
        response: ok(DISCOVERY_RUN),
        body: obj({ max_provider_calls: { type: "integer", minimum: 1, maximum: MAX_MANUAL_PROVIDER_CALLS } }),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await discovery.call<DiscoveryRun>("POST", "/internal/v1/runs", {
        actor: auth.actor,
        body: { trigger: "manual", max_provider_calls: req.body?.max_provider_calls ?? MAX_MANUAL_PROVIDER_CALLS },
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return reply.status(res.status).send(res.body);
    },
  );

  app.get(
    "/admin/v1/discovery/budget",
    { config: requirePermission("discovery.manage"), schema: { response: ok(AI_BUDGET) } },
    async (req) => {
      const auth = staffOf(req);
      return namedBudget(ctx, auth, await gateway.get<AiBudget>(`${AI_WEB}/budget`, { actor: auth.actor }));
    },
  );

  app.put<{ Body: { paused: boolean; reason: string } }>(
    "/admin/v1/discovery/pause",
    {
      config: { ...requirePermission("ops.kill_switch"), ...requireStepUp() },
      schema: {
        response: ok(AI_BUDGET),
        body: obj({ paused: { type: "boolean" }, reason: str(3, 300) }, ["paused", "reason"]),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const res = await gateway.call("PUT", `${AI_WEB}/pause`, {
        actor: auth.actor,
        body: req.body,
        timeoutMs: PAUSE_TIMEOUT_MS,
        // Без повторов при любых настройках (UPSTREAM_RETRIES, Idempotency-Key): после таймаута provider-gateway мог
        // уже записать аудит и сменить состояние — повтор дал бы двойной аудит и ожидание 2 × 15 с.
        retries: 0,
        mapServerError: auditUnavailable,
      });
      // admin.ts: ответ — AiBudget. provider-gateway может вернуть только состояние паузы — тогда дочитываем бюджет.
      const budget = isBudget(res.body) ? res.body : await gateway.get<AiBudget>(`${AI_WEB}/budget`, { actor: auth.actor });
      return namedBudget(ctx, auth, budget);
    },
  );
}
