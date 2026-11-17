/**
 * Спринт 3: каталог событий и Home с рельсами (AT-24 BFF-часть, AT-25 provenance, AT-34 stale Home).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { EventsCatalog, fallbackMapUrl, httpsOrNull, media, priceRange, sourceName, toCard, toDetail } from "../src/events.js";
import { byQualityThenSoonest, HomeService, personalSignals } from "../src/home.js";
import { isCalendarDate } from "../src/routes/events.js";
import { EventDetailViewSchema, EventPageSchema, HomeResponseSchema } from "../src/schemas.js";
import { AIWEB_URL, aiwebEvent, bearer, catalogEvent, closeRedis, domainError, login, makeHarness, type Harness, type LoggedIn } from "./helpers.js";
import { NewsService, RecommendationsService, WatchService } from "../src/personal.js";

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

/** Поля каталога, которых нет в контракте bff.ts — не должны попасть в ответ Mini App. */
const INTERNAL = ["dedup_keys", "external_ids", "verdict", "internal_note", "hidden"];
function expectNoInternal(body: string): void {
  for (const k of INTERNAL) expect(body, k).not.toContain(`"${k}"`);
}

describe("GET /v1/events", () => {
  it("returns Page<EventCard> mapped 1:1 from EventSummary, without catalog-internal fields", async () => {
    h.fake.catalog.push(
      catalogEvent({ title: "Formula 1 Abu Dhabi Grand Prix", quality_score: 92 }),
      catalogEvent({ title: "Bosphorus Live Weekend", categories: ["music.concerts", "music"], venue: { name: "Volkswagen Arena", city: "Istanbul", country_code: "TR", address: null, lat: null, lon: null, map_url: "https://www.google.com/maps/search/?api=1&query=Volkswagen%20Arena%2C%20Istanbul" }, start: { local_date: "2027-05-21", local_time: null, utc: null, timezone: "Europe/Istanbul" }, media: null, price_range: null }),
    );
    const res = await get("/v1/events");
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(Value.Check(EventPageSchema, page)).toBe(true);
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
    const [f1, music] = page.items;
    expect(f1).toEqual({
      event_id: h.fake.catalog[0]!.event_id,
      title: "Formula 1 Abu Dhabi Grand Prix",
      categories: ["sport.motorsport", "sport"],
      start: { local_date: "2026-12-04", local_time: "17:00:00", utc: "2026-12-04T13:00:00Z", timezone: "Asia/Dubai" },
      end: { local_date: "2026-12-06", local_time: null, utc: null, timezone: "Asia/Dubai" },
      venue: { name: "Yas Marina Circuit", city: "Abu Dhabi", country_code: "AE" },
      online: false,
      lifecycle: { status: "ON_SALE", changed_at: "2026-10-09T08:00:00Z" },
      quality_score: 92,
      price_range: { min: "120.00", max: "950.00", currency: "USD", fetched_at: "2026-10-10T08:00:00Z", source: { provider: "ticketmaster", url: "https://www.ticketmaster.com/event/abc" } },
      media: {
        url: "https://s1.ticketm.net/dam/a/1d1/f1_RETINA_LANDSCAPE_16_9.jpg",
        width: 2048,
        height: 1152,
        ratio: "16_9",
        provenance: { provider: "ticketmaster", source_url: "https://www.ticketmaster.com/event/abc", fetched_at: "2026-10-10T08:00:00Z", rights: "provider_api" },
      },
      updated_at: "2026-10-10T08:00:00Z",
      is_past: false,
    });
    expect(music.media).toBeNull();
    expect(music.price_range).toBeNull();
    expectNoInternal(res.body);
    // карточка — не деталь: official_url/sources/track в список не попадают
    for (const k of ["official_url", "sources", "lifecycle_track", "media_all", "first_seen_at", "basis", "map_url"]) expect(res.body).not.toContain(`"${k}"`);
  });

  it("forwards filters to event-catalog (defaults soonest/20, q trimmed, country upper-cased, no user_id)", async () => {
    const res = await get("/v1/events?q=%20%20Formula%201%20&category=sport.motorsport&country=ae&city=Abu%20Dhabi&date_from=2026-12-01&date_to=2026-12-31&has_tickets=true&online=false");
    expect(res.statusCode).toBe(200);
    const call = h.fake.callsTo("events", "GET", "/internal/v1/events").at(-1)!;
    expect(call.query).toEqual({
      q: "Formula 1",
      category: "sport.motorsport",
      country: "AE",
      city: "Abu Dhabi",
      date_from: "2026-12-01",
      date_to: "2026-12-31",
      has_tickets: "true",
      online: "false",
      sort: "soonest",
      limit: "20",
    });
    // внутренний JWT: aud=events, iss=telegram-bff; каталог — не пользовательский домен, user_id ему не передаём
    expect(call.subject).toBeUndefined();
    await get("/v1/events?sort=quality&limit=50&q=%20%20");
    expect(h.fake.callsTo("events").at(-1)!.query).toEqual({ sort: "quality", limit: "50" });
  });

  it("search, filters and cursor pagination work end to end", async () => {
    for (let i = 0; i < 25; i++) h.fake.catalog.push(catalogEvent({ title: `Concert ${i}`, start: { local_date: `2027-01-${String(i + 1).padStart(2, "0")}`, local_time: null, utc: null, timezone: null } }));
    h.fake.catalog.push(catalogEvent({ title: "Online AI Summit", online: true, venue: null, categories: ["business.ai", "business"] }));
    const p1 = (await get("/v1/events?q=concert&limit=10")).json();
    expect(p1.items).toHaveLength(10);
    expect(p1.items[0].title).toBe("Concert 0");
    expect(p1.next_cursor).toEqual(expect.any(String));
    const p2 = (await get(`/v1/events?q=concert&limit=10&cursor=${p1.next_cursor}`)).json();
    expect(p2.items[0].title).toBe("Concert 10");
    expect(h.fake.callsTo("events").at(-1)!.query.cursor).toBe(p1.next_cursor);
    const online = (await get("/v1/events?online=true&category=business")).json();
    expect(online.items.map((e: { title: string }) => e.title)).toEqual(["Online AI Summit"]);
    expect(online.items[0].venue).toBeNull();
    const none = (await get("/v1/events?q=nothing-like-this")).json();
    expect(none).toEqual({ items: [], next_cursor: null });
  });

  it.each([
    ["q longer than 100", `q=${"a".repeat(101)}`, "q"],
    ["category not a taxonomy code", "category=Sport!", "category"],
    ["category with sql", "category=sport'%20OR%201=1", "category"],
    ["country not ISO-2", "country=UZB", "country"],
    ["date format", "date_from=10.12.2026", "date_from"],
    ["impossible date", "date_to=2026-02-30", "date_to"],
    ["date range reversed", "date_from=2026-12-10&date_to=2026-12-01", "date_to"],
    ["has_tickets not boolean", "has_tickets=maybe", "has_tickets"],
    ["online not boolean", "online=1x", "online"],
    ["unknown sort", "sort=price", "sort"],
    ["limit above 50", "limit=51", "limit"],
    ["limit 0", "limit=0", "limit"],
    ["empty cursor", "cursor=", "cursor"],
    ["unknown parameter (user_id is never accepted)", "user_id=6f1c2a7e-3b9d-4c51-9a0e-2d7f81c4b6a1", "user_id"],
  ])("422 VALIDATION_ERROR: %s", async (_name, qs, field) => {
    const res = await get(`/v1/events?${qs}`);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { in: "querystring", field } });
    expect(h.fake.callsTo("events")).toHaveLength(0);
  });

  it("401 without a token and with a foreign token", async () => {
    expect((await h.app.inject({ url: "/v1/events" })).json().code).toBe("UNAUTHORIZED");
    const bad = await get("/v1/events", bearer("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad"));
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe("TOKEN_INVALID");
    expect(h.fake.callsTo("events")).toHaveLength(0);
  });

  it("event-catalog outage → 503 EVENTS_UNAVAILABLE (network, 5xx, internal auth); catalog 4xx passes through", async () => {
    h.fake.down.add("events");
    let res = await get("/v1/events");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "EVENTS_UNAVAILABLE", details: { service: "events" } });
    h.fake.down.delete("events");
    h.fake.override("events", "GET", "/internal/v1/events", () => domainError(500, "INTERNAL_ERROR"));
    res = await get("/v1/events");
    expect(res.json().code).toBe("EVENTS_UNAVAILABLE");
    h.fake.override("events", "GET", "/internal/v1/events", () => domainError(403, "CALLER_NOT_ALLOWED"));
    res = await get("/v1/events");
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("EVENTS_UNAVAILABLE");
    h.fake.override("events", "GET", "/internal/v1/events", () => domainError(422, "CURSOR_INVALID"));
    res = await get("/v1/events?cursor=garbage");
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("CURSOR_INVALID");
  });
});

