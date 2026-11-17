import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { StackStore } from "./store";
import { getWebApp, isInsideTelegram, supports } from "./webapp";

/**
 * Telegram BackButton bound to the screen/sheet stack: the most recently registered handler is active. Inside
 * Telegram (6.1+) the native button is shown and the in-app back button in the bar is hidden; outside Telegram the
 * bar renders its own button. Main actions are in-page buttons (prototype), not the native MainButton.
 */
export interface BackSpec {
  onBack: () => void;
}

export const backButtonStore = new StackStore<BackSpec>();

export const nativeBackButton = (): boolean => isInsideTelegram() && supports("6.1");

let wired = false;
function wire(): void {
  if (wired || !nativeBackButton()) return;
  const wa = getWebApp();
  if (!wa) return;
  wired = true;
  wa.BackButton.onClick(() => backButtonStore.top()?.onBack());
  const sync = () => {
    if (backButtonStore.top()) wa.BackButton.show();
    else wa.BackButton.hide();
  };
  backButtonStore.subscribe(sync);
  sync();
}

/** Registers a back handler while mounted (null — nothing to go back to). The latest handler is always called. */
export function useBackButton(onBack: (() => void) | null): void {
  const id = useRef<number | null>(null);
  const latest = useRef(onBack);
  latest.current = onBack;
  const active = onBack != null;
  useLayoutEffect(() => {
    wire();
    if (!active) return;
    id.current = backButtonStore.push({ onBack: () => latest.current?.() });
    return () => {
      if (id.current != null) backButtonStore.remove(id.current);
      id.current = null;
    };
  }, [active]);
}

export function useStoreTop<T>(store: StackStore<T>): T | null {
  return useSyncExternalStore(store.subscribe, () => store.top(), () => null);
}
