import type {
  CardStrength,
  ContentRef,
  LearnerSummary,
  MemoryOverview,
  PronunciationView,
  ReadingView,
  ReviewAnswer,
  ReviewHint,
  ReviewSession,
  ReviewTask,
  ReviewTaskResult,
} from "@tilhero/contracts/bff";
import { ApiError } from "../api/errors";

/**
 * Pure logic of sprint 5 in the Mini App (bff.ts «Спринт 5»): the «Повторение дня» card of Home, the tiles of «Собери
 * слово» and the typed answer, the review player as a reducer (feedback, the check block without hints, a lost answer
 * re-sent as is), who may record the voice, the targets of «Произнести», the words of a reading text that can be tapped
 * (glossary terms highlighted). No key ever reaches the client: correctness comes only from the server.
 */

const DAY_MS = 24 * 3600_000;

/* ---------------------------------------------------------------- Home: «Повторение дня» */

export type ReviewCardState =
  /** an unfinished session: «Продолжить» */
  | { kind: "continue"; sessionId: string; due: number; fresh: number; checks: number }
  /** something to review today: «Начать» */
  | { kind: "start"; due: number; fresh: number; checks: number; doneToday: boolean }
  /** the review of today is done and nothing is left: a calm state with the next date */
  | { kind: "done"; nextDueAt: string | null }
  /** nothing to review (no cards yet, or everything is ahead): the nearest date */
  | { kind: "empty"; nextDueAt: string | null; total: number };

export function reviewCardState(o: MemoryOverview): ReviewCardState {
  const due = Math.max(0, o.due_count);
  const fresh = Math.max(0, o.new_available);
  const checks = Math.max(0, o.retention_due);
  if (o.active_session_id) return { kind: "continue", sessionId: o.active_session_id, due, fresh, checks };
  if (due + fresh + checks > 0) return { kind: "start", due, fresh, checks, doneToday: o.done_today };
  if (o.done_today) return { kind: "done", nextDueAt: o.next_due_at };
  return { kind: "empty", nextDueAt: o.next_due_at, total: o.total_cards };
}

/** «около N минут»: the notifications formula (INTERNAL_API §6) — 0.4 min per card, 2..15. */
export function reviewMinutes(cards: number): number {
  if (cards <= 0) return 0;
  return Math.min(15, Math.max(2, Math.ceil(cards * 0.4)));
}

/** Whole days until `iso` (0 — today or already due). null — unknown date. */
export function daysUntil(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - now) / DAY_MS));
}

/* ---------------------------------------------------------------- strength */

/** Bars of the strength meter: the state is told by the number of bars AND a word (never by colour alone). */
export const STRENGTH_BARS: Record<CardStrength, 0 | 1 | 2 | 3> = { new: 0, weak: 1, ok: 2, strong: 3 };

/* ---------------------------------------------------------------- typed answer */

export const TYPED_MAX = 200;

/** The typed answer as sent: NFC, whitespace collapsed, trimmed, ≤ 200; empty → null (no answer yet). The server
 *  compares it (case, punctuation, contractions); the client never decides correctness. */
export function typedAnswer(raw: string): ReviewAnswer | null {
  const v = raw.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, TYPED_MAX);
  return v ? { text: v } : null;
}

/* ---------------------------------------------------------------- tiles («Собери») */

/** Tiles picked in order (indices into `tiles`): the same letter twice stays two tiles. */
export interface Tiles {
  picked: number[];
}

export const tilesStart = (): Tiles => ({ picked: [] });

/** Tap a free tile → to the end of the answer. */
export function tilesPick(s: Tiles, i: number, n: number): Tiles {
  if (!Number.isInteger(i) || i < 0 || i >= n || s.picked.includes(i)) return s;
  return { picked: [...s.picked, i] };
}

/** Tap a tile of the answer → it goes back (wherever it stands). */
export function tilesUnpick(s: Tiles, i: number): Tiles {
  return s.picked.includes(i) ? { picked: s.picked.filter((x) => x !== i) } : s;
}

/** «Отменить»: the last tile goes back. */
export function tilesUndo(s: Tiles): Tiles {
  return s.picked.length ? { picked: s.picked.slice(0, -1) } : s;
}

export const tilesFree = (s: Tiles, n: number): number[] => Array.from({ length: n }, (_, i) => i).filter((i) => !s.picked.includes(i));

/** Letters (every tile one character): the word is assembled without spaces; words — with spaces. */
export const isLetterTiles = (tiles: readonly string[]): boolean => tiles.length > 0 && tiles.every((t) => [...t].length === 1);

export function tilesText(s: Tiles, tiles: readonly string[]): string {
  const parts = s.picked.map((i) => tiles[i] ?? "");
  return isLetterTiles(tiles) ? parts.join("") : parts.join(" ");
}

