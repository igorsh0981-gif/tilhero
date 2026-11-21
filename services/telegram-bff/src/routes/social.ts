/**
 * Спринт 7 — социальное в social (bff.ts «Спринт 7», INTERNAL_API спринта 7 §0, §1, §9): профиль сообщества (ник, код
 * друга, скрытие), поиск, заявки в друзья, друзья, блокировки, жалобы, санкции и обжалование, рефералы. Семья спринта 1
 * (+ member_id) — routes/family.ts.
 *
 * social вызывается от имени активного ученика (socialApi.ts): sub = аккаунт, claims lrn и age_band. member_id другого
 * ученика BFF передаёт как есть; в ответах другой ученик — только member_id и ник (схемы src/schemas.ts; «сырой» UUID в
 * member_id — ответ не по контракту: элемент списка отбрасывается, объект — 503). user_id, имени, Telegram, возраста в
 * ответах нет по построению: сериализация по схеме контракта.
 *
 * Детский профиль (lrn ≠ sub) — до вызова social: поиск, заявки и друзья — 403 FRIENDS_NOT_ALLOWED {reason: kids};
 * блокировки, жалобы, рефералы — 403 KIDS_NOT_ALLOWED (контракт). Профиль сообщества и санкции — решает social.
 *
 * Лимиты на ученика: tg.social.search (поиск, 30/мин), tg.social.write (ник, код, скрытие, заявки, друзья, блокировки,
 * обжалование — 30/мин), tg.social.complaint (жалобы, 10/сутки); чтение — общий tg.user.
 * Ошибки social — как есть (код, статус, details); недоступность, таймаут, 5xx, ответ не по контракту → 503
 * UPSTREAM_UNAVAILABLE {service: social} (социальный блок скрыть, учёба работает).
 * Логи: без ника, кода друга, запроса поиска, текста жалобы и обжалования (тела не пишутся, ключи вычищаются).
 */
import { Type, type Static, type TSchema } from "@fastify/type-provider-typebox";
import type * as C from "@tilhero/contracts/bff";
import { expectShape, matches } from "../check.js";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, idempotencyKey, schemaErrors, type App } from "../http.js";
import {
  BlockRequestSchema,
  BlockViewSchema,
  BlocksResponseSchema,
  CommunityPatchSchema,
  CommunityProfileSchema,
  ComplaintRequestSchema,
  ComplaintResultSchema,
  CursorOnlyQuerySchema,
  FriendPageSchema,
  FriendRequestCreateSchema,
  FriendRequestPageSchema,
  FriendRequestParamsSchema,
  FriendRequestViewSchema,
  FriendRequestsQuerySchema,
  FriendViewSchema,
  IdempotencyHeadersSchema,
  MemberCardSchema,
  MemberParamsSchema,
  MemberSearchQuerySchema,
  MemberSearchResultSchema,
  NicknameRequestSchema,
  ReferralTermsSchema,
  ReferralViewSchema,
  ReferralsResponseSchema,
  SanctionAppealRequestSchema,
  SanctionParamsSchema,
  SanctionViewSchema,
  SanctionsResponseSchema,
} from "../schemas.js";
import { createdStatus, friendsNotAllowedForKids, isChildProfile, kidsNotAllowed, learnerCall, validationError } from "../socialApi.js";
import type { AccessClaims } from "../tokens.js";
import type { RawMethod, RawRequest } from "../upstream.js";
import { pageView } from "./content.js";

const user = { access: "user" } as const;
const TAG = ["social"];
const SOCIAL = "social";
const SEARCH = "tg.social.search";
const WRITE = "tg.social.write";
const COMPLAINT = "tg.social.complaint";
const ME = "/internal/v1/me";
const enc = encodeURIComponent;

