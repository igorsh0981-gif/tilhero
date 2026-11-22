/**
 * Спринт 8 — подписка и покупки за Telegram Stars в Mini App (канал `miniapp`, INTERNAL_API §12, bff.ts «Спринт 8»):
 * GET /v1/billing/catalog | subscription | minutes | orders | orders/{order_no}, POST /v1/billing/trial | orders |
 * orders/{order_no}/cancel | stars-subscription → billing `/internal/v1/me/billing/*` через `ctx.billing` с claims
 * `{lrn, age_band, chn: "miniapp"}` (sub — аккаунт); `provider` — только `telegram_stars`; ответы — только поля
 * контракта (без тийинов и фиатных провайдеров — анти-стиринг); лимиты `tg.billing.read`, `tg.billing.order`;
 * billing недоступен → 503 BILLING_UNAVAILABLE.
 *
 * Каркас потока 0: маршрутов нет. Пишет поток E (кодеки — contractBilling.ts).
 */
import type { BffContext } from "../context.js";
import type { App } from "../http.js";

export function billingRoutes(_app: App, _ctx: BffContext): void {
  // поток E
}
