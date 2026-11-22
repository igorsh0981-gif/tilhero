/**
 * «Сообщество» (sprint 7, ADM-SOC-01/02/03, ADM-REF-01/02, ADM-GAME-02, AT-79, AT-80): pure helpers of the five
 * sections — «Друзья и жалобы», «Модерация», «Реферальные кампании», «Лиги и дуэли», «Парные комнаты».
 *
 * - routes and the lists of codes with their tones;
 * - moderation: the decision of a case (dismiss / warning / ban 1–30 days or for ever / nickname reset, basis 10..500),
 *   when it needs step-up (a ban longer than 7 days or for ever), the revocation and the appeal decision;
 * - referral campaigns: the payload form (numbers as typed text), its parse with the path of each problem, the client
 *   mirror of the validator (admin.ts ReferralCampaignPayload — the server stays the authority), the activation gate;
 * - the review queue: which decision a referral still allows (one re-decision of a rejection), the bodies of approve
 *   and reject;
 * - leagues and duels: the week of Tashkent (Monday), the preview of a re-evaluation of a group (places and prizes after
 *   excluding members), the bodies of re-evaluation and release, the re-evaluation of a duel;
 * - pair rooms: which statuses can still be stopped, durations, the list filters.
 * Every reason / basis / note of a command: 10..500 characters (admin.ts «Социальное»).
 */
import type {
  AdminCaseRow,
  AdminDuel,
  AdminLeagueGroup,
  AdminLeagueGroupRow,
  AdminLeagueMember,
  AdminReferral,
  AdminSanction,
  CaseResolveRequest,
  CaseStatus,
  DuelReevaluateRequest,
  DuelResult,
  LeagueGroupStatus,
  LeagueReevaluateRequest,
  ModerationAction,
  ReferralCampaignPayload,
  ReferralCampaignStatus,
  ReferralCampaignVersion,
  ReferralRejectRequest,
  ReferralRiskFlag,
  SanctionAppealDecision,
} from "@tilhero/contracts/admin";
import type {
  ComplaintReason,
  ComplaintSubjectKind,
  DuelStatus,
  FriendRequestStatus,
  LeagueLevelBand,
  PairEndReason,
  PairRoomEventKind,
  PairRoomMode,
  PairRoomStatus,
  ReferralRejectCode,
  ReferralRewardOutcome,
  ReferralStatus,
  SanctionAppealStatus,
  SanctionKind,
} from "@tilhero/contracts/bff";
import type { Tone } from "../../ui/kit";
import { normPath, type Issue } from "../game/model";

export type { Issue };

/* ---------------------------------------------------------------- codes */

