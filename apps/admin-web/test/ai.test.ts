import { describe, expect, it } from "vitest";
import type { SessionCard } from "@tilhero/contracts/admin";
import type { AgentVersion, GoldenCheck } from "@tilhero/contracts/ai";
import { translate } from "../src/i18n";
import {
  CALL_REASONS,
  buildCheck, budgetLevel, capPct, checkBudget, checkContextJson, checkForm, checkLine, checkOutputSchema, collapseDiff, diffStats, draftOf,
  emptyCheck, formOf, isOutputPath, lineDiff, mergeBudgetForm, niceMax, parseValueList, patchOf, PATH_RE, publishGate, scrubPii, speechHourPrice, speechHours, taskFileName,
  taskMarkdown, usd,
} from "../src/screens/ai/model";

/* ---------------------------------------------------------------- line diff */

describe("line diff of an agent version (own LCS)", () => {
  it("keeps common lines, marks removed before added inside a changed block", () => {
    const d = lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne");
    expect(d.map((x) => `${x.op}:${x.text}`)).toEqual(["eq:a", "del:b", "add:B", "eq:c", "eq:d", "add:e"]);
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
    // line numbers of both sides
    expect(d.find((x) => x.op === "add" && x.text === "e")).toMatchObject({ a: null, b: 5 });
    expect(d.find((x) => x.op === "del")).toMatchObject({ a: 2, b: null });
  });
  it("is minimal on moved blocks and handles empty texts and CRLF", () => {
    expect(lineDiff("", "").length).toBe(0);
    expect(lineDiff("", "x\ny").map((x) => x.op)).toEqual(["add", "add"]);
    expect(lineDiff("x\r\ny", "x\ny").every((x) => x.op === "eq")).toBe(true);
    const d = lineDiff("1\n2\n3\n4\n5", "1\n3\n4\n2\n5");
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
  });
  it("applying the diff gives the new text; big unrelated texts fall back without blowing up", () => {
    const a = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 7", "line seven").replace("line 250", "line 250\nextra");
    const d = lineDiff(a, b);
    expect(d.filter((x) => x.op !== "del").map((x) => x.text).join("\n")).toBe(b);
    expect(d.filter((x) => x.op !== "add").map((x) => x.text).join("\n")).toBe(a);
    const big1 = Array.from({ length: 2500 }, (_, i) => `a${i}`).join("\n");
    const big2 = Array.from({ length: 2500 }, (_, i) => `b${i}`).join("\n");
    expect(diffStats(lineDiff(big1, big2))).toEqual({ added: 2500, removed: 2500 });
  });
  it("collapses long unchanged runs with context", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const rows = collapseDiff(lineDiff(a, a.replace("l10", "L10")), 2);
    expect(rows[0]).toEqual({ op: "skip", n: 8 });
    expect(rows.filter((r) => r.op !== "skip")).toHaveLength(6); // 2 + del + add + 2
    expect(rows.at(-1)).toEqual({ op: "skip", n: 7 });
  });
});

/* ---------------------------------------------------------------- golden check builder */

