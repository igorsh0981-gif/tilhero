/**
 * Поддержка (support, клиентский API) — от имени аккаунта (sub): пишет и получает ответы в Telegram аккаунт.
 * Чужое обращение → 404 (решает домен по sub). В детском профиле переписка недоступна (CONVENTIONS §8: детям —
 * никаких сообщений от незнакомых; ответы оператора адресованы аккаунту) → 403 ADULT_REQUIRED.
 */
import type { Page, Ticket, TicketCategory, TicketSummary } from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import { asAccount } from "../account.js";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, forbidInChildProfile, idempotencyKey, schemaErrors, type App } from "../http.js";
import {
  CreateTicketRequestSchema,
  IdempotencyHeadersSchema,
  PageQuerySchema,
  SupportCategorySchema,
  TicketMessageRequestSchema,
  TicketPageSchema,
  TicketParamsSchema,
  TicketSchema,
  itemsOf,
} from "../schemas.js";

const TAG = ["support"];
const user = { access: "user" } as const;

/** Неверный ticket_id (не UUID и не TCK-NNNN) — тот же ответ, что и для несуществующего обращения. */
const ticketNotFound = schemaErrors([
  { context: "params", status: 404, code: "SUPPORT_TICKET_NOT_FOUND", message: "Обращение не найдено" },
]);

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
        summary: "Создать обращение (из профиля)",
        description:
          "Idempotency-Key (UUID) обязателен (422 IDEMPOTENCY_KEY_REQUIRED), пробрасывается в support: повтор — то же " +
          "обращение и лимит tg.support_create (10/ч) не тратит. 422 SUPPORT_CATEGORY_INVALID. Контекст — только " +
          "deeplink (https) и client_version. 403 ADULT_REQUIRED в детском профиле.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: CreateTicketRequestSchema,
        response: { 201: TicketSchema, ...errorResponses(401, 403, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      const accountId = asAccount(auth);
      const key = idempotencyKey(req, true)!;
      // 10 обращений в час; повтор того же Idempotency-Key (сеть, «Повторить») лимит не тратит: ключ, на который
      // support уже ответил (или исход неизвестен — 5xx/таймаут), помечен в Redis на 24 ч
      const seenKey = `${ctx.config.redisKeyPrefix}support:seen:${accountId}:${key}`;
      const repeat = await ctx.redis.exists(seenKey).then((v) => v > 0, () => false);
      if (!repeat) await ctx.limiter.enforce("tg.support_create", accountId);
      const markSeen = () => ctx.redis.set(seenKey, "1", "EX", 86_400).then(() => undefined, () => undefined);
      let ticket: Ticket;
      try {
        ticket = await support.post<Ticket>("/internal/v1/me/tickets", { subject: accountId, body: req.body, idempotencyKey: key });
      } catch (err) {
        if (!(err instanceof AppError) || err.status >= 500) await markSeen();
        throw err;
      }
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
        summary: "Мои обращения (limit/cursor)",
        security: BEARER,
        querystring: PageQuerySchema,
        response: { 200: TicketPageSchema, ...errorResponses(401, 403, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      return support.get<Page<TicketSummary>>("/internal/v1/me/tickets", {
        subject: asAccount(auth),
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
        description: "ticket_id — UUID или номер TCK-NNNN (deep link). 404 SUPPORT_TICKET_NOT_FOUND (в т. ч. чужое).",
        security: BEARER,
        params: TicketParamsSchema,
        response: { 200: TicketSchema, ...errorResponses(401, 403, 404, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      return support.get<Ticket>(`/internal/v1/me/tickets/${req.params.ticket_id}`, { subject: asAccount(auth) });
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
        headers: IdempotencyHeadersSchema,
        params: TicketParamsSchema,
        body: TicketMessageRequestSchema,
        response: { 200: TicketSchema, ...errorResponses(401, 403, 404, 409, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      const key = idempotencyKey(req, false);
      return support.post<Ticket>(`/internal/v1/me/tickets/${req.params.ticket_id}/messages`, {
        subject: asAccount(auth),
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
        response: { 200: TicketSchema, ...errorResponses(401, 403, 404, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      return support.post<Ticket>(`/internal/v1/me/tickets/${req.params.ticket_id}/close`, { subject: asAccount(auth) });
    },
  );

  app.get(
    "/v1/support/categories",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Категории обращений (RU/UZ)",
        security: BEARER,
        response: { 200: itemsOf(SupportCategorySchema), ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      return support.get<{ items: Array<{ code: TicketCategory; label: { ru: string; uz: string }; available: boolean }> }>(
        "/internal/v1/support/categories",
        { subject: asAccount(auth) },
      );
    },
  );
}
