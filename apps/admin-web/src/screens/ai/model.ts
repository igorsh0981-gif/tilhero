/**
 * Pure logic of the sprint 4 sections («Агенты и скиллы», «Контроль диалогов», «Затраты и лимиты»): the line diff of
 * an agent version against the published one, the golden-check builder, the output JSON Schema check, the draft
 * limits (ai.ts AgentVersion), the budget share and its level, the budget settings check and the Markdown of a task
 * for Jira (ADM-QA-04) — built WITHOUT any learner data (no user_ref, replies, answers, quotes, appeal texts).
 * No React here: unit-tested in test/ai.test.ts.
 */
import type { AgentId, AgentImplementation, AgentVersion, GoldenCheck, RubricCriterionCode, SessionKind } from "@tilhero/contracts/ai";
import type { AiBudget, AiModel, SessionCard, SessionFlag, SessionRow } from "@tilhero/contracts/admin";

/* ---------------------------------------------------------------- catalogues */

export const AGENT_IDS: readonly AgentId[] = [
  "learning_orchestrator", "diagnostic_assessor", "curriculum_planner", "teaching_coach", "conversation_partner", "independent_evaluator",
  "error_analyst", "spaced_repetition_coach", "pronunciation_coach", "evening_review_coach", "safety_quality_gate", "cooperative_lesson_coach",
  "gameplay_director", "duel_host", "referral_integrity_reviewer", "media_lesson_designer", "language_pathway_advisor",
];
export const IMPLEMENTATIONS: readonly AgentImplementation[] = ["llm", "rules", "code"];
export const VERSION_STATUSES: readonly AgentVersion["status"][] = ["draft", "published", "archived"];
export const RUN_STATUSES = ["running", "finished", "failed"] as const;
export const CHECK_KINDS: readonly GoldenCheck["kind"][] = ["schema_valid", "field_equals", "field_in", "field_absent", "text_not_contains", "max_length"];
/** sprint 7: + duel (a duel session of lessons — no AI, closed tasks only; listed for completeness of the journal) */
export const SESSION_KINDS: readonly SessionKind[] = ["lesson", "scenario", "media", "review", "reading", "duel"];
export const SESSION_STATUSES: readonly SessionRow["status"][] = ["ready", "in_progress", "paused", "completed", "failed", "cancelled"];
export const OUTCOMES: readonly NonNullable<SessionRow["outcome"]>[] = ["success", "alt_success", "fail"];
export const SESSION_FLAGS: readonly SessionFlag[] = ["ai_used", "ai_unavailable", "hints", "human_review", "appealed", "flagged", "failed"];
export const EVAL_STATUSES = ["ok", "partial", "insufficient_evidence", "pending_review"] as const;
export const SKILL_OUTCOMES = ["demonstrated", "learning", "not_assessed"] as const;
export const APPEAL_STATUSES = ["new", "in_review", "upheld", "corrected"] as const;
export const SEVERITIES = ["low", "medium", "high"] as const;
export const CALL_STATUSES = ["ok", "unavailable", "refused"] as const;
export const CALL_REASONS = ["ai_disabled", "budget_exceeded", "cost_limit", "provider_error", "timeout", "invalid_output", "kids_not_allowed", "agent_not_active"] as const;
export const HISTORY_REASONS = ["started", "pause", "resume", "auto_pause", "finish", "fail", "cancel", "expired", "content_unpublished"] as const;
export const AI_MODES = ["full", "choices"] as const;
export const USAGE_PERIODS = ["day", "week", "month"] as const;
export const CRITERIA: readonly RubricCriterionCode[] = ["task", "vocabulary", "grammar", "independence", "pronunciation", "fluency", "comprehension"];

/* ---------------------------------------------------------------- version limits (ai.ts AgentVersion) */

export const LIMITS = {
  instructions: 20_000,
  rules: 10_000,
  schema: 20_000,
  notes: 500,
  temperature: [0, 1],
  maxTokens: [1, 2000],
  timeout: [2000, 30_000],
  cost: [0.0001, 1],
} as const;
/** a published version and its green run are «fresh» for publication 14 days (INTERNAL_API §1.1) */
export const RUN_FRESH_DAYS = 14;
export const SCHEMA_VERSION_RE = /^[a-z][a-z0-9_]*\.v\d+$/;

