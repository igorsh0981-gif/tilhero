/**
 * Sprint 6 — Watch and news without React (tested in test/watch.test.tsx): statuses of a watch, the «было → сейчас»
 * board, signed deltas (decimal strings, no float arithmetic on money), change rows of the history and of Home
 * «Что изменилось», the summary tiles, the news text sanitiser. Texts are built by the caller from i18n keys.
 */
import type { EventLifecycleStatus, NewsItem, Watch, WatchChange } from "@tilhero/contracts/bff";
import type { Lang } from "../i18n";
import { hostOf, sourceLabel } from "../events/format";

const LOCALE: Record<Lang, string> = { ru: "ru-RU", en: "en-GB" };
const MINUS = "−";
const NBSP = " ";

/* ---------------------------------------------------------------- money */

const DEC = /^([+-])?(\d{1,12})(?:\.(\d{1,2}))?$/;

/** "844.00" → "$844"; "1180.5" → "$1 180,50" (ru) / "$1,180.50" (en); malformed → "". Never parses money as float. */
export function usd(amount: string | null | undefined, lang: Lang): string {
  const m = DEC.exec((amount ?? "").trim());
  if (!m || m[1] === "-") return "";
  const whole = new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 0 }).format(Number(m[2])).replace(/[  \s]/g, NBSP);
  const cents = (m[3] ?? "").padEnd(2, "0");
  return `$${cents === "00" ? whole : `${whole}${lang === "ru" ? "," : "."}${cents}`}`;
}

/** Signed delta for a flap: price drops read «−$120», rises «+$40» (sign by the change type when the value has none). */
export function signedUsd(delta: string | null | undefined, lang: Lang, sign: -1 | 1 | 0 = 0): string {
  const m = DEC.exec((delta ?? "").trim());
  if (!m) return "";
  const s = m[1] === "-" ? -1 : m[1] === "+" ? 1 : sign || 1;
  const abs = usd(`${m[2]}${m[3] ? `.${m[3]}` : ""}`, lang);
  if (!abs || /^\$0(?:[.,]00)?$/.test(abs)) return abs;
  return `${s < 0 ? MINUS : "+"}${abs}`;
}

/** "−12 %" (NBSP before the sign of percent in RU typography, none in EN). */
export function signedPct(pct: string | null | undefined, lang: Lang, sign: -1 | 1 | 0 = 0): string {
  const m = /^([+-])?(\d{1,3})(?:\.(\d{1,2}))?$/.exec((pct ?? "").trim());
  if (!m) return "";
  const s = m[1] === "-" ? -1 : m[1] === "+" ? 1 : sign || 1;
  const n = m[3] && Number(m[3]) > 0 ? `${m[2]}${lang === "ru" ? "," : "."}${m[3].replace(/0$/, "")}` : m[2]!;
  return `${s < 0 ? MINUS : "+"}${n}${lang === "ru" ? `${NBSP}%` : "%"}`;
}

/* ---------------------------------------------------------------- watch status */

export type WatchTone = "good" | "warn" | "bad" | "info" | "lime" | undefined;
export type WatchBadge = {
  key: "w.b.live" | "w.b.paused" | "w.b.crit" | "w.b.low" | "w.b.ended" | "w.b.past" | "w.b.cancelled" | "w.b.removed" | "w.b.stopped" | "w.b.wait";
  tone: WatchTone;
  live?: boolean;
};

/**
 * Why a watch ended, as the UI says it. EVENT_REMOVED (the event was taken off the catalogue — not a cancellation, no
 * refund talk) and any reason this build does not know yet read neutrally.
 */
export function endedKey(reason: string | null | undefined): { badge: WatchBadge["key"]; note: "w.end.past" | "w.end.cancelled" | "w.end.removed" | "w.end.user" | "w.end.other" } {
  switch (reason) {
    case "EVENT_PAST":
      return { badge: "w.b.past", note: "w.end.past" };
    case "EVENT_CANCELLED":
      return { badge: "w.b.cancelled", note: "w.end.cancelled" };
    case "EVENT_REMOVED":
      return { badge: "w.b.removed", note: "w.end.removed" };
    case "USER":
      return { badge: "w.b.stopped", note: "w.end.user" };
    default:
      return { badge: "w.b.ended", note: "w.end.other" };
  }
}

const CRITICAL_LIFE: ReadonlySet<string> = new Set(["POSTPONED", "CANCELLED", "SOLD_OUT"]);

/** How long a cancellation stays «critical» after the watch ended with it (review M2). */
export const CANCELLED_CRITICAL_MS = 7 * 86_400_000;

