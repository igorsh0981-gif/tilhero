import type { Source, SourceInput, SourceJsonApiMapping, SourceListingKind, SourceListingPage, SourceListingPriority, SourceTierCode } from "@tilhero/contracts/admin";
import { TAXONOMY } from "../catalog/common";

/**
 * Client-side checks of the source form — the same rules as source-registry (docs/sprint4/INTERNAL_API.md §2.1), so
 * the operator sees the problem next to the field. The registry re-checks everything (422 SOURCE_*).
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
/** Город страницы афиши — не длиннее source-registry `CITY_MAX` (и схемы admin-bff). */
export const CITY_MAX = 80;
const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MULTI_SUFFIX = /^(com|co|org|gov|net|edu)\.[a-z]{2}$/;

export type DomainProblem = "format" | "ip" | "suffix" | "wildcard";

/** null = valid domain. `allowWildcard` — media domains may be `*.cdn.example.com`. */
export function domainProblem(raw: string, allowWildcard: boolean): DomainProblem | null {
  const d = raw.trim();
  if (!d || d.length > 253 || d.endsWith(".") || d === "localhost") return "format";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d) || d.includes(":")) return "ip";
  if (!DOMAIN_RE.test(d)) return "format";
  const wild = d.startsWith("*.");
  if (wild && !allowWildcard) return "wildcard";
  const bare = wild ? d.slice(2) : d;
  const labels = bare.split(".");
  if (labels.length < 2 || MULTI_SUFFIX.test(bare)) return "suffix";
  if (/^\d+$/.test(labels.at(-1)!)) return "ip";
  return null;
}

/** "HTTPS://WWW.Example.com/" → "www.example.com"; typed domains are lower-cased and stripped of a scheme/path. */
export function cleanDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "");
}

/** host matches a source domain: equal, or a sub-domain of it; `*.x` matches sub-domains of x only */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (domain.startsWith("*.")) {
    const base = domain.slice(2);
    return h.endsWith(`.${base}`);
  }
  return h === domain || h.endsWith(`.${domain}`);
}

/** Страница афиши в форме (исправление 9.1: тип — сайт или Telegram-канал, приоритет обхода; 9.3 — JSON API:
 *  маппинг правится текстом JSON, в запрос уходит разобранный объект). */
export interface FormPage {
  url: string;
  city: string;
  category: string;
  kind: SourceListingKind;
  priority: SourceListingPriority;
  /** 9.3: текст маппинга страницы «JSON API» (у остальных типов не используется) */
  json?: string;
}

export function emptyPage(): FormPage {
  return { url: "", city: "", category: "", kind: "html", priority: "normal" };
}

/* ---------------------------------------------------------------- 9.3: страница «JSON API» */

/** Путь к полю ответа API — как tilhero_common.jsonapi_mapping.PATH_RE. */
export const JSON_PATH_RE = /^[A-Za-z0-9_\-$@]{1,64}(\.[A-Za-z0-9_\-$@]{1,64}){0,7}$/;
const JSON_API_KEYS = new Set([
  "url", "params", "page_param", "per_page_param", "per_page", "max_pages", "first_page", "items_path", "fields", "url_template",
  "image_base", "image_where", "status_exclude", "locale_order", "start_tz",
]);
const FIELD_KEYS = new Set(["id", "title", "start", "end", "venue", "hall", "city", "ticket_url", "image", "price_min", "price_max", "currency", "age", "status", "description"]);

/** Текст маппинга → объект или null (не JSON-объект). */
export function parseJsonApi(text: string): SourceJsonApiMapping | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as SourceJsonApiMapping) : null;
  } catch {
    return null;
  }
}

const httpsHost = (u: unknown): string | null => {
  if (typeof u !== "string") return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (!url.port || url.port === "443") && !url.username ? url.hostname : null;
  } catch {
    return null;
  }
};

/**
 * Первая проблема маппинга (код src.err.<code>) — те же правила, что у source-registry, в объёме, нужном оператору
 * рядом с полем: JSON-объект, известные ключи, обязательные пути, https на доменах источника. Остальное (плейсхолдеры,
 * пояс, границы) проверит реестр (422 SOURCE_JSON_API_INVALID / VALIDATION_ERROR).
 */
