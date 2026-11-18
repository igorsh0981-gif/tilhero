/**
 * Спринт 5 — офферы (docs/sprint5/INTERNAL_API.md §5, §1.6, §2.4):
 *  - GET /admin/v1/travel/providers (dashboard.read) — состояние travel-поставщиков из provider-gateway
 *    `GET /internal/v1/providers`: строки aviasales, liteapi, osm, cbu → TravelProvidersStatus. Нет строки (старый gateway,
 *    адаптер не зарегистрирован) → configured:false. Без PROVIDER_GATEWAY_URL — 503 FEATURE_UNAVAILABLE.
 *    last_error: {code, reason, message, at, http_status} — исправление 5.1; у старого gateway (плоские
 *    last_error_code / last_error_at) reason/message/http_status = null. last_route_error: {code, location, route, at} —
 *    исправление 5.2 (поставщик не знает код места маршрута; на здоровье не влияет), у старого gateway — null.
 *  - POST /admin/v1/travel/providers/:name/probe (dashboard.read, исправление 5.1) — тестовый вызов поставщика через
 *    provider-gateway `POST /internal/v1/travel/providers/{name}:probe` с actor; 429 → 429 PROBE_RATE_LIMITED
 *    {retry_after} (+ Retry-After); маршрута нет у gateway (404/405) → 503 PROBE_UNAVAILABLE.
 *  - GET /admin/v1/offers/:offerId (support.read) — снимок предложения из offers `GET /internal/v1/offers/{id}` с actor
 *    сотрудника (offers проверяет support.read и отдаёт любой снимок + user_id). Нет снимка → 404 OFFER_NOT_FOUND.
 *    Без OFFERS_URL — 503 FEATURE_UNAVAILABLE.
 *
 * Оба ответа доменов — недоверенные данные: admin-web выводит строки, коды и ссылки как есть, поэтому BFF пропускает
 * только ожидаемые поля и форматы (коды UPPER_SNAKE, деньги — десятичная строка, время ISO, ссылки — только https без
 * учётных данных, строки — без управляющих символов и с ограничением длины). Испорченный компонент снимка (билет,
 * перелёт, отель) заменяется на `{status: "unavailable", reason: "BAD_DATA"}`, остальное показывается; испорченный
 * «скелет» снимка (offer_id, tier, даты, travellers) → 503 UPSTREAM_UNAVAILABLE {service: "offers"}.
 */
import { AppError, UpstreamError } from "@tilhero/ts-common";
import type { OfferSnapshotAdmin, TravelProviderProbe, TravelProviderStatus, TravelProvidersStatus, TravelRouteError } from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { staffOf, type App } from "../http.js";
import { requirePermission } from "../rbac.js";
import { UUID, enumOf, params } from "../schemas.js";
import { ok, OFFER_SNAPSHOT, TRAVEL_PROBE, TRAVEL_PROVIDERS } from "../responses.js";
import { upstreamUnavailable } from "../upstream.js";

export const TRAVEL_PROVIDERS_ORDER = ["aviasales", "liteapi", "osm", "cbu"] as const;
type TravelName = (typeof TRAVEL_PROVIDERS_ORDER)[number];
const BREAKER: readonly TravelProviderStatus["breaker"][] = ["closed", "open", "half_open"];