/** Ник не по правилам формы — коды контракта (запрещённые слова и занятость проверяет social). */
const nicknameErrors = schemaErrors([
  { context: "body", field: "nickname", keywords: ["minLength", "maxLength"], code: "NICKNAME_INVALID", message: "Ник — от 3 до 20 символов", details: { reason: "length" } },
  { context: "body", field: "nickname", keywords: ["pattern"], code: "NICKNAME_INVALID", message: "Ник — только буквы, цифры и «_»", details: { reason: "chars" } },
]);
/** Неверный формат id в пути — как чужой или несуществующий (неотличимо), без вызова social. */
const notFoundIn = (code: string, message: string) => schemaErrors([{ context: "params", status: 404, code, message }]);
const requestNotFound = notFoundIn("REQUEST_NOT_FOUND", "Заявка не найдена");
const memberNotFound = notFoundIn("MEMBER_NOT_FOUND", "Участник не найден");
const sanctionNotFound = notFoundIn("SANCTION_NOT_FOUND", "Санкция не найдена");

/** Виды жалобы без предмета (subject_id = null); для остальных subject_id обязателен. */
const SUBJECTLESS: ReadonlySet<C.ComplaintSubjectKind> = new Set(["user", "nickname"]);

// ---------------------------------------------------------------- сборка ответов (только поля контракта, явно)
export const communityView = (p: C.CommunityProfile): C.CommunityProfile => ({
  member_id: p.member_id,
  nickname: p.nickname,
  friend_code: p.friend_code,
  game_profile_hidden: p.game_profile_hidden,
  restrictions: { social_ban: p.restrictions.social_ban, social_ban_until: p.restrictions.social_ban_until },
  nickname_change_available_at: p.nickname_change_available_at,
  friends_available: p.friends_available,
  friends_unavailable_reason: p.friends_unavailable_reason,
});
const requestView = (r: C.FriendRequestView): C.FriendRequestView => ({
  request_id: r.request_id.toLowerCase(),
  direction: r.direction,
  member_id: r.member_id,
  nickname: r.nickname,
  status: r.status,
  created_at: r.created_at,
  decided_at: r.decided_at,
});
const sanctionView = (s: C.SanctionView): C.SanctionView => ({
  sanction_id: s.sanction_id.toLowerCase(),
  kind: s.kind,
  basis: s.basis,
  decided_at: s.decided_at,
  until: s.until,
  active: s.active,
  revoked_at: s.revoked_at,
  appeal: s.appeal
    ? { appeal_id: s.appeal.appeal_id.toLowerCase(), status: s.appeal.status, text: s.appeal.text, created_at: s.appeal.created_at, decided_at: s.appeal.decided_at, decision_note: s.appeal.decision_note }
    : null,
  can_appeal: s.can_appeal,
});
const referralView = (r: C.ReferralView): C.ReferralView => ({
  referral_id: r.referral_id.toLowerCase(),
  invitee_nickname: r.invitee_nickname,
  status: r.status,
  progress: { ...r.progress },
  reward: r.reward ? { freeze: r.reward.freeze, til: r.reward.til } : null,
  reward_outcome: r.reward_outcome,
  reject_code: r.reject_code,
  legacy: r.legacy,
  accepted_at: r.accepted_at,
});

