import type { LessonSummary, StepAnswer, UiLang } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { Bff } from "../../api/bff";
import { ApiError } from "../../api/errors";
import { initialPlayer, isOpen, isRetryable, playerReducer, retryAiBusy, shouldRecheckSession, type PlayerState } from "../../domain/lessons";

const CLOSED = new Set(["SESSION_NOT_FOUND"]);

export interface PlayerApi {
  st: PlayerState;
  load(): Promise<void>;
  /** answer the step on screen; a lost answer stays pending and is re-sent unchanged by `resend` */
  answer(body: StepAnswer): Promise<void>;
  resend(): Promise<void>;
  /** «Дальше» after the feedback of a checked item */
  advance(): void;
  hint(): Promise<void>;
  simpler(): Promise<void>;
  pause(): Promise<boolean>;
  resume(): Promise<void>;
  retryRoleplay(): Promise<void>;
  finish(): Promise<LessonSummary | null>;
}

/**
 * The lesson player against the BFF: GET current (it starts the lesson and resumes it after a pause — «автоматическое
 * продолжение»), then the session for the header; answers go one at a time, a lost one is re-sent as is (the server
 * answers the same step the same way); STEP_NOT_CURRENT — the current step is shown again; the session finished or
 * cancelled elsewhere — the player closes; the AI gone in the middle of the roleplay — the session is re-read for the
 * plaque of the simplified mode; 409 AI_BUSY (the same answer is still processed) — the same request again in 2 s, ≤ 3
 * times.
 */
