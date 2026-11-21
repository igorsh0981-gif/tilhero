/**
 * Sprint 7 — the logic of the social screens: the nickname and the search query, members by nickname or «Друг» /
 * «Участник семьи» (never a name), the tabs of the leagues (a child — only the family, no places), the phases of a duel,
 * the progress of a referral and its public reason, the texts of social errors with their details; the pair room — the
 * long-poll link (after_seq, abort on leave, retries, the heartbeat every 10 s, the end), whose turn it is and how one
 * answers (a child — choices only, no voice).
 */
import type { DuelView, Family, PairRoomEvent, PairRoomState, ReferralView, Standings } from "@tilhero/contracts/bff";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors";
import {
  canUseVoice,
  closedWhy,
  HEARTBEAT_MS,
  inputMode,
  isLive,
  isTerminal,
  lineOf,
  lobbyPhase,
  mergeEvents,
  partnerNetwork,
  RoomLink,
  roomGone,
  startValue,
  turnInfo,
  turnMark,
} from "../src/domain/pairRoom";
import {
  badgeNames,
  cardAction,
  duelPhase,
  familyPick,
  friendsGate,
  leagueBadgeCodes,
  legacyExpired,
  leagueTabs,
  memberLabel,
  nicknameProblem,
  prizeOf,
  referralPct,
  referralSteps,
  rejectReason,
  scoreText,
  searchQuery,
  showPlaces,
  socialDown,
  socialErrorText,
  standingRows,
} from "../src/domain/social";
import { makeFormatters, translate, type MessageKey, type Vars } from "../src/i18n";
import { ru } from "../src/i18n/ru";
import { uz } from "../src/i18n/uz";

const t = (k: MessageKey, v?: Vars) => translate("ru", k, v);
const fmt = makeFormatters("ru");

describe("nickname and search", () => {
  it("3–20 letters (RU / UZ / EN), digits and «_»", () => {
    expect(nicknameProblem("Aziz_23")).toBeNull();
    expect(nicknameProblem("Азиз")).toBeNull();
    // Uzbek Latin: ʻ (U+02BB) is a modifier letter (Lm) — a letter
    expect(nicknameProblem("Oʻgʻil")).toBeNull();
    expect(nicknameProblem("ab")).toBe("length");
    expect(nicknameProblem("a".repeat(21))).toBe("length");
    expect(nicknameProblem("Aziz Tj")).toBe("chars");
    expect(nicknameProblem("aziz!")).toBe("chars");
    expect(nicknameProblem("  Malika  ")).toBeNull();
  });

  it("a friend code in any case, with or without dashes → TH-XXXX-XXXX; else an exact nickname; else nothing", () => {
    expect(searchQuery("th-7qkd-m3px")).toEqual({ kind: "code", q: "TH-7QKD-M3PX" });
    expect(searchQuery("TH7QKDM3PX")).toEqual({ kind: "code", q: "TH-7QKD-M3PX" });
    expect(searchQuery(" TH 7QKD M3PX ")).toEqual({ kind: "code", q: "TH-7QKD-M3PX" });
    // the alphabet has no 0 / O / 1 / I: such a «code» is neither a code nor a nickname
    expect(searchQuery("TH-0OKD-M3PX")).toBeNull();
    expect(searchQuery("Malika_23")).toEqual({ kind: "nickname", q: "Malika_23" });
    expect(searchQuery("Thomas")).toEqual({ kind: "nickname", q: "Thomas" });
    expect(searchQuery("ab")).toBeNull();
    expect(searchQuery("")).toBeNull();
  });

  it("a found card: add, answer, take back, already friends, myself", () => {
    expect(cardAction({ relation: "none" })).toBe("add");
    expect(cardAction({ relation: "request_in" })).toBe("respond");
    expect(cardAction({ relation: "request_out" })).toBe("cancel");
    expect(cardAction({ relation: "friend" })).toBe("friend");
    expect(cardAction({ relation: "self" })).toBe("self");
  });

  it("friends: a child — only the family; a teen without the parent; no consent «social»", () => {
    expect(friendsGate({ friends_available: true, friends_unavailable_reason: null }, false)).toBe("ok");
    expect(friendsGate({ friends_available: true, friends_unavailable_reason: null }, true)).toBe("kids");
    expect(friendsGate({ friends_available: false, friends_unavailable_reason: "guardian_consent" }, false)).toBe("guardian_consent");
    expect(friendsGate({ friends_available: false, friends_unavailable_reason: null }, false)).toBe("consent");
    expect(friendsGate(null, false)).toBe("ok");
  });
});

