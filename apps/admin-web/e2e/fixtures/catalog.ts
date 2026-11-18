/**
 * Sprint-4 fixtures of the mock admin-bff (event catalog): sources (from docs/sprint4/sources_seed.json),
 * review queue, discovery runs and the AI budget. Shapes follow packages/contracts/src/admin.ts (section «Спринт 4»).
 */
import { createHash } from "node:crypto";
import type {
  AiLimits, AiBudget, DiscoveryRun, ReviewDetail, Source, SourceChange, SourceCrawlStats } from "@tilhero/contracts/admin";
import { ID, iso } from "./data";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** served by the mock for every banner URL that ends with /e2e-banner.svg (no real network in e2e) */
export const BANNER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 16 9"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1C2A5A"/><stop offset="1" stop-color="#315EFB"/></linearGradient></defs><rect width="16" height="9" fill="url(#g)"/><circle cx="12.5" cy="2.6" r="1.4" fill="#DFFF56"/><path d="M0 9 5 4.5 8 7l3-2.5L16 9z" fill="#0B1020" opacity=".55"/></svg>`;

/** content_hash of the candidate's facts (events: SHA-256 of the canonical facts) */
export const factsHash = (facts: Record<string, unknown>): string => createHash("sha256").update(JSON.stringify(facts)).digest("hex");

const src = (n: number, s: Omit<Source, "source_id" | "created_at" | "updated_at" | "updated_by" | "updated_by_name" | "version"> & Partial<Source>): Source => ({
  source_id: `5c000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  version: 1,
  created_at: iso(-3 * 24 * HOUR),
  updated_at: iso(-3 * 24 * HOUR),
  updated_by: null,
  updated_by_name: null,
  ...s,
});

export function sources(): Source[] {
  return [
    src(1, {
      slug: "iticket-uz",
      name: "iTicket.uz",
      country_code: "UZ",
      tier: "OFFICIAL_TICKET_PROVIDER",
      event_domains: ["iticket.uz"],
      media_domains: ["cdn.iticket.az", "iticket.uz"],
      listing_pages: [
        { url: "https://iticket.uz/ru/events/concerts", city: "Tashkent", category: "music.concerts" },
        { url: "https://iticket.uz/ru/events/theaters-tashkent", city: "Tashkent", category: "culture.theatre" },
      ],
      enabled: true,
      js_only: false,
      notes: "Исследование 10.10.2026: афиша в HTML.",
      version: 3,
      updated_at: iso(-5 * HOUR),
      updated_by: ID.ops,
    }),
    src(2, {
      slug: "afisha-uz",
      name: "Afisha.uz",
      country_code: "UZ",
      tier: "TRUSTED_MEDIA",
      event_domains: ["afisha.uz"],
      media_domains: ["afisha.uz"],
      listing_pages: [{ url: "https://www.afisha.uz/ru/concerts", city: "Tashkent", category: "music.concerts" }],
      enabled: true,
      js_only: false,
      notes: "Городской гид, частично продаёт билеты.",
    }),
    src(3, {
      slug: "ticketon-kz",
      name: "Ticketon",
      country_code: "KZ",
      tier: "OFFICIAL_TICKET_PROVIDER",
      event_domains: ["ticketon.kz"],
      media_domains: ["*.ticketon.kz"],
      listing_pages: [{ url: "https://ticketon.kz/almaty/concerts", city: "Almaty", category: "music.concerts" }],
      enabled: false,
      js_only: null,
      notes: "Блокирует загрузку — выключен до разбора.",
    }),
    src(4, {
      slug: "tkt-ge",
      name: "tkt.ge",
      country_code: "GE",
      tier: "OFFICIAL_TICKET_PROVIDER",
      event_domains: ["tkt.ge"],
      media_domains: [],
      listing_pages: [{ url: "https://tkt.ge/en/events", city: "Tbilisi", category: null }],
      enabled: false,
      js_only: true,
      notes: "Афиша только через JS.",
    }),
    src(5, {
      slug: "opera-am",
      name: "Armenian National Opera",
      country_code: "AM",
      tier: "OFFICIAL_ORGANIZER",
      event_domains: ["opera.am"],
      media_domains: ["opera.am"],
      listing_pages: [{ url: "https://opera.am/en/afisha", city: "Yerevan", category: "culture.opera_ballet" }],
      enabled: true,
      js_only: false,
      notes: null,
      version: 2,
      updated_at: iso(-26 * HOUR),
      updated_by: ID.admin,
    }),
  ];
}

