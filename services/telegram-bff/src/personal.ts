/**
 * Спринт 6 (INTERNAL_API §1–3, §6): клиенты recommendations, watch, news и проверка их ответов.
 *
 * Ответы доменов — недоверенные данные: строки чистятся от управляющих символов (scrubStrings), затем каждая
 * сущность проверяется строгой схемой TypeBox (src/schemas.ts) и проецируется на неё (лишние поля не уходят дальше):
 *  - recommendations:rank — весь ответ или ничего (битый элемент → сбой ранжирования, Home покажет прежний порядок);
 *    причины с неизвестным кодом (новая версия сервиса) отбрасываются, остаётся ≤ 3;
 *  - watch — слежение/изменение, не прошедшее схему: в списке — отбрасывается, одиночное — 503 UPSTREAM_UNAVAILABLE;
 *  - news — новость без https-ссылки на домене источника, с битыми полями — отбрасывается.
 * Без URL домена (RECOMMENDATIONS_URL / WATCH_URL / NEWS_URL) сервис configured=false: эндпоинты → 503 FEATURE_UNAVAILABLE.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type {
  CreateWatchRequest,
  EventCard,
  NewsItem,
  NewsPreferences,
  NewsTopic,
  NewsTopicsResponse,
  Page,
  Preferences,
  Recommendation,
  RecommendationReason,
  Watch,
  WatchChange,
  WatchDimensions,
} from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import { Ajv, type ValidateFunction } from "ajv";
import type { Static } from "@fastify/type-provider-typebox";
import { firstSeenOf } from "./events.js";
import { hotelFiltersOf, project, scrubStrings, tripHotelFiltersOf, tripProfile, type HotelFilters, type LastTrip } from "./offers.js";
import {
  ByEventsSchema,
  DomainTopicsSchema,
  NEWS_TOPICS,
  ReactionStateSchema,
  CATEGORY_CODE,
  DomainPageSchema,
  InternalWatchSchema,
  MAX_REASON_PARAMS,
  NewsItemSchema,
  NewsPreferencesSchema,
  REASON_CODES,
  REASON_PARAM_KEY,
  RankItemSchema,
  RankResponseSchema,
  RecommendationReasonSchema,
  UUID_RE,
  WatchChangeSchema,
  WatchSummarySchema,
  type WatchRef,
} from "./schemas.js";
import type { DomainClient } from "./upstream.js";
import type { IdentityMe } from "./views.js";

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

export type Feature = "recommendations" | "watch" | "news";

export function featureUnavailable(feature: Feature): AppError {
  return new AppError(503, "FEATURE_UNAVAILABLE", "Функция временно недоступна", { feature });
}

// ---------------------------------------------------------------- проверка ответов

const ajv = new Ajv({ strict: false, coerceTypes: false, useDefaults: false, removeAdditional: false, allErrors: false });
const validators = new WeakMap<object, ValidateFunction>();
export function validator(schema: object): ValidateFunction {
  let fn = validators.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    validators.set(schema, fn);
  }
  return fn;
}

export class DomainResponseInvalid extends Error {
  constructor(
    readonly service: Feature,
    readonly path: string,
    readonly rule: string,
  ) {
    super(`${service} response invalid at ${path || "/"} (${rule})`);
    this.name = "DomainResponseInvalid";
  }
}

/** Значение по схеме или DomainResponseInvalid; результат — проекция (только поля схемы). */
export function strictly<T>(service: Feature, schema: object, raw: unknown): T {
  const v = scrubStrings(raw);
  const fn = validator(schema);
  if (!fn(v)) {
    const e = fn.errors?.[0];
    throw new DomainResponseInvalid(service, e?.instancePath ?? "", e?.keyword ?? "unknown");
  }
  return project(schema as never, v) as T;
}

/** Как strictly, но null вместо исключения (элементы списков). */
function orNull<T>(schema: object, raw: unknown): T | null {
  const v = scrubStrings(raw);
  return validator(schema)(v) ? (project(schema as never, v) as T) : null;
}

/** Страница домена: items (каждый проверяется отдельно), next_cursor (нет — null). */
function pageOf(service: Feature, raw: unknown): { items: unknown[]; next_cursor: string | null } {
  const p = strictly<{ items: unknown[]; next_cursor?: string | null }>(service, DomainPageSchema, raw);
  return { items: p.items, next_cursor: p.next_cursor ?? null };
}

// ---------------------------------------------------------------- общие данные пользователя

