import { useState } from "react";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";
import { useStartSession } from "../lessons/startSession";

const OUTCOME_MARK = { success: "✓", alt_success: "☆", fail: "↺" } as const;

/** A scenario card (AT-37): task, characters, the first line with its translation on tap, the learner's replies,
 *  outcomes and completion criteria; «Разыграть» (AT-48) — a scenario session: the roleplay chat → the summary with the
 *  evaluation by the scenario's rubric. A child plays it with ready replies only. */
export function ScenarioScreen({ id }: { id: string }) {
  const { bff, nav } = useApp();
  const { t, l } = useI18n();
  const sc = useLoad(() => bff.scenario(id), [id]);
  const [gloss, setGloss] = useState(false);
  const { start, sheet } = useStartSession();
  const d = sc.data;
  return (
    <>
      {/* в шапке — раздел, название сценария — h1 ниже (без повтора) */}
      <Bar title={t("pr.tab.scenarios")} onBack={nav.back} plainTitle />
      <main className="scroll" data-testid="scenario">
        {sc.loading && !d ? (
          <div className="pad"><Skeleton lines={4} /></div>
        ) : sc.error && !d ? (
          <div className="pad stack tight">
            <div className="card err"><p className="sub ink">{sc.error}</p></div>
            <Btn variant="secondary" onClick={() => void sc.reload()}>{t("c.retry")}</Btn>
          </div>
        ) : d ? (
          <div className="pad stack loose">
            <div className="stack tight">
              <div className="cap">{t("sc.meta", { level: d.level, n: d.difficulty })}</div>
              <h1 className="h1">{l(d.title)}</h1>
            </div>
            <div className="card stack tight">
              <p className="lb">{t("sc.task")}</p>
              <p className="sub ink">{l(d.task)}</p>
              <p className="lb mt8">{t("sc.characters")}</p>
              <ul className="stack tight">
                {d.characters.map((c, i) => (
                  <li key={i} className="hrow">
                    <span className="av s" aria-hidden="true">{c.name.charAt(0)}</span>
                    <span><b lang="en">{c.name}</b> — <span className="sub">{l(c.role)}</span></span>
                  </li>
                ))}
              </ul>
            </div>

            <section className="stack tight" aria-labelledby="sc-open">
              <h2 className="sec" id="sc-open">{t("sc.opening")}</h2>
              <div className="card stack tight" data-testid="sc-opening">
                <span className="cap" lang="en">{d.opening.speaker}</span>
                <p className="line-en" lang="en">{d.opening.line_en}</p>
                {gloss ? <p className="gloss" data-testid="sc-gloss">{l(d.opening.gloss)}</p> : null}
                <Btn variant="link" onClick={() => setGloss(!gloss)} aria-expanded={gloss} data-testid="sc-translate">
                  {gloss ? t("sc.hideTranslate") : t("sc.translate")}
                </Btn>
              </div>
              <p className="lb">{t("sc.replies")}</p>
              <ul className="list">
                {d.opening.replies.map((r, i) => (
                  <li className="row" key={i}>
                    <span className="t">
                      <b>{l(r.description)}</b>
                      {r.example_en ? <span lang="en">«{r.example_en}»</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="stack tight" aria-labelledby="sc-out">
              <h2 className="sec" id="sc-out">{t("sc.outcomes")}</h2>
              <ul className="stack tight">
                {d.outcomes.map((o, i) => (
                  <li className="ev" key={i}>
                    <span className={cx("mk", o.outcome === "fail" ? "no" : "ok")} aria-hidden="true">{OUTCOME_MARK[o.outcome]}</span>
                    <span className="grow">
                      <b className="blk">{l(o.summary)}</b>
                      <span className="sub small">{t(`sc.outcome.${o.outcome}` as MessageKey)}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="card pen">
                <p className="lb">{t("sc.completion")}</p>
                <p className="sub ink">{l(d.completion)}</p>
              </div>
            </section>

          </div>
        ) : null}
      </main>
      {d ? (
        <div className="foot">
          <ErrorLine text={start.error} />
          <Btn busy={start.busy} onClick={() => void start.run({ kind: "scenario", id: d.scenario_id })} data-testid="sc-play">
            <Icon name="chat" size={18} />
            {t("sc.play")}
          </Btn>
          <p className="sub small center">{t("sc.playNote")}</p>
        </div>
      ) : null}
      {sheet}
    </>
  );
}
