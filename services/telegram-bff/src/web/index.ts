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
 *
 * Маршруты:
 *  - GET  /auth/start            → 302 на {oidcBase}/auth (state, PKCE; cookie `__Host-wp_oidc`, Redis 10 мин);
 *  - GET  /auth/callback         → 302 на `/` (cookie сессии) или `/?login_error=<WebLoginError>` — без ПДн в адресе;
 *  - POST /auth/logout           → 204 (сессия отозвана, cookie удалены);
 *  - GET  /me                    → WebMe (identity-consent /internal/v1/me; CSRF-токен сессии);
 *  - GET  /catalog, /subscription, /orders, /orders/{order_no} → billing (`chn web`);
 *  - POST /orders, /orders/{order_no}/cancel → billing (`chn web`; плательщик проверяется и здесь — identity-consent).
 *
 * Защита области:
 *  - stage/prod: Host запроса = host WEB_PAY_ORIGIN, иначе 404 — область доступна только через Caddy web-pay (Railway
 *    edge направляет домен сайта в web-pay, а не в публичный домен telegram-bff), поэтому адрес клиента из
 *    X-Forwarded-For (глубина 2) нельзя подделать прямым запросом к telegram-bff;
 *  - сессия: подпись, срок (30 мин скользящий, ≤ 2 ч), отзыв (Redis, fail-closed → 503);
 *  - POST: Origin = WEB_PAY_ORIGIN и X-CSRF-Token = HMAC(jti) — иначе 403 CSRF_INVALID; SameSite=Strict у cookie.
 */
import { isIP } from "node:net";
import { Type, type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { FastifyBaseLogger, FastifyReply } from "fastify";
import { AppError, currentContext, pseudonymize } from "@tilhero/ts-common";
import type { WebLoginError, WebMe } from "@tilhero/contracts/web";
import type { BffContext } from "../context.js";
import { errorResponses, idempotencyKey, type App } from "../http.js";
import { TELEGRAM_OIDC_BASE } from "../config.js";
import type { IdentityMe } from "../views.js";
import { BadUpstream, webCatalog, webOrder, webOrderPage, webSubscription } from "./codecs.js";
import { CALLBACK_PATH, CODE_RE, FLOW_ID_RE, OidcFailure, STATE_RE, TelegramOidc, flowIdOf, newPkce, safeEqual } from "./oidc.js";
import {
  CursorQuerySchema,
  OrderNoParamsSchema,
  WebCatalogSchema,
  WebMeSchema,
  WebOrderPageSchema,
  WebOrderRequestSchema,
  WebOrderSchema,
  WebSubscriptionSchema,
} from "./schemas.js";
import {
  OIDC_COOKIE,
  OIDC_FLOW_SECONDS,
  SESSION_COOKIE,
  WebSessions,
  clearOidcCookie,
  clearSessionCookie,
  csrfInvalid,
  parseCookies,
  serializeCookie,
  sessionExpired,
  type WebSession,
} from "./session.js";

export const WEB_PREFIX = "/web/v1";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Сайт оплаты (/web/v1): nav — навигация браузера (вход, ошибки — перенаправлением); logout — выход;
     *  read — GET с сессией (web.read); write — POST с сессией, Origin и CSRF (web.order). */
    web?: "nav" | "logout" | "read" | "write";
  }
  interface FastifyRequest {
    webSession?: WebSession;
  }
}