describe("golden check builder (ai.ts GoldenCheck)", () => {
  it("paths start at the root of AgentInvokeResult; array indexes are dot segments", () => {
    for (const p of ["status", "reason", "output.intent", "output.confirmed_errors.0.evidence"]) expect(PATH_RE.test(p), p).toBe(true);
    for (const p of ["output intent", "output.", ".x", "output[0]", "1abc"]) expect(PATH_RE.test(p), p).toBe(false);
    expect(isOutputPath("output.intent")).toBe(true);
    expect(isOutputPath("status")).toBe(false);
  });
  it("builds every kind with typed values and reports field issues", () => {
    expect(buildCheck(emptyCheck("schema_valid"))).toEqual({ check: { kind: "schema_valid" }, issues: [] });
    expect(buildCheck({ ...emptyCheck("field_equals"), path: "output.hint_offered", valueType: "boolean", value: "true" }).check).toEqual({ kind: "field_equals", path: "output.hint_offered", value: true });
    expect(buildCheck({ ...emptyCheck("field_equals"), path: "status", valueType: "string", value: "refused" }).check).toEqual({ kind: "field_equals", path: "status", value: "refused" });
    expect(buildCheck({ ...emptyCheck("field_equals"), path: "output.n", valueType: "number", value: "1.5" }).check).toEqual({ kind: "field_equals", path: "output.n", value: 1.5 });
    expect(buildCheck({ ...emptyCheck("field_equals"), path: "output.n", valueType: "null" }).check).toEqual({ kind: "field_equals", path: "output.n", value: null });
    expect(buildCheck({ ...emptyCheck("field_equals"), path: "output.n", valueType: "number", value: "x" }).issues).toEqual([{ field: "value", code: "format" }]);
    expect(buildCheck({ ...emptyCheck("field_in"), path: "output.intent", values: "unclear\n off_topic \n\n3\nnull\n\"true\"" }).check).toEqual({ kind: "field_in", path: "output.intent", values: ["unclear", "off_topic", 3, null, "true"] });
    expect(buildCheck({ ...emptyCheck("field_in"), path: "output.intent", values: " \n" }).issues).toEqual([{ field: "values", code: "required" }]);
    expect(buildCheck({ ...emptyCheck("text_not_contains"), path: "output.reply_en", values: "http\nwww." }).check).toEqual({ kind: "text_not_contains", path: "output.reply_en", values: ["http", "www."] });
    expect(buildCheck({ ...emptyCheck("max_length"), path: "output.reply_en", n: "240" }).check).toEqual({ kind: "max_length", path: "output.reply_en", n: 240 });
    expect(buildCheck({ ...emptyCheck("max_length"), path: "output.reply_en", n: "0" }).issues).toEqual([{ field: "n", code: "range" }]);
    expect(buildCheck({ ...emptyCheck("field_absent"), path: "" }).issues).toEqual([{ field: "path", code: "required" }]);
    expect(buildCheck({ ...emptyCheck("field_absent"), path: "output[0]" }).issues).toEqual([{ field: "path", code: "format" }]);
  });
  it("round-trips a saved check through the builder; one-line descriptions", () => {
    const checks: GoldenCheck[] = [
      { kind: "field_in", path: "output.intent", values: ["a", 1, true, null, "null"] },
      { kind: "field_equals", path: "output.hint_offered", value: false },
      { kind: "max_length", path: "output.reply_en", n: 240 },
      { kind: "text_not_contains", path: "output.reply_en", values: ["t.me"] },
    ];
    for (const c of checks) expect(buildCheck(draftOf(c)).check).toEqual(c);
    expect(parseValueList("true\nfalse")).toEqual([true, false]);
    expect(checkLine({ kind: "max_length", path: "output.reply_en", n: 240 })).toBe("|output.reply_en| ≤ 240");
    expect(checkLine({ kind: "field_in", path: "output.intent", values: ["unclear", null] })).toBe('output.intent ∈ {"unclear", null}');
  });
  it("the golden input is a JSON object; a parse error names the line", () => {
    expect(checkContextJson('{"a": 1}').value).toEqual({ a: 1 });
    expect(checkContextJson("[1]").error).toEqual({ code: "not_object" });
    expect(checkContextJson("").error).toEqual({ code: "required" });
    expect(checkContextJson('{\n  "a": 1,\n}').error).toMatchObject({ code: "json_parse", line: 3 });
  });
});

/* ---------------------------------------------------------------- version form and JSON Schema */

const V: AgentVersion = {
  agent_id: "conversation_partner",
  version: 3,
  status: "draft",
  instructions: "Stay in the node.",
  rules: "One JSON object.",
  output_schema: { type: "object", required: ["intent"], properties: { intent: { type: "string" } } },
  schema_version: "conversation_partner.v1",
  model_id: "claude-haiku-5-5",
  fallback_model_id: null,
  temperature: 0.3,
  max_output_tokens: 400,
  timeout_ms: 8000,
  max_cost_usd: 0.003,
  notes: null,
  author_id: "x",
  created_at: "2026-11-19T10:00:00Z",
  published_by: null,
  published_at: null,
  last_test_run: null,
  updated_at: "2026-11-19T10:00:00Z",
  canary: false,
};

