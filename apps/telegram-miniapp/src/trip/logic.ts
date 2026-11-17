/**
 * Trip block (sprint 5) — pure logic, tested in test/trip.test.tsx:
 *  - which BFF call a set of parameters needs (GET with travellers, POST /recalculate with overrides);
 *  - money from decimal strings without float arithmetic (cents as integers);
 *  - trip dates / flight times / distances / «цена от ЧЧ:ММ»;
 *  - honest texts for unavailable components and states (by `reason`);
 *  - the support context of «Проблема с предложением?» and the links of «Источники и бронирование»;
 *  - fix 5.1: the budget mark of a tier / a hotel, the order of «Отели рядом», the hotel the user chose;
 *  - fix 5.2: a change of travellers keeps the tier the user chose and every tier's hotel (keep_hotels); a tier
 *    picked automatically for the budget is picked again — and said so; the hotel the supplier did not price is named.
 * Prices are never invented here: a component without a price stays «—», totals come from the server.
 */
import type {
  BudgetFit,
  EventDetailView,
  MapLinks,
  NearbyHotel,
  Offer,
  OfferComponentUnavailable,
  OfferComponentUnavailableReason,
  OfferFlight,
  OfferHotel,
  OfferHotelFilters,
  OfferKeepHotels,
  OfferNote,
  OfferRecalculateRequest,
  OfferSetView,
  OfferTicket,
  OfferTier,
  TripBudget,
} from "@tilhero/contracts/bff";
import { flightLink } from "../ai/chat";
import { ApiError } from "../api/errors";
import { hostOf, parseLocalDate, sourceLabel, tidy } from "../events/format";
import type { Lang, MessageKey, Vars } from "../i18n";
import type { EventSupportContext } from "../state/nav";

export type Translate = (key: MessageKey, vars?: Vars) => string;

export const TIERS: readonly OfferTier[] = ["economy", "comfort", "premium"];
export const MIN_TRAVELLERS = 1;
export const MAX_TRAVELLERS = 6;
export const MAX_EXTRA_NIGHTS = 3;
export const NEAR_VENUE_M = 1000;

/** What the user changed in the block; everything but travellers is an override of POST /recalculate. */
export interface TripParams {
  travellers: number;
  /** null = the server picks the cheapest of the profile's cities */
  departure_iata: string | null;
  direct_only: boolean;
  near_venue: boolean;
  extra_nights: number;
  /** fix 5.1: the hotel the user picked in «Отели рядом» (for every tier); null — the hotel by the tier rules */
  hotel_id: string | null;
  /**
   * fix 5.2: every tier's hotel of the set on screen when the user changed the number of travellers — the next sets
   * keep them (priced by the supplier for the new occupancy) instead of re-picking another hotel by the rules;
   * null — the hotels by the tier rules (first calculation, a new budget, «Вернуть подбор»).
   */
  keep_hotels: OfferKeepHotels | null;
  /**
   * fix 6.3: the hotel settings for this trip only («Настроить расчёт»: guest rating, distance to the venue, stars) —
   * over the profile's; a field not set — as in the profile; null — all as in the profile.
   */
  hotel_filters: OfferHotelFilters | null;
}

export const DEFAULT_PARAMS: TripParams = {
  travellers: 1,
  departure_iata: null,
  direct_only: false,
  near_venue: false,
  extra_nights: 0,
  hotel_id: null,
  keep_hotels: null,
  hotel_filters: null,
};

export const clampTravellers = (n: number): number => Math.min(MAX_TRAVELLERS, Math.max(MIN_TRAVELLERS, Math.round(Number.isFinite(n) ? n : 1)));
export const clampNights = (n: number): number => Math.min(MAX_EXTRA_NIGHTS, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));

export function hasOverrides(p: TripParams): boolean {
  return p.departure_iata !== null || p.direct_only || p.near_venue || p.extra_nights > 0 || !!p.hotel_id || !!keepOf(p) || !!filtersOf(p);
}

/* ---------------------------------------------------------------- hotel settings (fix 6.3) */

const RATINGS = [0, 7, 7.5, 8, 8.5, 9];
const DISTANCES = [1, 3, 5, 10, 15];
const STARS = [0, 3, 4, 5];
export const DEFAULT_HOTEL_KM = 5;
/** experience-config hotel_rating_min when the config is not at hand (the built-in config has the same) */
export const DEFAULT_HOTEL_RATING = 8.5;

/** The trip's hotel settings as they are sent: known chip values only; none → null (the profile's). */
export function filtersOf(p: Pick<TripParams, "hotel_filters">): OfferHotelFilters | null {
  const f = p.hotel_filters;
  if (!f) return null;
  const out: OfferHotelFilters = {};
  if (typeof f.rating_min === "number" && RATINGS.includes(f.rating_min)) out.rating_min = f.rating_min;
  if (typeof f.max_distance_km === "number" && DISTANCES.includes(f.max_distance_km)) out.max_distance_km = f.max_distance_km;
  if (typeof f.min_stars === "number" && STARS.includes(f.min_stars)) out.min_stars = f.min_stars;
  return Object.keys(out).length ? out : null;
}

