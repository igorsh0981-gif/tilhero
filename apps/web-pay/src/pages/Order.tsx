/**
 * Страница заказа /orders/{order_no} — сюда провайдер возвращает покупателя. Пока заказ pending или paid — опрос
 * статуса (каждые 3 с, до 3 минут); источник истины — billing. Оплатить (если не оплачен), отменить, фискальный чек.
 */
import { useEffect, useState } from "react";
import type { WebOrder } from "@tilhero/contracts/web";
import { ApiError, api, goToCheckout, safeHttps } from "../api";
import { errorText, useI18n } from "../i18n";
import { formatDateTime, formatSum } from "../money";
import { ErrorBox, Link, Loading, Notice, StatusChip, useLoad } from "../ui";
import { PROVIDER_NAMES } from "./Buy";

export const POLL_INTERVAL_MS = 3000;
export const POLL_MAX = 60;

export function OrderPage({ orderNo }: { orderNo: number }) {
  const { t } = useI18n();
  const data = useLoad(() => api.order(orderNo), [orderNo]);
  const [polls, setPolls] = useState(0);
  const order = data.data;
  const waiting = order !== null && (order.status === "pending" || order.status === "paid");

  useEffect(() => {
    if (!waiting || polls >= POLL_MAX || data.error !== null) return;
    const timer = window.setTimeout(() => {
      api.order(orderNo).then(
        (o) => {
          data.set(o);
          setPolls((n) => n + 1);
        },
        () => setPolls((n) => n + 1),
      );
    }, POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, polls, orderNo, data.error]);

  const notFound = data.error instanceof ApiError && data.error.status === 404;
  return (
    <main className="page page--narrow" id="main">
      <p>
        <Link to="/orders" className="back">
          ← {t("nav.orders")}
        </Link>
      </p>
      {data.loading && !order && <Loading />}
      {notFound && <Notice tone="error">{t("order.not_found")}</Notice>}
      {data.error !== null && !notFound && <ErrorBox error={data.error} onRetry={data.reload} />}
      {order && (
        <OrderCard
          order={order}
          pollingDone={polls >= POLL_MAX}
          onChange={(o) => data.set(o)}
          onRefresh={() => {
            setPolls(0);
            data.reload();
          }}
        />
      )}
    </main>
  );
}

function OrderCard({
  order,
  pollingDone,
  onChange,
  onRefresh,
}: {
  order: WebOrder;
  pollingDone: boolean;
  onChange: (o: WebOrder) => void;
  onRefresh: () => void;
}) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const receipt = safeHttps(order.receipt_url);
  const refundReceipt = safeHttps(order.refund?.receipt_url);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.cancelOrder(order.order_no));
    } catch (e) {
      setError(errorText(t, e instanceof ApiError ? e.code : "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card order" aria-labelledby="order-title" data-testid="order">
      <div className="order__head">
        <h1 id="order-title" className="card__title">
          {t("order.title", { no: order.order_no })}
        </h1>
        <StatusChip status={order.status} />
      </div>
      <p className="order__product">{order.product.title[lang]}</p>
      <dl className="kv">
        <dt>{t("order.amount")}</dt>
        <dd data-testid="order-amount">{formatSum(order.amount_tiyin, lang)}</dd>
        <dt>{t("order.provider")}</dt>
        <dd>{PROVIDER_NAMES[order.provider]}</dd>
        <dt>{t("order.created")}</dt>
        <dd>{formatDateTime(order.created_at, lang)}</dd>
        {order.paid_at && (
          <>
            <dt>{t("order.paid")}</dt>
            <dd>{formatDateTime(order.paid_at, lang)}</dd>
          </>
        )}
        {order.status === "pending" && (
          <>
            <dt>{t("order.expires")}</dt>
            <dd>{formatDateTime(order.expires_at, lang)}</dd>
          </>
        )}
        {receipt && (
          <>
            <dt>{t("order.receipt")}</dt>
            <dd>
              <a href={receipt} target="_blank" rel="noopener noreferrer">
                {t("order.receipt.open")} ↗
              </a>
            </dd>
          </>
        )}
        {order.refund && (
          <>
            <dt>{t("order.refund")}</dt>
            <dd>
              {t(`order.refund.${order.refund.status}`)}
              {refundReceipt && (
                <>
                  {" · "}
                  <a href={refundReceipt} target="_blank" rel="noopener noreferrer">
                    {t("order.receipt.open")} ↗
                  </a>
                </>
              )}
            </dd>
          </>
        )}
      </dl>

      {order.status === "fulfilled" && <Notice tone="ok">{t(order.product.kind === "subscription" ? "order.done.subscription" : "order.done.til_pack")}</Notice>}
      {(order.status === "pending" || order.status === "paid") && !pollingDone && (
        <p className="loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {t("order.checking")}
        </p>
      )}
      {(order.status === "pending" || order.status === "paid") && pollingDone && (
        <Notice>
          <span>{t("order.check_later")}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRefresh}>
            {t("common.refresh")}
          </button>
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      {order.status === "pending" && (
        <div className="actions">
          {order.checkout_url && (
            <button type="button" className="btn btn--primary" onClick={() => goToCheckout(order.checkout_url)} disabled={busy}>
              {t("order.pay")}
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={() => void cancel()} disabled={busy}>
            {t("order.cancel")}
          </button>
        </div>
      )}
    </section>
  );
}
