/**
 * Каталог событий (event-catalog, services/events) для Mini App: вызовы /internal/v1/events и маппинг
 * EventSummary/EventDetail → EventCard/EventDetailView (packages/contracts/src/bff.ts).
 *
 * Маппинг поле-в-поле: наружу уходят только поля контракта (служебные поля каталога — dedup-ключи, verdict,
 * external_id, hidden — не копируются). Данные каталога — недоверенный ввод второго уровня: медиа без https или
 * без provenance не показываем (UI нарисует нейтральный fallback), ссылки — только https.
 *
 * Недоступность каталога (сеть, таймаут, 5xx, circuit breaker) → 503 EVENTS_UNAVAILABLE: у каталога нет stale-копии
 * (она есть только у Home). 4xx каталога (404 EVENT_NOT_FOUND, 422 по cursor) отдаются клиенту как есть.
 */
import type {
  EventCard,
  EventDetailView,
  EventFacets,
  EventLifecycleStatus,
  EventMedia,
  EventPriceRange,
  EventSort,
  EventWhen,
  Page,
  SourceTier,
} from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import type { DomainClient } from "./upstream.js";

/** Логгер для предупреждений о совместимости (только warn). */
export type LegacyLog = { warn: (obj: Record<string, unknown>, msg: string) => void };

/** Параметры поиска каталога (INTERNAL_API «GET /internal/v1/events»). */
export interface CatalogQuery {
  q?: string;
  category?: string;
  /** ISO-2 (верхний регистр); несколько стран уходят в каталог через запятую (исправление 4.1) */
  country?: string | readonly string[];
  city?: string;
  date_from?: string;
  date_to?: string;
  lifecycle?: EventLifecycleStatus[];
  has_tickets?: boolean;
  online?: boolean;
  sort?: EventSort;
  limit?: number;
  cursor?: string;
  /** спринт 6 (AT-23): только события, впервые увиденные каталогом после этого момента (UTC ISO). Каталог без
   *  поддержки параметра его игнорирует — BFF досчитывает по first_seen_at (см. HomeService.newEvents). */
  first_seen_from?: string;
}

export const EVENTS_UNAVAILABLE_MESSAGE = "Каталог событий временно недоступен, повторите позже";

export function eventsUnavailable(): AppError {
  return new AppError(503, "EVENTS_UNAVAILABLE", EVENTS_UNAVAILABLE_MESSAGE, { service: "events" });
}

/** Сбой доступности каталога (а не бизнес-ответ 4xx). */
export function isCatalogOutage(err: unknown): boolean {
  return err instanceof AppError && err.status === 503 && (err.code === "UPSTREAM_UNAVAILABLE" || err.code === "EVENTS_UNAVAILABLE");
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isCatalogOutage(err)) throw eventsUnavailable();
    throw err;
  }
}

