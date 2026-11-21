/**
 * Спринт 7 — лиги недели и дуэли в gamification (bff.ts «Спринт 7», INTERNAL_API спринта 7 §2.2, §2.3, §9). Настройка
 * участия в общей лиге (league_opt_in) — PATCH /v1/game/settings (routes/game.ts).
 *
 * Вызов gamification — как у игры спринта 6 (gameApi, routes/game.ts): sub = аккаунт, claims lrn и age_band активного
 * ученика; нет GAMIFICATION_URL, недоступность, таймаут, 5xx и ответ не по контракту → 503 GAME_UNAVAILABLE {service:
 * gamification} (игровой и социальный блок скрыть, учёба работает); 4xx — как есть, 503 DUEL_SET_UNAVAILABLE (lessons не
 * выдал набор при принятии дуэли) — как есть.
 *
 * Приватность: другой ученик — member_id, ник, герой, XP недели, место и разрешённые значки (≤ 3); счёт соперника — только
 * в завершённой дуэли (status finished; иначе result = null — защита в глубину). Картинки героев — url BFF (как в спринте 6).
 * Дети (6–13: детский профиль или детская полоса): лиги друзей и общей нет — friends = null, общая недоступна (kids), даже
 * если домен прислал иное (в лог — предупреждение).
 *
 * Лимиты на ученика: tg.game.read (чтение, 120/мин), tg.duel.write (вызов, принятие, отказ — 20/мин).
 */
import type * as C from "@tilhero/contracts/bff";
import type { Static, TSchema } from "@fastify/type-provider-typebox";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, idempotencyKey, schemaErrors, type App } from "../http.js";
import {
  CursorOnlyQuerySchema,
  DuelChallengeRequestSchema,
  DuelPageSchema,
  DuelParamsSchema,
  DuelsQuerySchema,
  IdempotencyHeadersSchema,
  LeagueHistoryPageSchema,
  LeagueResultSchema,
  SocialDomain,
  SocialView,
} from "../schemas.js";
import { createdStatus, isChildProfile, KID_BANDS } from "../socialApi.js";
import type { AccessClaims } from "../tokens.js";
import { GAME_SERVICE } from "../upstream.js";
import { pageView } from "./content.js";
import { asGameError, gameApi } from "./game.js";

const user = { access: "user" } as const;
const READ = "tg.game.read";
const DUEL_WRITE = "tg.duel.write";
const enc = encodeURIComponent;
/** Строк рейтинга — не больше 50, значков у строки — не больше 3 (bff.ts Standings, StandingRow). */
const MAX_ROWS = 50;
const MAX_BADGES = 3;

const duelNotFound = schemaErrors([{ context: "params", status: 404, code: "DUEL_NOT_FOUND", message: "Дуэль не найдена" }]);

type D<K extends keyof typeof SocialDomain> = Static<(typeof SocialDomain)[K]>;

