/**
 * Предложения поездки под событие (спринт 5, INTERNAL_API §4): Mini App → BFF → offers `POST /internal/v1/offers:build`.
 *
 * - departures и flight_prefs — из preferences пользователя (как профиль), язык — из identity (сбой → ru);
 * - ответ offers — недоверенные данные: строки чистятся от управляющих символов, необязательные ссылки (фото отеля,
 *   сайт места) не-https → null, элементы списков «Отели рядом»/«Рядом с площадкой», не прошедшие схему, отбрасываются,
 *   неизвестные коды notes — тоже; остальное обязано пройти схему OfferSetView целиком (ссылки только https, длины,
 *   деньги — строки-десятичные), иначе 503 OFFERS_UNAVAILABLE. Лишние поля удаляются (Value.Clean), наружу —
 *   сериализация по схеме;
 * - ошибки offers: 404 → 404 EVENT_NOT_FOUND; 422 → 422 (OFFER_DEPARTURE_INVALID как есть, прочее — VALIDATION_ERROR);
 *   429 → 429 RATE_LIMITED {retry_after}; 5xx, таймаут, недоступность, ошибка внутренней авторизации, мусор → 503
 *   OFFERS_UNAVAILABLE. Деталь события от этого не зависит — это отдельный запрос Mini App;
 * - снимок для обращения в поддержку: `GET /internal/v1/offers/{id}` с sub — только свой снимок.
 *
 * Исправление 5.1 (FEEDBACK_5_1 §B): в offers:build уходит `budget` из профиля (USD на человека, строки с 2 знаками;
 * нет бюджета → null) и `overrides.hotel_id`. Ответ: budget/recommended_tier/hotel_chosen_by, у тарифа и отеля рядом —
 * budget_fit/over_by, у отеля рядом — per_person_share; у билета — fx (пересчёт по курсу ЦБ, note TICKET_FX_CONVERTED). Старый offers (полей нет) — значения по умолчанию
 * (null / "rules" / "unknown", ticket.fx: null, per_person_share = price_total / travellers, банковское округление) и одно предупреждение
 * в лог; присланные поля проверяются строго (over_by только при over, budget.min ≤ max).
 */
import type { FastifyBaseLogger } from "fastify";
import type { OfferHotelFilters, OfferKeepHotels, OfferRecalculateRequest, OfferSetView, Preferences, TripBudget } from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import { Ajv, type ValidateFunction } from "ajv";
import {
  HTTPS_URL_PATTERN,
  MAX_HOTELS_NEARBY,
  MAX_POI,
  NearbyHotelSchema,
  NearbyPoiSchema,
  OFFER_NOTES,
  OfferSetViewSchema,
  UUID_RE,
} from "./schemas.js";
import type { DomainClient } from "./upstream.js";
import type { IdentityMe } from "./views.js";

export const OFFERS_UNAVAILABLE_MESSAGE = "Расчёт поездки временно недоступен, повторите позже";

export function offersUnavailable(): AppError {
  return new AppError(503, "OFFERS_UNAVAILABLE", OFFERS_UNAVAILABLE_MESSAGE, { service: "offers" });
}

const eventNotFound = () => new AppError(404, "EVENT_NOT_FOUND", "Событие не найдено");

/** Тело offers:build (INTERNAL_API §2.1). */
export interface BuildRequest {
  event_id: string;
  travellers: number;
  departures: Array<{ airport_iata: string; city: string; country_code: string }>;
  flight_prefs: { direct: boolean; connecting: boolean; alternative_departure: boolean };
  overrides: {
    departure_iata: string | null;
    direct_only: boolean;
    near_venue: boolean;
    extra_nights: number;
    hotel_id?: string; // 5.1: только если выбран (null/не задан — поле не отправляется)
    keep_hotels?: OfferKeepHotels; // 5.2: отели тарифов прошлого расчёта; только непустой и без hotel_id
  };
  budget?: TripBudget; // 5.1: USD на 1 человека за поездку, из профиля; нет бюджета — поле не отправляется
  hotel_filters?: HotelFilters; // 6.3: профиль + «Настроить расчёт» поездки; всё по умолчанию — поле не отправляется
  lang: "ru" | "en";
}

/** 6.3: настройки отеля для offers:build (профиль, поверх него — поездка); null в поле — по умолчанию. */
export interface HotelFilters {
  rating_min: number | null;
  max_distance_km: number | null;
  min_stars: number | null;
}

/** Переопределения пересчёта до сборки тела: hotel_id null — подбор по правилам. */
export type Overrides = Omit<BuildRequest["overrides"], "hotel_id" | "keep_hotels"> & {
  hotel_id: string | null;
  keep_hotels: OfferKeepHotels | null;
  /** 6.3: настройки отеля только для этой поездки (поверх профиля); null — как в профиле */
  hotel_filters: OfferHotelFilters | null;
};

