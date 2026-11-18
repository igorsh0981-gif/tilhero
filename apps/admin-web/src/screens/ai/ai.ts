import type {
  AccessLevel,
  AiRequestStatus,
  AiAgent,
  AiAgentPatch,
  AiAgentState,
  AiAlert,
  PriceCatalogItem,
  SkillContent,
  SkillStatus,
  SkillVersion,
} from "@tilhero/contracts/admin";

/* Sprint 7 — pure helpers of «Requests and cost», «Budgets and limits», «Agents and skills» (no React, unit-tested). */

export type Tone = "good" | "warn" | "bad" | "neutral" | "info";

/** budget thresholds of the alerts (ai-control §2.6): 70 / 90 / 100 % */
export const THRESHOLDS = [70, 90, 100] as const;

/** colour of a budget meter: < 70 % ok, 70–89 % warning, ≥ 90 % critical (the 90 % alert), no limit — neutral */
export function pctTone(pct: number | null | undefined): Tone {
  if (pct == null) return "neutral";
  if (pct >= 90) return "bad";
  if (pct >= 70) return "warn";
  return "good";
}

export const REQ_TONE: Record<AiRequestStatus, "good" | "warn" | "bad"> = { SUCCESS: "good", PARTIAL: "warn", FAILED: "bad", ERROR: "bad" };

export const STATE_TONE: Record<AiAgentState, Tone> = { normal: "good", degraded: "warn", paused: "bad", exhausted: "bad" };

/** meter width 0..100 (display only) */
export const meterWidth = (pct: number | null | undefined) => (pct == null ? 0 : Math.max(0, Math.min(100, pct)));

// ---------------------------------------------------------------- money without floats

const DEC_RE = /^(\d{1,12})(?:\.(\d{1,6}))?$/;

