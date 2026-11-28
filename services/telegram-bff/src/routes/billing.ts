/**
 * Спринт 8 — подписка и покупки за Telegram Stars в Mini App (канал `miniapp`, INTERNAL_API §1.3, §1.5, §1.11, §1.17,
 * §12; bff.ts «Спринт 8»): тонкий прокси `/v1/billing/*` → billing `/internal/v1/me/billing/*` через `ctx.billing`.
 *
 * Вызов: `sub` — аккаунт (подписка, минуты и заказы — на аккаунт), claims `lrn` и `age_band` активного ученика и
 * **`chn: "miniapp"`** (канал продаж: billing сам фильтрует каталог и заказы по каналу и проверяет пару «канал —
 * провайдер»). Язык счёта Stars (`stars_title`) — заголовок `Accept-Language` (ru | uz). `user_id` в запросах нет.
 *
 * Анти-стиринг: провайдер на входе — только `telegram_stars` (иное — 422 без вызова billing); ответы собираются кодеками
 * `contractBilling.ts` и сериализуются по схемам контракта — без тийинов, фиатных провайдеров, адресов оплаты вне
 * Telegram и заказов других каналов; ошибки billing — код и статус как есть, details — только поля контракта, текст —
 * нейтральный текст BFF.
 *
 * Детский профиль (`lrn ≠ sub`, защита в глубину): команды оплаты и история заказов — 403 PAYER_REQUIRED без вызова
 * billing; каталог — без цен и пробного; подписка — «статус семьи» без цены подписки Stars.
 *
 * Ошибки: нет `BILLING_URL`, недоступность, таймаут, 5xx, отказ внутренней авторизации, ответ не по контракту → 503
 * BILLING_UNAVAILABLE {service: billing} (покупки недоступны — учёба работает); 503 STARS_UNAVAILABLE (счёт не получен —
 * заказ pending, повторить тем же Idempotency-Key) — как есть. Лимиты на аккаунт: `tg.billing.read` (GET, 120/мин),
 * `tg.billing.order` (POST, 10 за 10 мин).
 *
 * `purchase_available` игры (GameSummary, INSUFFICIENT_TILS) — `purchaseAvailable()`: каталог billing того же ученика,
 * любой сбой → false (игра работает без billing).
 */
import type { TSchema, Static } from "@fastify/type-provider-typebox";
import type * as C from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import { asAccount } from "../account.js";
import { expectShape, matches } from "../check.js";
import type { BffContext } from "../context.js";
import {
  BEARER,
  authOf,
  errorResponses,
  idempotencyKey,
  localeOf,
  schemaErrors,
  type App,
} from "../http.js";
import {
  BillingCatalogSchema,
  BillingCursorQuerySchema,
  BillingOrderRequestSchema,
  CatalogDomain,
  MinuteEntrySchema,
  MinutePageSchema,
  OrderDomain,
  OrderNoParamsSchema,
  StarsOrderPageSchema,
  StarsOrderSchema,
  StarsSubscriptionRequestSchema,
  SubscriptionDomain,
  SubscriptionViewSchema,
  billingErrorDetails,
  billingMessage,
  catalogProblem,
  catalogView,
  starsOrderView,
  starsOrdersView,
  subscriptionView,
  tilPurchaseAvailable,
} from "../contractBilling.js";
import { IdempotencyHeadersSchema } from "../schemas.js";
import { createdStatus, isChildProfile } from "../socialApi.js";
import type { AccessClaims } from "../tokens.js";
import { BILLING_SERVICE, type RawMethod, type RawRequest } from "../upstream.js";

const user = { access: "user" } as const;
const TAG = ["billing"];
const READ = "tg.billing.read";
const ORDER = "tg.billing.order";
const ME = "/internal/v1/me/billing";
/** Канал продаж Mini App (claim `chn` внутреннего токена, INTERNAL_API §0.2). */
export const MINIAPP_CHANNEL = "miniapp";
/** Проверка «можно купить тилы» для игровой сводки — короче обычного вызова billing: главная не ждёт billing. */
export const PURCHASE_CHECK_TIMEOUT_MS = 1500;

