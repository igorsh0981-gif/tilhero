import type { ReviewAnswer, ReviewTask, ReviewTaskResult } from "@tilhero/contracts/bff";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { errorText } from "../../api/errors";
import {
  canAnswer,
  isLetterTiles,
  reviewCardState,
  reviewMinutes,
  reviewProgress,
  splitBlank,
  tilesAnswer,
  tilesFree,
  tilesPick,
  tilesStart,
  tilesText,
  tilesUndo,
  tilesUnpick,
  typedAnswer,
  TYPED_MAX,
  type Tiles,
} from "../../domain/memory";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { haptic, useBackButton } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, HERO, Hero, Opt, Pill, Skeleton } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { StepFrame } from "../lessons/steps";
import { SpeakButton } from "./parts";
import { useReview, type ReviewApi } from "./useReview";

/**
 * «Повторение дня» (APP-MEM-03/04, AT-54/56): a start panel (from a notification) or the session at once (from the card),
 * then the tasks one by one — introduction of a new card, recognition (choice of the meaning, of what sounded), recall
 * (typing, a gap, assembling letters or words, fixing an error), the retention check («Проверка: <навык>», no hints, the
 * result of the block at its end). Feedback: right / almost (a typo) / not yet + the right answer, when the card comes
 * back; a card answered wrong comes back at the end of the session. Pause — leave and continue later from the same task.
 * No key is ever on the client. Children: bigger, softer words, no «ошибок» and no comparisons.
 */
export function ReviewPlayer({ autostart }: { autostart?: boolean }) {
  const [playing, setPlaying] = useState(!!autostart);
  return playing ? <ReviewSession /> : <StartPanel onStart={() => setPlaying(true)} />;
}

