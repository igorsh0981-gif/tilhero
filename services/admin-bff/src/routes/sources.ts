/**
 * Источники AI-поиска (allowlist официальных сайтов) — прокси в source-registry (docs/sprint4/INTERNAL_API.md §2.2, §7).
 * Право sources.manage (привилегированное). Создание — всегда step-up; изменение — step-up, только если меняются
 * поля доверия: event_domains, media_domains, enabled, tier (admin.ts). Без свежего step-up BFF сверяет такие поля
 * с текущей версией источника: изменение засчитывается, если значение отличается (домены — как множества без учёта
 * регистра) или если `expected_version` не совпадает с текущей (тогда сравнивать не с чем — нужен step-up).
 * Домен применяет PATCH только к `expected_version`, поэтому сверка не обходится гонкой.
 * Idempotency-Key создания пробрасывается в домен (как POST staff); статус ответа домена сохраняется (201).
 * Имена сотрудников (updated_by_name, changes[].actor_name) — admin-identity staff/lookup (./staffNames.ts).
 *
 * Последний обход (исправление 4.1): GET /admin/v1/sources/crawl-stats — прокси provider-gateway
 * `GET /internal/v1/providers/ai_web/sources`, право sources.manage или discovery.manage. Без PROVIDER_GATEWAY_URL —
 * 503 FEATURE_UNAVAILABLE (как бюджет AI). Если provider-gateway пагинирует (`next_cursor`), BFF дочитывает страницы
 * (limit=200, не больше CRAWL_MAX_PAGES) и отдаёт admin-web один список. Ответ домена нормализуется (normalizeCrawlStats): admin-web выводит
 * slug, коды и причины как текст, поэтому чужие форматы не проходят дальше BFF.
 *
 * Исправление 9.3: POST /admin/v1/sources/json-api/preview — «Проверить» страницу типа «JSON API» из формы источника
 * (до сохранения): прокси provider-gateway `POST /internal/v1/providers/ai_web/json_api:preview` с actor, право
 * sources.manage, CSRF и лимит команд — как у остальных POST; provider-gateway сам пускает не чаще раза в 5 с на
 * сотрудника (429 → 429 PREVIEW_RATE_LIMITED {retry_after}). Без повторов (каждая попытка — запрос к сайту), свой
 * breaker. Ответ нормализуется (normalizeJsonApiPreview): admin-web выводит его как текст и ссылки.
 * Домены (ревью 9.3): провайдер ходит только на домены источника, поэтому для сохранённого источника (`source_id`)
 * берутся домены из реестра; если в форме они другие (или источник новый) — нужен свежий step-up, как при сохранении
 * доменов. Каждая проверка — запись аудита `source.json_api.preview` (кто, источник, хост API, итог).
 */
import { AppError, UpstreamError } from "@tilhero/ts-common";
import type {
  Page,
  Source,
  SourceCrawlOutcome,
  SourceCrawlStats,
  SourceCrawlStatsList,
  SourceDetail,
  SourceJsonApiPreview,
  SourceJsonApiPreviewEvent,
} from "@tilhero/contracts/admin";
import { hasFreshStepUp, stepUpRequired } from "../auth.js";
import { writeAudit, type BffContext } from "../context.js";
import { idempotencyKeyOf, staffOf, type App, type StaffAuth } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import {
  BOOL_Q,
  COUNTRY,
  CURSOR_Q,
  JSON_API_PREVIEW_INPUT,
  LIMIT_Q,
  REASON,
  SOURCE_FIELDS,
  SOURCE_SLUG,
  SOURCE_STEP_UP_FIELDS,
  UUID,
  obj,
  pageQuery,
  params,
  query,
  str,
} from "../schemas.js";
import { ok, SOURCE, SOURCE_CRAWL_STATS, SOURCE_DETAIL, SOURCE_JSON_API_PREVIEW, SOURCE_PAGE } from "../responses.js";
import { upstreamUnavailable } from "../upstream.js";
import { namedSourceDetail, namedSources } from "./staffNames.js";

