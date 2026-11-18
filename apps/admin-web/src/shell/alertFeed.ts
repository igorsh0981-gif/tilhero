import type { AlertFeedItem, OpsAlert } from "@tilhero/contracts/admin";
import type { I18n, MessageKey } from "../i18n";
import { fmtUsd } from "../lib/money";
import { alertTarget, alertText, subjectText, tOr } from "../screens/monitoring/Alerts";

/** agents with a dictionary name (until / without the ai-control agent list) */
const KNOWN = new Set(["concierge", "evaluation", "discovery", "news"]);

/** text of an AI budget alert of the feed (sprint 7 wording) */
export function aiAlertText(i: Pick<I18n, "t">, x: AlertFeedItem): string {
  const p = x.params as { period?: string; threshold?: number; spent_usd?: string | null; limit_usd?: string | null; auto_paused?: boolean; detail?: string | null };
  if (x.kind === "unpriced") return i.t("ai.alert.unpriced", { m: p.detail?.startsWith("model:") ? p.detail.slice(6) : (p.detail ?? "") });
  const kind = p.auto_paused ? "autoPause" : p.period === "month" ? "month" : "day";
  const base = i.t(`ai.alert.${kind}` as MessageKey, { n: p.threshold ?? 0 });
  return p.spent_usd && p.limit_usd ? `${base} · ${fmtUsd(p.spent_usd, 4)} / ${fmtUsd(p.limit_usd, 2)}` : base;
}

/** who: the agent (ai-control name, else the dictionary, else the id) or the provider / consumer / service */
export function feedWho(i: Pick<I18n, "t">, x: AlertFeedItem, names?: ReadonlyMap<string, string> | null): string {
  if (x.source !== "ai") return subjectText(i, x.subject_type, x.subject);
  return names?.get(x.subject) ?? (KNOWN.has(x.subject) ? i.t(`bell.agent.${x.subject}` as MessageKey) : x.subject);
}

/** what happened, in words (codes and numbers only) */
export function feedWhat(i: Pick<I18n, "t" | "tp" | "fmt">, x: AlertFeedItem): string {
  if (x.source === "ai") return aiAlertText(i, x);
  const a = { kind: x.kind as OpsAlert["kind"], params: x.params as OpsAlert["params"], subject_type: x.subject_type as OpsAlert["subject_type"], subject: x.subject };
  return `${tOr(i, `mon.ak.${x.kind}`, x.kind)} · ${alertText(i, a)}`;
}

/** where «Open» leads: AI → «Budgets and limits», ops → its tab of «Monitoring» */
export function feedTarget(x: AlertFeedItem): { page: string; id: string | null } {
  return x.source === "ai" ? { page: "budgets", id: null } : alertTarget(x.subject_type, x.subject);
}

/** a source is worth a warning only when it did not answer — «not connected» is a deployment state, not a problem */
export function feedProblem(f: { sources: { ops: string; ai: string } }): "ops" | "ai" | "both" | null {
  const ops = f.sources.ops === "unavailable";
  const ai = f.sources.ai === "unavailable";
  return ops && ai ? "both" : ops ? "ops" : ai ? "ai" : null;
}
