/**
 * Ученики аккаунта и детские профили, согласие родителя для 14–17 (ссылка, решение, список решений родителя и отзыв),
 * приглашения и семья.
 * identity-consent и social вызываются от имени аккаунта (sub); активный ученик влияет только на is_active / is_me
 * и на запреты детского профиля (приглашения — 403 INVITES_NOT_ALLOWED, команды взрослого — 403 ADULT_REQUIRED).
 */
import { Type } from "@fastify/type-provider-typebox";
import type {
  Family,
  GuardianConsentGrant,
  GuardianConsentLink,
  GuardianConsentPreview,
  Invite,
  InviteAcceptResult,
  InvitePreview,
  LearnerSummary,
  Page,
} from "@tilhero/contracts/bff";
import { learnersState, loadPlan } from "../account.js";
import type { BffContext } from "../context.js";
import {
  BEARER,
  authOf,
  clientTimezone,
  errorResponses,
  forbidInChildProfile,
  idempotencyKey,
  schemaErrors,
  type App,
} from "../http.js";
import {
  CreateChildRequestSchema,
  CreateInviteRequestSchema,
  FamilySchema,
  GuardianConsentGrantSchema,
  GuardianConsentLinkSchema,
  GuardianConsentPreviewSchema,
  GuardianTokenParamsSchema,
  IdempotencyHeadersSchema,
  InviteAcceptResultSchema,
  InviteOpenRequestSchema,
  InvitePageSchema,
  InviteParamsSchema,
  InvitePreviewSchema,
  InviteSchema,
  LearnerParamsSchema,
  LearnerSummarySchema,
  PageQuerySchema,
  TeenParamsSchema,
  VoiceConsentRequestSchema,
  itemsOf,
} from "../schemas.js";
import { orNull, upstreamUnavailable } from "../upstream.js";
import { familyView, guardianGrantView, learnerView, type IdentityLearner } from "../views.js";

const user = { access: "user" } as const;

/** Неверный формат токена согласия — тот же ответ, что и для неизвестного. */
const guardianNotFound = schemaErrors([
  { context: "params", status: 404, code: "GUARDIAN_CONSENT_NOT_FOUND", message: "Ссылка согласия не найдена" },
]);
/** Неверный формат teen_user_id — как подросток, за которого этот родитель не решал. */
const grantNotFound = schemaErrors([
  { context: "params", status: 404, code: "GUARDIAN_CONSENT_NOT_FOUND", message: "Согласие не найдено" },
]);
/** Неверный invite_id / токен приглашения — как несуществующее приглашение (пустой токен — 422). */
const inviteNotFound = schemaErrors([
  { context: "params", status: 404, code: "INVITE_NOT_FOUND", message: "Приглашение не найдено" },
  { context: "body", field: "token", keywords: ["pattern"], status: 404, code: "INVITE_NOT_FOUND", message: "Приглашение не найдено" },
]);

/** Неверный формат learner_id — как чужой ребёнок (404 LEARNER_NOT_FOUND). */
const learnerNotFound = schemaErrors([
  { context: "params", status: 404, code: "LEARNER_NOT_FOUND", message: "Профиль ученика не найден" },
]);

/** Токен ссылки согласия от identity (base64url) — без префикса gc_ укладывается в 64 символа start_param. */
const GC_TOKEN_RE = /^[A-Za-z0-9_-]{16,61}$/;

