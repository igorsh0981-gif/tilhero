/**
 * Подделка доменов спринта 7 для тестов BFF (INTERNAL_API спринта 7 §1–§3, §9): social (профиль сообщества, друзья,
 * блокировки, жалобы, санкции, рефералы), gamification (лиги, дуэли), lessons (задания дуэли, парные комнаты).
 *
 * Ученик — из claim `lrn` (sub — аккаунт; без `lrn` — 401 USER_CONTEXT_MISSING). Ответы — формы bff.ts «Спринт 7» ПЛЮС
 * служебные поля доменов с чужими и своими user_id, Telegram, именем, флагами антифрода, исполнителем санкции,
 * чужими репликами и ответами — BFF обязан отбросить их (тест приватности). Переключатели — для проверки строгости.
 * Каждый обработчик возвращает null для чужого пути — дальше идут подделки прежних спринтов.
 */
import { createHash, randomUUID } from "node:crypto";
import type * as C from "@tilhero/contracts/bff";
import type { FakeGame } from "./fakeGame.js";
import type { Req } from "./helpers.js";

/** member_id подделки (формат как у social: mb_ + 22 символа base64url; вычисление — любое, не HMAC). */
export const memberIdOf = (userId: string): string => `mb_${createHash("sha256").update(`member:${userId}`).digest("base64url").slice(0, 22)}`;

/** Другой ученик (друг, соперник, партнёр): его user_id не должен встретиться ни в одном ответе BFF. */
export const OTHER_USER_ID = "7d1f6c2a-3b4e-4f50-8a61-92b3c4d5e6f7";
export const OTHER_MEMBER = memberIdOf(OTHER_USER_ID);
export const OTHER_NICK = "Anvar_77";
export const OTHER_CODE = "TH-AB2C-D3EF";
/** Заблокировавший ученика (заявка к нему — 403 BLOCKED). */
export const BLOCKED_USER_ID = "0b8a7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
export const BLOCKED_MEMBER = memberIdOf(BLOCKED_USER_ID);
/** Telegram и имя другого ученика — тоже не должны встретиться в ответах. */
export const OTHER_TELEGRAM_ID = 900777;
export const OTHER_NAME = "Анвар Каримов";
/** Метка служебных данных доменов (заметки модератора, флаги антифрода). */
export const SOCIAL_SECRET = "SOCIAL-STAFF-NOTE-77";

const AT = "2026-11-20T09:00:00Z";
const L = (ru: string) => ({ ru, uz: `${ru} (uz)` });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: string, details: Record<string, unknown> = {}) =>
  json(status, { code, message: `domain says ${code}`, trace_id: "domain-trace", details });
const KID_BANDS = new Set(["6-9", "10-13"]);

interface Learner {
  lrn: string;
  kids: boolean;
  band: string | null;
}

interface Idem {
  body: string;
  status: number;
  result: unknown;
}

export class FakeSocial {
  constructor(private readonly game: FakeGame) {}

  // ---------------------------------------------------------------- переключатели
  /** элемент списка с «сырым» UUID вместо member_id (BFF обязан отбросить) */
  rawUuidItem = false;
  /** профиль сообщества с «сырым» UUID вместо member_id (BFF — 503) */
  rawUuidProfile = false;
  /** причина недоступности социального в профиле сообщества (как social_reason social); undefined — по возрасту */
  friendsReason: "kids" | "guardian_consent" | "consent" | null | undefined = undefined;
  /** лиги ребёнку с лигой друзей и общей (BFF обязан скрыть) */
  kidsLeagueLeak = false;
  /** дуэль: счёт до завершения (BFF обязан скрыть) */
  duelScoreLeak = true;
  /** принятие дуэли: lessons не выдал набор */
  duelSetUnavailable = false;
  /** разбор дуэли: дуэль не завершена */
  duelNotFinished = false;
  /** перевод подсказки коуча — объектом {ru, uz} (иначе строкой) */
  glossAsObject = true;
  /** событий в ленте */
  stateEvents = 2;
  /** голос: ответ lessons */
  audioError: { status: number; code: string; details?: Record<string, unknown> } | null = null;

