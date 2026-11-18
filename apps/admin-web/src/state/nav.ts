import type { Permission } from "@tilhero/contracts/admin";
import type { IconName } from "../ui/Icon";

export type PageId =
  | "dashboard"
  | "users"
  | "requests"
  | "budgets"
  | "support"
  | "review"
  | "sources"
  | "discovery"
  | "travel"
  | "feeds"
  | "news"
  | "watches"
  | "subscriptions"
  | "billing"
  | "agents"
  | "monitoring"
  | "config"
  | "audit"
  | "roles";

export type NavGroup = "ops" | "catalog" | "content" | "commerce" | "ai" | "system";

export interface NavItem {
  id: PageId;
  icon: IconName;
  /** visible when the staff member has ANY of these permissions (Me.permissions) */
  perms: readonly Permission[];
  /** …and ALL of these (the permission of the screen's API when the audience is narrower than it) */
  requires?: readonly Permission[];
  /** section of a later sprint: listed with the «soon» tag, honest empty screen */
  soon?: 6 | 7;
}

/** Sidebar groups as in prototype v2 (20-shell.js NAV). */
export const NAV: ReadonlyArray<{ group: NavGroup; items: readonly NavItem[] }> = [
  {
    group: "ops",
    items: [
      { id: "dashboard", icon: "dashboard", perms: ["dashboard.read"] },
      { id: "users", icon: "users", perms: ["users.read"] },
      // sprint 7 (docs/sprint7/INTERNAL_API.md §6): usage and cost of the AI agents — the API needs dashboard.read; the
      // menu shows it to the people who run AI or the platform (support / billing keep their short menu)
      { id: "requests", icon: "activity", perms: ["ops.kill_switch", "discovery.manage", "skills.edit", "skills.publish", "ai.content.read", "audit.read"], requires: ["dashboard.read"] },
      // budgets, kill switch, alerts, access levels: reading — dashboard.read; changes — ops.kill_switch (+ TOTP)
      { id: "budgets", icon: "gauge", perms: ["ops.kill_switch", "discovery.manage", "skills.edit", "skills.publish"], requires: ["dashboard.read"] },
      { id: "support", icon: "support", perms: ["support.read"] },
    ],
  },
  {
    // sprint 4: AI search of events on official sites (docs/sprint4/INTERNAL_API.md §7)
    group: "catalog",
    items: [
      { id: "review", icon: "clipboardCheck", perms: ["events.review"] },
      { id: "sources", icon: "globe", perms: ["sources.manage"] },
      { id: "discovery", icon: "scan", perms: ["discovery.manage"] },
      // sprint 5: health of the trip providers. The API needs dashboard.read (every role has it); the menu shows the
      // screen to the people who run the catalogue or the platform, so support / billing keep their short menu.
      { id: "travel", icon: "luggage", perms: ["events.review", "sources.manage", "discovery.manage", "ops.kill_switch"], requires: ["dashboard.read"] },
    ],
  },
  {
    // sprint 6: what the Mini App shows besides the catalogue — news feeds, moderation of news, Watch statistics
    // (docs/sprint6/INTERNAL_API.md §3.1, §8). Its own group: «Event catalog» is about events and is already long.
    group: "content",
    items: [
      { id: "feeds", icon: "rss", perms: ["news.manage"] },
      { id: "news", icon: "newspaper", perms: ["news.manage"] },
      // the API needs dashboard.read (every role); the menu shows it to the people who run content or the platform,
      // like «Trip providers» — support / billing / analyst keep their short menu
      { id: "watches", icon: "radar", perms: ["news.manage", "events.review", "sources.manage", "discovery.manage", "ops.kill_switch"], requires: ["dashboard.read"] },
    ],
  },
  {
    group: "commerce",
    items: [
      { id: "subscriptions", icon: "star", perms: ["subscriptions.override"], soon: 7 },
      { id: "billing", icon: "card", perms: ["billing.refund"], soon: 7 },
    ],
  },
  // sprint 7: agents and skills (versions, review, publication, rollback as a new activation, Test Console)
  { group: "ai", items: [{ id: "agents", icon: "cpu", perms: ["skills.edit", "skills.publish", "ops.kill_switch"], requires: ["dashboard.read"] }] },
  {
    group: "system",
    items: [
      // sprint 8: providers, queues, DLQ, alerts (ops-monitor). Reading — dashboard.read; DLQ — ops.queues.manage. The
      // menu shows it to the people who run the platform or AI (support / billing keep their short menu).
      { id: "monitoring", icon: "server", perms: ["ops.kill_switch", "ops.queues.manage", "discovery.manage"], requires: ["dashboard.read"] },
      { id: "config", icon: "sliders", perms: ["config.read"] },
      { id: "audit", icon: "audit", perms: ["audit.read"] },
      { id: "roles", icon: "shield", perms: ["staff.manage", "roles.manage"] },
    ],
  },
];

export const ALL_ITEMS: readonly NavItem[] = NAV.flatMap((g) => g.items);
export const navItem = (id: string): NavItem | undefined => ALL_ITEMS.find((i) => i.id === id);
export const GROUP_OF: Readonly<Record<PageId, NavGroup>> = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.id, g.group]))) as Record<PageId, NavGroup>;

export const allowed = (item: NavItem, perms: ReadonlySet<Permission>) =>
  item.perms.some((p) => perms.has(p)) && (item.requires ?? []).every((p) => perms.has(p));

export function visibleNav(perms: ReadonlySet<Permission>) {
  return NAV.map((g) => ({ group: g.group, items: g.items.filter((i) => allowed(i, perms)) })).filter((g) => g.items.length > 0);
}

export function pageAllowed(id: string, perms: ReadonlySet<Permission>): boolean {
  const it = navItem(id);
  return !!it && allowed(it, perms);
}

/** Start screen: the first available section that already has content (not a «soon» stub). */
export function homePage(perms: ReadonlySet<Permission>): PageId | null {
  const live = ALL_ITEMS.find((i) => !i.soon && allowed(i, perms));
  return (live ?? ALL_ITEMS.find((i) => allowed(i, perms)))?.id ?? null;
}
