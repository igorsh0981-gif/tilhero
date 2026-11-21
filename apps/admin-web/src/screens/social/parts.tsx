/**
 * Shared pieces of «Сообщество»: a learner reference (short UUID, a link to the social card with social.read; «обезличен»
 * after the deletion saga), a staff reference, the reason / basis / note field with its counter (10..500), the step-up
 * notice, the sanctions table with the revoke command, the error text of a command and the learner lookup by UUID.
 * Nothing here shows correspondence, answers or a learner's name — only ids, nicknames, statuses, dates and counters.
 */
import { useState, type ReactNode } from "react";
import type { AdminSanction, StaffRef } from "@tilhero/contracts/admin";
import { Moderation } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { Btn, Callout, cx, Empty, FieldErr, Pill } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { errText } from "../../ui/errors";
import { useToast } from "../../ui/toasts";
import { CommandKey, outcomeUnknown } from "../memory/model";
import { canRevoke, isUuid, REASON_MAX, REASON_MIN, sanctionState, type Issue } from "./model";

/** a learner by UUID: a short id (full in the title) and the way to their social card; null — anonymised */
export function UserRef({ id, testId, card = true }: { id: string | null; testId?: string; card?: boolean }) {
  const { t } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  if (!id)
    return (
      <span className="tag plain" data-testid={testId}>
        {t("soc.anon")}
      </span>
    );
  const label = shortId(id, 8, 4);
  if (card && can("social.read"))
    return (
      <button type="button" className="tr mono" title={id} aria-label={t("soc.openCardOf", { id: label })} onClick={() => navigate("friends", id)} data-testid={testId}>
        {label}
      </button>
    );
  return (
    <span className="mono" title={id} data-testid={testId}>
      {label}
    </span>
  );
}

export const staffName = (s: StaffRef | null | undefined, system: string) => s?.name ?? system;

/** The text of a command error: a dismissed TOTP, an unknown outcome (re-read), else the dictionary text of the code. */
export function useCmdFail() {
  const i18n = useI18n();
  return (e: unknown, onUnknown?: () => void): string => {
    if ((e as ApiError)?.cancelled) return i18n.t("stepup.cancelled");
    if (outcomeUnknown(e)) {
      onUnknown?.();
      return i18n.t("soc.unknownOutcome");
    }
    return errText(i18n, e);
  };
}

/** Text of a form problem of the section: `sci.<code>`, else the raw code. */
export function useSocIssue() {
  const { t } = useI18n();
  return (x: Issue | null | undefined) => {
    if (!x) return null;
    const k = `sci.${x.code}` as MessageKey;
    const s = t(k, { min: REASON_MIN, max: REASON_MAX });
    return s === k ? x.code : s;
  };
}

/** A reason / basis / note of 10..500 characters with a live counter; the error is shown after the first try. */
export function NoteField({ id, label, value, onChange, error, hint, placeholder, testId, rows = 3, required = true }: { id: string; label: string; value: string; onChange: (v: string) => void; error?: string | null; hint?: ReactNode; placeholder?: string; testId?: string; rows?: number; required?: boolean }) {
  const n = value.trim().length;
  const over = n > REASON_MAX;
  return (
    <div className="field">
      <div className="field-top">
        <label htmlFor={id} className={cx(required && "req")}>
          {label}
        </label>
        <span className={cx("counter", (over || (!!error && n < REASON_MIN)) && "is-over")} data-testid={testId ? `${testId}-count` : undefined}>
          {n}/{REASON_MAX}
        </span>
      </div>
      <textarea id={id} className={cx("textarea", (!!error || over) && "is-invalid")} rows={rows} value={value} maxLength={REASON_MAX * 2} placeholder={placeholder} aria-invalid={!!error || undefined} aria-describedby={error ? `${id}-e` : hint ? `${id}-h` : undefined} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
      {hint && !error && (
        <span className="hint" id={`${id}-h`}>
          {hint}
        </span>
      )}
      <FieldErr msg={error} id={`${id}-e`} />
    </div>
  );
}