/** From the notification «Пора повторить слова»: what is due today and «Начать» / «Продолжить». */
function StartPanel({ onStart }: { onStart: () => void }) {
  const { bff, nav, session } = useApp();
  const { t, tp, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const ov = useLoad(() => bff.memoryOverview(), [session.learner.learner_id]);
  const o = ov.data;
  const st = o ? reviewCardState(o) : null;
  return (
    <>
      <Bar title={t("rv.title")} onBack={nav.back} />
      <main className="scroll" data-testid="rv-start">
        <div className="pad stack loose rv-start">
          {ov.loading && !o ? <Skeleton lines={3} /> : null}
          {ov.error && !o ? (
            <div className="stack tight">
              <div className="card err"><p className="sub ink">{ov.error}</p></div>
              <Btn variant="secondary" onClick={() => void ov.reload()}>{t("c.retry")}</Btn>
            </div>
          ) : null}
          {st ? (
            <>
              <Hero src={kid ? HERO.myatik : HERO.iskra} alt="" className="rv-hero" />
              {st.kind === "start" || st.kind === "continue" ? (
                <>
                  <h2 className="h1">{st.kind === "continue" ? t("mem.card.continueLine") : kid ? t("mem.card.lineKid") : t("mem.card.line")}</h2>
                  <ul className="list" data-testid="rv-start-counts">
                    {st.due ? <li className="row"><span className="t"><b>{t("mem.card.due", { n: st.due, w: tp("mem.wordsWord", st.due) })}</b></span></li> : null}
                    {st.fresh ? <li className="row"><span className="t"><b>{t("mem.card.new", { n: st.fresh })}</b></span></li> : null}
                    {st.checks ? (
                      <li className="row">
                        <span className="t"><b>{t("mem.card.checks", { n: st.checks })}</b><span>{t("rv.start.checksNote")}</span></span>
                      </li>
                    ) : null}
                  </ul>
                  <p className="sub">{t("rv.start.minutes", { n: reviewMinutes(st.due + st.fresh + st.checks * 3) })}</p>
                </>
              ) : (
                <>
                  <h2 className="h1" data-testid="rv-start-nothing">{st.kind === "done" ? (kid ? t("mem.card.doneKid") : t("mem.card.done")) : t("rv.nothing")}</h2>
                  {st.nextDueAt ? <p className="sub">{t("mem.card.nextAt", { date: fmt.date(st.nextDueAt) })}</p> : null}
                </>
              )}
            </>
          ) : null}
        </div>
      </main>
      {st ? (
        <div className="foot">
          {st.kind === "start" || st.kind === "continue" ? (
            <Btn onClick={onStart} data-testid="rv-start-go">
              <Icon name={st.kind === "continue" ? "play" : "review"} size={18} />
              {st.kind === "continue" ? t("mem.card.continue") : t("mem.card.start")}
            </Btn>
          ) : (
            <Btn variant="secondary" onClick={() => nav.back()} data-testid="rv-start-back">{t("rv.toDictionary")}</Btn>
          )}
        </div>
      ) : null}
    </>
  );
}

function ReviewSession() {
  const { bff, nav, session } = useApp();
  const { t, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const api = useReview(bff);
  const { st } = api;
  const [menu, setMenu] = useState(false);
  // once per opening (StrictMode runs mount effects twice in dev; the Idempotency-Key would make it harmless anyway)
  const begun = useRef(false);
  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    void api.begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useBackButton(() => setMenu(true));

  // a check block answer: «Ответ принят», no correctness until the end of the block
  const accepted = useRef(st.accepted);
  useEffect(() => {
    if (st.accepted > accepted.current && st.phase !== "checkDone") {
      showToast(t("rv.check.accepted"));
      haptic.impact("light");
    }
    accepted.current = st.accepted;
  }, [st.accepted, st.phase, t]);

  // all answered: the summary
  const finishing = useRef(false);
  useEffect(() => {
    if (st.phase !== "done" || st.error || finishing.current) return;
    finishing.current = true;
    void api.finish().then((summary) => {
      finishing.current = false;
      if (!summary || !st.session) return;
      haptic.notify("success");
      nav.replace({ name: "reviewSummary", sessionId: st.session.session_id, summary, fresh: true });
    });
  }, [st.phase, st.error, st.session, api, nav]);

  const exit = () => {
    setMenu(false);
    nav.back();
    if (st.session && st.phase !== "closed") showToast(t("rv.exited"));
  };

  const task = st.task;
  const progress = reviewProgress(task, st.session);
  const error = st.error ? <ReviewErrorLine api={api} /> : null;

  let body: ReactNode;
  if (api.nothing) {
    body = (
      <StepFrame top={null} error={null} testId="rv-nothing" foot={<Btn variant="secondary" onClick={nav.back} data-testid="rv-back">{t("rv.toDictionary")}</Btn>}>
        <div className="stack center rv-end">
          <Hero src={kid ? HERO.myatik : HERO.iskra} alt="" className="rv-hero" />
          <h2 className="h1">{t("rv.nothing")}</h2>
          {api.nothing.nextDueAt ? <p className="sub">{t("mem.card.nextAt", { date: fmt.date(api.nothing.nextDueAt) })}</p> : null}
        </div>
      </StepFrame>
    );
  } else if (st.phase === "closed") {
    body = (
      <StepFrame top={null} error={null} testId="rv-closed" foot={<Btn onClick={nav.back} data-testid="rv-back">{t("rv.toDictionary")}</Btn>}>
        <div className="card warn"><p className="sub ink">{t("rv.closed")}</p></div>
      </StepFrame>
    );
  } else if (st.phase === "done" || st.phase === "finishing") {
    body = (
      <StepFrame top={null} error={error} testId="rv-finishing" foot={st.error ? <Btn onClick={() => void api.finish()} data-testid="rv-finish-retry">{t("c.retry")}</Btn> : null}>
        <div className="stack center rv-end">
          <Hero src={kid ? HERO.myatik : HERO.voltUp} alt="" className="rv-hero" />
          <p className="sub" role="status">{t("rv.finishing")}</p>
        </div>
      </StepFrame>
    );
  } else if (!task) {
    body = (
      <main className="scroll lp-main" aria-busy={st.phase === "loading"}>
        <div className="pad stack">
          {st.error ? (
            <>
              <ErrorLine text={errorText(st.error.error, t, fmt.mmss)} />
              <Btn variant="secondary" onClick={() => void api.reload()} data-testid="rv-reload">{t("c.retry")}</Btn>
            </>
          ) : (
            <>
              <p className="sub" role="status">{t("rv.loading")}</p>
              <Skeleton lines={3} />
            </>
          )}
        </div>
      </main>
    );
  } else if (st.phase === "checkDone" && st.result?.check_result) {
    body = <CheckDone result={st.result} task={task} kid={kid} onNext={api.advance} />;
  } else {
    body = <TaskView key={task.task_id} api={api} task={task} kid={kid} error={error} />;
  }

  return (
    <>
      <header className="bar lp-bar" data-testid="rv-header">
        <button type="button" className="ib" aria-label={t("rv.menu")} onClick={() => setMenu(true)} data-testid="rv-menu">
          <Icon name="close" size={24} stroke={2} />
        </button>
        <div className="lp-head">
          <h1 className="h3">{t("rv.title")}</h1>
          {progress.total ? (
            <p className="sub" data-testid="rv-progress-text">{t("rv.taskOf", { n: Math.min(progress.done + 1, progress.total), m: progress.total })}</p>
          ) : null}
        </div>
      </header>
      {progress.total ? (
        <div className="lp-strip">
          <div
            className="prog grow"
            role="progressbar"
            aria-label={t("rv.progressAria", { n: progress.done, m: progress.total })}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            data-testid="rv-progress"
          >
            <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        </div>
      ) : null}
      {body}
      {menu ? (
        <Sheet title={t("rv.menuTitle")} onClose={() => setMenu(false)} testId="rv-menu-sheet">
          <p className="sub">{t("rv.menuText")}</p>
          <div className="stack tight">
            <Btn variant="secondary" onClick={exit} data-testid="rv-exit">
              <Icon name="clock" size={18} />
              {t("rv.exit")}
            </Btn>
            <Btn onClick={() => setMenu(false)} data-testid="rv-stay">{t("pl.stay")}</Btn>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}

/** A lost answer → «Отправить ещё раз» (the same answer); another error — its text. */
function ReviewErrorLine({ api }: { api: ReviewApi }) {
  const { t, fmt } = useI18n();
  const e = api.st.error;
  if (!e) return null;
  if (e.kind === "send") {
    const status = (e.error as { status?: number }).status ?? 0;
    return (
      <div className="stack tight" data-testid="rv-send-failed">
        <ErrorLine text={status === 0 ? t("pl.sendFailed") : errorText(e.error, t, fmt.mmss)} />
        <Btn variant="secondary" busy={api.st.phase === "sending"} onClick={() => void api.resend()} data-testid="rv-resend">{t("pl.resend")}</Btn>
      </div>
    );
  }
  return <ErrorLine text={errorText(e.error, t, fmt.mmss)} />;
}

/* ================================================================ tasks */

function TaskView({ api, task, kid, error }: { api: ReviewApi; task: ReviewTask; kid: boolean; error: ReactNode }) {
  const { t, l } = useI18n();
  const [choice, setChoice] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [tiles, setTiles] = useState<Tiles>(tilesStart);
  const [asking, setAsking] = useState<null | "first_letter" | "reveal">(null);
  const st = api.st;
  const feedback = st.phase === "feedback" && st.result?.result ? st.result : null;
  const sending = st.phase === "sending";
  // a lost answer is held: the inputs stay as sent, only «Отправить ещё раз» (the error line) sends it again
  const held = !!st.pending;
  const locked = !!feedback || sending || held;
  const check = task.check;
  const tileSet = task.tiles.length ? task.tiles : task.answer_kind === "order" ? task.options : [];

  // a lost answer keeps the draft; a new task starts clean (key={task_id} remounts this view)
  const body: ReviewAnswer | null =
    task.answer_kind === "choice" ? (choice === null ? null : { choice }) : task.answer_kind === "text" ? typedAnswer(text) : task.answer_kind === "order" ? tilesAnswer(tiles, tileSet.length) : null;
  const send = () => {
    if (!body || locked || !canAnswer(st)) return;
    haptic.selection();
    void api.answer(body);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send();
  };
  const hint = async (kind: "first_letter" | "reveal") => {
    setAsking(kind);
    try {
      await api.hint(kind);
    } finally {
      setAsking(null);
    }
  };
  useEffect(() => {
    if (feedback) haptic.notify(feedback.result === "correct" ? "success" : "warning");
  }, [feedback]);

  const canFirst = !check && task.hints.includes("first_letter") && !st.firstLetter && !task.hints_used.includes("first_letter");
  const canReveal = !check && task.hints.includes("reveal") && !st.revealed && !task.hints_used.includes("reveal");

  let foot: ReactNode;
  if (feedback) {
    foot = <Btn onClick={api.advance} data-testid="rv-next" autoFocus>{t("rv.next")}</Btn>;
  } else if (task.answer_kind === "none") {
    foot = (
      <div className="duo">
        <Btn variant="secondary" busy={sending && st.pending?.body.known === true} disabled={locked} onClick={() => void api.answer({ known: true })} data-testid="rv-known">
          {t("rv.intro.known")}
        </Btn>
        <Btn busy={sending && !st.pending?.body.known} disabled={locked} onClick={() => void api.answer({})} data-testid="rv-got">
          {t("rv.intro.got")}
        </Btn>
      </div>
    );
  } else {
    foot = (
      <div className={canReveal ? "dx-actions" : undefined}>
        {canReveal ? (
          <Btn variant="secondary" busy={asking === "reveal"} disabled={locked || !!asking} onClick={() => void hint("reveal")} data-testid="rv-reveal">
            {t("rv.hint.reveal")}
          </Btn>
        ) : null}
        <Btn busy={sending} disabled={!body || !!asking || held} onClick={send} data-testid="rv-answer">
          {check ? t("rv.check.answer") : t("rv.answer")}
        </Btn>
      </div>
    );
  }

  const top = check ? (
    <div className="card notice rv-check" role="note" data-testid="rv-check">
      <Icon name="shield" size={20} />
      <div className="stack tight">
        <b>{t("rv.check.title", { skill: l(check.skill_title) })}</b>
        <span className="sub small">{t("rv.check.of", { n: check.position, m: check.of })} · {t(kid ? "rv.check.noteKid" : "rv.check.note")}</span>
      </div>
    </div>
  ) : null;

  return (
    <StepFrame top={top} error={error} foot={foot} testId={`rv-task-${task.type}`}>
      <form className="stack rv-task" onSubmit={onSubmit} noValidate>
        <Prompt task={task} kid={kid} />

        {task.answer_kind === "choice" ? (
          <div className="opts" role="group" aria-label={t("rv.options")} lang={task.type === "meaning_choice" ? undefined : "en"}>
            {task.options.map((o, i) => (
              <Opt key={i} on={choice === i} title={o} onClick={() => setChoice(i)} disabled={locked} testId={`rv-opt-${i}`} />
            ))}
          </div>
        ) : null}

        {task.answer_kind === "text" ? (
          <div>
            <label className="lb" htmlFor="rv-in">{task.type === "error_fix" ? t("rv.typed.fixLabel") : t("rv.typed.label")}</label>
            <input
              id="rv-in"
              className="inp rv-in"
              lang="en"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="send"
              maxLength={TYPED_MAX}
              placeholder={t("rv.typed.placeholder")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={locked}
              aria-describedby={st.firstLetter || st.revealed ? "rv-hint" : undefined}
              data-testid="rv-input"
            />
          </div>
        ) : null}

        {task.answer_kind === "order" ? <TileBoard tiles={tileSet} state={tiles} onChange={setTiles} locked={locked} /> : null}

        {/* hidden submit: Enter on the phone keyboard sends the typed answer */}
        <button type="submit" className="sr" tabIndex={-1} aria-hidden="true" disabled={!body || locked} />
      </form>

      {st.firstLetter || st.revealed ? (
        <div className="card warn stack tight" id="rv-hint" data-testid="rv-hint" role="status">
          {st.firstLetter ? <p className="sub ink">{t("rv.hint.firstIs", { s: st.firstLetter })}</p> : null}
          {st.revealed ? (
            <>
              <p className="sub ink">{t("rv.hint.answerIs")} <b lang="en" data-testid="rv-revealed">{st.revealed}</b></p>
              <p className="sub small">{task.answer_kind === "text" ? t("rv.hint.typeIt") : t("rv.hint.pickIt")}</p>
            </>
          ) : null}
        </div>
      ) : null}

      {canFirst && !feedback ? (
        <Btn variant="link" busy={asking === "first_letter"} disabled={locked || !!asking} onClick={() => void hint("first_letter")} data-testid="rv-first-letter">
          <Icon name="spark" size={18} />
          {t("rv.hint.first")}
        </Btn>
      ) : null}

      {feedback ? <Feedback r={feedback} kid={kid} /> : null}
    </StepFrame>
  );
}

/** What the task shows (bff.ts ReviewTask.prompt) — by type. */
function Prompt({ task, kid }: { task: ReviewTask; kid: boolean }) {
  const { t, l } = useI18n();
  const p = task.prompt;
  const gap = (s: string | null) => {
    const parts = splitBlank(s);
    if (!parts) return s;
    return (
      <>
        {parts[0]}
        <span className="gap" role="img" aria-label={t("dx.gap")}>…</span>
        {parts[1]}
      </>
    );
  };
  switch (task.type) {
    case "intro":
      return (
        <div className="stack tight rv-intro">
          <span className="cap">{t("rv.intro.cap")}</span>
          <h2 className="rv-word" lang="en" data-testid="rv-word">{p.text_en}</h2>
          {p.text_en ? <SpeakButton text={p.text_en} voice={task.voice} kid={kid} testId="rv-listen" /> : null}
          {p.gloss ? <p className="rv-gloss" data-testid="rv-gloss">{l(p.gloss)}</p> : null}
          {p.example_en ? <p className="line-en" lang="en">{p.example_en}</p> : null}
        </div>
      );
    case "meaning_choice":
      return (
        <div className="stack tight">
          <p className="lp-instr">{t("rv.meaning.instr")}</p>
          <h2 className="rv-word" lang="en" data-testid="rv-word">{p.text_en}</h2>
          {p.text_en ? <SpeakButton text={p.text_en} voice={task.voice} kid={kid} testId="rv-listen" /> : null}
        </div>
      );
    case "listen_choice":
      return (
        <div className="stack tight">
          <p className="lp-instr">{t("rv.listen.instr")}</p>
          <div className="listen">
            {p.speech_text ? <SpeakButton big text={p.speech_text} voice={task.voice} kid={kid} label={t("rv.listen.play")} testId="rv-listen" /> : null}
            <span className="sub small">{t("rv.listen.again")}</span>
          </div>
        </div>
      );
    case "typed":
      return (
        <div className="stack tight">
          <p className="lp-instr">{t("rv.typed.instr")}</p>
          {p.gloss ? <h2 className="rv-word" data-testid="rv-gloss">{l(p.gloss)}</h2> : null}
          {p.example_gap ? <p className="line-en rv-gapline" lang="en" data-testid="rv-example">{gap(p.example_gap)}</p> : null}
        </div>
      );
    case "cloze":
      return (
        <div className="stack tight">
          <p className="lp-instr">{t("rv.cloze.instr")}</p>
          <h2 className="lp-q" lang="en" data-testid="rv-example">{gap(p.example_gap)}</h2>
          {p.gloss ? <p className="sub" data-testid="rv-gloss">{t("rv.cloze.gloss", { g: l(p.gloss) })}</p> : null}
        </div>
      );
    case "assemble":
      return (
        <div className="stack tight">
          <p className="lp-instr">{isLetterTiles(task.tiles) ? t("rv.assemble.letters") : t("rv.assemble.words")}</p>
          {p.gloss ? <h2 className="rv-word" data-testid="rv-gloss">{l(p.gloss)}</h2> : null}
        </div>
      );
    case "error_fix":
      return (
        <div className="stack tight">
          <p className="lp-instr">{t("rv.fix.instr")}</p>
          {p.explanation ? <p className="h3" data-testid="rv-explanation">{l(p.explanation)}</p> : null}
          {p.evidence ? (
            <div className="card fix-card">
              <span className="sub small">{t("sm.yours")}</span>
              <span className="was" lang="en" data-testid="rv-evidence">{p.evidence}</span>
            </div>
          ) : null}
        </div>
      );
    case "check_item":
      return (
        <div className="stack tight">
          {p.instruction ? <p className="lp-instr">{l(p.instruction)}</p> : null}
          <h2 className="lp-q" lang="en" data-testid="rv-check-prompt">{gap(p.prompt_en)}</h2>
        </div>
      );
  }
}

/** «Собери»: tap a tile to add it, tap it in the answer to give it back, «Отменить» — the last one, «Сначала» — all. */
function TileBoard({ tiles, state, onChange, locked }: { tiles: string[]; state: Tiles; onChange: (s: Tiles) => void; locked: boolean }) {
  const { t } = useI18n();
  const letters = isLetterTiles(tiles);
  const free = tilesFree(state, tiles.length);
  return (
    <div className="stack tight">
      <p className="lb" id="rv-line-l">{t("rv.assemble.line")}</p>
      <div className={cx("ow-line rv-line", letters && "letters")} role="group" aria-labelledby="rv-line-l" lang="en" data-testid="rv-line" aria-live="polite">
        {state.picked.length === 0 ? <span className="ph" lang="ru">{t("dx.order.empty")}</span> : null}
        {state.picked.map((i, k) => (
          <button
            key={i}
            type="button"
            className="ow-word"
            disabled={locked}
            onClick={() => onChange(tilesUnpick(state, i))}
            aria-label={t("dx.order.remove", { w: tiles[i] ?? "" })}
            data-testid={`rv-line-${k}`}
          >
            {tiles[i]}
          </button>
        ))}
      </div>
      <p className="sr" aria-live="polite" data-testid="rv-assembled">{tilesText(state, tiles)}</p>
      <div className="hrow between">
        <p className="lb" id="rv-bank-l">{t("dx.order.bank")}</p>
        <span className="hrow">
          <Btn variant="link" disabled={locked || !state.picked.length} onClick={() => onChange(tilesUndo(state))} data-testid="rv-undo">
            {t("rv.assemble.undo")}
          </Btn>
          <Btn variant="link" disabled={locked || !state.picked.length} onClick={() => onChange(tilesStart())} data-testid="rv-clear">
            {t("dx.order.reset")}
          </Btn>
        </span>
      </div>
      <div className={cx("ow-bank", letters && "letters")} role="group" aria-labelledby="rv-bank-l" lang="en" data-testid="rv-bank">
        {free.map((i) => (
          <button
            key={i}
            type="button"
            className="ow-word"
            disabled={locked}
            onClick={() => onChange(tilesPick(state, i, tiles.length))}
            aria-label={t("dx.order.add", { w: tiles[i] ?? "" })}
            data-testid={`rv-tile-${i}`}
          >
            {tiles[i]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Right / almost (a typo) / not yet — an icon and words, the right answer, when the card comes back. */
function Feedback({ r, kid }: { r: ReviewTaskResult; kid: boolean }) {
  const { t } = useI18n();
  const res = r.result ?? "incorrect";
  const ok = res === "correct";
  const head = ok ? t(kid ? "rv.fb.correct.kid" : "rv.fb.correct") : res === "almost" ? t(kid ? "rv.fb.almost.kid" : "rv.fb.almost") : t(kid ? "rv.fb.incorrect.kid" : "rv.fb.incorrect");
  return (
    <div className={cx("card lp-feedback", ok ? "ok" : "warn no")} role="status" data-testid="rv-feedback" data-result={res}>
      <Icon name={ok ? "check" : res === "almost" ? "spark" : "info"} size={20} />
      <div className="stack tight">
        <b>{head}</b>
        {!ok && r.correct_answer ? (
          <span className="sub ink" data-testid="rv-right">
            {t("rv.fb.right")} <b lang="en">{r.correct_answer}</b>
          </span>
        ) : null}
        {r.requeued ? (
          <span className="sub small" data-testid="rv-requeued">{t(kid ? "rv.fb.requeued.kid" : "rv.fb.requeued")}</span>
        ) : r.next_review_in_days !== null ? (
          <span className="sub small" data-testid="rv-back-in">
            {r.next_review_in_days <= 1 ? t("rv.fb.backTomorrow") : t("rv.fb.backIn", { n: r.next_review_in_days })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The end of a retention check block: passed or not, each task with your and the right answer. */
function CheckDone({ result, task, kid, onNext }: { result: ReviewTaskResult; task: ReviewTask; kid: boolean; onNext: () => void }) {
  const { t, l } = useI18n();
  const c = result.check_result!;
  useEffect(() => {
    haptic.notify(c.passed ? "success" : "warning");
  }, [c.passed]);
  return (
    <StepFrame top={null} error={null} testId="rv-check-done" foot={<Btn onClick={onNext} data-testid="rv-next" autoFocus>{t("rv.next")}</Btn>}>
      <div className={cx("card outcome", c.passed ? "ok" : "warn")} role="status" data-testid="rv-check-result" data-passed={c.passed}>
        <span className={cx("mk", c.passed ? "ok" : "no")} aria-hidden="true">{c.passed ? "✓" : "↺"}</span>
        <div className="stack tight">
          <b className="h3">{task.check ? t("rv.check.title", { skill: l(task.check.skill_title) }) : t("rv.check.titlePlain")}</b>
          <p className="sub ink">
            {c.passed ? t("rv.check.passed", { n: c.correct, m: c.total }) : t(kid ? "rv.check.failedKid" : "rv.check.failed", { n: c.correct, m: c.total })}
          </p>
        </div>
      </div>
      <ul className="list" data-testid="rv-check-items">
        {c.items.map((it, i) => (
          <li key={i} className="row">
            <span className={cx("mk", it.correct ? "ok" : "no")} aria-hidden="true">{it.correct ? "✓" : "–"}</span>
            <span className="t">
              <b lang="en">{it.prompt_en}</b>
              <span>
                {t("rv.check.yours")}: <span lang="en">{it.your_answer ?? "—"}</span>
                {it.correct ? ` · ${t("rv.check.right")}` : <> · {t("rv.fb.right")} <b lang="en">{it.correct_answer}</b></>}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {!kid ? <Pill tone="mute">{t("rv.check.noXp")}</Pill> : null}
    </StepFrame>
  );
}
