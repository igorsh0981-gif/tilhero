import type { AiBudget, AiLimits, AiLimitsInput, AiLimitValues } from "@tilhero/contracts/admin";
import { micro } from "../ai/ai";

/* Fix 6.1 — AI limits from the admin (pure helpers of the «Limits» block; same bounds as admin-bff / provider-gateway).
   Sprint 7: + the AI concierge and Test Console daily budgets (their own, NOT inside the AI total; 0–50 each). */

export const AI_MAX_USD = 50;
export const PAGES_MAX = 5000;
const USD_RE = /^\d{1,2}(\.\d{1,2})?$/;

export interface LimitsForm {
  ai: string;
  news: string;
  pages: string;
  concierge: string;
  evaluation: string;
}
export type LimitField = keyof LimitsForm;
/** fields of the 6.1 block («AI search of events» screen) and of «Budgets and limits» (sprint 7) */
export const BASE_FIELDS: readonly LimitField[] = ["ai", "news", "pages"];
export const ALL_FIELDS: readonly LimitField[] = ["ai", "news", "pages", "concierge", "evaluation"];
/** error keys: lim.err.* */
export type LimitErrors = Partial<Record<LimitField, "money" | "aiMax" | "newsMax" | "pages" | "agentMax">>;

/** "2,5" → "2.5": a comma typed by habit is accepted; spaces dropped */
export const cleanMoney = (s: string) => s.trim().replace(/\s+/g, "").replace(",", ".");
/** money string → cents (integer), null when not a valid amount */
export function cents(s: string): number | null {
  const v = cleanMoney(s);
  if (!USD_RE.test(v)) return null;
  const [i, f = ""] = v.split(".");
  return Number(i) * 100 + Number(f.padEnd(2, "0"));
}
/** a decimal string from the server ("0.4213") in hundredths of a cent (1 USD = 10 000) */
const ten4 = (s: string | null | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 10_000) : 0;
};

export const formFromLimits = (l: AiLimitValues): LimitsForm => ({
  ai: l.ai_daily_usd,
  news: l.news_daily_usd,
  pages: String(l.pages_daily),
  concierge: l.concierge_daily_usd ?? "",
  evaluation: l.evaluation_daily_usd ?? "",
});

/** agent budgets the provider-gateway does not report yet (6.1 gateway: null) — hidden, «unavailable until the update» */
export const AGENT_LIMIT_FIELDS = ["concierge", "evaluation"] as const;
const agentValue = (l: AiLimitValues, k: (typeof AGENT_LIMIT_FIELDS)[number]) =>
  k === "concierge" ? l.concierge_daily_usd : l.evaluation_daily_usd;
export const missingLimits = (l: AiLimitValues, fields: readonly LimitField[]): LimitField[] =>
  AGENT_LIMIT_FIELDS.filter((k) => fields.includes(k) && agentValue(l, k) == null);
/** the fields the block can show and change for these limits */
export const availableLimits = (l: AiLimitValues, fields: readonly LimitField[]): LimitField[] => {
  const miss = missingLimits(l, fields);
  return fields.filter((k) => !miss.includes(k));
};

export function validateLimits(f: LimitsForm): LimitErrors {
  const e: LimitErrors = {};
  const ai = cents(f.ai);
  const news = cents(f.news);
  if (ai === null) e.ai = "money";
  else if (ai > AI_MAX_USD * 100) e.ai = "aiMax";
  if (news === null) e.news = "money";
  else if (ai !== null && news > ai) e.news = "newsMax";
  const p = f.pages.trim();
  if (!/^\d{1,4}$/.test(p) || Number(p) > PAGES_MAX) e.pages = "pages";
  for (const k of ["concierge", "evaluation"] as const) {
    const c = cents(f[k]);
    if (c === null) e[k] = "money";
    else if (c > AI_MAX_USD * 100) e[k] = "agentMax";
  }
  return e;
}

/** body of PUT (money as typed but normalised: "2,5" → "2.5"); the agent budgets only when the block shows them —
 *  without them provider-gateway keeps the current values */
export function valuesFromForm(f: LimitsForm, fields: readonly LimitField[] = BASE_FIELDS): Omit<AiLimitsInput, "reason"> {
  const v: Omit<AiLimitsInput, "reason"> = { ai_daily_usd: cleanMoney(f.ai), news_daily_usd: cleanMoney(f.news), pages_daily: Number(f.pages.trim()) };
  if (fields.includes("concierge")) v.concierge_daily_usd = cleanMoney(f.concierge);
  if (fields.includes("evaluation")) v.evaluation_daily_usd = cleanMoney(f.evaluation);
  return v;
}

