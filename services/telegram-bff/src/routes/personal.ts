/**
 * Спринт 6 (INTERNAL_API §6): реакции «Почему вам», слежения Watch, новости.
 *
 * Домены необязательны: без RECOMMENDATIONS_URL / WATCH_URL / NEWS_URL соответствующие эндпоинты отвечают
 * 503 FEATURE_UNAVAILABLE {feature}. Лимиты сверх общего (120/мин): реакции — RATE_LIMIT_REACTIONS_PER_MIN (60),
 * команды слежений (создание, изменение, удаление) — RATE_LIMIT_WATCH_PER_MIN (30). Чужое слежение — 404 WATCH_NOT_FOUND
 * (watch проверяет владельца по sub внутреннего JWT; BFF user_id от клиента не принимает).
 * Изменение слежений и реакции сбрасывают кэш Home (баллы, кнопка Watch, «Что изменилось»).
 */
import { Type } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import type { EventCard, NewsPreferences, Watch } from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import type { BffContext } from "../context.js";
import { detailToCard, isCatalogOutage } from "../events.js";
import { BEARER, authOf, errorResponses, schemaErrors, type App } from "../http.js";
import {
  featureUnavailable,
  loadPrefs,
  loadUser,
  mapLimit,
  offerParamsOf,
  publicWatch,
  type InternalWatch,
} from "../personal.js";
import {
  CATEGORY_CODE,
  CreateWatchRequestSchema,
  EventParamsSchema,
  NewsPageSchema,
  NewsPreferencesPatchSchema,
  NewsPreferencesSchema,
  NewsQuerySchema,
  NewsTopicsQuerySchema,
  NewsTopicsResponseSchema,
  ReactionRequestSchema,
  UUID_RE,
  WatchChangePageSchema,
  WatchChangesQuerySchema,
  WatchListQuerySchema,
  WatchPageSchema,
  WatchParamsSchema,
  WatchPatchRequestSchema,
  WatchSchema,
} from "../schemas.js";

const user = { access: "user" } as const;
const CATEGORY_RE = new RegExp(CATEGORY_CODE);

const IdempotencyHeaders = Type.Object({
  "idempotency-key": Type.Optional(Type.String({ description: "UUID; повтор с тем же ключом — то же слежение" })),
});