describe("privacy: nobody by name", () => {
  it("a nickname, else «Друг» / «Участник семьи»", () => {
    expect(memberLabel("Malika_23", t)).toBe("Malika_23");
    expect(memberLabel(null, t)).toBe("Друг");
    expect(memberLabel("  ", t)).toBe("Друг");
    expect(memberLabel(null, t, "family")).toBe("Участник семьи");
  });

  it("the family to choose from: member_id and the nickname of the family league — never display_name", () => {
    const family: Family = {
      family_id: "f",
      members: [
        { user_id: "u1", member_id: "mb_parent00000000000000", display_name: "Азиз Каримов", role: "owner", is_me: false },
        { user_id: "u2", member_id: "mb_me0000000000000000000", display_name: "Мадина", role: "child", is_me: true },
        { user_id: "u3", member_id: "mb_sib10000000000000000", display_name: "Сардор", role: "child", is_me: false },
        { user_id: "u4", member_id: "mb_sib20000000000000000", display_name: "Нигора", role: "teen", is_me: false },
      ],
    };
    const standings: Standings = {
      rows: [{ member_id: "mb_parent00000000000000", nickname: "Aziz_TH", hero: null, xp: 100, place: 1, badges: [], me: false }],
      me_row: null,
      participants: 4,
      total_xp: 300,
    };
    const out = familyPick(family, standings, t);
    expect(out.map((m) => m.label)).toEqual(["Aziz_TH", "Участник семьи 1", "Участник семьи 2"]);
    expect(out.map((m) => m.member_id)).toEqual(["mb_parent00000000000000", "mb_sib10000000000000000", "mb_sib20000000000000000"]);
    expect(JSON.stringify(out)).not.toMatch(/Азиз|Сардор|Нигора|u1|u3/);
    // one unnamed member — without a number
    expect(familyPick({ ...family, members: family.members.slice(0, 3) }, standings, t).map((m) => m.label)).toEqual(["Aziz_TH", "Участник семьи"]);
    expect(familyPick(null, standings, t)).toEqual([]);
  });
});

describe("leagues", () => {
  const s = (rows: Standings["rows"], me_row: Standings["me_row"] = null): Standings => ({ rows, me_row, participants: rows.length + (me_row ? 1 : 0), total_xp: 0 });
  const row = (place: number, me = false) => ({ member_id: `mb_${place}`, nickname: `n${place}`, hero: null, xp: 100 - place, place, badges: [], me });

  it("badge names (F7-14): the 9 named ones, then the catalogue title; an unnamed code — «значок» once, never twice", () => {
    const titles = new Map([["streak_100", "100 дней подряд"]]);
    expect(badgeNames(["streak_7", "first_lesson"], t)).toEqual(["Неделя подряд", "Первый урок"]);
    expect(badgeNames(["streak_100", "skills_50", "reviews_1000"], t, titles)).toEqual(["100 дней подряд", "значок"]);
    expect(badgeNames(["skills_50", "reviews_1000", "x"], t)).toEqual(["значок"]);
    expect(badgeNames([], t)).toEqual([]);
    const withBadges = (badges: string[], place: number) => ({ ...row(place), badges });
    expect(leagueBadgeCodes({ friends: s([withBadges(["a", "b"], 1)], withBadges(["c"], 9)), family: null, general: { group: s([withBadges(["a"], 1)]) } as never }).sort()).toEqual(["a", "b", "c"]);
  });

  it("a child — only the family tab and no places; the rest — friends, family (if any), general", () => {
    expect(leagueTabs({ friends: s([]), family: s([]) }, true)).toEqual(["family"]);
    expect(leagueTabs({ friends: s([]), family: null }, false)).toEqual(["friends", "general"]);
    expect(leagueTabs({ friends: s([]), family: s([]) }, false)).toEqual(["friends", "family", "general"]);
    expect(showPlaces(true)).toBe(false);
    expect(showPlaces(false)).toBe(true);
  });

  it("my row under the top when it is not there", () => {
    expect(standingRows(s([row(2), row(1)])).map((r) => r.place)).toEqual([1, 2]);
    expect(standingRows(s([row(1), row(2)], row(57, true))).map((r) => r.place)).toEqual([1, 2, 57]);
    expect(standingRows(s([row(1), row(2, true)], row(2, true))).map((r) => r.place)).toEqual([1, 2]);
  });

  it("prizes of places 1–3 from the rules", () => {
    expect(prizeOf([50, 30, 20], 1)).toBe(50);
    expect(prizeOf([50, 30, 20], 3)).toBe(20);
    expect(prizeOf([50, 30, 20], 4)).toBeNull();
    expect(prizeOf([50, 30, 20], 0)).toBeNull();
  });

  it("children's texts: «вместе набрали», no «последний», no comparisons", () => {
    for (const k of ["lg.togetherKid", "lg.kidNote", "lg.rowAriaKid", "du.res.lossKid", "du.res.drawKid", "du.waitTextKid", "prep.noContributionKid", "soc.privacyKid"] as const) {
      expect(ru[k]).not.toMatch(/последн|проиграл|хуже|рейтинг|потеря|провал/i);
    }
    expect(t("lg.togetherKid", { n: 420 })).toBe("Вместе вы набрали 420 XP — так держать!");
  });
});

