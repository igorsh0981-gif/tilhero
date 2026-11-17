import type { EventCard, SessionResponse } from "@tilhero/contracts/bff";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api/client";
import { createApi } from "../src/api/endpoints";
import { errorText } from "../src/api/errors";
import { activeFilterCount, CIS_AI_COUNTRIES, countryOptions, dateWindow, DEFAULT_FILTERS, filtersToQuery, localCountryLabel, queryKey, topCategory } from "../src/events/catalog";
import {
  formatEventDates,
  formatEventTime,
  formatFetched,
  formatMoney,
  hostOf,
  isAiwebProvider,
  lifecycleBasis,
  parseLocalDate,
  provenanceChipKey,
  provenanceDomain,
  relativeTime,
  sourceLabel,
  sourceLine,
} from "../src/events/format";
import { I18nProvider, translate, type Lang } from "../src/i18n";
import { categoryLabel } from "../src/state/directory";
import { navReducer, initialNav } from "../src/state/nav";
import { eventStartLink, parseStartParam } from "../src/tg";
import { countryName, EventCardView, EventMediaView, PriceLine, placeOf } from "../src/ui/EventCard";
import { RadioChips } from "../src/ui/RadioChips";
import { useState } from "react";

const NBSP = "\u00a0";
afterEach(cleanup);

const card = (o: Partial<EventCard> = {}): EventCard => ({
  event_id: "7d3c2b1a-0e9f-4a8b-8c7d-000000000001",
  title: "Formula 1 Abu Dhabi Grand Prix",
  categories: ["sport.motorsport", "sport"],
  is_past: false,
  start: { local_date: "2026-12-04", local_time: "17:00:00", utc: "2026-12-04T13:00:00Z", timezone: "Asia/Dubai" },
  end: { local_date: "2026-12-06", local_time: null, utc: null, timezone: "Asia/Dubai" },
  venue: { name: "Yas Marina Circuit", city: "Abu Dhabi", country_code: "AE" },
  online: false,
  lifecycle: { status: "ON_SALE", changed_at: "2026-10-10T03:42:00Z" },
  quality_score: 96,
  price_range: { min: "120.00", max: "950.00", currency: "USD", fetched_at: "2026-10-10T03:42:00Z", source: { provider: "ticketmaster", url: "https://www.ticketmaster.com/event/E1" } },
  media: {
    url: "https://s1.ticketm.net/dam/a/f1.jpg",
    width: 2048,
    height: 1152,
    ratio: "16_9",
    provenance: { provider: "ticketmaster", source_url: "https://www.ticketmaster.com/event/E1", fetched_at: "2026-10-10T03:42:00Z", rights: "provider_api" },
  },
  updated_at: "2026-10-10T03:42:00Z",
  ...o,
});

const wrap = (ui: React.ReactElement, lang: Lang = "ru") => render(<I18nProvider initial={lang}>{ui}</I18nProvider>);

