import type { Watch as WatchT } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatEventDates, formatFetched } from "../../events/format";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { haptic, openExternal } from "../../tg";
import { EventMediaView } from "../../ui/EventCard";
import { Icon } from "../../ui/Icon";
import { Badge, Spinner } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import {
  changeFlap,
  changeSign,
  changeSource,
  criticalKeysOfWatches,
  isCritical,
  mergeWatches,
  signedUsd,
  sortWatches,
  untilLabel,
  usd,
  watchBadge,
  watchStats,
} from "../../watch/logic";
import { watchStore } from "../../watch/store";
import { WatchSheet } from "./WatchSheet";

/**
 * Watch tab (prototype v9 SCREENS.watch, TG-FR-030/032): numbers (active, critical, until the next check), the banner
 * of a critical change, watch cards with their status, «было → сейчас» of the trip price per person and the delta;
 * a card opens the watch sheet. Empty — what Watch does and a way to the catalogue.
 * Review fixes: pages of ≤ 20 by cursor («Показать ещё»); a cancellation within 7 days stays critical even though its
 * watch ended; «Что делать?» opens the decision sheet of prototype v9 (keep watching / remove, the source).
 */
const UNIT: Record<"min" | "h" | "d", MessageKey> = {
  min: "w.unit.min",
  h: "w.unit.h",
  d: "w.unit.d",
};
const PRICE_TYPES = new Set(["price_drop", "price_rise"]);

