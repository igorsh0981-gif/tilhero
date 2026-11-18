/**
 * Спринт 6 — новости (docs/sprint6/INTERNAL_API.md §3.1, §8; admin.ts раздел «Спринт 6»). Право news.manage
 * (super_admin, operations; не привилегированное — step-up не нужен). Прокси в news (NEWS_URL) с actor сотрудника:
 *  - реестр лент: GET/POST/PATCH/DELETE /admin/v1/news/sources[/:id] → news /internal/v1/news/sources[/{id}].
 *    POST — Idempotency-Key обязателен; PATCH/DELETE/hide/unhide — ключ пробрасывается, если admin-web его прислал.
 *    PATCH и DELETE — с expected_version (DELETE: в теле и в query `expected_version`, домену — как удобнее);
 *  - проверка ленты (пробная загрузка без записи): POST /admin/v1/news/sources/:id/check → news `{id}:check`
 *    (тело — несохранённые поля формы, без тела — сохранённые); POST /admin/v1/news/sources/check → news
 *    `sources:check` (новая лента до создания). Без повторов, своё окно breaker; домен без маршрута → 503
 *    CHECK_UNAVAILABLE;
 *  - новости: GET /admin/v1/news/items, POST /admin/v1/news/items/:id/hide|unhide {reason 3..300} → news
 *    `items/{id}:hide|:unhide` (аудит news.item.hidden пишет домен).
 * Коды конфликтов домена приводятся к контракту admin.ts: …VERSION_CONFLICT → NEWS_SOURCE_VERSION_CONFLICT,
 * …SLUG… (409) → NEWS_SOURCE_SLUG_TAKEN, 404 → NEWS_SOURCE_NOT_FOUND / NEWS_ITEM_NOT_FOUND.
 *
 * Ответы news — недоверенные данные (тексты лент приходят от изданий): BFF пропускает только поля контракта, ссылки —
 * только https без учётных данных, коды — UPPER_SNAKE, строки — без управляющих символов и HTML-разметки остаются
 * текстом (admin-web выводит их как текст), длины ограничены. Строка списка с испорченным ключевым полем
 * отбрасывается (WARNING в лог с числом); испорченный одиночный ответ → 503 UPSTREAM_UNAVAILABLE {service: "news"}.
 */
import { AppError, UpstreamError } from "@tilhero/ts-common";
import type { NewsAdminItem, NewsDisabledReason, NewsProbeResult, NewsSignificance, NewsSource, NewsSourceCheck, NewsSourceError, NewsSourceHealth, Page } from "@tilhero/contracts/admin";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, staffOf, validationError, type App, type StaffAuth } from "../http.js";
import { requirePermission } from "../rbac.js";
import {
  BOOL_Q,
  COUNTRY_LIST_Q,
  CURSOR_Q,
  EXPECTED_VERSION,
  LIMIT_Q,
  NEWS_CHECK_FIELDS,
  NEWS_HIDE_REASON,
  NEWS_SOURCE_FIELDS,
  REASON,
  SOURCE_SLUG,
  TAXONOMY_CODE,
  UUID,
  obj,
  pageQuery,
  params,
  query,
  str,
} from "../schemas.js";
import { NEWS_ITEM, NEWS_ITEM_PAGE, NEWS_SOURCE, NEWS_SOURCE_CHECK, NEWS_SOURCE_PAGE, NO_CONTENT, ok } from "../responses.js";
import { upstreamUnavailable } from "../upstream.js";
import { ISO_COUNTRIES } from "../iso3166.js";
import { cleanText, isoTime, safeHttps } from "./travel.js";

