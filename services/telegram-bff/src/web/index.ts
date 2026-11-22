/**
 * Спринт 8 — сайт оплаты вне Telegram (INTERNAL_API §3, контракт packages/contracts/src/web.ts): маршруты /web/v1/*.
 * Своя область Fastify (encapsulation, prefix /web/v1): cookie-сессия `__Host-wp_session` (JWT WEB_SESSION_SECRET),
 * вход «Log In with Telegram» (OIDC Authorization Code + PKCE S256, `id_token` по JWKS `config.webPay.oidcBase`),
 * CSRF `X-CSRF-Token` и `Origin = config.webPay.origin` у изменяющих запросов (иначе 403 CSRF_INVALID), лимиты
 * `web.auth_ip`, `web.read`, `web.order`, вызовы billing через `ctx.billing` с claims `{lrn: <аккаунт>, chn: "web"}`.
 * Запросы приходят через Caddy web-pay (/api/* → /web/v1/*): адрес клиента — глубина 2 справа в X-Forwarded-For.
 * Секрет клиента OIDC, `code`, `code_verifier`, `id_token` и Telegram ID — никогда в лог, Redis-ключи и ответы.
 *
 * WEB_PAY_ENABLED=false — область не регистрируется: /web/v1/* → 404 NOT_FOUND.
 * Каркас потока 0: маршрутов нет. Пишет поток H (src/web/**, test/web/**).
 */
import type { BffContext } from "../context.js";
import type { App } from "../http.js";

export const WEB_PREFIX = "/web/v1";

export async function webRoutes(app: App, ctx: BffContext): Promise<void> {
  if (!ctx.config.webPay.enabled) return;
  await app.register(
    async (_web) => {
      // поток H
    },
    { prefix: WEB_PREFIX },
  );
}
