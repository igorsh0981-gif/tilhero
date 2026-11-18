/**
 * Admin theme from Remote Experience Config (app=admin, A46): the active version's `payload.theme.tokens`
 * are applied to <html> at runtime — a rollback/activation changes the look without rebuilding admin-web.
 *
 * Only the token names of the experience-config whitelist (services/experience-config … domain/tokens.py
 * ADMIN_TOKENS, values = proto/admin/src/02-style.css :root) are accepted, and every value is re-checked here
 * with the same "no CSS injection" rules (no url(), var(), expression(), ;{}<>\ …): the client applies
 * nothing the server would not have accepted.
 *
 * The config tokens describe the LIGHT theme (seed admin 1.0.0). Colours and shadows are therefore applied
 * only while the effective theme is light; in the dark theme the built-in dark palette (theme.default.css)
 * stays in force and only the non-colour tokens (radii, sizes, fonts) follow the config. Inline custom
 * properties are set via CSSOM (style.setProperty), which the CSP `style-src 'self'` allows.
 */

export type TokenKind = "color" | "shadow" | "length" | "font";

const COLORS = [
  "--bg", "--surface", "--surface-2", "--surface-3", "--surface-sunk", "--line", "--line-strong",
  "--ink", "--ink-2", "--muted", "--faint", "--field-line",
  "--nav", "--nav-2", "--nav-3", "--nav-ink", "--nav-ink-strong", "--nav-muted", "--nav-line",
  "--accent", "--accent-press", "--accent-ink", "--primary", "--primary-ink", "--primary-hover",
  "--info", "--info-bg", "--info-ink", "--info-line",
  "--good", "--good-bg", "--good-ink", "--good-line",
  "--warn", "--warn-bg", "--warn-ink", "--warn-line", "--bad", "--bad-bg", "--bad-ink", "--bad-line",
  "--neutral-bg", "--neutral-ink", "--note-bg", "--note-line", "--note-ink", "--focus", "--scrim",
  "--chart-grid", "--chart-axis", "--chart-label", "--s1", "--s2", "--s3", "--s4", "--s-other",
  "--s-single", "--s-ghost", "--code-key", "--code-str", "--code-num", "--code-bool",
  "--diff-add", "--diff-add-ink", "--diff-del", "--diff-del-ink",
] as const;

export const ADMIN_TOKENS: Readonly<Record<string, { kind: TokenKind; min?: number; max?: number }>> = {
  ...Object.fromEntries(COLORS.map((n) => [n, { kind: "color" as const }])),
  "--shadow-pop": { kind: "shadow" },
  "--shadow-drawer": { kind: "shadow" },
  "--r-xs": { kind: "length", min: 0, max: 64 },
  "--r-sm": { kind: "length", min: 0, max: 64 },
  "--r": { kind: "length", min: 0, max: 64 },
  "--r-lg": { kind: "length", min: 0, max: 64 },
  "--nav-w": { kind: "length", min: 180, max: 360 },
  "--top-h": { kind: "length", min: 40, max: 96 },
  "--font-ui": { kind: "font" },
  "--font-display": { kind: "font" },
  "--font-mono": { kind: "font" },
};

const FORBIDDEN = /url\s*\(|expression\s*\(|javascript\s*:|var\s*\(|@import|[<>\\;{}]|\/\*|\*\//i;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:\d{1,3}(?:\.\d{1,4})?|\.\d{1,4})%?\s*)?\)$/i;
const LENGTH = /^(\d{1,4}(?:\.\d{1,3})?)(px|rem)?$/;
const FAMILY = /^(?:"[A-Za-z][A-Za-z0-9 -]{0,40}"|'[A-Za-z][A-Za-z0-9 -]{0,40}'|-?[A-Za-z][A-Za-z0-9-]{0,40})$/;
const SHADOW_LAYER = /^(?:inset\s+)?(?:-?\d{1,3}(?:\.\d+)?(?:px)?\s+){2,4}(?:#[0-9a-f]{3,8}|rgba?\([^()]*\))$/i;

export function isColor(v: string): boolean {
  return HEX.test(v) || RGB.test(v);
}

export function validToken(name: string, value: unknown): value is string {
  const spec = ADMIN_TOKENS[name];
  if (!spec || typeof value !== "string" || value.length === 0 || value.length > 300) return false;
  if (FORBIDDEN.test(value) || [...value].some((c) => c.charCodeAt(0) < 0x20)) return false;
  const v = value.trim();
  switch (spec.kind) {
    case "color":
      return isColor(v);
    case "length": {
      const m = LENGTH.exec(v);
      if (!m || (!m[2] && Number(m[1]) !== 0)) return false;
      const n = Number(m[1]);
      return n >= (spec.min ?? 0) && n <= (spec.max ?? Infinity);
    }
    case "font": {
      const parts = v.split(",").map((p) => p.trim());
      return parts.length > 0 && parts.length <= 8 && parts.every((p) => FAMILY.test(p));
    }
    case "shadow": {
      if (v === "none") return true;
      const layers = v.split(/,(?![^(]*\))/).map((p) => p.trim());
      return layers.length <= 3 && layers.every((l) => SHADOW_LAYER.test(l));
    }
  }
}

/** Keeps only whitelisted tokens with valid values; anything else is dropped silently. */
export function sanitizeTokens(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (validToken(name, value)) out[name] = value.trim();
  }
  return out;
}

/** Extracts payload.theme.tokens from an admin ConfigVersion payload. */
export function tokensFromPayload(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== "object") return {};
  const theme = (payload as { theme?: unknown }).theme;
  if (!theme || typeof theme !== "object") return {};
  return sanitizeTokens((theme as { tokens?: unknown }).tokens);
}

const applied = new Set<string>();
let current: Record<string, string> = {};

const isColorRole = (name: string) => {
  const k = ADMIN_TOKENS[name]?.kind;
  return k === "color" || k === "shadow";
};

/** (Re)applies the config tokens for the effective scheme. Safe to call on every theme switch. */
export function applyConfigTokens(tokens: Record<string, string> | null, dark: boolean, root: HTMLElement = document.documentElement): void {
  if (tokens) current = sanitizeTokens(tokens);
  for (const name of applied) root.style.removeProperty(name);
  applied.clear();
  for (const [name, value] of Object.entries(current)) {
    if (dark && isColorRole(name)) continue;
    root.style.setProperty(name, value);
    applied.add(name);
  }
}

export function clearConfigTokens(root: HTMLElement = document.documentElement): void {
  current = {};
  applyConfigTokens({}, false, root);
}

export function appliedTokenNames(): string[] {
  return [...applied];
}

/** payload.layout of an admin config version, validated loosely (unknown widget ids are kept for ordering). */
export function layoutFromPayload(payload: unknown): { density: "compact" | "comfortable"; widgets: Array<{ id: string; enabled: boolean }> } | null {
  if (!payload || typeof payload !== "object") return null;
  const lay = (payload as { layout?: unknown }).layout;
  if (!lay || typeof lay !== "object") return null;
  const l = lay as { density?: unknown; dashboard_widgets?: unknown };
  const density = l.density === "comfortable" ? "comfortable" : "compact";
  const widgets = Array.isArray(l.dashboard_widgets)
    ? l.dashboard_widgets
        .filter((w): w is { id: string; enabled: unknown } => !!w && typeof w === "object" && typeof (w as { id?: unknown }).id === "string")
        .map((w) => ({ id: w.id, enabled: w.enabled !== false }))
    : [];
  return { density, widgets };
}
