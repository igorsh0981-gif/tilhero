import type { Permission } from "@tilhero/contracts/admin";
import type { IconName } from "../ui/Icon";

/**
 * Menu sections of TilHero Admin = the ids of the experience-config `admin` seed (layout.menu, 0002_seed.py) and the
 * NAV of the approved prototype (Admin.dc.html): 15 sections in 5 groups. The active admin config decides the order
 * and which sections are switched on; the role decides which of them the staff member sees (RBAC is re-checked by
 * admin-bff and every domain — the menu is UX only).
 */
export type PageId =
  | "overview"
  | "users"
  | "content"
  | "agents"
  | "qa"
  | "costs"
  | "heroes"
  | "game"
  | "events"
  | "news"
  | "support"
  | "config"
  | "langs"
  | "roles"
  | "audit";

export type NavGroup = "product" | "ai" | "game" | "comms" | "manage";

export interface NavItem {
  id: PageId;
  group: NavGroup;
  icon: IconName;
  /** visible when the staff member has ANY of these permissions (Me.permissions) */
  perms: readonly Permission[];
  /** section of a later sprint: honest «soon» screen with the sprint number */
  soon?: 4 | 6;
}

/** Default order and grouping (prototype NAV). */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: "overview", group: "product", icon: "dashboard", perms: ["dashboard.read"] },
  { id: "users", group: "product", icon: "users", perms: ["users.read"] },
  // sprint 3: course, lessons, scenarios, rubrics, media and rights, learners' requests, review, diagnostics
  { id: "content", group: "product", icon: "book", perms: ["content.read"] },
  { id: "agents", group: "ai", icon: "cpu", perms: ["dashboard.read"], soon: 4 },
  { id: "qa", group: "ai", icon: "clipboardCheck", perms: ["dashboard.read"], soon: 4 },
  { id: "costs", group: "ai", icon: "gauge", perms: ["dashboard.read"], soon: 4 },
  { id: "heroes", group: "game", icon: "hero", perms: ["dashboard.read"], soon: 6 },
  { id: "game", group: "game", icon: "trophy", perms: ["dashboard.read"], soon: 6 },
  { id: "events", group: "game", icon: "calendar", perms: ["dashboard.read"], soon: 6 },
  // «Новости и „Что нового“» of the prototype: release notes + notification templates + campaigns (tabs by right)
  { id: "news", group: "comms", icon: "sparkles", perms: ["whatsnew.manage", "notif.templates.manage", "notif.campaigns.manage"] },
  { id: "support", group: "comms", icon: "support", perms: ["support.read"] },
  { id: "config", group: "manage", icon: "sliders", perms: ["config.read"] },
  // sprint 3: languages and language pairs (changes — lang.manage with step-up)
  { id: "langs", group: "manage", icon: "globe", perms: ["content.read", "lang.manage"] },
  { id: "roles", group: "manage", icon: "shield", perms: ["staff.manage", "roles.manage"] },
  { id: "audit", group: "manage", icon: "audit", perms: ["audit.read"] },
];

export const PAGE_IDS: readonly PageId[] = NAV_ITEMS.map((i) => i.id);
export const GROUPS: readonly NavGroup[] = ["product", "ai", "game", "comms", "manage"];
export const navItem = (id: string): NavItem | undefined => NAV_ITEMS.find((i) => i.id === id);
export const GROUP_OF: Readonly<Record<PageId, NavGroup>> = Object.fromEntries(NAV_ITEMS.map((i) => [i.id, i.group])) as Record<PageId, NavGroup>;

export const allowed = (item: NavItem, perms: ReadonlySet<Permission>) => item.perms.some((p) => perms.has(p));

/** layout.menu of the active admin config: order and switches; unknown ids are ignored, missing ids keep the default. */
export interface MenuEntry {
  id: string;
  enabled: boolean;
}

/** Items in config order (enabled only), then any section the config does not mention, in the default order. */
export function orderedItems(menu: readonly MenuEntry[] | null | undefined): NavItem[] {
  if (!menu || !menu.length) return [...NAV_ITEMS];
  const seen = new Set<string>();
  const out: NavItem[] = [];
  for (const m of menu) {
    const it = navItem(m.id);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    if (m.enabled) out.push(it);
  }
  for (const it of NAV_ITEMS) if (!seen.has(it.id)) out.push(it);
  return out;
}

/** Sidebar: groups in the order their first section appears; inside a group — the config order. */
export function visibleNav(perms: ReadonlySet<Permission>, menu?: readonly MenuEntry[] | null) {
  const items = orderedItems(menu).filter((i) => allowed(i, perms));
  const groups: Array<{ group: NavGroup; items: NavItem[] }> = [];
  for (const it of items) {
    let g = groups.find((x) => x.group === it.group);
    if (!g) groups.push((g = { group: it.group, items: [] }));
    g.items.push(it);
  }
  return groups;
}

export function pageAllowed(id: string, perms: ReadonlySet<Permission>, menu?: readonly MenuEntry[] | null): boolean {
  return orderedItems(menu).some((i) => i.id === id && allowed(i, perms));
}

/** Start screen: the first available section that already has content (not a «soon» stub). */
export function homePage(perms: ReadonlySet<Permission>, menu?: readonly MenuEntry[] | null): PageId | null {
  const items = orderedItems(menu).filter((i) => allowed(i, perms));
  return (items.find((i) => !i.soon) ?? items[0])?.id ?? null;
}
