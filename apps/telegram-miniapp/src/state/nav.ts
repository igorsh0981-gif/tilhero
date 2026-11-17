/** Navigation stack ↔ Telegram BackButton. Pure reducer (tested in test/nav.test.ts). */
import type { TicketCategory } from "@tilhero/contracts/bff";

export type Tab = "home" | "catalog" | "watch" | "news" | "profile";
export const TABS: readonly Tab[] = ["home", "catalog", "watch", "news", "profile"];

/** Context a support request is created with from an event (TG-FR-041); client_version is added on send. */
export interface EventSupportContext {
  event_id: string;
  provider_id?: string;
  deeplink?: string;
  event_title?: string;
  /** sprint 5: «Проблема с предложением?» — the offer snapshot and the package price at its time */
  offer_id?: string;
  price_snapshot?: { amount: string; currency: "USD"; fetched_at: string };
  /** form presets (not sent as context): category and subject */
  category?: TicketCategory;
  subject?: string;
}

export type Route =
  | { name: Tab }
  | { name: "event"; id: string }
  | { name: "supportNew"; ctx?: EventSupportContext }
  | { name: "supportList" }
  | { name: "supportThread"; id: string }
  | { name: "supportDone"; id: string; number: string };

export interface NavState {
  stack: Route[];
  anim: "push" | "pop" | "fade" | null;
  /** increments on every transition (screen key / scroll reset) */
  seq: number;
}

export type NavAction =
  | { type: "tab"; tab: Tab }
  | { type: "push"; route: Route }
  | { type: "pop" }
  | { type: "replace"; route: Route }
  | { type: "reset"; stack: Route[] };

export const initialNav = (tab: Tab = "home"): NavState => ({ stack: [{ name: tab }], anim: null, seq: 0 });

export function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  return ("id" in a ? a.id : null) === ("id" in b ? b.id : null);
}

export function isTab(name: string): name is Tab {
  return (TABS as readonly string[]).includes(name);
}

export function navReducer(s: NavState, a: NavAction): NavState {
  switch (a.type) {
    case "tab": {
      if (s.stack.length === 1 && s.stack[0]!.name === a.tab) return s;
      return { stack: [{ name: a.tab }], anim: "fade", seq: s.seq + 1 };
    }
    case "push": {
      const top = s.stack[s.stack.length - 1]!;
      if (sameRoute(top, a.route)) return s; // double tap
      return { stack: [...s.stack, a.route], anim: "push", seq: s.seq + 1 };
    }
    case "pop": {
      if (s.stack.length <= 1) return s;
      return { stack: s.stack.slice(0, -1), anim: "pop", seq: s.seq + 1 };
    }
    case "replace": {
      return { stack: [...s.stack.slice(0, -1), a.route], anim: "fade", seq: s.seq + 1 };
    }
    case "reset": {
      if (!a.stack.length) return s;
      return { stack: a.stack, anim: "fade", seq: s.seq + 1 };
    }
    default:
      return s;
  }
}

export const topRoute = (s: NavState): Route => s.stack[s.stack.length - 1]!;
export const rootTab = (s: NavState): Tab => {
  const r = s.stack[0]!.name;
  return isTab(r) ? r : "home";
};
export const canGoBack = (s: NavState): boolean => s.stack.length > 1;
