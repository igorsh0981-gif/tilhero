import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/en";
import { DICTS, normLang, pluralForm, resolveLang, translate } from "../src/i18n";
import { ru, type MessageKey } from "../src/i18n/ru";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const CYR = /[Ѐ-ӿ]/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}
const SRC = join(__dirname, "..", "src");
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("i18n dictionaries", () => {
  it("EN defines exactly the RU keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });

  it("has no empty strings and the same placeholders in both languages", () => {
    for (const k of Object.keys(ru) as MessageKey[]) {
      expect(ru[k].trim(), `ru ${k}`).not.toBe("");
      expect(en[k].trim(), `en ${k}`).not.toBe("");
      expect(placeholders(en[k]), `placeholders ${k}`).toEqual(placeholders(ru[k]));
    }
  });

  it("EN has no Cyrillic (switching to EN leaves no Russian in the UI)", () => {
    const bad = (Object.keys(en) as MessageKey[]).filter((k) => CYR.test(en[k]));
    expect(bad).toEqual([]);
  });

  it("plural entries have 3 RU forms and 2 EN forms", () => {
    for (const k of Object.keys(ru) as MessageKey[]) {
      if (!ru[k].includes("|")) continue;
      expect(ru[k].split("|"), k).toHaveLength(3);
      expect(en[k].split("|"), k).toHaveLength(2);
    }
  });

  it("every literal t('…') key used in the code exists", () => {
    const missing: string[] = [];
    for (const f of files(SRC)) {
      const code = stripComments(readFileSync(f, "utf8"));
      for (const m of code.matchAll(/\bt\("([a-zA-Z0-9_.]+)"/g)) if (!(m[1]! in ru)) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it("no interface text is hard-coded outside the dictionaries (Cyrillic only in src/i18n)", () => {
    const hits: string[] = [];
    for (const f of files(SRC)) {
      if (f.includes(`${join("src", "i18n")}`)) continue;
      stripComments(readFileSync(f, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          if (CYR.test(line)) hits.push(`${f}:${i + 1} ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

describe("language resolution and formatting", () => {
  it("profile locale → initData language_code → ru", () => {
    expect(resolveLang("en", "ru")).toBe("en");
    expect(resolveLang(null, "en-US")).toBe("en");
    expect(resolveLang(null, "uz")).toBe("ru");
    expect(resolveLang(null, "de")).toBe("ru");
    expect(resolveLang(undefined, undefined)).toBe("ru");
    expect(normLang("kk")).toBe("ru");
  });

  it("interpolates variables and keeps unknown ones visible", () => {
    expect(translate("ru", "ob.step", { n: 3 })).toBe("Шаг 3 из 6");
    expect(translate("en", "err.PIN_INVALID", { remaining: 2 })).toBe("Wrong PIN. Attempts left: 2");
    expect(translate("en", "sp.done.h")).toBe("Request {id} created");
  });

  it("chooses Russian plural forms", () => {
    const f = DICTS.ru["home.sum.new"];
    expect([1, 2, 5, 11, 21, 22, 25, 111].map((n) => pluralForm("ru", n, f))).toEqual([
      "новое событие",
      "новых события",
      "новых событий",
      "новых событий",
      "новое событие",
      "новых события",
      "новых событий",
      "новых событий",
    ]);
    expect(pluralForm("en", 1, DICTS.en["home.sum.new"])).toBe("new event");
    expect(pluralForm("en", 4, DICTS.en["home.sum.new"])).toBe("new events");
  });
});