function idempotencyKey(req: FastifyRequest): string {
  const raw = req.headers["idempotency-key"];
  const key = Array.isArray(raw) ? undefined : raw?.trim();
  if (key && UUID_RE.test(key)) return key.toLowerCase();
  throw new AppError(422, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key (UUID)");
}

/**
 * Ошибка recommendations → ответ Mini App: 404 только с кодом EVENT_NOT_FOUND; любой другой 404 (нет маршрута — старая
 * версия сервиса) → 503 FEATURE_UNAVAILABLE; 429 — как есть; прочее 4xx/5xx/мусор → 503 UPSTREAM_UNAVAILABLE.
 */
export function recommendationsError(err: unknown, log: () => void): AppError {
  if (err instanceof AppError) {
    if (err.status === 404 && err.code === "EVENT_NOT_FOUND") return new AppError(404, "EVENT_NOT_FOUND", "Событие не найдено");
    if (err.status === 429) return err;
    if (err.code === "FEATURE_UNAVAILABLE") return err;
    log();
    if (err.status === 404) return featureUnavailable("recommendations");
    if (err.status === 503 && err.code === "UPSTREAM_UNAVAILABLE") return err;
  } else log();
  return new AppError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен, повторите позже", { service: "recommendations" });
}

/** Неверный watchId (не UUID) — как несуществующее слежение. */
const watchNotFound = schemaErrors([{ context: "params", status: 404, code: "WATCH_NOT_FOUND", message: "Слежение не найдено" }]);

export function personalRoutes(app: App, ctx: BffContext): void {
  const { recommendations, watch, news, limiter, config } = ctx;

  /** Карточка события для Watch (каталог; нет/недоступен — null), без лишних вызовов для повторов. */
  const cardsOf = async (ids: readonly string[]): Promise<Map<string, EventCard | null>> => {
    const uniq = [...new Set(ids.map((x) => x.toLowerCase()))];
    const cards = await mapLimit(uniq, 5, async (id) => {
      try {
        return detailToCard(await ctx.catalog.get(id));
      } catch {
        return null;
      }
    });
    return new Map(uniq.map((id, i) => [id, cards[i] ?? null]));
  };
  const withCard = async (w: InternalWatch): Promise<Watch> => publicWatch(w, (await cardsOf([w.event_id])).get(w.event_id.toLowerCase()) ?? null);

  const watchCommand = async (userId: string) => {
    if (!watch.configured) throw featureUnavailable("watch");
    await limiter.enforce("tg.watch", userId);
  };
  const needWatch = () => {
    if (!watch.configured) throw featureUnavailable("watch");
  };
  const needNews = () => {
    if (!news.configured) throw featureUnavailable("news");
  };

  // ---------------------------------------------------------------- реакции

  app.post(
    "/v1/recommendations/reactions",
    {
      config: user,
      schema: {
        tags: ["recommendations"],
        summary: "Реакция на рекомендацию: «Больше такого» / «Не интересно» (undo — снять)",
        description:
          "Тело ReactionRequest {event_id, reaction: more|less, undo?}. Категории события BFF берёт из каталога. Идемпотентно " +
          "по (пользователь, событие). Лимит RATE_LIMIT_REACTIONS_PER_MIN (60) в минуту. Сбрасывает кэш Home. " +
          "→ 204. 404 EVENT_NOT_FOUND; 503 FEATURE_UNAVAILABLE (рекомендации не подключены) | EVENTS_UNAVAILABLE | UPSTREAM_UNAVAILABLE.",
        security: BEARER,
        body: ReactionRequestSchema,
        response: { 204: Type.Null({ description: "Реакция учтена" }), ...errorResponses(401, 404, 423) },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      if (!recommendations.configured) throw featureUnavailable("recommendations");
      await limiter.enforce("tg.reactions", userId);
      const eventId = req.body.event_id.toLowerCase();
      const detail = await ctx.catalog.get(eventId);
      try {
        await recommendations.react(userId, {
          event_id: eventId,
          categories: detail.categories.filter((c) => CATEGORY_RE.test(c)),
          reaction: req.body.reaction,
          undo: req.body.undo ?? false,
        });
      } catch (err) {
        if (err instanceof AppError && err.status === 422) throw new AppError(422, "VALIDATION_ERROR", "Некорректная реакция", { in: "body" });
        throw recommendationsError(err, () => recommendations.logFailure(err, "reaction"));
      }
      await ctx.home.invalidate(userId);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    "/v1/recommendations/reactions/:eventId",
    {
      config: user,
      schemaErrorFormatter: schemaErrors([{ context: "params", status: 404, code: "EVENT_NOT_FOUND", message: "Событие не найдено" }]),
      schema: {
        tags: ["recommendations"],
        summary: "Снять реакцию на событие (отмена «Не интересно» / «Больше такого»)",
        description:
          "Текущая реакция берётся из recommendations (GET /internal/v1/reactions/{event_id}) и снимается (undo). Реакции нет — " +
          "тоже 204. Лимит реакций общий (60/мин). Сбрасывает кэш Home. → 204. 404 EVENT_NOT_FOUND (не-UUID); " +
          "503 FEATURE_UNAVAILABLE | UPSTREAM_UNAVAILABLE.",
        security: BEARER,
        params: EventParamsSchema,
        response: { 204: Type.Null({ description: "Реакция снята" }), ...errorResponses(401, 404, 423) },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      if (!recommendations.configured) throw featureUnavailable("recommendations");
      await limiter.enforce("tg.reactions", userId);
      const eventId = req.params.eventId.toLowerCase();
      let current: "more_like_this" | "not_interested" | null;
      try {
        current = await recommendations.reactionOf(userId, eventId);
      } catch (err) {
        throw recommendationsError(err, () => recommendations.logFailure(err, "reaction_state"));
      }
      if (current) {
        await recommendations.react(userId, { event_id: eventId, categories: [], reaction: current === "not_interested" ? "less" : "more", undo: true });
        await ctx.home.invalidate(userId);
      }
      return reply.code(204).send(null);
    },
  );

  // ---------------------------------------------------------------- слежения

  app.post(
    "/v1/watches",
    {
      config: user,
      schema: {
        tags: ["watch"],
        summary: "Следить за событием (один тап «Следить»)",
        description:
          "Заголовок Idempotency-Key (UUID) обязателен (422 IDEMPOTENCY_KEY_REQUIRED), пробрасывается в watch. Тело " +
          "CreateWatchRequest {event_id, dimensions?, threshold_pct? 5|10|15, tier?, travellers?}. offer_params BFF берёт из " +
          "последнего расчёта «Поездки» пользователя по событию (тариф, путешественники, вылет, только прямые, отель рядом, " +
          "доп. ночи, отель) и профиля (бюджет, города вылета, предпочтения перелёта); расчёта не было — comfort, 1 " +
          "путешественник; tier/travellers из тела важнее. → 201 Watch (создано) | 200 Watch (слежение за событием уже есть). " +
          "Лимит RATE_LIMIT_WATCH_PER_MIN (30) команд в минуту. 404 EVENT_NOT_FOUND; 409 WATCH_LIMIT; 422 EVENT_PAST; " +
          "503 FEATURE_UNAVAILABLE.",
        security: BEARER,
        headers: IdempotencyHeaders,
        body: CreateWatchRequestSchema,
        response: { 200: WatchSchema, 201: WatchSchema, ...errorResponses(401, 404, 409, 423) },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      await watchCommand(userId);
      const key = idempotencyKey(req);
      const eventId = req.body.event_id.toLowerCase();
      const [detail, prefs, trip] = await Promise.all([
        ctx.catalog.get(eventId).catch((err: unknown) => {
          if (isCatalogOutage(err)) return null; // watch сам проверит событие
          throw err;
        }),
        loadPrefs(ctx.domains.preferences, userId),
        ctx.lastTrip.get(userId, eventId),
      ]);
      if (detail?.is_past) throw new AppError(422, "EVENT_PAST", "Событие уже прошло");
      // без городов вылета и бюджета перепроверка цены была бы неверной — честнее 503
      if (!prefs) throw new AppError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен, повторите позже", { service: "preferences" });
      const { created, watch: w } = await watch.create(
        userId,
        {
          event_id: eventId,
          offer_params: offerParamsOf(req.body, trip, prefs),
          ...(req.body.dimensions ? { dimensions: req.body.dimensions } : {}),
          ...(req.body.threshold_pct ? { threshold_pct: req.body.threshold_pct } : {}),
          ...(req.body.offer_id ? { offer_id: req.body.offer_id.toLowerCase() } : {}),
        },
        key,
      );
      await ctx.home.invalidate(userId);
      const card = detail && detail.event_id.toLowerCase() === w.event_id.toLowerCase() ? detailToCard(detail) : null;
      return reply.code(created ? 201 : 200).send(publicWatch(w, card));
    },
  );

  app.get(
    "/v1/watches",
    {
      config: user,
      schema: {
        tags: ["watch"],
        summary: "Мои слежения (с последним изменением и карточкой события)",
        description: "status active|paused|ended; limit ≤ 20; cursor. → Page<Watch>. 503 FEATURE_UNAVAILABLE.",
        security: BEARER,
        querystring: WatchListQuerySchema,
        response: { 200: WatchPageSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      needWatch();
      const page = await watch.list(userId, { status: req.query.status, cursor: req.query.cursor, limit: req.query.limit ?? 20 });
      const cards = await cardsOf(page.items.map((w) => w.event_id));
      return { items: page.items.map((w) => publicWatch(w, cards.get(w.event_id.toLowerCase()) ?? null)), next_cursor: page.next_cursor };
    },
  );

  app.get(
    "/v1/watches/:watchId",
    {
      config: user,
      schemaErrorFormatter: watchNotFound,
      schema: {
        tags: ["watch"],
        summary: "Слежение",
        description: "→ Watch. 404 WATCH_NOT_FOUND (нет, чужое или не-UUID); 503 FEATURE_UNAVAILABLE.",
        security: BEARER,
        params: WatchParamsSchema,
        response: { 200: WatchSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      needWatch();
      return withCard(await watch.get(userId, req.params.watchId.toLowerCase()));
    },
  );

  app.patch(
    "/v1/watches/:watchId",
    {
      config: user,
      schemaErrorFormatter: watchNotFound,
      schema: {
        tags: ["watch"],
        summary: "Изменить слежение: измерения, порог 5/10/15 %, пауза/возобновление",
        description:
          "Тело {dimensions?, threshold_pct?, status?: active|paused, expected_version}. → Watch. 404 WATCH_NOT_FOUND; " +
          "409 VERSION_CONFLICT; лимит команд 30/мин; 503 FEATURE_UNAVAILABLE.",
        security: BEARER,
        params: WatchParamsSchema,
        body: WatchPatchRequestSchema,
        response: { 200: WatchSchema, ...errorResponses(401, 404, 409, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      await watchCommand(userId);
      const w = await watch.patch(userId, req.params.watchId.toLowerCase(), req.body as Record<string, unknown>);
      await ctx.home.invalidate(userId);
      return withCard(w);
    },
  );

  app.delete(
    "/v1/watches/:watchId",
    {
      config: user,
      schemaErrorFormatter: watchNotFound,
      schema: {
        tags: ["watch"],
        summary: "Перестать следить",
        description: "→ 204. 404 WATCH_NOT_FOUND; лимит команд 30/мин; 503 FEATURE_UNAVAILABLE.",
        security: BEARER,
        params: WatchParamsSchema,
        response: { 204: Type.Null({ description: "Слежение удалено" }), ...errorResponses(401, 404, 423) },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      await watchCommand(userId);
      await watch.remove(userId, req.params.watchId.toLowerCase());
      await ctx.home.invalidate(userId);
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/v1/watches/:watchId/changes",
    {
      config: user,
      schemaErrorFormatter: schemaErrors([{ context: "params", status: 404, code: "WATCH_NOT_FOUND", message: "Слежение не найдено" }]),
      schema: {
        tags: ["watch"],
        summary: "История изменений слежения",
        description: "cursor; limit ≤ 50. → Page<WatchChange>. 404 WATCH_NOT_FOUND; 503 FEATURE_UNAVAILABLE.",
        security: BEARER,
        params: WatchParamsSchema,
        querystring: WatchChangesQuerySchema,
        response: { 200: WatchChangePageSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      needWatch();
      return watch.changes(userId, req.params.watchId.toLowerCase(), { cursor: req.query.cursor, limit: req.query.limit ?? 20 });
    },
  );

  // ---------------------------------------------------------------- новости

  app.get(
    "/v1/news",
    {
      config: user,
      schema: {
        tags: ["news"],
        summary: "Новости: все / из Watch / по интересам",
        description:
          "filter all|watch|interests (all); topic music|sport|business|culture|education|festivals (6.1, иначе 422); cursor; " +
          "limit ≤ 50 (20). BFF передаёт в news географию профиля (6.1), интересы и сущности профиля " +
          "(если by_interests), события на слежении (если from_watch), only_significant — из настроек новостей. У каждой " +
          "новости источник (имя, домен, https-ссылка на домене источника). → Page<NewsItem>. 503 FEATURE_UNAVAILABLE.",
        security: BEARER,
        querystring: NewsQuerySchema,
        response: { 200: NewsPageSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      needNews();
      let prefsP: ReturnType<typeof loadPrefs> | null = null;
      let watchesP: Promise<InternalWatch[]> | null = null;
      return ctx.home.newsFeed(
        userId,
        () => (prefsP ??= loadPrefs(ctx.domains.preferences, userId)),
        () => loadUser(ctx.domains.identity, userId),
        () => (watchesP ??= watch.list(userId, { status: "active", limit: 20 }).then((p) => p.items)),
        { filter: req.query.filter ?? "all", topic: req.query.topic, cursor: req.query.cursor, limit: req.query.limit ?? 20 },
      );
    },
  );

  app.get(
    "/v1/news/topics",
    {
      config: user,
      schema: {
        tags: ["news"],
        summary: "Темы новостей (чипы) с числом новостей",
        description:
          "6.1: filter all|watch|interests (all). То же тело, что у ленты (интересы, сущности и география профиля, слежения, " +
          "настройки новостей), без cursor/limit/topic → news:topics. → NewsTopicsResponse {items: [{topic, count}] — непустые " +
          "темы в порядке чипов, total — вся выдача}. Старый news без тем — {items: [], total: null}. 503 FEATURE_UNAVAILABLE.",
        security: BEARER,
        querystring: NewsTopicsQuerySchema,
        response: { 200: NewsTopicsResponseSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      needNews();
      let watchesP: Promise<InternalWatch[]> | null = null;
      return ctx.home.newsTopics(
        userId,
        () => loadPrefs(ctx.domains.preferences, userId),
        () => loadUser(ctx.domains.identity, userId),
        () => (watchesP ??= watch.list(userId, { status: "active", limit: 20 }).then((p) => p.items)),
        req.query.filter ?? "all",
      );
    },
  );

  app.get(
    "/v1/news/preferences",
    {
      config: user,
      schema: {
        tags: ["news"],
        summary: "Настройки новостей",
        description: "→ NewsPreferences {from_watch, by_interests, only_significant, digest}. 503 FEATURE_UNAVAILABLE.",
        security: BEARER,
        response: { 200: NewsPreferencesSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      needNews();
      return news.preferences(userId);
    },
  );

  app.patch(
    "/v1/news/preferences",
    {
      config: user,
      schema: {
        tags: ["news"],
        summary: "Изменить настройки новостей (частично)",
        description: "Тело — любые из полей NewsPreferences (хотя бы одно). → NewsPreferences. Сбрасывает кэш Home. 503 FEATURE_UNAVAILABLE.",
        security: BEARER,
        body: NewsPreferencesPatchSchema,
        response: { 200: NewsPreferencesSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      needNews();
      const current = await news.preferences(userId);
      const next: NewsPreferences = { ...current, ...(req.body as Partial<NewsPreferences>) };
      const saved = await news.savePreferences(userId, next);
      await ctx.home.invalidate(userId);
      return saved;
    },
  );
}
