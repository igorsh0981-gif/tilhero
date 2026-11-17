/**
 * Спринт 5: предложения поездки (INTERNAL_API §4) — GET /v1/events/{id}/offers, POST …/offers/recalculate,
 * лимит 20/мин, недоверенный ответ offers, offer_id в обращении в поддержку.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import type { OfferSetView } from "@tilhero/contracts/bff";
import { ConfigError } from "../src/config.js";
import { project, sanitizeOfferSet, scrubStrings } from "../src/offers.js";
import { contextFromSnapshot } from "../src/routes/support.js";
import { OfferSetViewSchema } from "../src/schemas.js";
import { ResponseTooLarge, limitedFetch } from "../src/upstream.js";
import {
  TG_USER,
  bearer,
  catalogEvent,
  closeRedis,
  domainError,
  json,
  login,
  makeHarness,
  offerSetFixture,
  testConfig,
  type Harness,
  type LoggedIn,
} from "./helpers.js";

let h: Harness;
let s: LoggedIn;
let eventId: string;

async function setup(env: Record<string, string> = {}) {
  h = await makeHarness(env);
  s = await login(h);
  const e = catalogEvent();
  h.fake.catalog.push(e);
  eventId = e.event_id;
  await setDepartures(["TAS"]);
}

afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const get = (url: string, headers: Record<string, string> = bearer(s.access)) => h.app.inject({ url, headers });
const recalc = (body: unknown, id = eventId, headers: Record<string, string> = bearer(s.access)) =>
  h.app.inject({ method: "POST", url: `/v1/events/${id}/offers/recalculate`, headers, payload: body as object });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildCalls = () => h.fake.callsTo("offers", "POST", "/internal/v1/offers:build") as Array<{ subject?: string; body: any }>;

async function setDepartures(airports: string[]) {
  const r = await h.app.inject({ method: "PUT", url: "/v1/profile/departures", headers: bearer(s.access), payload: { airports } });
  expect(r.statusCode).toBe(200);
}

/** Ответ offers с подменой (недоверенные данные). */
function tamper(fn: (set: any) => unknown) { // eslint-disable-line @typescript-eslint/no-explicit-any
  h.fake.offersBuild = (set) => fn(structuredClone(set));
}

