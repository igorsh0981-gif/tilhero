/**
 * Content model of the admin (sprint 3): pure helpers shared by the editors — kinds and key fields, RU/UZ walk of the
 * Localized texts, client-side checks that mirror the catalog rules (services/catalog domain/validation.py) for live
 * highlighting, sums of lesson minutes and rubric weights, transcript and rights checks of media, payload diff for the
 * review screen, audio upload checks and base64. The catalog stays the authority: its 422 CONTENT_INVALID {errors}
 * replaces these issues on save / validate / submit / publish.
 */
import type {
  AudienceSegment,
  Band,
  ContentKind,
  ControlItem,
  CoursePayload,
  GoalCode,
  LessonPayload,
  LessonStageType,
  Localized,
  MediaExercisePayload,
  MediaOrigin,
  MediaPayload,
  MediaRights,
  MediaType,
  MediaUse,
  ModulePayload,
  RubricCriterion,
  RubricPayload,
  ScenarioPayload,
  SkillArea,
  SkillPayload,
  TopicCode,
  TranscriptLine,
  VersionStatus,
} from "@tilhero/contracts/content";
import { analyzeScenario } from "./graph";

export type Kind = ContentKind;
export const KINDS: readonly ContentKind[] = ["course", "skill", "module", "lesson", "rubric", "scenario", "media_asset", "media_exercise"];
export const KEY_FIELD: Readonly<Record<ContentKind, string>> = {
  course: "course_id",
  skill: "skill_id",
  module: "module_id",
  lesson: "lesson_id",
  rubric: "rubric_id",
  scenario: "scenario_id",
  media_asset: "asset_id",
  media_exercise: "exercise_id",
};
export const BANDS: readonly Band[] = ["A0", "A1", "A2", "B1", "B2"];
export const AUDIENCES: readonly AudienceSegment[] = ["kids", "teens", "adults"];
export const GOALS: readonly GoalCode[] = ["work", "career", "travel", "daily", "study", "exam"];
export const TOPICS: readonly TopicCode[] = ["small_talk", "travel", "food", "shopping", "work", "interview", "study", "health", "home", "hobbies", "movies", "tech"];
export const STAGE_ORDER: readonly LessonStageType[] = ["retrieval", "explanation", "roleplay", "assessment", "summary"];
export const DURATIONS: readonly LessonPayload["duration_min"][] = [10, 15, 20, 30];
export const CONTROL_TYPES: readonly ControlItem["type"][] = ["single_choice", "gap_fill", "order_words", "translate_choice"];
export const SKILL_AREAS: readonly SkillArea[] = ["vocabulary", "grammar", "reading", "listening", "speaking", "writing", "function"];
export const RUBRIC_CODES: readonly RubricCriterion["code"][] = ["task", "vocabulary", "grammar", "independence", "pronunciation", "fluency", "comprehension"];
export const RUBRIC_TARGETS: readonly RubricPayload["applies_to"][number][] = ["lesson", "scenario", "media_exercise"];
export const MEDIA_TYPES: readonly MediaType[] = ["own_scene", "dialogue", "interview", "song", "movie"];
/** licensed / platform_embed: in the model, closed by the media.external_sources flag (owner + lawyer decision). */
export const MEDIA_ORIGINS: readonly MediaOrigin[] = ["own_recording", "public_domain", "open_license", "licensed", "platform_embed"];
export const EXTERNAL_ORIGINS: readonly MediaOrigin[] = ["licensed", "platform_embed"];
export const LICENSES: readonly MediaRights["license_type"][] = ["own", "cc0", "cc_by", "cc_by_sa", "public_domain", "contract"];
export const LICENSES_BY_ORIGIN: Readonly<Record<MediaOrigin, readonly MediaRights["license_type"][]>> = {
  own_recording: ["own"],
  public_domain: ["public_domain", "cc0"],
  open_license: ["cc0", "cc_by", "cc_by_sa"],
  licensed: ["contract"],
  platform_embed: ["contract"],
};
export const MEDIA_USES: readonly MediaUse[] = ["listen", "show_transcript", "exercises", "dictionary", "translation"];
export const EXERCISE_TYPES: readonly MediaExercisePayload["type"][] = ["comprehension", "gap_fill", "order_lines", "phrase_meaning", "shadowing", "roleplay"];
export const STATUSES: readonly VersionStatus[] = ["draft", "in_review", "approved", "published", "suspended", "archived"];
export const MEDIA_MIN_S = 5;
export const MEDIA_MAX_S = 90;
export const RIGHTS_WARN_DAYS = 14;