export function jsonApiProblem(text: string, eventDomains: readonly string[], mediaDomains: readonly string[] = []): string | null {
  if (!text.trim()) return "apiEmpty";
  const m = parseJsonApi(text) as Record<string, unknown> | null;
  if (!m) return "apiJson";
  if (Object.keys(m).some((k) => !JSON_API_KEYS.has(k))) return "apiKeys";
  const fields = m.fields as Record<string, unknown> | undefined;
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).some((k) => !FIELD_KEYS.has(k))) return "apiFields";
  for (const k of ["id", "title", "start"]) if (typeof fields[k] !== "string" || !JSON_PATH_RE.test(fields[k] as string)) return "apiFields";
  if (Object.values(fields).some((v) => v != null && (typeof v !== "string" || !JSON_PATH_RE.test(v)))) return "apiPath";
  const items = typeof m.items_path === "string" ? [m.items_path] : m.items_path;
  if (!Array.isArray(items) || !items.length || items.length > 3 || items.some((p) => typeof p !== "string" || !JSON_PATH_RE.test(p))) return "apiItems";
  const apiHost = httpsHost(m.url);
  const tpl = typeof m.url_template === "string" ? m.url_template : "";
  const tplHost = tpl.includes("{id}") ? httpsHost(tpl.replace("{id}", "x")) : null;
  if (!apiHost || !tplHost) return "apiUrl";
  if (!eventDomains.some((d) => hostMatches(apiHost, d)) || !eventDomains.some((d) => hostMatches(tplHost, d))) return "apiDomain";
  if (m.image_base != null) {
    // картинки — только с медиа-доменов (нет медиа — домены событий): как у обхода и verification
    const imgHost = httpsHost(m.image_base);
    const media = mediaDomains.length ? mediaDomains : eventDomains;
    if (!imgHost || !media.some((d) => hostMatches(imgHost, d))) return "apiDomain";
  }
  const pages = m.max_pages ?? 1;
  if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 1 || pages > 5) return "apiPages";
  if (pages > 1 && typeof m.page_param !== "string") return "apiPages";
  return null;
}

/** Шаблон маппинга для нового API: пути — самые частые; адреса — на первом домене событий источника. */
export function jsonApiTemplate(domain: string): string {
  const d = domain || "example.kz";
  const tpl: SourceJsonApiMapping = {
    url: `https://${d}/api/events/`,
    params: { start_time_from: "{today}", start_time_to: "{today+183d}" },
    page_param: "page",
    per_page_param: "per_page",
    per_page: 100,
    max_pages: 3,
    items_path: ["data.items", "data"],
    fields: { id: "id", title: "title", start: "start_time", end: "end_time", venue: "venue.name", hall: "hall.name", image: "media_items.url" },
    image_where: { purpose: "cover" },
    url_template: `https://${d}/event/{id}`,
    status_exclude: ["cancelled", "canceled"],
    locale_order: ["ru", "kz", "en"],
    start_tz: null,
  };
  return JSON.stringify(tpl, null, 2);
}

/** Публичный предпросмотр канала: https://t.me/s/<канал> (как source-registry TELEGRAM_PREVIEW_RE). */
export const TELEGRAM_PREVIEW_RE = /^https:\/\/t\.me\/s\/[A-Za-z][A-Za-z0-9_]{4,31}\/?$/;
export const TELEGRAM_HOST = "t.me";

export interface SourceForm {
  slug: string;
  name: string;
  country_code: string;
  tier: SourceTierCode;
  event_domains: string[];
  media_domains: string[];
  listing_pages: FormPage[];
  enabled: boolean;
  js_only: "" | "yes" | "no";
  notes: string;
  reason: string;
}

export function emptyForm(): SourceForm {
  return { slug: "", name: "", country_code: "UZ", tier: "OFFICIAL_TICKET_PROVIDER", event_domains: [], media_domains: [], listing_pages: [], enabled: false, js_only: "", notes: "", reason: "" };
}

export function formFromSource(s: Source): SourceForm {
  return {
    slug: s.slug,
    name: s.name,
    country_code: s.country_code,
    tier: s.tier,
    event_domains: [...s.event_domains],
    media_domains: [...s.media_domains],
    listing_pages: s.listing_pages.map((p) => ({
      url: p.url,
      city: p.city ?? "",
      category: p.category ?? "",
      kind: p.kind ?? "html",
      priority: p.priority ?? "normal",
      json: p.json_api ? JSON.stringify(p.json_api, null, 2) : "",
    })),
    enabled: s.enabled,
    js_only: s.js_only == null ? "" : s.js_only ? "yes" : "no",
    notes: s.notes ?? "",
    reason: "",
  };
}

/** error codes (src.err.<code> in the dictionaries) by field; listing page errors as `page.<i>` */
export type SourceErrors = Record<string, string>;

export function pageProblem(p: { url: string; kind?: SourceListingKind }, eventDomains: readonly string[]): string | null {
  const u = p.url.trim();
  if (!u) return "pageUrl";
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return "pageUrl";
  }
  if (url.protocol !== "https:") return "pageHttps";
  if (url.port && url.port !== "443") return "pagePort";
  if (!eventDomains.some((d) => hostMatches(url.hostname, d))) return "pageDomain";
  // исправление 9.1: Telegram-канал — только адрес предпросмотра t.me/s/<канал>, домен t.me — в доменах событий
  if (p.kind === "telegram") {
    if (!TELEGRAM_PREVIEW_RE.test(u)) return "pageTelegram";
    if (!eventDomains.includes(TELEGRAM_HOST)) return "pageTelegramDomain";
  } else if (url.hostname.toLowerCase() === TELEGRAM_HOST) return "pageTelegramKind";
  return null;
}

