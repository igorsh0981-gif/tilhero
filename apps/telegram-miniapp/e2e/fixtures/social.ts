import type {
  BlockView,
  CommunityProfile,
  DuelView,
  Family,
  FriendRequestView,
  FriendView,
  GeneralLeagueUnavailableReason,
  LeagueResult,
  LeaguesView,
  MemberCard,
  MemberHero,
  MemberRelation,
  PairRole,
  PairRoomEvent,
  PairRoomEventKind,
  PairRoomReport,
  PairRoomState,
  PairRoomStatus,
  PairRoomView,
  ReferralView,
  ReferralsResponse,
  SanctionView,
  SessionStatus,
  StandingRow,
  Standings,
} from "@tilhero/contracts/bff";
import type { Localized } from "@tilhero/contracts/content";
import type { MockLessons, ReadingQuestionDef, Res } from "./lessons";

/**
 * Sprint 7 part of the mock telegram-bff (bff.ts «Спринт 7», INTERNAL_API §1–§3): the community profile (nickname with
 * its errors and the 7-day cooldown, the friend code and its rotation), the search by an exact code or nickname,
 * requests both ways (a counter request is an acceptance), friends, blocks (a block cancels the friendship and the
 * requests, hides both from the search), complaints (Idempotency-Key, «и заблокировать»), sanctions with one appeal,
 * referrals with the progress and public reasons, leagues of the week (friends, family, the general league by choice
 * with its reasons and a group of 24), duels (challenge, accept / decline, the same 10 tasks through MockLessons, the
 * result once both played), pair rooms (the invitation, join, the long-poll feed — the mock partner answers in turn,
 * goes offline and comes back on the test's command —, turns with an Idempotency-Key, the voice, leave, the private
 * report). Another learner is only a member_id with a nickname — never a name. Pure TS (Playwright, Node).
 */
export interface SocialScenario {
  /** down — 503 UPSTREAM_UNAVAILABLE {service: social} on the social routes (learning works) */
  mode?: "ok" | "down";
  /** my nickname at start (null — not set) */
  nickname?: string | null;
  /** my XP of the week */
  xp?: number;
  /** an active social_ban: ISO until, or "forever" */
  restricted?: string;
  /** seeded sanctions (a ban and a past warning with a decided appeal) */
  sanctions?: boolean;
  /** a moderator reset my nickname a day ago (sanction nickname_reset): the nickname is empty, the old one is closed to
   *  everybody, a new one — 7 days after the reset (social community.py) */
  nicknameReset?: boolean;
  /** friends at start (default: Malika_23 and one without a nickname) */
  friends?: boolean;
  /** an incoming request from Jasur and an outgoing one to Kamol (default true) */
  requests?: boolean;
  /** the general league: opted in at start (a group of 24 is assigned), the history of past weeks */
  league?: { optIn?: boolean; history?: boolean };
  /** duels: an incoming challenge from Malika; the opponent accepts by itself (on the next read of the duel) */
  duels?: { incoming?: boolean; autoAccept?: boolean; setUnavailableOnce?: boolean; finished?: boolean };
  /** pair rooms: an incoming invitation from Malika; the partner accepts my invitation by itself; the partner goes
   *  offline in his turn after my N-th line (the room is paused until partnerBack()) */
  pair?: { incoming?: boolean; autoAccept?: boolean; pauseAfter?: number; aiDegraded?: boolean };
  /** referrals of the account (default: five in different states) */
  referrals?: boolean;
}

const ok = (body: unknown, status = 200): Res => ({ status, body });
const fail = (status: number, code: string, details: Record<string, unknown> = {}): Res => ({ status, code, details });
const L = (ru: string, uz: string): Localized => ({ ru, uz });
const DAY = 86400_000;
/** a scheduled room can be entered from 5 minutes before its start (lessons rooms.py JOIN_EARLY) */
const JOIN_EARLY = 5 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** `mb_` + 22 chars of base64url */
export const mb = (name: string) => `mb_${(name.replace(/[^A-Za-z0-9_-]/g, "") + "0".repeat(22)).slice(0, 22)}`;
export const ME = mb("me");

export interface Person {
  member_id: string;
  nickname: string | null;
  code: string;
  hero: MemberHero | null;
  xp: number;
  /** a child 6–13: never found, never a friend */
  kid?: boolean;
  /** the level band differs by two: a duel is 409 LEVELS_INCOMPATIBLE */
  farLevel?: boolean;
  badges?: string[];
}

const hero = (code: string, stage: 1 | 2 | 3): MemberHero => ({ code, stage, image: { asset_id: `as-${code}-${stage}`, url: `/v1/game/assets/as-${code}-${stage}/0`, width: 300, height: 460 } });

export const P = {
  malika: { member_id: mb("malika"), nickname: "Malika_23", code: "TH-MALK-2345", hero: hero("pet_1", 2), xp: 260, badges: ["streak_7", "first_lesson"] },
  noNick: { member_id: mb("nonick"), nickname: null, code: "TH-QWER-TY78", hero: hero("robot_2", 1), xp: 90 },
  jasur: { member_id: mb("jasur"), nickname: "Jasur", code: "TH-JSRK-7788", hero: null, xp: 40 },
  kamol: { member_id: mb("kamol"), nickname: "Kamol", code: "TH-KAML-3456", hero: null, xp: 70 },
  dilnoza: { member_id: mb("dilnoza"), nickname: "Dilnoza", code: "TH-DLNZ-4567", hero: hero("human_0", 1), xp: 120 },
  far: { member_id: mb("farlevel"), nickname: "Bobur_B2", code: "TH-BBRB-2222", hero: null, xp: 500, farLevel: true },
  kidStranger: { member_id: mb("kidstranger"), nickname: "Kichkina", code: "TH-KCHK-9999", hero: null, xp: 10, kid: true },
  // the family of a child profile: the parent (with a nickname) and a sibling without one
  parent: { member_id: mb("parent"), nickname: "Aziz_TH", code: "TH-AZZT-4444", hero: hero("robot_0", 2), xp: 180 },
  sibling: { member_id: mb("sibling"), nickname: null, code: "TH-SBLN-5555", hero: hero("pet_0", 1), xp: 60, kid: true },
} satisfies Record<string, Person>;

/** The family of the mock (Family.members[].member_id — sprint 7). */
export function kidFamily(kidId: string, accountId: string): Family {
  return {
    family_id: "44444444-aaaa-4bbb-8ccc-000000000777",
    members: [
      { user_id: accountId, member_id: P.parent.member_id, display_name: "Азиз", role: "owner", is_me: false },
      { user_id: kidId, member_id: ME, display_name: "Мадина", role: "child", is_me: true },
      { user_id: "7a1c2b3a-2222-4a2b-9c3d-000000000888", member_id: P.sibling.member_id, display_name: "Сардор", role: "child", is_me: false },
    ],
  };
}

/** The 10 closed tasks of a duel: option 0 is right in 8 of them (tapping the first option gives 8 of 10). */
export const DUEL_ITEMS: ReadingQuestionDef[] = Array.from({ length: 10 }, (_, i) => {
  const words = ["apple", "table", "window", "coffee", "ticket", "street", "water", "friend", "music", "money"];
  const ru = ["яблоко", "стол", "окно", "кофе", "билет", "улица", "вода", "друг", "музыка", "деньги"];
  const right = i === 3 || i === 7 ? 1 : 0;
  const opts = right === 0 ? [ru[i]!, ru[(i + 1) % 10]!, ru[(i + 2) % 10]!] : [ru[(i + 1) % 10]!, ru[i]!, ru[(i + 2) % 10]!];
  return { item_id: `du-${i + 1}`, item_type: "single_choice", instruction: L("Выберите перевод", "Tarjimani tanlang"), prompt_en: words[i]!, options: opts, key: right, right: ru[i]! };
});

/* ---------------------------------------------------------------- pair room script */

