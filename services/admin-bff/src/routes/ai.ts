/**
 * Агенты и скиллы, модели, бюджет и затраты ИИ (admin.ts «ИИ, контроль диалогов, затраты»; ai-gateway
 * `/admin/v1/ai/*`, пути совпадают с путями домена — docs/sprint4/INTERNAL_API.md §1.5).
 *
 * ai.read — реестр агентов, карточка, версия, прогон золотых тестов, золотые тесты, модели, провайдер;
 * ai.manage — черновик версии (из опубликованной или указанной), правка и удаление черновика, золотые тесты, запуск
 * прогона; ai.publish + step-up — публикация версии, канарейка (установка и снятие), откат, правка модели и цен;
 * costs.read — бюджет и затраты; costs.manage + step-up — бюджет и аварийная остановка; вызовы сессии
 * (`usage?session_id=`) — ещё и qa.read («Контроль диалогов»). Права проверяются здесь до вызова домена, ai-gateway
 * проверяет их повторно по actor.
 *
 * Ошибки домена — как есть: 422 TESTS_REQUIRED | TESTS_FAILED {case_ids}, 409 DRAFT_EXISTS {version},
 * VERSION_NOT_DRAFT, VERSION_CONFLICT, NO_PREVIOUS_VERSION, 404 AGENT_NOT_FOUND …
 * Лимит тела: создание и правка версии — 128 КБ (инструкции ≤ 20 000 + правила ≤ 10 000 символов), остальное — 64 КБ.
 * Ключ провайдера в ответах не пропускается никогда (aiGateway.ts).
 */
import type { FastifyReply } from "fastify";
import { AppError } from "@tilhero/ts-common";
import { aiCall, aiGet, AI_SERVICE } from "../aiGateway.js";
import type { Codec } from "../codec.js";
import {
  AGENT_DETAIL,
  AGENT_DETAIL_DOMAIN,
  AGENT_ROW,
  AGENT_ROW_DOMAIN,
  AGENT_ROWS,
  AGENT_ROWS_DOMAIN,
  AGENT_VERSION_VIEW,
  AI_BUDGET,
  AI_CALL_PAGE,
  AI_MODEL,
  AI_MODELS,
  AI_PROVIDER,
  AI_USAGE_SUMMARY,
  GOLDEN_CASE,
  GOLDEN_CASES,
  TEST_RUN,
  TEST_RUN_SUMMARY,
  publicAgentDetail,
  publicAgentRow,
} from "../contractAi.js";
import type { BffContext } from "../context.js";
import { hasPermission, idempotencyKeyOf, ifMatchOf, passReplayed, staffOf, validationError, type App, type StaffAuth } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { NO_CONTENT } from "../responses.js";
import {
  AGENT_CANARY_SET,
  AGENT_ID,
  AGENT_VERSION_BODY_LIMIT,
  AGENT_VERSION_CREATE,
  AGENT_VERSION_PATCH,
  BUDGET_UPDATE,
  CASE_ID,
  CURSOR_Q,
  EMERGENCY_STOP,
  GOLDEN_CASE_CREATE,
  GOLDEN_CASE_PATCH,
  LIMIT_Q,
  MODEL_ID,
  MODEL_UPDATE,
  REASON_ONLY,
  USAGE_PERIODS,
  UUID,
  VERSION_NO,
  enumOf,
  obj,
  pageQuery,
  params,
  query,
} from "../schemas.js";
import type { DomainResponse } from "../upstream.js";
import { out, shaped } from "./common.js";

const BASE = "/admin/v1/ai";
const AGENT_PARAMS = params({ agentId: AGENT_ID });
const VERSION_PARAMS = params({ agentId: AGENT_ID, v: VERSION_NO });
const RUN_PARAMS = params({ agentId: AGENT_ID, v: VERSION_NO, runId: UUID });
const CASE_PARAMS = params({ caseId: CASE_ID });
const MODEL_PARAMS = params({ modelId: MODEL_ID });
const EMPTY = obj({});

