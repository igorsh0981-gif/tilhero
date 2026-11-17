import type { ExperienceConfig, HomeSectionType } from "@tilhero/contracts/bff";
import tokenNames from "@tilhero/ui-tokens/token-names.json";

/**
 * Remote Experience Config (ТЗ UI/CSS §3–5, §8): theme tokens and Home section
 * order/visibility come from the server; a bundled fallback keeps the app working
 * when experience-config is down. Only allow-listed CSS variables with validated
 * values are applied — never arbitrary CSS or JS.
 */
export const FALLBACK_CONFIG: ExperienceConfig = {
  app: "miniapp",
  version: "2.0.3",
  theme: { id: "default", version: "2.0.3", tokens: {} },
  home: {
    welcome_mode: "first_visit_only",
    sections: [
      { type: "event_carousel", key: "best_for_you", variant: "large", enabled: true },
      { type: "watch_changes", key: "watch", variant: "compact", enabled: true },
      { type: "event_carousel", key: "sales_soon", variant: "compact", enabled: true },
      { type: "news_carousel", key: "news", variant: "compact", enabled: true },
    ],
  },
  flags: {},
  hotel_rating_min: 8.5,
};

export type ConfigSource = "remote" | "local";
type TokenKind = "color" | "length" | "number" | "font";

const ALLOWED = tokenNames.tokens as Record<string, TokenKind>;
const FONTS = new Set(tokenNames.fonts);
const SECTION_TYPES: ReadonlySet<HomeSectionType> = new Set(["event_carousel", "watch_changes", "news_carousel", "ai_summary", "catalog_link"]);
const THEMES = new Set(["default", "bank"]);
const FONT_FALLBACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/+-]{1,60}\))$/i;
const LENGTH = /^(0|-?\d{1,4}(\.\d{1,3})?(px|rem|em|%))$/;
const NUMBER = /^\d{1,2}(\.\d{1,3})?$|^\.\d{1,3}$/;

export function sanitizeTokenValue(kind: TokenKind, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > 80 || /[;{}<>\\]|url\(|expression|var\(/i.test(v)) return null;
  switch (kind) {
    case "color":
      return COLOR.test(v) ? v : null;
    case "length":
      return LENGTH.test(v) ? v : null;
    case "number":
      return NUMBER.test(v) && Number(v) >= 0 && Number(v) <= 10 ? v : null;
    case "font": {
      const name = v.replace(/^["']|["']$/g, "");
      return FONTS.has(name) ? `"${name}", "${name} Fallback", ${FONT_FALLBACK}` : null;
    }
    default:
      return null;
  }
}

/** Keep only allow-listed tokens with valid values. */
export function sanitizeTokens(tokens: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tokens || typeof tokens !== "object") return out;
  for (const [name, value] of Object.entries(tokens as Record<string, unknown>)) {
    const kind = ALLOWED[name];
    if (!kind) continue;
    const v = sanitizeTokenValue(kind, value);
    if (v !== null) out[name] = v;
  }
  return out;
}

/** Structural validation of a server payload; null → use the bundled fallback. */
export function validateConfig(raw: unknown): ExperienceConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<ExperienceConfig>;
  if (typeof c.version !== "string" || !c.theme || typeof c.theme !== "object" || !c.home || typeof c.home !== "object") return null;
  if (!Array.isArray(c.home.sections)) return null;
  const sections = c.home.sections
    .filter((s) => s && SECTION_TYPES.has(s.type) && typeof s.key === "string" && /^[a-z0-9_]{1,40}$/.test(s.key))
    .map((s) => ({ type: s.type, key: s.key, variant: s.variant === "large" ? ("large" as const) : ("compact" as const), enabled: s.enabled !== false }));
  const mode = c.home.welcome_mode;
  return {
    app: "miniapp",
    version: c.version.slice(0, 20),
    theme: {
      id: typeof c.theme.id === "string" && THEMES.has(c.theme.id) ? c.theme.id : "default",
      version: typeof c.theme.version === "string" ? c.theme.version.slice(0, 20) : c.version.slice(0, 20),
      tokens: sanitizeTokens(c.theme.tokens),
    },
    home: { welcome_mode: mode === "always" || mode === "never" ? mode : "first_visit_only", sections },
    flags: c.flags && typeof c.flags === "object" ? Object.fromEntries(Object.entries(c.flags).filter(([, v]) => typeof v === "boolean")) : {},
    hotel_rating_min: typeof c.hotel_rating_min === "number" ? c.hotel_rating_min : 8.5,
  };
}

let appliedTokens: string[] = [];

/** Apply theme id + tokens as CSS variables on <html>. Previously applied tokens are removed (rollback-safe). */
export function applyTheme(config: ExperienceConfig, root: HTMLElement = document.documentElement): void {
  for (const name of appliedTokens) root.style.removeProperty(name);
  const tokens = sanitizeTokens(config.theme.tokens);
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  appliedTokens = Object.keys(tokens);
  root.dataset.theme = THEMES.has(config.theme.id) ? config.theme.id : "default";
  root.dataset.themeVersion = config.theme.version;
}

export async function fetchExperience(load: (signal: AbortSignal) => Promise<unknown>, timeoutMs = 4000): Promise<{ config: ExperienceConfig; source: ConfigSource }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const cfg = validateConfig(await load(ctrl.signal));
    return cfg ? { config: cfg, source: "remote" } : { config: FALLBACK_CONFIG, source: "local" };
  } catch {
    return { config: FALLBACK_CONFIG, source: "local" };
  } finally {
    clearTimeout(timer);
  }
}