/** The editable part of a version (AgentVersionPatch) as the editor keeps it: the schema stays text until saved. */
export interface VersionForm {
  instructions: string;
  rules: string;
  schemaText: string;
  schema_version: string;
  model_id: string;
  fallback_model_id: string; // "" — none
  temperature: string;
  max_output_tokens: string;
  timeout_ms: string;
  max_cost_usd: string;
  notes: string;
}

export type FormField = keyof VersionForm;
export interface FormIssue {
  field: FormField;
  code: "required" | "too_long" | "range" | "format" | "same_model" | "json_parse" | "not_object" | "type_not_object" | "properties_not_object" | "required_not_array" | "required_unknown";
  /** values for the message: max, min, line, col, name */
  vars?: Record<string, string | number>;
}

export function formOf(v: AgentVersion): VersionForm {
  return {
    instructions: v.instructions,
    rules: v.rules,
    schemaText: prettyJson(v.output_schema),
    schema_version: v.schema_version,
    model_id: v.model_id,
    fallback_model_id: v.fallback_model_id ?? "",
    temperature: String(v.temperature),
    max_output_tokens: String(v.max_output_tokens),
    timeout_ms: String(v.timeout_ms),
    max_cost_usd: String(v.max_cost_usd),
    notes: v.notes ?? "",
  };
}

export const prettyJson = (v: unknown): string => JSON.stringify(v ?? {}, null, 2);

const num = (s: string): number | null => {
  const t = s.trim().replace(",", ".");
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
/** a decimal typed by a staff member («0,5» or «0.5»); null — not a number */
export const decimal = num;

/** 1-based line and column of a character offset in `text` */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split("\n");
  return { line: lines.length, col: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

/**
 * Output JSON Schema of a version: valid JSON, an object, `type` (if any) = "object", `properties` an object,
 * `required` an array of names of `properties`. The ai-gateway checks the schema itself on save — this catches typos
 * before the request (and shows the line of a parse error).
 */
export function checkOutputSchema(text: string): { value: Record<string, unknown> | null; issues: FormIssue[] } {
  const issues: FormIssue[] = [];
  const add = (code: FormIssue["code"], vars?: FormIssue["vars"]) => issues.push({ field: "schemaText", code, vars });
  if (!text.trim()) {
    add("required");
    return { value: null, issues };
  }
  if (text.length > LIMITS.schema) add("too_long", { max: LIMITS.schema });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const m = /position (\d+)/.exec(String((e as Error).message ?? ""));
    const at = m ? lineCol(text, Number(m[1])) : lineCol(text, text.length);
    add("json_parse", at);
    return { value: null, issues };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    add("not_object");
    return { value: null, issues };
  }
  const o = parsed as Record<string, unknown>;
  if ("type" in o && o.type !== "object") add("type_not_object");
  const props = o.properties;
  if (props !== undefined && (!props || typeof props !== "object" || Array.isArray(props))) add("properties_not_object");
  if (o.required !== undefined) {
    if (!Array.isArray(o.required) || o.required.some((x) => typeof x !== "string")) add("required_not_array");
    else if (props && typeof props === "object" && !Array.isArray(props)) {
      const unknown = (o.required as string[]).filter((x) => !(x in (props as object)));
      if (unknown.length) add("required_unknown", { name: unknown.join(", ") });
    }
  }
  return { value: o, issues };
}

/** All issues of the draft form; `patch` is null while anything is wrong. */
export function checkForm(f: VersionForm, activeModels: readonly string[]): { issues: FormIssue[]; schema: Record<string, unknown> | null } {
  const issues: FormIssue[] = [];
  const add = (field: FormField, code: FormIssue["code"], vars?: FormIssue["vars"]) => issues.push({ field, code, vars });
  if (!f.instructions.trim()) add("instructions", "required");
  if (f.instructions.length > LIMITS.instructions) add("instructions", "too_long", { max: LIMITS.instructions });
  if (f.rules.length > LIMITS.rules) add("rules", "too_long", { max: LIMITS.rules });
  if (f.notes.length > LIMITS.notes) add("notes", "too_long", { max: LIMITS.notes });
  const s = checkOutputSchema(f.schemaText);
  issues.push(...s.issues);
  if (!SCHEMA_VERSION_RE.test(f.schema_version.trim())) add("schema_version", "format");
  if (!f.model_id) add("model_id", "required");
  else if (activeModels.length && !activeModels.includes(f.model_id)) add("model_id", "format");
  if (f.fallback_model_id && f.fallback_model_id === f.model_id) add("fallback_model_id", "same_model");
  const range = (field: FormField, value: string, [min, max]: readonly [number, number], int = false) => {
    const n = num(value);
    if (n == null || n < min || n > max || (int && !Number.isInteger(n))) add(field, "range", { min, max });
  };
  range("temperature", f.temperature, LIMITS.temperature);
  range("max_output_tokens", f.max_output_tokens, LIMITS.maxTokens, true);
  range("timeout_ms", f.timeout_ms, LIMITS.timeout, true);
  range("max_cost_usd", f.max_cost_usd, LIMITS.cost);
  return { issues, schema: s.value };
}

/** Only the fields that differ from the version that was read (AgentVersionPatch). */
export function patchOf(f: VersionForm, base: AgentVersion, schema: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown, was: unknown) => {
    if (JSON.stringify(v) !== JSON.stringify(was)) out[k] = v;
  };
  set("instructions", f.instructions, base.instructions);
  set("rules", f.rules, base.rules);
  set("output_schema", schema, base.output_schema);
  set("schema_version", f.schema_version.trim(), base.schema_version);
  set("model_id", f.model_id, base.model_id);
  set("fallback_model_id", f.fallback_model_id || null, base.fallback_model_id);
  set("temperature", num(f.temperature), base.temperature);
  set("max_output_tokens", num(f.max_output_tokens), base.max_output_tokens);
  set("timeout_ms", num(f.timeout_ms), base.timeout_ms);
  set("max_cost_usd", num(f.max_cost_usd), base.max_cost_usd);
  set("notes", f.notes.trim() ? f.notes : null, base.notes);
  return out;
}

