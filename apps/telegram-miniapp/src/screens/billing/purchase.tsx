import type { BillingCatalog, BillingProduct, StarsOrder, SubscriptionView } from "@tilhero/contracts/bff";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../../api/errors";
import { CREDIT_POLL_MS, canSubmit, keepOrderKey, orderBody, orderSettled, pollOrder, purchasePlan, purchaseProblem, starsText, type PurchaseChoice, type PurchaseProblem } from "../../domain/billing";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { keyForDraft, type DraftKey } from "../../state/idempotency";
import { canOpenInvoice, haptic, openExternal, openInvoice } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, Check, ErrorLine, Opt } from "../../ui/kit";
import { Sheet } from "../../ui/overlays";
import { FeatureList, Notice, Stars } from "./parts";

/* ---------------------------------------------------------------- paying an order: openInvoice → the poll */

export type PayPhase =
  | { k: "idle" }
  | { k: "invoice"; order: StarsOrder }
  | { k: "checking"; order: StarsOrder }
  | { k: "done"; order: StarsOrder }
  | { k: "cancelled"; order: StarsOrder }
  | { k: "failed"; order: StarsOrder | null }
  | { k: "slow"; order: StarsOrder }
  | { k: "closed"; order: StarsOrder }
  | { k: "noLink"; order: StarsOrder }
  | { k: "unsupported" };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Pays a Stars order: the invoice opens in Telegram (only through src/tg openInvoice), then the order is polled — the
 * billing is the source of truth, not the status of the invoice (§14 S5): «paid» / «pending» — until paid, ≤ 60 s;
 * «cancelled» / «failed» — one check (the payment may still have gone through). A pending order without a link yet is
 * re-read a few times (Telegram was slow to make the invoice).
 */
export function usePayOrder(onSettled?: (o: StarsOrder) => void) {
  const { bff } = useApp();
  const [phase, setPhase] = useState<PayPhase>({ k: "idle" });
  const abort = useRef<AbortController | null>(null);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  useEffect(() => () => abort.current?.abort(), []);

  const pay = async (start: StarsOrder): Promise<void> => {
    if (!canOpenInvoice()) {
      setPhase({ k: "unsupported" });
      return;
    }
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    let o = start;
    for (let i = 0; o.status === "pending" && !o.invoice_link && i < 3 && !ac.signal.aborted; i++) {
      await sleep(1000);
      try {
        o = await bff.order(o.order_no, true);
      } catch {
        /* the next read */
      }
    }
    if (ac.signal.aborted) return;
    if (orderSettled(o)) return finish(o);
    if (o.status !== "pending") return setPhase({ k: "closed", order: o });
    if (!o.invoice_link) return setPhase({ k: "noLink", order: o });
    setPhase({ k: "invoice", order: o });
    const outcome = await openInvoice(o.invoice_link);
    if (ac.signal.aborted) return;
    if (outcome === "busy") return;
    if (outcome === "unsupported") return setPhase({ k: "unsupported" });
    if (outcome === "invalid") return setPhase({ k: "failed", order: o });
    setPhase({ k: "checking", order: o });
    const hopeful = outcome === "paid" || outcome === "pending";
    const res = await pollOrder({ read: () => bff.order(o.order_no, true), signal: ac.signal }, { untilSettled: hopeful });
    if (res.kind === "aborted") return;
    if (res.kind === "settled") return finish(res.order);
    if (res.kind === "closed") return setPhase({ k: "closed", order: res.order });
    const last = res.order ?? o;
    if (hopeful) return setPhase({ k: "slow", order: last });
    setPhase(outcome === "cancelled" ? { k: "cancelled", order: last } : { k: "failed", order: last });
  };

  const finish = (o: StarsOrder) => {
    haptic.notify("success");
    setPhase({ k: "done", order: o });
    settled.current?.(o);
    // tils: paid at once, credited by gamification a moment later — follow it a little (the words become «Зачислено»)
    if (o.status === "paid" && o.product.kind === "til_pack") {
      const ac = abort.current;
      void pollOrder({ read: () => bff.order(o.order_no, true), signal: ac?.signal }, { limitMs: CREDIT_POLL_MS, done: (x) => x.status === "fulfilled" }).then((r) => {
        if (r.kind !== "settled" || ac?.signal.aborted) return;
        setPhase({ k: "done", order: r.order });
        settled.current?.(r.order);
      });
    }
  };

  /** «Проверить ещё раз» after a slow payment: one more poll of up to 60 s. */
  const recheck = async () => {
    if (phase.k !== "slow" && phase.k !== "cancelled" && phase.k !== "failed") return;
    const o = phase.order;
    if (!o) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setPhase({ k: "checking", order: o });
    const res = await pollOrder({ read: () => bff.order(o.order_no, true), signal: ac.signal });
    if (res.kind === "aborted") return;
    if (res.kind === "settled") return finish(res.order);
    if (res.kind === "closed") return setPhase({ k: "closed", order: res.order });
    setPhase({ k: "slow", order: res.order ?? o });
  };

  const reset = () => {
    abort.current?.abort();
    setPhase({ k: "idle" });
  };
  return { phase, pay, recheck, reset };
}

