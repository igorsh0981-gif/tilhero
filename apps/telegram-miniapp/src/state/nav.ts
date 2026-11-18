import type { ReleaseNoteRoute } from "@tilhero/contracts/bff";
import { useCallback, useMemo, useState } from "react";

/** Main shell navigation: five tabs (prototype) and a stack of pushed screens above the current tab. */
export type Tab = "home" | "lessons" | "review" | "progress" | "profile";
export const TABS: readonly Tab[] = ["home", "lessons", "review", "progress", "profile"];

export type Pushed =
  | { name: "inbox" }
  | { name: "news" }
  | { name: "schedule" }
  | { name: "notifSettings" }
  | { name: "language" }
  | { name: "theme" }
  | { name: "goal" }
  | { name: "family" }
  | { name: "guardian" }
  | { name: "privacy" }
  | { name: "parentCode"; cancel?: boolean }
  | { name: "delete" }
  | { name: "support"; number?: string }
  | { name: "ticket"; id: string };

export interface NavState {
  tab: Tab;
  stack: Pushed[];
}

export interface Nav extends NavState {
  push(p: Pushed): void;
  back(): void;
  goTab(t: Tab): void;
  /** a route from «Что нового», a notification or a deep link */
  route(r: ReleaseNoteRoute): void;
  reset(): void;
  top: Pushed | null;
}

const ROUTE_SCREEN: Partial<Record<ReleaseNoteRoute, Pushed["name"]>> = {
  schedule: "schedule",
  family: "family",
  support: "support",
  notifications: "inbox",
  news: "news",
};

/**
 * Where a ReleaseNoteRoute leads: a tab root, or a screen pushed on top of the current stack (so «Назад» returns to
 * where the link was opened — the notification center, «Что нового», Home).
 */
export function routeTarget(r: ReleaseNoteRoute, cur: NavState): NavState {
  if ((TABS as readonly string[]).includes(r)) return { tab: r as Tab, stack: [] };
  const name = ROUTE_SCREEN[r];
  if (!name) return { tab: "home", stack: [] };
  const top = cur.stack[cur.stack.length - 1];
  if (top?.name === name) return cur;
  return { tab: cur.tab, stack: [...cur.stack.filter((p) => p.name !== name), { name } as Pushed] };
}

export function useNav(initial: NavState = { tab: "home", stack: [] }): Nav {
  const [state, setState] = useState<NavState>(initial);
  const push = useCallback((p: Pushed) => setState((s) => ({ ...s, stack: [...s.stack, p] })), []);
  const back = useCallback(() => setState((s) => (s.stack.length ? { ...s, stack: s.stack.slice(0, -1) } : s.tab !== "home" ? { tab: "home", stack: [] } : s)), []);
  const goTab = useCallback((t: Tab) => setState({ tab: t, stack: [] }), []);
  const route = useCallback((r: ReleaseNoteRoute) => setState((s) => routeTarget(r, s)), []);
  const reset = useCallback(() => setState({ tab: "home", stack: [] }), []);
  return useMemo(() => ({ ...state, push, back, goTab, route, reset, top: state.stack.length ? state.stack[state.stack.length - 1]! : null }), [state, push, back, goTab, route, reset]);
}