export function sourceChanges(s: Source): SourceChange[] {
  const out: SourceChange[] = [];
  for (let v = s.version; v >= 1; v--)
    out.push(
      v === 1
        ? { version: 1, actor_id: null, actor_name: null, changed_fields: [], reason: "seed", at: s.created_at }
        : { version: v, actor_id: s.updated_by, actor_name: null, changed_fields: v === s.version ? ["listing_pages"] : ["media_domains"], reason: v === s.version ? "Добавили афишу театров Ташкента" : "CDN баннеров iticket.az", at: iso(-(s.version - v + 1) * 5 * HOUR) },
    );
  return out;
}

const rv = (n: number, r: Partial<ReviewDetail> & Pick<ReviewDetail, "title" | "provider" | "source_url" | "reasons">): ReviewDetail => {
  const base: ReviewDetail = {
    review_id: `7e000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    status: "OPEN",
    provider: r.provider,
    source_name: null,
    source_url: r.source_url,
    tier: "OFFICIAL_TICKET_PROVIDER",
    confidence: 0.54,
    reasons: r.reasons,
    title: r.title,
    start: { local_date: "2026-10-24", local_time: "19:00" },
    city: "Tashkent",
    country_code: "UZ",
    received_at: iso(-n * 37 * MIN),
    content_hash: "",
    facts: {},
    media: [],
    matched_event_id: null,
    decided_by: null,
    decided_by_name: null,
    decided_at: null,
    decision_note: null,
    decision_reason: null,
    event_id: null,
  };
  const out = { ...base, ...r };
  // fix 5.1: an OPEN card knows when it will be removed automatically
  if (out.status === "OPEN" && out.expires_at === undefined) out.expires_at = iso(EXPIRES_IN[n] ?? 5 * 24 * HOUR);
  out.facts = {
    title: out.title,
    start: out.start,
    end: null,
    venue: out.city ? { name: n === 2 ? "Istiqlol Palace" : "Ташкентский театр оперы и балета им. Навои", city: out.city, country_code: out.country_code, address: n === 1 ? "ул. Ататурка, 28" : null } : null,
    online: false,
    categories: ["music.concerts", "music"],
    official_url: out.source_url,
    price_range: n === 1 ? { min: "150000.00", max: "450000.00", currency: "UZS" } : null,
    ...(r.facts ?? {}),
  };
  out.content_hash = factsHash(out.facts);
  return out;
};

export function reviews(): ReviewDetail[] {
  return [
    rv(1, {
      title: "Шахзода. Большой сольный концерт",
      provider: "aiweb.iticket-uz",
      source_name: "iTicket.uz",
      source_url: "https://iticket.uz/ru/events/concerts/shahzoda-2026",
      reasons: ["SOURCE_CONFLICT"],
      confidence: 0.71,
      media: [{ url: "https://cdn.iticket.az/event/poster/e2e-banner.svg", provenance: { provider: "aiweb.iticket-uz", source_url: "https://iticket.uz/ru/events/concerts/shahzoda-2026", fetched_at: iso(-HOUR), rights: "official_site" } }],
      matched_event_id: "e1000000-0000-4000-8000-000000000042",
    }),
    rv(2, {
      title: "Jazz Nights: Tashkent Big Band",
      provider: "aiweb.afisha-uz",
      source_name: "Afisha.uz",
      source_url: "https://www.afisha.uz/ru/concerts/jazz-nights",
      tier: "TRUSTED_MEDIA",
      reasons: ["LOW_CONFIDENCE", "NO_MEDIA"],
      confidence: 0.48,
      start: { local_date: "2026-11-02", local_time: null },
    }),
    rv(3, {
      title: "Лебединое озеро",
      provider: "aiweb.opera-am",
      source_name: "Armenian National Opera",
      source_url: "https://opera.am/en/afisha/swan-lake",
      tier: "OFFICIAL_ORGANIZER",
      reasons: ["CATALOG_REJECTED", "LOCATION_MISSING"],
      confidence: 0.62,
      city: null,
      country_code: "AM",
      start: { local_date: "2026-10-30", local_time: "19:00" },
      media: [{ url: "http://opera.am/img/swan.jpg", provenance: { provider: "aiweb.opera-am", source_url: "https://opera.am/en/afisha/swan-lake", fetched_at: iso(-2 * HOUR), rights: "official_site" } }],
    }),
    rv(4, {
      title: "Imagine Dragons — Loom World Tour",
      provider: "ticketmaster",
      source_name: "Ticketmaster",
      source_url: "https://www.ticketmaster.de/event/imagine-dragons-loom",
      reasons: ["CONFLICT_SAME_RANK"],
      confidence: 0.66,
      city: "Berlin",
      country_code: "DE",
      start: { local_date: "2026-12-05", local_time: "20:00" },
    }),
    rv(5, {
      title: "Кубок Алматы по футзалу",
      provider: "aiweb.ticketon-kz",
      source_name: "Ticketon",
      source_url: "https://ticketon.kz/almaty/sport/futsal-cup",
      reasons: ["SOURCE_NOT_ALLOWED"],
      status: "REJECTED",
      confidence: 0.3,
      city: "Almaty",
      country_code: "KZ",
      decided_by: ID.ops,
      decided_at: iso(-3 * HOUR),
      decision_note: "Источник выключен",
      decision_reason: "SOURCE_UNRELIABLE",
    }),
    // fix 5.1: «Not confirmed» — 7 days in the queue without a decision, removed by the events job
    ...expired(),
  ];
}

const DAY = 24 * HOUR;
/** OPEN cards: when the events job will move them to EXPIRED (fix 5.1) — the row shows «in N days» */
export const EXPIRES_IN: Record<number, number> = { 1: 6 * DAY + 2 * HOUR, 2: 2 * DAY + 20 * HOUR, 3: 20 * HOUR, 4: 4 * DAY + 3 * HOUR };

function expired(): ReviewDetail[] {
  const auto = (daysAgo: number) => ({
    status: "EXPIRED" as const,
    received_at: iso(-(7 * DAY + daysAgo * DAY + 3 * HOUR)),
    decided_by: "system",
    decided_at: iso(-daysAgo * DAY),
    decision_note: null,
    decision_reason: "AUTO_EXPIRED" as const,
    expires_at: null,
    expired_at: iso(-daysAgo * DAY),
  });
  return [
    rv(6, {
      title: "Stand-up вечер: Открытый микрофон",
      provider: "aiweb.iticket-uz",
      source_name: "iTicket.uz",
      source_url: "https://iticket.uz/ru/events/standup/open-mic-oct",
      reasons: ["LOW_CONFIDENCE"],
      confidence: 0.44,
      start: { local_date: "2026-10-25", local_time: "20:00" },
      ...auto(1),
    }),
    rv(7, {
      title: "Выставка «Шёлковый путь в фотографиях»",
      provider: "aiweb.afisha-uz",
      source_name: "Afisha.uz",
      source_url: "https://www.afisha.uz/ru/exhibitions/silk-road-photo",
      tier: "TRUSTED_MEDIA",
      reasons: ["LOCATION_MISSING", "NO_MEDIA"],
      confidence: 0.51,
      city: null,
      start: { local_date: "2026-11-08", local_time: null },
      ...auto(2),
    }),
    rv(8, {
      title: "Кубок Казахстана по боксу — финал",
      provider: "aiweb.ticketon-kz",
      source_name: "Ticketon",
      source_url: "https://ticketon.kz/almaty/sport/boxing-cup-final",
      reasons: ["CONFLICT_SAME_RANK"],
      confidence: 0.58,
      city: "Almaty",
      country_code: "KZ",
      start: { local_date: "2026-11-21", local_time: "18:00" },
      ...auto(4),
    }),
  ];
}

const run = (n: number, r: Partial<DiscoveryRun>): DiscoveryRun => ({
  run_id: `d1500000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  trigger: "scheduler",
  status: "COMPLETED",
  started_at: iso(-n * 6 * HOUR),
  finished_at: iso(-n * 6 * HOUR + 14 * MIN),
  scopes_total: 18,
  scopes_done: 18,
  provider_calls: 74,
  candidates_seen: 212,
  candidates_emitted: 38,
  ai: { llm_calls: 9, pages_fetched: 31, input_tokens: 96_420, output_tokens: 11_380, cost_usd: "0.1533" },
  errors: [],
  ...r,
});

