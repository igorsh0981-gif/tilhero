import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EscalationType, ReplyTemplate, StaffTicket, StaffTicketMessage, StaffTicketSummary, TicketPriority, TicketStatus, UiLang } from "@tilhero/contracts/admin";
import type { Ticket as ClientTicket } from "@tilhero/contracts/bff";
import { Support as SupportApi, type SlaPolicy, type SupportStats, type TicketFilters } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { fmtCountdown, useI18n, type MessageKey } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { useNow } from "../../lib/useNow";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon, type IconName } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, CopyBtn, cx, Empty, FieldErr, Pill, Seg, Select, Spinner, TabPanel, Tabs, type Tone } from "../../ui/kit";
import { ConfirmCommand, Drawer, MenuButton, MenuItem } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errMeta, errText } from "../../ui/errors";
import { tgHandle } from "../../lib/tg";
import { CATEGORIES, liveSla, PRIORITIES, sortQueue, STAFF_TRANSITIONS, TICKET_STATUSES } from "./sla";

/* ---------------------------------------------------------------- pills & chips */

export const STATUS_TONE: Record<TicketStatus, Tone> = { NEW: "info", IN_PROGRESS: "warn", WAITING_CUSTOMER: "neutral", RESOLVED: "good", CLOSED: "outline" };
export const PRIO_TONE: Record<TicketPriority, Tone> = { urgent: "bad", high: "warn", normal: "neutral", low: "outline" };
export const ESCALATIONS: readonly EscalationType[] = ["billing_review", "assessment_review", "content_review", "tech_issue", "security_privacy"];
const ESC_ICON: Record<EscalationType, IconName> = { billing_review: "card", assessment_review: "clipboardCheck", content_review: "book", tech_issue: "wrench", security_privacy: "shield" };
const MAX_TEXT = 4000;

export function StatusPill({ s }: { s: string }) {
  const { t } = useI18n();
  const known = (TICKET_STATUSES as readonly string[]).includes(s);
  return (
    <Pill tone={known ? STATUS_TONE[s as TicketStatus] : "neutral"} title={s}>
      {known ? t(`tstatus.${s as TicketStatus}`) : s}
    </Pill>
  );
}

export function PrioPill({ p }: { p: TicketPriority }) {
  const { t } = useI18n();
  return (
    <Pill tone={PRIO_TONE[p] ?? "neutral"} title={p}>
      {t(`prio.${p}`)}
    </Pill>
  );
}

const catLabel = (t: (k: MessageKey) => string, c: string) => ((CATEGORIES as readonly string[]).includes(c) ? t(`cat.${c as (typeof CATEGORIES)[number]}`) : c);

/** Live SLA timer: re-rendered every second by the shared clock, no refetch. */
export function SlaChip({ tk, long }: { tk: StaffTicketSummary; long?: boolean }) {
  const { t, fmt } = useI18n();
  const now = useNow();
  const { state, left } = liveSla(tk, now);
  if (state === "met")
    return (
      <span className="sla met" data-sla="met">
        <Icon name="check" />
        {t("sla.met")}
      </span>
    );
  if (state === "paused")
    return (
      <span className="sla paused" title={t("sla.pausedT")} data-sla="paused">
        <Icon name="pause" />
        {t("sla.paused")}
      </span>
    );
  const kind = tk.sla_target === "first_response" ? t("sla.firstShort") : t("sla.resShort");
  return (
    <span className={cx("sla", state)} title={`${kind} · ${fmt.dateTime(tk.sla_due_at)}`} data-sla={state} data-testid="sla-chip">
      <Icon name="clock" />
      <span className="sla-v">{fmtCountdown(left ?? 0)}</span>
      {long && <span className="sla-k"> · {kind}</span>}
    </span>
  );
}

/* ---------------------------------------------------------------- page */

type SupTab = "queue" | "sla";