  // ---------------------------------------------------------------- состояние
  readonly nick = new Map<string, string | null>();
  readonly hidden = new Map<string, boolean>();
  readonly code = new Map<string, string>();
  readonly requests = new Map<string, C.FriendRequestView & { owner: string }>();
  readonly blocks = new Map<string, Set<string>>();
  readonly idem = new Map<string, Idem>();
  readonly duels = new Map<string, { owner: string; status: C.DuelStatus }>();
  readonly sessions = new Map<string, { owner: string; duel_id: string }>();
  readonly rooms = new Map<string, { owner: string; status: C.PairRoomStatus; scenario_id: string; start: string }>();
  readonly appeals = new Set<string>();
  readonly sanctionId = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";

  private learner(r: Req): Learner | Response {
    const lrn = typeof r.claims.lrn === "string" ? r.claims.lrn : null;
    if (!lrn) return err(401, "USER_CONTEXT_MISSING");
    const band = typeof r.claims.age_band === "string" ? r.claims.age_band : null;
    return { lrn, band, kids: lrn !== r.subject || (band !== null && KID_BANDS.has(band)) };
  }

  /** Создающая команда с Idempotency-Key: повтор ключа — тот же ответ (200), другое тело — 422 IDEMPOTENCY_KEY_REUSED. */
  private once(r: Req, l: Learner, make: () => Response | { status: number; result: unknown }): Response {
    const key = r.headers["idempotency-key"];
    if (!key) return err(422, "IDEMPOTENCY_KEY_REQUIRED");
    const k = `${l.lrn}:${r.path}:${key}`;
    const body = JSON.stringify(r.body ?? null);
    const prev = this.idem.get(k);
    if (prev) return prev.body === body ? json(200, prev.result) : err(422, "IDEMPOTENCY_KEY_REUSED");
    const out = make();
    if (out instanceof Response) return out;
    this.idem.set(k, { body, status: out.status, result: out.result });
    return json(out.status, out.result);
  }

  /** Ещё известные участники (члены семьи из теста). */
  readonly members = new Set<string>();

  private known(member: string): boolean {
    return member === OTHER_MEMBER || member === BLOCKED_MEMBER || this.members.has(member);
  }

  // ================================================================ social
  private profile(l: Learner): Record<string, unknown> {
    return {
      member_id: this.rawUuidProfile ? l.lrn : memberIdOf(l.lrn),
      nickname: this.nick.get(l.lrn) ?? null,
      friend_code: this.code.get(l.lrn) ?? "TH-QW3R-TY5U",
      game_profile_hidden: this.hidden.get(l.lrn) ?? false,
      restrictions: { social_ban: false, social_ban_until: null },
      nickname_change_available_at: null,
      friends_available: (this.friendsReason !== undefined ? this.friendsReason : l.kids ? "kids" : null) === null,
      friends_unavailable_reason: this.friendsReason !== undefined ? this.friendsReason : l.kids ? "kids" : null,
      // служебное домена
      user_id: l.lrn,
      telegram_user_id: 900001,
      display_name: "Игорь",
      age_band: l.band,
    };
  }

  private card(): Record<string, unknown> {
    return { member_id: OTHER_MEMBER, nickname: OTHER_NICK, relation: "none", request_id: null, user_id: OTHER_USER_ID, display_name: OTHER_NAME, telegram_user_id: OTHER_TELEGRAM_ID, age_band: "18+" };
  }

  private requestOut(id: string, owner: string, member: string, status: C.FriendRequestStatus): C.FriendRequestView & { owner: string } {
    return { request_id: id, direction: "out", member_id: member, nickname: OTHER_NICK, status, created_at: AT, decided_at: status === "pending" ? null : AT, owner };
  }
  private leakRequest(x: C.FriendRequestView): Record<string, unknown> {
    const { owner: _o, ...rest } = x as C.FriendRequestView & { owner?: string };
    return { ...rest, from_user_id: x.direction === "out" ? "me" : OTHER_USER_ID, to_user_id: OTHER_USER_ID };
  }

  private sanction(appealed: boolean): Record<string, unknown> {
    return {
      sanction_id: this.sanctionId,
      kind: "social_ban",
      basis: "Оскорбления в нике после предупреждения",
      decided_at: AT,
      until: "2026-11-27T09:00:00Z",
      active: true,
      revoked_at: null,
      appeal: appealed ? { appeal_id: "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e", status: "open", text: "Я исправил ник, прошу снять", created_at: AT, decided_at: null, decision_note: null, decided_by: "staff:moder-1" } : null,
      can_appeal: !appealed,
      decided_by: "staff:moder-1",
      case_id: randomUUID(),
      staff_comment: SOCIAL_SECRET,
    };
  }