export const CASE_STATUSES: readonly CaseStatus[] = ["open", "resolved", "dismissed"];
export const MOD_ACTIONS: readonly ModerationAction[] = ["dismiss", "warning", "social_ban", "nickname_reset"];
export const SANCTION_KINDS: readonly SanctionKind[] = ["warning", "social_ban", "nickname_reset"];
export const APPEAL_STATUSES: readonly SanctionAppealStatus[] = ["open", "upheld", "overturned"];
export const SUBJECT_KINDS: readonly ComplaintSubjectKind[] = ["user", "nickname", "friend_request", "invite", "duel", "pair_room"];
export const COMPLAINT_REASONS: readonly ComplaintReason[] = ["spam", "abuse", "inappropriate_nickname", "cheating", "other"];
export const FRIEND_REQUEST_STATUSES: readonly FriendRequestStatus[] = ["pending", "accepted", "declined", "cancelled", "expired"];
export const CAMPAIGN_STATUSES: readonly ReferralCampaignStatus[] = ["draft", "active", "archived"];
export const REFERRAL_STATUSES: readonly ReferralStatus[] = ["invited", "diagnostic_done", "learning", "review", "qualified", "rewarded", "rejected", "expired", "capped"];
export const REJECT_CODES: readonly ReferralRejectCode[] = ["not_new_user", "family_member", "window_expired", "review_rejected", "monthly_cap"];
/** an operator rejects only with these: window_expired and monthly_cap are set by the system (admin.ts ReferralRejectRequest) */
export const MANUAL_REJECT_CODES: readonly ReferralRejectRequest["reject_code"][] = ["review_rejected", "not_new_user", "family_member"];
export const RISK_FLAGS: readonly ReferralRiskFlag[] = ["velocity", "short_lessons", "activity_before_accept", "family_member"];
export const LEVEL_BANDS: readonly LeagueLevelBand[] = ["A0-A1", "A2", "B1+"];
export const GROUP_STATUSES: readonly LeagueGroupStatus[] = ["open", "closed", "held"];
export const DUEL_STATUSES: readonly DuelStatus[] = ["challenged", "accepted", "finished", "declined", "expired", "cancelled"];
export const DUEL_RESULTS: readonly DuelResult[] = ["challenger", "opponent", "draw", "none"];
/** a re-evaluation names a winner or a draw — never «none» (admin.ts DuelReevaluateRequest) */
export const REEVAL_RESULTS: readonly DuelReevaluateRequest["result"][] = ["challenger", "opponent", "draw"];
export const ROOM_STATUSES: readonly PairRoomStatus[] = ["invited", "waiting", "in_progress", "paused", "finished", "abandoned", "stopped", "declined", "expired", "cancelled"];
/** a room that has not ended yet: the only ones an administrator can stop (otherwise 409 ROOM_NOT_ACTIVE) */
export const ROOM_ACTIVE: readonly PairRoomStatus[] = ["invited", "waiting", "in_progress", "paused"];
export const ROOM_MODES: readonly PairRoomMode[] = ["free", "choices"];
export const END_REASONS: readonly PairEndReason[] = ["completed", "participant_left", "inactivity", "stopped"];
export const ROOM_EVENT_KINDS: readonly PairRoomEventKind[] = ["joined", "left", "offline", "online", "paused", "resumed", "roles", "coach", "turn", "mode_changed", "finished", "stopped"];

export const MOD_TABS = ["cases", "sanctions", "appeals"] as const;
export type ModTab = (typeof MOD_TABS)[number];
export const REF_TABS = ["review", "campaigns", "stats"] as const;
export type RefTab = (typeof REF_TABS)[number];
export const LEAGUE_TABS = ["groups", "duels"] as const;
export type LeagueTab = (typeof LEAGUE_TABS)[number];

export const CASE_TONE: Record<CaseStatus, Tone> = { open: "warn", resolved: "good", dismissed: "neutral" };
export const APPEAL_TONE: Record<SanctionAppealStatus, Tone> = { open: "warn", upheld: "neutral", overturned: "good" };
export const CAMPAIGN_TONE: Record<ReferralCampaignStatus, Tone> = { draft: "info", active: "good", archived: "neutral" };
export const REFERRAL_TONE: Record<ReferralStatus, Tone> = {
  invited: "neutral", diagnostic_done: "info", learning: "info", review: "warn", qualified: "good", rewarded: "good", rejected: "bad", expired: "neutral", capped: "neutral",
};
/** the outcome of the reward (ack of gamification): null — no badge */
export const REWARD_OUTCOMES: readonly ReferralRewardOutcome[] = ["rewarded", "legacy", "inviter_capped"];
export const REWARD_OUTCOME_TONE: Record<ReferralRewardOutcome, Tone> = { rewarded: "good", legacy: "info", inviter_capped: "warn" };
export const REQUEST_TONE: Record<FriendRequestStatus, Tone> = { pending: "info", accepted: "good", declined: "neutral", cancelled: "neutral", expired: "neutral" };
export const GROUP_TONE: Record<LeagueGroupStatus, Tone> = { open: "info", closed: "good", held: "warn" };
export const DUEL_TONE: Record<DuelStatus, Tone> = { challenged: "info", accepted: "info", finished: "good", declined: "neutral", expired: "neutral", cancelled: "neutral" };
export const ROOM_TONE: Record<PairRoomStatus, Tone> = {
  invited: "info", waiting: "info", in_progress: "good", paused: "warn", finished: "neutral", abandoned: "neutral", stopped: "bad", declined: "neutral", expired: "neutral", cancelled: "neutral",
};