/** Снимок предложения (INTERNAL_API §2.4) — только поля, которые BFF использует. */
export interface OfferSnapshot {
  offer_id: string;
  event_id: string;
  created_at: string;
  offer: {
    tier?: unknown;
    ticket?: Record<string, unknown>;
    flight?: Record<string, unknown>;
    hotel?: Record<string, unknown>;
    totals?: Record<string, unknown>;
  };
}

/** Без overrides (GET): нейтральные значения — тот же params_hash, что и у пересчёта без изменений. */
export const NO_OVERRIDES: Overrides = {
  departure_iata: null,
  direct_only: false,
  near_venue: false,
  extra_nights: 0,
  hotel_id: null,
  keep_hotels: null,
  hotel_filters: null,
};

export function overridesOf(body: OfferRecalculateRequest): Overrides {
  return {
    departure_iata: body.departure_iata ?? null,
    direct_only: body.direct_only ?? false,
    near_venue: body.near_venue ?? false,
    extra_nights: body.extra_nights ?? 0,
    hotel_id: body.hotel_id ?? null,
    keep_hotels: keepHotelsOf(body.keep_hotels),
    hotel_filters: tripHotelFiltersOf(body.hotel_filters),
  };
}

// ---------------------------------------------------------------- настройки отеля (6.3)

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isRating = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10 && Math.abs(v * 10 - Math.round(v * 10)) < 1e-9;

/** Поездка: только заданные поля (null / нет — как в профиле); пусто → null (тот же params_hash, что без поля). */
export function tripHotelFiltersOf(f: OfferHotelFilters | null | undefined): OfferHotelFilters | null {
  if (!isObj(f)) return null;
  const out: OfferHotelFilters = {};
  if (isRating(f.rating_min)) out.rating_min = f.rating_min;
  if (isInt(f.max_distance_km, 1, 20)) out.max_distance_km = f.max_distance_km;
  if (isInt(f.min_stars, 0, 5)) out.min_stars = f.min_stars;
  return Object.keys(out).length ? out : null;
}

/** Профиль (preferences.hotel_prefs, недоверенный) + поездка → hotel_filters offers:build; всё по умолчанию → null
 *  (поле не отправляется: старый offers не ломается, хэш параметров прежний). Звёзды 0 («любые») — как null. */
export function hotelFiltersOf(profile: unknown, trip: OfferHotelFilters | null | undefined): HotelFilters | null {
  const p = isObj(profile) ? (profile as Raw) : {};
  const t = tripHotelFiltersOf(trip) ?? {};
  const rating = t.rating_min ?? (isRating(p.rating_min) ? p.rating_min : null);
  const distance = t.max_distance_km ?? (isInt(p.max_distance_km, 1, 20) ? p.max_distance_km : null);
  const stars = (t.min_stars ?? (isInt(p.min_stars, 0, 5) ? p.min_stars : null)) || null;
  return rating === null && distance === null && stars === null ? null : { rating_min: rating, max_distance_km: distance, min_stars: stars };
}

const TIER_KEYS = ["economy", "comfort", "premium"] as const;

