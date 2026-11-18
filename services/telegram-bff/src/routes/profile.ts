/**
 * Профиль (аккаунт + активный ученик), настройки уведомлений по категориям и тихие часы, возраст, согласия и политика,
 * код родителя (PIN) и биометрия, удаление аккаунта.
 * identity-consent вызывается от имени аккаунта (sub); user_id — только из сессии, никогда из тела/пути.
 */
import type { ConsentState, DeletionResponse, PinResetRequestResponse, PolicyDocument, Profile, SecurityState } from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import { buildSession, learnersOf, learnersState, loadLearner, loadMe, notificationsFor } from "../account.js";
import type { BffContext } from "../context.js";
import {
  BEARER,
  PIN_FORMAT,
  authOf,
  clientTimezone,
  errorResponses,
  forbidInChildProfile,
  schemaErrors,
  type App,
} from "../http.js";
import {
  AgeRequestSchema,
  BiometricEnableResponseSchema,
  ConsentRequestSchema,
  ConsentStateSchema,
  DeletionRequestSchema,
  DeletionResponseSchema,
  PinRemoveRequestSchema,
  PinResetConfirmRequestSchema,
  PinResetRequestResponseSchema,
  PinSetRequestSchema,
  PolicyDocumentSchema,
  PolicyQuerySchema,
  ProfileSchema,
  SecurityStateSchema,
  SessionResponseSchema,
  SettingsPatchSchema,
  type BiometricEnableResponse,
} from "../schemas.js";
import type { AccessClaims } from "../tokens.js";
import { consentView, profileView, securityView, type IdentityLearner, type IdentityMe } from "../views.js";

const user = { access: "user" } as const;

/** Ошибки тихих часов в теле → 422 QUIET_HOURS_INVALID (контракт), остальное — VALIDATION_ERROR. */
const SETTINGS_ERRORS = schemaErrors([
  { context: "body", field: "notifications.quiet_hours", code: "QUIET_HOURS_INVALID", message: "Тихие часы — время HH:MM" },
]);

/** Profile после команды identity (MeResponse): ученики с онбордингом из learning-plan, настройки активного ученика.
 *  tz — зона клиента (X-Timezone) для плана ученика, которого ещё нет (детский профиль сразу после создания). */
export async function profileFor(
  ctx: BffContext,
  auth: AccessClaims,
  tz: string | undefined,
  me: IdentityMe,
  child?: IdentityLearner | null,
): Promise<Profile> {
  const inChild = auth.learnerId !== auth.accountId;
  const [ls, detail] = await Promise.all([
    learnersState(ctx, learnersOf(me), auth.learnerId, { tz }),
    // настройки детского профиля — из identity (GET /me/learners/{id}), если ещё не получены командой
    inChild && !child ? loadLearner(ctx, auth.accountId, auth.learnerId) : Promise.resolve(child ?? null),
  ]);
  return profileView(me, ls, notificationsFor(me, auth.learnerId, detail));
}

