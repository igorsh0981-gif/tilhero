import type { BillingCatalog, BillingProduct, StarsOrder, SubscriptionView } from "@tilhero/contracts/bff";
import { useRef, useState } from "react";
import { newIdempotencyKey } from "../../api/client";
import { canBuy, canToggleAutoRenew, hasAccess, purchasePlan, starsText, subscriptionsOf } from "../../domain/billing";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { canOpenInvoice, confirmPopup, haptic } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, NavRow, Pill, Skeleton, cx } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { BillingError, FeatureList, MinutesMeter, Notice, Stars, planFacts } from "./parts";
import { PurchaseSheet } from "./purchase";

interface Data {
  sub: SubscriptionView;
  /** null — a child profile (no catalogue: no prices, no buttons) */
  catalog: BillingCatalog | null;
}

/**
 * «Подписка» (APP-BILL-01…03): the status, the AI minutes of the period, the dates, the next period, the trial; a
 * subscription for Telegram Stars — «Автопродление: вкл./выкл.» and the date of the next charge; the plans for Stars with
 * what is included before the payment; links to the history of minutes and of Stars payments and «Вопрос по оплате».
 * Where the period came from is not shown (decision 3). A child profile sees only the family status — no prices, no
 * buttons, no calls to buy.
 */
export function SubscriptionScreen() {
  const { bff, nav, session } = useApp();
  const { t } = useI18n();
  const kid = session.learner.kind === "child";
  const data = useLoad<Data>(async () => {
    if (kid) return { sub: await bff.billingSubscription(), catalog: null };
    const [sub, catalog] = await Promise.all([bff.billingSubscription(), bff.billingCatalog()]);
    return { sub, catalog };
  }, [session.learner.learner_id]);
  const d = data.data;
  return (
    <>
      <Bar title={kid ? t("bill.kid.title") : t("bill.title")} onBack={nav.back} />
      <main className="scroll" data-testid="subscription">
        {!d ? (
          data.loading ? (
            <div className="pad"><Skeleton lines={4} /></div>
          ) : (
            <BillingError error={data.error} errorObj={data.errorObj} onRetry={() => void data.reload()} />
          )
        ) : kid ? (
          <KidStatus sub={d.sub} />
        ) : (
          <AdultSubscription sub={d.sub} catalog={d.catalog!} reload={() => void data.reload()} setSub={(sub) => data.setData((prev) => (prev ? { ...prev, sub } : prev))} />
        )}
      </main>
    </>
  );
}

/** A child profile: «Подписка семьи активна до …» or that learning works as usual — no prices, no buttons. */
function KidStatus({ sub }: { sub: SubscriptionView }) {
  const { t, fmt } = useI18n();
  const on = hasAccess(sub) && !!sub.period;
  return (
    <div className="pad">
      <div className={cx("card stack tight", on && "ok")} data-testid="bill-kid">
        <Icon name={on ? "star" : "book"} size={22} />
        <p className="sub ink" data-testid="bill-kid-text">{on ? t("bill.kid.active", { date: fmt.date(sub.period!.ends_at) }) : t("bill.kid.none")}</p>
      </div>
    </div>
  );
}