type AgentP = { agentId: string };
type VersionP = AgentP & { v: string };

export function aiRoutes(app: App, ctx: BffContext): void {
  const agentPath = (p: AgentP) => `${BASE}/agents/${p.agentId}`;
  const versionPath = (p: VersionP) => `${agentPath(p)}/versions/${Number(p.v)}`;

  /** Ответ команды ai-gateway: тело по кодеку (+ имена), статус домена, Idempotent-Replayed. */
  async function relayAi<T>(auth: StaffAuth, reply: FastifyReply, c: Codec<T>, res: DomainResponse<unknown>, names = false): Promise<FastifyReply> {
    passReplayed(reply, res);
    return reply.status(res.status).send(await shaped(ctx, auth, AI_SERVICE, c, res.body, { names }));
  }
  /** Команда над агентом → AgentRow (published_by → published_by_name). */
  async function rowReply(auth: StaffAuth, reply: FastifyReply, res: DomainResponse<unknown>): Promise<FastifyReply> {
    passReplayed(reply, res);
    const row = await shaped(ctx, auth, AI_SERVICE, AGENT_ROW_DOMAIN, res.body, { names: true });
    return reply.status(res.status).send(publicAgentRow(row));
  }

  // ---------------------------------------------------------------- агенты

  app.get(`${BASE}/agents`, { config: requirePermission("ai.read"), schema: { response: out(AGENT_ROWS) } }, async (req) => {
    const auth = staffOf(req);
    const page = await shaped(ctx, auth, AI_SERVICE, AGENT_ROWS_DOMAIN, await aiGet(ctx, `${BASE}/agents`, { actor: auth.actor }), { names: true });
    return { items: page.items.map(publicAgentRow) };
  });

  app.get<{ Params: AgentP }>(
    `${BASE}/agents/:agentId`,
    { config: requirePermission("ai.read"), schema: { response: out(AGENT_DETAIL), params: AGENT_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      const d = await shaped(ctx, auth, AI_SERVICE, AGENT_DETAIL_DOMAIN, await aiGet(ctx, agentPath(req.params), { actor: auth.actor }), { names: true });
      return publicAgentDetail(d);
    },
  );

  // ---------------------------------------------------------------- версии инструкций

  app.get<{ Params: VersionP }>(
    `${BASE}/agents/:agentId/versions/:v`,
    { config: requirePermission("ai.read"), schema: { response: out(AGENT_VERSION_VIEW), params: VERSION_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, AI_SERVICE, AGENT_VERSION_VIEW, await aiGet(ctx, versionPath(req.params), { actor: auth.actor }), { names: true });
    },
  );

  /** Черновик из опубликованной (или from_version) → 201 версия (AgentVersion & names & updated_at, как GET);
   *  409 DRAFT_EXISTS {version} — как есть. */
  app.post<{ Params: AgentP; Body: { from_version?: number } }>(
    `${BASE}/agents/:agentId/versions`,
    {
      bodyLimit: AGENT_VERSION_BODY_LIMIT,
      config: requirePermission("ai.manage"),
      schema: { response: out(AGENT_VERSION_VIEW), params: AGENT_PARAMS, body: AGENT_VERSION_CREATE },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await aiCall(ctx, "POST", `${agentPath(req.params)}/versions`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relayAi(auth, reply, AGENT_VERSION_VIEW, res, true);
    },
  );

  /** Правка черновика (If-Match: updated_at → 409 VERSION_CONFLICT домена, без If-Match — 428 IF_MATCH_REQUIRED
   *  домена); не черновик → 409 VERSION_NOT_DRAFT. Ответ — как GET версии (новый updated_at для следующей правки). */
  app.patch<{ Params: VersionP; Body: Record<string, unknown> }>(
    `${BASE}/agents/:agentId/versions/:v`,
    {
      bodyLimit: AGENT_VERSION_BODY_LIMIT,
      config: requirePermission("ai.manage"),
      schema: { response: out(AGENT_VERSION_VIEW), params: VERSION_PARAMS, body: AGENT_VERSION_PATCH },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await aiCall(ctx, "PATCH", versionPath(req.params), {
        actor: auth.actor,
        body: req.body,
        headers: ifMatchOf(req.headers["if-match"]),
      });
      return relayAi(auth, reply, AGENT_VERSION_VIEW, res, true);
    },
  );

  app.delete<{ Params: VersionP }>(
    `${BASE}/agents/:agentId/versions/:v`,
    { config: requirePermission("ai.manage"), schema: { response: NO_CONTENT, params: VERSION_PARAMS } },
    async (req, reply) => {
      const auth = staffOf(req);
      await aiCall(ctx, "DELETE", versionPath(req.params), { actor: auth.actor });
      return reply.status(204).send();
    },
  );

  /** Прогон золотых тестов (асинхронно) → 202 TestRunSummary; результат — опросом GET …/test-runs/{run_id}. */
  app.post<{ Params: VersionP }>(
    `${BASE}/agents/:agentId/versions/:v/test-runs`,
    { config: requirePermission("ai.manage"), schema: { response: out(TEST_RUN_SUMMARY), params: VERSION_PARAMS, body: EMPTY } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await aiCall(ctx, "POST", `${versionPath(req.params)}/test-runs`, {
        actor: auth.actor,
        body: {},
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relayAi(auth, reply, TEST_RUN_SUMMARY, res);
    },
  );

  app.get<{ Params: VersionP & { runId: string } }>(
    `${BASE}/agents/:agentId/versions/:v/test-runs/:runId`,
    { config: requirePermission("ai.read"), schema: { response: out(TEST_RUN), params: RUN_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      const body = await aiGet(ctx, `${versionPath(req.params)}/test-runs/${req.params.runId.toLowerCase()}`, { actor: auth.actor });
      return shaped(ctx, auth, AI_SERVICE, TEST_RUN, body);
    },
  );

  /** Публикация (ai.publish, step-up) → AgentRow; 422 TESTS_REQUIRED | TESTS_FAILED {case_ids} — как есть. */
  app.post<{ Params: VersionP; Body: { reason: string } }>(
    `${BASE}/agents/:agentId/versions/:v/publish`,
    {
      config: { ...requirePermission("ai.publish"), ...requireStepUp() },
      schema: { response: out(AGENT_ROW), params: VERSION_PARAMS, body: REASON_ONLY },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await aiCall(ctx, "POST", `${versionPath(req.params)}/publish`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return rowReply(auth, reply, res);
    },
  );

  // ---------------------------------------------------------------- канарейка и откат

  app.put<{ Params: AgentP; Body: { version: number; percent: number; reason: string } }>(
    `${BASE}/agents/:agentId/canary`,
    {
      config: { ...requirePermission("ai.publish"), ...requireStepUp() },
      schema: { response: out(AGENT_ROW), params: AGENT_PARAMS, body: AGENT_CANARY_SET },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await aiCall(ctx, "PUT", `${agentPath(req.params)}/canary`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return rowReply(auth, reply, res);
    },
  );

  app.delete<{ Params: AgentP; Body: { reason: string } }>(
    `${BASE}/agents/:agentId/canary`,
    {
      config: { ...requirePermission("ai.publish"), ...requireStepUp() },
      schema: { response: out(AGENT_ROW), params: AGENT_PARAMS, body: REASON_ONLY },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await aiCall(ctx, "DELETE", `${agentPath(req.params)}/canary`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return rowReply(auth, reply, res);
    },
  );

  /** Откат к previous_version (ai.publish, step-up); 409 NO_PREVIOUS_VERSION — как есть. */
  app.post<{ Params: AgentP; Body: { reason: string } }>(
    `${BASE}/agents/:agentId/rollback`,
    {
      config: { ...requirePermission("ai.publish"), ...requireStepUp() },
      schema: { response: out(AGENT_ROW), params: AGENT_PARAMS, body: REASON_ONLY },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await aiCall(ctx, "POST", `${agentPath(req.params)}/rollback`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return rowReply(auth, reply, res);
    },
  );

  // ---------------------------------------------------------------- золотые тесты

  app.get<{ Params: AgentP }>(
    `${BASE}/agents/:agentId/golden-cases`,
    { config: requirePermission("ai.read"), schema: { response: out(GOLDEN_CASES), params: AGENT_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, AI_SERVICE, GOLDEN_CASES, await aiGet(ctx, `${agentPath(req.params)}/golden-cases`, { actor: auth.actor }));
    },
  );

  app.post<{ Params: AgentP; Body: Record<string, unknown> }>(
    `${BASE}/agents/:agentId/golden-cases`,
    { config: requirePermission("ai.manage"), schema: { response: out(GOLDEN_CASE), params: AGENT_PARAMS, body: GOLDEN_CASE_CREATE } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await aiCall(ctx, "POST", `${agentPath(req.params)}/golden-cases`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relayAi(auth, reply, GOLDEN_CASE, res);
    },
  );

  app.patch<{ Params: { caseId: string }; Body: Record<string, unknown> }>(
    `${BASE}/golden-cases/:caseId`,
    { config: requirePermission("ai.manage"), schema: { response: out(GOLDEN_CASE), params: CASE_PARAMS, body: GOLDEN_CASE_PATCH } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await aiCall(ctx, "PATCH", `${BASE}/golden-cases/${encodeURIComponent(req.params.caseId)}`, { actor: auth.actor, body: req.body });
      return relayAi(auth, reply, GOLDEN_CASE, res);
    },
  );

  /** Удаление = архив: домен отвечает 204 или 200 GoldenCase (с archived_at) — статус и тело передаются. */
  app.delete<{ Params: { caseId: string } }>(
    `${BASE}/golden-cases/:caseId`,
    { config: requirePermission("ai.manage"), schema: { response: { 200: GOLDEN_CASE.schema, ...NO_CONTENT }, params: CASE_PARAMS } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await aiCall(ctx, "DELETE", `${BASE}/golden-cases/${encodeURIComponent(req.params.caseId)}`, { actor: auth.actor });
      if (res.status === 204 || res.body === undefined) return reply.status(204).send();
      return reply.status(200).send(await shaped(ctx, auth, AI_SERVICE, GOLDEN_CASE, res.body));
    },
  );

  // ---------------------------------------------------------------- модели, провайдер

  app.get(`${BASE}/models`, { config: requirePermission("ai.read"), schema: { response: out(AI_MODELS) } }, async (req) => {
    const auth = staffOf(req);
    return shaped(ctx, auth, AI_SERVICE, AI_MODELS, await aiGet(ctx, `${BASE}/models`, { actor: auth.actor }));
  });

  app.put<{ Params: { modelId: string }; Body: Record<string, unknown> }>(
    `${BASE}/models/:modelId`,
    {
      config: { ...requirePermission("ai.publish"), ...requireStepUp() },
      schema: { response: out(AI_MODEL), params: MODEL_PARAMS, body: MODEL_UPDATE },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await aiCall(ctx, "PUT", `${BASE}/models/${encodeURIComponent(req.params.modelId)}`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relayAi(auth, reply, AI_MODEL, res);
    },
  );

  /** Провайдер: «ключ задан / не задан» и код последней ошибки — сам ключ не показывается никогда. */
  app.get(`${BASE}/provider`, { config: requirePermission("ai.read"), schema: { response: out(AI_PROVIDER) } }, async (req) => {
    const auth = staffOf(req);
    return shaped(ctx, auth, AI_SERVICE, AI_PROVIDER, await aiGet(ctx, `${BASE}/provider`, { actor: auth.actor }));
  });

  // ---------------------------------------------------------------- бюджет и аварийная остановка

  app.get(`${BASE}/budget`, { config: requirePermission("costs.read"), schema: { response: out(AI_BUDGET) } }, async (req) => {
    const auth = staffOf(req);
    return shaped(ctx, auth, AI_SERVICE, AI_BUDGET, await aiGet(ctx, `${BASE}/budget`, { actor: auth.actor }));
  });

  /** Лимиты ИИ (costs.manage, step-up); подлимит речи и потолок парной комнаты (спринт 7) — не больше месячного
   *  потолка (422 до домена). */
  app.put<{ Body: { monthly_cap_usd: number; speech_monthly_cap_usd: number; room_cap_usd?: number } & Record<string, unknown> }>(
    `${BASE}/budget`,
    { config: { ...requirePermission("costs.manage"), ...requireStepUp() }, schema: { response: out(AI_BUDGET), body: BUDGET_UPDATE } },
    async (req, reply) => {
      const auth = staffOf(req);
      if (req.body.speech_monthly_cap_usd > req.body.monthly_cap_usd) {
        throw validationError("speech_monthly_cap_usd", "Подлимит речи — не больше месячного потолка ИИ");
      }
      if (req.body.room_cap_usd !== undefined && req.body.room_cap_usd > req.body.monthly_cap_usd) {
        throw validationError("room_cap_usd", "Потолок парной комнаты — не больше месячного потолка ИИ");
      }
      const res = await aiCall(ctx, "PUT", `${BASE}/budget`, { actor: auth.actor, body: req.body, idempotencyKey: idempotencyKeyOf(req, false) });
      return relayAi(auth, reply, AI_BUDGET, res);
    },
  );

  /** Аварийная остановка ИИ: enabled=true — все вызовы unavailable (ai_disabled), уроки идут без ИИ. */
  app.post<{ Body: { enabled: boolean; reason: string } }>(
    `${BASE}/emergency-stop`,
    { config: { ...requirePermission("costs.manage"), ...requireStepUp() }, schema: { response: out(AI_BUDGET), body: EMERGENCY_STOP } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await aiCall(ctx, "POST", `${BASE}/emergency-stop`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relayAi(auth, reply, AI_BUDGET, res);
    },
  );

  // ---------------------------------------------------------------- затраты

  app.get<{ Querystring: { period?: string } }>(
    `${BASE}/usage/summary`,
    {
      config: requirePermission("costs.read"),
      schema: { response: out(AI_USAGE_SUMMARY), querystring: query({ period: enumOf(USAGE_PERIODS) }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await aiGet(ctx, `${BASE}/usage/summary`, { actor: auth.actor, query: { period: req.query.period ?? "month" } });
      return shaped(ctx, auth, AI_SERVICE, AI_USAGE_SUMMARY, body);
    },
  );

  /**
   * Вызовы ИИ (метаданные, без текста): costs.read — любые фильтры; qa.read — только вызовы одной сессии
   * (`session_id` обязателен, для карточки «Контроля диалогов»).
   */
  app.get<{ Querystring: { session_id?: string; agent_id?: string; cursor?: string; limit?: string } }>(
    `${BASE}/usage`,
    {
      config: requirePermission("costs.read", "qa.read"),
      schema: {
        response: out(AI_CALL_PAGE),
        querystring: query({ session_id: UUID, agent_id: AGENT_ID, cursor: CURSOR_Q, limit: LIMIT_Q }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      if (!hasPermission(auth, "costs.read") && !req.query.session_id) {
        throw new AppError(403, "PERMISSION_DENIED", "Недостаточно прав", { permission: "costs.read" });
      }
      const body = await aiGet(ctx, `${BASE}/usage`, {
        actor: auth.actor,
        query: { session_id: req.query.session_id?.toLowerCase(), agent_id: req.query.agent_id, ...pageQuery(req.query) },
      });
      return shaped(ctx, auth, AI_SERVICE, AI_CALL_PAGE, body);
    },
  );
}
