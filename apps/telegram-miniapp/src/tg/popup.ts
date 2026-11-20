import { StackStore } from "./store";
import { getWebApp, isInsideTelegram, supports } from "./webapp";

export interface PopupButton {
  id: string;
  text: string;
  type?: "default" | "destructive" | "cancel";
  /** bold default action (fallback rendering only) */
  primary?: boolean;
}
export interface PopupRequest {
  title: string;
  message: string;
  buttons: PopupButton[];
  resolve: (id: string | null) => void;
}

/** In-app popups (outside Telegram or for >3 buttons). Rendered by ui/PopupHost. */
export const popupStore = new StackStore<PopupRequest>();

/** A native popup is on screen: Telegram allows one at a time (a second showPopup throws WebAppPopupOpened). */
let nativeOpen = false;

/**
 * Telegram showPopup (6.2+) instead of window.confirm. Native popups allow at most
 * 3 buttons, a 64-char title and a 256-char message — otherwise the in-app twin is used.
 * Resolves with the pressed button id, or null when dismissed. A second call while a native popup is open (a double
 * tap) resolves null at once — never a second dialog over the first (sprint 6 review: «Купить» twice).
 */
export function showPopup(p: { title: string; message: string; buttons: PopupButton[] }): Promise<string | null> {
  const wa = getWebApp();
  const fitsNative = p.buttons.length >= 1 && p.buttons.length <= 3 && p.title.length <= 64 && p.message.length <= 256;
  if (wa && isInsideTelegram() && supports("6.2") && fitsNative) {
    if (nativeOpen) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        nativeOpen = true;
        wa.showPopup(
          {
            title: p.title,
            message: p.message,
            buttons: p.buttons.map((b) => ({ id: b.id, text: b.text, type: b.type === "destructive" ? "destructive" : "default" })),
          },
          (id) => {
            nativeOpen = false;
            resolve(id ? id : null);
          },
        );
      } catch (e) {
        nativeOpen = false;
        // another popup of Telegram is already open: this one is dropped, not drawn twice
        if (e instanceof Error && /PopupOpened/i.test(e.message)) resolve(null);
        else resolve(fallback(p));
      }
    });
  }
  return fallback(p);
}

function fallback(p: { title: string; message: string; buttons: PopupButton[] }): Promise<string | null> {
  return new Promise((resolve) => {
    let id = 0;
    const done = (v: string | null) => {
      popupStore.remove(id);
      resolve(v);
    };
    id = popupStore.push({ ...p, resolve: done });
  });
}

/** Confirmation with a cancel and a (possibly destructive) confirm button. */
export async function confirmPopup(p: { title: string; message: string; ok: string; cancel: string; destructive?: boolean }): Promise<boolean> {
  const id = await showPopup({
    title: p.title,
    message: p.message,
    buttons: [
      { id: "cancel", text: p.cancel, type: "cancel" },
      { id: "ok", text: p.ok, type: p.destructive ? "destructive" : "default", primary: !p.destructive },
    ],
  });
  return id === "ok";
}

/**
 * WebApp.requestWriteAccess (6.9+) — permission for the bot to message the user (reminders opt-in). Outside Telegram
 * there is no bot chat to allow: resolves true without asking (the in-app notification center works anyway).
 */
export function requestWriteAccess(): Promise<boolean> {
  const wa = getWebApp();
  if (wa && isInsideTelegram() && supports("6.9") && wa.requestWriteAccess) {
    return new Promise((resolve) => {
      try {
        wa.requestWriteAccess!((granted) => resolve(!!granted));
      } catch {
        resolve(false);
      }
    });
  }
  return Promise.resolve(true);
}