// ---------------------------------------------------------------- примитивы недоверенных данных

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const IATA_RE = /^[A-Z]{3}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const AIRLINE_RE = /^[A-Z0-9]{2,3}$/;
const FLIGHT_NO_RE = /^[A-Z0-9]{1,8}$/;
const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOTEL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const RATING_RE = /^(10(\.0{1,2})?|\d(\.\d{1,2})?)$/;
/** управляющие символы C0/C1 и bidi-переключатели (подмена порядка текста в интерфейсе) */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
export const MAX_URL = 2048;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const pick = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);
const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : null;
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** Строка без управляющих символов, схлопнутые пробелы, не длиннее max; пустая → null. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Время ISO 8601 с зоной (как отдают домены), разумной длины; иначе null. */
export function isoTime(v: unknown): string | null {
  return typeof v === "string" && v.length <= 40 && DATETIME_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

const isoDate = (v: unknown): string | null =>
  typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null;

/** Ссылка для сотрудника: только https, с хостом-доменом, без учётных данных и пробелов; иначе null. */
export function safeHttps(v: unknown): string | null {
  if (typeof v !== "string" || v.length > MAX_URL || /[\s\u0000-\u001f\u007f]/.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return null;
  return u.href;
}

// ---------------------------------------------------------------- поставщики поездок

/** Машинный код причины (upstream_400, success_false, shape, …): нижний регистр, цифры, «_», «.», «-». */
const REASON_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
/** Похоже на ключ/токен (длинная шестнадцатеричная или base64-подобная строка) — сообщение поставщика не показываем. */
const SECRETISH_RE = /[A-Fa-f0-9]{24,}|[A-Za-z0-9_-]{32,}|(token|marker|api[_-]?key|apikey)\s*[=:]/i;

/** HTTP-статус ответа поставщика (100..599) или null. */
const httpStatus = (v: unknown): number | null => int(v, 100, 599);

/** Сообщение поставщика (success_false, provider_error, upstream_4xx): без управляющих символов, ≤ 200, и не похоже на секрет — иначе null. */
export function providerMessage(v: unknown): string | null {
  const s = cleanText(v, 200);
  return s && !SECRETISH_RE.test(s) ? s : null;
}

/** Причина ошибки поставщика: {reason, message, http_status} — общая для last_error и ответа проверки. */
export function reasonOf(x: Rec): { reason: string | null; message: string | null; http_status: number | null } {
  let raw = x.reason;
  let msg = x.message;
  // допускаем и форму «success_false: <сообщение поставщика>» в одном поле reason
  if (typeof raw === "string" && /^success_false\s*:/.test(raw)) {
    msg = msg ?? raw.slice(raw.indexOf(":") + 1);
    raw = "success_false";
  }
  const reason = pick(raw, REASON_RE);
  return { reason, message: reason && MESSAGE_REASONS.test(reason) ? providerMessage(msg) : null, http_status: httpStatus(x.http_status) };
}

/** Причины, у которых gateway передаёт сообщение поставщика: success_false (Aviasales), provider_error (LiteAPI),
 *  upstream_4xx (JSON-тело с error/message). У прочих message отбрасывается. */
const MESSAGE_REASONS = /^(success_false|provider_error|upstream_4\d\d)$/;

function errorOf(x: Rec): TravelProviderStatus["last_error"] {
  // gateway 5.1: last_error {code, reason, message, at, http_status}; спринт 5: плоские last_error_code / last_error_at
  // (+ last_error_reason / last_error_http_status / last_error_message — на случай плоской формы у нового gateway)
  const nested = isRec(x.last_error) ? x.last_error : null;
  const src: Rec = nested ?? {
    code: x.last_error_code,
    at: x.last_error_at,
    reason: x.last_error_reason,
    message: x.last_error_message,
    http_status: x.last_error_http_status,
  };
  const code = pick(src.code, CODE_RE);
  if (!code) return null;
  // gateway спринта 4 отдавал только код (время — в Redis); без времени admin-web пишет «время неизвестно»
  return { code, ...reasonOf(src), at: isoTime(src.at) };
}

/** 5.2: последняя ошибка маршрута {code, location, route, at} (поставщик не знает код места) или null. */
function routeErrorOf(v: unknown): TravelRouteError | null {
  if (!isRec(v)) return null;
  const code = pick(v.code, CODE_RE);
  if (!code) return null;
  return { code, location: pick(v.location, IATA_RE), route: pick(v.route, ROUTE_RE), at: isoTime(v.at) };
}
const ROUTE_RE = /^[A-Z]{3}-[A-Z]{3}$/;

function providerRow(name: TravelName, x: Rec | undefined): TravelProviderStatus {
  if (!x)
    return { name, configured: false, enabled: false, quota: null, breaker: "closed", last_error: null, last_success_at: null, last_route_error: null };
  const q = isRec(x.quota) ? x.quota : null;
  const used = q ? int(q.day_used, 0, 1e9) : null;
  const limit = q ? int(q.day_limit, 0, 1e9) : null;
  return {
    name,
    configured: x.configured === true,
    enabled: x.enabled === true,
    quota: used !== null && limit !== null ? { day_used: used, day_limit: limit } : null,
    breaker: BREAKER.includes(x.breaker as TravelProviderStatus["breaker"]) ? (x.breaker as TravelProviderStatus["breaker"]) : "closed",
    last_error: errorOf(x),
    last_success_at: isoTime(x.last_success_at),
    last_route_error: routeErrorOf(x.last_route_error),
  };
}

/**
 * Ответ provider-gateway (список ProviderStatus или {items}) → строки aviasales, liteapi, osm, cbu в этом порядке.
 * Имя строки — `provider` (gateway) или `name`; дубли — первая строка; прочие поставщики (ticketmaster, ai_web) не нужны.
 */
export function normalizeTravelProviders(body: unknown): TravelProvidersStatus {
  const raw: unknown[] = Array.isArray(body) ? body : isRec(body) && Array.isArray(body.items) ? body.items : [];
  const rows = new Map<string, Rec>();
  for (const r of raw) {
    if (!isRec(r)) continue;
    const name = typeof r.provider === "string" ? r.provider : typeof r.name === "string" ? r.name : null;
    if (name && !rows.has(name)) rows.set(name, r);
  }
  return { items: TRAVEL_PROVIDERS_ORDER.map((n) => providerRow(n, rows.get(n))) };
}

// ---------------------------------------------------------------- снимок предложения

const TIERS = ["economy", "comfort", "premium"] as const;
const OFFER_STATUS = ["complete", "partial", "unavailable"] as const;
const MISSING = ["ticket", "flight", "hotel"] as const;
const TRIP_KINDS = ["trip", "ticket_only", "not_available"] as const;
const PRECISION = ["venue", "city"] as const;
const CHOSEN_BY = ["cheapest", "user"] as const;
const MAP_KEYS = ["yandex", "google", "osm", "dgis"] as const;
const oneOf = <T extends string>(v: unknown, xs: readonly T[]): T | null => (xs.includes(v as T) ? (v as T) : null);

/** Компонент, который не прошёл проверку: показываем честно «данные повреждены», а не выдумываем. */
export const BAD_COMPONENT = { status: "unavailable", reason: "BAD_DATA" } as const;
type Unavailable = { status: "unavailable"; reason: string };

function unavailable(x: Rec): Unavailable {
  return { status: "unavailable", reason: pick(x.reason, CODE_RE) ?? "BAD_DATA" };
}

function ticketOf(v: unknown): Rec | Unavailable {
  if (!isRec(v)) return BAD_COMPONENT;
  if (v.status === "unavailable") return unavailable(v);
  if (v.status !== "ok") return BAD_COMPONENT;
  const price = pick(v.price_per_person, MONEY_RE);
  const currency = pick(v.currency, CURRENCY_RE);
  const provider = pick(v.provider, PROVIDER_RE);
  if (!price || !currency || !provider) return BAD_COMPONENT;
  const fx = currency === "USD" ? null : fxOf(v.fx);
  return {
    status: "ok",
    price_per_person: price,
    currency,
    // 5.1: цена не в USD входит в сумму, только если пересчитана по курсу (fx); без курса — не входит
    in_total: v.in_total === true && (currency === "USD" || fx !== null),
    provider,
    deeplink: safeHttps(v.deeplink),
    fetched_at: isoTime(v.fetched_at),
    fx,
  };
}

const FX_RATE_RE = /^\d{1,9}(\.\d{1,12})?$/;
/** 5.1: пересчёт цены билета по курсу ЦБ РУз {price_per_person_usd, rate, date, source: "cbu.uz"}; иначе null. */
function fxOf(v: unknown): Rec | null {
  if (!isRec(v)) return null;
  const usd = pick(v.price_per_person_usd, MONEY_RE);
  const rate = pick(v.rate, FX_RATE_RE);
  const date = isoDate(v.date);
  if (!usd || !rate || !date || v.source !== "cbu.uz") return null;
  return { price_per_person_usd: usd, rate, date, source: "cbu.uz" };
}

function flightOf(v: unknown): Rec | Unavailable {
  if (!isRec(v)) return BAD_COMPONENT;
  if (v.status === "unavailable") return unavailable(v);
  if (v.status !== "ok") return BAD_COMPONENT;
  const origin = pick(v.origin, IATA_RE);
  const destination = pick(v.destination, IATA_RE);
  const price = pick(v.price_per_person, MONEY_RE);
  const total = pick(v.total, MONEY_RE);
  const departAt = isoTime(v.depart_at);
  if (!origin || !destination || !price || !total || !departAt) return BAD_COMPONENT;
  return {
    status: "ok",
    provider: pick(v.provider, PROVIDER_RE) ?? "aviasales",
    origin,
    destination,
    depart_at: departAt,
    return_at: isoTime(v.return_at),
    airline: pick(v.airline, AIRLINE_RE),
    flight_number: pick(v.flight_number, FLIGHT_NO_RE),
    transfers: int(v.transfers, 0, 9),
    return_transfers: int(v.return_transfers, 0, 9),
    duration_minutes: int(v.duration_minutes, 1, 10_000),
    duration_back_minutes: int(v.duration_back_minutes, 1, 10_000),
    price_per_person: price,
    total,
    deeplink: safeHttps(v.deeplink),
    fetched_at: isoTime(v.fetched_at),
    dates_shifted: v.dates_shifted === true,
  };
}

function mapOf(v: unknown): Record<string, string> | null {
  if (!isRec(v)) return null;
  const out: Record<string, string> = {};
  for (const k of MAP_KEYS) {
    const u = safeHttps(v[k]);
    if (u) out[k] = u;
  }
  return Object.keys(out).length ? out : null;
}

function hotelOf(v: unknown): Rec | Unavailable {
  if (!isRec(v)) return BAD_COMPONENT;
  if (v.status === "unavailable") return unavailable(v);
  if (v.status !== "ok") return BAD_COMPONENT;
  const name = cleanText(v.name, 200);
  const total = pick(v.total, MONEY_RE);
  if (!name || !total) return BAD_COMPONENT;
  return {
    status: "ok",
    provider: pick(v.provider, PROVIDER_RE) ?? "liteapi",
    hotel_id: pick(v.hotel_id, HOTEL_ID_RE),
    name,
    stars: int(v.stars, 0, 5),
    rating: pick(v.rating, RATING_RE),
    review_count: int(v.review_count, 0, 10_000_000),
    distance_m: int(v.distance_m, 0, 1_000_000),
    nights: int(v.nights, 1, 60),
    rooms: int(v.rooms, 1, 10),
    total,
    refundable: bool(v.refundable),
    board: cleanText(v.board, 100),
    deeplink: safeHttps(v.deeplink),
    map: mapOf(v.map),
    fetched_at: isoTime(v.fetched_at),
  };
}

function totalsOf(v: unknown): Rec | null {
  if (!isRec(v)) return null;
  const total = pick(v.total, MONEY_RE);
  const perPerson = pick(v.per_person, MONEY_RE);
  if (!total || !perPerson) return null;
  const missing = Array.isArray(v.missing) ? [...new Set(v.missing.filter((m): m is (typeof MISSING)[number] => oneOf(m, MISSING) !== null))] : [];
  return { total, per_person: perPerson, currency: "USD", missing };
}

function tripOf(v: unknown): Rec | null {
  if (!isRec(v)) return null;
  const kind = oneOf(v.kind, TRIP_KINDS);
  if (!kind) return null;
  const d = isRec(v.destination) ? v.destination : null;
  const venue = d && isRec(d.venue) ? d.venue : null;
  return {
    kind,
    reason: pick(v.reason, CODE_RE),
    destination: d
      ? {
          city: cleanText(d.city, 100),
          country_code: pick(d.country_code, COUNTRY_RE),
          iata: pick(d.iata, IATA_RE),
          venue: venue ? { name: cleanText(venue.name, 200), precision: oneOf(venue.precision, PRECISION), map: mapOf(venue.map) } : null,
        }
      : null,
    out_date: isoDate(v.out_date),
    back_date: isoDate(v.back_date),
    nights: int(v.nights, 0, 60),
  };
}

function departureOf(v: unknown): OfferSnapshotAdmin["departure"] {
  if (!isRec(v)) return null;
  const iata = pick(v.iata, IATA_RE);
  const chosen = oneOf(v.chosen_by, CHOSEN_BY);
  if (!iata || !chosen) return null;
  return { iata, city: cleanText(v.city, 100) ?? iata, chosen_by: chosen };
}

function notesOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && CODE_RE.test(x)))].slice(0, 10);
}

