/**
 * The «Тариф» tab of the learner card in «Ученики» (ADM-USR-02, ADM-MONEY-02; billing.read): the subscription of the
 * learner's account (a child profile — its guardian's pool): status and tier, the current period with its minutes
 * (granted, spent, held, left; overage is never charged to the learner), active holds of running lessons, the Stars
 * subscription with auto-renewal, the periods, pending requests and the minutes ledger (append only: a correction is a
 * new entry). «Корректировка» (subscriptions.override + step-up + a reason ≥ 10) files a «four eyes» request — another
 * staff member applies it in «Корректировки». A separate route: the card works when billing is down.
 */
import { useCallback, useEffect, useState } from "react";
import type { AdminBillingAccount, AdminLedgerEntry, AdjustmentKind } from "@tilhero/contracts/admin";
import { Billing, Learners } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, Empty, FieldErr, Pill, Select, Spinner } from "../../ui/kit";
import { Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { CommandKey } from "../memory/model";
import { NoteField, StepUpNote, useCmdFail } from "../social/parts";
import { ADJ_KINDS, adjustmentBody, adjustmentSig, emptyAdjustment, PERIOD_TONE, STARS_SUB_TONE, SUB_TONE, type AdjustmentForm } from "./model";
import { useMoney, useMoneyIssue } from "./parts";

export function LearnerBillingTab({ id, child }: { id: string; child: boolean }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const money = useMoney();
  const [a, setA] = useState<AdminBillingAccount | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [ledger, setLedger] = useState<AdminLedgerEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [adjust, setAdjust] = useState(false);
  const load = useCallback(() => {
    setError(null);
    Learners.billing(id)
      .then((x) => {
        setA(x);
        // the ledger is a block of its own: its failure leaves the tab as it is
        Billing.ledger(x.account_id)
          .then((p) => (setLedger(p.items), setCursor(p.next_cursor)))
          .catch(() => setLedger([]));
      })
      .catch(setError);
  }, [id]);
  useEffect(load, [load]);
  if (error)
    return error instanceof ApiError && error.status === 404 ? (
      <Empty icon="card" title={t("lb.none")} text={t("lb.noneM")} testId="lb-none" />
    ) : (
      <LoadError error={error} onRetry={load} testId="lb-error" />
    );
  if (!a) return <Spinner label={t("common.loading")} />;
  const p = a.current_period;
  return (
    <div className="stack" data-testid="lb">
      {child && (
        <Callout icon="users" testId="lb-child">
          {t("lb.child")}
        </Callout>
      )}
      <div className="row">
        <Pill tone={SUB_TONE[a.status]} testId="lb-status">
          {t(`subst.${a.status}` as MessageKey)}
        </Pill>
        <Pill tone={a.tier === "paid" ? "good" : "neutral"} testId="lb-tier">
          {t(`tier.${a.tier}` as MessageKey)}
        </Pill>
        {a.expiring && <Pill tone="warn">{t("lb.expiring")}</Pill>}
        {a.minutes_exhausted && <Pill tone="bad">{t("lb.exhausted")}</Pill>}
        {a.trial_used && <Pill tone="neutral">{t("lb.trialUsed")}</Pill>}
        {a.pending_adjustments > 0 && (
          <button type="button" className="tr small" onClick={() => navigate("adjustments", a.account_id)} data-testid="lb-pending">
            {t("lb.pending", { n: a.pending_adjustments })}
          </button>
        )}
      </div>
      {p ? (
        <div className="kpis mem-kpis" data-testid="lb-period">
          <div className="card kpi">
            <div className="kpi-l">{t("lb.left")}</div>
            <div className="kpi-v" data-testid="lb-left">
              {p.balance ? fmt.num(p.balance.minutes_left) : "—"}
            </div>
            <div className="kpi-n">{p.balance ? t("lb.ofGranted", { g: fmt.num(p.balance.granted), s: fmt.num(p.balance.spent), h: fmt.num(p.balance.held) }) : ""}</div>
          </div>
          <div className="card kpi">
            <div className="kpi-l">{t("lb.period")}</div>
            <div className="kpi-v small">
              <span className="mono">{p.product_code}</span> <Pill tone={PERIOD_TONE[p.status]}>{t(`bps.${p.status}` as MessageKey)}</Pill>
            </div>
            <div className="kpi-n">{t("lb.until", { a: fmt.date(p.starts_at), b: fmt.date(p.ends_at) })}</div>
          </div>
          <div className="card kpi">
            <div className="kpi-l">{t("lb.overage")}</div>
            <div className="kpi-v">{p.balance ? fmt.num(p.balance.overage) : "—"}</div>
            <div className="kpi-n">{t("lb.overageNote")}</div>
          </div>
        </div>
      ) : (
        <p className="small muted" data-testid="lb-no-period">
          {t("lb.noPeriod")}
        </p>
      )}
      {a.stars_subscription && (
        <Callout icon="star" testId="lb-stars">
          <b>{t("pay.starsSub")}</b> <Pill tone={STARS_SUB_TONE[a.stars_subscription.status]}>{t(`ssub.${a.stars_subscription.status}` as MessageKey)}</Pill> {money.stars(a.stars_subscription.amount_stars)} ·{" "}
          {t("pay.starsSubUntil", { t: fmt.dateTime(a.stars_subscription.expires_at), n: a.stars_subscription.renewals })}
        </Callout>
      )}
      {a.holds.length > 0 && (
        <section className="stack sm" aria-labelledby="lb-holds-h">
          <h3 className="h3" id="lb-holds-h">
            {t("lb.holds", { n: a.holds.length })}
          </h3>
          <ul className="small">
            {a.holds.map((h) => (
              <li key={h.hold_id} data-testid={`lb-hold-${h.hold_id}`}>
                {t(`feat.${h.feature}` as MessageKey)} · {t("lb.holdMin", { n: h.minutes })} · {t("lb.holdUntil", { t: fmt.dateTime(h.expires_at) })}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="stack sm" aria-labelledby="lb-periods-h">
        <h3 className="h3" id="lb-periods-h">
          {t("lb.periods")}
        </h3>
        {a.periods.length ? (
          <div className="table-wrap">
            <table className="tbl compact" data-testid="lb-periods">
              <caption className="sr-only">{t("lb.periods")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("lb.period")}</th>
                  <th scope="col">{t("lb.source")}</th>
                  <th scope="col">{t("col.status")}</th>
                  <th scope="col" className="r">
                    {t("lb.minutes")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {a.periods.map((x) => (
                  <tr key={x.period_id}>
                    <td className="small">
                      <span className="mono">{x.product_code}</span>
                      <span className="xs muted block">{t("lb.until", { a: fmt.date(x.starts_at), b: fmt.date(x.ends_at) })}</span>
                    </td>
                    <td className="small">
                      {t(`lb.src.${x.source}` as MessageKey)}
                      {x.order_no != null && <span className="xs muted block">№ {x.order_no}</span>}
                    </td>
                    <td>
                      <Pill tone={PERIOD_TONE[x.status]}>{t(`bps.${x.status}` as MessageKey)}</Pill>
                      {x.close_reason && <span className="xs muted block">{t(`lb.close.${x.close_reason}` as MessageKey)}</span>}
                    </td>
                    <td className="r num">{x.balance ? `${fmt.num(x.balance.minutes_left)} / ${fmt.num(x.minutes_granted)}` : fmt.num(x.minutes_granted)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">{t("lb.noPeriods")}</p>
        )}
      </section>
      <section className="stack sm" aria-labelledby="lb-ledger-h">
        <h3 className="h3" id="lb-ledger-h">
          {t("lb.ledger")}
        </h3>
        {!ledger ? (
          <Spinner label={t("common.loading")} />
        ) : ledger.length ? (
          <div className="table-wrap">
            <table className="tbl dense" data-testid="lb-ledger">
              <caption className="sr-only">{t("lb.ledger")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("pay.col.when")}</th>
                  <th scope="col">{t("lb.entry")}</th>
                  <th scope="col" className="r">
                    {t("lb.minutes")}
                  </th>
                  <th scope="col">{t("pay.col.who")}</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((e) => (
                  <tr key={e.entry_id} data-kind={e.kind}>
                    <td className="small nowrap">{fmt.dateTime(e.created_at)}</td>
                    <td className="small">
                      {t(`mle.${e.kind}` as MessageKey)}
                      <span className="xs muted block">{e.ref_kind}</span>
                    </td>
                    <td className="r num">
                      {e.minutes > 0 ? `+${fmt.num(e.minutes)}` : fmt.num(e.minutes)}
                      {e.overage > 0 && <span className="xs muted block">{t("lb.overageN", { n: e.overage })}</span>}
                    </td>
                    <td className="small">{e.actor_name ?? t(`lb.actor.${e.actor.startsWith("staff:") ? "staff" : e.actor}` as MessageKey)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">{t("lb.noLedger")}</p>
        )}
        {cursor && <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void Billing.ledger(a.account_id, cursor).then((p) => (setLedger((xs) => [...(xs ?? []), ...p.items]), setCursor(p.next_cursor)))} testId="lb-ledger-more" />}
      </section>
      <div className="acts">
        {can("subscriptions.override") ? (
          <Btn kind="primary" icon="edit" label={t("lb.adjust")} onClick={() => setAdjust(true)} testId="lb-adjust" />
        ) : (
          <span className="xs muted row" data-testid="lb-adjust-ro">
            <Icon name="lock" /> {t("perm.need", { p: "subscriptions.override" })}
          </span>
        )}
        <Btn size="sm" icon="coins" label={t("lb.orders")} onClick={() => navigate("payments")} testId="lb-orders" />
      </div>
      {adjust && <AdjustDialog account={a} onClose={() => setAdjust(false)} onDone={load} />}
    </div>
  );
}

function AdjustDialog({ account, onClose, onDone }: { account: AdminBillingAccount; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const fail = useCmdFail();
  const issueText = useMoneyIssue();
  const [key] = useState(() => new CommandKey(uuid));
  const live = account.periods.filter((p) => p.status === "active" || p.status === "scheduled");
  const [f, setF] = useState<AdjustmentForm>(() => emptyAdjustment(account.current_period?.period_id ?? live[0]?.period_id ?? null));
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const period = live.find((p) => p.period_id === f.period_id) ?? null;
  const chk = adjustmentBody(f, period?.balance?.minutes_left ?? null);
  const issue = (path: string) => (tried ? issueText(chk.issues.find((x) => x.path === path)) : null);
  const set = <K extends keyof AdjustmentForm>(k: K, v: AdjustmentForm[K]) => (setF((x) => ({ ...x, [k]: v })), setErr(null));
  const submit = async () => {
    setTried(true);
    if (!chk.body || busy) return;
    setBusy(true);
    setErr(null);
    const k = key.for(adjustmentSig(account.account_id, chk.body));
    try {
      await Billing.requestAdjustment(account.account_id, chk.body, k);
      key.settle();
      toast(t("lb.requested"), "ok", "billing.adjustment_requested");
      onDone();
      onClose();
    } catch (e) {
      key.settle(e);
      // billing 409 BALANCE_NEGATIVE: the minutes left changed since the tab was read — the words of the form
      setErr(e instanceof ApiError && e.code === "BALANCE_NEGATIVE" ? t("mi.below_zero") : fail(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("lb.adjustT")}
      text={t("lb.adjustM")}
      icon="edit"
      onClose={() => !busy && onClose()}
      testId="lb-adjust-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn label={t("lb.sendRequest")} kind="primary" busy={busy} onClick={() => void submit()} testId="lb-adjust-ok" />
        </>
      }
    >
      <div className="field">
        <label htmlFor="lb-kind">{t("lb.kind")}</label>
        <Select<AdjustmentKind> id="lb-kind" label={t("lb.kind")} value={f.kind} onChange={(v) => set("kind", v)} options={ADJ_KINDS.map((v) => ({ v, label: t(`adk.${v}` as MessageKey) }))} testId="lb-kind" />
      </div>
      {f.kind !== "grant_period" && (
        <div className="field">
          <label htmlFor="lb-period">{t("lb.period")}</label>
          <Select<string>
            id="lb-period"
            label={t("lb.period")}
            value={f.period_id}
            onChange={(v) => set("period_id", v)}
            options={[{ v: "", label: t("lb.pickPeriod") }, ...live.map((p) => ({ v: p.period_id, label: `${p.product_code} · ${t(`bps.${p.status}` as MessageKey)}${p.balance ? ` · ${t("lb.leftN", { n: p.balance.minutes_left })}` : ""}` }))]}
            testId="lb-period"
          />
          <FieldErr msg={issue("period_id")} />
        </div>
      )}
      {f.kind !== "revoke_period" && (
        <div className="field">
          <label htmlFor="lb-minutes">{t(f.kind === "minutes" ? "lb.minutesDelta" : "lb.minutes")}</label>
          <input id="lb-minutes" className="input num" inputMode="numeric" value={f.minutes} onChange={(e) => set("minutes", e.target.value)} aria-invalid={!!issue("minutes") || undefined} data-testid="lb-minutes" />
          <span className="hint">{t(f.kind === "minutes" ? "lb.minutesH" : "lb.grantMinutesH")}</span>
          <FieldErr msg={issue("minutes")} />
        </div>
      )}
      {f.kind === "grant_period" && (
        <div className="field">
          <label htmlFor="lb-days">{t("tf.days")}</label>
          <input id="lb-days" className="input num" inputMode="numeric" value={f.days} onChange={(e) => set("days", e.target.value)} data-testid="lb-days" />
          <FieldErr msg={issue("days")} />
        </div>
      )}
      {f.kind === "revoke_period" && (
        <Callout kind="warn" icon="alert" testId="lb-revoke-note">
          {t("lb.revokeNote")}
        </Callout>
      )}
      <NoteField id="lb-reason" label={t("lb.reason")} value={f.reason} onChange={(v) => set("reason", v)} error={issue("reason")} hint={t("lb.reasonH")} testId="lb-reason" />
      <StepUpNote text={t("lb.fourEyes")} />
      {err && (
        <p className="err" role="alert">
          <Icon name="alertCircle" /> {err}
        </p>
      )}
    </Modal>
  );
}