  social(r: Req): Response | null {
    if (!r.path.startsWith("/internal/v1/me/") || r.path === "/internal/v1/me/family" || r.path.startsWith("/internal/v1/me/invites")) return null;
    const l = this.learner(r);
    if (l instanceof Response) return l;
    const p = r.path.slice("/internal/v1/me".length);
    const key = `${r.method} ${p}`;
    switch (key) {
      case "GET /community":
        return json(200, this.profile(l));
      case "PATCH /community":
        this.hidden.set(l.lrn, (r.body as C.CommunityPatch).game_profile_hidden ?? false);
        return json(200, this.profile(l));
      case "PUT /community/nickname": {
        const n = (r.body as C.NicknameRequest).nickname;
        if (n.toLowerCase() === "taken_nick") return err(409, "NICKNAME_TAKEN");
        if (n.toLowerCase() === "badword") return err(422, "NICKNAME_INVALID", { reason: "forbidden" });
        this.nick.set(l.lrn, n);
        return json(200, this.profile(l));
      }
      case "POST /community/friend-code:rotate":
        this.code.set(l.lrn, "TH-NEW2-CODE");
        return json(200, this.profile(l));
      case "GET /friends/search": {
        const q = (r.query.q ?? "").toLowerCase().replaceAll("-", "");
        const hit = q === OTHER_NICK.toLowerCase() || q === OTHER_CODE.toLowerCase().replaceAll("-", "");
        return json(200, { items: hit ? [this.card()] : [] });
      }
      case "POST /friend-requests":
        return this.once(r, l, () => {
          const m = (r.body as C.FriendRequestCreate).member_id;
          if (m === memberIdOf(l.lrn)) return err(422, "VALIDATION_ERROR", { field: "member_id" });
          if (!this.known(m)) return err(404, "MEMBER_NOT_FOUND");
          if (m === BLOCKED_MEMBER) return err(403, "BLOCKED");
          const id = randomUUID();
          const x = this.requestOut(id, l.lrn, m, "pending");
          this.requests.set(id, x);
          return { status: 201, result: this.leakRequest(x) };
        });
      case "GET /friend-requests": {
        const items = [...this.requests.values()].filter((x) => x.owner === l.lrn && x.direction === r.query.direction).map((x) => this.leakRequest(x));
        if (r.query.direction === "in") items.push(this.leakRequest({ ...this.requestOut(randomUUID(), l.lrn, OTHER_MEMBER, "pending"), direction: "in" }));
        if (this.rawUuidItem) items.push(this.leakRequest({ ...this.requestOut(randomUUID(), l.lrn, OTHER_USER_ID, "pending"), direction: "in" }));
        return json(200, { items, next_cursor: r.query.cursor ? null : "c2" });
      }
      case "GET /friends": {
        const items: Array<Record<string, unknown>> = [{ member_id: OTHER_MEMBER, nickname: OTHER_NICK, since: AT, user_id: OTHER_USER_ID, friend_code: OTHER_CODE, telegram_user_id: OTHER_TELEGRAM_ID }];
        if (this.rawUuidItem) items.push({ member_id: OTHER_USER_ID, nickname: "Leak", since: AT });
        return json(200, { items, next_cursor: null });
      }
      case "POST /blocks": {
        const m = (r.body as C.BlockRequest).member_id;
        if (!this.known(m)) return err(404, "MEMBER_NOT_FOUND");
        const set = this.blocks.get(l.lrn) ?? new Set<string>();
        const again = set.has(m);
        set.add(m);
        this.blocks.set(l.lrn, set);
        return json(again ? 200 : 201, { member_id: m, nickname: OTHER_NICK, created_at: AT, blocked_user_id: OTHER_USER_ID, blocker_user_id: l.lrn });
      }
      case "GET /blocks":
        return json(200, { items: [...(this.blocks.get(l.lrn) ?? [])].map((m) => ({ member_id: m, nickname: OTHER_NICK, created_at: AT, blocked_user_id: OTHER_USER_ID })) });
      case "POST /complaints":
        return this.once(r, l, () => {
          const b = r.body as C.ComplaintRequest;
          if (!this.known(b.member_id)) return err(404, "MEMBER_NOT_FOUND");
          return { status: 201, result: { case_id: randomUUID(), created_at: AT, blocked: b.block === true, target_user_id: OTHER_USER_ID, reporter_user_id: l.lrn, status: "open" } };
        });
      case "GET /sanctions":
        return json(200, { items: [this.sanction(this.appeals.has(l.lrn))] });
      case "GET /referrals":
        return json(200, {
          items: [
            {
              referral_id: "8c9d0e1f-2a3b-4c4d-9e5f-6a7b8c9d0e1f",
              invitee_nickname: OTHER_NICK,
              status: "learning",
              progress: { diagnostic: true, diagnostic_required: true, lessons: 2, lessons_required: 3, days: 1, days_required: 2, window_ends_at: "2026-12-20T09:00:00Z" },
              reward: null,
              reward_outcome: null,
              reject_code: null,
              legacy: false,
              accepted_at: AT,
              invitee_user_id: OTHER_USER_ID,
              risk_flags: ["short_lessons"],
              decision_note: SOCIAL_SECRET,
            },
          ],
          next_cursor: null,
          terms: { campaign_version: 1, require_diagnostic: true, min_lessons: 3, min_days: 2, window_days: 30, inviter_reward: { freeze: 2, til: 0 }, invitee_reward: { freeze: 0, til: 0 }, monthly_cap: 10, review: { velocity_per_day: 5 } },
          month: { qualified: 1, cap: 10 },
        });
    }
    const fr = /^\/friend-requests\/([^/]+)\/(accept|decline|cancel)$/.exec(p);
    if (fr && r.method === "POST") {
      const x = this.requests.get(fr[1]!);
      if (!x || x.owner !== l.lrn) return err(404, "REQUEST_NOT_FOUND");
      const to = { accept: "accepted", decline: "declined", cancel: "cancelled" }[fr[2] as "accept"] as C.FriendRequestStatus;
      if (x.status !== "pending" && x.status !== to) return err(409, "REQUEST_STATE", { status: x.status });
      x.status = to;
      x.decided_at = AT;
      return json(200, this.leakRequest(x));
    }
    const del = /^\/(friends|blocks)\/([^/]+)$/.exec(p);
    if (del && r.method === "DELETE") {
      if (del[1] === "blocks") this.blocks.get(l.lrn)?.delete(decodeURIComponent(del[2]!));
      return new Response(null, { status: 204 });
    }
    const ap = /^\/sanctions\/([^/]+)\/appeal$/.exec(p);
    if (ap && r.method === "POST") {
      if (ap[1] !== this.sanctionId) return err(404, "SANCTION_NOT_FOUND");
      return this.once(r, l, () => {
        if (this.appeals.has(l.lrn)) return err(409, "APPEAL_EXISTS");
        this.appeals.add(l.lrn);
        return { status: 201, result: this.sanction(true) };
      });
    }
    return err(404, "NOT_FOUND");
  }