type StepUpField = (typeof SOURCE_STEP_UP_FIELDS)[number];
type SourcePatch = { expected_version: number; reason: string } & Partial<Omit<Source, "source_id" | "slug" | "version">>;

const ID_PARAMS = params({ id: UUID });
const INPUT_REQUIRED = ["slug", "name", "country_code", "tier", "event_domains", "media_domains", "listing_pages", "enabled", "js_only", "notes", "reason"];

const normDomains = (v: unknown): string =>
  Array.isArray(v) ? [...new Set(v.map((d) => String(d).trim().toLowerCase()))].sort().join(",") : JSON.stringify(v);

/** Меняет ли тело поле доверия относительно текущей версии источника. */
export function changesTrustFields(body: Partial<Record<StepUpField, unknown>>, current: Source): boolean {
  return SOURCE_STEP_UP_FIELDS.some((f) => {
    if (!(f in body)) return false;
    if (f === "event_domains" || f === "media_domains") return normDomains(body[f]) !== normDomains(current[f]);
    return body[f] !== current[f];
  });
}

const AI_WEB_SOURCES = "/internal/v1/providers/ai_web/sources";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
/** коды исходов и причины отбрасывания: SOURCE_FETCH_FAILED, date_mismatch, link_foreign… */
const CODE_RE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const MONEY_RE = /^\d{1,9}(\.\d{1,6})?$/;
const OUTCOMES: readonly SourceCrawlOutcome[] = ["ok", "skipped", "error"];
/** Не больше причин (skipped) и признаков (notes) в одной строке (у provider-gateway их около 15). */
export const MAX_SKIP_REASONS = 40;
/** Страница provider-gateway и предел страниц: источников — десятки, 5 × 200 — с большим запасом. */
export const CRAWL_PAGE_LIMIT = 200;
export const CRAWL_MAX_PAGES = 5;

const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const money = (v: unknown): string => (typeof v === "string" && MONEY_RE.test(v) ? v : typeof v === "number" && Number.isFinite(v) && v >= 0 ? v.toFixed(4) : "0.0000");
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);

/** Словарь «код → число» (skipped, notes): только коды CODE_RE и целые > 0, не больше MAX_SKIP_REASONS; иначе / нет поля → {}. */
function codeCounts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_SKIP_REASONS) break;
    if (CODE_RE.test(k) && count(n) > 0) out[k] = count(n);
  }
  return out;
}

/**
 * Ответ provider-gateway → SourceCrawlStatsList: строки без корректного slug отбрасываются (дубли — первая),
 * счётчики — неотрицательные целые, деньги — десятичная строка, неизвестный outcome → null, причины отбрасывания
 * (skipped) и признаки страниц (notes: deadline, part_truncated, part_saturated) — только коды и целые > 0
 * (не больше MAX_SKIP_REASONS); старый provider-gateway без notes → {}.
 */
export function normalizeCrawlStats(body: unknown): SourceCrawlStatsList {
  const raw = body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [];
  const seen = new Set<string>();
  const items: SourceCrawlStats[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    if (typeof x.slug !== "string" || !SLUG_RE.test(x.slug) || seen.has(x.slug)) continue;
    seen.add(x.slug);
    items.push({
      slug: x.slug,
      last_crawl_at: isoOrNull(x.last_crawl_at),
      outcome: OUTCOMES.includes(x.outcome as SourceCrawlOutcome) ? (x.outcome as SourceCrawlOutcome) : null,
      code: typeof x.code === "string" && CODE_RE.test(x.code) ? x.code : null,
      pages: count(x.pages),
      events_found: count(x.events_found),
      skipped: codeCounts(x.skipped),
      notes: codeCounts(x.notes),
      llm_calls: count(x.llm_calls),
      cost_usd_last: money(x.cost_usd_last),
      cost_usd_day: money(x.cost_usd_day),
    });
  }
  return { items };
}

