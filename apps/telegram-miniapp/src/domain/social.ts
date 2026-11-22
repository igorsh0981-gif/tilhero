import type {
  CommunityProfile,
  DuelView,
  Family,
  GeneralLeagueUnavailableReason,
  LeaguesView,
  MemberCard,
  MemberHero,
  MemberId,
  ReferralRejectCode,
  ReferralStatus,
  ReferralView,
  StandingRow,
  Standings,
} from "@tilhero/contracts/bff";
import { ApiError, errorText } from "../api/errors";
import type { MessageKey, Vars } from "../i18n";

/**
 * Sprint 7 — the social part of the learner (APP-SOC-01…10, APP-REF-01…04): pure logic of the screens. Another learner
 * is only a member_id with a nickname (or «Друг» / «Участник семьи»), a hero, XP, a place and allowed badges — never a
 * name, Telegram or an age (APP-SOC-09). Children 6–13 see only their family: no friends, no general league, no places
 * «последний» — «вместе набрали». Every number comes from the server; the client only shows it.
 */

type T = (key: MessageKey, vars?: Vars) => string;

/* ---------------------------------------------------------------- the nickname and the friend code */

export const NICK_MIN = 3;
export const NICK_MAX = 20;
/** letters RU/UZ/EN, digits, «_» (the server also filters forbidden words and look-alike letters) */
const NICK_RE = /^[\p{L}\p{N}_]+$/u;

export type NicknameProblem = "length" | "chars";

/** What is wrong with a nickname before it is sent (the server answers the same reasons, plus `forbidden`). */
export function nicknameProblem(raw: string): NicknameProblem | null {
  const v = raw.trim();
  const n = [...v].length;
  if (n < NICK_MIN || n > NICK_MAX) return "length";
  return NICK_RE.test(v) ? null : "chars";
}

/** TH-XXXX-XXXX: the alphabet without 0 / O / 1 / I; spaces and dashes are optional when typed. */
const CODE_RE = /^TH([A-HJ-NP-Z2-9]{4})([A-HJ-NP-Z2-9]{4})$/;

export type SearchQuery = { kind: "code"; q: string } | { kind: "nickname"; q: string };

/**
 * The query of «Найти»: an exact friend code (any case, with or without dashes) → TH-XXXX-XXXX; else an exact nickname
 * 3..20; anything else → null (the button stays off — nothing is sent).
 */
export function searchQuery(raw: string): SearchQuery | null {
  const v = raw.trim();
  const compact = v.replace(/[\s-]/g, "").toUpperCase();
  const m = CODE_RE.exec(compact);
  if (m) return { kind: "code", q: `TH-${m[1]}-${m[2]}` };
  if (/^th[\s-]/i.test(v)) return null;
  return nicknameProblem(v) ? null : { kind: "nickname", q: v };
}

/** The name of another learner on screen: the nickname, else «Друг» (friends) / «Участник семьи» (family). */
export function memberLabel(nickname: string | null | undefined, t: T, kind: "friend" | "family" = "friend"): string {
  const n = nickname?.trim();
  return n ? n : t(kind === "family" ? "soc.familyMember" : "soc.friend");
}

/** What a found card offers: add, accept / decline the request to me, take mine back, or nothing. */
export type CardAction = "add" | "respond" | "cancel" | "friend" | "self";

export function cardAction(card: Pick<MemberCard, "relation">): CardAction {
  switch (card.relation) {
    case "none":
      return "add";
    case "request_in":
      return "respond";
    case "request_out":
      return "cancel";
    case "friend":
      return "friend";
    default:
      return "self";
  }
}

/** Friends and requests on this account: available, or why not (children — only the family). */
export type FriendsGate = "ok" | "kids" | "guardian_consent" | "consent";

export function friendsGate(p: Pick<CommunityProfile, "friends_available" | "friends_unavailable_reason"> | null, kid: boolean): FriendsGate {
  if (kid) return "kids";
  if (!p || p.friends_available) return "ok";
  return p.friends_unavailable_reason ?? "consent";
}

/* ---------------------------------------------------------------- members to choose (a duel, a pair lesson) */

export interface PickMember {
  member_id: MemberId;
  label: string;
  kind: "friend" | "family";
  hero: MemberHero | null;
}

/**
 * Members of my family to challenge or invite: by member_id only; the label is the nickname known from the family league
 * (a hidden game profile is not there), else «Участник семьи» — numbered when there are several. Names of the family
 * (display_name) are never used here: in social screens nobody is shown by name.
 */
export function familyPick(family: Family | null | undefined, standings: Standings | null | undefined, t: T): PickMember[] {
  if (!family) return [];
  const rows = new Map<string, StandingRow>();
  for (const r of [...(standings?.rows ?? []), ...(standings?.me_row ? [standings.me_row] : [])]) rows.set(r.member_id, r);
  const others = family.members.filter((m) => !m.is_me && typeof m.member_id === "string" && m.member_id);
  const unnamed = others.filter((m) => !rows.get(m.member_id)?.nickname).length;
  let n = 0;
  return others.map((m) => {
    const row = rows.get(m.member_id);
    const nick = row?.nickname?.trim();
    let label: string;
    if (nick) label = nick;
    else {
      n += 1;
      label = unnamed > 1 ? t("soc.familyMemberN", { n }) : t("soc.familyMember");
    }
    return { member_id: m.member_id, label, kind: "family" as const, hero: row?.hero ?? null };
  });
}

