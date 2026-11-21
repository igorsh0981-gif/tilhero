/**
 * Seed data of the sprint 7 part of the mock admin-bff («Сообщество»): community profiles, moderation cases, sanctions
 * and appeals, referral campaigns and the review queue, league weeks with groups and members, duels, pair rooms.
 * Learners are the ids of data.ts (LEARNER) plus members known only to the community (MEMBER) — no names, only
 * nicknames, the way social sees them.
 */
import type {
  AdminCase,
  AdminDuel,
  AdminLeagueMember,
  AdminLeagueResult,
  AdminPairRoom,
  AdminReferral,
  AdminSanction,
  AdminSanctionAppeal,
  LeagueGroupStatus,
  ReferralCampaignPayload,
  ReferralCampaignVersion,
  StaffRef,
} from "@tilhero/contracts/admin";
import type { FriendRequestStatus, LeagueLevelBand, PairRoomEventKind, PairRole } from "@tilhero/contracts/bff";
import { DAY, HOUR, ID, iso, LEARNER, MIN } from "./data";

const u = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** members of the community without a card in «Ученики» of the mock */
export const MEMBER = {
  rudeFox: u("b1000000", 11),
  quickDuel: u("b1000000", 12),
  invitee1: u("b1000000", 21),
  invitee2: u("b1000000", 22),
  invitee3: u("b1000000", 23),
  invitee4: u("b1000000", 24),
  invitee5: u("b1000000", 25),
  invitee6: u("b1000000", 26),
};
export const CASE = { nick: u("c7000000", 1), duel: u("c7000000", 2), room: u("c7000000", 3), warned: u("c7000000", 4), dismissed: u("c7000000", 5), old: u("c7000000", 6) };
export const SANCTION = { oldWarning: u("57000000", 1), anyaBan: u("57000000", 2), expiredBan: u("57000000", 3), anyaWarning: u("57000000", 4) };
export const APPEAL = { anya: u("a7000000", 1), old: u("a7000000", 2) };
export const REFERRAL = { shortLessons: u("e7000000", 1), velocity: u("e7000000", 2), rejected: u("e7000000", 3), rewarded: u("e7000000", 4), capped: u("e7000000", 5), learning: u("e7000000", 6), legacy: u("e7000000", 7) };
export const GROUP = { a2Now: u("97000000", 1), b1Now: u("97000000", 2), a2Prev: u("97000000", 3), heldPrev: u("97000000", 4) };
export const DUEL = { won: u("d7000000", 1), technical: u("d7000000", 2), running: u("d7000000", 3), challenged: u("d7000000", 4), declined: u("d7000000", 5), cancelled: u("d7000000", 6) };
export const ROOM = { finished: u("f7000000", 1), live: u("f7000000", 2), paused: u("f7000000", 3), waiting: u("f7000000", 4), stopped: u("f7000000", 5), kids: u("f7000000", 6), abandoned: u("f7000000", 7) };

export const STAFF = {
  ops: { staff_id: ID.ops, name: "Тимур" } satisfies StaffRef,
  admin: { staff_id: ID.admin, name: "Игорь Ш." } satisfies StaffRef,
  support: { staff_id: ID.support, name: "Алина" } satisfies StaffRef,
};

/** member_id = "mb_" + 22 url-safe characters (the shape of INTERNAL_API §0; values are fake) */
export const memberId = (userId: string) => `mb_${Buffer.from(userId).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 22).padEnd(22, "x")}`;

export interface Profile {
  nickname: string | null;
  friend_code: string | null;
  hidden: boolean;
  nickname_changed_at: string | null;
  friends: number;
  blocks: { given: number; received: number };
  requests: Array<{ request_id: string; direction: "in" | "out"; status: FriendRequestStatus; created_at: string; decided_at: string | null }>;
}

const req = (n: number, direction: "in" | "out", status: FriendRequestStatus, daysAgo: number): Profile["requests"][number] => ({
  request_id: u("f1000000", n),
  direction,
  status,
  created_at: iso(-daysAgo * DAY),
  decided_at: status === "pending" ? null : iso(-daysAgo * DAY + 3 * HOUR),
});

