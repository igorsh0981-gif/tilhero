/**
 * Контент (catalog), пути — как admin.ts «Контент и диагностика» (совпадают с путями домена `/admin/v1/content/*`).
 *
 * content.read — списки, карточка ключа, версия, сухая проверка (validate), аудио для предпросмотра;
 * content.edit — черновик, копия опубликованной, правка, отправка на проверку, тестовый прогон сценария, загрузка
 * аудио; content.review — проверка (не своей версии: 409 SELF_REVIEW домена) и очередь проверки; content.publish +
 * step-up — публикация, снятие, откат; media.rights — реестр заявок учеников (персональные данные: ссылка и
 * комментарий) и «взять», а с step-up — решение и подтверждение прав медиа;
 * dashboard.read | content.read — сводка. Права проверяются здесь до вызова домена; catalog проверяет их повторно.
 *
 * Ошибки домена — как есть (код, статус, details): 422 CONTENT_INVALID {errors: [{path, code, message}]},
 * 409 SELF_REVIEW, DRAFT_EXISTS {version}, VERSION_CONFLICT {payload_hash}, VERSION_NOT_DRAFT, VERSION_NOT_APPROVED,
 * CONTENT_IN_USE {refs}, CONTENT_KEY_EXISTS, 422 AUDIO_INVALID {reason}, 404 CONTENT_NOT_FOUND …
 * Лимит тела: загрузка аудио — 4,5 МБ (JSON base64 ≤ 3 МБ), черновик и правка версии — 256 КБ, остальное — 64 КБ.
 */
import type { FastifyReply } from "fastify";
import type { ContentRow, Page } from "@tilhero/contracts/admin";
import {
  ARCHIVED,
  ARCHIVED_DOMAIN,
  AUDIO_BLOB,
  CONTENT_DETAIL,
  CONTENT_DETAIL_DOMAIN,
  CONTENT_ROW_PAGE,
  CONTENT_ROW_PAGE_DOMAIN,
  CONTENT_SUMMARY,
  CONTENT_VERSION,
  MEDIA_REQUEST,
  MEDIA_REQUEST_PAGE,
  SCENARIO_TEST_RUN,
  VALIDATION_RESULT,
  publicRow,
} from "../contractContent.js";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, passReplayed, staffOf, type App, type StaffAuth } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import {
  AUDIO_MAX_BYTES,
  AUDIO_TYPES,
  AUDIO_UPLOAD,
  BAND,
  CONTENT_BODY_LIMIT,
  CONTENT_CREATE,
  CONTENT_KEY,
  CONTENT_KIND,
  CONTENT_NEW_VERSION,
  CONTENT_REVIEW,
  CONTENT_ROLLBACK,
  CONTENT_UPDATE,
  CURSOR_Q,
  LIMIT_Q,
  MEDIA_REQUEST_DECISION,
  MEDIA_REQUEST_STATUS,
  REASON,
  RIGHTS_APPROVE,
  UPLOAD_BODY_LIMIT,
  UUID,
  VERSION_NO,
  VERSION_STATUS,
  obj,
  pageQuery,
  params,
  query,
  str,
} from "../schemas.js";
import { DOMAIN, upstreamUnavailable, type DomainResponse } from "../upstream.js";
import { out, relay, shaped } from "./common.js";

const SERVICE = DOMAIN.catalog;
const BASE = "/admin/v1/content";
/** Загрузка до 4,5 МБ по приватной сети — дольше обычного вызова домена. */
const UPLOAD_TIMEOUT_MS = 15_000;

const KIND_PARAMS = params({ kind: CONTENT_KIND });
const KEY_PARAMS = params({ kind: CONTENT_KIND, key: CONTENT_KEY });
const VERSION_PARAMS = params({ kind: CONTENT_KIND, key: CONTENT_KEY, v: VERSION_NO });
const FIXED_KIND_VERSION_PARAMS = params({ key: CONTENT_KEY, v: VERSION_NO });
const ID_PARAMS = params({ id: UUID });
const REASON_BODY = obj({ reason: REASON }, ["reason"]);
const EMPTY = obj({});

type KindP = { kind: string };
type KeyP = KindP & { key: string };
type VersionP = KeyP & { v: string };
type PageQ = { cursor?: string; limit?: string };

