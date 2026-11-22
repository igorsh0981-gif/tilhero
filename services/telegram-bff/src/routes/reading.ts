/**
 * Спринт 5 — «Чтение» в «Практике» (bff.ts ReadingCard, ReadingView; INTERNAL_API §2.1, §4, §1.10).
 *
 *  - GET /v1/practice/readings?level=&cursor= → catalog `GET /internal/v1/readings?pair_id=&audience=&level=` (тексты
 *    аудитории активного ученика, пара курса) + `last_result` из lessons `GET /internal/v1/reading-results?ids=` (одним
 *    вызовом на страницу, ≤ 50 id; сбой lessons — `last_result: null`, список показывается);
 *  - GET /v1/practice/readings/{id} → catalog `GET /internal/v1/readings/{id}?audience=` → ReadingView без вопросов и
 *    ответов (только число и типы вопросов) + `in_dictionary` глоссария из memory `POST /internal/v1/cards/lookup`
 *    (сбой memory — null);
 *  - POST /v1/practice/readings/{id}/sessions (Idempotency-Key) → lessons `POST /internal/v1/readings/{id}/sessions` →
 *    LessonSession kind reading (201); дальше — общие маршруты сессий: шаг `reading`, вопросы (`item`, graded_later),
 *    `done`, finish → LessonSummary (practice_only).
 *
 * catalog и lessons — sub = аккаунт, claims `lrn` и `age_band` (как сценарии и медиа): детский профиль catalog и lessons
 * распознают сами и сужают аудиторию до kids — ребёнку только детские тексты (защита в глубину).
 * Коды доменов как есть: 404 READING_NOT_AVAILABLE; 409 SESSION_ACTIVE {session_id, kind, title} | PAIR_NOT_AVAILABLE.
 */
import type * as C from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import { asAccount } from "../account.js";
import { expectShape, matches } from "../check.js";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, idempotencyKey, type App } from "../http.js";
import { withInDictionary } from "../memoryApi.js";
import {
  ContentIdParamsSchema,
  DEFAULT_PAIR,
  IdempotencyHeadersSchema,
  LessonSessionDomainSchema,
  LessonSessionSchema,
  READING_RESULTS_MAX,
  ReadingCardDomainSchema,
  ReadingDetailDomainSchema,
  ReadingPageSchema,
  ReadingQuerySchema,
  ReadingResultSchema,
  ReadingViewSchema,
} from "../schemas.js";
import { claimsOf, pageView } from "./content.js";
import { lessonsCall, readingView, sessionView } from "./lessons.js";

const user = { access: "user" } as const;
const CATALOG = "catalog";
const LESSONS = "lessons";
const enc = encodeURIComponent;

