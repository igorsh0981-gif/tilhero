import { useCallback, useEffect, useState, type ReactNode } from "react";
import { OffersApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId } from "../../lib/ids";
import { useNow } from "../../lib/useNow";
import { Icon, type IconName } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Callout, CopyBtn, cx, Pill, Spinner } from "../../ui/kit";
import {
  OFFER_STATUS_TONE,
  UUID_RE,
  codeLabel,
  fmtApproxUsd,
  fmtMoney,
  fmtTripDate,
  foreignSnapshot,
  fxDay,
  isExpired,
  localClock,
  toOfferView,
  type FlightView,
  type HotelView,
  type OfferView,
  type TicketView,
  type Unavailable,
} from "./offer";
import { webHref } from "../../lib/url";

type Load = { state: "loading" } | { state: "ready"; view: OfferView | null } | { state: "error"; error: unknown };

/**
 * «Offer snapshot» in the context column of a ticket whose Mini App context carries an offer_id: the trip package the
 * user saw (tier, travellers, dates, ticket / flight / hotel with price, provider, time and link, total, validity).
 */
export function OfferSnapshot({ offerId, ticketUserId }: { offerId: string; ticketUserId: string | null }) {
  const { t } = useI18n();
  const valid = UUID_RE.test(offerId);
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const fetchIt = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      setLoad({ state: "ready", view: toOfferView(await OffersApi.snapshot(offerId)) });
    } catch (e) {
      setLoad({ state: "error", error: e });
    }
  }, [offerId]);

  useEffect(() => {
    if (valid) void fetchIt();
  }, [valid, fetchIt]);

  return (
    <div className="ctx-sec osn" data-testid="ctx-offer">
      <h3>
        <Icon name="luggage" />
        {t("osn.title")}
      </h3>
      {!valid ? (
        <p className="small muted" data-testid="osn-bad-id">
          {t("osn.badId")}
        </p>
      ) : load.state === "loading" ? (
        <Spinner label={t("common.loading")} />
      ) : load.state === "error" ? (
        <SnapshotError error={load.error} onRetry={() => void fetchIt()} />
      ) : !load.view ? (
        <Callout kind="warn" icon="alert" testId="osn-damaged">
          {t("osn.damaged")}
        </Callout>
      ) : (
        <SnapshotBody v={load.view} ticketUserId={ticketUserId} />
      )}
    </div>
  );
}

function SnapshotError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useI18n();
  if (error instanceof ApiError && (error.code === "OFFER_NOT_FOUND" || error.status === 404))
    return (
      <Callout icon="inbox" testId="osn-not-found">
        <b>{t("osn.notFound")}</b> {t("osn.notFoundH")}
      </Callout>
    );
  if (error instanceof ApiError && error.code === "FEATURE_UNAVAILABLE")
    return (
      <Callout kind="info" icon="sliders" testId="osn-feature-off">
        {t("osn.featureOff")}
      </Callout>
    );
  return <LoadError error={error} onRetry={onRetry} testId="osn-error" />;
}