/** 5.2: только заданные тарифы; пусто → null (расчёт по правилам, тот же params_hash, что без поля). */
export function keepHotelsOf(k: OfferKeepHotels | null | undefined): OfferKeepHotels | null {
  if (!k) return null;
  const out: OfferKeepHotels = {};
  for (const t of TIER_KEYS) if (typeof k[t] === "string" && k[t]) out[t] = k[t];
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------- совместимость запроса со старым offers (5.1)

type NewField = "budget" | "hotel_id" | "keep_hotels" | "hotel_filters";

/**
 * 422 старого offers (extra="forbid") на новые поля: все ошибки валидации — по `budget`, `overrides.hotel_id` (5.1) или
 * `overrides.keep_hotels` (5.2) (loc FastAPI: ["body", "budget", …] / ["body", "overrides", "hotel_id"]). Возвращает
 * отвергнутые поля — запрос повторяется без них (остальные новые поля остаются); иначе null.
 */
export function rejectedNewFields(err: unknown): Set<NewField> | null {
  if (!(err instanceof AppError) || err.status !== 422 || err.code !== "VALIDATION_ERROR") return null;
  const errors = err.details?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const out = new Set<NewField>();
  for (const e of errors) {
    const loc = isObj(e) && Array.isArray(e.loc) ? e.loc.map(String) : [];
    if (loc[0] === "body" && (loc[1] === "budget" || loc[1] === "hotel_filters")) out.add(loc[1]);
    else if (loc[0] === "body" && loc[1] === "overrides" && (loc[2] === "hotel_id" || loc[2] === "keep_hotels")) out.add(loc[2]);
    else return null;
  }
  return out;
}

/** Совместимость: 422 только по новым полям (5.1 / 5.2). */
export const rejectsFields51 = (err: unknown): boolean => rejectedNewFields(err) !== null;

/** Тело без отвергнутых новых полей (для старого offers); по умолчанию — без всех полей 5.1 и 5.2. */
export function withoutFields51(body: BuildRequest, fields: ReadonlySet<NewField> = new Set<NewField>(["budget", "hotel_id", "keep_hotels", "hotel_filters"])): BuildRequest {
  const { budget, hotel_filters: filters, overrides, ...rest } = body;
  const { hotel_id, keep_hotels, ...ov } = overrides;
  return {
    ...rest,
    overrides: { ...ov, ...(hotel_id !== undefined && !fields.has("hotel_id") ? { hotel_id } : {}), ...(keep_hotels !== undefined && !fields.has("keep_hotels") ? { keep_hotels } : {}) },
    ...(budget !== undefined && !fields.has("budget") ? { budget } : {}),
    ...(filters !== undefined && !fields.has("hotel_filters") ? { hotel_filters: filters } : {}),
  };
}

/** Есть ли в теле хоть одно из отвергнутых полей (иначе повтор ничего не изменит). */
const hasAny = (b: BuildRequest, f: ReadonlySet<NewField>): boolean =>
  (f.has("budget") && b.budget !== undefined) ||
  (f.has("hotel_id") && b.overrides.hotel_id !== undefined) ||
  (f.has("keep_hotels") && b.overrides.keep_hotels !== undefined) ||
  (f.has("hotel_filters") && b.hotel_filters !== undefined);

// ---------------------------------------------------------------- бюджет (5.1)

/** Границы пресетов — как BUDGET_PRESETS в services/preferences (domain/validation.py), USD на человека. */
export const BUDGET_PRESETS: Readonly<Record<string, readonly [number, number]>> = {
  under_500: [0, 500],
  "500_1000": [500, 1000],
  "1000_2000": [1000, 2000],
  "2000_5000": [2000, 5000],
};
/** Предел offers (BudgetIn: ≤ 1 000 000); больше — бюджет не передаём, а не 422 на каждом расчёте. */
const BUDGET_LIMIT = 1_000_000;
const usd = (n: unknown): string | null =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= BUDGET_LIMIT ? `${n}.00` : null;

/**
 * Бюджет профиля → TripBudget для offers. Пресет — границы из таблицы (нижняя граница 0 = «без нижней» → null);
 * custom → {min: null, max: custom_amount}; произвольный диапазон без пресета — min/max профиля; нет бюджета или
 * мусор → null (расчёт без бюджета, а не ошибка).
 */
export function tripBudget(raw: unknown): TripBudget | null {
  if (!isObj(raw)) return null;
  if (raw.currency !== undefined && raw.currency !== "USD") return null;
  let lo: unknown;
  let hi: unknown;
  if (raw.preset === "custom") {
    lo = null;
    hi = raw.custom_amount;
  } else if (typeof raw.preset === "string" && Object.prototype.hasOwnProperty.call(BUDGET_PRESETS, raw.preset)) {
    [lo, hi] = BUDGET_PRESETS[raw.preset]!;
  } else if (raw.preset === null || raw.preset === undefined) {
    lo = raw.min;
    hi = raw.max;
  } else {
    return null; // неизвестный пресет — границы не выдумываем
  }
  const min = lo === 0 ? null : usd(lo);
  const max = usd(hi);
  if (max === "0.00") return null;
  if ((lo !== null && lo !== undefined && lo !== 0 && min === null) || (hi !== null && hi !== undefined && max === null)) return null;
  if (min === null && max === null) return null;
  if (min !== null && max !== null && (lo as number) >= (hi as number)) return null;
  return { min, max };
}

/** Деньги-строка → центы (BigInt); null — не деньги. */
function cents(v: unknown): bigint | null {
  if (typeof v !== "string" || !MONEY_RE.test(v)) return null;
  const [i, f = ""] = v.split(".");
  return BigInt(i!) * 100n + BigInt((f + "00").slice(0, 2));
}

/** amount / n с банковским округлением (половина — к чётному) до центов, строкой "X.YY"; null — не деньги/n. */
export function divMoney(amount: unknown, n: unknown): string | null {
  const c = cents(amount);
  if (c === null || typeof n !== "number" || !Number.isInteger(n) || n < 1) return null;
  const d = BigInt(n);
  let q = c / d;
  const r2 = (c % d) * 2n;
  if (r2 > d || (r2 === d && q % 2n === 1n)) q += 1n;
  return `${q / 100n}.${(q % 100n).toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------- очистка недоверенного ответа

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** Управляющие символы (C0/C1), zero-width, bidi-переопределения, разделители строк (как в events.ts). */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
/** Предел длины любой строки до проверки схемой (схема всё равно ограничит точнее). */
const MAX_RAW_STRING = 4096;
const MAX_DEPTH = 12;

/** Глубокая копия JSON с чисткой строк; слишком глубокая вложенность → null (схема её отвергнет). Ссылки с
 *  управляющими символами после чистки содержат пробел и не проходят шаблон https — отбрасываются, а не «чинятся». */
export function scrubStrings(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof v === "string") return v.length > MAX_RAW_STRING ? v : v.replace(UNSAFE_CHARS, " ").replace(/ {2,}/g, " ").trim();
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => scrubStrings(x, depth + 1));
  if (isObj(v)) {
    const out: Raw = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = scrubStrings(x, depth + 1);
    }
    return out;
  }
  return v;
}

const HTTPS_RE = new RegExp(HTTPS_URL_PATTERN);
const MONEY_RE = /^[0-9]{1,12}(\.[0-9]{1,2})?$/;
export const isHttpsUrl = (v: unknown): v is string => typeof v === "string" && v.length <= 2048 && HTTPS_RE.test(v);

/** Домены ссылок на перелёт, с поддоменами — копия packages/contracts/link-domains.json (`flight`, общий список всех
 *  звеньев; 7.2: + aviasales.tp.st — короткая партнёрская ссылка Travelpayouts). Сверку проверяет тест. */
export const FLIGHT_LINK_DOMAINS = ["aviasales.com", "aviasales.ru", "aviasales.kz", "tp.media", "aviasales.tp.st"] as const;

/** Сайт Aviasales — куда в итоге ведёт любая ссылка на перелёт, в том числе партнёрский редирект (ревью 7.2). */
const AVIASALES_DOMAINS = ["aviasales.com", "aviasales.ru", "aviasales.kz"] as const;

/** Хост без точки в конце, в нижнем регистре; пустые метки — null. */
function cleanHost(raw: string): string | null {
  let h = raw.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  return !h || h.startsWith(".") || h.endsWith(".") || h.includes("..") ? null : h;
}
const hostIn = (h: string, list: readonly string[]): boolean => list.some((d) => h === d || h.endsWith(`.${d}`));

/** https без userinfo, порт 443 или без порта, без пробелов и кавычек, ≤ 2048 → URL с чистым хостом, иначе null. */
function parseHttps(v: unknown): URL | null {
  if (typeof v !== "string" || !v || v.length > 2048 || /[\s\u0000-\u001f\u007f\\<>"'`]/.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const host = cleanHost(u.hostname);
  if (u.protocol !== "https:" || !host || u.username || u.password || (u.port !== "" && u.port !== "443")) return null;
  u.hostname = host;
  return u;
}

