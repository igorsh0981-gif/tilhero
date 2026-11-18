/**
 * Спринт 7 — «Бюджеты и лимиты», агенты, алерты, каталог цен, уровни доступа (docs/sprint7/INTERNAL_API.md §2.1,
 * §2.5–2.7, §3.2–3.3, §6). Домены: ai-control (AI_CONTROL_URL) и provider-gateway (PROVIDER_GATEWAY_URL).
 *  - GET /admin/v1/ai/budgets — ai-control budgets/overview + provider-gateway providers/ai/agents + ai_web/limits.
 *    ai-control недоступен → обзор из provider-gateway (control: "unavailable"): аварийная остановка доступна всегда;
 *    недоступны оба → ошибка ai-control;
 *  - kill switch агента и провайдера — provider-gateway (ops.kill_switch + step-up; admin-web — причина и ввод имени);
 *  - команды ai-control: Idempotency-Key обязателен (домен требует), причина, expected_version; аудит синхронный в
 *    домене: 15 с без повторов, 503 → AUDIT_UNAVAILABLE.
 * Ответы нормализуются строго (aiCodecs.ts): испорченный → 503 UPSTREAM_UNAVAILABLE {service}.
 */
import type { AppError } from "@tilhero/ts-common";
import type {
  AccessLevelInput,
  AiAgentPatch,
  AiAgentRuntimeState,
  AiBudgetOverview,
  AiKillSwitchState,
  AiLimits,
  AiPauseInput,
  PriceCatalogActivateInput,
  PriceCatalogDraftInput,
  PriceCatalogPatch,
} from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, staffOf, validationError, type App, type StaffAuth } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { BOOL_Q, CURSOR_Q, EXPECTED_VERSION, LIMIT_Q, UUID, enumOf, obj, pageQuery, params, query, str } from "../schemas.js";
import { AI_LIMITS, ok } from "../responses.js";
import { parseDomain } from "../codec.js";
import {
  ACCESS_LEVEL_SAVED,
  ACCESS_LEVEL_LIST,
  AI_AGENT,
  AI_AGENT_SAVED,
  AI_AGENT_LIST,
  AI_ALERT,
  AI_ALERT_PAGE,
  CONTROL_OVERVIEW,
  KILL_SWITCH_STATE,
  PRICE_LIST,
  PRICE_VERSION_C,
  budgetOverviewSchema,
  type ControlOverview,
} from "./aiCodecs.js";
import { REASON_IN, command, reasonOf, respond } from "./aiCommon.js";
import { namedLimits, normalizeLimits } from "./limits.js";
import { withNames } from "../codec.js";

const CONTROL = "ai-control";
const GATEWAY = "provider-gateway";
const AGENTS_GW = "/internal/v1/providers/ai/agents";
const LIMITS_GW = "/internal/v1/providers/ai_web/limits";
const AGENT_ID = str(2, 32, { pattern: "^[a-z][a-z0-9_-]{1,31}$" });
const LEVEL_CODE = str(2, 32, { pattern: "^[a-z][a-z0-9_]{1,31}$" });
const PRICE_VERSION = "(\\d{4}-\\d{2}-\\d{2}(-\\d{1,3})?|env)";
const MODEL_KEY = str(3, 64, { pattern: "^[a-z0-9][a-z0-9.\\-_]{2,63}$" });
/** Деньги во входе: строка-число (без float), границы проверяет домен. */
const MONEY = (places: number) => str(1, 20, { pattern: `^\\d{1,4}(\\.\\d{1,${places}})?$` });
const RATE_IN = { anyOf: [str(1, 20, { pattern: "^\\d{1,4}(\\.\\d{1,6})?$" }), { type: "null" }] };
const PRICE_ITEM_IN = obj(
  {
    kind: enumOf(["model", "external_api", "request_fee"]),
    key: str(1, 64, { pattern: "^(\\*|[a-z0-9][a-z0-9.\\-_]{2,63})$" }),
    input_usd_per_mtok: RATE_IN,
    output_usd_per_mtok: RATE_IN,
    cache_write_usd_per_mtok: RATE_IN,
    cache_read_usd_per_mtok: RATE_IN,
    per_call_usd: RATE_IN,
  },
  ["kind", "key"],
);
const PRICE_ITEMS = { type: "array", maxItems: 100, items: PRICE_ITEM_IN };

