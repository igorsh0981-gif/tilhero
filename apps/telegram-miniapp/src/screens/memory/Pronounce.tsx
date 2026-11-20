import type { PronunciationView } from "@tilhero/contracts/bff";
import { useEffect, useRef, useState } from "react";
import { canRecord, RecorderError, startRecording, type RecordedAudio, type RecorderFailure, type Recording } from "../../audio/recorder";
import { MAX_RECORD_MS, MIN_RECORD_MS } from "../../audio/wav";
import { ApiError, errorText } from "../../api/errors";
import { wordMark, type PronunciationAccess, type WordMark } from "../../domain/memory";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { haptic, type EnVariant } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine } from "../../ui/kit";
import { Sheet } from "../../ui/overlays";
import { SpeakButton } from "./parts";

/**
 * «Произнести» (APP-ADV-01, AT-58) for a card of the dictionary or a sentence of a text. Shown by
 * MemoryOverview.pronunciation: available — the button; consent_self — why it is off and the way to the settings;
 * consent_guardian — a teen is told the parent's consent is needed, a child «попроси родителя»; unavailable — nothing.
 */
export function PronounceBlock(props: {
  access: PronunciationAccess;
  target: string;
  text: string;
  voice?: EnVariant;
  testId?: string;
  onDone?: () => void;
  /** inside another sheet: the owner closes it and opens PronounceSheet itself (sheets are never stacked) */
  onRecord?: () => void;
}) {
  const { nav, session } = useApp();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const kid = session.learner.kind === "child";
  const id = props.testId ?? "pron";
  switch (props.access) {
    case "hidden":
      return null;
    case "consent_self":
      return (
        <div className="card pn-off stack tight" data-testid={`${id}-consent`} data-who="self">
          <p className="sub ink notice"><Icon name="mic" size={18} />{t("pn.needSelf")}</p>
          <Btn variant="link" onClick={() => nav.push({ name: "voiceConsent" })} data-testid={`${id}-to-settings`}>
            {t("pn.toSettings")}
          </Btn>
        </div>
      );
    case "consent_teen":
      return (
        <div className="card pn-off stack tight" data-testid={`${id}-consent`} data-who="guardian">
          <p className="sub ink notice"><Icon name="mic" size={18} />{t("pn.needGuardianTeen")}</p>
          <Btn variant="link" onClick={() => nav.push({ name: "guardian" })} data-testid={`${id}-to-guardian`}>
            {t("profile.guardian")}
          </Btn>
        </div>
      );
    case "consent_child":
      return (
        <div className="card pn-off" data-testid={`${id}-consent`} data-who="child">
          <p className="sub ink notice"><Icon name="mic" size={18} />{t("pn.askParent")}</p>
        </div>
      );
    case "record":
      return (
        <>
          <Btn variant="secondary" onClick={() => (props.onRecord ? props.onRecord() : setOpen(true))} data-testid={id}>
            <Icon name="mic" size={18} />
            {t("pn.button")}
          </Btn>
          {open ? (
            <PronounceSheet
              target={props.target}
              text={props.text}
              voice={props.voice}
              kid={kid}
              onClose={() => {
                setOpen(false);
                props.onDone?.();
              }}
            />
          ) : null}
        </>
      );
  }
}

type Phase =
  | { k: "idle" }
  | { k: "starting" }
  | { k: "recording" }
  | { k: "sending" }
  | { k: "tooShort" }
  | { k: "result"; view: PronunciationView }
  | { k: "mic"; reason: RecorderFailure }
  | { k: "server"; error: unknown };

/**
 * The recording: the microphone is asked for only on «Записать» (APP-VOICE-04), the state of the recording is always on
 * screen (a red dot, «Идёт запись», the time and the level), auto-stop at 15 s, at least 0.5 s; the WAV lives in memory
 * until it is sent and is dropped right after. A refusal or no microphone — the reason, how to allow it and the text way
 * (listen to the sample and say it aloud — no score then, APP-VOICE-03); no repeated prompts on its own.
 */
