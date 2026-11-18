/**
 * Sprint-5 fixtures of the mock admin-bff: trip providers (GET /travel/providers) and offer snapshots
 * (GET /offers/{id}). Shapes follow packages/contracts/src/admin.ts (section «Спринт 5») and the normalized
 * offer of admin-bff (routes/travel.ts: links — https or null).
 */
import type { OfferSnapshotAdmin, TravelProviderProbe, TravelProviderStatus } from "@tilhero/contracts/admin";
import { USER, iso } from "./data";

const MIN = 60_000;
const HOUR = 60 * MIN;

export const OFFER_OK = "0ffe0000-0000-4000-8000-000000003074";
export const OFFER_GONE = "0ffe0000-0000-4000-8000-000000003069";

export type ProvidersVariant = "mixed" | "allOk" | "fresh" | "diag";
export type TravelName = TravelProviderStatus["name"];
/** fix 5.1: what «Check now» answers in the mock */
export type ProbeOutcome = "ok" | "fail" | "limited" | "unavailable";

export function providers(v: ProvidersVariant = "mixed"): TravelProviderStatus[] {
  const ok = (name: TravelProviderStatus["name"], used: number, limit: number): TravelProviderStatus => ({
    name,
    configured: true,
    enabled: true,
    quota: { day_used: used, day_limit: limit },
    breaker: "closed",
    last_error: null,
    last_success_at: iso(-3 * MIN),
  });
  if (v === "allOk") return [ok("aviasales", 1240, 20000), ok("liteapi", 318, 20000), ok("osm", 96, 2000), ok("cbu", 4, 500)];
  const off = (name: TravelProviderStatus["name"]): TravelProviderStatus => ({ name, configured: false, enabled: true, quota: null, breaker: "closed", last_error: null, last_success_at: null });
  if (v === "fresh") return [off("aviasales"), off("liteapi"), off("osm"), off("cbu")];
  if (v === "diag")
    // the customer's case (FEEDBACK_5_1 п. 6): Aviasales failed at 14:07 after a success at 13:48; LiteAPI refuses the key
    return [
      {
        ...ok("aviasales", 1240, 20000),
        last_success_at: iso(-19 * MIN - 25 * MIN),
        last_error: { code: "PROVIDER_BAD_RESPONSE", reason: "success_false", message: "No prices found for TAS-FRU on 2026-11-13", at: iso(-25 * MIN), http_status: 200 },
      },
      { ...ok("liteapi", 210, 20000), last_success_at: iso(-3 * HOUR), last_error: { code: "PROVIDER_NOT_CONFIGURED", reason: "upstream_401", message: null, at: iso(-6 * MIN), http_status: 401 } },
      { ...ok("osm", 96, 2000), last_success_at: iso(-50 * MIN), last_error: { code: "PROVIDER_BAD_RESPONSE", reason: "shape", message: null, at: iso(-12 * MIN), http_status: 200 } },
      ok("cbu", 4, 500),
    ];
  return [
    ok("aviasales", 1240, 20000),
    {
      name: "liteapi",
      configured: true,
      enabled: true,
      quota: { day_used: 16620, day_limit: 20000 },
      breaker: "open",
      last_error: { code: "PROVIDER_UNAVAILABLE", reason: null, message: null, at: iso(-4 * MIN), http_status: null },
      last_success_at: iso(-38 * MIN),
    },
    off("osm"),
    ok("cbu", 4, 500),
  ];
}

/** «Check now» in the mock: a success, or a failure with the provider's own reason */
export function probeResult(name: TravelName, outcome: ProbeOutcome): TravelProviderProbe {
  const at = iso(0);
  if (outcome !== "fail") return { name, ok: true, latency_ms: name === "cbu" ? 96 : 412, code: null, reason: null, message: null, http_status: 200, checked_at: at };
  const fail: Record<TravelName, Pick<TravelProviderProbe, "code" | "reason" | "message" | "http_status" | "latency_ms">> = {
    aviasales: { code: "PROVIDER_BAD_RESPONSE", reason: "success_false", message: "No prices found for TAS-IST on 2026-11-10", http_status: 200, latency_ms: 840 },
    liteapi: { code: "PROVIDER_NOT_CONFIGURED", reason: "upstream_401", message: null, http_status: 401, latency_ms: 230 },
    osm: { code: "PROVIDER_UNAVAILABLE", reason: "timeout", message: null, http_status: null, latency_ms: 10_000 },
    cbu: { code: "PROVIDER_BAD_RESPONSE", reason: "shape", message: null, http_status: 200, latency_ms: 120 },
  };
  return { name, ok: false, ...fail[name], checked_at: at };
}

