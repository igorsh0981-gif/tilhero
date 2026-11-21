/**
 * «Модерация» (sprint 7, ADM-SOC-03, AT-79, moderation.manage): the queue of cases (open first — the oldest at the top),
 * a case — the subject of the complaint without correspondence (the nickname at the time of the report, the status of
 * the request / invite / duel / room, a link to the duel or room card), the complaint's reason and comment, the
 * complaints on the target in 30 days and the history of the target's sanctions; the decision — dismiss, a warning, a
 * ban of 1–30 days or for ever, a nickname reset — with a basis of 10..500 characters the learner will see (a ban longer
 * than 7 days or for ever asks for a fresh TOTP); the revocation of a sanction; appeals (upheld / overturned with a
 * note; overturned lifts the sanction). Every command is audited; the decision records the basis, the staff member and
 * the term (ADM-SOC-03 acceptance).
 * Routes: #/moderation[/cases[/<case_id>]] · #/moderation/sanctions · #/moderation/appeals.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminCase, AdminCaseRow, AdminSanction, AdminSanctionAppeal, CaseStatus, ModerationAction, SanctionAppealDecision } from "@tilhero/contracts/admin";
import type { SanctionAppealStatus } from "@tilhero/contracts/bff";
import { Moderation } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { DICTS, useI18n, type MessageKey } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Seg, Select, Spinner, TabPanel, Tabs } from "../../ui/kit";
import { Drawer } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { CommandKey } from "../memory/model";
import {
  APPEAL_STATUSES,
  APPEAL_TONE,
  appealBody,
  BAN_DAYS_MAX,
  BAN_DAYS_MIN,
  banUntil,
  CASE_STATUSES,
  CASE_TONE,
  emptyResolve,
  HOT_COMPLAINTS,
  isUuid,
  MOD_ACTIONS,
  MOD_TABS,
  parseModRoute,
  resolveBody,
  resolveNeedsStepUp,
  STEP_UP_DAYS,
  subjectLink,
  subjectStatusKeys,
  type Issue,
  type ModTab,
  type ResolveForm,
} from "./model";
import { NoteField, PrivacyNote, RevokeDialog, SanctionPill, SanctionsTable, StepUpNote, staffName, useCmdFail, useSocIssue, useTerm, UserRef } from "./parts";

export function ModerationPage({ routeId }: { routeId: string | null }) {
  const { t } = useI18n();
  const { navigate } = useNav();
  const r = parseModRoute(routeId);
  const [tick, setTick] = useState(0);
  return (
    <div className="stack" data-testid="moderation">
      <Tabs<ModTab> id="mod" label={t("mod.tabs")} value={r.tab} onChange={(v) => navigate("moderation", v)} items={MOD_TABS.map((v) => ({ v, label: t(`mod.tab.${v}` as MessageKey), icon: v === "cases" ? "flag" : v === "sanctions" ? "ban" : "escalate", testId: `mod-tab-${v}` }))} />
      <TabPanel id="mod" value={r.tab}>
        {r.tab === "cases" ? <CasesTab openId={r.id} tick={tick} onChanged={() => setTick((n) => n + 1)} /> : r.tab === "sanctions" ? <SanctionsTab /> : <AppealsTab />}
      </TabPanel>
      <PrivacyNote testId="mod-privacy" />
    </div>
  );
}

/* ---------------------------------------------------------------- cases */