// ---------------------------------------------------------------- маппинг

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 2048): string => (typeof v === "string" ? v.slice(0, max) : "");
const strOrNull = (v: unknown, max = 2048): string | null => (typeof v === "string" && v !== "" ? v.slice(0, max) : null);
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
/** Только https, с хостом, без userinfo (https://user:pass@host), без пробелов и кавычек. */
export function httpsOrNull(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048 || /[\s"'<>\\]/.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  return v;
}
const DECIMAL = /^[0-9]{1,12}(\.[0-9]{1,2})?$/;

const LIFECYCLE: ReadonlySet<string> = new Set<EventLifecycleStatus>([
  "DISCOVERED",
  "VERIFIED",
  "ANNOUNCED",
  "SALES_SOON",
  "ON_SALE",
  "LOW_INVENTORY",
  "SOLD_OUT",
  "RESALE",
  "COMPLETED",
  "POSTPONED",
  "CANCELLED",
]);
const TIERS: ReadonlySet<string> = new Set<SourceTier>([
  "OFFICIAL_ORGANIZER",
  "OFFICIAL_TICKET_PROVIDER",
  "TRUSTED_STRUCTURED",
  "TRUSTED_MEDIA",
  "DISCOVERY_PAGE",
]);

/** Известный статус lifecycle или null (неизвестный статус не подменяем другим — запись отбрасывается). */
const status = (v: unknown): EventLifecycleStatus | null => (typeof v === "string" && LIFECYCLE.has(v) ? (v as EventLifecycleStatus) : null);

function when(v: unknown): EventWhen {
  const w = isObj(v) ? v : {};
  return {
    local_date: str(w.local_date, 10),
    local_time: strOrNull(w.local_time, 8),
    utc: strOrNull(w.utc, 40),
    timezone: strOrNull(w.timezone, 64),
  };
}

const RIGHTS: ReadonlySet<string> = new Set<EventMedia["provenance"]["rights"]>(["provider_api", "official_organizer", "official_site"]);
const isRights = (v: unknown): v is EventMedia["provenance"]["rights"] => typeof v === "string" && RIGHTS.has(v);

/** Управляющие символы (C0/C1), bidi-переопределения и разделители строк — недоверенный текст реестра в UI не пускаем. */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** Имя источника (реестр AI-источников, спринт 4): без управляющих символов и HTML-скобок, схлопнутые пробелы, ≤ 120.
 *  Нет имени у Ticketmaster (каталог до спринта 4) → «Ticketmaster»; у прочих — null (UI покажет домен url). */
export function sourceName(v: unknown, provider: string): string | null {
  const clean = typeof v === "string" ? v.replace(UNSAFE_CHARS, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 120).trim() : "";
  if (clean) return clean;
  return provider === "ticketmaster" ? "Ticketmaster" : null;
}

/** Медиа только из источника и только с provenance (TG-FR-024, AT-25); иначе null → fallback в UI. */
export function media(v: unknown): EventMedia | null {
  if (!isObj(v) || !isObj(v.provenance)) return null;
  const url = httpsOrNull(v.url);
  const p = v.provenance;
  const sourceUrl = httpsOrNull(p.source_url);
  const provider = str(p.provider, 64);
  const fetchedAt = str(p.fetched_at, 40);
  if (!url || !sourceUrl || !provider || !fetchedAt) return null;
  if (!isRights(p.rights)) return null;
  return {
    url,
    width: intOrNull(v.width),
    height: intOrNull(v.height),
    ratio: strOrNull(v.ratio, 16),
    provenance: { provider, source_url: sourceUrl, fetched_at: fetchedAt, rights: p.rights },
  };
}

/** Цена — факт провайдера: строки-десятичные, валюта ISO 4217, источник https. Иначе не показываем. */
export function priceRange(v: unknown): EventPriceRange | null {
  if (!isObj(v) || !isObj(v.source)) return null;
  const min = str(v.min, 16);
  const max = str(v.max, 16);
  const currency = str(v.currency, 3);
  const url = httpsOrNull(v.source.url);
  const provider = str(v.source.provider, 64);
  const fetchedAt = str(v.fetched_at, 40);
  if (!DECIMAL.test(min) || !DECIMAL.test(max) || !/^[A-Z]{3}$/.test(currency) || !url || !provider || !fetchedAt) return null;
  return { min, max, currency, fetched_at: fetchedAt, source: { provider, url } };
}

// ---------------------------------------------------------------- is_past (исправление 5.1)

let isPastLegacyWarned = false;

/** Для тестов: снова предупредить о старом каталоге без is_past. */
export function resetIsPastLegacyWarning(): void {
  isPastLegacyWarned = false;
}

/**
 * Признак «событие прошло» (FEEDBACK_5_1 §A) считает каталог — BFF его только пропускает. Старый каталог без поля
 * (выкладка events позже BFF) → false и одно предупреждение на процесс; дату BFF сам не пересчитывает, чтобы не
 * расходиться с правилом каталога (часовой пояс события).
 */
export function isPastOf(e: Raw, log?: LegacyLog): boolean {
  if (typeof e.is_past === "boolean") return e.is_past;
  if (!isPastLegacyWarned && log) {
    isPastLegacyWarned = true;
    log.warn({ upstream: "events", field: "is_past", present: "is_past" in e }, "events response without boolean is_past: assuming false (events not yet updated to 5.1)");
  }
  return false;
}

function common(e: Raw, log?: LegacyLog) {
  return {
    event_id: str(e.event_id, 64),
    title: str(e.title, 300),
    categories: Array.isArray(e.categories) ? e.categories.filter((c): c is string => typeof c === "string").slice(0, 10) : [],
    start: when(e.start),
    end: isObj(e.end) ? when(e.end) : null,
    online: e.online === true,
    quality_score: typeof e.quality_score === "number" ? Math.max(0, Math.min(100, Math.round(e.quality_score))) : 0,
    price_range: priceRange(e.price_range),
    media: media(e.media),
    updated_at: str(e.updated_at, 40),
    is_past: isPastOf(e, log),
  };
}

/** EventSummary каталога → EventCard (1:1 по контракту); null — статус lifecycle неизвестен (карточка отбрасывается). */
export function toCard(raw: unknown, log?: LegacyLog): EventCard | null {
  const e = isObj(raw) ? raw : {};
  const v = isObj(e.venue) ? e.venue : null;
  const lc = isObj(e.lifecycle) ? e.lifecycle : {};
  const st = status(lc.status);
  if (!st) return null;
  return {
    ...common(e, log),
    venue: v ? { name: str(v.name, 200), city: str(v.city, 100), country_code: str(v.country_code, 2) } : null,
    lifecycle: { status: st, changed_at: str(lc.changed_at, 40) },
  };
}

/** Деталь → карточка списка (карточка события в Watch, проверка статуса продаж по слежениям). */
/**
 * Спринт 6 (интеграция): first_seen_at карточки каталога — только для кандидатов ранжирования (причина NEW в
 * recommendations); клиенту не отдаётся (карточка сериализуется по EventCard). Заполняется в search и detailToCard.
 */
export const firstSeenOf = new WeakMap<EventCard, string>();

const firstSeen = (raw: unknown): string | null =>
  isObj(raw) && typeof raw.first_seen_at === "string" && !Number.isNaN(Date.parse(raw.first_seen_at)) ? raw.first_seen_at.slice(0, 40) : null;

/** Деталь каталога — EventDetailView без полей спринта 6, которые добавляет маршрут GET /v1/events/{id}. */
export type CatalogDetail = Omit<EventDetailView, "recommendation" | "watch" | "reaction">;

export function detailToCard(d: CatalogDetail): EventCard {
  const card: EventCard = {
    event_id: d.event_id,
    title: d.title,
    categories: d.categories,
    start: d.start,
    end: d.end,
    venue: d.venue ? { name: d.venue.name, city: d.venue.city, country_code: d.venue.country_code } : null,
    online: d.online,
    lifecycle: { status: d.lifecycle.status, changed_at: d.lifecycle.changed_at },
    quality_score: d.quality_score,
    price_range: d.price_range,
    media: d.media,
    updated_at: d.updated_at,
    is_past: d.is_past,
  };
  if (firstSeen(d)) firstSeenOf.set(card, d.first_seen_at);
  return card;
}

/** Точный объект на карте (TG-FR-028): по координатам, если они есть, иначе по названию площадки и городу. */
export function fallbackMapUrl(name: string, city: string, lat: string | null, lon: string | null): string {
  const coord = /^-?\d{1,3}(\.\d+)?$/;
  if (lat && lon && coord.test(lat) && coord.test(lon)) return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${city}`)}`;
}

/** EventDetail каталога → EventDetailView. */
export function toDetail(raw: unknown, log?: LegacyLog): CatalogDetail | null {
  const e = isObj(raw) ? raw : {};
  const v = isObj(e.venue) ? e.venue : null;
  const lc = isObj(e.lifecycle) ? e.lifecycle : {};
  const st = status(lc.status);
  if (!st) return null;
  const lat = v ? strOrNull(v.lat, 32) : null;
  const lon = v ? strOrNull(v.lon, 32) : null;
  const seenSteps = new Set<string>();
  const basis = isObj(lc.basis) ? lc.basis : {};
  const mapUrl = v ? httpsOrNull(v.map_url) : null;
  return {
    ...common(e, log),
    venue: v
      ? {
          name: str(v.name, 200),
          city: str(v.city, 100),
          country_code: str(v.country_code, 2),
          address: strOrNull(v.address, 300),
          lat,
          lon,
          // карта площадки — точный объект (TG-FR-028); если каталог не дал https-ссылку — по координатам или названию
          map_url: mapUrl ?? fallbackMapUrl(str(v.name, 200), str(v.city, 100), lat, lon),
        }
      : null,
    official_url: httpsOrNull(e.official_url) ?? "",
    sources: (Array.isArray(e.sources) ? e.sources : [])
      .filter(isObj)
      .map((s) => ({
        provider: str(s.provider, 64),
        name: sourceName(s.name, str(s.provider, 64)),
        tier: (typeof s.tier === "string" && TIERS.has(s.tier) ? s.tier : "DISCOVERY_PAGE") as SourceTier,
        url: httpsOrNull(s.url) ?? "",
        fetched_at: str(s.fetched_at, 40),
      }))
      .filter((s) => s.url !== "" && s.provider !== "")
      .slice(0, 20),
    lifecycle: {
      status: st,
      changed_at: str(lc.changed_at, 40),
      basis: {
        fact: str(basis.fact, 200),
        source_url: httpsOrNull(basis.source_url),
        provider: strOrNull(basis.provider, 64),
        observed_at: str(basis.observed_at, 40),
      },
    },
    lifecycle_track: (Array.isArray(e.lifecycle_track) ? e.lifecycle_track : [])
      .filter(isObj)
      .map((s) => ({ status: status(s.status), reached: s.reached === true, current: s.current === true }))
      // неизвестные шаги трека отбрасываем, дубли статуса — тоже (ключ шага в UI — статус)
      .filter((s): s is { status: EventLifecycleStatus; reached: boolean; current: boolean } => s.status !== null && !seenSteps.has(s.status) && !!seenSteps.add(s.status))
      .slice(0, 12),
    media_all: (Array.isArray(e.media_all) ? e.media_all : [])
      .map(media)
      .filter((m): m is EventMedia => m !== null)
      .slice(0, 10),
    first_seen_at: str(e.first_seen_at, 40),
  };
}

// ---------------------------------------------------------------- facets (исправление 4.1)

/** Фильтры счётчиков — те же, что у поиска, без sort/limit/cursor/lifecycle. */
export type FacetsQuery = Pick<CatalogQuery, "q" | "category" | "city" | "date_from" | "date_to" | "has_tickets" | "online"> & {
  country?: readonly string[];
  /** окно this_month (чип «В этом месяце» в календаре пользователя), YYYY-MM-DD; оба или ни одного */
  month_from?: string;
  month_to?: string;
};

/** Ключи словарей facets: корневой код таксономии (или other) и ISO-2; лишнее/битое отбрасываем. */
const ROOT_CATEGORY = /^[a-z][a-z_]{0,31}$/;
const ISO2 = /^[A-Z]{2}$/;
const MAX_FACET_KEYS = 300;

const facetCount = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);

