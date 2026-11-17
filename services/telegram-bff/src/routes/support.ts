/**
 * Поддержка клиента (support-service, клиентский API). Чужой тикет → 404 (решает домен по sub токена).
 */
import { Type } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import type { CreateTicketRequest, Page, Ticket, TicketCategory, TicketContext, TicketSummary } from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, schemaErrors, type App } from "../http.js";
import { isHttpsUrl, type OfferSnapshot } from "../offers.js";
import {
  CreateTicketRequestSchema,
  SupportCategorySchema,
  TicketListQuerySchema,
  TicketMessageRequestSchema,
  TicketPageSchema,
  TicketParamsSchema,
  TicketSchema,
  UUID_RE,
  itemsOf,
} from "../schemas.js";

const TAG = ["support"];
const user = { access: "user" } as const;

const IdempotencyHeaders = Type.Object({
  "idempotency-key": Type.Optional(Type.String({ description: "UUID; повтор с тем же ключом возвращает тот же результат" })),
});

/** Неверный ticket_id (не UUID и не TCK-NNNN) — тот же ответ, что и для несуществующего обращения. */
const ticketNotFound = schemaErrors([
  { context: "params", status: 404, code: "SUPPORT_TICKET_NOT_FOUND", message: "Обращение не найдено" },
]);

