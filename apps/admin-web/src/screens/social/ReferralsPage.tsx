/**
 * «Реферальные кампании» (sprint 7, ADM-REF-01/02, AT-78, AT-80; referral.read, commands — referral.manage):
 * - «Проверка» — the queue of referrals held for an operator (review — the oldest first): the facts (dates, the number
 *   of lessons, days, minutes, the lessons log without content), the internal risk_flags, the inviter's month against
 *   the cap; approve with a note or reject with a public code and a note (10..500); a rejection can be re-decided once,
 *   the previous decision stays in the history;
 * - «Кампании» — versions: the active one (immutable), one draft (the qualification threshold, rewards, the monthly
 *   cap, the review thresholds — the learner never sees those), the server check, activation with step-up and a
 *   comment, the history with the difference to the active version (referrals stay on the version they came with);
 * - «Статистика» — per campaign version.
 * Routes: #/referrals[/review[/<referral_id>]] · #/referrals/campaigns[/<version>] · #/referrals/stats.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AdminReferral, AdminReferralRow, ReferralCampaignStats, ReferralCampaignSummary, ReferralCampaignVersion, ReferralRejectRequest, RulesValidation } from "@tilhero/contracts/admin";
import type { ReferralRewardOutcome, ReferralStatus } from "@tilhero/contracts/bff";
import { Referrals } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Reveal, Select, Spinner, TabPanel, Tabs } from "../../ui/kit";
import { ConfirmCommand, Drawer, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { diffValues, showValue } from "../game/model";
import { CommandKey, outcomeUnknown } from "../memory/model";
import { errMeta } from "../../ui/errors";
import {
  CAMPAIGN_LIMITS,
  CAMPAIGN_TONE,
  campaignForm,
  campaignGate,
  campaignIssues,
  campaignValue,
  canApprove,
  canReject,
  checkCampaign,
  isRedecision,
  MANUAL_REJECT_CODES,
  monthFull,
  parseRefRoute,
  REASON_MAX,
  REASON_MIN,
  reasonProblem,
  REF_TABS,
  REFERRAL_TONE,
  REWARD_OUTCOME_TONE,
  rejectBody,
  RISK_FLAGS,
  setCampaignValue,
  type CampaignForm,
  type Issue,
  type RefTab,
} from "./model";
import { NoteField, PrivacyNote, StepUpNote, useCmdFail, useSocIssue, UserRef } from "./parts";

export function ReferralsPage({ routeId }: { routeId: string | null }) {
  const { t } = useI18n();
  const { navigate } = useNav();
  const r = parseRefRoute(routeId);
  return (
    <div className="stack" data-testid="referrals">
      <Tabs<RefTab> id="ref" label={t("ref.tabs")} value={r.tab} onChange={(v) => navigate("referrals", v)} items={REF_TABS.map((v) => ({ v, label: t(`ref.tab.${v}` as MessageKey), icon: v === "review" ? "scan" : v === "campaigns" ? "sliders" : "activity", testId: `ref-tab-${v}` }))} />
      <TabPanel id="ref" value={r.tab}>
        {r.tab === "review" ? <ReviewTab openId={r.id} /> : r.tab === "campaigns" ? <CampaignsTab openVersion={r.id ? Number(r.id) : null} /> : <StatsTab />}
      </TabPanel>
    </div>
  );
}

/* ---------------------------------------------------------------- the review queue */

type Filter = ReferralStatus | "";
const QUEUE_FILTERS: readonly Filter[] = ["review", "rejected", "qualified", "rewarded", "capped", ""];

