/** Fix 7.2: «Билеты на Aviasales» in the chat — the flight link domains are the contract list (link-domains.json);
 *  real Travelpayouts partner links (long tp.media/r?…, short aviasales.tp.st/…) open, other brands do not. */
import { describe, expect, it } from "vitest";
import linkDomains from "../../../packages/contracts/link-domains.json";
import { FLIGHT_LINK_DOMAINS, flightSearchUrl } from "../src/ai/chat";
import { routeSearchLink } from "../src/trip/logic";

const contract: { flight: string[] } = linkDomains;

describe("fix 7.2: flight links", () => {
  it("the Mini App list is the contract list", () => {
    expect([...FLIGHT_LINK_DOMAINS]).toEqual(contract.flight);
  });

  it("partner links in the real format open; foreign Travelpayouts brands do not", () => {
    const long = "https://tp.media/r?marker=424242&trs=777&p=4114&u=https%3A%2F%2Fwww.aviasales.com%2Fsearch%2FTAS1710FRU19101";
    const short = "https://aviasales.tp.st/kn3kv29H?erid=2VtzqwiKLkx";
    expect(flightSearchUrl({ url: long })).toBe(long);
    expect(flightSearchUrl({ url: short })).toBe(short);
    expect(flightSearchUrl({ url: long.replace("tp.media", "TP.MEDIA.") })).toBe(long);
    for (const bad of ["https://yesim.tp.st/abc", "https://tp.st/abc", "https://aviasales.tp.st.evil.example/x", "http://aviasales.tp.st/x"]) {
      expect(flightSearchUrl({ url: bad })).toBeNull();
    }
  });

  it("review 7.2: a redirect opens only when it leads to the Aviasales site; the trip block uses the same check", () => {
    expect(flightSearchUrl({ url: "https://www.aviasales.com./search/TAS1710FRU1" })).toBe("https://www.aviasales.com/search/TAS1710FRU1");
    for (const bad of [
      "https://tp.media/r?marker=1",
      "https://tp.media/r?u=https%3A%2F%2Fevil.example%2Fx",
      "https://tp.media/r?u=https%3A%2F%2Fwww.aviasales.com%2Fx&u=https%3A%2F%2Fevil.example",
      "https://www.aviasales.com/redirect?url=https%3A%2F%2Fevil.example%2Fx",
    ]) {
      expect(flightSearchUrl({ url: bad })).toBeNull();
      expect(routeSearchLink({ status: "unavailable", reason: "ROUTE_NOT_SUPPORTED", search_url: bad })).toBe("");
    }
  });
});
