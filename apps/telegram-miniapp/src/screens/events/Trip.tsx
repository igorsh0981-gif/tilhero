import type { EventDetailView, MapLinks, NearbyHotel, NearbyPoi, Offer, OfferFlight, OfferHotel, OfferSetView, OfferTicket, OfferTier } from "@tilhero/contracts/bff";
import { Component, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../../api/errors";
import { rateLimits, useRateWait } from "../../api/rateLimit";
import { noteText as aiNoteText } from "../../ai/text";
import { fromAiTripParams, toAiTripParams, tripBridge, tripKey, type TripNote } from "../../ai/tripBridge";
import { formatMoney, hostOf, sourceLabel } from "../../events/format";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { haptic, openExternal } from "../../tg";
import {
  budgetKey,
  budgetMark,
  budgetRange,
  beyondBase,
  excludesText,
  formatRadius,
  sharedHotelTiers,
  chosenHotelId,
  clampTravellers,
  DEFAULT_HOTEL_RATING,
  DEFAULT_PARAMS,
  formatDistance,
  formatDuration,
  formatRating,
  formatTripDates,
  filtersFallback,
  filtersOf,
  hasOverrides,
  hotelConditions,
  hotelValues,
  keepFallback,
  pickTripHotel,
  hotelSwaps,
  initialTier,
  isExpired,
  isOk,
  isProviderDown,
  keepOf,
  MAX_EXTRA_NIGHTS,
  MAX_TRAVELLERS,
  MIN_TRAVELLERS,
  mapItems,
  missingText,
  mulAmount,
  NOTE_KEYS,
  offersCall,
  offerSupportContext,
  packageLinks,
  passHotel,
  poiKindKey,
  priceTime,
  retier,
  routeSearchLink,
  safeLink,
  sortHotels,
  ticketFxLine,
  ticketProvider,
  ticketUsd,
  tierHotels,
  TIERS,
  transfersText,
  unavailableKey,
  wallDay,
  type BudgetMark,
  type HotelSwap,
  type PackageLink,
  type Retier,
  type TripParams,
} from "../../trip/logic";
import { Icon, type IconName } from "../../ui/Icon";
import { Badge, Chip, Note, Seg, Spinner, ToggleRow } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import { PrefEditor } from "../profile/PrefEditor";
import { HotelPicker, hotelRatingLabel } from "../../ui/prefControls";

/**
 * «Поездка» on the event detail (sprint 5, prototype v9 22-offer.js / 60-detail.js, AGENT_BRIEF D).
 * Loaded by its own request (GET /v1/events/{id}/offers, POST …/recalculate): a failure here shows a retry inside the
 * block and never breaks the event detail. The boarding pass carries the main facts — route, dates, travellers and the
 * total; every row below names its supplier, the time of the price and opens the exact supplier link (Telegram openLink).
 * Prices are what suppliers returned: a component without a price says why and stays out of the total.
 * Fix 5.1: the block opens the tier the server recommends for the profile budget; tiers, the total and every hotel
 * nearby carry «В вашем бюджете» / «Превышает ваш бюджет на $X»; a hotel from «Отели рядом» can be chosen for every
 * tier (POST …/recalculate with hotel_id) and given back to the tier rules; no budget → a quiet hint to set one.
 * A past event (is_past) is not priced at all. A ticket in another currency is in the total at the CBU rate (ticket.fx):
 * «≈ $309 по курсу ЦБ РУз на 11.10 · на сайте 27 000 сом». A flight / hotel whose supplier did not answer says which
 * service failed and offers «Попробовать снова» — the same parameters priced anew (POST …/recalculate past the cache).
 */
type SheetState = { k: "map"; title: string; map: MapLinks } | { k: "sources" } | { k: "deps" } | { k: "budget" } | null;

/**
 * Sprint 7: a trip the AI concierge changed (tool_result.trip_params) — the plaque «AI изменил предложение: … ·
 * Отменить» while these exact parameters are on screen; `prev` is the snapshot «Отменить» returns to, with the plaque of
 * an earlier AI change in it (m-05: the label lives in the snapshot).
 */
interface AiChange {
  note: TripNote;
  params: TripParams;
  prev: { params: TripParams; tier: OfferTier; change: AiChange | null };
}

const RECALC_DEBOUNCE_MS = 350;
/** telegram-bff's rate-limit policy of trip pricing (sprint 9) */
const OFFERS_POLICY = "tg.offers";

function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(id);
  }, [stepMs]);
  return now;
}

/** Render-time failures of the block (unexpected data) stay inside it: the event detail keeps working. */
export class TripBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function TripBlock({ ev }: { ev: EventDetailView }) {
  const { api, profile, reloadProfile, navigate } = useApp();
  const { t, tp, fmt, lang } = useI18n();
  const errText = useErrorText();
  // departure cities and flight preferences live in the profile (loaded lazily by the app): needed for the city chips,
  // «direct only from the profile» and the departures editor
  const depKey = profile ? profile.preferences.departures.map((d) => d.airport_iata).join(",") : null;
  const budKey = profile ? budgetKey(profile.preferences.budget) : null;
  const [params, setParams] = useState<TripParams>(DEFAULT_PARAMS);
  const [tier, setTier] = useState<OfferTier>("comfort");
  const [data, setData] = useState<OfferSetView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(true);
  const [reload, setReload] = useState(0);
  const [sheet, setSheet] = useState<SheetState>(null);
  const loaded = useRef(false);
  const lastDeps = useRef<string | null>(null);
  const lastBudget = useRef<string | null>(null);
  // the recommended tier is opened on the first calculation and after the user changes the budget — not on every
  // recalculation (a tier must not jump under the user's finger when they add a traveller)
  const applyRecommended = useRef(true);
  // fix 5.2: the tier on screen was picked by the block (the budget recommendation), not by the user's tap — only such
  // a tier follows the recommendation when the number of travellers changes, and the block says so (`retiered`)
  const tierAuto = useRef(true);
  const tierNow = useRef<OfferTier>("comfort");
  const shown = useRef<OfferSetView | null>(null);
  const [retiered, setRetiered] = useState<Retier | null>(null);
  // fix 5.2: tiers whose kept hotel the supplier priced no more for the new number of travellers
  const [swaps, setSwaps] = useState<Partial<Record<OfferTier, HotelSwap>>>({});
  // the last parameters the server priced: a failed recalculation (but 429) rolls the controls back to them,
  // so the settings never disagree with the numbers; «Повторить» then retries the failed parameters
  const lastGood = useRef<TripParams>(DEFAULT_PARAMS);
  const failed = useRef<TripParams | null>(null);
  const skipFetch = useRef(false);
  // «Попробовать снова» after a supplier failure: the next calculation is a POST with the same parameters (a new one)
  const force = useRef(false);
  // fix 6.1 review: the BFF does not know keep_hotels (older version) — not sent again in this block
  const keepOff = useRef(false);
  // fix 6.3: the BFF does not know hotel_filters (older version) — the trip's hotel settings are not sent again
  const filtersOff = useRef(false);
  const [visible, setVisible] = useState(false);
  const watchRef = useRef<HTMLElement | null>(null);
  const now = useNow(30_000);
  // sprint 7: the AI concierge reads the trip on screen and applies what its tools priced (src/ai/tripBridge.ts)
  const [aiChange, setAiChange] = useState<AiChange | null>(null);
  const kindNow = data?.trip.kind ?? null;
  const live = useRef({ params, tier, aiChange, kind: kindNow });
  live.current = { params, tier, aiChange, kind: kindNow };
  // the AI's parameters being priced: the chat learns whether «Поездка» took them (ok) or the recalculation failed
  const aiPending = useRef<{ params: TripParams; done: (ok: boolean) => void } | null>(null);
  // sprint 9: a 429 of offers (or of the user) in force — «Повторить» / «Обновить» wait, the text counts down
  const rl = useRateWait([OFFERS_POLICY]);
  const limited = rl.left > 0;
  const settleAi = (asked: TripParams, ok: boolean) => {
    const p = aiPending.current;
    // a success settles any pending change (a newer calculation replaced it); a failure — only the AI's own
    if (!p || (!ok && p.params !== asked)) return;
    aiPending.current = null;
    p.done(ok);
  };
  useEffect(
    () =>
      tripBridge.register(ev.event_id, {
        // an event without a trip package (online, postponed, past): nothing to send
        get: () => (ev.is_past || (live.current.kind !== null && live.current.kind !== "trip") ? null : toAiTripParams(live.current.params, live.current.tier)),
        apply: (p, note) => {
          if (ev.is_past) return Promise.resolve(false);
          const next = fromAiTripParams(p);
          const cur = live.current;
          aiPending.current?.done(true);
          const settled = new Promise<boolean>((resolve) => {
            aiPending.current = { params: next.params, done: resolve };
          });
          setAiChange({ note, params: next.params, prev: { params: cur.params, tier: cur.tier, change: cur.aiChange } });
          setRetiered(null);
          setParams(next.params);
          if (next.tier) {
            tierAuto.current = false;
            applyRecommended.current = false; // the AI's tier is not replaced by the budget recommendation
            setTier(next.tier);
          }
          return settled;
        },
        sync: (p) => {
          if (ev.is_past) return;
          const cur = live.current;
          // the same trip in other words — nothing to recalculate
          if (tripKey(p) === tripKey(toAiTripParams(cur.params, cur.tier))) return;
          const next = fromAiTripParams(p);
          setParams(next.params); // a quiet recalculation: no plaque, no «Отменить»
          if (next.tier && next.tier !== cur.tier) {
            tierAuto.current = false;
            applyRecommended.current = false;
            setTier(next.tier);
          }
        },
      }),
    [ev.event_id, ev.is_past],
  );

