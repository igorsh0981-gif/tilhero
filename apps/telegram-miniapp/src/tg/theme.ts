import { useSyncExternalStore } from "react";
import { kvStore, localGetSync, localKvStore, type KvStore } from "./storage";
import type { TgInsets, TgThemeParams } from "./types";
import { getWebApp, isInsideTelegram, supports } from "./webapp";

const HEX = /^#[0-9a-f]{6}$/i;
export type Scheme = "light" | "dark";

/* ---------------------------------------------------------------- the user's theme choice */

/** Profile → «Тема»: «Как в Telegram» (default), «Светлая», «Тёмная». */
export type ThemePref = "system" | "light" | "dark";
export const THEME_PREFS: readonly ThemePref[] = ["system", "light", "dark"];
/** CloudStorage key (Bot API 6.9+); the localStorage copy is "tilhero:theme_pref" (public/theme-boot.js reads it). */
export const THEME_PREF_KEY = "theme_pref";

export function parseThemePref(raw: unknown): ThemePref | null {
  return raw === "system" || raw === "light" || raw === "dark" ? raw : null;
}

/**
 * The scheme on screen. The user's choice always wins; «Как в Telegram» follows Telegram's colorScheme (outside
 * Telegram — the device). The server's theme id (Remote Experience Config) never overrides it: it only says which
 * scheme its colour tokens tune (config/experience.ts).
 */
export function resolveScheme(pref: ThemePref, platform: Scheme): Scheme {
  return pref === "system" ? platform : pref;
}

interface Appearance {
  pref: ThemePref;
  /** Telegram colorScheme (outside Telegram — prefers-color-scheme) */
  platform: Scheme;
}
const appearance: Appearance = { pref: "system", platform: "light" };
/** user changes since start: a late CloudStorage answer never overrides a fresh choice */
let changes = 0;
const listeners = new Set<() => void>();

export interface ThemeStores {
  cloud: KvStore;
  local: KvStore;
}
const defaultStores = (): ThemeStores => ({ cloud: kvStore(), local: localKvStore() });

/** html[data-scheme] — light / dark notebook; html[data-theme] — the active notebook theme of ui-tokens. */
export function applyScheme(scheme: Scheme, root: HTMLElement = document.documentElement): void {
  root.dataset.scheme = scheme === "dark" ? "dark" : "light";
  root.dataset.theme = scheme === "dark" ? "notebook_dark" : "notebook";
}

function render(): void {
  const root = document.documentElement;
  applyScheme(resolveScheme(appearance.pref, appearance.platform), root);
  root.dataset.themePref = appearance.pref;
  syncNativeChrome();
  for (const l of [...listeners]) l();
}

function detectPlatformScheme(): Scheme {
  const wa = getWebApp();
  if (wa && isInsideTelegram()) return wa.colorScheme === "dark" ? "dark" : "light";
  const mq = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  return mq?.matches ? "dark" : "light";
}

export function getThemePref(): ThemePref {
  return appearance.pref;
}

export function currentScheme(): Scheme {
  return resolveScheme(appearance.pref, appearance.platform);
}

/** Telegram (or the device) changed its colour scheme: followed only with «Как в Telegram». */
export function setPlatformScheme(s: Scheme): void {
  appearance.platform = s === "dark" ? "dark" : "light";
  render();
}

/**
 * Called before the first render (main.tsx): the saved choice from the localStorage copy is applied synchronously
 * (no flash of the wrong notebook), then the CloudStorage copy — the same on every device of the user — is read and,
 * when it differs and the user has not changed anything meanwhile, applied and copied locally.
 */
export function restoreThemePref(stores: ThemeStores = defaultStores()): Promise<ThemePref> {
  appearance.platform = detectPlatformScheme();
  appearance.pref = parseThemePref(localGetSync(THEME_PREF_KEY)) ?? "system";
  render();
  if (stores.cloud.kind !== "cloud") return Promise.resolve(appearance.pref);
  const at = changes;
  return stores.cloud.get(THEME_PREF_KEY).then(
    (raw) => {
      const p = parseThemePref(raw);
      if (p && changes === at && p !== appearance.pref) {
        appearance.pref = p;
        render();
        void stores.local.set(THEME_PREF_KEY, p);
      }
      return appearance.pref;
    },
    () => appearance.pref,
  );
}