describe("event formatting (Intl, event time zone)", () => {
  it("dates are the event's local calendar dates, never shifted by the viewer's zone", () => {
    const w = (d: string) => ({ local_date: d, local_time: null, utc: null, timezone: null });
    expect(formatEventDates(w("2026-12-04"), w("2026-12-06"), "ru")).toBe("4–6 дек. 2026");
    expect(formatEventDates(w("2026-12-04"), w("2026-12-06"), "en")).toBe("4–6 Dec 2026");
    expect(formatEventDates(w("2026-12-04"), null, "ru")).toBe("4 дек. 2026");
    expect(formatEventDates(w("2026-12-30"), w("2027-01-02"), "ru")).toBe("30 дек. 2026 – 2 янв. 2027");
    expect(formatEventDates(w("2026-12-04"), w("2026-12-04"), "en")).toBe("4 Dec 2026");
    expect(formatEventDates(w("2026-02-30"), null, "ru")).toBe("");
    expect(parseLocalDate("2026-13-01")).toBeNull();
  });

  it("start time is shown in the event's time zone; wall time when the zone is unknown", () => {
    expect(formatEventTime({ local_date: "2026-12-04", local_time: "17:00:00", utc: "2026-12-04T13:00:00Z", timezone: "Asia/Dubai" }, "ru")).toBe("17:00 GMT+4");
    expect(formatEventTime({ local_date: "2026-12-04", local_time: "17:00:00", utc: null, timezone: null }, "en")).toBe("17:00");
    expect(formatEventTime({ local_date: "2026-12-04", local_time: "20:30:00", utc: "2026-12-04T16:30:00Z", timezone: "Not/AZone" }, "en")).toBe("20:30");
    expect(formatEventTime({ local_date: "2026-12-04", local_time: null, utc: null, timezone: "Asia/Dubai" }, "ru")).toBeNull();
  });

  it("ticket prices: decimal strings in the provider's currency, no float maths, no conversion", () => {
    expect(formatMoney("120.00", "USD", "ru")).toBe(`120${NBSP}USD`);
    expect(formatMoney("1250.5", "EUR", "ru")).toBe(`1${NBSP}250,50${NBSP}EUR`);
    expect(formatMoney("1250.5", "EUR", "en")).toBe(`1,250.50${NBSP}EUR`);
    expect(formatMoney("150000.00", "UZS", "ru")).toBe(`150${NBSP}000${NBSP}UZS`);
    expect(formatMoney("12.345", "USD", "ru")).toBe("");
    expect(formatMoney("120", "usd", "ru")).toBe("");
  });

  it("host, relative and fetch time", () => {
    expect(hostOf("https://www.ticketmaster.com/event/E1")).toBe("ticketmaster.com");
    expect(hostOf("http://evil.example/")).toBe("");
    expect(hostOf("javascript:alert(1)")).toBe("");
    const now = Date.parse("2026-10-10T04:00:00Z");
    expect(relativeTime("2026-10-10T03:42:00Z", "ru", now)).toMatch(/^18 мин\.? назад$/);
    expect(relativeTime("2026-10-10T03:42:00Z", "en", now)).toMatch(/^18 min\.? ago$/);
    expect(relativeTime("2026-10-09T03:42:00Z", "ru", now)).toBe("вчера");
    expect(relativeTime("garbage", "ru", now)).toBe("");
    expect(formatFetched("2026-10-10T03:42:00Z", "ru")).toMatch(/^10\.10 \d\d:42$/);
  });
});

describe("catalogue filters → GET /v1/events query", () => {
  const today = new Date(2026, 9, 10, 9, 0);

  it("defaults: soonest, page of 20, nothing else", () => {
    expect(filtersToQuery(DEFAULT_FILTERS, today)).toEqual({ sort: "soonest", limit: 20 });
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
  });

  it("every filter maps to a contract parameter; the counter ignores the search text", () => {
    const f = { q: "  Formula   1 ", category: "sport.motorsport", countries: ["ae"], dates: "month" as const, hasTickets: true, format: "offline" as const, sort: "quality" as const };
    expect(filtersToQuery(f, today, "c2")).toEqual({
      q: "Formula 1",
      category: "sport.motorsport",
      country: "AE",
      date_from: "2026-10-10",
      date_to: "2026-10-31",
      has_tickets: "true",
      online: "false",
      sort: "quality",
      limit: 20,
      cursor: "c2",
    });
    expect(activeFilterCount(f)).toBe(6);
    expect(filtersToQuery({ ...DEFAULT_FILTERS, format: "online" }, today).online).toBe("true");
  });

  it("date windows; invalid values never reach the BFF; q is capped at 100", () => {
    expect(dateWindow("3", today)).toEqual(["2026-10-10", "2027-01-10"]);
    expect(dateWindow("12", today)).toEqual(["2026-10-10", "2027-10-10"]);
    expect(dateWindow("any", today)).toBeNull();
    const q = filtersToQuery({ ...DEFAULT_FILTERS, q: "x".repeat(300), category: "Sport!'", countries: ["UZB", "1A", ""] }, today);
    expect(q.q).toHaveLength(100);
    expect(q.category).toBeUndefined();
    expect(q.country).toBeUndefined();
  });

  it("query key ignores the cursor (pages of one search)", () => {
    expect(queryKey(filtersToQuery(DEFAULT_FILTERS, today, "a"))).toBe(queryKey(filtersToQuery(DEFAULT_FILTERS, today, "b")));
    expect(queryKey(filtersToQuery({ ...DEFAULT_FILTERS, q: "jazz" }, today))).not.toBe(queryKey(filtersToQuery(DEFAULT_FILTERS, today)));
  });

  it("type label: directory label of the main category, then its parent, then the bundled name", () => {
    const items = [
      { code: "sport", parent: null, label: { ru: "Спорт", en: "Sport" }, icon: "flag" },
      { code: "sport.motorsport", parent: "sport", label: { ru: "Автоспорт", en: "Motorsport" }, icon: "flag" },
    ];
    const fb = (top: string) => `fallback:${top}`;
    expect(categoryLabel(items, ["sport.motorsport", "sport"], "ru", fb)).toBe("Автоспорт");
    expect(categoryLabel(items, ["sport.cricket"], "en", fb)).toBe("Sport");
    expect(categoryLabel(null, ["music.jazz"], "ru", fb)).toBe("fallback:music");
    expect(topCategory([])).toBe("other");
  });
});

