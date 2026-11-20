import type { ReviewAnswer, ReviewHint, ReviewSummary } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Bff } from "../../api/bff";
import { newIdempotencyKey } from "../../api/client";
import { ApiError } from "../../api/errors";
import { canAnswer, initialReview, isRetryableReview, reviewReducer, type ReviewState } from "../../domain/memory";

export interface ReviewApi {
  st: ReviewState;
  /** 409 NOTHING_TO_REVIEW: there is nothing today (next_due_at — when the next card is due) */
  nothing: { nextDueAt: string | null } | null;
  begin(): Promise<void>;
  reload(): Promise<void>;
  answer(body: ReviewAnswer): Promise<void>;
  resend(): Promise<void>;
  advance(): void;
  hint(kind: ReviewHint["kind"]): Promise<void>;
  finish(): Promise<ReviewSummary | null>;
}

const CLOSED = new Set(["REVIEW_SESSION_STATE", "REVIEW_SESSION_NOT_FOUND"]);
/** GET current after the last task: 409 TASK_NOT_CURRENT {current_task_id: null} — all answered, finish. */
const allAnswered = (e: unknown) => e instanceof ApiError && e.code === "TASK_NOT_CURRENT" && !e.details.current_task_id;

/**
 * «Повторение дня» against the BFF: POST review-sessions (one Idempotency-Key per opening, reused after a lost answer —
 * the active session comes back, never a second one), GET current (re-entry continues from the same task), answers one
 * at a time — a lost one is re-sent unchanged (memory answers the same task the same way), TASK_NOT_CURRENT — the
 * current task is shown again, the session expired or cancelled elsewhere — the player closes; after the last task —
 * finish → the summary.
 */
export function useReview(bff: Bff): ReviewApi {
  const [st, dispatch] = useReducer(reviewReducer, initialReview);
  const [nothing, setNothingState] = useState<{ nextDueAt: string | null } | null>(null);
  const ref = useRef(st);
  ref.current = st;
  const alive = useRef(true);
  const key = useRef<string | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const safe = useCallback((a: Parameters<typeof dispatch>[0]) => {
    if (alive.current) dispatch(a);
  }, []);
  const setNothing = useCallback((n: { nextDueAt: string | null } | null) => {
    if (alive.current) setNothingState(n);
  }, []);

  const loadCurrent = useCallback(
    async (sessionId: string) => {
      const session = await bff.reviewSession(sessionId);
      if (session.status !== "active") {
        safe({ type: "closed" });
        return;
      }
      try {
        safe({ type: "loaded", session, task: await bff.reviewTask(sessionId) });
      } catch (e) {
        if (allAnswered(e)) safe({ type: "loaded", session, task: null });
        else throw e;
      }
    },
    [bff, safe],
  );

  const begin = useCallback(async () => {
    safe({ type: "loading" });
    key.current ??= newIdempotencyKey();
    try {
      const session = await bff.startReviewSession(key.current);
      setNothing(null);
      await loadCurrent(session.session_id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "NOTHING_TO_REVIEW") {
        key.current = null;
        setNothing({ nextDueAt: typeof e.details.next_due_at === "string" ? e.details.next_due_at : null });
        return;
      }
      if (e instanceof ApiError && CLOSED.has(e.code)) safe({ type: "closed", error: e });
      else safe({ type: "failed", error: { kind: "load", error: e } });
    }
  }, [bff, safe, loadCurrent, setNothing]);

  const reload = useCallback(async () => {
    const id = ref.current.session?.session_id;
    if (!id) return begin();
    safe({ type: "loading" });
    try {
      await loadCurrent(id);
    } catch (e) {
      if (e instanceof ApiError && CLOSED.has(e.code)) safe({ type: "closed", error: e });
      else safe({ type: "failed", error: { kind: "load", error: e } });
    }
  }, [begin, loadCurrent, safe]);

  const send = useCallback(
    async (taskId: string, body: ReviewAnswer) => {
      const id = ref.current.session?.session_id;
      if (!id) return;
      safe({ type: "send", taskId, body });
      try {
        safe({ type: "result", result: await bff.answerReviewTask(id, taskId, body) });
      } catch (e) {
        if (isRetryableReview(e)) safe({ type: "sendFailed", error: e });
        else if (e instanceof ApiError && e.code === "TASK_NOT_CURRENT") await reload();
        else if (e instanceof ApiError && CLOSED.has(e.code)) safe({ type: "closed", error: e });
        else safe({ type: "failed", error: { kind: "action", error: e } });
      }
    },
    [bff, safe, reload],
  );

  const answer = useCallback(
    async (body: ReviewAnswer) => {
      const s = ref.current;
      // a lost answer waits: only resend() sends it, unchanged
      if (!s.task || !canAnswer(s)) return;
      await send(s.task.task_id, body);
    },
    [send],
  );

  const resend = useCallback(async () => {
    const p = ref.current.pending;
    if (p && ref.current.phase !== "sending") await send(p.taskId, p.body);
  }, [send]);

  const hint = useCallback(
    async (kind: ReviewHint["kind"]) => {
      const s = ref.current;
      const id = s.session?.session_id;
      if (!id || !s.task || !canAnswer(s)) return;
      try {
        safe({ type: "hint", hint: await bff.reviewHint(id, s.task.task_id, kind) });
      } catch (e) {
        if (e instanceof ApiError && e.code === "TASK_NOT_CURRENT") await reload();
        else if (e instanceof ApiError && CLOSED.has(e.code)) safe({ type: "closed", error: e });
        else safe({ type: "failed", error: { kind: "action", error: e } });
      }
    },
    [bff, safe, reload],
  );

  const finish = useCallback(async (): Promise<ReviewSummary | null> => {
    const id = ref.current.session?.session_id;
    if (!id) return null;
    safe({ type: "finishing" });
    try {
      return await bff.finishReview(id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "TASK_NOT_CURRENT" && e.details.current_task_id) await reload();
      else if (e instanceof ApiError && CLOSED.has(e.code)) safe({ type: "closed", error: e });
      else safe({ type: "finishFailed", error: e });
      return null;
    }
  }, [bff, safe, reload]);

  const advance = useCallback(() => safe({ type: "advance" }), [safe]);

  return useMemo(() => ({ st, nothing, begin, reload, answer, resend, advance, hint, finish }), [st, nothing, begin, reload, answer, resend, advance, hint, finish]);
}
