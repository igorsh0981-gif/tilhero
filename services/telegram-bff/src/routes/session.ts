/**
 * Сессия Mini App: initData → access JWT (sub = аккаунт, lrn = активный ученик) + refresh; refresh с ротацией и
 * reuse-detection; подтверждение кода родителя / биометрии (новые токены с pin=true); переключение активного ученика
 * (родитель ↔ детский профиль); logout.
 */
import { createHash } from "node:crypto";
import { Type } from "@fastify/type-provider-typebox";
import type { SessionResponse } from "@tilhero/contracts/bff";
import { AppError, currentContext, pseudonymize } from "@tilhero/ts-common";
import { buildSession, hasLearner, learnerNotFound, loadLearner, loadMe } from "../account.js";
import { sessionRevoked } from "../auth.js";
import type { BffContext } from "../context.js";
import { BEARER, PIN_FORMAT, authOf, clientTimezone, errorResponses, type App } from "../http.js";
import {
  BiometricVerifyRequestSchema,
  PinVerifyRequestSchema,
  RefreshRequestSchema,
  SessionResponseSchema,
  SwitchLearnerRequestSchema,
  TelegramSessionRequestSchema,
} from "../schemas.js";
import { InitDataError, validateInitData, type TelegramUser } from "../telegramAuth.js";
import type { AccessClaims } from "../tokens.js";
import { startParamView, type TelegramLoginRequest, type TelegramLoginResponse } from "../views.js";

const TAG = ["session"];

export const refreshInvalid = () => new AppError(401, "REFRESH_INVALID", "Сессия истекла, войдите заново");
export const userDeleted = () => new AppError(410, "USER_DELETED", "Профиль удалён по запросу пользователя");
const parentPinMissing = () => new AppError(401, "PIN_INVALID", "Введите код родителя, чтобы выйти из детского профиля", { reason: "missing" });

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

/** После подтверждения кода родителя / биометрии: та же сессия и тот же ученик, новые токены с pin=true. */
async function confirmSession(ctx: BffContext, auth: AccessClaims, tz: string | undefined): Promise<SessionResponse> {
  return reissueSession(ctx, auth, auth.learnerId, true, tz);
}

/**
 * Новые токены в той же сессии (pin и/или активный ученик). Ответ собирается ДО перевыпуска refresh: сбой
 * identity / learning-plan → 503, а прежний refresh клиента остаётся рабочим.
 */