/**
 * A watch needs attention: its last change is critical and the watch is not over — or the event was cancelled
 * (the watch ended with EVENT_CANCELLED) within the last 7 days: the user must learn about it even though the watch
 * itself is finished.
 */
export function isCritical(w: Pick<Watch, "status" | "last_change"> & Partial<Pick<Watch, "ended_reason" | "last_snapshot" | "created_at">>, now = Date.now()): boolean {
  if (w.status !== "ended") return w.last_change?.severity === "critical";
  if (w.ended_reason !== "EVENT_CANCELLED") return false;
  const at = Date.parse(w.last_change?.detected_at ?? w.last_snapshot?.taken_at ?? "");
  return Number.isFinite(at) && now - at <= CANCELLED_CRITICAL_MS;
}

export function watchBadge(w: Pick<Watch, "status" | "ended_reason" | "last_change" | "event" | "last_snapshot">): WatchBadge {
  if (w.status === "ended") {
    const k = endedKey(w.ended_reason).badge;
    return { key: k, tone: k === "w.b.cancelled" ? "bad" : undefined };
  }
  if (w.status === "paused") return { key: "w.b.paused", tone: undefined };
  if (w.last_change?.severity === "critical") return { key: "w.b.crit", tone: "bad" };
  const life = w.event?.lifecycle.status ?? w.last_snapshot?.lifecycle_status;
  if (life === "LOW_INVENTORY") return { key: "w.b.low", tone: "warn" };
  if (!w.last_snapshot) return { key: "w.b.wait", tone: "info" };
  return { key: "w.b.live", tone: "good", live: true };
}

/** Header numbers of the Watch tab: active watches, critical changes, the nearest check. */
export function watchStats(list: readonly Watch[], now = Date.now()): { active: number; critical: number; nextCheckAt: string | null } {
  let next: string | null = null;
  for (const w of list) {
    if (w.status !== "active" || !w.next_check_at || Number.isNaN(Date.parse(w.next_check_at))) continue;
    if (!next || Date.parse(w.next_check_at) < Date.parse(next)) next = w.next_check_at;
  }
  return { active: list.filter((w) => w.status === "active").length, critical: list.filter((w) => isCritical(w, now)).length, nextCheckAt: next };
}

const RANK = (w: Watch, now: number) => (isCritical(w, now) ? 0 : w.status === "active" ? 1 : w.status === "paused" ? 2 : 3);
const lastAt = (w: Watch) => Date.parse(w.last_change?.detected_at ?? w.created_at) || 0;

/** Critical first, then active, paused, ended; inside — the freshest change first. */
export function sortWatches(list: readonly Watch[], now = Date.now()): Watch[] {
  return [...list].sort((a, b) => RANK(a, now) - RANK(b, now) || lastAt(b) - lastAt(a) || a.watch_id.localeCompare(b.watch_id));
}

/** Key of a critical change for the tab bar badge: the watch and the change (a new change → a new key). */
export function criticalKey(watchId: string, change: Pick<WatchChange, "change_id" | "detected_at"> | null | undefined, fallback = ""): string {
  return `${watchId}:${change ? change.change_id || change.detected_at : fallback}`;
}

/** Keys of the critical watches of the Watch tab. */
export function criticalKeysOfWatches(list: readonly Watch[], now = Date.now()): string[] {
  return list.filter((w) => isCritical(w, now)).map((w) => criticalKey(w.watch_id, w.last_change, w.ended_reason ?? "critical"));
}

/**
 * Keys of the critical rows of Home «Что изменилось» (HomeWatchChange): a critical change of a live watch, or a
 * cancellation of an ended one within 7 days — the same rule as isCritical.
 */
export function criticalKeysOfRows(rows: readonly ChangeRow[], now = Date.now()): string[] {
  return rows
    .filter((r) => {
      if (!r.watch_id || r.change.severity !== "critical") return false;
      if (r.status !== "ended") return true;
      const at = Date.parse(r.change.detected_at);
      return r.change.after === "CANCELLED" && Number.isFinite(at) && now - at <= CANCELLED_CRITICAL_MS;
    })
    .map((r) => criticalKey(r.watch_id!, r.change));
}

/** Next page of GET /v1/watches appended to the loaded ones (a watch already shown is not repeated). */
export function mergeWatches(a: readonly Watch[], b: readonly Watch[]): Watch[] {
  const seen = new Set(a.map((w) => w.watch_id));
  return [...a, ...b.filter((w) => !seen.has(w.watch_id))];
}

