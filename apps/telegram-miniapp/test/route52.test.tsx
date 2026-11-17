/**
 * Fix 5.2 (prod 11.10.2026 21:11: Tashkent → Bishkek, Aviasales «unknown location code `FRU`»): the flight row says
 * honestly that the supplier does not know the route and links to the Aviasales search — no «Попробовать снова».
 */
import type { EventDetailView, Profile } from "@tilhero/contracts/bff";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as F from "../e2e/fixtures/data";
import { buildOfferSet, type OfferBuildOpts } from "../e2e/fixtures/offers";
import type { Api } from "../src/api/endpoints";
import { I18nProvider, type Lang } from "../src/i18n";
import { TripBlock, TripBoundary } from "../src/screens/events/Trip";
import { AppContext, type AppCtx } from "../src/state/app";
import { hasProviderFailure, routeSearchLink, unavailableKey } from "../src/trip/logic";

const BISHKEK = F.tripEvents()[4]!;
const SEARCH_RE = /^https:\/\/www\.aviasales\.com\/search\/TAS\d{4}FRU\d{4}1$/;

const opts = (o: Partial<OfferBuildOpts> = {}): OfferBuildOpts => ({
  travellers: 1,
  departures: F.filledPreferences().departures,
  flightPrefs: { direct: true, connecting: true, alternative_departure: true },
  overrides: {},
  seq: 7,
  ...o,
});
const bishkekSet = (o: Partial<OfferBuildOpts> = {}) => buildOfferSet(BISHKEK, opts(o));

function renderTrip(offers: Partial<Api["offers"]>, o: { lang?: Lang; ev?: EventDetailView } = {}) {
  const api = { offers, profile: {}, directory: { airports: async () => ({ items: [] }) } } as unknown as Api;
  const prof = { preferences: { ...F.filledPreferences() } } as unknown as Profile;
  const ctx = { api, navigate: vi.fn(), profile: prof, reloadProfile: vi.fn(async () => null) } as unknown as AppCtx;
  return render(
    <I18nProvider initial={o.lang ?? "ru"}>
      <AppContext.Provider value={ctx}>
        <TripBoundary>
          <TripBlock ev={o.ev ?? BISHKEK} />
        </TripBoundary>
      </AppContext.Provider>
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("fix 5.2: flight route unknown to the supplier", () => {
  it("logic: honest text key, link only for ROUTE_NOT_SUPPORTED over https, not a provider failure", () => {
    expect(unavailableKey("flight", "ROUTE_NOT_SUPPORTED", false, true)).toBe("tr.na.flight.ROUTE_NOT_SUPPORTED");
    expect(unavailableKey("flight", "ROUTE_NOT_SUPPORTED")).toBe("tr.na.flight.ROUTE_NOT_SUPPORTED.noLink");
    expect(routeSearchLink({ status: "unavailable", reason: "ROUTE_NOT_SUPPORTED", search_url: "https://www.aviasales.com/search/TAS1710FRU19101" })).toBe(
      "https://www.aviasales.com/search/TAS1710FRU19101",
    );
    expect(routeSearchLink({ status: "unavailable", reason: "ROUTE_NOT_SUPPORTED", search_url: "javascript:alert(1)" })).toBe("");
    expect(routeSearchLink({ status: "unavailable", reason: "NO_PRICE", search_url: "https://www.aviasales.com/search/x" })).toBe("");
    expect(hasProviderFailure(bishkekSet({ flightRouteUnknown: true }))).toBe(false);
  });

  it("the row says the supplier does not know the route, links to the Aviasales search, no retry", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const recalculate = vi.fn();
    renderTrip({ get: vi.fn(async () => bishkekSet({ flightRouteUnknown: true })), recalculate });
    const row = await screen.findByTestId("trip-row-flight");
    expect(row).toHaveAttribute("data-status", "unavailable");
    expect(row).toHaveTextContent("Поставщик не знает этот маршрут — посмотрите билеты на Aviasales");
    expect(row).not.toHaveTextContent("Сервис перелётов не ответил");
    expect(within(row).queryByTestId("flight-retry")).toBeNull();
    const btn = within(row).getByTestId("flight-search");
    expect(btn).toHaveTextContent("Билеты на Aviasales");
    expect(btn).toHaveAccessibleName("Билеты на Aviasales: откроется aviasales.com");
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toMatch(SEARCH_RE);
    expect(recalculate).not.toHaveBeenCalled();
    expect(screen.getByTestId("pass-total-label")).toHaveTextContent("без перелёта");
    open.mockRestore();
  });

  it("without a link: honest text, no button; English", async () => {
    renderTrip({ get: vi.fn(async () => bishkekSet({ flightRouteUnknown: "nolink" })) });
    const row = await screen.findByTestId("trip-row-flight");
    expect(row).toHaveTextContent("Поставщик не знает этот маршрут — поищите билеты на сайте авиакомпании или Aviasales");
    expect(within(row).queryByTestId("flight-search")).toBeNull();
    expect(within(row).queryByTestId("flight-retry")).toBeNull();
    cleanup();
    renderTrip({ get: vi.fn(async () => bishkekSet({ flightRouteUnknown: true, lang: "en" })) }, { lang: "en" });
    const en = await screen.findByTestId("trip-row-flight");
    expect(en).toHaveTextContent("The supplier does not know this route — see tickets on Aviasales");
    expect(within(en).getByTestId("flight-search")).toHaveTextContent("Tickets on Aviasales");
  });
});