export const billingUnavailable = () =>
  new AppError(503, "BILLING_UNAVAILABLE", "Покупки временно недоступны, учёба работает", { service: BILLING_SERVICE });
export const payerRequired = () => new AppError(403, "PAYER_REQUIRED", billingMessage("PAYER_REQUIRED"));
export const orderNotFound = () => new AppError(404, "ORDER_NOT_FOUND", billingMessage("ORDER_NOT_FOUND"));

/**
 * Ошибка вызова billing → ответ Mini App: сбой (503 UPSTREAM_UNAVAILABLE {service: billing}) → 503 BILLING_UNAVAILABLE;
 * код домена — как есть, но details — только поля контракта и текст — BFF (анти-стиринг: текст домена наружу не уходит).
 */
export function asBillingError(err: unknown): unknown {
  if (!(err instanceof AppError)) return err;
  if (err.status === 503 && err.code === "UPSTREAM_UNAVAILABLE" && err.details.service === BILLING_SERVICE) return billingUnavailable();
  if (err.code === "CLIENT_CLOSED_REQUEST") return err;
  return new AppError(err.status, err.code, billingMessage(err.code), billingErrorDetails(err.code, err.status, err.details));
}

type Extra = Pick<RawRequest, "query" | "body" | "idempotencyKey">;

/** Параметры вызова billing от имени активного ученика Mini App (sub = аккаунт, lrn, age_band, chn = miniapp). */
async function billingRequest(ctx: BffContext, auth: AccessClaims, locale: "ru" | "uz"): Promise<RawRequest> {
  const band = await ctx.audience.learnerBand(ctx, auth);
  return {
    subject: asAccount(auth),
    claims: { lrn: auth.learnerId, ...(band ? { age_band: band } : {}), chn: MINIAPP_CHANNEL },
    headers: { "accept-language": locale },
  };
}

export interface BillingApi {
  /** Лимит политики на аккаунт (null — без лимита), вызов billing; ошибки — asBillingError. */
  call(auth: AccessClaims, locale: "ru" | "uz", policy: string | null, method: RawMethod, path: string, extra?: Extra): Promise<{ status: number; body: unknown }>;
  /** Ответ по доменной схеме; не по схеме → 503 BILLING_UNAVAILABLE (в лог — проверка, путь, правило). */
  shape<S extends TSchema>(what: string, schema: S, raw: unknown): Static<S>;
}

export function billingApi(ctx: BffContext): BillingApi {
  return {
    async call(auth, locale, policy, method, path, extra = {}) {
      const billing = ctx.billing;
      if (!billing) throw billingUnavailable();
      if (policy) await ctx.limiter.enforce(policy, auth.accountId);
      const ro = await billingRequest(ctx, auth, locale);
      try {
        return await billing.jsonWithStatus<unknown>(method, path, { ...ro, ...extra });
      } catch (err) {
        throw asBillingError(err);
      }
    },
    shape(what, schema, raw) {
      try {
        return expectShape(ctx.log, BILLING_SERVICE, what, schema, raw);
      } catch {
        throw billingUnavailable();
      }
    },
  };
}

/**
 * «Купить тилы» за Stars доступно активному ученику (GameSummary.purchase_available, INSUFFICIENT_TILS): продажи
 * включены ∧ профиль может платить ∧ есть пакет тилов с ценой в Stars. Детский профиль, нет billing, сбой, таймаут,
 * ответ не по контракту — false (игра работает без billing; лимиты billing не тратятся).
 */