  // ================================================================ gamification: лиги и дуэли
  private hero(): Record<string, unknown> {
    return { code: "robot_0", stage: 2, image: this.game.image("a-robot_0-2"), hero_user_id: OTHER_USER_ID };
  }
  private row(me: boolean, l: Learner, place: number): Record<string, unknown> {
    return {
      member_id: me ? memberIdOf(l.lrn) : OTHER_MEMBER,
      nickname: me ? (this.nick.get(l.lrn) ?? null) : OTHER_NICK,
      hero: me ? null : this.hero(),
      xp: me ? 120 : 340,
      place,
      badges: me ? [] : ["first_lesson", "streak_7", "together_1", "skills_10"],
      me,
      user_id: me ? l.lrn : OTHER_USER_ID,
      telegram_user_id: me ? 900001 : OTHER_TELEGRAM_ID,
      age_band: me ? l.band : "18+",
      purchases: 3,
      errors_week: 7,
    };
  }
  private standings(l: Learner, rows = 2): Record<string, unknown> {
    const list = [this.row(false, l, 1), this.row(true, l, 2)];
    for (let i = 2; i < rows; i++) list.push({ ...this.row(false, l, i + 1), member_id: memberIdOf(`filler-${i}`), user_id: randomUUID() });
    return { rows: list, me_row: null, participants: rows, total_xp: 460, group_id: randomUUID() };
  }
  leaguesRows = 2;

