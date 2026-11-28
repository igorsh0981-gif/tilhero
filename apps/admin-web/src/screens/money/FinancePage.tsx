/**
 * «Финансовый обзор» (ADM-DASH-04, AT-99; billing.read | dashboard.read; rates — billing.manage): the revenue of the
 * site (sums) and of the Mini App (Telegram Stars) side by side, never added up as one currency; the estimate of the
 * Stars revenue in sums by the Star rate of finance (marked «оценка»); refunds, subscriptions, trials and conversion,
 * minutes (granted, spent, burnt, revoked, overage — never charged to a learner); AI costs in USD and in sums by the USD
 * rate, the cost of an AI minute, the forecast to the end of the month (UTC), «the cap needed», the level of
 * degradation; the margin — without the fees of the providers and of the app stores (no data). All figures are
 * integers from admin-bff (tiyin, Stars, micro-dollars). A block whose source is down shows its own notice.
 * The rates (USD and Star) with their history, and the providers: enabled and «ключ задан / не задан» only — the keys
 * are never shown or entered here. Route: #/finance.
 */
import { useCallback, useEffect, useState } from "react";
import type { BillingProviderStatus, FinanceOverview, FxRate, StarRate } from "@tilhero/contracts/admin";
import { Billing, Finance } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, FieldErr, Pill, Seg, Spinner } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { errText } from "../../ui/errors";
import { useToast } from "../../ui/toasts";
import { Kv } from "../ai/parts";
import { LEVEL_TONE, NOTE_MAX, NOTE_MIN, parseCount, parseSums, REPORT_PERIODS, WEB_PROVIDERS, type ReportPeriod } from "./model";
import { EstimateTag, Kpi, staffName, useMoney } from "./parts";

