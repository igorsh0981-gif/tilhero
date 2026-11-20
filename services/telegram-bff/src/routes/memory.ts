/**
 * Спринт 5 — память и повторения (bff.ts «Спринт 5», INTERNAL_API §1.10, §8): обзор, личный словарь, журнал ошибок,
 * «Повторение дня», перевод слова по тапу. Произношение — routes/pronunciation.ts, чтение — routes/reading.ts.
 *
 * memory вызывается от имени активного ученика (memoryApi.ts): sub = аккаунт, claims `lrn` и `age_band` ученика, query
 * `audience` и `locale`. Срок следующего повторения считает только FSRS в memory: BFF сроки не задаёт и не меняет.
 *
 * Дети 6–13: ввод текста в повторении допустим — сравнение локальное в memory, ИИ не участвует; перевод по тапу разрешён —
 * слово из опубликованного контента, memory проверяет это через catalog (свободный текст в ИИ не уходит).
 *
 * Ключи ответов: задание (ReviewTask) сверяется со схемой СТРОГО — лишнее поле на любом уровне (`answers_en`, `key`,
 * `correct` и т. п.) или поле подсказки, раскрывающее ответ для этого типа (например, `text_en` у `typed`), → 503
 * UPSTREAM_UNAVAILABLE {service: memory}, ответ ученику не собирается. Ответ Mini App собирается явно, поле за полем.
 * Проверка удержания (`check_item`): BFF помнит такие задания, выданные ученику (Redis, сутки) — подсказка → 409
 * HINTS_NOT_ALLOWED до вызова memory, верный ответ и результат до конца блока проверки не отдаются, даже если memory
 * их прислал (защита в глубину, как graded_later в уроке).
 *
 * Лимиты: `tg.memory.answer` (300 за 10 минут на ученика) — ответы на задания; `tg.memory.translate` (60 за 10 минут) —
 * перевод. Таймауты: memory 10 с, перевод 12 с (MEMORY_TIMEOUT_MS, MEMORY_TRANSLATE_TIMEOUT_MS).
 *
 * Логи: без текстов ученика (ввод в повторении, поиск по словарю, слово перевода, цитаты ошибок) — тела запросов не
 * пишутся, ключи вычищаются (logging.ts).
 * Коды memory передаются как есть: 404 CARD_NOT_FOUND | REVIEW_SESSION_NOT_FOUND | TASK_NOT_FOUND | CONTENT_NOT_FOUND;
 * 409 NOTHING_TO_REVIEW {next_due_at} | TASK_NOT_CURRENT {current_task_id} | REVIEW_SESSION_STATE {status} |
 * HINTS_NOT_ALLOWED | IDEMPOTENCY_KEY_REUSED; 422 CARDS_LIMIT {limit} | WORD_NOT_IN_CONTENT | GLOSS_UNAVAILABLE |
 * ANSWER_INVALID {field}; 410 USER_DELETED; ответ не по контракту → 503 UPSTREAM_UNAVAILABLE.
 */
import { Type } from "@fastify/type-provider-typebox";
import type * as C from "@tilhero/contracts/bff";
import type { Localized } from "@tilhero/contracts/content";
import { AppError } from "@tilhero/ts-common";
import { expectShape } from "../check.js";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, idempotencyKey, type App } from "../http.js";
import { MEMORY, memoryCall } from "../memoryApi.js";
import {
  ActiveReviewSessionSchema,
  AddCardRequestSchema,
  CardsQuerySchema,
  CursorQuerySchema,
  DictionaryCardDetailSchema,
  DictionaryCardSchema,
  DictionaryPageSchema,
  ErrorJournalItemSchema,
  ErrorJournalPageSchema,
  IdParamsSchema,
  IdempotencyHeadersSchema,
  MemoryOverviewSchema,
  ReviewAnswerSchema,
  ReviewHintRequestSchema,
  ReviewHintSchema,
  ReviewSessionSchema,
  ReviewSummarySchema,
  ReviewTaskParamsSchema,
  ReviewTaskResultSchema,
  ReviewTaskSchema,
  TranslateRequestSchema,
  WordGlossSchema,
} from "../schemas.js";
import { upstreamUnavailable } from "../upstream.js";
import { pageView } from "./content.js";

