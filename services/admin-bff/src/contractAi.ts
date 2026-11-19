/**
 * Кодеки ответов ai-gateway, lessons и assessment по admin.ts «ИИ, контроль диалогов, затраты» и ai.ts (спринт 4) —
 * как contract.ts: проверка значения домена (испорченное → 503 UPSTREAM_UNAVAILABLE) и схема ответа admin-bff (лишние
 * поля отбрасываются).
 *
 * Формы доменов = admin.ts без `*_name`: вместо имён — идентификаторы сотрудников (`published_by`, `author_id`,
 * `created_by`, `taken_by`, `decided_by`, `flags[].by`). Имена подставляет `withNames` (admin-identity staff/lookup),
 * идентификаторы, которых нет в контракте, клиенту не уходят (`public*`). Служебный автор сида
 * `00000000-0000-4000-a000-000000005eed` — «Сид (начальное наполнение)» (context.ts SYSTEM_ACTOR_NAMES).
 *
 * JSON Schema вывода версии агента и вход золотого теста (`input.context`) — JSON-объекты как есть: их проверяет
 * ai-gateway. Ключ провайдера ИИ — только переменная ai-gateway: любой ответ ai-gateway (в т. ч. тело ошибки),
 * в котором есть поле с именем ключа или строка вида ключа Anthropic, не уходит клиенту (`assertNoProviderKey` → 503,
 * в лог — только путь, без значения).
 */
import type {
  AdminAppeal,
  AiCall,
  AiUsageSummary,
  AgentDetail,
  AgentRow,
  AgentVersionRow,
  AgentVersionView,
  EvaluationCard,
  LessonStats,
  Period,
  SessionCard,
  SessionFlag,
  SessionRow,
  Transcript,
} from "@tilhero/contracts/admin";
import type {
  Agent,
  AgentId,
  AgentRollout,
  AiBudget,
  AiModel,
  AiProviderStatus,
  ConfirmedError,
  GoldenCase,
  GoldenCheck,
  RubricCriterionCode,
  SessionKind,
  TestRun,
  TestRunSummary,
} from "@tilhero/contracts/ai";
import type { AudienceSegment, Band } from "@tilhero/contracts/content";
import { BadValue, C, CONTRACT_REQUIRED, bad, itemsOf, pageOf, type Codec, type Schema } from "./codec.js";
import {
  AGENT_IDS as AGENT_IDS_IN,
  APPEAL_STATUSES,
  AUDIENCE_SEGMENTS as AUDIENCES_IN,
  BANDS,
  ERROR_SEVERITIES,
  RUBRIC_CRITERIA as CRITERIA_IN,
  SESSION_FLAGS as FLAGS_IN,
  SESSION_KINDS as KINDS_IN,
  SESSION_OUTCOMES,
  SESSION_STATUSES,
  SKILL_OUTCOMES,
} from "./schemas.js";

// ---------------------------------------------------------------- перечисления: вход (schemas.ts) = ai.ts / admin.ts

type Exact<T extends string, L extends readonly string[]> = [Exclude<T, L[number]>] extends [never] ? true : Exclude<T, L[number]>;
export const AGENT_IDS = AGENT_IDS_IN satisfies readonly AgentId[];
const AUDIENCES = AUDIENCES_IN satisfies readonly AudienceSegment[];
const CRITERIA = CRITERIA_IN satisfies readonly RubricCriterionCode[];
const SESSION_KINDS = KINDS_IN satisfies readonly SessionKind[];
const SESSION_FLAGS = FLAGS_IN satisfies readonly SessionFlag[];
const STATUSES = SESSION_STATUSES satisfies readonly SessionRow["status"][];
const OUTCOMES = SESSION_OUTCOMES satisfies readonly NonNullable<SessionRow["outcome"]>[];
const APPEAL_ST = APPEAL_STATUSES satisfies readonly AdminAppeal["status"][];
const SKILL_OUT = SKILL_OUTCOMES satisfies readonly EvaluationCard["skill_outcomes"][number]["outcome"][];
const SEVERITIES = ERROR_SEVERITIES satisfies readonly ConfirmedError["severity"][];
const _exact: [
  Exact<AgentId, typeof AGENT_IDS>,
  Exact<AudienceSegment, typeof AUDIENCES>,
  Exact<RubricCriterionCode, typeof CRITERIA>,
  Exact<SessionKind, typeof SESSION_KINDS>,
  Exact<SessionFlag, typeof SESSION_FLAGS>,
  Exact<SessionRow["status"], typeof STATUSES>,
  Exact<NonNullable<SessionRow["outcome"]>, typeof OUTCOMES>,
  Exact<AdminAppeal["status"], typeof APPEAL_ST>,
  Exact<EvaluationCard["skill_outcomes"][number]["outcome"], typeof SKILL_OUT>,
  Exact<ConfirmedError["severity"], typeof SEVERITIES>,
] = [true, true, true, true, true, true, true, true, true, true];
void _exact;

