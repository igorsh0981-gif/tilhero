import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RateLimitHistory, RateLimitPolicy } from "@tilhero/contracts/admin";
import { RateLimitsApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type I18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Seg, Select, Spinner } from "../../ui/kit";
import { Drawer, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { Kpi } from "../ai/parts";
import type { MonShared } from "./Monitoring";
import { useProviderTitle } from "./Providers";
import { CLOSED_LOOSE_MAX_HOURS, CLOSED_MAX_FACTOR, expiresAt, limitTone, loosens, OVERRIDE_TTL_HOURS, perMinute, rejectShare, tooLoose, tooStrict, windowUnit } from "./ops";

/* Sprint 9 — «Monitoring → Limits» (INTERNAL_API §2.3–2.4): the rate limit policies of the platform, rejections in the
   last 15 min and history, top subjects (pseudonyms), override with a reason, a term and TOTP, reset. */

/** order of the service groups: Mini App, admin, internal calls, Claude */
const GROUPS = ["telegram-bff", "admin-bff", "*", "provider-gateway"];

/** dictionary text of a policy id or service, else the raw value (a newer catalogue) */
function tOr(i: Pick<I18n, "t">, key: string, fallback: string): string {
  const r = i.t(key as MessageKey);
  return r === key ? fallback : r;
}

/** «120 / min», «10 / h», «300 / 30 s» */
export function rateText(i: Pick<I18n, "t" | "fmt">, limit: number, windowS: number): string {
  const w = windowUnit(windowS);
  const per = i.t(`rl.per.${w.unit}` as MessageKey, { n: w.n });
  return `${i.fmt.num(limit)} / ${per}`;
}

function FailPill({ fail }: { fail: "open" | "closed" }) {
  const { t } = useI18n();
  return (
    <span className={cx("pill no-dot", fail === "closed" ? "warn" : "")} title={t(`rl.fail.${fail}.h`)} data-testid="rl-fail" data-fail={fail}>
      <Icon name={fail === "closed" ? "lock" : "unlock"} />
      {t(`rl.fail.${fail}`)}
    </span>
  );
}

function SourceCell({ p }: { p: RateLimitPolicy }) {
  const i = useI18n();
  const { t, fmt } = i;
  if (!p.override) return <span className="small muted">{t("rl.src.default")}</span>;
  return (
    <span className="rl-src">
      <span className="pill info no-dot" data-testid="rl-overridden">
        <Icon name="sliders" />
        {t("rl.src.override")}
      </span>
      <span className="block xs muted">
        {p.override.expires_at ? t("rl.until", { t: fmt.dateTime(p.override.expires_at) }) : t("rl.untilReset")}
      </span>
    </span>
  );
}

export function LimitsTab({ shared, policy, onOpen }: { shared: MonShared; policy: string | null; onOpen: (p: string | null) => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const [items, setItems] = useState<RateLimitPolicy[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<{ kind: "override" | "reset"; p: RateLimitPolicy } | null>(null);
  const load = useCallback(async (background = false) => {
    try {
      setItems((await RateLimitsApi.policies(background)).items);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(true), 60_000);
    return () => clearInterval(id);
  }, [load]);

  const groups = useMemo(() => {
    const by = new Map<string, RateLimitPolicy[]>();
    for (const p of items ?? []) by.set(p.service, [...(by.get(p.service) ?? []), p]);
    return [...by.entries()].sort((a, b) => (GROUPS.indexOf(a[0]) + 1 || 99) - (GROUPS.indexOf(b[0]) + 1 || 99));
  }, [items]);
  const k = useMemo(() => {
    const xs = items ?? [];
    return {
      rejecting: xs.filter((p) => p.last_15m.rejected > 0).length,
      rejected: xs.reduce((s, p) => s + p.last_15m.rejected, 0),
      overridden: xs.filter((p) => p.override).length,
      failclosed: xs.reduce((s, p) => s + p.last_15m.failclosed, 0),
      failopen: xs.reduce((s, p) => s + p.last_15m.failopen, 0),
    };
  }, [items]);
  const open = policy ? (items?.find((p) => p.policy === policy) ?? null) : null;
  const done = (p: RateLimitPolicy) => {
    setItems((xs) => (xs ? xs.map((x) => (x.policy === p.policy ? p : x)) : xs));
    setDialog(null);
  };

  return (
    <div className="stack" data-testid="mon-limits">
      {error && !items ? (
        <section className="panel">
          <div className="panel-b">
            <LoadError error={error} onRetry={() => void load()} testId="rl-error" />
          </div>
        </section>
      ) : !items ? (
        <section className="panel">
          <Spinner label={t("common.loading")} />
        </section>
      ) : (
        <>
          <section className="panel" aria-label={t("rl.summary")}>
            <div className="statband rl-kpis" data-testid="rl-kpis">
              <Kpi
                label={t("rl.k.rejected")}
                value={fmt.num(k.rejected)}
                sub={k.rejecting ? i.tp("rl.k.rejectingN", k.rejecting) : t("rl.k.rejectingNone")}
                tone={k.rejected ? "warn" : undefined}
                testId="rl-k-rejected"
              />
              <Kpi label={t("rl.k.overridden")} value={fmt.num(k.overridden)} sub={t("rl.k.overriddenS")} testId="rl-k-overridden" />
              <Kpi
                label={t("rl.k.redis")}
                value={k.failclosed || k.failopen ? fmt.num(k.failclosed + k.failopen) : t("rl.k.redisOk")}
                sub={k.failclosed || k.failopen ? t("rl.k.redisBad", { c: fmt.num(k.failclosed), o: fmt.num(k.failopen) }) : t("rl.k.redisOkS")}
                tone={k.failclosed ? "bad" : k.failopen ? "warn" : undefined}
                testId="rl-k-redis"
              />
              <Kpi label={t("rl.k.policies")} value={fmt.num(items.length)} sub={t("rl.k.policiesS")} testId="rl-k-policies" />
            </div>
          </section>

          <section className="panel" aria-labelledby="rl-h">
            <div className="panel-h">
              <h2 className="panel-t" id="rl-h">
                <Icon name="gauge" />
                {t("rl.t")}
              </h2>
              <span className="panel-sub">{t("rl.sub")}</span>
            </div>
            {error ? (
              <div className="panel-b">
                <Callout kind="warn" icon="alert">
                  <b>{t("mon.staleLoad")}</b> {errText(i, error)}
                </Callout>
              </div>
            ) : null}
            {!items.length ? (
              <Empty icon="gauge" title={t("rl.emptyT")} text={t("rl.emptyM")} />
            ) : (
              <div className="table-wrap">
                <table className="tbl rl-tbl">
                  <thead>
                    <tr>
                      <th>{t("rl.col.policy")}</th>
                      <th>{t("rl.col.subject")}</th>
                      <th className="num">{t("rl.col.limit")}</th>
                      <th>{t("rl.col.fail")}</th>
                      <th className="num">{t("rl.col.rejected")}</th>
                      <th>{t("rl.col.source")}</th>
                      <th className="act" aria-label={t("common.actions")} />
                    </tr>
                  </thead>
                  {groups.map(([service, ps]) => (
                    <tbody key={service}>
                      <tr className="rl-group">
                        <th colSpan={7} scope="rowgroup">
                          {tOr(i, `rl.svc.${service}`, service)} <span className="mono xs muted">{service === "*" ? t("rl.svc.allPy") : service}</span>
                        </th>
                      </tr>
                      {ps.map((p) => {
                        const tone = limitTone(p.last_15m);
                        const share = rejectShare(p.last_15m);
                        return (
                          <tr
                            key={p.policy}
                            className={cx("is-click", tone === "bad" ? "sev-bad" : tone === "warn" ? "sev-warn" : "sev-none")}
                            tabIndex={0}
                            onClick={() => onOpen(p.policy)}
                            onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen(p.policy)}
                            data-testid="rl-row"
                            data-policy={p.policy}
                          >
                            <td className="rl-c-policy">
                              <b className="mono">{p.policy}</b>
                              <span className="block xs muted rl-desc">{tOr(i, `rl.p.${p.policy}`, "")}</span>
                            </td>
                            <td className="small" data-label={t("rl.col.subject")}>{t(`rl.subj.${p.subject}`)}</td>
                            <td className="num nowrap" data-label={t("rl.col.limit")}>
                              <b>{rateText(i, p.limit, p.window_s)}</b>
                              {p.source === "override" && (
                                <span className="block xs muted" data-testid="rl-default">
                                  {t("rl.defaultWas", { v: rateText(i, p.default.limit, p.default.window_s) })}
                                </span>
                              )}
                            </td>
                            <td data-label={t("rl.col.fail")}>
                              <FailPill fail={p.fail} />
                            </td>
                            <td className="num nowrap" data-testid="rl-rejected" data-label={t("rl.col.rejected")}>
                              {p.last_15m.rejected ? (
                                <b className={cx(tone === "warn" && "txt-warn", tone === "bad" && "txt-bad")}>
                                  {tone !== "neutral" && <Icon name={tone === "bad" ? "alertCircle" : "alert"} />} {fmt.num(p.last_15m.rejected)}
                                </b>
                              ) : (
                                <span className="muted">0</span>
                              )}
                              <span className="block xs muted">
                                {share != null && p.last_15m.rejected ? t("rl.share", { v: fmt.pct(share * 100) }) : t("rl.allowed", { n: fmt.num(p.last_15m.allowed) })}
                              </span>
                              {(p.last_15m.failclosed > 0 || p.last_15m.failopen > 0) && (
                                <span className="block xs txt-bad nowrap">{t("rl.failN", { c: fmt.num(p.last_15m.failclosed), o: fmt.num(p.last_15m.failopen) })}</span>
                              )}
                            </td>
                            <td data-label={t("rl.col.source")}>
                              <SourceCell p={p} />
                            </td>
                            <td className="act" onClick={(e) => e.stopPropagation()}>
                              {p.override && (
                                <Btn size="xs" kind="ghost" icon="rollback" aria={`${t("rl.reset")}: ${p.policy}`} title={t("rl.reset")} perm="ops.kill_switch" onClick={() => setDialog({ kind: "reset", p })} testId="rl-reset" />
                              )}
                              <Btn size="xs" kind="ghost" icon="sliders" aria={`${t("rl.override")}: ${p.policy}`} title={t("rl.override")} perm="ops.kill_switch" onClick={() => setDialog({ kind: "override", p })} testId="rl-override" />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  ))}
                </table>
              </div>
            )}
            <div className="panel-f ai-foot">
              <Icon name="info" /> {t("rl.foot")}
            </div>
          </section>

          <ProviderLimits shared={shared} />
        </>
      )}
      {open && <PolicyDrawer p={open} onClose={() => onOpen(null)} onCommand={(kind) => setDialog({ kind, p: open })} />}
      {dialog?.kind === "override" && <OverrideDialog p={dialog.p} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "reset" && <ResetDialog p={dialog.p} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

/** outbound limits of the providers (token bucket and daily quota of provider-gateway): read only (§2.3) */
function ProviderLimits({ shared }: { shared: MonShared }) {
  const i = useI18n();
  const { t, fmt } = i;
  const title = useProviderTitle();
  const ps = (shared.providers ?? []).filter((p) => p.quota || p.window.by_class.rate_limit || p.window.by_class.quota);
  if (!shared.providers) return null;
  return (
    <section className="panel" aria-labelledby="rl-prov-h" data-testid="rl-providers">
      <div className="panel-h">
        <h2 className="panel-t" id="rl-prov-h">
          <Icon name="zap" />
          {t("rl.prov.t")}
        </h2>
        <span className="panel-sub">{t("rl.prov.sub")}</span>
      </div>
      {!ps.length ? (
        <Empty icon="zap" title={t("rl.prov.emptyT")} />
      ) : (
        <div className="table-wrap">
          <table className="tbl compact">
            <thead>
              <tr>
                <th>{t("mon.col.provider")}</th>
                <th>{t("mon.col.quota")}</th>
                <th className="num">{t("rl.prov.rate")}</th>
                <th className="num">{t("rl.prov.quotaErr")}</th>
              </tr>
            </thead>
            <tbody>
              {ps.map((p) => (
                <tr key={p.provider} data-testid="rl-prov-row">
                  <td>
                    <b>{title(p.provider, p.title)}</b>
                  </td>
                  <td className="small">{p.quota ? t("rl.prov.quota", { pct: fmt.pct(p.quota.pct, 0), used: fmt.num(p.quota.used), limit: fmt.num(p.quota.limit) }) : "—"}</td>
                  <td className="num">{fmt.num(p.window.by_class.rate_limit)}</td>
                  <td className="num">{fmt.num(p.window.by_class.quota)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** allowed / rejected per bucket — a fixed time axis (no requests — no bar) */
export function LimitChart({ h, now = Date.now() }: { h: RateLimitHistory; now?: number }) {
  const { t, fmt } = useI18n();
  const W = 640;
  const H = 130;
  const L = 40;
  const R = 12;
  const T = 8;
  const B = 22;
  const iw = W - L - R;
  const ih = H - T - B;
  const step = h.range === "24h" ? 5 * 60_000 : 3_600_000;
  const n = h.range === "24h" ? 288 : 168;
  const end = Math.floor(now / step) * step + step;
  const start = end - n * step;
  const slot = iw / n;
  const max = Math.max(1, ...h.points.map((p) => p.allowed + p.rejected));
  const bars = h.points
    .map((p) => ({ p, i: Math.floor((Date.parse(p.t) - start) / step) }))
    .filter((x) => x.i >= 0 && x.i < n)
    .map(({ p, i }) => ({ p, x: i * slot, w: Math.max(1, slot - (slot > 3 ? 1 : 0)), a: (p.allowed / max) * ih, r: (p.rejected / max) * ih }));
  const rejected = h.points.reduce((s, p) => s + p.rejected, 0);
  const allowed = h.points.reduce((s, p) => s + p.allowed, 0);
  const summary = t("rl.chart.summary", { a: fmt.num(allowed), r: fmt.num(rejected) });
  const tickEvery = h.range === "24h" ? 6 * 3_600_000 : 86_400_000;
  const ticks: number[] = [];
  for (let x = Math.ceil(start / tickEvery) * tickEvery; x < end; x += tickEvery) ticks.push(x);
  return (
    <figure className="mon-chart" data-testid="rl-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
        <g transform={`translate(${L},${T})`}>
          {[0, 0.5, 1].map((f) => (
            <line key={f} className="grid" x1={0} x2={iw} y1={ih - f * ih} y2={ih - f * ih} />
          ))}
          {bars.map((b) => (
            <g key={b.p.t}>
              <title>{`${fmt.dateTime(b.p.t)} · ${t("rl.chart.allowed")} ${fmt.num(b.p.allowed)} · ${t("rl.chart.rejected")} ${fmt.num(b.p.rejected)}`}</title>
              <rect className="b-ok" x={b.x} width={b.w} y={ih - b.a} height={b.a} />
              <rect className="b-err" x={b.x} width={b.w} y={ih - b.a - b.r} height={b.r} />
            </g>
          ))}
          {ticks.map((x) => (
            <text key={x} className="tick" x={((x - start) / step) * slot} y={ih + 15} textAnchor="middle">
              {h.range === "24h" ? fmt.time(new Date(x).toISOString()) : fmt.date(new Date(x).toISOString()).slice(0, 5)}
            </text>
          ))}
          <line className="axis-line" x1={0} x2={0} y1={0} y2={ih} />
          {[1, 0.5, 0].map((f) => (
            <text key={f} className="axis" x={-6} y={ih - f * ih + 3} textAnchor="end">
              {fmt.num(Math.round(max * f))}
            </text>
          ))}
        </g>
      </svg>
      <figcaption className="mon-chart-cap">
        <span className="lg">
          <i className="b-ok" />
          {t("rl.chart.allowed")}
        </span>
        <span className="lg">
          <i className="b-err" />
          {t("rl.chart.rejected")}
        </span>
        <span className="grow" />
        <span className="xs muted">{summary}</span>
      </figcaption>
    </figure>
  );
}

function PolicyDrawer({ p, onClose, onCommand }: { p: RateLimitPolicy; onClose: () => void; onCommand: (k: "override" | "reset") => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const [range, setRange] = useState<"24h" | "7d">("24h");
  const [h, setH] = useState<RateLimitHistory | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    setH(null);
    setError(null);
    RateLimitsApi.history(p.policy, range)
      .then((x) => live && setH(x))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [p.policy, range]);
  return (
    <Drawer
      wide
      title={p.policy}
      sub={
        <>
          <span>{tOr(i, `rl.p.${p.policy}`, "")}</span>
          <FailPill fail={p.fail} />
        </>
      }
      onClose={onClose}
      testId="rl-drawer"
      footer={
        <>
          <Btn label={t("common.close")} onClick={onClose} />
          <span className="grow" />
          {p.override && <Btn kind="ghost" icon="rollback" label={t("rl.reset")} perm="ops.kill_switch" onClick={() => onCommand("reset")} testId="rl-drawer-reset" />}
          <Btn kind="primary" icon="sliders" label={t("rl.override")} perm="ops.kill_switch" onClick={() => onCommand("override")} testId="rl-drawer-override" />
        </>
      }
    >
      <div className="stack">
        <div className="statband dash-band-3">
          <Kpi label={t("rl.d.current")} value={rateText(i, p.limit, p.window_s)} sub={t("rl.d.burst", { n: fmt.num(p.burst) })} testId="rl-d-current" />
          <Kpi
            label={t("rl.d.default")}
            value={rateText(i, p.default.limit, p.default.window_s)}
            sub={p.env ? <span className="mono">{p.env}</span> : t("rl.d.catalog")}
          />
          <Kpi
            label={t("rl.col.rejected")}
            value={fmt.num(p.last_15m.rejected)}
            sub={t("rl.allowed", { n: fmt.num(p.last_15m.allowed) })}
            tone={limitTone(p.last_15m) === "neutral" ? undefined : (limitTone(p.last_15m) as "bad" | "warn")}
          />
        </div>
        {p.override && (
          <Callout kind="info" icon="sliders" testId="rl-d-override">
            <b>{t("rl.d.overrideT", { v: rateText(i, p.override.limit, p.override.window_s) })}</b>
            <span className="block small">
              {t("rl.d.overrideBy", { who: p.override.by_name ?? p.override.by, t: fmt.dateTime(p.override.at) })} ·{" "}
              {p.override.expires_at ? t("rl.until", { t: fmt.dateTime(p.override.expires_at) }) : t("rl.untilReset")}
            </span>
            <span className="block small">«{p.override.reason}»</span>
          </Callout>
        )}
        <section className="mon-sec" aria-labelledby="rl-hist-h">
          <div className="mon-sec-h">
            <h3 id="rl-hist-h">{t("rl.d.history")}</h3>
            <span className="grow" />
            <Seg label={t("rl.d.history")} value={range} onChange={setRange} testId="rl-range" items={[{ v: "24h", label: t("mon.r24") }, { v: "7d", label: t("mon.r7") }]} />
          </div>
          {error ? <LoadError error={error} /> : !h ? <Spinner label={t("common.loading")} /> : !h.points.length ? <Empty icon="activity" title={t("rl.d.noHistory")} /> : <LimitChart h={h} />}
        </section>
        <section className="mon-sec" aria-labelledby="rl-top-h">
          <div className="mon-sec-h">
            <h3 id="rl-top-h">{t("rl.d.top")}</h3>
          </div>
          {!h ? null : !h.top_subjects_15m.length ? (
            <p className="small muted" data-testid="rl-top-empty">
              {t("rl.d.topEmpty")}
            </p>
          ) : (
            <ol className="rl-top" data-testid="rl-top">
              {h.top_subjects_15m.map((x) => (
                <li key={x.subject}>
                  <span className="mono small wrap-any">{x.subject}</span>
                  <b>{fmt.num(x.rejected)}</b>
                </li>
              ))}
            </ol>
          )}
          <p className="xs muted row">
            <Icon name="shield" /> {t("rl.d.topNote")}
          </p>
        </section>
      </div>
    </Drawer>
  );
}

const WINDOWS = [60, 3600, 86_400] as const;

function OverrideDialog({ p, onClose, onDone }: { p: RateLimitPolicy; onClose: () => void; onDone: (p: RateLimitPolicy) => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const toast = useToast();
  const [limit, setLimit] = useState(String(p.limit));
  const [win, setWin] = useState(String((WINDOWS as readonly number[]).includes(p.window_s) ? p.window_s : 60));
  const [burst, setBurst] = useState("");
  const [ttl, setTtl] = useState("24");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // one Idempotency-Key per command: a repeat (network, step-up, audit down) is the same; a changed field — a new key
  const idem = useRef(`rl-${uuid()}`);
  const fresh = () => (idem.current = `rl-${uuid()}`);
  const n = Number(limit);
  const w = Number(win);
  const b = burst.trim() ? Number(burst) : null;
  const limitOk = Number.isInteger(n) && n >= 1 && n <= 100_000;
  const burstOk = b == null || (Number.isInteger(b) && b >= 1 && b <= 100_000);
  const strict = limitOk && tooStrict(p.fail, n, w);
  // fail: closed — защита входа / MFA / PIN / команд: ослабление не больше ×10 и только со сроком ≤ 24 ч
  const weakens = limitOk && burstOk && p.fail === "closed" && loosens(p.default, n, w, b);
  const loose = limitOk && burstOk && tooLoose(p.fail, p.default, n, w, b);
  const ttlOptions = OVERRIDE_TTL_HOURS.filter((x) => !weakens || (x != null && x <= CLOSED_LOOSE_MAX_HOURS));
  const ttlOk = !weakens || (ttl !== "none" && Number(ttl) <= CLOSED_LOOSE_MAX_HOURS);
  const ok = limitOk && burstOk && !strict && !loose && ttlOk && reason.trim().length >= 3;
  // ослабление защиты входа — срок не дольше суток: «до сброса» / «неделя» сменяются на 24 ч
  useEffect(() => {
    if (!ttlOk) setTtl(String(CLOSED_LOOSE_MAX_HOURS));
  }, [ttlOk]);
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const hours = ttl === "none" ? null : Number(ttl);
      const r = await RateLimitsApi.override(
        p.policy,
        { limit: n, window_s: w, reason: reason.trim(), ...(b != null ? { burst: b } : {}), ...(hours != null ? { expires_at: expiresAt(Date.now(), hours) } : {}) },
        idem.current,
      );
      toast(t("rl.overrideDone", { p: p.policy, v: rateText(i, r.limit, r.window_s) }), "ok", "ratelimit.override.set");
      onDone(r);
    } catch (e) {
      setErr(e instanceof ApiError && e.cancelled ? t("stepup.cancelled") : errText(i, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("rl.overrideT", { p: p.policy })}
      text={t("rl.overrideM")}
      icon="sliders"
      tone="warn"
      onClose={() => !busy && onClose()}
      testId="rl-override-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn kind="primary" label={t("rl.override")} disabled={!ok} busy={busy} onClick={() => void submit()} testId="rl-override-ok" />
        </>
      }
    >
      <dl className="kv mon-kv">
        <dt>{t("rl.d.current")}</dt>
        <dd>{rateText(i, p.limit, p.window_s)}</dd>
        <dt>{t("rl.d.default")}</dt>
        <dd>
          {rateText(i, p.default.limit, p.default.window_s)} {p.env && <span className="mono xs muted">{p.env}</span>}
        </dd>
        <dt>{t("rl.col.fail")}</dt>
        <dd>
          <FailPill fail={p.fail} />
        </dd>
      </dl>
      <div className="rl-form">
        <div className="field">
          <label htmlFor="rl-limit" className="req">
            {t("rl.f.limit")}
          </label>
          <input
            id="rl-limit"
            className={cx("input mono", !limitOk && "is-invalid")}
            inputMode="numeric"
            value={limit}
            onChange={(e) => {
              setLimit(e.target.value);
              fresh();
            }}
            data-autofocus=""
            data-testid="rl-limit"
          />
        </div>
        <div className="field">
          <label htmlFor="rl-window">{t("rl.f.window")}</label>
          <Select
            id="rl-window"
            label={t("rl.f.window")}
            value={win}
            onChange={(v) => {
              setWin(v);
              fresh();
            }}
            options={WINDOWS.map((x) => ({ v: String(x), label: t(`rl.w.${x}` as MessageKey) }))}
            testId="rl-window"
          />
        </div>
        <div className="field">
          <label htmlFor="rl-burst">{t("rl.f.burst")}</label>
          <input
            id="rl-burst"
            className={cx("input mono", !burstOk && "is-invalid")}
            inputMode="numeric"
            placeholder={t("rl.f.burstPh")}
            value={burst}
            onChange={(e) => {
              setBurst(e.target.value);
              fresh();
            }}
            data-testid="rl-burst"
          />
        </div>
        <div className="field">
          <label htmlFor="rl-ttl">{t("rl.f.ttl")}</label>
          <Select
            id="rl-ttl"
            label={t("rl.f.ttl")}
            value={ttl}
            onChange={(v) => {
              setTtl(v);
              fresh();
            }}
            options={ttlOptions.map((x) => ({ v: x == null ? "none" : String(x), label: x == null ? t("rl.ttl.none") : t(`rl.ttl.${x}` as MessageKey) }))}
            testId="rl-ttl"
          />
        </div>
      </div>
      {limitOk && (
        <p className="small" data-testid="rl-preview">
          {t("rl.preview", { v: fmt.num(Math.round(perMinute(n, w) * 100) / 100), now: fmt.num(Math.round(perMinute(p.limit, p.window_s) * 100) / 100) })}
        </p>
      )}
      {strict && (
        <Callout kind="bad" icon="lock" testId="rl-too-strict">
          {t("rl.tooStrict")}
        </Callout>
      )}
      {loose ? (
        <Callout kind="bad" icon="shield" testId="rl-too-loose">
          {t("rl.tooLoose", { x: CLOSED_MAX_FACTOR, v: fmt.num(Math.round(perMinute(p.default.limit, p.default.window_s) * CLOSED_MAX_FACTOR * 100) / 100) })}
        </Callout>
      ) : (
        weakens && (
          <Callout kind="warn" icon="shield" testId="rl-weakens">
            {t("rl.weakens", { h: CLOSED_LOOSE_MAX_HOURS })}
          </Callout>
        )
      )}
      <div className="field">
        <label htmlFor="rl-reason" className="req">
          {t("cmd.reason")}
        </label>
        <textarea
          id="rl-reason"
          className="textarea"
          rows={2}
          maxLength={300}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            fresh();
          }}
          placeholder={t("rl.reasonPh")}
          data-testid="rl-reason"
        />
      </div>
      <FieldErr msg={err} />
      <p className="xs muted row">
        <Icon name="smartphoneKey" /> {t("dsc.stepUpNote")}
      </p>
      <p className="xs muted row">
        <Icon name="audit" /> {t("cmd.auditNote")}
      </p>
    </Modal>
  );
}

function ResetDialog({ p, onClose, onDone }: { p: RateLimitPolicy; onClose: () => void; onDone: (p: RateLimitPolicy) => void }) {
  const i = useI18n();
  const { t } = i;
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idem = useRef(`rl-reset-${uuid()}`);
  const submit = async () => {
    if (reason.trim().length < 3 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await RateLimitsApi.reset(p.policy, reason.trim(), idem.current);
      toast(t("rl.resetDone", { p: p.policy, v: rateText(i, r.limit, r.window_s) }), "ok", "ratelimit.override.reset");
      onDone(r);
    } catch (e) {
      setErr(e instanceof ApiError && e.cancelled ? t("stepup.cancelled") : errText(i, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("rl.resetT", { p: p.policy })}
      text={t("rl.resetM", { v: rateText(i, p.default.limit, p.default.window_s) })}
      icon="rollback"
      onClose={() => !busy && onClose()}
      testId="rl-reset-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn kind="primary" label={t("rl.reset")} disabled={reason.trim().length < 3} busy={busy} onClick={() => void submit()} testId="rl-reset-ok" />
        </>
      }
    >
      <div className="field">
        <label htmlFor="rl-reset-reason" className="req">
          {t("cmd.reason")}
        </label>
        <textarea
          id="rl-reset-reason"
          className="textarea"
          rows={2}
          maxLength={300}
          data-autofocus=""
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            idem.current = `rl-reset-${uuid()}`;
          }}
          data-testid="rl-reset-reason"
        />
      </div>
      <FieldErr msg={err} />
      <p className="xs muted row">
        <Icon name="smartphoneKey" /> {t("dsc.stepUpNote")}
      </p>
    </Modal>
  );
}

