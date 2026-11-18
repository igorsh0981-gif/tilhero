/**
 * Шаблоны уведомлений и рассылки (notifications), пути — как admin.ts (совпадают с путями домена).
 *
 * Шаблоны (notif.templates.manage): список, карточка с версиями, новая версия (Idempotency-Key), предпросмотр,
 * тестовая отправка; активация версии и сброс к тексту по умолчанию — ещё и step-up.
 * Тестовые получатели — только индексы и маски (полные chat id в админку не отдаются).
 * Рассылки: notif.campaigns.manage — черновик (Idempotency-Key обязателен), правка, оценка охвата, предпросмотр,
 * тест; notif.campaigns.send — расписание (step-up), снятие с расписания, экстренная остановка (step-up).
 * Ошибки домена (TEMPLATE_INVALID {fields}, CAMPAIGN_NOT_DRAFT, CAMPAIGN_EMPTY_AUDIENCE, 429 тестов …) — как есть.
 */
import {
  CAMPAIGN,
  CAMPAIGN_ESTIMATE,
  CAMPAIGN_PAGE,
  TEMPLATE_DETAIL,
  TEMPLATE_INFO,
  TEMPLATE_LIST,
  TEMPLATE_PREVIEW,
  TEMPLATE_VERSION,
  TEST_RECIPIENTS,
  TEST_SEND_RESULT,
} from "../contract.js";
import type { BffContext } from "../context.js";
import { idempotencyKeyOf, staffOf, type App } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import {
  CAMPAIGN_CREATE,
  CAMPAIGN_PATCH,
  CAMPAIGN_SCHEDULE,
  CAMPAIGN_STATUS,
  CURSOR_Q,
  LIMIT_Q,
  PREVIEW_REQUEST,
  REASON,
  TEMPLATE_KEY,
  TEMPLATE_VERSION_CREATE,
  TEST_SEND_REQUEST,
  UUID,
  VERSION_NO,
  obj,
  pageQuery,
  params,
  query,
} from "../schemas.js";
import { DOMAIN } from "../upstream.js";
import { out, relay, shaped } from "./common.js";

const SERVICE = DOMAIN.notifications;
const TEMPLATES = "/admin/v1/notifications/templates";
const CAMPAIGNS = "/admin/v1/notifications/campaigns";
const KEY_PARAMS = params({ key: TEMPLATE_KEY });
const VERSION_PARAMS = params({ key: TEMPLATE_KEY, v: VERSION_NO });
const CAMPAIGN_PARAMS = params({ id: UUID });
const REASON_BODY = obj({ reason: REASON }, ["reason"]);