function ReviewTab({ openId }: { openId: string | null }) {
  const { t, fmt } = useI18n();
  const { navigate } = useNav();
  const [status, setStatus] = useState<Filter>("review");
  const [rows, setRows] = useState<AdminReferralRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const req = useRef(0);
  const load = useCallback(
    async (more?: string | null) => {
      const id = ++req.current;
      try {
        const r = await Referrals.list(status, more ?? null);
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
    <section className="panel" aria-labelledby="rq-h" data-testid="ref-queue">
      <div className="panel-h">
        <h2 className="panel-t grow" id="rq-h">
          <Icon name="scan" /> {t("rfq.title")}
        </h2>
        <div className="field soc-inline">
          <label htmlFor="rq-status" className="sr-only">
            {t("col.status")}
          </label>
          <Select<Filter> id="rq-status" label={t("col.status")} value={status} onChange={(v) => (setRows(null), setStatus(v))} options={QUEUE_FILTERS.map((v) => ({ v, label: v ? t(`rfs.${v}` as MessageKey) : t("rfq.allStatuses") }))} testId="rq-status" />
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
          <table className="tbl compact soc-tbl" data-testid="rq-rows">
            <caption className="sr-only">{t("rfq.title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("rfq.col.accepted")}</th>
                <th scope="col">{t("rfq.col.inviter")}</th>
                <th scope="col">{t("rfq.col.invitee")}</th>
                <th scope="col" className="r">
                  {t("rfq.col.facts")}
                </th>
                <th scope="col">{t("rfq.col.flags")}</th>
                <th scope="col">{t("col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.referral_id} className={cx(openId === r.referral_id && "is-selected")} data-testid={`rq-${r.referral_id}`} data-status={r.status}>
                  <td className="small nowrap">
                    <button type="button" className="tr" onClick={() => navigate("referrals", `review/${r.referral_id}`)} data-testid={`rq-open-${r.referral_id}`}>
                      {fmt.date(r.accepted_at)}
                    </button>
                    <span className="xs muted block">{t("rfq.campaignV", { v: r.campaign_version })}</span>
                  </td>
                  <td>
                    <UserRef id={r.inviter_user_id} />
                  </td>
                  <td>
                    <UserRef id={r.invitee_user_id} />
                  </td>
                  <td className="r small nowrap">{t("rfq.factsV", { l: r.lessons, d: r.days, m: fmt.num(r.minutes_total) })}</td>
                  <td>
                    <RiskFlags flags={r.risk_flags} />
                  </td>
                  <td>
                    <Pill tone={REFERRAL_TONE[r.status]}>{t(`rfs.${r.status}` as MessageKey)}</Pill>
                    {r.reject_code && <span className="xs muted block">{t(`rjc.${r.reject_code}` as MessageKey)}</span>}
                    <RewardOutcome outcome={r.reward_outcome} testId={`rq-outcome-${r.referral_id}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="scan" title={t(status === "review" ? "rfq.noReview" : "rfq.none")} testId="rq-empty" />
      )}
      {cursor && (
        <div className="more-row">
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} testId="rq-more" />
        </div>
      )}
      <div className="panel-f xs">
        <Icon name="lock" /> {t("rfq.note")}
      </div>
      {openId && <ReferralDrawer key={openId} id={openId} onClose={() => navigate("referrals", "review")} onChanged={() => setTick((n) => n + 1)} />}
    </section>
  );
}

/** the outcome of the reward as a badge; null — nothing */
function RewardOutcome({ outcome, testId }: { outcome: ReferralRewardOutcome | null; testId?: string }) {
  const { t } = useI18n();
  if (!outcome) return null;
  return (
    <span className="block soc-outcome">
      <Pill tone={REWARD_OUTCOME_TONE[outcome]} title={t(`rro.${outcome}.h` as MessageKey)} testId={testId}>
        {t(`rro.${outcome}` as MessageKey)}
      </Pill>
    </span>
  );
}

function RiskFlags({ flags, long }: { flags: readonly string[]; long?: boolean }) {
  const { t } = useI18n();
  if (!flags.length) return <span className="xs muted">{t("rfq.noFlags")}</span>;
  if (long)
    return (
      <ul className="plain-list soc-flags" data-testid="rr-flags">
        {RISK_FLAGS.filter((f) => flags.includes(f)).map((f) => (
          <li key={f} data-flag={f}>
            <b>{t(`rflag.${f}` as MessageKey)}</b> — {t(`rflag.${f}.h` as MessageKey)}
          </li>
        ))}
      </ul>
    );
  return (
    <span className="row xs-gap">
      {flags.map((f) => (
        <span key={f} className="tag plain warn-tag" title={t(`rflag.${f}.h` as MessageKey)}>
          {t(`rflag.${f}` as MessageKey)}
        </span>
      ))}
    </span>
  );
}

type RefCmd = { kind: "approve" } | { kind: "reject" };

function ReferralDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const fail = useCmdFail();
  const [r, setR] = useState<AdminReferral | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cmd, setCmd] = useState<RefCmd | null>(null);
  const [key] = useState(() => new CommandKey(uuid));
  const manage = can("referral.manage");
  const load = useCallback(() => {
    Referrals.get(id)
      .then((x) => (setR(x), setError(null)))
      .catch(setError);
  }, [id]);
  useEffect(load, [load]);
  return (
    <Drawer
      wide
      testId="rr"
      onClose={onClose}
      title={t("rr.title", { id: shortId(id, 8, 4) })}
      sub={
        r && (
          <>
            <Pill tone={REFERRAL_TONE[r.status]}>{t(`rfs.${r.status}` as MessageKey)}</Pill>
            <span>{t("rfq.campaignV", { v: r.campaign_version })}</span>
          </>
        )
      }
      footer={
        r && manage && (canApprove(r) || canReject(r)) ? (
          <>
            {isRedecision(r) && <span className="xs muted grow" data-testid="rr-redecide-note">{t("rr.redecideNote")}</span>}
            {canReject(r) && <Btn kind="danger-ghost" icon="x" label={t("rr.reject")} onClick={() => setCmd({ kind: "reject" })} testId="rr-reject" />}
            {canApprove(r) && <Btn kind="primary" icon="check" label={isRedecision(r) ? t("rr.redecide") : t("rr.approve")} onClick={() => setCmd({ kind: "approve" })} testId="rr-approve" />}
          </>
        ) : r && !manage && (canApprove(r) || canReject(r)) ? (
          <span className="xs muted row" data-testid="rr-ro">
            <Icon name="lock" /> {t("perm.need", { p: "referral.manage" })}
          </span>
        ) : undefined
      }
    >
      {error && !r ? (
        <LoadError error={error} onRetry={load} />
      ) : !r ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="stack" data-testid="rr-body" data-status={r.status}>
          <section className="card stack sm" aria-labelledby="rr-f-h" data-testid="rr-facts">
            <h3 className="h3" id="rr-f-h">
              {t("rr.facts")}
            </h3>
            <dl className="dl">
              <dt>{t("rfq.col.inviter")}</dt>
              <dd>
                <UserRef id={r.inviter_user_id} testId="rr-inviter" />
              </dd>
              <dt>{t("rfq.col.invitee")}</dt>
              <dd>
                <UserRef id={r.invitee_user_id} testId="rr-invitee" />
              </dd>
              <dt>{t("rfq.col.accepted")}</dt>
              <dd>{fmt.dateTime(r.accepted_at)}</dd>
              <dt>{t("rr.diagnostic")}</dt>
              <dd>{r.diagnostic_at ? fmt.dateTime(r.diagnostic_at) : <span className="muted">{t("rr.noDiagnostic")}</span>}</dd>
              <dt>{t("rfq.col.facts")}</dt>
              <dd data-testid="rr-counts">{t("rr.counts", { l: r.lessons, d: r.days, m: fmt.num(r.minutes_total) })}</dd>
              <dt>{t("rr.month")}</dt>
              <dd data-testid="rr-month">
                {t("rr.monthV", { q: r.inviter_month.qualified, c: r.inviter_month.cap })}
                {monthFull(r.inviter_month) && <span className="xs warn-ink block">{t("rr.monthFull")}</span>}
              </dd>
              {r.reward_outcome && (
                <>
                  <dt>{t("rro.label")}</dt>
                  <dd data-testid="rr-outcome" data-outcome={r.reward_outcome}>
                    <Pill tone={REWARD_OUTCOME_TONE[r.reward_outcome]}>{t(`rro.${r.reward_outcome}` as MessageKey)}</Pill>
                    <span className="xs muted block">{t(`rro.${r.reward_outcome}.h` as MessageKey)}</span>
                  </dd>
                </>
              )}
              {r.qualified_at && (
                <>
                  <dt>{t("rr.qualified")}</dt>
                  <dd>{fmt.dateTime(r.qualified_at)}</dd>
                </>
              )}
              {r.reject_code && (
                <>
                  <dt>{t("rr.rejectCode")}</dt>
                  <dd>
                    {t(`rjc.${r.reject_code}` as MessageKey)} <span className="mono xs muted">{r.reject_code}</span>
                  </dd>
                </>
              )}
            </dl>
          </section>
          <section className="card stack sm" aria-labelledby="rr-r-h">
            <h3 className="h3" id="rr-r-h">
              {t("rr.flags")}
            </h3>
            <RiskFlags flags={r.risk_flags} long />
            <p className="xs muted row">
              <Icon name="lock" /> {t("rr.flagsNote")}
            </p>
          </section>
          <section className="card stack sm" aria-labelledby="rr-l-h" data-testid="rr-lessons">
            <h3 className="h3" id="rr-l-h">
              {t("rr.lessons", { n: r.lessons_log.length })}
            </h3>
            {r.lessons_log.length ? (
              <table className="tbl dense">
                <caption className="sr-only">{t("rr.lessons", { n: r.lessons_log.length })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("rr.col.day")}</th>
                    <th scope="col" className="r">
                      {t("rr.col.minutes")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.lessons_log.map((l, i) => (
                    <tr key={`${l.local_date}-${i}`}>
                      <td className="small">{l.local_date}</td>
                      <td className="r num">{fmt.num(l.minutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="small muted">{t("rr.noLessons")}</p>
            )}
            <p className="xs muted">{t("rr.lessonsNote")}</p>
          </section>
          <section className="card stack sm" aria-labelledby="rr-h-h" data-testid="rr-history">
            <h3 className="h3" id="rr-h-h">
              {t("rr.history", { n: r.decision_history.length })}
            </h3>
            {r.decision_history.length ? (
              <ol className="soc-timeline">
                {r.decision_history.map((d, i) => (
                  <li key={`${d.at}-${i}`} data-decision={d.decision}>
                    <span className="row xs-gap">
                      <Pill tone={d.decision === "approved" ? "good" : "bad"}>{t(`rr.d.${d.decision}` as MessageKey)}</Pill>
                      {d.reject_code && <span className="small">{t(`rjc.${d.reject_code}` as MessageKey)}</span>}
                      <span className="xs muted">
                        {d.by.name} · {fmt.dateTime(d.at)}
                      </span>
                    </span>
                    <span className="small block wrap-any" lang="ru">
                      {d.note}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="small muted">{t("rr.noHistory")}</p>
            )}
            {r.status === "rejected" && !r.can_redecide && <p className="xs muted" data-testid="rr-final">{t("rr.final")}</p>}
          </section>
          <PrivacyNote text={t("rr.privacy")} />
        </div>
      )}
      {cmd && r && dialog(r)}
    </Drawer>
  );

  function dialog(ref: AdminReferral): ReactNode {
    const close = () => setCmd(null);
    const done = (x: AdminReferral, msg: string) => {
      setR(x);
      onChanged();
      toast(msg, "ok", "referral.decided");
    };
    if (cmd!.kind === "approve")
      return (
        <ConfirmCommand
          title={isRedecision(ref) ? t("rr.redecideT") : t("rr.approveT")}
          text={monthFull(ref.inviter_month) ? t("rr.approveCapped") : t("rr.approveM")}
          icon="check"
          ok={isRedecision(ref) ? t("rr.redecide") : t("rr.approve")}
          minReason={REASON_MIN}
          maxReason={REASON_MAX}
          reasonLabel={t("rr.note")}
          reasonPlaceholder={t("rr.notePh")}
          testId="rr-approve-dialog"
          extra={isRedecision(ref) ? <Callout kind="warn" icon="alert">{t("rr.redecideNote")}</Callout> : undefined}
          onClose={close}
          onConfirm={async (note) => {
            const k = key.for(JSON.stringify(["approve", ref.referral_id, note]));
            try {
              const x = await Referrals.approve(ref.referral_id, note, k);
              key.settle();
              done(x, t(x.status === "capped" ? "rr.approvedCapped" : "rr.approved"));
              return null;
            } catch (e) {
              key.settle(e);
              if (e instanceof ApiError && e.code === "REFERRAL_STATE") load();
              return fail(e, load);
            }
          }}
        />
      );
    return <RejectDialog r={ref} onClose={close} onDone={(x) => done(x, t("rr.rejected"))} onUnknown={load} />;
  }
}

function RejectDialog({ r, onClose, onDone, onUnknown }: { r: AdminReferral; onClose: () => void; onDone: (x: AdminReferral) => void; onUnknown: () => void }) {
  const { t } = useI18n();
  const fail = useCmdFail();
  const issueText = useSocIssue();
  const [code, setCode] = useState<ReferralRejectRequest["reject_code"] | "">("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(() => new CommandKey(uuid));
  const chk = rejectBody(code, note);
  const at = (p: string): Issue | null => (tried ? (chk.issues.find((x) => x.path === p) ?? null) : null);
  const submit = async () => {
    if (busy) return;
    setTried(true);
    if (!chk.body) return;
    setBusy(true);
    setErr(null);
    const k = key.for(JSON.stringify(["reject", r.referral_id, chk.body]));
    try {
      const x = await Referrals.reject(r.referral_id, chk.body, k);
      key.settle();
      onDone(x);
      onClose();
    } catch (e) {
      key.settle(e);
      setErr(fail(e, onUnknown));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("rr.rejectT")}
      text={t("rr.rejectM")}
      icon="x"
      tone="bad"
      onClose={() => !busy && onClose()}
      testId="rr-reject-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn label={t("rr.reject")} kind="danger" busy={busy} onClick={() => void submit()} testId="rr-reject-ok" />
        </>
      }
    >
      <div className="field">
        <label htmlFor="rr-code" className="req">
          {t("rr.rejectCode")}
        </label>
        <Select<ReferralRejectRequest["reject_code"] | ""> id="rr-code" label={t("rr.rejectCode")} value={code} onChange={(v) => (setCode(v), setErr(null))} options={[{ v: "", label: t("rr.pickCode") }, ...MANUAL_REJECT_CODES.map((c) => ({ v: c, label: t(`rjc.${c}` as MessageKey) }))]} testId="rr-code" />
        {code && <span className="hint">{t("rr.codeHint", { c: t(`rjc.${code}.learner` as MessageKey) })}</span>}
        <FieldErr msg={at("reject_code") ? t("rr.pickCode") : null} />
      </div>
      <NoteField id="rr-note" label={t("rr.note")} value={note} onChange={(v) => (setNote(v), setErr(null))} error={issueText(at("note"))} hint={t("rr.noteHint")} placeholder={t("rr.notePh")} testId="rr-note" />
      <FieldErr msg={err} />
      <p className="xs muted row">
        <Icon name="audit" /> {t("cmd.auditNote")}
      </p>
    </Modal>
  );
}

/* ---------------------------------------------------------------- campaigns */

type CCmd = { kind: "activate" } | { kind: "delete" };
const SECTIONS: ReadonlyArray<{ id: string; fields: readonly string[] }> = [
  { id: "qualify", fields: ["min_lessons", "min_days", "window_days"] },
  { id: "rewards", fields: ["inviter_reward.freeze", "inviter_reward.til", "invitee_reward.freeze", "invitee_reward.til"] },
  { id: "limits", fields: ["monthly_cap"] },
  { id: "review", fields: ["review.velocity_per_day", "review.min_lesson_minutes"] },
];
const fid = (path: string) => `rcf-${path.replace(/\./g, "-")}`;

function CampaignsTab({ openVersion }: { openVersion: number | null }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const toast = useToast();
  const fail = useCmdFail();
  const manage = can("referral.manage");
  const [versions, setVersions] = useState<ReferralCampaignSummary[] | null>(null);
  const [active, setActive] = useState<ReferralCampaignVersion | null>(null);
  const [draft, setDraft] = useState<ReferralCampaignVersion | null>(null);
  const [form, setForm] = useState<CampaignForm | null>(null);
  const [base, setBase] = useState<CampaignForm | null>(null);
  const [comment, setComment] = useState("");
  const [baseComment, setBaseComment] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [server, setServer] = useState<(RulesValidation & { at: string }) | null>(null);
  const [cmd, setCmd] = useState<CCmd | null>(null);
  const [actKey] = useState(() => new CommandKey(uuid));
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const applyDraft = useCallback((d: ReferralCampaignVersion | null) => {
    setDraft(d);
    const f = d ? campaignForm(d.payload) : null;
    setForm(f);
    setBase(f);
    setComment(d?.comment ?? "");
    setBaseComment(d?.comment ?? "");
    setConflict(false);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await Referrals.campaigns();
      if (!alive.current) return;
      setVersions(r.items);
      const a = r.items.find((v) => v.status === "active");
      const d = r.items.find((v) => v.status === "draft");
      const [av, dv] = await Promise.all([a ? Referrals.campaign(a.version) : Promise.resolve(null), d ? Referrals.campaign(d.version) : Promise.resolve(null)]);
      if (!alive.current) return;
      setActive(av);
      applyDraft(dv);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e);
    }
  }, [applyDraft]);
  useEffect(() => {
    void load();
  }, [load]);

  const editable = !!draft && manage;
  const shown = form ?? (active ? campaignForm(active.payload) : null);
  const checked = useMemo(() => (shown ? checkCampaign(shown) : null), [shown]);
  const dirty = !!form && !!base && (JSON.stringify(form) !== JSON.stringify(base) || comment !== baseComment);
  const serverFresh = server && draft && server.at === draft.updated_at && !dirty ? server : null;
  const errors = useMemo(() => [...(checked?.errors ?? []), ...campaignIssues(serverFresh?.errors).filter((x) => !(checked?.errors ?? []).some((y) => y.path === x.path))], [checked, serverFresh]);
  const warnings = useMemo(() => [...(checked?.warnings ?? []), ...campaignIssues(serverFresh?.warnings)], [checked, serverFresh]);
  const gate = campaignGate(draft, dirty, checked?.errors.length ?? 0, serverFresh ? { ok: serverFresh.ok, at: serverFresh.at } : null);
  const diff = useMemo(() => (active && checked && draft ? diffValues(active.payload, checked.payload) : []), [active, checked, draft]);

  /** onUnknown — what to re-read when the answer was lost (the activation: the whole screen, F7-18) */
  const failed = (e: unknown, onUnknown?: () => void): string => {
    if (e instanceof ApiError) {
      if (e.code === "DRAFT_CONFLICT") setConflict(true);
      if (e.code === "CAMPAIGN_INVALID" && draft) {
        const xs = campaignIssues(e.details.errors);
        setServer({ ok: false, errors: xs, warnings: [], at: draft.updated_at });
        return t("rcp.invalidN", { n: xs.length });
      }
    }
    return fail(e, onUnknown);
  };
  const refreshList = () =>
    Referrals.campaigns()
      .then((r) => alive.current && setVersions(r.items))
      .catch(() => undefined);

  const createDraft = async () => {
    if (!active || busy) return;
    setBusy("create");
    try {
      const d = await Referrals.saveDraft({ payload: active.payload, comment: null, based_on: active.version }, null);
      applyDraft(d);
      setServer(null);
      toast(t("rcp.draftCreated", { v: d.version, b: active.version }), "ok", "referral.campaign_draft_saved");
      void refreshList();
    } catch (e) {
      toast(failed(e), "err");
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    if (!draft || !form || !checked || busy) return;
    const numErr = checked.errors.filter((x) => x.code === "required" || x.code === "not_integer");
    if (numErr.length) {
      setFormErr(t("rcp.fixNumbers", { n: numErr.length }));
      setTimeout(() => document.getElementById(fid(numErr[0]!.path))?.focus(), 30);
      return;
    }
    // F7-17: the text of the very problem — too short or too long
    const cp = comment.trim() ? reasonProblem(comment) : null;
    if (cp) {
      setFormErr(t(`sci.${cp}`, { min: REASON_MIN, max: REASON_MAX }));
      setTimeout(() => document.getElementById("rc-comment")?.focus(), 30);
      return;
    }
    setBusy("save");
    setFormErr(null);
    try {
      const d = await Referrals.saveDraft({ payload: checked.payload, comment: comment.trim() || null, based_on: draft.based_on }, draft.updated_at);
      applyDraft(d);
      toast(t("rcp.saved", { v: d.version }), "ok", "referral.campaign_draft_saved");
    } catch (e) {
      setFormErr(failed(e));
    } finally {
      setBusy(null);
    }
  };
  const validate = async () => {
    if (!draft || busy || dirty) return;
    setBusy("validate");
    setFormErr(null);
    try {
      const v = await Referrals.validate();
      const d = await Referrals.campaign(draft.version).catch(() => draft);
      setDraft(d);
      setServer({ ...v, errors: campaignIssues(v.errors), warnings: campaignIssues(v.warnings), at: d.updated_at });
      toast(v.ok ? t("rcp.checkOk") : t("rcp.checkBad", { n: v.errors.length }), v.ok ? "ok" : "err", "referral.campaign_validated");
    } catch (e) {
      setFormErr(failed(e));
    } finally {
      setBusy(null);
    }
  };
  const set = (path: string, v: string) => {
    setForm((f) => (f ? setCampaignValue(f, path, v) : f));
    setFormErr(null);
  };

  if (error && !versions) return <LoadError error={error} onRetry={() => void load()} />;
  if (!versions || !shown) return versions && !versions.length ? <Empty icon="gift" title={t("rcp.none")} /> : <Spinner label={t("common.loading")} />;
  const activeRow = versions.find((v) => v.status === "active") ?? null;

  return (
    <div className="stack" data-testid="rc">
      <section className="card ws" aria-labelledby="rc-h" data-testid="rc-head">
        <div className="ws-h">
          <div className="grow">
            <h2 className="h2" id="rc-h">
              {t("rcp.title")}
            </h2>
            <p className="small muted">{t("rcp.lead")}</p>
          </div>
          <div className="ws-pills">
            {activeRow && (
              <Pill tone="good" testId="rc-active">
                {t("rcp.activeV", { v: activeRow.version })}
              </Pill>
            )}
            {draft && (
              <Pill tone="info" testId="rc-draft">
                {t("rcp.draftV", { v: draft.version })}
              </Pill>
            )}
            {dirty && <Pill tone="warn">{t("ct.unsaved")}</Pill>}
          </div>
        </div>
        <div className="ag-roll">
          <div className="ag-roll-c">
            <span className="xs muted">{t("gr.r.active")}</span>
            <b>{activeRow ? `v${activeRow.version}` : "—"}</b>
            {activeRow?.activated_at && <span className="xs muted">{t("gr.byAt", { n: activeRow.activated_by?.name ?? t("rcp.migration"), t: fmt.dateTime(activeRow.activated_at) })}</span>}
          </div>
          <div className="ag-roll-c">
            <span className="xs muted">{t("gr.r.draft")}</span>
            <b>{draft ? `v${draft.version}${draft.based_on != null ? ` · ${t("gr.basedOn", { v: draft.based_on })}` : ""}` : t("gr.noDraft")}</b>
            {draft && <span className="xs muted">{t("gr.byAt", { n: draft.created_by?.name ?? "—", t: fmt.dateTime(draft.updated_at) })}</span>}
          </div>
          <div className="ag-roll-c">
            <span className="xs muted">{t("gr.r.check")}</span>
            <b data-testid="rc-check-state" data-state={!draft ? "none" : gate === "not_validated" ? "stale" : gate === "invalid" ? "bad" : gate === null ? "ok" : "unsaved"}>
              {!draft ? "—" : gate === null ? t("gr.checkedAt", { t: fmt.dateTime(draft.validated_at) }) : gate === "invalid" ? t("gr.checkFailed") : gate === "unsaved" ? t("gr.gate.unsaved") : t("gr.notChecked")}
            </b>
          </div>
        </div>
        <div className="acts ws-acts" data-testid="rc-actions">
          {manage && !draft && <Btn icon="copy" kind="primary" label={t("gr.newDraft", { v: activeRow?.version ?? "—" })} busy={busy === "create"} disabled={!active} onClick={() => void createDraft()} testId="rc-new-draft" />}
          {editable && (
            <>
              <Btn icon="check" kind={dirty ? "primary" : ""} label={t("common.save")} busy={busy === "save"} disabled={!dirty} onClick={() => void save()} testId="rc-save" />
              <Btn icon="clipboardCheck" label={t("gr.validate")} busy={busy === "validate"} disabled={dirty} title={dirty ? t("gr.gate.unsaved") : undefined} onClick={() => void validate()} testId="rc-validate" />
              <Btn icon="x" kind="danger-ghost" label={t("gr.deleteDraft")} onClick={() => setCmd({ kind: "delete" })} testId="rc-delete" />
              <Btn icon="send" kind={gate ? "" : "primary"} label={t("rcp.activate")} disabled={!!gate} title={gate ? t(`gr.gate.${gate}` as MessageKey) : undefined} onClick={() => setCmd({ kind: "activate" })} testId="rc-activate" />
            </>
          )}
        </div>
        {(gate && editable) || !manage ? (
          <p className="xs muted row ws-notes" data-testid="rc-notes" data-gate={gate ?? "ok"}>
            <Icon name={manage ? "info" : "lock"} />
            {gate && editable && <span>{t(`gr.gate.${gate}` as MessageKey)}</span>}
            {!manage && <span>{t("perm.need", { p: "referral.manage" })}</span>}
          </p>
        ) : null}
      </section>
      <Callout icon="lock" testId="rc-immutable">
        {t("rcp.immutable")}
      </Callout>
      {conflict && (
        <Reveal dep={conflict}>
          <Callout kind="warn" icon="alert" testId="rc-conflict">
            <b>{t("gr.conflict")}</b> {t("rcp.conflictM")} <Btn size="xs" icon="refresh" label={t("ct.reload")} onClick={() => void load()} testId="rc-reload" />
          </Callout>
        </Reveal>
      )}
      <FieldErr msg={formErr} />
      {serverFresh?.ok && (
        <Callout kind="good" icon="checkCircle" testId="rc-check-ok">
          {t("rcp.checkOkM")}
        </Callout>
      )}
      {errors.length > 0 && <IssueList title={t("gr.errorsN", { n: errors.length })} issues={errors} tone="bad" testId="rc-errors" />}
      {warnings.length > 0 && <IssueList title={t("gr.warningsN", { n: warnings.length })} issues={warnings} tone="warn" testId="rc-warnings" />}
      <div className="grid2">
        <section className="card stack sm" aria-labelledby="rc-f-h" data-testid="rc-form" data-editable={String(editable)}>
          <h2 className="h3" id="rc-f-h">
            {draft ? t("gr.tab.draft", { v: draft.version }) : t("rcp.activeParams", { v: activeRow?.version ?? "—" })}
          </h2>
          {!draft && <Callout icon="info" testId="rc-readonly">{manage ? t("rcp.roNoDraft") : t("rcp.roNoManage")}</Callout>}
          {editable && (
            <NoteField id="rc-comment" label={t("rcp.comment")} value={comment} onChange={setComment} hint={t("rcp.commentHint")} testId="rc-comment" rows={2} required={false} />
          )}
          <label className="check" data-testid="rc-diag-l">
            <input type="checkbox" checked={shown.require_diagnostic} disabled={!editable} onChange={(e) => setForm((f) => (f ? { ...f, require_diagnostic: e.target.checked } : f))} data-testid="rc-diag" />
            {t("rcf.require_diagnostic")}
          </label>
          {SECTIONS.map((sec) => (
            <fieldset key={sec.id} className={cx("fs soc-fs", sec.id === "review" && "is-internal")} data-testid={`rcs-${sec.id}`}>
              <legend className="field-label">{t(`rcs.${sec.id}` as MessageKey)}</legend>
              {sec.id === "review" && <p className="xs muted">{t("rcs.reviewNote")}</p>}
              <div className="gr-row">
                {sec.fields.map((p) => {
                  const xs = errors.filter((x) => x.path === p);
                  const ws = warnings.filter((x) => x.path === p);
                  const [min, max] = CAMPAIGN_LIMITS[p]!;
                  return (
                    <div className="field gr-num" key={p}>
                      <label htmlFor={fid(p)}>{t(`rcf.${p}` as MessageKey)}</label>
                      <input id={fid(p)} className={cx("input num-in", xs.length > 0 && "is-invalid")} inputMode="numeric" value={campaignValue(shown, p)} disabled={!editable} aria-invalid={xs.length > 0 || undefined} aria-describedby={`${fid(p)}-h`} onChange={(e) => set(p, e.target.value)} data-testid={fid(p)} />
                      <span className="hint" id={`${fid(p)}-h`}>
                        {t("rcp.range", { a: min, b: p === "min_days" ? t("rcp.toLessons") : max })}
                      </span>
                      <IssueText issues={[...xs, ...ws]} />
                    </div>
                  );
                })}
              </div>
              <IssueText issues={[...errors, ...warnings].filter((x) => x.path === sec.fields[0]!.split(".")[0] && !sec.fields.includes(x.path))} />
            </fieldset>
          ))}
        </section>
        <section className="card stack sm" aria-labelledby="rc-d-h" data-testid="rc-diff">
          <h2 className="h3" id="rc-d-h">
            {t("rcp.diff", { a: activeRow?.version ?? "—" })}
          </h2>
          {!draft ? <p className="small muted">{t("gr.diffNoDraft")}</p> : <CampaignDiff rows={diff} testId="rc-diff-rows" />}
          <p className="xs muted row">
            <Icon name="info" /> {t("rcp.diffNote")}
          </p>
        </section>
      </div>
      <History versions={versions} onOpen={(v) => navigate("referrals", `campaigns/${v}`)} />
      {openVersion != null && <VersionDrawer key={openVersion} version={openVersion} onClose={() => navigate("referrals", "campaigns")} />}
      {cmd?.kind === "delete" && draft && (
        <Modal
          title={t("gr.deleteT", { v: draft.version })}
          text={t("rcp.deleteM")}
          icon="x"
          tone="bad"
          onClose={() => setCmd(null)}
          testId="rc-delete-dialog"
          footer={
            <>
              <Btn label={t("common.cancel")} onClick={() => setCmd(null)} />
              <Btn
                label={t("gr.deleteDraft")}
                kind="danger"
                busy={busy === "delete"}
                testId="rc-delete-ok"
                onClick={async () => {
                  if (busy) return;
                  setBusy("delete");
                  try {
                    await Referrals.deleteDraft();
                    setCmd(null);
                    applyDraft(null);
                    setServer(null);
                    toast(t("gr.deleted", { v: draft.version }), "ok", "referral.campaign_draft_deleted");
                    void refreshList();
                  } catch (e) {
                    setCmd(null);
                    toast(failed(e), "err");
                  } finally {
                    setBusy(null);
                  }
                }}
              />
            </>
          }
        />
      )}
      {cmd?.kind === "activate" && draft && (
        <ConfirmCommand
          title={t("rcp.activateT", { v: draft.version })}
          text={t("rcp.activateM", { cur: activeRow?.version ?? "—" })}
          icon="send"
          ok={t("rcp.activate")}
          minReason={REASON_MIN}
          maxReason={REASON_MAX}
          reasonLabel={t("gm.comment")}
          reasonPlaceholder={t("rcp.activatePh")}
          testId="rc-activate-dialog"
          extra={
            <>
              <p className="small" data-testid="rc-activate-changes">
                {t("gr.changesN", { n: diff.length })}
              </p>
              {warnings.length > 0 && (
                <Callout kind="warn" icon="alert" testId="rc-activate-warnings">
                  {t("gr.activateWarn", { n: warnings.length })}
                </Callout>
              )}
              <StepUpNote />
            </>
          }
          onClose={() => setCmd(null)}
          onConfirm={async (c) => {
            const k = actKey.for(JSON.stringify(["activate", draft.version, draft.updated_at, c]));
            try {
              const v = await Referrals.activate(c, k);
              actKey.settle();
              setServer(null);
              toast(t("rcp.activated", { v: v.version }), "ok", "referral.campaign_activated");
              await load();
              return null;
            } catch (e) {
              actKey.settle(e);
              if (e instanceof ApiError && e.code === "CAMPAIGN_NOT_VALIDATED") void load();
              // F7-18: the answer is lost — the activation may have gone through: re-read the screen, say so and close
              // (a repeat of the same comment keeps its key, so it never activates twice)
              if (outcomeUnknown(e)) {
                toast(failed(e, () => void load()), "err", errMeta(e));
                return null;
              }
              return failed(e);
            }
          }}
        />
      )}
    </div>
  );
}

function IssueText({ issues }: { issues: readonly Issue[] }) {
  const text = useCampaignIssue();
  if (!issues.length) return null;
  return <FieldErr msg={[...new Set(issues.map(text))].join(" · ")} />;
}

function useCampaignIssue() {
  const { t } = useI18n();
  return (x: Issue) => {
    const k = `rci.${x.code}` as MessageKey;
    const s = t(k);
    return s === k ? x.code : s;
  };
}

function IssueList({ title, issues, tone, testId }: { title: string; issues: readonly Issue[]; tone: "bad" | "warn"; testId: string }) {
  const { t } = useI18n();
  const text = useCampaignIssue();
  return (
    <section className={cx("issues-panel", `is-${tone}`)} aria-label={title} data-testid={testId}>
      <h3 className="h3">
        <Icon name={tone === "bad" ? "alertCircle" : "alert"} /> {title}
      </h3>
      <ul className="issue-list">
        {issues.map((x, i) => {
          const k = `rcf.${x.path}` as MessageKey;
          const label = t(k) === k ? x.path : t(k);
          return (
            <li key={`${x.path}:${x.code}:${i}`} data-path={x.path} data-code={x.code}>
              <button type="button" className="tr" onClick={() => document.getElementById(fid(x.path))?.focus()}>
                {label}
              </button>
              <span className="grow">{text(x)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CampaignDiff({ rows, testId }: { rows: Array<{ path: string; from: unknown; to: unknown }>; testId: string }) {
  const { t } = useI18n();
  if (!rows.length)
    return (
      <p className="small muted" data-testid={`${testId}-none`}>
        {t("rcp.noDiff")}
      </p>
    );
  return (
    <div className="table-wrap">
      <table className="tbl dense" data-testid={testId}>
        <caption className="sr-only">{t("gr.tab.diff")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("gr.col.param")}</th>
            <th scope="col">{t("gr.col.was")}</th>
            <th scope="col">{t("gr.col.now")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const k = `rcf.${r.path}` as MessageKey;
            return (
              <tr key={r.path} data-path={r.path}>
                <th scope="row">
                  {t(k) === k ? r.path : t(k)}
                  <span className="mono xs muted block">{r.path}</span>
                </th>
                <td className="mono small">{typeof r.from === "boolean" ? (r.from ? t("common.yes") : t("common.no")) : showValue(r.from)}</td>
                <td className="mono small">{typeof r.to === "boolean" ? (r.to ? t("common.yes") : t("common.no")) : showValue(r.to)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function History({ versions, onOpen }: { versions: ReferralCampaignSummary[]; onOpen: (v: number) => void }) {
  const { t, fmt } = useI18n();
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  return (
    <section className="panel" aria-labelledby="rc-hist-h" data-testid="rc-history">
      <div className="panel-h">
        <h2 className="panel-t grow" id="rc-hist-h">
          <Icon name="clock" /> {t("gr.tab.history")}
        </h2>
      </div>
      <div className="table-wrap">
        <table className="tbl compact">
          <caption className="sr-only">{t("gr.tab.history")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("ct.col.version")}</th>
              <th scope="col">{t("col.status")}</th>
              <th scope="col">{t("gm.comment")}</th>
              <th scope="col">{t("ct.col.author")}</th>
              <th scope="col">{t("gr.col.activated")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((v) => (
              <tr key={v.version} data-testid={`rch-${v.version}`} data-status={v.status}>
                <td>
                  <button type="button" className="tr" onClick={() => onOpen(v.version)} data-testid={`rch-open-${v.version}`}>
                    v{v.version}
                  </button>
                  {v.based_on != null && <span className="xs muted block">{t("gr.basedOn", { v: v.based_on })}</span>}
                </td>
                <td>
                  <Pill tone={CAMPAIGN_TONE[v.status]}>{t(`gst.${v.status}` as MessageKey)}</Pill>
                </td>
                <td className="small wrap-any" lang="ru">
                  {v.comment ?? <span className="muted">—</span>}
                </td>
                <td className="small">
                  {v.created_by?.name ?? t("rcp.migration")}
                  <span className="xs muted block">{fmt.dateTime(v.created_at)}</span>
                </td>
                <td className="small">
                  {v.activated_at ? (
                    <>
                      {fmt.dateTime(v.activated_at)}
                      <span className="xs muted block">{v.activated_by?.name ?? t("rcp.migration")}</span>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel-f">
        <Icon name="lock" /> {t("rcp.histNote")}
      </div>
    </section>
  );
}

function VersionDrawer({ version, onClose }: { version: number; onClose: () => void }) {
  const { t, fmt } = useI18n();
  const [v, setV] = useState<ReferralCampaignVersion | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    Referrals.campaign(version)
      .then((x) => (setV(x), setError(null)))
      .catch(setError);
  }, [version]);
  useEffect(load, [load]);
  return (
    <Drawer
      wide
      testId="rc-version"
      onClose={onClose}
      title={t("rcp.versionT", { v: version })}
      sub={
        v && (
          <>
            <Pill tone={CAMPAIGN_TONE[v.status]}>{t(`gst.${v.status}` as MessageKey)}</Pill>
            <span>{t("gr.byAt", { n: v.created_by?.name ?? t("rcp.migration"), t: fmt.dateTime(v.created_at) })}</span>
          </>
        )
      }
    >
      {error && !v ? (
        <LoadError error={error} onRetry={load} />
      ) : !v ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="stack" data-testid="rc-version-body" data-status={v.status}>
          <dl className="dl">
            <dt>{t("gm.comment")}</dt>
            <dd lang="ru">{v.comment ?? "—"}</dd>
            <dt>{t("gr.col.activated")}</dt>
            <dd>{v.activated_at ? t("gr.byAt", { n: v.activated_by?.name ?? t("rcp.migration"), t: fmt.dateTime(v.activated_at) }) : "—"}</dd>
            <dt>{t("gr.validatedL")}</dt>
            <dd>{v.validated_at ? fmt.dateTime(v.validated_at) : "—"}</dd>
          </dl>
          <section className="stack sm">
            <h3 className="h3">{t("rcp.params")}</h3>
            <dl className="dl" data-testid="rc-version-params">
              <dt>{t("rcf.require_diagnostic")}</dt>
              <dd>{v.payload.require_diagnostic ? t("common.yes") : t("common.no")}</dd>
              {Object.keys(CAMPAIGN_LIMITS).map((p) => (
                <ParamRow key={p} path={p} value={campaignValue(campaignForm(v.payload), p)} />
              ))}
            </dl>
          </section>
          <section className="stack sm">
            <h3 className="h3">{v.status === "active" ? t("gr.isActive") : t("rcp.diffVsActive")}</h3>
            <CampaignDiff rows={v.diff} testId="rc-version-diff" />
          </section>
        </div>
      )}
    </Drawer>
  );
}

function ParamRow({ path, value }: { path: string; value: string }) {
  const { t } = useI18n();
  return (
    <>
      <dt>{t(`rcf.${path}` as MessageKey)}</dt>
      <dd className="num">{value}</dd>
    </>
  );
}

/* ---------------------------------------------------------------- statistics */

function StatsTab() {
  const { t, fmt } = useI18n();
  const [rows, setRows] = useState<ReferralCampaignStats[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    Referrals.stats()
      .then((r) => (setRows(r.items), setError(null)))
      .catch(setError);
  }, []);
  useEffect(load, [load]);
  if (error && !rows) return <LoadError error={error} onRetry={load} />;
  if (!rows) return <Spinner label={t("common.loading")} />;
  const reward = (r: { freeze: number; til: number }) => t("rst.reward", { f: fmt.num(r.freeze), t: fmt.num(r.til) });
  return (
    <section className="panel" aria-labelledby="rst-h" data-testid="ref-stats">
      <div className="panel-h">
        <h2 className="panel-t grow" id="rst-h">
          <Icon name="activity" /> {t("rst.title")}
        </h2>
      </div>
      {rows.length ? (
        <div className="table-wrap">
          <table className="tbl compact" data-testid="rst-rows">
            <caption className="sr-only">{t("rst.title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("ct.col.version")}</th>
                {(["invited", "in_progress", "in_review", "qualified", "rejected", "expired", "capped"] as const).map((k) => (
                  <th key={k} scope="col" className="r">
                    {t(`rst.${k}` as MessageKey)}
                  </th>
                ))}
                <th scope="col">{t("rst.rewards")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.version} data-testid={`rst-${r.version}`}>
                  <th scope="row">v{r.version}</th>
                  <td className="r num">{fmt.num(r.invited)}</td>
                  <td className="r num">{fmt.num(r.in_progress)}</td>
                  <td className="r num">{r.in_review ? <Pill tone="warn">{fmt.num(r.in_review)}</Pill> : fmt.num(r.in_review)}</td>
                  <td className="r num">{fmt.num(r.qualified)}</td>
                  <td className="r num">{fmt.num(r.rejected)}</td>
                  <td className="r num">{fmt.num(r.expired)}</td>
                  <td className="r num">{fmt.num(r.capped)}</td>
                  <td className="small">
                    {t("rst.inviter")}: {reward(r.rewards.inviter)}
                    <span className="block">
                      {t("rst.invitee")}: {reward(r.rewards.invitee)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="activity" title={t("rst.none")} />
      )}
      <div className="panel-f xs">
        <Icon name="info" /> {t("rst.note")}
      </div>
    </section>
  );
}
