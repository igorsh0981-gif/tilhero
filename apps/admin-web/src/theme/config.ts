/**
 * Admin theme from Remote Experience Config (app=admin): the active version's `payload.theme.tokens` are applied to
 * <html> at runtime — an activation or a rollback changes the look without rebuilding admin-web.
 *
 * Only the token names of the experience-config whitelist (services/experience-config … domain/tokens.py ADMIN_TOKENS,
 * values = `.ad` of the TilHero prototype Admin.dc.html) are accepted, and every value is re-checked here with the same
 * «no CSS injection» rules (no url(), var(), expression(), ;{}<>\ …): the client applies nothing the server would not
 * have accepted.
 *
 * The config tokens describe the LIGHT theme (theme.id = admin_light, seed admin 1.0.0). Colours are therefore applied
 * only while the effective theme is light; in the dark theme the built-in dark palette (theme.default.css, the
 * «notebook at night» of the Mini App) stays in force and only radii, the menu width and fonts follow the config.
 * Inline custom properties are set via CSSOM (style.setProperty), which the CSP `style-src 'self'` allows.
 */

export type TokenKind = "color" | "length" | "font";

const COLORS = [
  "--bg", "--card", "--ink", "--ink2", "--line", "--pen", "--pen-soft", "--side", "--side2",
  "--ok", "--ok-soft", "--warn", "--warn-soft", "--err", "--err-soft",
] as const;

export const ADMIN_TOKENS: Readonly<Record<string, { kind: TokenKind; min?: number; max?: number; px?: boolean }>> = {
  ...Object.fromEntries(COLORS.map((n) => [n, { kind: "color" as const }])),
  "--r-card": { kind: "length", min: 0, max: 32 },
  "--r-btn": { kind: "length", min: 0, max: 24 },
  "--r-field": { kind: "length", min: 0, max: 24 },
  "--nav-w": { kind: "length", min: 180, max: 360, px: true },
  "--font-ui": { kind: "font" },
  "--font-display": { kind: "font" },
  "--font-mono": { kind: "font" },
};

/** Fonts the server accepts in an admin stack (tokens.py ALLOWED_FONTS). */
export const ALLOWED_FONTS: ReadonlySet<string> = new Set([
  "Onest", "Unbounded", "Caveat",
  "ui-sans-serif", "ui-monospace", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto",
  "Helvetica Neue", "Arial", "SFMono-Regular", "Menlo", "Consolas", "sans-serif", "monospace", "cursive",
]);

const FORBIDDEN = /url\s*\(|expression\s*\(|javascript\s*:|var\s*\(|@import|[<>\\;{}]|\/\*|\*\//i;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;
const RGBA = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3}(?:\.\d{1,4})?|\.\d{1,4})(%?)\s*\)$/i;
const LENGTH = /^(\d{1,4}(?:\.\d{1,3})?|\.\d{1,3})(px|rem)?$/;
const FAMILY = /^(?:"([A-Za-z][A-Za-z0-9 -]{0,40})"|'([A-Za-z][A-Za-z0-9 -]{0,40})'|(-?[A-Za-z][A-Za-z0-9-]{0,40}))$/;

export function isColor(v: string): boolean {
  if (HEX.test(v)) return true;
  const m = RGB.exec(v) ?? RGBA.exec(v);
  if (!m) return false;
  if ([m[1], m[2], m[3]].some((x) => Number(x) > 255)) return false;
  return m[4] === undefined || Number(m[4]) <= (m[5] ? 100 : 1);
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
      if (!m) return false;
      if (!m[2]) return Number(m[1]) === 0;
      if (spec.px && m[2] !== "px") return false;
      const px = Number(m[1]) * (m[2] === "rem" ? 16 : 1);
      return px >= (spec.min ?? 0) && px <= (spec.max ?? Infinity);
    }
    case "font": {
      const parts = v.split(",").map((p) => p.trim());
      if (!parts.length || parts.length > 8) return false;
      return parts.every((p) => {
        const m = FAMILY.exec(p);
        const fam = m ? (m[1] ?? m[2] ?? m[3]) : null;
        return !!fam && ALLOWED_FONTS.has(fam);
      });
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

/** Extracts payload.theme.tokens from an admin config (current or a version payload). */
export function tokensFromPayload(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== "object") return {};
  const theme = (payload as { theme?: unknown }).theme;
  if (!theme || typeof theme !== "object") return {};
  return sanitizeTokens((theme as { tokens?: unknown }).tokens);
}

const applied = new Set<string>();
let current: Record<string, string> = {};

const isColorRole = (name: string) => ADMIN_TOKENS[name]?.kind === "color";

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

/** payload.layout of an admin config, validated loosely (unknown menu ids are dropped by the menu builder). */
export function layoutFromPayload(payload: unknown): { density: "compact" | "comfortable"; menu: Array<{ id: string; enabled: boolean }> } | null {
  if (!payload || typeof payload !== "object") return null;
  const lay = (payload as { layout?: unknown }).layout;
  if (!lay || typeof lay !== "object") return null;
  const l = lay as { density?: unknown; menu?: unknown };
  const density = l.density === "comfortable" ? "comfortable" : "compact";
  const menu = Array.isArray(l.menu)
    ? l.menu
        .filter((m): m is { id: string; enabled?: unknown } => !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string")
        .map((m) => ({ id: m.id, enabled: m.enabled !== false }))
    : [];
  return { density, menu };
}
