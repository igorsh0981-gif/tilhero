/**
 * «Корректировки» (ADM-USR-04, ADM-MONEY-05, AT-95; billing.read; decision — billing.approve + step-up): requests of
 * «four eyes» — minutes ±N to a period, a grant of a period, a revocation of a period. A request is made in the learner
 * card («Тариф», subscriptions.override + step-up) and applied only after ANOTHER staff member approves it: the author
 * never sees «Подтвердить» (can_decide is computed by admin-bff from the session; billing answers 409 SELF_APPROVAL
 * anyway), the author can withdraw it; 72 hours without a decision — expired. The reason of the staff member is never
 * shown to the learner. Routes: #/adjustments · #/adjustments/<account_id> (the requests of one account).
 */
import { useCallback, useEffect, useState } from "react";
import type { Adjustment, AdjustmentStatus } from "@tilhero/contracts/admin";
import { Billing } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, Empty, Pill, Select, Spinner } from "../../ui/kit";
import { ConfirmCommand, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { CommandKey } from "../memory/model";
import { NoteField, StepUpNote, useCmdFail } from "../social/parts";
import { ADJ_STATUSES, ADJ_TONE, isUuid, NOTE_MAX, NOTE_MIN } from "./model";
import { AccountRef, staffName } from "./parts";

type Cmd = { kind: "approve" | "reject" | "cancel"; a: Adjustment };

/** What the request changes, in words: «+30 мин к периоду», «выдать 30 дн. и 300 мин», «отозвать период». */
export function useAdjustmentWhat() {
  const { t } = useI18n();
  return (a: Pick<Adjustment, "kind" | "minutes" | "days">) =>
    a.kind === "minutes"
      ? t("adj.what.minutes", { n: `${(a.minutes ?? 0) > 0 ? "+" : ""}${a.minutes ?? 0}` })
      : a.kind === "grant_period"
        ? t("adj.what.grant", { d: a.days ?? 0, m: a.minutes ?? 0 })
        : t("adj.what.revoke");
}

/** #/adjustments/<account_id> — the requests of one account (from the «Тариф» tab); anything else — all accounts */
export const parseAdjustmentsRoute = (id: string | null): string | null => (id && isUuid(id) ? id.toLowerCase() : null);

export function AdjustmentsPage({ routeId = null }: { routeId?: string | null }) {
  const { t, fmt } = useI18n();
  const { navigate } = useNav();
  const what = useAdjustmentWhat();
  const account = parseAdjustmentsRoute(routeId);
  const [status, setStatus] = useState<AdjustmentStatus | "">("pending");
  const [rows, setRows] = useState<Adjustment[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cmd, setCmd] = useState<Cmd | null>(null);
  const load = useCallback(
    async (more?: string | null) => {
      try {
        const p = await Billing.adjustments(status, more ?? null, account);
        setRows((xs) => (more && xs ? [...xs, ...p.items] : p.items));
        setCursor(p.next_cursor);
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [status, account],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const replace = (a: Adjustment) => setRows((xs) => xs?.map((x) => (x.adjustment_id === a.adjustment_id ? a : x)) ?? xs);
  return (
    <div className="stack" data-testid="adjustments">
      <Callout icon="userCheck" testId="adj-four-eyes">
        {t("adj.fourEyes")}
      </Callout>
      <section className="panel" aria-labelledby="adj-h" data-testid="adj-list">
        <div className="panel-h">
          <h2 className="panel-t grow" id="adj-h">
            <Icon name="userCheck" /> {t("page.adjustments")}
          </h2>
          <Select<AdjustmentStatus | ""> id="adj-status" label={t("col.status")} value={status} onChange={setStatus} options={[{ v: "", label: t("common.all") }, ...ADJ_STATUSES.map((v) => ({ v, label: t(`ads.${v}` as MessageKey) }))]} testId="adj-status" />
          <Btn size="sm" icon="refresh" label={t("common.refresh")} onClick={() => void load()} testId="adj-refresh" />
        </div>
        {account && (
          <div className="panel-b row wrap" data-testid="adj-account">
            <span className="small">
              {t("adj.forAccount")} <AccountRef id={account} />
            </span>
            <Btn size="xs" kind="ghost" icon="x" label={t("adj.allAccounts")} onClick={() => navigate("adjustments")} testId="adj-all-accounts" />
          </div>
        )}
        {error && !rows ? (
          <div className="panel-b">
            <LoadError error={error} onRetry={() => void load()} />
          </div>
        ) : !rows ? (
          <Spinner label={t("common.loading")} />
        ) : rows.length ? (
          <div className="table-wrap">
            <table className="tbl compact" data-testid="adj-rows">
              <caption className="sr-only">{t("page.adjustments")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("adj.col.account")}</th>
                  <th scope="col">{t("adj.col.what")}</th>
                  <th scope="col">{t("pay.col.reason")}</th>
                  <th scope="col">{t("adj.col.author")}</th>
                  <th scope="col">{t("col.status")}</th>
                  <th scope="col" className="r">
                    {t("ct.col.actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.adjustment_id} data-testid={`adj-${a.adjustment_id}`} data-status={a.status}>
                    <td>
                      <AccountRef id={a.account_id} />
                    </td>
                    <td className="small">
                      <b>{what(a)}</b>
                      {a.period_id && <span className="mono xs muted block">{a.period_id.slice(0, 8)}</span>}
                    </td>
                    <td className="small wrap-any adj-reason" lang="ru">
                      {a.reason}
                      {a.decision_note && <span className="xs muted block">{t("adj.decisionNote", { n: a.decision_note })}</span>}
                    </td>
                    <td className="small">
                      {staffName(a.requested_by, t("mny.system"))}
                      <span className="xs muted block">{fmt.dateTime(a.requested_at)}</span>
                    </td>
                    <td>
                      <Pill tone={ADJ_TONE[a.status]}>{t(`ads.${a.status}` as MessageKey)}</Pill>
                      {a.status === "pending" && <span className="xs muted block">{t("adj.expires", { t: fmt.dateTime(a.expires_at) })}</span>}
                      {a.decided_by && <span className="xs muted block">{t("adj.decidedBy", { n: staffName(a.decided_by, t("mny.system")) })}</span>}
                    </td>
                    <td className="actions-cell">
                      {a.can_decide && (
                        <>
                          <Btn size="xs" kind="primary" icon="check" label={t("adj.approve")} onClick={() => setCmd({ kind: "approve", a })} testId={`adj-approve-${a.adjustment_id}`} />
                          <Btn size="xs" kind="danger-ghost" icon="x" label={t("adj.reject")} onClick={() => setCmd({ kind: "reject", a })} testId={`adj-reject-${a.adjustment_id}`} />
                        </>
                      )}
                      {a.can_cancel && <Btn size="xs" kind="ghost" icon="rollback" label={t("adj.cancel")} onClick={() => setCmd({ kind: "cancel", a })} testId={`adj-cancel-${a.adjustment_id}`} />}
                      {a.status === "pending" && !a.can_decide && !a.can_cancel && (
                        <span className="xs muted" data-testid={`adj-wait-${a.adjustment_id}`}>
                          {t("adj.waitOther")}
                        </span>
                      )}
                      {a.status === "pending" && a.can_cancel && (
                        <span className="xs muted block" data-testid={`adj-own-${a.adjustment_id}`}>
                          {t("adj.ownRequest")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="userCheck" title={t("adj.none")} testId="adj-empty" />
        )}
        {cursor && (
          <div className="more-row">
            <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} testId="adj-more" />
          </div>
        )}
        <div className="panel-f xs">
          <Icon name="shield" /> {t("adj.privacy")}
        </div>
      </section>
      {cmd && <DecisionDialog cmd={cmd} onClose={() => setCmd(null)} onDone={(a) => (replace(a), void load())} />}
    </div>
  );
}

function DecisionDialog({ cmd, onClose, onDone }: { cmd: Cmd; onClose: () => void; onDone: (a: Adjustment) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const fail = useCmdFail();
  const what = useAdjustmentWhat();
  const [key] = useState(() => new CommandKey(uuid));
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const a = cmd.a;
  if (cmd.kind === "reject")
    return (
      <ConfirmCommand
        title={t("adj.rejectT")}
        text={t("adj.rejectM")}
        icon="x"
        tone="bad"
        ok={t("adj.reject")}
        okKind="danger"
        minReason={NOTE_MIN}
        maxReason={NOTE_MAX}
        reasonLabel={t("mny.note")}
        testId="adj-reject-dialog"
        extra={
          <>
            <p className="small">
              <b>{what(a)}</b> · {a.reason}
            </p>
            <StepUpNote />
          </>
        }
        onClose={onClose}
        onConfirm={async (n) => {
          const k = key.for(JSON.stringify(["reject", a.adjustment_id, n]));
          try {
            const x = await Billing.reject(a.adjustment_id, n, k);
            key.settle();
            toast(t("adj.rejected"), "ok", "billing.adjustment_rejected");
            onDone(x);
            return null;
          } catch (e) {
            key.settle(e);
            return fail(e);
          }
        }}
      />
    );
  const approve = cmd.kind === "approve";
  const submit = async () => {
    if (busy) return;
    if (approve && note.trim().length > NOTE_MAX) return setErr(t("mi.reason_long", { max: NOTE_MAX }));
    setBusy(true);
    setErr(null);
    const k = key.for(JSON.stringify([cmd.kind, a.adjustment_id, approve ? note.trim() : ""]));
    try {
      const x = approve ? await Billing.approve(a.adjustment_id, note.trim() || null, k) : await Billing.cancelAdjustment(a.adjustment_id, k);
      key.settle();
      toast(t(approve ? "adj.approved" : "adj.cancelled"), "ok", approve ? "billing.adjustment_approved" : "billing.adjustment_cancelled");
      onDone(x);
      onClose();
    } catch (e) {
      key.settle(e);
      setErr(e instanceof ApiError && e.code === "SELF_APPROVAL" ? t("err.SELF_APPROVAL") : fail(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t(approve ? "adj.approveT" : "adj.cancelT")}
      text={t(approve ? "adj.approveM" : "adj.cancelM")}
      icon={approve ? "check" : "rollback"}
      tone={approve ? "" : "warn"}
      onClose={() => !busy && onClose()}
      testId={approve ? "adj-approve-dialog" : "adj-cancel-dialog"}
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn label={t(approve ? "adj.approve" : "adj.cancel")} kind="primary" busy={busy} onClick={() => void submit()} testId="adj-dialog-ok" />
        </>
      }
    >
      <dl className="dl">
        <dt>{t("adj.col.what")}</dt>
        <dd>{what(a)}</dd>
        <dt>{t("pay.col.reason")}</dt>
        <dd lang="ru">{a.reason}</dd>
        <dt>{t("adj.col.author")}</dt>
        <dd>{staffName(a.requested_by, t("mny.system"))}</dd>
      </dl>
      {approve && (
        <>
          <NoteField id="adj-note" label={t("adj.noteOptional")} value={note} onChange={setNote} required={false} testId="adj-note" />
          <StepUpNote />
        </>
      )}
      {err && (
        <p className="err" role="alert">
          <Icon name="alertCircle" /> {err}
        </p>
      )}
    </Modal>
  );
}