describe("output JSON Schema and the draft form", () => {
  it("validates the schema text: JSON, object, type, properties, required", () => {
    expect(checkOutputSchema('{"type":"object"}').issues).toEqual([]);
    expect(checkOutputSchema("").issues[0]!.code).toBe("required");
    const bad = checkOutputSchema('{\n  "type": "object",\n  "properties": {,}\n}');
    expect(bad.issues[0]).toMatchObject({ code: "json_parse", vars: { line: 3 } });
    expect(checkOutputSchema("[]").issues[0]!.code).toBe("not_object");
    expect(checkOutputSchema('{"type":"array"}').issues[0]!.code).toBe("type_not_object");
    expect(checkOutputSchema('{"properties":[]}').issues[0]!.code).toBe("properties_not_object");
    expect(checkOutputSchema('{"required":"a"}').issues[0]!.code).toBe("required_not_array");
    expect(checkOutputSchema('{"properties":{"a":{}},"required":["a","b"]}').issues[0]).toMatchObject({ code: "required_unknown", vars: { name: "b" } });
    expect(checkOutputSchema("x".repeat(20_001)).issues.map((i) => i.code)).toContain("too_long");
  });
  it("checks limits of ai.ts AgentVersion and the models list", () => {
    const f = formOf(V);
    expect(checkForm(f, ["claude-haiku-5-5"]).issues).toEqual([]);
    const issues = (patch: Partial<typeof f>) => checkForm({ ...f, ...patch }, ["claude-haiku-5-5", "fake"]).issues.map((x) => `${x.field}:${x.code}`);
    expect(issues({ instructions: "" })).toEqual(["instructions:required"]);
    expect(issues({ instructions: "x".repeat(20_001) })).toEqual(["instructions:too_long"]);
    expect(issues({ rules: "x".repeat(10_001) })).toEqual(["rules:too_long"]);
    expect(issues({ temperature: "1.2", max_output_tokens: "2001", timeout_ms: "1999", max_cost_usd: "0" })).toEqual(["temperature:range", "max_output_tokens:range", "timeout_ms:range", "max_cost_usd:range"]);
    expect(issues({ max_output_tokens: "10.5" })).toEqual(["max_output_tokens:range"]);
    expect(issues({ fallback_model_id: "claude-haiku-5-5" })).toEqual(["fallback_model_id:same_model"]);
    expect(issues({ model_id: "gpt" })).toEqual(["model_id:format"]);
    expect(issues({ schema_version: "v2" })).toEqual(["schema_version:format"]);
    expect(issues({ temperature: "0,5" })).toEqual([]); // decimal comma of the RU keyboard
  });
  it("the PATCH carries only the changed fields, typed", () => {
    const f = { ...formOf(V), temperature: "0.5", fallback_model_id: "fake", notes: "  " };
    const s = checkForm(f, []).schema!;
    expect(patchOf(f, V, s)).toEqual({ temperature: 0.5, fallback_model_id: "fake" });
    expect(patchOf({ ...formOf(V), schemaText: '{"type":"object"}' }, V, { type: "object" })).toEqual({ output_schema: { type: "object" } });
  });
  it("publication gate: a draft, saved, with a fresh green run of this very version", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    const run = (p: object) => ({ status: "finished" as const, passed_mandatory: true, started_at: "2026-11-19T11:00:00Z", version: 3, ...p });
    expect(publishGate({ ...V, last_test_run: null }, false, now)).toBe("no_run");
    expect(publishGate({ ...V, last_test_run: run({}) }, true, now)).toBe("unsaved");
    expect(publishGate({ ...V, last_test_run: run({ version: 2 }) }, false, now)).toBe("no_run");
    expect(publishGate({ ...V, last_test_run: run({ status: "running" }) }, false, now)).toBe("running");
    expect(publishGate({ ...V, last_test_run: run({ passed_mandatory: false }) }, false, now)).toBe("failed");
    expect(publishGate({ ...V, last_test_run: run({ started_at: "2026-11-04T11:00:00Z" }) }, false, now)).toBe("stale");
    expect(publishGate({ ...V, status: "published", last_test_run: run({}) }, false, now)).toBe("not_draft");
    expect(publishGate({ ...V, last_test_run: run({}) }, false, now)).toBeNull();
  });
});

/* ---------------------------------------------------------------- budget */

