import { applyInsets, applyViewport } from "./theme";
import type { TgWebApp } from "./types";
import { getWebApp, isInsideTelegram, supports } from "./webapp";

/**
 * Start inside Telegram: ready → expand → no vertical swipes (7.7+) → full screen on phones (Bot API 8.0).
 * In full screen Telegram draws its own buttons over the top of the page: the shell keeps every header below
 * --safe-top = safeAreaInset.top + contentSafeAreaInset.top (packages/ui-tokens/styles/telegram.css), so the insets
 * are re-read whenever the mode changes.
 */
export const FULLSCREEN_MIN_VERSION = "8.0";
/** Phones only (on desktop / web «full screen» is a whole-monitor window). Telegram X for Android reports android_x. */
const MOBILE: ReadonlySet<string> = new Set(["ios", "android", "android_x"]);

export function wantsFullscreen(wa: TgWebApp | null = getWebApp()): boolean {
  if (!wa || !isInsideTelegram()) return false;
  return MOBILE.has(String(wa.platform ?? "").toLowerCase()) && supports(FULLSCREEN_MIN_VERSION) && typeof wa.requestFullscreen === "function";
}

let requested = false;
let bound: TgWebApp | null = null;

function mark(on: boolean): void {
  document.documentElement.dataset.fullscreen = on ? "true" : "false";
}

function refreshLayout(wa: TgWebApp): void {
  applyInsets("safe", wa.safeAreaInset);
  applyInsets("content-safe", wa.contentSafeAreaInset);
  applyViewport(wa.viewportStableHeight);
}

function bind(wa: TgWebApp): void {
  if (bound === wa) return;
  bound = wa;
  wa.onEvent("fullscreenChanged", () => {
    mark(!!wa.isFullscreen);
    refreshLayout(wa);
  });
  wa.onEvent("fullscreenFailed", (payload?: unknown) => {
    // UNSUPPORTED (or anything else): silently stay expanded; ALREADY_FULLSCREEN — we are already there
    const error = (payload as { error?: unknown } | undefined)?.error;
    mark(error === "ALREADY_FULLSCREEN" || !!wa.isFullscreen);
    refreshLayout(wa);
  });
}

/** Full screen on iOS / Android (8.0+), requested once per launch. Returns whether it was asked for. */
export function requestFullscreenOnMobile(): boolean {
  const wa = getWebApp();
  if (!wa || !wantsFullscreen(wa)) return false;
  bind(wa);
  if (wa.isFullscreen) {
    mark(true);
    refreshLayout(wa);
    return true;
  }
  if (requested) return true;
  requested = true;
  try {
    wa.requestFullscreen!();
  } catch {
    mark(false);
  }
  return true;
}

export function isFullscreen(): boolean {
  const wa = getWebApp();
  return !!wa && isInsideTelegram() && !!wa.isFullscreen;
}

export function tgReady(): void {
  const wa = getWebApp();
  if (!wa || !isInsideTelegram()) return;
  try {
    wa.ready();
    wa.expand();
    if (supports("7.7")) wa.disableVerticalSwipes?.();
  } catch {
    /* older clients: ignore */
  }
  requestFullscreenOnMobile();
}

export function resetFullscreenForTests(): void {
  requested = false;
  bound = null;
  delete document.documentElement.dataset.fullscreen;
}