function facetMap(v: unknown, keyOk: RegExp, upper = false): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(v)) return out;
  let n = 0;
  for (const [k0, raw] of Object.entries(v)) {
    const k = upper ? k0.toUpperCase() : k0;
    if (!keyOk.test(k) || Object.prototype.hasOwnProperty.call(out, k)) continue;
    out[k] = facetCount(raw);
    if (++n >= MAX_FACET_KEYS) break;
  }
  return out;
}

/** Ответ каталога `GET /internal/v1/events:facets` → EventFacets: только поля контракта, счётчики — целые ≥ 0. */
export function toFacets(raw: unknown): EventFacets {
  const f = isObj(raw) ? raw : {};
  return {
    total: facetCount(f.total),
    this_month: facetCount(f.this_month),
    has_tickets: facetCount(f.has_tickets),
    online: facetCount(f.online),
    categories: facetMap(f.categories, ROOT_CATEGORY),
    countries: facetMap(f.countries, ISO2, true),
  };
}

const countryParam = (c: CatalogQuery["country"]): string | undefined =>
  c === undefined ? undefined : typeof c === "string" ? c : c.length ? c.join(",") : undefined;

// ---------------------------------------------------------------- вызовы каталога

export class EventsCatalog {
  constructor(
    private readonly client: DomainClient,
    private readonly log?: LegacyLog,
  ) {}