/** every reason, basis, note and comment of a command of the section (admin.ts: 10..500, audited) */
export const REASON_MIN = 10;
export const REASON_MAX = 500;
export const BAN_DAYS_MIN = 1;
export const BAN_DAYS_MAX = 30;
/** a social_ban longer than this (or for ever) needs a fresh TOTP (admin.ts, PLAN «Права») */
export const STEP_UP_DAYS = 7;
export const EXCLUDE_MAX = 30;
/** complaints on one target in 30 days from which the queue marks it */
export const HOT_COMPLAINTS = 3;
export const SOCIAL_TZ = "Asia/Tashkent";
const DAY = 86_400_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string | null | undefined): s is string => !!s && UUID_RE.test(s.trim());

/** A reason / basis / note: 10..500 characters after trimming → null, else the problem code. */
export function reasonProblem(s: string): "reason_short" | "reason_long" | null {
  const n = s.trim().length;
  return n < REASON_MIN ? "reason_short" : n > REASON_MAX ? "reason_long" : null;
}

/* ---------------------------------------------------------------- routes */

const uuidOrNull = (s: string | undefined) => (isUuid(s) ? s!.trim().toLowerCase() : null);

/** #/friends[/<user_id>] */
export const parseFriendsRoute = (id: string | null): string | null => uuidOrNull((id ?? "").split("/")[0]);

/** #/moderation[/cases[/<case_id>] | /sanctions | /appeals] */
export function parseModRoute(id: string | null): { tab: ModTab; id: string | null } {
  const [head, rest] = (id ?? "").split("/");
  const tab = (MOD_TABS as readonly string[]).includes(head ?? "") ? (head as ModTab) : "cases";
  return { tab, id: tab === "cases" ? uuidOrNull(rest) : null };
}

/** #/referrals[/review[/<referral_id>] | /campaigns[/<version>] | /stats] */
export function parseRefRoute(id: string | null): { tab: RefTab; id: string | null } {
  const [head, rest] = (id ?? "").split("/");
  const tab = (REF_TABS as readonly string[]).includes(head ?? "") ? (head as RefTab) : "review";
  if (tab === "review") return { tab, id: uuidOrNull(rest) };
  if (tab === "campaigns") return { tab, id: rest && /^\d{1,6}$/.test(rest) ? rest : null };
  return { tab, id: null };
}

/** #/leagues[/groups[/<group_id>] | /duels[/<duel_id>]] */
export function parseLeagueRoute(id: string | null): { tab: LeagueTab; id: string | null } {
  const [head, rest] = (id ?? "").split("/");
  const tab = (LEAGUE_TABS as readonly string[]).includes(head ?? "") ? (head as LeagueTab) : "groups";
  return { tab, id: uuidOrNull(rest) };
}

/** #/pair_rooms[/<room_id>] */
export const parseRoomRoute = (id: string | null): string | null => uuidOrNull((id ?? "").split("/")[0]);

/* ---------------------------------------------------------------- moderation: the decision of a case */

export interface ResolveForm {
  action: ModerationAction;
  /** social_ban: «days» — 1..30 days, «forever» — no end */
  term: "days" | "forever";
  days: string;
  basis: string;
}

export const emptyResolve = (): ResolveForm => ({ action: "warning", term: "days", days: "3", basis: "" });

/** The body of POST …/cases/{id}/resolve or the problems (paths days, basis). */
export function resolveBody(f: ResolveForm): { body: CaseResolveRequest | null; issues: Issue[] } {
  const issues: Issue[] = [];
  let days: number | null = null;
  if (f.action === "social_ban" && f.term === "days") {
    const s = f.days.trim();
    const n = /^\d+$/.test(s) ? Number(s) : Number.NaN;
    if (!s) issues.push({ path: "days", code: "required" });
    else if (!Number.isInteger(n) || n < BAN_DAYS_MIN || n > BAN_DAYS_MAX) issues.push({ path: "days", code: "days_range" });
    else days = n;
  }
  const b = reasonProblem(f.basis);
  if (b) issues.push({ path: "basis", code: b });
  if (issues.length) return { body: null, issues };
  return { body: { action: f.action, days, basis: f.basis.trim() }, issues };
}

/** step-up: a ban longer than 7 days or for ever (the server answers 403 STEP_UP_REQUIRED, the dialog asks for TOTP). */
export function resolveNeedsStepUp(f: Pick<ResolveForm, "action" | "term" | "days">): boolean {
  if (f.action !== "social_ban") return false;
  if (f.term === "forever") return true;
  const n = Number(f.days.trim());
  return Number.isFinite(n) && n > STEP_UP_DAYS;
}

