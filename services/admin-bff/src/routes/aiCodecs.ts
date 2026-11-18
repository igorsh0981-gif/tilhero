/**
 * Спринт 7: строгие описания ответов ai-control, ai-concierge и provider-gateway (admin.ts «Спринт 7»).
 * Одно описание — и проверка ответа домена, и схема ответа admin-bff (см. codec.ts).
 */
import type {
  AccessLevelSaved,
  AiAgentSaved,
  AiCommandWarning,
  AccessLevel,
  AccessLevelList,
  AdminAiConversation,
  AiAgent,
  AiAgentDayBudget,
  AiAgentList,
  AiAgentRuntimeState,
  AiAgentSkillRef,
  AiAgentUsage,
  AiAgentUsageRow,
  AiAlert,
  AiBudgetOverview,
  AiContentSource,
  AiKillSwitchState,
  AiKpi,
  AiPause,
  AiRequestCall,
  AiRequestContent,
  AiRequestDetail,
  AiRequestRow,
  AiTimelineStep,
  AiUserUsage,
  CostBreakdown,
  EvalCase,
  EvalCaseComparison,
  EvalCaseList,
  EvalCheck,
  EvalResult,
  EvalRun,
  EvalRunStarted,
  EvalRunSummary,
  EvalTotals,
  PriceCatalogItem,
  PriceCatalogList,
  PriceCatalogVersion,
  SkillActivation,
  SkillArtifact,
  SkillCompare,
  SkillDetail,
  SkillDiffLine,
  SkillList,
  SkillRollbackResult,
  SkillStatus,
  SkillSummary,
  SkillVersion,
  SkillVersionBrief,
  UserAccessLevel,
} from "@tilhero/contracts/admin";
import { BadValue, C, KEY_RE, SLUG_RE, pageOf, type Codec } from "../codec.js";
import { cleanText, safeHttps } from "./travel.js";

const AGENT = C.id(SLUG_RE, 32);
/** Сотрудник (UUID) или "system". */
const BY = C.id(/^[A-Za-z0-9._:@-]{1,64}$/, 64);
const N_BY = C.nullable(BY);
const MODEL = C.id(KEY_RE, 64);
const CODE = C.id(/^[A-Z][A-Z0-9_]{1,63}$/, 64);
const N_CODE = C.nullable(CODE);
const N_USD = C.nullable(C.usd);
const PCT = C.nullable(C.num(0, 1_000_000));
const RATE = C.nullable(C.num(0, 1));
const N_INT = C.nullable(C.int());
const N_TIME = C.nullable(C.time);
const HASH = C.id(/^[0-9a-f]{16,128}$/, 128);
const SKILL_ID = C.id(/^[a-z][a-z0-9_.-]{1,63}$/, 64);
const VERSION_NO = C.int(1, 100_000);
const PRICE_VERSION = C.id(/^(\d{4}-\d{2}-\d{2}(-\d{1,3})?|env)$/, 16);
const SKILL_STATUS = C.oneOf<SkillStatus>(["DRAFT", "TESTED", "REVIEW", "PUBLISHED", "DEPRECATED"]);
const KIND = C.oneOf<AiAgent["kind"]>(["interactive", "batch", "system"]);
const DEGRADED = C.oneOf<AiAgent["degraded_mode"]>(["fallback_model", "refuse", "none"]);
const LIMIT_SOURCE = C.nullable(C.oneOf<"admin" | "env">(["admin", "env"]));
/** Причина паузы: у повреждённой записи gateway может быть пустой — показываем «—» в UI. */
const REASON = C.custom<string>({ type: "string" }, (v, p) => (typeof v === "string" ? (cleanText(v, 300) ?? "") : C.text(300).parse(v, p)));
const N_TEXT = (max: number) => C.custom<string | null>({ type: ["string", "null"] }, (v, p) => (v === null || v === undefined ? null : typeof v === "string" ? cleanText(v, max) : C.text(max).parse(v, p)));

// ---------------------------------------------------------------- бюджеты и kill switch

export const AI_PAUSE = C.obj<AiPause>({ reason: REASON, by: BY, by_name: C.name, at: C.time });
export const N_PAUSE = C.nullable(AI_PAUSE);

export const AI_ALERT = C.obj<AiAlert>({
  alert_id: C.uuid,
  agent_id: AGENT,
  day: C.date,
  period: C.oneOf(["day", "month"]),
  threshold: C.int(0, 100),
  kind: C.oneOf(["budget", "unpriced"]),
  spent_usd: N_USD,
  limit_usd: N_USD,
  auto_paused: C.bool,
  detail: N_TEXT(200),
  created_at: C.time,
  acked_by: N_BY,
  acked_by_name: C.name,
  acked_at: N_TIME,
});
export const AI_ALERT_PAGE = pageOf(AI_ALERT, 100);

