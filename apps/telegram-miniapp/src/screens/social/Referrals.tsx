import type { Invite, ReferralReward, ReferralView } from "@tilhero/contracts/bff";
import { useRef, useState } from "react";
import { newIdempotencyKey } from "../../api/client";
import { teenWithoutConsent } from "../../domain/people";
import { legacyExpired, memberLabel, referralPct, referralSteps, referralTone, rejectReason } from "../../domain/social";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { shareToTelegram } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, Pill, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { useSocialConsentGate } from "../profile/SocialConsent";
import { SocialError, useSocialAction } from "./parts";

type TP = (k: MessageKey, n: number) => string;

/** «2 заморозки · 10 тилов» (zero parts are left out). */
export function rewardText(r: ReferralReward, tp: TP): string {
  const parts: string[] = [];
  if (r.freeze > 0) parts.push(`${r.freeze} ${tp("game.freezeWord", r.freeze)}`);
  if (r.til > 0) parts.push(`${r.til} ${tp("game.tilsWord", r.til)}`);
  return parts.join(" · ");
}

const OPEN: ReadonlySet<ReferralView["status"]> = new Set(["invited", "diagnostic_done", "learning"]);

/**
 * Referrals (APP-REF-01…04, AT-78): my personal link (an invitation kind referral of sprint 1, shared in Telegram), the
 * terms of the active campaign in plain words, the month's rewards against the limit; every invitee by nickname or
 * «Друг» with the progress «диагностика · уроки N/3 · дни N/2», the status (review — «проверяем»), the reward, and a
 * refusal with a plain reason — never the rules of the anti-fraud check. Children do not invite.
 */
