import type { DiscoveryRunStatus, ReviewRejectReason, ReviewStatus, SourceCrawlStats, SourceTierCode } from "@tilhero/contracts/admin";
import type { Lang, MessageKey } from "../../i18n";
import { DICTS } from "../../i18n";
import type { Tone } from "../../ui/kit";

/* Shared vocabulary of the sprint-4 «Event catalog» screens: review, sources, discovery (docs/sprint4). */

/** Countries of the AI search (DISCOVERY_AI_COUNTRIES) — first in every country filter. */
export const AI_COUNTRIES = ["UZ", "KZ", "KG", "AZ", "GE", "AM"] as const;
/** A few more for sources outside the sprint scope (the registry accepts any ISO-2). */
export const MORE_COUNTRIES = ["TJ", "TM", "RU", "BY", "TR", "AE", "GB", "US", "DE", "FR"] as const;

/**
 * Countries named explicitly in both languages (fix 4.1): Intl gives «Киргизия» for KG, the customer wants the
 * official «Кыргызстан»; the CIS neighbours are pinned too so a browser/ICU update cannot rename them. Labels live in
 * the dictionaries (country.<CODE>); every other code goes through Intl.DisplayNames.
 */
export const NAMED_COUNTRIES = ["UZ", "KZ", "KG", "AZ", "GE", "AM", "TJ", "TM", "RU", "BY"] as const;
const NAMED = new Set<string>(NAMED_COUNTRIES);

const regionNames = new Map<Lang, Intl.DisplayNames | null>();
/** "KG" → «Кыргызстан» / "Kyrgyzstan" (dictionary for the CIS, Intl for the rest); unknown → the code itself. */
export function countryName(lang: Lang, code: string | null | undefined): string {
  if (!code) return "—";
  if (NAMED.has(code)) return DICTS[lang][`country.${code}` as MessageKey];
  let dn = regionNames.get(lang);
  if (dn === undefined) {
    try {
      dn = new Intl.DisplayNames([lang === "ru" ? "ru" : "en"], { type: "region" });
    } catch {
      dn = null;
    }
    regionNames.set(lang, dn);
  }
  try {
    return (dn && /^[A-Z]{2}$/.test(code) && dn.of(code)) || code;
  } catch {
    return code;
  }
}

export function countryOptions(lang: Lang, extra: Iterable<string | null | undefined> = []): string[] {
  const seen = new Set<string>(AI_COUNTRIES);
  const rest = [...new Set([...extra].filter((c): c is string => !!c && /^[A-Z]{2}$/.test(c) && !seen.has(c)))];
  return [...AI_COUNTRIES, ...rest.sort((a, b) => countryName(lang, a).localeCompare(countryName(lang, b)))];
}

/* ---------------------------------------------------------------- review reasons */

/**
 * Review reason codes written by verification (sprint 3–4) and the catalogue guard (CATALOG_REJECTED + a code).
 * Tone: bad — the candidate cannot be published as is; warn — sources disagree; info — weak evidence.
 */
export const REVIEW_REASONS: Readonly<Record<string, Tone>> = {
  LOW_CONFIDENCE: "info",
  NO_MEDIA: "info",
  SOURCE_CONFLICT: "warn",
  CONFLICT_SAME_RANK: "warn",
  CONFLICT_LOST: "warn",
  CONFLICT_WON: "info",
  EVIDENCE_RANK_TOO_LOW: "warn",
  CATALOG_REJECTED: "bad",
  SOURCE_NOT_ALLOWED: "bad",
  PROVIDER_INVALID: "bad",
  PROVIDER_UNKNOWN: "bad",
  EXTERNAL_ID_EMPTY: "bad",
  SOURCE_URL_NOT_ALLOWED: "bad",
  OFFICIAL_URL_NOT_ALLOWED: "bad",
  URL_NOT_ALLOWED: "bad",
  TITLE_EMPTY: "bad",
  LOCATION_MISSING: "bad",
  DATE_INVALID: "bad",
  EVENT_IN_PAST: "bad",
};

/** Human label of a reason code; unknown codes are shown as the code (never hidden). */
export function reasonLabel(t: (k: MessageKey) => string, code: string): string {
  const key = `reason.${code}` as MessageKey;
  return key in DICTS.ru ? t(key) : code;
}
export function reasonHint(t: (k: MessageKey) => string, code: string): string | undefined {
  const key = `reason.${code}.h` as MessageKey;
  return key in DICTS.ru ? t(key) : undefined;
}
export const reasonTone = (code: string): Tone => REVIEW_REASONS[code] ?? "neutral";

