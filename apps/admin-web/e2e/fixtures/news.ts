/**
 * Sprint 6 fixtures of the mock admin-bff: news feeds (from docs/sprint6/news_sources_seed.json), collected news,
 * a feed check result and Watch statistics. Shapes follow packages/contracts/src/admin.ts «Спринт 6».
 */
import type { NewsAdminItem, NewsSource, NewsSourceCheck, WatchStats } from "@tilhero/contracts/admin";
import { ID, iso } from "./data";

const MIN = 60_000;
const HOUR = 60 * MIN;
export const FEED = {
  f1: "a6000000-0000-4000-8000-000000000001",
  uefa: "a6000000-0000-4000-8000-000000000002",
  playbill: "a6000000-0000-4000-8000-000000000003",
  kun: "a6000000-0000-4000-8000-000000000004",
  gazeta: "a6000000-0000-4000-8000-000000000005",
  tengri: "a6000000-0000-4000-8000-000000000006",
  opera: "a6000000-0000-4000-8000-000000000007",
  techcrunch: "a6000000-0000-4000-8000-000000000008",
  kunEn: "a6000000-0000-4000-8000-000000000009",
  bbc: "a6000000-0000-4000-8000-000000000010",
};
export const NEWS = {
  f1: "b6000000-0000-4000-8000-000000000001",
  event: "b6000000-0000-4000-8000-000000000002",
  uefa: "b6000000-0000-4000-8000-000000000003",
  kun: "b6000000-0000-4000-8000-000000000004",
  playbill: "b6000000-0000-4000-8000-000000000005",
  hidden: "b6000000-0000-4000-8000-000000000006",
};
export type CheckOutcome = "ok" | "fail" | "unavailable";

const health = (p: Partial<NewsSource["health"]> = {}): NewsSource["health"] => ({ last_fetch_at: iso(-40 * MIN), last_ok_at: iso(-40 * MIN), last_error: null, items_24h: 0, ...p });
const base = (p: Partial<NewsSource> & Pick<NewsSource, "source_id" | "slug" | "name" | "site_domain">): NewsSource => ({
  kind: "media",
  mode: "rss",
  feed_url: `https://${p.site_domain}/rss`,
  page_url: null,
  extra_domains: [],
  interests: ["culture"],
  entities: [],
  country_code: null,
  lang: "ru",
  display: "summary",
  category_filter: null,
  enabled: true,
  health: health(),
  disabled_reason: p.enabled === false ? "manual" : null,
  last_probe_at: null,
  last_probe_result: null,
  version: 1,
  updated_at: iso(-3 * 24 * HOUR),
  ...p,
});

