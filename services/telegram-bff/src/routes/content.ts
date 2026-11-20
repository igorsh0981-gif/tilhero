/**
 * Спринт 3 — учебное содержание ученика: языки, карта навыков, траектория уроков, каталог сценариев, медиатека (аудио —
 * прокси с кешем), заявки на песни и фильмы.
 *
 * Субъект внутреннего JWT (CONVENTIONS §8): learning-plan, diagnostics — активный ученик (lrn). catalog (сценарии, медиа,
 * аудио, заявки) — sub = аккаунт и claims `lrn` (активный ученик) и `age_band` (возраст аккаунта): catalog сам распознаёт
 * детский профиль и сужает аудиторию до kids независимо от `?audience=` (защита в глубину, решения ревью спринта 3).
 * Заявки на песни и фильмы детскому профилю — 403 KIDS_NOT_ALLOWED ещё в BFF, до вызова catalog (AT-38). Сегмент ученика
 * `audience` (content.ts) — в catalog и learning-plan: детям 6–13 — только детское.
 *
 * Права на медиа: BFF ничего не скачивает и не открывает по ссылке ученика — ссылка заявки только передаётся
 * контент-менеджеру; аудио отдаётся только из catalog (авторские файлы ≤ 3 МБ) после проверки прав в catalog.
 */
import { createHash } from "node:crypto";
import { Type, type TSchema } from "@fastify/type-provider-typebox";
import type { MediaRequest, MyLanguages, SkillMap } from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import { asAccount, asLearner, loadMe } from "../account.js";
import { expectShape, matches } from "../check.js";
import type { AudioEntry } from "../content.js";
import type { BffContext } from "../context.js";
import type { IdentityMe } from "../views.js";
import { BEARER, authOf, errorResponses, idempotencyKey, type App } from "../http.js";
import {
  AudioBytesSchema,
  AudioHeadersSchema,
  ContentIdParamsSchema,
  DEFAULT_PAIR,
  IdempotencyHeadersSchema,
  MediaCardSchema,
  MediaDetailSchema,
  MediaPageSchema,
  MediaQuerySchema,
  MediaRequestCreateSchema,
  MediaRequestListSchema,
  MediaRequestSchema,
  MyLanguagesSchema,
  PairQuerySchema,
  ScenarioCardSchema,
  ScenarioDetailSchema,
  ScenarioPageSchema,
  ScenarioQuerySchema,
  SkillMapDomainSchema,
  SkillMapSchema,
  TrajectorySchema,
} from "../schemas.js";
import type { AccessClaims } from "../tokens.js";
import { catalogUnavailable, upstreamUnavailable } from "../upstream.js";

const user = { access: "user" } as const;
const enc = encodeURIComponent;

/** Аудио авторских сценок: файл ≤ 3 МБ (INTERNAL_API §1.1); больше BFF не читает и не держит в памяти. */
export const AUDIO_MAX_BYTES = 3 * 1024 * 1024;
export const AUDIO_TYPES: ReadonlySet<string> = new Set(["audio/mpeg", "audio/ogg", "audio/mp4"]);

export const kidsNotAllowed = () =>
  new AppError(403, "KIDS_NOT_ALLOWED", "Заявки на песни и фильмы отправляет взрослый из своего профиля — попросите родителя");

/** Детский профиль (lrn ≠ sub): заявки на песни и фильмы недоступны (bff.ts, AT-38). */
function forbidKids(auth: AccessClaims): void {
  if (auth.learnerId !== auth.accountId) throw kidsNotAllowed();
}

const KID_BANDS: ReadonlySet<string> = new Set(["6-9", "10-13"]);

/** Claims внутреннего JWT для catalog (защита в глубину, INTERNAL_API «Решения по ревью»): sub — аккаунт, lrn — активный
 *  ученик, age_band — возраст аккаунта. Детский профиль catalog распознаёт сам (lrn ≠ sub или детский age_band) и
 *  принудительно сужает аудиторию до kids. */
