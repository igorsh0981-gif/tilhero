import type { EventDetailView, Offer, OfferSetView, Profile } from "@tilhero/contracts/bff";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as F from "../e2e/fixtures/data";
import { buildOfferSet, type OfferBuildOpts } from "../e2e/fixtures/offers";
import { ApiClient } from "../src/api/client";
import { createApi, type Api } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import * as I18nForms from "../src/i18n";
import { I18nProvider, translate, type Lang } from "../src/i18n";
import { TripBlock, TripBoundary } from "../src/screens/events/Trip";
import { AppContext, type AppCtx } from "../src/state/app";
import { keyboardOverlap } from "../src/ui/overlays";
import {
  budgetKey,
  budgetMark,
  budgetRange,
  chosenHotelId,
  DEFAULT_PARAMS,
  formatDistance,
  formatDuration,
  formatTripDates,
  fromCents,
  hasOverrides,
  initialTier,
  isExpired,
  mapItems,
  missingText,
  mulAmount,
  offersCall,
  offerSupportContext,
  packageLinks,
  priceTime,
  sortHotels,
  toCents,
  transfersText,
  unavailableKey,
  approxUsd,
  fxDate,
  hasProviderFailure,
  isProviderDown,
  siteMoney,
  ticketFxLine,
  ticketUsd,
  wallClock,
  wallDay,
  hotelSwaps,
  keepOf,
  passHotel,
  retier,
  tierHotels,
  beyondBase,
  excludesText,
  formatRadius,
  sharedHotelTiers,
  keepFallback,
} from "../src/trip/logic";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ALMATY = F.tripEvents()[0]!;
const F1 = F.catalogEvents()[0]!;
const tr = (lang: Lang) => (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(lang, k, v);
const tp = (k: Parameters<typeof translate>[1], n: number) => (n === 1 ? translate("ru", k).split("|")[0]! : n < 5 ? translate("ru", k).split("|")[1]! : translate("ru", k).split("|")[2]!);

const opts = (o: Partial<OfferBuildOpts> = {}): OfferBuildOpts => ({
  travellers: 1,
  departures: F.filledPreferences().departures,
  flightPrefs: { direct: true, connecting: true, alternative_departure: true },
  overrides: {},
  seq: 7,
  ...o,
});
const almatySet = (o: Partial<OfferBuildOpts> = {}) => buildOfferSet(ALMATY, opts(o));
const DUBAI = F.tripEvents()[3]!;
const B12 = { min: "1000.00", max: "2000.00" };
const dubaiSet = (o: Partial<OfferBuildOpts> = {}) => buildOfferSet(DUBAI, opts({ budget: B12, ...o }));
const BISHKEK = F.tripEvents()[4]!;
const bishkekSet = (o: Partial<OfferBuildOpts> = {}) => buildOfferSet(BISHKEK, opts({ budget: B12, ...o }));
// fix 5.2: prod 11.10 — Bishkek 17–19 Oct, no ticket / flight price, hotels priced per occupancy
const BISHKEK_PROD = F.tripEvents()[5]!;
const prodSet = (o: Partial<OfferBuildOpts> = {}) => buildOfferSet(BISHKEK_PROD, opts({ departures: [{ airport_iata: "TAS", city: "Tashkent", country_code: "UZ" }], ...o }));
type RecalcBody = Parameters<Api["offers"]["recalculate"]>[1];
// fix 6.1: prod 12.10 — F1 Abu Dhabi, 1 traveller, no ticket price, flight on nearby dates, the hotel search widened
const ABU = F.tripEvents()[6]!;
const ABU_ONE = F.tripEvents()[7]!;
const TAS_ONLY = [{ airport_iata: "TAS", city: "Tashkent", country_code: "UZ" }];
const B3K = { min: null, max: "3000.00" };
const abuSet = (o: Partial<OfferBuildOpts> = {}) => buildOfferSet(ABU, opts({ departures: TAS_ONLY, budget: B3K, ...o }));
// fix 6.2: prod 12.10 after 6.1 — the same race against $1 000–2 000, nothing fits
const ABU62 = F.tripEvents()[8]!;
const abu62Set = (o: Partial<OfferBuildOpts> = {}) => buildOfferSet(ABU62, opts({ departures: TAS_ONLY, budget: B12, ...o }));

/* ================================================================ pure logic */

describe("which call a set of parameters needs", () => {
  it("no overrides → GET with travellers (BFF reads departures and flight preferences from the profile)", () => {
    expect(offersCall(DEFAULT_PARAMS)).toEqual({ method: "GET", travellers: 1 });
    expect(offersCall({ ...DEFAULT_PARAMS, travellers: 4 })).toEqual({ method: "GET", travellers: 4 });
  });
  it("any override → POST /recalculate with the whole parameter set; values are clamped, a bad IATA is dropped", () => {
    expect(offersCall({ ...DEFAULT_PARAMS, direct_only: true })).toEqual({ method: "POST", body: { travellers: 1, direct_only: true, near_venue: false, extra_nights: 0 } });
    expect(offersCall({ travellers: 9, departure_iata: "ALA", direct_only: false, near_venue: true, extra_nights: 7, hotel_id: null, keep_hotels: null, hotel_filters: null })).toEqual({
      method: "POST",
      body: { travellers: 6, departure_iata: "ALA", direct_only: false, near_venue: true, extra_nights: 3 },
    });
    expect(offersCall({ ...DEFAULT_PARAMS, travellers: 0, departure_iata: "ala" })).toEqual({ method: "POST", body: { travellers: 1, direct_only: false, near_venue: false, extra_nights: 0 } });
  });
});

describe("fix 5.2: travellers change — keep_hotels, the tier, the hotel in the pass", () => {
  it("keep_hotels → POST with valid ids only; with hotel_id it is not sent; empty → nothing", () => {
    const keep = { economy: "fru5", comfort: "fru3", premium: "fru2" };
    expect(offersCall({ ...DEFAULT_PARAMS, travellers: 2, keep_hotels: keep })).toEqual({
      method: "POST",
      body: { travellers: 2, direct_only: false, near_venue: false, extra_nights: 0, keep_hotels: keep },
    });
    expect(keepOf({ hotel_id: null, keep_hotels: { premium: "../x", comfort: "fru3" } })).toEqual({ comfort: "fru3" });
    expect(keepOf({ hotel_id: "lp2", keep_hotels: keep })).toBeNull();
    expect(keepOf({ hotel_id: null, keep_hotels: {} })).toBeNull();
    expect(hasOverrides({ ...DEFAULT_PARAMS, keep_hotels: {} })).toBe(false);
    expect(offersCall({ ...DEFAULT_PARAMS, hotel_id: "lp2", keep_hotels: keep })).toEqual({
      method: "POST",
      body: { travellers: 1, direct_only: false, near_venue: false, extra_nights: 0, hotel_id: "lp2" },
    });
  });

  it("tierHotels: the rule hotels of a trip set; none for the user's hotel or a ticket-only set", () => {
    expect(tierHotels(prodSet())).toEqual({ economy: "fru5", comfort: "fru3", premium: "fru2" });
    expect(tierHotels(prodSet({ travellers: 2 }))).toEqual({ economy: "fru5", comfort: "fru3", premium: "fru1" });
    expect(tierHotels(prodSet({ overrides: { hotel_id: "fru4" } }))).toBeNull();
    expect(tierHotels(almatySet({ hotelDown: true }))).toBeNull();
    expect(tierHotels(buildOfferSet(F.catalogEvents()[5]!, opts()))).toBeNull(); // online: ticket only
  });

  it("retier: only a tier the block picked, only a budget recommendation", () => {
    const two = dubaiSet({ travellers: 2 });
    expect(two.recommended_tier).toBe("comfort");
    expect(retier(two, "economy", true)).toEqual({ from: "economy", to: "comfort", travellers: 2 });
    expect(retier(two, "economy", false)).toBeNull(); // the user's choice
    expect(retier(two, "comfort", true)).toBeNull(); // already there
    expect(retier({ ...two, budget: null }, "economy", true)).toBeNull();
    // an unknown sum: «comfort» is the default, not a budget pick
    expect(retier(prodSet({ budget: B12 }), "premium", true)).toBeNull();
  });

  it("hotelSwaps: a kept hotel missing from the new set is named with the hotel shown now", () => {
    const two = prodSet({ travellers: 2 });
    const one = prodSet({ travellers: 1, overrides: { keep_hotels: tierHotels(two)! } });
    expect(hotelSwaps(two, one, tierHotels(two))).toEqual({ premium: { from: "Ala-Too Grand Hotel", to: "Chui Palace", travellers: 1 } });
    const kept = prodSet({ travellers: 2, overrides: { keep_hotels: tierHotels(prodSet())! } });
    expect(hotelSwaps(prodSet(), kept, tierHotels(prodSet()))).toEqual({});
    expect(hotelSwaps(null, kept, tierHotels(prodSet()))).toEqual({});
  });

  it("passHotel: the hotel the total is priced with; out of the total; none", () => {
    expect(passHotel(prodSet().tiers!.premium)).toEqual({ name: "Chui Palace", inTotal: true });
    const partial = almatySet({ hotelEventDates: true });
    expect(passHotel(partial.tiers!.comfort)).toEqual({ name: "Novotel Almaty City Center", inTotal: false });
    expect(passHotel(almatySet({ hotelDown: true }).tiers!.comfort)).toBeNull();
  });
});

describe("money on integer cents (no float arithmetic, no conversion)", () => {
  it("parses and prints decimal strings", () => {
    expect(toCents("85")).toBe(8500);
    expect(toCents("85.5")).toBe(8550);
    expect(toCents("0.07")).toBe(7);
    expect(toCents("85.555")).toBeNull();
    expect(toCents("-1.00")).toBeNull();
    expect(toCents("1e3")).toBeNull();
    expect(fromCents(8550)).toBe("85.50");
  });
  it("multiplies per person × travellers exactly", () => {
    expect(mulAmount("0.10", 3)).toBe("0.30"); // 0.1 × 3 = 0.30000000000000004 in floats
    expect(mulAmount("19.99", 6)).toBe("119.94");
    expect(mulAmount("85.00", 2)).toBe("170.00");
    expect(mulAmount("x", 2)).toBeNull();
  });
});

describe("dates, times, distances", () => {
  it("trip dates are local calendar dates", () => {
    expect(formatTripDates("2026-11-13", "2026-11-16", "ru")).toBe("13–16 нояб.");
    expect(formatTripDates("2026-11-13", "2026-11-16", "en")).toBe("13–16 Nov");
    expect(formatTripDates("2026-11-29", "2026-12-02", "ru")).toBe("29 нояб. – 2 дек.");
    // New Year: no year while both dates are in this or next year (fits the 360 px pass), named when further away
    const oct2026 = Date.parse("2026-10-10T00:00:00Z");
    expect(formatTripDates("2026-12-30", "2027-01-03", "ru", oct2026)).toBe("30 дек. – 3 янв.");
    expect(formatTripDates("2026-12-30", "2027-01-02", "en", oct2026)).toBe("30 Dec – 2 Jan");
    expect(formatTripDates("2026-12-30", "2027-01-02", "en", Date.parse("2024-05-01T00:00:00Z"))).toBe("30 Dec 2026 – 2 Jan 2027");
    expect(formatTripDates("2026-11-13", null, "ru")).toBe("13 нояб.");
    expect(formatTripDates(null, null, "ru")).toBe("");
  });
  it("flight times stay in the place's own offset (overnight flights do not shift the day)", () => {
    expect(wallClock("2026-11-13T23:40:00+05:00")).toBe("23:40");
    expect(wallDay("2026-11-13T23:40:00+05:00", "ru")).toBe("13 нояб.");
    expect(wallClock(null)).toBe("");
  });
  it("«цена от ЧЧ:ММ»: time only today, with the date otherwise", () => {
    const iso = "2026-10-10T12:05:00Z";
    const now = Date.parse("2026-10-10T12:30:00Z");
    const local = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
    expect(priceTime(iso, "ru", now)).toBe(local);
    expect(priceTime(iso, "ru", now + 3 * 86_400_000)).toMatch(/^\d{2}\.\d{2} \d{2}:\d{2}$/);
    expect(priceTime("nope", "ru", now)).toBe("");
  });
  it("durations and distances", () => {
    expect(formatDuration(95, tr("ru"))).toBe("1 ч 35 мин");
    expect(formatDuration(120, tr("en"))).toBe("2 h");
    expect(formatDuration(45, tr("ru"))).toBe("45 мин");
    expect(formatDuration(null, tr("ru"))).toBe("");
    expect(formatDistance(110, "ru", tr("ru"))).toBe("110 м");
    expect(formatDistance(1830, "ru", tr("ru"))).toBe("1,8 км");
    expect(formatDistance(1830, "en", tr("en"))).toBe("1.8 km");
    expect(formatDistance(12_400, "ru", tr("ru"))).toBe("12,4 км");
  });
  it("expired offers", () => {
    expect(isExpired("2026-10-10T04:00:00Z", Date.parse("2026-10-10T04:00:01Z"))).toBe(true);
    expect(isExpired("2026-10-10T04:00:00Z", Date.parse("2026-10-10T03:59:00Z"))).toBe(false);
    expect(isExpired("garbage", Date.now())).toBe(false);
  });
});

describe("honest texts by reason", () => {
  it("transfers", () => {
    expect(transfersText({ transfers: 0, return_transfers: 0 }, tr("ru"), tp)).toBe("прямой");
    expect(transfersText({ transfers: 1, return_transfers: 1 }, tr("ru"), tp)).toBe("1 пересадка");
    expect(transfersText({ transfers: 2, return_transfers: null }, tr("ru"), tp)).toBe("2 пересадки");
    expect(transfersText({ transfers: 0, return_transfers: 1 }, tr("ru"), tp)).toBe("пересадки: туда 0, обратно 1");
  });
  it("unavailable components", () => {
    expect(unavailableKey("flight", "NO_DIRECT")).toBe("tr.na.flight.NO_DIRECT");
    expect(unavailableKey("flight", "NO_DEPARTURE")).toBe("tr.na.flight.NO_DEPARTURE");
    expect(unavailableKey("hotel", "NO_HOTEL")).toBe("tr.na.hotel.NO_HOTEL");
    expect(unavailableKey("hotel", "NO_HOTEL", true)).toBe("tr.na.hotel.NO_HOTEL_NEAR");
    expect(unavailableKey("ticket", "PROVIDER_UNAVAILABLE")).toBe("tr.na.PROVIDER_UNAVAILABLE");
    // fix 5.1 E: a failed / switched-off flight or hotel supplier names the service, not «no price»
    expect(unavailableKey("hotel", "NOT_CONFIGURED")).toBe("tr.na.hotel.NOT_CONFIGURED");
    expect(unavailableKey("flight", "PROVIDER_UNAVAILABLE")).toBe("tr.na.flight.PROVIDER_UNAVAILABLE");
    expect(unavailableKey("ticket", "NOT_CONFIGURED")).toBe("tr.na.NOT_CONFIGURED");
    expect(translate("ru", unavailableKey("flight", "PROVIDER_UNAVAILABLE"))).toBe("Сервис перелётов не ответил");
    expect(translate("ru", unavailableKey("hotel", "PROVIDER_UNAVAILABLE"))).toBe("Сервис отелей не ответил");
    expect(translate("ru", unavailableKey("flight", "NOT_CONFIGURED"))).toBe("Расчёт перелётов временно отключён");
    expect(translate("en", unavailableKey("flight", "PROVIDER_UNAVAILABLE"))).toBe("The flight service did not respond");
    expect(unavailableKey("ticket", "NO_DIRECT")).toBe("tr.na.other");
  });
  it("what is missing from the total", () => {
    expect(missingText([], tr("ru"))).toBe("");
    expect(missingText(["flight"], tr("ru"))).toBe("без перелёта");
    expect(missingText(["hotel", "flight"], tr("ru"))).toBe("без перелёта и отеля");
    expect(missingText(["ticket", "hotel", "flight"], tr("en"))).toBe("without flight, hotel and ticket");
  });
});

describe("links and support context", () => {
  it("map menu keeps only https links (no javascript:, no http)", () => {
    expect(mapItems({ yandex: "javascript:alert(1)", google: "https://www.google.com/maps/search/?api=1&query=1,2", osm: "http://osm.org", dgis: "https://2gis.ru/geo/2,1" }).map((x) => x.key)).toEqual(["google", "dgis"]);
    expect(mapItems(null)).toEqual([]);
  });
  it("sources & booking: every link of the package with supplier, time and price for the group", () => {
    const set = almatySet({ travellers: 2 });
    const links = packageLinks(set, set.tiers!.comfort);
    expect(links.map((l) => [l.kind, l.provider, l.amount])).toEqual([
      ["ticket", "Ticketmaster", "170.00"],
      ["flight", "Aviasales", "284.00"],
      ["hotel", "LiteAPI", "390.00"],
      ["venue", "", null],
    ]);
    expect(links[1]!.object).toBe("TAS → ALA");
    expect(links[1]!.fetched_at).toBe("2026-10-10T03:48:00Z");
  });
  it("a non-https deeplink is not offered", () => {
    const set = almatySet();
    const offer: Offer = { ...set.tiers!.comfort, flight: { ...(set.tiers!.comfort.flight as Extract<Offer["flight"], { status: "ok" }>), deeplink: "javascript:alert(1)" } };
    expect(packageLinks(set, offer).map((l) => l.kind)).toEqual(["ticket", "hotel", "venue"]);
  });
  it("«Проблема с предложением?»: offer_id, the main supplier and its link, the package price at its time", () => {
    const set = almatySet({ travellers: 2 });
    const ctx = offerSupportContext(ALMATY, set, set.tiers!.comfort, "Предложение поездки: x");
    expect(ctx).toEqual({
      event_id: ALMATY.event_id,
      event_title: ALMATY.title,
      offer_id: set.tiers!.comfort.offer_id,
      provider_id: "aviasales",
      deeplink: "https://www.aviasales.com/search/TAS1311ALA16112?t=HY17631230&marker=512345",
      price_snapshot: { amount: "844.00", currency: "USD", fetched_at: set.generated_at },
      category: "PRICE",
      subject: "Предложение поездки: x",
    });
    // no flight → the hotel; nothing priced → no price snapshot
    const nodep = buildOfferSet(F1, opts({ departures: [] }));
    expect(offerSupportContext(F1, nodep, nodep.tiers!.economy, "s").provider_id).toBe("liteapi");
    const zero: Offer = { ...nodep.tiers!.economy, totals: { ...nodep.tiers!.economy.totals, total: "0.00" } };
    expect(offerSupportContext(F1, nodep, zero, "s")).not.toHaveProperty("price_snapshot");
  });
});

/* ================================================================ fix 5.1: budget, alternatives, the hotel the user chooses */

describe("fix 5.1 — ticket at the CBU rate, supplier failures (pure logic)", () => {
  it("the ticket in the total: USD as is, a converted one by fx; another currency without a rate stays out", () => {
    const base = { status: "ok" as const, provider: "aiweb.ticket-gov-kg", deeplink: "https://ticket.gov.kg/e/1", fetched_at: "2026-10-10T03:42:00Z" };
    expect(ticketUsd({ ...base, price_per_person: "85.00", currency: "USD", in_total: true, fx: null })).toBe("85.00");
    const kgs = { ...base, price_per_person: "27000.00", currency: "KGS", in_total: true, fx: { price_per_person_usd: "309.18", rate: "0.011451", date: "2026-10-11", source: "cbu.uz" as const } };
    expect(ticketUsd(kgs)).toBe("309.18");
    expect(ticketUsd({ ...kgs, in_total: false, fx: null })).toBeNull();
    expect(ticketUsd({ ...kgs, fx: { ...kgs.fx, price_per_person_usd: "x" } })).toBeNull(); // a broken figure is never shown
    expect(ticketFxLine(kgs, "ru", tr("ru"), (a) => `$${a}`)).toBe("≈ $309 по курсу ЦБ РУз на 11.10 · на сайте 27\u00a0000\u00a0сом");
    expect(ticketFxLine(kgs, "en", tr("en"), (a) => `$${a}`)).toBe("≈ $309 at the Central Bank of Uzbekistan rate on 11 Oct · 27,000\u00a0som on the site");
    expect(ticketFxLine({ ...kgs, fx: null }, "ru", tr("ru"), (a) => a)).toBe("");
  });

  it("TICKET_NOT_USD is neutral: no rate, a currency the CBU does not list or a failed conversion read the same", () => {
    expect(translate("ru", "tr.note.TICKET_NOT_USD")).toBe("Цена билета — в местной валюте, в сумму поездки не вошла: пересчитать по курсу ЦБ не получилось.");
    expect(translate("en", "tr.note.TICKET_NOT_USD")).toBe("The ticket price is in the local currency and is not in the trip total: it could not be converted at the central bank rate.");
    expect(translate("ru", "tr.note.TICKET_NOT_USD")).not.toMatch(/недоступен/);
  });

  it("approximate dollars, the rate date, the site money in the site's words", () => {
    expect(approxUsd("309.18")).toBe("309");
    expect(approxUsd("2061.50")).toBe("2062");
    expect(approxUsd("0.49")).toBe("0");
    expect(approxUsd("bad")).toBeNull();
    expect(fxDate("2026-10-11", "ru")).toBe("11.10");
    expect(fxDate("2026-10-11", "en")).toBe("11 Oct");
    expect(siteMoney("27000.00", "KGS", "ru", tr("ru"))).toBe("27\u00a0000\u00a0сом");
    expect(siteMoney("250000.50", "UZS", "ru", tr("ru"))).toBe("250\u00a0000,50\u00a0сум");
    expect(siteMoney("27000", "KGS", "en", tr("en"))).toBe("27,000\u00a0som");
    expect(siteMoney("100", "CHF", "ru", tr("ru"))).toBe("100\u00a0CHF");
    expect(siteMoney("1e3", "KGS", "ru", tr("ru"))).toBe("");
  });

  it("the mock engine converts half-even to cents and marks the set", () => {
    const set = bishkekSet();
    const tk = set.tiers!.comfort.ticket;
    expect(tk).toMatchObject({ currency: "KGS", in_total: true, fx: { price_per_person_usd: "309.18", rate: "0.011451", date: "2026-10-11", source: "cbu.uz" } });
    expect(set.tiers!.premium.ticket).toMatchObject({ fx: { price_per_person_usd: "2061.18" } });
    expect(set.notes).toContain("TICKET_FX_CONVERTED");
    expect(set.tiers!.comfort.totals).toMatchObject({ total: "759.18", missing: [] });
    expect(set.recommended_tier).toBe("comfort");
    expect(set.tiers!.premium).toMatchObject({ budget_fit: "over", over_by: "691.18" });
  });

  it("«Попробовать снова»: only a supplier that did not answer; the forced call is a POST with the same parameters", () => {
    expect(isProviderDown({ status: "unavailable", reason: "PROVIDER_UNAVAILABLE" })).toBe(true);
    expect(isProviderDown({ status: "unavailable", reason: "NOT_CONFIGURED" })).toBe(false);
    expect(isProviderDown({ status: "unavailable", reason: "NO_PRICE" })).toBe(false);
    expect(isProviderDown({ status: "ok" })).toBe(false);
    expect(hasProviderFailure(almatySet({ flightDown: true }))).toBe(true);
    expect(hasProviderFailure(almatySet())).toBe(false);
    expect(offersCall({ ...DEFAULT_PARAMS, travellers: 3 }, true)).toEqual({ method: "POST", body: { travellers: 3, direct_only: false, near_venue: false, extra_nights: 0 } });
    expect(offersCall({ ...DEFAULT_PARAMS, travellers: 3 })).toEqual({ method: "GET", travellers: 3 });
  });
});

describe("fix 5.1 — budget and hotels (pure logic)", () => {
  it("a chosen hotel is an override → POST with hotel_id; «Вернуть подбор» (null) sends no field; a strange id is never sent", () => {
    expect(hasOverrides({ ...DEFAULT_PARAMS, hotel_id: "lp5d0b02" })).toBe(true);
    expect(offersCall({ ...DEFAULT_PARAMS, hotel_id: "lp5d0b02" })).toEqual({
      method: "POST",
      body: { travellers: 1, direct_only: false, near_venue: false, extra_nights: 0, hotel_id: "lp5d0b02" },
    });
    expect(offersCall({ ...DEFAULT_PARAMS, hotel_id: null })).toEqual({ method: "GET", travellers: 1 });
    const near = offersCall({ ...DEFAULT_PARAMS, near_venue: true, hotel_id: null });
    expect(near.method === "POST" && near.body).not.toHaveProperty("hotel_id");
    const bad = offersCall({ ...DEFAULT_PARAMS, hotel_id: "../x?y" });
    expect(bad.method === "POST" && bad.body).not.toHaveProperty("hotel_id");
  });

  it("budget marks: within / over with the amount (cents, no float) / unknown → nothing", () => {
    expect(budgetMark({ budget_fit: "within", over_by: null })).toEqual({ kind: "within", excludes: [] });
    expect(budgetMark({ budget_fit: "over", over_by: "130" })).toEqual({ kind: "over", by: "130.00", excludes: [] });
    expect(budgetMark({ budget_fit: "over", over_by: null })).toEqual({ kind: "over", by: null, excludes: [] });
    expect(budgetMark({ budget_fit: "over", over_by: "-5" })).toEqual({ kind: "over", by: null, excludes: [] });
    // fix 6.1: what is not compared, in the order of the total label (flight, hotel, ticket); unknown parts dropped
    expect(budgetMark({ budget_fit: "within", over_by: null, budget_excludes: ["ticket", "flight", "boat"] })).toEqual({ kind: "within", excludes: ["flight", "ticket"] });
    expect(budgetMark({ budget_fit: "unknown", over_by: null })).toBeNull();
    expect(budgetMark({})).toBeNull(); // an older server without the fields
    expect(budgetMark(null)).toBeNull();
  });

  it("budget range of the set: «$1 000–2 000», «до $2 000», «от $1 000», nothing", () => {
    const usd = (a: string) => `$${Number(a).toLocaleString("ru-RU").replace(/\u00a0/g, " ")}`;
    const t = tr("ru");
    expect(budgetRange(B12, usd, t)).toBe("$1 000–2 000");
    expect(budgetRange({ min: null, max: "1500.00" }, usd, t)).toBe("до $1 500");
    expect(budgetRange({ min: "1000.00", max: null }, usd, t)).toBe("от $1 000");
    expect(budgetRange({ min: null, max: null }, usd, t)).toBe("");
    expect(budgetRange(null, usd, t)).toBe("");
  });

  it("the tier to open: the server's recommendation, else Comfort", () => {
    const set = dubaiSet();
    expect(set.recommended_tier).toBe("economy");
    expect(initialTier(set)).toBe("economy");
    expect(initialTier({ ...set, recommended_tier: null })).toBe("comfort");
    expect(initialTier({ ...set, recommended_tier: "bogus" as never })).toBe("comfort");
  });

  it("hotels nearby: within by distance, unknown by distance, over by price; the chosen hotel only when hotel_chosen_by = user", () => {
    const set = dubaiSet();
    expect(sortHotels(set.hotels_nearby).map((h) => `${h.name}:${h.budget_fit}`)).toEqual([
      "Rove Dubai Marina:within",
      "Media One Hotel:within",
      "Hilton Dubai The Walk:over",
      "JW Marriott Hotel Marina:over",
      "Address Dubai Marina:over",
      "Five Palm Jumeirah:over",
    ]);
    // an older order from the server is fixed on the client
    const shuffled = [...set.hotels_nearby].reverse();
    expect(sortHotels(shuffled).map((h) => h.hotel_id)).toEqual(set.hotels_nearby.map((h) => h.hotel_id));
    const mixed = [{ ...set.hotels_nearby[4]!, budget_fit: "unknown" as const }, set.hotels_nearby[0]!];
    expect(sortHotels(mixed).map((h) => h.budget_fit)).toEqual(["within", "unknown"]);
    expect(chosenHotelId(set, set.tiers!.economy)).toBeNull();
    const mine = dubaiSet({ overrides: { hotel_id: "lp5d0b02" } });
    expect(mine.hotel_chosen_by).toBe("user");
    expect(chosenHotelId(mine, mine.tiers!.premium)).toBe("lp5d0b02");
    expect(budgetKey(F.filledPreferences().budget)).not.toBe(budgetKey({ ...F.filledPreferences().budget, max: 1000 }));
    expect(budgetKey(null)).toBe("");
  });

  it("mock engine follows the contract: fits per tier, different hotels per tier, the user's hotel in every tier, unknown without a budget", () => {
    const set = dubaiSet();
    expect([set.tiers!.economy, set.tiers!.comfort, set.tiers!.premium].map((o) => [o.budget_fit, o.over_by])).toEqual([
      ["within", null],
      ["over", "130.00"],
      ["over", "1600.00"],
    ]);
    const hotels = new Set(["economy", "comfort", "premium"].map((k) => (set.tiers![k as "economy"].hotel as { hotel_id: string }).hotel_id));
    expect(hotels.size).toBe(3);
    expect(set.hotels_nearby[0]!.per_person_share).toBe("560.00");
    const mine = dubaiSet({ overrides: { hotel_id: "lp5d0b02" } });
    expect(new Set(["economy", "comfort", "premium"].map((k) => (mine.tiers![k as "economy"].hotel as { hotel_id: string }).hotel_id))).toEqual(new Set(["lp5d0b02"]));
    expect(mine.recommended_tier).toBe("comfort");
    expect(dubaiSet({ overrides: { hotel_id: "nope" } }).tiers!.comfort.hotel).toEqual({ status: "unavailable", reason: "NO_HOTEL" });
    const none = dubaiSet({ budget: null });
    expect(none.recommended_tier).toBe("comfort");
    expect(none.tiers!.economy.budget_fit).toBe("unknown");
    expect(none.hotels_nearby.every((h) => h.budget_fit === "unknown")).toBe(true);
  });

  it("on-screen keyboard: the part of the layer under the visual viewport", () => {
    expect(keyboardOverlap(667, { height: 667, offsetTop: 0 })).toBe(0);
    expect(keyboardOverlap(667, { height: 376, offsetTop: 0 })).toBe(291);
    expect(keyboardOverlap(600, { height: 376, offsetTop: 40 })).toBe(184); // the page scrolled up by the browser
    expect(keyboardOverlap(600, { height: 900, offsetTop: 0 })).toBe(0);
    expect(keyboardOverlap(600, null)).toBe(0);
    expect(keyboardOverlap(600, { height: Number.NaN, offsetTop: 0 })).toBe(0);
  });
});

/* ================================================================ the block */

const profile = (o: Partial<Profile["preferences"]> = {}): Profile =>
  ({ preferences: { ...F.filledPreferences(), ...o } }) as unknown as Profile;

function renderTrip(offers: Partial<Api["offers"]>, o: { lang?: Lang; prof?: Profile | null; ev?: EventDetailView } = {}) {
  const navigate = vi.fn();
  const api = { offers, profile: {}, directory: { airports: async () => ({ items: [] }) } } as unknown as Api;
  const ctx = { api, navigate, profile: o.prof === undefined ? profile() : o.prof, reloadProfile: vi.fn(async () => null) } as unknown as AppCtx;
  const r = render(
    <I18nProvider initial={o.lang ?? "ru"}>
      <AppContext.Provider value={ctx}>
        <TripBoundary>
          <TripBlock ev={o.ev ?? ALMATY} />
        </TripBoundary>
      </AppContext.Provider>
    </I18nProvider>,
  );
  return { ...r, navigate, ctx };
}

describe("TripBlock", () => {
  it("skeleton → pass with the total; tiers switch locally (no request)", async () => {
    let resolve: (s: OfferSetView) => void = () => {};
    const get = vi.fn(() => new Promise<OfferSetView>((r) => (resolve = r)));
    renderTrip({ get });
    expect(screen.getByTestId("trip-loading")).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(get).toHaveBeenCalled());
    await act(async () => resolve(almatySet()));
    expect(screen.getByTestId("trip-total")).toHaveTextContent("$617");
    expect(get).toHaveBeenCalledWith(ALMATY.event_id, 1, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Premium" }));
    expect(screen.getByTestId("trip-total")).toHaveTextContent("$1 668");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("flight without an airline code (supplier did not send it): row shows route and transfers, no code", async () => {
    const set = almatySet();
    for (const tier of ["economy", "comfort", "premium"] as const) {
      const f = set.tiers![tier].flight;
      if (f.status === "ok") f.airline = null;
    }
    renderTrip({ get: vi.fn(async () => set) });
    await screen.findByTestId("trip-pass");
    const row = screen.getByTestId("trip-row-flight");
    expect(row).toHaveAttribute("data-status", "ok");
    expect(row.textContent).not.toMatch(/\b(FZ|HY|KC)\b/);
    expect(row.textContent).not.toMatch(/null|undefined/);
    expect(row).toHaveTextContent("ALA");
  });

  it("stepper: aria, bounds, rapid taps are debounced into one request with the last value", async () => {
    const get = vi.fn(async (_id: string, n: number) => almatySet({ travellers: n }));
    const recalculate = vi.fn(async (_id: string, b: RecalcBody) => almatySet({ travellers: b.travellers, overrides: b }));
    renderTrip({ get, recalculate });
    await screen.findByTestId("trip-pass");
    const dec = screen.getByRole("button", { name: "Меньше путешественников" });
    const inc = screen.getByRole("button", { name: "Больше путешественников" });
    expect(dec).toBeDisabled();
    expect(screen.getByRole("group", { name: "Путешественники" })).toContainElement(inc);
    expect(screen.getByTestId("trip-travellers")).toHaveAttribute("aria-live", "polite");
    fireEvent.click(inc);
    fireEvent.click(inc);
    fireEvent.click(inc);
    expect(screen.getByTestId("trip-travellers")).toHaveTextContent("4");
    await waitFor(() => expect(screen.getByTestId("trip-total")).toHaveTextContent("$1 688")); // 227 × 4 + 130 × 3 × 2
    expect(get.mock.calls.map((c) => c[1])).toEqual([1]);
    // fix 5.2: another number of travellers keeps every tier's hotel (POST with keep_hotels), one request for the last value
    expect(recalculate.mock.calls.map((c) => c[1])).toEqual([
      { travellers: 4, direct_only: false, near_venue: false, extra_nights: 0, keep_hotels: { economy: "lp2a1a02", comfort: "lp2a1a01", premium: "lp2a1a03" } },
    ]);
    expect(screen.getByText("≈ $422 на человека · 2 номера")).toBeInTheDocument();
  });

  it("settings → POST /recalculate; «direct only» from the profile is shown on and locked", async () => {
    const get = vi.fn(async () => almatySet());
    const recalculate = vi.fn(async (_id: string, b: Parameters<Api["offers"]["recalculate"]>[1]) => almatySet({ travellers: b.travellers, overrides: b }));
    renderTrip({ get, recalculate }, { prof: profile({ flight_prefs: { direct: true, connecting: false, alternative_departure: false } }) });
    await screen.findByTestId("trip-pass");
    fireEvent.click(screen.getByTestId("trip-settings-toggle"));
    const direct = screen.getByRole("switch", { name: "Только прямые рейсы" });
    expect(direct).toHaveAttribute("aria-checked", "true");
    expect(direct).toBeDisabled();
    expect(screen.getByText("так указано в профиле")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Отель рядом с площадкой" }));
    await waitFor(() => expect(recalculate).toHaveBeenCalledWith(ALMATY.event_id, { travellers: 1, direct_only: false, near_venue: true, extra_nights: 0 }, expect.any(AbortSignal)));
    await waitFor(() => expect(screen.getByTestId("trip-row-hotel")).toHaveTextContent("Arena Park Hotel"));
    fireEvent.click(screen.getByRole("radio", { name: /Samarkand/ }));
    await waitFor(() => expect(recalculate.mock.calls.at(-1)![1]).toMatchObject({ departure_iata: "SKD", near_venue: true }));
  });

  it("first load fails → error with retry inside the block; a failed recalculation keeps the numbers", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, "OFFERS_UNAVAILABLE", "x"))
      .mockResolvedValueOnce(almatySet());
    const recalculate = vi.fn().mockRejectedValueOnce(new ApiError(429, "RATE_LIMITED", "x", { retry_after: 30 }));
    renderTrip({ get, recalculate });
    expect(await screen.findByTestId("trip-error")).toHaveTextContent("Расчёт поездок временно недоступен. Повторите через минуту");
    fireEvent.click(within(screen.getByTestId("trip-error")).getByRole("button", { name: "Повторить" }));
    expect(await screen.findByTestId("trip-pass")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Больше путешественников" }));
    expect(await screen.findByTestId("trip-recalc-error")).toHaveTextContent("Не получилось пересчитать. Слишком много запросов — повторите через");
    expect(screen.getByTestId("trip-total")).toHaveTextContent("$617");
    expect(screen.getByTestId("trip-travellers")).toHaveTextContent("2"); // 429: the choice stays, «Повторить» sends it again
    // sprint 9: the wait counts down and «Повторить» waits for it (no automatic repeat)
    expect(screen.getByTestId("trip-recalc-error")).toHaveTextContent(/повторите через (30|29)\s?с/);
    const retry = within(screen.getByTestId("trip-recalc-error").closest(".note") as HTMLElement).getByRole("button", { name: "Повторить" });
    expect(retry).toBeDisabled();
    expect(recalculate).toHaveBeenCalledTimes(1);
  });

  it("a failed recalculation (not 429) rolls the controls back to the last priced parameters; «Повторить» retries the failed ones", async () => {
    const get = vi.fn().mockResolvedValueOnce(almatySet());
    const recalculate = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, "OFFERS_UNAVAILABLE", "x"))
      .mockImplementation(async (_id: string, b: RecalcBody) => almatySet({ travellers: b.travellers, overrides: b }));
    renderTrip({ get, recalculate });
    await screen.findByTestId("trip-pass");
    fireEvent.click(screen.getByRole("button", { name: "Больше путешественников" }));
    expect(await screen.findByTestId("trip-recalc-error")).toBeInTheDocument();
    expect(screen.getByTestId("trip-travellers")).toHaveTextContent("1");
    expect(screen.getByTestId("trip-total")).toHaveTextContent("$617");
    expect(get).toHaveBeenCalledTimes(1);
    expect(recalculate).toHaveBeenCalledTimes(1); // the rollback itself is not a request
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(screen.getByTestId("trip-total")).toHaveTextContent("$844"));
    expect(screen.getByTestId("trip-travellers")).toHaveTextContent("2");
  });

  it("«Обновить» appears only when the offer is out of date", async () => {
    renderTrip({ get: async () => ({ ...almatySet(), expires_at: "2099-01-01T00:00:00Z" }) });
    expect(await screen.findByTestId("trip-fresh")).toHaveTextContent(/^Цены получены в [\d.: ]+\. Пересчитаем после [\d.: ]+$/);
    expect(screen.queryByTestId("trip-refresh")).toBeNull();
  });

  it("a synchronous failure of the client is the block's error, never the detail's", async () => {
    renderTrip({});
    expect(await screen.findByTestId("trip-error")).toBeInTheDocument();
  });

  it("OFFER_DEPARTURE_INVALID rolls back to the last accepted city without a new request", async () => {
    const get = vi.fn(async () => almatySet());
    const recalculate = vi.fn(async () => {
      throw new ApiError(422, "OFFER_DEPARTURE_INVALID", "x");
    });
    renderTrip({ get, recalculate });
    await screen.findByTestId("trip-pass");
    fireEvent.click(screen.getByTestId("trip-settings-toggle"));
    fireEvent.click(screen.getByRole("radio", { name: /Samarkand/ }));
    expect(await screen.findByTestId("trip-recalc-error")).toHaveTextContent("Этого города вылета нет в профиле");
    expect(screen.getByRole("radio", { name: "Где дешевле" })).toHaveAttribute("aria-checked", "true");
    expect(get).toHaveBeenCalledTimes(1);
    expect(recalculate).toHaveBeenCalledTimes(1);
  });

  it("states: not available by reason, stale, notes, shifted flight dates", async () => {
    for (const reason of ["EVENT_POSTPONED", "EVENT_CANCELLED", "EVENT_PAST", "NO_DESTINATION"] as const) {
      const set: OfferSetView = { ...almatySet(), trip: { kind: "not_available", reason, destination: null, out_date: null, back_date: null, nights: null }, tiers: null };
      const { unmount } = renderTrip({ get: async () => set });
      expect(await screen.findByTestId("trip")).toHaveAttribute("data-reason", reason);
      expect(screen.getByTestId("trip")).toHaveTextContent(translate("ru", `tr.na.${reason}.h`));
      unmount();
    }
    const base = almatySet();
    const fl = base.tiers!.comfort.flight as Extract<Offer["flight"], { status: "ok" }>;
    const shifted: OfferSetView = {
      ...base,
      expires_at: "2020-01-01T00:00:00Z",
      notes: ["FLIGHT_DATES_SHIFTED", "LOCATION_APPROX"],
      tiers: { ...base.tiers!, comfort: { ...base.tiers!.comfort, flight: { ...fl, dates_shifted: true, depart_at: "2026-11-12T07:40:00+05:00" } } },
    };
    renderTrip({ get: async () => shifted });
    expect(await screen.findByTestId("trip-fresh")).toHaveAttribute("data-stale", "true");
    expect(screen.getByTestId("trip-notes")).toHaveTextContent("На точные даты перелётов нет");
    expect(screen.getByTestId("trip-notes")).toHaveTextContent("расстояния считаем от центра города");
    expect(screen.getByTestId("trip-row-flight")).toHaveTextContent("На ваши даты цены нет, поэтому даты сдвинуты: 12 нояб. – 16 нояб.");
  });

  it("HOTEL_PRICES_PARTIAL: hotel priced for the event dates is marked and stays out of the total", async () => {
    const set = { ...almatySet({ hotelEventDates: true }), expires_at: "2099-01-01T00:00:00Z" };
    expect(set.tiers!.comfort.totals).toMatchObject({ total: "227.00", missing: ["hotel"] });
    expect(packageLinks(set, set.tiers!.comfort).find((l) => l.kind === "hotel")!.outOfTotal).toBe(true);
    renderTrip({ get: async () => set });
    const row = await screen.findByTestId("trip-row-hotel");
    expect(row).toHaveAttribute("data-in-total", "false");
    expect(row).toHaveTextContent("Цена — на даты события, не на даты перелёта");
    expect(row).toHaveTextContent("не входит в сумму");
    expect(screen.getByTestId("trip-notes")).toHaveTextContent("Отель показан на даты события и в сумму не входит");
    expect(screen.getByTestId("pass-total-label")).toHaveTextContent("без отеля · ориентировочно");
    // a hotel in the total carries no mark
    cleanup();
    renderTrip({ get: async () => almatySet() });
    expect(await screen.findByTestId("trip-row-hotel")).toHaveAttribute("data-in-total", "true");
    expect(screen.queryByTestId("hotel-event-dates")).toBeNull();
  });

  it("«Проблема с предложением?» navigates to support with the offer context", async () => {
    const { navigate } = renderTrip({ get: async () => almatySet() });
    await screen.findByTestId("trip-pass");
    fireEvent.click(screen.getByTestId("trip-support"));
    const route = navigate.mock.calls[0]![0].route;
    expect(route.name).toBe("supportNew");
    expect(route.ctx).toMatchObject({ offer_id: almatySet().tiers!.comfort.offer_id, category: "PRICE", provider_id: "aviasales", subject: `Предложение поездки: ${ALMATY.title}` });
  });

  it("fix 5.1: opens the recommended tier; tier marks are short on screen and full for screen readers; the total says the fit", async () => {
    renderTrip({ get: vi.fn(async () => dubaiSet()) }, { ev: DUBAI });
    await screen.findByTestId("trip-pass");
    expect(screen.getByTestId("trip")).toHaveAttribute("data-tier", "economy");
    const premium = screen.getByRole("button", { name: "Premium" }); // the name stays the tier
    expect(premium).toHaveAccessibleDescription(/^Превышает ваш бюджет на \$1\s600\.$/);
    expect(within(premium).getByText(/^сверх \$1\s600$/)).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("pass-fit")).toHaveTextContent("В вашем бюджете");
    expect(screen.getByTestId("pass-fit")).toHaveTextContent("бюджет $1 000–2 000 на человека");
    expect(screen.queryByTestId("trip-budget-hint")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Comfort" }));
    expect(screen.getByTestId("pass-fit")).toHaveAttribute("data-fit", "over");
    expect(screen.getByTestId("pass-fit")).toHaveTextContent("Превышает ваш бюджет на $130");
  });

  it("fix 5.2: a tier the user chose never jumps when travellers change (the recommendation changes with two)", async () => {
    const get = vi.fn(async (_id: string, n: number) => dubaiSet({ travellers: n }));
    const recalculate = vi.fn(async (_id: string, b: RecalcBody) => dubaiSet({ travellers: b.travellers, overrides: b }));
    renderTrip({ get, recalculate }, { ev: DUBAI });
    await screen.findByTestId("trip-pass");
    fireEvent.click(screen.getByRole("button", { name: "Economy" })); // the user's choice (the same tier as recommended)
    fireEvent.click(screen.getByRole("button", { name: "Больше путешественников" }));
    await waitFor(() => expect(recalculate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("trip-travellers")).toHaveTextContent("2"));
    expect((await recalculate.mock.results[0]!.value).recommended_tier).toBe("comfort");
    expect(screen.getByTestId("trip")).toHaveAttribute("data-tier", "economy");
    expect(screen.queryByTestId("trip-retier")).toBeNull();
  });

  it("fix 5.2: a tier picked for the budget is picked again for two travellers — said so, «Вернуть Economy» goes back", async () => {
    const recalculate = vi.fn(async (_id: string, b: RecalcBody) => dubaiSet({ travellers: b.travellers, overrides: b }));
    renderTrip({ get: vi.fn(async () => dubaiSet()), recalculate }, { ev: DUBAI });
    await screen.findByTestId("trip-pass");
    expect(screen.getByTestId("trip")).toHaveAttribute("data-tier", "economy"); // recommended for one: Comfort is over
    fireEvent.click(screen.getByRole("button", { name: "Больше путешественников" }));
    const note = await screen.findByTestId("trip-retier");
    expect(note).toHaveTextContent("Подобрали Comfort под бюджет на 2 человека");
    expect(screen.getByTestId("trip")).toHaveAttribute("data-tier", "comfort");
    expect(screen.getByTestId("pass-tier")).toHaveTextContent("Comfort");
    expect(screen.getByTestId("pass-hotel")).toHaveTextContent("Hilton Dubai The Walk");
    expect(screen.getByTestId("pass-fit")).toHaveTextContent("В вашем бюджете");
    fireEvent.click(screen.getByRole("button", { name: "Вернуть Economy" }));
    expect(screen.getByTestId("trip")).toHaveAttribute("data-tier", "economy");
    expect(screen.queryByTestId("trip-retier")).toBeNull();
    // the user's choice now: back to one traveller keeps Economy, no note
    fireEvent.click(screen.getByRole("button", { name: "Меньше путешественников" }));
    await waitFor(() => expect(recalculate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("trip-travellers")).toHaveTextContent("1"));
    expect(screen.getByTestId("trip")).toHaveAttribute("data-tier", "economy");
    expect(screen.queryByTestId("trip-retier")).toBeNull();
  });

  it("fix 5.2: prod Bishkek — Premium for one is Chui Palace $869.64; for two the same hotel stays ($888.20), named in the pass", async () => {
    const get = vi.fn(async () => prodSet());
    const recalculate = vi.fn(async (_id: string, b: RecalcBody) => prodSet({ travellers: b.travellers, overrides: b }));
    renderTrip({ get, recalculate }, { ev: BISHKEK_PROD });
    await screen.findByTestId("trip-pass");
    fireEvent.click(screen.getByRole("button", { name: "Premium" }));
    expect(screen.getByTestId("pass-tier")).toHaveTextContent("Premium");
    expect(screen.getByTestId("pass-hotel")).toHaveTextContent("Chui Palace");
    expect(screen.getByTestId("pass-hotel")).toHaveAttribute("data-in-total", "true");
    expect(screen.getByTestId("pass-total-label")).toHaveTextContent("Итого на 1 человека · без перелёта и билета · ориентировочно");
    expect(screen.getByTestId("trip-total")).toHaveTextContent("$869,64");
    fireEvent.click(screen.getByRole("button", { name: "Больше путешественников" }));
    await waitFor(() => expect(screen.getByTestId("trip-total")).toHaveTextContent("$888,20"));
    expect(recalculate.mock.calls[0]![1].keep_hotels).toEqual({ economy: "fru5", comfort: "fru3", premium: "fru2" });
    expect(screen.getByTestId("trip")).toHaveAttribute("data-tier", "premium");
    expect(screen.getByTestId("pass-hotel")).toHaveTextContent("Chui Palace");
    expect(screen.getByText("≈ $444,10 на человека · 1 номер")).toBeInTheDocument();
    expect(screen.queryByTestId("trip-hotel-swap")).toBeNull();
    // by the rules alone (the old behaviour) Premium for two is another hotel: $327.49 — what the customer saw
    expect(prodSet({ travellers: 2 }).tiers!.premium.totals.total).toBe("327.49");
    expect(passHotel(prodSet({ travellers: 2 }).tiers!.premium)!.name).toBe("Ala-Too Grand Hotel");
  });

  it("fix 5.2: the kept hotel has no price for the new occupancy → the hotel shown now is named", async () => {
    const recalculate = vi.fn(async (_id: string, b: RecalcBody) => prodSet({ travellers: b.travellers, overrides: b }));
    renderTrip({ get: vi.fn(async () => prodSet({ travellers: 2 })), recalculate }, { ev: BISHKEK_PROD });
    await screen.findByTestId("trip-pass");
    // the first set (GET) is priced for two — Premium is Ala-Too Grand; the stepper then goes 2 → 1
    fireEvent.click(screen.getByRole("button", { name: "Premium" }));
    expect(screen.getByTestId("pass-hotel")).toHaveTextContent("Ala-Too Grand Hotel");
    fireEvent.click(screen.getByRole("button", { name: "Больше путешественников" }));
    await waitFor(() => expect(recalculate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Меньше путешественников" }));
    await waitFor(() => expect(recalculate).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("trip-hotel-swap")).toHaveTextContent("На 1 человека у «Ala-Too Grand Hotel» нет цены у поставщика — посчитали с «Chui Palace»");
    expect(screen.getByTestId("pass-hotel")).toHaveTextContent("Chui Palace");
    // Comfort kept its hotel: no note there
    fireEvent.click(screen.getByRole("button", { name: "Comfort" }));
    expect(screen.queryByTestId("trip-hotel-swap")).toBeNull();
  });

  it("fix 5.1: «Выбрать» → recalculate with hotel_id, «Выбран вами»; «Вернуть подбор» → plain GET; a failure rolls the choice back", async () => {
    const get = vi.fn(async () => dubaiSet());
    const recalculate = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, "OFFERS_UNAVAILABLE", "x"))
      .mockImplementation(async (_id: string, b: Parameters<Api["offers"]["recalculate"]>[1]) => dubaiSet({ travellers: b.travellers, overrides: b }));
    renderTrip({ get, recalculate }, { ev: DUBAI });
    await screen.findByTestId("trip-hotels");
    const media = () => screen.getAllByTestId("trip-hotel").find((h) => h.getAttribute("data-hotel-id") === "lp5d0b02")!;
    fireEvent.click(within(media()).getByRole("button", { name: "Выбрать отель Media One Hotel для поездки" }));
    expect(await screen.findByTestId("trip-recalc-error")).toBeInTheDocument();
    expect(screen.getByTestId("trip-row-hotel")).toHaveTextContent("Rove Dubai Marina"); // nothing changed
    expect(media()).not.toHaveAttribute("data-chosen");
    fireEvent.click(within(media()).getByRole("button", { name: "Выбрать отель Media One Hotel для поездки" }));
    await waitFor(() => expect(screen.getByTestId("trip-row-hotel")).toHaveTextContent("Media One Hotel"));
    expect(recalculate.mock.calls.at(-1)![1]).toEqual({ travellers: 1, direct_only: false, near_venue: false, extra_nights: 0, hotel_id: "lp5d0b02" });
    expect(screen.getByTestId("hotel-chosen")).toHaveTextContent("Вы выбрали этот отель — он во всех тарифах");
    expect(media()).toHaveAttribute("data-chosen", "true");
    expect(within(media()).getByTestId("hotel-chosen-badge")).toHaveTextContent("Выбран вами");
    expect(screen.getByTestId("trip-settings-toggle")).toHaveTextContent("отель выбран вами");
    fireEvent.click(within(media()).getByRole("button", { name: /Вернуть подбор/ }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("trip-row-hotel")).toHaveTextContent("Rove Dubai Marina"));
    expect(screen.queryByTestId("hotel-chosen")).toBeNull();
  });

  it("fix 5.1: no budget → no marks and a quiet hint; a past event is not priced at all", async () => {
    renderTrip({ get: vi.fn(async () => dubaiSet({ budget: null })) }, { ev: DUBAI });
    expect(await screen.findByTestId("trip-budget-hint")).toHaveTextContent("Укажите бюджет в профиле — подберём тариф");
    expect(screen.queryByTestId("pass-fit")).toBeNull();
    expect(screen.queryAllByTestId("hotel-fit")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Comfort" })).not.toHaveAttribute("aria-describedby");
    cleanup();
    const get = vi.fn(async () => dubaiSet());
    renderTrip({ get }, { ev: { ...DUBAI, is_past: true } });
    expect(screen.getByTestId("trip")).toHaveAttribute("data-reason", "EVENT_PAST");
    expect(screen.getByTestId("trip")).toHaveTextContent("Событие уже прошло. Поездку больше не считаем");
    await new Promise((r) => setTimeout(r, 20));
    expect(get).not.toHaveBeenCalled();
  });

  it("fix 5.1 D: a ticket in som at the CBU rate — in the total, «≈ $309 по курсу ЦБ РУз на 11.10 · на сайте 27 000 сом»", async () => {
    const get = vi.fn(async (_id: string, n: number) => bishkekSet({ travellers: n }));
    const recalculate = vi.fn(async (_id: string, b: RecalcBody) => bishkekSet({ travellers: b.travellers, overrides: b }));
    renderTrip({ get, recalculate }, { ev: BISHKEK });
    const row = await screen.findByTestId("trip-row-ticket");
    expect(row).toHaveAttribute("data-in-total", "true");
    expect(within(row).getByTestId("ticket-fx")).toHaveTextContent("≈ $309 по курсу ЦБ РУз на 11.10 · на сайте 27 000 сом");
    expect(row).toHaveTextContent("$309,18");
    expect(row).not.toHaveTextContent("KGS");
    expect(row).not.toHaveTextContent("в итог не входит");
    expect(screen.getByTestId("trip-total")).toHaveTextContent("$759,18"); // comfort: 309.18 + 210 + 2 × 120
    expect(screen.getByTestId("pass-total-label")).toHaveTextContent("Итого на 1 человека · ориентировочно");
    expect(screen.getByTestId("trip-notes")).toHaveTextContent("в итог он вошёл по курсу ЦБ Республики Узбекистан");
    fireEvent.click(screen.getByTestId("trav-inc"));
    await waitFor(() => expect(within(screen.getByTestId("trip-row-ticket")).getByText("$618,36")).toBeInTheDocument());
    expect(screen.getByTestId("trip-row-ticket")).toHaveTextContent("$309,18 × 2");
    fireEvent.click(screen.getByRole("button", { name: "Premium" }));
    expect(screen.getByTestId("ticket-fx")).toHaveTextContent("≈ $2 061 по курсу ЦБ РУз на 11.10 · на сайте 180 000 сом");
  });

  it("fix 5.1 D: no rate (fx null) and not USD — as before: the site currency, out of the total", async () => {
    const set = bishkekSet();
    for (const k of ["economy", "comfort", "premium"] as const) {
      const tk = set.tiers![k].ticket;
      if (tk.status === "ok") Object.assign(tk, { fx: null, in_total: false });
    }
    renderTrip({ get: vi.fn(async () => set) }, { ev: BISHKEK });
    const row = await screen.findByTestId("trip-row-ticket");
    expect(row).toHaveAttribute("data-in-total", "false");
    expect(within(row).queryByTestId("ticket-fx")).toBeNull();
    expect(row).toHaveTextContent("27 000 KGS");
    expect(row).toHaveTextContent("цена в другой валюте — в итог не входит");
  });

  it("fix 5.1 E: the flight supplier did not answer → «Сервис перелётов не ответил» + «Попробовать снова» = the same parameters, a new calculation", async () => {
    const get = vi.fn(async () => almatySet({ flightDown: true }));
    const recalculate = vi.fn(async (_id: string, b: Parameters<Api["offers"]["recalculate"]>[1]) => almatySet({ travellers: b.travellers, overrides: b }));
    renderTrip({ get, recalculate });
    const row = await screen.findByTestId("trip-row-flight");
    expect(row).toHaveAttribute("data-status", "unavailable");
    expect(row).toHaveTextContent("Сервис перелётов не ответил");
    expect(row).not.toHaveTextContent("нет цены");
    expect(screen.getByTestId("pass-total-label")).toHaveTextContent("без перелёта");
    fireEvent.click(within(row).getByRole("button", { name: "Перелёт: попробовать снова" }));
    await waitFor(() => expect(recalculate).toHaveBeenCalledTimes(1));
    expect(recalculate.mock.calls[0]![1]).toEqual({ travellers: 1, direct_only: false, near_venue: false, extra_nights: 0 });
    await waitFor(() => expect(screen.getByTestId("trip-row-flight")).toHaveAttribute("data-status", "ok"));
    expect(screen.queryByTestId("flight-retry")).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    // a later change is a plain recalculation with the travellers' hotels kept (the force is one-shot)
    fireEvent.click(screen.getByTestId("trav-inc"));
    await waitFor(() => expect(recalculate).toHaveBeenCalledTimes(2));
    expect(recalculate.mock.calls[1]![1]).toMatchObject({ travellers: 2, keep_hotels: { comfort: "lp2a1a01" } });
  });

  it("fix 5.1 E: NOT_CONFIGURED and NO_PRICE are not retried; the hotel supplier failure retries too; no places → no block", async () => {
    renderTrip({ get: vi.fn(async () => almatySet({ flightOff: true, hotelDown: true, poiDown: true })) });
    const fl = await screen.findByTestId("trip-row-flight");
    expect(fl).toHaveTextContent("Расчёт перелётов временно отключён");
    expect(within(fl).queryByTestId("flight-retry")).toBeNull();
    expect(screen.getByTestId("trip-row-hotel")).toHaveTextContent("Сервис отелей не ответил");
    expect(within(screen.getByTestId("trip-row-hotel")).getByTestId("hotel-retry")).toHaveTextContent("Попробовать снова");
    expect(screen.queryByTestId("trip-poi")).toBeNull();
    expect(screen.queryByTestId("trip-error")).toBeNull();
    cleanup();
    renderTrip({ get: vi.fn(async () => almatySet({ flightNoPrice: true })) });
    const np = await screen.findByTestId("trip-row-flight");
    expect(np).toHaveTextContent("У поставщика нет цены перелёта на эти даты");
    expect(within(np).queryByTestId("flight-retry")).toBeNull();
  });

  it("the boundary keeps a broken block out of the detail", () => {
    const Boom = () => {
      throw new Error("bad data");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(
      <div>
        <TripBoundary>
          <Boom />
        </TripBoundary>
        <p>detail</p>
      </div>,
    );
    expect(container).toHaveTextContent("detail");
    spy.mockRestore();
  });
});

describe("API client", () => {
  it("GET /v1/events/{id}/offers?travellers= and POST …/offers/recalculate; OFFERS_UNAVAILABLE is not «no connection»", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const online = vi.fn();
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([String(url), init]);
      if (String(url).endsWith("/v1/session/telegram"))
        return new Response(JSON.stringify({ access_token: "a", expires_in: 900, refresh_token: "r", user: {}, security: {}, consent: {}, onboarding_completed: true }), { status: 200 });
      return new Response(JSON.stringify({ code: "OFFERS_UNAVAILABLE", message: "x", trace_id: "t", details: {} }), { status: 503 });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "https://bff.test", fetchImpl, storage: null, lang: () => "ru", hooks: { onConnectivity: online } } as ConstructorParameters<typeof ApiClient>[0]);
    await client.startSession("init");
    const api = createApi(client);
    await expect(api.offers.get("a/b", 2)).rejects.toMatchObject({ code: "OFFERS_UNAVAILABLE" });
    expect(calls.at(-1)![0]).toBe("https://bff.test/v1/events/a%2Fb/offers?travellers=2");
    await expect(api.offers.recalculate("e1", { travellers: 1, departure_iata: "ALA" })).rejects.toBeInstanceOf(ApiError);
    expect(calls.at(-1)![0]).toBe("https://bff.test/v1/events/e1/offers/recalculate");
    expect(calls.at(-1)![1].method).toBe("POST");
    expect(JSON.parse(String(calls.at(-1)![1].body))).toEqual({ travellers: 1, departure_iata: "ALA" });
    expect(online).toHaveBeenLastCalledWith(true);
  });
});

