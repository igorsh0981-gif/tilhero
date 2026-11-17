/**
 * Исправление 5.1 (docs/sprint5/FEEDBACK_5_1.md §A, §B): is_past в карточках и детали, бюджет профиля в offers:build,
 * hotel_id в пересчёте, новые поля OfferSetView и совместимость со старыми events/offers.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import type { OfferSetView, Preferences } from "@tilhero/contracts/bff";
import { resetIsPastLegacyWarning, toCard, toDetail } from "../src/events.js";
import { BUDGET_PRESETS, divMoney, rejectsFields51, sanitizeOfferSet, tripBudget } from "../src/offers.js";
import { AppError } from "@tilhero/ts-common";
import { EventDetailViewSchema, EventPageSchema, HomeResponseSchema, OfferSetViewSchema } from "../src/schemas.js";
import { bearer, catalogEvent, closeRedis, domainError, login, makeHarness, offerSetFixture, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
let eventId: string;

beforeEach(async () => {
  resetIsPastLegacyWarning();
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
const recalc = (body: unknown) =>
  h.app.inject({ method: "POST", url: `/v1/events/${eventId}/offers/recalculate`, headers: bearer(s.access), payload: body as object });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildCalls = () => h.fake.callsTo("offers", "POST", "/internal/v1/offers:build") as Array<{ body: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tamper = (fn: (set: any) => unknown) => {
  h.fake.offersBuild = (set) => fn(structuredClone(set));
};
const setBudget = (budget: Preferences["budget"]) => {
  h.fake.prefs.get(s.userId)!.budget = budget;
};
const warnings = (msg: string) => h.logs.parsed().filter((l) => typeof l.msg === "string" && (l.msg as string).startsWith(msg));

/** Ответ offers до 5.1: без budget/recommended_tier/hotel_chosen_by и бюджетных полей тарифов и отелей. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function legacy(set: any): any {
  delete set.budget;
  delete set.recommended_tier;
  delete set.hotel_chosen_by;
  for (const t of Object.values(set.tiers ?? {}) as Array<Record<string, unknown>>) {
    delete t.budget_fit;
    delete t.over_by;
    delete (t.ticket as Record<string, unknown>).fx;
  }
  for (const x of set.hotels_nearby as Array<Record<string, unknown>>) {
    delete x.per_person_share;
    delete x.budget_fit;
    delete x.over_by;
  }
  return set;
}

// ---------------------------------------------------------------- A. is_past

describe("5.1 A: is_past passes through from events", () => {
  it("catalog, detail and Home rails carry is_past from the catalog", async () => {
    const past = catalogEvent({ title: "HOUSE RULES | TOMAN", is_past: true, start: { local_date: "2026-10-10", local_time: null, utc: null, timezone: "Asia/Dubai" }, end: null });
    h.fake.catalog.push(past);

    const page = (await get("/v1/events")).json();
    expect(Value.Check(EventPageSchema, page)).toBe(true);
    const byId = Object.fromEntries(page.items.map((e: { event_id: string; is_past: boolean }) => [e.event_id, e.is_past]));
    expect(byId).toEqual({ [eventId]: false, [past.event_id]: true });

    const detail = (await get(`/v1/events/${past.event_id}`)).json();
    expect(Value.Check(EventDetailViewSchema, detail)).toBe(true);
    expect(detail.is_past).toBe(true);

    h.fake.experience.home.sections = [{ type: "event_carousel", key: "best_for_you", variant: "large", enabled: true }];
    const home = (await get("/v1/home")).json();
    expect(Value.Check(HomeResponseSchema, home)).toBe(true);
    const cards = home.sections[0].items as Array<{ event_id: string; is_past: boolean }>;
    expect(cards.find((c) => c.event_id === past.event_id)?.is_past).toBe(true);
    expect(cards.every((c) => typeof c.is_past === "boolean")).toBe(true);
    expect(warnings("events response without boolean is_past")).toHaveLength(0);
  });

  it("old events without is_past → false everywhere and exactly one warning", async () => {
    for (const e of h.fake.catalog) delete (e as { is_past?: boolean }).is_past;
    h.fake.catalog.push(catalogEvent({ is_past: undefined }));
    const page = (await get("/v1/events")).json();
    expect(page.items).toHaveLength(2);
    expect(page.items.every((e: { is_past: unknown }) => e.is_past === false)).toBe(true);
    expect((await get(`/v1/events/${eventId}`)).json().is_past).toBe(false);
    await get("/v1/events");
    const w = warnings("events response without boolean is_past");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ upstream: "events", field: "is_past" });
  });

  it("garbage is_past (string) is not trusted: false", () => {
    const log = { warn: vi.fn() };
    expect(toCard({ ...catalogEvent(), is_past: "true" }, log)!.is_past).toBe(false);
    expect(toDetail({ ...catalogEvent(), is_past: 1 }, log)!.is_past).toBe(false);
    expect(toCard({ ...catalogEvent(), is_past: true }, log)!.is_past).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- B. бюджет в offers:build

describe("5.1 B: budget from preferences → offers:build", () => {
  it.each([
    ["under_500", { min: null, max: "500.00" }],
    ["500_1000", { min: "500.00", max: "1000.00" }],
    ["1000_2000", { min: "1000.00", max: "2000.00" }],
    ["2000_5000", { min: "2000.00", max: "5000.00" }],
  ] as const)("preset %s → %j", async (preset, expected) => {
    const [lo, hi] = BUDGET_PRESETS[preset]!;
    setBudget({ currency: "USD", preset, min: lo, max: hi, custom_amount: null });
    const res = await get(`/v1/events/${eventId}/offers?travellers=2`);
    expect(res.statusCode).toBe(200);
    expect(buildCalls()[0]!.body.budget).toEqual(expected);
    expect(res.json().budget).toEqual(expected); // offers эхом возвращает бюджет расчёта
  });

  it("custom → {min: null, max: custom_amount}; also for recalculate", async () => {
    setBudget({ currency: "USD", preset: "custom", min: 0, max: 1500, custom_amount: 1500 });
    await get(`/v1/events/${eventId}/offers`);
    await recalc({ travellers: 3 });
    expect(buildCalls().map((c) => c.body.budget)).toEqual([
      { min: null, max: "1500.00" },
      { min: null, max: "1500.00" },
    ]);
  });

  it("no budget in profile → budget not sent; response says budget null", async () => {
    setBudget({ currency: "USD", preset: null, min: null, max: null, custom_amount: null });
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(buildCalls()[0]!.body).not.toHaveProperty("budget");
    expect(res.json().budget).toBeNull();
  });

  it("tripBudget: ranges without preset, garbage and non-USD", () => {
    expect(tripBudget({ currency: "USD", preset: null, min: 500, max: 5000, custom_amount: null })).toEqual({ min: "500.00", max: "5000.00" });
    expect(tripBudget({ currency: "USD", preset: null, min: 0, max: 1000, custom_amount: null })).toEqual({ min: null, max: "1000.00" });
    expect(tripBudget({ currency: "USD", preset: "custom", min: 0, max: 100000, custom_amount: 100000 })).toEqual({ min: null, max: "100000.00" });
    // пресет — по таблице, даже если min/max профиля другие
    expect(tripBudget({ currency: "USD", preset: "1000_2000", min: 1, max: 2, custom_amount: null })).toEqual({ min: "1000.00", max: "2000.00" });
    for (const bad of [
      null,
      undefined,
      "1000",
      { currency: "EUR", preset: "1000_2000", min: 1000, max: 2000, custom_amount: null },
      { currency: "USD", preset: "luxury", min: 1000, max: 2000, custom_amount: null },
      { currency: "USD", preset: "custom", min: 0, max: null, custom_amount: null },
      { currency: "USD", preset: "custom", min: 0, max: 12.5, custom_amount: 12.5 },
      { currency: "USD", preset: "custom", min: 0, max: -5, custom_amount: -5 },
      { currency: "USD", preset: "custom", min: 0, max: 0, custom_amount: 0 },
      { currency: "USD", preset: null, min: 2000, max: 1000, custom_amount: null },
      { currency: "USD", preset: null, min: "500", max: "1000", custom_amount: null },
      { currency: "USD", preset: "__proto__", min: 1, max: 2, custom_amount: null },
      { currency: "USD", preset: "custom", min: 0, max: 1_000_001, custom_amount: 1_000_001 }, // предел offers BudgetIn
    ]) {
      expect(tripBudget(bad)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- B. hotel_id

describe("5.1 B: recalculate with hotel_id", () => {
  it("hotel_id is forwarded in overrides; GET, null and omitted → not sent; response hotel_chosen_by", async () => {
    const res = await recalc({ travellers: 2, hotel_id: "lp2" });
    expect(res.statusCode).toBe(200);
    expect(buildCalls()[0]!.body.overrides).toEqual({ departure_iata: null, direct_only: false, near_venue: false, extra_nights: 0, hotel_id: "lp2" });
    expect(res.json().hotel_chosen_by).toBe("user");

    await recalc({ travellers: 2, hotel_id: null });
    await recalc({ travellers: 2 });
    await get(`/v1/events/${eventId}/offers`);
    expect(buildCalls().slice(1).map((c) => "hotel_id" in c.body.overrides)).toEqual([false, false, false]);

    const max = "A_b-9".repeat(12) + "Zz_-";
    expect(max).toHaveLength(64);
    expect((await recalc({ travellers: 1, hotel_id: max })).statusCode).toBe(200);
    expect(buildCalls().at(-1)!.body.overrides.hotel_id).toBe(max);
  });

  it.each([["x".repeat(65)], [""], ["lp 2"], ["lp/2"], ["../etc"], ["lp2\n"], ["отель"], [42], [true], [["lp2"]]])(
    "invalid hotel_id %j → 422 VALIDATION_ERROR, offers not called",
    async (hotelId) => {
      const res = await recalc({ travellers: 2, hotel_id: hotelId });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { in: "body", field: "hotel_id" } });
      expect(buildCalls()).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------- B. ответ offers

describe("5.1 B: OfferSetView budget fields", () => {
  it("new fields pass through as sent by offers", async () => {
    setBudget({ currency: "USD", preset: "1000_2000", min: 1000, max: 2000, custom_amount: null });
    tamper((set: OfferSetView) => {
      set.recommended_tier = "economy";
      set.tiers!.economy.budget_fit = "within";
      set.tiers!.comfort.budget_fit = "over";
      set.tiers!.comfort.over_by = "120.50";
      set.tiers!.premium.budget_fit = "over";
      set.tiers!.premium.over_by = "900.00";
      set.hotels_nearby[0]!.budget_fit = "over";
      set.hotels_nearby[0]!.over_by = "15.00";
      set.hotels_nearby.push({ ...set.hotels_nearby[0]!, hotel_id: "lp3", budget_fit: "within", over_by: null, per_person_share: "250.00" });
      return set;
    });
    const res = await get(`/v1/events/${eventId}/offers?travellers=2`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as OfferSetView;
    expect(Value.Check(OfferSetViewSchema, body)).toBe(true);
    expect(body).toMatchObject({ budget: { min: "1000.00", max: "2000.00" }, recommended_tier: "economy", hotel_chosen_by: "rules" });
    expect([body.tiers!.economy, body.tiers!.comfort, body.tiers!.premium].map((t) => [t.budget_fit, t.over_by])).toEqual([
      ["within", null],
      ["over", "120.50"],
      ["over", "900.00"],
    ]);
    expect(body.hotels_nearby.map((x) => [x.hotel_id, x.per_person_share, x.budget_fit, x.over_by])).toEqual([
      ["lp2", "600.00", "over", "15.00"],
      ["lp3", "250.00", "within", null],
    ]);
    expect(warnings("offers response without 5.1 fields")).toHaveLength(0);
  });

  it("old offers without 5.1 fields → defaults, per_person_share computed (banker's rounding), one warning", async () => {
    tamper((set) => {
      legacy(set);
      set.hotels_nearby[0].price_total = "1000.01"; // 100001 / 2 = 50000.5 → к чётному 50000
      set.hotels_nearby.push({ ...set.hotels_nearby[0], hotel_id: "lp3", price_total: "1000.03" }); // 50001.5 → 50002
      return set;
    });
    const res = await get(`/v1/events/${eventId}/offers?travellers=2`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as OfferSetView;
    expect(Value.Check(OfferSetViewSchema, body)).toBe(true);
    expect(body).toMatchObject({ budget: null, recommended_tier: null, hotel_chosen_by: "rules" });
    for (const t of [body.tiers!.economy, body.tiers!.comfort, body.tiers!.premium]) {
      expect([t.budget_fit, t.over_by]).toEqual(["unknown", null]);
      expect(t.ticket).toMatchObject({ status: "ok", fx: null });
    }
    expect(body.hotels_nearby.map((x) => [x.per_person_share, x.budget_fit, x.over_by])).toEqual([
      ["500.00", "unknown", null],
      ["500.02", "unknown", null],
    ]);
    await get(`/v1/events/${eventId}/offers?travellers=3`);
    const w = warnings("offers response without 5.1 fields");
    expect(w).toHaveLength(1);
    expect(w[0]!.missing_fields).toEqual(
      expect.arrayContaining(["budget", "recommended_tier", "hotel_chosen_by", "tiers.budget_fit", "tiers.ticket.fx", "hotels_nearby.per_person_share"]),
    );
  });

  it("legacy not_available (tiers null) passes; recommended_tier forced to null without tiers", async () => {
    tamper((set) => ({ ...legacy(set), trip: { ...set.trip, kind: "not_available", reason: "EVENT_PAST" }, tiers: null, hotels_nearby: [], poi: [] }));
    const a = await get(`/v1/events/${eventId}/offers`);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ tiers: null, recommended_tier: null, budget: null });
    tamper((set) => ({ ...set, trip: { ...set.trip, kind: "not_available", reason: "EVENT_PAST" }, tiers: null, recommended_tier: "comfort" }));
    expect((await get(`/v1/events/${eventId}/offers`)).json().recommended_tier).toBeNull();
  });

  it.each([
    ["budget_fit outside enum", (x: any) => void (x.tiers.comfort.budget_fit = "maybe")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["over without over_by", (x: any) => void (x.tiers.comfort.budget_fit = "over")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["within with over_by", (x: any) => void (x.tiers.economy.over_by = "10.00")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["over_by not money", (x: any) => Object.assign(x.tiers.premium, { budget_fit: "over", over_by: "12.345" })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["over_by number", (x: any) => Object.assign(x.tiers.premium, { budget_fit: "over", over_by: 12 })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["hotel_chosen_by unknown", (x: any) => void (x.hotel_chosen_by = "admin")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["recommended_tier unknown", (x: any) => void (x.recommended_tier = "vip")], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["budget.max number", (x: any) => void (x.budget = { min: null, max: 2000 })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["budget min > max", (x: any) => void (x.budget = { min: "2000.00", max: "1000.00" })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["budget without max key", (x: any) => void (x.budget = { min: "2000.00" })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["hotel_chosen_by null", (x: any) => void (x.hotel_chosen_by = null)], // eslint-disable-line @typescript-eslint/no-explicit-any
  ])("strict validation: %s → 503 OFFERS_UNAVAILABLE", async (_name, mutate) => {
    tamper((set) => {
      mutate(set);
      return set;
    });
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("OFFERS_UNAVAILABLE");
  });

  it("inconsistent or invalid nearby hotel is dropped, the rest stays", async () => {
    tamper((set) => {
      const base = set.hotels_nearby[0];
      set.hotels_nearby = [
        { ...base, hotel_id: "ok1" },
        { ...base, hotel_id: "bad_over", budget_fit: "over", over_by: null },
        { ...base, hotel_id: "bad_within", budget_fit: "within", over_by: "1.00" },
        { ...base, hotel_id: "bad_share", per_person_share: "1,00" },
        { ...base, hotel_id: "bad_fit", budget_fit: "cheap" },
        { ...base, hotel_id: "ok2", budget_fit: "over", over_by: "30.00" },
      ];
      return set;
    });
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(200);
    expect(res.json().hotels_nearby.map((x: { hotel_id: string }) => x.hotel_id)).toEqual(["ok1", "ok2"]);
  });

  it("sanitizeOfferSet: legacy hotel with broken price_total cannot get a share → dropped", () => {
    const set = legacy(structuredClone(offerSetFixture(eventId, { travellers: 2 })));
    set.hotels_nearby.push({ ...set.hotels_nearby[0], hotel_id: "broken", price_total: "abc" });
    const legacyFields = new Set<string>();
    const out = sanitizeOfferSet(set, eventId, legacyFields);
    expect(out.hotels_nearby.map((x) => x.hotel_id)).toEqual(["lp2"]);
    expect(legacyFields.has("hotels_nearby.per_person_share")).toBe(true);
  });
});

// ---------------------------------------------------------------- 5.1: старый offers отвергает поля запроса

/** 422 старого offers (extra="forbid", формат py-common) на присланные поля 5.1. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function oldOffersGuard(body: any): Response | null {
  const errors: Array<{ loc: string[]; msg: string; type: string }> = [];
  if ("budget" in body) errors.push({ loc: ["body", "budget"], msg: "Extra inputs are not permitted", type: "extra_forbidden" });
  if ("hotel_id" in (body.overrides ?? {})) errors.push({ loc: ["body", "overrides", "hotel_id"], msg: "Extra inputs are not permitted", type: "extra_forbidden" });
  return errors.length ? domainError(422, "VALIDATION_ERROR", { errors }) : null;
}

describe("5.1: rollout against old offers (extra=forbid)", () => {
  beforeEach(() => {
    h.fake.offersBuildGuard = oldOffersGuard;
  });

  it("no budget and no hotel → nothing new is sent, one call, no retry", async () => {
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(200);
    expect(buildCalls()).toHaveLength(1);
    expect(warnings("offers rejected 5.1 request fields")).toHaveLength(0);
  });

  it("budget + hotel_id rejected with 422 → one retry without them, 200, one warning per process", async () => {
    setBudget({ currency: "USD", preset: "1000_2000", min: 1000, max: 2000, custom_amount: null });
    const res = await recalc({ travellers: 2, hotel_id: "lp2", extra_nights: 1 });
    expect(res.statusCode).toBe(200);
    const calls = buildCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ budget: { min: "1000.00", max: "2000.00" }, overrides: { hotel_id: "lp2" } });
    expect(calls[1]!.body).not.toHaveProperty("budget");
    expect(calls[1]!.body.overrides).toEqual({ departure_iata: null, direct_only: false, near_venue: false, extra_nights: 1 });
    expect(calls[1]!.body).toMatchObject({ event_id: eventId, travellers: 2, lang: "ru" });
    expect(res.json()).toMatchObject({ budget: null, hotel_chosen_by: "rules" });

    await get(`/v1/events/${eventId}/offers`);
    expect(buildCalls()).toHaveLength(4);
    expect(warnings("offers rejected 5.1 request fields")).toHaveLength(1);
  });

  it("only budget rejected → retry; retry fails again → error mapped as usual (422 VALIDATION_ERROR), no third call", async () => {
    setBudget({ currency: "USD", preset: "custom", min: 0, max: 1500, custom_amount: 1500 });
    h.fake.offersBuildGuard = () => domainError(422, "VALIDATION_ERROR", { errors: [{ loc: ["body", "budget"], msg: "x", type: "extra_forbidden" }] });
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(buildCalls()).toHaveLength(2);
  });

  it("422 on other fields, or other codes → no retry", async () => {
    setBudget({ currency: "USD", preset: "custom", min: 0, max: 1500, custom_amount: 1500 });
    h.fake.offersBuildGuard = () =>
      domainError(422, "VALIDATION_ERROR", {
        errors: [
          { loc: ["body", "budget"], msg: "x", type: "extra_forbidden" },
          { loc: ["body", "travellers"], msg: "x", type: "less_than_equal" },
        ],
      });
    expect((await get(`/v1/events/${eventId}/offers`)).statusCode).toBe(422);
    expect(buildCalls()).toHaveLength(1);

    h.fake.offersBuildGuard = () => domainError(422, "OFFER_DEPARTURE_INVALID", { errors: [{ loc: ["body", "budget"] }] });
    expect((await get(`/v1/events/${eventId}/offers`)).json().code).toBe("OFFER_DEPARTURE_INVALID");
    expect(buildCalls()).toHaveLength(2);
  });

  it("rejectsFields51: only VALIDATION_ERROR 422 with all errors at budget / overrides.hotel_id", () => {
    const e = (status: number, code: string, details: Record<string, unknown>) => new AppError(status, code, "m", details);
    expect(rejectsFields51(e(422, "VALIDATION_ERROR", { errors: [{ loc: ["body", "budget", "max"] }] }))).toBe(true);
    expect(rejectsFields51(e(422, "VALIDATION_ERROR", { errors: [{ loc: ["body", "overrides", "hotel_id"] }] }))).toBe(true);
    expect(rejectsFields51(e(422, "VALIDATION_ERROR", { errors: [{ loc: ["body", "overrides", "near_venue"] }] }))).toBe(false);
    expect(rejectsFields51(e(422, "VALIDATION_ERROR", { errors: [] }))).toBe(false);
    expect(rejectsFields51(e(422, "VALIDATION_ERROR", {}))).toBe(false);
    expect(rejectsFields51(e(400, "VALIDATION_ERROR", { errors: [{ loc: ["body", "budget"] }] }))).toBe(false);
    expect(rejectsFields51(new Error("x"))).toBe(false);
  });
});

// ---------------------------------------------------------------- 5.1: билет по курсу ЦБ (OfferTicket.fx)

const FX = { price_per_person_usd: "85.42", rate: "12650.75", date: "2026-10-11", source: "cbu.uz" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const uzsTicket = (set: any, fx: unknown = FX) => {
  for (const t of Object.values(set.tiers) as Array<{ ticket: Record<string, unknown> }>) {
    Object.assign(t.ticket, { price_per_person: "1080600.00", currency: "UZS", in_total: true, fx });
  }
  set.notes = ["TICKET_FX_CONVERTED"];
  return set;
};

describe("5.1: ticket.fx (CBU rate) and TICKET_FX_CONVERTED", () => {
  it("converted ticket passes through; unavailable ticket has no fx", async () => {
    tamper((set) => {
      uzsTicket(set);
      set.tiers.premium.ticket = { status: "unavailable", reason: "NO_PRICE" };
      return set;
    });
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as OfferSetView;
    expect(Value.Check(OfferSetViewSchema, body)).toBe(true);
    expect(body.tiers!.economy.ticket).toMatchObject({ currency: "UZS", in_total: true, fx: FX });
    expect(body.tiers!.premium.ticket).toEqual({ status: "unavailable", reason: "NO_PRICE" });
    expect(body.notes).toEqual(["TICKET_FX_CONVERTED"]);
  });

  it("ticket not in USD without rate: fx null, in_total false", async () => {
    tamper((set) => {
      uzsTicket(set, null);
      for (const t of Object.values(set.tiers) as Array<{ ticket: Record<string, unknown> }>) t.ticket.in_total = false;
      set.notes = ["TICKET_NOT_USD"];
      return set;
    });
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(200);
    expect(res.json().tiers.comfort.ticket).toMatchObject({ in_total: false, fx: null });
  });

  it.each([
    ["rate zero", { ...FX, rate: "0" }],
    ["rate 0.000", { ...FX, rate: "0.000" }],
    ["rate negative", { ...FX, rate: "-12650.75" }],
    ["rate number", { ...FX, rate: 12650.75 }],
    ["rate > 24 chars", { ...FX, rate: "12345678.1234567890123" }],
    ["rate 9 integer digits", { ...FX, rate: "123456789.5" }],
    ["rate 13 decimals", { ...FX, rate: "0.0000789123456" }],
    ["rate trailing dot", { ...FX, rate: "12650." }],
    ["rate exponent", { ...FX, rate: "1e4" }],
    ["usd not money", { ...FX, price_per_person_usd: "85.425" }],
    ["usd number", { ...FX, price_per_person_usd: 85.42 }],
    ["date with time", { ...FX, date: "2026-10-11T00:00:00Z" }],
    ["date format", { ...FX, date: "11.10.2026" }],
    ["source other", { ...FX, source: "ecb.europa.eu" }],
    ["missing source", { price_per_person_usd: "85.42", rate: "12650.75", date: "2026-10-11" }],
    ["fx string", "cbu"],
  ])("strict fx: %s → 503", async (_n, fx) => {
    tamper((set) => uzsTicket(set, fx));
    const res = await get(`/v1/events/${eventId}/offers`);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("OFFERS_UNAVAILABLE");
  });

  it("fx with in_total false or USD currency → 503 (inconsistent)", async () => {
    tamper((set) => {
      uzsTicket(set);
      set.tiers.comfort.ticket.in_total = false;
      return set;
    });
    expect((await get(`/v1/events/${eventId}/offers`)).statusCode).toBe(503);
    tamper((set) => {
      uzsTicket(set);
      set.tiers.economy.ticket.currency = "USD";
      return set;
    });
    expect((await get(`/v1/events/${eventId}/offers`)).statusCode).toBe(503);
  });

  it("real gateway rates accepted (up to 12 decimals), edge lengths", async () => {
    // строки курсов как их отдаёт provider-gateway (cbu.uz): KGS, UZS-обратный, RUB, USD→UZS
    for (const rate of ["0.011435318", "0.000078912345", "0.0128", "12650.75", "1", "12345678.123456789012", "0.000000000001"]) {
      tamper((set) => uzsTicket(set, { ...FX, rate }));
      const res = await get(`/v1/events/${eventId}/offers`);
      expect(res.statusCode, rate).toBe(200);
      expect(res.json().tiers.economy.ticket.fx.rate).toBe(rate);
    }
  });
});

describe("divMoney: banker's rounding to cents", () => {
  it.each([
    ["1000.00", 3, "333.33"],
    ["1000.00", 6, "166.67"],
    ["100.01", 2, "50.00"],
    ["100.03", 2, "50.02"],
    ["0.05", 2, "0.02"],
    ["0.15", 2, "0.08"],
    ["6347", 1, "6347.00"],
    ["6347.5", 4, "1586.88"],
    ["999999999999.99", 6, "166666666666.66"],
  ])("%s / %d = %s", (amount, n, expected) => {
    expect(divMoney(amount, n)).toBe(expected);
  });

  it("not money or bad divisor → null", () => {
    for (const [a, n] of [["1e3", 2], ["-1.00", 2], ["1.001", 2], [100, 2], ["100.00", 0], ["100.00", 1.5], ["100.00", "2"]] as const) {
      expect(divMoney(a, n)).toBeNull();
    }
  });
});
