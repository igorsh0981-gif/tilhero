import type {
  EvaluationView,
  LessonCard,
  LessonSession,
  LessonStep,
  LessonSummary,
  SessionStage,
  SimplerExplanation,
  SkillState,
  StepAnswer,
  StepItemType,
  StepResult,
  Trajectory,
} from "@tilhero/contracts/bff";
import type { Localized } from "@tilhero/contracts/content";
import { ApiError } from "../api/errors";

/**
 * Pure logic of the lessons (sprint 4): stage header, minute ranges of the lesson card, how an item is answered, the
 * roleplay chat assembled from the server history and the local transcript, which errors are retried with the same
 * answer, and the lesson player as a reducer (transitions between steps, feedback, pause, idempotent re-send).
 */

export type RoleplayStep = Extract<LessonStep, { type: "roleplay" }>;
export type ItemStep = Extract<LessonStep, { type: "item" }>;
export type ExplanationStep = Extract<LessonStep, { type: "explanation" }>;
export type ListenStep = Extract<LessonStep, { type: "listen" }>;
export type RoleplayEndStep = Extract<LessonStep, { type: "roleplay_end" }>;
export type OpenAnswerStep = Extract<LessonStep, { type: "open_answer" }>;
export type Reply = NonNullable<StepResult["reply"]>;
export type Feedback = NonNullable<StepResult["feedback"]>;

/* ---------------------------------------------------------------- stages */

export type StageStatus = "done" | "current" | "pending" | "skipped";

/**
 * The stages of the header. The session knows the order and the skipped ones; the current stage is the stage of the
 * step on screen (the session object is not reloaded after every answer): before it — done, after it — pending.
 */
export function stageStrip(session: Pick<LessonSession, "stages" | "stage">, step: Pick<LessonStep, "stage"> | null): {
  stages: Array<{ type: SessionStage; status: StageStatus }>;
  current: SessionStage | null;
  index: number;
  total: number;
  done: number;
} {
  const current = step?.stage ?? session.stage ?? null;
  const at = current ? session.stages.findIndex((s) => s.type === current) : -1;
  const stages = session.stages.map((s, i): { type: SessionStage; status: StageStatus } => {
    if (s.status === "skipped") return { type: s.type, status: "skipped" };
    if (at < 0) return { type: s.type, status: s.status };
    return { type: s.type, status: i < at ? "done" : i === at ? "current" : "pending" };
  });
  const visible = stages.filter((s) => s.status !== "skipped");
  const index = Math.max(1, visible.findIndex((s) => s.type === current) + 1);
  return { stages, current, index, total: Math.max(1, visible.length), done: visible.filter((s) => s.status === "done").length };
}

/** «0–3», «3–7» … — minute ranges of the stages on the lesson card. */
export function stageRanges<T extends { minutes: number }>(stages: readonly T[]): Array<T & { from: number; to: number }> {
  let at = 0;
  return stages.map((s) => {
    const from = at;
    at += Math.max(0, s.minutes);
    return { ...s, from, to: at };
  });
}

/* ---------------------------------------------------------------- items */

export type ItemKind = "choice" | "gapChoice" | "gap" | "order" | "lines";

/** How an item is answered: an index (choice), the word of a gap (chosen or typed), words or lines in order. */
export function itemKind(type: StepItemType, options: readonly string[]): ItemKind {
  if (type === "order_words") return "order";
  if (type === "order_lines") return "lines";
  if (type === "gap_fill" || type === "gap_fill_media") return options.length ? "gapChoice" : "gap";
  return "choice";
}

/** The value of an item answer: index | word | words/lines in order; null — nothing chosen yet. */
export type Draft = number | string | string[] | null;

/** The body sent for an item. A typed gap is trimmed; an empty one is not an answer. */
export function itemAnswer(draft: Draft): StepAnswer | null {
  if (draft === null) return null;
  if (typeof draft === "string") {
    const v = draft.trim();
    return v ? { answer: v } : null;
  }
  if (Array.isArray(draft)) return draft.length ? { answer: [...draft] } : null;
  return { answer: draft };
}

/** Text of the learner's answer for the chat and the summary (choice → its line). */
export function learnerLine(step: RoleplayStep, body: StepAnswer): string {
  if (body.text) return body.text.trim();
  return step.choices.find((c) => c.choice_id === body.choice_id)?.text_en ?? "";
}

