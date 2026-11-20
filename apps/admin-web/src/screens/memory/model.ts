/**
 * «Память и повторения» (sprint 5, ADM-MEM-01/02, AT-61): pure helpers — statuses and their tones, which manual action
 * fits a card (memory.manage: reschedule / reset / freeze / unfreeze; one card at a time, reason ≥ 10), the new due
 * date of a reschedule (noon of the chosen local day 1..365 days ahead — memory answers 422 DUE_AT_RANGE otherwise),
 * the Idempotency-Key of an action (kept for a retry after a network failure / 5xx), the title of a card (an error
 * card shows the label of its code, never a text derived from the learner's input), the routes of the section,
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
 * The new due moment of a reschedule: noon of the chosen local day (admin.ts: the client sends the chosen day as local
 * noon; memory allows ±1 day at the borders 1..365). The value depends only on the chosen day — not on the moment of
 * the render — so a retry sends the same body. null — outside 1..365 days from today or an invalid date.
 */
export function rescheduleDueAt(date: string, now: number = Date.now()): string | null {
  const n = daysUntil(date, now);
  if (!Number.isInteger(n) || n < DUE_MIN_DAYS || n > DUE_MAX_DAYS) return null;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12, 0, 0, 0).toISOString();
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

/**
 * What the admin shows as the name of a card. Words and phrases — their English text. An error card never shows a
 * text: its correction was derived from the learner's own free text (admin.ts: `text_en` is null there) — the label of
 * its error code instead (the card's gloss is that label), or the bare code. Even if a text arrives for an error card,
 * it is not shown.
 */
export function cardTitle(c: Pick<AdminCardRow, "kind" | "text_en" | "gloss" | "error_code">): { text: string; lang: "en" | "ru" | undefined; label: boolean } {
  if (c.kind !== "error" && c.text_en != null && c.text_en.trim() !== "") return { text: c.text_en, lang: "en", label: false };
  const label = c.kind === "error" ? c.gloss?.ru?.trim() : "";
  if (label) return { text: label, lang: "ru", label: true };
  return { text: c.error_code ?? "—", lang: undefined, label: true };
}

/**
 * The result of a command is unknown — a network failure or a 5xx (the server may have applied it): a retry must
 * carry the same Idempotency-Key (memory answers a repeat with the stored answer). A 4xx or a success settles the
 * command: the next one gets a new key.
 */
export function outcomeUnknown(e: unknown): boolean {
  const st = (e as { status?: unknown } | null)?.status;
  if (typeof st !== "number") return true;
  return st === 0 || st >= 500;
}

/**
 * The Idempotency-Key of a manual card action: one key per command (card + body). The same command repeated after a
 * network failure / 5xx reuses the key; a changed command (another action, day or reason — memory would answer 422
 * IDEMPOTENCY_KEY_REUSED for a key with another body) gets a new one; a success or a 4xx forgets the key.
 */
export class CommandKey {
  private pending: { sig: string; key: string } | null = null;
  constructor(private readonly gen: () => string) {}
  /** the key for this command */
  for(sig: string): string {
    if (!this.pending || this.pending.sig !== sig) this.pending = { sig, key: this.gen() };
    return this.pending.key;
  }
  /** the command answered: success (no error) or a definite error → forget the key; an unknown outcome → keep it */
  settle(error?: unknown): void {
    if (error === undefined || !outcomeUnknown(error)) this.pending = null;
  }
  get current(): string | null {
    return this.pending?.key ?? null;
  }
}

/** The signature of a manual card action for its Idempotency-Key. */
export const commandSig = (cardId: string, body: CardAction): string => JSON.stringify([cardId, body]);

/** Analytics: a rate is shown only when the group is not hidden and has a value. */
export const rateShown = (r: CheckRate): boolean => !r.hidden && r.pass_pct != null;