  // the first calculation starts when the block comes near the screen (300 px ahead) — not for every opened detail
  useEffect(() => {
    if (visible) return;
    const el = watchRef.current;
    if (typeof IntersectionObserver === "undefined" || !el) {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), {
      root: el.closest(".vp"),
      rootMargin: "300px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!profile)
      Promise.resolve()
        .then(reloadProfile)
        .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // the user changed departure cities (e.g. «Добавить город вылета») → price again; the first profile load does not
  useEffect(() => {
    if (depKey === null) return;
    if (lastDeps.current !== null && lastDeps.current !== depKey) setReload((x) => x + 1);
    lastDeps.current = depKey;
  }, [depKey]);
  // the user set or changed the budget (e.g. from «Укажите бюджет в профиле») → price again and open the recommendation
  useEffect(() => {
    if (budKey === null) return;
    if (lastBudget.current !== null && lastBudget.current !== budKey) {
      applyRecommended.current = true;
      tierAuto.current = true;
      // a new budget: the hotels by the tier rules again (not the ones kept for the travellers)
      setParams((p) => (p.keep_hotels ? { ...p, keep_hotels: null } : p));
      setReload((x) => x + 1);
    }
    lastBudget.current = budKey;
  }, [budKey]);

  useEffect(() => {
    if (!visible || ev.is_past) return;
    if (skipFetch.current) {
      skipFetch.current = false; // a rollback to the last priced parameters: the numbers on screen already match them
      return;
    }
    const ac = new AbortController();
    const asked = params;
    setBusy(true);
    setError(null);
    const timer = setTimeout(
      () => {
        const call = offersCall({ ...params, ...(keepOff.current ? { keep_hotels: null } : {}), ...(filtersOff.current ? { hotel_filters: null } : {}) }, force.current);
        force.current = false;
        const send = (c: typeof call) => (c.method === "GET" ? api.offers.get(ev.event_id, c.travellers, ac.signal) : api.offers.recalculate(ev.event_id, c.body, ac.signal));
        // any failure — even a synchronous one — becomes the block's error state, never the detail's;
        // an older BFF rejecting keep_hotels → the same calculation without it (once, then never sent again)
        const req = Promise.resolve()
          .then(() => send(call))
          .catch((e: unknown) => {
            const fb = keepFallback(call, e);
            if (!fb || ac.signal.aborted) throw e;
            keepOff.current = true;
            return send(fb);
          })
          .catch((e: unknown) => {
            const fb = filtersFallback(call, e);
            if (!fb || ac.signal.aborted) throw e;
            filtersOff.current = true;
            return send(fb);
          });
        req.then(
          (d) => {
            if (ac.signal.aborted) return;
            loaded.current = true;
            lastGood.current = asked;
            failed.current = null;
            settleAi(asked, true);
            const prev = shown.current;
            shown.current = d;
            setData(d);
            // fix 5.2: another number of travellers — the user's tier stays; a tier the block picked follows the budget
            // recommendation and says so; a kept hotel the supplier did not price for this occupancy is named
            const moved = !!prev && prev.travellers !== d.travellers;
            const re = moved && !applyRecommended.current ? retier(d, tierNow.current, tierAuto.current) : null;
            setRetiered(re);
            setSwaps(moved && !keepOff.current ? hotelSwaps(prev, d, keepOf(asked)) : {});
            if (applyRecommended.current && d.tiers) {
              applyRecommended.current = false;
              setTier(initialTier(d));
            } else if (re) setTier(re.to);
            setBusy(false);
          },
          (e) => {
            if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
            if (loaded.current && !(e instanceof ApiError && e.code === "RATE_LIMITED") && asked !== lastGood.current) {
              failed.current = asked;
              skipFetch.current = true;
              setParams(lastGood.current);
            }
            settleAi(asked, false);
            rateLimits.note(e, OFFERS_POLICY);
            setError(e);
            setBusy(false);
          },
        );
      },
      loaded.current ? RECALC_DEBOUNCE_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [api, ev.event_id, ev.is_past, params, reload, visible]);

  tierNow.current = tier;
  const set = (patch: Partial<TripParams>) => setParams((p) => ({ ...p, ...patch }));
  /** A tap on a tier (or «Вернуть …»): the user's choice — never switched by a change of travellers. */
  const pickTier = (k: OfferTier) => {
    tierAuto.current = false;
    setRetiered(null);
    setAiChange(null); // the user's own choice over the AI's
    setTier(k);
  };
  /** «Отменить» under «AI изменил предложение»: the parameters and the tier before the change (priced anew, same window). */
  const undoAi = () => {
    const c = aiChange;
    if (!c) return;
    haptic.selection();
    setParams(c.prev.params);
    setTier(c.prev.tier);
    setAiChange(c.prev.change && c.prev.change.params === c.prev.params ? c.prev.change : null);
    showToast(t("tr.ai.undone"), "refresh");
  };
  const retrySupplier = () => {
    haptic.selection();
    force.current = true;
    setReload((x) => x + 1);
  };
  /** an error as the block says it; a 429 counts down while it holds (sprint 9) */
  const errLine = (e: unknown): string => {
    if (e instanceof ApiError && e.code === "RATE_LIMITED") return limited ? t("err.RATE_LIMITED.wait", { n: rl.left }) : t("err.RATE_LIMITED");
    return errText(e);
  };
  const retry = () => {
    if (limited) return;
    const f = failed.current;
    failed.current = null;
    // a departure the server refused is not retried: price the last accepted parameters again
    if (f && !(error instanceof ApiError && error.code === "OFFER_DEPARTURE_INVALID")) setParams(f);
    else setReload((x) => x + 1);
  };

  // the event is over: nothing to price (offers answers not_available/EVENT_PAST too) — no request at all
  if (ev.is_past) return <TripNotAvailable reason="EVENT_PAST" />;
  if (!data && !error) return <TripSkeleton watch={watchRef} />;
  if (!data) {
    return (
      <section className="sec trip" data-testid="trip-error" aria-labelledby="tripH">
        <TripHead />
        <div className="panel trip-err">
          <Icon name="alert" size={20} />
          <div className="grow">
            <b>{t("tr.err.h")}</b>
            <p className="hint" data-testid="trip-error-text">{errLine(error)}</p>
          </div>
          <button className="btn btn-sm btn-soft" type="button" onClick={retry} disabled={busy || limited} data-testid="trip-error-retry">
            {busy ? <Spinner small /> : <Icon name="refresh" size={16} />}
            {t("common.retry")}
          </button>
        </div>
      </section>
    );
  }

  const kind = data.trip.kind;
  if (kind === "not_available" || !data.tiers) return <TripNotAvailable reason={data.trip.reason ?? "NO_DESTINATION"} />;

  const offer = data.tiers[tier];
  const stale = isExpired(data.expires_at, now);
  const recalcError = error ? t("tr.recalcErr", { e: errLine(error) }) : null;
  const support = () => navigate({ type: "push", route: { name: "supportNew", ctx: offerSupportContext(ev, data, offer, t("tr.sup.subj", { t: ev.title })) } });
  const openMap = (title: string, map: MapLinks) => setSheet({ k: "map", title, map });
  const links = packageLinks(data, offer);
  // the hotel the user chose: by the package (hotel_chosen_by = "user"), or the asked id when that hotel is gone (NO_HOTEL)
  const userHotel = data.hotel_chosen_by === "user";
  // fix 6.1: the widened hotel search says where it looked; one hotel in several tiers — no alternatives were found
  const hs = data.hotel_search;
  const noteText = (n: (typeof data.notes)[number]): string =>
    n === "HOTEL_SEARCH_WIDENED" && hs
      ? t("tr.note.widened", { base: formatRadius(hs.base_radius_m, lang, t), br: formatRating(hs.base_rating_min, lang), km: formatRadius(hs.radius_m, lang, t), r: formatRating(hs.rating_min, lang) })
      : n === "HOTEL_PREFS_NONE" && hs
        ? t("tr.note.prefsNone", { c: hotelConditions(hs, lang, t) })
        : t(NOTE_KEYS[n]);
  // 6.3: «По вашим условиям … отелей нет — показываем ближайшие варианты» says it all — no second «поиск расширен»
  // ревью 6.3: старый telegram-bff отверг настройки отеля поездки — расчёт без них, сказано (как от BFF при старом offers)
  const notes: typeof data.notes =
    filtersOff.current && filtersOf(params) && !data.notes.includes("HOTEL_PREFS_PENDING") ? [...data.notes, "HOTEL_PREFS_PENDING"] : data.notes;
  const shownNote = (n: (typeof data.notes)[number]): boolean =>
    !!NOTE_KEYS[n] && n !== "BUDGET_NONE_WITHIN" && !(n === "HOTEL_SEARCH_WIDENED" && data.notes.includes("HOTEL_PREFS_NONE"));
  const shared = userHotel ? [] : sharedHotelTiers(data, tier);
  // 6.2: no tier fits the budget — the closest one (the recommended tier: the least over the budget)
  const noneWithin = data.notes.includes("BUDGET_NONE_WITHIN") && !!data.recommended_tier;
  const closest = (() => {
    const k = data.recommended_tier ?? tier;
    const o = data.tiers[k];
    const m = budgetMark(o);
    const ex = m ? excludesText(m.excludes, t) : "";
    const over = m?.kind === "over" && m.by ? fmt.usdDecimal(m.by) + (ex ? ` (${ex})` : "") : "";
    return { tier: k, name: isOk<OfferHotel>(o.hotel) ? o.hotel.name : t(`tr.tier.${k}` as MessageKey), over };
  })();
  const chosenId = chosenHotelId(data, offer) ?? (userHotel ? params.hotel_id : null);
  const chooseHotel = (id: string | null) => {
    haptic.selection();
    // the user's hotel / «Вернуть подбор»: the tier rules from now on, not the hotels kept for the travellers
    set({ hotel_id: id, keep_hotels: null });
  };
  // fix 5.2: another number of travellers keeps every tier's hotel of the set on screen (priced for the new occupancy)
  const setTravellers = (n: number) => set({ travellers: n, keep_hotels: tierHotels(data) ?? params.keep_hotels });
  const swap = swaps[tier];

  return (
    <>
      <section className="sec trip" data-testid="trip" data-kind={kind} data-tier={tier} aria-labelledby="tripH" aria-busy={busy}>
        <TripHead sub={kind === "ticket_only" ? t("tr.sub.ticket") : t("tr.sub")} />
        {kind === "trip" && noneWithin && (
          // 6.2: nothing fits the budget — said above the tiers, with the closest option (the recommended tier)
          <Note tone="warn" icon="wallet" className="trip-none" action={closest.tier !== tier ? { label: t("tr.bud.none.show"), onClick: () => pickTier(closest.tier) } : undefined}>
            <span data-testid="trip-budget-none">{closest.over ? t("tr.bud.none", { h: closest.name, p: closest.over }) : t("tr.bud.none.any", { h: closest.name })}</span>
          </Note>
        )}
        {(kind === "trip" || ticketPricesDiffer(data)) && <TierSwitch set={data} tier={tier} onChange={pickTier} />}
        {kind === "ticket_only" ? (
          <TicketOnly set={data} offer={offer} ev={ev} />
        ) : (
          <Pass
            set={data}
            offer={offer}
            tier={tier}
            params={params}
            busy={busy}
            onTravellers={setTravellers}
            onAddDeparture={() => setSheet({ k: "deps" })}
            retiered={retiered && retiered.to === tier ? retiered : null}
            onRevert={pickTier}
          />
        )}
        {aiChange && aiChange.params === params && (
          <div className="aichg mt12" role="status" data-testid="trip-ai-change">
            <Icon name="spark" size={18} />
            <div className="grow">
              <span data-testid="trip-ai-note">{t("tr.ai.changed", { w: aiNoteText(t, aiChange.note) })}</span>
              <small>
                <Icon name="check" size={12} />
                {t("tr.ai.verified")}
              </small>
            </div>
            <button type="button" onClick={undoAi} data-testid="trip-ai-undo">
              {t("tr.ai.undo")}
            </button>
          </div>
        )}
        {/* fix 5.2: the tier's kept hotel has no rate for the new number of travellers — which hotel the total is for now */}
        {kind === "trip" && swap && (
          <Note icon="bed" className="mt12">
            <span data-testid="trip-hotel-swap">
              {swap.to
                ? t("tr.swap", { a: swap.from, b: swap.to, n: `${swap.travellers} ${tp("tr.people", swap.travellers)}` })
                : t("tr.swap.none", { a: swap.from, n: `${swap.travellers} ${tp("tr.people", swap.travellers)}` })}
            </span>
          </Note>
        )}
        {kind === "trip" && data.budget === null && (
          // no budget in the profile: a quiet way to set one (the same editor as in the profile, over the detail)
          <button className="trip-bud mt12" type="button" data-testid="trip-budget-hint" onClick={() => setSheet({ k: "budget" })}>
            <Icon name="wallet" size={18} />
            <span className="grow">{t("tr.bud.hint")}</span>
            <Icon name="chevR" size={16} />
          </button>
        )}
        {recalcError && (
          <Note tone="bad" icon="alert" className="mt12" action={{ label: t("common.retry"), onClick: retry, disabled: busy || limited }}>
            <span data-testid="trip-recalc-error">{recalcError}</span>
          </Note>
        )}
        <Freshness set={data} stale={stale} busy={busy} limited={limited} onRefresh={retry} />
        {notes.filter(shownNote).length > 0 && (
          <div className="trip-notes" data-testid="trip-notes">
            {notes
              .filter(shownNote)
              .map((n) => (
                <Note
                  key={n}
                  icon={n === "LOCATION_APPROX" ? "pin" : n === "FLIGHT_DATES_SHIFTED" ? "cal" : n.startsWith("HOTEL_") ? "bed" : "info"}
                  className="mt8"
                  // the widened hotel search failed on a step: «Попробовать снова» — the same parameters priced anew
                  action={n === "HOTEL_SEARCH_INCOMPLETE" && !busy ? { label: t("tr.na.again"), onClick: retrySupplier } : undefined}
                >
                  <span data-note={n}>{noteText(n)}</span>
                </Note>
              ))}
          </div>
        )}
        {data.alternative && kind === "trip" && (
          <div className="alt" data-testid="trip-alt">
            <Icon name="down" size={18} />
            <span className="grow">
              {t("tr.alt", {
                c: `${data.alternative.city} (${data.alternative.iata})`,
                p: fmt.usdDecimal(data.alternative.saving_per_person),
                tier: t(`tr.tier.${data.alternative.tier}` as MessageKey),
                city: data.alternative.city,
              })}
            </span>
            <button className="btn btn-sm btn-soft" type="button" disabled={busy} onClick={() => set({ departure_iata: data.alternative!.iata })}>
              {t("tr.alt.use", { c: data.alternative.city })}
            </button>
          </div>
        )}
        {kind === "trip" && (
          <div className="panel li-wrap mt12" data-testid="trip-items">
            <TicketRow ticket={offer.ticket} tier={tier} travellers={data.travellers} />
            <FlightRow flight={offer.flight} set={data} busy={busy} onRetry={retrySupplier} />
            <HotelRow
              hotel={offer.hotel}
              nearVenue={params.near_venue}
              outOfTotal={offer.totals.missing.includes("hotel")}
              onMap={openMap}
              chosen={userHotel}
              onReset={busy ? undefined : () => chooseHotel(null)}
              busy={busy}
              onRetry={retrySupplier}
              shared={shared.length ? t("tr.ht.shared", { tiers: shared.map((k) => t(`tr.tier.${k}` as MessageKey)).join(` ${t("tr.and")} `) }) : null}
            />
          </div>
        )}
        {kind === "trip" && <Settings params={params} busy={busy} onChange={set} lastDeparture={data.departure} />}
      </section>

      {data.hotels_nearby.length > 0 && <HotelsNearby set={data} offer={offer} chosenId={chosenId} pendingId={busy ? params.hotel_id : undefined} busy={busy} onChoose={chooseHotel} onMap={openMap} />}
      {data.poi.length > 0 && <Places poi={data.poi} />}

      <section className="sec trip-foot" data-testid="trip-foot">
        {links.length > 1 && (
          <button className="btn btn-ink btn-block" type="button" data-testid="trip-sources" onClick={() => setSheet({ k: "sources" })}>
            <Icon name="link" size={18} />
            {t("tr.src.btn")}
          </button>
        )}
        <p className="disc dt-disc" data-testid="trip-disc">
          {t("tr.disc")}
        </p>
        <button className="dt-sup" type="button" onClick={support} data-testid="trip-support">
          <Icon name="help" size={18} />
          <span>{t("tr.sup")}</span>
          <Icon name="chevR" size={16} />
        </button>
      </section>

      {sheet?.k === "map" && <MapSheet title={sheet.title} map={sheet.map} onClose={() => setSheet(null)} />}
      {sheet?.k === "sources" && <SourcesSheet links={links} set={data} onClose={() => setSheet(null)} onMap={openMap} />}
      {sheet?.k === "deps" && <PrefEditor kind="deps" onClose={() => setSheet(null)} />}
      {sheet?.k === "budget" && <PrefEditor kind="budget" onClose={() => setSheet(null)} />}
    </>
  );
}

/* ---------------------------------------------------------------- helpers */

/** ticket only: the tier switch matters only when the source has different ticket prices (min / max). */
function ticketPricesDiffer(set: OfferSetView): boolean {
  if (!set.tiers) return false;
  const prices = new Set(
    TIERS.map((k) => {
      const tk = set.tiers![k].ticket;
      return isOk<OfferTicket>(tk) ? `${tk.price_per_person} ${tk.currency}` : "-";
    }),
  );
  return prices.size > 1;
}

function TripNotAvailable({ reason }: { reason: NonNullable<OfferSetView["trip"]["reason"]> }) {
  const { t } = useI18n();
  return (
    <section className="sec trip" data-testid="trip" data-kind="not_available" data-reason={reason} aria-labelledby="tripH">
      <TripHead />
      <Note tone={reason === "EVENT_PAST" ? undefined : "warn"} icon={reason === "EVENT_POSTPONED" ? "clock" : "info"} className="trip-na">
        <b>{t(`tr.na.${reason}.h` as MessageKey)}.</b> {t(`tr.na.${reason}.p` as MessageKey)}
      </Note>
    </section>
  );
}

/** «В вашем бюджете» / «Превышает ваш бюджет на $X» (full) and «в бюджете» / «сверх $X» (the tier switch). */
function useFitText() {
  const { t, fmt } = useI18n();
  /** fix 6.1: `full` — with what is not compared: «В вашем бюджете (без учёта билета)» */
  return (m: NonNullable<BudgetMark>, short = false, full = !short): string => {
    const ex = full ? excludesText(m.excludes, t) : "";
    const with_ = (x: string) => (ex ? `${x} (${ex})` : x);
    if (m.kind === "within") return with_(t(short ? "tr.bud.inShort" : "tr.bud.in"));
    const p = m.by ? fmt.usdDecimal(m.by) : "";
    if (short) return p ? t("tr.bud.overShort", { p }) : t("tr.bud.overShortAny");
    return with_(p ? t("tr.bud.over", { p }) : t("tr.bud.overAny"));
  };
}

/** A budget mark badge; `full` adds «(без учёта билета)» (the hotels list says it once in its note instead). */
function FitBadge({ mark, testId, full = true }: { mark: BudgetMark; testId?: string; full?: boolean }) {
  const text = useFitText();
  if (!mark) return null;
  return (
    <span className="fit-b" data-testid={testId} data-fit={mark.kind} data-excludes={mark.excludes.join(",") || undefined}>
      <Badge tone={mark.kind === "within" ? "good" : "warn"}>{text(mark, false, full)}</Badge>
    </span>
  );
}

/**
 * Economy / Comfort / Premium with the budget mark of each tier under its name. The mark is short on screen
 * («в бюджете», «сверх $110») and full for screen readers (aria-describedby: the button's name stays the tier).
 */
function TierSwitch({ set, tier, onChange }: { set: OfferSetView; tier: OfferTier; onChange: (t: OfferTier) => void }) {
  const { t } = useI18n();
  const fit = useFitText();
  const id = useId();
  const marks = TIERS.map((k) => budgetMark(set.tiers?.[k]));
  const any = marks.some(Boolean);
  return (
    <div className={any ? "seg trip-tiers has-fit" : "seg trip-tiers"} role="group" aria-label={t("tr.tiers")} data-testid="trip-tiers">
      {TIERS.map((k, i) => {
        const m = marks[i];
        return (
          <button
            key={k}
            type="button"
            aria-pressed={tier === k}
            aria-describedby={m ? `${id}-${k}` : undefined}
            data-tier={k}
            data-fit={m?.kind}
            onClick={() => {
              // fix 5.2: a tap on the tier on screen is a choice too — it no longer follows the budget recommendation
              if (tier !== k) haptic.selection();
              onChange(k);
            }}
          >
            <span>{t(`tr.tier.${k}` as MessageKey)}</span>
            {m && (
              <small className={`tier-fit ${m.kind}`} aria-hidden="true">
                {fit(m, true)}
              </small>
            )}
          </button>
        );
      })}
      {TIERS.map((k, i) => {
        const m = marks[i];
        return m ? (
          // 6.2: hidden texts for screen readers sit side by side — copied text must not run them together
          <span key={k} className="sr-only" id={`${id}-${k}`}>
            {` ${fit(m)}.`}
          </span>
        ) : null;
      })}
    </div>
  );
}

function useMoney() {
  const { fmt } = useI18n();
  return (amount: string | null | undefined) => (amount ? fmt.usdDecimal(amount) : "") || "—";
}
function TripHead({ sub }: { sub?: string }) {
  const { t } = useI18n();
  return (
    <div className="sec-h">
      <h2 id="tripH">
        {t("tr.h")}
        {sub && <small>{sub}</small>}
      </h2>
    </div>
  );
}

function TripSkeleton({ watch }: { watch?: { current: HTMLElement | null } }) {
  const { t } = useI18n();
  return (
    <section ref={(el) => void (watch && (watch.current = el))} className="sec trip" data-testid="trip-loading" aria-busy="true" aria-labelledby="tripH">
      <TripHead />
      <div className="sk trip-sk-seg" />
      <div className="sk trip-sk-pass">
        <Spinner small />
        <span>{t("tr.loading")}</span>
      </div>
      <div className="sk trip-sk-rows" />
    </section>
  );
}

function ExtBtn({ label, url, a11y, testId, icon = "ext" }: { label: string; url: string; a11y?: string; testId?: string; icon?: IconName }) {
  if (!safeLink(url)) return null;
  return (
    <button className="ext" type="button" data-testid={testId} aria-label={a11y} onClick={() => openExternal(url)}>
      {label}
      <Icon name={icon} size={14} />
    </button>
  );
}

/* ---------------------------------------------------------------- boarding pass */

function Pass(props: {
  set: OfferSetView;
  offer: Offer;
  tier: OfferTier;
  params: TripParams;
  busy: boolean;
  onTravellers: (n: number) => void;
  onAddDeparture: () => void;
  /** fix 5.2: the block picked this tier again for the new number of travellers (budget) — said under the total */
  retiered?: Retier | null;
  onRevert?: (tier: OfferTier) => void;
}) {
  const { set, offer, tier, params, busy } = props;
  const { t, tp, lang } = useI18n();
  const money = useMoney();
  const labelId = useId();
  const fl = offer.flight;
  const dest = set.trip.destination;
  const dep = set.departure;
  const origin = isOk<OfferFlight>(fl) ? fl.origin : (dep?.iata ?? null);
  const destIata = isOk<OfferFlight>(fl) ? fl.destination : (dest?.iata ?? null);
  const mid = isOk<OfferFlight>(fl) ? [transfersText(fl, t, tp), formatDuration(fl.duration_minutes, t)].filter(Boolean).join(" · ") : dep ? t("tr.pass.noFlight") : "—";
  const direct = isOk<OfferFlight>(fl) && fl.transfers === 0 && (fl.return_transfers ?? 0) === 0;
  const n = clampTravellers(params.travellers);
  const shown = set.travellers;
  const miss = missingText(offer.totals.missing, t);
  const people = `${shown} ${tp("tr.people", shown)}`;
  const hotelIn = !offer.totals.missing.includes("hotel");
  const pp = [shown > 1 ? t("tr.pp", { p: money(offer.totals.per_person) }) : "", hotelIn ? `${set.rooms} ${tp("tr.rooms", set.rooms)}` : ""].filter(Boolean).join(" · ");
  const step = (d: number) => {
    const v = clampTravellers(n + d);
    if (v === n) return;
    haptic.selection();
    props.onTravellers(v);
  };
  const nodep = !dep;
  const mark = budgetMark(offer);
  const fit = useFitText();
  const { fmt } = useI18n();
  const range = budgetRange(set.budget, fmt.usdDecimal, t);
  const hotel = passHotel(offer);
  return (
    <div className={busy ? "pass busy" : "pass"} role="group" aria-label={t("tr.pass.a11y", { from: origin ?? t("tr.pass.noCity"), to: destIata ?? dest?.city ?? "" })} data-testid="trip-pass">
      <div className="pass-top">
        <div className="pass-hd">
          <span className="lbl">{t("tr.pass")}</span>
          <span className="pass-tier" data-testid="pass-tier">
            {t(`tr.tier.${tier}` as MessageKey)}
          </span>
        </div>
        {/* fix 5.2: the hotel the total is priced with — the same tier can mean another hotel for another occupancy */}
        <p className={hotel && !hotel.inTotal ? "pass-hotel out" : "pass-hotel"} data-testid="pass-hotel" data-in-total={hotel ? String(hotel.inTotal) : "false"}>
          <Icon name="bed" size={14} />
          <span className="pass-hotel-n">{hotel ? hotel.name : t("tr.pass.noHotel")}</span>
          {hotel && !hotel.inTotal && <small>{t("tr.pass.hotelOut")}</small>}
        </p>
        <div className="pass-route">
          <div className="pass-pt">
            <b data-testid="pass-from">{origin ?? "———"}</b>
            <small>{dep?.city ?? t("tr.pass.noCity")}</small>
          </div>
          <div className="pass-mid">
            <span className="ln">
              <Icon name="plane" size={18} />
            </span>
            <small className={direct ? "direct" : undefined} data-testid="pass-mid">
              {mid}
            </small>
          </div>
          <div className="pass-pt r">
            <b data-testid="pass-to">{destIata ?? "———"}</b>
            <small>{dest?.city ?? ""}</small>
          </div>
        </div>
        <dl className="pass-f">
          <div>
            <dt className="lbl">{t("tr.f.dates")}</dt>
            <dd data-testid="pass-dates">{formatTripDates(set.trip.out_date, set.trip.back_date, lang) || "—"}</dd>
          </div>
          <div>
            <dt className="lbl">{t("tr.f.nights")}</dt>
            <dd>{set.trip.nights ?? "—"}</dd>
          </div>
          <div>
            <dt className="lbl">{t("tr.f.rooms")}</dt>
            <dd>{set.rooms}</dd>
          </div>
        </dl>
        <div className="pass-tr">
          <span className="lbl" id={labelId}>
            {t("tr.travellers")}
          </span>
          <div className="stp" role="group" aria-labelledby={labelId}>
            <button type="button" aria-label={t("tr.trav.dec")} disabled={n <= MIN_TRAVELLERS} onClick={() => step(-1)} data-testid="trav-dec">
              <Icon name="minus" size={18} />
            </button>
            <output aria-live="polite" aria-atomic="true" data-testid="trip-travellers">
              {n}
            </output>
            <button type="button" aria-label={t("tr.trav.inc")} disabled={n >= MAX_TRAVELLERS} onClick={() => step(1)} data-testid="trav-inc">
              <Icon name="plus" size={18} />
            </button>
          </div>
        </div>
        {nodep && (
          <div className="pass-nodep" data-testid="pass-nodep">
            <span>{t("tr.nodep")}</span>
            <button className="pass-cta" type="button" onClick={props.onAddDeparture} data-testid="trip-add-dep">
              <Icon name="plus" size={18} />
              {t("tr.nodep.add")}
            </button>
          </div>
        )}
      </div>
      <div className="pass-bot">
        {busy && (
          <div className="pass-busy" role="status">
            <Spinner small />
            {t("tr.recalc")}
          </div>
        )}
        <div className="pass-tot">
          <div className="grow">
            <small className="lbl" data-testid="pass-total-label">
              {miss ? t("tr.tot.part", { n: people, m: miss }) : t("tr.tot", { n: people })}
            </small>
            <div className="pass-sum">
              <b className="num" data-testid="trip-total">
                {money(offer.totals.total)}
              </b>
            </div>
            {pp && <p className="pass-pp">{pp}</p>}
          </div>
          <div className="pass-code" aria-hidden="true">
            <i className="bars" />
            <span>{[destIata, wallDay(set.trip.out_date, lang)].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        {mark && (
          <p className={`pass-fit ${mark.kind}`} data-testid="pass-fit" data-fit={mark.kind}>
            <b>
              <Icon name={mark.kind === "within" ? "check" : "alert"} size={14} />
              {fit(mark)}
            </b>
            {range && <span className="pass-fit-r">{t("tr.bud.pp", { r: range })}</span>}
          </p>
        )}
        {props.retiered && (
          <div className="pass-re" role="status" data-testid="trip-retier-row">
            <Icon name="spark" size={16} />
            <span className="grow" data-testid="trip-retier" data-from={props.retiered.from} data-to={props.retiered.to}>
              {t("tr.retier", { tier: t(`tr.tier.${props.retiered.to}` as MessageKey), n: `${props.retiered.travellers} ${tp("tr.people", props.retiered.travellers)}` })}
            </span>
            <button type="button" className="pass-re-b" onClick={() => props.onRevert?.(props.retiered!.from)}>
              {t("tr.retier.back", { tier: t(`tr.tier.${props.retiered.from}` as MessageKey) })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Freshness({ set, stale, busy, limited, onRefresh }: { set: OfferSetView; stale: boolean; busy: boolean; limited: boolean; onRefresh: () => void }) {
  const { t, lang } = useI18n();
  const at = priceTime(set.generated_at, lang);
  return (
    <div className={stale ? "fresh-bar warn mt12" : "fresh-bar mt12"} data-testid="trip-fresh" data-stale={stale || undefined} role={stale ? "status" : undefined}>
      <Icon name={stale ? "alert" : "clock"} size={16} />
      <span>{stale ? t("tr.fresh.stale", { t: at }) : t("tr.fresh", { t: at, u: priceTime(set.expires_at, lang) })}</span>
      {/* «Обновить» only once the offer is out of date: a fresh set is reused by the server anyway */}
      {stale && (
        <button type="button" onClick={onRefresh} disabled={busy || limited} data-testid="trip-refresh">
          {busy ? <Spinner small /> : <Icon name="refresh" size={16} />}
          {t("tr.fresh.btn")}
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- rows */

function Row(props: {
  kind: "ticket" | "flight" | "hotel";
  icon: IconName;
  title: string;
  lines: ReactNode[];
  fresh?: string | null;
  actions?: ReactNode;
  price: string;
  small?: string | null;
  na?: boolean;
  /** priced, but not in the total (hotel on the event dates) */
  out?: boolean;
  /** priced in another currency without a rate: not in the total, the price itself stays as the site gives it */
  excluded?: boolean;
}) {
  return (
    <div className={props.na ? "li na" : props.out ? "li out" : "li"} data-testid={`trip-row-${props.kind}`} data-status={props.na ? "unavailable" : "ok"} data-in-total={props.na || props.out || props.excluded ? "false" : "true"}>
      <span className="li-i">
        <Icon name={props.icon} size={18} />
      </span>
      <div className="li-t">
        <b>{props.title}</b>
        {props.lines.map((l, i) =>
          l ? (
            <span className="sub" key={i}>
              {l}
            </span>
          ) : null,
        )}
        {props.fresh && (
          <span className="fresh">
            <Icon name="check" size={12} />
            {props.fresh}
          </span>
        )}
        {props.actions && <div className="li-a">{props.actions}</div>}
      </div>
      <div className="li-p">
        <span className="num">{props.price}</span>
        {props.small && <small>{props.small}</small>}
      </div>
    </div>
  );
}

function TicketRow({ ticket, tier, travellers }: { ticket: Offer["ticket"]; tier: OfferTier; travellers: number }) {
  const { t, lang, fmt } = useI18n();
  const money = useMoney();
  if (!isOk<OfferTicket>(ticket)) {
    return <Row kind="ticket" icon="ticket" title={t("tr.li.ticket")} lines={[t(unavailableKey("ticket", ticket.reason))]} price="—" small={t("tr.na.notInSum")} na />;
  }
  const prov = ticketProvider(ticket);
  const host = hostOf(ticket.deeplink);
  // USD in the total: the USD price, or (fix 5.1) the price converted at the CBU rate; else the site's own currency
  const usd = ticketUsd(ticket);
  const each = usd ? money(usd) : formatMoney(ticket.price_per_person, ticket.currency, lang);
  const price = usd ? money(mulAmount(usd, travellers)) : each;
  const fxLine = ticketFxLine(ticket, lang, t, fmt.usdDecimal);
  return (
    <Row
      kind="ticket"
      icon="ticket"
      title={t("tr.li.ticket")}
      lines={[
        t(tier === "premium" ? "tr.tk.max" : "tr.tk.min"),
        fxLine ? (
          <span className="fx-t" data-testid="ticket-fx">
            {fxLine}
          </span>
        ) : null,
        usd ? null : t("tr.tk.notInTotal"),
      ]}
      fresh={t("tr.priceAt", { p: prov, t: priceTime(ticket.fetched_at, lang) })}
      actions={<ExtBtn label={t("tr.go.ticket")} url={ticket.deeplink} a11y={t("tr.go.a11y", { w: t("tr.go.ticket"), d: host || prov })} testId="go-ticket" />}
      price={price}
      small={usd ? (travellers > 1 ? t("tr.mul", { p: each, n: travellers }) : null) : t("tr.tk.each")}
      excluded={!usd}
    />
  );
}

/** «Попробовать снова» of a flight / hotel whose supplier did not answer (fix 5.1 E). */
function RetryBtn({ what, busy, onRetry, testId }: { what: string; busy: boolean; onRetry: () => void; testId: string }) {
  const { t } = useI18n();
  return (
    <button className="btn btn-sm btn-soft na-retry" type="button" data-testid={testId} disabled={busy} aria-label={t("tr.na.again.a11y", { w: what })} onClick={onRetry}>
      {busy ? <Spinner small /> : <Icon name="refresh" size={14} />}
      {t("tr.na.again")}
    </button>
  );
}

function FlightRow({ flight, set, busy = false, onRetry }: { flight: Offer["flight"]; set: OfferSetView; busy?: boolean; onRetry?: () => void }) {
  const { t, tp, lang } = useI18n();
  const money = useMoney();
  if (!isOk<OfferFlight>(flight)) {
    const retry = onRetry && isProviderDown(flight) ? <RetryBtn what={t("tr.li.flight")} busy={busy} onRetry={onRetry} testId="flight-retry" /> : null;
    // fix 5.2: the supplier does not know the route — no «Попробовать снова» (asking again changes nothing), a link to search on Aviasales
    const search = routeSearchLink(flight);
    const searchBtn = search ? (
      <ExtBtn label={t("tr.go.flightSearch")} url={search} a11y={t("tr.go.a11y", { w: t("tr.go.flightSearch"), d: hostOf(search) })} testId="flight-search" />
    ) : null;
    return (
      <Row
        kind="flight"
        icon="plane"
        title={t("tr.li.flight")}
        lines={[<span data-reason={flight.reason}>{t(unavailableKey("flight", flight.reason, false, !!search))}</span>]}
        price="—"
        small={t("tr.na.notInSum")}
        actions={retry ?? searchBtn}
        na
      />
    );
  }
  const from = set.departure ? `${set.departure.city} (${flight.origin})` : flight.origin;
  const to = set.trip.destination ? `${set.trip.destination.city} (${flight.destination})` : flight.destination;
  // код авиакомпании необязателен (поставщик не всегда его отдаёт): без него номер рейса не показываем
  const code = flight.airline ? [flight.airline, flight.flight_number].filter(Boolean).join(" ") : null;
  const info = [code, transfersText(flight, t, tp), formatDuration(flight.duration_minutes, t)].filter(Boolean).join(" · ");
  const shifted = flight.dates_shifted ? t("tr.fl.shifted", { d: [wallDay(flight.depart_at, lang), wallDay(flight.return_at, lang)].filter(Boolean).join(" – ") }) : null;
  return (
    <Row
      kind="flight"
      icon="plane"
      title={t("tr.li.flight")}
      lines={[t("tr.fl.route", { a: from, b: to }), info, shifted ? <em className="warn-t">{shifted}</em> : null]}
      fresh={t("tr.priceAt", { p: sourceLabel(flight.provider), t: priceTime(flight.fetched_at, lang) })}
      actions={<ExtBtn label={t("tr.go.flight")} url={flight.deeplink} a11y={t("tr.go.a11y", { w: t("tr.go.flight"), d: hostOf(flight.deeplink) })} testId="go-flight" />}
      price={money(flight.total)}
      small={set.travellers > 1 ? t("tr.mul", { p: money(flight.price_per_person), n: set.travellers }) : null}
    />
  );
}

function HotelRow(props: {
  hotel: Offer["hotel"];
  nearVenue: boolean;
  outOfTotal: boolean;
  onMap: (title: string, map: MapLinks) => void;
  /** the user chose the hotel in «Отели рядом» (hotel_chosen_by = "user") */
  chosen?: boolean;
  /** «Вернуть подбор»; absent while a calculation runs */
  onReset?: () => void;
  busy?: boolean;
  /** «Попробовать снова» when the hotel supplier did not answer */
  onRetry?: () => void;
  /** fix 6.1: «Других отелей рядом не нашлось — этот же отель в тарифе …» */
  shared?: string | null;
}) {
  const { hotel, nearVenue, outOfTotal, onMap, chosen } = props;
  const { t, tp, lang } = useI18n();
  const money = useMoney();
  const reset = chosen ? (
    <button className="ext" type="button" data-testid="hotel-reset" disabled={!props.onReset} onClick={props.onReset}>
      {t("tr.htl.reset")}
      <Icon name="refresh" size={14} />
    </button>
  ) : null;
  if (!isOk<OfferHotel>(hotel)) {
    const retry = props.onRetry && isProviderDown(hotel) ? <RetryBtn what={t("tr.li.hotel")} busy={!!props.busy} onRetry={props.onRetry} testId="hotel-retry" /> : null;
    return (
      <Row
        kind="hotel"
        icon="bed"
        title={t("tr.li.hotel")}
        lines={[<span data-reason={hotel.reason}>{t(unavailableKey("hotel", hotel.reason, nearVenue && !chosen))}</span>]}
        price="—"
        small={t("tr.na.notInSum")}
        actions={
          retry || reset ? (
            <>
              {retry}
              {reset}
            </>
          ) : null
        }
        na
      />
    );
  }
  const nn = `${hotel.nights} ${tp("tr.nights", hotel.nights)}`;
  const facts = [hotel.stars ? t("tr.ht.stars", { n: hotel.stars }) : "", t("tr.ht.rating", { r: formatRating(hotel.rating, lang) }), hotel.refundable ? t("tr.ht.refund") : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <Row
      kind="hotel"
      icon="bed"
      title={t("tr.li.hotelName", { n: hotel.name })}
      lines={[
        t("tr.ht.sub", { nn, d: formatDistance(hotel.distance_m, lang, t) }),
        facts,
        // HOTEL_PRICES_PARTIAL: the flight moved to nearby dates, the hotel price is for the event dates — out of the total
        outOfTotal ? (
          <em className="warn-t" data-testid="hotel-event-dates">
            {t("tr.ht.eventDates")}
          </em>
        ) : null,
        chosen ? (
          <em className="chosen-t" data-testid="hotel-chosen">
            {t("tr.ht.chosen")}
          </em>
        ) : null,
        props.shared ? (
          <em className="warn-t" data-testid="hotel-shared">
            {props.shared}
          </em>
        ) : null,
      ]}
      fresh={t("tr.priceAt", { p: hostOf(hotel.deeplink) || sourceLabel(hotel.provider), t: priceTime(hotel.fetched_at, lang) })}
      actions={
        <>
          <ExtBtn label={t("tr.go.hotel")} url={hotel.deeplink} a11y={t("tr.go.a11y", { w: t("tr.go.hotel"), d: hostOf(hotel.deeplink) })} testId="go-hotel" />
          {mapItems(hotel.map).length > 0 && (
            <button className="ext" type="button" data-testid="hotel-map" onClick={() => onMap(hotel.name, hotel.map)}>
              {t("tr.onMap")}
              <Icon name="pin" size={14} />
            </button>
          )}
          {reset}
        </>
      }
      price={money(hotel.total)}
      small={outOfTotal ? t("tr.ht.notInTotal") : hotel.rooms > 1 ? `${hotel.rooms} ${tp("tr.rooms", hotel.rooms)} · ${nn}` : t("tr.ht.for", { nn })}
      out={outOfTotal}
    />
  );
}

/* ---------------------------------------------------------------- ticket only (online / same city) */

function TicketOnly({ set, offer, ev }: { set: OfferSetView; offer: Offer; ev: EventDetailView }) {
  const { t, lang, fmt } = useI18n();
  const money = useMoney();
  const reason = set.trip.reason === "SAME_CITY" ? "SAME_CITY" : "ONLINE_EVENT";
  const tk = offer.ticket;
  const ok = isOk<OfferTicket>(tk);
  const official = safeLink(ev.official_url);
  return (
    <div className="panel ticket-only mt12" data-testid="trip-ticket-only" data-reason={reason}>
      <div className="to-h">
        <span className="li-i">
          <Icon name={reason === "SAME_CITY" ? "pin" : "monitor"} size={18} />
        </span>
        <div className="grow">
          <b>{t(`tr.to.${reason}.h` as MessageKey)}</b>
          <p className="hint">{t(`tr.to.${reason}.p` as MessageKey)}</p>
        </div>
      </div>
      {ok ? (
        <div className="to-p">
          <div className="grow">
            <b className="big num" data-testid="trip-total">
              {ticketUsd(tk) ? money(ticketUsd(tk)) : formatMoney(tk.price_per_person, tk.currency, lang)}
            </b>
            {ticketFxLine(tk, lang, t, fmt.usdDecimal) && (
              <span className="fx-t" data-testid="ticket-fx">
                {ticketFxLine(tk, lang, t, fmt.usdDecimal)}
              </span>
            )}
            <span className="fresh">
              <Icon name="check" size={12} />
              {t("tr.priceAt", { p: ticketProvider(tk), t: priceTime(tk.fetched_at, lang) })}
            </span>
          </div>
          <ExtBtn label={t("tr.go.ticket")} url={tk.deeplink} a11y={t("tr.go.a11y", { w: t("tr.go.ticket"), d: hostOf(tk.deeplink) })} testId="go-ticket" />
        </div>
      ) : (
        <div className="to-p">
          <p className="hint grow">{t(unavailableKey("ticket", tk.reason))}</p>
          {official && <ExtBtn label={t("dt.cta.more")} url={official} testId="go-ticket" />}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- recalculation settings */

function Settings({ params, busy, onChange, lastDeparture }: { params: TripParams; busy: boolean; onChange: (p: Partial<TripParams>) => void; lastDeparture: OfferSetView["departure"] }) {
  const { profile, config } = useApp();
  const { t, tp, lang } = useI18n();
  // fix 6.3: the hotel settings of this trip over the profile's — each control says «как в профиле» / «изменено»
  const hp = profile?.preferences.hotel_prefs ?? null;
  const trip = filtersOf(params);
  const defaultRating = config?.hotel_rating_min ?? DEFAULT_HOTEL_RATING;
  const asProfile = hotelValues(hp, null, defaultRating);
  const now = hotelValues(hp, trip, defaultRating);
  const mark = (changed: boolean) => ({ text: changed ? t("tr.set.changed") : t("tr.set.asProfile"), changed });
  const pickHotel = (field: "rating_min" | "max_distance_km" | "min_stars", v: number, base: number) => onChange({ hotel_filters: pickTripHotel(trip, field, v, base) });
  const hotelSummary = trip
    ? t("tr.sum.hotelSet", {
        c: [
          trip.max_distance_km !== undefined ? t("tr.cond.dist", { km: t("tr.dist.km", { n: now.distance }) }) : "",
          trip.rating_min !== undefined ? (now.rating ? t("tr.cond.rating", { r: hotelRatingLabel(now.rating, lang, "") }) : t("tr.cond.anyRating")) : "",
          trip.min_stars !== undefined ? (now.stars ? t("tr.cond.stars", { n: now.stars }) : t("p.v.ht.anyStars")) : "",
        ]
          .filter(Boolean)
          .join(", "),
      })
    : "";
  const [open, setOpen] = useState(false);
  const deps = profile?.preferences.departures ?? [];
  const fp = profile?.preferences.flight_prefs;
  const forcedDirect = !!fp && fp.direct && !fp.connecting;
  // the alternative hub picked from the plate is shown as a chosen city too
  const extra =
    params.departure_iata && !deps.some((d) => d.airport_iata === params.departure_iata)
      ? [{ airport_iata: params.departure_iata, city: lastDeparture?.iata === params.departure_iata ? lastDeparture.city : params.departure_iata }]
      : [];
  const cities = [...deps.map((d) => ({ airport_iata: d.airport_iata, city: d.city })), ...extra];
  const depCity = cities.find((c) => c.airport_iata === params.departure_iata)?.city;
  const summary = [
    depCity ? t("tr.sum.dep", { c: depCity }) : "",
    params.direct_only ? t("tr.sum.direct") : "",
    params.near_venue ? t("tr.sum.near") : "",
    params.hotel_id ? t("tr.sum.hotel") : "",
    hotelSummary,
    params.extra_nights ? `+${params.extra_nights} ${tp("tr.nights", params.extra_nights)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const id = useId();
  return (
    <div className="panel trip-set mt12" data-testid="trip-settings">
      <button className="trip-set-h" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} data-testid="trip-settings-toggle">
        <span className="lrow-i">
          <Icon name="sliders" size={18} />
        </span>
        <span className="grow">
          <b>{t("tr.set.h")}</b>
          <small>{summary || t("tr.set.default")}</small>
        </span>
        <Icon name="chevD" size={18} className={open ? "rot" : undefined} />
      </button>
      {open && (
        <div id={id} className="trip-set-b">
          {cities.length > 0 && (
            <div className="trip-dep">
              <span className="lbl" id={`${id}-dep`}>
                {t("tr.set.dep")}
              </span>
              <div className="wrap" role="radiogroup" aria-labelledby={`${id}-dep`}>
                <Chip role="radio" pressed={params.departure_iata === null} disabled={busy && params.departure_iata !== null} onToggle={() => onChange({ departure_iata: null })} testId="dep-auto">
                  {t("tr.set.depAuto")}
                </Chip>
                {cities.map((c) => (
                  <Chip
                    key={c.airport_iata}
                    role="radio"
                    pressed={params.departure_iata === c.airport_iata}
                    onToggle={() => onChange({ departure_iata: c.airport_iata })}
                    testId={`dep-${c.airport_iata}`}
                  >
                    {c.city}
                    <small>{c.airport_iata}</small>
                  </Chip>
                ))}
              </div>
            </div>
          )}
          <ToggleRow
            title={t("tr.set.direct")}
            sub={forcedDirect ? t("tr.set.directProfile") : null}
            on={params.direct_only || forcedDirect}
            disabled={forcedDirect}
            onChange={(v) => onChange({ direct_only: v })}
            icon="plane"
          />
          <ToggleRow title={t("tr.set.near")} sub={t("tr.set.nearSub")} on={params.near_venue} onChange={(v) => onChange({ near_venue: v })} icon="pin" />
          <div className="trow trip-nights">
            <span className="lrow-i">
              <Icon name="moon" size={18} />
            </span>
            <div className="trow-t">
              <b>{t("tr.set.nights")}</b>
              <small>{t("tr.set.nightsSub")}</small>
            </div>
            <Seg
              className="trip-nights-seg"
              value={params.extra_nights}
              label={t("tr.set.nights")}
              options={Array.from({ length: MAX_EXTRA_NIGHTS + 1 }, (_, i) => ({ value: i, label: i ? `+${i}` : "0" }))}
              onChange={(v) => onChange({ extra_nights: v })}
            />
          </div>
          <div className="trip-hotel" data-testid="trip-hotel-set">
            <div className="trip-hotel-h">
              <span className="lrow-i">
                <Icon name="bed" size={18} />
              </span>
              <b className="grow">{t("tr.set.hotel")}</b>
              {trip && (
                <button className="lnk" type="button" onClick={() => onChange({ hotel_filters: null })} data-testid="trip-hotel-reset">
                  {t("tr.set.hotelReset")}
                </button>
              )}
            </div>
            <HotelPicker
              idPrefix={`${id}-hotel`}
              rating={now.rating}
              distance={now.distance}
              stars={now.stars}
              defaultRating={defaultRating}
              marks={{ rating: mark(trip?.rating_min !== undefined), distance: mark(trip?.max_distance_km !== undefined), stars: mark(trip?.min_stars !== undefined) }}
              onRating={(v) => pickHotel("rating_min", v, asProfile.rating)}
              onDistance={(v) => pickHotel("max_distance_km", v, asProfile.distance)}
              onStars={(v) => pickHotel("min_stars", v, asProfile.stars)}
            />
          </div>
          {/* the hotels kept for the travellers (fix 5.2) are not a setting: no «Сбросить» for them */}
          {hasOverrides({ ...params, keep_hotels: null }) && (
            <button
              className="lnk mt12"
              type="button"
              onClick={() => onChange({ departure_iata: null, direct_only: false, near_venue: false, extra_nights: 0, hotel_id: null, hotel_filters: null })}
              data-testid="trip-reset"
            >
              <Icon name="refresh" size={14} />
              {t("tr.set.reset")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- nearby */

function HotelsNearby(props: {
  set: OfferSetView;
  offer: Offer;
  chosenId: string | null;
  /** the hotel being chosen (or null: given back to the rules) while the calculation runs */
  pendingId: string | null | undefined;
  busy: boolean;
  onChoose: (id: string | null) => void;
  onMap: (title: string, map: MapLinks) => void;
}) {
  const { set, offer, chosenId, pendingId, busy, onChoose, onMap } = props;
  const { t, tp, lang } = useI18n();
  const money = useMoney();
  // fix 6.1: a widened search names its step («Отели · до 15 км · 7,5+»), hotels beyond the base are tagged
  const hs = set.hotel_search;
  const r = formatRating(hs?.widened ? hs.rating_min : set.rating_min, lang);
  const n = set.travellers;
  const nights = set.trip.nights;
  const stay = nights ? t("tr.ht.for", { nn: `${nights} ${tp("tr.nights", nights)}` }) : t("tr.htl.stay");
  // within the budget first (by distance), over the budget below (by price)
  const hotels = sortHotels(set.hotels_nearby).slice(0, 8);
  const inTrip = isOk<OfferHotel>(offer.hotel) ? offer.hotel.hotel_id : null;
  const marked = hotels.some((h) => budgetMark(h));
  return (
    <section className="sec" data-testid="trip-hotels">
      <div className="sec-h">
        <h2>
          {/* 6.3: the user's distance (not 5 km) is named too */}
          {hs && (hs.widened || hs.from_prefs) ? t("tr.htl.hWide", { km: formatRadius(hs.radius_m, lang, t), r }) : t("tr.htl.h", { r })}
          <small>{t("tr.htl.sub", { r })}</small>
        </h2>
      </div>
      <div className="panel">
        {marked && (
          <p className="htl-note hint" data-testid="trip-hotels-note">
            {[t("tr.htl.budgetNote"), excludesText(hotels.map((h) => budgetMark(h)?.excludes ?? []).find((x) => x.length) ?? [], t)].filter(Boolean).join(", ")}
          </p>
        )}
        {hotels.map((h: NearbyHotel) => {
          const mark = budgetMark(h);
          const wide = beyondBase(h, hs);
          const chosen = chosenId === h.hotel_id;
          const pending = busy && pendingId !== undefined && (chosen ? pendingId === null : pendingId === h.hotel_id);
          return (
            <div className={chosen ? "htl-r chosen" : "htl-r"} key={h.hotel_id} data-testid="trip-hotel" data-hotel-id={h.hotel_id} data-fit={mark?.kind ?? "unknown"} data-chosen={chosen || undefined}>
              <b>{h.name}</b>
              <span className="sub">{[t("tr.htl.dist", { d: formatDistance(h.distance_m, lang, t) }), h.stars ? t("tr.ht.stars", { n: h.stars }) : ""].filter(Boolean).join(" · ")}</span>
              <span className="score">
                <b aria-hidden="true">{formatRating(h.rating, lang)}</b>
                <span className="sr-only">{t("tr.ht.rating", { r: formatRating(h.rating, lang) })}</span>
                <small className="num" data-testid="hotel-price">
                  {money(h.price_total)}
                </small>
                <small>{stay}</small>
                {n > 1 && h.per_person_share && (
                  <small className="pp" data-testid="hotel-pp">
                    {t("tr.pp", { p: money(h.per_person_share) })}
                  </small>
                )}
              </span>
              {(chosen || mark || wide.far || wide.lowRating || wide.lowStars || (inTrip === h.hotel_id && !chosenId)) && (
                <div className="htl-tags">
                  {chosen ? (
                    <span data-testid="hotel-chosen-badge">
                      <Badge tone="lime">{t("tr.htl.chosen")}</Badge>
                    </span>
                  ) : (
                    inTrip === h.hotel_id &&
                    !chosenId && (
                      <span data-testid="hotel-in-trip">
                        <Badge>{t("tr.htl.inTrip")}</Badge>
                      </span>
                    )
                  )}
                  <FitBadge mark={mark} testId="hotel-fit" full={false} />
                  {wide.far && hs && (
                    <span data-testid="hotel-far">
                      <Badge tone="info">{t("tr.htl.far", { km: formatRadius(hs.base_radius_m, lang, t) })}</Badge>
                    </span>
                  )}
                  {wide.lowRating && hs && (
                    <span data-testid="hotel-low">
                      <Badge tone="info">{t("tr.htl.lowRating", { r: formatRating(hs.base_rating_min, lang) })}</Badge>
                    </span>
                  )}
                  {wide.lowStars && hs?.base_min_stars && (
                    <span data-testid="hotel-low-stars">
                      <Badge tone="info">{t("tr.htl.lowStars", { n: hs.base_min_stars })}</Badge>
                    </span>
                  )}
                </div>
              )}
              <div className="li-a">
                {chosen ? (
                  <button className="btn btn-sm btn-soft" type="button" data-testid="hotel-unchoose" disabled={busy} onClick={() => onChoose(null)}>
                    {pending ? <Spinner small /> : <Icon name="refresh" size={14} />}
                    {t("tr.htl.reset")}
                  </button>
                ) : (
                  <button
                    className="btn btn-sm htl-pick"
                    type="button"
                    data-testid="hotel-choose"
                    disabled={busy}
                    aria-label={t("tr.htl.choose.a11y", { n: h.name })}
                    onClick={() => onChoose(h.hotel_id)}
                  >
                    {pending && <Spinner small />}
                    {t("tr.htl.choose")}
                  </button>
                )}
                <ExtBtn label={t("tr.htl.open")} url={h.deeplink} a11y={t("tr.go.a11y", { w: `${t("tr.htl.open")} ${h.name}`, d: hostOf(h.deeplink) })} />
                {mapItems(h.map).length > 0 && (
                  <button className="ext" type="button" onClick={() => onMap(h.name, h.map)}>
                    {t("tr.onMap")}
                    <Icon name="pin" size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Places({ poi }: { poi: NearbyPoi[] }) {
  const { t, lang } = useI18n();
  return (
    <section className="sec" data-testid="trip-poi">
      <div className="sec-h">
        <h2>
          {t("tr.poi.h")}
          <small>{t("tr.poi.sub")}</small>
        </h2>
      </div>
      <div className="poi">
        {poi
          .filter((p) => safeLink(p.url))
          .slice(0, 10)
          .map((p) => {
            const site = safeLink(p.website);
            return (
              <div key={`${p.osm_type}-${p.osm_id}`} className="poi-c">
                <button type="button" className="poi-i" data-testid="trip-poi-item" aria-label={t("tr.poi.open", { n: p.name })} onClick={() => openExternal(p.url)}>
                  <b>{p.name}</b>
                  <small>{t(poiKindKey(p.kind))}</small>
                  <span className="mono">
                    <Icon name="pin" size={13} />
                    {t("tr.poi.dist", { d: formatDistance(p.distance_m, lang, t) })}
                  </span>
                </button>
                {site && (
                  // the place's own site: any https domain (not a supplier) — marked as an external site
                  <button type="button" className="ext poi-site" data-testid="poi-site" aria-label={t("tr.poi.site.a11y", { n: p.name, d: hostOf(site) })} onClick={() => openExternal(site)}>
                    {t("tr.poi.site")}
                    <Icon name="ext" size={14} />
                  </button>
                )}
              </div>
            );
          })}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- sheets */

function MapSheet({ title, map, onClose }: { title: string; map: MapLinks; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Sheet title={t("tr.map.h")} sub={title} onClose={onClose}>
      <div className="srcs" data-testid="map-menu">
        {mapItems(map).map((m) => (
          <button
            key={m.key}
            type="button"
            className="srcs-r"
            data-testid={`map-${m.key}`}
            onClick={() => {
              openExternal(m.url);
              onClose();
            }}
          >
            <span className="li-i">
              <Icon name="pin" size={18} />
            </span>
            <span>
              <b>{t(`tr.map.${m.key}` as MessageKey)}</b>
              <small>{hostOf(m.url)}</small>
            </span>
            <Icon name="ext" size={16} />
          </button>
        ))}
      </div>
    </Sheet>
  );
}

const LINK_ICON: Record<PackageLink["kind"], IconName> = { ticket: "ticket", flight: "plane", hotel: "bed", venue: "pin" };

function SourcesSheet({ links, set, onClose, onMap }: { links: PackageLink[]; set: OfferSetView; onClose: () => void; onMap: (title: string, map: MapLinks) => void }) {
  const { t, lang } = useI18n();
  const money = useMoney();
  const venue = set.trip.destination?.venue ?? null;
  return (
    <Sheet title={t("tr.src.btn")} sub={t("tr.src.sub")} onClose={onClose}>
      <div className="srcs" data-testid="sources-sheet">
        {links.map((l) => {
          if (l.kind === "venue") {
            return (
              <button key="venue" type="button" className="srcs-r" data-testid="src-venue" onClick={() => venue && onMap(venue.name, venue.map)}>
                <span className="li-i">
                  <Icon name="pin" size={18} />
                </span>
                <span>
                  <b>{t("tr.map.venue")}</b>
                  <small>{l.object}</small>
                </span>
                <Icon name="chevR" size={16} />
              </button>
            );
          }
          const price = l.amount ? (l.currency === "USD" ? money(l.amount) : formatMoney(l.amount, l.currency ?? "", lang)) : "";
          // the hotel supplier is a booking API the user does not know: name the service and the site that opens
          const who = [l.kind === "hotel" ? t("tr.src.hotelProv") : l.provider, l.host].filter((x, i, a) => x && a.indexOf(x) === i).join(" · ");
          const meta = [price, l.fetched_at ? t("tr.src.at", { t: priceTime(l.fetched_at, lang) }) : "", l.outOfTotal ? t("tr.ht.notInTotal") : ""].filter(Boolean).join(" · ");
          return (
            <button key={l.kind} type="button" className="srcs-r" data-testid={`src-${l.kind}`} onClick={() => openExternal(l.url)}>
              <span className="li-i">
                <Icon name={LINK_ICON[l.kind]} size={18} />
              </span>
              <span>
                <b>{[t(`tr.li.${l.kind}` as MessageKey), l.object].filter(Boolean).join(" · ")}</b>
                <small>{who}</small>
                <small>{meta}</small>
                {l.outOfTotal && (
                  <small className="warn-t" data-testid="src-hotel-event-dates">
                    {t("tr.ht.eventDates")}
                  </small>
                )}
              </span>
              <Icon name="ext" size={16} />
            </button>
          );
        })}
      </div>
      <Note icon="info" className="mt12">
        {t("tr.src.note")}
      </Note>
    </Sheet>
  );
}
