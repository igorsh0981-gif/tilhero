/**
 * Control of AI (sprint 8, INTERNAL_API §7, AT-98; on «Затраты и лимиты»): the levels of degradation — normal →
 * economy (the fallback model) → paid_only (AI only for subscribers; free learners get the simple mode before any call)
 * → off — switched automatically by the share of the month's cap (economy_at_percent, paid_only_at_percent) or set by
 * hand (costs.manage + step-up + a reason; an event and an audit record); the history of level changes; and the cost of
 * activities — a lesson, a scenario, a lesson for two: sessions, AI sessions, cost, p50 / p95 of an AI session, AI
 * minutes charged and the cost of an AI minute, the share of degraded activities.
 */
import { useCallback, useEffect, useState } from "react";
import type { AiDegradationView, AiUnitCosts, DegradationLevel, DegradationMode } from "@tilhero/contracts/admin";
import { Ai } from "../../api/endpoints";
import { uuid } from "../../lib/ids";
import { useI18n, type MessageKey } from "../../i18n";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, FieldErr, Pill, Seg, Select, Spinner } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { errText } from "../../ui/errors";
import { useToast } from "../../ui/toasts";
import { CommandKey } from "../memory/model";
import { DEG_LEVELS, DEG_MODES, degradationProblem, LEVEL_TONE, NOTE_MAX, NOTE_MIN, type DegradationForm } from "../money/model";
import { StepUpNote } from "../social/parts";

const formOf = (d: AiDegradationView): DegradationForm => ({ mode: d.mode, manual_level: d.manual_level ?? d.level, economy: String(d.economy_at_percent), paid_only: String(d.paid_only_at_percent) });

