/**
 * Входная диагностика (APP-DIAG-01…04, AT-32…34) — diagnostics, sub = активный ученик (lrn). Ключей ответов в ответах
 * нет никогда (схема и явная сборка задания), правильность во время теста не показывается. Сегмент ученика `audience`
 * (kids / teens / adults по возрасту, content.ts) — в state и создание сессии: детям 6–13 — детский тест.
 *
 * Коды доменов передаются как есть (bff.ts): 404 DIAGNOSTIC_SESSION_NOT_FOUND | DIAGNOSTIC_RESULT_NOT_FOUND |
 * DIAGNOSTIC_TEST_NOT_FOUND; 409 DIAGNOSTIC_TOO_SOON {next_allowed_at} | PAIR_NOT_AVAILABLE | ITEM_NOT_CURRENT |
 * DIAGNOSTIC_SESSION_EXPIRED | DIAGNOSTIC_SESSION_CLOSED {status} | FOLLOWUP_NOT_AVAILABLE {area, reason};
 * 422 DIAGNOSTIC_EMPTY | ANSWER_INVALID; 410 USER_DELETED.
 */
import { Type } from "@fastify/type-provider-typebox";
import type { DiagnosticItem, DiagnosticResult } from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import type { FastifyBaseLogger } from "fastify";
import { asLearner } from "../account.js";
import { expectShape } from "../check.js";
import type { BffContext } from "../context.js";
import { upstreamUnavailable } from "../upstream.js";
import { BEARER, authOf, errorResponses, idempotencyKey, type App } from "../http.js";
import {
  AnswerRequestSchema,
  AnswerResultSchema,
  DEFAULT_PAIR,
  DiagnosticDoneSchema,
  DiagnosticItemSchema,
  DiagnosticNextSchema,
  DiagnosticResultSchema,
  DiagnosticResultsSchema,
  DiagnosticSessionSchema,
  DiagnosticStateSchema,
  FollowupRequestSchema,
  IdParamsSchema,
  IdempotencyHeadersSchema,
  PairQuerySchema,
  SessionCreateSchema,
} from "../schemas.js";

const user = { access: "user" } as const;
const TAG = ["diagnostics"];
const SVC = "diagnostics";

/** Задание — только поля контракта, явно (ключ ответа `answer` домена не может попасть в Mini App ни при каком сбое). */
export function itemView(i: DiagnosticItem): DiagnosticItem {
  return {
    item_id: i.item_id,
    area: i.area,
    type: i.type,
    instruction: { ru: i.instruction.ru, uz: i.instruction.uz },
    prompt_en: i.prompt_en,
    passage_en: i.passage_en ?? null,
    audio_text_en: i.audio_text_en ?? null,
    options: [...i.options],
    position: i.position,
  };
}

/**
 * Основания результата (ревью спринта 3): только по полосам — {band, answered, correct}, без заданий. Неоценённая область —
 * без оснований ([] — даже если домен прислал). correct > answered — ответ домена противоречив → 503.
 */
