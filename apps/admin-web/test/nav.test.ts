import { describe, expect, it } from "vitest";
import type { Permission, RoleCode } from "@tilhero/contracts/admin";
import { homePage, pageAllowed, visibleNav } from "../src/state/nav";
import { parseHash, routeHash } from "../src/state/route";

/** Default matrix (docs/sprint2/INTERNAL_API.md + sprint 4 §7: operations gets the event-catalog permissions). */
const MATRIX: Record<RoleCode, Permission[]> = {
  super_admin: [
    "dashboard.read", "users.read", "users.sensitive.read", "ai.content.read", "export.csv", "support.read", "support.reply", "support.manage",
    "subscriptions.override", "billing.refund", "skills.edit", "skills.publish", "audit.read", "config.read", "config.edit", "config.publish",
    "ops.kill_switch", "staff.manage", "roles.manage", "events.review", "sources.manage", "discovery.manage", "news.manage", "users.access.manage",
  ],
  operations: ["dashboard.read", "users.read", "support.read", "config.read", "ops.kill_switch", "audit.read", "events.review", "sources.manage", "discovery.manage", "news.manage", "users.access.manage"],
  support: ["dashboard.read", "users.read", "support.read", "support.reply"],
  billing: ["dashboard.read", "users.read", "subscriptions.override", "billing.refund"],
  agent_manager: ["dashboard.read", "skills.edit"],
  analyst: ["dashboard.read", "users.read"],
  auditor: ["dashboard.read", "audit.read"],
  read_only: ["dashboard.read"],
};
const ids = (role: RoleCode) => visibleNav(new Set(MATRIX[role])).flatMap((g) => g.items.map((i) => i.id));
const groups = (role: RoleCode) => visibleNav(new Set(MATRIX[role])).map((g) => g.group);