export function profiles(): Record<string, Profile> {
  return {
    [LEARNER.madina]: { nickname: "TilMaster", friend_code: "TH-K7QM-4PZD", hidden: false, nickname_changed_at: iso(-40 * DAY), friends: 12, blocks: { given: 1, received: 0 }, requests: [req(1, "out", "accepted", 30), req(2, "in", "accepted", 21), req(3, "in", "declined", 12), req(4, "out", "pending", 1)] },
    [LEARNER.botir]: { nickname: "Botir_uz", friend_code: "TH-2WXR-9BNA", hidden: true, nickname_changed_at: iso(-60 * DAY), friends: 4, blocks: { given: 0, received: 0 }, requests: [req(5, "out", "accepted", 50)] },
    [LEARNER.anya]: { nickname: "SkyFox", friend_code: "TH-M3TA-8HKE", hidden: false, nickname_changed_at: iso(-9 * DAY), friends: 31, blocks: { given: 0, received: 3 }, requests: [req(6, "out", "pending", 2), req(7, "out", "expired", 35), req(8, "out", "cancelled", 6), req(9, "in", "accepted", 14)] },
    [LEARNER.kamila]: { nickname: "Kami_14", friend_code: "TH-QR4S-7UVW", hidden: false, nickname_changed_at: iso(-20 * DAY), friends: 6, blocks: { given: 1, received: 0 }, requests: [] },
    [LEARNER.jasur]: { nickname: null, friend_code: null, hidden: false, nickname_changed_at: null, friends: 0, blocks: { given: 0, received: 0 }, requests: [] },
    [MEMBER.rudeFox]: { nickname: "RudeFox", friend_code: "TH-9ZZT-3CQP", hidden: false, nickname_changed_at: iso(-5 * DAY), friends: 2, blocks: { given: 0, received: 4 }, requests: [req(10, "out", "declined", 4), req(11, "out", "declined", 3)] },
    [MEMBER.quickDuel]: { nickname: "QuickDuel", friend_code: "TH-HH7A-2KMR", hidden: false, nickname_changed_at: iso(-15 * DAY), friends: 9, blocks: { given: 0, received: 1 }, requests: [] },
  };
}

const sanction = (id: string, user_id: string, kind: AdminSanction["kind"], extra: Partial<AdminSanction>): AdminSanction => ({
  sanction_id: id,
  user_id,
  kind,
  until: null,
  active: true,
  basis: "",
  case_id: null,
  decided_by: STAFF.ops,
  decided_at: iso(-10 * DAY),
  revoked_at: null,
  revoked_by: null,
  revoke_reason: null,
  appeal: null,
  ...extra,
});

export function sanctions(): AdminSanction[] {
  return [
    sanction(SANCTION.anyaBan, LEARNER.anya, "social_ban", { until: iso(2 * DAY), basis: "Массовые заявки в друзья незнакомым ученикам за один вечер", case_id: CASE.old, decided_at: iso(-1 * DAY), appeal: { appeal_id: APPEAL.anya, status: "open" } }),
    sanction(SANCTION.anyaWarning, LEARNER.anya, "warning", { basis: "Повторяющиеся приглашения в парный урок после отказа", case_id: CASE.warned, decided_at: iso(-12 * DAY), decided_by: STAFF.support }),
    sanction(SANCTION.oldWarning, MEMBER.rudeFox, "warning", { basis: "Грубые сообщения в нике, первое нарушение", decided_at: iso(-20 * DAY), appeal: { appeal_id: APPEAL.old, status: "upheld" } }),
    sanction(SANCTION.expiredBan, MEMBER.quickDuel, "social_ban", { until: iso(-3 * DAY), active: false, basis: "Вызовы на дуэль после блокировки — обход ограничения", decided_at: iso(-10 * DAY) }),
  ];
}

export function appeals(all: AdminSanction[]): AdminSanctionAppeal[] {
  const s = (id: string) => all.find((x) => x.sanction_id === id)!;
  return [
    { appeal_id: APPEAL.anya, sanction: s(SANCTION.anyaBan), text: "Я отправила заявки одноклассникам из нового кружка, а не незнакомым. Прошу снять запрет.", status: "open", created_at: iso(-20 * HOUR), decided_by: null, decided_at: null, decision_note: null },
    { appeal_id: APPEAL.old, sanction: s(SANCTION.oldWarning), text: "Ник был шуткой, я его сменю.", status: "upheld", created_at: iso(-19 * DAY), decided_by: STAFF.support, decided_at: iso(-18 * DAY), decision_note: "Предупреждение остаётся: ник был оскорбительным." },
  ];
}

