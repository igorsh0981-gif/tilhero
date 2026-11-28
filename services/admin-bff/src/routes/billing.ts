/**
 * Деньги (admin.ts «Деньги», спринт 8; INTERNAL_API спринта 8 §1.2, §1.12–§1.15, §1.17, §12):
 * `/admin/v1/billing/*` → billing `/internal/v1/admin/billing/*`; вкладка «Тариф» карточки ученика
 * `/admin/v1/learners/{user_id}/billing` → user-admin (вид профиля и опекун) + billing `/accounts/{account_id}`.
 * Права проверяются здесь до вызова домена (onRequest), billing — повторно по actor (защита в глубину); аудит каждой
 * команды пишет billing (`billing.catalog_activated | … | trials_granted`).
 *
 *  - billing.read — каталог и версии, заказы и карточка, возвраты, аккаунт и реестр минут, заявки, сверка, курсы,
 *    провайдеры, вкладка «Тариф»; отчёты — billing.read | dashboard.read;
 *  - billing.manage — черновик каталога (If-Match — как есть, 409 DRAFT_CONFLICT решает billing), проверка, удаление
 *    черновика; курсы USD и Star; ручной прогон и разбор сверки;
 *  - billing.publish + step-up — активация и откат каталога, массовая выдача пробного;
 *  - subscriptions.override + step-up — заявка на корректировку («четыре глаза»); отзыв своей заявки — без step-up;
 *  - billing.approve + step-up — подтверждение и отклонение чужой заявки (автор — 409 SELF_APPROVAL от billing;
 *    подсказки UI can_decide / can_cancel вычисляет admin-bff по правам сессии — автор кнопку «Подтвердить» не видит);
 *  - billing.refund + step-up — возврат по заказу (причина 10..500, Idempotency-Key обязателен) и закрытие возврата
 *    как неудачного.
 * Команде со step-up admin-bff передаёт `X-Step-Up: ok` (staff_id — в actor-токене). Idempotency-Key — сквозной; у
 * заявки на корректировку и у возврата обязателен (деньги и минуты: повтор после потерянного ответа не должен создать
 * второй возврат или вторую заявку), у прочих POST — передаётся, если прислан (формат — 422 до домена).
 *
 * Ключи провайдеров админка не показывает и не принимает: `GET /providers` — только «включён / задан ключ».
 * Ошибки billing — как есть (CATALOG_INVALID {errors}, CATALOG_NOT_VALIDATED, DRAFT_CONFLICT, REFUND_STATE,
 * REFUND_NOT_ALLOWED {reason, til?, til_balance?}, SELF_APPROVAL, BALANCE_NEGATIVE, ADJUSTMENT_STATE, RECON_ITEM_STATE,
 * STARS_PAYER_UNKNOWN, FX_INVALID, *_NOT_FOUND). BILLING_URL не задана, billing недоступен, 5xx, испорченный ответ (в т.
 * ч. «смешанные» деньги: две суммы, сумма не в валюте заказа, канал не своего провайдера) → 503 UPSTREAM_UNAVAILABLE
 * {service: billing}; остальная админка работает.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AdminLedgerEntry, Adjustment, Page } from "@tilhero/contracts/admin";
import { AppError } from "@tilhero/ts-common";
import { parseDomain, type Codec } from "../codec.js";
import {
  ADJUSTMENT,
  ADJUSTMENT_PAGE,
  ADMIN_REFUND,
  BILLING_ACCOUNT,
  BILLING_SUMMARY,
  CATALOG_LIST,
  CATALOG_VALIDATION,
  CATALOG_VERSION,
  DAILY_LIST,
  FX_LIST,
  FX_RATE,
  LEARNER_ACCOUNT_REF,
  LEDGER_PAGE,
  ORDER_CARD,
  ORDER_PAGE,
  PROVIDER_LIST,
  RECON_ITEM,
  RECON_PAGE,
  RECON_RUN,
  REFUND_PAGE,
  STAR_RATE,
  STAR_RATE_LIST,
  TRIALS_RESULT,
  adjustmentHints,
} from "../contractBilling.js";
import { withDomainNames } from "../contractGame.js";
import type { BffContext } from "../context.js";
import { hasPermission, idempotencyKeyOf, ifMatchOf, passReplayed, staffOf, validationError, type App, type StaffAuth } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { NO_CONTENT } from "../responses.js";
import {
  ADJUSTMENT_APPROVE,
  ADJUSTMENT_REJECT,
  ADJUSTMENT_REQUEST,
  ADJUSTMENT_STATUSES,
  BILLING_CHANNELS,
  BILLING_PROVIDERS,
  CATALOG_BODY_LIMIT,
  CATALOG_COMMENT,
  CATALOG_DRAFT,
  CATALOG_VERSION_NO,
  CURSOR_Q,
  DAILY_MAX_DAYS,
  DATE_Q,
  FX_REQUEST,
  ISO_Q,
  LIMIT_Q,
  ORDER_NO_Q,
  ORDER_STATUSES,
  PRODUCT_KINDS,
  PROVIDER_TXN_Q,
  RECON_ITEM_KINDS,
  RECON_RESOLVE,
  RECON_STATUSES,
  REFUND_FAIL,
  REFUND_REQUEST,
  REFUND_STATUSES,
  REPORT_PERIODS,
  STAR_RATE_REQUEST,
  TRIALS_GRANT_ALL,
  UUID,
  enumOf,
  obj,
  pageQuery,
  params,
  query,
} from "../schemas.js";
import { BILLING_SERVICE, DOMAIN, upstreamUnavailable, type CallOptions, type DomainClient } from "../upstream.js";
import { out } from "./common.js";

export const BILLING_BASE = "/admin/v1/billing";
const INTERNAL = "/internal/v1/admin/billing";
const EMPTY = obj({});
/** Маршрут без параметров запроса: лишний параметр → 422 (как лишнее поле тела). */
const NO_QUERY = query({});
const PAGE_Q = { cursor: CURSOR_Q, limit: LIMIT_Q };