export const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const INTENT_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** C0/C1 controls, line separators, invisible and bidi characters (catalog content.py CONTROL_RE). */
// eslint-disable-next-line no-control-regex
export const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const CYRILLIC = /[\u0400-\u04ff]/;
const BAD_OKINA = /[oOgG]['\u2018\u2019`]/;

/* ---------------------------------------------------------------- issues */

/** One problem of a payload: the catalog ContentValidationError {path, code, message} or a client check (no message). */
export interface Issue {
  path: string;
  code: string;
  message?: string;
}
export type IssueMap = Record<string, Issue[]>;

export function byPath(list: readonly Issue[]): IssueMap {
  const out: IssueMap = {};
  for (const i of list) (out[i.path] ??= []).push(i);
  return out;
}

/** Issues at `path` itself or below it (`payload.stages` covers `payload.stages[1].minutes`). */
export function issuesUnder(map: IssueMap, prefix: string): Issue[] {
  const out: Issue[] = [];
  for (const [p, xs] of Object.entries(map)) if (p === prefix || p.startsWith(`${prefix}.`) || p.startsWith(`${prefix}[`)) out.push(...xs);
  return out;
}

/** «payload.nodes.n4.transitions[0].to» → itself, «…transitions[0]», «…transitions», «payload.nodes.n4», … «payload». */
export function pathPrefixes(path: string): string[] {
  const out: string[] = [path];
  let p = path;
  while (p) {
    const cut = Math.max(p.lastIndexOf("."), p.lastIndexOf("["));
    if (cut <= 0) break;
    p = p.slice(0, cut);
    out.push(p);
  }
  return out;
}

/** The scenario node a path points into (payload.nodes.<id>…), else null. */
export function nodeOfPath(path: string): string | null {
  const m = /^payload\.nodes\.([a-z0-9][a-z0-9._-]*?)(?:\.(?:speaker|line_en|gloss|hint|recovery_point|event|transitions|end)\b|$|\[)/.exec(path);
  return m?.[1] ?? null;
}

/** RU/UZ of a Localized leaf path (payload.title.uz → "uz"). */
export function langOfPath(path: string): "ru" | "uz" | null {
  const m = /\.(ru|uz)$/.exec(path);
  return (m?.[1] as "ru" | "uz" | undefined) ?? null;
}

/* ---------------------------------------------------------------- Localized */

export function isLocalized(v: unknown): v is Localized {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 2 && typeof (v as Localized).ru === "string" && typeof (v as Localized).uz === "string";
}

/** Every Localized text of a payload with its catalog path (payload.stages[0].instructions). */
export function localizedPaths(value: unknown, base = "payload"): Array<{ path: string; value: Localized }> {
  const out: Array<{ path: string; value: Localized }> = [];
  const walk = (v: unknown, p: string) => {
    if (isLocalized(v)) out.push({ path: p, value: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
  };
  walk(value, base);
  return out;
}

/** Empty RU / UZ texts (paths of the leaves) — the counters of the language tabs. */
export function missingByLang(payload: unknown): { ru: string[]; uz: string[] } {
  const out = { ru: [] as string[], uz: [] as string[] };
  for (const { path, value } of localizedPaths(payload)) {
    if (!value.ru.trim()) out.ru.push(`${path}.ru`);
    if (!value.uz.trim()) out.uz.push(`${path}.uz`);
  }
  return out;
}

/** LOCALE_MISSING / LOCALE_SCRIPT (UZ only in Latin, oʻ gʻ with U+02BB) / control characters. */
export function localeIssues(payload: unknown): Issue[] {
  const out: Issue[] = [];
  for (const { path, value } of localizedPaths(payload)) {
    for (const l of ["ru", "uz"] as const) {
      if (!value[l].trim()) out.push({ path: `${path}.${l}`, code: "LOCALE_MISSING" });
      else if (CONTROL_RE.test(value[l])) out.push({ path: `${path}.${l}`, code: "SCHEMA_INVALID" });
    }
    if (CYRILLIC.test(value.uz) || BAD_OKINA.test(value.uz)) out.push({ path: `${path}.uz`, code: "LOCALE_SCRIPT" });
  }
  return out;
}

export const L = (ru = "", uz = ""): Localized => ({ ru, uz });

/* ---------------------------------------------------------------- generic checks */

class Checks {
  readonly out: Issue[] = [];
  add(path: string, code: string) {
    this.out.push({ path, code });
  }
  count(path: string, n: number, lo: number, hi: number | null) {
    if (n < lo || (hi != null && n > hi)) this.add(path, "COUNT_OUT_OF_RANGE");
  }
  required(path: string, v: string | null | undefined) {
    if (!v || !v.trim()) this.add(path, "VALUE_REQUIRED");
  }
  unique(path: string, values: readonly unknown[]) {
    const seen = new Set<unknown>();
    values.forEach((v, i) => {
      if (seen.has(v)) this.add(`${path}[${i}]`, "DUPLICATE_ID");
      seen.add(v);
    });
  }
  audience(a: readonly string[]) {
    if (!a.length) this.add("payload.audience", "AUDIENCE_EMPTY");
  }
}

/* ---------------------------------------------------------------- lesson */

export const stagesSum = (stages: readonly { minutes: number }[]): number => stages.reduce((a, s) => a + (Number.isFinite(s.minutes) ? s.minutes : 0), 0);

export function controlItemIssues(it: ControlItem, path: string, c: Checks): void {
  c.required(`${path}.prompt_en`, it.prompt_en);
  if (!it.skill_id) c.add(`${path}.skill_id`, "VALUE_REQUIRED");
  const a = it.answer;
  if (it.type === "single_choice" || it.type === "translate_choice") {
    if (it.options.length < 2 || it.options.some((o) => !o.trim())) c.add(`${path}.options`, "ANSWER_INVALID");
    if (typeof a !== "number" || a < 0 || a >= Math.max(it.options.length, 1)) c.add(`${path}.answer`, "ANSWER_INVALID");
  } else if (it.type === "gap_fill") {
    if (!Array.isArray(a) || !a.length || a.some((x) => !x.trim())) c.add(`${path}.answer`, "ANSWER_INVALID");
  } else if (it.type === "order_words") {
    if (!Array.isArray(a) || a.length < 2) c.add(`${path}.answer`, "ANSWER_INVALID");
    else if (it.options.length && [...it.options].sort().join("\u0001") !== [...a].sort().join("\u0001")) c.add(`${path}.answer`, "ANSWER_INVALID");
  }
}

export function validateLesson(p: LessonPayload): Issue[] {
  const c = new Checks();
  c.audience(p.audience);
  if (!p.primary_skill_id) c.add("payload.primary_skill_id", "VALUE_REQUIRED");
  c.count("payload.secondary_skill_ids", p.secondary_skill_ids.length, 0, 3);
  c.unique("payload.secondary_skill_ids", p.secondary_skill_ids);
  p.secondary_skill_ids.forEach((s, i) => s === p.primary_skill_id && c.add(`payload.secondary_skill_ids[${i}]`, "DUPLICATE_ID"));
  if (p.stages.map((s) => s.type).join() !== STAGE_ORDER.join()) c.add("payload.stages", "STAGES_INVALID");
  p.stages.forEach((s, i) => (!Number.isInteger(s.minutes) || s.minutes < 1 || s.minutes > 10) && c.add(`payload.stages[${i}].minutes`, "STAGES_INVALID"));
  if (stagesSum(p.stages) !== p.duration_min) c.add("payload.stages", "STAGES_INVALID");
  c.count("payload.key_words", p.key_words.length, 4, 12);
  p.key_words.forEach((k, i) => {
    c.required(`payload.key_words[${i}].en`, k.en);
    c.required(`payload.key_words[${i}].example_en`, k.example_en);
  });
  c.count("payload.examples", p.examples.length, 2, 8);
  p.examples.forEach((e, i) => c.required(`payload.examples[${i}].en`, e.en));
  c.count("payload.hints", p.hints.length, 0, 5);
  if (!p.rubric_id) c.add("payload.rubric_id", "VALUE_REQUIRED");
  if (p.control_items.length < 3) c.add("payload.control_items", "NO_CONTROL_ITEMS");
  c.unique("payload.control_items", p.control_items.map((x) => x.item_id));
  p.control_items.forEach((it, i) => controlItemIssues(it, `payload.control_items[${i}]`, c));
  return [...localeIssues(p), ...c.out];
}

/* ---------------------------------------------------------------- rubric */

/** Sum of the weights rounded to 4 digits (0.1 + 0.2 = 0.3, not 0.30000000000000004). */
export const weightsSum = (criteria: readonly { weight: number }[]): number => Math.round(criteria.reduce((a, c) => a + (Number.isFinite(c.weight) ? c.weight : 0), 0) * 10_000) / 10_000;
export const weightsOk = (criteria: readonly { weight: number }[]): boolean => Math.abs(weightsSum(criteria) - 1) < 1e-6;

export function validateRubric(p: RubricPayload): Issue[] {
  const c = new Checks();
  c.count("payload.applies_to", p.applies_to.length, 1, null);
  c.count("payload.criteria", p.criteria.length, 2, null);
  c.unique("payload.criteria", p.criteria.map((x) => x.code));
  p.criteria.forEach((cr, i) => {
    if (!(cr.weight > 0 && cr.weight <= 1)) c.add(`payload.criteria[${i}].weight`, "RUBRIC_WEIGHTS");
    if (cr.bands.map((b) => b.score).join() !== "0,1,2,3") c.add(`payload.criteria[${i}].bands`, "RUBRIC_BANDS");
  });
  if (p.criteria.length && !weightsOk(p.criteria)) c.add("payload.criteria", "RUBRIC_WEIGHTS");
  if (!(p.pass_rule.min_weighted >= 0 && p.pass_rule.min_weighted <= 3)) c.add("payload.pass_rule.min_weighted", "VALUE_REQUIRED");
  return [...localeIssues(p), ...c.out];
}

/* ---------------------------------------------------------------- scenario */

export function validateScenario(p: ScenarioPayload): Issue[] {
  const c = new Checks();
  c.audience(p.audience);
  c.count("payload.characters", p.characters.length, 1, null);
  c.unique("payload.characters", p.characters.map((x) => x.id));
  c.count("payload.nodes", Object.keys(p.nodes).length, 5, 30);
  for (const [id, n] of Object.entries(p.nodes)) {
    const path = `payload.nodes.${id}`;
    c.required(`${path}.line_en`, n.line_en);
    if (n.end && n.transitions.length) c.add(`${path}.transitions`, "END_HAS_TRANSITIONS");
    n.transitions.forEach((t, i) => {
      if (!INTENT_RE.test(t.intent)) c.add(`${path}.transitions[${i}].intent`, "VALUE_REQUIRED");
      c.count(`${path}.transitions[${i}].examples_en`, t.examples_en.length, 1, 4);
      t.examples_en.forEach((x, j) => c.required(`${path}.transitions[${i}].examples_en[${j}]`, x));
    });
  }
  if (!p.rubric_id) c.add("payload.rubric_id", "VALUE_REQUIRED");
  for (const i of analyzeScenario(p).issues) {
    const path = i.node_id ? `payload.nodes.${i.node_id}` : i.code === "START_MISSING" ? "payload.start_node" : "payload.nodes";
    c.add(path, i.code);
  }
  return [...localeIssues(p), ...c.out];
}

/* ---------------------------------------------------------------- media */

/** Today's date in Asia/Tashkent (the catalog tick and the rights checks count days there). */
export function todayTashkent(now: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (s: string | null | undefined): s is string => !!s && ISO_DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** «expired» — valid_to already passed, «expiring» — within 14 days (the overview warning), «open» — no end date. */
export function rightsState(validTo: string | null, today: string, warnDays = RIGHTS_WARN_DAYS): "ok" | "expiring" | "expired" | "open" {
  if (!validTo) return "open";
  if (validTo < today) return "expired";
  return validTo <= addDays(today, warnDays) ? "expiring" : "ok";
}

export function transcriptIssues(lines: readonly TranscriptLine[], durationS: number): Issue[] {
  const out: Issue[] = [];
  const limit = durationS * 1000;
  if (!lines.length) out.push({ path: "payload.transcript", code: "TRANSCRIPT_INVALID" });
  let prevEnd = -1;
  lines.forEach((l, i) => {
    const path = `payload.transcript[${i}]`;
    const bad = (field: string) => out.push({ path: `${path}.${field}`, code: "TRANSCRIPT_INVALID" });
    if (!(l.t_start_ms < l.t_end_ms)) bad("t_end_ms");
    if (l.t_end_ms > limit) bad("t_end_ms");
    if (l.t_start_ms < prevEnd) bad("t_start_ms");
    prevEnd = Math.max(prevEnd, l.t_end_ms);
    if (!l.speaker.trim()) bad("speaker");
    if (!l.text_en.trim()) bad("text_en");
  });
  return out;
}

export function rightsIssues(p: MediaPayload, today: string): Issue[] {
  const r = p.rights;
  const out: Issue[] = [];
  const need = (field: string) => out.push({ path: `payload.rights.${field}`, code: "RIGHTS_REQUIRED" });
  if (!r.owner.trim()) need("owner");
  if (!(LICENSES_BY_ORIGIN[p.origin] ?? []).includes(r.license_type)) need("license_type");
  if ((r.license_type === "cc_by" || r.license_type === "cc_by_sa") && !(r.attribution ?? "").trim()) need("attribution");
  if (r.license_type === "contract" && !(r.license_ref ?? "").trim()) need("license_ref");
  if (!r.territories.includes("UZ")) need("territories");
  if (!r.allowed_uses.length) need("allowed_uses");
  if (!isIsoDate(r.valid_from)) need("valid_from");
  if (r.valid_to != null) {
    if (!isIsoDate(r.valid_to)) need("valid_to");
    else if (r.valid_to < r.valid_from || r.valid_to < today) need("valid_to");
  }
  return out;
}

export function validateMedia(p: MediaPayload, today: string = todayTashkent()): Issue[] {
  const c = new Checks();
  c.audience(p.audience);
  if (p.duration_s > MEDIA_MAX_S) c.add("payload.duration_s", "MEDIA_TOO_LONG");
  else if (p.duration_s < MEDIA_MIN_S) c.add("payload.duration_s", "MEDIA_TOO_SHORT");
  if (EXTERNAL_ORIGINS.includes(p.origin) || p.embed) c.add("payload.origin", "EXTERNAL_SOURCE_DISABLED");
  p.phrases.forEach((ph, i) => {
    c.required(`payload.phrases[${i}].en`, ph.en);
    if (ph.t_ms > p.duration_s * 1000) c.add(`payload.phrases[${i}].t_ms`, "TRANSCRIPT_INVALID");
  });
  return [...localeIssues(p), ...c.out, ...transcriptIssues(p.transcript, p.duration_s), ...rightsIssues(p, today)];
}

export function validateExercise(p: MediaExercisePayload): Issue[] {
  const c = new Checks();
  if (!p.asset_id) c.add("payload.asset_id", "VALUE_REQUIRED");
  if (!p.skill_id) c.add("payload.skill_id", "VALUE_REQUIRED");
  const a = p.answer;
  if (p.type === "comprehension" || p.type === "phrase_meaning") {
    c.required("payload.prompt_en", p.prompt_en);
    if (p.options.length < 2) c.add("payload.options", "ANSWER_INVALID");
    if (typeof a !== "number" || a < 0 || a >= Math.max(p.options.length, 1)) c.add("payload.answer", "ANSWER_INVALID");
  } else if (p.type === "gap_fill") {
    if (!(p.prompt_en ?? "").includes("___")) c.add("payload.prompt_en", "ANSWER_INVALID");
    if (!Array.isArray(a) || !a.length || a.some((x) => typeof x !== "string" || !x.trim())) c.add("payload.answer", "ANSWER_INVALID");
  } else if (p.type === "order_lines") {
    if (p.options.length < 2) c.add("payload.options", "ANSWER_INVALID");
    const idx = Array.isArray(a) ? a.filter((x): x is number => typeof x === "number") : [];
    if (idx.length !== p.options.length || [...idx].sort((x, y) => x - y).join() !== p.options.map((_, i) => i).join()) c.add("payload.answer", "ANSWER_INVALID");
  } else if (p.type === "shadowing") {
    if (p.line_index == null) c.add("payload.line_index", "ANSWER_INVALID");
    if (a != null) c.add("payload.answer", "ANSWER_INVALID");
  } else if (p.type === "roleplay" && a != null) c.add("payload.answer", "ANSWER_INVALID");
  return [...localeIssues(p), ...c.out];
}

/* ---------------------------------------------------------------- course, module, skill */

/** A cycle of prerequisites through `me` (me → … → me), else null. `graph` — prerequisites of the other skills. */
export function prereqCycle(graph: Readonly<Record<string, readonly string[]>>, me: string, mine: readonly string[]): string[] | null {
  const g: Record<string, readonly string[]> = { ...graph, [me]: mine.filter((x) => x !== me) };
  const stack: Array<[string, string[]]> = (g[me] ?? []).map((x) => [x, [me, x]]);
  const seen = new Set<string>();
  while (stack.length) {
    const [node, path] = stack.pop()!;
    if (node === me) return path;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const nxt of g[node] ?? []) stack.push([nxt, [...path, nxt]]);
  }
  return null;
}

export function validateSkill(p: SkillPayload, others: Readonly<Record<string, readonly string[]>> = {}): Issue[] {
  const c = new Checks();
  c.unique("payload.prerequisites", p.prerequisites);
  p.prerequisites.forEach((x, i) => x === p.skill_id && c.add(`payload.prerequisites[${i}]`, "PREREQ_CYCLE"));
  if (prereqCycle(others, p.skill_id, p.prerequisites)) c.add("payload.prerequisites", "PREREQ_CYCLE");
  c.unique("payload.diagnostic_tags", p.diagnostic_tags);
  return [...localeIssues(p), ...c.out];
}

export function validateModule(p: ModulePayload): Issue[] {
  const c = new Checks();
  c.count("payload.lesson_ids", p.lesson_ids.length, 1, null);
  c.unique("payload.lesson_ids", p.lesson_ids);
  return [...localeIssues(p), ...c.out];
}

export function validateCourse(p: CoursePayload): Issue[] {
  const c = new Checks();
  c.count("payload.module_ids", p.module_ids.length, 1, null);
  c.unique("payload.module_ids", p.module_ids);
  if (BANDS.indexOf(p.level_start) > BANDS.indexOf(p.level_end)) c.add("payload.level_end", "LEVEL_RANGE");
  return [...localeIssues(p), ...c.out];
}

export interface ValidateCtx {
  today?: string;
  /** prerequisites of the other skills of the course (cycle check) */
  skills?: Readonly<Record<string, readonly string[]>>;
}

export function validatePayload(kind: ContentKind, p: unknown, ctx: ValidateCtx = {}): Issue[] {
  switch (kind) {
    case "lesson":
      return validateLesson(p as LessonPayload);
    case "rubric":
      return validateRubric(p as RubricPayload);
    case "scenario":
      return validateScenario(p as ScenarioPayload);
    case "media_asset":
      return validateMedia(p as MediaPayload, ctx.today);
    case "media_exercise":
      return validateExercise(p as MediaExercisePayload);
    case "skill":
      return validateSkill(p as SkillPayload, ctx.skills);
    case "module":
      return validateModule(p as ModulePayload);
    case "course":
      return validateCourse(p as CoursePayload);
  }
}

/** The key (lesson_id, asset_id, …) of a payload. */
export const keyOf = (kind: ContentKind, p: unknown): string => String((p as Record<string, unknown> | null)?.[KEY_FIELD[kind]] ?? "");

/* ---------------------------------------------------------------- new payloads */

export interface NewCtx {
  course_id?: string;
  pair_id?: string;
  module_id?: string;
  rubric_id?: string;
  asset_id?: string;
}

export function emptyPayload(kind: ContentKind, key: string, x: NewCtx = {}): Record<string, unknown> {
  const course = x.course_id ?? "en-core";
  switch (kind) {
    case "course":
      return { course_id: key, pair_id: x.pair_id ?? "ru-en", title: L(), description: L(), level_start: "A0", level_end: "A2", module_ids: [] } satisfies CoursePayload;
    case "skill":
      return { skill_id: key, course_id: course, area: "function", title: L(), description: L(), level: "A1", prerequisites: [], rubric_id: null, diagnostic_tags: [] } satisfies SkillPayload;
    case "module":
      return { module_id: key, course_id: course, title: L(), goal: L(), theme: "small_talk", lesson_ids: [] } satisfies ModulePayload;
    case "lesson":
      return {
        lesson_id: key,
        course_id: course,
        module_id: x.module_id ?? "",
        title: L(),
        goal: L(),
        level: "A1",
        kind: "core",
        audience: ["teens", "adults"],
        goals: [],
        topics: [],
        primary_skill_id: "",
        secondary_skill_ids: [],
        prerequisite_skill_ids: [],
        duration_min: 20,
        stages: STAGE_ORDER.map((type, i) => ({ type, minutes: [3, 5, 6, 4, 2][i]!, instructions: L() })),
        key_words: [],
        examples: [],
        scenario_id: null,
        rubric_id: x.rubric_id ?? "",
        control_items: [],
        hints: [],
      } satisfies LessonPayload;
    case "rubric":
      return {
        rubric_id: key,
        title: L(),
        applies_to: ["lesson"],
        criteria: (["task", "vocabulary"] as const).map((code) => ({ code, title: L(), weight: 0.5, bands: ([0, 1, 2, 3] as const).map((score) => ({ score, descriptor: L() })) })),
        pass_rule: { min_weighted: 1.5, min_per_criterion: 1 },
      } satisfies RubricPayload;
    case "scenario":
      return {
        scenario_id: key,
        title: L(),
        task: L(),
        goals: [],
        topics: [],
        level: "A1",
        difficulty: 2,
        audience: ["teens", "adults"],
        access: "free",
        characters: [{ id: "host", name: "Alex", role: L(), voice: "en-GB" }],
        start_node: "start",
        nodes: {
          start: { speaker: "host", line_en: "", gloss: L(), hint: null, recovery_point: true, event: null, transitions: [{ intent: "greet", description: L(), examples_en: [""], to: "end" }], end: null },
          end: { speaker: "host", line_en: "", gloss: L(), hint: null, recovery_point: false, event: null, transitions: [], end: { outcome: "success", summary: L() } },
        },
        completion: { criteria: L() },
        skill_ids: [],
        rubric_id: x.rubric_id ?? "",
      } satisfies ScenarioPayload;
    case "media_asset":
      return {
        asset_id: key,
        type: "own_scene",
        origin: "own_recording",
        title: L(),
        original_title: null,
        language: "en",
        level: "A1",
        topics: [],
        skill_ids: [],
        audience: ["teens", "adults"],
        duration_s: 30,
        transcript: [],
        phrases: [],
        audio_blob_id: null,
        embed: null,
        rights: { owner: "TilHero", license_type: "own", license_ref: null, attribution: null, territories: ["UZ"], valid_from: todayTashkent(), valid_to: null, allowed_uses: ["listen", "show_transcript", "exercises"] },
      } satisfies MediaPayload;
    case "media_exercise":
      return { exercise_id: key, asset_id: x.asset_id ?? "", type: "comprehension", skill_id: "", level: "A1", instruction: L(), prompt_en: "", options: ["", ""], answer: 0, line_index: null, rubric_id: null } satisfies MediaExercisePayload;
  }
}

/* ---------------------------------------------------------------- diff (review screen) */

/** Leaves of a JSON value by catalog path: strings as-is, other scalars as JSON, empty arrays/objects as «[]»/«{}». */
export function flatten(value: unknown, base = "payload"): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) {
      if (!v.length) out[p] = "[]";
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
    } else if (v && typeof v === "object") {
      const e = Object.entries(v);
      if (!e.length) out[p] = "{}";
      for (const [k, x] of e) walk(x, `${p}.${k}`);
    } else out[p] = typeof v === "string" ? v : JSON.stringify(v);
  };
  walk(value, base);
  return out;
}

export interface DiffRow {
  path: string;
  before: string | null;
  after: string | null;
  lang: "ru" | "uz" | null;
}

/** Changed leaves between the published payload (null — nothing published yet) and the version under review. */
export function diffPayload(before: unknown, after: unknown): DiffRow[] {
  const a = before == null ? {} : flatten(before);
  const b = flatten(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const order = Object.keys(b);
  keys.sort((x, y) => {
    const ix = order.indexOf(x);
    const iy = order.indexOf(y);
    return (ix < 0 ? 1e9 : ix) - (iy < 0 ? 1e9 : iy) || x.localeCompare(y);
  });
  return keys.filter((k) => a[k] !== b[k]).map((k) => ({ path: k, before: a[k] ?? null, after: b[k] ?? null, lang: langOfPath(k) }));
}

export const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/* ---------------------------------------------------------------- audio upload */

export const AUDIO_MAX_BYTES = 3 * 1024 * 1024;
export type AudioType = "audio/mpeg" | "audio/ogg" | "audio/mp4";
const BY_EXT: Record<string, AudioType> = { mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4" };

/** File type by its signature: ID3 tag / MPEG frame sync → mp3, «OggS» → ogg, «ftyp» at offset 4 → m4a. */
export function sniffAudio(head: Uint8Array): AudioType | null {
  const s = (o: number, n: number) => String.fromCharCode(...head.slice(o, o + n));
  if (head.length >= 3 && s(0, 3) === "ID3") return "audio/mpeg";
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  if (head.length >= 4 && s(0, 4) === "OggS") return "audio/ogg";
  if (head.length >= 8 && s(4, 4) === "ftyp") return "audio/mp4";
  return null;
}

export type AudioCheck = { ok: true; content_type: AudioType } | { ok: false; reason: "type" | "size" | "empty" | "signature" };

/** mp3 / ogg / m4a ≤ 3 MB whose bytes really are that type (the catalog re-checks: 422 AUDIO_INVALID). */
export function checkAudio(file: { name: string; size: number; type?: string }, head: Uint8Array): AudioCheck {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const want = BY_EXT[ext];
  if (!want) return { ok: false, reason: "type" };
  if (!file.size) return { ok: false, reason: "empty" };
  if (file.size > AUDIO_MAX_BYTES) return { ok: false, reason: "size" };
  if (sniffAudio(head) !== want) return { ok: false, reason: "signature" };
  return { ok: true, content_type: want };
}

/** Standard base64 of bytes (chunked: no call-stack overflow on 3 MB). */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}

/* ---------------------------------------------------------------- time of transcripts */

/** 3500 → «3.5» (seconds, one decimal is enough for the editor; ms kept when finer). */
export function msToSec(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s * 10) ? s.toFixed(1) : String(s);
}

/** «3.5» / «3,5» / «0:03.5» → 3500; invalid → null. */
export function secToMs(v: string): number | null {
  const t = v.trim().replace(",", ".");
  const m = /^(?:(\d+):)?(\d+(?:\.\d{1,3})?)$/.exec(t);
  if (!m) return null;
  const sec = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  return Number.isFinite(sec) ? Math.round(sec * 1000) : null;
}

/* ---------------------------------------------------------------- answers of control items (editor helpers) */

/** «is, 's» → ["is", "'s"]: accepted answers of a gap. */
export const splitAnswers = (s: string): string[] => s.split(/[,\n;]/).map((x) => x.trim()).filter(Boolean);
/** «Nice to meet you» → words of order_words. */
export const splitWords = (s: string): string[] => s.split(/\s+/).map((x) => x.trim()).filter(Boolean);

/** Readable key of a control item / exercise answer for the reviewer («B: Good morning!», «is / 's»). */
export function answerText(type: string, options: readonly string[], answer: unknown): string {
  if (typeof answer === "number") return `${String.fromCharCode(65 + answer)}: ${options[answer] ?? "?"}`;
  if (Array.isArray(answer)) {
    if (type === "order_lines") return answer.map((i) => (typeof i === "number" ? i + 1 : String(i))).join(" → ");
    return answer.map(String).join(type === "order_words" ? " " : " / ");
  }
  return "—";
}
