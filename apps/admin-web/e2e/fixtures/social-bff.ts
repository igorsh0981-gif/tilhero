/**
 * Sprint 7 part of the mock admin-bff («Сообщество», admin.ts «Социальное»):
 * - `/social/users/{id}` (social.read) — the social card built from the profile, cases and sanctions;
 * - `/moderation/*` (moderation.manage) — the case queue, a case with the target's history, the decision (a ban > 7
 *   days or for ever → 403 STEP_UP_REQUIRED without a fresh TOTP; 409 CASE_STATE), sanctions and their revocation
 *   (409 SANCTION_STATE), appeals (overturned lifts the sanction; 409 APPEAL_STATE);
 * - `/referrals/*` (referral.read / referral.manage) — campaign versions (draft with If-Match → 409 DRAFT_CONFLICT,
 *   validate, activate with step-up → 409 CAMPAIGN_NOT_VALIDATED), the review queue (approve review or a rejection
 *   once, reject only review → 409 REFERRAL_STATE), statistics;
 * - `/game/leagues*`, `/game/duels*` (league.read / league.manage) — weeks and groups, the release of held prizes, the
 *   re-evaluation of a group or a duel with step-up (a new version, the previous one kept; reversals of rewards);
 * - `/pair-rooms*` (room.read / room.manage) — rooms with filters, a room without texts, the stop with step-up
 *   (409 ROOM_NOT_ACTIVE).
 * Every command checks the reason (10..500), is audited and answers a repeated Idempotency-Key with the stored answer.
 */
import type {
  AdminCase,
  AdminCaseRow,
  AdminDuel,
  AdminLeagueGroup,
  AdminLeagueWeek,
  AdminPairRoom,
  AdminPairRoomRow,
  AdminReferral,
  AdminReferralRow,
  AdminSanction,
  AdminSanctionAppeal,
  AdminSocialCard,
  DuelResult,
  Period,
  Permission,
  ReferralCampaignPayload,
  ReferralCampaignStats,
  ReferralCampaignVersion,
  SocialStats,
  StaffRef,
} from "@tilhero/contracts/admin";
import type { Ctx } from "./content-bff";
import { DAY, HOUR, iso } from "./data";
import * as S from "./social-data";

type P = Record<string, unknown>;

export interface SocialScenario {
  /** the dashboard block «Сообщество» is down (social did not answer) */
  statsDown?: boolean;
  /** gamification / lessons did not answer the dashboard: duels_finished / pair_rooms_finished — null */
  duelsDown?: boolean;
  roomsDown?: boolean;
  /** another staff member saves the campaign draft right after it is read: the next PUT gets 409 DRAFT_CONFLICT */
  draftConflictOnce?: boolean;
  /** the list page size (default 50) */
  pageSize?: number;
  /** F7-9: the first group re-evaluation is made, but its answer is lost (502): the outcome is unknown to the client */
  reevalLostOnce?: boolean;
  /** F7-18: the campaign activation is made, but its answer is lost (502) */
  activateLostOnce?: boolean;
}

/** F7-20 (admin-bff): the friend code for staff without moderation.manage — «TH-••••-M3PX» */
export const maskCode = (code: string | null) => (code ? `TH-••••-${code.slice(-4)}` : null);

const REASON = (s: unknown) => typeof s === "string" && s.trim().length >= 10 && s.trim().length <= 500;
const ACTIVE_ROOM = new Set(["invited", "waiting", "in_progress", "paused"]);
const MANUAL_REJECT = new Set(["review_rejected", "not_new_user", "family_member"]);
const CAMPAIGN_LIMITS: Record<string, [number, number]> = {
  min_lessons: [1, 10], min_days: [1, 10], window_days: [7, 90], "inviter_reward.freeze": [0, 5], "inviter_reward.til": [0, 1000], "invitee_reward.freeze": [0, 5], "invitee_reward.til": [0, 1000], monthly_cap: [1, 100], "review.velocity_per_day": [1, 50], "review.min_lesson_minutes": [1, 20],
};
const DUEL_XP = { win: 30, draw: 15, participation: 10 };

function mondayOf(ms: number): string {
  const l = new Date(ms + 5 * HOUR);
  const dow = (l.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() - dow)).toISOString().slice(0, 10);
}