export const sameForm = (a: VersionForm, b: VersionForm) => (Object.keys(a) as FormField[]).every((k) => a[k] === b[k]);

/* ---------------------------------------------------------------- test runs and the publication gate */

export interface RunLike {
  status: "running" | "finished" | "failed";
  passed_mandatory: boolean;
  started_at: string;
  version: number;
}

/** Why «Опубликовать» is closed for the version (null — open). The ai-gateway decides again (422 TESTS_*). */
export function publishGate(v: { status: AgentVersion["status"]; version: number; last_test_run: RunLike | null }, dirty: boolean, now = Date.now()):
  | null
  | "not_draft"
  | "unsaved"
  | "no_run"
  | "running"
  | "stale"
  | "failed" {
  if (v.status !== "draft") return "not_draft";
  if (dirty) return "unsaved";
  const r = v.last_test_run;
  if (!r || r.version !== v.version) return "no_run";
  if (r.status === "running") return "running";
  if (now - Date.parse(r.started_at) > RUN_FRESH_DAYS * 86_400_000) return "stale";
  if (r.status !== "finished" || !r.passed_mandatory) return "failed";
  return null;
}

/* ---------------------------------------------------------------- line diff (LCS) */

export interface DiffLine {
  op: "eq" | "add" | "del";
  text: string;
  /** 1-based line in the published text (eq/del) and in the compared text (eq/add) */
  a: number | null;
  b: number | null;
}
export type DiffRow = DiffLine | { op: "skip"; n: number };

const splitLines = (s: string) => (s === "" ? [] : s.replace(/\r\n?/g, "\n").split("\n"));

/**
 * Line diff of `before` → `after`: the common head and tail are trimmed, the middle is an LCS table (removed lines
 * come before added ones inside a changed block). Past 4 M cells (two huge texts with nothing in common) the middle
 * becomes «all removed, then all added» — still correct, just not minimal.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const A = splitLines(before);
  const B = splitLines(after);
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ op: "eq", text: A[i]!, a: i + 1, b: i + 1 });
  const a = A.slice(head, A.length - tail);
  const b = B.slice(head, B.length - tail);
  const n = a.length;
  const m = b.length;
  if (n && m && (n + 1) * (m + 1) <= 4_000_000) {
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        out.push({ op: "eq", text: a[i]!, a: head + i + 1, b: head + j + 1 });
        i++;
        j++;
      } else if (j >= m || (i < n && L[(i + 1) * w + j]! >= L[i * w + j + 1]!)) {
        out.push({ op: "del", text: a[i]!, a: head + i + 1, b: null });
        i++;
      } else {
        out.push({ op: "add", text: b[j]!, a: null, b: head + j + 1 });
        j++;
      }
    }
  } else {
    a.forEach((t, i) => out.push({ op: "del", text: t, a: head + i + 1, b: null }));
    b.forEach((t, j) => out.push({ op: "add", text: t, a: null, b: head + j + 1 }));
  }
  for (let k = 0; k < tail; k++) out.push({ op: "eq", text: A[A.length - tail + k]!, a: A.length - tail + k + 1, b: B.length - tail + k + 1 });
  return out;
}

export const diffStats = (d: readonly DiffLine[]) => ({ added: d.filter((x) => x.op === "add").length, removed: d.filter((x) => x.op === "del").length });

/** Unchanged runs longer than 2·context collapse into «N lines without changes». */
export function collapseDiff(d: readonly DiffLine[], context = 2): DiffRow[] {
  const keep = d.map((x) => x.op !== "eq");
  const near = d.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) if (keep[k]) return true;
    return false;
  });
  const out: DiffRow[] = [];
  let skipped = 0;
  d.forEach((x, i) => {
    if (near[i]) {
      if (skipped) out.push({ op: "skip", n: skipped });
      skipped = 0;
      out.push(x);
    } else skipped++;
  });
  if (skipped) out.push({ op: "skip", n: skipped });
  return out;
}

