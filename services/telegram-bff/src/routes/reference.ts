/**
 * Публичные и справочные эндпоинты: политика, Remote Experience Config, Home (каркас), справочники.
 */
import type { Airport, GeoOption, InterestCategory, PolicyDocument } from "@tilhero/contracts/bff";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, type App } from "../http.js";
import {
  AirportSchema,
  AirportsQuerySchema,
  ExperienceConfigSchema,
  GeoOptionSchema,
  HomeResponseSchema,
  InterestCategorySchema,
  PolicyDocumentSchema,
  PolicyQuerySchema,
  itemsOf,
} from "../schemas.js";

export function referenceRoutes(app: App, ctx: BffContext): void {
  const { domains } = ctx;

  app.get(
    "/v1/legal/policy",
    {
      config: { access: "public", ipLimit: "public" },
      schema: {
        tags: ["consent"],
        summary: "Политика обработки данных (публично)",
        querystring: PolicyQuerySchema,
        response: { 200: PolicyDocumentSchema, ...errorResponses() },
      },
    },
    async (req, reply) => {
      const doc = await domains.identity.get<PolicyDocument>("/internal/v1/legal/policy", {
        query: { lang: req.query.lang ?? "ru" },
      });
      void reply.header("cache-control", "public, max-age=300");
      return doc;
    },
  );

  app.get(
    "/v1/experience/config",
    {
      config: { access: "public", ipLimit: "public" },
      schema: {
        tags: ["experience"],
        summary: "Remote Experience Config Mini App (тема, секции Home, флаги)",
        description: "Публично, кэш 60 с; при недоступности experience-config — последняя полученная версия.",
        response: { 200: ExperienceConfigSchema, ...errorResponses() },
      },
    },
    async (_req, reply) => {
      const cfg = await ctx.experience.get();
      void reply.header("cache-control", "public, max-age=60");
      return cfg;
    },
  );

  app.get(
    "/v1/home",
    {
      config: { access: "user" },
      schema: {
        tags: ["home"],
        summary: "Главный экран: «Лучшее для вас», «Что изменилось», продажи скоро, новости, сводка «Пока вас не было»",
        description:
          "Секции и их порядок — из Remote Experience Config. best_for_you — кандидаты по интересам и странам → " +
          "recommendations:rank (карточки += recommendation {score, reasons}; сбой — прежний порядок, recommendation null); " +
          "sales_soon — SALES_SOON, ближайшие; до 10 карточек, у карточек watch {watch_id, status} | null. watch_changes — " +
          "последние изменения слежений; news_carousel — до 10 новостей; домен не подключён — pending_data. Кэш на пользователя: " +
          "свежий 60 с, stale 24 ч; домен недоступен → секция из stale-копии (state «stale»), без копии — «unavailable»; HTTP " +
          "всегда 200 (AT-34). summary (AT-23) — при визите после ≥ 30 мин {since, new_events, price_drops, sales_opened, critical}, " +
          "иначе null.",
        security: BEARER,
        response: { 200: HomeResponseSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      return ctx.home.build(userId);
    },
  );

  app.get(
    "/v1/directory/airports",
    {
      config: { access: "user" },
      schema: {
        tags: ["directory"],
        summary: "Поиск аэропортов (город, IATA, страна; English naming)",
        security: BEARER,
        querystring: AirportsQuerySchema,
        response: { 200: itemsOf(AirportSchema), ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      return domains.preferences.get<{ items: Airport[] }>("/internal/v1/directory/airports", {
        subject: userId,
        query: { q: req.query.q?.trim() || undefined, limit: req.query.limit ?? 20 },
      });
    },
  );

  app.get(
    "/v1/directory/interests",
    {
      config: { access: "user" },
      schema: {
        tags: ["directory"],
        summary: "Категории интересов",
        security: BEARER,
        response: { 200: itemsOf(InterestCategorySchema), ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      return domains.preferences.get<{ items: InterestCategory[] }>("/internal/v1/directory/interests", { subject: userId });
    },
  );

  app.get(
    "/v1/directory/geographies",
    {
      config: { access: "user" },
      schema: {
        tags: ["directory"],
        summary: "Варианты географии (мир, регионы, страны, города)",
        security: BEARER,
        response: { 200: itemsOf(GeoOptionSchema), ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      return domains.preferences.get<{ items: GeoOption[] }>("/internal/v1/directory/geographies", { subject: userId });
    },
  );
}