/** Параметр с целью редиректа: `u` у tp.media, `url` у aviasales.*\/redirect; null — ссылка не редирект. */
function redirectParam(u: URL): string | null {
  if (hostIn(u.hostname, ["tp.media"])) return "u";
  if (hostIn(u.hostname, AVIASALES_DOMAINS) && (u.pathname === "/redirect" || u.pathname.startsWith("/redirect/"))) return "url";
  return null;
}

/**
 * Ссылка на перелёт для пользователя (как tilhero_common.links.flight_link): https, хост из FLIGHT_LINK_DOMAINS (с
 * поддоменами), без точки в конце и в нижнем регистре. Редирект (tp.media/r?u=…, aviasales.*\/redirect?url=…) —
 * только если цель (ровно один параметр) — страница сайта Aviasales. Иначе null.
 */
export function flightLink(v: unknown): string | null {
  const u = parseHttps(v);
  if (!u || !hostIn(u.hostname, FLIGHT_LINK_DOMAINS)) return null;
  const param = redirectParam(u);
  if (param) {
    const targets = u.searchParams.getAll(param);
    const t = targets.length === 1 ? parseHttps(targets[0]) : null;
    if (!t || !hostIn(t.hostname, AVIASALES_DOMAINS) || redirectParam(t)) return null;
  }
  return u.toString();
}

/** search_url перелёта (5.2): ссылка, которую принимает `flightLink`. */
export function isFlightSearchUrl(v: unknown): v is string {
  return isHttpsUrl(v) && flightLink(v) !== null;
}

/** Необязательная ссылка: не-https → null (элемент остаётся). */
function nullUnlessHttps(o: unknown, key: string): void {
  if (isObj(o) && key in o && o[key] !== null && !isHttpsUrl(o[key])) o[key] = null;
}

// Отдельный Ajv: без приведения типов, без значений по умолчанию, без удаления полей — только проверка.
const ajv = new Ajv({ strict: false, coerceTypes: false, useDefaults: false, removeAdditional: false, allErrors: false });
const validators = new WeakMap<object, ValidateFunction>();
function validator(schema: object): ValidateFunction {
  let fn = validators.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    validators.set(schema, fn);
  }
  return fn;
}
const checkSet = validator(OfferSetViewSchema);
const checkHotel = validator(NearbyHotelSchema);
const checkPoi = validator(NearbyPoiSchema);
const NOTES: ReadonlySet<string> = new Set(OFFER_NOTES);

