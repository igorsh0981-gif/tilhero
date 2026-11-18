import type { NewsAdminItem, NewsSource, NewsSourceCheck, NewsSourceCheckInput, NewsSourceInput, WatchChangeType, WatchStats } from "@tilhero/contracts/admin";
import type { Lang, MessageKey } from "../../i18n";
import { DICTS } from "../../i18n";
import type { Tone } from "../../ui/kit";

/* Pure helpers of the sprint-6 content screens: news feeds (form, validation, health), news, Watch statistics. */

export const NEWS_LANGS = ["ru", "en", "uz"] as const;
export type NewsLang = (typeof NEWS_LANGS)[number];
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
export const DOMAIN_RE = new RegExp(`^${LABEL}(\\.${LABEL})+$`);
export const CATEGORY_RE = /^[^\s"'<>\\]{1,100}$/;
export const NAME_MAX = 120;
export const ENTITY_MAX = 80;
export const INTERESTS_MAX = 10;
export const ENTITIES_MAX = 20;
export const DOMAINS_MAX = 10;
export const REASON_MIN = 3;
export const HIDE_REASON_MAX = 300;
/** a feed that was fetched more than this ago is «late» (collection runs every 2 h — NEWS_FETCH_MINUTES) */
export const FETCH_LATE_MS = 5 * 3600_000;

/* ---------------------------------------------------------------- feed health */

export type HealthState = "ok" | "error" | "late" | "never" | "off";
export const HEALTH_TONE: Record<HealthState, Tone> = { ok: "good", error: "bad", late: "warn", never: "neutral", off: "neutral" };

/**
 * State of a feed for the table: off — switched off; never — not collected yet; error — the last collection failed
 * (an error newer than the last success); late — enabled but not fetched for FETCH_LATE_MS; ok otherwise.
 */
export function healthState(s: Pick<NewsSource, "enabled" | "health">, now = Date.now()): HealthState {
  if (!s.enabled) return "off";
  const h = s.health;
  if (!h.last_fetch_at && !h.last_ok_at) return h.last_error ? "error" : "never";
  if (h.last_error && (!h.last_ok_at || !h.last_error.at || Date.parse(h.last_error.at) >= Date.parse(h.last_ok_at))) return "error";
  const last = Date.parse(h.last_fetch_at ?? h.last_ok_at ?? "");
  if (Number.isFinite(last) && now - last > FETCH_LATE_MS) return "late";
  return "ok";
}

/** Known collection/check error codes with a human label (feed.code.<CODE>); others are shown as the code. */
export const FEED_CODES = [
  "SOURCE_FETCH_FAILED",
  "SOURCE_ROBOTS_DISALLOWED",
  "SOURCE_TIMEOUT",
  "SOURCE_TOO_LARGE",
  "FEED_INVALID",
  "FEED_EMPTY",
  "FEED_DTD_FORBIDDEN",
  "FEED_NOT_FOUND",
  "PAGE_NO_ITEMS",
  "SSRF_BLOCKED",
  "REDIRECT_FOREIGN",
  "AI_BUDGET_EXHAUSTED",
  "AI_PAUSED",
  "PROVIDER_UNAVAILABLE",
  // fix 8.1: the exact reason of a failed collection (news FEED_* codes)
  "FEED_HTTP_401",
  "FEED_HTTP_403",
  "FEED_HTTP_404",
  "FEED_HTTP_410",
  "FEED_HTTP_429",
  "FEED_HTTP_4XX",
  "FEED_HTTP_5XX",
  "FEED_TIMEOUT",
  "FEED_NETWORK",
  "FEED_HOST_BUSY",
  "FEED_FETCH_FAILED",
  "FEED_ROBOTS_DISALLOWED",
  "FEED_ROBOTS_UNAVAILABLE",
  "FEED_REDIRECT_FOREIGN",
  "FEED_REDIRECT_LOOP",
  "FEED_URL_NOT_ALLOWED",
  "FEED_SSRF_BLOCKED",
  "FEED_NOT_FEED",
  "FEED_NOT_HTML",
  "FEED_NOT_XML",
  "FEED_TOO_LARGE",
  "FEED_ENCODING",
  "FEED_FOREIGN_LINKS",
  "FEED_NO_HTTPS_LINKS",
  "FEED_EMPTY_BODY",
  "DEADLINE_EXCEEDED",
  "INTERNAL_ERROR",
  "GATEWAY_UNAVAILABLE",
  "UPSTREAM_UNAVAILABLE",
] as const;
export function feedCodeLabel(t: (k: MessageKey) => string, code: string): string {
  const key = `feed.code.${code}` as MessageKey;
  return key in DICTS.ru ? t(key) : code;
}
/** why a check would drop an entry (dropped): link_foreign, no_https, category_filter, duplicate, old… */
export const DROP_REASONS = ["link_foreign", "no_https", "category_filter", "duplicate", "no_title", "too_old", "rejected"] as const;
export function dropLabel(t: (k: MessageKey) => string, reason: string): string {
  const key = `feed.drop.${reason}` as MessageKey;
  return key in DICTS.ru ? t(key) : reason;
}

/* ---------------------------------------------------------------- form */

export interface FeedForm {
  slug: string;
  name: string;
  kind: NewsSourceInput["kind"];
  mode: NewsSourceInput["mode"];
  feed_url: string;
  page_url: string;
  site_domain: string;
  extra_domains: string[];
  interests: string[];
  entities: string[];
  country_code: string; // "" — international
  lang: NewsLang;
  display: NewsSourceInput["display"];
  category_filter: string;
  enabled: boolean;
  reason: string;
}

export const emptyFeedForm = (): FeedForm => ({
  slug: "",
  name: "",
  kind: "media",
  mode: "rss",
  feed_url: "",
  page_url: "",
  site_domain: "",
  extra_domains: [],
  interests: [],
  entities: [],
  country_code: "",
  lang: "ru",
  display: "summary",
  category_filter: "",
  // a new feed starts switched off: the operator checks it, saves, then switches it on
  enabled: false,
  reason: "",
});

export const formFromSource = (s: NewsSource): FeedForm => ({
  slug: s.slug,
  name: s.name,
  kind: s.kind,
  mode: s.mode,
  feed_url: s.feed_url ?? "",
  page_url: s.page_url ?? "",
  site_domain: s.site_domain,
  extra_domains: [...s.extra_domains],
  interests: [...s.interests],
  entities: [...s.entities],
  country_code: s.country_code ?? "",
  lang: (NEWS_LANGS as readonly string[]).includes(s.lang) ? s.lang : "ru",
  display: s.display,
  category_filter: s.category_filter ?? "",
  enabled: s.enabled,
  reason: "",
});

const orNull = (v: string) => (v.trim() ? v.trim() : null);

export function inputFromForm(f: FeedForm): NewsSourceInput {
  return {
    slug: f.slug.trim(),
    name: f.name.trim(),
    kind: f.kind,
    mode: f.mode,
    // only the URL of the chosen mode is sent: an rss feed has no page and vice versa
    feed_url: f.mode === "rss" ? orNull(f.feed_url) : null,
    page_url: f.mode === "html" ? orNull(f.page_url) : null,
    site_domain: f.site_domain.trim().toLowerCase(),
    extra_domains: f.extra_domains,
    interests: f.interests,
    entities: f.entities.map((e) => e.trim()).filter(Boolean),
    country_code: f.country_code || null,
    lang: f.lang,
    display: f.display,
    category_filter: orNull(f.category_filter),
    enabled: f.enabled,
  };
}

/** Fields of the feed itself: the check is valid only for these values. */
export function checkInputFromForm(f: FeedForm): NewsSourceCheckInput {
  const i = inputFromForm(f);
  return { mode: i.mode, feed_url: i.feed_url, page_url: i.page_url, site_domain: i.site_domain, extra_domains: i.extra_domains, category_filter: i.category_filter };
}
export const checkSignature = (f: FeedForm) => JSON.stringify(checkInputFromForm(f));

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** PATCH body: only the changed fields + expected_version + reason; `changed` names them (for the footer line). */
export function patchFromForm(s: NewsSource, f: FeedForm): { body: Record<string, unknown>; changed: string[]; feedChanged: boolean } {
  const next = inputFromForm(f);
  const body: Record<string, unknown> = {};
  const changed: string[] = [];
  const cur: Record<string, unknown> = { ...s };
  for (const k of Object.keys(next) as Array<keyof NewsSourceInput>) {
    if (k === "slug") continue;
    const a = next[k];
    const b = cur[k];
    const same = Array.isArray(a) && Array.isArray(b) ? sameList(a, b as string[]) : a === b;
    if (!same) {
      body[k] = a;
      changed.push(k);
    }
  }
  const feedChanged = changed.some((k) => ["mode", "feed_url", "page_url", "site_domain", "extra_domains", "category_filter"].includes(k));
  return { body: { expected_version: s.version, ...body, reason: f.reason.trim() }, changed, feedChanged };
}

export type FeedErrors = Partial<Record<keyof FeedForm, string>>;

function hostOf(u: string): string | null {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && !x.username && !x.password ? x.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}
export const onDomain = (host: string, domains: readonly string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));