/** «через 3 ч» / «in 3 h» until the next check; past or unknown → "". */
export function untilLabel(iso: string | null, now = Date.now()): { n: number; unit: "min" | "h" | "d" } | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return null;
  const min = Math.max(1, Math.round(ms / 60_000));
  if (ms <= 0) return { n: 1, unit: "min" };
  if (min < 60) return { n: min, unit: "min" };
  const h = Math.round(min / 60);
  if (h < 48) return { n: h, unit: "h" };
  return { n: Math.round(h / 24), unit: "d" };
}

/* ---------------------------------------------------------------- changes */

const isPrice = (c: Pick<WatchChange, "type">) => c.type === "price_drop" || c.type === "price_rise" || c.type === "flight" || c.type === "hotel";
const isStatus = (v: string | null | undefined): v is EventLifecycleStatus => !!v && /^[A-Z_]{3,20}$/.test(v);

/** Sign of a change: drop → −1, rise → +1, a flight / hotel by the value's sign or before/after. */
export function changeSign(c: Pick<WatchChange, "type" | "delta_usd" | "before" | "after">): -1 | 1 | 0 {
  if (c.type === "price_drop") return -1;
  if (c.type === "price_rise") return 1;
  const m = DEC.exec((c.delta_usd ?? "").trim());
  if (m?.[1] === "-") return -1;
  if (m?.[1] === "+") return 1;
  const b = DEC.exec(c.before ?? "");
  const a = DEC.exec(c.after ?? "");
  if (a && b) {
    const cents = (x: RegExpExecArray) => BigInt(x[2]!) * 100n + BigInt((x[3] ?? "").padEnd(2, "0") || "0");
    const d = cents(a) - cents(b);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  return 0;
}

export type FlapTone = "good" | "bad" | "warn" | "lime" | "info";

/** Split-flap of a change: a signed delta for prices, a short status for lifecycle / tickets. */
export function changeFlap(c: WatchChange, lang: Lang): { text: string; key: string | null; tone: FlapTone } {
  if (isPrice(c)) {
    const sign = changeSign(c);
    const text = signedUsd(c.delta_usd, lang, sign) || signedPct(c.delta_pct, lang, sign);
    return { text, key: text ? null : "flap.chg", tone: sign < 0 ? "good" : sign > 0 ? "bad" : "info" };
  }
  const after = c.after ?? "";
  const tone: FlapTone = c.severity === "critical" || CRITICAL_LIFE.has(after) ? "bad" : after === "ON_SALE" || after === "RESALE" ? "lime" : after === "LOW_INVENTORY" ? "warn" : "info";
  return { text: "", key: isStatus(after) ? `flap.life.${after}` : "flap.chg", tone };
}

/** i18n key + vars of the change line (history rows, Home board). */
export function changeLine(c: WatchChange, lang: Lang): { key: string; vars: Record<string, string> } {
  const before = usd(c.before, lang);
  const after = usd(c.after, lang);
  switch (c.type) {
    case "price_drop":
      return before && after ? { key: "w.c.drop", vars: { from: before, to: after } } : { key: "w.c.dropShort", vars: {} };
    case "price_rise":
      return before && after ? { key: "w.c.rise", vars: { from: before, to: after } } : { key: "w.c.riseShort", vars: {} };
    case "flight":
      return before && after ? { key: "w.c.flight", vars: { from: before, to: after } } : { key: "w.c.flightShort", vars: {} };
    case "hotel":
      return before && after ? { key: "w.c.hotel", vars: { from: before, to: after } } : { key: "w.c.hotelShort", vars: {} };
    case "tickets":
    case "lifecycle": {
      const st = isStatus(c.after) ? c.after : null;
      return st ? { key: c.type === "tickets" ? "w.c.tickets" : "w.c.life", vars: { s: st } } : { key: "w.c.lifeShort", vars: {} };
    }
    default:
      return { key: "w.c.other", vars: {} };
  }
}

/** Source of a change for the history: the domain of its page, else the provider's display name. */
export function changeSource(c: Pick<WatchChange, "source">): string {
  return hostOf(c.source.url) || sourceLabel(c.source.provider, c.source.url) || c.source.provider;
}

/** Board time: «18:42» today, «вчера» yesterday, «07.10» earlier (viewer's zone). */
export function boardTime(iso: string, lang: Lang, now = Date.now()): { kind: "time" | "yday" | "date"; text: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { kind: "date", text: "" };
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const today = new Date(now);
  const yday = new Date(now - 86_400_000);
  if (day(d) === day(today)) return { kind: "time", text: new Intl.DateTimeFormat(LOCALE[lang], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d) };
  if (day(d) === day(yday)) return { kind: "yday", text: "" };
  return { kind: "date", text: new Intl.DateTimeFormat(LOCALE[lang], { day: "2-digit", month: "2-digit" }).format(d) };
}

/** Duplicates suppressed by the watch service (notified: "suppressed") in the loaded history. */
export const suppressedCount = (changes: readonly WatchChange[]): number => changes.filter((c) => c.notified === "suppressed").length;

/* ---------------------------------------------------------------- Home sections (sprint 6) */

export interface ChangeRow {
  watch_id: string | null;
  event_id: string;
  event_title: string;
  /** status of the watch (HomeWatchChange.status); null — unknown */
  status: Watch["status"] | null;
  change: WatchChange;
}

const isChange = (x: unknown): x is WatchChange =>
  !!x && typeof x === "object" && typeof (x as WatchChange).change_id === "string" && typeof (x as WatchChange).type === "string" && typeof (x as WatchChange).detected_at === "string";
const STATUSES = new Set(["active", "paused", "ended"]);

/**
 * Items of the `watch_changes` section. The BFF sends HomeWatchChange `{watch_id, event_id, event_title, status, change}`;
 * Watch objects with `last_change` (GET /v1/watches) and flat changes with their event are accepted too. Anything else
 * is dropped; newest first.
 */
export function normalizeChangeRows(items: readonly unknown[]): ChangeRow[] {
  const out: ChangeRow[] = [];
  for (const x of items) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const title = typeof o.event_title === "string" ? o.event_title : "";
    const eventId = typeof o.event_id === "string" ? o.event_id : "";
    if (!eventId || !title) continue;
    const change = isChange(o.change) ? o.change : isChange(o.last_change) ? o.last_change : isChange(o) ? (o as unknown as WatchChange) : null;
    if (!change) continue;
    const status = typeof o.status === "string" && STATUSES.has(o.status) ? (o.status as Watch["status"]) : null;
    out.push({ watch_id: typeof o.watch_id === "string" ? o.watch_id : null, event_id: eventId, event_title: title, status, change });
  }
  return out.sort((a, b) => (Date.parse(b.change.detected_at) || 0) - (Date.parse(a.change.detected_at) || 0));
}