describe("RBAC menu filter (UX only — every command is re-checked by admin-bff)", () => {
  it("support: operations group only", () => {
    // sprint 7: «Requests and cost» is for the people who run AI / the platform (support does not see AI content anyway)
    expect(ids("support")).toEqual(["dashboard", "users", "support"]);
    expect(groups("support")).toEqual(["ops"]);
  });
  it("auditor: dashboard + audit, no roles, no support", () => {
    expect(ids("auditor")).toEqual(["dashboard", "requests", "audit"]);
    expect(pageAllowed("roles", new Set(MATRIX.auditor))).toBe(false);
    expect(pageAllowed("support", new Set(MATRIX.auditor))).toBe(false);
  });
  it("super_admin: every section in prototype order", () => {
    expect(ids("super_admin")).toEqual(["dashboard", "users", "requests", "budgets", "support", "review", "sources", "discovery", "travel", "feeds", "news", "watches", "subscriptions", "billing", "agents", "monitoring", "config", "audit", "roles"]);
  });
  it("operations sees the AI sections (kill switch, emergency rollback), config and audit but not roles", () => {
    expect(ids("operations")).toEqual(["dashboard", "users", "requests", "budgets", "support", "review", "sources", "discovery", "travel", "feeds", "news", "watches", "agents", "monitoring", "config", "audit"]);
    expect(groups("operations")).toEqual(["ops", "catalog", "content", "ai", "system"]);
  });
  it("billing gets its «soon» sections; agent_manager — requests, budgets and agents", () => {
    expect(ids("billing")).toEqual(["dashboard", "users", "subscriptions", "billing"]);
    expect(ids("agent_manager")).toEqual(["dashboard", "requests", "budgets", "agents"]);
  });
  it("sprint 7: AI sections need dashboard.read (their API) AND an AI / platform permission", () => {
    const has = (page: string, ps: Permission[]) => pageAllowed(page, new Set<Permission>(ps));
    expect(has("requests", ["dashboard.read", "ai.content.read"])).toBe(true);
    expect(has("requests", ["dashboard.read"])).toBe(false);
    expect(has("budgets", ["dashboard.read", "ops.kill_switch"])).toBe(true);
    expect(has("budgets", ["ops.kill_switch"])).toBe(false);
    expect(has("agents", ["dashboard.read", "skills.publish"])).toBe(true);
    expect(has("agents", ["skills.edit"])).toBe(false);
    for (const r of ["support", "billing", "analyst", "read_only"] as RoleCode[]) expect(groups(r)).not.toContain("ai");
    expect(parseHash("#/agents/concierge.event")).toEqual({ page: "agents", id: "concierge.event" });
    expect(parseHash("#/requests/user:0f8fad5b-d9cb-469f-a165-70867728950e")).toEqual({ page: "requests", id: "user:0f8fad5b-d9cb-469f-a165-70867728950e" });
  });
  it("roles page needs staff.manage OR roles.manage", () => {
    expect(pageAllowed("roles", new Set<Permission>(["roles.manage"]))).toBe(true);
    expect(pageAllowed("roles", new Set<Permission>(["staff.manage"]))).toBe(true);
    expect(pageAllowed("nope", new Set(MATRIX.super_admin))).toBe(false);
  });
  it("sprint 4: each catalog item needs its own permission; other roles get no catalog group", () => {
    const only = (p: Permission) => visibleNav(new Set<Permission>([p])).flatMap((g) => g.items.map((i) => i.id));
    expect(only("events.review")).toEqual(["review"]);
    expect(only("sources.manage")).toEqual(["sources"]);
    expect(only("discovery.manage")).toEqual(["discovery"]);
    expect(only("ops.kill_switch")).not.toContain("discovery"); // the kill switch alone does not open the search screen
    for (const r of ["support", "billing", "agent_manager", "analyst", "auditor", "read_only"] as RoleCode[]) expect(groups(r)).not.toContain("catalog");
    expect(pageAllowed("sources", new Set(MATRIX.support))).toBe(false);
    expect(homePage(new Set<Permission>(["events.review"]))).toBe("review");
  });
  it("sprint 5: «Trip providers» needs dashboard.read (its API) AND a catalogue / platform permission", () => {
    const has = (ps: Permission[]) => pageAllowed("travel", new Set<Permission>(ps));
    expect(has(["dashboard.read", "discovery.manage"])).toBe(true);
    expect(has(["dashboard.read", "ops.kill_switch"])).toBe(true);
    expect(has(["discovery.manage"])).toBe(false); // the API would answer 403
    expect(has(["dashboard.read"])).toBe(false); // read_only / analyst keep their short menu
    for (const r of ["support", "billing", "agent_manager", "analyst", "auditor", "read_only"] as RoleCode[]) expect(ids(r)).not.toContain("travel");
    expect(homePage(new Set<Permission>(["dashboard.read", "events.review"]))).toBe("dashboard");
  });
  it("sprint 6: «Content» group — feeds and news need news.manage; «Watches» needs dashboard.read AND a content / platform permission", () => {
    const only = (ps: Permission[]) => visibleNav(new Set<Permission>(ps)).flatMap((g) => g.items.map((i) => i.id));
    expect(only(["news.manage"])).toEqual(["feeds", "news"]);
    expect(only(["dashboard.read", "news.manage"])).toEqual(["dashboard", "feeds", "news", "watches"]);
    expect(pageAllowed("watches", new Set<Permission>(["dashboard.read", "ops.kill_switch"]))).toBe(true);
    expect(pageAllowed("watches", new Set<Permission>(["dashboard.read"]))).toBe(false);
    for (const r of ["support", "billing", "agent_manager", "analyst", "auditor", "read_only"] as RoleCode[]) expect(groups(r)).not.toContain("content");
    expect(homePage(new Set<Permission>(["news.manage"]))).toBe("feeds");
    expect(parseHash("#/feeds/a6000000-0000-4000-8000-000000000001")).toEqual({ page: "feeds", id: "a6000000-0000-4000-8000-000000000001" });
  });
  it("fail-closed: no permissions → no menu, no start page", () => {
    expect(visibleNav(new Set())).toEqual([]);
    expect(homePage(new Set())).toBeNull();
  });
  it("start page is the first live section (a «soon» stub only if nothing else is allowed)", () => {
    expect(homePage(new Set(MATRIX.read_only))).toBe("dashboard");
    expect(homePage(new Set<Permission>(["subscriptions.override"]))).toBe("subscriptions");
    expect(homePage(new Set<Permission>(["dashboard.read", "skills.edit"]))).toBe("dashboard");
    expect(homePage(new Set<Permission>(["audit.read"]))).toBe("audit");
  });
});

describe("hash routes", () => {
  it("parses page and id, strips junk", () => {
    expect(parseHash("#/support/TCK-3081")).toEqual({ page: "support", id: "TCK-3081" });
    expect(parseHash("#/users")).toEqual({ page: "users", id: null });
    expect(parseHash("#/su<p>port/x")).toEqual({ page: "support", id: "x" });
    expect(parseHash("#/support/%E0%A4%A")).toEqual({ page: "support", id: null });
    expect(routeHash("support", "TCK 1")).toBe("#/support/TCK%201");
  });
});