function CasesTab({ openId, tick, onChanged }: { openId: string | null; tick: number; onChanged: () => void }) {
  const { t, fmt } = useI18n();
  const { navigate } = useNav();
  const [status, setStatus] = useState<CaseStatus>("open");
  const [rows, setRows] = useState<AdminCaseRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const req = useRef(0);
  const load = useCallback(
    async (more?: string | null) => {
      const id = ++req.current;
      try {
        const r = await Moderation.cases(status, more ?? null);
        if (id !== req.current) return;
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError(null);
      } catch (e) {
        if (id === req.current) setError(e);
      }
    },
    [status],
  );
  useEffect(() => {
    void load();
  }, [load, tick]);
  return (
    <section className="panel" aria-labelledby="mc-h" data-testid="mod-cases">
      <div className="panel-h">
        <h2 className="panel-t grow" id="mc-h">
          <Icon name="flag" /> {t("mod.cases")}
        </h2>
        <Seg<CaseStatus> label={t("col.status")} value={status} onChange={(v) => (setRows(null), setStatus(v))} items={CASE_STATUSES.map((v) => ({ v, label: t(`cst7.${v}` as MessageKey) }))} testId="mc-status" />
      </div>
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="tbl compact soc-tbl" data-testid="mc-rows">
            <caption className="sr-only">{t("mod.cases")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("col.created")}</th>
                <th scope="col">{t("mod.col.target")}</th>
                <th scope="col">{t("mod.col.subject")}</th>
                <th scope="col">{t("mod.col.reason")}</th>
                <th scope="col" className="r">
                  {t("mod.col.30d")}
                </th>
                <th scope="col">{t("col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.case_id} className={cx(openId === c.case_id && "is-selected")} data-testid={`mc-${c.case_id}`} data-status={c.status}>
                  <td className="small nowrap">
                    <button type="button" className="tr" onClick={() => navigate("moderation", `cases/${c.case_id}`)} data-testid={`mc-open-${c.case_id}`}>
                      {fmt.dateTime(c.created_at)}
                    </button>
                    <span className="xs muted block">{fmt.rel(c.created_at)}</span>
                  </td>
                  <td className="small">
                    {c.target_nickname ? <b lang="ru">{c.target_nickname}</b> : <span className="muted">{t("fr.noNick")}</span>}
                    <span className="block">
                      <UserRef id={c.target_user_id} />
                    </span>
                  </td>
                  <td className="small">{t(`subj.${c.subject_kind}` as MessageKey)}</td>
                  <td className="small">{t(`crsn.${c.reason}` as MessageKey)}</td>
                  <td className="r num">{c.target_complaints_30d >= HOT_COMPLAINTS ? <Pill tone="warn">{fmt.num(c.target_complaints_30d)}</Pill> : fmt.num(c.target_complaints_30d)}</td>
                  <td>
                    <Pill tone={CASE_TONE[c.status]}>{t(`cst7.${c.status}` as MessageKey)}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="flag" title={t(status === "open" ? "mod.noOpen" : "mod.noCases")} testId="mc-empty" />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} testId="mc-more" />
        </div>
      )}
      <div className="panel-f xs">
        <Icon name="info" /> {t("mod.queueNote")}
      </div>
      {openId && <CaseDrawer key={openId} id={openId} onClose={() => navigate("moderation", "cases")} onChanged={onChanged} />}
    </section>
  );
}

function CaseDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t, fmt } = useI18n();
  const [c, setC] = useState<AdminCase | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revoke, setRevoke] = useState<AdminSanction | null>(null);
  const load = useCallback(() => {
    Moderation.caseOf(id)
      .then((x) => (setC(x), setError(null)))
      .catch(setError);
  }, [id]);
  useEffect(load, [load]);
  return (
    <Drawer
      wide
      testId="mc-case"
      onClose={onClose}
      title={t("mod.caseT", { id: shortId(id, 8, 4) })}
      sub={
        c && (
          <>
            <Pill tone={CASE_TONE[c.status]}>{t(`cst7.${c.status}` as MessageKey)}</Pill>
            <span>{t("mod.createdAt", { t: fmt.dateTime(c.created_at) })}</span>
          </>
        )
      }
    >
      {error && !c ? (
        <LoadError error={error} onRetry={load} />
      ) : !c ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="stack" data-testid="mc-case-body" data-status={c.status}>
          <Callout icon="shield" testId="mc-no-chat">
            {t("mod.noChat")}
          </Callout>
          <CaseSubject c={c} />
          <section className="stack sm" aria-labelledby="mc-hist-h">
            <h3 className="h3" id="mc-hist-h">
              {t("mod.targetHistory", { n: c.target_sanctions.length })}
            </h3>
            <SanctionsTable items={c.target_sanctions} onRevoke={setRevoke} testId="mc-hist" empty={t("mod.noHistory")} />
          </section>
          {c.status === "open" ? (
            <ResolveForm c={c} onDone={(x) => (setC(x), onChanged())} onUnknown={load} />
          ) : (
            c.resolution && (
              <section className="card stack sm soc-decision" aria-labelledby="mc-res-h" data-testid="mc-resolution">
                <h3 className="h3" id="mc-res-h">
                  {t("mod.decision")}
                </h3>
                <dl className="dl">
                  <dt>{t("mod.action")}</dt>
                  <dd>
                    <b>{t(`mact7.${c.resolution.action}` as MessageKey)}</b>
                  </dd>
                  <dt>{t("soc.col.basis")}</dt>
                  <dd lang="ru" className="wrap-any">
                    {c.resolution.basis}
                  </dd>
                  <dt>{t("mod.by")}</dt>
                  <dd>
                    {c.resolution.resolved_by.name} · {fmt.dateTime(c.resolved_at)}
                  </dd>
                  {c.resolution.sanction_id && (
                    <>
                      <dt>{t("mod.sanctionId")}</dt>
                      <dd className="mono xs">{c.resolution.sanction_id}</dd>
                    </>
                  )}
                </dl>
              </section>
            )
          )}
        </div>
      )}
      {revoke && (
        <RevokeDialog
          sanction={revoke}
          onClose={() => setRevoke(null)}
          onDone={() => {
            setRevoke(null);
            load();
          }}
        />
      )}
    </Drawer>
  );
}

