import type { BillingOrderStatus, MinuteEntry, Page, StarsOrder } from "@tilhero/contracts/bff";
import { useRef, useState } from "react";
import { errorText } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { confirmPopup } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Pill, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { BillingError, Stars } from "./parts";
import { PayStatus, usePayOrder } from "./purchase";

const STATUS_TONE: Record<BillingOrderStatus, "ok" | "warn" | "mute" | undefined> = {
  pending: "warn",
  paid: "ok",
  fulfilled: "ok",
  expired: "mute",
  cancelled: "mute",
  refunded: undefined,
};

/** Pages of a cursor list: the first page on mount, «Показать ещё» appends the next one. */
function usePages<T>(load: (cursor: string | null) => Promise<Page<T>>, deps: readonly unknown[]) {
  const first = useLoad(() => load(null), deps);
  const [more, setMore] = useState<{ items: T[]; cursor: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const items = [...(first.data?.items ?? []), ...(more?.items ?? [])];
  const cursor = more ? more.cursor : (first.data?.next_cursor ?? null);
  const next = async () => {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const p = await load(cursor);
      setMore((m) => ({ items: [...(m?.items ?? []), ...p.items], cursor: p.next_cursor }));
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    setMore(null);
    await first.reload();
  };
  return { first, items, cursor, next, busy, reload };
}

/**
 * «История платежей» (APP-BILL-04): only Stars orders of the Mini App — purchases and renewals of the Stars subscription;
 * the product, the date, «⭐ N», the status in words, a refund. A pending order — «Оплатить» (the same invoice) and
 * «Отменить»; every order — «Вопрос по заказу» (support, SUBSCRIPTION_PAYMENT).
 */
export function PaymentsScreen() {
  const { bff, nav, session } = useApp();
  const { t } = useI18n();
  const list = usePages((c) => bff.orders(c), [session.learner.learner_id]);
  return (
    <>
      <Bar title={t("bill.ord.title")} onBack={nav.back} />
      <main className="scroll" data-testid="payments">
        <div className="pad stack">
          <p className="sub small">{t("bill.ord.note")}</p>
          {!list.first.data ? (
            list.first.loading ? <Skeleton lines={3} /> : <BillingError error={list.first.error} errorObj={list.first.errorObj} onRetry={() => void list.reload()} />
          ) : list.items.length ? (
            <ul className="stack tight" data-testid="orders">
              {list.items.map((o) => (
                <OrderRow key={o.order_no} o={o} onChanged={() => void list.reload()} />
              ))}
            </ul>
          ) : (
            <div className="card"><p className="sub" data-testid="orders-empty">{t("bill.ord.empty")}</p></div>
          )}
          {list.cursor ? (
            <Btn variant="secondary" busy={list.busy} onClick={() => void list.next()}>{t("c.more")}</Btn>
          ) : null}
        </div>
      </main>
    </>
  );
}

function OrderRow({ o, onChanged }: { o: StarsOrder; onChanged: () => void }) {
  const { bff, nav } = useApp();
  const { t, l, fmt } = useI18n();
  const pay = usePayOrder(() => onChanged());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const cancel = async () => {
    if (lock.current) return;
    lock.current = true;
    try {
      const ok = await confirmPopup({ title: t("bill.ord.cancelTitle"), message: t("bill.ord.cancelText"), ok: t("bill.ord.cancel"), cancel: t("c.back"), destructive: true });
      if (!ok) return;
      setBusy(true);
      setError(null);
      await bff.cancelOrder(o.order_no);
      showToast(t("bill.ord.cancelled"));
      onChanged();
    } catch (e) {
      setError(errorText(e, t, fmt.mmss));
      onChanged();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const pending = o.status === "pending";
  return (
    <li className="card stack tight bill-order" data-testid={`order-${o.order_no}`} data-status={o.status}>
      <div className="hrow between">
        <b>{l(o.product.title)}</b>
        <Stars n={o.amount_stars} testId={`order-amount-${o.order_no}`} />
      </div>
      <p className="sub small">
        {t("bill.ord.no", { n: o.order_no })} · {fmt.dateTime(o.paid_at ?? o.created_at)}
      </p>
      <div className="pills">
        <Pill tone={STATUS_TONE[o.status]}>{t(`bill.ord.st.${o.status}` as MessageKey)}</Pill>
        {o.channel === "renewal" ? <Pill tone="mute"><Icon name="review" size={14} />{t("bill.ord.renewal")}</Pill> : null}
        {o.refund ? <Pill tone={o.refund.status === "failed" ? "err" : undefined}>{t(`bill.ord.refund.${o.refund.status}` as MessageKey)}</Pill> : null}
      </div>
      <ErrorLine text={error} />
      <PayStatus phase={pay.phase} onAgain={() => void pay.pay(o)} onRecheck={() => void pay.recheck()} />
      <div className="duo">
        {pending && pay.phase.k !== "done" ? (
          <>
            <Btn busy={pay.phase.k === "checking" || pay.phase.k === "invoice"} disabled={busy} onClick={() => void pay.pay(o)} data-testid={`order-pay-${o.order_no}`}>
              {t("bill.ord.pay")}
            </Btn>
            <Btn variant="dangerOutline" busy={busy} disabled={pay.phase.k === "checking" || pay.phase.k === "invoice"} onClick={() => void cancel()} data-testid={`order-cancel-${o.order_no}`}>
              {t("bill.ord.cancel")}
            </Btn>
          </>
        ) : null}
      </div>
      <Btn
        variant="link"
        onClick={() => nav.push({ name: "support", category: "SUBSCRIPTION_PAYMENT", subject: t("bill.ord.askSubject", { n: o.order_no }) })}
        data-testid={`order-ask-${o.order_no}`}
      >
        <Icon name="chat" size={16} />
        {t("bill.ord.ask")}
      </Btn>
    </li>
  );
}

/** «История ИИ-минут»: what was granted, spent on a session (mine or a child profile's), burnt, revoked, adjusted. */
export function MinutesScreen() {
  const { bff, nav, session } = useApp();
  const { t, fmt } = useI18n();
  const list = usePages((c) => bff.billingMinutes(c), [session.learner.learner_id]);
  return (
    <>
      <Bar title={t("bill.mins.title")} onBack={nav.back} />
      <main className="scroll" data-testid="minutes">
        <div className="pad stack">
          {!list.first.data ? (
            list.first.loading ? <Skeleton lines={3} /> : <BillingError error={list.first.error} errorObj={list.first.errorObj} onRetry={() => void list.reload()} />
          ) : list.items.length ? (
            <ul className="list" data-testid="minute-entries">
              {list.items.map((e: MinuteEntry, i) => (
                <li key={`${e.at}-${i}`} className="row" data-testid="minute-entry" data-kind={e.kind}>
                  <span className="t">
                    <b>{t(`bill.mins.kind.${e.kind}` as MessageKey)}</b>
                    <span>
                      {t(`bill.mins.ref.${e.ref_kind}` as MessageKey)}
                      {e.learner === "child" ? ` · ${t("bill.mins.child")}` : ""} · {fmt.dateTime(e.at)}
                    </span>
                  </span>
                  <span className={e.minutes > 0 ? "v ok" : "v"} data-testid="minute-delta">
                    {t("bill.mins.n", { sign: e.minutes > 0 ? "+" : e.minutes < 0 ? "−" : "", n: Math.abs(e.minutes) })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="card"><p className="sub">{t("bill.mins.empty")}</p></div>
          )}
          {list.cursor ? (
            <Btn variant="secondary" busy={list.busy} onClick={() => void list.next()}>{t("c.more")}</Btn>
          ) : null}
        </div>
      </main>
    </>
  );
}