describe("GET /v1/events/{eventId}", () => {
  it("returns EventDetailView with sources, lifecycle basis and provenance; internal fields dropped", async () => {
    const ev = catalogEvent({ title: "Formula 1 Abu Dhabi Grand Prix" });
    h.fake.catalog.push(ev);
    const res = await get(`/v1/events/${ev.event_id.toUpperCase()}`);
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(Value.Check(EventDetailViewSchema, d)).toBe(true);
    expect(h.fake.callsTo("events").at(-1)!.path).toBe(`/internal/v1/events/${ev.event_id}`);
    const { dedup_keys: _a, external_ids: _b, verdict: _c, internal_note: _d, hidden: _e, ...expected } = ev;
    expect(d).toEqual({ ...expected, recommendation: null, watch: null, reaction: null }); // спринт 6: домены не настроены
    expectNoInternal(res.body);
  });

  it("404 EVENT_NOT_FOUND for an unknown/hidden event and for a non-UUID id (catalog not called)", async () => {
    h.fake.catalog.push(catalogEvent({ event_id: "11111111-2222-4333-8444-555555555555", hidden: true }));
    let res = await get("/v1/events/11111111-2222-4333-8444-555555555555");
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("EVENT_NOT_FOUND");
    res = await get("/v1/events/9b0c1d2e-0000-4000-8000-000000000000");
    expect(res.json().code).toBe("EVENT_NOT_FOUND");
    const calls = h.fake.callsTo("events").length;
    for (const bad of ["evt_f1_auh_2026", "..%2F..%2Finternal", "1%27%20OR%201%3D1"]) {
      res = await get(`/v1/events/${bad}`);
      expect(res.statusCode, bad).toBe(404);
      expect(res.json().code).toBe("EVENT_NOT_FOUND");
    }
    expect(h.fake.callsTo("events")).toHaveLength(calls);
  });

  it("401 without a token; 503 EVENTS_UNAVAILABLE when the catalog is down", async () => {
    expect((await h.app.inject({ url: "/v1/events/9b0c1d2e-0000-4000-8000-000000000000" })).statusCode).toBe(401);
    h.fake.down.add("events");
    const res = await get("/v1/events/9b0c1d2e-0000-4000-8000-000000000000");
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("EVENTS_UNAVAILABLE");
  });
});