/** The subject of the complaint: what social knows about it — never the replies of a room or the answers of a duel. */
function CaseSubject({ c }: { c: AdminCase }) {
  const { t, fmt } = useI18n();
  // F7-19: the status of the request / invite / duel / room in words; an unknown status stays its code
  const statusText = (kind: AdminCase["subject_kind"], s: string) => {
    const k = subjectStatusKeys(kind, s).find((x) => x in DICTS.ru);
    return k ? t(k as MessageKey) : s;
  };
  const { can } = useSession();
  const { navigate } = useNav();
  const link = subjectLink(c.subject_kind, c.subject_id);
  const linkAllowed = link && can(link.page === "leagues" ? "league.read" : "room.read");
  return (
    <section className="card stack sm" aria-labelledby="mc-subj-h" data-testid="mc-subject">
      <h3 className="h3" id="mc-subj-h">
        {t("mod.subject")}
      </h3>
      <dl className="dl">
        <dt>{t("mod.col.reason")}</dt>
        <dd>
          <b>{t(`crsn.${c.reason}` as MessageKey)}</b>
        </dd>
        <dt>{t("mod.col.subject")}</dt>
        <dd data-testid="mc-subject-kind">
          {t(`subj.${c.subject_kind}` as MessageKey)}
          {c.subject_id && (
            <span className="mono xs muted block" title={c.subject_id}>
              {shortId(c.subject_id, 8, 4)}
            </span>
          )}
          {c.subject.status && (
            <span className="xs block" data-testid="mc-subject-status" data-status={c.subject.status}>
              {t("mod.subjectStatus", { s: statusText(c.subject_kind, c.subject.status) })}
            </span>
          )}
          {linkAllowed && (
            <Btn size="xs" icon="ext" label={t(link!.page === "leagues" ? "mod.openDuel" : "mod.openRoom")} onClick={() => navigate(link!.page, link!.id)} testId="mc-subject-open" />
          )}
        </dd>
        <dt>{t("mod.nickAtReport")}</dt>
        <dd lang="ru" data-testid="mc-nick-at">
          {c.subject.nickname_at_report ?? <span className="muted">—</span>}
          {c.target_nickname !== c.subject.nickname_at_report && <span className="xs muted block">{t("mod.nickNow", { n: c.target_nickname ?? t("fr.noNick") })}</span>}
        </dd>
        <dt>{t("mod.comment")}</dt>
        <dd lang="ru" className="wrap-any" data-testid="mc-comment">
          {c.comment ?? <span className="muted">{t("mod.noComment")}</span>}
        </dd>
        <dt>{t("mod.col.target")}</dt>
        <dd>
          <UserRef id={c.target_user_id} testId="mc-target" />
        </dd>
        <dt>{t("mod.reporter")}</dt>
        <dd>
          <UserRef id={c.reporter_user_id} testId="mc-reporter" />
        </dd>
        <dt>{t("mod.col.30d")}</dt>
        <dd data-testid="mc-30d">
          {c.target_complaints_30d >= HOT_COMPLAINTS ? <Pill tone="warn">{t("mod.hot", { n: fmt.num(c.target_complaints_30d) })}</Pill> : fmt.num(c.target_complaints_30d)}
        </dd>
      </dl>
    </section>
  );
}

