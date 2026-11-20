/**
 * «Геймификация → Магазин» (ADM-GAME-05 LinguaFlow «Магазин предметов», AT-69): cosmetics only — a background of the
 * home screen and a hero frame (a picture or two colour tokens of the Mini App theme); the streak freeze is the one
 * consumable item, its price and stock come from the rules. A new item is a draft (game.manage, Idempotency-Key);
 * a draft changes freely, a published item — only the end of sale and the order; publication and retirement —
 * game.publish with step-up and a comment ≥ 10. Retirement never takes an item away from its owners (the column
 * «Владельцев»). Nothing in the shop can change a grade or the learning (the validator of gamification forbids it).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminGameImage, AdminShopItem, ShopItemStatus } from "@tilhero/contracts/admin";
import { Game } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, Pill, Seg, Select, Spinner } from "../../ui/kit";
import { ConfirmCommand, Drawer } from "../../ui/overlays";
import { errText } from "../../ui/errors";
import { useToast } from "../../ui/toasts";
import { CommandKey } from "../memory/model";
import { AudiencePicker, AudiencePills, GameImg, ImagePicker, ImageUpload, IssueMsg, LocFields } from "./parts";
import {
  ACCENT_TOKENS,
  BG_TOKENS,
  checkItem,
  COMMENT_MAX,
  COMMENT_MIN,
  CREATABLE_KINDS,
  emptyItemForm,
  fieldId,
  issuesAt,
  ITEM_DESC_MAX,
  ITEM_TITLE_MAX,
  itemBody,
  itemFormOf,
  itemPatch,
  onSale,
  MINIAPP_COLORS,
  PRICE_MAX,
  PRICE_MIN,
  serverIssues,
  SHOP_STATUSES,
  SHOP_TONE,
  zoneDateTime,
  type Issue,
  type ItemForm,
} from "./model";

export function ShopTab({ openId }: { openId: string | null }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const [items, setItems] = useState<AdminShopItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<ShopItemStatus | "">("");
  const load = useCallback(async () => {
    try {
      const r = await Game.items();
      setItems(r.items);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const now = Date.now();
  const rows = (items ?? []).filter((x) => !status || x.status === status).sort((a, b) => a.order - b.order || a.code.localeCompare(b.code));
  const item = openId && openId !== "new" ? (items?.find((x) => x.code === openId) ?? null) : null;
  return (
    <div className="stack" data-testid="shop">
      <div className="toolbar">
        <Seg<ShopItemStatus | ""> label={t("col.status")} value={status} onChange={setStatus} testId="sh-status" items={[{ v: "", label: t("common.all"), cnt: items?.length ?? null }, ...SHOP_STATUSES.map((s) => ({ v: s, label: t(`shs.${s}` as MessageKey), cnt: items ? items.filter((x) => x.status === s).length : null }))]} />
        <span className="grow" />
        {can("game.manage") ? <Btn kind="primary" icon="plus" label={t("sh.new")} onClick={() => navigate("game", "shop/new")} testId="sh-new" /> : <span className="xs muted row" data-testid="sh-ro"><Icon name="lock" /> {t("gm.noManage")}</span>}
      </div>
      <Callout icon="shield" testId="sh-note">
        {t("sh.note")}
      </Callout>
      {error && !items ? (
        <LoadError error={error} onRetry={() => void load()} />
      ) : !items ? (
        <Spinner label={t("common.loading")} />
      ) : rows.length ? (
        <section className="panel">
          <div className="table-wrap">
            <table className="tbl" data-testid="sh-rows">
              <caption className="sr-only">{t("gtab.shop")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("sh.col.item")}</th>
                  <th scope="col">{t("sh.col.kind")}</th>
                  <th scope="col" className="r">
                    {t("sh.col.price")}
                  </th>
                  <th scope="col">{t("gm.audiences")}</th>
                  <th scope="col">{t("sh.col.sale")}</th>
                  <th scope="col">{t("col.status")}</th>
                  <th scope="col" className="r">
                    {t("sh.col.owners")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.code} className={cx(openId === x.code && "is-sel")} data-testid={`sh-row-${x.code}`} data-status={x.status}>
                    <td>
                      <span className="row nowrap-row">
                        <ItemLook item={x} size={44} />
                        <span>
                          <button type="button" className="tr" lang="ru" onClick={() => navigate("game", `shop/${x.code}`)} data-testid={`sh-open-${x.code}`}>
                            {x.title.ru}
                          </button>
                          <span className="mono xs muted block">{x.code}</span>
                        </span>
                      </span>
                    </td>
                    <td className="small">{t(`shk.${x.kind}` as MessageKey)}</td>
                    <td className="r num">{fmt.num(x.price_til)}</td>
                    <td>
                      <AudiencePills value={x.audiences} />
                    </td>
                    <td className="small">
                      {onSale(x, now) ? <Pill tone="good">{t("sh.onSale")}</Pill> : <Pill tone="neutral">{t("sh.offSale")}</Pill>}
                      {(x.available_from || x.available_until) && <span className="xs muted block">{saleWindow(t, (iso) => zoneDateTime(fmt.locale, iso), x)}</span>}
                    </td>
                    <td>
                      <Pill tone={SHOP_TONE[x.status]}>{t(`shs.${x.status}` as MessageKey)}</Pill>
                    </td>
                    <td className="r num" data-testid={`sh-owners-${x.code}`}>
                      {fmt.num(x.owners)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <Empty icon="inbox" title={t("sh.none")} text={status ? t("common.changeFilters") : t("sh.noneM")} />
      )}
      {openId === "new" && can("game.manage") && <ItemDrawer key="new" item={null} items={items ?? []} onClose={() => navigate("game", "shop")} onSaved={(x) => (setItems((xs) => [...(xs ?? []).filter((y) => y.code !== x.code), x]), navigate("game", `shop/${x.code}`))} />}
      {item && <ItemDrawer key={item.code} item={item} items={items ?? []} onClose={() => navigate("game", "shop")} onSaved={(x) => setItems((xs) => (xs ?? []).map((y) => (y.code === x.code ? x : y)))} />}
    </div>
  );
}

/** the sale window on the Tashkent clock */
function saleWindow(t: (k: MessageKey, v?: Record<string, string | number>) => string, at: (iso: string | null) => string, x: Pick<AdminShopItem, "available_from" | "available_until">) {
  if (x.available_from && x.available_until) return t("sh.window", { a: at(x.available_from), b: at(x.available_until) });
  if (x.available_from) return t("sh.from", { a: at(x.available_from) });
  return t("sh.until", { b: at(x.available_until) });
}

