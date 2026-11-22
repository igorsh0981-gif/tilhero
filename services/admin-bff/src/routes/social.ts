/**
 * Социальное (admin.ts «Социальное», спринт 7; INTERNAL_API спринта 7 §1.3, §1.4, §2.6, §3.2, §6, §9):
 *
 *  - social (`SOCIAL_URL`):
 *    `/admin/v1/social/users/{user_id}` → `/internal/v1/admin/social/users/{user_id}` (social.read);
 *    `/admin/v1/moderation/*` → `/internal/v1/admin/moderation/*` (moderation.manage);
 *    `/admin/v1/referrals*` → `/internal/v1/admin/referrals*` (referral.read, referral.manage);
 *  - gamification (`GAMIFICATION_URL`): `/admin/v1/game/leagues*`, `/admin/v1/game/duels*` →
 *    `/internal/v1/admin/game/leagues*`, `/internal/v1/admin/game/duels*` (league.read, league.manage);
 *  - lessons: `/admin/v1/pair-rooms*` → `/internal/v1/admin/pair-rooms*` (room.read, room.manage).
 *
 * Права проверяются здесь до вызова домена (onRequest), домен — повторно по actor (защита в глубину); аудит каждой
 * команды пишет домен. Step-up (окно 5 мин), домену — заголовок `X-Step-Up: ok`:
 *  - статически: активация реферальной кампании, переоценка лиги и дуэли, остановка парной комнаты;
 *  - по телу команды: решение по делу `social_ban` дольше 7 дней или бессрочно (`days: null`) — 403 STEP_UP_REQUIRED
 *    {permission: moderation.manage} до домена; при свежем step-up заголовок уходит и с прочими решениями.
 * Причина, основание, комментарий и заметка — 10..500 (422 до домена). Idempotency-Key — у всех команд (POST)
 * передаётся, если прислан (формат — 422 до домена); «обязателен» в разделе нигде не сказано. If-Match черновика
 * кампании — как есть (неверный формат — 422; 409 DRAFT_CONFLICT решает social).
 *
 * Ответы — строгие кодеки contractSocial.ts: ровно ключи admin.ts, лишнее отбрасывается (переписка, реплики, оценки,
 * отчёты участников комнат, ник второй стороны заявки в ответ не попадают), чужие значения перечислений → 503. Код
 * друга в карточке ученика — полностью только с moderation.manage, иначе маска `TH-••••-XXXX` (F7-20).
 * Коды доменов — как есть (CASE_STATE, SANCTION_STATE, APPEAL_STATE, REFERRAL_STATE, RESULT_STATE, CAMPAIGN_INVALID,
 * CAMPAIGN_NOT_VALIDATED, DRAFT_CONFLICT, ROOM_NOT_ACTIVE, *_NOT_FOUND). Адрес домена не задан, домен недоступен, 5xx,
 * испорченный ответ → 503 UPSTREAM_UNAVAILABLE {service}; остальная админка работает.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { stepUpRequired } from "../auth.js";
import { parseDomain, type Codec } from "../codec.js";
import { withStaffRefs } from "../contractGame.js";
import {
  ADMIN_CASE,
  ADMIN_DUEL,
  ADMIN_PAIR_ROOM,
  ADMIN_REFERRAL,
  ADMIN_SANCTION,
  ADMIN_SANCTION_APPEAL,
  ADMIN_SOCIAL_CARD,
  APPEAL_PAGE,
  FRIEND_CODE_FULL_PERMISSION,
  CAMPAIGN_LIST,
  CAMPAIGN_STATS_LIST,
  CAMPAIGN_VALIDATION,
  CAMPAIGN_VERSION,
  CASE_PAGE,
  DUEL_PAGE,
  LEAGUE_GROUP,
  LEAGUE_WEEK,
  PAIR_ROOM_PAGE,
  REFERRAL_PAGE,
  SANCTION_PAGE,
  maskFriendCode,
} from "../contractSocial.js";
import type { BffContext } from "../context.js";
import { hasPermission, idempotencyKeyOf, ifMatchOf, passReplayed, staffOf, validationError, type App, type StaffAuth } from "../http.js";
import { requirePermission, requireStepUp } from "../rbac.js";
import { NO_CONTENT } from "../responses.js";
import {
  BOOL_Q,
  CAMPAIGN_VERSION_NO,
  CASE_RESOLVE,
  CASE_STATUSES,
  CURSOR_Q,
  DUEL_REEVALUATE,
  DUEL_STATUSES,
  ISO_Q,
  LEAGUE_REEVALUATE,
  LEAGUE_RELEASE,
  LIMIT_Q,
  PAIR_ROOM_STATUSES,
  PAIR_ROOM_STOP,
  REFERRAL_APPROVE,
  REFERRAL_CAMPAIGN_ACTIVATE,
  REFERRAL_CAMPAIGN_DRAFT,
  REFERRAL_REJECT,
  REFERRAL_STATUSES,
  SANCTION_APPEAL_DECISION,
  SANCTION_APPEAL_STATUSES,
  SANCTION_REVOKE,
  SOCIAL_BAN_STEP_UP_DAYS,
  UUID,
  WEEK_Q,
  enumOf,
  obj,
  pageQuery,
  params,
  query,
} from "../schemas.js";
import { DOMAIN, GAME_SERVICE, SOCIAL_SERVICE, upstreamUnavailable, type CallOptions, type DomainClient } from "../upstream.js";
import { out } from "./common.js";

const INTERNAL = "/internal/v1/admin";
const EMPTY = obj({});
/** Маршрут без параметров запроса: лишний параметр → 422 (как лишнее поле тела). */
const NO_QUERY = query({});
const PAGE_Q = { cursor: CURSOR_Q, limit: LIMIT_Q };