describe("GET /v1/events/{eventId}/offers", () => {
  beforeEach(() => setup());

  it("happy path: departures/flight_prefs from preferences, sub = user_id, neutral overrides, OfferSetView by contract", async () => {
    await setDepartures(["TAS", "SKD"]);
    const res = await get(`/v1/events/${eventId}/offers?travellers=2`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as OfferSetView;
    expect(Value.Check(OfferSetViewSchema, body)).toBe(true);
    expect(body).toEqual(offerSetFixture(eventId, { travellers: 2 }) && body); // форма
    expect(body.event_id).toBe(eventId);
    expect(body.travellers).toBe(2);
    expect(body.tiers?.comfort.flight).toMatchObject({ status: "ok", origin: "TAS", deeplink: expect.stringMatching(/^https:\/\/www\.aviasales\.com\//) });

    const [call] = buildCalls();
    expect(call!.subject).toBe(s.userId);
    expect(call!.body).toEqual({
      event_id: eventId,
      travellers: 2,
      departures: [
        { airport_iata: "TAS", city: "Tashkent", country_code: "UZ" },
        { airport_iata: "SKD", city: "Samarkand", country_code: "UZ" },
      ],
      flight_prefs: { direct: true, connecting: true, alternative_departure: true },
      overrides: { departure_iata: null, direct_only: false, near_venue: false, extra_nights: 0 },
      lang: "ru",
    });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("travellers defaults to 1; no departures → offers gets [] and the set says departure null", async () => {
    await setDepartures([]);
    tamper(() => offerSetFixture(eventId, { travellers: 1, departure: null }));
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(200);
    expect(buildCalls()[0]!.body).toMatchObject({ travellers: 1, departures: [] });
    expect(res.json().departure).toBeNull();
    expect(res.json().tiers.economy.flight).toEqual({ status: "unavailable", reason: "NO_DEPARTURE" });
  });

  it("incomplete departures from the profile are not sent (offers DepartureIn: IATA, city 1..100, ISO-2)", async () => {
    const p = h.fake.prefs.get(s.userId)!;
    p.departures = [
      { airport_iata: "TAS", city: "Tashkent", country_code: "UZ" },
      { airport_iata: "SKD", city: "", country_code: "UZ" },
      { airport_iata: "ala", city: "Almaty", country_code: "KZ" },
      { airport_iata: "NQZ", city: "Astana", country_code: "" },
      { airport_iata: "FRU", city: "Б".repeat(150), country_code: "KG" },
    ];
    expect((await get(`/v1/events/${eventId}/offers`)).statusCode).toBe(200);
    const sent = buildCalls()[0]!.body.departures as Array<{ airport_iata: string; city: string }>;
    expect(sent.map((d) => d.airport_iata)).toEqual(["TAS", "FRU"]);
    expect(sent[1]!.city).toHaveLength(100);
  });

  it("uppercase UUID is normalised; lang follows the user's locale", async () => {
    await h.app.inject({ method: "PATCH", url: "/v1/profile/settings", headers: bearer(s.access), payload: { locale: "en" } });
    const res = await get(`/v1/events/${eventId.toUpperCase()}/offers`);
    expect(res.statusCode).toBe(200);
    expect(buildCalls()[0]!.body).toMatchObject({ event_id: eventId, lang: "en" });
  });

  it.each(["0", "7", "abc", "1.5", "-1"])("travellers=%s → 422 VALIDATION_ERROR, offers not called", async (t) => {
    const res = await get(`/v1/events/${eventId}/offers?travellers=${t}`);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { in: "querystring", field: "travellers" } });
    expect(buildCalls()).toHaveLength(0);
  });

  it("unknown query parameter → 422", async () => {
    const res = await get(`/v1/events/${eventId}/offers?user_id=${s.userId}`);
    expect(res.statusCode).toBe(422);
  });

  it("non-UUID eventId → 404 EVENT_NOT_FOUND (как у детали), offers not called", async () => {
    const res = await get("/v1/events/not-a-uuid/offers");
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("EVENT_NOT_FOUND");
    expect(buildCalls()).toHaveLength(0);
  });

  it("offers 404 → 404 EVENT_NOT_FOUND", async () => {
    const res = await get("/v1/events/0b7c3a52-1d2e-4f60-8a9b-ffffffffffff/offers");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "EVENT_NOT_FOUND", message: "Событие не найдено" });
  });

  it("401 without token / with garbage token; offers not called", async () => {
    expect((await get(`/v1/events/${eventId}/offers`, {})).statusCode).toBe(401);
    const bad = await get(`/v1/events/${eventId}/offers`, { authorization: "Bearer a.b.c" });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe("TOKEN_INVALID");
    expect(buildCalls()).toHaveLength(0);
  });

  it("423 PIN_REQUIRED for a session awaiting PIN", async () => {
    h.fake.enablePin(s.userId, "1357");
    const locked = await login(h);
    const res = await get(`/v1/events/${eventId}/offers`, bearer(locked.access));
    expect(res.statusCode).toBe(423);
  });
});

describe("POST /v1/events/{eventId}/offers/recalculate", () => {
  beforeEach(() => setup());

  it("forwards overrides; omitted fields are neutral", async () => {
    await setDepartures(["TAS"]);
    const res = await recalc({ travellers: 6, departure_iata: "ALA", direct_only: true, near_venue: true, extra_nights: 3 });
    expect(res.statusCode).toBe(200);
    expect(res.json().departure).toEqual({ iata: "ALA", city: "Ташкент", chosen_by: "user" });
    expect(buildCalls()[0]!.body).toMatchObject({
      travellers: 6,
      overrides: { departure_iata: "ALA", direct_only: true, near_venue: true, extra_nights: 3 },
    });

    await recalc({ travellers: 1, departure_iata: null });
    expect(buildCalls()[1]!.body.overrides).toEqual({ departure_iata: null, direct_only: false, near_venue: false, extra_nights: 0 });
  });

  it.each([
    [{}, "travellers"],
    [{ travellers: 0 }, "travellers"],
    [{ travellers: 7 }, "travellers"],
    [{ travellers: "2" }, "travellers"],
    [{ travellers: 2, departure_iata: "tas" }, "departure_iata"],
    [{ travellers: 2, departure_iata: "TASH" }, "departure_iata"],
    [{ travellers: 2, extra_nights: 4 }, "extra_nights"],
    [{ travellers: 2, extra_nights: -1 }, "extra_nights"],
    [{ travellers: 2, direct_only: "yes" }, "direct_only"],
    [{ travellers: 2, user_id: "00000000-0000-0000-0000-000000000000" }, "user_id"],
  ])("invalid body %j → 422 VALIDATION_ERROR (%s)", async (body, field) => {
    const res = await recalc(body);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { in: "body", field } });
    expect(buildCalls()).toHaveLength(0);
  });

  it("offers 422 OFFER_DEPARTURE_INVALID passes through (без текста домена)", async () => {
    const res = await recalc({ travellers: 2, departure_iata: "IST" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "OFFER_DEPARTURE_INVALID", details: {} });
    expect(res.body).not.toContain("domain says");
  });

  it("other offers 422 → VALIDATION_ERROR without domain details", async () => {
    h.fake.override("offers", "POST", "/internal/v1/offers:build", () => domainError(422, "SOMETHING_INTERNAL", { secret: "x" }));
    const res = await recalc({ travellers: 2 });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(res.body).not.toContain("SOMETHING_INTERNAL");
    expect(res.body).not.toContain("secret");
  });

  it("non-UUID eventId → 404 even with a valid body", async () => {
    const res = await recalc({ travellers: 2 }, "123");
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("EVENT_NOT_FOUND");
  });

  it("401 without token", async () => {
    expect((await recalc({ travellers: 2 }, eventId, {})).statusCode).toBe(401);
  });
});