describe("deep links and navigation", () => {
  it("startapp=event_<uuid> opens the exact event; share link builds the same parameter", () => {
    const id = "7d3c2b1a-0e9f-4a8b-8c7d-000000000001";
    expect(parseStartParam(`event_${id.toUpperCase()}`)).toEqual({ kind: "event", id });
    expect(parseStartParam("event_not-a-uuid")).toBeNull();
    expect(parseStartParam("evt_f1_auh_2026")).toEqual({ kind: "tab", tab: "catalog" });
    expect(eventStartLink("@TilHeroBot", "", id)).toBe(`https://t.me/TilHeroBot?startapp=event_${id}`);
    expect(eventStartLink("TilHeroBot", "app", id)).toBe(`https://t.me/TilHeroBot/app?startapp=event_${id}`);
    expect(eventStartLink("TilHeroBot", "bad/name", id)).toBe(`https://t.me/TilHeroBot?startapp=event_${id}`);
  });

  it("event detail is pushed over the catalogue and popped by BackButton", () => {
    let s = navReducer(initialNav("catalog"), { type: "push", route: { name: "event", id: "a" } });
    expect(s.stack).toEqual([{ name: "catalog" }, { name: "event", id: "a" }]);
    expect(navReducer(s, { type: "push", route: { name: "event", id: "a" } })).toBe(s); // double tap
    s = navReducer(s, { type: "pop" });
    expect(s.stack).toEqual([{ name: "catalog" }]);
  });
});