/* ---------------------------------------------------------------- roleplay */

/** Children never type (owner's decision); after two unclear answers on a node — only the choices. */
export function canTypeFreeText(step: Pick<RoleplayStep, "free_text_allowed" | "unclear_attempts">, kid: boolean): boolean {
  return !kid && step.free_text_allowed && step.unclear_attempts < 2;
}

export const TEXT_MAX = 500;

export interface Bubble {
  id: string;
  who: "learner" | "character";
  text: string;
  gloss: Localized | null;
  characterId: string | null;
  clarification?: boolean;
  pending?: boolean;
}

function tailAfterLearner(list: readonly Bubble[]): readonly Bubble[] {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.who === "learner") return list.slice(i + 1);
  return list;
}

/**
 * Bubbles of the roleplay chat. The server history (last turns of the scene) is the truth when it is there; otherwise
 * the local transcript of this screen. Then the character's last reply (AI or the next line of the graph) and the line
 * of the current node — each only if the character has not already said it since the learner's last turn; a
 * clarifying reply («Sorry, what would you like?») is itself the prompt, the node line is not repeated after it.
 */
export function chatBubbles(step: RoleplayStep, local: readonly Bubble[], reply: Reply | null): Bubble[] {
  const out: Bubble[] = step.history.length
    ? step.history.map((h) => ({ id: h.turn_id, who: h.speaker, text: h.text_en, gloss: null, characterId: h.character_id }))
    : local.map((b) => ({ ...b }));
  const said = (text: string) => tailAfterLearner(out).find((b) => b.who === "character" && b.text === text);
  if (reply) {
    const b = said(reply.text_en);
    if (b) {
      b.gloss ??= reply.gloss;
      if (reply.clarification) b.clarification = true;
    } else out.push({ id: `reply-${out.length}`, who: "character", text: reply.text_en, gloss: reply.gloss, characterId: reply.character_id, clarification: reply.clarification });
  }
  // the translation of the node line goes to that line wherever it was said (also before a clarification)
  for (let i = out.length - 1; i >= 0; i--) {
    const b = out[i]!;
    if (b.who === "character" && b.text === step.line_en) {
      b.gloss ??= step.gloss;
      break;
    }
  }
  if (!reply?.clarification && !said(step.line_en)) {
    out.push({ id: `line-${step.node_id}-${out.length}`, who: "character", text: step.line_en, gloss: step.gloss, characterId: step.character.id });
  }
  return out;
}

/* ---------------------------------------------------------------- errors */

/** A lost answer (no network, BFF or domain down, rate limit, still processed) is re-sent as is — the server answers it
 *  the same way. */
export function isRetryable(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.code === "RATE_LIMITED" || e.code === "AI_BUSY");
}

/**
 * 409 AI_BUSY (steps, simpler): lessons is still processing the same answer (the AI thinks). «Секунду, ответ ещё
 * обрабатывается» — the same answer again in 2 s, at most 3 times; then «Отправить ещё раз».
 */
export const AI_BUSY_RETRY_MS = 2_000;
export const AI_BUSY_RETRIES = 3;
export const isAiBusy = (e: unknown): boolean => e instanceof ApiError && e.code === "AI_BUSY";

/**
 * Calls `fn`; on AI_BUSY waits and calls it again (the same request), at most `retries` times; `onBusy` before each
 * wait. `alive` — stop waiting when the screen is gone (the last AI_BUSY is thrown then).
 */
export async function retryAiBusy<T>(
  fn: () => Promise<T>,
  o: { onBusy?: (attempt: number) => void; alive?: () => boolean; delayMs?: number; retries?: number } = {},
): Promise<T> {
  const retries = o.retries ?? AI_BUSY_RETRIES;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isAiBusy(e) || attempt > retries || (o.alive && !o.alive())) throw e;
      o.onBusy?.(attempt);
      await new Promise((r) => setTimeout(r, o.delayMs ?? AI_BUSY_RETRY_MS));
      if (o.alive && !o.alive()) throw e;
    }
  }
}

/**
 * Why an answer did not come back (review R2-02) — the learner is told differently:
 *  - network — no connection (status 0, fetch failed): check the internet and send the same answer again;
 *  - service — the service answers slowly or is temporarily down (503/504, any 5xx: the BFF did not wait for the AI,
 *    the answer may already be saved) — re-sending the same answer is safe, the domain is idempotent by step;
 *  - rate — too many requests (429): wait and send again;
 *  - busy — 409 AI_BUSY still after the automatic repeats: the answer is being processed, send it again a bit later.
 */