function SnapshotBody({ v, ticketUserId }: { v: OfferView; ticketUserId: string | null }) {
  const { t, tp, fmt, lang } = useI18n();
  const now = useNow();
  const expired = isExpired(v, now);
  const trip = v.trip;
  const rooms = v.hotel.status === "ok" ? v.hotel.rooms : null;
  return (
    <div className="osn-b" data-testid="osn-body" data-offer={v.offerId}>
      <div className="osn-tags">
        <Pill tone="accent" dot={false} testId="osn-tier">
          {t(`offer.tier.${v.tier}` as MessageKey)}
        </Pill>
        <Pill tone={OFFER_STATUS_TONE[v.status]} testId="osn-status">
          {t(`offer.status.${v.status}` as MessageKey)}
        </Pill>
        {expired ? (
          <Pill tone="neutral" testId="osn-expired">
            {t("osn.expired")}
          </Pill>
        ) : (
          <Pill tone="info" testId="osn-valid">
            {t("osn.valid")}
          </Pill>
        )}
      </div>

      {foreignSnapshot(v, ticketUserId) && (
        <Callout kind="bad" icon="alert" testId="osn-foreign">
          {t("osn.foreign")}
        </Callout>
      )}

      <dl className="kv osn-kv">
        <dt>{t("osn.travellers")}</dt>
        <dd data-testid="osn-travellers">
          {tp("osn.people", v.travellers)}
          {rooms ? ` · ${tp("osn.rooms", rooms)}` : ""}
        </dd>
        {trip?.outDate && (
          <>
            <dt>{t("osn.dates")}</dt>
            <dd data-testid="osn-dates">
              <span className="mono">
                {fmtTripDate(trip.outDate)} → {fmtTripDate(trip.backDate)}
              </span>
              {trip.nights != null && <span className="muted"> · {tp("osn.nights", trip.nights)}</span>}
            </dd>
          </>
        )}
        <dt>{t("osn.from")}</dt>
        <dd>
          {v.departure ? (
            <>
              <span className="mono b">{v.departure.iata}</span> {v.departure.city}
              <span className="xs muted block">{t(`osn.chosen.${v.departure.chosen_by}` as MessageKey)}</span>
            </>
          ) : (
            <span className="muted">{t("osn.noDeparture")}</span>
          )}
        </dd>
        {trip && (trip.city || trip.venue) && (
          <>
            <dt>{t("osn.to")}</dt>
            <dd>
              {trip.city ?? "—"}
              {trip.iata && <span className="mono muted"> · {trip.iata}</span>}
              {trip.venue && <span className="xs muted block wrap-any">{trip.venue}</span>}
            </dd>
          </>
        )}
        <dt>{t("osn.created")}</dt>
        <dd className="mono">{fmt.dateTime(v.createdAt)}</dd>
        <dt>{t("osn.expires")}</dt>
        <dd className={cx("mono", expired && "muted")} data-testid="osn-expires">
          {fmt.dateTime(v.expiresAt)}
        </dd>
      </dl>

      {trip && trip.kind !== "trip" && trip.reason && (
        <Callout icon="info" testId="osn-trip-kind">
          <b>{t(`offer.kind.${trip.kind}` as MessageKey)}</b> {codeLabel(t, "trip", trip.reason)}
        </Callout>
      )}

      <ul className="osn-items" aria-label={t("osn.items")}>
        <Row kind="ticket" icon="ticket" c={v.ticket} travellers={v.travellers} missing={v.missing.includes("ticket")} />
        <Row kind="flight" icon="plane" c={v.flight} travellers={v.travellers} missing={v.missing.includes("flight")} />
        <Row kind="hotel" icon="bed" c={v.hotel} travellers={v.travellers} missing={v.missing.includes("hotel")} />
      </ul>

      <div className="osn-total" data-testid="osn-total">
        <div className="osn-total-l">
          <span className="xs muted">{t("osn.total")}</span>
          <span className="osn-total-v">{fmtMoney(v.total, "USD", lang)}</span>
        </div>
        <div className="osn-total-r xs muted">{t("osn.perPerson", { x: fmtMoney(v.perPerson, "USD", lang) })}</div>
        {v.missing.length > 0 && (
          <div className="osn-missing xs" data-testid="osn-missing">
            <Icon name="alertCircle" />
            {t("osn.missing", { x: v.missing.map((m) => t(`osn.c.${m}` as MessageKey).toLowerCase()).join(", ") })}
          </div>
        )}
      </div>

      {v.notes.length > 0 && (
        <ul className="osn-notes" data-testid="osn-notes">
          {v.notes.map((n) => (
            <li key={n}>
              <Icon name="info" />
              <span>{codeLabel(t, "note", n)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="osn-id xs muted">
        <span>offer_id</span>
        <span className="mono">{shortId(v.offerId, 8, 4)}</span>
        <CopyBtn value={v.offerId} label="offer_id" />
        <span className="osn-disc">{t("osn.disclaimer")}</span>
      </div>
    </div>
  );
}

function Row({ kind, icon, c, travellers, missing }: { kind: "ticket" | "flight" | "hotel"; icon: IconName; c: TicketView | FlightView | HotelView | Unavailable; travellers: number; missing: boolean }) {
  const { t, tp, fmt, lang } = useI18n();
  const label = t(`osn.c.${kind}` as MessageKey);
  if (c.status === "unavailable")
    return (
      <li className="osn-row is-na" data-testid={`osn-${kind}`} data-status="unavailable">
        <span className="osn-ico" aria-hidden="true">
          <Icon name={icon} />
        </span>
        <div className="osn-main">
          <div className="osn-head">
            <span className="osn-l">{label}</span>
            <b className="osn-amt is-out">—</b>
          </div>
          <div className="osn-sub">
            {codeLabel(t, "reason", c.reason)} <code className="code-chip">{c.reason}</code>
          </div>
        </div>
      </li>
    );

  let sub: ReactNode = null;
  let price = "";
  let unit = "";
  if (c.status === "ok" && "inTotal" in c) {
    // fix 5.1: a non-USD ticket converted at the CBU rate is in the total — «≈ $309 at the CBU rate of 11.10 · 27 000 KGS»
    price = c.fx ? fmtApproxUsd(c.fx.usd) : fmtMoney(c.pricePerPerson, c.currency, lang);
    unit = t("osn.unit.person");
    sub = (
      <>
        <span className="mono">{c.provider}</span>
        {c.fx && (
          <span className="osn-fx" data-testid="osn-fx" title={`1 ${c.currency} = ${c.fx.rate} USD`}>
            {" "}
            · {t("osn.fx", { d: fxDay(c.fx.date), orig: fmtMoney(c.pricePerPerson, c.currency, lang) })}
          </span>
        )}
        {!c.inTotal && <span className="osn-flag"> · {t("osn.notInTotal")}</span>}
      </>
    );
  } else if (c.status === "ok" && "origin" in c) {
    const out = localClock(c.departAt);
    const back = c.returnAt ? localClock(c.returnAt) : null;
    price = fmtMoney(c.total, "USD", lang);
    unit = c.pricePerPerson ? t("osn.unit.flight", { x: fmtMoney(c.pricePerPerson, "USD", lang), n: travellers }) : "";
    const stops = (n: number | null) => (n == null ? "" : n === 0 ? t("osn.direct") : tp("osn.stops", n));
    sub = (
      <>
        <span className="mono b">
          {c.origin} → {c.destination}
        </span>
        {(c.airline || c.flightNumber) && (
          <span className="mono">
            {" "}
            · {c.airline ?? ""}
            {c.flightNumber ? ` ${c.flightNumber}` : ""}
          </span>
        )}
        <span className="block">
          {out && t("osn.out", { d: out.date, t: out.time })}
          {back && ` · ${t("osn.back", { d: back.date, t: back.time })}`}
        </span>
        <span className="block">
          {stops(c.transfers)}
          {c.returnTransfers != null && c.returnTransfers !== c.transfers ? ` / ${stops(c.returnTransfers)}` : ""}
          {c.datesShifted && <span className="osn-flag"> · {t("osn.shifted")}</span>}
        </span>
        <span className="mono">{c.provider}</span>
      </>
    );
  } else if (c.status === "ok" && "name" in c) {
    price = fmtMoney(c.total, "USD", lang);
    unit = [c.nights ? tp("osn.nights", c.nights) : "", c.rooms ? tp("osn.rooms", c.rooms) : ""].filter(Boolean).join(" · ");
    sub = (
      <>
        <span className="b wrap-any">{c.name}</span>
        <span className="block">
          {c.stars ? `${"★".repeat(Math.min(5, c.stars))} · ` : ""}
          {c.rating && t("osn.rating", { x: c.rating })}
          {c.distanceM != null && ` · ${t("osn.distance", { x: c.distanceM >= 1000 ? `${(c.distanceM / 1000).toFixed(1)} ${t("osn.km")}` : `${c.distanceM} ${t("osn.m")}` })}`}
        </span>
        {(c.board || c.refundable != null) && (
          <span className="block">
            {c.board ?? ""}
            {c.board && c.refundable != null ? " · " : ""}
            {c.refundable === true ? t("osn.refundable") : c.refundable === false ? t("osn.nonRefundable") : ""}
          </span>
        )}
        <span className="mono">{c.provider}</span>
        {/* HOTEL_PRICES_PARTIAL: the flight moved to nearby dates, the hotel price is for the event dates — not in the total */}
        {missing && (
          <span className="block osn-flag" data-testid="osn-hotel-event-dates">
            {t("osn.hotelNotInTotal")} · {t("osn.hotelEventDates")}
          </span>
        )}
      </>
    );
  }
  const link = webHref(c.link);
  const map = "mapLink" in c ? webHref(c.mapLink) : null;
  return (
    <li className={cx("osn-row", missing && "is-missing")} data-testid={`osn-${kind}`} data-status="ok">
      <span className="osn-ico" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <div className="osn-main">
        <div className="osn-head">
          <span className="osn-l">{label}</span>
          <b className={cx("osn-amt", missing && "is-out")}>{price}</b>
        </div>
        {unit && <div className="osn-unit xs muted">{unit}</div>}
        <div className="osn-sub">{sub}</div>
        <div className="osn-acts">
          {c.fetchedAt && <span className="xs muted">{t("osn.priceAt", { x: fmt.dateTime(c.fetchedAt) })}</span>}
          {link ? (
            <a className="osn-link" href={link} target="_blank" rel="noopener noreferrer nofollow" data-testid={`osn-link-${kind}`}>
              <Icon name="ext" />
              {t("osn.open")}
            </a>
          ) : (
            <span className="xs muted" data-testid={`osn-nolink-${kind}`}>
              {t("osn.noLink")}
            </span>
          )}
          {map && (
            <a className="osn-link" href={map} target="_blank" rel="noopener noreferrer nofollow">
              <Icon name="mapPin" />
              {t("osn.map")}
            </a>
          )}
        </div>
      </div>
    </li>
  );
}