export function DegradationCard() {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { can } = useSession();
  const toast = useToast();
  const [d, setD] = useState<AiDegradationView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [f, setF] = useState<DegradationForm | null>(null);
  const [ask, setAsk] = useState(false);
  const [tried, setTried] = useState(false);
  const [key] = useState(() => new CommandKey(uuid));
  const load = useCallback(() => {
    Ai.degradation()
      .then((x) => (setD(x), setF(formOf(x)), setError(null)))
      .catch(setError);
  }, []);
  useEffect(load, [load]);
  const manage = can("costs.manage");
  const problem = f ? degradationProblem(f) : null;
  const dirty = !!d && !!f && JSON.stringify(f) !== JSON.stringify(formOf(d));
  return (
    <section className="card stack sm" aria-labelledby="deg-h" data-testid="deg">
      <div className="row between">
        <h2 className="h2" id="deg-h">
          <Icon name="gauge" /> {t("deg.title")}
        </h2>
        {d && (
          <Pill tone={LEVEL_TONE[d.level]} testId="deg-level">
            {t(`dlv.${d.level}` as MessageKey)}
          </Pill>
        )}
      </div>
      <p className="small muted">{t("deg.lead")}</p>
      {error && !d ? (
        <LoadError error={error} onRetry={load} testId="deg-error" />
      ) : !d || !f ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <>
          <div className="row" data-testid="deg-now">
            <span className="small">{t("deg.now", { m: t(`dmode.${d.mode}` as MessageKey), p: fmt.pct(d.spent_percent), mo: d.month })}</span>
          </div>
          <ul className="small deg-levels">
            {DEG_LEVELS.map((l) => (
              <li key={l} className={cx(d.level === l && "is-current")} aria-current={d.level === l ? "true" : undefined} data-testid={`deg-l-${l}`}>
                <b>{t(`dlv.${l}` as MessageKey)}</b> — {t(`dlv.h.${l}` as MessageKey, { e: d.economy_at_percent, p: d.paid_only_at_percent })}
                {d.level === l && <span className="tag">{t("deg.current")}</span>}
              </li>
            ))}
          </ul>
          {manage ? (
            <div className="stack sm" data-testid="deg-form">
              <Seg<DegradationMode> label={t("deg.mode")} value={f.mode} onChange={(v) => setF({ ...f, mode: v })} testId="deg-mode" items={DEG_MODES.map((v) => ({ v, label: t(`dmode.${v}` as MessageKey) }))} />
              <div className="row wrap">
                {f.mode === "manual" && (
                  <div className="field">
                    <label htmlFor="deg-manual">{t("deg.manualLevel")}</label>
                    <Select<DegradationLevel> id="deg-manual" label={t("deg.manualLevel")} value={f.manual_level} onChange={(v) => setF({ ...f, manual_level: v })} options={DEG_LEVELS.map((v) => ({ v, label: t(`dlv.${v}` as MessageKey) }))} testId="deg-manual" />
                  </div>
                )}
                <div className="field">
                  <label htmlFor="deg-economy">{t("deg.economyAt")}</label>
                  <input id="deg-economy" className={cx("input num", tried && (problem === "economy" || problem === "order") && "is-invalid")} inputMode="numeric" value={f.economy} onChange={(e) => setF({ ...f, economy: e.target.value })} data-testid="deg-economy" />
                </div>
                <div className="field">
                  <label htmlFor="deg-paid">{t("deg.paidOnlyAt")}</label>
                  <input id="deg-paid" className={cx("input num", tried && (problem === "paid_only" || problem === "order") && "is-invalid")} inputMode="numeric" value={f.paid_only} onChange={(e) => setF({ ...f, paid_only: e.target.value })} data-testid="deg-paid" />
                </div>
              </div>
              <FieldErr msg={tried && problem ? t(`deg.p.${problem}` as MessageKey) : null} />
              <div className="acts">
                <Btn kind={dirty ? "primary" : ""} icon="check" label={t("common.save")} disabled={!dirty} onClick={() => (setTried(true), !problem && setAsk(true))} testId="deg-save" />
                {dirty && <Btn kind="ghost" label={t("common.cancel")} onClick={() => (setF(formOf(d)), setTried(false))} />}
              </div>
            </div>
          ) : (
            <p className="xs muted row" data-testid="deg-ro">
              <Icon name="lock" /> {t("perm.need", { p: "costs.manage" })}
            </p>
          )}
          <h3 className="h3">{t("deg.history")}</h3>
          {d.events.length ? (
            <div className="table-wrap">
              <table className="tbl dense" data-testid="deg-events">
                <caption className="sr-only">{t("deg.history")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("pay.col.when")}</th>
                    <th scope="col">{t("deg.change")}</th>
                    <th scope="col">{t("deg.reason")}</th>
                    <th scope="col">{t("pay.col.who")}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.events.map((e) => (
                    <tr key={e.seq}>
                      <td className="small nowrap">{fmt.dateTime(e.at)}</td>
                      <td className="small">
                        {t(`dlv.${e.from}` as MessageKey)} → <b>{t(`dlv.${e.to}` as MessageKey)}</b>
                        <span className="xs muted block">{fmt.pct(e.spent_percent)}</span>
                      </td>
                      <td className="small">{t(`dreason.${e.reason}` as MessageKey)}</td>
                      <td className="small">{e.actor_name ?? t("mny.system")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="small muted">{t("deg.noEvents")}</p>
          )}
          {ask && (
            <ConfirmCommand
              title={t("deg.saveT")}
              text={f.mode === "manual" ? t("deg.saveManual", { l: t(`dlv.${f.manual_level}` as MessageKey) }) : t("deg.saveAuto", { e: f.economy, p: f.paid_only })}
              icon="gauge"
              ok={t("common.save")}
              minReason={NOTE_MIN}
              maxReason={NOTE_MAX}
              testId="deg-dialog"
              extra={
                <>
                  {f.mode === "manual" && (f.manual_level === "paid_only" || f.manual_level === "off") && (
                    <Callout kind="warn" icon="alert" testId="deg-warn">
                      {t(`deg.warn.${f.manual_level}` as MessageKey)}
                    </Callout>
                  )}
                  <StepUpNote />
                </>
              }
              onClose={() => setAsk(false)}
              onConfirm={async (reason) => {
                const body = { mode: f.mode, manual_level: f.mode === "manual" ? f.manual_level : null, economy_at_percent: Number(f.economy), paid_only_at_percent: Number(f.paid_only), reason };
                // the key — by the command itself, never by updated_at (a lost answer repeats with the same key)
                const k = key.for(JSON.stringify(["degradation", body]));
                try {
                  const x = await Ai.putDegradation(body, k);
                  key.settle();
                  setD(x);
                  setF(formOf(x));
                  setTried(false);
                  toast(t("deg.saved"), "ok", "ai.degradation_updated");
                  return null;
                } catch (e) {
                  key.settle(e);
                  return (e as { cancelled?: boolean })?.cancelled ? t("stepup.cancelled") : errText(i18n, e);
                }
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

const KINDS = ["lesson", "scenario", "pair"] as const;
/** "0.012345" → «$0.012345» (strings with 6 digits from ai-gateway, never parsed into floats for sums) */
const usd6 = (s: string | null) => (s == null ? "—" : `$${s.replace(/0{1,4}$/, "")}`);

export function UnitCostsCard() {
  const { t, fmt } = useI18n();
  const [period, setPeriod] = useState<AiUnitCosts["period"]>("month");
  const [u, setU] = useState<AiUnitCosts | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    Ai.unitCosts(period)
      .then((x) => (setU(x), setError(null)))
      .catch(setError);
  }, [period]);
  useEffect(load, [load]);
  return (
    <section className="card stack sm" aria-labelledby="uc-h" data-testid="uc">
      <div className="row between">
        <h2 className="h2" id="uc-h">
          {t("uc.title")}
        </h2>
        <Seg<AiUnitCosts["period"]> label={t("cs.period")} value={period} onChange={setPeriod} testId="uc-period" items={(["week", "month"] as const).map((v) => ({ v, label: t(`usp.${v}`) }))} />
      </div>
      <p className="small muted">{t("uc.lead")}</p>
      {error && !u ? (
        <LoadError error={error} onRetry={load} testId="uc-error" />
      ) : !u ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <>
          <div className="table-wrap">
            <table className="tbl compact" data-testid="uc-rows">
              <caption className="sr-only">{t("uc.title")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("uc.kind")}</th>
                  <th scope="col" className="r">
                    {t("uc.sessions")}
                  </th>
                  <th scope="col" className="r">
                    {t("uc.cost")}
                  </th>
                  <th scope="col" className="r">
                    {t("uc.p50p95")}
                  </th>
                  <th scope="col" className="r">
                    {t("uc.minutes")}
                  </th>
                  <th scope="col" className="r">
                    {t("uc.perMinute")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {KINDS.map((k) => {
                  const x = u.by_kind[k];
                  return (
                    <tr key={k} data-testid={`uc-${k}`}>
                      <td className="small">{t(`uc.k.${k}` as MessageKey)}</td>
                      <td className="r num">
                        {fmt.num(x.ai_sessions)} / {fmt.num(x.sessions)}
                      </td>
                      <td className="r num">{usd6(x.cost_usd)}</td>
                      <td className="r num">
                        {usd6(x.cost_per_ai_session_p50_usd)} · {usd6(x.cost_per_ai_session_p95_usd)}
                      </td>
                      <td className="r num">{fmt.num(x.billable_minutes)}</td>
                      <td className="r num" data-testid={`uc-${k}-minute`}>
                        {usd6(x.cost_per_billable_minute_usd)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small" data-testid="uc-degraded">
            {t("uc.degraded", { p: u.degraded_sessions_pct != null ? fmt.pct(u.degraded_sessions_pct) : "—" })}
          </p>
          <p className="xs muted">{t("uc.note")}</p>
        </>
      )}
    </section>
  );
}