interface Line {
  /** the coach's prompt for my turn */
  prompt: string;
  gloss: string;
  options: Array<{ choice_id: string; text_en: string }>;
  /** the partner's answer after my turn, then the coach's line */
  partner: string;
  coach: string;
}
/** the coach offers c1..c3 on every turn (lessons coach.py): the same choice_id comes again on the next turn */
const SCRIPT: Line[] = [
  {
    prompt: "Greet the waiter and ask for a table for two.",
    gloss: "Поздоровайтесь с официантом и попросите столик на двоих.",
    options: [
      { choice_id: "c1", text_en: "Hello! A table for two, please." },
      { choice_id: "c2", text_en: "Hi! Can we sit here?" },
      { choice_id: "c3", text_en: "Good evening! Is this table free?" },
    ],
    partner: "Of course! Here is your table. What would you like to drink?",
    coach: "Nice start! Now order the drinks.",
  },
  {
    prompt: "Order two drinks politely.",
    gloss: "Вежливо закажите два напитка.",
    options: [
      { choice_id: "c1", text_en: "Two teas, please." },
      { choice_id: "c2", text_en: "I'd like a latte and a tea, please." },
      { choice_id: "c3", text_en: "Can we have two coffees, please?" },
    ],
    partner: "Great choice. Anything else?",
    coach: "Good teamwork. One more step — the bill.",
  },
  {
    prompt: "Ask for the bill.",
    gloss: "Попросите счёт.",
    options: [
      { choice_id: "c1", text_en: "Could we have the bill, please?" },
      { choice_id: "c2", text_en: "The bill, please." },
      { choice_id: "c3", text_en: "How much is it, please?" },
    ],
    partner: "Here you are. Have a nice day!",
    coach: "Well done, team! The goal is reached.",
  },
];

interface RoomRec {
  view: PairRoomView;
  owner: string;
  partner: Person;
  kid: boolean;
  events: PairRoomEvent[];
  seq: number;
  myRole: PairRole;
  step: number;
  next: PairRole | "both" | null;
  progress: number;
  myTurns: number;
  mySeconds: number;
  myLines: Array<{ text: string; at: string }>;
  partnerNet: "online" | "offline";
  joins: number;
  /** sessions created for me in this room (one per participant: uuid5(room, user)) */
  sessions: Set<string>;
  turnKeys: Map<string, { body: string; state: PairRoomState }>;
  waiters: Array<() => void>;
  pausedForPartner: boolean;
  audio: Map<string, string>;
  /** I was away more than 3 minutes: can_join=false, join and heartbeat → 409 ROOM_NOT_ACTIVE {abandoned} */
  abandoned: boolean;
}

/* ---------------------------------------------------------------- the mock */

export class MockSocial {
  readonly sc: SocialScenario;
  people: Person[];
  nickname: string | null;
  nicknameSetAt: number | null;
  /** the reset by the moderator: the cooldown counts from it while the nickname is empty */
  nicknameResetAt: number | null = null;
  /** nicknames reset by moderators — closed to everybody, forever (social NicknameStop) */
  stopList = new Set<string>();
  code = "TH-7QKD-M3PX";
  rotations = 0;
  hidden = false;
  friends = new Map<string, string>(); // member_id → since
  requests: Array<FriendRequestView & { owner: string }> = [];
  blocks = new Map<string, string>(); // member_id → since
  /** someone blocked me (hidden from my search; my actions → 403 BLOCKED) */
  blockedBy = new Set<string>();
  complaints: Array<{ key: string; body: Record<string, unknown>; case_id: string }> = [];
  sanctions: SanctionView[] = [];
  duels = new Map<string, DuelRec>();
  duelKeys = new Map<string, string>();
  rooms = new Map<string, RoomRec>();
  roomKeys = new Map<string, string>();
  referrals: ReferralView[];
  /** the general league was switched on mid-week: the group is assigned only at the start of the next one */
  groupAssigned: boolean;
  private seq = 1;
  private setUnavailableOnce: boolean;
  private timers: Array<ReturnType<typeof setTimeout>> = [];

  constructor(sc: SocialScenario, private readonly lessons: MockLessons, start?: { owner: string; kid: boolean }) {
    this.sc = sc;
    this.people = Object.values(P).map((p) => ({ ...p }));
    this.nickname = sc.nickname === undefined ? null : sc.nickname;
    this.nicknameSetAt = this.nickname ? Date.now() - 30 * DAY : null;
    this.groupAssigned = !!sc.league?.optIn;
    this.setUnavailableOnce = !!sc.duels?.setUnavailableOnce;
    const now = Date.now();
    if (sc.friends !== false) {
      this.friends.set(P.malika.member_id, iso(now - 20 * DAY));
      this.friends.set(P.noNick.member_id, iso(now - 5 * DAY));
    }
    this.referrals = sc.referrals === false ? [] : this.seedReferrals();
    if (sc.sanctions || sc.restricted) this.seedSanctions();
    if (sc.nicknameReset) this.seedNicknameReset();
    lessons.onDuelFinished = (duelId, _owner, score) => this.duelPlayed(duelId, score);
    // the seeds of the active learner exist from the start: their ids are known to the test (duel_<id>, room_<id>)
    if (start) this.seed(start.owner, start.kid);
  }

  /** the next N polls of a room answer 503 UPSTREAM_UNAVAILABLE {service: lessons} (the test's command) */
  failPolls = 0;

  /** the requests of the account (seeded for the active learner on first use) */
  private seeded = new Set<string>();
  private seed(owner: string, kid: boolean): void {
    if (this.seeded.has(owner)) return;
    this.seeded.add(owner);
    const now = Date.now();
    if (!kid && this.sc.requests !== false) {
      this.requests.push({ owner, request_id: this.uuid("f2"), direction: "in", member_id: P.jasur.member_id, nickname: P.jasur.nickname, status: "pending", created_at: iso(now - 2 * DAY), decided_at: null });
      this.requests.push({ owner, request_id: this.uuid("f2"), direction: "out", member_id: P.kamol.member_id, nickname: P.kamol.nickname, status: "pending", created_at: iso(now - DAY), decided_at: null });
    }
    if (this.sc.duels?.incoming) this.newDuel(owner, kid ? P.parent : P.malika, "opponent");
    if (this.sc.duels?.finished) {
      const d = this.newDuel(owner, kid ? P.parent : P.malika, "challenger");
      d.status = "finished";
      d.myScore = { correct: 9, total: 10 };
      d.oppScore = { correct: 7, total: 10 };
      d.my_played = true;
      d.opponent_played = true;
      d.finished_at = iso(now - DAY);
      d.result = { outcome: "win", technical: false, my_score: d.myScore, opponent_score: d.oppScore, xp: 30, version: 1 };
    }
    if (this.sc.pair?.incoming) this.newRoom(owner, kid ? P.parent : P.malika, kid, "invitee", "sc-cafe-order", "now");
  }

  /** a UUID of the mock (hex prefix): matched by the routes as [0-9a-f-]{36} */
  private uuid(prefix: string): string {
    return `${prefix.padEnd(8, "0").slice(0, 8)}-aaaa-4bbb-8ccc-${String(this.seq++).padStart(12, "0")}`;
  }

  person(id: string): Person | undefined {
    if (id === ME) return undefined;
    return this.people.find((p) => p.member_id === id);
  }

  private restriction(): { social_ban: boolean; social_ban_until: string | null } {
    const ban = this.sanctions.find((s) => s.kind === "social_ban" && s.active);
    return ban ? { social_ban: true, social_ban_until: ban.until } : { social_ban: false, social_ban_until: null };
  }

  private seedSanctions(): void {
    const now = Date.now();
    const until = this.sc.restricted === "forever" ? null : this.sc.restricted ?? iso(now + 5 * DAY);
    this.sanctions.push({
      sanction_id: "5a000000-aaaa-4bbb-8ccc-000000000001",
      kind: "social_ban",
      basis: "Грубые сообщения в нике: жалобы трёх учеников подтвердились.",
      decided_at: iso(now - DAY),
      until,
      active: true,
      revoked_at: null,
      appeal: null,
      can_appeal: true,
    });
    if (this.sc.sanctions) {
      this.sanctions.push({
        sanction_id: "5a000000-aaaa-4bbb-8ccc-000000000002",
        kind: "warning",
        basis: "Спам заявками в друзья.",
        decided_at: iso(now - 40 * DAY),
        until: null,
        active: false,
        revoked_at: null,
        appeal: { appeal_id: "5b000000-aaaa-4bbb-8ccc-000000000002", status: "upheld", text: "Я просто искал одноклассников.", created_at: iso(now - 39 * DAY), decided_at: iso(now - 38 * DAY), decision_note: "Заявок было больше 40 за час — предупреждение остаётся." },
        can_appeal: false,
      });
    }
  }

