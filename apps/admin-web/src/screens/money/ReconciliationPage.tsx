/**
 * «Сверка» (ADM-MONEY-04, AT-97; billing.read; manual run and resolution — billing.manage): the queue of
 * reconciliation items — paid but not fulfilled, stale transactions, a mismatch with the provider, refunds without a
 * request, missing fiscal receipts, a Stars payer other than the owner, Stars transactions without our record and back,
 * a desync of a Stars subscription, expired holds, balance drift. An item is resolved or ignored with a note (audited);
 * money consequences — only by a refund or an adjustment. Details carry no PII, Telegram ids or secrets.
 * Route: #/reconciliation.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReconItem, ReconItemKind } from "@tilhero/contracts/admin";
import { Billing } from "../../api/endpoints";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, Empty, Pill, Select, Spinner } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { CommandKey } from "../memory/model";
import { useCmdFail } from "../social/parts";
import { detailsLine, NOTE_MAX, NOTE_MIN, RECON_KINDS, RECON_STATUSES, RECON_TONE } from "./model";
import { OrderLink, staffName } from "./parts";

type Status = (typeof RECON_STATUSES)[number];

export function ReconciliationPage() {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const fail = useCmdFail();
  const manage = can("billing.manage");
  const [status, setStatus] = useState<Status | "">("open");
  const [kind, setKind] = useState<ReconItemKind | "">("");
  const [rows, setRows] = useState<ReconItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [resolve, setResolve] = useState<{ item: ReconItem; status: "resolved" | "ignored" } | null>(null);
  const [running, setRunning] = useState(false);
  const [key] = useState(() => new CommandKey(uuid));
  const [runKey] = useState(() => new CommandKey(uuid));
  const load = useCallback(
    async (more?: string | null) => {
      try {
        const p = await Billing.recon({ status, kind, cursor: more ?? null });
        setRows((xs) => (more && xs ? [...xs, ...p.items] : p.items));
        setCursor(p.next_cursor);
        setError(null);
      } catch (e) {
        setError(e);
      }
    },
    [status, kind],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const run = async () => {
    if (running) return;
    setRunning(true);
    // one manual run per click: a repeat after a lost answer keeps the key until it settles
    const k = runKey.for("run");
    try {
      const r = await Billing.reconRun(k);
      runKey.settle();
      toast(r.finished_at ? t("rec.runDone", { c: fmt.num(r.checked), f: fmt.num(r.found) }) : t("rec.runStarted"), "ok", "billing.recon_run");
      void load();
    } catch (e) {
      runKey.settle(e);
      toast(fail(e), "err");
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="stack" data-testid="reconciliation">
      <section className="panel" aria-labelledby="rec-h" data-testid="rec-list">
        <div className="panel-h">
          <h2 className="panel-t grow" id="rec-h">
            <Icon name="scan" /> {t("page.reconciliation")}
          </h2>
          {manage && <Btn size="sm" icon="play" label={t("rec.run")} busy={running} onClick={() => void run()} testId="rec-run" />}
          <Btn size="sm" icon="refresh" label={t("common.refresh")} onClick={() => void load()} testId="rec-refresh" />
        </div>
        <div className="panel-b qa-filters" role="group" aria-label={t("mny.filters")}>
          <div className="field">
            <label htmlFor="rec-status">{t("col.status")}</label>
            <Select<Status | ""> id="rec-status" label={t("col.status")} value={status} onChange={setStatus} options={[{ v: "", label: t("common.all") }, ...RECON_STATUSES.map((v) => ({ v, label: t(`rcst.${v}` as MessageKey) }))]} testId="rec-status" />
          </div>
          <div className="field">
            <label htmlFor="rec-kind">{t("rec.kind")}</label>
            <Select<ReconItemKind | ""> id="rec-kind" label={t("rec.kind")} value={kind} onChange={setKind} options={[{ v: "", label: t("common.all") }, ...RECON_KINDS.map((v) => ({ v, label: t(`rck.${v}` as MessageKey) }))]} testId="rec-kind" />
          </div>
        </div>
        {error && !rows ? (
          <div className="panel-b">
            <LoadError error={error} onRetry={() => void load()} />
          </div>
        ) : !rows ? (
          <Spinner label={t("common.loading")} />
        ) : rows.length ? (
          <div className="table-wrap">
            <table className="tbl compact" data-testid="rec-rows">
              <caption className="sr-only">{t("page.reconciliation")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("rec.kind")}</th>
                  <th scope="col">{t("pay.col.order")}</th>
                  <th scope="col">{t("rec.details")}</th>
                  <th scope="col">{t("col.status")}</th>
                  {manage && (
                    <th scope="col" className="r">
                      {t("ct.col.actions")}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.item_id} data-testid={`rec-${x.item_id}`} data-status={x.status} data-kind={x.kind}>
                    <td className="small">
                      <b>{t(`rck.${x.kind}` as MessageKey)}</b>
                      <span className="xs muted block">
                        {x.provider ? t(`bprv.${x.provider}` as MessageKey) : "—"} · {fmt.dateTime(x.created_at)}
                      </span>
                    </td>
                    <td>
                      <OrderLink id={x.order_id} no={x.order_no} testId={`rec-order-${x.item_id}`} />
                    </td>
                    <td className="mono xs wrap-any rec-details">{detailsLine(x.details)}</td>
                    <td>
                      <Pill tone={RECON_TONE[x.status]}>{t(`rcst.${x.status}` as MessageKey)}</Pill>
                      {x.resolved_at && (
                        <span className="xs muted block">
                          {staffName(x.resolved_by, t("mny.system"))} · {fmt.dateTime(x.resolved_at)}
                        </span>
                      )}
                      {x.note && <span className="xs block wrap-any">{x.note}</span>}
                    </td>
                    {manage && (
                      <td className="actions-cell">
                        {x.status === "open" && (
                          <>
                            <Btn size="xs" icon="check" label={t("rec.resolve")} onClick={() => setResolve({ item: x, status: "resolved" })} testId={`rec-resolve-${x.item_id}`} />
                            <Btn size="xs" kind="ghost" icon="eyeOff" label={t("rec.ignore")} onClick={() => setResolve({ item: x, status: "ignored" })} testId={`rec-ignore-${x.item_id}`} />
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="checkCircle" title={t("rec.none")} testId="rec-empty" />
        )}
        {cursor && (
          <div className="more-row">
            <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} testId="rec-more" />
          </div>
        )}
        <div className="panel-f xs">
          <Icon name="info" /> {t("rec.note")}
        </div>
      </section>
      {!manage && (
        <Callout icon="lock" testId="rec-ro">
          {t("perm.need", { p: "billing.manage" })}
        </Callout>
      )}
      {resolve && (
        <ConfirmCommand
          title={t(resolve.status === "resolved" ? "rec.resolveT" : "rec.ignoreT")}
          text={t("rec.resolveM", { k: t(`rck.${resolve.item.kind}` as MessageKey) })}
          icon={resolve.status === "resolved" ? "check" : "eyeOff"}
          ok={t(resolve.status === "resolved" ? "rec.resolve" : "rec.ignore")}
          minReason={NOTE_MIN}
          maxReason={NOTE_MAX}
          reasonLabel={t("mny.note")}
          testId="rec-resolve-dialog"
          onClose={() => setResolve(null)}
          onConfirm={async (note) => {
            const k = key.for(JSON.stringify(["resolve", resolve.item.item_id, resolve.status, note]));
            try {
              const x = await Billing.resolve(resolve.item.item_id, resolve.status, note, k);
              key.settle();
              setRows((xs) => xs?.map((y) => (y.item_id === x.item_id ? x : y)) ?? xs);
              toast(t("rec.resolved"), "ok", "billing.recon_resolved");
              return null;
            } catch (e) {
              key.settle(e);
              return fail(e, () => void load());
            }
          }}
        />
      )}
    </div>
  );
}