export class OfferResponseInvalid extends Error {
  constructor(readonly path: string, readonly rule: string) {
    super(`offers response invalid at ${path || "/"} (${rule})`);
    this.name = "OfferResponseInvalid";
  }
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
}

/** Проекция уже проверенного значения на схему: остаются только объявленные поля (лишние поля offers не уходят
 *  дальше); у anyOf — первая подходящая ветка (как fast-json-stringify). */
export function project(schema: JsonSchema, v: unknown): unknown {
  if (schema.anyOf) {
    const branch = schema.anyOf.find((s) => validator(s as object)(v));
    return branch ? project(branch, v) : v;
  }
  if (Array.isArray(v)) return schema.items ? v.map((x) => project(schema.items!, x)) : v;
  if (isObj(v) && schema.properties) {
    const out: Raw = {};
    for (const [k, s] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = project(s, v[k]);
    }
    return out;
  }
  return v;
}

/** budget_fit/over_by согласованы: over_by — только при over (и обязателен при нём); 6.1: «без учёта …» — только при
 *  известной пометке (within / over). */
const budgetFitConsistent = (o: Raw): boolean =>
  (o.budget_fit === "over") === (o.over_by !== null && o.over_by !== undefined) &&
  !(o.budget_fit === "unknown" && Array.isArray(o.budget_excludes) && o.budget_excludes.length > 0);

/** Поле отсутствует (старый offers до 5.1) → значение по умолчанию; имя поля — в legacy. Присланное не трогаем. */
function fill(o: Raw, key: string, value: () => unknown, legacy: Set<string>, label: string): void {
  if (Object.prototype.hasOwnProperty.call(o, key)) return;
  o[key] = value();
  legacy.add(label);
}

/** Значения по умолчанию для ответа offers без полей 5.1 (обратная совместимость при выкладке). */
function fillLegacyDefaults(v: Raw, legacy: Set<string>): void {
  fill(v, "budget", () => null, legacy, "budget");
  fill(v, "recommended_tier", () => null, legacy, "recommended_tier");
  fill(v, "hotel_chosen_by", () => "rules", legacy, "hotel_chosen_by");
  fill(v, "hotel_search", () => null, legacy, "hotel_search"); // 6.1
  if (isObj(v.hotel_search)) {
    // 6.3: offers до настроек отеля — звёзды любые, база по умолчанию
    fill(v.hotel_search, "min_stars", () => null, legacy, "hotel_search.min_stars");
    fill(v.hotel_search, "base_min_stars", () => null, legacy, "hotel_search.base_min_stars");
    fill(v.hotel_search, "from_prefs", () => false, legacy, "hotel_search.from_prefs");
  }
  if (isObj(v.tiers)) {
    for (const tier of Object.values(v.tiers)) {
      if (!isObj(tier)) continue;
      fill(tier, "budget_fit", () => "unknown", legacy, "tiers.budget_fit");
      fill(tier, "over_by", () => null, legacy, "tiers.over_by");
      fill(tier, "budget_excludes", () => [], legacy, "tiers.budget_excludes"); // 6.1
      // 5.1: билет без пересчёта по курсу ЦБ (старый offers)
      if (isObj(tier.ticket) && tier.ticket.status === "ok") fill(tier.ticket, "fx", () => null, legacy, "tiers.ticket.fx");
    }
  }
  if (Array.isArray(v.hotels_nearby)) {
    for (const h of v.hotels_nearby) {
      if (!isObj(h)) continue;
      fill(h, "budget_fit", () => "unknown", legacy, "hotels_nearby.budget_fit");
      fill(h, "over_by", () => null, legacy, "hotels_nearby.over_by");
      fill(h, "budget_excludes", () => [], legacy, "hotels_nearby.budget_excludes"); // 6.1
      // не посчитать (битая цена/travellers) — поле остаётся пустым, элемент не пройдёт схему и будет отброшен
      fill(h, "per_person_share", () => divMoney(h.price_total, v.travellers) ?? undefined, legacy, "hotels_nearby.per_person_share");
      if (h.per_person_share === undefined) delete h.per_person_share;
    }
  }
}

/**
 * Недоверенный ответ offers → OfferSetView или OfferResponseInvalid. Мутирует только свою глубокую копию.
 * eventId — запрошенное событие: набор для другого события не отдаётся. legacy (необязательно) — сюда попадают имена
 * полей 5.1, которых не было в ответе (старый offers).
 */
