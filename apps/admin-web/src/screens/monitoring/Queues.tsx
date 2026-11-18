import { useCallback, useEffect, useState } from "react";
import type { OutboxInfo, ServiceReady, StreamInfo } from "@tilhero/contracts/admin";
import { OpsApi } from "../../api/endpoints";
import { useI18n } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, Pill, Spinner } from "../../ui/kit";
import { errText } from "../../ui/errors";
import type { MonShared } from "./Monitoring";
import { ageParts, CONSUMER_TONE, sizeParts, snapshotStale, STALLED_S } from "./ops";
import { MsText } from "./Providers";

/** «данные устарели»: снимок ops-monitor не обновлялся (ops-monitor говорит stale или checked_at давно) */
function StaleTag({ x, testId }: { x: { stale: boolean | null; checked_at: string | null }; testId?: string }) {
  const { t, fmt } = useI18n();
  if (!snapshotStale(x, Date.now())) return null;
  return (
    <span className="tag is-warn mon-stale-tag" title={t("mon.staleSnapH")} data-testid={testId}>
      <Icon name="clock" /> {x.checked_at ? t("mon.staleSnapAt", { t: fmt.rel(x.checked_at) }) : t("mon.staleSnap")}
    </span>
  );
}

/** a value of a stale snapshot: «no data», the last known value in the hint (as readiness «unknown») */
function StaleVal({ v }: { v: string }) {
  const { t } = useI18n();
  return (
    <span className="muted nowrap" title={t("mon.svc.lastReady", { s: v })} data-testid="mon-stale-val">
      {t("dash.svc.unknown")}
    </span>
  );
}

export function Age({ s }: { s: number | null | undefined }) {
  const { t, fmt } = useI18n();
  const a = ageParts(s);
  if (!a) return <>—</>;
  return <>{t(`mon.age.${a.unit}`, { n: fmt.num(a.v, a.unit === "h" || a.unit === "d" ? 1 : 0) })}</>;
}

function Size({ b }: { b: number | null | undefined }) {
  const { t, fmt } = useI18n();
  const p = sizeParts(b);
  if (!p) return <>—</>;
  return <>{t(`mon.size.${p.unit}`, { n: fmt.num(p.v, p.unit === "b" ? 0 : 1) })}</>;
}

