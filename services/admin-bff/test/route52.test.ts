/**
 * Исправление 5.2 (prod 11.10.2026: TAS → FRU, Aviasales «unknown location code `FRU`»): provider-gateway отдаёт
 * в строке поставщика `last_route_error` — ошибка маршрута отдельно от `last_error` (на здоровье не влияет).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { browser, closeRedis, fakeSprint5, json, loginAs, makeHarness, providerStatusRow, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  fakeSprint5(h.fake);
});
afterEach(async () => {
  await h?.close();
});
afterAll(closeRedis);

const GW = "/internal/v1/providers";
const get = (s: { id: string; csrf: string }) => h.app.inject({ method: "GET", url: "/admin/v1/travel/providers", headers: browser(s) });

describe("5.2: last_route_error in «Поставщики поездок»", () => {
  it("passes through next to a healthy last_success_at; last_error stays null", async () => {
    h.fake.on("providerGateway", "GET", GW, () =>
      json(200, [
        providerStatusRow({
          provider: "aviasales",
          last_error: null,
          last_error_code: null,
          last_success_at: "2026-10-11T15:46:00Z",
          last_route_error: { code: "ROUTE_NOT_SUPPORTED", location: "FRU", route: "TAS-FRU", at: "2026-10-11T16:11:00Z" },
        }),
      ]),
    );
    const { s } = await loginAs(h, "analyst");
    const res = await get(s);
    expect(res.statusCode).toBe(200);
    const av = res.json().items[0];
    expect(av.last_error).toBeNull();
    expect(av.last_route_error).toEqual({ code: "ROUTE_NOT_SUPPORTED", location: "FRU", route: "TAS-FRU", at: "2026-10-11T16:11:00Z" });
  });

  it("untrusted: garbage fields → null, bad code → no route error; old gateway → null", async () => {
    h.fake.on("providerGateway", "GET", GW, () =>
      json(200, [
        providerStatusRow({ provider: "aviasales", last_route_error: { code: "ROUTE_NOT_SUPPORTED", location: "<b>", route: "TAS→FRU", at: "вчера", extra: "x" } }),
        providerStatusRow({ provider: "liteapi", last_route_error: { code: "<script>", location: "FRU" } }),
        providerStatusRow({ provider: "osm" }),
      ]),
    );
    const { s } = await loginAs(h, "analyst");
    const [av, lite, osm] = (await get(s)).json().items;
    expect(av.last_route_error).toEqual({ code: "ROUTE_NOT_SUPPORTED", location: null, route: null, at: null });
    expect(lite.last_route_error).toBeNull();
    expect(osm.last_route_error).toBeNull();
  });
});