export function sanitizeOfferSet(raw: unknown, eventId: string, legacy: Set<string> = new Set()): OfferSetView {
  const v = scrubStrings(raw);
  if (!isObj(v)) throw new OfferResponseInvalid("", "type");
  fillLegacyDefaults(v, legacy);

  // тарифы: фото отеля не-https → null; search_url (5.2) — только у перелёта ROUTE_NOT_SUPPORTED на домене Aviasales
  if (isObj(v.tiers)) {
    for (const tier of Object.values(v.tiers)) {
      if (!isObj(tier)) continue;
      nullUnlessHttps(tier.hotel, "photo_url");
      for (const key of ["ticket", "flight", "hotel"] as const) {
        const c = tier[key];
        if (!isObj(c) || !("search_url" in c)) continue;
        const link = key === "flight" && c.status === "unavailable" && c.reason === "ROUTE_NOT_SUPPORTED" ? flightLink(c.search_url) : null;
        if (link) c.search_url = link;
        else delete c.search_url;
      }
    }
  }
  // списки: битый элемент отбрасывается, а не ломает весь ответ
  if (Array.isArray(v.hotels_nearby)) {
    v.hotels_nearby = v.hotels_nearby
      .map((h) => {
        nullUnlessHttps(h, "photo_url");
        return h;
      })
      .filter((h) => checkHotel(h) && budgetFitConsistent(h as Raw))
      .slice(0, MAX_HOTELS_NEARBY);
  }
  if (Array.isArray(v.poi)) {
    v.poi = v.poi
      .map((p) => {
        nullUnlessHttps(p, "website");
        return p;
      })
      .filter((p) => checkPoi(p))
      .slice(0, MAX_POI);
  }
  // неизвестные коды заметок (новая версия offers) — без них, а не 503
  if (Array.isArray(v.notes)) v.notes = [...new Set(v.notes.filter((n): n is string => typeof n === "string" && NOTES.has(n)))];

  if (!checkSet(v)) {
    const first = checkSet.errors?.[0];
    throw new OfferResponseInvalid(first?.instancePath ?? "", first?.keyword ?? "unknown");
  }
  // 5.1: согласованность бюджета — пометка «Превышает на $X» без суммы (или сумма при within) — ошибка offers
  if (isObj(v.tiers)) {
    for (const [name, tier] of Object.entries(v.tiers)) {
      if (isObj(tier) && !budgetFitConsistent(tier)) throw new OfferResponseInvalid(`/tiers/${name}/over_by`, "budget_fit");
      // курс ЦБ: пересчитанный билет входит в сумму и не в USD
      const t = isObj(tier) ? tier.ticket : null;
      if (isObj(t) && isObj(t.fx) && (t.in_total !== true || t.currency === "USD")) {
        throw new OfferResponseInvalid(`/tiers/${name}/ticket/fx`, "fx_consistency");
      }
    }
  }
  if (isObj(v.budget)) {
    const lo = cents(v.budget.min);
    const hi = cents(v.budget.max);
    if (lo !== null && hi !== null && lo > hi) throw new OfferResponseInvalid("/budget", "range");
  }
  // рекомендованный тариф без тарифов (not_available) — нечего открывать
  if (v.tiers === null) v.recommended_tier = null;
  const out = project(OfferSetViewSchema as JsonSchema, v) as OfferSetView;
  if (out.event_id.toLowerCase() !== eventId.toLowerCase()) throw new OfferResponseInvalid("/event_id", "mismatch");
  if (out.travellers < 1) throw new OfferResponseInvalid("/travellers", "range");
  return out;
}

// ---------------------------------------------------------------- профиль поездки

/** Параметры поездки из профиля: города вылета, предпочтения перелёта, бюджет (для offers:build и offer_params слежения). */
export function tripProfile(
  prefs: Preferences | null | undefined,
): Pick<BuildRequest, "departures" | "flight_prefs"> & { budget: TripBudget | null; hotel_filters: HotelFilters | null } {
  const deps = Array.isArray(prefs?.departures) ? prefs.departures : [];
  const fp = isObj(prefs?.flight_prefs) ? (prefs.flight_prefs as unknown as Raw) : {};
  return {
    // контракт offers (DepartureIn): IATA, город 1..100, ISO-2 — неполная запись профиля не ломает весь расчёт
    departures: deps
      .filter((d) => isObj(d) && typeof d.airport_iata === "string" && /^[A-Z]{3}$/.test(d.airport_iata))
      .map((d) => ({
        airport_iata: d.airport_iata,
        city: typeof d.city === "string" ? d.city.replace(UNSAFE_CHARS, " ").trim().slice(0, 100).trim() : "",
        country_code: typeof d.country_code === "string" ? d.country_code : "",
      }))
      .filter((d) => d.city !== "" && /^[A-Z]{2}$/.test(d.country_code))
      .slice(0, 10),
    flight_prefs: {
      direct: fp.direct === true,
      connecting: fp.connecting !== false,
      alternative_departure: fp.alternative_departure === true,
    },
    budget: tripBudget(prefs?.budget),
    hotel_filters: hotelFiltersOf(prefs?.hotel_prefs, null), // 6.3
  };
}