export function socialRoutes(app: App, ctx: BffContext): void {
  const social = ctx.domains.socialRaw;
  const log = ctx.log;

  /** Вызов social от имени активного ученика; policy — лимит на ученика (null — только общий tg.user). */
  async function call(auth: AccessClaims, policy: string | null, method: RawMethod, path: string, extra: Pick<RawRequest, "query" | "body" | "idempotencyKey"> = {}) {
    if (policy) await ctx.limiter.enforce(policy, auth.learnerId);
    const { ro } = await learnerCall(ctx, auth);
    return social.jsonWithStatus<unknown>(method, path, { ...ro, ...extra });
  }
  const shape = <S extends TSchema>(what: string, schema: S, raw: unknown): Static<S> => expectShape(log, SOCIAL, what, schema, raw);
  /** Список без курсора: элемент не по контракту (в т. ч. member_id не того формата) отбрасывается с записью в лог. */
  function itemsView<S extends TSchema>(what: string, item: S, raw: unknown): Static<S>[] {
    const r = raw as { items?: unknown } | null;
    if (!r || typeof r !== "object" || !Array.isArray(r.items)) return shape(what, Type.Object({ items: Type.Array(item) }), raw).items;
    const items = r.items.filter((i): i is Static<S> => matches(item, i));
    if (items.length < r.items.length) log.warn({ upstream: SOCIAL, check: what, dropped: r.items.length - items.length, upstream_code: "UPSTREAM_BAD_RESPONSE" }, "list items dropped");
    return items;
  }
  const community = (raw: unknown) => communityView(shape("community", CommunityProfileSchema, raw));
  /** Друзья и заявки — не для детского профиля. */
  const noFriendsForChild = (auth: AccessClaims): AccessClaims => {
    if (isChildProfile(auth)) throw friendsNotAllowedForKids();
    return auth;
  };
  const noChild = (auth: AccessClaims, message?: string): AccessClaims => {
    if (isChildProfile(auth)) throw kidsNotAllowed(message);
    return auth;
  };
  /** Idempotency-Key необязательной команды: есть — пробрасывается (не UUID — 422), нет — без него. */
  const optionalKey = (req: { headers: Record<string, string | string[] | undefined> }) => {
    const key = idempotencyKey(req, false);
    return key ? { idempotencyKey: key } : {};
  };

  // ---------------------------------------------------------------- профиль сообщества (APP-SOC-01/02)
  app.get(
    "/v1/community",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Профиль сообщества: member_id, ник, код друга (виден только владельцу), скрытие, ограничения",
        description:
          "Создаётся при первом обращении (ник — null). friends_available=false — друзья и заявки недоступны (kids — детский " +
          "профиль: лиги, дуэли и парные уроки только с семьёй; guardian_consent; consent). 403 CONSENT_REQUIRED {purpose: social}.",
        security: BEARER,
        response: { 200: CommunityProfileSchema, ...errorResponses(401, 403, 410, 423) },
      },
    },
    async (req) => community((await call(authOf(req), null, "GET", `${ME}/community`)).body),
  );

  app.patch(
    "/v1/community",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Скрыть или показать игровой профиль (в лигах друзей и семьи; себе виден всегда) → CommunityProfile",
        description: "Хотя бы одно поле (иначе 422). Лимит tg.social.write.",
        security: BEARER,
        body: CommunityPatchSchema,
        response: { 200: CommunityProfileSchema, ...errorResponses(401, 403, 410, 423) },
      },
    },
    async (req) => {
      const b = req.body;
      const body: C.CommunityPatch = { ...(b.game_profile_hidden !== undefined ? { game_profile_hidden: b.game_profile_hidden } : {}) };
      return community((await call(authOf(req), WRITE, "PATCH", `${ME}/community`, { body })).body);
    },
  );

  app.put(
    "/v1/community/nickname",
    {
      config: user,
      schemaErrorFormatter: nicknameErrors,
      schema: {
        tags: TAG,
        summary: "Задать или сменить ник (3–20: буквы RU/UZ/EN, цифры, «_») → CommunityProfile",
        description:
          "Тот же ник — 200 без смены. 409 NICKNAME_TAKEN (без учёта регистра); 422 NICKNAME_INVALID {reason: length | chars | " +
          "forbidden}; 429 NICKNAME_COOLDOWN {until} — раз в 7 дней. Лимит tg.social.write. Ник в лог не пишется.",
        security: BEARER,
        body: NicknameRequestSchema,
        response: { 200: CommunityProfileSchema, ...errorResponses(401, 403, 409, 410, 423) },
      },
    },
    async (req) => community((await call(authOf(req), WRITE, "PUT", `${ME}/community/nickname`, { body: { nickname: req.body.nickname } })).body),
  );

  app.post(
    "/v1/community/friend-code/rotate",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Новый код друга (прежний сразу перестаёт находиться) → CommunityProfile",
        description: "429 FRIEND_CODE_LIMIT {until} — не чаще 3 раз в сутки. Idempotency-Key необязателен (пробрасывается). Лимит tg.social.write.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        response: { 200: CommunityProfileSchema, ...errorResponses(401, 403, 410, 423) },
      },
    },
    async (req) => community((await call(authOf(req), WRITE, "POST", `${ME}/community/friend-code:rotate`, optionalKey(req))).body),
  );

  // ---------------------------------------------------------------- поиск (APP-SOC-01)
  app.get(
    "/v1/friends/search",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Найти ученика по точному коду друга или нику → 0 или 1 карточка",
        description:
          "?q= — 3..20 знаков (буквы, цифры, «_», «-»); код — без учёта дефисов и регистра, ник — без учёта регистра. " +
          "Заблокированные в любую сторону и дети не находятся; ничего — 200 {items: []}. Детский профиль — 403 FRIENDS_NOT_ALLOWED " +
          "{reason: kids}. Лимит tg.social.search (30 в минуту). Запрос в лог не пишется.",
        security: BEARER,
        querystring: MemberSearchQuerySchema,
        response: { 200: MemberSearchResultSchema, ...errorResponses(401, 403, 410, 423) },
      },
    },
    async (req) => {
      const auth = noFriendsForChild(authOf(req));
      const res = await call(auth, SEARCH, "GET", `${ME}/friends/search`, { query: { q: req.query.q } });
      return {
        items: itemsView("friends_search", MemberCardSchema, res.body)
          .slice(0, 1)
          .map((m) => ({ member_id: m.member_id, nickname: m.nickname, relation: m.relation, request_id: m.request_id ? m.request_id.toLowerCase() : null })),
      };
    },
  );

  // ---------------------------------------------------------------- заявки (APP-SOC-01/02)
  app.post(
    "/v1/friends/requests",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Заявка в друзья по member_id (из поиска) → FriendRequestView (201; встречная заявка — принятие, 200)",
        description:
          "Idempotency-Key (UUID) обязателен: повтор — тот же ответ. 409 ALREADY_FRIENDS | REQUEST_EXISTS | FRIENDS_LIMIT {limit}; " +
          "429 REQUESTS_LIMIT (20 в сутки); 403 BLOCKED | SOCIAL_RESTRICTED {until} | FRIENDS_NOT_ALLOWED {reason}; 404 MEMBER_NOT_FOUND; " +
          "себе — 422 VALIDATION_ERROR. Лимит tg.social.write.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: FriendRequestCreateSchema,
        response: { 200: FriendRequestViewSchema, 201: FriendRequestViewSchema, ...errorResponses(401, 403, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const auth = noFriendsForChild(authOf(req));
      const key = idempotencyKey(req, true)!;
      const res = await call(auth, WRITE, "POST", `${ME}/friend-requests`, { body: { member_id: req.body.member_id }, idempotencyKey: key });
      return reply.code(createdStatus(res.status)).send(requestView(shape("friend_request", FriendRequestViewSchema, res.body)));
    },
  );

  app.get(
    "/v1/friends/requests",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Заявки: входящие (direction=in) или исходящие (out), только pending, новые сверху",
        description: "?direction=in|out (обязателен), ?cursor=. Детский профиль — 403 FRIENDS_NOT_ALLOWED {reason: kids}.",
        security: BEARER,
        querystring: FriendRequestsQuerySchema,
        response: { 200: FriendRequestPageSchema, ...errorResponses(401, 403, 410, 423) },
      },
    },
    async (req) => {
      const auth = noFriendsForChild(authOf(req));
      const res = await call(auth, null, "GET", `${ME}/friend-requests`, { query: { direction: req.query.direction, cursor: req.query.cursor } });
      const page = pageView(ctx, SOCIAL, "friend_requests", FriendRequestViewSchema, res.body);
      return { items: page.items.map(requestView), next_cursor: page.next_cursor };
    },
  );

  for (const action of ["accept", "decline", "cancel"] as const) {
    app.post(
      `/v1/friends/requests/:request_id/${action}`,
      {
        config: user,
        schemaErrorFormatter: requestNotFound,
        schema: {
          tags: TAG,
          summary:
            action === "accept"
              ? "Принять входящую заявку → FriendRequestView (accepted)"
              : action === "decline"
                ? "Отклонить входящую заявку → FriendRequestView (declined)"
                : "Отозвать свою заявку → FriendRequestView (cancelled)",
          description:
            "Повтор с тем же исходом — 200; иначе 409 REQUEST_STATE {status}; принять при 200 друзьях — 409 FRIENDS_LIMIT; " +
            "404 REQUEST_NOT_FOUND (чужая неотличима). Лимит tg.social.write.",
          security: BEARER,
          params: FriendRequestParamsSchema,
          headers: IdempotencyHeadersSchema,
          response: { 200: FriendRequestViewSchema, ...errorResponses(401, 403, 404, 409, 410, 423) },
        },
      },
      async (req) => {
        const auth = noFriendsForChild(authOf(req));
        const res = await call(auth, WRITE, "POST", `${ME}/friend-requests/${enc(req.params.request_id.toLowerCase())}/${action}`, optionalKey(req));
        return requestView(shape("friend_request", FriendRequestViewSchema, res.body));
      },
    );
  }

  // ---------------------------------------------------------------- друзья
  app.get(
    "/v1/friends",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Мои друзья: member_id, ник (null — «Друг»), с какого времени; по нику",
        description: "?cursor=. Чужой код друга не показывается. Детский профиль — 403 FRIENDS_NOT_ALLOWED {reason: kids}.",
        security: BEARER,
        querystring: CursorOnlyQuerySchema,
        response: { 200: FriendPageSchema, ...errorResponses(401, 403, 410, 423) },
      },
    },
    async (req) => {
      const auth = noFriendsForChild(authOf(req));
      const res = await call(auth, null, "GET", `${ME}/friends`, { query: { cursor: req.query.cursor } });
      const page = pageView(ctx, SOCIAL, "friends", FriendViewSchema, res.body);
      return { items: page.items.map((f) => ({ member_id: f.member_id, nickname: f.nickname, since: f.since })), next_cursor: page.next_cursor };
    },
  );

  app.delete(
    "/v1/friends/:member_id",
    {
      config: user,
      schemaErrorFormatter: memberNotFound,
      schema: {
        tags: TAG,
        summary: "Удалить из друзей (повтор — 204; второй стороне без уведомления)",
        description: "Лимит tg.social.write. Детский профиль — 403 FRIENDS_NOT_ALLOWED {reason: kids}.",
        security: BEARER,
        params: MemberParamsSchema,
        response: { 204: Type.Null({ description: "Удалено" }), ...errorResponses(401, 403, 404, 410, 423) },
      },
    },
    async (req, reply) => {
      const auth = noFriendsForChild(authOf(req));
      await call(auth, WRITE, "DELETE", `${ME}/friends/${enc(req.params.member_id)}`);
      return reply.code(204).send(null);
    },
  );

  // ---------------------------------------------------------------- блокировки
  app.post(
    "/v1/blocks",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Заблокировать ученика → BlockView (201; повтор — 200)",
        description:
          "Удаляет дружбу, отменяет заявки, вызовы и приглашения в обе стороны, скрывает учеников друг от друга. Заблокированный " +
          "не узнаёт о блокировке. Idempotency-Key необязателен. Детский профиль — 403 KIDS_NOT_ALLOWED. Лимит tg.social.write.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: BlockRequestSchema,
        response: { 200: BlockViewSchema, 201: BlockViewSchema, ...errorResponses(401, 403, 404, 410, 423) },
      },
    },
    async (req, reply) => {
      const auth = noChild(authOf(req));
      const res = await call(auth, WRITE, "POST", `${ME}/blocks`, { body: { member_id: req.body.member_id }, ...optionalKey(req) });
      const b = shape("block", BlockViewSchema, res.body);
      return reply.code(createdStatus(res.status)).send({ member_id: b.member_id, nickname: b.nickname, created_at: b.created_at });
    },
  );

  app.get(
    "/v1/blocks",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Мои блокировки",
        description: "Детский профиль — 403 KIDS_NOT_ALLOWED.",
        security: BEARER,
        response: { 200: BlocksResponseSchema, ...errorResponses(401, 403, 410, 423) },
      },
    },
    async (req) => {
      const auth = noChild(authOf(req));
      const res = await call(auth, null, "GET", `${ME}/blocks`);
      return { items: itemsView("blocks", BlockViewSchema, res.body).map((b) => ({ member_id: b.member_id, nickname: b.nickname, created_at: b.created_at })) };
    },
  );

  app.delete(
    "/v1/blocks/:member_id",
    {
      config: user,
      schemaErrorFormatter: memberNotFound,
      schema: {
        tags: TAG,
        summary: "Снять блокировку (дружба не возвращается) → 204",
        description: "Детский профиль — 403 KIDS_NOT_ALLOWED. Лимит tg.social.write.",
        security: BEARER,
        params: MemberParamsSchema,
        response: { 204: Type.Null({ description: "Снята" }), ...errorResponses(401, 403, 404, 410, 423) },
      },
    },
    async (req, reply) => {
      const auth = noChild(authOf(req));
      await call(auth, WRITE, "DELETE", `${ME}/blocks/${enc(req.params.member_id)}`);
      return reply.code(204).send(null);
    },
  );

  // ---------------------------------------------------------------- жалобы (APP-SOC-10)
  app.post(
    "/v1/complaints",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Пожаловаться на ученика, ник, заявку, приглашение, дуэль или парную комнату → ComplaintResult (201)",
        description:
          "Idempotency-Key (UUID) обязателен. subject_id — обязателен для friend_request, invite, duel, pair_room (UUID), для user и " +
          "nickname — null (иначе 422 VALIDATION_ERROR). Повтор на ту же цель за 24 ч — 200 тот же case_id. block=true — сразу " +
          "блокировка. 429 COMPLAINTS_LIMIT; 404 MEMBER_NOT_FOUND; детский профиль — 403 KIDS_NOT_ALLOWED. Лимит tg.social.complaint " +
          "(10 в сутки). Комментарий в лог не пишется.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: ComplaintRequestSchema,
        response: { 200: ComplaintResultSchema, 201: ComplaintResultSchema, ...errorResponses(401, 403, 404, 410, 423) },
      },
    },
    async (req, reply) => {
      const auth = noChild(authOf(req), "В детском профиле жалобы отправляет родитель");
      const key = idempotencyKey(req, true)!;
      const b = req.body;
      if (SUBJECTLESS.has(b.subject_kind) !== (b.subject_id === null)) throw validationError("subject_id", "subject_kind");
      const comment = b.comment?.trim();
      const body: C.ComplaintRequest = {
        member_id: b.member_id,
        subject_kind: b.subject_kind,
        subject_id: b.subject_id ? b.subject_id.toLowerCase() : null,
        reason: b.reason,
        ...(comment ? { comment } : {}),
        ...(b.block !== undefined ? { block: b.block } : {}),
      };
      const res = await call(auth, COMPLAINT, "POST", `${ME}/complaints`, { body, idempotencyKey: key });
      const r = shape("complaint", ComplaintResultSchema, res.body);
      return reply.code(createdStatus(res.status)).send({ case_id: r.case_id.toLowerCase(), created_at: r.created_at, blocked: r.blocked });
    },
  );

  // ---------------------------------------------------------------- санкции и обжалование
  app.get(
    "/v1/sanctions",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Мои санкции: активные и прошлые, основание, срок, обжалование (новые сверху)",
        description: "Кто решал, не показывается.",
        security: BEARER,
        response: { 200: SanctionsResponseSchema, ...errorResponses(401, 403, 410, 423) },
      },
    },
    async (req) => ({ items: itemsView("sanctions", SanctionViewSchema, (await call(authOf(req), null, "GET", `${ME}/sanctions`)).body).map(sanctionView) }),
  );

  app.post(
    "/v1/sanctions/:sanction_id/appeal",
    {
      config: user,
      schemaErrorFormatter: sanctionNotFound,
      schema: {
        tags: TAG,
        summary: "Обжаловать санкцию (одно обжалование) → SanctionView (201)",
        description:
          "Idempotency-Key (UUID) обязателен. text — 10..1000 знаков. 409 APPEAL_EXISTS | SANCTION_STATE; 404 SANCTION_NOT_FOUND. " +
          "Решение придёт уведомлением. Лимит tg.social.write. Текст в лог не пишется.",
        security: BEARER,
        params: SanctionParamsSchema,
        headers: IdempotencyHeadersSchema,
        body: SanctionAppealRequestSchema,
        response: { 200: SanctionViewSchema, 201: SanctionViewSchema, ...errorResponses(401, 403, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      const key = idempotencyKey(req, true)!;
      const text = req.body.text.trim();
      if ([...text].length < 10) throw validationError("text", "minLength");
      const res = await call(auth, WRITE, "POST", `${ME}/sanctions/${enc(req.params.sanction_id.toLowerCase())}/appeal`, { body: { text }, idempotencyKey: key });
      return reply.code(createdStatus(res.status)).send(sanctionView(shape("sanction", SanctionViewSchema, res.body)));
    },
  );

  // ---------------------------------------------------------------- рефералы (APP-REF-01…04)
  app.get(
    "/v1/referrals",
    {
      config: user,
      schema: {
        tags: TAG,
        summary: "Мои приглашённые: статус, прогресс условий, награда, причина отказа; условия кампании и лимит месяца",
        description:
          "?cursor=. Причина отказа — публичный код (not_new_user | family_member | window_expired | review_rejected | monthly_cap), " +
          "правила проверки не раскрываются. Детский профиль — 403 KIDS_NOT_ALLOWED.",
        security: BEARER,
        querystring: CursorOnlyQuerySchema,
        response: { 200: ReferralsResponseSchema, ...errorResponses(401, 403, 410, 423) },
      },
    },
    async (req) => {
      const auth = noChild(authOf(req));
      const res = await call(auth, null, "GET", `${ME}/referrals`, { query: { cursor: req.query.cursor } });
      const page = pageView(ctx, SOCIAL, "referrals", ReferralViewSchema, res.body);
      const rest = shape("referrals", Type.Object({ terms: ReferralTermsSchema, month: Type.Object({ qualified: Type.Integer({ minimum: 0 }), cap: Type.Integer({ minimum: 0 }) }) }), res.body);
      const t = rest.terms;
      return {
        items: page.items.map(referralView),
        next_cursor: page.next_cursor,
        terms: {
          campaign_version: t.campaign_version,
          require_diagnostic: t.require_diagnostic,
          min_lessons: t.min_lessons,
          min_days: t.min_days,
          window_days: t.window_days,
          inviter_reward: { freeze: t.inviter_reward.freeze, til: t.inviter_reward.til },
          invitee_reward: { freeze: t.invitee_reward.freeze, til: t.invitee_reward.til },
          monthly_cap: t.monthly_cap,
        },
        month: { qualified: rest.month.qualified, cap: rest.month.cap },
      };
    },
  );
}