function diffValues(a: unknown, b: unknown, path = ""): Array<{ path: string; from: unknown; to: unknown }> {
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])];
    return keys.flatMap((k) => diffValues((a as P)[k], (b as P)[k], path ? `${path}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, from: a ?? null, to: b ?? null }];
}

export class SocialStore {
  profiles = S.profiles();
  sanctions: AdminSanction[] = S.sanctions();
  appeals: AdminSanctionAppeal[];
  cases: AdminCase[] = S.cases();
  campaigns: ReferralCampaignVersion[] = S.campaigns();
  referrals: AdminReferral[] = S.referrals();
  groups: S.GroupSeed[];
  duels: AdminDuel[] = S.duels();
  rooms: AdminPairRoom[] = S.rooms();
  readonly audit: Array<{ action: string; id: string; reason: string | null }> = [];
  readonly currentWeek = mondayOf(Date.now());
  readonly prevWeek = mondayOf(Date.now() - 7 * DAY);
  private idem = new Map<string, unknown>();
  private seq = 0;
  private conflictArmed: boolean;
  private reevalLost: boolean;
  private activateLost: boolean;

  constructor(private readonly sc: SocialScenario = {}) {
    this.conflictArmed = !!sc.draftConflictOnce;
    this.reevalLost = !!sc.reevalLostOnce;
    this.activateLost = !!sc.activateLostOnce;
    this.appeals = S.appeals(this.sanctions);
    const now = S.members(1, 24, { base: 380 }).map((m) => ({ ...m, place: m.place, prize_til: 0 }));
    const b1 = S.members(2, 21, { base: 610 }).map((m) => ({ ...m, prize_til: 0 }));
    const a2 = S.members(3, 23, { base: 540 });
    const held = S.members(4, 22, { base: 330, anomalyAt: 5 });
    const res = (ms: typeof a2, held: boolean, at: string): AdminLeagueGroup["results"][number] => ({ version: 1, standings: S.standingsOf(ms), prizes_held: held, excluded_user_ids: [], closed_at: at, closed_by: null, reason: null });
    const closedAt = new Date(Date.parse(`${this.currentWeek}T00:00:00Z`) - 5 * HOUR + 7 * 60_000).toISOString();
    this.groups = [
      { group_id: S.GROUP.a2Now, week: this.currentWeek, pair_id: "ru-en", level_band: "A2", group_no: 1, status: "open", members: now, results: [] },
      { group_id: S.GROUP.b1Now, week: this.currentWeek, pair_id: "uz-en", level_band: "B1+", group_no: 1, status: "open", members: b1, results: [] },
      { group_id: S.GROUP.a2Prev, week: this.prevWeek, pair_id: "ru-en", level_band: "A2", group_no: 1, status: "closed", members: a2, results: [res(a2, false, closedAt)] },
      { group_id: S.GROUP.heldPrev, week: this.prevWeek, pair_id: "ru-en", level_band: "A0-A1", group_no: 2, status: "held", members: held.map((m) => ({ ...m })), results: [res(held, true, closedAt)] },
    ];
    for (const c of this.cases) c.target_sanctions = this.sanctionsOf(c.target_user_id);
  }

  /* ---------------------------------------------------------------- helpers */

  private stamp(): string {
    return new Date(Date.now() + ++this.seq).toISOString();
  }
  private uuid(prefix: string): string {
    return `${prefix}-0000-4000-8000-${String(900 + ++this.seq).padStart(12, "0")}`;
  }
  private page<T>(xs: T[], cursor: string | null): { items: T[]; next_cursor: string | null } {
    const size = this.sc.pageSize ?? 50;
    const from = cursor ? Number(cursor) : 0;
    const items = xs.slice(from, from + size);
    return { items, next_cursor: from + size < xs.length ? String(from + size) : null };
  }
  private sanctionsOf(uid: string | null): AdminSanction[] {
    if (!uid) return [];
    return this.sanctions.filter((s) => s.user_id === uid).sort((a, b) => b.decided_at.localeCompare(a.decided_at)).map((s) => ({ ...s }));
  }
  private refreshActive(): void {
    const now = Date.now();
    for (const s of this.sanctions) if (s.kind === "social_ban" && s.active && s.until && Date.parse(s.until) <= now) s.active = false;
  }
  private row(c: AdminCase): AdminCaseRow {
    const { comment: _c, subject: _s, resolution: _r, target_sanctions: _t, ...row } = c;
    return row;
  }
  private caseView(c: AdminCase): AdminCase {
    return { ...c, target_sanctions: this.sanctionsOf(c.target_user_id) };
  }
  /** `fullCode` — the staff member has moderation.manage (admin-bff masks the friend code otherwise, F7-20) */
  card(uid: string, fullCode = true): AdminSocialCard | null {
    const p = this.profiles[uid];
    const involved = this.cases.filter((c) => c.target_user_id === uid || c.reporter_user_id === uid);
    if (!p && !involved.length) return null;
    this.refreshActive();
    const sanctions = this.sanctionsOf(uid);
    const ban = sanctions.find((s) => s.kind === "social_ban" && s.active && !s.revoked_at);
    return {
      user_id: uid,
      member_id: S.memberId(uid),
      nickname: p?.nickname ?? null,
      friend_code: fullCode ? (p?.friend_code ?? null) : maskCode(p?.friend_code ?? null),
      game_profile_hidden: p?.hidden ?? false,
      nickname_changed_at: p?.nickname_changed_at ?? null,
      friends: p?.friends ?? 0,
      requests: p?.requests ?? [],
      blocks: p?.blocks ?? { given: 0, received: 0 },
      cases: {
        as_reporter: involved.filter((c) => c.reporter_user_id === uid).length,
        as_target: involved.filter((c) => c.target_user_id === uid).length,
        open_as_target: involved.filter((c) => c.target_user_id === uid && c.status === "open").length,
        recent: involved.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20).map((c) => this.row(c)),
      },
      sanctions,
      restrictions: { social_ban: !!ban, social_ban_until: ban?.until ?? null },
    };
  }
  private refRow(r: AdminReferral): AdminReferralRow {
    const { lessons_log: _l, inviter_month: _m, decision_history: _d, can_redecide: _c, ...row } = r;
    return row;
  }
  private campaignView(v: ReferralCampaignVersion): ReferralCampaignVersion {
    const active = this.campaigns.find((c) => c.status === "active");
    return { ...v, diff: active && active !== v ? diffValues(active.payload, v.payload) : [] };
  }
  private validateCampaign(p: ReferralCampaignPayload): Array<{ path: string; code: string }> {
    const out: Array<{ path: string; code: string }> = [];
    for (const [path, [min, max]] of Object.entries(CAMPAIGN_LIMITS)) {
      const v = path.split(".").reduce<unknown>((o, k) => (o as P | undefined)?.[k], p);
      if (typeof v !== "number" || !Number.isInteger(v)) out.push({ path, code: "not_integer" });
      else if (v < min || v > max) out.push({ path, code: "range" });
    }
    if (typeof p.min_days === "number" && typeof p.min_lessons === "number" && p.min_days > p.min_lessons) out.push({ path: "min_days", code: "days_gt_lessons" });
    return out;
  }
  private groupView(g: S.GroupSeed): AdminLeagueGroup {
    const latest = g.results[0];
    return {
      group_id: g.group_id,
      week: g.week,
      pair_id: g.pair_id,
      level_band: g.level_band,
      group_no: g.group_no,
      size: g.members.length,
      status: g.status,
      version: latest?.version ?? null,
      anomalies: g.members.filter((m) => m.anomaly && !m.excluded).length,
      closed_at: latest?.closed_at ?? null,
      members: g.members.map((m) => ({ ...m })),
      results: g.results.map((r) => ({ ...r, standings: r.standings.map((s) => ({ ...s })) })),
    };
  }
  private weekView(week: string): AdminLeagueWeek {
    const gs = this.groups.filter((g) => g.week === week);
    const start = Date.parse(`${week}T00:00:00Z`) - 5 * HOUR;
    return {
      week,
      starts_at: new Date(start).toISOString(),
      ends_at: new Date(start + 7 * DAY).toISOString(),
      status: week >= this.currentWeek ? "open" : "closed",
      participants: gs.reduce((a, g) => a + g.members.length, 0),
      prizes_til: gs.filter((g) => g.status === "closed").reduce((a, g) => a + (g.results[0]?.standings ?? []).reduce((x, s) => x + s.prize_til, 0), 0),
      groups: gs.map((g) => {
        const { members: _m, results: _r, ...row } = this.groupView(g);
        return row;
      }),
    };
  }
  private duelRow(d: AdminDuel) {
    const { set_id: _s, accept_deadline: _a, play_deadline: _p, rewards: _r, history: _h, ...row } = d;
    return row;
  }
  private roomRow(r: AdminPairRoom): AdminPairRoomRow {
    const { timeline: _t, stopped_by: _s, stop_reason: _r, ...row } = r;
    return row;
  }

  /** the dashboard block (social; duels — gamification, rooms — lessons) */
  stats(period: Period): SocialStats | null {
    if (this.sc.statsDown) return null;
    const m = period === "today" ? 1 : period === "7d" ? 7 : 30;
    const from = Date.now() - m * DAY;
    return {
      period,
      friend_requests: 14 * m,
      friendships_added: 9 * m,
      duels_finished: this.sc.duelsDown ? null : this.duels.filter((d) => d.status === "finished").length * m,
      pair_rooms_finished: this.sc.roomsDown ? null : this.rooms.filter((r) => r.status === "finished").length * m,
      referrals_in_review: this.referrals.filter((r) => r.status === "review").length,
      cases_opened: this.cases.filter((c) => Date.parse(c.created_at) >= from).length,
      cases_open: this.cases.filter((c) => c.status === "open").length,
    };
  }

  /* ---------------------------------------------------------------- routes */

  async handle(method: string, path: string, body: P, q: URLSearchParams, idemKey: string | undefined, headers: Record<string, string>, x: Ctx): Promise<boolean> {
    if (!/^\/(social|moderation|referrals|pair-rooms)\//.test(`${path}/`) && !/^\/game\/(leagues|duels)(\/|$)/.test(path)) return false;
    const done = (p: Promise<void>) => p.then(() => true);
    const deny = (p: Permission, stepUp = false): Promise<boolean> | null => {
      if (!x.perms.has(p)) return done(x.err(403, "PERMISSION_DENIED", { permission: p }));
      if (stepUp && !x.stepUpOk()) return done(x.err(403, "STEP_UP_REQUIRED", { permission: p }));
      return null;
    };
    const rec = (action: string, type: string, id: string, after: P | null, reason: string | null = null) => {
      this.audit.push({ action, id, reason });
      x.record(action, type, id, after, reason);
    };
    const seen = idemKey ? this.idem.get(`${path}:${idemKey}`) : undefined;
    const remember = (v: unknown) => idemKey && this.idem.set(`${path}:${idemKey}`, v);
    const bad = (field: string) => done(x.err(422, "VALIDATION_ERROR", { in: "body", field, errors: ["invalid"] }));
    const me: StaffRef = { staff_id: x.me.staff_id, name: x.me.display_name };
    const key = `${method} ${path}`;
    let m: RegExpMatchArray | null;

    /* ---------- social card ---------- */
    if ((m = path.match(/^\/social\/users\/([0-9a-f-]{36})$/)) && method === "GET") {
      const g = deny("social.read");
      if (g) return g;
      const c = this.card(m[1]!, x.perms.has("moderation.manage"));
      return done(c ? x.json(200, c) : x.err(404, "SOCIAL_PROFILE_NOT_FOUND"));
    }

    /* ---------- moderation: cases ---------- */
    if (path.startsWith("/moderation/")) {
      const g = deny("moderation.manage");
      if (g) return g;
    }
    if (key === "GET /moderation/cases") {
      const st = q.get("status") ?? "open";
      const xs = this.cases.filter((c) => c.status === st).sort((a, b) => (st === "open" ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)));
      return done(x.json(200, (({ items, next_cursor }) => ({ items: items.map((c) => this.row(c)), next_cursor }))(this.page(xs, q.get("cursor")))));
    }
    if ((m = path.match(/^\/moderation\/cases\/([0-9a-f-]{36})$/)) && method === "GET") {
      const c = this.cases.find((y) => y.case_id === m![1]);
      return done(c ? x.json(200, this.caseView(c)) : x.err(404, "CASE_NOT_FOUND"));
    }
    if ((m = path.match(/^\/moderation\/cases\/([0-9a-f-]{36})\/resolve$/)) && method === "POST") {
      const c = this.cases.find((y) => y.case_id === m![1]);
      if (!c) return done(x.err(404, "CASE_NOT_FOUND"));
      if (seen) return done(x.json(200, seen));
      const action = String(body.action ?? "");
      if (!["dismiss", "warning", "social_ban", "nickname_reset"].includes(action)) return bad("action");
      const days = body.days == null ? null : Number(body.days);
      if (action === "social_ban" && days != null && !(Number.isInteger(days) && days >= 1 && days <= 30)) return bad("days");
      if (action !== "social_ban" && days != null) return bad("days");
      if (!REASON(body.basis)) return bad("basis");
      // a ban longer than 7 days or for ever — step-up (moderation.manage)
      if (action === "social_ban" && (days == null || days > 7)) {
        const s = deny("moderation.manage", true);
        if (s) return s;
      }
      if (c.status !== "open") return done(x.err(409, "CASE_STATE", { status: c.status }));
      const basis = String(body.basis).trim();
      let sanction_id: string | null = null;
      if (action !== "dismiss" && c.target_user_id) {
        sanction_id = this.uuid("57000000");
        this.sanctions.unshift({ sanction_id, user_id: c.target_user_id, kind: action as AdminSanction["kind"], until: action === "social_ban" && days != null ? iso(days * DAY) : null, active: action !== "nickname_reset", basis, case_id: c.case_id, decided_by: me, decided_at: iso(0), revoked_at: null, revoked_by: null, revoke_reason: null, appeal: null });
        if (action === "nickname_reset" && this.profiles[c.target_user_id]) {
          this.profiles[c.target_user_id]!.nickname = null;
          c.target_nickname = null;
        }
      }
      Object.assign(c, { status: action === "dismiss" ? "dismissed" : "resolved", resolved_at: iso(0), resolution: { action, sanction_id, basis, resolved_by: me } });
      rec("moderation.case_resolved", "moderation_case", c.case_id, { action, days, sanction_id }, basis);
      const out = this.caseView(c);
      remember(out);
      return done(x.json(200, out));
    }

    /* ---------- moderation: sanctions ---------- */
    if (key === "GET /moderation/sanctions") {
      this.refreshActive();
      const uid = q.get("user_id");
      const act = q.get("active");
      const xs = this.sanctions.filter((s) => (!uid || s.user_id === uid) && (act == null || String(s.active && !s.revoked_at) === act)).sort((a, b) => b.decided_at.localeCompare(a.decided_at));
      return done(x.json(200, this.page(xs, q.get("cursor"))));
    }
    if ((m = path.match(/^\/moderation\/sanctions\/([0-9a-f-]{36})\/revoke$/)) && method === "POST") {
      const s = this.sanctions.find((y) => y.sanction_id === m![1]);
      if (!s) return done(x.err(404, "SANCTION_NOT_FOUND"));
      if (seen) return done(x.json(200, seen));
      if (!REASON(body.reason)) return bad("reason");
      this.refreshActive();
      if (!s.active || s.revoked_at) return done(x.err(409, "SANCTION_STATE"));
      Object.assign(s, { active: false, revoked_at: iso(0), revoked_by: me, revoke_reason: String(body.reason).trim() });
      rec("moderation.sanction_revoked", "sanction", s.sanction_id, null, s.revoke_reason);
      remember({ ...s });
      return done(x.json(200, { ...s }));
    }

    /* ---------- moderation: appeals ---------- */
    if (key === "GET /moderation/appeals") {
      const st = q.get("status") ?? "open";
      const xs = this.appeals.filter((a) => a.status === st).map((a) => ({ ...a, sanction: { ...this.sanctions.find((s) => s.sanction_id === a.sanction.sanction_id)! } }));
      return done(x.json(200, this.page(xs, q.get("cursor"))));
    }
    if ((m = path.match(/^\/moderation\/appeals\/([0-9a-f-]{36})\/decide$/)) && method === "POST") {
      const a = this.appeals.find((y) => y.appeal_id === m![1]);
      if (!a) return done(x.err(404, "APPEAL_NOT_FOUND"));
      if (seen) return done(x.json(200, seen));
      const decision = String(body.decision ?? "");
      if (decision !== "upheld" && decision !== "overturned") return bad("decision");
      if (!REASON(body.note)) return bad("note");
      if (a.status !== "open") return done(x.err(409, "APPEAL_STATE", { status: a.status }));
      const s = this.sanctions.find((y) => y.sanction_id === a.sanction.sanction_id)!;
      Object.assign(a, { status: decision, decided_by: me, decided_at: iso(0), decision_note: String(body.note).trim() });
      s.appeal = { appeal_id: a.appeal_id, status: decision as "upheld" | "overturned" };
      if (decision === "overturned") Object.assign(s, { active: false, revoked_at: iso(0), revoked_by: me, revoke_reason: String(body.note).trim() });
      a.sanction = { ...s };
      rec("moderation.appeal_decided", "appeal", a.appeal_id, { decision }, a.decision_note);
      remember({ ...a });
      return done(x.json(200, { ...a }));
    }

    /* ---------- referral campaigns ---------- */
    if (path.startsWith("/referrals")) {
      const g = deny("referral.read");
      if (g) return g;
    }
    if (key === "GET /referrals/campaigns") {
      return done(x.json(200, { items: [...this.campaigns].sort((a, b) => b.version - a.version).map(({ payload: _p, diff: _d, updated_at: _u, ...s }) => s) }));
    }
    if (key === "GET /referrals/campaigns/stats") {
      const items: ReferralCampaignStats[] = [...new Set(this.campaigns.map((c) => c.version))].sort((a, b) => b - a).map((v) => {
        const rs = this.referrals.filter((r) => r.campaign_version === v);
        const n = (...st: string[]) => rs.filter((r) => st.includes(r.status)).length;
        const pay = this.campaigns.find((c) => c.version === v)!.payload;
        const paid = n("rewarded");
        return { version: v, invited: rs.length + (v === 1 ? 30 : 0), in_progress: n("invited", "diagnostic_done", "learning"), in_review: n("review"), qualified: n("qualified", "rewarded") + (v === 1 ? 11 : 0), rejected: n("rejected") + (v === 1 ? 3 : 0), expired: n("expired") + (v === 1 ? 9 : 0), capped: n("capped"), rewards: { inviter: { freeze: pay.inviter_reward.freeze * paid, til: pay.inviter_reward.til * paid }, invitee: { freeze: pay.invitee_reward.freeze * paid, til: pay.invitee_reward.til * paid } } };
      });
      return done(x.json(200, { items }));
    }
    if ((m = path.match(/^\/referrals\/campaigns\/(\d+)$/)) && method === "GET") {
      const v = this.campaigns.find((c) => c.version === Number(m![1]));
      return done(v ? x.json(200, this.campaignView(v)) : x.err(404, "CAMPAIGN_VERSION_NOT_FOUND"));
    }
    if (path.startsWith("/referrals/campaigns/draft") || (path.startsWith("/referrals/") && method === "POST")) {
      const stepUp = key === "POST /referrals/campaigns/draft/activate";
      const g = deny("referral.manage", stepUp);
      if (g) return g;
    }
    if (key === "PUT /referrals/campaigns/draft") {
      const d = this.campaigns.find((c) => c.status === "draft");
      if (d && this.conflictArmed) {
        this.conflictArmed = false;
        d.updated_at = this.stamp();
        d.comment = "Правка коллеги";
      }
      if (d && headers["if-match"] !== d.updated_at) return done(x.err(409, "DRAFT_CONFLICT", { updated_at: d.updated_at }));
      const payload = body.payload as ReferralCampaignPayload;
      if (!payload || typeof payload !== "object") return bad("payload");
      const comment = body.comment == null ? null : String(body.comment);
      if (comment != null && !REASON(comment)) return bad("comment");
      const now = this.stamp();
      if (d) Object.assign(d, { payload, comment, updated_at: now, validated_at: null });
      else {
        const active = this.campaigns.find((c) => c.status === "active")!;
        this.campaigns.push({ version: Math.max(...this.campaigns.map((c) => c.version)) + 1, status: "draft", comment, based_on: (body.based_on as number | null) ?? active.version, created_by: me, created_at: now, validated_at: null, activated_by: null, activated_at: null, payload, diff: [], updated_at: now });
      }
      const out = this.campaigns.find((c) => c.status === "draft")!;
      rec("referral.campaign_draft_saved", "referral_campaign", String(out.version), null);
      return done(x.json(200, this.campaignView(out)));
    }
    if (key === "DELETE /referrals/campaigns/draft") {
      const d = this.campaigns.find((c) => c.status === "draft");
      if (!d) return done(x.err(404, "CAMPAIGN_VERSION_NOT_FOUND"));
      this.campaigns = this.campaigns.filter((c) => c !== d);
      rec("referral.campaign_draft_deleted", "referral_campaign", String(d.version), null);
      return done(x.json(204));
    }
    if (key === "POST /referrals/campaigns/draft/validate") {
      const d = this.campaigns.find((c) => c.status === "draft");
      if (!d) return done(x.err(404, "CAMPAIGN_VERSION_NOT_FOUND"));
      const errors = this.validateCampaign(d.payload);
      if (!errors.length) d.validated_at = new Date(Math.max(Date.now(), Date.parse(d.updated_at) + 1)).toISOString();
      return done(x.json(200, { ok: !errors.length, errors, warnings: [] }));
    }
    if (key === "POST /referrals/campaigns/draft/activate") {
      if (seen) return done(x.json(200, seen));
      if (!REASON(body.comment)) return bad("comment");
      const d = this.campaigns.find((c) => c.status === "draft");
      if (!d) return done(x.err(404, "CAMPAIGN_VERSION_NOT_FOUND"));
      if (!d.validated_at || Date.parse(d.validated_at) < Date.parse(d.updated_at)) return done(x.err(409, "CAMPAIGN_NOT_VALIDATED"));
      const errors = this.validateCampaign(d.payload);
      if (errors.length) return done(x.err(422, "CAMPAIGN_INVALID", { errors }));
      this.campaigns.find((c) => c.status === "active")!.status = "archived";
      Object.assign(d, { status: "active", comment: String(body.comment).trim(), activated_by: me, activated_at: iso(0) });
      rec("referral.campaign_activated", "referral_campaign", String(d.version), { version: d.version }, d.comment);
      const out = this.campaignView(d);
      remember(out);
      if (this.activateLost) {
        // activated, but the answer never reaches the client
        this.activateLost = false;
        return done(x.err(502, "UPSTREAM_UNAVAILABLE", { service: "social" }));
      }
      return done(x.json(200, out));
    }

    /* ---------- referral review ---------- */
    if (key === "GET /referrals") {
      const st = q.get("status") ?? "";
      const xs = this.referrals.filter((r) => !st || r.status === st).sort((a, b) => (st === "review" ? a.accepted_at.localeCompare(b.accepted_at) : b.accepted_at.localeCompare(a.accepted_at)));
      return done(x.json(200, (({ items, next_cursor }) => ({ items: items.map((r) => this.refRow(r)), next_cursor }))(this.page(xs, q.get("cursor")))));
    }
    if ((m = path.match(/^\/referrals\/([0-9a-f-]{36})$/)) && method === "GET") {
      const r = this.referrals.find((y) => y.referral_id === m![1]);
      return done(r ? x.json(200, { ...r }) : x.err(404, "REFERRAL_NOT_FOUND"));
    }
    if ((m = path.match(/^\/referrals\/([0-9a-f-]{36})\/(approve|reject)$/)) && method === "POST") {
      const r = this.referrals.find((y) => y.referral_id === m![1]);
      if (!r) return done(x.err(404, "REFERRAL_NOT_FOUND"));
      if (seen) return done(x.json(200, seen));
      if (!REASON(body.note)) return bad("note");
      const note = String(body.note).trim();
      if (m[2] === "approve") {
        if (!(r.status === "review" || (r.status === "rejected" && r.can_redecide))) return done(x.err(409, "REFERRAL_STATE", { status: r.status }));
        const redecide = r.status === "rejected";
        const capped = r.inviter_month.qualified >= r.inviter_month.cap;
        Object.assign(r, { status: capped ? "capped" : "qualified", reject_code: capped ? "monthly_cap" : null, qualified_at: iso(0), decided_by: me, decided_at: iso(0), can_redecide: false, inviter_month: capped ? r.inviter_month : { ...r.inviter_month, qualified: r.inviter_month.qualified + 1 } });
        r.decision_history = [...r.decision_history, { decision: "approved", reject_code: null, note, by: me, at: iso(0) }];
        rec(redecide ? "referral.redecided" : "referral.approved", "referral", r.referral_id, { status: r.status }, note);
      } else {
        const code = String(body.reject_code ?? "");
        if (!MANUAL_REJECT.has(code)) return bad("reject_code");
        if (r.status !== "review") return done(x.err(409, "REFERRAL_STATE", { status: r.status }));
        Object.assign(r, { status: "rejected", reject_code: code, decided_by: me, decided_at: iso(0), can_redecide: true });
        r.decision_history = [...r.decision_history, { decision: "rejected", reject_code: code as AdminReferral["reject_code"], note, by: me, at: iso(0) }];
        rec("referral.rejected", "referral", r.referral_id, { reject_code: code }, note);
      }
      remember({ ...r });
      return done(x.json(200, { ...r }));
    }

    /* ---------- leagues ---------- */
    if (path.startsWith("/game/leagues") || path.startsWith("/game/duels")) {
      const g = deny("league.read");
      if (g) return g;
    }
    if (key === "GET /game/leagues") {
      const w = q.get("week") || this.currentWeek;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(w)) return done(x.err(422, "VALIDATION_ERROR", { in: "query", field: "week", errors: ["format"] }));
      return done(x.json(200, this.weekView(w)));
    }
    if ((m = path.match(/^\/game\/leagues\/([0-9a-f-]{36})$/)) && method === "GET") {
      const g = this.groups.find((y) => y.group_id === m![1]);
      return done(g ? x.json(200, this.groupView(g)) : x.err(404, "GROUP_NOT_FOUND"));
    }
    if ((m = path.match(/^\/game\/leagues\/([0-9a-f-]{36})\/(reevaluate|release-prizes)$/)) && method === "POST") {
      const re = m[2] === "reevaluate";
      const p = deny("league.manage", re);
      if (p) return p;
      const g = this.groups.find((y) => y.group_id === m![1]);
      if (!g) return done(x.err(404, "GROUP_NOT_FOUND"));
      if (seen) return done(x.json(200, seen));
      if (!REASON(body.reason)) return bad("reason");
      const reason = String(body.reason).trim();
      if (!re) {
        if (g.status !== "held") return done(x.err(409, "RESULT_STATE", { status: g.status }));
        g.status = "closed";
        g.results[0] = { ...g.results[0]!, prizes_held: false };
        rec("league.prizes_released", "league_group", g.group_id, null, reason);
      } else {
        const ex = Array.isArray(body.exclude_user_ids) ? (body.exclude_user_ids as string[]) : null;
        if (!ex || ex.length > 30) return bad("exclude_user_ids");
        if (g.status === "open") return done(x.err(409, "RESULT_STATE", { status: g.status }));
        const prev = g.results[0]!;
        const prizes = prev.standings.filter((s) => s.prize_til > 0).sort((a, b) => a.place - b.place).map((s) => s.prize_til);
        for (const mm of g.members) if (ex.includes(mm.user_id)) Object.assign(mm, { excluded: true, place: null, prize_til: 0 });
        const ranked = g.members.filter((mm) => !mm.excluded).sort((a, b) => (a.place ?? 0) - (b.place ?? 0) || b.xp - a.xp);
        ranked.forEach((mm, i) => Object.assign(mm, { place: i + 1, prize_til: prizes[i] ?? 0 }));
        const anomalies = g.members.some((mm) => mm.anomaly && !mm.excluded);
        const held = prev.prizes_held && anomalies;
        g.status = held ? "held" : "closed";
        g.results.unshift({ version: prev.version + 1, standings: S.standingsOf(g.members), prizes_held: held, excluded_user_ids: g.members.filter((mm) => mm.excluded).map((mm) => mm.user_id), closed_at: iso(0), closed_by: me, reason });
        rec("league.group_reevaluated", "league_group", g.group_id, { version: prev.version + 1, excluded: ex.length }, reason);
      }
      const out = this.groupView(g);
      remember(out);
      if (re && this.reevalLost) {
        // the new version is written, but the answer never reaches the client
        this.reevalLost = false;
        return done(x.err(502, "UPSTREAM_UNAVAILABLE", { service: "gamification" }));
      }
      return done(x.json(200, out));
    }

    /* ---------- duels ---------- */
    if (key === "GET /game/duels") {
      const st = q.get("status") ?? "";
      const xs = this.duels.filter((d) => !st || d.status === st).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return done(x.json(200, (({ items, next_cursor }) => ({ items: items.map((d) => this.duelRow(d)), next_cursor }))(this.page(xs, q.get("cursor")))));
    }
    if ((m = path.match(/^\/game\/duels\/([0-9a-f-]{36})$/)) && method === "GET") {
      const d = this.duels.find((y) => y.duel_id === m![1]);
      return done(d ? x.json(200, { ...d }) : x.err(404, "DUEL_NOT_FOUND"));
    }
    if ((m = path.match(/^\/game\/duels\/([0-9a-f-]{36})\/reevaluate$/)) && method === "POST") {
      const p = deny("league.manage", true);
      if (p) return p;
      const d = this.duels.find((y) => y.duel_id === m![1]);
      if (!d) return done(x.err(404, "DUEL_NOT_FOUND"));
      if (seen) return done(x.json(200, seen));
      const result = String(body.result ?? "") as DuelResult;
      if (!["challenger", "opponent", "draw"].includes(result)) return bad("result");
      if (!REASON(body.reason)) return bad("reason");
      if (d.status !== "finished") return done(x.err(409, "RESULT_STATE", { status: d.status }));
      const reason = String(body.reason).trim();
      const v = d.result_version + 1;
      // the previous result stays in the history (the system result of the tick is version 1)
      if (!d.history.length) d.history = [{ version: d.result_version, result: d.result!, reason: null, by: null, at: d.finished_at ?? iso(0) }];
      const rewards = d.rewards.map((r) => (r.status === "confirmed" && r.amount > 0 ? { ...r, status: "reversed" as const } : r));
      for (const r of d.rewards) if (r.status === "confirmed" && r.amount > 0) rewards.push({ user_id: r.user_id, op_id: this.uuid("0e700000"), amount: -r.amount, status: "confirmed", result_version: v });
      const give = (uid: string | null, amount: number) => uid && rewards.push({ user_id: uid, op_id: this.uuid("0e700000"), amount, status: "confirmed", result_version: v });
      if (result === "draw") {
        give(d.challenger_user_id, DUEL_XP.draw);
        give(d.opponent_user_id, DUEL_XP.draw);
      } else {
        give(result === "challenger" ? d.challenger_user_id : d.opponent_user_id, DUEL_XP.win);
        const loser = result === "challenger" ? d.opponent_user_id : d.challenger_user_id;
        const played = result === "challenger" ? d.scores.opponent : d.scores.challenger;
        if (played) give(loser, DUEL_XP.participation);
      }
      Object.assign(d, { result, result_version: v, technical: false, rewards });
      d.history = [{ version: v, result, reason, by: me, at: iso(0) }, ...d.history];
      rec("duel.reevaluated", "duel", d.duel_id, { result, result_version: v }, reason);
      remember({ ...d });
      return done(x.json(200, { ...d }));
    }

    /* ---------- pair rooms ---------- */
    if (path.startsWith("/pair-rooms")) {
      const g = deny("room.read");
      if (g) return g;
    }
    if (key === "GET /pair-rooms") {
      const st = q.get("status") ?? "";
      const from = q.get("from");
      const to = q.get("to");
      const local = (s: string) => new Date(Date.parse(s) + 5 * HOUR).toISOString().slice(0, 10);
      const xs = this.rooms.filter((r) => (!st || r.status === st) && (!from || local(r.start_at) >= from) && (!to || local(r.start_at) <= to)).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return done(x.json(200, (({ items, next_cursor }) => ({ items: items.map((r) => this.roomRow(r)), next_cursor }))(this.page(xs, q.get("cursor")))));
    }
    if ((m = path.match(/^\/pair-rooms\/([0-9a-f-]{36})$/)) && method === "GET") {
      const r = this.rooms.find((y) => y.room_id === m![1]);
      return done(r ? x.json(200, { ...r }) : x.err(404, "ROOM_NOT_FOUND"));
    }
    if ((m = path.match(/^\/pair-rooms\/([0-9a-f-]{36})\/stop$/)) && method === "POST") {
      const p = deny("room.manage", true);
      if (p) return p;
      const r = this.rooms.find((y) => y.room_id === m![1]);
      if (!r) return done(x.err(404, "ROOM_NOT_FOUND"));
      if (seen) return done(x.json(200, seen));
      if (!REASON(body.reason)) return bad("reason");
      if (!ACTIVE_ROOM.has(r.status)) return done(x.err(409, "ROOM_NOT_ACTIVE", { status: r.status }));
      const reason = String(body.reason).trim();
      Object.assign(r, { status: "stopped", end_reason: "stopped", ended_at: iso(0), stopped_by: me, stop_reason: reason, participants: r.participants.map((pp) => ({ ...pp, network: null })) });
      r.timeline = [...r.timeline, { seq: (r.timeline.at(-1)?.seq ?? 0) + 1, kind: "stopped", role: null, at: iso(0) }];
      rec("pair_room.stopped", "pair_room", r.room_id, null, reason);
      remember({ ...r });
      return done(x.json(200, { ...r }));
    }
    return false;
  }
}