/**
 * Ответ offers → OfferSnapshotAdmin (offer/trip — нормализованные формы bff.Offer / OfferSetView["trip"], ссылки — только
 * https или null). null — «скелет» снимка испорчен (маршрут отвечает 503 UPSTREAM_UNAVAILABLE {service: "offers"}).
 */
export function normalizeOfferSnapshot(body: unknown, offerId: string): OfferSnapshotAdmin | null {
  if (!isRec(body) || !isRec(body.offer)) return null;
  const id = pick(body.offer_id, UUID_RE)?.toLowerCase();
  const tier = oneOf(body.tier, TIERS);
  const travellers = int(body.travellers, 1, 6);
  const createdAt = isoTime(body.created_at);
  const expiresAt = isoTime(body.expires_at);
  const userId = pick(body.user_id, UUID_RE);
  const eventId = pick(body.event_id, UUID_RE);
  if (id !== offerId.toLowerCase() || !tier || travellers === null || !createdAt || !expiresAt || !userId || !eventId) return null;
  const o = body.offer;
  const status = oneOf(o.status, OFFER_STATUS);
  const totals = totalsOf(o.totals);
  if (!status || !totals) return null;
  return {
    offer_id: id,
    user_id: userId.toLowerCase(),
    event_id: eventId.toLowerCase(),
    tier,
    travellers,
    created_at: createdAt,
    expires_at: expiresAt,
    offer: {
      offer_id: id,
      tier: oneOf(o.tier, TIERS) ?? tier,
      status,
      ticket: ticketOf(o.ticket),
      flight: flightOf(o.flight),
      hotel: hotelOf(o.hotel),
      totals,
      expires_at: isoTime(o.expires_at) ?? expiresAt,
    },
    trip: tripOf(body.trip),
    departure: departureOf(body.departure),
    notes: notesOf(body.notes),
  };
}