/** Предпочтения пользователя или null (preferences недоступен — персонализация деградирует, а не падает). */
export async function loadPrefs(preferences: DomainClient, userId: string): Promise<Preferences | null> {
  try {
    const p = await preferences.get<Preferences>("/internal/v1/me/preferences", { subject: userId });
    return isObj(p) ? p : null;
  } catch {
    return null;
  }
}

/** Язык и доставка пользователя (identity /me): digest_time/timezone — только проверенные значения. */
export interface UserMeta {
  lang: "ru" | "en";
  digest_time?: string;
  timezone?: string;
}

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
/** IANA-зона, которую знает среда исполнения (мусор из домена в news не уходит). */
export function isTimeZone(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(v)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

/** Язык (сбой → ru) и время дайджеста/часовой пояс из настроек уведомлений (сбой или мусор → не заданы). */
export async function loadUser(identity: DomainClient, userId: string): Promise<UserMeta> {
  try {
    const me = await identity.get<IdentityMe>("/internal/v1/me", { subject: userId });
    const out: UserMeta = { lang: me?.user?.locale === "en" ? "en" : "ru" };
    const n = isObj(me?.settings) ? (me.settings as unknown as Raw) : {};
    if (typeof n.digest_time === "string" && HHMM.test(n.digest_time)) out.digest_time = n.digest_time;
    if (isTimeZone(n.timezone)) out.timezone = n.timezone;
    return out;
  } catch {
    return { lang: "ru" };
  }
}

/** Язык пользователя (identity), сбой → ru. */
export async function loadLang(identity: DomainClient, userId: string): Promise<"ru" | "en"> {
  return (await loadUser(identity, userId)).lang;
}

const CATEGORY_RE = new RegExp(CATEGORY_CODE);
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
const cleanText = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(UNSAFE, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return s || null;
};

/** Интересы для news:feed: коды категорий и сущности (как в профиле, очищенные). */
export function interestsOf(prefs: Preferences | null): { interests: string[]; entities: string[] } {
  const cats = Array.isArray(prefs?.interests?.categories) ? prefs.interests.categories : [];
  const ents = Array.isArray(prefs?.interests?.entities) ? prefs.interests.entities : [];
  return {
    interests: [...new Set(cats.filter((c): c is string => typeof c === "string" && CATEGORY_RE.test(c)))].slice(0, 50),
    entities: [...new Set(ents.map((e) => cleanText(e, 128)).filter((e): e is string => e !== null))].slice(0, 20),
  };
}

/** Ограниченный параллелизм (fan-out к каталогу/доменам). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- последний расчёт поездки

const TIERS = new Set(["economy", "comfort", "premium"]);
const MONEY_RE = /^[0-9]{1,12}(\.[0-9]{1,2})?$/;

function lastTripOrNull(raw: string | null): LastTrip | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Raw;
    if (!isObj(t) || !TIERS.has(String(t.tier))) return null;
    if (typeof t.travellers !== "number" || !Number.isInteger(t.travellers) || t.travellers < 1 || t.travellers > 6) return null;
    const dep = t.departure_iata === null || (typeof t.departure_iata === "string" && /^[A-Z]{3}$/.test(t.departure_iata)) ? t.departure_iata : undefined;
    const hotel = t.hotel_id === null || (typeof t.hotel_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(t.hotel_id)) ? t.hotel_id : undefined;
    const nights = typeof t.extra_nights === "number" && Number.isInteger(t.extra_nights) && t.extra_nights >= 0 && t.extra_nights <= 3 ? t.extra_nights : -1;
    if (dep === undefined || hotel === undefined || nights < 0) return null;
    return {
      tier: t.tier as LastTrip["tier"],
      travellers: t.travellers,
      departure_iata: dep as string | null,
      direct_only: t.direct_only === true,
      near_venue: t.near_venue === true,
      extra_nights: nights,
      hotel_id: hotel as string | null,
      hotel_filters: tripHotelFiltersOf(t.hotel_filters as LastTrip["hotel_filters"]), // 6.3; до 6.3 — нет поля
      per_person: typeof t.per_person === "string" && MONEY_RE.test(t.per_person) ? t.per_person : null,
      at: typeof t.at === "string" ? t.at.slice(0, 40) : "",
    };
  } catch {
    return null;
  }
}

/** Последний расчёт «Поездки» пользователя по событию (Redis, TTL LAST_TRIP_TTL_DAYS). Сбой Redis — не ошибка. */
export class LastTripStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly ttlSeconds: number,
    private readonly log: FastifyBaseLogger,
  ) {}

  private key(userId: string, eventId: string): string {
    return `${this.prefix}trip:${userId}:${eventId.toLowerCase()}`;
  }

  async save(userId: string, eventId: string, trip: LastTrip): Promise<void> {
    try {
      await this.redis.set(this.key(userId, eventId), JSON.stringify(trip), "EX", this.ttlSeconds);
    } catch (err) {
      this.log.warn({ err_name: (err as Error)?.name }, "last trip save failed");
    }
  }

  async get(userId: string, eventId: string): Promise<LastTrip | null> {
    try {
      return lastTripOrNull(await this.redis.get(this.key(userId, eventId)));
    } catch (err) {
      this.log.warn({ err_name: (err as Error)?.name }, "last trip read failed");
      return null;
    }
  }

  /** trip_per_person для кандидатов ранжирования (полная сумма последнего расчёта). */
  async perPerson(userId: string, eventIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!eventIds.length) return out;
    try {
      const raws = await this.redis.mget(...eventIds.map((id) => this.key(userId, id)));
      raws.forEach((r, i) => {
        const t = lastTripOrNull(r);
        if (t?.per_person) out.set(eventIds[i]!, t.per_person);
      });
    } catch (err) {
      this.log.warn({ err_name: (err as Error)?.name }, "last trip read failed");
    }
    return out;
  }
}