/* ---------------------------------------------------------------- leagues (APP-SOC-08/09) */

export type LeagueTab = "friends" | "family" | "general";

/** The tabs a learner has: a child — only the family; the rest — friends, the family (if any) and the general league. */
export function leagueTabs(v: Pick<LeaguesView, "friends" | "family">, kid: boolean): LeagueTab[] {
  if (kid) return ["family"];
  const out: LeagueTab[] = [];
  if (v.friends) out.push("friends");
  if (v.family) out.push("family");
  out.push("general");
  return out;
}

/** Rows to show: the top rows and my row under them when it is not among them. */
export function standingRows(s: Standings): StandingRow[] {
  const rows = [...s.rows].sort((a, b) => a.place - b.place);
  if (s.me_row && !rows.some((r) => r.me)) rows.push(s.me_row);
  return rows;
}

/** Badges of the game catalogue with a short name in the dictionaries (lg.badge.<code>). */
export const BADGE_CODES = ["first_lesson", "streak_7", "streak_30", "skills_10", "skill_retained", "reviews_100", "readings_10", "first_freeze", "together_1"] as const;

export function knownBadge(code: string): boolean {
  return (BADGE_CODES as readonly string[]).includes(code);
}

/** The badge codes of every table of the leagues (to know whether the catalogue is needed for their names). */
export function leagueBadgeCodes(v: Pick<LeaguesView, "friends" | "family" | "general">): string[] {
  const all = [v.friends, v.family, v.general.group].flatMap((s) => (s ? [...s.rows, ...(s.me_row ? [s.me_row] : [])] : []));
  return [...new Set(all.flatMap((r) => r.badges))];
}

/**
 * The names of a row's badges (never codes): the short name of the dictionaries for the 9 known codes, the title from
 * the game catalogue (GET /v1/game/badges — steps added by the rules, e.g. streak_100, skills_50) for the others; a
 * code nobody names reads «значок» — once, not «значок, значок, значок».
 */
export function badgeNames(codes: readonly string[], t: T, titles?: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  let other = false;
  for (const c of codes) {
    const title = knownBadge(c) ? t(`lg.badge.${c}` as MessageKey) : titles?.get(c);
    if (title && !out.includes(title)) out.push(title);
    else if (!title) other = true;
  }
  if (other) out.push(t("lg.badge.other"));
  return out;
}

/** Children never see places (no «последний»): the list is in the server order, with «вместе набрали». */
export function showPlaces(kid: boolean): boolean {
  return !kid;
}

export function generalReasonKey(r: GeneralLeagueUnavailableReason): MessageKey {
  return `lg.why.${r}` as MessageKey;
}

/** The prize of a place 1..3 (tils) from the rules of the server; null — no prize. */
export function prizeOf(prizes: readonly number[], place: number): number | null {
  const p = place >= 1 ? prizes[place - 1] : undefined;
  return typeof p === "number" && p > 0 ? p : null;
}

/* ---------------------------------------------------------------- duels (APP-SOC-07) */

export type DuelPhase = "incoming" | "awaiting" | "play" | "waiting" | "result" | "declined" | "expired" | "cancelled";

/** Where a duel is from my side: answer a challenge, wait for the answer, play, wait for the opponent, the result. */
export function duelPhase(d: Pick<DuelView, "status" | "can_accept" | "can_play" | "my_played" | "result">): DuelPhase {
  switch (d.status) {
    case "challenged":
      return d.can_accept ? "incoming" : "awaiting";
    case "accepted":
      return d.can_play ? "play" : "waiting";
    case "finished":
      return "result";
    case "declined":
      return "declined";
    case "expired":
      return "expired";
    default:
      return "cancelled";
  }
}

/** «8 из 10» — or «—» when not played. */
export function scoreText(s: { correct: number; total: number } | null | undefined, t: T): string {
  return s ? t("du.score", { n: s.correct, m: s.total }) : t("du.notPlayed");
}

/* ---------------------------------------------------------------- referrals (APP-REF-01…04) */

export interface ReferralStep {
  key: "diagnostic" | "lessons" | "days";
  value: number;
  required: number;
  done: boolean;
}

/** The conditions of a referral in order: the placement test (when the campaign needs it), lessons, different days. */
export function referralSteps(v: Pick<ReferralView, "progress">): ReferralStep[] {
  const p = v.progress;
  const out: ReferralStep[] = [];
  if (p.diagnostic_required) out.push({ key: "diagnostic", value: p.diagnostic ? 1 : 0, required: 1, done: p.diagnostic });
  const lessons = Math.max(0, Math.min(p.lessons, p.lessons_required));
  const days = Math.max(0, Math.min(p.days, p.days_required));
  out.push({ key: "lessons", value: lessons, required: p.lessons_required, done: lessons >= p.lessons_required });
  out.push({ key: "days", value: days, required: p.days_required, done: days >= p.days_required });
  return out;
}

