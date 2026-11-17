/**
 * Formatting of event facts (pure, tested in test/events.test.ts):
 *  - dates are the event's LOCAL dates (EventWhen.local_date) — formatted with Intl in UTC so the calendar day
 *    never shifts with the viewer's time zone; a start time is shown in the event's own time zone;
 *  - ticket prices are decimal strings from the provider ("120.00") — formatted without float arithmetic,
 *    with the provider's ISO currency code ("120 USD"), never converted.
 */
import type { EventMedia, EventWhen } from "@tilhero/contracts/bff";
import type { Lang } from "../i18n";

const LOCALE: Record<Lang, string> = { ru: "ru-RU", en: "en-GB" };

/** "2026-12-04" → Date at UTC midnight (null if malformed). */
export function parseLocalDate(d: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d ?? "");
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(dt.getTime()) || dt.getUTCDate() !== Number(m[3]) || dt.getUTCMonth() !== Number(m[2]) - 1 ? null : dt;
}

/** Canonical output regardless of the ICU version (Node/browsers differ: "4–6", "4 – 6", thin spaces):
 *  regular spaces, " – " between periods, but "4–6" for a day range inside one month. */
export const tidy = (s: string) =>
  s
    .replace(/\s?\u0433\./gu, "")
    .replace(/[\u2009\u202f\u00a0]/g, " ")
    .replace(/\s*[\u2013-]\s*/g, " \u2013 ")
    .replace(/^(\d{1,2}) \u2013 (\d{1,2})(?=\s)/, "$1\u2013$2")
    .replace(/\s{2,}/g, " ")
    .trim();

/** "4–6 дек. 2026" / "4–6 Dec 2026" / "30 дек. 2026 – 2 янв. 2027"; one day → "4 дек. 2026". */
export function formatEventDates(start: EventWhen, end: EventWhen | null, lang: Lang): string {
  const a = parseLocalDate(start.local_date);
  if (!a) return "";
  const f = new Intl.DateTimeFormat(LOCALE[lang], { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const b = end ? parseLocalDate(end.local_date) : null;
  if (!b || b.getTime() <= a.getTime()) return tidy(f.format(a));
  return tidy(f.formatRange(a, b));
}

/**
 * Start time in the EVENT's time zone: "17:00 GMT+4" when UTC instant and IANA zone are known,
 * otherwise the local wall time "17:00"; null when the source gave only a date.
 */
export function formatEventTime(w: EventWhen, lang: Lang): string | null {
  if (w.utc && w.timezone) {
    const d = new Date(w.utc);
    if (!Number.isNaN(d.getTime())) {
      try {
        return new Intl.DateTimeFormat(LOCALE[lang], { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: w.timezone, timeZoneName: "short" })
          .format(d)
          .replace(/\u202f/g, " ");
      } catch {
        /* unknown zone → wall time below */
      }
    }
  }
  const m = /^(\d{2}):(\d{2})/.exec(w.local_time ?? "");
  return m ? `${m[1]}:${m[2]}` : null;
}

/** Decimal-string money in the provider's currency (non-breaking spaces): "120.00","USD" → "120 USD"; "1250.5","EUR" → "1 250,50 EUR". */
export function formatMoney(amount: string, currency: string, lang: Lang): string {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec((amount ?? "").trim());
  if (!m || !/^[A-Z]{3}$/.test(currency)) return "";
  const whole = new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 0 }).format(Number(m[1])).replace(/[\u00a0\u202f\s]/g, "\u00a0");
  const cents = (m[2] ?? "").padEnd(2, "0");
  const num = cents === "00" ? whole : `${whole}${lang === "ru" ? "," : "."}${cents}`;
  return `${num}\u00a0${currency}`;
}