// ---------------------------------------------------------------- recommendations

/** География профиля для recommendations:rank и news:feed/:topics (одинаково): уровень + очищенный код, ≤ 30. */
export function geographiesOf(prefs: Preferences): Array<{ level: string; code: string | null }> {
  return (Array.isArray(prefs.geographies) ? prefs.geographies : [])
    .filter((g) => isObj(g) && ["world", "region", "country", "city"].includes(String(g.level)))
    .map((g) => ({ level: g.level, code: cleanText(g.code, 64) }))
    .slice(0, 30);
}

export interface RankProfile {
  categories: string[];
  entities: string[];
  geographies: Array<{ level: string; code: string | null }>;
  budget: { min: string | null; max: string | null } | null;
  formats: string[];
  horizon_months: number;
  has_departure: boolean;
}

/** Профиль для ранжирования (§1.1) из предпочтений. */
export function rankProfile(prefs: Preferences): RankProfile {
  const { interests, entities } = interestsOf(prefs);
  const trip = tripProfile(prefs);
  return {
    categories: interests,
    entities,
    geographies: geographiesOf(prefs)
      .slice(0, 30),
    budget: trip.budget,
    formats: (Array.isArray(prefs.event_formats) ? prefs.event_formats : []).filter((f) => f === "offline" || f === "online"),
    horizon_months: [3, 6, 12, 24].includes(prefs.search_horizon_months) ? prefs.search_horizon_months : 12,
    has_departure: trip.departures.length > 0,
  };
}

const REASON_SET: ReadonlySet<string> = new Set(REASON_CODES);
const checkReason = validator(RecommendationReasonSchema);

/** Причина «Почему вам»: известный код, ≤ 8 параметров с латинскими ключами; иначе null (причина отбрасывается). */
export function reasonOf(raw: unknown): RecommendationReason | null {
  const v = scrubStrings(raw);
  if (!isObj(v) || typeof v.code !== "string" || !REASON_SET.has(v.code)) return null;
  if (!checkReason(v)) return null;
  const params = v.params as Record<string, string | number>;
  const keys = Object.keys(params);
  if (keys.length > MAX_REASON_PARAMS || keys.some((k) => !REASON_PARAM_KEY.test(k))) return null;
  if (Object.values(params).some((x) => typeof x === "number" && !Number.isFinite(x))) return null;
  return { code: v.code as RecommendationReason["code"], params: { ...params }, kind: v.kind as RecommendationReason["kind"] };
}

/** Ответ recommendations:rank → [event_id, Recommendation] в порядке выдачи; битый ответ — DomainResponseInvalid. */
export function sanitizeRank(raw: unknown, candidates: ReadonlySet<string>, withFactors: boolean): Array<{ event_id: string; recommendation: Recommendation }> {
  const resp = strictly<{ items: unknown[] }>("recommendations", RankResponseSchema, raw);
  const out: Array<{ event_id: string; recommendation: Recommendation }> = [];
  const seen = new Set<string>();
  resp.items.forEach((item, i) => {
    const it = orNull<Static<typeof RankItemSchema>>(RankItemSchema, item);
    if (!it) throw new DomainResponseInvalid("recommendations", `/items/${i}`, "schema");
    const id = it.event_id.toLowerCase();
    // событие не из кандидатов или повтор — ответ не по контракту
    if (!candidates.has(id) || seen.has(id)) throw new DomainResponseInvalid("recommendations", `/items/${i}/event_id`, "candidate");
    seen.add(id);
    const reasons = it.reasons.map(reasonOf).filter((r): r is RecommendationReason => r !== null).slice(0, 3);
    const rec: Recommendation = { score: Math.round(it.score * 10) / 10, reasons };
    if (withFactors) rec.factors = it.factors;
    out.push({ event_id: id, recommendation: rec });
  });
  return out;
}