export interface HotelValues {
  rating: number;
  distance: number;
  stars: number;
}

/** The values the calculation uses: the trip's setting, else the profile's, else the default (experience-config,
 *  5 km, any stars). */
export function hotelValues(
  profile: { rating_min: number | null; max_distance_km: number | null; min_stars: number | null } | null | undefined,
  trip: OfferHotelFilters | null,
  defaultRating: number,
): HotelValues {
  return {
    rating: trip?.rating_min ?? profile?.rating_min ?? defaultRating,
    distance: trip?.max_distance_km ?? profile?.max_distance_km ?? DEFAULT_HOTEL_KM,
    stars: trip?.min_stars ?? profile?.min_stars ?? 0,
  };
}

/** A pick in the trip settings: the profile's value again → the field is dropped («как в профиле»). */
export function pickTripHotel(trip: OfferHotelFilters | null, field: keyof OfferHotelFilters, v: number, asProfile: number): OfferHotelFilters | null {
  const next: OfferHotelFilters = { ...(trip ?? {}) };
  if (v === asProfile) delete next[field];
  else next[field] = v;
  return filtersOf({ hotel_filters: next });
}

/** keep_hotels as it is sent: valid ids only, none → null; the user's own hotel (hotel_id) makes it moot. */
export function keepOf(p: Pick<TripParams, "hotel_id" | "keep_hotels">): OfferKeepHotels | null {
  if (p.hotel_id || !p.keep_hotels) return null;
  const out: OfferKeepHotels = {};
  for (const k of TIERS) {
    const id = p.keep_hotels[k];
    if (id && HOTEL_ID.test(id)) out[k] = id;
  }
  return Object.keys(out).length ? out : null;
}

export type OffersCall = { method: "GET"; travellers: number } | { method: "POST"; body: OfferRecalculateRequest };

/** Without overrides the plain GET (BFF reads departures and flight preferences from the profile); otherwise POST. */
/**
 * GET for the plain calculation (the server reuses a fresh set); POST /recalculate with overrides — or with `force`
 * (fix 5.1 «Попробовать снова» after a supplier failure: the same parameters, a new calculation past the offers cache).
 */
export function offersCall(p: TripParams, force = false): OffersCall {
  const travellers = clampTravellers(p.travellers);
  if (!hasOverrides(p) && !force) return { method: "GET", travellers };
  const body: OfferRecalculateRequest = { travellers, direct_only: p.direct_only, near_venue: p.near_venue, extra_nights: clampNights(p.extra_nights) };
  if (p.departure_iata && /^[A-Z]{3}$/.test(p.departure_iata)) body.departure_iata = p.departure_iata;
  // «Вернуть подбор» = hotel_id null = no field: the hotel by the tier rules (the contract treats both the same)
  if (p.hotel_id && HOTEL_ID.test(p.hotel_id)) body.hotel_id = p.hotel_id;
  const keep = keepOf(p);
  if (keep) body.keep_hotels = keep;
  const filters = filtersOf(p);
  if (filters) body.hotel_filters = filters;
  return { method: "POST", body };
}

/**
 * Fix 6.3: an older telegram-bff does not know hotel_filters (422 VALIDATION_ERROR on the field) — the same calculation
 * without the trip's hotel settings (the profile's still apply on the server side). null — not this case.
 */
export function filtersFallback(call: OffersCall, err: unknown): OffersCall | null {
  if (call.method !== "POST" || !call.body.hotel_filters || !(err instanceof ApiError)) return null;
  const field = typeof err.details.field === "string" ? err.details.field : null;
  if (!(err.status === 422 && err.code === "VALIDATION_ERROR" && field !== null && field.startsWith("hotel_filters"))) return null;
  const { hotel_filters: _f, ...body } = call.body;
  const plain = !body.departure_iata && !body.direct_only && !body.near_venue && !body.extra_nights && !body.hotel_id && !body.keep_hotels;
  return plain ? { method: "GET", travellers: body.travellers } : { method: "POST", body };
}

/**
 * Fix 6.1 review: an older telegram-bff does not know keep_hotels — its strict schema answers 422 VALIDATION_ERROR (on
 * the field), a BFF without POST …/recalculate answers 404 / 405. The same calculation without keep_hotels: GET when
 * nothing else is overridden, else POST without the field (no POST route — nothing to fall back to: null). null — not
 * this case (the error stays the block's error).
 */