const baseCase = (id: string, extra: Partial<AdminCase>): AdminCase => ({
  case_id: id,
  status: "open",
  reporter_user_id: LEARNER.madina,
  target_user_id: MEMBER.rudeFox,
  target_nickname: "RudeFox",
  subject_kind: "user",
  subject_id: null,
  reason: "abuse",
  target_complaints_30d: 1,
  created_at: iso(-1 * DAY),
  resolved_at: null,
  comment: null,
  subject: { nickname_at_report: null, status: null },
  resolution: null,
  target_sanctions: [],
  ...extra,
});

export function cases(): AdminCase[] {
  return [
    baseCase(CASE.nick, { subject_kind: "nickname", reason: "inappropriate_nickname", target_complaints_30d: 4, created_at: iso(-2 * DAY), comment: "Ник оскорбительный, видно в лиге друзей", subject: { nickname_at_report: "RudeFox", status: null } }),
    baseCase(CASE.duel, { reporter_user_id: LEARNER.kamila, target_user_id: MEMBER.quickDuel, target_nickname: "QuickDuel", subject_kind: "duel", subject_id: DUEL.technical, reason: "cheating", target_complaints_30d: 2, created_at: iso(-30 * HOUR), comment: "Слишком быстро ответил на все задания", subject: { nickname_at_report: "QuickDuel", status: "finished" } }),
    baseCase(CASE.room, { reporter_user_id: LEARNER.botir, target_user_id: LEARNER.anya, target_nickname: "SkyFox", subject_kind: "pair_room", subject_id: ROOM.live, reason: "abuse", target_complaints_30d: 3, created_at: iso(-50 * MIN), comment: null, subject: { nickname_at_report: "SkyFox", status: "in_progress" } }),
    baseCase(CASE.warned, { reporter_user_id: LEARNER.kamila, target_user_id: LEARNER.anya, target_nickname: "SkyFox", subject_kind: "invite", subject_id: ROOM.waiting, reason: "spam", status: "resolved", created_at: iso(-13 * DAY), resolved_at: iso(-12 * DAY), subject: { nickname_at_report: "SkyFox", status: "declined" }, resolution: { action: "warning", sanction_id: SANCTION.anyaWarning, basis: "Повторяющиеся приглашения в парный урок после отказа", resolved_by: STAFF.support } }),
    baseCase(CASE.dismissed, { reporter_user_id: LEARNER.anya, target_user_id: LEARNER.madina, target_nickname: "TilMaster", subject_kind: "friend_request", subject_id: u("f1000000", 3), reason: "spam", status: "dismissed", created_at: iso(-11 * DAY), resolved_at: iso(-11 * DAY + 2 * HOUR), subject: { nickname_at_report: "TilMaster", status: "declined" }, resolution: { action: "dismiss", sanction_id: null, basis: "Одна заявка в друзья — не спам", resolved_by: STAFF.ops } }),
    baseCase(CASE.old, { reporter_user_id: LEARNER.kamila, target_user_id: LEARNER.anya, target_nickname: "SkyFox", subject_kind: "user", reason: "spam", status: "resolved", created_at: iso(-30 * HOUR), resolved_at: iso(-1 * DAY), subject: { nickname_at_report: "SkyFox", status: null }, resolution: { action: "social_ban", sanction_id: SANCTION.anyaBan, basis: "Массовые заявки в друзья незнакомым ученикам за один вечер", resolved_by: STAFF.ops } }),
  ];
}

/* ---------------------------------------------------------------- referrals */

