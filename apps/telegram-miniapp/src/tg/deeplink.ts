/**
 * Deep links (start_param / ?startapp=): events | watch | support | ticket_TCK-NNNN | profile | event_<uuid>.
 * The bot gateway builds them (INTERNAL_API: `startapp=ticket_<number>`).
 */
export type DeepLink =
  | { kind: "tab"; tab: "home" | "catalog" | "watch" | "news" | "profile" }
  | { kind: "event"; id: string }
  | { kind: "supportList" }
  | { kind: "ticket"; number: string };

const TABS: Record<string, "home" | "catalog" | "watch" | "news" | "profile"> = {
  home: "home",
  events: "catalog",
  catalog: "catalog",
  watch: "watch",
  news: "news",
  profile: "profile",
};

export function parseStartParam(raw: string | null | undefined): DeepLink | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) return null;
  const lower = v.toLowerCase();
  const tab = TABS[lower];
  if (tab) return { kind: "tab", tab };
  if (lower === "support") return { kind: "supportList" };
  const m = /^ticket_(tck-\d{1,9})$/i.exec(v);
  if (m) return { kind: "ticket", number: m[1]!.toUpperCase() };
  // event_<uuid> — exact event (Mini App «Поделиться», bot notifications; TG-FR-027)
  const ev = /^event_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(v);
  if (ev) return { kind: "event", id: ev[1]!.toLowerCase() };
  // legacy evt_… slugs (prototype) have no event id — open the catalogue
  if (/^evt_[a-z0-9_]{1,60}$/i.test(v)) return { kind: "tab", tab: "catalog" };
  return null;
}

/**
 * Link that opens this Mini App on an event: https://t.me/<bot>/<app>?startapp=event_<uuid> when the Mini App has
 * a short name, otherwise the bot's main Mini App https://t.me/<bot>?startapp=event_<uuid>.
 */
export function eventStartLink(bot: string, appShortName: string, eventId: string): string {
  const b = bot.replace(/^@/, "");
  const app = /^[A-Za-z0-9_]{3,64}$/.test(appShortName) ? `/${appShortName}` : "";
  return `https://t.me/${encodeURIComponent(b)}${app}?startapp=event_${encodeURIComponent(eventId.toLowerCase())}`;
}