export function sources(): NewsSource[] {
  return [
    base({ source_id: FEED.f1, slug: "formula1-latest", name: "Formula 1 — Latest News", kind: "official", feed_url: "https://www.formula1.com/en/latest/all.xml", site_domain: "formula1.com", interests: ["sport.motorsport"], entities: ["Formula 1", "FIA"], lang: "en", health: health({ items_24h: 7 }), version: 2 }),
    base({ source_id: FEED.uefa, slug: "uefa-inside", name: "UEFA.com — Inside UEFA", kind: "official", feed_url: "https://www.uefa.com/rss/insideuefa/rss.xml", site_domain: "uefa.com", interests: ["sport.football"], entities: ["UEFA"], lang: "en", health: health({ items_24h: 3, last_fetch_at: iso(-95 * MIN), last_ok_at: iso(-95 * MIN) }) }),
    base({ source_id: FEED.playbill, slug: "playbill-news", name: "Playbill — News", feed_url: "https://playbill.com/rss/news", site_domain: "playbill.com", interests: ["culture.theatre", "music.concerts"], entities: ["Broadway"], lang: "en", display: "title_only", health: health({ items_24h: 12 }) }),
    base({
      source_id: FEED.kun,
      slug: "kun-uz-culture",
      name: "Kun.uz — Маданият",
      feed_url: "https://kun.uz/news/rss",
      site_domain: "kun.uz",
      interests: ["culture", "culture.theatre", "festivals.city", "music.concerts"],
      country_code: "UZ",
      lang: "uz",
      category_filter: "/culture/",
      health: health({ last_fetch_at: iso(-35 * MIN), last_ok_at: iso(-26 * HOUR), last_error: { code: "FEED_INVALID", message: "Ответ — HTML-страница защиты от ботов, а не RSS", at: iso(-35 * MIN) }, items_24h: 0 }),
      version: 4,
    }),
    base({ source_id: FEED.gazeta, slug: "gazeta-uz-afisha", name: "Gazeta.uz — Афиша", mode: "html", feed_url: null, page_url: "https://www.gazeta.uz/ru/afisha/", site_domain: "gazeta.uz", interests: ["culture.exhibitions", "culture.cinema"], country_code: "UZ", health: health({ last_fetch_at: iso(-6 * HOUR), last_ok_at: iso(-6 * HOUR), items_24h: 2 }) }),
    base({
      source_id: FEED.tengri,
      slug: "tengrinews-culture",
      name: "Tengrinews — Культура",
      feed_url: "https://tengrinews.kz/news.rss",
      site_domain: "tengrinews.kz",
      interests: ["culture"],
      country_code: "KZ",
      category_filter: "/culture/",
      enabled: false,
      disabled_reason: "unverified",
      last_probe_at: iso(-7 * HOUR),
      last_probe_result: { ok: false, code: "NO_DATES", fetched: 30, accepted: 30, newest_at: null, enabled: false },
      health: health({ last_fetch_at: null, last_ok_at: null }),
    }),
    // fix 6.1: reprint terms not checked — the auto-check runs (the feed is alive) but never switches it on
    base({
      source_id: FEED.bbc,
      slug: "bbc-sport-tennis",
      name: "BBC Sport — Tennis",
      feed_url: "https://feeds.bbci.co.uk/sport/tennis/rss.xml",
      site_domain: "bbc.co.uk",
      extra_domains: ["bbci.co.uk"],
      interests: ["sport.tennis"],
      lang: "en",
      enabled: false,
      disabled_reason: "terms",
      last_probe_at: iso(-5 * HOUR),
      last_probe_result: { ok: true, code: null, fetched: 40, accepted: 38, newest_at: iso(-3 * HOUR), enabled: false },
      health: health({ last_fetch_at: null, last_ok_at: null }),
    }),
    // fix 6.1: switched off with a reason — publisher permission, stale feed (seed of news migration 0004)
    base({
      source_id: FEED.techcrunch,
      slug: "techcrunch",
      name: "TechCrunch",
      feed_url: "https://techcrunch.com/feed/",
      site_domain: "techcrunch.com",
      interests: ["business.startups", "business.ai"],
      lang: "en",
      enabled: false,
      disabled_reason: "legal",
      health: health({ last_fetch_at: null, last_ok_at: null }),
    }),
    base({
      source_id: FEED.kunEn,
      slug: "kun-uz-en",
      name: "Kun.uz — English",
      feed_url: "https://kun.uz/en/news/rss",
      site_domain: "kun.uz",
      interests: ["culture", "business"],
      country_code: "UZ",
      lang: "en",
      enabled: false,
      disabled_reason: "stale",
      last_probe_at: iso(-2 * 24 * HOUR),
      last_probe_result: { ok: false, code: "STALE", fetched: 20, accepted: 20, newest_at: iso(-41 * 24 * HOUR), enabled: false },
      health: health({ last_fetch_at: iso(-9 * 24 * HOUR), last_ok_at: iso(-9 * 24 * HOUR) }),
    }),
    base({ source_id: FEED.opera, slug: "opera-am-news", name: "Armenian National Opera", kind: "official", feed_url: null, mode: "html", page_url: "https://opera.am/en/news", site_domain: "opera.am", interests: ["culture.opera_ballet", "music.classical"], country_code: "AM", lang: "en", last_probe_at: iso(-50 * MIN), last_probe_result: { ok: true, code: null, fetched: 12, accepted: 12, newest_at: iso(-30 * HOUR), enabled: true }, health: health({ last_fetch_at: null, last_ok_at: null, items_24h: 0 }) }),
  ];
}

const it = (p: Partial<NewsAdminItem> & Pick<NewsAdminItem, "news_id" | "title" | "url" | "source">): NewsAdminItem => ({
  kind: "article",
  summary_ru: null,
  summary_en: null,
  published_at: iso(-2 * HOUR),
  collected_at: iso(-90 * MIN),
  significance: 0.55,
  significance_level: "mid",
  interests: [],
  entities: [],
  event_ids: [],
  hidden: false,
  hidden_reason: null,
  hidden_at: null,
  hidden_by: null,
  hidden_by_name: null,
  below_threshold: false,
  ...p,
});