/* ---------------------------------------------------------------- golden check builder */

/** dot-path from the root of AgentInvokeResult (ai.ts): `status`, `output.intent`, `output.confirmed_errors.0.evidence` */
export const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/;
/** checks of the output content: the fake provider skips them (ai.ts GoldenCheck) */
export const isOutputPath = (path: string) => path === "output" || path.startsWith("output.");
export type ValueType = "string" | "number" | "boolean" | "null";

/** The builder row: everything as text, typed on build. */
export interface CheckDraft {
  kind: GoldenCheck["kind"];
  path: string;
  value: string;
  valueType: ValueType;
  /** field_in / text_not_contains: one value per line */
  values: string;
  n: string;
}
export interface CheckIssue {
  field: "path" | "value" | "values" | "n";
  code: "required" | "format" | "range";
}

export const needsPath = (k: GoldenCheck["kind"]) => k !== "schema_valid";

export function emptyCheck(kind: GoldenCheck["kind"] = "schema_valid"): CheckDraft {
  return { kind, path: "", value: "", valueType: "string", values: "", n: kind === "max_length" ? "240" : "" };
}

const literal = (v: string | number | boolean | null): string => (v === null ? "null" : typeof v === "string" ? (/^(true|false|null|-?\d+(\.\d+)?)$/.test(v) || /^".*"$/.test(v) ? JSON.stringify(v) : v) : String(v));

export function draftOf(c: GoldenCheck): CheckDraft {
  const d = emptyCheck(c.kind);
  if ("path" in c) d.path = c.path;
  if (c.kind === "field_equals") {
    d.valueType = c.value === null ? "null" : (typeof c.value as ValueType);
    d.value = c.value === null ? "" : String(c.value);
  }
  if (c.kind === "field_in") d.values = c.values.map(literal).join("\n");
  if (c.kind === "text_not_contains") d.values = c.values.join("\n");
  if (c.kind === "max_length") d.n = String(c.n);
  return d;
}

/** field_in: one value per line — true / false / null / a number become typed, "quoted" stays a string. */
export function parseValueList(text: string): Array<string | number | boolean | null> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      if (l === "true") return true;
      if (l === "false") return false;
      if (l === "null") return null;
      if (/^-?\d+(\.\d+)?$/.test(l)) return Number(l);
      if (/^".*"$/.test(l)) {
        try {
          return JSON.parse(l) as string;
        } catch {
          return l.slice(1, -1);
        }
      }
      return l;
    });
}

export function buildCheck(d: CheckDraft): { check: GoldenCheck | null; issues: CheckIssue[] } {
  const issues: CheckIssue[] = [];
  const path = d.path.trim();
  if (needsPath(d.kind)) {
    if (!path) issues.push({ field: "path", code: "required" });
    else if (!PATH_RE.test(path)) issues.push({ field: "path", code: "format" });
  }
  let check: GoldenCheck | null = null;
  switch (d.kind) {
    case "schema_valid":
      check = { kind: "schema_valid" };
      break;
    case "field_absent":
      check = { kind: "field_absent", path };
      break;
    case "field_equals": {
      let value: string | number | boolean | null = d.value;
      if (d.valueType === "null") value = null;
      else if (d.valueType === "boolean") {
        if (d.value !== "true" && d.value !== "false") issues.push({ field: "value", code: "format" });
        value = d.value === "true";
      } else if (d.valueType === "number") {
        const n = num(d.value);
        if (n == null) issues.push({ field: "value", code: "format" });
        value = n ?? 0;
      }
      check = { kind: "field_equals", path, value };
      break;
    }
    case "field_in": {
      const values = parseValueList(d.values);
      if (!values.length) issues.push({ field: "values", code: "required" });
      check = { kind: "field_in", path, values };
      break;
    }
    case "text_not_contains": {
      const values = d.values.split("\n").map((x) => x.trim()).filter(Boolean);
      if (!values.length) issues.push({ field: "values", code: "required" });
      check = { kind: "text_not_contains", path, values };
      break;
    }
    case "max_length": {
      const n = num(d.n);
      if (n == null || !Number.isInteger(n) || n < 1 || n > 20_000) issues.push({ field: "n", code: "range" });
      check = { kind: "max_length", path, n: n ?? 0 };
      break;
    }
  }
  return { check: issues.length ? null : check, issues };
}