const DAY_BUDGET = C.obj<AiAgentDayBudget>({ spent_usd: C.usd, limit_usd: C.usd, pct: PCT, source: LIMIT_SOURCE });

export const AI_RUNTIME_STATE = C.obj<AiAgentRuntimeState>({
  agent_id: AGENT,
  name: C.text(120),
  kind: KIND,
  code_managed: C.bool,
  day: C.nullable(DAY_BUDGET),
  month: C.nullable(C.obj<NonNullable<AiAgentRuntimeState["month"]>>({ cost_usd: C.usd, cap_usd: N_USD, pct: PCT })),
  paused: N_PAUSE,
  state: C.oneOf(["normal", "degraded", "paused", "exhausted"]),
  degrade_at_pct: C.nullable(C.int(0, 100)),
  degraded_mode: C.nullable(DEGRADED),
  alerts: C.fallback(C.arr(AI_ALERT, 50), []),
});

/** ai-control budgets/overview (без лимитов и признаков источников — их добавляет admin-bff). */
export interface ControlOverview {
  agents: AiAgentRuntimeState[];
  provider: { anthropic: { paused: AiPause | null } };
  gateway: "ok" | "unavailable";
  at: string;
}
export const CONTROL_OVERVIEW = C.obj<ControlOverview>({
  agents: C.arr(AI_RUNTIME_STATE, 50),
  provider: C.obj<ControlOverview["provider"]>({ anthropic: C.obj<{ paused: AiPause | null }>({ paused: N_PAUSE }) }),
  gateway: C.oneOf(["ok", "unavailable"]),
  at: C.time,
});

type GatewayBudget = NonNullable<AiKillSwitchState["agents"][number]["budget"]>;
export const KILL_SWITCH_STATE = C.obj<AiKillSwitchState>({
  provider: C.obj<AiKillSwitchState["provider"]>({ anthropic: C.obj<{ paused: AiPause | null }>({ paused: N_PAUSE }) }),
  agents: C.arr(
    C.obj<AiKillSwitchState["agents"][number]>({
      agent_id: AGENT,
      paused: N_PAUSE,
      budget: C.nullable(
        C.obj<GatewayBudget>({ day: C.date, spent_usd: C.usd, reserved_usd: C.usd, limit_usd: C.usd, pct: PCT, source: LIMIT_SOURCE }),
      ),
    }),
    50,
  ),
});

/** Схема ответа /admin/v1/ai/budgets (limits — схема AI_LIMITS из responses.ts подставляется в маршруте). */
export const budgetOverviewSchema = (limitsSchema: Record<string, unknown>) =>
  C.obj<AiBudgetOverview>({
    agents: C.arr(AI_RUNTIME_STATE, 50),
    provider: C.obj<AiBudgetOverview["provider"]>({ anthropic: C.obj<{ paused: AiPause | null }>({ paused: N_PAUSE }) }),
    limits: C.custom({ ...limitsSchema, type: ["object", "null"] }, (v) => v as AiBudgetOverview["limits"]),
    gateway: C.oneOf(["ok", "unavailable"]),
    control: C.oneOf(["ok", "unavailable"]),
    at: C.time,
  }).schema;

// ---------------------------------------------------------------- агенты

const SKILL_REF = C.obj<AiAgentSkillRef>({
  skill_id: SKILL_ID,
  code_managed: C.fallback(C.bool, false),
  active_version: C.nullable(VERSION_NO),
  pending: C.fallback(C.arr(C.obj<AiAgentSkillRef["pending"][number]>({ version: VERSION_NO, status: SKILL_STATUS }), 20), []),
});
const AI_AGENT_PROPS = {
  agent_id: AGENT,
  name: C.text(120),
  kind: KIND,
  code_managed: C.bool,
  skills: C.arr(SKILL_REF, 50),
  degraded_mode: DEGRADED,
  degrade_at_pct: C.int(0, 100),
  per_request_max_usd: C.usd,
  monthly_cap_usd: N_USD,
  max_tool_calls: C.int(0, 100),
  model_fallback: C.nullable(MODEL),
  tools_whitelist: C.fallback(C.arr(C.id(/^[a-z_]{3,40}$/, 40), 50), []),
  config_version: C.int(0),
  updated_by: N_BY,
  updated_by_name: C.name,
  updated_at: N_TIME,
};
export const AI_AGENT = C.obj<AiAgent>(AI_AGENT_PROPS);
export const AI_AGENT_LIST = C.obj<AiAgentList>({ items: C.arr(AI_AGENT, 50) });

