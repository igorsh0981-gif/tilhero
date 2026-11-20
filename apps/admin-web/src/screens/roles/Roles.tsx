import { useCallback, useEffect, useRef, useState } from "react";
import type { Approval, ApprovalStatus, Permission, Role, RoleCode, Staff, StaffCreated } from "@tilhero/contracts/admin";
import { PERMISSIONS, PRIVILEGED_ROLES } from "@tilhero/contracts/admin";
import { StaffApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { initials, shortId } from "../../lib/ids";
import { useEphemeral } from "../../lib/useEphemeral";
import { fmtCountdown } from "../../i18n";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, CopyBtn, cx, Empty, FieldErr, Locked, Pill, Select, Spinner, TabPanel, Tabs, type Tone } from "../../ui/kit";
import { ConfirmCommand, Drawer, MenuButton, MenuItem } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";

export const ROLE_CODES: readonly RoleCode[] = ["super_admin", "operations", "communications", "support", "methodist", "content_manager", "qa_analyst", "analyst", "auditor", "read_only"];
/**
 * Privileged role (MFA required, granting it is four-eyes): `Role.privileged` of GET /roles — admin-identity decides it
 * by the role's permissions too, so a role that gains a step-up right becomes privileged without a new admin-web
 * (review T2-7). Only until /roles has answered (or when it failed) — the contract's default list. The server decides
 * either way (202 + approval); this drives the hints.
 */
export function privilegedOf(roles: readonly Pick<Role, "code" | "privileged">[] | null): (code: string) => boolean {
  return (code) => {
    const r = roles?.find((x) => x.code === code);
    return r ? r.privileged : (PRIVILEGED_ROLES as readonly string[]).includes(code);
  };
}

/** Matrix rows: section access first, then commands (admin.ts Permission catalogue). */
export const PERM_GROUPS: ReadonlyArray<{ id: "sections" | "actions"; perms: readonly Permission[] }> = [
  { id: "sections", perms: ["dashboard.read", "users.read", "support.read", "whatsnew.manage", "notif.templates.manage", "notif.campaigns.manage", "config.read", "audit.read", "content.read", "ai.read", "qa.read", "costs.read", "memory.read", "game.read"] },
  {
    id: "actions",
    perms: [
      "users.sensitive.read",
      "support.reply",
      "support.manage",
      "whatsnew.publish",
      "notif.campaigns.send",
      "config.edit",
      "config.publish",
      "staff.manage",
      "roles.manage",
      // sprint 3: content life cycle, media rights and learners' requests, languages and pairs
      "content.edit",
      "content.review",
      "content.publish",
      "media.rights",
      "lang.manage",
      // sprint 4: agent versions and golden tests, publication / canary / rollback and model prices (step-up),
      // learner replies with a reason (audited), re-evaluation and appeals (step-up), AI limits and emergency stop (step-up)
      "ai.manage",
      "ai.publish",
      "qa.transcripts",
      "qa.review",
      "costs.manage",
      // sprint 5: manual adjustment of one memory card (step-up, reason, audit), the course dictionary and AI translations
      "memory.manage",
      "glossary.manage",
      // sprint 6: drafts of the rules, heroes, shop and events; activation and publication (step-up); manual wallet
      // operations, reversals and refunds (step-up, reason, audit)
      "game.manage",
      "game.publish",
      "wallet.adjust",
    ],
  },
]

const APR_TONE: Record<ApprovalStatus, Tone> = { PENDING: "warn", APPROVED: "info", APPLIED: "good", REJECTED: "bad", EXPIRED: "neutral" };
const permKey = (p: string) => `perm.${p}` as MessageKey;

type Tr = (k: MessageKey, v?: Record<string, string | number>) => string;

/**
 * Human one-liner of an approval summary (admin-identity): staff.create_privileged / staff.role_grant /
 * role.permissions_change / staff.privileged_revoke / staff.privileged_reset / staff.reactivate_privileged. Statuses and
 * actions come from the dictionaries — never raw codes like "DISABLED".
 */
export function approvalLabel(a: Approval, roleName: (r: string) => string, t: Tr): string {
  const s = a.summary as {
    staff?: { email?: string; display_name?: string };
    role?: string;
    from_role?: string;
    to_role?: string | null;
    status?: string | null;
    from_status?: string;
    action?: string;
    added?: string[];
    removed?: string[];
  };
  const who = s.staff?.display_name || s.staff?.email || "";
  if (a.kind === "staff.create_privileged") return `${who} (${s.staff?.email ?? ""}) · ${roleName(s.role ?? "")}`;
  if (a.kind === "staff.role_grant") return `${who}: ${roleName(s.from_role ?? "")} → ${roleName(s.to_role ?? "")}`;
  if (a.kind === "staff.privileged_revoke") {
    const parts: string[] = [];
    if (s.to_role) parts.push(`${roleName(s.from_role ?? "")} → ${roleName(s.to_role)}`);
    if (s.status === "DISABLED" || s.status === "ACTIVE" || s.status === "LOCKED") parts.push(t(`staff.st.${s.status}`));
    return `${who}: ${parts.join(" · ") || roleName(s.from_role ?? "")}`;
  }
  if (a.kind === "staff.privileged_reset") return `${who}: ${t(s.action === "mfa" ? "apr.reset.mfa" : "apr.reset.password")}`;
  if (a.kind === "staff.reactivate_privileged") {
    // admin-identity: {staff, role, to_role (null unless the role changes too), from_status}
    const from = s.from_status === "LOCKED" ? "LOCKED" : "DISABLED";
    const role = s.to_role && s.to_role !== s.role ? `${roleName(s.role ?? "")} → ${roleName(s.to_role)}` : roleName(s.role ?? "");
    return `${who}: ${t(`staff.st.${from}`)} → ${t("staff.st.ACTIVE")} · ${role}`;
  }
  const add = (s.added ?? []).map((p) => `+${p}`);
  const rem = (s.removed ?? []).map((p) => `−${p}`);
  return `${roleName(s.role ?? "")}: ${[...add, ...rem].join(", ") || "—"}`;
}

