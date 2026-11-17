/**
 * Исправление 5.2 (prod 11.10.2026: TAS → FRU, Aviasales «unknown location code `FRU`»): перелёт
 * `unavailable/ROUTE_NOT_SUPPORTED` со ссылкой на поиск Aviasales (`search_url`) проходит BFF как есть.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import type { OfferSetView } from "@tilhero/contracts/bff";
import { OfferSetViewSchema } from "../src/schemas.js";
import { bearer, catalogEvent, closeRedis, login, makeHarness, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
let eventId: string;

const SEARCH = "https://www.aviasales.com/search/TAS1710FRU19101";

beforeEach(async () => {
  h = await makeHarness();
  s = await login(h);
  const e = catalogEvent();
  h.fake.catalog.push(e);
  eventId = e.event_id;
  const r = await h.app.inject({ method: "PUT", url: "/v1/profile/departures", headers: bearer(s.access), payload: { airports: ["TAS"] } });
  expect(r.statusCode).toBe(200);
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const routeError = (searchUrl?: string) => (set: OfferSetView) => {
  for (const t of Object.values(set.tiers!)) {
    t.flight = { status: "unavailable", reason: "ROUTE_NOT_SUPPORTED", ...(searchUrl ? { search_url: searchUrl } : {}) };
    t.totals.missing = ["flight"];
    t.status = "partial";
  }
  return set;
};

describe("5.2: flight route unknown to the supplier", () => {
  it("ROUTE_NOT_SUPPORTED with search_url passes through", async () => {
    h.fake.offersBuild = (set) => routeError(SEARCH)(structuredClone(set));
    const res = await h.app.inject({ url: `/v1/events/${eventId}/offers?travellers=1`, headers: bearer(s.access) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OfferSetView;
    expect(Value.Check(OfferSetViewSchema, body)).toBe(true);
    expect(body.tiers!.comfort.flight).toEqual({ status: "unavailable", reason: "ROUTE_NOT_SUPPORTED", search_url: SEARCH });
  });

  it("without a link the reason still passes (no search_url field)", async () => {
    h.fake.offersBuild = (set) => routeError()(structuredClone(set));
    const res = await h.app.inject({ url: `/v1/events/${eventId}/offers?travellers=1`, headers: bearer(s.access) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as OfferSetView).tiers!.economy.flight).toEqual({ status: "unavailable", reason: "ROUTE_NOT_SUPPORTED" });
  });
});