  private seedNicknameReset(): void {
    const at = Date.now() - DAY;
    this.stopList.add("bad_boy_th");
    this.nickname = null;
    this.nicknameSetAt = null;
    this.nicknameResetAt = at;
    this.sanctions.unshift({
      sanction_id: "5a000000-aaaa-4bbb-8ccc-000000000003",
      kind: "nickname_reset",
      basis: "Ник Bad_Boy_TH нарушает правила сообщества.",
      decided_at: iso(at),
      until: null,
      active: true,
      revoked_at: null,
      appeal: null,
      can_appeal: true,
    });
  }

  /** when a new nickname can be set (social change_available_at): after a change — from it, after a reset — from the reset */
  private nicknameAvailableAt(): number | null {
    const base = this.nickname === null ? this.nicknameResetAt : this.nicknameSetAt;
    return base !== null && base + 7 * DAY > Date.now() ? base + 7 * DAY : null;
  }

  /** the 7 days after the reset have passed (the test's command) */
  nicknameCooldownOver(): void {
    if (this.nicknameResetAt !== null) this.nicknameResetAt -= 8 * DAY;
    if (this.nicknameSetAt !== null) this.nicknameSetAt -= 8 * DAY;
  }

  private seedReferrals(): ReferralView[] {
    const now = Date.now();
    const prog = (diag: boolean, lessons: number, days: number, windowDays = 20) => ({ diagnostic: diag, diagnostic_required: true, lessons, lessons_required: 3, days, days_required: 2, window_ends_at: iso(now + windowDays * DAY) });
    return [
      { referral_id: "7e000000-aaaa-4bbb-8ccc-000000000001", invitee_nickname: "Nodira", status: "learning", progress: prog(true, 2, 1), reward: null, reward_outcome: null, reject_code: null, legacy: false, accepted_at: iso(now - 4 * DAY) },
      { referral_id: "7e000000-aaaa-4bbb-8ccc-000000000002", invitee_nickname: null, status: "review", progress: prog(true, 3, 2), reward: null, reward_outcome: null, reject_code: null, legacy: false, accepted_at: iso(now - 9 * DAY) },
      { referral_id: "7e000000-aaaa-4bbb-8ccc-000000000003", invitee_nickname: "Bekzod", status: "rewarded", progress: prog(true, 4, 3), reward: { freeze: 2, til: 0 }, reward_outcome: "rewarded", reject_code: null, legacy: false, accepted_at: iso(now - 15 * DAY) },
      { referral_id: "7e000000-aaaa-4bbb-8ccc-000000000004", invitee_nickname: "Ulugbek", status: "rejected", progress: prog(true, 3, 2), reward: null, reward_outcome: null, reject_code: "review_rejected", legacy: false, accepted_at: iso(now - 25 * DAY) },
      { referral_id: "7e000000-aaaa-4bbb-8ccc-000000000005", invitee_nickname: null, status: "expired", progress: prog(false, 1, 1, -2), reward: null, reward_outcome: null, reject_code: "window_expired", legacy: false, accepted_at: iso(now - 40 * DAY) },
      // accepted before sprint 7, the transitional terms ran out: no refusal reason — «Приглашение по прежней программе»
      { referral_id: "7e000000-aaaa-4bbb-8ccc-000000000006", invitee_nickname: "Shoxrux", status: "expired", progress: prog(true, 0, 0, -10), reward: null, reward_outcome: null, reject_code: null, legacy: true, accepted_at: iso(now - 70 * DAY) },
    ];
  }

  /* ---------------------------------------------------------------- the community profile */

  community(ctx: Ctx): CommunityProfile {
    const gate = this.friendsGate(ctx);
    return {
      member_id: ME,
      nickname: this.nickname,
      friend_code: this.code,
      game_profile_hidden: this.hidden,
      restrictions: this.restriction(),
      nickname_change_available_at: ((at) => (at === null ? null : iso(at)))(this.nicknameAvailableAt()),
      friends_available: gate === null,
      friends_unavailable_reason: gate,
    };
  }

  private friendsGate(ctx: Ctx): "kids" | "guardian_consent" | "consent" | null {
    if (ctx.kid) return "kids";
    if (ctx.teenLocked) return "guardian_consent";
    if (!ctx.purposes.includes("social")) return "consent";
    return null;
  }

  private relation(id: string, owner: string): { relation: MemberRelation; request_id: string | null } {
    if (id === ME) return { relation: "self", request_id: null };
    if (this.friends.has(id)) return { relation: "friend", request_id: null };
    const r = this.requests.find((x) => x.owner === owner && x.member_id === id && x.status === "pending");
    if (r) return { relation: r.direction === "in" ? "request_in" : "request_out", request_id: r.request_id };
    return { relation: "none", request_id: null };
  }

  private blockedAny(id: string): boolean {
    return this.blocks.has(id) || this.blockedBy.has(id);
  }

  /* ---------------------------------------------------------------- leagues */

  private row(p: Person | "me", place: number, ctx: Ctx, kind: "friend" | "family" | "general"): StandingRow {
    if (p === "me") return { member_id: ME, nickname: this.nickname, hero: ctx.myHero, xp: this.sc.xp ?? 140, place, badges: ["first_lesson"], me: true };
    return { member_id: p.member_id, nickname: kind === "general" ? p.nickname ?? "Learner" : p.nickname, hero: p.hero, xp: p.xp, place, badges: (p.badges ?? []).slice(0, 3), me: false };
  }

  private standings(entries: Array<Person | "me">, ctx: Ctx, kind: "friend" | "family" | "general"): Standings {
    const xp = (e: Person | "me") => (e === "me" ? this.sc.xp ?? 140 : e.xp);
    const sorted = [...entries].sort((a, b) => xp(b) - xp(a));
    const rows = sorted.map((e, i) => this.row(e, i + 1, ctx, kind));
    return { rows: rows.slice(0, 50), me_row: rows.slice(50).find((r) => r.me) ?? null, participants: rows.length, total_xp: rows.reduce((a, r) => a + r.xp, 0) };
  }

  private generalReason(ctx: Ctx): GeneralLeagueUnavailableReason | null {
    if (ctx.kid) return "kids";
    if (ctx.teenLocked) return "guardian_consent";
    if (!ctx.purposes.includes("social")) return "consent";
    if (this.restriction().social_ban) return "restricted";
    if (this.hidden) return "hidden";
    if (!this.nickname) return "nickname_required";
    return null;
  }

  leagues(ctx: Ctx): LeaguesView {
    const friends = [...this.friends.keys()].map((id) => this.person(id)).filter((p): p is Person => !!p && !this.blockedAny(p.member_id));
    const familyIds = ctx.family?.members.filter((m) => !m.is_me).map((m) => m.member_id) ?? [];
    const family = familyIds.map((id) => this.person(id)).filter((p): p is Person => !!p);
    const reason = this.generalReason(ctx);
    let group: Standings | null = null;
    if (ctx.optIn && this.groupAssigned && !reason) {
      const others: Person[] = Array.from({ length: 23 }, (_, i) => ({ member_id: mb(`league${i}`), nickname: `Learner_${i + 1}`, code: "", hero: i % 3 === 0 ? hero("robot_1", 1) : null, xp: 600 - i * 22 }));
      group = this.standings(["me", ...others], ctx, "general");
    }
    return {
      week: "2026-11-16",
      ends_at: "2026-11-22T19:00:00Z",
      friends: ctx.kid ? null : this.standings(["me", ...friends], ctx, "friend"),
      family: ctx.family ? this.standings(["me", ...family], ctx, "family") : null,
      general: { opt_in: ctx.optIn, available: reason === null, unavailable_reason: reason, pair_id: ctx.kid ? null : "ru-en", level_band: ctx.kid ? null : "A2", group, prizes: [50, 30, 20] },
    };
  }

