/**
 * «Аналитика забывания» (memory.read | dashboard.read; ADM-MEM-02, AT-61): period 30 / 90 days; the share of passed
 * delayed checks d7 / d30 overall and by skill; by lesson — cards and the share of «again»; repeated errors by code;
 * the most forgotten words (≥ 20 answers). Only aggregates: a group of fewer than 5 learners is `hidden` and shown as
 * «мало данных (< 5 учеников)» — never as a zero. The bars follow the chart rules of the admin: a title, the value as
 * text next to every bar (never colour alone), a meter role for screen readers.
 */
import { useCallback, useEffect, useState } from "react";
import type { CheckRate, ForgettingAnalytics } from "@tilhero/contracts/admin";
import { Memory } from "../../api/endpoints";
import { useI18n } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, cx, Empty, Seg, Spinner } from "../../ui/kit";
import { rateShown } from "./model";

type APeriod = ForgettingAnalytics["period"];

export function AnalyticsTab() {
  const { t, fmt } = useI18n();
  const [period, setPeriod] = useState<APeriod>("30d");
  const [data, setData] = useState<ForgettingAnalytics | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    Memory.analytics(period)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [period]);
  useEffect(load, [load]);
  return (
    <div className="stack" data-testid="mem-analytics" data-period={period}>
      <div className="dash-head">
        <Seg<APeriod> label={t("fa.period")} value={period} onChange={setPeriod} testId="fa-period" items={(["30d", "90d"] as const).map((v) => ({ v, label: t(`fa.p.${v}`) }))} />
        <span className="grow" />
        {data && (
          <span className="dash-updated" data-testid="fa-updated">
            {data.pair_id} · {t("dash.updated", { t: fmt.time(data.generated_at) })}
          </span>
        )}
        <Btn size="sm" icon="refresh" label={t("common.refresh")} busy={loading && !!data} onClick={load} />
      </div>
      <p className="small muted">{t("fa.lead")}</p>
      {error && !data ? <LoadError error={error} onRetry={load} /> : !data ? <Spinner label={t("common.loading")} /> : <Body d={data} />}
    </div>
  );
}