export interface RankOptions {
  limit: number;
  diversity: boolean;
  withFactors: boolean;
  lang: "ru" | "en";
  /** trip_per_person по event_id (последний полный расчёт пользователя) */
  tripPerPerson?: ReadonlyMap<string, string>;
}

export class RecommendationsService {
  constructor(
    private readonly client: DomainClient | null,
    private readonly log: FastifyBaseLogger,
  ) {}

  get configured(): boolean {
    return this.client !== null;
  }

  /** Ранжирование кандидатов (≤ 100). Бросает при сбое/битом ответе — вызывающий деградирует. */
  async rank(userId: string, prefs: Preferences, cards: readonly EventCard[], o: RankOptions): Promise<Array<{ event_id: string; recommendation: Recommendation }>> {
    if (!this.client) throw featureUnavailable("recommendations");
    const candidates = cards.slice(0, 100);
    const raw = await this.client.post<unknown>("/internal/v1/recommendations:rank", {
      subject: userId,
      body: {
        profile: rankProfile(prefs),
        // first_seen_at — для причины NEW (каталог отдаёт его в списке с интеграции спринта 6; клиенту не уходит)
        candidates: candidates.map((c) => ({ ...c, trip_per_person: o.tripPerPerson?.get(c.event_id) ?? null, first_seen_at: firstSeenOf.get(c) ?? null })),
        limit: o.limit,
        diversity: o.diversity,
        lang: o.lang,
      },
    });
    return sanitizeRank(raw, new Set(candidates.map((c) => c.event_id.toLowerCase())), o.withFactors);
  }

  /** Реакция «Больше такого» / «Не интересно» (§1.2) → 204. */
  async react(userId: string, body: { event_id: string; categories: string[]; reaction: "more" | "less"; undo: boolean }): Promise<void> {
    if (!this.client) throw featureUnavailable("recommendations");
    await this.client.post("/internal/v1/reactions", { subject: userId, body });
  }

  /** Текущая реакция пользователя на событие (§1.2 GET /internal/v1/reactions/{event_id}); бросает при сбое/мусоре. */
  async reactionOf(userId: string, eventId: string): Promise<"more_like_this" | "not_interested" | null> {
    if (!this.client) throw featureUnavailable("recommendations");
    const raw = await this.client.get<unknown>(`/internal/v1/reactions/${eventId.toLowerCase()}`, { subject: userId });
    const st = strictly<Static<typeof ReactionStateSchema>>("recommendations", ReactionStateSchema, raw);
    if (st.event_id.toLowerCase() !== eventId.toLowerCase()) throw new DomainResponseInvalid("recommendations", "/event_id", "mismatch");
    return st.reaction;
  }

  /** Сбой ранжирования — в лог без значений ответа. */
  logFailure(err: unknown, where: string): void {
    const e = err as { status?: number; code?: string; path?: string; rule?: string; name?: string };
    this.log.warn(
      { upstream: "recommendations", where, upstream_status: e?.status ?? 0, upstream_code: e?.code ?? e?.name ?? "UNKNOWN", path: e?.path, rule: e?.rule },
      "recommendations unavailable, fallback order",
    );
  }
}

// ---------------------------------------------------------------- watch

export type InternalWatch = Omit<Watch, "event" | "tier" | "travellers"> & { offer_params: { tier: Watch["tier"]; travellers: number } };
export type WatchSummary = Static<typeof WatchSummarySchema>;

export const DEFAULT_DIMENSIONS: WatchDimensions = { tickets: true, price: true, flight: true, hotel: true, status: true, news: true };

/** Внутреннее слежение → Watch контракта bff.ts (event — карточка из каталога, null — нет в каталоге/каталог недоступен). */
export function publicWatch(w: InternalWatch, event: EventCard | null): Watch {
  const { offer_params, ...rest } = w;
  return { ...rest, event, tier: offer_params.tier, travellers: offer_params.travellers };
}