/** the end of a ban of `days` days from now (preview; the server sets the real moment) */
export const banUntil = (days: number, now = Date.now()): string => new Date(now + days * DAY).toISOString();

/** Is the sanction still in force (not revoked, not expired)? `active` is the server's word; the end is checked too. */
export const sanctionInForce = (s: Pick<AdminSanction, "active" | "revoked_at" | "until" | "kind">, now = Date.now()): boolean =>
  s.active && !s.revoked_at && !(s.kind === "social_ban" && s.until != null && Date.parse(s.until) <= now);

/** the state of a sanction for its pill: in force · revoked · expired · done (a warning or a nickname reset) */
export function sanctionState(s: Pick<AdminSanction, "active" | "revoked_at" | "until" | "kind">, now = Date.now()): "active" | "revoked" | "expired" | "done" {
  if (s.revoked_at) return "revoked";
  if (sanctionInForce(s, now)) return "active";
  if (s.kind === "social_ban") return "expired";
  return "done";
}

export const canRevoke = (s: Pick<AdminSanction, "active" | "revoked_at" | "until" | "kind">, now = Date.now()) => sanctionInForce(s, now);

/** The body of POST …/appeals/{id}/decide or the problem of the note. */
export function appealBody(decision: SanctionAppealDecision["decision"] | null, note: string): { body: SanctionAppealDecision | null; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!decision) issues.push({ path: "decision", code: "required" });
  const p = reasonProblem(note);
  if (p) issues.push({ path: "note", code: p });
  return issues.length ? { body: null, issues } : { body: { decision: decision!, note: note.trim() }, issues };
}

/** the role of a learner in a case: who complained, who was complained about (both null — anonymised by the saga) */
export function caseRole(c: Pick<AdminCaseRow, "reporter_user_id" | "target_user_id">, userId: string): "reporter" | "target" | null {
  if (c.target_user_id === userId) return "target";
  if (c.reporter_user_id === userId) return "reporter";
  return null;
}

/** the subject of a complaint that has its own card in the admin: a duel (leagues) or a pair room */
export function subjectLink(kind: ComplaintSubjectKind, id: string | null): { page: "leagues" | "pair_rooms"; id: string } | null {
  if (!id || !isUuid(id)) return null;
  if (kind === "duel") return { page: "leagues", id: `duels/${id.toLowerCase()}` };
  if (kind === "pair_room") return { page: "pair_rooms", id: id.toLowerCase() };
  return null;
}

/**
 * The dictionary keys that may name the status of a complaint subject (F7-19), the best first: a request — `frs.*`,
 * a duel — `dst.*`, a room — `rst7.*`, an invite — a room invitation (`rst7.*`) or a friend request (`frs.*`). The
 * screen takes the first key the dictionary knows and shows the raw code only when none does.
 */
export function subjectStatusKeys(kind: ComplaintSubjectKind, status: string | null): string[] {
  if (!status) return [];
  const fam: Record<ComplaintSubjectKind, string[]> = { user: [], nickname: [], friend_request: ["frs"], invite: ["rst7", "frs"], duel: ["dst"], pair_room: ["rst7"] };
  return fam[kind].map((f) => `${f}.${status}`);
}

/**
 * F7-20: admin-bff masks the friend code for staff without moderation.manage («TH-••••-M3PX»): the screen shows it as
 * it came and says the whole code is seen by moderators only.
 */
export const codeMasked = (code: string | null | undefined): boolean => !!code && code.includes("•");

/* ---------------------------------------------------------------- referral campaigns */

type FormOf<T> = T extends boolean ? boolean : T extends number ? string : T extends object ? { -readonly [K in keyof T]: FormOf<T[K]> } : T;
/** ReferralCampaignPayload with every number as the typed text */
export type CampaignForm = FormOf<ReferralCampaignPayload>;