/** The look of an item: its picture, or the two theme tokens as a swatch in the colours of the Mini App theme. */
function ItemLook({ item, size }: { item: Pick<AdminShopItem, "image" | "theme" | "kind" | "title">; size: number }) {
  const { t } = useI18n();
  if (item.kind === "streak_freeze")
    return (
      <span className="g-img is-empty" style={{ width: size, height: size }} role="img" aria-label={t("shk.streak_freeze")}>
        <Icon name="clock" />
      </span>
    );
  if (item.image) return <GameImg img={item.image} alt={item.title.ru} size={size} />;
  if (item.theme) return <ThemeSwatch bg={item.theme.bg} accent={item.theme.accent} size={size} />;
  return <GameImg img={null} alt="" size={size} />;
}

function ThemeSwatch({ bg, accent, size, testId }: { bg: string; accent: string; size: number; testId?: string }) {
  const { t } = useI18n();
  const b = MINIAPP_COLORS[bg] ?? "transparent";
  const a = MINIAPP_COLORS[accent] ?? "transparent";
  return (
    <span className="g-swatch" style={{ width: size, height: size, background: b, borderColor: a }} role="img" aria-label={t("sh.swatch", { bg, accent })} data-bg={b} data-accent={a} data-testid={testId}>
      <span style={{ background: a }} />
    </span>
  );
}

