/**
 * Исправление 6.3: настройки отеля (оценка гостей, расстояние до площадки, звёзды) — профиль (preferences.hotel_prefs)
 * и «Настроить расчёт» поездки (recalculate.hotel_filters) → offers:build.hotel_filters и offer_params слежения.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import type { OfferSetView, Preferences } from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import { hotelFiltersOf, rejectedNewFields, sanitizeOfferSet, tripHotelFiltersOf, withoutFields51, type BuildRequest } from "../src/offers.js";
import { OfferSetViewSchema, PreferencesSchema } from "../src/schemas.js";
import { SPRINT6_ENV, bearer, catalogEvent, closeRedis, domainError, login, makeHarness, offerSetFixture, type Harness, type LoggedIn } from "./helpers.js";

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

const send = (method: "GET" | "PATCH" | "POST" | "PUT", url: string, payload?: object, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, headers: { ...bearer(s.access), ...headers }, ...(payload ? { payload } : {}) });
const recalc = (body: object) => send("POST", `/v1/events/${eventId}/offers/recalculate`, body);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildCalls = () => h.fake.callsTo("offers", "POST", "/internal/v1/offers:build") as Array<{ body: any }>;
const setHotel = (hotel_prefs: Preferences["hotel_prefs"]) => {
  h.fake.prefs.get(s.userId)!.hotel_prefs = hotel_prefs;
};
const DEFAULT = { rating_min: null, max_distance_km: null, min_stars: null };

describe("6.3: hotel settings in the profile", () => {
  it("GET /v1/profile → hotel_prefs; PATCH passes them to preferences", async () => {
    const p = await send("GET", "/v1/profile");
    expect(p.statusCode).toBe(200);
    expect(p.json().preferences.hotel_prefs).toEqual(DEFAULT);
    const r = await send("PATCH", "/v1/profile/preferences", { hotel_prefs: { rating_min: 9, max_distance_km: 1, min_stars: null }, version: 1 });
    expect(r.statusCode).toBe(200);
    expect(r.json().hotel_prefs).toEqual({ rating_min: 9, max_distance_km: 1, min_stars: null });
    expect(Value.Check(PreferencesSchema, r.json())).toBe(true);
    const patch = h.fake.callsTo("preferences", "PATCH", "/internal/v1/me/preferences") as Array<{ body: unknown }>;
    expect(patch.at(-1)!.body).toEqual({ hotel_prefs: { rating_min: 9, max_distance_km: 1, min_stars: null }, version: 1 });
  });

  it.each([{ rating_min: 11 }, { rating_min: "9" }, { max_distance_km: 0 }, { max_distance_km: 2.5 }, { min_stars: 6 }, { radius_m: 1000 }])(
    "invalid hotel_prefs %j → 422 PREFERENCES_INVALID, preferences not called",
    async (bad) => {
      const r = await send("PATCH", "/v1/profile/preferences", { hotel_prefs: { ...DEFAULT, ...bad } });
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe("PREFERENCES_INVALID");
      expect(h.fake.callsTo("preferences", "PATCH", "/internal/v1/me/preferences")).toHaveLength(0);
    },
  );

  it("old preferences without hotel_prefs (rollout) → defaults, not 500", async () => {
    delete (h.fake.prefs.get(s.userId) as Partial<Preferences>).hotel_prefs;
    const p = await send("GET", "/v1/profile");
    expect(p.statusCode).toBe(200);
    expect(p.json().preferences.hotel_prefs).toEqual(DEFAULT);
    const r = await send("PATCH", "/v1/profile/preferences", { search_horizon_months: 6 });
    expect(r.statusCode).toBe(200);
    expect(r.json().hotel_prefs).toEqual(DEFAULT);
  });
});

describe("6.3: hotel_filters in offers:build", () => {
  it("profile → hotel_filters; all defaults → no field (same params hash as before)", async () => {
    expect((await send("GET", `/v1/events/${eventId}/offers`)).statusCode).toBe(200);
    expect(buildCalls()[0]!.body).not.toHaveProperty("hotel_filters");
    setHotel({ rating_min: 9, max_distance_km: 1, min_stars: 4 });
    expect((await send("GET", `/v1/events/${eventId}/offers?travellers=2`)).statusCode).toBe(200);
    expect(buildCalls()[1]!.body.hotel_filters).toEqual({ rating_min: 9, max_distance_km: 1, min_stars: 4 });
  });

  it("recalculate: trip settings override the profile field by field; 0 stars = any even over the profile", async () => {
    setHotel({ rating_min: 9, max_distance_km: 1, min_stars: 4 });
    expect((await recalc({ travellers: 1, hotel_filters: { max_distance_km: 15, rating_min: 7 } })).statusCode).toBe(200);
    expect(buildCalls()[0]!.body.hotel_filters).toEqual({ rating_min: 7, max_distance_km: 15, min_stars: 4 });
    expect((await recalc({ travellers: 1, hotel_filters: { min_stars: 0, rating_min: null } })).statusCode).toBe(200);
    expect(buildCalls()[1]!.body.hotel_filters).toEqual({ rating_min: 9, max_distance_km: 1, min_stars: null });
    setHotel(DEFAULT);
    await recalc({ travellers: 1, hotel_filters: { rating_min: 0 } }); // «любая» — не то же, что по умолчанию
    expect(buildCalls()[2]!.body.hotel_filters).toEqual({ rating_min: 0, max_distance_km: null, min_stars: null });
    await recalc({ travellers: 1, hotel_filters: null });
    expect(buildCalls()[3]!.body).not.toHaveProperty("hotel_filters");
  });

  it.each([{ rating_min: 6.5 }, { rating_min: 9.5 }, { max_distance_km: 2 }, { max_distance_km: 20 }, { min_stars: 2 }, { radius_m: 1000 }])(
    "invalid recalculate hotel_filters %j → 422 VALIDATION_ERROR, offers not called",
    async (bad) => {
      const r = await recalc({ travellers: 1, hotel_filters: bad });
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe("VALIDATION_ERROR");
      expect(buildCalls()).toHaveLength(0);
    },
  );

  it("offers without hotel_filters (rollout) → one retry without the field, the budget stays", async () => {
    setHotel({ rating_min: 9, max_distance_km: 1, min_stars: null });
    h.fake.prefs.get(s.userId)!.budget = { currency: "USD", preset: "1000_2000", min: 1000, max: 2000, custom_amount: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.fake.offersBuildGuard = (body: any) =>
      "hotel_filters" in body
        ? domainError(422, "VALIDATION_ERROR", { errors: [{ loc: ["body", "hotel_filters"], msg: "Extra inputs are not permitted", type: "extra_forbidden" }] })
        : null;
    const res = await send("GET", `/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(200);
    const calls = buildCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).not.toHaveProperty("hotel_filters");
    expect(calls[1]!.body.budget).toEqual({ min: "1000.00", max: "2000.00" });
    // ревью 6.3: расчёт без условий отеля — не молча: Mini App покажет «Условия отеля применятся чуть позже»
    expect((res.json() as OfferSetView).notes).toContain("HOTEL_PREFS_PENDING");
    // без условий отеля в профиле повтора нет и пометки тоже
    setHotel(DEFAULT);
    const plain = await send("GET", `/v1/events/${eventId}/offers?travellers=2`);
    expect((plain.json() as OfferSetView).notes).not.toContain("HOTEL_PREFS_PENDING");
  });

  it("HOTEL_PREFS_NONE and the 6.3 hotel_search fields pass through; old offers → defaults", async () => {
    h.fake.offersBuild = (set: OfferSetView) => {
      const out = structuredClone(set);
      out.hotel_search = { radius_m: 15000, rating_min: "8.5", base_radius_m: 1000, base_rating_min: "9.0", widened: true, found: 3, min_stars: null, base_min_stars: 4, from_prefs: true };
      out.notes = ["HOTEL_SEARCH_WIDENED", "HOTEL_PREFS_NONE"];
      return out;
    };
    const res = await send("GET", `/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as OfferSetView;
    expect(Value.Check(OfferSetViewSchema, body)).toBe(true);
    expect(body.notes).toEqual(["HOTEL_SEARCH_WIDENED", "HOTEL_PREFS_NONE"]);
    expect(body.hotel_search).toMatchObject({ base_radius_m: 1000, base_rating_min: "9.0", base_min_stars: 4, from_prefs: true });

    const old = structuredClone(offerSetFixture(eventId)) as OfferSetView;
    for (const k of ["min_stars", "base_min_stars", "from_prefs"] as const) delete (old.hotel_search as Partial<NonNullable<OfferSetView["hotel_search"]>>)[k];
    const legacy = new Set<string>();
    const out = sanitizeOfferSet(old, eventId, legacy);
    expect(out.hotel_search).toMatchObject({ min_stars: null, base_min_stars: null, from_prefs: false });
    expect([...legacy].sort()).toEqual(["hotel_search.base_min_stars", "hotel_search.from_prefs", "hotel_search.min_stars"]);
  });

  it("hotelFiltersOf / tripHotelFiltersOf / rejectedNewFields / withoutFields51", () => {
    expect(hotelFiltersOf(DEFAULT, null)).toBeNull();
    expect(hotelFiltersOf(undefined, null)).toBeNull();
    expect(hotelFiltersOf({ rating_min: "9", max_distance_km: 1.5, min_stars: -1 }, null)).toBeNull(); // мусор профиля — по умолчанию
    expect(hotelFiltersOf({ rating_min: 8.5, max_distance_km: 3, min_stars: 0 }, null)).toEqual({ rating_min: 8.5, max_distance_km: 3, min_stars: null });
    expect(hotelFiltersOf({ min_stars: 4 }, { min_stars: 0 })).toBeNull();
    expect(tripHotelFiltersOf({ rating_min: null, max_distance_km: undefined })).toBeNull();
    expect(tripHotelFiltersOf({ rating_min: 7.5, min_stars: 3 })).toEqual({ rating_min: 7.5, min_stars: 3 });
    const e = (errors: unknown[]) => new AppError(422, "VALIDATION_ERROR", "m", { errors });
    expect([...rejectedNewFields(e([{ loc: ["body", "hotel_filters", "rating_min"] }]))!]).toEqual(["hotel_filters"]);
    const body: BuildRequest = {
      event_id: "e",
      travellers: 1,
      departures: [],
      flight_prefs: { direct: false, connecting: true, alternative_departure: false },
      overrides: { departure_iata: null, direct_only: false, near_venue: false, extra_nights: 0 },
      hotel_filters: { rating_min: 9, max_distance_km: 1, min_stars: null },
      lang: "ru",
    };
    const { hotel_filters: _drop, ...rest } = body;
    expect(withoutFields51(body, new Set(["hotel_filters"]))).toEqual(rest);
    expect(withoutFields51(body, new Set(["budget"]))).toEqual(body);
  });
});

describe("6.3: watch rechecks with the same hotel settings", () => {
  const idem = () => ({ "idempotency-key": crypto.randomUUID() });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createCalls = () => h.fake.callsTo("watch", "POST", "/internal/v1/watches") as Array<{ body: any }>;

  it("offer_params.hotel_filters = profile + the last trip's settings; none → no field", async () => {
    await h.close();
    h = await makeHarness(SPRINT6_ENV);
    s = await login(h);
    h.fake.catalog.push(catalogEvent({ event_id: eventId }));
    await send("PUT", "/v1/profile/departures", { airports: ["TAS"] });
    const a = await send("POST", "/v1/watches", { event_id: eventId }, idem());
    expect(a.statusCode).toBe(201);
    expect(createCalls()[0]!.body.offer_params).not.toHaveProperty("hotel_filters");

    const e2 = catalogEvent();
    h.fake.catalog.push(e2);
    setHotel({ rating_min: 9, max_distance_km: 1, min_stars: null });
    const rc = await send("POST", `/v1/events/${e2.event_id}/offers/recalculate`, { travellers: 2, hotel_filters: { max_distance_km: 15 } });
    expect(rc.statusCode).toBe(200);
    const b = await send("POST", "/v1/watches", { event_id: e2.event_id }, idem());
    expect(b.statusCode).toBe(201);
    expect(createCalls()[1]!.body.offer_params).toMatchObject({ travellers: 2, hotel_filters: { rating_min: 9, max_distance_km: 15, min_stars: null } });
  });

  it("an older watch rejects offer_params.hotel_filters (422) → one retry without the field, the watch is created", async () => {
    await h.close();
    h = await makeHarness(SPRINT6_ENV);
    s = await login(h);
    h.fake.catalog.push(catalogEvent({ event_id: eventId }));
    await send("PUT", "/v1/profile/departures", { airports: ["TAS"] });
    setHotel({ rating_min: 9, max_distance_km: 1, min_stars: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.fake.watchCreateGuard = (body: any) =>
      "hotel_filters" in body.offer_params
        ? domainError(422, "VALIDATION_ERROR", { errors: [{ loc: ["body", "offer_params", "hotel_filters"], msg: "Extra inputs are not permitted", type: "extra_forbidden" }] })
        : null;
    const res = await send("POST", "/v1/watches", { event_id: eventId }, idem());
    expect(res.statusCode).toBe(201);
    const calls = createCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.offer_params.hotel_filters).toEqual({ rating_min: 9, max_distance_km: 1, min_stars: null });
    expect(calls[1]!.body.offer_params).not.toHaveProperty("hotel_filters");
    // другая ошибка валидации — без повтора
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.fake.watchCreateGuard = () => domainError(422, "VALIDATION_ERROR", { errors: [{ loc: ["body", "offer_params", "travellers"], msg: "x", type: "x" }] });
    const e2 = catalogEvent();
    h.fake.catalog.push(e2);
    expect((await send("POST", "/v1/watches", { event_id: e2.event_id }, idem())).statusCode).toBe(422);
    expect(createCalls()).toHaveLength(3);
  });
});