function AdultSubscription({ sub, catalog, reload, setSub }: { sub: SubscriptionView; catalog: BillingCatalog; reload: () => void; setSub: (v: SubscriptionView) => void }) {
  const { bff, nav } = useApp();
  const { t, tp } = useI18n();
  const [buying, setBuying] = useState<BillingProduct | null>(null);
  const trialKey = useRef<string | null>(null);
  const trial = useAction(async () => {
    trialKey.current ??= newIdempotencyKey();
    const v = await bff.startTrial(trialKey.current);
    trialKey.current = null;
    haptic.notify("success");
    showToast(t("bill.trial.started"));
    setSub(v);
  });
  const plans = subscriptionsOf(catalog);
  const buyable = canBuy(catalog);
  const showTrial = !!catalog.trial?.available && sub.trial_available && catalog.can_pay && !hasAccess(sub);
  const payer = !catalog.payer_required;

  return (
    <div className="stack loose">
      <div className="pad">
        <StatusCard sub={sub} onChanged={setSub} />
      </div>

      {catalog.consent_required && !catalog.can_pay ? (
        <div className="pad">
          <Notice
            text={t("bill.consent")}
            tone="warn"
            testId="bill-consent"
            action={
              <Btn variant="secondary" onClick={() => nav.push({ name: "guardian" })} data-testid="bill-consent-btn">
                {t("bill.consentBtn")}
              </Btn>
            }
          />
        </div>
      ) : !catalog.can_pay ? (
        <div className="pad"><Notice text={t("bill.notPayer")} testId="bill-not-payer" /></div>
      ) : !catalog.sales_enabled ? (
        <div className="pad"><Notice text={t("bill.salesOff")} tone="warn" testId="bill-sales-off" /></div>
      ) : !canOpenInvoice() ? (
        <div className="pad"><Notice text={t("bill.updateTg")} tone="warn" testId="bill-update-tg" /></div>
      ) : null}

      {showTrial && catalog.trial ? (
        <div className="pad">
          <div className="card pen stack tight" data-testid="bill-trial">
            <b className="h3">{t("bill.trial.title")}</b>
            <p className="sub ink">{t("bill.trial.text", { days: catalog.trial.days, dw: tp("bill.daysWord", catalog.trial.days), m: catalog.trial.minutes })}</p>
            <ErrorLine text={trial.error} />
            <Btn busy={trial.busy} onClick={() => void trial.run()} data-testid="bill-trial-start">
              <Icon name="spark" size={18} />
              {t("bill.trial.start")}
            </Btn>
          </div>
        </div>
      ) : null}

      {buyable && plans.length ? (
        <section className="pad stack tight" aria-labelledby="bill-plans">
          <h2 className="sec" id="bill-plans">{t("bill.plans")}</h2>
          <ul className="stack tight" data-testid="bill-plans">
            {plans.map((p) => (
              <PlanCard key={p.code} p={p} sub={sub} onBuy={() => setBuying(p)} />
            ))}
          </ul>
        </section>
      ) : null}

      <div className="pad">
        <div className="card stack tight" data-testid="bill-free">
          <b>{t("bill.free.title")}</b>
          <p className="sub">{t("bill.free.text")}</p>
          {!hasAccess(sub) ? <p className="sub small">{t("bill.free.noAi")}</p> : null}
        </div>
      </div>

      <div className="pad">
        <div className="list">
          <NavRow title={t("bill.link.minutes")} icon="clock" onClick={() => nav.push({ name: "minutes" })} testId="bill-link-minutes" />
          {payer ? <NavRow title={t("bill.link.payments")} icon="list" onClick={() => nav.push({ name: "payments" })} testId="bill-link-payments" /> : null}
          <NavRow
            title={t("bill.link.question")}
            icon="chat"
            onClick={() => nav.push({ name: "support", category: "SUBSCRIPTION_PAYMENT", subject: t("bill.questionSubject") })}
            testId="bill-link-question"
          />
        </div>
      </div>

      {buying ? (
        <PurchaseSheet
          product={buying}
          catalog={catalog}
          sub={sub}
          onClose={() => {
            setBuying(null);
            reload();
          }}
          onStale={reload}
          onSettled={(_o: StarsOrder) => {
            showToast(t("bill.pay.doneSub"));
            void bff.billingSubscription(true).then(setSub, () => undefined);
          }}
        />
      ) : null}
    </div>
  );
}