function ItemDrawer({ item, items, onClose, onSaved }: { item: AdminShopItem | null; items: AdminShopItem[]; onClose: () => void; onSaved: (x: AdminShopItem) => void }) {
  const i18n = useI18n();
  const { t, fmt, tp } = i18n;
  const { can } = useSession();
  const { navigate } = useNav();
  const toast = useToast();
  const [x, setX] = useState<AdminShopItem | null>(item);
  const [form, setForm] = useState<ItemForm>(() => (item ? itemFormOf(item) : emptyItemForm()));
  const [base, setBase] = useState<ItemForm>(() => (item ? itemFormOf(item) : emptyItemForm()));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState(false);
  const [ask, setAsk] = useState<"publish" | "retire" | null>(null);
  const [extra, setExtra] = useState<AdminGameImage[]>([]);
  const [createKey] = useState(() => new CommandKey(uuid));
  const [cmdKey] = useState(() => new CommandKey(uuid));
  const [srv, setSrv] = useState<Issue[]>([]);
  const freeze = x?.kind === "streak_freeze";
  const mode: "create" | "draft" | "published" | "retired" = !x ? "create" : x.status === "draft" ? "draft" : x.status === "published" ? "published" : "retired";
  const manage = can("game.manage") && !freeze && mode !== "retired";
  const full = manage && (mode === "create" || mode === "draft");
  const issues = mode === "retired" || freeze ? [] : checkItem(form, mode === "create" ? "create" : mode === "draft" ? "draft" : "published");
  // problems of 422 ITEM_INVALID {errors} stay at their fields until the form changes
  const shown = [...(tried ? issues : issues.filter((i) => i.code !== "required" && i.code !== "code_format")), ...srv];
  const edit = (f: ItemForm) => {
    setForm(f);
    setSrv([]);
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  const images = useMemo(() => {
    const m = new Map<string, AdminGameImage>();
    for (const y of items) if (y.image) m.set(y.image.asset_id, y.image);
    for (const im of extra) m.set(im.asset_id, im);
    return m;
  }, [items, extra]);
  const curImg = form.asset_id ? (images.get(form.asset_id) ?? null) : null;

  const save = async () => {
    if (busy) return;
    setTried(true);
    if (issues.length) {
      setErr(t("gm.fixErrors", { n: issues.length }));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      let y: AdminShopItem;
      if (!x) {
        const body = itemBody(form);
        y = await Game.createItem(body, createKey.for(JSON.stringify(body)));
        createKey.settle();
        toast(t("sh.created", { c: y.code }), "ok", "game.shop_item_created");
      } else {
        const patch = itemPatch(x, form);
        if (!patch) {
          setBase(form);
          return;
        }
        y = await Game.patchItem(x.code, patch);
        toast(t("sh.saved", { c: y.code }), "ok", "game.shop_item_updated");
      }
      setX(y);
      const f = itemFormOf(y);
      setForm(f);
      setBase(f);
      setTried(false);
      onSaved(y);
    } catch (e) {
      if (!x) createKey.settle(e);
      if (e instanceof ApiError) setSrv(serverIssues(e.details));
      setErr(errText(i18n, e));
    } finally {
      setBusy(false);
    }
  };

  const ownersText = x ? tp("sh.ownersN", x.owners).replace(String(x.owners), fmt.num(x.owners)) : "";
  return (
    <Drawer
      wide
      testId="sh-item"
      onClose={onClose}
      title={x ? <span lang="ru">{x.title.ru}</span> : t("sh.new")}
      sub={
        x && (
          <>
            <span className="mono">{x.code}</span>
            <span>{t(`shk.${x.kind}` as MessageKey)}</span>
            <Pill tone={SHOP_TONE[x.status]} testId="sh-item-status">
              {t(`shs.${x.status}` as MessageKey)}
            </Pill>
            <Pill tone={x.owners ? "accent" : "neutral"} testId="sh-item-owners">
              {ownersText}
            </Pill>
            {dirty && <Pill tone="warn">{t("ct.unsaved")}</Pill>}
          </>
        )
      }
      footer={
        <>
          <span className="grow" />
          {manage && <Btn icon="check" kind={dirty || !x ? "primary" : ""} label={x ? t("common.save") : t("sh.createDraft")} disabled={!!x && !dirty} busy={busy} onClick={() => void save()} testId="sh-save" />}
          {x && !freeze && can("game.publish") && x.status === "draft" && <Btn icon="send" label={t("sh.publish")} disabled={dirty} title={dirty ? t("gr.gate.unsaved") : undefined} onClick={() => setAsk("publish")} testId="sh-publish" />}
          {x && !freeze && can("game.publish") && x.status === "published" && <Btn icon="stop" kind="danger-ghost" label={t("sh.retire")} onClick={() => setAsk("retire")} testId="sh-retire" />}
        </>
      }
    >
      <div className="stack" data-testid="sh-form" data-mode={mode}>
        {freeze ? (
          <Callout icon="info" testId="sh-freeze-note">
            {t("sh.freezeNote", { p: fmt.num(x!.price_til) })}{" "}
            <Btn size="xs" icon="sliders" label={t("sh.toRules")} onClick={() => navigate("game", "rules")} />
          </Callout>
        ) : mode === "retired" ? (
          <Callout icon="lock" testId="sh-retired-note">
            {t("sh.retiredNote", { n: x!.owners })}
          </Callout>
        ) : mode === "published" ? (
          <Callout icon="info" testId="sh-published-note">
            {t("sh.publishedNote")}
          </Callout>
        ) : null}
        {!can("game.manage") && !freeze && (
          <Callout icon="lock" testId="sh-item-ro">
            {t("gm.roManage")}
          </Callout>
        )}
        {err && (
          <Callout kind="bad" icon="alertCircle" testId="sh-err">
            {err}
          </Callout>
        )}
        <div className="form-grid">
          <div className="field">
            <label htmlFor={fieldId("sh", "code")} className="req">
              {t("sh.f.code")}
            </label>
            <input id={fieldId("sh", "code")} className={cx("input mono", issuesAt(shown, "code").length > 0 && "is-invalid")} value={form.code} disabled={!!x} spellCheck={false} onChange={(e) => edit({ ...form, code: e.target.value.toLowerCase() })} aria-describedby={`${fieldId("sh", "code")}-h`} data-testid="sh-code" />
            <span className="hint" id={`${fieldId("sh", "code")}-h`}>
              {t("gm.codeHint")}
            </span>
            <IssueMsg issues={issuesAt(shown, "code")} />
          </div>
          <div className="field">
            <label htmlFor="sh-kind">{t("sh.f.kind")}</label>
            <Select<string> id="sh-kind" label={t("sh.f.kind")} value={freeze ? "streak_freeze" : form.kind} disabled={!full} onChange={(v) => edit({ ...form, kind: v as ItemForm["kind"] })} options={(freeze ? ["streak_freeze"] : CREATABLE_KINDS).map((k) => ({ v: k, label: t(`shk.${k}` as MessageKey) }))} testId="sh-kind" />
            <span className="hint">{t("sh.kindHint")}</span>
          </div>
        </div>
        <LocFields prefix="sh" path="title" label={t("sh.f.title")} value={form.title} onChange={(v) => edit({ ...form, title: v })} max={ITEM_TITLE_MAX} issues={shown} disabled={!full} testId="sh-title" />
        <LocFields prefix="sh" path="description" label={t("sh.f.description")} value={form.description} onChange={(v) => edit({ ...form, description: v })} max={ITEM_DESC_MAX} issues={shown} disabled={!full} area testId="sh-desc" />
        {!freeze && (
          <section className="stack sm" aria-labelledby="sh-look-h" data-testid="sh-look">
            <h3 className="h3" id="sh-look-h">
              {t("sh.look")}
            </h3>
            <Seg<ItemForm["look"]> label={t("sh.look")} value={form.look} onChange={(v) => full && edit({ ...form, look: v })} items={[{ v: "theme", label: t("sh.look.theme") }, { v: "image", label: t("sh.look.image") }]} testId="sh-look-seg" />
            {form.look === "image" ? (
              <div className="row" id={fieldId("sh", "asset_id")}>
                <GameImg img={curImg} alt={form.title.ru || t("sh.look.image")} size={120} testId="sh-img" />
                {full && (
                  <span className="stack sm">
                    <ImageUpload purpose="shop_item" aria={t("sh.uploadImg")} testId="sh-upload" onDone={(im) => (setExtra((xs) => [...xs, im]), setSrv([]), setForm((f) => ({ ...f, asset_id: im.asset_id })))} />
                    <Btn size="sm" icon="image" label={t("gm.pick")} aria={t("sh.pickImg")} onClick={() => setPick(true)} testId="sh-pick" />
                  </span>
                )}
                <IssueMsg issues={issuesAt(shown, "asset_id")} />
              </div>
            ) : (
              <div className="row" id={fieldId("sh", "theme")}>
                <ThemeSwatch bg={form.bg} accent={form.accent} size={64} testId="sh-swatch" />
                <div className="field">
                  <label htmlFor="sh-bg">{t("sh.f.bg")}</label>
                  <Select<string> id="sh-bg" label={t("sh.f.bg")} value={form.bg} disabled={!full} onChange={(v) => edit({ ...form, bg: v })} options={[...(BG_TOKENS as readonly string[]).includes(form.bg) ? [] : [{ v: form.bg, label: form.bg, disabled: true }], ...BG_TOKENS.map((k) => ({ v: k, label: k }))]} className="mono" testId="sh-bg" />
                  <IssueMsg issues={issuesAt(shown, "theme.bg")} />
                </div>
                <div className="field">
                  <label htmlFor="sh-accent">{t("sh.f.accent")}</label>
                  <Select<string> id="sh-accent" label={t("sh.f.accent")} value={form.accent} disabled={!full} onChange={(v) => edit({ ...form, accent: v })} options={[...(ACCENT_TOKENS as readonly string[]).includes(form.accent) ? [] : [{ v: form.accent, label: form.accent, disabled: true }], ...ACCENT_TOKENS.map((k) => ({ v: k, label: k }))]} className="mono" testId="sh-accent" />
                  <IssueMsg issues={issuesAt(shown, "theme.accent")} />
                </div>
                <span className="xs muted">{t("sh.tokensHint")}</span>
              </div>
            )}
          </section>
        )}
        <div className="form-grid">
          <div className="field">
            <label htmlFor={fieldId("sh", "price_til")} className="req">
              {t("sh.f.price")}
            </label>
            <input id={fieldId("sh", "price_til")} className={cx("input num-in", issuesAt(shown, "price_til").length > 0 && "is-invalid")} inputMode="numeric" value={freeze ? String(x!.price_til) : form.price} disabled={!full} onChange={(e) => edit({ ...form, price: e.target.value })} data-testid="sh-price" />
            <span className="hint">{t("sh.priceHint", { a: PRICE_MIN, b: fmt.num(PRICE_MAX) })}</span>
            <IssueMsg issues={issuesAt(shown, "price_til")} />
          </div>
          <div className="field">
            <label htmlFor={fieldId("sh", "order")}>{t("sh.f.order")}</label>
            <input id={fieldId("sh", "order")} className={cx("input num-in", issuesAt(shown, "order").length > 0 && "is-invalid")} inputMode="numeric" value={form.order} disabled={!manage} onChange={(e) => edit({ ...form, order: e.target.value })} data-testid="sh-order" />
            <IssueMsg issues={issuesAt(shown, "order")} />
          </div>
          <div className="field">
            <label htmlFor={fieldId("sh", "available_from")}>{t("sh.f.from")}</label>
            <input id={fieldId("sh", "available_from")} type="datetime-local" className="input" value={form.from} disabled={!full} onChange={(e) => edit({ ...form, from: e.target.value })} aria-describedby="sh-tz" data-testid="sh-from" />
            <span className="hint" id="sh-tz">
              {t("gm.tzNote")}
            </span>
            <IssueMsg issues={issuesAt(shown, "available_from")} />
          </div>
          <div className="field">
            <label htmlFor={fieldId("sh", "available_until")}>{t("sh.f.until")}</label>
            <input id={fieldId("sh", "available_until")} type="datetime-local" className={cx("input", issuesAt(shown, "available_until").length > 0 && "is-invalid")} value={form.until} disabled={!manage} onChange={(e) => edit({ ...form, until: e.target.value })} data-testid="sh-until" />
            <span className="hint">{t("sh.windowHint")}</span>
            <IssueMsg issues={issuesAt(shown, "available_until")} />
          </div>
        </div>
        {!freeze && <AudiencePicker id={fieldId("sh", "audiences")} value={form.audiences} onChange={(a) => edit({ ...form, audiences: a })} disabled={!full} issues={issuesAt(shown, "audiences")} hint={t("sh.audHint")} />}
        {x && (
          <p className="xs muted row">
            <Icon name="clock" /> {t("sh.updatedAt", { t: fmt.dateTime(x.updated_at) })}
          </p>
        )}
      </div>
      {pick && (
        <ImagePicker
          title={t("sh.pickT")}
          images={[...images.values()]}
          current={form.asset_id}
          labelOf={(im) => items.find((y) => y.image?.asset_id === im.asset_id)?.code ?? t("gm.uploadedHere")}
          onClose={() => setPick(false)}
          onPick={(im) => (edit({ ...form, asset_id: im.asset_id }), setPick(false))}
          testId="sh-picker"
        />
      )}
      {ask && x && (
        <ConfirmCommand
          title={t(ask === "publish" ? "sh.publishT" : "sh.retireT", { n: x.title.ru })}
          text={ask === "publish" ? t("sh.publishM", { p: fmt.num(x.price_til) }) : t("sh.retireM", { n: x.owners })}
          icon={ask === "publish" ? "send" : "stop"}
          tone={ask === "retire" ? "bad" : "warn"}
          ok={t(ask === "publish" ? "sh.publish" : "sh.retire")}
          okKind={ask === "retire" ? "danger" : "primary"}
          minReason={COMMENT_MIN}
          maxReason={COMMENT_MAX}
          reasonLabel={t("gm.comment")}
          reasonPlaceholder={t("gm.commentPh")}
          testId="sh-cmd-dialog"
          extra={
            <Callout kind="info" icon="smartphoneKey">
              {t("ct.stepUpNote")}
            </Callout>
          }
          onClose={() => setAsk(null)}
          onConfirm={async (c) => {
            const key = cmdKey.for(JSON.stringify([ask, x.code, c]));
            try {
              const y = ask === "publish" ? await Game.publishItem(x.code, c, key) : await Game.retireItem(x.code, c, key);
              cmdKey.settle();
              setX(y);
              const f = itemFormOf(y);
              setForm(f);
              setBase(f);
              onSaved(y);
              toast(t(ask === "publish" ? "sh.published" : "sh.retired", { c: y.code }), "ok", ask === "publish" ? "game.shop_item_published" : "game.shop_item_retired");
              return null;
            } catch (e) {
              cmdKey.settle(e);
              if ((e as ApiError)?.cancelled) return t("stepup.cancelled");
              return errText(i18n, e);
            }
          }}
        />
      )}
    </Drawer>
  );
}