// ---------------------------------------------------------------- сервис

export interface OffersServiceDeps {
  offers: DomainClient | null;
  offersRead: DomainClient | null;
  preferences: DomainClient;
  identity: DomainClient;
  log: FastifyBaseLogger;
  /** Спринт 6: последний расчёт пользователя по событию (offer_params слежения, trip_per_person ранжирования). */
  lastTrip?: { save(userId: string, eventId: string, trip: LastTrip): Promise<void> };
}

/** Ошибка вызова offers → ответ Mini App (см. шапку файла). */
export function mapOffersError(err: unknown, log: FastifyBaseLogger): AppError {
  if (err instanceof AppError) {
    if (err.status === 404) return eventNotFound();
    if (err.status === 422) {
      if (err.code === "OFFER_DEPARTURE_INVALID") {
        return new AppError(422, "OFFER_DEPARTURE_INVALID", "Город вылета недоступен для расчёта", {});
      }
      return new AppError(422, "VALIDATION_ERROR", "Некорректные параметры расчёта", { in: "body" });
    }
    if (err.status === 429) {
      const ra = Number(err.details?.retry_after);
      const retryAfter = Number.isInteger(ra) && ra > 0 && ra <= 3600 ? ra : 60;
      return new AppError(429, "RATE_LIMITED", "Слишком много запросов, повторите позже", { retry_after: retryAfter });
    }
  }
  const e = err as { status?: number; code?: string; name?: string };
  log.warn(
    { upstream: "offers", upstream_status: e?.status ?? 0, upstream_code: e?.code ?? e?.name ?? "UNKNOWN" },
    "offers unavailable",
  );
  return offersUnavailable();
}

/** Последний расчёт поездки (спринт 6): параметры, с которыми пользователь смотрел «Поездку», и сумма на человека. */
export interface LastTrip {
  tier: OfferSetView["recommended_tier"] & string;
  travellers: number;
  departure_iata: string | null;
  direct_only: boolean;
  near_venue: boolean;
  extra_nights: number;
  hotel_id: string | null;
  /** 6.3: настройки отеля этой поездки («Настроить расчёт», поверх профиля); null — как в профиле */
  hotel_filters: OfferHotelFilters | null;
  /** totals.per_person тарифа tier, если сумма полная (missing пуст); иначе null */
  per_person: string | null;
  at: string;
}

/** Тариф — рекомендованный offers (5.1) или comfort; город вылета — выбранный пользователем (cheapest → null). */
export function lastTripOf(set: OfferSetView, overrides: Overrides): LastTrip {
  const tier = set.recommended_tier ?? "comfort";
  const offer = set.tiers?.[tier];
  return {
    tier,
    travellers: set.travellers,
    departure_iata: overrides.departure_iata,
    direct_only: overrides.direct_only,
    near_venue: overrides.near_venue,
    extra_nights: overrides.extra_nights,
    hotel_id: overrides.hotel_id,
    hotel_filters: tripHotelFiltersOf(overrides.hotel_filters),
    per_person: offer && offer.totals.missing.length === 0 ? offer.totals.per_person : null,
    at: new Date().toISOString(),
  };
}

export class OffersService {
  /** Предупреждение «offers без полей 5.1» — один раз на процесс. */
  private legacyWarned = false;
  /** Предупреждение «offers отверг поля 5.1, повтор без них» — один раз на процесс. */
  private retryWarned = false;

  constructor(private readonly d: OffersServiceDeps) {}

  get configured(): boolean {
    return this.d.offers !== null;
  }

  /** Профиль пользователя для сборки: города вылета, предпочтения перелёта, язык. */
  private async profile(
    userId: string,
  ): Promise<Pick<BuildRequest, "departures" | "flight_prefs" | "lang"> & { budget: TripBudget | null; hotel_filters: HotelFilters | null }> {
    const [prefs, lang] = await Promise.all([
      this.d.preferences.get<Preferences>("/internal/v1/me/preferences", { subject: userId }).catch((err: unknown) => {
        // без городов вылета расчёт был бы неверным («нет города вылета») — честнее 503
        this.d.log.warn({ upstream: "preferences", upstream_code: (err as { code?: string })?.code ?? "UNKNOWN" }, "offers: preferences unavailable");
        throw offersUnavailable();
      }),
      this.d.identity
        .get<IdentityMe>("/internal/v1/me", { subject: userId })
        .then((me) => (me?.user?.locale === "en" ? "en" : "ru") as "ru" | "en")
        .catch(() => "ru" as const),
    ]);
    return { ...tripProfile(prefs), lang };
  }