describe("plural «человек»", () => {
  it("на 1 человека, на 2 человека, на 5 человек, на 21 человека", () => {
    const f = translate("ru", "tr.people");
    const { pluralForm } = I18nForms;
    expect([1, 2, 4, 5, 6, 11, 21, 22].map((n) => `${n} ${pluralForm("ru", n, f)}`)).toEqual(["1 человека", "2 человека", "4 человека", "5 человек", "6 человек", "11 человек", "21 человека", "22 человека"]);
  });
});

/* ================================================================ fix 6.1 (prod 12.10, F1 Abu Dhabi) */

describe("fix 6.1: budget on priced parts, widened hotel search", () => {
  it("excludesText / formatRadius / beyondBase / sharedHotelTiers", () => {
    const t = tr("ru");
    expect(excludesText(["ticket"], t)).toBe("без учёта билета");
    expect(excludesText(["ticket", "flight"], t)).toBe("без учёта перелёта и билета");
    expect(excludesText([], t)).toBe("");
    expect(excludesText(["ticket"], tr("en"))).toBe("excluding the ticket");
    expect([5000, 1500, 15000, 1000].map((m) => formatRadius(m, "ru", t))).toEqual(["5 км", "1,5 км", "15 км", "1 км"]);
    const hs = abuSet().hotel_search!;
    expect(beyondBase({ distance_m: 9800, rating: "8.2" }, hs)).toEqual({ far: true, lowRating: true, lowStars: false });
    expect(beyondBase({ distance_m: 600, rating: "8.7" }, hs)).toEqual({ far: false, lowRating: false, lowStars: false });
    expect(beyondBase({ distance_m: 9800, rating: "8.2" }, { ...hs, widened: false })).toEqual({ far: false, lowRating: false, lowStars: false });
    expect(sharedHotelTiers(abuSet(), "economy")).toEqual([]);
    const one = buildOfferSet(ABU_ONE, opts({ departures: TAS_ONLY, budget: B3K }));
    expect(sharedHotelTiers(one, "economy")).toEqual(["comfort", "premium"]);
  });

  it("prod Abu Dhabi: different hotels by tier, Comfort recommended within $3 000 «без учёта билета», Premium over by $133", async () => {
    renderTrip({ get: vi.fn(async () => abuSet()) }, { ev: ABU });
    await screen.findByTestId("trip-pass");
    expect(screen.getByTestId("trip")).toHaveAttribute("data-tier", "comfort");
    expect(screen.getByTestId("pass-hotel")).toHaveTextContent("Centro Yas Island by Rotana");
    expect(screen.getByTestId("pass-fit")).toHaveTextContent("В вашем бюджете (без учёта билета)");
    expect(screen.getByTestId("pass-total-label")).toHaveTextContent("Итого на 1 человека · без билета · ориентировочно");
    const premium = screen.getByRole("button", { name: "Premium" });
    expect(premium).toHaveAccessibleDescription(/^Превышает ваш бюджет на \$133 \(без учёта билета\)\.$/);
    fireEvent.click(premium);
    expect(screen.getByTestId("pass-hotel")).toHaveTextContent("Saadiyat Rotana Resort");
    expect(screen.getByTestId("pass-fit")).toHaveTextContent("Превышает ваш бюджет на $133 (без учёта билета)");
    fireEvent.click(screen.getByRole("button", { name: "Economy" }));
    expect(screen.getByTestId("pass-hotel")).toHaveTextContent("Abu Dhabi Budget Inn");
    expect(screen.getByTestId("trip-total")).toHaveTextContent("$983");
    // the widened search says where it looked; hotels beyond the base are tagged; the note says the ticket is left out
    expect(screen.getByTestId("trip-notes")).toHaveTextContent("Рядом с площадкой (до 5 км, оценка 8,5+) мало отелей с ценой — показываем отели до 15 км, оценка гостей от 7,5.");
    const list = screen.getByTestId("trip-hotels");
    expect(within(list).getByRole("heading", { level: 2 })).toHaveTextContent("Отели · до 15 км · 7,5+");
    expect(within(list).getByTestId("trip-hotels-note")).toHaveTextContent("на человека, без учёта билета");
    const yas = within(list).getAllByTestId("trip-hotel").find((h) => h.getAttribute("data-hotel-id") === "lpad01")!;
    expect(within(yas).getByTestId("hotel-fit")).toHaveTextContent(/^Превышает ваш бюджет на \$4\s070,18$/);
    expect(within(yas).queryByTestId("hotel-far")).toBeNull();
    const inn = within(list).getAllByTestId("trip-hotel").find((h) => h.getAttribute("data-hotel-id") === "lpad04")!;
    expect(within(inn).getByTestId("hotel-far")).toHaveTextContent("дальше 5 км");
    expect(within(inn).getByTestId("hotel-low")).toHaveTextContent("оценка ниже 8,5");
    expect(screen.queryByTestId("hotel-shared")).toBeNull();
  });

  it("no other hotel even on the widest step: the hotel row says so (not three identical cards), the note too", async () => {
    renderTrip({ get: vi.fn(async () => buildOfferSet(ABU_ONE, opts({ departures: TAS_ONLY, budget: B3K }))) }, { ev: ABU_ONE });
    await screen.findByTestId("trip-pass");
    expect(screen.getByTestId("hotel-shared")).toHaveTextContent(/^Других отелей рядом не нашлось — этот же отель в тарифе (Economy|Comfort|Premium) и (Comfort|Premium)$/);
    expect(screen.getByTestId("trip-notes")).toHaveTextContent("Других отелей рядом не нашлось — в нескольких тарифах один отель");
    expect(screen.getByTestId("pass-fit")).toHaveTextContent("Превышает ваш бюджет на $4 070,18 (без учёта билета)");
  });

  it("no budget: no marks, «Укажите бюджет в профиле — подберём тариф»; different hotels anyway", async () => {
    renderTrip({ get: vi.fn(async () => abuSet({ budget: null })) }, { ev: ABU });
    expect(await screen.findByTestId("trip-budget-hint")).toHaveTextContent("Укажите бюджет в профиле — подберём тариф");
    expect(screen.queryByTestId("pass-fit")).toBeNull();
    expect(screen.queryAllByTestId("hotel-fit")).toHaveLength(0);
    expect(screen.getByTestId("pass-hotel")).toHaveTextContent("Centro Yas Island by Rotana"); // Comfort by default
  });
});

