import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditRecord, ChainVerification } from "@tilhero/contracts/admin";
import { Audit as AuditApi, type AuditFilters } from "../../api/endpoints";
import { useI18n } from "../../i18n";
import { shortId } from "../../lib/ids";
import { redactSecrets } from "../../lib/redact";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, CopyBtn, cx, Empty, JsonView, Spinner } from "../../ui/kit";
import { Drawer } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errMeta, errText } from "../../ui/errors";

/** Actions written by the sprint-2 producers (admin-identity, admin-bff, identity-consent, support, experience-config, notifications). */
export const KNOWN_ACTIONS = [
  "auth.login",
  "auth.login_failed",
  "auth.locked",
  "auth.logout",
  "auth.mfa_enrolled",
  "auth.mfa_failed",
  "auth.password_changed",
  "auth.step_up",
  "staff.bootstrap",
  "staff.created",
  "staff.updated",
  "staff.password_reset",
  "staff.mfa_reset",
  "staff.mfa_reset_all",
  "role.permissions_requested",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.applied",
  "approval.waived",
  "sensitive.view",
  "sensitive.view_rate_limited",
  "dev.impersonate",
  "ticket.reply",
  "ticket.note",
  "ticket.status",
  "ticket.priority",
  "ticket.assign",
  "ticket.take",
  "ticket.escalate",
  "sla.change",
  "config.create",
  "config.activate",
  "config.rollback",
  "release_note.create",
  "release_note.update",
  "release_note.publish",
  "release_note.archive",
  "template.version_created",
  "template.activated",
  "template.reset",
  "template.test_sent",
  "campaign.created",
  "campaign.updated",
  "campaign.scheduled",
  "campaign.unscheduled",
  "campaign.stopped",
  "campaign.finished",
  "campaign.test_sent",
] as const;

/** object_type of the TilHero producers (INTERNAL_API sprint 2). */
export const OBJECT_TYPES = ["staff", "role", "approval", "learner", "release_note", "notification_template", "campaign", "config", "ticket"] as const;

const CRIT = new Set(["sensitive.view", "auth.locked", "staff.mfa_reset", "staff.mfa_reset_all", "staff.bootstrap", "approval.waived", "campaign.stopped"]);
const SEC = /^(auth|staff|role|approval|impersonat|export|dev)\b/;

/** Severity of an audit action: crit (red bar), sec (amber), "" (neutral). */
export function actionSeverity(action: string): "crit" | "sec" | "" {
  if (CRIT.has(action)) return "crit";
  return SEC.test(action) ? "sec" : "";
}