const user = { access: "user" } as const;
/** Сколько BFF помнит задания проверки удержания, выданные ученику (сессия истекает к концу местного дня). */
const CHECK_TTL_SECONDS = 26 * 3600;

const loc = (x: Localized): Localized => ({ ru: x.ru, uz: x.uz });
const hintsNotAllowed = () => new AppError(409, "HINTS_NOT_ALLOWED", "На проверке удержания подсказки недоступны");
const answerInvalid = (field: string) => new AppError(422, "ANSWER_INVALID", "Один ответ на задание: вариант, текст или порядок", { field });

/** Поля подсказки, которые для этого типа задания раскрывают ответ и обязаны быть null (английский эквивалент). */
const REVEALING: Partial<Record<C.ReviewTaskType, ReadonlyArray<keyof C.ReviewTask["prompt"]>>> = {
  // выбор перевода: перевод в подсказке выдал бы верный вариант
  meaning_choice: ["gloss"],
  // выбор английского варианта на слух: текст карточки и пример выдали бы верный вариант
  listen_choice: ["text_en", "example_en"],
  // воспроизведение: английский текст — это и есть ответ
  typed: ["text_en", "example_en", "speech_text"],
  cloze: ["text_en", "example_en", "speech_text"],
  assemble: ["text_en", "example_en", "speech_text"],
  error_fix: ["text_en", "example_en", "speech_text"],
  check_item: ["text_en", "example_en", "speech_text", "gloss"],
};

