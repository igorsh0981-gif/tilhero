import type { UiLang } from "@tilhero/contracts/bff";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ru, type MessageKey } from "./ru";
import { uz } from "./uz";

/**
 * Interface languages RU and UZ (Latin script). Every text goes through these dictionaries; the two are never mixed
 * on one screen (test/i18n.test.ts checks parity and the absence of Cyrillic in UZ). The interface language never
 * changes the course (ru → en, AT-05).
 */
export type Lang = UiLang;
export type { MessageKey };
export type Vars = Record<string, string | number>;

export const DICTS: Record<Lang, Record<MessageKey, string>> = { ru, uz };

/** Telegram language_code / profile locale → supported UI language; Russian for everything else. */
export function normLang(code: string | null | undefined): Lang | null {
  if (!code) return null;
  const c = String(code).trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (c === "uz") return "uz";
  if (c === "ru") return "ru";
  return null;
}

/** Language priority: profile locale → initData language_code → ru. */
export function resolveLang(profileLocale: string | null | undefined, telegramCode: string | null | undefined): Lang {
  return normLang(profileLocale) ?? normLang(telegramCode) ?? "ru";
}

export function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (vars[name] == null ? m : String(vars[name])));
}

export function translate(lang: Lang, key: MessageKey, vars?: Vars): string {
  const s = DICTS[lang][key] ?? DICTS.ru[key] ?? key;
  return interpolate(s, vars);
}

/** Plural form from "one|few|many" (ru). Uzbek nouns do not change after numerals: the first form is used. */
export function pluralForm(lang: Lang, n: number, forms: string): string {
  const f = forms.split("|");
  if (lang !== "ru") return f[0] ?? forms;
  const abs = Math.abs(n);
  const a = abs % 10;
  const b = abs % 100;
  const i = a === 1 && b !== 11 ? 0 : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? 1 : 2;
  return f[Math.min(i, f.length - 1)] ?? forms;
}

const MONTHS: Record<Lang, string[]> = {
  ru: ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"],
  uz: ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"],
};

export interface Formatters {
  /** "18 ноября" / "18-noyabr" (local time of the device) */
  date(iso: string): string;
  /** "18 ноября, 19:05" / "18-noyabr, 19:05" */
  dateTime(iso: string): string;
  /** a plan date "YYYY-MM-DD" (no time zone conversion) */
  localDate(ymd: string): string;
  mmss(seconds: number): string;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

export function makeFormatters(lang: Lang): Formatters {
  const dm = (day: number, month: number) => (lang === "ru" ? `${day} ${MONTHS.ru[month]}` : `${day}-${MONTHS.uz[month]}`);
  const parse = (iso: string): Date | null => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  return {
    date: (iso) => {
      const d = parse(iso);
      return d ? dm(d.getDate(), d.getMonth()) : "";
    },
    dateTime: (iso) => {
      const d = parse(iso);
      return d ? `${dm(d.getDate(), d.getMonth())}, ${two(d.getHours())}:${two(d.getMinutes())}` : "";
    },
    localDate: (ymd) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
      if (!m) return "";
      const month = Number(m[2]) - 1;
      return month >= 0 && month < 12 ? dm(Number(m[3]), month) : "";
    },
    mmss: (sec) => {
      const s = Math.max(0, Math.ceil(sec));
      return `${two(Math.floor(s / 60))}:${two(s % 60)}`;
    },
  };
}

export interface I18n {
  lang: Lang;
  setLang(l: Lang): void;
  t(key: MessageKey, vars?: Vars): string;
  /** plural word for n (without the number) */
  tp(key: MessageKey, n: number): string;
  /** label in the current language from a {ru, uz} object (directory data from the BFF) */
  l(label: { ru: string; uz: string } | null | undefined): string;
  fmt: Formatters;
}

const Ctx = createContext<I18n | null>(null);

export function makeI18n(lang: Lang, setLang: (l: Lang) => void = () => undefined): I18n {
  return {
    lang,
    setLang,
    t: (key, vars) => translate(lang, key, vars),
    tp: (key, n) => pluralForm(lang, n, translate(lang, key)),
    l: (label) => (label ? label[lang] || label.ru || "" : ""),
    fmt: makeFormatters(lang),
  };
}

export function I18nProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    document.documentElement.lang = l;
  }, []);
  const value = useMemo<I18n>(() => {
    document.documentElement.lang = lang;
    return makeI18n(lang, setLang);
  }, [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}