/** Строки домена (с `updated_by`) → имена через staff/lookup → ContentRow без `updated_by`. */
async function rowPage(ctx: BffContext, auth: StaffAuth, body: unknown): Promise<Page<ContentRow>> {
  const page = await shaped(ctx, auth, SERVICE, CONTENT_ROW_PAGE_DOMAIN, body, { names: true });
  return { items: page.items.map(publicRow), next_cursor: page.next_cursor };
}

export function contentRoutes(app: App, ctx: BffContext): void {
  const catalog = ctx.domains.catalog;
  const keyPath = (p: KeyP) => `${BASE}/${p.kind}/${encodeURIComponent(p.key)}`;
  const verPath = (p: KeyP & { v: string }) => `${keyPath(p)}/versions/${Number(p.v)}`;
  /** Команда над версией → ContentVersion с именами, статус домена и Idempotent-Replayed. */
  const versionReply = (auth: StaffAuth, reply: FastifyReply, res: DomainResponse<unknown>) =>
    relay(ctx, auth, reply, SERVICE, CONTENT_VERSION, res, { names: true });

  // ---------------------------------------------------------------- сводка, очередь проверки (до /:kind)

  app.get(
    `${BASE}/summary`,
    { config: requirePermission("dashboard.read", "content.read"), schema: { response: out(CONTENT_SUMMARY) } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, CONTENT_SUMMARY, await catalog.get<unknown>(`${BASE}/summary`, { actor: auth.actor }));
    },
  );

  app.get<{ Querystring: { kind?: string } & PageQ }>(
    `${BASE}/review-queue`,
    {
      config: requirePermission("content.review"),
      schema: { response: out(CONTENT_ROW_PAGE), querystring: query({ kind: CONTENT_KIND, cursor: CURSOR_Q, limit: LIMIT_Q }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await catalog.get<unknown>(`${BASE}/review-queue`, { actor: auth.actor, query: { kind: req.query.kind, ...pageQuery(req.query) } });
      return rowPage(ctx, auth, body);
    },
  );

  // ---------------------------------------------------------------- аудио авторских сценок

  app.post<{ Body: { filename: string; content_type: string; data_base64: string } }>(
    `${BASE}/blobs`,
    {
      bodyLimit: UPLOAD_BODY_LIMIT,
      config: requirePermission("content.edit"),
      schema: { response: out(AUDIO_BLOB), body: AUDIO_UPLOAD },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("POST", `${BASE}/blobs`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
        timeoutMs: Math.max(ctx.config.upstreamTimeoutMs, UPLOAD_TIMEOUT_MS),
      });
      // 201 — новый файл, 200 — такой же уже загружен (sha256)
      return relay(ctx, auth, reply, SERVICE, AUDIO_BLOB, res);
    },
  );

  /**
   * Аудио для предпросмотра (content.read): байты catalog с его типом — только audio/mpeg | audio/ogg | audio/mp4 и
   * ≤ 3 МБ, иначе 503 (в браузер не уходит ничего, что можно исполнить). Cache-Control: no-store, nosniff — общие.
   */
  app.get<{ Params: { blobId: string } }>(
    `${BASE}/blobs/:blobId`,
    { config: requirePermission("content.read"), schema: { response: { "2xx": { type: "string" } }, params: params({ blobId: UUID }) } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.binary(`${BASE}/blobs/${req.params.blobId.toLowerCase()}`, { actor: auth.actor, maxBytes: AUDIO_MAX_BYTES });
      const type = res.body.contentType.split(";")[0]!.trim().toLowerCase();
      if (!(AUDIO_TYPES as readonly string[]).includes(type) || res.body.bytes.length === 0) {
        ctx.log.warn({ upstream: SERVICE, upstream_code: "UPSTREAM_BAD_RESPONSE", field: "content-type" }, "domain response rejected by normalization");
        throw upstreamUnavailable(SERVICE);
      }
      return reply.status(200).header("content-type", type).header("content-disposition", "inline").send(res.body.bytes);
    },
  );

  // ---------------------------------------------------------------- заявки учеников на песни и фильмы

  /** Реестр заявок — media.rights (ревью: ссылка и свободный комментарий ученика — персональные данные; content.read
   *  недостаточно). Число новых заявок для обзора — в сводке (content/summary, dashboard.read | content.read). */
  app.get<{ Querystring: { status?: string; q?: string } & PageQ }>(
    `${BASE}/media-requests`,
    {
      config: requirePermission("media.rights"),
      schema: {
        response: out(MEDIA_REQUEST_PAGE),
        querystring: query({ status: MEDIA_REQUEST_STATUS, q: str(1, 200), cursor: CURSOR_Q, limit: LIMIT_Q }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await catalog.get<unknown>(`${BASE}/media-requests`, {
        actor: auth.actor,
        query: { status: req.query.status, q: req.query.q, ...pageQuery(req.query) },
      });
      return shaped(ctx, auth, SERVICE, MEDIA_REQUEST_PAGE, body, { names: true });
    },
  );

  app.post<{ Params: { id: string } }>(
    `${BASE}/media-requests/:id/take`,
    { config: requirePermission("media.rights"), schema: { response: out(MEDIA_REQUEST), params: ID_PARAMS, body: EMPTY } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("POST", `${BASE}/media-requests/${req.params.id.toLowerCase()}/take`, { actor: auth.actor, body: {} });
      return relay(ctx, auth, reply, SERVICE, MEDIA_REQUEST, res, { names: true });
    },
  );

  /** Решение (media.rights, step-up) → уведомление ученику. Ссылка ученика сервером не открывается. */
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    `${BASE}/media-requests/:id/decide`,
    {
      config: { ...requirePermission("media.rights"), ...requireStepUp() },
      schema: { response: out(MEDIA_REQUEST), params: ID_PARAMS, body: MEDIA_REQUEST_DECISION },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("POST", `${BASE}/media-requests/${req.params.id.toLowerCase()}/decide`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relay(ctx, auth, reply, SERVICE, MEDIA_REQUEST, res, { names: true });
    },
  );

  // ---------------------------------------------------------------- команды, привязанные к виду

  /** Тестовый прогон сценария (content.edit) → ScenarioTestRun; хранится с хешем тела — после правки устаревает. */
  app.post<{ Params: { key: string; v: string } }>(
    `${BASE}/scenario/:key/versions/:v/test-run`,
    { config: requirePermission("content.edit"), schema: { response: out(SCENARIO_TEST_RUN), params: FIXED_KIND_VERSION_PARAMS, body: EMPTY } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("POST", `${verPath({ kind: "scenario", ...req.params })}/test-run`, { actor: auth.actor, body: {} });
      return relay(ctx, auth, reply, SERVICE, SCENARIO_TEST_RUN, res);
    },
  );

  /** Подтверждение прав медиа (media.rights, step-up); сбрасывается правкой черновика. */
  app.post<{ Params: { key: string; v: string }; Body: { note: string } }>(
    `${BASE}/media_asset/:key/versions/:v/rights-approve`,
    {
      config: { ...requirePermission("media.rights"), ...requireStepUp() },
      schema: { response: out(CONTENT_VERSION), params: FIXED_KIND_VERSION_PARAMS, body: RIGHTS_APPROVE },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("POST", `${verPath({ kind: "media_asset", ...req.params })}/rights-approve`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return versionReply(auth, reply, res);
    },
  );

  // ---------------------------------------------------------------- сущности контента

  app.get<{ Params: KindP; Querystring: { q?: string; status?: string; level?: string } & PageQ }>(
    `${BASE}/:kind`,
    {
      config: requirePermission("content.read"),
      schema: {
        response: out(CONTENT_ROW_PAGE),
        params: KIND_PARAMS,
        querystring: query({ q: str(1, 200), status: VERSION_STATUS, level: BAND, cursor: CURSOR_Q, limit: LIMIT_Q }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const { q, status, level } = req.query;
      const body = await catalog.get<unknown>(`${BASE}/${req.params.kind}`, { actor: auth.actor, query: { q, status, level, ...pageQuery(req.query) } });
      return rowPage(ctx, auth, body);
    },
  );

  app.post<{ Params: KindP; Body: { payload: Record<string, unknown> } }>(
    `${BASE}/:kind`,
    {
      bodyLimit: CONTENT_BODY_LIMIT,
      config: requirePermission("content.edit"),
      schema: { response: out(CONTENT_VERSION), params: KIND_PARAMS, body: CONTENT_CREATE },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("POST", `${BASE}/${req.params.kind}`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return versionReply(auth, reply, res);
    },
  );

  app.get<{ Params: KeyP }>(
    `${BASE}/:kind/:key`,
    { config: requirePermission("content.read"), schema: { response: out(CONTENT_DETAIL), params: KEY_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      const d = await shaped(ctx, auth, SERVICE, CONTENT_DETAIL_DOMAIN, await catalog.get<unknown>(keyPath(req.params), { actor: auth.actor }), {
        names: true,
      });
      return { row: publicRow(d.row), versions: d.versions };
    },
  );

  app.post<{ Params: KeyP; Body: { from_version: number } }>(
    `${BASE}/:kind/:key/versions`,
    { config: requirePermission("content.edit"), schema: { response: out(CONTENT_VERSION), params: KEY_PARAMS, body: CONTENT_NEW_VERSION } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("POST", `${keyPath(req.params)}/versions`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return versionReply(auth, reply, res);
    },
  );

  app.get<{ Params: VersionP }>(
    `${BASE}/:kind/:key/versions/:v`,
    { config: requirePermission("content.read"), schema: { response: out(CONTENT_VERSION), params: VERSION_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, CONTENT_VERSION, await catalog.get<unknown>(verPath(req.params), { actor: auth.actor }), { names: true });
    },
  );

  app.put<{ Params: VersionP; Body: { payload: Record<string, unknown>; expected_hash: string } }>(
    `${BASE}/:kind/:key/versions/:v`,
    {
      bodyLimit: CONTENT_BODY_LIMIT,
      config: requirePermission("content.edit"),
      schema: { response: out(CONTENT_VERSION), params: VERSION_PARAMS, body: CONTENT_UPDATE },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      return versionReply(auth, reply, await catalog.call("PUT", verPath(req.params), { actor: auth.actor, body: req.body }));
    },
  );

  /** Сухая проверка в режиме публикации (content.read) → {ok, errors}. */
  app.post<{ Params: VersionP }>(
    `${BASE}/:kind/:key/versions/:v/validate`,
    { config: requirePermission("content.read"), schema: { response: out(VALIDATION_RESULT), params: VERSION_PARAMS, body: EMPTY } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("POST", `${verPath(req.params)}/validate`, { actor: auth.actor, body: {} });
      return relay(ctx, auth, reply, SERVICE, VALIDATION_RESULT, res);
    },
  );

  app.post<{ Params: VersionP }>(
    `${BASE}/:kind/:key/versions/:v/submit`,
    { config: requirePermission("content.edit"), schema: { response: out(CONTENT_VERSION), params: VERSION_PARAMS, body: EMPTY } },
    async (req, reply) => {
      const auth = staffOf(req);
      return versionReply(auth, reply, await catalog.call("POST", `${verPath(req.params)}/submit`, { actor: auth.actor, body: {} }));
    },
  );

  app.post<{ Params: VersionP; Body: Record<string, unknown> }>(
    `${BASE}/:kind/:key/versions/:v/review`,
    { config: requirePermission("content.review"), schema: { response: out(CONTENT_VERSION), params: VERSION_PARAMS, body: CONTENT_REVIEW } },
    async (req, reply) => {
      const auth = staffOf(req);
      return versionReply(auth, reply, await catalog.call("POST", `${verPath(req.params)}/review`, { actor: auth.actor, body: req.body }));
    },
  );

  app.post<{ Params: VersionP; Body: { reason: string } }>(
    `${BASE}/:kind/:key/versions/:v/publish`,
    {
      config: { ...requirePermission("content.publish"), ...requireStepUp() },
      schema: { response: out(CONTENT_VERSION), params: VERSION_PARAMS, body: REASON_BODY },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("POST", `${verPath(req.params)}/publish`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return versionReply(auth, reply, res);
    },
  );

  /** Снять с публикации → {row}; 409 CONTENT_IN_USE {refs} домена — как есть. */
  app.post<{ Params: KeyP; Body: { reason: string } }>(
    `${BASE}/:kind/:key/archive`,
    {
      config: { ...requirePermission("content.publish"), ...requireStepUp() },
      schema: { response: out(ARCHIVED), params: KEY_PARAMS, body: REASON_BODY },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("POST", `${keyPath(req.params)}/archive`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      passReplayed(reply, res);
      const d = await shaped(ctx, auth, SERVICE, ARCHIVED_DOMAIN, res.body, { names: true });
      return reply.status(res.status).send({ row: publicRow(d.row) });
    },
  );

  app.post<{ Params: KeyP; Body: { to_version: number; reason: string } }>(
    `${BASE}/:kind/:key/rollback`,
    {
      config: { ...requirePermission("content.publish"), ...requireStepUp() },
      schema: { response: out(CONTENT_VERSION), params: KEY_PARAMS, body: CONTENT_ROLLBACK },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await catalog.call("POST", `${keyPath(req.params)}/rollback`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return versionReply(auth, reply, res);
    },
  );
}