export function keepFallback(call: OffersCall, err: unknown): OffersCall | null {
  if (call.method !== "POST" || !call.body.keep_hotels || !(err instanceof ApiError)) return null;
  const field = typeof err.details.field === "string" ? err.details.field : null;
  const strict = err.status === 422 && err.code === "VALIDATION_ERROR" && (field === null || field.startsWith("keep_hotels"));
  const noRoute = err.status === 405 || (err.status === 404 && err.code !== "EVENT_NOT_FOUND");
  if (!strict && !noRoute) return null;
  const { keep_hotels: _keep, ...body } = call.body;
  const plain = !body.departure_iata && !body.direct_only && !body.near_venue && !body.extra_nights && !body.hotel_id && !body.hotel_filters;
  if (plain) return { method: "GET", travellers: body.travellers };
  return strict ? { method: "POST", body } : null;
}

/** Supplier hotel ids are short opaque tokens ("lp3f1a01"); anything else is never sent back. */
const HOTEL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/* ---------------------------------------------------------------- money (decimal strings, integer cents) */

const DEC = /^(\d{1,12})(?:\.(\d{1,2}))?$/;

/** "85.5" → 8550; null when malformed. */
export function toCents(amount: string | null | undefined): number | null {
  const m = DEC.exec((amount ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** 8550 → "85.50". */
export function fromCents(c: number): string {
  const v = Math.max(0, Math.round(c));
  return `${Math.floor(v / 100)}.${String(v % 100).padStart(2, "0")}`;
}

/** price × travellers on integer cents ("85.00" × 2 → "170.00"); null when malformed. */
export function mulAmount(amount: string, n: number): string | null {
  const c = toCents(amount);
  return c == null ? null : fromCents(c * n);
}

export const isPositiveAmount = (amount: string | null | undefined): boolean => (toCents(amount) ?? 0) > 0;

/* ---------------------------------------------------------------- dates, times, distances */

const LOCALE: Record<Lang, string> = { ru: "ru-RU", en: "en-GB" };

/**
 * "2026-11-13","2026-11-16" → "13–16 нояб." / "13–16 Nov"; across months "30 нояб. – 2 дек."; one day → "13 нояб.".
 * Across a New Year the year is named only when a date is beyond the next calendar year (the pass is 360 px wide:
 * "30 дек. – 3 янв." fits, "30 дек. 2026 – 3 янв. 2027" does not).
 */
export function formatTripDates(out: string | null, back: string | null, lang: Lang, now: number = Date.now()): string {
  const a = parseLocalDate(out);
  if (!a) return "";
  const b = parseLocalDate(back);
  const year = new Date(now).getUTCFullYear();
  const far = [a, b].some((d) => d && (d.getUTCFullYear() < year || d.getUTCFullYear() > year + 1));
  const f = new Intl.DateTimeFormat(LOCALE[lang], { day: "numeric", month: "short", timeZone: "UTC", ...(far ? { year: "numeric" } : {}) });
  if (!b || b.getTime() <= a.getTime()) return tidy(f.format(a));
  if (a.getUTCFullYear() !== b.getUTCFullYear() && !far) return tidy(`${f.format(a)} – ${f.format(b)}`);
  return tidy(f.formatRange(a, b));
}

/** Local wall time of an ISO timestamp with the place's offset ("2026-11-13T07:40:00+05:00" → "07:40"), no zone shift. */
export function wallClock(iso: string | null | undefined): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso ?? "");
  return m ? `${m[1]}:${m[2]}` : "";
}

/** Local date of an ISO timestamp with offset → "13 нояб.". */
export function wallDay(iso: string | null | undefined, lang: Lang): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso ?? "");
  return m ? formatTripDates(m[1]!, null, lang) : "";
}

/** «цена от ЧЧ:ММ»: the time in the viewer's zone; another calendar day → "10.10 12:00". */
export function priceTime(iso: string, lang: Lang, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const loc = LOCALE[lang];
  const time = new Intl.DateTimeFormat(loc, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  const day = (x: Date) => new Intl.DateTimeFormat(loc, { year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  if (day(d) === day(new Date(now))) return time;
  return `${new Intl.DateTimeFormat(loc, { day: "2-digit", month: "2-digit" }).format(d)} ${time}`;
}

export function formatDuration(minutes: number | null | undefined, t: Translate): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (!h) return t("tr.dur.m", { m });
  return m ? t("tr.dur.hm", { h, m }) : t("tr.dur.h", { h });
}

/** 650 → "650 м"; 1830 → "1,8 км" / "1.8 km". */
export function formatDistance(m: number, lang: Lang, t: Translate): string {
  if (!Number.isFinite(m) || m < 0) return "";
  if (m < 1000) return t("tr.dist.m", { n: Math.round(m / 10) * 10 || Math.round(m) });
  const km = new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 1, minimumFractionDigits: m < 10_000 ? 1 : 0 }).format(Math.round(m / 100) / 10);
  return t("tr.dist.km", { n: km });
}

/** Fix 6.1: a search radius as people say it: 5000 → «5 км», 1500 → «1,5 км», 15000 → «15 км». */
export function formatRadius(m: number, lang: Lang, t: Translate): string {
  if (!Number.isFinite(m) || m <= 0) return "";
  const km = new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 1, minimumFractionDigits: 0 }).format(Math.round(m / 100) / 10);
  return t("tr.dist.km", { n: km });
}

