import type { WebCatalog, WebMe, WebProduct, WebSubscriptionView } from "@tilhero/contracts/web";
import { api } from "../api";
import { useI18n } from "../i18n";
import { formatDate, formatSum } from "../money";
import { navigate } from "../router";
import { ErrorBox, Loading, Notice, useLoad } from "../ui";

/** Почему этот аккаунт не может платить (или null). */
export function PayerNotice({ me }: { me: WebMe }) {
  const { t } = useI18n();
  if (me.account.can_pay) return null;
  return <Notice tone="warn">{t(me.account.consent_required ? "payer.consent" : "payer.age")}</Notice>;
}

export function SubscriptionCard({ sub }: { sub: WebSubscriptionView }) {
  const { t, lang } = useI18n();
  const p = sub.period;
  let line: string;
  if (sub.status === "trial" && p) line = t("sub.trial", { date: formatDate(p.ends_at, lang) });
  else if (sub.status === "active" && p)
    line = sub.plan
      ? t("sub.active", { plan: sub.plan.title[lang], date: formatDate(p.ends_at, lang) })
      : t("sub.active_noplan", { date: formatDate(p.ends_at, lang) });
  else if (sub.status === "expired") line = t("sub.expired");
  else line = t("sub.none");
  return (
    <section className="card sub" aria-labelledby="sub-title" data-testid="subscription">
      <div className="sub__head">
        <h2 id="sub-title" className="card__title">
          {t("sub.title")}
        </h2>
        {sub.expiring && <span className="status status--expiring">{t("sub.expiring")}</span>}
      </div>
      <p className="sub__line">{line}</p>
      {p && (sub.status === "active" || sub.status === "trial") && (
        <>
          <p className="muted">{t("sub.minutes", { left: p.minutes_left, granted: p.minutes_granted })}</p>
          <div
            className="meter"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={p.minutes_granted}
            aria-valuenow={p.minutes_left}
            aria-label={t("sub.minutes", { left: p.minutes_left, granted: p.minutes_granted })}
          >
            <span className={`meter__fill meter__fill--${meterStep(p.minutes_left, p.minutes_granted)}`} />
          </div>
        </>
      )}
      {sub.next_period && (
        <p className="muted small">{t("sub.next", { days: sub.next_period.days, minutes: sub.next_period.minutes_granted })}</p>
      )}
    </section>
  );
}

/** Заполнение шкалы ступенями по 10 % (классы CSS: встроенные стили запрещены CSP). */
function meterStep(left: number, granted: number): number {
  if (granted <= 0) return 0;
  return Math.max(0, Math.min(10, Math.round((left * 10) / granted)));
}

export function ProductCard({ product, disabled }: { product: WebProduct; disabled: boolean }) {
  const { t, lang } = useI18n();
  return (
    <article className="card product" data-testid={`product-${product.code}`}>
      <h3 className="product__title">{product.title[lang]}</h3>
      {product.description && <p className="product__desc">{product.description[lang]}</p>}
      <ul className="facts">
        {product.days !== null && <li>{t("cat.days", { days: product.days })}</li>}
        {product.minutes !== null && <li>{t("cat.minutes", { minutes: product.minutes })}</li>}
        {product.til !== null && <li>{t("cat.til", { til: product.til })}</li>}
      </ul>
      {product.features.length > 0 && (
        <ul className="features">
          {product.features.map((f) => (
            <li key={f}>{t(`feature.${f}`)}</li>
          ))}
        </ul>
      )}
      <div className="product__foot">
        <span className="price" data-testid="price">
          {formatSum(product.price.tiyin, lang)}
        </span>
        <button type="button" className="btn btn--primary" disabled={disabled} onClick={() => navigate(`/buy/${product.code}`)}>
          {t("cat.choose")}
        </button>
      </div>
    </article>
  );
}

export function HomePage({ me }: { me: WebMe }) {
  const data = useLoad(async () => {
    const [catalog, sub] = await Promise.all([api.catalog(), api.subscription()]);
    return { catalog, sub } as { catalog: WebCatalog; sub: WebSubscriptionView };
  }, []);
  return (
    <main className="page" id="main">
      <PayerNotice me={me} />
      {data.loading && !data.data && <Loading />}
      {data.error !== null && <ErrorBox error={data.error} onRetry={data.reload} />}
      {data.data && <Catalog me={me} catalog={data.data.catalog} sub={data.data.sub} />}
    </main>
  );
}

function Catalog({ me, catalog, sub }: { me: WebMe; catalog: WebCatalog; sub: WebSubscriptionView }) {
  const { t } = useI18n();
  const disabled = !catalog.sales_enabled || !me.account.can_pay;
  const subs = catalog.products.filter((p) => p.kind === "subscription");
  const tils = catalog.products.filter((p) => p.kind === "til_pack");
  return (
    <>
      <SubscriptionCard sub={sub} />
      {!catalog.sales_enabled && <Notice tone="warn">{t("cat.unavailable")}</Notice>}
      {subs.length > 0 && (
        <section aria-labelledby="cat-subs">
          <h2 id="cat-subs" className="section-title">
            {t("cat.subscriptions")}
          </h2>
          <div className="grid">
            {subs.map((p) => (
              <ProductCard key={p.code} product={p} disabled={disabled} />
            ))}
          </div>
        </section>
      )}
      {tils.length > 0 && (
        <section aria-labelledby="cat-tils">
          <h2 id="cat-tils" className="section-title">
            {t("cat.tils")}
          </h2>
          <div className="grid">
            {tils.map((p) => (
              <ProductCard key={p.code} product={p} disabled={disabled} />
            ))}
          </div>
        </section>
      )}
      {catalog.products.length === 0 && <Notice>{t("cat.empty")}</Notice>}
    </>
  );
}