export function familyRoutes(app: App, ctx: BffContext): void {
  const { identity, social } = ctx.domains;

  // ---------- Ученики ----------
  app.get(
    "/v1/learners",
    {
      config: user,
      schema: {
        tags: ["learners"],
        summary: "Ученики аккаунта: сам аккаунт и детские профили (онбординг — из learning-plan)",
        security: BEARER,
        response: { 200: itemsOf(LearnerSummarySchema), ...errorResponses(401, 404, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const { items } = await identity.get<{ items: IdentityLearner[] }>("/internal/v1/me/learners", { subject: auth.accountId });
      const list = (Array.isArray(items) ? items : []).map((l) => (l.learner_id === auth.accountId ? { ...l, kind: "self" as const } : l));
      const { learners } = await learnersState(ctx, list, auth.learnerId, { tz: clientTimezone(req) });
      return { items: learners };
    },
  );

  app.post(
    "/v1/learners",
    {
      config: user,
      schema: {
        tags: ["learners"],
        summary: "Создать детский профиль 6–13 (только аккаунт 18+)",
        description:
          "403 ADULT_REQUIRED (аккаунт не 18+ или запрос из детского профиля); 409 CHILDREN_LIMIT (5). Idempotency-Key (UUID) " +
          "необязателен, пробрасывается в identity-consent.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: CreateChildRequestSchema,
        response: { 201: LearnerSummarySchema, ...errorResponses(401, 403, 409, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      const key = idempotencyKey(req, false);
      const child = await identity.post<IdentityLearner>("/internal/v1/me/learners", {
        subject: auth.accountId,
        body: { display_name: req.body.display_name, age_band: req.body.age_band },
        ...(key ? { idempotencyKey: key } : {}),
      });
      const view: LearnerSummary = learnerView({ ...child, kind: "child" }, auth.learnerId, false);
      return reply.code(201).send(view);
    },
  );

  // ---------- Спринт 5: согласие опекуна на запись голоса детского профиля ----------
  app.put(
    "/v1/learners/:learner_id/voice-consent",
    {
      config: user,
      schemaErrorFormatter: learnerNotFound,
      schema: {
        tags: ["learners"],
        summary: "Разрешить или запретить запись голоса (оценка произношения) детскому профилю — решение опекуна",
        description:
          "Только из профиля аккаунта 18+ со своим действующим согласием (identity-consent); из детского профиля — 403 ADULT_REQUIRED " +
          "до вызова identity. Повтор того же значения — без новой записи согласия. 404 LEARNER_NOT_FOUND — не свой ребёнок " +
          "(и свой аккаунт: своё согласие — POST /v1/profile/consent с целью voice_recording); 403 CONSENT_REQUIRED {purpose}. " +
          "onboarding_completed — из learning-plan; план недоступен — из identity (иначе false), согласие уже сохранено.",
        security: BEARER,
        params: LearnerParamsSchema,
        body: VoiceConsentRequestSchema,
        response: { 200: LearnerSummarySchema, ...errorResponses(401, 403, 404, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      const childId = req.params.learner_id.toLowerCase();
      const child = await identity.put<IdentityLearner>(`/internal/v1/me/learners/${childId}/voice-consent`, {
        subject: auth.accountId,
        body: { granted: req.body.granted },
      });
      if (!child || typeof child !== "object" || child.learner_id?.toLowerCase() !== childId) throw upstreamUnavailable("identity-consent");
      // согласие уже сохранено в identity: сбой learning-plan ответ не валит — онбординг из identity (иначе false)
      let onboarded = child.onboarding_completed === true;
      try {
        onboarded = (await loadPlan(ctx, child.learner_id, clientTimezone(req))).onboarding_completed_at != null;
      } catch (err) {
        const e = err as { status?: number; code?: string };
        ctx.log.warn({ upstream: "learning-plan", check: "voice_consent.onboarding", upstream_status: e.status ?? 0, upstream_code: e.code ?? "UNKNOWN" }, "onboarding unknown, voice consent saved");
      }
      return learnerView({ ...child, kind: "child" }, auth.learnerId, onboarded);
    },
  );

  // ---------- Согласие родителя для 14–17 ----------
  app.post(
    "/v1/profile/guardian-consent",
    {
      config: user,
      schema: {
        tags: ["guardian"],
        summary: "Подросток 14–17: ссылка для родителя (https://t.me/<bot>/<app>?startapp=gc_<token>)",
        description: "Ссылка 7 дней, повторный запрос отзывает прежнюю. 409 GUARDIAN_CONSENT_NOT_REQUIRED.",
        security: BEARER,
        response: { 200: GuardianConsentLinkSchema, ...errorResponses(401, 409, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const res = await identity.post<{ token: string; expires_at: string }>("/internal/v1/me/guardian-consent-requests", {
        subject: auth.accountId,
      });
      if (typeof res?.token !== "string" || !GC_TOKEN_RE.test(res.token)) {
        req.log.warn({ upstream: "identity-consent" }, "guardian consent token has unexpected format");
        throw upstreamUnavailable("identity-consent");
      }
      const link: GuardianConsentLink = { link: `${ctx.config.telegramAppLink}?startapp=gc_${res.token}`, expires_at: res.expires_at };
      return link;
    },
  );

  app.get(
    "/v1/guardian-consents/:token",
    {
      config: { access: "public", ipLimit: "public" },
      schemaErrorFormatter: guardianNotFound,
      schema: {
        tags: ["guardian"],
        summary: "Родитель открыл ссылку согласия: имя подростка и статус (публично)",
        description: "token — из start_param без префикса gc_. 404 GUARDIAN_CONSENT_NOT_FOUND; 410 GUARDIAN_CONSENT_EXPIRED.",
        params: GuardianTokenParamsSchema,
        response: { 200: GuardianConsentPreviewSchema, ...errorResponses(404, 410) },
      },
    },
    async (req) => identity.get<GuardianConsentPreview>(`/internal/v1/guardian-consents/${req.params.token}`),
  );

  for (const action of ["accept", "decline"] as const) {
    app.post(
      `/v1/guardian-consents/:token/${action}`,
      {
        config: user,
        schemaErrorFormatter: guardianNotFound,
        schema: {
          tags: ["guardian"],
          summary: action === "accept" ? "Родитель даёт согласие" : "Родитель отказывает",
          description:
            "Решение — от имени аккаунта родителя. 404 GUARDIAN_CONSENT_NOT_FOUND; 410 GUARDIAN_CONSENT_EXPIRED; " +
            "409 GUARDIAN_CONSENT_SELF; 403 ADULT_REQUIRED (не 18+ или детский профиль).",
          security: BEARER,
          params: GuardianTokenParamsSchema,
          response: { 200: GuardianConsentPreviewSchema, ...errorResponses(401, 403, 404, 409, 410, 423) },
        },
      },
      async (req) => {
        const auth = authOf(req);
        forbidInChildProfile(auth, "ADULT_REQUIRED");
        return identity.post<GuardianConsentPreview>(`/internal/v1/guardian-consents/${req.params.token}/${action}`, {
          subject: auth.accountId,
        });
      },
    );
  }

  // ---------- Решения родителя по подросткам 14–17 (INTERNAL_API §11, P-4) ----------
  app.get(
    "/v1/family/guardian-consents",
    {
      config: user,
      schema: {
        tags: ["guardian"],
        summary: "Подростки 14–17, за которых решал этот родитель (последнее решение по каждому)",
        description:
          "identity-consent GET /internal/v1/me/guardian-consents (sub = аккаунт родителя). 403 ADULT_REQUIRED в детском профиле.",
        security: BEARER,
        response: { 200: itemsOf(GuardianConsentGrantSchema), ...errorResponses(401, 403, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      const res = await identity.get<{ items: GuardianConsentGrant[] }>("/internal/v1/me/guardian-consents", { subject: auth.accountId });
      const items = (Array.isArray(res?.items) ? res.items : []).flatMap((g) => {
        const v = guardianGrantView(g);
        return v ? [v] : [];
      });
      return { items };
    },
  );

  app.post(
    "/v1/family/guardian-consents/:teen_user_id/revoke",
    {
      config: user,
      schemaErrorFormatter: grantNotFound,
      schema: {
        tags: ["guardian"],
        summary: "Родитель отзывает своё согласие за подростка 14–17",
        description:
          "identity-consent POST /internal/v1/me/guardian-consents/{teen_user_id}:revoke (sub = аккаунт родителя): у подростка " +
          "guardian_consent=declined, необязательные цели сняты. Только родитель, который дал согласие, иначе 404 " +
          "GUARDIAN_CONSENT_NOT_FOUND (чужой подросток неотличим от несуществующего). 403 ADULT_REQUIRED в детском профиле.",
        security: BEARER,
        params: TeenParamsSchema,
        response: { 200: GuardianConsentGrantSchema, ...errorResponses(401, 403, 404, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "ADULT_REQUIRED");
      const teen = req.params.teen_user_id.toLowerCase();
      const res = await identity.post<GuardianConsentGrant>(`/internal/v1/me/guardian-consents/${teen}:revoke`, { subject: auth.accountId });
      const view = guardianGrantView(res);
      // ответ о другом подростке или вне контракта — ошибка домена, клиенту не отдаём
      if (!view || view.teen_user_id.toLowerCase() !== teen) {
        req.log.warn({ upstream: "identity-consent" }, "guardian consent revoke: unexpected response");
        throw upstreamUnavailable("identity-consent");
      }
      return view;
    },
  );

  // ---------- Приглашения ----------
  app.post(
    "/v1/invites",
    {
      config: user,
      schema: {
        tags: ["invites"],
        summary: "Создать приглашение (семья, друг, реферал) — ссылка для «Поделиться»",
        description:
          "Idempotency-Key (UUID) обязателен (422 IDEMPOTENCY_KEY_REQUIRED). 403 ADULT_REQUIRED (family — только 18+); " +
          "403 INVITES_NOT_ALLOWED (детский профиль, подросток без согласия родителя); 409 INVITES_LIMIT.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: CreateInviteRequestSchema,
        response: { 201: InviteSchema, ...errorResponses(401, 403, 409, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "INVITES_NOT_ALLOWED");
      const key = idempotencyKey(req, true)!;
      const invite = await social.post<Invite>("/internal/v1/me/invites", { subject: auth.accountId, body: { kind: req.body.kind }, idempotencyKey: key });
      return reply.code(201).send(invite);
    },
  );

  app.get(
    "/v1/invites",
    {
      config: user,
      schema: {
        tags: ["invites"],
        summary: "Мои приглашения (limit/cursor)",
        security: BEARER,
        querystring: PageQuerySchema,
        response: { 200: InvitePageSchema, ...errorResponses(401, 403, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "INVITES_NOT_ALLOWED");
      return social.get<Page<Invite>>("/internal/v1/me/invites", {
        subject: auth.accountId,
        query: { limit: req.query.limit ?? 20, cursor: req.query.cursor },
      });
    },
  );

  app.delete(
    "/v1/invites/:invite_id",
    {
      config: user,
      schemaErrorFormatter: inviteNotFound,
      schema: {
        tags: ["invites"],
        summary: "Отозвать своё приглашение",
        description: "Чужое / несуществующее → 404 INVITE_NOT_FOUND.",
        security: BEARER,
        params: InviteParamsSchema,
        response: { 200: InviteSchema, ...errorResponses(401, 403, 404, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "INVITES_NOT_ALLOWED");
      return social.delete<Invite>(`/internal/v1/me/invites/${req.params.invite_id.toLowerCase()}`, { subject: auth.accountId });
    },
  );

  app.post(
    "/v1/invites/open",
    {
      config: user,
      schemaErrorFormatter: inviteNotFound,
      schema: {
        tags: ["invites"],
        summary: "Получатель открыл ссылку приглашения (token из start_param без inv_)",
        description: "Повтор не создаёт дубль. Самоприглашение → can_accept=false, reason=self. 404 INVITE_NOT_FOUND.",
        security: BEARER,
        body: InviteOpenRequestSchema,
        response: { 200: InvitePreviewSchema, ...errorResponses(401, 403, 404, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "INVITES_NOT_ALLOWED");
      return social.post<InvitePreview>("/internal/v1/invites:open", { subject: auth.accountId, body: { token: req.body.token } });
    },
  );

  app.get(
    "/v1/invites/:invite_id/preview",
    {
      config: user,
      schemaErrorFormatter: inviteNotFound,
      schema: {
        tags: ["invites"],
        summary: "Карточка приглашения повторно (кнопка напоминания startapp=invite_<id>)",
        description: "Только тому, кто уже открывал приглашение; иначе 404 INVITE_NOT_FOUND.",
        security: BEARER,
        params: InviteParamsSchema,
        response: { 200: InvitePreviewSchema, ...errorResponses(401, 403, 404, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "INVITES_NOT_ALLOWED");
      return social.get<InvitePreview>(`/internal/v1/invites/${req.params.invite_id.toLowerCase()}/preview`, { subject: auth.accountId });
    },
  );

  app.post(
    "/v1/invites/:invite_id/accept",
    {
      config: user,
      schemaErrorFormatter: inviteNotFound,
      schema: {
        tags: ["invites"],
        summary: "Принять приглашение (семья — вступление в семью пригласившего, друг/реферал — дружба)",
        description:
          "409 INVITE_SELF | INVITE_ALREADY_USED | INVITE_EXPIRED | INVITE_REVOKED | FAMILY_ALREADY_MEMBER; " +
          "403 INVITES_NOT_ALLOWED. Повтор тем же пользователем — 200 тот же результат.",
        security: BEARER,
        params: InviteParamsSchema,
        response: { 200: InviteAcceptResultSchema, ...errorResponses(401, 403, 404, 409, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "INVITES_NOT_ALLOWED");
      const res = await social.post<InviteAcceptResult>(`/internal/v1/invites/${req.params.invite_id.toLowerCase()}/accept`, {
        subject: auth.accountId,
      });
      return { invite_id: res.invite_id, kind: res.kind, family: res.family ? familyView(res.family, auth.learnerId) : null };
    },
  );

  app.post(
    "/v1/invites/:invite_id/decline",
    {
      config: user,
      schemaErrorFormatter: inviteNotFound,
      schema: {
        tags: ["invites"],
        summary: "Отклонить приглашение",
        security: BEARER,
        params: InviteParamsSchema,
        response: { 200: InvitePreviewSchema, ...errorResponses(401, 403, 404, 409, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      forbidInChildProfile(auth, "INVITES_NOT_ALLOWED");
      return social.post<InvitePreview>(`/internal/v1/invites/${req.params.invite_id.toLowerCase()}/decline`, { subject: auth.accountId });
    },
  );

  // ---------- Семья ----------
  app.get(
    "/v1/family",
    {
      config: user,
      schema: {
        tags: ["invites"],
        summary: "Моя семья (204 — семьи нет)",
        description: "is_me — активный ученик (в детском профиле — ребёнок).",
        security: BEARER,
        response: { 200: FamilySchema, 204: Type.Null({ description: "Семьи нет" }), ...errorResponses(401, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const family = await orNull(social.get<Family>("/internal/v1/me/family", { subject: auth.accountId }), "FAMILY_NOT_FOUND");
      if (!family) return reply.code(204).send(null);
      return familyView(family, auth.learnerId);
    },
  );
}
