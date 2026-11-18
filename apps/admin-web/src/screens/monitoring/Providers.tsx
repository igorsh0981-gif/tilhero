import { useCallback, useEffect, useState } from "react";
import type { ProblemFeeds, ProviderHealth, ProviderHistory } from "@tilhero/contracts/admin";
import { OpsApi } from "../../api/endpoints";
import { useI18n, type MessageKey } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, Pill, Seg, Spinner } from "../../ui/kit";
import { Drawer } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errMeta, errText } from "../../ui/errors";
import { feedCodeLabel } from "../news/news";
import { HistoryChart } from "./Chart";
import type { MonShared } from "./Monitoring";
import { quotaTone, ratePct, rateTone, rowSev, sortProviders, STATUS_ICON, STATUS_TONE, topClasses, ERROR_CLASSES, msParts } from "./ops";

/** provider title in the UI language (ops-monitor gives a Russian title; unknown providers keep it) */
export function useProviderTitle() {
  const { t, lang } = useI18n();
  return (id: string, title?: string | null) => {
    const key = `mon.prov.${id}` as MessageKey;
    const tr = t(key);
    return tr !== key ? tr : lang === "ru" && title ? title : (title ?? id);
  };
}

export function MsText({ ms }: { ms: number | null | undefined }) {
  const { t, fmt } = useI18n();
  const p = msParts(ms);
  if (!p) return <>—</>;
  return <>{p.unit === "ms" ? t("ai.ms", { n: fmt.num(p.v) }) : t("ai.sec", { n: fmt.num(p.v, 1) })}</>;
}

/** status: colour + icon + word (never colour alone) */
export function StatusPill({ s, testId }: { s: ProviderHealth["status"]; testId?: string }) {
  const { t } = useI18n();
  return (
    <span className={cx("pill", STATUS_TONE[s] !== "neutral" && STATUS_TONE[s], "mon-status")} data-testid={testId} data-status={s}>
      <Icon name={STATUS_ICON[s]} />
      {t(`mon.st.${s}`)}
    </span>
  );
}