/** One-line text of a check for the case list: «reply_en ≤ 240», «intent ∈ {greet, ask}». */
export function checkLine(c: GoldenCheck): string {
  switch (c.kind) {
    case "schema_valid":
      return "schema";
    case "field_equals":
      return `${c.path} = ${JSON.stringify(c.value)}`;
    case "field_in":
      return `${c.path} ∈ {${c.values.map((v) => JSON.stringify(v)).join(", ")}}`;
    case "field_absent":
      return `${c.path} ∅`;
    case "text_not_contains":
      return `${c.path} ∌ ${c.values.map((v) => JSON.stringify(v)).join(", ")}`;
    case "max_length":
      return `|${c.path}| ≤ ${c.n}`;
  }
}

/** Golden input JSON (the agent context): an object. */
export function checkContextJson(text: string): { value: Record<string, unknown> | null; error: null | { code: "required" | "json_parse" | "not_object"; line?: number; col?: number } } {
  if (!text.trim()) return { value: null, error: { code: "required" } };
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { value: null, error: { code: "not_object" } };
    return { value: v as Record<string, unknown>, error: null };
  } catch (e) {
    const m = /position (\d+)/.exec(String((e as Error).message ?? ""));
    return { value: null, error: { code: "json_parse", ...lineCol(text, m ? Number(m[1]) : text.length) } };
  }
}

/* ---------------------------------------------------------------- budget */

/** Share of the cap in percent with one decimal (a zero cap with spending counts as 100 %). */
export function capPct(spent: number, cap: number): number {
  if (!(cap > 0)) return spent > 0 ? 100 : 0;
  return Math.round((spent / cap) * 1000) / 10;
}

/** ok — below the alert threshold; warn — at or above it; over — the cap is reached (AI calls answer budget_exceeded). */
export function budgetLevel(pct: number, alertPercent: number): "ok" | "warn" | "over" {
  if (pct >= 100) return "over";
  if (pct >= alertPercent) return "warn";
  return "ok";
}

export type BudgetForm = Record<"monthly_cap_usd" | "learner_daily_cap_usd" | "lesson_cap_usd" | "speech_monthly_cap_usd" | "room_cap_usd" | "alert_percent", string>;
export interface BudgetIssue {
  field: keyof BudgetForm;
  code: "range" | "range0" | "gt_daily" | "gt_monthly";
}
export const budgetForm = (b: Pick<AiBudget, keyof BudgetForm>): BudgetForm => ({
  monthly_cap_usd: String(b.monthly_cap_usd),
  learner_daily_cap_usd: String(b.learner_daily_cap_usd),
  lesson_cap_usd: String(b.lesson_cap_usd),
  speech_monthly_cap_usd: String(b.speech_monthly_cap_usd),
  // sprint 7: an ai-gateway before the room cap answers without it — the default of the contract (0.10)
  room_cap_usd: String(b.room_cap_usd ?? ROOM_CAP_DEFAULT),
  alert_percent: String(b.alert_percent),
});
/** AiBudget.room_cap_usd by default (INTERNAL_API sprint 7 §4) */
export const ROOM_CAP_DEFAULT = 0.1;

/**
 * 409 BUDGET_CONFLICT (review R2-07): someone saved the limits after they were read. The fields this user edited keep
 * the entered values; the rest take the values saved now (a field nobody here touched must not undo the other change).
 */
export function mergeBudgetForm(read: BudgetForm, entered: BudgetForm, now: BudgetForm): BudgetForm {
  const out = { ...now };
  for (const k of Object.keys(entered) as Array<keyof BudgetForm>) if (entered[k] !== read[k]) out[k] = entered[k];
  return out;
}

