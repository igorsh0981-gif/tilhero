/**
 * Игра и герои (admin.ts «Игра и герои», спринт 6): `/admin/v1/game/*` → gamification `/internal/v1/admin/game/*`
 * (docs/sprint6/INTERNAL_API.md §1.11, §10). Права проверяются здесь до вызова домена, gamification — повторно по actor.
 *
 *  - game.read — обзор, версии правил, герои, картинки (байты), магазин, события, кошелёк и реестр ученика;
 *  - game.manage — черновик правил (If-Match — как есть), проверка черновика, черновик героя, загрузка картинки,
 *    предметы магазина (создание — Idempotency-Key обязателен) и события недели (создание — Idempotency-Key обязателен);
 *  - game.publish + step-up — активация и откат правил, публикация героя, публикация и снятие предмета, публикация и
 *    отмена события;
 *  - wallet.adjust + step-up — ручная операция (Idempotency-Key обязателен), обратная запись, возврат покупки.
 * Команде со step-up admin-bff передаёт `X-Step-Up: ok` (staff_id — в actor-токене): gamification проверяет право и
 * step-up в домене (защита в глубину). Аудит `game.*` пишет gamification.
 *
 * Ошибки gamification — как есть (код, статус, details): 422 RULES_INVALID {errors}, 409 RULES_NOT_VALIDATED,
 * DRAFT_CONFLICT, HERO_IN_USE {learners}, EVENT_OVERLAP {event_id}, BALANCE_NEGATIVE, ALREADY_REVERSED, 413
 * ASSET_TOO_LARGE, 422 ASSET_INVALID {reason}, 404 *_NOT_FOUND. GAMIFICATION_URL не задана, домен недоступен, 5xx,
 * испорченный ответ → 503 UPSTREAM_UNAVAILABLE {service: gamification}; остальная админка работает.
 *
 * Картинка: сырое тело `image/webp | image/png` ≤ 300 КБ (читается потоком: больше — 413 ASSET_TOO_LARGE без вызова
 * домена), формат и размеры — по заголовку байтов (gameImage.ts). Байты для админки — `GET assets/{id}/content`
 * (game.read): только webp/png ≤ 300 КБ, совпадающие с сигнатурой, иначе 503; `nosniff`, `no-store`.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "@tilhero/ts-common";
import { parseDomain, type Codec } from "../codec.js";
import {
  ADMIN_GAME_EVENT,
  ADMIN_HERO,
  ADMIN_SHOP_ITEM,
  ADMIN_WALLET,
  GAME_EVENT_LIST,
  GAME_IMAGE,
  GAME_OVERVIEW,
  HERO_LIST,
  LEDGER_OPERATION,
  LEDGER_PAGE,
  REFUND_RESULT,
  RULES_LIST,
  RULES_VALIDATION,
  RULES_VERSION,
  SHOP_ITEM_LIST,
  withStaffRefs,
} from "../contractGame.js";
import type { BffContext } from "../context.js";
import { assetTooLarge, inspectAsset, isAssetType, mediaTypeOf, readImageHeader } from "../gameImage.js";
import { idempotencyKeyOf, ifMatchOf, passReplayed, staffOf, type App } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { NO_CONTENT } from "../responses.js";
import {
  ASSET_MAX_BYTES,
  ASSET_PURPOSE,
  CURSOR_Q,
  GAME_COMMENT,
  GAME_CURRENCY,
  GAME_EVENT_CREATE,
  GAME_EVENT_PATCH,
  GAME_EVENT_STATUS,
  GAME_ITEM_CODE,
  HERO_CODE,
  HERO_FIELDS,
  LIMIT_Q,
  OVERVIEW_PERIOD,
  RULES_COMMENT,
  RULES_DRAFT,
  RULES_VERSION_NO,
  SHOP_ITEM_CREATE,
  SHOP_ITEM_PATCH,
  UUID,
  WALLET_ADJUSTMENT,
  WALLET_REASON,
  obj,
  pageQuery,
  params,
  query,
} from "../schemas.js";
import { GAME_SERVICE, upstreamUnavailable, type CallOptions, type DomainClient } from "../upstream.js";
import { out } from "./common.js";

const BASE = "/admin/v1/game";
const INTERNAL = "/internal/v1/admin/game";
export const ASSET_UPLOAD_ROUTE = `${BASE}/assets`;
/** Загрузка ≤ 300 КБ по приватной сети — с запасом к обычному таймауту вызова домена. */
const UPLOAD_TIMEOUT_MS = 10_000;