/** the limits of the validator (admin.ts ReferralCampaignPayload); min_days is 1..min_lessons */
export const CAMPAIGN_LIMITS: Readonly<Record<string, [number, number]>> = {
  min_lessons: [1, 10],
  min_days: [1, 10],
  window_days: [7, 90],
  "inviter_reward.freeze": [0, 5],
  "inviter_reward.til": [0, 1000],
  "invitee_reward.freeze": [0, 5],
  "invitee_reward.til": [0, 1000],
  monthly_cap: [1, 100],
  "review.velocity_per_day": [1, 50],
  "review.min_lesson_minutes": [1, 20],
};
export const CAMPAIGN_NUMBERS = Object.keys(CAMPAIGN_LIMITS);

export function campaignForm(p: ReferralCampaignPayload): CampaignForm {
  return {
    require_diagnostic: p.require_diagnostic,
    min_lessons: String(p.min_lessons),
    min_days: String(p.min_days),
    window_days: String(p.window_days),
    inviter_reward: { freeze: String(p.inviter_reward.freeze), til: String(p.inviter_reward.til) },
    invitee_reward: { freeze: String(p.invitee_reward.freeze), til: String(p.invitee_reward.til) },
    monthly_cap: String(p.monthly_cap),
    review: { velocity_per_day: String(p.review.velocity_per_day), min_lesson_minutes: String(p.review.min_lesson_minutes) },
  };
}

export const campaignValue = (f: CampaignForm, path: string): string => {
  const [a, b] = path.split(".");
  const v = b ? (f as unknown as Record<string, Record<string, string>>)[a!]![b] : (f as unknown as Record<string, string>)[a!];
  return v ?? "";
};

export function setCampaignValue(f: CampaignForm, path: string, v: string): CampaignForm {
  const [a, b] = path.split(".");
  if (!b) return { ...f, [a!]: v } as CampaignForm;
  return { ...f, [a!]: { ...(f as unknown as Record<string, Record<string, string>>)[a!], [b]: v } } as CampaignForm;
}

/**
 * The typed form back to the payload and the client mirror of the validator: whole numbers in their ranges,
 * min_days ≤ min_lessons. Warnings (not blocking): the inviter gets no reward at all; the window is shorter than the
 * number of distinct days a learner needs.
 */
export function checkCampaign(f: CampaignForm): { payload: ReferralCampaignPayload; errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const num = (path: string): number => {
    const s = campaignValue(f, path).trim();
    if (!s) {
      errors.push({ path, code: "required" });
      return Number.NaN;
    }
    if (!/^\d+$/.test(s)) {
      errors.push({ path, code: "not_integer" });
      return Number.NaN;
    }
    const n = Number(s);
    const [min, max] = CAMPAIGN_LIMITS[path]!;
    if (n < min || n > max) errors.push({ path, code: "range" });
    return n;
  };
  const v = Object.fromEntries(CAMPAIGN_NUMBERS.map((p) => [p, num(p)])) as Record<string, number>;
  // min_days ≤ min_lessons — only between two valid numbers (an invalid one already has its own problem)
  const pairOk = !errors.some((x) => x.path === "min_days" || x.path === "min_lessons");
  if (pairOk && v.min_days! > v.min_lessons!) errors.push({ path: "min_days", code: "days_gt_lessons" });
  if (v["inviter_reward.freeze"] === 0 && v["inviter_reward.til"] === 0) warnings.push({ path: "inviter_reward", code: "no_reward" });
  if (Number.isFinite(v.window_days) && Number.isFinite(v.min_days) && v.window_days! < v.min_days!) warnings.push({ path: "window_days", code: "window_short" });
  const payload: ReferralCampaignPayload = {
    require_diagnostic: f.require_diagnostic,
    min_lessons: v.min_lessons!,
    min_days: v.min_days!,
    window_days: v.window_days!,
    inviter_reward: { freeze: v["inviter_reward.freeze"]!, til: v["inviter_reward.til"]! },
    invitee_reward: { freeze: v["invitee_reward.freeze"]!, til: v["invitee_reward.til"]! },
    monthly_cap: v.monthly_cap!,
    review: { velocity_per_day: v["review.velocity_per_day"]!, min_lesson_minutes: v["review.min_lesson_minutes"]! },
  };
  return { payload, errors, warnings };
}

export type CampaignGate = null | "no_draft" | "unsaved" | "invalid" | "not_validated";

