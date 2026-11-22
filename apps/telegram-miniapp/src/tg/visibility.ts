import { getWebApp } from "./webapp";

/**
 * The Mini App is on screen or not: the document visibility (a hidden tab, a minimised window, the phone locked) and the
 * Telegram events `deactivated` / `activated` (Bot API 8.0: the Mini App went to the background — another chat, the
 * minimised sheet). The callback gets false when either says hidden, true when both say visible again; repeated states
 * are not reported. Returns the unsubscribe.
 */
export function onAppVisibility(cb: (visible: boolean) => void): () => void {
  const doc = typeof document !== "undefined" ? document : null;
  let tgActive = true;
  let last = visibleNow();
  function visibleNow(): boolean {
    return (!doc || doc.visibilityState !== "hidden") && tgActive;
  }
  const check = () => {
    const v = visibleNow();
    if (v === last) return;
    last = v;
    cb(v);
  };
  const onDoc = () => check();
  const onActivated = () => {
    tgActive = true;
    check();
  };
  const onDeactivated = () => {
    tgActive = false;
    check();
  };
  doc?.addEventListener("visibilitychange", onDoc);
  const wa = getWebApp();
  try {
    wa?.onEvent("activated", onActivated);
    wa?.onEvent("deactivated", onDeactivated);
  } catch {
    /* an old client without these events: the document visibility still works */
  }
  return () => {
    doc?.removeEventListener("visibilitychange", onDoc);
    try {
      wa?.offEvent("activated", onActivated);
      wa?.offEvent("deactivated", onDeactivated);
    } catch {
      /* ignore */
    }
  };
}
