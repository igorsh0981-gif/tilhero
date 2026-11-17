/**
 * Исправление 4.1: мультивыбор стран в GET /v1/events, category=other и GET /v1/events/facets (кэш 60 с в Redis).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { toFacets, type EventsCatalog } from "../src/events.js";
import { canonicalFacetsQuery, FacetsService } from "../src/facets.js";
import { monthWindowOf, parseCountries } from "../src/routes/events.js";
import { EventFacetsSchema } from "../src/schemas.js";
import { aiwebEvent, bearer, catalogEvent, closeRedis, domainError, json, login, makeHarness, testRedis, TG_USER, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
beforeEach(async () => {
  h = await makeHarness();
  s = await login(h);
});
afterEach(async () => {
  await h.close();
});
afterAll(closeRedis);

const get = (url: string, headers: Record<string, string> = bearer(s.access)) => h.app.inject({ url, headers });

const venue = (city: string, country_code: string) => ({
  name: `${city} Arena`,
  city,
  country_code,
  address: null,
  lat: null,
  lon: null,
  map_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(city)}`,
});

const thisMonth = () => `${new Date().toISOString().slice(0, 7)}-28`;
const farDate = { local_date: "2030-06-01", local_time: null, utc: null, timezone: null };

/** UZ: концерт (в продаже, в этом месяце) + экскурсия без категории (анонс); KZ: спорт; GE: online-бизнес; AE: F1. */
function seed(): void {
  h.fake.catalog.push(
    aiwebEvent({ title: "Tashkent Concert", start: { local_date: thisMonth(), local_time: null, utc: null, timezone: null }, lifecycle: { ...aiwebEvent().lifecycle, status: "ON_SALE" } }),
    aiwebEvent({ title: "Тур «1 день 6 локаций»", categories: [], start: farDate }),
    catalogEvent({ title: "Almaty Derby", categories: ["sport.football", "sport"], venue: venue("Almaty", "KZ"), start: farDate }),
    catalogEvent({ title: "Tbilisi AI Online", categories: ["business.ai", "business"], online: true, venue: venue("Tbilisi", "GE"), start: farDate, lifecycle: { ...catalogEvent().lifecycle, status: "ANNOUNCED" } }),
    catalogEvent({ title: "Abu Dhabi GP", start: farDate }),
  );
}

describe("GET /v1/events: several countries (4.1)", () => {
  it("repeated parameter and comma list → one ISO-2 list for event-catalog (upper-cased, de-duplicated, order kept)", async () => {
    seed();
    let res = await get("/v1/events?country=uz&country=KZ");
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("events", "GET", "/internal/v1/events").at(-1)!.query.country).toBe("UZ,KZ");
    expect(res.json().items.map((e: { title: string }) => e.title).sort()).toEqual(["Almaty Derby", "Tashkent Concert", "Тур «1 день 6 локаций»"]);

    res = await get("/v1/events?country=uz,kz&country=GE&country=KZ");
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("events", "GET", "/internal/v1/events").at(-1)!.query.country).toBe("UZ,KZ,GE");

    res = await get("/v1/events?country=ae");
    expect(h.fake.callsTo("events", "GET", "/internal/v1/events").at(-1)!.query.country).toBe("AE");
    expect(res.json().items.map((e: { title: string }) => e.title)).toEqual(["Abu Dhabi GP"]);
  });

  it("up to 20 countries are accepted; 21 (comma list or repeated) → 422", async () => {
    const codes = Array.from({ length: 21 }, (_, i) => `A${String.fromCharCode(65 + i)}`);
    expect((await get(`/v1/events?country=${codes.slice(0, 20).join(",")}`)).statusCode).toBe(200);
    expect(h.fake.callsTo("events").at(-1)!.query.country!.split(",")).toHaveLength(20);
    // дубли не считаются: 20 разных + повтор — ок
    expect((await get(`/v1/events?country=${codes.slice(0, 20).join(",")}&country=AA`)).statusCode).toBe(200);
    const calls = h.fake.callsTo("events").length;
    for (const qs of [`country=${codes.join(",")}`, codes.map((c) => `country=${c}`).join("&"), `country=${codes.slice(0, 11).join(",")}&country=${codes.slice(11).join(",")}`]) {
      const res = await get(`/v1/events?${qs}`);
      expect(res.statusCode, qs).toBe(422);
      expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { in: "querystring", field: "country" } });
    }
    expect(h.fake.callsTo("events")).toHaveLength(calls);
  });

  it.each([
    ["three letters", "country=UZB"],
    ["trailing comma", "country=UZ,"],
    ["empty item", "country=UZ,,KZ"],
    ["digits", "country=U1"],
    ["empty value", "country="],
    ["space", "country=UZ,%20KZ"],
    ["injection", "country=UZ'%20OR%201=1"],
  ])("422 VALIDATION_ERROR for country: %s", async (_name, qs) => {
    const res = await get(`/v1/events?${qs}`);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { in: "querystring", field: "country" } });
    expect(h.fake.callsTo("events")).toHaveLength(0);
  });

  it("category=other is forwarded and returns events without a category", async () => {
    seed();
    const res = await get("/v1/events?category=other");
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("events").at(-1)!.query.category).toBe("other");
    expect(res.json().items.map((e: { title: string; categories: string[] }) => [e.title, e.categories])).toEqual([["Тур «1 день 6 локаций»", []]]);
  });

  it("parseCountries: flattening, upper case, de-duplication, limits", () => {
    expect(parseCountries(undefined)).toBeUndefined();
    expect(parseCountries([])).toBeUndefined();
    expect(parseCountries(["uz,kz", "Uz", "ge"])).toEqual(["UZ", "KZ", "GE"]);
    expect(() => parseCountries(["U1"])).toThrow();
    expect(() => parseCountries([Array.from({ length: 21 }, (_, i) => `B${String.fromCharCode(65 + i)}`).join(",")])).toThrow();
  });
});

