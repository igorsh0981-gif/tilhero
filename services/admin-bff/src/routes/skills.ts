/**
 * Спринт 7 — «Агенты и Skills», Test Console (docs/sprint7/INTERNAL_API.md §2.2–2.3, §6). Домен — ai-control.
 *  - чтение (dashboard.read): реестр, skill с версиями и активациями, версия (артефакт целиком), сравнение версий,
 *    прогон Test Console, кейсы;
 *  - skills.edit: новая версия (Idempotency-Key обязателен), правка DRAFT/TESTED/REVIEW (→ DRAFT), прогон, запрос
 *    ревью, кейсы Test Console;
 *  - skills.publish: одобрение/отклонение (four-eyes проверяет домен: SKILL_REVIEWER_IS_AUTHOR), публикация (+ step-up),
 *    вывод из эксплуатации; откат — skills.publish или ops.kill_switch (аварийный) + step-up, всегда новая активация.
 * Аудит пишет ai-control синхронно: 15 с без повторов, 503 → AUDIT_UNAVAILABLE. Ответы — строгая нормализация
 * (aiCodecs.ts); результаты Test Console — сводка без текста ответа модели.
 */
import { AppError } from "@tilhero/ts-common";
import type {
  EvalCaseInput,
  EvalCasePatch,
  EvalRunInput,
  SkillContent,
  SkillPublishInput,
  SkillReviewInput,
  SkillRollbackInput,
  SkillVersionCreate,
  SkillVersionPatch,
} from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { hasPermission, idempotencyKeyOf, staffOf, validationError, type App } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { EXPECTED_VERSION, UUID, enumOf, obj, params, query, str } from "../schemas.js";
import { ok } from "../responses.js";
import {
  EVAL_CASE,
  EVAL_CASE_LIST,
  EVAL_RUN,
  EVAL_RUN_STARTED,
  SKILL_COMPARE,
  SKILL_DETAIL,
  SKILL_LIST,
  SKILL_ROLLBACK,
  SKILL_VERSION,
} from "./aiCodecs.js";
import { REASON_IN, command, reasonOf, respond } from "./aiCommon.js";

