import type { AreaResult, DiagnosticArea, DiagnosticResult, DiagnosticSession, DiagnosticState } from "@tilhero/contracts/bff";
import type { Band } from "@tilhero/contracts/content";

/**
 * Pure logic of the placement test screens (APP-DIAG-01…04): progress, the order of areas on the result, the
 * confidence scale in words, the evidence summary («почему так»), the follow-up window (24 h) and the retake date.
 * No correctness is ever computed on the client: the keys never reach it.
 */
export const BAND_LIST: readonly Band[] = ["A0", "A1", "A2", "B1", "B2"];
export const AREA_ORDER: readonly DiagnosticArea[] = ["vocabulary", "grammar", "reading", "listening", "speaking", "writing"];
/** follow-up (уточнение) — within 24 h after the result (INTERNAL_API §2.3) */
export const FOLLOWUP_WINDOW_MS = 24 * 3600_000;
/** listening items: the phrase may be played at most twice */
export const MAX_LISTENS = 2;

export function bandIndex(b: Band | null | undefined): number {
  return b ? BAND_LIST.indexOf(b) : -1;
}

/** Progress of a session: answered of the estimate, never above 100 %, the current item number (1-based). */
export function progressOf(session: Pick<DiagnosticSession, "answered" | "total_estimate">, position?: number | null) {
  const total = Math.max(1, session.total_estimate, session.answered + (position ? 1 : 0));
  const current = Math.min(position ?? session.answered + 1, total);
  return { answered: session.answered, total, current, pct: Math.min(100, Math.round((session.answered / total) * 100)) };
}

export type ConfidenceLevel = "high" | "medium" | "low";

/** Confidence 0..1 → three plain words and a 1..3 scale (shown as dots, never only as a colour). */
export function confidenceLevel(c: number | null | undefined): { level: ConfidenceLevel; dots: 1 | 2 | 3 } | null {
  if (c == null || !Number.isFinite(c)) return null;
  if (c >= 0.75) return { level: "high", dots: 3 };
  if (c >= 0.5) return { level: "medium", dots: 2 };
  return { level: "low", dots: 1 };
}

/** Areas in the fixed order of the result (vocabulary … writing); unknown ones at the end. */
export function orderedAreas(areas: readonly AreaResult[]): AreaResult[] {
  const rank = (a: AreaResult) => {
    const i = AREA_ORDER.indexOf(a.area);
    return i < 0 ? AREA_ORDER.length : i;
  };
  return [...areas].sort((a, b) => rank(a) - rank(b));
}

/** «Почему так»: the evidence of an area by band (answered / correct per band, no items), low bands first; a share for the
 *  bar. Rows with nothing answered are skipped. */
export function evidenceRows(evidence: AreaResult["evidence"]): Array<{ band: Band; answered: number; correct: number; pct: number }> {
  return evidence
    .filter((e) => e.answered > 0)
    .map((e) => ({ band: e.band, answered: e.answered, correct: Math.min(e.correct, e.answered), pct: Math.round((Math.min(e.correct, e.answered) / e.answered) * 100) }))
    .sort((a, b) => bandIndex(a.band) - bandIndex(b.band));
}

/** A result rests on at least one assessed area. Results without one are «unfinished in substance»: three of them within
 *  the retest period lock new attempts (409 DIAGNOSTIC_TOO_SOON — review of sprint 3). */
export function hasAssessedArea(result: Pick<DiagnosticResult, "areas"> | null | undefined): boolean {
  return !!result && result.areas.some((a) => a.status === "assessed");
}

/** Until when a follow-up of an area may be started (result + 24 h), or null when it is not offered. */
export function followupUntil(result: Pick<DiagnosticResult, "created_at">, area: Pick<AreaResult, "needs_followup" | "status">, now = Date.now()): Date | null {
  if (!area.needs_followup || area.status !== "assessed") return null;
  const t = Date.parse(result.created_at);
  if (!Number.isFinite(t)) return null;
  const until = new Date(t + FOLLOWUP_WINDOW_MS);
  return until.getTime() > now ? until : null;
}

/** A retake is allowed now (next_allowed_at is null or in the past). */
export function retakeAllowed(state: Pick<DiagnosticState, "next_allowed_at">, now = Date.now()): boolean {
  if (!state.next_allowed_at) return true;
  const t = Date.parse(state.next_allowed_at);
  return !Number.isFinite(t) || t <= now;
}

/** The unfinished session can still be continued (≤ 24 h, server says in_progress). */
export function canResume(state: Pick<DiagnosticState, "status" | "session">, now = Date.now()): boolean {
  if (state.status !== "in_progress" || !state.session || state.session.status !== "in_progress") return false;
  const t = Date.parse(state.session.expires_at);
  return !Number.isFinite(t) || t > now;
}

/* ---------- order_words: word bank and the answer line ---------- */

/** Tokens keep the index of the option, so repeated words («the … the») stay distinct. */
export interface OrderState {
  bank: number[];
  line: number[];
}

export const orderStart = (n: number): OrderState => ({ bank: Array.from({ length: n }, (_, i) => i), line: [] });

/** Tap on a word of the bank → to the end of the answer line (or before `at` when dropped there). */
export function orderPick(s: OrderState, token: number, at?: number): OrderState {
  if (!s.bank.includes(token) && !s.line.includes(token)) return s;
  const line = s.line.filter((t) => t !== token);
  const pos = at == null ? line.length : Math.max(0, Math.min(at, line.length));
  line.splice(pos, 0, token);
  return { bank: s.bank.filter((t) => t !== token), line };
}

/** Tap on a word of the answer line → back to the bank (in its original place). */
export function orderUnpick(s: OrderState, token: number): OrderState {
  if (!s.line.includes(token)) return s;
  return { bank: [...s.bank, token].sort((a, b) => a - b), line: s.line.filter((t) => t !== token) };
}

export const orderAnswer = (s: OrderState, options: readonly string[]): string[] => s.line.map((t) => options[t]!).filter((w) => w !== undefined);

/** The gap of a gap_choice prompt («She ___ a teacher.») split for highlighting. */
export function splitGap(prompt: string): [string, string] | null {
  const m = /_{2,}/.exec(prompt);
  if (!m) return null;
  return [prompt.slice(0, m.index), prompt.slice(m.index + m[0].length)];
}