/**
 * Caps are positive, a lesson ≤ a learner's day ≤ the month; the sub-cap of pronunciation (sprint 5, owner's decision:
 * $5 a month) is 0…the month (0 — the feature is off); the coach of one pair room (sprint 7, $0.10 by default) is
 * 0…the month (0 — rooms go by the scenario with choices); the alert threshold is 1…100 %.
 */
export function checkBudget(f: BudgetForm): { issues: BudgetIssue[]; value: Pick<AiBudget, keyof BudgetForm> | null } {
  const issues: BudgetIssue[] = [];
  const m = num(f.monthly_cap_usd);
  const d = num(f.learner_daily_cap_usd);
  const l = num(f.lesson_cap_usd);
  const sp = num(f.speech_monthly_cap_usd);
  const rc = num(f.room_cap_usd);
  const a = num(f.alert_percent);
  if (m == null || m <= 0 || m > 100_000) issues.push({ field: "monthly_cap_usd", code: "range" });
  if (d == null || d <= 0) issues.push({ field: "learner_daily_cap_usd", code: "range" });
  else if (m != null && m > 0 && d > m) issues.push({ field: "learner_daily_cap_usd", code: "gt_monthly" });
  if (l == null || l <= 0) issues.push({ field: "lesson_cap_usd", code: "range" });
  else if (d != null && d > 0 && l > d) issues.push({ field: "lesson_cap_usd", code: "gt_daily" });
  if (sp == null || sp < 0) issues.push({ field: "speech_monthly_cap_usd", code: "range0" });
  else if (m != null && m > 0 && sp > m) issues.push({ field: "speech_monthly_cap_usd", code: "gt_monthly" });
  if (rc == null || rc < 0) issues.push({ field: "room_cap_usd", code: "range0" });
  else if (m != null && m > 0 && rc > m) issues.push({ field: "room_cap_usd", code: "gt_monthly" });
  if (a == null || !Number.isInteger(a) || a < 1 || a > 100) issues.push({ field: "alert_percent", code: "range" });
  return { issues, value: issues.length ? null : { monthly_cap_usd: m!, learner_daily_cap_usd: d!, lesson_cap_usd: l!, speech_monthly_cap_usd: sp!, room_cap_usd: rc!, alert_percent: a! } };
}

/** sprint 5: a speech model (pronunciation) is priced per hour of audio, not per token. */
export const isSpeech = (m: Pick<AiModel, "provider">): boolean => m.provider === "whisper" || m.provider === "azure_speech" || m.provider === "fake_speech";

/**
 * release 5.1: whisper — the own server (tts: faster-whisper). Nothing is charged: the price of an hour is fixed at 0 and
 * is not edited; its status is «подключён / не подключён» (the recognition service), never a key or a region.
 */
export const isOwnServer = (m: { provider: string } | null | undefined): boolean => m?.provider === "whisper";

/** The price of an hour of audio of a paid provider now (the sub-cap applies to those): the active Azure model first,
 *  then any other active paid speech model. The own server (whisper, $0) never counts. */
export function speechHourPrice(models: ReadonlyArray<Pick<AiModel, "provider" | "active" | "audio_usd_per_hour">> | null | undefined): number | null {
  const priced = (models ?? []).filter((x) => x.active && isSpeech(x) && !isOwnServer(x) && x.audio_usd_per_hour != null && x.audio_usd_per_hour > 0);
  const m = priced.find((x) => x.provider === "azure_speech") ?? priced[0];
  return m ? m.audio_usd_per_hour : null;
}

/** «≈ N ч аудио» for a sub-cap at the current price of an hour; null — no price or no valid sub-cap. */
export function speechHours(capUsd: number | null, hourUsd: number | null): number | null {
  if (capUsd == null || !Number.isFinite(capUsd) || capUsd < 0 || hourUsd == null || !(hourUsd > 0)) return null;
  return Math.round((capUsd / hourUsd) * 10) / 10;
}

/** Dollars: ≥ $1 with 2 decimals, below — up to 4 significant decimals ($0.0031). */
export function usd(n: number | null | undefined, locale = "en-US"): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const d = abs >= 1 || abs === 0 ? 2 : abs >= 0.01 ? 3 : 4;
  return `$${new Intl.NumberFormat(locale, { minimumFractionDigits: abs === 0 ? 2 : Math.min(d, 2), maximumFractionDigits: d }).format(n)}`;
}

