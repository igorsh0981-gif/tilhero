import type { GameSummary, ShopItemKind, ShopItemView } from "@tilhero/contracts/bff";
import { useRef, useState } from "react";
import { newIdempotencyKey } from "../../api/client";
import { ApiError, errorText } from "../../api/errors";
import { equippedCodes, keepPurchaseKey, missingTils, PurchaseKeys, purchaseProblem, shortageText, themeVars, type PurchaseProblem, type ShopResponse } from "../../domain/game";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { confirmPopup, haptic } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Pill, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { AssetImg, FreezeChip, GameError } from "./parts";

const SECTIONS: readonly ShopItemKind[] = ["streak_freeze", "background", "hero_frame"];

/**
 * The shop (APP-GAME-05, AT-67, AT-69): cosmetics (backgrounds of Home, hero frames) and the streak freeze, for tils only.
 * Prices, «Куплено», «Надето», the stock of freezes «N из max». A purchase is one server transaction with an
 * Idempotency-Key: a lost answer is repeated with the same key (no second charge), the client never changes the balance
 * itself. Not enough tils — «Не хватает N тилов. Заработайте их в уроках» and, sprint 8, «Купить тилы» for Telegram Stars
 * when the server says a pack can be bought (GameSummary.purchase_available / INSUFFICIENT_TILS.purchase_available);
 * a child profile never sees it (tils for a child — only through a parent).
 */