/**
 * Approvals whose approve response carries a one-time temporary password for the APPROVER (review P2-1/P2-2): the
 * author of a privileged account / role grant / re-enable never learns the target's credentials.
 */
export function issuesPassword(a: Pick<Approval, "kind" | "summary">): boolean {
  if (a.kind === "staff.privileged_reset") return (a.summary as { action?: string }).action !== "mfa";
  return a.kind === "staff.create_privileged" || a.kind === "staff.role_grant" || a.kind === "staff.reactivate_privileged";
}

const targetOf = (a: Approval) => (a.summary as { staff?: { staff_id?: string } }).staff?.staff_id;

type RolesTab = "matrix" | "staff";

export function Roles() {
  const { t } = useI18n();
  const { can } = useSession();
  const [tab, setTab] = useState<RolesTab>(() => (can("roles.manage") || !can("staff.manage") ? "matrix" : "staff"));
  const [approvalsRev, setApprovalsRev] = useState(0);
  const [roles, setRoles] = useState<{ items: Role[]; permissions: Permission[] } | null>(null);
  const [rolesErr, setRolesErr] = useState<unknown>(null);
  const [pending, setPending] = useState<Approval[]>([]);

  const loadRoles = useCallback(() => {
    setRolesErr(null);
    StaffApi.roles()
      .then((r) => setRoles({ items: r.items, permissions: [...PERMISSIONS] }))
      .catch(setRolesErr);
  }, []);
  useEffect(loadRoles, [loadRoles]);
  const changed = useCallback(() => {
    loadRoles();
    setApprovalsRev((n) => n + 1);
  }, [loadRoles]);

  return (
    <div data-testid="roles">
      <div className="page-head">
        <div className="lead">
          <p>{t("roles.lead")}</p>
        </div>
      </div>
      <Approvals rev={approvalsRev} onPending={setPending} onChanged={changed} />
      <Tabs<RolesTab>
        id="roles"
        label={t("page.roles")}
        value={tab}
        onChange={setTab}
        className="mb-16"
        items={[
          { v: "matrix", label: t("roles.matrix"), icon: "key", testId: "roles-tab-matrix" },
          { v: "staff", label: t("roles.staff"), icon: "users", testId: "roles-tab-staff" },
        ]}
      />
      <TabPanel id="roles" value={tab}>
        {tab === "matrix" ? (
          rolesErr ? (
            <LoadError error={rolesErr} onRetry={loadRoles} />
          ) : !roles ? (
            <Spinner label={t("common.loading")} />
          ) : (
            <Matrix roles={roles.items} catalogue={roles.permissions} pending={pending} onChanged={changed} />
          )
        ) : can("staff.manage") ? (
          <StaffTab roles={roles?.items ?? null} pending={pending} onChanged={changed} />
        ) : (
          <Locked title={t("err.denied.t")} text={t("perm.need", { p: "staff.manage" })} testId="staff-locked" />
        )}
      </TabPanel>
    </div>
  );
}

/* ---------------------------------------------------------------- four-eyes requests */

