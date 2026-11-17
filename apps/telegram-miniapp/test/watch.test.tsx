import type { EventCard, NewsItem, Recommendation, SessionResponse, Watch, WatchChange } from "@tilhero/contracts/bff";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api/client";
import { createApi, type Api } from "../src/api/endpoints";
import { ApiError, errorText } from "../src/api/errors";
import { clampScore, displayReasons, reasonText, type ReasonDeps } from "../src/events/why";
import { I18nProvider, translate, type Lang } from "../src/i18n";
import { NewsCard } from "../src/screens/news/News";
import { NotInterested, useReaction, WhyBlock } from "../src/screens/events/Why";
import { WatchSheet } from "../src/screens/watch/WatchSheet";
import { AppContext, type AppCtx } from "../src/state/app";
import { resetDirectoryCache } from "../src/state/directory";
import { parseStartParam } from "../src/tg";
import { EventCardView } from "../src/ui/EventCard";
import { QuickChip } from "../src/ui/QuickChip";
import { ToastHost } from "../src/ui/overlays";
import {
  boardTime,
  changeFlap,
  changeLine,
  changeSign,
  criticalKeysOfRows,
  criticalKeysOfWatches,
  endedKey,
  isCritical,
  isPastEventNews,
  mergeWatches,
  newsEventDate,
  newsSourceUrl,
  normalizeChangeRows,
  plainText,
  showableNews,
  signedPct,
  signedUsd,
  sortWatches,
  suppressedCount,
  untilLabel,
  usd,
  watchBadge,
  watchStats,
} from "../src/watch/logic";
import { watchStore } from "../src/watch/store";

const NB = " ";
const MINUS = "−";
afterEach(cleanup);
beforeEach(() => {
  watchStore.reset();
  resetDirectoryCache();
});

const change = (o: Partial<WatchChange> = {}): WatchChange => ({
  change_id: "c1",
  type: "price_drop",
  severity: "normal",
  before: "1590.00",
  after: "1470.00",
  delta_usd: "-120.00",
  delta_pct: "-7.55",
  source: { provider: "aviasales", url: "https://www.aviasales.ru/search/X", observed_at: "2026-10-10T03:42:00Z" },
  detected_at: "2026-10-10T03:42:00Z",
  notified: "digest",
  ...o,
});

const card = (o: Partial<EventCard> = {}): EventCard => ({
  event_id: "7d3c2b1a-0e9f-4a8b-8c7d-000000000001",
  title: "Formula 1 Abu Dhabi Grand Prix",
  categories: ["sport.motorsport"],
  is_past: false,
  start: { local_date: "2026-12-04", local_time: null, utc: null, timezone: "Asia/Dubai" },
  end: { local_date: "2026-12-06", local_time: null, utc: null, timezone: "Asia/Dubai" },
  venue: { name: "Yas Marina Circuit", city: "Abu Dhabi", country_code: "AE" },
  online: false,
  lifecycle: { status: "ON_SALE", changed_at: "2026-10-10T03:42:00Z" },
  quality_score: 96,
  price_range: null,
  media: null,
  updated_at: "2026-10-10T03:42:00Z",
  ...o,
});

const watch = (o: Partial<Watch> = {}): Watch => ({
  watch_id: "w-1",
  event_id: card().event_id,
  event_title: "Formula 1 Abu Dhabi Grand Prix",
  event: card(),
  status: "active",
  ended_reason: null,
  dimensions: { tickets: true, price: true, flight: true, hotel: true, status: true, news: true },
  threshold_pct: 10,
  tier: "comfort",
  travellers: 1,
  last_snapshot: { taken_at: "2026-10-10T03:42:00Z", lifecycle_status: "ON_SALE", per_person_usd: "1470.00", total_usd: "1470.00", flight_usd: null, hotel_usd: null, ticket_status: "on_sale", offer_id: null },
  last_change: change(),
  next_check_at: "2026-10-10T07:00:00Z",
  created_at: "2026-09-28T10:00:00Z",
  version: 4,
  ...o,
});