/** The status, the dates, the minutes meter, the next period and the Stars subscription with its auto-renew switch. */
function StatusCard({ sub, onChanged }: { sub: SubscriptionView; onChanged: (v: SubscriptionView) => void }) {
  const { bff } = useApp();
  const { t, tp, l, fmt } = useI18n();
  const p = sub.period;
  const s = sub.stars_subscription;
  const toggle = useAction(async (on: boolean) => {
    if (!on && s) {
      const ok = await confirmPopup({
        title: t("bill.sub.offTitle"),
        message: t("bill.sub.offText", { date: fmt.date(s.expires_at) }),
        ok: t("bill.sub.offOk"),
        cancel: t("c.cancel"),
        destructive: true,
      });
      if (!ok) return;
    }
    const v = await bff.setAutoRenew(on);
    haptic.selection();
    showToast(t(on ? "bill.sub.onDone" : "bill.sub.offDone"));
    onChanged(v);
  });
  const next = sub.next_period;
  return (
    <section className={cx("card stack", hasAccess(sub) && "bill-on")} aria-labelledby="bill-st" data-testid="bill-status" data-status={sub.status}>
      {/* the plan (when it says more than the status), then the status in words — one each, not repeated */}
      {sub.plan && l(sub.plan.title) !== t(`bill.st.${sub.status}` as MessageKey) ? <span className="cap" data-testid="bill-plan">{l(sub.plan.title)}</span> : null}
      <h2 className="h2 hrow" id="bill-st">
        <Icon name={hasAccess(sub) ? "check" : sub.status === "expired" ? "clock" : "star"} size={22} stroke={hasAccess(sub) ? 3 : 2} />
        {t(`bill.st.${sub.status}` as MessageKey)}
      </h2>
      {p ? (
        <p className="sub" data-testid="bill-dates">
          {sub.status === "expired" ? t("bill.expiredAt", { date: fmt.date(p.ends_at) }) : t("bill.activeUntil", { date: fmt.date(p.ends_at) })}
        </p>
      ) : null}
      {sub.expiring && p ? (
        <p className="sub small ink notice" role="note" data-testid="bill-expiring">
          <Icon name="alert" size={16} />
          {t("bill.expiring", { date: fmt.date(p.ends_at) })}
        </p>
      ) : null}
      {hasAccess(sub) ? <MinutesMeter v={sub} /> : null}
      {hasAccess(sub) ? <p className="sub small">{t("bill.min.what")}</p> : null}
      {next ? (
        <p className="sub small" data-testid="bill-next">
          {next.starts_at
            ? t("bill.next", { days: next.days, dw: tp("bill.daysWord", next.days), m: next.minutes_granted, date: fmt.date(next.starts_at) })
            : t("bill.nextAfter", { days: next.days, dw: tp("bill.daysWord", next.days), m: next.minutes_granted })}
        </p>
      ) : null}
      {s && (s.status === "active" || s.status === "canceled" || s.status === "failed") ? (
        <div className="bill-stars stack tight" data-testid="bill-stars" data-renew={s.auto_renew}>
          <div className="hrow between">
            <b>{t("bill.sub.title")}</b>
            <Pill tone={s.auto_renew ? "ok" : "mute"}>{s.auto_renew ? t("bill.sub.renewOn") : t("bill.sub.renewOff")}</Pill>
          </div>
          <p className="sub small" data-testid="bill-stars-next">
            {s.status === "failed"
              ? t("bill.sub.failed", { date: fmt.date(s.expires_at) })
              : s.auto_renew
                ? t("bill.sub.next", { date: fmt.date(s.expires_at), stars: starsText(s.amount_stars) })
                : t("bill.sub.offUntil", { date: fmt.date(s.expires_at) })}
          </p>
          {canToggleAutoRenew(s) ? (
            <>
              <ErrorLine text={toggle.error} />
              <Btn variant={s.auto_renew ? "secondary" : "primary"} busy={toggle.busy} onClick={() => void toggle.run(!s.auto_renew)} data-testid="bill-renew">
                {s.auto_renew ? t("bill.sub.turnOff") : t("bill.sub.turnOn")}
              </Btn>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PlanCard({ p, sub, onBuy }: { p: BillingProduct; sub: SubscriptionView; onBuy: () => void }) {
  const { t, tp, l, fmt } = useI18n();
  const plan = purchasePlan(p, sub);
  const days = p.days ?? 0;
  const noteId = `plan-why-${p.code}`;
  const why = plan.blocked
    ? plan.blocked.reason === "stars_exists"
      ? t("bill.plan.starsExists")
      : plan.blocked.until
        ? t("bill.plan.afterActive", { date: fmt.date(plan.blocked.until) })
        : t("err.ACTIVE_PERIOD_EXISTS")
    : null;
  return (
    <li className="card stack tight bill-plan" data-testid={`plan-${p.code}`} data-mode={p.price.mode}>
      <div className="hrow between">
        <b className="h3">{l(p.title)}</b>
        <Stars n={p.price.stars} className="big" testId={`plan-price-${p.code}`} />
      </div>
      {l(p.description) ? <p className="sub small">{l(p.description)}</p> : null}
      <div className="pills">
        <Pill tone="mute">{planFacts(p, t, tp)}</Pill>
        <Pill tone="mute">{p.price.mode === "subscription" ? t("bill.plan.renews") : t("bill.plan.once")}</Pill>
      </div>
      <FeatureList features={p.features} />
      {why ? (
        <p className="sub small ink notice" id={noteId} role="note" data-testid={`plan-why-${p.code}`}>
          <Icon name="info" size={16} />
          {why}
        </p>
      ) : null}
      <Btn variant={plan.blocked ? "secondary" : "primary"} disabled={!!plan.blocked} aria-describedby={why ? noteId : undefined} onClick={onBuy} data-testid={`plan-buy-${p.code}`}>
        {t("bill.plan.buy", { stars: starsText(p.price.stars) })}
      </Btn>
      <span className="sr">{t("bill.plan.per", { days, dw: tp("bill.daysWord", days) })}</span>
    </li>
  );
}