  /** PATCH /v1/game/settings {league_opt_in: true}: the checks of gamification before the game applies it */
  optInProblem(ctx: Ctx, on: boolean): Res | null {
    if (!on) return null;
    if (ctx.kid) return fail(403, "KIDS_NOT_ALLOWED");
    if (ctx.teenLocked) return fail(403, "FRIENDS_NOT_ALLOWED", { reason: "guardian_consent" });
    if (!ctx.purposes.includes("social")) return fail(403, "CONSENT_REQUIRED", { purpose: "social" });
    const r = this.restriction();
    if (r.social_ban) return fail(403, "SOCIAL_RESTRICTED", { until: r.social_ban_until });
    if (!this.nickname) return fail(409, "NICKNAME_REQUIRED");
    return null;
  }

  private history(): LeagueResult[] {
    if (!this.sc.league?.history) return [];
    return [
      { week: "2026-11-09", pair_id: "ru-en", level_band: "A2", place: 2, participants: 24, xp: 610, prize_til: 30, prize_held: false, version: 1, closed_at: "2026-11-15T19:05:00Z" },
      { week: "2026-11-02", pair_id: "ru-en", level_band: "A2", place: 7, participants: 22, xp: 280, prize_til: 0, prize_held: false, version: 2, closed_at: "2026-11-08T19:05:00Z" },
    ];
  }

  /* ---------------------------------------------------------------- duels */

  private newDuel(owner: string, opp: Person, role: "challenger" | "opponent"): DuelRec {
    const now = Date.now();
    const d: DuelRec = {
      duel_id: this.uuid("d0"),
      status: "challenged",
      role,
      opponent: { member_id: opp.member_id, nickname: opp.nickname, hero: opp.hero },
      pair_id: "ru-en",
      level_band: "A2",
      created_at: iso(now),
      accept_deadline: iso(now + DAY),
      play_deadline: null,
      my_session: null,
      my_played: false,
      opponent_played: false,
      can_accept: role === "opponent",
      can_play: false,
      result: null,
      finished_at: null,
      oppScore: null,
      myScore: null,
      acceptOnRead: role === "challenger" && !!this.sc.duels?.autoAccept,
      owner,
    };
    this.duels.set(d.duel_id, d);
    return d;
  }

  private duelView(d: DuelRec): DuelView {
    const { oppScore: _o, myScore: _m, acceptOnRead: _a, owner: _w, ...view } = d;
    return { ...view, can_accept: d.status === "challenged" && d.role === "opponent", can_play: d.status === "accepted" && !d.my_played };
  }

  private accept(d: DuelRec): void {
    d.status = "accepted";
    d.play_deadline = iso(Date.now() + 2 * DAY);
  }

  private duelPlayed(duelId: string, score: { correct: number; total: number }): void {
    const d = this.duels.get(duelId);
    if (!d) return;
    d.myScore = score;
    d.my_played = true;
    if (d.my_session) d.my_session = { ...d.my_session, status: "completed" };
    if (d.opponent_played) this.finishDuel(d);
  }

  /** The opponent plays (the test's command): the duel ends if I have played too. */
  opponentPlays(duelId: string, correct = 6): void {
    const d = this.duels.get(duelId);
    if (!d) return;
    d.oppScore = { correct, total: 10 };
    d.opponent_played = true;
    if (d.my_played) this.finishDuel(d);
  }

  private finishDuel(d: DuelRec): void {
    const my = d.myScore?.correct ?? -1;
    const op = d.oppScore?.correct ?? -1;
    const outcome = my > op ? "win" : my < op ? "loss" : "draw";
    d.status = "finished";
    d.finished_at = iso(Date.now());
    d.result = { outcome, technical: false, my_score: d.myScore, opponent_score: d.oppScore, xp: outcome === "win" ? 30 : outcome === "draw" ? 15 : 10, version: 1 };
  }

  /* ---------------------------------------------------------------- pair rooms */

  private newRoom(owner: string, partner: Person, kid: boolean, side: "inviter" | "invitee", scenarioId: string, start: string): RoomRec {
    const now = Date.now();
    const startAt = start === "now" ? now : Date.parse(start);
    const view: PairRoomView = {
      room_id: this.uuid("a0"),
      status: "invited",
      side,
      partner: { member_id: partner.member_id, nickname: partner.nickname, hero: partner.hero },
      pair_id: "ru-en",
      scenario: { scenario_id: scenarioId, title: kid ? L("В зоопарке", "Hayvonot bogʻida") : L("Заказ в кафе", "Kafeda buyurtma"), level: kid ? "A0" : "A1" },
      mode: kid || this.sc.pair?.aiDegraded ? "choices" : "free",
      start_at: iso(startAt),
      respond_until: iso(startAt + 15 * 60_000),
      created_at: iso(now),
      started_at: null,
      ended_at: null,
      end_reason: null,
      my_role: null,
      can_accept: side === "invitee",
      can_join: false,
      minutes: 0,
      report_available: false,
    };
    const r: RoomRec = {
      view, owner, partner, kid, events: [], seq: 0, myRole: side === "inviter" ? "A" : "B", step: 0, next: null, progress: 0, myTurns: 0, mySeconds: 0, myLines: [],
      partnerNet: "online", joins: 0, sessions: new Set(), turnKeys: new Map(), waiters: [], pausedForPartner: false, audio: new Map(),
      abandoned: false,
    };
    this.rooms.set(view.room_id, r);
    return r;
  }

  private push(r: RoomRec, kind: PairRoomEventKind, role: PairRole | null, text: string | null = null): void {
    r.seq += 1;
    r.events.push({ seq: r.seq, kind, role, text, at: iso(Date.now()) });
    const w = r.waiters.splice(0);
    for (const f of w) f();
  }

  private later(fn: () => void, ms: number): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private partnerRole(r: RoomRec): PairRole {
    return r.myRole === "A" ? "B" : "A";
  }

  /** both are in: the coach gives the roles and the goal, then my first turn */
  private begin(r: RoomRec): void {
    r.view.status = "in_progress";
    r.view.started_at = iso(Date.now());
    r.view.my_role = r.myRole;
    this.push(r, "joined", this.partnerRole(r));
    this.push(r, "roles", null);
    this.push(r, "coach", null, "Welcome! A is the guest, B is the waiter. Team goal: order two drinks and ask for the bill.");
    r.next = r.myRole;
    this.push(r, "coach", null, SCRIPT[0]!.prompt);
  }

  /** after my line: the partner answers in his turn (or goes offline — the room pauses), then the coach */
  private partnerTurn(r: RoomRec): void {
    const line = SCRIPT[r.step]!;
    r.next = this.partnerRole(r);
    if (this.sc.pair?.pauseAfter && r.myTurns === this.sc.pair.pauseAfter && !r.pausedForPartner) {
      r.pausedForPartner = true;
      this.later(() => {
        r.partnerNet = "offline";
        this.push(r, "offline", this.partnerRole(r));
        r.view.status = "paused";
        this.push(r, "paused", null);
      }, 300);
      return;
    }
    this.later(() => this.partnerAnswers(r, line), 400);
  }

  private partnerAnswers(r: RoomRec, line: Line): void {
    if (r.view.status !== "in_progress") return;
    this.push(r, "turn", this.partnerRole(r), line.partner);
    r.step += 1;
    r.progress = Math.min(1, r.step / SCRIPT.length);
    this.push(r, "coach", null, line.coach);
    if (r.step >= SCRIPT.length) {
      r.next = null;
      r.view.status = "finished";
      r.view.ended_at = iso(Date.now());
      r.view.end_reason = "completed";
      r.view.minutes = 4;
      r.view.report_available = true;
      this.push(r, "finished", null);
      return;
    }
    r.next = r.myRole;
    this.push(r, "coach", null, SCRIPT[r.step]!.prompt);
  }