/** Известные агенты (provider-gateway AGENTS): вид — для обзора без ai-control. */
const KNOWN_KIND: Record<string, AiAgentRuntimeState["kind"]> = { concierge: "interactive", evaluation: "system", discovery: "batch", news: "batch" };

/** Сумма двух строк USD без float: в микродолларах (целые). */
const addUsd = (a: string, b: string): string => {
  const micro = (v: string) => {
    const [i, f = ""] = v.split(".");
    return BigInt(i!) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
  };
  const t = micro(a) + micro(b);
  return `${t / 1_000_000n}.${(t % 1_000_000n).toString().padStart(6, "0")}`;
};

/** Обзор = ai-control (месяц, состояние, алерты) поверх свежего состояния provider-gateway (пауза, сутки). */
export function mergeOverview(control: ControlOverview | null, gw: AiKillSwitchState | null, limits: AiLimits | null, at: string): AiBudgetOverview {
  const gwAgents = new Map((gw?.agents ?? []).map((a) => [a.agent_id, a]));
  const provider = gw ? gw.provider : (control?.provider ?? { anthropic: { paused: null } });
  const providerPaused = provider.anthropic.paused !== null;
  const fromGw = (id: string): Pick<AiAgentRuntimeState, "day" | "paused"> | null => {
    const g = gwAgents.get(id);
    if (!g) return null;
    const b = g.budget;
    return {
      paused: g.paused,
      day: b ? { spent_usd: addUsd(b.spent_usd, b.reserved_usd), limit_usd: b.limit_usd, pct: b.pct, source: b.source } : null,
    };
  };
  let agents: AiAgentRuntimeState[];
  if (control) {
    agents = control.agents.map((a) => {
      const g = fromGw(a.agent_id);
      const paused = g ? g.paused : a.paused;
      const day = g ? g.day : a.day;
      let state = a.state;
      if (paused || providerPaused) state = "paused";
      else if (a.state === "paused") state = day?.pct != null && day.pct >= 100 ? "exhausted" : "normal";
      return { ...a, paused, day, state };
    });
  } else {
    agents = (gw?.agents ?? []).map((g) => {
      const x = fromGw(g.agent_id)!;
      const exhausted = x.day?.pct != null && x.day.pct >= 100;
      return {
        agent_id: g.agent_id,
        name: g.agent_id,
        kind: KNOWN_KIND[g.agent_id] ?? "system",
        code_managed: g.agent_id === "discovery" || g.agent_id === "news",
        day: x.day,
        month: null,
        paused: x.paused,
        state: x.paused || providerPaused ? "paused" : exhausted ? "exhausted" : "normal",
        degrade_at_pct: null,
        degraded_mode: null,
        alerts: [],
      };
    });
  }
  return { agents, provider, limits, gateway: gw ? "ok" : "unavailable", control: control ? "ok" : "unavailable", at };
}