export const CAMPAIGN_V1: ReferralCampaignPayload = {
  require_diagnostic: true, min_lessons: 3, min_days: 2, window_days: 30, inviter_reward: { freeze: 2, til: 0 }, invitee_reward: { freeze: 0, til: 0 }, monthly_cap: 10, review: { velocity_per_day: 5, min_lesson_minutes: 3 },
};
export const CAMPAIGN_V2: ReferralCampaignPayload = { ...CAMPAIGN_V1, inviter_reward: { freeze: 2, til: 50 }, invitee_reward: { freeze: 1, til: 0 } };

export function campaigns(): ReferralCampaignVersion[] {
  return [
    { version: 1, status: "archived", comment: "Версия 1 из миграции: 2 заморозки пригласившему", based_on: null, created_by: null, created_at: iso(-40 * DAY), validated_at: iso(-40 * DAY), activated_by: null, activated_at: iso(-40 * DAY), payload: CAMPAIGN_V1, diff: [], updated_at: iso(-40 * DAY) },
    { version: 2, status: "active", comment: "Плюс 50 тилов пригласившему и заморозка приглашённому", based_on: 1, created_by: STAFF.ops, created_at: iso(-10 * DAY), validated_at: iso(-10 * DAY), activated_by: STAFF.ops, activated_at: iso(-9 * DAY), payload: CAMPAIGN_V2, diff: [], updated_at: iso(-10 * DAY) },
  ];
}

const refBase = (id: string, extra: Partial<AdminReferral>): AdminReferral => ({
  referral_id: id,
  inviter_user_id: LEARNER.madina,
  invitee_user_id: MEMBER.invitee1,
  campaign_version: 2,
  status: "review",
  accepted_at: iso(-9 * DAY),
  diagnostic_at: iso(-9 * DAY + 2 * HOUR),
  lessons: 3,
  days: 2,
  minutes_total: 31,
  risk_flags: [],
  reject_code: null,
  reward_outcome: null,
  qualified_at: null,
  decided_by: null,
  decided_at: null,
  lessons_log: [],
  inviter_month: { qualified: 4, cap: 10 },
  decision_history: [],
  can_redecide: false,
  ...extra,
});
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY + 5 * HOUR).toISOString().slice(0, 10);

export function referrals(): AdminReferral[] {
  return [
    refBase(REFERRAL.shortLessons, { accepted_at: iso(-8 * DAY), minutes_total: 7, risk_flags: ["short_lessons"], lessons_log: [{ local_date: day(7), minutes: 2 }, { local_date: day(7), minutes: 2 }, { local_date: day(6), minutes: 3 }] }),
    refBase(REFERRAL.velocity, { inviter_user_id: LEARNER.botir, invitee_user_id: MEMBER.invitee2, accepted_at: iso(-5 * DAY), lessons: 4, days: 3, minutes_total: 46, risk_flags: ["velocity", "activity_before_accept"], inviter_month: { qualified: 10, cap: 10 }, lessons_log: [{ local_date: day(6), minutes: 12 }, { local_date: day(4), minutes: 11 }, { local_date: day(3), minutes: 12 }, { local_date: day(2), minutes: 11 }] }),
    refBase(REFERRAL.rejected, { invitee_user_id: MEMBER.invitee3, status: "rejected", reject_code: "review_rejected", risk_flags: ["family_member"], accepted_at: iso(-15 * DAY), decided_by: STAFF.support, decided_at: iso(-3 * DAY), can_redecide: true, lessons_log: [{ local_date: day(14), minutes: 10 }, { local_date: day(12), minutes: 11 }, { local_date: day(11), minutes: 10 }], decision_history: [{ decision: "rejected", reject_code: "review_rejected", note: "Похоже на члена семьи — проверить по обращению", by: STAFF.support, at: iso(-3 * DAY) }] }),
    refBase(REFERRAL.rewarded, { invitee_user_id: MEMBER.invitee4, status: "rewarded", reward_outcome: "rewarded", accepted_at: iso(-20 * DAY), qualified_at: iso(-14 * DAY), lessons: 5, days: 4, minutes_total: 62 }),
    // sprint 6 rule: the reward was granted before the campaign; gamification acked it as legacy
    refBase(REFERRAL.legacy, { invitee_user_id: MEMBER.invitee5, campaign_version: 1, status: "rewarded", reward_outcome: "legacy", accepted_at: iso(-35 * DAY), qualified_at: iso(-31 * DAY), lessons: 3, days: 3, minutes_total: 40 }),
    refBase(REFERRAL.capped, { inviter_user_id: LEARNER.botir, invitee_user_id: null, status: "capped", reject_code: "monthly_cap", reward_outcome: "inviter_capped", accepted_at: iso(-16 * DAY), qualified_at: iso(-10 * DAY), inviter_month: { qualified: 10, cap: 10 } }),
    refBase(REFERRAL.learning, { invitee_user_id: MEMBER.invitee6, status: "learning", accepted_at: iso(-2 * DAY), lessons: 1, days: 1, minutes_total: 14 }),
  ];
}