// ---------------------------------------------------------------- примитивы недоверенных данных

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** «dropped» записи при проверке — машинная причина (link_foreign, no_https, category_filter…) или код */
const REASON_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const TAX_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^${LABEL}(\\.${LABEL})+$`);
const CATEGORY_RE = /^[^\s"'<>\\]{1,100}$/;
const KINDS = ["official", "media"] as const;
const MODES = ["rss", "html"] as const;
const DISPLAYS = ["summary", "title_only"] as const;
const LANGS = ["ru", "en", "uz"] as const;
const ITEM_KINDS = ["event_update", "article"] as const;
const LEVELS: readonly NewsSignificance[] = ["high", "mid", "low"];
const DISABLED_REASONS: readonly NewsDisabledReason[] = ["legal", "terms", "stale", "unverified", "manual", "blocked"];
/** Граница «ниже порога» по умолчанию (NEWS_MIN_SIGNIFICANCE у news), если домен не сообщил флаг сам. */
export const NEWS_MIN_SIGNIFICANCE = 0.3;
export const NEWS_SUMMARY_MAX = 600;
export const NEWS_CHECK_ITEMS_MAX = 10;
/** Проверка ленты: provider-gateway сам ждёт загрузку (до ~15 с) — у BFF запас; без повторов. */
export const NEWS_CHECK_TIMEOUT_MS = 25_000;
const CHECK_BREAKER = "news-check";

const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | null => (values.includes(v as T) ? (v as T) : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const uuidOrNull = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null);
const domainOrNull = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const d = v.trim().toLowerCase();
  return d.length <= 253 && DOMAIN_RE.test(d) ? d : null;
};

/** Список строк: только прошедшие проверку, без дублей, не больше max. */
function list(v: unknown, max: number, item: (x: unknown) => string | null): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (out.length >= max) break;
    const s = item(x);
    if (s !== null && !out.includes(s)) out.push(s);
  }
  return out;
}
const taxCode = (x: unknown) => (typeof x === "string" && TAX_RE.test(x) ? x : null);

// ---------------------------------------------------------------- источники

/** Исправление 6.1: итог автопроверки ленты; испорченный → null (admin-web покажет «ещё не проверялась»). */
export function probeOf(v: unknown): NewsProbeResult | null {
  if (!isRec(v) || typeof v.ok !== "boolean" || typeof v.enabled !== "boolean") return null;
  return {
    ok: v.ok,
    code: typeof v.code === "string" && CODE_RE.test(v.code) ? v.code : null,
    fetched: count(v.fetched),
    accepted: count(v.accepted),
    newest_at: isoTime(v.newest_at),
    enabled: v.enabled,
  };
}

function errorOf(src: Rec): NewsSourceError | null {
  // форма контракта: last_error {code, message, at}; допускаем строку-код и плоские last_error_code / last_error_at
  const raw = src.last_error;
  if (typeof raw === "string") {
    // news хранит код последней ошибки сбора (сбрасывается при успехе): время — последний сбор
    const code = CODE_RE.test(raw) ? raw : null;
    return code ? { code, message: null, at: isoTime(src.last_error_at) ?? isoTime(src.last_fetch_at) } : null;
  }
  const e: Rec = isRec(raw) ? raw : { code: src.last_error_code, message: src.last_error_message, at: src.last_error_at };
  const code = typeof e.code === "string" && CODE_RE.test(e.code) ? e.code : null;
  if (!code) return null;
  return { code, message: cleanText(e.message, 300), at: isoTime(e.at) };
}

function healthOf(x: Rec): NewsSourceHealth {
  // health {…} по контракту; старый/иной news — те же поля на верхнем уровне
  const h: Rec = isRec(x.health) ? x.health : x;
  return {
    last_fetch_at: isoTime(h.last_fetch_at),
    last_ok_at: isoTime(h.last_ok_at),
    last_error: errorOf(h),
    items_24h: count(h.items_24h),
  };
}

/**
 * Источник news → NewsSource; ключевые поля (id, slug, имя, вид, режим, домен, язык, показ, enabled, версия)
 * испорчены → null. Ссылка ленты/страницы — только https (иначе null), прочее приводится к контракту.
 */
export function normalizeNewsSource(v: unknown): NewsSource | null {
  if (!isRec(v)) return null;
  const source_id = uuidOrNull(v.source_id);
  const slug = typeof v.slug === "string" && SLUG_RE.test(v.slug) ? v.slug : null;
  const name = cleanText(v.name, 120);
  const kind = oneOf(v.kind, KINDS);
  const mode = oneOf(v.mode, MODES);
  const site_domain = domainOrNull(v.site_domain);
  const lang = oneOf(v.lang, LANGS);
  const display = oneOf(v.display, DISPLAYS);
  const version = typeof v.version === "number" && Number.isSafeInteger(v.version) && v.version >= 1 ? v.version : null;
  if (!source_id || !slug || !name || !kind || !mode || !site_domain || !lang || !display || version === null || typeof v.enabled !== "boolean") {
    return null;
  }
  const category = typeof v.category_filter === "string" && CATEGORY_RE.test(v.category_filter) ? v.category_filter : null;
  return {
    source_id,
    slug,
    name,
    kind,
    mode,
    feed_url: safeHttps(v.feed_url),
    page_url: safeHttps(v.page_url),
    site_domain,
    extra_domains: list(v.extra_domains, 10, domainOrNull),
    interests: list(v.interests, 20, taxCode),
    entities: list(v.entities, 20, (x) => cleanText(x, 80)),
    country_code: typeof v.country_code === "string" && COUNTRY_RE.test(v.country_code) ? v.country_code : null,
    lang,
    display,
    category_filter: category,
    enabled: v.enabled,
    health: healthOf(v),
    // исправление 6.1: причина выключения — только у выключенной ленты (у включённой news отдаёт null)
    disabled_reason: v.enabled ? null : oneOf(v.disabled_reason, DISABLED_REASONS),
    last_probe_at: isoTime(v.last_probe_at),
    last_probe_result: probeOf(v.last_probe_result),
    version,
    updated_at: isoTime(v.updated_at),
  };
}

/** Страница источников: испорченные строки отбрасываются (их число — в rejected), дубли source_id — первая. */
export function normalizeNewsSourcePage(body: unknown): { page: Page<NewsSource>; rejected: number } {
  const raw = isRec(body) && Array.isArray(body.items) ? body.items : [];
  const seen = new Set<string>();
  const items: NewsSource[] = [];
  let rejected = 0;
  for (const r of raw) {
    const s = normalizeNewsSource(r);
    if (!s || seen.has(s.source_id)) {
      rejected += 1;
      continue;
    }
    seen.add(s.source_id);
    items.push(s);
  }
  const next = isRec(body) && typeof body.next_cursor === "string" && body.next_cursor.length > 0 && body.next_cursor.length <= 512 ? body.next_cursor : null;
  return { page: { items, next_cursor: next }, rejected };
}

/** Причины отбора записи у news (CheckItemOut.reason) → коды контракта admin.ts (admin-web подписывает их). */
const DROP_REASONS: Readonly<Record<string, string>> = {
  FOREIGN_DOMAIN: "link_foreign",
  NOT_HTTPS: "no_https",
  CATEGORY_FILTER: "category_filter",
  DUPLICATE_IN_FEED: "duplicate",
};
function droppedOf(r: Rec): string | null {
  // форма news: {accepted: bool, reason: КОД}; форма контракта: {dropped: код | null}
  const raw = r.accepted === true ? null : r.accepted === false ? (r.reason ?? "rejected") : r.dropped;
  if (typeof raw !== "string" || !REASON_RE.test(raw)) return r.accepted === false ? "rejected" : null;
  return DROP_REASONS[raw] ?? raw;
}

/**
 * Результат пробной загрузки ленты → NewsSourceCheck (записи — только https и с заголовком, ≤ 10). Понимает и форму
 * news (`{ok, error, fetched, accepted, items: [{url, title, published_at, accepted, reason}]}`).
 */
export function normalizeNewsCheck(v: unknown, now: number): NewsSourceCheck | null {
  if (!isRec(v)) return null;
  const items: NewsSourceCheck["items"] = [];
  const rawItems = Array.isArray(v.items) ? v.items : [];
  for (const r of rawItems) {
    if (items.length >= NEWS_CHECK_ITEMS_MAX) break;
    if (!isRec(r)) continue;
    const url = safeHttps(r.url);
    const title = cleanText(r.title, 300);
    if (!url || !title) continue;
    items.push({ url, title, published_at: isoTime(r.published_at), dropped: droppedOf(r) });
  }
  // errors: [{code, message}] | [код] | error: код (на случай краткой формы домена)
  const rawErrors: unknown[] = Array.isArray(v.errors) ? v.errors : v.error !== undefined ? [v.error] : [];
  const errors: NewsSourceCheck["errors"] = [];
  for (const e of rawErrors) {
    if (errors.length >= 10) break;
    const code = typeof e === "string" ? e : isRec(e) ? e.code : null;
    if (typeof code !== "string" || !CODE_RE.test(code)) continue;
    errors.push({ code, message: isRec(e) ? cleanText(e.message, 300) : null });
  }
  const totalRaw = v.items_total ?? v.fetched;
  const total = typeof totalRaw === "number" && Number.isSafeInteger(totalRaw) && totalRaw >= 0 ? totalRaw : rawItems.length;
  const okFlag = typeof v.ok === "boolean" ? v.ok : errors.length === 0 && items.length > 0;
  return {
    // «ok» без единой годной записи — не ok (admin-web иначе показал бы зелёную проверку пустой ленты)
    ok: okFlag && items.some((x) => !x.dropped),
    items,
    items_total: Math.max(total, items.length),
    errors,
    checked_at: isoTime(v.checked_at) ?? isoTime(v.fetched_at) ?? new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------- новости

function levelOf(n: number | null, raw: unknown): NewsSignificance | null {
  const given = oneOf(raw, LEVELS);
  if (given) return given;
  if (n === null) return null;
  return n >= 0.7 ? "high" : n >= 0.4 ? "mid" : "low";
}

/**
 * Новость news → NewsAdminItem; без id, заголовка или https-ссылки — null (новость без источника не показывается,
 * AT-33). significance — число 0..1 или уровень high|mid|low (у выдачи Mini App); event_ids — только UUID, ≤ 5.
 */
export function normalizeNewsItem(v: unknown): NewsAdminItem | null {
  if (!isRec(v)) return null;
  const news_id = uuidOrNull(v.news_id);
  const kind = oneOf(v.kind, ITEM_KINDS);
  const title = cleanText(v.title, 300);
  const src: Rec = isRec(v.source) ? v.source : { source_id: v.source_id, name: v.source_name, domain: v.source_domain, url: v.url };
  const url = safeHttps(v.url) ?? safeHttps(src.url);
  if (!news_id || !kind || !title || !url) return null;
  const host = new URL(url).hostname.replace(/^www\./, "");
  const domain = domainOrNull(src.domain) ?? host;
  const sig = typeof v.significance === "number" && Number.isFinite(v.significance) && v.significance >= 0 && v.significance <= 1 ? Math.round(v.significance * 1000) / 1000 : null;
  const summary: Rec = isRec(v.summary) ? v.summary : {};
  const hidden = v.hidden === true;
  return {
    news_id,
    kind,
    title,
    summary_ru: cleanText(v.summary_ru ?? summary.ru, NEWS_SUMMARY_MAX),
    summary_en: cleanText(v.summary_en ?? summary.en, NEWS_SUMMARY_MAX),
    url,
    source: { source_id: uuidOrNull(src.source_id), name: cleanText(src.name, 120) ?? domain, domain },
    published_at: isoTime(v.published_at),
    collected_at: isoTime(v.collected_at) ?? isoTime(v.first_seen_at) ?? isoTime(v.created_at),
    significance: sig,
    significance_level: levelOf(sig, v.significance_level ?? v.significance),
    interests: list(v.interests, 10, taxCode),
    entities: list(v.entities, 10, (x) => cleanText(x, 80)),
    event_ids: list(v.event_ids, 5, uuidOrNull),
    hidden,
    hidden_reason: hidden ? cleanText(v.hidden_reason, 300) : null,
    hidden_at: hidden ? isoTime(v.hidden_at) : null,
    hidden_by: hidden ? uuidOrNull(v.hidden_by) : null,
    hidden_by_name: null,
    below_threshold: typeof v.below_threshold === "boolean" ? v.below_threshold : sig !== null && sig < NEWS_MIN_SIGNIFICANCE,
  };
}

export function normalizeNewsItemPage(body: unknown): { page: Page<NewsAdminItem>; rejected: number } {
  const raw = isRec(body) && Array.isArray(body.items) ? body.items : [];
  const seen = new Set<string>();
  const items: NewsAdminItem[] = [];
  let rejected = 0;
  for (const r of raw) {
    const n = normalizeNewsItem(r);
    if (!n || seen.has(n.news_id)) {
      rejected += 1;
      continue;
    }
    seen.add(n.news_id);
    items.push(n);
  }
  const next = isRec(body) && typeof body.next_cursor === "string" && body.next_cursor.length > 0 && body.next_cursor.length <= 512 ? body.next_cursor : null;
  return { page: { items, next_cursor: next }, rejected };
}

async function namedItems(ctx: BffContext, auth: StaffAuth, items: NewsAdminItem[]): Promise<NewsAdminItem[]> {
  const ids = items.map((n) => n.hidden_by).filter((x): x is string => !!x);
  if (!ids.length) return items;
  const names = await ctx.names.resolve(ids, auth);
  return items.map((n) => ({ ...n, hidden_by_name: n.hidden_by ? (names.get(n.hidden_by) ?? null) : null }));
}

// ---------------------------------------------------------------- ошибки домена → коды контракта

export function sourceVersionConflict(details: Record<string, unknown> = {}): AppError {
  return new AppError(409, "NEWS_SOURCE_VERSION_CONFLICT", "Источник изменён другим сотрудником — перечитайте карточку", pickDetails(details, ["current_version", "version"]));
}
export function checkUnavailable(): AppError {
  return new AppError(503, "CHECK_UNAVAILABLE", "Проверка ленты недоступна: обновите сервис news", { service: "news" });
}

/** Только числовые детали домена (версии): прочее — недоверенный текст, наружу не идёт. */
function pickDetails(details: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (typeof details[k] === "number" && Number.isSafeInteger(details[k])) out[k] = details[k];
  return out;
}

/** Ошибки 4xx news для маршрутов источников → коды admin.ts; прочие — как есть. */
export function mapSourceError(err: unknown): unknown {
  if (!(err instanceof UpstreamError)) return err;
  if (err.status === 409 && /VERSION_CONFLICT$/.test(err.code)) return sourceVersionConflict(err.details);
  if (err.status === 409 && /SLUG/.test(err.code)) return new AppError(409, "NEWS_SOURCE_SLUG_TAKEN", "Источник с таким slug уже есть", {});
  if (err.status === 404 && err.code !== "UPSTREAM_ERROR") return new AppError(404, "NEWS_SOURCE_NOT_FOUND", "Источник новостей не найден");
  return err;
}
function mapItemError(err: unknown): unknown {
  if (err instanceof UpstreamError && err.status === 404 && err.code !== "UPSTREAM_ERROR") return new AppError(404, "NEWS_ITEM_NOT_FOUND", "Новость не найдена");
  return err;
}

async function mapped<T>(fn: () => Promise<T>, map: (e: unknown) => unknown): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw map(err);
  }
}

// ---------------------------------------------------------------- проверки тела

type Body = Record<string, unknown>;
const hostOf = (u: unknown): string | null => {
  if (typeof u !== "string") return null;
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
};
const onDomain = (host: string, domains: string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * Согласованность полей ленты (первая линия, домен проверяет повторно): режиму rss нужен feed_url, html — page_url;
 * хост ссылки — site_domain, его поддомен или extra_domains. Для PATCH — только переданные вместе поля.
 */
export function checkFeedFields(b: Body, full: boolean): void {
  const mode = b.mode as string | undefined;
  if (full || mode !== undefined) {
    if (mode === "rss" && (full || "feed_url" in b) && !b.feed_url) throw validationError("feed_url", "Для режима rss нужна ссылка на ленту");
    if (mode === "html" && (full || "page_url" in b) && !b.page_url) throw validationError("page_url", "Для режима html нужна страница новостей");
  }
  const site = typeof b.site_domain === "string" ? b.site_domain : null;
  if (!site) return;
  const domains = [site, ...(Array.isArray(b.extra_domains) ? (b.extra_domains as string[]) : [])];
  for (const f of ["feed_url", "page_url"] as const) {
    const host = hostOf(b[f]);
    if (host && !onDomain(host, domains)) throw validationError(f, "Адрес должен быть на домене источника (site_domain или extra_domains)");
  }
}

// ---------------------------------------------------------------- фильтр стран

/**
 * `country=UZ,kz` → ["UZ", "KZ"] (верхний регистр, без дублей, порядок сохраняется); код не из ISO 3166-1 alpha-2 →
 * 422 VALIDATION_ERROR {in: "querystring", field: "country"}. Формат и предел 20 — схемой (COUNTRY_LIST_Q).
 */
export function countryList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const codes = [...new Set(raw.split(",").map((c) => c.toUpperCase()))];
  const bad = codes.filter((c) => !ISO_COUNTRIES.has(c));
  if (bad.length) throw validationError("country", `Неизвестный код страны ISO 3166-1: ${bad.slice(0, 5).join(", ")}`, "querystring");
  return codes;
}

// ---------------------------------------------------------------- маршруты

const ID_PARAMS = params({ id: UUID });
const INPUT_REQUIRED = [
  "slug", "name", "kind", "mode", "feed_url", "page_url", "site_domain", "extra_domains", "interests", "entities",
  "country_code", "lang", "display", "category_filter", "enabled", "reason",
];
const CHECK_REQUIRED = ["mode", "feed_url", "page_url", "site_domain", "extra_domains", "category_filter"];
const SOURCES = "/internal/v1/news/sources";

export function newsRoutes(app: App, ctx: BffContext): void {
  const news = ctx.domains.news;
  const sourcePath = (id: string) => `${SOURCES}/${id.toLowerCase()}`;

  const one = (body: unknown, what: string): NewsSource => {
    const s = normalizeNewsSource(body);
    if (!s) {
      ctx.log.warn({ upstream: "news", upstream_code: "UPSTREAM_BAD_RESPONSE", what }, "news source rejected by normalization");
      throw upstreamUnavailable("news");
    }
    return s;
  };

  app.get<{ Querystring: { interest?: string; country?: string; enabled?: string; q?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/news/sources",
    {
      config: requirePermission("news.manage"),
      schema: {
        response: ok(NEWS_SOURCE_PAGE),
        querystring: query({ interest: TAXONOMY_CODE, country: COUNTRY_LIST_Q, enabled: BOOL_Q, q: str(1, 120), cursor: CURSOR_Q, limit: LIMIT_Q }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const { interest, enabled, q } = req.query;
      const countries = countryList(req.query.country);
      const body = await news.get<unknown>(SOURCES, { actor: auth.actor, query: { interest, country: countries?.join(","), enabled, q, ...pageQuery(req.query) } });
      const { page, rejected } = normalizeNewsSourcePage(body);
      if (rejected) ctx.log.warn({ upstream: "news", rejected }, "news sources rows rejected by normalization");
      // страну фильтрует news (страница и next_cursor — как есть)
      return page;
    },
  );

  // статический путь: у Fastify он приоритетнее /admin/v1/news/sources/:id
  app.post<{ Body: Body }>(
    "/admin/v1/news/sources/check",
    {
      config: requirePermission("news.manage"),
      schema: { response: ok(NEWS_SOURCE_CHECK), body: obj(NEWS_CHECK_FIELDS, CHECK_REQUIRED) },
    },
    async (req) => {
      const auth = staffOf(req);
      checkFeedFields(req.body, true);
      return runCheck(`${SOURCES}:check`, auth, req.body, false);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/v1/news/sources/:id",
    { config: requirePermission("news.manage"), schema: { response: ok(NEWS_SOURCE), params: ID_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return one(await mapped(() => news.get<unknown>(sourcePath(req.params.id), { actor: auth.actor }), mapSourceError), "get");
    },
  );

  app.post<{ Body: Body }>(
    "/admin/v1/news/sources",
    {
      config: requirePermission("news.manage"),
      schema: { response: ok(NEWS_SOURCE), body: obj({ slug: SOURCE_SLUG, ...NEWS_SOURCE_FIELDS, reason: REASON }, INPUT_REQUIRED) },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const idempotencyKey = idempotencyKeyOf(req, true);
      checkFeedFields(req.body, true);
      const res = await mapped(() => news.call<unknown>("POST", SOURCES, { actor: auth.actor, body: req.body, idempotencyKey }), mapSourceError);
      return reply.status(res.status).send(one(res.body, "create"));
    },
  );

  app.patch<{ Params: { id: string }; Body: Body }>(
    "/admin/v1/news/sources/:id",
    {
      config: requirePermission("news.manage"),
      schema: {
        response: ok(NEWS_SOURCE),
        params: ID_PARAMS,
        body: obj({ expected_version: EXPECTED_VERSION, ...NEWS_SOURCE_FIELDS, reason: REASON }, ["expected_version", "reason"], { minProperties: 3 }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      checkFeedFields(req.body, false);
      const res = await mapped(
        () => news.call<unknown>("PATCH", sourcePath(req.params.id), { actor: auth.actor, body: req.body, idempotencyKey: idempotencyKeyOf(req, false) }),
        mapSourceError,
      );
      return one(res.body, "patch");
    },
  );

  app.delete<{ Params: { id: string }; Body: { expected_version: number; reason: string } }>(
    "/admin/v1/news/sources/:id",
    {
      config: requirePermission("news.manage"),
      schema: {
        response: NO_CONTENT,
        params: ID_PARAMS,
        body: obj({ expected_version: EXPECTED_VERSION, reason: REASON }, ["expected_version", "reason"]),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      await mapped(
        () =>
          news.call("DELETE", sourcePath(req.params.id), {
            actor: auth.actor,
            query: { expected_version: req.body.expected_version },
            body: req.body,
            idempotencyKey: idempotencyKeyOf(req, false),
          }),
        mapSourceError,
      );
      return reply.status(204).send();
    },
  );

  async function runCheck(path: string, auth: StaffAuth, body: Body | undefined, existing: boolean): Promise<NewsSourceCheck> {
    let raw: unknown;
    try {
      raw = await news.post<unknown>(path, {
        actor: auth.actor,
        ...(body && Object.keys(body).length ? { body } : {}),
        retries: 0,
        timeoutMs: NEWS_CHECK_TIMEOUT_MS,
        breakerKey: CHECK_BREAKER,
      });
    } catch (err) {
      // маршрута проверки у news нет (FastAPI: 404 без кода / 405)
      if (err instanceof UpstreamError && (err.status === 405 || (err.status === 404 && err.code === "UPSTREAM_ERROR"))) throw checkUnavailable();
      throw existing ? mapSourceError(err) : err;
    }
    const out = normalizeNewsCheck(raw, ctx.now());
    if (!out) {
      ctx.log.warn({ upstream: "news", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "news check rejected by normalization");
      throw upstreamUnavailable("news");
    }
    return out;
  }

  app.post<{ Params: { id: string }; Body: Body }>(
    "/admin/v1/news/sources/:id/check",
    {
      config: requirePermission("news.manage"),
      schema: { response: ok(NEWS_SOURCE_CHECK), params: ID_PARAMS, body: obj(NEWS_CHECK_FIELDS, [], {}) },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = req.body ?? {};
      if (Object.keys(body).length) {
        // несохранённые поля формы — только полным набором (иначе домен смешал бы их с сохранёнными)
        for (const f of CHECK_REQUIRED) if (!(f in body)) throw validationError(f, "Для проверки несохранённой ленты нужны все поля ленты");
        checkFeedFields(body, true);
      }
      return runCheck(`${sourcePath(req.params.id)}:check`, auth, body, true);
    },
  );

  // ---------------------------------------------------------------- новости

  app.get<{ Querystring: { source?: string; country?: string; hidden?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/news/items",
    {
      config: requirePermission("news.manage"),
      schema: {
        response: ok(NEWS_ITEM_PAGE),
        querystring: query({ source: UUID, country: COUNTRY_LIST_Q, hidden: BOOL_Q, cursor: CURSOR_Q, limit: LIMIT_Q }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const { source, hidden } = req.query;
      const countries = countryList(req.query.country);
      const body = await news.get<unknown>("/internal/v1/news/items", {
        actor: auth.actor,
        query: { source: source?.toLowerCase(), country: countries?.join(","), hidden, ...pageQuery(req.query) },
      });
      const { page, rejected } = normalizeNewsItemPage(body);
      if (rejected) ctx.log.warn({ upstream: "news", rejected }, "news items rejected by normalization");
      // страну фильтрует news: ленты — по стране ленты, изменения событий — по стране площадки
      return { ...page, items: await namedItems(ctx, auth, page.items) };
    },
  );

  for (const action of ["hide", "unhide"] as const) {
    app.post<{ Params: { id: string }; Body: { reason: string } }>(
      `/admin/v1/news/items/:id/${action}`,
      {
        config: requirePermission("news.manage"),
        schema: { response: ok(NEWS_ITEM), params: ID_PARAMS, body: obj({ reason: NEWS_HIDE_REASON }, ["reason"]) },
      },
      async (req) => {
        const auth = staffOf(req);
        const reason = req.body.reason.trim();
        if (reason.length < 3) throw validationError("reason", "Причина — от 3 символов");
        const res = await mapped(
          () =>
            news.call<unknown>("POST", `/internal/v1/news/items/${req.params.id.toLowerCase()}:${action}`, {
              actor: auth.actor,
              body: { reason },
              idempotencyKey: idempotencyKeyOf(req, false),
            }),
          mapItemError,
        );
        const item = normalizeNewsItem(res.body);
        if (!item) {
          ctx.log.warn({ upstream: "news", upstream_code: "UPSTREAM_BAD_RESPONSE", action }, "news item rejected by normalization");
          throw upstreamUnavailable("news");
        }
        return (await namedItems(ctx, auth, [item]))[0];
      },
    );
  }
}
