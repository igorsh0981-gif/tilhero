/**
 * Спринт 7 — задания дуэли и парный урок в lessons (bff.ts «Спринт 7», INTERNAL_API спринта 7 §3.1, §3.2, §9).
 *
 * lessons вызывается от имени активного ученика (socialApi.ts): sub = аккаунт, claims lrn и age_band активного ученика,
 * query `locale` — язык ученика (перевод подсказки коуча). Пути домена — `/internal/v1/me/duel-sessions…`,
 * `/internal/v1/me/pair-rooms…`. Дальше сессия дуэли идёт общими маршрутами /v1/sessions/{id}/… (routes/lessons.ts).
 *
 * Лента комнаты — long-poll: lessons держит GET …/state до 25 с, BFF ждёт PAIR_ROOM_POLL_TIMEOUT_MS (30 с; > 25 с), без
 * повторов; клиент закрыл соединение — вызов lessons прерывается (AbortSignal), ответа нет. Таймаут — 503
 * UPSTREAM_UNAVAILABLE {service: lessons}. Вход, ход и выход синхронно ждут ИИ-коуча — PAIR_ROOM_COACH_TIMEOUT_MS (30 с;
 * ≥ 25 с), команды не повторяются (ход идемпотентен по Idempotency-Key — повтор только с тем же ключом, его делает клиент).
 *
 * Голос (POST …/audio): своя область Fastify, как произношение спринта 5 — тело audio/wav ≤ 600 000 байт, заголовок WAV
 * (PCM 16 бит, моно, 16 кГц, 0,5..15 с) проверяется до lessons (422 AUDIO_INVALID {reason}); детский профиль — 403
 * KIDS_NOT_ALLOWED до чтения тела (onRequest маршрута); лимит tg.room.audio; аудио — только в памяти на время запроса.
 *
 * Дети (6–13): свободный текст хода — 403 KIDS_NOT_ALLOWED до lessons; режим комнаты — choices, голос недоступен
 * (защита в глубину: даже если домен прислал иное). Приватность: партнёр — member_id, ник, герой; участники ленты —
 * только роли A/B; отчёт — только свой (чужие реплики, ошибки и оценка в контракте отсутствуют).
 *
 * Лимиты на ученика: tg.duel.write (сессия дуэли), tg.room.write (приглашение, ответ, вход, выход, ход — 60/мин),
 * tg.room.poll (лента и heartbeat — 240/мин), tg.room.audio (30 за 10 минут); чтение — общий tg.user.
 * Ошибки lessons — как есть (в т. ч. 409 FREE_TEXT_NOT_ALLOWED, DUEL_SET_CONFLICT, 503 SPEECH_UNAVAILABLE); недоступность
 * и ответ не по контракту → 503
 * UPSTREAM_UNAVAILABLE {service: lessons}. Тексты ходов, подсказки и аудио в лог не пишутся.
 */