/** Why the draft cannot be activated yet (social answers 409 CAMPAIGN_NOT_VALIDATED when it changed after the check). */
export function campaignGate(draft: Pick<ReferralCampaignVersion, "status" | "validated_at" | "updated_at"> | null, dirty: boolean, clientErrors: number, lastCheck: { ok: boolean; at: string } | null): CampaignGate {
  if (!draft || draft.status !== "draft") return "no_draft";
  if (dirty) return "unsaved";
  if (clientErrors > 0 || (lastCheck && !lastCheck.ok && lastCheck.at === draft.updated_at)) return "invalid";
  if (!draft.validated_at || Date.parse(draft.validated_at) < Date.parse(draft.updated_at)) return "not_validated";
  return null;
}

/** problems from 422 CAMPAIGN_INVALID {errors: [{path, code}]} or a RulesValidation (paths normalised) */
export function campaignIssues(xs: unknown): Issue[] {
  if (!Array.isArray(xs)) return [];
  return xs.filter((x): x is Issue => !!x && typeof (x as Issue).path === "string" && typeof (x as Issue).code === "string").map((x) => ({ path: normPath(x.path).replace(/\[(\d+)\]/g, ".$1"), code: x.code }));
}

/* ---------------------------------------------------------------- referral review queue */

/** approve: a referral under review, or a rejected one once (the one re-decision, `can_redecide`) */
export const canApprove = (r: Pick<AdminReferral, "status" | "can_redecide">) => r.status === "review" || (r.status === "rejected" && r.can_redecide);
/** reject: only under review (a reward already given is cancelled by a wallet reversal, not here) */
export const canReject = (r: Pick<AdminReferral, "status">) => r.status === "review";
/** this approval would be the re-decision of an earlier rejection */
export const isRedecision = (r: Pick<AdminReferral, "status">) => r.status === "rejected";

export function rejectBody(code: ReferralRejectRequest["reject_code"] | "", note: string): { body: ReferralRejectRequest | null; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!code || !(MANUAL_REJECT_CODES as readonly string[]).includes(code)) issues.push({ path: "reject_code", code: "required" });
  const p = reasonProblem(note);
  if (p) issues.push({ path: "note", code: p });
  return issues.length ? { body: null, issues } : { body: { reject_code: code as ReferralRejectRequest["reject_code"], note: note.trim() }, issues };
}

/** the inviter's month against the cap: the next qualification would be capped (no reward) */
export const monthFull = (m: AdminReferral["inviter_month"]) => m.qualified >= m.cap;

/* ---------------------------------------------------------------- leagues: weeks of Tashkent */

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
export const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The Monday (YYYY-MM-DD) of the league week of a moment: the week runs Monday 00:00 – Sunday 24:00 Asia/Tashkent (UTC+5). */
export function weekOf(ms = Date.now()): string {
  const local = new Date(ms + 5 * 3_600_000);
  const dow = (local.getUTCDay() + 6) % 7; // Monday = 0
  return ymd(new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow)));
}

/** the Monday n weeks after (before, n < 0) a Monday */
export function shiftWeek(week: string, n: number): string {
  const [y, m, d] = week.split("-").map(Number);
  return ymd(new Date(Date.UTC(y!, m! - 1, d! + 7 * n)));
}

/** «16.11–22.11.2026» */
export function weekLabel(week: string): string {
  const [y, m, d] = week.split("-").map(Number);
  const end = new Date(Date.UTC(y!, m! - 1, d! + 6));
  return `${pad2(d!)}.${pad2(m!)}–${pad2(end.getUTCDate())}.${pad2(end.getUTCMonth() + 1)}.${end.getUTCFullYear()}`;
}

/* ---------------------------------------------------------------- leagues: re-evaluation of a group */

/** only a closed group (prizes paid or held) gets a new version of its results (otherwise 409 RESULT_STATE) */
export const canReevaluateGroup = (g: Pick<AdminLeagueGroupRow, "status">) => g.status === "closed" || g.status === "held";
export const canReleasePrizes = (g: Pick<AdminLeagueGroupRow, "status">) => g.status === "held";

export interface PlaceRow {
  user_id: string;
  was: number | null;
  now: number | null;
  prize_was: number;
  prize_now: number;
}

/**
 * Preview of a re-evaluation: the members still in the standings keep their order (by place, then XP), the excluded
 * leave it; the prizes follow the places of the latest version (place → prize), the server recalculates for real.
 */
