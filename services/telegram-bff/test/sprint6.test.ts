/**
 * Спринт 6 (INTERNAL_API §6): Home (best_for_you через recommendations:rank, watch_changes, news_carousel, сводка AT-23,
 * кэш и сброс), деталь (recommendation, watch), реакции, /v1/watches*, /v1/news*, лимиты, недоверенные ответы доменов.
 * Домены recommendations/watch/news — подделки по контракту (test/helpers.ts).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { boundary } from "../src/home.js";
import { newsItemOf, reasonOf, sanitizeRank } from "../src/personal.js";
import { EventDetailPersonalSchema, HomeResponseSchema, NewsPageSchema, WatchPageSchema, WatchSchema } from "../src/schemas.js";
import {
  SPRINT6_ENV,
  TG_USER,
  bearer,
  catalogEvent,
  changeFixture,
  closeRedis,
  domainError,
  json,
  login,
  makeHarness,
  newsFixture,
  testRedis,
  type Harness,
  type LoggedIn,
} from "./helpers.js";

let h: Harness;
let s: LoggedIn;

async function setup(env: Record<string, string> = {}, opts: { sprint6?: boolean } = {}) {
  h = await makeHarness({ ...(opts.sprint6 === false ? {} : SPRINT6_ENV), ...env });
  s = await login(h);
}
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const get = (url: string, token = s.access) => h.app.inject({ url, headers: bearer(token) });
const send = (method: "POST" | "PATCH" | "DELETE" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}, token = s.access) =>
  h.app.inject({ method, url, headers: { ...bearer(token), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const idem = () => ({ "idempotency-key": crypto.randomUUID() });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sec = (body: any, key: string) => body.sections.find((x: { key: string }) => x.key === key);
const rankCalls = () => h.fake.callsTo("recommendations", "POST", "/internal/v1/recommendations:rank");

async function setPrefs(patch: Record<string, unknown>) {
  const cur = (await get("/v1/profile")).json().preferences;
  h.fake.prefs.set(s.userId, { ...cur, ...patch });
}

/** Каталог: n событий по автоспорту с разным quality. */
function seed(n: number, o: Record<string, unknown> = {}) {
  const evs = Array.from({ length: n }, (_, i) => catalogEvent({ title: `Race ${i}`, quality_score: 50 + i, ...o }));
  h.fake.catalog.push(...evs);
  return evs;
}

// ====================================================================================== Home