  /** The start of a scheduled room comes (the test's command): it can be entered now. */
  startSoon(roomId?: string): void {
    const r = this.room(roomId);
    if (r) r.view.start_at = new Date(Date.now() + 60_000).toISOString();
  }

  /** I was away more than 3 minutes (the test's command): the partner goes on alone; my join and heartbeat → 409. */
  abandon(roomId?: string): void {
    const r = this.room(roomId);
    if (!r) return;
    r.abandoned = true;
    this.push(r, "left", r.myRole);
  }

  /** The partner finishes the lesson alone with the coach (the test's command): the room is finished. */
  finishSolo(roomId?: string): void {
    const r = this.room(roomId);
    if (!r) return;
    r.next = null;
    r.view.status = "finished";
    r.view.ended_at = iso(Date.now());
    r.view.end_reason = "participant_left";
    r.view.minutes = Math.max(1, r.myTurns);
    r.view.report_available = true;
    this.push(r, "finished", null);
  }

  /** the answer of the next turn is lost on the way after the turn is taken (the test's command) */
  dropTurnOnce = false;
  takeTurnDrop(key: string): boolean {
    if (!this.dropTurnOnce || !/^POST \/v1\/pair-rooms\/[0-9a-f-]{36}\/turns$/.test(key)) return false;
    this.dropTurnOnce = false;
    return true;
  }

  /** The partner's network comes back (the test's command): online, resumed, then his answer. */
  partnerBack(roomId?: string): void {
    const r = roomId ? this.rooms.get(roomId) : [...this.rooms.values()].find((x) => x.view.status === "paused");
    if (!r || r.view.status !== "paused") return;
    r.partnerNet = "online";
    this.push(r, "online", this.partnerRole(r));
    r.view.status = "in_progress";
    this.push(r, "resumed", null);
    this.later(() => this.partnerAnswers(r, SCRIPT[r.step]!), 300);
  }

  roomState(r: RoomRec, after: number, ctx: Ctx): PairRoomState {
    const line = SCRIPT[Math.min(r.step, SCRIPT.length - 1)]!;
    const mine = r.view.status === "in_progress" && r.next === r.myRole;
    const choices = r.view.mode === "choices";
    return {
      room_id: r.view.room_id,
      status: r.view.status,
      seq: r.seq,
      events: r.events.filter((e) => e.seq > after).slice(0, 50),
      mode: r.view.mode,
      my_role: r.view.my_role,
      my_role_brief: r.view.my_role ? (r.myRole === "A" ? "You are the guest at a cafe." : "You are the waiter at a cafe.") : null,
      team_goal: r.view.my_role ? "Order two drinks and ask for the bill." : null,
      team_goal_progress: r.progress,
      next_speaker: r.view.status === "in_progress" ? r.next : null,
      prompt: mine ? line.prompt : null,
      prompt_gloss: mine ? line.gloss : null,
      options: mine && choices ? line.options : null,
      participants: [
        { role: r.view.my_role, me: true, network: "online" },
        { role: r.view.status === "waiting" ? null : this.partnerRole(r), me: false, network: r.partnerNet },
      ],
      ai_degraded: !!this.sc.pair?.aiDegraded,
      voice_available: !ctx.kid && ctx.purposes.includes("voice_recording") && !ctx.teenLocked,
      my_speaking_seconds: r.mySeconds,
    };
  }

  private report(r: RoomRec): PairRoomReport {
    const contributed = r.myTurns > 0;
    return {
      room_id: r.view.room_id,
      scenario: { scenario_id: r.view.scenario.scenario_id, title: r.view.scenario.title },
      status: r.view.status,
      end_reason: r.view.end_reason,
      ended_at: r.view.ended_at,
      team: { goal_reached: r.view.end_reason === "completed" && r.progress >= 1, progress: r.progress, summary: L("Отличная командная работа: вы договорились и довели сцену до конца.", "Ajoyib jamoaviy ish: kelishib oldingiz va sahnani oxirigacha yetkazdingiz.") },
      me: {
        role: r.myRole,
        contributed,
        turns: r.myTurns,
        speaking_seconds: r.mySeconds,
        minutes: r.view.minutes,
        lines: r.myLines,
        skills: contributed ? [{ skill_id: "en.func.order", title: L("Вежливая просьба в кафе", "Kafeda xushmuomala iltimos") }] : [],
        tips: contributed ? [L("Добавляйте please в конце просьбы — так вежливее.", "Iltimos oxirida please qoʻshing — shunday xushmuomalaroq.")] : [],
        evaluation_id: contributed ? "e7a10000-aaaa-4bbb-8ccc-000000000777" : null,
      },
    };
  }

  /* ---------------------------------------------------------------- the router */