/** What the screen says after the invoice (the words of a phase), with the actions it offers. */
export function PayStatus({ phase, onAgain, onRecheck, tilsFor }: { phase: PayPhase; onAgain: () => void; onRecheck: () => void; tilsFor?: string | null }) {
  const { t, l, fmt } = useI18n();
  switch (phase.k) {
    case "idle":
    case "invoice":
      return null;
    case "checking":
      return (
        <p className="sub ink bill-checking" role="status" aria-live="polite" data-testid="pay-checking">
          <span className="spin" aria-hidden="true" />
          {t("bill.pay.checking")}
        </p>
      );
    case "done": {
      const o = phase.order;
      const tils = o.product.kind === "til_pack";
      const text = !tils ? t("bill.pay.doneSub") : o.status === "fulfilled" ? t("bill.pay.doneTils", { what: l(o.product.title) }) : t("bill.pay.doneTilsSoon");
      return (
        <div className="card ok notice" role="status" data-testid="pay-done">
          <Icon name="check" size={20} stroke={3} />
          <p className="sub ink">{tilsFor && tils ? `${text} · ${tilsFor}` : text}</p>
        </div>
      );
    }
    case "cancelled":
    case "failed": {
      const text = phase.k === "cancelled" && phase.order ? t("bill.pay.cancelled", { time: fmt.dateTime(phase.order.expires_at) }) : t("bill.pay.failed");
      return (
        <Notice
          text={text}
          tone="warn"
          testId={`pay-${phase.k}`}
          action={
            phase.order ? (
              <Btn variant="secondary" onClick={onAgain} data-testid="pay-again">
                {t("bill.pay.again")}
              </Btn>
            ) : null
          }
        />
      );
    }
    case "slow":
      return (
        <Notice
          text={t("bill.pay.slow")}
          tone="pen"
          testId="pay-slow"
          action={
            <Btn variant="secondary" onClick={onRecheck} data-testid="pay-recheck">
              {t("bill.pay.check")}
            </Btn>
          }
        />
      );
    case "closed":
      return <Notice text={t("bill.pay.closed")} tone="warn" testId="pay-closed" />;
    case "noLink":
      return (
        <Notice
          text={t("bill.pay.starsRetry")}
          tone="warn"
          testId="pay-nolink"
          action={
            <Btn variant="secondary" onClick={onAgain} data-testid="pay-again">
              {t("bill.pay.retry")}
            </Btn>
          }
        />
      );
    case "unsupported":
      return <Notice text={t("bill.updateTg")} tone="warn" testId="pay-unsupported" />;
  }
}

/* ---------------------------------------------------------------- the purchase sheet */

/**
 * Before the payment (APP-BILL-01/02): the product, the price in Stars, the term, the minutes and what is included; when
 * to start (a one-off period over a running one); the confirmation that the rest of the trial burns; the recipient of a
 * til pack (me or a child profile); the offer and the consent. «Оплатить ⭐ N» → POST /v1/billing/orders (one
 * Idempotency-Key per content of the sheet) → openInvoice → the poll.
 */
