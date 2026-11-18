/**
 * Спринт 6 (docs/sprint6/INTERNAL_API.md §3.1, §8): ленты новостей (CRUD, проверка), модерация новостей (news) и
 * статистика слежений (watch). Домены — подделки по тому же контракту. 401/403, happy path, Idempotency-Key,
 * expected_version и 409, 404, 422, 503 FEATURE_UNAVAILABLE / CHECK_UNAVAILABLE, недоверенные ответы доменов.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkFeedFields, normalizeNewsCheck, normalizeNewsItem, normalizeNewsSource, probeOf } from "../src/routes/news.js";
import { normalizeWatchStats } from "../src/routes/watch.js";
import {
  NEWS_EVENT_ID,
  NEWS_ID,
  NEWS_SOURCE_ID,
  browser,
  closeRedis,
  domainError,
  fakeSprint6,
  json,
  loginAs,
  makeHarness,
  newsCheckRow,
  newsItemRow,
  newsSourceRow,
  watchStatsRow,
  type Harness,
  type Session,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  fakeSprint6(h.fake);
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const SOURCES = "/admin/v1/news/sources";
const SOURCE = `${SOURCES}/${NEWS_SOURCE_ID}`;
const ITEMS = "/admin/v1/news/items";
const STATS = "/admin/v1/watches/stats";
const D_SOURCES = "/internal/v1/news/sources";
const D_SOURCE = `${D_SOURCES}/${NEWS_SOURCE_ID}`;

type Method = "GET" | "POST" | "PATCH" | "DELETE";
const call = (method: Method, url: string, s?: Session | null, payload?: unknown, extra: Record<string, string> = {}) =>
  h.app.inject({ method, url, headers: browser(s, extra), ...(payload !== undefined ? { payload: payload as object } : {}) });

const INPUT = {
  slug: "playbill-news",
  name: "Playbill — News",
  kind: "media",
  mode: "rss",
  feed_url: "https://playbill.com/rss/news",
  page_url: null,
  site_domain: "playbill.com",
  extra_domains: [],
  interests: ["culture.theatre"],
  entities: ["Broadway"],
  country_code: null,
  lang: "en",
  display: "title_only",
  category_filter: null,
  enabled: false,
  reason: "Театральные новости",
};

describe("доступ", () => {
  const ROUTES: Array<[Method, string, unknown?]> = [
    ["GET", SOURCES],
    ["GET", SOURCE],
    ["POST", SOURCES, INPUT],
    ["PATCH", SOURCE, { expected_version: 3, name: "x", reason: "abc" }],
    ["DELETE", SOURCE, { expected_version: 3, reason: "abc" }],
    ["POST", `${SOURCE}/check`, {}],
    ["POST", `${SOURCES}/check`, { mode: "rss", feed_url: "https://a.uz/rss", page_url: null, site_domain: "a.uz", extra_domains: [], category_filter: null }],
    ["GET", ITEMS],
    ["POST", `${ITEMS}/${NEWS_ID}/hide`, { reason: "abc" }],
    ["POST", `${ITEMS}/${NEWS_ID}/unhide`, { reason: "abc" }],
  ];

  it("без сессии → 401, без news.manage (support, analyst) → 403 PERMISSION_DENIED {news.manage}; домен не вызывается", async () => {
    for (const [m, url, body] of ROUTES) expect((await call(m, url, null, body)).statusCode, `${m} ${url}`).toBe(401);
    for (const role of ["support", "analyst", "read_only"] as const) {
      const { s } = await loginAs(h, role);
      for (const [m, url, body] of ROUTES) {
        const res = await call(m, url, s, body, m === "POST" && url === SOURCES ? { "idempotency-key": "k-12345678" } : {});
        expect(res.statusCode, `${role} ${m} ${url}`).toBe(403);
        expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "news.manage" } });
      }
    }
    expect(h.fake.callsTo("news")).toHaveLength(0);
  });

  it("operations (матрица по умолчанию) — news.manage; step-up не нужен; actor с news.manage", async () => {
    const { staff, s } = await loginAs(h, "operations");
    expect(s.me.permissions).toContain("news.manage");
    const res = await call("PATCH", SOURCE, s, { expected_version: 3, enabled: false, reason: "пауза" });
    expect(res.statusCode).toBe(200);
    const c = h.fake.callsTo("news", "PATCH", D_SOURCE)[0]!;
    expect(c.actor?.id).toBe(staff.staff_id);
    expect(c.actor?.permissions).toContain("news.manage");
  });

  it("watches/stats: dashboard.read (read_only — да; без прав — 403)", async () => {
    const ro = await loginAs(h, "read_only");
    expect((await call("GET", STATS, ro.s)).statusCode).toBe(200);
    const none = await loginAs(h, "read_only", { permissions: [] });
    const res = await call("GET", STATS, none.s);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "dashboard.read" } });
    expect(h.fake.callsTo("watch")).toHaveLength(1);
  });
});

describe("источники новостей", () => {
  it("список: фильтры interest/country/enabled/q/limit уходят в news; строки нормализуются, испорченные отбрасываются", async () => {
    h.fake.on("news", "GET", D_SOURCES, () =>
      json(200, {
        items: [
          newsSourceRow({ feed_url: "http://insecure.formula1.com/rss", internal_key: "leak-7f3a", health: { last_fetch_at: "вчера", last_ok_at: null, last_error: "FEED_INVALID", items_24h: -3 } }),
          newsSourceRow({ source_id: "not-a-uuid" }),
          newsSourceRow({ source_id: "a6000000-0000-4000-8000-000000000002", slug: "Bad Slug" }),
          newsSourceRow({ source_id: "a6000000-0000-4000-8000-000000000003", slug: "kun-uz", kind: "media", country_code: "UZ", lang: "uz", interests: ["culture", "<b>", 7], entities: ["  Kun\u0000.uz  "], extra_domains: ["cdn.kun.uz", "BAD DOMAIN"], name: "Kun.uz‮" }),
          newsSourceRow(), // дубль source_id — первая строка
          "мусор",
        ],
        next_cursor: "c2",
      }),
    );
    const { s } = await loginAs(h, "operations");
    const res = await call("GET", `${SOURCES}?interest=culture.theatre&enabled=true&q=kun&limit=50`, s);
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("news", "GET", D_SOURCES)[0]!.query).toEqual({ interest: "culture.theatre", enabled: "true", q: "kun", limit: "50" });
    const b = res.json();
    expect(b.next_cursor).toBe("c2");
    expect(b.items).toHaveLength(2);
    // страну фильтрует news: BFF передаёт список и отдаёт страницу как есть
    const uz = await call("GET", `${SOURCES}?country=UZ&limit=10`, s);
    expect(h.fake.callsTo("news", "GET", D_SOURCES)[1]!.query).toEqual({ country: "UZ", limit: "10" });
    expect(uz.json().items).toHaveLength(2);
    expect(b.items[0]).toMatchObject({ feed_url: null, health: { last_fetch_at: null, last_error: { code: "FEED_INVALID", message: null, at: null }, items_24h: 0 } });
    expect(b.items[1]).toMatchObject({ slug: "kun-uz", name: "Kun.uz", interests: ["culture"], entities: ["Kun .uz"], extra_domains: ["cdn.kun.uz"], country_code: "UZ", lang: "uz" });
    expect(res.body).not.toContain("leak-7f3a");
    expect(h.logs.text).toMatch(/news sources rows rejected by normalization/);
  });

  it("422: неизвестный фильтр интереса; страна — не ISO 3166-1 alpha-2, больше 20, пустой элемент", async () => {
    const { s } = await loginAs(h, "operations");
    expect((await call("GET", `${SOURCES}?interest=Спорт`, s)).statusCode).toBe(422);
    const twentyOne = Array.from({ length: 21 }, () => "UZ").join(",");
    for (const c of ["uzb", "U1", "UZ,", ",UZ", "UZ,,KZ", "UZ;KZ", "UZ KZ", "QQ", "UZ,EU", "ZZ", twentyOne]) {
      for (const url of [SOURCES, ITEMS]) {
        const res = await call("GET", `${url}?country=${encodeURIComponent(c)}`, s);
        expect(res.statusCode, `${url} ${c}`).toBe(422);
        expect(res.json().details, `${url} ${c}`).toMatchObject({ field: "country" });
      }
    }
    expect(h.fake.callsTo("news")).toHaveLength(0);
  });

  it("страны: список через запятую (регистр не важен, без дублей) уходит в news; страница и next_cursor — как есть", async () => {
    h.fake.on("news", "GET", D_SOURCES, () =>
      json(200, { items: [newsSourceRow({ country_code: "KZ" }), newsSourceRow({ source_id: "a6000000-0000-4000-8000-000000000002", slug: "kun-uz", country_code: "UZ" })], next_cursor: "c3" }),
    );
    h.fake.on("news", "GET", "/internal/v1/news/items", () =>
      json(200, {
        items: [
          newsItemRow(),
          newsItemRow({ news_id: "b6000000-0000-4000-8000-000000000003", kind: "event_update", source: { source_id: null, name: "Каталог", domain: "ticketmaster.com" }, url: "https://www.ticketmaster.com/e/1" }),
        ],
        next_cursor: "n2",
      }),
    );
    const { s } = await loginAs(h, "operations");
    const twenty = "UZ,KZ,KG,AZ,GE,AM,TJ,TM,RU,BY,TR,AE,GB,US,DE,FR,IT,ES,PL,CN";
    expect((await call("GET", `${SOURCES}?country=${twenty}`, s)).statusCode).toBe(200);
    const res = await call("GET", `${SOURCES}?country=uz,KZ,uz&limit=20`, s);
    expect(h.fake.callsTo("news", "GET", D_SOURCES)[1]!.query).toEqual({ country: "UZ,KZ", limit: "20" });
    expect(res.json()).toMatchObject({ next_cursor: "c3" });
    expect(res.json().items.map((x: { slug: string }) => x.slug)).toEqual(["formula1-latest", "kun-uz"]);
    // новости: страна уходит в news, ленты не дочитываются, изменения событий (страна площадки — у news) не отбрасываются
    const items = await call("GET", `${ITEMS}?country=uz&hidden=false&limit=30`, s);
    expect(h.fake.callsTo("news", "GET", "/internal/v1/news/items")[0]!.query).toEqual({ country: "UZ", hidden: "false", limit: "30" });
    expect(items.json().items).toHaveLength(2);
    expect(items.json().next_cursor).toBe("n2");
    expect(h.fake.callsTo("news", "GET", D_SOURCES)).toHaveLength(2);
  });

  it("карточка: 404 домена → NEWS_SOURCE_NOT_FOUND; испорченный ответ → 503 UPSTREAM_UNAVAILABLE {news}", async () => {
    const { s } = await loginAs(h, "operations");
    expect((await call("GET", SOURCE, s)).json()).toMatchObject({ source_id: NEWS_SOURCE_ID, health: { items_24h: 7 } });
    h.fake.on("news", "GET", D_SOURCE, () => domainError(404, "SOURCE_NOT_FOUND"));
    const nf = await call("GET", SOURCE, s);
    expect(nf.statusCode).toBe(404);
    expect(nf.json().code).toBe("NEWS_SOURCE_NOT_FOUND");
    h.fake.on("news", "GET", D_SOURCE, () => json(200, newsSourceRow({ kind: "blog" })));
    const bad = await call("GET", SOURCE, s);
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "news" } });
    expect((await call("GET", `${SOURCES}/123`, s)).statusCode).toBe(422);
  });

  it("создание: Idempotency-Key обязателен и пробрасывается; 201; повтор с тем же ключом — тот же ключ в домен", async () => {
    const { s } = await loginAs(h, "operations");
    const noKey = await call("POST", SOURCES, s, INPUT);
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await call("POST", SOURCES, s, INPUT, { "idempotency-key": "bad key" })).json().code).toBe("IDEMPOTENCY_KEY_INVALID");
    const res = await call("POST", SOURCES, s, INPUT, { "idempotency-key": "news-create-0001" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ slug: "playbill-news", display: "title_only", enabled: false, version: 1 });
    await call("POST", SOURCES, s, INPUT, { "idempotency-key": "news-create-0001" });
    const calls = h.fake.callsTo("news", "POST", D_SOURCES);
    expect(calls.map((c) => c.headers["idempotency-key"])).toEqual(["news-create-0001", "news-create-0001"]);
    expect(calls[0]!.body).toEqual(INPUT);
  });

  it("создание 422: лишнее поле, режим rss без ленты, лента не на домене источника, http-лента, пустые интересы", async () => {
    const { s } = await loginAs(h, "operations");
    const k = { "idempotency-key": "news-create-0002" };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...INPUT, secret: 1 }, "secret"],
      [{ ...INPUT, feed_url: null }, "feed_url"],
      [{ ...INPUT, mode: "html", page_url: null }, "page_url"],
      [{ ...INPUT, feed_url: "https://evil.example.com/rss" }, "feed_url"],
      [{ ...INPUT, feed_url: "http://playbill.com/rss" }, "feed_url"],
      [{ ...INPUT, interests: [] }, "interests"],
      [{ ...INPUT, lang: "de" }, "lang"],
      [{ ...INPUT, category_filter: "/culture news/" }, "category_filter"],
    ];
    for (const [body, field] of cases) {
      const res = await call("POST", SOURCES, s, body, k);
      expect(res.statusCode, field).toBe(422);
      expect(res.json().details.field, field).toBe(field);
    }
    // поддомен и extra_domains — допустимы
    const ok = await call("POST", SOURCES, s, { ...INPUT, feed_url: "https://feeds.playbill.com/news", extra_domains: [] }, k);
    expect(ok.statusCode).toBe(201);
    expect((await call("POST", SOURCES, s, { ...INPUT, feed_url: "https://cdn.pb.example/rss", extra_domains: ["pb.example"] }, k)).statusCode).toBe(201);
    expect(h.fake.callsTo("news")).toHaveLength(2);
  });

  it("создание: 409 slug домена → NEWS_SOURCE_SLUG_TAKEN", async () => {
    h.fake.on("news", "POST", D_SOURCES, () => domainError(409, "SOURCE_SLUG_TAKEN", { slug: "playbill-news" }));
    const { s } = await loginAs(h, "operations");
    const res = await call("POST", SOURCES, s, INPUT, { "idempotency-key": "news-create-0003" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NEWS_SOURCE_SLUG_TAKEN", details: {} });
  });

  it("изменение: expected_version обязателен; slug не меняется; 409 *VERSION_CONFLICT → NEWS_SOURCE_VERSION_CONFLICT {current_version}", async () => {
    const { s } = await loginAs(h, "operations");
    expect((await call("PATCH", SOURCE, s, { name: "x", reason: "abc" })).statusCode).toBe(422);
    expect((await call("PATCH", SOURCE, s, { expected_version: 3, reason: "abc" })).statusCode).toBe(422); // нечего менять
    expect((await call("PATCH", SOURCE, s, { expected_version: 3, slug: "new", reason: "abc" })).statusCode).toBe(422);
    const okRes = await call("PATCH", SOURCE, s, { expected_version: 3, category_filter: "/culture/", reason: "только культура" }, { "idempotency-key": "news-patch-0001" });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json()).toMatchObject({ version: 4, category_filter: "/culture/" });
    expect(h.fake.callsTo("news", "PATCH")[0]!.headers["idempotency-key"]).toBe("news-patch-0001");

    for (const code of ["VERSION_CONFLICT", "SOURCE_VERSION_CONFLICT", "NEWS_SOURCE_VERSION_CONFLICT"]) {
      h.fake.on("news", "PATCH", D_SOURCE, () => domainError(409, code, { current_version: 5, secret: "x" }));
      const res = await call("PATCH", SOURCE, s, { expected_version: 3, enabled: true, reason: "включить" });
      expect(res.statusCode, code).toBe(409);
      expect(res.json()).toMatchObject({ code: "NEWS_SOURCE_VERSION_CONFLICT", details: { current_version: 5 } });
      expect(res.json().details.secret).toBeUndefined();
    }
  });

  it("изменение: смена ленты проверяется вместе с доменом из тела", async () => {
    const { s } = await loginAs(h, "operations");
    const bad = await call("PATCH", SOURCE, s, { expected_version: 3, feed_url: "https://other.example/rss", site_domain: "formula1.com", reason: "лента" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().details.field).toBe("feed_url");
    const modeOnly = await call("PATCH", SOURCE, s, { expected_version: 3, mode: "html", page_url: null, reason: "страница" });
    expect(modeOnly.statusCode).toBe(422);
  });

  it("удаление: 204; expected_version — в query и теле; 409 → NEWS_SOURCE_VERSION_CONFLICT; без версии — 422", async () => {
    const { s } = await loginAs(h, "operations");
    expect((await call("DELETE", SOURCE, s, { reason: "abc" })).statusCode).toBe(422);
    const res = await call("DELETE", SOURCE, s, { expected_version: 3, reason: "лента закрыта" }, { "idempotency-key": "news-del-0001" });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    const c = h.fake.callsTo("news", "DELETE", D_SOURCE)[0]!;
    expect(c.query).toEqual({ expected_version: "3" });
    expect(c.body).toEqual({ expected_version: 3, reason: "лента закрыта" });
    expect(c.headers["idempotency-key"]).toBe("news-del-0001");
    h.fake.on("news", "DELETE", D_SOURCE, () => domainError(409, "VERSION_CONFLICT", { current_version: 4 }));
    const conflict = await call("DELETE", SOURCE, s, { expected_version: 3, reason: "лента закрыта" });
    expect(conflict.json()).toMatchObject({ code: "NEWS_SOURCE_VERSION_CONFLICT", details: { current_version: 4 } });
  });
});

describe("проверка ленты", () => {
  const FORM = { mode: "rss", feed_url: "https://www.formula1.com/en/latest/all.xml", page_url: null, site_domain: "formula1.com", extra_domains: [], category_filter: "/latest/" };

  it("сохранённая лента: без тела домену; с полями формы — тело целиком; неполные поля → 422", async () => {
    const { s } = await loginAs(h, "operations");
    const res = await call("POST", `${SOURCE}/check`, s);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, items_total: 10, errors: [], checked_at: "2026-10-11T09:00:00Z" });
    expect(h.fake.callsTo("news", "POST", `${D_SOURCE}:check`)[0]!.body).toBeUndefined();
    expect((await call("POST", `${SOURCE}/check`, s, FORM)).statusCode).toBe(200);
    expect(h.fake.callsTo("news", "POST", `${D_SOURCE}:check`)[1]!.body).toEqual(FORM);
    const partial = await call("POST", `${SOURCE}/check`, s, { feed_url: FORM.feed_url });
    expect(partial.statusCode).toBe(422);
    expect(h.fake.callsTo("news", "POST", `${D_SOURCE}:check`)).toHaveLength(2);
  });

  it("новая лента: POST sources/check → news sources:check; лента не на домене → 422", async () => {
    const { s } = await loginAs(h, "operations");
    expect((await call("POST", `${SOURCES}/check`, s, FORM)).statusCode).toBe(200);
    expect(h.fake.callsTo("news", "POST", `${D_SOURCES}:check`)[0]!.body).toEqual(FORM);
    expect((await call("POST", `${SOURCES}/check`, s, { ...FORM, site_domain: "uefa.com" })).statusCode).toBe(422);
  });

  it("лента не прочитана: ok:false и коды ошибок; ok без годных записей → ok:false", async () => {
    h.fake.on("news", "POST", `${D_SOURCES}:check`, () => json(200, { ok: false, items: [], items_total: 0, errors: [{ code: "SOURCE_FETCH_FAILED", message: "HTTP 404" }, { code: "<x>" }] }));
    const { s } = await loginAs(h, "operations");
    const res = await call("POST", `${SOURCES}/check`, s, FORM);
    expect(res.json()).toMatchObject({ ok: false, items: [], errors: [{ code: "SOURCE_FETCH_FAILED", message: "HTTP 404" }] });
    h.fake.on("news", "POST", `${D_SOURCES}:check`, () => json(200, newsCheckRow({ items: [{ url: "https://formula1.com/a", title: "A", dropped: "category_filter" }] })));
    expect((await call("POST", `${SOURCES}/check`, s, FORM)).json()).toMatchObject({ ok: false, items: [{ dropped: "category_filter" }] });
  });

  it("news без маршрута проверки (404 без кода / 405) → 503 CHECK_UNAVAILABLE; 404 с кодом источника → NEWS_SOURCE_NOT_FOUND", async () => {
    const { s } = await loginAs(h, "operations");
    h.fake.on("news", "POST", `${D_SOURCES}:check`, () => json(404, { detail: "Not Found" }));
    const res = await call("POST", `${SOURCES}/check`, s, FORM);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "CHECK_UNAVAILABLE", details: { service: "news" } });
    h.fake.on("news", "POST", `${D_SOURCE}:check`, () => json(405, { detail: "Method Not Allowed" }));
    expect((await call("POST", `${SOURCE}/check`, s)).json().code).toBe("CHECK_UNAVAILABLE");
    h.fake.on("news", "POST", `${D_SOURCE}:check`, () => domainError(404, "NEWS_SOURCE_NOT_FOUND"));
    expect((await call("POST", `${SOURCE}/check`, s)).json().code).toBe("NEWS_SOURCE_NOT_FOUND");
  });

  it("проверка — без повторов при UPSTREAM_RETRIES > 0 (каждая попытка — загрузка чужой ленты)", async () => {
    const h2 = await makeHarness({ UPSTREAM_RETRIES: "2" });
    try {
      fakeSprint6(h2.fake);
      h2.fake.on("news", "POST", `${D_SOURCE}:check`, () => json(502, { code: "BAD_GATEWAY" }));
      const { s } = await loginAs(h2, "operations");
      const res = await h2.app.inject({ method: "POST", url: `${SOURCE}/check`, headers: browser(s) });
      expect(res.statusCode).toBe(503);
      expect(h2.fake.callsTo("news", "POST", `${D_SOURCE}:check`)).toHaveLength(1);
    } finally {
      await h2.close();
    }
  });
});

describe("новости", () => {
  it("список: фильтры source/hidden; имя скрывшего — из admin-identity; ссылки только https", async () => {
    const { staff, s } = await loginAs(h, "operations");
    h.fake.on("news", "GET", "/internal/v1/news/items", () =>
      json(200, {
        items: [
          newsItemRow({ hidden: true, hidden_reason: "Реклама", hidden_at: "2026-10-11T09:30:00Z", hidden_by: staff.staff_id }),
          newsItemRow({ news_id: "b6000000-0000-4000-8000-000000000002", url: "http://www.formula1.com/x" }), // без https — не показывается
          newsItemRow({ news_id: "b6000000-0000-4000-8000-000000000003", url: "javascript:alert(1)" }),
          newsItemRow({ news_id: "b6000000-0000-4000-8000-000000000004", kind: "event_update", source: { source_id: null, name: "Каталог событий", domain: "ticketmaster.com" }, url: "https://www.ticketmaster.com/e/1", significance: "high", event_ids: [NEWS_EVENT_ID, "evt-1"] }),
          newsItemRow({ news_id: "b6000000-0000-4000-8000-000000000005", significance: 0.12, title: "<img src=x onerror=alert(1)>", summary_ru: "a\u0007b" }),
        ],
        next_cursor: null,
      }),
    );
    const res = await call("GET", `${ITEMS}?source=${NEWS_SOURCE_ID.toUpperCase()}&hidden=true&limit=20`, s);
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("news", "GET", "/internal/v1/news/items")[0]!.query).toEqual({ source: NEWS_SOURCE_ID, hidden: "true", limit: "20" });
    const items = res.json().items;
    expect(items.map((x: { news_id: string }) => x.news_id.slice(-1))).toEqual(["1", "4", "5"]);
    expect(items[0]).toMatchObject({ hidden: true, hidden_reason: "Реклама", hidden_by: staff.staff_id, hidden_by_name: staff.display_name, significance: 0.82, significance_level: "high", below_threshold: false });
    expect(items[1]).toMatchObject({ kind: "event_update", source: { source_id: null, name: "Каталог событий", domain: "ticketmaster.com" }, significance: null, significance_level: "high", event_ids: [NEWS_EVENT_ID] });
    // текст остаётся текстом (admin-web не вставляет HTML), управляющие символы — пробел
    expect(items[2]).toMatchObject({ title: "<img src=x onerror=alert(1)>", summary_ru: "a b", significance_level: "low", below_threshold: true });
    expect((await call("GET", `${ITEMS}?source=xyz`, s)).statusCode).toBe(422);
  });

  it("скрыть / вернуть: причина 3..300 (обрезается), ключ идемпотентности, 404 → NEWS_ITEM_NOT_FOUND", async () => {
    const { staff, s } = await loginAs(h, "operations");
    const res = await call("POST", `${ITEMS}/${NEWS_ID}/hide`, s, { reason: "  Не по теме событий  " }, { "idempotency-key": "news-hide-0001" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hidden: true, hidden_reason: "Не по теме событий", hidden_by_name: staff.display_name });
    const c = h.fake.callsTo("news", "POST", `/internal/v1/news/items/${NEWS_ID}:hide`)[0]!;
    expect(c.body).toEqual({ reason: "Не по теме событий" });
    expect(c.headers["idempotency-key"]).toBe("news-hide-0001");
    expect(c.actor?.id).toBe(staff.staff_id);
    expect((await call("POST", `${ITEMS}/${NEWS_ID}/unhide`, s, { reason: "Ошибка" })).json()).toMatchObject({ hidden: false, hidden_reason: null });
    for (const reason of ["ab", "   ab   ", "x".repeat(301)]) expect((await call("POST", `${ITEMS}/${NEWS_ID}/hide`, s, { reason })).statusCode, reason).toBe(422);
    expect((await call("POST", `${ITEMS}/${NEWS_ID}/hide`, s, {})).statusCode).toBe(422);
    h.fake.on("news", "POST", `/internal/v1/news/items/${NEWS_ID}:hide`, () => domainError(404, "NEWS_NOT_FOUND"));
    const nf = await call("POST", `${ITEMS}/${NEWS_ID}/hide`, s, { reason: "Реклама" });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().code).toBe("NEWS_ITEM_NOT_FOUND");
  });
});

describe("слежения", () => {
  it("статистика: happy, нормализация (отрицательные/дробные → 0, неизвестные типы отбрасываются)", async () => {
    const { s } = await loginAs(h, "analyst");
    expect((await call("GET", STATS, s)).json()).toEqual(watchStatsRow());
    h.fake.on("watch", "GET", "/internal/v1/watches:stats", () =>
      json(200, { active: -1, paused: 2.5, changes_24h: { price_drop: 3, teleport: 9 }, notifications_24h: "много", next_batch_at: "скоро", secret: "s3" }),
    );
    const res = await call("GET", STATS, s);
    expect(res.json()).toEqual({
      active: 0,
      paused: 0,
      ended_24h: 0,
      rechecks_24h: 0,
      changes_24h: { price_drop: 3, price_rise: 0, lifecycle: 0, tickets: 0, flight: 0, hotel: 0 },
      notifications_24h: { immediate: 0, digest: 0, suppressed: 0 },
      errors_24h: 0,
      next_batch_at: null,
    });
    h.fake.on("watch", "GET", "/internal/v1/watches:stats", () => json(200, [1, 2]));
    expect((await call("GET", STATS, s)).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "watch" } });
  });

  it("watch недоступен → 503 UPSTREAM_UNAVAILABLE {watch}", async () => {
    h.fake.down.add("watch");
    const { s } = await loginAs(h, "analyst");
    expect((await call("GET", STATS, s)).json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "watch" } });
  });
});

describe("NEWS_URL / WATCH_URL не заданы", () => {
  it("разделы → 503 FEATURE_UNAVAILABLE с понятным текстом {service}; остальная админка работает; WARNING при старте", async () => {
    const bare = await makeHarness({}, {}, (c) => {
      c.urls.news = null;
      c.urls.watch = null;
      c.unconfigured = ["NEWS_URL", "WATCH_URL"];
    });
    try {
      const { s } = await loginAs(bare, "operations");
      for (const [m, url, body] of [
        ["GET", SOURCES],
        ["GET", ITEMS],
        ["POST", `${SOURCE}/check`, {}],
      ] as Array<[Method, string, unknown?]>) {
        const res = await bare.app.inject({ method: m, url, headers: browser(s), ...(body ? { payload: body as object } : {}) });
        expect(res.statusCode, url).toBe(503);
        expect(res.json(), url).toMatchObject({ code: "FEATURE_UNAVAILABLE", message: "Раздел ещё не настроен: сервис новостей (news) не подключён к админке", details: { service: "news" } });
      }
      const stats = await bare.app.inject({ method: "GET", url: STATS, headers: browser(s) });
      expect(stats.json()).toMatchObject({ code: "FEATURE_UNAVAILABLE", message: "Раздел ещё не настроен: сервис слежений (watch) не подключён к админке", details: { service: "watch" } });
      expect((await bare.app.inject({ method: "GET", url: "/admin/v1/me", headers: browser(s) })).statusCode).toBe(200);
      expect(bare.logs.text).toMatch(/sprint 4-7 domain urls are not configured/);
      expect(bare.fake.callsTo("news")).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });
});

describe("нормализаторы", () => {
  it("исправление 6.1: disabled_reason, last_probe_at, last_probe_result", () => {
    const probe = { ok: false, code: "STALE", fetched: 20, accepted: 18, newest_at: "2026-09-01T00:00:00Z", enabled: false, secret: "x" };
    const off = normalizeNewsSource(newsSourceRow({ enabled: false, disabled_reason: "stale", last_probe_at: "2026-10-12T06:00:00Z", last_probe_result: probe }))!;
    expect(off).toMatchObject({ disabled_reason: "stale", last_probe_at: "2026-10-12T06:00:00Z", last_probe_result: { ok: false, code: "STALE", fetched: 20, accepted: 18, newest_at: "2026-09-01T00:00:00Z", enabled: false } });
    expect(off.last_probe_result).not.toHaveProperty("secret");
    // у включённой ленты причины нет; неизвестная причина — null; старый news без полей — null
    expect(normalizeNewsSource(newsSourceRow({ enabled: true, disabled_reason: "legal" }))!.disabled_reason).toBeNull();
    expect(normalizeNewsSource(newsSourceRow({ enabled: false, disabled_reason: "boss" }))!.disabled_reason).toBeNull();
    // исправление 8.1: сайт запрещает загрузку; код причины сбора FEED_* — как есть
    const blocked = normalizeNewsSource(newsSourceRow({ enabled: false, disabled_reason: "blocked",
      health: { last_fetch_at: "2026-10-15T06:00:00Z", last_ok_at: null, last_error: "FEED_HTTP_403", last_error_at: "2026-10-15T06:00:00Z", items_24h: 0 } }))!;
    expect(blocked.disabled_reason).toBe("blocked");
    expect(blocked.health.last_error).toEqual({ code: "FEED_HTTP_403", message: null, at: "2026-10-15T06:00:00Z" });
    for (const r of ["legal", "terms", "stale", "unverified", "manual"]) {
      expect(normalizeNewsSource(newsSourceRow({ enabled: false, disabled_reason: r }))!.disabled_reason, r).toBe(r);
    }
    expect(normalizeNewsSource(newsSourceRow())).toMatchObject({ disabled_reason: null, last_probe_at: null, last_probe_result: null });
    expect(probeOf({ ok: "yes", enabled: false })).toBeNull();
    expect(probeOf({ ok: true, enabled: true, code: "<b>", fetched: -1, newest_at: "вчера" })).toEqual({ ok: true, code: null, fetched: 0, accepted: 0, newest_at: null, enabled: true });
  });

  it("normalizeNewsSource: здоровье на верхнем уровне (старый news), ошибка объектом/плоско; ключевые поля обязательны", () => {
    const flat = normalizeNewsSource({ ...newsSourceRow(), health: undefined, last_fetch_at: "2026-10-11T08:00:00Z", items_24h: 3, last_error_code: "FEED_TOO_LARGE", last_error_at: "2026-10-11T08:00:00Z" });
    expect(flat?.health).toEqual({ last_fetch_at: "2026-10-11T08:00:00Z", last_ok_at: null, last_error: { code: "FEED_TOO_LARGE", message: null, at: "2026-10-11T08:00:00Z" }, items_24h: 3 });
    const obj = normalizeNewsSource(newsSourceRow({ health: { last_error: { code: "SOURCE_FETCH_FAILED", message: "x".repeat(400), at: null } } }));
    expect(obj?.health.last_error?.message).toHaveLength(300);
    for (const broken of [{ version: 0 }, { enabled: "yes" }, { mode: "ftp" }, { display: "full" }, { site_domain: "https://x.uz" }, { name: "   " }]) {
      expect(normalizeNewsSource(newsSourceRow(broken)), JSON.stringify(broken)).toBeNull();
    }
    expect(normalizeNewsSource(newsSourceRow({ feed_url: "https://user:pw@formula1.com/rss" }))?.feed_url).toBeNull();
    expect(normalizeNewsSource(newsSourceRow({ category_filter: "/a b/" }))?.category_filter).toBeNull();
  });

  it("normalizeNewsItem: краткая форма источника, summary {ru,en}, уровень по числу", () => {
    const n = normalizeNewsItem({ ...newsItemRow(), source: undefined, source_id: NEWS_SOURCE_ID, source_name: "F1", summary_ru: undefined, summary_en: undefined, summary: { ru: "Р", en: "E" }, significance: 0.5 });
    expect(n).toMatchObject({ source: { source_id: NEWS_SOURCE_ID, name: "F1", domain: "formula1.com" }, summary_ru: "Р", summary_en: "E", significance_level: "mid" });
    expect(normalizeNewsItem(newsItemRow({ significance: 7 }))).toMatchObject({ significance: null, significance_level: null, below_threshold: false });
    expect(normalizeNewsItem(newsItemRow({ title: "" }))).toBeNull();
    expect(normalizeNewsItem(newsItemRow({ kind: "ad" }))).toBeNull();
    expect(normalizeNewsItem(newsItemRow({ hidden_reason: "забыто", hidden: false }))?.hidden_reason).toBeNull();
  });

  it("normalizeNewsCheck: форма news {ok, error, fetched, accepted, items[{accepted, reason}]}", () => {
    const out = normalizeNewsCheck(
      {
        ok: true,
        error: null,
        fetched: 12,
        accepted: 1,
        items: [
          { url: "https://kun.uz/culture/1", title: "A", published_at: null, accepted: true, reason: null },
          { url: "https://other.uz/x", title: "B", published_at: null, accepted: false, reason: "FOREIGN_DOMAIN" },
          { url: "https://kun.uz/sport/2", title: "C", published_at: null, accepted: false, reason: "CATEGORY_FILTER" },
          { url: "https://kun.uz/x", title: "D", published_at: null, accepted: false, reason: null },
        ],
      },
      Date.parse("2026-10-11T10:00:00Z"),
    )!;
    expect(out).toMatchObject({ ok: true, items_total: 12, errors: [] });
    expect(out.items.map((x) => x.dropped)).toEqual([null, "link_foreign", "category_filter", "rejected"]);
    expect(normalizeNewsCheck({ ok: false, error: "SOURCE_FETCH_FAILED", fetched: 0, accepted: 0, items: [] }, 0)).toMatchObject({ ok: false, errors: [{ code: "SOURCE_FETCH_FAILED" }] });
    // здоровье news: last_error — код, время — последний сбор
    expect(normalizeNewsSource(newsSourceRow({ health: { last_fetch_at: "2026-10-11T08:00:00Z", last_ok_at: null, last_error: "FEED_INVALID", items_24h: 0, last_new_items: 0 } }))?.health.last_error).toEqual({ code: "FEED_INVALID", message: null, at: "2026-10-11T08:00:00Z" });
  });

  it("normalizeNewsCheck: краткая форма ошибок, ≤ 10 записей, время по умолчанию — сейчас", () => {
    const now = Date.parse("2026-10-11T10:00:00Z");
    const many = Array.from({ length: 30 }, (_, i) => ({ url: `https://a.uz/${i}`, title: `T${i}` }));
    const out = normalizeNewsCheck({ items: many, error: "FEED_INVALID" }, now)!;
    expect(out).toMatchObject({ ok: false, items_total: 30, errors: [{ code: "FEED_INVALID", message: null }], checked_at: "2026-10-11T10:00:00.000Z" });
    expect(out.items).toHaveLength(10);
    expect(normalizeNewsCheck({ items: many.slice(0, 2), errors: ["X_Y"] }, now)).toMatchObject({ ok: false, errors: [{ code: "X_Y" }] });
    expect(normalizeNewsCheck({ items: many.slice(0, 2) }, now)?.ok).toBe(true);
    expect(normalizeNewsCheck("x", now)).toBeNull();
  });

  it("checkFeedFields и normalizeWatchStats — граничные случаи", () => {
    expect(() => checkFeedFields({ mode: "rss", feed_url: "https://news.kun.uz/rss", site_domain: "kun.uz", extra_domains: [] }, true)).not.toThrow();
    expect(() => checkFeedFields({ mode: "rss", feed_url: "https://kun.uz.evil.com/rss", site_domain: "kun.uz", extra_domains: [] }, true)).toThrow();
    expect(() => checkFeedFields({ mode: "rss", feed_url: "https://notkun.uz/rss", site_domain: "kun.uz", extra_domains: [] }, true)).toThrow();
    expect(() => checkFeedFields({ name: "x" }, false)).not.toThrow();
    expect(normalizeWatchStats(null)).toBeNull();
    expect(normalizeWatchStats({})?.changes_24h).toEqual({ price_drop: 0, price_rise: 0, lifecycle: 0, tickets: 0, flight: 0, hotel: 0 });
  });
});