  private duelView(id: string, l: Learner, status: C.DuelStatus): Record<string, unknown> {
    const score = { correct: 7, total: 10 };
    return {
      duel_id: id,
      status,
      role: "challenger",
      opponent: { member_id: OTHER_MEMBER, nickname: OTHER_NICK, hero: this.hero(), user_id: OTHER_USER_ID },
      pair_id: "ru-en",
      level_band: "A2",
      created_at: AT,
      accept_deadline: "2026-11-21T09:00:00Z",
      play_deadline: status === "challenged" ? null : "2026-11-23T09:00:00Z",
      my_session: status === "accepted" || status === "finished" ? { session_id: "9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a", status: "in_progress" } : null,
      my_played: status === "finished",
      opponent_played: status === "finished",
      can_accept: false,
      can_play: status === "accepted",
      result:
        status === "finished" || this.duelScoreLeak
          ? { outcome: "win", technical: false, my_score: score, opponent_score: { correct: 5, total: 10 }, xp: 30, version: 1, opponent_answers: ["a", "b"] }
          : null,
      finished_at: status === "finished" ? AT : null,
      challenger_user_id: l.lrn,
      opponent_user_id: OTHER_USER_ID,
      scores: { [OTHER_USER_ID]: { correct: 5, total: 10 } },
    };
  }

  gameRoute(r: Req): Response | null {
    if (!r.path.startsWith("/internal/v1/game/leagues") && !r.path.startsWith("/internal/v1/game/duels")) return null;
    const l = this.learner(r);
    if (l instanceof Response) return l;
    const p = r.path.slice("/internal/v1/game".length);
    switch (`${r.method} ${p}`) {
      case "GET /leagues": {
        const general = l.kids && !this.kidsLeagueLeak
          ? { opt_in: false, available: false, unavailable_reason: "kids", pair_id: "ru-en", level_band: "A0-A1", group: null, prizes: [50, 30, 20] }
          : { opt_in: true, available: true, unavailable_reason: null, pair_id: "ru-en", level_band: "A2", group: this.standings(l, this.leaguesRows), prizes: [50, 30, 20] };
        return json(200, {
          week: "2026-11-16",
          ends_at: "2026-11-22T19:00:00Z",
          friends: l.kids && !this.kidsLeagueLeak ? null : this.standings(l),
          family: this.standings(l),
          general,
          user_id: l.lrn,
        });
      }
      case "GET /leagues/history":
        return json(200, {
          items: [{ week: "2026-11-09", pair_id: "ru-en", level_band: "A2", place: 2, participants: 24, xp: 410, prize_til: 30, prize_held: false, version: 1, closed_at: "2026-11-16T00:05:00Z", group_id: randomUUID(), user_id: l.lrn }],
          next_cursor: null,
        });
      case "POST /duels":
        return this.once(r, l, () => {
          const b = r.body as C.DuelChallengeRequest;
          if (!this.known(b.opponent_member_id)) return err(404, "MEMBER_NOT_FOUND");
          if (b.opponent_member_id === BLOCKED_MEMBER) return err(403, "BLOCKED");
          const id = randomUUID();
          this.duels.set(id, { owner: l.lrn, status: "challenged" });
          return { status: 201, result: this.duelView(id, l, "challenged") };
        });
      case "GET /duels": {
        const items = [...this.duels.entries()].filter(([, d]) => d.owner === l.lrn).map(([id, d]) => this.duelView(id, l, d.status));
        if (this.rawUuidItem) items.push({ ...this.duelView(randomUUID(), l, "finished"), opponent: { member_id: OTHER_USER_ID, nickname: "Leak", hero: null } });
        return json(200, { items, next_cursor: null });
      }
    }
    const m = /^\/duels\/([^/]+)(?:\/(accept|decline))?$/.exec(p);
    if (m) {
      const d = this.duels.get(m[1]!);
      if (!d || d.owner !== l.lrn) return err(404, "DUEL_NOT_FOUND");
      if (!m[2] && r.method === "GET") return json(200, this.duelView(m[1]!, l, d.status));
      if (m[2] === "accept" && r.method === "POST") {
        if (this.duelSetUnavailable) return err(503, "DUEL_SET_UNAVAILABLE", { service: "lessons" });
        d.status = "accepted";
        return json(200, this.duelView(m[1]!, l, d.status));
      }
      if (m[2] === "decline" && r.method === "POST") {
        d.status = "declined";
        return json(200, this.duelView(m[1]!, l, d.status));
      }
    }
    return err(404, "NOT_FOUND");
  }