/** 0..100: the share of the conditions met (each condition weighs the same; the parts of a condition count). */
export function referralPct(v: Pick<ReferralView, "progress" | "status">): number {
  if (v.status === "qualified" || v.status === "rewarded" || v.status === "review") return 100;
  const steps = referralSteps(v);
  if (!steps.length) return 0;
  const sum = steps.reduce((a, s) => a + (s.required > 0 ? Math.min(1, s.value / s.required) : 1), 0);
  return Math.floor((sum / steps.length) * 100);
}

export function referralTone(s: ReferralStatus): "ok" | "warn" | "mute" | undefined {
  if (s === "rewarded" || s === "qualified") return "ok";
  if (s === "review") return "warn";
  if (s === "rejected" || s === "expired" || s === "capped") return "mute";
  return undefined;
}

/** An invitation of the former programme that expired: «Приглашение по прежней программе», never a refusal reason. */
export function legacyExpired(v: Pick<ReferralView, "status" | "legacy">): boolean {
  return v.legacy && v.status === "expired";
}

/** The public reason of a refusal — never the rules of the anti-fraud check. capped and expired have their own codes;
 *  an expired invitation of the former programme has none (reject_code null). */
export function rejectReason(v: Pick<ReferralView, "status" | "reject_code"> & Partial<Pick<ReferralView, "legacy">>): ReferralRejectCode | null {
  if (legacyExpired({ status: v.status, legacy: !!v.legacy })) return null;
  if (v.reject_code) return v.reject_code;
  if (v.status === "expired") return "window_expired";
  if (v.status === "capped") return "monthly_cap";
  if (v.status === "rejected") return "review_rejected";
  return null;
}

/* ---------------------------------------------------------------- errors */

/** The social or game domain is down (503 UPSTREAM_UNAVAILABLE {service}, GAME_UNAVAILABLE, 5xx): the block says so,
 *  learning goes on. */
export function socialDown(e: unknown): boolean {
  return e instanceof ApiError && (e.code === "UPSTREAM_UNAVAILABLE" || e.code === "GAME_UNAVAILABLE" || e.status >= 500);
}

const untilOf = (e: ApiError): string | null => (typeof e.details.until === "string" ? e.details.until : null);

/**
 * The text of a social error with its details: SOCIAL_RESTRICTED {until | null}, NICKNAME_COOLDOWN / FRIEND_CODE_LIMIT
 * {until}, NICKNAME_INVALID {reason}, FRIENDS_NOT_ALLOWED {reason}, VOICE_CONSENT_REQUIRED {who}, AUDIO_INVALID {reason}.
 * Who blocked whom is never told (BLOCKED reads the same both ways).
 */
export function socialErrorText(e: unknown, t: T, fmt: { dateTime(iso: string): string; mmss(s: number): string }): string {
  if (!(e instanceof ApiError)) return errorText(e, t, fmt.mmss);
  const until = untilOf(e);
  switch (e.code) {
    case "SOCIAL_RESTRICTED":
      return until ? t("err.SOCIAL_RESTRICTED.until", { date: fmt.dateTime(until) }) : t("err.SOCIAL_RESTRICTED");
    case "NICKNAME_COOLDOWN":
      return until ? t("err.NICKNAME_COOLDOWN.until", { date: fmt.dateTime(until) }) : t("err.NICKNAME_COOLDOWN");
    case "FRIEND_CODE_LIMIT":
      return until ? t("err.FRIEND_CODE_LIMIT.until", { date: fmt.dateTime(until) }) : t("err.FRIEND_CODE_LIMIT");
    case "NICKNAME_INVALID": {
      const r = e.details.reason;
      return r === "length" || r === "chars" || r === "forbidden" ? t(`nick.err.${r}` as MessageKey) : t("err.NICKNAME_INVALID");
    }
    case "FRIENDS_NOT_ALLOWED":
      return e.details.reason === "kids" ? t("err.FRIENDS_NOT_ALLOWED.kids") : t("err.FRIENDS_NOT_ALLOWED");
    case "VOICE_CONSENT_REQUIRED":
      return e.details.who === "guardian" ? t("pair.room.voiceGuardian") : t("pair.room.voiceConsent");
    case "SPEECH_UNAVAILABLE":
      return t("pair.room.voiceOff");
    case "APPEAL_EXISTS":
      return t("san.appealExists");
    case "AUDIO_INVALID": {
      const r = e.details.reason;
      return t(r === "too_short" ? "pn.tooShort" : r === "too_long" || r === "too_large" ? "pn.tooLong" : "pn.badAudio");
    }
    default:
      return errorText(e, t, fmt.mmss);
  }
}