export function claimsOf(auth: AccessClaims, accountAgeBand: string | null): Record<string, string> {
  return { lrn: auth.learnerId, ...(accountAgeBand ? { age_band: accountAgeBand } : {}) };
}

/** Вызов catalog от имени ученика: сегмент (audience) и параметры токена (sub = аккаунт + claims). */
async function asLearnerOfCatalog(ctx: BffContext, auth: AccessClaims) {
  const seg = await ctx.audience.segment(ctx, auth);
  return { audience: seg.audience, ro: { subject: asAccount(auth), claims: claimsOf(auth, seg.accountAgeBand) } };
}

/** Claims заявки: возраст аккаунта детский (6–13) — отказ ещё в BFF. */
function requestClaims(auth: AccessClaims, me: IdentityMe): Record<string, string> {
  const band = me.user.age_band ?? null;
  if (band && KID_BANDS.has(band)) throw kidsNotAllowed();
  return claimsOf(auth, band);
}

/** Страница списка домена: обёртка обязана быть по контракту; элемент не по схеме отбрасывается (с предупреждением). */
export function pageView<S extends TSchema>(ctx: BffContext, service: string, what: string, item: S, res: unknown) {
  const page = res as { items?: unknown; next_cursor?: unknown } | null;
  if (!page || typeof page !== "object" || !Array.isArray(page.items) || !(page.next_cursor === null || page.next_cursor === undefined || typeof page.next_cursor === "string")) {
    return expectShape(ctx.log, service, what, Type.Object({ items: Type.Array(item), next_cursor: Type.Union([Type.String(), Type.Null()]) }), res);
  }
  const items = page.items.filter((i) => matches(item, i));
  if (items.length < page.items.length) {
    ctx.log.warn({ upstream: service, check: what, dropped: page.items.length - items.length, upstream_code: "UPSTREAM_BAD_RESPONSE" }, "list items dropped");
  }
  return { items, next_cursor: typeof page.next_cursor === "string" ? page.next_cursor : null };
}

/** Байты аудио из ответа catalog: тип из ответа (только аудио), не больше 3 МБ — без чтения лишнего. */
export async function readAudio(resp: Response): Promise<Omit<AudioEntry, "etag"> & { etag: string | null }> {
  const contentType = (resp.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!AUDIO_TYPES.has(contentType)) throw new Error("unexpected content type");
  const declared = Number(resp.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > AUDIO_MAX_BYTES) {
    await resp.body?.cancel().catch(() => undefined);
    throw new Error("audio too large");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("no body");
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > AUDIO_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("audio too large");
    }
    chunks.push(value);
  }
  if (total === 0) throw new Error("empty audio");
  return { contentType, bytes: Buffer.concat(chunks), etag: resp.headers.get("etag") };
}

export const etagMatches = (header: string | undefined, etag: string): boolean =>
  !!header && header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*");