// ---------------------------------------------------------------- 9.3: предпросмотр страницы «JSON API»

const JSON_API_PREVIEW = "/internal/v1/providers/ai_web/json_api:preview";
export const PREVIEW_TIMEOUT_MS = 40_000;
export const PREVIEW_BREAKER = "json-api-preview";
export const PREVIEW_WINDOW_S = 5;
const PREVIEW_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const REASON_RE = /^[A-Za-z0-9_.:/ -]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^\d{2}:\d{2}$/;
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MONEY_STR_RE = /^\d{1,10}\.\d{2}$/;

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Строка до max символов без управляющих; иначе null. */
const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
const re = (v: unknown, rx: RegExp): string | null => (typeof v === "string" && rx.test(v) ? v : null);
/** Только https-ссылки (admin-web делает из них <a>/<img>). */
const httpsUrl = (v: unknown): string | null => {
  const s = text(v, 4096);
  if (!s) return null;
  try {
    return new URL(s).protocol === "https:" ? s : null;
  } catch {
    return null;
  }
};

function previewEvent(v: unknown): SourceJsonApiPreviewEvent | null {
  if (!isRec(v)) return null;
  const id = text(v.id, 100);
  const title = text(v.title, 300);
  const localDate = re(v.local_date, DATE_RE);
  const url = httpsUrl(v.url);
  if (!id || !title || !localDate || !url) return null;
  const p = v.price;
  const price =
    isRec(p) && re(p.min, MONEY_STR_RE) && re(p.max, MONEY_STR_RE) && re(p.currency, /^[A-Z]{3}$/)
      ? { min: p.min as string, max: p.max as string, currency: p.currency as string }
      : null;
  return {
    id,
    title,
    local_date: localDate,
    local_time: re(v.local_time, HM_RE),
    timezone: text(v.timezone, 64),
    utc: re(v.utc, ISO_Z_RE),
    end_local_date: re(v.end_local_date, DATE_RE),
    end_local_time: re(v.end_local_time, HM_RE),
    venue: text(v.venue, 310),
    city: text(v.city, 200),
    url,
    image: httpsUrl(v.image),
    price,
    category: text(v.category, 64),
    age: text(v.age, 20),
    status: text(v.status, 40),
    description: text(v.description, 500),
  };
}

/**
 * Ответ provider-gateway → SourceJsonApiPreview; null — испорчен (нет ok, request_url или checked_at). События — до 5,
 * отклонённые — до 5, ключи — до 80 (путь ≤ 600, образец ≤ 60), причины — коды CODE_RE и целые > 0; ссылки — только https.
 */
export function normalizeJsonApiPreview(body: unknown): SourceJsonApiPreview | null {
  if (!isRec(body) || typeof body.ok !== "boolean") return null;
  const requestUrl = httpsUrl(body.request_url);
  const checkedAt = isoOrNull(body.checked_at);
  if (!requestUrl || !checkedAt) return null;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return {
    ok: body.ok,
    code: re(body.code, PREVIEW_CODE_RE),
    // отказ SSRF-защиты сотруднику не раскрываем (старый provider-gateway отдавал blocked_address)
    reason: body.reason === "blocked_address" ? "address_unavailable" : re(body.reason, REASON_RE),
    request_url: requestUrl,
    items_path: text(body.items_path, 600),
    items_total: count(body.items_total),
    events: list(body.events).map(previewEvent).filter((e): e is SourceJsonApiPreviewEvent => e !== null).slice(0, 5),
    rejected: list(body.rejected)
      .filter(isRec)
      .map((r) => ({ index: count(r.index), id: text(r.id, 100), reason: re(r.reason, CODE_RE) ?? "unknown" }))
      .slice(0, 5),
    keys: list(body.keys)
      .filter(isRec)
      .map((k) => ({ path: text(k.path, 600), sample: typeof k.sample === "string" ? k.sample.slice(0, 60).replace(/[\u0000-\u001f\u007f]/g, " ") : "" }))
      .filter((k): k is { path: string; sample: string } => k.path !== null)
      .slice(0, 80),
    keys_scope: body.keys_scope === "item" || body.keys_scope === "response" ? body.keys_scope : null,
    skipped: codeCounts(body.skipped),
    checked_at: checkedAt,
  };
}