function Approvals({ rev, onPending, onChanged }: { rev: number; onPending: (a: Approval[]) => void; onChanged: () => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { me } = useSession();
  const toast = useToast();
  const [all, setAll] = useState(false);
  const [items, setItems] = useState<Approval[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [decide, setDecide] = useState<{ a: Approval; kind: "approve" | "reject" } | null>(null);
  // create_privileged / role_grant / reactivate_privileged / privileged_reset (password): the temporary password is
  // issued to the APPROVER, once, for 60 s
  const [issued, setIssued, issuedLeft] = useEphemeral<{ who: string; pwd: string }>();
  const roleName = (r: string) => ((ROLE_CODES as readonly string[]).includes(r) ? t(`role.${r as RoleCode}`) : r);

  const load = useCallback(() => {
    StaffApi.approvals(all ? undefined : "PENDING")
      .then((p) => {
        setItems(p.items);
        setError(null);
        if (!all) onPending(p.items);
        else onPending(p.items.filter((x) => x.status === "PENDING"));
      })
      .catch(setError);
  }, [all, onPending]);
  useEffect(load, [load, rev]);

  const banner = issued && (
        <div className="temp-banner" role="status" data-testid="issued-banner">
          <Icon name="key" />
          <div className="grow">
            <b>
              {t("staff.tempPwd")} · {issued.who}
            </b>
            <span>
              {t("apr.issuedOnce")} · {t("staff.pwdHidesIn")} <b className="mono">{fmtCountdown(issuedLeft)}</b>
            </span>
          </div>
          <span className="code-chip temp-big" data-testid="issued-password">
            {issued.pwd}
          </span>
          <CopyBtn value={issued.pwd} label={t("staff.tempPwd")} />
          <Btn size="xs" kind="ghost" icon="x" aria={t("common.hide")} onClick={() => setIssued(null)} />
        </div>
      );
  const isSuper = me?.staff.role === "super_admin";
  if (error) return <div className="mb-16"><LoadError error={error} onRetry={load} /></div>;
  if (!items) return null;
  if (!items.length && !all)
    return (
      <>
      {banner}
      <p className="small muted row mb-16" data-testid="approvals-empty">
        <Icon name="userCheck" /> {t("apr.none")}
        <button type="button" className="link-btn" onClick={() => setAll(true)}>
          {t("apr.showAll")}
        </button>
      </p>
      </>
    );

  return (
    <section className="panel mb-16" data-testid="approvals">
      {banner}
      <div className="panel-h">
        <h2 className="panel-t">
          <Icon name="userCheck" />
          {t("apr.title")}
        </h2>
        <span className="panel-sub">{t("apr.sub")}</span>
        <span className="grow" />
        <label className="check" htmlFor="apr-all">
          <input id="apr-all" type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          <span>{t("apr.all")}</span>
        </label>
      </div>
      <div className="table-wrap">
        <table className="tbl compact">
          <thead>
            <tr>
              <th>{t("apr.col.kind")}</th>
              <th>{t("apr.col.change")}</th>
              <th>{t("cmd.reason")}</th>
              <th>{t("apr.col.author")}</th>
              <th>{t("col.status")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((a) => {
              const own = a.requested_by.staff_id === me?.staff.staff_id;
              const pend = a.status === "PENDING";
              return (
                <tr key={a.approval_id} className={pend ? "sev-warn" : a.status === "REJECTED" ? "sev-bad" : "sev-none"} data-testid="approval-row">
                  <td className="nowrap">
                    <div className="cell-main">{t(`apr.kind.${a.kind}`)}</div>
                    <div className="cell-sub mono">{shortId(a.approval_id, 8, 4)}</div>
                  </td>
                  <td className="mono small wrap-any" style={{ minWidth: 200 }}>
                    {approvalLabel(a, roleName, t)}
                  </td>
                  <td className="small" style={{ minWidth: 160 }}>
                    {a.reason}
                  </td>
                  <td className="nowrap">
                    <div className="cell-main">{a.requested_by.display_name}</div>
                    <div className="cell-sub">{fmt.rel(a.requested_at)}</div>
                  </td>
                  <td className="nowrap">
                    <Pill tone={APR_TONE[a.status]}>{t(`apr.st.${a.status}`)}</Pill>
                    {a.waived && <div className="cell-sub">{t("apr.waived")}</div>}
                    {pend && <div className="cell-sub">{t("apr.expires", { t: fmt.dateTime(a.expires_at) })}</div>}
                    {a.decided_by && (
                      <div className="cell-sub">
                        {a.decided_by.display_name} · {fmt.rel(a.decided_at)}
                      </div>
                    )}
                  </td>
                  <td className="actions-cell nowrap">
                    {pend &&
                      (own ? (
                        <span className="xs muted">{t("apr.own")}</span>
                      ) : isSuper ? (
                        <>
                          <Btn size="xs" icon="check" label={t("apr.approve")} onClick={() => setDecide({ a, kind: "approve" })} testId="apr-approve" />
                          <Btn size="xs" kind="ghost" label={t("apr.reject")} onClick={() => setDecide({ a, kind: "reject" })} testId="apr-reject" />
                        </>
                      ) : (
                        <span className="xs muted">{t("apr.superOnly")}</span>
                      ))}
                  </td>
                </tr>
              );
            })}
            {!items.length && (
              <tr>
                <td colSpan={6} className="empty-cell">
                  <Empty icon="userCheck" title={t("apr.none")} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="panel-f">
        <Icon name="shield" />
        <span>{t("apr.foot")}</span>
      </div>
      {decide && (
        <ConfirmCommand
          title={t(decide.kind === "approve" ? "apr.approveT" : "apr.rejectT")}
          text={approvalLabel(decide.a, roleName, t)}
          icon={decide.kind === "approve" ? "userCheck" : "ban"}
          tone={decide.kind === "approve" ? "bad" : "warn"}
          ok={t(decide.kind === "approve" ? "apr.approve" : "apr.reject")}
          okKind={decide.kind === "approve" ? "primary" : "danger"}
          reasonLabel={t("apr.note")}
          extra={
            <>
              {decide.kind === "approve" && issuesPassword(decide.a) && (
                <Callout kind="info" icon="key" testId="apr-issues-pwd">
                  {t("apr.issuesPwd")}
                </Callout>
              )}
              <Callout kind="warn" icon="smartphoneKey">
                {t("apr.stepUpNote")}
              </Callout>
            </>
          }
          testId="apr-confirm"
          onClose={() => setDecide(null)}
          onConfirm={async (note) => {
            try {
              const res = decide.kind === "approve" ? await StaffApi.approve(decide.a.approval_id, note) : await StaffApi.reject(decide.a.approval_id, note);
              if (res.temporary_password) {
                const st = (decide.a.summary as { staff?: { email?: string } }).staff;
                setIssued({ who: st?.email ?? "", pwd: res.temporary_password });
              }
              toast(t(decide.kind === "approve" ? "apr.approved" : "apr.rejected"), decide.kind === "approve" ? "ok" : "info", `${res.status}`);
              onChanged();
              return null;
            } catch (e) {
              if ((e as ApiError).cancelled) return t("stepup.cancelled");
              return errText(i, e);
            }
          }}
        />
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- permission matrix */

function Matrix({ roles, catalogue, pending, onChanged }: { roles: Role[]; catalogue: Permission[]; pending: Approval[]; onChanged: () => void }) {
  const i = useI18n();
  const { t, l, fmt } = i;
  const { can, me, refreshMe } = useSession();
  const toast = useToast();
  const editable = can("roles.manage");
  const [ask, setAsk] = useState<{ role: Role; perm: Permission; value: boolean } | null>(null);
  const ordered = ROLE_CODES.map((c) => roles.find((r) => r.code === c)).filter((r): r is Role => !!r);
  const extra = roles.filter((r) => !ROLE_CODES.includes(r.code));
  const cols = [...ordered, ...extra];
  const known = new Set<string>(PERM_GROUPS.flatMap((g) => g.perms));
  const others = catalogue.filter((p) => !known.has(p));
  const groups = [...PERM_GROUPS, ...(others.length ? [{ id: "other" as const, perms: others }] : [])];
  const pendingRole = (code: string) => pending.find((a) => a.kind === "role.permissions_change" && (a.summary as { role?: string }).role === code);

  return (
    <>
      <div className="mb-12">
        {editable ? (
          <Callout kind="info" icon="info">
            {t("roles.editNote")}
          </Callout>
        ) : (
          <Callout icon="lock">{t("roles.ro", { p: "roles.manage" })}</Callout>
        )}
      </div>
      <section className="panel" data-testid="matrix">
        <div className="table-wrap">
          <table className="tbl matrix compact">
            <thead>
              <tr>
                <th>Permission</th>
                {cols.map((r) => (
                  <th key={r.code} className="c nowrap" title={`${r.code} · ${r.staff_count}`}>
                    {l(r.name)}
                    {r.privileged && <Icon name="shield" className="th-ico" />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <MatrixGroup key={g.id} id={g.id} perms={g.perms} cols={cols} editable={editable} pendingRole={pendingRole} onToggle={(role, perm, value) => setAsk({ role, perm, value })} />
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel-f">
          <Icon name="shield" />
          <span>{t("roles.backend")}</span>
          <span className="grow" />
          {cols[0]?.updated_at && <span className="xs muted">{t("roles.updated", { t: fmt.dateTime(cols.map((r) => r.updated_at).sort().at(-1) ?? null) })}</span>}
        </div>
      </section>
      {ask && (
        <ConfirmCommand
          title={t("roles.changeT", { r: l(ask.role.name) })}
          text={`${ask.perm}: ${ask.value ? "off → on" : "on → off"} — ${t("roles.fourEyes")}`}
          icon="key"
          tone="bad"
          ok={t("roles.send")}
          extra={<Callout kind="warn" icon="smartphoneKey">{t("apr.stepUpNote")}</Callout>}
          testId="perm-confirm"
          onClose={() => setAsk(null)}
          onConfirm={async (reason) => {
            const next = ask.value ? [...new Set([...ask.role.permissions, ask.perm])] : ask.role.permissions.filter((p) => p !== ask.perm);
            try {
              const res = await StaffApi.putRole(ask.role.code, next, reason);
              const a = res.approval;
              toast(a.waived || a.status === "APPLIED" ? t("roles.applied", { r: l(ask.role.name) }) : t("roles.requested"), a.waived ? "ok" : "info", a.waived ? "four-eyes waived: single_super_admin" : "four-eyes · PENDING");
              onChanged();
              if (ask.role.code === (me?.impersonating ?? me?.staff.role)) void refreshMe();
              return null;
            } catch (e) {
              if ((e as ApiError).cancelled) return t("stepup.cancelled");
              return errText(i, e);
            }
          }}
        />
      )}
    </>
  );
}

function MatrixGroup({ id, perms, cols, editable, pendingRole, onToggle }: { id: string; perms: readonly Permission[]; cols: Role[]; editable: boolean; pendingRole: (code: string) => Approval | undefined; onToggle: (r: Role, p: Permission, v: boolean) => void }) {
  const { t, l } = useI18n();
  return (
    <>
      <tr className="grp">
        <td colSpan={cols.length + 1}>{t(`perm.g.${id as "sections"}`)}</td>
      </tr>
      {perms.map((p) => (
        <tr key={p}>
          <td>
            <span className="mono">{p}</span>
            <div className="cell-sub">{t(permKey(p))}</div>
          </td>
          {cols.map((r) => {
            const on = r.permissions.includes(p);
            const pend = pendingRole(r.code);
            const locked = !editable || r.code === "super_admin" || !!pend;
            return (
              <td key={r.code} className={cx("c", pend && "is-pending")}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={locked}
                  aria-label={`${l(r.name)}: ${p}`}
                  title={r.code === "super_admin" ? t("roles.saAll") : pend ? t("roles.pending") : undefined}
                  onChange={(e) => {
                    e.preventDefault();
                    if (!locked) onToggle(r, p, !on);
                  }}
                  data-testid={`pm-${r.code}-${p}`}
                />
                {pend && <span className="pend-dot" aria-hidden="true" />}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

/* ---------------------------------------------------------------- staff */

type StaffCmd =
  | { kind: "role"; s: Staff; to: RoleCode }
  | { kind: "block"; s: Staff }
  | { kind: "unblock"; s: Staff }
  | { kind: "reset-password"; s: Staff }
  | { kind: "reset-mfa"; s: Staff };

function StaffTab({ roles, pending, onChanged }: { roles: Role[] | null; pending: Approval[]; onChanged: () => void }) {
  const i = useI18n();
  const { t, fmt, l } = i;
  const { me } = useSession();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<Staff[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [cmd, setCmd] = useState<StaffCmd | null>(null);
  const [adding, setAdding] = useState(false);
  // the one-time password: hidden after 60 s, when the browser tab is hidden and when this tab/section is left
  const [temp, setTemp, tempLeft] = useEphemeral<{ who: string; pwd: string }>();
  const [resetReq, setResetReq] = useState<{ who: string; action: "password" | "mfa" } | null>(null);
  // P2-2: re-enabling a privileged account is a four-eyes request (202), not an immediate change
  const [reactReq, setReactReq] = useState<string | null>(null);
  const req = useRef(0);

  const roleName = (r: string) => {
    const x = roles?.find((y) => y.code === r);
    return x ? l(x.name) : (ROLE_CODES as readonly string[]).includes(r) ? t(`role.${r as RoleCode}`) : r;
  };
  const isPrivileged = privilegedOf(roles);
  const load = useCallback(async (f: { q?: string; role?: string; status?: string; cursor?: string | null }, append: boolean) => {
    const id = ++req.current;
    setLoading(true);
    try {
      const p = await StaffApi.list(f);
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
  const filters = { q: q.trim() || undefined, role: role || undefined, status: status || undefined };
  const fKey = JSON.stringify(filters);
  useEffect(() => {
    const tm = setTimeout(() => void load(JSON.parse(fKey) as typeof filters, false), q ? 300 : 0);
    return () => clearTimeout(tm);
    // q is part of fKey; the debounce only applies to typing
  }, [fKey, load, q]);

  // a pending role grant or privileged creation: the row shows the requested role and the role select is locked
  const pendingFor = (s: Staff) => pending.find((a) => (a.kind === "staff.role_grant" || a.kind === "staff.create_privileged") && targetOf(a) === s.staff_id);
  const pendingReactivate = (s: Staff) => pending.find((a) => a.kind === "staff.reactivate_privileged" && targetOf(a) === s.staff_id);
  const reload = () => {
    void load(filters, false);
    onChanged();
  };

  const runCmd = async (c: StaffCmd, reason: string): Promise<string | null> => {
    try {
      if (c.kind === "role" || c.kind === "block" || c.kind === "unblock") {
        const body = c.kind === "role" ? { role: c.to, reason } : { status: c.kind === "block" ? ("DISABLED" as const) : ("ACTIVE" as const), reason };
        const res = await StaffApi.patch(c.s.staff_id, body);
        const pendingReq = res && "approval" in res ? res : null;
        // the single super_admin: the request applied at once (waived) and the target's new password comes back here
        if (pendingReq?.temporary_password) setTemp({ who: c.s.email, pwd: pendingReq.temporary_password });
        if (pendingReq && pendingReq.approval.status === "PENDING") {
          if (c.kind === "unblock") {
            setReactReq(c.s.display_name);
            toast(t("staff.reactivateRequested", { u: c.s.display_name }), "info", "four-eyes · staff.reactivate_privileged");
          } else toast(t("staff.requested", { u: c.s.display_name }), "info", "four-eyes · PENDING");
        } else toast(t(c.kind === "role" ? "staff.roleChanged" : c.kind === "block" ? "staff.blocked" : "staff.unblocked", { u: c.s.display_name }), "ok", "session_version +1");
      } else if (c.kind === "reset-password") {
        const res = await StaffApi.resetPassword(c.s.staff_id, reason);
        if ("approval" in res) {
          // privileged target: four-eyes — the author never sees the password, the approver gets it
          setResetReq({ who: c.s.display_name, action: "password" });
          toast(t("staff.requested", { u: c.s.display_name }), "info", "four-eyes · staff.privileged_reset");
        } else {
          setTemp({ who: c.s.email, pwd: res.temporary_password });
          toast(t("staff.resetDone", { u: c.s.display_name }), "ok", "session_version +1");
        }
      } else {
        const res = await StaffApi.resetMfa(c.s.staff_id, reason);
        if (res && "approval" in res) {
          setResetReq({ who: c.s.display_name, action: "mfa" });
          toast(t("staff.requested", { u: c.s.display_name }), "info", "four-eyes · staff.privileged_reset");
        } else toast(t("staff.mfaResetDone", { u: c.s.display_name }), "ok", "session_version +1");
      }
      reload();
      return null;
    } catch (e) {
      if ((e as ApiError).cancelled) return t("stepup.cancelled");
      return errText(i, e);
    }
  };

  return (
    <div data-testid="staff">
      {temp && (
        <div className="temp-banner" role="status" data-testid="temp-banner">
          <Icon name="key" />
          <div className="grow">
            <b>
              {t("staff.tempPwd")} · {temp.who}
            </b>
            <span>
              {t("staff.pwdOnce")} · {t("staff.pwdHidesIn")} <b className="mono" data-testid="temp-countdown">{fmtCountdown(tempLeft)}</b>
            </span>
          </div>
          <span className="code-chip temp-big" data-testid="temp-password">
            {temp.pwd}
          </span>
          <CopyBtn value={temp.pwd} label={t("staff.tempPwd")} />
          <Btn size="xs" kind="ghost" icon="x" aria={t("common.hide")} onClick={() => setTemp(null)} />
        </div>
      )}
      {resetReq && (
        <div className="mb-12">
          <Callout kind="warn" icon="userCheck" testId="reset-requested">
            <b>{t("staff.resetRequestedT", { u: resetReq.who })}</b> {t(resetReq.action === "mfa" ? "staff.resetRequestedMfa" : "staff.resetRequestedPwd")}
          </Callout>
        </div>
      )}
      {reactReq && (
        <div className="mb-12">
          <Callout kind="warn" icon="userCheck" testId="reactivate-requested">
            <b>{t("staff.reactivateRequested", { u: reactReq })}</b> {t("staff.reactivateRequestedM")}
          </Callout>
        </div>
      )}
      <div className="staff-head">
        <div className="grow">
          <Callout icon="key">{t("staff.noteLocal")}</Callout>
        </div>
        <Btn label={t("staff.add")} icon="userPlus" kind="primary" perm="staff.manage" onClick={() => setAdding(true)} testId="staff-add" />
      </div>
      <div className="toolbar">
        <div className="input-wrap">
          <Icon name="search" />
          <input className="input" type="search" placeholder={t("staff.searchPh")} aria-label={t("staff.searchPh")} value={q} maxLength={120} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select id="staff-role-f" label={t("staff.role")} value={role} onChange={setRole} options={[{ v: "", label: t("staff.allRoles") }, ...ROLE_CODES.map((r) => ({ v: r, label: roleName(r) }))]} />
        <Select
          id="staff-status-f"
          label={t("col.status")}
          value={status}
          onChange={setStatus}
          options={[{ v: "", label: t("users.allStatuses") }, ...(["ACTIVE", "LOCKED", "DISABLED"] as const).map((s) => ({ v: s, label: t(`staff.st.${s}`) }))]}
        />
      </div>
      {error ? <LoadError error={error} onRetry={() => void load(filters, false)} /> : null}
      <section className="panel">
        <div className="table-wrap">
          <table className="tbl" data-testid="staff-table">
            <thead>
              <tr>
                <th>{t("staff.col.staff")}</th>
                <th>{t("staff.role")}</th>
                <th>{t("staff.col.method")}</th>
                <th>MFA</th>
                <th>{t("staff.col.lastLogin")}</th>
                <th>{t("col.status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const self = s.staff_id === me?.staff.staff_id;
                const pend = pendingFor(s);
                const priv = isPrivileged(s.role);
                return (
                  <tr key={s.staff_id} className={s.status !== "ACTIVE" ? "sev-bad" : priv && !s.mfa_enabled ? "sev-warn" : "sev-none"} data-staff={s.email}>
                    <td>
                      <div className="staff-cell">
                        <span className="staff-avatar">{initials(s.display_name)}</span>
                        <div>
                          <div className="cell-main">
                            {s.display_name}
                            {self && (
                              <>
                                {" "}
                                <span className="pill info no-dot">{t("staff.self")}</span>
                              </>
                            )}
                          </div>
                          <div className="cell-sub mono">{s.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="role-cell">
                      {!self && s.status === "ACTIVE" && !pend ? (
                        <Select<RoleCode>
                          id={`staff-role-${s.staff_id}`}
                          label={`${t("staff.role")} · ${s.email}`}
                          value={s.role}
                          onChange={(to) => to !== s.role && setCmd({ kind: "role", s, to })}
                          options={ROLE_CODES.map((r) => ({ v: r, label: roleName(r) }))}
                          testId={`staff-role-${s.email}`}
                        />
                      ) : (
                        <span className="tag plain">{roleName(s.role)}</span>
                      )}
                      {pend && <div className="cell-sub">{t("staff.pendingRole", { r: roleName((pend.summary as { to_role?: string; role?: string }).to_role ?? (pend.summary as { role?: string }).role ?? "") })}</div>}
                    </td>
                    <td className="nowrap">
                      <span className="tag plain">{t("staff.pwd")}</span>
                      {s.must_change_password && (
                        <>
                          {" "}
                          <span className="pill warn no-dot">{t("staff.must")}</span>
                        </>
                      )}
                    </td>
                    <td>{s.mfa_enabled ? <Pill tone="good">TOTP</Pill> : priv ? <Pill tone="bad">{t("staff.mfaReqOff")}</Pill> : <span className="pill outline no-dot">{t("staff.mfaNotReq")}</span>}</td>
                    <td className="nowrap">{s.last_login_at ? fmt.rel(s.last_login_at) : <span className="muted">{t("staff.never")}</span>}</td>
                    <td>
                      <Pill tone={s.status === "ACTIVE" ? "good" : s.status === "LOCKED" ? "warn" : "bad"}>{t(`staff.st.${s.status}`)}</Pill>
                      {pendingReactivate(s) && <div className="cell-sub">{t("staff.pendingReactivate")}</div>}
                    </td>
                    <td className="actions-cell">
                      {!self && (
                        <MenuButton
                          label={t("staff.actions", { u: s.email })}
                          className="btn ghost xs"
                          testId={`staff-menu-${s.email}`}
                          render={(close) => (
                            <>
                              <div className="menu-id">
                                <span>
                                  <b>{s.display_name}</b> · <span className="mono">{s.email}</span>
                                </span>
                              </div>
                              <MenuItem icon="key" sub={t("staff.resetSub")} disabled={s.status !== "ACTIVE"} onClick={() => { close(); setCmd({ kind: "reset-password", s }); }} testId="staff-reset">
                                {t("staff.resetPwd")}
                              </MenuItem>
                              <MenuItem icon="smartphoneKey" sub={t("staff.resetMfaSub")} disabled={!s.mfa_enabled} onClick={() => { close(); setCmd({ kind: "reset-mfa", s }); }}>
                                {t("staff.resetMfa")}
                              </MenuItem>
                              {s.status === "ACTIVE" ? (
                                <MenuItem icon="ban" danger onClick={() => { close(); setCmd({ kind: "block", s }); }} testId="staff-block">
                                  {t("staff.block")}
                                </MenuItem>
                              ) : (
                                <MenuItem icon="unlock" disabled={!!pendingReactivate(s)} onClick={() => { close(); setCmd({ kind: "unblock", s }); }} testId="staff-unblock">
                                  {t("staff.unblock")}
                                </MenuItem>
                              )}
                            </>
                          )}
                        >
                          <Icon name="more" />
                        </MenuButton>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!loading && !rows.length && !error && (
                <tr>
                  <td colSpan={7} className="empty-cell">
                    <Empty icon="users" title={t("staff.empty")} text={t("common.changeFilters")} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && <Spinner label={t("common.loading")} />}
        <div className="pager">
          <span>
            <Icon name="info" /> {t("staff.foot")}
          </span>
          {cursor && !loading && <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load({ ...filters, cursor }, true)} />}
        </div>
      </section>
      {cmd && <StaffConfirm cmd={cmd} roleName={roleName} isPrivileged={isPrivileged} onClose={() => setCmd(null)} onRun={runCmd} />}
      {adding && (
        <AddStaff
          roleName={roleName}
          isPrivileged={isPrivileged}
          onClose={() => setAdding(false)}
          onCreated={() => {
            reload();
          }}
        />
      )}
    </div>
  );
}

function StaffConfirm({
  cmd,
  roleName,
  isPrivileged,
  onClose,
  onRun,
}: {
  cmd: StaffCmd;
  roleName: (r: string) => string;
  isPrivileged: (r: string) => boolean;
  onClose: () => void;
  onRun: (c: StaffCmd, reason: string) => Promise<string | null>;
}) {
  const { t } = useI18n();
  const u = cmd.s.display_name;
  const priv = cmd.kind === "role" && (isPrivileged(cmd.to) || isPrivileged(cmd.s.role));
  const grant = cmd.kind === "role" && isPrivileged(cmd.to);
  const privUnblock = cmd.kind === "unblock" && isPrivileged(cmd.s.role);
  const conf: Record<StaffCmd["kind"], { title: string; text: string; icon: "key" | "ban" | "unlock" | "smartphoneKey" | "users"; tone: "" | "warn" | "bad"; ok: string; danger?: boolean }> = {
    role: {
      title: t("staff.roleT", { u }),
      text: `${roleName(cmd.s.role)} → ${cmd.kind === "role" ? roleName(cmd.to) : ""} — ${grant ? t("staff.roleGrantFourEyes") : priv ? t("staff.roleFourEyes") : t("staff.roleSimple")}`,
      icon: "users",
      tone: priv ? "bad" : "warn",
      ok: priv ? t("roles.send") : t("common.apply"),
    },
    block: { title: t("staff.blockT", { u }), text: t("staff.blockM"), icon: "ban", tone: "bad", ok: t("staff.block"), danger: true },
    unblock: privUnblock
      ? { title: t("staff.unblockT", { u }), text: t("staff.unblockPrivM", { r: roleName(cmd.s.role) }), icon: "unlock", tone: "bad", ok: t("roles.send") }
      : { title: t("staff.unblockT", { u }), text: t("staff.unblockM"), icon: "unlock", tone: "", ok: t("staff.unblock") },
    "reset-password": { title: t("staff.resetT", { u }), text: t("staff.resetM"), icon: "key", tone: "warn", ok: t("staff.resetPwd") },
    "reset-mfa": { title: t("staff.resetMfaT", { u }), text: t("staff.resetMfaM"), icon: "smartphoneKey", tone: "warn", ok: t("staff.resetMfa") },
  };
  const c = conf[cmd.kind];
  return (
    <ConfirmCommand
      title={c.title}
      text={c.text}
      icon={c.icon}
      tone={c.tone}
      ok={c.ok}
      okKind={c.danger ? "danger" : "primary"}
      extra={<Callout kind="warn" icon="smartphoneKey">{t("apr.stepUpNote")}</Callout>}
      testId="staff-confirm"
      onClose={onClose}
      onConfirm={(reason) => onRun(cmd, reason)}
    />
  );
}

function AddStaff({ roleName, isPrivileged, onClose, onCreated }: { roleName: (r: string) => string; isPrivileged: (r: string) => boolean; onClose: () => void; onCreated: () => void }) {
  const i = useI18n();
  const { t } = i;
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<RoleCode>("support");
  const [err, setErr] = useState<{ email?: string; name?: string; g?: string }>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<StaffCreated | null>(null);
  const [pwd, setPwd, pwdLeft] = useEphemeral<string>();
  const [hadPwd, setHadPwd] = useState(false);
  const priv = isPrivileged(role);

  const submit = async () => {
    const e: typeof err = {};
    const em = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) || em.length > 254) e.email = t("staff.errEmail");
    if (name.trim().length < 2) e.name = t("staff.errName");
    setErr(e);
    if (e.email || e.name) return;
    setBusy(true);
    try {
      const res = await StaffApi.create({ email: em, display_name: name.trim(), role });
      setDone({ ...res, temporary_password: null }); // the password lives only in the ephemeral slot
      setPwd(res.temporary_password);
      setHadPwd(!!res.temporary_password);
      toast(t("staff.created", { email: em }), "ok", res.approval ? "four-eyes · PENDING" : "201");
      onCreated();
    } catch (ex) {
      if ((ex as ApiError).cancelled) setErr({ g: t("stepup.cancelled") });
      else if (ex instanceof ApiError && ex.status === 409) setErr({ email: errText(i, ex) });
      else setErr({ g: errText(i, ex) });
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setDone(null);
    setPwd(null); // drop the one-time password from memory and the DOM
    onClose();
  };

  return (
    <Drawer
      title={t("staff.formT")}
      sub={<span>{t("staff.formSub")}</span>}
      onClose={close}
      testId="staff-add-drawer"
      footer={
        done ? (
          <>
            <span className="grow" />
            <Btn label={t("common.close")} kind="primary" onClick={close} testId="staff-add-close" />
          </>
        ) : (
          <>
            <span className="grow xs muted">
              <Icon name="audit" /> {t("cmd.auditNote")}
            </span>
            <Btn label={t("common.cancel")} onClick={close} disabled={busy} />
            <Btn label={t("staff.create")} kind="primary" icon="userPlus" busy={busy} onClick={() => void submit()} testId="staff-create" />
          </>
        )
      }
    >
      {done ? (
        <div className="stack" data-testid="staff-created">
          <Callout kind="good" icon="checkCircle">
            <b>{t("staff.created", { email: done.staff.email })}</b> {roleName(done.staff.role)}
          </Callout>
          {done.approval && (
            <Callout kind="warn" icon="userCheck" testId="staff-created-four-eyes">
              {t(done.approval.status === "PENDING" ? "staff.createdFourEyes" : "staff.createdWaived", { r: roleName((done.approval.summary as { role?: string }).role ?? role) })}
              {!hadPwd && (
                <b className="block mt-8" data-testid="pwd-to-approver">
                  {t("staff.createdPwdToApprover")}
                </b>
              )}
            </Callout>
          )}
          {pwd ? (
            <div className="field">
              <span className="field-label">{t("staff.tempPwd")}</span>
              <div className="row">
                <span className="code-chip temp-big" data-testid="new-temp-password">
                  {pwd}
                </span>
                <CopyBtn value={pwd} label={t("staff.tempPwd")} />
              </div>
              <span className="hint">
                {t("staff.pwdOnce")} · {t("staff.pwdHidesIn")} <b className="mono">{fmtCountdown(pwdLeft)}</b>
              </span>
            </div>
          ) : hadPwd ? (
            <Callout icon="lock" testId="temp-hidden">
              {t("staff.pwdHidden")}
            </Callout>
          ) : null}
          {hadPwd && <p className="small ink2">{t("staff.createdM")}</p>}
        </div>
      ) : (
        <div className="stack">
          <div className="field">
            <label htmlFor="sn-email" className="req">
              {t("staff.email")}
            </label>
            <input id="sn-email" className={cx("input", err.email && "is-invalid")} type="email" autoComplete="off" spellCheck={false} placeholder="name@tilhero.local" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} data-autofocus="" />
            <FieldErr msg={err.email} />
          </div>
          <div className="field">
            <label htmlFor="sn-name" className="req">
              {t("staff.name")}
            </label>
            <input id="sn-name" className={cx("input", err.name && "is-invalid")} autoComplete="off" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            <FieldErr msg={err.name} />
          </div>
          <div className="field">
            <label htmlFor="sn-role">{t("staff.role")}</label>
            <Select<RoleCode> id="sn-role" label={t("staff.role")} value={role} onChange={setRole} options={ROLE_CODES.map((r) => ({ v: r, label: `${roleName(r)} — ${t(`role.desc.${r}`)}` }))} testId="sn-role" />
            <span className="hint">{priv ? `${t("staff.mfaPriv", { r: roleName(role) })} ${t("staff.privFourEyes")}` : t("staff.mfaNone", { r: roleName(role) })}</span>
          </div>
          <Callout kind="info" icon="key">
            {t("staff.createdM")}
          </Callout>
          <FieldErr msg={err.g} />
        </div>
      )}
    </Drawer>
  );
}