// ---------------------------------------------------------------- проверка поставщика (исправление 5.1)

/** Окно проверки у provider-gateway (1 раз в 30 с на поставщика); retry_after вне 1..300 → это значение. */
export const PROBE_WINDOW_S = 30;
/** Таймаут вызова проверки: тестовый запрос к поставщику (до ~20 с у медленного) + работа gateway. */
export const PROBE_TIMEOUT_MS = 25_000;
/** Имя отдельного circuit breaker проверок в клиенте provider-gateway. */
export const PROBE_BREAKER = "travel-probe";

/**
 * Ответ provider-gateway `POST …/{name}:probe` → TravelProviderProbe. null — ответ испорчен (нет ok или checked_at):
 * маршрут отвечает 503 UPSTREAM_UNAVAILABLE {service: "provider-gateway"}. ok:true — поля ошибки сбрасываются.
 */
export function normalizeProbe(body: unknown, name: TravelName): TravelProviderProbe | null {
  if (!isRec(body) || typeof body.ok !== "boolean") return null;
  const checkedAt = isoTime(body.checked_at);
  if (!checkedAt) return null;
  const latency = int(body.latency_ms, 0, 600_000);
  if (body.ok) return { name, ok: true, latency_ms: latency, code: null, reason: null, message: null, http_status: httpStatus(body.http_status), checked_at: checkedAt };
  return { name, ok: false, latency_ms: latency, code: pick(body.code, CODE_RE), ...reasonOf(body), checked_at: checkedAt };
}

