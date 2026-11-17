import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { StackStore } from "./store";
import { getWebApp, isInsideTelegram, supports } from "./webapp";

export interface MainButtonSpec {
  text: string;
  onClick: () => void;
  disabled?: boolean;
  progress?: boolean;
  variant?: "primary" | "danger";
  /** Shorter label for narrow screens (fallback bar only). */
  short?: string;
}
export interface SecondaryButtonSpec {
  text: string;
  onClick: () => void;
}
export interface BackSpec {
  onBack: () => void;
}

export const mainButtonStore = new StackStore<MainButtonSpec>();
export const secondaryButtonStore = new StackStore<SecondaryButtonSpec>();
export const backButtonStore = new StackStore<BackSpec>();

const HEX = /^#[0-9a-f]{6}$/i;
function token(name: string): string | undefined {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return HEX.test(v) ? v : undefined;
}

export const nativeMainButton = (): boolean => isInsideTelegram() && supports("6.0");
export const nativeSecondaryButton = (): boolean => isInsideTelegram() && supports("7.10");
export const nativeBackButton = (): boolean => isInsideTelegram() && supports("6.1");

/* ---------- native sync: one stable click handler per button that calls the active spec ---------- */
let wired = false;
function wireNative(): void {
  if (wired) return;
  const wa = getWebApp();
  if (!wa) return;
  wired = true;
  if (nativeMainButton()) {
    wa.MainButton.onClick(() => {
      const s = mainButtonStore.top();
      if (s && !s.disabled && !s.progress) s.onClick();
    });
    mainButtonStore.subscribe(syncMain);
    syncMain();
  }
  if (nativeSecondaryButton() && wa.SecondaryButton) {
    wa.SecondaryButton.onClick(() => secondaryButtonStore.top()?.onClick());
    secondaryButtonStore.subscribe(syncSecondary);
    syncSecondary();
  }
  if (nativeBackButton()) {
    wa.BackButton.onClick(() => backButtonStore.top()?.onBack());
    backButtonStore.subscribe(syncBack);
    syncBack();
  }
}

function syncMain(): void {
  const wa = getWebApp();
  if (!wa) return;
  const s = mainButtonStore.top();
  const mb = wa.MainButton;
  if (!s) {
    mb.hideProgress();
    mb.hide();
    return;
  }
  const inactive = !!s.disabled;
  const bg = inactive ? token("--surface-2") : s.variant === "danger" ? token("--bad") : token("--btn-bg");
  const tx = inactive ? token("--muted") : s.variant === "danger" ? token("--c-white") : token("--btn-tx");
  mb.setParams({ text: s.text, is_active: !inactive, is_visible: true, ...(bg ? { color: bg } : {}), ...(tx ? { text_color: tx } : {}) });
  if (s.progress) mb.showProgress(false);
  else mb.hideProgress();
}

function syncSecondary(): void {
  const sb = getWebApp()?.SecondaryButton;
  if (!sb) return;
  const s = secondaryButtonStore.top();
  if (!s) {
    sb.hide();
    return;
  }
  const bg = token("--surface-2");
  const tx = token("--ink");
  sb.setParams({ text: s.text, is_visible: true, is_active: true, position: "left", ...(bg ? { color: bg } : {}), ...(tx ? { text_color: tx } : {}) });
}

function syncBack(): void {
  const bb = getWebApp()?.BackButton;
  if (!bb) return;
  if (backButtonStore.top()) bb.show();
  else bb.hide();
}

/** Re-apply colours after a theme change (tokens changed). */
export function resyncNativeButtons(): void {
  if (!wired) return;
  if (nativeMainButton()) syncMain();
  if (nativeSecondaryButton()) syncSecondary();
}

/* ---------- hooks ---------- */
/**
 * Registers `spec` while the component is mounted. Function props are replaced by stable
 * trampolines that call the latest render's handler, and the store is only notified when
 * the serialisable part (text, disabled, progress…) changes — no render loops.
 */
function useRegistration<T extends object>(store: StackStore<T>, spec: T | null): void {
  const id = useRef<number | null>(null);
  const latest = useRef(spec);
  const lastKey = useRef<string>("");
  latest.current = spec;
  useLayoutEffect(() => {
    wireNative();
    return () => {
      if (id.current != null) store.remove(id.current);
      id.current = null;
      lastKey.current = "";
    };
  }, [store]);
  useLayoutEffect(() => {
    if (spec == null) {
      if (id.current != null) store.remove(id.current);
      id.current = null;
      lastKey.current = "";
      return;
    }
    const key = JSON.stringify(spec);
    if (id.current != null && key === lastKey.current) return;
    lastKey.current = key;
    const stable = { ...spec } as Record<string, unknown>;
    for (const [k, v] of Object.entries(spec)) {
      if (typeof v === "function") {
        stable[k] = (...args: unknown[]) => {
          const fn = (latest.current as Record<string, unknown> | null)?.[k];
          if (typeof fn === "function") (fn as (...a: unknown[]) => void)(...args);
        };
      }
    }
    if (id.current == null) id.current = store.push(stable as T);
    else store.update(id.current, stable as T);
  });
}

/** Telegram MainButton for the screen/sheet that calls it (fallback bar outside Telegram). */
export function useMainButton(spec: MainButtonSpec | null): void {
  useRegistration(mainButtonStore, spec);
}

/** Telegram SecondaryButton (7.10+). Returns false when it cannot be shown, so the caller renders an in-page button. */
export function useSecondaryButton(spec: SecondaryButtonSpec | null): boolean {
  useRegistration(secondaryButtonStore, spec);
  return !isInsideTelegram() || nativeSecondaryButton();
}

/** Telegram BackButton bound to the navigation stack. Pass null to hide. */
export function useBackButton(onBack: (() => void) | null): void {
  useRegistration(backButtonStore, onBack ? { onBack } : null);
}

export function useStoreTop<T>(store: StackStore<T>): T | null {
  return useSyncExternalStore(store.subscribe, () => store.top(), () => null);
}

/** Wire native buttons once the app shell mounts (idempotent). */
export function useNativeButtonsWiring(): void {
  useEffect(() => {
    wireNative();
  }, []);
}
