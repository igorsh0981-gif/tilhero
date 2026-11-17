/**
 * Сессия Mini App: initData → access JWT + refresh; refresh с ротацией и reuse-detection; подтверждение
 * PIN/биометрии (новые токены с pin=true); logout.
 */
import { createHash } from "node:crypto";
import { Type } from "@fastify/type-provider-typebox";
import type { Preferences, SessionResponse } from "@tilhero/contracts/bff";
import { AppError, currentContext, pseudonymize } from "@tilhero/ts-common";
import { sessionRevoked } from "../auth.js";
import { loadAccount, type BffContext } from "../context.js";
import { BEARER, PIN_FORMAT, authOf, errorResponses, type App } from "../http.js";
import {
  BiometricVerifyRequestSchema,
  PinVerifyRequestSchema,
  RefreshRequestSchema,
  SessionResponseSchema,
  TelegramSessionRequestSchema,
} from "../schemas.js";
import { InitDataError, validateInitData, type TelegramUser } from "../telegramAuth.js";
import type { AccessClaims } from "../tokens.js";
import { sessionView, type IdentityMe, type TelegramLoginRequest, type TelegramLoginResponse } from "../views.js";

const TAG = ["session"];

export const refreshInvalid = () => new AppError(401, "REFRESH_INVALID", "Сессия истекла, войдите заново");
export const userDeleted = () =>
  new AppError(410, "USER_DELETED", "Профиль удалён по запросу пользователя");

/** Обрезка по кодовым точкам (как len() в Python): Telegram допускает имена до 64 символов, identity — тоже. */
const clip = (s: string, max: number) => Array.from(s).slice(0, max).join("");

function loginBody(u: TelegramUser): TelegramLoginRequest {
  return {
    telegram_user_id: u.id,
    first_name: clip(u.first_name, 64),
    ...(u.username ? { username: clip(u.username, 64) } : {}),
    ...(u.last_name ? { last_name: clip(u.last_name, 64) } : {}),
    ...(u.language_code ? { language_code: u.language_code } : {}),
  };
}

export async function sessionResponse(
  ctx: BffContext,
  s: { userId: string; sid: string; refreshToken: string; pinOk: boolean },
  me: IdentityMe,
  prefs: Preferences,
): Promise<SessionResponse> {
  const accessToken = await ctx.tokens.issue({ userId: s.userId, sid: s.sid, pin: s.pinOk });
  return sessionView({ accessToken, refreshToken: s.refreshToken, expiresIn: ctx.tokens.ttlSeconds }, me, prefs, s.pinOk);
}

/** После подтверждения PIN/биометрии: та же сессия, новые токены с pin=true. */
async function confirmSession(ctx: BffContext, auth: AccessClaims): Promise<SessionResponse> {
  const { me, prefs } = await loadAccount(ctx, auth.userId);
  const refreshToken = await ctx.store(() => ctx.sessions.reissue(auth.sid, true));
  if (!refreshToken) throw sessionRevoked();
  return sessionResponse(ctx, { userId: auth.userId, sid: auth.sid, refreshToken, pinOk: true }, me, prefs);
}