describe("duels", () => {
  const d = (over: Partial<DuelView>): Pick<DuelView, "status" | "can_accept" | "can_play" | "my_played" | "result"> => ({ status: "challenged", can_accept: false, can_play: false, my_played: false, result: null, ...over });
  it("phases from my side", () => {
    expect(duelPhase(d({ can_accept: true }))).toBe("incoming");
    expect(duelPhase(d({}))).toBe("awaiting");
    expect(duelPhase(d({ status: "accepted", can_play: true }))).toBe("play");
    expect(duelPhase(d({ status: "accepted", my_played: true }))).toBe("waiting");
    expect(duelPhase(d({ status: "finished" }))).toBe("result");
    expect(duelPhase(d({ status: "declined" }))).toBe("declined");
    expect(duelPhase(d({ status: "expired" }))).toBe("expired");
    expect(duelPhase(d({ status: "cancelled" }))).toBe("cancelled");
  });
  it("a score or «не сыграно»", () => {
    expect(scoreText({ correct: 8, total: 10 }, t)).toBe("8 из 10");
    expect(scoreText(null, t)).toBe("не сыграно");
  });
});

describe("referrals: «диагностика, уроки 1/3, дни 1/2»", () => {
  const v = (over: Partial<ReferralView["progress"]>, status: ReferralView["status"] = "learning", reject: ReferralView["reject_code"] = null): ReferralView => ({
    referral_id: "r",
    invitee_nickname: null,
    status,
    progress: { diagnostic: true, diagnostic_required: true, lessons: 1, lessons_required: 3, days: 1, days_required: 2, window_ends_at: "2026-12-01T00:00:00Z", ...over },
    reward: null,
    reward_outcome: status === "rewarded" ? "rewarded" : status === "capped" ? "inviter_capped" : null,
    reject_code: reject,
    legacy: false,
    accepted_at: "2026-11-10T00:00:00Z",
  });

  it("the steps in order; values never above the requirement", () => {
    expect(referralSteps(v({}))).toEqual([
      { key: "diagnostic", value: 1, required: 1, done: true },
      { key: "lessons", value: 1, required: 3, done: false },
      { key: "days", value: 1, required: 2, done: false },
    ]);
    expect(referralSteps(v({ lessons: 5, days: 4 })).map((s) => [s.value, s.done])).toEqual([[1, true], [3, true], [2, true]]);
    // a campaign without the placement test
    expect(referralSteps(v({ diagnostic_required: false, diagnostic: false })).map((s) => s.key)).toEqual(["lessons", "days"]);
  });

  it("the share of the conditions: each condition weighs the same", () => {
    // (1 + 1/3 + 1/2) / 3 = 0.611
    expect(referralPct(v({}))).toBe(61);
    expect(referralPct(v({ diagnostic: false, lessons: 0, days: 0 }))).toBe(0);
    expect(referralPct(v({ lessons: 3, days: 2 }))).toBe(100);
    expect(referralPct(v({ lessons: 0 }, "review"))).toBe(100);
  });

  it("the public reason of a refusal — never the anti-fraud rules", () => {
    expect(rejectReason(v({}, "rejected", "review_rejected"))).toBe("review_rejected");
    expect(rejectReason(v({}, "expired"))).toBe("window_expired");
    expect(rejectReason(v({}, "capped"))).toBe("monthly_cap");
    expect(rejectReason(v({}, "learning"))).toBeNull();
    // the former programme, expired: no reason (reject_code null) — «Приглашение по прежней программе»
    expect(rejectReason({ ...v({}, "expired"), legacy: true })).toBeNull();
    expect(legacyExpired({ ...v({}, "expired"), legacy: true })).toBe(true);
    expect(legacyExpired({ ...v({}, "rewarded"), legacy: true })).toBe(false);
    expect(legacyExpired(v({}, "expired"))).toBe(false);
    for (const code of ["not_new_user", "family_member", "window_expired", "review_rejected", "monthly_cap"] as const) {
      expect(ru[`ref.reject.${code}`]).not.toMatch(/скорост|velocity|минут|антифрод|подозр/i);
    }
  });
});

