import { useCallback, useEffect, useRef, useState } from "react";
import { newIdempotencyKey } from "../../api/client";
import type { Watch, WatchChange, WatchDimensions, WatchPatchRequest, WatchRef } from "@tilhero/contracts/bff";
import { ApiError } from "../../api/errors";
import { formatEventDates, formatFetched } from "../../events/format";
import { useI18n, type Lang, type MessageKey } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { confirmPopup, haptic, openExternal } from "../../tg";
import { placeOf } from "../../ui/EventCard";
import { Icon } from "../../ui/Icon";
import { GroupH, Note, Seg, Spinner, ToggleRow } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import { endedKey, boardTime, changeFlap, changeLine, changeSource, suppressedCount, watchBadge } from "../../watch/logic";
import { watchStore } from "../../watch/store";
import { NotifTimeSheet } from "../profile/sheets";

/**
 * Watch sheet (prototype v9 SHEETS.watch): 6 dimensions, the price-drop threshold 5 / 10 / 15 %, quiet hours and the
 * digest time from the profile notification settings (edited in place with the profile sheet), the change history
 * with its source and time, «Подавлено дублей», pause / resume, remove, open the event. Every PATCH carries
 * expected_version; 409 VERSION_CONFLICT reloads the watch.
 */
const DIMS: ReadonlyArray<[keyof WatchDimensions, MessageKey, MessageKey]> = [
  ["tickets", "w.d.tickets", "w.d.ticketsSub"],
  ["price", "w.d.price", "w.d.priceSub"],
  ["flight", "w.d.flight", "w.d.flightSub"],
  ["hotel", "w.d.hotel", "w.d.hotelSub"],
  ["status", "w.d.status", "w.d.statusSub"],
  ["news", "w.d.news", "w.d.newsSub"],
];
const THRESHOLDS = [5, 10, 15] as const;

export const pctLabel = (n: number, lang: Lang): string => (lang === "ru" ? `${n} %` : `${n}%`);
export const refOf = (w: Pick<Watch, "watch_id" | "status">): WatchRef => ({ watch_id: w.watch_id, status: w.status });

/** One history row: what changed, its source (link) and time, the flap with the delta or status. */
export function ChangeRowView({ c }: { c: WatchChange }) {
  const { t, lang } = useI18n();
  const bt = boardTime(c.detected_at, lang);
  const flap = changeFlap(c, lang);
  const line = changeLine(c, lang);
  const vars = line.vars.s ? { ...line.vars, s: t(`life.${line.vars.s}` as MessageKey) } : line.vars;
  const src = changeSource(c);
  const url = /^https:\/\//i.test(c.source.url ?? "") ? c.source.url! : null;
  return (
    <li className="brow" data-testid="w-change" data-type={c.type} data-notified={c.notified}>
      <time dateTime={c.detected_at}>{bt.kind === "yday" ? t("w.d.yday") : bt.text}</time>
      <span className="brow-t">
        <b>{t(line.key as MessageKey, vars)}</b>
        <small>
          {url ? (
            <button className="wt-src" type="button" onClick={() => openExternal(url)} aria-label={t("w.d.srcOpen", { d: src })}>
              {src}
              <Icon name="ext" size={11} />
            </button>
          ) : (
            src
          )}
          {` · ${formatFetched(c.source.observed_at, lang)}`}
          {c.notified === "suppressed" && <span className="wt-dup">{` · ${t("w.d.dup")}`}</span>}
        </small>
      </span>
      <span className={`flap ${flap.tone}`}>{flap.text || t(flap.key as MessageKey)}</span>
    </li>
  );
}