describe("rate limit 20 calculations/min per user", () => {
  beforeEach(() => setup());

  it("21st calculation (GET + recalculate share the bucket) → 429 RATE_LIMITED {retry_after} + Retry-After; other user unaffected", async () => {
    for (let i = 0; i < 20; i++) {
      const r = i % 2 ? await recalc({ travellers: 1 }) : await get(`/v1/events/${eventId}/offers`);
      expect(r.statusCode, `call ${i}`).toBe(200);
    }
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.details.retry_after).toBeGreaterThanOrEqual(1);
    expect(body.details.retry_after).toBeLessThanOrEqual(60);
    expect(res.headers["retry-after"]).toBe(String(body.details.retry_after));
    expect(buildCalls()).toHaveLength(20);

    // событие при этом открывается (деталь — отдельный лимит)
    expect((await get(`/v1/events/${eventId}`)).statusCode).toBe(200);

    const other = await login(h, { ...TG_USER, id: 900777, username: "other" });
    expect((await get(`/v1/events/${eventId}/offers`, bearer(other.access))).statusCode).toBe(200);
  });

  it("RATE_LIMIT_OFFERS_PER_MIN is configurable", async () => {
    await h.close();
    await setup({ RATE_LIMIT_OFFERS_PER_MIN: "2" });
    expect((await get(`/v1/events/${eventId}/offers`)).statusCode).toBe(200);
    expect((await recalc({ travellers: 2 })).statusCode).toBe(200);
    expect((await recalc({ travellers: 2 })).statusCode).toBe(429);
  });

  it("offers' own 429 → 429 RATE_LIMITED with sane retry_after", async () => {
    h.fake.override("offers", "POST", "/internal/v1/offers:build", () => domainError(429, "PROVIDER_RATE_LIMITED", { retry_after: 30 }));
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: "RATE_LIMITED", details: { retry_after: 30 } });
    h.fake.override("offers", "POST", "/internal/v1/offers:build", () => domainError(429, "X", { retry_after: "soon" }));
    expect((await get(`/v1/events/${eventId}/offers`)).json().details.retry_after).toBe(60);
  });
});

describe("offers unavailable → 503 OFFERS_UNAVAILABLE", () => {
  it("network failure; 5xx; event detail still works", async () => {
    await setup();
    h.fake.down.add("offers");
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "OFFERS_UNAVAILABLE", details: { service: "offers" } });
    expect((await get(`/v1/events/${eventId}`)).statusCode).toBe(200);
    h.fake.down.delete("offers");
    h.fake.override("offers", "POST", "/internal/v1/offers:build", () => domainError(503, "EVENTS_UNAVAILABLE"));
    expect((await recalc({ travellers: 2 })).json().code).toBe("OFFERS_UNAVAILABLE");
    h.fake.override("offers", "POST", "/internal/v1/offers:build", () => new Response("boom", { status: 500 }));
    expect((await recalc({ travellers: 2 })).json().code).toBe("OFFERS_UNAVAILABLE");
    expect(h.logs.text).toContain("offers unavailable");
  });

  it("timeout (OFFERS_TIMEOUT_MS) → 503, build is not retried", async () => {
    await setup({ OFFERS_TIMEOUT_MS: "1000" });
    h.fake.delays.set("offers", 1500);
    const t0 = performance.now();
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("OFFERS_UNAVAILABLE");
    expect(performance.now() - t0).toBeLessThan(1450);
  });

  it("internal auth refusal (CALLER_NOT_ALLOWED / 401) is not leaked as 401/403", async () => {
    await setup();
    h.fake.override("offers", "POST", "/internal/v1/offers:build", () => domainError(403, "CALLER_NOT_ALLOWED"));
    const r1 = await get(`/v1/events/${eventId}/offers`);
    expect([r1.statusCode, r1.json().code]).toEqual([503, "OFFERS_UNAVAILABLE"]);
    h.fake.override("offers", "POST", "/internal/v1/offers:build", () => domainError(401, "SUBJECT_REQUIRED"));
    const r2 = await get(`/v1/events/${eventId}/offers`);
    expect([r2.statusCode, r2.json().code]).toEqual([503, "OFFERS_UNAVAILABLE"]);
  });

  it("OFFERS_URL not set → 503 without any call; preferences down → 503", async () => {
    await setup({ OFFERS_URL: "" });
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("OFFERS_UNAVAILABLE");
    expect((await recalc({ travellers: 2 })).json().code).toBe("OFFERS_UNAVAILABLE");
    expect(h.fake.callsTo("offers")).toHaveLength(0);
    await h.close();

    await setup();
    h.fake.down.add("preferences");
    const r = await get(`/v1/events/${eventId}/offers`);
    expect([r.statusCode, r.json().code]).toEqual([503, "OFFERS_UNAVAILABLE"]);
    expect(buildCalls()).toHaveLength(0);
  });

  it("identity down → still builds with lang ru", async () => {
    await setup();
    h.fake.down.add("identity");
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(200);
    expect(buildCalls()[0]!.body.lang).toBe("ru");
  });
});

