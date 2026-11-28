import type { AiLockReason, BillingFeature, BillingProduct, SubscriptionRequiredReason, SubscriptionView } from "@tilhero/contracts/bff";
import type { ReactNode } from "react";
import { ApiError } from "../../api/errors";
import { lockKey, lockLeadsToPlans, minutesLeftPct, starsText } from "../../domain/billing";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { Icon } from "../../ui/Icon";
import { Btn, cx } from "../../ui/kit";
import { Sheet } from "../../ui/overlays";

/* Building blocks of the billing screens (sprint 8). Every number and price comes from the server; a price is whole
 * Telegram Stars only («⭐ 250») and is never shown in a child profile. */

/** «⭐ 250» with a spoken label («250 звёзд Telegram»). */
export function Stars({ n, className, testId }: { n: number; className?: string; testId?: string }) {
  const { t, tp } = useI18n();
  return (
    <span className={cx("stars", className)} aria-label={t("bill.starsAria", { n, w: tp("bill.starsWord", n) })} data-testid={testId}>
      <span aria-hidden="true">{starsText(n)}</span>
    </span>
  );
}

/** What the subscription opens — a list with check marks (never colour only). */
export function FeatureList({ features, testId }: { features: readonly BillingFeature[]; testId?: string }) {
  const { t } = useI18n();
  if (!features.length) return null;
  return (
    <ul className="bill-feats" data-testid={testId}>
      {features.map((f) => (
        <li key={f}>
          <span className="mk" aria-hidden="true"><Icon name="check" size={14} stroke={3} /></span>
          {t(`bill.feat.${f}` as MessageKey)}
        </li>
      ))}
    </ul>
  );
}

/** The counter of AI minutes of the current period: «285 из 300», a bar with its words, held and overage notes. */
export function MinutesMeter({ v }: { v: SubscriptionView }) {
  const { t } = useI18n();
  const p = v.period;
  if (!p) return null;
  const pct = minutesLeftPct(v);
  return (
    <div className="bill-meter" data-testid="bill-minutes">
      <div className="hrow between">
        <span className="sub small">{t("bill.min.label")}</span>
        <b data-testid="bill-minutes-left">{t("bill.min.left", { n: p.minutes_left, m: p.minutes_granted })}</b>
      </div>
      <div
        className={cx("prog", pct <= 10 && "low")}
        role="progressbar"
        aria-label={t("bill.min.label")}
        aria-valuemin={0}
        aria-valuemax={p.minutes_granted}
        aria-valuenow={p.minutes_left}
        aria-valuetext={t("bill.min.aria", { n: p.minutes_left, m: p.minutes_granted })}
      >
        <div style={{ width: `${pct}%` }} />
      </div>
      {p.minutes_held > 0 ? <p className="sub small">{t("bill.min.held", { n: p.minutes_held })}</p> : null}
      {p.overage > 0 ? <p className="sub small">{t("bill.min.overage", { n: p.overage })}</p> : null}
      {v.minutes_exhausted ? (
        <p className="sub small ink notice" role="note" data-testid="bill-exhausted">
          <Icon name="info" size={16} />
          {t("bill.min.exhausted")}
        </p>
      ) : null}
    </div>
  );
}

/** «30 дней · 300 ИИ-минут» of a subscription product. */
export function planFacts(p: BillingProduct, t: (k: MessageKey, v?: Record<string, string | number>) => string, tp: (k: MessageKey, n: number) => string): string {
  if (p.kind !== "subscription" || p.days == null || p.minutes == null) return "";
  return t("bill.plan.facts", { days: p.days, dw: tp("bill.daysWord", p.days), m: p.minutes });
}

/** A neutral notice card (info icon + text, optional action). */
export function Notice({ text, tone, action, testId }: { text: string; tone?: "warn" | "err" | "pen"; action?: ReactNode; testId?: string }) {
  return (
    <div className={cx("card stack tight", tone)} role="status" data-testid={testId}>
      <p className="sub ink notice">
        <Icon name="info" size={18} />
        {text}
      </p>
      {action}
    </div>
  );
}

/** Billing is down (503 BILLING_UNAVAILABLE / no network): «учёба работает как обычно», plus «Повторить». */
export function BillingError({ error, errorObj, onRetry }: { error: string | null; errorObj: unknown; onRetry: () => void }) {
  const { t } = useI18n();
  const down = errorObj instanceof ApiError && (errorObj.code === "BILLING_UNAVAILABLE" || errorObj.status >= 500 || errorObj.status === 0);
  return (
    <div className="pad stack tight" data-testid="bill-error">
      <Notice text={down ? t("bill.unavailable") : (error ?? t("err.UNKNOWN"))} tone="warn" />
      <Btn variant="secondary" onClick={onRetry}>{t("c.retry")}</Btn>
    </div>
  );
}

/**
 * The plaque at the start of a lesson that goes with ready replies because of the plan (APP-LESS-01, sprint 8): the
 * reason in words; «О подписке» — where a subscription would change it. Plus «ИИ: осталось N мин» when the AI is on.
 */
export function AiPlanPlaque({ locked, minutesLeft, kid }: { locked: AiLockReason | null; minutesLeft: number | null; kid: boolean }) {
  const { nav } = useApp();
  const { t } = useI18n();
  if (kid) return null;
  if (locked) {
    return (
      <div className="card notice bill-lock" role="note" data-testid="pl-ai-locked" data-reason={locked}>
        <Icon name="lock" size={20} />
        <div className="stack tight grow">
          <p className="sub ink">{t(lockKey(locked))}</p>
          {lockLeadsToPlans(locked) ? (
            <Btn variant="link" onClick={() => nav.push({ name: "subscription" })} data-testid="pl-ai-locked-more">
              {t("bill.lock.more")}
            </Btn>
          ) : null}
        </div>
      </div>
    );
  }
  if (minutesLeft == null) return null;
  return (
    <p className="bill-ai-left" role="note" data-testid="pl-ai-left">
      <Icon name="clock" size={16} />
      {t("bill.aiLeft", { n: minutesLeft })}
    </p>
  );
}

/** «Уроки вдвоём — в подписке» (403 SUBSCRIPTION_REQUIRED of the invitation): accepting a friend's invitation is free. */
export function PairSubscriptionSheet({ reason, onClose }: { reason: SubscriptionRequiredReason; onClose: () => void }) {
  const { nav } = useApp();
  const { t } = useI18n();
  return (
    <Sheet title={t("bill.pair.title")} onClose={onClose} testId="pair-sub-sheet">
      <p className="sub ink">{t(`bill.pair.${reason}` as MessageKey)}</p>
      <div className="stack tight">
        {reason !== "kids" ? (
          <Btn
            onClick={() => {
              onClose();
              nav.push({ name: "subscription" });
            }}
            data-testid="pair-sub-more"
          >
            {t("bill.pair.more")}
          </Btn>
        ) : null}
        <Btn variant="secondary" onClick={onClose}>{t("c.close")}</Btn>
      </div>
    </Sheet>
  );
}
