import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfferSnapshotAdmin, TravelProviderStatus } from "@tilhero/contracts/admin";
import { OffersApi, TravelApi } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { I18nProvider, translate, type Lang } from "../src/i18n";
import { ru, type MessageKey } from "../src/i18n/ru";
import { PROVIDER_META, PROVIDER_STATES, TRAVEL_ERROR_CODES, TRAVEL_PROVIDERS, errorIsLatest, providerState, quotaLevel, summary, travelErrorLabel } from "../src/screens/travel/travel";
import { ProviderCard, TravelPage } from "../src/screens/travel/Travel";
import {
  COMPONENT_REASONS,
  OFFER_NOTES,
  OFFER_STATUSES,
  OFFER_TIERS,
  TRIP_REASONS,
  codeLabel,
  fmtMoney,
  fmtTripDate,
  foreignSnapshot,
  httpsLink,
  isExpired,
  localClock,
  toOfferView,
} from "../src/screens/support/offer";
import { OfferSnapshot } from "../src/screens/support/OfferSnapshot";

/* Sprint 5: «Trip providers» screen and the «Offer snapshot» block of a support ticket. */

const tRu = (k: MessageKey) => translate("ru", k);
const ui = (node: ReactNode, lang: Lang = "ru") => render(<I18nProvider initial={lang}>{node}</I18nProvider>);
const has = (k: string) => k in ru;
afterEach(cleanup);

const prov = (p: Partial<TravelProviderStatus> = {}): TravelProviderStatus => ({
  name: "aviasales",
  configured: true,
  enabled: true,
  quota: { day_used: 412, day_limit: 20000 },
  breaker: "closed",
  last_error: null,
  last_success_at: "2026-10-11T06:58:00Z",
  ...p,
});

const OFFER_ID = "0ffe0000-0000-4000-8000-000000000001";
const USER_ID = "5f1c2a3b-4d5e-4f60-8a71-92b3c4d5e603";
function snap(p: Partial<OfferSnapshotAdmin> = {}, offer: Record<string, unknown> = {}): OfferSnapshotAdmin {
  return {
    offer_id: OFFER_ID,
    user_id: USER_ID,
    event_id: "e1000000-0000-4000-8000-000000000042",
    tier: "comfort",
    travellers: 2,
    created_at: "2026-10-11T07:00:00Z",
    expires_at: "2099-10-11T08:00:00Z",
    offer: {
      offer_id: OFFER_ID,
      tier: "comfort",
      status: "complete",
      ticket: { status: "ok", price_per_person: "85.00", currency: "USD", in_total: true, provider: "ticketmaster", deeplink: "https://www.ticketmaster.com/e/1", fetched_at: "2026-10-11T06:40:00Z" },
      flight: {
        status: "ok", provider: "aviasales", origin: "TAS", destination: "ALA", depart_at: "2026-11-13T07:40:00+05:00", return_at: "2026-11-16T19:05:00+06:00",
        airline: "HY", flight_number: "763", transfers: 0, return_transfers: 1, price_per_person: "142.00", total: "284.00",
        deeplink: "https://www.aviasales.com/search/TAS1311ALA16111", fetched_at: "2026-10-11T06:59:00Z", dates_shifted: true,
      },
      hotel: {
        status: "ok", provider: "liteapi", name: "Rixos Almaty", stars: 5, rating: "9.1", distance_m: 1830, nights: 3, rooms: 1, total: "390.00",
        refundable: true, board: "Breakfast included", deeplink: "https://book.tilhero.app/hotels/lp1beec", map: { osm: "https://www.openstreetmap.org/?mlat=1" }, fetched_at: "2026-10-11T06:59:30Z",
      },
      totals: { total: "844.00", per_person: "422.00", currency: "USD", missing: [] },
      expires_at: "2099-10-11T08:00:00Z",
      ...offer,
    },
    trip: { kind: "trip", reason: null, destination: { city: "Алматы", country_code: "KZ", iata: "ALA", venue: { name: "Almaty Arena", precision: "venue" } }, out_date: "2026-11-13", back_date: "2026-11-16", nights: 3 },
    departure: { iata: "TAS", city: "Ташкент", chosen_by: "cheapest" },
    notes: [],
    ...p,
  };
}