  async search(q: CatalogQuery): Promise<Page<EventCard>> {
    const page = await guarded(() =>
      this.client.get<{ items?: unknown[]; next_cursor?: unknown }>("/internal/v1/events", {
        query: {
          q: q.q,
          category: q.category,
          country: countryParam(q.country),
          city: q.city,
          date_from: q.date_from,
          date_to: q.date_to,
          lifecycle: q.lifecycle?.length ? q.lifecycle.join(",") : undefined,
          has_tickets: q.has_tickets,
          online: q.online,
          sort: q.sort,
          limit: q.limit,
          cursor: q.cursor,
          first_seen_from: q.first_seen_from,
        },
      }),
    );
    const items: EventCard[] = [];
    for (const raw of Array.isArray(page?.items) ? page.items.slice(0, 50) : []) {
      const card = toCard(raw, this.log);
      if (!card) continue;
      const fs = firstSeen(raw);
      if (fs) firstSeenOf.set(card, fs);
      items.push(card);
    }
    return { items, next_cursor: typeof page?.next_cursor === "string" && page.next_cursor ? page.next_cursor : null };
  }

  /** Новые события (sort=newest) с first_seen_at, если каталог его отдаёт в списке (иначе null — BFF уточнит по детали). */
  async newest(q: Omit<CatalogQuery, "sort">): Promise<Array<{ card: EventCard; first_seen_at: string | null }>> {
    const page = await guarded(() =>
      this.client.get<{ items?: unknown[] }>("/internal/v1/events", {
        query: {
          category: q.category,
          country: countryParam(q.country),
          sort: "newest",
          limit: q.limit,
          first_seen_from: q.first_seen_from,
        },
      }),
    );
    const out: Array<{ card: EventCard; first_seen_at: string | null }> = [];
    for (const raw of Array.isArray(page?.items) ? page.items.slice(0, 50) : []) {
      const card = toCard(raw, this.log);
      if (!card) continue;
      const fs = firstSeen(raw);
      if (fs) firstSeenOf.set(card, fs);
      out.push({ card, first_seen_at: fs });
    }
    return out;
  }

  /** Счётчики быстрых фильтров (event-catalog `GET /internal/v1/events:facets`, те же параметры фильтра). */
  async facets(q: FacetsQuery): Promise<EventFacets> {
    const raw = await guarded(() =>
      this.client.get<unknown>("/internal/v1/events:facets", {
        query: {
          q: q.q,
          category: q.category,
          country: countryParam(q.country),
          city: q.city,
          date_from: q.date_from,
          date_to: q.date_to,
          has_tickets: q.has_tickets,
          online: q.online,
          month_from: q.month_from,
          month_to: q.month_to,
        },
      }),
    );
    return toFacets(raw);
  }

  async get(eventId: string): Promise<CatalogDetail> {
    const raw = await guarded(() => this.client.get<unknown>(`/internal/v1/events/${encodeURIComponent(eventId)}`));
    const d = toDetail(raw, this.log);
    // статус lifecycle, неизвестный контракту, не показываем (и не подменяем) — для клиента события нет
    if (!d) throw new AppError(404, "EVENT_NOT_FOUND", "Событие не найдено");
    return d;
  }
}
