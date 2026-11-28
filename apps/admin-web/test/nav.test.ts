import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Permission, RoleCode } from "@tilhero/contracts/admin";
import { GROUPS, homePage, NAV_ITEMS, orderedItems, pageAllowed, visibleNav } from "../src/state/nav";
import { parseHash, routeHash } from "../src/state/route";
import { parseNewsRoute } from "../src/screens/news/News";

/** Default matrix (docs/sprint2/PLAN.md «Роли и права»). */
const ALL: Permission[] = [
  "dashboard.read", "users.read", "users.sensitive.read", "support.read", "support.reply", "support.manage", "audit.read", "config.read",
  "config.edit", "config.publish", "whatsnew.manage", "whatsnew.publish", "notif.templates.manage", "notif.campaigns.manage",
  "notif.campaigns.send", "staff.manage", "roles.manage",
  "content.read", "content.edit", "content.review", "content.publish", "media.rights", "lang.manage",
  "ai.read", "ai.manage", "ai.publish", "qa.read", "qa.transcripts", "qa.review", "costs.read", "costs.manage",
  "memory.read", "memory.manage", "glossary.manage",
  "game.read", "game.manage", "game.publish", "wallet.adjust",
  "billing.read", "billing.manage", "billing.publish", "billing.approve", "billing.refund", "subscriptions.override",
];
/** + sprint 5 (PLAN «Права и роли»): memory.read, memory.manage, glossary.manage; + sprint 6: game.*, wallet.adjust;
 *  + sprint 8 (PLAN «Права и роли»): finance; support + billing.read, subscriptions.override; operations + billing.*,
 *  subscriptions.override; analyst, auditor + billing.read */
const MATRIX: Record<RoleCode, Permission[]> = {
  super_admin: ALL,
  operations: ["dashboard.read", "users.read", "support.read", "config.read", "config.edit", "config.publish", "audit.read", "content.read", "ai.read", "qa.read", "costs.read", "costs.manage", "memory.read", "memory.manage", "game.read", "game.manage", "game.publish", "wallet.adjust", "billing.read", "billing.manage", "billing.publish", "billing.approve", "billing.refund", "subscriptions.override"],
  communications: ["dashboard.read", "whatsnew.manage", "whatsnew.publish", "notif.templates.manage", "notif.campaigns.manage", "notif.campaigns.send"],
  support: ["dashboard.read", "users.read", "support.read", "support.reply", "game.read", "billing.read", "subscriptions.override"],
  methodist: ["dashboard.read", "users.read", "content.read", "content.edit", "content.review", "content.publish", "ai.read", "ai.manage", "ai.publish", "qa.read", "qa.transcripts", "qa.review", "memory.read", "glossary.manage", "game.read"],
  content_manager: ["dashboard.read", "content.read", "content.edit", "media.rights", "glossary.manage", "game.read", "game.manage"],
  qa_analyst: ["dashboard.read", "content.read", "ai.read", "qa.read", "qa.transcripts", "memory.read"],
  finance: ["dashboard.read", "users.read", "costs.read", "billing.read", "billing.manage", "billing.publish", "billing.approve", "billing.refund"],
  analyst: ["dashboard.read", "users.read", "content.read", "ai.read", "qa.read", "costs.read", "memory.read", "game.read", "billing.read"],
  auditor: ["dashboard.read", "audit.read", "content.read", "ai.read", "qa.read", "costs.read", "memory.read", "game.read", "billing.read"],
  read_only: ["dashboard.read"],
};
const ids = (role: RoleCode, menu?: Array<{ id: string; enabled: boolean }>) => visibleNav(new Set(MATRIX[role]), menu).flatMap((g) => g.items.map((i) => i.id));
const live = (role: RoleCode) => ids(role);
const GAME = ["heroes", "game", "events"];

/** sections not in the experience-config seed 1.0.0 — they follow the config's sections: «memory» (sprint 5) and the five
 *  of «Сообщество» (sprint 7: ADMIN_MENU friends, moderation, referrals, leagues, pair_rooms) */
