import { useCallback, useEffect, useRef, useState } from "react";
import type { DeletionDetail, DeletionRow } from "@tilhero/contracts/admin";
import { DeletionsApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon, type IconName } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Seg, Spinner, type Tone } from "../../ui/kit";
import { Drawer, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { ackShare, type DelFilter } from "../monitoring/ops";

/* Sprint 9 — «Users → Deletions» (INTERNAL_API §1.4, AT 35): the deletion saga of identity-consent. A profile is
   anonymised only after every domain acknowledged; a stuck deletion can be re-sent, never «closed». No PII: the user
   is a pseudonym (user_id). */

export const DEL_TONE: Record<DeletionRow["status"], Tone> = { REQUESTED: "info", STUCK: "bad", COMPLETED: "good" };
const DEL_ICON: Record<DeletionRow["status"], IconName> = { REQUESTED: "clock", STUCK: "alertCircle", COMPLETED: "checkCircle" };

export function DeletionStatus({ s, testId }: { s: DeletionRow["status"]; testId?: string }) {
  const { t } = useI18n();
  return (
    <span className={cx("pill no-dot", DEL_TONE[s])} data-testid={testId} data-status={s}>
      <Icon name={DEL_ICON[s]} />
      {t(`del.st.${s}`)}
    </span>
  );
}

/** acked / expected domains: a meter with the number in words (not colour alone) */
function AckMeter({ r }: { r: Pick<DeletionRow, "acked" | "expected" | "status"> }) {
  const { t } = useI18n();
  const pct = Math.round(ackShare(r) * 100);
  return (
    <span className="del-ack" title={t("del.ackH", { a: r.acked, e: r.expected })}>
      <span className={cx("mon-meter", r.status === "STUCK" ? "is-bad" : r.status === "COMPLETED" ? "is-good" : "is-info")} role="meter" aria-label={t("del.col.domains")} aria-valuemin={0} aria-valuemax={r.expected} aria-valuenow={r.acked}>
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="small nowrap">{t("del.ackN", { a: r.acked, e: r.expected })}</span>
    </span>
  );
}

export function DeletionsPage({ filter, openId }: { filter: DelFilter; openId: string | null }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { navigate } = useNav();
  const { can } = useSession();
  const [rows, setRows] = useState<DeletionRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const req = useRef(0);
  const load = useCallback(async (f: DelFilter, more: string | null) => {
    const id = ++req.current;
    setLoading(true);
    try {
      const page = await DeletionsApi.list({ status: f === "all" ? undefined : f, cursor: more });
      if (id !== req.current) return;
      setRows((xs) => (more && xs ? [...xs, ...page.items] : page.items));
      setCursor(page.next_cursor);
      setError(null);
    } catch (e) {
      if (id === req.current) setError(e);
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, []);
  useEffect(() => void load(filter, null), [filter, load]);
  const go = (f: DelFilter) => navigate("users", f === "open" ? "deletions" : `deletions/${f}`);
  const stuck = rows?.filter((r) => r.status === "STUCK").length ?? 0;

  return (
    <div className="stack" data-testid="deletions">
      <section className="panel" aria-labelledby="del-h">
        <div className="panel-h">
          <h2 className="panel-t" id="del-h">
            <Icon name="userCheck" />
            {t("del.t")}
          </h2>
          <span className="panel-sub">{t("del.sub")}</span>
          <span className="grow" />
          <Seg
            label={t("del.filter")}
            value={filter}
            onChange={go}
            testId="del-filter"
            items={(["open", "stuck", "completed", "all"] as const).map((v) => ({ v, label: t(`del.f.${v}`) }))}
          />
        </div>
        {filter !== "completed" && stuck > 0 && (
          <div className="panel-b">
            <Callout kind="bad" icon="alertCircle" testId="del-stuck-note">
              <b>{i.tp("del.stuckN", stuck)}</b> {t("del.stuckM")}
            </Callout>
          </div>
        )}
        {error && !rows ? (
          <div className="panel-b">
            <LoadError error={error} onRetry={() => void load(filter, null)} testId="del-error" />
          </div>
        ) : !rows ? (
          <Spinner label={t("common.loading")} />
        ) : !rows.length ? (
          <Empty icon="checkCircle" title={t(`del.emptyT.${filter}` as MessageKey)} text={t("del.emptyM")} testId="del-empty" />
        ) : (
          <div className="table-wrap">
            <table className="tbl del-tbl" aria-busy={loading}>
              <thead>
                <tr>
                  <th>{t("del.col.requested")}</th>
                  <th>{t("del.col.user")}</th>
                  <th>{t("mon.col.status")}</th>
                  <th>{t("del.col.domains")}</th>
                  <th>{t("del.col.pending")}</th>
                  <th className="num">{t("del.col.attempts")}</th>
                  <th>{t("del.col.next")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.request_id}
                    className={cx("is-click", r.status === "STUCK" ? "sev-bad" : "sev-none")}
                    tabIndex={0}
                    onClick={() => navigate("users", `deletions/${r.request_id}`)}
                    onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && navigate("users", `deletions/${r.request_id}`)}
                    data-testid="del-row"
                    data-request={r.request_id}
                  >
                    <td className="nowrap" data-label={t("del.col.requested")}>
                      {fmt.dateTime(r.requested_at)}
                      <span className="block xs muted">{fmt.rel(r.requested_at)}</span>
                    </td>
                    <td data-label={t("del.col.user")}>
                      <span className="mono small" title={r.user_id}>
                        {shortId(r.user_id, 8, 4)}
                      </span>
                      <span className="block xs muted">{t("del.pseudo")}</span>
                    </td>
                    <td data-label={t("mon.col.status")}>
                      <DeletionStatus s={r.status} testId="del-status" />
                      {r.stuck_at && <span className="block xs muted">{t("del.stuckSince", { t: fmt.rel(r.stuck_at) })}</span>}
                      {r.completed_at && <span className="block xs muted">{fmt.dateTime(r.completed_at)}</span>}
                    </td>
                    <td data-label={t("del.col.domains")}>
                      <AckMeter r={r} />
                    </td>
                    <td data-label={t("del.col.pending")}>
                      {r.pending_domains.length ? (
                        <span className="mon-classes">
                          {r.pending_domains.map((d) => (
                            <span key={d} className="tag" data-testid="del-pending">
                              {d}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num" data-label={t("del.col.attempts")}>
                      {fmt.num(r.attempts)}
                    </td>
                    <td className="small nowrap" data-label={t("del.col.next")}>
                      {r.status === "COMPLETED" ? "—" : r.next_retry_at ? fmt.rel(r.next_retry_at) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <div className="pager">
            <span />
            <Btn size="sm" icon="down" label={t("common.loadMore")} busy={loading} onClick={() => void load(filter, cursor)} testId="del-more" />
          </div>
        )}
        <div className="panel-f ai-foot">
          <Icon name="shield" /> {t("del.foot")}
        </div>
      </section>
      {openId && (
        <DeletionDrawer
          id={openId}
          canRetry={can("ops.queues.manage")}
          onClose={() => navigate("users", filter === "open" ? "deletions" : `deletions/${filter}`)}
          onChanged={(d) => setRows((xs) => (xs ? xs.map((x) => (x.request_id === d.request_id ? { ...x, ...d } : x)) : xs))}
        />
      )}
    </div>
  );
}

function byText(i: ReturnType<typeof useI18n>, h: DeletionDetail["history"][number]): string {
  if (h.by === "user") return i.t("del.by.user");
  if (h.by === "system") return i.t("del.by.system");
  return h.by_name ?? shortId(h.by, 8, 4);
}

function DeletionDrawer({ id, canRetry, onClose, onChanged }: { id: string; canRetry: boolean; onClose: () => void; onChanged: (d: DeletionDetail) => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const [d, setD] = useState<DeletionDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [retry, setRetry] = useState(false);
  const load = useCallback(async () => {
    try {
      setD(await DeletionsApi.get(id));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [id]);
  useEffect(() => {
    setD(null);
    void load();
  }, [load]);
  const open = d && d.status !== "COMPLETED";
  return (
    <Drawer
      wide
      title={t("del.d.t")}
      sub={
        <>
          <span className="mono">{shortId(id, 8, 4)}</span>
          {d && <DeletionStatus s={d.status} />}
        </>
      }
      onClose={onClose}
      testId="del-drawer"
      footer={
        <>
          <Btn label={t("common.close")} onClick={onClose} />
          <span className="grow" />
          {open && <Btn kind="primary" icon="refresh" label={t("del.retry")} perm="ops.queues.manage" onClick={() => setRetry(true)} testId="del-retry" />}
        </>
      }
    >
      {error && !d ? (
        <LoadError error={error} onRetry={() => void load()} testId="del-d-error" />
      ) : !d ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="stack">
          <dl className="kv mon-kv">
            <dt>{t("del.col.user")}</dt>
            <dd className="mono small">
              {d.user_id} <span className="xs muted">· {t("del.pseudo")}</span>
            </dd>
            <dt>{t("del.col.requested")}</dt>
            <dd>{fmt.dateTime(d.requested_at)}</dd>
            {d.stuck_at && (
              <>
                <dt>{t("del.d.stuckAt")}</dt>
                <dd className="txt-bad">
                  <Icon name="alertCircle" /> {fmt.dateTime(d.stuck_at)}
                </dd>
              </>
            )}
            {d.completed_at && (
              <>
                <dt>{t("del.d.completedAt")}</dt>
                <dd>{fmt.dateTime(d.completed_at)}</dd>
              </>
            )}
            <dt>{t("del.col.domains")}</dt>
            <dd>
              <AckMeter r={d} />
            </dd>
            {d.status !== "COMPLETED" && (
              <>
                <dt>{t("del.col.next")}</dt>
                <dd>{d.next_retry_at ? `${fmt.dateTime(d.next_retry_at)} · ${fmt.rel(d.next_retry_at)}` : "—"}</dd>
              </>
            )}
          </dl>
          {d.status === "STUCK" && (
            <Callout kind="warn" icon="info" testId="del-d-stuck">
              {t("del.d.stuckHint")}
            </Callout>
          )}
          <section className="mon-sec" aria-labelledby="del-dom-h">
            <div className="mon-sec-h">
              <h3 id="del-dom-h">{t("del.d.domains")}</h3>
            </div>
            <ul className="del-domains" data-testid="del-domains">
              {d.domains.map((x) => (
                <li key={x.domain} className={cx(!x.acked && "is-pending")} data-testid="del-domain" data-domain={x.domain} data-acked={String(x.acked)}>
                  <Icon name={x.acked ? "checkCircle" : "clock"} className={x.acked ? "txt-good" : "txt-warn"} />
                  <span className="mono grow">{x.domain}</span>
                  <span className="small">
                    {!x.acked ? (
                      <b className="txt-warn">{t("del.d.waiting")}</b>
                    ) : x.acked_at ? (
                      <>
                        {t(x.mode === "anonymized" ? "del.mode.anonymized" : "del.mode.deleted")} · <span title={fmt.dateTime(x.acked_at)}>{fmt.dateTime(x.acked_at)}</span>
                      </>
                    ) : (
                      <span className="muted" title={t("del.d.before9H")}>
                        {t("del.d.before9")}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="mon-sec" aria-labelledby="del-hist-h">
            <div className="mon-sec-h">
              <h3 id="del-hist-h">{t("del.d.history")}</h3>
            </div>
            <ol className="mon-trans del-history" data-testid="del-history">
              {[...d.history].reverse().map((h) => (
                <li key={h.attempt}>
                  <b>{t("del.d.attempt", { n: h.attempt })}</b> · {fmt.dateTime(h.sent_at)} ·{" "}
                  <span className={cx(h.by !== "user" && h.by !== "system" && "del-by-staff")}>{byText(i, h)}</span>
                </li>
              ))}
            </ol>
          </section>
          {!canRetry && open && (
            <p className="xs muted row">
              <Icon name="lock" /> {t("del.d.noRight")}
            </p>
          )}
        </div>
      )}
      {retry && d && (
        <RetryDialog
          d={d}
          onClose={() => setRetry(false)}
          onDone={(x) => {
            setD(x);
            onChanged(x);
            setRetry(false);
          }}
        />
      )}
    </Drawer>
  );
}

function RetryDialog({ d, onClose, onDone }: { d: DeletionDetail; onClose: () => void; onDone: (d: DeletionDetail) => void }) {
  const i = useI18n();
  const { t } = i;
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState<number | null>(null);
  // one key per open dialog: a repeat after a network error / step-up is the same command (Idempotent-Replayed)
  const idem = useRef(`del-retry-${uuid()}`);
  useEffect(() => {
    if (wait == null || wait <= 0) return;
    const id = setTimeout(() => setWait((w) => (w == null ? null : w - 1)), 1000);
    return () => clearTimeout(id);
  }, [wait]);
  const submit = async () => {
    if (reason.trim().length < 3 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const x = await DeletionsApi.retry(d.request_id, reason.trim(), idem.current);
      toast(t("del.retryDone", { n: x.attempts }), "ok", "user.deletion.retry");
      onDone(x);
    } catch (e) {
      if (e instanceof ApiError && e.cancelled) setErr(t("stepup.cancelled"));
      else if (e instanceof ApiError && e.code === "DELETION_RETRY_TOO_SOON") {
        setWait(e.num("retry_after") ?? 300);
        setErr(null);
        idem.current = `del-retry-${uuid()}`;
      } else setErr(errText(i, e));
    } finally {
      setBusy(false);
    }
  };
  const waiting = wait != null && wait > 0;
  return (
    <Modal
      title={t("del.retryT")}
      text={t("del.retryM", { n: d.pending_domains.length })}
      icon="refresh"
      tone="warn"
      onClose={() => !busy && onClose()}
      testId="del-retry-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn kind="primary" label={t("del.retry")} disabled={reason.trim().length < 3 || waiting} busy={busy} onClick={() => void submit()} testId="del-retry-ok" />
        </>
      }
    >
      <dl className="kv mon-kv">
        <dt>{t("del.col.pending")}</dt>
        <dd className="mono small">{d.pending_domains.join(", ") || "—"}</dd>
        <dt>{t("del.col.attempts")}</dt>
        <dd>{d.attempts}</dd>
      </dl>
      <p className="small muted">{t("del.retryNote")}</p>
      {waiting && (
        <Callout kind="warn" icon="clock" testId="del-too-soon">
          {t("del.tooSoon", { n: wait })}
        </Callout>
      )}
      <div className="field">
        <label htmlFor="del-reason" className="req">
          {t("cmd.reason")}
        </label>
        <textarea
          id="del-reason"
          className="textarea"
          rows={2}
          maxLength={300}
          data-autofocus=""
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("del.reasonPh")}
          data-testid="del-reason"
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
