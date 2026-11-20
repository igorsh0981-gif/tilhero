/**
 * «Память и повторения» (sprint 5, ADM-MEM-01/02, AT-61): pure helpers — statuses and their tones, which manual action
 * fits a card (memory.manage: reschedule / reset / freeze / unfreeze; one card at a time, reason ≥ 10), the new due
 * date of a reschedule (1..365 days from now — memory answers 422 DUE_AT_RANGE otherwise), the routes of the section,
 * and the hidden groups of the forgetting analytics (fewer than 5 learners — «мало данных», never a zero).
 */
import type { AdminCardRow, AdminCardStatus, CardAction, CheckRate, ReviewLogRow, RetentionCheckRow } from "@tilhero/contracts/admin";
import type { Tone } from "../../ui/kit";

export const CARD_STATUSES: readonly AdminCardStatus[] = ["new", "learning", "review", "known", "frozen", "archived"];
export const CARD_KINDS: readonly AdminCardRow["kind"][] = ["word", "phrase", "error"];
export const CHECK_STATUSES: readonly RetentionCheckRow["status"][] = ["scheduled", "in_session", "passed", "failed", "cancelled"];
export const CARD_ACTIONS: readonly CardAction["action"][] = ["reschedule", "reset", "freeze", "unfreeze"];
export const GRADES: readonly NonNullable<ReviewLogRow["grade"]>[] = ["again", "hard", "good"];
export const ANSWER_MODES: readonly ReviewLogRow["answer_mode"][] = ["choice", "typed", "assemble", "listen", "manual"];
export const LOG_ACTORS: readonly ReviewLogRow["actor"][] = ["learner", "system", "staff"];
export const FSRS_STATES: readonly ReviewLogRow["before"]["state"][] = ["new", "learning", "review"];
export const MEMORY_TABS = ["analytics", "learners"] as const;
export type MemoryTab = (typeof MEMORY_TABS)[number];
export const REASON_MIN = 10;
export const REASON_MAX = 300;
export const DUE_MIN_DAYS = 1;
export const DUE_MAX_DAYS = 365;
const DAY = 86_400_000;

export const CARD_TONE: Record<AdminCardStatus, Tone> = { new: "info", learning: "warn", review: "good", known: "accent", frozen: "neutral", archived: "neutral" };
export const CHECK_TONE: Record<RetentionCheckRow["status"], Tone> = { scheduled: "info", in_session: "accent", passed: "good", failed: "bad", cancelled: "neutral" };
export const GRADE_TONE: Record<NonNullable<ReviewLogRow["grade"]>, Tone> = { again: "bad", hard: "warn", good: "good" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string | null | undefined): s is string => !!s && UUID_RE.test(s.trim());

/** #/memory[/analytics] · #/memory/learners[/<user_id>[/<card_id>]] */
export function parseMemoryRoute(id: string | null): { tab: MemoryTab | null; user: string | null; card: string | null } {
  const [head, user, card] = (id ?? "").split("/");
  if (head === "learners") return { tab: "learners", user: isUuid(user) ? user!.toLowerCase() : null, card: isUuid(user) && isUuid(card) ? card!.toLowerCase() : null };
  if (head === "analytics") return { tab: "analytics", user: null, card: null };
  return { tab: null, user: null, card: null };
}

/** The tabs a staff member gets: analytics — memory.read | dashboard.read; a learner's memory — memory.read. */
export function memoryTabs(can: (p: "memory.read" | "dashboard.read") => boolean): MemoryTab[] {
  const out: MemoryTab[] = [];
  if (can("memory.read") || can("dashboard.read")) out.push("analytics");
  if (can("memory.read")) out.push("learners");
  return out;
}

/** Which manual actions fit the card's status (memory answers 409 CARD_STATE otherwise). */
export function allowedActions(status: AdminCardStatus): Record<CardAction["action"], boolean> {
  const live = status !== "archived";
  return {
    reschedule: live && status !== "frozen" && status !== "known",
    reset: live && status !== "new",
    freeze: live && status !== "frozen",
    unfreeze: status === "frozen",
  };
}

/** YYYY-MM-DD of a moment in the browser's zone. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whole days from today (local) to the chosen local date; NaN for an invalid date. */
export function daysUntil(date: string, now: number = Date.now()): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Number.NaN;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(y, m - 1, d);
  if (target.getFullYear() !== y || target.getMonth() !== m - 1 || target.getDate() !== d) return Number.NaN;
  const t0 = new Date(now);
  const today = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate());
  return Math.round((target.getTime() - today.getTime()) / DAY);
}

/**
 * The new due moment of a reschedule: the chosen day at the current time of day — exactly N whole days from now, so
 * a date 1..365 days ahead is always inside memory's range. null — outside the range or invalid.
 */
export function rescheduleDueAt(date: string, now: number = Date.now()): string | null {
  const n = daysUntil(date, now);
  if (!Number.isInteger(n) || n < DUE_MIN_DAYS || n > DUE_MAX_DAYS) return null;
  return new Date(now + n * DAY).toISOString();
}

export function actionBody(action: CardAction["action"], reason: string, dueAt: string | null): CardAction | null {
  const r = reason.trim();
  if (r.length < REASON_MIN || r.length > REASON_MAX) return null;
  if (action === "reschedule") return dueAt ? { action, due_at: dueAt, reason: r } : null;
  return { action, reason: r };
}

/** A card is overdue when its due moment has passed (learning / review only — new, known, frozen are not due). */
export function isOverdue(c: Pick<AdminCardRow, "due_at" | "status">, now: number = Date.now()): boolean {
  return (c.status === "learning" || c.status === "review") && !!c.due_at && Date.parse(c.due_at) < now;
}

/** Analytics: a rate is shown only when the group is not hidden and has a value. */
export const rateShown = (r: CheckRate): boolean => !r.hidden && r.pass_pct != null;
