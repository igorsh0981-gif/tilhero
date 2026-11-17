import type { TgWebApp } from "./types";

/**
 * The ONLY module that reads window.Telegram.WebApp. Everything else in the app
 * goes through src/tg/* (CONVENTIONS §7).
 */
export function getWebApp(): TgWebApp | null {
  if (typeof window === "undefined") return null;
  return window.Telegram?.WebApp ?? null;
}

/** telegram-web-app.js defines WebApp everywhere; inside Telegram initData is non-empty. */
export function isInsideTelegram(): boolean {
  const wa = getWebApp();
  return !!wa && typeof wa.initData === "string" && wa.initData.length > 0;
}

/** Feature check against the client's Bot API version (only meaningful inside Telegram). */
export function supports(version: string): boolean {
  const wa = getWebApp();
  if (!wa || !isInsideTelegram()) return false;
  try {
    return wa.isVersionAtLeast(version);
  } catch {
    return false;
  }
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
}

export function tgClose(): void {
  const wa = getWebApp();
  if (wa && isInsideTelegram()) wa.close();
}

export function openExternal(url: string): void {
  if (!/^https:\/\//i.test(url)) return;
  const wa = getWebApp();
  if (wa && isInsideTelegram()) wa.openLink(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function openTelegramLink(url: string): void {
  if (!/^https:\/\/t\.me\//i.test(url)) return;
  const wa = getWebApp();
  if (wa && isInsideTelegram()) wa.openTelegramLink(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** Telegram share sheet («Поделиться» → chat picker) for a link, via t.me/share/url. */
export function shareToTelegram(url: string, text: string): void {
  if (!/^https:\/\/t\.me\//i.test(url)) return;
  openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
}