/** Ошибка watch → ответ Mini App: 404 WATCH_NOT_FOUND, 409 WATCH_LIMIT/VERSION_CONFLICT, 422 EVENT_PAST/VALIDATION_ERROR. */
export function mapWatchError(err: unknown): unknown {
  if (!(err instanceof AppError) || err.status >= 500) return err;
  const d = err.details ?? {};
  switch (err.status) {
    case 404:
      return err.code === "EVENT_NOT_FOUND"
        ? new AppError(404, "EVENT_NOT_FOUND", "Событие не найдено")
        : new AppError(404, "WATCH_NOT_FOUND", "Слежение не найдено");
    case 409:
      if (err.code === "WATCH_LIMIT") {
        const limit = Number(d.limit);
        return new AppError(409, "WATCH_LIMIT", "Достигнут предел слежений", Number.isInteger(limit) && limit > 0 ? { limit } : {});
      }
      if (err.code === "VERSION_CONFLICT") {
        const cur = Number(d.current_version);
        return new AppError(409, "VERSION_CONFLICT", "Слежение изменилось, обновите данные", Number.isInteger(cur) && cur >= 0 ? { current_version: cur } : {});
      }
      if (err.code === "WATCH_ENDED") return new AppError(409, "WATCH_ENDED", "Слежение завершено");
      return new AppError(409, "WATCH_CONFLICT", "Конфликт состояния слежения");
    case 422:
      if (err.code === "EVENT_PAST") return new AppError(422, "EVENT_PAST", "Событие уже прошло");
      if (err.code === "EVENT_CANCELLED") return new AppError(422, "EVENT_CANCELLED", "Событие отменено");
      return new AppError(422, "VALIDATION_ERROR", "Некорректные параметры слежения", { in: "body" });
    case 429: {
      const ra = Number(d.retry_after);
      return new AppError(429, "RATE_LIMITED", "Слишком много запросов, повторите позже", { retry_after: Number.isInteger(ra) && ra > 0 && ra <= 3600 ? ra : 60 });
    }
    default:
      // 400/401/403 домена — ошибка интеграции BFF ↔ watch, клиенту — «недоступно»
      return new AppError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен, повторите позже", { service: "watch" });
  }
}

export interface CreateWatchBody {
  event_id: string;
  offer_params: {
    tier: Watch["tier"];
    travellers: number;
    departure_iata: string | null;
    direct_only: boolean;
    near_venue: boolean;
    extra_nights: number;
    hotel_id: string | null;
    budget: { min: string | null; max: string | null } | null;
    departures: Array<{ airport_iata: string; city: string; country_code: string }>;
    flight_prefs: { direct: boolean; connecting: boolean; alternative_departure: boolean };
    /** 6.3: настройки отеля (профиль + поездка); всё по умолчанию — поля нет (старый watch не ломается) */
    hotel_filters?: HotelFilters;
  };
  dimensions?: Partial<WatchDimensions>;
  threshold_pct?: 5 | 10 | 15;
  /** снимок offers, который видел пользователь (начальная база цены; watch проверяет владельца по sub) */
  offer_id?: string;
}

/** offer_params слежения: последний расчёт «Поездки» (тариф, путешественники, вылет, прямые, рядом, ночи, отель) +
 *  бюджет, города вылета и предпочтения перелёта из профиля; расчёта не было — comfort, 1 путешественник. Явные tier/
 *  travellers запроса важнее расчёта. 6.3: настройки отеля — профиль, поверх него — «Настроить расчёт» поездки (как в
 *  offers:build): перепроверка — с теми же условиями. */
export function offerParamsOf(req: CreateWatchRequest, trip: LastTrip | null, prefs: Preferences): CreateWatchBody["offer_params"] {
  const profile = tripProfile(prefs);
  const filters = hotelFiltersOf(profile.hotel_filters, trip?.hotel_filters);
  return {
    tier: req.tier ?? trip?.tier ?? "comfort",
    travellers: req.travellers ?? trip?.travellers ?? 1,
    departure_iata: trip?.departure_iata ?? null,
    direct_only: trip?.direct_only ?? false,
    near_venue: trip?.near_venue ?? false,
    extra_nights: trip?.extra_nights ?? 0,
    hotel_id: trip?.hotel_id ?? null,
    budget: profile.budget,
    departures: profile.departures,
    flight_prefs: profile.flight_prefs,
    ...(filters ? { hotel_filters: filters } : {}),
  };
}