export type SendFailure = "network" | "service" | "rate" | "busy";
export function sendFailure(e: unknown): SendFailure {
  if (e instanceof ApiError && e.code === "RATE_LIMITED") return "rate";
  if (isAiBusy(e)) return "busy";
  if (e instanceof ApiError && e.status >= 500) return "service";
  return "network";
}

/**
 * The AI went away in the middle of the roleplay (review R2-05): the free text got a clarification («Let's choose an
 * answer») and the node is offered with choices only. The session now says ai_degraded — re-read it to show the plaque
 * without a reload. Not when the session already says so, and not for a step that never allowed free text.
 */
export function shouldRecheckSession(prev: LessonStep | null, result: Pick<StepResult, "reply" | "next">, session: Pick<LessonSession, "ai_degraded"> | null): boolean {
  if (!session || session.ai_degraded) return false;
  if (prev?.type !== "roleplay" || !prev.free_text_allowed) return false;
  return result.reply?.clarification === true && result.next.type === "roleplay" && !result.next.free_text_allowed;
}

/** The plaque of the simplified mode: from the first step of a degraded session (AI off at the start), not on «done». */
export function showsDegraded(session: Pick<LessonSession, "ai_degraded"> | null, step: Pick<LessonStep, "type"> | null): boolean {
  return !!session?.ai_degraded && !!step && step.type !== "done";
}

/* ---------------------------------------------------------------- the player */

export type PlayerPhase = "loading" | "ready" | "sending" | "finishing" | "paused" | "closed";

export interface PlayerError {
  /** send — the answer did not go (re-send the same); load — the step did not load; note — informational */
  kind: "send" | "load" | "action" | "note";
  error: unknown;
}

export interface PlayerState {
  session: LessonSession | null;
  step: LessonStep | null;
  phase: PlayerPhase;
  /** a checked item (retrieval, meaning check): «верно / неверно» with the right answer until «Дальше» */
  checked: { stepId: string; feedback: Feedback; next: LessonStep } | null;
  /** the character's last reply in the roleplay */
  reply: Reply | null;
  /** local transcript of the scene (when the server sends no history) */
  chat: Bubble[];
  hint: Localized | null;
  /** «Объясни проще» results under the explanation (the position does not change) */
  simpler: SimplerExplanation[];
  /** the answer in flight or lost: re-sent exactly as is */
  pending: { stepId: string; body: StepAnswer } | null;
  error: PlayerError | null;
  /** graded steps answered — each shows «Ответ принят» */
  accepted: number;
  /** 409 AI_BUSY: «Секунду, ответ ещё обрабатывается» while the same request is repeated */
  busy: boolean;
}

export type PlayerAction =
  | { type: "loading" }
  | { type: "loaded"; session: LessonSession; step: LessonStep }
  | { type: "send"; stepId: string; body: StepAnswer }
  | { type: "result"; result: StepResult }
  | { type: "advance" }
  | { type: "sendFailed"; error: unknown }
  | { type: "failed"; error: PlayerError }
  | { type: "step"; step: LessonStep; note?: unknown }
  | { type: "hint"; hint: Localized }
  | { type: "simpler"; simpler: SimplerExplanation }
  | { type: "session"; session: LessonSession }
  | { type: "paused"; session: LessonSession }
  | { type: "finishing" }
  | { type: "finishFailed"; error: unknown }
  | { type: "closed"; error?: unknown }
  | { type: "clearError" }
  | { type: "busy"; busy: boolean };

export const initialPlayer: PlayerState = {
  session: null,
  step: null,
  phase: "loading",
  checked: null,
  reply: null,
  chat: [],
  hint: null,
  simpler: [],
  pending: null,
  error: null,
  accepted: 0,
  busy: false,
};

const keepsChat = (s: LessonStep) => s.type === "roleplay" || s.type === "roleplay_end";