/** The answer is sent when every tile is used (the server checks the exact order). */
export function tilesAnswer(s: Tiles, n: number): ReviewAnswer | null {
  return n > 0 && s.picked.length === n ? { order: [...s.picked] } : null;
}

/* ---------------------------------------------------------------- the review player */

export type ReviewPhase =
  | "loading"
  | "ready"
  | "sending"
  /** the result of a graded task until «Дальше» */
  | "feedback"
  /** the end of a check block: its result until «Дальше» */
  | "checkDone"
  /** all tasks answered: POST …/finish */
  | "done"
  | "finishing"
  /** the session ended elsewhere (expired, cancelled, finished) */
  | "closed";

export interface ReviewError {
  /** send — the answer did not go (re-send the same); load — the task did not load; action — a hint, finish */
  kind: "send" | "load" | "action";
  error: unknown;
}

export interface ReviewState {
  phase: ReviewPhase;
  session: ReviewSession | null;
  task: ReviewTask | null;
  /** the answer result on screen (feedback or the check block) — its `next` follows on «Дальше» */
  result: ReviewTaskResult | null;
  /** hints taken on the task on screen */
  firstLetter: string | null;
  revealed: string | null;
  /** the answer in flight or lost: re-sent exactly as is */
  pending: { taskId: string; body: ReviewAnswer } | null;
  error: ReviewError | null;
  /** answers of a check block accepted («Ответ принят») */
  accepted: number;
}

export type ReviewAction =
  | { type: "loading" }
  | { type: "loaded"; session: ReviewSession; task: ReviewTask | null }
  | { type: "task"; task: ReviewTask }
  | { type: "send"; taskId: string; body: ReviewAnswer }
  | { type: "result"; result: ReviewTaskResult }
  | { type: "advance" }
  | { type: "sendFailed"; error: unknown }
  | { type: "failed"; error: ReviewError }
  | { type: "hint"; hint: ReviewHint }
  | { type: "finishing" }
  | { type: "finishFailed"; error: unknown }
  | { type: "closed"; error?: unknown };

export const initialReview: ReviewState = {
  phase: "loading",
  session: null,
  task: null,
  result: null,
  firstLetter: null,
  revealed: null,
  pending: null,
  error: null,
  accepted: 0,
};

const onTask = (state: ReviewState, task: ReviewTask | null): ReviewState => ({
  ...state,
  task,
  phase: task ? "ready" : "done",
  result: null,
  firstLetter: task?.hints_used.includes("first_letter") && task.task_id === state.task?.task_id ? state.firstLetter : null,
  revealed: task?.hints_used.includes("reveal") && task.task_id === state.task?.task_id ? state.revealed : null,
  pending: null,
  error: null,
});

export function reviewReducer(state: ReviewState, a: ReviewAction): ReviewState {
  switch (a.type) {
    case "loading":
      return { ...state, phase: "loading", error: null };
    case "loaded":
      return onTask({ ...state, session: a.session }, a.task);
    case "task":
      return onTask(state, a.task);
    case "send":
      return { ...state, phase: "sending", pending: { taskId: a.taskId, body: a.body }, error: null };
    case "sendFailed":
      // the same answer stays pending: «Отправить ещё раз» re-sends it unchanged
      return { ...state, phase: "ready", error: { kind: "send", error: a.error } };
    case "failed":
      return { ...state, phase: state.task ? "ready" : "loading", pending: null, error: a.error };
    case "result": {
      const r = a.result;
      const prev = state.task;
      const accepted = prev?.type === "check_item" ? state.accepted + 1 : state.accepted;
      if (r.check_result) return { ...state, phase: "checkDone", result: r, pending: null, error: null, accepted };
      // intro («Понятно» / «Знаю это») and an answer inside a check block: no feedback, the next task at once
      if (r.result === null) return { ...onTask(state, r.next), accepted };
      return { ...state, phase: "feedback", result: r, pending: null, error: null, accepted };
    }
    case "advance":
      if (!state.result || (state.phase !== "feedback" && state.phase !== "checkDone")) return state;
      return onTask(state, state.result.next);
    case "hint":
      return a.hint.kind === "first_letter" ? { ...state, firstLetter: a.hint.text, error: null } : { ...state, revealed: a.hint.text, error: null };
    case "finishing":
      return { ...state, phase: "finishing", error: null };
    case "finishFailed":
      return { ...state, phase: "done", error: { kind: "action", error: a.error } };
    case "closed":
      return { ...state, phase: "closed", pending: null, error: a.error !== undefined ? { kind: "action", error: a.error } : null };
  }
}

/** A lost answer (no network, BFF or memory down, rate limit) is re-sent as is — memory answers it the same way. */
export function isRetryableReview(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.code === "RATE_LIMITED");
}