function WatchCard({ w, onOpen }: { w: WatchT; onOpen: () => void }) {
  const { t, lang } = useI18n();
  const badge = watchBadge(w);
  const ev = w.event;
  const c = w.last_change;
  const now = usd(w.last_snapshot?.per_person_usd, lang);
  const priceChange = c && PRICE_TYPES.has(c.type) ? c : null;
  const was = priceChange ? usd(priceChange.before, lang) : "";
  const flap = c ? changeFlap(c, lang) : null;
  const dates = ev ? formatEventDates(ev.start, ev.end, lang) : "";
  const since = t("w.since", {
    d: formatFetched(w.created_at, lang).split(" ")[0] ?? "",
  });
  return (
    <button
      className={[
        "wc",
        isCritical(w) ? "crit-c" : "",
        w.status !== "active" && !isCritical(w) ? "dim" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      type="button"
      data-testid="watch-card"
      data-watch-id={w.watch_id}
      data-status={w.status}
      onClick={onOpen}
    >
      <div className="wc-h">
        {ev ? (
          <EventMediaView event={ev} className="wc-th" chip="none" />
        ) : (
          <div className="media fb wc-th" aria-hidden="true" />
        )}
        <div className="wc-t">
          <b>{w.event_title}</b>
          <small>{[dates, since].filter(Boolean).join(" · ")}</small>
        </div>
        <Badge tone={badge.tone} live={badge.live}>
          <span data-testid="watch-badge">{t(badge.key)}</span>
        </Badge>
      </div>
      {(now || flap || w.status !== "ended") && ( // a finished watch without a price has nothing to show here
        <div className="wc-board">
          <div>
            <small>
              {now
                ? t("w.trip", { tier: t(`tr.tier.${w.tier}` as MessageKey) })
                : t("w.d.price")}
            </small>
            {now ? (
              <div
                className="vals"
                aria-label={
                  was ? t("w.trip.vals", { from: was, to: now }) : undefined
                }
                data-testid="watch-vals"
              >
                {was && (
                  <>
                    <s>{was}</s>
                    <Icon name="chevR" size={14} />
                  </>
                )}
                <span>{now}</span>
                <small className="pp">{t("w.pp")}</small>
              </div>
            ) : (
              <p className="wc-none">{t("w.trip.none")}</p>
            )}
          </div>
          {flap && c && (
            <span
              className={`flap ${flap.tone}`}
              data-testid="watch-delta"
              title={changeSource(c)}
            >
              {priceChange
                ? signedUsd(
                    priceChange.delta_usd,
                    lang,
                    changeSign(priceChange),
                  ) || flap.text
                : flap.text || t(flap.key as MessageKey)}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

export function Watch() {
  const { api, navigate } = useApp();
  const { t, tp, lang } = useI18n();
  const errText = useErrorText();
  const [list, setList] = useState<WatchT[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [open, setOpen] = useState<WatchT | null>(null);
  const [crit, setCrit] = useState<WatchT | null>(null);
  const [n, setN] = useState(0);
  const gen = useRef(0);

  const publish = useCallback((items: WatchT[]) => {
    const keys = criticalKeysOfWatches(items);
    watchStore.setCritical(keys);
    watchStore.ack(keys); // the user sees them here — the tab bar badge goes away
    for (const w of items)
      watchStore.set(
        w.event_id,
        w.status === "ended"
          ? null
          : { watch_id: w.watch_id, status: w.status },
      );
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const g = ++gen.current;
    setErr(null);
    api.watches.list(undefined, null, ac.signal).then(
      (p) => {
        if (ac.signal.aborted || g !== gen.current) return;
        setList(p.items);
        setCursor(p.next_cursor);
        publish(p.items);
      },
      (e) => !ac.signal.aborted && !(e instanceof DOMException) && setErr(e),
    );
    return () => ac.abort();
  }, [api, n, publish]);

  const loadMore = async () => {
    if (!cursor || more) return;
    const g = gen.current;
    setMore(true);
    try {
      const p = await api.watches.list(undefined, cursor);
      if (g !== gen.current) return; // a reload started meanwhile: this page belongs to the old list
      setList((l) => {
        const next = mergeWatches(l ?? [], p.items);
        publish(next);
        return next;
      });
      setCursor(p.next_cursor);
    } catch (e) {
      showToast(errText(e), "alert");
    } finally {
      setMore(false);
    }
  };

  const onChanged = useCallback((id: string, x: WatchT | null) => {
    setList((l) => {
      if (!l) return l;
      const next = x
        ? l.map((w) =>
            w.watch_id === id ? { ...x, event: x.event ?? w.event } : w,
          )
        : l.filter((w) => w.watch_id !== id);
      const keys = criticalKeysOfWatches(next);
      watchStore.setCritical(keys);
      watchStore.ack(keys);
      return next;
    });
  }, []);

  const header = (
    <header className="pg-h">
      <h1>{t("w.h")}</h1>
    </header>
  );

  if (err && !list) {
    return (
      <>
        {header}
        <div className="empty" data-testid="watch-error">
          <div className="empty-art">
            <Icon name="alert" size={46} />
          </div>
          <h3>{t("w.err.h")}</h3>
          <p>{errText(err)}</p>
          <div className="btns">
            <button
              className="btn btn-lime"
              type="button"
              onClick={() => setN((x) => x + 1)}
            >
              <Icon name="refresh" size={16} />
              {t("common.retry")}
            </button>
          </div>
        </div>
      </>
    );
  }
  if (!list) {
    return (
      <>
        {header}
        <div className="sec wt-sk" aria-busy="true" data-testid="watch-loading">
          <div className="sk" />
          <div className="sk" />
          <Spinner />
        </div>
      </>
    );
  }
  if (!list.length) {
    return (
      <>
        {header}
        <div className="empty wt-empty" data-testid="watch-empty">
          <div className="empty-art">
            <Icon name="radar" size={46} />
          </div>
          <h3>{t("w.empty.h")}</h3>
          <p>{t("w.empty.p")}</p>
          <ul className="wt-how">
            <li>
              <Icon name="radar" size={16} />
              {t("w.empty.how1")}
            </li>
            <li>
              <Icon name="refresh" size={16} />
              {t("w.empty.how2")}
            </li>
            <li>
              <Icon name="bell" size={16} />
              {t("w.empty.how3")}
            </li>
          </ul>
          <div className="btns">
            <button
              className="btn btn-lime"
              type="button"
              data-testid="watch-empty-cta"
              onClick={() => navigate({ type: "tab", tab: "catalog" })}
            >
              <Icon name="ticket" size={16} />
              {t("w.empty.btn")}
            </button>
          </div>
        </div>
      </>
    );
  }

  const sorted = sortWatches(list);
  const stats = watchStats(list);
  const until = untilLabel(stats.nextCheckAt);
  const critical = sorted.find((w) => isCritical(w)) ?? null;
  // a cancelled event stays on top while it is critical (7 days), then moves to «Завершённые»
  const live = sorted.filter((w) => w.status !== "ended" || isCritical(w));
  const ended = sorted.filter((w) => w.status === "ended" && !isCritical(w));
  const critAfter =
    critical?.last_change?.after ??
    (critical?.ended_reason === "EVENT_CANCELLED" ? "CANCELLED" : "");

  return (
    <>
      {header}
      <p className="pd hint wt-sub">{t("w.sub")}</p>
      <div className="wt-stats" data-testid="watch-stats">
        <div className="wt-stat">
          <b className="num">{stats.active}</b>
          <small>{tp("w.s.active", stats.active)}</small>
        </div>
        <div className={stats.critical ? "wt-stat bad" : "wt-stat"}>
          <b className="num">{stats.critical}</b>
          <small>{tp("w.s.crit", stats.critical)}</small>
        </div>
        <div className="wt-stat">
          <b className="num">
            {until ? t(UNIT[until.unit], { n: until.n }) : "—"}
          </b>
          <small>{t("w.s.next")}</small>
        </div>
      </div>
      {critical && (
        <div className="crit" role="alert" data-testid="watch-crit">
          <Icon name="alert" size={22} />
          <div>
            <b>
              {t("w.crit.h", {
                e: critical.event_title,
                s: /^[A-Z_]+$/.test(critAfter)
                  ? t(`life.${critAfter}` as MessageKey)
                  : t("w.c.lifeShort"),
              })}
            </b>
            {critical.last_change && (
              <p>
                {t("w.crit.p", {
                  src: changeSource(critical.last_change),
                  at: formatFetched(critical.last_change.detected_at, lang),
                })}
              </p>
            )}
            <button
              className="btn btn-sm btn-danger"
              type="button"
              data-testid="watch-crit-what"
              aria-label={t("w.crit.btnA11y", { e: critical.event_title })}
              onClick={() => setCrit(critical)}
            >
              {t("w.crit.btn")}
            </button>
          </div>
        </div>
      )}
      <div className="sec wt-list">
        {live.map((w) => (
          <WatchCard key={w.watch_id} w={w} onOpen={() => setOpen(w)} />
        ))}
      </div>
      {cursor && (
        <div className="pd mt12">
          <button
            className="btn btn-soft btn-block"
            type="button"
            data-testid="watch-more"
            disabled={more}
            onClick={() => void loadMore()}
          >
            {more && <Spinner small />}
            {t("n.more")}
          </button>
        </div>
      )}
      {ended.length > 0 && (
        <section className="sec wt-list">
          <div className="sec-h">
            <h2>{t("w.ended.h")}</h2>
          </div>
          {ended.map((w) => (
            <WatchCard key={w.watch_id} w={w} onOpen={() => setOpen(w)} />
          ))}
        </section>
      )}
      <div className="scr-end" />
      {open && (
        <WatchSheet
          watchId={open.watch_id}
          initial={open}
          onClose={() => setOpen(null)}
          onChanged={(x) => onChanged(open.watch_id, x)}
        />
      )}
      {crit && (
        <CritSheet
          w={crit}
          onClose={() => setCrit(null)}
          onRemoved={() => {
            onChanged(crit.watch_id, null);
            setCrit(null);
          }}
        />
      )}
    </>
  );
}

/**
 * «Что делать?» (prototype v9 SHEETS.crit): what happened, what TilHero does next, the source — and the decision:
 * keep watching (postponed / sold out: we report new dates or tickets at once) or remove the watch. A cancelled event
 * cannot be watched any more: the sheet points to the source for refunds.
 */
function CritSheet({
  w,
  onClose,
  onRemoved,
}: {
  w: WatchT;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { api } = useApp();
  const { t, lang } = useI18n();
  const errText = useErrorText();
  const [busy, setBusy] = useState(false);
  const c = w.last_change;
  const status =
    c?.after && /^[A-Z_]+$/.test(c.after)
      ? c.after
      : w.ended_reason === "EVENT_CANCELLED"
        ? "CANCELLED"
        : "";
  const cancelled =
    status === "CANCELLED" || w.ended_reason === "EVENT_CANCELLED";
  const what: MessageKey = cancelled
    ? "w.ds.CANCELLED"
    : status === "POSTPONED"
      ? "w.ds.POSTPONED"
      : status === "SOLD_OUT"
        ? "w.ds.SOLD_OUT"
        : "w.ds.other";
  const url =
    c?.source.url && /^https:\/\//i.test(c.source.url) ? c.source.url : null;
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.watches.remove(w.watch_id);
      watchStore.set(w.event_id, null);
      haptic.notify("success");
      showToast(t("w.del.done"), "trash");
      onRemoved();
    } catch (e) {
      showToast(errText(e), "alert");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={t("w.ds.t", { e: w.event_title })}
      onClose={onClose}
      className="wt-crit-sheet"
      foot={
        <>
          <button
            className="btn btn-danger"
            type="button"
            data-testid="crit-remove"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? <Spinner small /> : <Icon name="trash" size={16} />}
            {t("w.ds.del")}
          </button>
          {cancelled ? (
            url ? (
              <button
                className="btn btn-lime grow"
                type="button"
                data-testid="crit-source"
                onClick={() => openExternal(url)}
              >
                {t("w.ds.src")}
                <Icon name="ext" size={16} />
              </button>
            ) : (
              <button
                className="btn btn-ink grow"
                type="button"
                onClick={onClose}
              >
                {t("common.ok")}
              </button>
            )
          ) : (
            <button
              className="btn btn-lime grow"
              type="button"
              data-testid="crit-keep"
              onClick={() => {
                showToast(
                  t(status === "POSTPONED" ? "w.ds.kept" : "w.ds.keptOther"),
                  "radar",
                );
                onClose();
              }}
            >
              {t("w.ds.keep")}
            </button>
          )}
        </>
      }
    >
      <div data-testid="crit-sheet" data-status={status}>
        {w.event && (
          <EventMediaView event={w.event} className="wt-crit-m" chip="none" />
        )}
        <p className="lead mt12">{t(what)}</p>
        {c && (
          <p className="hint mt8 mono" data-testid="crit-src">
            {t("w.ds.from", {
              src: changeSource(c),
              at: formatFetched(c.detected_at, lang),
            })}
          </p>
        )}
      </div>
    </Sheet>
  );
}