export function runs(): DiscoveryRun[] {
  return [
    run(1, {
      status: "PARTIAL",
      ai: { llm_calls: 14, pages_fetched: 40, input_tokens: 148_900, output_tokens: 17_204, cost_usd: "0.2349" },
      errors: [
        { scope: "ai_web:KG", code: "AI_BUDGET_EXHAUSTED" },
        { scope: "ai_web:AZ", code: "AI_BUDGET_EXHAUSTED" },
        { scope: "ai_web:AM", code: "AI_BUDGET_EXHAUSTED" },
        { scope: "ticketmaster:DE:music", code: "PROVIDER_RATE_LIMITED" },
      ],
    }),
    run(2, { trigger: "manual" }),
    run(3, {
      status: "FAILED",
      scopes_done: 2,
      provider_calls: 3,
      candidates_seen: 0,
      candidates_emitted: 0,
      ai: { llm_calls: 0, pages_fetched: 0, input_tokens: 0, output_tokens: 0, cost_usd: "0.0000" },
      errors: [{ scope: "ai_web:UZ", code: "SOURCE_REGISTRY_UNAVAILABLE" }, { scope: "ticketmaster:*", code: "PROVIDER_UNAVAILABLE" }],
    }),
    run(4, {}),
  ];
}

export const runningRun = (): DiscoveryRun =>
  run(0, {
    run_id: "d1500000-0000-4000-8000-0000000000aa",
    status: "RUNNING",
    started_at: iso(-3 * MIN),
    finished_at: null,
    scopes_done: 7,
    provider_calls: 21,
    candidates_seen: 60,
    candidates_emitted: 9,
    ai: { llm_calls: 3, pages_fetched: 8, input_tokens: 31_200, output_tokens: 3_900, cost_usd: "0.0507" },
  });