/**
 * warnings[] команд ai-control (ревью 7, M3): изменение уже выполнено, поэтому испорченное предупреждение не валит
 * ответ (503 после применённой команды ввёл бы в заблуждение) — оно отбрасывается; в details — только скаляры.
 */
const WARNING_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const WARNING_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const AI_WARNINGS = C.custom<AiCommandWarning[]>(
  {
    type: "array",
    items: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" }, details: { type: "object", additionalProperties: true } },
      "x-contract-required": ["code", "message", "details"],
    },
  },
  (v) => {
    if (!Array.isArray(v)) return [];
    const out: AiCommandWarning[] = [];
    for (const w of v.slice(0, 20)) {
      if (!w || typeof w !== "object") continue;
      const x = w as Record<string, unknown>;
      if (typeof x.code !== "string" || !WARNING_CODE_RE.test(x.code)) continue;
      const details: AiCommandWarning["details"] = {};
      if (x.details && typeof x.details === "object" && !Array.isArray(x.details)) {
        for (const [k, d] of Object.entries(x.details as Record<string, unknown>).slice(0, 20)) {
          if (!WARNING_KEY_RE.test(k)) continue;
          if (typeof d === "number" && Number.isFinite(d)) details[k] = d;
          else if (typeof d === "boolean" || d === null) details[k] = d;
          else if (typeof d === "string") details[k] = cleanText(d, 120) ?? "";
        }
      }
      out.push({ code: x.code, message: cleanText(x.message, 300) ?? x.code, details });
    }
    return out;
  },
);
export const AI_AGENT_SAVED = C.obj<AiAgentSaved>({ ...AI_AGENT_PROPS, warnings: AI_WARNINGS });

// ---------------------------------------------------------------- учёт и стоимость

export const AI_KPI = C.obj<AiKpi>({
  from: C.time,
  to: C.time,
  requests: C.int(),
  calls: C.int(),
  success_rate: RATE,
  retry_rate: RATE,
  tokens_in: C.int(),
  tokens_out: C.int(),
  cache_read: C.int(),
  cache_write: C.int(),
  llm_cost_usd: C.usd,
  external_cost_usd: C.usd,
  total_cost_usd: C.usd,
  avg_cost_per_request: N_USD,
  cost_per_active_user: N_USD,
  active_users: C.int(),
  unpriced_calls: C.int(),
  p50_ms: N_INT,
  p95_ms: N_INT,
});

export const AI_AGENT_USAGE = C.obj<AiAgentUsage>({
  from: C.time,
  to: C.time,
  items: C.arr(
    C.obj<AiAgentUsageRow>({
      agent_id: AGENT,
      name: C.text(120),
      kind: KIND,
      code_managed: C.bool,
      calls: C.int(),
      requests: C.int(),
      success_rate: RATE,
      retry_rate: RATE,
      tokens_in: C.int(),
      tokens_out: C.int(),
      cache_read: C.int(),
      cache_write: C.int(),
      total_cost_usd: C.usd,
      avg_cost_usd: N_USD,
      p50_ms: N_INT,
      p95_ms: N_INT,
      external_api_share: RATE,
      cost_trend: C.arr(C.obj<{ day: string; cost_usd: string }>({ day: C.date, cost_usd: C.usd }), 400),
      budget_today: C.nullable(C.obj<NonNullable<AiAgentUsageRow["budget_today"]>>({ spent_usd: C.usd, limit_usd: C.usd, pct: PCT })),
    }),
    50,
  ),
  gateway: C.oneOf(["ok", "unavailable"]),
});

const ROW_PROPS = {
  request_id: C.uuid,
  occurred_at: C.time,
  agent_id: AGENT,
  skill_id: C.nullable(SKILL_ID),
  skill_version: C.nullable(C.id(/^[0-9A-Za-z._-]{1,32}$/, 32)),
  user_id: C.nullable(C.uuid),
  model_used: C.nullable(MODEL),
  fallback_used: C.bool,
  tokens_in: C.int(),
  tokens_out: C.int(),
  tool_calls: C.int(),
  service_calls: C.int(),
  cost_usd: N_USD,
  latency_ms: C.int(),
  status: C.oneOf<AiRequestRow["status"]>(["SUCCESS", "PARTIAL", "FAILED", "ERROR"]),
  error_code: N_CODE,
  // спринт 8 (§5): «квота не списана»; ai-control до спринта 8 полей не отдаёт — тогда их нет и в ответе
  quota_charged: C.nullable(C.bool),
  quota_refund_reason: C.nullable(C.oneOf<"failed" | "no_change">(["failed", "no_change"])),
};
const QUOTA_OPTIONAL = ["quota_charged", "quota_refund_reason"] as const;
export const AI_REQUEST_ROW = C.obj<AiRequestRow>(ROW_PROPS, ...QUOTA_OPTIONAL);
export const AI_REQUEST_PAGE = pageOf(AI_REQUEST_ROW, 100);

