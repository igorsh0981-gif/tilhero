/**
 * Sprint 4 in the Mini App: the logic of the lesson player (step transitions, feedback on retrieval and none on the
 * check without hints, idempotent re-send of a lost answer, restore after a pause, the roleplay chat, no text field for
 * a child, errors shown by code) — pure reducer tests and the screens on a fake BFF built on the same lesson engine as
 * the Playwright mock (e2e/fixtures/lessons.ts).
 */
import type { EvaluationView, LearningPlan, LessonSession, LessonStep, LessonSummary, SessionResponse, StepResult } from "@tilhero/contracts/bff";
import { act, cleanup as cleanupRender, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLessons, type LessonsScenario } from "../e2e/fixtures/lessons";
import { createBff } from "../src/api/bff";
import { ApiClient } from "../src/api/client";
import { ApiError } from "../src/api/errors";
import { FALLBACK_CONFIG } from "../src/config/experience";
import {
  AI_BUSY_RETRIES,
  AI_BUSY_RETRY_MS,
  APPEAL_WINDOW_DAYS,
  errorRedacted,
  errorType,
  retryAiBusy,
  appealState,
  canAppeal,
  canTypeFreeText,
  chatBubbles,
  completedMark,
  EVAL_POLL_DELAYS_MS,
  initialPlayer,
  isRetryable,
  needsEvaluationPoll,
  pollEvaluation,
  sendFailure,
  shouldRecheckSession,
  showsDegraded,
  itemAnswer,
  itemKind,
  playerMarker,
  playerReducer,
  stageRanges,
  stageStrip,
  type RoleplayStep,
} from "../src/domain/lessons";
import { I18nProvider } from "../src/i18n";
import { AppealScreen } from "../src/screens/lessons/AppealScreen";
import { LessonCardScreen } from "../src/screens/lessons/LessonCardScreen";
import { LessonPlayer } from "../src/screens/lessons/Player";
import { LessonSummaryScreen } from "../src/screens/lessons/Summary";
import { AppProvider, type AppCtx } from "../src/state/app";
import { useNav, type Nav, type Pushed } from "../src/state/nav";
import { PopupHost, ToastHost } from "../src/ui/overlays";

const ME = "6f1c2b3a-1111-4a2b-9c3d-000000000001";
const L = (ru: string) => ({ ru, uz: `${ru} uz` });

/* ================================================================ pure logic */

const session = (over: Partial<LessonSession> = {}): LessonSession => ({
  session_id: "5e550000-aaaa-4bbb-8ccc-000000000001",
  kind: "lesson",
  title: L("В кафе"),
  lesson_id: "l1",
  scenario_id: null,
  asset_id: null,
  status: "in_progress",
  stage: "retrieval",
  stages: [
    { type: "retrieval", status: "current" },
    { type: "explanation", status: "pending" },
    { type: "roleplay", status: "skipped" },
    { type: "assessment", status: "pending" },
    { type: "summary", status: "pending" },
  ],
  ai_mode: "full",
  ai_degraded: false,
  started_at: null,
  paused_at: null,
  finished_at: null,
  expires_at: null,
  minutes: 0,
  ...over,
});
const base = (n: number, stage: LessonStep["stage"] = "retrieval") => ({ step_id: `s${n}`, stage, position: 1, stage_total: 2 });
const item = (n: number, graded = false): LessonStep => ({
  ...base(n, graded ? "assessment" : "retrieval"),
  type: "item",
  item: { item_id: `i${n}`, item_type: "single_choice", instruction: L("Выберите"), prompt_en: "the bill", options: ["счёт", "чек"] },
  hint_available: !graded,
  hints_used: 0,
  graded_later: graded,
});
const roleplay = (n: number, o: Partial<RoleplayStep> = {}): RoleplayStep => ({
  ...base(n, "roleplay"),
  type: "roleplay",
  node_id: "n1",
  character: { id: "tom", name: "Tom", role: L("Официант"), voice: "en-GB" },
  line_en: "Hi! What can I get you?",
  gloss: L("Привет! Что вам принести?"),
  choices: [{ choice_id: "c1", text_en: "A latte, please." }],
  free_text_allowed: true,
  hint_available: true,
  hints_used: 0,
  history: [],
  unclear_attempts: 0,
  ...o,
});
const result = (next: LessonStep, o: Partial<StepResult> = {}): StepResult => ({ accepted: true, feedback: null, reply: null, next, ...o });

describe("stages and items", () => {
  it("the strip: before the current stage — done, after — pending, skipped stays; index among the visible", () => {
    const s = stageStrip(session(), { stage: "assessment" });
    expect(s.stages.map((x) => x.status)).toEqual(["done", "done", "skipped", "current", "pending"]);
    expect([s.index, s.total, s.done, s.current]).toEqual([3, 4, 2, "assessment"]);
  });
  it("minute ranges of the card: 0–3, 3–7 …", () => {
    expect(stageRanges([{ minutes: 3 }, { minutes: 4 }, { minutes: 8 }]).map((x) => [x.from, x.to])).toEqual([[0, 3], [3, 7], [7, 15]]);
  });
  it("how an item is answered: index, chosen or typed gap word, words or lines in order", () => {
    expect(itemKind("single_choice", ["a"])).toBe("choice");
    expect(itemKind("gap_fill", [])).toBe("gap");
    expect(itemKind("gap_fill_media", ["to", "for"])).toBe("gapChoice");
    expect(itemKind("order_lines", ["a", "b"])).toBe("lines");
    expect(itemAnswer(1)).toEqual({ answer: 1 });
    expect(itemAnswer("  like ")).toEqual({ answer: "like" });
    expect(itemAnswer("   ")).toBeNull();
    expect(itemAnswer(["I", "am"])).toEqual({ answer: ["I", "am"] });
    expect(itemAnswer(null)).toBeNull();
  });
  it("free text: never a child; only when allowed; after two unclear answers — choices only", () => {
    expect(canTypeFreeText({ free_text_allowed: true, unclear_attempts: 0 }, false)).toBe(true);
    expect(canTypeFreeText({ free_text_allowed: true, unclear_attempts: 0 }, true)).toBe(false);
    expect(canTypeFreeText({ free_text_allowed: true, unclear_attempts: 2 }, false)).toBe(false);
    expect(canTypeFreeText({ free_text_allowed: false, unclear_attempts: 0 }, false)).toBe(false);
  });
  it("a lost answer is re-sent (network, 5xx, 429); a business error is not", () => {
    expect(isRetryable(new ApiError(0, "NETWORK", ""))).toBe(true);
    expect(isRetryable(new ApiError(503, "UPSTREAM_UNAVAILABLE", ""))).toBe(true);
    expect(isRetryable(new ApiError(429, "RATE_LIMITED", ""))).toBe(true);
    expect(isRetryable(new ApiError(409, "STEP_NOT_CURRENT", ""))).toBe(false);
    expect(isRetryable(new Error("x"))).toBe(false);
  });
  it("plan marks: passed / again / later", () => {
    const c = { lesson_id: "l", module_id: "m", title: L("x"), goal: L("x"), level: "A1" as const, kind: "core" as const, duration_min: 20, primary_skill_id: "s", scenario_id: null, stages: [], evaluation_id: null, completed_at: "2026-11-19T10:00:00Z" };
    expect([completedMark({ ...c, passed: true }), completedMark({ ...c, passed: false }), completedMark({ ...c, passed: null })]).toEqual(["passed", "again", "later"]);
  });
});

