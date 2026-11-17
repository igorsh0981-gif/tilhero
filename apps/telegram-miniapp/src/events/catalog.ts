/**
 * Catalogue filters ↔ GET /v1/events and GET /v1/events/facets queries (pure; tested in test/events.test.ts).
 * Only contract parameters are produced (bff.ts: q ≤ 100, category code or "other", ISO-2 countries — several,
 * comma-separated, ≤ 20 (fix 4.1), YYYY-MM-DD dates, has_tickets, online, sort; facets — + month_from/month_to). Dates are calendar dates in the
 * viewer's calendar — the catalogue compares them with the event's local date.
 */
import type { EventLifecycleStatus, EventSort, GeoOption } from "@tilhero/contracts/bff";
import type { EventsFacetsQuery, EventsFilterQuery, EventsQuery } from "../api/endpoints";
import { DICTS, type Lang, type MessageKey } from "../i18n";

export type DateRange = "any" | "month" | "3" | "6" | "12";
export type FormatFilter = "any" | "online" | "offline";

export interface CatalogFilters {
  q: string;
  /** taxonomy code (with children) or OTHER_CATEGORY — events without a category */
  category: string | null;
  /** ISO-2, in the order picked; empty = any country */
  countries: string[];
  dates: DateRange;
  hasTickets: boolean;
  format: FormatFilter;
  sort: EventSort;
}

export const DEFAULT_FILTERS: CatalogFilters = {
  q: "",
  category: null,
  countries: [],
  dates: "any",
  hasTickets: false,
  format: "any",
  sort: "soonest",
};

export const PAGE_SIZE = 20;
export const Q_MAX = 100;
/** Countries in one request (telegram-bff / event-catalog limit). */
export const MAX_COUNTRIES = 20;
/** Category filter for events without a taxonomy code (event-catalog `category=other`). */
export const OTHER_CATEGORY = "other";

const CATEGORY_RE = /^[a-z][a-z_]{0,31}(\.[a-z][a-z_]{0,31})?$/;
const ISO2 = /^[A-Za-z]{2}$/;

/** Valid ISO-2 codes, upper case, de-duplicated, at most MAX_COUNTRIES (order kept). */
export function cleanCountries(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const c of list) {
    if (typeof c !== "string" || !ISO2.test(c)) continue;
    const code = c.toUpperCase();
    if (!out.includes(code)) out.push(code);
    if (out.length >= MAX_COUNTRIES) break;
  }
  return out;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** [date_from, date_to] for a range relative to `today` (viewer's calendar). */
export function dateWindow(range: DateRange, today: Date): [string, string] | null {
  if (range === "any") return null;
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const to =
    range === "month"
      ? new Date(today.getFullYear(), today.getMonth() + 1, 0)
      : new Date(today.getFullYear(), today.getMonth() + Number(range), today.getDate());
  return [ymd(from), ymd(to)];
}

/** Window of the «В этом месяце» chip: today .. the last day of the month, in the viewer's calendar. The search
 *  (dates "month") and the chip counter (facets month_from/month_to) both take it from here — the number on the
 *  chip is counted over the very window the chip filters by. */
export const monthWindow = (today: Date): [string, string] => dateWindow("month", today)!;

/** Filter parameters shared by the search and the counters (no sort/limit/cursor, no counter window). */
function filterParams(f: CatalogFilters, today: Date): EventsFilterQuery {
  const q: EventsFilterQuery = {};
  const text = f.q.replace(/\s+/g, " ").trim().slice(0, Q_MAX);
  if (text) q.q = text;
  if (f.category && CATEGORY_RE.test(f.category)) q.category = f.category;
  // sorted: the same set of countries is the same request (and the same BFF cache entry) whatever the click order
  const countries = cleanCountries(f.countries).sort();
  if (countries.length) q.country = countries.join(",");
  const w = dateWindow(f.dates, today);
  if (w) [q.date_from, q.date_to] = w;
  if (f.hasTickets) q.has_tickets = "true";
  if (f.format !== "any") q.online = f.format === "online" ? "true" : "false";
  return q;
}

/** Quick-chip counters: the search filters + the window of the «В этом месяце» chip (this_month is counted over
 *  the viewer's local month window, not the catalogue's UTC one). */
export function filtersToFacetsQuery(f: CatalogFilters, today: Date): EventsFacetsQuery {
  const [month_from, month_to] = monthWindow(today);
  return { ...filterParams(f, today), month_from, month_to };
}

export function filtersToQuery(f: CatalogFilters, today: Date, cursor?: string | null): EventsQuery {
  const q: EventsQuery = { sort: f.sort, limit: PAGE_SIZE, ...filterParams(f, today) };
  if (cursor) q.cursor = cursor;
  return q;
}

/** Badge on the «Фильтры» button: every non-default filter except the search text; each picked country counts. */
export function activeFilterCount(f: CatalogFilters): number {
  return (
    (f.category ? 1 : 0) +
    f.countries.length +
    (f.dates !== "any" ? 1 : 0) +
    (f.hasTickets ? 1 : 0) +
    (f.format !== "any" ? 1 : 0) +
    (f.sort !== DEFAULT_FILTERS.sort ? 1 : 0)
  );
}

export const isDefaultFilters = (f: CatalogFilters): boolean => activeFilterCount(f) === 0 && !f.q.trim();

/** Stable key of a search (to drop responses of an outdated query). */
export const queryKey = (q: EventsQuery | EventsFacetsQuery): string => JSON.stringify(Object.entries(q).filter(([k]) => k !== "cursor").sort());

// ---------------------------------------------------------------- saved filters (fix 4.1)

/** Filters kept between launches: everything but the search text (a search is a one-off, not a preference). */
export type SavedFilters = Omit<CatalogFilters, "q">;

const DATES: readonly DateRange[] = ["any", "month", "3", "6", "12"];
const FORMATS: readonly FormatFilter[] = ["any", "online", "offline"];
const SORTS: readonly EventSort[] = ["soonest", "newest", "quality"];

/** JSON for the store, or null when nothing differs from the defaults (then the saved entry is removed). */
export function serializeFilters(f: CatalogFilters): string | null {
  const s: SavedFilters = {
    category: f.category && CATEGORY_RE.test(f.category) ? f.category : null,
    countries: cleanCountries(f.countries),
    dates: f.dates,
    hasTickets: f.hasTickets,
    format: f.format,
    sort: f.sort,
  };
  if (activeFilterCount({ ...s, q: "" }) === 0) return null;
  return JSON.stringify({ v: 1, ...s });
}

/** Saved JSON → filters; anything unknown or malformed falls back to the default of that field (store is untrusted). */
export function parseSavedFilters(raw: string | null | undefined): SavedFilters | null {
  if (!raw || raw.length > 4096) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o) || (o as { v?: unknown }).v !== 1) return null;
  const x = o as Record<string, unknown>;
  return {
    category: typeof x.category === "string" && CATEGORY_RE.test(x.category) ? x.category : null,
    countries: Array.isArray(x.countries) ? cleanCountries(x.countries) : [],
    dates: DATES.includes(x.dates as DateRange) ? (x.dates as DateRange) : "any",
    hasTickets: x.hasTickets === true,
    format: FORMATS.includes(x.format as FormatFilter) ? (x.format as FormatFilter) : "any",
    sort: SORTS.includes(x.sort as EventSort) ? (x.sort as EventSort) : DEFAULT_FILTERS.sort,
  };
}