/** Apply at once (and repaint the native header / background), then store: CloudStorage when available + the local copy. */
export async function setThemePref(p: ThemePref, stores: ThemeStores = defaultStores()): Promise<KvStore["kind"]> {
  changes += 1;
  appearance.pref = p;
  render();
  await stores.local.set(THEME_PREF_KEY, p).catch(() => undefined);
  if (stores.cloud.kind === "cloud") await stores.cloud.set(THEME_PREF_KEY, p).catch(() => undefined);
  return stores.cloud.kind === "cloud" ? "cloud" : stores.local.kind;
}

/** Where the choice is kept: "cloud" — in Telegram (every device), "local" — this device only. */
export function themeStorageKind(): KvStore["kind"] {
  const cloud = kvStore().kind;
  return cloud === "cloud" ? "cloud" : localKvStore().kind;
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, getThemePref, getThemePref);
}
export function useScheme(): Scheme {
  return useSyncExternalStore(subscribe, currentScheme, currentScheme);
}

export function resetThemeForTests(): void {
  appearance.pref = "system";
  appearance.platform = "light";
  changes = 0;
}

/* ---------------------------------------------------------------- Telegram bridge: theme params, insets, viewport */

/** themeParams → --tg-theme-* CSS variables (bridge). The scheme itself goes through setPlatformScheme. */
export function applyThemeParams(params: TgThemeParams, root: HTMLElement = document.documentElement): void {
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && HEX.test(value)) root.style.setProperty(`--tg-theme-${key.replace(/_/g, "-")}`, value);
  }
}

function px(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? `${Math.round(n)}px` : "0px";
}

export function applyInsets(prefix: "safe" | "content-safe", insets: TgInsets | undefined, root: HTMLElement = document.documentElement): void {
  const i = insets ?? { top: 0, bottom: 0, left: 0, right: 0 };
  root.style.setProperty(`--tg-${prefix}-top`, px(i.top));
  root.style.setProperty(`--tg-${prefix}-bottom`, px(i.bottom));
  root.style.setProperty(`--tg-${prefix}-left`, px(i.left));
  root.style.setProperty(`--tg-${prefix}-right`, px(i.right));
}

/** viewportStableHeight → --tg-vh (the app shell height). Outside Telegram CSS falls back to 100dvh. */
export function applyViewport(stableHeight: number | undefined, root: HTMLElement = document.documentElement): void {
  if (typeof stableHeight === "number" && stableHeight > 120) root.style.setProperty("--tg-vh", `${Math.round(stableHeight)}px`);
}

function readToken(name: string): string | null {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return HEX.test(v) ? v : null;
}

/** Paint the native Telegram header / background / bottom bar with the notebook paper (after every scheme change). */
export function syncNativeChrome(): void {
  const wa = getWebApp();
  if (!wa || !isInsideTelegram()) return;
  const paper = readToken("--paper");
  const card = readToken("--card");
  try {
    if (paper && supports("6.1")) {
      wa.setHeaderColor?.(paper);
      wa.setBackgroundColor?.(paper);
    }
    if (card && supports("7.10")) wa.setBottomBarColor?.(card);
  } catch {
    /* ignore unsupported clients */
  }
}

/** Subscribes to theme / viewport / safe-area events. Outside Telegram the device colour scheme is followed. */
export function bindTelegramEnvironment(onChange?: () => void): () => void {
  const wa = getWebApp();
  if (!wa || !isInsideTelegram()) {
    const mq = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const sync = () => {
      setPlatformScheme(mq?.matches ? "dark" : "light");
      onChange?.();
    };
    sync();
    mq?.addEventListener?.("change", sync);
    return () => mq?.removeEventListener?.("change", sync);
  }
  const theme = () => {
    applyThemeParams(wa.themeParams ?? {});
    setPlatformScheme(wa.colorScheme);
    onChange?.();
  };
  const viewport = (payload?: unknown) => {
    const stable = (payload as { isStateStable?: boolean } | undefined)?.isStateStable;
    if (stable === false) return;
    applyViewport(wa.viewportStableHeight);
    onChange?.();
  };
  const safe = () => applyInsets("safe", wa.safeAreaInset);
  const contentSafe = () => applyInsets("content-safe", wa.contentSafeAreaInset);
  theme();
  applyViewport(wa.viewportStableHeight);
  safe();
  contentSafe();
  wa.onEvent("themeChanged", theme);
  wa.onEvent("viewportChanged", viewport);
  wa.onEvent("safeAreaChanged", safe);
  wa.onEvent("contentSafeAreaChanged", contentSafe);
  return () => {
    wa.offEvent("themeChanged", theme);
    wa.offEvent("viewportChanged", viewport);
    wa.offEvent("safeAreaChanged", safe);
    wa.offEvent("contentSafeAreaChanged", contentSafe);
  };
}
