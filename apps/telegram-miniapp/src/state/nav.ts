import type { DiagnosticResult, LessonSummary, MemberId, ReviewSummary, TicketCategory } from "@tilhero/contracts/bff";
import type { Localized } from "@tilhero/contracts/content";
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
  /** category / subject — a prefilled new request (sprint 8: «Вопрос по оплате» → SUBSCRIPTION_PAYMENT) */
  | { name: "support"; number?: string; category?: TicketCategory; subject?: string }
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
  | { name: "languages" }
  // sprint 4
  | { name: "lessonCard"; id: string }
  /** duelId (sprint 7) — the tasks of a duel: the end of the player leads back to the duel, not to a lesson summary */
  | { name: "player"; sessionId: string; duelId?: string }
  /** fresh — just finished in the player (sprint 6: the rewards of the game are shown and polled only then) */
  | { name: "lessonSummary"; sessionId: string; summary?: LessonSummary; fresh?: boolean }
  | { name: "appeal"; evaluationId: string; title: Localized }
  // sprint 5: «Повторение дня» (autostart — from the card of Home / the dictionary: the session starts at once; without
  // it — a start panel, e.g. from the notification reviews_due), its summary, a card of the dictionary, a reading text,
  // the voice recording consent
  | { name: "review"; autostart?: boolean }
  | { name: "reviewSummary"; sessionId: string; summary: ReviewSummary; fresh?: boolean }
  | { name: "card"; id: string }
  | { name: "reading"; id: string }
  | { name: "voiceConsent" }
  // sprint 6: the game — the hero, the shop, the history of the ledger, badges, the motivation settings
  | { name: "heroes" }
  | { name: "shop" }
  | { name: "gameHistory" }
  | { name: "badges" }
  | { name: "gameSettings" }
  // sprint 7: friends (a child — «Моя семья»), blocks, sanctions, leagues of the week, duels, the pair lesson, referrals
  | { name: "friends" }
  | { name: "blocked" }
  | { name: "sanctions" }
  | { name: "leagues"; tab?: "friends" | "family" | "general" }
  | { name: "leagueHistory" }
  | { name: "duels" }
  | { name: "duel"; id: string }
  | { name: "duelReview"; sessionId: string; duelId: string }
  | { name: "pairRooms" }
  | { name: "pairInvite"; partner?: MemberId; partnerLabel?: string }
  | { name: "pairRoom"; id: string }
  | { name: "pairReport"; id: string }
  | { name: "referrals" }
  // sprint 8: the subscription for Telegram Stars, the history of Stars payments, the history of AI minutes, tils for Stars
  | { name: "subscription" }
  | { name: "payments" }
  | { name: "minutes" }
  | { name: "tilShop" };

export type PracticeTab = "scenarios" | "media" | "reading";

export interface NavState {
  tab: Tab;
  stack: Pushed[];
}

export interface Nav extends NavState {
  push(p: Pushed): void;
  /** the top screen gives way to another (the player → the summary): «Назад» does not return to it */
  replace(p: Pushed): void;
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
  // release 6.1: the screens of the game (sprint 6) and reading texts (sprint 5, «Практика» → «Чтение»)
  heroes: { name: "heroes" },
  shop: { name: "shop" },
  badges: { name: "badges" },
  game_history: { name: "gameHistory" },
  game_settings: { name: "gameSettings" },
  reading: { name: "practice", tab: "reading" },
  // sprint 7
  friends: { name: "friends" },
  leagues: { name: "leagues" },
  duels: { name: "duels" },
  referrals: { name: "referrals" },
  // sprint 8 (the notifications about payments lead to route_subscription)
  subscription: { name: "subscription" },
  til_shop: { name: "tilShop" },
};
/** Routes that open a tab root: the skill map lives on the «Прогресс» tab, the dictionary (release 6.1) is the root
 *  of the «Словарь» tab. */
const ROUTE_TAB: Partial<Record<AppRoute, Tab>> = { skills: "progress", dictionary: "review" };
/** Routes into the game: when the operator switched the game off (flag `game`), they lead Home. */
export const GAME_ROUTES: readonly AppRoute[] = ["heroes", "shop", "badges", "game_history", "game_settings", "leagues", "duels", "til_shop"];
export const routeAllowed = (r: AppRoute, gameOn: boolean): AppRoute => (!gameOn && GAME_ROUTES.includes(r) ? "home" : r);
/** Sprint 5: route_review (the evening notification reviews_due, «Что нового») opens «Повторение дня» above the
 *  «Словарь» tab — «Назад» lands in the dictionary. */
const REVIEW_SCREEN: Pushed = { name: "review" };

const samePushed = (a: Pushed | undefined, b: Pushed): boolean => !!a && JSON.stringify(a) === JSON.stringify(b);

/**
 * Where an AppRoute leads: a tab root, or a screen pushed on top of the current stack (so «Назад» returns to
 * where the link was opened — the notification center, «Что нового», Home).
 */
export function routeTarget(r: AppRoute, cur: NavState): NavState {
  if (r === "review") {
    const top = cur.stack[cur.stack.length - 1];
    if (cur.tab === "review" && top?.name === "review") return cur;
    return { tab: "review", stack: [REVIEW_SCREEN] };
  }
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
  const replace = useCallback((p: Pushed) => setState((s) => ({ ...s, stack: [...s.stack.slice(0, -1), p] })), []);
  const back = useCallback(() => setState((s) => (s.stack.length ? { ...s, stack: s.stack.slice(0, -1) } : s.tab !== "home" ? { tab: "home", stack: [] } : s)), []);
  const goTab = useCallback((t: Tab) => setState({ tab: t, stack: [] }), []);
  const route = useCallback((r: AppRoute) => setState((s) => routeTarget(r, s)), []);
  const reset = useCallback(() => setState({ tab: "home", stack: [] }), []);
  return useMemo(
    () => ({ ...state, push, replace, back, goTab, route, reset, top: state.stack.length ? state.stack[state.stack.length - 1]! : null }),
    [state, push, replace, back, goTab, route, reset],
  );
}