export function playerReducer(state: PlayerState, a: PlayerAction): PlayerState {
  switch (a.type) {
    case "loading":
      return { ...state, phase: "loading", error: null };
    case "loaded":
      return { ...initialPlayer, accepted: state.accepted, session: a.session, step: a.step, phase: a.session.status === "paused" ? "paused" : "ready" };
    case "send":
      return { ...state, phase: "sending", pending: { stepId: a.stepId, body: a.body }, error: null };
    case "sendFailed":
      // the same answer stays pending: «Отправить ещё раз» re-sends it unchanged
      return { ...state, phase: "ready", busy: false, error: { kind: "send", error: a.error } };
    case "failed":
      return { ...state, phase: "ready", busy: false, pending: null, error: a.error };
    case "result": {
      const prev = state.step;
      if (!prev) return state;
      const r = a.result;
      if (prev.type === "item" && !prev.graded_later && r.feedback) {
        return { ...state, phase: "ready", busy: false, pending: null, error: null, checked: { stepId: prev.step_id, feedback: r.feedback, next: r.next } };
      }
      let chat = state.chat;
      if (prev.type === "roleplay" && state.pending) {
        chat = [
          ...chatBubbles(prev, state.chat, state.reply),
          { id: `me-${prev.step_id}-${state.chat.length}`, who: "learner", text: learnerLine(prev, state.pending.body), gloss: null, characterId: null },
        ];
      }
      const stay = keepsChat(r.next);
      return {
        ...state,
        step: r.next,
        phase: "ready",
        busy: false,
        pending: null,
        error: null,
        checked: null,
        hint: null,
        simpler: [],
        reply: stay ? r.reply : null,
        chat: stay ? chat : [],
        accepted: prev.type === "item" && prev.graded_later ? state.accepted + 1 : state.accepted,
      };
    }
    case "advance":
      if (!state.checked) return state;
      return { ...state, step: state.checked.next, checked: null, hint: null, simpler: [], error: null };
    case "step":
      // a fresh step from the server (the current one after STEP_NOT_CURRENT, the retry point of the roleplay)
      return {
        ...state,
        step: a.step,
        phase: "ready",
        busy: false,
        checked: null,
        hint: null,
        simpler: [],
        pending: null,
        reply: null,
        chat: [],
        error: a.note !== undefined ? { kind: "note", error: a.note } : null,
      };
    case "hint":
      return { ...state, hint: a.hint, error: null };
    case "simpler":
      return { ...state, simpler: [...state.simpler, a.simpler], busy: false, error: null };
    case "session":
      return { ...state, session: a.session };
    case "paused":
      return { ...state, session: a.session, phase: "paused", error: null };
    case "finishing":
      return { ...state, phase: "finishing", error: null };
    case "finishFailed":
      return { ...state, phase: "ready", error: { kind: "action", error: a.error } };
    case "closed":
      return { ...state, phase: "closed", pending: null, error: a.error !== undefined ? { kind: "action", error: a.error } : null };
    case "clearError":
      return { ...state, error: null };
    case "busy":
      return { ...state, busy: a.busy };
  }
}

/* ---------------------------------------------------------------- summary, plan, history */

export type ScoreWord = "0" | "1" | "2" | "3" | "null";
export const scoreWord = (s: 0 | 1 | 2 | 3 | null): ScoreWord => (s === null ? "null" : (String(s) as ScoreWord));

/** Error types of the evaluator (ai-gateway rules) and of the closed items (assessment) — words for the learner. */
export const ERROR_TYPES = [
  "missing_be", "third_person_s", "wrong_tense", "verb_form", "article", "preposition", "plural", "word_order", "question_form",
  "pronoun", "vocabulary", "gap_fill", "line_order", "wrong_choice", "other",
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];
export const errorType = (code: string): ErrorType => ((ERROR_TYPES as readonly string[]).includes(code) ? (code as ErrorType) : "other");

/** A copy of an evaluation older than 90 days: the fragment and the correction are erased (empty) — only the type. */
export const errorRedacted = (e: { evidence: string; correction: string }): boolean => !e.evidence.trim() && !e.correction.trim();

/** Items to show in the summary: only the wrong ones (with the learner's and the right answer). */
export function wrongItems(e: EvaluationView): EvaluationView["items"] {
  return e.items.filter((i) => !i.correct);
}

/** The current evaluation after an appeal / QA re-evaluation: superseded_by → the newer one. */
export function needsActualEvaluation(e: EvaluationView | null): string | null {
  return e?.superseded_by ?? null;
}

/** An appeal is filed within 14 days of the evaluation (the current record of the chain; assessment: 409
 *  APPEAL_WINDOW_CLOSED after that). */
