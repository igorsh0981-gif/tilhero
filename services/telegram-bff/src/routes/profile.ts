/**
 * Профиль, предпочтения, безопасность (PIN, сброс, биометрия), согласие, отключение и удаление аккаунта.
 * user_id — только из сессии (sub внутреннего JWT), никогда из тела/пути.
 */
import type {
  BiometricEnableResponse,
  ConsentState,
  DeletionResponse,
  PinResetRequestResponse,
  Preferences,
  SecurityState,
} from "@tilhero/contracts/bff";
import { loadAccount, type BffContext } from "../context.js";
import { BEARER, PIN_FORMAT, authOf, errorResponses, schemaErrors, type App } from "../http.js";
import {
  BiometricEnableResponseSchema,
  ConsentRequestSchema,
  ConsentStateSchema,
  DeletionRequestSchema,
  DeletionResponseSchema,
  DeparturesRequestSchema,
  PinRemoveRequestSchema,
  PinResetConfirmRequestSchema,
  PinResetRequestResponseSchema,
  PinSetRequestSchema,
  PreferencesPatchSchema,
  PreferencesSchema,
  ProfileSchema,
  SecurityStateSchema,
  SessionResponseSchema,
  SettingsPatchSchema,
} from "../schemas.js";
import { consentView, preferencesView, profileView, securityView, type IdentityMe } from "../views.js";
import { sessionResponse } from "./session.js";

const user = { access: "user" } as const;

