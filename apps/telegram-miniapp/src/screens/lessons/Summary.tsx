import type { EvaluationView, LessonSummary } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { appealState, errorRedacted, errorType, needsEvaluationPoll, pollEvaluation, scoreWord, wrongItems } from "../../domain/lessons";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, Margin, NoBreakHyphens, Pill, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";
import { SessionRewardsCard } from "../game/Rewards";
import { StateChip } from "../skills/SkillMap";
import { useStartSession } from "./startSession";

/** The evaluation as it is now: after an appeal or a QA re-evaluation the newer record replaces the old one. */
async function actualEvaluation(read: (id: string) => Promise<EvaluationView>, id: string): Promise<{ shown: EvaluationView; original: EvaluationView; corrected: boolean }> {
  const original = await read(id);
  let shown = original;
  for (let i = 0; i < 5 && shown.superseded_by; i++) shown = await read(shown.superseded_by);
  return { shown, original, corrected: shown !== original };
}

/**
 * The summary (APP-LESS-07, AT-45, AT-47): the result of the task, the rubric criteria in words (null — «не
 * оценивалось в этом формате»), 1–3 key errors (your fragment → the correction), the items with your and the right
 * answer (only where wrong), the skill changes, the words of the lesson, the next lesson, «Повторить упражнения»,
 * «Оспорить оценку» (within 14 days of the evaluation, then a short note) and the state of the appeal; «оценка появится
 * позже» when there is no evaluation yet — while the screen is open it is re-read on a schedule (6 attempts, ~2 min),
 * «Проверить оценку» re-reads it at once. Not a CEFR certificate — as in the placement test. Sprint 6: the rewards of the
 * game for this session (SessionRewardsCard), only when it was just finished in the player (`fresh`) — the same screen
 * serves lessons, scenarios, media and reading.
 */