import { Type, type Static, type TSchema, type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type * as C from "@tilhero/contracts/bff";
import type { Localized } from "@tilhero/contracts/content";
import type { FastifyError } from "fastify";
import { expectShape } from "../check.js";
import type { BffContext } from "../context.js";
import { BEARER, authOf, errorResponses, idempotencyKey, localeOf, schemaErrors, type App, type LocaleSource } from "../http.js";
import {
  DuelReviewSchema,
  DuelSessionParamsSchema,
  DuelSessionRequestSchema,
  IdempotencyHeadersSchema,
  LessonSessionDomainSchema,
  LessonSessionSchema,
  PairAudioSchema,
  PairRoomInviteSchema,
  PairRoomPageSchema,
  PairRoomParamsSchema,
  PairRoomReportSchema,
  PairRoomStateDomainSchema,
  PairRoomStateQuerySchema,
  PairRoomStateSchema,
  PairRoomsQuerySchema,
  PairTurnRequestSchema,
  SocialDomain,
  SocialView,
} from "../schemas.js";
import { createdStatus, isChildProfile, kidsNotAllowed, learnerCall, validationError } from "../socialApi.js";
import type { AccessClaims } from "../tokens.js";
import { upstreamUnavailable, type RawMethod, type RawRequest } from "../upstream.js";
import { WAV_MAX_BYTES, audioInvalid, checkWav } from "../wav.js";
import { pageView } from "./content.js";
import { imageView } from "./game.js";
import { sessionView } from "./lessons.js";
import { WAV_CONTENT_TYPE, mapBodyError } from "./pronunciation.js";

const user = { access: "user" } as const;
const LESSONS = "lessons";
const DUEL_WRITE = "tg.duel.write";
const ROOM_WRITE = "tg.room.write";
const ROOM_POLL = "tg.room.poll";
const ROOM_AUDIO = "tg.room.audio";
const ME = "/internal/v1/me";
const enc = encodeURIComponent;
/** Событий в одном ответе ленты — не больше 50 (bff.ts PairRoomState.events); вариантов реплики — не больше 3. */
const MAX_EVENTS = 50;
const MAX_OPTIONS = 3;
/** Запланированный старт — не дальше 7 дней; допуск на расхождение часов с клиентом — минута. */
const START_MAX_MS = 7 * 24 * 3600 * 1000;
const CLOCK_SKEW_MS = 60_000;

const roomNotFound = schemaErrors([{ context: "params", status: 404, code: "ROOM_NOT_FOUND", message: "Комната не найдена" }]);
const sessionNotFound = schemaErrors([{ context: "params", status: 404, code: "SESSION_NOT_FOUND", message: "Сессия не найдена" }]);
const kidsText = () => kidsNotAllowed("В детском профиле реплика выбирается из готовых вариантов");
const kidsVoice = () => kidsNotAllowed("В детском профиле голосовой ход недоступен — выберите реплику");

type D<K extends keyof typeof SocialDomain> = Static<(typeof SocialDomain)[K]>;
type DomainState = Static<typeof PairRoomStateDomainSchema>;

const loc = (x: Localized): Localized => ({ ru: x.ru, uz: x.uz });

/** Старт приглашения: "now" или время не в прошлом и не дальше 7 дней (минута допуска на часы клиента). */
export function checkStart(start: string, now = Date.now()): void {
  if (start === "now") return;
  const t = Date.parse(start);
  if (!Number.isFinite(t) || t < now - CLOCK_SKEW_MS || t > now + START_MAX_MS + CLOCK_SKEW_MS) throw validationError("start", "range");
}

/** Лента комнаты для Mini App: перевод подсказки — на языке ученика; ребёнку — выбор реплик без голоса; событий ≤ 50
 *  (больше — первые 50, seq — последнего отданного: следующий запрос after_seq заберёт остальные). */
export function stateView(s: DomainState, locale: "ru" | "uz", kids: boolean): C.PairRoomState {
  const events = s.events.slice(0, MAX_EVENTS);
  const truncated = s.events.length > MAX_EVENTS;
  return {
    room_id: s.room_id.toLowerCase(),
    status: s.status,
    seq: truncated ? events[events.length - 1]!.seq : s.seq,
    events: events.map((e) => ({ seq: e.seq, kind: e.kind, role: e.role, text: e.text, at: e.at })),
    mode: kids ? "choices" : s.mode,
    my_role: s.my_role,
    my_role_brief: s.my_role_brief,
    team_goal: s.team_goal,
    team_goal_progress: s.team_goal_progress,
    next_speaker: s.next_speaker,
    prompt: s.prompt,
    prompt_gloss: s.prompt_gloss === null ? null : typeof s.prompt_gloss === "string" ? s.prompt_gloss : s.prompt_gloss[locale],
    options: s.options ? s.options.slice(0, MAX_OPTIONS).map((o) => ({ choice_id: o.choice_id, text_en: o.text_en })) : null,
    participants: s.participants.map((p) => ({ role: p.role, me: p.me, network: p.network })),
    ai_degraded: s.ai_degraded,
    voice_available: kids ? false : s.voice_available,
    my_speaking_seconds: s.my_speaking_seconds,
  };
}

export const reportView = (r: C.PairRoomReport): C.PairRoomReport => ({
  room_id: r.room_id.toLowerCase(),
  scenario: { scenario_id: r.scenario.scenario_id, title: loc(r.scenario.title) },
  status: r.status,
  end_reason: r.end_reason,
  ended_at: r.ended_at,
  team: { goal_reached: r.team.goal_reached, progress: r.team.progress, summary: r.team.summary ? loc(r.team.summary) : null },
  me: {
    role: r.me.role,
    contributed: r.me.contributed,
    turns: r.me.turns,
    speaking_seconds: r.me.speaking_seconds,
    minutes: r.me.minutes,
    lines: r.me.lines.map((l) => ({ text: l.text, at: l.at })),
    skills: r.me.skills.map((x) => ({ skill_id: x.skill_id, title: loc(x.title) })),
    tips: r.me.tips.slice(0, 3).map(loc),
    evaluation_id: r.me.evaluation_id ? r.me.evaluation_id.toLowerCase() : null,
  },
});

export async function pairRoomsRoutes(app: App, ctx: BffContext): Promise<void> {
  const lessons = ctx.domains.lessons;
  const log = ctx.log;
  const room = (id: string) => `${ME}/pair-rooms/${enc(id.toLowerCase())}`;

  /** Вызов lessons от имени активного ученика; policy — лимит на ученика (null — только общий tg.user). */
  async function call(
    auth: AccessClaims,
    policy: string | null,
    method: RawMethod,
    path: string,
    extra: Pick<RawRequest, "query" | "body" | "idempotencyKey" | "rawBody" | "timeoutMs" | "retries" | "signal"> = {},
    req?: LocaleSource,
  ) {
    if (policy) await ctx.limiter.enforce(policy, auth.learnerId);
    const lc = await learnerCall(ctx, auth);
    const { query, ...rest } = extra;
    const res = await lessons.jsonWithStatus<unknown>(method, path, { ...lc.ro, ...rest, query: { ...(req ? { locale: localeOf(req) } : {}), ...query } });
    return { ...res, kids: lc.kids };
  }
  const shape = <S extends TSchema>(what: string, schema: S, raw: unknown): Static<S> => expectShape(log, LESSONS, what, schema, raw);
  const optionalKey = (req: { headers: Record<string, string | string[] | undefined> }) => {
    const key = idempotencyKey(req, false);
    return key ? { idempotencyKey: key } : {};
  };

  const roomView = (r: D<"PairRoomView">, kids: boolean): C.PairRoomView => ({
    room_id: r.room_id.toLowerCase(),
    status: r.status,
    side: r.side,
    partner: {
      member_id: r.partner.member_id,
      nickname: r.partner.nickname,
      hero: r.partner.hero
        ? { code: r.partner.hero.code, stage: r.partner.hero.stage, image: imageView(log, LESSONS, "pair_room.partner.hero.image", r.partner.hero.image, () => upstreamUnavailable(LESSONS)) }
        : null,
    },
    pair_id: r.pair_id,
    scenario: { scenario_id: r.scenario.scenario_id, title: loc(r.scenario.title), level: r.scenario.level },
    mode: kids ? "choices" : r.mode,
    start_at: r.start_at,
    respond_until: r.respond_until,
    created_at: r.created_at,
    started_at: r.started_at,
    ended_at: r.ended_at,
    end_reason: r.end_reason,
    my_role: r.my_role,
    can_accept: r.can_accept,
    can_join: r.can_join,
    minutes: r.minutes,
    report_available: r.report_available,
  });
  const roomOf = (raw: unknown, kids: boolean) => roomView(shape("pair_room", SocialDomain.PairRoomView, raw), kids);
  const stateOf = (raw: unknown, req: LocaleSource, kids: boolean, what = "pair_room_state") => stateView(shape(what, PairRoomStateDomainSchema, raw), localeOf(req), kids);

  // ---------------------------------------------------------------- задания дуэли (§3.1)
  app.post(
    "/v1/duel-sessions",
    {
      config: user,
      schema: {
        tags: ["duels"],
        summary: "Начать задания дуэли → сессия kind duel (201; повтор — 200 та же сессия, одна на участника)",
        description:
          "Idempotency-Key (UUID) обязателен. Только участник принятой дуэли до play_deadline: 409 DUEL_CLOSED | DUEL_SET_CONFLICT; " +
          "404 DUEL_NOT_FOUND. " +
          "Дальше — общие маршруты /v1/sessions/{id}/… (шаги item без подсказок и ИИ; finish — без оценки). Лимит tg.duel.write.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: DuelSessionRequestSchema,
        response: { 200: LessonSessionSchema, 201: LessonSessionSchema, ...errorResponses(401, 403, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const key = idempotencyKey(req, true)!;
      const res = await call(authOf(req), DUEL_WRITE, "POST", `${ME}/duel-sessions`, { body: { duel_id: req.body.duel_id.toLowerCase() }, idempotencyKey: key }, req);
      return reply.code(createdStatus(res.status)).send(sessionView(shape("duel_session", LessonSessionDomainSchema, res.body), res.kids));
    },
  );

  app.get(
    "/v1/duel-sessions/:session_id/review",
    {
      config: user,
      schemaErrorFormatter: sessionNotFound,
      schema: {
        tags: ["duels"],
        summary: "Разбор своих ответов дуэли — только после завершения дуэли (ответов соперника нет никогда)",
        description: "409 DUEL_NOT_FINISHED — дуэль не завершена; 404 SESSION_NOT_FOUND — нет или чужая.",
        security: BEARER,
        params: DuelSessionParamsSchema,
        response: { 200: DuelReviewSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const res = await call(authOf(req), null, "GET", `${ME}/duel-sessions/${enc(req.params.session_id.toLowerCase())}/review`, {}, req);
      const r = shape("duel_review", DuelReviewSchema, res.body);
      return {
        session_id: r.session_id.toLowerCase(),
        duel_id: r.duel_id.toLowerCase(),
        score: { correct: r.score.correct, total: r.score.total },
        items: r.items.map((i) => ({ item_id: i.item_id, prompt_en: i.prompt_en, your_answer: i.your_answer, correct_answer: i.correct_answer, correct: i.correct })),
      };
    },
  );

  // ---------------------------------------------------------------- парные комнаты (§3.2): приглашение и список
  app.post(
    "/v1/pair-rooms",
    {
      config: user,
      schema: {
        tags: ["pair-rooms"],
        summary: "Пригласить друга (14+) или члена семьи в парный урок по сценарию → PairRoomView (201)",
        description:
          "Idempotency-Key (UUID) обязателен. start — now или ISO-8601 не дальше 7 дней (иначе 422 VALIDATION_ERROR). 409 ROOM_LIMIT " +
          "{room_id} | PAIR_NOT_AVAILABLE; 403 BLOCKED | SOCIAL_RESTRICTED {until} | PARTNER_NOT_ALLOWED | FRIENDS_NOT_ALLOWED {reason}; " +
          "404 MEMBER_NOT_FOUND | LESSON_NOT_AVAILABLE. Детям — только выбор реплик. Лимит tg.room.write.",
        security: BEARER,
        headers: IdempotencyHeadersSchema,
        body: PairRoomInviteSchema,
        response: { 200: SocialView.PairRoomView, 201: SocialView.PairRoomView, ...errorResponses(401, 403, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const key = idempotencyKey(req, true)!;
      const b = req.body;
      checkStart(b.start);
      const res = await call(
        authOf(req),
        ROOM_WRITE,
        "POST",
        `${ME}/pair-rooms`,
        { body: { partner_member_id: b.partner_member_id, pair_id: b.pair_id, scenario_id: b.scenario_id, start: b.start }, idempotencyKey: key },
        req,
      );
      return reply.code(createdStatus(res.status)).send(roomOf(res.body, res.kids));
    },
  );

  app.get(
    "/v1/pair-rooms",
    {
      config: user,
      schema: {
        tags: ["pair-rooms"],
        summary: "Мои парные уроки: active (приглашения в обе стороны и комнаты) или finished",
        description: "?status=active|finished, ?cursor=.",
        security: BEARER,
        querystring: PairRoomsQuerySchema,
        response: { 200: PairRoomPageSchema, ...errorResponses(401, 410, 423) },
      },
    },
    async (req) => {
      const res = await call(authOf(req), null, "GET", `${ME}/pair-rooms`, { query: { status: req.query.status, cursor: req.query.cursor } }, req);
      const page = pageView(ctx, LESSONS, "pair_rooms", SocialDomain.PairRoomView, res.body);
      return { items: (page.items as D<"PairRoomView">[]).map((r) => roomView(r, res.kids)), next_cursor: page.next_cursor };
    },
  );

  app.get(
    "/v1/pair-rooms/:room_id",
    {
      config: user,
      schemaErrorFormatter: roomNotFound,
      schema: {
        tags: ["pair-rooms"],
        summary: "Парный урок: приглашение, комната или итог (ссылка room_<room_id>)",
        description: "404 ROOM_NOT_FOUND — нет или чужая (неотличимо).",
        security: BEARER,
        params: PairRoomParamsSchema,
        response: { 200: SocialView.PairRoomView, ...errorResponses(401, 404, 410, 423) },
      },
    },
    async (req) => {
      const res = await call(authOf(req), null, "GET", room(req.params.room_id), {}, req);
      return roomOf(res.body, res.kids);
    },
  );

  // ---------------------------------------------------------------- ответ на приглашение, выход
  for (const action of ["accept", "decline", "cancel", "leave"] as const) {
    app.post(
      `/v1/pair-rooms/:room_id/${action}`,
      {
        config: user,
        schemaErrorFormatter: roomNotFound,
        schema: {
          tags: ["pair-rooms"],
          summary: {
            accept: "Принять приглашение (приглашённый, invited) → PairRoomView",
            decline: "Отклонить приглашение (приглашённый, invited) → PairRoomView",
            cancel: "Отменить до старта (любой участник, invited или waiting) → PairRoomView (cancelled)",
            leave: "Выйти из комнаты (возврат в течение 3 минут — та же комната) → PairRoomView",
          }[action],
          description:
            action === "leave"
              ? "409 ROOM_NOT_ACTIVE {status}; 404 ROOM_NOT_FOUND. Лимит tg.room.write."
              : "Повтор с тем же исходом — 200; иначе 409 ROOM_STATE {status}; 404 ROOM_NOT_FOUND. Лимит tg.room.write.",
          security: BEARER,
          params: PairRoomParamsSchema,
          headers: IdempotencyHeadersSchema,
          response: { 200: SocialView.PairRoomView, ...errorResponses(401, 403, 404, 409, 410, 423) },
        },
      },
      async (req) => {
        // выход может завершить комнату — lessons ждёт итоговый отчёт коуча (trigger end)
        const timeout = action === "leave" ? { timeoutMs: ctx.config.pairRoomCoachTimeoutMs } : {};
        const res = await call(authOf(req), ROOM_WRITE, "POST", `${room(req.params.room_id)}/${action}`, { ...optionalKey(req), ...timeout }, req);
        return roomOf(res.body, res.kids);
      },
    );
  }

  // ---------------------------------------------------------------- комната: вход, присутствие, лента, ходы
  app.post(
    "/v1/pair-rooms/:room_id/join",
    {
      config: user,
      schemaErrorFormatter: roomNotFound,
      schema: {
        tags: ["pair-rooms"],
        summary: "Войти в комнату → PairRoomState (оба вошли — in_progress, коуч раздаёт роли и цель)",
        description:
          "Повторный вход и возврат ≤ 3 мин — та же комната, без новой сессии. 409 ROOM_NOT_ACTIVE {status}. Ждёт ИИ-коуча " +
          "(PAIR_ROOM_COACH_TIMEOUT_MS), без повторов. Лимит tg.room.write.",
        security: BEARER,
        params: PairRoomParamsSchema,
        headers: IdempotencyHeadersSchema,
        response: { 200: PairRoomStateSchema, ...errorResponses(401, 403, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const res = await call(authOf(req), ROOM_WRITE, "POST", `${room(req.params.room_id)}/join`, { ...optionalKey(req), timeoutMs: ctx.config.pairRoomCoachTimeoutMs }, req);
      return stateOf(res.body, req, res.kids);
    },
  );

  app.post(
    "/v1/pair-rooms/:room_id/heartbeat",
    {
      config: user,
      schemaErrorFormatter: roomNotFound,
      schema: {
        tags: ["pair-rooms"],
        summary: "Присутствие в комнате (каждые 10 с; без него 30 с — offline, в свой ход — paused) → 204",
        description: "409 ROOM_NOT_ACTIVE {status}. Лимит tg.room.poll.",
        security: BEARER,
        params: PairRoomParamsSchema,
        response: { 204: Type.Null({ description: "Принято" }), ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      await call(authOf(req), ROOM_POLL, "POST", `${room(req.params.room_id)}/heartbeat`);
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/v1/pair-rooms/:room_id/state",
    {
      config: user,
      schemaErrorFormatter: roomNotFound,
      schema: {
        tags: ["pair-rooms"],
        summary: "Лента комнаты — long-poll до 25 с: сразу, если есть события новее after_seq или сменился статус",
        description:
          "?after_seq=N (последний полученный seq), ?locale=ru|uz — язык перевода подсказки (иначе Accept-Language). Иначе — по " +
          "истечении ожидания с events []. Тексты реплик видят только участники. Клиент закрыл соединение — запрос к lessons " +
          "прерывается. Лимит tg.room.poll (240 в минуту).",
        security: BEARER,
        params: PairRoomParamsSchema,
        querystring: PairRoomStateQuerySchema,
        response: { 200: PairRoomStateSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req, reply) => {
      const auth = authOf(req);
      // клиент закрыл соединение до ответа — ожидание в lessons больше никому не нужно
      const abort = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) abort.abort();
      };
      reply.raw.once("close", onClose);
      try {
        const res = await call(
          auth,
          ROOM_POLL,
          "GET",
          `${room(req.params.room_id)}/state`,
          {
            query: { after_seq: req.query.after_seq },
            timeoutMs: ctx.config.pairRoomPollTimeoutMs,
            retries: 0,
            signal: abort.signal,
          },
          req,
        );
        return stateOf(res.body, req, res.kids);
      } catch (err) {
        if (abort.signal.aborted) log.info({ upstream: LESSONS, route: "pair_room_state" }, "long-poll cancelled by client");
        throw err;
      } finally {
        reply.raw.off("close", onClose);
      }
    },
  );

  app.post(
    "/v1/pair-rooms/:room_id/turns",
    {
      config: user,
      schemaErrorFormatter: roomNotFound,
      schema: {
        tags: ["pair-rooms"],
        summary: "Ход: ровно одно из text (≤ 300), choice_id (из options) или audio_id (после POST …/audio) → PairRoomState",
        description:
          "Idempotency-Key (UUID) обязателен: повтор ключа — тот же ответ, без второго хода. Детский профиль: text — 403 " +
          "KIDS_NOT_ALLOWED (только выбор реплик). 409 NOT_YOUR_TURN | ROOM_NOT_ACTIVE {status} | FREE_TEXT_NOT_ALLOWED (комната в " +
          "режиме выбора реплик). Ждёт ИИ-коуча (PAIR_ROOM_COACH_TIMEOUT_MS), без повторов. Лимит tg.room.write. Текст в лог не пишется.",
        security: BEARER,
        params: PairRoomParamsSchema,
        headers: IdempotencyHeadersSchema,
        body: PairTurnRequestSchema,
        response: { 200: PairRoomStateSchema, ...errorResponses(401, 403, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const key = idempotencyKey(req, true)!;
      const b = req.body;
      if (b.text !== undefined) {
        // свободный текст детям (детский профиль или детская полоса аккаунта) — до lessons; lessons проверяет и сам
        if (isChildProfile(auth) || (await learnerCall(ctx, auth)).kids) throw kidsText();
      }
      const body: C.PairTurnRequest =
        b.text !== undefined ? { text: b.text.trim() } : b.choice_id !== undefined ? { choice_id: b.choice_id } : { audio_id: b.audio_id! };
      const res = await call(auth, ROOM_WRITE, "POST", `${room(req.params.room_id)}/turns`, { body, idempotencyKey: key, timeoutMs: ctx.config.pairRoomCoachTimeoutMs }, req);
      return stateOf(res.body, req, res.kids);
    },
  );

  app.get(
    "/v1/pair-rooms/:room_id/report",
    {
      config: user,
      schemaErrorFormatter: roomNotFound,
      schema: {
        tags: ["pair-rooms"],
        summary: "Мой отчёт о парном уроке: мои реплики, секунды, навыки, 1–3 подсказки, итог команды",
        description: "Только свой; после завершения комнаты (раньше — 409 ROOM_STATE {status}). Чужие реплики, ошибки и оценка не показываются.",
        security: BEARER,
        params: PairRoomParamsSchema,
        response: { 200: PairRoomReportSchema, ...errorResponses(401, 404, 409, 410, 423) },
      },
    },
    async (req) => {
      const res = await call(authOf(req), null, "GET", `${room(req.params.room_id)}/report`, {}, req);
      return reportView(shape("pair_room_report", PairRoomReportSchema, res.body));
    },
  );

  // ---------------------------------------------------------------- голосовой ход: своя область (audio/wav)
  await app.register(async (scope) => {
    const typed = scope.withTypeProvider<TypeBoxTypeProvider>();
    typed.removeAllContentTypeParsers();
    typed.addContentTypeParser(WAV_CONTENT_TYPE, { parseAs: "buffer", bodyLimit: WAV_MAX_BYTES }, (_req, body, done) => done(null, body));
    const parent = typed.errorHandler;
    typed.setErrorHandler(function (err, req, reply) {
      return parent.call(this, mapBodyError(err as FastifyError) as FastifyError, req, reply);
    });

    typed.post(
      "/v1/pair-rooms/:room_id/audio",
      {
        config: user,
        bodyLimit: WAV_MAX_BYTES,
        // детский профиль — отказ до чтения тела (после общей авторизации onRequest)
        onRequest: async (req) => {
          if (isChildProfile(authOf(req))) throw kidsVoice();
        },
        schemaErrorFormatter: roomNotFound,
        schema: {
          tags: ["pair-rooms"],
          summary: "Голосовой ход: запись → распознанный текст для подтверждения (audio_id на 5 минут, один раз)",
          description:
            "Тело — audio/wav: PCM 16 бит, моно, 16 000 Гц, 0,5..15 с, ≤ 600 000 байт. 422 AUDIO_INVALID {reason: format | too_short " +
            "| too_long | too_large}; 403 VOICE_CONSENT_REQUIRED {who: self | guardian}; детский профиль — 403 KIDS_NOT_ALLOWED; 503 " +
            "SPEECH_UNAVAILABLE (перейти на текст); 409 NOT_YOUR_TURN | ROOM_NOT_ACTIVE {status}. Лимит tg.room.audio (30 за 10 минут). " +
            "Аудио не сохраняется и в лог не пишется.",
          consumes: ["audio/wav"],
          security: BEARER,
          params: PairRoomParamsSchema,
          response: { 200: PairAudioSchema, ...errorResponses(401, 403, 404, 409, 410, 423) },
        },
      },
      async (req) => {
        const auth = authOf(req);
        const bytes = req.body;
        if (!Buffer.isBuffer(bytes)) throw audioInvalid("format");
        const wav = checkWav(bytes);
        const lc = await learnerCall(ctx, auth);
        // детская полоса аккаунта (6–13): голос в комнате детям не разрешён
        if (lc.kids) throw kidsVoice();
        await ctx.limiter.enforce(ROOM_AUDIO, auth.learnerId);
        let raw: unknown;
        try {
          raw = await lessons.json("POST", `${room(req.params.room_id)}/audio`, { ...lc.ro, rawBody: { bytes, contentType: "audio/wav" } });
        } catch (err) {
          const e = err as { status?: number; code?: string };
          log.info({ audio_ms: wav.durationMs, upstream: LESSONS, upstream_status: e.status ?? 0, upstream_code: e.code ?? "UNKNOWN" }, "pair room audio not recognized");
          throw err;
        }
        const a = shape("pair_audio", PairAudioSchema, raw);
        log.info({ audio_ms: wav.durationMs }, "pair room audio recognized");
        return { audio_id: a.audio_id, text: a.text, duration_ms: a.duration_ms, expires_at: a.expires_at };
      },
    );
  });
}
