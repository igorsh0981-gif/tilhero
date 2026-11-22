/**
 * Sprint 7 logic of «Сообщество»: routes; the decision of a moderation case (actions, the term 1–30 days or for ever,
 * the basis 10..500, step-up for a ban longer than 7 days or for ever), sanctions (in force / revoked / expired),
 * appeals; the referral campaign form (numbers as text, ranges of the validator, min_days ≤ min_lessons, warnings, the
 * activation gate, server paths), the review queue (one re-decision, manual reject codes); league weeks of Tashkent,
 * the preview of a re-evaluation, the bodies of re-evaluation; duels; pair rooms (active statuses, durations, filters,
 * speaking share); plus the overview block «Сообщество» and the decision form of a case on the screen.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminCase, AdminLeagueGroup, AdminLeagueMember, AdminReferral, AdminSanction, AdminSocialCard, Dashboard, Permission, ReferralCampaignPayload } from "@tilhero/contracts/admin";
import { api } from "../src/api/client";
import { I18nProvider } from "../src/i18n";
import { SessionCtx, type Session } from "../src/state/session";
import { ToastProvider } from "../src/ui/toasts";
import { Overview } from "../src/screens/overview/Overview";
import { ModerationPage } from "../src/screens/social/ModerationPage";
import { LeaguesPage } from "../src/screens/social/LeaguesPage";
import { FriendsPage } from "../src/screens/social/FriendsPage";
import { ReferralsPage } from "../src/screens/social/ReferralsPage";
import { LearnerSocialTab } from "../src/screens/social/LearnerSocial";
import * as S from "../src/screens/social/model";

const UID = "a1000000-0000-4000-8000-000000000005";
const CID = "c7000000-0000-4000-8000-000000000001";
const codes = (xs: S.Issue[]) => xs.map((x) => `${x.path}:${x.code}`);
const REASON = "Ник оскорбительный, видно в лиге";

describe("routes", () => {
  it("#/friends/<uuid>, #/moderation/<tab>[/<case>], #/referrals/<tab>[/<id>], #/leagues/<tab>[/<id>], #/pair_rooms/<id>", () => {
    expect(S.parseFriendsRoute(UID.toUpperCase())).toBe(UID);
    expect(S.parseFriendsRoute("nope")).toBeNull();
    expect(S.parseModRoute(null)).toEqual({ tab: "cases", id: null });
    expect(S.parseModRoute(`cases/${CID}`)).toEqual({ tab: "cases", id: CID });
    expect(S.parseModRoute("appeals/x")).toEqual({ tab: "appeals", id: null });
    expect(S.parseModRoute("bogus")).toEqual({ tab: "cases", id: null });
    expect(S.parseRefRoute(null)).toEqual({ tab: "review", id: null });
    expect(S.parseRefRoute("campaigns/3")).toEqual({ tab: "campaigns", id: "3" });
    expect(S.parseRefRoute("campaigns/x")).toEqual({ tab: "campaigns", id: null });
    expect(S.parseRefRoute(`review/${CID}`)).toEqual({ tab: "review", id: CID });
    expect(S.parseRefRoute("stats/1")).toEqual({ tab: "stats", id: null });
    expect(S.parseLeagueRoute(`duels/${CID}`)).toEqual({ tab: "duels", id: CID });
    expect(S.parseLeagueRoute("groups/garbage")).toEqual({ tab: "groups", id: null });
    expect(S.parseRoomRoute(CID)).toBe(CID);
    expect(S.parseRoomRoute("<script>")).toBeNull();
  });
});

describe("moderation: the decision of a case", () => {
  const form = (p: Partial<S.ResolveForm>): S.ResolveForm => ({ ...S.emptyResolve(), basis: REASON, ...p });
  it("a warning, a dismissal and a nickname reset carry no term; the basis is 10..500 after trimming", () => {
    expect(S.resolveBody(form({ action: "warning" })).body).toEqual({ action: "warning", days: null, basis: REASON });
    expect(S.resolveBody(form({ action: "dismiss", days: "99" })).body).toEqual({ action: "dismiss", days: null, basis: REASON });
    expect(S.resolveBody(form({ action: "nickname_reset" })).body?.days).toBeNull();
    expect(codes(S.resolveBody(form({ basis: "  коротко  " })).issues)).toEqual(["basis:reason_short"]);
    expect(codes(S.resolveBody(form({ basis: "x".repeat(501) })).issues)).toEqual(["basis:reason_long"]);
    expect(S.resolveBody(form({ basis: ` ${"x".repeat(500)} ` })).body?.basis).toHaveLength(500);
  });
  it("a ban: 1..30 whole days, or for ever (days null)", () => {
    expect(S.resolveBody(form({ action: "social_ban", days: "1" })).body).toEqual({ action: "social_ban", days: 1, basis: REASON });
    expect(S.resolveBody(form({ action: "social_ban", days: "30" })).body?.days).toBe(30);
    expect(codes(S.resolveBody(form({ action: "social_ban", days: "0" })).issues)).toEqual(["days:days_range"]);
    expect(codes(S.resolveBody(form({ action: "social_ban", days: "31" })).issues)).toEqual(["days:days_range"]);
    expect(codes(S.resolveBody(form({ action: "social_ban", days: "2.5" })).issues)).toEqual(["days:days_range"]);
    expect(codes(S.resolveBody(form({ action: "social_ban", days: " " })).issues)).toEqual(["days:required"]);
    expect(S.resolveBody(form({ action: "social_ban", term: "forever", days: "" })).body).toEqual({ action: "social_ban", days: null, basis: REASON });
  });
  it("step-up: a ban longer than 7 days or for ever; never for the other actions", () => {
    expect(S.resolveNeedsStepUp({ action: "social_ban", term: "days", days: "7" })).toBe(false);
    expect(S.resolveNeedsStepUp({ action: "social_ban", term: "days", days: "8" })).toBe(true);
    expect(S.resolveNeedsStepUp({ action: "social_ban", term: "forever", days: "1" })).toBe(true);
    expect(S.resolveNeedsStepUp({ action: "warning", term: "forever", days: "30" })).toBe(false);
    expect(S.resolveNeedsStepUp({ action: "nickname_reset", term: "days", days: "30" })).toBe(false);
  });
  it("sanctions: in force, revoked, expired by its end, a warning or a reset done; only those in force are revoked", () => {
    const now = Date.parse("2026-11-21T10:00:00Z");
    const s = (p: Partial<AdminSanction>) => ({ kind: "social_ban" as const, active: true, revoked_at: null, until: "2026-11-23T10:00:00Z", ...p });
    expect(S.sanctionState(s({}), now)).toBe("active");
    expect(S.sanctionState(s({ until: null }), now)).toBe("active");
    expect(S.sanctionState(s({ revoked_at: "2026-11-21T09:00:00Z", active: false }), now)).toBe("revoked");
    expect(S.sanctionState(s({ until: "2026-11-21T09:59:00Z" }), now)).toBe("expired");
    expect(S.sanctionState(s({ active: false }), now)).toBe("expired");
    expect(S.sanctionState(s({ kind: "nickname_reset", active: false, until: null }), now)).toBe("done");
    expect(S.canRevoke(s({}), now)).toBe(true);
    expect(S.canRevoke(s({ until: "2026-11-21T09:59:00Z" }), now)).toBe(false);
    expect(S.canRevoke(s({ revoked_at: "2026-11-21T09:00:00Z" }), now)).toBe(false);
  });
  it("appeal: a decision and a note 10..500", () => {
    expect(S.appealBody("overturned", "  Одноклассники, не спам  ").body).toEqual({ decision: "overturned", note: "Одноклассники, не спам" });
    expect(codes(S.appealBody(null, "коротко").issues)).toEqual(["decision:required", "note:reason_short"]);
  });
  it("the role in a case and the card of the subject (duel → leagues, room → pair rooms, anything else — none)", () => {
    expect(S.caseRole({ reporter_user_id: UID, target_user_id: CID }, UID)).toBe("reporter");
    expect(S.caseRole({ reporter_user_id: CID, target_user_id: UID }, UID)).toBe("target");
    expect(S.caseRole({ reporter_user_id: null, target_user_id: null }, UID)).toBeNull();
    expect(S.subjectLink("duel", CID)).toEqual({ page: "leagues", id: `duels/${CID}` });
    expect(S.subjectLink("pair_room", CID.toUpperCase())).toEqual({ page: "pair_rooms", id: CID });
    expect(S.subjectLink("invite", CID)).toBeNull();
    expect(S.subjectLink("duel", null)).toBeNull();
    expect(S.subjectLink("duel", "not-a-uuid")).toBeNull();
  });
});

describe("referral campaigns: the form and the gate", () => {
  const P: ReferralCampaignPayload = { require_diagnostic: true, min_lessons: 3, min_days: 2, window_days: 30, inviter_reward: { freeze: 2, til: 0 }, invitee_reward: { freeze: 0, til: 0 }, monthly_cap: 10, review: { velocity_per_day: 5, min_lesson_minutes: 3 } };
  it("payload → form → payload is the same; nested paths are set and read", () => {
    const f = S.campaignForm(P);
    expect(f.inviter_reward.freeze).toBe("2");
    expect(S.checkCampaign(f)).toMatchObject({ payload: P, errors: [], warnings: [] });
    const g = S.setCampaignValue(f, "review.min_lesson_minutes", "5");
    expect(S.campaignValue(g, "review.min_lesson_minutes")).toBe("5");
    expect(f.review.min_lesson_minutes).toBe("3");
    expect(S.checkCampaign(S.setCampaignValue(f, "min_lessons", "4")).payload.min_lessons).toBe(4);
  });
  it("the validator limits: whole numbers in range; min_days ≤ min_lessons", () => {
    const at = (path: string, v: string) => codes(S.checkCampaign(S.setCampaignValue(S.campaignForm(P), path, v)).errors);
    expect(at("min_lessons", "11")).toEqual(["min_lessons:range"]);
    expect(at("min_lessons", "0")).toEqual(["min_lessons:range"]);
    expect(at("window_days", "6")).toEqual(["window_days:range"]);
    expect(at("window_days", "91")).toEqual(["window_days:range"]);
    expect(at("inviter_reward.freeze", "6")).toEqual(["inviter_reward.freeze:range"]);
    expect(at("invitee_reward.til", "1001")).toEqual(["invitee_reward.til:range"]);
    expect(at("monthly_cap", "0")).toEqual(["monthly_cap:range"]);
    expect(at("review.velocity_per_day", "51")).toEqual(["review.velocity_per_day:range"]);
    expect(at("review.min_lesson_minutes", "21")).toEqual(["review.min_lesson_minutes:range"]);
    expect(at("monthly_cap", "")).toEqual(["monthly_cap:required"]);
    expect(at("monthly_cap", "1.5")).toEqual(["monthly_cap:not_integer"]);
    expect(at("monthly_cap", "-1")).toEqual(["monthly_cap:not_integer"]);
    expect(at("min_days", "4")).toEqual(["min_days:days_gt_lessons"]);
    expect(at("min_days", "3")).toEqual([]);
  });
  it("warnings do not block: no reward for the inviter", () => {
    const f = S.setCampaignValue(S.campaignForm(P), "inviter_reward.freeze", "0");
    expect(codes(S.checkCampaign(f).warnings)).toEqual(["inviter_reward:no_reward"]);
    expect(S.checkCampaign(f).errors).toEqual([]);
  });
  it("the gate: no draft → unsaved → invalid → not validated → ok", () => {
    const d = { status: "draft" as const, validated_at: null as string | null, updated_at: "2026-11-21T10:00:00Z" };
    expect(S.campaignGate(null, false, 0, null)).toBe("no_draft");
    expect(S.campaignGate({ ...d, status: "active" }, false, 0, null)).toBe("no_draft");
    expect(S.campaignGate(d, true, 0, null)).toBe("unsaved");
    expect(S.campaignGate(d, false, 1, null)).toBe("invalid");
    expect(S.campaignGate(d, false, 0, { ok: false, at: d.updated_at })).toBe("invalid");
    expect(S.campaignGate(d, false, 0, null)).toBe("not_validated");
    expect(S.campaignGate({ ...d, validated_at: "2026-11-21T09:59:59Z" }, false, 0, null)).toBe("not_validated");
    expect(S.campaignGate({ ...d, validated_at: "2026-11-21T10:00:01Z" }, false, 0, null)).toBeNull();
  });
  it("server paths are normalised (pydantic loc / brackets → dots)", () => {
    expect(S.campaignIssues([{ path: "payload.review.velocity_per_day", code: "range" }, { path: "body.min_days", code: "x" }, { bad: 1 }])).toEqual([
      { path: "review.velocity_per_day", code: "range" },
      { path: "min_days", code: "x" },
    ]);
    expect(S.campaignIssues(null)).toEqual([]);
  });
});

describe("referral review", () => {
  it("approve under review or a rejection once; reject only under review", () => {
    expect(S.canApprove({ status: "review", can_redecide: false })).toBe(true);
    expect(S.canApprove({ status: "rejected", can_redecide: true })).toBe(true);
    expect(S.canApprove({ status: "rejected", can_redecide: false })).toBe(false);
    expect(S.canApprove({ status: "rewarded", can_redecide: true })).toBe(false);
    expect(S.canReject({ status: "review" })).toBe(true);
    expect(S.canReject({ status: "rejected" })).toBe(false);
    expect(S.isRedecision({ status: "rejected" })).toBe(true);
    expect(S.monthFull({ qualified: 10, cap: 10 })).toBe(true);
    expect(S.monthFull({ qualified: 9, cap: 10 })).toBe(false);
  });
  it("reject: a public code an operator may choose (not window_expired / monthly_cap) and a note", () => {
    expect(S.rejectBody("review_rejected", "Проверка: три урока по 2 минуты").body).toEqual({ reject_code: "review_rejected", note: "Проверка: три урока по 2 минуты" });
    expect(codes(S.rejectBody("", "коротко").issues)).toEqual(["reject_code:required", "note:reason_short"]);
    expect(codes(S.rejectBody("monthly_cap" as never, "Лимит месяца пригласившего").issues)).toEqual(["reject_code:required"]);
    expect(S.MANUAL_REJECT_CODES).not.toContain("window_expired");
  });
});

describe("leagues and duels", () => {
  it("the week of Tashkent: Monday 00:00 (UTC+5) — Sunday 24:00", () => {
    // Sunday 18:59 UTC = Sunday 23:59 Tashkent → still the week of Monday 16.11
    expect(S.weekOf(Date.parse("2026-11-22T18:59:00Z"))).toBe("2026-11-16");
    // Sunday 19:00 UTC = Monday 00:00 Tashkent → the next week
    expect(S.weekOf(Date.parse("2026-11-22T19:00:00Z"))).toBe("2026-11-23");
    expect(S.weekOf(Date.parse("2026-11-16T00:00:00Z"))).toBe("2026-11-16");
    expect(S.shiftWeek("2026-11-16", -1)).toBe("2026-11-09");
    expect(S.shiftWeek("2026-12-28", 1)).toBe("2027-01-04");
    expect(S.weekLabel("2026-11-16")).toBe("16.11–22.11.2026");
    expect(S.weekLabel("2026-12-28")).toBe("28.12–03.01.2027");
  });
  const m = (n: number, xp: number, extra: Partial<AdminLeagueMember> = {}): AdminLeagueMember => ({ user_id: `u${n}`, member_id: `mb_${n}`, nickname: `N${n}`, xp, place: n, prize_til: [50, 30, 20][n - 1] ?? 0, anomaly: false, excluded: false, joined_at: "2026-11-09T10:00:00Z", ...extra });
  const g = (members: AdminLeagueMember[]): Pick<AdminLeagueGroup, "members" | "results"> => ({
    members,
    results: [{ version: 1, standings: members.map((x) => ({ user_id: x.user_id, place: x.place!, xp: x.xp, prize_til: x.prize_til })), prizes_held: true, excluded_user_ids: [], closed_at: "2026-11-16T00:07:00Z", closed_by: null, reason: null }],
  });
  it("re-evaluation preview: the excluded leave, the others move up and take the prizes of their new places", () => {
    const grp = g([m(1, 4200, { anomaly: true }), m(2, 500), m(3, 480), m(4, 300)]);
    const rows = S.previewPlaces(grp, new Set(["u1"]));
    expect(rows).toEqual([
      { user_id: "u1", was: 1, now: null, prize_was: 50, prize_now: 0 },
      { user_id: "u2", was: 2, now: 1, prize_was: 30, prize_now: 50 },
      { user_id: "u3", was: 3, now: 2, prize_was: 20, prize_now: 30 },
      { user_id: "u4", was: 4, now: 3, prize_was: 0, prize_now: 20 },
    ]);
    expect(S.changedPlaces(S.previewPlaces(grp, new Set()))).toEqual([]);
    expect(S.excludable(grp.members).map((x) => x.user_id)).toEqual(["u1", "u2", "u3", "u4"]);
    expect(S.excludable([m(1, 10, { excluded: true, place: null }), m(2, 5)]).map((x) => x.user_id)).toEqual(["u2"]);
  });
  it("group commands: a closed or held group is re-evaluated, only a held one is released; ≤ 30 excluded, a reason", () => {
    expect(S.canReevaluateGroup({ status: "open" })).toBe(false);
    expect(S.canReevaluateGroup({ status: "closed" })).toBe(true);
    expect(S.canReevaluateGroup({ status: "held" })).toBe(true);
    expect(S.canReleasePrizes({ status: "closed" })).toBe(false);
    expect(S.canReleasePrizes({ status: "held" })).toBe(true);
    expect(S.groupReevalBody([], "Пересчёт после исправления XP").body).toEqual({ exclude_user_ids: [], reason: "Пересчёт после исправления XP" });
    expect(codes(S.groupReevalBody(Array.from({ length: 31 }, (_, i) => `u${i}`), "Пересчёт после проверки").issues)).toEqual(["exclude_user_ids:too_many"]);
    expect(codes(S.groupReevalBody(["u1"], "кратко").issues)).toEqual(["reason:reason_short"]);
  });
  it("a duel: only a finished one; another result than the current, a reason", () => {
    expect(S.canReevaluateDuel({ status: "finished" })).toBe(true);
    expect(S.canReevaluateDuel({ status: "accepted" })).toBe(false);
    expect(S.duelReevalBody("challenger", "draw", "Сбой проверки ключей в задании 4").body).toEqual({ result: "draw", reason: "Сбой проверки ключей в задании 4" });
    expect(codes(S.duelReevalBody("challenger", "challenger", "Сбой проверки ключей").issues)).toEqual(["result:same_result"]);
    expect(codes(S.duelReevalBody("draw", null, "").issues)).toEqual(["result:required", "reason:reason_short"]);
    expect(S.REEVAL_RESULTS).not.toContain("none");
  });
});

describe("pair rooms", () => {
  it("only a room that has not ended can be stopped", () => {
    expect(["invited", "waiting", "in_progress", "paused"].every((x) => S.roomActive(x as never))).toBe(true);
    expect(["finished", "abandoned", "stopped", "declined", "expired", "cancelled"].some((x) => S.roomActive(x as never))).toBe(false);
  });
  it("durations, filters, the share of speaking time", () => {
    expect(S.fmtDuration(0)).toBe("0:00");
    expect(S.fmtDuration(860)).toBe("14:20");
    expect(S.fmtDuration(3729)).toBe("1:02:09");
    expect(S.fmtDuration(null)).toBe("—");
    expect(S.fmtDuration(-1)).toBe("—");
    expect(S.roomFiltersProblem({ status: "", from: "2026-11-20", to: "2026-11-19" })).toBe("to_before_from");
    expect(S.roomFiltersProblem({ status: "", from: "2026-11-19", to: "2026-11-19" })).toBeNull();
    expect(S.roomFiltersProblem({ status: "", from: "", to: "2026-11-19" })).toBeNull();
    expect(S.speakShare(142, [142, 96])).toBe(60);
    expect(S.speakShare(0, [0, 0])).toBeNull();
  });
  it("reasons of every command: 10..500", () => {
    expect(S.reasonProblem("123456789")).toBe("reason_short");
    expect(S.reasonProblem(" 1234567890 ")).toBeNull();
    expect(S.reasonProblem("x".repeat(501))).toBe("reason_long");
  });
});

describe("review of sprint 7 (F7-9, F7-19, F7-20)", () => {
  it("F7-9: the key of a group re-evaluation is the group and the body — never its version; the order of ids does not matter", () => {
    const body = { exclude_user_ids: ["u2", "u1"], reason: "Повторы одного урока" };
    expect(S.reevalSig("g1", body)).toBe(S.reevalSig("g1", { exclude_user_ids: ["u1", "u2"], reason: "Повторы одного урока" }));
    expect(S.reevalSig("g1", body)).not.toBe(S.reevalSig("g2", body));
    expect(S.reevalSig("g1", body)).not.toBe(S.reevalSig("g1", { ...body, reason: "Другая причина пересчёта" }));
  });
  it("F7-19: the dictionary families of a subject status by its kind", () => {
    expect(S.subjectStatusKeys("duel", "finished")).toEqual(["dst.finished"]);
    expect(S.subjectStatusKeys("pair_room", "in_progress")).toEqual(["rst7.in_progress"]);
    expect(S.subjectStatusKeys("friend_request", "declined")).toEqual(["frs.declined"]);
    expect(S.subjectStatusKeys("invite", "expired")).toEqual(["rst7.expired", "frs.expired"]);
    expect(S.subjectStatusKeys("nickname", "x")).toEqual([]);
    expect(S.subjectStatusKeys("duel", null)).toEqual([]);
  });
  it("F7-20: a masked friend code is recognised", () => {
    expect(S.codeMasked("TH-••••-M3PX")).toBe(true);
    expect(S.codeMasked("TH-K7QM-4PZD")).toBe(false);
    expect(S.codeMasked(null)).toBe(false);
  });
});

/* ---------------------------------------------------------------- screens */

