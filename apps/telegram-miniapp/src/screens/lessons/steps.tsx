import type { LessonStep } from "@tilhero/contracts/bff";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { splitGap } from "../../domain/diagnostics";
import {
  itemAnswer,
  itemKind,
  type Draft,
  type ExplanationStep,
  type ItemStep,
  type ListenStep,
  type OpenAnswerStep,
  type RoleplayEndStep,
} from "../../domain/lessons";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { haptic, loadVoices, pickEnglishVoice, speakLines, stopSpeaking, type EnVariant } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, Chip, cx, HERO, Hero, Opt, Pill } from "../../ui/kit";
import { OrderWords } from "../diagnostics/ItemView";
import type { PlayerApi } from "./usePlayer";

export interface StepProps<S extends LessonStep> {
  api: PlayerApi;
  step: S;
  kid: boolean;
  /** plaques above the step (simplified mode, notes) */
  top: ReactNode;
  /** the error line of the last action, with «Отправить ещё раз» for a lost answer */
  error: ReactNode;
}

/** A step: the scrolling body and the pinned actions under it (always reachable on a small phone). */
export function StepFrame(props: { top: ReactNode; error: ReactNode; foot: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <>
      <main className="scroll lp-main" data-testid={props.testId}>
        <div className="pad stack">
          {props.top}
          {props.children}
        </div>
      </main>
      {props.foot || props.error ? (
        <div className="foot lp-foot">
          {props.error}
          {props.foot}
        </div>
      ) : null}
    </>
  );
}

const busy = (api: PlayerApi) => api.st.phase === "sending" || api.st.phase === "finishing" || api.st.phase === "loading";

/* ---------------------------------------------------------------- notice */
export function NoticeView({ api, step, top, error }: StepProps<Extract<LessonStep, { type: "notice" }>>) {
  const { t, l } = useI18n();
  return (
    <StepFrame top={top} error={error} testId="pl-notice" foot={<Btn busy={busy(api)} onClick={() => void api.answer({})} data-testid="pl-next">{t("pl.next")}</Btn>}>
      <div className="card pen notice">
        <Icon name="info" size={20} />
        <p className="sub ink">{l(step.text)}</p>
      </div>
    </StepFrame>
  );
}