export function FinancePage() {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { can } = useSession();
  const { navigate } = useNav();
  const money = useMoney();
  const [period, setPeriod] = useState<ReportPeriod>("month");
  const [o, setO] = useState<FinanceOverview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    Finance.overview(period)
      .then((x) => (setO(x), setError(null)))
      .catch(setError);
  }, [period]);
  useEffect(load, [load]);
  const r = o?.revenue ?? null;
  const ai = o?.ai ?? null;
  return (
    <div className="stack" data-testid="finance">
      <div className="dash-head">
        <Seg<ReportPeriod> label={t("fin.period")} value={period} onChange={setPeriod} testId="fin-period" items={REPORT_PERIODS.map((v) => ({ v, label: t(`fin.p.${v}` as MessageKey) }))} />
        <span className="grow" />
        {o && (
          <span className="small muted" data-testid="fin-range">
            {t("fin.range", { a: fmt.dateTime(o.from), b: fmt.dateTime(o.to) })}
          </span>
        )}
        <Btn size="sm" icon="refresh" label={t("common.refresh")} onClick={load} testId="fin-refresh" />
      </div>
      {error && !o ? <LoadError error={error} onRetry={load} /> : null}
      {!o && !error ? <Spinner label={t("common.loading")} /> : null}
      {o && (
        <>
          <Callout icon="info" testId="fin-no-fees">
            {t("fin.noFees")}
          </Callout>
          <div className="grid2">
            <section className="card stack sm" aria-labelledby="fin-web-h" data-testid="fin-web" data-available={String(!!r)}>
              <h2 className="h2" id="fin-web-h">
                <Icon name="globe" /> {t("fin.web")}
              </h2>
              {!r ? (
                <Off service="billing" />
              ) : (
                <>
                  <div className="kpis mem-kpis">
                    <Kpi label={t("fin.revenue")} value={money.sum(r.web.revenue_tiyin)} testId="fin-web-revenue" />
                    <Kpi label={t("fin.refunds")} value={money.sum(r.web.refunds_tiyin)} />
                    <Kpi label={t("fin.net")} value={money.sum(r.web.net_tiyin)} tone={r.web.net_tiyin < 0 ? "bad" : undefined} testId="fin-web-net" />
                  </div>
                  {WEB_PROVIDERS.map((p) => (
                    <Kv key={p} k={t(`bprv.${p}` as MessageKey)} v={t("fin.byProvider", { a: money.sum(r.web.by_provider[p].revenue_tiyin), n: fmt.num(r.web.by_provider[p].orders) })} testId={`fin-web-${p}`} />
                  ))}
                  <Kv k={t("fin.ordersPaid")} v={fmt.num(r.web.orders_paid)} />
                </>
              )}
            </section>
            <section className="card stack sm" aria-labelledby="fin-stars-h" data-testid="fin-stars" data-available={String(!!r)}>
              <h2 className="h2" id="fin-stars-h">
                <Icon name="star" /> {t("fin.stars")}
              </h2>
              {!r ? (
                <Off service="billing" />
              ) : (
                <>
                  <div className="kpis mem-kpis">
                    <Kpi label={t("fin.revenue")} value={money.stars(r.stars.revenue_stars)} testId="fin-stars-revenue" />
                    <Kpi label={t("fin.refunds")} value={money.stars(r.stars.refunds_stars)} />
                    <Kpi label={t("fin.net")} value={money.stars(r.stars.net_stars)} testId="fin-stars-net" />
                  </div>
                  <Kv
                    k={
                      <>
                        {t("fin.starsInSums")} <EstimateTag testId="fin-stars-est-tag" />
                      </>
                    }
                    v={r.stars.est_net_tiyin != null ? money.sum(r.stars.est_net_tiyin) : <span className="muted">{t("fin.noStarRate")}</span>}
                    testId="fin-stars-est"
                  />
                  <Kv k={t("fin.ordersPaid")} v={fmt.num(r.stars.orders_paid)} />
                  <Kv k={t("fin.renewals")} v={fmt.num(r.stars.renewals)} />
                  <p className="xs muted">{t("fin.starsNote")}</p>
                </>
              )}
            </section>
            <section className="card stack sm" aria-labelledby="fin-subs-h" data-testid="fin-subs">
              <h2 className="h2" id="fin-subs-h">
                <Icon name="users" /> {t("fin.subs")}
              </h2>
              {!r ? (
                <Off service="billing" />
              ) : (
                <>
                  <Kv k={t("fin.active")} v={fmt.num(r.active_subscriptions)} testId="fin-active" />
                  <Kv k={t("fin.starsLive")} v={fmt.num(r.stars_subscriptions_live)} />
                  <Kv k={t("fin.trials")} v={t("fin.trialsV", { s: fmt.num(r.trials_started), c: fmt.num(r.trials_converted) })} />
                  <Kv k={t("fin.conversion")} v={r.conversion_pct != null ? fmt.pct(r.conversion_pct) : "—"} />
                  <Kv k={t("fin.refundsDone")} v={fmt.num(r.refunds_count)} testId="fin-refunds-count" />
                  <Kv
                    k={t("fin.reconOpen")}
                    testId="fin-recon-open"
                    v={
                      can("billing.read") && r.recon_open ? (
                        <button type="button" className="tr" onClick={() => navigate("reconciliation")} data-testid="fin-recon-link">
                          {fmt.num(r.recon_open)}
                        </button>
                      ) : (
                        fmt.num(r.recon_open)
                      )
                    }
                  />
                  <h3 className="h4">{t("fin.minutes")}</h3>
                  {(["granted", "spent", "expired", "revoked", "overage"] as const).map((k) => (
                    <Kv key={k} k={t(`fin.min.${k}` as MessageKey)} v={fmt.num(r.minutes[k])} testId={`fin-min-${k}`} />
                  ))}
                  <p className="xs muted">{t("fin.overageNote")}</p>
                </>
              )}
            </section>
            <section className="card stack sm" aria-labelledby="fin-ai-h" data-testid="fin-ai" data-available={String(!!ai)}>
              <h2 className="h2" id="fin-ai-h">
                <Icon name="cpu" /> {t("fin.ai")}
              </h2>
              {!ai ? (
                <Off service="ai-gateway" />
              ) : (
                <>
                  <div className="row">
                    <Pill tone={LEVEL_TONE[ai.level]} testId="fin-ai-level">
                      {t(`dlv.${ai.level}` as MessageKey)}
                    </Pill>
                    <span className="small muted">{t("fin.capUsed", { p: fmt.pct(ai.cap_used_pct), c: money.usd(ai.monthly_cap_micro_usd) })}</span>
                  </div>
                  <Kv k={t("fin.aiSpent")} v={`${money.usd(ai.spent_micro_usd)} · ${ai.spent_tiyin != null ? money.sum(ai.spent_tiyin) : t("fin.noFx")}`} testId="fin-ai-spent" />
                  <Kv k={t("fin.perMinute")} v={ai.cost_per_minute_micro_usd != null ? `${money.usd(ai.cost_per_minute_micro_usd)}${ai.cost_per_minute_tiyin != null ? ` · ${money.sum(ai.cost_per_minute_tiyin)}` : ""}` : "—"} testId="fin-ai-minute" />
                  <Kv k={t("fin.forecast")} v={money.usd(ai.forecast_month_micro_usd)} testId="fin-ai-forecast" />
                  <Kv k={t("fin.neededCap")} v={money.usd(ai.needed_cap_micro_usd)} testId="fin-ai-needed" />
                  <p className="xs muted">{t("fin.neededNote")}</p>
                  {can("costs.read") && (
                    <p className="xs muted row">
                      <Icon name="gauge" /> {t("fin.toCosts")}
                    </p>
                  )}
                </>
              )}
            </section>
          </div>
          <section className={cx("card stack sm fin-margin", o.margin && o.margin.net_tiyin < 0 && "is-bad")} aria-labelledby="fin-m-h" data-testid="fin-margin">
            <h2 className="h2" id="fin-m-h">
              {t("fin.margin")} {o.margin?.estimated && <EstimateTag testId="fin-margin-est" />}
            </h2>
            {o.margin ? (
              <p className="kpi-v" data-testid="fin-margin-v">
                {money.sum(o.margin.net_tiyin)}
              </p>
            ) : (
              <p className="small muted" data-testid="fin-margin-none">
                {t("fin.marginNone")}
              </p>
            )}
            <p className="xs muted">{t("fin.marginNote")}</p>
            <p className="xs muted" data-testid="fin-rates-used">
              {o.fx ? t("fin.fxUsed", { r: money.sum(o.fx.usd_in_tiyin), d: o.fx.valid_from }) : t("fin.noFx")} ·{" "}
              {o.star_rate ? t("fin.starUsed", { r: money.sum(o.star_rate.star_in_tiyin), d: o.star_rate.valid_from }) : t("fin.noStarRate")}
            </p>
          </section>
          {can("billing.read") && (
            <div className="grid2">
              <Rates kind="fx" />
              <Rates kind="star" />
            </div>
          )}
          {can("billing.read") && <Providers />}
        </>
      )}
    </div>
  );
}