describe("the roleplay chat", () => {
  it("first node: the character's line with its translation", () => {
    const b = chatBubbles(roleplay(1), [], null);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ who: "character", text: "Hi! What can I get you?", gloss: { ru: "Привет! Что вам принести?" } });
  });
  it("server history is the truth; the reply and the node line are not repeated when already said", () => {
    const step = roleplay(2, {
      line_en: "Sure! Anything else?",
      gloss: L("Конечно!"),
      history: [
        { turn_id: "T1", speaker: "character", text_en: "Hi! What can I get you?", character_id: "tom" },
        { turn_id: "T2", speaker: "learner", text_en: "A latte, please.", character_id: null },
        { turn_id: "T3", speaker: "character", text_en: "Sure! Anything else?", character_id: "tom" },
      ],
    });
    const b = chatBubbles(step, [], { character_id: "tom", text_en: "Sure! Anything else?", gloss: L("Конечно!"), clarification: false });
    expect(b.map((x) => x.text)).toEqual(["Hi! What can I get you?", "A latte, please.", "Sure! Anything else?"]);
    expect(b[2]!.gloss).toEqual(L("Конечно!"));
  });
  it("after a clarification the node line said earlier keeps its translation", () => {
    const step = roleplay(3, {
      unclear_attempts: 1,
      history: [
        { turn_id: "T1", speaker: "character", text_en: "Hi! What can I get you?", character_id: "tom" },
        { turn_id: "T2", speaker: "learner", text_en: "blue sky", character_id: null },
        { turn_id: "T3", speaker: "character", text_en: "Sorry, what would you like?", character_id: "tom" },
      ],
    });
    const b = chatBubbles(step, [], { character_id: "tom", text_en: "Sorry, what would you like?", gloss: null, clarification: true });
    expect(b.map((x) => x.text)).toEqual(["Hi! What can I get you?", "blue sky", "Sorry, what would you like?"]);
    expect(b[0]!.gloss).toEqual(L("Привет! Что вам принести?"));
    expect(b[2]!.clarification).toBe(true);
  });

  it("a clarification is the prompt: the node line is not added after it", () => {
    const b = chatBubbles(roleplay(2, { unclear_attempts: 1 }), [{ id: "x", who: "learner", text: "blah", gloss: null, characterId: null }], {
      character_id: "tom", text_en: "Sorry, what would you like?", gloss: null, clarification: true,
    });
    expect(b.map((x) => [x.who, x.text, !!x.clarification])).toEqual([["learner", "blah", false], ["character", "Sorry, what would you like?", true]]);
  });
});

describe("the player reducer", () => {
  const loaded = playerReducer(initialPlayer, { type: "loaded", session: session(), step: item(1) });

  it("retrieval: feedback with the right answer, then «Дальше» → the next step", () => {
    let s = playerReducer(loaded, { type: "send", stepId: "s1", body: { answer: 1 } });
    expect(s.phase).toBe("sending");
    s = playerReducer(s, { type: "result", result: result(item(2), { feedback: { correct: false, correct_answer: "счёт" } }) });
    expect(s.step!.step_id).toBe("s1");
    expect(s.checked).toMatchObject({ stepId: "s1", feedback: { correct: false, correct_answer: "счёт" } });
    expect(s.pending).toBeNull();
    s = playerReducer(s, { type: "advance" });
    expect([s.step!.step_id, s.checked]).toEqual(["s2", null]);
  });

  it("check without hints: no feedback even if sent, «Ответ принят» counter, straight to the next step", () => {
    const g = playerReducer(initialPlayer, { type: "loaded", session: session(), step: item(5, true) });
    const s1 = playerReducer(playerReducer(g, { type: "send", stepId: "s5", body: { answer: 0 } }), { type: "result", result: result(item(6, true), { feedback: { correct: false, correct_answer: "x" } }) });
    expect(s1.checked).toBeNull();
    expect(s1.step!.step_id).toBe("s6");
    expect(s1.accepted).toBe(1);
  });

  it("a lost answer stays pending (same body), a business error clears it, the result clears it", () => {
    const body = { answer: 0 };
    let s = playerReducer(loaded, { type: "send", stepId: "s1", body });
    s = playerReducer(s, { type: "sendFailed", error: new ApiError(0, "NETWORK", "") });
    expect(s.pending).toEqual({ stepId: "s1", body });
    expect(s.error?.kind).toBe("send");
    expect(s.phase).toBe("ready");
    const again = playerReducer(s, { type: "send", stepId: "s1", body: s.pending!.body });
    expect(again.pending!.body).toBe(body);
    expect(playerReducer(again, { type: "failed", error: { kind: "action", error: new ApiError(422, "ANSWER_INVALID", "") } }).pending).toBeNull();
  });

  it("roleplay: the learner's line joins the transcript, the reply is kept; leaving the scene clears it", () => {
    let s = playerReducer(initialPlayer, { type: "loaded", session: session(), step: roleplay(3) });
    s = playerReducer(s, { type: "send", stepId: "s3", body: { choice_id: "c1" } });
    const next = roleplay(4, { line_en: "Sure!", node_id: "n2" });
    s = playerReducer(s, { type: "result", result: result(next, { reply: { character_id: "tom", text_en: "Sure!", gloss: null, clarification: false } }) });
    expect(s.chat.map((b) => b.text)).toEqual(["Hi! What can I get you?", "A latte, please."]);
    expect(chatBubbles(next, s.chat, s.reply).map((b) => b.text)).toEqual(["Hi! What can I get you?", "A latte, please.", "Sure!"]);
    s = playerReducer(s, { type: "send", stepId: "s4", body: { text: "  That's all " } });
    s = playerReducer(s, { type: "result", result: result({ ...base(5, "roleplay"), type: "roleplay_end", outcome: "success", summary: L("ok"), can_retry: false }) });
    expect(s.chat.at(-1)).toMatchObject({ who: "learner", text: "That's all" });
    s = playerReducer(s, { type: "send", stepId: "s5", body: {} });
    s = playerReducer(s, { type: "result", result: result(item(6, true)) });
    expect([s.chat, s.reply]).toEqual([[], null]);
  });

  it("pause keeps the step; a fresh session from the server restores it; a closed session ends the player", () => {
    const paused = playerReducer(loaded, { type: "paused", session: session({ status: "paused" }) });
    expect([paused.phase, paused.step!.step_id]).toEqual(["paused", "s1"]);
    const back = playerReducer(paused, { type: "loaded", session: session(), step: item(1) });
    expect([back.phase, back.step!.step_id]).toEqual(["ready", "s1"]);
    expect(playerReducer(back, { type: "closed" }).phase).toBe("closed");
  });

  it("explanation: «проще» results pile up without changing the step; the next step drops them", () => {
    const ex: LessonStep = { ...base(2, "explanation"), type: "explanation", instructions: L("rule"), examples: [], key_words: [], can_simplify: true };
    let s = playerReducer(initialPlayer, { type: "loaded", session: session(), step: ex });
    s = playerReducer(s, { type: "simpler", simpler: { explanation: null, example_en: "I'd like tea.", example_gloss: L("Мне чай."), source: "lesson" } });
    expect([s.simpler.length, s.step!.step_id]).toEqual([1, "s2"]);
    s = playerReducer(playerReducer(s, { type: "send", stepId: "s2", body: {} }), { type: "result", result: result(item(3)) });
    expect(s.simpler).toEqual([]);
  });
});

/* ================================================================ review R2: pure logic */

const evaluation = (o: Partial<EvaluationView> = {}): EvaluationView => ({
  evaluation_id: "e7a10000-aaaa-4bbb-8ccc-000000000001", status: "ok", passed: true, task_completed: true, scores: [], key_errors: [], items: [],
  practice_only: false, rubric_version: "r-a1@2", evaluator: null, superseded_by: null, appeal: null, created_at: "2026-11-01T10:00:00Z", ...o,
});

describe("R2-02: why an answer did not come back", () => {
  it("no network (status 0) ≠ the service answers slowly / is down (5xx) ≠ too many requests", () => {
    expect(sendFailure(new ApiError(0, "NETWORK", ""))).toBe("network");
    expect(sendFailure(new ApiError(503, "UPSTREAM_UNAVAILABLE", ""))).toBe("service");
    expect(sendFailure(new ApiError(504, "SERVICE_UNAVAILABLE", ""))).toBe("service");
    expect(sendFailure(new ApiError(502, "SERVICE_UNAVAILABLE", ""))).toBe("service");
    expect(sendFailure(new ApiError(429, "RATE_LIMITED", ""))).toBe("rate");
    expect(sendFailure(new TypeError("Failed to fetch"))).toBe("network");
    // all of them keep the same answer for «Отправить ещё раз»
    for (const e of [new ApiError(0, "NETWORK", ""), new ApiError(503, "UPSTREAM_UNAVAILABLE", ""), new ApiError(504, "SERVICE_UNAVAILABLE", "")]) expect(isRetryable(e)).toBe(true);
  });
});