export function ShopScreen() {
  const { bff, nav, session } = useApp();
  const { t, tp, l, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const shop = useLoad<ShopResponse>(() => bff.gameShop(), [session.learner.learner_id]);
  // sprint 8: «Купить тилы» for Stars — the server decides (sales on, the right to pay, a pack with a Stars price)
  const summary = useLoad<GameSummary | null>(() => (kid ? Promise.resolve(null) : bff.gameSummary(true).catch(() => null)), [session.learner.learner_id]);
  const [tilsForSale, setTilsForSale] = useState<boolean | null>(null);
  const buyTils = !kid && (tilsForSale ?? summary.data?.purchase_available ?? false);
  const toTilShop = () => nav.push({ name: "tilShop" });
  const keys = useRef(new PurchaseKeys(newIdempotencyKey));
  // synchronous lock: a second tap before React re-renders (or while the confirmation is open) does nothing
  const lock = useRef<string | null>(null);
  const [pending, setPending] = useState<{ code: string; phase: "confirm" | "send" } | null>(null);
  const [problems, setProblems] = useState<Record<string, PurchaseProblem>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const data = shop.data;

  const note = (code: string, p: PurchaseProblem | null, err: string | null) => {
    setProblems((prev) => {
      const next = { ...prev };
      if (p) next[code] = p;
      else delete next[code];
      return next;
    });
    setErrors((prev) => {
      const next = { ...prev };
      if (err) next[code] = err;
      else delete next[code];
      return next;
    });
  };

  const buy = async (item: ShopItemView) => {
    if (!data || lock.current) return;
    lock.current = item.code;
    // the key of this purchase: made at the first tap, kept until the outcome is known (a lost answer repeats it)
    const key = keys.current.get(item.code);
    setPending({ code: item.code, phase: "confirm" });
    note(item.code, null, null);
    try {
      const ok = await confirmPopup({
        title: t("game.shop.confirmTitle", { item: l(item.title) }),
        message: t("game.shop.confirmText", { n: item.price_til, w: tp("game.tilsWord", item.price_til) }),
        ok: t("game.shop.confirmOk"),
        cancel: t("c.cancel"),
      });
      if (!ok) return;
      setPending({ code: item.code, phase: "send" });
      try {
        const r = await bff.purchase(item.code, key);
        keys.current.drop(item.code);
        haptic.notify("success");
        showToast(item.kind === "streak_freeze" ? t("game.shop.boughtFreeze", { n: r.freeze_stock, max: data.freeze_max }) : t("game.shop.bought", { item: l(item.title) }));
        shop.setData((prev) => (prev ? { ...prev, til_balance: r.til_balance, freeze_stock: r.freeze_stock } : prev));
        void shop.reload();
      } catch (e) {
        if (keepPurchaseKey(e)) {
          // the outcome is unknown (network, 5xx): the purchase may have gone through — show the shelf and the balance as
          // they are now; a retry carries the same key and gets the same answer, never a second charge
          note(item.code, null, errorText(e, t, fmt.mmss));
          void shop.reload();
          return;
        }
        keys.current.drop(item.code);
        if (e instanceof ApiError && e.code === "INSUFFICIENT_TILS" && typeof e.details.purchase_available === "boolean") setTilsForSale(e.details.purchase_available);
        const p = purchaseProblem(e, item.price_til, data.til_balance);
        if (p.kind === "other") note(item.code, null, errorText(e, t, fmt.mmss));
        else {
          note(item.code, p, null);
          // the shelf changed on the server (balance, stock, the item went away): show it as it is now
          void shop.reload();
        }
      }
    } finally {
      lock.current = null;
      setPending(null);
    }
  };

  const equip = async (item: ShopItemView) => {
    if (!data || lock.current) return;
    lock.current = item.code;
    const slot = item.kind === "background" ? "background_code" : "frame_code";
    const body = { ...equippedCodes(data.items), [slot]: item.equipped ? null : item.code };
    setPending({ code: item.code, phase: "send" });
    note(item.code, null, null);
    try {
      await bff.setEquipment(body);
      haptic.selection();
      showToast(t(item.equipped ? "game.shop.unequippedToast" : "game.shop.equippedToast", { item: l(item.title) }));
      await shop.reload();
    } catch (e) {
      note(item.code, null, errorText(e, t, fmt.mmss));
    } finally {
      lock.current = null;
      setPending(null);
    }
  };

  return (
    <>
      <Bar title={t("game.shop.title")} onBack={nav.back} />
      <main className="scroll" data-testid="shop">
        {!data ? (
          shop.loading ? (
            <div className="pad"><Skeleton lines={4} /></div>
          ) : (
            <GameError error={shop.error} errorObj={shop.errorObj} onRetry={() => void shop.reload()} />
          )
        ) : (
          <div className="stack loose">
            <div className="pad">
              <div className="card stack tight" data-testid="shop-balance">
                <p className="h2 bal-h" data-testid="shop-tils">
                  <Icon name="coin" size={24} />
                  {t(kid ? "game.shop.balanceKid" : "game.shop.balance", { n: data.til_balance, w: tp("game.tilsWord", data.til_balance) })}
                </p>
                <div className="bal">
                  <FreezeChip n={data.freeze_stock} max={data.freeze_max} testId="shop-freezes" />
                </div>
                <p className="sub small">{kid ? t("game.shop.earnKid") : t("game.shop.earn")}</p>
                <p className="sub small">{t("game.shop.noLearn")}</p>
                {buyTils ? (
                  <Btn variant="secondary" onClick={toTilShop} data-testid="shop-buy-tils">
                    <Icon name="coin" size={18} />
                    {t("game.buyTils")}
                  </Btn>
                ) : null}
              </div>
            </div>
            {data.items.length === 0 ? (
              <div className="pad"><p className="sub">{t("game.shop.empty")}</p></div>
            ) : null}
            {SECTIONS.map((kind) => {
              const items = data.items.filter((i) => i.kind === kind);
              if (!items.length) return null;
              return (
                <section key={kind} className="pad stack tight" aria-labelledby={`shop-sec-${kind}`}>
                  <h2 className="sec" id={`shop-sec-${kind}`}>{t(`game.shop.sec.${kind}` as MessageKey)}</h2>
                  {kind === "streak_freeze" ? <p className="sub small">{kid ? t("game.shop.freezeHowKid") : t("game.shop.freezeHow")}</p> : null}
                  <ul className="stack tight" data-testid={`shop-sec-${kind}`}>
                    {items.map((item) => (
                      <ShopItem
                        key={item.code}
                        item={item}
                        shop={data}
                        kid={kid}
                        busy={pending?.code === item.code && pending.phase === "send"}
                        locked={!!pending}
                        problem={problems[item.code] ?? null}
                        error={errors[item.code] ?? null}
                        onBuy={() => void buy(item)}
                        onEquip={() => void equip(item)}
                        onGetTils={buyTils ? toTilShop : null}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}

function ShopItem(props: {
  item: ShopItemView;
  shop: ShopResponse;
  kid: boolean;
  busy: boolean;
  locked: boolean;
  problem: PurchaseProblem | null;
  error: string | null;
  onBuy: () => void;
  onEquip: () => void;
  /** sprint 8: not enough tils and a pack can be bought for Stars */
  onGetTils: (() => void) | null;
}) {
  const { item, shop, kid, problem } = props;
  const { t, tp, l, fmt } = useI18n();
  const freeze = item.kind === "streak_freeze";
  const price = { n: item.price_til, w: tp("game.tilsWord", item.price_til) };
  // why it cannot be bought: the server's reason, or what the last attempt answered (409 with details)
  const short = problem?.kind === "short" ? problem.missing : item.reason_unavailable === "not_enough_tils" ? missingTils(item.price_til, shop.til_balance) : 0;
  const full = problem?.kind === "full" || (freeze && item.reason_unavailable === "freeze_full");
  const noteId = `shop-note-${item.code}`;
  const why = short > 0 ? shortageText(t, tp, short, kid) : full ? t("game.shop.full", { max: problem?.kind === "full" && problem.max != null ? problem.max : shop.freeze_max }) : problem?.kind === "gone" ? t("game.shop.gone") : null;
  return (
    <li className="card shop-item" data-testid={`shop-${item.code}`} data-owned={item.owned} data-equipped={item.equipped}>
      <div className="shop-vis" style={themeVars(item.theme)} aria-hidden="true">
        <AssetImg image={item.image} fallback={freeze ? <Icon name="snow" size={30} /> : item.kind === "hero_frame" ? <Icon name="hero" size={30} /> : null} testId={`shop-img-${item.code}`} />
      </div>
      <div className="grow">
        <b>{l(item.title)}</b>
        {l(item.description) ? <p className="sub small">{l(item.description)}</p> : null}
        <div className="pills">
          <Pill tone="mute"><Icon name="coin" size={14} />{t("game.shop.price", price)}</Pill>
          {item.owned ? <Pill tone="ok"><Icon name="check" size={14} stroke={3} />{t("game.shop.owned")}</Pill> : null}
          {item.equipped ? <Pill><Icon name="star" size={12} />{t("game.shop.equipped")}</Pill> : null}
          {freeze ? <Pill tone="mute"><Icon name="snow" size={14} />{t("game.shop.stock", { n: shop.freeze_stock, max: shop.freeze_max })}</Pill> : null}
          {item.available_until && !item.owned ? <Pill tone="mute">{t("game.shop.until", { date: fmt.date(item.available_until) })}</Pill> : null}
        </div>
        {why ? (
          <p className="sub small ink notice" id={noteId} role="note" data-testid={`shop-why-${item.code}`}>
            <Icon name="info" size={16} />
            {why}
          </p>
        ) : null}
        {short > 0 && props.onGetTils ? (
          <Btn variant="link" onClick={props.onGetTils} data-testid={`shop-get-tils-${item.code}`}>
            <Icon name="coin" size={16} />
            {t("game.buyTils")}
          </Btn>
        ) : null}
        <ErrorLine text={props.error} />
        <div className="shop-acts">
          {item.owned && !freeze ? (
            <Btn variant="secondary" busy={props.busy} disabled={props.locked} onClick={props.onEquip} data-testid={`shop-equip-${item.code}`} aria-pressed={item.equipped}>
              {item.equipped ? t("game.shop.unequip") : t("game.shop.equip")}
            </Btn>
          ) : (
            <Btn
              variant={item.can_buy ? "primary" : "secondary"}
              busy={props.busy}
              disabled={!item.can_buy || props.locked || short > 0 || full}
              aria-describedby={why ? noteId : undefined}
              onClick={props.onBuy}
              data-testid={`shop-buy-${item.code}`}
            >
              {t("game.shop.buy", price)}
            </Btn>
          )}
        </div>
      </div>
    </li>
  );
}