/** Ответ identity-consent GET /internal/v1/telegram-users/{id}/account (поток D, INTERNAL_API §9). */
interface TelegramUserAccount {
  account_id: string;
  age_band: string | null;
  guardian_consent: string | null;
  /** дополнение потока D: ACTIVE | DISABLED | DELETION_REQUESTED (нет — считаем ACTIVE) */
  status?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHILD_BANDS = new Set(["6-9", "10-13"]);

export const billingUnavailable = () =>
  new AppError(503, "BILLING_UNAVAILABLE", "Оплата временно недоступна, повторите позже", { service: "billing" });
const notFound = () => new AppError(404, "NOT_FOUND", "Маршрут не найден");
const payerRequired = () =>
  new AppError(403, "PAYER_REQUIRED", "Оплата доступна владельцу аккаунта 18+ или 14–17 с согласием родителя");
const guardianConsentRequired = () =>
  new AppError(403, "GUARDIAN_CONSENT_REQUIRED", "Нужно согласие родителя на оплату — его можно дать в TilHero в Telegram");
const beneficiaryNotAllowed = () => new AppError(403, "BENEFICIARY_NOT_ALLOWED", "Получатель — только вы или ваш детский профиль");

/** Адрес клиента запроса сайта: Railway edge → Caddy web-pay → telegram-bff, т. е. глубина 2 справа в X-Forwarded-For
 *  (как admin-bff). Меньше двух адресов (локальный стенд) или не IP — req.ip. */
export function webClientIp(req: { headers: Record<string, string | string[] | undefined>; ip: string }): string {
  const raw = req.headers["x-forwarded-for"];
  const list = (Array.isArray(raw) ? raw.join(",") : (raw ?? ""))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const candidate = list.length >= 2 ? list[list.length - 2] : undefined;
  return candidate && isIP(candidate) ? candidate : req.ip;
}

/** Возраст аккаунта для сайта: дети 6–13 своего Telegram-аккаунта не имеют — «детский» возраст аккаунта не платит. */
function payerState(
  ageBand: string | null | undefined,
  consent: string | null | undefined,
): { band: "14-17" | "18+" | null; canPay: boolean; consentRequired: boolean } {
  const band = ageBand === "14-17" || ageBand === "18+" ? ageBand : null;
  const consentRequired = band === "14-17" && consent !== "granted";
  return { band, canPay: band === "18+" || (band === "14-17" && consent === "granted"), consentRequired };
}

export async function webRoutes(app: App, ctx: BffContext): Promise<void> {
  const cfg = ctx.config.webPay;
  if (!cfg.enabled) return;
  // вторая линия к config.ts: подмена OIDC Telegram — только dev/test
  if (ctx.config.isSecure && cfg.oidcBase !== TELEGRAM_OIDC_BASE) {
    throw new Error("telegram-bff: TELEGRAM_OIDC_BASE в stage/prod — только https://oauth.telegram.org");
  }
  const siteHost = new URL(cfg.origin).host.toLowerCase();
  const oidc = new TelegramOidc({
    base: cfg.oidcBase,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: `${cfg.origin}${CALLBACK_PATH}`,
  });
  const sessions = new WebSessions(cfg.sessionSecret, ctx.redis, ctx.config.redisKeyPrefix);
  const flowKey = (flowId: string) => `${ctx.config.redisKeyPrefix}web:oidc:${flowId}`;
  const { limiter } = ctx;

  /** Сессия из cookie: подпись, срок, отзыв. Нет / недействительна — 401 SESSION_EXPIRED. */
  async function sessionOf(cookieHeader: string | undefined): Promise<WebSession> {
    const s = await sessions.verify(parseCookies(cookieHeader).get(SESSION_COOKIE));
    if (await ctx.store(() => sessions.isRevoked(s.jti))) throw sessionExpired();
    return s;
  }

  async function revokeQuietly(s: WebSession): Promise<void> {
    await ctx.store(() => sessions.revoke(s));
  }

  /** Вызов billing от имени аккаунта, канал web: sub = lrn = аккаунт, chn = web (INTERNAL_API §3). */
  async function billing(
    s: WebSession,
    method: "GET" | "POST",
    path: string,
    extra: { body?: unknown; query?: Record<string, string | undefined>; idempotencyKey?: string } = {},
  ): Promise<{ status: number; body: unknown }> {
    if (!ctx.billing) throw billingUnavailable();
    try {
      return await ctx.billing.jsonWithStatus<unknown>(method, `/internal/v1/me/billing${path}`, {
        subject: s.accountId,
        claims: { lrn: s.accountId, chn: "web" },
        ...(extra.body !== undefined ? { body: extra.body } : {}),
        ...(extra.query ? { query: extra.query } : {}),
        ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}),
      });
    } catch (err) {
      if (err instanceof AppError && err.status === 503) throw billingUnavailable();
      throw err;
    }
  }

  /** Ответ billing → контракт; неожиданная форма — 503 BILLING_UNAVAILABLE (с записью в лог, без тела). */
  function decode<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof BadUpstream) {
        ctx.log.warn({ upstream: "billing", upstream_code: "UPSTREAM_BAD_RESPONSE", field: err.field }, "billing response does not match contract");
        throw billingUnavailable();
      }
      throw err;
    }
  }

  /** Аккаунт (identity-consent /internal/v1/me, sub = аккаунт). Удалён / удаляется — сессия отзывается, 401. */
  async function accountOf(s: WebSession): Promise<IdentityMe> {
    let me: IdentityMe;
    try {
      me = await ctx.domains.identity.get<IdentityMe>("/internal/v1/me", { subject: s.accountId });
    } catch (err) {
      if (err instanceof AppError && err.status === 404) {
        await revokeQuietly(s);
        throw sessionExpired();
      }
      throw err;
    }
    if (!me?.user || me.user.status === "DELETION_REQUESTED" || CHILD_BANDS.has(me.user.age_band ?? "")) {
      await revokeQuietly(s);
      throw sessionExpired();
    }
    return me;
  }

  await app.register(
    async (scope) => {
      const web = scope.withTypeProvider<TypeBoxTypeProvider>();
      // ---------------------------------------------------------------- охрана области
      web.addHook("onRequest", async (req, reply) => {
        if (ctx.config.isSecure && (req.headers.host ?? "").toLowerCase() !== siteHost) throw notFound();
        const kind = req.routeOptions.config?.web;
        if (kind !== "read" && kind !== "write") return;
        if (kind === "write" && req.headers.origin !== cfg.origin) throw csrfInvalid();
        const s = await sessionOf(req.headers.cookie);
        if (kind === "write" && !sessions.csrfOk(s.jti, req.headers["x-csrf-token"])) throw csrfInvalid();
        currentContext().userPid = pseudonymize(s.accountId);
        await limiter.enforce(kind === "write" ? "web.order" : "web.read", s.accountId);
        if (sessions.shouldRenew(s)) {
          const renewed = await sessions.renew(s);
          void reply.header("set-cookie", serializeCookie(SESSION_COOKIE, renewed.token, { maxAge: renewed.session.exp - renewed.session.iat, sameSite: "Strict" }));
        }
        req.webSession = s;
      });

      // любой 401 области (сессия нет / истекла / отозвана — в т. ч. после продления cookie в этом же запросе) удаляет
      // cookie сессии; прочие Set-Cookie этого ответа не нужны
      web.addHook("onSend", async (_req, reply, payload) => {
        if (reply.statusCode === 401) {
          reply.removeHeader("set-cookie");
          void reply.header("set-cookie", clearSessionCookie());
        }
        return payload;
      });

      // access-лог успешных ответов (ошибки ≥ 400 пишет общий хук app.ts): только шаблон маршрута, без query
      web.addHook("onResponse", async (req, reply) => {
        if (reply.statusCode >= 400) return;
        req.log.info(
          {
            method: req.method,
            route: req.routeOptions.url ?? "unmatched",
            status_code: reply.statusCode,
            duration_ms: Math.round(reply.elapsedTime * 10) / 10,
            outcome: "success",
          },
          "request completed",
        );
      });

      const sessionOfReq = (req: { webSession?: WebSession }): WebSession => {
        if (!req.webSession) throw sessionExpired();
        return req.webSession;
      };

      /** Ошибка входа: 302 на `/?login_error=<код>` (только код из WebLoginError, без ПДн), cookie попытки удалена. */
      const loginFailed = (reply: FastifyReply, code: WebLoginError, reason: string, log: FastifyBaseLogger) => {
        log.warn({ event: "web_login", outcome: code, reason }, "web-pay login failed");
        void reply.header("set-cookie", clearOidcCookie());
        return reply.redirect(`/?login_error=${code}`, 302);
      };

      // ---------------------------------------------------------------- вход
      web.get(
        "/auth/start",
        // HEAD не создаёт и не сжигает попыток входа
        { config: { web: "nav" }, exposeHeadRoute: false, schema: { hide: true } },
        async (req, reply) => {
          try {
            await limiter.enforce("web.auth_ip", () => limiter.hashedSubject("ip", webClientIp(req)));
            const p = newPkce();
            await ctx.store(() => ctx.redis.set(flowKey(p.flowId), JSON.stringify({ v: p.verifier }), "EX", OIDC_FLOW_SECONDS));
            void reply.header("set-cookie", serializeCookie(OIDC_COOKIE, p.flowId, { maxAge: OIDC_FLOW_SECONDS, sameSite: "Lax" }));
            return reply.redirect(oidc.authorizeUrl(p.state, p.challenge), 302);
          } catch (err) {
            return loginFailed(reply, "auth_failed", reasonOf(err), req.log);
          }
        },
      );

      web.get(
        "/auth/callback",
        { config: { web: "nav" }, exposeHeadRoute: false, schema: { hide: true } },
        async (req, reply) => {
          const q = (req.query ?? {}) as Record<string, unknown>;
          const flowId = parseCookies(req.headers.cookie).get(OIDC_COOKIE);
          try {
            await limiter.enforce("web.auth_ip", () => limiter.hashedSubject("ip", webClientIp(req)));
            if (!flowId || !FLOW_ID_RE.test(flowId)) throw new OidcFailure("no_flow_cookie");
            // попытка одноразовая: любой возврат на callback сжигает её (повтор state/code — отказ)
            const stored = await ctx.store(() => ctx.redis.getdel(flowKey(flowId)));
            if (!stored) throw new OidcFailure("flow_unknown_or_used");
            if (q.error !== undefined) throw new OidcFailure("provider_error");
            // state: если Telegram вернул его — обязан совпасть с cookie (INTERNAL_API §14 L1: возврат state не
            // описан в документации — без него попытку держат cookie + одноразовая запись + PKCE)
            if (q.state !== undefined) {
              if (typeof q.state !== "string" || !STATE_RE.test(q.state) || !safeEqual(flowIdOf(q.state), flowId)) {
                throw new OidcFailure("state_mismatch");
              }
            }
            if (typeof q.code !== "string" || !CODE_RE.test(q.code)) throw new OidcFailure("no_code");
            let verifier: string;
            try {
              verifier = String((JSON.parse(stored) as { v?: unknown }).v ?? "");
            } catch {
              throw new OidcFailure("flow_corrupted");
            }
            const telegramId = await oidc.login(q.code, verifier);

            let account: TelegramUserAccount;
            try {
              account = await ctx.domains.identity.get<TelegramUserAccount>(`/internal/v1/telegram-users/${telegramId}/account`);
            } catch (err) {
              if (err instanceof AppError && err.status === 404) return loginFailed(reply, "account_not_found", "no_account", req.log);
              throw err;
            }
            if (typeof account?.account_id !== "string" || !UUID_RE.test(account.account_id)) throw new OidcFailure("identity_bad_response");
            if (account.status === "DELETION_REQUESTED") return loginFailed(reply, "not_allowed", "deletion_requested", req.log);
            if (CHILD_BANDS.has(account.age_band ?? "")) return loginFailed(reply, "not_allowed", "kids", req.log);

            const { token, session } = await sessions.issue(account.account_id.toLowerCase());
            currentContext().userPid = pseudonymize(session.accountId);
            void reply.header("set-cookie", [
              clearOidcCookie(),
              serializeCookie(SESSION_COOKIE, token, { maxAge: session.exp - session.iat, sameSite: "Strict" }),
            ]);
            req.log.info({ event: "web_login", outcome: "success" }, "web-pay login");
            // адрес очищен от code/state: только корень сайта
            return reply.redirect("/", 302);
          } catch (err) {
            return loginFailed(reply, "auth_failed", reasonOf(err), req.log);
          }
        },
      );

      web.post(
        "/auth/logout",
        { config: { web: "logout" }, schema: { hide: true, response: { 204: Type.Null({ description: "Сессия отозвана" }), ...errorResponses(403) } } },
        async (req, reply) => {
          if (req.headers.origin !== cfg.origin) throw csrfInvalid();
          await limiter.enforce("web.auth_ip", () => limiter.hashedSubject("ip", webClientIp(req)));
          let s: WebSession | null = null;
          try {
            s = await sessionOf(req.headers.cookie);
          } catch (err) {
            if (!(err instanceof AppError && err.code === "SESSION_EXPIRED")) throw err;
          }
          if (s) {
            if (!sessions.csrfOk(s.jti, req.headers["x-csrf-token"])) throw csrfInvalid();
            await revokeQuietly(s);
            currentContext().userPid = pseudonymize(s.accountId);
          }
          void reply.header("set-cookie", [clearSessionCookie(), clearOidcCookie()]);
          return reply.code(204).send(null);
        },
      );

      // ---------------------------------------------------------------- профиль
      web.get(
        "/me",
        { config: { web: "read" }, schema: { hide: true, response: { 200: WebMeSchema, ...errorResponses(401) } } },
        async (req): Promise<WebMe> => {
          const s = sessionOfReq(req);
          const me = await accountOf(s);
          const p = payerState(me.user.age_band, me.user.guardian_consent);
          const list = Array.isArray(me.learners) ? me.learners : [];
          const self = list.find((l) => l.learner_id === me.user.user_id);
          return {
            account: { age_band: p.band, can_pay: p.canPay, consent_required: p.consentRequired },
            learners: [
              { learner_id: s.accountId, kind: "self", display: self?.display_name ?? me.user.display_name },
              ...list
                .filter((l) => l.kind === "child" && l.learner_id !== me.user.user_id)
                .map((l) => ({ learner_id: l.learner_id, kind: "child" as const, display: l.display_name })),
            ],
            csrf_token: sessions.csrf(s.jti),
          };
        },
      );

      // ---------------------------------------------------------------- billing (канал web)
      web.get(
        "/catalog",
        { config: { web: "read" }, schema: { hide: true, response: { 200: WebCatalogSchema, ...errorResponses(401) } } },
        async (req) => {
          const r = await billing(sessionOfReq(req), "GET", "/catalog");
          return decode(() => webCatalog(r.body));
        },
      );

      web.get(
        "/subscription",
        { config: { web: "read" }, schema: { hide: true, response: { 200: WebSubscriptionSchema, ...errorResponses(401) } } },
        async (req) => {
          const r = await billing(sessionOfReq(req), "GET", "/subscription");
          return decode(() => webSubscription(r.body));
        },
      );

      web.get(
        "/orders",
        {
          config: { web: "read" },
          schema: { hide: true, querystring: CursorQuerySchema, response: { 200: WebOrderPageSchema, ...errorResponses(401) } },
        },
        async (req) => {
          const r = await billing(sessionOfReq(req), "GET", "/orders", { query: { cursor: req.query.cursor } });
          return decode(() => webOrderPage(r.body));
        },
      );

      web.get(
        "/orders/:order_no",
        {
          config: { web: "read" },
          schema: { hide: true, params: OrderNoParamsSchema, response: { 200: WebOrderSchema, ...errorResponses(401, 404) } },
        },
        async (req) => {
          const r = await billing(sessionOfReq(req), "GET", `/orders/${req.params.order_no}`);
          const order = decode(() => webOrder(r.body));
          // заказ не сайта (Stars) в канале web — как чужой
          if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Заказ не найден");
          return order;
        },
      );

      web.post(
        "/orders",
        {
          config: { web: "write" },
          schema: {
            hide: true,
            body: WebOrderRequestSchema,
            response: { 200: WebOrderSchema, 201: WebOrderSchema, ...errorResponses(401, 403, 404, 409) },
          },
        },
        async (req, reply) => {
          const s = sessionOfReq(req);
          const key = idempotencyKey(req, true);
          // плательщик — и здесь (вторая линия к billing): ребёнок не платит, подросток — только с согласием родителя
          const me = await accountOf(s);
          const p = payerState(me.user.age_band, me.user.guardian_consent);
          if (!p.canPay) throw p.consentRequired ? guardianConsentRequired() : payerRequired();
          const body = req.body;
          if (body.beneficiary_id !== undefined) {
            const id = body.beneficiary_id.toLowerCase();
            const own = id === s.accountId || (Array.isArray(me.learners) && me.learners.some((l) => l.learner_id.toLowerCase() === id && l.kind === "child"));
            if (!own) throw beneficiaryNotAllowed();
          }
          const r = await billing(s, "POST", "/orders", {
            body: { ...body, ...(body.beneficiary_id ? { beneficiary_id: body.beneficiary_id.toLowerCase() } : {}) },
            ...(key ? { idempotencyKey: key } : {}),
          });
          const order = decode(() => webOrder(r.body));
          if (!order) {
            ctx.log.warn({ upstream: "billing", upstream_code: "UPSTREAM_BAD_RESPONSE", field: "order.channel" }, "billing returned a non-web order to the web channel");
            throw billingUnavailable();
          }
          return reply.code(r.status === 200 ? 200 : 201).send(order);
        },
      );

      web.post(
        "/orders/:order_no/cancel",
        {
          config: { web: "write" },
          schema: { hide: true, params: OrderNoParamsSchema, response: { 200: WebOrderSchema, ...errorResponses(401, 403, 404, 409) } },
        },
        async (req) => {
          const r = await billing(sessionOfReq(req), "POST", `/orders/${req.params.order_no}/cancel`);
          const order = decode(() => webOrder(r.body));
          if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Заказ не найден");
          return order;
        },
      );
    },
    { prefix: WEB_PREFIX },
  );
}

/** Код причины неудачного входа для лога (без значений). */
function reasonOf(err: unknown): string {
  if (err instanceof OidcFailure) return err.reason;
  if (err instanceof AppError) {
    if (err.code === "RATE_LIMITED") return "rate_limited";
    if (err.code === "RATE_LIMIT_UNAVAILABLE") return "rate_limit_unavailable";
    const service = typeof err.details.service === "string" ? err.details.service : "";
    return `${err.code.toLowerCase()}${service ? `:${service}` : ""}`;
  }
  return "internal";
}