const VERSION_PARAMS = params({ version: RULES_VERSION_NO });
const HERO_PARAMS = params({ code: HERO_CODE });
const ITEM_PARAMS = params({ code: GAME_ITEM_CODE });
const EVENT_PARAMS = params({ id: UUID });
const ASSET_PARAMS = params({ assetId: UUID });
const WALLET_PARAMS = params({ userId: UUID });
const OP_PARAMS = params({ userId: UUID, opId: UUID });
const PURCHASE_PARAMS = params({ userId: UUID, purchaseId: UUID });
const EMPTY = obj({});
/** Маршрут без параметров запроса: лишний параметр → 422 (как лишнее поле тела). */
const NO_QUERY = query({});

type Idem = "required" | "optional";
interface ProxyOptions {
  body?: unknown;
  query?: CallOptions["query"];
  idempotency?: Idem;
  headers?: Record<string, string>;
}

/**
 * Сырое тело картинки (`image/*`) — только для POST assets: поток читается до 300 КБ (больше → 413 ASSET_TOO_LARGE,
 * чтение прекращается); тип не webp/png → 422 ASSET_INVALID {reason: content_type}. На любом другом маршруте
 * `image/*` → 415. Парсер работает после onRequest — без сессии и права тело не читается вовсе.
 */
export function registerAssetParser(app: App): void {
  // fastify сверяет с типом вместе с параметрами («image/webp; charset="binary"») — только префикс
  app.addContentTypeParser(/^image\//i, (req, payload, done) => {
    if (req.method !== "POST" || req.routeOptions.url !== ASSET_UPLOAD_ROUTE) {
      done(new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Тип тела запроса не поддерживается"), undefined);
      return;
    }
    if (!isAssetType(mediaTypeOf(req.headers["content-type"]))) {
      done(new AppError(422, "ASSET_INVALID", "Картинка не подходит: нужен WebP или PNG", { reason: "content_type" }), undefined);
      return;
    }
    if (Number(req.headers["content-length"]) > ASSET_MAX_BYTES) {
      done(assetTooLarge(), undefined);
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let finished = false;
    const finish = (err: Error | null, body?: Buffer) => {
      if (finished) return;
      finished = true;
      payload.removeListener("data", onData);
      payload.removeListener("end", onEnd);
      payload.removeListener("error", onError);
      done(err, body);
    };
    const onData = (chunk: Buffer | string) => {
      const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += b.length;
      if (total > ASSET_MAX_BYTES) return finish(assetTooLarge());
      chunks.push(b);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks, total));
    const onError = (err: Error) => finish(Object.assign(err, { statusCode: 400 }));
    payload.on("data", onData);
    payload.on("end", onEnd);
    payload.on("error", onError);
    payload.resume();
  });
}