export async function purchaseAvailable(ctx: BffContext, auth: AccessClaims, locale: "ru" | "uz" = "ru"): Promise<boolean> {
  const billing = ctx.billing;
  if (!billing || isChildProfile(auth)) return false;
  try {
    const ro = await billingRequest(ctx, auth, locale);
    const raw = await billing.json<unknown>("GET", `${ME}/catalog`, {
      ...ro,
      timeoutMs: Math.min(ctx.config.billingTimeoutMs, PURCHASE_CHECK_TIMEOUT_MS),
      retries: 0,
    });
    if (!matches(CatalogDomain, raw) || catalogProblem(raw, ctx.config.webPay.origin)) return false;
    return tilPurchaseAvailable(catalogView(raw, { childProfile: false, webPayOrigin: ctx.config.webPay.origin, log: ctx.log }));
  } catch {
    return false;
  }
}

export function billingRoutes(app: App, ctx: BffContext): void {
  const log = ctx.log;
  const { call, shape } = billingApi(ctx);
  const webPayOrigin = ctx.config.webPay.origin;

  /** Детский профиль платить не может — до вызова billing (лимит политики уже учтён). */
  async function payerOnly(auth: AccessClaims, policy: string): Promise<void> {
    if (!isChildProfile(auth)) return;
    if (!ctx.billing) throw billingUnavailable();
    await ctx.limiter.enforce(policy, auth.accountId);
    throw payerRequired();
  }

  const subscriptionOf = (auth: AccessClaims, raw: unknown): C.SubscriptionView =>
    subscriptionView(shape("subscription", SubscriptionDomain, raw), isChildProfile(auth));

  /** Заказ из ответа billing на команду: не Stars — ответ не по контракту (503), а не чужой заказ клиенту. */
  const commandOrder = (raw: unknown): C.StarsOrder => {
    const v = starsOrderView(shape("order", OrderDomain, raw));
    if (!v) {
      log.warn({ upstream: BILLING_SERVICE, check: "order", rule: "stars_only", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "domain response does not match the contract");
      throw billingUnavailable();
    }
    return v;
  };

  // ---------------------------------------------------------------- чтение (tg.billing.read)
  app.get(
    "/v1/billing/catalog",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Каталог подписки и пакетов тилов за Telegram Stars (активная версия, канал Mini App)",
        description:
          "Только товары с ценой в Stars ({stars, mode}); providers — [\"telegram_stars\"] или []; sales_enabled = false — " +
          "покупки временно недоступны (каталог виден, кнопки оплаты нет). Детский профиль — products: [], trial: null, " +
          "payer_required: true, can_pay: false. 503 BILLING_UNAVAILABLE — покупки недоступны, учёба работает.",
        security: BEARER,
        response: { 200: BillingCatalogSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const res = await call(auth, localeOf(req), READ, "GET", `${ME}/catalog`);
      const d = shape("catalog", CatalogDomain, res.body);
      const problem = catalogProblem(d, webPayOrigin);
      if (problem) {
        log.warn({ upstream: BILLING_SERVICE, check: "catalog", rule: problem, upstream_code: "UPSTREAM_BAD_RESPONSE" }, "domain response does not match the contract");
        throw billingUnavailable();
      }
      return catalogView(d, { childProfile: isChildProfile(auth), webPayOrigin, log });
    },
  );

  app.get(
    "/v1/billing/subscription",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Подписка аккаунта: статус, период и ИИ-минуты, следующий период, подписка Telegram Stars",
        description:
          "Источник периода (Stars, пробный, выдача поддержкой, покупка вне Mini App) не показывается. Детскому профилю — " +
          "статус семьи без цены (stars_subscription: null, can_pay: false).",
        security: BEARER,
        response: { 200: SubscriptionViewSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      return subscriptionOf(auth, (await call(auth, localeOf(req), READ, "GET", `${ME}/subscription`)).body);
    },
  );

  app.get(
    "/v1/billing/minutes",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "История ИИ-минут аккаунта (начислено, списано за занятие, сгорело, отозвано, поддержка) — новые сверху",
        description: "?cursor=. Комментарии сотрудников не отдаются.",
        security: BEARER,
        querystring: BillingCursorQuerySchema,
        response: { 200: MinutePageSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const res = await call(auth, localeOf(req), READ, "GET", `${ME}/minutes`, { query: { cursor: req.query.cursor } });
      const page = res.body as { items?: unknown; next_cursor?: unknown } | null;
      if (!page || typeof page !== "object" || !Array.isArray(page.items) || !(page.next_cursor == null || typeof page.next_cursor === "string")) {
        shape("minutes", MinutePageSchema, res.body);
      }
      const p = page as { items: unknown[]; next_cursor?: string | null };
      const items = p.items.filter((i): i is C.MinuteEntry => matches(MinuteEntrySchema, i));
      if (items.length < p.items.length) {
        log.warn({ upstream: BILLING_SERVICE, check: "minutes", dropped: p.items.length - items.length, upstream_code: "UPSTREAM_BAD_RESPONSE" }, "list items dropped");
      }
      return { items, next_cursor: typeof p.next_cursor === "string" ? p.next_cursor : null };
    },
  );

  app.get(
    "/v1/billing/orders",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "История платежей Mini App — только заказы Telegram Stars (покупки и продления подписки), новые сверху",
        description: "?cursor=. Покупки вне Mini App здесь не показываются (видны только как статус подписки и минуты). Детский профиль — 403 PAYER_REQUIRED.",
        security: BEARER,
        querystring: BillingCursorQuerySchema,
        response: { 200: StarsOrderPageSchema, ...errorResponses(401, 403, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      await payerOnly(auth, READ);
      const res = await call(auth, localeOf(req), READ, "GET", `${ME}/orders`, { query: { cursor: req.query.cursor } });
      const page = res.body as { items?: unknown; next_cursor?: unknown } | null;
      if (!page || typeof page !== "object" || !Array.isArray(page.items) || !(page.next_cursor == null || typeof page.next_cursor === "string")) {
        shape("orders", StarsOrderPageSchema, res.body);
      }
      const p = page as { items: unknown[]; next_cursor?: string | null };
      return { items: starsOrdersView(p.items, log), next_cursor: typeof p.next_cursor === "string" ? p.next_cursor : null };
    },
  );

  app.get(
    "/v1/billing/orders/:order_no",
    {
      config: user,
      schemaErrorFormatter: schemaErrors([{ context: "params", status: 404, code: "ORDER_NOT_FOUND", message: billingMessage("ORDER_NOT_FOUND") }]),
      schema: {
        tags: TAG,
        summary: "Заказ Stars по номеру (опрос после закрытия счёта: источник истины — billing, не статус openInvoice)",
        description: "Чужой, не Stars или неверный номер — 404 ORDER_NOT_FOUND. invoice_link — пока заказ pending (null — повторить чтение).",
        security: BEARER,
        params: OrderNoParamsSchema,
        response: { 200: StarsOrderSchema, ...errorResponses(401, 403, 404, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      await payerOnly(auth, READ);
      const res = await call(auth, localeOf(req), READ, "GET", `${ME}/orders/${req.params.order_no}`);
      const v = starsOrderView(shape("order", OrderDomain, res.body));
      if (!v) {
        log.warn({ upstream: BILLING_SERVICE, check: "order", rule: "stars_only" }, "non-Stars order hidden from the Mini App");
        throw orderNotFound();
      }
      return v;
    },
  );

  // ---------------------------------------------------------------- команды (tg.billing.order)
  app.post(
    "/v1/billing/trial",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Начать пробный период (один раз на аккаунт, без оплаты) → SubscriptionView",
        description:
          "Idempotency-Key обязателен. 409 TRIAL_USED | TRIAL_NOT_AVAILABLE; 403 PAYER_REQUIRED (детский профиль — без вызова " +
          "billing) | GUARDIAN_CONSENT_REQUIRED.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        response: { 200: SubscriptionViewSchema, 201: SubscriptionViewSchema, ...errorResponses(401, 403, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const key = idempotencyKey(req, true)!;
      const auth = authOf(req);
      await payerOnly(auth, ORDER);
      const res = await call(auth, localeOf(req), ORDER, "POST", `${ME}/trial`, { idempotencyKey: key });
      return reply.code(createdStatus(res.status)).send(subscriptionOf(auth, res.body));
    },
  );

  app.post(
    "/v1/billing/orders",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Заказ за Telegram Stars → StarsOrder со ссылкой на счёт (Telegram.WebApp.openInvoice)",
        description:
          "Idempotency-Key обязателен (повтор — тот же заказ). provider — только telegram_stars (иное — 422). Сумма — из " +
          "каталога на сервере. 409 FORFEIT_CONFIRMATION_REQUIRED {minutes_left, days_left} | ACTIVE_PERIOD_EXISTS {ends_at} | " +
          "STARS_SUBSCRIPTION_EXISTS | OFFER_VERSION_MISMATCH {current} | PRODUCT_NOT_AVAILABLE | PAYMENTS_DISABLED; 403 " +
          "PAYER_REQUIRED | GUARDIAN_CONSENT_REQUIRED | BENEFICIARY_NOT_ALLOWED; 429 ORDERS_LIMIT; 503 STARS_UNAVAILABLE — " +
          "счёт не получен, заказ pending: повторить с тем же ключом.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: BillingOrderRequestSchema,
        response: { 200: StarsOrderSchema, 201: StarsOrderSchema, ...errorResponses(401, 403, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const key = idempotencyKey(req, true)!;
      const auth = authOf(req);
      await payerOnly(auth, ORDER);
      const b = req.body;
      const body: C.BillingOrderRequest = {
        product_code: b.product_code,
        provider: b.provider,
        offer_version: b.offer_version,
        ...(b.start_mode !== undefined ? { start_mode: b.start_mode } : {}),
        ...(b.confirm_forfeit !== undefined ? { confirm_forfeit: b.confirm_forfeit } : {}),
        ...(b.beneficiary_id !== undefined ? { beneficiary_id: b.beneficiary_id.toLowerCase() } : {}),
      };
      const res = await call(auth, localeOf(req), ORDER, "POST", `${ME}/orders`, { body, idempotencyKey: key });
      return reply.code(createdStatus(res.status)).send(commandOrder(res.body));
    },
  );

  app.post(
    "/v1/billing/orders/:order_no/cancel",
    {
      config: user,
      schemaErrorFormatter: schemaErrors([{ context: "params", status: 404, code: "ORDER_NOT_FOUND", message: billingMessage("ORDER_NOT_FOUND") }]),
      schema: {
        tags: TAG,
        summary: "Отменить незавершённый заказ Stars (только pending без платежа) → StarsOrder",
        description: "409 ORDER_STATE {status}; 404 ORDER_NOT_FOUND.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        params: OrderNoParamsSchema,
        response: { 200: StarsOrderSchema, ...errorResponses(401, 403, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const key = idempotencyKey(req, false);
      const auth = authOf(req);
      await payerOnly(auth, ORDER);
      const res = await call(auth, localeOf(req), ORDER, "POST", `${ME}/orders/${req.params.order_no}/cancel`, key ? { idempotencyKey: key } : {});
      return commandOrder(res.body);
    },
  );

  app.post(
    "/v1/billing/stars-subscription",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Автопродление подписки Telegram Stars: выключить (оплаченный период живёт до конца) или включить снова → SubscriptionView",
        description: "404 STARS_SUBSCRIPTION_NOT_FOUND; 503 STARS_UNAVAILABLE; детский профиль — 403 PAYER_REQUIRED.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: StarsSubscriptionRequestSchema,
        response: { 200: SubscriptionViewSchema, ...errorResponses(401, 403, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const key = idempotencyKey(req, false);
      const auth = authOf(req);
      await payerOnly(auth, ORDER);
      const res = await call(auth, localeOf(req), ORDER, "POST", `${ME}/stars-subscription`, {
        body: { auto_renew: req.body.auto_renew },
        ...(key ? { idempotencyKey: key } : {}),
      });
      return subscriptionOf(auth, res.body);
    },
  );
}