export function contentRoutes(app: App, ctx: BffContext): void {
  const { diagnostics, learningPlan, catalogRaw } = ctx.domains;
  const log = ctx.log;

  // ---------------------------------------------------------------- языки (APP-LANG-01/02, AT-31)
  app.get(
    "/v1/languages",
    {
      config: user,
      schema: {
        tags: ["languages"],
        summary: "Мои языки: активная пара ru-en и остальные пары справочника («скоро», запустить нельзя)",
        security: BEARER,
        response: { 200: MyLanguagesSchema, ...errorResponses(401, 423) },
      },
    },
    async (): Promise<MyLanguages> => {
      const rows = await ctx.pairs.get();
      const pairs = rows
        .filter((p) => p.status !== "archived")
        .map((p) => ({ pair_id: p.pair_id, source: p.source, target: p.target, title: p.title, status: p.status, available: p.status === "published" && !!p.course_id }))
        .sort((a, b) => (a.pair_id === DEFAULT_PAIR ? -1 : b.pair_id === DEFAULT_PAIR ? 1 : Number(b.available) - Number(a.available) || a.pair_id.localeCompare(b.pair_id)));
      return { active_pair_id: DEFAULT_PAIR, pairs };
    },
  );

  // ---------------------------------------------------------------- карта навыков (APP-PLAN-01, AT-35)
  app.get(
    "/v1/skills/map",
    {
      config: user,
      schema: {
        tags: ["skills"],
        summary: "Карта навыков: состояния из diagnostics, названия и уровни — из снимка курса catalog (кеш по ETag)",
        description:
          "Навык вне опубликованного курса не показывается. Снимка курса нет (catalog недоступен, кеша нет) — 503 CATALOG_UNAVAILABLE. " +
          "409 PAIR_NOT_AVAILABLE; 410 USER_DELETED.",
        security: BEARER,
        querystring: PairQuerySchema,
        response: { 200: SkillMapSchema, ...errorResponses(401, 409, 410, 423) },
      },
    },
    async (req): Promise<SkillMap> => {
      const auth = authOf(req);
      const res = expectShape(
        log,
        "diagnostics",
        "skill_map",
        SkillMapDomainSchema,
        await diagnostics.get("/internal/v1/skills/map", { subject: asLearner(auth), query: { pair_id: req.query.pair_id ?? DEFAULT_PAIR } }),
      );
      const meta = await ctx.snapshots.skills(res.course_id);
      const skills: SkillMap["skills"] = [];
      for (const s of res.skills) {
        const m = meta?.get(s.skill_id);
        const fromDomain = s.area && s.title && s.level ? { area: s.area, title: s.title, level: s.level } : null;
        if (!m && !meta && !fromDomain) throw catalogUnavailable();
        const area = m?.area ?? fromDomain?.area;
        const level = m?.level ?? fromDomain?.level;
        const title = m?.title ?? fromDomain?.title;
        const entry = {
          skill_id: s.skill_id,
          area,
          title,
          level,
          state: s.state,
          confidence: s.confidence,
          prerequisites: m ? [...m.prerequisites] : s.prerequisites,
          updated_at: s.updated_at,
          history: s.history.map((h) => ({ source: h.source, outcome: h.outcome, at: h.at })),
        };
        // навык не из опубликованного курса или с неизвестной областью / уровнем — не показывается
        if (matches(SkillMapSchema.properties.skills.items, entry)) skills.push(entry as SkillMap["skills"][number]);
      }
      const counts = { not_started: 0, learning: 0, demonstrated: 0, retained: 0 };
      for (const s of skills) counts[s.state] += 1;
      return { pair_id: res.pair_id, course_id: res.course_id, counts, skills };
    },
  );

  // ---------------------------------------------------------------- траектория (APP-PLAN-02/03, AT-36)
  app.get(
    "/v1/plan/trajectory",
    {
      config: user,
      schema: {
        tags: ["plan"],
        summary: "Мой план: следующий урок с причиной, обязательные и дополнительные уроки (пересчёт после смены цели)",
        description:
          "learning-plan пересчитывает траекторию, если изменились диагностика, навыки, цель или темы плана, сегмент ученика или курс. " +
          "409 PAIR_NOT_AVAILABLE {pair_id}; 410 USER_DELETED; 503 CATALOG_UNAVAILABLE — нет снимка курса.",
        security: BEARER,
        querystring: PairQuerySchema,
        response: { 200: TrajectorySchema, ...errorResponses(401, 409, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const audience = await ctx.audience.of(ctx, auth);
      const res = await learningPlan.get("/internal/v1/plan/trajectory", {
        subject: asLearner(auth),
        query: { pair_id: req.query.pair_id ?? DEFAULT_PAIR, audience },
      });
      return expectShape(log, "learning-plan", "trajectory", TrajectorySchema, res);
    },
  );

  // ---------------------------------------------------------------- сценарии (APP-PLAN-04, AT-37)
  app.get(
    "/v1/scenarios",
    {
      config: user,
      schema: {
        tags: ["scenarios"],
        summary: "Каталог опубликованных сценариев разговоров (фильтры цели, уровня, темы); детям 6–13 — только детские",
        security: BEARER,
        querystring: ScenarioQuerySchema,
        response: { 200: ScenarioPageSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { audience, ro } = await asLearnerOfCatalog(ctx, auth);
      const q = req.query;
      const res = await catalogRaw.json("GET", "/internal/v1/scenarios", {
        ...ro,
        query: { audience, goal: q.goal, level: q.level, topic: q.topic, limit: q.limit ?? 20, cursor: q.cursor },
      });
      return pageView(ctx, "catalog", "scenarios", ScenarioCardSchema, res);
    },
  );

  app.get(
    "/v1/scenarios/:id",
    {
      config: user,
      schema: {
        tags: ["scenarios"],
        summary: "Сценарий: задача, персонажи, критерии завершения, первая реплика и варианты ответа, исходы (без полного графа)",
        description: "404 SCENARIO_NOT_FOUND — нет, не опубликован или не для аудитории ученика.",
        security: BEARER,
        params: ContentIdParamsSchema,
        response: { 200: ScenarioDetailSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { audience, ro } = await asLearnerOfCatalog(ctx, auth);
      const res = await catalogRaw.json("GET", `/internal/v1/scenarios/${enc(req.params.id)}`, { ...ro, query: { audience } });
      return expectShape(log, "catalog", "scenario", ScenarioDetailSchema, res);
    },
  );

  // ---------------------------------------------------------------- медиатека (APP-MEDIA-01, AT-29, AT-38)
  app.get(
    "/v1/media",
    {
      config: user,
      schema: {
        tags: ["media"],
        summary: "Медиатека: опубликованные материалы с действующими правами (UZ), по аудитории ученика; фильтры типа, уровня, темы",
        security: BEARER,
        querystring: MediaQuerySchema,
        response: { 200: MediaPageSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { audience, ro } = await asLearnerOfCatalog(ctx, auth);
      const q = req.query;
      const res = await catalogRaw.json("GET", "/internal/v1/media", {
        ...ro,
        query: { audience, type: q.type, level: q.level, topic: q.topic, limit: q.limit ?? 20, cursor: q.cursor },
      });
      return pageView(ctx, "catalog", "media", MediaCardSchema, res);
    },
  );

  app.get(
    "/v1/media/requests",
    {
      config: user,
      schema: {
        tags: ["media"],
        summary: "Мои заявки на песни и фильмы: статусы и комментарии контент-менеджера",
        description: "Заявки аккаунта; детский профиль — 403 KIDS_NOT_ALLOWED.",
        security: BEARER,
        response: { 200: MediaRequestListSchema, ...errorResponses(401, 403, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidKids(auth);
      const seg = await ctx.audience.segment(ctx, auth);
      if (seg.accountAgeBand && KID_BANDS.has(seg.accountAgeBand)) throw kidsNotAllowed();
      const res = await catalogRaw.json("GET", "/internal/v1/media/requests", { subject: asAccount(auth), claims: claimsOf(auth, seg.accountAgeBand) });
      return expectShape(log, "catalog", "media_requests", MediaRequestListSchema, res);
    },
  );

  app.post(
    "/v1/media/requests",
    {
      config: user,
      schema: {
        tags: ["media"],
        summary: "Заявка контент-менеджеру на песню, фильм или сериал (ничего не скачивается и не расшифровывается)",
        description:
          "Idempotency-Key (UUID) обязателен. Ссылка — только https, BFF и catalog её не открывают. Детский профиль — 403 KIDS_NOT_ALLOWED; " +
          "> 5 в сутки — 429 {retry_after}.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: MediaRequestCreateSchema,
        response: { 201: MediaRequestSchema, ...errorResponses(401, 403, 410, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      forbidKids(auth);
      const key = idempotencyKey(req, true)!;
      const me = await loadMe(ctx, asAccount(auth));
      const b = req.body;
      const res = await catalogRaw.json<MediaRequest>("POST", "/internal/v1/media/requests", {
        subject: asAccount(auth),
        claims: requestClaims(auth, me),
        idempotencyKey: key,
        body: {
          kind: b.kind,
          title: b.title.trim(),
          ...(b.link ? { link: b.link } : {}),
          ...(b.comment?.trim() ? { comment: b.comment.trim() } : {}),
          ui_locale: me.user.locale === "uz" ? "uz" : "ru",
        },
      });
      return reply.code(201).send(expectShape(log, "catalog", "media_request", MediaRequestSchema, res));
    },
  );

  app.get(
    "/v1/media/:id",
    {
      config: user,
      schema: {
        tags: ["media"],
        summary: "Материал: источник и атрибуция, транскрипт (если разрешён лицензией), фразы, голоса синтеза речи",
        description: "404 MEDIA_NOT_AVAILABLE — снят с публикации, права истекли или не для аудитории ученика.",
        security: BEARER,
        params: ContentIdParamsSchema,
        response: { 200: MediaDetailSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { audience, ro } = await asLearnerOfCatalog(ctx, auth);
      const res = await catalogRaw.json("GET", `/internal/v1/media/${enc(req.params.id)}`, { ...ro, query: { audience } });
      const d = expectShape(log, "catalog", "media", MediaDetailSchema, res);
      // транскрипт — только если лицензия разрешает его показ (защита в глубину)
      return d.allowed_uses.includes("show_transcript") ? d : { ...d, transcript: null };
    },
  );

  app.get(
    "/v1/media/:id/audio",
    {
      config: user,
      schema: {
        tags: ["media"],
        summary: "Аудиофайл материала (прокси catalog с кешем; права и аудитория проверяются при каждом запросе)",
        description:
          "Content-Type — из ответа catalog (audio/mpeg | audio/ogg | audio/mp4), файл ≤ 3 МБ; ETag, Cache-Control: private, max-age=3600, " +
          "If-None-Match → 304. 404 MEDIA_NOT_AVAILABLE | AUDIO_NOT_FOUND — файла нет (синтез речи устройства).",
        security: BEARER,
        params: ContentIdParamsSchema,
        headers: AudioHeadersSchema,
        response: { 200: AudioBytesSchema, 304: Type.Null({ description: "Не изменился" }), ...errorResponses(401, 404, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const { audience, ro } = await asLearnerOfCatalog(ctx, auth);
      const id = req.params.id;
      const cached = ctx.audio.get(id);
      let resp: Response;
      try {
        resp = await catalogRaw.get(`/internal/v1/media/${enc(id)}/audio`, {
          ...ro,
          query: { audience },
          headers: cached ? { "if-none-match": cached.etag } : {},
        });
      } catch (err) {
        if (err instanceof AppError && err.status === 404) ctx.audio.delete(id);
        throw err;
      }
      let entry: AudioEntry;
      if (resp.status === 304 && cached) {
        entry = cached;
      } else if (resp.status === 200) {
        try {
          const a = await readAudio(resp);
          entry = { contentType: a.contentType, bytes: a.bytes, etag: a.etag ?? `"${createHash("sha256").update(a.bytes).digest("hex")}"` };
        } catch (err) {
          log.warn({ upstream: "catalog", check: "media_audio", reason: (err as Error).message, upstream_code: "UPSTREAM_BAD_RESPONSE" }, "media audio rejected");
          throw upstreamUnavailable("catalog");
        }
        ctx.audio.set(id, entry);
      } else {
        await resp.body?.cancel().catch(() => undefined);
        log.warn({ upstream: "catalog", check: "media_audio", upstream_status: resp.status, upstream_code: "UPSTREAM_BAD_RESPONSE" }, "media audio rejected");
        throw upstreamUnavailable("catalog");
      }
      void reply.header("etag", entry.etag).header("cache-control", "private, max-age=3600");
      if (etagMatches(req.headers["if-none-match"], entry.etag)) return reply.code(304).send(null);
      return reply.header("content-type", entry.contentType).header("content-length", String(entry.bytes.length)).send(entry.bytes);
    },
  );
}
