/**
 * Спринт 6 — игра и герои (bff.ts «Спринт 6», INTERNAL_API спринта 6 §0, §1.7–§1.9, §1.12, §9, §12): тонкий прокси на
 * gamification (GAMIFICATION_URL; нет адреса — все маршруты 503 GAME_UNAVAILABLE, учёба работает).
 *
 * Вызов от имени активного ученика — как memory: sub = аккаунт, claims `lrn` (кошелёк, герой, задания и значки — у `lrn`)
 * и `age_band` полосы активного ученика (аудиторию gamification выводит сама). user_id в запросах нет — только токен.
 *
 * Ошибки: 4xx gamification — клиенту как есть (код, статус, details): 404 HERO_NOT_FOUND | ITEM_NOT_FOUND; 409
 * HERO_NOT_AVAILABLE | INSUFFICIENT_TILS {price, balance, missing, purchase_available: false} | ALREADY_OWNED |
 * FREEZE_STOCK_FULL {max} | NOT_OWNED; 410 ITEM_NOT_AVAILABLE; 422 IDEMPOTENCY_KEY_REUSED. Недоступность, таймаут, 5xx,
 * отказ внутренней авторизации и ответ не по контракту → 503 GAME_UNAVAILABLE {service: gamification} (Mini App скрывает
 * игровой блок). Деньги: `purchase_available` всегда false (тилы за деньги — спринт 8), и в GameSummary, и в
 * INSUFFICIENT_TILS.
 *
 * Картинки: домен отдаёт {asset_id, sha256, width, height} — url собирает BFF: /v1/game/assets/{asset_id}/{sha256}
 * (путь от адреса BFF). Готовый url домена без sha256 принимается, только если это тот же путь для того же asset_id;
 * иначе — ответ не по контракту (503). GET /v1/game/assets/{asset_id}/{sha256} — без авторизации (публичное содержимое),
 * лимит tg.game.assets по IP; байты из gamification, ETag домена = sha пути (иначе 404), sha256 байтов = ETag и
 * сигнатура webp/png (иначе 503); Cache-Control: public, max-age=31536000, immutable — как у домена (§1.12).
 *
 * Лимиты на ученика: tg.game.read (GET, 120/мин), tg.game.write (герой, экипировка, настройки — 30/мин),
 * tg.game.purchase (покупка — 10/мин).
 */
import { createHash } from "node:crypto";
import { Type, type Static, type TSchema } from "@fastify/type-provider-typebox";
import type * as C from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import { asAccount } from "../account.js";
import { expectShape } from "../check.js";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, idempotencyKey, schemaErrors, type App } from "../http.js";
import {
  DailyQuestsSchema,
  EquipmentRequestSchema,
  GameAssetHeadersSchema,
  GameAssetParamsSchema,
  GameDomain,
  GameHistoryPageSchema,
  GameHistoryQuerySchema,
  GameImageBytesSchema,
  GameOperationSchema,
  GameRewardsQuerySchema,
  GameSettingsPatchSchema,
  GameSettingsSchema,
  GameView,
  IdempotencyHeadersSchema,
  PurchaseRequestSchema,
  PurchaseResultSchema,
  SelectHeroRequestSchema,
  type GameImageDomainSchema,
} from "../schemas.js";
import type { AccessClaims } from "../tokens.js";
import { GAME_SERVICE, type RawMethod, type RawRequest } from "../upstream.js";
import { etagMatches, pageView } from "./content.js";

const user = { access: "user" } as const;
const TAG = ["game"];
const READ = "tg.game.read";
const WRITE = "tg.game.write";
const PURCHASE = "tg.game.purchase";

/** Заголовок кеша картинки — как у gamification (§1.12): путь содержит sha256, содержимое неизменяемо. */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** Картинка ≤ 300 КБ (§1.1); BFF читает не больше 1 МБ — защита памяти, а не политика размера. */
export const GAME_IMAGE_MAX_BYTES = 1024 * 1024;
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/webp", "image/png"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const ASSET_URL_RE = /^\/v1\/game\/assets\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/([0-9a-fA-F]{64})$/;