export function PronounceSheet(props: { target: string; text: string; voice?: EnVariant; kid: boolean; onClose: () => void }) {
  const { bff } = useApp();
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [lvl, setLvl] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<Recording | null>(null);
  /** recordings already sent (auto-stop and «Стоп» may both deliver one); a WeakSet keeps no audio alive */
  const sent = useRef(new WeakSet<RecordedAudio>());
  const startedAt = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // the sheet closed while recording: the microphone is released, the samples thrown away
      rec.current?.cancel();
      rec.current = null;
    };
  }, []);

  const send = async (audio: RecordedAudio) => {
    if (sent.current.has(audio) || !alive.current) return;
    sent.current.add(audio);
    rec.current = null;
    if (audio.durationMs < MIN_RECORD_MS) {
      setPhase({ k: "tooShort" });
      return;
    }
    setPhase({ k: "sending" });
    try {
      // the Blob goes only into this request; nothing is kept after it
      const view = await bff.pronounce(props.target, audio.wav);
      if (!alive.current) return;
      haptic.notify(view.status === "ok" ? "success" : "warning");
      setPhase({ k: "result", view });
    } catch (e) {
      if (alive.current) setPhase({ k: "server", error: e });
    }
  };

  /** Synchronous in the tap handler: iOS opens the AudioContext and the permission prompt only from a gesture. */
  const start = () => {
    if (!canRecord()) {
      setPhase({ k: "mic", reason: "unsupported" });
      return;
    }
    haptic.impact("medium");
    setLvl(0);
    setElapsed(0);
    setPhase({ k: "starting" });
    startRecording({ onLevel: (v) => alive.current && setLvl(v), onAutoStop: (r) => void send(r) }).then(
      (r) => {
        if (!alive.current) {
          r.cancel();
          return;
        }
        rec.current = r;
        startedAt.current = Date.now();
        setPhase({ k: "recording" });
      },
      (e: unknown) => {
        if (alive.current) setPhase({ k: "mic", reason: e instanceof RecorderError ? e.reason : "failed" });
      },
    );
  };

  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    haptic.impact("light");
    await send(await r.stop());
  };

  const recording = phase.k === "recording";
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsed(ms);
      // the recorder stops itself at 15 s of audio; this is the backstop if the audio clock stalls
      if (ms > MAX_RECORD_MS + 1000) void stop();
    }, 200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const again = () => setPhase({ k: "idle" });
  const sec = (ms: number) => `0:${String(Math.min(15, Math.floor(ms / 1000))).padStart(2, "0")}`;

  return (
    <Sheet title={t("pn.title")} onClose={props.onClose} testId="pron-sheet">
      <div className="stack">
        <div className="card pn-ref stack tight">
          <span className="cap">{t("pn.say")}</span>
          <p className="pn-text" lang="en" data-testid="pron-ref">{phase.k === "result" ? phase.view.reference_text || props.text : props.text}</p>
          <SpeakButton text={props.text} voice={props.voice} kid={props.kid} label={t("pn.sample")} testId="pron-sample" />
        </div>

        {phase.k === "idle" || phase.k === "starting" ? (
          <div className="stack tight center pn-rec">
            <button type="button" className="rec-btn" onClick={start} disabled={phase.k === "starting"} aria-label={t("pn.record")} data-testid="pron-record">
              <Icon name="mic" size={34} />
            </button>
            <p className="sub small" role="status">{phase.k === "starting" ? t("pn.allow") : t("pn.recordHint", { s: MAX_RECORD_MS / 1000 })}</p>
            <p className="sub small">{t("pn.privacy")}</p>
          </div>
        ) : null}

        {recording ? (
          <div className="stack tight center pn-rec" data-testid="pron-recording">
            <p className="rec-state" role="status" aria-live="polite">
              <span className="rec-dot" aria-hidden="true" />
              {t("pn.recording")} · <span data-testid="pron-time">{sec(elapsed)}</span> / 0:15
            </p>
            <div className="meter" role="meter" aria-label={t("pn.level")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(lvl * 100)} data-testid="pron-level">
              {Array.from({ length: 12 }, (_, i) => (
                <i key={i} className={cx(lvl * 12 > i && "on")} />
              ))}
            </div>
            <div className="prog" aria-hidden="true"><div style={{ width: `${Math.min(100, (elapsed / MAX_RECORD_MS) * 100)}%` }} /></div>
            <Btn onClick={() => void stop()} data-testid="pron-stop">
              <Icon name="stop" size={18} />
              {t("pn.stop")}
            </Btn>
          </div>
        ) : null}

        {phase.k === "sending" ? (
          <p className="sub center" role="status" data-testid="pron-sending">
            <span className="spin" aria-hidden="true" /> {t("pn.sending")}
          </p>
        ) : null}

        {phase.k === "tooShort" ? (
          <div className="stack tight" data-testid="pron-short">
            <p className="sub ink notice" role="status"><Icon name="info" size={18} />{t("pn.tooShort")}</p>
            <Btn onClick={again} data-testid="pron-again">{t("pn.again")}</Btn>
          </div>
        ) : null}

        {phase.k === "result" ? <PronResult view={phase.view} kid={props.kid} onAgain={again} /> : null}

        {phase.k === "mic" ? <MicProblem reason={phase.reason} onRetry={again} /> : null}

        {phase.k === "server" ? <ServerProblem error={phase.error} onAgain={again} kid={props.kid} /> : null}
      </div>
    </Sheet>
  );
}

