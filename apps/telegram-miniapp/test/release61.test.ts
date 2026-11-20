import { describe, expect, it } from "vitest";
import { GAME_ROUTES, routeAllowed, routeTarget } from "../src/state/nav";
import { isRoute, parseStartParam } from "../src/tg/deeplink";

/** Release 6.1: «Что нового» (and notifications, deep links) lead into the game, the dictionary and reading. */
describe("release 6.1 routes", () => {
  const home = { tab: "home" as const, stack: [] };
  const NEW = ["heroes", "shop", "badges", "game_history", "game_settings", "dictionary", "reading"] as const;

  it("route_<new> parses; unknown routes are not routes", () => {
    for (const r of NEW) {
      expect(isRoute(r)).toBe(true);
      expect(parseStartParam(`route_${r}`)).toEqual({ kind: "route", route: r });
    }
    expect(parseStartParam("route_game")).toBeNull();
    expect(isRoute("gameHistory")).toBe(false);
  });

  it("each opens its screen above the current one; the dictionary is the root of the «Словарь» tab", () => {
    expect(routeTarget("heroes", home)).toEqual({ tab: "home", stack: [{ name: "heroes" }] });
    expect(routeTarget("shop", home).stack).toEqual([{ name: "shop" }]);
    expect(routeTarget("badges", home).stack).toEqual([{ name: "badges" }]);
    expect(routeTarget("game_history", home).stack).toEqual([{ name: "gameHistory" }]);
    expect(routeTarget("game_settings", home).stack).toEqual([{ name: "gameSettings" }]);
    expect(routeTarget("reading", home).stack).toEqual([{ name: "practice", tab: "reading" }]);
    expect(routeTarget("dictionary", { tab: "profile", stack: [{ name: "inbox" }] })).toEqual({ tab: "review", stack: [] });
    // «Назад» from the shop returns to the notification center the link was opened from
    expect(routeTarget("shop", { tab: "home", stack: [{ name: "inbox" }] })).toEqual({ tab: "home", stack: [{ name: "inbox" }, { name: "shop" }] });
    // the same screen is not pushed twice; another practice tab replaces the practice screen
    const onReading = routeTarget("reading", home);
    expect(routeTarget("reading", onReading)).toBe(onReading);
    expect(routeTarget("scenarios", onReading).stack).toEqual([{ name: "practice", tab: "scenarios" }]);
  });

  it("an unknown route leads Home", () => {
    expect(routeTarget("events" as never, { tab: "profile", stack: [{ name: "inbox" }] })).toEqual({ tab: "home", stack: [] });
  });

  it("the game switched off (flag game) — routes into the game lead Home, the rest stay", () => {
    expect([...GAME_ROUTES]).toEqual(["heroes", "shop", "badges", "game_history", "game_settings"]);
    for (const r of GAME_ROUTES) {
      expect(routeAllowed(r, false)).toBe("home");
      expect(routeAllowed(r, true)).toBe(r);
    }
    expect(routeAllowed("dictionary", false)).toBe("dictionary");
    expect(routeAllowed("reading", false)).toBe("reading");
  });
});