  handle(method: string, path: string, q: URLSearchParams, b: Record<string, unknown>, headers: Record<string, string>, ctx: Ctx): Res | Promise<Res> | null {
    const social = /^\/v1\/(community|friends|blocks|complaints|sanctions|referrals|duel-sessions|pair-rooms)(\/|$)/.test(path) || /^\/v1\/game\/(leagues|duels)(\/|$)/.test(path);
    if (!social) return null;
    if (this.sc.mode === "down") return fail(503, "UPSTREAM_UNAVAILABLE", { service: path.startsWith("/v1/game/") ? "gamification" : path.startsWith("/v1/pair-rooms") || path.startsWith("/v1/duel-sessions") ? "lessons" : "social" });
    this.seed(ctx.owner, ctx.kid);
    const key = `${method} ${path}`;
    const idem = headers["idempotency-key"];
    const now = Date.now();
    const kid = ctx.kid;
    const gate = this.friendsGate(ctx);
    const restricted = this.restriction();
    const notAllowed = () => (kid ? fail(403, "KIDS_NOT_ALLOWED") : gate === "guardian_consent" ? fail(403, "FRIENDS_NOT_ALLOWED", { reason: "guardian_consent" }) : fail(403, "CONSENT_REQUIRED", { purpose: "social" }));

    // ---- the community profile ----
    if (key === "GET /v1/community") return ok(this.community(ctx));
    if (key === "PATCH /v1/community") {
      if (typeof b.game_profile_hidden === "boolean") this.hidden = b.game_profile_hidden;
      return ok(this.community(ctx));
    }
    if (key === "PUT /v1/community/nickname") {
      const n = String(b.nickname ?? "").trim();
      const len = [...n].length;
      if (len < 3 || len > 20) return fail(422, "NICKNAME_INVALID", { reason: "length" });
      if (!/^[\p{L}\p{N}_]+$/u.test(n)) return fail(422, "NICKNAME_INVALID", { reason: "chars" });
      if (/durak|admin/i.test(n)) return fail(422, "NICKNAME_INVALID", { reason: "forbidden" });
      if (this.nickname && this.nickname.toLowerCase() === n.toLowerCase()) return ok(this.community(ctx));
      // the order of social set_nickname: the cooldown, the stop list of reset nicknames, then taken
      const availableAt = this.nicknameAvailableAt();
      if (availableAt !== null) return fail(429, "NICKNAME_COOLDOWN", { until: iso(availableAt) });
      if (this.stopList.has(n.toLowerCase())) return fail(422, "NICKNAME_INVALID", { reason: "forbidden" });
      if (this.people.some((p) => p.nickname?.toLowerCase() === n.toLowerCase())) return fail(409, "NICKNAME_TAKEN");
      this.nickname = n;
      this.nicknameSetAt = now;
      this.nicknameResetAt = null;
      return ok(this.community(ctx));
    }
    if (key === "POST /v1/community/friend-code/rotate") {
      if (this.rotations >= 3) return fail(429, "FRIEND_CODE_LIMIT", { until: iso(now + DAY) });
      this.rotations += 1;
      this.code = ["TH-NEWC-ODE2", "TH-NEWC-ODE3", "TH-NEWC-ODE4"][this.rotations - 1]!;
      return ok(this.community(ctx));
    }

    // ---- search, requests, friends, blocks ----
    if (key === "GET /v1/friends/search") {
      if (gate) return notAllowed();
      const raw = (q.get("q") ?? "").trim();
      const code = raw.replace(/[\s-]/g, "").toUpperCase();
      if (code === this.code.replace(/-/g, "") || raw.toLowerCase() === (this.nickname ?? "").toLowerCase()) return ok({ items: [{ member_id: ME, nickname: this.nickname, relation: "self", request_id: null } satisfies MemberCard] });
      const p = this.people.find((x) => !x.kid && !this.blockedAny(x.member_id) && (x.code.replace(/-/g, "") === code || (x.nickname ?? "").toLowerCase() === raw.toLowerCase()));
      return ok({ items: p ? [{ member_id: p.member_id, nickname: p.nickname, ...this.relation(p.member_id, ctx.owner) } satisfies MemberCard] : [] });
    }
    if (key === "POST /v1/friends/requests") {
      if (!idem) return fail(422, "IDEMPOTENCY_KEY_REQUIRED");
      const ik = `fr:${idem}`;
      if (this.roomKeys.has(ik)) return ok(JSON.parse(this.roomKeys.get(ik)!), 201);
      if (gate) return notAllowed();
      if (restricted.social_ban) return fail(403, "SOCIAL_RESTRICTED", { until: restricted.social_ban_until });
      const id = String(b.member_id ?? "");
      if (id === ME) return fail(422, "VALIDATION_ERROR", { field: "member_id" });
      const p = this.person(id);
      if (!p || p.kid) return fail(404, "MEMBER_NOT_FOUND");
      if (this.blockedAny(id)) return fail(403, "BLOCKED");
      if (this.friends.has(id)) return fail(409, "ALREADY_FRIENDS");
      const counter = this.requests.find((r) => r.owner === ctx.owner && r.member_id === id && r.status === "pending" && r.direction === "in");
      if (counter) {
        counter.status = "accepted";
        counter.decided_at = iso(now);
        this.friends.set(id, iso(now));
        const out = { ...counter, owner: undefined };
        return ok(out, 200);
      }
      if (this.requests.some((r) => r.owner === ctx.owner && r.member_id === id && r.status === "pending")) return fail(409, "REQUEST_EXISTS");
      const r = { owner: ctx.owner, request_id: this.uuid("f2"), direction: "out" as const, member_id: id, nickname: p.nickname, status: "pending" as const, created_at: iso(now), decided_at: null };
      this.requests.push(r);
      const { owner: _o, ...view } = r;
      this.roomKeys.set(ik, JSON.stringify(view));
      return ok(view, 201);
    }
    if (key === "GET /v1/friends/requests") {
      if (gate) return notAllowed();
      const dir = q.get("direction") === "out" ? "out" : "in";
      const items = this.requests.filter((r) => r.owner === ctx.owner && r.direction === dir && r.status === "pending").reverse().map(({ owner: _o, ...v }) => v);
      return ok({ items, next_cursor: null });
    }
    let m = /^\/v1\/friends\/requests\/([0-9a-f-]{36})\/(accept|decline|cancel)$/.exec(path);
    if (m && method === "POST") {
      const r = this.requests.find((x) => x.owner === ctx.owner && x.request_id === m![1]);
      if (!r) return fail(404, "REQUEST_NOT_FOUND");
      const want = m[2] === "accept" ? "accepted" : m[2] === "decline" ? "declined" : "cancelled";
      if ((m[2] === "cancel") !== (r.direction === "out")) return fail(404, "REQUEST_NOT_FOUND");
      if (r.status === want) return ok({ ...r, owner: undefined });
      if (r.status !== "pending") return fail(409, "REQUEST_STATE", { status: r.status });
      r.status = want;
      r.decided_at = iso(now);
      if (want === "accepted") this.friends.set(r.member_id, iso(now));
      const { owner: _o, ...view } = r;
      return ok(view);
    }
    if (key === "GET /v1/friends") {
      if (gate) return notAllowed();
      const items: FriendView[] = [...this.friends.entries()]
        .map(([id, since]) => ({ member_id: id, nickname: this.person(id)?.nickname ?? null, since }))
        .sort((a, z) => (a.nickname === null ? 1 : z.nickname === null ? -1 : a.nickname.localeCompare(z.nickname)));
      return ok({ items, next_cursor: null });
    }
    m = /^\/v1\/friends\/(mb_[A-Za-z0-9_-]{22})$/.exec(path);
    if (m && method === "DELETE") {
      this.friends.delete(m[1]!);
      return ok(undefined, 204);
    }
    if (key === "POST /v1/blocks") {
      if (kid) return fail(403, "KIDS_NOT_ALLOWED");
      const id = String(b.member_id ?? "");
      if (!this.person(id)) return fail(404, "MEMBER_NOT_FOUND");
      this.blockEffects(id, ctx.owner);
      const had = this.blocks.has(id);
      if (!had) this.blocks.set(id, iso(now));
      return ok({ member_id: id, nickname: this.person(id)!.nickname, created_at: this.blocks.get(id)! } satisfies BlockView, had ? 200 : 201);
    }
    if (key === "GET /v1/blocks") {
      if (kid) return fail(403, "KIDS_NOT_ALLOWED");
      return ok({ items: [...this.blocks.entries()].map(([id, at]) => ({ member_id: id, nickname: this.person(id)?.nickname ?? null, created_at: at })) });
    }
    m = /^\/v1\/blocks\/(mb_[A-Za-z0-9_-]{22})$/.exec(path);
    if (m && method === "DELETE") {
      this.blocks.delete(m[1]!);
      return ok(undefined, 204);
    }

    // ---- complaints, sanctions ----
    if (key === "POST /v1/complaints") {
      if (kid) return fail(403, "KIDS_NOT_ALLOWED");
      if (!idem) return fail(422, "IDEMPOTENCY_KEY_REQUIRED");
      const prev = this.complaints.find((c) => c.key === idem);
      if (prev) return ok({ case_id: prev.case_id, created_at: iso(now), blocked: !!prev.body.block }, 201);
      const kind = String(b.subject_kind ?? "");
      const needsId = ["friend_request", "invite", "duel", "pair_room"].includes(kind);
      if (needsId !== (typeof b.subject_id === "string" && !!b.subject_id)) return fail(422, "VALIDATION_ERROR", { field: "subject_id" });
      if (typeof b.comment === "string" && b.comment.length > 500) return fail(422, "VALIDATION_ERROR", { field: "comment" });
      const id = String(b.member_id ?? "");
      if (!this.person(id)) return fail(404, "MEMBER_NOT_FOUND");
      const same = this.complaints.find((c) => c.body.member_id === id && c.body.subject_kind === kind && (c.body.subject_id ?? null) === (b.subject_id ?? null));
      const case_id = same?.case_id ?? this.uuid("ca");
      this.complaints.push({ key: idem, body: b, case_id });
      if (b.block) {
        this.blockEffects(id, ctx.owner);
        if (!this.blocks.has(id)) this.blocks.set(id, iso(now));
      }
      return ok({ case_id, created_at: iso(now), blocked: !!b.block }, same ? 200 : 201);
    }
    if (key === "GET /v1/sanctions") return ok({ items: this.sanctions });
    m = /^\/v1\/sanctions\/([0-9a-f-]{36})\/appeal$/.exec(path);
    if (m && method === "POST") {
      const s = this.sanctions.find((x) => x.sanction_id === m![1]);
      if (!s) return fail(404, "SANCTION_NOT_FOUND");
      if (s.appeal) return fail(409, "APPEAL_EXISTS");
      if (!s.active) return fail(409, "SANCTION_STATE");
      const text = String(b.text ?? "").trim();
      if (text.length < 10 || text.length > 1000) return fail(422, "VALIDATION_ERROR", { field: "text" });
      s.appeal = { appeal_id: this.uuid("5b"), status: "open", text, created_at: iso(now), decided_at: null, decision_note: null };
      s.can_appeal = false;
      return ok(s, 201);
    }

    // ---- referrals ----
    if (key === "GET /v1/referrals") {
      if (kid) return fail(403, "KIDS_NOT_ALLOWED");
      const out: ReferralsResponse = {
        items: this.referrals,
        next_cursor: null,
        terms: { campaign_version: 1, require_diagnostic: true, min_lessons: 3, min_days: 2, window_days: 30, inviter_reward: { freeze: 2, til: 0 }, invitee_reward: { freeze: 0, til: 20 }, monthly_cap: 10 },
        month: { qualified: 1, cap: 10 },
      };
      return ok(out);
    }

    // ---- leagues ----
    if (key === "GET /v1/game/leagues") return ok(this.leagues(ctx));
    if (key === "GET /v1/game/leagues/history") return ok({ items: this.history(), next_cursor: null });

    // ---- duels ----
    if (key === "POST /v1/game/duels") {
      if (!idem) return fail(422, "IDEMPOTENCY_KEY_REQUIRED");
      const ik = `du:${idem}`;
      if (this.duelKeys.has(ik)) return ok(this.duelView(this.duels.get(this.duelKeys.get(ik)!)!), 201);
      const id = String(b.opponent_member_id ?? "");
      if (id === ME) return fail(422, "VALIDATION_ERROR", { field: "opponent_member_id" });
      const p = this.person(id);
      if (!p) return fail(404, "MEMBER_NOT_FOUND");
      const inFamily = !!ctx.family?.members.some((x) => x.member_id === id);
      if (kid && !inFamily) return fail(403, "PARTNER_NOT_ALLOWED");
      if (!inFamily && !this.friends.has(id)) return this.blockedAny(id) ? fail(403, "BLOCKED") : fail(403, "PARTNER_NOT_ALLOWED");
      if (this.blockedAny(id)) return fail(403, "BLOCKED");
      if (restricted.social_ban) return fail(403, "SOCIAL_RESTRICTED", { until: restricted.social_ban_until });
      if (p.farLevel) return fail(409, "LEVELS_INCOMPATIBLE");
      const active = [...this.duels.values()].filter((d) => d.owner === ctx.owner && (d.status === "challenged" || d.status === "accepted"));
      const same = active.find((d) => d.opponent.member_id === id);
      if (same) return fail(409, "DUEL_EXISTS", { duel_id: same.duel_id });
      if (active.filter((d) => d.role === "challenger" && d.status === "challenged").length >= 3) return fail(409, "DUELS_LIMIT");
      const d = this.newDuel(ctx.owner, p, "challenger");
      this.duelKeys.set(ik, d.duel_id);
      return ok(this.duelView(d), 201);
    }
    if (key === "GET /v1/game/duels") {
      const st = q.get("status") === "finished" ? "finished" : "active";
      const items = [...this.duels.values()]
        .filter((d) => d.owner === ctx.owner)
        .filter((d) => (st === "active" ? d.status === "challenged" || d.status === "accepted" : !(d.status === "challenged" || d.status === "accepted")))
        .reverse()
        .map((d) => this.duelView(d));
      return ok({ items, next_cursor: null });
    }
    m = /^\/v1\/game\/duels\/([0-9a-f-]{36})(?:\/(accept|decline))?$/.exec(path);
    if (m) {
      const d = this.duels.get(m[1]!);
      if (!d || d.owner !== ctx.owner) return fail(404, "DUEL_NOT_FOUND");
      if (!m[2] && method === "GET") {
        if (d.acceptOnRead && d.status === "challenged") {
          d.acceptOnRead = false;
          this.accept(d);
        }
        return ok(this.duelView(d));
      }
      if (m[2] && method === "POST") {
        if (d.role !== "opponent") return fail(409, "DUEL_STATE", { status: d.status });
        const want = m[2] === "accept" ? "accepted" : "declined";
        if (d.status === want) return ok(this.duelView(d));
        if (d.status !== "challenged") return fail(409, "DUEL_STATE", { status: d.status });
        if (want === "accepted") {
          if (this.setUnavailableOnce) {
            this.setUnavailableOnce = false;
            return fail(503, "DUEL_SET_UNAVAILABLE");
          }
          this.accept(d);
        } else d.status = "declined";
        return ok(this.duelView(d));
      }
    }
    if (key === "POST /v1/duel-sessions") {
      if (!idem) return fail(422, "IDEMPOTENCY_KEY_REQUIRED");
      const d = this.duels.get(String(b.duel_id ?? ""));
      if (!d || d.owner !== ctx.owner) return fail(404, "DUEL_NOT_FOUND");
      if (d.status !== "accepted" || (d.play_deadline && Date.parse(d.play_deadline) < now)) return fail(409, "DUEL_CLOSED");
      const { res } = this.lessons.startDuel(ctx.owner, kid, d.duel_id, DUEL_ITEMS);
      const view = res.body as { session_id: string; status: SessionStatus };
      d.my_session = { session_id: view.session_id, status: view.status };
      return res;
    }
    m = /^\/v1\/duel-sessions\/([0-9a-f-]{36})\/review$/.exec(path);
    if (m && method === "GET") {
      const s = this.lessons.duelSession(ctx.owner, m[1]!);
      if (!s) return fail(404, "SESSION_NOT_FOUND");
      if (this.duels.get(s.duelId)?.status !== "finished") return fail(409, "DUEL_NOT_FINISHED");
      return ok({ session_id: m[1]!, duel_id: s.duelId, score: s.score, items: s.items });
    }

    // ---- pair rooms ----
    if (key === "POST /v1/pair-rooms") {
      if (!idem) return fail(422, "IDEMPOTENCY_KEY_REQUIRED");
      const ik = `pr:${idem}`;
      if (this.roomKeys.has(ik)) return ok(this.rooms.get(this.roomKeys.get(ik)!)!.view, 201);
      const id = String(b.partner_member_id ?? "");
      const p = this.person(id);
      if (!p) return fail(404, "MEMBER_NOT_FOUND");
      const inFamily = !!ctx.family?.members.some((x) => x.member_id === id);
      if (kid && !inFamily) return fail(403, "PARTNER_NOT_ALLOWED");
      if (!inFamily && !this.friends.has(id)) return fail(403, "PARTNER_NOT_ALLOWED");
      if (this.blockedAny(id)) return fail(403, "BLOCKED");
      if (restricted.social_ban) return fail(403, "SOCIAL_RESTRICTED", { until: restricted.social_ban_until });
      const start = String(b.start ?? "");
      if (start !== "now") {
        const at = Date.parse(start);
        if (Number.isNaN(at) || at < now || at > now + 7 * DAY) return fail(422, "VALIDATION_ERROR", { field: "start" });
      }
      const open = [...this.rooms.values()].find((r) => r.owner === ctx.owner && ["invited", "waiting", "in_progress", "paused"].includes(r.view.status));
      if (open) return fail(409, "ROOM_LIMIT", { room_id: open.view.room_id });
      const r = this.newRoom(ctx.owner, p, kid, "inviter", String(b.scenario_id ?? "sc-cafe-order"), start);
      this.roomKeys.set(ik, r.view.room_id);
      return ok(r.view, 201);
    }
    if (key === "GET /v1/pair-rooms") {
      const st = q.get("status") === "finished" ? "finished" : "active";
      const live = (s: PairRoomStatus) => ["invited", "waiting", "in_progress", "paused"].includes(s);
      const items = [...this.rooms.values()].filter((r) => r.owner === ctx.owner && (st === "active" ? live(r.view.status) : !live(r.view.status))).reverse().map((r) => this.roomView(r));
      return ok({ items, next_cursor: null });
    }
    m = /^\/v1\/pair-rooms\/([0-9a-f-]{36})(?:\/([a-z]+))?$/.exec(path);
    if (m) {
      const r = this.rooms.get(m[1]!);
      if (!r || r.owner !== ctx.owner) return fail(404, "ROOM_NOT_FOUND");
      const action = m[2] ?? "";
      const st = r.view.status;
      if (action === "" && method === "GET") return ok(this.roomView(r));
      if (method === "POST" && (action === "accept" || action === "decline")) {
        const want = action === "accept" ? "waiting" : "declined";
        if (r.view.side !== "invitee") return fail(409, "ROOM_STATE", { status: st });
        if (st === want) return ok(this.roomView(r));
        if (st !== "invited") return fail(409, "ROOM_STATE", { status: st });
        r.view.status = want;
        r.view.respond_until = null;
        return ok(this.roomView(r));
      }
      if (method === "POST" && action === "cancel") {
        if (st === "cancelled") return ok(this.roomView(r));
        if (st !== "invited" && st !== "waiting") return fail(409, "ROOM_STATE", { status: st });
        r.view.status = "cancelled";
        return ok(this.roomView(r));
      }
      if (method === "POST" && action === "join") {
        if (r.abandoned) return fail(409, "ROOM_NOT_ACTIVE", { status: "abandoned" });
        if (!["waiting", "in_progress", "paused"].includes(st)) return fail(409, "ROOM_NOT_ACTIVE", { status: st });
        if (st === "waiting" && now < Date.parse(r.view.start_at) - JOIN_EARLY) return fail(409, "ROOM_NOT_ACTIVE", { status: "waiting", start_at: r.view.start_at });
        r.joins += 1;
        // one session per participant: uuid5(room_id, user_id) — a re-join never creates a second one
        r.sessions.add(`${r.view.room_id}:${ctx.owner}`);
        if (st === "waiting" && !r.view.my_role) {
          r.view.my_role = r.myRole;
          this.push(r, "joined", r.myRole);
          this.later(() => this.begin(r), 350);
        } else this.push(r, "joined", r.myRole);
        return ok(this.roomState(r, 0, ctx));
      }
      if (method === "POST" && action === "heartbeat") {
        if (r.abandoned) return fail(409, "ROOM_NOT_ACTIVE", { status: "abandoned" });
        if (!["waiting", "in_progress", "paused"].includes(st)) return fail(409, "ROOM_NOT_ACTIVE", { status: st });
        this.heartbeats += 1;
        return ok(undefined, 204);
      }
      if (method === "POST" && action === "leave") {
        if (!["waiting", "in_progress", "paused"].includes(st)) return fail(409, "ROOM_NOT_ACTIVE", { status: st });
        this.push(r, "left", r.myRole);
        return ok(this.roomView(r));
      }
      if (method === "GET" && action === "state") {
        if (this.failPolls > 0) {
          this.failPolls -= 1;
          return fail(503, "UPSTREAM_UNAVAILABLE", { service: "lessons" });
        }
        const after = Number(q.get("after_seq") ?? 0) || 0;
        if (r.events.some((e) => e.seq > after) || !["waiting", "in_progress", "paused"].includes(st)) return ok(this.roomState(r, after, ctx));
        // long-poll: answer when the feed moves, else after a short wait (25 s on the server)
        return new Promise<Res>((resolve) => {
          const done = () => resolve(ok(this.roomState(r, after, ctx)));
          const t = setTimeout(() => {
            r.waiters = r.waiters.filter((w) => w !== wake);
            done();
          }, 1500);
          const wake = () => {
            clearTimeout(t);
            done();
          };
          r.waiters.push(wake);
        });
      }
      if (method === "POST" && action === "audio") {
        if (kid) return fail(403, "KIDS_NOT_ALLOWED");
        if (!ctx.purposes.includes("voice_recording")) return fail(403, "VOICE_CONSENT_REQUIRED", { who: ctx.teenLocked ? "guardian" : "self" });
        if (st !== "in_progress") return fail(409, "ROOM_NOT_ACTIVE", { status: st });
        if (r.next !== r.myRole) return fail(409, "NOT_YOUR_TURN");
        const id = this.uuid("ad");
        const text = "Hello! A table for two, please.";
        r.audio.set(id, text);
        return ok({ audio_id: id, text, duration_ms: 2100, expires_at: iso(now + 5 * 60_000) }, 201);
      }
      if (method === "POST" && action === "turns") {
        if (!idem) return fail(422, "IDEMPOTENCY_KEY_REQUIRED");
        const prev = r.turnKeys.get(idem);
        const body = JSON.stringify(b);
        if (prev) return prev.body === body ? ok(prev.state) : fail(422, "IDEMPOTENCY_KEY_REUSED");
        if (st !== "in_progress") return fail(409, "ROOM_NOT_ACTIVE", { status: st });
        const fields = ["text", "choice_id", "audio_id"].filter((f) => b[f] !== undefined && b[f] !== null);
        if (fields.length !== 1) return fail(422, "VALIDATION_ERROR", { field: "body" });
        if (r.next !== r.myRole) return fail(409, "NOT_YOUR_TURN");
        let said: string;
        let seconds: number;
        if (typeof b.text === "string") {
          if (kid) return fail(403, "KIDS_NOT_ALLOWED");
          said = b.text.trim();
          if (!said || said.length > 300) return fail(422, "VALIDATION_ERROR", { field: "text" });
          seconds = 8;
        } else if (typeof b.choice_id === "string") {
          const opt = SCRIPT[r.step]!.options.find((o) => o.choice_id === b.choice_id);
          if (!opt) return fail(422, "VALIDATION_ERROR", { field: "choice_id" });
          said = opt.text_en;
          seconds = 5;
        } else {
          const text = r.audio.get(String(b.audio_id));
          if (!text) return fail(422, "AUDIO_INVALID", { reason: "format" });
          r.audio.delete(String(b.audio_id));
          said = text;
          seconds = 2;
        }
        r.myTurns += 1;
        r.mySeconds += seconds;
        r.myLines.push({ text: said, at: iso(now) });
        this.push(r, "turn", r.myRole, said);
        this.partnerTurn(r);
        const state = this.roomState(r, r.seq - 1, ctx);
        r.turnKeys.set(idem, { body, state });
        return ok(state);
      }
      if (method === "GET" && action === "report") {
        if (!["finished", "abandoned", "stopped"].includes(st)) return fail(409, "ROOM_STATE", { status: st });
        return ok(this.report(r));
      }
    }
    return fail(404, "NOT_FOUND");
  }