export function profileRoutes(app: App, ctx: BffContext): void {
  const { domains, sessions } = ctx;
  const identity = domains.identity;
  const preferences = domains.preferences;

  /** Ответ identity «как GET /me» + предпочтения → Profile (предпочтения читаются параллельно с командой). */
  async function profileAfter(userId: string, command: Promise<IdentityMe>) {
    const [me, prefs] = await Promise.all([
      command,
      preferences.get<Preferences>("/internal/v1/me/preferences", { subject: userId }),
    ]);
    return profileView(me, prefs);
  }

  // ---------- Profile ----------
  app.get(
    "/v1/profile",
    {
      config: user,
      schema: {
        tags: ["profile"],
        summary: "Профиль: identity + предпочтения + уведомления (агрегация, домены опрашиваются параллельно)",
        security: BEARER,
        response: { 200: ProfileSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const { me, prefs } = await loadAccount(ctx, userId);
      return profileView(me, prefs);
    },
  );

  app.patch(
    "/v1/profile/settings",
    {
      config: user,
      schema: {
        tags: ["profile"],
        summary: "Язык и настройки уведомлений",
        security: BEARER,
        body: SettingsPatchSchema,
        response: { 200: ProfileSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      return profileAfter(userId, identity.patch<IdentityMe>("/internal/v1/me/settings", { subject: userId, body: req.body }));
    },
  );

  // ---------- Preferences ----------
  app.patch(
    "/v1/profile/preferences",
    {
      config: user,
      schemaErrorFormatter: schemaErrors([
        { context: "body", code: "PREFERENCES_INVALID", message: "Некорректные параметры предпочтений", withField: true },
      ]),
      schema: {
        tags: ["preferences"],
        summary: "Частичное обновление предпочтений (кроме вылетов)",
        description: "422 PREFERENCES_INVALID {field}; 409 PREFERENCES_VERSION_CONFLICT (оптимистическая блокировка по version).",
        security: BEARER,
        body: PreferencesPatchSchema,
        response: { 200: PreferencesSchema, ...errorResponses(401, 409, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const prefs = await preferences.patch<Preferences>("/internal/v1/me/preferences", { subject: userId, body: req.body });
      await ctx.home.invalidate(userId); // интересы/география изменились — персональная подборка Home устарела
      return preferencesView(prefs);
    },
  );

  app.put(
    "/v1/profile/departures",
    {
      config: user,
      schema: {
        tags: ["preferences"],
        summary: "Аэропорты вылета (IATA, максимум 10)",
        description: "422 AIRPORT_UNKNOWN {iata}.",
        security: BEARER,
        body: DeparturesRequestSchema,
        response: { 200: PreferencesSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const airports = req.body.airports.map((a) => a.toUpperCase());
      const prefs = await preferences.put<Preferences>("/internal/v1/me/departures", { subject: userId, body: { airports } });
      await ctx.home.invalidate(userId);
      return preferencesView(prefs);
    },
  );

  app.post(
    "/v1/profile/onboarding/complete",
    {
      config: user,
      schema: {
        tags: ["preferences"],
        summary: "Завершение онбординга (onboarding_completed_at)",
        security: BEARER,
        response: { 200: PreferencesSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const prefs = await preferences.post<Preferences>("/internal/v1/me/onboarding/complete", { subject: userId });
      await ctx.home.invalidate(userId);
      return preferencesView(prefs);
    },
  );

  // ---------- Security ----------
  app.put(
    "/v1/profile/security/pin",
    {
      schemaErrorFormatter: PIN_FORMAT,
      config: { ...user, pinLimited: true },
      schema: {
        tags: ["security"],
        summary: "Задать (без current_pin) или сменить (с current_pin) PIN",
        description:
          "401 PIN_INVALID {remaining}; 423 PIN_LOCKED {retry_after}; 422 PIN_FORMAT. " +
          "После успеха отзываются все ДРУГИЕ сессии пользователя (текущая остаётся).",
        security: BEARER,
        body: PinSetRequestSchema,
        response: { 200: SecurityStateSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const state = await identity.put<SecurityState>("/internal/v1/me/pin", { subject: auth.userId, body: req.body });
      const revoked = await ctx.store(() => sessions.revokeAllForUser(auth.userId, auth.sid));
      req.log.info({ revoked_sessions: revoked }, "pin set/changed, other sessions revoked");
      return securityView(state, true);
    },
  );

  app.delete(
    "/v1/profile/security/pin",
    {
      schemaErrorFormatter: PIN_FORMAT,
      config: { ...user, pinLimited: true },
      schema: {
        tags: ["security"],
        summary: "Выключить PIN (требует текущий PIN)",
        description: "401 PIN_INVALID {remaining}; 423 PIN_LOCKED {retry_after}.",
        security: BEARER,
        body: PinRemoveRequestSchema,
        response: { 200: SecurityStateSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const state = await identity.delete<SecurityState>("/internal/v1/me/pin", {
        subject: userId,
        body: { current_pin: req.body.current_pin },
      });
      return securityView(state, true);
    },
  );

  app.post(
    "/v1/profile/security/pin/reset-request",
    {
      config: { ...user, pinExempt: true },
      schema: {
        tags: ["security"],
        summary: "Запросить код сброса PIN (бот пришлёт 6-значный код в чат)",
        description: "429 PIN_RESET_TOO_OFTEN. Доступно и в сессии, ожидающей PIN.",
        security: BEARER,
        response: { 200: PinResetRequestResponseSchema, ...errorResponses(401) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const res = await identity.post<PinResetRequestResponse>("/internal/v1/me/pin/reset-request", { subject: userId });
      return { expires_in: res.expires_in };
    },
  );

  app.post(
    "/v1/profile/security/pin/reset-confirm",
    {
      schemaErrorFormatter: PIN_FORMAT,
      config: { ...user, pinExempt: true, pinLimited: "reset" },
      schema: {
        tags: ["security"],
        summary: "Подтвердить сброс кодом из бота и задать новый PIN",
        description:
          "401 RESET_CODE_INVALID {remaining}; 410 RESET_CODE_EXPIRED. Все сессии пользователя отзываются, " +
          "в ответе — новая сессия с pin=true. Доступно в сессии, ожидающей PIN.",
        security: BEARER,
        body: PinResetConfirmRequestSchema,
        response: { 200: SessionResponseSchema, ...errorResponses(401, 410) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      await identity.post<SecurityState>("/internal/v1/me/pin/reset-confirm", {
        subject: auth.userId,
        body: { code: req.body.code, new_pin: req.body.new_pin },
      });
      // Отзыв — сразу после смены PIN, до чтения профиля: сбой домена не должен оставить старые сессии живыми.
      const revoked = await ctx.store(() => sessions.revokeAllForUser(auth.userId));
      req.log.info({ revoked_sessions: revoked }, "pin reset, all sessions revoked");
      const { sid, refreshToken } = await ctx.store(() => sessions.create(auth.userId, true));
      const { me, prefs } = await loadAccount(ctx, auth.userId);
      void reply.header("cache-control", "no-store");
      return sessionResponse(ctx, { userId: auth.userId, sid, refreshToken, pinOk: true }, me, prefs);
    },
  );

  app.put(
    "/v1/profile/security/biometric",
    {
      config: user,
      schema: {
        tags: ["security"],
        summary: "Включить вход по биометрии (только при заданном PIN)",
        description: "409 PIN_REQUIRED, если PIN не задан. biometric_token Mini App сохраняет через BiometricManager.updateBiometricToken.",
        security: BEARER,
        response: { 200: BiometricEnableResponseSchema, ...errorResponses(401, 409, 423) },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      const res = await identity.put<BiometricEnableResponse>("/internal/v1/me/biometric", { subject: userId });
      void reply.header("cache-control", "no-store");
      return { biometric_token: res.biometric_token, security: securityView(res.security, true) };
    },
  );

  app.delete(
    "/v1/profile/security/biometric",
    {
      config: user,
      schema: {
        tags: ["security"],
        summary: "Выключить биометрию",
        security: BEARER,
        response: { 200: SecurityStateSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      const state = await identity.delete<SecurityState>("/internal/v1/me/biometric", { subject: userId });
      return securityView(state, true);
    },
  );

  // ---------- Consent ----------
  app.post(
    "/v1/profile/consent",
    {
      config: user,
      schemaErrorFormatter: schemaErrors([
        {
          context: "body",
          field: "age_confirmed_18_plus",
          code: "AGE_CONFIRMATION_REQUIRED",
          message: "Сервис доступен только с 18 лет — подтвердите возраст",
        },
      ]),
      schema: {
        tags: ["consent"],
        summary: "Принять политику (версия, цели, подтверждение 18+)",
        description: "422 AGE_CONFIRMATION_REQUIRED; 409 POLICY_VERSION_OUTDATED.",
        security: BEARER,
        body: ConsentRequestSchema,
        response: { 200: ConsentStateSchema, ...errorResponses(401, 409, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      return consentView(await identity.post<ConsentState>("/internal/v1/me/consent", { subject: userId, body: req.body }));
    },
  );

  app.delete(
    "/v1/profile/consent",
    {
      config: user,
      schema: {
        tags: ["consent"],
        summary: "Отозвать согласие (персонализация выключается)",
        security: BEARER,
        response: { 200: ConsentStateSchema, ...errorResponses(401, 423) },
      },
    },
    async (req) => {
      const { userId } = authOf(req);
      return consentView(await identity.delete<ConsentState>("/internal/v1/me/consent", { subject: userId }));
    },
  );

  // ---------- Account ----------
  for (const action of ["disable", "enable"] as const) {
    app.post(
      `/v1/profile/${action}`,
      {
        config: user,
        schema: {
          tags: ["account"],
          summary: action === "disable" ? "Отключить TilHero (статус DISABLED, уведомления выключены)" : "Включить TilHero",
          security: BEARER,
          response: { 200: ProfileSchema, ...errorResponses(401, 409, 423) },
        },
      },
      async (req) => {
        const { userId } = authOf(req);
        return profileAfter(userId, identity.post<IdentityMe>(`/internal/v1/me/${action}`, { subject: userId }));
      },
    );
  }

  app.post(
    "/v1/profile/delete-request",
    {
      schemaErrorFormatter: PIN_FORMAT,
      config: { ...user, pinLimited: true },
      schema: {
        tags: ["account"],
        summary: "Запрос удаления профиля (распределённая сага)",
        description:
          "Если PIN задан — нужен pin, иначе confirm_word «УДАЛИТЬ»|«DELETE». 202 → все сессии пользователя отозваны.",
        security: BEARER,
        body: DeletionRequestSchema,
        response: { 202: DeletionResponseSchema, ...errorResponses(401, 409, 423) },
      },
    },
    async (req, reply) => {
      const { userId } = authOf(req);
      const res = await identity.post<DeletionResponse>("/internal/v1/me/deletion-request", { subject: userId, body: req.body });
      const revoked = await ctx.store(() => sessions.revokeAllForUser(userId));
      req.log.info({ revoked_sessions: revoked }, "deletion requested, all sessions revoked");
      return reply.code(202).send({ request_id: res.request_id, status: res.status, domains: res.domains });
    },
  );
}