export function items(): NewsAdminItem[] {
  return [
    it({
      news_id: NEWS.event,
      kind: "event_update",
      title: "Imagine Dragons — Loom World Tour: открылись продажи билетов",
      summary_ru: "Статус события изменился на «В продаже». Билеты — от 85 USD на Ticketmaster.",
      summary_en: "The event is now on sale. Tickets from 85 USD on Ticketmaster.",
      url: "https://www.ticketmaster.com/imagine-dragons-loom-world-tour",
      source: { source_id: null, name: "Каталог событий", domain: "ticketmaster.com" },
      published_at: iso(-25 * MIN),
      collected_at: iso(-25 * MIN),
      significance: 0.9,
      significance_level: "high",
      interests: ["music.pop_rock", "music.concerts"],
      event_ids: ["e1000000-0000-4000-8000-000000000042"],
    }),
    it({
      news_id: NEWS.f1,
      title: "Abu Dhabi Grand Prix: tickets for the season finale go on general sale",
      summary_ru: "Организаторы финального этапа сезона открыли общую продажу билетов; трибуны у шиканы — почти распроданы.",
      summary_en: "Organisers of the season finale opened general sales; grandstands at the chicane are almost sold out.",
      url: "https://www.formula1.com/en/latest/article/abu-dhabi-grand-prix-tickets.6Fh2x.html",
      source: { source_id: FEED.f1, name: "Formula 1 — Latest News", domain: "formula1.com" },
      significance: 0.82,
      significance_level: "high",
      interests: ["sport.motorsport"],
      entities: ["Formula 1"],
      event_ids: ["e1000000-0000-4000-8000-000000000051", "e1000000-0000-4000-8000-000000000052"],
    }),
    it({
      news_id: NEWS.uefa,
      title: "UEFA confirms venues for the 2027 Nations League finals",
      summary_ru: "UEFA объявил стадионы финального турнира Лиги наций 2027 года.",
      summary_en: "UEFA named the stadiums of the 2027 Nations League finals.",
      url: "https://www.uefa.com/insideuefa/news/0293-1c5e-nations-league-finals-2027/",
      source: { source_id: FEED.uefa, name: "UEFA.com — Inside UEFA", domain: "uefa.com" },
      published_at: iso(-5 * HOUR),
      interests: ["sport.football"],
      entities: ["UEFA"],
    }),
    it({
      news_id: NEWS.playbill,
      title: "Hadestown Extends Broadway Run Through 2027",
      url: "https://playbill.com/article/hadestown-extends-broadway-run-through-2027",
      source: { source_id: FEED.playbill, name: "Playbill — News", domain: "playbill.com" },
      published_at: iso(-9 * HOUR),
      significance: 0.21,
      significance_level: "low",
      below_threshold: true,
      interests: ["culture.theatre"],
      entities: ["Broadway"],
    }),
    it({
      news_id: NEWS.hidden,
      title: "Скидка 30% на абонементы в фитнес-клуб у Дворца искусств",
      summary_ru: "Рекламный материал партнёра издания.",
      summary_en: "Sponsored material of the publication’s partner.",
      url: "https://kun.uz/culture/2026/10/10/fitness-promo",
      source: { source_id: FEED.kun, name: "Kun.uz — Маданият", domain: "kun.uz" },
      published_at: iso(-28 * HOUR),
      significance: 0.34,
      significance_level: "low",
      interests: ["culture"],
      hidden: true,
      hidden_reason: "Реклама партнёра, а не новость о событии",
      hidden_at: iso(-20 * HOUR),
      hidden_by: ID.ops,
      hidden_by_name: "Тимур",
    }),
  ];
}

export function checkResult(outcome: CheckOutcome, siteDomain: string): NewsSourceCheck {
  if (outcome === "fail")
    return { ok: false, items: [], items_total: 0, errors: [{ code: "FEED_INVALID", message: "Ответ — HTML-страница, а не RSS / Atom" }], checked_at: iso(0) };
  const host = siteDomain.startsWith("www.") ? siteDomain : `www.${siteDomain}`;
  return {
    ok: true,
    items: [
      { url: `https://${host}/news/2026/10/11/season-finale-tickets`, title: "Season finale: tickets go on general sale", published_at: iso(-3 * HOUR), dropped: null },
      { url: `https://${host}/news/2026/10/10/new-venue-announced`, title: "New venue announced for the spring tour", published_at: iso(-26 * HOUR), dropped: null },
      { url: `https://${host}/news/2026/10/09/partners-day`, title: "Partners’ day at the federation", published_at: iso(-50 * HOUR), dropped: null },
      { url: `https://${host}/shop/2026/10/09/merch-sale`, title: "Merchandise sale this weekend", published_at: null, dropped: "category_filter" },
      { url: "https://partner-cdn.example.net/promo/123", title: "Partner promo", published_at: iso(-60 * HOUR), dropped: "link_foreign" },
    ],
    items_total: 20,
    errors: [],
    checked_at: iso(0),
  };
}

export function watchStats(): WatchStats {
  return {
    active: 1284,
    paused: 96,
    ended_24h: 41,
    rechecks_24h: 5136,
    changes_24h: { price_drop: 64, price_rise: 38, lifecycle: 9, tickets: 22, flight: 17, hotel: 11 },
    notifications_24h: { immediate: 9, digest: 58, suppressed: 6 },
    errors_24h: 73,
    next_batch_at: iso(84 * MIN),
  };
}