export function profileRoutes(app: App, ctx: BffContext): void {
  const { domains, sessions } = ctx;
  const identity = domains.identity;

  // ---------- Profile ----------
  app.get(
    "/v1/profile",
    {
      config: user,
      schema: {
        tags: ["profile"],
        summary: "Профиль: аккаунт, активный ученик, ученики, код родителя, согласие, уведомления активного ученика",
        description: "identity-consent (sub = аккаунт) + learning-plan (онбординг каждого ученика, sub = ученик). Сбой любого домена — его ошибка, частичного профиля нет.",
        security: BEARER,
        response: { 200: ProfileSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      return profileFor(ctx, auth, clientTimezone(req), await loadMe(ctx, auth.accountId));
    },
  );

  app.patch(
    "/v1/profile/settings",
    {
      config: user,
      schemaErrorFormatter: SETTINGS_ERRORS,
      schema: {
        tags: ["profile"],
        summary: "Язык интерфейса аккаунта, имя ребёнка, уведомления по категориям, тихие часы, часовой пояс",
        description:
          "locale — настройка аккаунта (identity /me/settings). notifications — активного ученика: аккаунт — /me/settings, " +
          "детский профиль — /me/learners/{id} (адресат сообщений — родитель). display_name — только в детском профиле " +
          "(имя ребёнка), в профиле аккаунта → 422 VALIDATION_ERROR. 422 QUIET_HOURS_INVALID.",
        security: BEARER,
        body: SettingsPatchSchema,
        response: { 200: ProfileSchema, ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { locale, display_name: displayName, notifications } = req.body;
      if (auth.learnerId === auth.accountId) {
        if (displayName !== undefined) {
          throw new AppError(422, "VALIDATION_ERROR", "Имя меняется только у детского профиля", {
            in: "body",
            field: "display_name",
            errors: [],
          });
        }
        const body = { ...(locale !== undefined ? { locale } : {}), ...(notifications !== undefined ? { notifications } : {}) };
        const me = await identity.patch<IdentityMe>("/internal/v1/me/settings", { subject: auth.accountId, body });
        return profileFor(ctx, auth, clientTimezone(req), me);
      }
      // детский профиль: сначала ребёнок (ошибка — язык аккаунта не меняется), затем язык аккаунта
      let child: IdentityLearner | null = null;
      if (displayName !== undefined || notifications !== undefined) {
        child = await identity.patch<IdentityLearner>(`/internal/v1/me/learners/${auth.learnerId}`, {
          subject: auth.accountId,
          body: { ...(displayName !== undefined ? { display_name: displayName } : {}), ...(notifications !== undefined ? { settings: notifications } : {}) },
        });
      }
      const me =
        locale !== undefined
          ? await identity.patch<IdentityMe>("/internal/v1/me/settings", { subject: auth.accountId, body: { locale } })
          : await loadMe(ctx, auth.accountId);
      return profileFor(ctx, auth, clientTimezone(req), me, child);
    },
  );

  app.put(
    "/v1/profile/age",
    {
      config: user,
      schema: {
        tags: ["profile"],
        summary: "Возраст аккаунта: 14-17 или 18+ (ребёнок 6–13 — детский профиль родителя)",
        description:
          "14-17 → guardian_consent=pending (необязательные функции выключены до согласия родителя). 409 AGE_ALREADY_SET; " +
          "403 ADULT_REQUIRED в детском профиле (возраст — свойство аккаунта родителя).",
        security: BEARER,
        body: AgeRequestSchema,
        response: { 200: ProfileSchema, ...errorResponses(401, 403, 409, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      const me = await identity.put<IdentityMe>("/internal/v1/me/age", { subject: auth.accountId, body: { age_band: req.body.age_band } });
      return profileFor(ctx, auth, clientTimezone(req), me);
    },
  );

  // ---------- Consent / legal ----------
  app.get(
    "/v1/legal/policy",
    {
      config: { access: "public", ipLimit: "public" },
      schema: {
        tags: ["consent"],
        summary: "Политика обработки данных (публично, RU/UZ)",
        querystring: PolicyQuerySchema,
        response: { 200: PolicyDocumentSchema, ...errorResponses() },
      },
    },
    async (req, reply) => {
      const doc = await identity.get<PolicyDocument>("/internal/v1/legal/policy", { query: { lang: req.query.lang ?? "ru" } });
      void reply.header("cache-control", "public, max-age=300");
      return doc;
    },
  );

  app.post(
    "/v1/profile/consent",
    {
      config: user,
      schema: {
        tags: ["consent"],
        summary: "Принять политику: версия и цели (обязательные terms, privacy, learning; необязательные — по выбору)",
        description:
          "409 POLICY_VERSION_OUTDATED; 422 CONSENT_REQUIRED_PURPOSES {missing}; 403 GUARDIAN_CONSENT_REQUIRED — подросток " +
          "выбирает необязательные цели до согласия родителя. Отказ от записи голоса онбординг не блокирует. Повторный " +
          "POST с другим набором необязательных целей — новая запись согласия. 403 ADULT_REQUIRED в детском профиле " +
          "(согласия аккаунта меняет родитель в своём профиле).",
        security: BEARER,
        body: ConsentRequestSchema,
        response: { 200: ConsentStateSchema, ...errorResponses(401, 403, 409, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      return consentView(await identity.post<ConsentState>("/internal/v1/me/consent", { subject: auth.accountId, body: req.body }));
    },
  );

  app.delete(
    "/v1/profile/consent",
    {
      config: user,
      schema: {
        tags: ["consent"],
        summary: "Отозвать согласие",
        description: "403 ADULT_REQUIRED в детском профиле.",
        security: BEARER,
        response: { 200: ConsentStateSchema, ...errorResponses(401, 403, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      return consentView(await identity.delete<ConsentState>("/internal/v1/me/consent", { subject: auth.accountId }));
    },
  );

  // ---------- Код родителя (PIN) и биометрия ----------
  app.put(
    "/v1/profile/security/pin",
    {
      schemaErrorFormatter: PIN_FORMAT,
      config: { ...user, pinLimited: true },
      schema: {
        tags: ["security"],
        summary: "Задать (без current_pin) или сменить (с current_pin) код родителя",
        description:
          "401 PIN_INVALID {remaining}; 423 PIN_LOCKED {retry_after}; 422 PIN_FORMAT; 403 ADULT_REQUIRED в детском профиле. " +
          "После успеха отзываются все ДРУГИЕ сессии аккаунта (текущая остаётся).",
        security: BEARER,
        body: PinSetRequestSchema,
        response: { 200: SecurityStateSchema, ...errorResponses(401, 403, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      const state = await identity.put<SecurityState>("/internal/v1/me/pin", { subject: auth.accountId, body: req.body });
      const revoked = await ctx.store(() => sessions.revokeAllForUser(auth.accountId, auth.sid));
      req.log.info({ revoked_sessions: revoked }, "parent pin set/changed, other sessions revoked");
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
        summary: "Выключить код родителя (нужен текущий код)",
        description: "401 PIN_INVALID {remaining}; 423 PIN_LOCKED {retry_after}; 403 ADULT_REQUIRED в детском профиле.",
        security: BEARER,
        body: PinRemoveRequestSchema,
        response: { 200: SecurityStateSchema, ...errorResponses(401, 403, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      const state = await identity.delete<SecurityState>("/internal/v1/me/pin", {
        subject: auth.accountId,
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
        summary: "Запросить код сброса (бот пришлёт 6-значный код в чат аккаунта)",
        description: "429 PIN_RESET_TOO_OFTEN; 403 ADULT_REQUIRED в детском профиле. Доступно и в сессии, ожидающей код родителя.",
        security: BEARER,
        response: { 200: PinResetRequestResponseSchema, ...errorResponses(401, 403) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      const res = await identity.post<PinResetRequestResponse>("/internal/v1/me/pin/reset-request", { subject: auth.accountId });
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
        summary: "Подтвердить сброс кодом из бота и задать новый код родителя",
        description:
          "401 RESET_CODE_INVALID {remaining}; 410 RESET_CODE_EXPIRED; 403 ADULT_REQUIRED в детском профиле. Все сессии " +
          "аккаунта отзываются, в ответе — новая сессия (pin=true, активный ученик — сам аккаунт).",
        security: BEARER,
        body: PinResetConfirmRequestSchema,
        response: { 200: SessionResponseSchema, ...errorResponses(401, 403, 410) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      await identity.post<SecurityState>("/internal/v1/me/pin/reset-confirm", {
        subject: auth.accountId,
        body: { code: req.body.code, new_pin: req.body.new_pin },
      });
      // Отзыв — сразу после смены кода, до чтения профиля: сбой домена не должен оставить старые сессии живыми.
      const revoked = await ctx.store(() => sessions.revokeAllForUser(auth.accountId));
      req.log.info({ revoked_sessions: revoked }, "parent pin reset, all sessions revoked");
      const { sid, refreshToken } = await ctx.store(() => sessions.create(auth.accountId, true));
      const me = await loadMe(ctx, auth.accountId);
      void reply.header("cache-control", "no-store");
      return buildSession(ctx, { accountId: auth.accountId, learnerId: auth.accountId, sid, refreshToken, pinOk: true, tz: clientTimezone(req) }, me);
    },
  );

  app.put(
    "/v1/profile/security/biometric",
    {
      config: user,
      schema: {
        tags: ["security"],
        summary: "Включить вход по биометрии (только при заданном коде родителя)",
        description: "409 PIN_REQUIRED, если код не задан; 403 ADULT_REQUIRED в детском профиле. biometric_token Mini App сохраняет через BiometricManager.",
        security: BEARER,
        response: { 200: BiometricEnableResponseSchema, ...errorResponses(401, 403, 409, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      const res = await identity.put<BiometricEnableResponse>("/internal/v1/me/biometric", { subject: auth.accountId });
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
        response: { 200: SecurityStateSchema, ...errorResponses(401, 403, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      const state = await identity.delete<SecurityState>("/internal/v1/me/biometric", { subject: auth.accountId });
      return securityView(state, true);
    },
  );

  // ---------- Удаление ----------
  app.post(
    "/v1/profile/delete-request",
    {
      schemaErrorFormatter: PIN_FORMAT,
      config: { ...user, pinLimited: true },
      schema: {
        tags: ["account"],
        summary: "Запрос удаления аккаунта и всех детских профилей (распределённая сага)",
        description:
          "Если код родителя задан — нужен pin, иначе confirm_word «УДАЛИТЬ» | «OʻCHIRISH». 202 → все сессии аккаунта " +
          "отозваны. learners — сколько профилей удаляется (аккаунт + дети). 403 ADULT_REQUIRED в детском профиле.",
        security: BEARER,
        body: DeletionRequestSchema,
        response: { 202: DeletionResponseSchema, ...errorResponses(401, 403, 409, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      const res = await identity.post<DeletionResponse>("/internal/v1/me/deletion-request", { subject: auth.accountId, body: req.body });
      const revoked = await ctx.store(() => sessions.revokeAllForUser(auth.accountId));
      req.log.info({ revoked_sessions: revoked, learners: res.learners }, "deletion requested, all sessions revoked");
      return reply.code(202).send({ request_id: res.request_id, status: res.status, domains: res.domains, learners: res.learners });
    },
  );
}