export function SupportPage({ ticketRef, onStats }: { ticketRef: string | null; onStats: () => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<SupTab>("queue");
  if (ticketRef) return <Thread key={ticketRef} refId={ticketRef} onChanged={onStats} />;
  return (
    <div data-testid="support">
      <div className="page-head">
        <div className="lead">
          <p>{t("sup.lead")}</p>
        </div>
      </div>
      <Tabs<SupTab>
        id="sup"
        label={t("page.support")}
        value={tab}
        onChange={setTab}
        className="mb-16"
        items={[
          { v: "queue", label: t("sup.queue"), icon: "inbox", testId: "sup-tab-queue" },
          { v: "sla", label: t("sup.sla"), icon: "clock", testId: "sup-tab-sla" },
        ]}
      />
      <TabPanel id="sup" value={tab}>
        {tab === "queue" ? <Queue onChanged={onStats} /> : <SlaSettings />}
      </TabPanel>
    </div>
  );
}

/* ---------------------------------------------------------------- queue */

type StatusFilter = "open" | TicketStatus | "all";
const STATUS_FILTERS: readonly StatusFilter[] = ["open", "NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED", "all"];

function statusCount(s: StatusFilter, st: SupportStats | null): number | null {
  if (!st) return null;
  if (s === "open") return st.open;
  if (s === "IN_PROGRESS") return st.in_progress;
  if (s === "WAITING_CUSTOMER") return st.waiting_customer;
  if (s === "NEW") return Math.max(0, st.open - st.in_progress - st.waiting_customer);
  return null;
}

function rowSeverity(tk: StaffTicketSummary, now: number): string {
  const { state } = liveSla(tk, now);
  return state === "over" ? "sev-bad" : state === "soon" ? "sev-warn" : tk.status === "NEW" ? "sev-info" : "sev-none";
}

function Queue({ onChanged }: { onChanged: () => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { me, can } = useSession();
  const toast = useToast();
  const { navigate } = useNav();
  const now = useNow();
  const [status, setStatus] = useState<StatusFilter>("open");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  const [assignee, setAssignee] = useState("");
  const [sla, setSla] = useState("");
  const [items, setItems] = useState<StaffTicketSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [stats, setStats] = useState<SupportStats | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const req = useRef(0);

  const filters: TicketFilters = {
    status: status === "all" ? "all" : status,
    category: category || undefined,
    priority: priority || undefined,
    assignee: assignee || undefined,
    sla: sla || undefined,
  };
  const fKey = JSON.stringify(filters);

  const load = useCallback(async (f: TicketFilters, append: boolean, quiet = false) => {
    const id = ++req.current;
    if (!quiet) setLoading(true);
    try {
      const page = await SupportApi.list(f, quiet); // the quiet refresh is a background poll (X-Background)
      if (id !== req.current) return;
      setItems((xs) => (append ? [...xs, ...page.items] : page.items));
      setCursor(page.next_cursor);
      setError(null);
    } catch (e) {
      if (id === req.current && !quiet) setError(e);
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, []);

  const loadStats = useCallback(() => {
    SupportApi.stats("today", true)
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  useEffect(() => {
    void load(JSON.parse(fKey) as TicketFilters, false);
  }, [fKey, load]);
  useEffect(() => {
    loadStats();
    // the first page refreshes quietly; SLA timers tick locally every second in between
    const id = setInterval(() => {
      loadStats();
      void load(JSON.parse(fKey) as TicketFilters, false, true);
    }, 30_000);
    return () => clearInterval(id);
  }, [fKey, load, loadStats]);

  const operators = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of items) if (x.assignee_id && x.assignee_id !== me?.staff.staff_id) m.set(x.assignee_id, x.assignee_name ?? shortId(x.assignee_id));
    return [...m.entries()];
  }, [items, me?.staff.staff_id]);

  const sorted = sortQueue(items, now);
  const breached = stats?.breached ?? 0;

  const take = async (tk: StaffTicketSummary) => {
    setBusy(tk.ticket_id);
    try {
      const res = await SupportApi.take(tk.ticket_id);
      toast(t("sup.taken", { id: res.number }), "ok", "POST …/take");
      onChanged();
      navigate("support", res.number);
    } catch (e) {
      if (!(e as ApiError).cancelled) toast(errText(i, e), "err", errMeta(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="support-queue">
      <div className="row mb-12">
        <Seg<StatusFilter>
          label={t("col.status")}
          value={status}
          onChange={setStatus}
          testId="sup-status"
          items={STATUS_FILTERS.map((s) => ({ v: s, label: s === "open" ? t("sup.open") : s === "all" ? t("common.all") : t(`tstatus.${s}`), cnt: statusCount(s, stats) }))}
        />
      </div>
      <div className="toolbar">
        <Select id="sq-cat" label={t("col.category")} value={category} onChange={setCategory} options={[{ v: "", label: t("sup.allCategories") }, ...CATEGORIES.map((c) => ({ v: c, label: t(`cat.${c}`) }))]} />
        <Select id="sq-prio" label={t("col.priority")} value={priority} onChange={setPriority} options={[{ v: "", label: t("sup.allPriorities") }, ...PRIORITIES.map((p) => ({ v: p, label: t(`prio.${p}`) }))]} />
        <Select
          id="sq-op"
          label={t("col.operator")}
          value={assignee}
          onChange={setAssignee}
          testId="sq-op"
          options={[{ v: "", label: t("sup.allOperators") }, { v: "me", label: t("sup.opMe") }, { v: "none", label: t("sup.opNone") }, ...operators.map(([id, name]) => ({ v: id, label: name }))]}
        />
        <Select
          id="sq-sla"
          label="SLA"
          value={sla}
          onChange={setSla}
          options={[
            { v: "", label: t("sla.all") },
            { v: "breached", label: breached ? `${t("sla.over")} · ${breached}` : t("sla.over") },
            { v: "soon", label: t("sla.soon") },
            { v: "ok", label: t("sla.ok") },
          ]}
        />
        <span className="grow" />
        <span className="small muted">{t("sup.sorted")}</span>
      </div>
      {error ? <LoadError error={error} onRetry={() => void load(filters, false)} /> : null}
      <section className="panel" aria-label={t("sup.queue")}>
        <div className="table-wrap">
          <table className="tbl" data-testid="queue-table">
            <thead>
              <tr>
                <th>{t("col.ticket")}</th>
                <th>{t("col.subject")}</th>
                <th>{t("col.category")}</th>
                <th>{t("col.priority")}</th>
                <th>{t("col.status")}</th>
                <th>SLA</th>
                <th>{t("col.operator")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((tk) => {
                const canTake = !tk.assignee_id && tk.status !== "CLOSED" && tk.status !== "RESOLVED";
                return (
                  <tr
                    key={tk.ticket_id}
                    className={cx("is-click", rowSeverity(tk, now))}
                    tabIndex={0}
                    aria-label={t("common.openRow", { x: tk.number })}
                    data-ticket={tk.number}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("button")) return;
                      navigate("support", tk.number);
                    }}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                      e.preventDefault();
                      navigate("support", tk.number);
                    }}
                  >
                    <td className="nowrap">
                      <div className="cell-main mono">{tk.number}</div>
                      <div className="cell-sub" title={`${t("col.channel")}: ${tk.channel}`}>
                        <Icon name="send" /> {fmt.rel(tk.created_at, now)}
                      </div>
                    </td>
                    <td style={{ minWidth: 240 }}>
                      <div className="cell-main">{tk.subject}</div>
                      <div className="cell-sub">
                        {tk.anonymized ? t("sup.anonymized") : tk.user_id ? <span className="mono">{shortId(tk.user_id, 8, 4)}</span> : "—"}
                        {tk.has_context && (
                          <>
                            {" · "}
                            <Icon name="link" /> {t("sup.hasContext")}
                          </>
                        )}
                      </div>
                    </td>
                    <td className="nowrap">{catLabel(t, tk.category)}</td>
                    <td>
                      <PrioPill p={tk.priority} />
                    </td>
                    <td>
                      <StatusPill s={tk.status} />
                    </td>
                    <td>
                      <SlaChip tk={tk} />
                    </td>
                    <td className="nowrap">{tk.assignee_id ? tk.assignee_name ?? shortId(tk.assignee_id) : <span className="muted">{t("sup.opNone")}</span>}</td>
                    <td className="actions-cell">
                      {canTake ? (
                        <Btn size="xs" label={t("sup.take")} perm="support.reply" busy={busy === tk.ticket_id} onClick={() => void take(tk)} testId={`take-${tk.number}`} />
                      ) : (
                        <Btn size="xs" kind="ghost" label={t("common.open")} onClick={() => navigate("support", tk.number)} />
                      )}
                    </td>
                  </tr>
                );
              })}
              {!loading && !sorted.length && !error && (
                <tr>
                  <td colSpan={8} className="empty-cell">
                    <Empty icon="inbox" title={t("sup.empty.t")} text={t("common.changeFilters")} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && <Spinner label={t("common.loading")} />}
        <div className="pager">
          <span>
            <Icon name="info" /> {t("sup.queueFoot", { n: sorted.length })}
          </span>
          {cursor && !loading && <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load({ ...filters, cursor }, true)} />}
        </div>
      </section>
      {!can("support.reply") && <p className="xs muted foot-note"><Icon name="lock" /> {t("sup.readOnly")}</p>}
    </div>
  );
}

/* ---------------------------------------------------------------- SLA settings */

const PRIO_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function SlaSettings() {
  const i = useI18n();
  const { t, fmt } = i;
  const toast = useToast();
  const [items, setItems] = useState<SlaPolicy[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [edit, setEdit] = useState<SlaPolicy | null>(null);

  const load = useCallback(() => {
    setError(null);
    SupportApi.slaPolicies()
      .then((r) => setItems(r.items))
      .catch(setError);
  }, []);
  useEffect(load, [load]);

  const rows = useMemo(
    () =>
      [...(items ?? [])].sort((a, b) =>
        a.category === b.category ? (PRIO_RANK[a.priority] ?? 9) - (PRIO_RANK[b.priority] ?? 9) : a.category === "*" ? -1 : b.category === "*" ? 1 : a.category.localeCompare(b.category),
      ),
    [items],
  );

  const save = async (row: SlaPolicy, first: number, res: number, reason: string): Promise<string | null> => {
    const next = (items ?? []).map((p) => (p.category === row.category && p.priority === row.priority ? { ...p, first_response_minutes: first, resolution_minutes: res } : p));
    try {
      const r = await SupportApi.putSlaPolicies(next, reason);
      setItems(r.items);
      toast(t("sla.saved"), "ok", "PUT /admin/v1/support/sla-policies");
      return null;
    } catch (e) {
      return errText(i, e);
    }
  };

  return (
    <section className="panel" data-testid="sla-settings">
      <div className="panel-h">
        <h2 className="panel-t">
          <Icon name="clock" />
          {t("sla.t")}
        </h2>
        <span className="panel-sub">support · sla_policy</span>
      </div>
      {error ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={load} />
        </div>
      ) : !items ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="table-wrap">
          <table className="tbl compact" data-testid="sla-table">
            <thead>
              <tr>
                <th>{t("col.category")}</th>
                <th>{t("col.priority")}</th>
                <th className="r">{t("sla.first")}</th>
                <th className="r">{t("sla.res")}</th>
                <th>{t("common.updated")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={`${p.category}/${p.priority}`}>
                  <td>{p.category === "*" ? <span className="muted">{t("sla.anyCat")}</span> : catLabel(t, p.category)}</td>
                  <td>
                    <PrioPill p={p.priority} />
                  </td>
                  <td className="r mono">{fmt.minutes(p.first_response_minutes)}</td>
                  <td className="r mono">{fmt.minutes(p.resolution_minutes)}</td>
                  <td className="nowrap small muted">{p.updated_at ? fmt.dateTime(p.updated_at) : "—"}</td>
                  <td className="actions-cell">
                    <Btn size="xs" icon="edit" label={t("common.edit")} perm="support.manage" onClick={() => setEdit(p)} testId={`sla-edit-${p.category}-${p.priority}`} />
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    <Empty icon="clock" title={t("sla.none")} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel-f">
        <Icon name="info" />
        <span>{t("sla.foot")}</span>
      </div>
      {edit && <SlaEdit row={edit} onClose={() => setEdit(null)} onSave={save} />}
    </section>
  );
}

function SlaEdit({ row, onClose, onSave }: { row: SlaPolicy; onClose: () => void; onSave: (row: SlaPolicy, first: number, res: number, reason: string) => Promise<string | null> }) {
  const { t, fmt } = useI18n();
  const [first, setFirst] = useState(String(row.first_response_minutes));
  const [res, setRes] = useState(String(row.resolution_minutes));
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<{ f?: string; r?: string; g?: string }>({});
  const [busy, setBusy] = useState(false);
  const f = Number(first);
  const r = Number(res);
  const submit = async () => {
    const e: typeof err = {};
    if (!Number.isInteger(f) || f < 1 || f > 43_200) e.f = t("sla.errFirst");
    else if (!Number.isInteger(r) || r <= f || r > 129_600) e.f = t("sla.errOrder");
    if (reason.trim().length < 5) e.r = t("cmd.errReason", { n: 5 });
    if (!e.f && f === row.first_response_minutes && r === row.resolution_minutes) e.g = t("sla.errSame");
    setErr(e);
    if (e.f || e.r || e.g) return;
    setBusy(true);
    const msg = await onSave(row, f, r, reason.trim());
    setBusy(false);
    if (msg) setErr({ g: msg });
    else onClose();
  };
  return (
    <Drawer
      title={t("sla.editT")}
      sub={
        <span>
          {row.category === "*" ? t("sla.anyCat") : catLabel(t, row.category)} · {t(`prio.${row.priority}`)}
        </span>
      }
      onClose={onClose}
      testId="sla-edit"
      footer={
        <>
          <span className="grow xs muted">
            <Icon name="audit" /> {t("cmd.auditNote")}
          </span>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn kind="primary" label={t("common.save")} busy={busy} onClick={() => void submit()} testId="sla-save" />
        </>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label htmlFor="sla-first">{t("sla.firstMin")}</label>
          <input id="sla-first" className={cx("input mono", err.f && "is-invalid")} inputMode="numeric" value={first} onChange={(e) => setFirst(e.target.value.replace(/\D/g, "").slice(0, 6))} />
          <span className="hint">{Number.isFinite(f) && f > 0 ? fmt.minutes(f) : "—"}</span>
        </div>
        <div className="field">
          <label htmlFor="sla-res">{t("sla.resMin")}</label>
          <input id="sla-res" className={cx("input mono", err.f && "is-invalid")} inputMode="numeric" value={res} onChange={(e) => setRes(e.target.value.replace(/\D/g, "").slice(0, 6))} />
          <span className="hint">{Number.isFinite(r) && r > 0 ? fmt.minutes(r) : "—"}</span>
        </div>
        <div className="span-2">
          <FieldErr msg={err.f} />
        </div>
        <div className="field span-2">
          <label htmlFor="sla-reason" className="req">
            {t("cmd.reason")}
          </label>
          <textarea id="sla-reason" className={cx("textarea", err.r && "is-invalid")} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("cmd.reasonPh")} />
          <FieldErr msg={err.r} />
        </div>
      </div>
      <FieldErr msg={err.g} />
      <p className="xs muted mt-12">{t("sla.editNote")}</p>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- thread */

type MobTab = "conv" | "ctx";

function Thread({ refId, onChanged }: { refId: string; onChanged: () => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { navigate } = useNav();
  const [tk, setTk] = useState<StaffTicket | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [side, setSide] = useState<StaffTicketSummary[]>([]);
  const [mtab, setMtab] = useState<MobTab>("conv");
  const [clientView, setClientView] = useState(false);
  const msgsRef = useRef<HTMLDivElement>(null);
  const now = useNow();

  const load = useCallback(
    async (quiet = false) => {
      try {
        const x = await SupportApi.get(refId, quiet);
        setTk(x);
        setError(null);
      } catch (e) {
        if (!quiet) setError(e);
      }
    },
    [refId],
  );
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(true), 20_000);
    return () => clearInterval(id);
  }, [load]);
  useEffect(() => {
    SupportApi.list({ status: "open", limit: 50 }, true)
      .then((p) => setSide(p.items))
      .catch(() => setSide([]));
  }, [tk?.status, tk?.assignee_id]);

  const msgCount = tk?.messages.length ?? 0;
  useEffect(() => {
    const box = msgsRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [msgCount]);

  const update = (x: StaffTicket) => {
    setTk(x);
    onChanged();
  };

  if (error && !tk) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div data-testid="thread-error">
        <Btn icon="chevL" size="sm" kind="ghost" label={t("sup.back")} onClick={() => navigate("support")} className="mb-12" />
        {notFound ? <Empty icon="inbox" title={t("sup.notFound.t")} text={t("sup.notFound.m", { id: refId })} /> : <LoadError error={error} onRetry={() => void load()} />}
      </div>
    );
  }
  if (!tk) return <Spinner label={t("common.loading")} />;

  const list = sortQueue(side.some((x) => x.ticket_id === tk.ticket_id) ? side : [tk, ...side], now);

  return (
    <div data-testid="thread">
      <div className="row mob-thread-tabs mb-12">
        <Btn icon="chevL" size="sm" kind="ghost" label={t("sup.back")} onClick={() => navigate("support")} />
        <span className="grow" />
        <Seg<MobTab> label={t("sup.view")} value={mtab} onChange={setMtab} testId="thread-mtab" items={[{ v: "conv", label: t("sup.conv") }, { v: "ctx", label: t("sup.ctx") }]} />
      </div>
      <div className="support-thread" data-mtab={mtab}>
        <aside className="st-list" aria-label={t("sup.queue")}>
          <div className="st-list-h">
            <Btn icon="chevL" size="sm" kind="ghost" label={t("sup.queue")} onClick={() => navigate("support")} />
            <span className="grow" />
            <span className="xs muted">
              {t("sup.open")} · {side.length}
            </span>
          </div>
          <div className="st-list-b">
            {list.map((x) => (
              <button key={x.ticket_id} type="button" className="st-li" aria-current={x.ticket_id === tk.ticket_id ? "true" : undefined} onClick={() => navigate("support", x.number)}>
                <span className="top">
                  <span className="mono xs">{x.number}</span>
                  <SlaChip tk={x} />
                </span>
                <span className="subj">{x.subject}</span>
                <span className="meta">
                  <StatusPill s={x.status} />
                  <span>{x.assignee_name ?? t("sup.opNone")}</span>
                </span>
              </button>
            ))}
          </div>
        </aside>
        <section className="st-conv" aria-label={t("sup.conv")}>
          <div className="st-conv-h">
            <h2 data-testid="thread-subject">{tk.subject}</h2>
            <div className="row">
              <span className="code-chip">{tk.number}</span>
              <StatusPill s={tk.status} />
              <PrioPill p={tk.priority} />
              <span className="tag plain">{catLabel(t, tk.category)}</span>
              <SlaChip tk={tk} long />
              <span className="small muted">
                {t("col.created")} {fmt.dateTime(tk.created_at)}
              </span>
              <span className="grow" />
              <Btn size="xs" icon="eye" label={t("cv.btn")} onClick={() => setClientView(true)} testId="client-view-btn" />
            </div>
          </div>
          <div className="st-msgs" ref={msgsRef} aria-live="polite" data-testid="thread-msgs">
            {tk.messages.map((m) => (
              <Message key={m.message_id} m={m} tk={tk} />
            ))}
            {!tk.messages.length && <Empty icon="support" title={t("sup.noMessages")} />}
          </div>
          <Composer tk={tk} onSent={update} />
        </section>
        <aside className="st-ctx" aria-label={t("sup.ctx")}>
          <Context tk={tk} onUpdate={update} onReload={() => void load(true)} />
        </aside>
      </div>
      {clientView && <ClientView tk={tk} onClose={() => setClientView(false)} />}
    </div>
  );
}

function userTag(tk: StaffTicket, t: (k: MessageKey) => string): string {
  if (tk.anonymized) return t("sup.anonymized");
  if (tk.learner?.username) return tgHandle(tk.learner.username);
  return tk.user_id ? shortId(tk.user_id, 8, 4) : t("sup.client");
}

function Message({ m, tk }: { m: StaffTicketMessage; tk: StaffTicket }) {
  const { t, fmt } = useI18n();
  if (m.sender_type === "system")
    return (
      <div className="msg sys">
        <div className="bub">
          <Icon name="info" /> {m.text} · <span className="mono">{fmt.time(m.created_at)}</span>
        </div>
      </div>
    );
  if (m.visibility === "internal")
    return (
      <div className="msg note" data-testid="msg-note">
        <div className="who">
          <Icon name="lock" />
          <b>{t("note.staffOnly")}</b> · {m.author_name ?? t("sup.staff")} · <span className="mono">{fmt.time(m.created_at)}</span>
        </div>
        <div className="bub">{m.text}</div>
      </div>
    );
  if (m.sender_type === "user")
    return (
      <div className="msg" data-testid="msg-user">
        <div className="who">
          <b>{userTag(tk, t)}</b> · {tk.channel} · <span className="mono">{fmt.time(m.created_at)}</span>
        </div>
        <div className="bub">{m.text}</div>
      </div>
    );
  return (
    <div className="msg op" data-testid="msg-op">
      <div className="who">
        {m.author_name ?? t("sup.staff")} · {t("sup.replyToClient")} · <span className="mono">{fmt.time(m.created_at)}</span>
      </div>
      <div className="bub">{m.text}</div>
      <div className="deliv">
        <Icon name="send" />
        <span>{t("sup.sentVia", { c: tk.channel })}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- composer */

type Mode = "reply" | "note";

/** Reply templates may refer to the ticket: {number}, {deeplink} (support templates catalogue). */
function fillTemplate(text: string, tk: StaffTicket): string {
  return text.replace(/\{deeplink\}/g, tk.context?.deeplink ?? "—").replace(/\{number\}/g, tk.number);
}

function Composer({ tk, onSent }: { tk: StaffTicket; onSent: (x: StaffTicket) => void }) {
  const i = useI18n();
  const { t } = i;
  const { can } = useSession();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>("reply");
  const [drafts, setDrafts] = useState<Record<Mode, string>>({ reply: "", note: "" });
  const keys = useRef<Record<Mode, string | null>>({ reply: null, note: null });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<ReplyTemplate[] | null>(null);
  const [tplLang, setTplLang] = useState<UiLang | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const canReply = can("support.reply");
  useEffect(() => {
    if (!canReply) return;
    let alive = true;
    SupportApi.templates()
      .then((r) => alive && setTemplates(r.items))
      .catch(() => alive && setTemplates([]));
    return () => {
      alive = false;
    };
  }, [canReply]);

  if (!canReply)
    return (
      <div className="composer" data-testid="composer-locked">
        <div className="locked-block">
          <Icon name="lock" />
          <div className="grow">
            <div className="t">{t("comp.lockedT")}</div>
            <div className="m">{t("perm.need", { p: "support.reply" })}</div>
          </div>
        </div>
      </div>
    );
  if (tk.status === "CLOSED")
    return (
      <div className="composer">
        <p className="small muted row">
          <Icon name="lock" /> {t("comp.closed")}
        </p>
      </div>
    );

  const note = mode === "note";
  const text = drafts[mode];
  const replyLang: UiLang = tplLang ?? tk.learner?.locale ?? "ru";
  const setText = (v: string) => {
    setDrafts((d) => ({ ...d, [mode]: v }));
    keys.current[mode] = null; // edited text = a new command (a retry of the same text keeps its key)
    setErr(null);
  };

  const send = async () => {
    if (busy) return;
    const body = text.trim();
    if (body.length < 2) {
      setErr(t("comp.empty"));
      taRef.current?.focus();
      return;
    }
    if (body.length > MAX_TEXT) {
      setErr(t("comp.tooLong", { n: MAX_TEXT }));
      return;
    }
    const key = keys.current[mode] ?? (keys.current[mode] = uuid());
    setBusy(true);
    setErr(null);
    try {
      const res = await SupportApi.send(tk.ticket_id, body, note ? "internal" : "public", key);
      keys.current[mode] = null;
      setDrafts((d) => ({ ...d, [mode]: "" }));
      onSent(res);
      toast(note ? t("note.added") : t("comp.sent", { id: tk.number }), "ok", note ? t("note.staffOnly") : "support → notifications → Telegram");
    } catch (e) {
      if (!(e as ApiError).cancelled) setErr(errText(i, e));
    } finally {
      setBusy(false);
    }
  };

  const tplSorted = [...(templates ?? [])].sort((a, b) => Number(b.categories.includes(tk.category)) - Number(a.categories.includes(tk.category)));

  return (
    <div className={cx("composer", note && "is-note")} data-testid="composer">
      <Seg<Mode>
        label={t("comp.mode")}
        value={mode}
        onChange={(m) => {
          setMode(m);
          setErr(null);
          setTimeout(() => taRef.current?.focus(), 0);
        }}
        testId="composer-mode"
        items={[
          { v: "reply", label: t("comp.reply") },
          { v: "note", label: t("comp.note") },
        ]}
      />
      <label className="sr-only" htmlFor="composer-text">
        {note ? t("comp.note") : t("comp.reply")}
      </label>
      <textarea
        ref={taRef}
        id="composer-text"
        className={cx("textarea", err && "is-invalid")}
        placeholder={note ? t("comp.notePh") : t("comp.replyPh")}
        value={text}
        maxLength={MAX_TEXT + 100}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
        data-testid="composer-text"
      />
      <FieldErr msg={err} />
      <div className="composer-bar">
        {note ? (
          <span className="note-label">
            <Icon name="lock" /> {t("note.staffOnly")}
          </span>
        ) : (
          <>
            <Seg<UiLang>
              label={t("tpl.lang")}
              value={replyLang}
              onChange={setTplLang}
              testId="tpl-lang"
              items={[
                { v: "ru", label: "RU" },
                { v: "uz", label: "UZ" },
              ]}
            />
            <MenuButton
              label={t("tpl.title")}
              className="btn sm"
              alignLeft
              testId="tpl-btn"
              render={(close) => (
                <>
                  <div className="menu-h">{t("tpl.title")}</div>
                  {!templates && (
                    <div className="menu-note row" role="status">
                      <span className="spinner" aria-hidden="true" /> {t("common.loading")}
                    </div>
                  )}
                  {templates && !templates.length && <div className="menu-note">{t("tpl.none")}</div>}
                  {tplSorted.map((tp) => (
                    <MenuItem
                      key={tp.id}
                      icon="note"
                      sub={[tp.categories.includes(tk.category) ? t("tpl.match") : null, tp.text[replyLang] ? null : t("tpl.noLang", { l: replyLang.toUpperCase() })].filter(Boolean).join(" · ") || undefined}
                      onClick={() => {
                        close();
                        setDrafts((d) => ({ ...d, reply: fillTemplate(tp.text[replyLang] || tp.text.ru, tk) }));
                        keys.current.reply = null;
                        setTimeout(() => taRef.current?.focus(), 0);
                      }}
                    >
                      {i.l(tp.title)}
                    </MenuItem>
                  ))}
                </>
              )}
            >
              <Icon name="note" />
              <span>{t("tpl.title")}</span>
            </MenuButton>
          </>
        )}
        <span className="grow" />
        <span className={cx("xs", text.length > MAX_TEXT ? "err" : "muted")}>
          {text.length > MAX_TEXT * 0.8 ? `${text.length}/${MAX_TEXT} · ` : ""}
          {note ? t("comp.noteHint") : t("comp.replyHint")}
        </span>
        <Btn label={note ? t("note.add") : t("comp.send")} icon={note ? "note" : "send"} kind={note ? "" : "primary"} size="sm" busy={busy} onClick={() => void send()} testId="composer-send" />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- context column */

function Context({ tk, onUpdate, onReload }: { tk: StaffTicket; onUpdate: (x: StaffTicket) => void; onReload: () => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { me, can } = useSession();
  const { navigate } = useNav();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [esc, setEsc] = useState<EscalationType | null>(null);
  const canReply = can("support.reply");
  const allowed = STAFF_TRANSITIONS[tk.status] ?? [];
  const myId = me?.staff.staff_id ?? "";

  const run = async (what: string, fn: () => Promise<StaffTicket>, ok: string) => {
    setBusy(what);
    try {
      onUpdate(await fn());
      toast(ok, "ok");
    } catch (e) {
      if (!(e as ApiError).cancelled) toast(errText(i, e), "err", errMeta(e));
      onReload();
    } finally {
      setBusy(null);
    }
  };

  const assigneeOpts = [
    { v: "", label: t("sup.opNone") },
    { v: myId, label: `${me?.staff.display_name ?? ""} · ${t("sup.me")}` },
    ...(tk.assignee_id && tk.assignee_id !== myId ? [{ v: tk.assignee_id, label: tk.assignee_name ?? shortId(tk.assignee_id) }] : []),
  ];
  const c = tk.context;

  return (
    <>
      <div className="ctx-sec" data-testid="ticket-controls">
        <h3>
          <Icon name="support" />
          {t("ctx.ticket")}
        </h3>
        <div className="stack sm">
          <div className="field">
            <span className="field-label">{t("col.status")}</span>
            <div className="status-flow" role="group" aria-label={t("sup.statusFlow")}>
              {TICKET_STATUSES.map((s) => {
                const cur = s === tk.status;
                const ok = allowed.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    className="btn xs"
                    aria-current={cur ? "true" : undefined}
                    disabled={!ok || cur || !canReply || !!busy}
                    title={cur ? t("sup.statusCur") : ok ? t("sup.statusTo", { s: t(`tstatus.${s}`) }) : t("sup.statusBad", { a: tk.status, b: s })}
                    onClick={() => void run(`st-${s}`, () => SupportApi.patch(tk.ticket_id, { status: s }), t("sup.statusChanged", { s: t(`tstatus.${s}`) }))}
                    data-testid={`status-${s}`}
                  >
                    {t(`tstatus.${s}`)}
                  </button>
                );
              })}
            </div>
            <span className="hint">{t("sup.statusHint")}</span>
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="tk-prio">{t("col.priority")}</label>
              <Select<TicketPriority>
                id="tk-prio"
                label={t("col.priority")}
                value={tk.priority}
                disabled={!canReply || !!busy}
                onChange={(p) => void run("prio", () => SupportApi.patch(tk.ticket_id, { priority: p }), t("common.saved"))}
                options={PRIORITIES.map((p) => ({ v: p, label: t(`prio.${p}`) }))}
                testId="tk-prio"
              />
            </div>
            <div className="field">
              <label htmlFor="tk-op">{t("col.operator")}</label>
              <Select
                id="tk-op"
                label={t("col.operator")}
                value={tk.assignee_id ?? ""}
                disabled={!canReply || !!busy}
                onChange={(v) => void run("assign", () => SupportApi.patch(tk.ticket_id, { assignee_id: v || null }), t("sup.assigned"))}
                options={assigneeOpts}
                testId="tk-op"
              />
            </div>
          </div>
          {tk.assignee_id !== myId && tk.status !== "CLOSED" && tk.status !== "RESOLVED" && (
            <Btn size="sm" icon="user" label={t("sup.take")} perm="support.reply" busy={busy === "take"} onClick={() => void run("take", () => SupportApi.take(tk.ticket_id), t("sup.taken", { id: tk.number }))} testId="take-btn" />
          )}
        </div>
      </div>

      <div className="ctx-sec" data-testid="ctx-user">
        <h3>
          <Icon name="user" />
          {t("ctx.user")}
        </h3>
        {tk.anonymized ? (
          <p className="small muted">{t("sup.anonymizedNote")}</p>
        ) : tk.learner ? (
          <dl className="kv">
            <dt>ID</dt>
            <dd>
              {can("users.read") ? (
                <button type="button" className="link-btn mono" onClick={() => navigate("users", tk.learner!.user_id)} data-testid="ctx-learner-link">
                  {shortId(tk.learner.user_id, 8, 4)}
                </button>
              ) : (
                <span className="mono">{shortId(tk.learner.user_id, 8, 4)}</span>
              )}
            </dd>
            <dt>{t("lr.kind")}</dt>
            <dd>
              {tk.learner.kind === "child" ? t("lk.child") : t("lk.account")}
              {tk.learner.age_band ? ` · ${tk.learner.age_band}` : ""}
            </dd>
            <dt>Telegram</dt>
            <dd>
              {tk.learner.username ? `${tgHandle(tk.learner.username)} · ` : ""}
              <span className="masked">{tk.learner.telegram_id_masked ?? "—"}</span>
            </dd>
            <dt>{t("lr.f.lang")}</dt>
            <dd>{tk.learner.locale ? t(`ulang.${tk.learner.locale}`) : "—"}</dd>
            <dt>{t("col.status")}</dt>
            <dd>{t(`lstatus.${tk.learner.status}`)}</dd>
          </dl>
        ) : (
          <p className="small muted">{tk.user_id ? (can("users.read") ? t("ctx.userUnavailable") : t("perm.need", { p: "users.read" })) : "—"}</p>
        )}
        <p className="xs muted mt-8">{t("ctx.userNote")}</p>
      </div>

      {c && (
        <div className="ctx-sec" data-testid="ctx-context">
          <h3>
            <Icon name="link" />
            {t("ctx.context")}
          </h3>
          <dl className="kv">
            <dt>{t("ctx.screen")}</dt>
            <dd className="mono xs wrap-any">{c.deeplink ?? "—"}</dd>
            <dt>{t("ctx.client")}</dt>
            <dd className="mono">{c.client_version}</dd>
            {tk.correlation_id && (
              <>
                <dt>trace</dt>
                <dd className="mono">
                  {shortId(tk.correlation_id, 6, 4)} <CopyBtn value={tk.correlation_id} label="trace" />
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

      <div className="ctx-sec" data-testid="ctx-escalate">
        <h3>
          <Icon name="escalate" />
          {t("esc.title")}
        </h3>
        {tk.escalations.length > 0 && (
          <div className="stack sm mb-12">
            {tk.escalations.map((x) => (
              <div key={x.escalation_id} className="row" data-testid="escalation">
                <Icon name={ESC_ICON[x.type] ?? "escalate"} />
                <span className="small b">{t(`esc.${x.type}`)}</span>
                <Pill tone={x.status === "OPEN" ? "warn" : "neutral"}>{x.status}</Pill>
                <span className="xs muted">{fmt.rel(x.created_at)}</span>
                <div className="xs ink2 wrap-any" style={{ flexBasis: "100%" }}>
                  {x.note}
                </div>
              </div>
            ))}
          </div>
        )}
        {canReply ? (
          <MenuButton
            label={t("esc.create")}
            className="btn sm"
            alignLeft
            testId="esc-btn"
            render={(close) => (
              <>
                <div className="menu-h">{t("esc.create")}</div>
                {ESCALATIONS.map((k) => (
                  <MenuItem key={k} icon={ESC_ICON[k]} sub={t(`esc.team.${k}`)} onClick={() => { close(); setEsc(k); }} testId={`esc-${k}`}>
                    {t(`esc.${k}`)}
                  </MenuItem>
                ))}
              </>
            )}
          >
            <Icon name="plus" />
            <span>{t("esc.create")}</span>
            <Icon name="chevD" />
          </MenuButton>
        ) : (
          <Btn size="sm" icon="plus" label={t("esc.create")} perm="support.reply" />
        )}
        <p className="xs muted mt-8">{t("esc.note")}</p>
      </div>

      <div className="ctx-sec">
        <h3>
          <Icon name="clock" />
          SLA
        </h3>
        <dl className="kv">
          <dt>{t("sla.first")}</dt>
          <dd>
            {tk.first_response_at ? (
              <>
                {fmt.dateTime(tk.first_response_at)} <Pill tone="good">{t("sla.met")}</Pill>
              </>
            ) : (
              <>
                {t("sla.due")} {fmt.dateTime(tk.sla_first_response_at)}
              </>
            )}
          </dd>
          <dt>{t("sla.res")}</dt>
          <dd>
            {tk.resolved_at ? fmt.dateTime(tk.resolved_at) : `${t("sla.due")} ${fmt.dateTime(tk.sla_resolution_at)}`}
          </dd>
          <dt>{t("col.channel")}</dt>
          <dd>{tk.channel}</dd>
          {tk.sla_paused && (
            <>
              <dt>{t("sla.state")}</dt>
              <dd>{t("sla.pausedT")}</dd>
            </>
          )}
        </dl>
      </div>

      {tk.status_history.length > 0 && (
        <div className="ctx-sec">
          <h3>
            <Icon name="activity" />
            {t("sup.history")}
          </h3>
          <ul className="hist">
            {tk.status_history.map((h, idx) => (
              <li key={idx}>
                <span className="mono xs muted">{fmt.dateTime(h.at)}</span>
                <span className="small">
                  {h.from_status ? `${h.from_status} → ` : ""}
                  <b>{h.status}</b>
                </span>
                <span className="xs muted">{h.changed_by}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {esc && (
        <ConfirmCommand
          title={t("esc.t", { k: t(`esc.${esc}`) })}
          text={t("esc.m", { team: t(`esc.team.${esc}`) })}
          icon="escalate"
          tone=""
          ok={t("esc.ok")}
          reasonLabel={t("esc.noteLabel")}
          reasonPlaceholder={t("esc.ph")}
          testId="esc-confirm"
          onClose={() => setEsc(null)}
          onConfirm={async (note) => {
            try {
              await SupportApi.escalate(tk.ticket_id, esc, note);
              toast(t("esc.done", { k: t(`esc.${esc}`) }), "ok", "POST …/escalations");
              onReload();
              return null;
            } catch (e) {
              return (e as ApiError).cancelled ? null : errText(i, e);
            }
          }}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------- client view (A42) */

function ClientView({ tk, onClose }: { tk: StaffTicket; onClose: () => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const [cv, setCv] = useState<ClientTicket | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    SupportApi.clientView(tk.ticket_id)
      .then((x) => alive && setCv(x))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [tk.ticket_id]);
  const hidden = cv ? Math.max(0, tk.messages.length - cv.messages.length) : 0;
  return (
    <Drawer
      title={t("cv.btn")}
      sub={
        <>
          <span className="mono">{tk.number}</span>
          <span>· {userTag(tk, t)} · Telegram</span>
        </>
      }
      onClose={onClose}
      testId="client-view"
    >
      {error ? (
        <LoadError error={error} />
      ) : !cv ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="stack">
          <Callout kind="info" icon="eye">
            {t("cv.note", { n: hidden })}
          </Callout>
          <div className="tg-phone" role="log" aria-label={t("cv.btn")} data-testid="client-feed">
            <div className="tg-top">
              <span className="tg-ava">TH</span>
              <div>
                <b>TilHero</b>
                <div className="xs">{t("cv.bot")}</div>
              </div>
            </div>
            <div className="tg-feed">
              <div className="tg-svc">{t("cv.opened", { id: cv.number, s: cv.subject })}</div>
              {cv.messages
                .filter((m) => m.sender_type !== "system")
                .map((m) => (
                  <div key={m.message_id} className={cx("tg-msg", m.sender_type === "user" && "me")}>
                    <div className="tg-b">
                      {m.sender_type === "operator" && <div className="tg-from">{m.author_name ? `${t("cv.from")} · ${m.author_name}` : t("cv.from")}</div>}
                      {m.text}
                      <span className="tg-t">{fmt.time(m.created_at)}</span>
                    </div>
                  </div>
                ))}
              {cv.status === "WAITING_CUSTOMER" ? <div className="tg-svc">{t("cv.waiting")}</div> : cv.status === "RESOLVED" || cv.status === "CLOSED" ? <div className="tg-svc">{t("cv.resolved")}</div> : null}
            </div>
            <div className="tg-input" aria-hidden="true">
              <span>{t("cv.input")}</span>
              <Icon name="send" />
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}