export function validateSource(f: SourceForm, creating: boolean): SourceErrors {
  const e: SourceErrors = {};
  if (creating && !SLUG_RE.test(f.slug.trim())) e.slug = "slug";
  const name = f.name.trim();
  if (!name) e.name = "name";
  else if (name.length > 120) e.name = "nameLong";
  if (!/^[A-Z]{2}$/.test(f.country_code)) e.country_code = "country";
  if (!f.event_domains.length) e.event_domains = "domainsEmpty";
  else if (f.event_domains.length > 10) e.event_domains = "domainsMany";
  else if (f.event_domains.some((d) => domainProblem(d, false))) e.event_domains = "domainBad";
  if (f.media_domains.length > 10) e.media_domains = "domainsMany";
  else if (f.media_domains.some((d) => domainProblem(d, true))) e.media_domains = "domainBad";
  if (f.listing_pages.length > 10) e.listing_pages = "pagesMany";
  f.listing_pages.forEach((p, i) => {
    const pr = pageProblem(p, f.event_domains);
    if (pr) e[`page.${i}`] = pr;
    else if (p.category && !TAXONOMY.includes(p.category)) e[`page.${i}`] = "pageCategory";
    else if (p.city.trim().length > CITY_MAX) e[`page.${i}`] = "pageCity";
    else if (p.kind === "json_api") {
      // 9.3: категория присваивается событиям API — обязательна; маппинг — отдельной строкой ошибки под редактором
      if (!p.category) e[`page.${i}`] = "apiCategory";
      const ap = jsonApiProblem(p.json ?? "", f.event_domains, f.media_domains);
      if (ap) e[`api.${i}`] = ap;
    }
  });
  if (f.notes.length > 1000) e.notes = "notesLong";
  const r = f.reason.trim();
  if (r.length < 3) e.reason = "reason";
  else if (r.length > 500) e.reason = "reasonLong";
  return e;
}

export function inputFromForm(f: SourceForm): SourceInput {
  return {
    slug: f.slug.trim(),
    name: f.name.trim(),
    country_code: f.country_code,
    tier: f.tier,
    event_domains: f.event_domains,
    media_domains: f.media_domains,
    listing_pages: f.listing_pages.map((p): SourceListingPage => {
      const page: SourceListingPage = { url: p.url.trim(), city: p.city.trim() || null, category: p.category || null, kind: p.kind, priority: p.priority };
      // 9.3: маппинг уходит только у страницы JSON API (у остальных поля нет — как до 9.3)
      if (p.kind === "json_api") page.json_api = parseJsonApi(p.json ?? "");
      return page;
    }),
    enabled: f.enabled,
    js_only: f.js_only === "" ? null : f.js_only === "yes",
    notes: f.notes.trim() || null,
  };
}

/** Fields that need a fresh step-up on PATCH (admin-bff §7): domains, enabled, tier. */
export const STEP_UP_FIELDS = ["event_domains", "media_domains", "enabled", "tier"] as const;

/** PATCH body: only changed fields (slug never), plus expected_version and reason. */
export function patchFromForm(s: Source, f: SourceForm): { body: Record<string, unknown>; changed: string[]; stepUp: boolean } {
  const next = inputFromForm(f);
  // страницы источника — в полном виде (9.1: старый реестр отдаёт их без kind/priority — это не изменение)
  const current: Record<string, unknown> = { ...s, listing_pages: inputFromForm(formFromSource(s)).listing_pages };
  const body: Record<string, unknown> = {};
  const keys = ["name", "country_code", "tier", "event_domains", "media_domains", "listing_pages", "enabled", "js_only", "notes"] as const;
  for (const k of keys) if (JSON.stringify(next[k]) !== JSON.stringify(current[k])) body[k] = next[k];
  const changed = Object.keys(body);
  return {
    body: { expected_version: s.version, ...body, reason: f.reason.trim() },
    changed,
    stepUp: changed.some((k) => (STEP_UP_FIELDS as readonly string[]).includes(k)),
  };
}

/** source fields the form edits (slug never changes) */
const FORM_FIELDS = ["name", "country_code", "tier", "event_domains", "media_domains", "listing_pages", "enabled", "js_only", "notes"] as const;

/**
 * 409 SOURCE_VERSION_CONFLICT: carry the operator's draft (made on `base`) over to the newer version `next`.
 * Fields the operator changed take the draft's value, everything else comes from `next`; the reason is kept.
 * `mine` — the operator's fields (highlighted), `both` — fields that the other staff member changed too.
 */
export function rebaseSourceForm(draft: SourceForm, base: Source, next: Source): { form: SourceForm; mine: string[]; both: string[] } {
  const mine = patchFromForm(base, draft).changed;
  const baseInput = inputFromForm(formFromSource(base));
  const nextInput = inputFromForm(formFromSource(next));
  const theirs = FORM_FIELDS.filter((k) => JSON.stringify(baseInput[k]) !== JSON.stringify(nextInput[k]));
  const form: SourceForm = { ...formFromSource(next), reason: draft.reason };
  for (const k of mine) (form as unknown as Record<string, unknown>)[k] = draft[k as keyof SourceForm];
  return { form, mine, both: mine.filter((k) => (theirs as readonly string[]).includes(k)) };
}
