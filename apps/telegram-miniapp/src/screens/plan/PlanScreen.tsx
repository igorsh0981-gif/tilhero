import type { LessonCard, ReasonCode } from "@tilhero/contracts/bff";
import { stageShares } from "../../domain/content";
import { completedMark } from "../../domain/lessons";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp, usePlan } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, Margin, NoBreakHyphens, Pill, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";
import { isCatalogUnavailable } from "../skills/SkillMap";

export function ReasonPills({ codes }: { codes: readonly ReasonCode[] }) {
  const { t } = useI18n();
  if (!codes.length) return null;
  return (
    <div className="pills" data-testid="reasons">
      {codes.map((c) => (
        <Pill key={c} tone={c === "weak_area" || c === "prerequisite_missing" ? "warn" : c === "repeat" ? "mute" : undefined}>
          {t(`plan.reason.${c}` as MessageKey)}
        </Pill>
      ))}
    </div>
  );
}

/** Stages of a lesson: a bar (decorative) and the same as text («повторение 3 мин · …»). */
export function Stages({ card }: { card: Pick<LessonCard, "stages" | "duration_min"> }) {
  const { t } = useI18n();
  const shares = stageShares(card);
  const text = shares.map((s) => t("plan.stageMin", { stage: t(`plan.stage.${s.type}` as MessageKey), n: s.minutes }));
  return (
    <div className="stack tight">
      <div className="stagebar" aria-hidden="true">
        {shares.map((s, i) => (
          <span key={i} style={{ width: `${s.pct}%` }} />
        ))}
      </div>
      <p className="stages" aria-label={`${t("plan.stagesAria")}: ${text.join(", ")}`}>
        {text.map((x, i) => (
          <span key={i} aria-hidden="true">{x}</span>
        ))}
      </p>
    </div>
  );
}

export function LessonCardView({ card, reasons, n, onOpen }: { card: LessonCard; reasons?: readonly ReasonCode[]; n?: number; onOpen?: () => void }) {
  const { t, l } = useI18n();
  return (
    <Margin note={n != null ? String(n) : undefined} tone="b">
      <article className="card stack tight" data-testid={`lesson-${card.lesson_id}`} aria-label={l(card.title)}>
        <div className="cap">
          {t("plan.meta", { level: card.level, n: card.duration_min })} · {t(`plan.kind.${card.kind}` as MessageKey)}
        </div>
        <h3 className="h3">{l(card.title)}</h3>
        <p className="sub">{l(card.goal)}</p>
        <Stages card={card} />
        {reasons ? <ReasonPills codes={reasons} /> : null}
        {onOpen ? (
          <Btn variant="link" onClick={onOpen} data-testid={`open-${card.lesson_id}`}>
            {t("ls.next.open")}
            <Icon name="chevron" size={16} stroke={2} />
          </Btn>
        ) : null}
      </article>
    </Margin>
  );
}

/**
 * «Мой план» (APP-PLAN-02/03, AT-36): the next lesson with its reason, mandatory and optional lessons (goal, level,
 * stages and minutes), the lessons passed (sprint 4: «зачтено / повторить»). Recalculated by learning-plan after a goal
 * change (the plan version), a new placement test or a lesson. «Начать урок» → the lesson card.
 */
