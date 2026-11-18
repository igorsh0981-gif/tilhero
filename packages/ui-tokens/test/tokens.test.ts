import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const styles = join(root, "styles");
const read = (p: string): string => readFileSync(join(styles, p), "utf8");
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const TOKEN_FILES = ["tokens.css", ...readdirSync(join(styles, "themes")).map((f) => `themes/${f}`)];
const LAYER_FILES = ["base.css", "layout.css", "components.css", "telegram.css"];
/** Variables written at runtime by the Telegram bridge / app shell, not by CSS. */
const RUNTIME_VARS = /^--(tg-|toast-b$)/;

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(|\b(?:white|black|red|blue|green|yellow|orange|purple|gray|grey)\b(?![-\w])/;

const names = JSON.parse(readFileSync(join(root, "token-names.json"), "utf8")) as { fonts: string[]; tokens: Record<string, string> };

function definedVars(): Set<string> {
  const out = new Set<string>();
  for (const f of [...TOKEN_FILES, ...LAYER_FILES]) {
    for (const m of stripComments(read(f)).matchAll(/(--[a-z0-9-]+)\s*:/gi)) out.add(m[1]!);
  }
  return out;
}

/** custom properties declared inside the first rule block that matches `selector` */
function block(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return "";
  const open = css.indexOf("{", i);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("ui-tokens", () => {
  it("has no colour literals outside tokens.css and themes/*", () => {
    for (const f of LAYER_FILES) {
      const lines = stripComments(read(f)).split("\n");
      lines.forEach((line, i) => {
        const probe = line.replace(/--[a-z0-9-]+/gi, "");
        expect(COLOR_LITERAL.test(probe), `${f}:${i + 1} → ${line.trim()}`).toBe(false);
      });
    }
  });

  it("references only defined custom properties", () => {
    const defined = definedVars();
    for (const f of [...TOKEN_FILES, ...LAYER_FILES]) {
      for (const m of stripComments(read(f)).matchAll(/var\((--[a-z0-9-]+)/gi)) {
        const name = m[1]!;
        if (RUNTIME_VARS.test(name)) continue;
        expect(defined.has(name), `${f}: var(${name}) is not defined`).toBe(true);
      }
    }
  });

  it("declares cascade layers in the documented order and imports every layer", () => {
    const index = read("index.css");
    expect(index).toMatch(/@layer tokens, themes, base, components, layout, telegram;/);
    for (const f of [...TOKEN_FILES, ...LAYER_FILES]) expect(index).toContain(`@import "./${f}"`);
  });

  it("defines every allow-listed token in the light notebook theme or tokens.css", () => {
    const base = stripComments(read("tokens.css") + read("themes/notebook.css"));
    for (const [name, kind] of Object.entries(names.tokens)) {
      expect(["color", "length", "font"]).toContain(kind);
      expect(base.includes(`${name}:`), `${name} missing from tokens/notebook theme`).toBe(true);
    }
  });

  it("gives the dark notebook every colour token of the light one", () => {
    const light = block(stripComments(read("themes/notebook.css")), ":root");
    const dark = block(stripComments(read("themes/notebook-dark.css")), ':root[data-scheme="dark"]');
    expect(read("themes/notebook-dark.css")).toContain(':root[data-theme="notebook_dark"]');
    for (const [name, kind] of Object.entries(names.tokens)) {
      if (kind !== "color") continue;
      expect(light.includes(`${name}:`), `${name} in light`).toBe(true);
      expect(dark.includes(`${name}:`), `${name} in dark`).toBe(true);
    }
  });

  it("uses the brand fonts from token-names.json", () => {
    const tokens = read("tokens.css");
    for (const f of names.fonts) expect(tokens).toContain(`"${f}"`);
  });
});