  async build(
    userId: string,
    eventId: string,
    travellers: number,
    overrides: Overrides,
  ): Promise<OfferSetView> {
    const client = this.d.offers;
    if (!client) throw offersUnavailable();
    const { budget, hotel_filters: profileFilters, ...profile } = await this.profile(userId);
    const { hotel_id: hotelId, keep_hotels: keepRaw, hotel_filters: tripFilters, ...ov } = overrides;
    // 6.3: профиль, поверх него — настройки этой поездки
    const filters = hotelFiltersOf(profileFilters, tripFilters);
    // 5.2: выбор пользователя важнее отелей прошлого расчёта — keep_hotels только без hotel_id
    const keep = hotelId ? null : keepHotelsOf(keepRaw);
    // поля 5.1 / 5.2 — только если заданы: старый offers (extra="forbid") не ломается на расчётах без них
    const body: BuildRequest = {
      event_id: eventId,
      travellers,
      ...profile,
      overrides: { ...ov, ...(hotelId ? { hotel_id: hotelId } : {}), ...(keep ? { keep_hotels: keep } : {}) },
      ...(budget ? { budget } : {}),
      ...(filters ? { hotel_filters: filters } : {}),
    };
    const post = (b: BuildRequest) => client.post<unknown>("/internal/v1/offers:build", { subject: userId, body: b });
    let raw: unknown;
    // ревью 6.3: offers отверг hotel_filters — расчёт без условий отеля, Mini App говорит об этом (HOTEL_PREFS_PENDING)
    let filtersDropped = false;
    try {
      raw = await post(body);
    } catch (err) {
      const rejected = rejectedNewFields(err);
      if (!rejected || !hasAny(body, rejected)) throw mapOffersError(err, this.d.log);
      // старый offers при выкладке: один повтор без отвергнутых полей (без бюджета / по правилам)
      if (!this.retryWarned) {
        this.retryWarned = true;
        const names = [...rejected].map((f) => (f === "budget" || f === "hotel_filters" ? f : `overrides.${f}`)).sort();
        this.d.log.warn({ upstream: "offers", fields: names }, "offers rejected 5.1 request fields: retried without them (offers not yet updated)");
      }
      filtersDropped = rejected.has("hotel_filters") && body.hotel_filters !== undefined;
      try {
        raw = await post(withoutFields51(body, rejected));
      } catch (err2) {
        throw mapOffersError(err2, this.d.log);
      }
    }
    const legacy = new Set<string>();
    try {
      const out = sanitizeOfferSet(raw, eventId, legacy);
      if (filtersDropped && !out.notes.includes("HOTEL_PREFS_PENDING")) out.notes.push("HOTEL_PREFS_PENDING");
      if (legacy.size && !this.legacyWarned) {
        this.legacyWarned = true;
        this.d.log.warn({ upstream: "offers", missing_fields: [...legacy].sort() }, "offers response without 5.1 fields: defaults applied (offers not yet updated)");
      }
      await this.d.lastTrip?.save(userId, eventId, lastTripOf(out, overrides));
      return out;
    } catch (err) {
      const e = err as OfferResponseInvalid;
      // без значений из ответа: только путь и правило
      this.d.log.warn({ upstream: "offers", reason: "schema", path: e.path, rule: e.rule }, "offers bad response");
      throw offersUnavailable();
    }
  }

  /**
   * Свой снимок предложения или null (чужой, несуществующий, не-UUID, offers не настроен/недоступен, мусор в ответе).
   * Никогда не бросает: обращение в поддержку создаётся и без снимка.
   */
  async snapshot(userId: string, offerId: string): Promise<OfferSnapshot | null> {
    const client = this.d.offersRead;
    if (!client || !UUID_RE.test(offerId)) return null;
    let raw: unknown;
    try {
      raw = await client.get<unknown>(`/internal/v1/offers/${offerId.toLowerCase()}`, { subject: userId });
    } catch (err) {
      const e = err as { status?: number; code?: string };
      if (e?.status !== 404) {
        this.d.log.warn({ upstream: "offers", upstream_status: e?.status ?? 0, upstream_code: e?.code ?? "UNKNOWN" }, "offer snapshot unavailable");
      }
      return null;
    }
    const v = scrubStrings(raw);
    if (
      !isObj(v) ||
      typeof v.offer_id !== "string" ||
      v.offer_id.toLowerCase() !== offerId.toLowerCase() ||
      typeof v.event_id !== "string" ||
      !UUID_RE.test(v.event_id) ||
      !isObj(v.offer)
    ) {
      this.d.log.warn({ upstream: "offers", reason: "snapshot_shape" }, "offer snapshot bad response");
      return null;
    }
    return {
      offer_id: v.offer_id.toLowerCase(),
      event_id: v.event_id.toLowerCase(),
      created_at: typeof v.created_at === "string" ? v.created_at.slice(0, 40) : "",
      offer: v.offer as OfferSnapshot["offer"],
    };
  }
}