/** Same rules as admin-bff (first line; news checks again). Error values are keys of feed.err.* */
export function validateFeed(f: FeedForm, creating: boolean, withReason = true): FeedErrors {
  const e: FeedErrors = {};
  if (creating && !SLUG_RE.test(f.slug.trim())) e.slug = "slug";
  if (!f.name.trim()) e.name = "name";
  else if (f.name.trim().length > NAME_MAX) e.name = "nameLong";
  const site = f.site_domain.trim().toLowerCase();
  if (!DOMAIN_RE.test(site)) e.site_domain = "domain";
  const url = f.mode === "rss" ? f.feed_url.trim() : f.page_url.trim();
  const urlKey = f.mode === "rss" ? "feed_url" : "page_url";
  if (!url) e[urlKey] = f.mode === "rss" ? "feedUrl" : "pageUrl";
  else {
    const host = hostOf(url);
    if (!host) e[urlKey] = "https";
    else if (DOMAIN_RE.test(site) && !onDomain(host, [site, ...f.extra_domains])) e[urlKey] = "urlDomain";
  }
  if (f.interests.length < 1) e.interests = "interests";
  if (f.category_filter.trim() && !CATEGORY_RE.test(f.category_filter.trim())) e.category_filter = "category";
  if (withReason && f.reason.trim().length < REASON_MIN) e.reason = "reason";
  return e;
}

