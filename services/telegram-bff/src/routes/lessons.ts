/**
 * Спринт 4 — урок 20 минут, практика сценариев и медиа, итоги, оценка и апелляции (bff.ts «Спринт 4»,
 * INTERNAL_API §2.4, §3.3, §7). Сессии ведёт lessons (машина состояний на сервере), оценки — assessment.
 *
 * Субъект внутреннего JWT: lessons — `sub` = аккаунт, claims `lrn` (активный ученик) и `age_band` (возраст аккаунта; в
 * детском профиле не передаётся) — как для catalog (issueWithClaims); детский профиль lessons распознаёт сам (`lrn ≠ sub`
 * или детский `age_band`) — защита в глубину. assessment — `sub` = активный ученик (`lrn`, как diagnostics;
 * services/assessment/README.md), те же claims.
 *
 * Дети 6–13 (сегмент kids — content.ts): свободный текст (`text` в ответе на шаг) → 403 KIDS_NOT_ALLOWED в BFF до вызова
 * lessons; в шагах ролевой ситуации `free_text_allowed` для ребёнка всегда false, режим — выбор реплик.
 *
 * Ключи ответов: ответы доменов сверяются со схемами контракта (шаг — по дискриминатору `type`), ответ Mini App
 * собирается явно, поле за полем: у задания нет ключа; верный ответ в итогах — только для заданий, где ученик ошибся;
 * на проверке без подсказок (graded_later) правильность не сообщается — даже если домен её прислал (BFF помнит такие
 * шаги, выданные ученику, в Redis 3 суток) и подсказка недоступна (409 HINTS_NOT_ALLOWED до вызова домена).
 *
 * Логи: без текстов ученика (реплики, ответы, причины апелляций) — тела запросов не пишутся, ключи вычищаются (logging.ts).
 * Коды доменов передаются как есть: 404 LESSON_NOT_AVAILABLE | SESSION_NOT_FOUND | NO_EXERCISES | EVALUATION_NOT_FOUND;
 * 409 SESSION_ACTIVE {session_id, kind, title} | SESSION_STATE {status} | STEP_NOT_CURRENT {current_step_id} |
 * HINTS_NOT_ALLOWED | FREE_TEXT_NOT_ALLOWED | SIMPLER_NOT_AVAILABLE | RETRY_NOT_AVAILABLE | NOTHING_TO_REVIEW |
 * AI_BUSY (steps, simpler: тот же ответ ещё обрабатывается — Mini App повторяет его) |
 * PAIR_NOT_AVAILABLE | APPEAL_EXISTS | APPEAL_WINDOW_CLOSED | APPEAL_NOT_ALLOWED; 422 ANSWER_INVALID {field}; 410 USER_DELETED;
 * 503 CATALOG_UNAVAILABLE (свой код); ответ не по контракту → 503 UPSTREAM_UNAVAILABLE.
 *
 * Спринт 5: сессии kind reading (старт — routes/reading.ts) идут через эти же маршруты: шаг `reading` (ReadingView) —
 * строго по схеме и явной сборкой, `in_dictionary` глоссария — из словаря ученика (memory cards/lookup, сбой — null);
 * вопросы к тексту — шаги `item` с graded_later.
 */
import { Type } from "@fastify/type-provider-typebox";
import type * as C from "@tilhero/contracts/bff";
import type { ConfirmedError } from "@tilhero/contracts/ai";
import type { Localized } from "@tilhero/contracts/content";
import { AppError } from "@tilhero/ts-common";
import type { FastifyBaseLogger } from "fastify";
import { asAccount, asLearner } from "../account.js";
import { expectShape, matches } from "../check.js";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, idempotencyKey, localeOf, type App, type LocaleSource } from "../http.js";
import {
  ActiveSessionSchema,
  AppealListSchema,
  AppealRequestSchema,
  AppealSchema,
  ContentIdParamsSchema,
  EvaluationViewSchema,
  HintSchema,
  HistoryQuerySchema,
  IdParamsSchema,
  IdempotencyHeadersSchema,
  LessonCardDetailSchema,
  LessonHistoryItemSchema,
  LessonHistoryPageSchema,
  LessonParamsSchema,
  LessonSessionDomainSchema,
  LessonSessionSchema,
  LocaleQuerySchema,
  LessonStepSchema,
  LessonSummarySchema,
  STEP_SCHEMAS,
  SimplerExplanationSchema,
  StepAnswerSchema,
  StepParamsSchema,
  StepResultDomainSchema,
  StepResultSchema,
} from "../schemas.js";
import type { AccessClaims } from "../tokens.js";
import { upstreamUnavailable, type RawRequest } from "../upstream.js";
import { claimsOf, pageView } from "./content.js";
import { withInDictionary } from "../memoryApi.js";

