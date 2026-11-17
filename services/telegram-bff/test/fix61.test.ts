/**
 * Исправление 6.1 (prod 12.10, F1 Abu Dhabi): бюджет по оценённым частям (`budget_excludes` — «без учёта билета»),
 * ступень поиска отелей (`hotel_search`), заметки HOTEL_SEARCH_WIDENED / HOTEL_ALTERNATIVES_NONE. BFF пропускает их
 * как прислал offers, проверяет согласованность, у старого offers — значения по умолчанию.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import type { OfferSetView, Preferences } from "@tilhero/contracts/bff";
import { sanitizeOfferSet } from "../src/offers.js";
import { OfferSetViewSchema } from "../src/schemas.js";
import { bearer, catalogEvent, closeRedis, login, makeHarness, offerSetFixture, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
let eventId: string;

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

const get = (url: string) => h.app.inject({ url, headers: bearer(s.access) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildCalls = () => h.fake.callsTo("offers", "POST", "/internal/v1/offers:build") as Array<{ body: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tamper = (fn: (set: any) => unknown) => {
  h.fake.offersBuild = (set) => fn(structuredClone(set));
};
const setBudget = (budget: Preferences["budget"]) => {
  h.fake.prefs.get(s.userId)!.budget = budget;
};

describe("6.1: budget on priced parts, hotel search step", () => {
  it("custom $3 000 from the profile reaches offers:build; budget_excludes, hotel_search and new notes pass through", async () => {
    setBudget({ currency: "USD", preset: "custom", min: 0, max: 3000, custom_amount: 3000 });
    tamper((set: OfferSetView) => {
      for (const t of [set.tiers!.economy, set.tiers!.comfort, set.tiers!.premium]) t.budget_excludes = ["ticket"];
      set.tiers!.economy.budget_fit = "within";
      set.tiers!.comfort.budget_fit = "within";
      set.tiers!.premium.budget_fit = "over";
      set.tiers!.premium.over_by = "133.00";
      set.hotels_nearby[0]!.budget_fit = "within";
      set.hotels_nearby[0]!.budget_excludes = ["ticket"];
      set.hotel_search = { radius_m: 15000, rating_min: "7.5", base_radius_m: 5000, base_rating_min: "8.5", widened: true, found: 4, min_stars: null, base_min_stars: null, from_prefs: false };
      set.notes = ["FLIGHT_DATES_SHIFTED", "HOTEL_SEARCH_WIDENED"];
      return set;
    });
    const res = await get(`/v1/events/${eventId}/offers?travellers=1`);
    expect(res.statusCode).toBe(200);
    expect(buildCalls()[0]!.body.budget).toEqual({ min: null, max: "3000.00" });
    const body = res.json() as OfferSetView;
    expect(Value.Check(OfferSetViewSchema, body)).toBe(true);
    expect(body.tiers!.premium).toMatchObject({ budget_fit: "over", over_by: "133.00", budget_excludes: ["ticket"] });
    expect(body.hotels_nearby[0]!.budget_excludes).toEqual(["ticket"]);
    expect(body.hotel_search).toMatchObject({ radius_m: 15000, widened: true, found: 4 });
    expect(body.notes).toEqual(["FLIGHT_DATES_SHIFTED", "HOTEL_SEARCH_WIDENED"]);
  });

  it("«без учёта …» with an unknown fit is inconsistent: tier → 503, nearby hotel dropped", async () => {
    tamper((set: OfferSetView) => {
      set.hotels_nearby.push({ ...set.hotels_nearby[0]!, hotel_id: "bad", budget_fit: "unknown", budget_excludes: ["ticket"] });
      return set;
    });
    const ok = await get(`/v1/events/${eventId}/offers`);
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as OfferSetView).hotels_nearby.map((x) => x.hotel_id)).toEqual(["lp2"]);
    tamper((set: OfferSetView) => {
      set.tiers!.comfort.budget_excludes = ["ticket"];
      return set;
    });
    const bad = await get(`/v1/events/${eventId}/offers?travellers=3`);
    expect(bad.statusCode).toBe(503);
  });

  it("old offers without 6.1 fields → budget_excludes [] and hotel_search null", () => {
    const set = structuredClone(offerSetFixture(eventId)) as unknown as Record<string, unknown> & OfferSetView;
    delete (set as Partial<OfferSetView>).hotel_search;
    for (const t of [set.tiers!.economy, set.tiers!.comfort, set.tiers!.premium]) delete (t as Partial<typeof t>).budget_excludes;
    delete (set.hotels_nearby[0] as Partial<(typeof set.hotels_nearby)[0]>).budget_excludes;
    const legacy = new Set<string>();
    const out = sanitizeOfferSet(set, eventId, legacy);
    expect(out.hotel_search).toBeNull();
    expect(out.tiers!.economy.budget_excludes).toEqual([]);
    expect(out.hotels_nearby[0]!.budget_excludes).toEqual([]);
    expect([...legacy].sort()).toEqual(["hotel_search", "hotels_nearby.budget_excludes", "tiers.budget_excludes"]);
  });

  it("bad hotel_search shape → 503 (not passed to the Mini App)", async () => {
    tamper((set: OfferSetView) => {
      (set as unknown as Record<string, unknown>).hotel_search = { radius_m: -1, rating_min: "x" };
      return set;
    });
    expect((await get(`/v1/events/${eventId}/offers`)).statusCode).toBe(503);
  });
});
