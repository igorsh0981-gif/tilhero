/**
 * Sprint 3 logic without the DOM: placement test helpers (progress, confidence words, «почему так», follow-up window,
 * retake date, word order), speech voice choice, content helpers, deep links of the new routes.
 */
import { describe, expect, it } from "vitest";
import {
  canResume,
  confidenceLevel,
  evidenceRows,
  followupUntil,
  hasAssessedArea,
  orderAnswer,
  orderPick,
  orderStart,
  orderUnpick,
  orderedAreas,
  progressOf,
  retakeAllowed,
  splitGap,
} from "../src/domain/diagnostics";
import { groupSkills, HTTPS_LINK, stageShares } from "../src/domain/content";
import { routeTarget } from "../src/state/nav";
import { parseStartParam, ROUTES } from "../src/tg/deeplink";
import { pickEnglishVoice } from "../src/tg/speech";
import catalogue from "../../../packages/contracts/release-notes.json";

describe("placement test — progress and result helpers", () => {
  it("progress: answered of the estimate, the current item, never above 100 %", () => {
    expect(progressOf({ answered: 0, total_estimate: 24 }, 1)).toEqual({ answered: 0, total: 24, current: 1, pct: 0 });
    expect(progressOf({ answered: 12, total_estimate: 24 }, 13)).toMatchObject({ current: 13, pct: 50 });
    // adaptive test longer than the estimate: the total grows, the bar stays below 100 %
    expect(progressOf({ answered: 25, total_estimate: 24 }, 26)).toMatchObject({ total: 26, current: 26 });
    expect(progressOf({ answered: 3, total_estimate: 3 })).toMatchObject({ pct: 100 });
  });

  it("confidence in words and dots (never only colour)", () => {
    expect(confidenceLevel(0.9)).toEqual({ level: "high", dots: 3 });
    expect(confidenceLevel(0.75)).toEqual({ level: "high", dots: 3 });
    expect(confidenceLevel(0.5)).toEqual({ level: "medium", dots: 2 });
    expect(confidenceLevel(0.49)).toEqual({ level: "low", dots: 1 });
    expect(confidenceLevel(null)).toBeNull();
    expect(confidenceLevel(Number.NaN)).toBeNull();
  });

  it("«почему так»: rows by band (answered / correct, never above answered), low bands first, empty bands skipped", () => {
    expect(
      evidenceRows([
        { band: "A2", answered: 3, correct: 1 },
        { band: "A1", answered: 3, correct: 3 },
        { band: "B1", answered: 0, correct: 0 },
        { band: "B2", answered: 1, correct: 5 },
      ]),
    ).toEqual([
      { band: "A1", answered: 3, correct: 3, pct: 100 },
      { band: "A2", answered: 3, correct: 1, pct: 33 },
      { band: "B2", answered: 1, correct: 1, pct: 100 },
    ]);
  });

  it("a result rests on an assessed area (results without one count towards the «unfinished» limit)", () => {
    const area = (status: "assessed" | "not_assessed") => ({ area: "grammar", status, band: null, confidence: null, reason: null, evidence: [], needs_followup: false }) as never;
    expect(hasAssessedArea({ areas: [area("not_assessed"), area("assessed")] })).toBe(true);
    expect(hasAssessedArea({ areas: [area("not_assessed")] })).toBe(false);
    expect(hasAssessedArea(null)).toBe(false);
  });

  it("areas in the fixed order vocabulary → writing", () => {
    const a = (area: string) => ({ area, status: "not_assessed", band: null, confidence: null, reason: null, evidence: [], needs_followup: false }) as never;
    expect(orderedAreas([a("writing"), a("listening"), a("vocabulary"), a("speaking"), a("grammar"), a("reading")]).map((x: { area: string }) => x.area)).toEqual([
      "vocabulary", "grammar", "reading", "listening", "speaking", "writing",
    ]);
  });

  it("follow-up: only needs_followup of an assessed area, within 24 h of the result", () => {
    const now = Date.parse("2026-11-19T10:00:00Z");
    const res = { created_at: "2026-11-19T08:00:00Z" };
    expect(followupUntil(res, { needs_followup: true, status: "assessed" }, now)?.toISOString()).toBe("2026-11-20T08:00:00.000Z");
    expect(followupUntil(res, { needs_followup: false, status: "assessed" }, now)).toBeNull();
    expect(followupUntil(res, { needs_followup: true, status: "not_assessed" }, now)).toBeNull();
    expect(followupUntil({ created_at: "2026-11-18T09:00:00Z" }, { needs_followup: true, status: "assessed" }, now)).toBeNull();
  });

  it("retake: allowed when next_allowed_at is empty or passed; resume only an in-progress unexpired session", () => {
    const now = Date.parse("2026-11-19T10:00:00Z");
    expect(retakeAllowed({ next_allowed_at: null }, now)).toBe(true);
    expect(retakeAllowed({ next_allowed_at: "2026-12-03T10:00:00Z" }, now)).toBe(false);
    expect(retakeAllowed({ next_allowed_at: "2026-11-19T09:00:00Z" }, now)).toBe(true);
    const session = { session_id: "s", pair_id: "ru-en", test_version: "x", status: "in_progress" as const, answered: 3, total_estimate: 24, started_at: "", expires_at: "2026-11-20T08:00:00Z", followup_area: null };
    expect(canResume({ status: "in_progress", session }, now)).toBe(true);
    expect(canResume({ status: "in_progress", session: { ...session, expires_at: "2026-11-19T09:00:00Z" } }, now)).toBe(false);
    expect(canResume({ status: "completed", session: null }, now)).toBe(false);
  });

  it("word order: tap adds to the end or before a word (drop), tap in the answer returns to the bank; repeated words stay distinct", () => {
    const opts = ["the", "cat", "the", "sees", "dog"];
    let s = orderStart(opts.length);
    s = orderPick(s, 0);
    s = orderPick(s, 1);
    s = orderPick(s, 3);
    s = orderPick(s, 2);
    s = orderPick(s, 4);
    expect(orderAnswer(s, opts)).toEqual(["the", "cat", "sees", "the", "dog"]);
    expect(s.bank).toEqual([]);
    s = orderUnpick(s, 1);
    expect(s.bank).toEqual([1]);
    s = orderPick(s, 1, 1); // dropped before «sees»
    expect(orderAnswer(s, opts)).toEqual(["the", "cat", "sees", "the", "dog"]);
    expect(orderPick(s, 99)).toBe(s);
    expect(orderUnpick(orderStart(2), 0)).toEqual(orderStart(2));
  });

  it("gap of a gap_choice prompt", () => {
    expect(splitGap("She ___ a teacher.")).toEqual(["She ", " a teacher."]);
    expect(splitGap("No gap")).toBeNull();
  });
});