/** Progress of the session: answered tasks of the (growing) total. */
export function reviewProgress(task: Pick<ReviewTask, "index" | "total"> | null, s: Pick<ReviewSession, "done_tasks" | "total_tasks"> | null): { done: number; total: number } {
  if (task) return { done: Math.max(0, task.index - 1), total: Math.max(task.total, task.index) };
  if (s) return { done: s.done_tasks, total: Math.max(s.total_tasks, s.done_tasks) };
  return { done: 0, total: 0 };
}

/** What the task asks to show as the main line (by type, bff.ts ReviewTask.prompt). */
export function splitBlank(text: string | null | undefined): [string, string] | null {
  if (!text) return null;
  const m = /_{2,}/.exec(text);
  return m ? [text.slice(0, m.index), text.slice(m.index + m[0].length)] : null;
}

/* ---------------------------------------------------------------- pronunciation */

/** What «Произнести» shows: the recording, an explanation of the missing consent (self / a teen / a child), nothing. */
export type PronunciationAccess = "record" | "consent_self" | "consent_teen" | "consent_child" | "hidden";

export function pronunciationAccess(p: MemoryOverview["pronunciation"] | null | undefined, learner: Pick<LearnerSummary, "kind">): PronunciationAccess {
  switch (p) {
    case "available":
      return "record";
    case "consent_self":
      return "consent_self";
    case "consent_guardian":
      return learner.kind === "child" ? "consent_child" : "consent_teen";
    default:
      return "hidden";
  }
}

/** ?target= of POST /v1/memory/pronunciation: a card or a sentence of published content (the server takes its text). */
export const cardTarget = (cardId: string): string => `card:${cardId}`;
export function sentenceTarget(ref: ContentRef): string {
  return `sentence:${ref.kind}:${ref.key}:${ref.version}:${ref.locator ?? ""}`;
}

/** A word of the result: said clearly, worth practising, missed, extra. Accent is not an error (PLAN «Произношение»). */
export type WordMark = "ok" | "practice" | "missed" | "extra";
export function wordMark(w: PronunciationView["words"][number]): WordMark {
  if (w.error_type === "omission") return "missed";
  if (w.error_type === "insertion") return "extra";
  if (w.error_type === "mispronunciation") return "practice";
  return w.accuracy !== null && w.accuracy < 60 ? "practice" : "ok";
}

/* ---------------------------------------------------------------- reading: tappable words */

/** A piece of a sentence: plain text (spaces, punctuation, numbers) or a word that can be tapped; `term` — the index
 *  of the glossary entry it belongs to (highlighted; a multi-word term is one piece). */
export type Piece = { kind: "text"; text: string } | { kind: "word"; text: string; term: number | null };

const WORD = /[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+)*/g;
const norm = (s: string) => s.toLowerCase().replace(/[’‘`]/g, "'");

/** The words of a phrase in normalised form («I’d like» → ["i'd", "like"]). */
export function wordsOf(text: string): string[] {
  return [...text.matchAll(WORD)].map((m) => norm(m[0]));
}

/**
 * The sentence as pieces: every English word can be tapped (only words of the published text are ever translated);
 * glossary terms (one or several words, longest first) are joined into one highlighted piece.
 */
export function sentencePieces(text: string, glossary: ReadonlyArray<Pick<ReadingView["glossary"][number], "en">>): Piece[] {
  const words = [...text.matchAll(WORD)].map((m) => ({ text: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, n: norm(m[0]) }));
  const terms = glossary
    .map((g, i) => ({ i, w: wordsOf(g.en) }))
    .filter((t) => t.w.length > 0)
    .sort((a, b) => b.w.length - a.w.length);
  const out: Piece[] = [];
  let at = 0;
  let wi = 0;
  const push = (p: Piece) => {
    const last = out[out.length - 1];
    if (p.kind === "text" && last?.kind === "text") last.text += p.text;
    else if (p.text) out.push(p);
  };
  while (wi < words.length) {
    const w = words[wi]!;
    const term = terms.find((t) => t.w.every((x, k) => words[wi + k]?.n === x));
    const span = term ? term.w.length : 1;
    const last = words[wi + span - 1]!;
    // a multi-word term must not jump over punctuation («to. Go» is not «to go»)
    const between = text.slice(w.start, last.end);
    const ok = !term || span === 1 || /^[A-Za-z'’\s-]+$/.test(between);
    const end = ok ? last.end : w.end;
    push({ kind: "text", text: text.slice(at, w.start) });
    push({ kind: "word", text: text.slice(w.start, end), term: ok && term ? term.i : null });
    at = end;
    wi += ok ? span : 1;
  }
  push({ kind: "text", text: text.slice(at) });
  return out;
}

/** The ContentRef of a sentence of a reading text (translation by tap, «В словарь», «Произнести»). */
export function readingRef(r: Pick<ReadingView, "reading_id" | "version">, sId: string): ContentRef {
  return { kind: "reading", key: r.reading_id, version: r.version, locator: sId };
}
