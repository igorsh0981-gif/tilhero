import type { BillingCatalog, BillingProduct, GameSummary } from "@tilhero/contracts/bff";
import { useState } from "react";
import { canBuy, tilPacksOf } from "../../domain/billing";
import { children } from "../../domain/people";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { canOpenInvoice } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, HERO, Hero, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { BillingError, Notice, Stars } from "./parts";
import { PurchaseSheet } from "./purchase";

/**
 * «Купить тилы» (AT-93): packs of tils for Telegram Stars — for myself or for a child profile of my account (a parent
 * buys a child tils from the own profile). Tils are only for the game shop: they never change learning. A child profile
 * sees no prices and no buttons — tils are earned in lessons.
 */
export function TilShopScreen() {
  const { bff, nav, session } = useApp();
  const { t, tp, l } = useI18n();
  const kid = session.learner.kind === "child";
  const catalog = useLoad<BillingCatalog | null>(() => (kid ? Promise.resolve(null) : bff.billingCatalog()), [session.learner.learner_id]);
  const game = useLoad<GameSummary | null>(() => (kid ? Promise.resolve(null) : bff.gameSummary(true).catch(() => null)), [session.learner.learner_id]);
  const [buying, setBuying] = useState<BillingProduct | null>(null);
  const c = catalog.data;
  const packs = c ? tilPacksOf(c) : [];
  const recipients = [{ id: null, label: t("bill.buy.me") }, ...children(session).map((l) => ({ id: l.learner_id, label: l.display_name }))];

  return (
    <>
      <Bar title={t("bill.til.title")} onBack={nav.back} />
      <main className="scroll" data-testid="til-shop">
        {kid ? (
          <div className="pad">
            <div className="card stack tight hrow" data-testid="til-shop-kid">
              <Hero src={HERO.myatik} alt="" className="bill-kid-hero" />
              <p className="sub ink">{t("bill.til.kid")}</p>
            </div>
          </div>
        ) : !c ? (
          catalog.loading ? (
            <div className="pad"><Skeleton lines={3} /></div>
          ) : (
            <BillingError error={catalog.error} errorObj={catalog.errorObj} onRetry={() => void catalog.reload()} />
          )
        ) : (
          <div className="stack loose">
            <div className="pad">
              <div className="card stack tight">
                {game.data ? (
                  <p className="h3 bal-h" data-testid="til-balance">
                    <Icon name="coin" size={22} />
                    {t("bill.til.balance", { n: game.data.til_balance, w: tp("game.tilsWord", game.data.til_balance) })}
                  </p>
                ) : null}
                <p className="sub small">{t("bill.til.text")}</p>
              </div>
            </div>
            {!c.can_pay ? (
              <div className="pad"><Notice text={c.consent_required ? t("bill.consent") : t("bill.notPayer")} tone="warn" testId="til-not-payer" /></div>
            ) : !c.sales_enabled ? (
              <div className="pad"><Notice text={t("bill.salesOff")} tone="warn" testId="til-sales-off" /></div>
            ) : !canOpenInvoice() ? (
              <div className="pad"><Notice text={t("bill.updateTg")} tone="warn" testId="til-update-tg" /></div>
            ) : null}
            {canBuy(c) ? (
              packs.length ? (
                <ul className="pad stack tight" data-testid="til-packs">
                  {packs.map((p) => (
                    <li key={p.code} className="card hrow bill-pack" data-testid={`pack-${p.code}`}>
                      <span className="bill-pack-ic" aria-hidden="true"><Icon name="coin" size={26} /></span>
                      <b className="grow">{t("game.tilsN", { n: p.til ?? 0, w: tp("game.tilsWord", p.til ?? 0) })}</b>
                      <Btn
                        onClick={() => setBuying(p)}
                        data-testid={`pack-buy-${p.code}`}
                        aria-label={`${t("bill.til.title")}: ${t("game.tilsN", { n: p.til ?? 0, w: tp("game.tilsWord", p.til ?? 0) })}, ${t("bill.starsAria", { n: p.price.stars, w: tp("bill.starsWord", p.price.stars) })}`}
                      >
                        <Stars n={p.price.stars} testId={`pack-price-${p.code}`} />
                      </Btn>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="pad"><p className="sub" data-testid="til-none">{t("bill.til.none")}</p></div>
              )
            ) : null}
          </div>
        )}
      </main>
      {buying && c ? (
        <PurchaseSheet
          product={buying}
          catalog={c}
          sub={null}
          recipients={recipients}
          initialRecipient={null}
          onClose={() => {
            setBuying(null);
            void game.reload();
          }}
          onStale={() => void catalog.reload()}
          onSettled={(o) => {
            showToast(o.status === "fulfilled" ? t("bill.pay.doneTils", { what: l(o.product.title) }) : t("bill.pay.doneTilsSoon"));
            void game.reload();
          }}
        />
      ) : null}
    </>
  );
}