function ResolveForm({ c, onDone, onUnknown }: { c: AdminCase; onDone: (x: AdminCase) => void; onUnknown: () => void }) {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const fail = useCmdFail();
  const issueText = useSocIssue();
  const [f, setF] = useState<ResolveForm>(emptyResolve);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(() => new CommandKey(uuid));
  const chk = resolveBody(f);
  const at = (p: string): Issue | null => (tried ? (chk.issues.find((x) => x.path === p) ?? null) : null);
  const stepUp = resolveNeedsStepUp(f);
  const days = Number(f.days.trim());
  const daysOk = f.action === "social_ban" && f.term === "days" && Number.isInteger(days) && days >= BAN_DAYS_MIN && days <= BAN_DAYS_MAX;
  const set = (p: Partial<ResolveForm>) => (setF((x) => ({ ...x, ...p })), setErr(null));
  const okLabel = f.action === "social_ban" ? (f.term === "forever" ? t("mod.do.banForever") : daysOk ? t("mod.do.banDays", { n: days }) : t("mact7.social_ban")) : t(`mod.do.${f.action}` as MessageKey);
  const submit = async () => {
    if (busy) return;
    setTried(true);
    if (!chk.body) return;
    setBusy(true);
    setErr(null);
    const k = key.for(JSON.stringify(["resolve", c.case_id, chk.body]));
    try {
      const x = await Moderation.resolve(c.case_id, chk.body, k);
      key.settle();
      toast(t("mod.resolved", { a: t(`mact7.${chk.body.action}` as MessageKey) }), "ok", "moderation.case_resolved");
      onDone(x);
    } catch (e) {
      key.settle(e);
      // decided in another tab: say so and show the case as it is now (the form goes away)
      if (e instanceof ApiError && e.code === "CASE_STATE") {
        toast(fail(e), "err", "409 CASE_STATE");
        onUnknown();
        return;
      }
      setErr(fail(e, onUnknown));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack sm soc-decision" aria-labelledby="mc-dec-h" data-testid="mc-resolve">
      <h3 className="h3" id="mc-dec-h">
        {t("mod.decide")}
      </h3>
      <fieldset className="fs soc-choices" data-testid="mc-action">
        <legend className="field-label">{t("mod.action")}</legend>
        {MOD_ACTIONS.map((a) => (
          <label key={a} className={cx("soc-choice", f.action === a && "is-on")}>
            <input type="radio" name="mc-action" value={a} checked={f.action === a} onChange={() => set({ action: a as ModerationAction })} data-testid={`mc-action-${a}`} />
            <span>
              <b>{t(`mact7.${a}` as MessageKey)}</b>
              <span className="xs muted block">{t(`mact7.${a}.h` as MessageKey)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {f.action === "social_ban" && (
        <fieldset className="fs" data-testid="mc-term">
          <legend className="field-label">{t("mod.term")}</legend>
          <div className="row soc-term">
            <label className="check">
              <input type="radio" name="mc-term" checked={f.term === "days"} onChange={() => set({ term: "days" })} data-testid="mc-term-days" />
              {t("mod.termDays")}
            </label>
            <input
              id="mc-days"
              className={cx("input num-in soc-days", !!at("days") && "is-invalid")}
              inputMode="numeric"
              aria-label={t("mod.daysAria", { a: BAN_DAYS_MIN, b: BAN_DAYS_MAX })}
              value={f.days}
              disabled={f.term !== "days"}
              aria-invalid={!!at("days") || undefined}
              aria-describedby="mc-days-h"
              onChange={(e) => set({ days: e.target.value })}
              data-testid="mc-days"
            />
            <label className="check">
              <input type="radio" name="mc-term" checked={f.term === "forever"} onChange={() => set({ term: "forever" })} data-testid="mc-term-forever" />
              {t("soc.forever")}
            </label>
          </div>
          <span className="hint" id="mc-days-h" data-testid="mc-until">
            {f.term === "forever" ? t("mod.untilForever") : daysOk ? t("mod.untilPreview", { t: fmt.dateTime(banUntil(days)) }) : t("mod.daysHint", { a: BAN_DAYS_MIN, b: BAN_DAYS_MAX })}
          </span>
          <FieldErr msg={issueText(at("days"))} />
        </fieldset>
      )}
      {f.action === "nickname_reset" && (
        <Callout icon="info" testId="mc-nick-note">
          {t("mod.nickResetNote", { n: c.target_nickname ?? "—" })}
        </Callout>
      )}
      <NoteField id="mc-basis" label={t("soc.col.basis")} value={f.basis} onChange={(v) => set({ basis: v })} error={issueText(at("basis"))} hint={t("mod.basisHint")} placeholder={t("mod.basisPh")} testId="mc-basis" />
      {stepUp && <StepUpNote testId="mc-stepup" text={t("mod.stepUpNote", { n: STEP_UP_DAYS })} />}
      <FieldErr msg={err} />
      <div className="acts">
        <Btn kind={f.action === "social_ban" ? "danger" : "primary"} icon={f.action === "dismiss" ? "x" : f.action === "social_ban" ? "ban" : "check"} label={okLabel} busy={busy} onClick={() => void submit()} testId="mc-submit" />
      </div>
      <p className="xs muted row">
        <Icon name="audit" /> {t("mod.auditNote")}
      </p>
    </section>
  );
}

/* ---------------------------------------------------------------- sanctions */

function SanctionsTab() {
  const { t } = useI18n();
  const [uid, setUid] = useState("");
  const [active, setActive] = useState<"" | "true" | "false">("true");
  const [rows, setRows] = useState<AdminSanction[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revoke, setRevoke] = useState<AdminSanction | null>(null);
  const req = useRef(0);
  const uidBad = uid.trim() !== "" && !isUuid(uid);
  const load = useCallback(
    async (more?: string | null) => {
      if (uidBad) return;
      const id = ++req.current;
      try {
        const r = await Moderation.sanctions({ user_id: uid.trim().toLowerCase() || undefined, active: active === "" ? null : active === "true", cursor: more ?? null });
        if (id !== req.current) return;
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError(null);
      } catch (e) {
        if (id === req.current) setError(e);
      }
    },
    [uid, active, uidBad],
  );
  useEffect(() => {
    const tm = setTimeout(() => void load(), uid ? 300 : 0);
    return () => clearTimeout(tm);
  }, [load, uid]);
  return (
    <section className="panel" aria-labelledby="ms-h" data-testid="mod-sanctions">
      <div className="panel-h">
        <h2 className="panel-t grow" id="ms-h">
          <Icon name="ban" /> {t("soc.sanctions")}
        </h2>
      </div>
      <div className="panel-b qa-filters" role="group" aria-label={t("soc.filters")}>
        <div className="field soc-uid">
          <label htmlFor="ms-uid">{t("mem.uid")}</label>
          <input id="ms-uid" className={cx("input mono", uidBad && "is-invalid")} value={uid} spellCheck={false} autoComplete="off" aria-invalid={uidBad || undefined} aria-describedby={uidBad ? "ms-uid-e" : undefined} onChange={(e) => setUid(e.target.value)} data-testid="ms-uid" />
          <FieldErr msg={uidBad ? t("mem.lookupErr") : null} id="ms-uid-e" />
        </div>
        <div className="field">
          <label htmlFor="ms-active">{t("col.status")}</label>
          <Select<"" | "true" | "false"> id="ms-active" label={t("col.status")} value={active} onChange={setActive} options={[{ v: "", label: t("common.all") }, { v: "true", label: t("ms.active") }, { v: "false", label: t("ms.inactive") }]} testId="ms-active" />
        </div>
      </div>
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="panel-b">
          <SanctionsTable items={rows} showUser onRevoke={setRevoke} testId="ms-rows" empty={t("ms.none")} />
        </div>
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} testId="ms-more" />
        </div>
      )}
      {revoke && (
        <RevokeDialog
          sanction={revoke}
          onClose={() => setRevoke(null)}
          onDone={() => {
            setRevoke(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- appeals */

function AppealsTab() {
  const { t, fmt } = useI18n();
  const term = useTerm();
  const [status, setStatus] = useState<SanctionAppealStatus>("open");
  const [rows, setRows] = useState<AdminSanctionAppeal[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<AdminSanctionAppeal | null>(null);
  const req = useRef(0);
  const load = useCallback(
    async (more?: string | null) => {
      const id = ++req.current;
      try {
        const r = await Moderation.appeals(status, more ?? null);
        if (id !== req.current) return;
        setRows((xs) => (more && xs ? [...xs, ...r.items] : r.items));
        setCursor(r.next_cursor);
        setError(null);
      } catch (e) {
        if (id === req.current) setError(e);
      }
    },
    [status],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="panel" aria-labelledby="ma-h" data-testid="mod-appeals">
      <div className="panel-h">
        <h2 className="panel-t grow" id="ma-h">
          <Icon name="escalate" /> {t("mod.appeals")}
        </h2>
        <Seg<SanctionAppealStatus> label={t("col.status")} value={status} onChange={(v) => (setRows(null), setStatus(v))} items={APPEAL_STATUSES.map((v) => ({ v, label: t(`aps7.${v}` as MessageKey) }))} testId="ma-status" />
      </div>
      {error && !rows ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !rows ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="tbl compact soc-tbl" data-testid="ma-rows">
            <caption className="sr-only">{t("mod.appeals")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("col.created")}</th>
                <th scope="col">{t("soc.col.learner")}</th>
                <th scope="col">{t("soc.col.sanction")}</th>
                <th scope="col">{t("map.text")}</th>
                <th scope="col">{t("col.status")}</th>
                <th scope="col" className="r">
                  {t("ct.col.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.appeal_id} data-testid={`ma-${a.appeal_id}`} data-status={a.status}>
                  <td className="small nowrap">{fmt.dateTime(a.created_at)}</td>
                  <td>
                    <UserRef id={a.sanction.user_id} />
                  </td>
                  <td className="small">
                    {t(`sk7.${a.sanction.kind}` as MessageKey)}
                    <span className="xs muted block">{term(a.sanction)}</span>
                  </td>
                  <td className="small wrap-any soc-clip" lang="ru">
                    {a.text}
                  </td>
                  <td>
                    <Pill tone={APPEAL_TONE[a.status]}>{t(`aps7.${a.status}` as MessageKey)}</Pill>
                  </td>
                  <td className="actions-cell">
                    <Btn size="xs" kind={a.status === "open" ? "primary" : ""} icon={a.status === "open" ? "check" : "eye"} label={a.status === "open" ? t("map.review") : t("map.view")} onClick={() => setOpen(a)} testId={`ma-open-${a.appeal_id}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="escalate" title={t(status === "open" ? "map.noOpen" : "map.none")} testId="ma-empty" />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} testId="ma-more" />
        </div>
      )}
      {open && (
        <AppealDrawer
          a={open}
          onClose={() => setOpen(null)}
          onDone={(x) => {
            setOpen(x);
            void load();
          }}
          onUnknown={() => void load()}
        />
      )}
    </section>
  );
}

function AppealDrawer({ a, onClose, onDone, onUnknown }: { a: AdminSanctionAppeal; onClose: () => void; onDone: (x: AdminSanctionAppeal) => void; onUnknown: () => void }) {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const fail = useCmdFail();
  const issueText = useSocIssue();
  const term = useTerm();
  const [decision, setDecision] = useState<SanctionAppealDecision["decision"] | null>(null);
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(() => new CommandKey(uuid));
  const chk = appealBody(decision, note);
  const at = (p: string) => (tried ? (chk.issues.find((x) => x.path === p) ?? null) : null);
  const s = a.sanction;
  const submit = async () => {
    if (busy) return;
    setTried(true);
    if (!chk.body) return;
    setBusy(true);
    setErr(null);
    const k = key.for(JSON.stringify(["appeal", a.appeal_id, chk.body]));
    try {
      const x = await Moderation.decideAppeal(a.appeal_id, chk.body, k);
      key.settle();
      toast(t(chk.body.decision === "overturned" ? "map.overturned" : "map.upheld"), "ok", "moderation.appeal_decided");
      onDone(x);
    } catch (e) {
      key.settle(e);
      setErr(fail(e, onUnknown));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      wide
      testId="ma-appeal"
      onClose={onClose}
      title={t("map.appealT", { k: t(`sk7.${s.kind}` as MessageKey) })}
      sub={
        <>
          <Pill tone={APPEAL_TONE[a.status]}>{t(`aps7.${a.status}` as MessageKey)}</Pill>
          <span>{fmt.dateTime(a.created_at)}</span>
        </>
      }
    >
      <div className="stack" data-testid="ma-appeal-body" data-status={a.status}>
        <section className="card stack sm" aria-labelledby="ma-s-h">
          <h3 className="h3" id="ma-s-h">
            {t("map.sanction")}
          </h3>
          <dl className="dl">
            <dt>{t("soc.col.learner")}</dt>
            <dd>
              <UserRef id={s.user_id} />
            </dd>
            <dt>{t("soc.col.sanction")}</dt>
            <dd>
              {t(`sk7.${s.kind}` as MessageKey)} <SanctionPill s={s} />
            </dd>
            <dt>{t("soc.col.term")}</dt>
            <dd>{term(s)}</dd>
            <dt>{t("soc.col.basis")}</dt>
            <dd lang="ru" className="wrap-any">
              {s.basis}
            </dd>
            <dt>{t("soc.col.decided")}</dt>
            <dd>
              {staffName(s.decided_by, t("soc.system"))} · {fmt.dateTime(s.decided_at)}
            </dd>
          </dl>
        </section>
        <section className="card stack sm" aria-labelledby="ma-t-h">
          <h3 className="h3" id="ma-t-h">
            {t("map.text")}
          </h3>
          <p className="wrap-any soc-quote" lang="ru" data-testid="ma-text">
            {a.text}
          </p>
        </section>
        {a.status === "open" ? (
          <section className="card stack sm soc-decision" aria-labelledby="ma-d-h" data-testid="ma-decide">
            <h3 className="h3" id="ma-d-h">
              {t("mod.decision")}
            </h3>
            <fieldset className="fs soc-choices">
              <legend className="field-label">{t("map.decision")}</legend>
              {(["upheld", "overturned"] as const).map((d) => (
                <label key={d} className={cx("soc-choice", decision === d && "is-on")}>
                  <input type="radio" name="ma-decision" checked={decision === d} onChange={() => (setDecision(d), setErr(null))} data-testid={`ma-d-${d}`} />
                  <span>
                    <b>{t(`map.d.${d}` as MessageKey)}</b>
                    <span className="xs muted block">{t(`map.d.${d}.h` as MessageKey)}</span>
                  </span>
                </label>
              ))}
              <FieldErr msg={issueText(at("decision")) && t("map.pick")} />
            </fieldset>
            <NoteField id="ma-note" label={t("map.note")} value={note} onChange={(v) => (setNote(v), setErr(null))} error={issueText(at("note"))} hint={t("map.noteHint")} testId="ma-note" />
            <FieldErr msg={err} />
            <div className="acts">
              <Btn kind="primary" icon="check" label={t("map.decide")} busy={busy} onClick={() => void submit()} testId="ma-submit" />
            </div>
          </section>
        ) : (
          <section className="card stack sm soc-decision" data-testid="ma-decided">
            <h3 className="h3">{t("mod.decision")}</h3>
            <dl className="dl">
              <dt>{t("map.decision")}</dt>
              <dd>
                <b>{t(a.status === "overturned" ? "map.d.overturned" : "map.d.upheld")}</b>
              </dd>
              <dt>{t("map.note")}</dt>
              <dd lang="ru" className="wrap-any">
                {a.decision_note ?? "—"}
              </dd>
              <dt>{t("mod.by")}</dt>
              <dd>
                {staffName(a.decided_by, t("soc.system"))} · {fmt.dateTime(a.decided_at)}
              </dd>
            </dl>
          </section>
        )}
      </div>
    </Drawer>
  );
}