describe("budget share and levels", () => {
  it("percent of the monthly cap with one decimal; zero cap", () => {
    expect(capPct(12.4, 20)).toBe(62);
    expect(capPct(17.2, 20)).toBe(86);
    expect(capPct(1, 3)).toBe(33.3);
    expect(capPct(0, 0)).toBe(0);
    expect(capPct(0.01, 0)).toBe(100);
  });
  it("ok below the alert threshold, warn at it, over at 100 %", () => {
    expect(budgetLevel(79.9, 80)).toBe("ok");
    expect(budgetLevel(80, 80)).toBe("warn");
    expect(budgetLevel(99.9, 80)).toBe("warn");
    expect(budgetLevel(100, 80)).toBe("over");
    expect(budgetLevel(120, 100)).toBe("over");
  });
  it("limits: positive, lesson ≤ day ≤ month, threshold 1…100", () => {
    const ok = { monthly_cap_usd: "20", learner_daily_cap_usd: "0.05", lesson_cap_usd: "0,03", speech_monthly_cap_usd: "5", alert_percent: "80" };
    expect(checkBudget(ok).value).toEqual({ monthly_cap_usd: 20, learner_daily_cap_usd: 0.05, lesson_cap_usd: 0.03, speech_monthly_cap_usd: 5, alert_percent: 80 });
    const codes = (p: Partial<typeof ok>) => checkBudget({ ...ok, ...p }).issues.map((x) => `${x.field}:${x.code}`);
    expect(codes({ lesson_cap_usd: "0.06" })).toEqual(["lesson_cap_usd:gt_daily"]);
    expect(codes({ learner_daily_cap_usd: "25" })).toEqual(["learner_daily_cap_usd:gt_monthly"]);
    expect(codes({ monthly_cap_usd: "0" })).toEqual(["monthly_cap_usd:range"]);
    expect(codes({ alert_percent: "101" })).toEqual(["alert_percent:range"]);
    expect(codes({ alert_percent: "80.5" })).toEqual(["alert_percent:range"]);
    // sprint 5: the sub-cap of pronunciation is 0…the month; 0 turns the feature off
    expect(codes({ speech_monthly_cap_usd: "0" })).toEqual([]);
    expect(codes({ speech_monthly_cap_usd: "20" })).toEqual([]);
    expect(codes({ speech_monthly_cap_usd: "20,01" })).toEqual(["speech_monthly_cap_usd:gt_monthly"]);
    expect(codes({ speech_monthly_cap_usd: "-1" })).toEqual(["speech_monthly_cap_usd:range0"]);
    expect(codes({ speech_monthly_cap_usd: "" })).toEqual(["speech_monthly_cap_usd:range0"]);
  });
  it("pronunciation sub-cap: hours of audio at the price of the active speech model", () => {
    const m = (provider: "anthropic" | "azure_speech" | "fake_speech", active: boolean, audio_usd_per_hour: number | null) => ({ provider, active, audio_usd_per_hour });
    expect(speechHourPrice([m("anthropic", true, null), m("fake_speech", true, 0), m("azure_speech", true, 1.32)])).toBe(1.32);
    expect(speechHourPrice([m("azure_speech", false, 1.32), m("fake_speech", true, 0.5)])).toBe(0.5);
    expect(speechHourPrice([m("azure_speech", false, 1.32)])).toBeNull();
    expect(speechHourPrice(null)).toBeNull();
    expect(speechHours(5, 1.32)).toBe(3.8);
    expect(speechHours(0, 1.32)).toBe(0);
    expect(speechHours(5, null)).toBeNull();
    expect(speechHours(null, 1.32)).toBeNull();
    expect(speechHours(-1, 1.32)).toBeNull();
  });
  it("R2-07 BUDGET_CONFLICT: edited fields keep the entered values, untouched ones take the values saved now", () => {
    const read = { monthly_cap_usd: "20", learner_daily_cap_usd: "0.05", lesson_cap_usd: "0.03", speech_monthly_cap_usd: "5", alert_percent: "80" };
    const entered = { ...read, lesson_cap_usd: "0.04", alert_percent: "90" };
    const now = { ...read, monthly_cap_usd: "25", alert_percent: "70" };
    expect(mergeBudgetForm(read, entered, now)).toEqual({ monthly_cap_usd: "25", learner_daily_cap_usd: "0.05", lesson_cap_usd: "0.04", speech_monthly_cap_usd: "5", alert_percent: "90" });
    // nothing edited — exactly the values saved now
    expect(mergeBudgetForm(read, read, now)).toEqual(now);
  });
  it("money: cents above a dollar, more decimals for small sums; nice chart max", () => {
    expect(usd(20, "en-US")).toBe("$20.00");
    expect(usd(0.1, "en-US")).toBe("$0.10");
    expect(usd(0.0118, "en-US")).toBe("$0.012");
    expect(usd(0.00012, "en-US")).toBe("$0.0001");
    expect(usd(null)).toBe("—");
    expect(usd(0.1, "ru-RU")).toBe("$0,10");
    expect([0, 0.7, 1, 1.2, 3.4, 7.1, 12].map(niceMax)).toEqual([1, 1, 1, 2, 5, 10, 20]);
  });
});

