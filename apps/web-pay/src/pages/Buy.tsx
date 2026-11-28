/**
 * Оформление покупки: что входит и цена — до оплаты; получатель тилов (я или детский профиль); для подписки при
 * активном периоде — «после текущего» или «начать сейчас» (остаток сгорает — только с подтверждением); способ оплаты;
 * согласие с офертой → POST /api/orders (Idempotency-Key, CSRF) → переход на страницу провайдера (location.assign).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { WebCatalog, WebMe, WebOrderRequest, WebProvider, WebSubscriptionView } from "@tilhero/contracts/web";
import { ApiError, api, goToCheckout, newIdempotencyKey, safeHttps } from "../api";
import { errorText, useI18n } from "../i18n";
import { formatDate, formatSum } from "../money";
import { navigate } from "../router";
import { ErrorBox, Link, Loading, Notice, useLoad } from "../ui";
import { PayerNotice } from "./Home";

export const PROVIDER_NAMES: Record<WebProvider, string> = { payme: "Payme", click: "Click", uzum: "Uzum" };

const DAY_MS = 86_400_000;

export function BuyPage({ me, code }: { me: WebMe; code: string }) {
  const { t } = useI18n();
  const data = useLoad(async () => {
    const [catalog, sub] = await Promise.all([api.catalog(), api.subscription()]);
    return { catalog, sub } as { catalog: WebCatalog; sub: WebSubscriptionView };
  }, []);
  return (
    <main className="page page--narrow" id="main">
      <p>
        <Link to="/" className="back">
          ← {t("common.back")}
        </Link>
      </p>
      <PayerNotice me={me} />
      {data.loading && !data.data && <Loading />}
      {data.error !== null && <ErrorBox error={data.error} onRetry={data.reload} />}
      {data.data && <BuyForm me={me} code={code} catalog={data.data.catalog} sub={data.data.sub} onCatalogStale={data.reload} />}
    </main>
  );
}

function BuyForm({
  me,
  code,
  catalog,
  sub,
  onCatalogStale,
}: {
  me: WebMe;
  code: string;
  catalog: WebCatalog;
  sub: WebSubscriptionView;
  onCatalogStale: () => void;
}) {
  const { t, lang } = useI18n();
  const product = catalog.products.find((p) => p.code === code);
  const self = me.learners.find((l) => l.kind === "self");
  const isSub = product?.kind === "subscription";
  const active = (sub.status === "active" || sub.status === "trial") && sub.period !== null;

  const [startMode, setStartMode] = useState<"after_current" | "now">(active ? "after_current" : "now");
  const [confirmForfeit, setConfirmForfeit] = useState(false);
  const [forfeit, setForfeit] = useState<{ minutes_left: number; days_left: number } | null>(null);
  const [recipient, setRecipient] = useState<string>(self?.learner_id ?? "");
  const [provider, setProvider] = useState<WebProvider | null>(catalog.providers[0] ?? null);
  const [offer, setOffer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // каталог перечитан (новая оферта) — согласие заново
  useEffect(() => setOffer(false), [catalog.offer.version]);

  // один ключ идемпотентности на одну и ту же форму: повтор после сбоя сети — тот же заказ
  const idemKey = useRef(newIdempotencyKey());
  useEffect(() => {
    idemKey.current = newIdempotencyKey();
  }, [code, provider, recipient, startMode, confirmForfeit, catalog.offer.version]);

  const forfeitText = useMemo(() => {
    if (forfeit) return t("buy.start.forfeit", { minutes: forfeit.minutes_left, days: forfeit.days_left });
    if (sub.period) {
      const days = Math.max(0, Math.ceil((Date.parse(sub.period.ends_at) - Date.now()) / DAY_MS));
      return t("buy.start.forfeit", { minutes: sub.period.minutes_left, days });
    }
    return t("buy.start.forfeit_short");
  }, [forfeit, sub.period, t]);

  if (!product) {
    return <Notice tone="error">{t("buy.not_found")}</Notice>;
  }

  const needsForfeit = isSub && startMode === "now" && (active || forfeit !== null);
  const offerUrl = safeHttps(catalog.offer.url);
  const canSubmit =
    catalog.sales_enabled && me.account.can_pay && provider !== null && offer && (!needsForfeit || confirmForfeit) && !busy && !redirecting;

  const submit = async () => {
    if (!canSubmit || !provider) return;
    setBusy(true);
    setError(null);
    const body: WebOrderRequest = {
      product_code: product.code,
      provider,
      offer_version: catalog.offer.version,
      ...(isSub ? { start_mode: startMode, ...(needsForfeit ? { confirm_forfeit: true } : {}) } : {}),
      ...(product.kind === "til_pack" && recipient ? { beneficiary_id: recipient } : {}),
    };
    try {
      const order = await api.createOrder(body, idemKey.current);
      setRedirecting(true);
      if (!goToCheckout(order.checkout_url)) {
        setRedirecting(false);
        navigate(`/orders/${order.order_no}`);
      }
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "FORFEIT_CONFIRMATION_REQUIRED") {
          const d = e.details as { minutes_left?: unknown; days_left?: unknown };
          setForfeit({ minutes_left: Number(d.minutes_left ?? 0) || 0, days_left: Number(d.days_left ?? 0) || 0 });
          setStartMode("now");
          setConfirmForfeit(false);
        }
        if (e.code === "OFFER_VERSION_MISMATCH") onCatalogStale();
        setError(errorText(t, e.code));
      } else {
        setError(t("err.generic"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card buy"
      aria-labelledby="buy-title"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h1 id="buy-title" className="card__title">
        {t("buy.title")}: {product.title[lang]}
      </h1>

      <section className="buy__block" aria-label={t("buy.includes")}>
        <h2 className="block-title">{t("buy.includes")}</h2>
        {product.description && <p>{product.description[lang]}</p>}
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
        <p className="price price--big" data-testid="buy-price">
          {formatSum(product.price.tiyin, lang)}
        </p>
      </section>

      {product.kind === "til_pack" && me.learners.length > 0 && (
        <fieldset className="buy__block">
          <legend className="block-title">{t("buy.recipient")}</legend>
          {me.learners.map((l) => (
            <label key={l.learner_id} className="option">
              <input type="radio" name="recipient" value={l.learner_id} checked={recipient === l.learner_id} onChange={() => setRecipient(l.learner_id)} />
              <span>{l.kind === "self" ? t("buy.recipient.self") : l.display}</span>
            </label>
          ))}
        </fieldset>
      )}

      {isSub && (active || forfeit !== null) && (
        <fieldset className="buy__block">
          <legend className="block-title">{t("buy.start")}</legend>
          {active && sub.period && (
            <label className="option">
              <input type="radio" name="start" value="after_current" checked={startMode === "after_current"} onChange={() => setStartMode("after_current")} />
              <span>{t("buy.start.after", { date: formatDate(sub.period.ends_at, lang) })}</span>
            </label>
          )}
          <label className="option">
            <input type="radio" name="start" value="now" checked={startMode === "now"} onChange={() => setStartMode("now")} />
            <span>{t("buy.start.now")}</span>
          </label>
          {needsForfeit && (
            <div className="forfeit">
              <Notice tone="warn">{forfeitText}</Notice>
              <label className="option">
                <input type="checkbox" name="confirm_forfeit" checked={confirmForfeit} onChange={(e) => setConfirmForfeit(e.target.checked)} />
                <span>{t("buy.start.confirm")}</span>
              </label>
            </div>
          )}
        </fieldset>
      )}

      <fieldset className="buy__block">
        <legend className="block-title">{t("buy.provider")}</legend>
        <div className="providers">
          {catalog.providers.map((p) => (
            <label key={p} className={`provider${provider === p ? " provider--on" : ""}`}>
              <input type="radio" name="provider" value={p} checked={provider === p} onChange={() => setProvider(p)} />
              <span>{PROVIDER_NAMES[p]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="buy__block">
        <label className="option">
          <input type="checkbox" name="offer" checked={offer} onChange={(e) => setOffer(e.target.checked)} />
          <span>{t("buy.offer")}</span>
        </label>
        {offerUrl && (
          <a className="small" href={offerUrl} target="_blank" rel="noopener noreferrer">
            {t("buy.offer.read")} ↗
          </a>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      <button type="submit" className="btn btn--primary btn--wide" disabled={!canSubmit} aria-busy={busy || redirecting}>
        {redirecting ? t("buy.redirecting") : t("buy.pay", { amount: formatSum(product.price.tiyin, lang) })}
      </button>
      <p className="muted small">{t("buy.secure")}</p>
    </form>
  );
}
