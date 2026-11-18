import { useCallback, useEffect, useRef, useState } from "react";
import type { TravelProviderProbe, TravelProviderStatus } from "@tilhero/contracts/admin";
import { TravelApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useNow } from "../../lib/useNow";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, CopyBtn, cx, Pill, Spinner } from "../../ui/kit";
import { errMeta, errText } from "../../ui/errors";
import {
  PROBE_COOLDOWN_S,
  PROVIDER_META,
  STATE_TONE,
  diagKind,
  diagTone,
  errorIsLatest,
  lockLeft,
  providerMsg,
  providerState,
  quotaLevel,
  routeErrorTitle,
  summary,
  travelErrorLabel,
  type DiagKind,
  type ProviderState,
  type TravelName,
} from "./travel";

/** background refresh of the cards (does not extend the idle session) */
export const TRAVEL_POLL_MS = 60_000;

const SEV: Partial<Record<ProviderState, string>> = {
  breaker_open: "sev-bad",
  quota_exhausted: "sev-bad",
  breaker_half: "sev-warn",
  failing: "sev-warn",
  not_configured: "sev-warn",
};

/** «Trip providers» (dashboard.read): Aviasales, LiteAPI, OpenStreetMap, CBU rates — configured, enabled, quota,
 *  breaker, the last error explained (fix 5.1) and «Check now». */