/** Short single-line view of a before/after object for the table (secrets redacted). */
export function compact(v: Record<string, unknown> | null, max = 64): string {
  if (v == null) return "∅";
  const s = JSON.stringify(redactSecrets(v));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Local calendar day → ISO-8601 UTC bounds for the from/to filters. */
export function dayBound(day: string, end: boolean): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T${end ? "23:59:59.999" : "00:00:00"}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function AuditPage() {
  const i = useI18n();
  const { t, fmt } = i;
  const toast = useToast();
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [objType, setObjType] = useState("");
  const [objId, setObjId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<AuditRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<AuditRecord | null>(null);
  const [chain, setChain] = useState<ChainVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [badFilter, setBadFilter] = useState<string | null>(null);
  const req = useRef(0);

  const act = action.trim().toLowerCase();
  const filters: AuditFilters = {
    action: act && /^[a-z][a-z0-9_.]*$/.test(act) ? act : undefined,
    actor_id: actor.trim() || undefined,
    object_type: objType.trim() || undefined,
    object_id: objId.trim() || undefined,
    from: from ? dayBound(from, false) : undefined,
    to: to ? dayBound(to, true) : undefined,
  };
  const fKey = JSON.stringify(filters);

  const load = useCallback(async (f: AuditFilters, append: boolean) => {
    const id = ++req.current;
    setLoading(true);
    try {
      const p = await AuditApi.list(f);
      if (id !== req.current) return;
      setRows((xs) => (append ? [...xs, ...p.items] : p.items));
      setCursor(p.next_cursor);
      setError(null);
    } catch (e) {
      if (id === req.current) setError(e);
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setBadFilter(act && !/^[a-z][a-z0-9_.]*$/.test(act) ? t("aud.badAction") : from && to && from > to ? t("aud.badRange") : null);
    const tm = setTimeout(() => void load(JSON.parse(fKey) as AuditFilters, false), 300);
    return () => clearTimeout(tm);
  }, [fKey, load, act, from, to, t]);

  const verify = async () => {
    setVerifying(true);
    try {
      const v = await AuditApi.verify();
      setChain(v);
      toast(v.valid ? t("aud.chainOk", { n: v.checked }) : t("aud.chainBad", { seq: v.broken_at_seq ?? "?" }), v.valid ? "ok" : "err", "GET /admin/v1/audit/verify");
    } catch (e) {
      toast(errText(i, e), "err", errMeta(e));
    } finally {
      setVerifying(false);
    }
  };

  const reset = () => {
    setAction("");
    setActor("");
    setObjType("");
    setObjId("");
    setFrom("");
    setTo("");
  };

  return (
    <div data-testid="audit">
      <div className="mb-16">
        <Callout icon="lock">
          <b>{t("aud.roT")}</b> {t("aud.roM")}
        </Callout>
      </div>
      <div className="toolbar">
        <div className="input-wrap">
          <Icon name="filter" />
          <input className="input mono" list="aud-actions" placeholder={t("aud.action")} aria-label={t("aud.action")} value={action} maxLength={80} onChange={(e) => setAction(e.target.value)} data-testid="aud-action" />
          <datalist id="aud-actions">
            {KNOWN_ACTIONS.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </div>
        <input className="input mono aud-f" placeholder="actor_id" aria-label={t("aud.actor")} value={actor} maxLength={64} onChange={(e) => setActor(e.target.value)} />
        <select className="select aud-f" aria-label={t("aud.objType")} value={objType} onChange={(e) => setObjType(e.target.value)} data-testid="aud-objtype">
          <option value="">{t("aud.allObjects")}</option>
          {OBJECT_TYPES.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <input className="input mono aud-f" placeholder="object_id" aria-label={t("aud.objId")} value={objId} maxLength={128} onChange={(e) => setObjId(e.target.value)} />
        <label className="row aud-date">
          <span className="xs muted">{t("aud.from")}</span>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("aud.from")} />
        </label>
        <label className="row aud-date">
          <span className="xs muted">{t("aud.to")}</span>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("aud.to")} />
        </label>
        <Btn kind="ghost" size="sm" label={t("common.resetFilters")} onClick={reset} />
        <span className="grow" />
        <Btn icon="shield" size="sm" label={t("aud.verify")} busy={verifying} onClick={() => void verify()} testId="aud-verify" />
      </div>
      {badFilter && (
        <div className="mb-12">
          <Callout kind="warn" icon="alert">
            {badFilter}
          </Callout>
        </div>
      )}
      {chain && (
        <div className="mb-12">
          <Callout kind={chain.valid ? "good" : "bad"} icon={chain.valid ? "checkCircle" : "alertCircle"} testId="aud-chain">
            <b>{chain.valid ? t("aud.chainOk", { n: chain.checked }) : t("aud.chainBad", { seq: chain.broken_at_seq ?? "?" })}</b>{" "}
            <span className="mono xs">
              seq {chain.first_seq ?? "—"} … {chain.last_seq ?? "—"}
            </span>
          </Callout>
        </div>
      )}
      {error ? <LoadError error={error} onRetry={() => void load(filters, false)} /> : null}
      <section className="panel" aria-live="polite">
        <div className="table-wrap">
          <table className="tbl dense" data-testid="audit-table">
            <thead>
              <tr>
                <th>{t("aud.col.time")}</th>
                <th>{t("aud.col.actor")}</th>
                <th>{t("aud.col.action")}</th>
                <th>{t("aud.col.object")}</th>
                <th>{t("aud.col.ba")}</th>
                <th>IP · session</th>
                <th>trace_id</th>
                <th>hash</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const sev = actionSeverity(a.action);
                return (
                  <tr
                    key={a.record_id}
                    className={cx("is-click", sev === "crit" ? "sev-bad" : sev === "sec" ? "sev-warn" : "sev-none")}
                    tabIndex={0}
                    aria-label={t("common.openRow", { x: `#${a.seq} ${a.action}` })}
                    onClick={() => setOpen(a)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(a))}
                    data-action={a.action}
                  >
                    <td className="mono nowrap">{fmt.dateTimeS(a.occurred_at)}</td>
                    <td className="nowrap">
                      <div className="cell-main">{a.actor_role ?? a.actor_type}</div>
                      <div className="cell-sub mono">{a.actor_id ? shortId(a.actor_id, 8, 4) : a.actor_type}</div>
                    </td>
                    <td>
                      <span className={cx("act-code", sev)}>{a.action}</span>
                    </td>
                    <td className="wrap-any" style={{ minWidth: 140 }}>
                      <div className="cell-main">{a.object_type ?? "—"}</div>
                      {a.object_id && <div className="cell-sub mono">{shortId(a.object_id, 8, 4)}</div>}
                    </td>
                    <td style={{ minWidth: 180 }}>
                      <span className="ba wrap">
                        {compact(a.before, 40)} <Icon name="right" /> {compact(a.after, 56)}
                      </span>
                    </td>
                    <td className="mono small nowrap">
                      {a.ip ?? "—"} · {a.session_id ? shortId(a.session_id, 4, 3) : "—"}
                    </td>
                    <td className="mono small nowrap">{a.trace_id ? shortId(a.trace_id, 4, 3) : "—"}</td>
                    <td className="hash">{a.hash.slice(0, 8)}</td>
                  </tr>
                );
              })}
              {!loading && !rows.length && !error && (
                <tr>
                  <td colSpan={8} className="empty-cell">
                    <Empty icon="audit" title={t("common.nothingFound")} text={t("common.changeFilters")} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && <Spinner label={t("common.loading")} />}
        <div className="pager">
          <span>{t("aud.shown", { n: rows.length })}</span>
          {rows[0] && <span className="mono">head #{rows[0].seq} · {rows[0].hash.slice(0, 12)}</span>}
          {cursor && !loading && <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load({ ...filters, cursor }, true)} testId="aud-more" />}
        </div>
      </section>
      {open && <RecordDrawer rec={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function RecordDrawer({ rec, onClose }: { rec: AuditRecord; onClose: () => void }) {
  const { t, fmt } = useI18n();
  const [full, setFull] = useState<AuditRecord>(rec);
  useEffect(() => {
    let alive = true;
    AuditApi.get(rec.record_id)
      .then((r) => alive && setFull(r))
      .catch(() => undefined); // the list row is already complete; the re-read only confirms it
    return () => {
      alive = false;
    };
  }, [rec.record_id]);
  const safe = redactSecrets(full);
  const sev = actionSeverity(full.action);
  return (
    <Drawer
      wide
      testId="audit-record"
      onClose={onClose}
      title={
        <>
          <span className={cx("act-code", sev)}>{full.action}</span> · <span className="mono">#{full.seq}</span>
        </>
      }
      sub={
        <>
          <span className="mono">{fmt.dateTimeS(full.occurred_at)}</span>
          <span>· {full.source}</span>
        </>
      }
    >
      <div className="stack">
        <dl className="dl">
          <dt>record_id</dt>
          <dd className="mono">
            {full.record_id} <CopyBtn value={full.record_id} label="record_id" />
          </dd>
          <dt>{t("aud.col.actor")}</dt>
          <dd>
            {full.actor_type}
            {full.actor_role ? ` · ${full.actor_role}` : ""}
            {full.actor_id && <span className="mono block xs">{full.actor_id}</span>}
          </dd>
          <dt>{t("aud.col.object")}</dt>
          <dd>
            {full.object_type ?? "—"}
            {full.object_id && <span className="mono block xs">{full.object_id}</span>}
          </dd>
          <dt>{t("cmd.reason")}</dt>
          <dd>{full.reason ?? "—"}</dd>
          <dt>IP · session</dt>
          <dd className="mono">
            {full.ip ?? "—"} · {full.session_id ?? "—"}
          </dd>
          <dt>trace_id</dt>
          <dd className="mono">{full.trace_id ?? "—"}</dd>
          <dt>recorded_at</dt>
          <dd className="mono">{fmt.dateTimeS(full.recorded_at)}</dd>
        </dl>
        <div>
          <div className="field-label mb-12">{t("aud.col.ba")}</div>
          <div className="diff-pair">
            <JsonView value={safe.before} className="before" />
            <JsonView value={safe.after} className="after" />
          </div>
        </div>
        <div>
          <div className="field-label mb-12">{t("aud.chain")}</div>
          <div className="chain">
            <div className="lnk">
              <Icon name="hash" />
              prev_hash {full.prev_hash}
            </div>
            <div className="lnk">
              <Icon name="hash" />
              hash {full.hash}
            </div>
          </div>
        </div>
        <div>
          <div className="field-label mb-12">JSON</div>
          <JsonView value={safe} testId="audit-json" />
        </div>
        <Callout icon="lock">{t("aud.roM")}</Callout>
      </div>
    </Drawer>
  );
}
