/**
 * Центр уведомлений активного ученика (notifications, sub = lrn): все сообщения, в т. ч. не доставленные в Telegram
 * (выключено, лимит, тихие часы, бот заблокирован). Для детского профиля — его сообщения (адресат в Telegram — родитель).
 */
import type { InboxItem, Page } from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import { asLearner } from "../account.js";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, type App } from "../http.js";
import { InboxPageSchema, InboxReadRequestSchema, PageQuerySchema, UnreadSchema } from "../schemas.js";
import { inboxItemView } from "../views.js";

const user = { access: "user" } as const;
const TAG = ["notifications"];

const unreadView = (r: { unread: number }) => ({ unread: Number.isInteger(r?.unread) && r.unread >= 0 ? r.unread : 0 });

export function notificationsRoutes(app: App, ctx: BffContext): void {
  const n = ctx.domains.notifications;

  app.get(
    "/v1/notifications",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Центр уведомлений (новые первыми, 90 дней)",
        security: BEARER,
        querystring: PageQuerySchema,
        response: { 200: InboxPageSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const page = await n.get<Page<InboxItem>>("/internal/v1/me/inbox", {
        subject: asLearner(auth),
        query: { limit: req.query.limit ?? 20, cursor: req.query.cursor },
      });
      return { items: (Array.isArray(page.items) ? page.items : []).map(inboxItemView), next_cursor: page.next_cursor ?? null };
    },
  );

  app.get(
    "/v1/notifications/unread-count",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Число непрочитанных",
        security: BEARER,
        response: { 200: UnreadSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      return unreadView(await n.get<{ unread: number }>("/internal/v1/me/inbox/unread-count", { subject: asLearner(auth) }));
    },
  );

  app.post(
    "/v1/notifications/read",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Отметить прочитанными: ids (≤ 100) или all=true",
        description: "422 VALIDATION_ERROR, если нет ни ids, ни all. Чужие id игнорируются доменом.",
        security: BEARER,
        body: InboxReadRequestSchema,
        response: { 200: UnreadSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { ids, all } = req.body;
      if (!all && !ids?.length) {
        throw new AppError(422, "VALIDATION_ERROR", "Укажите ids или all", { in: "body", field: "ids", errors: [] });
      }
      const body = all ? { all: true } : { ids: ids!.map((i) => i.toLowerCase()) };
      return unreadView(await n.post<{ unread: number }>("/internal/v1/me/inbox:read", { subject: asLearner(auth), body }));
    },
  );
}