/** Host of an https URL without "www." ("https://www.ticketmaster.com/e/1" → "ticketmaster.com"). */
export function hostOf(url: string | null | undefined): string {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "https:" ? u.hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- sources (sprint 4: AI sources aiweb.<slug>)

/** AI-found event from an official site: provider "aiweb.<slug>" (INTERNAL_API sprint 4 §1). */
export const isAiwebProvider = (provider: string | null | undefined): boolean => /^aiweb\.[a-z0-9][a-z0-9-]{1,40}$/.test(provider ?? "");

/** Fixed display names of API providers (not the raw provider id). */
/** Sprint 5: travel suppliers of the trip block (aviasales, liteapi, osm). */
const PROVIDER_NAMES: Record<string, string> = { ticketmaster: "Ticketmaster", aviasales: "Aviasales", liteapi: "LiteAPI", osm: "OpenStreetMap" };

/**
 * How a source is shown to the user (INTERNAL_API §8):
 *  - aiweb.* → the domain of the event page without «www.» ("https://www.iticket.uz/…" → "iticket.uz"); without an
 *    https page — the registry name, else the slug;
 *  - ticketmaster → «Ticketmaster»;
 *  - any other provider → its name from the catalogue, else the raw provider id.
 */
export function sourceLabel(provider: string, url?: string | null, name?: string | null): string {
  if (isAiwebProvider(provider)) return hostOf(url) || (name ?? "").trim() || provider.slice("aiweb.".length);
  return PROVIDER_NAMES[provider] ?? ((name ?? "").trim() || provider);
}

/** Domain for the media provenance chip: the source page's host (no «www.»), else the source label. */
export function provenanceDomain(p: EventMedia["provenance"]): string {
  return hostOf(p.source_url) || sourceLabel(p.provider, null);
}

/** i18n key of the provenance chip: a photo from an official site («Фото: iticket.uz») or provider media («Медиа: …»). */
export const provenanceChipKey = (rights: EventMedia["provenance"]["rights"]): "media.site" | "media.src" => (rights === "official_site" ? "media.site" : "media.src");

/** Source line on the event detail: «name · domain», without repeating the name when it IS the domain. */
export function sourceLine(s: { provider: string; name: string | null; url: string }): string {
  const domain = hostOf(s.url);
  const title = isAiwebProvider(s.provider) ? (s.name ?? "").trim() || sourceLabel(s.provider, s.url) : sourceLabel(s.provider, s.url, s.name);
  if (!domain || title.toLowerCase() === domain.toLowerCase()) return title || domain;
  return `${title} · ${domain}`;
}

/**
 * Lifecycle basis line on the event detail (INTERNAL_API sprint 4 §6):
 *  - fact "staff_reviewed" → «Проверено оператором по данным {domain}» (the operator is never named);
 *  - fact "listed_on_official_site" → «Опубликовано на официальном сайте {domain}»;
 *  - anything else → «основание: {source label}» as before.
 * The domain is the https host of basis.source_url (no «www.»); without it the source label stands in.
 * Returns the i18n key and its {p}; an empty {p} means «TilHero» (a system transition).
 */
export type BasisKey = "dt.life.staff" | "dt.life.site" | "dt.life.basis";
export function lifecycleBasis(b: { fact: string; source_url: string | null; provider: string | null }): { key: BasisKey; p: string } {
  const label = b.provider ? sourceLabel(b.provider, b.source_url) : "";
  const domain = hostOf(b.source_url) || label;
  if (domain && b.fact === "staff_reviewed") return { key: "dt.life.staff", p: domain };
  if (domain && b.fact === "listed_on_official_site") return { key: "dt.life.site", p: domain };
  return { key: "dt.life.basis", p: label };
}

/** "18 мин назад" / "2 ч назад" / "вчера" via Intl.RelativeTimeFormat (no dictionary strings). */
export function relativeTime(iso: string, lang: Lang, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const rtf = new Intl.RelativeTimeFormat(LOCALE[lang], { numeric: "auto", style: "short" });
  const sec = Math.round((t - now) / 1000);
  const abs = Math.abs(sec);
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(sec / 3600), "hour");
  if (abs < 30 * 86_400) return rtf.format(Math.round(sec / 86_400), "day");
  return new Intl.DateTimeFormat(LOCALE[lang], { day: "numeric", month: "short", year: "numeric" }).format(new Date(t)).replace(/\s?\u0433\.$/u, "");
}

/** "07.10 18:42" in the viewer's zone — when the fact was fetched. */
export function formatFetched(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(LOCALE[lang], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(d)
    .replace(",", "");
}