/* ---------------------------------------------------------------- task for Jira (ADM-QA-04) */

export interface TaskInput {
  kind: "bug" | "method";
  title: string;
  expected: string;
  actual: string;
}
type Tr = (key: string, vars?: Record<string, string | number>) => string;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;
const HANDLE_RE = /(^|[^\w])@[A-Za-z][A-Za-z0-9_]{3,}/g;
const TG_RE = /\b(?:https?:\/\/)?t\.me\/\S+/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Text typed by the staff member may carry learner data by mistake: e-mails, phones, @handles, t.me links, other
 * UUIDs (user ids) and the session's user_ref are replaced with «[скрыто]». The session id itself is kept.
 */
export function scrubPii(text: string, keep: { sessionId: string; userRef?: string | null; hidden: string }): string {
  // the session id, dates and times are protected first: the phone and UUID masks must not eat their digits
  const kept: string[] = [];
  const protect = (m: string) => `\u0001${kept.push(m) - 1}\u0001`;
  let s = keep.sessionId ? text.split(keep.sessionId).join(protect(keep.sessionId)) : text;
  s = s.replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b|\b\d{1,2}:\d{2}\b/g, protect);
  s = s.replace(TG_RE, keep.hidden).replace(EMAIL_RE, keep.hidden).replace(UUID_RE, keep.hidden);
  // a phone has ≥ 9 digits: short numbers stay
  s = s.replace(HANDLE_RE, (_m, pre: string) => `${pre}${keep.hidden}`).replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 9 ? keep.hidden : m));
  if (keep.userRef && keep.userRef.length >= 4) s = s.split(keep.userRef).join(keep.hidden);
  return s.replace(/\u0001(\d+)\u0001/g, (_m, n: string) => kept[Number(n)] ?? "");
}

/**
 * Markdown of the task: reproduction (session kind, content and its versions, the steps and the status path), the
 * expected and the actual behaviour (the staff member's words, scrubbed), the session id and the versions of the
 * evaluator, rubric and agents. Never included: user_ref, replies and answers of the learner, error quotes
 * (evidence), appeal and flag texts, staff names.
 */