export function PlanScreen() {
  const { bff, nav } = useApp();
  const plan = usePlan();
  const { t, tp, l, fmt } = useI18n();
  const tr = useLoad(() => bff.trajectory(), [plan.version, plan.goal, plan.learner_id]);
  const d = tr.data;

  return (
    <>
      <Bar title={t("plan.title")} onBack={nav.back} />
      <main className="scroll" data-testid="plan-screen">
        <div className="stack loose">
          <div className="pad">
            <div className="card stack tight" data-testid="plan-basis">
              <div className="hrow between">
                <b className="h3">{plan.goal ? t("plan.goal", { goal: t(`goal.${plan.goal}` as MessageKey) }) : t("plan.goalNone")}</b>
                <Btn variant="link" onClick={() => nav.push({ name: "goal" })} data-testid="plan-change-goal">
                  {t("plan.changeGoal")}
                </Btn>
              </div>
              {d ? (
                d.basis.diagnostic_result_id ? (
                  <p className="sub">{t("plan.basisDiag", { date: fmt.date(d.basis.computed_at) })}</p>
                ) : (
                  <div className="stack tight">
                    <p className="sub">{t("plan.basisNone")}</p>
                    <Btn variant="secondary" onClick={() => nav.push({ name: "diagnostics" })} data-testid="plan-to-diag">
                      {t("plan.toDiag")}
                    </Btn>
                  </div>
                )
              ) : null}
              <p className="sub small">{t("plan.recalc")}</p>
            </div>
          </div>

          {tr.loading && !d ? (
            <div className="pad"><Skeleton lines={4} /></div>
          ) : tr.error && !d ? (
            <div className="pad">
              <div className="card warn stack tight" data-testid="plan-error">
                <p className="sub ink">{isCatalogUnavailable(tr.errorObj) ? t("plan.unavailable") : tr.error}</p>
                <Btn variant="secondary" onClick={() => void tr.reload()}>{t("c.retry")}</Btn>
              </div>
            </div>
          ) : d ? (
            <>
              {d.next ? (
                <Margin note={t("plan.why")} tilt>
                  <section className="card lift stack tight" aria-labelledby="plan-next" data-testid="plan-next">
                    <div className="cap" id="plan-next">
                      {t("plan.next")} · {t("plan.meta", { level: d.next.level, n: d.next.duration_min })}
                    </div>
                    <h2 className="h2"><NoBreakHyphens text={l(d.next.title)} /></h2>
                    <p className="sub ink">{l(d.next.goal)}</p>
                    <p className="sub" data-testid="plan-explanation">{l(d.next.explanation)}</p>
                    <ReasonPills codes={d.next.reason_codes} />
                    <Stages card={d.next} />
                    <Btn disabled={!d.lessons_available} onClick={() => nav.push({ name: "lessonCard", id: d.next!.lesson_id })} data-testid="plan-start">
                      <Icon name="lessons" size={18} />
                      {t("plan.startLesson")}
                    </Btn>
                    {!d.lessons_available ? <p className="sub small">{t("plan.lessonsSoon")}</p> : null}
                  </section>
                </Margin>
              ) : null}

              <section className="stack" aria-labelledby="plan-mand" data-testid="plan-mandatory">
                <div className="pad hrow between">
                  <h2 className="sec" id="plan-mand">{t("plan.mandatory")}</h2>
                  <span className="sub small">{t("plan.count", { n: d.mandatory.length, lessons: tp("plan.lessonsWord", d.mandatory.length) })}</span>
                </div>
                {d.mandatory.length ? (
                  d.mandatory.map((c, i) => (
                    <LessonCardView key={c.lesson_id} card={c} reasons={c.reason_codes} n={i + 1} onOpen={d.lessons_available ? () => nav.push({ name: "lessonCard", id: c.lesson_id }) : undefined} />
                  ))
                ) : (
                  <div className="pad"><p className="sub">{t("plan.empty")}</p></div>
                )}
              </section>

              {d.optional.length ? (
                <section className="stack" aria-labelledby="plan-opt" data-testid="plan-optional">
                  <div className="pad">
                    <h2 className="sec" id="plan-opt">{t("plan.optional")}</h2>
                  </div>
                  {d.optional.map((c) => (
                    <LessonCardView key={c.lesson_id} card={c} reasons={c.reason_codes} onOpen={d.lessons_available ? () => nav.push({ name: "lessonCard", id: c.lesson_id }) : undefined} />
                  ))}
                </section>
              ) : null}

              {d.completed.length ? (
                <section className="pad stack tight" aria-labelledby="plan-done" data-testid="plan-completed">
                  <h2 className="sec" id="plan-done">{t("ls.completed")}</h2>
                  <div className="list">
                    {d.completed.map((c) => {
                      const mark = completedMark(c);
                      return (
                        <div className="row ls-row" key={c.lesson_id}>
                          <span className="t">
                            <b>{l(c.title)}</b>
                            <span>{fmt.date(c.completed_at)}</span>
                          </span>
                          <span className={mark === "passed" ? "v ok" : mark === "again" ? "v again" : "v"}>
                            {t(mark === "passed" ? "ls.passed" : mark === "again" ? "ls.again" : "ls.later")}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </main>
    </>
  );
}
