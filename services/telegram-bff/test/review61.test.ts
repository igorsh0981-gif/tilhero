/**
 * Ревью 6.1: search_url (5.2) пропускается только у перелёта ROUTE_NOT_SUPPORTED и только на доменах Aviasales
 * (aviasales.com/.ru/.kz, tp.media — как FLIGHT_LINK_DOMAINS в services/offers); иначе поле отбрасывается.
 */
import { describe, expect, it } from "vitest";
import type { OfferSetView } from "@tilhero/contracts/bff";
import { isFlightSearchUrl, sanitizeOfferSet } from "../src/offers.js";
import { offerSetFixture } from "./helpers.js";

const EVENT = "0b7c3a52-1d2e-4f60-8a9b-000000000999";
const OK = "https://www.aviasales.ru/search/TAS0312XYZ07121?marker=1";

function withFlight(flight: Record<string, unknown>, other: Record<string, Record<string, unknown>> = {}): unknown {
  const set = structuredClone(offerSetFixture(EVENT)) as unknown as { tiers: Record<string, Record<string, unknown>> };
  for (const t of Object.values(set.tiers)) {
    t.flight = flight;
    Object.assign(t, other);
    (t.totals as { missing: string[] }).missing = ["flight"];
    t.status = "partial";
  }
  return set;
}
const flightOf = (v: OfferSetView) => v.tiers!.comfort.flight as unknown as Record<string, unknown>;

describe("review 6.1: flight search_url", () => {
  it("ROUTE_NOT_SUPPORTED + https on aviasales.* / tp.media (and subdomains) → kept", () => {
    for (const url of [OK, "https://aviasales.com/search/x", "https://aviasales.kz/x", "https://tp.media/r?marker=1&u=https%3A%2F%2Fwww.aviasales.com%2Fx", "https://c1.tp.media/r?u=https%3A%2F%2Fwww.aviasales.com%2Fx"]) {
      expect(flightOf(sanitizeOfferSet(withFlight({ status: "unavailable", reason: "ROUTE_NOT_SUPPORTED", search_url: url }), EVENT)).search_url, url).toBe(url);
    }
  });

  it("foreign domain, look-alike, http, userinfo, other port → field dropped, response still valid", () => {
    for (const url of [
      "https://evil.example/aviasales.ru",
      "https://aviasales.ru.evil.example/x",
      "https://notaviasales.ru/x",
      "http://www.aviasales.ru/x",
      "https://user@aviasales.ru/x",
      "https://www.aviasales.ru:8443/x",
      "javascript:alert(1)",
      42,
    ]) {
      const f = flightOf(sanitizeOfferSet(withFlight({ status: "unavailable", reason: "ROUTE_NOT_SUPPORTED", search_url: url }), EVENT));
      expect(f, String(url)).toEqual({ status: "unavailable", reason: "ROUTE_NOT_SUPPORTED" });
    }
  });

  it("other reasons / other components → field dropped", () => {
    const v = sanitizeOfferSet(
      withFlight({ status: "unavailable", reason: "NO_DEPARTURE", search_url: OK }, { hotel: { status: "unavailable", reason: "NO_HOTEL", search_url: OK } }),
      EVENT,
    );
    expect(flightOf(v)).toEqual({ status: "unavailable", reason: "NO_DEPARTURE" });
    expect(v.tiers!.economy.hotel).toEqual({ status: "unavailable", reason: "NO_HOTEL" });
  });

  it("isFlightSearchUrl unit", () => {
    expect(isFlightSearchUrl(OK)).toBe(true);
    expect(isFlightSearchUrl("https://aviasales.ru.example/x")).toBe(false);
    expect(isFlightSearchUrl(null)).toBe(false);
  });
});