const MARK_SIGN: Record<WordMark, string> = { ok: "✓", practice: "~", missed: "—", extra: "+" };

function PronResult({ view, kid, onAgain }: { view: PronunciationView; kid: boolean; onAgain: () => void }) {
  const { t, l } = useI18n();
  if (view.status !== "ok") {
    return (
      <div className="stack tight" data-testid="pron-result" data-status={view.status}>
        <div className="card warn notice" role="status">
          <Icon name="info" size={20} />
          <p className="sub ink">{view.message ? l(view.message) : t(view.status === "unavailable" ? "pn.unavailable" : "pn.notAssessed")}</p>
        </div>
        {view.status === "insufficient_evidence" ? <Btn onClick={onAgain} data-testid="pron-again">{t("pn.again")}</Btn> : null}
      </div>
    );
  }
  return (
    <div className="stack tight" data-testid="pron-result" data-status="ok">
      {view.intelligibility ? (
        <p className={cx("h3 pn-head", view.intelligibility)} role="status" data-testid="pron-intel">
          <Icon name={view.intelligibility === "needs_practice" ? "info" : "check"} size={20} />
          {t(`pn.intel.${view.intelligibility}${kid ? ".kid" : ""}` as MessageKey)}
        </p>
      ) : null}
      {view.score !== null ? <p className="sub small" data-testid="pron-score">{t("pn.score", { n: Math.round(view.score) })}</p> : null}
      <ul className="pn-words" lang="en" data-testid="pron-words">
        {view.words.map((w, i) => {
          const mark = wordMark(w);
          return (
            <li key={i} className={cx("pn-w", mark)} data-mark={mark} aria-label={`${w.word} — ${t(`pn.mark.${mark}` as MessageKey)}`}>
              <span aria-hidden="true">{w.word}</span>
              <small aria-hidden="true">{MARK_SIGN[mark]}</small>
            </li>
          );
        })}
      </ul>
      <p className="sub small pn-legend" aria-hidden="true">{t("pn.legend")}</p>
      {view.tips.length ? (
        <section className="card pen stack tight" aria-labelledby="pn-tips" data-testid="pron-tips">
          <h3 className="sec" id="pn-tips">{t("pn.tips")}</h3>
          {view.tips.slice(0, 2).map((tip, i) => (
            <p key={i} className="sub ink">
              <b lang="en">{tip.word}</b> — {tip.text}
            </p>
          ))}
        </section>
      ) : null}
      <Btn onClick={onAgain} data-testid="pron-again">
        <Icon name="mic" size={18} />
        {t("pn.again")}
      </Btn>
    </div>
  );
}

/** No microphone or no permission: the reason, how to allow it, and the text way. Retrying is only by a tap. */
function MicProblem({ reason, onRetry }: { reason: RecorderFailure; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="stack tight" data-testid="pron-mic" data-reason={reason}>
      <div className="card warn notice" role="alert">
        <Icon name="mic" size={20} />
        <div className="stack tight">
          <p className="sub ink">{t(`pn.mic.${reason}` as MessageKey)}</p>
          {reason === "denied" ? <p className="sub small">{t("pn.mic.howTo")}</p> : null}
        </div>
      </div>
      <p className="sub" data-testid="pron-text-way">{t("pn.textWay")}</p>
      {reason !== "unsupported" ? (
        <Btn variant="secondary" onClick={onRetry} data-testid="pron-retry">
          {t("pn.mic.retry")}
        </Btn>
      ) : null}
    </div>
  );
}

function ServerProblem({ error, onAgain, kid }: { error: unknown; onAgain: () => void; kid: boolean }) {
  const { t, fmt } = useI18n();
  let text: string;
  let retry = true;
  if (error instanceof ApiError && error.code === "VOICE_CONSENT_REQUIRED") {
    text = error.details.who === "guardian" ? (kid ? t("pn.askParent") : t("pn.needGuardianTeen")) : t("pn.needSelf");
    retry = false;
  } else if (error instanceof ApiError && error.code === "SPEECH_UNAVAILABLE") {
    text = t("pn.unavailable");
    retry = false;
  } else if (error instanceof ApiError && error.code === "AUDIO_INVALID") {
    const r = error.details.reason;
    text = t(r === "too_short" ? "pn.tooShort" : r === "too_long" || r === "too_large" ? "pn.tooLong" : "pn.badAudio");
  } else {
    text = errorText(error, t, fmt.mmss);
  }
  return (
    <div className="stack tight" data-testid="pron-error">
      <ErrorLine text={text} />
      {retry ? <Btn variant="secondary" onClick={onAgain} data-testid="pron-again">{t("pn.again")}</Btn> : <p className="sub">{t("pn.textWay")}</p>}
    </div>
  );
}