export function previewPlaces(g: Pick<AdminLeagueGroup, "members" | "results">, exclude: ReadonlySet<string>): PlaceRow[] {
  const latest = g.results[0];
  const prizeAt = new Map<number, number>();
  for (const s of latest?.standings ?? []) if (s.prize_til > 0) prizeAt.set(s.place, s.prize_til);
  const ranked = [...g.members]
    .filter((m) => m.place != null)
    .sort((a, b) => a.place! - b.place! || b.xp - a.xp);
  let place = 0;
  const out: PlaceRow[] = [];
  for (const m of ranked) {
    if (exclude.has(m.user_id)) {
      out.push({ user_id: m.user_id, was: m.place, now: null, prize_was: m.prize_til, prize_now: 0 });
      continue;
    }
    place += 1;
    out.push({ user_id: m.user_id, was: m.place, now: place, prize_was: m.prize_til, prize_now: prizeAt.get(place) ?? 0 });
  }
  return out;
}

/** what the re-evaluation changes for people: who leaves the standings and whose prize changes (everyone below an
 *  excluded member moves up a place — listing them all would hide the point) */
export const changedPlaces = (rows: readonly PlaceRow[]) => rows.filter((r) => (r.was != null && r.now == null) || r.prize_was !== r.prize_now);

/** members that can be excluded: ranked now (not excluded by an earlier version); anomalies first */
export function excludable(members: readonly AdminLeagueMember[]): AdminLeagueMember[] {
  return members.filter((m) => !m.excluded && m.place != null).sort((a, b) => Number(b.anomaly) - Number(a.anomaly) || a.place! - b.place!);
}

export function groupReevalBody(exclude: readonly string[], reason: string): { body: LeagueReevaluateRequest | null; issues: Issue[] } {
  const issues: Issue[] = [];
  if (exclude.length > EXCLUDE_MAX) issues.push({ path: "exclude_user_ids", code: "too_many" });
  const p = reasonProblem(reason);
  if (p) issues.push({ path: "reason", code: p });
  return issues.length ? { body: null, issues } : { body: { exclude_user_ids: [...exclude], reason: reason.trim() }, issues };
}

/**
 * The signature of the Idempotency-Key of a group re-evaluation: the group and the body (F7-9). Never the version of
 * the group: a lost answer re-reads the group (v + 1) and the repeat of the same command must go with the same key.
 */
export const reevalSig = (groupId: string, body: LeagueReevaluateRequest) => JSON.stringify(["reevaluate", groupId, [...body.exclude_user_ids].sort(), body.reason]);

/* ---------------------------------------------------------------- duels */

/** only a finished duel is re-evaluated (otherwise 409 RESULT_STATE) */
export const canReevaluateDuel = (d: Pick<AdminDuel, "status">) => d.status === "finished";

export function duelReevalBody(current: DuelResult | null, result: DuelReevaluateRequest["result"] | null, reason: string): { body: DuelReevaluateRequest | null; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!result) issues.push({ path: "result", code: "required" });
  else if (result === current) issues.push({ path: "result", code: "same_result" });
  const p = reasonProblem(reason);
  if (p) issues.push({ path: "reason", code: p });
  return issues.length ? { body: null, issues } : { body: { result: result!, reason: reason.trim() }, issues };
}

/* ---------------------------------------------------------------- pair rooms */

export const roomActive = (s: PairRoomStatus) => (ROOM_ACTIVE as readonly string[]).includes(s);

/** «4:05», «1:02:09» */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

export interface RoomFilters {
  status: PairRoomStatus | "";
  from: string;
  to: string;
}
export const emptyRoomFilters = (): RoomFilters => ({ status: "", from: "", to: "" });
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** «from» after «to» is a problem of the filters (no request is sent) */
export function roomFiltersProblem(f: RoomFilters): "to_before_from" | null {
  return f.from && f.to && DATE_RE.test(f.from) && DATE_RE.test(f.to) && f.to < f.from ? "to_before_from" : null;
}

/** the share of the speaking time of one participant in the room (0..100), null when nobody spoke */
export function speakShare(seconds: number, all: readonly number[]): number | null {
  const total = all.reduce((a, b) => a + b, 0);
  return total > 0 ? Math.round((seconds / total) * 100) : null;
}
