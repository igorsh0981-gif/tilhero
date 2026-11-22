import type { PairRoomReport } from "@tilhero/contracts/bff";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, cx, Pill, Skeleton } from "../../ui/kit";
import { Bar } from "../../ui/shell";
import { SocialError } from "./parts";

/**
 * My report of a pair lesson (APP-SOC-04/06, AT-76/77): only mine — the team (goal reached or the progress, a safe praise),
 * my role, turns, seconds of speech, minutes (counted, not charged), my lines, skills and 1–3 tips; «не участвовал» —
 * without an evaluation or rewards. The partner's lines, mistakes and evaluation are never shown. The badge «Вместе» —
 * to both when each contributed.
 */
export function PairReportScreen({ id }: { id: string }) {
  const { bff, nav, session } = useApp();
  const { t, tp, l, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const res = useLoad<PairRoomReport>(() => bff.pairReport(id), [id]);
  const r = res.data;
  const progress = r ? Math.round(Math.max(0, Math.min(1, r.team.progress)) * 100) : 0;
  return (
    <>
      <Bar title={t("prep.title")} onBack={nav.back} />
      <main className="scroll" data-testid="pair-report">
        {!r ? (
          res.loading ? <div className="pad"><Skeleton lines={4} /></div> : <SocialError error={res.error} errorObj={res.errorObj} onRetry={() => void res.reload()} service="lessons" />
        ) : (
          <div className="pad stack loose">
            <p className="sub ic-line" data-testid="prep-private"><Icon name="lock" size={16} /> {kid ? t("prep.privateKid") : t("prep.private")}</p>
            <p className="h3">{l(r.scenario.title)}</p>
            {r.end_reason ? <p className="sub small">{t(`pair.end.${r.end_reason}` as MessageKey)}</p> : null}

            <section className={cx("card stack tight", r.team.goal_reached && "ok")} aria-labelledby="prep-team" data-testid="prep-team" data-goal={r.team.goal_reached}>
              <h2 className="cap" id="prep-team">{t("prep.team")}</h2>
              <b className="h3 ic-line">
                <Icon name={r.team.goal_reached ? "trophy" : "target"} size={20} /> {r.team.goal_reached ? t("prep.goalDone") : t("prep.goalNot", { n: progress })}
              </b>
              <div className="prog" role="progressbar" aria-label={t("pair.room.goal")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={t("pair.room.progress", { n: progress })}>
                <div style={{ width: `${progress}%` }} />
              </div>
              {r.team.summary ? <p className="sub ink">{l(r.team.summary)}</p> : null}
              {r.team.goal_reached && r.me.contributed ? (
                <p className="sub ink ic-line" data-testid="prep-together"><Icon name="medal" size={16} /> {t("prep.together")}</p>
              ) : null}
            </section>

            <section className="card stack tight" aria-labelledby="prep-me" data-testid="prep-me" data-contributed={r.me.contributed}>
              <h2 className="cap" id="prep-me">{t("prep.me")}</h2>
              {r.me.role ? <b>{t("prep.role", { role: r.me.role })}</b> : null}
              {!r.me.contributed ? (
                <p className="sub ink" data-testid="prep-none">{kid ? t("prep.noContributionKid") : t("prep.noContribution")}</p>
              ) : null}
              <ul className="prep-stats">
                <li data-testid="prep-turns">{t("prep.turns", { n: r.me.turns })}</li>
                <li data-testid="prep-seconds">{t("prep.seconds", { n: r.me.speaking_seconds, w: tp("soc.secondsWord", r.me.speaking_seconds) })}</li>
                <li data-testid="prep-minutes">{t("prep.minutes", { n: r.me.minutes })}</li>
              </ul>
            </section>

            {r.me.lines.length ? (
              <section className="stack tight" aria-labelledby="prep-lines">
                <h2 className="sec" id="prep-lines">{t("prep.lines")}</h2>
                <ol className="chat" data-testid="prep-lines">
                  {r.me.lines.map((x, i) => (
                    <li key={i} className="bub me" lang="en">
                      {x.text}
                      <small>{fmt.dateTime(x.at)}</small>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            {r.me.skills.length ? (
              <section className="stack tight" aria-labelledby="prep-skills">
                <h2 className="sec" id="prep-skills">{t("prep.skills")}</h2>
                <div className="pills" data-testid="prep-skills">
                  {r.me.skills.map((s) => <Pill key={s.skill_id}>{l(s.title)}</Pill>)}
                </div>
              </section>
            ) : null}

            {r.me.tips.length ? (
              <section className="card pen stack tight" aria-labelledby="prep-tips" data-testid="prep-tips">
                <h2 className="sec" id="prep-tips">{t("prep.tips")}</h2>
                {r.me.tips.slice(0, 3).map((tip, i) => <p key={i} className="sub ink">{l(tip)}</p>)}
              </section>
            ) : null}

            {r.me.contributed ? <p className="sub small" data-testid="prep-eval">{r.me.evaluation_id ? t("prep.evaluation") : t("prep.evalPending")}</p> : null}
            {r.me.contributed && r.me.evaluation_id && !kid ? (
              <Btn variant="link" onClick={() => nav.goTab("progress")} data-testid="prep-skills-link">
                <Icon name="map" size={16} />
                {t("home.skills")}
              </Btn>
            ) : null}
          </div>
        )}
      </main>
    </>
  );
}
