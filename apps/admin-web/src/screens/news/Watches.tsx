import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { WatchStats } from "@tilhero/contracts/admin";
import { WatchApi } from "../../api/endpoints";
import { useI18n } from "../../i18n";
import { Icon, type IconName } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Spinner } from "../../ui/kit";
import { errText } from "../../ui/errors";
import { NOTIFY_KINDS, WATCH_CHANGE_TYPES, watchTotals } from "./news";

/** background refresh (does not extend the idle session) */
export const WATCH_POLL_MS = 60_000;

const CHANGE_ICON: Record<string, IconName> = { price_drop: "trendDown", price_rise: "up", lifecycle: "calendar", tickets: "ticket", flight: "plane", hotel: "bed" };

/** «Watches» (dashboard.read): active and paused watches, rechecks, detected changes and notifications in 24 h. */
export function WatchesPage() {
  const i = useI18n();
  const { t, fmt } = i;
  const [stats, setStats] = useState<WatchStats | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [staleErr, setStaleErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const has = useRef(false);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    try {
      const s = await WatchApi.stats(background);
      has.current = true;
      setStats(s);
      setError(null);
      setStaleErr(null);
      setUpdatedAt(new Date().toISOString());
    } catch (e) {
      if (has.current) setStaleErr(e);
      else setError(e);
    } finally {
      if (!background) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(true), WATCH_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const tot = stats ? watchTotals(stats) : null;
  const maxChange = stats ? Math.max(1, ...WATCH_CHANGE_TYPES.map((k) => stats.changes_24h[k])) : 1;
  const notifyTotal = stats ? NOTIFY_KINDS.reduce((a, k) => a + stats.notifications_24h[k], 0) : 0;

  return (
    <div data-testid="watches" aria-busy={loading}>
      <div className="page-head">
        <div className="lead">
          <p>{t("wch.lead")}</p>
        </div>
        <div className="acts">
          {updatedAt && (
            <span className="dash-updated" data-testid="wch-updated">
              {t("common.updated")} {fmt.time(updatedAt)}
            </span>
          )}
          <Btn kind="ghost" icon="refresh" label={t("common.refresh")} busy={loading && !!stats} onClick={() => void load()} testId="wch-refresh" />
        </div>
      </div>
      {error ? (
        <LoadError error={error} onRetry={() => void load()} testId="wch-error" />
      ) : !stats || !tot ? (
        <section className="panel">
          <Spinner label={t("common.loading")} />
        </section>
      ) : (
        <>
          {staleErr ? (
            <div className="mb-12">
              <Callout kind="warn" icon="alert" testId="wch-stale">
                <b>{t("trv.stale")}</b> {errText(i, staleErr)}
              </Callout>
            </div>
          ) : null}
          <div className="wch-kpis" data-testid="wch-kpis">
            <Kpi icon="radar" label={t("wch.active")} value={fmt.num(stats.active)} sub={t("wch.paused", { n: fmt.num(stats.paused) })} testId="wch-active" />
            <Kpi icon="refresh" label={t("wch.rechecks")} value={fmt.num(stats.rechecks_24h)} sub={stats.next_batch_at ? t("wch.next", { t: fmt.time(stats.next_batch_at) }) : t("wch.nextUnknown")} testId="wch-rechecks" />
            <Kpi icon="activity" label={t("wch.changes")} value={fmt.num(tot.changes)} sub={t("wch.notified", { n: fmt.num(tot.notified) })} testId="wch-changes" />
            <Kpi
              icon="alertCircle"
              label={t("wch.errors")}
              value={fmt.num(stats.errors_24h)}
              sub={tot.errorRate != null ? t("wch.errorRate", { p: fmt.pct(tot.errorRate * 100, 1) }) : t("wch.noRechecks")}
              tone={stats.errors_24h > 0 ? (tot.errorRate != null && tot.errorRate >= 0.1 ? "bad" : "warn") : undefined}
              testId="wch-errors"
            />
            <Kpi icon="clock" label={t("wch.ended")} value={fmt.num(stats.ended_24h)} sub={t("wch.endedH")} testId="wch-ended" />
          </div>
          <div className="wch-grid">
            <section className="panel" aria-labelledby="wch-ch-h" data-testid="wch-changes-panel">
              <div className="panel-h">
                <h2 className="panel-t" id="wch-ch-h">
                  <Icon name="activity" />
                  {t("wch.changesT")}
                </h2>
              </div>
              <ul className="wch-bars">
                {WATCH_CHANGE_TYPES.map((k) => {
                  const n = stats.changes_24h[k];
                  return (
                    <li key={k} data-change={k} className={cx(n === 0 && "is-zero")}>
                      <span className="wch-bar-l">
                        <Icon name={CHANGE_ICON[k] ?? "activity"} />
                        <span>
                          {t(`wch.ch.${k}`)}
                          <span className="xs muted block">{t(`wch.ch.${k}.h`)}</span>
                        </span>
                      </span>
                      <span className="crawl-bar wch-bar" aria-hidden="true">
                        <span className={`is-${k}`} style={{ width: n ? `${Math.max(4, Math.round((n / maxChange) * 100))}%` : 0 }} />
                      </span>
                      <span className="wch-bar-n mono">{fmt.num(n)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section className="panel" aria-labelledby="wch-nt-h" data-testid="wch-notify-panel">
              <div className="panel-h">
                <h2 className="panel-t" id="wch-nt-h">
                  <Icon name="bell" />
                  {t("wch.notifyT")}
                </h2>
              </div>
              <div className="wch-stack" role="img" aria-label={NOTIFY_KINDS.map((k) => `${t(`wch.nt.${k}`)}: ${stats.notifications_24h[k]}`).join(", ")}>
                {notifyTotal > 0 ? (
                  NOTIFY_KINDS.map((k) => (stats.notifications_24h[k] ? <span key={k} className={`is-${k}`} style={{ flexGrow: stats.notifications_24h[k] }} /> : null))
                ) : (
                  <span className="is-empty" />
                )}
              </div>
              <ul className="wch-legend">
                {NOTIFY_KINDS.map((k) => (
                  <li key={k} data-notify={k}>
                    <i className={`dot is-${k}`} aria-hidden="true" />
                    <span className="grow">
                      <b>{t(`wch.nt.${k}`)}</b>
                      <span className="xs muted block">{t(`wch.nt.${k}.h`)}</span>
                    </span>
                    <span className="mono wch-bar-n">{fmt.num(stats.notifications_24h[k])}</span>
                  </li>
                ))}
              </ul>
              <p className="xs muted wch-note">
                <Icon name="info" /> {t("wch.dedupNote")}
              </p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ icon, label, value, sub, tone, testId }: { icon: IconName; label: string; value: ReactNode; sub?: ReactNode; tone?: "warn" | "bad"; testId?: string }) {
  return (
    <section className={cx("panel wch-kpi", tone && `is-${tone}`)} data-testid={testId}>
      <div className="wch-kpi-l">
        <Icon name={icon} />
        {label}
      </div>
      <div className="wch-kpi-v">{value}</div>
      {sub != null && <div className="xs muted">{sub}</div>}
    </section>
  );
}