describe("speech synthesis voice", () => {
  const v = (lang: string, name = lang, localService = true) => ({ lang, name, localService });
  it("prefers the requested variant, then en-GB, en-US, any en-*; local voices first; none → null", () => {
    expect(pickEnglishVoice([v("ru-RU"), v("en-US"), v("en-GB")])?.lang).toBe("en-GB");
    expect(pickEnglishVoice([v("en-US"), v("en-GB")], "en-US")?.lang).toBe("en-US");
    expect(pickEnglishVoice([v("en_AU")])?.lang).toBe("en_AU");
    expect(pickEnglishVoice([v("en-GB", "remote", false), v("en-GB", "local", true)])?.name).toBe("local");
    expect(pickEnglishVoice([v("ru-RU"), v("uz-UZ")])).toBeNull();
    expect(pickEnglishVoice([])).toBeNull();
  });
});

describe("content helpers", () => {
  it("skills grouped by area in a fixed order, course order inside", () => {
    const sk = (id: string, area: string) => ({ skill_id: id, area, title: { ru: id, uz: id }, level: "A1", state: "not_started", confidence: null, prerequisites: [], updated_at: null, history: [] }) as never;
    const g = groupSkills([sk("g1", "grammar"), sk("f1", "function"), sk("v1", "vocabulary"), sk("g2", "grammar")]);
    expect(g.map((x) => x.area)).toEqual(["function", "vocabulary", "grammar"]);
    expect(g[2]!.skills.map((x: { skill_id: string }) => x.skill_id)).toEqual(["g1", "g2"]);
  });
  it("stage shares of a lesson", () => {
    const s = stageShares({ duration_min: 20, stages: [{ type: "retrieval", minutes: 5 }, { type: "roleplay", minutes: 15 }] });
    expect(s.map((x) => x.pct)).toEqual([25, 75]);
  });
  it("request link: https only", () => {
    expect(HTTPS_LINK.test("https://example.com/x?y=1")).toBe(true);
    for (const bad of ["http://example.com", "javascript:alert(1)", "https://exa mple.com", "ftp://x"]) expect(HTTPS_LINK.test(bad), bad).toBe(false);
  });
});

describe("deep links of sprint 3 (release-notes.json routes)", () => {
  it("the app knows exactly the routes of the catalogue (sprint 8: subscription / til_shop included)", () => {
    const cat = catalogue as { routes: string[]; planned?: unknown };
    expect([...ROUTES].sort()).toEqual([...cat.routes].sort());
    expect(cat.routes).toEqual(expect.arrayContaining(["subscription", "til_shop"]));
    expect(cat.planned).toBeUndefined();
  });
  it("route_<new> parses; each leads to its screen (skills — the «Прогресс» tab)", () => {
    for (const r of ["diagnostics", "plan", "skills", "scenarios", "media", "media_requests", "languages"]) {
      expect(parseStartParam(`route_${r}`)).toEqual({ kind: "route", route: r });
    }
    const home = { tab: "home" as const, stack: [] };
    expect(routeTarget("diagnostics", home)).toEqual({ tab: "home", stack: [{ name: "diagnostics" }] });
    expect(routeTarget("plan", home).stack).toEqual([{ name: "plan" }]);
    expect(routeTarget("skills", home)).toEqual({ tab: "progress", stack: [] });
    expect(routeTarget("scenarios", home).stack).toEqual([{ name: "practice", tab: "scenarios" }]);
    expect(routeTarget("media", home).stack).toEqual([{ name: "practice", tab: "media" }]);
    expect(routeTarget("media_requests", home).stack).toEqual([{ name: "mediaRequests" }]);
    expect(routeTarget("languages", home).stack).toEqual([{ name: "languages" }]);
    // the same screen is not pushed twice; another practice tab replaces the practice screen
    const onMedia = routeTarget("media", home);
    expect(routeTarget("media", onMedia)).toBe(onMedia);
    expect(routeTarget("scenarios", onMedia).stack).toEqual([{ name: "practice", tab: "scenarios" }]);
  });
});