function Body({ d }: { d: ForgettingAnalytics }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const content = can("content.read");
  return (
    <>
      <div className="grid2">
        <RateCard stage="d7" r={d.checks.d7} />
        <RateCard stage="d30" r={d.checks.d30} />
      </div>

      <section className="panel" aria-labelledby="fa-skill-h" data-testid="fa-skills">
        <div className="panel-h">
          <h2 className="panel-t grow" id="fa-skill-h">
            <Icon name="layers" /> {t("fa.bySkill")}
          </h2>
        </div>
        {d.by_skill.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <caption className="sr-only">{t("fa.bySkill")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("mem.col.skill")}</th>
                  <th scope="col">{t("fa.d7")}</th>
                  <th scope="col">{t("fa.d30")}</th>
                </tr>
              </thead>
              <tbody>
                {d.by_skill.map((s) => (
                  <tr key={s.skill_id} data-testid={`fa-skill-${s.skill_id}`}>
                    <td>
                      <span lang="ru">{s.title?.ru ?? s.skill_id}</span>
                      <span className="mono xs muted block">{s.skill_id}</span>
                    </td>
                    <td>
                      <RateCell r={s.d7} testId={`fa-skill-${s.skill_id}-d7`} />
                    </td>
                    <td>
                      <RateCell r={s.d30} testId={`fa-skill-${s.skill_id}-d30`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="inbox" title={t("fa.noData")} text={t("fa.noDataM")} />
        )}
      </section>

      <div className="grid2">
        <section className="panel" aria-labelledby="fa-lesson-h" data-testid="fa-lessons">
          <div className="panel-h">
            <h2 className="panel-t grow" id="fa-lesson-h">
              <Icon name="book" /> {t("fa.byLesson")}
            </h2>
          </div>
          {d.by_lesson.length ? (
            <div className="table-wrap">
              <table className="tbl compact">
                <caption className="sr-only">{t("fa.byLesson")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("fa.lesson")}</th>
                    <th scope="col" className="r">
                      {t("fa.cards")}
                    </th>
                    <th scope="col">{t("fa.againPct")}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.by_lesson.map((l) => (
                    <tr key={l.lesson_id} data-testid={`fa-lesson-${l.lesson_id}`} data-hidden={String(l.hidden)}>
                      <td>
                        {content ? (
                          <button type="button" className="tr" lang="ru" onClick={() => navigate("content", `lessons/${l.lesson_id}`)}>
                            {l.title?.ru ?? l.lesson_id}
                          </button>
                        ) : (
                          <span lang="ru">{l.title?.ru ?? l.lesson_id}</span>
                        )}
                        <span className="mono xs muted block">{l.lesson_id}</span>
                      </td>
                      {l.hidden ? (
                        <td colSpan={2}>
                          <Hidden />
                        </td>
                      ) : (
                        <>
                          <td className="r num">{fmt.num(l.cards)}</td>
                          <td>{l.again_pct == null ? "—" : <Meter v={l.again_pct} label={t("fa.againAria", { w: l.title?.ru ?? l.lesson_id, p: fmt.pct(l.again_pct) })} bad={l.again_pct >= 40} />}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="inbox" title={t("fa.noData")} />
          )}
        </section>

        <section className="panel" aria-labelledby="fa-err-h" data-testid="fa-errors">
          <div className="panel-h">
            <h2 className="panel-t grow" id="fa-err-h">
              <Icon name="alertCircle" /> {t("fa.repeated")}
            </h2>
          </div>
          <p className="panel-b xs muted">{t("fa.repeatedHint")}</p>
          {d.repeated_errors.length ? (
            <div className="table-wrap">
              <table className="tbl compact">
                <caption className="sr-only">{t("fa.repeated")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("fa.error")}</th>
                    <th scope="col" className="r">
                      {t("fa.learnersRepeats")}
                    </th>
                    <th scope="col" className="r">
                      {t("fa.cards")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.repeated_errors.map((e) => (
                    <tr key={e.error_code} data-testid={`fa-err-${e.error_code}`} data-hidden={String(e.hidden)}>
                      <td>
                        <span lang="ru">{e.label.ru}</span>
                        <span className="mono xs muted block">{e.error_code}</span>
                      </td>
                      {e.hidden ? (
                        <td colSpan={2}>
                          <Hidden />
                        </td>
                      ) : (
                        <>
                          <td className="r num">{fmt.num(e.learners_with_repeats)}</td>
                          <td className="r num">{fmt.num(e.cards)}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="inbox" title={t("fa.noData")} />
          )}
        </section>
      </div>

      <section className="card stack sm" aria-labelledby="fa-words-h" data-testid="fa-words">
        <h2 className="h2" id="fa-words-h">
          {t("fa.words")}
        </h2>
        <p className="xs muted">{t("fa.wordsHint")}</p>
        {d.forgotten_words.length ? (
          <figure className="hbars" aria-labelledby="fa-words-h">
            <ol className="hbars-list">
              {d.forgotten_words.map((w, n) => (
                <li key={w.text_en} className="hbars-row" data-testid={`fa-word-${n}`}>
                  <span className="hbars-l" lang="en">
                    {w.text_en}
                  </span>
                  <Meter v={w.again_pct} label={t("fa.wordAria", { w: w.text_en, p: fmt.pct(w.again_pct), n: fmt.num(w.answers) })} bad={w.again_pct >= 40} />
                  <span className="xs muted hbars-n">{t("fa.answersN", { n: fmt.num(w.answers) })}</span>
                </li>
              ))}
            </ol>
          </figure>
        ) : (
          <Empty icon="inbox" title={t("fa.noWords")} />
        )}
      </section>
      <p className="xs muted row">
        <Icon name="shield" /> {t("fa.privacy")}
      </p>
    </>
  );
}

function Hidden() {
  const { t } = useI18n();
  return (
    <span className="fa-hidden" title={t("fa.hiddenHint")} data-testid="fa-hidden">
      <Icon name="eyeOff" /> {t("fa.hidden")}
    </span>
  );
}

/** A percentage as text + a thin bar (role meter): the value is always written, the bar only supports it. */
export function Meter({ v, label, bad, good }: { v: number; label: string; bad?: boolean; good?: boolean }) {
  const { fmt } = useI18n();
  const w = Math.max(0, Math.min(100, v));
  return (
    <span className={cx("fa-meter", bad && "is-bad", good && "is-good")}>
      <span className="fa-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w)} aria-label={label}>
        <span className="fa-fill" style={{ width: `${w}%` }} />
      </span>
      <b className="num">{fmt.pct(v)}</b>
    </span>
  );
}

function RateCell({ r, testId }: { r: CheckRate; testId?: string }) {
  const { t, fmt } = useI18n();
  if (r.hidden)
    return (
      <span data-testid={testId} data-hidden="true">
        <Hidden />
      </span>
    );
  if (!rateShown(r))
    return (
      <span className="xs muted" data-testid={testId}>
        {t("fa.noChecks")}
      </span>
    );
  return (
    <span className="stack xs-gap" data-testid={testId}>
      <Meter v={r.pass_pct!} label={t("fa.rateAria", { p: fmt.pct(r.pass_pct!), a: r.passed, n: r.scheduled })} good={r.pass_pct! >= 70} bad={r.pass_pct! < 50} />
      <span className="xs muted">{t("fa.rateN", { a: fmt.num(r.passed), f: fmt.num(r.failed), n: fmt.num(r.scheduled) })}</span>
    </span>
  );
}

function RateCard({ stage, r }: { stage: "d7" | "d30"; r: CheckRate }) {
  const { t, fmt } = useI18n();
  return (
    <section className="card stack sm" aria-labelledby={`fa-${stage}-h`} data-testid={`fa-${stage}`} data-hidden={String(r.hidden)}>
      <h2 className="h2" id={`fa-${stage}-h`}>
        {t(`fa.${stage}`)}
      </h2>
      <p className="xs muted">{t(`fa.${stage}.hint`)}</p>
      {r.hidden ? (
        <Hidden />
      ) : rateShown(r) ? (
        <>
          <div className="kpi-v" data-testid={`fa-${stage}-pct`}>
            {fmt.pct(r.pass_pct!)}
          </div>
          <Meter v={r.pass_pct!} label={t("fa.rateAria", { p: fmt.pct(r.pass_pct!), a: r.passed, n: r.scheduled })} good={r.pass_pct! >= 70} bad={r.pass_pct! < 50} />
          <span className="small">{t("fa.rateN", { a: fmt.num(r.passed), f: fmt.num(r.failed), n: fmt.num(r.scheduled) })}</span>
        </>
      ) : (
        <span className="small muted">{t("fa.noChecks")}</span>
      )}
    </section>
  );
}
