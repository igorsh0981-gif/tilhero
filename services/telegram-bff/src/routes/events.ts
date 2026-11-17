/**
 * Каталог событий для Mini App (спринт 3): поиск с фильтрами и деталь события. Источник — event-catalog;
 * n8n в read path не участвует (Mini App → BFF → event-catalog).
 */
import { AppError } from "@tilhero/ts-common";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, schemaErrors, type App } from "../http.js";
import { detailToCard, type CatalogDetail, type FacetsQuery } from "../events.js";
import { loadLang, loadPrefs } from "../personal.js";
import type { EventCard, Recommendation } from "@tilhero/contracts/bff";
import {
  EventDetailPersonalSchema,
  EventFacetsQuerySchema,
  EventFacetsSchema,
  EventCardPageSchema,
  EventParamsSchema,
  EventsQuerySchema,
  MAX_COUNTRIES,
  MAX_MONTH_WINDOW_DAYS,
} from "../schemas.js";

const TAG = ["events"];

/** Неверный eventId (не UUID) — тот же ответ, что и для несуществующего события. */
const eventNotFound = schemaErrors([{ context: "params", status: 404, code: "EVENT_NOT_FOUND", message: "Событие не найдено" }]);

/** YYYY-MM-DD — настоящая календарная дата (2026-02-30 отклоняется). */
export function isCalendarDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100;
}

function invalidQuery(field: string, rule: string): AppError {
  return new AppError(422, "VALIDATION_ERROR", "Некорректные данные запроса", {
    in: "querystring",
    field,
    errors: [{ field, rule, message: rule, params: {} }],
  });
}

/** country (повтор параметра и/или через запятую) → ISO-2 в верхнем регистре без дублей; > MAX_COUNTRIES → 422. */
export function parseCountries(raw: readonly string[] | undefined): string[] | undefined {
  if (!raw?.length) return undefined;
  const list = [...new Set(raw.flatMap((v) => v.split(",")).map((c) => c.trim().toUpperCase()))];
  if (list.some((c) => !/^[A-Z]{2}$/.test(c))) throw invalidQuery("country", "pattern");
  if (list.length > MAX_COUNTRIES) throw invalidQuery("country", "maxItems");
  return list;
}

interface FilterInput {
  q?: string;
  category?: string;
  country?: string[];
  city?: string;
  date_from?: string;
  date_to?: string;
  has_tickets?: boolean;
  online?: boolean;
}

const DAY_MS = 86_400_000;

/** Окно this_month от Mini App (недоверенное): обе даты или ни одной, настоящие даты, month_from ≤ month_to,
 *  не длиннее MAX_MONTH_WINDOW_DAYS — те же правила, что у event-catalog. */
export function monthWindowOf(q: { month_from?: string; month_to?: string }): { month_from?: string; month_to?: string } {
  const { month_from: from, month_to: to } = q;
  if (from === undefined && to === undefined) return {};
  if (from === undefined) throw invalidQuery("month_from", "required");
  if (to === undefined) throw invalidQuery("month_to", "required");
  if (!isCalendarDate(from)) throw invalidQuery("month_from", "date");
  if (!isCalendarDate(to)) throw invalidQuery("month_to", "date");
  if (from > to) throw invalidQuery("month_from", "date_range");
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS > MAX_MONTH_WINDOW_DAYS) {
    throw invalidQuery("month_to", "max_window");
  }
  return { month_from: from, month_to: to };
}

/** Общая проверка и нормализация фильтров поиска и счётчиков. */
function filtersOf(q: FilterInput): FacetsQuery {
  for (const f of ["date_from", "date_to"] as const) {
    if (q[f] !== undefined && !isCalendarDate(q[f])) throw invalidQuery(f, "date");
  }
  if (q.date_from && q.date_to && q.date_from > q.date_to) throw invalidQuery("date_to", "date_range");
  const text = q.q?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const city = q.city?.trim();
  return {
    q: text || undefined,
    category: q.category,
    country: parseCountries(q.country),
    city: city || undefined,
    date_from: q.date_from,
    date_to: q.date_to,
    has_tickets: q.has_tickets,
    online: q.online,
  };
}

/** «Почему вам» на детали (§6): ранжирование одного кандидата с факторами; сбой/не настроено/исключено — null. */
export async function detailRecommendation(ctx: BffContext, userId: string, d: CatalogDetail): Promise<Recommendation | null> {
  const rec = ctx.recommendations;
  if (!rec.configured) return null;
  try {
    const prefs = await loadPrefs(ctx.domains.preferences, userId);
    if (!prefs) return null;
    const [lang, trips] = await Promise.all([loadLang(ctx.domains.identity, userId), ctx.lastTrip.perPerson(userId, [d.event_id])]);
    const ranked = await rec.rank(userId, prefs, [detailToCard(d)], { limit: 1, diversity: false, withFactors: true, lang, tripPerPerson: trips });
    return ranked[0]?.recommendation ?? null;
  } catch (err) {
    rec.logFailure(err, "detail");
    return null;
  }
}

/** Реакция пользователя на событие (деталь, отмена «Не интересно»): сбой/не настроено — null. */
export async function detailReaction(ctx: BffContext, userId: string, eventId: string) {
  if (!ctx.recommendations.configured) return null;
  try {
    return await ctx.recommendations.reactionOf(userId, eventId);
  } catch (err) {
    ctx.recommendations.logFailure(err, "reaction_state");
    return null;
  }
}

