/**
 * Предложения поездки под событие (спринт 5, INTERNAL_API §4): Mini App → BFF → offers.
 * Лимит — RATE_LIMIT_OFFERS_PER_MIN (20) расчётов в минуту на пользователя, общий для GET и пересчёта
 * (сверх общего лимита 120/мин): каждый расчёт — вызовы поставщиков с суточными квотами.
 */
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, schemaErrors, type App } from "../http.js";
import { NO_OVERRIDES, offersUnavailable, overridesOf } from "../offers.js";
import { AiTripParamsSchema, EventParamsSchema, OfferSetViewSchema, OffersQuerySchema } from "../schemas.js";

const TAG = ["offers"];

/** Неверный eventId (не UUID) — как у детали события: 404 EVENT_NOT_FOUND. Ошибки query/тела — 422. */
const eventNotFound = schemaErrors([{ context: "params", status: 404, code: "EVENT_NOT_FOUND", message: "Событие не найдено" }]);

const ERRORS =
  "404 EVENT_NOT_FOUND (неизвестное событие или не-UUID); 422 VALIDATION_ERROR | OFFER_DEPARTURE_INVALID; " +
  "429 RATE_LIMITED {retry_after} (20 расчётов в минуту); 503 OFFERS_UNAVAILABLE (offers недоступен, не настроен или ответил не по контракту).";

export function offersRoutes(app: App, ctx: BffContext): void {
  const limit = async (userId: string) => {
    if (!ctx.offers.configured) throw offersUnavailable();
    await ctx.limiter.enforce("tg.offers", userId);
  };

  app.get(
    "/v1/events/:eventId/offers",
    {
      config: { access: "user" },
      schemaErrorFormatter: eventNotFound,
      schema: {
        tags: TAG,
        summary: "Поездка под событие: тарифы Economy/Comfort/Premium, отели и места рядом",
        description:
          "travellers 1..6 (1). Города вылета, предпочтения перелёта и бюджет — из профиля пользователя, без изменений расчёта. " +
          "Цены — ориентировочные, у каждой поставщик и время получения. " +
          ERRORS,
        security: BEARER,
        params: EventParamsSchema,
        querystring: OffersQuerySchema,
        response: { 200: OfferSetViewSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      await limit(userId);
      return ctx.offers.build(userId, req.params.eventId.toLowerCase(), req.query.travellers ?? 1, NO_OVERRIDES);
    },
  );

  app.post(
    "/v1/events/:eventId/offers/recalculate",
    {
      config: { access: "user" },
      schemaErrorFormatter: eventNotFound,
      schema: {
        tags: TAG,
        summary: "Пересчёт поездки: путешественники, город вылета, только прямые, отель рядом, дополнительные ночи",
        description:
          "Тело OfferRecalculateRequest: travellers 1..6; departure_iata ^[A-Z]{3}$ — город вылета из профиля или " +
          "альтернативный хаб (иначе 422 OFFER_DEPARTURE_INVALID); direct_only; near_venue (отель ≤ 1 км); extra_nights 0..3; " +
          "hotel_id (5.1) — отель из hotels_nearby для всех тарифов (≤ 64, ^[A-Za-z0-9_-]+$; null — подбор по правилам; " +
          "нет в результатах поиска → hotel unavailable/NO_HOTEL); keep_hotels (5.2) — {economy?, comfort?, premium?}: отели тарифов " +
          "прошлого расчёта при смене числа путешественников (тариф остаётся на своём отеле, если он есть в поиске; с hotel_id не применяется). " +
          "hotel_filters (6.3) — {rating_min?, max_distance_km?, min_stars?} только для этой поездки, поверх настроек отеля профиля " +
          "(null — как в профиле; rating_min 0 — любая, min_stars 0 — любые). " +
          "Бюджет — из профиля (budget_fit/over_by, recommended_tier). Спринт 7: принимается selected_tier (AiTripParams из " +
          "tool_result консьержа) — в offers не передаётся. " +
          ERRORS,
        security: BEARER,
        params: EventParamsSchema,
        // = OfferRecalculateRequest + selected_tier? (спринт 7): Mini App применяет trip_params консьержа как есть
        body: AiTripParamsSchema,
        response: { 200: OfferSetViewSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      await limit(userId);
      return ctx.offers.build(userId, req.params.eventId.toLowerCase(), req.body.travellers, overridesOf(req.body));
    },
  );
}