describe("fix 6.1 review: an older telegram-bff without keep_hotels", () => {
  const keep = { economy: "lp2a1a02", comfort: "lp2a1a01", premium: "lp2a1a03" };
  const post = (extra: Record<string, unknown> = {}) => ({ method: "POST" as const, body: { travellers: 2, direct_only: false, near_venue: false, extra_nights: 0, keep_hotels: keep, ...extra } });

  it("keepFallback: 422 on the field → without it (GET when nothing else is overridden); 404/405 → GET; others → null", () => {
    const strict = new ApiError(422, "VALIDATION_ERROR", "x", { in: "body", field: "keep_hotels" });
    expect(keepFallback(post(), strict)).toEqual({ method: "GET", travellers: 2 });
    expect(keepFallback(post({ near_venue: true }), strict)).toEqual({ method: "POST", body: { travellers: 2, direct_only: false, near_venue: true, extra_nights: 0 } });
    expect(keepFallback(post(), new ApiError(422, "VALIDATION_ERROR", "x", {}))).toEqual({ method: "GET", travellers: 2 });
    expect(keepFallback(post(), new ApiError(422, "VALIDATION_ERROR", "x", { field: "travellers" }))).toBeNull();
    expect(keepFallback(post(), new ApiError(404, "NOT_FOUND", "x"))).toEqual({ method: "GET", travellers: 2 });
    expect(keepFallback(post(), new ApiError(405, "METHOD_NOT_ALLOWED", "x"))).toEqual({ method: "GET", travellers: 2 });
    expect(keepFallback(post({ extra_nights: 1 }), new ApiError(404, "NOT_FOUND", "x"))).toBeNull(); // no POST route — no settings
    expect(keepFallback(post(), new ApiError(404, "EVENT_NOT_FOUND", "x"))).toBeNull();
    expect(keepFallback(post(), new ApiError(503, "OFFERS_UNAVAILABLE", "x"))).toBeNull();
    expect(keepFallback({ method: "GET", travellers: 1 }, strict)).toBeNull();
    expect(keepFallback({ method: "POST", body: { travellers: 1, direct_only: true, near_venue: false, extra_nights: 0 } }, strict)).toBeNull();
  });

  it("a change of travellers against the old BFF: 422 → the same calculation by GET, no error; keep_hotels not sent again", async () => {
    const get = vi.fn(async (_id: string, n: number) => almatySet({ travellers: n }));
    const recalculate = vi.fn(async (_id: string, b: RecalcBody) => {
      if (b.keep_hotels) throw new ApiError(422, "VALIDATION_ERROR", "x", { in: "body", field: "keep_hotels" });
      return almatySet({ travellers: b.travellers, overrides: b });
    });
    renderTrip({ get, recalculate });
    await screen.findByTestId("trip-pass");
    fireEvent.click(screen.getByRole("button", { name: "Больше путешественников" }));
    await waitFor(() => expect(screen.getByTestId("trip-total")).toHaveTextContent("$844"));
    expect(get.mock.calls.map((c) => c[1])).toEqual([1, 2]);
    expect(recalculate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("trip-recalc-error")).toBeNull();
    expect(screen.getByTestId("trip-travellers")).toHaveTextContent("2");
    // the next change goes straight without keep_hotels (one rejected request per block, not per tap)
    fireEvent.click(screen.getByRole("button", { name: "Больше путешественников" }));
    await waitFor(() => expect(get.mock.calls.map((c) => c[1])).toEqual([1, 2, 3]));
    expect(recalculate).toHaveBeenCalledTimes(1);
  });

  it("an old BFF without POST …/recalculate (405): travellers fall back to GET", async () => {
    const get = vi.fn(async (_id: string, n: number) => almatySet({ travellers: n }));
    const recalculate = vi.fn(async () => {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "x");
    });
    renderTrip({ get, recalculate });
    await screen.findByTestId("trip-pass");
    fireEvent.click(screen.getByRole("button", { name: "Больше путешественников" }));
    await waitFor(() => expect(get.mock.calls.map((c) => c[1])).toEqual([1, 2]));
    expect(screen.queryByTestId("trip-recalc-error")).toBeNull();
  });

  it("HOTEL_SEARCH_INCOMPLETE: the note says to try later and offers «Попробовать снова» (a new calculation)", async () => {
    const set = { ...almatySet(), notes: ["HOTEL_SEARCH_INCOMPLETE" as const] };
    const recalculate = vi.fn(async (_id: string, b: RecalcBody) => almatySet({ travellers: b.travellers, overrides: b }));
    renderTrip({ get: vi.fn(async () => set), recalculate });
    const note = await screen.findByText("Не удалось расширить поиск отелей — попробуйте позже.");
    fireEvent.click(within(note.closest(".note") as HTMLElement).getByRole("button", { name: "Попробовать снова" }));
    await waitFor(() => expect(recalculate).toHaveBeenCalledTimes(1));
  });
});