/* ---------------------------------------------------------------- leagues */

export interface GroupSeed {
  group_id: string;
  week: string;
  pair_id: string;
  level_band: LeagueLevelBand;
  group_no: number;
  status: LeagueGroupStatus;
  members: AdminLeagueMember[];
  results: AdminLeagueResult[];
}

const NICKS = ["SkyFox", "TilMaster", "Kami_14", "Botir_uz", "Lingvo", "SamarkandStar", "Yulduz", "BlueOwl", "Shox", "Nodir_A", "Laylo", "Aziz7", "Mira", "Sardor_22", "Zarina", "Kumush", "Bek", "Dilnoza_r", "Otabek", "Gulya", "Rustam", "Malika"];
const PRIZES = [50, 30, 20];

/** members by XP (desc); an anomaly at `anomalyAt` (index) */
export function members(seed: number, n: number, opts: { anomalyAt?: number; base?: number } = {}): AdminLeagueMember[] {
  const xs = Array.from({ length: n }, (_, i) => {
    const uid = i === 0 ? LEARNER.anya : i === 1 ? LEARNER.madina : i === 2 ? LEARNER.kamila : u(`9${seed}100000`.slice(0, 8), 100 + i);
    const xp = i === opts.anomalyAt ? 4200 : Math.max(20, (opts.base ?? 520) - i * 21 - ((i * 37) % 13));
    return { user_id: uid, member_id: memberId(uid), nickname: NICKS[i % NICKS.length]!, xp, place: 0, prize_til: 0, anomaly: i === opts.anomalyAt, excluded: false, joined_at: iso(-(6 - (i % 5)) * DAY) } satisfies AdminLeagueMember;
  });
  xs.sort((a, b) => b.xp - a.xp);
  xs.forEach((m, i) => {
    m.place = i + 1;
    m.prize_til = PRIZES[i] ?? 0;
  });
  return xs;
}

export const standingsOf = (ms: AdminLeagueMember[]) => ms.filter((m) => m.place != null && !m.excluded).map((m) => ({ user_id: m.user_id, place: m.place!, xp: m.xp, prize_til: m.prize_til }));

/* ---------------------------------------------------------------- duels */