export function gameRoutes(app: App, ctx: BffContext): void {
  /** Клиент gamification; GAMIFICATION_URL не задана → 503 UPSTREAM_UNAVAILABLE {service: gamification}. */
  const game = (): DomainClient => {
    if (!ctx.gamification) throw upstreamUnavailable(GAME_SERVICE);
    return ctx.gamification;
  };

  /**
   * Вызов gamification с actor: Idempotency-Key (обязательный — 422 до домена), `X-Step-Up: ok` для маршрутов
   * requireStepUp → строгий кодек → имена сотрудников в StaffRef → статус домена и Idempotent-Replayed.
   */
  async function proxy<T>(req: FastifyRequest, reply: FastifyReply, method: string, path: string, c: Codec<T>, o: ProxyOptions = {}) {
    const auth = staffOf(req);
    const idempotencyKey = o.idempotency ? idempotencyKeyOf(req, o.idempotency === "required") : undefined;
    const stepUp: Record<string, string> = req.routeOptions.config.stepUp === true ? { "x-step-up": "ok" } : {};
    const res = await game().call(method, `${INTERNAL}${path}`, {
      actor: auth.actor,
      ...(o.body !== undefined ? { body: o.body } : {}),
      ...(o.query ? { query: o.query } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      headers: { ...o.headers, ...stepUp },
    });
    passReplayed(reply, res);
    const body = await withStaffRefs(ctx, auth, parseDomain(ctx, GAME_SERVICE, c, res.body));
    return reply.status(res.status).send(body);
  }

  const read = <T>(c: Codec<T>, path: (req: FastifyRequest) => string, q?: (req: FastifyRequest) => CallOptions["query"]) =>
    async (req: FastifyRequest, reply: FastifyReply) => proxy(req, reply, "GET", path(req), c, q ? { query: q(req) } : {});

  type P = Record<string, string>;
  type Q = Record<string, string | undefined>;
  const p = (req: FastifyRequest): P => req.params as P;
  const qs = (req: FastifyRequest): Q => req.query as Q;
  const versionOf = (req: FastifyRequest) => Number(p(req).version);
  const wallet = (req: FastifyRequest) => `/wallets/${p(req).userId!.toLowerCase()}`;

  // ---------------------------------------------------------------- обзор

  app.get(
    `${BASE}/overview`,
    { config: requirePermission("game.read"), schema: { response: out(GAME_OVERVIEW), querystring: query({ period: OVERVIEW_PERIOD }) } },
    read(GAME_OVERVIEW, () => "/overview", (req) => ({ period: qs(req).period ?? "7d" })),
  );

  // ---------------------------------------------------------------- правила

  app.get(`${BASE}/rules`, { config: requirePermission("game.read"), schema: { response: out(RULES_LIST), querystring: NO_QUERY } }, read(RULES_LIST, () => "/rules"));

  app.get(
    `${BASE}/rules/:version`,
    { config: requirePermission("game.read"), schema: { response: out(RULES_VERSION), params: VERSION_PARAMS } },
    read(RULES_VERSION, (req) => `/rules/${versionOf(req)}`),
  );

  /** Создать или заменить черновик; If-Match (updated_at черновика) — в gamification как есть (409 DRAFT_CONFLICT). */
  app.put(
    `${BASE}/rules/draft`,
    { config: requirePermission("game.manage"), schema: { response: out(RULES_VERSION), body: RULES_DRAFT } },
    async (req, reply) => proxy(req, reply, "PUT", "/rules/draft", RULES_VERSION, { body: req.body, headers: ifMatchOf(req.headers["if-match"]) }),
  );

  app.delete(`${BASE}/rules/draft`, { config: requirePermission("game.manage"), schema: { response: NO_CONTENT, body: EMPTY } }, async (req, reply) => {
    const auth = staffOf(req);
    await game().call("DELETE", `${INTERNAL}/rules/draft`, { actor: auth.actor });
    return reply.status(204).send();
  });

  app.post(
    `${BASE}/rules/draft/validate`,
    { config: requirePermission("game.manage"), schema: { response: out(RULES_VALIDATION), body: EMPTY } },
    async (req, reply) => proxy(req, reply, "POST", "/rules/draft/validate", RULES_VALIDATION, { body: {} }),
  );

  app.post(
    `${BASE}/rules/draft/activate`,
    { config: { ...requirePermission("game.publish"), ...requireStepUp() }, schema: { response: out(RULES_VERSION), body: RULES_COMMENT } },
    async (req, reply) => proxy(req, reply, "POST", "/rules/draft/activate", RULES_VERSION, { body: req.body, idempotency: "optional" }),
  );

  app.post(
    `${BASE}/rules/:version/rollback`,
    {
      config: { ...requirePermission("game.publish"), ...requireStepUp() },
      schema: { response: out(RULES_VERSION), params: VERSION_PARAMS, body: RULES_COMMENT },
    },
    async (req, reply) => proxy(req, reply, "POST", `/rules/${versionOf(req)}/rollback`, RULES_VERSION, { body: req.body, idempotency: "optional" }),
  );

  // ---------------------------------------------------------------- герои и картинки

  app.get(`${BASE}/heroes`, { config: requirePermission("game.read"), schema: { response: out(HERO_LIST), querystring: NO_QUERY } }, read(HERO_LIST, () => "/heroes"));

  app.put(
    `${BASE}/heroes/:code/draft`,
    { config: requirePermission("game.manage"), schema: { response: out(ADMIN_HERO), params: HERO_PARAMS, body: HERO_FIELDS } },
    async (req, reply) => proxy(req, reply, "PUT", `/heroes/${p(req).code}/draft`, ADMIN_HERO, { body: req.body }),
  );

  app.post(
    `${BASE}/heroes/:code/publish`,
    {
      config: { ...requirePermission("game.publish"), ...requireStepUp() },
      schema: { response: out(ADMIN_HERO), params: HERO_PARAMS, body: GAME_COMMENT },
    },
    async (req, reply) => proxy(req, reply, "POST", `/heroes/${p(req).code}/publish`, ADMIN_HERO, { body: req.body, idempotency: "optional" }),
  );

  /**
   * Загрузка картинки (game.manage): сырое тело webp/png ≤ 300 КБ, `?purpose=hero_stage|shop_item|badge` →
   * AdminGameImage (201 — новая, 200 — та же картинка по sha256, статус домена). Сигнатура, тип и размеры — до домена.
   */
  app.post<{ Querystring: { purpose: string } }>(
    ASSET_UPLOAD_ROUTE,
    {
      config: requirePermission("game.manage"),
      schema: { response: out(GAME_IMAGE), querystring: obj({ purpose: ASSET_PURPOSE }, ["purpose"]) },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const type = mediaTypeOf(req.headers["content-type"]);
      // application/json, text/plain и пустое тело сюда тоже доходят (их разбирают общие парсеры)
      if (!Buffer.isBuffer(req.body)) throw new AppError(422, "ASSET_INVALID", "Картинка не подходит: нужен WebP или PNG", { reason: "content_type" });
      inspectAsset(req.body, type);
      const idempotencyKey = idempotencyKeyOf(req, false);
      const res = await game().call("POST", `${INTERNAL}/assets`, {
        actor: auth.actor,
        query: { purpose: req.query.purpose },
        raw: { bytes: req.body, contentType: type },
        ...(idempotencyKey ? { idempotencyKey } : {}),
        timeoutMs: Math.max(ctx.config.upstreamTimeoutMs, UPLOAD_TIMEOUT_MS),
      });
      passReplayed(reply, res);
      return reply.status(res.status).send(parseDomain(ctx, GAME_SERVICE, GAME_IMAGE, res.body));
    },
  );

  /** Байты картинки для админки (game.read; черновые тоже): только webp/png ≤ 300 КБ по сигнатуре, иначе 503. */
  app.get(
    `${BASE}/assets/:assetId/content`,
    { config: requirePermission("game.read"), schema: { response: { "2xx": { type: "string" } }, params: ASSET_PARAMS } },
    async (req, reply) => {
      const auth = staffOf(req);
      const id = p(req).assetId!.toLowerCase();
      const res = await game().binary(`${INTERNAL}/assets/${id}/content`, { actor: auth.actor, maxBytes: ASSET_MAX_BYTES });
      const type = mediaTypeOf(res.body.contentType);
      if (!isAssetType(type) || readImageHeader(res.body.bytes)?.type !== type) {
        ctx.log.warn({ upstream: GAME_SERVICE, upstream_code: "UPSTREAM_BAD_RESPONSE", field: "content-type" }, "domain response rejected by normalization");
        throw upstreamUnavailable(GAME_SERVICE);
      }
      return reply.status(200).header("content-type", type).header("content-disposition", "inline").send(res.body.bytes);
    },
  );

  // ---------------------------------------------------------------- магазин

  app.get(
    `${BASE}/shop/items`,
    { config: requirePermission("game.read"), schema: { response: out(SHOP_ITEM_LIST), querystring: NO_QUERY } },
    read(SHOP_ITEM_LIST, () => "/shop/items"),
  );

  app.post(
    `${BASE}/shop/items`,
    { config: requirePermission("game.manage"), schema: { response: out(ADMIN_SHOP_ITEM), body: SHOP_ITEM_CREATE } },
    async (req, reply) => proxy(req, reply, "POST", "/shop/items", ADMIN_SHOP_ITEM, { body: req.body, idempotency: "required" }),
  );

  app.patch(
    `${BASE}/shop/items/:code`,
    { config: requirePermission("game.manage"), schema: { response: out(ADMIN_SHOP_ITEM), params: ITEM_PARAMS, body: SHOP_ITEM_PATCH } },
    async (req, reply) => proxy(req, reply, "PATCH", `/shop/items/${p(req).code}`, ADMIN_SHOP_ITEM, { body: req.body }),
  );

  for (const verb of ["publish", "retire"] as const) {
    app.post(
      `${BASE}/shop/items/:code/${verb}`,
      {
        config: { ...requirePermission("game.publish"), ...requireStepUp() },
        schema: { response: out(ADMIN_SHOP_ITEM), params: ITEM_PARAMS, body: GAME_COMMENT },
      },
      async (req, reply) => proxy(req, reply, "POST", `/shop/items/${p(req).code}/${verb}`, ADMIN_SHOP_ITEM, { body: req.body, idempotency: "optional" }),
    );
  }

  // ---------------------------------------------------------------- события недели

  app.get(
    `${BASE}/events`,
    { config: requirePermission("game.read"), schema: { response: out(GAME_EVENT_LIST), querystring: query({ status: GAME_EVENT_STATUS }) } },
    read(GAME_EVENT_LIST, () => "/events", (req) => ({ status: qs(req).status })),
  );

  app.post(
    `${BASE}/events`,
    { config: requirePermission("game.manage"), schema: { response: out(ADMIN_GAME_EVENT), body: GAME_EVENT_CREATE } },
    async (req, reply) => proxy(req, reply, "POST", "/events", ADMIN_GAME_EVENT, { body: req.body, idempotency: "required" }),
  );

  app.patch(
    `${BASE}/events/:id`,
    { config: requirePermission("game.manage"), schema: { response: out(ADMIN_GAME_EVENT), params: EVENT_PARAMS, body: GAME_EVENT_PATCH } },
    async (req, reply) => proxy(req, reply, "PATCH", `/events/${p(req).id!.toLowerCase()}`, ADMIN_GAME_EVENT, { body: req.body }),
  );

  for (const verb of ["publish", "cancel"] as const) {
    app.post(
      `${BASE}/events/:id/${verb}`,
      {
        config: { ...requirePermission("game.publish"), ...requireStepUp() },
        schema: { response: out(ADMIN_GAME_EVENT), params: EVENT_PARAMS, body: GAME_COMMENT },
      },
      async (req, reply) =>
        proxy(req, reply, "POST", `/events/${p(req).id!.toLowerCase()}/${verb}`, ADMIN_GAME_EVENT, { body: req.body, idempotency: "optional" }),
    );
  }

  // ---------------------------------------------------------------- кошельки учеников

  app.get(
    `${BASE}/wallets/:userId`,
    { config: requirePermission("game.read"), schema: { response: out(ADMIN_WALLET), params: WALLET_PARAMS, querystring: NO_QUERY } },
    read(ADMIN_WALLET, wallet),
  );

  app.get(
    `${BASE}/wallets/:userId/ledger`,
    {
      config: requirePermission("game.read"),
      schema: {
        response: out(LEDGER_PAGE),
        params: WALLET_PARAMS,
        querystring: query({ currency: GAME_CURRENCY, cursor: CURSOR_Q, limit: LIMIT_Q }),
      },
    },
    read(LEDGER_PAGE, (req) => `${wallet(req)}/ledger`, (req) => ({ currency: qs(req).currency, ...pageQuery(qs(req)) })),
  );

  app.post(
    `${BASE}/wallets/:userId/adjustments`,
    {
      config: { ...requirePermission("wallet.adjust"), ...requireStepUp() },
      schema: { response: out(LEDGER_OPERATION), params: WALLET_PARAMS, body: WALLET_ADJUSTMENT },
    },
    async (req, reply) => proxy(req, reply, "POST", `${wallet(req)}/adjustments`, LEDGER_OPERATION, { body: req.body, idempotency: "required" }),
  );

  app.post(
    `${BASE}/wallets/:userId/ledger/:opId/reverse`,
    {
      config: { ...requirePermission("wallet.adjust"), ...requireStepUp() },
      schema: { response: out(LEDGER_OPERATION), params: OP_PARAMS, body: WALLET_REASON },
    },
    async (req, reply) =>
      proxy(req, reply, "POST", `${wallet(req)}/ledger/${p(req).opId!.toLowerCase()}/reverse`, LEDGER_OPERATION, { body: req.body, idempotency: "optional" }),
  );

  app.post(
    `${BASE}/wallets/:userId/purchases/:purchaseId/refund`,
    {
      config: { ...requirePermission("wallet.adjust"), ...requireStepUp() },
      schema: { response: out(REFUND_RESULT), params: PURCHASE_PARAMS, body: WALLET_REASON },
    },
    async (req, reply) =>
      proxy(req, reply, "POST", `${wallet(req)}/purchases/${p(req).purchaseId!.toLowerCase()}/refund`, REFUND_RESULT, {
        body: req.body,
        idempotency: "optional",
      }),
  );
}