describe("EventCard components", () => {
  it("source media: the image plus the provenance chip «Медиа: <domain of source_url>»", () => {
    wrap(<EventMediaView event={card()} />);
    expect(screen.getByTestId("media-source").querySelector("img")).toHaveAttribute("src", "https://s1.ticketm.net/dam/a/f1.jpg");
    expect(screen.getByTestId("prov-chip")).toHaveTextContent("Медиа: ticketmaster.com");
    expect(screen.queryByTestId("media-fallback")).toBeNull();
  });

  it("media = null → neutral category fallback with «Нет баннера у источника», no image (AT-25)", () => {
    wrap(<EventMediaView event={card({ media: null, categories: ["music.jazz", "music"] })} />);
    const fb = screen.getByTestId("media-fallback");
    expect(fb).toHaveAttribute("data-cat", "music");
    expect(fb.querySelector("img")).toBeNull();
    expect(screen.getByTestId("prov-chip")).toHaveTextContent("Нет баннера у источника");
  });

  it("narrow cards (list/grid) use the short fallback chip, full text in the tooltip", () => {
    wrap(<EventMediaView event={card({ media: null })} chip="short" />);
    expect(screen.getByTestId("prov-chip")).toHaveTextContent("без баннера");
    expect(screen.getByTestId("prov-chip")).toHaveAttribute("title", "Нет баннера у источника");
  });

  it("image fails to load → the same fallback (onerror); online events use the online ground", () => {
    wrap(<EventMediaView event={card({ online: true })} />);
    fireEvent.error(screen.getByTestId("media-source").querySelector("img")!);
    expect(screen.getByTestId("media-fallback")).toHaveAttribute("data-cat", "online");
    expect(screen.getByTestId("prov-chip")).toHaveTextContent("Нет баннера у источника");
  });

  it("card: type · city · dates, title, lifecycle badge, price fact, «Подробнее»; no score or trip price", async () => {
    const onOpen = vi.fn();
    wrap(<EventCardView event={card()} variant="large" typeLabel="Автоспорт" onOpen={onOpen} />);
    const el = screen.getByTestId("event-card");
    expect(el.querySelector(".ec-meta")).toHaveTextContent("Автоспорт · Abu Dhabi4–6 дек. 2026");
    expect(el.querySelector(".ec-t")).toHaveTextContent("Formula 1 Abu Dhabi Grand Prix");
    expect(screen.getByTestId("lifecycle")).toHaveTextContent("Продажи открыты");
    // sprint 4: the source is shown by name — «Ticketmaster», not the provider id
    expect(screen.getByTestId("price")).toHaveTextContent(/^Билеты от 120\sUSD Ticketmaster$/);
    expect(screen.getByTestId("price").querySelector(".kind")).toHaveTextContent("Ticketmaster");
    expect(el).not.toHaveTextContent(/%|Поездка|Следить/);
    await userEvent.click(screen.getByRole("button", { name: "Подробнее: Formula 1 Abu Dhabi Grand Prix" }));
    expect(onOpen).toHaveBeenCalledWith(card().event_id);
  });

  it("fix 5.1: a past event — «Событие прошло» in a neutral tone instead of the sales status (RU/EN)", () => {
    wrap(<EventCardView event={card({ is_past: true })} variant="large" typeLabel="Автоспорт" onOpen={() => {}} />);
    const badge = screen.getByTestId("lifecycle");
    expect(badge).toHaveTextContent("Событие прошло");
    expect(badge).toHaveAttribute("data-past", "true");
    expect(badge.closest(".badge")!.className).toBe("badge");
    expect(screen.getByTestId("event-card")).not.toHaveTextContent("Продажи открыты");
    cleanup();
    wrap(<EventCardView event={card({ is_past: true })} variant="compact" typeLabel="Motorsport" onOpen={() => {}} />, "en");
    expect(screen.getByTestId("lifecycle")).toHaveTextContent("Event is over");
    cleanup();
    wrap(<EventCardView event={card({ is_past: false })} variant="large" typeLabel="Автоспорт" onOpen={() => {}} />);
    expect(screen.getByTestId("lifecycle")).toHaveTextContent("Продажи открыты");
  });

  it("no price from the source → an honest line, not an invented price; online place", () => {
    wrap(<PriceLine price={null} />, "en");
    expect(screen.getByTestId("price")).toHaveTextContent(/^Price on the source website$/);
    expect(placeOf(card({ online: true, venue: null }), "en", "Online")).toBe("Online");
    expect(placeOf(card({ venue: { name: "X", city: "", country_code: "AE" } }), "en", "Online")).toBe("United Arab Emirates");
  });
});

describe("filter radio chips (roving tabindex)", () => {
  function Group() {
    const [v, setV] = useState<string>("any");
    return (
      <RadioChips
        label="Даты"
        value={v}
        onChange={setV}
        options={[
          { value: "any", label: "Любые" },
          { value: "month", label: "В этом месяце" },
          { value: "3", label: "3 месяца" },
        ]}
      />
    );
  }
  it("only the checked chip is tabbable; arrows move and select, Home/End jump", async () => {
    wrap(<Group />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    radios[0]!.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "В этом месяце" })).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "В этом месяце" }));
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "3 месяца" })).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowRight}"); // wraps around
    expect(screen.getByRole("radio", { name: "Любые" })).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "3 месяца" }));
  });
});

