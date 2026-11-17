import type { TgInsets, TgThemeParams } from "./types";
import { getWebApp, isInsideTelegram, supports } from "./webapp";

const HEX = /^#[0-9a-f]{6}$/i;

/** themeParams → --tg-theme-* CSS variables (bridge); colorScheme → html[data-scheme]. */
export function applyThemeParams(params: TgThemeParams, scheme: "light" | "dark", root: HTMLElement = document.documentElement): void {
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && HEX.test(value)) root.style.setProperty(`--tg-theme-${key.replace(/_/g, "-")}`, value);
  }
  root.dataset.scheme = scheme === "light" ? "light" : "dark";
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

/** Paint the native Telegram header / background / bottom bar with our theme colours. */
export function syncNativeChrome(): void {
  const wa = getWebApp();
  if (!wa || !isInsideTelegram()) return;
  const chrome = readToken("--chrome");
  const bg = readToken("--bg");
  try {
    if (chrome && supports("6.1")) wa.setHeaderColor?.(chrome);
    if (bg && supports("6.1")) wa.setBackgroundColor?.(bg);
    if (chrome && supports("7.10")) wa.setBottomBarColor?.(chrome);
  } catch {
    /* ignore unsupported clients */
  }
}

/** Subscribes to theme / viewport / safe-area events. Returns a cleanup function. */
export function bindTelegramEnvironment(onChange?: () => void): () => void {
  const wa = getWebApp();
  if (!wa || !isInsideTelegram()) {
    document.documentElement.dataset.scheme = "dark";
    return () => undefined;
  }
  const theme = () => {
    applyThemeParams(wa.themeParams ?? {}, wa.colorScheme);
    syncNativeChrome();
    onChange?.();
  };
  const viewport = (payload?: unknown) => {
    const stable = (payload as { isStateStable?: boolean } | undefined)?.isStateStable;
    if (stable === false) return;
    applyViewport(wa.viewportStableHeight);
    onChange?.();
  };
  const safe = () => {
    applyInsets("safe", wa.safeAreaInset);
    onChange?.();
  };
  const contentSafe = () => {
    applyInsets("content-safe", wa.contentSafeAreaInset);
    onChange?.();
  };
  theme();
  applyViewport(wa.viewportStableHeight);
  applyInsets("safe", wa.safeAreaInset);
  applyInsets("content-safe", wa.contentSafeAreaInset);
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