/** 422 старого watch только по `offer_params.hotel_filters` (loc FastAPI: ["body", "offer_params", "hotel_filters", …]). */
export function rejectsWatchFilters(err: unknown): boolean {
  if (!(err instanceof AppError) || err.status !== 422 || err.code !== "VALIDATION_ERROR") return false;
  const errors = err.details?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((e) => {
    const loc = isObj(e) && Array.isArray(e.loc) ? e.loc.map(String) : [];
    return loc[0] === "body" && loc[1] === "offer_params" && loc[2] === "hotel_filters";
  });
}

export class WatchService {
  constructor(
    private readonly client: DomainClient | null,
    private readonly createClient: DomainClient | null,
    private readonly log: FastifyBaseLogger,
  ) {}

  get configured(): boolean {
    return this.client !== null;
  }

  /** Предупреждение «watch отверг hotel_filters» — один раз на процесс. */
  private filtersWarned = false;

  private c(): DomainClient {
    if (!this.client) throw featureUnavailable("watch");
    return this.client;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapWatchError(err);
    }
  }

  private one(raw: unknown): InternalWatch {
    try {
      return strictly<InternalWatch>("watch", InternalWatchSchema, raw);
    } catch (err) {
      const e = err as DomainResponseInvalid;
      this.log.warn({ upstream: "watch", reason: "schema", path: e.path, rule: e.rule }, "watch bad response");
      throw new AppError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен, повторите позже", { service: "watch" });
    }
  }

  /** Страница: битые элементы отбрасываются (с предупреждением), битая обёртка — 503. */
  private page<T>(raw: unknown, schema: object, what: string): Page<T> {
    let p: { items: unknown[]; next_cursor: string | null };
    try {
      p = pageOf("watch", raw);
    } catch (err) {
      const e = err as DomainResponseInvalid;
      this.log.warn({ upstream: "watch", reason: "schema", path: e.path, rule: e.rule }, "watch bad response");
      throw new AppError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен, повторите позже", { service: "watch" });
    }
    const items = p.items.map((x) => orNull<T>(schema, x)).filter((x): x is T => x !== null);
    if (items.length < p.items.length) this.log.warn({ upstream: "watch", what, dropped: p.items.length - items.length }, "watch items dropped (schema)");
    return { items, next_cursor: p.next_cursor };
  }

  async create(userId: string, body: CreateWatchBody, idempotencyKey: string): Promise<{ created: boolean; watch: InternalWatch }> {
    if (!this.createClient) throw featureUnavailable("watch");
    const post = (b: CreateWatchBody) => this.createClient!.post<unknown>("/internal/v1/watches", { subject: userId, body: b, idempotencyKey });
    const env = await this.call(async () => {
      try {
        return await post(body);
      } catch (err) {
        // 6.3 (ревью): watch до 6.3 (extra="forbid") не знает offer_params.hotel_filters — один повтор без поля
        if (!body.offer_params.hotel_filters || !rejectsWatchFilters(err)) throw err;
        if (!this.filtersWarned) {
          this.filtersWarned = true;
          this.log.warn({ upstream: "watch", fields: ["offer_params.hotel_filters"] }, "watch rejected 6.3 fields: retried without them (watch not yet updated)");
        }
        const { hotel_filters: _f, ...params } = body.offer_params;
        return await post({ ...body, offer_params: params });
      }
    });
    const e = isObj(env) ? env : {};
    return { created: e.status === 201, watch: this.one(e.body) };
  }

  async list(userId: string, q: { status?: string; cursor?: string; limit?: number }): Promise<Page<InternalWatch>> {
    const raw = await this.call(() => this.c().get<unknown>("/internal/v1/watches", { subject: userId, query: { status: q.status, cursor: q.cursor, limit: q.limit } }));
    return this.page<InternalWatch>(raw, InternalWatchSchema, "watches");
  }

  async get(userId: string, watchId: string): Promise<InternalWatch> {
    const raw = await this.call(() => this.c().get<unknown>(`/internal/v1/watches/${watchId}`, { subject: userId }));
    return this.one(raw);
  }

  async patch(userId: string, watchId: string, body: Raw): Promise<InternalWatch> {
    const raw = await this.call(() => this.c().patch<unknown>(`/internal/v1/watches/${watchId}`, { subject: userId, body }));
    return this.one(raw);
  }

  async remove(userId: string, watchId: string): Promise<void> {
    await this.call(() => this.c().delete(`/internal/v1/watches/${watchId}`, { subject: userId }));
  }

  async changes(userId: string, watchId: string, q: { cursor?: string; limit?: number }): Promise<Page<WatchChange>> {
    const raw = await this.call(() =>
      this.c().get<unknown>(`/internal/v1/watches/${watchId}/changes`, { subject: userId, query: { cursor: q.cursor, limit: q.limit } }),
    );
    return this.page<WatchChange>(raw, WatchChangeSchema, "changes");
  }

  /** Сводка для Home (§2.1 watches:summary, since — UTC). Бросает при сбое. */
  async summary(userId: string, since: string): Promise<WatchSummary> {
    const raw = await this.c().get<unknown>("/internal/v1/watches:summary", { subject: userId, query: { since } });
    return strictly<WatchSummary>("watch", WatchSummarySchema, raw);
  }

  /** Какие из событий на слежении (кнопка Watch). Бросает при сбое; пустой список — без вызова. */
  async byEvents(userId: string, eventIds: readonly string[]): Promise<Map<string, WatchRef>> {
    const ids = [...new Set(eventIds.map((x) => x.toLowerCase()).filter((x) => UUID_RE.test(x)))].slice(0, 100);
    const out = new Map<string, WatchRef>();
    if (!ids.length) return out;
    const raw = await this.c().get<unknown>("/internal/v1/watches:by-events", { subject: userId, query: { ids: ids.join(",") } });
    const resp = strictly<Static<typeof ByEventsSchema>>("watch", ByEventsSchema, raw);
    const wanted = new Set(ids);
    for (const it of resp.items) {
      const id = it.event_id.toLowerCase();
      if (wanted.has(id) && !out.has(id)) out.set(id, { watch_id: it.watch_id.toLowerCase(), status: it.status });
    }
    return out;
  }
}

