import { getWebApp, isInsideTelegram, supports } from "./webapp";

/** Telegram HapticFeedback. No-op outside Telegram (never navigator.vibrate). */
function hf() {
  const wa = getWebApp();
  return wa && isInsideTelegram() && supports("6.1") ? wa.HapticFeedback ?? null : null;
}

export const haptic = {
  selection(): void {
    try { hf()?.selectionChanged(); } catch { /* ignore */ }
  },
  impact(style: "light" | "medium" | "heavy" = "light"): void {
    try { hf()?.impactOccurred(style); } catch { /* ignore */ }
  },
  notify(type: "success" | "error" | "warning"): void {
    try { hf()?.notificationOccurred(type); } catch { /* ignore */ }
  },
};