export const COST_BREAKDOWN = C.obj<CostBreakdown>({
  llm_input_usd: N_USD,
  llm_output_usd: N_USD,
  cache_write_usd: N_USD,
  cache_read_usd: N_USD,
  request_fee_usd: N_USD,
  external_api_usd: N_USD,
  total_cost_usd: N_USD,
  price_catalog_version: PRICE_VERSION,
  status: C.oneOf(["priced", "unpriced"]),
});
const CALL = C.obj<AiRequestCall>({
  usage_id: C.uuid,
  occurred_at: C.time,
  model: MODEL,
  tokens_in: C.int(),
  tokens_out: C.int(),
  cache_write_tokens: C.int(),
  cache_read_tokens: C.int(),
  tool_calls: C.int(),
  external_api_calls: C.arr(C.obj<{ key: string; count: number }>({ key: C.id(KEY_RE, 64), count: C.int(0, 1_000_000) }), 50),
  cost: C.nullable(COST_BREAKDOWN),
  latency_ms: C.int(),
  status: C.id(/^[A-Z_]{2,32}$/, 32),
  error_code: N_CODE,
  price_catalog_version: PRICE_VERSION,
});
const STEP = C.obj<AiTimelineStep>({
  type: C.oneOf(["llm", "tool"]),
  name: C.text(80),
  started_ms: N_INT,
  duration_ms: N_INT,
  status: C.nullable(C.id(/^[A-Za-z_]{2,32}$/, 32)),
  code: N_CODE,
});
const DETAIL_RAW = C.obj<AiRequestDetail>({
  ...ROW_PROPS,
  calls: C.arr(CALL, 100),
  timeline: C.arr(STEP, 200),
  source_count: N_INT,
  safety_violations: N_INT,
  first_event_ms: N_INT,
  mode: C.nullable(C.id(/^[a-z_]{2,16}$/, 16)),
  kind: C.nullable(C.id(/^[a-z_]{2,16}$/, 16)),
  conversation_id: C.nullable(C.uuid),
  price_catalog_versions: C.arr(PRICE_VERSION, 20),
  trace_id: C.nullable(C.id(/^[A-Za-z0-9._:-]{1,128}$/, 128)),
  content: C.obj<AiRequestDetail["content"]>({ available: C.bool, requires: C.oneOf(["ai.content.read"]) }),
}, ...QUOTA_OPTIONAL);
/** ai-control отдаёт price_catalog_version строкой, списком или null → price_catalog_versions[]. */
export const AI_REQUEST_DETAIL = C.custom<AiRequestDetail>(DETAIL_RAW.schema, (v, p) => {
  if (!v || typeof v !== "object") throw new BadValue(p);
  const raw = (v as Record<string, unknown>).price_catalog_version;
  const versions = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return DETAIL_RAW.parse({ ...(v as object), price_catalog_versions: versions }, p);
});

const CONTENT_SOURCE = C.custom<AiContentSource>(
  { type: "object", properties: { ref: { type: "string" }, title: { type: "string" }, domain: { type: "string" }, url: { type: ["string", "null"] } } },
  (v, p) => {
    if (!v || typeof v !== "object") throw new BadValue(p);
    const s = v as Record<string, unknown>;
    return {
      ref: cleanText(s.ref, 16) ?? "—",
      title: cleanText(s.title, 200) ?? "—",
      domain: cleanText(s.domain, 255) ?? "",
      url: safeHttps(s.url),
    };
  },
);
/** Раскрытое содержимое (A43): текст пользователя и ответ — как есть (многострочно), аргументы — JSON строкой. */
export const AI_REQUEST_CONTENT = C.obj<AiRequestContent>({
  request_id: C.uuid,
  user_text: C.nullable(C.multiline(4000, true)),
  segments: C.arr(
    C.obj<AiRequestContent["segments"][number]>({
      kind: C.id(/^[a-z_]{2,32}$/, 32),
      text: C.multiline(8000, true),
      sources: C.fallback(C.arr(CONTENT_SOURCE, 20), []),
    }),
    50,
  ),
  tool_calls: C.arr(
    C.obj<AiRequestContent["tool_calls"][number]>({
      tool: C.id(/^[a-z_]{3,40}$/, 40),
      status: C.id(/^[a-z_]{2,32}$/, 32),
      code: N_CODE,
      duration_ms: N_INT,
      args: C.jsonText(2000),
    }),
    20,
  ),
});