export function notificationRoutes(app: App, ctx: BffContext): void {
  const notif = ctx.domains.notifications;
  const tpl = (key: string) => `${TEMPLATES}/${encodeURIComponent(key)}`;
  const ver = (key: string, v: string) => `${tpl(key)}/versions/${Number(v)}`;
  const camp = (id: string) => `${CAMPAIGNS}/${id.toLowerCase()}`;

  // ---------------------------------------------------------------- шаблоны

  app.get("/admin/v1/notifications/templates", { config: requirePermission("notif.templates.manage"), schema: { response: out(TEMPLATE_LIST) } }, async (req) => {
    const auth = staffOf(req);
    return shaped(ctx, auth, SERVICE, TEMPLATE_LIST, await notif.get<unknown>(TEMPLATES, { actor: auth.actor }));
  });

  app.get<{ Params: { key: string } }>(
    `${TEMPLATES}/:key`,
    { config: requirePermission("notif.templates.manage"), schema: { response: out(TEMPLATE_DETAIL), params: KEY_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, TEMPLATE_DETAIL, await notif.get<unknown>(tpl(req.params.key), { actor: auth.actor }), { names: true });
    },
  );

  app.post<{ Params: { key: string }; Body: Record<string, unknown> }>(
    `${TEMPLATES}/:key/versions`,
    { config: requirePermission("notif.templates.manage"), schema: { response: out(TEMPLATE_VERSION), params: KEY_PARAMS, body: TEMPLATE_VERSION_CREATE } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await notif.call("POST", `${tpl(req.params.key)}/versions`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relay(ctx, auth, reply, SERVICE, TEMPLATE_VERSION, res, { names: true });
    },
  );

  app.post<{ Params: { key: string; v: string }; Body: Record<string, unknown> }>(
    `${TEMPLATES}/:key/versions/:v/preview`,
    { config: requirePermission("notif.templates.manage"), schema: { response: out(TEMPLATE_PREVIEW), params: VERSION_PARAMS, body: PREVIEW_REQUEST } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await notif.call("POST", `${ver(req.params.key, req.params.v)}/preview`, { actor: auth.actor, body: req.body });
      return relay(ctx, auth, reply, SERVICE, TEMPLATE_PREVIEW, res);
    },
  );

  app.post<{ Params: { key: string; v: string }; Body: { reason: string } }>(
    `${TEMPLATES}/:key/versions/:v/activate`,
    {
      config: { ...requirePermission("notif.templates.manage"), ...requireStepUp() },
      schema: { response: out(TEMPLATE_VERSION), params: VERSION_PARAMS, body: REASON_BODY },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await notif.call("POST", `${ver(req.params.key, req.params.v)}/activate`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relay(ctx, auth, reply, SERVICE, TEMPLATE_VERSION, res, { names: true });
    },
  );

  app.post<{ Params: { key: string }; Body: { reason: string } }>(
    `${TEMPLATES}/:key/reset`,
    {
      config: { ...requirePermission("notif.templates.manage"), ...requireStepUp() },
      schema: { response: out(TEMPLATE_INFO), params: KEY_PARAMS, body: REASON_BODY },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await notif.call("POST", `${tpl(req.params.key)}/reset`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relay(ctx, auth, reply, SERVICE, TEMPLATE_INFO, res);
    },
  );

  app.post<{ Params: { key: string; v: string }; Body: Record<string, unknown> }>(
    `${TEMPLATES}/:key/versions/:v/test`,
    { config: requirePermission("notif.templates.manage"), schema: { response: out(TEST_SEND_RESULT), params: VERSION_PARAMS, body: TEST_SEND_REQUEST } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await notif.call("POST", `${ver(req.params.key, req.params.v)}/test`, { actor: auth.actor, body: req.body });
      return relay(ctx, auth, reply, SERVICE, TEST_SEND_RESULT, res);
    },
  );

  app.get(
    "/admin/v1/notifications/test-recipients",
    { config: requirePermission("notif.templates.manage", "notif.campaigns.manage"), schema: { response: out(TEST_RECIPIENTS) } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, TEST_RECIPIENTS, await notif.get<unknown>("/admin/v1/notifications/test-recipients", { actor: auth.actor }));
    },
  );

  // ---------------------------------------------------------------- рассылки

  app.get<{ Querystring: { status?: string; cursor?: string; limit?: string } }>(
    CAMPAIGNS,
    {
      config: requirePermission("notif.campaigns.manage"),
      schema: { response: out(CAMPAIGN_PAGE), querystring: query({ status: CAMPAIGN_STATUS, cursor: CURSOR_Q, limit: LIMIT_Q }) },
    },
    async (req) => {
      const auth = staffOf(req);
      const body = await notif.get<unknown>(CAMPAIGNS, { actor: auth.actor, query: { status: req.query.status, ...pageQuery(req.query) } });
      return shaped(ctx, auth, SERVICE, CAMPAIGN_PAGE, body, { names: true });
    },
  );

  app.get<{ Params: { id: string } }>(
    `${CAMPAIGNS}/:id`,
    { config: requirePermission("notif.campaigns.manage"), schema: { response: out(CAMPAIGN), params: CAMPAIGN_PARAMS } },
    async (req) => {
      const auth = staffOf(req);
      return shaped(ctx, auth, SERVICE, CAMPAIGN, await notif.get<unknown>(camp(req.params.id), { actor: auth.actor }), { names: true });
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    CAMPAIGNS,
    { config: requirePermission("notif.campaigns.manage"), schema: { response: out(CAMPAIGN), body: CAMPAIGN_CREATE } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await notif.call("POST", CAMPAIGNS, { actor: auth.actor, body: req.body, idempotencyKey: idempotencyKeyOf(req, true) });
      return relay(ctx, auth, reply, SERVICE, CAMPAIGN, res, { names: true });
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    `${CAMPAIGNS}/:id`,
    { config: requirePermission("notif.campaigns.manage"), schema: { response: out(CAMPAIGN), params: CAMPAIGN_PARAMS, body: CAMPAIGN_PATCH } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await notif.call("PATCH", camp(req.params.id), { actor: auth.actor, body: req.body });
      return relay(ctx, auth, reply, SERVICE, CAMPAIGN, res, { names: true });
    },
  );

  app.post<{ Params: { id: string } }>(
    `${CAMPAIGNS}/:id/estimate`,
    { config: requirePermission("notif.campaigns.manage"), schema: { response: out(CAMPAIGN_ESTIMATE), params: CAMPAIGN_PARAMS, body: obj({}) } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await notif.call("POST", `${camp(req.params.id)}/estimate`, { actor: auth.actor, body: {} });
      return relay(ctx, auth, reply, SERVICE, CAMPAIGN_ESTIMATE, res);
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    `${CAMPAIGNS}/:id/preview`,
    { config: requirePermission("notif.campaigns.manage"), schema: { response: out(TEMPLATE_PREVIEW), params: CAMPAIGN_PARAMS, body: PREVIEW_REQUEST } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await notif.call("POST", `${camp(req.params.id)}/preview`, { actor: auth.actor, body: req.body });
      return relay(ctx, auth, reply, SERVICE, TEMPLATE_PREVIEW, res);
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    `${CAMPAIGNS}/:id/test`,
    { config: requirePermission("notif.campaigns.manage"), schema: { response: out(TEST_SEND_RESULT), params: CAMPAIGN_PARAMS, body: TEST_SEND_REQUEST } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await notif.call("POST", `${camp(req.params.id)}/test`, { actor: auth.actor, body: req.body });
      return relay(ctx, auth, reply, SERVICE, TEST_SEND_RESULT, res);
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    `${CAMPAIGNS}/:id/schedule`,
    {
      config: { ...requirePermission("notif.campaigns.send"), ...requireStepUp() },
      schema: { response: out(CAMPAIGN), params: CAMPAIGN_PARAMS, body: CAMPAIGN_SCHEDULE },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await notif.call("POST", `${camp(req.params.id)}/schedule`, {
        actor: auth.actor,
        body: req.body,
        idempotencyKey: idempotencyKeyOf(req, false),
      });
      return relay(ctx, auth, reply, SERVICE, CAMPAIGN, res, { names: true });
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    `${CAMPAIGNS}/:id/unschedule`,
    { config: requirePermission("notif.campaigns.send"), schema: { response: out(CAMPAIGN), params: CAMPAIGN_PARAMS, body: REASON_BODY } },
    async (req, reply) => {
      const auth = staffOf(req);
      const res = await notif.call("POST", `${camp(req.params.id)}/unschedule`, { actor: auth.actor, body: req.body });
      return relay(ctx, auth, reply, SERVICE, CAMPAIGN, res, { names: true });
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    `${CAMPAIGNS}/:id/stop`,
    {
      config: { ...requirePermission("notif.campaigns.send"), ...requireStepUp() },
      schema: { response: out(CAMPAIGN), params: CAMPAIGN_PARAMS, body: REASON_BODY },
    },
    async (req, reply) => {
      const auth = staffOf(req);
      // экстренная остановка: без повторов вслепую (повтор — 200 у домена, но решает сотрудник)
      const res = await notif.call("POST", `${camp(req.params.id)}/stop`, { actor: auth.actor, body: req.body });
      return relay(ctx, auth, reply, SERVICE, CAMPAIGN, res, { names: true });
    },
  );
}