const t = (lang: Lang) => (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(lang, k, v);

/* ---------------------------------------------------------------- money & deltas */

describe("watch money: decimal strings, never floats", () => {
  it("usd formats the per-person price with NBSP grouping; malformed / negative → empty", () => {
    expect(usd("1470.00", "ru")).toBe(`$1${NB}470`);
    expect(usd("1180.5", "ru")).toBe(`$1${NB}180,50`);
    expect(usd("1180.5", "en")).toBe("$1,180.50");
    expect(usd("0.1", "en")).toBe("$0.10");
    expect(usd("1e3", "ru")).toBe("");
    expect(usd("-5.00", "ru")).toBe("");
    expect(usd(null, "ru")).toBe("");
  });

  it("signed deltas: drop → minus sign (U+2212), rise → plus; the change type gives the sign of an unsigned value", () => {
    expect(signedUsd("-120.00", "ru")).toBe(`${MINUS}$120`);
    expect(signedUsd("45.00", "en", 1)).toBe("+$45");
    expect(signedUsd("120.00", "ru", -1)).toBe(`${MINUS}$120`);
    expect(signedUsd("+1200.00", "ru")).toBe(`+$1${NB}200`);
    expect(signedUsd("0.00", "ru", -1)).toBe("$0");
    expect(signedUsd("abc", "ru")).toBe("");
    expect(signedPct("-7.55", "ru")).toBe(`${MINUS}7,55${NB}%`);
    expect(signedPct("10", "en", -1)).toBe(`${MINUS}10%`);
    expect(signedPct("7.50", "ru", 1)).toBe(`+7,5${NB}%`);
  });

  it("changeSign uses the type, then the value's sign, then before/after in cents", () => {
    expect(changeSign(change())).toBe(-1);
    expect(changeSign(change({ type: "price_rise", delta_usd: "45.00" }))).toBe(1);
    expect(changeSign(change({ type: "flight", delta_usd: null, before: "400.00", after: "320.50" }))).toBe(-1);
    expect(changeSign(change({ type: "hotel", delta_usd: null, before: "100.00", after: "100.01" }))).toBe(1);
    expect(changeSign(change({ type: "hotel", delta_usd: null, before: "100.00", after: "100.00" }))).toBe(0);
  });
});

/* ---------------------------------------------------------------- status, stats, order */

describe("watch status, stats and order", () => {
  it("badge: ended reasons, paused, critical, low inventory, waiting for the first check, live", () => {
    expect(watchBadge(watch({ status: "ended", ended_reason: "EVENT_PAST" })).key).toBe("w.b.past");
    expect(watchBadge(watch({ status: "ended", ended_reason: "EVENT_CANCELLED" })).tone).toBe("bad");
    expect(watchBadge(watch({ status: "ended", ended_reason: "USER" })).key).toBe("w.b.stopped");
    expect(watchBadge(watch({ status: "ended", ended_reason: "EVENT_REMOVED" }))).toEqual({ key: "w.b.removed", tone: undefined });
    expect(watchBadge(watch({ status: "ended", ended_reason: "SOMETHING_NEW" as never })).key).toBe("w.b.ended");
    expect(endedKey("EVENT_REMOVED").note).toBe("w.end.removed");
    expect(endedKey(null).note).toBe("w.end.other");
    expect(translate("ru", "w.end.removed")).not.toMatch(/возврат/);
    expect(isCritical(watch({ status: "ended", ended_reason: "EVENT_REMOVED", last_change: change({ severity: "critical" }) }))).toBe(false);
    expect(watchBadge(watch({ status: "paused", last_change: change({ severity: "critical" }) })).key).toBe("w.b.paused");
    expect(watchBadge(watch({ last_change: change({ type: "lifecycle", severity: "critical", after: "POSTPONED" }) }))).toEqual({ key: "w.b.crit", tone: "bad" });
    expect(watchBadge(watch({ event: card({ lifecycle: { status: "LOW_INVENTORY", changed_at: "x" } }) })).key).toBe("w.b.low");
    expect(watchBadge(watch({ last_snapshot: null, last_change: null })).key).toBe("w.b.wait");
    expect(watchBadge(watch())).toEqual({ key: "w.b.live", tone: "good", live: true });
  });

  it("stats: active, critical (not ended), the nearest check of an active watch", () => {
    const list = [
      watch({ watch_id: "a", next_check_at: "2026-10-10T07:00:00Z" }),
      watch({ watch_id: "b", next_check_at: "2026-10-10T05:30:00Z", last_change: change({ severity: "critical" }) }),
      watch({ watch_id: "c", status: "paused", next_check_at: "2026-10-10T04:10:00Z" }),
      watch({ watch_id: "d", status: "ended", last_change: change({ severity: "critical" }) }),
    ];
    expect(watchStats(list)).toEqual({ active: 2, critical: 1, nextCheckAt: "2026-10-10T05:30:00Z" });
    expect(isCritical(list[3]!)).toBe(false);
    expect(sortWatches(list).map((w) => w.watch_id)).toEqual(["b", "a", "c", "d"]);
  });

  it("until the next check: minutes, hours, days; unknown → null", () => {
    const now = Date.parse("2026-10-10T04:00:00Z");
    expect(untilLabel("2026-10-10T07:00:00Z", now)).toEqual({ n: 3, unit: "h" });
    expect(untilLabel("2026-10-10T04:20:00Z", now)).toEqual({ n: 20, unit: "min" });
    expect(untilLabel("2026-10-13T04:00:00Z", now)).toEqual({ n: 3, unit: "d" });
    expect(untilLabel("2026-10-10T03:00:00Z", now)).toEqual({ n: 1, unit: "min" });
    expect(untilLabel(null, now)).toBeNull();
    expect(untilLabel("garbage", now)).toBeNull();
  });
});

/* ---------------------------------------------------------------- change rows */

describe("change rows (history, Home «Что изменилось»)", () => {
  it("flap: signed delta for prices, short status for lifecycle, tone by meaning", () => {
    expect(changeFlap(change(), "ru")).toEqual({ text: `${MINUS}$120`, key: null, tone: "good" });
    expect(changeFlap(change({ type: "price_rise", delta_usd: "45.00" }), "en")).toEqual({ text: "+$45", key: null, tone: "bad" });
    expect(changeFlap(change({ type: "lifecycle", severity: "critical", after: "POSTPONED", delta_usd: null }), "ru")).toEqual({ text: "", key: "flap.life.POSTPONED", tone: "bad" });
    expect(changeFlap(change({ type: "lifecycle", after: "ON_SALE", delta_usd: null }), "ru").tone).toBe("lime");
    expect(changeFlap(change({ type: "tickets", after: "LOW_INVENTORY", delta_usd: null }), "ru").tone).toBe("warn");
    expect(changeFlap(change({ type: "lifecycle", after: "<b>x</b>", delta_usd: null }), "ru").key).toBe("flap.chg");
  });

  it("line: «Поездка подешевела: $1 590 → $1 470», status changes by their label; short forms without values", () => {
    expect(changeLine(change(), "ru")).toEqual({ key: "w.c.drop", vars: { from: `$1${NB}590`, to: `$1${NB}470` } });
    expect(changeLine(change({ before: null }), "ru").key).toBe("w.c.dropShort");
    expect(changeLine(change({ type: "lifecycle", after: "POSTPONED" }), "ru")).toEqual({ key: "w.c.life", vars: { s: "POSTPONED" } });
    expect(changeLine(change({ type: "tickets", after: "SOLD_OUT" }), "ru")).toEqual({ key: "w.c.tickets", vars: { s: "SOLD_OUT" } });
    expect(changeLine(change({ type: "hotel", before: "780.00", after: "720.00" }), "en")).toEqual({ key: "w.c.hotel", vars: { from: "$780", to: "$720" } });
    expect(translate("ru", "w.c.drop", { from: "$1 590", to: "$1 470" })).toBe("Поездка подешевела: $1 590 → $1 470");
  });

  it("board time: HH:MM today, «вчера», dd.MM earlier (viewer's zone)", () => {
    const now = new Date(2026, 9, 10, 9, 0).getTime();
    expect(boardTime(new Date(2026, 9, 10, 8, 42).toISOString(), "ru", now)).toEqual({ kind: "time", text: "08:42" });
    expect(boardTime(new Date(2026, 9, 9, 21, 10).toISOString(), "ru", now).kind).toBe("yday");
    expect(boardTime(new Date(2026, 9, 7, 10, 2).toISOString(), "ru", now)).toEqual({ kind: "date", text: "07.10" });
  });

  it("duplicates suppressed are counted from the history", () => {
    expect(suppressedCount([change(), change({ change_id: "2", notified: "suppressed" }), change({ change_id: "3", notified: "suppressed" })])).toBe(2);
  });

  it("Home watch_changes items: BFF HomeWatchChange, Watch objects, flat changes; junk dropped; newest first (B1)", () => {
    const rows = normalizeChangeRows([
      // HomeWatchChange — what telegram-bff sends
      { watch_id: "w-3", event_id: "e-3", event_title: "Qatar Open", status: "ended", change: change({ change_id: "c7", type: "lifecycle", after: "CANCELLED", detected_at: "2026-10-10T06:00:00Z" }) },
      watch(),
      { ...change({ change_id: "c9", detected_at: "2026-10-10T05:00:00Z" }), watch_id: "w-2", event_id: "e-2", event_title: "Gala" },
      { event_id: "e-3", event_title: "No change" },
      { watch_id: "w-4", event_id: "e-4", event_title: "Bad", status: "active", change: { change_id: 1 } },
      watch({ event_title: "" }),
      null,
      "x",
    ]);
    expect(rows.map((r) => [r.watch_id, r.event_title, r.status, r.change.change_id])).toEqual([
      ["w-3", "Qatar Open", "ended", "c7"],
      ["w-2", "Gala", null, "c9"],
      ["w-1", "Formula 1 Abu Dhabi Grand Prix", "active", "c1"],
    ]);
  });

  it("a cancellation is critical for 7 days after the watch ended (M2); other ended watches are not", () => {
    const now = Date.parse("2026-10-10T04:00:00Z");
    const cancelled = (at: string) => watch({ status: "ended", ended_reason: "EVENT_CANCELLED", last_change: change({ type: "lifecycle", severity: "critical", after: "CANCELLED", detected_at: at }) });
    expect(isCritical(cancelled("2026-10-08T10:00:00Z"), now)).toBe(true);
    expect(isCritical(cancelled("2026-10-02T10:00:00Z"), now)).toBe(false);
    expect(isCritical(watch({ status: "ended", ended_reason: "EVENT_PAST", last_change: change({ severity: "critical" }) }), now)).toBe(false);
    expect(watchStats([watch(), cancelled("2026-10-09T00:00:00Z")], now).critical).toBe(1);
    expect(sortWatches([watch({ watch_id: "a" }), { ...cancelled("2026-10-09T00:00:00Z"), watch_id: "b" }], now).map((w) => w.watch_id)).toEqual(["b", "a"]);
  });

  it("badge keys: one quantity — critical changes by watch + change, from the Home board and from the Watch list", () => {
    const now = Date.parse("2026-10-10T04:00:00Z");
    const rows = normalizeChangeRows([
      { watch_id: "w-1", event_id: "e1", event_title: "Gala", status: "active", change: change({ change_id: "g2", type: "lifecycle", severity: "critical", after: "POSTPONED" }) },
      { watch_id: "w-2", event_id: "e2", event_title: "Qatar", status: "ended", change: change({ change_id: "q1", type: "lifecycle", severity: "critical", after: "CANCELLED", detected_at: "2026-10-08T10:00:00Z" }) },
      { watch_id: "w-3", event_id: "e3", event_title: "Old", status: "ended", change: change({ change_id: "o1", type: "lifecycle", severity: "critical", after: "CANCELLED", detected_at: "2026-09-01T10:00:00Z" }) },
      { watch_id: "w-4", event_id: "e4", event_title: "F1", status: "active", change: change({ change_id: "f1" }) },
    ]);
    expect(criticalKeysOfRows(rows, now).sort()).toEqual(["w-1:g2", "w-2:q1"]);
    const list = [
      watch({ watch_id: "w-1", last_change: change({ change_id: "g2", severity: "critical" }) }),
      watch({ watch_id: "w-2", status: "ended", ended_reason: "EVENT_CANCELLED", last_change: change({ change_id: "q1", severity: "critical", detected_at: "2026-10-08T10:00:00Z" }) }),
      watch({ watch_id: "w-4" }),
    ];
    expect(criticalKeysOfWatches(list, now).sort()).toEqual(["w-1:g2", "w-2:q1"]);
  });

  it("the badge: keys not acknowledged by the Watch tab; acknowledgements are remembered; a new key lights it", async () => {
    localStorage.clear();
    watchStore.reset();
    watchStore.setCritical(["w-1:g2", "w-2:q1"]);
    await waitFor(() => expect(watchStore.badge()).toBe(2));
    watchStore.ack(["w-1:g2", "w-2:q1"]);
    expect(watchStore.badge()).toBe(0);
    // next launch: the acknowledgements are read back
    watchStore.reset();
    watchStore.setCritical(["w-1:g2", "w-2:q1", "w-1:g3"]);
    await waitFor(() => expect(watchStore.badge()).toBe(1));
    localStorage.clear();
  });

  it("pages of watches are merged without repeats", () => {
    expect(mergeWatches([watch({ watch_id: "a" }), watch({ watch_id: "b" })], [watch({ watch_id: "b" }), watch({ watch_id: "c" })]).map((w) => w.watch_id)).toEqual(["a", "b", "c"]);
  });
});

/* ---------------------------------------------------------------- news */

const newsItem = (o: Partial<NewsItem> = {}): NewsItem => ({
  news_id: "n1",
  kind: "article",
  title: "Formula 1 confirms the timetable",
  summary: "Qualifying on 5 December.",
  source: { name: "Formula 1", domain: "formula1.com", url: "https://www.formula1.com/en/latest/article/x" },
  published_at: "2026-10-10T02:00:00Z",
  significance: "high",
  interests: ["sport.motorsport"],
  event_ids: ["e1"],
  link: { type: "watch", label: "F1 Abu Dhabi" },
  ...o,
});

describe("news: untrusted feed text, sources", () => {
  it("plain text: tags removed, entities decoded, control characters and long text cut", () => {
    expect(plainText("Shows <img src=x onerror=alert(1)>in <b>Dubai</b> &amp; Doha&nbsp;")).toBe("Shows in Dubai & Doha");
    expect(plainText("a\u0000b\nc")).toBe("a b c");
    expect(plainText("<script>alert(1)</script>ok<style>p{}</style>")).toBe("ok");
    expect(plainText("x".repeat(700))).toHaveLength(600);
    expect(plainText(null)).toBe("");
  });

  it("only items with an https source are shown (AT-33); malformed items are dropped", () => {
    const list = showableNews([newsItem(), newsItem({ news_id: "n2", source: { name: "x", domain: "x.org", url: "http://x.org/a" } }), { news_id: "n3" }, null]);
    expect(list.map((n) => n.news_id)).toEqual(["n1"]);
    expect(newsSourceUrl(newsItem({ source: { name: "x", domain: "x", url: "javascript:alert(1)" } }))).toBeNull();
  });

  it("NewsCard: significance, link, plain-text summary, the source opens the item's URL, no image", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <I18nProvider initial="ru">
        <AppContext.Provider value={{ navigate: vi.fn() } as unknown as AppCtx}>
          <NewsCard n={newsItem({ summary: "<script>alert(1)</script>Квалификация 5 декабря" })} />
        </AppContext.Provider>
      </I18nProvider>,
    );
    expect(screen.getByTestId("news-sig")).toHaveTextContent("Высокая значимость");
    expect(screen.getByTestId("news-bound")).toHaveTextContent("Watch · F1 Abu Dhabi");
    expect(screen.getByTestId("news-card").querySelector("script, img")).toBeNull();
    expect(screen.getByTestId("news-card").querySelector("p")).toHaveTextContent(/^Квалификация 5 декабря$/);
    fireEvent.click(screen.getByTestId("news-src"));
    expect(open).toHaveBeenCalledWith("https://www.formula1.com/en/latest/article/x", "_blank", "noopener,noreferrer");
  });
});