/** Домен маршрута: клиент (null — адрес не задан → 503 {service}) и имя сервиса для 503 и лога. */
interface Target {
  client: () => DomainClient | null;
  service: string;
}

interface ProxyOptions {
  body?: unknown;
  query?: CallOptions["query"];
  /** Idempotency-Key команды — передаётся, если прислан (формат проверяется до домена). */
  idempotency?: boolean;
  headers?: Record<string, string>;
  /** `X-Step-Up: ok` вне статического requireStepUp (решение по делу при свежем step-up). */
  stepUp?: boolean;
}

/** Защита ответа по правам сотрудника после кодека (маска кода друга, F7-20). */
type Redact<T> = (auth: StaffAuth, body: T) => T;

/** Нужен ли step-up решению по делу: social_ban дольше 7 дней или бессрочный (days: null). */
export function resolveNeedsStepUp(body: { action: string; days: number | null }): boolean {
  return body.action === "social_ban" && (body.days === null || body.days > SOCIAL_BAN_STEP_UP_DAYS);
}

export function socialRoutes(app: App, ctx: BffContext): void {
  const SOCIAL: Target = { client: () => ctx.social, service: SOCIAL_SERVICE };
  const GAME: Target = { client: () => ctx.gamification, service: GAME_SERVICE };
  const LESSONS: Target = { client: () => ctx.domains.lessons, service: DOMAIN.lessons };

  /**
   * Вызов домена с actor: Idempotency-Key (формат — 422 до домена), `X-Step-Up: ok` для маршрутов requireStepUp и
   * по признаку stepUp → строгий кодек → имена сотрудников в StaffRef → статус домена и Idempotent-Replayed.
   */
  async function proxy<T>(
    t: Target,
    req: FastifyRequest,
    reply: FastifyReply,
    method: string,
    path: string,
    c: Codec<T>,
    o: ProxyOptions & { redact?: Redact<T> } = {},
  ) {
    const auth = staffOf(req);
    const idempotencyKey = o.idempotency ? idempotencyKeyOf(req, false) : undefined;
    const client = t.client();
    if (!client) throw upstreamUnavailable(t.service);
    const stepUp: Record<string, string> = req.routeOptions.config.stepUp === true || o.stepUp ? { "x-step-up": "ok" } : {};
    const res = await client.call(method, `${INTERNAL}${path}`, {
      actor: auth.actor,
      ...(o.body !== undefined ? { body: o.body } : {}),
      ...(o.query ? { query: o.query } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      headers: { ...o.headers, ...stepUp },
    });
    passReplayed(reply, res);
    const parsed = parseDomain(ctx, t.service, c, res.body);
    const body = await withStaffRefs(ctx, auth, o.redact ? o.redact(auth, parsed) : parsed);
    return reply.status(res.status).send(body);
  }

  type P = Record<string, string>;
  type Q = Record<string, string | undefined>;
  const p = (req: FastifyRequest): P => req.params as P;
  const qs = (req: FastifyRequest): Q => req.query as Q;
  /** UUID из пути — в нижнем регистре (схема пути уже проверила формат). */
  const id = (req: FastifyRequest, name: string): string => p(req)[name]!.toLowerCase();

  const read = <T>(t: Target, c: Codec<T>, path: (req: FastifyRequest) => string, q?: (req: FastifyRequest) => CallOptions["query"]) =>
    async (req: FastifyRequest, reply: FastifyReply) => proxy(t, req, reply, "GET", path(req), c, q ? { query: q(req) } : {});
  const command = <T>(t: Target, c: Codec<T>, path: (req: FastifyRequest) => string) =>
    async (req: FastifyRequest, reply: FastifyReply) => proxy(t, req, reply, "POST", path(req), c, { body: req.body, idempotency: true });

  // ================================================================ social: карточка ученика (social.read)

  /**
   * Код друга (F7-20): полностью — только с moderation.manage, иначе маска `TH-••••-XXXX` (по эффективным правам
   * сессии; домен отдаёт код целиком, маскирует BFF).
   */
  app.get(
    "/admin/v1/social/users/:userId",
    { config: requirePermission("social.read"), schema: { response: out(ADMIN_SOCIAL_CARD), params: params({ userId: UUID }), querystring: NO_QUERY } },
    async (req, reply) =>
      proxy(SOCIAL, req, reply, "GET", `/social/users/${id(req, "userId")}`, ADMIN_SOCIAL_CARD, {
        redact: (auth, card) =>
          card.friend_code === null || hasPermission(auth, FRIEND_CODE_FULL_PERMISSION) ? card : { ...card, friend_code: maskFriendCode(card.friend_code) },
      }),
  );

  // ================================================================ social: модерация (moderation.manage)

  const MOD = "/admin/v1/moderation";
  const CASE_PARAMS = params({ caseId: UUID });

  app.get(
    `${MOD}/cases`,
    {
      config: requirePermission("moderation.manage"),
      schema: { response: out(CASE_PAGE), querystring: query({ status: enumOf(CASE_STATUSES), ...PAGE_Q }) },
    },
    read(SOCIAL, CASE_PAGE, () => "/moderation/cases", (req) => ({ status: qs(req).status, ...pageQuery(qs(req)) })),
  );

  app.get(
    `${MOD}/cases/:caseId`,
    { config: requirePermission("moderation.manage"), schema: { response: out(ADMIN_CASE), params: CASE_PARAMS, querystring: NO_QUERY } },
    read(SOCIAL, ADMIN_CASE, (req) => `/moderation/cases/${id(req, "caseId")}`),
  );

  /**
   * Решение по делу. social_ban дольше 7 дней или бессрочно — только со свежим step-up (403 STEP_UP_REQUIRED
   * {permission: moderation.manage} до домена); при свежем step-up домену уходит `X-Step-Up: ok`.
   */
  app.post<{ Body: { action: string; days: number | null; basis: string } }>(
    `${MOD}/cases/:caseId/resolve`,
    { config: requirePermission("moderation.manage"), schema: { response: out(ADMIN_CASE), params: CASE_PARAMS, body: CASE_RESOLVE } },
    async (req, reply) => {
      const auth = staffOf(req);
      const fresh = auth.session.step_up_until > ctx.now();
      if (resolveNeedsStepUp(req.body) && !fresh) throw stepUpRequired("moderation.manage");
      return proxy(SOCIAL, req, reply, "POST", `/moderation/cases/${id(req, "caseId")}/resolve`, ADMIN_CASE, {
        body: req.body,
        idempotency: true,
        stepUp: fresh,
      });
    },
  );

  app.get(
    `${MOD}/sanctions`,
    {
      config: requirePermission("moderation.manage"),
      schema: { response: out(SANCTION_PAGE), querystring: query({ user_id: UUID, active: BOOL_Q, ...PAGE_Q }) },
    },
    read(SOCIAL, SANCTION_PAGE, () => "/moderation/sanctions", (req) => ({
      user_id: qs(req).user_id?.toLowerCase(),
      active: qs(req).active,
      ...pageQuery(qs(req)),
    })),
  );

  app.post(
    `${MOD}/sanctions/:sanctionId/revoke`,
    {
      config: requirePermission("moderation.manage"),
      schema: { response: out(ADMIN_SANCTION), params: params({ sanctionId: UUID }), body: SANCTION_REVOKE },
    },
    command(SOCIAL, ADMIN_SANCTION, (req) => `/moderation/sanctions/${id(req, "sanctionId")}/revoke`),
  );

  app.get(
    `${MOD}/appeals`,
    {
      config: requirePermission("moderation.manage"),
      schema: { response: out(APPEAL_PAGE), querystring: query({ status: enumOf(SANCTION_APPEAL_STATUSES), ...PAGE_Q }) },
    },
    read(SOCIAL, APPEAL_PAGE, () => "/moderation/appeals", (req) => ({ status: qs(req).status, ...pageQuery(qs(req)) })),
  );

  app.post(
    `${MOD}/appeals/:appealId/decide`,
    {
      config: requirePermission("moderation.manage"),
      schema: { response: out(ADMIN_SANCTION_APPEAL), params: params({ appealId: UUID }), body: SANCTION_APPEAL_DECISION },
    },
    command(SOCIAL, ADMIN_SANCTION_APPEAL, (req) => `/moderation/appeals/${id(req, "appealId")}/decide`),
  );

  // ================================================================ social: реферальные кампании и очередь проверки

  const REF = "/admin/v1/referrals";
  const REFERRAL_PARAMS = params({ referralId: UUID });

  app.get(
    `${REF}/campaigns`,
    { config: requirePermission("referral.read"), schema: { response: out(CAMPAIGN_LIST), querystring: NO_QUERY } },
    read(SOCIAL, CAMPAIGN_LIST, () => "/referrals/campaigns"),
  );

  app.get(
    `${REF}/campaigns/stats`,
    { config: requirePermission("referral.read"), schema: { response: out(CAMPAIGN_STATS_LIST), querystring: NO_QUERY } },
    read(SOCIAL, CAMPAIGN_STATS_LIST, () => "/referrals/campaigns/stats"),
  );

  app.get(
    `${REF}/campaigns/:version`,
    {
      config: requirePermission("referral.read"),
      schema: { response: out(CAMPAIGN_VERSION), params: params({ version: CAMPAIGN_VERSION_NO }), querystring: NO_QUERY },
    },
    read(SOCIAL, CAMPAIGN_VERSION, (req) => `/referrals/campaigns/${Number(p(req).version)}`),
  );

  /** Создать или заменить черновик; If-Match (updated_at черновика) — в social как есть (409 DRAFT_CONFLICT). */
  app.put(
    `${REF}/campaigns/draft`,
    { config: requirePermission("referral.manage"), schema: { response: out(CAMPAIGN_VERSION), body: REFERRAL_CAMPAIGN_DRAFT } },
    async (req, reply) =>
      proxy(SOCIAL, req, reply, "PUT", "/referrals/campaigns/draft", CAMPAIGN_VERSION, { body: req.body, headers: ifMatchOf(req.headers["if-match"]) }),
  );

  app.delete(`${REF}/campaigns/draft`, { config: requirePermission("referral.manage"), schema: { response: NO_CONTENT, body: EMPTY } }, async (req, reply) => {
    const auth = staffOf(req);
    const client = SOCIAL.client();
    if (!client) throw upstreamUnavailable(SOCIAL.service);
    await client.call("DELETE", `${INTERNAL}/referrals/campaigns/draft`, { actor: auth.actor });
    return reply.status(204).send();
  });

  app.post(
    `${REF}/campaigns/draft/validate`,
    { config: requirePermission("referral.manage"), schema: { response: out(CAMPAIGN_VALIDATION), body: EMPTY } },
    async (req, reply) => proxy(SOCIAL, req, reply, "POST", "/referrals/campaigns/draft/validate", CAMPAIGN_VALIDATION, { body: {} }),
  );

  app.post(
    `${REF}/campaigns/draft/activate`,
    {
      config: { ...requirePermission("referral.manage"), ...requireStepUp() },
      schema: { response: out(CAMPAIGN_VERSION), body: REFERRAL_CAMPAIGN_ACTIVATE },
    },
    command(SOCIAL, CAMPAIGN_VERSION, () => "/referrals/campaigns/draft/activate"),
  );

  app.get(
    REF,
    {
      config: requirePermission("referral.read"),
      schema: { response: out(REFERRAL_PAGE), querystring: query({ status: enumOf(REFERRAL_STATUSES), ...PAGE_Q }) },
    },
    read(SOCIAL, REFERRAL_PAGE, () => "/referrals", (req) => ({ status: qs(req).status, ...pageQuery(qs(req)) })),
  );

  app.get(
    `${REF}/:referralId`,
    { config: requirePermission("referral.read"), schema: { response: out(ADMIN_REFERRAL), params: REFERRAL_PARAMS, querystring: NO_QUERY } },
    read(SOCIAL, ADMIN_REFERRAL, (req) => `/referrals/${id(req, "referralId")}`),
  );

  app.post(
    `${REF}/:referralId/approve`,
    { config: requirePermission("referral.manage"), schema: { response: out(ADMIN_REFERRAL), params: REFERRAL_PARAMS, body: REFERRAL_APPROVE } },
    command(SOCIAL, ADMIN_REFERRAL, (req) => `/referrals/${id(req, "referralId")}/approve`),
  );

  app.post(
    `${REF}/:referralId/reject`,
    { config: requirePermission("referral.manage"), schema: { response: out(ADMIN_REFERRAL), params: REFERRAL_PARAMS, body: REFERRAL_REJECT } },
    command(SOCIAL, ADMIN_REFERRAL, (req) => `/referrals/${id(req, "referralId")}/reject`),
  );

  // ================================================================ gamification: лиги недели и дуэли

  const GM = "/admin/v1/game";
  const GROUP_PARAMS = params({ groupId: UUID });
  const DUEL_PARAMS = params({ duelId: UUID });

  /** ?week= — понедельник (YYYY-MM-DD); другой день или несуществующая дата → 422 до домена; нет — текущая неделя. */
  app.get(
    `${GM}/leagues`,
    { config: requirePermission("league.read"), schema: { response: out(LEAGUE_WEEK), querystring: query({ week: WEEK_Q }) } },
    async (req, reply) => {
      const week = qs(req).week;
      if (week !== undefined) {
        const d = new Date(`${week}T00:00:00Z`);
        if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== week || d.getUTCDay() !== 1) {
          throw validationError("week", "Неделя — понедельник в формате YYYY-MM-DD", "querystring");
        }
      }
      return proxy(GAME, req, reply, "GET", "/game/leagues", LEAGUE_WEEK, { query: { week } });
    },
  );

  app.get(
    `${GM}/leagues/:groupId`,
    { config: requirePermission("league.read"), schema: { response: out(LEAGUE_GROUP), params: GROUP_PARAMS, querystring: NO_QUERY } },
    read(GAME, LEAGUE_GROUP, (req) => `/game/leagues/${id(req, "groupId")}`),
  );

  /** Переоценка закрытой группы (step-up): версия + 1, прежняя хранится; исключаемые id — в нижнем регистре. */
  app.post<{ Body: { exclude_user_ids: string[]; reason: string } }>(
    `${GM}/leagues/:groupId/reevaluate`,
    {
      config: { ...requirePermission("league.manage"), ...requireStepUp() },
      schema: { response: out(LEAGUE_GROUP), params: GROUP_PARAMS, body: LEAGUE_REEVALUATE },
    },
    async (req, reply) => {
      const ids = req.body.exclude_user_ids.map((x) => x.toLowerCase());
      if (new Set(ids).size !== ids.length) throw validationError("exclude_user_ids", "Участник указан дважды");
      return proxy(GAME, req, reply, "POST", `/game/leagues/${id(req, "groupId")}/reevaluate`, LEAGUE_GROUP, {
        body: { ...req.body, exclude_user_ids: ids },
        idempotency: true,
      });
    },
  );

  app.post(
    `${GM}/leagues/:groupId/release-prizes`,
    { config: requirePermission("league.manage"), schema: { response: out(LEAGUE_GROUP), params: GROUP_PARAMS, body: LEAGUE_RELEASE } },
    command(GAME, LEAGUE_GROUP, (req) => `/game/leagues/${id(req, "groupId")}/release-prizes`),
  );

  app.get(
    `${GM}/duels`,
    { config: requirePermission("league.read"), schema: { response: out(DUEL_PAGE), querystring: query({ status: enumOf(DUEL_STATUSES), ...PAGE_Q }) } },
    read(GAME, DUEL_PAGE, () => "/game/duels", (req) => ({ status: qs(req).status, ...pageQuery(qs(req)) })),
  );

  app.get(
    `${GM}/duels/:duelId`,
    { config: requirePermission("league.read"), schema: { response: out(ADMIN_DUEL), params: DUEL_PARAMS, querystring: NO_QUERY } },
    read(GAME, ADMIN_DUEL, (req) => `/game/duels/${id(req, "duelId")}`),
  );

  app.post(
    `${GM}/duels/:duelId/reevaluate`,
    {
      config: { ...requirePermission("league.manage"), ...requireStepUp() },
      schema: { response: out(ADMIN_DUEL), params: DUEL_PARAMS, body: DUEL_REEVALUATE },
    },
    command(GAME, ADMIN_DUEL, (req) => `/game/duels/${id(req, "duelId")}/reevaluate`),
  );

  // ================================================================ lessons: парные комнаты

  const ROOMS = "/admin/v1/pair-rooms";
  const ROOM_PARAMS = params({ roomId: UUID });

  /** ?from=&to= — ISO-8601 (дата или время с зоной); from позже to или неразборчивая дата → 422 до домена. */
  app.get(
    ROOMS,
    {
      config: requirePermission("room.read"),
      schema: { response: out(PAIR_ROOM_PAGE), querystring: query({ status: enumOf(PAIR_ROOM_STATUSES), from: ISO_Q, to: ISO_Q, ...PAGE_Q }) },
    },
    async (req, reply) => {
      const q = qs(req);
      for (const k of ["from", "to"] as const) {
        if (q[k] !== undefined && Number.isNaN(Date.parse(q[k]!))) throw validationError(k, "Ожидается дата ISO-8601", "querystring");
      }
      if (q.from !== undefined && q.to !== undefined && Date.parse(q.from) > Date.parse(q.to)) {
        throw validationError("from", "Начало периода позже конца", "querystring");
      }
      return proxy(LESSONS, req, reply, "GET", "/pair-rooms", PAIR_ROOM_PAGE, {
        query: { status: q.status, from: q.from, to: q.to, ...pageQuery(q) },
      });
    },
  );

  app.get(
    `${ROOMS}/:roomId`,
    { config: requirePermission("room.read"), schema: { response: out(ADMIN_PAIR_ROOM), params: ROOM_PARAMS, querystring: NO_QUERY } },
    read(LESSONS, ADMIN_PAIR_ROOM, (req) => `/pair-rooms/${id(req, "roomId")}`),
  );

  app.post(
    `${ROOMS}/:roomId/stop`,
    {
      config: { ...requirePermission("room.manage"), ...requireStepUp() },
      schema: { response: out(ADMIN_PAIR_ROOM), params: ROOM_PARAMS, body: PAIR_ROOM_STOP },
    },
    command(LESSONS, ADMIN_PAIR_ROOM, (req) => `/pair-rooms/${id(req, "roomId")}/stop`),
  );
}