describe("fix 6.2: nothing fits the budget — said above the tiers; copied tier marks are separated", () => {
  it("«В вашем бюджете вариантов не нашлось — ближайший: Premier Inn…, сверх $1 039,96 (без учёта билета)»; Economy opens", async () => {
    const set = abu62Set();
    expect(set.notes).toContain("BUDGET_NONE_WITHIN");
    renderTrip({ get: vi.fn(async () => set) }, { ev: ABU62 });
    await screen.findByTestId("trip-pass");
    expect(screen.getByTestId("trip")).toHaveAttribute("data-tier", "economy");
    expect(screen.getByTestId("trip-budget-none")).toHaveTextContent(
      /^В вашем бюджете вариантов не нашлось — ближайший: Premier Inn Abu Dhabi Airport, сверх \$1\s039,96 \(без учёта билета\)$/,
    );
    expect(screen.getByTestId("pass-hotel")).toHaveTextContent("Premier Inn Abu Dhabi Airport");
    expect(screen.queryByText("В вашем бюджете вариантов не нашлось.")).toBeNull(); // not repeated in the notes
    // the user opened Premium: «Показать» brings the closest back
    fireEvent.click(screen.getByRole("button", { name: "Premium" }));
    fireEvent.click(screen.getByRole("button", { name: "Показать" }));
    expect(screen.getByTestId("trip")).toHaveAttribute("data-tier", "economy");
    // hidden texts of the tier marks (screen readers) do not run together when copied
    const text = screen.getByTestId("trip-tiers").textContent ?? "";
    expect(text).toContain("(без учёта билета). Превышает ваш бюджет на");
    expect(text).not.toMatch(/\)Превышает/);
  });

  it("the closest tier is over the budget without an amount (over_by null) — the text has no «сверх»", async () => {
    const set = abu62Set();
    set.tiers!.economy.over_by = null;
    renderTrip({ get: vi.fn(async () => set) }, { ev: ABU62 });
    expect(await screen.findByTestId("trip-budget-none")).toHaveTextContent(/^В вашем бюджете вариантов не нашлось — ближайший: Premier Inn Abu Dhabi Airport$/);
  });

  it("something fits — no banner, the tier within opens first", async () => {
    renderTrip({ get: vi.fn(async () => abuSet()) }, { ev: ABU });
    await screen.findByTestId("trip-pass");
    expect(screen.queryByTestId("trip-budget-none")).toBeNull();
    expect(screen.getByTestId("pass-fit")).toHaveAttribute("data-fit", "within");
  });
});