const CONTROL = "ai-control";
const SKILL_ID = str(3, 64, { pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$" });
const VERSION = str(1, 6, { pattern: "^[1-9][0-9]{0,5}$" });
const VERSION_INT = { type: "integer", minimum: 1, maximum: 100_000 };
const MODEL_KEY = str(3, 64, { pattern: "^[a-z0-9][a-z0-9.\\-_]{2,63}$" });
const TOOL = str(3, 40, { pattern: "^[a-z_]{3,40}$" });

/** Поля артефакта (ТЗ Admin §8) — первая линия проверки; полную (whitelist, каталог цен, лимит агента) делает домен. */
const CONTENT_PROPS = {
  system_instruction: str(1, 20_000),
  output_schema: enumOf(["concierge-answer-v1"]),
  allowed_tools: { type: "array", maxItems: 10, uniqueItems: true, items: TOOL },
  source_priority: { type: "array", maxItems: 4, uniqueItems: true, items: enumOf(["official", "ticket_provider", "provider", "trusted_media"]) },
  model_policy: obj({ primary: MODEL_KEY, fallback: { anyOf: [MODEL_KEY, { type: "null" }] } }, ["primary"]),
  limits: obj(
    {
      max_tokens: { type: "integer", minimum: 64, maximum: 4096 },
      max_cost_usd: str(1, 12, { pattern: "^\\d(\\.\\d{1,6})?$" }),
      timeout_ms: { type: "integer", minimum: 1000, maximum: 120_000 },
      retries: { type: "integer", minimum: 0, maximum: 3 },
    },
    ["max_tokens", "max_cost_usd", "timeout_ms", "retries"],
  ),
  confidence: obj({ min: { type: "number", minimum: 0, maximum: 1 } }, ["min"]),
  safety_policy: obj(
    {
      no_invented_prices: { type: "boolean" },
      source_required: { type: "boolean" },
      web_content_untrusted: { type: "boolean" },
      tool_before_claim: { type: "boolean" },
    },
    ["no_invented_prices", "source_required", "web_content_untrusted", "tool_before_claim"],
  ),
  change_note: { anyOf: [str(0, 1000), { type: "null" }] },
};
const CONTENT_REQUIRED = ["system_instruction", "output_schema", "allowed_tools", "source_priority", "model_policy", "limits"];
const JSON_OBJ = { type: "object", additionalProperties: true, maxProperties: 50 };

const skillPath = (id: string) => `/internal/v1/skills/${id}`;
const versionPath = (id: string, v: string | number) => `${skillPath(id)}/versions/${v}`;

/** Ровно два знака после точки у confidence.min (как домен); NaN и прочее отсечёт схема. */
function checkContent(c: Partial<SkillContent>): void {
  if (c.confidence && Math.round(c.confidence.min * 100) !== c.confidence.min * 100) {
    throw validationError("confidence.min", "Порог уверенности — от 0 до 1, не больше 2 знаков после точки");
  }
  if (c.system_instruction !== undefined && c.system_instruction.includes("\u0000")) {
    throw validationError("system_instruction", "Недопустимый символ в инструкции");
  }
}

export function skillRoutes(app: App, ctx: BffContext): void {
  const control = ctx.domains.aiControl;

  // ------------------------------------------------------------ чтение

  app.get("/admin/v1/skills", { config: requirePermission("dashboard.read"), schema: { response: ok(SKILL_LIST.schema) } }, async (req) => {
    const auth = staffOf(req);
    return respond(ctx, auth, CONTROL, SKILL_LIST, await control.get<unknown>("/internal/v1/skills", { actor: auth.actor }));
  });

  app.get<{ Params: { skillId: string } }>(
    "/admin/v1/skills/:skillId",
    { config: requirePermission("dashboard.read"), schema: { response: ok(SKILL_DETAIL.schema), params: params({ skillId: SKILL_ID }) } },
    async (req) => {
      const auth = staffOf(req);
      return respond(ctx, auth, CONTROL, SKILL_DETAIL, await control.get<unknown>(skillPath(req.params.skillId), { actor: auth.actor }));
    },
  );

  app.get<{ Params: { skillId: string; v: string } }>(
    "/admin/v1/skills/:skillId/versions/:v",
    { config: requirePermission("dashboard.read"), schema: { response: ok(SKILL_VERSION.schema), params: params({ skillId: SKILL_ID, v: VERSION }) } },
    async (req) => {
      const auth = staffOf(req);
      const body = await control.get<unknown>(versionPath(req.params.skillId, req.params.v), { actor: auth.actor });
      return respond(ctx, auth, CONTROL, SKILL_VERSION, body);
    },
  );

  app.get<{ Params: { skillId: string }; Querystring: { a: string; b: string } }>(
    "/admin/v1/skills/:skillId/compare",
    {
      config: requirePermission("dashboard.read"),
      schema: { response: ok(SKILL_COMPARE.schema), params: params({ skillId: SKILL_ID }), querystring: obj({ a: VERSION, b: VERSION }, ["a", "b"]) },
    },
    async (req) => {
      const auth = staffOf(req);
      if (req.query.a === req.query.b) throw validationError("b", "Выберите две разные версии", "querystring");
      const body = await control.get<unknown>(`${skillPath(req.params.skillId)}/compare`, { actor: auth.actor, query: { a: req.query.a, b: req.query.b } });
      return respond(ctx, auth, CONTROL, SKILL_COMPARE, body);
    },
  );

  // ------------------------------------------------------------ версии (skills.edit)

  app.post<{ Params: { skillId: string }; Body: SkillVersionCreate }>(
    "/admin/v1/skills/:skillId/versions",
    {
      config: requirePermission("skills.edit"),
      schema: {
        response: ok(SKILL_VERSION.schema),
        params: params({ skillId: SKILL_ID }),
        body: obj({ from_version: VERSION_INT, artifact: obj(CONTENT_PROPS, CONTENT_REQUIRED) }),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      if (req.body.artifact) checkContent(req.body.artifact);
      const res = await control.call<unknown>("POST", `${skillPath(req.params.skillId)}/versions`, {
        actor: auth.actor,
        body: req.body,
        ...command(idempotencyKeyOf(req, true)),
      });
      return reply.status(res.status).send(await respond(ctx, auth, CONTROL, SKILL_VERSION, res.body));
    },
  );

  app.patch<{ Params: { skillId: string; v: string }; Body: SkillVersionPatch }>(
    "/admin/v1/skills/:skillId/versions/:v",
    {
      config: requirePermission("skills.edit"),
      schema: {
        response: ok(SKILL_VERSION.schema),
        params: params({ skillId: SKILL_ID, v: VERSION }),
        body: obj({ ...CONTENT_PROPS, expected_version: EXPECTED_VERSION }, ["expected_version"], { minProperties: 2 }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      checkContent(req.body);
      const res = await control.call<unknown>("PATCH", versionPath(req.params.skillId, req.params.v), {
        actor: auth.actor,
        body: req.body,
        ...command(idempotencyKeyOf(req, true)),
      });
      return respond(ctx, auth, CONTROL, SKILL_VERSION, res.body);
    },
  );

  app.post<{ Params: { skillId: string; v: string }; Body: EvalRunInput }>(
    "/admin/v1/skills/:skillId/versions/:v/test",
    {
      config: requirePermission("skills.edit"),
      schema: {
        response: ok(EVAL_RUN_STARTED.schema),
        params: params({ skillId: SKILL_ID, v: VERSION }),
        body: obj({ case_ids: { type: "array", maxItems: 100, uniqueItems: true, items: UUID }, compare_version: VERSION_INT }),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      if (req.body.compare_version !== undefined && String(req.body.compare_version) === req.params.v) {
        throw validationError("compare_version", "Сравнивать версию с самой собой не нужно");
      }
      const res = await control.call<unknown>("POST", `${versionPath(req.params.skillId, req.params.v)}/test`, {
        actor: auth.actor,
        body: req.body,
        ...command(idempotencyKeyOf(req, true)),
      });
      return reply.status(res.status).send(await respond(ctx, auth, CONTROL, EVAL_RUN_STARTED, res.body));
    },
  );

  // ------------------------------------------------------------ lifecycle

  app.post<{ Params: { skillId: string; v: string }; Body: SkillReviewInput }>(
    "/admin/v1/skills/:skillId/versions/:v/review",
    {
      config: requirePermission("skills.edit", "skills.publish"),
      schema: {
        response: ok(SKILL_VERSION.schema),
        params: params({ skillId: SKILL_ID, v: VERSION }),
        body: obj({ action: enumOf(["request", "approve", "reject"]), comment: str(0, 1000) }, ["action"]),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const need = req.body.action === "request" ? "skills.edit" : "skills.publish";
      if (!hasPermission(auth, need)) throw new AppError(403, "PERMISSION_DENIED", "Недостаточно прав", { permission: need });
      if (req.body.action === "reject" && (req.body.comment ?? "").trim().length < 3) {
        throw validationError("comment", "Отклонение — с комментарием (от 3 символов)");
      }
      const res = await control.call<unknown>("POST", `${versionPath(req.params.skillId, req.params.v)}/review`, {
        actor: auth.actor,
        body: req.body,
        ...command(idempotencyKeyOf(req, true)),
      });
      return respond(ctx, auth, CONTROL, SKILL_VERSION, res.body);
    },
  );

  app.post<{ Params: { skillId: string; v: string }; Body: SkillPublishInput }>(
    "/admin/v1/skills/:skillId/versions/:v/publish",
    {
      config: { ...requirePermission("skills.publish"), ...requireStepUp() },
      schema: {
        response: ok(SKILL_VERSION.schema),
        params: params({ skillId: SKILL_ID, v: VERSION }),
        body: obj({ reason: REASON_IN, effective_from: str(20, 40, { pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,6})?)?(Z|[+-]\\d{2}:\\d{2})$" }) }, ["reason"]),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = { ...req.body, reason: reasonOf(req.body.reason) };
      if (body.effective_from !== undefined && Date.parse(body.effective_from) < ctx.now() - 60_000) {
        throw validationError("effective_from", "Начало действия — не в прошлом");
      }
      const res = await control.call<unknown>("POST", `${versionPath(req.params.skillId, req.params.v)}/publish`, {
        actor: auth.actor,
        body,
        ...command(idempotencyKeyOf(req, true)),
      });
      return respond(ctx, auth, CONTROL, SKILL_VERSION, res.body);
    },
  );

  app.post<{ Params: { skillId: string }; Body: SkillRollbackInput }>(
    "/admin/v1/skills/:skillId/rollback",
    {
      config: { ...requirePermission("skills.publish", "ops.kill_switch"), ...requireStepUp() },
      schema: {
        response: ok(SKILL_ROLLBACK.schema),
        params: params({ skillId: SKILL_ID }),
        body: obj({ to_version: VERSION_INT, reason: REASON_IN }, ["to_version", "reason"]),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const res = await control.call<unknown>("POST", `${skillPath(req.params.skillId)}/rollback`, {
        actor: auth.actor,
        body: { to_version: req.body.to_version, reason: reasonOf(req.body.reason) },
        ...command(idempotencyKeyOf(req, true)),
      });
      return respond(ctx, auth, CONTROL, SKILL_ROLLBACK, res.body);
    },
  );

  app.post<{ Params: { skillId: string; v: string }; Body: { reason: string } }>(
    "/admin/v1/skills/:skillId/versions/:v/deprecate",
    {
      config: requirePermission("skills.publish"),
      schema: { response: ok(SKILL_VERSION.schema), params: params({ skillId: SKILL_ID, v: VERSION }), body: obj({ reason: REASON_IN }, ["reason"]) },
    },
    async (req) => {
      const auth = staffOf(req);
      const res = await control.call<unknown>("POST", `${versionPath(req.params.skillId, req.params.v)}/deprecate`, {
        actor: auth.actor,
        body: { reason: reasonOf(req.body.reason) },
        ...command(idempotencyKeyOf(req, true)),
      });
      return respond(ctx, auth, CONTROL, SKILL_VERSION, res.body);
    },
  );

  // ------------------------------------------------------------ Test Console (ai-control §2.3)

  app.get<{ Params: { runId: string } }>(
    "/admin/v1/evaluation/runs/:runId",
    { config: requirePermission("dashboard.read"), schema: { response: ok(EVAL_RUN.schema), params: params({ runId: UUID }) } },
    async (req) => {
      const auth = staffOf(req);
      const body = await control.get<unknown>(`/internal/v1/evaluation/runs/${req.params.runId.toLowerCase()}`, { actor: auth.actor });
      return respond(ctx, auth, CONTROL, EVAL_RUN, body);
    },
  );

  app.get<{ Querystring: { skill_id?: string } }>(
    "/admin/v1/evaluation/cases",
    { config: requirePermission("dashboard.read"), schema: { response: ok(EVAL_CASE_LIST.schema), querystring: query({ skill_id: SKILL_ID }) } },
    async (req) => {
      const auth = staffOf(req);
      const body = await control.get<unknown>("/internal/v1/evaluation/cases", { actor: auth.actor, query: { skill_id: req.query.skill_id } });
      return respond(ctx, auth, CONTROL, EVAL_CASE_LIST, body);
    },
  );

  const CASE_PROPS = {
    name: str(2, 80, { pattern: "^[a-z][a-z0-9_]{1,79}$" }),
    required: { type: "boolean" },
    enabled: { type: "boolean" },
    input: JSON_OBJ,
    tool_fixtures: JSON_OBJ,
    expect: JSON_OBJ,
    reason: REASON_IN,
  };
  app.post<{ Body: EvalCaseInput }>(
    "/admin/v1/evaluation/cases",
    {
      config: requirePermission("skills.edit"),
      schema: { response: ok(EVAL_CASE.schema), body: obj({ skill_id: SKILL_ID, ...CASE_PROPS }, ["skill_id", "name", "input"]) },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await control.call<unknown>("POST", "/internal/v1/evaluation/cases", {
        actor: auth.actor,
        body: req.body,
        ...command(idempotencyKeyOf(req, true)),
      });
      return reply.status(res.status).send(await respond(ctx, auth, CONTROL, EVAL_CASE, res.body));
    },
  );
  app.patch<{ Params: { caseId: string }; Body: EvalCasePatch }>(
    "/admin/v1/evaluation/cases/:caseId",
    {
      config: requirePermission("skills.edit"),
      schema: {
        response: ok(EVAL_CASE.schema),
        params: params({ caseId: UUID }),
        body: obj({ ...CASE_PROPS, expected_version: EXPECTED_VERSION }, ["expected_version"], { minProperties: 2 }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const res = await control.call<unknown>("PATCH", `/internal/v1/evaluation/cases/${req.params.caseId.toLowerCase()}`, {
        actor: auth.actor,
        body: req.body,
        ...command(idempotencyKeyOf(req, true)),
      });
      return respond(ctx, auth, CONTROL, EVAL_CASE, res.body);
    },
  );
  app.delete<{ Params: { caseId: string }; Querystring: { reason: string } }>(
    "/admin/v1/evaluation/cases/:caseId",
    {
      config: requirePermission("skills.edit"),
      schema: {
        response: ok(obj({ case_id: { type: "string" }, deleted: { type: "boolean" } })),
        params: params({ caseId: UUID }),
        querystring: obj({ reason: REASON_IN }, ["reason"]),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const id = req.params.caseId.toLowerCase();
      await control.call<unknown>("DELETE", `/internal/v1/evaluation/cases/${id}`, {
        actor: auth.actor,
        query: { reason: reasonOf(req.query.reason) },
        ...command(idempotencyKeyOf(req, true)),
      });
      return { case_id: id, deleted: true };
    },
  );
}