export function LessonSummaryScreen({ sessionId, initial, fresh: justFinished = false }: { sessionId: string; initial?: LessonSummary; /** just finished in the player */ fresh?: boolean }) {
  const { bff, nav, session } = useApp();
  const { t, l } = useI18n();
  const kid = session.learner.kind === "child";
  // the summary passed by the player is shown at once; «Проверить оценку» re-requests it (evaluation null — later)
  const [fresh, setFresh] = useState(0);
  const sm = useLoad(() => (initial && fresh === 0 ? Promise.resolve(initial) : bff.sessionSummary(sessionId)), [sessionId, fresh]);
  const s = sm.data;
  const evalId = s?.evaluation?.evaluation_id ?? null;
  // re-read every time: the appeal and the methodologist's decision change it
  const ev = useLoad(() => (evalId ? actualEvaluation((id) => bff.evaluation(id), evalId) : Promise.resolve(null)), [evalId]);
  const e = ev.data?.shown ?? s?.evaluation ?? null;
  const appeal = ev.data?.original.appeal ?? e?.appeal ?? null;
  const appealAt = appealState(e);
  const { start, sheet } = useStartSession();

  // «оценка появится позже»: no message comes in Telegram — re-read the summary while this screen is open (R2-03)
  const waiting = needsEvaluationPoll(s);
  /** the 6 attempts are over: only «Проверить оценку» is left */
  const [pollEnded, setPollEnded] = useState(false);
  const setSummary = sm.setData;
  useEffect(() => {
    if (!waiting) return;
    setPollEnded(false);
    return pollEvaluation(() => bff.sessionSummary(sessionId), { ready: (fresh) => setSummary(fresh), end: () => setPollEnded(true) });
  }, [waiting, bff, sessionId, setSummary]);

  return (
    <>
      <Bar title={s ? t(`sm.cap.${s.kind}` as MessageKey) : t("sm.cap.lesson")} onBack={nav.back} plainTitle />
      <main className="scroll" data-testid="summary">
        {sm.loading && !s ? (
          <div className="pad"><Skeleton lines={5} /></div>
        ) : sm.error && !s ? (
          <div className="pad stack tight">
            <div className="card err"><p className="sub ink">{sm.error}</p></div>
            <Btn variant="secondary" onClick={() => void sm.reload()}>{t("c.retry")}</Btn>
          </div>
        ) : s ? (
          <div className="stack loose">
            <div className="pad sm-head">
              <div className="cap">{l(s.title)}</div>
              <h1 className="h1" data-testid="sm-task">
                {s.status !== "completed" ? t(`sm.status.${s.status}` as MessageKey) : s.outcome ? t(`sm.task.${s.outcome}` as MessageKey) : t("sm.task.none")}
              </h1>
              <div className="pills">
                {e?.passed === true ? <Pill tone="ok"><Icon name="check" size={14} stroke={3} />{s.kind === "lesson" ? t("sm.passed") : t("sm.passedOther")}</Pill> : null}
                {e?.passed === false ? <Pill tone="mute">{t("sm.notPassed")}</Pill> : null}
                <Pill tone="mute">{t("sm.minutes", { n: s.minutes })}</Pill>
              </div>
            </div>

            {/* sprint 6: XP, tils, a level, badges, the hero's growth of this session (credited by events — polled) — only
                right after the player; a past session opened from the history shows no rewards and asks nothing */}
            {justFinished && s.status === "completed" ? <SessionRewardsCard sessionId={s.session_id} /> : null}

            {/* a re-evaluation by appeal is told once, in the appeal card; a QA re-evaluation — by its own note */}
            {ev.data?.corrected && !appeal ? (
              <div className="pad"><div className="card pen notice" data-testid="sm-corrected"><Icon name="info" size={20} /><p className="sub ink">{t("sm.showingCorrected")}</p></div></div>
            ) : null}
            {appeal ? <AppealState appeal={appeal} corrected={!!ev.data?.corrected} /> : null}

            {!e && s.status === "completed" ? (
              <div className="pad">
                <div className="card stack tight" data-testid="sm-pending">
                  <div className="notice" role="status"><Icon name="clock" size={20} /><p className="sub ink">{t(pollEnded ? "sm.pendingEvalIdle" : "sm.pendingEval")}</p></div>
                  <Btn variant="secondary" busy={sm.loading} onClick={() => setFresh((n) => n + 1)} data-testid="sm-refresh">{t("sm.refresh")}</Btn>
                </div>
              </div>
            ) : null}
            {e ? <EvaluationNotes e={e} /> : null}

            <div className="pad">
              <div className="card warn cert" role="note" data-testid="sm-not-cefr">
                <Icon name="shield" size={20} />
                <p className="sub ink">{t("sm.notCert")}</p>
              </div>
            </div>

            {e && e.scores.length ? (
              <section className="pad stack tight" aria-labelledby="sm-sc">
                <h2 className="sec" id="sm-sc">{t("sm.scores")}</h2>
                <div className="list" data-testid="sm-scores">
                  {e.scores.map((x) => (
                    <div className="score-row" key={x.code} data-testid={`sm-score-${x.code}`}>
                      <span className="t">{l(x.title)}</span>
                      {x.score !== null ? (
                        <span className="dots3" aria-hidden="true">
                          {[1, 2, 3].map((n) => <i key={n} className={cx(x.score! >= n && "on")} />)}
                        </span>
                      ) : null}
                      <span className="sub small">{t(`sm.score.${scoreWord(x.score)}` as MessageKey)}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {e && e.key_errors.length ? (
              <section className="stack" aria-labelledby="sm-err" data-testid="sm-errors">
                <div className="pad"><h2 className="sec" id="sm-err">{t("sm.errors")}</h2></div>
                {e.key_errors.map((x, i) => (
                  <Margin key={`${x.turn_id}-${i}`} note={String(i + 1)}>
                    {errorRedacted(x) ? (
                      // a copy older than 90 days: the fragment and the correction are erased — only the type of the error
                      <div className="card fix-card" data-testid="sm-error" data-redacted="true">
                        <span className="sub small">{t("sm.errType")}</span>
                        <span className="ink" data-testid="sm-error-type">{t(`ec.${errorType(x.error_code)}` as MessageKey)}</span>
                      </div>
                    ) : (
                      <div className="card fix-card" data-testid="sm-error">
                        {x.evidence.trim() ? (
                          <>
                            <span className="sub small">{t("sm.yours")}</span>
                            <span className="was" lang="en">{x.evidence}</span>
                          </>
                        ) : null}
                        {x.correction.trim() ? <span className="now" lang="en">{t("sm.better", { text: x.correction })}</span> : null}
                      </div>
                    )}
                  </Margin>
                ))}
              </section>
            ) : null}

            {e && e.items.length ? (
              <section className="pad stack tight" aria-labelledby="sm-it" data-testid="sm-items">
                <h2 className="sec" id="sm-it">{t("sm.items")}</h2>
                {wrongItems(e).length ? (
                  wrongItems(e).map((i) => (
                    <div className="card stack tight" key={i.item_id} data-testid={`sm-item-${i.item_id}`}>
                      <b lang="en">{i.prompt_en}</b>
                      <dl className="ans">
                        <dt>{t("sm.yourAnswer")}</dt>
                        <dd lang="en">{i.your_answer ?? t("sm.noAnswer")}{i.hinted ? ` · ${t("sm.hinted")}` : ""}</dd>
                        {i.correct_answer ? (
                          <>
                            <dt>{t("sm.rightAnswer")}</dt>
                            <dd lang="en">{i.correct_answer}</dd>
                          </>
                        ) : null}
                      </dl>
                    </div>
                  ))
                ) : (
                  <p className="sub" data-testid="sm-all-right">{t("sm.allRight")}</p>
                )}
              </section>
            ) : null}

            {e?.practice_only || s.kind === "review" ? null : (
              <section className="pad stack tight" aria-labelledby="sm-sk" data-testid="sm-skills">
                <h2 className="sec" id="sm-sk">{t("sm.skills")}</h2>
                {s.skills.length ? (
                  <div className="list">
                    {s.skills.map((x) => (
                      <div className="row" key={x.skill_id}>
                        <span className="t">
                          <b>{l(x.title)}</b>
                          {x.from === x.to ? (
                            <span className="skill-ch"><StateChip state={x.to} /></span>
                          ) : (
                            <span className="skill-ch" aria-label={t("sm.skillArrow", { from: t(`sk.state.${x.from}` as MessageKey), to: t(`sk.state.${x.to}` as MessageKey) })}>
                              <StateChip state={x.from} /> <span aria-hidden="true">→</span> <StateChip state={x.to} />
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="sub">{t("sm.skillsNone")}</p>
                )}
                <p className="sub small">{t("sm.retainedLater")}</p>
              </section>
            )}

            {s.key_words.length ? (
              <section className="pad stack tight" aria-labelledby="sm-kw">
                <h2 className="sec" id="sm-kw">{t("sm.words")}</h2>
                <ul className="list" data-testid="sm-words">
                  {s.key_words.map((k) => (
                    <li className="row" key={k.en}>
                      <span className="t"><b lang="en">{k.en}</b><span>{l(k.gloss)}</span></span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {s.next_lesson ? (
              <Margin>
                <section className="card lift stack tight" aria-labelledby="sm-next" data-testid="sm-next">
                  <div className="cap" id="sm-next">{t("sm.next")} · {t("plan.meta", { level: s.next_lesson.level, n: s.next_lesson.duration_min })}</div>
                  <h2 className="h2"><NoBreakHyphens text={l(s.next_lesson.title)} /></h2>
                  <p className="sub">{l(s.next_lesson.goal)}</p>
                  <Btn variant="secondary" onClick={() => nav.replace({ name: "lessonCard", id: s.next_lesson!.lesson_id })} data-testid="sm-next-open">
                    {t("sm.nextOpen")}
                  </Btn>
                </section>
              </Margin>
            ) : null}

            <div className="pad stack tight">
              {s.can_review ? (
                <>
                  <ErrorLine text={start.error} />
                  <Btn variant="secondary" busy={start.busy} onClick={() => void start.run({ kind: "review", sessionId: s.session_id })} data-testid="sm-review">
                    <Icon name="review" size={18} />
                    {t("sm.review")}
                  </Btn>
                  <p className="sub small">{t("sm.reviewNote")}</p>
                </>
              ) : null}
              {e && appealAt === "open" ? (
                <Btn variant="link" className="c" onClick={() => nav.push({ name: "appeal", evaluationId: e.evaluation_id, title: s.title })} data-testid="sm-appeal">
                  <Icon name="flag" size={18} />
                  {t("sm.appeal")}
                </Btn>
              ) : null}
              {appealAt === "closed" ? <p className="sub small center" data-testid="sm-appeal-closed">{t("sm.appealClosed")}</p> : null}
              {kid && appealAt === "open" ? <p className="sub small center">{t("ap.kid")}</p> : null}
              {e ? (
                <p className="sub small center" data-testid="sm-versions">
                  {t("sm.versions", { r: e.rubric_version, who: e.evaluator ? t("sm.byEvaluator") : t("sm.byRules") })}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </main>
      {s ? (
        <div className="foot">
          <Btn onClick={nav.back} data-testid="sm-done">{t("sm.done")}</Btn>
        </div>
      ) : null}
      {sheet}
    </>
  );
}

function EvaluationNotes({ e }: { e: EvaluationView }) {
  const { t } = useI18n();
  const notes: string[] = [];
  if (e.status === "pending_review") notes.push(t("sm.pendingReview"));
  if (e.status === "partial") notes.push(t("sm.partial"));
  if (e.status === "insufficient_evidence") notes.push(t("sm.insufficient"));
  if (e.practice_only) notes.push(t("sm.practiceOnly"));
  if (!notes.length) return null;
  return (
    <div className="pad stack tight" data-testid="sm-notes">
      {notes.map((n) => (
        <div className="card notice" key={n}><Icon name="info" size={20} /><p className="sub ink">{n}</p></div>
      ))}
    </div>
  );
}

function AppealState({ appeal, corrected }: { appeal: NonNullable<EvaluationView["appeal"]>; corrected: boolean }) {
  const { t } = useI18n();
  const decided = appeal.status === "upheld" || appeal.status === "corrected";
  return (
    <div className="pad">
      <div className={cx("card appeal-st", decided ? "ok" : "pen")} role="status" data-testid="sm-appeal-state" data-status={appeal.status}>
        <Icon name={decided ? "check" : "clock"} size={20} />
        <div className="stack tight">
          <b>{t(`sm.appeal.${appeal.status}` as MessageKey)}</b>
          {appeal.reason === null ? (
            <p className="sub small" data-testid="sm-appeal-reason" data-redacted="true">{t("sm.appeal.reasonRedacted")}</p>
          ) : (
            <p className="sub small" data-testid="sm-appeal-reason">{t("sm.appeal.reason", { reason: appeal.reason })}</p>
          )}
          {appeal.decision_note ? <p className="sub ink">{t("sm.appeal.note", { note: appeal.decision_note })}</p> : null}
          {corrected ? <p className="sub small" data-testid="sm-corrected">{t("sm.showingCorrected")}</p> : null}
        </div>
      </div>
    </div>
  );
}