/* ---------------------------------------------------------------- news */

/** Feed texts are untrusted: tags and entities are shown as plain text, never as HTML (PLAN «Правила»). */
export function plainText(s: string | null | undefined, max = 600): string {
  const noTags = (s ?? "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, " ");
  const decoded = noTags.replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (_m, e: string) => ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" })[e] ?? " ");
  const flat = decoded.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** A news item is shown only with an https source (AT-33): the link opens the item's own URL. */
export function newsSourceUrl(n: Pick<NewsItem, "source">): string | null {
  return /^https:\/\//i.test(n.source?.url ?? "") && hostOf(n.source.url) ? n.source.url : null;
}

export function newsDomain(n: Pick<NewsItem, "source">): string {
  return (n.source?.domain ?? "").replace(/^www\./, "").trim() || hostOf(n.source?.url) || (n.source?.name ?? "");
}

const isNews = (x: unknown): x is NewsItem => {
  const n = x as NewsItem;
  return !!n && typeof n === "object" && typeof n.news_id === "string" && typeof n.title === "string" && !!n.source && typeof n.source.url === "string";
};

const ymdLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ISO_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

/**
 * Fix 6.1 (a guard — news hides outdated items itself; this covers a cached Home copy): a fallback for news before 6.1
 * that has no `event_ends_at` — the date in the text of an «event update» (news renders «(2026-12-04, Abu Dhabi)»).
 * The latest date found counts.
 */
export function newsEventDate(n: NewsItem): string | null {
  if (n.kind !== "event_update") return null;
  let last: string | null = null;
  for (const m of `${n.title} ${n.summary ?? ""}`.matchAll(ISO_DAY)) {
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    if (Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31 && (!last || d > last)) last = d;
  }
  return last;
}

/** The news item is about an event that is over — the card is not shown. `event_ends_at` (news 6.1, the moment the
 *  event is past by rule 5.1 or was cancelled) decides; a news item without the field — the date in its text. */
export function isPastEventNews(n: NewsItem, now = new Date()): boolean {
  if (n.event_ends_at !== undefined) {
    const t = n.event_ends_at === null ? NaN : Date.parse(n.event_ends_at);
    if (!Number.isNaN(t)) return t <= now.getTime();
    if (n.event_ends_at === null) return false; // news knows the item is not about a dated event
  }
  const d = newsEventDate(n);
  return d !== null && d < ymdLocal(now);
}

/** Items of `news_carousel` / GET /v1/news that can be shown: valid shape, an https source, not about a past event. */
export const showableNews = (items: readonly unknown[], now = new Date()): NewsItem[] =>
  items.filter(isNews).filter((n) => newsSourceUrl(n) !== null && !isPastEventNews(n, now));