export function taskMarkdown(card: SessionCard, input: TaskInput, t: Tr): string {
  const s = card.session;
  const sid = s?.session_id ?? card.evaluations?.[0]?.session_id ?? card.ai_calls?.[0]?.session_id ?? "—";
  const scrub = (x: string) => scrubPii(x.trim(), { sessionId: sid, userRef: s?.user_ref, hidden: t("qt.hidden") });
  const lines: string[] = [];
  const title = scrub(input.title) || t("qt.defaultTitle", { kind: t(`sk.${s?.kind ?? "lesson"}`) });
  lines.push(`# [${t(`qt.kind.${input.kind}`)}] ${title}`, "");
  lines.push(`**${t("qt.md.session")}:** \`${sid}\` (${t("qt.md.anon")})`);
  if (s) {
    const ref = s.lesson_id ?? s.scenario_id ?? s.asset_id ?? "—";
    lines.push(`**${t("qt.md.kind")}:** ${t(`sk.${s.kind}`)} · ${s.title.ru || ref} (\`${ref}\`)${s.level ? ` · ${s.level}` : ""} · ${t(`ageseg.${s.audience}`)} · ${t("qt.md.mode")} ${t(`aimode.${s.ai_mode}`)}`);
    lines.push(`**${t("qt.md.state")}:** ${t(`sst.${s.status}`)}${s.outcome ? ` · ${t(`out.${s.outcome}`)}` : ""}${s.passed != null ? ` · ${t("qt.md.passed")}: ${t(s.passed ? "common.yes" : "common.no")}` : ""}`);
  }
  lines.push("", `## ${t("qt.md.repro")}`);
  if (!s) lines.push(`1. ${t("qt.md.noSession")}`);
  else {
    const vers = Object.entries(s.content_versions).map(([k, v]) => `${k} v${v}`).join(", ") || "—";
    const ref = s.lesson_id ?? s.scenario_id ?? s.asset_id ?? "—";
    let n = 1;
    lines.push(`${n++}. ${t("qt.md.open", { kind: t(`sk.${s.kind}`), title: s.title.ru || ref, ref, vers })}`);
    if (s.audience || s.ai_mode) lines.push(`${n++}. ${t("qt.md.profile", { aud: t(`ageseg.${s.audience}`), mode: t(`aimode.${s.ai_mode}`) })}`);
    if (s.steps.length) {
      lines.push(`${n++}. ${t("qt.md.steps")}`);
      for (const st of s.steps.slice(0, 40)) {
        const res = st.result ? t(`stres.${st.result}`) : "—";
        lines.push(`   - ${st.step_id} · ${st.stage} · ${st.type} → ${res}${st.hinted ? ` (${t("qt.md.hint")})` : ""}`);
      }
      if (s.steps.length > 40) lines.push(`   - … +${s.steps.length - 40}`);
    }
    const learnerTurns = s.turns_meta.filter((x) => x.speaker === "learner");
    if (learnerTurns.length) {
      lines.push(`${n++}. ${t("qt.md.turns", { n: learnerTurns.length })}`);
      for (const tm of learnerTurns.slice(0, 20)) lines.push(`   - ${tm.turn_id} · ${t(`tmode.${tm.mode}`)}${tm.intent ? ` → ${tm.intent}` : ""}`);
    }
    const path = s.status_history.map((h) => h.to).join(" → ");
    if (path) lines.push(`${n++}. ${t("qt.md.path", { path })}`);
  }
  lines.push("", `## ${t("qt.md.expected")}`, scrub(input.expected) || "—", "", `## ${t("qt.md.actual")}`, scrub(input.actual) || "—", "");
  lines.push(`## ${t("qt.md.versions")}`);
  if (s) lines.push(`- ${t("qt.md.content")}: ${Object.entries(s.content_versions).map(([k, v]) => `${k} v${v}`).join(", ") || "—"}`);
  const latest = card.evaluations?.length ? card.evaluations[card.evaluations.length - 1]! : null;
  if (latest) {
    lines.push(`- ${t("qt.md.rubric")}: ${latest.rubric.rubric_id} v${latest.rubric.version}`);
    const e = latest.evaluator;
    lines.push(`- ${t("qt.md.evaluator")}: ${e ? `${e.prompt_version} · ${e.model_id} · ${e.schema_version}${e.canary ? ` · ${t("qt.md.canary")}` : ""}` : t("qt.md.rulesOnly")}`);
    lines.push(`- ${t("qt.md.evaluation")}: \`${latest.evaluation_id}\` · ${t(`evs.${latest.status}`)}${latest.supersedes ? ` · ${t("qt.md.reeval")}` : ""}`);
    const codes = [...new Set(latest.confirmed_errors.map((x) => `${x.turn_id}:${x.error_code}`))];
    if (codes.length) lines.push(`- ${t("qt.md.errors")}: ${codes.join(", ")}`);
  } else if (card.evaluations) lines.push(`- ${t("qt.md.evaluator")}: —`);
  if (card.ai_calls?.length) {
    const by = new Map<string, { n: number; bad: number }>();
    for (const c of card.ai_calls) {
      const k = `${c.agent_id}${c.version != null ? ` v${c.version}` : ""} · ${c.model_id ?? "—"}${c.canary ? ` · ${t("qt.md.canary")}` : ""}`;
      const x = by.get(k) ?? { n: 0, bad: 0 };
      x.n++;
      if (c.status !== "ok") x.bad++;
      by.set(k, x);
    }
    lines.push(`- ${t("qt.md.calls")}: ${[...by.entries()].map(([k, x]) => `${k} ×${x.n}${x.bad ? ` (${t("qt.md.notOk", { n: x.bad })})` : ""}`).join("; ")}`);
  }
  const missing = (["lessons", "assessment", "ai-gateway"] as const).filter((b) => card.errors[b]);
  if (missing.length) lines.push(`- ${t("qt.md.missing", { s: missing.join(", ") })}`);
  lines.push("", `_${t("qt.md.noPii")}_`, "");
  return lines.join("\n");
}

export const taskFileName = (sessionId: string) => `tilhero-session-${sessionId.slice(0, 8)}.md`;

/* ---------------------------------------------------------------- misc */

/** Simple bar chart scale: a «nice» top (1, 2, 2.5, 5 × 10^k) at or above the max. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

/** Date window of the journal (yyyy-mm-dd, Tashkent): the last `days` days including today. */
export function lastDays(days: number, now = Date.now()): { from: string; to: string } {
  const day = (ms: number) => new Date(ms + 5 * 3_600_000).toISOString().slice(0, 10);
  return { from: day(now - (days - 1) * 86_400_000), to: day(now) };
}