/** money value of a field in the PUT body (display of the new value) */
export const formMoney = (f: LimitsForm, k: Exclude<LimitField, "pages">) => cleanMoney(f[k]);

/** which values differ from the current limits (by amount: "2.5" = "2.50") */
export function changedLimits(l: AiLimitValues, f: LimitsForm, fields: readonly LimitField[] = BASE_FIELDS): LimitField[] {
  const out: LimitField[] = [];
  if (cents(f.ai) !== cents(l.ai_daily_usd)) out.push("ai");
  if (cents(f.news) !== cents(l.news_daily_usd)) out.push("news");
  if (f.pages.trim() !== String(l.pages_daily)) out.push("pages");
  if (l.concierge_daily_usd != null && cents(f.concierge) !== cents(l.concierge_daily_usd)) out.push("concierge");
  if (l.evaluation_daily_usd != null && cents(f.evaluation) !== cents(l.evaluation_daily_usd)) out.push("evaluation");
  return out.filter((k) => fields.includes(k));
}

/**
 * New limits below what is already used today: spent is not reverted, the next AI calls get 429 until midnight UTC.
 * Only for valid values.
 */
export function belowUsed(f: LimitsForm, b: AiBudget | null, agentsSpent: Partial<Record<"concierge" | "evaluation", string>> = {}): LimitField[] {
  const out: LimitField[] = [];
  for (const k of ["concierge", "evaluation"] as const) {
    const c = cents(f[k]);
    if (c !== null && agentsSpent[k] != null && c * 100 < ten4(agentsSpent[k])) out.push(k);
  }
  if (!b) return out;
  const ai = cents(f.ai);
  const news = cents(f.news);
  if (ai !== null && ai * 100 < ten4(b.spent_usd)) out.push("ai");
  if (news !== null && b.news && news * 100 < ten4(b.news.spent_usd)) out.push("news");
  const p = Number(f.pages.trim());
  if (/^\d+$/.test(f.pages.trim()) && p < b.pages_used) out.push("pages");
  return out;
}

export const isDefault = (l: AiLimits) =>
  cents(l.ai_daily_usd) === cents(l.defaults.ai_daily_usd) &&
  cents(l.news_daily_usd) === cents(l.defaults.news_daily_usd) &&
  l.pages_daily === l.defaults.pages_daily &&
  sameMoney(l.concierge_daily_usd, l.defaults.concierge_daily_usd) &&
  sameMoney(l.evaluation_daily_usd, l.defaults.evaluation_daily_usd);
/** null / absent (6.1 gateway) on either side → not compared */
const sameMoney = (a: string | null | undefined, b: string | null | undefined) => a == null || b == null || cents(a) === cents(b);

/** per-request / monthly limits of the agents with their own daily budget (ai-control agent config) */
export type AgentCaps = Partial<Record<"concierge" | "evaluation", { per_request_max_usd: string; monthly_cap_usd: string | null }>>;
export type LimitWarning = { k: "dayBelowPerRequest" | "dayAboveMonth"; f: "concierge" | "evaluation"; v: string };

/**
 * Review 7 (M3): a daily budget of the concierge / Test Console below the agent's per-request limit (no request fits
 * the day) or above its monthly cap (the month ends first). Allowed — confirmed in the save dialog. Changed fields only.
 */
export function agentLimitWarnings(f: LimitsForm, caps: AgentCaps, changed: readonly LimitField[]): LimitWarning[] {
  const out: LimitWarning[] = [];
  for (const k of AGENT_LIMIT_FIELDS) {
    const c = cents(f[k]);
    const cap = caps[k];
    if (c === null || !cap || !changed.includes(k)) continue;
    const day = BigInt(c) * 10_000n; // µ$
    const per = micro(cap.per_request_max_usd);
    if (per !== null && day < per) out.push({ k: "dayBelowPerRequest", f: k, v: cap.per_request_max_usd });
    const month = micro(cap.monthly_cap_usd);
    if (month !== null && day > month) out.push({ k: "dayAboveMonth", f: k, v: cap.monthly_cap_usd! });
  }
  return out;
}