export function StepUpNote({ testId, text }: { testId?: string; text?: string }) {
  const { t } = useI18n();
  return (
    <Callout kind="info" icon="smartphoneKey" testId={testId}>
      {text ?? t("ct.stepUpNote")}
    </Callout>
  );
}

export function SanctionPill({ s }: { s: Pick<AdminSanction, "active" | "revoked_at" | "until" | "kind"> }) {
  const { t } = useI18n();
  const st = sanctionState(s);
  return <Pill tone={st === "active" ? "bad" : st === "revoked" ? "info" : "neutral"}>{t(`ssst.${st}` as MessageKey)}</Pill>;
}

/** «бессрочно» / «до 30.11.2026 14:00» / «—» (a warning or a nickname reset has no term) */
export function useTerm() {
  const { t, fmt } = useI18n();
  return (s: Pick<AdminSanction, "kind" | "until">) => (s.kind !== "social_ban" ? "—" : s.until ? t("soc.until", { t: fmt.dateTime(s.until) }) : t("soc.forever"));
}

/**
 * Sanctions with their basis, term, who decided and the appeal; «Снять» for a sanction in force (moderation.manage —
 * the caller passes onRevoke only with the right).
 */
export function SanctionsTable({ items, showUser, onRevoke, testId, empty }: { items: AdminSanction[]; showUser?: boolean; onRevoke?: ((s: AdminSanction) => void) | null; testId: string; empty?: string }) {
  const { t, fmt } = useI18n();
  const term = useTerm();
  if (!items.length) return <p className="small muted" data-testid={`${testId}-empty`}>{empty ?? t("soc.noSanctions")}</p>;
  return (
    <div className="table-wrap">
      <table className="tbl compact soc-tbl" data-testid={testId}>
        <caption className="sr-only">{t("soc.sanctions")}</caption>
        <thead>
          <tr>
            {showUser && <th scope="col">{t("soc.col.learner")}</th>}
            <th scope="col">{t("soc.col.sanction")}</th>
            <th scope="col">{t("soc.col.term")}</th>
            <th scope="col">{t("soc.col.basis")}</th>
            <th scope="col">{t("soc.col.decided")}</th>
            <th scope="col">{t("soc.col.appeal")}</th>
            {onRevoke && (
              <th scope="col" className="r">
                {t("ct.col.actions")}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.sanction_id} data-testid={`${testId}-${s.sanction_id}`} data-state={sanctionState(s)}>
              {showUser && (
                <td>
                  <UserRef id={s.user_id} />
                </td>
              )}
              <td className="small">
                <b>{t(`sk7.${s.kind}` as MessageKey)}</b>
                <span className="block">
                  <SanctionPill s={s} />
                </span>
              </td>
              <td className="small nowrap">{term(s)}</td>
              <td className="small wrap-any soc-basis" lang="ru">
                {s.basis}
                {s.revoked_at && (
                  <span className="xs muted block" data-testid={`${testId}-${s.sanction_id}-revoked`}>
                    {t("soc.revokedBy", { n: staffName(s.revoked_by, t("soc.system")), t: fmt.dateTime(s.revoked_at) })}
                    {s.revoke_reason ? ` · ${s.revoke_reason}` : ""}
                  </span>
                )}
              </td>
              <td className="small">
                {staffName(s.decided_by, t("soc.system"))}
                <span className="xs muted block">{fmt.dateTime(s.decided_at)}</span>
              </td>
              <td className="small">{s.appeal ? <Pill tone={s.appeal.status === "open" ? "warn" : s.appeal.status === "overturned" ? "good" : "neutral"}>{t(`aps7.${s.appeal.status}` as MessageKey)}</Pill> : <span className="muted">—</span>}</td>
              {onRevoke && (
                <td className="actions-cell">
                  {canRevoke(s) && <Btn size="xs" kind="danger-ghost" icon="unlock" label={t("mod.revoke")} onClick={() => onRevoke(s)} testId={`${testId}-revoke-${s.sanction_id}`} />}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** «Снять санкцию»: a reason of 10..500 (audit); the learner gets the restriction lifted at once. */
export function RevokeDialog({ sanction, onClose, onDone }: { sanction: AdminSanction; onClose: () => void; onDone: (s: AdminSanction) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const fail = useCmdFail();
  const term = useTerm();
  const [key] = useState(() => new CommandKey(uuid));
  return (
    <ConfirmCommand
      title={t("mod.revokeT", { k: t(`sk7.${sanction.kind}` as MessageKey) })}
      text={t("mod.revokeM")}
      icon="unlock"
      ok={t("mod.revoke")}
      minReason={REASON_MIN}
      maxReason={REASON_MAX}
      reasonPlaceholder={t("mod.revokePh")}
      testId="mod-revoke-dialog"
      extra={
        <dl className="dl" data-testid="mod-revoke-what">
          <dt>{t("soc.col.learner")}</dt>
          <dd className="mono">{sanction.user_id}</dd>
          <dt>{t("soc.col.term")}</dt>
          <dd>{term(sanction)}</dd>
          <dt>{t("soc.col.basis")}</dt>
          <dd lang="ru">{sanction.basis}</dd>
        </dl>
      }
      onClose={onClose}
      onConfirm={async (reason) => {
        const k = key.for(JSON.stringify(["revoke", sanction.sanction_id, reason]));
        try {
          const s = await Moderation.revoke(sanction.sanction_id, reason, k);
          key.settle();
          toast(t("mod.revoked"), "ok", "moderation.sanction_revoked");
          onDone(s);
          return null;
        } catch (e) {
          key.settle(e);
          if (e instanceof ApiError && e.code === "SANCTION_STATE") onDone(sanction);
          return fail(e);
        }
      }}
    />
  );
}

/** The learner lookup by UUID (the social card has no search by name: nicknames and codes are the learners' own). */
export function UserLookup({ page, sub, title, text, testId }: { page: string; sub?: string; title: string; text: string; testId: string }) {
  const { t } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const [id, setId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <section className="card stack sm mem-lookup" aria-labelledby={`${testId}-h`} data-testid={testId}>
      <h2 className="h2" id={`${testId}-h`}>
        {title}
      </h2>
      <p className="small muted">{text}</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!isUuid(id)) return setErr(t("mem.lookupErr"));
          navigate(page, `${sub ? `${sub}/` : ""}${id.trim().toLowerCase()}`);
        }}
      >
        <div className="field grow">
          <label htmlFor={`${testId}-uid`}>{t("mem.uid")}</label>
          <input id={`${testId}-uid`} className="input mono" value={id} spellCheck={false} autoComplete="off" placeholder="a1000000-0000-4000-8000-000000000001" aria-invalid={!!err || undefined} aria-describedby={err ? `${testId}-uid-e` : undefined} onChange={(e) => (setId(e.target.value), setErr(null))} data-testid={`${testId}-uid`} />
          <FieldErr msg={err} id={`${testId}-uid-e`} />
        </div>
        <Btn type="submit" kind="primary" icon="search" label={t("mem.open")} testId={`${testId}-go`} />
      </form>
      {can("users.read") ? (
        <Empty icon="users" title={t("soc.fromCard")} text={t("soc.fromCardM")}>
          <Btn size="sm" icon="users" label={t("mem.toLearners")} onClick={() => navigate("users")} testId={`${testId}-to-users`} />
        </Empty>
      ) : (
        <p className="xs muted row">
          <Icon name="info" /> {t("soc.noUsers")}
        </p>
      )}
    </section>
  );
}

/** «Переписка и ответы учеников здесь не показываются» — the privacy line of every screen of the section */
export function PrivacyNote({ text, testId }: { text?: string; testId?: string }) {
  const { t } = useI18n();
  return (
    <p className="xs muted row soc-privacy" data-testid={testId}>
      <Icon name="shield" /> {text ?? t("soc.privacy")}
    </p>
  );
}