/** EXPIRED («Not confirmed», fix 5.1) right after OPEN: the next thing an operator looks for */
export const REVIEW_STATUSES: readonly ReviewStatus[] = ["OPEN", "EXPIRED", "ACCEPTED", "CORRECTED", "REJECTED", "SUPERSEDED", "DISMISSED"];
export const REVIEW_STATUS_TONE: Record<ReviewStatus, Tone> = {
  OPEN: "warn",
  EXPIRED: "outline",
  ACCEPTED: "good",
  CORRECTED: "good",
  REJECTED: "bad",
  SUPERSEDED: "neutral",
  DISMISSED: "neutral",
};
export const REJECT_REASONS: readonly ReviewRejectReason[] = ["NOT_AN_EVENT", "DUPLICATE", "WRONG_FACTS", "SOURCE_UNRELIABLE", "OTHER"];

/* ---------------------------------------------------------------- sources */

export const TIERS: readonly SourceTierCode[] = ["OFFICIAL_ORGANIZER", "OFFICIAL_TICKET_PROVIDER", "TRUSTED_STRUCTURED", "TRUSTED_MEDIA"];
export const TIER_TONE: Record<string, Tone> = { OFFICIAL_ORGANIZER: "good", OFFICIAL_TICKET_PROVIDER: "info", TRUSTED_STRUCTURED: "neutral", TRUSTED_MEDIA: "outline" };

/** Event taxonomy codes (services/preferences directory/taxonomy.py) — labels in the dictionaries (tax.<code>). */
export const TAXONOMY: readonly string[] = [
  "music", "music.concerts", "music.jazz", "music.classical", "music.electronic", "music.pop_rock",
  "sport", "sport.motorsport", "sport.football", "sport.tennis", "sport.basketball", "sport.combat", "sport.esports", "sport.other",
  "business", "business.ai", "business.fintech", "business.startups", "business.conferences", "business.expo",
  "culture", "culture.theatre", "culture.exhibitions", "culture.cinema", "culture.opera_ballet",
  "education", "education.lectures", "education.workshops",
  "festivals", "festivals.music", "festivals.city", "festivals.food",
];
export function categoryLabel(t: (k: MessageKey) => string, code: string | null | undefined): string {
  if (!code) return "—";
  const key = `tax.${code}` as MessageKey;
  return key in DICTS.ru ? t(key) : code;
}

/* ---------------------------------------------------------------- last crawl of a source (fix 4.1) */

/** Codes of a skipped/failed crawl with their own label and hint (crawl.code.<CODE>, crawl.code.<CODE>.h). */
export const CRAWL_CODES = [
  "SOURCE_ROBOTS_DISALLOWED",
  "SOURCE_NO_CONTENT",
  "SOURCE_FETCH_FAILED",
  "SOURCE_TOO_LARGE",
  "SOURCE_NOT_HTML",
  "SOURCE_DEADLINE",
  "SOURCE_NO_LISTING_PAGES",
  "PROVIDER_BAD_RESPONSE",
  "SOURCE_NOT_JSON", // 9.3: страница «JSON API»
  "SOURCE_SCHEMA_MISMATCH",
] as const;
/** Why verification discarded an event of the page (provider-gateway aiweb evidence / JSON-LD), crawl.skip.<reason>. */
export const CRAWL_SKIP_REASONS = [
  "shape",
  "link_unknown",
  "link_foreign",
  "link_far",
  "title_missing",
  "title_not_on_page",
  "title_mismatch",
  "date_invalid",
  "date_not_on_page",
  "date_far",
  "date_mismatch",
  "date_out_of_window",
  "date_past", // 9.1/9.2: событие уже прошло (дата без года прошла, старый пост канала, дата раньше окна)
  "city_unknown",
  "city_foreign_country", // 9.1: город другой страны (не страны источника)
  "category",
  "no_content",
  "id_missing", // 9.3: элемент JSON API без id / отменён по статусу
  "status_excluded",
  "unknown",
] as const;
/**
 * What happened to a page, not to an event (provider-gateway `notes`), crawl.note.<code>: shown as warnings apart
 * from the discarded events — some events of the page may be missing, but none was discarded by verification.
 */
export const CRAWL_NOTES = ["deadline", "part_truncated", "part_saturated", "quota_pages", "items_truncated", "pages_repeated", "unknown"] as const;

const known = (key: string): key is MessageKey => key in DICTS.ru;

