import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { en } from "./en";
import { ru, type MessageKey } from "./ru";

export type Lang = "ru" | "en";
export type { MessageKey };
export type Vars = Record<string, string | number>;

export const DICTS: Record<Lang, Record<MessageKey, string>> = { ru, en };

/** Telegram language_code → supported UI language (same mapping as the bot gateway for CIS locales). */
export function normLang(code: string | null | undefined): Lang | null {
  if (!code) return null;
  const c = String(code).trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (c === "en") return "en";
  if (["ru", "uz", "kk", "ky", "tg", "be", "uk"].includes(c)) return "ru";
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

/** Plural form from a "one|few|many" (ru) or "one|other" (en) entry. */
export function pluralForm(lang: Lang, n: number, forms: string): string {
  const f = forms.split("|");
  const abs = Math.abs(n);
  if (lang === "ru") {
    const a = abs % 10;
    const b = abs % 100;
    const i = a === 1 && b !== 11 ? 0 : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? 1 : 2;
    return f[Math.min(i, f.length - 1)] ?? forms;
  }
  return (abs === 1 ? f[0] : f[1] ?? f[0]) ?? forms;
}

export interface Formatters {
  locale: string;
  num(n: number): string;
  usd(n: number): string;
  /** decimal-string money from the contract ("850.00", ≤ 2 decimals) → "$850" / "$850.50"; "" if malformed */
  usdDecimal(amount: string): string;
  date(iso: string): string;
  dateTime(iso: string): string;
  time(iso: string): string;
  mmss(seconds: number): string;
}

export function makeFormatters(lang: Lang): Formatters {
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const df = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
  const dtf = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const tf = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  const safe = (f: Intl.DateTimeFormat, iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : f.format(d).replace(",", "");
  };
  return {
    locale,
    num: (n) => nf.format(n),
    usd: (n) => `$${nf.format(Math.round(n))}`,
    usdDecimal: (amount) => {
      // no float arithmetic: integer part and cents are formatted separately
      const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(typeof amount === "string" ? amount.trim() : "");
      if (!m) return "";
      const cents = (m[2] ?? "").padEnd(2, "0");
      const whole = `$${nf.format(Number(m[1]))}`;
      return cents === "00" ? whole : `${whole}${lang === "ru" ? "," : "."}${cents}`;
    },
    date: (iso) => safe(df, iso),
    dateTime: (iso) => safe(dtf, iso),
    time: (iso) => safe(tf, iso),
    mmss: (sec) => {
      const s = Math.max(0, Math.ceil(sec));
      return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    },
  };
}

export interface I18n {
  lang: Lang;
  setLang(l: Lang): void;
  t(key: MessageKey, vars?: Vars): string;
  /** plural word for n (without the number) */
  tp(key: MessageKey, n: number): string;
  /** label in the current language from a {ru, en} object (directory data from the BFF) */
  l(label: { ru: string; en: string } | null | undefined): string;
  fmt: Formatters;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    document.documentElement.lang = l;
  }, []);
  const value = useMemo<I18n>(() => {
    document.documentElement.lang = lang;
    return {
      lang,
      setLang,
      t: (key, vars) => translate(lang, key, vars),
      tp: (key, n) => pluralForm(lang, n, translate(lang, key)),
      l: (label) => (label ? label[lang] || label.ru || label.en || "" : ""),
      fmt: makeFormatters(lang),
    };
  }, [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}