export function leaguesRoutes(app: App, ctx: BffContext): void {
  const { call, callWithStatus, shape, img } = gameApi(ctx);
  const log = ctx.log;

  /** 6–13: детский профиль или детская полоса активного ученика (полоса — из кеша AudienceResolver). */
  const kidsOf = async (auth: AccessClaims): Promise<boolean> => {
    if (isChildProfile(auth)) return true;
    const band = await ctx.audience.learnerBand(ctx, auth);
    return band !== null && KID_BANDS.has(band);
  };

  // ---------------------------------------------------------------- сборка ответов (только поля контракта, явно)
  const heroView = (what: string, h: D<"MemberHero"> | null): C.MemberHero | null =>
    h ? { code: h.code, stage: h.stage, image: img(what, h.image) } : null;
  const rowView = (r: D<"StandingRow">): C.StandingRow => ({
    member_id: r.member_id,
    nickname: r.nickname,
    hero: heroView("leagues.row.hero.image", r.hero),
    xp: r.xp,
    place: r.place,
    badges: r.badges.slice(0, MAX_BADGES),
    me: r.me,
  });
  const standingsView = (s: D<"Standings"> | null): C.Standings | null =>
    s ? { rows: s.rows.slice(0, MAX_ROWS).map(rowView), me_row: s.me_row ? rowView(s.me_row) : null, participants: s.participants, total_xp: s.total_xp } : null;
  function leaguesView(v: D<"LeaguesView">, kids: boolean): C.LeaguesView {
    const g = v.general;
    if (kids && (v.friends !== null || g.opt_in || g.available || g.group !== null)) {
      log.warn({ upstream: GAME_SERVICE, check: "leagues", rule: "kids_no_strangers", upstream_code: "UPSTREAM_BAD_RESPONSE" }, "kids league view corrected");
    }
    return {
      week: v.week,
      ends_at: v.ends_at,
      friends: kids ? null : standingsView(v.friends),
      family: standingsView(v.family),
      general: kids
        ? { opt_in: false, available: false, unavailable_reason: "kids", pair_id: g.pair_id, level_band: g.level_band, group: null, prizes: [...g.prizes] }
        : {
            opt_in: g.opt_in,
            available: g.available,
            unavailable_reason: g.unavailable_reason,
            pair_id: g.pair_id,
            level_band: g.level_band,
            group: standingsView(g.group),
            prizes: [...g.prizes],
          },
    };
  }
  /** Дуэль для Mini App: счёт обоих — только после завершения (status finished). */
  const duelView = (d: D<"DuelView">): C.DuelView => ({
    duel_id: d.duel_id.toLowerCase(),
    status: d.status,
    role: d.role,
    opponent: { member_id: d.opponent.member_id, nickname: d.opponent.nickname, hero: heroView("duel.opponent.hero.image", d.opponent.hero) },
    pair_id: d.pair_id,
    level_band: d.level_band,
    created_at: d.created_at,
    accept_deadline: d.accept_deadline,
    play_deadline: d.play_deadline,
    my_session: d.my_session ? { session_id: d.my_session.session_id.toLowerCase(), status: d.my_session.status } : null,
    my_played: d.my_played,
    opponent_played: d.opponent_played,
    can_accept: d.can_accept,
    can_play: d.can_play,
    result:
      d.status === "finished" && d.result
        ? {
            outcome: d.result.outcome,
            technical: d.result.technical,
            my_score: d.result.my_score ? { ...d.result.my_score } : null,
            opponent_score: d.result.opponent_score ? { ...d.result.opponent_score } : null,
            xp: d.result.xp,
            version: d.result.version,
          }
        : null,
    finished_at: d.finished_at,
  });
  const duelOf = (raw: unknown) => duelView(shape("duel", SocialDomain.DuelView, raw));
  /** Список ответа gamification: элемент не по контракту отбрасывается (сбой формы — GAME_UNAVAILABLE). */
  function page<S extends TSchema, T>(what: string, item: S, raw: unknown, map: (x: Static<S>) => T): C.Page<T> {
    try {
      const p = pageView(ctx, GAME_SERVICE, what, item, raw);
      return { items: (p.items as Static<S>[]).map(map), next_cursor: p.next_cursor };
    } catch (err) {
      throw asGameError(err);
    }
  }
  const optionalKey = (req: { headers: Record<string, string | string[] | undefined> }) => {
    const key = idempotencyKey(req, false);
    return key ? { idempotencyKey: key } : {};
  };

  // ---------------------------------------------------------------- лиги недели (APP-SOC-08/09)
  app.get(
    "/v1/game/leagues",
    {
      config: user,
      schema: {
        tags: ["leagues"],
        summary: "Лиги недели: друзей, семейная, общая (14+, по желанию, только ник) — XP недели, места, герои, значки",
        description:
          "Неделя — пн 00:00 … вс 24:00 Asia/Tashkent. Рейтинг — ≤ 50 строк и моя строка. Детскому профилю — только семейная " +
          "(friends = null, общая недоступна: kids). Скрытый игровой профиль: себя видно, другим — нет. 503 GAME_UNAVAILABLE.",
        security: BEARER,
        response: { 200: SocialView.LeaguesView, ...errorResponses(401, 403, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const v = shape("leagues", SocialDomain.LeaguesView, await call(auth, READ, "GET", "/internal/v1/game/leagues"));
      return leaguesView(v, await kidsOf(auth));
    },
  );

  app.get(
    "/v1/game/leagues/history",
    {
      config: user,
      schema: {
        tags: ["leagues"],
        summary: "Мои итоги общей лиги прошлых недель (последняя версия итогов группы), новые сверху",
        description: "?cursor=. prize_held — приз удержан до решения администратора; version — номер переоценки.",
        security: BEARER,
        querystring: CursorOnlyQuerySchema,
        response: { 200: LeagueHistoryPageSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const raw = await call(authOf(req), READ, "GET", "/internal/v1/game/leagues/history", { query: { cursor: req.query.cursor } });
      return page("leagues_history", LeagueResultSchema, raw, (r: C.LeagueResult): C.LeagueResult => ({ ...r }));
    },
  );

  // ---------------------------------------------------------------- дуэли (APP-SOC-07)
  app.post(
    "/v1/game/duels",
    {
      config: user,
      schema: {
        tags: ["duels"],
        summary: "Вызвать на дуэль друга (14+) или члена семьи по member_id → DuelView (201)",
        description:
          "Idempotency-Key (UUID) обязателен: повтор — тот же ответ. pair_id по умолчанию — активная пара. 409 DUELS_LIMIT (≤ 3 " +
          "активных вызова) | DUEL_EXISTS {duel_id} | LEVELS_INCOMPATIBLE; 403 BLOCKED | SOCIAL_RESTRICTED {until} | PARTNER_NOT_ALLOWED " +
          "| FRIENDS_NOT_ALLOWED {reason}; 404 MEMBER_NOT_FOUND; себе — 422 VALIDATION_ERROR. Лимит tg.duel.write.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: DuelChallengeRequestSchema,
        response: { 200: SocialView.DuelView, 201: SocialView.DuelView, ...errorResponses(401, 403, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const key = idempotencyKey(req, true)!;
      const b = req.body;
      const res = await callWithStatus(authOf(req), DUEL_WRITE, "POST", "/internal/v1/game/duels", {
        body: { opponent_member_id: b.opponent_member_id, ...(b.pair_id !== undefined ? { pair_id: b.pair_id } : {}) },
        idempotencyKey: key,
      });
      return reply.code(createdStatus(res.status)).send(duelOf(res.body));
    },
  );

  app.get(
    "/v1/game/duels",
    {
      config: user,
      schema: {
        tags: ["duels"],
        summary: "Мои дуэли: active (вызовы и принятые) или finished; соперник — member_id и ник",
        description: "?status=active|finished, ?cursor=. Счёт — только у завершённых.",
        security: BEARER,
        querystring: DuelsQuerySchema,
        response: { 200: DuelPageSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const raw = await call(authOf(req), READ, "GET", "/internal/v1/game/duels", { query: { status: req.query.status, cursor: req.query.cursor } });
      return page("duels", SocialDomain.DuelView, raw, duelView);
    },
  );

  app.get(
    "/v1/game/duels/:duel_id",
    {
      config: user,
      schemaErrorFormatter: duelNotFound,
      schema: {
        tags: ["duels"],
        summary: "Карточка дуэли (ссылка duel_<duel_id>)",
        description: "404 DUEL_NOT_FOUND — нет или чужая (неотличимо).",
        security: BEARER,
        params: DuelParamsSchema,
        response: { 200: SocialView.DuelView, ...errorResponses(401, 404, 410, 423) },
      },
    },
    async (req) => duelOf(await call(authOf(req), READ, "GET", `/internal/v1/game/duels/${enc(req.params.duel_id.toLowerCase())}`)),
  );

  for (const action of ["accept", "decline"] as const) {
    app.post(
      `/v1/game/duels/:duel_id/${action}`,
      {
        config: user,
        schemaErrorFormatter: duelNotFound,
        schema: {
          tags: ["duels"],
          summary: action === "accept" ? "Принять вызов → DuelView (набор заданий выдаёт lessons)" : "Отказаться от вызова → DuelView",
          description:
            (action === "accept" ? "503 DUEL_SET_UNAVAILABLE — набор не выдан, дуэль остаётся challenged, можно повторить. " : "") +
            "Повтор с тем же исходом — 200; иначе 409 DUEL_STATE {status}; 404 DUEL_NOT_FOUND. Лимит tg.duel.write.",
          security: BEARER,
          params: DuelParamsSchema,
          headers: IdempotencyHeadersSchema,
          response: { 200: SocialView.DuelView, ...errorResponses(401, 403, 404, 409, 410, 423) },
        },
      },
      async (req) => duelOf(await call(authOf(req), DUEL_WRITE, "POST", `/internal/v1/game/duels/${enc(req.params.duel_id.toLowerCase())}/${action}`, optionalKey(req))),
    );
  }
}