describe("mapping of untrusted catalog data", () => {
  const prov = { provider: "ticketmaster", source_url: "https://www.ticketmaster.com/event/abc", fetched_at: "2026-10-10T08:00:00Z", rights: "provider_api" };

  it("media without provenance, with http or javascript URL, or unknown rights → null (UI fallback, AT-25)", () => {
    expect(media({ url: "https://x.example/a.jpg", width: 1, height: 1, ratio: null, provenance: prov })).not.toBeNull();
    expect(media({ url: "https://x.example/a.jpg", width: 1, height: 1, ratio: null })).toBeNull();
    expect(media({ url: "http://x.example/a.jpg", provenance: prov })).toBeNull();
    expect(media({ url: "javascript:alert(1)", provenance: prov })).toBeNull();
    expect(media({ url: "https://x.example/a.jpg", provenance: { ...prov, source_url: "http://evil" } })).toBeNull();
    expect(media({ url: "https://x.example/a.jpg", provenance: { ...prov, rights: "scraped" } })).toBeNull();
    expect(media(null)).toBeNull();
  });

  it("price range must be decimal strings with ISO currency and an https source", () => {
    const ok = { min: "120.00", max: "950", currency: "USD", fetched_at: "2026-10-10T08:00:00Z", source: { provider: "ticketmaster", url: "https://www.ticketmaster.com/e" } };
    expect(priceRange(ok)).toEqual(ok);
    expect(priceRange({ ...ok, min: 120.5 })).toBeNull();
    expect(priceRange({ ...ok, max: "9.999" })).toBeNull();
    expect(priceRange({ ...ok, currency: "usd" })).toBeNull();
    expect(priceRange({ ...ok, source: { provider: "tm", url: "http://x" } })).toBeNull();
  });

  it("detail: non-https official/source links are dropped; fallback map link by coordinates, else by venue name", () => {
    const raw = { ...catalogEvent(), official_url: "javascript:alert(1)", sources: [{ provider: "tm", tier: "OFFICIAL_TICKET_PROVIDER", url: "http://x", fetched_at: "t" }] };
    (raw.venue as unknown as Record<string, unknown>).map_url = "ftp://x";
    const d = toDetail(raw)!;
    expect(d.official_url).toBe("");
    expect(d.sources).toEqual([]);
    expect(d.venue!.map_url).toBe("https://www.google.com/maps/search/?api=1&query=24.4672,54.6031");
    const noCoord = toDetail({ ...raw, venue: { ...raw.venue!, lat: null, lon: null, map_url: "ftp://x" } })!;
    expect(noCoord.venue!.map_url).toBe("https://www.google.com/maps/search/?api=1&query=Yas%20Marina%20Circuit%2C%20Abu%20Dhabi");
    expect(fallbackMapUrl("V", "C", "1; DROP", "2")).toBe("https://www.google.com/maps/search/?api=1&query=V%2C%20C");
  });

  it("https links: URL-parsed, no userinfo/credentials, no http/javascript/protocol-relative", () => {
    expect(httpsOrNull("https://www.ticketmaster.com/event/1?x=1")).toBe("https://www.ticketmaster.com/event/1?x=1");
    for (const bad of ["https://user:pass@evil.example/", "https://user@evil.example/", "http://x.example", "//x.example", "javascript:alert(1)", "https://", "https://a b.example", 'https://x.example/"onerror', 42]) {
      expect(httpsOrNull(bad), String(bad)).toBeNull();
    }
  });

  it("unknown lifecycle status is never replaced: the card is dropped, unknown/duplicate track steps too", () => {
    expect(toCard({ ...catalogEvent(), lifecycle: { status: "HACKED", changed_at: "x" } })).toBeNull();
    const d = toDetail({
      ...catalogEvent(),
      lifecycle_track: [
        { status: "ANNOUNCED", reached: true, current: false },
        { status: "WHATEVER", reached: true, current: false },
        { status: "ANNOUNCED", reached: true, current: false },
        { status: "ON_SALE", reached: true, current: true },
      ],
    })!;
    expect(d.lifecycle_track.map((x) => x.status)).toEqual(["ANNOUNCED", "ON_SALE"]);
    expect(toDetail({ ...catalogEvent(), lifecycle: { ...catalogEvent().lifecycle, status: "HACKED" } })).toBeNull();
  });

  it("search drops cards with an unknown lifecycle; detail with an unknown lifecycle → 404", async () => {
    const odd = catalogEvent({ title: "Odd" });
    (odd.lifecycle as unknown as Record<string, unknown>).status = "TELEPORTED";
    h.fake.catalog.push(catalogEvent({ title: "Normal" }), odd);
    const page = (await get("/v1/events")).json();
    expect(page.items.map((e: { title: string }) => e.title)).toEqual(["Normal"]);
    const res = await get(`/v1/events/${odd.event_id}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("EVENT_NOT_FOUND");
  });

  it("calendar dates are validated", () => {
    expect(isCalendarDate("2026-12-31")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
  });
});

describe("GET /v1/home", () => {
  const sec = (body: { sections: Array<{ key: string }> }, key: string) => body.sections.find((x) => x.key === key) as { state: string; items: Array<{ title: string; event_id: string }> } | undefined;

  beforeEach(() => {
    h.fake.experience.home.sections = [
      { type: "event_carousel", key: "best_for_you", variant: "large", enabled: true },
      { type: "watch_changes", key: "watch", variant: "compact", enabled: true },
      { type: "event_carousel", key: "sales_soon", variant: "compact", enabled: true },
      { type: "news_carousel", key: "news", variant: "compact", enabled: true },
      { type: "catalog_link", key: "all_events", variant: "compact", enabled: true },
    ];
  });

  it("best_for_you by interests + countries (quality, then soonest); sales_soon = SALES_SOON soonest; watch/news pending", async () => {
    h.fake.prefs.set(s.userId, {
      ...(await get("/v1/profile")).json().preferences,
      interests: { categories: ["sport.motorsport", "music.concerts"], entities: [] },
      geographies: [{ level: "country", code: "AE" }, { level: "country", code: "tr" }, { level: "region", code: "europe" }],
    });
    h.fake.catalog.push(
      catalogEvent({ title: "F1 Abu Dhabi", quality_score: 90 }),
      catalogEvent({ title: "Le Mans", quality_score: 95, venue: { name: "Circuit de la Sarthe", city: "Le Mans", country_code: "FR", address: null, lat: null, lon: null, map_url: "https://www.google.com/maps/search/?api=1&query=x" } }),
      catalogEvent({ title: "Istanbul concert", quality_score: 90, categories: ["music.concerts", "music"], start: { local_date: "2026-11-01", local_time: null, utc: null, timezone: null }, venue: { name: "Arena", city: "Istanbul", country_code: "TR", address: null, lat: null, lon: null, map_url: "https://www.google.com/maps/search/?api=1&query=y" } }),
      catalogEvent({ title: "Tech expo", quality_score: 99, categories: ["business.expo", "business"] }),
      catalogEvent({ title: "Soon in Dubai", quality_score: 50, lifecycle: { ...catalogEvent().lifecycle, status: "SALES_SOON" }, start: { local_date: "2027-03-01", local_time: null, utc: null, timezone: null } }),
      catalogEvent({ title: "Soon earlier", quality_score: 40, lifecycle: { ...catalogEvent().lifecycle, status: "SALES_SOON" }, start: { local_date: "2027-01-15", local_time: null, utc: null, timezone: null }, categories: ["culture.exhibitions", "culture"] }),
    );
    const res = await get("/v1/home");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Value.Check(HomeResponseSchema, body)).toBe(true);
    expect(body.summary).toBeNull();
    expect(Date.parse(body.generated_at)).toBeGreaterThan(Date.now() - 10_000);
    // Le Mans (FR) не в географии, Tech expo — не в интересах; равный quality → раньше дата
    expect(sec(body, "best_for_you")!.items.map((e) => e.title)).toEqual(["Istanbul concert", "F1 Abu Dhabi", "Soon in Dubai"]);
    expect(sec(body, "best_for_you")!.state).toBe("ready");
    expect(sec(body, "sales_soon")).toMatchObject({ state: "ready" });
    expect(sec(body, "sales_soon")!.items.map((e) => e.title)).toEqual(["Soon earlier", "Soon in Dubai"]);
    expect(sec(body, "watch")).toEqual({ type: "watch_changes", key: "watch", variant: "compact", state: "pending_data", items: [] });
    expect(sec(body, "news")!.state).toBe("pending_data");
    expect(sec(body, "all_events")).toEqual({ type: "catalog_link", key: "all_events", variant: "compact", state: "ready", items: [] });
    // interests → по запросу на категорию (quality); страны > 1 → фильтр в BFF; preferences — по sub пользователя
    const qs = h.fake.callsTo("events", "GET", "/internal/v1/events").map((c) => c.query);
    expect(qs).toEqual(
      expect.arrayContaining([
        { category: "sport.motorsport", sort: "quality", limit: "30" },
        { category: "music.concerts", sort: "quality", limit: "30" },
        { lifecycle: "SALES_SOON", sort: "soonest", limit: "10" },
      ]),
    );
    expect(h.fake.callsTo("preferences", "GET", "/internal/v1/me/preferences").at(-1)!.subject).toBe(s.userId);
    expectNoInternal(res.body);
  });

  it("single country is passed to the catalog; nothing by interests → general list by quality; ≤ 10 cards", async () => {
    h.fake.prefs.set(s.userId, {
      ...(await get("/v1/profile")).json().preferences,
      interests: { categories: ["culture.theatre"], entities: [] },
      geographies: [{ level: "country", code: "UZ" }],
    });
    for (let i = 0; i < 14; i++) h.fake.catalog.push(catalogEvent({ title: `Popular ${i}`, quality_score: 50 + i }));
    const body = (await get("/v1/home")).json();
    expect(h.fake.callsTo("events").map((c) => c.query)).toEqual(expect.arrayContaining([{ category: "culture.theatre", country: "UZ", sort: "quality", limit: "30" }, { sort: "quality", limit: "50" }]));
    const best = sec(body, "best_for_you")!;
    expect(best.state).toBe("ready");
    expect(best.items).toHaveLength(10);
    expect(best.items[0]!.title).toBe("Popular 13");
  });

  it("fresh cache: a second call within 60 s does not hit the catalog", async () => {
    h.fake.catalog.push(catalogEvent());
    const a = (await get("/v1/home")).json();
    const calls = h.fake.callsTo("events").length;
    const b = (await get("/v1/home")).json();
    expect(h.fake.callsTo("events")).toHaveLength(calls);
    expect(b.generated_at).toBe(a.generated_at);
    expect(sec(b, "best_for_you")!.state).toBe("ready");
  });

  it("AT-34: event-catalog down → sections from the stale copy (state stale), HTTP 200; no copy → unavailable", async () => {
    const h2 = await makeHarness({ HOME_CACHE_SECONDS: "0" });
    try {
      const s2 = await login(h2);
      h2.fake.experience = structuredClone(h.fake.experience);
      h2.fake.catalog.push(catalogEvent({ title: "Cached F1" }), catalogEvent({ title: "Cached soon", lifecycle: { ...catalogEvent().lifecycle, status: "SALES_SOON" } }));
      const fresh = (await h2.app.inject({ url: "/v1/home", headers: bearer(s2.access) })).json();
      expect(sec(fresh, "best_for_you")!.state).toBe("ready");

      h2.fake.down.add("events"); // n8n/discovery тут ни при чём: Home читает каталог, а он «лежит»
      const res = await h2.app.inject({ url: "/v1/home", headers: bearer(s2.access) });
      expect(res.statusCode).toBe(200);
      const stale = res.json();
      expect(Value.Check(HomeResponseSchema, stale)).toBe(true);
      expect(sec(stale, "best_for_you")).toMatchObject({ state: "stale" });
      expect(sec(stale, "best_for_you")!.items.map((e) => e.title)).toEqual(sec(fresh, "best_for_you")!.items.map((e) => e.title));
      expect(sec(stale, "sales_soon")!.state).toBe("stale");
      expect(sec(stale, "sales_soon")!.items.map((e) => e.title)).toEqual(["Cached soon"]);
      expect(sec(stale, "watch")!.state).toBe("pending_data");
      expect(h2.logs.text).toContain("home section unavailable");

      // другой пользователь без stale-копии → unavailable, но 200
      const other = await login(h2, { id: 900777, first_name: "Other" });
      const res2 = await h2.app.inject({ url: "/v1/home", headers: bearer(other.access) });
      expect(res2.statusCode).toBe(200);
      expect(sec(res2.json(), "best_for_you")).toMatchObject({ state: "unavailable", items: [] });
      expect(sec(res2.json(), "sales_soon")).toMatchObject({ state: "unavailable", items: [] });
    } finally {
      await h2.close();
    }
  });

  it("only one rail failing → the other stays ready (no stale copy → unavailable)", async () => {
    const h2 = await makeHarness({ HOME_CACHE_SECONDS: "0" });
    try {
      const s2 = await login(h2);
      h2.fake.experience = structuredClone(h.fake.experience);
      h2.fake.catalog.push(catalogEvent({ title: "Any" }));
      h2.fake.override("events", "GET", "/internal/v1/events", (r) =>
        r.query.lifecycle ? domainError(500, "INTERNAL_ERROR") : Response.json({ items: [], next_cursor: null }),
      );
      const body = (await h2.app.inject({ url: "/v1/home", headers: bearer(s2.access) })).json();
      expect(sec(body, "best_for_you")!.state).toBe("ready");
      expect(sec(body, "sales_soon")!.state).toBe("unavailable");
    } finally {
      await h2.close();
    }
  });

  it("experience-config never reached → bundled layout, still 200", async () => {
    const h2 = await makeHarness({ EXPERIENCE_CACHE_SECONDS: "0" });
    try {
      const s2 = await login(h2);
      h2.fake.down.add("experience");
      const res = await h2.app.inject({ url: "/v1/home", headers: bearer(s2.access) });
      expect(res.statusCode).toBe(200);
      expect(res.json().sections.map((x: { key: string }) => x.key)).toEqual(["best_for_you", "watch", "sales_soon", "news"]);
    } finally {
      await h2.close();
    }
  });

  it("401 without a token; 423 PIN_REQUIRED for a session waiting for the PIN", async () => {
    expect((await h.app.inject({ url: "/v1/home" })).statusCode).toBe(401);
    h.fake.enablePin(s.userId, "4826");
    const locked = await login(h);
    const res = await get("/v1/home", bearer(locked.access));
    expect(res.statusCode).toBe(423);
    expect(res.json().code).toBe("PIN_REQUIRED");
  });

  it("best_for_you survives a partial failure: one interest query fails, the others still fill the rail", async () => {
    h.fake.prefs.set(s.userId, { ...(await get("/v1/profile")).json().preferences, interests: { categories: ["sport.motorsport", "music.concerts"], entities: [] } });
    h.fake.catalog.push(catalogEvent({ title: "F1" }), catalogEvent({ title: "Concert", categories: ["music.concerts", "music"] }));
    h.fake.override("events", "GET", "/internal/v1/events", (r) => {
      if (r.query.category === "music.concerts") return domainError(500, "INTERNAL_ERROR");
      const items = h.fake.catalog.filter((e) => !r.query.category || e.categories.includes(r.query.category)).map((e) => ({ ...e }));
      return Response.json({ items: r.query.lifecycle ? [] : items, next_cursor: null });
    });
    const body = (await get("/v1/home")).json();
    expect(sec(body, "best_for_you")).toMatchObject({ state: "ready" });
    expect(sec(body, "best_for_you")!.items.map((e) => e.title)).toEqual(["F1"]);
  });

  it("preferences down → general picks (ready), not cached as personal and not overwriting the stale copy", async () => {
    const h2 = await makeHarness({ HOME_CACHE_SECONDS: "0" });
    try {
      const s2 = await login(h2);
      h2.fake.experience = structuredClone(h.fake.experience);
      h2.fake.prefs.set(s2.userId, { ...(await h2.app.inject({ url: "/v1/profile", headers: bearer(s2.access) })).json().preferences, interests: { categories: ["sport.motorsport"], entities: [] } });
      h2.fake.catalog.push(catalogEvent({ title: "Personal F1", quality_score: 60 }), catalogEvent({ title: "Popular expo", quality_score: 99, categories: ["business.expo"] }));
      const home = () => h2.app.inject({ url: "/v1/home", headers: bearer(s2.access) }).then((r) => r.json());
      expect(sec(await home(), "best_for_you")!.items.map((e) => e.title)).toEqual(["Personal F1"]);
      h2.fake.down.add("preferences");
      const general = await home();
      expect(sec(general, "best_for_you")).toMatchObject({ state: "ready" });
      expect(sec(general, "best_for_you")!.items[0]!.title).toBe("Popular expo");
      // catalog down now: the stale copy is still the PERSONAL one
      h2.fake.down.add("events");
      const stale = await home();
      expect(sec(stale, "best_for_you")).toMatchObject({ state: "stale" });
      expect(sec(stale, "best_for_you")!.items.map((e) => e.title)).toEqual(["Personal F1"]);
    } finally {
      await h2.close();
    }
  });

  it("cache is per user: another user never gets someone else's picks (fresh or stale)", async () => {
    h.fake.catalog.push(catalogEvent({ title: "Motorsport", categories: ["sport.motorsport"] }), catalogEvent({ title: "Jazz", categories: ["music.jazz"] }));
    h.fake.prefs.set(s.userId, { ...(await get("/v1/profile")).json().preferences, interests: { categories: ["sport.motorsport"], entities: [] } });
    const other = await login(h, { id: 900555, first_name: "Other" });
    h.fake.prefs.set(other.userId, { ...(await get("/v1/profile", bearer(other.access))).json().preferences, interests: { categories: ["music.jazz"], entities: [] } });
    const a = (await get("/v1/home")).json();
    const b = (await get("/v1/home", bearer(other.access))).json();
    expect(sec(a, "best_for_you")!.items.map((e) => e.title)).toEqual(["Motorsport"]);
    expect(sec(b, "best_for_you")!.items.map((e) => e.title)).toEqual(["Jazz"]);
    const keys = await h.app.inject({ url: "/v1/home", headers: bearer(other.access) }).then((r) => r.json());
    expect(sec(keys, "best_for_you")!.items.map((e) => e.title)).toEqual(["Jazz"]);
  });

  it("changing preferences/departures/onboarding resets the user's Home cache", async () => {
    h.fake.catalog.push(catalogEvent({ title: "Motorsport", categories: ["sport.motorsport"] }), catalogEvent({ title: "Jazz", categories: ["music.jazz"] }));
    await get("/v1/home");
    const key = `${h.config.redisKeyPrefix}home:${s.userId}`;
    const redis = (await import("./helpers.js")).testRedis();
    expect(await redis.exists(key)).toBe(1);
    const prefs = (await get("/v1/profile")).json().preferences;
    const patch = await h.app.inject({ method: "PATCH", url: "/v1/profile/preferences", headers: bearer(s.access), payload: { interests: { categories: ["music.jazz"], entities: [] }, version: prefs.version } });
    expect(patch.statusCode).toBe(200);
    expect(await redis.exists(key)).toBe(0);
    expect(sec((await get("/v1/home")).json(), "best_for_you")!.items.map((e) => e.title)).toEqual(["Jazz"]);
    await h.app.inject({ method: "PUT", url: "/v1/profile/departures", headers: bearer(s.access), payload: { airports: ["TAS"] } });
    expect(await redis.exists(key)).toBe(0);
    await get("/v1/home");
    await h.app.inject({ method: "POST", url: "/v1/profile/onboarding/complete", headers: bearer(s.access) });
    expect(await redis.exists(key)).toBe(0);
  });

  it("HomeService: Redis read/write/del errors are logged and skipped, Home still answers from the catalog", async () => {
    const boom = () => Promise.reject(new Error("ECONNRESET"));
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { incr: () => chain, expire: () => chain, del: () => chain, exec: boom });
    const redis = { get: boom, set: boom, del: boom, eval: boom, multi: () => chain } as unknown as import("ioredis").Redis;
    const warn = vi.fn();
    const log = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as import("fastify").FastifyBaseLogger;
    const catalog = { search: vi.fn(async () => ({ items: [toCard(catalogEvent({ title: "From catalog" }))!], next_cursor: null })) } as unknown as EventsCatalog;
    const svc = new HomeService({
      config: h.config,
      redis,
      catalog,
      preferences: { get: async () => null } as never,
      experience: { get: async () => h.fake.experience } as never,
      ...sprint6Off(),
      log,
    });
    const body = await svc.build("6f1c2a7e-3b9d-4c51-9a0e-2d7f81c4b6a1");
    expect(sec(body, "best_for_you")).toMatchObject({ state: "ready" });
    expect(sec(body, "best_for_you")!.items[0]!.title).toBe("From catalog");
    await svc.invalidate("u");
    expect(warn.mock.calls.map((c) => c[1])).toEqual(expect.arrayContaining(["home cache read failed", "home cache invalidate failed"]));
  });

  it("race: a build started with old preferences does not write its picks after invalidate (generation check)", async () => {
    const redis = (await import("./helpers.js")).testRedis();
    const userId = "11111111-2222-4333-8444-000000000777";
    const key = `${h.config.redisKeyPrefix}home:${userId}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const oldPrefs = { ...(await get("/v1/profile")).json().preferences, interests: { categories: ["sport.motorsport"], entities: [] } };
    const catalog = { search: vi.fn(async () => ({ items: [toCard(catalogEvent({ title: "Old picks" }))!], next_cursor: null })) } as unknown as EventsCatalog;
    const svc = new HomeService({
      config: h.config,
      redis,
      catalog,
      preferences: { get: async () => (await gate, oldPrefs) } as never,
      experience: { get: async () => h.fake.experience } as never,
      ...sprint6Off(),
      log: { warn: vi.fn() } as never,
    });
    const building = svc.build(userId); // reads the generation, then waits for preferences
    await new Promise((r) => setTimeout(r, 30));
    await svc.invalidate(userId); // the user changed preferences meanwhile
    release();
    const body = await building;
    expect(sec(body, "best_for_you")!.items.map((e) => e.title)).toEqual(["Old picks"]); // this response is fine…
    expect(await redis.exists(key)).toBe(0); // …but it is not cached under the new generation
    expect(await redis.get(`${h.config.redisKeyPrefix}home:gen:${userId}`)).toBe("1");
    expect(await redis.ttl(`${h.config.redisKeyPrefix}home:gen:${userId}`)).toBeGreaterThan(0);
    // the next build (new generation) caches normally
    await svc.build(userId);
    expect(await redis.exists(key)).toBe(1);
  });

  it("cached rails are re-mapped on read: foreign fields and unknown statuses in Redis never reach the client", async () => {
    h.fake.catalog.push(catalogEvent({ title: "Clean" }));
    const key = `${h.config.redisKeyPrefix}home:${s.userId}`;
    const redis = (await import("./helpers.js")).testRedis();
    const card = { ...toCard(catalogEvent({ title: "Tampered" }))!, internal_note: "secret" };
    const bad = { ...toCard(catalogEvent({ title: "Bad status" }))!, lifecycle: { status: "HACKED", changed_at: "x" } };
    await redis.set(key, JSON.stringify({ v: 1, at: Date.now(), rails: { best_for_you: [card, bad], sales_soon: [] } }), "EX", 60);
    const res = await get("/v1/home");
    expect(sec(res.json(), "best_for_you")!.items.map((e) => e.title)).toEqual(["Tampered"]);
    expect(res.body).not.toContain("internal_note");
  });

  it("helpers: personal signals and ordering", () => {
    expect(personalSignals(null)).toEqual({ categories: [], countries: [] });
    const a = toCard(catalogEvent({ quality_score: 70, start: { local_date: "2027-01-02", local_time: null, utc: null, timezone: null } }))!;
    const b = toCard(catalogEvent({ quality_score: 70, start: { local_date: "2027-01-01", local_time: null, utc: null, timezone: null } }))!;
    const c = toCard(catalogEvent({ quality_score: 90 }))!;
    expect([a, b, c].sort(byQualityThenSoonest)).toEqual([c, b, a]);
  });
});

describe("sprint 4: AI sources aiweb.* (source name, official_site provenance)", () => {
  it("GET /v1/events: aiweb card keeps media with rights official_site and validates against the schema", async () => {
    h.fake.catalog.push(aiwebEvent());
    const res = await get("/v1/events");
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(Value.Check(EventPageSchema, page)).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].media).toEqual({
      url: "https://cdn.iticket.az/event/poster/yulduz-usmonova.jpg",
      width: null,
      height: null,
      ratio: null,
      provenance: { provider: "aiweb.iticket-uz", source_url: AIWEB_URL, fetched_at: "2026-10-10T06:00:00Z", rights: "official_site" },
    });
    expect(page.items[0].price_range).toMatchObject({ min: "250000.00", currency: "UZS", source: { provider: "aiweb.iticket-uz" } });
    expectNoInternal(res.body);
  });

  it("GET /v1/events/{id}: sources[].name and rights are passed through 1:1 from event-catalog", async () => {
    const ev = aiwebEvent({
      media_all: [
        { url: "https://cdn.iticket.az/event/poster/2.jpg", width: 800, height: 450, ratio: "16_9", provenance: { provider: "aiweb.iticket-uz", source_url: AIWEB_URL, fetched_at: "2026-10-10T06:00:00Z", rights: "official_site" } },
      ],
      sources: [
        { provider: "aiweb.iticket-uz", name: "iTicket.uz", tier: "OFFICIAL_TICKET_PROVIDER", url: AIWEB_URL, fetched_at: "2026-10-10T06:00:00Z" },
        { provider: "ticketmaster", name: "Ticketmaster", tier: "OFFICIAL_TICKET_PROVIDER", url: "https://www.ticketmaster.com/event/xyz", fetched_at: "2026-10-09T06:00:00Z" },
      ],
    });
    h.fake.catalog.push(ev);
    const res = await get(`/v1/events/${ev.event_id}`);
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(Value.Check(EventDetailViewSchema, d)).toBe(true);
    const { dedup_keys: _a, external_ids: _b, verdict: _c, internal_note: _d, hidden: _e, ...expected } = ev;
    expect(d).toEqual({ ...expected, recommendation: null, watch: null, reaction: null }); // спринт 6: домены не настроены
    expect(d.sources.map((x: { name: string }) => x.name)).toEqual(["iTicket.uz", "Ticketmaster"]);
    expect(d.media.provenance.rights).toBe("official_site");
    expect(d.media_all[0].provenance.rights).toBe("official_site");
  });

  it("source name from the registry is untrusted: control/bidi chars and HTML brackets stripped, ≤ 120; absent → Ticketmaster or null", async () => {
    expect(sourceName("  iTicket\u0000.uz‮  ", "aiweb.iticket-uz")).toBe("iTicket .uz");
    expect(sourceName("<img src=x onerror=alert(1)>Afisha", "aiweb.afisha-uz")).toBe("img src=x onerror=alert(1)Afisha");
    expect(sourceName("Line1\nLine2 x", "aiweb.a")).toBe("Line1 Line2 x");
    expect(sourceName("x".repeat(500), "aiweb.a")).toHaveLength(120);
    expect(sourceName(null, "ticketmaster")).toBe("Ticketmaster");
    expect(sourceName(undefined, "aiweb.iticket-uz")).toBeNull();
    expect(sourceName(42, "aiweb.iticket-uz")).toBeNull();
    expect(sourceName("\u0000​ ", "aiweb.iticket-uz")).toBeNull();
    // каталог до спринта 4 (без name) — схема ответа всё равно соблюдается
    const legacy = aiwebEvent();
    legacy.sources = legacy.sources.map(({ name: _n, ...rest }) => rest) as typeof legacy.sources;
    legacy.sources.push({ provider: "ticketmaster", tier: "OFFICIAL_TICKET_PROVIDER", url: "https://www.ticketmaster.com/e/1", fetched_at: "2026-10-09T06:00:00Z" } as (typeof legacy.sources)[number]);
    h.fake.catalog.push(legacy);
    const d = (await get(`/v1/events/${legacy.event_id}`)).json();
    expect(Value.Check(EventDetailViewSchema, d)).toBe(true);
    expect(d.sources.map((x: { name: string | null }) => x.name)).toEqual([null, "Ticketmaster"]);
  });

  it("media rights: provider_api / official_organizer / official_site accepted, anything else → null", () => {
    const base = { url: "https://cdn.iticket.az/a.jpg", width: null, height: null, ratio: null };
    const prov = { provider: "aiweb.iticket-uz", source_url: AIWEB_URL, fetched_at: "2026-10-10T06:00:00Z" };
    for (const rights of ["provider_api", "official_organizer", "official_site"]) {
      expect(media({ ...base, provenance: { ...prov, rights } })?.provenance.rights, rights).toBe(rights);
    }
    for (const rights of ["OFFICIAL_SITE", "scraped", "", null, 1]) {
      expect(media({ ...base, provenance: { ...prov, rights } }), String(rights)).toBeNull();
    }
  });

  it("Home rail with an aiweb event keeps official_site provenance (also when re-mapped from the Redis cache)", async () => {
    h.fake.catalog.push(aiwebEvent({ quality_score: 99 }));
    const first = (await get("/v1/home")).json();
    expect(Value.Check(HomeResponseSchema, first)).toBe(true);
    const card = (first.sections as Array<{ key: string; items: Array<{ media: { provenance: { rights: string } } }> }>).find((x) => x.key === "best_for_you")!.items[0]!;
    expect(card.media.provenance.rights).toBe("official_site");
    const again = (await get("/v1/home")).json();
    expect(again).toEqual(first);
  });
});

/** Домены спринта 6 не настроены (HomeService, собранный вручную в тестах выше). */
function sprint6Off() {
  const log = { warn: () => undefined } as never;
  return {
    identity: { get: async () => null } as never,
    recommendations: new RecommendationsService(null, log),
    watch: new WatchService(null, null, log),
    news: new NewsService(null, log),
    lastTrip: { perPerson: async () => new Map(), get: async () => null, save: async () => undefined } as never,
  };
}