describe("untrusted offers response", () => {
  beforeEach(() => setup());

  const expect503 = async () => {
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("OFFERS_UNAVAILABLE");
    return res;
  };

  it.each([
    ["javascript: deeplink", (x: any) => void (x.tiers.comfort.flight.deeplink = "javascript:alert(1)")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["http deeplink", (x: any) => void (x.tiers.economy.hotel.deeplink = "http://book.example/h")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["userinfo in url", (x: any) => void (x.tiers.economy.ticket.deeplink = "https://user:pw@evil.example/")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["https with spaces", (x: any) => void (x.tiers.economy.ticket.deeplink = "https://a.example/x y")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["map link data:", (x: any) => void (x.trip.destination.venue.map.osm = "data:text/html,<script>")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["deeplink with control char", (x: any) => void (x.tiers.premium.flight.deeplink = "https://www.aviasales.com/a\u0000b")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["huge hotel name", (x: any) => void (x.tiers.comfort.hotel.name = "A".repeat(100_000))], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["money as number", (x: any) => void (x.tiers.comfort.totals.total = 844)], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["money with 3 decimals", (x: any) => void (x.tiers.comfort.totals.total = "1.005")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["unknown trip.kind", (x: any) => void (x.trip.kind = "teleport")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["unknown unavailable reason", (x: any) => void (x.tiers.comfort.hotel = { status: "unavailable", reason: "<b>x</b>" })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["offer_id not uuid", (x: any) => void (x.tiers.comfort.offer_id = "../../admin")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["missing tier", (x: any) => void delete x.tiers.premium], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["other event_id", (x: any) => void (x.event_id = "0b7c3a52-1d2e-4f60-8a9b-eeeeeeeeeeee")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["travellers 0", (x: any) => void (x.travellers = 0)], // eslint-disable-line @typescript-eslint/no-explicit-any
  ])("%s → 503, value not logged", async (_name, mutate) => {
    tamper((x) => {
      mutate(x);
      return x;
    });
    await expect503();
    expect(h.logs.text).toContain("offers bad response");
    expect(h.logs.text).not.toContain("javascript:");
    expect(h.logs.text).not.toContain("evil.example");
    expect(h.logs.text).not.toContain("AAAAAAAAAA");
  });

  it("flight without airline code (gateway/offers: airline null) passes; a bad airline code → 503", async () => {
    tamper((x) => {
      x.tiers.economy.flight.airline = null;
      return x;
    });
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(200);
    expect(res.json().tiers.economy.flight.airline).toBeNull();
    expect(Value.Check(OfferSetViewSchema, res.json())).toBe(true);
    tamper((x) => {
      x.tiers.economy.flight.airline = "<b>";
      return x;
    });
    await expect503();
  });

  it("not JSON / array / empty body → 503", async () => {
    h.fake.override("offers", "POST", "/internal/v1/offers:build", () => new Response("<html>", { status: 200 }));
    await expect503();
    h.fake.override("offers", "POST", "/internal/v1/offers:build", () => json(200, []));
    await expect503();
    h.fake.override("offers", "POST", "/internal/v1/offers:build", () => new Response("", { status: 200 }));
    await expect503();
  });

  it("response larger than OFFERS_MAX_RESPONSE_BYTES → 503", async () => {
    await h.close();
    await setup({ OFFERS_MAX_RESPONSE_BYTES: "16384" });
    tamper((x) => ({ ...x, padding: "x".repeat(20_000) }));
    await expect503();
  });

  it("extra fields are dropped at every level; optional links degrade to null; broken list items are dropped", async () => {
    tamper((x) => {
      x.user_id = "leak";
      x.debug = { provider_raw: "TOKEN" };
      x.trip.internal = 1;
      x.trip.destination.venue.map.raw = "x";
      x.tiers.comfort.params_hash = "abc";
      x.tiers.comfort.flight.raw = { marker: "12345", token: "SECRET" };
      x.tiers.comfort.hotel.photo_url = "javascript:alert(1)";
      x.tiers.economy.hotel.photo_url = "http://static.cupid.travel/1.jpg";
      x.tiers.economy.totals.internal = true;
      x.hotels_nearby[0].supplier_cost = "1.00";
      x.hotels_nearby.push({ ...x.hotels_nearby[0], hotel_id: "bad1", deeplink: "javascript:void(0)" });
      x.hotels_nearby.push({ ...x.hotels_nearby[0], hotel_id: "bad2", name: "N".repeat(5000) });
      x.hotels_nearby.push({ ...x.hotels_nearby[0], hotel_id: "pic", photo_url: "javascript:alert(1)" });
      x.poi[0].website = "http://example.com";
      x.poi[0].tags = { "addr:street": "x" };
      x.poi.push({ ...x.poi[0], osm_id: 2, url: "javascript:alert(1)" });
      x.notes = ["LOCATION_APPROX", "NEW_FUTURE_NOTE", "LOCATION_APPROX", 5];
      return x;
    });
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Value.Check(OfferSetViewSchema, body)).toBe(true);
    for (const leak of ["user_id", "debug", "TOKEN", "internal", "params_hash", "SECRET", "marker\":", "supplier_cost", "tags", "javascript:", "raw", "NEW_FUTURE_NOTE"]) {
      expect(res.body, leak).not.toContain(leak);
    }
    expect(body.tiers.comfort.hotel.photo_url).toBeNull();
    expect(body.tiers.economy.hotel.photo_url).toBeNull();
    expect(body.hotels_nearby.map((x: { hotel_id: string }) => x.hotel_id)).toEqual(["lp2", "pic"]);
    expect(body.hotels_nearby[1].photo_url).toBeNull();
    expect(body.poi).toHaveLength(1);
    expect(body.poi[0].website).toBeNull();
    expect(body.notes).toEqual(["LOCATION_APPROX"]);
  });

  it("control and bidi characters in text are stripped; lists are capped (8 hotels, 10 poi)", async () => {
    tamper((x) => {
      x.tiers.comfort.hotel.name = "Rixos\u202e\u0007 Almaty\u200b";
      x.hotels_nearby = Array.from({ length: 12 }, (_, i) => ({ ...x.hotels_nearby[0], hotel_id: `h${i}` }));
      x.poi = Array.from({ length: 15 }, (_, i) => ({ ...x.poi[0], osm_id: i }));
      return x;
    });
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tiers.comfort.hotel.name).toBe("Rixos Almaty");
    expect(body.hotels_nearby).toHaveLength(8);
    expect(body.poi).toHaveLength(10);
  });

  it("not_available set (tiers null, empty lists) is valid", async () => {
    tamper((x) => ({
      ...x,
      trip: { kind: "not_available", reason: "EVENT_CANCELLED", destination: null, out_date: null, back_date: null, nights: null },
      tiers: null,
      departure: null,
      rooms: 0,
      hotels_nearby: [],
      poi: [],
    }));
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ trip: { kind: "not_available", reason: "EVENT_CANCELLED" }, tiers: null });
  });
});

describe("support ticket with context.offer_id", () => {
  beforeEach(() => setup());

  let n = 0;
  const createTicket = (payload: object, access = s.access) =>
    h.app.inject({
      method: "POST",
      url: "/v1/support/tickets",
      headers: { ...bearer(access), "idempotency-key": `6f0c2a1e-1b2c-4d3e-8f90-${String(++n).padStart(12, "0")}` },
      payload,
    });
  const supportBody = () => h.fake.callsTo("support", "POST", "/internal/v1/me/tickets").at(-1)!.body as { context: Record<string, unknown> };

  async function myOffers(access = s.access): Promise<OfferSetView> {
    const r = await get(`/v1/events/${eventId}/offers?travellers=2`, bearer(access));
    expect(r.statusCode).toBe(200);
    return r.json();
  }

  const CLIENT_CTX = {
    client_version: "telegram-miniapp-2.0",
    deeplink: "https://evil.example/phish",
    price_snapshot: { amount: "1.00", currency: "USD", fetched_at: "2020-01-01T00:00:00Z" },
    event_id: "0b7c3a52-1d2e-4f60-8a9b-dddddddddddd",
  };

  /** Ожидаемые поля из снимка (единое правило с Mini App): цена — итог пакета, время — created_at снимка. */
  const fromSnap = (set: OfferSetView, tier: "economy" | "comfort" | "premium", provider: string, deeplink: string) => ({
    offer_id: set.tiers![tier].offer_id,
    event_id: eventId,
    provider_id: provider,
    deeplink,
    price_snapshot: { amount: set.tiers![tier].totals.total, currency: "USD", fetched_at: set.generated_at },
  });
  const linkOf = (c: unknown) => (c as { deeplink: string }).deeplink;

  it("own snapshot, provider_id of the flight: price = package total (what the user saw), link of the flight", async () => {
    const set = await myOffers();
    const offer = set.tiers!.comfort;
    const res = await createTicket({ category: "FLIGHT", subject: "Цена другая", message: "На сайте дороже", context: { ...CLIENT_CTX, offer_id: offer.offer_id.toUpperCase(), provider_id: "aviasales" } });
    expect(res.statusCode).toBe(201);
    const snapCall = h.fake.callsTo("offers", "GET").at(-1)!;
    expect(snapCall.subject).toBe(s.userId);
    expect(snapCall.path).toBe(`/internal/v1/offers/${offer.offer_id}`);
    expect(supportBody().context).toEqual({ client_version: "telegram-miniapp-2.0", ...fromSnap(set, "comfort", "aviasales", linkOf(offer.flight)) });
    expect(offer.totals.total).not.toBe((offer.flight as { total: string }).total);
    expect(res.json().context.offer_id).toBe(offer.offer_id);
    expect(res.body).not.toContain("evil.example");
  });

  it("provider_id of the hotel → hotel link, price still the package total", async () => {
    const set = await myOffers();
    const offer = set.tiers!.premium;
    await createTicket({ category: "FLIGHT", subject: "Отель", message: "Нет мест", context: { client_version: "x", offer_id: offer.offer_id, provider_id: "liteapi" } });
    expect(supportBody().context).toEqual({ client_version: "x", ...fromSnap(set, "premium", "liteapi", linkOf(offer.hotel)) });
  });

  it("unknown or absent provider_id → main component (flight → hotel → ticket)", async () => {
    const set = await myOffers();
    const offer = set.tiers!.economy;
    await createTicket({ category: "HOTEL", subject: "Сумма", message: "Не сходится", context: { ...CLIENT_CTX, offer_id: offer.offer_id, provider_id: "unknown" } });
    expect(supportBody().context).toEqual({ client_version: "telegram-miniapp-2.0", ...fromSnap(set, "economy", "aviasales", linkOf(offer.flight)) });
    await createTicket({ category: "PRICE", subject: "Сумма", message: "Не сходится", context: { client_version: "x", offer_id: offer.offer_id } });
    expect(supportBody().context).toEqual({ client_version: "x", ...fromSnap(set, "economy", "aviasales", linkOf(offer.flight)) });
  });

  it("provider_id of an unavailable component (no departure → flight unavailable) → main ok component (hotel)", async () => {
    await setDepartures([]);
    const set = await myOffers();
    const offer = set.tiers!.comfort;
    expect(offer.flight).toEqual({ status: "unavailable", reason: "NO_DEPARTURE" });
    await createTicket({ category: "FLIGHT", subject: "Нет перелёта", message: "…", context: { client_version: "x", offer_id: offer.offer_id, provider_id: "aviasales" } });
    expect(supportBody().context).toEqual({ client_version: "x", ...fromSnap(set, "comfort", "liteapi", linkOf(offer.hotel)) });
  });

  it("snapshot check is remembered only after support answered or failed with 5xx; support 4xx → not remembered", async () => {
    const offer = (await myOffers()).tiers!.comfort;
    const payload = { category: "FLIGHT", subject: "Повтор", message: "…", context: { client_version: "x", offer_id: offer.offer_id } };
    const send = (key: string) => h.app.inject({ method: "POST", url: "/v1/support/tickets", headers: { ...bearer(s.access), "idempotency-key": key }, payload });

    // 4xx support → не запоминаем: повтор после сбоя offers честно проверяет заново (offer_id убран)
    const k4 = "7a1b2c3d-4e5f-4a6b-8c7d-000000000004";
    h.fake.override("support", "POST", "/internal/v1/me/tickets", () => domainError(409, "SUPPORT_TEMPORARY_CONFLICT"));
    expect((await send(k4)).statusCode).toBe(409);
    expect(supportBody().context.offer_id).toBe(offer.offer_id);
    const calls4 = h.fake.callsTo("offers", "GET").length;
    h.fake.down.add("offers");
    expect((await send(k4)).statusCode).toBe(409);
    expect(h.fake.callsTo("offers", "GET").length).toBe(calls4); // offers «лежит» — вызов не дошёл, но проверка была заново
    expect(supportBody().context.offer_id).toBeUndefined();
    h.fake.down.delete("offers");

    // 5xx support (исход неизвестен) → запоминаем: повтор после сбоя offers шлёт то же тело с offer_id
    const k5 = "7a1b2c3d-4e5f-4a6b-8c7d-000000000005";
    h.fake.override("support", "POST", "/internal/v1/me/tickets", () => domainError(503, "DB_DOWN"));
    expect((await send(k5)).statusCode).toBe(503);
    const first = supportBody();
    expect(first.context.offer_id).toBe(offer.offer_id);
    h.fake.down.add("offers");
    expect((await send(k5)).statusCode).toBe(503);
    expect(supportBody()).toEqual(first);

    // сеть до support (исход неизвестен) — тоже запоминаем: повтор без offers всё равно несёт offer_id
    const kn = "7a1b2c3d-4e5f-4a6b-8c7d-000000000006";
    h.fake.down.delete("offers");
    h.fake.down.add("support");
    expect((await send(kn)).statusCode).toBe(503);
    h.fake.down.delete("support");
    h.fake.down.add("offers");
    expect((await send(kn)).statusCode).toBe(503); // support всё ещё отвечает 503 (override), тело — записано
    expect(supportBody().context.offer_id).toBe(offer.offer_id);
  });

  it("retry with the same Idempotency-Key reuses the snapshot check even if offers went down in between", async () => {
    const offer = (await myOffers()).tiers!.comfort;
    const key = "7a1b2c3d-4e5f-4a6b-8c7d-000000000001";
    const send = () =>
      h.app.inject({
        method: "POST",
        url: "/v1/support/tickets",
        headers: { ...bearer(s.access), "idempotency-key": key },
        payload: { category: "FLIGHT", subject: "Повтор", message: "…", context: { client_version: "x", offer_id: offer.offer_id, provider_id: "aviasales" } },
      });
    expect((await send()).statusCode).toBe(201);
    const first = supportBody();
    expect(first.context.offer_id).toBe(offer.offer_id);
    const snapCalls = h.fake.callsTo("offers", "GET").length;
    h.fake.down.add("offers");
    const again = await send();
    expect(again.statusCode).toBe(201);
    expect(supportBody()).toEqual(first);
    expect(h.fake.callsTo("offers", "GET")).toHaveLength(snapCalls);

    // и наоборот: первая попытка без offers — повтор после восстановления тоже без offer_id (тело то же)
    const key2 = "7a1b2c3d-4e5f-4a6b-8c7d-000000000002";
    const send2 = () =>
      h.app.inject({
        method: "POST",
        url: "/v1/support/tickets",
        headers: { ...bearer(s.access), "idempotency-key": key2 },
        payload: { category: "FLIGHT", subject: "Повтор", message: "…", context: { client_version: "x", offer_id: offer.offer_id } },
      });
    expect((await send2()).statusCode).toBe(201);
    const dropped = supportBody();
    expect(dropped.context.offer_id).toBeUndefined();
    h.fake.down.delete("offers");
    expect((await send2()).statusCode).toBe(201);
    expect(supportBody()).toEqual(dropped);
  });

  it("someone else's offer_id → removed together with client price/link; ticket is created", async () => {
    const other = await login(h, { ...TG_USER, id: 900555, username: "other" });
    const foreign = (await myOffers(other.access)).tiers!.economy.offer_id;
    const res = await createTicket({ category: "FLIGHT", subject: "Чужое", message: "…", context: { ...CLIENT_CTX, offer_id: foreign, provider_id: "aviasales" } });
    expect(res.statusCode).toBe(201);
    const ctx = supportBody().context;
    expect(ctx.offer_id).toBeUndefined();
    expect(ctx.price_snapshot).toBeUndefined();
    expect(ctx.deeplink).toBeUndefined();
    expect(ctx).toMatchObject({ client_version: "telegram-miniapp-2.0", provider_id: "aviasales", event_id: CLIENT_CTX.event_id });
    expect(res.json().context.offer_id).toBeUndefined();
  });

  it("unknown or non-UUID offer_id → removed (non-UUID is not even sent to offers)", async () => {
    let res = await createTicket({ category: "BUG", subject: "Нет", message: "…", context: { client_version: "x", offer_id: "0b7c3a52-1d2e-4f60-8a9b-cccccccccccc" } });
    expect(res.statusCode).toBe(201);
    expect(supportBody().context.offer_id).toBeUndefined();
    const before = h.fake.callsTo("offers").length;
    res = await createTicket({ category: "BUG", subject: "Нет", message: "…", context: { client_version: "x", offer_id: "../../etc/passwd" } });
    expect(res.statusCode).toBe(201);
    expect(supportBody().context.offer_id).toBeUndefined();
    expect(h.fake.callsTo("offers")).toHaveLength(before);
  });

  it("offers down / 5xx / bad snapshot → ticket still created without offer_id", async () => {
    const offer = (await myOffers()).tiers!.comfort;
    h.fake.down.add("offers");
    let res = await createTicket({ category: "FLIGHT", subject: "Сбой", message: "…", context: { ...CLIENT_CTX, offer_id: offer.offer_id } });
    expect(res.statusCode).toBe(201);
    expect(supportBody().context.offer_id).toBeUndefined();
    expect(supportBody().context.price_snapshot).toBeUndefined();
    h.fake.down.delete("offers");

    h.fake.override("offers", "GET", `/internal/v1/offers/${offer.offer_id}`, () => domainError(500, "BOOM"));
    res = await createTicket({ category: "FLIGHT", subject: "Сбой", message: "…", context: { client_version: "x", offer_id: offer.offer_id } });
    expect(res.statusCode).toBe(201);
    expect(supportBody().context.offer_id).toBeUndefined();

    h.fake.override("offers", "GET", `/internal/v1/offers/${offer.offer_id}`, () => json(200, { offer_id: "0b7c3a52-1d2e-4f60-8a9b-bbbbbbbbbbbb", event_id: eventId, offer: {} }));
    res = await createTicket({ category: "FLIGHT", subject: "Сбой", message: "…", context: { client_version: "x", offer_id: offer.offer_id } });
    expect(res.statusCode).toBe(201);
    expect(supportBody().context.offer_id).toBeUndefined();
    expect(h.logs.text).toContain("offer_id dropped");
  });

  it("slow offers do not block ticket creation beyond the regular upstream timeout", async () => {
    await h.close();
    await setup({ UPSTREAM_TIMEOUT_MS: "300" });
    const offer = (await myOffers()).tiers!.comfort;
    h.fake.delays.set("offers", 800);
    const t0 = performance.now();
    const res = await createTicket({ category: "FLIGHT", subject: "Медленно", message: "…", context: { client_version: "x", offer_id: offer.offer_id } });
    expect(res.statusCode).toBe(201);
    expect(performance.now() - t0).toBeLessThan(750);
    expect(supportBody().context.offer_id).toBeUndefined();
  });

  it("OFFERS_URL not set → offer_id removed, ticket created", async () => {
    await h.close();
    await setup({ OFFERS_URL: "" });
    const res = await createTicket({ category: "FLIGHT", subject: "Без offers", message: "…", context: { ...CLIENT_CTX, offer_id: "0b7c3a52-1d2e-4f60-8a9b-cccccccccccc" } });
    expect(res.statusCode).toBe(201);
    expect(supportBody().context.offer_id).toBeUndefined();
    expect(h.fake.callsTo("offers")).toHaveLength(0);
  });

  it("without offer_id the client context is unchanged (событие, цена билета)", async () => {
    await createTicket({ category: "TICKET_SOURCE", subject: "Билет", message: "…", context: CLIENT_CTX });
    expect(supportBody().context).toEqual(CLIENT_CTX);
    expect(h.fake.callsTo("offers")).toHaveLength(0);
  });
});

describe("units", () => {
  it("contextFromSnapshot: non-positive total → no price_snapshot; no ok component with a link → no link", () => {
    const set = offerSetFixture("0b7c3a52-1d2e-4f60-8a9b-aaaaaaaaaaaa");
    const offer = structuredClone(set.tiers!.economy) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    offer.flight = { status: "unavailable", reason: "NO_DEPARTURE" };
    offer.hotel = { status: "unavailable", reason: "NO_HOTEL" };
    offer.ticket = { ...offer.ticket, currency: "UZS", in_total: false, deeplink: "javascript:x" };
    offer.totals = { total: "0.00", per_person: "0.00", currency: "USD", missing: ["ticket", "flight", "hotel"] };
    const snap = { offer_id: offer.offer_id, event_id: set.event_id, created_at: "2026-10-11T07:00:00.000Z", offer };
    // неположительный итог ("0.00", "0", пусто) в контекст не кладётся — как isPositiveAmount в Mini App
    expect(contextFromSnapshot(snap, undefined)).toEqual({ offer_id: offer.offer_id, event_id: set.event_id });
    // компонент указан клиентом и ok, но ссылка не https → поставщик есть, ссылки нет
    expect(contextFromSnapshot(snap, "ticketmaster")).toEqual({ offer_id: offer.offer_id, event_id: set.event_id, provider_id: "ticketmaster" });
    for (const total of ["0", "", "-5.00", "abc"]) {
      offer.totals.total = total;
      expect(contextFromSnapshot(snap, undefined).price_snapshot, total).toBeUndefined();
    }
    offer.totals.total = "0.01";
    expect(contextFromSnapshot(snap, undefined).price_snapshot).toEqual({ amount: "0.01", currency: "USD", fetched_at: "2026-10-11T07:00:00.000Z" });
  });

  it("sanitizeOfferSet accepts the contract fixture as is", () => {
    const set = offerSetFixture("0b7c3a52-1d2e-4f60-8a9b-aaaaaaaaaaaa");
    expect(sanitizeOfferSet(structuredClone(set), set.event_id)).toEqual(set);
  });

  it("scrubStrings drops prototype keys and over-deep nesting; project keeps only schema fields", () => {
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "a": "x\\u0000y"}');
    const out = scrubStrings(evil) as Record<string, unknown>;
    expect(out).toEqual({ a: "x y" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    let deep: unknown = "leaf";
    for (let i = 0; i < 30; i++) deep = { d: deep };
    expect(JSON.stringify(scrubStrings(deep))).not.toContain("leaf");
    expect(project({ type: "object", properties: { a: { type: "string" } } }, { a: "1", b: 2 })).toEqual({ a: "1" });
  });

  it("limitedFetch: Content-Length over the limit and streamed bodies over the limit are rejected", async () => {
    const big = "x".repeat(2000);
    const f1 = limitedFetch(async () => new Response(big, { headers: { "content-length": "2000" } }), 1000);
    await expect(f1("http://x")).rejects.toBeInstanceOf(ResponseTooLarge);
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode("y".repeat(400)));
        c.close();
      },
    });
    const f2 = limitedFetch(async () => new Response(stream), 1000);
    await expect(f2("http://x")).rejects.toBeInstanceOf(ResponseTooLarge);
    const f3 = limitedFetch(async () => new Response("ok", { status: 201 }), 1000);
    const r = await f3("http://x");
    expect([r.status, await r.text()]).toEqual([201, "ok"]);
  });

  it("config: OFFERS_URL optional (also in prod), validated when set; offers limits", () => {
    expect(testConfig({ OFFERS_URL: "" }).offersUrl).toBeUndefined();
    expect(testConfig({ OFFERS_URL: "http://offers.railway.internal:8115/" }).offersUrl).toBe("http://offers.railway.internal:8115");
    expect(() => testConfig({ OFFERS_URL: "ftp://x" })).toThrow(ConfigError);
    const c = testConfig();
    expect([c.rateLimits.offersPerMinute, c.offersTimeoutMs, c.offersMaxResponseBytes]).toEqual([20, 25_000, 1_048_576]);
    expect(() => testConfig({ RATE_LIMIT_OFFERS_PER_MIN: "0" })).toThrow(ConfigError);
  });
});