/** Кнопки Watch на карточках каталога: watch {watch_id, status} | null; watch не настроен/недоступен — поля нет. */
export async function withWatch(ctx: BffContext, userId: string, items: EventCard[]): Promise<EventCard[]> {
  if (!ctx.watch.configured || !items.length) return items;
  try {
    const refs = await ctx.watch.byEvents(userId, items.map((c) => c.event_id));
    return items.map((c) => ({ ...c, watch: refs.get(c.event_id.toLowerCase()) ?? null }));
  } catch (err) {
    ctx.log.warn({ upstream: "watch", where: "events", err_code: (err as { code?: string })?.code ?? (err as Error)?.name }, "watch by-events unavailable");
    return items;
  }
}

/** Кнопка Watch на детали: {watch_id, status} | null (не на слежении, watch не настроен или недоступен). */
export async function detailWatch(ctx: BffContext, userId: string, eventId: string) {
  if (!ctx.watch.configured) return null;
  try {
    return (await ctx.watch.byEvents(userId, [eventId])).get(eventId.toLowerCase()) ?? null;
  } catch (err) {
    ctx.log.warn({ upstream: "watch", where: "detail", err_code: (err as { code?: string })?.code ?? (err as Error)?.name }, "watch by-events unavailable");
    return null;
  }
}

export function eventsRoutes(app: App, ctx: BffContext): void {
  app.get(
    "/v1/events",
    {
      config: { access: "user" },
      schema: {
        tags: TAG,
        summary: "Поиск событий каталога (строка поиска, фильтры, сортировка, пагинация)",
        description:
          "q ≤ 100 (название, площадка, город); category — код таксономии (с потомками) или other (без категории); " +
          "country — ISO-2, несколько: повтор параметра или через запятую, до 20; city; " +
          "date_from/date_to — локальные даты события YYYY-MM-DD; has_tickets — ON_SALE/LOW_INVENTORY/RESALE; online; " +
          "sort soonest|newest|quality; limit ≤ 50 (20); cursor — непрозрачный. По умолчанию без COMPLETED/CANCELLED. " +
          "→ Page<EventCard>; спринт 6: карточки += watch {watch_id, status} | null (watches:by-events; watch не подключён или " +
          "недоступен — поля нет). 422 VALIDATION_ERROR; 503 EVENTS_UNAVAILABLE (каталог недоступен; stale-копии нет).",
        security: BEARER,
        querystring: EventsQuerySchema,
        response: { 200: EventCardPageSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const q = req.query;
      const page = await ctx.catalog.search({
        ...filtersOf(q),
        sort: q.sort ?? "soonest",
        limit: q.limit ?? 20,
        cursor: q.cursor,
      });
      return { items: await withWatch(ctx, userId, page.items), next_cursor: page.next_cursor };
    },
  );

  app.get(
    "/v1/events/facets",
    {
      config: { access: "user" },
      schema: {
        tags: TAG,
        summary: "Счётчики быстрых фильтров каталога (исправление 4.1)",
        description:
          "Те же фильтры, что у GET /v1/events (без sort/limit/cursor). Каждый счётчик учитывает остальные активные фильтры, " +
          "кроме своего измерения; categories — корневые коды и other (без категории), countries — ISO-2. " +
          "month_from/month_to (YYYY-MM-DD, оба или ни одного, ≤ 31 дня) — окно чипа «В этом месяце» в календаре пользователя: " +
          "this_month считается по нему (без них — по UTC). Кэш 60 с по набору фильтров и окну (общий, не персональный). " +
          "→ EventFacets. 422 VALIDATION_ERROR; 503 EVENTS_UNAVAILABLE.",
        security: BEARER,
        querystring: EventFacetsQuerySchema,
        response: { 200: EventFacetsSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      authOf(req);
      return ctx.facets.get({ ...filtersOf(req.query), ...monthWindowOf(req.query) });
    },
  );

  app.get(
    "/v1/events/:eventId",
    {
      config: { access: "user" },
      schemaErrorFormatter: eventNotFound,
      schema: {
        tags: TAG,
        summary: "Деталь события: источники, lifecycle с основанием, медиа с provenance, карта площадки, «Почему вам», Watch",
        description:
          "eventId — UUID. Спринт 6: recommendation {score, reasons, factors} — ранжирование одного кандидата (null — сервис " +
          "рекомендаций недоступен/не настроен или событие исключено реакцией «Не интересно»); watch {watch_id, status} | null. " +
          "404 EVENT_NOT_FOUND (неизвестное, скрытое или не-UUID); 503 EVENTS_UNAVAILABLE.",
        security: BEARER,
        params: EventParamsSchema,
        response: { 200: EventDetailPersonalSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const id = req.params.eventId.toLowerCase();
      const detail = await ctx.catalog.get(id);
      const [recommendation, watch, reaction] = await Promise.all([
        detailRecommendation(ctx, userId, detail),
        detailWatch(ctx, userId, id),
        detailReaction(ctx, userId, id),
      ]);
      return { ...detail, recommendation, watch, reaction };
    },
  );
}