/* ---------------------------------------------------------------- explanation */
export function ExplanationView({ api, step, top, error }: StepProps<ExplanationStep>) {
  const { t, l } = useI18n();
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [word, setWord] = useState<number | null>(null);
  const [asking, setAsking] = useState(false);
  const toggle = (i: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const simpler = async () => {
    setAsking(true);
    try {
      await api.simpler();
      haptic.selection();
    } finally {
      setAsking(false);
    }
  };
  const kw = word !== null ? step.key_words[word] : null;
  return (
    <StepFrame
      top={top}
      error={error}
      testId="pl-explanation"
      foot={
        <div className={step.can_simplify ? "duo" : undefined}>
          {step.can_simplify ? (
            <Btn variant="secondary" busy={asking} disabled={busy(api)} onClick={() => void simpler()} data-testid="pl-simpler">
              {api.st.simpler.length ? t("pl.ex.simplerAgain") : t("pl.ex.simpler")}
            </Btn>
          ) : null}
          <Btn busy={api.st.phase === "sending"} disabled={asking} onClick={() => void api.answer({})} data-testid="pl-next">
            {t("pl.ex.got")}
          </Btn>
        </div>
      }
    >
      <p className="lp-rule" data-testid="pl-rule">{l(step.instructions)}</p>
      {step.examples.length ? (
        <section className="stack tight" aria-labelledby="pl-ex-h">
          <h2 className="sec" id="pl-ex-h">{t("pl.ex.examples")}</h2>
          <p className="sub small">{t("pl.ex.tapHint")}</p>
          <div className="card" data-testid="pl-examples">
            {step.examples.map((e, i) => (
              <button type="button" key={i} className="ex-row" onClick={() => toggle(i)} aria-expanded={open.has(i)} data-testid={`pl-ex-${i}`}>
                <span className="en" lang="en">{e.en}</span>
                {open.has(i) ? <span className="gloss" data-testid={`pl-ex-gloss-${i}`}>{l(e.gloss)}</span> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {step.key_words.length ? (
        <section className="stack tight" aria-labelledby="pl-kw-h">
          <h2 className="sec" id="pl-kw-h">{t("pl.ex.words")}</h2>
          <div className="chips" lang="en">
            {step.key_words.map((k, i) => (
              <Chip key={i} on={word === i} label={k.en} onClick={() => setWord(word === i ? null : i)} />
            ))}
          </div>
          {kw ? (
            <div className="card kw-gloss" data-testid="pl-kw">
              <b lang="en">{kw.en}</b>
              <span className="sub ink">{l(kw.gloss)}</span>
              <span className="sub" lang="en">{kw.example_en}</span>
            </div>
          ) : null}
        </section>
      ) : null}
      {api.st.simpler.map((s, i) => (
        <div className="card pen simpler" key={i} data-testid="pl-simpler-card">
          <span className="cap">
            {t("pl.ex.simplerTitle")} · {t(`pl.ex.source.${s.source}` as MessageKey)}
          </span>
          {s.explanation ? <p className="sub ink">{l(s.explanation)}</p> : null}
          <b lang="en">{s.example_en}</b>
          <span className="sub">{l(s.example_gloss)}</span>
        </div>
      ))}
    </StepFrame>
  );
}

/* ---------------------------------------------------------------- item */
export function ItemView({ api, step, top, error }: StepProps<ItemStep>) {
  const { t, l } = useI18n();
  const [draft, setDraft] = useState<Draft>(null);
  const [asking, setAsking] = useState(false);
  const it = step.item;
  const kind = itemKind(it.item_type, it.options);
  const checked = api.st.checked?.stepId === step.step_id ? api.st.checked : null;
  const body = itemAnswer(draft);
  const locked = !!checked || busy(api);
  const gap = splitGap(it.prompt_en);
  const qId = `pl-q-${step.step_id}`;
  const hint = async () => {
    setAsking(true);
    try {
      await api.hint();
    } finally {
      setAsking(false);
    }
  };
  useEffect(() => {
    if (checked) haptic.notify(checked.feedback.correct ? "success" : "warning");
  }, [checked]);

  const foot = checked ? (
    <Btn onClick={api.advance} data-testid="pl-next">{t("pl.next")}</Btn>
  ) : (
    <div className="dx-actions">
      <Btn variant="secondary" disabled={busy(api)} onClick={() => void api.answer({ dont_know: true })} data-testid="pl-dont-know">
        {t("pl.item.dontKnow")}
      </Btn>
      <Btn busy={api.st.phase === "sending"} disabled={!body} onClick={() => body && void api.answer(body)} data-testid="pl-answer">
        {t("pl.item.answer")}
      </Btn>
    </div>
  );

  return (
    <StepFrame top={top} error={error} foot={foot} testId={`pl-item-${it.item_type}`}>
      {step.graded_later ? (
        <div className="card notice" data-testid="pl-graded">
          <Icon name="shield" size={20} />
          <p className="sub ink">{t("pl.item.graded")}</p>
        </div>
      ) : null}
      <p className="lp-instr">{l(it.instruction)}</p>
      <h2 className="lp-q" id={qId} lang="en" data-testid="pl-prompt">
        {gap ? (
          <>
            {gap[0]}
            <span className="gap" role="img" aria-label={t("dx.gap")}>…</span>
            {gap[1]}
          </>
        ) : (
          it.prompt_en
        )}
      </h2>
      {kind === "choice" || kind === "gapChoice" ? (
        <div className="opts" role="group" aria-labelledby={qId}>
          {it.options.map((o, i) => {
            const value = kind === "choice" ? i : o;
            return <Opt key={i} on={draft === value} title={o} onClick={() => setDraft(value)} disabled={locked} testId={`pl-opt-${i}`} />;
          })}
        </div>
      ) : kind === "gap" ? (
        <div>
          <label className="lb" htmlFor={`${qId}-in`}>{t("pl.item.gapLabel")}</label>
          <input
            id={`${qId}-in`}
            className="inp"
            lang="en"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={60}
            placeholder={t("pl.item.gapPlaceholder")}
            value={typeof draft === "string" ? draft : ""}
            onChange={(e) => setDraft(e.target.value)}
            disabled={locked}
            data-testid="pl-gap-input"
          />
        </div>
      ) : (
        <OrderWords options={it.options} lines={kind === "lines"} hint={kind === "lines" ? t("pl.item.linesHint") : undefined} onChange={(a) => setDraft(a)} />
      )}
      {!step.graded_later && step.hint_available && !checked ? (
        api.st.hint ? (
          <div className="card warn stack tight" data-testid="pl-hint">
            <p className="sub ink">{l(api.st.hint)}</p>
            <p className="sub small">{t("pl.item.hintNote")}</p>
          </div>
        ) : (
          <Btn variant="link" busy={asking} disabled={busy(api)} onClick={() => void hint()} data-testid="pl-hint-btn">
            <Icon name="spark" size={18} />
            {t("pl.item.hint")}
          </Btn>
        )
      ) : null}
      {checked ? (
        <div className={cx("card lp-feedback", checked.feedback.correct ? "ok" : "warn no")} role="status" data-testid="pl-feedback">
          <Icon name={checked.feedback.correct ? "check" : "info"} size={20} />
          <div className="stack tight">
            <b>{checked.feedback.correct ? t("pl.item.correct") : t("pl.item.wrong")}</b>
            {!checked.feedback.correct && checked.feedback.correct_answer ? (
              <span className="sub ink" data-testid="pl-right-answer">{t("pl.item.rightIs", { a: checked.feedback.correct_answer })}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </StepFrame>
  );
}

/* ---------------------------------------------------------------- listen (media) */
export function ListenView({ api, step, top, error }: StepProps<ListenStep>) {
  const { t, l } = useI18n();
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const toggle = (i: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  return (
    <StepFrame top={top} error={error} testId="pl-listen" foot={<Btn busy={busy(api)} onClick={() => void api.answer({})} data-testid="pl-next">{t("pl.next")}</Btn>}>
      <h2 className="h2">{l(step.title)}</h2>
      {step.can_listen ? <ListenPlayer step={step} /> : <p className="sub" data-testid="pl-no-listen">{t("pl.ls.cannot")}</p>}
      <section className="stack tight" aria-labelledby="pl-tr">
        <h3 className="sec" id="pl-tr">{t("pl.ls.transcript")}</h3>
        {step.transcript ? (
          <>
            {step.transcript.some((x) => x.gloss) ? <p className="sub small">{t("pl.ls.tapHint")}</p> : null}
            <div className="card" data-testid="pl-transcript">
              {step.transcript.map((line, i) => (
                <button type="button" className="tr" key={i} onClick={() => line.gloss && toggle(i)} aria-expanded={line.gloss ? open.has(i) : undefined} data-testid={`pl-line-${i}`}>
                  <span className="sp" lang="en">{line.speaker}</span>
                  <span className="line-en" lang="en">{line.text_en}</span>
                  {open.has(i) && line.gloss ? <span className="gloss">{l(line.gloss)}</span> : null}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="sub">{t("pl.ls.noTranscript")}</p>
        )}
      </section>
    </StepFrame>
  );
}

function ListenPlayer({ step }: { step: ListenStep }) {
  const { bff } = useApp();
  const { t } = useI18n();
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const signal = useRef({ stopped: false });
  const tts = !step.has_audio && !!step.transcript?.length;
  useEffect(
    () => () => {
      signal.current.stopped = true;
      audio.current?.pause();
      stopSpeaking();
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );
  if (!step.has_audio && !tts) return null;
  const stop = () => {
    signal.current.stopped = true;
    audio.current?.pause();
    stopSpeaking();
    setPlaying(false);
  };
  const play = async () => {
    setFailed(null);
    setLoading(true);
    try {
      if (step.has_audio) {
        if (!url.current) url.current = URL.createObjectURL(await bff.mediaAudio(step.asset_id));
        const a = audio.current ?? new Audio(url.current);
        audio.current = a;
        a.onended = () => setPlaying(false);
        a.currentTime = 0;
        await a.play();
        setPlaying(true);
      } else if (step.transcript) {
        const voices = await loadVoices(1500);
        if (!pickEnglishVoice(voices)) {
          setFailed(t("pl.rp.noVoice"));
          return;
        }
        signal.current = { stopped: false };
        setPlaying(true);
        const lines = step.transcript.map((x) => ({ text: x.text_en, variant: (step.voices[x.speaker] ?? "en-GB") as EnVariant }));
        void speakLines(lines, voices, signal.current).finally(() => setPlaying(false));
      }
    } catch {
      setFailed(t("pl.ls.error"));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="card stack tight" data-testid="pl-player">
      <Btn variant={playing ? "secondary" : "primary"} busy={loading} onClick={() => (playing ? stop() : void play())} data-testid="pl-play">
        <Icon name={playing ? "stop" : "play"} size={18} />
        {playing ? t("pl.ls.stop") : t("pl.ls.play")}
      </Btn>
      {tts ? (
        <p className="sub small tts">
          <Pill tone="warn">{t("pl.ls.tts")}</Pill>
        </p>
      ) : null}
      {failed ? <p className="sub small" role="status">{failed}</p> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- open answer */
export function OpenAnswerView({ api, step, kid, top, error }: StepProps<OpenAnswerStep>) {
  const { t, l } = useI18n();
  const [text, setText] = useState("");
  const value = text.trim();
  if (kid) {
    // children never send free text (owner's decision): the step is skipped
    return (
      <StepFrame top={top} error={error} testId="pl-open-kid" foot={<Btn busy={busy(api)} onClick={() => void api.answer({ dont_know: true })} data-testid="pl-next">{t("pl.next")}</Btn>}>
        <div className="card pen notice">
          <Icon name="info" size={20} />
          <p className="sub ink">{t("pl.oa.kidSkip")}</p>
        </div>
      </StepFrame>
    );
  }
  return (
    <StepFrame
      top={top}
      error={error}
      testId="pl-open"
      foot={
        <Btn busy={api.st.phase === "sending"} disabled={!value} onClick={() => void api.answer({ text: value })} data-testid="pl-open-send">
          {t("pl.oa.send")}
        </Btn>
      }
    >
      <h2 className="lp-q">{l(step.prompt)}</h2>
      <div>
        <label className="lb" htmlFor="pl-open-in">{t("pl.oa.label")}</label>
        <textarea
          id="pl-open-in"
          className="inp"
          lang="en"
          rows={4}
          maxLength={step.max_length}
          placeholder={t("pl.oa.placeholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy(api)}
          data-testid="pl-open-input"
        />
        <p className="rp-count" aria-live="polite">{t("pl.rp.count", { n: text.length, m: step.max_length })}</p>
      </div>
      <p className="sub small">{t("pl.oa.note")}</p>
    </StepFrame>
  );
}

/* ---------------------------------------------------------------- end of the roleplay */
export function RoleplayEndView({ api, step, top, error, chat }: StepProps<RoleplayEndStep> & { chat: ReactNode }) {
  const { t, l } = useI18n();
  const [retrying, setRetrying] = useState(false);
  const ok = step.outcome !== "fail";
  const retry = async () => {
    setRetrying(true);
    try {
      await api.retryRoleplay();
    } finally {
      setRetrying(false);
    }
  };
  useEffect(() => {
    haptic.notify(ok ? "success" : "warning");
  }, [ok]);
  return (
    <StepFrame
      top={top}
      error={error}
      testId="pl-roleplay-end"
      foot={
        <div className="stack tight">
          {step.can_retry ? (
            <Btn variant="secondary" busy={retrying} disabled={busy(api)} onClick={() => void retry()} data-testid="pl-rp-retry">
              <Icon name="route" size={18} />
              {t("pl.end.retry")}
            </Btn>
          ) : null}
          <Btn busy={api.st.phase === "sending"} disabled={retrying} onClick={() => void api.answer({})} data-testid="pl-next">
            {t("pl.next")}
          </Btn>
        </div>
      }
    >
      {chat}
      <div className={cx("card outcome", ok ? "ok" : "warn")} role="status" data-testid="pl-outcome" data-outcome={step.outcome}>
        <span className={cx("mk", ok ? "ok" : "no")} aria-hidden="true">{step.outcome === "success" ? "✓" : step.outcome === "alt_success" ? "☆" : "↺"}</span>
        <div className="stack tight">
          <b className="h3">{t(`pl.end.${step.outcome}` as MessageKey)}</b>
          <p className="sub ink">{l(step.summary)}</p>
          {step.can_retry ? <p className="sub small">{t("pl.end.retryNote")}</p> : null}
        </div>
      </div>
    </StepFrame>
  );
}

/* ---------------------------------------------------------------- done */
export function DoneView({ api, kid, top, error, onFinish }: StepProps<Extract<LessonStep, { type: "done" }>> & { onFinish: () => void }) {
  const { t } = useI18n();
  const finishing = api.st.phase === "finishing";
  return (
    <StepFrame
      top={top}
      error={error}
      testId="pl-done"
      foot={
        <Btn busy={finishing} onClick={onFinish} data-testid="pl-finish">
          {t("pl.done.finish")}
        </Btn>
      }
    >
      <div className="stack lp-done center">
        <Hero src={kid ? HERO.myatik : HERO.voltUp} alt="" />
        <h2 className="h1">{t("pl.done.title")}</h2>
        <p className="sub">{finishing ? t("pl.finishing") : t("pl.done.text")}</p>
      </div>
    </StepFrame>
  );
}
