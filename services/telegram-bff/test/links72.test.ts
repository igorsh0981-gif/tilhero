/**
 * Исправление 7.2: «Билеты на Aviasales» в чате консьержа и в блоке «Поездка» — домены ссылок на перелёт из одного
 * источника (packages/contracts/link-domains.json), партнёрские ссылки Travelpayouts в реальном формате:
 * длинная tp.media/r?… и короткая aviasales.tp.st/… (support.travelpayouts.com, «API for Travelpayouts partner links»).
 */
import { describe, expect, it } from "vitest";
import linkDomains from "../../../packages/contracts/link-domains.json" with { type: "json" };
import { FLIGHT_LINK_DOMAINS, flightLink, isFlightSearchUrl } from "../src/offers.js";
import { FLIGHT_SEARCH_URL_PATTERN } from "../src/schemas.js";

const contract: { flight: string[] } = linkDomains;
const TP_LONG = "https://tp.media/r?marker=424242&trs=777&p=4114&u=https%3A%2F%2Fwww.aviasales.com%2Fsearch%2FTAS1710FRU19101";
const TP_SHORT = "https://aviasales.tp.st/kn3kv29H?erid=2VtzqwiKLkx";

describe("7.2: flight link domains", () => {
  it("the BFF list is the contract list", () => {
    expect([...FLIGHT_LINK_DOMAINS]).toEqual(contract.flight);
  });

  it("real Travelpayouts partner links pass both checks (done.actions schema and offers search_url)", () => {
    const re = new RegExp(FLIGHT_SEARCH_URL_PATTERN, "u");
    for (const url of [TP_LONG, TP_SHORT, "https://www.aviasales.com/search/TAS1710FRU19101", TP_LONG.replace("tp.media", "TP.MEDIA.")]) {
      expect([url, re.test(url), isFlightSearchUrl(url)]).toEqual([url, true, true]);
    }
    for (const url of ["https://yesim.tp.st/abc", "https://tp.st/abc", "https://aviasales.tp.st.evil.example/x", "http://aviasales.tp.st/x"]) {
      expect([url, re.test(url), isFlightSearchUrl(url)]).toEqual([url, false, false]);
    }
  });

  it("review 7.2: a redirect must lead to the Aviasales site; the host is lower-case without a trailing dot", () => {
    expect(flightLink(TP_LONG.replace("tp.media", "TP.MEDIA."))).toBe(TP_LONG);
    expect(flightLink("https://www.aviasales.com./search/TAS1710FRU1")).toBe("https://www.aviasales.com/search/TAS1710FRU1");
    expect(flightLink("https://www.aviasales.com/redirect?url=https%3A%2F%2Fwww.aviasales.ru%2Fx")).not.toBeNull();
    for (const url of [
      "https://tp.media/r?marker=1",
      "https://tp.media/r?u=https%3A%2F%2Fevil.example%2Fx",
      "https://tp.media/r?u=http%3A%2F%2Fwww.aviasales.com%2Fx",
      "https://tp.media/r?u=https%3A%2F%2Fwww.aviasales.com%2Fx&u=https%3A%2F%2Fevil.example",
      "https://tp.media/r?u=https%3A%2F%2Ftp.media%2Fr%3Fu%3Dhttps%253A%252F%252Fevil.example",
      "https://www.aviasales.com/redirect?url=https%3A%2F%2Fevil.example%2Fx",
      "https://www.aviasales.com/redirect",
    ]) {
      expect([url, flightLink(url), isFlightSearchUrl(url)]).toEqual([url, null, false]);
    }
  });
});