  heartbeats = 0;

  private roomView(r: RoomRec): PairRoomView {
    // the partner accepts my invitation by itself (on the next read)
    if (r.view.side === "inviter" && r.view.status === "invited" && this.sc.pair?.autoAccept) {
      r.view.status = "waiting";
      r.view.respond_until = null;
    }
    const st = r.view.status;
    // lessons rooms.py can_join: not abandoned, a live status, and a waiting room — from 5 minutes before the start
    const canJoin = !r.abandoned && (st === "in_progress" || st === "paused" || (st === "waiting" && Date.now() >= Date.parse(r.view.start_at) - JOIN_EARLY));
    return {
      ...r.view,
      can_accept: st === "invited" && r.view.side === "invitee",
      can_join: canJoin,
      report_available: r.view.report_available && (r.joins > 0 || r.myTurns > 0),
    };
  }

  /** a block (or a complaint with block): friendship and pending requests both ways are gone, duels and rooms
   *  waiting for an answer are cancelled */
  private blockEffects(id: string, owner: string): void {
    this.friends.delete(id);
    for (const r of this.requests) if (r.owner === owner && r.member_id === id && r.status === "pending") r.status = "cancelled";
    for (const d of this.duels.values()) if (d.opponent.member_id === id && d.status === "challenged") d.status = "cancelled";
    for (const r of this.rooms.values()) if (r.partner.member_id === id && r.view.status === "invited") r.view.status = "cancelled";
  }

  /** the rooms of the test (the first one, or by id) */
  room(id?: string): RoomRec | undefined {
    return id ? this.rooms.get(id) : [...this.rooms.values()][0];
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
  }
}

type DuelRec = DuelView & { oppScore: { correct: number; total: number } | null; myScore: { correct: number; total: number } | null; acceptOnRead: boolean; owner: string };

export interface Ctx {
  owner: string;
  kid: boolean;
  /** a teen 14–17 without the parent's consent */
  teenLocked: boolean;
  purposes: string[];
  family: Family | null;
  optIn: boolean;
  myHero: MemberHero | null;
}