  // ================================================================ lessons: задания дуэли и парные комнаты
  private duelSession(id: string, duelId: string): Record<string, unknown> {
    return {
      session_id: id,
      kind: "duel",
      title: L("Дуэль"),
      lesson_id: null,
      scenario_id: null,
      asset_id: null,
      status: "in_progress",
      stage: "assessment",
      stages: [{ type: "assessment", status: "current" }, { type: "summary", status: "pending" }],
      ai_mode: "choices",
      ai_degraded: false,
      started_at: AT,
      paused_at: null,
      finished_at: null,
      expires_at: "2026-11-23T09:00:00Z",
      minutes: 0,
      duel_id: duelId,
      set_id: randomUUID(),
      user_id: "x",
    };
  }

  private roomView(id: string, l: Learner): Record<string, unknown> {
    const st = this.rooms.get(id)!;
    return {
      room_id: id,
      status: st.status,
      side: "inviter",
      partner: { member_id: OTHER_MEMBER, nickname: OTHER_NICK, hero: this.hero(), user_id: OTHER_USER_ID, display_name: OTHER_NAME },
      pair_id: "ru-en",
      scenario: { scenario_id: st.scenario_id, title: L("В кафе"), level: "A1", rubric_id: "r-1" },
      mode: l.kids ? "choices" : "free",
      start_at: AT,
      respond_until: st.status === "invited" ? "2026-11-20T09:15:00Z" : null,
      created_at: AT,
      started_at: null,
      ended_at: null,
      end_reason: null,
      my_role: st.status === "in_progress" ? "A" : null,
      can_accept: false,
      can_join: st.status === "waiting",
      minutes: 0,
      report_available: st.status === "finished",
      inviter_user_id: l.lrn,
      invitee_user_id: OTHER_USER_ID,
      ai_cost_usd: 0.01,
    };
  }

  /** Лента комнаты (ответ lessons). */
  state(id: string, l: Learner): Record<string, unknown> {
    const events = Array.from({ length: this.stateEvents }, (_, i) => ({
      seq: i + 1,
      kind: i % 2 ? "turn" : "coach",
      role: i % 2 ? "B" : null,
      text: i % 2 ? "I'd like a coffee, please." : "Welcome to the café!",
      at: AT,
      user_id: i % 2 ? OTHER_USER_ID : null,
    }));
    return {
      room_id: id,
      status: "in_progress",
      seq: this.stateEvents,
      events,
      mode: l.kids ? "choices" : "free",
      my_role: "A",
      my_role_brief: "You are the customer.",
      team_goal: "Order two drinks and pay.",
      team_goal_progress: 0.4,
      next_speaker: "A",
      prompt: "What would you like to drink?",
      prompt_gloss: this.glossAsObject ? { ru: "Что вы будете пить?", uz: "Nima ichasiz?" } : "Что вы будете пить?",
      options: [
        { choice_id: "c1", text_en: "A tea, please." },
        { choice_id: "c2", text_en: "Coffee." },
        { choice_id: "c3", text_en: "Water." },
        { choice_id: "c4", text_en: "Juice." },
      ],
      participants: [
        { role: "A", me: true, network: "online", user_id: l.lrn },
        { role: "B", me: false, network: "online", user_id: OTHER_USER_ID, nickname: OTHER_NICK },
      ],
      ai_degraded: false,
      voice_available: true,
      my_speaking_seconds: 12,
      partner_speaking_seconds: 30,
      ai_cost_usd: 0.02,
    };
  }