export function previewRateLimited(retryAfter: unknown): AppError {
  const n = typeof retryAfter === "number" && Number.isFinite(retryAfter) ? Math.ceil(retryAfter) : NaN;
  const sec = n >= 1 && n <= 60 ? n : PREVIEW_WINDOW_S;
  return new AppError(429, "PREVIEW_RATE_LIMITED", "Проверять страницу JSON API можно не чаще раза в 5 секунд", { retry_after: sec });
}

export function previewUnavailable(): AppError {
  return new AppError(503, "PREVIEW_UNAVAILABLE", "Проверка JSON API недоступна: обновите provider-gateway", { service: "provider-gateway" });
}

export function sourceRoutes(app: App, ctx: BffContext): void {
  const registry = ctx.domains.sourceRegistry;
  const path = (id: string) => `/internal/v1/sources/${id.toLowerCase()}`;

  app.get<{ Querystring: { country?: string; enabled?: string; q?: string; cursor?: string; limit?: string } }>(
    "/admin/v1/sources",
    {
      config: requirePermission("sources.manage"),
      schema: {
        response: ok(SOURCE_PAGE),
        querystring: query({ country: COUNTRY, enabled: BOOL_Q, q: str(1, 120), cursor: CURSOR_Q, limit: LIMIT_Q }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const { country, enabled, q } = req.query;
      const page = await registry.get<Page<Source>>("/internal/v1/sources", {
        actor: auth.actor,
        query: { country, enabled, q, ...pageQuery(req.query) },
      });
      return { ...page, items: await namedSources(ctx, auth, page.items ?? []) };
    },
  );

  // статический путь: у Fastify он приоритетнее /admin/v1/sources/:id
  app.get(
    "/admin/v1/sources/crawl-stats",
    { config: requirePermission("sources.manage", "discovery.manage"), schema: { response: ok(SOURCE_CRAWL_STATS) } },
    async (req) => {
      const auth = staffOf(req);
      const items: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < CRAWL_MAX_PAGES; page++) {
        const body = await ctx.domains.providerGateway.get<{ items?: unknown; next_cursor?: unknown }>(AI_WEB_SOURCES, {
          actor: auth.actor,
          query: { limit: String(CRAWL_PAGE_LIMIT), cursor },
        });
        if (Array.isArray(body?.items)) items.push(...body.items);
        const next = body?.next_cursor;
        if (typeof next !== "string" || !next || next === cursor) break;
        cursor = next;
      }
      return normalizeCrawlStats({ items });
    },
  );

  // 9.3: «Проверить» страницу JSON API из формы (до сохранения), без AI и без записи событий
  app.post<{ Body: Record<string, unknown> & { source_id?: string; event_domains: string[]; media_domains: string[]; json_api: { url?: string } } }>(
    "/admin/v1/sources/json-api/preview",
    { config: requirePermission("sources.manage"), schema: { response: ok(SOURCE_JSON_API_PREVIEW), body: JSON_API_PREVIEW_INPUT } },
    async (req) => {
      const auth = staffOf(req);
      const { source_id: sourceId, ...input } = req.body;
      if (sourceId) {
        // 404/403 домена — как есть; домены — сохранённые, иначе (форма с другими доменами) — свежий step-up
        const current = await registry.get<Source>(path(sourceId), { actor: auth.actor });
        const same = normDomains(input.event_domains) === normDomains(current.event_domains) && normDomains(input.media_domains) === normDomains(current.media_domains);
        if (same) {
          input.event_domains = current.event_domains;
          input.media_domains = current.media_domains;
        } else if (!hasFreshStepUp(ctx, auth)) throw stepUpRequired("sources.manage");
      } else if (!hasFreshStepUp(ctx, auth)) throw stepUpRequired("sources.manage");
      let body: unknown;
      try {
        body = await ctx.domains.providerGateway.post<unknown>(JSON_API_PREVIEW, {
          actor: auth.actor,
          body: input,
          retries: 0,
          timeoutMs: PREVIEW_TIMEOUT_MS,
          breakerKey: PREVIEW_BREAKER,
        });
      } catch (err) {
        if (err instanceof UpstreamError && err.status === 429) throw previewRateLimited(err.details.retry_after);
        // старый provider-gateway без маршрута предпросмотра
        if (err instanceof UpstreamError && (err.status === 404 || err.status === 405)) throw previewUnavailable();
        throw err;
      }
      const out = normalizeJsonApiPreview(body);
      if (!out) {
        ctx.log.warn({ upstream: "provider-gateway", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "json api preview rejected by normalization");
        throw upstreamUnavailable("provider-gateway");
      }
      let host: string | null = null;
      try {
        host = new URL(String(input.json_api.url)).hostname;
      } catch {
        host = null;
      }
      try {
        await writeAudit(
          ctx,
          auth,
          {
            action: "source.json_api.preview",
            object_type: "source",
            object_id: sourceId?.toLowerCase() ?? null,
            after: { host, ok: out.ok, code: out.code, items_total: out.items_total, events: out.events.length },
          },
          req.ip,
        );
      } catch (err) {
        // проверка — чтение без изменений: сбой журнала не отнимает у сотрудника результат (запись — в лог)
        ctx.log.warn({ upstream: "audit", err: err instanceof Error ? err.name : "unknown" }, "json api preview not audited");
      }
      return out;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/v1/sources/:id",
    { config: requirePermission("sources.manage"), schema: { response: ok(SOURCE_DETAIL), params: ID_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return namedSourceDetail(ctx, auth, await registry.get<SourceDetail>(path(req.params.id), { actor: auth.actor }));
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    "/admin/v1/sources",
    {
      config: { ...requirePermission("sources.manage"), ...requireStepUp() },
      schema: {
        response: ok(SOURCE),
        body: obj({ slug: SOURCE_SLUG, ...SOURCE_FIELDS, reason: REASON }, INPUT_REQUIRED),
      },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await registry.call<Source>("POST", "/internal/v1/sources", {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      const [named] = await namedSources(ctx, auth, [res.body]);
      return reply.status(res.status).send(named);
    },
  );

  async function requireStepUpIfTrustChanges(auth: StaffAuth, id: string, body: SourcePatch): Promise<void> {
    if (!SOURCE_STEP_UP_FIELDS.some((f) => f in body) || hasFreshStepUp(ctx, auth)) return;
    // 404/403 домена — как есть (ошибка ресурса важнее требования step-up)
    const current = await registry.get<Source>(path(id), { actor: auth.actor });
    if (current.version !== body.expected_version || changesTrustFields(body, current)) {
      throw stepUpRequired("sources.manage");
    }
  }

  app.patch<{ Params: { id: string }; Body: SourcePatch }>(
    "/admin/v1/sources/:id",
    {
      config: requirePermission("sources.manage"), // step-up — условный, в обработчике (поля доверия)
      schema: {
        response: ok(SOURCE),
        params: ID_PARAMS,
        body: obj(
          { expected_version: { type: "integer", minimum: 1, maximum: 2_147_483_647 }, ...SOURCE_FIELDS, reason: REASON },
          ["expected_version", "reason"],
          { minProperties: 3 },
        ),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      await requireStepUpIfTrustChanges(auth, req.params.id, req.body);
      const res = await registry.call<Source>("PATCH", path(req.params.id), { actor: auth.actor, body: req.body });
      return (await namedSources(ctx, auth, [res.body]))[0];
    },
  );
}
