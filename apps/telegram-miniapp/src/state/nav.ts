import type { DiagnosticResult } from "@tilhero/contracts/bff";
import { useCallback, useMemo, useState } from "react";
import type { AppRoute } from "../tg/deeplink";

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
  | { name: "ticket"; id: string }
  // sprint 3
  | { name: "diagnostics" }
  | { name: "diagResult"; result: DiagnosticResult }
  | { name: "skills" }
  | { name: "plan" }
  | { name: "practice"; tab?: PracticeTab }
  | { name: "scenario"; id: string }
  | { name: "mediaItem"; id: string }
  | { name: "mediaRequests" }
  | { name: "languages" };

export type PracticeTab = "scenarios" | "media";

export interface NavState {
  tab: Tab;
  stack: Pushed[];
}

export interface Nav extends NavState {
  push(p: Pushed): void;
  back(): void;
  goTab(t: Tab): void;
  /** a route from «Что нового», a notification or a deep link */
  route(r: AppRoute): void;
  reset(): void;
  top: Pushed | null;
}

const ROUTE_SCREEN: Partial<Record<AppRoute, Pushed>> = {
  schedule: { name: "schedule" },
  family: { name: "family" },
  support: { name: "support" },
  notifications: { name: "inbox" },
  news: { name: "news" },
  diagnostics: { name: "diagnostics" },
  plan: { name: "plan" },
  scenarios: { name: "practice", tab: "scenarios" },
  media: { name: "practice", tab: "media" },
  media_requests: { name: "mediaRequests" },
  languages: { name: "languages" },
};
/** Routes that open a tab root: the skill map lives on the «Прогресс» tab. */
const ROUTE_TAB: Partial<Record<AppRoute, Tab>> = { skills: "progress" };

const samePushed = (a: Pushed | undefined, b: Pushed): boolean => !!a && JSON.stringify(a) === JSON.stringify(b);

/**
 * Where an AppRoute leads: a tab root, or a screen pushed on top of the current stack (so «Назад» returns to
 * where the link was opened — the notification center, «Что нового», Home).
 */
export function routeTarget(r: AppRoute, cur: NavState): NavState {
  if ((TABS as readonly string[]).includes(r)) return { tab: r as Tab, stack: [] };
  const tab = ROUTE_TAB[r];
  if (tab) return { tab, stack: [] };
  const screen = ROUTE_SCREEN[r];
  if (!screen) return { tab: "home", stack: [] };
  const top = cur.stack[cur.stack.length - 1];
  if (samePushed(top, screen)) return cur;
  return { tab: cur.tab, stack: [...cur.stack.filter((p) => p.name !== screen.name), screen] };
}

export function useNav(initial: NavState = { tab: "home", stack: [] }): Nav {
  const [state, setState] = useState<NavState>(initial);
  const push = useCallback((p: Pushed) => setState((s) => ({ ...s, stack: [...s.stack, p] })), []);
  const back = useCallback(() => setState((s) => (s.stack.length ? { ...s, stack: s.stack.slice(0, -1) } : s.tab !== "home" ? { tab: "home", stack: [] } : s)), []);
  const goTab = useCallback((t: Tab) => setState({ tab: t, stack: [] }), []);
  const route = useCallback((r: AppRoute) => setState((s) => routeTarget(r, s)), []);
  const reset = useCallback(() => setState({ tab: "home", stack: [] }), []);
  return useMemo(() => ({ ...state, push, back, goTab, route, reset, top: state.stack.length ? state.stack[state.stack.length - 1]! : null }), [state, push, back, goTab, route, reset]);
}
