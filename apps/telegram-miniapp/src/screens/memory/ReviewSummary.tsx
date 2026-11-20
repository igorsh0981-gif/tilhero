import type { ReviewSummary } from "@tilhero/contracts/bff";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { Icon } from "../../ui/Icon";
import { Btn, cx, HERO, Hero, Pill } from "../../ui/kit";
import { Bar } from "../../ui/shell";

/**
 * Итоги «Повторения дня» (AT-54, AT-56): what was reviewed, right from the first time, new words, the retention checks
 * (a d30 check passed — the skill is «закреплён»), when the next review is. Children: what went well, no counters of
 * misses and no comparisons.
 */
export function ReviewSummaryScreen({ summary: s }: { summary: ReviewSummary }) {
  const { nav, session } = useApp();
  const { t, l, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const done = s.status === "completed";
  return (
    <>
      <Bar title={t("rv.sum.cap")} onBack={nav.back} plainTitle />
      <main className="scroll" data-testid="rv-summary">
        <div className="pad stack loose">
          <div className="stack tight center">
            <Hero src={kid ? HERO.myatik : HERO.voltUp} alt="" className="rv-hero" />
            <h1 className="h1" data-testid="rv-sum-title">{done ? t(kid ? "rv.sum.titleKid" : "rv.sum.title") : t(`rv.sum.status.${s.status}` as MessageKey)}</h1>
            <p className="sub">{t("sm.minutes", { n: s.minutes })}</p>
          </div>

          <div className="counts" data-testid="rv-sum-counts">
            <div className="count"><Icon name="review" size={20} /><b data-testid="rv-sum-reviewed">{s.reviewed}</b><span className="sub small">{t("rv.sum.reviewed")}</span></div>
            <div className="count"><Icon name="check" size={20} /><b data-testid="rv-sum-correct">{s.correct}</b><span className="sub small">{t("rv.sum.correct")}</span></div>
            <div className="count"><Icon name="plus" size={20} /><b data-testid="rv-sum-new">{s.new_learned}</b><span className="sub small">{t("rv.sum.new")}</span></div>
            {!kid ? <div className="count"><Icon name="route" size={20} /><b data-testid="rv-sum-again">{s.again}</b><span className="sub small">{t("rv.sum.again")}</span></div> : null}
          </div>

          {s.checks.length ? (
            <section className="stack tight" aria-labelledby="rv-sum-checks" data-testid="rv-sum-checks">
              <h2 className="sec" id="rv-sum-checks">{t("rv.sum.checks")}</h2>
              <ul className="list">
                {s.checks.map((c, i) => (
                  <li key={i} className="row" data-testid="rv-sum-check" data-passed={c.passed}>
                    <span className={cx("mk", c.passed ? "ok" : "no")} aria-hidden="true">{c.passed ? "✓" : "↺"}</span>
                    <span className="t">
                      <b>{t("rv.check.title", { skill: l(c.skill_title) })}</b>
                      <span>
                        {t(c.stage === "d7" ? "rv.sum.d7" : "rv.sum.d30")} · {c.passed ? t("rv.sum.passed") : t(kid ? "rv.sum.notYetKid" : "rv.sum.notYet")}
                      </span>
                      {c.skill_retained ? (
                        <span className="pills">
                          <Pill tone="ok"><Icon name="star" size={14} />{t("rv.sum.retained")}</Pill>
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              {!kid ? <p className="sub small">{t("rv.check.noXp")}</p> : null}
            </section>
          ) : null}

          <div className="card stack tight" data-testid="rv-sum-next">
            <p className="h3 ic-line"><Icon name="calendar" size={18} />{s.next_due_at ? t("rv.sum.next", { date: fmt.date(s.next_due_at) }) : t("rv.sum.nextNone")}</p>
            {s.due_tomorrow ? <p className="sub">{t("rv.sum.tomorrow", { n: s.due_tomorrow })}</p> : null}
          </div>
        </div>
      </main>
      <div className="foot">
        <Btn onClick={nav.back} data-testid="rv-sum-done">{t("rv.sum.done")}</Btn>
      </div>
    </>
  );
}
