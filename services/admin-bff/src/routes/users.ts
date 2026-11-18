/**
 * Пользователи (users.read): список и карточка — user-admin; обращения пользователя — support (если у сотрудника
 * есть support.read).
 * Спринт 7 (docs/sprint7/INTERNAL_API.md §1.11, §2.4, §2.7, §6): в карточке — уровень доступа и использование AI за 30
 * дней (ai-control), AI-переписки — только метаданные (ai-concierge, текста нет никогда; содержимое — раскрытие запроса
 * в «Запросах и стоимости» по ai.content.read). Недоступный источник → поле null, карточка открывается.
 * Уровень доступа пользователя: GET (users.read), PUT/DELETE (users.access.manage, причина, срок, expected_version;
 * аудит user.access_level.assign / reset пишет ai-control синхронно).
 * Reveal полного Telegram ID — identity-consent напрямую с actor (users.sensitive.read; аудит sensitive.view
 * пишет identity-consent синхронно, без аудита значение не выдаётся).
 */
import type { AdminUserCard, AdminUserRow, Page, RevealResult, StaffTicketSummary, UserAccessLevelInput } from "@tilhero/contracts/admin";
import type { AppError } from "@tilhero/ts-common";
import type { BffContext } from "../context.js";
import { hasPermission, idempotencyKeyOf, staffOf, validationError, type App, type StaffAuth } from "../http.js";
import { requirePermission } from "../rbac.js";
import { BOOL_Q, CURSOR_Q, LIMIT_Q, UUID, enumOf, obj, pageQuery, params, query, str } from "../schemas.js";
import { ok, REVEAL_RESULT, USER_CARD, USER_PAGE, type Schema } from "../responses.js";
import { C } from "../codec.js";
import { AI_CONVERSATION, AI_CONVERSATION_PAGE, AI_USER_USAGE, USER_ACCESS_LEVEL } from "./aiCodecs.js";
import { REASON_IN, command, reasonOf, respond } from "./aiCommon.js";

/** Карточка со строгими схемами полей спринта 7 (в responses.ts — заглушки, см. комментарий USER_CARD). */
const CARD_PROPS = (USER_CARD as { properties: Record<string, Schema> }).properties;
const USER_CARD_7: Schema = {
  ...USER_CARD,
  properties: {
    ...CARD_PROPS,
    ai_conversations: C.nullable(C.arr(AI_CONVERSATION)).schema,
    access_level: C.nullable(USER_ACCESS_LEVEL).schema,
    ai_usage_30d: C.nullable(AI_USER_USAGE).schema,
  },
};
const LEVEL_Q = str(2, 330, { pattern: "^[a-z][a-z0-9_]{1,31}(,[a-z][a-z0-9_]{1,31}){0,9}$" });

const USER_STATUS = enumOf(["ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED"]);

interface ListQuery {
  q?: string;
  status?: string;
  locale?: string;
  has_open_tickets?: string;
  access_level?: string;
  access_level_source?: string;
  cursor?: string;
  limit?: string;
}

/** Необязательный источник карточки: сбой → null (карточка открывается), в лог — сервис и код. */
async function optional<T>(ctx: BffContext, service: string, p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    ctx.log.warn({ upstream: service, err_code: (e as AppError)?.code }, "user card: optional source unavailable");
    return null;
  }
}