/** fix 6.1: AI limits — defaults from env */
export function limits(): AiLimits {
  const defaults = { ai_daily_usd: "1.00", news_daily_usd: "0.20", pages_daily: 300, concierge_daily_usd: "1.00", evaluation_daily_usd: "0.30" };
  return { ...defaults, source: "env", updated_by: null, updated_by_name: null, updated_at: null, reason: null, defaults };
}

export function budget(day = new Date().toISOString().slice(0, 10)): AiBudget {
  return { day, spent_usd: "0.4213", reserved_usd: "0.0380", budget_usd: "1.00", pages_used: 71, pages_limit: 300, paused: null, model: "claude-haiku-4-5", news: { spent_usd: "0.0312", budget_usd: "0.20" } };
}

/**
 * Last crawl of the seed sources (provider-gateway ai_web/sources, fix 4.1): one per outcome the screen shows —
 * events found (with page notes: the page wasn't read in full), nothing found (a non-event of the catalog discarded),
 * robots.txt, JS-only listing, a model error. Sources created in a test have no row.
 */
export function crawlStats(): SourceCrawlStats[] {
  const row = (slug: string, agoMin: number, c: Partial<SourceCrawlStats>): SourceCrawlStats => ({
    slug,
    last_crawl_at: iso(-agoMin * MIN),
    outcome: "ok",
    code: null,
    pages: 1,
    events_found: 0,
    skipped: {},
    notes: {},
    llm_calls: 1,
    cost_usd_last: "0.0000",
    cost_usd_day: "0.0000",
    ...c,
  });
  return [
    row("iticket-uz", 132, { pages: 2, events_found: 14, skipped: { date_mismatch: 3, title_not_on_page: 2, link_foreign: 1 }, notes: { part_truncated: 1, deadline: 1 }, llm_calls: 2, cost_usd_last: "0.0231", cost_usd_day: "0.0462" }),
    row("afisha-uz", 131, { events_found: 0, skipped: { date_out_of_window: 5, category: 3 }, cost_usd_last: "0.0118", cost_usd_day: "0.0236" }),
    row("ticketon-kz", 3 * 24 * 60 + 20, { outcome: "skipped", code: "SOURCE_ROBOTS_DISALLOWED", pages: 0, llm_calls: 0 }),
    row("tkt-ge", 3 * 24 * 60 + 18, { outcome: "skipped", code: "SOURCE_NO_CONTENT", llm_calls: 0, skipped: { no_content: 1 } }),
    row("opera-am", 128, { outcome: "error", code: "PROVIDER_BAD_RESPONSE", cost_usd_last: "0.0412", cost_usd_day: "0.0824" }),
  ];
}
