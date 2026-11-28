import type { Permission } from "@tilhero/contracts/admin";
import type { IconName } from "../ui/Icon";

/**
 * Menu sections of TilHero Admin = the ids of the experience-config `admin` seed (layout.menu, 0002_seed.py) and the
 * NAV of the approved prototype (Admin.dc.html): 15 sections in 5 groups, + «memory» of sprint 5, + the group «Сообщество»
 * of sprint 7 (friends, moderation, referrals, leagues, pair_rooms — LinguaFlow «Социальное»). The active admin config decides the order
 * and which sections are switched on; the role decides which of them the staff member sees (RBAC is re-checked by
 * admin-bff and every domain — the menu is UX only).
 */
export type PageId =
  | "overview"
  | "users"
  | "content"
  | "memory"
  | "agents"
  | "qa"
  | "costs"
  | "heroes"
  | "game"
  | "events"
  | "friends"
  | "moderation"
  | "referrals"
  | "leagues"
  | "pair_rooms"
  | "tariffs"
  | "payments"
  | "adjustments"
  | "reconciliation"
  | "finance"
  | "news"
  | "support"
  | "config"
  | "langs"
  | "roles"
  | "audit";

export type NavGroup = "product" | "ai" | "game" | "social" | "money" | "comms" | "manage";

export interface NavItem {
  id: PageId;
  group: NavGroup;
  icon: IconName;
  /** visible when the staff member has ANY of these permissions (Me.permissions) */
  perms: readonly Permission[];
  /** section of a later sprint: honest «soon» screen with the sprint number */
  soon?: number;
}

/** Default order and grouping (prototype NAV). */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: "overview", group: "product", icon: "dashboard", perms: ["dashboard.read"] },
  { id: "users", group: "product", icon: "users", perms: ["users.read"] },
  // sprint 3: course, lessons, scenarios, rubrics, media and rights, learners' requests, review, diagnostics
  { id: "content", group: "product", icon: "book", perms: ["content.read"] },
  // sprint 5: «Память и повторения» — forgetting analytics (memory.read | dashboard.read, aggregates only) and a
  // learner's memory (memory.read). Not in the experience-config menu whitelist yet: it follows the config's sections.
  { id: "memory", group: "product", icon: "trendDown", perms: ["memory.read", "dashboard.read"] },
  // sprint 4: agents and skills (ai.read), dialogue QA (qa.read), AI costs and limits (costs.read)
  { id: "agents", group: "ai", icon: "cpu", perms: ["ai.read"] },
  { id: "qa", group: "ai", icon: "clipboardCheck", perms: ["qa.read"] },
  { id: "costs", group: "ai", icon: "gauge", perms: ["costs.read"] },
  // sprint 6: «Герои», «Геймификация» (rules, shop, wallets, overview), «События и сезоны» — game.read; commands need
  // game.manage / game.publish / wallet.adjust (buttons hidden without them, the domain re-checks)
  { id: "heroes", group: "game", icon: "hero", perms: ["game.read"] },
  { id: "game", group: "game", icon: "trophy", perms: ["game.read"] },
  { id: "events", group: "game", icon: "calendar", perms: ["game.read"] },
  // sprint 7: «Сообщество» — friends and complaints (social.read), moderation (moderation.manage), referral campaigns
  // and the review queue (referral.read), leagues and duels (league.read), pair rooms (room.read). The commands need
  // referral.manage / league.manage / room.manage (buttons hidden without them; admin-bff and the domains re-check).
  // Not in the experience-config seed yet: they follow the config's sections until a version places them.
  { id: "friends", group: "social", icon: "userPlus", perms: ["social.read"] },
  { id: "moderation", group: "social", icon: "flag", perms: ["moderation.manage"] },
  { id: "referrals", group: "social", icon: "gift", perms: ["referral.read"] },
  { id: "leagues", group: "social", icon: "podium", perms: ["league.read"] },
  { id: "pair_rooms", group: "social", icon: "mic", perms: ["room.read"] },
  // sprint 8: «Деньги» (ADMIN_MENU 1.8.0: tariffs, payments, adjustments, reconciliation, finance) — billing.read; the
  // financial overview — billing.read | dashboard.read (admin.ts FinanceOverview). Commands need billing.manage /
  // billing.publish / billing.refund / billing.approve / subscriptions.override (buttons hidden without them; admin-bff
  // and billing re-check). Not in the experience-config seed 1.0.0: they follow the config's sections until 1.8.0.
  { id: "tariffs", group: "money", icon: "card", perms: ["billing.read"] },
  { id: "payments", group: "money", icon: "coins", perms: ["billing.read"] },
  { id: "adjustments", group: "money", icon: "userCheck", perms: ["billing.read"] },
  { id: "reconciliation", group: "money", icon: "scan", perms: ["billing.read"] },
  { id: "finance", group: "money", icon: "activity", perms: ["billing.read", "dashboard.read"] },
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
export const GROUPS: readonly NavGroup[] = ["product", "ai", "game", "social", "money", "comms", "manage"];
export const navItem = (id: string): NavItem | undefined => NAV_ITEMS.find((i) => i.id === id);
/**
 * Ids of the experience-config menu that name a section of admin-web by another id: INTERNAL_API sprint 6 §8 calls the
 * events section `game_events` (the 1.0.0 seed says `events`) — either one places and switches «События и сезоны».
 */
export const MENU_ALIASES: Readonly<Record<string, PageId>> = { game_events: "events" };
const menuItem = (id: string): NavItem | undefined => navItem(MENU_ALIASES[id] ?? id);
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
    const it = menuItem(m.id);
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