/* ---------------------------------------------------------------- task for Jira */

const SID = "5e000000-0000-4000-8000-000000000001";
const CARD: SessionCard = {
  session: {
    session_id: SID,
    kind: "lesson",
    title: { ru: "Привет! Знакомимся", uz: "Salom!" },
    lesson_id: "l-01-greetings",
    scenario_id: null,
    asset_id: null,
    reading_id: null,
    level: "A1",
    status: "completed",
    outcome: "success",
    passed: true,
    minutes: 19,
    audience: "adults",
    ai_mode: "full",
    models: ["claude-haiku-5-5"],
    cost_usd: 0.0124,
    p95_latency_ms: 2140,
    flags: ["ai_used", "appealed"],
    started_at: "2026-11-19T09:00:00Z",
    finished_at: "2026-11-19T09:19:00Z",
    user_ref: "7f3a91c2",
    content_versions: { lesson: 3, rubric: 1 },
    status_history: [
      { from: null, to: "ready", reason: "started", at: "2026-11-19T09:00:00Z" },
      { from: "ready", to: "completed", reason: "finish", at: "2026-11-19T09:19:00Z" },
    ],
    steps: [{ step_id: "s2", stage: "retrieval", type: "gap_fill", result: "incorrect", hinted: true, answered_at: null }],
    turns_meta: [{ turn_id: "T3", speaker: "learner", mode: "choice", intent: "order_drink", ai_call_id: null, redacted: false }],
  },
  evaluations: [
    {
      evaluation_id: "e7000000-0000-4000-8000-000000000001",
      session_id: SID,
      status: "ok",
      rubric: { rubric_id: "r-lesson", version: 1 },
      scores: [{ code: "grammar", score: 1 }],
      weighted: 2.1,
      passed: true,
      task_completed: true,
      confirmed_errors: [{ turn_id: "T3", evidence: "I want coffee big", correction: "I'd like a large coffee", error_code: "word_order", severity: "medium" }],
      items: [],
      skill_outcomes: [],
      evaluator: { agent_id: "independent_evaluator", agent_version: 1, prompt_version: "independent_evaluator@1", model_id: "claude-sonnet-5-5", schema_version: "independent_evaluator.v1", canary: true },
      requires_human_review: false,
      practice_only: false,
      supersedes: null,
      created_by_name: "Гульнора",
      reason: null,
      flags: [{ reason: "Учитель Мадина сказала, что это верно", by_name: "Зарина", at: "2026-11-19T10:00:00Z" }],
      created_at: "2026-11-19T09:19:00Z",
    },
  ],
  ai_calls: [
    { call_id: "c1", agent_id: "conversation_partner", version: 2, model_id: "claude-haiku-5-5", status: "ok", reason: null, input_tokens: 1, output_tokens: 1, cost_usd: 0.0001, latency_ms: 1, session_id: SID, canary: false, created_at: "2026-11-19T09:05:00Z" },
    { call_id: "c2", agent_id: "conversation_partner", version: 2, model_id: "claude-haiku-5-5", status: "unavailable", reason: "timeout", input_tokens: 1, output_tokens: 0, cost_usd: 0, latency_ms: 8000, session_id: SID, canary: false, created_at: "2026-11-19T09:06:00Z" },
  ],
  errors: {},
};
const tr = (k: string, v?: Record<string, string | number>) => translate("ru", k as never, v);