export const gameUnavailable = () =>
  new AppError(503, "GAME_UNAVAILABLE", "Игра временно недоступна, учёба работает", { service: GAME_SERVICE });
export const assetNotFound = () => new AppError(404, "ASSET_NOT_FOUND", "Картинка не найдена");

/** Сбой gamification (RawClient / expectShape → 503 UPSTREAM_UNAVAILABLE {service: gamification}) → GAME_UNAVAILABLE. */
export function asGameError(err: unknown): unknown {
  if (err instanceof AppError && err.status === 503 && err.code === "UPSTREAM_UNAVAILABLE" && err.details.service === GAME_SERVICE) {
    return gameUnavailable();
  }
  return err;
}

/** Публичный путь картинки (от адреса BFF). */
export const assetPath = (assetId: string, sha256: string): string => `/v1/game/assets/${encodeURIComponent(assetId)}/${sha256.toLowerCase()}`;

/** ETag домена → sha256 (hex, нижний регистр): `"<sha>"`, `W/"<sha>"` или `<sha>`; иначе null. */
function etagSha(v: string | null): string | null {
  const t = (v ?? "").trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1").toLowerCase();
  return SHA256_RE.test(t) ? t : null;
}

function signatureOk(type: string, b: Buffer): boolean {
  if (type === "image/png") return b.length > 8 && b.subarray(0, 8).equals(PNG_SIGNATURE);
  return b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP";
}

/** Байты картинки из ответа gamification: тип из списка, не больше GAME_IMAGE_MAX_BYTES, сигнатура по типу. */
async function readImage(resp: Response): Promise<{ contentType: string; bytes: Buffer }> {
  const contentType = (resp.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!IMAGE_TYPES.has(contentType)) throw new Error("unexpected content type");
  const declared = Number(resp.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > GAME_IMAGE_MAX_BYTES) throw new Error("image too large");
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > GAME_IMAGE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("image too large");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  if (!signatureOk(contentType, bytes)) throw new Error("signature mismatch");
  return { contentType, bytes };
}

type DomainImage = Static<typeof GameImageDomainSchema>;
type D<K extends keyof typeof GameDomain> = Static<(typeof GameDomain)[K]>;

