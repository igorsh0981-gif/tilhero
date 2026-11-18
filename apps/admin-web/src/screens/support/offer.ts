import type { OfferSnapshotAdmin } from "@tilhero/contracts/admin";
import { DICTS, type Lang, type MessageKey } from "../../i18n";
import { fmtAmount, fmtUsd } from "../../lib/money";
import type { Tone } from "../../ui/kit";

/*
 * «Offer snapshot» block of a support ticket (sprint 5, docs/sprint5/INTERNAL_API.md §2.4, §5): what the user saw when
 * writing to support. admin-bff already normalizes the snapshot (OfferSnapshotAdmin.offer / trip are `unknown` in
 * admin.ts); the screen reads it defensively once more — a field of an unexpected shape is shown as «—» or the whole
 * component as «data damaged», never as a made-up value, and only https links are clickable.
 */

export const OFFER_TIERS = ["economy", "comfort", "premium"] as const;
export type OfferTier = (typeof OFFER_TIERS)[number];
export const OFFER_STATUSES = ["complete", "partial", "unavailable"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
export const OFFER_STATUS_TONE: Record<OfferStatus, Tone> = { complete: "good", partial: "warn", unavailable: "bad" };
/** reasons of an unavailable component (§2.1) + BAD_DATA (admin-bff: the component failed the checks) */
export const COMPONENT_REASONS = ["NO_PRICE", "NO_DEPARTURE", "NO_DIRECT", "NO_HOTEL", "NO_LOCATION", "PROVIDER_UNAVAILABLE", "NOT_CONFIGURED", "ROUTE_NOT_SUPPORTED", "BAD_DATA"] as const;
export const TRIP_REASONS = ["ONLINE_EVENT", "SAME_CITY", "EVENT_POSTPONED", "EVENT_CANCELLED", "EVENT_PAST", "NO_DESTINATION"] as const;
export const OFFER_NOTES = ["FLIGHT_DATES_SHIFTED", "TICKET_NOT_USD", "LOCATION_APPROX", "HOTEL_PRICES_PARTIAL"] as const;
export const COMPONENTS = ["ticket", "flight", "hotel"] as const;
export type ComponentKind = (typeof COMPONENTS)[number];

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Unavailable {
  status: "unavailable";
  reason: string;
}
export interface TicketView {
  status: "ok";
  pricePerPerson: string;
  currency: string;
  inTotal: boolean;
  provider: string;
  link: string | null;
  fetchedAt: string | null;
  /** fix 5.1: a non-USD price converted at the CBU rate (then it is in the total) */
  fx: { usd: string; rate: string; date: string } | null;
}
export interface FlightView {
  status: "ok";
  provider: string;
  origin: string;
  destination: string;
  departAt: string;
  returnAt: string | null;
  airline: string | null;
  flightNumber: string | null;
  transfers: number | null;
  returnTransfers: number | null;
  pricePerPerson: string | null;
  total: string;
  link: string | null;
  fetchedAt: string | null;
  datesShifted: boolean;
}
export interface HotelView {
  status: "ok";
  provider: string;
  name: string;
  stars: number | null;
  rating: string | null;
  distanceM: number | null;
  nights: number | null;
  rooms: number | null;
  total: string;
  refundable: boolean | null;
  board: string | null;
  link: string | null;
  mapLink: string | null;
  fetchedAt: string | null;
}
export interface OfferView {
  offerId: string;
  userId: string;
  eventId: string;
  tier: OfferTier;
  travellers: number;
  createdAt: string;
  expiresAt: string;
  status: OfferStatus;
  ticket: TicketView | Unavailable;
  flight: FlightView | Unavailable;
  hotel: HotelView | Unavailable;
  total: string;
  perPerson: string;
  missing: ComponentKind[];
  trip: {
    kind: "trip" | "ticket_only" | "not_available";
    reason: string | null;
    city: string | null;
    iata: string | null;
    venue: string | null;
    approx: boolean;
    outDate: string | null;
    backDate: string | null;
    nights: number | null;
  } | null;
  departure: OfferSnapshotAdmin["departure"];
  notes: string[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v : null);
const re = (v: unknown, r: RegExp): string | null => (typeof v === "string" && r.test(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const IATA = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const iso = (v: unknown): string | null => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);
const BAD: Unavailable = { status: "unavailable", reason: "BAD_DATA" };

/** clickable link: https with a dotted host and no credentials (defence in depth after admin-bff) */
export function httpsLink(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".") ? u.href : null;
  } catch {
    return null;
  }
}

function unavailable(v: Rec): Unavailable {
  return { status: "unavailable", reason: re(v.reason, CODE) ?? "BAD_DATA" };
}

function ticketOf(v: unknown): TicketView | Unavailable {
  if (!isRec(v)) return BAD;
  if (v.status === "unavailable") return unavailable(v);
  const price = re(v.price_per_person, MONEY);
  const currency = re(v.currency, /^[A-Z]{3}$/);
  if (v.status !== "ok" || !price || !currency) return BAD;
  return {
    status: "ok",
    pricePerPerson: price,
    currency,
    inTotal: v.in_total === true,
    provider: str(v.provider, 64) ?? "—",
    link: httpsLink(v.deeplink),
    fetchedAt: iso(v.fetched_at),
    fx: currency === "USD" ? null : fxOf(v.fx),
  };
}

/** fix 5.1: {price_per_person_usd, rate, date, source: "cbu.uz"} — the CBU conversion of a ticket price */
function fxOf(v: unknown): TicketView["fx"] {
  if (!isRec(v) || v.source !== "cbu.uz") return null;
  const usd = re(v.price_per_person_usd, MONEY);
  const rate = re(v.rate, /^\d{1,9}(\.\d{1,12})?$/);
  const date = re(v.date, /^\d{4}-\d{2}-\d{2}$/);
  return usd && rate && date ? { usd, rate, date } : null;
}

/** «≈ $309» — a converted price: whole dollars when there are no cents */
export const fmtApproxUsd = (usd: string): string => `≈ ${fmtUsd(usd, 2).replace(/\.00$/, "")}`;
/** "2026-10-11" → "11.10" — the date of the CBU rate */
export const fxDay = (d: string): string => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

function flightOf(v: unknown): FlightView | Unavailable {
  if (!isRec(v)) return BAD;
  if (v.status === "unavailable") return unavailable(v);
  const origin = re(v.origin, IATA);
  const destination = re(v.destination, IATA);
  const total = re(v.total, MONEY);
  const departAt = iso(v.depart_at);
  if (v.status !== "ok" || !origin || !destination || !total || !departAt) return BAD;
  return {
    status: "ok",
    provider: str(v.provider, 64) ?? "aviasales",
    origin,
    destination,
    departAt,
    returnAt: iso(v.return_at),
    airline: re(v.airline, /^[A-Z0-9]{2,3}$/),
    flightNumber: re(v.flight_number, /^[A-Z0-9]{1,8}$/),
    transfers: int(v.transfers),
    returnTransfers: int(v.return_transfers),
    pricePerPerson: re(v.price_per_person, MONEY),
    total,
    link: httpsLink(v.deeplink),
    fetchedAt: iso(v.fetched_at),
    datesShifted: v.dates_shifted === true,
  };
}

function hotelOf(v: unknown): HotelView | Unavailable {
  if (!isRec(v)) return BAD;
  if (v.status === "unavailable") return unavailable(v);
  const name = str(v.name);
  const total = re(v.total, MONEY);
  if (v.status !== "ok" || !name || !total) return BAD;
  const map = isRec(v.map) ? v.map : {};
  return {
    status: "ok",
    provider: str(v.provider, 64) ?? "liteapi",
    name,
    stars: int(v.stars),
    rating: re(v.rating, /^\d{1,2}(\.\d{1,2})?$/),
    distanceM: int(v.distance_m),
    nights: int(v.nights),
    rooms: int(v.rooms),
    total,
    refundable: typeof v.refundable === "boolean" ? v.refundable : null,
    board: str(v.board, 100),
    link: httpsLink(v.deeplink),
    mapLink: httpsLink(map.osm) ?? httpsLink(map.google),
    fetchedAt: iso(v.fetched_at),
  };
}

function tripOf(v: unknown): OfferView["trip"] {
  if (!isRec(v)) return null;
  const kind = v.kind === "trip" || v.kind === "ticket_only" || v.kind === "not_available" ? v.kind : null;
  if (!kind) return null;
  const d = isRec(v.destination) ? v.destination : {};
  const venue = isRec(d.venue) ? d.venue : {};
  return {
    kind,
    reason: re(v.reason, CODE),
    city: str(d.city, 100),
    iata: re(d.iata, IATA),
    venue: str(venue.name),
    approx: venue.precision === "city",
    outDate: re(v.out_date, DATE),
    backDate: re(v.back_date, DATE),
    nights: int(v.nights),
  };
}

/** OfferSnapshotAdmin → view; null when even the skeleton is unusable (the block shows «data damaged») */
export function toOfferView(s: OfferSnapshotAdmin | null | undefined): OfferView | null {
  if (!s || !isRec(s.offer) || !OFFER_TIERS.includes(s.tier)) return null;
  const o = s.offer;
  const totals = isRec(o.totals) ? o.totals : null;
  const total = totals ? re(totals.total, MONEY) : null;
  const perPerson = totals ? re(totals.per_person, MONEY) : null;
  const status = OFFER_STATUSES.includes(o.status as OfferStatus) ? (o.status as OfferStatus) : null;
  if (!total || !perPerson || !status || !iso(s.expires_at) || !iso(s.created_at)) return null;
  const missing = Array.isArray(totals!.missing) ? COMPONENTS.filter((c) => (totals!.missing as unknown[]).includes(c)) : [];
  return {
    offerId: s.offer_id,
    userId: s.user_id,
    eventId: s.event_id,
    tier: s.tier,
    travellers: s.travellers,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    status,
    ticket: ticketOf(o.ticket),
    flight: flightOf(o.flight),
    hotel: hotelOf(o.hotel),
    total,
    perPerson,
    missing,
    trip: tripOf(s.trip),
    departure: s.departure && IATA.test(s.departure.iata) ? s.departure : null,
    notes: Array.isArray(s.notes) ? s.notes.filter((n) => typeof n === "string" && CODE.test(n)) : [],
  };
}

export const isExpired = (v: Pick<OfferView, "expiresAt">, now: number): boolean => Date.parse(v.expiresAt) <= now;

/** "$142.00" for USD; "850 000 UZS" for other currencies (amount grouped by the locale, no conversion) */
export function fmtMoney(amount: string, currency: string, lang: Lang): string {
  return currency === "USD" ? fmtUsd(amount, 2) : `${fmtAmount(amount, lang)} ${currency}`;
}

/**
 * Wall-clock date and time of a flight at the departure place, from the offset carried by the string itself
 * ("2026-11-13T07:40:00+05:00" → 13.11 07:40): support sees what the user saw, not the operator's time zone.
 */
export function localClock(isoTime: string): { date: string; time: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(isoTime);
  return m ? { date: `${m[3]}.${m[2]}`, time: `${m[4]}:${m[5]}` } : null;
}

/** "2026-11-13" → "13.11.2026" (trip dates are local dates of the event place, no time zone) */
export function fmtTripDate(d: string | null): string {
  const m = d ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(d) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "—";
}

/** human label of a code family (offer.reason.<CODE>, offer.trip.<CODE>, offer.note.<CODE>); unknown → the code */
export function codeLabel(t: (k: MessageKey) => string, family: "reason" | "trip" | "note", code: string): string {
  const key = `offer.${family}.${code}` as MessageKey;
  return key in DICTS.ru ? t(key) : code;
}

/** the snapshot belongs to another user than the ticket's author (telegram-bff checks ownership — this is a red flag) */
export const foreignSnapshot = (v: Pick<OfferView, "userId">, ticketUserId: string | null): boolean =>
  !!ticketUserId && v.userId.toLowerCase() !== ticketUserId.toLowerCase();