// ---------------------------------------------------------------- каталог цен

const RATE_USD = N_USD;
export const PRICE_ITEM = C.obj<PriceCatalogItem>({
  kind: C.oneOf(["model", "external_api", "request_fee"]),
  key: C.id(/^(\*|[a-z0-9][a-z0-9.\-_]{2,63})$/, 64),
  input_usd_per_mtok: RATE_USD,
  output_usd_per_mtok: RATE_USD,
  cache_write_usd_per_mtok: RATE_USD,
  cache_read_usd_per_mtok: RATE_USD,
  per_call_usd: RATE_USD,
});
export const PRICE_VERSION_C = C.obj<PriceCatalogVersion>(
  {
    version: PRICE_VERSION,
    status: C.oneOf(["draft", "active", "retired"]),
    note: N_TEXT(500),
    based_on: C.nullable(PRICE_VERSION),
    content_hash: C.nullable(HASH),
    created_by: N_BY,
    created_by_name: C.name,
    created_at: C.time,
    updated_at: N_TIME,
    activated_by: N_BY,
    activated_by_name: C.name,
    activated_at: N_TIME,
    retired_at: N_TIME,
    row_version: C.int(0),
    items: C.arr(PRICE_ITEM, 200),
    incomplete_models: C.arr(MODEL, 200),
  },
  "items",
  "incomplete_models",
);
export const PRICE_LIST = C.obj<PriceCatalogList>({ items: C.arr(PRICE_VERSION_C, 200) });

// ---------------------------------------------------------------- skills

const ACTIVATION = C.obj<SkillActivation>({
  activation_id: C.uuid,
  skill_id: SKILL_ID,
  version: VERSION_NO,
  kind: C.oneOf(["publish", "rollback", "bootstrap"]),
  effective_from: C.time,
  by: BY,
  by_name: C.name,
  reason: N_TEXT(300),
  previous_version: C.nullable(VERSION_NO),
  created_at: C.time,
  cancelled: C.fallback(C.bool, false),
});
const SUMMARY_PROPS = {
  skill_id: SKILL_ID,
  agent_id: AGENT,
  title: C.text(120),
  critical: C.bool,
  code_managed: C.bool,
  active: C.nullable(C.obj<NonNullable<SkillSummary["active"]>>({ version: VERSION_NO, activation_id: C.uuid, since: C.time })),
  versions: C.arr(C.obj<{ version: number; status: SkillStatus }>({ version: VERSION_NO, status: SKILL_STATUS }), 1000),
};
export const SKILL_LIST = C.obj<SkillList>({ items: C.arr(C.obj<SkillSummary>(SUMMARY_PROPS), 200) });

const VERSION_BRIEF = C.obj<SkillVersionBrief>({
  version: VERSION_NO,
  status: SKILL_STATUS,
  artifact_hash: HASH,
  author: N_BY,
  author_name: C.name,
  reviewer: N_BY,
  reviewer_name: C.name,
  editors: C.fallback(C.arr(BY, 50), []),
  created_at: C.time,
  published_at: N_TIME,
  change_note: N_TEXT(1000),
});
const DETAIL_SKILL = C.obj<SkillDetail>({
  ...SUMMARY_PROPS,
  versions_full: C.arr(VERSION_BRIEF, 1000),
  activations: C.arr(ACTIVATION, 1000),
});
/** ai-control: `versions` в деталях — полные карточки версий → versions_full + краткий versions. */
export const SKILL_DETAIL = C.custom<SkillDetail>(DETAIL_SKILL.schema, (v, p) => {
  if (!v || typeof v !== "object") throw new BadValue(p);
  const raw = v as Record<string, unknown>;
  const full = Array.isArray(raw.versions) ? raw.versions : [];
  const brief = full.map((x) => (x && typeof x === "object" ? { version: (x as Record<string, unknown>).version, status: (x as Record<string, unknown>).status } : x));
  return DETAIL_SKILL.parse({ ...raw, versions: brief, versions_full: full }, p);
});