export function ProvidersTab({ shared, provider, onOpen }: { shared: MonShared; provider: string | null; onOpen: (p: string | null) => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const title = useProviderTitle();
  const toast = useToast();
  const [probing, setProbing] = useState<string | null>(null);
  const items = shared.providers;
  const stale = items?.find((p) => p.stale_since);
  const probe = async (p: ProviderHealth) => {
    setProbing(p.provider);
    try {
      const r = await OpsApi.probe(p.provider);
      toast(
        r.probe.ok ? t("mon.probe.ok", { p: title(p.provider, p.title), ms: r.probe.latency_ms ?? "—" }) : t("mon.probe.fail", { p: title(p.provider, p.title), code: r.probe.code ?? r.probe.reason ?? "—" }),
        r.probe.ok ? "ok" : "err",
        r.probe.http_status ? `HTTP ${r.probe.http_status}` : undefined,
      );
      shared.reload(true);
    } catch (e) {
      toast(errText(i, e), "err", errMeta(e));
    } finally {
      setProbing(null);
    }
  };
  const open = items?.find((p) => p.provider === provider) ?? null;

  return (
    <div data-testid="mon-providers">
      {shared.errors.providers && items ? (
        <div className="mb-12">
          <Callout kind="warn" icon="alert" testId="mon-prov-stale-load">
            <b>{t("mon.staleLoad")}</b> {errText(i, shared.errors.providers)}
          </Callout>
        </div>
      ) : null}
      {stale && (
        <div className="mb-12">
          <Callout kind="warn" icon="clock" testId="mon-gw-stale">
            {t("mon.gwStale", { t: fmt.dateTime(stale.stale_since) })}
          </Callout>
        </div>
      )}
      {!items ? (
        shared.errors.providers ? (
          <LoadError error={shared.errors.providers} onRetry={() => shared.reload()} testId="mon-prov-error" />
        ) : (
          <Spinner label={t("common.loading")} />
        )
      ) : !items.length ? (
        <section className="panel">
          <Empty icon="zap" title={t("mon.prov.emptyT")} text={t("mon.prov.emptyM")} />
        </section>
      ) : (
        <section className="panel" aria-labelledby="mon-prov-h">
          <div className="panel-h">
            <h2 className="panel-t" id="mon-prov-h">
              <Icon name="zap" />
              {t("mon.prov.t")}
            </h2>
            <span className="panel-sub">{t("mon.prov.sub")}</span>
          </div>
          <div className="table-wrap">
            <table className="tbl mon-prov-tbl">
              <thead>
                <tr>
                  <th>{t("mon.col.provider")}</th>
                  <th>{t("mon.col.status")}</th>
                  <th className="num">{t("mon.col.callsErr")}</th>
                  <th className="num">p50 / p95</th>
                  <th>{t("mon.col.byClass")}</th>
                  <th className="num">{t("mon.col.route")}</th>
                  <th>{t("mon.col.quota")}</th>
                  <th className="act" aria-label={t("common.actions")} />
                </tr>
              </thead>
              <tbody>
                {sortProviders(items).map((p) => {
                  const w = p.window;
                  const tc = topClasses(w.by_class);
                  return (
                    <tr
                      key={p.provider}
                      className={cx("is-click", rowSev(p.status))}
                      tabIndex={0}
                      onClick={() => onOpen(p.provider)}
                      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen(p.provider)}
                      data-testid="mon-prov-row"
                      data-provider={p.provider}
                    >
                      <td>
                        <b>{title(p.provider, p.title)}</b>
                        <span className="block xs muted mono">{p.provider}</span>
                      </td>
                      <td>
                        <StatusPill s={p.status} testId="mon-prov-status" />
                        <span className="block xs muted nowrap">
                          {p.status_since && t("mon.since", { t: fmt.rel(p.status_since) })}
                          {p.breaker && p.breaker !== "closed" && (
                            <>
                              {" · "}
                              <span className={cx("mono", p.breaker === "open" ? "txt-bad" : "txt-warn")} title={t("mon.col.breaker")}>
                                breaker {p.breaker.toUpperCase()}
                              </span>
                            </>
                          )}
                        </span>
                      </td>
                      <td className="num nowrap">
                        {fmt.num(w.calls)} · <span className={cx("mon-rate", `tone-${rateTone(w.error_rate, w.calls)}`)}>{w.calls ? fmt.pct(ratePct(w.error_rate)!) : "—"}</span>
                        <span className="block xs muted">
                          {t("mon.day", { n: `${fmt.num(p.last_24h.calls)} · ${fmt.pct(ratePct(p.last_24h.error_rate)!)}` })}
                        </span>
                      </td>
                      <td className="num nowrap">
                        <MsText ms={w.p50_ms} /> / <MsText ms={w.p95_ms} />
                      </td>
                      <td>
                        {tc.length ? (
                          <span className="mon-classes">
                            {tc.map((c) => (
                              <span key={c.k} className="tag" title={t(`mon.cls.${c.k}.h`)}>
                                {t(`mon.cls.${c.k}`)} <b>{fmt.num(c.v)}</b>
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="xs muted">{w.calls ? t("mon.noErrors") : "—"}</span>
                        )}
                        {p.last_error && (
                          <span className="block xs muted mon-lasterr" title={p.last_error.message ?? undefined}>
                            {p.last_error.code ?? p.last_error.reason} · {fmt.rel(p.last_error.at)}
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {p.last_24h.route_unsupported ? (
                          <>
                            <b>{fmt.num(p.last_24h.route_unsupported)}</b>
                            {w.route_top[0] && <span className="block xs muted mono">{w.route_top.map((r) => `${r.location}×${r.count}`).slice(0, 2).join(" ")}</span>}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="mon-quota-cell">
                        {p.quota ? (
                          <>
                            <span className={cx("mon-meter", `is-${quotaTone(p.quota.pct)}`)} role="meter" aria-label={t("mon.col.quota")} aria-valuemin={0} aria-valuemax={p.quota.limit} aria-valuenow={p.quota.used}>
                              <i style={{ width: `${Math.min(100, p.quota.pct)}%` }} />
                            </span>
                            <span className="xs muted">
                              {fmt.pct(p.quota.pct, 0)} · {fmt.num(p.quota.used)} / {fmt.num(p.quota.limit)}
                            </span>
                          </>
                        ) : (
                          <span className="xs muted">—</span>
                        )}
                      </td>
                      <td className="act" onClick={(e) => e.stopPropagation()}>
                        {p.probe_supported ? (
                          <Btn size="xs" kind="ghost" icon="refresh" aria={`${t("mon.probe")}: ${title(p.provider, p.title)}`} title={t("mon.probe")} busy={probing === p.provider} onClick={() => void probe(p)} testId="mon-probe" />
                        ) : (
                          <span className="xs muted" title={t("mon.probe.noH")} data-testid="mon-probe-no">
                            <span aria-hidden="true">—</span>
                            <span className="sr-only">{t("mon.probe.no")}</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="panel-f ai-foot">
            <Icon name="info" />
            <span>
              {t("mon.prov.foot")} {t("mon.foot")}
            </span>
          </div>
        </section>
      )}
      <FeedsPanel />
      {open && <ProviderDrawer p={open} onClose={() => onOpen(null)} onProbe={() => void probe(open)} probing={probing === open.provider} />}
    </div>
  );
}

function ProviderDrawer({ p, onClose, onProbe, probing }: { p: ProviderHealth; onClose: () => void; onProbe: () => void; probing: boolean }) {
  const i = useI18n();
  const { t, fmt } = i;
  const title = useProviderTitle();
  const [range, setRange] = useState<"24h" | "7d">("24h");
  const [h, setH] = useState<ProviderHistory | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async (r: "24h" | "7d") => {
    setH(null);
    try {
      setH(await OpsApi.history(p.provider, r));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [p.provider]);
  useEffect(() => void load(range), [load, range]);
  const w = p.window;
  return (
    <Drawer
      wide
      title={title(p.provider, p.title)}
      sub={
        <>
          <span className="mono">{p.provider}</span>
          <StatusPill s={p.status} />
          {p.status_since && <span>{t("mon.since", { t: fmt.dateTime(p.status_since) })}</span>}
        </>
      }
      onClose={onClose}
      testId="mon-prov-drawer"
      footer={
        <>
          <Btn label={t("common.close")} onClick={onClose} />
          <span className="grow" />
          {p.probe_supported ? (
            <Btn kind="primary" icon="refresh" label={t("mon.probeNow")} busy={probing} onClick={onProbe} testId="mon-drawer-probe" />
          ) : (
            <span className="xs muted">{t("mon.probe.noH")}</span>
          )}
        </>
      }
    >
      <div className="stack">
        {p.open_alerts.length > 0 && (
          <Callout kind={p.open_alerts.some((a) => a.severity === "critical") ? "bad" : "warn"} icon="bell">
            {p.open_alerts.map((a) => t(`mon.ak.${a.kind}`)).join(" · ")}
          </Callout>
        )}
        <div className="statband mon-dkpis">
          <Kpi2 label={t("mon.w.calls")} value={fmt.num(w.calls)} sub={t("mon.day", { n: fmt.num(p.last_24h.calls) })} />
          <Kpi2 label={t("mon.w.errors")} value={w.calls ? fmt.pct(ratePct(w.error_rate)!) : "—"} sub={t("mon.day", { n: fmt.pct(ratePct(p.last_24h.error_rate)!) })} tone={rateTone(w.error_rate, w.calls)} />
          <Kpi2 label="p50 / p95" value={<><MsText ms={w.p50_ms} /> / <MsText ms={w.p95_ms} /></>} sub={<>{t("mon.day24")} p95 <MsText ms={p.last_24h.p95_ms} /></>} />
          <Kpi2 label={t("mon.w.route")} value={fmt.num(w.route_unsupported)} sub={t("mon.day", { n: fmt.num(p.last_24h.route_unsupported) })} />
        </div>
        <p className="xs muted">{t("mon.w.note", { n: w.minutes })}</p>

        <section className="mon-sec" aria-labelledby="mon-hist-h">
          <div className="mon-sec-h">
            <h3 id="mon-hist-h">{t("mon.hist")}</h3>
            <span className="grow" />
            <Seg label={t("mon.hist")} value={range} onChange={setRange} testId="mon-range" items={[{ v: "24h", label: t("mon.r24") }, { v: "7d", label: t("mon.r7") }]} />
          </div>
          {error ? <LoadError error={error} onRetry={() => void load(range)} /> : !h ? <Spinner label={t("common.loading")} /> : !h.points.length ? <Empty icon="activity" title={t("mon.hist.emptyT")} text={t("mon.hist.emptyM")} /> : <HistoryChart h={h} />}
        </section>

        <div className="grid-2">
          <section className="mon-sec" aria-labelledby="mon-cls-h">
            <h3 id="mon-cls-h">{t("mon.byClass")}</h3>
            <ul className="mon-cls-list" data-testid="mon-cls-list">
              {ERROR_CLASSES.map((k) => (
                <li key={k} className={cx(!w.by_class[k] && "is-zero")}>
                  <span className="grow">
                    {t(`mon.cls.${k}`)}
                    <span className="block xs muted">{t(`mon.cls.${k}.h`)}</span>
                  </span>
                  <b className="mono">{fmt.num(w.by_class[k] ?? 0)}</b>
                </li>
              ))}
            </ul>
          </section>
          <section className="mon-sec" aria-labelledby="mon-route-h">
            <h3 id="mon-route-h">{t("mon.route.t")}</h3>
            <p className="xs muted">{t("mon.route.m")}</p>
            {(h?.route_top.length ?? 0) || w.route_top.length ? (
              <ul className="mon-route-list" data-testid="mon-route-top">
                {(h?.route_top.length ? h.route_top : w.route_top).map((r) => (
                  <li key={r.location}>
                    <span className="mono">{r.location === "_other" ? t("mon.route.other") : r.location}</span>
                    <span className="grow mon-route-bar">
                      <i style={{ width: `${(r.count / Math.max(1, (h?.route_top[0] ?? w.route_top[0])!.count)) * 100}%` }} />
                    </span>
                    <b className="mono">{fmt.num(r.count)}</b>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">{t("mon.route.none")}</p>
            )}
            {p.last_route_error && (
              <p className="xs muted">
                {t("mon.route.last", { code: p.last_route_error.location ?? "—", route: p.last_route_error.route ?? "—", t: fmt.rel(p.last_route_error.at) })}
              </p>
            )}
          </section>
        </div>

        <div className="grid-2">
          <section className="mon-sec">
            <h3>{t("mon.transitions")}</h3>
            {h?.transitions.length ? (
              <ol className="mon-trans" data-testid="mon-transitions">
                {[...h.transitions].reverse().slice(0, 12).map((x) => (
                  <li key={x.at + x.to}>
                    <span className="xs muted nowrap">{fmt.dateTime(x.at)}</span>
                    <StatusPill s={x.from} /> <Icon name="right" /> <StatusPill s={x.to} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="small muted">{h ? t("mon.transitions.none") : "…"}</p>
            )}
          </section>
          <section className="mon-sec">
            <h3>{t("mon.last")}</h3>
            <dl className="kv">
              <dt>{t("mon.lastError")}</dt>
              <dd data-testid="mon-last-error">
                {p.last_error ? (
                  <>
                    <span className="mono">{p.last_error.code ?? "—"}</span>
                    {p.last_error.reason && <span className="xs muted"> · {p.last_error.reason}</span>}
                    {p.last_error.http_status && <span className="xs muted"> · HTTP {p.last_error.http_status}</span>}
                    {p.last_error.message && <span className="block small">«{p.last_error.message}»</span>}
                    <span className="block xs muted">{fmt.dateTime(p.last_error.at)}</span>
                  </>
                ) : (
                  "—"
                )}
              </dd>
              <dt>{t("mon.lastProbe")}</dt>
              <dd>
                {p.last_probe ? (
                  <>
                    <Pill tone={p.last_probe.ok ? "good" : "bad"}>{p.last_probe.ok ? t("mon.probe.okShort") : t("mon.probe.failShort")}</Pill> <MsText ms={p.last_probe.latency_ms} />
                    {p.last_probe.code && <span className="mono xs"> · {p.last_probe.code}</span>}
                    <span className="block xs muted">{fmt.dateTime(p.last_probe.at)}</span>
                  </>
                ) : (
                  <span className="xs muted">{p.probe_supported ? t("mon.probe.never") : t("mon.probe.noH")}</span>
                )}
              </dd>
              <dt>{t("mon.col.breaker")}</dt>
              <dd className="mono">{p.breaker?.toUpperCase() ?? "—"}</dd>
              <dt>{t("mon.col.quota")}</dt>
              <dd>{p.quota ? `${fmt.num(p.quota.used)} / ${fmt.num(p.quota.limit)} · ${fmt.pct(p.quota.pct, 0)}` : "—"}</dd>
            </dl>
          </section>
        </div>
      </div>
    </Drawer>
  );
}

function Kpi2({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className={cx("stat", tone === "bad" && "is-bad", tone === "warn" && "is-warn")}>
      <div className="stat-l">
        <span className="stat-ln">{label}</span>
      </div>
      <div className="stat-v">{value}</div>
      {sub != null && <div className="stat-s">{sub}</div>}
    </div>
  );
}

export function FeedsPanel() {
  const i = useI18n();
  const { t, fmt } = i;
  const [f, setF] = useState<ProblemFeeds | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setF(await OpsApi.feeds());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => void load(), [load]);
  return (
    <section className="panel mt-16" aria-labelledby="mon-feeds-h" data-testid="mon-feeds">
      <div className="panel-h">
        <h2 className="panel-t" id="mon-feeds-h">
          <Icon name="rss" />
          {t("mon.feeds.t")}
        </h2>
        <span className="panel-sub">{t("mon.feeds.sub")}</span>
        <span className="grow" />
        {f?.checked_at && <span className="xs muted">{t("mon.checked", { t: fmt.rel(f.checked_at) })}</span>}
      </div>
      {error ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !f ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <>
          {!f.available && (
            <div className="panel-b">
              <Callout kind="warn" icon="alert">
                {t("mon.feeds.down")}
              </Callout>
            </div>
          )}
          {!f.items.length ? (
            <Empty icon="checkCircle" title={t("mon.feeds.emptyT")} text={t("mon.feeds.emptyM")} testId="mon-feeds-empty" />
          ) : (
            <div className="table-wrap">
              <table className="tbl compact">
                <thead>
                  <tr>
                    <th>{t("mon.feeds.col.feed")}</th>
                    <th>{t("mon.feeds.col.error")}</th>
                    <th>{t("mon.feeds.col.ok")}</th>
                  </tr>
                </thead>
                <tbody>
                  {f.items.map((x) => (
                    <tr key={x.source_id} data-testid="mon-feed-row">
                      <td>
                        <b>{x.name ?? x.slug ?? x.source_id}</b>
                        <span className="block xs muted mono">
                          {x.domain ?? "—"}
                          {x.country_code && ` · ${x.country_code}`}
                        </span>
                      </td>
                      <td>
                        {x.last_error ? (
                          <>
                            <span className="small">{x.last_error.code ? feedCodeLabel(t, x.last_error.code) : "—"}</span>
                            {x.last_error.code && <span className="block xs muted mono">{x.last_error.code}</span>}
                            <span className="block xs muted">{fmt.rel(x.last_error.at)}</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="small">{x.last_ok_at ? fmt.rel(x.last_ok_at) : t("mon.feeds.never")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