export function TravelPage() {
  const i = useI18n();
  const { t, fmt } = i;
  const [items, setItems] = useState<TravelProviderStatus[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [staleErr, setStaleErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const hasItems = useRef(false);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    try {
      const r = await TravelApi.providers(background);
      hasItems.current = true;
      setItems(r.items);
      setError(null);
      setStaleErr(null);
      setUpdatedAt(new Date().toISOString());
    } catch (e) {
      // a failed refresh keeps the last known cards and says so; without cards — the error block
      if (hasItems.current) setStaleErr(e);
      else setError(e);
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(true), TRAVEL_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const sum = items ? summary(items) : null;

  return (
    <div data-testid="travel" aria-busy={loading}>
      <div className="page-head">
        <div className="lead">
          <p>{t("trv.lead")}</p>
        </div>
        <div className="acts">
          {updatedAt && (
            <span className="dash-updated" data-testid="trv-updated">
              {t("common.updated")} {fmt.time(updatedAt)}
            </span>
          )}
          <Btn kind="ghost" icon="refresh" label={t("common.refresh")} busy={loading && !!items} onClick={() => void load()} testId="trv-refresh" />
        </div>
      </div>

      {error ? (
        <LoadError error={error} onRetry={() => void load()} testId="trv-error" />
      ) : !items ? (
        <section className="panel">
          <Spinner label={t("common.loading")} />
        </section>
      ) : (
        <>
          {staleErr ? (
            <div className="mb-12">
              <Callout kind="warn" icon="alert" testId="trv-stale">
                <b>{t("trv.stale")}</b> {errText(i, staleErr)}
              </Callout>
            </div>
          ) : null}
          {sum && (
            <div className="mb-12">
              <Callout kind={sum.attention ? "warn" : "good"} icon={sum.attention ? "alert" : "checkCircle"} testId="trv-summary">
                <b>{sum.attention ? t("trv.sum.attention", { n: sum.attention, total: sum.total }) : t("trv.sum.ok", { total: sum.total })}</b>{" "}
                {t("trv.sum.note")}
              </Callout>
            </div>
          )}
          <div className="trv-grid">
            {items.map((p) => (
              <ProviderCard key={p.name} p={p} onProbed={() => void load(true)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ProviderCard({ p, onProbed }: { p: TravelProviderStatus; onProbed?: () => void }) {
  const { t, fmt } = useI18n();
  const [probe, setProbe] = useState<TravelProviderProbe | null>(null);
  const now = useNow(!!(p.last_success_at || p.last_error?.at));
  const meta = PROVIDER_META[p.name];
  const state = providerState(p);
  /** not configured / switched off: gateway does not call it, a «closed» breaker would read as «all good» */
  const inactive = state === "not_configured" || state === "disabled";
  const q = p.quota;
  const qLevel = quotaLevel(q);
  const qRatio = q && q.day_limit > 0 ? Math.min(1, q.day_used / q.day_limit) : 0;
  const when = (iso: string) => (
    <>
      <span>{fmt.rel(iso, now)}</span> <span className="xs muted mono">{fmt.dateTime(iso)}</span>
    </>
  );
  return (
    <section className={cx("panel trv-card", SEV[state])} aria-labelledby={`trv-h-${p.name}`} data-testid={`trv-${p.name}`} data-state={state}>
      <div className="panel-h">
        <span className={cx("trv-ico", `tone-${STATE_TONE[state]}`)} aria-hidden="true">
          <Icon name={meta.icon} />
        </span>
        <div className="trv-title">
          <h2 className="panel-t" id={`trv-h-${p.name}`}>
            {t(`trv.name.${p.name}` as MessageKey)}
          </h2>
          <div className="panel-sub">{t(`trv.role.${p.name}` as MessageKey)}</div>
        </div>
        <span className="grow" />
        <Pill tone={STATE_TONE[state]} testId={`trv-state-${p.name}`}>
          {t(`trv.state.${state}` as MessageKey)}
        </Pill>
      </div>

      <div className="panel-b trv-body">
        {state === "not_configured" && <SetupHint name={p.name} />}
        {state === "disabled" && (
          <Callout icon="power" testId={`trv-disabled-${p.name}`}>
            {t("trv.disabledHint")} <code className="code-chip">{meta.enableVar}=true</code>
          </Callout>
        )}

        <div className={cx("trv-quota", `lvl-${qLevel}`)} data-testid={`trv-quota-${p.name}`}>
          <div className="trv-quota-h">
            <span className="trv-l">{t("trv.quota")}</span>
            {q ? (
              <span className="trv-quota-v">
                <b>{fmt.num(q.day_used)}</b>
                <span className="slash">/</span>
                <span className="muted">{fmt.num(q.day_limit)}</span>
              </span>
            ) : (
              <span className="muted small">{t("trv.quotaNone")}</span>
            )}
          </div>
          <span
            className="trv-meter"
            role="meter"
            aria-label={t("trv.quota")}
            aria-valuemin={0}
            aria-valuemax={q?.day_limit || 1}
            aria-valuenow={q?.day_used ?? 0}
          >
            <i style={{ width: `${qRatio * 100}%` }} />
          </span>
          <div className="xs muted">
            {t("trv.quotaReset")} · <code className="mono">{meta.quotaVar}</code>
          </div>
        </div>

        <dl className="kv trv-kv">
          <dt>{t("trv.configured")}</dt>
          <dd data-testid={`trv-configured-${p.name}`}>{p.configured ? t("common.yes") : t("common.no")}</dd>
          <dt>{t("trv.enabled")}</dt>
          <dd>{p.enabled ? t("common.yes") : t("common.no")}</dd>
          <dt>{t("trv.breaker")}</dt>
          <dd>
            {inactive ? (
              <span className="muted" data-testid={`trv-breaker-${p.name}`}>
                {t("trv.noCalls")}
              </span>
            ) : (
              <>
                <Pill tone={p.breaker === "open" ? "bad" : p.breaker === "half_open" ? "warn" : "good"} testId={`trv-breaker-${p.name}`}>
                  {t(`trv.breaker.${p.breaker}` as MessageKey)}
                </Pill>
                <span className="xs muted trv-sub">{t(`trv.breaker.${p.breaker}.h` as MessageKey)}</span>
              </>
            )}
          </dd>
          <dt>{t("trv.lastSuccess")}</dt>
          <dd data-testid={`trv-success-${p.name}`}>{p.last_success_at ? when(p.last_success_at) : <span className="muted">{t("trv.never")}</span>}</dd>
          <dt>{t("trv.lastError")}</dt>
          <dd data-testid={`trv-last-error-${p.name}`}>
            {p.last_error ? (
              <>
                <span className={cx("b", (state === "failing" || state === "breaker_open") && "trv-err-l")} data-testid={`trv-why-${p.name}`}>
                  {diagTitle(t, p.last_error)}
                </span>
                <ErrorCodes e={p.last_error} />
                <span className="trv-sub small">{p.last_error.at ? when(p.last_error.at) : <span className="muted">{t("trv.timeUnknown")}</span>}</span>
              </>
            ) : (
              <span className="muted">{t("trv.noErrors")}</span>
            )}
          </dd>
          {/* fix 5.2: the supplier did not know a code of the route — a separate line, the provider's health is not affected */}
          {p.last_route_error ? (
            <>
              <dt>{t("trv.routeError")}</dt>
              <dd data-testid={`trv-route-error-${p.name}`}>
                <span className="b">{routeErrorTitle(t, p.last_route_error)}</span>
                <span className="trv-sub small">{p.last_route_error.at ? when(p.last_route_error.at) : <span className="muted">{t("trv.timeUnknown")}</span>}</span>
                <span className="xs muted trv-sub">{t("trv.routeError.h")}</span>
              </dd>
            </>
          ) : null}
        </dl>

        {/* a failed «Check now» explains itself below — no second «what to do» for the same failure */}
        {p.last_error && errorIsLatest(p) && !inactive && !(probe && !probe.ok) && <FixHint name={p.name} e={p.last_error} testId={`trv-fix-${p.name}`} />}

        {!inactive && <ProbeBlock name={p.name} onProbed={onProbed} onResult={setProbe} />}
      </div>
      <div className="panel-f">
        <Icon name="info" />
        <span>{t(`trv.uses.${p.name}` as MessageKey)}</span>
      </div>
    </section>
  );
}

type ErrLike = Pick<TravelProviderProbe, "code" | "reason" | "message" | "http_status">;
type T = (k: MessageKey, v?: Record<string, string | number>) => string;

/** Human title of a provider error: by the machine reason (fix 5.1), else the label of the code (old gateway). */
export function diagTitle(t: T, e: ErrLike): string {
  const kind = diagKind(e.reason, e.code);
  if (!kind) return e.code ? travelErrorLabel(t, e.code) : t("trv.why.unknownNoReason");
  const msg = providerMsg(e.message);
  if (kind === "provider_error") return msg ? t("trv.why.provider_errorMsg", { msg }) : t("trv.why.provider_error");
  const title = kind === "unknown" ? t("trv.why.unknown", { reason: e.reason ?? "—" }) : t(`trv.why.${kind}` as MessageKey);
  // the provider's own words (admin-bff passes them for success_false, provider_error and upstream_4xx only)
  return msg ? t("trv.why.withMsg", { title, msg }) : title;
}

/** code · reason · HTTP status — for the developers, next to the human text */
function ErrorCodes({ e }: { e: ErrLike }) {
  return (
    <span className="trv-sub trv-codes">
      {e.code && <code className="code-chip">{e.code}</code>}
      {e.reason && <code className="code-chip">{e.reason}</code>}
      {e.http_status != null && <code className="code-chip">HTTP {e.http_status}</code>}
    </span>
  );
}

/** «What to do» for an error that is still the latest news of the provider */
function FixHint({ name, e, testId, title }: { name: TravelName; e: ErrLike; testId: string; title?: boolean }) {
  const { t } = useI18n();
  const kind: DiagKind | null = diagKind(e.reason, e.code);
  const key = (kind ? `trv.fix.${kind}` : "trv.fix.generic") as MessageKey;
  const meta = PROVIDER_META[name];
  return (
    <div className={cx("trv-diag", `tone-${kind ? diagTone(kind) : "warn"}`)} data-testid={testId} data-kind={kind ?? "generic"}>
      {title && (
        <>
          <div className="trv-diag-t">
            <Icon name="alertCircle" />
            <b>{diagTitle(t, e)}</b>
          </div>
          <ErrorCodes e={e} />
        </>
      )}
      <div className="trv-diag-h">
        <Icon name="wrench" />
        <span>{t("trv.whatToDo")}</span>
      </div>
      <p>{t(key, { var: meta.keyVar, quotaVar: meta.quotaVar, enableVar: meta.enableVar })}</p>
    </div>
  );
}

type ProbeState =
  | { s: "idle" }
  | { s: "busy" }
  | { s: "done"; r: TravelProviderProbe }
  | { s: "limited"; retry: number }
  | { s: "error"; e: unknown };

/**
 * «Check now»: one test call of the provider through provider-gateway (no cache). The button is locked for the
 * gateway's window (30 s after a probe, or retry_after of a 429) with a live countdown; the card is re-read after.
 */
export function ProbeBlock({ name, onProbed, onResult }: { name: TravelName; onProbed?: () => void; onResult?: (r: TravelProviderProbe | null) => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const [st, setSt] = useState<ProbeState>({ s: "idle" });
  const [until, setUntil] = useState<number | null>(null);
  const now = useNow(until !== null);
  const left = lockLeft(until, now);
  useEffect(() => {
    if (until !== null && left === 0) setUntil(null);
  }, [left, until]);

  const run = async () => {
    if (st.s === "busy" || left > 0) return;
    setSt({ s: "busy" });
    try {
      const r = await TravelApi.probe(name);
      setSt({ s: "done", r });
      onResult?.(r);
      setUntil(Date.now() + PROBE_COOLDOWN_S * 1000);
      onProbed?.();
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        const retry = Math.max(1, Math.min(300, e.num("retry_after") ?? PROBE_COOLDOWN_S));
        setSt({ s: "limited", retry });
        setUntil(Date.now() + retry * 1000);
        return;
      }
      setSt({ s: "error", e }); // the text is built at render: it follows a language switch
    }
  };

  const r = st.s === "done" ? st.r : null;
  return (
    <div className="trv-probe" data-testid={`trv-probe-${name}`} data-state={st.s === "done" ? (st.r.ok ? "ok" : "fail") : st.s}>
      <div className="trv-probe-row">
        <Btn
          size="sm"
          icon="stethoscope"
          label={left > 0 ? t("trv.probe.wait", { s: left }) : t("trv.probe.btn")}
          busy={st.s === "busy"}
          disabled={left > 0}
          onClick={() => void run()}
          testId={`trv-probe-btn-${name}`}
        />
        <span className="trv-probe-res" role="status" aria-live="polite" data-testid={`trv-probe-res-${name}`}>
          {st.s === "busy" && <span className="muted small">{t("trv.probe.running")}</span>}
          {r && (
            <>
              <Pill tone={r.ok ? "good" : "bad"}>{r.ok ? t("trv.probe.ok") : t("trv.probe.fail")}</Pill>
              <span className="xs muted">
                {[r.latency_ms != null ? t("trv.probe.ms", { n: fmt.num(r.latency_ms) }) : null, t("trv.probe.at", { t: fmt.time(r.checked_at) })].filter(Boolean).join(" · ")}
              </span>
            </>
          )}
          {st.s === "limited" && <span className="small trv-probe-wait">{t("trv.probe.limited", { s: left || st.retry })}</span>}
          {st.s === "idle" && <span className="xs muted">{t("trv.probe.hint")}</span>}
        </span>
      </div>
      {r && !r.ok && <FixHint name={name} e={r} title testId={`trv-probe-fix-${name}`} />}
      {st.s === "error" && (
        <Callout kind="bad" icon="alertCircle" testId={`trv-probe-err-${name}`}>
          <b>{st.e instanceof ApiError && st.e.cancelled ? t("stepup.cancelled") : errText(i, st.e)}</b>
          {errMeta(st.e) && <span className="xs muted block mono">{errMeta(st.e)}</span>}
        </Callout>
      )}
    </div>
  );
}

function SetupHint({ name }: { name: TravelProviderStatus["name"] }) {
  const { t } = useI18n();
  return (
    <div className="trv-setup" data-testid={`trv-setup-${name}`}>
      <div className="trv-setup-h">
        <Icon name="key" />
        <span>{t("trv.setup.t")}</span>
      </div>
      <ul>
        {PROVIDER_META[name].vars.map((v) => (
          <li key={v.name}>
            <span className="trv-var">
              <code className="code-chip">{v.name}</code>
              {v.secret && (
                <Pill tone="outline" dot={false}>
                  {t("trv.secret")}
                </Pill>
              )}
              {v.optional && (
                <Pill tone="neutral" dot={false}>
                  {t("trv.optional")}
                </Pill>
              )}
              <CopyBtn value={v.name} label={v.name} />
            </span>
            <span className="xs muted">{t(`trv.var.${v.name}` as MessageKey)}</span>
          </li>
        ))}
      </ul>
      <p className="xs muted">{t("trv.setup.after")}</p>
    </div>
  );
}
