/**
 * Спринт 5 (docs/sprint5/INTERNAL_API.md §5): поставщики поездок (provider-gateway) и снимок предложения (offers).
 * 401/403, happy path через подделки доменов, 404/422/503, недоверенные ответы доменов (мусор, чужие схемы ссылок,
 * управляющие символы, лишние поля).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_URL, cleanText, normalizeOfferSnapshot, normalizeTravelProviders, safeHttps } from "../src/routes/travel.js";
import {
  OFFER_ID,
  OFFER_USER_ID,
  browser,
  closeRedis,
  domainError,
  fakeSprint5,
  json,
  loginAs,
  makeHarness,
  offerSnapshotRow,
  providerStatusRow,
  type Harness,
} from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  fakeSprint5(h.fake);
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const PROVIDERS = "/admin/v1/travel/providers";
const OFFER = `/admin/v1/offers/${OFFER_ID}`;
const GW = "/internal/v1/providers";
const SNAP = `/internal/v1/offers/${OFFER_ID}`;

const get = (url: string, s?: { id: string; csrf: string } | null) => h.app.inject({ method: "GET", url, headers: browser(s) });

describe("GET /admin/v1/travel/providers", () => {
  it("happy: aviasales, liteapi, osm по порядку из provider-gateway (с actor), прочие поставщики не попадают", async () => {
    const { staff, s } = await loginAs(h, "analyst");
    const res = await get(PROVIDERS, s);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        { name: "aviasales", configured: true, enabled: true, quota: { day_used: 412, day_limit: 20000 }, breaker: "closed", last_error: null, last_success_at: "2026-10-11T06:58:00Z", last_route_error: null },
        { name: "liteapi", configured: true, enabled: true, quota: { day_used: 412, day_limit: 20000 }, breaker: "open", last_error: { code: "PROVIDER_UNAVAILABLE", reason: null, message: null, at: "2026-10-11T06:50:00Z", http_status: null }, last_success_at: "2026-10-11T06:58:00Z", last_route_error: null },
        { name: "osm", configured: false, enabled: true, quota: { day_used: 0, day_limit: 2000 }, breaker: "closed", last_error: null, last_success_at: null, last_route_error: null },
        // исправление 5.1: cbu — строки у этого gateway нет → configured:false
        { name: "cbu", configured: false, enabled: false, quota: null, breaker: "closed", last_error: null, last_success_at: null, last_route_error: null },
      ],
    });
    const call = h.fake.callsTo("providerGateway", "GET", GW)[0]!;
    expect(call.actor?.id).toBe(staff.staff_id);
    expect(call.actor?.permissions).toContain("dashboard.read");
  });

  it("нет строки поставщика (gateway ещё без travel-адаптеров) → configured:false", async () => {
    h.fake.on("providerGateway", "GET", GW, () => json(200, [providerStatusRow({ provider: "ticketmaster" })]));
    const { s } = await loginAs(h, "read_only");
    const res = await get(PROVIDERS, s);
    expect(res.statusCode).toBe(200);
    for (const it of res.json().items) {
      expect(it).toEqual({ name: it.name, configured: false, enabled: false, quota: null, breaker: "closed", last_error: null, last_success_at: null, last_route_error: null });
    }
    expect(res.json().items.map((x: { name: string }) => x.name)).toEqual(["aviasales", "liteapi", "osm", "cbu"]);
  });

  it("401 без сессии, 403 без dashboard.read — домен не вызывается", async () => {
    expect((await get(PROVIDERS)).statusCode).toBe(401);
    const { s } = await loginAs(h, "read_only", { permissions: [] });
    const res = await get(PROVIDERS, s);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "dashboard.read" } });
    expect(h.fake.callsTo("providerGateway")).toHaveLength(0);
  });

  it("provider-gateway недоступен → 503 UPSTREAM_UNAVAILABLE; без PROVIDER_GATEWAY_URL → 503 FEATURE_UNAVAILABLE", async () => {
    const { s } = await loginAs(h, "analyst");
    h.fake.down.add("providerGateway");
    const down = await get(PROVIDERS, s);
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "provider-gateway" } });

    const bare = await makeHarness({}, {}, (c) => {
      c.urls.providerGateway = null;
      c.unconfigured = ["PROVIDER_GATEWAY_URL"];
    });
    try {
      const op = await loginAs(bare, "operations");
      const res = await bare.app.inject({ method: "GET", url: PROVIDERS, headers: browser(op.s) });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "FEATURE_UNAVAILABLE", details: { service: "provider-gateway" } });
    } finally {
      await bare.close();
    }
  });

  it("недоверенный ответ: мусор в полях приводится к контракту, лишние поля не проходят", async () => {
    h.fake.on("providerGateway", "GET", GW, () =>
      json(200, {
        items: [
          providerStatusRow({ quota: { day_used: -1, day_limit: 10 }, breaker: "melted", last_success_at: "вчера", configured: "yes", enabled: 1, token: "secret-token" }),
          providerStatusRow({ provider: "aviasales", breaker: "open" }), // дубль — первая строка
          providerStatusRow({ provider: "liteapi", last_error_code: "<script>alert(1)</script>", last_error_at: "2026-10-11T06:50:00Z" }),
          providerStatusRow({ provider: "osm", last_error: { code: "PROVIDER_RATE_LIMITED", at: "2026-10-11T05:00:00Z" }, last_error_code: null, quota: "много" }),
          "строка",
          null,
        ],
      }),
    );
    const { s } = await loginAs(h, "analyst");
    const res = await get(PROVIDERS, s);
    expect(res.statusCode).toBe(200);
    const [av, lite, osm] = res.json().items;
    expect(av).toEqual({ name: "aviasales", configured: false, enabled: false, quota: null, breaker: "closed", last_error: null, last_success_at: null, last_route_error: null });
    expect(lite.last_error).toBeNull();
    expect(osm).toMatchObject({ quota: null, last_error: { code: "PROVIDER_RATE_LIMITED", reason: null, message: null, at: "2026-10-11T05:00:00Z", http_status: null } });
    expect(res.body).not.toContain("secret-token");
  });

  it("normalizeTravelProviders: не список → все не настроены; код без времени → at: null", () => {
    for (const body of [null, "x", 42, { items: "x" }]) {
      expect(normalizeTravelProviders(body).items.every((x) => !x.configured)).toBe(true);
    }
    const out = normalizeTravelProviders([providerStatusRow({ provider: "osm", last_error_code: "PROVIDER_NOT_CONFIGURED", last_error_at: undefined })]);
    expect(out.items[2]!.last_error).toEqual({ code: "PROVIDER_NOT_CONFIGURED", reason: null, message: null, at: null, http_status: null });
    expect(normalizeTravelProviders([{ name: "liteapi", configured: true, enabled: true, breaker: "half_open" }]).items[1]).toMatchObject({ configured: true, breaker: "half_open", quota: null });
  });
});

describe("GET /admin/v1/offers/:offerId", () => {
  it("happy: снимок с user_id, offers вызывается с actor сотрудника (support.read)", async () => {
    const { staff, s } = await loginAs(h, "support");
    const res = await get(OFFER, s);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({ offer_id: OFFER_ID, user_id: OFFER_USER_ID, tier: "comfort", travellers: 2, departure: { iata: "TAS", city: "Ташкент", chosen_by: "cheapest" }, notes: [] });
    expect(b.offer).toMatchObject({
      status: "complete",
      ticket: { status: "ok", price_per_person: "85.00", currency: "USD", in_total: true, provider: "ticketmaster" },
      flight: { status: "ok", origin: "TAS", destination: "ALA", transfers: 0, total: "284.00", deeplink: expect.stringMatching(/^https:\/\/www\.aviasales\.com\//) },
      hotel: { status: "ok", name: "Rixos Almaty", stars: 5, rating: "9.1", distance_m: 1830, total: "390.00", nights: 3, rooms: 1 },
      totals: { total: "844.00", per_person: "422.00", currency: "USD", missing: [] },
    });
    expect(b.offer.hotel).not.toHaveProperty("photo_url");
    expect(b.trip).toMatchObject({ kind: "trip", out_date: "2026-11-13", back_date: "2026-11-16", nights: 3, destination: { city: "Алматы", iata: "ALA", venue: { name: "Almaty Arena", precision: "venue" } } });
    const call = h.fake.callsTo("offers", "GET", SNAP)[0]!;
    expect(call.actor?.id).toBe(staff.staff_id);
    expect(call.actor?.permissions).toContain("support.read");
  });

  it("401 без сессии; 403 без support.read — offers не вызывается", async () => {
    expect((await get(OFFER)).statusCode).toBe(401);
    const { s } = await loginAs(h, "analyst"); // dashboard.read, users.read — без support.read
    const res = await get(OFFER, s);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "PERMISSION_DENIED", details: { permission: "support.read" } });
    expect(h.fake.callsTo("offers")).toHaveLength(0);
  });

  it("404: снимка нет (удалён по сроку) → OFFER_NOT_FOUND; любой 404 домена — тот же код", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("offers", "GET", SNAP, () => domainError(404, "OFFER_NOT_FOUND"));
    const res = await get(OFFER, s);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "OFFER_NOT_FOUND", message: "Снимок предложения не найден" });
    h.fake.on("offers", "GET", SNAP, () => domainError(404, "NOT_FOUND"));
    expect((await get(OFFER, s)).json().code).toBe("OFFER_NOT_FOUND");
  });

  it("offer_id не UUID → 422 VALIDATION_ERROR, offers не вызывается; UUID в верхнем регистре — нижний в домен", async () => {
    const { s } = await loginAs(h, "support");
    for (const bad of ["off_987", "..%2F..%2Fadmin", `${OFFER_ID}x`, "0ffe0000-0000-4000-8000-00000000000g"]) {
      const res = await get(`/admin/v1/offers/${bad}`, s);
      expect(res.statusCode, bad).toBe(422);
      expect(res.json().code).toBe("VALIDATION_ERROR");
    }
    expect(h.fake.callsTo("offers")).toHaveLength(0);
    expect((await get(`/admin/v1/offers/${OFFER_ID.toUpperCase()}`, s)).statusCode).toBe(200);
    expect(h.fake.callsTo("offers")[0]!.path).toBe(SNAP);
  });

  it("503: без OFFERS_URL — FEATURE_UNAVAILABLE {service: offers}; offers недоступен — UPSTREAM_UNAVAILABLE", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.down.add("offers");
    const down = await get(OFFER, s);
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "offers" } });

    const bare = await makeHarness({}, {}, (c) => {
      c.urls.offers = null;
      c.unconfigured = ["OFFERS_URL"];
    });
    try {
      expect(bare.logs.text).toContain("OFFERS_URL");
      const sup = await loginAs(bare, "support");
      const res = await bare.app.inject({ method: "GET", url: OFFER, headers: browser(sup.s) });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "FEATURE_UNAVAILABLE", message: "Раздел ещё не настроен", details: { service: "offers" } });
      expect(bare.fake.callsTo("offers")).toHaveLength(0);
      // остальная поддержка работает
      expect((await bare.app.inject({ method: "GET", url: "/admin/v1/support/tickets", headers: browser(sup.s) })).statusCode).toBe(200);
    } finally {
      await bare.close();
    }
  });

  it("отказ offers во внутренней авторизации (ACTOR_NOT_ALLOWED) → 503, а не 401/403 сотруднику", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("offers", "GET", SNAP, () => domainError(403, "ACTOR_NOT_ALLOWED"));
    const res = await get(OFFER, s);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "offers" } });
  });

  it("недоверенный ответ: ссылки только https, управляющие символы вычищены, испорченный компонент — BAD_DATA", async () => {
    const { s } = await loginAs(h, "support");
    h.fake.on("offers", "GET", SNAP, () =>
      json(
        200,
        offerSnapshotRow(
          { notes: ["FLIGHT_DATES_SHIFTED", "<b>x</b>", 5, "FLIGHT_DATES_SHIFTED"], raw_provider_payload: { token: "secret-token" } },
          {
            status: "partial",
            ticket: { status: "ok", price_per_person: "850000.00", currency: "UZS", in_total: true, provider: "aiweb.iticket-uz", deeplink: "javascript:alert(1)", fetched_at: "2026-10-11T06:40:00Z" },
            flight: { status: "ok", origin: "TAS", destination: "ALA", price_per_person: "1e9", total: "284.00", depart_at: "2026-11-13T07:40:00+05:00" },
            hotel: {
              status: "ok", name: "Rixos\u0000 ‮Almaty\u0007" + " ".repeat(3) + "x".repeat(400), total: "390.00", stars: 7, rating: "11", distance_m: -5,
              deeplink: "http://book.tilhero.app/hotels/1", map: { osm: "https://www.openstreetmap.org/?mlat=1", google: "https://user:pw@evil.example/x", yandex: "data:text/html,x" },
            },
            totals: { total: "844.00", per_person: "422.00", currency: "USD", missing: ["ticket", "flight", "spa", "ticket"] },
          },
        ),
      ),
    );
    const res = await get(OFFER, s);
    expect(res.statusCode).toBe(200);
    const o = res.json().offer;
    // билет не в USD в сумму не входит, ссылка javascript: отброшена
    expect(o.ticket).toMatchObject({ status: "ok", currency: "UZS", in_total: false, deeplink: null, provider: "aiweb.iticket-uz" });
    // перелёт с ценой не по формату — не показываем выдуманное: BAD_DATA
    expect(o.flight).toEqual({ status: "unavailable", reason: "BAD_DATA" });
    expect(o.hotel.deeplink).toBeNull();
    expect(o.hotel.map).toEqual({ osm: "https://www.openstreetmap.org/?mlat=1" });
    expect(o.hotel.name.startsWith("Rixos Almaty x")).toBe(true);
    expect(o.hotel.name.length).toBeLessThanOrEqual(200);
    expect(o.hotel.name).not.toMatch(/[\u0000-\u001f‮]/);
    expect(o.hotel).toMatchObject({ stars: null, rating: null, distance_m: null });
    expect(o.totals.missing).toEqual(["ticket", "flight"]);
    expect(res.json().notes).toEqual(["FLIGHT_DATES_SHIFTED"]);
    expect(res.body).not.toContain("secret-token");
    expect(res.json()).not.toHaveProperty("raw_provider_payload");
  });

  it("испорченный «скелет» снимка (чужой offer_id, нет tier, не объект) → 503 UPSTREAM_UNAVAILABLE {service: offers}", async () => {
    const { s } = await loginAs(h, "support");
    const bodies = [
      offerSnapshotRow({ offer_id: "0ffe0000-0000-4000-8000-000000000999" }),
      offerSnapshotRow({ tier: "vip" }),
      offerSnapshotRow({ travellers: 7 }),
      offerSnapshotRow({ expires_at: "завтра" }),
      offerSnapshotRow({ offer: "x" }),
      offerSnapshotRow({}, { totals: null }),
      [1, 2],
    ];
    for (const body of bodies) {
      h.fake.on("offers", "GET", SNAP, () => json(200, body));
      const res = await get(OFFER, s);
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(503);
      expect(res.json()).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", details: { service: "offers" } });
    }
    h.fake.on("offers", "GET", SNAP, () => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect((await get(OFFER, s)).statusCode).toBe(503);
  });

  it("недоступные компоненты и trip ticket_only/not_available проходят как есть", () => {
    const snap = normalizeOfferSnapshot(
      offerSnapshotRow(
        { trip: { kind: "ticket_only", reason: "SAME_CITY", destination: null, out_date: null, back_date: null, nights: null }, departure: null },
        { status: "unavailable", flight: { status: "unavailable", reason: "NO_DEPARTURE" }, hotel: { status: "unavailable", reason: "<x>" }, ticket: "x", totals: { total: "0.00", per_person: "0.00", currency: "USD", missing: ["flight", "hotel"] } },
      ),
      OFFER_ID,
    )!;
    expect(snap.offer).toMatchObject({
      status: "unavailable",
      flight: { status: "unavailable", reason: "NO_DEPARTURE" },
      hotel: { status: "unavailable", reason: "BAD_DATA" },
      ticket: { status: "unavailable", reason: "BAD_DATA" },
    });
    expect(snap.trip).toEqual({ kind: "ticket_only", reason: "SAME_CITY", destination: null, out_date: null, back_date: null, nights: null });
    expect(snap.departure).toBeNull();
  });

  it("safeHttps / cleanText: граничные случаи", () => {
    expect(safeHttps("https://www.aviasales.com/search/TAS1311ALA16111?marker=1")).toBe("https://www.aviasales.com/search/TAS1311ALA16111?marker=1");
    for (const bad of ["http://x.com", "javascript:alert(1)", "data:text/html,1", "https://localhost/x", "https://a b.com", "//evil.com", "https://u:p@x.com", `https://x.com/${"a".repeat(MAX_URL)}`, 42, null]) {
      expect(safeHttps(bad), String(bad)).toBeNull();
    }
    expect(cleanText("  a\u0000\nb‮  ", 10)).toBe("a b");
    expect(cleanText("\u0000\u0001", 10)).toBeNull();
    expect(cleanText("abcdefghijk", 5)).toBe("abcd…");
  });
});
