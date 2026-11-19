import type { DiagnosticArea, DiagnosticItem, DiagnosticResult, DiagnosticSession, DiagnosticState } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useRef, useState } from "react";
import { newIdempotencyKey } from "../../api/client";
import { ApiError, errorText } from "../../api/errors";
import { canResume, hasAssessedArea, progressOf } from "../../domain/diagnostics";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { confirmPopup, haptic, loadVoices, pickEnglishVoice } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, HERO, Hero, Margin, NoBreakHyphens, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { ItemActions, ItemView, type Answer } from "./ItemView";
import { ResultView } from "./Result";

type Mode = { k: "auto" } | { k: "intro" } | { k: "run"; session: DiagnosticSession } | { k: "result"; result: DiagnosticResult };

/**
 * Placement test (APP-DIAG-01…04, AT-32…34): intro → items → result. Pause any time (the session lives 24 h on the
 * server, «Продолжить» resumes it); the result shows the provisional level with the CEFR disclaimer, follow-up for an
 * uncertain area and the retake date.
 */
export function Diagnostics() {
  const { bff, nav, session } = useApp();
  const { t, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const state = useLoad(() => bff.diagnosticsState(), [session.learner.learner_id]);
  const [mode, setMode] = useState<Mode>({ k: "auto" });
  const startKey = useRef<string | null>(null);
  const [tooSoon, setTooSoon] = useState<string | null>(null);

  const start = useAction(async () => {
    setTooSoon(null);
    startKey.current ??= newIdempotencyKey();
    try {
      const s = await bff.startDiagnostic(startKey.current);
      startKey.current = null;
      haptic.impact("medium");
      setMode({ k: "run", session: s });
    } catch (e) {
      if (e instanceof ApiError && e.code === "DIAGNOSTIC_TOO_SOON") {
        startKey.current = null;
        setTooSoon(typeof e.details.next_allowed_at === "string" ? e.details.next_allowed_at : "");
        return;
      }
      throw e;
    }
  });
  const followup = useAction(async (resultId: string, area: DiagnosticArea) => {
    const s = await bff.followup(resultId, area);
    setMode({ k: "run", session: s });
  });

  const finished = useCallback(
    (r: DiagnosticResult) => {
      haptic.notify("success");
      setMode({ k: "result", result: r });
      void state.reload();
    },
    [state],
  );

  const running = mode.k === "run";
  const onBack = () => {
    if (running) showToast(t("dx.paused"));
    nav.back();
  };

  let body;
  if (mode.k === "run") {
    body = (
      <TestRunner
        key={mode.session.session_id}
        session={mode.session}
        onFinished={finished}
        onPause={onBack}
        onRestart={() => {
          void state.reload();
          setMode({ k: "intro" });
        }}
      />
    );
  } else if (mode.k === "result") {
    body = (
      <ResultView
        result={mode.result}
        nextAllowedAt={state.data?.next_allowed_at ?? null}
        actions
        busyArea={followup.busy}
        actionError={followup.error ?? start.error}
        onFollowup={(area) => void followup.run(mode.result.result_id, area)}
        onRetake={() => void retake()}
        retakeBusy={start.busy}
      />
    );
  } else if (state.loading && !state.data) {
    body = (
      <main className="scroll">
        <div className="pad">
          <Skeleton lines={3} />
        </div>
      </main>
    );
  } else if (state.error && !state.data) {
    body = (
      <main className="scroll">
        <div className="pad">
          <div className="card err stack tight">
            <p className="sub ink">{state.error}</p>
            <Btn variant="secondary" onClick={() => void state.reload()}>{t("c.retry")}</Btn>
          </div>
        </div>
      </main>
    );
  } else if (mode.k === "auto" && state.data?.status === "completed" && state.data.last_result) {
    body = (
      <ResultView
        result={state.data.last_result}
        nextAllowedAt={state.data.next_allowed_at}
        actions
        busyArea={followup.busy}
        actionError={followup.error ?? start.error}
        onFollowup={(area) => void followup.run(state.data!.last_result!.result_id, area)}
        onRetake={() => void retake()}
        retakeBusy={start.busy}
      />
    );
  } else {
    body = (
      <Intro
        state={state.data}
        kid={kid}
        busy={start.busy}
        error={tooSoon !== null ? t(tooSoonKey(state.data), { date: tooSoon ? fmt.date(tooSoon) : "" }) : start.error}
        onStart={() => void start.run()}
        onResume={(s) => setMode({ k: "run", session: s })}
      />
    );
  }

  async function retake() {
    const ok = await confirmPopup({ title: t("dxr.retakeConfirm.title"), message: t("dxr.retakeConfirm.text"), ok: t("dxr.retake"), cancel: t("c.cancel") });
    if (ok) await start.run();
  }

  return (
    <>
      <Bar title={t("dx.title")} onBack={onBack} />
      <div className="dx dx-wrap" data-testid="diagnostics">{body}</div>
    </>
  );
}

/** 409 DIAGNOSTIC_TOO_SOON has two causes (review of sprint 3): the retest interval after a real result, or three
 *  results without an assessed area in that period. The domain does not say which — the last result does. */
export function tooSoonKey(state: DiagnosticState | null): MessageKey {
  return hasAssessedArea(state?.last_result) ? "dxr.retakeAt" : "dx.tooManyUnfinished";
}

/* ---------------------------------------------------------------- intro */

const INTRO_AREAS = ["vocabulary", "grammar", "reading", "listening"] as const;

function Intro(props: { state: DiagnosticState | null; kid: boolean; busy: boolean; error: string | null; onStart: () => void; onResume: (s: DiagnosticSession) => void }) {
  const { t, fmt } = useI18n();
  const { state, kid } = props;
  const resumable = state && canResume(state) ? state.session : null;
  const restart = async () => {
    const ok = await confirmPopup({ title: t("dx.restartConfirm.title"), message: t("dx.restartConfirm.text"), ok: t("dx.restart"), cancel: t("c.cancel"), destructive: true });
    if (ok) props.onStart();
  };
  return (
    <>
    <main className="scroll" data-testid="dx-intro">
      <div className="stack loose">
        <div className="pad stack tight">
          <div className="cap">{t("dx.intro.time", { n: resumable?.total_estimate ?? (kid ? 12 : 24) })}</div>
          <h1 className="h1">
            <NoBreakHyphens text={kid ? t("dx.intro.hKid") : t("dx.intro.h")} />
          </h1>
          <p className="sub">{kid ? t("dx.intro.textKid") : t("dx.intro.text")}</p>
        </div>
        {kid ? (
          <div className="pad">
            <Hero src={HERO.myatik} alt={t("hero.myatik")} className="dx-hero" />
          </div>
        ) : null}
        <div className="stack">
          {INTRO_AREAS.map((a, i) => (
            <Margin key={a} note={String(i + 1)} tone="b">
              <div className="card">
                <b className="h3">{t(`area.${a}` as MessageKey)}</b>
                <p className="sub">{t(`dx.intro.area.${a}` as MessageKey)}</p>
              </div>
            </Margin>
          ))}
        </div>
        <div className="pad stack">
          <div className="card warn cert" data-testid="dx-not-exam">
            <Icon name="shield" size={20} />
            <p className="sub ink">{kid ? t("dx.intro.notExamKid") : t("dx.intro.notExam")}</p>
          </div>
          <ul className="stack tight">
            <li className="notice sub"><Icon name="info" size={18} />{kid ? t("dx.intro.dontKnowKid") : t("dx.intro.dontKnow")}</li>
            <li className="notice sub"><Icon name="clock" size={18} />{t("dx.intro.pause")}</li>
            <li className="notice sub"><Icon name="volume" size={18} />{t("dx.intro.listen")}</li>
            <li className="notice sub"><Icon name="mic" size={18} />{t("dx.intro.speaking")}</li>
          </ul>
          {resumable ? (
            <p className="sub" data-testid="dx-resume-note">
              {t("dx.resumeNote", { n: resumable.answered, m: progressOf(resumable).total, time: fmt.dateTime(resumable.expires_at) })}
            </p>
          ) : null}
        </div>
      </div>
    </main>
    <div className="foot">
      <ErrorLine text={props.error} />
      {resumable ? (
        <div className="dx-actions">
          <Btn variant="secondary" busy={props.busy} onClick={() => void restart()} data-testid="dx-restart">
            {t("dx.restart")}
          </Btn>
          <Btn onClick={() => props.onResume(resumable)} data-testid="dx-resume">
            {t("dx.resume")}
          </Btn>
        </div>
      ) : (
        <Btn busy={props.busy} onClick={props.onStart} data-testid="dx-start">
          {kid ? t("dx.startKid") : t("dx.start")}
        </Btn>
      )}
    </div>
    </>
  );
}

/* ---------------------------------------------------------------- items */

type VoiceCheck = { status: "unknown" } | { status: "ok"; voice: SpeechSynthesisVoice } | { status: "none" };

const FATAL = new Set(["DIAGNOSTIC_SESSION_EXPIRED", "DIAGNOSTIC_SESSION_CLOSED", "DIAGNOSTIC_SESSION_NOT_FOUND"]);

function TestRunner(props: {
  session: DiagnosticSession;
  onFinished: (r: DiagnosticResult) => void;
  onPause: () => void;
  onRestart: () => void;
}) {
  const { bff, session: appSession } = useApp();
  const { t, fmt } = useI18n();
  const kid = appSession.learner.kind === "child";
  const id = props.session.session_id;
  const [answered, setAnswered] = useState(props.session.answered);
  const [item, setItem] = useState<DiagnosticItem | null>(null);
  const [phase, setPhase] = useState<"loading" | "item" | "finishing" | "fatal">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [listenOff, setListenOff] = useState(false);
  const [checkingVoice, setCheckingVoice] = useState(false);
  const [draft, setDraft] = useState<Answer>(null);
  const voice = useRef<VoiceCheck>({ status: "unknown" });
  const listenOffRef = useRef(false);
  const shownAt = useRef(Date.now());
  const alive = useRef(true);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fail = (e: unknown) => {
    if (!alive.current) return;
    if (e instanceof ApiError && FATAL.has(e.code)) {
      setFatal(e.code === "DIAGNOSTIC_SESSION_EXPIRED" ? t("dx.expired") : e.code === "DIAGNOSTIC_SESSION_CLOSED" ? t("dx.closed") : errorText(e, t, fmt.mmss));
      setPhase("fatal");
      return;
    }
    setError(errorText(e, t, fmt.mmss));
    setPhase((p) => (p === "loading" || p === "finishing" ? "item" : p));
  };

  const finish = async () => {
    setPhase("finishing");
    setError(null);
    try {
      const r = await bff.finishDiagnostic(id);
      if (alive.current) latest.current.onFinished(r);
    } catch (e) {
      fail(e);
    }
  };

  /** An English voice for listening; none → listening is reported unavailable once (the area becomes not_assessed). */
  const voiceAvailable = async (): Promise<boolean> => {
    if (voice.current.status === "unknown") {
      setCheckingVoice(true);
      const v = pickEnglishVoice(await loadVoices(1500));
      if (alive.current) setCheckingVoice(false);
      voice.current = v ? { status: "ok", voice: v } : { status: "none" };
    }
    if (voice.current.status === "ok") return true;
    if (!listenOffRef.current) {
      await bff.listeningUnavailable(id);
      listenOffRef.current = true;
      if (alive.current) setListenOff(true);
    }
    return false;
  };

  /** Show an item; a listening item without a voice is reported and the next item is asked for (the server skips the
   *  rest of listening; if it still sends one, it is shown with «Не знаю» only). */
  const present = async (n: DiagnosticItem | { done: true }): Promise<void> => {
    if ("done" in n) return finish();
    let it = n;
    if (it.type === "listen_choice" && !listenOffRef.current && !(await voiceAvailable())) {
      const again = await bff.diagnosticNext(id);
      if ("done" in again) return finish();
      it = again;
    }
    if (!alive.current) return;
    shownAt.current = Date.now();
    setDraft(null);
    setItem(it);
    setPhase("item");
  };

  const loadNext = async (): Promise<void> => {
    setPhase("loading");
    setError(null);
    try {
      await present(await bff.diagnosticNext(id));
    } catch (e) {
      fail(e);
    }
  };

  useEffect(() => {
    void loadNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const answer = async (a: Answer, dontKnow: boolean) => {
    if (!item || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await bff.diagnosticAnswer(id, {
        item_id: item.item_id,
        answer: dontKnow ? null : a,
        dont_know: dontKnow,
        time_ms: Math.max(0, Math.min(3_600_000, Date.now() - shownAt.current)),
      });
      if (!alive.current) return;
      setAnswered((x) => x + 1);
      haptic.selection();
      if (res.next) await present(res.next);
      else if (res.done) await finish();
      else await loadNext();
    } catch (e) {
      // the item changed meanwhile (another tab, a repeated tap): show the current one
      if (e instanceof ApiError && e.code === "ITEM_NOT_CURRENT") await loadNext();
      else fail(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const finishEarly = async () => {
    const ok = await confirmPopup({ title: t("dx.finishConfirm.title"), message: t("dx.finishConfirm.text"), ok: t("dx.finishConfirm.ok"), cancel: t("c.cancel") });
    if (ok) await finish();
  };

  const prog = progressOf({ answered, total_estimate: props.session.total_estimate }, item?.position);
  const followupArea = props.session.followup_area;

  if (phase === "fatal") {
    return (
      <main className="scroll">
        <div className="pad stack">
          <div className="card warn stack tight" data-testid="dx-fatal">
            <p className="sub ink">{fatal}</p>
          </div>
          <Btn onClick={props.onRestart} data-testid="dx-fatal-restart">{t("dx.restart")}</Btn>
        </div>
      </main>
    );
  }

  return (
    <>
    <main className="scroll" data-testid="dx-run">
      <div className="pad stack">
        <div className="dx-top">
          <div className="hrow between">
            <span className="cap" data-testid="dx-progress">
              {followupArea ? `${t("dx.followupCap", { area: t(`area.${followupArea}` as MessageKey) })} · ` : ""}
              {t("dx.progress", { n: prog.current, m: prog.total })}
            </span>
            <Btn variant="link" onClick={props.onPause} data-testid="dx-pause">
              <Icon name="clock" size={18} />
              {t("dx.pause")}
            </Btn>
          </div>
          <div className="dx-prog" role="progressbar" aria-label={t("dx.progressAria", { n: answered, m: prog.total })} aria-valuemin={0} aria-valuemax={prog.total} aria-valuenow={answered}>
            <div style={{ width: `${prog.pct}%` }} />
          </div>
        </div>

        {listenOff ? (
          <div className="card warn notice" role="status" data-testid="dx-listen-unavailable">
            <Icon name="info" size={20} />
            <p className="sub ink">{t("dx.listen.unavailable")}</p>
          </div>
        ) : null}

        {phase === "item" && item ? (
          <ItemView
            key={item.item_id}
            item={item}
            kid={kid}
            busy={busy}
            voice={voice.current.status === "ok" ? voice.current.voice : null}
            listenBlocked={item.type === "listen_choice" && listenOff}
            draft={draft}
            onDraft={setDraft}
          />
        ) : (
          <div className="stack" aria-busy="true">
            <p className="sub" role="status">{phase === "finishing" ? t("dx.finishing") : checkingVoice ? t("dx.listen.checking") : t("dx.loadingItem")}</p>
            <Skeleton lines={3} />
          </div>
        )}
        <ErrorLine text={error} />
        {error && phase !== "finishing" && !item ? <Btn variant="secondary" onClick={() => void loadNext()}>{t("c.retry")}</Btn> : null}

        <div className="stack tight mt16">
          <Btn variant="link" className="c" disabled={answered === 0 || busy || phase === "finishing"} onClick={() => void finishEarly()} data-testid="dx-finish">
            {t("dx.finishEarly")}
          </Btn>
          <p className="sub small center">{t("dx.finishEarlyNote")}</p>
        </div>
      </div>
    </main>
    {phase === "item" && item ? <ItemActions kid={kid} busy={busy} draft={draft} onAnswer={(a, dk) => void answer(a, dk)} /> : null}
    </>
  );
}