/** "0.050000" → 50000 µ$ (bigint); invalid → null */
export function micro(v: string | null | undefined): bigint | null {
  if (v == null) return null;
  const m = DEC_RE.exec(v.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** operator input "0,05" → "0.05"; spaces dropped */
export const cleanUsd = (s: string) => s.trim().replace(/\s+/g, "").replace(",", ".");

/** money typed in a form: up to `places` fraction digits, no exponent; returns the cleaned string or null */
export function moneyIn(s: string, places: number, maxInt = 4): string | null {
  const v = cleanUsd(s);
  return new RegExp(`^\\d{1,${maxInt}}(\\.\\d{1,${places}})?$`).test(v) ? v : null;
}

// ---------------------------------------------------------------- numbers

/** 17 300 000 → «17,3 млн» / «17.3M» */
export function fmtCompact(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** milliseconds → «6,2 с» / «820 мс» numbers (units are added by the dictionary) */
export function msParts(ms: number | null | undefined): { v: number; unit: "ms" | "s" } | null {
  if (ms == null) return null;
  return ms < 1000 ? { v: ms, unit: "ms" } : { v: Math.round(ms / 100) / 10, unit: "s" };
}

/** share 0..1 → percent number for fmt.pct (expects percent) */
export const pct100 = (r: number | null | undefined) => (r == null ? null : r * 100);

// ---------------------------------------------------------------- alerts

/** alert text key + vars: budget threshold of a day/month or a call without a price in the catalogue */
export function alertKind(a: AiAlert): "unpriced" | "autoPause" | "day" | "month" {
  if (a.kind === "unpriced") return "unpriced";
  if (a.auto_paused) return "autoPause";
  return a.period === "month" ? "month" : "day";
}

/** model of an unpriced alert: detail "model:<id>" */
export const unpricedModel = (a: AiAlert) => (a.detail?.startsWith("model:") ? a.detail.slice(6) : (a.detail ?? ""));

// ---------------------------------------------------------------- agent config

export interface AgentForm {
  degraded_mode: AiAgent["degraded_mode"];
  degrade_at_pct: string;
  per_request_max_usd: string;
  monthly_cap_usd: string; // "" — no monthly cap
  max_tool_calls: string;
  model_fallback: string; // "" — none
}
export type AgentField = keyof AgentForm;
export type AgentErrors = Partial<Record<AgentField, "pct" | "perRequest" | "cap" | "tools" | "model" | "belowSkill" | "monthBelowDay">>;

/** max_cost_usd of an active or open (DRAFT · TESTED · REVIEW) version of the agent's skills */
export interface SkillCost {
  skill_id: string;
  version: number;
  status: SkillStatus;
  max_cost_usd: string;
}
/**
 * What the agent form is checked against (review 7, M3 — the same rules as ai-control, so the operator sees them
 * before the 409 / 422): only the fields that change are checked, as ai-control checks only the PATCH fields.
 */
export interface AgentCtx {
  agent?: AiAgent;
  /** null / absent — not loaded (ai-control still checks: 409 AGENT_PER_REQUEST_BELOW_SKILL) */
  skillCosts?: SkillCost[] | null;
  /** the agent's daily limit (AiLimits / provider-gateway) */
  dayLimitUsd?: string | null;
  /** spent this month (ai-control) */
  monthSpentUsd?: string | null;
}
export type AgentWarning =
  | { k: "monthBelowSpent"; cap: string; spent: string }
  | { k: "dayBelowPerRequest"; day: string; per: string };

/** the most expensive skill version above the per-request limit (the one the error names), else null */
export function skillAbove(per: string, costs: SkillCost[] | null | undefined): SkillCost | null {
  const p = micro(per);
  if (p === null || !costs?.length) return null;
  let top: SkillCost | null = null;
  for (const c of costs) {
    const m = micro(c.max_cost_usd);
    if (m !== null && m > p && (!top || m > micro(top.max_cost_usd)!)) top = c;
  }
  return top;
}

const perChanged = (f: AgentForm, a?: AiAgent) => !a || micro(cleanUsd(f.per_request_max_usd)) !== micro(a.per_request_max_usd);
const capOf = (f: AgentForm) => (f.monthly_cap_usd.trim() ? cleanUsd(f.monthly_cap_usd) : null);
const capChanged = (f: AgentForm, a?: AiAgent) => {
  const cap = capOf(f);
  return !a || (cap === null) !== (a.monthly_cap_usd === null) || (cap !== null && micro(cap) !== micro(a.monthly_cap_usd));
};

/** consequences the operator confirms before saving (the change itself is allowed) */
export function agentWarnings(f: AgentForm, ctx: AgentCtx = {}): AgentWarning[] {
  if (Object.keys(validateAgent(f, ctx)).length) return [];
  const out: AgentWarning[] = [];
  const cap = capOf(f);
  if (cap !== null && capChanged(f, ctx.agent) && ctx.monthSpentUsd != null) {
    const spent = micro(ctx.monthSpentUsd);
    if (spent !== null && micro(cap)! <= spent) out.push({ k: "monthBelowSpent", cap, spent: ctx.monthSpentUsd });
  }
  const per = cleanUsd(f.per_request_max_usd);
  if (perChanged(f, ctx.agent) && ctx.dayLimitUsd != null) {
    const day = micro(ctx.dayLimitUsd);
    if (day !== null && day < micro(per)!) out.push({ k: "dayBelowPerRequest", day: ctx.dayLimitUsd, per });
  }
  return out;
}

export const agentForm = (a: AiAgent): AgentForm => ({
  degraded_mode: a.degraded_mode,
  degrade_at_pct: String(a.degrade_at_pct),
  per_request_max_usd: trimZeros(a.per_request_max_usd),
  monthly_cap_usd: a.monthly_cap_usd == null ? "" : trimZeros(a.monthly_cap_usd),
  max_tool_calls: String(a.max_tool_calls),
  model_fallback: a.model_fallback ?? "",
});

/** "0.050000" → "$0.05", "0.045000" → "$0.045", "1" → "$1.00": an amount with no trailing zeros, at least cents */
export function usdShort(v: string): string {
  const t = trimZeros(v);
  const [i, f = ""] = t.split(".");
  return `$${i}.${f.padEnd(2, "0")}`;
}

/** "0.050000" → "0.05", "30.000000" → "30" (display in inputs) */
export function trimZeros(v: string): string {
  return v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
}

const MODEL_RE = /^[a-z0-9][a-z0-9.\-_]{2,63}$/;

export function validateAgent(f: AgentForm, ctx: AgentCtx = {}): AgentErrors {
  const e: AgentErrors = {};
  const pct = f.degrade_at_pct.trim();
  if (!/^\d{2,3}$/.test(pct) || Number(pct) < 50 || Number(pct) > 100) e.degrade_at_pct = "pct";
  const per = moneyIn(f.per_request_max_usd, 6, 1);
  const perM = micro(per);
  if (perM === null || perM < 1000n || perM > 1_000_000n) e.per_request_max_usd = "perRequest";
  // a request must fit the most expensive active / open skill version (ai-control: 409 AGENT_PER_REQUEST_BELOW_SKILL)
  else if (perChanged(f, ctx.agent) && skillAbove(per!, ctx.skillCosts)) e.per_request_max_usd = "belowSkill";
  if (f.monthly_cap_usd.trim()) {
    const cap = micro(moneyIn(f.monthly_cap_usd, 2, 4));
    if (cap === null || cap > 1000n * 1_000_000n) e.monthly_cap_usd = "cap";
    // month ≥ day (prototype lim_err_month; ai-control: 422 AGENT_MONTHLY_BELOW_DAILY)
    else if (capChanged(f, ctx.agent) && ctx.dayLimitUsd != null && micro(ctx.dayLimitUsd) !== null && cap < micro(ctx.dayLimitUsd)!) e.monthly_cap_usd = "monthBelowDay";
  }
  if (!/^[0-5]$/.test(f.max_tool_calls.trim())) e.max_tool_calls = "tools";
  if (f.model_fallback.trim() && !MODEL_RE.test(f.model_fallback.trim())) e.model_fallback = "model";
  return e;
}

/** PATCH body of the changed fields only (money as typed but normalised) */
export function agentPatch(a: AiAgent, f: AgentForm): Omit<AiAgentPatch, "reason" | "expected_version"> {
  const out: Omit<AiAgentPatch, "reason" | "expected_version"> = {};
  if (f.degraded_mode !== a.degraded_mode) out.degraded_mode = f.degraded_mode;
  if (Number(f.degrade_at_pct) !== a.degrade_at_pct) out.degrade_at_pct = Number(f.degrade_at_pct);
  if (micro(cleanUsd(f.per_request_max_usd)) !== micro(a.per_request_max_usd)) out.per_request_max_usd = cleanUsd(f.per_request_max_usd);
  const cap = f.monthly_cap_usd.trim() ? cleanUsd(f.monthly_cap_usd) : null;
  if ((cap === null) !== (a.monthly_cap_usd === null) || (cap !== null && micro(cap) !== micro(a.monthly_cap_usd))) out.monthly_cap_usd = cap;
  if (Number(f.max_tool_calls) !== a.max_tool_calls) out.max_tool_calls = Number(f.max_tool_calls);
  const fb = f.model_fallback.trim() || null;
  if (fb !== a.model_fallback) out.model_fallback = fb;
  return out;
}

// ---------------------------------------------------------------- access levels

export interface LevelForm {
  code: string;
  name_ru: string;
  name_en: string;
  messages: string;
  is_default: boolean;
}
export type LevelError = "code" | "name" | "messages" | "defaultZero";
export type LevelWarning = { k: "belowDefault"; level: AccessLevel; n: number } | { k: "othersBelow"; levels: AccessLevel[]; n: number };

const LEVEL_CODE_RE = /^[a-z][a-z0-9_]{1,31}$/;

/** first blocking error of the level dialog (in the order of the fields) */
export function levelErrors(f: LevelForm): LevelError | null {
  if (!LEVEL_CODE_RE.test(f.code)) return "code";
  if (!f.name_ru.trim() || !f.name_en.trim()) return "name";
  const n = f.messages.trim();
  if (!/^\d{1,4}$/.test(n) || Number(n) > 1000) return "messages";
  // the default level must allow at least one message (ai-control: 422 ACCESS_DEFAULT_ZERO)
  if (f.is_default && Number(n) === 0) return "defaultZero";
  return null;
}

/**
 * Allowed, but confirmed: a level below the default one (plus < basic — assigning it lowers the user's limit), or a
 * new default above other levels (ai-control answers with warnings[] LEVEL_BELOW_DEFAULT after the save).
 */
export function levelWarnings(f: LevelForm, levels: readonly AccessLevel[]): LevelWarning[] {
  if (levelErrors(f)) return [];
  const n = Number(f.messages.trim());
  const others = levels.filter((l) => l.code !== f.code);
  if (f.is_default) {
    const below = others.filter((l) => l.concierge_messages_per_day < n);
    return below.length ? [{ k: "othersBelow", levels: below, n }] : [];
  }
  const def = others.find((l) => l.is_default);
  return def && n < def.concierge_messages_per_day ? [{ k: "belowDefault", level: def, n }] : [];
}

// ---------------------------------------------------------------- price catalogue

export const RATE_FIELDS = ["input_usd_per_mtok", "output_usd_per_mtok", "cache_read_usd_per_mtok", "cache_write_usd_per_mtok"] as const;
export type RateField = (typeof RATE_FIELDS)[number] | "per_call_usd";

/** rate typed by an operator: "" — not set (null), else 0..1000 with ≤ 6 fraction digits */
export function rateIn(s: string): string | null | false {
  const v = cleanUsd(s);
  if (!v) return null;
  const m = moneyIn(v, 6, 4);
  if (m === null) return false;
  const x = micro(m)!;
  return x <= 1000n * 1_000_000n ? m : false;
}

/** model rows without all four token rates (the catalogue cannot be activated for a skill using them) */
export const incompleteModels = (items: PriceCatalogItem[]) =>
  items.filter((i) => i.kind === "model" && RATE_FIELDS.some((f) => i[f] == null)).map((i) => i.key);

// ---------------------------------------------------------------- skills

export const LIFECYCLE: readonly SkillStatus[] = ["DRAFT", "TESTED", "REVIEW", "PUBLISHED", "DEPRECATED"];

export const STATUS_TONE: Record<SkillStatus, Tone> = { DRAFT: "neutral", TESTED: "info", REVIEW: "warn", PUBLISHED: "good", DEPRECATED: "neutral" };

export type SkillAction = "save" | "requestReview" | "approve" | "reject" | "publish" | "rollback" | "deprecate";

/**
 * Buttons of a version by its lifecycle state (ai-control §2.2): permissions decide whether a button is locked
 * (Btn perm), the backend re-checks everything (four-eyes, tested content, immutability).
 */
export function skillActions(v: Pick<SkillVersion, "status" | "review" | "version">, activeVersion: number | null): SkillAction[] {
  switch (v.status) {
    case "DRAFT":
      return ["save"];
    case "TESTED":
      return ["save", "requestReview"];
    case "REVIEW":
      return v.review?.decision === "approved" ? ["publish", "reject"] : ["approve", "reject"];
    case "PUBLISHED":
      return v.version === activeVersion ? [] : ["rollback", "deprecate"];
    default:
      return [];
  }
}

/** an open (editable) version exists — a new draft is refused with 409 SKILL_DRAFT_EXISTS */
export const openVersion = (versions: Array<{ version: number; status: SkillStatus }>) =>
  versions.find((x) => x.status === "DRAFT" || x.status === "TESTED" || x.status === "REVIEW") ?? null;

/** which version to open first: the open one, else the active one, else the latest */
export function initialVersion(versions: Array<{ version: number; status: SkillStatus }>, active: number | null): number | null {
  const open = openVersion(versions);
  if (open) return open.version;
  if (active != null) return active;
  return versions.length ? Math.max(...versions.map((x) => x.version)) : null;
}

export const editable = (s: SkillStatus) => s === "DRAFT" || s === "TESTED" || s === "REVIEW";

export type SkillErrors = Partial<Record<"system_instruction" | "allowed_tools" | "primary" | "fallback" | "max_tokens" | "max_cost_usd" | "timeout_ms" | "retries" | "confidence" | "change_note" | "source_priority", string>>;

export const INSTRUCTION_MAX = 20_000;

/** form checks before PATCH (the server checks again: tools whitelist, priced models, agent per-request limit) */
export function validateSkill(c: SkillContent, whitelist: readonly string[] | null, perRequestMax: string | null): SkillErrors {
  const e: SkillErrors = {};
  if (!c.system_instruction.trim()) e.system_instruction = "empty";
  else if (c.system_instruction.length > INSTRUCTION_MAX) e.system_instruction = "long";
  if (whitelist && c.allowed_tools.some((x) => !whitelist.includes(x))) e.allowed_tools = "notAllowed";
  if (!MODEL_RE.test(c.model_policy.primary)) e.primary = "model";
  if (c.model_policy.fallback && !MODEL_RE.test(c.model_policy.fallback)) e.fallback = "model";
  if (!Number.isInteger(c.limits.max_tokens) || c.limits.max_tokens < 64 || c.limits.max_tokens > 4096) e.max_tokens = "range";
  const cost = micro(moneyIn(c.limits.max_cost_usd, 6, 1));
  if (cost === null || cost < 1000n || cost > 1_000_000n) e.max_cost_usd = "money";
  else if (perRequestMax && micro(perRequestMax) !== null && cost > micro(perRequestMax)!) e.max_cost_usd = "aboveAgent";
  if (!Number.isInteger(c.limits.timeout_ms) || c.limits.timeout_ms < 1000 || c.limits.timeout_ms > 120_000) e.timeout_ms = "range";
  if (!Number.isInteger(c.limits.retries) || c.limits.retries < 0 || c.limits.retries > 3) e.retries = "range";
  if (!(c.confidence.min >= 0 && c.confidence.min <= 1) || Math.round(c.confidence.min * 100) !== c.confidence.min * 100) e.confidence = "range";
  if ((c.change_note ?? "").length > 1000) e.change_note = "long";
  if (!c.source_priority.length) e.source_priority = "empty";
  return e;
}

/** the content fields of a version (what PATCH can change) */
export function contentOf(v: SkillVersion): SkillContent {
  const a = v.artifact;
  return {
    system_instruction: a.system_instruction,
    output_schema: a.output_schema,
    allowed_tools: [...a.allowed_tools],
    source_priority: [...a.source_priority],
    model_policy: { ...a.model_policy },
    limits: { ...a.limits, max_cost_usd: trimZeros(a.limits.max_cost_usd) },
    confidence: { ...a.confidence },
    safety_policy: { ...a.safety_policy },
    change_note: a.change_note,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** changed top-level content fields (PATCH sends only them; money compared by amount) */
export function skillChanges(base: SkillContent, f: SkillContent): Partial<SkillContent> {
  const out: Partial<SkillContent> = {};
  for (const k of Object.keys(f) as Array<keyof SkillContent>) {
    if (k === "limits") {
      const l = f.limits;
      const b = base.limits;
      if (l.max_tokens !== b.max_tokens || l.timeout_ms !== b.timeout_ms || l.retries !== b.retries || micro(cleanUsd(l.max_cost_usd)) !== micro(b.max_cost_usd)) {
        out.limits = { ...l, max_cost_usd: cleanUsd(l.max_cost_usd) };
      }
      continue;
    }
    if (k === "change_note") {
      if ((f.change_note ?? "").trim() !== (base.change_note ?? "").trim()) out.change_note = f.change_note?.trim() ? f.change_note.trim() : null;
      continue;
    }
    if (!same(f[k], base[k])) (out as Record<string, unknown>)[k] = f[k];
  }
  return out;
}

/** move an item of the source priority list up/down */
export function move<T>(list: readonly T[], idx: number, dir: -1 | 1): T[] {
  const j = idx + dir;
  if (j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[idx], out[j]] = [out[j]!, out[idx]!];
  return out;
}

/** UUID check (user filter of the request log) */
export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());

/** route id of the requests screen: a request id or «user:<uuid>» (log filtered by a user, from the user card) */
export function parseRequestsRoute(id: string | null): { request: string | null; user: string | null } {
  if (!id) return { request: null, user: null };
  if (id.startsWith("user:")) return { request: null, user: isUuid(id.slice(5)) ? id.slice(5).toLowerCase() : null };
  return { request: isUuid(id) ? id.toLowerCase() : null, user: null };
}