/** Human label of a crawl code: own label → the discovery error label (AI_BUDGET_EXHAUSTED…) → the code itself. */
export function crawlCodeLabel(t: (k: MessageKey) => string, code: string): string {
  const own = `crawl.code.${code}`;
  if (known(own)) return t(own);
  const run = `run.err.${code}`;
  return known(run) ? t(run) : code;
}
/** What the operator can do about the code; undefined when there is nothing specific to say. */
export function crawlCodeHint(t: (k: MessageKey) => string, code: string | null | undefined): string | undefined {
  const key = `crawl.code.${code}.h`;
  return code && known(key) ? t(key) : undefined;
}
/**
 * Label of a discard reason; a page note in an older response (deadline, part_truncated were reported as discards)
 * or a crawl code used as a reason gets its label; unknown reasons stay visible as is.
 */
export function skipReasonLabel(t: (k: MessageKey) => string, reason: string): string {
  const key = `crawl.skip.${reason}`;
  if (known(key)) return t(key);
  const note = `crawl.note.${reason}`;
  return known(note) ? t(note) : crawlCodeLabel(t, reason);
}
/** Label of a page note; unknown codes go through the same fallback as discard reasons. */
export function crawlNoteLabel(t: (k: MessageKey) => string, code: string): string {
  const key = `crawl.note.${code}`;
  return known(key) ? t(key) : skipReasonLabel(t, code);
}

export type CrawlState = "ok" | "empty" | "skipped" | "error" | "never";
/** ok with events / ok without events / skipped / error / never crawled (no row or no last_crawl_at). */
export function crawlState(c: SourceCrawlStats | null | undefined): CrawlState {
  if (!c || !c.last_crawl_at || !c.outcome) return "never";
  if (c.outcome === "ok") return c.events_found > 0 ? "ok" : "empty";
  return c.outcome;
}
export const CRAWL_TONE: Record<CrawlState, Tone> = { ok: "good", empty: "neutral", skipped: "warn", error: "bad", never: "outline" };

/** Discard reasons, most frequent first (ties by code), with the total. */
export function sortedSkips(skipped: Record<string, number> | null | undefined): { total: number; items: Array<{ reason: string; n: number }> } {
  const items = Object.entries(skipped ?? {})
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .map(([reason, n]) => ({ reason, n }))
    .sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason));
  return { total: items.reduce((s, x) => s + x.n, 0), items };
}

/* ---------------------------------------------------------------- discovery */

export const RUN_STATUS_TONE: Record<DiscoveryRunStatus, Tone> = { RUNNING: "info", COMPLETED: "good", PARTIAL: "warn", FAILED: "bad" };

/** Error codes of a discovery run (discovery runner + provider-gateway ai_web) with a human label (run.err.<CODE>). */
export const RUN_ERROR_CODES = [
  "AI_BUDGET_EXHAUSTED",
  "PROVIDER_QUOTA_EXHAUSTED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_PAUSED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_BAD_RESPONSE",
  "PROVIDER_DISABLED",
  "PROVIDER_UNKNOWN",
  "SOURCE_REGISTRY_UNAVAILABLE",
  "UPSTREAM_UNAVAILABLE",
  "DISCOVERY_BUDGET_EXHAUSTED",
  "DISCOVERY_RUN_TIMEOUT",
  "DISCOVERY_RUN_INTERRUPTED",
  "COUNTRY_REQUIRED",
  "INTERNAL_ERROR",
] as const;
export function runErrorLabel(t: (k: MessageKey) => string, code: string): string {
  const key = `run.err.${code}` as MessageKey;
  return key in DICTS.ru ? t(key) : code;
}

/* ---------------------------------------------------------------- URLs and dates */

/** https URL with a host, else null (javascript:, data:, http: and relative links are never rendered as links). */
export function httpsUrl(u: string | null | undefined): URL | null {
  if (!u || u.length > 2048) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname ? url : null;
  } catch {
    return null;
  }
}

/** visible domain of a page: "https://www.iticket.uz/ru/e/1" → "iticket.uz" */
export function domainOf(u: string | null | undefined): string {
  if (!u) return "—";
  try {
    return new URL(u).hostname.replace(/^www\./, "") || "—";
  } catch {
    return "—";
  }
}

/**
 * Local event date "2026-10-21" → "21.10.2026" / "10/21/2026" — the event's own calendar day, never shifted by
 * the browser time zone (it is not an instant).
 */
export function fmtLocalDate(lang: Lang, ymd: string | null | undefined): string {
  const m = ymd ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd) : null;
  if (!m) return ymd ?? "—";
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-US", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(d);
}

/** milliseconds until the next UTC midnight (the AI budget day resets then) */
export function msToUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

/** "2:05:00" → "2 h 05 min" style is in the dictionaries; here: whole hours and minutes */
export function hoursMinutes(ms: number): { h: number; m: number } {
  const total = Math.max(0, Math.floor(ms / 60_000));
  return { h: Math.floor(total / 60), m: total % 60 };
}

export const looksLikeUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