export function duels(): AdminDuel[] {
  const base = (id: string, extra: Partial<AdminDuel>): AdminDuel => ({
    duel_id: id,
    status: "finished",
    challenger_user_id: LEARNER.madina,
    opponent_user_id: LEARNER.anya,
    pair_id: "ru-en",
    level_band: "A2",
    scores: { challenger: null, opponent: null },
    result: null,
    technical: false,
    result_version: 1,
    created_at: iso(-3 * DAY),
    finished_at: null,
    set_id: u("5e700000", 1),
    accept_deadline: iso(-2 * DAY),
    play_deadline: iso(0),
    rewards: [],
    history: [],
    ...extra,
  });
  return [
    base(DUEL.won, { scores: { challenger: { correct: 8, total: 10 }, opponent: { correct: 6, total: 10 } }, result: "challenger", finished_at: iso(-1 * DAY), history: [{ version: 1, result: "challenger", reason: null, by: null, at: iso(-1 * DAY) }], rewards: [{ user_id: LEARNER.madina, op_id: u("0e700000", 1), amount: 30, status: "confirmed", result_version: 1 }, { user_id: LEARNER.anya, op_id: u("0e700000", 2), amount: 10, status: "confirmed", result_version: 1 }] }),
    base(DUEL.technical, { challenger_user_id: MEMBER.quickDuel, opponent_user_id: LEARNER.kamila, level_band: "A0-A1", created_at: iso(-4 * DAY), scores: { challenger: { correct: 10, total: 10 }, opponent: null }, result: "challenger", technical: true, finished_at: iso(-30 * HOUR), history: [{ version: 1, result: "challenger", reason: null, by: null, at: iso(-30 * HOUR) }], set_id: u("5e700000", 2), rewards: [{ user_id: MEMBER.quickDuel, op_id: u("0e700000", 3), amount: 30, status: "confirmed", result_version: 1 }] }),
    base(DUEL.running, { status: "accepted", challenger_user_id: LEARNER.kamila, opponent_user_id: LEARNER.anya, created_at: iso(-6 * HOUR), accept_deadline: iso(18 * HOUR), play_deadline: iso(42 * HOUR), set_id: u("5e700000", 3) }),
    base(DUEL.challenged, { status: "challenged", challenger_user_id: LEARNER.anya, opponent_user_id: LEARNER.madina, created_at: iso(-2 * HOUR), accept_deadline: iso(22 * HOUR), play_deadline: null, set_id: null }),
    base(DUEL.declined, { status: "declined", created_at: iso(-5 * DAY), accept_deadline: iso(-4 * DAY), play_deadline: null, set_id: null }),
    base(DUEL.cancelled, { status: "cancelled", result: "none", created_at: iso(-7 * DAY), finished_at: iso(-5 * DAY), set_id: u("5e700000", 6) }),
  ];
}

/* ---------------------------------------------------------------- pair rooms */

const ev = (seq: number, kind: PairRoomEventKind, role: PairRole | null, minsAgo: number) => ({ seq, kind, role, at: iso(-minsAgo * MIN) });