/* ---------------------------------------------------------------- «Почему вам» */

const deps = (lang: Lang): ReasonDeps => ({
  t: t(lang),
  lang,
  category: (c) => (c === "music.concerts" ? (lang === "ru" ? "Концерты" : "Concerts") : null),
  country: (c) => (c === "TR" ? (lang === "ru" ? "Турция" : "Türkiye") : c),
});

describe("«Почему вам»: texts from codes, kinds, score", () => {
  it("each code → a RU / EN sentence with params; missing params → the generic sentence; unknown code → dropped", () => {
    expect(reasonText({ code: "INTEREST_MATCH", params: { category: "music.concerts" }, kind: "recommendation" }, deps("ru"))).toBe("Совпадает с вашим интересом «Концерты»");
    expect(reasonText({ code: "INTEREST_MATCH", params: { category: "unknown.code" }, kind: "recommendation" }, deps("ru"))).toBe("Совпадает с вашими интересами");
    expect(reasonText({ code: "ENTITY_MATCH", params: { entity: "Formula 1" }, kind: "recommendation" }, deps("en"))).toBe("“Formula 1” is in your interests");
    expect(reasonText({ code: "IN_GEOGRAPHY", params: { country: "tr" }, kind: "fact" }, deps("ru"))).toBe("Турция — в вашей географии");
    expect(reasonText({ code: "FITS_BUDGET", params: { trip_per_person: "844.00", budget_max: "1000.00" }, kind: "estimate" }, deps("ru"))).toBe("Поездка ~$844 на человека — в бюджете до $1 000");
    expect(reasonText({ code: "OVER_BUDGET", params: { trip_per_person: "oops" }, kind: "estimate" }, deps("en"))).toBe("Above your budget");
    // интеграция: имена params как у services/recommendations (domain/scoring.py)
    expect(reasonText({ code: "IN_GEOGRAPHY", params: { level: "country", code: "TR" }, kind: "fact" }, deps("ru"))).toBe("Турция — в вашей географии");
    expect(reasonText({ code: "IN_GEOGRAPHY", params: { level: "world", country_code: "TR" }, kind: "fact" }, deps("ru"))).toBe("Турция — в вашей географии");
    expect(reasonText({ code: "IN_GEOGRAPHY", params: { level: "city", code: "Baku" }, kind: "fact" }, deps("ru"))).toBe("Baku — в вашей географии");
    expect(reasonText({ code: "IN_GEOGRAPHY", params: { level: "online" }, kind: "fact" }, deps("ru"))).toBe("В вашей географии");
    expect(reasonText({ code: "FITS_BUDGET", params: { per_person: "844.00", max: "1000.00", basis: "trip" }, kind: "estimate" }, deps("ru"))).toBe("Поездка ~$844 на человека — в бюджете до $1 000");
    // basis «ticket»: only the ticket price is known — the text says «Билет», never «Поездка» (review)
    expect(reasonText({ code: "FITS_BUDGET", params: { per_person: "120.00", max: "1000.00", basis: "ticket" }, kind: "estimate" }, deps("ru"))).toBe("Билет ~$120 — в бюджете до $1\u00a0000");
    expect(reasonText({ code: "OVER_BUDGET", params: { per_person: "2400.00", max: "2000.00", basis: "ticket" }, kind: "estimate" }, deps("en"))).toBe("Ticket ~$2,400 — above your $2,000 budget");
    expect(reasonText({ code: "HIGH_SIGNIFICANCE", params: { quality_score: 88 }, kind: "fact" }, deps("ru"))).toBe("Значимость события — 88 из 100");
    expect(reasonText({ code: "HIGH_SIGNIFICANCE", params: {}, kind: "fact" }, deps("en"))).toBe("High event significance in the catalogue");
    expect(reasonText({ code: "SALES_OPEN", params: { status: "LOW_INVENTORY" }, kind: "fact" }, deps("ru"))).toBe("Билеты в продаже, осталось мало");
    expect(reasonText({ code: "NEW", params: { first_seen_at: "2026-10-06T08:00:00Z" }, kind: "fact" }, deps("ru"))).toBe("Новое в каталоге — с 6 октября");
    expect(reasonText({ code: "MORE_LIKE_THIS", params: { scope: "event" }, kind: "recommendation" }, deps("en"))).toBe("You marked it “More like this”");
    expect(reasonText({ code: "MORE_LIKE_THIS", params: { category: "music.concerts" }, kind: "recommendation" }, deps("ru"))).toBe("Вы просили больше такого: «Концерты»");
    expect(reasonText({ code: "OVER_BUDGET", params: { per_person: "2400.00", max: "2000.00", basis: "trip", over_by: "400.00" }, kind: "estimate" }, deps("en"))).toMatch(/^Trip ~\$2.400 per person/);
    expect(reasonText({ code: "SALES_OPEN", params: {}, kind: "fact" }, deps("en"))).toBe("Tickets are on sale");
    expect(reasonText({ code: "HACK" as never, params: {}, kind: "fact" }, deps("ru"))).toBeNull();
  });

  it("at most 3 reasons, kind normalised; score clamped to 0..100", () => {
    const rec: Recommendation = {
      score: 104.4,
      reasons: [
        { code: "NEW", params: {}, kind: "fact" },
        { code: "NOPE" as never, params: {}, kind: "fact" },
        { code: "SALES_OPEN", params: {}, kind: "weird" as never },
        { code: "HIGH_SIGNIFICANCE", params: {}, kind: "fact" },
        { code: "MORE_LIKE_THIS", params: {}, kind: "recommendation" },
      ],
    };
    expect(displayReasons(rec, deps("ru")).map((r) => [r.code, r.kind])).toEqual([
      ["NEW", "fact"],
      ["SALES_OPEN", "recommendation"],
      ["HIGH_SIGNIFICANCE", "fact"],
    ]);
    expect(clampScore(rec.score)).toBe(100);
    expect(clampScore(-3)).toBe(0);
    expect(clampScore(Number.NaN)).toBeNull();
    expect(displayReasons(null, deps("ru"))).toEqual([]);
  });

  it("WhyBlock + useReaction: ring, factors, legend; «Больше такого» → POST, «Отменить» → DELETE; a failure rolls back", async () => {
    const react = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiError(503, "SERVICE_UNAVAILABLE", "x"));
    const unreact = vi.fn().mockResolvedValue(undefined);
    const api = { recommendations: { react, unreact }, directory: { interests: async () => ({ items: [] }) } } as unknown as Api;
    const rec: Recommendation = { score: 96, reasons: [{ code: "SALES_OPEN", params: {}, kind: "fact" }, { code: "NEW", params: {}, kind: "fact" }], factors: { interests: 100, geography: 90, budget: null, significance: 96, freshness: 40, feedback: 50 } };
    function Detail() {
      const r = useReaction("e1", null);
      return r.rx === "less" ? <NotInterested r={r} /> : <WhyBlock rec={rec} reaction={r} />;
    }
    render(
      <I18nProvider initial="ru">
        <AppContext.Provider value={{ api } as unknown as AppCtx}>
          <Detail />
          <ToastHost />
        </AppContext.Provider>
      </I18nProvider>,
    );
    expect(screen.getByTestId("why-score")).toHaveAttribute("aria-label", "Совпадение 96 из 100");
    expect(screen.getByTestId("why-reasons").querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByRole("list", { name: "Что значат метки" })).toHaveTextContent("фактиз источникаоценкарасчёт по ценамрекомендациявывод по профилю");
    fireEvent.click(screen.getByTestId("why-fx-toggle"));
    expect(screen.getByTestId("why-factors")).toHaveTextContent("Бюджет не оценён: нет цены поездки.");
    fireEvent.click(screen.getByTestId("why-more"));
    await waitFor(() => expect(react).toHaveBeenCalledWith({ event_id: "e1", reaction: "more", undo: false }));
    expect(screen.getByTestId("why-more")).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getByTestId("why-undo")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("why-undo"));
    await waitFor(() => expect(unreact).toHaveBeenCalledWith("e1"));
    await waitFor(() => expect(screen.getByTestId("why-more")).toHaveAttribute("aria-pressed", "false"));
    fireEvent.click(screen.getByTestId("why-less"));
    // optimistic: the «Не интересно» block shows at once, the failure brings «Почему вам» back
    expect(screen.getByTestId("dt-not-interested")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Сервис временно недоступен"));
    expect(screen.getByTestId("why-less")).toHaveAttribute("aria-pressed", "false");
  });

  it("reaction not_interested from the BFF → «Вы отметили «Не интересно» · Отменить»; undo is DELETE, rolled back on failure", async () => {
    const unreact = vi.fn().mockRejectedValueOnce(new ApiError(503, "SERVICE_UNAVAILABLE", "x")).mockResolvedValueOnce(undefined);
    const api = { recommendations: { react: vi.fn(), unreact } } as unknown as Api;
    function Detail() {
      const r = useReaction("e1", "not_interested");
      return r.rx === "less" ? <NotInterested r={r} /> : <p data-testid="gone">ok</p>;
    }
    render(
      <I18nProvider initial="ru">
        <AppContext.Provider value={{ api } as unknown as AppCtx}>
          <Detail />
          <ToastHost />
        </AppContext.Provider>
      </I18nProvider>,
    );
    expect(screen.getByTestId("dt-not-interested")).toHaveTextContent("Вы отметили «Не интересно»");
    fireEvent.click(screen.getByRole("button", { name: "Отменить «Не интересно»" }));
    expect(screen.getByTestId("gone")).toBeInTheDocument(); // optimistic
    await waitFor(() => expect(screen.getByTestId("dt-not-interested")).toBeInTheDocument()); // rolled back
    await waitFor(() => expect(screen.getByRole("button", { name: "Отменить «Не интересно»" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Отменить «Не интересно»" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Реакция отменена"));
    expect(screen.getByTestId("gone")).toBeInTheDocument();
    expect(unreact).toHaveBeenCalledTimes(2);
  });
});

/* ---------------------------------------------------------------- cards */

describe("EventCard: score badge and the Watch icon", () => {
  it("«96% для вас»; the icon is filled when watched; its tap does not open the detail", () => {
    const onOpen = vi.fn();
    const onTap = vi.fn();
    render(
      <I18nProvider initial="ru">
        <EventCardView event={card()} variant="large" typeLabel="Автоспорт" onOpen={onOpen} score={96} watch={{ on: true, onTap }} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("card-score")).toHaveTextContent("96% для вас");
    const btn = screen.getByTestId("card-watch");
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(btn).toHaveAccessibleName("Настройки слежения за «Formula 1 Abu Dhabi Grand Prix»");
    fireEvent.click(btn);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("no score and no watch → no overlay", () => {
    render(
      <I18nProvider initial="en">
        <EventCardView event={card()} variant="list" typeLabel="Motorsport" onOpen={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.queryByTestId("card-score")).toBeNull();
    expect(screen.queryByTestId("card-watch")).toBeNull();
  });
});

/* ---------------------------------------------------------------- Watch sheet */

describe("WatchSheet", () => {
  function setup(w = watch(), patchImpl?: (id: string, p: unknown) => Promise<Watch>) {
    const patch = vi.fn(patchImpl ?? (async (_id: string, p: { expected_version: number }) => ({ ...w, ...(p as object), version: p.expected_version + 1 }) as Watch));
    const get = vi.fn(async () => ({ ...w, version: 9, threshold_pct: 15 as const }));
    const changes = vi.fn(async () => ({ items: [change(), change({ change_id: "c2", notified: "suppressed" })], next_cursor: null }));
    const api = { watches: { get, patch, changes, remove: vi.fn() } } as unknown as Api;
    const profile = { notifications: { enabled: true, quiet_hours: { start: "23:00", end: "08:00" }, digest_time: "09:30", timezone: "Asia/Tashkent" } };
    const ctx = { api, profile, reloadProfile: vi.fn(), nav: { stack: [{ name: "watch" }] }, navigate: vi.fn() } as unknown as AppCtx;
    const onChanged = vi.fn();
    render(
      <I18nProvider initial="ru">
        <AppContext.Provider value={ctx}>
          <div id="aie-layers" />
          <WatchSheet watchId={w.watch_id} initial={w} onClose={vi.fn()} onChanged={onChanged} />
          <ToastHost />
        </AppContext.Provider>
      </I18nProvider>,
    );
    return { patch, get, changes, onChanged, ctx };
  }

  it("shows the notification settings of the profile, the history and suppressed duplicates", async () => {
    setup();
    expect(screen.getByTestId("w-quiet")).toHaveTextContent("Тихие часы 23:00–08:00");
    expect(screen.getByTestId("w-how")).toHaveTextContent("Критичное — сразу, остальное — дайджестом в 09:30");
    await waitFor(() => expect(screen.getAllByTestId("w-change")).toHaveLength(2));
    expect(screen.getByTestId("w-suppressed")).toHaveTextContent("Подавлено дублей: 1.");
  });

  it("a dimension and the threshold are PATCHed with expected_version; the store learns the new state", async () => {
    const { patch, onChanged } = setup();
    fireEvent.click(screen.getByRole("switch", { name: "Новости" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("w-1", { dimensions: { news: false }, expected_version: 4 }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: `15${NB}%` }));
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith("w-1", { threshold_pct: 15, expected_version: 5 }));
    expect(watchStore.get(card().event_id)).toEqual({ watch_id: "w-1", status: "active" });
  });

  it("409 → the watch is reloaded and the user is told; other errors roll back", async () => {
    const { get } = setup(watch(), async () => {
      throw new ApiError(409, "VERSION_CONFLICT", "x");
    });
    fireEvent.click(screen.getByRole("button", { name: `5${NB}%` }));
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Слежение изменилось в другом окне — показываем актуальное"));
    expect(screen.getByRole("button", { name: `15${NB}%` })).toHaveAttribute("aria-pressed", "true");
  });

  it("the last dimension stays on", async () => {
    const { patch } = setup(watch({ dimensions: { tickets: false, price: true, flight: false, hotel: false, status: false, news: false } }));
    fireEvent.click(screen.getByRole("switch", { name: "Цена поездки" }));
    await act(async () => undefined);
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Оставьте хотя бы одно измерение");
  });
});

/* ---------------------------------------------------------------- API, deep links, errors */

describe("sprint 6 API and deep links", () => {
  it("endpoints: watches, changes, news with the filter, preferences, reactions", async () => {
    const seen: Array<[string, string, unknown, string | null]> = [];
    const session: SessionResponse = {
      access_token: "acc",
      expires_in: 900,
      refresh_token: "ref",
      user: { user_id: "u", display_name: "I", username: null, locale: "ru", status: "ACTIVE", is_new: false },
      security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null },
      consent: { accepted: true, policy_version: "1", current_policy_version: "1", accepted_at: null, evidence_hash: null, age_confirmed_18_plus: true },
      onboarding_completed: true,
    };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/v1/session/telegram")) return new Response(JSON.stringify(session), { status: 200, headers: { "content-type": "application/json" } });
      seen.push([init.method ?? "GET", url, init.body ? JSON.parse(String(init.body)) : null, new Headers(init.headers).get("idempotency-key")]);
      return new Response(init.method === "DELETE" ? null : JSON.stringify({ items: [], next_cursor: null }), { status: init.method === "DELETE" ? 204 : 200, headers: { "content-type": "application/json" } });
    });
    const client = new ApiClient({ baseUrl: "https://bff.test", fetchImpl: fetchImpl as unknown as typeof fetch, storage: null, lang: () => "ru" });
    await client.startSession("init");
    const api = createApi(client);
    await api.watches.list("active");
    await api.watches.list(undefined, "20");
    await api.watches.create({ event_id: "e1" }, "idem-1");
    await api.watches.patch("w/1", { threshold_pct: 5, expected_version: 3 });
    await api.watches.changes("w1", "c 2");
    await api.watches.remove("w1");
    await api.news.list("interests", null);
    await api.news.setPreferences({ digest: false });
    await api.recommendations.react({ event_id: "e1", reaction: "less", undo: false });
    await api.recommendations.unreact("e/1");
    expect(seen).toEqual([
      // B2: the BFF accepts limit ≤ 20 — pages by cursor
      ["GET", "https://bff.test/v1/watches?status=active&limit=20", null, null],
      ["GET", "https://bff.test/v1/watches?cursor=20&limit=20", null, null],
      ["POST", "https://bff.test/v1/watches", { event_id: "e1" }, "idem-1"],
      ["PATCH", "https://bff.test/v1/watches/w%2F1", { threshold_pct: 5, expected_version: 3 }, null],
      ["GET", "https://bff.test/v1/watches/w1/changes?cursor=c+2&limit=20", null, null],
      ["DELETE", "https://bff.test/v1/watches/w1", null, null],
      ["GET", "https://bff.test/v1/news?filter=interests&limit=20", null, null],
      ["PATCH", "https://bff.test/v1/news/preferences", { digest: false }, null],
      ["POST", "https://bff.test/v1/recommendations/reactions", { event_id: "e1", reaction: "less", undo: false }, null],
      ["DELETE", "https://bff.test/v1/recommendations/reactions/e%2F1", null, null],
    ]);
  });

  it("deep links watch / news / event_<uuid>", () => {
    expect(parseStartParam("watch")).toEqual({ kind: "tab", tab: "watch" });
    expect(parseStartParam("news")).toEqual({ kind: "tab", tab: "news" });
    expect(parseStartParam("event_7D3C2B1A-0E9F-4A8B-8C7D-000000000001")).toEqual({ kind: "event", id: "7d3c2b1a-0e9f-4a8b-8c7d-000000000001" });
  });

  it("watch errors read as people would say them", () => {
    const tr = t("ru");
    expect(errorText(new ApiError(409, "WATCH_LIMIT", "x"), tr, () => "")).toBe("Можно следить не больше чем за 20 событиями — удалите лишние в Watch");
    expect(errorText(new ApiError(422, "EVENT_PAST", "x"), tr, () => "")).toBe("Событие уже прошло — следить не за чем");
    expect(errorText(new ApiError(422, "EVENT_CANCELLED", "x"), tr, () => "")).toBe("Событие отменено — следить не за чем");
    expect(errorText(new ApiError(409, "WATCH_ENDED", "x"), tr, () => "")).toBe("Слежение уже завершено — изменить его нельзя");
    expect(errorText(new ApiError(422, "IDEMPOTENCY_KEY_REQUIRED", "x"), (k, v) => translate("en", k, v), () => "")).toBe("Couldn't send the request. Try again");
    expect(translate("en", "w.toast.on", { n: 10 })).toBe("Watching · threshold 10%");
    expect(translate("ru", "w.toast.on", { n: 10 })).toBe(`Следим · порог 10${NB}%`);
  });
});

describe("fix 6.1: news about a past event is not shown (a guard behind news)", () => {
  const upd = (summary: string, o: Partial<NewsItem> = {}): NewsItem => newsItem({ kind: "event_update", summary, ...o });
  const now = new Date(2026, 9, 10, 9, 0);
  it("the event date: structured fields first, else the latest ISO date in the text of an event update", () => {
    expect(newsEventDate(upd("Осталось мало билетов (2026-10-09, Dubai)."))).toBe("2026-10-09");
    expect(newsEventDate(upd("Перенос с 2026-10-01 на 2026-12-18 (2026-12-18, Istanbul)"))).toBe("2026-12-18");
    expect(newsEventDate(upd("no date"))).toBeNull();
    expect(newsEventDate(newsItem({ summary: "2020-01-01 in an article is not an event date" }))).toBeNull();
    expect(newsEventDate(upd("bad 2026-13-40 date"))).toBeNull();
  });
  it("event_ends_at (news 6.1) decides: over → hidden, later → shown, null → not about a dated event; text — fallback", () => {
    const at = (iso: string | null, summary = "(2026-10-09, Dubai)") => upd(summary, { event_ends_at: iso });
    expect(isPastEventNews(at(new Date(now.getTime() - 60_000).toISOString(), "no date"), now)).toBe(true);
    expect(isPastEventNews(at(new Date(now.getTime() + 60_000).toISOString()), now)).toBe(false); // the field wins over the text
    expect(isPastEventNews(at(null), now)).toBe(false);
    expect(isPastEventNews(at("garbage"), now)).toBe(true); // unparsable → the text date (2026-10-09) decides
  });
  it("past in the viewer's calendar (no event_ends_at: news before 6.1) → hidden; today and later → shown", () => {
    expect(isPastEventNews(upd("(2026-10-09, Dubai)"), now)).toBe(true);
    expect(isPastEventNews(upd("(2026-10-10, Dubai)"), now)).toBe(false);
    expect(showableNews([upd("(2026-10-09, Dubai)"), upd("(2026-12-04, Abu Dhabi)", { news_id: "n2" })], now).map((x) => x.news_id)).toEqual(["n2"]);
  });
});

describe("fix 6.1: QuickChip (catalogue categories and news topics)", () => {
  it("icon, counter badge, muted zero, screen-reader noun", () => {
    const onToggle = vi.fn();
    render(
      <I18nProvider initial="ru">
        <QuickChip id="music" testIdPrefix="nt" noun="n.topic.noun" icon="music" pressed={false} count={3} label="Музыка" onToggle={onToggle} />
        <QuickChip id="sport" testIdPrefix="nt" pressed={false} count={0} label="Спорт" onToggle={onToggle} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("nt-music")).toHaveAccessibleName("Музыка, 3 новости");
    expect(screen.getByTestId("nt-music").querySelector("svg")).not.toBeNull();
    expect(screen.getByTestId("nt-sport")).toHaveClass("dim");
    fireEvent.click(screen.getByTestId("nt-music"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