export function readingRoutes(app: App, ctx: BffContext): void {
  const { catalogRaw, lessons } = ctx.domains;
  const log = ctx.log;

  /** catalog от имени ученика: sub = аккаунт, claims lrn и age_band; audience — сегмент активного ученика. */
  const asCatalog = async (auth: Parameters<typeof claimsOf>[0]) => {
    const seg = await ctx.audience.segment(ctx, auth);
    return { audience: seg.audience, ro: { subject: asAccount(auth), claims: claimsOf(auth, seg.accountAgeBand) } };
  };

  /** Последние результаты по текстам страницы (lessons); сбой — пустая карта (last_result: null). */
  const lastResults = async (auth: Parameters<typeof claimsOf>[0], ids: string[]): Promise<Map<string, C.ReadingCard["last_result"]>> => {
    const out = new Map<string, C.ReadingCard["last_result"]>();
    const unique = [...new Set(ids)].slice(0, READING_RESULTS_MAX);
    if (unique.length === 0) return out;
    try {
      const { ro } = await lessonsCall(ctx, auth);
      const res = await lessons.json<{ items?: unknown }>("GET", "/internal/v1/reading-results", { ...ro, query: { ids: unique.join(",") } });
      const items = res && typeof res === "object" && Array.isArray(res.items) ? res.items : null;
      if (!items) {
        log.warn({ upstream: LESSONS, check: "reading_results", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "domain response does not match the contract");
        return out;
      }
      for (const i of items) {
        if (matches(ReadingResultSchema, i)) out.set(i.reading_id, { correct: i.correct, total: i.total, finished_at: i.finished_at });
      }
    } catch (err) {
      // 410 USER_DELETED и прочие 4xx — как есть (ученик удаляется); недоступность lessons — без результатов
      if (err instanceof AppError && err.status < 500) throw err;
    }
    return out;
  };

  app.get(
    "/v1/practice/readings",
    {
      config: user,
      schema: {
        tags: ["reading"],
        summary: "Тексты для чтения по уровню (аудитория активного ученика, пара курса) с последним результатом",
        description:
          "?level=A0..B2, ?cursor=, ?limit= (1–50). Детям 6–13 — только детские тексты. last_result — доля верных ответов последней " +
          "завершённой сессии (lessons; недоступен — null).",
        security: BEARER,
        querystring: ReadingQuerySchema,
        response: { 200: ReadingPageSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req): Promise<C.Page<C.ReadingCard>> => {
      const auth = authOf(req);
      const { audience, ro } = await asCatalog(auth);
      const q = req.query;
      const res = await catalogRaw.json("GET", "/internal/v1/readings", {
        ...ro,
        query: { pair_id: DEFAULT_PAIR, audience, level: q.level, limit: q.limit ?? 20, cursor: q.cursor },
      });
      const page = pageView(ctx, CATALOG, "readings", ReadingCardDomainSchema, res);
      const results = await lastResults(auth, page.items.map((i) => i.reading_id));
      return {
        items: page.items.map((i) => ({
          reading_id: i.reading_id,
          title: { ru: i.title.ru, uz: i.title.uz },
          level: i.level,
          topics: [...i.topics],
          est_minutes: i.est_minutes,
          word_count: i.word_count,
          last_result: results.get(i.reading_id) ?? null,
        })),
        next_cursor: page.next_cursor,
      };
    },
  );

  app.get(
    "/v1/practice/readings/:id",
    {
      config: user,
      schema: {
        tags: ["reading"],
        summary: "Текст для чтения: абзацы и предложения с переводом, глоссарий (подсветка, в словаре ли), число и типы вопросов",
        description:
          "Без вопросов и ответов. Перевод слова по тапу — POST /v1/memory/translate (ContentRef kind reading, locator — s_id). " +
          "404 READING_NOT_AVAILABLE — не опубликован или не для аудитории ученика.",
        security: BEARER,
        params: ContentIdParamsSchema,
        response: { 200: ReadingViewSchema, ...errorResponses(401, 404, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { audience, ro } = await asCatalog(auth);
      const res = await catalogRaw.json("GET", `/internal/v1/readings/${enc(req.params.id)}`, { ...ro, query: { audience } });
      const d = expectShape(log, CATALOG, "reading", ReadingDetailDomainSchema, res);
      const view = readingView({ ...d, glossary: d.glossary.map((g) => ({ ...g, in_dictionary: null })) });
      return withInDictionary(ctx, auth, view);
    },
  );

  app.post(
    "/v1/practice/readings/:id/sessions",
    {
      config: user,
      schema: {
        tags: ["reading"],
        summary: "Начать чтение (сессия kind reading: текст → вопросы → итоги; практика, навыки не меняются)",
        description:
          "Idempotency-Key (UUID) обязателен: повтор с тем же ключом — та же сессия. Дальше — общие маршруты сессий (/v1/sessions/{id}/…). " +
          "404 READING_NOT_AVAILABLE; 409 SESSION_ACTIVE {session_id, kind, title}; 409 PAIR_NOT_AVAILABLE.",
        security: BEARER,
        params: ContentIdParamsSchema,
        headers: IdempotencyHeadersSchema,
        response: { 201: LessonSessionSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const key = idempotencyKey(req, true)!;
      const { kids, ro } = await lessonsCall(ctx, auth, req);
      const res = await lessons.json("POST", `/internal/v1/readings/${enc(req.params.id)}/sessions`, { ...ro, idempotencyKey: key });
      return reply.code(201).send(sessionView(expectShape(log, LESSONS, "reading_session", LessonSessionDomainSchema, res), kids));
    },
  );
}
