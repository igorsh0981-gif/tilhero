import { useCallback, useEffect, useState } from "react";
import type { OpsAlert } from "@tilhero/contracts/admin";
import { AlertsApi, OpsApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type I18n, type MessageKey } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, cx, Empty, Seg, Spinner } from "../../ui/kit";
import { Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import type { MonShared } from "./Monitoring";
import { monRoute, SEV_ICON, SEV_TONE } from "./ops";
import { useSession } from "../../state/session";
import { runbookHref } from "../../lib/url";

/** translate a dynamic key, or fall back to a raw value (unknown kinds / providers of a newer ops-monitor) */
export function tOr(i: Pick<I18n, "t">, key: string, fallback: string, vars?: Record<string, string | number>): string {
  const r = i.t(key as MessageKey, vars);
  return r === key ? fallback : r;
}

/** subject in words: provider title / consumer / service */
export function subjectText(i: Pick<I18n, "t">, type: string, subject: string): string {
  if (type === "provider") return tOr(i, `mon.prov.${subject}`, subject);
  if (type === "feeds") return i.t("mon.subj.feeds");
  // sprint 9
  if (type === "deletion") return i.t("mon.subj.deletion");
  if (type === "ratelimit") return subject === "redis" ? i.t("mon.subj.rlRedis") : i.t("mon.subj.rl", { p: subject });
  return subject;
}

/** one line of what happened, from the params (codes and numbers only) */
export function alertText(i: Pick<I18n, "t" | "tp" | "fmt">, a: Pick<OpsAlert, "kind" | "params" | "subject_type" | "subject">): string {
  const p = a.params;
  const st = (s: string | null | undefined) => (s ? tOr(i, `mon.st.${s}`, s) : "—");
  switch (a.kind) {
    case "status":
      return i.t("mon.at.status", { from: st(p.status_from), to: st(p.status_to), rate: p.error_rate != null ? i.fmt.pct(p.error_rate * 100) : "—" });
    case "unstable":
      return i.t("mon.at.unstable");
    case "route_spike":
      return i.t("mon.at.route_spike", { top: (p.route_top ?? []).map((r) => `${r.location} ×${r.count}`).join(", ") || "—", n: p.rl_60 ?? "—" });
    case "dlq_growth":
      return p.dlq_count == null ? i.t("mon.at.dlq_growthNa") : i.t("mon.at.dlq_growth", { what: i.tp("mon.dlq.msgN", p.dlq_count) });
    case "lag":
      return i.t("mon.at.lag", { n: p.pending ?? "—", age: p.oldest_age_s != null ? Math.round(p.oldest_age_s / 60) : "—" });
    case "outbox_stuck":
      return i.t("mon.at.outbox_stuck", { n: p.pending ?? "—", f: p.failing ?? 0 });
    case "feeds_problem":
      return i.t("mon.at.feeds_problem", { n: p.problem_feeds ?? "—" });
    // sprint 9 (§6.1)
    case "service_down":
      return p.down_s != null ? i.t("mon.at.service_down", { m: Math.max(1, Math.round(p.down_s / 60)) }) : i.t("mon.at.service_downNa");
    case "deletion_stuck": {
      const pend = Object.entries(p.pending_by_domain ?? {})
        .sort((x, y) => y[1] - x[1])
        .slice(0, 3)
        .map(([d, n]) => `${d} ×${n}`)
        .join(", ");
      return i.t("mon.at.deletion_stuck", { n: p.stuck ?? "—", open: p.open ?? "—" }) + (pend ? ` · ${i.t("mon.at.pending", { d: pend })}` : "");
    }
    case "rate_limit_spike":
      return i.t("mon.at.rate_limit_spike", { n: p.rejected ?? "—", share: p.share != null ? i.fmt.pct(p.share * 100) : "—", s: p.subjects ?? "—" });
    case "rate_limit_unavailable":
      return p.failclosed != null
        ? i.t("mon.at.rate_limit_unavailable", { n: p.failclosed, p: p.policies ?? "—" })
        : i.t("mon.at.rate_limit_redis", { p: p.policies ?? "—" });
    default:
      return a.kind;
  }
}

/** an acknowledgement is audited first: audit down → nothing changed (the generic AUDIT text speaks of the AI search) */
export function ackErrText(i: Pick<I18n, "t">, e: unknown): string {
  return e instanceof ApiError && e.code === "AUDIT_UNAVAILABLE" ? i.t("mon.dlq.auditDown") : errText(i, e);
}

/** where an alert leads: a tab of «Monitoring», or «Users → Deletions» (sprint 9) */
export function alertTarget(type: string, subject: string): { page: string; id: string } {
  if (type === "provider") return { page: "monitoring", id: monRoute("providers", subject) };
  if (type === "feeds") return { page: "monitoring", id: "providers" };
  if (type === "dlq" || type === "consumer") return { page: "monitoring", id: `dlq/${subject}` };
  if (type === "ratelimit") return { page: "monitoring", id: subject === "redis" ? "limits" : `limits/${subject}` };
  if (type === "deletion") return { page: "users", id: "deletions/stuck" };
  return { page: "monitoring", id: "queues" };
}

/** «Runbook» (sprint 9, §6.2): the runbook section of the alert — https only, opens in a new tab */
export function RunbookLink({ url, size = "xs", testId = "runbook" }: { url: string | null | undefined; size?: "xs" | "sm"; testId?: string }) {
  const { t } = useI18n();
  const { me } = useSession();
  const href = runbookHref(url, me?.runbook_base_url);
  if (!href) return null;
  return (
    <a className={cx("btn ghost", size)} href={href} target="_blank" rel="noopener noreferrer" title={t("mon.runbookH")} data-testid={testId}>
      <Icon name="wrench" />
      <span>{t("mon.runbook")}</span>
      <span className="sr-only"> ({t("common.newTab")})</span>
    </a>
  );
}

/** «Alerts»: open and resolved alerts of ops-monitor; acknowledge (ops.kill_switch) — with an optional comment. */
export function AlertsTab({ shared }: { shared: MonShared }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { navigate } = useNav();
  const [state, setState] = useState<"open" | "resolved">("open");
  const [resolved, setResolved] = useState<OpsAlert[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [ack, setAck] = useState<OpsAlert | null>(null);
  const loadResolved = useCallback(async () => {
    try {
      setResolved((await OpsApi.alerts({ state: "resolved" })).items);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    if (state === "resolved" && !resolved) void loadResolved();
  }, [state, resolved, loadResolved]);
  const items = state === "open" ? shared.alerts : resolved;
  const err = state === "open" ? shared.errors.alerts : error;

  return (
    <section className="panel" aria-labelledby="mon-alerts-h" data-testid="mon-alerts">
      <div className="panel-h">
        <h2 className="panel-t" id="mon-alerts-h">
          <Icon name="bell" />
          {t("mon.alerts.t")}
        </h2>
        {shared.alerts && (
          <span className="panel-sub" data-testid="mon-alerts-unacked">
            {t("mon.alerts.unacked", { n: shared.alerts.filter((x) => !x.acked_at).length, all: shared.alerts.length })}
          </span>
        )}
        <span className="grow" />
        <Seg
          label={t("mon.alerts.t")}
          value={state}
          onChange={setState}
          testId="mon-alerts-state"
          items={[
            { v: "open", label: t("mon.alerts.open"), cnt: shared.alerts?.length ?? null },
            { v: "resolved", label: t("mon.alerts.resolved") },
          ]}
        />
      </div>
      {err && !items ? (
        <div className="panel-b">
          <LoadError error={err} onRetry={() => (state === "open" ? shared.reload() : void loadResolved())} />
        </div>
      ) : !items ? (
        <Spinner label={t("common.loading")} />
      ) : !items.length ? (
        <Empty icon="checkCircle" title={state === "open" ? t("mon.alerts.emptyT") : t("mon.alerts.emptyRT")} text={state === "open" ? t("mon.alerts.emptyM") : undefined} testId="mon-alerts-empty" />
      ) : (
        <ul className="mon-alerts" data-testid="mon-alert-list">
          {items.map((a) => (
            <li key={a.alert_id} className={cx("mon-alert", `is-${SEV_TONE[a.severity]}`, (a.acked_at || a.state === "resolved") && "is-quiet")} data-testid="mon-alert" data-alert={a.alert_id}>
              <span className="mon-alert-ico" aria-hidden="true">
                <Icon name={SEV_ICON[a.severity]} />
              </span>
              <div className="grow">
                <div className="mon-alert-t">
                  <span className={cx("sev-tag", `is-${SEV_TONE[a.severity]}`)}>{t(`mon.sev.${a.severity}`)}</span>
                  <b>{subjectText(i, a.subject_type, a.subject)}</b> · {tOr(i, `mon.ak.${a.kind}`, a.kind)}
                </div>
                <div className="small">{alertText(i, a)}</div>
                <div className="xs muted">
                  {t("mon.alerts.opened", { t: fmt.dateTime(a.opened_at) })}
                  {a.resolved_at && ` · ${t("mon.alerts.resolvedAt", { t: fmt.dateTime(a.resolved_at) })}`}
                  {a.acked_at && ` · ${t("mon.alerts.acked", { who: a.acked_by_name ?? t("ai.system"), t: fmt.rel(a.acked_at) })}`}
                  {a.ack_comment && ` · «${a.ack_comment}»`}
                </div>
              </div>
              <div className="mon-alert-acts">
                <RunbookLink url={a.runbook_url} testId="mon-alert-runbook" />
                <Btn
                  size="xs"
                  kind="ghost"
                  icon="right"
                  label={t("dash.open")}
                  onClick={() => {
                    const to = alertTarget(a.subject_type, a.subject);
                    navigate(to.page, to.id);
                  }}
                  testId="mon-alert-go"
                />
                {a.state === "open" && !a.acked_at && <Btn size="xs" icon="check" label={t("ai.alert.ack")} perm="ops.kill_switch" onClick={() => setAck(a)} testId="mon-alert-ack" />}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="panel-f ai-foot">
        <Icon name="info" /> {t("mon.alerts.foot")}
      </div>
      {ack && (
        <AckDialog
          a={ack}
          onClose={() => setAck(null)}
          onDone={() => {
            setAck(null);
            shared.reload(true);
          }}
        />
      )}
    </section>
  );
}

function AckDialog({ a, onClose, onDone }: { a: OpsAlert; onClose: () => void; onDone: () => void }) {
  const i = useI18n();
  const { t } = i;
  const toast = useToast();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    try {
      await AlertsApi.ack("ops", a.alert_id, comment.trim() || undefined);
      toast(t("mon.alerts.ackDone"), "ok", "ops.alert.ack");
      onDone();
    } catch (e) {
      setErr(ackErrText(i, e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("mon.alerts.ackT")}
      text={t("mon.alerts.ackM")}
      icon="check"
      onClose={() => !busy && onClose()}
      testId="mon-ack"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn kind="primary" label={t("ai.alert.ack")} busy={busy} onClick={() => void submit()} testId="mon-ack-ok" />
        </>
      }
    >
      <p className="small">
        <b>{subjectText(i, a.subject_type, a.subject)}</b> · {alertText(i, a)}
      </p>
      <div className="field">
        <label htmlFor="ack-comment">{t("mon.alerts.comment")}</label>
        <textarea id="ack-comment" className="textarea" rows={2} maxLength={300} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("mon.alerts.commentPh")} data-autofocus="" data-testid="mon-ack-comment" />
      </div>
      {err && <p className="field-err">{err}</p>}
    </Modal>
  );
}