/** «Queues»: consumers (lag, status, DLQ, replay availability), streams, outbox by service, service readiness. */
export function QueuesTab({ shared, onDlq }: { shared: MonShared; onDlq: (consumer: string | null) => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const [streams, setStreams] = useState<StreamInfo[] | null>(null);
  const [outbox, setOutbox] = useState<OutboxInfo[] | null>(null);
  const [services, setServices] = useState<ServiceReady[] | null>(null);
  const [err, setErr] = useState<{ streams: unknown; outbox: unknown; services: unknown }>({ streams: null, outbox: null, services: null });
  const load = useCallback(async () => {
    const [s, o, v] = await Promise.allSettled([OpsApi.streams(), OpsApi.outbox(), OpsApi.services()]);
    if (s.status === "fulfilled") setStreams(s.value.items);
    if (o.status === "fulfilled") setOutbox(o.value.items);
    if (v.status === "fulfilled") setServices(v.value.items);
    setErr({ streams: s.status === "rejected" ? s.reason : null, outbox: o.status === "rejected" ? o.reason : null, services: v.status === "rejected" ? v.reason : null });
  }, []);
  useEffect(() => void load(), [load]);
  const cons = shared.consumers;

  return (
    <div className="stack" data-testid="mon-queues">
      <section className="panel" aria-labelledby="mon-cons-h" data-testid="mon-consumers">
        <div className="panel-h">
          <h2 className="panel-t" id="mon-cons-h">
            <Icon name="layers" />
            {t("mon.cons.t")}
          </h2>
          <span className="panel-sub">{t("mon.cons.sub")}</span>
        </div>
        {shared.errors.consumers && !cons ? (
          <div className="panel-b">
            <LoadError error={shared.errors.consumers} onRetry={() => shared.reload()} testId="mon-cons-error" />
          </div>
        ) : !cons ? (
          <Spinner label={t("common.loading")} />
        ) : !cons.length ? (
          <Empty icon="layers" title={t("mon.cons.emptyT")} text={t("mon.cons.emptyM")} />
        ) : (
          <>
            {shared.errors.consumers ? (
              <div className="panel-b">
                <Callout kind="warn" icon="alert">
                  <b>{t("mon.staleLoad")}</b> {errText(i, shared.errors.consumers)}
                </Callout>
              </div>
            ) : null}
            <div className="table-wrap">
              <table className="tbl mon-cons-tbl">
                <thead>
                  <tr>
                    <th>{t("mon.cons.col.consumer")}</th>
                    <th>{t("mon.col.status")}</th>
                    <th className="num">{t("mon.cons.col.pending")}</th>
                    <th className="num">{t("mon.cons.col.ack")}</th>
                    <th className="num">{t("mon.cons.col.stuck")}</th>
                    <th className="num">{t("mon.cons.col.oldest")}</th>
                    <th>{t("mon.cons.col.active")}</th>
                    <th className="num">DLQ</th>
                    <th>{t("mon.cons.col.replay")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...cons].sort((a, b) => (a.status === b.status ? b.num_pending - a.num_pending : a.status === "ok" ? 1 : b.status === "ok" ? -1 : a.status === "stalled" ? -1 : 1)).map((c) => (
                    <tr key={c.durable} className={c.status === "stalled" ? "sev-bad" : c.status === "lagging" ? "sev-warn" : c.dlq.count ? "sev-warn" : "sev-none"} data-testid="mon-cons-row" data-consumer={c.durable}>
                      <td>
                        <b className="mono">{c.durable}</b>
                        <span className="block xs muted">
                          {c.service}
                          {c.event_types.length > 0 && ` · ${c.event_types.slice(0, 2).join(", ")}${c.event_types.length > 2 ? ` +${c.event_types.length - 2}` : ""}`}
                        </span>
                      </td>
                      <td>
                        <Pill tone={CONSUMER_TONE[c.status]} testId="mon-cons-status">
                          {t(`mon.cons.st.${c.status}`)}
                        </Pill>
                      </td>
                      <td className="num">
                        <b>{fmt.num(c.num_pending)}</b>
                        {c.num_redelivered > 0 && <span className="block xs muted">{t("mon.cons.redelivered", { n: fmt.num(c.num_redelivered) })}</span>}
                      </td>
                      <td className="num">{fmt.num(c.num_ack_pending)}</td>
                      <td className="num nowrap" data-testid="mon-cons-stuck">
                        {c.ack_stuck_s == null ? (
                          <span className="muted">—</span>
                        ) : (
                          <span className={cx(c.ack_stuck_s >= STALLED_S && "txt-bad")} title={t("mon.cons.stuckH")}>
                            {c.ack_stuck_s >= STALLED_S && <Icon name="alertCircle" />} <Age s={c.ack_stuck_s} />
                          </span>
                        )}
                      </td>
                      <td className="num">
                        <Age s={c.oldest_pending_age_s} />
                      </td>
                      <td className="small">{c.last_active_at ? fmt.rel(c.last_active_at) : "—"}</td>
                      <td className="num">
                        {c.dlq.count ? (
                          <Btn size="xs" kind="ghost" label={fmt.num(c.dlq.count)} icon="inbox" onClick={() => onDlq(c.durable)} title={t("mon.cons.openDlq")} testId="mon-cons-dlq" />
                        ) : (
                          "0"
                        )}
                      </td>
                      <td>
                        {c.replay_enabled ? (
                          <span className="small">
                            <Icon name="check" /> {t("mon.cons.replayOn")}
                          </span>
                        ) : (
                          <span className="small muted" title={t("mon.cons.replayOffH")}>
                            <Icon name="ban" /> {t("mon.cons.replayOff")}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="panel-f ai-foot">
          <Icon name="info" /> {t("mon.cons.foot")}
        </div>
      </section>

      <section className="panel" aria-labelledby="mon-outbox-h" data-testid="mon-outbox">
        <div className="panel-h">
          <h2 className="panel-t" id="mon-outbox-h">
            <Icon name="send" />
            {t("mon.outbox.t")}
          </h2>
          <span className="panel-sub">{t("mon.outbox.sub")}</span>
        </div>
        {err.outbox && !outbox ? (
          <div className="panel-b">
            <LoadError error={err.outbox} onRetry={() => void load()} />
          </div>
        ) : !outbox ? (
          <Spinner label={t("common.loading")} />
        ) : !outbox.length ? (
          <Empty icon="send" title={t("mon.outbox.emptyT")} />
        ) : (
          <div className="table-wrap">
            <table className="tbl compact mon-outbox-tbl">
              <thead>
                <tr>
                  <th>{t("mon.outbox.col.service")}</th>
                  <th className="num">{t("mon.outbox.col.pending")}</th>
                  <th className="num">{t("mon.outbox.col.failing")}</th>
                  <th>{t("mon.outbox.col.oldest")}</th>
                  <th className="num">{t("mon.outbox.col.attempts")}</th>
                  <th>{t("mon.outbox.col.error")}</th>
                  <th className="num">{t("mon.outbox.col.published")}</th>
                </tr>
              </thead>
              <tbody>
                {outbox.map((o) => {
                  // перепроверка 8: устаревший снимок — не «0 / в норме», а «нет данных» (прежнее — в подсказке)
                  const old = o.available && snapshotStale(o, Date.now());
                  const stuck = !old && (!!o.failing || (o.max_attempts ?? 0) >= 5);
                  return (
                    <tr key={o.service} className={cx(stuck ? "sev-warn" : "sev-none", !o.available && "is-muted")} data-testid="mon-outbox-row" data-service={o.service}>
                      <td>
                        <span className="mono">{o.service}</span> <StaleTag x={o} testId="mon-outbox-stale" />
                        {!o.available && <span className="block xs muted">{t("mon.outbox.na")}</span>}
                        {o.stale_consumers.length > 0 && <span className="block xs muted">{t("mon.outbox.stale", { c: o.stale_consumers.join(", ") })}</span>}
                      </td>
                      <td className="num">{old ? <StaleVal v={o.pending == null ? "—" : fmt.num(o.pending)} /> : o.pending == null ? "—" : fmt.num(o.pending)}</td>
                      <td className="num">
                        {old ? (
                          <StaleVal v={o.failing == null ? "—" : fmt.num(o.failing)} />
                        ) : o.failing == null ? (
                          "—"
                        ) : o.failing ? (
                          <b className="txt-bad nowrap" title={t("mon.outbox.failingH")}>
                            <Icon name="alertCircle" /> {fmt.num(o.failing)}
                            <span className="sr-only"> {t("mon.outbox.failingSr")}</span>
                          </b>
                        ) : (
                          "0"
                        )}
                      </td>
                      <td className="small">{o.oldest_pending_at ? fmt.rel(o.oldest_pending_at) : "—"}</td>
                      <td className="num">{o.max_attempts == null ? "—" : fmt.num(o.max_attempts)}</td>
                      <td className="mono small">{o.last_error_class ?? "—"}</td>
                      <td className="num">{o.published_24h == null ? "—" : fmt.num(o.published_24h)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid-2 mon-grid-2">
        <section className="panel" aria-labelledby="mon-streams-h" data-testid="mon-streams">
          <div className="panel-h">
            <h2 className="panel-t" id="mon-streams-h">
              <Icon name="activity" />
              {t("mon.streams.t")}
            </h2>
          </div>
          {err.streams && !streams ? (
            <div className="panel-b">
              <LoadError error={err.streams} onRetry={() => void load()} />
            </div>
          ) : !streams ? (
            <Spinner label={t("common.loading")} />
          ) : (
            <div className="table-wrap">
              <table className="tbl compact">
                <thead>
                  <tr>
                    <th>{t("mon.streams.col.name")}</th>
                    <th className="num">{t("mon.streams.col.messages")}</th>
                    <th className="num">{t("mon.streams.col.size")}</th>
                    <th className="num">{t("mon.streams.col.consumers")}</th>
                    <th className="num">{t("mon.streams.col.age")}</th>
                  </tr>
                </thead>
                <tbody>
                  {streams.map((s) => (
                    <tr key={s.name} data-testid="mon-stream-row">
                      <td>
                        <b className="mono">{s.name}</b>
                        <span className="block xs muted mono">{s.subjects.join(" ")}</span>
                      </td>
                      <td className="num">{fmt.num(s.messages)}</td>
                      <td className="num">
                        <Size b={s.bytes} />
                      </td>
                      <td className="num">{fmt.num(s.consumers)}</td>
                      <td className="num">
                        <Age s={s.max_age_s} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="panel" aria-labelledby="mon-svc-h" data-testid="mon-services">
          <div className="panel-h">
            <h2 className="panel-t" id="mon-svc-h">
              <Icon name="server" />
              {t("mon.svc.t")}
            </h2>
            {services && (
              <span className="panel-sub">
                {t("mon.svc.sub", { ok: services.filter((x) => x.ready === "ok").length, n: services.length })}
              </span>
            )}
          </div>
          {err.services && !services ? (
            <div className="panel-b">
              <LoadError error={err.services} onRetry={() => void load()} />
            </div>
          ) : !services ? (
            <Spinner label={t("common.loading")} />
          ) : (
            <ul className="svc-list">
              {[...services]
                .map((x) =>
                  // перепроверка 8: устаревший снимок — «нет данных», прежнее состояние — в подсказке
                  x.ready !== "unknown" && snapshotStale(x, Date.now()) ? { ...x, ready: "unknown" as const, last_ready: x.ready } : x,
                )
                .sort((a, b) => (a.ready === b.ready ? a.service.localeCompare(b.service) : a.ready === "ok" ? 1 : -1)).map((x) => (
                <li key={x.service} data-testid="mon-svc-row" data-ready={x.ready}>
                  <span className={cx("health-dot", x.ready === "degraded" && "warn", x.ready === "down" && "bad", x.ready === "unknown" && "muted")} aria-hidden="true" />
                  <span className="grow mono">
                    {x.service} <StaleTag x={x} testId="mon-svc-stale" />
                  </span>
                  <span
                    className={cx("pill", x.ready === "ok" ? "good" : x.ready === "degraded" ? "warn" : x.ready === "unknown" ? "no-dot" : "bad")}
                    title={x.ready === "unknown" && x.last_ready ? t("mon.svc.lastReady", { s: t(`dash.svc.${x.last_ready}`) }) : undefined}
                    data-testid="mon-svc-ready"
                  >
                    {x.ready === "unknown" && <Icon name="clock" />} {t(`dash.svc.${x.ready}`)}
                  </span>
                  <span className="mono xs muted" style={{ minWidth: 56, textAlign: "right" }}>
                    <MsText ms={x.latency_ms} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