// ---------------------------------------------------------------- news

const checkNews = validator(NewsItemSchema);

/** Новость: строгая схема + ссылка https на домене источника (или его поддомене); иначе null. */
export function newsItemOf(raw: unknown): NewsItem | null {
  const v = scrubStrings(raw);
  if (!checkNews(v)) return null;
  const n = project(NewsItemSchema as never, v) as NewsItem;
  let host: string;
  try {
    host = new URL(n.source.url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const domain = n.source.domain.toLowerCase();
  if (host !== domain && !host.endsWith(`.${domain}`)) return null;
  return { ...n, news_id: n.news_id.toLowerCase(), event_ids: n.event_ids.map((x) => x.toLowerCase()) };
}

/** Общая часть тела news:feed и news:topics. */
export interface NewsQueryBody {
  interests: string[];
  entities: string[];
  watched_event_ids: string[];
  only_significant: boolean;
  filter: "all" | "watch" | "interests";
  /** 6.1: география preferences (как в recommendations:rank); не передаётся — preferences недоступен (news берёт
   *  сохранённую с прошлого запроса) */
  geographies?: Array<{ level: string; code: string | null }>;
  lang: "ru" | "en";
  /** настройки уведомлений пользователя (identity): дайджест новостей уходит до digest_time; нет данных — не передаются */
  digest_time?: string;
  timezone?: string;
}

/** 422 старого news (extra=forbid) на поля 6.1: все ошибки валидации — по body.geographies / body.topic. */
export function rejectsNewsFields61(err: unknown): boolean {
  if (!(err instanceof AppError) || err.status !== 422 || err.code !== "VALIDATION_ERROR") return false;
  const errors = err.details?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((e) => {
    const loc = isObj(e) && Array.isArray(e.loc) ? e.loc.map(String) : [];
    return loc[0] === "body" && (loc[1] === "geographies" || loc[1] === "topic");
  });
}

/** Тело ленты без полей 6.1 (для старого news). */
export function withoutNewsFields61(body: FeedRequest): FeedRequest {
  const { geographies: _g, topic: _t, ...rest } = body;
  return rest;
}

export interface FeedRequest extends NewsQueryBody {
  cursor: string | null;
  limit: number;
  /** 6.1: тема (чип) — корневой код интереса */
  topic?: NewsTopic;
}

export class NewsService {
  /** Предупреждение «news отверг поля 6.1, повтор без них» — один раз на процесс. */
  private retryWarned = false;

  constructor(
    private readonly client: DomainClient | null,
    private readonly log: FastifyBaseLogger,
  ) {}

  get configured(): boolean {
    return this.client !== null;
  }

  private c(): DomainClient {
    if (!this.client) throw featureUnavailable("news");
    return this.client;
  }

  private bad(err: unknown): AppError {
    const e = err as DomainResponseInvalid;
    this.log.warn({ upstream: "news", reason: "schema", path: e.path, rule: e.rule }, "news bad response");
    return new AppError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен, повторите позже", { service: "news" });
  }

  async feed(userId: string, body: FeedRequest): Promise<Page<NewsItem>> {
    const post = (b: FeedRequest) => this.c().post<unknown>("/internal/v1/news:feed", { subject: userId, body: b });
    let raw: unknown;
    try {
      raw = await post(body);
    } catch (err) {
      // старый news (extra=forbid) при выкладке 6.1: 422 только на geographies/topic — один повтор без них
      if (!rejectsNewsFields61(err) || (body.geographies === undefined && body.topic === undefined)) throw err;
      if (!this.retryWarned) {
        this.retryWarned = true;
        this.log.warn({ upstream: "news", fields: ["geographies", "topic"] }, "news rejected 6.1 feed fields: retried without them (news not yet updated)");
      }
      raw = await post(withoutNewsFields61(body));
    }
    let p: { items: unknown[]; next_cursor: string | null };
    try {
      p = pageOf("news", raw);
    } catch (err) {
      throw this.bad(err);
    }
    const seen = new Set<string>();
    const items = p.items
      .map(newsItemOf)
      .filter((n): n is NewsItem => n !== null && !seen.has(n.news_id) && !!seen.add(n.news_id))
      .slice(0, body.limit);
    if (items.length < p.items.length) this.log.warn({ upstream: "news", dropped: p.items.length - items.length }, "news items dropped (schema/source)");
    return { items, next_cursor: p.next_cursor };
  }

  /**
   * Темы новостей (6.1, news:topics): непустые темы в порядке чипов, total — вся выдача. Старый news без маршрута
   * (404 без кода) → {items: [], total: null} — Mini App прячет ряд тем. Неизвестные темы и дубли отбрасываются.
   */
  async topics(userId: string, body: NewsQueryBody): Promise<NewsTopicsResponse> {
    let raw: unknown;
    try {
      raw = await this.c().post<unknown>("/internal/v1/news:topics", { subject: userId, body });
    } catch (err) {
      // 404 без кода домена (FastAPI «нет маршрута» → UPSTREAM_ERROR) — старый news; прочие 404 — сбой интеграции
      if (err instanceof AppError && err.status === 404 && (err.code === "UPSTREAM_ERROR" || err.code === "NOT_FOUND")) {
        this.log.warn({ upstream: "news", upstream_code: err.code }, "news:topics not supported (old news), topics hidden");
        return { items: [], total: null };
      }
      if (err instanceof AppError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        this.log.warn({ upstream: "news", upstream_status: err.status, upstream_code: err.code }, "news:topics rejected");
        throw new AppError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен, повторите позже", { service: "news" });
      }
      throw err;
    }
    let resp: { items: unknown[]; total: number };
    try {
      resp = strictly<{ items: unknown[]; total: number }>("news", DomainTopicsSchema, raw);
    } catch (err) {
      throw this.bad(err);
    }
    const counts = new Map<NewsTopic, number>();
    for (const it of resp.items) {
      if (!isObj(it) || typeof it.topic !== "string" || !(NEWS_TOPICS as readonly string[]).includes(it.topic)) continue;
      const n = it.count;
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) continue;
      if (n > 0 && !counts.has(it.topic as NewsTopic)) counts.set(it.topic as NewsTopic, n);
    }
    return { items: NEWS_TOPICS.filter((t) => counts.has(t)).map((topic) => ({ topic, count: counts.get(topic)! })), total: resp.total };
  }

  async preferences(userId: string): Promise<NewsPreferences> {
    const raw = await this.c().get<unknown>("/internal/v1/news/preferences", { subject: userId });
    try {
      return strictly<NewsPreferences>("news", NewsPreferencesSchema, raw);
    } catch (err) {
      throw this.bad(err);
    }
  }

  async savePreferences(userId: string, prefs: NewsPreferences): Promise<NewsPreferences> {
    const raw = await this.c().put<unknown>("/internal/v1/news/preferences", { subject: userId, body: prefs });
    try {
      return strictly<NewsPreferences>("news", NewsPreferencesSchema, raw);
    } catch (err) {
      throw this.bad(err);
    }
  }
}

/** Настройки новостей по умолчанию (news недоступен при сборке ленты Home — не блокируем её). */
export const DEFAULT_NEWS_PREFS: NewsPreferences = { from_watch: true, by_interests: true, only_significant: false, digest: true };
