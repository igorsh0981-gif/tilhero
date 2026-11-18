import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Permission, RoleCode } from "@tilhero/contracts/admin";
import { homePage, NAV_ITEMS, orderedItems, pageAllowed, visibleNav } from "../src/state/nav";
import { parseHash, routeHash } from "../src/state/route";
import { parseNewsRoute } from "../src/screens/news/News";

/** Default matrix (docs/sprint2/PLAN.md «Роли и права»). */
const ALL: Permission[] = [
  "dashboard.read", "users.read", "users.sensitive.read", "support.read", "support.reply", "support.manage", "audit.read", "config.read",
  "config.edit", "config.publish", "whatsnew.manage", "whatsnew.publish", "notif.templates.manage", "notif.campaigns.manage",
  "notif.campaigns.send", "staff.manage", "roles.manage",
];
const MATRIX: Record<RoleCode, Permission[]> = {
  super_admin: ALL,
  operations: ["dashboard.read", "users.read", "support.read", "config.read", "config.edit", "config.publish", "audit.read"],
  communications: ["dashboard.read", "whatsnew.manage", "whatsnew.publish", "notif.templates.manage", "notif.campaigns.manage", "notif.campaigns.send"],
  support: ["dashboard.read", "users.read", "support.read", "support.reply"],
  methodist: ["dashboard.read", "users.read"],
  analyst: ["dashboard.read", "users.read"],
  auditor: ["dashboard.read", "audit.read"],
  read_only: ["dashboard.read"],
};
const SOON = ["content", "agents", "qa", "costs", "heroes", "game", "events", "langs"];
const ids = (role: RoleCode, menu?: Array<{ id: string; enabled: boolean }>) => visibleNav(new Set(MATRIX[role]), menu).flatMap((g) => g.items.map((i) => i.id));
const live = (role: RoleCode) => ids(role).filter((x) => !SOON.includes(x));

describe("menu: 15 sections of the experience-config seed, filtered by role (UX only — admin-bff re-checks)", () => {
  it("the menu ids are exactly the admin seed (services/experience-config 0002_seed.py) and the payload whitelist", () => {
    const seed = readFileSync(resolve(__dirname, "../../../services/experience-config/migrations/versions/0002_seed.py"), "utf8");
    const m = seed.match(/for m in \(\s*([\s\S]*?)\)\]/);
    const fromSeed = [...(m?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
    expect(NAV_ITEMS.map((i) => i.id)).toEqual(fromSeed);
    expect(fromSeed).toHaveLength(15);
  });
  it("super_admin sees every section in the prototype order and groups", () => {
    expect(ids("super_admin")).toEqual(["overview", "users", "content", "agents", "qa", "costs", "heroes", "game", "events", "news", "support", "config", "langs", "roles", "audit"]);
    expect(visibleNav(new Set(ALL)).map((g) => g.group)).toEqual(["product", "ai", "game", "comms", "manage"]);
  });
  it("live sections per role", () => {
    expect(live("operations")).toEqual(["overview", "users", "support", "config", "audit"]);
    expect(live("communications")).toEqual(["overview", "news"]);
    expect(live("support")).toEqual(["overview", "users", "support"]);
    expect(live("methodist")).toEqual(["overview", "users"]);
    expect(live("auditor")).toEqual(["overview", "audit"]);
    expect(live("read_only")).toEqual(["overview"]);
  });
  it("«news» opens with any communications right; roles with staff.manage OR roles.manage", () => {
    for (const p of ["whatsnew.manage", "notif.templates.manage", "notif.campaigns.manage"] as Permission[]) expect(pageAllowed("news", new Set([p]))).toBe(true);
    expect(pageAllowed("news", new Set<Permission>(["whatsnew.publish"]))).toBe(false);
    expect(pageAllowed("roles", new Set<Permission>(["roles.manage"]))).toBe(true);
    expect(pageAllowed("roles", new Set<Permission>(["staff.manage"]))).toBe(true);
    expect(pageAllowed("nope", new Set(ALL))).toBe(false);
  });
  it("«soon» sections carry the sprint number of the plan", () => {
    const soon = Object.fromEntries(NAV_ITEMS.filter((i) => i.soon).map((i) => [i.id, i.soon]));
    expect(soon).toEqual({ content: 3, langs: 3, agents: 4, qa: 4, costs: 4, heroes: 6, game: 6, events: 6 });
  });
  it("the start screen is the first live section", () => {
    expect(homePage(new Set(MATRIX.communications))).toBe("overview");
    expect(homePage(new Set<Permission>(["support.read"]))).toBe("support");
    expect(homePage(new Set<Permission>([]))).toBeNull();
  });
});

describe("menu order and switches from the active admin config (layout.menu)", () => {
  it("follows the config order; switched-off sections are hidden and closed by link", () => {
    const menu = [
      { id: "support", enabled: true },
      { id: "overview", enabled: true },
      { id: "content", enabled: false },
      { id: "users", enabled: true },
      { id: "bogus", enabled: true },
    ];
    const o = orderedItems(menu).map((i) => i.id);
    expect(o.slice(0, 3)).toEqual(["support", "overview", "users"]);
    expect(o).not.toContain("content");
    expect(o).not.toContain("bogus");
    expect(o).toContain("audit"); // not mentioned → default order at the end
    expect(pageAllowed("content", new Set(ALL), menu)).toBe(false);
    // groups follow the first appearance of their sections
    expect(visibleNav(new Set(ALL), menu).map((g) => g.group).slice(0, 2)).toEqual(["comms", "product"]);
  });
  it("an empty menu falls back to the defaults", () => {
    expect(orderedItems([]).map((i) => i.id)).toEqual(NAV_ITEMS.map((i) => i.id));
    expect(orderedItems(null)).toHaveLength(15);
  });
});

describe("hash routes", () => {
  it("parses and builds page/id routes", () => {
    expect(parseHash("#/support/TCK-1042")).toEqual({ page: "support", id: "TCK-1042" });
    expect(parseHash("#/news/templates/reminder.lesson")).toEqual({ page: "news", id: "templates/reminder.lesson" });
    expect(routeHash("users", "a1000000-0000-4000-8000-000000000001")).toBe("#/users/a1000000-0000-4000-8000-000000000001");
    expect(parseHash("#/<script>")).toEqual({ page: "script", id: null });
  });
  it("news tabs: #/news/<tab>[/<id>]", () => {
    expect(parseNewsRoute(null)).toEqual({ tab: null, id: null });
    expect(parseNewsRoute("templates")).toEqual({ tab: "templates", id: null });
    expect(parseNewsRoute("templates/reminder.lesson")).toEqual({ tab: "templates", id: "reminder.lesson" });
    expect(parseNewsRoute("campaigns/e1000000-0000-4000-8000-000000000003")).toEqual({ tab: "campaigns", id: "e1000000-0000-4000-8000-000000000003" });
    expect(parseNewsRoute("bogus/x")).toEqual({ tab: null, id: null });
  });
});