const TOOL = C.id(/^[a-z_]{3,40}$/, 40);
const ARTIFACT = C.obj<SkillArtifact>({
  skill_id: SKILL_ID,
  agent_id: AGENT,
  version: VERSION_NO,
  system_instruction: C.multiline(20_000),
  output_schema: C.oneOf(["concierge-answer-v1"]),
  allowed_tools: C.arr(TOOL, 20),
  source_priority: C.arr(C.oneOf<SkillArtifact["source_priority"][number]>(["official", "ticket_provider", "provider", "trusted_media"]), 4),
  model_policy: C.obj<SkillArtifact["model_policy"]>({ primary: MODEL, fallback: C.nullable(MODEL) }),
  limits: C.obj<SkillArtifact["limits"]>({ max_tokens: C.int(1, 100_000), max_cost_usd: C.usd, timeout_ms: C.int(0, 600_000), retries: C.int(0, 10) }),
  confidence: C.obj<SkillArtifact["confidence"]>({ min: C.num(0, 1) }),
  safety_policy: C.obj<SkillArtifact["safety_policy"]>({
    no_invented_prices: C.bool,
    source_required: C.bool,
    web_content_untrusted: C.bool,
    tool_before_claim: C.bool,
  }),
  change_note: N_TEXT(1000),
  author: N_BY,
  reviewer: N_BY,
  effective_from: N_TIME,
  rollback_target: C.nullable(VERSION_NO),
});
export const SKILL_VERSION = C.obj<SkillVersion>(
  {
    skill_id: SKILL_ID,
    version: VERSION_NO,
    artifact: ARTIFACT,
    artifact_hash: HASH,
    status: SKILL_STATUS,
    author: N_BY,
    author_name: C.name,
    reviewer: N_BY,
    reviewer_name: C.name,
    editors: C.fallback(C.arr(BY, 50), []),
    review: C.nullable(
      C.obj<NonNullable<SkillVersion["review"]>>({ decision: C.oneOf(["approved", "rejected"]), comment: N_TEXT(1000), at: N_TIME }),
    ),
    last_run: C.nullable(
      C.obj<NonNullable<SkillVersion["last_run"]>>({ run_id: C.uuid, passed: C.nullable(C.bool), at: N_TIME, current: C.fallback(C.bool, false) }),
    ),
    from_version: C.nullable(VERSION_NO),
    created_at: C.time,
    updated_at: N_TIME,
    published_at: N_TIME,
    deprecated_at: N_TIME,
    version_row: C.int(0),
    activation: ACTIVATION,
  },
  "activation",
);
export const SKILL_ROLLBACK = C.obj<SkillRollbackResult>({
  skill_id: SKILL_ID,
  from_version: C.nullable(VERSION_NO),
  to_version: VERSION_NO,
  activation: ACTIVATION,
  cancelled_activations: C.fallback(C.arr(ACTIVATION, 100), []),
  message: C.fallback(N_TEXT(1000), null),
});

// ---------------------------------------------------------------- Test Console

const TOTALS = C.obj<EvalTotals>({
  cases: C.int(),
  passed: C.int(),
  failed: C.int(),
  required_failed: C.fallback(C.int(), 0),
  cost_usd: C.nullable(C.usdSigned),
  latency_ms_avg: N_INT,
  required_passed: C.fallback(C.nullable(C.bool), null),
  complete: C.fallback(C.nullable(C.bool), null),
});
const N_TOTALS = C.nullable(TOTALS);
const RUN_STATUS = C.oneOf<EvalRunSummary["status"]>(["queued", "running", "done", "failed"]);
const RUN_SUMMARY = C.obj<EvalRunSummary>({ run_id: C.uuid, status: RUN_STATUS, totals: N_TOTALS, at: C.time });

const DIFF_LINE = C.obj<SkillDiffLine>({
  op: C.oneOf(["equal", "delete", "insert"]),
  a: C.nullable(C.int(1)),
  b: C.nullable(C.int(1)),
  text: C.multiline(20_000, true),
});
const SIDE = (k: "a" | "b") =>
  C.obj<SkillCompare[typeof k]>({ version: VERSION_NO, status: SKILL_STATUS, artifact_hash: HASH, last_run: C.nullable(RUN_SUMMARY) });
const PAIR_ARR_SCHEMA = {
  type: "array",
  items: { type: "object", properties: { field: { type: "string" }, metric: { type: "string" }, a: { type: ["string", "null"] }, b: { type: ["string", "null"] } } },
};
const jsonText = C.jsonText(2000);
/** {key: {a, b}} домена → [{<label>: key, a, b}] со значениями JSON-строкой (ключ — идентификатор поля). */
const pairs = <K extends "field" | "metric">(label: K) =>
  C.custom<Array<Record<K, string> & { a: string | null; b: string | null }>>(PAIR_ARR_SCHEMA, (v, p) => {
    if (v === undefined || v === null) return [];
    if (typeof v !== "object" || Array.isArray(v)) throw new BadValue(p);
    return Object.entries(v as Record<string, unknown>)
      .slice(0, 100)
      .map(([k, x]) => {
        if (!/^[a-z_][a-z0-9_.]{0,63}$/.test(k) || !x || typeof x !== "object") throw new BadValue(`${p}.${k.slice(0, 64)}`);
        const ab = x as Record<string, unknown>;
        return { [label]: k, a: jsonText.parse(ab.a, p), b: jsonText.parse(ab.b, p) } as Record<K, string> & { a: string | null; b: string | null };
      });
  });
