import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { en } from "./en";
import { ru, type MessageKey } from "./ru";

export type Lang = "ru" | "en";
export type { MessageKey };
export type Vars = Record<string, string | number>;

export const DICTS: Record<Lang, Record<MessageKey, string>> = { ru, en };

export function normLang(code: string | null | undefined): Lang | null {
  if (!code) return null;
  const c = String(code).trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (c === "en") return "en";
  if (c === "ru") return "ru";
  return null;
}

export function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (vars[name] == null ? m : String(vars[name])));
}

export function translate(lang: Lang, key: MessageKey, vars?: Vars): string {
  const s = DICTS[lang][key] ?? DICTS.ru[key] ?? key;
  return interpolate(s, vars);
}

/** Plural form from a "one|few|many" (ru) or "one|other" (en) entry; {n} is substituted. */
export function pluralForm(lang: Lang, n: number, forms: string): string {
  const f = forms.split("|");
  const abs = Math.abs(n);
  let i: number;
  if (lang === "ru") {
    const a = abs % 10;
    const b = abs % 100;
    i = a === 1 && b !== 11 ? 0 : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? 1 : 2;
  } else i = abs === 1 ? 0 : 1;
  return (f[Math.min(i, f.length - 1)] ?? forms).replace(/\{n\}/g, String(n));
}

/** SLA / countdown: 05:41, 1:05:18, −04:41 (negative = overdue). */
export function fmtCountdown(ms: number): string {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p2 = (x: number) => String(x).padStart(2, "0");
  return (neg ? "−" : "") + (h ? `${h}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`);
}

export interface Formatters {
  locale: string;
  num(n: number, digits?: number): string;
  pct(n: number, digits?: number): string;
  date(iso: string | null | undefined): string;
  dateTime(iso: string | null | undefined): string;
  dateTimeS(iso: string | null | undefined): string;
  time(iso: string | null | undefined): string;
  rel(iso: string | null | undefined, now?: number): string;
  minutes(min: number | null | undefined): string;
}

export function makeFormatters(lang: Lang): Formatters {
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const nfs = new Map<number, Intl.NumberFormat>();
  const nf = (d: number) => {
    let f = nfs.get(d);
    if (!f) nfs.set(d, (f = new Intl.NumberFormat(locale, { maximumFractionDigits: d, minimumFractionDigits: d })));
    return f;
  };
  const pf = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const df = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
  const dtf = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const dtsf = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const tf = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const safe = (f: Intl.DateTimeFormat, iso: string | null | undefined) => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : f.format(d).replace(",", "");
  };
  return {
    locale,
    num: (n, d = 0) => nf(d).format(n),
    pct: (n, d = 1) => (d === 1 ? pf : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: d })).format(n / 100),
    date: (iso) => safe(df, iso),
    dateTime: (iso) => safe(dtf, iso),
    dateTimeS: (iso) => safe(dtsf, iso),
    time: (iso) => safe(tf, iso),
    rel: (iso, now = Date.now()) => {
      if (!iso) return "";
      const ts = new Date(iso).getTime();
      if (Number.isNaN(ts)) return "";
      const diff = now - ts;
      const a = Math.abs(diff);
      if (a < 60_000) return rtf.format(0, "minute");
      if (a < 3_600_000) return rtf.format(-Math.round(diff / 60_000), "minute");
      if (a < 86_400_000) return rtf.format(-Math.round(diff / 3_600_000), "hour");
      if (a < 30 * 86_400_000) return rtf.format(-Math.round(diff / 86_400_000), "day");
      return safe(df, iso);
    },
    minutes: (min) => {
      if (min == null) return "—";
      const m = Math.round(min);
      const h = Math.floor(m / 60);
      return h ? translate(lang, "fmt.hm", { h, m: m % 60 }) : translate(lang, "fmt.m", { m });
    },
  };
}

export interface I18n {
  lang: Lang;
  setLang(l: Lang): void;
  t(key: MessageKey, vars?: Vars): string;
  /** plural phrase for n ({n} substituted) */
  tp(key: MessageKey, n: number): string;
  /** label in the current language from a {ru, en} object */
  l(label: { ru: string; en: string } | null | undefined): string;
  fmt: Formatters;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ initial, onChange, children }: { initial: Lang; onChange?: (l: Lang) => void; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial);
  const setLang = useCallback(
    (l: Lang) => {
      setLangState(l);
      document.documentElement.lang = l;
      onChange?.(l);
    },
    [onChange],
  );
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
