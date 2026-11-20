/**
 * «Затраты и лимиты» (costs.read; sprint 4, ADM-MONEY-01/02, AT-51): the month's spend against the cap (bar, percent
 * and the warning from alert_percent), spend per day (an accessible SVG bar chart with a table view), per agent and per
 * model (tables), the average cost of a lesson and the share of AI refusals; the settings (costs.manage, step-up and a
 * reason): monthly cap, learner's daily cap, lesson cap, alert threshold — saved against the `updated_at` that was read
 * (someone saved in between → 409 BUDGET_CONFLICT: the budget is re-read, the edited fields keep the entered values,
 * «проверьте и сохраните ещё раз» with the values saved now); and the EMERGENCY STOP of the AI — a big
 * switch with a confirmation and a reason. With the AI off the three sprint 4 sections show the banner «ИИ выключен —
 * уроки идут в упрощённом режиме» (lessons go on by choices, the learner sees a neutral notice).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AiBudget, AiUsageSummary } from "@tilhero/contracts/admin";
import { Ai, type BudgetInput } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n } from "../../i18n";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, FieldErr, Seg, Spinner } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { setAiEnabled } from "./aiState";
import { budgetForm, checkBudget, mergeBudgetForm, type BudgetForm } from "./model";
import { AiOffBanner, BarChart, BudgetBar, Kv, useKeyed, useUsd } from "./parts";

type UsagePeriod = AiUsageSummary["period"];

export function CostsPage() {
  const i = useI18n();
  const { t } = i;
  const [month, setMonth] = useState<AiUsageSummary | null>(null);
  const [monthErr, setMonthErr] = useState<unknown>(null);
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const [other, setOther] = useState<AiUsageSummary | null>(null);
  const [budget, setBudget] = useState<AiBudget | null>(null);
  const [budgetErr, setBudgetErr] = useState<unknown>(null);
  const loadMonth = useCallback(() => {
    Ai.usageSummary("month")
      .then((s) => {
        setMonth(s);
        setMonthErr(null);
        setAiEnabled(s.ai_enabled);
      })
      .catch(setMonthErr);
  }, []);
  const loadBudget = useCallback(() => {
    Ai.budget()
      .then((b) => {
        setBudget(b);
        setBudgetErr(null);
        setAiEnabled(b.ai_enabled);
      })
      .catch(setBudgetErr);
  }, []);
  /** BUDGET_CONFLICT: the budget as it is now (the settings card keeps the entered values) */
  const rereadBudget = useCallback(async () => {
    const b = await Ai.budget();
    setBudget(b);
    setBudgetErr(null);
    setAiEnabled(b.ai_enabled);
    loadMonth();
    return b;
  }, [loadMonth]);
  useEffect(() => {
    loadMonth();
    loadBudget();
  }, [loadMonth, loadBudget]);
  useEffect(() => {
    if (period === "month") {
      setOther(null);
      return;
    }
    let alive = true;
    Ai.usageSummary(period)
      .then((s) => alive && setOther(s))
      .catch(() => alive && setOther(null));
    return () => {
      alive = false;
    };
  }, [period]);
  const sum = period === "month" ? month : other;
  const onBudget = (b: AiBudget) => {
    setBudget(b);
    setAiEnabled(b.ai_enabled);
    loadMonth();
  };
  return (
    <div className="stack" data-testid="costs">
      <AiOffBanner />
      <div className="grid2 costs-top">
        <section className="card stack sm" aria-labelledby="cs-month-h" data-testid="cs-month">
          <div className="row between">
            <h2 className="h2" id="cs-month-h">
              {t("cs.month")}
            </h2>
            <Btn size="xs" kind="ghost" icon="refresh" label={t("common.refresh")} onClick={() => (loadMonth(), loadBudget())} testId="cs-refresh" />
          </div>
          {monthErr && !month ? (
            <LoadError error={monthErr} onRetry={loadMonth} />
          ) : !month ? (
            <Spinner label={t("common.loading")} />
          ) : (
            <MonthBody s={month} alert={budget?.alert_percent ?? month.alert_percent} />
          )}
        </section>
        <EmergencyCard budget={budget} error={budgetErr} onRetry={loadBudget} onChanged={onBudget} />
      </div>
      <section className="card stack sm" aria-labelledby="cs-usage-h" data-testid="cs-usage">
        <div className="row between">
          <h2 className="h2" id="cs-usage-h">
            {t("cs.usage")}
          </h2>
          <Seg<UsagePeriod> label={t("cs.period")} value={period} onChange={setPeriod} testId="cs-period" items={(["day", "week", "month"] as const).map((v) => ({ v, label: t(`usp.${v}`) }))} />
        </div>
        {!sum ? <Spinner label={t("common.loading")} /> : <UsageBody s={sum} />}
      </section>
      <SettingsCard budget={budget} error={budgetErr} onRetry={loadBudget} onSaved={onBudget} onConflict={rereadBudget} />
    </div>
  );
}