type Idem = "required" | "optional";
interface ProxyOptions<T> {
  body?: unknown;
  query?: CallOptions["query"];
  idempotency?: Idem;
  headers?: Record<string, string>;
  /** Дополнение ответа после кодека (имена сотрудников реестра, подсказки UI заявок). */
  after?: (auth: StaffAuth, v: T) => T | Promise<T>;
}

/** Дни между датами YYYY-MM-DD включительно (обе — проверенные даты). */
function daySpan(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Asia/Tashkent — UTC+5 без перехода на летнее время (дни отчётов и фильтров billing). */
const TASHKENT_OFFSET = "+05:00";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Граница фильтра по дате: YYYY-MM-DD — начало дня Ташкента (`end` — начало следующего дня: «по» включительно);
 * время с зоной — как есть.
 */
export function tashkentBound(v: string, end: boolean): string {
  if (!DATE_ONLY.test(v)) return v;
  if (!end) return `${v}T00:00:00${TASHKENT_OFFSET}`;
  const next = new Date(Date.parse(`${v}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return `${next}T00:00:00${TASHKENT_OFFSET}`;
}

/** Реальная дата YYYY-MM-DD (не 2026-02-31). */
function realDate(v: string): boolean {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function billingRoutes(app: App, ctx: BffContext): void {
  /** Клиент billing; BILLING_URL не задана → 503 UPSTREAM_UNAVAILABLE {service: billing}. */
  const billing = (): DomainClient => {
    if (!ctx.billing) throw upstreamUnavailable(BILLING_SERVICE);
    return ctx.billing;
  };

  /** Имена сотрудников записей реестра минут: имя billing остаётся; `staff:<id>` без имени → staff/lookup. */
  async function ledgerNames(auth: StaffAuth, page: Page<AdminLedgerEntry>): Promise<Page<AdminLedgerEntry>> {
    const need = (e: AdminLedgerEntry) => e.actor.startsWith("staff:") && !e.actor_name;
    const ids = [...new Set(page.items.filter(need).map((e) => e.actor.slice(6)))];
    if (!ids.length) return page;
    const names = await ctx.names.resolve(ids, auth);
    return { ...page, items: page.items.map((e) => (need(e) ? { ...e, actor_name: names.get(e.actor.slice(6)) ?? null } : e)) };
  }
  const hints = (auth: StaffAuth, a: Adjustment): Adjustment => adjustmentHints(a, auth.principal.staff.staff_id, hasPermission(auth, "billing.approve"));

  /**
   * Вызов billing с actor: Idempotency-Key (обязательный — 422 до домена), `X-Step-Up: ok` для маршрутов requireStepUp
   * → строгий кодек → имена сотрудников в StaffRef → дополнение → статус домена и Idempotent-Replayed.
   */
  async function proxy<T>(req: FastifyRequest, reply: FastifyReply, method: string, path: string, c: Codec<T>, o: ProxyOptions<T> = {}) {
    const auth = staffOf(req);
    const idempotencyKey = o.idempotency ? idempotencyKeyOf(req, o.idempotency === "required") : undefined;
    const stepUp: Record<string, string> = req.routeOptions.config.stepUp === true ? { "x-step-up": "ok" } : {};
    const res = await billing().call(method, `${INTERNAL}${path}`, {
      actor: auth.actor,
      ...(o.body !== undefined ? { body: o.body } : {}),
      ...(o.query ? { query: o.query } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      headers: { ...o.headers, ...stepUp },
    });
    passReplayed(reply, res);
    let body = await withDomainNames(ctx, auth, parseDomain(ctx, BILLING_SERVICE, c, res.body));
    if (o.after) body = await o.after(auth, body);
    return reply.status(res.status).send(body);
  }

  type P = Record<string, string>;
  type Q = Record<string, string | undefined>;
  const p = (req: FastifyRequest): P => req.params as P;
  const qs = (req: FastifyRequest): Q => req.query as Q;
  /** UUID из пути — в нижнем регистре (схема пути уже проверила формат). */
  const id = (req: FastifyRequest, name: string): string => p(req)[name]!.toLowerCase();

  const read = <T>(c: Codec<T>, path: (req: FastifyRequest) => string, q?: (req: FastifyRequest) => CallOptions["query"], after?: ProxyOptions<T>["after"]) =>
    async (req: FastifyRequest, reply: FastifyReply) => proxy(req, reply, "GET", path(req), c, { ...(q ? { query: q(req) } : {}), ...(after ? { after } : {}) });
  const command = <T>(c: Codec<T>, path: (req: FastifyRequest) => string, idempotency: Idem = "optional", after?: ProxyOptions<T>["after"]) =>
    async (req: FastifyRequest, reply: FastifyReply) => proxy(req, reply, "POST", path(req), c, { body: req.body ?? {}, idempotency, ...(after ? { after } : {}) });

  // ================================================================ каталог тарифов и товаров (ADM-MONEY-03)

  const VERSION_PARAMS = params({ version: CATALOG_VERSION_NO });

  app.get(`${BILLING_BASE}/catalog`, { config: requirePermission("billing.read"), schema: { response: out(CATALOG_LIST), querystring: NO_QUERY } }, read(CATALOG_LIST, () => "/catalog"));

  app.get(
    `${BILLING_BASE}/catalog/:version`,
    { config: requirePermission("billing.read"), schema: { response: out(CATALOG_VERSION), params: VERSION_PARAMS, querystring: NO_QUERY } },
    read(CATALOG_VERSION, (req) => `/catalog/${Number(p(req).version)}`),
  );

  /** Создать или заменить черновик; If-Match (updated_at черновика) — в billing как есть (409 DRAFT_CONFLICT). */
  app.put(
    `${BILLING_BASE}/catalog/draft`,
    { bodyLimit: CATALOG_BODY_LIMIT, config: requirePermission("billing.manage"), schema: { response: out(CATALOG_VERSION), body: CATALOG_DRAFT } },
    async (req, reply) => proxy(req, reply, "PUT", "/catalog/draft", CATALOG_VERSION, { body: req.body, headers: ifMatchOf(req.headers["if-match"]) }),
  );

  app.delete(`${BILLING_BASE}/catalog/draft`, { config: requirePermission("billing.manage"), schema: { response: NO_CONTENT, body: EMPTY } }, async (req, reply) => {
    const auth = staffOf(req);
    await billing().call("DELETE", `${INTERNAL}/catalog/draft`, { actor: auth.actor });
    return reply.status(204).send();
  });

  app.post(
    `${BILLING_BASE}/catalog/draft/validate`,
    { config: requirePermission("billing.manage"), schema: { response: out(CATALOG_VALIDATION), body: EMPTY } },
    async (req, reply) => proxy(req, reply, "POST", "/catalog/draft/validate", CATALOG_VALIDATION, { body: {} }),
  );

  app.post(
    `${BILLING_BASE}/catalog/draft/activate`,
    { config: { ...requirePermission("billing.publish"), ...requireStepUp() }, schema: { response: out(CATALOG_VERSION), body: CATALOG_COMMENT } },
    command(CATALOG_VERSION, () => "/catalog/draft/activate"),
  );

  app.post(
    `${BILLING_BASE}/catalog/:version/rollback`,
    {
      config: { ...requirePermission("billing.publish"), ...requireStepUp() },
      schema: { response: out(CATALOG_VERSION), params: VERSION_PARAMS, body: CATALOG_COMMENT },
    },
    command(CATALOG_VERSION, (req) => `/catalog/${Number(p(req).version)}/rollback`),
  );

  /** Разовая выдача пробного всем активным 14+ без пробного (только при TRIAL_ON_ENFORCEMENT=true в billing). */
  app.post(
    `${BILLING_BASE}/trials::grant-all`,
    { config: { ...requirePermission("billing.publish"), ...requireStepUp() }, schema: { response: out(TRIALS_RESULT), body: TRIALS_GRANT_ALL } },
    command(TRIALS_RESULT, () => "/trials:grant-all"),
  );

  // ================================================================ заказы, платежи, возвраты (ADM-MONEY-01, ADM-MONEY-04)

  const ORDER_PARAMS = params({ orderId: UUID });

  /**
   * ?from=&to= — ISO-8601 (дата или время с зоной); from позже to или неразборчивая дата → 422 до домена. Дата без
   * времени — день Ташкента: from — его начало, to — включительно (billing: created_at < to → начало следующего дня).
   */
  app.get(
    `${BILLING_BASE}/orders`,
    {
      config: requirePermission("billing.read"),
      schema: {
        response: out(ORDER_PAGE),
        querystring: query({
          status: enumOf(ORDER_STATUSES),
          channel: enumOf(BILLING_CHANNELS),
          provider: enumOf(BILLING_PROVIDERS),
          product_kind: enumOf(PRODUCT_KINDS),
          from: ISO_Q,
          to: ISO_Q,
          order_no: ORDER_NO_Q,
          provider_txn_id: PROVIDER_TXN_Q,
          account_id: UUID,
          ...PAGE_Q,
        }),
      },
    },
    async (req, reply) => {
      const q = qs(req);
      for (const k of ["from", "to"] as const) {
        if (q[k] !== undefined && Number.isNaN(Date.parse(q[k]!))) throw validationError(k, "Ожидается дата ISO-8601", "querystring");
      }
      if (q.from !== undefined && q.to !== undefined && Date.parse(q.from) > Date.parse(q.to)) {
        throw validationError("from", "Начало периода позже конца", "querystring");
      }
      return proxy(req, reply, "GET", "/orders", ORDER_PAGE, {
        query: {
          status: q.status,
          channel: q.channel,
          provider: q.provider,
          product_kind: q.product_kind,
          from: q.from === undefined ? undefined : tashkentBound(q.from, false),
          to: q.to === undefined ? undefined : tashkentBound(q.to, true),
          order_no: q.order_no,
          provider_txn_id: q.provider_txn_id,
          account_id: q.account_id?.toLowerCase(),
          ...pageQuery(q),
        },
      });
    },
  );

  app.get(
    `${BILLING_BASE}/orders/:orderId`,
    { config: requirePermission("billing.read"), schema: { response: out(ORDER_CARD), params: ORDER_PARAMS, querystring: NO_QUERY } },
    read(ORDER_CARD, (req) => `/orders/${id(req, "orderId")}`),
  );

  /**
   * Возврат (billing.refund, step-up, причина 10..500, Idempotency-Key обязателен): Stars и Click — сразу (completed |
   * failed), Payme и Uzum — awaiting_provider с инструкцией; 409 REFUND_STATE | REFUND_NOT_ALLOWED | STARS_PAYER_UNKNOWN.
   */
  app.post(
    `${BILLING_BASE}/orders/:orderId/refunds`,
    { config: { ...requirePermission("billing.refund"), ...requireStepUp() }, schema: { response: out(ADMIN_REFUND), params: ORDER_PARAMS, body: REFUND_REQUEST } },
    command(ADMIN_REFUND, (req) => `/orders/${id(req, "orderId")}/refunds`, "required"),
  );

  app.get(
    `${BILLING_BASE}/refunds`,
    { config: requirePermission("billing.read"), schema: { response: out(REFUND_PAGE), querystring: query({ status: enumOf(REFUND_STATUSES), ...PAGE_Q }) } },
    read(REFUND_PAGE, () => "/refunds", (req) => ({ status: qs(req).status, ...pageQuery(qs(req)) })),
  );

  app.post(
    `${BILLING_BASE}/refunds/:refundId/fail`,
    {
      config: { ...requirePermission("billing.refund"), ...requireStepUp() },
      schema: { response: out(ADMIN_REFUND), params: params({ refundId: UUID }), body: REFUND_FAIL },
    },
    command(ADMIN_REFUND, (req) => `/refunds/${id(req, "refundId")}/fail`),
  );

  // ================================================================ аккаунт: тариф, реестр минут, заявки «четыре глаза»

  const ACCOUNT_PARAMS = params({ accountId: UUID });

  app.get(
    `${BILLING_BASE}/accounts/:accountId`,
    { config: requirePermission("billing.read"), schema: { response: out(BILLING_ACCOUNT), params: ACCOUNT_PARAMS, querystring: NO_QUERY } },
    read(BILLING_ACCOUNT, (req) => `/accounts/${id(req, "accountId")}`),
  );

  app.get(
    `${BILLING_BASE}/accounts/:accountId/ledger`,
    { config: requirePermission("billing.read"), schema: { response: out(LEDGER_PAGE), params: ACCOUNT_PARAMS, querystring: query(PAGE_Q) } },
    read(LEDGER_PAGE, (req) => `/accounts/${id(req, "accountId")}/ledger`, (req) => pageQuery(qs(req)), ledgerNames),
  );

  /** Заявка (subscriptions.override, step-up, причина 10..500, Idempotency-Key обязателен) → 202 Adjustment pending. */
  app.post(
    `${BILLING_BASE}/accounts/:accountId/adjustments`,
    {
      config: { ...requirePermission("subscriptions.override"), ...requireStepUp() },
      schema: { response: out(ADJUSTMENT), params: ACCOUNT_PARAMS, body: ADJUSTMENT_REQUEST },
    },
    async (req, reply) => {
      const body = req.body as { period_id?: string };
      return proxy(req, reply, "POST", `/accounts/${id(req, "accountId")}/adjustments`, ADJUSTMENT, {
        body: body.period_id ? { ...body, period_id: body.period_id.toLowerCase() } : body,
        idempotency: "required",
        after: hints,
      });
    },
  );

  const ADJ_PARAMS = params({ adjustmentId: UUID });

  app.get(
    `${BILLING_BASE}/adjustments`,
    {
      config: requirePermission("billing.read"),
      schema: { response: out(ADJUSTMENT_PAGE), querystring: query({ status: enumOf(ADJUSTMENT_STATUSES), account_id: UUID, ...PAGE_Q }) },
    },
    read(ADJUSTMENT_PAGE, () => "/adjustments", (req) => ({ status: qs(req).status, account_id: qs(req).account_id?.toLowerCase(), ...pageQuery(qs(req)) }), (auth, page) => ({
      ...page,
      items: page.items.map((a) => hints(auth, a)),
    })),
  );

  app.post(
    `${BILLING_BASE}/adjustments/:adjustmentId/approve`,
    { config: { ...requirePermission("billing.approve"), ...requireStepUp() }, schema: { response: out(ADJUSTMENT), params: ADJ_PARAMS, body: ADJUSTMENT_APPROVE } },
    command(ADJUSTMENT, (req) => `/adjustments/${id(req, "adjustmentId")}/approve`, "optional", hints),
  );

  app.post(
    `${BILLING_BASE}/adjustments/:adjustmentId/reject`,
    { config: { ...requirePermission("billing.approve"), ...requireStepUp() }, schema: { response: out(ADJUSTMENT), params: ADJ_PARAMS, body: ADJUSTMENT_REJECT } },
    command(ADJUSTMENT, (req) => `/adjustments/${id(req, "adjustmentId")}/reject`, "optional", hints),
  );

  /** Отзыв своей заявки (только автор — проверяет billing): без step-up, право — как у подачи. */
  app.post(
    `${BILLING_BASE}/adjustments/:adjustmentId/cancel`,
    { config: requirePermission("subscriptions.override"), schema: { response: out(ADJUSTMENT), params: ADJ_PARAMS, body: EMPTY } },
    command(ADJUSTMENT, (req) => `/adjustments/${id(req, "adjustmentId")}/cancel`, "optional", hints),
  );

  // ================================================================ сверка (ADM-MONEY-04, AT-97)

  app.get(
    `${BILLING_BASE}/reconciliation/items`,
    {
      config: requirePermission("billing.read"),
      schema: { response: out(RECON_PAGE), querystring: query({ status: enumOf(RECON_STATUSES), kind: enumOf(RECON_ITEM_KINDS), ...PAGE_Q }) },
    },
    read(RECON_PAGE, () => "/reconciliation/items", (req) => ({ status: qs(req).status, kind: qs(req).kind, ...pageQuery(qs(req)) })),
  );

  app.post(
    `${BILLING_BASE}/reconciliation/runs`,
    { config: requirePermission("billing.manage"), schema: { response: out(RECON_RUN), body: EMPTY } },
    command(RECON_RUN, () => "/reconciliation/runs"),
  );

  app.post(
    `${BILLING_BASE}/reconciliation/items/:itemId/resolve`,
    { config: requirePermission("billing.manage"), schema: { response: out(RECON_ITEM), params: params({ itemId: UUID }), body: RECON_RESOLVE } },
    command(RECON_ITEM, (req) => `/reconciliation/items/${id(req, "itemId")}/resolve`),
  );

  // ================================================================ отчёты, курсы, провайдеры (ADM-DASH-04)

  app.get(
    `${BILLING_BASE}/reports/summary`,
    { config: requirePermission("billing.read", "dashboard.read"), schema: { response: out(BILLING_SUMMARY), querystring: query({ period: enumOf(REPORT_PERIODS) }) } },
    read(BILLING_SUMMARY, () => "/reports/summary", (req) => ({ period: qs(req).period ?? "day" })),
  );

  /** По дням: from и to обязательны, from ≤ to, не больше 92 дней — 422 до домена. */
  app.get(
    `${BILLING_BASE}/reports/daily`,
    {
      config: requirePermission("billing.read", "dashboard.read"),
      schema: { response: out(DAILY_LIST), querystring: obj({ from: DATE_Q, to: DATE_Q }, ["from", "to"]) },
    },
    async (req, reply) => {
      const { from, to } = qs(req) as { from: string; to: string };
      for (const [k, v] of [["from", from], ["to", to]] as const) if (!realDate(v)) throw validationError(k, "Несуществующая дата", "querystring");
      if (from > to) throw validationError("from", "Начало периода позже конца", "querystring");
      if (daySpan(from, to) > DAILY_MAX_DAYS) throw validationError("to", `Не больше ${DAILY_MAX_DAYS} дней`, "querystring");
      return proxy(req, reply, "GET", "/reports/daily", DAILY_LIST, { query: { from, to } });
    },
  );

  app.get(`${BILLING_BASE}/fx`, { config: requirePermission("billing.read"), schema: { response: out(FX_LIST), querystring: NO_QUERY } }, read(FX_LIST, () => "/fx"));

  app.put(
    `${BILLING_BASE}/fx`,
    { config: requirePermission("billing.manage"), schema: { response: out(FX_RATE), body: FX_REQUEST } },
    async (req, reply) => {
      const b = req.body as { valid_from: string };
      if (!realDate(b.valid_from)) throw validationError("valid_from", "Несуществующая дата");
      return proxy(req, reply, "PUT", "/fx", FX_RATE, { body: req.body, idempotency: "optional" });
    },
  );

  app.get(`${BILLING_BASE}/star-rate`, { config: requirePermission("billing.read"), schema: { response: out(STAR_RATE_LIST), querystring: NO_QUERY } }, read(STAR_RATE_LIST, () => "/star-rate"));

  app.put(
    `${BILLING_BASE}/star-rate`,
    { config: requirePermission("billing.manage"), schema: { response: out(STAR_RATE), body: STAR_RATE_REQUEST } },
    async (req, reply) => {
      const b = req.body as { valid_from: string };
      if (!realDate(b.valid_from)) throw validationError("valid_from", "Несуществующая дата");
      return proxy(req, reply, "PUT", "/star-rate", STAR_RATE, { body: req.body, idempotency: "optional" });
    },
  );

  /** Провайдеры: включён ли и задан ли ключ — ключи не показываются и не принимаются никогда. */
  app.get(`${BILLING_BASE}/providers`, { config: requirePermission("billing.read"), schema: { response: out(PROVIDER_LIST), querystring: NO_QUERY } }, read(PROVIDER_LIST, () => "/providers"));

  // ================================================================ карточка ученика → вкладка «Тариф» (ADM-USR-02)

  /**
   * Тариф ученика (billing.read): аккаунт — сам ученик или опекун детского профиля (user-admin карточка: вид и
   * guardian_user_id) → billing `/accounts/{account_id}`. Отдельный маршрут: карточка ученика не зависит от billing.
   * BILLING_URL не задана — 503 {service: billing} без вызова user-admin; ученик не найден — 404 user-admin как есть;
   * детский профиль без опекуна — 404 ACCOUNT_NOT_FOUND.
   */
  app.get(
    "/admin/v1/learners/:id/billing",
    { config: requirePermission("billing.read"), schema: { response: out(BILLING_ACCOUNT), params: params({ id: UUID }), querystring: NO_QUERY } },
    async (req, reply) => {
      const auth = staffOf(req);
      const client = billing();
      const card = parseDomain(ctx, DOMAIN.userAdmin, LEARNER_ACCOUNT_REF, await ctx.domains.userAdmin.get<unknown>(`/admin/v1/learners/${id(req, "id")}`, { actor: auth.actor }));
      const account = card.kind === "child" ? card.guardian_user_id : card.user_id;
      if (!account) throw new AppError(404, "ACCOUNT_NOT_FOUND", "У детского профиля нет аккаунта опекуна");
      const res = await client.call("GET", `${INTERNAL}/accounts/${account}`, { actor: auth.actor });
      const body = await withDomainNames(ctx, auth, parseDomain(ctx, BILLING_SERVICE, BILLING_ACCOUNT, res.body));
      return reply.status(200).send(body);
    },
  );
}
