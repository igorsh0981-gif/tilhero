/**
 * Ученики (users.read): реестр и карточка — user-admin (read-модель; Telegram ID только маской).
 * Спринт 8: фильтр списка по тарифу `?tier=free|paid` (проекция billing в user-admin); вкладка «Тариф» карточки —
 * отдельный маршрут `/admin/v1/learners/{id}/billing` (routes/billing.ts): карточка не зависит от billing.
 * Карточка = user-admin + последние 20 обращений из support по user_id — только если у сотрудника есть support.read
 * (иначе `tickets: null`, support не вызывается); support недоступен — тоже `tickets: null`, карточка открывается.
 * Раскрытие Telegram ID — identity-consent `/admin/v1/users/{id}/reveal` с actor (users.sensitive.read, step-up;
 * аудит sensitive.view identity-consent пишет синхронно: audit недоступен → 503 без значения).
 */
import type { AdminLearnerCard } from "@tilhero/contracts/admin";
import { AppError } from "@tilhero/ts-common";
import { parseDomain } from "../codec.js";
import { CARD_TICKET, LEARNER_CARD, LEARNER_CARD_DOMAIN, LEARNER_PAGE, REVEAL_RESULT, TICKET_PAGE } from "../contract.js";
import type { BffContext } from "../context.js";
import { hasPermission, staffOf, type App } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import {
  AGE_BAND,
  BOOL_Q,
  CURSOR_Q,
  LEARNER_KIND,
  LEARNER_STATUS,
  LEARNER_TIERS,
  LIMIT_Q,
  UI_LANG,
  UUID,
  enumOf,
  obj,
  pageQuery,
  params,
  query,
  str,
} from "../schemas.js";
import { DOMAIN } from "../upstream.js";
import { out, redactUsernames, shaped } from "./common.js";

interface ListQuery {
  q?: string;
  kind?: string;
  age_band?: string;
  status?: string;
  locale?: string;
  has_open_tickets?: string;
  tier?: string;
  cursor?: string;
  limit?: string;
}

export function learnerRoutes(app: App, ctx: BffContext): void {
  const { domains } = ctx;

  app.get<{ Querystring: ListQuery }>(
    "/admin/v1/learners",
    {
      config: requirePermission("users.read"),
      schema: {
        response: out(LEARNER_PAGE),
        querystring: query({
          // UUID, @username, часть имени, TCK-номер (разбор — user-admin)
          q: str(1, 120),
          kind: LEARNER_KIND,
          age_band: AGE_BAND,
          status: LEARNER_STATUS,
          locale: UI_LANG,
          has_open_tickets: BOOL_Q,
          // спринт 8 (ADM-USR-01): тариф — проекция billing.access.changed.v1 в user-admin
          tier: enumOf(LEARNER_TIERS),
          cursor: CURSOR_Q,
          limit: LIMIT_Q,
        }),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const { q, kind, age_band, status, locale, has_open_tickets, tier } = req.query;
      const body = await domains.userAdmin.get<unknown>("/admin/v1/learners", {
        actor: auth.actor,
        query: { q: q?.trim(), kind, age_band, status, locale, has_open_tickets, tier, ...pageQuery(req.query) },
      });
      return redactUsernames(auth, await shaped(ctx, auth, DOMAIN.userAdmin, LEARNER_PAGE, body));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/v1/learners/:id",
    { config: requirePermission("users.read"), schema: { response: out(LEARNER_CARD), params: params({ id: UUID }) } },
    async (req): Promise<AdminLearnerCard> => {
      const auth = staffOf(req);
      const id = req.params.id.toLowerCase();
      const tickets = hasPermission(auth, "support.read")
        ? domains.support
            .get<unknown>("/admin/v1/support/tickets", {
              actor: auth.actor,
              query: { user_id: id, limit: 20 },
              timeoutMs: ctx.config.dashboardTimeoutMs,
              retries: 0,
            })
            .then((b) => parseDomain(ctx, DOMAIN.support, TICKET_PAGE, b).items.slice(0, 20))
            .then((items) => items.map((t) => CARD_TICKET.parse(t, "$")))
            .catch((err: unknown) => {
              ctx.log.warn({ upstream: DOMAIN.support, err_code: (err as AppError)?.code }, "learner card: tickets unavailable");
              return null;
            })
        : Promise.resolve(null);
      const [cardBody, ticketItems] = await Promise.all([
        domains.userAdmin.get<unknown>(`/admin/v1/learners/${id}`, { actor: auth.actor }),
        tickets,
      ]);
      const card = parseDomain(ctx, DOMAIN.userAdmin, LEARNER_CARD_DOMAIN, cardBody);
      return redactUsernames(auth, { ...card, tickets: ticketItems });
    },
  );

  app.post<{ Params: { id: string }; Body: { field: "telegram_user_id"; reason: string } }>(
    "/admin/v1/learners/:id/reveal",
    {
      config: { ...requirePermission("users.sensitive.read"), ...requireStepUp() },
      schema: {
        response: out(REVEAL_RESULT),
        params: params({ id: UUID }),
        body: obj({ field: enumOf(["telegram_user_id"]), reason: str(5, 300) }, ["field", "reason"]),
      },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await domains.identity.post<unknown>(`/admin/v1/users/${req.params.id.toLowerCase()}/reveal`, {
        actor: auth.actor,
        body: { field: req.body.field, reason: req.body.reason.trim() },
        // аудит sensitive.view не записан — значения нет: 503 с кодом домена (не «сервис недоступен»)
        mapServerError: (e) =>
          e.code === "AUDIT_UNAVAILABLE"
            ? new AppError(503, "AUDIT_UNAVAILABLE", "Журнал аудита недоступен — раскрытие невозможно, повторите позже", { service: "audit" })
            : undefined,
      });
      return parseDomain(ctx, DOMAIN.identity, REVEAL_RESULT, body);
    },
  );
}