describe("trip providers: state of a card", () => {
  it("one state per card, the most important first", () => {
    expect(providerState(prov({ configured: false, enabled: false, breaker: "open" }))).toBe("not_configured");
    expect(providerState(prov({ enabled: false, breaker: "open" }))).toBe("disabled");
    expect(providerState(prov({ breaker: "open", quota: { day_used: 9, day_limit: 9 } }))).toBe("breaker_open");
    expect(providerState(prov({ breaker: "half_open" }))).toBe("breaker_half");
    expect(providerState(prov({ quota: { day_used: 20000, day_limit: 20000 } }))).toBe("quota_exhausted");
    expect(providerState(prov({ last_error: { code: "PROVIDER_RATE_LIMITED", reason: null, message: null, at: "2026-10-11T07:00:00Z", http_status: null } }))).toBe("failing");
    expect(providerState(prov({ last_error: { code: "PROVIDER_RATE_LIMITED", reason: null, message: null, at: "2026-10-11T06:00:00Z", http_status: null } }))).toBe("ok"); // success after the error
    expect(providerState(prov({ last_success_at: null }))).toBe("idle");
    expect(providerState(prov())).toBe("ok");
  });

  it("an error without a time counts only when there was no success; quota 0/0 is not «exhausted»", () => {
    expect(errorIsLatest(prov({ last_error: { code: "X", reason: null, message: null, at: null as unknown as string, http_status: null } }))).toBe(false);
    expect(errorIsLatest(prov({ last_success_at: null, last_error: { code: "X", reason: null, message: null, at: null as unknown as string, http_status: null } }))).toBe(true);
    expect(providerState(prov({ quota: { day_used: 0, day_limit: 0 } }))).toBe("ok");
    expect(quotaLevel({ day_used: 15_999, day_limit: 20_000 })).toBe("ok");
    expect(quotaLevel({ day_used: 16_000, day_limit: 20_000 })).toBe("warn");
    expect(quotaLevel({ day_used: 20_000, day_limit: 20_000 })).toBe("bad");
    expect(quotaLevel(null)).toBe("ok");
  });

  it("summary: working (ok / not called yet) vs needing attention", () => {
    expect(summary([prov(), prov({ name: "liteapi", breaker: "open" }), prov({ name: "osm", configured: false })])).toEqual({ working: 1, total: 3, attention: 2 });
    expect(summary([prov(), prov({ name: "osm", last_success_at: null })])).toEqual({ working: 2, total: 2, attention: 0 });
  });

  it("error codes have a human label; an unknown code stays visible", () => {
    expect(travelErrorLabel(tRu, "PROVIDER_UNAVAILABLE")).toBe("Поставщик недоступен или не ответил вовремя");
    expect(travelErrorLabel(tRu, "SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("every provider tells which Railway variables to set on provider-gateway (§1.7)", () => {
    expect(PROVIDER_META.aviasales.vars.map((v) => v.name)).toEqual(["TRAVELPAYOUTS_TOKEN", "TRAVELPAYOUTS_MARKER", "TRAVELPAYOUTS_TRS"]);
    expect(PROVIDER_META.liteapi.vars.filter((v) => !v.optional).map((v) => v.name)).toEqual(["LITEAPI_KEY", "LITEAPI_WHITELABEL_URL"]);
    expect(PROVIDER_META.osm.vars.map((v) => v.name)).toEqual(["OSM_CONTACT_EMAIL"]);
  });
});

describe("trip providers: card and screen", () => {
  it("not configured: the hint names the variables, the token is marked as a secret", () => {
    ui(<ProviderCard p={prov({ configured: false, quota: null, last_success_at: null })} />);
    expect(screen.getByTestId("trv-state-aviasales")).toHaveTextContent("Не настроен");
    const setup = screen.getByTestId("trv-setup-aviasales");
    expect(setup).toHaveTextContent("Railway → provider-gateway → Variables");
    expect(within(setup).getByText("TRAVELPAYOUTS_TOKEN").parentElement).toHaveTextContent("секрет");
    expect(within(setup).getByText("TRAVELPAYOUTS_MARKER").parentElement).toHaveTextContent("необязательно");
    expect(screen.getByTestId("trv-quota-aviasales")).toHaveTextContent("нет данных");
  });

  it("LiteAPI with an open breaker: state, code with a human label and time; OSM error without a time", () => {
    ui(<ProviderCard p={prov({ name: "liteapi", breaker: "open", last_error: { code: "PROVIDER_UNAVAILABLE", reason: null, message: null, at: "2026-10-11T06:50:00Z", http_status: null } })} />);
    expect(screen.getByTestId("trv-state-liteapi")).toHaveTextContent("Breaker открыт");
    const err = screen.getByTestId("trv-last-error-liteapi");
    expect(err).toHaveTextContent("Поставщик недоступен или не ответил вовремя");
    expect(err).toHaveTextContent("PROVIDER_UNAVAILABLE");
    expect(err).toHaveTextContent("11.10.2026");
    cleanup();
    ui(<ProviderCard p={prov({ name: "osm", last_error: { code: "PROVIDER_NOT_CONFIGURED", reason: null, message: null, at: null as unknown as string, http_status: null } })} />, "en");
    expect(screen.getByTestId("trv-last-error-osm")).toHaveTextContent("time unknown");
    expect(screen.getByTestId("trv-osm")).toHaveTextContent("OpenStreetMap");
  });

  it("screen: summary over the cards; 503 FEATURE_UNAVAILABLE is a calm notice, not a crash", async () => {
    vi.spyOn(TravelApi, "providers").mockResolvedValueOnce({ items: [prov(), prov({ name: "liteapi", breaker: "open" }), prov({ name: "osm", configured: false })] });
    ui(<TravelPage />);
    expect(await screen.findByTestId("trv-summary")).toHaveTextContent("Требуют внимания: 2 из 3");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Aviasales", "LiteAPI", "OpenStreetMap"]);
    cleanup();
    vi.spyOn(TravelApi, "providers").mockRejectedValueOnce(new ApiError(503, { code: "FEATURE_UNAVAILABLE", message: "", trace_id: "t", details: { service: "provider-gateway" } }));
    ui(<TravelPage />);
    expect(await screen.findByTestId("trv-error")).toHaveTextContent("Раздел ещё не настроен");
  });
});

describe("offer snapshot: view of the normalized snapshot", () => {
  it("reads the snapshot; flight times are the wall clock of the departure place", () => {
    const v = toOfferView(snap())!;
    expect(v).toMatchObject({ tier: "comfort", travellers: 2, status: "complete", total: "844.00", perPerson: "422.00", missing: [] });
    expect(v.flight).toMatchObject({ status: "ok", origin: "TAS", transfers: 0, returnTransfers: 1, datesShifted: true });
    expect(localClock("2026-11-13T07:40:00+05:00")).toEqual({ date: "13.11", time: "07:40" });
    expect(localClock("вчера")).toBeNull();
    expect(fmtTripDate("2026-11-13")).toBe("13.11.2026");
    expect(fmtTripDate(null)).toBe("—");
  });

  it("defence in depth: non-https links are not clickable, a damaged component is «unavailable / BAD_DATA»", () => {
    const v = toOfferView(
      snap({}, {
        ticket: { status: "ok", price_per_person: "85.00", currency: "USD", in_total: true, provider: "tm", deeplink: "javascript:alert(1)" },
        flight: { status: "ok", origin: "TAS" },
        hotel: { status: "maybe" },
      }),
    )!;
    expect(v.ticket).toMatchObject({ status: "ok", link: null });
    expect(v.flight).toEqual({ status: "unavailable", reason: "BAD_DATA" });
    expect(v.hotel).toEqual({ status: "unavailable", reason: "BAD_DATA" });
    for (const bad of ["http://x.com", "javascript:alert(1)", "https://user:pw@x.com", "https://localhost", "data:text/html,1", 5]) expect(httpsLink(bad), String(bad)).toBeNull();
    expect(toOfferView(snap({}, { totals: null }))).toBeNull();
    expect(toOfferView(snap({ tier: "vip" as never }))).toBeNull();
  });

  it("money, expiry, foreign snapshot, labels", () => {
    expect(fmtMoney("142.00", "USD", "ru")).toBe("$142.00");
    expect(fmtMoney("450000.00", "UZS", "en")).toBe("450,000 UZS");
    const v = toOfferView(snap({ expires_at: "2026-10-11T08:00:00Z" }))!;
    expect(isExpired(v, Date.parse("2026-10-11T08:00:00Z"))).toBe(true);
    expect(isExpired(v, Date.parse("2026-10-11T07:59:59Z"))).toBe(false);
    expect(foreignSnapshot(v, USER_ID.toUpperCase())).toBe(false);
    expect(foreignSnapshot(v, "5f1c2a3b-4d5e-4f60-8a71-92b3c4d5e601")).toBe(true);
    expect(foreignSnapshot(v, null)).toBe(false);
    expect(codeLabel(tRu, "reason", "NO_DEPARTURE")).toBe("Город вылета не указан");
    expect(codeLabel(tRu, "note", "NEW_NOTE")).toBe("NEW_NOTE");
  });
});

describe("offer snapshot: block in the ticket context", () => {
  it("fix 5.1: a ticket in KGS converted at the CBU rate — «≈ $309 at the CBU rate of 11.10 · 27 000 KGS», in the total", async () => {
    const ticket = {
      status: "ok", price_per_person: "27000.00", currency: "KGS", in_total: true, provider: "aiweb.ticket-kg", deeplink: "https://ticket.kg/event/shakira",
      fetched_at: "2026-10-11T06:40:00Z", fx: { price_per_person_usd: "309.00", rate: "0.011451", date: "2026-10-11", source: "cbu.uz" },
    };
    vi.spyOn(OffersApi, "snapshot").mockResolvedValueOnce(snap({}, { ticket }));
    ui(<OfferSnapshot offerId={OFFER_ID} ticketUserId={USER_ID} />);
    await screen.findByTestId("osn-body");
    const row = screen.getByTestId("osn-ticket");
    expect(row).toHaveTextContent("≈ $309");
    expect(screen.getByTestId("osn-fx")).toHaveTextContent("по курсу ЦБ РУз на 11.10 · 27 000 KGS");
    expect(row).not.toHaveTextContent("не входит в сумму");
    expect(toOfferView(snap({}, { ticket: { ...ticket, fx: { ...ticket.fx, source: "evil.example" }, in_total: false } }))!.ticket).toMatchObject({ fx: null, inTotal: false });
    cleanup();
    vi.spyOn(OffersApi, "snapshot").mockResolvedValueOnce(snap({}, { ticket }));
    ui(<OfferSnapshot offerId={OFFER_ID} ticketUserId={USER_ID} />, "en");
    expect(await screen.findByTestId("osn-fx")).toHaveTextContent("at the CBU rate of 11.10 · 27,000 KGS");
  });

  it("renders tier, travellers, dates, items with links and the total", async () => {
    vi.spyOn(OffersApi, "snapshot").mockResolvedValueOnce(snap());
    ui(<OfferSnapshot offerId={OFFER_ID} ticketUserId={USER_ID} />);
    const body = await screen.findByTestId("osn-body");
    expect(screen.getByTestId("osn-tier")).toHaveTextContent("Комфорт");
    expect(screen.getByTestId("osn-travellers")).toHaveTextContent("2 человека · 1 номер");
    expect(screen.getByTestId("osn-dates")).toHaveTextContent("13.11.2026 → 16.11.2026 · 3 ночи");
    expect(screen.getByTestId("osn-flight")).toHaveTextContent("TAS → ALA");
    expect(screen.getByTestId("osn-flight")).toHaveTextContent("туда 13.11 07:40");
    expect(screen.getByTestId("osn-flight")).toHaveTextContent("прямой / 1 пересадка");
    expect(screen.getByTestId("osn-hotel")).toHaveTextContent("1.8 км до площадки");
    expect(screen.getByTestId("osn-link-flight")).toHaveAttribute("href", "https://www.aviasales.com/search/TAS1311ALA16111");
    expect(screen.getByTestId("osn-link-flight")).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(screen.getByTestId("osn-total")).toHaveTextContent("$844.00");
    expect(screen.getByTestId("osn-valid")).toBeInTheDocument();
    expect(within(body).queryByTestId("osn-foreign")).toBeNull();
  });

  it("unavailable flight, ticket not in USD, missing parts; EN", async () => {
    vi.spyOn(OffersApi, "snapshot").mockResolvedValueOnce(
      snap({ notes: ["TICKET_NOT_USD"], expires_at: "2020-01-01T08:00:00Z", departure: null }, {
        status: "partial",
        ticket: { status: "ok", price_per_person: "450000.00", currency: "UZS", in_total: false, provider: "aiweb.iticket-uz", deeplink: null },
        flight: { status: "unavailable", reason: "NO_DEPARTURE" },
        totals: { total: "390.00", per_person: "195.00", currency: "USD", missing: ["ticket", "flight"] },
      }),
    );
    ui(<OfferSnapshot offerId={OFFER_ID} ticketUserId={USER_ID} />, "en");
    await screen.findByTestId("osn-body");
    expect(screen.getByTestId("osn-flight")).toHaveTextContent("No departure city");
    expect(screen.getByTestId("osn-ticket")).toHaveTextContent("450,000 UZS");
    expect(screen.getByTestId("osn-ticket")).toHaveTextContent("not in the total (not USD)");
    expect(screen.getByTestId("osn-nolink-ticket")).toBeInTheDocument();
    expect(screen.getByTestId("osn-missing")).toHaveTextContent("Not in the total: ticket, flight");
    expect(screen.getByTestId("osn-expired")).toHaveTextContent("Expired");
    expect(screen.getByTestId("osn-notes")).toHaveTextContent("The ticket price is not in USD");
  });

  it("HOTEL_PRICES_PARTIAL: the hotel is shown for the event dates and is out of the total", async () => {
    vi.spyOn(OffersApi, "snapshot").mockResolvedValueOnce(
      snap({ notes: ["FLIGHT_DATES_SHIFTED", "HOTEL_PRICES_PARTIAL"] }, { status: "partial", totals: { total: "454.00", per_person: "227.00", currency: "USD", missing: ["hotel"] } }),
    );
    ui(<OfferSnapshot offerId={OFFER_ID} ticketUserId={USER_ID} />);
    await screen.findByTestId("osn-body");
    expect(screen.getByTestId("osn-hotel-event-dates")).toHaveTextContent("не входит в сумму · Цена — на даты события, не на даты перелёта");
    expect(screen.getByTestId("osn-notes")).toHaveTextContent("отель показан на даты события и в сумму не входит");
    expect(screen.getByTestId("osn-missing")).toHaveTextContent("отель");
  });

  it("a hotel in the total has no «event dates» mark", async () => {
    vi.spyOn(OffersApi, "snapshot").mockResolvedValueOnce(snap());
    ui(<OfferSnapshot offerId={OFFER_ID} ticketUserId={USER_ID} />);
    await screen.findByTestId("osn-body");
    expect(screen.queryByTestId("osn-hotel-event-dates")).toBeNull();
  });

  it("errors: 404 — removed after 30 days; FEATURE_UNAVAILABLE — OFFERS_URL; other — retry; not a UUID — no request", async () => {
    const spy = vi.spyOn(OffersApi, "snapshot").mockRejectedValueOnce(new ApiError(404, { code: "OFFER_NOT_FOUND", message: "", trace_id: "t", details: {} }));
    ui(<OfferSnapshot offerId={OFFER_ID} ticketUserId={USER_ID} />);
    expect(await screen.findByTestId("osn-not-found")).toHaveTextContent("30 дней");
    cleanup();
    spy.mockRejectedValueOnce(new ApiError(503, { code: "FEATURE_UNAVAILABLE", message: "", trace_id: "t", details: { service: "offers" } }));
    ui(<OfferSnapshot offerId={OFFER_ID} ticketUserId={USER_ID} />);
    expect(await screen.findByTestId("osn-feature-off")).toHaveTextContent("OFFERS_URL");
    cleanup();
    spy.mockRejectedValueOnce(new ApiError(503, { code: "UPSTREAM_UNAVAILABLE", message: "", trace_id: "t", details: { service: "offers" } }));
    ui(<OfferSnapshot offerId={OFFER_ID} ticketUserId={USER_ID} />);
    expect(await screen.findByTestId("osn-error")).toHaveTextContent("Повторить");
    cleanup();
    spy.mockClear();
    ui(<OfferSnapshot offerId="off_987" ticketUserId={USER_ID} />);
    expect(screen.getByTestId("osn-bad-id")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("a snapshot of another user is flagged; damaged skeleton → «data damaged»", async () => {
    vi.spyOn(OffersApi, "snapshot").mockResolvedValueOnce(snap());
    ui(<OfferSnapshot offerId={OFFER_ID} ticketUserId="5f1c2a3b-4d5e-4f60-8a71-92b3c4d5e601" />);
    expect(await screen.findByTestId("osn-foreign")).toHaveTextContent("другому пользователю");
    cleanup();
    vi.spyOn(OffersApi, "snapshot").mockResolvedValueOnce(snap({}, { totals: "x" }));
    ui(<OfferSnapshot offerId={OFFER_ID} ticketUserId={USER_ID} />);
    expect(await screen.findByTestId("osn-damaged")).toBeInTheDocument();
  });
});

describe("sprint 5 dictionary", () => {
  it("every key family built at runtime exists in RU (EN parity is checked by i18n.test)", () => {
    const want = [
      "page.travel",
      ...TRAVEL_PROVIDERS.flatMap((n) => [`trv.name.${n}`, `trv.role.${n}`, `trv.uses.${n}`]),
      ...PROVIDER_STATES.map((s) => `trv.state.${s}`),
      ...["closed", "open", "half_open"].flatMap((b) => [`trv.breaker.${b}`, `trv.breaker.${b}.h`]),
      ...TRAVEL_ERROR_CODES.map((c) => `trv.err.${c}`),
      ...TRAVEL_PROVIDERS.flatMap((n) => PROVIDER_META[n].vars.map((v) => `trv.var.${v.name}`)),
      ...OFFER_TIERS.map((x) => `offer.tier.${x}`),
      ...OFFER_STATUSES.map((x) => `offer.status.${x}`),
      ...["ticket_only", "not_available"].map((x) => `offer.kind.${x}`),
      ...COMPONENT_REASONS.map((x) => `offer.reason.${x}`),
      ...TRIP_REASONS.map((x) => `offer.trip.${x}`),
      ...OFFER_NOTES.map((x) => `offer.note.${x}`),
      ...["ticket", "flight", "hotel"].map((x) => `osn.c.${x}`),
      ...["cheapest", "user"].map((x) => `osn.chosen.${x}`),
      "err.OFFER_NOT_FOUND",
    ];
    expect(want.filter((k) => !has(k))).toEqual([]);
  });
});