export function rooms(): AdminPairRoom[] {
  const base = (id: string, extra: Partial<AdminPairRoom>): AdminPairRoom => ({
    room_id: id,
    status: "finished",
    pair_id: "ru-en",
    scenario_id: "sc-cafe-order",
    scenario_title: { ru: "В кафе: заказ на двоих", uz: "Kafeda: ikki kishilik buyurtma" },
    mode: "free",
    participants: [],
    created_at: iso(-3 * HOUR),
    start_at: iso(-3 * HOUR),
    started_at: iso(-3 * HOUR + 2 * MIN),
    ended_at: null,
    duration_s: 0,
    end_reason: null,
    ai_cost_usd: 0,
    timeline: [],
    stopped_by: null,
    stop_reason: null,
    ...extra,
  });
  const p = (side: "inviter" | "invitee", user_id: string | null, role: PairRole | null, turns: number, speaking_seconds: number, minutes: number, network: "online" | "offline" | null, joinedMinsAgo: number | null) => ({ user_id, side, role, turns, speaking_seconds, minutes, contributed: turns > 0, network, joined_at: joinedMinsAgo == null ? null : iso(-joinedMinsAgo * MIN) });
  return [
    base(ROOM.live, { status: "in_progress", created_at: iso(-20 * MIN), start_at: iso(-15 * MIN), started_at: iso(-12 * MIN), duration_s: 12 * 60 + 4, ai_cost_usd: 0.0123, participants: [p("inviter", LEARNER.anya, "A", 5, 142, 13, "online", 12), p("invitee", LEARNER.botir, "B", 4, 96, 13, "online", 12)], timeline: [ev(1, "joined", "A", 12), ev(2, "joined", "B", 12), ev(3, "roles", null, 12), ev(4, "coach", null, 11), ev(5, "turn", "A", 10), ev(6, "turn", "B", 9), ev(7, "coach", null, 8), ev(8, "turn", "A", 7), ev(9, "turn", "B", 5)] }),
    base(ROOM.paused, { status: "paused", scenario_id: "sc-hotel-checkin", scenario_title: { ru: "Заселение в отель", uz: "Mehmonxonaga joylashish" }, created_at: iso(-40 * MIN), start_at: iso(-40 * MIN), started_at: iso(-38 * MIN), duration_s: 9 * 60 + 40, ai_cost_usd: 0.0098, participants: [p("inviter", LEARNER.madina, "A", 3, 70, 10, "online", 38), p("invitee", LEARNER.kamila, "B", 2, 41, 10, "offline", 38)], timeline: [ev(1, "joined", "A", 38), ev(2, "joined", "B", 38), ev(3, "roles", null, 37), ev(4, "turn", "A", 35), ev(5, "turn", "B", 33), ev(6, "offline", "B", 2), ev(7, "paused", null, 2)] }),
    base(ROOM.waiting, { status: "waiting", created_at: iso(-10 * MIN), start_at: iso(-5 * MIN), started_at: null, duration_s: 0, participants: [p("inviter", LEARNER.kamila, null, 0, 0, 0, "online", 4), p("invitee", LEARNER.anya, null, 0, 0, 0, null, null)], timeline: [ev(1, "joined", null, 4)] }),
    base(ROOM.finished, { status: "finished", created_at: iso(-26 * HOUR), start_at: iso(-26 * HOUR), started_at: iso(-26 * HOUR + 1 * MIN), ended_at: iso(-26 * HOUR + 16 * MIN), duration_s: 14 * 60 + 20, end_reason: "completed", ai_cost_usd: 0.0418, participants: [p("inviter", LEARNER.madina, "A", 9, 212, 15, null, 26 * 60), p("invitee", LEARNER.anya, "B", 8, 188, 15, null, 26 * 60)], timeline: [ev(1, "joined", "A", 1560), ev(2, "joined", "B", 1560), ev(3, "roles", null, 1559), ev(4, "turn", "A", 1556), ev(5, "turn", "B", 1554), ev(6, "turn", "A", 1550), ev(7, "turn", "B", 1548), ev(8, "finished", null, 1544)] }),
    base(ROOM.stopped, { status: "stopped", scenario_id: "sc-market", scenario_title: { ru: "На рынке", uz: "Bozorda" }, created_at: iso(-3 * DAY), start_at: iso(-3 * DAY), started_at: iso(-3 * DAY + 1 * MIN), ended_at: iso(-3 * DAY + 6 * MIN), duration_s: 5 * 60, end_reason: "stopped", ai_cost_usd: 0.0061, participants: [p("inviter", MEMBER.rudeFox, "A", 3, 50, 6, null, 3 * 1440), p("invitee", LEARNER.madina, "B", 1, 12, 6, null, 3 * 1440)], timeline: [ev(1, "joined", "A", 4320), ev(2, "joined", "B", 4320), ev(3, "roles", null, 4319), ev(4, "turn", "A", 4318), ev(5, "stopped", null, 4315)], stopped_by: STAFF.ops, stop_reason: "Жалоба на грубость в комнате, подтверждена" }),
    base(ROOM.kids, { status: "finished", mode: "choices", pair_id: "uz-en", scenario_id: "sc-kids-zoo", scenario_title: { ru: "В зоопарке", uz: "Hayvonot bogʻida" }, created_at: iso(-2 * DAY), start_at: iso(-2 * DAY), started_at: iso(-2 * DAY + 1 * MIN), ended_at: iso(-2 * DAY + 11 * MIN), duration_s: 10 * 60 + 5, end_reason: "completed", ai_cost_usd: 0, participants: [p("inviter", LEARNER.lola, "A", 6, 120, 11, null, 2 * 1440), p("invitee", LEARNER.timur, "B", 6, 131, 11, null, 2 * 1440)], timeline: [ev(1, "joined", "A", 2880), ev(2, "joined", "B", 2880), ev(3, "roles", null, 2879), ev(4, "finished", null, 2869)] }),
    base(ROOM.abandoned, { status: "abandoned", created_at: iso(-5 * DAY), start_at: iso(-5 * DAY), started_at: iso(-5 * DAY + 1 * MIN), ended_at: iso(-5 * DAY + 9 * MIN), duration_s: 8 * 60, end_reason: "participant_left", ai_cost_usd: 0.0057, participants: [p("inviter", LEARNER.botir, "A", 4, 90, 9, null, 5 * 1440), p("invitee", LEARNER.kamila, "B", 0, 0, 4, null, 5 * 1440)], timeline: [ev(1, "joined", "A", 7200), ev(2, "joined", "B", 7200), ev(3, "left", "B", 7196), ev(4, "finished", null, 7191)] }),
  ];
}
