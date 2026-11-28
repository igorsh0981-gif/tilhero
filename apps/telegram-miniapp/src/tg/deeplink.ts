import type { ReleaseNoteRoute } from "@tilhero/contracts/bff";

/** Sprint 8: «Подписка» and «Купить тилы» — routes of packages/contracts/release-notes.json (bff.ts ReleaseNoteRoute
 *  since the integration); the notifications about payments lead to route_subscription. */
export type BillingRoute = Extract<ReleaseNoteRoute, "subscription" | "til_shop">;
/** Routes of packages/contracts/release-notes.json (bff.ts ReleaseNoteRoute, sprint 3 routes included) and sprint 8. */
export type AppRoute = ReleaseNoteRoute | BillingRoute;

/**
 * Deep links (start_param / ?startapp=, InboxItem.startapp). Telegram allows [A-Za-z0-9_-]{1,64}.
 *  - inv_<token>        — invitation link (family / friend / referral) → POST /v1/invites/open;
 *  - invite_<uuid>      — reminder about an opened invitation → GET /v1/invites/{id}/preview;
 *  - gc_<token>         — a teen asks the parent for consent → GET /v1/guardian-consents/{token};
 *  - ticket_TCK-NNNN    — support ticket;
 *  - route_<route>      — a screen of the app (AppRoute: the release-notes catalogue);
 *  - duel_<uuid>        — sprint 7: the card of a duel (a challenge, the result);
 *  - room_<uuid>        — sprint 7: a pair lesson (the invitation, the room, the report).
 * Anything else is ignored (never interpreted as a URL or HTML).
 */
export type DeepLink =
  | { kind: "invite"; token: string }
  | { kind: "invitePreview"; inviteId: string }
  | { kind: "guardian"; token: string }
  | { kind: "ticket"; number: string }
  | { kind: "route"; route: AppRoute }
  | { kind: "duel"; id: string }
  | { kind: "room"; id: string };

export const ROUTES: readonly AppRoute[] = [
  "home", "lessons", "review", "progress", "profile", "schedule", "notifications", "family", "support", "news",
  "diagnostics", "plan", "skills", "scenarios", "media", "media_requests", "languages",
  // release 6.1: the game (heroes, shop, badges, history, settings), the dictionary and reading
  "heroes", "shop", "badges", "game_history", "game_settings", "dictionary", "reading",
  // sprint 7: friends, leagues of the week, duels, referrals
  "friends", "leagues", "duels", "referrals",
  // sprint 8: the subscription (Telegram Stars) and buying tils for Stars
  "subscription", "til_shop",
];
const ROUTE_SET: ReadonlySet<string> = new Set(ROUTES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{8,60}$/;

export function isRoute(v: unknown): v is AppRoute {
  return typeof v === "string" && ROUTE_SET.has(v);
}

export function parseStartParam(raw: string | null | undefined): DeepLink | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) return null;
  if (v.startsWith("inv_")) {
    const token = v.slice(4);
    return TOKEN.test(token) ? { kind: "invite", token } : null;
  }
  if (v.startsWith("invite_")) {
    const id = v.slice(7);
    return UUID.test(id) ? { kind: "invitePreview", inviteId: id.toLowerCase() } : null;
  }
  if (v.startsWith("gc_")) {
    const token = v.slice(3);
    return TOKEN.test(token) ? { kind: "guardian", token } : null;
  }
  const t = /^ticket_(TCK-\d{1,9})$/i.exec(v);
  if (t) return { kind: "ticket", number: t[1]!.toUpperCase() };
  const d = /^(duel|room)_([0-9a-f-]{36})$/i.exec(v);
  if (d) return UUID.test(d[2]!) ? { kind: d[1]!.toLowerCase() as "duel" | "room", id: d[2]!.toLowerCase() } : null;
  if (v.startsWith("route_")) {
    const route = v.slice(6).toLowerCase();
    return isRoute(route) ? { kind: "route", route } : null;
  }
  return null;
}

/** Deep links that need a finished registration (age and consents) before they can be acted upon. */
export function needsOnboarding(link: DeepLink): boolean {
  return link.kind === "ticket" || link.kind === "route" || link.kind === "duel" || link.kind === "room";
}