const SOCIAL = ["friends", "moderation", "referrals", "leagues", "pair_rooms"];
/** sprint 8: the five of «Деньги» (ADMIN_MENU 1.8.0) — not in the seed 1.0.0 either */
const MONEY = ["tariffs", "payments", "adjustments", "reconciliation", "finance"];
const NOT_IN_SEED = ["memory", ...SOCIAL, ...MONEY];

describe("menu: 15 sections of the experience-config seed + «memory» (sprint 5), filtered by role (UX only — admin-bff re-checks)", () => {
  it("the menu ids are the admin seed (services/experience-config 0002_seed.py) plus the sprint 5 section", () => {
    const seed = readFileSync(resolve(__dirname, "../../../services/experience-config/migrations/versions/0002_seed.py"), "utf8");
    const m = seed.match(/for m in \(\s*([\s\S]*?)\)\]/);
    const fromSeed = [...(m?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
    expect(NAV_ITEMS.map((i) => i.id).filter((x) => !NOT_IN_SEED.includes(x))).toEqual(fromSeed);
    expect(fromSeed).toHaveLength(15);
  });
  it("super_admin sees every section in the prototype order and groups («memory» in «Продукт» after the content)", () => {
    expect(ids("super_admin")).toEqual(["overview", "users", "content", "memory", "agents", "qa", "costs", "heroes", "game", "events", ...MONEY, "news", "support", "config", "langs", "roles", "audit"]);
    expect(visibleNav(new Set(ALL)).map((g) => g.group)).toEqual(["product", "ai", "game", "money", "comms", "manage"]);
  });
  it("live sections per role («memory»: forgetting analytics for dashboard.read, the learner's memory for memory.read; the game — game.read)", () => {
    // sprint 8: «Финансовый обзор» opens with billing.read or dashboard.read (admin.ts: finance/overview), the other
    // four sections of «Деньги» — with billing.read
    expect(live("operations")).toEqual(["overview", "users", "content", "memory", "agents", "qa", "costs", ...GAME, ...MONEY, "support", "config", "langs", "audit"]);
    expect(live("communications")).toEqual(["overview", "memory", "finance", "news"]);
    expect(live("support")).toEqual(["overview", "users", "memory", ...GAME, ...MONEY, "support"]);
    expect(live("methodist")).toEqual(["overview", "users", "content", "memory", "agents", "qa", ...GAME, "finance", "langs"]);
    expect(live("content_manager")).toEqual(["overview", "content", "memory", ...GAME, "finance", "langs"]);
    expect(live("qa_analyst")).toEqual(["overview", "content", "memory", "agents", "qa", "finance", "langs"]);
    expect(live("finance")).toEqual(["overview", "users", "memory", "costs", ...MONEY]);
    expect(live("analyst")).toEqual(["overview", "users", "content", "memory", "agents", "qa", "costs", ...GAME, ...MONEY, "langs"]);
    expect(live("auditor")).toEqual(["overview", "content", "memory", "agents", "qa", "costs", ...GAME, ...MONEY, "langs", "audit"]);
    expect(live("read_only")).toEqual(["overview", "memory", "finance"]);
  });
  it("sprint 6: «Герои», «Геймификация», «События и сезоны» open with game.read only (dashboard.read no longer)", () => {
    for (const p of GAME) {
      expect(pageAllowed(p, new Set<Permission>(["game.read"]))).toBe(true);
      expect(pageAllowed(p, new Set<Permission>(["dashboard.read", "game.manage", "game.publish", "wallet.adjust"]))).toBe(false);
    }
  });
  it("sprint 5: «memory» opens with memory.read or dashboard.read; with neither it is closed", () => {
    expect(pageAllowed("memory", new Set<Permission>(["memory.read"]))).toBe(true);
    expect(pageAllowed("memory", new Set<Permission>(["dashboard.read"]))).toBe(true);
    expect(pageAllowed("memory", new Set<Permission>(["memory.manage", "glossary.manage"]))).toBe(false);
  });
  it("«news» opens with any communications right; roles with staff.manage OR roles.manage", () => {
    for (const p of ["whatsnew.manage", "notif.templates.manage", "notif.campaigns.manage"] as Permission[]) expect(pageAllowed("news", new Set([p]))).toBe(true);
    expect(pageAllowed("news", new Set<Permission>(["whatsnew.publish"]))).toBe(false);
    expect(pageAllowed("roles", new Set<Permission>(["roles.manage"]))).toBe(true);
    expect(pageAllowed("roles", new Set<Permission>(["staff.manage"]))).toBe(true);
    expect(pageAllowed("nope", new Set(ALL))).toBe(false);
  });
  it("no section is «soon» any more: sprint 6 made the game sections live", () => {
    expect(NAV_ITEMS.filter((i) => i.soon).map((i) => i.id)).toEqual([]);
  });
  it("sprint 4: «agents» — ai.read, «qa» — qa.read, «costs» — costs.read (not dashboard.read any more)", () => {
    expect(pageAllowed("agents", new Set<Permission>(["ai.read"]))).toBe(true);
    expect(pageAllowed("qa", new Set<Permission>(["qa.read"]))).toBe(true);
    expect(pageAllowed("costs", new Set<Permission>(["costs.read"]))).toBe(true);
    for (const p of ["agents", "qa", "costs"]) expect(pageAllowed(p, new Set<Permission>(["dashboard.read", "ai.manage", "qa.transcripts", "costs.manage"]))).toBe(false);
    expect(live("qa_analyst")).not.toContain("costs");
  });
  it("sprint 3: «content» opens with content.read; «langs» with content.read or lang.manage", () => {
    expect(pageAllowed("content", new Set<Permission>(["content.read"]))).toBe(true);
    expect(pageAllowed("content", new Set<Permission>(["dashboard.read", "content.edit"]))).toBe(false);
    expect(pageAllowed("langs", new Set<Permission>(["lang.manage"]))).toBe(true);
    expect(pageAllowed("langs", new Set<Permission>(["dashboard.read"]))).toBe(false);
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
  it("the config id `game_events` (INTERNAL_API sprint 6 §8) places and switches «События и сезоны» like `events`", () => {
    const seedMenu = ["overview", "users", "content", "agents", "qa", "costs", "heroes", "game", "game_events", "news", "support", "config", "langs", "roles", "audit"].map((id) => ({ id, enabled: true }));
    const o = orderedItems(seedMenu).map((i) => i.id);
    expect(o.indexOf("events")).toBe(o.indexOf("game") + 1);
    expect(o.filter((x) => x === "events")).toHaveLength(1);
    const off = seedMenu.map((m) => (m.id === "game_events" ? { ...m, enabled: false } : m));
    expect(orderedItems(off).map((i) => i.id)).not.toContain("events");
    expect(pageAllowed("events", new Set(ALL), off)).toBe(false);
  });
  it("an empty menu falls back to the defaults", () => {
    expect(orderedItems([]).map((i) => i.id)).toEqual(NAV_ITEMS.map((i) => i.id));
    expect(orderedItems(null)).toHaveLength(26);
  });
  it("a section the config does not know yet («memory») follows the config's sections and joins its group", () => {
    const seedMenu = ["overview", "users", "content", "agents", "qa", "costs", "heroes", "game", "events", "news", "support", "config", "langs", "roles", "audit"].map((id) => ({ id, enabled: true }));
    expect(orderedItems(seedMenu).map((i) => i.id).slice(-11)).toEqual(["memory", ...SOCIAL, ...MONEY]);
    expect(visibleNav(new Set(ALL), seedMenu)[0]!.items.map((i) => i.id)).toEqual(["overview", "users", "content", "memory"]);
  });
});

describe("sprint 7: «Сообщество» — five sections by their own read rights (PLAN «Права»)", () => {
  const S7: Permission[] = ["social.read", "moderation.manage", "referral.read", "referral.manage", "league.read", "league.manage", "room.read", "room.manage"];
  const roles: Record<string, Permission[]> = {
    support: [...MATRIX.support, "social.read", "moderation.manage", "referral.read", "room.read"],
    operations: [...MATRIX.operations, ...S7],
    content_manager: [...MATRIX.content_manager, "league.read"],
    analyst: [...MATRIX.analyst, "social.read", "referral.read", "league.read", "room.read"],
  };
  const social = (ps: Permission[]) => visibleNav(new Set(ps)).find((g) => g.group === "social")?.items.map((i) => i.id) ?? [];
  it("each section opens with its read right only; the manage rights alone open nothing but «Модерация»", () => {
    expect(pageAllowed("friends", new Set<Permission>(["social.read"]))).toBe(true);
    expect(pageAllowed("moderation", new Set<Permission>(["moderation.manage"]))).toBe(true);
    expect(pageAllowed("moderation", new Set<Permission>(["social.read"]))).toBe(false);
    expect(pageAllowed("referrals", new Set<Permission>(["referral.read"]))).toBe(true);
    expect(pageAllowed("referrals", new Set<Permission>(["referral.manage"]))).toBe(false);
    expect(pageAllowed("leagues", new Set<Permission>(["league.read"]))).toBe(true);
    expect(pageAllowed("leagues", new Set<Permission>(["league.manage", "game.read"]))).toBe(false);
    expect(pageAllowed("pair_rooms", new Set<Permission>(["room.read"]))).toBe(true);
    expect(pageAllowed("pair_rooms", new Set<Permission>(["room.manage", "dashboard.read"]))).toBe(false);
  });
  it("the group «Сообщество» per role: support — friends, moderation, referrals, rooms; content manager — leagues; analyst — the reads", () => {
    expect(social(roles.operations!)).toEqual(SOCIAL);
    expect(social(roles.support!)).toEqual(["friends", "moderation", "referrals", "pair_rooms"]);
    expect(social(roles.content_manager!)).toEqual(["leagues"]);
    expect(social(roles.analyst!)).toEqual(["friends", "referrals", "leagues", "pair_rooms"]);
    expect(social(MATRIX.communications)).toEqual([]);
    expect(visibleNav(new Set([...ALL, ...S7])).map((g) => g.group)).toEqual(["product", "ai", "game", "social", "money", "comms", "manage"]);
  });
  it("the hash keeps «_» of the menu id: #/pair_rooms/<id>", () => {
    expect(parseHash("#/pair_rooms/f7000000-0000-4000-8000-000000000002")).toEqual({ page: "pair_rooms", id: "f7000000-0000-4000-8000-000000000002" });
    expect(routeHash("pair_rooms", "x")).toBe("#/pair_rooms/x");
  });
});

describe("sprint 8: «Деньги» — five sections by billing.read (PLAN «Права и роли»)", () => {
  it("each section opens with billing.read; the write rights alone open nothing; the overview also with dashboard.read", () => {
    for (const p of MONEY) {
      expect(pageAllowed(p, new Set<Permission>(["billing.read"]))).toBe(true);
      expect(pageAllowed(p, new Set<Permission>(["billing.manage", "billing.publish", "billing.approve", "billing.refund", "subscriptions.override", "costs.read"]))).toBe(false);
    }
    expect(pageAllowed("finance", new Set<Permission>(["dashboard.read"]))).toBe(true);
    for (const p of MONEY.filter((x) => x !== "finance")) expect(pageAllowed(p, new Set<Permission>(["dashboard.read"]))).toBe(false);
  });
  it("the group «Деньги» follows «Сообщество»; switched off in the config — hidden and closed by link", () => {
    expect(GROUPS).toEqual(["product", "ai", "game", "social", "money", "comms", "manage"]);
    expect(NAV_ITEMS.filter((i) => i.group === "money").map((i) => i.id)).toEqual(MONEY);
    const menu = NAV_ITEMS.map((i) => ({ id: i.id, enabled: i.id !== "tariffs" }));
    expect(orderedItems(menu).map((i) => i.id)).not.toContain("tariffs");
    expect(pageAllowed("tariffs", new Set(ALL), menu)).toBe(false);
    expect(pageAllowed("payments", new Set(ALL), menu)).toBe(true);
  });
  it("routes: #/payments/orders/<id>, #/tariffs/v/<n>", () => {
    expect(parseHash("#/payments/orders/f8000000-0000-4000-8000-000000000001")).toEqual({ page: "payments", id: "orders/f8000000-0000-4000-8000-000000000001" });
    expect(parseHash("#/tariffs/v/7")).toEqual({ page: "tariffs", id: "v/7" });
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