describe("R2-05 and the start in the simplified mode: the plaque", () => {
  const lets = { character_id: "tom", text_en: "Let's choose an answer.", gloss: L("Давайте выберем ответ"), clarification: true };
  it("re-read the session: a clarification after free text and the node is choices only now", () => {
    const before = roleplay(3, { free_text_allowed: true });
    const after = roleplay(4, { free_text_allowed: false });
    expect(shouldRecheckSession(before, { reply: lets, next: after }, session())).toBe(true);
    // the session already says so; free text was not allowed before; no clarification; the free text still allowed
    expect(shouldRecheckSession(before, { reply: lets, next: after }, session({ ai_degraded: true }))).toBe(false);
    expect(shouldRecheckSession(roleplay(3, { free_text_allowed: false }), { reply: lets, next: after }, session())).toBe(false);
    expect(shouldRecheckSession(before, { reply: { ...lets, clarification: false }, next: after }, session())).toBe(false);
    expect(shouldRecheckSession(before, { reply: lets, next: roleplay(4, { free_text_allowed: true }) }, session())).toBe(false);
    expect(shouldRecheckSession(item(1), { reply: null, next: item(2) }, session())).toBe(false);
    expect(shouldRecheckSession(before, { reply: lets, next: after }, null)).toBe(false);
  });
  it("a degraded session shows the plaque from the first step (any step but «done»); a normal one — never", () => {
    const off = session({ ai_mode: "choices", ai_degraded: true });
    expect(showsDegraded(off, item(1))).toBe(true);
    expect(showsDegraded(off, roleplay(2))).toBe(true);
    expect(showsDegraded(off, { type: "done" })).toBe(false);
    expect(showsDegraded(session(), roleplay(2))).toBe(false);
    expect(showsDegraded(off, null)).toBe(false);
  });
  it("the reducer keeps the step when the session is re-read", () => {
    const s0 = playerReducer(initialPlayer, { type: "loaded", session: session(), step: roleplay(3) });
    const s1 = playerReducer(s0, { type: "session", session: session({ ai_degraded: true }) });
    expect([s1.step!.step_id, s1.session!.ai_degraded, s1.phase]).toEqual(["s3", true, "ready"]);
  });
});

describe("R2-04: the 14-day appeal window", () => {
  const created = Date.parse("2026-11-01T10:00:00Z");
  const DAY = 24 * 3600_000;
  it("open until 14 days after the evaluation, then closed (a note instead of the button)", () => {
    expect(APPEAL_WINDOW_DAYS).toBe(14);
    expect(appealState(evaluation(), created + DAY)).toBe("open");
    expect(appealState(evaluation(), created + 14 * DAY)).toBe("open");
    expect(appealState(evaluation(), created + 14 * DAY + 1000)).toBe("closed");
    expect(canAppeal(evaluation(), created + 15 * DAY)).toBe(false);
  });
  it("nothing at all where an appeal is not possible anyway; an unreadable date — the server decides", () => {
    const late = created + 30 * DAY;
    expect(appealState(null, late)).toBe("none");
    expect(appealState(evaluation({ practice_only: true }), created)).toBe("none");
    expect(appealState(evaluation({ superseded_by: "e7a10000-aaaa-4bbb-8ccc-000000000002" }), created)).toBe("none");
    expect(appealState(evaluation({ status: "pending_review" }), created)).toBe("none");
    expect(appealState(evaluation({ appeal: { appeal_id: "a", evaluation_id: "e", status: "new", reason: "x", decision_note: null, new_evaluation_id: null, created_at: "2026-11-02T10:00:00Z", decided_at: null } }), late)).toBe("none");
    expect(appealState(evaluation({ created_at: "not a date" }), late)).toBe("open");
  });
});

describe("R2-03: «оценка появится позже» — re-read on a schedule", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const later = (evaluated: boolean): LessonSummary => ({
    session_id: "s", kind: "lesson", title: L("x"), status: "completed", outcome: null, minutes: 5,
    evaluation: evaluated ? evaluation() : null, skills: [], key_words: [], next_lesson: null, can_review: false,
  });
  it("6 attempts with pauses 5, 10, 15, 20, 30, 40 s; a completed session without an evaluation only", () => {
    expect(EVAL_POLL_DELAYS_MS).toEqual([5_000, 10_000, 15_000, 20_000, 30_000, 40_000]);
    expect(needsEvaluationPoll(later(false))).toBe(true);
    expect(needsEvaluationPoll(later(true))).toBe(false);
    expect(needsEvaluationPoll({ ...later(false), status: "cancelled" })).toBe(false);
    expect(needsEvaluationPoll(null)).toBe(false);
  });
  it("stops at the evaluation; a failed read is an attempt; after 6 — end", async () => {
    vi.useFakeTimers();
    const reads: number[] = [];
    let n = 0;
    const read = async () => {
      reads.push(Date.now());
      n += 1;
      if (n === 2) throw new ApiError(503, "UPSTREAM_UNAVAILABLE", "");
      return later(n === 4);
    };
    const ready = vi.fn();
    const end = vi.fn();
    pollEvaluation(read, { ready, end });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(n).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000 + 15_000 + 20_000);
    expect(n).toBe(4);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0]![0].evaluation).not.toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect([n, end.mock.calls.length]).toEqual([4, 0]);

    n = 0;
    const never = vi.fn(async () => later(false));
    pollEvaluation(never, { ready, end });
    await vi.advanceTimersByTimeAsync(EVAL_POLL_DELAYS_MS.reduce((a, b) => a + b, 0));
    expect(never).toHaveBeenCalledTimes(6);
    expect(end).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(never).toHaveBeenCalledTimes(6);
  });
  it("stop (the screen closed): no more reads", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => later(false));
    const stop = pollEvaluation(read, { ready: () => undefined });
    await vi.advanceTimersByTimeAsync(5_000);
    stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

/* ================================================================ screens on the fake BFF */

/** failOnce: "network" — handled, the response lost; [status, code] — not handled; {late} — handled, then this error
 *  (the BFF did not wait for the domain: 503 UPSTREAM_UNAVAILABLE / 504). */