describe("Home: best_for_you via recommendations:rank", () => {
  it("cards are ordered by rank and carry recommendation {score, reasons} (no factors); profile and candidates sent", async () => {
    await setup();
    await setPrefs({ interests: { categories: ["sport.motorsport"], entities: ["Formula 1"] }, budget: { currency: "USD", preset: "1000_2000", min: 1000, max: 2000, custom_amount: null } });
    const evs = seed(12);
    const res = await get("/v1/home");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Value.Check(HomeResponseSchema, body)).toBe(true);
    const best = sec(body, "best_for_you");
    expect(best.state).toBe("ready");
    expect(best.items).toHaveLength(10);
    // фейк ранжирует «обратно quality»: первым — наименее значимое событие
    expect(best.items[0].event_id).toBe(evs[0]!.event_id);
    expect(best.items[0].recommendation).toEqual({
      score: 50,
      reasons: [
        { code: "INTEREST_MATCH", params: { category: "sport.motorsport" }, kind: "fact" },
        { code: "HIGH_SIGNIFICANCE", params: {}, kind: "recommendation" },
      ],
    });
    expect(res.body).not.toContain("internal_weight");
    expect(res.body).not.toContain("factors");
    const call = rankCalls()[0]!;
    expect(call.subject).toBe(s.userId);
    const b = call.body as { profile: Record<string, unknown>; candidates: Array<Record<string, unknown>>; limit: number; diversity: boolean; lang: string };
    expect(b.profile).toMatchObject({ categories: ["sport.motorsport"], entities: ["Formula 1"], budget: { min: "1000.00", max: "2000.00" }, formats: ["offline"], horizon_months: 12, has_departure: false });
    expect(b.candidates).toHaveLength(12);
    expect(b.candidates[0]).toMatchObject({ trip_per_person: null });
    // интеграция спринта 6: first_seen_at из списка каталога → кандидат (причина NEW), клиенту не уходит
    expect(b.candidates.every((c) => "first_seen_at" in c)).toBe(true);
    expect(res.body).not.toContain("first_seen_at");
    expect(b).toMatchObject({ limit: 10, diversity: true, lang: "ru" });
  });

  it("trip_per_person — from the user's last complete offers calculation", async () => {
    await setup();
    const [e] = seed(1);
    await send("PUT", "/v1/profile/departures", { airports: ["TAS"] });
    expect((await get(`/v1/events/${e!.event_id}/offers?travellers=2`)).statusCode).toBe(200);
    await get("/v1/home");
    const cand = (rankCalls().at(-1)!.body as { candidates: Array<{ event_id: string; trip_per_person: string | null }> }).candidates;
    // comfort: (85 + 180) * 2 + 520 = 1050 → 525.00 на человека
    expect(cand.find((c) => c.event_id === e!.event_id)!.trip_per_person).toBe("525.00");
  });

  it("rank down / broken → previous order, recommendation null, not cached as fresh", async () => {
    await setup();
    const evs = seed(3);
    h.fake.override("recommendations", "POST", "/internal/v1/recommendations:rank", () => domainError(500, "BOOM"));
    const body = (await get("/v1/home")).json();
    const best = sec(body, "best_for_you");
    expect(best.state).toBe("ready");
    expect(best.items.map((x: { event_id: string }) => x.event_id)).toEqual([evs[2]!.event_id, evs[1]!.event_id, evs[0]!.event_id]);
    expect(best.items.every((x: { recommendation: unknown }) => x.recommendation === null)).toBe(true);
    expect(h.logs.text).toContain("recommendations unavailable, fallback order");
    await get("/v1/home");
    expect(rankCalls()).toHaveLength(2); // деградация не кэшируется
  });

  it.each([
    ["score out of range", (b: { items: any[] }) => ({ items: [{ ...b.items[0], score: 150 }] })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["event not among candidates", (b: { items: any[] }) => ({ items: [{ ...b.items[0], event_id: "6f1c2a7e-3b9d-4c51-9a0e-2d7f81c4b6a1" }] })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["duplicate event", (b: { items: any[] }) => ({ items: [b.items[0], b.items[0]] })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["not an object", () => "<html>"],
    ["factors missing", (b: { items: any[] }) => ({ items: [{ ...b.items[0], factors: undefined }] })], // eslint-disable-line @typescript-eslint/no-explicit-any
  ])("rank response %s → fallback order", async (_name, hook) => {
    await setup();
    seed(2);
    h.fake.rankHook = (_b, honest) => hook(honest);
    const best = sec((await get("/v1/home")).json(), "best_for_you");
    expect(best.items).toHaveLength(2);
    expect(best.items.every((x: { recommendation: unknown }) => x.recommendation === null)).toBe(true);
  });

  it("unknown reason codes and bad params are dropped, ≤ 3 reasons, strings scrubbed", async () => {
    await setup();
    seed(1);
    h.fake.rankHook = (_b, honest) => ({
      items: [
        {
          ...honest.items[0],
          reasons: [
            { code: "FUTURE_CODE", params: {}, kind: "fact" },
            { code: "ENTITY_MATCH", params: { entity: "Formula‮ 1" }, kind: "fact" },
            { code: "NEW", params: { "Bad-Key": 1 }, kind: "fact" },
            { code: "IN_GEOGRAPHY", params: { country: "AE" }, kind: "fact" },
            { code: "SALES_OPEN", params: {}, kind: "fact" },
            { code: "NEW", params: {}, kind: "recommendation" },
          ],
        },
      ],
    });
    const rec = sec((await get("/v1/home")).json(), "best_for_you").items[0].recommendation;
    expect(rec.reasons).toEqual([
      { code: "ENTITY_MATCH", params: { entity: "Formula 1" }, kind: "fact" },
      { code: "IN_GEOGRAPHY", params: { country: "AE" }, kind: "fact" },
      { code: "SALES_OPEN", params: {}, kind: "fact" },
    ]);
  });

  it("recommendations not configured → Home works, recommendation null", async () => {
    await setup({ RECOMMENDATIONS_URL: "" });
    seed(2);
    const best = sec((await get("/v1/home")).json(), "best_for_you");
    expect(best.items).toHaveLength(2);
    expect(best.items[0].recommendation).toBeNull();
  });
});

describe("Home: watch_changes, news_carousel, watch on cards", () => {
  it("watch_changes — latest changes of active watches, newest first; cards get watch {watch_id, status} | null", async () => {
    await setup();
    const [a, b, c] = seed(3);
    const w1 = h.fake.addWatch(s.userId, a!.event_id, {}, [changeFixture({ detected_at: "2026-10-11T06:00:00Z" })]);
    const w2 = h.fake.addWatch(s.userId, b!.event_id, {}, [changeFixture({ type: "lifecycle", severity: "critical", before: "ON_SALE", after: "POSTPONED", delta_usd: null, delta_pct: null, detected_at: "2026-10-11T09:00:00Z" })]);
    h.fake.addWatch(s.userId, c!.event_id); // без изменений — не на табло
    // чужое слежение не видно
    h.fake.addWatch("99999999-2222-4333-8444-000000000001", c!.event_id, {}, [changeFixture()]);
    const body = (await get("/v1/home")).json();
    expect(Value.Check(HomeResponseSchema, body)).toBe(true);
    const ch = sec(body, "watch");
    expect(ch.state).toBe("ready");
    expect(ch.items.map((x: { watch_id: string }) => x.watch_id)).toEqual([w2, w1]);
    expect(ch.items[0]).toMatchObject({ event_id: b!.event_id, status: "active", change: { type: "lifecycle", after: "POSTPONED", severity: "critical" } });
    const cards = sec(body, "best_for_you").items;
    expect(cards.find((x: { event_id: string }) => x.event_id === a!.event_id).watch).toEqual({ watch_id: w1, status: "active" });
    expect(cards.find((x: { event_id: string }) => x.event_id === c!.event_id).watch).toMatchObject({ status: "active" });
    const byEvents = h.fake.callsTo("watch", "GET", "/internal/v1/watches:by-events");
    expect(byEvents).toHaveLength(1);
    expect(byEvents[0]!.subject).toBe(s.userId);
  });

  it("news_carousel — news:feed limit 10 with profile interests, watched events and news settings; bad items dropped", async () => {
    await setup();
    await setPrefs({ interests: { categories: ["sport.motorsport"], entities: ["Formula 1"] } });
    const [a] = seed(1);
    h.fake.addWatch(s.userId, a!.event_id);
    h.fake.newsPrefs.set(s.userId, { from_watch: true, by_interests: true, only_significant: true, digest: false });
    const good = newsFixture({ event_ids: [a!.event_id], link: { type: "watch", label: "Race 0" } });
    h.fake.newsItems.push(
      good,
      newsFixture({ source: { name: "X", domain: "formula1.com", url: "http://www.formula1.com/a" } }), // не https
      newsFixture({ source: { name: "X", domain: "formula1.com", url: "https://evil.example/formula1.com" } }), // чужой домен
      newsFixture({ source: { name: "X", domain: "formula1.com", url: "javascript:alert(1)" } }),
      newsFixture({ title: "" }),
      newsFixture({ significance: "urgent" }),
      { ...newsFixture(), source: undefined },
    );
    const body = (await get("/v1/home")).json();
    const news = sec(body, "news");
    expect(news.state).toBe("ready");
    expect(news.items).toEqual([good]);
    const feed = h.fake.callsTo("news", "POST", "/internal/v1/news:feed")[0]!;
    expect(feed.body).toEqual({
      interests: ["sport.motorsport"],
      entities: ["Formula 1"],
      watched_event_ids: [a!.event_id],
      only_significant: true,
      filter: "all",
      geographies: [],
      cursor: null,
      limit: 10,
      lang: "ru",
      digest_time: "09:00",
      timezone: "Asia/Tashkent",
    });
    expect(h.logs.text).toContain("news items dropped");
  });

  it("watch/news down → sections from stale copy or unavailable; not configured → pending_data; HTTP 200", async () => {
    await setup({ HOME_CACHE_SECONDS: "0" });
    const [a] = seed(1);
    h.fake.addWatch(s.userId, a!.event_id, {}, [changeFixture()]);
    h.fake.newsItems.push(newsFixture());
    const first = (await get("/v1/home")).json();
    expect(sec(first, "watch").items).toHaveLength(1);
    h.fake.down.add("watch");
    h.fake.down.add("news");
    const res = await get("/v1/home");
    expect(res.statusCode).toBe(200);
    const stale = res.json();
    expect(sec(stale, "watch")).toMatchObject({ state: "stale" });
    expect(sec(stale, "watch").items).toHaveLength(1);
    expect(sec(stale, "news")).toMatchObject({ state: "stale" });
    expect(sec(stale, "best_for_you").items[0].watch).toBeNull(); // by-events недоступен
    await h.close();

    await setup({ WATCH_URL: "", NEWS_URL: "" });
    seed(1);
    const off = (await get("/v1/home")).json();
    expect(sec(off, "watch")).toMatchObject({ state: "pending_data", items: [] });
    expect(sec(off, "news")).toMatchObject({ state: "pending_data", items: [] });
    expect(sec(off, "best_for_you").items[0].watch).toBeUndefined();
    expect(h.fake.callsTo("watch")).toHaveLength(0);
  });

  it("Home cache: fresh copy skips domains; invalidated by watch create/patch/delete and reactions", async () => {
    await setup();
    const [a] = seed(2);
    await get("/v1/home");
    await get("/v1/home");
    expect(rankCalls()).toHaveLength(1);
    expect(h.fake.callsTo("news", "POST", "/internal/v1/news:feed")).toHaveLength(1);
    const created = await send("POST", "/v1/watches", { event_id: a!.event_id }, idem());
    expect(created.statusCode).toBe(201);
    const after = (await get("/v1/home")).json();
    expect(rankCalls()).toHaveLength(2);
    expect(sec(after, "best_for_you").items.find((x: { event_id: string }) => x.event_id === a!.event_id).watch).toEqual({ watch_id: created.json().watch_id, status: "active" });
    await send("PATCH", `/v1/watches/${created.json().watch_id}`, { status: "paused", expected_version: 1 });
    await get("/v1/home");
    expect(rankCalls()).toHaveLength(3);
    await send("POST", "/v1/recommendations/reactions", { event_id: a!.event_id, reaction: "less" });
    const afterLess = (await get("/v1/home")).json();
    expect(rankCalls()).toHaveLength(4);
    // «Не интересно» на событие — сервис рекомендаций исключает его
    expect(sec(afterLess, "best_for_you").items.map((x: { event_id: string }) => x.event_id)).not.toContain(a!.event_id);
    await send("DELETE", `/v1/watches/${created.json().watch_id}`);
    await get("/v1/home");
    expect(rankCalls()).toHaveLength(5);
  });
});

// ====================================================================================== AT-23

describe("AT-23: summary «while you were away»", () => {
  const visitKey = () => `${h.config.redisKeyPrefix}visit:${s.userId}`;
  const ago = (min: number) => String(Date.now() - min * 60_000);

  it("first visit → null; < 30 min → null; ≥ 30 min → summary with since; repeated within hold → same; after hold → null", async () => {
    await setup();
    expect((await get("/v1/home")).json().summary).toBeNull();
    expect((await get("/v1/home")).json().summary).toBeNull();
    expect(await testRedis().ttl(visitKey())).toBeGreaterThan(89 * 86_400);
    await testRedis().hset(visitKey(), "seen", ago(29));
    expect((await get("/v1/home")).json().summary).toBeNull();
    const seen = ago(120);
    await testRedis().hset(visitKey(), "seen", seen);
    const body = (await get("/v1/home")).json();
    expect(Value.Check(HomeResponseSchema, body)).toBe(true);
    expect(body.summary).toEqual({ since: new Date(Number(seen)).toISOString(), new_events: 0, price_drops: 0, sales_opened: 0, critical: 0 });
    expect((await get("/v1/home")).json().summary).toEqual(body.summary); // перерисовка в пределах визита
    await testRedis().hset(visitKey(), "started", ago(11));
    expect((await get("/v1/home")).json().summary).toBeNull();
  });

  it("new_events (profile, first_seen_at > since, via detail when list lacks it), price_drops/critical (watch summary), sales_opened", async () => {
    await setup();
    await setPrefs({ interests: { categories: ["sport.motorsport"], entities: [] } });
    const since = Date.now() - 3 * 3600_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    // 3 новых, 4 старых по автоспорту; 1 новое — не по профилю
    const fresh = [1, 2, 3].map((i) => catalogEvent({ title: `New ${i}`, first_seen_at: iso(since + i * 60_000) }));
    const old = [1, 2, 3, 4].map((i) => catalogEvent({ title: `Old ${i}`, first_seen_at: iso(since - i * 3600_000) }));
    const other = catalogEvent({ categories: ["music.concerts"], first_seen_at: iso(since + 60_000) });
    // продажи открылись: по изменению watch и по каталогу (watch ещё не перепроверил)
    const openedByWatch = catalogEvent({ first_seen_at: iso(since - 86_400_000) });
    const openedInCatalog = catalogEvent({
      first_seen_at: iso(since - 86_400_000),
      lifecycle: { status: "ON_SALE", changed_at: iso(since + 600_000), basis: { fact: "x", source_url: null, provider: "ticketmaster", observed_at: iso(since) } },
    });
    h.fake.catalog.push(...fresh, ...old, other, openedByWatch, openedInCatalog);
    h.fake.addWatch(s.userId, openedByWatch.event_id, {}, [
      changeFixture({ type: "lifecycle", severity: "normal", before: "SALES_SOON", after: "ON_SALE", delta_usd: null, delta_pct: null, detected_at: iso(since + 60_000) }),
    ]);
    h.fake.addWatch(s.userId, openedInCatalog.event_id, { last_snapshot: null }, []);
    const w3 = h.fake.addWatch(s.userId, old[0]!.event_id, {}, [
      changeFixture({ type: "price_drop", detected_at: iso(since + 120_000) }),
      changeFixture({ type: "lifecycle", severity: "critical", after: "POSTPONED", before: "ON_SALE", delta_usd: null, delta_pct: null, detected_at: iso(since + 180_000) }),
      changeFixture({ type: "price_drop", detected_at: iso(since - 60_000) }), // до визита
    ]);
    expect(w3).toBeTruthy();
    await testRedis().hset(`${h.config.redisKeyPrefix}visit:${s.userId}`, "seen", String(since));
    const body = (await get("/v1/home")).json();
    expect(body.summary).toEqual({ since: iso(since), new_events: 3, price_drops: 1, sales_opened: 2, critical: 1 });
    const newest = h.fake.callsTo("events", "GET", "/internal/v1/events").filter((c) => c.query.sort === "newest");
    expect(newest[0]!.query).toMatchObject({ category: "sport.motorsport", first_seen_from: iso(since), limit: "50" });
    // двоичный поиск по детали: не больше ~log2(n)+2 запросов детали на список
    expect(h.fake.callsTo("events").filter((c) => /^\/internal\/v1\/events\/[0-9a-f-]+$/.test(c.path)).length).toBeLessThanOrEqual(8);
  });

  it("catalog that supports first_seen_from/first_seen_at in the list — counted without detail calls", async () => {
    await setup();
    const since = Date.now() - 3600_000;
    const evs = [1, 2].map((i) => catalogEvent({ first_seen_at: new Date(since + i * 1000).toISOString() }));
    h.fake.catalog.push(...evs);
    h.fake.override("events", "GET", "/internal/v1/events", (r) => {
      if (r.query.sort !== "newest") return json(200, { items: [], next_cursor: null });
      expect(r.query.first_seen_from).toBe(new Date(since).toISOString());
      return json(200, { items: evs.map((e) => ({ ...e, first_seen_at: e.first_seen_at })), next_cursor: null });
    });
    await testRedis().hset(`${h.config.redisKeyPrefix}visit:${s.userId}`, "seen", String(since));
    expect((await get("/v1/home")).json().summary.new_events).toBe(2);
    expect(h.fake.callsTo("events").filter((c) => /^\/internal\/v1\/events\/[0-9a-f-]+$/.test(c.path))).toHaveLength(0);
  });

  it("watch down → watch parts null (not 0), summary still returned; Redis key of last visit is per user", async () => {
    await setup();
    h.fake.down.add("watch");
    await testRedis().hset(`${h.config.redisKeyPrefix}visit:${s.userId}`, "seen", String(Date.now() - 7200_000));
    const res = await get("/v1/home");
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toMatchObject({ new_events: 0, price_drops: null, critical: null, sales_opened: null });
    expect(Value.Check(HomeResponseSchema, res.json())).toBe(true);
    expect(h.logs.text).toContain("home summary part unavailable");
    const other = await login(h, { ...TG_USER, id: 900777, username: "other" });
    expect((await get("/v1/home", other.access)).json().summary).toBeNull();
  });

  it("boundary(): prefix length of a monotone predicate in O(log n)", async () => {
    for (const [n, k] of [[0, 0], [1, 0], [1, 1], [50, 0], [50, 50], [50, 17], [7, 6], [2, 1]] as const) {
      let calls = 0;
      expect(await boundary(n, async (i) => (calls++, i < k))).toBe(k);
      expect(calls).toBeLessThanOrEqual(2 + Math.ceil(Math.log2(Math.max(n, 2))));
    }
  });
});

// ====================================================================================== деталь события

describe("GET /v1/events/{id}: recommendation and watch", () => {
  it("recommendation with factors (rank of one) and watch {watch_id, status}", async () => {
    await setup();
    const [e] = seed(1);
    const wid = h.fake.addWatch(s.userId, e!.event_id, { status: "paused" });
    const res = await get(`/v1/events/${e!.event_id}`);
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(Value.Check(EventDetailPersonalSchema, d)).toBe(true);
    expect(d.recommendation).toEqual({
      score: 50,
      reasons: [
        { code: "INTEREST_MATCH", params: { category: "sport.motorsport" }, kind: "fact" },
        { code: "HIGH_SIGNIFICANCE", params: {}, kind: "recommendation" },
      ],
      factors: { interests: 80, geography: 50, budget: null, significance: 50, freshness: 40, feedback: 0 },
    });
    expect(d.watch).toEqual({ watch_id: wid, status: "paused" });
    const call = rankCalls()[0]!.body as { candidates: unknown[]; limit: number; diversity: boolean };
    expect(call).toMatchObject({ limit: 1, diversity: false });
    expect(call.candidates).toHaveLength(1);
    expect(call.candidates[0]).toMatchObject({ first_seen_at: e!.first_seen_at }); // причина NEW (интеграция)
  });

  it("rank/watch down → recommendation null, watch null; event still 200", async () => {
    await setup();
    const [e] = seed(1);
    h.fake.down.add("recommendations");
    h.fake.down.add("watch");
    const res = await get(`/v1/events/${e!.event_id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ recommendation: null, watch: null, title: e!.title });
  });

  it("event excluded by «less» → recommendation null; other user's watch is not shown", async () => {
    await setup();
    const [e] = seed(1);
    h.fake.reactions.set(`${s.userId}:${e!.event_id}`, { reaction: "less", categories: [] });
    h.fake.addWatch("99999999-2222-4333-8444-000000000002", e!.event_id);
    expect((await get(`/v1/events/${e!.event_id}`)).json()).toMatchObject({ recommendation: null, watch: null });
  });
});

// ====================================================================================== реакции

describe("POST /v1/recommendations/reactions", () => {
  it("204; categories from the catalog; undo; idempotent", async () => {
    await setup();
    const [e] = seed(1);
    const r1 = await send("POST", "/v1/recommendations/reactions", { event_id: e!.event_id.toUpperCase(), reaction: "more" });
    expect(r1.statusCode).toBe(204);
    expect(r1.body).toBe("");
    const call = h.fake.callsTo("recommendations", "POST", "/internal/v1/reactions")[0]!;
    expect(call.subject).toBe(s.userId);
    expect(call.body).toEqual({ event_id: e!.event_id, categories: ["sport.motorsport", "sport"], reaction: "more", undo: false });
    expect((await send("POST", "/v1/recommendations/reactions", { event_id: e!.event_id, reaction: "more" })).statusCode).toBe(204);
    expect((await send("POST", "/v1/recommendations/reactions", { event_id: e!.event_id, reaction: "more", undo: true })).statusCode).toBe(204);
    expect(h.fake.reactions.size).toBe(0);
  });

  it("401 / 404 / 422 / 503 FEATURE_UNAVAILABLE", async () => {
    await setup();
    const [e] = seed(1);
    expect((await h.app.inject({ method: "POST", url: "/v1/recommendations/reactions", payload: { event_id: e!.event_id, reaction: "more" } })).statusCode).toBe(401);
    const nf = await send("POST", "/v1/recommendations/reactions", { event_id: "6f1c2a7e-3b9d-4c51-9a0e-2d7f81c4b6a1", reaction: "less" });
    expect([nf.statusCode, nf.json().code]).toEqual([404, "EVENT_NOT_FOUND"]);
    for (const bad of [{ event_id: e!.event_id, reaction: "love" }, { event_id: "x", reaction: "more" }, { event_id: e!.event_id, reaction: "more", user_id: s.userId }, {}]) {
      const r = await send("POST", "/v1/recommendations/reactions", bad);
      expect([r.statusCode, r.json().code]).toEqual([422, "VALIDATION_ERROR"]);
    }
    expect(h.fake.callsTo("recommendations", "POST", "/internal/v1/reactions")).toHaveLength(0);
    await h.close();
    await setup({ RECOMMENDATIONS_URL: "" });
    const [e2] = seed(1);
    const off = await send("POST", "/v1/recommendations/reactions", { event_id: e2!.event_id, reaction: "more" });
    expect([off.statusCode, off.json().code, off.json().details]).toEqual([503, "FEATURE_UNAVAILABLE", { feature: "recommendations" }]);
  });

  it("rate limit: RATE_LIMIT_REACTIONS_PER_MIN → 429 RATE_LIMITED", async () => {
    await setup({ RATE_LIMIT_REACTIONS_PER_MIN: "2" });
    const [e] = seed(1);
    for (let i = 0; i < 2; i++) expect((await send("POST", "/v1/recommendations/reactions", { event_id: e!.event_id, reaction: "more" })).statusCode).toBe(204);
    const r = await send("POST", "/v1/recommendations/reactions", { event_id: e!.event_id, reaction: "more" });
    expect([r.statusCode, r.json().code]).toEqual([429, "RATE_LIMITED"]);
    expect(r.headers["retry-after"]).toBeTruthy();
  });
});

// ====================================================================================== слежения

describe("/v1/watches", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createCalls = () => h.fake.callsTo("watch", "POST", "/internal/v1/watches") as Array<{ body: any; headers: Record<string, string>; subject?: string }>;

  it("POST: offer_params from the last offers calculation + profile; 201 then 200 for the same event; Watch per contract", async () => {
    await setup();
    const [e] = seed(1);
    await send("PUT", "/v1/profile/departures", { airports: ["TAS", "SKD"] });
    await setPrefs({ budget: { currency: "USD", preset: "custom", min: null, max: null, custom_amount: 1500 } });
    const rc = await send("POST", `/v1/events/${e!.event_id}/offers/recalculate`, { travellers: 3, departure_iata: "SKD", direct_only: true, near_venue: true, extra_nights: 2, hotel_id: "lp2" });
    expect(rc.statusCode).toBe(200);
    const key = idem();
    const res = await send("POST", "/v1/watches", { event_id: e!.event_id, threshold_pct: 5, dimensions: { news: false } }, key);
    expect(res.statusCode).toBe(201);
    const w = res.json();
    expect(Value.Check(WatchSchema, w)).toBe(true);
    expect(w).toMatchObject({ event_id: e!.event_id, event_title: e!.title, status: "active", tier: "comfort", travellers: 3, threshold_pct: 5, version: 1 });
    expect(w.dimensions.news).toBe(false);
    expect(w.event).toMatchObject({ event_id: e!.event_id, title: e!.title, venue: { name: "Yas Marina Circuit", city: "Abu Dhabi", country_code: "AE" } });
    expect(w.last_snapshot?.ticket_status).toBe("on_sale"); // интеграция спринта 6: ticket_status — в контракте WatchSnapshot
    expect(res.body).not.toContain("offer_params");
    expect(res.body).not.toContain("user_id");
    const c = createCalls()[0]!;
    expect(c.subject).toBe(s.userId);
    expect(c.headers["idempotency-key"]).toBe(key["idempotency-key"]);
    expect(c.body).toEqual({
      event_id: e!.event_id,
      offer_params: {
        tier: "comfort",
        travellers: 3,
        departure_iata: "SKD",
        direct_only: true,
        near_venue: true,
        extra_nights: 2,
        hotel_id: "lp2",
        budget: { min: null, max: "1500.00" },
        departures: [
          { airport_iata: "TAS", city: "Tashkent", country_code: "UZ" },
          { airport_iata: "SKD", city: "Samarkand", country_code: "UZ" },
        ],
        flight_prefs: { direct: true, connecting: true, alternative_departure: true },
      },
      dimensions: { news: false },
      threshold_pct: 5,
    });
    const again = await send("POST", "/v1/watches", { event_id: e!.event_id }, idem());
    expect([again.statusCode, again.json().watch_id]).toEqual([200, w.watch_id]);
  });

  it("POST without a calculation → comfort, 1 traveller; explicit tier/travellers win", async () => {
    await setup();
    const [a, b] = seed(2);
    await send("POST", "/v1/watches", { event_id: a!.event_id }, idem());
    expect(createCalls()[0]!.body.offer_params).toMatchObject({ tier: "comfort", travellers: 1, departure_iata: null, direct_only: false, near_venue: false, extra_nights: 0, hotel_id: null, budget: null, departures: [] });
    await send("POST", "/v1/watches", { event_id: b!.event_id, tier: "premium", travellers: 4 }, idem());
    expect(createCalls()[1]!.body.offer_params).toMatchObject({ tier: "premium", travellers: 4 });
  });

  it("POST errors: 401, 422 IDEMPOTENCY_KEY_REQUIRED / VALIDATION_ERROR, 404 EVENT_NOT_FOUND, 422 EVENT_PAST, 409 WATCH_LIMIT", async () => {
    await setup();
    const [a, b] = seed(2);
    const past = catalogEvent({ is_past: true });
    h.fake.catalog.push(past);
    expect((await h.app.inject({ method: "POST", url: "/v1/watches", payload: { event_id: a!.event_id }, headers: idem() })).statusCode).toBe(401);
    const noKey = await send("POST", "/v1/watches", { event_id: a!.event_id });
    expect([noKey.statusCode, noKey.json().code]).toEqual([422, "IDEMPOTENCY_KEY_REQUIRED"]);
    for (const bad of [{ event_id: a!.event_id, threshold_pct: 7 }, { event_id: a!.event_id, travellers: 9 }, { event_id: a!.event_id, offer_params: {} }, { event_id: a!.event_id, dimensions: { radar: true } }]) {
      const r = await send("POST", "/v1/watches", bad, idem());
      expect([r.statusCode, r.json().code]).toEqual([422, "VALIDATION_ERROR"]);
    }
    const nf = await send("POST", "/v1/watches", { event_id: "6f1c2a7e-3b9d-4c51-9a0e-2d7f81c4b6a1" }, idem());
    expect([nf.statusCode, nf.json().code]).toEqual([404, "EVENT_NOT_FOUND"]);
    const p = await send("POST", "/v1/watches", { event_id: past.event_id }, idem());
    expect([p.statusCode, p.json().code]).toEqual([422, "EVENT_PAST"]);
    h.fake.watchLimit = 1;
    expect((await send("POST", "/v1/watches", { event_id: a!.event_id }, idem())).statusCode).toBe(201);
    const lim = await send("POST", "/v1/watches", { event_id: b!.event_id }, idem());
    expect([lim.statusCode, lim.json().code, lim.json().details]).toEqual([409, "WATCH_LIMIT", { limit: 1 }]);
    expect(lim.body).not.toContain("domain says");
  });

  it("AuthZ: someone else's watch → 404 WATCH_NOT_FOUND for GET/PATCH/DELETE/changes; non-UUID → 404", async () => {
    await setup();
    const [e] = seed(1);
    const foreign = h.fake.addWatch("99999999-2222-4333-8444-000000000003", e!.event_id, {}, [changeFixture()]);
    for (const [method, url, body] of [
      ["GET", `/v1/watches/${foreign}`, undefined],
      ["PATCH", `/v1/watches/${foreign}`, { status: "paused", expected_version: 1 }],
      ["DELETE", `/v1/watches/${foreign}`, undefined],
      ["GET", `/v1/watches/${foreign}/changes`, undefined],
      ["GET", "/v1/watches/not-a-uuid", undefined],
      ["DELETE", "/v1/watches/not-a-uuid", undefined],
    ] as const) {
      const r = method === "GET" ? await get(url) : await send(method, url, body);
      expect([method, url, r.statusCode, r.json().code]).toEqual([method, url, 404, "WATCH_NOT_FOUND"]);
    }
    expect(h.fake.watches.get(foreign)!.w.status).toBe("active");
    expect((await get("/v1/watches")).json().items).toEqual([]);
  });

  it("GET list/one, PATCH (pause, 409 VERSION_CONFLICT), changes (bad items dropped), DELETE 204", async () => {
    await setup();
    const [e] = seed(1);
    const good = changeFixture();
    const id = h.fake.addWatch(s.userId, e!.event_id, {}, [
      good,
      changeFixture({ source: { provider: "offers", url: "http://insecure.example/x", observed_at: "2026-10-11T06:00:00Z" } }),
      changeFixture({ type: "teleport" }),
      changeFixture({ delta_usd: "lots" }),
    ]);
    const list = await get("/v1/watches?status=active");
    expect(Value.Check(WatchPageSchema, list.json())).toBe(true);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({ watch_id: id, event: { event_id: e!.event_id }, last_change: { change_id: good.change_id } });
    expect(h.fake.callsTo("watch", "GET", "/internal/v1/watches")[0]!.query).toMatchObject({ status: "active", limit: "20" });
    const one = await get(`/v1/watches/${id.toUpperCase()}`);
    expect([one.statusCode, one.json().watch_id]).toEqual([200, id]);
    expect(one.body).not.toContain("history");
    const conflict = await send("PATCH", `/v1/watches/${id}`, { status: "paused", expected_version: 7 });
    expect([conflict.statusCode, conflict.json().code, conflict.json().details]).toEqual([409, "VERSION_CONFLICT", { current_version: 1 }]);
    const paused = await send("PATCH", `/v1/watches/${id}`, { status: "paused", threshold_pct: 15, expected_version: 1 });
    expect(paused.json()).toMatchObject({ status: "paused", threshold_pct: 15, version: 2 });
    for (const bad of [{ status: "ended", expected_version: 2 }, { status: "paused" }, { threshold_pct: 15, expected_version: 2, owner: "x" }]) {
      expect((await send("PATCH", `/v1/watches/${id}`, bad)).statusCode).toBe(422);
    }
    const ch = await get(`/v1/watches/${id}/changes`);
    expect(ch.json()).toEqual({ items: [good], next_cursor: null });
    expect(h.logs.text).toContain("watch items dropped (schema)");
    const del = await send("DELETE", `/v1/watches/${id}`);
    expect([del.statusCode, del.body]).toEqual([204, ""]);
    expect((await get(`/v1/watches/${id}`)).statusCode).toBe(404);
  });

  it("watch answers garbage → 503 UPSTREAM_UNAVAILABLE (single), list drops broken items", async () => {
    await setup();
    const [e] = seed(1);
    const id = h.fake.addWatch(s.userId, e!.event_id, { threshold_pct: 12 });
    h.fake.addWatch(s.userId, e!.event_id);
    const one = await get(`/v1/watches/${id}`);
    expect([one.statusCode, one.json().code]).toEqual([503, "UPSTREAM_UNAVAILABLE"]);
    expect((await get("/v1/watches")).json().items).toHaveLength(1);
    h.fake.override("watch", "GET", "/internal/v1/watches", () => json(200, { items: "nope" }));
    expect((await get("/v1/watches")).statusCode).toBe(503);
  });

  it("ended with EVENT_REMOVED (event gone from the catalogue) passes the schema — list and single", async () => {
    await setup();
    const [e] = seed(1);
    const id = h.fake.addWatch(s.userId, e!.event_id, { status: "ended", ended_reason: "EVENT_REMOVED", next_check_at: null });
    const one = await get(`/v1/watches/${id}`);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ status: "ended", ended_reason: "EVENT_REMOVED" });
    const list = await get("/v1/watches?status=ended");
    expect(list.json().items.map((w: { watch_id: string }) => w.watch_id)).toContain(id);
  });

  it("rate limit: RATE_LIMIT_WATCH_PER_MIN for create/patch/delete → 429", async () => {
    await setup({ RATE_LIMIT_WATCH_PER_MIN: "2" });
    const [a, b, c] = seed(3);
    expect((await send("POST", "/v1/watches", { event_id: a!.event_id }, idem())).statusCode).toBe(201);
    expect((await send("POST", "/v1/watches", { event_id: b!.event_id }, idem())).statusCode).toBe(201);
    const r = await send("POST", "/v1/watches", { event_id: c!.event_id }, idem());
    expect([r.statusCode, r.json().code]).toEqual([429, "RATE_LIMITED"]);
    expect((await get("/v1/watches")).statusCode).toBe(200); // чтение — без этого лимита
  });

  it("not configured → 503 FEATURE_UNAVAILABLE for /v1/watches* and /v1/news*", async () => {
    await setup({}, { sprint6: false });
    const [e] = seed(1);
    const id = "6f1c2a7e-3b9d-4c51-9a0e-2d7f81c4b6a1";
    const calls = [
      await send("POST", "/v1/watches", { event_id: e!.event_id }, idem()),
      await get("/v1/watches"),
      await get(`/v1/watches/${id}`),
      await send("PATCH", `/v1/watches/${id}`, { status: "paused", expected_version: 1 }),
      await send("DELETE", `/v1/watches/${id}`),
      await get(`/v1/watches/${id}/changes`),
      await get("/v1/news"),
      await get("/v1/news/preferences"),
      await send("PATCH", "/v1/news/preferences", { digest: false }),
    ];
    for (const r of calls) expect([r.statusCode, r.json().code]).toEqual([503, "FEATURE_UNAVAILABLE"]);
    expect(calls[0]!.json().details).toEqual({ feature: "watch" });
    expect(calls[6]!.json().details).toEqual({ feature: "news" });
    // Home и деталь работают
    expect((await get("/v1/home")).statusCode).toBe(200);
    expect((await get(`/v1/events/${e!.event_id}`)).json()).toMatchObject({ recommendation: null, watch: null });
  });
});

// ====================================================================================== новости

describe("/v1/news", () => {
  it("GET: filter, cursor, limit; profile interests; from_watch=false → no watched ids; by_interests=false → no interests", async () => {
    await setup();
    await setPrefs({ interests: { categories: ["sport.motorsport", "BAD CODE"], entities: ["Formula 1", "\u0000"] } });
    const [e] = seed(1);
    h.fake.addWatch(s.userId, e!.event_id);
    h.fake.newsItems.push(newsFixture(), newsFixture({ kind: "event_update", source: { name: "Ticketmaster", domain: "ticketmaster.com", url: "https://www.ticketmaster.com/event/abc" }, link: null }));
    h.fake.newsCursor = "c2";
    const res = await get("/v1/news?filter=watch&limit=5&cursor=c1");
    expect(res.statusCode).toBe(200);
    expect(Value.Check(NewsPageSchema, res.json())).toBe(true);
    expect(res.json().items).toHaveLength(2);
    expect(res.json().next_cursor).toBe("c2");
    expect(h.fake.callsTo("news", "POST", "/internal/v1/news:feed")[0]!.body).toEqual({
      interests: ["sport.motorsport"],
      entities: ["Formula 1"],
      watched_event_ids: [e!.event_id],
      only_significant: false,
      filter: "watch",
      geographies: [],
      cursor: "c1",
      limit: 5,
      lang: "ru",
      digest_time: "09:00",
      timezone: "Asia/Tashkent",
    });
    h.fake.newsPrefs.set(s.userId, { from_watch: false, by_interests: false, only_significant: true, digest: true });
    await get("/v1/news");
    expect(h.fake.callsTo("news", "POST", "/internal/v1/news:feed")[1]!.body).toMatchObject({ interests: [], entities: [], watched_event_ids: [], only_significant: true, filter: "all", limit: 20 });
    for (const bad of ["/v1/news?filter=hot", "/v1/news?limit=500", "/v1/news?user_id=x"]) expect((await get(bad)).statusCode).toBe(422);
    expect((await h.app.inject({ url: "/v1/news" })).statusCode).toBe(401);
  });

  it("digest_time/timezone from identity notification settings; garbage or identity down → not sent", async () => {
    await setup();
    h.fake.user(s.userId).settings = { enabled: true, quiet_hours: null, digest_time: "21:30", timezone: "Europe/Istanbul" };
    await get("/v1/news");
    expect(h.fake.callsTo("news", "POST", "/internal/v1/news:feed")[0]!.body).toMatchObject({ digest_time: "21:30", timezone: "Europe/Istanbul", lang: "ru" });
    h.fake.user(s.userId).settings = { enabled: true, quiet_hours: null, digest_time: "25:99", timezone: "Mars/Olympus" };
    await get("/v1/news");
    const b2 = h.fake.callsTo("news", "POST", "/internal/v1/news:feed")[1]!.body as Record<string, unknown>;
    expect(b2).not.toHaveProperty("digest_time");
    expect(b2).not.toHaveProperty("timezone");
    h.fake.down.add("identity");
    expect((await get("/v1/news")).statusCode).toBe(200);
    const b3 = h.fake.callsTo("news", "POST", "/internal/v1/news:feed").at(-1)!.body as Record<string, unknown>;
    expect(b3).toMatchObject({ lang: "ru" });
    expect(b3).not.toHaveProperty("digest_time");
    expect(b3).not.toHaveProperty("timezone");
  });

  it("preferences: GET (internal fields dropped), PATCH merges and PUTs full object; 422 on empty/extra", async () => {
    await setup();
    const g = await get("/v1/news/preferences");
    expect(g.json()).toEqual({ from_watch: true, by_interests: true, only_significant: false, digest: true });
    expect(g.body).not.toContain("user_id");
    const p = await send("PATCH", "/v1/news/preferences", { only_significant: true });
    expect(p.json()).toEqual({ from_watch: true, by_interests: true, only_significant: true, digest: true });
    expect(h.fake.callsTo("news", "PUT", "/internal/v1/news/preferences")[0]!.body).toEqual({ from_watch: true, by_interests: true, only_significant: true, digest: true });
    for (const bad of [{}, { digest: "yes" }, { digest: true, user_id: s.userId }]) expect((await send("PATCH", "/v1/news/preferences", bad)).statusCode).toBe(422);
    h.fake.override("news", "GET", "/internal/v1/news/preferences", () => json(200, { from_watch: "maybe" }));
    expect((await get("/v1/news/preferences")).statusCode).toBe(503);
  });
});

// ====================================================================================== единицы

describe("units: untrusted domain data", () => {
  it("newsItemOf: https on source domain or subdomain only", () => {
    const base = newsFixture();
    expect(newsItemOf(base)).not.toBeNull();
    expect(newsItemOf({ ...base, source: { name: "F1", domain: "formula1.com", url: "https://formula1.com/x" } })).not.toBeNull();
    expect(newsItemOf({ ...base, source: { name: "F1", domain: "formula1.com", url: "https://notformula1.com/x" } })).toBeNull();
    expect(newsItemOf({ ...base, source: { name: "F1", domain: "formula1.com", url: "https://user:pw@formula1.com/x" } })).toBeNull();
    expect(newsItemOf({ ...base, event_ids: Array.from({ length: 6 }, () => crypto.randomUUID()) })).toBeNull();
    expect(newsItemOf({ ...base, title: "x".repeat(301) })).toBeNull();
    expect(newsItemOf({ ...base, extra: "<script>" })).not.toHaveProperty("extra");
  });

  it("reasonOf / sanitizeRank", () => {
    expect(reasonOf({ code: "NEW", params: {}, kind: "fact" })).toEqual({ code: "NEW", params: {}, kind: "fact" });
    expect(reasonOf({ code: "NEW", params: {}, kind: "opinion" })).toBeNull();
    expect(reasonOf({ code: "NEW", params: { a: { nested: 1 } }, kind: "fact" })).toBeNull();
    expect(reasonOf({ code: "NEW", params: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i])), kind: "fact" })).toBeNull();
    const id = "6f1c2a7e-3b9d-4c51-9a0e-2d7f81c4b6a1";
    const item = { event_id: id, score: 77.77, bucket: "sport", reasons: [], factors: { interests: 1, geography: 2, budget: null, significance: 3, freshness: 4, feedback: -20 } };
    expect(sanitizeRank({ items: [item] }, new Set([id]), true)).toEqual([{ event_id: id, recommendation: { score: 77.8, reasons: [], factors: item.factors } }]);
    expect(() => sanitizeRank({ items: [{ ...item, factors: { ...item.factors, interests: 101 } }] }, new Set([id]), false)).toThrow();
    expect(() => sanitizeRank({ items: [] , extra: 1 }, new Set([id]), false)).not.toThrow();
  });
});

// ====================================================================================== ревью спринта 6

describe("review: watch on catalog cards (M1)", () => {
  it("GET /v1/events: cards += watch {watch_id, status} | null via one by-events call", async () => {
    await setup();
    const [a, b] = seed(2);
    const wid = h.fake.addWatch(s.userId, a!.event_id, { status: "paused" });
    h.fake.addWatch("99999999-2222-4333-8444-000000000004", b!.event_id); // чужое — не видно
    const res = await get("/v1/events?sort=quality");
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ event_id: string; watch: unknown }>;
    expect(items.find((x) => x.event_id === a!.event_id)!.watch).toEqual({ watch_id: wid, status: "paused" });
    expect(items.find((x) => x.event_id === b!.event_id)!.watch).toBeNull();
    const calls = h.fake.callsTo("watch", "GET", "/internal/v1/watches:by-events");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toBe(s.userId);
    expect(calls[0]!.query.ids!.split(",").sort()).toEqual([a!.event_id, b!.event_id].sort());
    expect(res.body).not.toContain("recommendation");
  });

  it("watch down or not configured → 200, cards without the watch field; empty page → no by-events call", async () => {
    await setup();
    seed(1);
    h.fake.down.add("watch");
    const res = await get("/v1/events");
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).not.toHaveProperty("watch");
    expect(h.logs.text).toContain("watch by-events unavailable");
    await h.close();
    await setup({ WATCH_URL: "" });
    seed(1);
    expect((await get("/v1/events")).json().items[0]).not.toHaveProperty("watch");
    await h.close();
    await setup();
    expect((await get("/v1/events")).json().items).toEqual([]);
    expect(h.fake.callsTo("watch")).toHaveLength(0);
  });
});

describe("review: reaction on the detail and its cancellation (M3)", () => {
  it("detail.reaction from recommendations (more_like_this / not_interested / null); down → null", async () => {
    await setup();
    const [e] = seed(1);
    expect((await get(`/v1/events/${e!.event_id}`)).json().reaction).toBeNull();
    await send("POST", "/v1/recommendations/reactions", { event_id: e!.event_id, reaction: "less" });
    const d = (await get(`/v1/events/${e!.event_id}`)).json();
    expect(Value.Check(EventDetailPersonalSchema, d)).toBe(true);
    expect(d.reaction).toBe("not_interested");
    expect(h.fake.callsTo("recommendations", "GET", `/internal/v1/reactions/${e!.event_id}`).at(-1)!.subject).toBe(s.userId);
    await send("POST", "/v1/recommendations/reactions", { event_id: e!.event_id, reaction: "more" });
    expect((await get(`/v1/events/${e!.event_id}`)).json().reaction).toBe("more_like_this");
    h.fake.override("recommendations", "GET", `/internal/v1/reactions/${e!.event_id}`, () => json(200, { event_id: e!.event_id, reaction: "love", created_at: null }));
    expect((await get(`/v1/events/${e!.event_id}`)).json().reaction).toBeNull(); // мусор — null
    h.fake.down.add("recommendations");
    const down = await get(`/v1/events/${e!.event_id}`);
    expect([down.statusCode, down.json().reaction]).toEqual([200, null]);
    await h.close();
    await setup({ RECOMMENDATIONS_URL: "" });
    const [e2] = seed(1);
    expect((await get(`/v1/events/${e2!.event_id}`)).json().reaction).toBeNull();
  });

  it("DELETE /v1/recommendations/reactions/{event_id}: undoes the current reaction; none → 204 without undo; 404/401/503", async () => {
    await setup();
    const [e] = seed(1);
    await send("POST", "/v1/recommendations/reactions", { event_id: e!.event_id, reaction: "less" });
    await get("/v1/home");
    const ranks = rankCalls().length;
    const del = await send("DELETE", `/v1/recommendations/reactions/${e!.event_id.toUpperCase()}`);
    expect([del.statusCode, del.body]).toEqual([204, ""]);
    const undo = h.fake.callsTo("recommendations", "POST", "/internal/v1/reactions").at(-1)!;
    expect(undo.body).toEqual({ event_id: e!.event_id, categories: [], reaction: "less", undo: true });
    expect(h.fake.reactions.size).toBe(0);
    await get("/v1/home");
    expect(rankCalls().length).toBe(ranks + 1); // кэш Home сброшен
    const posts = h.fake.callsTo("recommendations", "POST", "/internal/v1/reactions").length;
    expect((await send("DELETE", `/v1/recommendations/reactions/${e!.event_id}`)).statusCode).toBe(204);
    expect(h.fake.callsTo("recommendations", "POST", "/internal/v1/reactions")).toHaveLength(posts);
    const bad = await send("DELETE", "/v1/recommendations/reactions/not-a-uuid");
    expect([bad.statusCode, bad.json().code]).toEqual([404, "EVENT_NOT_FOUND"]);
    expect((await h.app.inject({ method: "DELETE", url: `/v1/recommendations/reactions/${e!.event_id}` })).statusCode).toBe(401);
    h.fake.down.add("recommendations");
    const down = await send("DELETE", `/v1/recommendations/reactions/${e!.event_id}`);
    expect([down.statusCode, down.json().code]).toEqual([503, "UPSTREAM_UNAVAILABLE"]);
    await h.close();
    await setup({ RECOMMENDATIONS_URL: "" });
    const off = await send("DELETE", `/v1/recommendations/reactions/${e!.event_id}`);
    expect([off.statusCode, off.json().code]).toEqual([503, "FEATURE_UNAVAILABLE"]);
  });
});

describe("review: summary counters null when the source is unavailable (M4) and the visit race", () => {
  const visitKey = () => `${h.config.redisKeyPrefix}visit:${s.userId}`;

  it("events and watch down → summary null; events down only → new_events null, watch parts are numbers", async () => {
    await setup();
    h.fake.down.add("events");
    h.fake.down.add("watch");
    await testRedis().hset(visitKey(), "seen", String(Date.now() - 7200_000));
    const res = await get("/v1/home");
    expect([res.statusCode, res.json().summary]).toEqual([200, null]);
    await h.close();
    await setup();
    h.fake.down.add("events");
    await testRedis().hset(visitKey(), "seen", String(Date.now() - 7200_000));
    const body = (await get("/v1/home")).json();
    expect(Value.Check(HomeResponseSchema, body)).toBe(true);
    expect(body.summary).toMatchObject({ new_events: null, price_drops: 0, sales_opened: 0, critical: 0 });
  });

  it("watch not configured → watch counters null (not 0)", async () => {
    await setup({ WATCH_URL: "" });
    await testRedis().hset(visitKey(), "seen", String(Date.now() - 7200_000));
    expect((await get("/v1/home")).json().summary).toMatchObject({ new_events: 0, price_drops: null, sales_opened: null, critical: null });
  });

  it("two parallel GET /v1/home (StrictMode) → since shifted once, both get the same summary", async () => {
    await setup();
    const seen = Date.now() - 7200_000;
    await testRedis().hset(visitKey(), "seen", String(seen));
    h.fake.delays.set("watch", 150); // сводка считается заметное время
    const [r1, r2] = await Promise.all([get("/v1/home"), get("/v1/home")]);
    const [a, b] = [r1.json().summary, r2.json().summary];
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(a.since).toBe(new Date(seen).toISOString());
    expect(await testRedis().hget(visitKey(), "since")).toBe(String(seen));
    expect(h.fake.callsTo("watch", "GET", "/internal/v1/watches:summary")).toHaveLength(1); // посчитана один раз
    // третий запрос того же визита — та же сводка (в пределах удержания), since не сдвинулся
    expect((await get("/v1/home")).json().summary).toEqual(a);
    expect(await testRedis().hget(visitKey(), "since")).toBe(String(seen));
  });
});

describe("review: offer_id on watch creation", () => {
  it("offer_id is forwarded to watch (lower-case); not a UUID → 422; absent → not sent", async () => {
    await setup();
    const [a, b] = seed(2);
    const offerId = "AB3C3A52-1D2E-4F60-8A9B-000000000123";
    expect((await send("POST", "/v1/watches", { event_id: a!.event_id, offer_id: offerId }, idem())).statusCode).toBe(201);
    const calls = h.fake.callsTo("watch", "POST", "/internal/v1/watches") as Array<{ body: Record<string, unknown> }>;
    expect(calls[0]!.body.offer_id).toBe(offerId.toLowerCase());
    const bad = await send("POST", "/v1/watches", { event_id: b!.event_id, offer_id: "x" }, idem());
    expect([bad.statusCode, bad.json().code]).toEqual([422, "VALIDATION_ERROR"]);
    expect((await send("POST", "/v1/watches", { event_id: b!.event_id }, idem())).statusCode).toBe(201);
    const after = h.fake.callsTo("watch", "POST", "/internal/v1/watches") as Array<{ body: Record<string, unknown> }>;
    expect(after.length).toBe(2);
    expect(after[1]!.body).not.toHaveProperty("offer_id");
  });
});

describe("re-review: recommendations 404 without code and summary save failure", () => {
  it("DELETE/POST reactions: upstream 404 EVENT_NOT_FOUND → 404; 404 without that code (old recommendations, no route) → 503 FEATURE_UNAVAILABLE", async () => {
    await setup();
    const [e] = seed(1);
    const path = `/internal/v1/reactions/${e!.event_id}`;
    h.fake.override("recommendations", "GET", path, () => json(404, { detail: "Not Found" }));
    const old = await send("DELETE", `/v1/recommendations/reactions/${e!.event_id}`);
    expect([old.statusCode, old.json().code, old.json().details]).toEqual([503, "FEATURE_UNAVAILABLE", { feature: "recommendations" }]);
    h.fake.override("recommendations", "GET", path, () => domainError(404, "EVENT_NOT_FOUND"));
    const nf = await send("DELETE", `/v1/recommendations/reactions/${e!.event_id}`);
    expect([nf.statusCode, nf.json().code]).toEqual([404, "EVENT_NOT_FOUND"]);
    h.fake.override("recommendations", "POST", "/internal/v1/reactions", () => json(404, { detail: "Not Found" }));
    const post = await send("POST", "/v1/recommendations/reactions", { event_id: e!.event_id, reaction: "more" });
    expect([post.statusCode, post.json().code]).toEqual([503, "FEATURE_UNAVAILABLE"]);
    h.fake.override("recommendations", "POST", "/internal/v1/reactions", () => domainError(404, "EVENT_NOT_FOUND"));
    expect((await send("POST", "/v1/recommendations/reactions", { event_id: e!.event_id, reaction: "more" })).json().code).toBe("EVENT_NOT_FOUND");
    // деталь при старом recommendations — reaction: null, 200
    h.fake.override("recommendations", "GET", path, () => json(404, { detail: "Not Found" }));
    expect((await get(`/v1/events/${e!.event_id}`)).json()).toMatchObject({ reaction: null });
  });

  /** Подмена методов общего Redis на время теста (сбой записи сводки). */
  function patchRedis(fail: { set?: boolean; del?: boolean }) {
    const r = testRedis() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const orig = { set: r.set!, del: r.del! };
    r.set = function (this: unknown, ...a: unknown[]) {
      if (fail.set && String(a[0]).includes("home:summary")) return Promise.reject(new Error("READONLY"));
      return orig.set.apply(this, a);
    };
    r.del = function (this: unknown, ...a: unknown[]) {
      if (fail.del && String(a[0]).includes("home:summary")) return Promise.reject(new Error("READONLY"));
      return orig.del.apply(this, a);
    };
    return () => Object.assign(r, orig);
  }

  it("first request fails to save the summary → its marker is removed, the parallel one computes itself without waiting", async () => {
    await setup();
    await testRedis().hset(`${h.config.redisKeyPrefix}visit:${s.userId}`, "seen", String(Date.now() - 7200_000));
    h.fake.delays.set("watch", 200);
    const restore = patchRedis({ set: true });
    try {
      const t0 = Date.now();
      const [r1, r2] = await Promise.all([get("/v1/home"), get("/v1/home")]);
      const took = Date.now() - t0;
      expect(r1.json().summary).not.toBeNull();
      expect(r2.json().summary).toEqual(r1.json().summary);
      expect(h.fake.callsTo("watch", "GET", "/internal/v1/watches:summary")).toHaveLength(2); // второй посчитал сам
      expect(took).toBeLessThan(1500 + 1500);
      expect(h.logs.text).toContain("home summary save failed");
    } finally {
      restore();
    }
  });

  it("marker could not be removed either → the parallel request waits ≤ 1.5 s, then computes itself", async () => {
    await setup();
    await testRedis().hset(`${h.config.redisKeyPrefix}visit:${s.userId}`, "seen", String(Date.now() - 7200_000));
    h.fake.delays.set("watch", 100);
    const restore = patchRedis({ set: true, del: true });
    try {
      const first = get("/v1/home");
      await new Promise((r) => setTimeout(r, 30));
      const t0 = Date.now();
      const r2 = await get("/v1/home");
      const waited = Date.now() - t0;
      const r1 = await first;
      expect(r2.json().summary).toEqual(r1.json().summary);
      expect(r2.json().summary).not.toBeNull();
      expect(waited).toBeGreaterThanOrEqual(1400);
      expect(waited).toBeLessThan(1500 + 2000);
    } finally {
      restore();
    }
  });
});
