/**
 * Исправление 5.2 (prod 11.10: Бишкек, 1 человек — Premium $869.64, 2 человека — $327.49): при смене числа
 * путешественников Mini App присылает отели тарифов прошлого расчёта (`keep_hotels`) — BFF передаёт их в
 * `offers:build` как `overrides.keep_hotels`, тариф остаётся на своём отеле. Совместимость со старым offers.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@tilhero/ts-common";
import { keepHotelsOf, rejectedNewFields, withoutFields51, type BuildRequest } from "../src/offers.js";
import { bearer, catalogEvent, closeRedis, domainError, login, makeHarness, type Harness, type LoggedIn } from "./helpers.js";

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

const recalc = (body: unknown) =>
  h.app.inject({ method: "POST", url: `/v1/events/${eventId}/offers/recalculate`, headers: bearer(s.access), payload: body as object });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildCalls = () => h.fake.callsTo("offers", "POST", "/internal/v1/offers:build") as Array<{ body: any }>;
const BASE = { departure_iata: null, direct_only: false, near_venue: false, extra_nights: 0 };

describe("5.2: keep_hotels in recalculate", () => {
  it("keep_hotels is forwarded in overrides (only the given tiers)", async () => {
    const res = await recalc({ travellers: 2, keep_hotels: { economy: "fru5", comfort: "fru3", premium: "fru2" } });
    expect(res.statusCode).toBe(200);
    expect(buildCalls()[0]!.body.overrides).toEqual({ ...BASE, keep_hotels: { economy: "fru5", comfort: "fru3", premium: "fru2" } });
    await recalc({ travellers: 3, keep_hotels: { premium: "fru2" } });
    expect(buildCalls()[1]!.body.overrides).toEqual({ ...BASE, keep_hotels: { premium: "fru2" } });
    expect(buildCalls()[1]!.body.travellers).toBe(3);
  });

  it("null, {} or omitted → not sent (same params_hash as without it); with hotel_id → only hotel_id", async () => {
    await recalc({ travellers: 2, keep_hotels: null });
    await recalc({ travellers: 2, keep_hotels: {} });
    await recalc({ travellers: 2 });
    expect(buildCalls().map((c) => "keep_hotels" in c.body.overrides)).toEqual([false, false, false]);
    await recalc({ travellers: 2, hotel_id: "lp2", keep_hotels: { premium: "fru2" } });
    expect(buildCalls()[3]!.body.overrides).toEqual({ ...BASE, hotel_id: "lp2" });
  });

  it.each([
    { premium: "../x" },
    { premium: "" },
    { premium: "x".repeat(65) },
    { lux: "fru1" },
    { premium: 1 },
    ["fru1"],
    "fru1",
  ])("invalid keep_hotels %j → 422 VALIDATION_ERROR, offers not called", async (keep) => {
    const res = await recalc({ travellers: 2, keep_hotels: keep });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(buildCalls()).toHaveLength(0);
  });
});

describe("5.2: rollout against offers without keep_hotels (extra=forbid)", () => {
  it("only keep_hotels rejected → one retry without it, the budget stays", async () => {
    h.fake.prefs.get(s.userId)!.budget = { currency: "USD", preset: "1000_2000", min: 1000, max: 2000, custom_amount: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.fake.offersBuildGuard = (body: any) =>
      body.overrides && "keep_hotels" in body.overrides
        ? domainError(422, "VALIDATION_ERROR", { errors: [{ loc: ["body", "overrides", "keep_hotels"], msg: "Extra inputs are not permitted", type: "extra_forbidden" }] })
        : null;
    const res = await recalc({ travellers: 2, keep_hotels: { premium: "fru2" } });
    expect(res.statusCode).toBe(200);
    const calls = buildCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.overrides).toEqual(BASE);
    expect(calls[1]!.body.budget).toEqual({ min: "1000.00", max: "2000.00" });
  });

  it("rejectedNewFields / withoutFields51 / keepHotelsOf", () => {
    const e = (errors: unknown[]) => new AppError(422, "VALIDATION_ERROR", "m", { errors });
    expect([...rejectedNewFields(e([{ loc: ["body", "overrides", "keep_hotels", "premium"] }]))!]).toEqual(["keep_hotels"]);
    expect([...rejectedNewFields(e([{ loc: ["body", "budget"] }, { loc: ["body", "overrides", "keep_hotels"] }]))!].sort()).toEqual(["budget", "keep_hotels"]);
    expect(rejectedNewFields(e([{ loc: ["body", "overrides", "keep_hotels"] }, { loc: ["body", "travellers"] }]))).toBeNull();
    const body: BuildRequest = {
      event_id: "e",
      travellers: 2,
      departures: [],
      flight_prefs: { direct: false, connecting: true, alternative_departure: false },
      overrides: { ...BASE, keep_hotels: { premium: "fru2" } },
      budget: { min: "1.00", max: "2.00" },
      lang: "ru",
    };
    expect(withoutFields51(body, new Set(["keep_hotels"]))).toEqual({ ...body, overrides: BASE });
    expect(withoutFields51(body)).toEqual({ ...body, overrides: BASE, budget: undefined });
    expect(keepHotelsOf({})).toBeNull();
    expect(keepHotelsOf(null)).toBeNull();
    expect(keepHotelsOf({ economy: "a", premium: "" })).toEqual({ economy: "a" });
  });
});