function MonthBody({ s, alert }: { s: AiUsageSummary; alert: number }) {
  const { t, fmt } = useI18n();
  const money = useUsd();
  return (
    <>
      <BudgetBar spent={s.spent_usd} cap={s.monthly_cap_usd} pct={s.cap_used_pct} alert={alert} testId="cs-bar" />
      <div className="kpis cs-kpis">
        <div className="kpi">
          <div className="kpi-l">{t("cs.calls")}</div>
          <div className="kpi-v">{fmt.num(s.calls)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-l">{t("cs.unavail")}</div>
          <div className={cx("kpi-v", (s.unavailable_pct ?? 0) >= 10 && "bad-ink")} data-testid="cs-unavail">
            {s.unavailable_pct != null ? fmt.pct(s.unavailable_pct) : "—"}
          </div>
          <div className="kpi-n">{t("cs.unavailN", { n: fmt.num(s.unavailable) })}</div>
        </div>
        <div className="kpi">
          <div className="kpi-l">{t("cs.avgLesson")}</div>
          <div className="kpi-v" data-testid="cs-avg-lesson">
            {money(s.avg_cost_per_lesson_usd)}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-l">{t("cs.p95")}</div>
          <div className="kpi-v">{s.p95_latency_ms != null ? `${fmt.num(s.p95_latency_ms)} ms` : "—"}</div>
        </div>
      </div>
    </>
  );
}

function UsageBody({ s }: { s: AiUsageSummary }) {
  const { t, fmt, lang } = useI18n();
  const money = useUsd();
  const k = useKeyed();
  const df = new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-US", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const days = s.by_day.map((d) => ({ key: d.date, label: df.format(new Date(`${d.date}T00:00:00Z`)), value: d.spent_usd, sub: t("cs.callsN", { n: fmt.num(d.calls) }) }));
  return (
    <div className="stack sm">
      <div className="row small muted">
        {t("cs.periodSum", { s: money(s.spent_usd), n: fmt.num(s.calls) })}
        {s.unavailable_pct != null && ` · ${t("cs.unavailShort", { p: fmt.pct(s.unavailable_pct) })}`}
      </div>
      <BarChart data={days} title={t("cs.byDay")} valueLabel={t("cs.spent")} format={(n) => money(n)} testId="cs-chart" />
      <SpeechBlock s={s} />
      <div className="grid2">
        <div className="stack sm">
          <h3 className="h3">{t("cs.byAgent")}</h3>
          <div className="table-wrap">
            <table className="tbl dense" data-testid="cs-agents">
              <caption className="sr-only">{t("cs.byAgent")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("cs.col.agent")}</th>
                  <th scope="col" className="r">
                    {t("cs.calls")}
                  </th>
                  <th scope="col" className="r">
                    {t("cs.col.unavail")}
                  </th>
                  <th scope="col" className="r">
                    {t("cs.spent")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.by_agent.map((a) => (
                  <tr key={a.agent_id}>
                    <td className="mono small">{a.agent_id}</td>
                    <td className="r num">{fmt.num(a.calls)}</td>
                    <td className="r num">
                      {fmt.num(a.unavailable)}
                      {a.calls > 0 && <span className="xs muted"> · {fmt.pct((a.unavailable / a.calls) * 100)}</span>}
                    </td>
                    <td className="r num">{money(a.spent_usd)}</td>
                  </tr>
                ))}
                {!s.by_agent.length && (
                  <tr>
                    <td colSpan={4} className="small muted">
                      {t("dash.noData")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="stack sm">
          <h3 className="h3">{t("cs.byModel")}</h3>
          <div className="table-wrap">
            <table className="tbl dense" data-testid="cs-models">
              <caption className="sr-only">{t("cs.byModel")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("mdl.col.model")}</th>
                  <th scope="col" className="r">
                    {t("cs.calls")}
                  </th>
                  <th scope="col" className="r">
                    {t("cs.col.tokens")}
                  </th>
                  <th scope="col" className="r">
                    {t("cs.spent")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.by_model.map((m) => (
                  <tr key={m.model_id}>
                    <td className="mono small">{m.model_id}</td>
                    <td className="r num">{fmt.num(m.calls)}</td>
                    <td className="r num small">
                      {fmt.num(m.input_tokens)} / {fmt.num(m.output_tokens)}
                    </td>
                    <td className="r num">{money(m.spent_usd)}</td>
                  </tr>
                ))}
                {!s.by_model.length && (
                  <tr>
                    <td colSpan={4} className="small muted">
                      {t("dash.noData")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <p className="xs muted">
        <Icon name="info" /> {t("cs.note", { p: k("usp", s.period) })}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- pronunciation (sprint 5) */

/** «Оценка произношения» (agent pronunciation_coach, Azure): calls, minutes of audio, spend — part of the period total. */
function SpeechBlock({ s }: { s: AiUsageSummary }) {
  const { t, fmt } = useI18n();
  const money = useUsd();
  const sp = s.speech;
  if (!sp) return null;
  return (
    <section className="cs-speech" aria-labelledby="cs-speech-h" data-testid="cs-speech" data-available={String(sp.speech_available)}>
      <div className="row between">
        <h3 className="h3" id="cs-speech-h">
          {t("cs.speech")}
        </h3>
        {sp.speech_available ? (
          <span className="pill good" data-testid="cs-speech-on">
            {t("cs.speechOn")}
          </span>
        ) : (
          <span className="pill warn" data-testid="cs-speech-off">
            <Icon name="alert" /> {t("cs.speechOff")}
          </span>
        )}
      </div>
      <div className="kpis cs-kpis">
        <div className="kpi">
          <div className="kpi-l">{t("cs.calls")}</div>
          <div className="kpi-v" data-testid="cs-speech-calls">
            {fmt.num(sp.calls)}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-l">{t("cs.speechMinutes")}</div>
          <div className="kpi-v" data-testid="cs-speech-minutes">
            {fmt.num(sp.audio_minutes, Number.isInteger(sp.audio_minutes) ? 0 : 1)}
          </div>
          <div className="kpi-n">{t("cs.speechMinutesN")}</div>
        </div>
        <div className="kpi">
          <div className="kpi-l">{t("cs.spent")}</div>
          <div className="kpi-v" data-testid="cs-speech-spent">
            {money(sp.spent_usd)}
          </div>
          <div className="kpi-n">{t("cs.speechShare", { s: money(s.spent_usd) })}</div>
        </div>
      </div>
      <p className="xs muted">{sp.speech_available ? t("cs.speechNote") : t("cs.speechOffM")}</p>
    </section>
  );
}

/* ---------------------------------------------------------------- emergency stop */

function EmergencyCard({ budget, error, onRetry, onChanged }: { budget: AiBudget | null; error: unknown; onRetry: () => void; onChanged: (b: AiBudget) => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const toast = useToast();
  const [ask, setAsk] = useState(false);
  const on = budget?.ai_enabled ?? null;
  return (
    <section className={cx("card stop-card", on === false && "is-off")} aria-labelledby="cs-stop-h" data-testid="cs-stop" data-ai={on == null ? "unknown" : on ? "on" : "off"}>
      <h2 className="h2" id="cs-stop-h">
        <Icon name="power" /> {t("cs.stop")}
      </h2>
      {error && !budget ? (
        <LoadError error={error} onRetry={onRetry} />
      ) : !budget ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <>
          <div className="stop-state" role="status">
            <span className={cx("stop-lamp", on ? "on" : "off")} aria-hidden="true" />
            <span>
              <b className="stop-t" data-testid="cs-stop-state">
                {on ? t("cs.aiOn") : t("cs.aiOff")}
              </b>
              <span className="small muted block">{on ? t("cs.aiOnM") : t("cs.aiOffM")}</span>
            </span>
          </div>
          {can("costs.manage") ? (
            <button type="button" className={cx("stop-switch", on ? "is-on" : "is-off")} role="switch" aria-checked={!on} aria-describedby="cs-stop-h" onClick={() => setAsk(true)} data-testid="cs-stop-btn">
              <span className="stop-knob" aria-hidden="true">
                <Icon name={on ? "power" : "play"} />
              </span>
              <span className="stop-label">{on ? t("cs.stopOn") : t("cs.stopOff")}</span>
            </button>
          ) : (
            <p className="xs muted row" data-testid="cs-stop-locked">
              <Icon name="lock" /> {t("perm.need", { p: "costs.manage" })}
            </p>
          )}
          <span className="xs muted">{t("cs.updatedAt", { t: fmt.dateTime(budget.updated_at) })}</span>
        </>
      )}
      {ask && budget && (
        <ConfirmCommand
          title={on ? t("cs.stopT") : t("cs.startT")}
          text={on ? t("cs.stopM") : t("cs.startM")}
          icon="power"
          tone={on ? "bad" : "warn"}
          ok={on ? t("cs.stopOk") : t("cs.startOk")}
          okKind={on ? "danger" : "primary"}
          minReason={10}
          testId="cs-stop-dialog"
          extra={
            <Callout kind="info" icon="smartphoneKey">
              {t("ct.stepUpNote")}
            </Callout>
          }
          onClose={() => setAsk(false)}
          onConfirm={async (reason) => {
            try {
              const b = await Ai.emergencyStop(!!on, reason);
              onChanged(b);
              toast(b.ai_enabled ? t("cs.started") : t("cs.stopped"), b.ai_enabled ? "ok" : "info", "ai.emergency_stop");
              return null;
            } catch (e) {
              if ((e as ApiError)?.cancelled) return t("stepup.cancelled");
              return errText(i, e);
            }
          }}
        />
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- settings */

const FIELDS: ReadonlyArray<{ k: keyof BudgetForm; unit: "usd" | "pct" }> = [
  { k: "monthly_cap_usd", unit: "usd" },
  { k: "learner_daily_cap_usd", unit: "usd" },
  { k: "lesson_cap_usd", unit: "usd" },
  { k: "alert_percent", unit: "pct" },
];

function SettingsCard({ budget, error, onRetry, onSaved, onConflict }: { budget: AiBudget | null; error: unknown; onRetry: () => void; onSaved: (b: AiBudget) => void; onConflict: () => Promise<AiBudget> }) {
  const i = useI18n();
  const { t } = i;
  const { can } = useSession();
  const toast = useToast();
  const money = useUsd();
  const [form, setForm] = useState<BudgetForm | null>(null);
  const [tried, setTried] = useState(false);
  const [ask, setAsk] = useState<BudgetInput | null>(null);
  /** someone else saved the limits in between (409 BUDGET_CONFLICT): the budget was re-read, the entered values stay */
  const [conflict, setConflict] = useState(false);
  /** the form to show over the re-read limits (set only when those limits differ — the effect below runs) */
  const keep = useRef<BudgetForm | null>(null);
  // re-filled only when the limits themselves change (the emergency stop must not drop unsaved edits)
  const limitsKey = budget ? JSON.stringify(budgetForm(budget)) : "";
  useEffect(() => {
    if (!limitsKey) return;
    setForm(keep.current ?? (JSON.parse(limitsKey) as BudgetForm));
    keep.current = null;
  }, [limitsKey]);
  const manage = can("costs.manage");
  if (error && !budget)
    return (
      <section className="card">
        <LoadError error={error} onRetry={onRetry} />
      </section>
    );
  if (!budget || !form) return null;
  const base = budgetForm(budget);
  const dirty = (Object.keys(form) as Array<keyof BudgetForm>).some((x) => form[x] !== base[x]);
  const saved = (k: keyof BudgetForm, unit: "usd" | "pct") => (unit === "usd" ? money(budget[k]) : `${budget[k]} %`);
  const chk = checkBudget(form);
  const issue = (f: keyof BudgetForm) => {
    const x = chk.issues.find((y) => y.field === f);
    return tried && x ? t(`csf.${x.code}`) : null;
  };
  return (
    <section className="card stack sm" aria-labelledby="cs-set-h" data-testid="cs-settings">
      <div className="row between">
        <h2 className="h2" id="cs-set-h">
          {t("cs.limits")}
        </h2>
        {!manage && (
          <span className="xs muted row" data-testid="cs-settings-locked">
            <Icon name="lock" /> {t("perm.need", { p: "costs.manage" })}
          </span>
        )}
      </div>
      <p className="small muted">{t("cs.limitsM")}</p>
      {conflict && (
        <div role="alert">
          <Callout kind="warn" icon="alert" testId="csf-conflict">
            {t("csf.conflict")}
          </Callout>
        </div>
      )}
      <div className="cs-grid">
        {FIELDS.map(({ k, unit }) => (
          <div key={k} className="field">
            <label htmlFor={`csf-${k}`} className="req">
              {t(`csf.l.${k}`)}
            </label>
            <div className="unit-input">
              {unit === "usd" && (
                <span className="unit" aria-hidden="true">
                  $
                </span>
              )}
              <input
                id={`csf-${k}`}
                className={cx("input num", issue(k) && "is-invalid")}
                inputMode="decimal"
                value={form[k]}
                readOnly={!manage}
                aria-invalid={!!issue(k)}
                aria-describedby={`csf-${k}-h`}
                onChange={(e) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f))}
                data-testid={`csf-${k}`}
              />
              {unit === "pct" && (
                <span className="unit" aria-hidden="true">
                  %
                </span>
              )}
            </div>
            <span className="hint" id={`csf-${k}-h`}>
              {t(`csf.h.${k}`)}
              {conflict && form[k] !== base[k] && (
                <b className="block" data-testid={`csf-${k}-saved`}>
                  {t("csf.savedNow", { v: saved(k, unit) })}
                </b>
              )}
            </span>
            <FieldErr msg={issue(k)} />
          </div>
        ))}
      </div>
      {manage && (
        <div className="acts">
          <Btn
            kind={dirty ? "primary" : ""}
            icon="check"
            label={t("common.save")}
            disabled={!dirty}
            onClick={() => {
              setTried(true);
              if (chk.value) setAsk(chk.value);
            }}
            testId="csf-save"
          />
          {dirty && <Btn kind="ghost" label={t("common.cancel")} onClick={() => (setForm(base), setTried(false), setConflict(false))} />}
        </div>
      )}
      {ask && (
        <ConfirmCommand
          title={t("csf.saveT")}
          text={t("csf.saveM", { m: money(ask.monthly_cap_usd), d: money(ask.learner_daily_cap_usd), l: money(ask.lesson_cap_usd), a: ask.alert_percent })}
          icon="gauge"
          ok={t("common.save")}
          testId="csf-dialog"
          extra={
            <Callout kind="info" icon="smartphoneKey">
              {t("ct.stepUpNote")}
            </Callout>
          }
          onClose={() => setAsk(null)}
          onConfirm={async (reason) => {
            try {
              const b = await Ai.putBudget(ask, budget.updated_at, reason);
              onSaved(b);
              setTried(false);
              setConflict(false);
              toast(t("csf.saved"), "ok", "ai.budget_updated");
              return null;
            } catch (e) {
              if ((e as ApiError)?.cancelled) return t("stepup.cancelled");
              if (e instanceof ApiError && e.code === "BUDGET_CONFLICT") {
                // another staff member saved in between: read the limits as they are now, keep what was entered
                const [read, entered] = [base, form];
                try {
                  const now = budgetForm(await onConflict());
                  if (JSON.stringify(now) !== limitsKey) keep.current = mergeBudgetForm(read, entered, now);
                } catch (re) {
                  return errText(i, re);
                }
                setConflict(true);
                return null;
              }
              return errText(i, e);
            }
          }}
        />
      )}
      <Kv k={t("csf.after")} v={t("csf.afterV")} />
    </section>
  );
}
