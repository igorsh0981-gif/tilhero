/** История заказов сайта (только заказы сайта: покупки за Stars видны в Mini App). */
import { useState } from "react";
import type { WebOrder } from "@tilhero/contracts/web";
import { api } from "../api";
import { useI18n } from "../i18n";
import { formatDate, formatSum } from "../money";
import { ErrorBox, Link, Loading, Notice, StatusChip, useLoad } from "../ui";

export function OrdersPage() {
  const { t, lang } = useI18n();
  const first = useLoad(() => api.orders(), []);
  const [more, setMore] = useState<WebOrder[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const next = cursor === undefined ? (first.data?.next_cursor ?? null) : cursor;
  const items = [...(first.data?.items ?? []), ...more];

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.orders(next);
      setMore((m) => [...m, ...page.items]);
      setCursor(page.next_cursor);
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <main className="page page--narrow" id="main">
      <h1 className="section-title">{t("orders.title")}</h1>
      {first.loading && !first.data && <Loading />}
      {first.error !== null && <ErrorBox error={first.error} onRetry={first.reload} />}
      {first.data && items.length === 0 && <Notice>{t("orders.empty")}</Notice>}
      {items.length > 0 && (
        <ul className="orders" data-testid="orders">
          {items.map((o) => (
            <li key={o.order_no}>
              <Link to={`/orders/${o.order_no}`} className="orders__row">
                <span className="orders__main">
                  <span className="orders__title">
                    № {o.order_no} · {o.product.title[lang]}
                  </span>
                  <span className="muted small">{formatDate(o.created_at, lang)}</span>
                </span>
                <span className="orders__side">
                  <span className="orders__amount">{formatSum(o.amount_tiyin, lang)}</span>
                  <StatusChip status={o.status} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {moreError !== null && <ErrorBox error={moreError} />}
      {next && (
        <button type="button" className="btn btn--ghost btn--wide" onClick={() => void loadMore()} disabled={loadingMore}>
          {t("orders.more")}
        </button>
      )}
    </main>
  );
}