function idempotencyKey(req: FastifyRequest, required: boolean): string | undefined {
  const raw = req.headers["idempotency-key"];
  const key = Array.isArray(raw) ? undefined : raw?.trim();
  if (key && UUID_RE.test(key)) return key.toLowerCase();
  if (!key && !required) return undefined;
  throw new AppError(422, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key (UUID)");
}

/** Сумма для поддержки — как Decimal в support: строка с ≤ 2 знаками. */
const AMOUNT_RE = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/;
/** Строка-десятичное > 0 (как isPositiveAmount в Mini App). */
export const isPositiveAmount = (v: unknown): v is string => typeof v === "string" && AMOUNT_RE.test(v) && /[1-9]/.test(v);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
/** Главный компонент снимка для ссылки в обращении: перелёт → отель → билет. */
const MAIN_ORDER = ["flight", "hotel", "ticket"] as const;

type OfferFields = Pick<TicketContext, "offer_id" | "event_id" | "provider_id" | "deeplink" | "price_snapshot">;

/**
 * Поля контекста обращения из снимка предложения (не от клиента), единое правило с Mini App (ревью спринта 5):
 * - price_snapshot = totals.total снимка (сумма пакета, которую видел пользователь; USD, в т. ч. "0.00" при неполной
 *   сумме), fetched_at = created_at снимка;
 * - provider_id и deeplink — компонента, указанного клиентом в provider_id (если он есть в снимке со status ok),
 *   иначе главного компонента (перелёт → отель → билет, первый со status ok и https-ссылкой).
 */
export function contextFromSnapshot(snap: OfferSnapshot, clientProvider: string | undefined): OfferFields {
  const out: OfferFields = { offer_id: snap.offer_id, event_id: snap.event_id };
  const totals = snap.offer.totals;
  const fetchedAt = str(snap.created_at, 40);
  // неположительная сумма (всё недоступно → "0.00") в контекст не кладётся — Mini App её тоже не показывает
  if (totals && totals.currency === "USD" && isPositiveAmount(totals.total) && fetchedAt) {
    out.price_snapshot = { amount: totals.total, currency: "USD", fetched_at: fetchedAt };
  }
  const ok = MAIN_ORDER.map((name) => snap.offer[name]).filter(
    (c): c is Record<string, unknown> => typeof c === "object" && c !== null && c.status === "ok",
  );
  const part =
    (clientProvider ? ok.find((c) => c.provider === clientProvider) : undefined) ?? ok.find((c) => isHttpsUrl(c.deeplink));
  if (part) {
    const provider = str(part.provider, 128);
    if (provider) out.provider_id = provider;
    if (isHttpsUrl(part.deeplink)) out.deeplink = part.deeplink;
  }
  return out;
}

/** Результат проверки снимка: verified=false — offer_id (и клиентские цена/ссылка) убираются. */
interface OfferCheck {
  verified: boolean;
  fields: OfferFields;
}

/** Проверка снимка для повтора с тем же Idempotency-Key: тело в support должно совпасть с первой попыткой, даже если
 *  offers за это время стал недоступен (иначе 422 IDEMPOTENCY_KEY_REUSED). TTL — как окно идемпотентности, 24 ч. */
export const OFFER_CHECK_TTL_SECONDS = 86_400;

/** Результат проверки + сохранение его в кэш повтора (вызывается после ответа support, см. маршрут). */
interface CheckedOffer {
  check: OfferCheck;
  remember(): Promise<void>;
}
const NOTHING_TO_REMEMBER = async () => undefined;

async function checkOffer(ctx: BffContext, userId: string, offerId: string, provider: string | undefined, key: string | undefined): Promise<CheckedOffer> {
  const cacheKey = key ? `${ctx.config.redisKeyPrefix}support:offerctx:${userId}:${key}:${offerId.toLowerCase()}:${provider ?? ""}` : null;
  if (cacheKey) {
    try {
      const cached = await ctx.redis.get(cacheKey);
      if (cached) return { check: JSON.parse(cached) as OfferCheck, remember: NOTHING_TO_REMEMBER };
    } catch (err) {
      // кэш — оптимизация повтора, его сбой не мешает создать обращение
      ctx.log.warn({ err_name: (err as Error)?.name }, "support offer check cache unavailable");
    }
  }
  const snap = await ctx.offers.snapshot(userId, offerId);
  const result: OfferCheck = snap ? { verified: true, fields: contextFromSnapshot(snap, provider) } : { verified: false, fields: {} };
  const remember = cacheKey
    ? async () => {
        await ctx.redis.set(cacheKey, JSON.stringify(result), "EX", OFFER_CHECK_TTL_SECONDS, "NX").catch(() => undefined);
      }
    : NOTHING_TO_REMEMBER;
  return { check: result, remember };
}

/**
 * Обращение с context.offer_id: снимок проверяется в offers (с sub — только свой). Клиентские price_snapshot и
 * deeplink при offer_id не принимаются — берутся из снимка. Чужой/несуществующий снимок, сбой или отсутствие offers →
 * offer_id убирается, обращение всё равно создаётся.
 */
async function withOfferContext(
  ctx: BffContext,
  userId: string,
  body: CreateTicketRequest,
  key: string | undefined,
): Promise<{ body: CreateTicketRequest; remember: () => Promise<void> }> {
  const c = body.context;
  if (!c || c.offer_id === undefined) return { body, remember: NOTHING_TO_REMEMBER };
  const { offer_id: offerId, price_snapshot: _p, deeplink: _d, provider_id: provider, ...rest } = c;
  const { check, remember } = await checkOffer(ctx, userId, offerId, provider, key);
  if (!check.verified) {
    ctx.log.info({ reason: "offer_not_verified" }, "support ticket: offer_id dropped");
    return { body: { ...body, context: { ...rest, ...(provider !== undefined ? { provider_id: provider } : {}) } }, remember };
  }
  return { body: { ...body, context: { ...rest, ...check.fields } }, remember };
}

export function supportRoutes(app: App, ctx: BffContext): void {
  const support = ctx.domains.support;

  app.post(
    "/v1/support/tickets",
    {
      config: user,
      schemaErrorFormatter: schemaErrors([
        { context: "body", field: "category", code: "SUPPORT_CATEGORY_INVALID", message: "Неизвестная категория обращения" },
      ]),
      schema: {
        tags: TAG,
        summary: "Создать обращение (из профиля или из контекста события)",
        description:
          "Заголовок Idempotency-Key (UUID) обязателен, иначе 422 IDEMPOTENCY_KEY_REQUIRED; пробрасывается в support. " +
          "context.offer_id проверяется в offers (только свой снимок): price_snapshot = итог пакета (totals.total, время — " +
          "created_at снимка), deeplink/provider_id — компонента из provider_id клиента или главного (перелёт → отель → билет), " +
          "event_id — из снимка; клиентские цена/ссылка не принимаются; чужой/несуществующий снимок или сбой offers — " +
          "offer_id убирается, обращение создаётся. Результат проверки кэшируется по Idempotency-Key на 24 ч (после ответа " +
          "support или его 5xx/таймаута; при 4xx — нет). Неположительный итог пакета в price_snapshot не кладётся. " +
          "422 SUPPORT_CATEGORY_INVALID.",
        security: BEARER,
        headers: IdempotencyHeaders,
        body: CreateTicketRequestSchema,
        response: { 201: TicketSchema, ...errorResponses(401, 423) },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      const key = idempotencyKey(req, true);
      // спринт 9: 10 обращений в час. Повтор того же Idempotency-Key (сеть, «Повторить») — то же обращение, лимит не
      // тратит (ревью спринта 9): ключ, на который support уже ответил, помечен в Redis на 24 ч
      const seenKey = key ? `${ctx.config.redisKeyPrefix}support:seen:${userId}:${key}` : null;
      const repeat = seenKey ? await ctx.redis.exists(seenKey).then((n) => n > 0, () => false) : false;
      if (!repeat) await ctx.limiter.enforce("tg.support_create", userId);
      const markSeen = async () => {
        if (seenKey) await ctx.redis.set(seenKey, "1", "EX", 86_400).catch(() => undefined);
      };
      const { body, remember } = await withOfferContext(ctx, userId, req.body, key);
      let ticket: Ticket;
      try {
        ticket = await support.post<Ticket>("/internal/v1/me/tickets", {
          subject: userId,
          body,
          ...(key ? { idempotencyKey: key } : {}),
        });
      } catch (err) {
        // 5xx/таймаут/сеть — исход неизвестен (support мог сохранить обращение): повтор обязан прислать то же тело.
        // 4xx — обращение точно не создано: проверку не запоминаем, повтор проверит снимок заново.
        if (!(err instanceof AppError) || err.status >= 500) {
          await remember();
          await markSeen();
        }
        throw err;
      }
      await remember();
      await markSeen();
      return reply.code(201).send(ticket);
    },
  );

  app.get(
    "/v1/support/tickets",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Мои обращения (пагинация limit/cursor)",
        security: BEARER,
        querystring: TicketListQuerySchema,
        response: { 200: TicketPageSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      return support.get<Page<TicketSummary>>("/internal/v1/me/tickets", {
        subject: userId,
        query: { limit: req.query.limit ?? 20, cursor: req.query.cursor },
      });
    },
  );

  app.get(
    "/v1/support/tickets/:ticket_id",
    {
      config: user,
      schemaErrorFormatter: ticketNotFound,
      schema: {
        tags: TAG,
        summary: "Обращение с перепиской (отмечает ответы оператора прочитанными)",
        description: "ticket_id — UUID или номер TCK-NNNN (deep link). 404 SUPPORT_TICKET_NOT_FOUND (в т. ч. чужое обращение).",
        security: BEARER,
        params: TicketParamsSchema,
        response: { 200: TicketSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      return support.get<Ticket>(`/internal/v1/me/tickets/${req.params.ticket_id}`, { subject: userId });
    },
  );

  app.post(
    "/v1/support/tickets/:ticket_id/messages",
    {
      config: user,
      schemaErrorFormatter: ticketNotFound,
      schema: {
        tags: TAG,
        summary: "Сообщение в обращение",
        description: "409 SUPPORT_TICKET_CLOSED. Необязательный Idempotency-Key (UUID) пробрасывается в support.",
        security: BEARER,
        headers: IdempotencyHeaders,
        params: TicketParamsSchema,
        body: TicketMessageRequestSchema,
        response: { 200: TicketSchema, ...errorResponses(401, 404, 409, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const key = idempotencyKey(req, false);
      return support.post<Ticket>(`/internal/v1/me/tickets/${req.params.ticket_id}/messages`, {
        subject: userId,
        body: { text: req.body.text },
        ...(key ? { idempotencyKey: key } : {}),
      });
    },
  );

  app.post(
    "/v1/support/tickets/:ticket_id/close",
    {
      config: user,
      schemaErrorFormatter: ticketNotFound,
      schema: {
        tags: TAG,
        summary: "Закрыть обращение (статус CLOSED)",
        security: BEARER,
        params: TicketParamsSchema,
        response: { 200: TicketSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      return support.post<Ticket>(`/internal/v1/me/tickets/${req.params.ticket_id}/close`, { subject: userId });
    },
  );

  app.get(
    "/v1/support/categories",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Категории обращений",
        security: BEARER,
        response: { 200: itemsOf(SupportCategorySchema), ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      return support.get<{ items: Array<{ code: TicketCategory; label: { ru: string; en: string }; available: boolean }> }>(
        "/internal/v1/support/categories",
        { subject: userId },
      );
    },
  );
}