export const APPEAL_WINDOW_DAYS = 14;
const DAY_MS = 24 * 3600_000;

/** When the appeal window of this evaluation closes (null — the date is unreadable: the server decides). */
export function appealClosesAt(e: Pick<EvaluationView, "created_at">): number | null {
  const at = Date.parse(e.created_at);
  return Number.isFinite(at) ? at + APPEAL_WINDOW_DAYS * DAY_MS : null;
}

/**
 * «Оспорить оценку» (review R2-04): open — the button; closed — the 14 days are over, a short note instead; none —
 * nothing (no evaluation, an appeal exists, replaced, practice, a methodologist checks it anyway).
 */
export type AppealState = "open" | "closed" | "none";
export function appealState(e: EvaluationView | null, now: number = Date.now()): AppealState {
  if (!e || e.appeal || e.superseded_by || e.practice_only || e.status === "pending_review") return "none";
  const closes = appealClosesAt(e);
  return closes !== null && now > closes ? "closed" : "open";
}

export function canAppeal(e: EvaluationView | null, now: number = Date.now()): boolean {
  return appealState(e, now) === "open";
}

/**
 * «Оценка появится позже» (review R2-03): there is no message in Telegram about it, so while the summary is open the
 * Mini App re-reads it itself — 6 attempts with these pauses (~2 min), then only «Проверить оценку».
 */
export const EVAL_POLL_DELAYS_MS: readonly number[] = [5_000, 10_000, 15_000, 20_000, 30_000, 40_000];

/** A completed session whose evaluation is not there yet. */
export function needsEvaluationPoll(s: Pick<LessonSummary, "status" | "evaluation"> | null): boolean {
  return !!s && s.status === "completed" && s.evaluation === null;
}

/**
 * Re-reads the summary on the schedule until the evaluation is there: `onReady` gets the summary with it, `onEnd` is
 * called when the attempts are over without it. A failed read counts as an attempt. Returns `stop` (the screen closed).
 */
export function pollEvaluation(
  read: () => Promise<LessonSummary>,
  on: { ready: (s: LessonSummary) => void; end?: () => void },
  delays: readonly number[] = EVAL_POLL_DELAYS_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const attempt = (i: number) => {
    if (stopped) return;
    if (i >= delays.length) {
      on.end?.();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void read().then(
        (s) => {
          if (stopped) return;
          if (!needsEvaluationPoll(s)) on.ready(s);
          else attempt(i + 1);
        },
        () => attempt(i + 1),
      );
    }, delays[i]);
  };
  attempt(0);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

/** Order of skill states for «из → в» (a demonstration is shown as progress, a step back — neutrally). */
export const SKILL_ORDER: readonly SkillState[] = ["not_started", "learning", "demonstrated", "retained"];

/** A lesson of the plan: passed / to repeat / evaluation later. */
export type CompletedMark = "passed" | "again" | "later";
export function completedMark(c: Trajectory["completed"][number]): CompletedMark {
  return c.passed === true ? "passed" : c.passed === false ? "again" : "later";
}

/** Lessons of the plan without the next one and without those already passed. */
export function planLists(t: Trajectory): { mandatory: Trajectory["mandatory"]; optional: Trajectory["optional"] } {
  const next = t.next?.lesson_id;
  const passed = new Set(t.completed.filter((c) => c.passed === true).map((c) => c.lesson_id));
  const keep = <T extends LessonCard>(l: T) => l.lesson_id !== next && !passed.has(l.lesson_id);
  return { mandatory: t.mandatory.filter(keep), optional: t.optional.filter(keep) };
}

/** An open session: «Продолжить урок». */
export const isOpen = (s: Pick<LessonSession, "status"> | null | undefined): boolean => !!s && ["ready", "in_progress", "paused"].includes(s.status);

/** The session the player was showing when the page went away (reload of the Mini App): continue it at boot. */
const PLAYER_KEY = "tilhero.player";
export const playerMarker = {
  set(id: string): void {
    try {
      window.sessionStorage?.setItem(PLAYER_KEY, id);
    } catch {
      /* storage unavailable */
    }
  },
  get(): string | null {
    try {
      return window.sessionStorage?.getItem(PLAYER_KEY) ?? null;
    } catch {
      return null;
    }
  },
  clear(): void {
    try {
      window.sessionStorage?.removeItem(PLAYER_KEY);
    } catch {
      /* ignore */
    }
  },
};
