/**
 * Sprint 8 — anti-steering (owner decision В1, PLAN decision 3, AT-100): inside the Mini App digital goods are sold for
 * Telegram Stars only. Neither the code, nor the RU / UZ dictionaries, nor `public/`, nor the build (`dist/`) carry the
 * address of the payment site, links to it, the names of the other payment providers (Payme, Click, Uzum), prices in
 * sums / tiyins or words about «another way to pay» / «cheaper on the site».
 *
 * The build: `npm run build` first (CI — stream I). Without `dist/` the build part is skipped, unless
 * `ANTI_STEERING_REQUIRE_DIST=1` (CI) — then a missing build fails the test.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ru } from "../src/i18n/ru";
import { uz } from "../src/i18n/uz";

const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|css|html|json|svg|txt|md|webmanifest)$/;

/** What must never appear in the Mini App (any case; word-like boundaries so «PAYMENTS» or «onClick» do not count). */
export const STEERING: ReadonlyArray<[string, RegExp]> = [
  ["Payme", /(?<![a-z])(payme|paycom)(?![a-z])/i],
  ["Click (provider)", /\bClick\b|click\.uz|my\.click/],
  ["Uzum", /(?<![a-z])uzum(?![a-z])/i],
  ["sums / tiyins", /(?<![\p{L}\d_])сум(?!\p{L})|(?<![a-z])so[ʻ'’`]m(?![a-z])|\bUZS\b|tiyin|тийин|amount_tiyin|price_tiyin/iu],
  ["the payment site", /web-?pay|\/web\/v1|pay\.tilhero|WEB_PAY|contracts\/web\b/i],
  ["another way / cheaper", /другим способом|другой способ|дешевле|на сайте|сайт оплаты|оплат\p{L}* на сайте|boshqa usul|arzonroq|saytda|sayt orqali/iu],
];
/** In the dictionaries any «click» is forbidden (the texts never speak of clicking — «нажмите»). */
const DICT_EXTRA: [string, RegExp] = ["click (any)", /(?<![a-z])click(?![a-z])/i];

function filesOf(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesOf(p));
    else if (TEXT_EXT.test(name)) out.push(p);
  }
  return out;
}

function hits(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const [what, re] of STEERING) {
      const m = re.exec(text);
      if (m) out.push(`${relative(ROOT, f)}: ${what} «${text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, " ")}»`);
    }
  }
  return out;
}

describe("anti-steering: the Mini App knows no other way to pay", () => {
  it("dictionaries RU / UZ: no provider names, sums, the site, «другим способом / дешевле»", () => {
    const bad: string[] = [];
    for (const [lang, dict] of [["ru", ru], ["uz", uz]] as const) {
      for (const [key, value] of Object.entries(dict)) {
        for (const [what, re] of [...STEERING, DICT_EXTRA]) if (re.test(value)) bad.push(`${lang} ${key}: ${what} «${value}»`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the payment texts speak of Telegram Stars only", () => {
    const pay = Object.entries(ru).filter(([k]) => k.startsWith("bill.") || k.startsWith("err.") && /PAY|STARS|ORDER|PROVIDER|BILLING/.test(k));
    expect(pay.length).toBeGreaterThan(20);
    const values = pay.map(([, v]) => v).join("\n");
    expect(values).toMatch(/Telegram Stars/);
    expect(values).not.toMatch(/карт[аоу]|card|банк|bank/i);
  });

  it("source, index.html and public/: no address, link or name of another payment, no sums", () => {
    const files = [...filesOf(join(ROOT, "src")), ...filesOf(join(ROOT, "public")), join(ROOT, "index.html")];
    expect(files.length).toBeGreaterThan(100);
    expect(hits(files)).toEqual([]);
  });

  it("the only way to pay — Telegram.WebApp.openInvoice through src/tg/invoice.ts; no window.open / openLink of payments", () => {
    const src = filesOf(join(ROOT, "src")).filter((f) => !f.includes(`${join("src", "tg")}`));
    const invoiceCalls = src.filter((f) => /\.openInvoice\s*\(/.test(readFileSync(f, "utf8")));
    expect(invoiceCalls.map((f) => relative(ROOT, f))).toEqual([]);
    const tg = readFileSync(join(ROOT, "src", "tg", "invoice.ts"), "utf8");
    expect(tg).toMatch(/wa\.openInvoice!\(url, done\)/);
    expect(tg).toMatch(/\^https:\\\/\\\/t\\\.me\\\//);
  });

  const requireDist = process.env.ANTI_STEERING_REQUIRE_DIST === "1";
  it.skipIf(!requireDist && !existsSync(join(DIST, "index.html")))("the build dist/: none of it either", () => {
    expect(existsSync(join(DIST, "index.html")), "run `npm run build` first").toBe(true);
    const files = filesOf(DIST);
    expect(files.some((f) => f.endsWith(".js"))).toBe(true);
    expect(hits(files)).toEqual([]);
    // the build does contain the Stars payment (the guard above is not vacuous)
    expect(files.some((f) => f.endsWith(".js") && readFileSync(f, "utf8").includes("Telegram Stars"))).toBe(true);
  });
});
