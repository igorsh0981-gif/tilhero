/**
 * Исправление 9.1 (источники Алматы): тип страницы афиши «Telegram-канал» и приоритет проходят в source-registry
 * и обратно; причина автоматического выключения (robots.txt) — в ответе; старый реестр без новых полей не ломает ответ.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { browser, closeRedis, fakeSprint4, json, loginAs, makeHarness, SOURCE_ID, sourceRow, stepUp, type Harness, type Session } from "./helpers.js";

let h: Harness;
let s: Session;
beforeEach(async () => {
  h = await makeHarness();
  fakeSprint4(h.fake);
  s = (await loginAs(h, "operations")).s;
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const send = (method: "GET" | "POST" | "PATCH", url: string, payload?: Record<string, unknown>, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, headers: browser(s, headers), ...(payload !== undefined ? { payload } : {}) });

const TG_SOURCE = {
  slug: "tg-sxodim-almaty",
  name: "Давай Сходим! Алматы (Telegram)",
  country_code: "KZ",
  tier: "TRUSTED_MEDIA",
  event_domains: ["t.me", "sxodim.com"],
  media_domains: [],
  listing_pages: [{ url: "https://t.me/s/sxodim", city: "Almaty", category: null, kind: "telegram", priority: "low" }],
  enabled: true,
  js_only: false,
  notes: null,
  reason: "Telegram-канал афиши Алматы",
};

describe("9.1: Telegram-канал и приоритет страниц", () => {
  it("создание: kind и priority — в теле source-registry", async () => {
    await stepUp(h, s);
    const res = await send("POST", "/admin/v1/sources", TG_SOURCE, { "idempotency-key": "src-create-tg-01" });
    expect(res.statusCode).toBe(201);
    const call = h.fake.callsTo("sourceRegistry", "POST", "/internal/v1/sources")[0]!;
    expect(call.body).toEqual(TG_SOURCE);
  });

  it("без kind/priority (клиент до 9.1) — допустимо; неизвестный тип или приоритет — 422, домен не вызывается", async () => {
    await stepUp(h, s);
    const old = { ...TG_SOURCE, slug: "kassir-kz", event_domains: ["kassir.kz"], listing_pages: [{ url: "https://kassir.kz/a", city: null, category: null }] };
    expect((await send("POST", "/admin/v1/sources", old)).statusCode).toBe(201);
    for (const page of [
      { ...TG_SOURCE.listing_pages[0], kind: "rss" },
      { ...TG_SOURCE.listing_pages[0], priority: "high" },
      { ...TG_SOURCE.listing_pages[0], kind: null },
    ]) {
      const res = await send("POST", "/admin/v1/sources", { ...TG_SOURCE, listing_pages: [page] });
      expect(res.statusCode, JSON.stringify(page)).toBe(422);
      expect(res.json().code).toBe("VALIDATION_ERROR");
    }
    expect(h.fake.callsTo("sourceRegistry", "POST")).toHaveLength(1);
  });

  it("ответ: kind, priority и disabled_reason; старый реестр без полей — без них", async () => {
    const tg = sourceRow({ slug: "tg-sxodim-almaty", enabled: false, disabled_reason: "robots", listing_pages: TG_SOURCE.listing_pages });
    h.fake.on("sourceRegistry", "GET", "/internal/v1/sources", () => json(200, { items: [tg, sourceRow()], next_cursor: null }));
    const items = (await send("GET", "/admin/v1/sources")).json().items;
    expect(items[0]).toMatchObject({ enabled: false, disabled_reason: "robots", listing_pages: TG_SOURCE.listing_pages });
    expect(items[1].listing_pages).toEqual([{ url: "https://iticket.uz/events", city: "Tashkent", category: null }]);
    expect("disabled_reason" in items[1]).toBe(false);
    h.fake.on("sourceRegistry", "GET", `/internal/v1/sources/${SOURCE_ID}`, () => json(200, { ...tg, changes: [] }));
    const card = (await send("GET", `/admin/v1/sources/${SOURCE_ID}`)).json();
    expect(card.disabled_reason).toBe("robots");
    expect(card.listing_pages[0]).toEqual(TG_SOURCE.listing_pages[0]);
  });

  it("PATCH только приоритета страниц — без step-up (страницы не поле доверия)", async () => {
    const res = await send("PATCH", `/admin/v1/sources/${SOURCE_ID}`, {
      expected_version: 3,
      listing_pages: [{ url: "https://iticket.uz/events", city: "Tashkent", category: null, kind: "html", priority: "low" }],
      reason: "мало событий",
    });
    expect(res.statusCode).toBe(200);
    expect(h.fake.callsTo("sourceRegistry", "PATCH")[0]!.body).toMatchObject({ listing_pages: [{ priority: "low", kind: "html" }] });
  });
});