/** host of the URL in the form (for the domain suggestion: the operator pastes the feed and gets site_domain). */
export function suggestDomain(url: string): string | null {
  const h = hostOf(url.trim());
  if (!h) return null;
  return h.replace(/^(www|feeds?|rss|news)\./, "");
}

/** summary/title_only check result in words */
export function checkUsable(c: NewsSourceCheck): number {
  return c.items.filter((x) => !x.dropped).length;
}

/* ---------------------------------------------------------------- news */

export const SIG_TONE: Record<string, Tone> = { high: "bad", mid: "warn", low: "neutral" };

/** Summary in the UI language, the other language as a fallback (title_only feeds have none). */
export function summaryFor(n: Pick<NewsAdminItem, "summary_ru" | "summary_en">, lang: Lang): string | null {
  return lang === "ru" ? (n.summary_ru ?? n.summary_en) : (n.summary_en ?? n.summary_ru);
}

/** host for the «source» line: the source domain, else the link's host */
export function newsDomain(n: Pick<NewsAdminItem, "url" | "source">): string {
  if (n.source.domain) return n.source.domain;
  try {
    return new URL(n.url).hostname.replace(/^www\./, "");
  } catch {
    return "—";
  }
}

/* ---------------------------------------------------------------- Watch */

export const WATCH_CHANGE_TYPES: readonly WatchChangeType[] = ["price_drop", "price_rise", "lifecycle", "tickets", "flight", "hotel"];
export const NOTIFY_KINDS = ["immediate", "digest", "suppressed"] as const;

export function watchTotals(s: WatchStats): { changes: number; notified: number; errorRate: number | null } {
  const changes = WATCH_CHANGE_TYPES.reduce((a, k) => a + (s.changes_24h[k] ?? 0), 0);
  const notified = s.notifications_24h.immediate + s.notifications_24h.digest;
  const errorRate = s.rechecks_24h > 0 ? s.errors_24h / s.rechecks_24h : null;
  return { changes, notified, errorRate };
}