type Failure = "network" | [number, string] | { late: [number, string] };
function fakeServer(o: { kid?: boolean; lessons?: LessonsScenario; failOnce?: Record<string, Failure> } = {}) {
  const engine = new MockLessons(o.lessons ?? {}, { self: ME });
  const calls: Array<{ key: string; body: any; search: string }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const fail = { ...(o.failOnce ?? {}) };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const method = init?.method ?? "GET";
    const key = `${method} ${url.pathname}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ key, body, search: url.search });
    const pattern = key.replace(/[0-9a-f-]{36}/g, "*").replace(/\/s\d+(?=$|\/)/, "/*");
    const f = fail[key] ?? fail[pattern];
    const json = (b: unknown, status = 200) => new Response(b === undefined ? null : JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (Array.isArray(f)) {
      delete fail[key];
      delete fail[pattern];
      return json({ code: f[1], message: f[1], trace_id: "t", details: {} }, f[0]);
    }
    const res = engine.handle(method, url.pathname, url.searchParams, body ?? {}, headers, { owner: ME, kids: !!o.kid });
    if (f && typeof f === "object") {
      delete fail[key];
      delete fail[pattern];
      return json({ code: f.late[1], message: f.late[1], trace_id: "t", details: {} }, f.late[0]);
    }
    if (f === "network") {
      // the server got the answer, the response was lost on the way
      delete fail[key];
      delete fail[pattern];
      throw new TypeError("Failed to fetch");
    }
    if (res) return res.code ? json({ code: res.code, message: res.code, trace_id: "t", details: res.details ?? {} }, res.status) : json(res.body, res.status);
    return json({ code: "NOT_FOUND", message: "", trace_id: "t", details: {} }, 404);
  }) as typeof fetch;
  const client = new ApiClient({ baseUrl: "", fetchImpl, storage: null, timezone: () => "Asia/Tashkent" });
  return { engine, calls, bff: createBff(client), callsTo: (k: string | RegExp) => calls.filter((c) => (typeof k === "string" ? c.key === k : k.test(c.key))) };
}

const PLAN: LearningPlan = {
  learner_id: ME, goal: "travel", level_self: "beginner", topics: [], ui_lang: "ru", explain_lang: "ru", course_pair: "ru-en",
  schedule: { preset: "daily", days: [1, 2, 3, 4, 5, 6, 7], preferred_time: "19:00", duration_min: 20, reminders_enabled: true, timezone: "Asia/Tashkent" },
  onboarding_completed_at: "2026-11-10T08:00:00Z", updated_at: "2026-11-10T08:00:00Z", version: 1,
};
function appSession(kid: boolean): SessionResponse {
  const learner = { learner_id: ME, kind: kid ? ("child" as const) : ("self" as const), display_name: "Азиз", age_band: kid ? ("6-9" as const) : ("18+" as const), is_active: true, onboarding_completed: true, voice_consent: false };
  return {
    access_token: "acc", expires_in: 900, refresh_token: "ref",
    account: { user_id: ME, display_name: "Азиз", username: null, locale: "ru", status: "ACTIVE", is_new: false, age_band: "18+", guardian_consent: "not_required" },
    learner, learners: [learner],
    security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null, pin_reset_effective_at: null },
    consent: { accepted: true, policy_version: "1.2", current_policy_version: "1.2", accepted_at: "2026-11-10T08:00:00Z", evidence_hash: "x", purposes: ["terms", "privacy", "learning"] },
    onboarding_completed: true, start_param: null,
  };
}

let navRef: Nav | null = null;
/** Renders the top of the stack like App.tsx (the screens under test) or the given ui. */
function Shell({ server, kid, children, stack }: { server: ReturnType<typeof fakeServer>; kid?: boolean; children?: ReactNode; stack?: Pushed[] }) {
  const [plan, setPlan] = useState<LearningPlan>(PLAN);
  const nav = useNav({ tab: "lessons", stack: stack ?? [] });
  navRef = nav;
  const ctx: AppCtx = {
    bff: server.bff, session: appSession(!!kid), applySession: async () => undefined, syncProfile: () => undefined, patchSession: () => undefined,
    plan, setPlan, reloadPlan: async () => plan, config: FALLBACK_CONFIG, nav, unread: 0, setUnread: () => undefined, refreshUnread: () => undefined,
    openLink: () => undefined, endSession: () => undefined, deviceTz: "Asia/Tashkent", online: true,
  };
  const top = nav.top;
  return (
    <AppProvider value={ctx}>
      <div className="app" data-learner={kid ? "child" : "self"}>
        {top?.name === "player" ? <LessonPlayer key={top.sessionId} sessionId={top.sessionId} /> : null}
        {top?.name === "lessonSummary" ? <LessonSummaryScreen key={top.sessionId} sessionId={top.sessionId} initial={top.summary} /> : null}
        {top?.name === "lessonCard" ? <LessonCardScreen id={top.id} /> : null}
        {top?.name === "appeal" ? <AppealScreen evaluationId={top.evaluationId} title={top.title} /> : null}
        {children}
        <PopupHost />
        <ToastHost />
      </div>
    </AppProvider>
  );
}
function mount(o: Parameters<typeof fakeServer>[0] & { stack?: Pushed[]; lang?: "ru" | "uz" } = {}) {
  const server = fakeServer(o);
  render(
    <I18nProvider initial={o.lang ?? "ru"}>
      <Shell server={server} kid={o.kid} stack={o.stack} />
    </I18nProvider>,
  );
  return server;
}

async function startLesson(server: ReturnType<typeof fakeServer>, kid = false): Promise<string> {
  const s = server.engine.handle("POST", `/v1/lessons/${kid ? "l-k-01-animals" : "l-a1-03-cafe"}/sessions`, new URLSearchParams(), {}, { "idempotency-key": crypto.randomUUID() }, { owner: ME, kids: kid });
  return (s!.body as LessonSession).session_id;
}

beforeEach(() => {
  navRef = null;
  playerMarker.clear();
});
afterEach(() => {
  playerMarker.clear();
});

describe("the lesson player", () => {
  it("retrieval with feedback → explanation with «проще» (position kept) → meaning check → roleplay chat → check without hints → done → summary", async () => {
    const pre = fakeServer();
    const id = await startLesson(pre);
    const server = pre;
    render(
      <I18nProvider initial="ru">
        <Shell server={server} stack={[{ name: "lessonCard", id: "l-a1-03-cafe" }, { name: "player", sessionId: id }]} />
      </I18nProvider>,
    );
    expect(playerMarker.get()).toBe(id);
    // 1. retrieval: choice with immediate feedback and the right answer
    expect(await screen.findByTestId("pl-item-single_choice")).toBeInTheDocument();
    expect(screen.getByTestId("pl-stage")).toHaveTextContent("Повторение");
    expect(screen.getByTestId("pl-stage-of")).toHaveTextContent("этап 1 из 5 · шаг 1 из 2");
    await userEvent.click(screen.getByTestId("pl-opt-1"));
    await userEvent.click(screen.getByTestId("pl-answer"));
    expect(await screen.findByTestId("pl-feedback")).toHaveTextContent("Пока неверно");
    expect(screen.getByTestId("pl-right-answer")).toHaveTextContent("Правильно: счёт");
    await userEvent.click(screen.getByTestId("pl-next"));
    // 2. word order by taps, with a hint (marked as counted)
    expect(await screen.findByTestId("pl-item-order_words")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("pl-hint-btn"));
    expect(await screen.findByTestId("pl-hint")).toHaveTextContent("Подсказка учитывается");
    for (const w of [1, 3, 4, 0, 2]) await userEvent.click(screen.getByTestId(`ow-word-${w}`));
    await userEvent.click(screen.getByTestId("pl-answer"));
    expect(await screen.findByTestId("pl-feedback")).toHaveTextContent("Верно!");
    await userEvent.click(screen.getByTestId("pl-next"));
    // 3. explanation: examples with the translation on tap, «Объясни проще» — the step does not change
    expect(await screen.findByTestId("pl-explanation")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("pl-ex-1"));
    expect(screen.getByTestId("pl-ex-gloss-1")).toHaveTextContent("Можно мне воды?");
    await userEvent.click(screen.getByTestId("pl-simpler"));
    expect(await screen.findByTestId("pl-simpler-card")).toHaveTextContent("I’d like a tea.");
    expect(screen.getByTestId("pl-explanation")).toBeInTheDocument();
    expect(server.callsTo(/\/current$/)).toHaveLength(1);
    expect(server.callsTo(/\/simpler$/)[0]!.search).toBe("?locale=ru"); // the learner's language of the explanation
    await userEvent.click(screen.getByTestId("pl-next"));
    // 4. meaning check
    await userEvent.click(await screen.findByTestId("pl-opt-0"));
    await userEvent.click(screen.getByTestId("pl-answer"));
    await userEvent.click(await screen.findByTestId("pl-next"));
    // 5. roleplay: the character's bubble (listen, translate), choices and a text field (adult, AI on)
    expect(await screen.findByTestId("pl-roleplay")).toBeInTheDocument();
    expect(screen.getByTestId("rp-ch")).toHaveTextContent("Tom · Официант");
    await userEvent.click(screen.getByTestId("rp-translate"));
    expect(screen.getByTestId("rp-gloss")).toHaveTextContent("Привет! Что вам принести?");
    expect(screen.getByTestId("rp-input")).toBeInTheDocument();
    // an unclear answer → the character clarifies, still the same node
    await userEvent.type(screen.getByTestId("rp-input"), "blue sky");
    await userEvent.click(screen.getByTestId("rp-send"));
    expect(await screen.findByTestId("rp-clarify")).toHaveTextContent("Sorry, what would you like to drink?");
    expect(screen.getByTestId("rp-input")).toHaveValue("");
    await userEvent.type(screen.getByTestId("rp-input"), "I want a latte");
    await userEvent.click(screen.getByTestId("rp-send"));
    await waitFor(() => expect(screen.getAllByTestId("rp-ch").at(-1)).toHaveTextContent("Sure! Anything else?"));
    await userEvent.click(screen.getByTestId("rp-choice-c3"));
    expect(await screen.findByTestId("pl-outcome")).toHaveTextContent("Задача выполнена");
    await userEvent.click(screen.getByTestId("pl-next"));
    // 6. check without hints: no hint, no correctness, «Ответ принят»
    expect(await screen.findByTestId("pl-graded")).toBeInTheDocument();
    expect(screen.queryByTestId("pl-hint-btn")).toBeNull();
    await userEvent.type(screen.getByTestId("pl-gap-input"), "likes");
    await userEvent.click(screen.getByTestId("pl-answer"));
    expect(await screen.findByTestId("toast")).toHaveTextContent("Ответ принят");
    expect(screen.queryByTestId("pl-feedback")).toBeNull();
    await userEvent.click(await screen.findByTestId("pl-opt-0"));
    await userEvent.click(screen.getByTestId("pl-answer"));
    // 7. open answer (adult, AI on)
    await userEvent.type(await screen.findByTestId("pl-open-input"), "I'd like a coffee to go and the bill.");
    await userEvent.click(screen.getByTestId("pl-open-send"));
    // 8. done → summary replaces the player
    await userEvent.click(await screen.findByTestId("pl-finish"));
    await waitFor(() => expect(navRef!.top?.name).toBe("lessonSummary"));
    expect(navRef!.stack.map((p) => p.name)).toEqual(["lessonCard", "lessonSummary"]);
    expect(playerMarker.get()).toBeNull();
    expect(await screen.findByTestId("sm-not-cefr")).toHaveTextContent("Это не сертификат CEFR");
    expect(screen.getByTestId("sm-errors")).toHaveTextContent("I want a latte");
    expect(screen.getByTestId("sm-errors")).toHaveTextContent("лучше: I’d like a latte");
    expect(screen.getByTestId("sm-item-a-gap")).toHaveTextContent("likes");
    expect(screen.getByTestId("sm-item-a-gap")).toHaveTextContent("Верно");
    expect(screen.queryByTestId("sm-item-a-trans")).toBeNull();
    expect(screen.getByTestId("sm-score-pronunciation")).toHaveTextContent("не оценивалось в этом формате");
    // the open answer went as text; the lesson was finished once
    expect(server.callsTo(/\/steps\/s\d+$/).at(-1)!.body).toEqual({ text: "I'd like a coffee to go and the bill." });
    expect(server.callsTo(/\/finish$/)).toHaveLength(1);
  }, 30_000);

  it("a lost answer: «Отправить ещё раз» re-sends the same answer, the server answers it the same way (no second step)", async () => {
    const server = fakeServer({ failOnce: { "POST /v1/sessions/*/steps/*": "network" } });
    const id = await startLesson(server);
    render(
      <I18nProvider initial="ru">
        <Shell server={server} stack={[{ name: "player", sessionId: id }]} />
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByTestId("pl-opt-0"));
    await userEvent.click(screen.getByTestId("pl-answer"));
    expect(await screen.findByTestId("pl-send-failed")).toHaveTextContent("Ответ не отправился");
    await userEvent.click(screen.getByTestId("pl-resend"));
    expect(await screen.findByTestId("pl-feedback")).toHaveTextContent("Верно!");
    const posts = server.callsTo(/\/steps\/s1$/);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    await userEvent.click(screen.getByTestId("pl-next"));
    expect(await screen.findByTestId("pl-item-order_words")).toBeInTheDocument();
  });

  it("pause from the menu → the paused screen; «Продолжить» → the same step; re-entry continues by GET current", async () => {
    const server = fakeServer();
    const id = await startLesson(server);
    render(
      <I18nProvider initial="ru">
        <Shell server={server} stack={[{ name: "player", sessionId: id }]} />
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByTestId("pl-opt-0"));
    await userEvent.click(screen.getByTestId("pl-answer"));
    await userEvent.click(await screen.findByTestId("pl-next"));
    expect(await screen.findByTestId("pl-item-order_words")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("pl-menu"));
    await userEvent.click(within(screen.getByTestId("pl-menu-sheet")).getByTestId("pl-pause"));
    expect(await screen.findByTestId("pl-paused")).toHaveTextContent("Урок на паузе");
    expect(server.engine.runs.get(id)!.view.status).toBe("paused");
    await userEvent.click(screen.getByTestId("pl-resume"));
    expect(await screen.findByTestId("pl-item-order_words")).toBeInTheDocument();
    expect(server.engine.runs.get(id)!.view.status).toBe("in_progress");
    // exit pauses on the server and leaves the player
    await userEvent.click(screen.getByTestId("pl-menu"));
    await userEvent.click(within(screen.getByTestId("pl-menu-sheet")).getByTestId("pl-exit"));
    await waitFor(() => expect(navRef!.stack).toEqual([]));
    expect(server.engine.runs.get(id)!.view.status).toBe("paused");
    expect(await screen.findByTestId("toast")).toHaveTextContent("Урок на паузе. Продолжите с этапа «Повторение».");
    // re-entry: GET current continues the paused session from the same step
    act(() => navRef!.push({ name: "player", sessionId: id }));
    expect(await screen.findByTestId("pl-item-order_words")).toBeInTheDocument();
    expect(server.engine.runs.get(id)!.view.status).toBe("in_progress");
  });

  it("a child: no text field in the chat (even if the server allowed it), choices only; no open answer", async () => {
    const server = fakeServer({ kid: true });
    const id = await startLesson(server, true);
    render(
      <I18nProvider initial="ru">
        <Shell server={server} kid stack={[{ name: "player", sessionId: id }]} />
      </I18nProvider>,
    );
    expect(await screen.findByTestId("pl-notice")).toHaveTextContent("Повторять пока нечего");
    await userEvent.click(screen.getByTestId("pl-next"));
    await userEvent.click(await screen.findByTestId("pl-next")); // explanation
    expect(await screen.findByTestId("pl-roleplay")).toBeInTheDocument();
    expect(screen.queryByTestId("rp-input")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("heading", { name: "Выбери ответ" })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("rp-choice-c2")); // «It's a fish!»
    await waitFor(() => expect(screen.getAllByTestId("rp-ch").at(-1)).toHaveTextContent("Hmm, look again."));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(server.callsTo(/\/steps\//).every((c) => !("text" in (c.body ?? {})))).toBe(true);
  });

  it("errors by code: STEP_NOT_CURRENT → the current step with a note; a finished session → «уже завершено»", async () => {
    const server = fakeServer({ failOnce: { "POST /v1/sessions/*/steps/*": [409, "STEP_NOT_CURRENT"] } });
    const id = await startLesson(server);
    render(
      <I18nProvider initial="ru">
        <Shell server={server} stack={[{ name: "player", sessionId: id }]} />
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByTestId("pl-opt-0"));
    await userEvent.click(screen.getByTestId("pl-answer"));
    expect(await screen.findByTestId("pl-note")).toHaveTextContent("Шаг обновился");
    expect(server.callsTo(/\/current$/)).toHaveLength(2);
    server.engine.runs.get(id)!.view.status = "cancelled";
    await userEvent.click(screen.getByTestId("pl-opt-0"));
    await userEvent.click(screen.getByTestId("pl-answer"));
    expect(await screen.findByTestId("pl-closed")).toHaveTextContent("уже завершено или отменено");
  });

  it("simplified mode (AI unavailable): a neutral plaque in the roleplay, no text field", async () => {
    const server = fakeServer({ lessons: { aiDegraded: true } });
    const s = server.engine.handle("POST", "/v1/scenarios/sc-cafe-order/sessions", new URLSearchParams(), {}, { "idempotency-key": "k" }, { owner: ME, kids: false });
    render(
      <I18nProvider initial="ru">
        <Shell server={server} stack={[{ name: "player", sessionId: (s!.body as LessonSession).session_id }]} />
      </I18nProvider>,
    );
    expect(await screen.findByTestId("pl-degraded")).toHaveTextContent("упрощённом режиме");
    expect(screen.queryByTestId("rp-input")).toBeNull();
  });
});

describe("lesson card and summary", () => {
  it("409 SESSION_ACTIVE → «Продолжить / Отменить и начать новое»: cancel starts a new one", async () => {
    const server = mount({ lessons: { active: "paused" }, stack: [{ name: "lessonCard", id: "l-opt-airport" }] });
    expect(await screen.findByTestId("lc-facts")).toHaveTextContent("Цель");
    await userEvent.click(screen.getByTestId("lc-start"));
    const sheet = await screen.findByTestId("active-session-sheet");
    expect(sheet).toHaveTextContent("«В кафе: заказ напитков» ещё не закончено");
    await userEvent.click(within(sheet).getByTestId("as-cancel-new"));
    await waitFor(() => expect(navRef!.top?.name).toBe("player"));
    const starts = server.callsTo("POST /v1/lessons/l-opt-airport/sessions");
    expect(starts).toHaveLength(2);
    expect(server.callsTo(/\/cancel$/)).toHaveLength(1);
  });

  it("an unfinished session of this lesson → «Продолжить урок» opens the player", async () => {
    mount({ lessons: { active: "paused" }, stack: [{ name: "lessonCard", id: "l-a1-03-cafe" }] });
    await userEvent.click(await screen.findByTestId("lc-continue"));
    expect(navRef!.top?.name).toBe("player");
  });

  it("summary after a corrected appeal: the actual evaluation, «Оценка исправлена» with the note; no second appeal", async () => {
    const server = fakeServer({ lessons: { decided: "corrected" } });
    const done = [...server.engine.runs.values()].find((r) => r.view.status === "completed")!;
    render(
      <I18nProvider initial="ru">
        <Shell server={server} stack={[{ name: "lessonSummary", sessionId: done.view.session_id }]} />
      </I18nProvider>,
    );
    expect(await screen.findByTestId("sm-corrected")).toHaveTextContent("исправленная оценка");
    expect(screen.getByTestId("sm-appeal-state")).toHaveTextContent("Оценка исправлена");
    expect(screen.getByTestId("sm-appeal-state")).toHaveTextContent("Комментарий методиста");
    expect(screen.queryByTestId("sm-appeal")).toBeNull();
  });

  it("appeal: the reason (≤ 500) with one Idempotency-Key per text → back to the summary with the state", async () => {
    const server = fakeServer();
    const id = await startLesson(server);
    const run = server.engine.runs.get(id)!;
    // finish the lesson on the engine
    for (let i = 0; i < 30 && server.engine.current(run).type !== "done"; i++) {
      const st = server.engine.current(run);
      server.engine.answer(run, st.step_id, st.type === "item" ? { answer: 1 } : st.type === "roleplay" ? { choice_id: st.choices[0]!.choice_id } : st.type === "open_answer" ? { text: "I want coffee" } : {});
    }
    const summary = server.engine.handle("POST", `/v1/sessions/${id}/finish`, new URLSearchParams(), {}, {}, { owner: ME, kids: false })!.body;
    render(
      <I18nProvider initial="ru">
        <Shell server={server} stack={[{ name: "lessonSummary", sessionId: id, summary: summary as never }]} />
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByTestId("sm-appeal"));
    expect(await screen.findByTestId("appeal")).toHaveTextContent("В кафе: заказ напитков");
    expect(screen.getByTestId("ap-send")).toBeDisabled();
    await userEvent.type(screen.getByTestId("ap-reason"), "«I’d like» я написал правильно");
    await userEvent.click(screen.getByTestId("ap-send"));
    expect(await screen.findByTestId("sm-appeal-state")).toHaveTextContent("Апелляция подана");
    const post = server.callsTo(/\/appeal$/)[0]!;
    expect(post.body).toEqual({ reason: "«I’d like» я написал правильно" });
    expect(screen.queryByTestId("sm-appeal")).toBeNull();
  });

  it("evaluation later: «Оценка появится позже», the CEFR disclaimer, no appeal", async () => {
    const server = fakeServer({ lessons: { evaluationLater: true } });
    const id = await startLesson(server);
    const run = server.engine.runs.get(id)!;
    for (let i = 0; i < 30 && server.engine.current(run).type !== "done"; i++) {
      const st = server.engine.current(run);
      server.engine.answer(run, st.step_id, st.type === "item" ? { answer: 0 } : st.type === "roleplay" ? { choice_id: st.choices[0]!.choice_id } : st.type === "open_answer" ? { text: "ok" } : {});
    }
    server.engine.handle("POST", `/v1/sessions/${id}/finish`, new URLSearchParams(), {}, {}, { owner: ME, kids: false });
    render(
      <I18nProvider initial="uz">
        <Shell server={server} stack={[{ name: "lessonSummary", sessionId: id }]} />
      </I18nProvider>,
    );
    expect(await screen.findByTestId("sm-pending")).toHaveTextContent("Baho keyinroq chiqadi");
    expect(screen.getByTestId("sm-not-cefr")).toHaveTextContent("CEFR sertifikati emas");
    expect(screen.queryByTestId("sm-appeal")).toBeNull();
  });
});

/* ================================================================ review R2: screens */

/** Answer every step of a lesson on the engine up to «done» and finish it (the summary as the player passes it). */
function finishOnEngine(server: ReturnType<typeof fakeServer>, id: string) {
  const run = server.engine.runs.get(id)!;
  for (let i = 0; i < 30 && server.engine.current(run).type !== "done"; i++) {
    const st = server.engine.current(run);
    server.engine.answer(run, st.step_id, st.type === "item" ? { answer: 0 } : st.type === "roleplay" ? { choice_id: st.choices[0]!.choice_id } : st.type === "open_answer" ? { text: "ok" } : {});
  }
  return server.engine.handle("POST", `/v1/sessions/${id}/finish`, new URLSearchParams(), {}, {}, { owner: ME, kids: false })!.body as LessonSummary;
}

function renderAt(server: ReturnType<typeof fakeServer>, stack: Pushed[], lang: "ru" | "uz" = "ru") {
  return render(
    <I18nProvider initial={lang}>
      <Shell server={server} stack={stack} />
    </I18nProvider>,
  );
}

describe("R2-02: the answer did not come back — no network ≠ the service is slow", () => {
  it("503 after the domain saved the answer: «сервис отвечает долго», «Отправить ещё раз» re-sends the same answer, no second step", async () => {
    const server = fakeServer({ failOnce: { "POST /v1/sessions/*/steps/*": { late: [503, "UPSTREAM_UNAVAILABLE"] } } });
    const id = await startLesson(server);
    renderAt(server, [{ name: "player", sessionId: id }]);
    await userEvent.click(await screen.findByTestId("pl-opt-0"));
    await userEvent.click(screen.getByTestId("pl-answer"));
    const failed = await screen.findByTestId("pl-send-failed");
    expect(failed).toHaveAttribute("data-reason", "service");
    expect(failed).toHaveTextContent("Сервис отвечает долго или временно недоступен");
    expect(failed).toHaveTextContent("Ответ мог уже сохраниться");
    expect(failed).not.toHaveTextContent("нет связи");
    await userEvent.click(screen.getByTestId("pl-resend"));
    expect(await screen.findByTestId("pl-feedback")).toHaveTextContent("Верно!");
    const posts = server.callsTo(/\/steps\/s1$/);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    await userEvent.click(screen.getByTestId("pl-next"));
    expect(await screen.findByTestId("pl-item-order_words")).toBeInTheDocument();
    expect(screen.getByTestId("pl-stage-of")).toHaveTextContent("шаг 2 из 2");
  });

  it("504 of the edge — the same «сервис» text; no network — «нет связи» (UZ: different texts too)", async () => {
    const server = fakeServer({ failOnce: { "POST /v1/sessions/*/steps/*": { late: [504, "SERVICE_UNAVAILABLE"] } } });
    const id = await startLesson(server);
    renderAt(server, [{ name: "player", sessionId: id }], "uz");
    await userEvent.click(await screen.findByTestId("pl-opt-0"));
    await userEvent.click(screen.getByTestId("pl-answer"));
    const slow = await screen.findByTestId("pl-send-failed");
    expect(slow).toHaveAttribute("data-reason", "service");
    expect(slow).toHaveTextContent("Xizmat sekin javob bermoqda");
    expect(screen.getByTestId("pl-resend")).toHaveTextContent("Yana yuborish");
    await userEvent.click(screen.getByTestId("pl-resend"));
    await userEvent.click(await screen.findByTestId("pl-next"));
    // the next answer is lost on the network
    const net = fakeServer({ failOnce: { "POST /v1/sessions/*/steps/*": "network" } });
    const id2 = await startLesson(net);
    cleanupRender();
    renderAt(net, [{ name: "player", sessionId: id2 }], "uz");
    await userEvent.click(await screen.findByTestId("pl-opt-0"));
    await userEvent.click(screen.getByTestId("pl-answer"));
    const off = await screen.findByTestId("pl-send-failed");
    expect(off).toHaveAttribute("data-reason", "network");
    expect(off).toHaveTextContent("aloqa yoʻq");
    expect(off).not.toHaveTextContent("Xizmat sekin");
  });
});

describe("R2-03: «оценка появится позже» on the summary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("no promise of a Telegram message; re-read while the screen is open → the evaluation appears", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = fakeServer({ lessons: { evaluationLater: true, evaluationAfterReads: 2 } });
    const id = await startLesson(server);
    const summary = finishOnEngine(server, id);
    expect(summary.evaluation).toBeNull();
    renderAt(server, [{ name: "lessonSummary", sessionId: id, summary }]);
    const pending = await screen.findByTestId("sm-pending");
    expect(pending).toHaveTextContent("Оценка появится позже — пока этот экран открыт, мы проверяем её сами");
    expect(pending).not.toHaveTextContent("Telegram");
    expect(screen.getByTestId("sm-refresh")).toHaveTextContent("Проверить оценку");
    expect(server.callsTo(/\/summary$/)).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(server.callsTo(/\/summary$/)).toHaveLength(1);
    expect(screen.getByTestId("sm-pending")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(server.callsTo(/\/summary$/)).toHaveLength(2);
    await waitFor(() => expect(screen.queryByTestId("sm-pending")).toBeNull());
    expect(await screen.findByTestId("sm-scores")).toBeInTheDocument();
    expect(screen.getByTestId("sm-appeal")).toBeInTheDocument();
    // the evaluation is there: no more reads
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(server.callsTo(/\/summary$/)).toHaveLength(2);
  });

  it("6 attempts, then «Проверить оценку» only; leaving the summary stops the reads (UZ without «Telegram»)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = fakeServer({ lessons: { evaluationLater: true } });
    const id = await startLesson(server);
    const summary = finishOnEngine(server, id);
    renderAt(server, [{ name: "lessonSummary", sessionId: id, summary }], "uz");
    expect(await screen.findByTestId("sm-pending")).not.toHaveTextContent("Telegram");
    await act(() => vi.advanceTimersByTimeAsync(EVAL_POLL_DELAYS_MS.reduce((a, b) => a + b, 0)));
    expect(server.callsTo(/\/summary$/)).toHaveLength(6);
    await waitFor(() => expect(screen.getByTestId("sm-pending")).toHaveTextContent("«Bahoni tekshirish»ni bosing"));
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(server.callsTo(/\/summary$/)).toHaveLength(6);
    // the button stays and re-reads at once
    await act(async () => screen.getByTestId("sm-refresh").click());
    await waitFor(() => expect(server.callsTo(/\/summary$/)).toHaveLength(7));

    // a new summary screen polls again — until it is closed
    cleanupRender();
    const again = fakeServer({ lessons: { evaluationLater: true } });
    const id2 = await startLesson(again);
    const s2 = finishOnEngine(again, id2);
    renderAt(again, [{ name: "lessonCard", id: "l-a1-03-cafe" }, { name: "lessonSummary", sessionId: id2, summary: s2 }]);
    await screen.findByTestId("sm-pending");
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(again.callsTo(/\/summary$/)).toHaveLength(1);
    act(() => navRef!.back());
    expect(await screen.findByTestId("lesson-card")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(again.callsTo(/\/summary$/)).toHaveLength(1);
  });
});

describe("R2-04: «Оспорить оценку» only within 14 days of the evaluation", () => {
  it("evaluated 15 days ago: no button, a short note (RU and UZ)", async () => {
    const server = fakeServer({ lessons: { evaluatedDaysAgo: 15 } });
    const done = [...server.engine.runs.values()].find((r) => r.view.status === "completed")!;
    renderAt(server, [{ name: "lessonSummary", sessionId: done.view.session_id }]);
    expect(await screen.findByTestId("sm-appeal-closed")).toHaveTextContent("Оспорить оценку можно в течение 14 дней — этот срок уже прошёл.");
    expect(screen.queryByTestId("sm-appeal")).toBeNull();
    expect(screen.getByTestId("sm-scores")).toBeInTheDocument();
    cleanupRender();
    renderAt(server, [{ name: "lessonSummary", sessionId: done.view.session_id }], "uz");
    expect(await screen.findByTestId("sm-appeal-closed")).toHaveTextContent("14 kun ichida");
  });

  it("evaluated 13 days ago: the button is there, no note", async () => {
    const server = fakeServer({ lessons: { evaluatedDaysAgo: 13 } });
    const done = [...server.engine.runs.values()].find((r) => r.view.status === "completed")!;
    renderAt(server, [{ name: "lessonSummary", sessionId: done.view.session_id }]);
    expect(await screen.findByTestId("sm-appeal")).toHaveTextContent("Оспорить оценку");
    expect(screen.queryByTestId("sm-appeal-closed")).toBeNull();
  });
});

describe("R2-05 and the AI off at the start: the plaque of the simplified mode", () => {
  it("the AI goes away on a free text in the roleplay: the session is re-read, the plaque appears without a reload", async () => {
    const server = fakeServer({ lessons: { aiDropsOnText: true } });
    const s = server.engine.handle("POST", "/v1/scenarios/sc-cafe-order/sessions", new URLSearchParams(), {}, { "idempotency-key": "k" }, { owner: ME, kids: false });
    const id = (s!.body as LessonSession).session_id;
    renderAt(server, [{ name: "player", sessionId: id }]);
    await userEvent.type(await screen.findByTestId("rp-input"), "A latte, please");
    expect(screen.queryByTestId("pl-degraded")).toBeNull();
    expect(server.callsTo(`GET /v1/sessions/${id}`)).toHaveLength(1);
    await userEvent.click(screen.getByTestId("rp-send"));
    expect(await screen.findByTestId("rp-clarify")).toHaveTextContent("Let's choose an answer.");
    expect(await screen.findByTestId("pl-degraded")).toHaveTextContent("упрощённом режиме");
    expect(screen.queryByTestId("rp-input")).toBeNull();
    expect(server.callsTo(`GET /v1/sessions/${id}`)).toHaveLength(2);
    expect(server.callsTo(/\/current$/)).toHaveLength(1); // no reload of the step
    // the scene goes on by choices, the plaque stays
    await userEvent.click(screen.getByTestId("rp-choice-c1"));
    await waitFor(() => expect(screen.getAllByTestId("rp-ch").at(-1)).toHaveTextContent("Sure! Anything else?"));
    expect(screen.getByTestId("pl-degraded")).toBeInTheDocument();
    expect(server.callsTo(`GET /v1/sessions/${id}`)).toHaveLength(2);
  });

  it("an unclear answer with the AI on: the free text stays, the session is not re-read", async () => {
    const server = fakeServer();
    const s = server.engine.handle("POST", "/v1/scenarios/sc-cafe-order/sessions", new URLSearchParams(), {}, { "idempotency-key": "k" }, { owner: ME, kids: false });
    const id = (s!.body as LessonSession).session_id;
    renderAt(server, [{ name: "player", sessionId: id }]);
    await userEvent.type(await screen.findByTestId("rp-input"), "blue sky");
    await userEvent.click(screen.getByTestId("rp-send"));
    expect(await screen.findByTestId("rp-clarify")).toBeInTheDocument();
    expect(screen.getByTestId("rp-input")).toBeInTheDocument();
    expect(screen.queryByTestId("pl-degraded")).toBeNull();
    expect(server.callsTo(`GET /v1/sessions/${id}`)).toHaveLength(1);
  });

  it("the AI off from the start (ai_mode choices, ai_degraded): the plaque from the first step of the lesson, not on «done»", async () => {
    const server = fakeServer({ lessons: { aiDegraded: true } });
    const id = await startLesson(server);
    const view = server.engine.runs.get(id)!.view;
    expect([view.ai_mode, view.ai_degraded]).toEqual(["choices", true]);
    renderAt(server, [{ name: "player", sessionId: id }]);
    expect(await screen.findByTestId("pl-item-single_choice")).toBeInTheDocument();
    expect(screen.getByTestId("pl-degraded")).toHaveTextContent("Сейчас занятие идёт в упрощённом режиме");
    expect(screen.getByTestId("pl-stage")).toHaveTextContent("Повторение");
    // to «done» on the engine, then re-enter: no plaque on the last screen
    const run = server.engine.runs.get(id)!;
    for (let i = 0; i < 30 && server.engine.current(run).type !== "done"; i++) {
      const st = server.engine.current(run);
      server.engine.answer(run, st.step_id, st.type === "item" ? { answer: 0 } : st.type === "roleplay" ? { choice_id: st.choices[0]!.choice_id } : {});
    }
    cleanupRender();
    renderAt(server, [{ name: "player", sessionId: id }]);
    expect(await screen.findByTestId("pl-done")).toBeInTheDocument();
    expect(screen.queryByTestId("pl-degraded")).toBeNull();
  });

  it("the lesson card does not promise «свой ответ»: neutral for an adult, choices for a child (RU / UZ)", async () => {
    mount({ stack: [{ name: "lessonCard", id: "l-a1-03-cafe" }] });
    const f = await screen.findByTestId("lc-format");
    expect(f).toHaveTextContent("выбор готовых реплик; свой ответ — если доступен ИИ");
    expect(f).not.toHaveTextContent(/свой ответ или/);
    expect(screen.getByTestId("lc-stage-roleplay")).toBeInTheDocument();
    cleanupRender();
    mount({ kid: true, stack: [{ name: "lessonCard", id: "l-k-01-animals" }] });
    expect(await screen.findByTestId("lc-format")).toHaveTextContent("выбор готовых реплик");
    expect(screen.getByTestId("lc-format")).not.toHaveTextContent("свой ответ");
    cleanupRender();
    mount({ lang: "uz", stack: [{ name: "lessonCard", id: "l-a1-03-cafe" }] });
    expect(await screen.findByTestId("lc-format")).toHaveTextContent("SI ishlayotgan boʻlsa");
  });
});

/* ================================================================ coordinator follow-ups */

describe("409 AI_BUSY: the same answer again in 2 s, at most 3 times", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("retryAiBusy: busy twice → the third call answers; busy 4 times → the 4th AI_BUSY is thrown; another error at once", async () => {
    vi.useFakeTimers();
    expect([AI_BUSY_RETRY_MS, AI_BUSY_RETRIES]).toEqual([2_000, 3]);
    const busy = () => new ApiError(409, "AI_BUSY", "");
    let n = 0;
    const onBusy = vi.fn();
    const p = retryAiBusy(async () => {
      n += 1;
      if (n <= 2) throw busy();
      return "ok";
    }, { onBusy });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(n).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBe("ok");
    expect([n, onBusy.mock.calls.length]).toEqual([3, 2]);

    let m = 0;
    const q = retryAiBusy(async () => {
      m += 1;
      throw busy();
    }).catch((e: ApiError) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await q).toMatchObject({ code: "AI_BUSY" });
    expect(m).toBe(4); // the first call + 3 repeats

    let k = 0;
    const r = retryAiBusy(async () => {
      k += 1;
      throw new ApiError(409, "STEP_NOT_CURRENT", "");
    }).catch((e: ApiError) => e.code);
    expect(await r).toBe("STEP_NOT_CURRENT");
    expect(k).toBe(1);
    // the screen is gone: no more waiting
    let j = 0;
    const gone = retryAiBusy(async () => {
      j += 1;
      throw busy();
    }, { alive: () => j < 2 }).catch((e: ApiError) => e.code);
    await vi.advanceTimersByTimeAsync(10_000);
    expect([await gone, j]).toEqual(["AI_BUSY", 2]);
  });

  it("still busy after the repeats: the answer stays for «Отправить ещё раз» with its own text", () => {
    expect(isRetryable(new ApiError(409, "AI_BUSY", ""))).toBe(true);
    expect(sendFailure(new ApiError(409, "AI_BUSY", ""))).toBe("busy");
  });

  it("a free text in the roleplay: «Секунду, ответ ещё обрабатывается», the same answer twice more → the reply", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = fakeServer({ lessons: { aiBusy: 2 } });
    const s = server.engine.handle("POST", "/v1/scenarios/sc-cafe-order/sessions", new URLSearchParams(), {}, { "idempotency-key": "k" }, { owner: ME, kids: false });
    const id = (s!.body as LessonSession).session_id;
    renderAt(server, [{ name: "player", sessionId: id }]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(await screen.findByTestId("rp-input"), "I'd like a latte, please");
    await user.click(screen.getByTestId("rp-send"));
    expect(await screen.findByTestId("pl-busy")).toHaveTextContent("Секунду, ответ ещё обрабатывается");
    expect(server.callsTo(/\/steps\/s1$/)).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(server.callsTo(/\/steps\/s1$/)).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await waitFor(() => expect(screen.getAllByTestId("rp-ch").at(-1)).toHaveTextContent("Sure! Anything else?"));
    const posts = server.callsTo(/\/steps\/s1$/);
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((p) => JSON.stringify(p.body)))).toEqual(new Set([JSON.stringify({ text: "I'd like a latte, please" })]));
    expect(screen.queryByTestId("pl-busy")).toBeNull();
  });

  it("busy 5 times: after 3 repeats — «Отправить ещё раз» (busy text, UZ), the same answer goes through later", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = fakeServer({ lessons: { aiBusy: 5 } });
    const s = server.engine.handle("POST", "/v1/scenarios/sc-cafe-order/sessions", new URLSearchParams(), {}, { "idempotency-key": "k" }, { owner: ME, kids: false });
    const id = (s!.body as LessonSession).session_id;
    renderAt(server, [{ name: "player", sessionId: id }], "uz");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(await screen.findByTestId("rp-input"), "A latte, please");
    await user.click(screen.getByTestId("rp-send"));
    expect(await screen.findByTestId("pl-busy")).toHaveTextContent("Bir soniya, javob hali qayta ishlanmoqda");
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    const failed = await screen.findByTestId("pl-send-failed");
    expect(failed).toHaveAttribute("data-reason", "busy");
    expect(failed).toHaveTextContent("Javob hali qayta ishlanmoqda");
    expect(server.callsTo(/\/steps\/s1$/)).toHaveLength(4);
    expect(screen.getByTestId("rp-input")).toHaveValue("A latte, please"); // the text is kept for the repeat
    await user.click(screen.getByTestId("pl-resend"));
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await waitFor(() => expect(screen.getAllByTestId("rp-ch").at(-1)).toHaveTextContent("Sure! Anything else?"));
    expect(server.callsTo(/\/steps\/s1$/)).toHaveLength(6);
  });

  it("«Объясни проще»: AI_BUSY once → the same request in 2 s → the explanation; the step does not change", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = fakeServer({ lessons: { aiBusy: 1 } });
    const id = await startLesson(server);
    const run = server.engine.runs.get(id)!;
    while (server.engine.current(run).type !== "explanation") server.engine.answer(run, server.engine.current(run).step_id, { answer: 0 });
    renderAt(server, [{ name: "player", sessionId: id }]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByTestId("pl-simpler"));
    expect(await screen.findByTestId("pl-busy")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(await screen.findByTestId("pl-simpler-card")).toHaveTextContent("I’d like a tea.");
    expect(server.callsTo(/\/simpler$/)).toHaveLength(2);
    expect(screen.queryByTestId("pl-busy")).toBeNull();
    expect(screen.getByTestId("pl-explanation")).toBeInTheDocument();
  });
});

describe("texts erased by retention (90 days): the appeal reason and the error fragments", () => {
  it("error types: the evaluator's closed list and the closed items; anything else — «другая ошибка»", () => {
    expect(errorType("missing_be")).toBe("missing_be");
    expect(errorType("line_order")).toBe("line_order");
    expect(errorType("politeness")).toBe("other");
    expect(errorRedacted({ evidence: "", correction: "" })).toBe(true);
    expect(errorRedacted({ evidence: " ", correction: "" })).toBe(true);
    expect(errorRedacted({ evidence: "I want", correction: "" })).toBe(false);
  });

  it("decided 100 days ago: «текст удалён по сроку хранения», the errors show only their type (RU / UZ)", async () => {
    const server = fakeServer({ lessons: { decided: "upheld", decidedDaysAgo: 100 } });
    const done = [...server.engine.runs.values()].find((r) => r.view.status === "completed")!;
    renderAt(server, [{ name: "lessonSummary", sessionId: done.view.session_id }]);
    const reason = await screen.findByTestId("sm-appeal-reason");
    expect(reason).toHaveAttribute("data-redacted", "true");
    expect(reason).toHaveTextContent("Текст апелляции удалён по сроку хранения.");
    const errors = screen.getAllByTestId("sm-error");
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(e).toHaveAttribute("data-redacted", "true");
      expect(e).not.toHaveTextContent("Ваш вариант");
      expect(e).not.toHaveTextContent("лучше:");
    }
    expect(screen.getAllByTestId("sm-error-type").map((x) => x.textContent)).toEqual(["выбор слова", "пропущенное слово"]);
    cleanupRender();
    renderAt(server, [{ name: "lessonSummary", sessionId: done.view.session_id }], "uz");
    expect(await screen.findByTestId("sm-appeal-reason")).toHaveTextContent("saqlash muddati tugagani uchun oʻchirildi");
    expect(screen.getAllByTestId("sm-error-type")[0]).toHaveTextContent("soʻz tanlash");
  });

  it("a fresh appeal shows the learner's reason; the errors keep «your fragment → better»", async () => {
    const server = fakeServer({ lessons: { decided: "upheld" } });
    const done = [...server.engine.runs.values()].find((r) => r.view.status === "completed")!;
    renderAt(server, [{ name: "lessonSummary", sessionId: done.view.session_id }]);
    expect(await screen.findByTestId("sm-appeal-reason")).toHaveTextContent("Ваша причина: Я написал «I’d like», а не «I want».");
    expect(screen.getAllByTestId("sm-error")[0]).toHaveTextContent("Ваш вариант");
    expect(screen.queryByTestId("sm-error-type")).toBeNull();
  });
});

describe("the lesson card by roleplay_mode (lessons knows the AI is off now)", () => {
  it("AI off → «выбор готовых реплик» without «свой ответ»; AI on → the neutral wording", async () => {
    mount({ lessons: { aiDegraded: true }, stack: [{ name: "lessonCard", id: "l-a1-03-cafe" }] });
    expect(await screen.findByTestId("lc-format")).toHaveTextContent("выбор готовых реплик");
    expect(screen.getByTestId("lc-format")).not.toHaveTextContent("свой ответ");
    cleanupRender();
    mount({ stack: [{ name: "lessonCard", id: "l-a1-03-cafe" }] });
    expect(await screen.findByTestId("lc-format")).toHaveTextContent("выбор готовых реплик; свой ответ — если доступен ИИ");
  });
});