// ---------------------------------------------------------------- lifecycle & categories

export type Tone = "good" | "info" | "warn" | "bad" | "lime" | undefined;

/** Badge tone per lifecycle status (prototype v9 LIFE map). */
export const LIFECYCLE_TONE: Record<EventLifecycleStatus, Tone> = {
  DISCOVERED: undefined,
  VERIFIED: undefined,
  ANNOUNCED: "info",
  SALES_SOON: "info",
  ON_SALE: "good",
  LOW_INVENTORY: "warn",
  SOLD_OUT: undefined,
  RESALE: undefined,
  COMPLETED: undefined,
  POSTPONED: "bad",
  CANCELLED: "bad",
};

/** Top-level taxonomy code of an event ("sport.motorsport" → "sport"); drives the fallback tint and icon. */
export function topCategory(categories: readonly string[]): string {
  const first = categories[0] ?? "";
  return first.split(".")[0] || "other";
}

export const KNOWN_TOP = ["music", "sport", "business", "culture", "education", "festivals"] as const;

// ---------------------------------------------------------------- countries (sprint 4: AI sources in the CIS)

/** Countries of the AI sources (discovery DISCOVERY_AI_COUNTRIES): their RU/EN names live in the dictionaries
 *  («Кыргызстан», not the ICU «Киргизия» — the same as the preferences directory), so the filter, cards and the
 *  detail agree, also in WebViews without Intl.DisplayNames. */
export const CIS_AI_COUNTRIES = ["UZ", "KZ", "KG", "AZ", "GE", "AM"] as const;
type CisCountry = (typeof CIS_AI_COUNTRIES)[number];
const isCis = (code: string): code is CisCountry => (CIS_AI_COUNTRIES as readonly string[]).includes(code);

/** Local RU/EN label of a CIS AI country (null for other codes — they come from the directory or Intl). */
export function localCountryLabel(code: string): { ru: string; en: string } | null {
  const c = code.toUpperCase();
  if (!isCis(c)) return null;
  const key = `country.${c}` as MessageKey;
  return { ru: DICTS.ru[key], en: DICTS.en[key] };
}

export const localCountryName = (code: string, lang: Lang): string | null => localCountryLabel(code)?.[lang] ?? null;

/**
 * Country options of the catalogue filter: the preferences directory (its order and labels; ISO-2 codes only,
 * de-duplicated), an empty label filled from the local CIS names; CIS AI countries the directory lacks
 * (old/failed directory) go first, so the filter always offers the countries of the AI sources.
 */
export function countryOptions(geos: readonly GeoOption[]): Array<{ code: string; label: { ru: string; en: string } }> {
  const seen = new Set<string>();
  const fromDir: Array<{ code: string; label: { ru: string; en: string } }> = [];
  for (const g of geos) {
    if (g.level !== "country" || !g.code || !/^[A-Za-z]{2}$/.test(g.code)) continue;
    const code = g.code.toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    const local = localCountryLabel(code);
    const ru = g.label?.ru?.trim() || local?.ru || g.label?.en?.trim() || code;
    const en = g.label?.en?.trim() || local?.en || g.label?.ru?.trim() || code;
    fromDir.push({ code, label: { ru, en } });
  }
  const missing = CIS_AI_COUNTRIES.filter((c) => !seen.has(c)).map((code) => ({ code, label: localCountryLabel(code)! }));
  return [...missing, ...fromDir];
}