const user = { access: "user" } as const;
const LESSONS = "lessons";
const ASSESSMENT = "assessment";
const enc = encodeURIComponent;
/** Сколько BFF помнит шаги проверки без подсказок, выданные ученику (пауза живёт 72 ч). */
const GRADED_TTL_SECONDS = 3 * 24 * 3600;

export const kidsFreeText = () =>
  new AppError(403, "KIDS_NOT_ALLOWED", "В детском профиле ответ выбирается из готовых вариантов");
const hintsNotAllowed = () => new AppError(409, "HINTS_NOT_ALLOWED", "На проверке без подсказок подсказки недоступны");
const answerInvalid = (field: string) => new AppError(422, "ANSWER_INVALID", "Один ответ на шаг: вариант, реплика или текст", { field });

const loc = (x: Localized): Localized => ({ ru: x.ru, uz: x.uz });

export { localeOf } from "../http.js";

// ---------------------------------------------------------------- проверка и сборка ответов

/** Шаг урока из ответа lessons: схема — по дискриминатору `type`; неизвестный тип или поле не по контракту → 503. */
export function checkStep(log: FastifyBaseLogger, raw: unknown, what = "lesson_step"): C.LessonStep {
  const type = raw && typeof raw === "object" ? (raw as { type?: unknown }).type : undefined;
  if (typeof type !== "string" || !Object.hasOwn(STEP_SCHEMAS, type)) {
    log.warn({ upstream: LESSONS, check: what, path: "/type", rule: "discriminator", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "domain response does not match the contract");
    throw upstreamUnavailable(LESSONS);
  }
  return expectShape(log, LESSONS, `${what}.${type}`, STEP_SCHEMAS[type as keyof typeof STEP_SCHEMAS], raw) as C.LessonStep;
}

/**
 * Шаг для Mini App — только поля контракта, явно: ключ ответа задания (`answer`, `correct_index` и т. п. домена)
 * не может попасть к ученику ни при каком сбое. Ребёнку — без свободного текста; на проверке без подсказок — без подсказки.
 */
export function stepView(s: C.LessonStep, kids: boolean): C.LessonStep {
  const base = { step_id: s.step_id, stage: s.stage, position: s.position, stage_total: s.stage_total };
  switch (s.type) {
    case "notice":
      return { ...base, type: "notice", text: loc(s.text) };
    case "explanation":
      return {
        ...base,
        type: "explanation",
        instructions: loc(s.instructions),
        examples: s.examples.map((e) => ({ en: e.en, gloss: loc(e.gloss) })),
        key_words: s.key_words.map((k) => ({ en: k.en, gloss: loc(k.gloss), example_en: k.example_en })),
        can_simplify: s.can_simplify,
      };
    case "item":
      return {
        ...base,
        type: "item",
        item: { item_id: s.item.item_id, item_type: s.item.item_type, instruction: loc(s.item.instruction), prompt_en: s.item.prompt_en, options: [...s.item.options] },
        hint_available: s.graded_later ? false : s.hint_available,
        hints_used: s.hints_used,
        graded_later: s.graded_later,
      };
    case "roleplay":
      return {
        ...base,
        type: "roleplay",
        node_id: s.node_id,
        character: { id: s.character.id, name: s.character.name, role: loc(s.character.role), voice: s.character.voice },
        line_en: s.line_en,
        gloss: loc(s.gloss),
        choices: s.choices.map((c) => ({ choice_id: c.choice_id, text_en: c.text_en })),
        free_text_allowed: kids ? false : s.free_text_allowed,
        hint_available: s.hint_available,
        hints_used: s.hints_used,
        history: s.history.map((h) => ({ turn_id: h.turn_id, speaker: h.speaker, text_en: h.text_en, character_id: h.character_id })),
        unclear_attempts: s.unclear_attempts,
      };
    case "roleplay_end":
      return { ...base, type: "roleplay_end", outcome: s.outcome, summary: loc(s.summary), can_retry: s.can_retry };
    case "listen":
      return {
        ...base,
        type: "listen",
        asset_id: s.asset_id,
        title: loc(s.title),
        has_audio: s.has_audio,
        transcript: s.transcript ? s.transcript.map((t) => ({ speaker: t.speaker, text_en: t.text_en, gloss: t.gloss ? loc(t.gloss) : null })) : null,
        voices: { ...s.voices },
        can_listen: s.can_listen,
      };
    case "open_answer":
      return { ...base, type: "open_answer", prompt: loc(s.prompt), max_length: s.max_length };
    case "reading":
      return { ...base, type: "reading", reading: readingView(s.reading) };
    case "done":
      return { ...base, type: "done" };
  }
}

/** Текст для чтения (спринт 5) — только поля контракта: вопросов и ответов в нём нет по построению. */
export function readingView(r: C.ReadingView): C.ReadingView {
  return {
    reading_id: r.reading_id,
    version: r.version,
    title: loc(r.title),
    level: r.level,
    voice: r.voice,
    paragraphs: r.paragraphs.map((p) => ({ p_id: p.p_id, sentences: p.sentences.map((x) => ({ s_id: x.s_id, text_en: x.text_en, gloss: loc(x.gloss) })) })),
    glossary: r.glossary.map((g) => ({ en: g.en, gloss: loc(g.gloss), note: g.note ? loc(g.note) : null, in_dictionary: g.in_dictionary ?? null })),
    questions_count: r.questions_count,
    question_types: [...r.question_types],
    est_minutes: r.est_minutes,
  };
}

/** Вызов lessons от имени ученика: sub = аккаунт, claims lrn и age_band; kids — детская аудитория (сегмент BFF).
 *  Query для lessons (services/lessons/README.md): `audience` — подсказка BFF (детский профиль lessons не понижает),
 *  `locale` — язык ученика (варианты проверки понимания, объяснение ИИ). */
export async function lessonsCall(ctx: BffContext, auth: AccessClaims, req?: LocaleSource): Promise<{ kids: boolean; ro: RawRequest }> {
  const seg = await ctx.audience.segment(ctx, auth);
  return {
    kids: seg.audience === "kids",
    ro: {
      subject: asAccount(auth),
      claims: claimsOf(auth, seg.accountAgeBand),
      ...(req ? { query: { audience: seg.audience, locale: localeOf(req) } } : {}),
    },
  };
}

/** Сессия домена lessons: поля пэйвола спринта 8 (ai_locked, ai_minutes_left) приходят от lessons после потока C —
 *  до этого их нет, ответ Mini App — null. */
export type DomainLessonSession = Omit<C.LessonSession, "ai_locked" | "ai_minutes_left"> &
  Partial<Pick<C.LessonSession, "ai_locked" | "ai_minutes_left">>;

export function sessionView(s: DomainLessonSession, kids: boolean): C.LessonSession {
  return {
    session_id: s.session_id,
    kind: s.kind,
    title: loc(s.title),
    lesson_id: s.lesson_id,
    scenario_id: s.scenario_id,
    asset_id: s.asset_id,
    status: s.status,
    stage: s.stage,
    stages: s.stages.map((x) => ({ type: x.type, status: x.status })),
    // дети — всегда выбор реплик (решение владельца)
    ai_mode: kids ? "choices" : s.ai_mode,
    ai_degraded: s.ai_degraded,
    started_at: s.started_at,
    paused_at: s.paused_at,
    finished_at: s.finished_at,
    expires_at: s.expires_at,
    minutes: s.minutes,
    ai_locked: s.ai_locked ? { reason: s.ai_locked.reason } : null,
    ai_minutes_left: s.ai_minutes_left ?? null,
  };
}

export function appealView(a: C.Appeal): C.Appeal {
  return {
    appeal_id: a.appeal_id,
    evaluation_id: a.evaluation_id,
    status: a.status,
    reason: a.reason,
    decision_note: a.decision_note,
    new_evaluation_id: a.new_evaluation_id,
    created_at: a.created_at,
    decided_at: a.decided_at,
  };
}

const SEVERITY_RANK: Record<ConfirmedError["severity"], number> = { high: 0, medium: 1, low: 2 };

/**
 * Оценка для ученика: верный ответ — только для заданий, где ученик ошибся (у верных он не нужен и не показывается);
 * ключевые ошибки — 1–3 с наибольшей severity (порядок домена при равной).
 */
export function evaluationView(e: C.EvaluationView): C.EvaluationView {
  const errors = e.key_errors
    .map((x, i) => ({ x, i }))
    .sort((a, b) => SEVERITY_RANK[a.x.severity] - SEVERITY_RANK[b.x.severity] || a.i - b.i)
    .slice(0, 3)
    .map(({ x }) => ({ turn_id: x.turn_id, evidence: x.evidence, correction: x.correction, error_code: x.error_code, severity: x.severity }));
  return {
    evaluation_id: e.evaluation_id,
    status: e.status,
    passed: e.passed,
    task_completed: e.task_completed,
    scores: e.scores.map((s) => ({ code: s.code, title: loc(s.title), score: s.score })),
    key_errors: errors,
    items: e.items.map((i) => ({
      item_id: i.item_id,
      prompt_en: i.prompt_en,
      your_answer: i.your_answer,
      correct: i.correct,
      hinted: i.hinted,
      correct_answer: i.correct ? null : i.correct_answer,
    })),
    practice_only: e.practice_only,
    rubric_version: e.rubric_version,
    evaluator: e.evaluator ? { model_id: e.evaluator.model_id, prompt_version: e.evaluator.prompt_version } : null,
    superseded_by: e.superseded_by,
    appeal: e.appeal ? appealView(e.appeal) : null,
    created_at: e.created_at,
  };
}

export function summaryView(s: C.LessonSummary): C.LessonSummary {
  return {
    session_id: s.session_id,
    kind: s.kind,
    title: loc(s.title),
    status: s.status,
    outcome: s.outcome,
    minutes: s.minutes,
    evaluation: s.evaluation ? evaluationView(s.evaluation) : null,
    skills: s.skills.map((x) => ({ skill_id: x.skill_id, title: loc(x.title), from: x.from, to: x.to })),
    key_words: s.key_words.map((k) => ({ en: k.en, gloss: loc(k.gloss) })),
    next_lesson: s.next_lesson,
    can_review: s.can_review,
  };
}

// ---------------------------------------------------------------- маршруты

export function lessonsRoutes(app: App, ctx: BffContext): void {
  const { lessons, assessment } = ctx.domains;
  const log = ctx.log;
  const sess = (id: string) => `/internal/v1/sessions/${id.toLowerCase()}`;

  const asLearnerOf = (auth: AccessClaims, req?: LocaleSource) => lessonsCall(ctx, auth, req);
  /** Шаг reading (спринт 5): in_dictionary глоссария — из словаря ученика (memory cards/lookup; сбой — null). */
  const enrich = async (auth: AccessClaims, step: C.LessonStep): Promise<C.LessonStep> =>
    step.type === "reading" ? { ...step, reading: await withInDictionary(ctx, auth, step.reading) } : step;
  /** assessment: sub = активный ученик (lrn), claims те же. */
  const asLearnerOfAssessment = async (auth: AccessClaims): Promise<RawRequest> => {
    const seg = await ctx.audience.segment(ctx, auth);
    return { subject: asLearner(auth), claims: claimsOf(auth, seg.accountAgeBand) };
  };

  /** Шаги проверки без подсказок, выданные ученику: правильность и подсказки по ним не отдаются никогда. */
  const gradedKey = (sessionId: string, stepId: string) => `${ctx.config.redisKeyPrefix}lsn:graded:${sessionId.toLowerCase()}:${stepId}`;
  const remember = async (sessionId: string, step: C.LessonStep): Promise<void> => {
    if (step.type === "item" && step.graded_later) await ctx.store(() => ctx.redis.set(gradedKey(sessionId, step.step_id), "1", "EX", GRADED_TTL_SECONDS));
  };
  const isGraded = async (sessionId: string, stepId: string): Promise<boolean> =>
    (await ctx.store(() => ctx.redis.exists(gradedKey(sessionId, stepId)))) === 1;

  const sessionOf = (raw: unknown, kids: boolean, what = "lesson_session") => sessionView(expectShape(log, LESSONS, what, LessonSessionDomainSchema, raw), kids);

  // ---------------------------------------------------------------- карточка урока (APP-LESS-01, AT-39)
  app.get(
    "/v1/lessons/:lesson_id",
    {
      config: user,
      schema: {
        tags: ["lessons"],
        summary: "Карточка урока: тема, цель, уровень, длительность, навык, 5 этапов с минутами, формат ролевой ситуации",
        description:
          "Опубликованная версия урока курса пары. Награды не показываются (спринт 6). Детям roleplay_mode — всегда «выбор реплик». " +
          "404 LESSON_NOT_AVAILABLE — не опубликован или не для аудитории ученика.",
        security: BEARER,
        params: LessonParamsSchema,
        response: { 200: LessonCardDetailSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const { kids, ro } = await asLearnerOf(authOf(req), req);
      const res = await lessons.json("GET", `/internal/v1/lessons/${enc(req.params.lesson_id)}/card`, ro);
      const c = expectShape(log, LESSONS, "lesson_card", LessonCardDetailSchema, res);
      return { ...c, roleplay_mode: kids && c.roleplay_mode ? "choices" : c.roleplay_mode };
    },
  );

  // ---------------------------------------------------------------- старт сессий (AT-39, AT-48)
  const startDescription =
    "Idempotency-Key (UUID) обязателен: повтор с тем же ключом — та же сессия. 409 SESSION_ACTIVE {session_id, kind, title} — есть " +
    "незавершённая сессия (продолжить или отменить); 409 PAIR_NOT_AVAILABLE.";
  const start = (url: string, summary: string, notFound: string, path: (id: string) => string, params: typeof LessonParamsSchema | typeof ContentIdParamsSchema) =>
    app.post(
      url,
      {
        config: user,
        schema: {
          tags: ["lessons"],
          summary,
          description: `${startDescription} ${notFound}`,
          security: BEARER,
          params,
          headers: IdempotencyHeadersSchema,
          response: { 201: LessonSessionSchema, ...errorResponses(401, 404, 409, 410, 423) },
        },
      },
      async (req, reply) => {
        const auth = authOf(req);
        const key = idempotencyKey(req, true)!;
        const { kids, ro } = await asLearnerOf(auth, req);
        const p = req.params as { lesson_id?: string; id?: string };
        const res = await lessons.json("POST", path(enc(p.lesson_id ?? p.id ?? "")), { ...ro, idempotencyKey: key });
        return reply.code(201).send(sessionOf(res, kids));
      },
    );
  start("/v1/lessons/:lesson_id/sessions", "Начать урок из плана (сессия kind lesson)", "404 LESSON_NOT_AVAILABLE.", (id) => `/internal/v1/lessons/${id}/sessions`, LessonParamsSchema);
  start(
    "/v1/scenarios/:id/sessions",
    "«Разыграть» сценарий из «Практики» (сессия kind scenario: ролевая ситуация → оценка по рубрике сценария)",
    "404 SCENARIO_NOT_FOUND — нет, не опубликован или не для аудитории ученика (детям — только детские, выбором реплик).",
    (id) => `/internal/v1/scenarios/${id}/sessions`,
    ContentIdParamsSchema,
  );
  start(
    "/v1/media/:id/sessions",
    "Упражнения к медиа (сессия kind media: прослушивание → упражнения → оценка закрытых заданий)",
    "404 MEDIA_NOT_AVAILABLE | NO_EXERCISES — нет опубликованных упражнений.",
    (id) => `/internal/v1/media/${id}/sessions`,
    ContentIdParamsSchema,
  );

  // ---------------------------------------------------------------- сессия
  app.get(
    "/v1/sessions/active",
    {
      config: user,
      schema: {
        tags: ["lessons"],
        summary: "Незавершённая сессия ученика (ready | in_progress | paused) или null — «Продолжить урок»",
        security: BEARER,
        response: { 200: ActiveSessionSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const { kids, ro } = await asLearnerOf(authOf(req));
      const res = expectShape(log, LESSONS, "active_session", Type.Object({ session: Type.Union([Type.Object({}), Type.Null()]) }), await lessons.json("GET", "/internal/v1/sessions/active", ro));
      return { session: res.session ? sessionOf(res.session, kids, "active_session.session") : null };
    },
  );

  app.get(
    "/v1/sessions",
    {
      config: user,
      schema: {
        tags: ["lessons"],
        summary: "История сессий ученика (уроки, сценарии, медиа, повторения, чтение), новые первыми",
        description: "?kind=lesson|scenario|media|review|reading, ?cursor=, ?limit= (1–50). Элемент не по контракту отбрасывается.",
        security: BEARER,
        querystring: HistoryQuerySchema,
        response: { 200: LessonHistoryPageSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await asLearnerOf(authOf(req));
      const q = req.query;
      const res = await lessons.json("GET", "/internal/v1/sessions", { ...ro, query: { kind: q.kind, cursor: q.cursor, limit: q.limit ?? 20 } });
      return pageView(ctx, LESSONS, "sessions", LessonHistoryItemSchema, res);
    },
  );

  app.get(
    "/v1/sessions/:id",
    {
      config: user,
      schema: {
        tags: ["lessons"],
        summary: "Сессия: статус, этапы, режим ролевой ситуации, упрощённый режим (ИИ недоступен), срок паузы",
        description: "404 SESSION_NOT_FOUND — нет или чужая (неотличимо).",
        security: BEARER,
        params: IdParamsSchema,
        response: { 200: LessonSessionSchema, ...errorResponses(401, 404, 410, 423) },
      },
    },
    async (req) => {
      const { kids, ro } = await asLearnerOf(authOf(req));
      return sessionOf(await lessons.json("GET", sess(req.params.id), ro), kids);
    },
  );

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(
      `/v1/sessions/:id/${action}`,
      {
        config: user,
        schema: {
          tags: ["lessons"],
          summary:
            action === "pause"
              ? "Пауза урока (время паузы не идёт в длительность; > 72 ч — отмена)"
              : action === "resume"
                ? "Продолжить урок после паузы (запрос текущего шага продолжает и сам)"
                : "Отменить урок (cancelled; итогов и оценки нет)",
          description: "409 SESSION_STATE {status} — переход недопустим в этом статусе; 404 SESSION_NOT_FOUND.",
          security: BEARER,
          params: IdParamsSchema,
          response: { 200: LessonSessionSchema, ...errorResponses(401, 404, 409, 410, 423) },
        },
      },
      async (req) => {
        const { kids, ro } = await asLearnerOf(authOf(req));
        return sessionOf(await lessons.json("POST", `${sess(req.params.id)}/${action}`, ro), kids);
      },
    );
  }

  // ---------------------------------------------------------------- шаги (AT-40, AT-42, AT-43)
  app.get(
    "/v1/sessions/:id/current",
    {
      config: user,
      schema: {
        tags: ["lessons"],
        summary: "Текущий шаг урока (первый запрос начинает урок, после паузы — продолжает с того же шага)",
        description:
          "Шаг — по типу: notice, explanation, item, roleplay, roleplay_end, listen, open_answer, reading (спринт 5: текст для чтения; " +
          "in_dictionary глоссария — из словаря ученика), done. Ключей ответов нет. 409 SESSION_STATE.",
        security: BEARER,
        params: IdParamsSchema,
        response: { 200: LessonStepSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { kids, ro } = await asLearnerOf(auth, req);
      const step = stepView(checkStep(log, await lessons.json("GET", `${sess(req.params.id)}/current`, ro)), kids);
      await remember(req.params.id, step);
      return enrich(auth, step);
    },
  );

  app.post(
    "/v1/sessions/:id/steps/:step_id",
    {
      config: user,
      schema: {
        tags: ["lessons"],
        summary: "Ответ на шаг → результат и следующий шаг (повтор того же ответа — тот же результат)",
        description:
          "roleplay: choice_id или text (≤ 500, только при free_text_allowed; детский профиль — 403 KIDS_NOT_ALLOWED до вызова lessons); " +
          "item: answer (индекс | слова/реплики по порядку | строка пропуска) или dont_know; остальные шаги — {} («Дальше»). " +
          "Один ответ на запрос (иначе 422 ANSWER_INVALID). На проверке без подсказок feedback = null. 409 STEP_NOT_CURRENT {current_step_id}.",
        security: BEARER,
        params: StepParamsSchema,
        body: Type.Optional(StepAnswerSchema),
        response: { 200: StepResultSchema, ...errorResponses(400, 401, 403, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const b = req.body ?? {};
      const { kids, ro } = await asLearnerOf(auth, req);
      if (b.text !== undefined && kids) throw kidsFreeText();
      const given = [b.answer !== undefined && b.answer !== null, b.choice_id !== undefined, b.text !== undefined].filter(Boolean).length;
      if (given > 1) throw answerInvalid("answer");
      if (b.dont_know && given > 0) throw answerInvalid("dont_know");
      const { id, step_id: stepId } = req.params;
      const body: C.StepAnswer = {
        ...(b.answer !== undefined ? { answer: b.answer } : {}),
        ...(b.dont_know !== undefined ? { dont_know: b.dont_know } : {}),
        ...(b.choice_id !== undefined ? { choice_id: b.choice_id } : {}),
        ...(b.text !== undefined ? { text: b.text.trim() } : {}),
      };
      const res = expectShape(log, LESSONS, "step_result", StepResultDomainSchema, await lessons.json("POST", `${sess(id)}/steps/${stepId}`, { ...ro, body }));
      const next = await enrich(auth, stepView(checkStep(log, res.next, "step_result.next"), kids));
      const graded = await isGraded(id, stepId);
      if (graded && res.feedback) {
        log.warn({ upstream: LESSONS, check: "step_result.feedback", rule: "graded_later", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "feedback on a graded step dropped");
      }
      await remember(id, next);
      return {
        accepted: res.accepted,
        feedback: graded || !res.feedback ? null : { correct: res.feedback.correct, correct_answer: res.feedback.correct_answer },
        reply: res.reply ? { character_id: res.reply.character_id, text_en: res.reply.text_en, gloss: res.reply.gloss ? loc(res.reply.gloss) : null, clarification: res.reply.clarification } : null,
        next,
      };
    },
  );

  app.post(
    "/v1/sessions/:id/steps/:step_id/hint",
    {
      config: user,
      schema: {
        tags: ["lessons"],
        summary: "Подсказка к шагу (отмечается и учитывается в оценке самостоятельности)",
        description: "409 HINTS_NOT_ALLOWED — проверка без подсказок; 409 STEP_NOT_CURRENT.",
        security: BEARER,
        params: StepParamsSchema,
        response: { 200: HintSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await asLearnerOf(authOf(req));
      const { id, step_id: stepId } = req.params;
      if (await isGraded(id, stepId)) throw hintsNotAllowed();
      const res = expectShape(log, LESSONS, "hint", HintSchema, await lessons.json("POST", `${sess(id)}/steps/${stepId}/hint`, ro));
      return { hint: loc(res.hint) };
    },
  );

  app.post(
    "/v1/sessions/:id/simpler",
    {
      config: user,
      schema: {
        tags: ["lessons"],
        summary: "«Объясни проще»: объяснение ИИ на языке ученика или следующий пример урока (позиция урока не меняется)",
        description: "?locale=ru|uz — язык объяснения (по умолчанию — Accept-Language). 409 SIMPLER_NOT_AVAILABLE — не этап объяснения.",
        security: BEARER,
        params: IdParamsSchema,
        querystring: LocaleQuerySchema,
        response: { 200: SimplerExplanationSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await asLearnerOf(authOf(req), req);
      const r = expectShape(log, LESSONS, "simpler", SimplerExplanationSchema, await lessons.json("POST", `${sess(req.params.id)}/simpler`, ro));
      return { explanation: r.explanation ? loc(r.explanation) : null, example_en: r.example_en, example_gloss: loc(r.example_gloss), source: r.source };
    },
  );

  app.post(
    "/v1/sessions/:id/roleplay/retry",
    {
      config: user,
      schema: {
        tags: ["lessons"],
        summary: "«Попробовать ещё раз» после исхода «не вышло» — один раз, с ближайшей точки восстановления",
        description: "409 RETRY_NOT_AVAILABLE — повтор недоступен (не «не вышло» или уже был).",
        security: BEARER,
        params: IdParamsSchema,
        response: { 200: LessonStepSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { kids, ro } = await asLearnerOf(auth, req);
      const step = stepView(checkStep(log, await lessons.json("POST", `${sess(req.params.id)}/roleplay/retry`, ro), "roleplay_retry"), kids);
      await remember(req.params.id, step);
      return enrich(auth, step);
    },
  );

  // ---------------------------------------------------------------- итоги (AT-45)
  app.post(
    "/v1/sessions/:id/finish",
    {
      config: user,
      schema: {
        tags: ["lessons"],
        summary: "Завершить урок → итоги с независимой оценкой (повтор — тот же итог, без новых событий)",
        description:
          "Только с шага done (иначе 409 STEP_NOT_CURRENT). Оценка синхронная (lessons ждёт assessment до 32 с, таймаут BFF LESSONS_FINISH_TIMEOUT_MS); " +
          "evaluation = null — «оценка появится позже» (перезапрос GET …/summary). 409 SESSION_STATE.",
        security: BEARER,
        params: IdParamsSchema,
        response: { 200: LessonSummarySchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await asLearnerOf(authOf(req));
      const res = await lessons.json("POST", `${sess(req.params.id)}/finish`, { ...ro, timeoutMs: ctx.config.lessonsFinishTimeoutMs });
      return summaryView(expectShape(log, LESSONS, "lesson_summary", LessonSummarySchema, res));
    },
  );

  app.get(
    "/v1/sessions/:id/summary",
    {
      config: user,
      schema: {
        tags: ["lessons"],
        summary: "Итоги завершённой сессии (из истории): результат, баллы, ошибки, навыки, слова, следующий урок",
        description: "409 SESSION_STATE — сессия не завершена.",
        security: BEARER,
        params: IdParamsSchema,
        response: { 200: LessonSummarySchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await asLearnerOf(authOf(req));
      return summaryView(expectShape(log, LESSONS, "lesson_summary", LessonSummarySchema, await lessons.json("GET", `${sess(req.params.id)}/summary`, ro)));
    },
  );

  app.post(
    "/v1/sessions/:id/review",
    {
      config: user,
      schema: {
        tags: ["lessons"],
        summary: "«Повторить упражнения» из итогов — новая сессия kind review без влияния на освоение",
        description: "Idempotency-Key (UUID) обязателен. 409 SESSION_ACTIVE; 409 NOTHING_TO_REVIEW — повторять нечего (can_review = false).",
        security: BEARER,
        params: IdParamsSchema,
        headers: IdempotencyHeadersSchema,
        response: { 201: LessonSessionSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const key = idempotencyKey(req, true)!;
      const { kids, ro } = await asLearnerOf(authOf(req));
      return reply.code(201).send(sessionOf(await lessons.json("POST", `${sess(req.params.id)}/review`, { ...ro, idempotencyKey: key }), kids));
    },
  );

  // ---------------------------------------------------------------- оценка и апелляции (AT-44, AT-47)
  app.get(
    "/v1/evaluations/:id",
    {
      config: user,
      schema: {
        tags: ["assessment"],
        summary: "Оценка ученика (актуальная — после переоценки ссылка superseded_by), апелляция и её решение",
        description: "Верный ответ — только для заданий, где ученик ошибся. 404 EVALUATION_NOT_FOUND — нет или чужая.",
        security: BEARER,
        params: IdParamsSchema,
        response: { 200: EvaluationViewSchema, ...errorResponses(401, 404, 410, 423) },
      },
    },
    async (req) => {
      const ro = await asLearnerOfAssessment(authOf(req));
      const res = await assessment.json("GET", `/internal/v1/evaluations/${req.params.id.toLowerCase()}`, ro);
      return evaluationView(expectShape(log, ASSESSMENT, "evaluation", EvaluationViewSchema, res));
    },
  );

  app.post(
    "/v1/evaluations/:id/appeal",
    {
      config: user,
      schema: {
        tags: ["assessment"],
        summary: "Оспорить оценку: причина (≤ 500) → методист решает (оценка верна / исправлена), уведомление придёт в Telegram",
        description:
          "Idempotency-Key (UUID) обязателен. 409 APPEAL_EXISTS — апелляция уже подана; 409 APPEAL_WINDOW_CLOSED — прошло больше 14 дней; " +
          "409 APPEAL_NOT_ALLOWED — тренировка (practice_only); " +
          "404 EVALUATION_NOT_FOUND. Причина в логи не пишется.",
        security: BEARER,
        params: IdParamsSchema,
        headers: IdempotencyHeadersSchema,
        body: AppealRequestSchema,
        response: { 201: AppealSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const key = idempotencyKey(req, true)!;
      const ro = await asLearnerOfAssessment(authOf(req));
      const res = await assessment.json("POST", `/internal/v1/evaluations/${req.params.id.toLowerCase()}/appeal`, {
        ...ro,
        idempotencyKey: key,
        body: { reason: req.body.reason.trim() },
      });
      return reply.code(201).send(appealView(expectShape(log, ASSESSMENT, "appeal", AppealSchema, res)));
    },
  );

  app.get(
    "/v1/appeals",
    {
      config: user,
      schema: {
        tags: ["assessment"],
        summary: "Мои апелляции: статус и решение методиста (последние 50, новые первыми)",
        security: BEARER,
        response: { 200: AppealListSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const ro = await asLearnerOfAssessment(authOf(req));
      const res = await assessment.json<{ items?: unknown }>("GET", "/internal/v1/appeals", { ...ro, query: { limit: 50 } });
      if (!res || typeof res !== "object" || !Array.isArray(res.items)) return expectShape(log, ASSESSMENT, "appeals", AppealListSchema, res);
      const items = res.items.filter((a): a is C.Appeal => matches(AppealSchema, a));
      if (items.length < res.items.length) {
        log.warn({ upstream: ASSESSMENT, check: "appeals", dropped: res.items.length - items.length, upstream_code: "UPSTREAM_BAD_RESPONSE" }, "list items dropped");
      }
      return { items: items.map(appealView) };
    },
  );
}