const COMPARE_RAW = C.obj<SkillCompare>({
  skill_id: SKILL_ID,
  a: SIDE("a"),
  b: SIDE("b"),
  instruction_diff: C.arr(DIFF_LINE, 4000),
  fields: pairs("field"),
  runs: pairs("metric"),
});
export const SKILL_COMPARE = COMPARE_RAW;

const CHECK = C.obj<EvalCheck>({ check: C.id(/^[a-z_]+(:[A-Za-z0-9_.-]{1,64})?$/, 80), passed: C.bool, detail: N_TEXT(300) });
const STR_LIST = (re: RegExp, max: number) => C.arr(C.id(re, 64), max);

/** Сводка вывода исполнителя без текста ответа модели: инструменты, виды сегментов, нарушения, стоимость. */
function outputBrief(output: unknown, p: string): Pick<EvalResult, "tools" | "kinds" | "violations" | "cost_usd" | "latency_ms" | "schema_valid"> {
  if (output === null || output === undefined) return { tools: [], kinds: [], violations: [], cost_usd: null, latency_ms: null, schema_valid: null };
  if (typeof output !== "object" || Array.isArray(output)) throw new BadValue(p);
  const o = output as Record<string, unknown>;
  const calls = Array.isArray(o.tool_calls) ? o.tool_calls : [];
  const tools = calls
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as Record<string, unknown>).tool === "string")
    .filter((c) => c.status !== "rejected")
    .map((c) => String(c.tool))
    .filter((t) => /^[a-z_]{3,40}$/.test(t))
    .slice(0, 20);
  const segs = Array.isArray(o.segments) ? o.segments : [];
  const kinds = [
    ...new Set(
      segs
        .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>).kind : null))
        .filter((k): k is string => typeof k === "string" && /^[a-z_]{2,32}$/.test(k)),
    ),
  ].sort();
  const viol = Array.isArray(o.safety_violations) ? o.safety_violations : [];
  const violations = [
    ...new Set(
      viol
        .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>).guard : null))
        .filter((g): g is string => typeof g === "string" && /^[A-Z0-9_]{1,16}$/.test(g)),
    ),
  ];
  const usage = o.usage && typeof o.usage === "object" ? (o.usage as Record<string, unknown>) : {};
  const cost = typeof usage.cost_usd === "string" && /^\d{1,12}(\.\d{1,6})?$/.test(usage.cost_usd) ? usage.cost_usd : null;
  const lat = typeof o.latency_ms === "number" && Number.isSafeInteger(o.latency_ms) && o.latency_ms >= 0 ? o.latency_ms : null;
  return { tools, kinds, violations, cost_usd: cost, latency_ms: lat, schema_valid: typeof o.schema_valid === "boolean" ? o.schema_valid : null };
}

const RESULT_FIELDS = C.obj<Omit<EvalResult, "tools" | "kinds" | "violations" | "cost_usd" | "latency_ms" | "schema_valid">>({
  case_id: C.uuid,
  case_name: C.text(80),
  required: C.bool,
  side: C.oneOf(["candidate", "compare"]),
  passed: C.bool,
  checks: C.arr(CHECK, 100),
});
const RESULT_SCHEMA = C.obj<EvalResult>({
  ...{
    case_id: C.uuid,
    case_name: C.text(80),
    required: C.bool,
    side: C.oneOf(["candidate", "compare"]),
    passed: C.bool,
    checks: C.arr(CHECK, 100),
  },
  tools: STR_LIST(/^[a-z_]{3,40}$/, 20),
  kinds: STR_LIST(/^[a-z_]{2,32}$/, 10),
  violations: STR_LIST(/^[A-Z0-9_]{1,16}$/, 10),
  cost_usd: N_USD,
  latency_ms: N_INT,
  schema_valid: C.nullable(C.bool),
}).schema;
const RESULT = C.custom<EvalResult>(RESULT_SCHEMA, (v, p) => {
  const base = RESULT_FIELDS.parse(v, p);
  return { ...base, ...outputBrief((v as Record<string, unknown>).output, `${p}.output`) };
});
const BRIEF = C.obj<EvalCaseComparison["candidate"]>({
  tools: STR_LIST(/^[a-z_]{3,40}$/, 20),
  kinds: STR_LIST(/^[a-z_]{2,32}$/, 10),
  cost_usd: C.nullable(C.usdSigned),
  latency_ms: N_INT,
});
const COMPARISON = C.obj<EvalCaseComparison>({
  case_id: C.uuid,
  case_name: C.text(80),
  changed: C.arr(C.id(/^[a-z_]{2,32}$/, 32), 10),
  candidate: BRIEF,
  compare: BRIEF,
  cost_delta_usd: C.fallback(C.nullable(C.usdSigned), null),
  latency_delta_ms: C.fallback(C.nullable(C.int(-10_000_000, 10_000_000)), null),
});
export const EVAL_RUN = C.obj<EvalRun>({
  run_id: C.uuid,
  skill_id: SKILL_ID,
  version: VERSION_NO,
  artifact_hash: HASH,
  compare_version: C.nullable(VERSION_NO),
  status: RUN_STATUS,
  started_by: N_BY,
  started_by_name: C.name,
  totals: N_TOTALS,
  error_code: N_CODE,
  created_at: C.time,
  started_at: N_TIME,
  finished_at: N_TIME,
  results: C.fallback(C.arr(RESULT, 400), []),
  comparison: C.fallback(C.arr(COMPARISON, 200), []),
});
export const EVAL_RUN_STARTED = C.obj<EvalRunStarted>({ run_id: C.uuid, status: RUN_STATUS, cases: C.int() });

