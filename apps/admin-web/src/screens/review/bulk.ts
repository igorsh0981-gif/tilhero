import type { ReviewBulkResult, ReviewItem } from "@tilhero/contracts/admin";

/* Fix 5.1 (FEEDBACK_5_1 §F): bulk decisions in «Event review», «Not confirmed» (EXPIRED) and the auto-expiry countdown. */

/** events: an OPEN card without a decision for REVIEW_EXPIRE_DAYS days becomes EXPIRED («Not confirmed») */
export const REVIEW_EXPIRE_DAYS = 7;
/** admin-bff / events: 1..100 cards per bulk command */
export const BULK_MAX = 100;
const DAY = 86_400_000;

/** statuses whose rows can be selected: OPEN → bulk reject, EXPIRED → back to the queue */
export const SELECTABLE: ReadonlySet<ReviewItem["status"]> = new Set(["OPEN", "EXPIRED"]);

/**
 * Days left before an OPEN card is removed automatically, rounded to the nearest day (2 d 21 h → 3, 6 d 2 h → 6);
 * 0 — less than a day (or already overdue: the hourly job has not run yet). null — no `expires_at` (an old events,
 * or not OPEN).
 */
export function daysLeft(expiresAt: string | null | undefined, now: number): number | null {
  const at = expiresAt ? Date.parse(expiresAt) : NaN;
  if (Number.isNaN(at)) return null;
  const ms = at - now;
  return ms < DAY ? 0 : Math.max(1, Math.round(ms / DAY));
}

/** «select all on the page»: all rows selected → none; otherwise → all (id → content_hash the operator saw) */
export function toggleAll(sel: ReadonlyMap<string, string>, rows: readonly Pick<ReviewItem, "review_id" | "content_hash">[]): Map<string, string> {
  const all = rows.length > 0 && rows.every((r) => sel.has(r.review_id));
  return all ? new Map() : new Map(rows.map((r) => [r.review_id, r.content_hash]));
}

export function toggleOne(sel: ReadonlyMap<string, string>, row: Pick<ReviewItem, "review_id" | "content_hash">): Map<string, string> {
  const next = new Map(sel);
  if (next.has(row.review_id)) next.delete(row.review_id);
  else next.set(row.review_id, row.content_hash);
  return next;
}

/** keep only the selected rows that are still on the screen (after a reload / a decision elsewhere) */
export function pruneSelection(sel: ReadonlyMap<string, string>, rows: readonly Pick<ReviewItem, "review_id">[]): Map<string, string> {
  const ids = new Set(rows.map((r) => r.review_id));
  return new Map([...sel].filter(([id]) => ids.has(id)));
}

export interface BulkSummary {
  done: number;
  skipped: number;
  /** skipped rows grouped by the reason code, most frequent first */
  byCode: Array<{ code: string; ids: string[] }>;
}

/** «Rejected N, skipped M (why)» from the per-row results of bulk-reject / bulk-reopen */
export function summarize(res: ReviewBulkResult): BulkSummary {
  const groups = new Map<string, string[]>();
  let done = 0;
  for (const r of res.results) {
    if (r.status !== "SKIPPED") {
      done++;
      continue;
    }
    const code = r.code || "SKIPPED";
    groups.set(code, [...(groups.get(code) ?? []), r.review_id]);
  }
  const byCode = [...groups].map(([code, ids]) => ({ code, ids })).sort((a, b) => b.ids.length - a.ids.length || a.code.localeCompare(b.code));
  return { done, skipped: byCode.reduce((n, g) => n + g.ids.length, 0), byCode };
}

/** skip reasons with their own text (rv.skip.<CODE>); anything else — the generic text with the code */
export const SKIP_CODES = ["REVIEW_CHANGED", "REVIEW_ALREADY_DECIDED", "REVIEW_NOT_FOUND"] as const;
