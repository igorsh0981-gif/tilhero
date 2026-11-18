/**
 * localStorage holds ONLY per-viewer UI preferences (theme, language, collapsed sidebar). Never tokens,
 * session ids or user data: the session lives in the HttpOnly cookie. Every access is wrapped in try/catch
 * (private mode / blocked storage) and the app works without it.
 */
const PREFIX = "tilhero.admin.";
export type PrefKey = "theme" | "lang" | "navCollapsed";

export const prefs = {
  get<T>(key: PrefKey, fallback: T): T {
    try {
      const raw = window.localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: PrefKey, value: unknown): void {
    try {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* storage unavailable — keep it in memory only */
    }
  },
};