describe("API client: catalogue errors", () => {
  const session: SessionResponse = {
    access_token: "acc",
    expires_in: 900,
    refresh_token: "ref",
    user: { user_id: "u", display_name: "I", username: null, locale: "ru", status: "ACTIVE", is_new: false },
    security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null },
    consent: { accepted: true, policy_version: "1", current_policy_version: "1", accepted_at: null, evidence_hash: null, age_confirmed_18_plus: true },
    onboarding_completed: true,
  };
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("503 EVENTS_UNAVAILABLE is a screen state, not «Нет связи»; 503 of the BFF itself still is", async () => {
    let code = "EVENTS_UNAVAILABLE";
    const fetchImpl = (async (url: string) =>
      String(url).endsWith("/v1/session/telegram") ? res(200, session) : res(503, { code, message: code, trace_id: "t", details: {} })) as unknown as typeof fetch;
    const onConnectivity = vi.fn();
    const client = new ApiClient({ baseUrl: "https://bff.test", fetchImpl, storage: null, hooks: { onConnectivity }, lang: () => "ru" });
    await client.startSession("init");
    const api = createApi(client);
    const err = await api.events.list({ sort: "soonest", limit: 20 }).catch((e) => e);
    expect(err.code).toBe("EVENTS_UNAVAILABLE");
    expect(onConnectivity).toHaveBeenLastCalledWith(true);
    expect(errorText(err, (k, v) => translate("ru", k, v), String)).toBe("Каталог событий временно недоступен. Повторите через минуту");
    code = "SERVICE_UNAVAILABLE";
    await api.events.get("x").catch(() => undefined);
    expect(onConnectivity).toHaveBeenLastCalledWith(false);
  });

  it("query parameters go to GET /v1/events as given; the event id is path-encoded", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return String(url).endsWith("/v1/session/telegram") ? res(200, session) : res(200, { items: [], next_cursor: null });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "https://bff.test", fetchImpl, storage: null, lang: () => "ru" });
    await client.startSession("init");
    const api = createApi(client);
    await api.events.list({ q: "jazz bar", has_tickets: "true", sort: "quality", limit: 20, cursor: "c 1" });
    expect(urls.at(-1)).toBe("https://bff.test/v1/events?q=jazz+bar&has_tickets=true&sort=quality&limit=20&cursor=c+1");
    await api.events.get("../admin");
    expect(urls.at(-1)).toBe("https://bff.test/v1/events/..%2Fadmin");
  });
});

