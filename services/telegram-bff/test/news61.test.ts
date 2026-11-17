/**
 * Исправление 6.1 (news §3.4): география профиля в news:feed / news:topics, тема в ленте, GET /v1/news/topics,
 * старый news без тем.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { NewsTopicsResponseSchema } from "../src/schemas.js";
import { SPRINT6_ENV, bearer, closeRedis, domainError, json, login, makeHarness, newsFixture, type Harness, type LoggedIn } from "./helpers.js";

let h: Harness;
let s: LoggedIn;
async function setup(env: Record<string, string> = {}) {
  h = await makeHarness({ ...SPRINT6_ENV, ...env });
  s = await login(h);
}
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const get = (url: string, token = s.access) => h.app.inject({ url, headers: bearer(token) });
const feedCalls = () => h.fake.callsTo("news", "POST", "/internal/v1/news:feed");
const topicCalls = () => h.fake.callsTo("news", "POST", "/internal/v1/news:topics");

async function setGeo(geographies: unknown[]) {
  const cur = (await get("/v1/profile")).json().preferences;
  h.fake.prefs.set(s.userId, { ...cur, interests: { categories: ["music.concerts"], entities: [] }, geographies } as never);
}

describe("6.1: event_ends_at — when the event of a news item is over (Mini App hides it without parsing text)", () => {
  it("passed through as is; absent (news before 6.1) — no field; garbage — the item is dropped", async () => {
    await setup();
    const ends = "2026-12-05T20:00:00Z";
    h.fake.newsItems.push({ ...newsFixture(), event_ends_at: ends } as never);
    h.fake.newsItems.push({ ...newsFixture(), news_id: "8a1b2c3d-4e5f-4a6b-8c7d-000000000002" } as never);
    h.fake.newsItems.push({ ...newsFixture(), news_id: "8a1b2c3d-4e5f-4a6b-8c7d-000000000003", event_ends_at: "soon" } as never);
    const items = (await get("/v1/news")).json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items.filter((x) => x.event_ends_at === ends)).toHaveLength(1);
    expect(items.filter((x) => !("event_ends_at" in x))).toHaveLength(1);
  });
});

describe("6.1: geography of the profile in news:feed / news:topics", () => {
  it("geographies from preferences (as for recommendations:rank) go to :feed — /v1/news and Home carousel", async () => {
    await setup();
    await setGeo([{ level: "country", code: "UZ" }, { level: "region", code: "central_asia" }, { level: "city", code: "Dubai" }, { level: "planet", code: "x" }]);
    h.fake.newsItems.push(newsFixture());
    await get("/v1/news?topic=music");
    const geo = [
      { level: "country", code: "UZ" },
      { level: "region", code: "central_asia" },
      { level: "city", code: "Dubai" },
    ];
    expect(feedCalls()[0]!.body).toMatchObject({ geographies: geo, topic: "music", interests: ["music.concerts"] });
    await get("/v1/home");
    const home = feedCalls().at(-1)!.body as Record<string, unknown>;
    expect(home).toMatchObject({ geographies: geo, limit: 10 });
    expect(home).not.toHaveProperty("topic");
  });

  it("preferences unavailable → geographies not sent (news uses the saved one); world → as is", async () => {
    await setup();
    await setGeo([{ level: "world" }]);
    await get("/v1/news");
    expect((feedCalls()[0]!.body as { geographies: unknown }).geographies).toEqual([{ level: "world", code: null }]);
    h.fake.down.add("preferences");
    expect((await get("/v1/news")).statusCode).toBe(200);
    expect(feedCalls()[1]!.body).not.toHaveProperty("geographies");
  });

  /** Старый news (extra=forbid): 422 VALIDATION_ERROR на полях 6.1. */
  const oldNews = () =>
    h.fake.override("news", "POST", "/internal/v1/news:feed", (r) => {
      const extra = ["geographies", "topic"].filter((k) => k in (r.body as object));
      if (extra.length) return domainError(422, "VALIDATION_ERROR", { errors: extra.map((k) => ({ loc: ["body", k], msg: "Extra inputs are not permitted", type: "extra_forbidden" })) });
      return json(200, { items: [newsFixture()], next_cursor: null });
    });

  it("old news rejects geographies/topic with 422 → one retry without them: /v1/news 200 and Home news section ready", async () => {
    await setup();
    await setGeo([{ level: "country", code: "UZ" }]);
    oldNews();
    const res = await get("/v1/news?topic=music");
    expect([res.statusCode, res.json().items.length]).toEqual([200, 1]);
    expect(feedCalls()).toHaveLength(2);
    expect(feedCalls()[0]!.body).toMatchObject({ geographies: [{ level: "country", code: "UZ" }], topic: "music" });
    expect(feedCalls()[1]!.body).not.toHaveProperty("geographies");
    expect(feedCalls()[1]!.body).not.toHaveProperty("topic");
    const home = (await get("/v1/home")).json();
    const news = home.sections.find((x: { key: string }) => x.key === "news");
    expect(news.state).toBe("ready");
    expect(news.items).toHaveLength(1);
    expect(h.logs.text.split("news rejected 6.1 feed fields").length - 1).toBe(1); // одно предупреждение на процесс
  });

  it("other 422 from news (not only 6.1 fields) — no retry, error as before", async () => {
    await setup();
    h.fake.override("news", "POST", "/internal/v1/news:feed", () =>
      domainError(422, "VALIDATION_ERROR", { errors: [{ loc: ["body", "geographies"], type: "extra_forbidden" }, { loc: ["body", "cursor"], type: "string_too_long" }] }),
    );
    expect((await get("/v1/news")).statusCode).toBe(422);
    expect(feedCalls()).toHaveLength(1);
  });

  it("topic: unknown → 422 VALIDATION_ERROR, no call to news; absent → not sent", async () => {
    await setup();
    for (const bad of ["/v1/news?topic=politics", "/v1/news?topic=MUSIC", "/v1/news?topic=", "/v1/news/topics?filter=hot", "/v1/news/topics?topic=music"]) {
      const r = await get(bad);
      expect([bad, r.statusCode, r.json().code]).toEqual([bad, 422, "VALIDATION_ERROR"]);
    }
    expect(feedCalls()).toHaveLength(0);
    await get("/v1/news");
    expect(feedCalls()[0]!.body).not.toHaveProperty("topic");
  });
});