function Off({ service }: { service: string }) {
  const { t } = useI18n();
  return (
    <Callout kind="warn" icon="alert" testId={`fin-off-${service}`}>
      <b>{t("dash.off.t")}</b> {t("dash.off.m", { s: service })}
    </Callout>
  );
}

/** The USD rate (tiyin for 1 USD) or the Star rate (an estimate of the reward for 1 Star, tiyin) with its history. */
function Rates({ kind }: { kind: "fx" | "star" }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { can } = useSession();
  const toast = useToast();
  const money = useMoney();
  const [items, setItems] = useState<Array<FxRate | StarRate> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [value, setValue] = useState("");
  // by default — today of Tashkent (the reports of billing count days of Asia/Tashkent)
  const [from, setFrom] = useState(() => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10));
  const [ask, setAsk] = useState<{ tiyin: number; from: string } | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const load = useCallback(() => {
    (kind === "fx" ? Billing.fx() : Billing.starRate())
      .then((r) => (setItems(r.items), setError(null)))
      .catch(setError);
  }, [kind]);
  useEffect(load, [load]);
  const rateOf = (x: FxRate | StarRate) => ("usd_in_tiyin" in x ? x.usd_in_tiyin : x.star_in_tiyin);
  const submit = () => {
    // USD: whole sums (12 850 → 1 285 000 tiyin); Star: tiyin as typed (an estimate below one sum is allowed)
    const tiyin = kind === "fx" ? parseSums(value) : parseCount(value);
    const ok = tiyin != null && (kind === "fx" ? tiyin >= 100_000 && tiyin <= 100_000_000 : tiyin >= 1 && tiyin <= 10_000_000);
    if (!ok) return setFormErr(t(kind === "fx" ? "fin.fxRange" : "fin.starRange"));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return setFormErr(t("fin.fromRequired"));
    setFormErr(null);
    setAsk({ tiyin: tiyin!, from });
  };
  const id = `fin-${kind}`;
  return (
    <section className="card stack sm" aria-labelledby={`${id}-h`} data-testid={id}>
      <h2 className="h2" id={`${id}-h`}>
        {t(kind === "fx" ? "fin.fxT" : "fin.starT")}
      </h2>
      <p className="small muted">{t(kind === "fx" ? "fin.fxM" : "fin.starM")}</p>
      {error && !items ? (
        <LoadError error={error} onRetry={load} />
      ) : !items ? (
        <Spinner label={t("common.loading")} />
      ) : items.length ? (
        <div className="table-wrap">
          <table className="tbl dense" data-testid={`${id}-rows`}>
            <caption className="sr-only">{t(kind === "fx" ? "fin.fxT" : "fin.starT")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("fin.validFrom")}</th>
                <th scope="col" className="r">
                  {t("fin.rate")}
                </th>
                <th scope="col">{t("pay.col.who")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((x) => (
                <tr key={`${x.valid_from}-${x.created_at}`}>
                  <td className="small nowrap">{x.valid_from}</td>
                  <td className="r num">{money.sum(rateOf(x))}</td>
                  <td className="small">
                    {staffName(x.set_by, t("mny.system"))}
                    <span className="xs muted block wrap-any">{x.reason}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small muted" data-testid={`${id}-none`}>
          {t("fin.noRates")}
        </p>
      )}
      {can("billing.manage") ? (
        <div className="row wrap" data-testid={`${id}-form`}>
          <div className="field">
            <label htmlFor={`${id}-v`}>{t(kind === "fx" ? "fin.fxInput" : "fin.starInput")}</label>
            <input id={`${id}-v`} className="input num" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} data-testid={`${id}-v`} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-from`}>{t("fin.validFrom")}</label>
            <input id={`${id}-from`} type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} data-testid={`${id}-from`} />
          </div>
          <div className="field">
            <span className="field-label" aria-hidden="true">
              &nbsp;
            </span>
            <Btn size="sm" kind="primary" icon="check" label={t("fin.setRate")} onClick={submit} testId={`${id}-set`} />
          </div>
          <FieldErr msg={formErr} />
        </div>
      ) : (
        <p className="xs muted row">
          <Icon name="lock" /> {t("perm.need", { p: "billing.manage" })}
        </p>
      )}
      {ask && (
        <ConfirmCommand
          title={t(kind === "fx" ? "fin.fxT" : "fin.starT")}
          text={t("fin.setRateM", { r: money.sum(ask.tiyin), d: ask.from })}
          icon="coins"
          ok={t("fin.setRate")}
          minReason={NOTE_MIN}
          maxReason={NOTE_MAX}
          testId={`${id}-dialog`}
          onClose={() => setAsk(null)}
          onConfirm={async (reason) => {
            try {
              if (kind === "fx") await Billing.putFx({ usd_in_tiyin: ask.tiyin, valid_from: ask.from, reason });
              else await Billing.putStarRate({ star_in_tiyin: ask.tiyin, valid_from: ask.from, reason });
              toast(t("fin.rateSaved"), "ok", kind === "fx" ? "billing.fx_updated" : "billing.star_rate_updated");
              setValue("");
              load();
              return null;
            } catch (e) {
              return e instanceof ApiError && e.code === "FX_INVALID" ? t("err.FX_INVALID") : errText(i18n, e);
            }
          }}
        />
      )}
      <p className="xs muted">{t("fin.rateNote", { d: fmt.date(new Date().toISOString()) })}</p>
    </section>
  );
}

/** Providers: switched on and «ключ задан / не задан» — never a key. */
function Providers() {
  const { t, fmt } = useI18n();
  const [items, setItems] = useState<BillingProviderStatus[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    Billing.providers()
      .then((r) => (setItems(r.items), setError(null)))
      .catch(setError);
  }, []);
  useEffect(load, [load]);
  return (
    <section className="card stack sm" aria-labelledby="fin-prov-h" data-testid="fin-providers">
      <h2 className="h2" id="fin-prov-h">
        <Icon name="key" /> {t("fin.providers")}
      </h2>
      <p className="small muted">{t("fin.providersM")}</p>
      {error && !items ? (
        <LoadError error={error} onRetry={load} />
      ) : !items ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="table-wrap">
          <table className="tbl compact" data-testid="fin-providers-rows">
            <caption className="sr-only">{t("fin.providers")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("pay.f.provider")}</th>
                <th scope="col">{t("fin.enabled")}</th>
                <th scope="col">{t("fin.configured")}</th>
                <th scope="col">{t("fin.lastCallback")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.provider} data-testid={`fin-prov-${p.provider}`}>
                  <td className="small">
                    <b>{t(`bprv.${p.provider}` as MessageKey)}</b>
                    <span className="xs muted block">{t(p.provider === "telegram_stars" ? "chn.miniapp" : "chn.web")}</span>
                  </td>
                  <td>
                    <Pill tone={p.enabled ? "good" : "neutral"}>{p.enabled ? t("fin.on") : t("fin.off")}</Pill>
                  </td>
                  <td>
                    <Pill tone={p.configured ? "good" : "warn"}>{t(p.provider === "telegram_stars" ? (p.configured ? "fin.botgwOk" : "fin.botgwDown") : p.configured ? "fin.keySet" : "fin.keyUnset")}</Pill>
                  </td>
                  <td className="small">
                    {p.last_callback_at ? fmt.dateTime(p.last_callback_at) : "—"}
                    {p.last_error_code && <span className="xs bad-ink block mono">{p.last_error_code}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="xs muted row">
        <Icon name="lock" /> {t("fin.keysNote")}
      </p>
    </section>
  );
}