export function sessionRoutes(app: App, ctx: BffContext): void {
  const { config, domains, sessions } = ctx;

  app.post(
    "/v1/session/telegram",
    {
      config: { access: "public", ipLimit: "session" },
      schema: {
        tags: TAG,
        summary: "Вход по Telegram initData",
        description:
          "Проверка подписи initData (HMAC «WebAppData»), auth_date не старше INIT_DATA_MAX_AGE_SECONDS (600 с). " +
          "initData одноразовый (INIT_DATA_ONE_TIME): повторное предъявление — 401 INIT_DATA_REPLAYED; Redis " +
          "недоступен — 503 (вход не выполняется). 401 INIT_DATA_INVALID | INIT_DATA_EXPIRED | INIT_DATA_REPLAYED; " +
          "410 USER_DELETED. Лимит 10/мин с IP.",
        body: TelegramSessionRequestSchema,
        response: { 200: SessionResponseSchema, ...errorResponses(401, 410) },
      },
    },
    async (req, reply) => {
      let user: TelegramUser;
      let signature: string;
      try {
        ({ user, signature } = validateInitData(req.body.init_data, config.botToken, { maxAgeSeconds: config.initDataMaxAgeSeconds }));
      } catch (err) {
        if (!(err instanceof InitDataError)) throw err;
        req.log.info({ reason: err.reason }, "initData rejected");
        const message =
          err.code === "INIT_DATA_EXPIRED"
            ? "Данные запуска Telegram устарели — откройте приложение заново"
            : "Недействительные данные запуска Telegram";
        throw new AppError(401, err.code, message, { reason: err.reason });
      }

      // О-1 (спринт 9): одноразовость — подпись initData помечается в Redis на срок его действия (+ допуск на часы);
      // Redis недоступен → 503 через ctx.store (fail closed, как остальной вход); неудачный вход метку снимает.
      // Ключ — серверная подпись канонической data-check-string, а не сырая строка: перестановка параметров, регистр
      // hash и другое кодирование того же initData дают тот же ключ (ревью спринта 9)
      const replayKey = `${config.redisKeyPrefix}initdata:${createHash("sha256").update(signature).digest("hex")}`;
      if (config.initDataOneTime) {
        const fresh = await ctx.store(() => ctx.redis.set(replayKey, "1", "EX", config.initDataMaxAgeSeconds + 60, "NX"));
        if (fresh !== "OK") {
          // метрика (ревью спринта 9): событие лога + минутный счётчик в Redis `<prefix>metric:initdata:<минута>`
          // (поле replayed, TTL 3 ч) — рост значит, что Mini App где-то предъявляет initData повторно
          req.log.warn({ reason: "replayed", event: "initdata_replayed" }, "initData rejected");
          const metricKey = `${config.redisKeyPrefix}metric:initdata:${Math.floor(Date.now() / 60_000)}`;
          void ctx.redis.multi().hincrby(metricKey, "replayed", 1).expire(metricKey, 3 * 3600).exec().catch(() => undefined);
          throw new AppError(401, "INIT_DATA_REPLAYED", "Данные запуска Telegram уже использованы — откройте приложение заново", {
            reason: "replayed",
          });
        }
      }
      try {
        const login = await domains.identity.post<TelegramLoginResponse>("/internal/v1/users/telegram-login", {
          body: loginBody(user),
        });
        const userId = login.user.user_id;
        currentContext().userPid = pseudonymize(userId);
        if (login.user.status === "DELETION_REQUESTED") throw userDeleted();

        const prefs = await domains.preferences.get<Preferences>("/internal/v1/me/preferences", { subject: userId });
        const pinOk = !login.security.pin_enabled;
        const { sid, refreshToken } = await ctx.store(() => sessions.create(userId, pinOk));
        req.log.info({ is_new: login.user.is_new === true, pin_required: !pinOk }, "session created");
        void reply.header("cache-control", "no-store");
        return sessionResponse(ctx, { userId, sid, refreshToken, pinOk }, login, prefs);
      } catch (err) {
        // вход не состоялся (домен недоступен, профиль удаляется) — тот же initData можно предъявить снова
        if (config.initDataOneTime) await ctx.redis.del(replayKey).catch(() => undefined);
        throw err;
      }
    },
  );

  app.post(
    "/v1/session/refresh",
    {
      config: { access: "public", ipLimit: "public" },
      schema: {
        tags: TAG,
        summary: "Обновление токенов (ротация refresh)",
        description:
          "Каждый refresh-токен одноразовый: в ответе — новый. Повторное предъявление использованного токена " +
          "отзывает всю сессию. Параллельные refresh одним токеном клиент должен сериализовать. 401 REFRESH_INVALID.",
        body: RefreshRequestSchema,
        response: { 200: SessionResponseSchema, ...errorResponses(401) },
      },
    },
    async (req, reply) => {
      const token = req.body.refresh_token;
      const found = await ctx.store(() => sessions.lookup(token));
      if (found.status === "reused") {
        currentContext().userPid = pseudonymize(found.userId);
        await ctx.store(() => sessions.revoke(found.sid));
        req.log.warn({ event: "refresh_token_reuse" }, "refresh token reuse detected, session revoked");
        throw refreshInvalid();
      }
      if (found.status !== "active") throw refreshInvalid();
      currentContext().userPid = pseudonymize(found.userId);

      // Сначала домены, потом ротация: сбой домена не «сжигает» refresh-токен клиента.
      const { me, prefs } = await loadAccount(ctx, found.userId);
      if (me.user.status === "DELETION_REQUESTED") {
        await ctx.store(() => sessions.revokeAllForUser(found.userId));
        throw refreshInvalid();
      }
      const pinOk = found.pin || !me.security.pin_enabled;
      const rotated = await ctx.store(() => sessions.rotate(token, found.sid, found.userId, pinOk));
      if (rotated.status === "reused") {
        await ctx.store(() => sessions.revoke(found.sid));
        req.log.warn({ event: "refresh_token_reuse" }, "concurrent refresh with the same token, session revoked");
        throw refreshInvalid();
      }
      if (rotated.status !== "ok") throw refreshInvalid();
      void reply.header("cache-control", "no-store");
      return sessionResponse(
        ctx,
        { userId: found.userId, sid: found.sid, refreshToken: rotated.refreshToken, pinOk },
        me,
        prefs,
      );
    },
  );

  app.post(
    "/v1/session/pin/verify",
    {
      schemaErrorFormatter: PIN_FORMAT,
      config: { access: "user", pinExempt: true, pinLimited: true },
      schema: {
        tags: TAG,
        summary: "Подтверждение сессии PIN-кодом",
        description: "→ новые токены с pin=true. 401 PIN_INVALID {remaining}; 423 PIN_LOCKED {retry_after}. Лимит 5/мин.",
        security: BEARER,
        body: PinVerifyRequestSchema,
        response: { 200: SessionResponseSchema, ...errorResponses(401, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      await domains.identity.post("/internal/v1/me/pin/verify", { subject: auth.userId, body: { pin: req.body.pin } });
      void reply.header("cache-control", "no-store");
      return confirmSession(ctx, auth);
    },
  );

  app.post(
    "/v1/session/biometric/verify",
    {
      config: { access: "user", pinExempt: true, pinLimited: true },
      schema: {
        tags: TAG,
        summary: "Подтверждение сессии биометрией (Telegram BiometricManager)",
        description: "→ новые токены с pin=true. 401 BIOMETRIC_INVALID; 423 PIN_LOCKED. Лимит 5/мин (общий с PIN).",
        security: BEARER,
        body: BiometricVerifyRequestSchema,
        response: { 200: SessionResponseSchema, ...errorResponses(401, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      await domains.identity.post("/internal/v1/me/biometric/verify", {
        subject: auth.userId,
        body: { biometric_token: req.body.biometric_token },
      });
      void reply.header("cache-control", "no-store");
      return confirmSession(ctx, auth);
    },
  );

  app.post(
    "/v1/session/logout",
    {
      config: { access: "user", pinExempt: true },
      schema: {
        tags: TAG,
        summary: "Выход: отзыв текущей сессии (refresh и access)",
        security: BEARER,
        response: { 204: Type.Null({ description: "Сессия завершена" }), ...errorResponses(401) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      await ctx.store(() => sessions.revoke(auth.sid));
      req.log.info("session revoked by logout");
      return reply.code(204).send(null);
    },
  );
}