/** Guest rating as the source gives it ("8.9") with the locale separator ("8,9"). */
export function formatRating(r: string, lang: Lang): string {
  const n = Number(r);
  return Number.isFinite(n) ? new Intl.NumberFormat(LOCALE[lang], { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n) : r;
}

export function isExpired(expiresAt: string, now: number = Date.now()): boolean {
  const e = Date.parse(expiresAt);
  return Number.isFinite(e) && e <= now;
}

/* ---------------------------------------------------------------- components */

export const isOk = <T extends { status: string }>(c: T | OfferComponentUnavailable): c is T => c.status === "ok";

/** Transfers line: "прямой" | "1 пересадка" | "пересадки: туда 0, обратно 1". */
export function transfersText(f: Pick<OfferFlight, "transfers" | "return_transfers">, t: Translate, tp: (k: MessageKey, n: number) => string): string {
  const a = f.transfers;
  const b = f.return_transfers ?? a;
  if (a === 0 && b === 0) return t("tr.fl.direct");
  if (a === b) return `${a} ${tp("tr.fl.transfers", a)}`;
  return t("tr.fl.transfersMixed", { a, b });
}

const REASON_KEYS: Record<"ticket" | "flight" | "hotel", Partial<Record<OfferComponentUnavailableReason, MessageKey>>> = {
  ticket: { NO_PRICE: "tr.na.ticket.NO_PRICE" },
  flight: { NO_PRICE: "tr.na.flight.NO_PRICE", NO_DEPARTURE: "tr.na.flight.NO_DEPARTURE", NO_DIRECT: "tr.na.flight.NO_DIRECT" },
  hotel: { NO_PRICE: "tr.na.hotel.NO_PRICE", NO_HOTEL: "tr.na.hotel.NO_HOTEL", NO_LOCATION: "tr.na.hotel.NO_LOCATION" },
};

/**
 * Honest text for an unavailable component by its `reason`; NO_HOTEL with «≤ 1 km» names the distance limit.
 * Fix 5.1: a supplier failure of the flight / hotel says which service did not answer (not «no price»).
 */
export function unavailableKey(kind: "ticket" | "flight" | "hotel", reason: OfferComponentUnavailableReason, nearVenue = false, hasLink = false): MessageKey {
  if (kind !== "ticket" && (reason === "PROVIDER_UNAVAILABLE" || reason === "NOT_CONFIGURED")) return `tr.na.${kind}.${reason}` as MessageKey;
  // fix 5.2: the flight supplier does not know the route — honest text, the Aviasales search link when there is one
  if (kind === "flight" && reason === "ROUTE_NOT_SUPPORTED") return hasLink ? "tr.na.flight.ROUTE_NOT_SUPPORTED" : "tr.na.flight.ROUTE_NOT_SUPPORTED.noLink";
  if (reason === "PROVIDER_UNAVAILABLE") return "tr.na.PROVIDER_UNAVAILABLE";
  if (reason === "NOT_CONFIGURED") return "tr.na.NOT_CONFIGURED";
  if (kind === "hotel" && reason === "NO_HOTEL" && nearVenue) return "tr.na.hotel.NO_HOTEL_NEAR";
  return REASON_KEYS[kind][reason] ?? "tr.na.other";
}

/**
 * Fix 5.1 E: the supplier did not answer — the flight / hotel row offers «Попробовать снова» (a forced recalculation
 * with the same parameters). NOT_CONFIGURED («временно отключён») and NO_PRICE are not retried: asking again changes nothing.
 */
export const isProviderDown = (c: OfferComponentUnavailable | { status: "ok" }): boolean => c.status === "unavailable" && (c as OfferComponentUnavailable).reason === "PROVIDER_UNAVAILABLE";

/** Fix 5.2: the Aviasales search for a route the flight supplier does not know (https only); "" — no link. */
export const routeSearchLink = (c: OfferComponentUnavailable): string => (c.reason === "ROUTE_NOT_SUPPORTED" ? (flightLink(c.search_url) ?? "") : "");

/** Any flight / hotel of the set whose supplier did not answer (any tier). */
export function hasProviderFailure(set: Pick<OfferSetView, "tiers">): boolean {
  return !!set.tiers && TIERS.some((k) => isProviderDown(set.tiers![k].flight) || isProviderDown(set.tiers![k].hotel));
}

/** «без перелёта», «без отеля и билета»… for the total label; "" when everything is in. */
export function missingText(missing: Offer["totals"]["missing"], t: Translate): string {
  const order: Array<"flight" | "hotel" | "ticket"> = ["flight", "hotel", "ticket"];
  const parts = order.filter((k) => missing.includes(k)).map((k) => t(`tr.miss.${k}` as MessageKey));
  if (!parts.length) return "";
  return t("tr.miss.wo", { w: parts.length > 1 ? `${parts.slice(0, -1).join(", ")} ${t("tr.and")} ${parts.at(-1)}` : parts[0]! });
}

/** Note codes the UI explains (unknown codes from a newer server are skipped). */
export const NOTE_KEYS: Record<OfferNote, MessageKey> = {
  FLIGHT_DATES_SHIFTED: "tr.note.FLIGHT_DATES_SHIFTED",
  TICKET_NOT_USD: "tr.note.TICKET_NOT_USD",
  TICKET_FX_CONVERTED: "tr.note.TICKET_FX_CONVERTED",
  LOCATION_APPROX: "tr.note.LOCATION_APPROX",
  HOTEL_PRICES_PARTIAL: "tr.note.HOTEL_PRICES_PARTIAL",
  HOTEL_SEARCH_WIDENED: "tr.note.HOTEL_SEARCH_WIDENED",
  HOTEL_ALTERNATIVES_NONE: "tr.note.HOTEL_ALTERNATIVES_NONE",
  HOTEL_SEARCH_INCOMPLETE: "tr.note.HOTEL_SEARCH_INCOMPLETE",
  BUDGET_NONE_WITHIN: "tr.note.BUDGET_NONE_WITHIN",
  HOTEL_PREFS_NONE: "tr.note.HOTEL_PREFS_NONE",
  HOTEL_PREFS_PENDING: "tr.note.HOTEL_PREFS_PENDING",
};

export const POI_KINDS = ["attraction", "museum", "viewpoint", "gallery", "zoo", "theatre", "arts_centre", "restaurant", "cafe", "park", "garden", "monument", "memorial", "castle", "theme_park", "concert_venue"] as const;
export const poiKindKey = (kind: string): MessageKey => ((POI_KINDS as readonly string[]).includes(kind) ? (`tr.poi.k.${kind}` as MessageKey) : "tr.poi.k.other");

/** The four map services of MapLinks, in menu order; only https links survive. */
export const MAP_SERVICES = ["yandex", "google", "dgis", "osm"] as const;
export function mapItems(map: MapLinks | null | undefined): Array<{ key: (typeof MAP_SERVICES)[number]; url: string }> {
  if (!map) return [];
  return MAP_SERVICES.map((key) => ({ key, url: map[key] })).filter((x) => typeof x.url === "string" && /^https:\/\//i.test(x.url));
}

export const safeLink = (url: string | null | undefined): string => (url && /^https:\/\//i.test(url) ? url : "");

/**
 * The ticket price per person in USD that is in the total: the USD price, or (fix 5.1) the price converted at the
 * Central Bank of Uzbekistan rate (`fx`). null — the ticket is in another currency and stays out of the total.
 */
export function ticketUsd(tk: OfferTicket): string | null {
  if (!tk.in_total) return null;
  if (tk.fx && isPositiveAmount(tk.fx.price_per_person_usd)) return fromCents(toCents(tk.fx.price_per_person_usd)!);
  return tk.currency === "USD" ? tk.price_per_person : null;
}

/** The converted ticket (fix 5.1): in the total by the CBU rate, the source price is shown next to it. */
export const ticketFx = (tk: OfferTicket): NonNullable<OfferTicket["fx"]> | null => (tk.in_total && tk.fx && isPositiveAmount(tk.fx.price_per_person_usd) ? tk.fx : null);

/** The rate date as people read it: "2026-10-11" → «11.10» / «11 Oct». */
export function fxDate(date: string, lang: Lang): string {
  const d = parseLocalDate(date);
  if (!d) return "";
  return lang === "ru"
    ? new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(d)
    : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
}

/** Currencies the ticket sites of the region write as a word or sign («27 000 сом»): i18n `tr.cur.<ISO>`; others keep the ISO code. */
export const SITE_CURRENCIES = ["KGS", "UZS", "KZT", "RUB", "EUR", "AZN", "GEL", "AMD", "TJS", "TRY", "AED"] as const;

/** "27000.00" KGS → «27 000 сом» / «27,000 som»; "" when malformed. */
export function siteMoney(amount: string, currency: string, lang: Lang, t: Translate): string {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec((amount ?? "").trim());
  if (!m || !/^[A-Z]{3}$/.test(currency)) return "";
  const whole = new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 0 }).format(Number(m[1])).replace(/[  \s]/g, " ");
  const cents = (m[2] ?? "").padEnd(2, "0");
  const num = cents === "00" ? whole : `${whole}${lang === "ru" ? "," : "."}${cents}`;
  const word = (SITE_CURRENCIES as readonly string[]).includes(currency) ? t(`tr.cur.${currency}` as MessageKey) : currency;
  return `${num} ${word}`;
}

/** Whole dollars for an «≈» figure, half up on the cents: "309.18" → "309", "2061.50" → "2062"; null when malformed. */
export function approxUsd(amount: string | null | undefined): string | null {
  const c = toCents(amount);
  return c == null ? null : String(Math.floor((c + 50) / 100));
}

/**
 * Fix 5.1 D: the line under a ticket converted at the CBU rate —
 * «≈ $309 по курсу ЦБ РУз на 11.10 · на сайте 27 000 сом» (per ticket; the site price in its own currency).
 */
export function ticketFxLine(tk: OfferTicket, lang: Lang, t: Translate, usd: (amount: string) => string): string {
  const fx = ticketFx(tk);
  if (!fx) return "";
  const p = approxUsd(fx.price_per_person_usd);
  const d = fxDate(fx.date, lang);
  const s = siteMoney(tk.price_per_person, tk.currency, lang, t);
  return p && d && s ? t("tr.tk.fx", { p: usd(p), d, s }) : "";
}

/** Ticket provider as the user knows it («Ticketmaster», «iticket.uz»), never the raw aiweb id. */
export const ticketProvider = (tk: OfferTicket): string => sourceLabel(tk.provider, tk.deeplink);

/* ---------------------------------------------------------------- sources & booking, support */

export interface PackageLink {
  kind: "ticket" | "flight" | "hotel" | "venue";
  /** what the link opens: the route, the hotel, the venue name ("" for the ticket) */
  object: string;
  provider: string;
  host: string;
  url: string;
  fetched_at: string | null;
  /** USD decimal for the whole group (or the ticket in its own currency) */
  amount: string | null;
  currency: string | null;
  /** HOTEL_PRICES_PARTIAL: the hotel is priced for the event dates (not the shifted flight dates) and is out of the total */
  outOfTotal?: boolean;
}

/** Every link of the selected package (ticket, flight, hotel) + the venue on the map. */
export function packageLinks(set: OfferSetView, offer: Offer): PackageLink[] {
  const out: PackageLink[] = [];
  const n = set.travellers;
  const tk = offer.ticket;
  if (isOk(tk) && safeLink(tk.deeplink)) {
    out.push({
      kind: "ticket",
      object: "",
      provider: ticketProvider(tk),
      host: hostOf(tk.deeplink),
      url: tk.deeplink,
      fetched_at: tk.fetched_at,
      ...(ticketUsd(tk) ? { amount: mulAmount(ticketUsd(tk)!, n), currency: "USD" } : { amount: tk.price_per_person, currency: tk.currency }),
    });
  }
  const fl = offer.flight;
  if (isOk(fl) && safeLink(fl.deeplink))
    out.push({
      kind: "flight",
      object: `${fl.origin} → ${fl.destination}`,
      provider: sourceLabel(fl.provider),
      host: hostOf(fl.deeplink),
      url: fl.deeplink,
      fetched_at: fl.fetched_at,
      amount: fl.total,
      currency: "USD",
    });
  const ht = offer.hotel;
  if (isOk(ht) && safeLink(ht.deeplink))
    out.push({ kind: "hotel", object: ht.name, provider: sourceLabel(ht.provider), host: hostOf(ht.deeplink), url: ht.deeplink, fetched_at: ht.fetched_at, amount: ht.total, currency: "USD", outOfTotal: offer.totals.missing.includes("hotel") });
  const venue = set.trip.destination?.venue;
  const vmap = venue ? safeLink(venue.map.google) || safeLink(venue.map.osm) : "";
  if (venue && vmap) out.push({ kind: "venue", object: venue.name, provider: "", host: "", url: vmap, fetched_at: null, amount: null, currency: null });
  return out;
}

/** The component a complaint is most likely about: the flight, else the hotel, else the ticket. */
export function mainComponent(offer: Offer): { provider: string; deeplink: string } | null {
  const fl = offer.flight;
  if (isOk<OfferFlight>(fl) && safeLink(fl.deeplink)) return { provider: fl.provider, deeplink: fl.deeplink };
  const ht = offer.hotel;
  if (isOk<OfferHotel>(ht) && safeLink(ht.deeplink)) return { provider: ht.provider, deeplink: ht.deeplink };
  const tk = offer.ticket;
  if (isOk<OfferTicket>(tk) && safeLink(tk.deeplink)) return { provider: tk.provider, deeplink: tk.deeplink };
  return null;
}

/**
 * «Проблема с предложением?» → support with offer_id, supplier, exact link and the package price at its time
 * (BFF re-reads price_snapshot/deeplink from the stored snapshot — the client values are only a hint).
 */
export function offerSupportContext(ev: Pick<EventDetailView, "event_id" | "title">, set: OfferSetView, offer: Offer, subject: string): EventSupportContext {
  const main = mainComponent(offer);
  const total = offer.totals.total;
  return {
    event_id: ev.event_id,
    event_title: ev.title.slice(0, 300),
    offer_id: offer.offer_id,
    ...(main ? { provider_id: main.provider.slice(0, 128), deeplink: main.deeplink } : {}),
    ...(isPositiveAmount(total) ? { price_snapshot: { amount: fromCents(toCents(total)!), currency: "USD" as const, fetched_at: set.generated_at } } : {}),
    category: "PRICE",
    subject: subject.slice(0, 120),
  };
}

/* ---------------------------------------------------------------- budget (fix 5.1) */

/** What the UI marks: «В вашем бюджете» / «Превышает ваш бюджет на $X»; unknown (no budget, partial sum) — nothing. */
/** Fix 6.1: `excludes` — parts not priced and so not compared («без учёта билета»); [] — the whole sum. */
export type BudgetMark = { kind: "within"; excludes: BudgetPart[] } | { kind: "over"; by: string | null; excludes: BudgetPart[] } | null;
export type BudgetPart = "ticket" | "flight" | "hotel";

const PARTS: readonly BudgetPart[] = ["flight", "hotel", "ticket"];

export function budgetMark(x: { budget_fit?: BudgetFit | null; over_by?: string | null; budget_excludes?: readonly string[] | null } | null | undefined): BudgetMark {
  if (!x) return null;
  const excludes = PARTS.filter((p) => (x.budget_excludes ?? []).includes(p));
  if (x.budget_fit === "within") return { kind: "within", excludes };
  if (x.budget_fit === "over") return { kind: "over", by: isPositiveAmount(x.over_by) ? fromCents(toCents(x.over_by)!) : null, excludes };
  return null;
}

/** Fix 6.1: «без учёта билета» / «без учёта перелёта и билета»; "" — everything is compared. */
export function excludesText(excludes: readonly BudgetPart[], t: Translate): string {
  const parts = PARTS.filter((p) => excludes.includes(p)).map((p) => t(`tr.miss.${p}` as MessageKey));
  if (!parts.length) return "";
  return t("tr.bud.wo", { w: parts.length > 1 ? `${parts.slice(0, -1).join(", ")} ${t("tr.and")} ${parts.at(-1)}` : parts[0]! });
}

/** Fix 6.1: the other tiers that carry the same hotel as `tier` (no alternatives were found). */
export function sharedHotelTiers(set: Pick<OfferSetView, "tiers">, tier: OfferTier): OfferTier[] {
  const h = set.tiers?.[tier]?.hotel;
  if (!set.tiers || !h || !isOk<OfferHotel>(h)) return [];
  return TIERS.filter((k) => {
    const o = set.tiers![k].hotel;
    return k !== tier && isOk<OfferHotel>(o) && o.hotel_id === h.hotel_id;
  });
}

/** Fix 6.1: a hotel found only by the wider search — beyond the base radius or below the base rating; 6.3 — or below
 *  the user's stars (the base is the user's hotel settings). */
export function beyondBase(
  h: Pick<NearbyHotel, "distance_m" | "rating"> & { stars?: number | null },
  search: OfferSetView["hotel_search"] | null | undefined,
): { far: boolean; lowRating: boolean; lowStars: boolean } {
  if (!search?.widened) return { far: false, lowRating: false, lowStars: false };
  const r = Number(h.rating);
  const base = Number(search.base_rating_min);
  const stars = search.base_min_stars ?? null;
  return {
    far: h.distance_m > search.base_radius_m,
    lowRating: Number.isFinite(r) && Number.isFinite(base) && r < base,
    lowStars: !!stars && (h.stars ?? 0) < stars,
  };
}

/** Fix 6.3: the user's hotel conditions as said in «По вашим условиям (до 1 км, оценка от 9,0) …». */
export function hotelConditions(search: NonNullable<OfferSetView["hotel_search"]>, lang: Lang, t: Translate): string {
  const r = Number(search.base_rating_min);
  return [
    t("tr.cond.dist", { km: formatRadius(search.base_radius_m, lang, t) }),
    Number.isFinite(r) && r > 0 ? t("tr.cond.rating", { r: formatRating(search.base_rating_min, lang) }) : t("tr.cond.anyRating"),
    search.base_min_stars ? t("tr.cond.stars", { n: search.base_min_stars }) : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** The tier the block opens with: the server's recommendation (highest tier within the budget…), else Comfort. */
export function initialTier(set: Pick<OfferSetView, "recommended_tier" | "tiers">): OfferTier {
  const r = set.recommended_tier;
  return r && TIERS.includes(r) && set.tiers?.[r] ? r : "comfort";
}

/** «$1 000–2 000» / «до $2 000» / «от $1 000» of the budget the set was priced with; "" without a usable max/min. */
export function budgetRange(b: TripBudget | null | undefined, usd: (amount: string) => string, t: Translate): string {
  if (!b) return "";
  const min = isPositiveAmount(b.min) ? usd(fromCents(toCents(b.min)!)) : "";
  const max = isPositiveAmount(b.max) ? usd(fromCents(toCents(b.max)!)) : "";
  if (min && max) return t("tr.bud.range", { a: min, b: max.replace(/^\$/, "") });
  if (max) return t("tr.bud.upTo", { b: max });
  if (min) return t("tr.bud.from", { a: min });
  return "";
}

/**
 * «Отели рядом» order (the server sorts too; the client keeps the rule if an older server does not):
 * within the budget by distance, then unknown by distance, then over the budget by price. Stable for ties.
 */
export function sortHotels(hotels: readonly NearbyHotel[]): NearbyHotel[] {
  const rank = (h: NearbyHotel) => (h.budget_fit === "within" ? 0 : h.budget_fit === "over" ? 2 : 1);
  return hotels
    .map((h, i) => ({ h, i }))
    .sort((a, b) => {
      const r = rank(a.h) - rank(b.h);
      if (r) return r;
      if (rank(a.h) === 2) {
        const d = (toCents(a.h.price_total) ?? Number.MAX_SAFE_INTEGER) - (toCents(b.h.price_total) ?? Number.MAX_SAFE_INTEGER);
        if (d) return d;
      } else if (a.h.distance_m !== b.h.distance_m) return a.h.distance_m - b.h.distance_m;
      return a.i - b.i;
    })
    .map((x) => x.h);
}

/** The hotel the user picked (hotel_chosen_by = "user"), as it stands in the selected package; null otherwise. */
export function chosenHotelId(set: Pick<OfferSetView, "hotel_chosen_by">, offer: Pick<Offer, "hotel">): string | null {
  if (set.hotel_chosen_by !== "user") return null;
  return isOk<OfferHotel>(offer.hotel) ? offer.hotel.hotel_id : null;
}

/** Key of the profile budget: a change (the user set it from the hint) prices the trip again. */
export function budgetKey(b: { preset: string | null; min: number | null; max: number | null; custom_amount: number | null } | null | undefined): string {
  return b ? [b.preset ?? "", b.min ?? "", b.max ?? "", b.custom_amount ?? ""].join("|") : "";
}

/* ---------------------------------------------------------------- travellers change (fix 5.2) */

/**
 * The hotel of every tier of a set priced by the tier rules — what a change of travellers keeps (keep_hotels).
 * The user's own hotel (hotel_chosen_by "user") is kept by hotel_id already; a tier without a hotel keeps nothing.
 */
export function tierHotels(set: Pick<OfferSetView, "tiers" | "hotel_chosen_by" | "trip">): OfferKeepHotels | null {
  if (!set.tiers || set.trip.kind !== "trip" || set.hotel_chosen_by === "user") return null;
  const out: OfferKeepHotels = {};
  for (const k of TIERS) {
    const h = set.tiers[k].hotel;
    if (isOk<OfferHotel>(h) && HOTEL_ID.test(h.hotel_id)) out[k] = h.hotel_id;
  }
  return Object.keys(out).length ? out : null;
}

/** «Подобрали Comfort под бюджет на 2 человека · Вернуть Premium». */
export interface Retier {
  from: OfferTier;
  to: OfferTier;
  travellers: number;
}

/**
 * The tier after a new set for another number of travellers. A tier the user chose stays (never switched silently);
 * a tier the block picked by itself for the budget follows the new recommendation — only when it is a budget
 * recommendation (the recommended tier is within / over the budget, not the default Comfort of an unknown sum).
 */
export function retier(set: Pick<OfferSetView, "recommended_tier" | "tiers" | "budget" | "travellers">, tier: OfferTier, auto: boolean): Retier | null {
  if (!auto || !set.budget || !set.tiers) return null;
  const to = set.recommended_tier;
  if (!to || to === tier || !set.tiers[to] || !set.tiers[tier]) return null;
  const fit = set.tiers[to].budget_fit;
  if (fit !== "within" && fit !== "over") return null;
  return { from: tier, to, travellers: set.travellers };
}

/** A tier whose hotel was kept on request, but the supplier priced it no more for this occupancy: the hotel shown now. */
export interface HotelSwap {
  from: string;
  /** the hotel the tier has now; null — none */
  to: string | null;
  travellers: number;
}

/** Per tier: the kept hotel (by id) is not the tier's hotel in the new set → what was shown and what is shown now. */
export function hotelSwaps(prev: Pick<OfferSetView, "tiers"> | null, next: Pick<OfferSetView, "tiers" | "travellers">, kept: OfferKeepHotels | null): Partial<Record<OfferTier, HotelSwap>> {
  const out: Partial<Record<OfferTier, HotelSwap>> = {};
  if (!prev?.tiers || !next.tiers || !kept) return out;
  for (const k of TIERS) {
    const id = kept[k];
    const before = prev.tiers[k].hotel;
    if (!id || !isOk<OfferHotel>(before) || before.hotel_id !== id) continue;
    const now = next.tiers[k].hotel;
    if (isOk<OfferHotel>(now) && now.hotel_id === id) continue;
    out[k] = { from: before.name, to: isOk<OfferHotel>(now) ? now.name : null, travellers: next.travellers };
  }
  return out;
}

/** The hotel the total of the boarding pass is priced with: its name; out of the total (other dates) or none. */
export function passHotel(offer: Pick<Offer, "hotel" | "totals">): { name: string; inTotal: boolean } | null {
  const h = offer.hotel;
  if (!isOk<OfferHotel>(h)) return null;
  return { name: h.name, inTotal: !offer.totals.missing.includes("hotel") };
}