export function resultView(log: FastifyBaseLogger, r: DiagnosticResult): DiagnosticResult {
  const areas = r.areas.map((a) => {
    if (a.status === "not_assessed") return { ...a, evidence: [] };
    if (a.evidence.some((e) => e.correct > e.answered)) {
      log.warn({ upstream: SVC, check: "diagnostic_result.evidence", rule: "correct<=answered", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "domain response does not match the contract");
      throw upstreamUnavailable(SVC);
    }
    return { ...a, evidence: a.evidence.map((e) => ({ band: e.band, answered: e.answered, correct: e.correct })) };
  });
  return { ...r, areas };
}

export function diagnosticsRoutes(app: App, ctx: BffContext): void {
  const dx = ctx.domains.diagnostics;
  const log = ctx.log;
  const sessionPath = (id: string) => `/internal/v1/diagnostics/sessions/${id.toLowerCase()}`;

  app.get(
    "/v1/diagnostics/state",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Состояние диагностики ученика: нет / идёт (сессия ≤ 24 ч) / пройдена (последний результат, когда можно снова)",
        description: "?pair_id= (по умолчанию ru-en). 409 PAIR_NOT_AVAILABLE {pair_id}; 410 USER_DELETED.",
        security: BEARER,
        querystring: PairQuerySchema,
        response: { 200: DiagnosticStateSchema, ...errorResponses(401, 409, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const audience = await ctx.audience.of(ctx, auth);
      const res = await dx.get("/internal/v1/diagnostics/state", { subject: asLearner(auth), query: { pair_id: req.query.pair_id ?? DEFAULT_PAIR, audience } });
      const st = expectShape(log, SVC, "diagnostic_state", DiagnosticStateSchema, res);
      return { ...st, last_result: st.last_result ? resultView(log, st.last_result) : null };
    },
  );

  app.post(
    "/v1/diagnostics/sessions",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Начать диагностику (новая сессия прерывает незавершённую)",
        description:
          "Idempotency-Key (UUID) обязателен: повтор с тем же ключом — та же сессия (200). 409 DIAGNOSTIC_TOO_SOON {next_allowed_at}; " +
          "409 PAIR_NOT_AVAILABLE {pair_id}; 410 USER_DELETED.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: Type.Optional(SessionCreateSchema),
        response: { 201: DiagnosticSessionSchema, 200: DiagnosticSessionSchema, ...errorResponses(401, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const key = idempotencyKey(req, true)!;
      const audience = await ctx.audience.of(ctx, auth);
      const res = await dx.post("/internal/v1/diagnostics/sessions", {
        subject: asLearner(auth),
        query: { audience },
        body: { pair_id: req.body?.pair_id ?? DEFAULT_PAIR },
        idempotencyKey: key,
      });
      return reply.code(201).send(expectShape(log, SVC, "diagnostic_session", DiagnosticSessionSchema, res));
    },
  );

  app.get(
    "/v1/diagnostics/sessions/:id/next",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Текущее задание сессии или {done: true}. Ключа ответа нет",
        description: "404 DIAGNOSTIC_SESSION_NOT_FOUND (чужая неотличима); 409 DIAGNOSTIC_SESSION_EXPIRED | DIAGNOSTIC_SESSION_CLOSED.",
        security: BEARER,
        params: IdParamsSchema,
        response: { 200: DiagnosticNextSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const res = await dx.get<unknown>(`${sessionPath(req.params.id)}/next`, { subject: asLearner(auth) });
      if (res && typeof res === "object" && (res as { done?: unknown }).done === true) {
        return expectShape(log, SVC, "diagnostic_done", DiagnosticDoneSchema, { done: true });
      }
      return itemView(expectShape(log, SVC, "diagnostic_item", DiagnosticItemSchema, res));
    },
  );

  app.post(
    "/v1/diagnostics/sessions/:id/answers",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Ответ на текущее задание → следующее (правильность не сообщается)",
        description:
          "answer: индекс варианта | слова по порядку | null; dont_know=true — «Не знаю» (answer=null). Повтор ответа на то же задание — " +
          "200 без изменений. 409 ITEM_NOT_CURRENT — перезапросить next; 422 ANSWER_INVALID {field}.",
        security: BEARER,
        params: IdParamsSchema,
        body: AnswerRequestSchema,
        response: { 200: AnswerResultSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const b = req.body;
      if (b.dont_know && b.answer !== null) {
        // «Не знаю» — без ответа (bff.ts AnswerRequest)
        throw new AppError(422, "ANSWER_INVALID", "«Не знаю» — без варианта ответа", { field: "answer" });
      }
      const res = expectShape(
        log,
        SVC,
        "diagnostic_answer",
        AnswerResultSchema,
        await dx.post(`${sessionPath(req.params.id)}/answers`, {
          subject: asLearner(auth),
          body: { item_id: b.item_id, answer: b.answer, dont_know: b.dont_know, time_ms: b.time_ms },
        }),
      );
      return { accepted: res.accepted, next: res.next ? itemView(res.next) : null, done: res.done };
    },
  );

  app.post(
    "/v1/diagnostics/sessions/:id/listening-unavailable",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "На устройстве нет голоса en-* для синтеза речи: аудирование — not_assessed (no_speech_voice), тест идёт дальше",
        security: BEARER,
        params: IdParamsSchema,
        response: { 204: Type.Null({ description: "Отмечено" }), ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      await dx.post(`${sessionPath(req.params.id)}/listening-unavailable`, { subject: asLearner(auth) });
      return reply.code(204).send(null);
    },
  );

  app.post(
    "/v1/diagnostics/sessions/:id/finish",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Завершить диагностику → результат (предварительный уровень, области, слабые стороны, старт; не сертификат CEFR)",
        description: "422 DIAGNOSTIC_EMPTY — нет ни одного ответа; 409 DIAGNOSTIC_SESSION_EXPIRED | DIAGNOSTIC_SESSION_CLOSED.",
        security: BEARER,
        params: IdParamsSchema,
        response: { 200: DiagnosticResultSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const res = await dx.post(`${sessionPath(req.params.id)}/finish`, { subject: asLearner(auth) });
      return resultView(log, expectShape(log, SVC, "diagnostic_result", DiagnosticResultSchema, res));
    },
  );

  app.post(
    "/v1/diagnostics/results/:id/followup",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Уточнить область с needs_followup (+3 задания, ≤ 24 ч после завершения) → новая сессия",
        description:
          "Прежний результат сохраняется, уточнение даёт ревизию. 409 FOLLOWUP_NOT_AVAILABLE {area, reason: not_needed | window_closed | " +
          "already_done | no_items}; 404 DIAGNOSTIC_RESULT_NOT_FOUND.",
        security: BEARER,
        params: IdParamsSchema,
        body: FollowupRequestSchema,
        response: { 201: DiagnosticSessionSchema, 200: DiagnosticSessionSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const res = await dx.post(`/internal/v1/diagnostics/results/${req.params.id.toLowerCase()}/followup`, {
        subject: asLearner(auth),
        body: { area: req.body.area },
      });
      return reply.code(201).send(expectShape(log, SVC, "diagnostic_session", DiagnosticSessionSchema, res));
    },
  );

  app.get(
    "/v1/diagnostics/results",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "История результатов (последняя ревизия каждого, новые первыми); прошлые результаты не перезаписываются",
        security: BEARER,
        querystring: PairQuerySchema,
        response: { 200: DiagnosticResultsSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const res = await dx.get("/internal/v1/diagnostics/results", {
        subject: asLearner(auth),
        query: { pair_id: req.query.pair_id ?? DEFAULT_PAIR, limit: 50 },
      });
      const list = expectShape(log, SVC, "diagnostic_results", DiagnosticResultsSchema, res);
      return { items: list.items.map((r) => resultView(log, r)) };
    },
  );
}