async function reissueSession(
  ctx: BffContext,
  auth: AccessClaims,
  learnerId: string,
  pinOk: boolean,
  tz: string | undefined,
  me?: TelegramLoginResponse,
): Promise<SessionResponse> {
  const account = me ?? (await loadMe(ctx, auth.accountId));
  const draft = await buildSession(ctx, { accountId: auth.accountId, learnerId, sid: auth.sid, refreshToken: "", pinOk, tz }, account);
  const re = await ctx.store(() => ctx.sessions.reissue(auth.sid, pinOk, learnerId));
  if (!re) throw sessionRevoked();
  return { ...draft, refresh_token: re.refreshToken };
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
          "initData одноразовый (INIT_DATA_ONE_TIME): повтор — 401 INIT_DATA_REPLAYED; Redis недоступен — 503. " +
          "Активный ученик новой сессии — сам аккаунт; start_param из initData возвращается в ответе. " +
          "401 INIT_DATA_INVALID | INIT_DATA_EXPIRED | INIT_DATA_REPLAYED; 410 USER_DELETED. Лимит 10/мин с IP.",
        body: TelegramSessionRequestSchema,
        response: { 200: SessionResponseSchema, ...errorResponses(401, 410) },
      },
    },
    async (req, reply) => {
      let user: TelegramUser;
      let signature: string;
      let startParam: string | undefined;
      try {
        ({ user, signature, startParam } = validateInitData(req.body.init_data, config.botToken, { maxAgeSeconds: config.initDataMaxAgeSeconds }));
      } catch (err) {
        if (!(err instanceof InitDataError)) throw err;
        req.log.info({ reason: err.reason }, "initData rejected");
        const message =
          err.code === "INIT_DATA_EXPIRED"
            ? "Данные запуска Telegram устарели — откройте приложение заново"
            : "Недействительные данные запуска Telegram";
        throw new AppError(401, err.code, message, { reason: err.reason });
      }

      // Одноразовость: серверная подпись канонической data-check-string помечается в Redis на срок действия initData
      // (+ допуск на часы). Перестановка параметров, регистр hash и другое кодирование дают тот же ключ.
      // Redis недоступен → 503 (fail closed); неудачный вход метку снимает.
      const replayKey = `${config.redisKeyPrefix}initdata:${createHash("sha256").update(signature).digest("hex")}`;
      if (config.initDataOneTime) {
        const fresh = await ctx.store(() => ctx.redis.set(replayKey, "1", "EX", config.initDataMaxAgeSeconds + 60, "NX"));
        if (fresh !== "OK") {
          req.log.warn({ reason: "replayed", event: "initdata_replayed" }, "initData rejected");
          const metricKey = `${config.redisKeyPrefix}metric:initdata:${Math.floor(Date.now() / 60_000)}`;
          void ctx.redis.multi().hincrby(metricKey, "replayed", 1).expire(metricKey, 3 * 3600).exec().catch(() => undefined);
          throw new AppError(401, "INIT_DATA_REPLAYED", "Данные запуска Telegram уже использованы — откройте приложение заново", {
            reason: "replayed",
          });
        }
      }
      try {
        const login = await domains.identity.post<TelegramLoginResponse>("/internal/v1/users/telegram-login", { body: loginBody(user) });
        const accountId = login.user.user_id;
        currentContext().userPid = pseudonymize(accountId);
        if (login.user.status === "DELETION_REQUESTED") throw userDeleted();

        const pinOk = !login.security.pin_enabled;
        const { sid, refreshToken } = await ctx.store(() => sessions.create(accountId, pinOk));
        try {
          const res = await buildSession(
            ctx,
            { accountId, learnerId: accountId, sid, refreshToken, pinOk, tz: clientTimezone(req) },
            login,
            startParamView(startParam),
          );
          req.log.info({ is_new: login.user.is_new === true, pin_required: !pinOk, has_start_param: res.start_param !== null }, "session created");
          void reply.header("cache-control", "no-store");
          return res;
        } catch (err) {
          await sessions.revoke(sid).catch(() => undefined); // learning-plan недоступен — сессия без ответа не остаётся жить
          throw err;
        }
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
          "отзывает всю сессию. Активный ученик сохраняется (детский профиль удалён — сам аккаунт). 401 REFRESH_INVALID.",
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
      const me = await loadMe(ctx, found.userId);
      if (me.user.status === "DELETION_REQUESTED") {
        await ctx.store(() => sessions.revokeAllForUser(found.userId));
        throw refreshInvalid();
      }
      const learnerId = hasLearner(me, found.learnerId) ? found.learnerId : found.userId;
      const pinOk = found.pin || !me.security.pin_enabled;
      // ответ собирается до ротации (learning-plan недоступен → 503, токен клиента цел)
      const draft = await buildSession(
        ctx,
        { accountId: found.userId, learnerId, sid: found.sid, refreshToken: "", pinOk, tz: clientTimezone(req) },
        me,
      );
      const rotated = await ctx.store(() => sessions.rotate(token, found.sid, found.userId, pinOk, learnerId));
      if (rotated.status === "reused") {
        await ctx.store(() => sessions.revoke(found.sid));
        req.log.warn({ event: "refresh_token_reuse" }, "concurrent refresh with the same token, session revoked");
        throw refreshInvalid();
      }
      if (rotated.status !== "ok") throw refreshInvalid();
      void reply.header("cache-control", "no-store");
      return { ...draft, refresh_token: rotated.refreshToken };
    },
  );

  app.post(
    "/v1/session/pin/verify",
    {
      schemaErrorFormatter: PIN_FORMAT,
      config: { access: "user", pinExempt: true, pinLimited: true },
      schema: {
        tags: TAG,
        summary: "Подтверждение сессии кодом родителя",
        description: "→ новые токены с pin=true. 401 PIN_INVALID {remaining}; 423 PIN_LOCKED {retry_after}; 422 PIN_FORMAT. Лимит 5/мин.",
        security: BEARER,
        body: PinVerifyRequestSchema,
        response: { 200: SessionResponseSchema, ...errorResponses(401, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      await domains.identity.post("/internal/v1/me/pin/verify", { subject: auth.accountId, body: { pin: req.body.pin } });
      void reply.header("cache-control", "no-store");
      return confirmSession(ctx, auth, clientTimezone(req));
    },
  );

  app.post(
    "/v1/session/biometric/verify",
    {
      config: { access: "user", pinExempt: true, pinLimited: true },
      schema: {
        tags: TAG,
        summary: "Подтверждение сессии биометрией (Telegram BiometricManager)",
        description: "→ новые токены с pin=true. 401 BIOMETRIC_INVALID; 423 PIN_LOCKED. Лимит 5/мин (общий с кодом родителя).",
        security: BEARER,
        body: BiometricVerifyRequestSchema,
        response: { 200: SessionResponseSchema, ...errorResponses(401, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      await domains.identity.post("/internal/v1/me/biometric/verify", {
        subject: auth.accountId,
        body: { biometric_token: req.body.biometric_token },
      });
      void reply.header("cache-control", "no-store");
      return confirmSession(ctx, auth, clientTimezone(req));
    },
  );

  app.post(
    "/v1/session/learner",
    {
      schemaErrorFormatter: PIN_FORMAT,
      config: { access: "user" },
      schema: {
        tags: TAG,
        summary: "Переключение активного ученика (родитель ↔ детский профиль)",
        description:
          "Ученик проверяется в identity-consent (GET /me/learners/{id} от имени аккаунта): только сам аккаунт или его " +
          "ребёнок, иначе 404 LEARNER_NOT_FOUND (чужой профиль неотличим от несуществующего). Выход ИЗ детского профиля " +
          "(в профиль родителя или другого ребёнка) при заданном коде родителя требует pin: нет или неверный — 401 " +
          "PIN_INVALID, блокировка — 423 PIN_LOCKED (лимит проверок 5/мин). → новые токены с lrn = learner_id.",
        security: BEARER,
        body: SwitchLearnerRequestSchema,
        response: { 200: SessionResponseSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const target = req.body.learner_id.toLowerCase();
      const [me, learner] = await Promise.all([
        loadMe(ctx, auth.accountId),
        target === auth.accountId ? Promise.resolve(null) : loadLearner(ctx, auth.accountId, target),
      ]);
      // ответ identity сверяется с запросом: не тот ученик или не ребёнок аккаунта — как чужой
      if (learner && (learner.learner_id?.toLowerCase() !== target || learner.kind !== "child" || !hasLearner(me, target))) {
        throw learnerNotFound();
      }
      const leavingChild = auth.learnerId !== auth.accountId && target !== auth.learnerId;
      if (leavingChild && me.security.pin_enabled) {
        const pin = req.body.pin;
        if (!pin) throw parentPinMissing();
        await ctx.limiter.enforce("tg.pin", auth.accountId);
        await domains.identity.post("/internal/v1/me/pin/verify", { subject: auth.accountId, body: { pin } });
      }
      const res = await reissueSession(ctx, auth, target, auth.pin, clientTimezone(req), me);
      req.log.info({ learner_kind: target === auth.accountId ? "self" : "child", parent_pin_checked: leavingChild && me.security.pin_enabled }, "active learner switched");
      void reply.header("cache-control", "no-store");
      return res;
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