describe("styles: CSS layers and tokens only", () => {
  const dir = join(__dirname, "..", "src", "styles");
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokensDir = join(__dirname, "..", "..", "..", "packages", "ui-tokens", "styles");
  const tokenFiles = ["tokens.css", "base.css", "components.css", "layout.css", "telegram.css", ...readdirSync(join(tokensDir, "themes")).map((f) => join("themes", f))];
  const defined = new Set<string>();
  for (const f of tokenFiles) for (const m of strip(readFileSync(join(tokensDir, f), "utf8")).matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]!);

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".css"))) {
    const css = strip(readFileSync(join(dir, file), "utf8"));
    it(`${file}: no colour literals, only defined tokens, only ui-tokens layers`, () => {
      const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(|\b(?:white|black|red|blue|green|yellow|orange|purple|gray|grey)\b(?![-\w])/;
      css.split("\n").forEach((line, i) => expect(literal.test(line.replace(/--[a-z0-9-]+/gi, "")), `${file}:${i + 1} ${line.trim()}`).toBe(false));
      for (const m of css.matchAll(/var\((--[a-z0-9-]+)/gi)) expect(defined.has(m[1]!), `var(${m[1]}) is not defined`).toBe(true);
      for (const m of css.matchAll(/@layer\s+([a-z, ]+)\{/gi)) for (const l of m[1]!.split(",")) expect(["components", "layout"]).toContain(l.trim());
      // every rule lives inside a layer (unlayered CSS would beat the design system)
      expect(css.trim().startsWith("@layer")).toBe(true);
    });
  }

  it("no inline colours in TSX (style={{ … }} with colour values)", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        if (f.isDirectory()) walk(join(d, f.name));
        else if (/\.tsx$/.test(f.name)) files.push(join(d, f.name));
      }
    };
    walk(join(__dirname, "..", "src"));
    const bad = files.filter((f) => /style=\{\{[^}]*(?:#[0-9a-f]{3,8}|rgba?\(|color\s*:)/i.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});

describe("sprint 4: AI sources (aiweb.*) — source label, photo provenance, CIS countries", () => {
  const AI_URL = "https://www.iticket.uz/events/concerts/yulduz-usmonova";
  const aiCard = (o: Partial<EventCard> = {}): EventCard =>
    card({
      title: "Yulduz Usmonova. Anniversary Concert",
      categories: ["music.concerts", "music"],
      venue: { name: "Istiqlol Palace", city: "Tashkent", country_code: "UZ" },
      price_range: { min: "250000.00", max: "900000.00", currency: "UZS", fetched_at: "2026-10-10T01:00:00Z", source: { provider: "aiweb.iticket-uz", url: AI_URL } },
      media: {
        url: "https://cdn.iticket.az/event/poster/music.svg",
        width: null,
        height: null,
        ratio: null,
        provenance: { provider: "aiweb.iticket-uz", source_url: AI_URL, fetched_at: "2026-10-10T01:00:00Z", rights: "official_site" },
      },
      ...o,
    });

  it("aiweb provider id is recognised strictly (aiweb.<slug>)", () => {
    expect(isAiwebProvider("aiweb.iticket-uz")).toBe(true);
    expect(isAiwebProvider("aiweb.opera-ge")).toBe(true);
    for (const p of ["ticketmaster", "aiweb.", "aiweb.X", "aiweb.-bad", "xaiweb.iticket-uz", "aiweb.a", "", null, undefined]) expect(isAiwebProvider(p), String(p)).toBe(false);
  });

  it("source label: aiweb → page domain without www.; Ticketmaster → «Ticketmaster»; fallbacks", () => {
    expect(sourceLabel("aiweb.iticket-uz", AI_URL)).toBe("iticket.uz");
    expect(sourceLabel("aiweb.iticket-uz", AI_URL, "iTicket.uz")).toBe("iticket.uz"); // domain wins over the name
    expect(sourceLabel("aiweb.opera-ge", "https://opera.ge/en/events/swan-lake")).toBe("opera.ge");
    expect(sourceLabel("aiweb.kassir-kz", "https://WWW.Kassir.KZ/almaty/e/1")).toBe("kassir.kz");
    expect(sourceLabel("aiweb.iticket-uz", "http://www.iticket.uz/e", "iTicket.uz")).toBe("iTicket.uz"); // no https page → name
    expect(sourceLabel("aiweb.iticket-uz", null)).toBe("iticket-uz"); // nothing else → slug
    expect(sourceLabel("ticketmaster", "https://www.ticketmaster.com/event/E1")).toBe("Ticketmaster");
    expect(sourceLabel("ticketmaster", null, null)).toBe("Ticketmaster");
    expect(sourceLabel("abudhabigp", "https://www.abudhabigp.com/en/", null)).toBe("abudhabigp");
    expect(sourceLabel("fixture", null, "Fixture feed")).toBe("Fixture feed");
  });

  it("domain without www.: only the leading www. label is dropped", () => {
    expect(hostOf("https://www.iticket.uz/e/1")).toBe("iticket.uz");
    expect(hostOf("https://wwwiticket.uz/e/1")).toBe("wwwiticket.uz");
    expect(hostOf("https://cdn.www.iticket.uz/e/1")).toBe("cdn.www.iticket.uz");
    expect(hostOf("https://tkt.ge/event/1")).toBe("tkt.ge");
    expect(hostOf("javascript:alert(1)")).toBe("");
  });

  it("detail source line: registry name and domain; no repetition when the name is the domain", () => {
    expect(sourceLine({ provider: "aiweb.opera-ge", name: "Tbilisi Opera and Ballet Theatre", url: "https://opera.ge/en/events/swan-lake" })).toBe("Tbilisi Opera and Ballet Theatre · opera.ge");
    expect(sourceLine({ provider: "aiweb.iticket-uz", name: "iTicket.uz", url: AI_URL })).toBe("iTicket.uz");
    expect(sourceLine({ provider: "aiweb.iticket-uz", name: null, url: AI_URL })).toBe("iticket.uz");
    expect(sourceLine({ provider: "ticketmaster", name: "Ticketmaster", url: "https://www.ticketmaster.com/event/E1" })).toBe("Ticketmaster · ticketmaster.com");
    expect(sourceLine({ provider: "ticketmaster", name: null, url: "https://www.ticketmaster.com/event/E1" })).toBe("Ticketmaster · ticketmaster.com");
    expect(sourceLine({ provider: "abudhabigp", name: null, url: "https://www.abudhabigp.com/en/" })).toBe("abudhabigp · abudhabigp.com");
  });

  it("provenance chip key and domain: official_site → «Фото: …» / «Photo: …», provider_api → «Медиа: …» as before", () => {
    const prov = aiCard().media!.provenance;
    expect(provenanceChipKey("official_site")).toBe("media.site");
    expect(provenanceChipKey("provider_api")).toBe("media.src");
    expect(provenanceChipKey("official_organizer")).toBe("media.src");
    expect(provenanceDomain(prov)).toBe("iticket.uz");
    expect(provenanceDomain({ ...prov, source_url: "not a url" })).toBe("iticket-uz");
    expect(translate("ru", provenanceChipKey("official_site"), { d: "iticket.uz" })).toBe("Фото: iticket.uz");
    expect(translate("en", provenanceChipKey("official_site"), { d: "iticket.uz" })).toBe("Photo: iticket.uz");
    expect(translate("ru", provenanceChipKey("provider_api"), { d: "ticketmaster.com" })).toBe("Медиа: ticketmaster.com");
  });

  it("card of an aiweb event: «Фото: iticket.uz» chip (RU/EN), price mark by domain, hint names the official site", () => {
    wrap(<EventCardView event={aiCard()} variant="large" typeLabel="Концерты" onOpen={() => {}} />);
    const chip = screen.getByTestId("prov-chip");
    expect(chip).toHaveTextContent(/^Фото: iticket\.uz$/);
    expect(chip).toHaveAttribute("data-rights", "official_site");
    expect(chip.getAttribute("title")).toMatch(/^Фото с официального сайта iticket\.uz, получено /);
    expect(screen.getByTestId("price-src")).toHaveTextContent(/^iticket\.uz$/);
    expect(screen.getByTestId("event-card")).not.toHaveTextContent("aiweb");
    cleanup();
    wrap(<EventCardView event={aiCard()} variant="compact" typeLabel="Concerts" onOpen={() => {}} />, "en");
    expect(screen.getByTestId("prov-chip")).toHaveTextContent(/^Photo: iticket\.uz$/);
    cleanup();
    // narrow cards: the short chip is the domain itself
    wrap(<EventMediaView event={aiCard()} chip="short" />);
    expect(screen.getByTestId("prov-chip")).toHaveTextContent(/^iticket\.uz$/);
  });

  it("provider_api media keeps «Медиа: ticketmaster.com»; no banner → «Нет баннера у источника» for aiweb too", () => {
    wrap(<EventMediaView event={card()} />);
    expect(screen.getByTestId("prov-chip")).toHaveTextContent(/^Медиа: ticketmaster\.com$/);
    expect(screen.getByTestId("prov-chip")).toHaveAttribute("data-rights", "provider_api");
    cleanup();
    wrap(<EventMediaView event={aiCard({ media: null })} />);
    expect(screen.getByTestId("media-fallback")).toBeInTheDocument();
    expect(screen.getByTestId("prov-chip")).toHaveTextContent(/^Нет баннера у источника$/);
    expect(document.querySelector("img")).toBeNull();
  });

  it("lifecycle basis: «Проверено оператором по данным …», «Опубликовано на официальном сайте …», else «основание: …»", () => {
    const b = (fact: string, source_url: string | null, provider: string | null) => lifecycleBasis({ fact, source_url, provider });
    expect(b("staff_reviewed", "https://www.iticket.uz/events/1", "aiweb.iticket-uz")).toEqual({ key: "dt.life.staff", p: "iticket.uz" });
    expect(b("staff_reviewed", "https://www.ticketmaster.com/event/E1", "ticketmaster")).toEqual({ key: "dt.life.staff", p: "ticketmaster.com" });
    expect(b("staff_reviewed", null, "aiweb.opera-ge")).toEqual({ key: "dt.life.staff", p: "opera-ge" }); // no page → source label
    expect(b("listed_on_official_site", "https://opera.ge/en/events/swan-lake", "aiweb.opera-ge")).toEqual({ key: "dt.life.site", p: "opera.ge" });
    expect(b("provider_status", "https://www.ticketmaster.com/event/E1", "ticketmaster")).toEqual({ key: "dt.life.basis", p: "Ticketmaster" });
    expect(b("staff_reviewed", "javascript:alert(1)", null)).toEqual({ key: "dt.life.basis", p: "" }); // nothing to name → «TilHero»
    const at = { t: "3 ч назад" };
    expect(translate("ru", "dt.life.staff", { p: "iticket.uz", ...at })).toBe("Проверено оператором по данным iticket.uz · 3 ч назад");
    expect(translate("en", "dt.life.staff", { p: "iticket.uz", t: "3h ago" })).toBe("Verified by our team using iticket.uz · 3h ago");
    expect(translate("ru", "dt.life.site", { p: "opera.ge", ...at })).toBe("Опубликовано на официальном сайте opera.ge · 3 ч назад");
    expect(translate("en", "dt.life.site", { p: "opera.ge", t: "3h ago" })).toBe("Listed on the official site opera.ge · 3h ago");
  });

  it("price mark keeps the source's own spelling: «Ticketmaster», not «ticketmaster» (no text-transform on .kind)", () => {
    wrap(<PriceLine price={card().price_range} />);
    expect(screen.getByTestId("price-src")).toHaveTextContent(/^Ticketmaster$/);
    const css = readFileSync(join(__dirname, "..", "src", "styles", "events.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]*\.kind[^{}]*)\{([^}]*)\}/g)) expect(m[2], m[1]!.trim()).not.toMatch(/text-transform/);
  });

  it("CIS countries of the AI sources: RU/EN names from the dictionaries (Кыргызстан, not the ICU «Киргизия»)", () => {
    const names = (lang: Lang) => CIS_AI_COUNTRIES.map((c) => countryName(c, lang));
    expect(names("ru")).toEqual(["Узбекистан", "Казахстан", "Кыргызстан", "Азербайджан", "Грузия", "Армения"]);
    expect(names("en")).toEqual(["Uzbekistan", "Kazakhstan", "Kyrgyzstan", "Azerbaijan", "Georgia", "Armenia"]);
    expect(countryName("kg", "ru")).toBe("Кыргызстан");
    expect(localCountryLabel("AE")).toBeNull();
    expect(countryName("AE", "en")).toBe("United Arab Emirates"); // others still via Intl
    expect(placeOf(card({ venue: { name: "X", city: "", country_code: "KG" } }), "ru", "Online")).toBe("Кыргызстан");
  });

  it("country filter options: directory order and labels; missing CIS AI countries added first; empty labels filled; junk dropped", () => {
    const L = (ru: string, en: string) => ({ ru, en });
    const opts = countryOptions([
      { level: "world", code: null, label: L("Весь мир", "Worldwide") },
      { level: "region", code: "cis", label: L("СНГ", "CIS") },
      { level: "country", code: "UZ", label: L("Узбекистан", "Uzbekistan") },
      { level: "country", code: "kz", label: L("", "") },
      { level: "country", code: "AE", label: L("ОАЭ", "UAE") },
      { level: "country", code: "UZ", label: L("dup", "dup") },
      { level: "country", code: "UZB", label: L("bad", "bad") },
    ]);
    expect(opts.map((o) => o.code)).toEqual(["KG", "AZ", "GE", "AM", "UZ", "KZ", "AE"]);
    expect(opts.find((o) => o.code === "KZ")!.label).toEqual({ ru: "Казахстан", en: "Kazakhstan" });
    expect(opts.find((o) => o.code === "UZ")!.label).toEqual({ ru: "Узбекистан", en: "Uzbekistan" });
    expect(opts.find((o) => o.code === "AM")!.label).toEqual({ ru: "Армения", en: "Armenia" });
    // the directory is unavailable → the filter still offers the countries of the AI sources
    expect(countryOptions([]).map((o) => o.code)).toEqual([...CIS_AI_COUNTRIES]);
  });
});
