import type { ExperienceConfig, HomeSectionType } from "@tilhero/contracts/bff";
import tokenNames from "@tilhero/ui-tokens/token-names.json";

/**
 * Remote Experience Config: theme tokens, Home sections and flags come from the server (GET /v1/experience/config);
 * a bundled fallback keeps the app working when experience-config is down. Only allow-listed CSS variables
 * (packages/ui-tokens/token-names.json) with validated values are applied — never arbitrary CSS or JS.
 * Theme ids never choose the scheme: light or dark is the user's choice (Profile → «Тема», default «Как в Telegram»,
 * src/tg/theme.ts) — the choice is more important than the server. The id says which notebook the colour tokens tune:
 * "notebook" — the LIGHT palette, applied only while the scheme is light; "notebook_dark" — the DARK palette, applied
 * only while the scheme is dark. The other notebook keeps its colours from ui-tokens; lengths and fonts apply in both.
 * Server shape (experience-config 1.0.0): theme {id, version, tokens}, home.sections (each type at most once), flags.
 */
export const FALLBACK_CONFIG: ExperienceConfig = {
  app: "miniapp",
  version: "1.0.0",
  theme: { id: "notebook", version: "1.0.0", tokens: {} },
  home: {
    sections: [
      { type: "today_plan", key: "today", variant: "large", enabled: true },
      { type: "lesson_of_day", key: "lesson", variant: "large", enabled: true },
      { type: "whats_new", key: "whats_new", variant: "compact", enabled: true },
      { type: "family", key: "family", variant: "compact", enabled: true },
    ],
  },
  flags: {},
};

export type ConfigSource = "remote" | "local";
type TokenKind = "color" | "length" | "font";
type ThemeId = ExperienceConfig["theme"]["id"];

const ALLOWED = tokenNames.tokens as Record<string, TokenKind>;
const FONTS = new Set(tokenNames.fonts);
const SECTION_TYPES: ReadonlySet<HomeSectionType> = new Set(["today_plan", "lesson_of_day", "review", "whats_new", "family", "news"]);
const THEMES: ReadonlySet<ThemeId> = new Set(["notebook", "notebook_dark"]);
const FONT_FALLBACK: Record<string, string> = {
  Onest: '"Onest Fallback", ui-sans-serif, system-ui, sans-serif',
  Unbounded: '"Unbounded Fallback", ui-sans-serif, system-ui, sans-serif',
  Caveat: '"Caveat Fallback", cursive',
};

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/+-]{1,60}\))$/i;
const LENGTH = /^(0|\d{1,3}(\.\d{1,3})?(px|rem|em))$/;

export function sanitizeTokenValue(kind: TokenKind, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > 80 || /[;{}<>\\]|url\(|expression|var\(/i.test(v)) return null;
  switch (kind) {
    case "color":
      return COLOR.test(v) ? v : null;
    case "length":
      return LENGTH.test(v) ? v : null;
    case "font": {
      // the first family decides; the stack is always ours (idempotent: a sanitised value sanitises to itself)
      const name = (v.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
      return FONTS.has(name) ? `"${name}", ${FONT_FALLBACK[name] ?? "sans-serif"}` : null;
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
  const seen = new Set<string>();
  const sections = c.home.sections
    .filter((s) => s && SECTION_TYPES.has(s.type) && typeof s.key === "string" && /^[a-z0-9_]{1,40}$/.test(s.key))
    .filter((s) => (seen.has(s.type) ? false : (seen.add(s.type), true)))
    .map((s) => ({ type: s.type, key: s.key, variant: s.variant === "large" ? ("large" as const) : ("compact" as const), enabled: s.enabled !== false }));
  const id = c.theme.id;
  return {
    app: "miniapp",
    version: c.version.slice(0, 20),
    theme: {
      id: typeof id === "string" && THEMES.has(id) ? id : "notebook",
      version: typeof c.theme.version === "string" ? c.theme.version.slice(0, 20) : c.version.slice(0, 20),
      tokens: sanitizeTokens(c.theme.tokens),
    },
    home: { sections },
    flags: c.flags && typeof c.flags === "object" ? Object.fromEntries(Object.entries(c.flags).filter(([, v]) => typeof v === "boolean")) : {},
  };
}

export const REMOTE_STYLE_ID = "remote-theme";

/**
 * CSS text for the remote tokens. Values are already sanitised (allow-listed names, strict value patterns), so the
 * text cannot carry selectors, url() or anything but a declaration. Unlayered → above every ui-tokens layer.
 */
export function themeCss(config: ExperienceConfig): string {
  const tokens = sanitizeTokens(config.theme.tokens);
  const colors: string[] = [];
  const rest: string[] = [];
  for (const [name, value] of Object.entries(tokens)) (ALLOWED[name] === "color" ? colors : rest).push(`${name}: ${value};`);
  const out: string[] = [];
  if (rest.length) out.push(`:root { ${rest.join(" ")} }`);
  if (colors.length) {
    const sel = config.theme.id === "notebook_dark" ? ':root[data-scheme="dark"]' : ':root:not([data-scheme="dark"])';
    out.push(`${sel} { ${colors.join(" ")} }`);
  }
  return out.join("\n");
}

/**
 * Apply the remote tokens (replaces the previous ones: activation and rollback without a release). html[data-theme]
 * stays with the user's scheme (src/tg/theme.ts); the server's id is kept in html[data-theme-remote] for diagnostics.
 */
export function applyTheme(config: ExperienceConfig, root: HTMLElement = document.documentElement): void {
  const doc = root.ownerDocument;
  let el = doc.getElementById(REMOTE_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = REMOTE_STYLE_ID;
    doc.head.appendChild(el);
  }
  el.textContent = themeCss(config);
  root.dataset.themeRemote = THEMES.has(config.theme.id) ? config.theme.id : "notebook";
  root.dataset.themeVersion = config.theme.version;
}

/** Feature flag of the config; a missing flag is on (the bundled behaviour). */
export function flag(config: ExperienceConfig, name: string): boolean {
  return config.flags[name] !== false;
}

/** Sections of Home that are enabled, in the server's order (unknown types are dropped by validateConfig). */
export function homeSections(config: ExperienceConfig): HomeSectionType[] {
  const out: HomeSectionType[] = [];
  for (const s of config.home.sections) if (s.enabled && !out.includes(s.type)) out.push(s.type);
  if (!out.includes("today_plan")) out.unshift("today_plan");
  return out;
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