describe("task for Jira (ADM-QA-04) — without learner data", () => {
  it("has reproduction, expected, actual, the session id and versions", () => {
    const md = taskMarkdown(CARD, { kind: "bug", title: "Ложная коррекция", expected: "Не исправлять выбранные реплики", actual: "T3 засчитана ошибкой" }, tr);
    expect(md).toContain("# [Баг] Ложная коррекция");
    expect(md).toContain(`\`${SID}\``);
    expect(md).toContain("## Воспроизведение");
    expect(md).toContain("lesson v3, rubric v1");
    expect(md).toContain("s2 · retrieval · gap_fill → неверно (с подсказкой)");
    expect(md).toContain("T3 · выбор → order_drink");
    expect(md).toContain("ready → completed");
    expect(md).toContain("## Ожидание\nНе исправлять выбранные реплики");
    expect(md).toContain("## Факт\nT3 засчитана ошибкой");
    expect(md).toContain("independent_evaluator@1 · claude-sonnet-5-5 · independent_evaluator.v1 · канарейка");
    expect(md).toContain("r-lesson v1");
    expect(md).toContain("T3:word_order");
    expect(md).toContain("conversation_partner v2 · claude-haiku-5-5 ×2 (не ok: 1)");
  });
  it("never includes user_ref, quotes, flag texts, staff names; scrubs PII typed by the staff member", () => {
    const md = taskMarkdown(
      CARD,
      { kind: "method", title: "", expected: "Письмо от madina@mail.uz, тел +998 (90) 123-45-67, @madina_k, ученик 7f3a91c2, id a1000000-0000-4000-8000-000000000009, t.me/madina", actual: `Сессия ${SID} от 2026-11-19` },
      tr,
    );
    for (const leak of ["7f3a91c2", "I want coffee big", "I'd like a large coffee", "Мадина", "Гульнора", "Зарина", "madina@mail.uz", "123-45-67", "@madina_k", "a1000000-0000-4000-8000-000000000009", "t.me/madina"]) {
      expect(md, leak).not.toContain(leak);
    }
    expect(md).toContain("[скрыто]");
    expect(md).toContain(`Сессия ${SID} от 2026-11-19`); // the session id and dates stay
    expect(md).toContain("# [Методическая доработка] Проверить сессию: Урок");
  });
  it("independent blocks: a missing domain is named, the rest still builds", () => {
    const md = taskMarkdown({ ...CARD, session: null, ai_calls: null, errors: { lessons: "UPSTREAM_UNAVAILABLE", "ai-gateway": "UPSTREAM_UNAVAILABLE" } }, { kind: "bug", title: "x", expected: "", actual: "" }, tr);
    expect(md).toContain("Данные сессии недоступны (lessons)");
    expect(md).toContain(SID);
    expect(md).toContain("Недоступные блоки: lessons, ai-gateway");
    expect(taskFileName(SID)).toBe("tilhero-session-5e000000.md");
  });
  it("scrubPii keeps the session id and short numbers", () => {
    expect(scrubPii(`x ${SID} 12 345 2026-11-19`, { sessionId: SID, hidden: "#" })).toBe(`x ${SID} 12 345 2026-11-19`);
    expect(scrubPii("+998901234567", { sessionId: SID, hidden: "#" })).toBe("#");
  });
});

/* ---------------------------------------------------------------- coordinator follow-ups */

describe("AI refusal cost_limit and erased appeal texts (RU / EN)", () => {
  it("cost_limit is a known call reason with words in both languages", () => {
    expect(CALL_REASONS).toContain("cost_limit");
    expect(translate("ru", "aireason.cost_limit")).toBe("превышен лимит стоимости вызова (версия агента)");
    expect(translate("en", "aireason.cost_limit")).toBe("call cost limit of the agent version exceeded");
  });
  it("an appeal text erased by retention is named so", () => {
    expect(translate("ru", "ap.redacted")).toBe("удалён по сроку хранения");
    expect(translate("en", "ap.redacted")).toBe("deleted after the retention period");
  });
});