const MAP = {
  yandex: "https://yandex.ru/maps/?pt=76.9420,43.2550&z=16&l=map",
  google: "https://www.google.com/maps/search/?api=1&query=43.2550,76.9420",
  osm: "https://www.openstreetmap.org/?mlat=43.2550&mlon=76.9420#map=17/43.2550/76.9420",
  dgis: "https://2gis.ru/geo/76.9420,43.2550",
};

/** TCK-3074 «Hotel far from the venue»: Comfort for 2, the ticket price is in UZS (not in the total), expired */
export function snapshot(id: string, variant: "ok" | "nodeparture" | "foreign" | "fx" = "ok"): OfferSnapshotAdmin {
  const created = iso(-(4 * HOUR + 10 * MIN));
  const expires = iso(-(3 * HOUR + 10 * MIN));
  const flight =
    variant === "nodeparture"
      ? { status: "unavailable", reason: "NO_DEPARTURE" }
      : {
          status: "ok",
          provider: "aviasales",
          origin: "TAS",
          destination: "ALA",
          depart_at: "2026-11-13T07:40:00+05:00",
          return_at: "2026-11-16T19:05:00+06:00",
          airline: "HY",
          flight_number: "763",
          transfers: 0,
          return_transfers: 0,
          duration_minutes: 95,
          duration_back_minutes: 100,
          price_per_person: "142.00",
          total: "284.00",
          deeplink: "https://www.aviasales.com/search/TAS1311ALA16111?t=HY1763&marker=e2e",
          fetched_at: created,
          dates_shifted: false,
        };
  return {
    offer_id: id,
    user_id: variant === "foreign" ? USER.igor : USER.aziza,
    event_id: "e1000000-0000-4000-8000-000000000042",
    tier: "comfort",
    travellers: 2,
    created_at: created,
    expires_at: expires,
    offer: {
      offer_id: id,
      tier: "comfort",
      status: "partial",
      ticket:
        variant === "fx"
          ? // fix 5.1: SHAKIRA, Bishkek (ticket.gov.kg) — the KGS price converted at the CBU rate, in the total
            {
              status: "ok",
              price_per_person: "27000.00",
              currency: "KGS",
              in_total: true,
              provider: "aiweb.ticket-gov-kg",
              deeplink: "https://ticket.gov.kg/event/shakira-bishkek",
              fetched_at: iso(-(5 * HOUR)),
              fx: { price_per_person_usd: "309.00", rate: "0.011451", date: "2026-10-11", source: "cbu.uz" },
            }
          : {
              status: "ok",
              price_per_person: "450000.00",
              currency: "UZS",
              in_total: false,
              provider: "aiweb.ticketon-kz",
              deeplink: "https://ticketon.kz/almaty/event/dimash-qudaibergen-almaty-arena",
              fetched_at: iso(-(5 * HOUR)),
            },
      flight,
      hotel: {
        status: "ok",
        provider: "liteapi",
        hotel_id: "lp1beec",
        name: "Rixos Almaty",
        stars: 5,
        rating: "9.1",
        review_count: 1840,
        distance_m: 1830,
        nights: 3,
        rooms: 1,
        total: "390.00",
        refundable: true,
        board: "Breakfast included",
        deeplink: "https://book.tilhero.app/hotels/lp1beec?checkin=2026-11-13&checkout=2026-11-16",
        map: MAP,
        fetched_at: created,
      },
      totals: variant === "nodeparture"
        ? { total: "390.00", per_person: "195.00", currency: "USD", missing: ["ticket", "flight"] }
        : variant === "fx"
          ? { total: "1292.00", per_person: "646.00", currency: "USD", missing: [] }
          : { total: "674.00", per_person: "337.00", currency: "USD", missing: ["ticket"] },
      expires_at: expires,
    },
    trip: {
      kind: "trip",
      reason: null,
      destination: { city: "Алматы", country_code: "KZ", iata: "ALA", venue: { name: "Almaty Arena", precision: "venue", map: MAP } },
      out_date: "2026-11-13",
      back_date: "2026-11-16",
      nights: 3,
    },
    departure: variant === "nodeparture" ? null : { iata: "TAS", city: "Ташкент", chosen_by: "cheapest" },
    notes: variant === "fx" ? ["TICKET_FX_CONVERTED"] : ["TICKET_NOT_USD"],
  };
}