// ---------------------------------------------------------------- ключ провайдера ИИ

/** Имя поля, похожее на ключ или секрет (ai-gateway такие поля не отдаёт никогда). `key_configured` — не ключ. */
const KEY_FIELD_RE = /(?:^|[_-])(?:api[_-]?key|x[_-]api[_-]key|secret|password|authorization|private[_-]?key)$|^anthropic[_-]?(?:api[_-]?)?key$/i;
/**
 * Строка вида ключа провайдера (Anthropic `sk-ant-…`, любые `sk-` с длинным хвостом) — отдельным словом: упоминание
 * «sk-» в правилах и слова вроде «task-…», «ask-for-…» (идентификаторы сценариев) ключом не считаются.
 */
const KEY_VALUE_RE = /(?<![A-Za-z0-9_-])sk-(?:ant-)?[A-Za-z0-9_-]{20,}/;

/** Путь первого поля, похожего на ключ провайдера, или null. Обход ограничен глубиной (ответы ai-gateway неглубокие). */
export function findProviderKey(v: unknown, path = "$", depth = 0): string | null {
  if (depth > 40) return path;
  if (typeof v === "string") return KEY_VALUE_RE.test(v) ? path : null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = findProviderKey(v[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = `${path}.${k.slice(0, 40)}`;
      if (KEY_FIELD_RE.test(k) || KEY_VALUE_RE.test(k)) return p;
      const hit = findProviderKey(x, p, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------- общие

const COUNT = C.int(0);
const ID64 = C.str(64, 1);
const N_ID64 = C.nullable(ID64);
const N_TIME = C.nullable(C.time);
const USD = C.num(0, 1e9);
const PCT = C.num(0, 100);
const VERSION_NO = C.int(1);
const KEY = C.id(/^[a-z0-9][a-z0-9._-]{1,63}$/, 64);
const BAND = C.oneOf<Band>(BANDS);
const AGENT_ID = C.oneOf<AgentId>(AGENT_IDS);
export const MODEL = C.id(/^[a-z0-9][a-z0-9._-]{1,63}$/, 64);
const CASE_ID = C.id(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, 64);
const LOCALIZED = C.obj<{ ru: string; uz: string }>({ ru: C.str(1000), uz: C.str(1000) });
/** Идентификатор реплики или задания: T{n}, s{n}, item_id каталога. */
const REF = C.id(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, 64);
/** Сотрудник-автор: UUID или «system» (оценка системой); имя — через lookup. */
const STAFF_REF = C.nullable(C.id(/^(?:system|[0-9a-fA-F-]{36})$/, 36));

// ---------------------------------------------------------------- агенты (ai-gateway)

const AGENT_PROPS = {
  agent_id: AGENT_ID,
  title: LOCALIZED,
  purpose: LOCALIZED,
  owner_role: C.str(64, 1),
  implementation: C.oneOf(["llm", "rules", "code"] as const),
  availability: C.oneOf(["active", "planned"] as const),
  planned_sprint: C.nullable(C.int(1, 99)),
  free_text: C.bool,
  implemented_in: C.nullable(C.str(64)),
};
export const AGENT: Codec<Agent> = C.obj<Agent>(AGENT_PROPS);

export const ROLLOUT: Codec<AgentRollout> = C.obj<AgentRollout>({
  agent_id: AGENT_ID,
  published_version: C.nullable(VERSION_NO),
  canary_version: C.nullable(VERSION_NO),
  canary_percent: C.int(0, 50),
  previous_version: C.nullable(VERSION_NO),
});

const PROVIDER = C.oneOf(["anthropic", "fake"] as const);
const RUN_PROPS = {
  run_id: C.uuid,
  agent_id: AGENT_ID,
  version: VERSION_NO,
  status: C.oneOf(["running", "finished", "failed"] as const),
  provider: PROVIDER,
  passed: COUNT,
  failed: COUNT,
  passed_mandatory: C.bool,
  cost_usd: USD,
  started_at: C.time,
  finished_at: N_TIME,
};
export const TEST_RUN_SUMMARY: Codec<TestRunSummary> = C.obj<TestRunSummary>(RUN_PROPS);
export const TEST_RUN: Codec<TestRun> = C.obj<TestRun>({
  ...RUN_PROPS,
  results: C.arr(
    C.obj<TestRun["results"][number]>({
      case_id: CASE_ID,
      title: C.text(200),
      mandatory: C.bool,
      passed: C.bool,
      failures: C.arr(C.text(500), 50),
      // проверки, не выполненные на этом провайдере (fake: содержимое output.*) — ai.ts, уточнение координатора
      skipped: C.fallback(C.arr(C.text(500), 50), []),
      latency_ms: COUNT,
      cost_usd: USD,
    }),
    500,
  ),
});

/** published от домена: + published_by (id) → published_by_name; в ответ — без published_by. */
type PublishedDomain = NonNullable<AgentRow["published"]> & { published_by: string | null };
const PUBLISHED_DOMAIN: Codec<PublishedDomain> = C.obj<PublishedDomain>({
  version: VERSION_NO,
  model_id: MODEL,
  published_at: C.time,
  // только для имени: нет поля — имя null (экран не ломается)
  published_by: C.fallback(N_ID64, null),
  published_by_name: C.name,
});
const PUBLISHED: Codec<NonNullable<AgentRow["published"]>> = C.obj<NonNullable<AgentRow["published"]>>({
  version: VERSION_NO,
  model_id: MODEL,
  published_at: C.time,
  published_by_name: C.name,
});

const ROW_PROPS = {
  ...AGENT_PROPS,
  rollout: C.nullable(ROLLOUT),
  draft_version: C.nullable(VERSION_NO),
  last_test_run: C.nullable(TEST_RUN_SUMMARY),
  calls_7d: COUNT,
  unavailable_pct_7d: C.nullable(PCT),
};
export const AGENT_ROW: Codec<AgentRow> = C.obj<AgentRow>({ ...ROW_PROPS, published: C.nullable(PUBLISHED) });
export type AgentRowDomain = Omit<AgentRow, "published"> & { published: PublishedDomain | null };
export const AGENT_ROW_DOMAIN: Codec<AgentRowDomain> = C.obj<AgentRowDomain>({ ...ROW_PROPS, published: C.nullable(PUBLISHED_DOMAIN) });
export const AGENT_ROWS = itemsOf(AGENT_ROW, 50);
export const AGENT_ROWS_DOMAIN = itemsOf(AGENT_ROW_DOMAIN, 50);

export function publicAgentRow(r: AgentRowDomain): AgentRow {
  if (!r.published) return { ...r, published: null };
  const { published_by: _drop, ...published } = r.published;
  return { ...r, published };
}

const VERSION_STATUS = C.oneOf(["draft", "published", "archived"] as const);
const VERSION_ROW_PROPS = {
  version: VERSION_NO,
  status: VERSION_STATUS,
  model_id: MODEL,
  author_name: C.name,
  created_at: C.time,
  published_at: N_TIME,
  published_by_name: C.name,
  last_test_run: C.nullable(TEST_RUN_SUMMARY),
  canary: C.bool,
};
export const AGENT_VERSION_ROW: Codec<AgentVersionRow> = C.obj<AgentVersionRow>(VERSION_ROW_PROPS);
export type AgentVersionRowDomain = AgentVersionRow & { author_id: string | null; published_by: string | null };
const AGENT_VERSION_ROW_DOMAIN: Codec<AgentVersionRowDomain> = C.obj<AgentVersionRowDomain>({
  ...VERSION_ROW_PROPS,
  // только для имён: нет поля — имя null
  author_id: C.fallback(N_ID64, null),
  published_by: C.fallback(N_ID64, null),
});

/** GET /admin/v1/ai/agents/{agent_id} → AgentDetail (admin.ts). */
export type AgentDetailDomain = AgentRowDomain & { versions: AgentVersionRowDomain[] };
export const AGENT_DETAIL: Codec<AgentDetail> = C.obj<AgentDetail>({
  ...ROW_PROPS,
  published: C.nullable(PUBLISHED),
  versions: C.arr(AGENT_VERSION_ROW, 1000),
});
export const AGENT_DETAIL_DOMAIN: Codec<AgentDetailDomain> = C.obj<AgentDetailDomain>({
  ...ROW_PROPS,
  published: C.nullable(PUBLISHED_DOMAIN),
  versions: C.arr(AGENT_VERSION_ROW_DOMAIN, 1000),
});

export function publicAgentDetail(d: AgentDetailDomain): AgentDetail {
  const { versions, ...row } = d;
  return {
    ...publicAgentRow(row),
    versions: versions.map(({ author_id: _a, published_by: _p, ...v }) => v),
  };
}

const AGENT_VERSION_PROPS = {
  agent_id: AGENT_ID,
  version: VERSION_NO,
  status: VERSION_STATUS,
  // правят методисты: как есть (длины ai.ts), управляющие символы не вычищаются — это текст инструкции
  instructions: C.str(20_000),
  rules: C.str(10_000),
  output_schema: C.json(262_144),
  schema_version: C.str(64, 1),
  model_id: MODEL,
  fallback_model_id: C.nullable(MODEL),
  temperature: C.num(0, 1),
  max_output_tokens: C.int(1, 2000),
  timeout_ms: C.int(2000, 30_000),
  max_cost_usd: C.num(0, 10),
  notes: C.nullable(C.str(2000)),
  author_id: ID64,
  created_at: C.time,
  // If-Match правки черновика (без него ai-gateway → 428 IF_MATCH_REQUIRED)
  updated_at: C.time,
  // версия на канарейке (заморожена)
  canary: C.bool,
  published_by: N_ID64,
  published_at: N_TIME,
  last_test_run: C.nullable(TEST_RUN_SUMMARY),
};
/** GET | POST | PATCH версии → AgentVersionView (admin.ts): имена автора и публикатора — через lookup. */
export const AGENT_VERSION_VIEW: Codec<AgentVersionView> = C.obj<AgentVersionView>({
  ...AGENT_VERSION_PROPS,
  author_name: C.name,
  published_by_name: C.name,
});

// ---------------------------------------------------------------- золотые тесты

const PATH_RE = /^[A-Za-z0-9_$.[\]-]{1,200}$/;
const scalar = (v: unknown, p: string): string | number | boolean | null =>
  v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 1000)
    ? (v as string | number | boolean | null)
    : bad(p);
const SCALAR_SCHEMA: Schema = { type: ["string", "number", "boolean", "null"] };
/** GoldenCheck (ai.ts): ровно поля своего вида; неизвестный вид → ошибка. */
export const GOLDEN_CHECK: Codec<GoldenCheck> = C.custom<GoldenCheck>(
  {
    type: "object",
    properties: {
      kind: { type: "string" },
      path: { type: "string" },
      value: SCALAR_SCHEMA,
      values: { type: "array", items: SCALAR_SCHEMA },
      n: { type: "integer" },
    },
    [CONTRACT_REQUIRED]: ["kind"],
  },
  (v, p) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return bad(p);
    const o = v as Record<string, unknown>;
    const path = (): string => (typeof o.path === "string" && PATH_RE.test(o.path) ? o.path : bad(`${p}.path`));
    const list = <T>(f: (x: unknown, q: string) => T): T[] =>
      Array.isArray(o.values) && o.values.length >= 1 && o.values.length <= 50 ? o.values.map((x, i) => f(x, `${p}.values[${i}]`)) : bad(`${p}.values`);
    switch (o.kind) {
      case "schema_valid":
        return { kind: "schema_valid" };
      case "field_equals":
        return { kind: "field_equals", path: path(), value: scalar(o.value, `${p}.value`) };
      case "field_in":
        return { kind: "field_in", path: path(), values: list(scalar) };
      case "field_absent":
        return { kind: "field_absent", path: path() };
      case "text_not_contains":
        return { kind: "text_not_contains", path: path(), values: list((x, q) => (typeof x === "string" && x.length <= 200 ? x : bad(q))) };
      case "max_length":
        return { kind: "max_length", path: path(), n: C.int(1, 100_000).parse(o.n, `${p}.n`) };
      default:
        return bad(`${p}.kind`);
    }
  },
);

export const GOLDEN_CASE: Codec<GoldenCase> = C.obj<GoldenCase>({
  case_id: CASE_ID,
  agent_id: AGENT_ID,
  title: C.text(200),
  input: C.obj<GoldenCase["input"]>({
    audience: C.oneOf(AUDIENCES),
    // контекст агента — JSON-объект как есть (проверяет ai-gateway)
    context: C.json(65_536) as unknown as Codec<GoldenCase["input"]["context"]>,
  }),
  checks: C.arr(GOLDEN_CHECK, 50),
  mandatory: C.bool,
  created_by: ID64,
  created_at: C.time,
  archived_at: N_TIME,
});
export const GOLDEN_CASES = itemsOf(GOLDEN_CASE, 500);

// ---------------------------------------------------------------- модели, провайдер, бюджет, затраты

export const AI_MODEL: Codec<AiModel> = C.obj<AiModel>({
  model_id: MODEL,
  provider: PROVIDER,
  input_usd_per_mtok: C.num(0, 1000),
  output_usd_per_mtok: C.num(0, 1000),
  active: C.bool,
  updated_at: C.time,
});
export const AI_MODELS = itemsOf(AI_MODEL, 100);

type ProviderError = NonNullable<AiProviderStatus["last_error"]>;
const PROVIDER_ERROR = C.obj<ProviderError>({ code: C.id(/^[a-z0-9_.:-]{1,64}$/i, 64), at: C.time });
/** «Задан / не задан» и код последней ошибки — без ключа и без текста ошибки провайдера. Ошибка без времени или с
 *  неожиданным кодом не показывается (null), статус провайдера — показывается. */
export const AI_PROVIDER: Codec<AiProviderStatus> = C.obj<AiProviderStatus>({
  provider: PROVIDER,
  key_configured: C.bool,
  last_error: C.custom<ProviderError | null>(C.nullable(PROVIDER_ERROR).schema, (v, p) => {
    try {
      return C.nullable(PROVIDER_ERROR).parse(v, p);
    } catch (e) {
      if (e instanceof BadValue) return null;
      throw e;
    }
  }),
  ai_enabled: C.bool,
});

export const AI_BUDGET: Codec<AiBudget> = C.obj<AiBudget>({
  ai_enabled: C.bool,
  monthly_cap_usd: C.num(0, 100_000),
  learner_daily_cap_usd: C.num(0, 1000),
  lesson_cap_usd: C.num(0, 1000),
  alert_percent: C.int(1, 100),
  updated_at: C.time,
});

export const AI_CALL: Codec<AiCall> = C.obj<AiCall>({
  call_id: C.uuid,
  agent_id: AGENT_ID,
  version: C.nullable(VERSION_NO),
  model_id: C.nullable(MODEL),
  status: C.oneOf(["ok", "unavailable", "refused"] as const),
  reason: C.nullable(C.id(/^[a-z][a-z0-9_]{0,63}$/, 64)),
  input_tokens: COUNT,
  output_tokens: COUNT,
  cost_usd: USD,
  latency_ms: COUNT,
  session_id: C.nullable(C.uuid),
  canary: C.bool,
  created_at: C.time,
});
export const AI_CALL_PAGE = pageOf(AI_CALL, 200);

export const AI_USAGE_SUMMARY: Codec<AiUsageSummary> = C.obj<AiUsageSummary>({
  period: C.oneOf(["day", "week", "month"] as const),
  spent_usd: USD,
  monthly_cap_usd: C.num(0, 100_000),
  // доля потолка; перерасход (проверка бюджета — до вызова, потолок можно снизить ниже расхода) не ломает обзор
  cap_used_pct: C.num(0, 1e9),
  calls: COUNT,
  unavailable: COUNT,
  unavailable_pct: C.nullable(PCT),
  p95_latency_ms: C.nullable(COUNT),
  by_agent: C.arr(C.obj<AiUsageSummary["by_agent"][number]>({ agent_id: AGENT_ID, calls: COUNT, spent_usd: USD, unavailable: COUNT }), 50),
  by_model: C.arr(
    C.obj<AiUsageSummary["by_model"][number]>({ model_id: MODEL, calls: COUNT, input_tokens: COUNT, output_tokens: COUNT, spent_usd: USD }),
    100,
  ),
  by_day: C.arr(C.obj<AiUsageSummary["by_day"][number]>({ date: C.date, spent_usd: USD, calls: COUNT }), 400),
  avg_cost_per_lesson_usd: C.nullable(USD),
  ai_enabled: C.bool,
  alert_percent: C.int(1, 100),
});

// ---------------------------------------------------------------- контроль диалогов: сессии (lessons)

/** Поля строки журнала, которые даёт lessons; модели, стоимость и p95 — из ai-gateway (usage?session_id=). */
type SessionRowAi = "models" | "cost_usd" | "p95_latency_ms";
export type SessionRowDomain = Omit<SessionRow, SessionRowAi>;
const SESSION_ROW_PROPS = {
  session_id: C.uuid,
  kind: C.oneOf(SESSION_KINDS),
  title: LOCALIZED,
  lesson_id: C.nullable(KEY),
  scenario_id: C.nullable(KEY),
  asset_id: C.nullable(KEY),
  level: C.nullable(BAND),
  status: C.oneOf(STATUSES),
  outcome: C.nullable(C.oneOf(OUTCOMES)),
  passed: C.nullable(C.bool),
  minutes: C.int(0, 100_000),
  audience: C.oneOf(AUDIENCES),
  ai_mode: C.oneOf(["full", "choices"] as const),
  flags: C.arrSkip(C.oneOf(SESSION_FLAGS), 20),
  started_at: N_TIME,
  finished_at: N_TIME,
};
/** null — ai-gateway недоступен: стоимость неизвестна (не 0). */
const AI_PROPS = { models: C.arr(MODEL, 20), cost_usd: C.nullable(USD), p95_latency_ms: C.nullable(COUNT) };
export const SESSION_ROW_DOMAIN: Codec<SessionRowDomain> = C.obj<SessionRowDomain>(SESSION_ROW_PROPS);
export const SESSION_ROW: Codec<SessionRow> = C.obj<SessionRow>({ ...SESSION_ROW_PROPS, ...AI_PROPS });
export const SESSION_ROW_PAGE_DOMAIN = pageOf(SESSION_ROW_DOMAIN, 50);
export const SESSION_ROW_PAGE = pageOf(SESSION_ROW, 50);

/**
 * Пакетная сводка оценок для журнала — assessment `GET /admin/v1/evaluations/summary?session_id=…` (≤ 100 сессий):
 * актуальная запись цепочки (зачёт и ручная проверка — с учётом переоценки), флаг QA, статус апелляции. Сессии без
 * оценки в ответе нет.
 */
export interface SessionSummary {
  session_id: string;
  passed: boolean | null;
  requires_human_review: boolean;
  flagged: boolean;
  appeal_status: AdminAppeal["status"] | null;
}
export const SESSION_SUMMARIES = itemsOf(
  C.obj<SessionSummary>({
    session_id: C.uuid,
    passed: C.nullable(C.bool),
    requires_human_review: C.bool,
    flagged: C.bool,
    appeal_status: C.nullable(C.oneOf(APPEAL_ST)),
  }),
  100,
);

/** Флаги строки журнала в порядке admin.ts: lessons (ИИ, подсказки, сбой) + assessment (ручная проверка, апелляция,
 *  флаг QA — по актуальной оценке). Без сводки assessment — значения lessons как есть. */
export function mergeSummary(row: SessionRowDomain, s: SessionSummary | undefined): SessionRowDomain {
  if (!s) return row;
  const have = new Set<SessionFlag>(row.flags.filter((f) => f !== "human_review" && f !== "appealed" && f !== "flagged"));
  if (s.requires_human_review) have.add("human_review");
  if (s.appeal_status) have.add("appealed");
  if (s.flagged) have.add("flagged");
  return { ...row, passed: s.passed, flags: SESSION_FLAGS.filter((f) => have.has(f)) };
}

type CardSession = NonNullable<SessionCard["session"]>;
type CardExtra = Pick<CardSession, "content_versions" | "status_history" | "steps" | "turns_meta">;
const CARD_EXTRA_PROPS = {
  // lesson | scenario | rubric | media_asset, а также `media_exercise:<id>` и `retrieval:<lesson_id>` (id каталога)
  content_versions: C.dict(/^[a-z][a-z0-9_]{0,31}(:[a-z0-9][a-z0-9_.-]{0,63})?$/, VERSION_NO, 40),
  status_history: C.arr(
    C.obj<CardSession["status_history"][number]>({
      from: C.nullable(C.oneOf(STATUSES)),
      to: C.oneOf(STATUSES),
      reason: C.id(/^[a-z][a-z0-9_]{0,63}$/, 64),
      at: C.time,
    }),
    200,
  ),
  steps: C.arr(
    C.obj<CardSession["steps"][number]>({
      step_id: REF,
      stage: C.id(/^[a-z][a-z0-9_]{0,31}$/, 32),
      type: C.id(/^[a-z][a-z0-9_]{0,31}$/, 32),
      result: C.nullable(C.oneOf(["correct", "incorrect", "skipped"] as const)),
      hinted: C.bool,
      answered_at: N_TIME,
    }),
    500,
  ),
  turns_meta: C.arr(
    C.obj<CardSession["turns_meta"][number]>({
      turn_id: REF,
      speaker: C.oneOf(["learner", "character"] as const),
      mode: C.oneOf(["choice", "text"] as const),
      intent: C.nullable(C.id(/^[a-z][a-z0-9_]{0,63}$/, 64)),
      ai_call_id: C.nullable(C.id(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, 64)),
      redacted: C.bool,
    }),
    500,
  ),
};
/**
 * Карточка сессии от lessons: строка без затрат ИИ + история, шаги, метаданные реплик и `user_ref` (HMAC lessons).
 * `user_id`, если lessons его пришлёт, отбрасывается и сотруднику не отдаётся; без `user_ref` блок недоступен.
 */
export type SessionCardDomain = SessionRowDomain & CardExtra & { user_id: string | null; user_ref: string | null };
export const SESSION_CARD_DOMAIN: Codec<SessionCardDomain> = C.obj<SessionCardDomain>({
  ...SESSION_ROW_PROPS,
  ...CARD_EXTRA_PROPS,
  user_id: C.fallback(C.nullable(C.uuid), null),
  user_ref: C.fallback(C.nullable(C.id(/^[0-9a-f]{8}$/, 8)), null),
});
export const SESSION_CARD_SESSION: Codec<CardSession> = C.obj<CardSession>({
  ...SESSION_ROW_PROPS,
  ...AI_PROPS,
  ...CARD_EXTRA_PROPS,
  user_ref: C.id(/^[0-9a-f]{8}$/, 8),
});

/** Тексты реплик и ответов — многострочный текст ученика (только qa.transcripts, с причиной, аудит в lessons). */
const LEARNER_TEXT = C.nullable(C.multiline(2000, true));
export const TRANSCRIPT: Codec<Transcript> = C.obj<Transcript>({
  session_id: C.uuid,
  turns: C.arr(
    C.obj<Transcript["turns"][number]>({
      turn_id: REF,
      speaker: C.oneOf(["learner", "character"] as const),
      text: LEARNER_TEXT,
      mode: C.oneOf(["choice", "text"] as const),
      redacted: C.bool,
    }),
    500,
  ),
  answers: C.arr(C.obj<Transcript["answers"][number]>({ step_id: REF, item_id: REF, answer: LEARNER_TEXT }), 500),
  open_answer: LEARNER_TEXT,
});

// ---------------------------------------------------------------- оценки и апелляции (assessment)

export const CONFIRMED_ERROR: Codec<ConfirmedError> = C.obj<ConfirmedError>({
  turn_id: REF,
  evidence: C.multiline(120, true),
  correction: C.multiline(200, true),
  error_code: C.id(/^[a-z][a-z0-9_]{0,63}$/, 64),
  severity: C.oneOf(SEVERITIES),
});
type Score = 0 | 1 | 2 | 3;
const SCORE = C.nullable(C.int(0, 3)) as unknown as Codec<Score | null>;
const EVAL_PROPS = {
  evaluation_id: C.uuid,
  session_id: C.uuid,
  status: C.oneOf(["ok", "partial", "insufficient_evidence", "pending_review"] as const),
  rubric: C.obj<EvaluationCard["rubric"]>({ rubric_id: KEY, version: VERSION_NO }),
  scores: C.arr(C.obj<EvaluationCard["scores"][number]>({ code: C.oneOf(CRITERIA), score: SCORE }), 20),
  weighted: C.nullable(C.num(0, 3)),
  passed: C.nullable(C.bool),
  task_completed: C.nullable(C.bool),
  confirmed_errors: C.arr(CONFIRMED_ERROR, 5),
  items: C.arr(C.obj<EvaluationCard["items"][number]>({ item_id: REF, skill_id: KEY, correct: C.bool, hinted: C.bool }), 200),
  skill_outcomes: C.arr(C.obj<EvaluationCard["skill_outcomes"][number]>({ skill_id: KEY, outcome: C.oneOf(SKILL_OUT) }), 200),
  evaluator: C.nullable(
    C.obj<NonNullable<EvaluationCard["evaluator"]>>({
      agent_id: AGENT_ID,
      agent_version: VERSION_NO,
      prompt_version: C.id(/^[a-z_]{1,40}@[1-9][0-9]{0,8}$/, 50),
      model_id: MODEL,
      schema_version: C.str(64, 1),
      canary: C.bool,
    }),
  ),
  requires_human_review: C.bool,
  practice_only: C.bool,
  supersedes: C.nullable(C.uuid),
  created_by_name: C.name,
  reason: C.nullable(C.multiline(500, true)),
  created_at: C.time,
};
type Flag = EvaluationCard["flags"][number];
const FLAG_PROPS = { reason: C.multiline(500, true), by_name: C.name, at: C.time };
export const EVALUATION_CARD: Codec<EvaluationCard> = C.obj<EvaluationCard>({ ...EVAL_PROPS, flags: C.arr(C.obj<Flag>(FLAG_PROPS), 100) });
/** От assessment: + created_by («system» | staff_id) и flags[].by — для имён; клиенту не уходят. */
export type EvaluationCardDomain = Omit<EvaluationCard, "flags"> & { created_by: string | null; flags: Array<Flag & { by: string | null }> };
export const EVALUATION_CARD_DOMAIN: Codec<EvaluationCardDomain> = C.obj<EvaluationCardDomain>({
  ...EVAL_PROPS,
  created_by: C.fallback(STAFF_REF, null),
  flags: C.arr(C.obj<Flag & { by: string | null }>({ ...FLAG_PROPS, by: C.fallback(STAFF_REF, null) }), 100),
});
export const EVALUATION_CHAIN_DOMAIN = itemsOf(EVALUATION_CARD_DOMAIN, 50);

export function publicEvaluation(e: EvaluationCardDomain): EvaluationCard {
  const { created_by: _c, flags, ...rest } = e;
  return { ...rest, flags: flags.map(({ by: _b, ...f }) => f) };
}

const APPEAL_PROPS = {
  appeal_id: C.uuid,
  evaluation_id: C.uuid,
  session_id: C.uuid,
  status: C.oneOf(APPEAL_ST),
  // текст ученика (без PII): управляющие символы вычищаются, переводы строк сохраняются; null — стёрт по сроку
  reason: C.nullable(C.multiline(500, true)),
  reason_redacted: C.bool,
  decision_note: C.nullable(C.multiline(500, true)),
  taken_by_name: C.name,
  decided_by_name: C.name,
  new_evaluation_id: C.nullable(C.uuid),
  created_at: C.time,
  decided_at: N_TIME,
};
export const ADMIN_APPEAL: Codec<AdminAppeal> = C.obj<AdminAppeal>(APPEAL_PROPS);
export type AdminAppealDomain = AdminAppeal & { taken_by: string | null; decided_by: string | null };
export const ADMIN_APPEAL_DOMAIN: Codec<AdminAppealDomain> = C.obj<AdminAppealDomain>({
  ...APPEAL_PROPS,
  taken_by: C.fallback(C.nullable(C.uuid), null),
  decided_by: C.fallback(C.nullable(C.uuid), null),
});
export const ADMIN_APPEAL_PAGE = pageOf(ADMIN_APPEAL, 100);
export const ADMIN_APPEAL_PAGE_DOMAIN = pageOf(ADMIN_APPEAL_DOMAIN, 100);

export function publicAppeal(a: AdminAppealDomain): AdminAppeal {
  const { taken_by: _t, decided_by: _d, ...rest } = a;
  return rest;
}

// ---------------------------------------------------------------- карточка сессии и обзор

export const SESSION_CARD: Codec<SessionCard> = C.obj<SessionCard>({
  session: C.nullable(SESSION_CARD_SESSION),
  evaluations: C.nullable(C.arr(EVALUATION_CARD, 50)),
  ai_calls: C.nullable(C.arr(AI_CALL, 200)),
  errors: C.obj<SessionCard["errors"]>(
    { lessons: C.str(64), assessment: C.str(64), "ai-gateway": C.str(64) },
    "lessons",
    "assessment",
    "ai-gateway",
  ),
});

/** lessons `GET /admin/v1/lesson-sessions/stats?period=` — LessonStats без счётчиков assessment. Период в ответе
 *  lessons может быть и в форме day|week|month — в обзоре он заменяется запрошенным (Period). */
export type LessonStatsDomain = Omit<LessonStats, "appeals_open" | "human_review_open" | "period"> & { period: string };
const LESSON_STATS_PROPS = {
  period: C.oneOf<Period>(["today", "7d", "30d"]),
  started: COUNT,
  completed: COUNT,
  completion_pct: C.nullable(PCT),
  median_minutes: C.nullable(C.num(0, 1e6)),
  by_kind: C.obj<LessonStats["by_kind"]>({ lesson: COUNT, scenario: COUNT, media: COUNT, review: COUNT }),
  ai_degraded_pct: C.nullable(PCT),
};
export const LESSON_STATS_DOMAIN: Codec<LessonStatsDomain> = C.obj<LessonStatsDomain>({
  ...LESSON_STATS_PROPS,
  period: C.oneOf(["today", "7d", "30d", "day", "week", "month"] as const),
});
/** assessment `GET /admin/v1/assessment/stats?period=` — открытые апелляции и оценки на ручной проверке (остальные
 *  поля статистики assessment обзору не нужны и отбрасываются). */
export type AssessmentStats = Pick<LessonStats, "appeals_open" | "human_review_open">;
export const ASSESSMENT_STATS: Codec<AssessmentStats> = C.obj<AssessmentStats>({ appeals_open: COUNT, human_review_open: COUNT });
export const LESSON_STATS: Codec<LessonStats> = C.obj<LessonStats>({ ...LESSON_STATS_PROPS, appeals_open: COUNT, human_review_open: COUNT });

/**
 * Затраты страницы журнала одним вызовом — ai-gateway `GET /admin/v1/ai/usage/by-session?session_id=…` (≤ 50): модели,
 * сумма и p95 по сессии. Сессии без вызовов в ответе может не быть — у неё models [], 0, null.
 */
export type SessionAiFigures = Pick<SessionRow, "session_id" | SessionRowAi>;
export const SESSION_AI_FIGURES = itemsOf(
  C.obj<SessionAiFigures>({ session_id: C.uuid, models: C.arr(MODEL, 20), cost_usd: USD, p95_latency_ms: C.nullable(COUNT) }),
  50,
);
/** Стоимость неизвестна (ai-gateway недоступен): не 0. */
export const AI_UNKNOWN: Pick<SessionRow, SessionRowAi> = { models: [], cost_usd: null, p95_latency_ms: null };
/** Вызовов ИИ не было (выбор реплик): стоимость известна — 0. */
export const AI_NONE: Pick<SessionRow, SessionRowAi> = { models: [], cost_usd: 0, p95_latency_ms: null };

/** Сводка вызовов сессии (карточка): модели по порядку появления, сумма, p95 задержки успешных. */
export function aiFigures(calls: readonly AiCall[]): Pick<SessionRow, SessionRowAi> {
  const models: string[] = [];
  let cost = 0;
  const lat: number[] = [];
  for (const c of calls) {
    if (c.model_id && !models.includes(c.model_id)) models.push(c.model_id);
    cost += c.cost_usd;
    if (c.status === "ok") lat.push(c.latency_ms);
  }
  lat.sort((a, b) => a - b);
  const p95 = lat.length ? lat[Math.max(0, Math.ceil(lat.length * 0.95) - 1)]! : null;
  return { models, cost_usd: Math.round(cost * 1e6) / 1e6, p95_latency_ms: p95 };
}

export { BadValue };
