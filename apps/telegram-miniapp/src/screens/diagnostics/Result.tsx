import type { AreaResult, DiagnosticArea, DiagnosticResult } from "@tilhero/contracts/bff";
import type { Band } from "@tilhero/contracts/content";
import { BAND_LIST, bandIndex, confidenceLevel, evidenceRows, followupUntil, hasAssessedArea, orderedAreas } from "../../domain/diagnostics";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, Margin, Pill } from "../../ui/kit";
import { Bar } from "../../ui/shell";

/**
 * Result of the placement test (AT-33): provisional level or «недостаточно данных», areas with the band scale, the
 * confidence in words and dots, «почему так» (how many items of each band were answered and how many right — never the
 * items themselves or a mark per item: the result must not reveal the keys of the bank), not assessed areas with the
 * reason, weak areas, the recommended start, the explicit «не сертификат CEFR», follow-up for an uncertain area
 * (24 h), «Пройти снова» with the date, and the history of results.
 */
export function ResultView(props: {
  result: DiagnosticResult;
  nextAllowedAt: string | null;
  /** follow-up and retake are offered only for the current result */
  actions: boolean;
  busyArea?: boolean;
  retakeBusy?: boolean;
  actionError?: string | null;
  onFollowup?: (area: DiagnosticArea) => void;
  onRetake?: () => void;
}) {
  const { result } = props;
  const { bff, nav, session } = useApp();
  const { t, fmt, l } = useI18n();
  const kid = session.learner.kind === "child";
  const history = useLoad(() => bff.diagnosticResults(), [result.result_id, result.revision]);
  const areas = orderedAreas(result.areas);
  const lvl = result.provisional_level;
  const retakeOk = !props.nextAllowedAt || Date.parse(props.nextAllowedAt) <= Date.now();
  const byArea = new Map(result.areas.map((a) => [a.area, a]));

  return (
    <main className="scroll" data-testid="dx-result">
      <div className="stack loose">
        <div className="pad stack tight">
          <div className="cap">
            {t("dxr.title")} · {fmt.date(result.created_at)}
            {result.revision > 1 ? ` · ${t("dxr.revised")}` : ""}
          </div>
          {kid ? <p className="sub ink">{t("dxr.levelKid")}</p> : null}
          <h1 className="h1" data-testid="dx-level">{lvl ? t("dxr.level", { band: lvl }) : t("dxr.levelNone")}</h1>
          <p className="sub">{lvl ? `${lvl} — ${t(`band.${lvl}` as MessageKey)}` : t("dxr.levelNoneText")}</p>
        </div>

        <div className="pad">
          <div className="card warn cert" role="note" data-testid="not-cefr">
            <Icon name="shield" size={20} />
            <p className="sub ink">{t("dxr.notCert")}</p>
          </div>
        </div>

        <section className="stack" aria-labelledby="dxr-areas">
          <div className="pad">
            <h2 className="sec" id="dxr-areas">{t("dxr.areas")}</h2>
          </div>
          {areas.map((a) => (
            <AreaCard key={a.area} result={result} area={a} kid={kid} actions={props.actions} busy={!!props.busyArea} onFollowup={props.onFollowup} />
          ))}
          {props.actionError ? (
            <div className="pad">
              <ErrorLine text={props.actionError} />
            </div>
          ) : null}
        </section>

        <section className="pad stack tight" aria-labelledby="dxr-weak" data-testid="dx-weak">
          <h2 className="sec" id="dxr-weak">{t("dxr.weak")}</h2>
          {result.weak_areas.length ? (
            <div className="list">
              {result.weak_areas.map((w) => {
                const a = byArea.get(w);
                return (
                  <div className="row" key={w}>
                    <span className="t">
                      <b>{a?.status === "not_assessed" ? t("dxr.weakNotAssessed", { area: t(`area.${w}` as MessageKey) }) : t(`area.${w}` as MessageKey)}</b>
                    </span>
                    {a?.band ? <Pill tone="warn">{a.band}</Pill> : <Pill tone="mute">—</Pill>}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="sub">{t("dxr.weakNone")}</p>
          )}
        </section>

        <Margin note={t("dxr.startNote")} tilt>
          <section className="card lift stack tight" aria-labelledby="dxr-start" data-testid="dx-start-lesson">
            <div className="cap" id="dxr-start">{t("dxr.start")}</div>
            {result.recommended_start ? (
              <h2 className="h2">
                {l(result.recommended_start.title)} <Pill>{result.recommended_start.level}</Pill>
              </h2>
            ) : (
              <h2 className="h2">{t("dxr.startFirst")}</h2>
            )}
            <p className="sub">{t("dxr.startText")}</p>
            <Btn onClick={() => nav.push({ name: "plan" })} data-testid="dx-open-plan">
              <Icon name="route" size={18} />
              {t("dxr.openPlan")}
            </Btn>
          </section>
        </Margin>

        {props.actions ? (
          <div className="pad stack tight">
            {retakeOk ? (
              <Btn variant="secondary" busy={props.retakeBusy} onClick={props.onRetake} data-testid="retake">
                {t("dxr.retake")}
              </Btn>
            ) : (
              <>
                <Btn variant="secondary" disabled aria-describedby="retake-note" data-testid="retake">
                  {t("dxr.retake")}
                </Btn>
                <p className="sub ink" id="retake-note" role="status" data-testid="retake-note">
                  {hasAssessedArea(result) ? t("dxr.retakeAt", { date: fmt.date(props.nextAllowedAt!) }) : t("dx.tooManyUnfinished", { date: fmt.date(props.nextAllowedAt!) })}
                </p>
              </>
            )}
            <p className="sub small">{t("dxr.retakeNote")}</p>
          </div>
        ) : null}

        {history.data && history.data.items.length ? (
          <section className="pad stack tight" aria-labelledby="dxr-history" data-testid="dx-history">
            <h2 className="sec" id="dxr-history">{t("dxr.history")}</h2>
            <div className="list">
              {history.data.items.map((r) => {
                const current = r.result_id === result.result_id;
                const label = `${fmt.date(r.created_at)} · ${r.provisional_level ? t("dxr.historyLevel", { band: r.provisional_level }) : t("dxr.historyNoLevel")}`;
                const badges = (
                  <>
                    {r.revision > 1 ? <Pill tone="mute">{t("dxr.revised")}</Pill> : null}
                    {current ? <Pill tone="ok">{t("dxr.current")}</Pill> : null}
                  </>
                );
                return current ? (
                  <div className="row" key={r.result_id}>
                    <span className="t"><b>{label}</b></span>
                    {badges}
                  </div>
                ) : (
                  <button type="button" className="row" key={r.result_id} onClick={() => nav.push({ name: "diagResult", result: r })}>
                    <span className="t"><b>{label}</b></span>
                    {badges}
                    <Icon name="chevron" size={18} stroke={2} />
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function reasonKey(a: AreaResult): MessageKey {
  if (a.reason === "not_in_test_yet") return a.area === "writing" ? "dxr.reason.writing" : "dxr.reason.speaking";
  if (a.reason === "no_speech_voice") return "dxr.reason.no_speech_voice";
  return "dxr.reason.too_few_items";
}

function AreaCard(props: {
  result: DiagnosticResult;
  area: AreaResult;
  kid: boolean;
  actions: boolean;
  busy: boolean;
  onFollowup?: (area: DiagnosticArea) => void;
}) {
  const { area: a } = props;
  const { t, fmt } = useI18n();
  const assessed = a.status === "assessed" && a.band;
  const conf = confidenceLevel(a.confidence);
  const until = props.actions ? followupUntil(props.result, a) : null;
  const rows = evidenceRows(a.evidence);
  const headId = `area-h-${a.area}`;
  return (
    <div className="pad">
      <section className="card area" aria-labelledby={headId} data-testid={`area-${a.area}`} data-status={a.status}>
        <div className="area-h">
          <h3 className="h3" id={headId}>{t(`area.${a.area}` as MessageKey)}</h3>
          {assessed ? <Pill>{a.band}</Pill> : <Pill tone="mute">{t("dxr.notAssessed")}</Pill>}
        </div>
        {assessed ? (
          <>
            <BandScale band={a.band!} />
            {conf ? (
              <span className="conf" role="img" aria-label={t("dxr.confAria", { level: t(`dxr.conf.${conf.level}` as MessageKey), n: conf.dots })} data-testid={`conf-${a.area}`}>
                {[1, 2, 3].map((i) => (
                  <i key={i} className={cx(i <= conf.dots && "on")} />
                ))}
                <span aria-hidden="true">{t(`dxr.conf.${conf.level}` as MessageKey)}</span>
              </span>
            ) : null}
          </>
        ) : (
          <p className="sub" data-testid={`reason-${a.area}`}>{t(reasonKey(a))}</p>
        )}
        {until && props.onFollowup ? (
          <div className="stack tight">
            <p className="sub small">{t("dxr.followupNote", { time: fmt.dateTime(until.toISOString()) })}</p>
            <Btn variant="secondary" busy={props.busy} onClick={() => props.onFollowup!(a.area)} data-testid={`followup-${a.area}`}>
              <Icon name="target" size={18} />
              {t("dxr.followup")}
            </Btn>
          </div>
        ) : null}
        {assessed ? (
          <details className="why" data-testid={`why-${a.area}`}>
            <summary>{t("dxr.why")}</summary>
            {rows.length ? (
              <div className="stack tight">
                <ul className="stack tight" aria-label={t("dxr.why")}>
                  {rows.map((r) => (
                    <li className="evb" key={r.band} data-testid={`why-${a.area}-${r.band}`}>
                      <span className="grow stack tight">
                        <span className="sub ink">{t("dxr.whyBand", { band: r.band, c: r.correct, n: r.answered })}</span>
                        <span className="prog" aria-hidden="true">
                          <span style={{ width: `${r.pct}%` }} />
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="sub small" data-testid={`why-how-${a.area}`}>{props.kid ? t("dxr.whyHowKid") : t("dxr.whyHow")}</p>
              </div>
            ) : (
              <p className="sub small">{t("dxr.whyNone")}</p>
            )}
          </details>
        ) : null}
      </section>
    </div>
  );
}

export function BandScale({ band }: { band: Band }) {
  const { t } = useI18n();
  const idx = bandIndex(band);
  return (
    <div className="bands" role="img" aria-label={t("dxr.scaleAria", { band })}>
      {BAND_LIST.map((b, i) => (
        <span key={b} className={cx(i <= idx && "on", i === idx && "cur")} aria-hidden="true">
          {b}
        </span>
      ))}
    </div>
  );
}

/** A result from the history (read-only: follow-up and retake are offered on the current one). */
export function DiagResultScreen({ result }: { result: DiagnosticResult }) {
  const { nav } = useApp();
  const { t } = useI18n();
  return (
    <>
      <Bar title={t("dxr.title")} onBack={nav.back} />
      <div className="dx dx-wrap">
        <ResultView result={result} nextAllowedAt={null} actions={false} />
      </div>
    </>
  );
}