export function probeRateLimited(retryAfter: unknown): AppError {
  const n = typeof retryAfter === "number" && Number.isFinite(retryAfter) ? Math.ceil(retryAfter) : NaN;
  const sec = n >= 1 && n <= 300 ? n : PROBE_WINDOW_S;
  return new AppError(429, "PROBE_RATE_LIMITED", "Проверять поставщика можно не чаще раза в 30 секунд", { retry_after: sec });
}

export function probeUnavailable(): AppError {
  return new AppError(503, "PROBE_UNAVAILABLE", "Проверка поставщика недоступна: обновите provider-gateway", { service: "provider-gateway" });
}

export function offerNotFound(): AppError {
  return new AppError(404, "OFFER_NOT_FOUND", "Снимок предложения не найден");
}

export function travelRoutes(app: App, ctx: BffContext): void {
  app.get(
    "/admin/v1/travel/providers",
    { config: requirePermission("dashboard.read"), schema: { response: ok(TRAVEL_PROVIDERS) } },
    async (req) => {
      const auth = staffOf(req);
      return normalizeTravelProviders(await ctx.domains.providerGateway.get<unknown>("/internal/v1/providers", { actor: auth.actor }));
    },
  );

  app.post<{ Params: { name: TravelName } }>(
    "/admin/v1/travel/providers/:name/probe",
    {
      config: requirePermission("dashboard.read"),
      schema: { response: ok(TRAVEL_PROBE), params: params({ name: enumOf(TRAVEL_PROVIDERS_ORDER) }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const name = req.params.name;
      let body: unknown;
      try {
        // без повторов: каждая попытка — вызов поставщика и место в окне 30 с; таймаут — с запасом на медленного
        // поставщика (gateway ждёт его сам); свой breaker — сбой проверки не закрывает GET статуса поставщиков
        body = await ctx.domains.providerGateway.post<unknown>(`/internal/v1/travel/providers/${name}:probe`, {
          actor: auth.actor,
          retries: 0,
          timeoutMs: PROBE_TIMEOUT_MS,
          breakerKey: PROBE_BREAKER,
        });
      } catch (err) {
        if (err instanceof UpstreamError && err.status === 429) throw probeRateLimited(err.details.retry_after);
        // старый gateway без маршрута проверки (404 / 405) или без поставщика cbu (PROVIDER_UNKNOWN)
        if (err instanceof UpstreamError && (err.status === 404 || err.status === 405)) throw probeUnavailable();
        throw err;
      }
      const out = normalizeProbe(body, name);
      if (!out) {
        ctx.log.warn({ upstream: "provider-gateway", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "provider probe rejected by normalization");
        throw upstreamUnavailable("provider-gateway");
      }
      return out;
    },
  );

  app.get<{ Params: { offerId: string } }>(
    "/admin/v1/offers/:offerId",
    { config: requirePermission("support.read"), schema: { response: ok(OFFER_SNAPSHOT), params: params({ offerId: UUID }) } },
    async (req) => {
      const auth = staffOf(req);
      const id = req.params.offerId.toLowerCase();
      let body: unknown;
      try {
        body = await ctx.domains.offers.get<unknown>(`/internal/v1/offers/${id}`, { actor: auth.actor });
      } catch (err) {
        // 404 домена (снимок удалён по сроку хранения или не существовал) — всегда OFFER_NOT_FOUND
        if (err instanceof UpstreamError && err.status === 404) throw offerNotFound();
        throw err;
      }
      const snap = normalizeOfferSnapshot(body, id);
      if (!snap) {
        ctx.log.warn({ upstream: "offers", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "offer snapshot rejected by normalization");
        throw upstreamUnavailable("offers");
      }
      return snap;
    },
  );
}