describe("social errors with their details", () => {
  const e = (status: number, code: string, details: Record<string, unknown> = {}) => new ApiError(status, code, code, details);
  it("SOCIAL_RESTRICTED until a date / without a term", () => {
    expect(socialErrorText(e(403, "SOCIAL_RESTRICTED", { until: "2026-11-25T10:00:00Z" }), t, fmt)).toMatch(/^Социальные действия ограничены до 25 ноября, \d\d:00\.$/);
    expect(socialErrorText(e(403, "SOCIAL_RESTRICTED", { until: null }), t, fmt)).toBe("Социальные действия сейчас ограничены.");
  });
  it("NICKNAME_INVALID by reason, NICKNAME_TAKEN, NICKNAME_COOLDOWN with the date", () => {
    expect(socialErrorText(e(422, "NICKNAME_INVALID", { reason: "forbidden" }), t, fmt)).toBe("Такой ник нельзя — выберите другой.");
    expect(socialErrorText(e(422, "NICKNAME_INVALID", { reason: "chars" }), t, fmt)).toBe("Только буквы, цифры и «_» — без пробелов и знаков.");
    expect(socialErrorText(e(409, "NICKNAME_TAKEN"), t, fmt)).toBe("Этот ник уже занят — выберите другой.");
    expect(socialErrorText(e(429, "NICKNAME_COOLDOWN", { until: "2026-11-28T09:00:00Z" }), t, fmt)).toMatch(/^Ник можно будет сменить 28 ноября/);
  });
  it("BLOCKED never says who blocked; FRIENDS_NOT_ALLOWED for a child", () => {
    expect(socialErrorText(e(403, "BLOCKED"), t, fmt)).toBe("Это действие с этим учеником недоступно.");
    expect(socialErrorText(e(403, "FRIENDS_NOT_ALLOWED", { reason: "kids" }), t, fmt)).toBe("В детском профиле — только семья.");
  });
  it("the voice of the room: the consent of the learner / of the parent, recognition down", () => {
    expect(socialErrorText(e(403, "VOICE_CONSENT_REQUIRED", { who: "self" }), t, fmt)).toMatch(/после согласия на запись голоса/);
    expect(socialErrorText(e(403, "VOICE_CONSENT_REQUIRED", { who: "guardian" }), t, fmt)).toMatch(/согласия родителя/);
    expect(socialErrorText(e(503, "SPEECH_UNAVAILABLE"), t, fmt)).toBe("Голос сейчас недоступен — отвечайте текстом.");
    expect(socialErrorText(e(422, "AUDIO_INVALID", { reason: "too_short" }), t, fmt)).toBe(ru["pn.tooShort"]);
  });
  it("a domain down — the block says so, learning goes on", () => {
    expect(socialDown(e(503, "UPSTREAM_UNAVAILABLE", { service: "social" }))).toBe(true);
    expect(socialDown(e(503, "GAME_UNAVAILABLE"))).toBe(true);
    expect(socialDown(e(409, "DUEL_STATE"))).toBe(false);
    expect(socialErrorText(e(409, "DUEL_EXISTS"), t, fmt)).toBe("С этим учеником дуэль уже идёт.");
  });
  it("UZ: the same keys, Latin", () => {
    expect(translate("uz", "err.SOCIAL_RESTRICTED.until", { date: "25-noyabr" })).toBe("Ijtimoiy amallar 25-noyabr gacha cheklangan.");
    expect(uz["lg.togetherKid"]).not.toMatch(/[Ѐ-ӿ]/);
  });
});

/* ---------------------------------------------------------------- the pair room */