describe("6.1: GET /v1/news/topics", () => {
  it("body as :feed without cursor/limit/topic; items in chip order, unknown/empty/duplicate topics dropped", async () => {
    await setup();
    await setGeo([{ level: "country", code: "AE" }]);
    h.fake.newsTopics = {
      items: [
        { topic: "sport", count: 4 },
        { topic: "music", count: 7 },
        { topic: "politics", count: 9 },
        { topic: "culture", count: 0 },
        { topic: "music", count: 1 },
        { topic: "business", count: -1 },
        "junk",
      ],
      total: 12,
      internal: "x",
    };
    const res = await get("/v1/news/topics?filter=interests");
    expect(res.statusCode).toBe(200);
    expect(Value.Check(NewsTopicsResponseSchema, res.json())).toBe(true);
    expect(res.json()).toEqual({ items: [{ topic: "music", count: 7 }, { topic: "sport", count: 4 }], total: 12 });
    const body = topicCalls()[0]!.body as Record<string, unknown>;
    expect(topicCalls()[0]!.subject).toBe(s.userId);
    expect(body).toMatchObject({ filter: "interests", geographies: [{ level: "country", code: "AE" }], interests: ["music.concerts"], lang: "ru" });
    for (const k of ["cursor", "limit", "topic"]) expect(body).not.toHaveProperty(k);
  });

  it("old news (no :topics route, 404 without code) → 200 {items: [], total: null}", async () => {
    await setup();
    h.fake.newsTopics = null;
    const res = await get("/v1/news/topics");
    expect([res.statusCode, res.json()]).toEqual([200, { items: [], total: null }]);
    expect(h.logs.text).toContain("news:topics not supported");
  });

  it("other errors: 404 with a domain code / 422 → 503 UPSTREAM_UNAVAILABLE; garbage → 503; down → 503; not configured → FEATURE_UNAVAILABLE; 401", async () => {
    await setup();
    h.fake.override("news", "POST", "/internal/v1/news:topics", () => domainError(404, "USER_NOT_FOUND"));
    expect((await get("/v1/news/topics")).json().code).toBe("UPSTREAM_UNAVAILABLE");
    h.fake.override("news", "POST", "/internal/v1/news:topics", () => domainError(422, "VALIDATION_ERROR"));
    expect((await get("/v1/news/topics")).statusCode).toBe(503);
    h.fake.override("news", "POST", "/internal/v1/news:topics", () => json(200, { items: [], total: "many" }));
    expect((await get("/v1/news/topics")).statusCode).toBe(503);
    h.fake.down.add("news");
    expect((await get("/v1/news/topics")).statusCode).toBe(503);
    expect((await h.app.inject({ url: "/v1/news/topics" })).statusCode).toBe(401);
    await h.close();
    await setup({ NEWS_URL: "" });
    const off = await get("/v1/news/topics");
    expect([off.statusCode, off.json().code]).toEqual([503, "FEATURE_UNAVAILABLE"]);
  });
});
