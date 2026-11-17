import { describe, expect, it } from "vitest";
import { KNOWN_CODES } from "../src/api/errors";
import { makeFormatters, normLang, pluralForm, resolveLang, translate } from "../src/i18n";
import { ru } from "../src/i18n/ru";
import { uz } from "../src/i18n/uz";

const CYRILLIC = /[Ѐ-ӿ]/;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("dictionaries RU / UZ", () => {
  it("have exactly the same keys", () => {
    expect(Object.keys(uz).sort()).toEqual(Object.keys(ru).sort());
  });
  it("Uzbek is Latin only (no mixing of scripts) and never empty", () => {
    for (const [k, v] of Object.entries(uz)) {
      expect(CYRILLIC.test(v), `${k}: ${v}`).toBe(false);
      expect(v.trim().length, k).toBeGreaterThan(0);
    }
  });
  it("Uzbek uses the modifier letter ʻ for oʻ / gʻ, not ASCII quotes", () => {
    for (const [k, v] of Object.entries(uz)) expect(/[oOgG]['‘’`]/.test(v), `${k}: ${v}`).toBe(false);
  });
  it("the same placeholders in both languages", () => {
    for (const k of Object.keys(ru) as Array<keyof typeof ru>) expect(placeholders(uz[k]), k).toEqual(placeholders(ru[k]));
  });
  it("every known error code has a text", () => {
    for (const c of KNOWN_CODES) expect(ru[`err.${c}` as keyof typeof ru], c).toBeTruthy();
  });
  it("the deletion confirmation words of the contract", () => {
    expect(translate("ru", "del.word")).toBe("УДАЛИТЬ");
    expect(translate("uz", "del.word")).toBe("OʻCHIRISH");
  });
});

describe("language helpers", () => {
  it("Telegram language_code → ru | uz, Russian by default", () => {
    expect(normLang("uz-UZ")).toBe("uz");
    expect(normLang("ru")).toBe("ru");
    expect(normLang("en")).toBeNull();
    expect(resolveLang(null, "uz")).toBe("uz");
    expect(resolveLang("ru", "uz")).toBe("ru");
    expect(resolveLang(null, "de")).toBe("ru");
  });
  it("Russian plurals; Uzbek nouns do not change after numerals", () => {
    expect(pluralForm("ru", 1, "день|дня|дней")).toBe("день");
    expect(pluralForm("ru", 3, "день|дня|дней")).toBe("дня");
    expect(pluralForm("ru", 11, "день|дня|дней")).toBe("дней");
    expect(pluralForm("ru", 21, "день|дня|дней")).toBe("день");
    expect(pluralForm("uz", 5, "kun")).toBe("kun");
  });
  it("dates: «18 ноября» / «18-noyabr»", () => {
    expect(makeFormatters("ru").localDate("2026-11-18")).toBe("18 ноября");
    expect(makeFormatters("uz").localDate("2026-11-18")).toBe("18-noyabr");
    expect(makeFormatters("ru").localDate("bad")).toBe("");
    expect(makeFormatters("ru").mmss(65)).toBe("01:05");
  });
});