export function PurchaseSheet(props: {
  product: BillingProduct;
  catalog: BillingCatalog;
  sub: SubscriptionView | null;
  /** til pack: who gets it — learners of the account (me first) */
  recipients?: Array<{ id: string | null; label: string }>;
  initialRecipient?: string | null;
  onClose: () => void;
  /** the catalogue changed on the server (offer version, the product went away) */
  onStale: () => void;
  /** paid: reload the subscription / the balance */
  onSettled: (o: StarsOrder) => void;
}) {
  const { product: p, catalog, sub } = props;
  const { bff } = useApp();
  const { t, tp, l, fmt } = useI18n();
  const plan = purchasePlan(p, sub);
  const [choice, setChoice] = useState<PurchaseChoice>({ startMode: plan.startModes ? "after_current" : null, forfeit: false, beneficiaryId: props.initialRecipient ?? null });
  const [offerOk, setOfferOk] = useState(false);
  const [problem, setProblem] = useState<PurchaseProblem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [order, setOrder] = useState<StarsOrder | null>(null);
  const key = useRef<DraftKey | null>(null);
  const lock = useRef(false);
  const pay = usePayOrder(props.onSettled);
  const recipientLabel = props.recipients?.find((r) => r.id === choice.beneficiaryId)?.label ?? null;
  const forfeitAsked = plan.forfeitsTrial || problem?.kind === "forfeit";
  const effectivePlan = problem?.kind === "forfeit" ? { ...plan, forfeitsTrial: true } : plan;
  const ready = canSubmit(effectivePlan, choice, offerOk) && !sending && pay.phase.k !== "checking" && pay.phase.k !== "invoice";
  const settledDone = pay.phase.k === "done";

  const submit = async () => {
    if (lock.current || !ready) return;
    if (!canOpenInvoice()) {
      setError(t("bill.updateTg"));
      return;
    }
    lock.current = true;
    setSending(true);
    setError(null);
    setProblem(null);
    const body = orderBody(p, catalog.offer.version, effectivePlan, choice);
    key.current = keyForDraft(key.current, body);
    try {
      const o = await bff.createOrder(body, key.current.key);
      setOrder(o);
      await pay.pay(o);
    } catch (e) {
      if (!keepOrderKey(e)) key.current = null;
      const pr = purchaseProblem(e);
      setProblem(pr);
      if (pr.kind === "offer") {
        setOfferOk(false);
        props.onStale();
      } else if (pr.kind === "gone") props.onStale();
      if (pr.kind === "other") setError(errorText(e, t, fmt.mmss));
    } finally {
      lock.current = false;
      setSending(false);
    }
  };

  const days = p.days ?? 0;
  return (
    <Sheet title={l(p.title)} cap={t("bill.buy.cap")} onClose={props.onClose} testId="buy-sheet">
      <div className="stack bill-buy">
        <div className="card lc-kv" data-testid="buy-facts">
          <div className="kv"><span>{t("bill.buy.price")}</span><Stars n={p.price.stars} testId="buy-price" /></div>
          {p.kind === "subscription" ? (
            <>
              <div className="kv">
                <span>{t("bill.buy.term")}</span>
                <span data-testid="buy-term">{t(p.price.mode === "subscription" ? "bill.buy.termSub" : "bill.buy.termOnce", { days, dw: tp("bill.daysWord", days) })}</span>
              </div>
              <div className="kv"><span>{t("bill.buy.minutes")}</span><span data-testid="buy-minutes">{t("bill.buy.minutesN", { m: p.minutes ?? 0 })}</span></div>
            </>
          ) : (
            <div className="kv"><span>{t("bill.buy.tils")}</span><span data-testid="buy-tils">{t("game.tilsN", { n: p.til ?? 0, w: tp("game.tilsWord", p.til ?? 0) })}</span></div>
          )}
        </div>
        {p.kind === "subscription" ? (
          <section className="stack tight" aria-labelledby="buy-inc">
            <h3 className="sec" id="buy-inc">{t("bill.buy.includes")}</h3>
            <FeatureList features={p.features} testId="buy-features" />
            {p.price.mode === "subscription" ? <p className="sub small" data-testid="buy-renews">{t("bill.sub.how")}</p> : null}
          </section>
        ) : null}

        {p.kind === "subscription" && p.price.mode === "subscription" && !forfeitAsked ? <p className="sub small">{t("bill.buy.startsNow")}</p> : null}

        {plan.startModes ? (
          <section className="stack tight" aria-labelledby="buy-start">
            <h3 className="sec" id="buy-start">{t("bill.buy.start")}</h3>
            <div className="opts" role="group" aria-labelledby="buy-start">
              <Opt on={choice.startMode !== "now"} title={t("bill.buy.startAfter")} note={sub?.period ? `${t("bill.buy.startAfterNote")} · ${fmt.date(sub.period.ends_at)}` : t("bill.buy.startAfterNote")} onClick={() => setChoice((c) => ({ ...c, startMode: "after_current", forfeit: false }))} testId="buy-start-after" />
              <Opt on={choice.startMode === "now"} title={t("bill.buy.startNow")} note={t("bill.buy.startNowNote")} onClick={() => setChoice((c) => ({ ...c, startMode: "now", forfeit: false }))} testId="buy-start-now" />
            </div>
          </section>
        ) : null}

        {forfeitAsked || choice.startMode === "now" ? (
          <div className="card warn stack tight" data-testid="buy-forfeit">
            <p className="sub ink">
              {problem?.kind === "forfeit" && problem.minutesLeft != null && problem.daysLeft != null
                ? t("bill.buy.forfeitTrialN", { m: problem.minutesLeft, d: problem.daysLeft, dw: tp("bill.daysWord", problem.daysLeft) })
                : forfeitAsked
                  ? t("bill.buy.forfeitTrial")
                  : t("bill.buy.forfeitPeriod")}
            </p>
            <Check checked={choice.forfeit} onChange={(v) => setChoice((c) => ({ ...c, forfeit: v }))} testId="buy-forfeit-ok">
              {t("bill.buy.forfeitOk")}
            </Check>
          </div>
        ) : null}

        {p.kind === "til_pack" && props.recipients && props.recipients.length > 1 ? (
          <section className="stack tight" aria-labelledby="buy-to">
            <h3 className="sec" id="buy-to">{t("bill.buy.recipient")}</h3>
            <div className="opts two" role="group" aria-labelledby="buy-to">
              {props.recipients.map((r) => (
                <Opt key={r.id ?? "me"} on={choice.beneficiaryId === r.id} title={r.label} onClick={() => setChoice((c) => ({ ...c, beneficiaryId: r.id }))} testId={`buy-to-${r.id ?? "me"}`} />
              ))}
            </div>
          </section>
        ) : null}

        <div className="stack tight">
          <Btn variant="link" onClick={() => openExternal(catalog.offer.url)} data-testid="buy-offer-link">
            <Icon name="book" size={18} />
            {t("bill.buy.offerLink")}
          </Btn>
          <Check checked={offerOk} onChange={setOfferOk} testId="buy-offer">
            {t("bill.buy.offerOk")}
          </Check>
          {problem?.kind === "offer" ? <p className="field-err" role="alert">{t("bill.buy.offerChanged")}</p> : null}
        </div>

        <ProblemLine problem={problem} />
        <ErrorLine text={error} />
        <PayStatus
          phase={pay.phase}
          tilsFor={recipientLabel}
          onAgain={() => {
            const o = pay.phase.k === "cancelled" || pay.phase.k === "failed" || pay.phase.k === "noLink" ? pay.phase.order : order;
            if (o) void pay.pay(o);
          }}
          onRecheck={() => void pay.recheck()}
        />
        <p className="sub small">{t("bill.payHow")}</p>
        {settledDone ? (
          <Btn onClick={props.onClose} data-testid="buy-close">{t("c.close")}</Btn>
        ) : (
          <Btn
            busy={sending || pay.phase.k === "checking" || pay.phase.k === "invoice"}
            disabled={!ready}
            onClick={() => void submit()}
            aria-label={t("bill.buy.pay", { stars: t("bill.starsAria", { n: p.price.stars, w: tp("bill.starsWord", p.price.stars) }) })}
            data-testid="buy-pay"
          >
            {t("bill.buy.pay", { stars: starsText(p.price.stars) })}
          </Btn>
        )}
      </div>
    </Sheet>
  );
}

function ProblemLine({ problem }: { problem: PurchaseProblem | null }) {
  const { t, fmt } = useI18n();
  if (!problem || problem.kind === "other" || problem.kind === "forfeit" || problem.kind === "offer") return null;
  const text: Record<Exclude<PurchaseProblem["kind"], "other" | "forfeit" | "offer">, string> = {
    active: problem.kind === "active" && problem.until ? t("bill.plan.afterActive", { date: fmt.date(problem.until) }) : t("err.ACTIVE_PERIOD_EXISTS"),
    starsExists: t("bill.plan.starsExists"),
    salesOff: t("bill.salesOff"),
    consent: t("bill.consent"),
    gone: t("err.PRODUCT_NOT_AVAILABLE"),
    starsRetry: t("bill.pay.starsRetry"),
    tooMany: t("bill.pay.tooMany"),
  };
  return (
    <p className="field-err" role="alert" data-testid="buy-problem" data-kind={problem.kind}>
      <Icon name="alert" size={16} />
      {text[problem.kind as keyof typeof text]}
    </p>
  );
}