export function usePlayer(bff: Bff, sessionId: string, locale: UiLang = "ru"): PlayerApi {
  const [st, dispatch] = useReducer(playerReducer, initialPlayer);
  const ref = useRef(st);
  ref.current = st;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const safe = useCallback((a: Parameters<typeof dispatch>[0]) => {
    if (alive.current) dispatch(a);
  }, []);

  const load = useCallback(async () => {
    safe({ type: "loading" });
    try {
      const step = await bff.currentStep(sessionId);
      const session = await bff.lessonSession(sessionId);
      safe({ type: "loaded", session, step });
    } catch (e) {
      if (e instanceof ApiError && (CLOSED.has(e.code) || e.code === "SESSION_STATE")) safe({ type: "closed", error: e });
      else safe({ type: "failed", error: { kind: "load", error: e } });
    }
  }, [bff, sessionId, safe]);

  /** The server says the session or the step moved on: show what is current, or close. */
  const resync = useCallback(
    async (e: ApiError) => {
      try {
        if (e.code === "STEP_NOT_CURRENT" || e.code === "FREE_TEXT_NOT_ALLOWED") {
          safe({ type: "step", step: await bff.currentStep(sessionId), note: e });
          return;
        }
        const session = await bff.lessonSession(sessionId);
        if (!isOpen(session)) {
          safe({ type: "closed" });
          return;
        }
      } catch (err) {
        safe({ type: "failed", error: { kind: "load", error: err } });
        return;
      }
      // paused in another window: GET current continues it
      await load();
    },
    [bff, sessionId, safe, load],
  );

  /** The AI went away in the roleplay (R2-05): the session now says ai_degraded — the plaque without a reload. */
  const recheckSession = useCallback(async () => {
    try {
      safe({ type: "session", session: await bff.lessonSession(sessionId) });
    } catch {
      /* the plaque waits for the next load; the step itself is already on screen */
    }
  }, [bff, sessionId, safe]);

  /** 409 AI_BUSY: the same request again in 2 s (≤ 3 times) with «Секунду, ответ ещё обрабатывается». */
  const busyRetry = useCallback(
    <T,>(fn: () => Promise<T>) => retryAiBusy(fn, { onBusy: () => safe({ type: "busy", busy: true }), alive: () => alive.current }),
    [safe],
  );

  const send = useCallback(
    async (stepId: string, body: StepAnswer) => {
      safe({ type: "send", stepId, body });
      try {
        const prev = ref.current.step;
        const result = await busyRetry(() => bff.answerStep(sessionId, stepId, body));
        const recheck = shouldRecheckSession(prev, result, ref.current.session);
        safe({ type: "result", result });
        if (recheck) await recheckSession();
      } catch (e) {
        if (isRetryable(e)) safe({ type: "sendFailed", error: e });
        else if (e instanceof ApiError && (e.code === "STEP_NOT_CURRENT" || e.code === "SESSION_STATE" || e.code === "FREE_TEXT_NOT_ALLOWED")) await resync(e);
        else if (e instanceof ApiError && CLOSED.has(e.code)) safe({ type: "closed", error: e });
        else safe({ type: "failed", error: { kind: "action", error: e } });
      }
    },
    [bff, sessionId, safe, resync, recheckSession, busyRetry],
  );

  const answer = useCallback(
    async (body: StepAnswer) => {
      const s = ref.current;
      if (!s.step || s.phase === "sending" || s.phase === "finishing") return;
      await send(s.step.step_id, body);
    },
    [send],
  );

  const resend = useCallback(async () => {
    const p = ref.current.pending;
    if (p && ref.current.phase !== "sending") await send(p.stepId, p.body);
  }, [send]);

  const action = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        safe({ type: "busy", busy: false });
        if (e instanceof ApiError && (e.code === "STEP_NOT_CURRENT" || e.code === "SESSION_STATE")) await resync(e);
        else safe({ type: "failed", error: { kind: "action", error: e } });
      }
    },
    [resync, safe],
  );

  const hint = useCallback(
    () =>
      action(async () => {
        const step = ref.current.step;
        if (!step) return;
        safe({ type: "hint", hint: (await bff.stepHint(sessionId, step.step_id)).hint });
      }),
    [action, bff, sessionId, safe],
  );

  const simpler = useCallback(
    () => action(async () => safe({ type: "simpler", simpler: await busyRetry(() => bff.simpler(sessionId, locale)) })),
    [action, bff, sessionId, safe, locale, busyRetry],
  );

  const retryRoleplay = useCallback(() => action(async () => safe({ type: "step", step: await bff.retryRoleplay(sessionId) })), [action, bff, sessionId, safe]);

  const pause = useCallback(async (): Promise<boolean> => {
    try {
      safe({ type: "paused", session: await bff.pauseSession(sessionId) });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "SESSION_STATE") {
        // already paused (or closed) on the server
        const session = await bff.lessonSession(sessionId).catch(() => null);
        if (session?.status === "paused") safe({ type: "paused", session });
        else if (session && !isOpen(session)) safe({ type: "closed" });
        return !!session;
      }
      safe({ type: "failed", error: { kind: "action", error: e } });
      return false;
    }
  }, [bff, sessionId, safe]);

  const resume = useCallback(
    () =>
      action(async () => {
        await bff.resumeSession(sessionId).catch((e: unknown) => {
          // already running — GET current is enough
          if (!(e instanceof ApiError && e.code === "SESSION_STATE")) throw e;
        });
        await load();
      }),
    [action, bff, sessionId, load],
  );

  const finish = useCallback(async (): Promise<LessonSummary | null> => {
    safe({ type: "finishing" });
    try {
      return await bff.finishSession(sessionId);
    } catch (e) {
      // finish is allowed only from the «done» step: the server says where the lesson is
      if (e instanceof ApiError && (e.code === "STEP_NOT_CURRENT" || e.code === "SESSION_STATE")) await resync(e);
      else safe({ type: "finishFailed", error: e });
      return null;
    }
  }, [bff, sessionId, safe, resync]);

  const advance = useCallback(() => safe({ type: "advance" }), [safe]);

  return useMemo(
    () => ({ st, load, answer, resend, advance, hint, simpler, pause, resume, retryRoleplay, finish }),
    [st, load, answer, resend, advance, hint, simpler, pause, resume, retryRoleplay, finish],
  );
}