export function aiRoutes(app: App, ctx: BffContext): void {
  const control = ctx.domains.aiControl;
  const gateway = ctx.domains.providerGateway;
  const nowIso = () => new Date(ctx.now()).toISOString().replace(/\.\d{3}Z$/, "Z");

  // ------------------------------------------------------------ обзор бюджетов

  app.get(
    "/admin/v1/ai/budgets",
    { config: requirePermission("dashboard.read", "ops.kill_switch"), schema: { response: ok(budgetOverviewSchema(AI_LIMITS)) } },
    async (req) => {
      const auth = staffOf(req);
      const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
      const [c, g, l] = await Promise.all([
        settle(control.get<unknown>("/internal/v1/budgets/overview", { actor: auth.actor })),
        settle(gateway.get<unknown>(AGENTS_GW, { actor: auth.actor })),
        settle(gateway.get<unknown>(LIMITS_GW, { actor: auth.actor })),
      ]);
      const ctl = c.ok ? parseDomain(ctx, CONTROL, CONTROL_OVERVIEW, c.v) : null;
      const gw = g.ok ? parseDomain(ctx, GATEWAY, KILL_SWITCH_STATE, g.v) : null;
      if (!ctl && !gw) throw (c as { e: unknown }).e;
      let limits: AiLimits | null = null;
      if (l.ok) {
        const n = normalizeLimits(l.v);
        if (n) limits = await namedLimits(ctx, auth, n);
        else ctx.log.warn({ upstream: GATEWAY, upstream_code: "UPSTREAM_BAD_RESPONSE" }, "ai limits rejected by normalization");
      }
      if (!c.ok) ctx.log.warn({ upstream: CONTROL, err_code: (c.e as AppError)?.code }, "ai budgets overview without ai-control");
      return withNames(ctx, auth, mergeOverview(ctl, gw, limits, ctl?.at ?? nowIso()));
    },
  );

  // ------------------------------------------------------------ kill switch (provider-gateway §3.3)

  const pause = async (auth: StaffAuth, path: string, body: AiPauseInput) => {
    const reason = reasonOf(body.reason);
    const res = await gateway.call<unknown>("PUT", path, { actor: auth.actor, body: { paused: body.paused, reason }, ...command() });
    return respond(ctx, auth, GATEWAY, KILL_SWITCH_STATE, res.body);
  };
  const PAUSE_BODY = obj({ paused: { type: "boolean" }, reason: REASON_IN }, ["paused", "reason"]);
  const PAUSE_ROUTE = {
    config: { ...requirePermission("ops.kill_switch"), ...requireStepUp() },
    schema: { response: ok(KILL_SWITCH_STATE.schema), body: PAUSE_BODY },
  };

  app.put<{ Params: { agentId: string }; Body: AiPauseInput }>(
    "/admin/v1/ai/agents/:agentId/pause",
    { ...PAUSE_ROUTE, schema: { ...PAUSE_ROUTE.schema, params: params({ agentId: AGENT_ID }) } },
    async (req) => pause(staffOf(req), `${AGENTS_GW}/${req.params.agentId}/pause`, req.body),
  );
  app.put<{ Body: AiPauseInput }>("/admin/v1/ai/providers/anthropic/pause", PAUSE_ROUTE, async (req) =>
    pause(staffOf(req), "/internal/v1/providers/ai/provider/anthropic/pause", req.body),
  );

  // ------------------------------------------------------------ агенты (ai-control §2.1)

  app.get(
    "/admin/v1/ai/agents",
    { config: requirePermission("dashboard.read", "ops.kill_switch"), schema: { response: ok(AI_AGENT_LIST.schema) } },
    async (req) => {
      const auth = staffOf(req);
      return respond(ctx, auth, CONTROL, AI_AGENT_LIST, await control.get<unknown>("/internal/v1/agents", { actor: auth.actor }));
    },
  );
  app.get<{ Params: { agentId: string } }>(
    "/admin/v1/ai/agents/:agentId",
    {
      config: requirePermission("dashboard.read", "ops.kill_switch"),
      schema: { response: ok(AI_AGENT.schema), params: params({ agentId: AGENT_ID }) },
    },
    async (req) => {
      const auth = staffOf(req);
      return respond(ctx, auth, CONTROL, AI_AGENT, await control.get<unknown>(`/internal/v1/agents/${req.params.agentId}`, { actor: auth.actor }));
    },
  );
  app.patch<{ Params: { agentId: string }; Body: AiAgentPatch }>(
    "/admin/v1/ai/agents/:agentId",
    {
      config: { ...requirePermission("ops.kill_switch"), ...requireStepUp() },
      schema: {
        response: ok(AI_AGENT_SAVED.schema),
        params: params({ agentId: AGENT_ID }),
        body: obj(
          {
            degraded_mode: enumOf(["fallback_model", "refuse", "none"]),
            degrade_at_pct: { type: "integer", minimum: 50, maximum: 100 },
            per_request_max_usd: MONEY(6),
            monthly_cap_usd: { anyOf: [MONEY(2), { type: "null" }] },
            max_tool_calls: { type: "integer", minimum: 0, maximum: 5 },
            model_fallback: { anyOf: [MODEL_KEY, { type: "null" }] },
            reason: REASON_IN,
            expected_version: EXPECTED_VERSION,
          },
          ["reason", "expected_version"],
          { minProperties: 3 },
        ),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = { ...req.body, reason: reasonOf(req.body.reason) };
      const res = await control.call<unknown>("PATCH", `/internal/v1/agents/${req.params.agentId}`, {
        actor: auth.actor,
        body,
        ...command(idempotencyKeyOf(req, true)),
      });
      return respond(ctx, auth, CONTROL, AI_AGENT_SAVED, res.body);
    },
  );

  // ------------------------------------------------------------ алерты (ai-control §2.6)

  app.get<{ Querystring: { unacked?: string; agent_id?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/ai/alerts",
    {
      config: requirePermission("dashboard.read", "ops.kill_switch"),
      schema: { response: ok(AI_ALERT_PAGE.schema), querystring: query({ unacked: BOOL_Q, agent_id: AGENT_ID, cursor: CURSOR_Q, limit: LIMIT_Q }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await control.get<unknown>("/internal/v1/budgets/alerts", {
        actor: auth.actor,
        query: { unacked: req.query.unacked, agent_id: req.query.agent_id, ...pageQuery(req.query) },
      });
      return respond(ctx, auth, CONTROL, AI_ALERT_PAGE, body);
    },
  );
  app.post<{ Params: { ref: string } }>(
    "/admin/v1/ai/alerts/:ref",
    {
      config: requirePermission("ops.kill_switch"),
      schema: {
        response: ok(AI_ALERT.schema),
        params: params({ ref: str(40, 40, { pattern: `^${(UUID.pattern as string).slice(1, -1)}:ack$` }) }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const id = req.params.ref.slice(0, 36).toLowerCase();
      const res = await control.call<unknown>("POST", `/internal/v1/budgets/alerts/${id}:ack`, {
        actor: auth.actor,
        ...command(idempotencyKeyOf(req, false) ?? `ack-${id}`),
      });
      return respond(ctx, auth, CONTROL, AI_ALERT, res.body);
    },
  );

  // ------------------------------------------------------------ каталог цен (ai-control §2.5)

  app.get(
    "/admin/v1/ai/pricing/versions",
    { config: requirePermission("dashboard.read"), schema: { response: ok(PRICE_LIST.schema) } },
    async (req) => {
      const auth = staffOf(req);
      return respond(ctx, auth, CONTROL, PRICE_LIST, await control.get<unknown>("/internal/v1/pricing/versions", { actor: auth.actor }));
    },
  );
  const VERSION_PARAM = params({ version: str(3, 16, { pattern: `^${PRICE_VERSION}$` }) });
  app.get<{ Params: { version: string } }>(
    "/admin/v1/ai/pricing/versions/:version",
    { config: requirePermission("dashboard.read"), schema: { response: ok(PRICE_VERSION_C.schema), params: VERSION_PARAM } },
    async (req) => {
      const auth = staffOf(req);
      const body = await control.get<unknown>(`/internal/v1/pricing/versions/${req.params.version}`, { actor: auth.actor });
      return respond(ctx, auth, CONTROL, PRICE_VERSION_C, body);
    },
  );
  app.post<{ Body: PriceCatalogDraftInput }>(
    "/admin/v1/ai/pricing/versions",
    {
      config: requirePermission("ops.kill_switch"),
      schema: {
        response: ok(PRICE_VERSION_C.schema),
        body: obj({ based_on: str(3, 16, { pattern: `^${PRICE_VERSION}$` }), items: PRICE_ITEMS, note: str(0, 500), reason: REASON_IN }),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await control.call<unknown>("POST", "/internal/v1/pricing/versions", {
        actor: auth.actor,
        body: req.body,
        ...command(idempotencyKeyOf(req, true)),
      });
      return reply.status(res.status).send(await respond(ctx, auth, CONTROL, PRICE_VERSION_C, res.body));
    },
  );
  app.patch<{ Params: { version: string }; Body: PriceCatalogPatch }>(
    "/admin/v1/ai/pricing/versions/:version",
    {
      config: requirePermission("ops.kill_switch"),
      schema: {
        response: ok(PRICE_VERSION_C.schema),
        params: VERSION_PARAM,
        body: obj({ items: PRICE_ITEMS, note: str(0, 500), reason: REASON_IN, expected_version: EXPECTED_VERSION }, ["expected_version"], { minProperties: 2 }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const res = await control.call<unknown>("PATCH", `/internal/v1/pricing/versions/${req.params.version}`, {
        actor: auth.actor,
        body: req.body,
        ...command(idempotencyKeyOf(req, true)),
      });
      return respond(ctx, auth, CONTROL, PRICE_VERSION_C, res.body);
    },
  );
  app.post<{ Params: { ref: string }; Body: PriceCatalogActivateInput }>(
    "/admin/v1/ai/pricing/versions/:ref",
    {
      config: { ...requirePermission("ops.kill_switch"), ...requireStepUp() },
      schema: {
        response: ok(PRICE_VERSION_C.schema),
        params: params({ ref: str(12, 26, { pattern: `^${PRICE_VERSION}:activate$` }) }),
        body: obj({ reason: REASON_IN, expected_version: EXPECTED_VERSION }, ["reason"]),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const version = req.params.ref.slice(0, -":activate".length);
      if (version === "env") throw validationError("version", "Снимок env не активируется", "params");
      const res = await control.call<unknown>("POST", `/internal/v1/pricing/versions/${version}:activate`, {
        actor: auth.actor,
        body: { ...req.body, reason: reasonOf(req.body.reason) },
        ...command(idempotencyKeyOf(req, true)),
      });
      return respond(ctx, auth, CONTROL, PRICE_VERSION_C, res.body);
    },
  );

  // ------------------------------------------------------------ уровни доступа (ai-control §2.7)

  app.get(
    "/admin/v1/ai/access-levels",
    { config: requirePermission("dashboard.read", "ops.kill_switch", "users.read"), schema: { response: ok(ACCESS_LEVEL_LIST.schema) } },
    async (req) => {
      const auth = staffOf(req);
      return respond(ctx, auth, CONTROL, ACCESS_LEVEL_LIST, await control.get<unknown>("/internal/v1/access/levels", { actor: auth.actor }));
    },
  );
  app.put<{ Params: { code: string }; Body: AccessLevelInput }>(
    "/admin/v1/ai/access-levels/:code",
    {
      config: { ...requirePermission("ops.kill_switch"), ...requireStepUp() },
      schema: {
        response: ok(ACCESS_LEVEL_SAVED.schema),
        params: params({ code: LEVEL_CODE }),
        body: obj(
          {
            name_ru: str(1, 60),
            name_en: str(1, 60),
            concierge_messages_per_day: { type: "integer", minimum: 0, maximum: 1000 },
            is_default: { type: "boolean" },
            sort: { type: "integer", minimum: 0, maximum: 1000 },
            reason: REASON_IN,
            expected_version: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
          },
          ["name_ru", "name_en", "concierge_messages_per_day", "reason"],
        ),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const name_ru = req.body.name_ru.trim();
      const name_en = req.body.name_en.trim();
      if (!name_ru) throw validationError("name_ru", "Название — обязательно");
      if (!name_en) throw validationError("name_en", "Название — обязательно");
      const res = await control.call<unknown>("PUT", `/internal/v1/access/levels/${req.params.code}`, {
        actor: auth.actor,
        body: { ...req.body, name_ru, name_en, reason: reasonOf(req.body.reason) },
        ...command(idempotencyKeyOf(req, true)),
      });
      return respond(ctx, auth, CONTROL, ACCESS_LEVEL_SAVED, res.body);
    },
  );
  // причина — в теле (ревью 7): URL с причиной попадает в журналы доступа прокси и браузера
  app.delete<{ Params: { code: string }; Body: { reason: string } }>(
    "/admin/v1/ai/access-levels/:code",
    {
      config: { ...requirePermission("ops.kill_switch"), ...requireStepUp() },
      schema: {
        response: ok(obj({ code: { type: "string" }, deleted: { type: "boolean" } })),
        params: params({ code: LEVEL_CODE }),
        body: obj({ reason: REASON_IN }, ["reason"]),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      // ai-control (INTERNAL_API §2.7, ревью 7): причина — в теле DELETE
      await control.call<unknown>("DELETE", `/internal/v1/access/levels/${req.params.code}`, {
        actor: auth.actor,
        body: { reason: reasonOf(req.body.reason) },
        ...command(idempotencyKeyOf(req, true)),
      });
      return { code: req.params.code, deleted: true };
    },
  );
}