export function WatchSheet(props: { watchId: string; initial?: Watch | null; onClose: () => void; onChanged?: (w: Watch | null) => void }) {
  const { api, nav, navigate, profile, reloadProfile } = useApp();
  const { t, lang } = useI18n();
  const errText = useErrorText();
  const [w, setW] = useState<Watch | null>(props.initial ?? null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [changes, setChanges] = useState<WatchChange[] | null>(null);
  const [chErr, setChErr] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notifSheet, setNotifSheet] = useState<"quiet" | "digest" | null>(null);
  const [n, setN] = useState(0);
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;

  useEffect(() => {
    if (!profile) void reloadProfile();
    // the profile is loaded once for the notification rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    setLoadErr(null);
    if (!props.initial || n > 0) {
      api.watches.get(props.watchId, ac.signal).then(
        (x) => !ac.signal.aborted && setW(x),
        (e) => !ac.signal.aborted && !(e instanceof DOMException) && setLoadErr(e),
      );
    }
    setChErr(false);
    api.watches.changes(props.watchId, null, ac.signal).then(
      (p) => !ac.signal.aborted && setChanges(p.items),
      (e) => !ac.signal.aborted && !(e instanceof DOMException) && setChErr(true),
    );
    return () => ac.abort();
    // props.initial is the first value only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, props.watchId, n]);

  const publish = useCallback((x: Watch | null, eventId: string) => {
    watchStore.set(eventId, x ? refOf(x) : null);
    onChanged.current?.(x);
  }, []);

  const patch = async (p: Omit<WatchPatchRequest, "expected_version">, key: string, ok?: string) => {
    if (!w || busy) return;
    const prev = w;
    setW({
      ...w,
      ...(p.dimensions ? { dimensions: { ...w.dimensions, ...p.dimensions } } : {}),
      ...(p.threshold_pct ? { threshold_pct: p.threshold_pct } : {}),
      ...(p.status ? { status: p.status } : {}),
    });
    setBusy(key);
    try {
      const next = await api.watches.patch(w.watch_id, { ...p, expected_version: w.version });
      setW(next);
      publish(next, next.event_id);
      if (ok) showToast(ok, p.status === "paused" ? "clock" : "check");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        try {
          const fresh = await api.watches.get(w.watch_id);
          setW(fresh);
          publish(fresh, fresh.event_id);
        } catch {
          setW(prev);
        }
        showToast(t("w.conflict"), "info");
      } else {
        setW(prev);
        showToast(errText(e), "alert");
      }
    } finally {
      setBusy(null);
    }
  };

  const toggleDim = (k: keyof WatchDimensions, on: boolean) => {
    if (!w) return;
    if (!on && Object.entries(w.dimensions).filter(([x, v]) => v && x !== k).length === 0) {
      haptic.notify("warning");
      showToast(t("w.d.minOne"), "info");
      return;
    }
    void patch({ dimensions: { [k]: on } }, `dim-${k}`);
  };

  const remove = async () => {
    if (!w || busy) return;
    const yes = await confirmPopup({ title: t("w.del.t"), message: t("w.del.m", { e: w.event_title }), ok: t("w.del.ok"), cancel: t("common.cancel"), destructive: true });
    if (!yes) return;
    setBusy("del");
    try {
      await api.watches.remove(w.watch_id);
      publish(null, w.event_id);
      haptic.notify("success");
      showToast(t("w.del.done"), "trash");
      props.onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        publish(null, w.event_id);
        props.onClose();
      } else showToast(errText(e), "alert");
    } finally {
      setBusy(null);
    }
  };

  const openEvent = () => {
    if (!w) return;
    props.onClose();
    const top = nav.stack[nav.stack.length - 1];
    if (top && top.name === "event" && top.id === w.event_id) return;
    navigate({ type: "push", route: { name: "event", id: w.event_id } });
  };

  const ev = w?.event ?? null;
  const sub = ev ? [formatEventDates(ev.start, ev.end, lang), placeOf(ev, lang, t("ev.online"))].filter(Boolean).join(" · ") : undefined;
  const notif = profile?.notifications ?? null;
  const ended = w?.status === "ended";
  const badge = w ? watchBadge(w) : null;

  const foot = w ? (
    <>
      {!ended && (
        <button
          className="btn btn-soft wt-f-pause"
          type="button"
          data-testid="w-pause"
          disabled={!!busy}
          onClick={() =>
            void patch(
              { status: w.status === "paused" ? "active" : "paused" },
              "status",
              w.status === "paused" ? t("w.resume.done") : t("w.pause.done"),
            )
          }
        >
          <Icon name={w.status === "paused" ? "play" : "pause"} size={16} />
          {w.status === "paused" ? t("w.d.resume") : t("w.d.pause")}
        </button>
      )}
      <button className="btn btn-danger wt-f-del" type="button" data-testid="w-delete" aria-label={t("w.d.del")} title={t("w.d.del")} disabled={!!busy} onClick={() => void remove()}>
        {busy === "del" ? <Spinner small /> : <Icon name="trash" size={18} />}
      </button>
      <button className="btn btn-ink wt-f-open" type="button" data-testid="w-open-event" aria-label={t("w.d.open")} onClick={openEvent}>
        {t("n.toEvent")}
        <Icon name="chevR" size={16} />
      </button>
    </>
  ) : undefined;

  return (
    <Sheet title={w?.event_title ?? t("w.h")} sub={sub} onClose={props.onClose} foot={foot} className="wt-sheet">
      <div data-testid="watch-sheet" data-status={w?.status ?? "loading"}>
        {!w && !loadErr && (
          <div className="empty">
            <Spinner />
          </div>
        )}
        {!w && !!loadErr && (
          <Note tone="bad" icon="alert" action={{ label: t("common.retry"), onClick: () => setN((x) => x + 1) }}>
            {errText(loadErr)}
          </Note>
        )}
        {w && (
          <>
            {(w.status === "paused" || ended) && badge && (
              <Note icon={ended ? "info" : "pause"} className="mb12">
                <span data-testid="w-ended-note">{ended ? t(endedKey(w.ended_reason).note) : t("w.d.paused")}</span>
              </Note>
            )}
            <GroupH>{t("w.d.what")}</GroupH>
            <div className="group" data-testid="w-dims">
              {DIMS.map(([k, title, sub2]) => (
                <ToggleRow key={k} id={`wdim-${k}`} title={t(title)} sub={t(sub2)} on={w.dimensions[k]} disabled={ended} busy={busy === `dim-${k}`} onChange={(v) => toggleDim(k, v)} />
              ))}
            </div>

            <GroupH>{t("w.d.thr")}</GroupH>
            <Seg
              value={w.threshold_pct}
              label={t("w.d.thr")}
              className="wt-thr"
              options={THRESHOLDS.map((x) => ({ value: x, label: pctLabel(x, lang) }))}
              onChange={(v) => !ended && void patch({ threshold_pct: v }, "thr", t("w.saved"))}
            />
            <p className="hint wt-thr-sub">{t("w.d.thrSub")}</p>

            <GroupH>{t("w.d.notify")}</GroupH>
            <div className="group" data-testid="w-notify">
              {notif && !notif.enabled && (
                <div className="trow">
                  <Note tone="warn" icon="bell">
                    {t("w.d.notifOff")}
                  </Note>
                </div>
              )}
              <div className="trow">
                <span className="lrow-i">
                  <Icon name="moon" size={18} />
                </span>
                <div className="trow-t">
                  <b data-testid="w-quiet">{notif?.quiet_hours ? t("w.d.quiet", { from: notif.quiet_hours.start, to: notif.quiet_hours.end }) : t("w.d.quietOff")}</b>
                  <small>{t("w.d.quietSub")}</small>
                </div>
                <button className="lnk" type="button" disabled={!notif} onClick={() => setNotifSheet("quiet")} data-testid="w-quiet-edit">
                  {t("w.d.edit")}
                </button>
              </div>
              <div className="trow">
                <span className="lrow-i">
                  <Icon name="bell" size={18} />
                </span>
                <div className="trow-t">
                  <b>{t("w.d.how")}</b>
                  <small data-testid="w-how">{notif?.digest_time ? t("w.d.howV", { time: notif.digest_time }) : t("w.d.howNoTime")}</small>
                </div>
                <button className="lnk" type="button" disabled={!notif} onClick={() => setNotifSheet("digest")}>
                  {t("w.d.edit")}
                </button>
              </div>
            </div>

            <GroupH>{t("w.d.hist")}</GroupH>
            {changes === null && !chErr && (
              <div className="empty sm">
                <Spinner small />
              </div>
            )}
            {chErr && (
              <Note tone="warn" icon="alert" action={{ label: t("common.retry"), onClick: () => setN((x) => x + 1) }}>
                {t("w.d.histErr")}
              </Note>
            )}
            {changes && changes.length === 0 && <p className="hint">{t("w.d.histEmpty")}</p>}
            {changes && changes.length > 0 && (
              <ol className="board wt-hist" data-testid="w-history">
                {changes.map((c) => (
                  <ChangeRowView key={c.change_id} c={c} />
                ))}
              </ol>
            )}
            {changes && changes.length > 0 && (
              <div className="note wt-sup" data-testid="w-suppressed">
                <Icon name="filter" size={16} />
                <span>
                  <b>{t("w.d.sup", { n: suppressedCount(changes) })}.</b> {t("w.d.supSub")}
                </span>
              </div>
            )}
          </>
        )}
      </div>
      {notifSheet && profile && <NotifTimeSheet kind={notifSheet} onClose={() => setNotifSheet(null)} />}
    </Sheet>
  );
}

/**
 * One-tap Watch (TG-FR-030): the first tap creates the watch (the BFF fills the trip parameters) and says
 * «Следим · порог 10 %»; a tap on a watched event opens its sheet. Shared by the detail, cards and Home.
 */
export function useWatchAction() {
  const { api } = useApp();
  const { t } = useI18n();
  const errText = useErrorText();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);

  const act = useCallback(
    async (eventId: string, ref: WatchRef | null) => {
      if (ref) {
        haptic.selection();
        setOpen(ref.watch_id);
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(eventId);
      haptic.impact("light");
      try {
        const w = await api.watches.create({ event_id: eventId }, newIdempotencyKey());
        watchStore.set(eventId, refOf(w));
        haptic.notify("success");
        showToast(t("w.toast.on", { n: w.threshold_pct }), "radar");
      } catch (e) {
        haptic.notify("error");
        showToast(errText(e), "alert");
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [api, errText, t],
  );
  const sheet = open ? <WatchSheet watchId={open} onClose={() => setOpen(null)} /> : null;
  return { act, busy, sheet, openSheet: setOpen };
}
