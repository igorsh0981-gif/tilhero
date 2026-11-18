import { applyConfigTokens } from "./config";

export type ThemeMode = "system" | "light" | "dark";

export function systemPrefersDark(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function isDark(mode: ThemeMode): boolean {
  return mode === "dark" || (mode === "system" && systemPrefersDark());
}

/** data-theme on <html> (absent = follow the OS) + re-application of config tokens for the new scheme. */
export function applyThemeMode(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  applyConfigTokens(null, isDark(mode), root);
}