/** Задание из ответа memory: строгая схема + «ответ не раскрыт»; иначе 503 (в лог — путь и правило, без значений). */
export function checkTask(ctx: BffContext, raw: unknown, what = "review_task"): C.ReviewTask {
  const t = expectShape(ctx.log, MEMORY, what, ReviewTaskSchema, raw) as C.ReviewTask;
  for (const field of REVEALING[t.type] ?? []) {
    if (t.prompt[field] !== null) {
      ctx.log.warn({ upstream: MEMORY, check: what, path: `/prompt/${field}`, rule: "answer_revealed", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "domain response does not match the contract");
      throw upstreamUnavailable(MEMORY);
    }
  }
  return t;
}

/** Задание для Mini App — только поля контракта, явно; у проверки удержания подсказок нет. */
export function taskView(t: C.ReviewTask): C.ReviewTask {
  const p = t.prompt;
  const check = t.type === "check_item";
  return {
    task_id: t.task_id.toLowerCase(),
    index: t.index,
    total: t.total,
    type: t.type,
    card_id: t.card_id ? t.card_id.toLowerCase() : null,
    check: t.check ? { check_id: t.check.check_id, skill_title: loc(t.check.skill_title), position: t.check.position, of: t.check.of } : null,
    prompt: {
      text_en: p.text_en,
      gloss: p.gloss ? loc(p.gloss) : null,
      example_en: p.example_en,
      example_gap: p.example_gap,
      speech_text: p.speech_text,
      explanation: p.explanation ? loc(p.explanation) : null,
      evidence: p.evidence,
      instruction: p.instruction ? loc(p.instruction) : null,
      prompt_en: p.prompt_en,
    },
    options: [...t.options],
    tiles: [...t.tiles],
    answer_kind: t.answer_kind,
    hints: check ? [] : [...t.hints],
    hints_used: check ? [] : [...t.hints_used],
    voice: t.voice,
  };
}

export function memoryRoutes(app: App, ctx: BffContext): void {
  const memory = ctx.domains.memory;
  const log = ctx.log;
  const enc = (id: string) => encodeURIComponent(id.toLowerCase());
  const card = (id: string) => `/internal/v1/cards/${enc(id)}`;
  const rs = (id: string) => `/internal/v1/review-sessions/${enc(id)}`;

  /** Задания проверки удержания, выданные ученику: подсказки и правильность по ним до конца блока не отдаются. */
  const checkKey = (sessionId: string, taskId: string) => `${ctx.config.redisKeyPrefix}mem:check:${sessionId.toLowerCase()}:${taskId.toLowerCase()}`;
  const remember = async (sessionId: string, t: C.ReviewTask | null): Promise<void> => {
    if (t?.type === "check_item") await ctx.store(() => ctx.redis.set(checkKey(sessionId, t.task_id), "1", "EX", CHECK_TTL_SECONDS));
  };
  const isCheck = async (sessionId: string, taskId: string): Promise<boolean> =>
    (await ctx.store(() => ctx.redis.exists(checkKey(sessionId, taskId)))) === 1;

  // ---------------------------------------------------------------- обзор
  app.get(
    "/v1/memory/overview",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Обзор памяти (главная, вкладка «Словарь»): к сроку, новые на сегодня, проверки, повторение сегодня, произношение",
        description:
          "pronunciation: available — можно записывать; consent_self / consent_guardian — нужно согласие (своё или родителя); " +
          "unavailable — оценка выключена (кнопку «Произнести» не показывать).",
        security: BEARER,
        response: { 200: MemoryOverviewSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await memoryCall(ctx, authOf(req), req);
      return expectShape(log, MEMORY, "overview", MemoryOverviewSchema, await memory.json("GET", "/internal/v1/overview", ro));
    },
  );

  // ---------------------------------------------------------------- словарь (APP-MEM-02)
  app.get(
    "/v1/memory/cards",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Мой словарь: слова, фразы и ошибки с силой запоминания и сроком (фильтры вида и статуса, поиск)",
        description: "?kind=word|phrase|error, ?status=, ?q= (≤ 60, по английскому и переводу; в лог не пишется), ?cursor=, ?limit= (1–100).",
        security: BEARER,
        querystring: CardsQuerySchema,
        response: { 200: DictionaryPageSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await memoryCall(ctx, authOf(req), req);
      const q = req.query;
      const res = await memory.json("GET", "/internal/v1/cards", {
        ...ro,
        query: { ...ro.query, kind: q.kind, status: q.status, q: q.q?.trim() || undefined, cursor: q.cursor, limit: q.limit ?? 20 },
      });
      return pageView(ctx, MEMORY, "cards", DictionaryCardSchema, res);
    },
  );

  app.get(
    "/v1/memory/cards/:id",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Карточка словаря: пример, источники, последние 10 повторений, срок, последняя попытка произношения",
        description: "Ошибка (kind error): исправление, ваш фрагмент (стирается через 90 дней — null), объяснение. 404 CARD_NOT_FOUND — нет или чужая.",
        security: BEARER,
        params: IdParamsSchema,
        response: { 200: DictionaryCardDetailSchema, ...errorResponses(401, 404, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await memoryCall(ctx, authOf(req), req);
      return expectShape(log, MEMORY, "card_detail", DictionaryCardDetailSchema, await memory.json("GET", card(req.params.id), ro));
    },
  );

  app.post(
    "/v1/memory/cards",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "«В словарь»: слово или фраза опубликованного контента (201 — новая карточка, 200 — уже была, источник добавлен)",
        description:
          "Idempotency-Key (UUID) обязателен. Только текст из этой опубликованной версии контента (проверяет memory через catalog); " +
          "свой текст ученика — нельзя: 422 WORD_NOT_IN_CONTENT. 422 GLOSS_UNAVAILABLE — перевода нет; 422 CARDS_LIMIT {limit: 2000}; " +
          "404 CONTENT_NOT_FOUND.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: AddCardRequestSchema,
        response: { 200: DictionaryCardSchema, 201: DictionaryCardSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const key = idempotencyKey(req, true)!;
      const { ro } = await memoryCall(ctx, authOf(req), req);
      const b = req.body;
      const source: C.ContentRef = { kind: b.source.kind, key: b.source.key, version: b.source.version, ...(b.source.locator ? { locator: b.source.locator } : {}) };
      const res = await memory.jsonWithStatus("POST", "/internal/v1/cards", { ...ro, idempotencyKey: key, body: { text_en: b.text_en.trim(), source } });
      const view = expectShape(log, MEMORY, "card", DictionaryCardSchema, res.body);
      return reply.code(res.status === 201 ? 201 : 200).send(view);
    },
  );

  for (const [method, summary] of [
    ["POST", "«Знаю это»: карточка не попадает в повторение (status known; это не оценка FSRS)"],
    ["DELETE", "Вернуть карточку в повторение (срок — сейчас)"],
  ] as const) {
    const route = method === "POST" ? app.post.bind(app) : app.delete.bind(app);
    route(
      "/v1/memory/cards/:id/known",
      {
        config: user,
        schema: {
          tags: ["memory"],
          summary,
          description: "404 CARD_NOT_FOUND; 409 CARD_STATE {status} — недопустимо в этом статусе (например, заморожена сотрудником).",
          security: BEARER,
          params: IdParamsSchema,
          response: { 200: DictionaryCardSchema, ...errorResponses(401, 404, 409, 410, 423) },
        },
      },
      async (req) => {
        const { ro } = await memoryCall(ctx, authOf(req), req);
        return expectShape(log, MEMORY, "card", DictionaryCardSchema, await memory.json(method, `${card(req.params.id)}/known`, ro));
      },
    );
  }

  app.delete(
    "/v1/memory/cards/:id",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Убрать карточку из словаря (любую свою; история планирования сохраняется)",
        description: "404 CARD_NOT_FOUND — нет или чужая.",
        security: BEARER,
        params: IdParamsSchema,
        response: { 204: Type.Null({ description: "Удалено" }), ...errorResponses(401, 404, 410, 423) },
      },
    },
    async (req, reply) => {
      const { ro } = await memoryCall(ctx, authOf(req), req);
      await memory.json("DELETE", card(req.params.id), ro);
      return reply.code(204).send(null);
    },
  );

  // ---------------------------------------------------------------- журнал ошибок (APP-MEM-01)
  app.get(
    "/v1/memory/errors",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Журнал ошибок: подтверждённые ошибки из оценок уроков и сценариев (только свободный текст; у детей журнала нет)",
        description: "Без ваших фрагментов (цитата — в карточке, пока не стёрта). ?cursor=, ?limit= (1–100).",
        security: BEARER,
        querystring: CursorQuerySchema,
        response: { 200: ErrorJournalPageSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await memoryCall(ctx, authOf(req), req);
      const res = await memory.json("GET", "/internal/v1/errors", { ...ro, query: { ...ro.query, cursor: req.query.cursor, limit: req.query.limit ?? 20 } });
      return pageView(ctx, MEMORY, "errors", ErrorJournalItemSchema, res);
    },
  );

  // ---------------------------------------------------------------- «Повторение дня» (APP-MEM-03/04/05)
  app.post(
    "/v1/memory/review-sessions",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Начать «Повторение дня» (201) или продолжить незавершённое (200 — оно же)",
        description:
          "Idempotency-Key (UUID) обязателен. Очередь: проверки удержания со сроком, карточки к сроку (до 20, детям до 10), новые " +
          "(до 5, детям до 3). 409 NOTHING_TO_REVIEW {next_due_at} — повторять нечего.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        response: { 200: ReviewSessionSchema, 201: ReviewSessionSchema, ...errorResponses(401, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const key = idempotencyKey(req, true)!;
      const { ro } = await memoryCall(ctx, authOf(req), req);
      const res = await memory.jsonWithStatus("POST", "/internal/v1/review-sessions", { ...ro, idempotencyKey: key });
      return reply.code(res.status === 201 ? 201 : 200).send(expectShape(log, MEMORY, "review_session", ReviewSessionSchema, res.body));
    },
  );

  app.get(
    "/v1/memory/review-sessions/active",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Незавершённое «Повторение дня» или null",
        security: BEARER,
        response: { 200: ActiveReviewSessionSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await memoryCall(ctx, authOf(req), req);
      return expectShape(log, MEMORY, "active_review_session", ActiveReviewSessionSchema, await memory.json("GET", "/internal/v1/review-sessions/active", ro));
    },
  );

  app.get(
    "/v1/memory/review-sessions/:id",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Сессия повторения: статус, задания (сделано / всего), карточки, проверки, минуты",
        description: "404 REVIEW_SESSION_NOT_FOUND — нет или чужая.",
        security: BEARER,
        params: IdParamsSchema,
        response: { 200: ReviewSessionSchema, ...errorResponses(401, 404, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await memoryCall(ctx, authOf(req), req);
      return expectShape(log, MEMORY, "review_session", ReviewSessionSchema, await memory.json("GET", rs(req.params.id), ro));
    },
  );

  app.get(
    "/v1/memory/review-sessions/:id/current",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Текущее задание повторения (без ключа ответа)",
        description:
          "Тип по стадии карточки: intro → узнавание (meaning_choice, listen_choice) → воспроизведение (typed, cloze, assemble), " +
          "error_fix, check_item (проверка удержания, без подсказок). 409 REVIEW_SESSION_STATE {status}; 409 TASK_NOT_CURRENT — заданий не осталось (finish).",
        security: BEARER,
        params: IdParamsSchema,
        response: { 200: ReviewTaskSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await memoryCall(ctx, authOf(req), req);
      const task = taskView(checkTask(ctx, await memory.json("GET", `${rs(req.params.id)}/current`, ro)));
      await remember(req.params.id, task);
      return task;
    },
  );

  app.post(
    "/v1/memory/review-sessions/:id/tasks/:task_id",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Ответ на задание → результат, когда карточка вернётся (FSRS в memory) и следующее задание",
        description:
          "choice (индекс) | text (≤ 200; детям тоже — сравнение локальное, без ИИ) | order (порядок tiles/options) | known (intro: " +
          "«Знаю это»); intro без полей — «Понятно». Один ответ на запрос (иначе 422 ANSWER_INVALID {field}). Повтор — тот же " +
          "результат. 409 TASK_NOT_CURRENT {current_task_id}. На проверке удержания результат и верный ответ — только в конце блока. " +
          "429 RATE_LIMITED (tg.memory.answer, 300 за 10 минут на ученика). Текст ответа в лог не пишется.",
        security: BEARER,
        params: ReviewTaskParamsSchema,
        body: Type.Optional(ReviewAnswerSchema),
        response: { 200: ReviewTaskResultSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const b = req.body ?? {};
      const given = (["choice", "text", "order", "known"] as const).filter((k) => b[k] !== undefined);
      if (given.length > 1) throw answerInvalid(given[1]!);
      await ctx.limiter.enforce("tg.memory.answer", auth.learnerId);
      const { ro } = await memoryCall(ctx, auth, req);
      const { id, task_id: taskId } = req.params;
      const body: C.ReviewAnswer = {
        ...(b.choice !== undefined ? { choice: b.choice } : {}),
        ...(b.text !== undefined ? { text: b.text } : {}),
        ...(b.order !== undefined ? { order: [...b.order] } : {}),
        ...(b.known !== undefined ? { known: b.known } : {}),
      };
      const raw = await memory.json("POST", `${rs(id)}/tasks/${enc(taskId)}`, { ...ro, body });
      const res = expectShape(log, MEMORY, "review_task_result", Type.Object({ ...ReviewTaskResultSchema.properties, next: Type.Unknown() }), raw);
      const next = res.next === null ? null : taskView(checkTask(ctx, res.next, "review_task_result.next"));
      const check = await isCheck(id, taskId);
      if (check && res.correct_answer !== null) {
        log.warn({ upstream: MEMORY, check: "review_task_result.correct_answer", rule: "check_item", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "correct answer on a retention check dropped");
      }
      await remember(id, next);
      const cr = res.check_result;
      return {
        // проверка удержания: результат — только в конце блока (вместе с check_result), верный ответ — только в его итогах
        result: check && !cr ? null : res.result,
        correct_answer: check ? null : res.correct_answer,
        next_review_in_days: res.next_review_in_days,
        requeued: res.requeued,
        check_result: cr
          ? {
              passed: cr.passed,
              correct: cr.correct,
              total: cr.total,
              items: cr.items.map((i) => ({ prompt_en: i.prompt_en, your_answer: i.your_answer, correct_answer: i.correct_answer, correct: i.correct })),
            }
          : null,
        next,
      };
    },
  );

  app.post(
    "/v1/memory/review-sessions/:id/tasks/:task_id/hint",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Подсказка: first_letter (первая буква) или reveal («Не помню» — ответ показан, оценка again)",
        description: "409 HINTS_NOT_ALLOWED — проверка удержания (без подсказок); 409 TASK_NOT_CURRENT.",
        security: BEARER,
        params: ReviewTaskParamsSchema,
        body: ReviewHintRequestSchema,
        response: { 200: ReviewHintSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const { id, task_id: taskId } = req.params;
      if (await isCheck(id, taskId)) throw hintsNotAllowed();
      const { ro } = await memoryCall(ctx, authOf(req), req);
      const res = expectShape(log, MEMORY, "review_hint", ReviewHintSchema, await memory.json("POST", `${rs(id)}/tasks/${enc(taskId)}/hint`, { ...ro, body: { kind: req.body.kind } }));
      return { kind: res.kind, text: res.text };
    },
  );

  app.post(
    "/v1/memory/review-sessions/:id/finish",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Завершить повторение → итог: повторено, верно, новые, проверки удержания, когда следующее (повтор — тот же итог)",
        description: "Только после последнего задания (иначе 409 TASK_NOT_CURRENT). 409 REVIEW_SESSION_STATE {status}.",
        security: BEARER,
        params: IdParamsSchema,
        response: { 200: ReviewSummarySchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await memoryCall(ctx, authOf(req), req);
      return expectShape(log, MEMORY, "review_summary", ReviewSummarySchema, await memory.json("POST", `${rs(req.params.id)}/finish`, ro));
    },
  );

  app.post(
    "/v1/memory/review-sessions/:id/cancel",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Прервать повторение (cancelled; уже данные ответы учтены)",
        description: "409 REVIEW_SESSION_STATE {status}.",
        security: BEARER,
        params: IdParamsSchema,
        response: { 200: ReviewSessionSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const { ro } = await memoryCall(ctx, authOf(req), req);
      return expectShape(log, MEMORY, "review_session", ReviewSessionSchema, await memory.json("POST", `${rs(req.params.id)}/cancel`, ro));
    },
  );

  // ---------------------------------------------------------------- перевод по тапу
  app.post(
    "/v1/memory/translate",
    {
      config: user,
      schema: {
        tags: ["memory"],
        summary: "Перевод слова по тапу: словарь курса → перевод ИИ (помечен, проверяется методистом)",
        description:
          "Только слово/выражение из этой опубликованной версии контента (422 WORD_NOT_IN_CONTENT — свободный ввод не переводится); " +
          "404 CONTENT_NOT_FOUND. gloss = null, reason not_available — перевода нет (показать перевод предложения). " +
          "429 RATE_LIMITED (tg.memory.translate, 60 за 10 минут на ученика). Слово в лог не пишется.",
        security: BEARER,
        body: TranslateRequestSchema,
        response: { 200: WordGlossSchema, ...errorResponses(401, 404, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const b = req.body;
      await ctx.limiter.enforce("tg.memory.translate", auth.learnerId);
      const { ro } = await memoryCall(ctx, auth, req);
      const contentRef: C.ContentRef = { kind: b.content.kind, key: b.content.key, version: b.content.version, ...(b.content.locator ? { locator: b.content.locator } : {}) };
      const res = await memory.json("POST", "/internal/v1/translate", {
        ...ro,
        body: { content_ref: contentRef, text: b.text.trim() },
        timeoutMs: ctx.config.memoryTranslateTimeoutMs,
      });
      return expectShape(log, MEMORY, "word_gloss", WordGlossSchema, res);
    },
  );
}