  lessonsRoute(r: Req): Response | null {
    if (!r.path.startsWith("/internal/v1/me/duel-sessions") && !r.path.startsWith("/internal/v1/me/pair-rooms")) return null;
    const l = this.learner(r);
    if (l instanceof Response) return l;
    const p = r.path.slice("/internal/v1/me".length);
    if (r.method === "POST" && p === "/duel-sessions") {
      return this.once(r, l, () => {
        const duelId = (r.body as C.DuelSessionRequest).duel_id;
        const known = [...this.sessions.entries()].find(([, s]) => s.owner === l.lrn && s.duel_id === duelId);
        if (known) return { status: 200, result: this.duelSession(known[0], duelId) };
        const id = randomUUID();
        this.sessions.set(id, { owner: l.lrn, duel_id: duelId });
        return { status: 201, result: this.duelSession(id, duelId) };
      });
    }
    const rv = /^\/duel-sessions\/([^/]+)\/review$/.exec(p);
    if (rv && r.method === "GET") {
      const s = this.sessions.get(rv[1]!);
      if (!s || s.owner !== l.lrn) return err(404, "SESSION_NOT_FOUND");
      if (this.duelNotFinished) return err(409, "DUEL_NOT_FINISHED");
      return json(200, {
        session_id: rv[1],
        duel_id: s.duel_id,
        score: { correct: 1, total: 2 },
        items: [
          { item_id: "i1", prompt_en: "I ___ a student.", your_answer: "am", correct_answer: "am", correct: true },
          { item_id: "i2", prompt_en: "She ___ tea.", your_answer: null, correct_answer: "likes", correct: false },
        ],
        opponent_items: [{ item_id: "i1", answer: "is", user_id: OTHER_USER_ID }],
        opponent_user_id: OTHER_USER_ID,
      });
    }
    if (p === "/pair-rooms" && r.method === "POST") {
      return this.once(r, l, () => {
        const b = r.body as C.PairRoomInvite;
        if (!this.known(b.partner_member_id)) return err(404, "MEMBER_NOT_FOUND");
        if (b.partner_member_id === BLOCKED_MEMBER) return err(403, "BLOCKED");
        const id = randomUUID();
        this.rooms.set(id, { owner: l.lrn, status: "invited", scenario_id: b.scenario_id, start: b.start });
        return { status: 201, result: this.roomView(id, l) };
      });
    }
    if (p === "/pair-rooms" && r.method === "GET") {
      const items = [...this.rooms.entries()].filter(([, x]) => x.owner === l.lrn).map(([id]) => this.roomView(id, l));
      return json(200, { items, next_cursor: null });
    }
    const m = /^\/pair-rooms\/([^/]+)(?:\/([a-z]+))?$/.exec(p);
    if (!m) return err(404, "NOT_FOUND");
    const id = m[1]!;
    const room = this.rooms.get(id);
    if (!room || room.owner !== l.lrn) return err(404, "ROOM_NOT_FOUND");
    const action = m[2];
    switch (`${r.method} ${action ?? ""}`) {
      case "GET ":
        return json(200, this.roomView(id, l));
      case "POST accept":
        room.status = "waiting";
        return json(200, this.roomView(id, l));
      case "POST decline":
        room.status = "declined";
        return json(200, this.roomView(id, l));
      case "POST cancel":
        if (room.status !== "invited" && room.status !== "waiting" && room.status !== "cancelled") return err(409, "ROOM_STATE", { status: room.status });
        room.status = "cancelled";
        return json(200, this.roomView(id, l));
      case "POST leave":
        room.status = "abandoned";
        return json(200, this.roomView(id, l));
      case "POST join":
        room.status = "in_progress";
        return json(200, this.state(id, l));
      case "POST heartbeat":
        return new Response(null, { status: 204 });
      case "GET state":
        return json(200, this.state(id, l));
      case "POST turns":
        return this.once(r, l, () => ({ status: 200, result: this.state(id, l) }));
      case "POST audio": {
        if (this.audioError) return err(this.audioError.status, this.audioError.code, this.audioError.details ?? {});
        return json(200, { audio_id: "au_1", text: "Two coffees, please.", duration_ms: 1000, expires_at: "2026-11-20T09:05:00Z", words: [{ word: "two" }], user_id: l.lrn });
      }
      case "GET report":
        return json(200, {
          room_id: id,
          scenario: { scenario_id: room.scenario_id, title: L("В кафе") },
          status: "finished",
          end_reason: "completed",
          ended_at: AT,
          team: { goal_reached: true, progress: 1, summary: L("Отличная командная работа"), partner_user_id: OTHER_USER_ID },
          me: {
            role: "A",
            contributed: true,
            turns: 4,
            speaking_seconds: 40,
            minutes: 12,
            lines: [{ text: "A tea, please.", at: AT }],
            skills: [{ skill_id: "s-order", title: L("Заказ") }],
            tips: [L("Говори полными фразами"), L("Добавляй please"), L("Задавай вопрос"), L("Четвёртая")],
            evaluation_id: "1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b",
          },
          partner: { member_id: OTHER_MEMBER, lines: [{ text: "PARTNER-SECRET-LINE", at: AT }], errors: ["she go"], user_id: OTHER_USER_ID },
          evaluations: { [OTHER_USER_ID]: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d" },
        });
    }
    return err(404, "NOT_FOUND");
  }
}