describe("GET /v1/events/facets (4.1)", () => {
  it("returns EventFacets from event-catalog; every counter ignores only its own dimension", async () => {
    seed();
    const res = await get("/v1/events/facets?country=UZ&country=KZ&has_tickets=true");
    expect(res.statusCode).toBe(200);
    const f = res.json();
    expect(Value.Check(EventFacetsSchema, f)).toBe(true);
    const call = h.fake.callsTo("events", "GET", "/internal/v1/events:facets").at(-1)!;
    expect(call.query).toEqual({ country: "KZ,UZ", has_tickets: "true" }); // канонический порядок (ключ кэша)
    expect(call.subject).toBeUndefined(); // не персонально: user_id каталогу не передаём
    // total: UZ/KZ + в продаже → концерт (ON_SALE) и дерби (ON_SALE)
    expect(f.total).toBe(2);
    expect(f.has_tickets).toBe(2); // без своего измерения — то же (экскурсия ANNOUNCED)
    expect(f.this_month).toBe(1);
    expect(f.online).toBe(0);
    expect(f.categories).toEqual({ music: 1, sport: 1 });
    // countries — без фильтра стран: AE тоже в продаже, GE — анонс (не в продаже)
    expect(f.countries).toEqual({ UZ: 1, KZ: 1, AE: 1 });

    const other = (await get("/v1/events/facets?country=UZ")).json();
    expect(other.categories).toEqual({ music: 1, other: 1 });
    expect(other.total).toBe(2);
  });

  it("forwards the same normalised filters as the search (q trimmed, dates checked, other category); no sort/limit/cursor", async () => {
    const res = await get("/v1/events/facets?q=%20%20Jazz%20&category=other&country=kz,uz&city=%20Almaty%20&date_from=2026-12-01&date_to=2026-12-31&online=false");
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("events").at(-1)!.query).toEqual({
      q: "Jazz",
      category: "other",
      country: "KZ,UZ",
      city: "Almaty",
      date_from: "2026-12-01",
      date_to: "2026-12-31",
      online: "false",
    });
    for (const qs of ["sort=quality", "limit=10", "cursor=abc", "user_id=x"]) {
      const bad = await get(`/v1/events/facets?${qs}`);
      expect(bad.statusCode, qs).toBe(422);
      expect(bad.json().details).toMatchObject({ in: "querystring", field: qs.split("=")[0] });
    }
  });

  it.each([
    ["q longer than 100", `q=${"a".repeat(101)}`, "q"],
    ["category not a code", "category=Sport!", "category"],
    ["country not ISO-2", "country=UZB", "country"],
    ["too many countries", `country=${Array.from({ length: 21 }, (_, i) => `C${String.fromCharCode(65 + i)}`).join(",")}`, "country"],
    ["impossible date", "date_from=2026-02-30", "date_from"],
    ["reversed range", "date_from=2026-12-10&date_to=2026-12-01", "date_to"],
    ["has_tickets not boolean", "has_tickets=maybe", "has_tickets"],
  ])("422 VALIDATION_ERROR: %s", async (_name, qs, field) => {
    const res = await get(`/v1/events/facets?${qs}`);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { in: "querystring", field } });
    expect(h.fake.callsTo("events")).toHaveLength(0);
  });

  it("401 without a token / with a foreign token; 423 for a session waiting for the PIN", async () => {
    expect((await h.app.inject({ url: "/v1/events/facets" })).statusCode).toBe(401);
    expect((await get("/v1/events/facets", bearer("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad"))).json().code).toBe("TOKEN_INVALID");
    h.fake.enablePin(s.userId, "4826");
    const locked = await login(h);
    const res = await get("/v1/events/facets", bearer(locked.access));
    expect(res.statusCode).toBe(423);
    expect(h.fake.callsTo("events")).toHaveLength(0);
  });

  it("the route is not taken for an event id: /v1/events/facets ≠ /v1/events/{eventId}", async () => {
    const res = await get("/v1/events/facets");
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("events").at(-1)!.path).toBe("/internal/v1/events:facets");
  });

  it("cache 60 s by the set of filters: same filters in another order/form → one catalog call, shared between users", async () => {
    seed();
    const a = (await get("/v1/events/facets?country=UZ,KZ&online=false")).json();
    const b = (await get("/v1/events/facets?online=false&country=kz&country=uz&country=UZ")).json();
    expect(b).toEqual(a);
    expect(h.fake.callsTo("events", "GET", "/internal/v1/events:facets")).toHaveLength(1);
    // другой пользователь, те же фильтры — общий кэш (счётчики не персональные)
    const other = await login(h, { ...TG_USER, id: TG_USER.id + 1 });
    expect((await get("/v1/events/facets?country=UZ,KZ&online=false", bearer(other.access))).json()).toEqual(a);
    expect(h.fake.callsTo("events", "GET", "/internal/v1/events:facets")).toHaveLength(1);
    // другие фильтры — новый вызов
    await get("/v1/events/facets?country=UZ");
    expect(h.fake.callsTo("events", "GET", "/internal/v1/events:facets")).toHaveLength(2);
    // ключ — хэш фильтров (текст поиска в ключе не виден), TTL ≈ 60 с
    await get("/v1/events/facets?q=secret%20words");
    const redis = testRedis();
    const keys = await redis.keys(`${h.config.redisKeyPrefix}facets:*`);
    expect(keys).toHaveLength(3);
    for (const k of keys) {
      expect(k).toMatch(/facets:v1:[0-9a-f]{64}$/);
      const ttl = await redis.ttl(k);
      expect(ttl).toBeGreaterThan(50);
      expect(ttl).toBeLessThanOrEqual(60);
    }
  });

  it("catalog outage → 503 EVENTS_UNAVAILABLE and nothing is cached; 4xx of the catalog passes through", async () => {
    h.fake.down.add("events");
    let res = await get("/v1/events/facets");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "EVENTS_UNAVAILABLE", details: { service: "events" } });
    h.fake.down.delete("events");
    h.fake.override("events", "GET", "/internal/v1/events:facets", () => domainError(500, "INTERNAL_ERROR"));
    expect((await get("/v1/events/facets")).json().code).toBe("EVENTS_UNAVAILABLE");
    h.fake.override("events", "GET", "/internal/v1/events:facets", () => domainError(403, "CALLER_NOT_ALLOWED"));
    expect((await get("/v1/events/facets")).statusCode).toBe(503);
    expect(await testRedis().keys(`${h.config.redisKeyPrefix}facets:*`)).toHaveLength(0);
    h.fake.override("events", "GET", "/internal/v1/events:facets", () => domainError(422, "VALIDATION_ERROR"));
    res = await get("/v1/events/facets");
    expect(res.statusCode).toBe(422);
  });

  it("untrusted catalog answer: counters → integers ≥ 0, bad keys and foreign fields dropped (also from the Redis copy)", async () => {
    h.fake.override("events", "GET", "/internal/v1/events:facets", () =>
      json(200, {
        total: 12,
        this_month: -3,
        has_tickets: 2.5,
        online: "7",
        categories: { music: 4, "sport.football": 1, "<script>": 2, other: 3, Music: 1, culture: null },
        countries: { uz: 5, KZ: 2, UZB: 1, "": 9, kz: 4 },
        user_id: "leak",
        internal_note: "x",
      }),
    );
    const res = await get("/v1/events/facets");
    expect(res.statusCode).toBe(200);
    const want = { total: 12, this_month: 0, has_tickets: 0, online: 0, categories: { music: 4, other: 3, culture: 0 }, countries: { UZ: 5, KZ: 2 } };
    expect(res.json()).toEqual(want);
    expect(res.body).not.toContain("leak");
    // копия в Redis подменена — при чтении снова маппинг контракта
    const [key] = await testRedis().keys(`${h.config.redisKeyPrefix}facets:*`);
    await testRedis().set(key!, JSON.stringify({ ...want, total: -1, countries: { "<b>": 1, ge: 2 }, extra: true }), "EX", 60);
    expect((await get("/v1/events/facets")).json()).toEqual({ ...want, total: 0, countries: { GE: 2 } });
    expect(toFacets(null)).toEqual({ total: 0, this_month: 0, has_tickets: 0, online: 0, categories: {}, countries: {} });
  });

  it("FACETS_CACHE_SECONDS=0 disables the cache", async () => {
    const h2 = await makeHarness({ FACETS_CACHE_SECONDS: "0" });
    try {
      const s2 = await login(h2);
      await h2.app.inject({ url: "/v1/events/facets", headers: bearer(s2.access) });
      await h2.app.inject({ url: "/v1/events/facets", headers: bearer(s2.access) });
      expect(h2.fake.callsTo("events", "GET", "/internal/v1/events:facets")).toHaveLength(2);
    } finally {
      await h2.close();
    }
  });

  it("concurrent identical requests are coalesced (single-flight): one catalog call", async () => {
    h.fake.delays.set("events", 150);
    const [a, b, c] = await Promise.all([get("/v1/events/facets?country=UZ"), get("/v1/events/facets?country=uz"), get("/v1/events/facets?country=UZ,UZ")]);
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([200, 200, 200]);
    expect(h.fake.callsTo("events", "GET", "/internal/v1/events:facets")).toHaveLength(1);
  });

  it("FacetsService: Redis read/write errors are logged and skipped, the answer comes from the catalog", async () => {
    const boom = () => Promise.reject(new Error("ECONNRESET"));
    const redis = { get: boom, set: boom } as unknown as import("ioredis").Redis;
    const warn = vi.fn();
    const log = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as import("fastify").FastifyBaseLogger;
    const facets = vi.fn(async () => toFacets({ total: 3 }));
    const svc = new FacetsService({ redis, catalog: { facets } as unknown as EventsCatalog, keyPrefix: "t:", ttlSeconds: 60, log });
    expect((await svc.get({ country: ["UZ"] })).total).toBe(3);
    expect(warn.mock.calls.map((c) => c[1])).toEqual(["facets cache read failed", "facets cache write failed"]);
    expect(facets).toHaveBeenCalledWith({ country: ["UZ"] });
  });

  it("month_from/month_to: the chip window is forwarded to event-catalog and this_month is counted over it", async () => {
    seed();
    const month = thisMonth().slice(0, 8);
    let res = await get(`/v1/events/facets?country=UZ&month_from=${month}27&month_to=${month}28`);
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("events", "GET", "/internal/v1/events:facets").at(-1)!.query).toEqual({
      country: "UZ",
      month_from: `${month}27`,
      month_to: `${month}28`,
    });
    expect(res.json().this_month).toBe(1); // концерт 28-го
    res = await get(`/v1/events/facets?country=UZ&month_from=${month}01&month_to=${month}27`);
    expect(res.json().this_month).toBe(0); // окно до 27-го — концерт не в нём
    // без окна — как раньше (параметры каталогу не уходят)
    await get("/v1/events/facets?country=UZ");
    expect(h.fake.callsTo("events", "GET", "/internal/v1/events:facets").at(-1)!.query).toEqual({ country: "UZ" });
  });

  it("month window is part of the cache key: another window → another catalog call; the same → cached", async () => {
    await get("/v1/events/facets?month_from=2026-10-31&month_to=2026-10-31");
    await get("/v1/events/facets?month_from=2026-10-31&month_to=2026-10-31");
    expect(h.fake.callsTo("events", "GET", "/internal/v1/events:facets")).toHaveLength(1);
    await get("/v1/events/facets?month_from=2026-11-01&month_to=2026-11-30"); // пользователь восточнее: уже 1-е
    await get("/v1/events/facets");
    expect(h.fake.callsTo("events", "GET", "/internal/v1/events:facets")).toHaveLength(3);
    const svc = new FacetsService({ redis: {} as never, catalog: {} as never, keyPrefix: "p:", ttlSeconds: 60, log: {} as never });
    expect(svc.key({ month_from: "2026-10-31", month_to: "2026-10-31" })).not.toBe(svc.key({ month_from: "2026-10-30", month_to: "2026-10-31" }));
    expect(svc.key({ month_from: "2026-10-31", month_to: "2026-10-31" })).not.toBe(svc.key({}));
    expect(canonicalFacetsQuery({ month_to: "2026-10-31", country: ["UZ"], month_from: "2026-10-01" })).toEqual({
      country: ["UZ"],
      month_from: "2026-10-01",
      month_to: "2026-10-31",
    });
  });

  it.each([
    ["month_from without month_to", "month_from=2026-10-01", "month_to"],
    ["month_to without month_from", "month_to=2026-10-31", "month_from"],
    ["impossible month_from", "month_from=2026-02-30&month_to=2026-03-01", "month_from"],
    ["impossible month_to", "month_from=2026-02-01&month_to=2026-02-29", "month_to"],
    ["month_from not a date", "month_from=today&month_to=2026-10-31", "month_from"],
    ["reversed window", "month_from=2026-10-31&month_to=2026-10-01", "month_from"],
    ["window longer than 31 days", "month_from=2026-10-01&month_to=2026-11-02", "month_to"],
    ["empty month_from", "month_from=&month_to=2026-10-31", "month_from"],
  ])("422 VALIDATION_ERROR (untrusted month window): %s", async (_name, qs, field) => {
    const res = await get(`/v1/events/facets?${qs}`);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { in: "querystring", field } });
    expect(h.fake.callsTo("events")).toHaveLength(0);
  });

  it("month window: exactly 31 days and one day are accepted; the search does not take it", async () => {
    expect((await get("/v1/events/facets?month_from=2026-10-01&month_to=2026-11-01")).statusCode).toBe(200);
    expect((await get("/v1/events/facets?month_from=2028-02-29&month_to=2028-02-29")).statusCode).toBe(200);
    const bad = await get("/v1/events?month_from=2026-10-01&month_to=2026-10-31");
    expect(bad.statusCode).toBe(422);
    expect(bad.json().details).toMatchObject({ in: "querystring", field: "month_from" });
    expect(monthWindowOf({})).toEqual({});
    expect(monthWindowOf({ month_from: "2026-12-01", month_to: "2027-01-01" })).toEqual({ month_from: "2026-12-01", month_to: "2027-01-01" });
    expect(() => monthWindowOf({ month_from: "2026-12-01", month_to: "2027-01-02" })).toThrow();
  });

  it("canonical key: order, duplicates and empty parameters do not matter", () => {
    expect(canonicalFacetsQuery({ online: false, country: ["KZ", "UZ", "KZ"], q: "", category: undefined })).toEqual({ country: ["KZ", "UZ"], online: false });
    const svc = new FacetsService({ redis: {} as never, catalog: {} as never, keyPrefix: "p:", ttlSeconds: 60, log: {} as never });
    expect(svc.key({ country: ["UZ", "KZ"], has_tickets: true })).toBe(svc.key({ has_tickets: true, country: ["KZ", "UZ", "UZ"] }));
    expect(svc.key({ country: ["UZ"] })).not.toBe(svc.key({ country: ["KZ"] }));
    expect(svc.key({ has_tickets: false })).not.toBe(svc.key({}));
  });
});