function state(over: Partial<PairRoomState> = {}): PairRoomState {
  return {
    room_id: "r",
    status: "in_progress",
    seq: 0,
    events: [],
    mode: "free",
    my_role: "A",
    my_role_brief: null,
    team_goal: null,
    team_goal_progress: 0,
    next_speaker: "A",
    prompt: null,
    prompt_gloss: null,
    options: null,
    participants: [
      { role: "A", me: true, network: "online" },
      { role: "B", me: false, network: "online" },
    ],
    ai_degraded: false,
    voice_available: true,
    my_speaking_seconds: 0,
    ...over,
  };
}
const ev = (seq: number, kind: PairRoomEvent["kind"] = "turn", role: PairRoomEvent["role"] = "A"): PairRoomEvent => ({ seq, kind, role, text: kind === "turn" || kind === "coach" ? `t${seq}` : null, at: "2026-11-21T10:00:00Z" });

describe("pair room: turns and input", () => {
  it("whose turn: mine, the partner's, both, nobody (the coach, a pause, waiting)", () => {
    expect(turnInfo(state())).toEqual({ mine: true, who: "me" });
    expect(turnInfo(state({ next_speaker: "B" }))).toEqual({ mine: false, who: "partner" });
    expect(turnInfo(state({ next_speaker: "both" }))).toEqual({ mine: true, who: "both" });
    expect(turnInfo(state({ next_speaker: null }))).toEqual({ mine: false, who: "nobody" });
    expect(turnInfo(state({ status: "paused" }))).toEqual({ mine: false, who: "nobody" });
    expect(turnInfo(state({ status: "waiting", my_role: null }))).toEqual({ mine: false, who: "nobody" });
  });

  it("how I answer: free text (14+), choices (a child, the scenario without the AI, options), wait", () => {
    const opts = [{ choice_id: "c1", text_en: "Hi" }];
    expect(inputMode(state(), false)).toBe("free");
    expect(inputMode(state({ options: opts }), false)).toBe("choices");
    expect(inputMode(state({ mode: "choices", options: opts }), false)).toBe("choices");
    expect(inputMode(state({ ai_degraded: true, options: opts }), false)).toBe("choices");
    // a child never types: without options a child waits
    expect(inputMode(state({ options: opts }), true)).toBe("choices");
    expect(inputMode(state(), true)).toBe("wait");
    expect(inputMode(state({ next_speaker: "B" }), false)).toBe("wait");
  });

  it("the voice — 14+, with the consent, when typing; never for a child", () => {
    expect(canUseVoice(state(), false)).toBe(true);
    expect(canUseVoice(state({ voice_available: false }), false)).toBe(false);
    expect(canUseVoice(state(), true)).toBe(false);
    expect(canUseVoice(state({ options: [{ choice_id: "c", text_en: "x" }] }), false)).toBe(false);
  });

  it("the feed: my lines, the partner's, the coach, system notes; no duplicates, in order", () => {
    expect(lineOf(ev(1, "turn", "A"), "A")).toBe("me");
    expect(lineOf(ev(1, "turn", "B"), "A")).toBe("partner");
    expect(lineOf(ev(1, "coach", null), "A")).toBe("coach");
    expect(lineOf(ev(1, "offline", "B"), "A")).toBe("system");
    const a = mergeEvents([ev(1), ev(2)], [ev(2), ev(4), ev(3)]);
    expect(a.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const prev = [ev(1)];
    expect(mergeEvents(prev, [])).toBe(prev);
    expect(mergeEvents([], Array.from({ length: 250 }, (_, i) => ev(i + 1))).length).toBe(200);
  });

  it("statuses, the partner's network, the lobby", () => {
    expect(isTerminal("finished")).toBe(true);
    expect(isTerminal("paused")).toBe(false);
    expect(isLive("paused")).toBe(true);
    expect(isLive("invited")).toBe(false);
    expect(partnerNetwork(state({ participants: [{ role: "A", me: true, network: "online" }, { role: "B", me: false, network: "offline" }] }))).toBe("offline");
    expect(partnerNetwork(state({ participants: [{ role: "A", me: true, network: "online" }, { role: null, me: false, network: "offline" }] }))).toBeNull();
    expect(lobbyPhase({ status: "invited", side: "invitee", can_accept: true, can_join: false })).toBe("incoming");
    expect(lobbyPhase({ status: "invited", side: "inviter", can_accept: false, can_join: false })).toBe("outgoing");
    expect(lobbyPhase({ status: "waiting", side: "inviter", can_accept: false, can_join: true })).toBe("enter");
    expect(lobbyPhase({ status: "in_progress", side: "inviter", can_accept: false, can_join: true })).toBe("room");
    expect(lobbyPhase({ status: "stopped", side: "invitee", can_accept: false, can_join: false })).toBe("ended");
  });

  it("the lobby by can_join (review F7-1): a later start — «scheduled», away more than 3 minutes — «away», never the room", () => {
    // accepted, the start is later than 5 minutes from now: the time and «Отменить», no entry
    expect(lobbyPhase({ status: "waiting", side: "inviter", can_accept: false, can_join: false })).toBe("scheduled");
    expect(lobbyPhase({ status: "waiting", side: "invitee", can_accept: false, can_join: false })).toBe("scheduled");
    // the lesson goes on without me (abandoned): the lobby says so — never a room that cannot be joined
    expect(lobbyPhase({ status: "in_progress", side: "inviter", can_accept: false, can_join: false })).toBe("away");
    expect(lobbyPhase({ status: "paused", side: "invitee", can_accept: false, can_join: false })).toBe("away");
    expect(lobbyPhase({ status: "paused", side: "invitee", can_accept: false, can_join: true })).toBe("room");
    // an incoming invitation past respond_until cannot be accepted any more
    expect(lobbyPhase({ status: "invited", side: "invitee", can_accept: false, can_join: false })).toBe("ended");
    for (const status of ["finished", "abandoned", "stopped", "declined", "expired", "cancelled"] as const) {
      expect(lobbyPhase({ status, side: "inviter", can_accept: false, can_join: false })).toBe("ended");
    }
  });

  it("why the room is over for me: 409 ROOM_NOT_ACTIVE {abandoned | waiting + start_at} and 404", () => {
    const away = new ApiError(409, "ROOM_NOT_ACTIVE", "x", { status: "abandoned" });
    const early = new ApiError(409, "ROOM_NOT_ACTIVE", "x", { status: "waiting", start_at: "2026-11-22T10:00:00Z" });
    expect(roomGone(away)).toBe(true);
    expect(roomGone(new ApiError(404, "ROOM_NOT_FOUND", "x"))).toBe(true);
    expect(roomGone(new ApiError(404, "NOT_FOUND", "x"))).toBe(true);
    expect(roomGone(new ApiError(409, "NOT_YOUR_TURN", "x"))).toBe(false);
    expect(roomGone(new ApiError(503, "UPSTREAM_UNAVAILABLE", "x"))).toBe(false);
    expect(roomGone(new ApiError(0, "NETWORK", "x"))).toBe(false);
    expect(roomGone(new Error("x"))).toBe(false);
    expect(closedWhy(away)).toEqual({ kind: "away" });
    expect(closedWhy(early)).toEqual({ kind: "early", startAt: "2026-11-22T10:00:00Z" });
    expect(closedWhy(new ApiError(409, "ROOM_NOT_ACTIVE", "x", { status: "waiting" }))).toEqual({ kind: "closed" });
    expect(closedWhy(new ApiError(409, "ROOM_NOT_ACTIVE", "x", { status: "finished" }))).toEqual({ kind: "closed" });
    expect(closedWhy(new ApiError(404, "ROOM_NOT_FOUND", "x"))).toEqual({ kind: "closed" });
  });

  it("the mark of a turn (review F7-5): the last line of the coach or a speaker; presence does not move it", () => {
    expect(turnMark([])).toBe(0);
    expect(turnMark([ev(1, "roles", null), ev(2, "coach", null)])).toBe(2);
    expect(turnMark([ev(1, "coach", null), ev(2, "turn", "A"), ev(3, "offline", "B"), ev(4, "online", "B"), ev(5, "joined", "B")])).toBe(2);
    expect(turnMark([ev(1, "coach", null), ev(2, "turn", "A"), ev(3, "turn", "B"), ev(4, "coach", null)])).toBe(4);
    expect(turnMark([ev(1, "coach", null), ev(2, "mode_changed", null)])).toBe(2);
  });

  it("the start: now, or a time within 7 days", () => {
    const now = Date.parse("2026-11-21T10:00:00Z");
    expect(startValue("now", "", now)).toBe("now");
    expect(startValue("later", "2026-11-22T10:00:00Z", now)).toBe("2026-11-22T10:00:00.000Z");
    expect(startValue("later", "2026-11-21T09:00:00Z", now)).toBeNull();
    expect(startValue("later", "2026-11-29T10:00:00Z", now)).toBeNull();
    expect(startValue("later", "", now)).toBeNull();
  });
});

describe("pair room: the long-poll link", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A scripted server: each poll waits for the test to answer it. */
  function server() {
    const polls: Array<{ after: number; signal: AbortSignal; resolve: (s: PairRoomState) => void; reject: (e: unknown) => void }> = [];
    const states: PairRoomState[] = [];
    const links: boolean[] = [];
    const ends: Array<PairRoomState | null> = [];
    let beats = 0;
    const link = new RoomLink({
      poll: (after, signal) =>
        new Promise<PairRoomState>((resolve, reject) => {
          polls.push({ after, signal, resolve, reject });
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      heartbeat: async () => {
        beats += 1;
      },
      onState: (s) => states.push(s),
      onLink: (ok) => links.push(ok),
      onEnd: (s) => ends.push(s),
    });
    return { link, polls, states, links, ends, beats: () => beats };
  }
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it("one poll at a time; the next starts right after the answer with after_seq = the last seq", async () => {
    const s = server();
    s.link.start(0);
    expect(s.polls).toHaveLength(1);
    expect(s.polls[0]!.after).toBe(0);
    s.polls[0]!.resolve(state({ seq: 3, events: [ev(1), ev(2), ev(3)] }));
    await flush();
    expect(s.polls).toHaveLength(2);
    expect(s.polls[1]!.after).toBe(3);
    // an empty answer (25 s passed) — the same after_seq
    s.polls[1]!.resolve(state({ seq: 3 }));
    await flush();
    expect(s.polls[2]!.after).toBe(3);
    expect(s.states.map((x) => x.seq)).toEqual([3, 3]);
    s.link.stop();
  });

  it("leaving the screen aborts the poll in flight and stops the heartbeat", async () => {
    const s = server();
    s.link.start(0);
    const inFlight = s.polls[0]!;
    s.link.stop();
    expect(inFlight.signal.aborted).toBe(true);
    await flush();
    expect(s.polls).toHaveLength(1);
    const beats = s.beats();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(s.beats()).toBe(beats);
    expect(s.links).toEqual([]);
    expect(s.link.running).toBe(false);
  });

  it("the heartbeat every 10 s while the room is on screen", async () => {
    const s = server();
    s.link.start(0);
    expect(s.beats()).toBe(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(s.beats()).toBe(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(s.beats()).toBe(3);
    s.link.stop();
  });

  it("a lost poll: «переподключаемся» and a retry after 1 s, 2 s…; the answer brings the link back", async () => {
    const s = server();
    s.link.start(5);
    s.polls[0]!.reject(new ApiError(0, "NETWORK", "network"));
    await flush();
    expect(s.links).toEqual([false]);
    expect(s.polls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(s.polls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.polls).toHaveLength(2);
    expect(s.polls[1]!.after).toBe(5);
    s.polls[1]!.reject(new ApiError(503, "UPSTREAM_UNAVAILABLE", "x"));
    await flush();
    await vi.advanceTimersByTimeAsync(1999);
    expect(s.polls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.polls).toHaveLength(3);
    s.polls[2]!.resolve(state({ seq: 6, events: [ev(6)] }));
    await flush();
    expect(s.links).toEqual([false, false, true]);
    // stop during a retry pause: no poll after it
    s.polls[3]!.reject(new ApiError(0, "NETWORK", "network"));
    await flush();
    s.link.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.polls).toHaveLength(4);
  });

  it("429 waits Retry-After", async () => {
    const s = server();
    s.link.start(0);
    s.polls[0]!.reject(new ApiError(429, "RATE_LIMITED", "x", { retry_after: 5 }));
    await flush();
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.polls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.polls).toHaveLength(2);
    s.link.stop();
  });

  it("the end: a terminal status stops the link once; a gone room (404) too", async () => {
    const s = server();
    s.link.start(0);
    s.polls[0]!.resolve(state({ seq: 9, status: "finished" }));
    await flush();
    expect(s.ends.map((x) => x?.status)).toEqual(["finished"]);
    expect(s.link.running).toBe(false);
    expect(s.polls).toHaveLength(1);

    const g = server();
    g.link.start(0);
    g.polls[0]!.reject(new ApiError(404, "ROOM_NOT_FOUND", "x"));
    await flush();
    expect(g.ends).toEqual([null]);
    expect(g.link.running).toBe(false);
  });

  it("a turn's answer is shown at once and moves after_seq; an older state is ignored", async () => {
    const s = server();
    s.link.start(2);
    s.link.push(state({ seq: 4, events: [ev(3), ev(4)] }));
    expect(s.link.lastSeq).toBe(4);
    s.link.push(state({ seq: 3 }));
    expect(s.states.map((x) => x.seq)).toEqual([4]);
    // the poll in flight answers with the old seq — not shown, the next poll asks after 4
    s.polls[0]!.resolve(state({ seq: 2 }));
    await flush();
    expect(s.states.map((x) => x.seq)).toEqual([4]);
    expect(s.polls[1]!.after).toBe(4);
    s.link.stop();
  });

  it("heartbeat 409 ROOM_NOT_ACTIVE / 404 ends the link (review F7-2): no more polls or beats; other errors — only «переподключаемся»", async () => {
    const run = (fail: () => unknown) => {
      const polls: AbortSignal[] = [];
      const ends: Array<[PairRoomState | null, unknown]> = [];
      const links: boolean[] = [];
      let beats = 0;
      const link = new RoomLink({
        poll: (_after, signal) =>
          new Promise<PairRoomState>((_, reject) => {
            polls.push(signal);
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
        heartbeat: async () => {
          beats += 1;
          throw fail();
        },
        onState: () => undefined,
        onLink: (ok) => links.push(ok),
        onEnd: (s, e) => ends.push([s, e]),
      });
      return { link, polls, ends, links, beats: () => beats };
    };
    const away = new ApiError(409, "ROOM_NOT_ACTIVE", "x", { status: "abandoned" });
    const a = run(() => away);
    a.link.start(7);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await flush();
    expect(a.ends).toEqual([[null, away]]);
    expect(a.link.running).toBe(false);
    expect(a.polls[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(a.beats()).toBe(1);
    expect(a.polls).toHaveLength(1);

    const g = run(() => new ApiError(404, "ROOM_NOT_FOUND", "x"));
    g.link.start(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await flush();
    expect(g.ends.map(([s]) => s)).toEqual([null]);
    expect(g.link.running).toBe(false);

    // a lost heartbeat is not the end: the link says «переподключаемся» and keeps beating
    const n = run(() => new ApiError(0, "NETWORK", "x"));
    n.link.start(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    await flush();
    expect(n.ends).toEqual([]);
    expect(n.links).toContain(false);
    expect(n.beats()).toBe(2);
    expect(n.link.running).toBe(true);
    n.link.stop();
  });

  it("a poll answered 409 ROOM_NOT_ACTIVE ends the link at once, without retries", async () => {
    const s = server();
    s.link.start(4);
    s.polls[0]!.reject(new ApiError(409, "ROOM_NOT_ACTIVE", "x", { status: "abandoned" }));
    await flush();
    expect(s.ends).toEqual([null]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.polls).toHaveLength(1);
    expect(s.beats()).toBe(0);
  });

  it("start twice does not open a second loop", () => {
    const s = server();
    s.link.start(0);
    s.link.start(0);
    expect(s.polls).toHaveLength(1);
    s.link.stop();
    s.link.stop();
  });
});

describe("links of sprint 7", () => {
  it("duel_<uuid> and room_<uuid> open their screens after onboarding; route_friends | leagues | duels | referrals", async () => {
    const { parseStartParam, needsOnboarding } = await import("../src/tg/deeplink");
    const { routeTarget } = await import("../src/state/nav");
    const id = "D0000000-AAAA-4BBB-8CCC-000000000003";
    expect(parseStartParam(`duel_${id}`)).toEqual({ kind: "duel", id: id.toLowerCase() });
    expect(parseStartParam(`room_${id}`)).toEqual({ kind: "room", id: id.toLowerCase() });
    expect(parseStartParam("duel_not-a-uuid")).toBeNull();
    expect(needsOnboarding({ kind: "duel", id })).toBe(true);
    const home = { tab: "home" as const, stack: [] };
    expect(routeTarget("friends", home).stack).toEqual([{ name: "friends" }]);
    expect(routeTarget("leagues", home).stack).toEqual([{ name: "leagues" }]);
    expect(routeTarget("duels", home).stack).toEqual([{ name: "duels" }]);
    expect(routeTarget("referrals", home).stack).toEqual([{ name: "referrals" }]);
  });
});
