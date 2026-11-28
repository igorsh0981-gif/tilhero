/**
 * Деньги и даты сайта оплаты. Суммы приходят целыми тийинами (1 сум = 100 тийинов, ADR-0001) и выводятся
 * целочисленно — без float-деления и без Intl (разделители не зависят от локали браузера): «49 000 сум» /
 * «49 000 soʻm» (U+02BB). Пробелы — неразрывные (U+00A0): сумма не переносится по строкам.
 * Даты — Ташкент (UTC+5, без перехода на летнее время), названия месяцев — свои (RU/UZ латиница).
 */
import type { Lang } from "./i18n";

export const NBSP = " ";
/** UZ: oʻ, gʻ — U+02BB (MODIFIER LETTER TURNED COMMA), не апостроф и не кавычка. */
export const CURRENCY: Record<Lang, string> = { ru: "сум", uz: "soʻm" };

/** Группы по три цифры: "49000" → "49 000". */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** Тийины → «49 000 сум». Не целое или отрицательное значение — ошибка (суммы с сервера всегда целые). */
export function formatSum(tiyin: number, lang: Lang): string {
  if (!Number.isSafeInteger(tiyin) || tiyin < 0) throw new RangeError("amount must be a non-negative integer of tiyin");
  const kop = tiyin % 100;
  const sum = (tiyin - kop) / 100;
  const frac = kop === 0 ? "" : `,${String(kop).padStart(2, "0")}`;
  return `${group(String(sum))}${frac}${NBSP}${CURRENCY[lang]}`;
}

const MONTHS: Record<Lang, string[]> = {
  ru: ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"],
  uz: ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"],
};
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

function tashkent(iso: string): Date | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t + TASHKENT_OFFSET_MS);
}

/** «22 ноября 2026» / «22-noyabr 2026» (Ташкент). */
export function formatDate(iso: string | null | undefined, lang: Lang): string {
  const d = iso ? tashkent(iso) : null;
  if (!d) return "—";
  const day = d.getUTCDate();
  const month = MONTHS[lang][d.getUTCMonth()];
  return lang === "uz" ? `${day}-${month} ${d.getUTCFullYear()}` : `${day} ${month} ${d.getUTCFullYear()}`;
}

/** «22 ноября 2026, 14:05» (Ташкент). */
export function formatDateTime(iso: string | null | undefined, lang: Lang): string {
  const d = iso ? tashkent(iso) : null;
  if (!d) return "—";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatDate(iso, lang)}, ${hh}:${mm}`;
}
