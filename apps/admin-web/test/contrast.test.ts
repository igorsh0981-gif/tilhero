import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG 2.1 AA contrast of the TilHero admin palettes (theme.default.css), light and dark: text ≥ 4.5:1, field borders
 * and other non-text UI ≥ 3:1. Pairs = how components.css / layout.css combine the tokens.
 */
const CSS = readFileSync(resolve(__dirname, "../src/styles/theme.default.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector);
  const body = CSS.slice(CSS.indexOf("{", start) + 1, CSS.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const LIGHT = block(":root{");
const DARK = { ...LIGHT, ...block(':root[data-theme="dark"]{') };

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)) as [number, number, number];
}
function lum(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const NAV_INK = "#E6E9F5";
const TEXT_PAIRS: Array<[string, string]> = [
  ["--ink", "--bg"], ["--ink", "--card"], ["--ink", "--surface-2"], ["--ink", "--surface-sunk"],
  ["--ink2", "--bg"], ["--ink2", "--card"], ["--ink2", "--surface-2"], ["--ink2", "--surface-sunk"],
  ["--pen", "--card"], ["--pen", "--bg"], ["--pen", "--pen-soft"], ["--on-pen", "--pen"],
  ["--ok", "--ok-soft"], ["--ok", "--card"], ["--warn", "--warn-soft"], ["--warn", "--card"],
  ["--err", "--err-soft"], ["--err", "--card"], ["--card", "--err"], ["--note-ink", "--note-bg"],
  ["--side2", "--side"], ["--on-pen", "--pen"],
];

for (const [name, pal] of [["light", LIGHT], ["dark", DARK]] as const) {
  describe(`contrast · ${name}`, () => {
    it("text pairs ≥ 4.5:1", () => {
      const bad = TEXT_PAIRS.map(([f, b]) => [f, b, contrast(pal[f]!, pal[b]!)] as const).filter(([, , c]) => c < 4.5);
      expect(bad.map(([f, b, c]) => `${f} on ${b}: ${c.toFixed(2)}`)).toEqual([]);
    });
    it("sidebar text ≥ 4.5:1 and field borders ≥ 3:1", () => {
      expect(contrast(NAV_INK, pal["--side"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#FFFFFF", pal["--side"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(pal["--field-line"]!, pal["--card"]!)).toBeGreaterThanOrEqual(3);
      expect(contrast(pal["--pen"]!, pal["--card"]!)).toBeGreaterThanOrEqual(3); // focus ring
    });
  });
}

describe("contrast · Mini App previews (notebook palettes in screens.css)", () => {
  const S = readFileSync(resolve(__dirname, "../src/styles/screens.css"), "utf8");
  const pick = (sel: string) => {
    const start = S.indexOf(sel);
    const body = S.slice(S.indexOf("{", start) + 1, S.indexOf("}", start));
    return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  };
  for (const [name, p] of [["light", pick(":root{")], ["dark", { ...pick(":root{"), ...pick(".phone.is-dark{") }]] as const) {
    it(`${name}: sheet text ≥ 4.5:1`, () => {
      expect(contrast(p["--mx-ink"]!, p["--mx-paper"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p["--mx-ink2"]!, p["--mx-card"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p["--mx-pen"]!, p["--mx-pen-soft"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p["--mx-pen-ink"]!, p["--mx-pen"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p["--mx-err"]!, p["--mx-err-soft"]!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