export function gameRoutes(app: App, ctx: BffContext): void {
  const log = ctx.log;

  // ---------------------------------------------------------------- вызов и проверка ответа
  /** Вызов gamification от имени активного ученика: лимит политики, claims lrn/age_band; сбой → GAME_UNAVAILABLE. */
  async function call(auth: AccessClaims, policy: string, method: RawMethod, path: string, extra: Pick<RawRequest, "query" | "body" | "idempotencyKey"> = {}): Promise<unknown> {
    const game = ctx.game;
    if (!game) throw gameUnavailable();
    await ctx.limiter.enforce(policy, auth.learnerId);
    const band = await ctx.audience.learnerBand(ctx, auth);
    try {
      return await game.json(method, path, { subject: asAccount(auth), claims: { lrn: auth.learnerId, ...(band ? { age_band: band } : {}) }, ...extra });
    } catch (err) {
      throw asGameError(err);
    }
  }

  /** Ответ gamification по схеме контракта; не по схеме → 503 GAME_UNAVAILABLE (в лог — проверка, путь, правило). */
  function shape<S extends TSchema>(what: string, schema: S, raw: unknown): Static<S> {
    try {
      return expectShape(log, GAME_SERVICE, what, schema, raw);
    } catch (err) {
      throw asGameError(err);
    }
  }

  // ---------------------------------------------------------------- картинки в ответах
  function img(what: string, i: DomainImage): C.GameImage {
    if (i.sha256) return { asset_id: i.asset_id, url: assetPath(i.asset_id, i.sha256), width: i.width, height: i.height };
    const m = i.url !== undefined ? ASSET_URL_RE.exec(i.url) : null;
    if (m && m[1] === i.asset_id) return { asset_id: i.asset_id, url: assetPath(i.asset_id, m[2]!), width: i.width, height: i.height };
    log.warn({ upstream: GAME_SERVICE, check: what, rule: "image_url", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "domain response does not match the contract");
    throw gameUnavailable();
  }
  const imgOrNull = (what: string, i: DomainImage | null): C.GameImage | null => (i ? img(what, i) : null);
  const refView = (what: string, r: D<"ShopItemRef"> | null): C.ShopItemRef | null => (r ? { ...r, image: imgOrNull(what, r.image) } : null);
  const badgeView = (what: string, b: D<"BadgeView">): C.BadgeView => ({ ...b, image: imgOrNull(what, b.image) });
  const summaryView = (s: D<"Summary">): C.GameSummary => ({
    ...s,
    hero: s.hero ? { ...s.hero, image: img("summary.hero.image", s.hero.image) } : null,
    equipment: {
      background: refView("summary.equipment.background.image", s.equipment.background),
      frame: refView("summary.equipment.frame.image", s.equipment.frame),
    },
    purchase_available: false,
  });
  const summaryOf = (raw: unknown) => summaryView(shape("summary", GameDomain.Summary, raw));

  // ---------------------------------------------------------------- чтение (tg.game.read)
  app.get(
    "/v1/game/summary",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Игровая сводка (главная, профиль): уровень, XP, тилы, заморозки, герой, задания дня, события, экипировка, настройки",
        description:
          "Задания дня выпускаются при первом запросе дня. hero = null — герой не выбран (показать выбор). purchase_available " +
          "всегда false (тилы за деньги — спринт 8). 503 GAME_UNAVAILABLE — игровой блок скрыть, учёба работает.",
        security: BEARER,
        response: { 200: GameView.Summary, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => summaryOf(await call(authOf(req), READ, "GET", "/internal/v1/game/summary")),
  );

  app.get(
    "/v1/game/heroes",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Герои для выбора (детям первыми — дракончики), выбранный и общая ступень",
        security: BEARER,
        response: { 200: GameView.Heroes, ...errorResponses(401, 410, 423) },
      },
    },
    async (req): Promise<{ items: C.HeroView[]; selected: string | null; stage: C.HeroStage }> => {
      const h = shape("heroes", GameDomain.Heroes, await call(authOf(req), READ, "GET", "/internal/v1/game/heroes"));
      return { ...h, items: h.items.map((x) => ({ ...x, stages: x.stages.map((st) => ({ ...st, image: img("heroes.items.stages.image", st.image) })) })) };
    },
  );

  app.get(
    "/v1/game/quests",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Задания дня (3 + бонус за все); скрыты в настройках — items пусто",
        security: BEARER,
        response: { 200: DailyQuestsSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => shape("quests", DailyQuestsSchema, await call(authOf(req), READ, "GET", "/internal/v1/game/quests")),
  );

  app.get(
    "/v1/game/badges",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Значки: выданные первыми; у невыданных — условие и прогресс (basis)",
        security: BEARER,
        response: { 200: GameView.Badges, ...errorResponses(401, 410, 423) },
      },
    },
    async (req): Promise<{ items: C.BadgeView[] }> => {
      const b = shape("badges", GameDomain.Badges, await call(authOf(req), READ, "GET", "/internal/v1/game/badges"));
      return { items: b.items.map((x) => badgeView("badges.items.image", x)) };
    },
  );

  app.get(
    "/v1/game/shop",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Магазин за тилы: фоны, рамки героя, заморозка серии; owned / can_buy / reason_unavailable",
        description: "Покупка тилов за деньги — спринт 8: при нехватке тилов — «Покупка тилов скоро», экранов оплаты нет.",
        security: BEARER,
        response: { 200: GameView.Shop, ...errorResponses(401, 410, 423) },
      },
    },
    async (req): Promise<{ items: C.ShopItemView[]; til_balance: number; freeze_stock: number; freeze_max: number }> => {
      const s = shape("shop", GameDomain.Shop, await call(authOf(req), READ, "GET", "/internal/v1/game/shop"));
      return { ...s, items: s.items.map((i) => ({ ...i, image: imgOrNull("shop.items.image", i.image) })) };
    },
  );

  app.get(
    "/v1/game/history",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "История операций (XP, тилы, заморозки): новые сверху, по 30",
        description: "?currency=xp|til|freeze, ?cursor=. Ручные операции поддержки — reason manual, без комментария сотрудника.",
        security: BEARER,
        querystring: GameHistoryQuerySchema,
        response: { 200: GameHistoryPageSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const raw = await call(authOf(req), READ, "GET", "/internal/v1/game/history", { query: { currency: req.query.currency, cursor: req.query.cursor } });
      try {
        return pageView(ctx, GAME_SERVICE, "history", GameOperationSchema, raw);
      } catch (err) {
        throw asGameError(err);
      }
    },
  );

  app.get(
    "/v1/game/rewards",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Награды занятия (урока или повторения): операции, новый уровень, рост героя, значки, задания",
        description:
          "?source_session_id=<uuid>. Начисляются по событиям асинхронно: pending — опрашивать каждые 1.5 с, до 8 раз; none — " +
          "наград не было (и для чужой сессии).",
        security: BEARER,
        querystring: GameRewardsQuerySchema,
        response: { 200: GameView.Rewards, ...errorResponses(401, 410, 423) },
      },
    },
    async (req): Promise<C.SessionRewards> => {
      const raw = await call(authOf(req), READ, "GET", "/internal/v1/game/rewards", { query: { source_session_id: req.query.source_session_id.toLowerCase() } });
      const r = shape("rewards", GameDomain.Rewards, raw);
      return { ...r, badges: r.badges.map((b) => badgeView("rewards.badges.image", b)) };
    },
  );

  app.get(
    "/v1/game/settings",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Игровые настройки: автозаморозка, скрыть задания, празднования (детям — quiet), уведомления игры",
        security: BEARER,
        response: { 200: GameSettingsSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => shape("settings", GameSettingsSchema, await call(authOf(req), READ, "GET", "/internal/v1/game/settings")),
  );

  // ---------------------------------------------------------------- команды (tg.game.write)
  app.put(
    "/v1/game/hero",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Выбрать героя → GameSummary (смена бесплатна, XP, уровень и ступень сохраняются)",
        description: "404 HERO_NOT_FOUND; 409 HERO_NOT_AVAILABLE — герой не опубликован или не для аудитории ученика.",
        security: BEARER,
        body: SelectHeroRequestSchema,
        response: { 200: GameView.Summary, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => summaryOf(await call(authOf(req), WRITE, "PUT", "/internal/v1/game/hero", { body: { hero_code: req.body.hero_code } })),
  );

  app.put(
    "/v1/game/equipment",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Экипировка: фон и рамка героя из купленных (null — снять) → GameSummary",
        description: "409 NOT_OWNED — предмет не куплен или другого вида.",
        security: BEARER,
        body: EquipmentRequestSchema,
        response: { 200: GameView.Summary, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) =>
      summaryOf(
        await call(authOf(req), WRITE, "PUT", "/internal/v1/game/equipment", {
          body: { background_code: req.body.background_code, frame_code: req.body.frame_code },
        }),
      ),
  );

  app.patch(
    "/v1/game/settings",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Изменить игровые настройки (только переданные поля) → GameSettings",
        security: BEARER,
        body: GameSettingsPatchSchema,
        response: { 200: GameSettingsSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const b = req.body;
      const body: Partial<C.GameSettings> = {
        ...(b.auto_freeze !== undefined ? { auto_freeze: b.auto_freeze } : {}),
        ...(b.quests_hidden !== undefined ? { quests_hidden: b.quests_hidden } : {}),
        ...(b.celebrations !== undefined ? { celebrations: b.celebrations } : {}),
        ...(b.game_notifications !== undefined ? { game_notifications: b.game_notifications } : {}),
      };
      return shape("settings", GameSettingsSchema, await call(authOf(req), WRITE, "PATCH", "/internal/v1/game/settings", { body }));
    },
  );

  // ---------------------------------------------------------------- покупка (tg.game.purchase)
  app.post(
    "/v1/game/shop/purchases",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Купить предмет за тилы (косметика или заморозка серии) → PurchaseResult",
        description:
          "Idempotency-Key (UUID) обязателен (422 IDEMPOTENCY_KEY_REQUIRED): повтор ключа — тот же ответ, без второго списания; " +
          "тот же ключ с другим телом — 422 IDEMPOTENCY_KEY_REUSED. 404 ITEM_NOT_FOUND; 409 INSUFFICIENT_TILS {price, balance, " +
          "missing, purchase_available: false} | ALREADY_OWNED | FREEZE_STOCK_FULL {max}; 410 ITEM_NOT_AVAILABLE. " +
          "429 RATE_LIMITED (tg.game.purchase, 10 в минуту на ученика).",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: PurchaseRequestSchema,
        response: { 200: PurchaseResultSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const key = idempotencyKey(req, true)!;
      let raw: unknown;
      try {
        raw = await call(authOf(req), PURCHASE, "POST", "/internal/v1/game/purchases", { body: { item_code: req.body.item_code }, idempotencyKey: key });
      } catch (err) {
        // тилы за деньги в спринте 6 не продаются — признак не зависит от домена
        if (err instanceof AppError && err.code === "INSUFFICIENT_TILS") {
          throw new AppError(err.status, err.code, err.message, { ...err.details, purchase_available: false });
        }
        throw err;
      }
      return shape("purchase", PurchaseResultSchema, raw);
    },
  );

  // ---------------------------------------------------------------- картинки (публично, tg.game.assets по IP)
  app.get(
    "/v1/game/assets/:asset_id/:sha256",
    {
      config: { access: "public", ipLimit: "game_assets" },
      // неверный формат пути — та же «нет такой картинки», без вызова домена
      schemaErrorFormatter: schemaErrors([{ context: "params", status: 404, code: "ASSET_NOT_FOUND", message: "Картинка не найдена" }]),
      schema: {
        tags: TAG,
        summary: "Картинка героя, предмета или значка (публично, неизменяемая: путь содержит sha256)",
        description:
          "image/webp | image/png; ETag \"<sha256>\", Cache-Control: public, max-age=31536000, immutable; If-None-Match → 304. " +
          "404 ASSET_NOT_FOUND — нет, не опубликована или sha256 не совпадает. 429 RATE_LIMITED (tg.game.assets, 600 в минуту с IP).",
        params: GameAssetParamsSchema,
        headers: GameAssetHeadersSchema,
        response: { 200: GameImageBytesSchema, 304: Type.Null({ description: "Не изменилась" }), ...errorResponses(404) },
      },
    },
    async (req, reply) => {
      const game = ctx.game;
      if (!game) throw gameUnavailable();
      const sha = req.params.sha256.toLowerCase();
      const resp = await game.get(`/internal/v1/game/assets/${encodeURIComponent(req.params.asset_id)}`).catch((err: unknown) => {
        // 4xx домена (нет, не используется в опубликованном, неверный id) — для публичного пути «нет такой картинки»
        if (err instanceof AppError && err.status < 500 && err.status !== 429) throw assetNotFound();
        throw asGameError(err);
      });
      const reject = async (reason: string): Promise<never> => {
        await resp.body?.cancel().catch(() => undefined);
        log.warn({ upstream: GAME_SERVICE, check: "game_asset", upstream_status: resp.status, reason, upstream_code: "UPSTREAM_BAD_RESPONSE" }, "game asset rejected");
        throw gameUnavailable();
      };
      if (resp.status !== 200) return reject("unexpected status");
      const etag = etagSha(resp.headers.get("etag"));
      if (!etag) return reject("no etag");
      if (etag !== sha) {
        // устаревший или подобранный путь: картинка есть, но не эта
        await resp.body?.cancel().catch(() => undefined);
        throw assetNotFound();
      }
      let image: { contentType: string; bytes: Buffer };
      try {
        image = await readImage(resp);
      } catch (err) {
        return reject((err as Error).message);
      }
      if (createHash("sha256").update(image.bytes).digest("hex") !== sha) return reject("sha256 mismatch");
      const tag = `"${sha}"`;
      void reply.header("etag", tag).header("cache-control", ASSET_CACHE_CONTROL);
      if (etagMatches(req.headers["if-none-match"], tag)) return reply.code(304).send(null);
      return reply.header("content-type", image.contentType).header("content-length", String(image.bytes.length)).send(image.bytes);
    },
  );
}