export function userRoutes(app: App, ctx: BffContext): void {
  const { domains } = ctx;

  app.get<{ Querystring: ListQuery }>(
    "/admin/v1/users",
    {
      config: requirePermission("users.read"),
      schema: {
        response: ok(USER_PAGE),
        querystring: query({
          q: str(1, 120),
          status: USER_STATUS,
          locale: str(2, 16, { pattern: "^[A-Za-z_-]+$" }),
          has_open_tickets: BOOL_Q,
          access_level: LEVEL_Q,
          access_level_source: enumOf(["default", "manual"]),
          cursor: CURSOR_Q,
          limit: LIMIT_Q,
        }),
      },
    },
    async (req): Promise<Page<AdminUserRow>> => {
      const auth = staffOf(req);
      const { q, status, locale, has_open_tickets, access_level, access_level_source } = req.query;
      return domains.userAdmin.get<Page<AdminUserRow>>("/admin/v1/users", {
        actor: auth.actor,
        query: { q, status, locale, has_open_tickets, access_level, access_level_source, ...pageQuery(req.query) },
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/v1/users/:id",
    { config: requirePermission("users.read"), schema: { response: ok(USER_CARD_7), params: params({ id: UUID }) } },
    async (req): Promise<AdminUserCard> => {
      const auth = staffOf(req);
      const id = req.params.id.toLowerCase();
      const control = domains.aiControl;
      const [card, tickets, access, usage, conversations] = await Promise.all([
        domains.userAdmin.get<AdminUserCard>(`/admin/v1/users/${id}`, { actor: auth.actor }),
        hasPermission(auth, "support.read")
          ? domains.support.get<Page<StaffTicketSummary>>("/admin/v1/support/tickets", {
              actor: auth.actor,
              query: { user_id: id, status: "all", limit: 20 },
            })
          : Promise.resolve<Page<StaffTicketSummary>>({ items: [], next_cursor: null }),
        optional(ctx, "ai-control", control.get<unknown>(`/internal/v1/access/users/${id}`, { actor: auth.actor }).then((b) => respond(ctx, auth, "ai-control", USER_ACCESS_LEVEL, b))),
        optional(ctx, "ai-control", control.get<unknown>(`/internal/v1/usage/users/${id}/summary`, { actor: auth.actor, query: { period: "30d" } }).then((b) => respond(ctx, auth, "ai-control", AI_USER_USAGE, b))),
        optional(
          ctx,
          "ai-concierge",
          domains.aiConcierge
            .get<unknown>("/internal/v1/admin/conversations", { actor: auth.actor, query: { user_id: id, limit: 20 } })
            .then((b) => respond(ctx, auth, "ai-concierge", AI_CONVERSATION_PAGE, b).then((p) => p.items)),
        ),
      ]);
      const full: AdminUserCard = {
        ...card,
        tickets: (tickets.items ?? []).map((t) => ({
          ticket_id: t.ticket_id,
          number: t.number,
          status: t.status,
          subject: t.subject,
          created_at: t.created_at,
        })),
        // спринт 7: только метаданные из ai-concierge; то, что прислал user-admin, не используется
        ai_conversations: conversations,
        access_level: access,
        ai_usage_30d: usage,
      };
      return full;
    },
  );

  // ------------------------------------------------------------ уровень доступа к AI (ai-control §2.7)

  const accessPath = (id: string) => `/internal/v1/access/users/${id.toLowerCase()}`;
  const ACCESS_RESPONSE = ok(USER_ACCESS_LEVEL.schema);
  const accessOut = (auth: StaffAuth, body: unknown) => respond(ctx, auth, "ai-control", USER_ACCESS_LEVEL, body);

  app.get<{ Params: { id: string } }>(
    "/admin/v1/users/:id/access-level",
    { config: requirePermission("users.read"), schema: { response: ACCESS_RESPONSE, params: params({ id: UUID }) } },
    async (req) => {
      const auth = staffOf(req);
      return accessOut(auth, await domains.aiControl.get<unknown>(accessPath(req.params.id), { actor: auth.actor }));
    },
  );

  app.put<{ Params: { id: string }; Body: UserAccessLevelInput }>(
    "/admin/v1/users/:id/access-level",
    {
      config: requirePermission("users.access.manage"),
      schema: {
        response: ACCESS_RESPONSE,
        params: params({ id: UUID }),
        body: obj(
          {
            level: str(2, 32, { pattern: "^[a-z][a-z0-9_]{1,31}$" }),
            reason: REASON_IN,
            expires_at: { anyOf: [str(20, 40, { pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,6})?)?(Z|[+-]\\d{2}:\\d{2})$" }), { type: "null" }] },
            expected_version: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
          },
          ["level", "reason"],
        ),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const reason = reasonOf(req.body.reason);
      const exp = req.body.expires_at;
      if (exp && !(Date.parse(exp) > ctx.now())) throw validationError("expires_at", "Срок — в будущем");
      const res = await domains.aiControl.call<unknown>("PUT", accessPath(req.params.id), {
        actor: auth.actor,
        body: { ...req.body, reason },
        ...command(idempotencyKeyOf(req, true)),
      });
      return accessOut(auth, res.body);
    },
  );

  // причина — в теле (ревью 7): URL с причиной попадает в журналы доступа прокси и браузера
  app.delete<{ Params: { id: string }; Body: { reason: string; expected_version?: number } }>(
    "/admin/v1/users/:id/access-level",
    {
      config: requirePermission("users.access.manage"),
      schema: {
        response: ACCESS_RESPONSE,
        params: params({ id: UUID }),
        body: obj({ reason: REASON_IN, expected_version: { type: "integer", minimum: 0, maximum: 2_147_483_647 } }, ["reason"]),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      // ai-control (INTERNAL_API §2.7, ревью 7): причина и expected_version — в теле DELETE, как у admin-bff
      const v = req.body.expected_version;
      const res = await domains.aiControl.call<unknown>("DELETE", accessPath(req.params.id), {
        actor: auth.actor,
        body: v === undefined ? { reason: reasonOf(req.body.reason) } : { reason: reasonOf(req.body.reason), expected_version: v },
        ...command(idempotencyKeyOf(req, true)),
      });
      return accessOut(auth, res.body);
    },
  );

  app.post<{ Params: { id: string }; Body: { field: "telegram_user_id"; reason: string } }>(
    "/admin/v1/users/:id/reveal",
    {
      config: requirePermission("users.sensitive.read"),
      schema: {
        response: ok(REVEAL_RESULT),
        params: params({ id: UUID }),
        body: obj({ field: enumOf(["telegram_user_id"]), reason: str(5, 500) }, ["field", "reason"]),
      },
    },
    async (req): Promise<RevealResult> => {
      const auth = staffOf(req);
      return domains.identity.post<RevealResult>(`/admin/v1/users/${req.params.id.toLowerCase()}/reveal`, {
        actor: auth.actor,
        body: req.body,
      });
    },
  );
}