export function ReferralsScreen() {
  const { bff, nav, session } = useApp();
  const { t, tp } = useI18n();
  const kid = session.learner.kind === "child";
  const teenLocked = teenWithoutConsent(session);
  const res = useLoad(() => (kid ? Promise.resolve(null) : bff.referrals()), [session.learner.learner_id]);
  const invites = useLoad(() => (kid ? Promise.resolve(null) : bff.invites(null).catch(() => null)), [session.learner.learner_id]);
  const link = invites.data?.items.find((i) => i.kind === "referral" && i.status === "active") ?? null;
  const gate = useSocialConsentGate();
  const key = useRef<string | null>(null);
  const create = useSocialAction(async (): Promise<Invite | undefined> => {
    key.current ??= newIdempotencyKey();
    let inv: Invite;
    try {
      inv = await bff.createInvite("referral", key.current);
    } catch (e) {
      if (gate.intercept(e, () => void create.run())) return;
      throw e;
    }
    key.current = null;
    invites.setData({ items: [inv, ...(invites.data?.items ?? [])], next_cursor: invites.data?.next_cursor ?? null });
    return inv;
  });
  const [copied, setCopied] = useState(false);
  const r = res.data;

  return (
    <>
      <Bar title={t("ref.title")} onBack={nav.back} />
      <main className="scroll" data-testid="referrals">
        <div className="pad stack loose">
          {kid || teenLocked ? (
            <div className="card warn" data-testid="ref-locked">
              <p className="sub ink">{kid ? t("ref.kid") : t("ref.teen")}</p>
            </div>
          ) : (
            <>
              <p className="sub ink">{t("ref.lead")}</p>
              <section className="card stack tight" aria-labelledby="ref-link" data-testid="ref-link">
                <h2 className="cap" id="ref-link">{t("ref.link")}</h2>
                {link ? (
                  <>
                    <p className="ref-url" lang="en" data-testid="ref-url">{link.link.replace(/^https:\/\//, "")}</p>
                    <div className="soc-actions">
                      <Btn onClick={() => shareToTelegram(link.link, t("ref.shareText"))} data-testid="ref-share">
                        <Icon name="share" size={18} />
                        {t("ref.share")}
                      </Btn>
                      <Btn
                        variant="secondary"
                        onClick={() =>
                          void navigator.clipboard?.writeText(link.link).then(
                            () => {
                              setCopied(true);
                              showToast(t("c.copied"));
                            },
                            () => undefined,
                          )
                        }
                        data-testid="ref-copy"
                        aria-pressed={copied}
                      >
                        <Icon name="copy" size={18} />
                        {t("ref.copy")}
                      </Btn>
                    </div>
                  </>
                ) : invites.loading && !invites.data ? (
                  <Skeleton lines={1} />
                ) : (
                  <Btn busy={create.busy} onClick={() => void create.run()} data-testid="ref-create">
                    <Icon name="gift" size={18} />
                    {t("ref.create")}
                  </Btn>
                )}
                <ErrorLine text={create.error} />
              </section>

              {!r ? (
                res.loading ? <Skeleton lines={3} /> : <SocialError error={res.error} errorObj={res.errorObj} onRetry={() => void res.reload()} />
              ) : (
                <>
                  <section className="card stack tight" aria-labelledby="ref-terms" data-testid="ref-terms">
                    <h2 className="cap" id="ref-terms">{t("ref.terms")}</h2>
                    <ul className="ref-terms">
                      {r.terms.require_diagnostic ? <li>{t("ref.term.diagnostic")}</li> : null}
                      <li>{t("ref.term.lessons", { n: r.terms.min_lessons, w: tp("soc.lessonsWord", r.terms.min_lessons) })}</li>
                      <li>{t("ref.term.days", { n: r.terms.min_days })}</li>
                      <li>{t("ref.term.window", { n: r.terms.window_days, w: tp("c.daysWord", r.terms.window_days) })}</li>
                    </ul>
                    {rewardText(r.terms.inviter_reward, tp) ? <p className="sub ink" data-testid="ref-reward">{t("ref.reward", { list: rewardText(r.terms.inviter_reward, tp) })}</p> : null}
                    {rewardText(r.terms.invitee_reward, tp) ? <p className="sub ink">{t("ref.rewardInvitee", { list: rewardText(r.terms.invitee_reward, tp) })}</p> : null}
                    <p className="sub small" data-testid="ref-month">{t("ref.month", { n: r.month.qualified, m: r.month.cap })}</p>
                    <p className="sub small">{t("ref.noMoney")}</p>
                  </section>
                  <section className="stack tight" aria-labelledby="ref-list">
                    <h2 className="sec" id="ref-list">{t("ref.list")}</h2>
                    {r.items.length ? (
                      <ul className="stack tight" data-testid="ref-list">
                        {r.items.map((v) => <ReferralRow key={v.referral_id} v={v} />)}
                      </ul>
                    ) : (
                      <p className="sub" data-testid="ref-empty">{t("ref.empty")}</p>
                    )}
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </main>
      {gate.sheet}
    </>
  );
}

function ReferralRow({ v }: { v: ReferralView }) {
  const { t, tp, fmt } = useI18n();
  const steps = referralSteps(v);
  const pct = referralPct(v);
  const reason = rejectReason(v);
  const open = OPEN.has(v.status);
  return (
    <li className="card stack tight" data-testid="ref-row" data-status={v.status} data-legacy={v.legacy || undefined}>
      <div className="hrow between">
        <b>{memberLabel(v.invitee_nickname, t)}</b>
        <Pill tone={referralTone(v.status)}>{v.reward_outcome === "legacy" ? t("ref.st.rewardedLegacy") : t(`ref.st.${v.status}` as MessageKey)}</Pill>
      </div>
      <span className="sub small">{t("ref.accepted", { date: fmt.date(v.accepted_at) })}</span>
      {open || v.status === "review" ? (
        <>
          <ul className="ref-steps" data-testid="ref-steps">
            {steps.map((s) => (
              <li key={s.key} className={cx("ref-step", s.done && "done")} data-testid={`ref-step-${s.key}`} data-done={s.done}>
                <span aria-hidden="true">{s.done ? <Icon name="check" size={14} stroke={3} /> : <Icon name="clock" size={14} />}</span>
                {s.key === "diagnostic" ? t("ref.step.diagnostic") : t(`ref.step.${s.key}` as MessageKey, { n: s.value, m: s.required })}
                <span className="sr">{s.done ? t("ref.stepDone") : t("ref.stepTodo")}</span>
              </li>
            ))}
          </ul>
          <div className="prog" role="progressbar" aria-label={t("ref.progressAria", { n: pct })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div style={{ width: `${pct}%` }} />
          </div>
          {open ? <span className="sub small" data-testid="ref-until">{t("ref.until", { date: fmt.date(v.progress.window_ends_at) })}</span> : null}
        </>
      ) : null}
      {v.status === "review" ? <p className="sub small" data-testid="ref-review">{t("ref.reviewNote")}</p> : null}
      {v.reward && (v.status === "qualified" || v.status === "rewarded") ? (
        <p className="sub ink ic-line" data-testid="ref-row-reward"><Icon name="gift" size={16} /> {t("ref.reward", { list: rewardText(v.reward, tp) })}</p>
      ) : null}
      {legacyExpired(v) ? <p className="sub ink" data-testid="ref-legacy">{t("ref.legacy")}</p> : null}
      {reason && !open && v.status !== "review" && v.status !== "qualified" && v.status !== "rewarded" ? (
        <p className="sub ink" data-testid="ref-reason">{t("ref.why", { text: t(`ref.reject.${reason}` as MessageKey) })}</p>
      ) : null}
    </li>
  );
}
