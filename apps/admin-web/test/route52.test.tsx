import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { TravelProviderStatus } from "@tilhero/contracts/admin";
import { I18nProvider, translate, type Lang } from "../src/i18n";
import { providerState, routeErrorTitle, summary } from "../src/screens/travel/travel";
import { ProviderCard } from "../src/screens/travel/Travel";
import { COMPONENT_REASONS, codeLabel } from "../src/screens/support/offer";

/* Fix 5.2 (prod 11.10.2026: TAS → FRU, Aviasales «unknown location code `FRU`»): a route error is shown as its own
   line «Ошибка маршрута» and does not turn the card into «Последний вызов с ошибкой». */

const ui = (node: ReactNode, lang: Lang = "ru") => render(<I18nProvider initial={lang}>{node}</I18nProvider>);
afterEach(cleanup);

const ROUTE = { code: "ROUTE_NOT_SUPPORTED", location: "FRU", route: "TAS-FRU", at: "2026-10-11T16:11:00Z" };
const prov = (p: Partial<TravelProviderStatus> = {}): TravelProviderStatus => ({
  name: "aviasales",
  configured: true,
  enabled: true,
  quota: { day_used: 412, day_limit: 20000 },
  breaker: "closed",
  last_error: null,
  last_success_at: "2026-10-11T15:46:00Z",
  last_route_error: ROUTE,
  ...p,
});

describe("fix 5.2: route error on «Поставщики поездок»", () => {
  it("a route error after the last success keeps the card healthy", () => {
    expect(providerState(prov())).toBe("ok");
    expect(summary([prov()])).toEqual({ working: 1, total: 1, attention: 0 });
  });

  it("the card shows «Ошибка маршрута» with the code, the route and the time; state stays «Работает»", () => {
    ui(<ProviderCard p={prov()} />);
    const row = screen.getByTestId("trv-route-error-aviasales");
    expect(row).toHaveTextContent("Поставщик не знает код FRU · маршрут TAS → FRU");
    expect(row).toHaveTextContent("Не сбой поставщика");
    expect(screen.getByText("Ошибка маршрута")).toBeInTheDocument();
    expect(screen.queryByText("Последний вызов с ошибкой")).toBeNull();
    expect(screen.getByTestId("trv-last-error-aviasales")).toHaveTextContent("Нет");
  });

  it("no route error (or an old admin-bff without the field) → no line", () => {
    ui(<ProviderCard p={prov({ last_route_error: null })} />);
    expect(screen.queryByTestId("trv-route-error-aviasales")).toBeNull();
    cleanup();
    const old = prov();
    delete old.last_route_error;
    ui(<ProviderCard p={old} />);
    expect(screen.queryByTestId("trv-route-error-aviasales")).toBeNull();
  });

  it("titles without location/route; English", () => {
    const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate("en", k, v);
    expect(routeErrorTitle(t, ROUTE)).toBe("The provider does not know code FRU · route TAS → FRU");
    expect(routeErrorTitle(t, { ...ROUTE, route: null })).toBe("The provider does not know code FRU");
    expect(routeErrorTitle(t, { ...ROUTE, location: null, route: null })).toBe("The provider does not know the route");
  });

  it("support snapshot: ROUTE_NOT_SUPPORTED has a human label", () => {
    expect(COMPONENT_REASONS).toContain("ROUTE_NOT_SUPPORTED");
    const t = (k: Parameters<typeof translate>[1]) => translate("ru", k);
    expect(codeLabel(t, "reason", "ROUTE_NOT_SUPPORTED")).toContain("Поставщик не знает маршрут");
  });
});