type Handler = (method: string, path: string, body: unknown) => { status: number; body?: unknown } | undefined;
let handler: Handler = () => undefined;
const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];
beforeEach(() => {
  calls.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const path = url.pathname.replace("/admin/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = handler(init?.method ?? "GET", path, body) ?? { status: 404, body: { code: "NOT_FOUND", message: "", trace_id: "", details: {} } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  });
  api.setCsrf("csrf-test");
  api.hooks = {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const session = (perms: Permission[]): Session => {
  const set = new Set(perms);
  return { me: null, can: (p) => set.has(p), canAny: (ps) => ps.some((p) => set.has(p)), refreshMe: async () => null, setMe: () => undefined, signOut: async () => undefined, reloadTheme: async () => undefined, themeVersion: null, adminLayout: null };
};
const ui = (node: ReactNode, perms: Permission[]) =>
  render(
    <I18nProvider initial="ru">
      <SessionCtx.Provider value={session(perms)}>
        <ToastProvider>{node}</ToastProvider>
      </SessionCtx.Provider>
    </I18nProvider>,
  );

describe("overview block «Сообщество»", () => {
  const off = (service: string) => ({ available: false, data: null, service });
  const d: Dashboard = {
    period: "today",
    generated_at: "2026-11-21T10:00:00Z",
    learners: off("user-admin"),
    support: off("support"),
    whats_new: off("experience-config"),
    campaigns: off("notifications"),
    content: off("catalog"),
    diagnostics: off("diagnostics"),
    lessons: off("lessons"),
    ai: off("ai-gateway"),
    memory: off("memory"),
    game: off("gamification"),
    social: { available: true, data: { period: "today", friend_requests: 14, friendships_added: 9, duels_finished: null, pair_rooms_finished: 3, referrals_in_review: 2, cases_opened: 4, cases_open: 3 } },
    money: { available: false, data: null, service: "billing" },
  };
  it("counters; a source that did not answer is «нет данных»; the queues link only with their rights; attention rows", async () => {
    handler = (_m, p) => (p === "/dashboard" ? { status: 200, body: d } : undefined);
    ui(<Overview />, ["dashboard.read"]);
    expect(await screen.findByTestId("dsoc-requests")).toHaveTextContent(/^Заявок в друзья, сегодня\s*14$/);
    expect(screen.getByTestId("dsoc-duels-na")).toHaveTextContent("нет данных");
    expect(screen.getByTestId("dsoc-rooms")).toHaveTextContent("3");
    expect(screen.getByTestId("dsoc-cases-open")).toHaveTextContent("3");
    expect(screen.queryByTestId("dsoc-cases-link")).toBeNull();
    expect(screen.getByTestId("att-cases-n")).toHaveTextContent("3");
    cleanup();
    ui(<Overview />, ["dashboard.read", "moderation.manage", "referral.read"]);
    await waitFor(() => expect(screen.getByTestId("dsoc-cases-link")).toHaveTextContent("3"));
    expect(screen.getByTestId("dsoc-referrals-link")).toHaveTextContent("2");
    expect(screen.getByTestId("att-referrals")).toBeInTheDocument();
  });
  it("the block is down alone", async () => {
    handler = (_m, p) => (p === "/dashboard" ? { status: 200, body: { ...d, social: off("social") } } : undefined);
    ui(<Overview />, ["dashboard.read"]);
    expect(await screen.findByTestId("block-social-off")).toHaveTextContent("social");
  });
});

describe("the decision of a case on the screen", () => {
  const c: AdminCase = {
    case_id: CID, status: "open", reporter_user_id: "a1000000-0000-4000-8000-000000000001", target_user_id: UID, target_nickname: "RudeFox", subject_kind: "nickname", subject_id: null, reason: "inappropriate_nickname",
    target_complaints_30d: 4, created_at: "2026-11-19T10:00:00Z", resolved_at: null, comment: "Ник оскорбительный", subject: { nickname_at_report: "RudeFox", status: null }, resolution: null, target_sanctions: [],
  };
  it("a ban of 14 days: the step-up notice, the button names the term, the body is sent with an Idempotency-Key", async () => {
    handler = (m, p, b) => {
      if (p === "/moderation/cases") return { status: 200, body: { items: [], next_cursor: null } };
      if (p === `/moderation/cases/${CID}` && m === "GET") return { status: 200, body: c };
      if (p === `/moderation/cases/${CID}/resolve`) return { status: 200, body: { ...c, status: "resolved", resolution: { action: "social_ban", sanction_id: "s1", basis: (b as { basis: string }).basis, resolved_by: { staff_id: "x", name: "Тимур" } } } };
      return undefined;
    };
    ui(<ModerationPage routeId={`cases/${CID}`} />, ["moderation.manage"]);
    const form = await screen.findByTestId("mc-resolve");
    fireEvent.click(within(form).getByTestId("mc-action-social_ban"));
    fireEvent.change(within(form).getByTestId("mc-days"), { target: { value: "7" } });
    expect(within(form).queryByTestId("mc-stepup")).toBeNull();
    expect(within(form).getByTestId("mc-submit")).toHaveTextContent("Запретить на 7 дн.");
    fireEvent.change(within(form).getByTestId("mc-days"), { target: { value: "14" } });
    expect(within(form).getByTestId("mc-stepup")).toHaveTextContent("дольше 7 дней");
    fireEvent.click(within(form).getByTestId("mc-submit"));
    expect(await within(form).findByText("Не короче 10 символов")).toBeInTheDocument();
    fireEvent.change(within(form).getByTestId("mc-basis"), { target: { value: REASON } });
    fireEvent.click(within(form).getByTestId("mc-submit"));
    await waitFor(() => expect(screen.getByTestId("mc-resolution")).toHaveTextContent(REASON));
    const post = calls.find((x) => x.method === "POST")!;
    expect(post.body).toEqual({ action: "social_ban", days: 14, basis: REASON });
    expect(post.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("for ever: no days are sent; the step-up notice is shown", async () => {
    handler = (m, p) => (p === `/moderation/cases/${CID}` && m === "GET" ? { status: 200, body: c } : p === "/moderation/cases" ? { status: 200, body: { items: [], next_cursor: null } } : undefined);
    ui(<ModerationPage routeId={`cases/${CID}`} />, ["moderation.manage"]);
    const form = await screen.findByTestId("mc-resolve");
    fireEvent.click(within(form).getByTestId("mc-action-social_ban"));
    fireEvent.click(within(form).getByTestId("mc-term-forever"));
    expect(within(form).getByTestId("mc-days")).toBeDisabled();
    expect(within(form).getByTestId("mc-stepup")).toBeInTheDocument();
    expect(within(form).getByTestId("mc-submit")).toHaveTextContent("Запретить бессрочно");
  });
});

describe("F7-9 on the screen: a lost answer of a group re-evaluation", () => {
  const GID = "97000000-0000-4000-8000-000000000004";
  const member = (n: number, xp: number, extra: Partial<AdminLeagueMember> = {}): AdminLeagueMember => ({ user_id: `a1000000-0000-4000-8000-00000000000${n}`, member_id: `mb_${n}`, nickname: `N${n}`, xp, place: n, prize_til: [50, 30, 20][n - 1] ?? 0, anomaly: false, excluded: false, joined_at: "2026-11-09T10:00:00Z", ...extra });
  const v1: AdminLeagueGroup = {
    group_id: GID, week: "2026-11-09", pair_id: "ru-en", level_band: "A0-A1", group_no: 2, size: 3, status: "held", version: 1, anomalies: 1, closed_at: "2026-11-16T00:07:00Z",
    members: [member(1, 4200, { anomaly: true }), member(2, 330), member(3, 298)],
    results: [{ version: 1, standings: [], prizes_held: true, excluded_user_ids: [], closed_at: "2026-11-16T00:07:00Z", closed_by: null, reason: null }],
  };
  const v2: AdminLeagueGroup = { ...v1, status: "closed", version: 2, anomalies: 0, results: [{ ...v1.results[0]!, version: 2, prizes_held: false }, v1.results[0]!] };
  it("the group is re-read (v2), the repeat of the same command goes with the same Idempotency-Key", async () => {
    let posts = 0;
    let read = 0;
    handler = (m, p) => {
      if (p === "/game/leagues" && m === "GET") return { status: 200, body: { week: "2026-11-16", starts_at: "2026-11-15T19:00:00Z", ends_at: "2026-11-22T19:00:00Z", status: "open", participants: 0, prizes_til: 0, groups: [] } };
      if (p === `/game/leagues/${GID}` && m === "GET") return { status: 200, body: read++ === 0 ? v1 : v2 };
      if (p === `/game/leagues/${GID}/reevaluate`) return ++posts === 1 ? { status: 502, body: { code: "UPSTREAM_UNAVAILABLE", message: "", trace_id: "", details: { service: "gamification" } } } : { status: 200, body: v2 };
      return undefined;
    };
    ui(<LeaguesPage routeId={`groups/${GID}`} />, ["league.read", "league.manage"]);
    fireEvent.click(await screen.findByTestId("lg-reevaluate"));
    const dlg = await screen.findByTestId("lg-reeval-dialog");
    fireEvent.click(within(within(dlg).getByTestId(`lg-ex-${v1.members[0]!.user_id}`)).getByRole("checkbox"));
    fireEvent.change(within(dlg).getByTestId("lg-reason"), { target: { value: "XP набран за счёт повторов одного урока" } });
    fireEvent.click(within(dlg).getByTestId("lg-reeval-ok"));
    expect(await within(dlg).findByText(/Ответ не получен/)).toBeInTheDocument();
    // the group was re-read: version 2 is under the dialog now
    await waitFor(() => expect(screen.getByTestId("lgr-2")).toBeInTheDocument());
    fireEvent.click(within(dlg).getByTestId("lg-reeval-ok"));
    await waitFor(() => expect(screen.queryByTestId("lg-reeval-dialog")).toBeNull());
    const keys = calls.filter((c) => c.method === "POST").map((c) => c.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe("F7-20 on the screen: the friend code as admin-bff sent it", () => {
  const UID2 = "a1000000-0000-4000-8000-000000000005";
  const card = (code: string | null): AdminSocialCard => ({
    user_id: UID2, member_id: "mb_AAAAAAAAAAAAAAAAAAAAAA", nickname: "SkyFox", friend_code: code, game_profile_hidden: false, nickname_changed_at: null, friends: 3, requests: [], blocks: { given: 0, received: 0 },
    cases: { as_reporter: 0, as_target: 0, open_as_target: 0, recent: [] }, sanctions: [], restrictions: { social_ban: false, social_ban_until: null },
  });
  it("masked — shown as it came, with «only moderators see it whole»; whole — with the moderators' note", async () => {
    handler = (_m, p) => (p === `/social/users/${UID2}` ? { status: 200, body: card("TH-••••-8HKE") } : undefined);
    ui(<FriendsPage routeId={UID2} />, ["social.read"]);
    expect(await screen.findByTestId("fr-code")).toHaveTextContent("TH-••••-8HKE");
    expect(screen.getByTestId("fr-code")).toHaveAttribute("data-masked", "true");
    expect(screen.getByTestId("fr-code-note")).toHaveTextContent("полностью его видят только модераторы");
    cleanup();
    handler = (_m, p) => (p === `/social/users/${UID2}` ? { status: 200, body: card("TH-M3TA-8HKE") } : undefined);
    ui(<FriendsPage routeId={UID2} />, ["social.read", "moderation.manage"]);
    expect(await screen.findByTestId("fr-code")).toHaveAttribute("data-masked", "false");
    expect(screen.getByTestId("fr-code-note")).toHaveTextContent("Код виден полностью — только модераторам");
  });
});

describe("review of sprint 7: the reward outcome of a referral", () => {
  const ref = (n: number, extra: Partial<AdminReferral>): AdminReferral => ({
    referral_id: `e7000000-0000-4000-8000-00000000000${n}`, inviter_user_id: null, invitee_user_id: null, campaign_version: 2, status: "rewarded", accepted_at: "2026-11-01T10:00:00Z", diagnostic_at: null,
    lessons: 3, days: 2, minutes_total: 30, risk_flags: [], reject_code: null, reward_outcome: null, qualified_at: "2026-11-05T10:00:00Z", decided_by: null, decided_at: null,
    lessons_log: [], inviter_month: { qualified: 1, cap: 10 }, decision_history: [], can_redecide: false, ...extra,
  });
  const rows = [ref(1, { reward_outcome: "rewarded" }), ref(2, { reward_outcome: "legacy", campaign_version: 1 }), ref(3, { status: "capped", reject_code: "monthly_cap", reward_outcome: "inviter_capped" }), ref(4, { status: "review", qualified_at: null })];
  it("every outcome has a tone and RU/EN texts", () => {
    expect(S.REWARD_OUTCOMES).toEqual(["rewarded", "legacy", "inviter_capped"]);
    expect(Object.keys(S.REWARD_OUTCOME_TONE).sort()).toEqual([...S.REWARD_OUTCOMES].sort());
  });
  it("the queue: a badge by the outcome, none for null; the card: the outcome with its explanation", async () => {
    handler = (m, p) => {
      if (p === "/referrals" && m === "GET") return { status: 200, body: { items: rows.map(({ lessons_log: _l, inviter_month: _i, decision_history: _d, can_redecide: _c, ...r }) => r), next_cursor: null } };
      const one = rows.find((r) => p === `/referrals/${r.referral_id}`);
      return one ? { status: 200, body: one } : undefined;
    };
    ui(<ReferralsPage routeId="review" />, ["referral.read"]);
    expect(await screen.findByTestId(`rq-outcome-${rows[0]!.referral_id}`)).toHaveTextContent("награда кампании");
    expect(screen.getByTestId(`rq-outcome-${rows[1]!.referral_id}`)).toHaveTextContent("по правилу спринта 6 (выдана ранее)");
    expect(screen.getByTestId(`rq-outcome-${rows[2]!.referral_id}`)).toHaveTextContent("лимит месяца");
    expect(screen.queryByTestId(`rq-outcome-${rows[3]!.referral_id}`)).toBeNull();
    cleanup();
    ui(<ReferralsPage routeId={`review/${rows[1]!.referral_id}`} />, ["referral.read"]);
    const o = await screen.findByTestId("rr-outcome");
    expect(o).toHaveAttribute("data-outcome", "legacy");
    expect(o).toHaveTextContent("по правилу спринта 6 (выдана ранее)");
    cleanup();
    ui(<ReferralsPage routeId={`review/${rows[3]!.referral_id}`} />, ["referral.read"]);
    expect(await screen.findByTestId("rr-body")).toBeInTheDocument();
    expect(screen.queryByTestId("rr-outcome")).toBeNull();
  });
});

describe("review of sprint 7: a learner unknown to the community", () => {
  const UID3 = "a1000000-0000-4000-8000-000000000006";
  const err = (status: number, code: string) => ({ status, body: { code, message: "", trace_id: "t-1", details: {} } });
  it("404 SOCIAL_PROFILE_NOT_FOUND — the calm state, not a failure (learner card tab and the social card)", async () => {
    handler = (_m, p) => (p === `/social/users/${UID3}` ? err(404, "SOCIAL_PROFILE_NOT_FOUND") : undefined);
    ui(<LearnerSocialTab id={UID3} />, ["social.read"]);
    expect(await screen.findByTestId("lc-social-none")).toHaveTextContent("Ученик не найден в сообществе");
    expect(screen.queryByTestId("load-error")).toBeNull();
    cleanup();
    ui(<FriendsPage routeId={UID3} />, ["social.read"]);
    expect(await screen.findByTestId("fr-none")).toHaveTextContent("Ученик не найден в сообществе");
    expect(screen.queryByTestId("load-error")).toBeNull();
  });
  it("any other failure stays a failure with a retry", async () => {
    handler = (_m, p) => (p === `/social/users/${UID3}` ? err(503, "UPSTREAM_UNAVAILABLE") : undefined);
    ui(<LearnerSocialTab id={UID3} />, ["social.read"]);
    expect(await screen.findByTestId("load-error")).toBeInTheDocument();
    expect(screen.queryByTestId("lc-social-none")).toBeNull();
  });
});