const CASE_JSON = C.json(64 * 1024);
export const EVAL_CASE = C.obj<EvalCase>({
  case_id: C.uuid,
  skill_id: SKILL_ID,
  name: C.id(/^[A-Za-z0-9_.\- ]{1,80}$/, 80),
  required: C.bool,
  enabled: C.bool,
  input: CASE_JSON,
  tool_fixtures: CASE_JSON,
  expect: CASE_JSON,
  version: C.int(0),
  updated_by: N_BY,
  updated_at: N_TIME,
});
export const EVAL_CASE_LIST = C.obj<EvalCaseList>({ items: C.arr(EVAL_CASE, 500) });

// ---------------------------------------------------------------- уровни доступа, пользователь

const LEVEL_CODE = C.id(/^[a-z][a-z0-9_]{1,31}$/, 32);
const ACCESS_LEVEL_PROPS = {
  code: LEVEL_CODE,
  name_ru: C.text(60),
  name_en: C.text(60),
  concierge_messages_per_day: C.int(0, 1000),
  is_default: C.bool,
  sort: C.int(0, 100_000),
  version: C.int(0),
  updated_by: N_BY,
  updated_by_name: C.name,
  updated_at: N_TIME,
};
export const ACCESS_LEVEL = C.obj<AccessLevel>(ACCESS_LEVEL_PROPS);
export const ACCESS_LEVEL_SAVED = C.obj<AccessLevelSaved>({ ...ACCESS_LEVEL_PROPS, warnings: AI_WARNINGS });
export const ACCESS_LEVEL_LIST = C.obj<AccessLevelList>({ items: C.arr(ACCESS_LEVEL, 100) });
export const USER_ACCESS_LEVEL = C.obj<UserAccessLevel>({
  user_id: C.uuid,
  level: LEVEL_CODE,
  level_name: C.text(60),
  level_name_en: C.text(60),
  source: C.oneOf(["default", "manual"]),
  expires_at: N_TIME,
  limits: C.obj<UserAccessLevel["limits"]>({ concierge_messages_per_day: C.int(0, 1000) }),
  assigned_by: N_BY,
  assigned_by_name: C.name,
  assigned_at: N_TIME,
  reason: N_TEXT(300),
  assignment: C.nullable(
    C.obj<NonNullable<UserAccessLevel["assignment"]>>({
      level: C.nullable(LEVEL_CODE),
      source: C.id(/^[a-z_]{2,32}$/, 32),
      expires_at: N_TIME,
      expired: C.fallback(C.bool, false),
    }),
  ),
  version: C.int(0),
});
export const AI_USER_USAGE = C.obj<AiUserUsage>({
  from: C.time,
  to: C.time,
  requests: C.int(),
  cost_usd: C.usd,
  agents: C.arr(C.obj<AiUserUsage["agents"][number]>({ agent_id: AGENT, requests: C.int(), cost_usd: C.usd }), 50),
  days: C.arr(C.obj<AiUserUsage["days"][number]>({ day: C.date, requests: C.int(), cost_usd: C.usd }), 400),
});
export const AI_CONVERSATION = C.obj<AdminAiConversation>({
  conversation_id: C.uuid,
  mode: C.oneOf(["event", "home"]),
  event_id: C.nullable(C.uuid),
  turns_count: C.int(),
  created_at: C.time,
  last_activity_at: N_TIME,
});
export const AI_CONVERSATION_PAGE = pageOf(AI_CONVERSATION, 100);

export type { Codec };
