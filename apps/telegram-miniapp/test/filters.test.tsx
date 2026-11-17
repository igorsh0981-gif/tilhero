/**
 * Fix 4.1: several countries, filters saved between launches (CloudStorage / localStorage), quick-chip counters
 * from GET /v1/events/facets, «Другое» for events without a category, source price/CTA texts.
 */
import type { EventCard, EventDetailView, EventFacets } from "@tilhero/contracts/bff";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api/client";
import { createApi, type Api, type EventsFacetsQuery, type EventsQuery } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import {
  activeFilterCount,
  cleanCountries,
  DEFAULT_FILTERS,
  filtersToFacetsQuery,
  filtersToQuery,
  MAX_COUNTRIES,
  monthWindow,
  parseSavedFilters,
  queryKey,
  serializeFilters,
} from "../src/events/catalog";
import { resetCatalogMemory } from "../src/events/memory";
import { forgetSavedFilters, loadSavedFilters, loadSavedFiltersWithin, persistFilters, resetSavedFiltersCache, SAVED_FILTERS_KEY } from "../src/events/saved";
import { I18nProvider, translate } from "../src/i18n";
import { Catalog } from "../src/screens/events/Catalog";
import { EventDetail } from "../src/screens/events/EventDetail";
import { AppContext, type AppCtx } from "../src/state/app";
import { resetDirectoryCache } from "../src/state/directory";
import { kvStore } from "../src/tg/storage";

const today = new Date(2026, 9, 10, 9, 0);
const LS_KEY = `tilhero:${SAVED_FILTERS_KEY}`;

// ---------------------------------------------------------------- fake Telegram CloudStorage

type TgWin = { Telegram?: unknown };
function installTelegram(version: string, cloud: Map<string, string> | "broken" | "silent" | null): void {
  const store = cloud instanceof Map ? cloud : null;
  const CloudStorage =
    cloud === null
      ? undefined
      : {
          getItem: (k: string, cb: (e: string | null, v?: string) => void) => {
            if (cloud === "silent") return;
            if (cloud === "broken") return cb("STORAGE_KEY_INVALID");
            setTimeout(() => cb(null, store!.get(k) ?? ""), 5);
          },
          setItem: (k: string, v: string, cb?: (e: string | null, ok?: boolean) => void) => {
            store?.set(k, v);
            cb?.(null, true);
          },
          removeItem: (k: string, cb?: (e: string | null, ok?: boolean) => void) => {
            store?.delete(k);
            cb?.(null, true);
          },
        };
  const cmp = (a: string, b: string) => {
    const x = a.split(".").map(Number);
    const y = b.split(".").map(Number);
    for (let i = 0; i < 2; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  const button = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of ["setParams", "onClick", "offClick", "show", "hide", "showProgress", "hideProgress", "enable", "disable"]) b[m] = () => b;
    return b;
  };
  (window as unknown as TgWin).Telegram = {
    WebApp: {
      initData: "query_id=x&hash=y",
      version,
      isVersionAtLeast: (v: string) => cmp(version, v) >= 0,
      CloudStorage,
      MainButton: button(),
      SecondaryButton: button(),
      BackButton: button(),
      onEvent: () => undefined,
      offEvent: () => undefined,
    },
  };
}

beforeEach(() => {
  resetCatalogMemory();
  resetDirectoryCache();
  resetSavedFiltersCache();
  localStorage.clear();
  delete (window as unknown as TgWin).Telegram;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------- pure

describe("several countries → query", () => {
  it("ISO-2 list, upper case, de-duplicated, sorted in the query, at most 20; each country counts in the badge", () => {
    const f = { ...DEFAULT_FILTERS, countries: ["uz", "KZ", "UZ", "UZB", "1A"] };
    expect(cleanCountries(f.countries)).toEqual(["UZ", "KZ"]);
    expect(filtersToQuery(f, today)).toEqual({ sort: "soonest", limit: 20, country: "KZ,UZ" });
    expect(activeFilterCount({ ...DEFAULT_FILTERS, countries: ["UZ", "KZ", "GE"] })).toBe(3);
    expect(activeFilterCount({ ...DEFAULT_FILTERS, countries: ["UZ", "KZ"], hasTickets: true })).toBe(3);
    const many = Array.from({ length: 30 }, (_, i) => `A${String.fromCharCode(65 + i % 26)}${i >= 26 ? "" : ""}`);
    expect(filtersToQuery({ ...DEFAULT_FILTERS, countries: many }, today).country!.split(",")).toHaveLength(MAX_COUNTRIES);
    // the same set in another click order → the same request
    expect(queryKey(filtersToQuery({ ...DEFAULT_FILTERS, countries: ["UZ", "KZ"] }, today))).toBe(queryKey(filtersToQuery({ ...DEFAULT_FILTERS, countries: ["KZ", "UZ"] }, today)));
  });

  it("facets query = the filters without sort/limit/cursor; category other passes", () => {
    const f = { ...DEFAULT_FILTERS, q: " jazz ", category: "other", countries: ["AZ"], dates: "month" as const, hasTickets: true, format: "online" as const, sort: "quality" as const };
    expect(filtersToFacetsQuery(f, today)).toEqual({ q: "jazz", category: "other", country: "AZ", date_from: "2026-10-10", date_to: "2026-10-31", has_tickets: "true", online: "true", month_from: "2026-10-10", month_to: "2026-10-31" });
    expect(filtersToQuery(f, today, "c")).toMatchObject({ category: "other", sort: "quality", cursor: "c" });
    // the counter window is a facets-only parameter: the search never gets it
    expect(filtersToQuery(f, today, "c")).not.toHaveProperty("month_from");
    expect(filtersToQuery(f, today, "c")).not.toHaveProperty("month_to");
  });

  it("saved filters: no search text; defaults → nothing saved; untrusted JSON is cleaned field by field", () => {
    expect(serializeFilters({ ...DEFAULT_FILTERS, q: "jazz" })).toBeNull();
    const raw = serializeFilters({ ...DEFAULT_FILTERS, q: "secret", countries: ["UZ", "KZ"], hasTickets: true, sort: "quality" })!;
    expect(raw).not.toContain("secret");
    expect(parseSavedFilters(raw)).toEqual({ category: null, countries: ["UZ", "KZ"], dates: "any", hasTickets: true, format: "any", sort: "quality" });
    expect(parseSavedFilters(JSON.stringify({ v: 1, category: "<b>", countries: ["UZ", 5, "uzb", "kz"], dates: "forever", hasTickets: "yes", format: "vr", sort: "price" }))).toEqual({
      category: null,
      countries: ["UZ", "KZ"],
      dates: "any",
      hasTickets: false,
      format: "any",
      sort: "soonest",
    });
    for (const bad of [null, "", "not json", "[]", JSON.stringify({ v: 2, countries: ["UZ"] }), "x".repeat(5000)]) expect(parseSavedFilters(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------- storage

describe("kv store: CloudStorage (6.9+) or localStorage", () => {
  it("outside Telegram → localStorage (prefixed key)", async () => {
    expect(kvStore().kind).toBe("local");
    await kvStore().set("k1", "v");
    expect(localStorage.getItem("tilhero:k1")).toBe("v");
    expect(await kvStore().get("k1")).toBe("v");
    await kvStore().remove("k1");
    expect(await kvStore().get("k1")).toBeNull();
  });

  it("Telegram 6.9+ with CloudStorage → cloud; older client or no CloudStorage → localStorage", async () => {
    const cloud = new Map<string, string>();
    installTelegram("8.0", cloud);
    expect(kvStore().kind).toBe("cloud");
    await kvStore().set("k2", "v2");
    expect(cloud.get("k2")).toBe("v2");
    expect(localStorage.getItem("tilhero:k2")).toBeNull();
    expect(await kvStore().get("k2")).toBe("v2");
    expect(await kvStore().get("missing")).toBeNull(); // CloudStorage answers "" for a missing key
    await kvStore().remove("k2");
    expect(cloud.has("k2")).toBe(false);
    installTelegram("6.7", new Map());
    expect(kvStore().kind).toBe("local");
    installTelegram("8.0", null);
    expect(kvStore().kind).toBe("local");
  });

  it("CloudStorage error → null; a client that never answers → null after the timeout; localStorage that throws → no crash", async () => {
    installTelegram("8.0", "broken");
    expect(await kvStore().get("k")).toBeNull();
    vi.useFakeTimers();
    installTelegram("8.0", "silent");
    const p = kvStore().get("k");
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toBeNull();
    vi.useRealTimers();
    delete (window as unknown as TgWin).Telegram;
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const spySet = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    expect(await kvStore().get("k")).toBeNull();
    await expect(kvStore().set("k", "v")).resolves.toBeUndefined();
    spy.mockRestore();
    spySet.mockRestore();
  });

  it("saved filters: persist → next launch reads them; defaults and «forget» remove the entry; same value not rewritten", async () => {
    const cloud = new Map<string, string>();
    installTelegram("8.0", cloud);
    const setSpy = vi.fn();
    const cs = (window as unknown as { Telegram: { WebApp: { CloudStorage: { setItem: (...a: unknown[]) => unknown } } } }).Telegram.WebApp.CloudStorage;
    const orig = cs.setItem;
    cs.setItem = (...a: unknown[]) => {
      setSpy(...a);
      return orig(...a);
    };
    persistFilters({ ...DEFAULT_FILTERS, countries: ["UZ", "KZ"] });
    persistFilters({ ...DEFAULT_FILTERS, countries: ["UZ", "KZ"], q: "typed" }); // only the text changed → no write
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(cloud.get(SAVED_FILTERS_KEY)!)).toMatchObject({ v: 1, countries: ["UZ", "KZ"] });
    resetSavedFiltersCache(); // new launch
    expect(await loadSavedFilters()).toMatchObject({ countries: ["UZ", "KZ"] });
    persistFilters(DEFAULT_FILTERS);
    expect(cloud.has(SAVED_FILTERS_KEY)).toBe(false);
    persistFilters({ ...DEFAULT_FILTERS, sort: "newest" });
    expect(cloud.has(SAVED_FILTERS_KEY)).toBe(true);
    forgetSavedFilters();
    expect(cloud.has(SAVED_FILTERS_KEY)).toBe(false);
  });

  it("slow CloudStorage (answers in 1.5 s): the catalogue starts with the defaults, the saved entry is NOT deleted", async () => {
    vi.useFakeTimers();
    const saved = JSON.stringify({ v: 1, countries: ["UZ", "KZ"] });
    const cloud = new Map<string, string>([[SAVED_FILTERS_KEY, saved]]);
    installTelegram("8.0", cloud);
    const cs = (window as unknown as { Telegram: { WebApp: { CloudStorage: { getItem: (k: string, cb: (e: string | null, v?: string) => void) => void } } } }).Telegram.WebApp.CloudStorage;
    cs.getItem = (k, cb) => void setTimeout(() => cb(null, cloud.get(k) ?? ""), 1500);
    const within = loadSavedFiltersWithin();
    await vi.advanceTimersByTimeAsync(1200);
    expect(await within).toBeNull(); // the wait is over → defaults
    persistFilters(DEFAULT_FILTERS); // what the catalogue does with the defaults
    expect(cloud.get(SAVED_FILTERS_KEY)).toBe(saved);
    await vi.advanceTimersByTimeAsync(400); // the store answers late
    expect(cloud.get(SAVED_FILTERS_KEY)).toBe(saved);
    resetSavedFiltersCache(); // next launch still gets them
    cs.getItem = (k, cb) => void setTimeout(() => cb(null, cloud.get(k) ?? ""), 5);
    const next = loadSavedFilters();
    await vi.advanceTimersByTimeAsync(10);
    expect(await next).toMatchObject({ countries: ["UZ", "KZ"] });
    // after the store answered, a return to the defaults by the user does remove the entry
    persistFilters({ ...DEFAULT_FILTERS, countries: ["UZ"] });
    persistFilters(DEFAULT_FILTERS);
    expect(cloud.has(SAVED_FILTERS_KEY)).toBe(false);
  });

  it("a real change before the store answered is saved and wins over the late answer", async () => {
    vi.useFakeTimers();
    const cloud = new Map<string, string>([[SAVED_FILTERS_KEY, JSON.stringify({ v: 1, countries: ["UZ"] })]]);
    installTelegram("8.0", cloud);
    const cs = (window as unknown as { Telegram: { WebApp: { CloudStorage: { getItem: (k: string, cb: (e: string | null, v?: string) => void) => void } } } }).Telegram.WebApp.CloudStorage;
    cs.getItem = (k, cb) => void setTimeout(() => cb(null, cloud.get(k) ?? ""), 1500);
    const load = loadSavedFilters();
    persistFilters({ ...DEFAULT_FILTERS, countries: ["GE"] });
    await vi.advanceTimersByTimeAsync(1600);
    expect(await load).toMatchObject({ countries: ["GE"] });
    expect(JSON.parse(cloud.get(SAVED_FILTERS_KEY)!)).toMatchObject({ countries: ["GE"] });
  });
});

// ---------------------------------------------------------------- Catalog screen

const ev = (n: number, title = `Event ${n}`, categories = ["music.jazz", "music"]): EventCard => ({
  event_id: `7d3c2b1a-0e9f-4a8b-8c7d-${String(n).padStart(12, "0")}`,
  title,
  categories,
  is_past: false,
  start: { local_date: "2026-11-01", local_time: null, utc: null, timezone: null },
  end: null,
  venue: { name: "Hall", city: "Tashkent", country_code: "UZ" },
  online: false,
  lifecycle: { status: "ON_SALE", changed_at: "2026-10-10T03:42:00Z" },
  quality_score: 50,
  price_range: null,
  media: null,
  updated_at: "2026-10-10T03:42:00Z",
});

const FACETS: EventFacets = { total: 12, this_month: 4, has_tickets: 0, online: 2, categories: { music: 9, sport: 0, other: 3 }, countries: { UZ: 8, KZ: 4 } };
const INTERESTS = [
  { code: "music", parent: null, label: { ru: "Музыка", en: "Music" }, icon: "music" },
  { code: "sport", parent: null, label: { ru: "Спорт", en: "Sport" }, icon: "flag" },
];

interface FCall {
  q: EventsFacetsQuery;
  resolve: (f: EventFacets) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
}

function setup(opts: { facets?: "manual" | "down" | EventFacets } = {}) {
  const lists: EventsQuery[] = [];
  const fcalls: FCall[] = [];
  const list = vi.fn(async (q: EventsQuery) => {
    lists.push(q);
    return { items: q.category === "other" ? [ev(7, "Тур «1 день 6 локаций»", [])] : [ev(1), ev(2)], next_cursor: null };
  });
  const facets = vi.fn((q: EventsFacetsQuery, signal?: AbortSignal) => {
    if (opts.facets === "down") return Promise.reject(new ApiError(503, "EVENTS_UNAVAILABLE", "down"));
    if (opts.facets && opts.facets !== "manual") return Promise.resolve(opts.facets);
    return new Promise<EventFacets>((resolve, reject) => {
      fcalls.push({ q, resolve, reject, signal });
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  });
  const api = {
    events: { list, get: vi.fn(), facets },
    directory: { interests: async () => ({ items: INTERESTS }), geographies: async () => ({ items: [] }) },
  } as unknown as Api;
  render(
    <I18nProvider initial="ru">
      <AppContext.Provider value={{ api, navigate: vi.fn() } as unknown as AppCtx}>
        <Catalog />
      </AppContext.Provider>
    </I18nProvider>,
  );
  return { lists, fcalls, facets, list };
}

const chip = (id: string) => screen.getByTestId(`qc-${id}`);

describe("Catalog: counters on the quick chips", () => {
  it("badge with the number; 0 → muted without a badge; «Другое» appears when other > 0; accessible count", async () => {
    setup({ facets: FACETS });
    await waitFor(() => expect(within(chip("month")).getByTestId("qc-count")).toHaveTextContent("4"));
    expect(within(chip("online")).getByTestId("qc-count")).toHaveTextContent("2");
    expect(chip("onsale")).toHaveClass("dim");
    expect(within(chip("onsale")).queryByTestId("qc-count")).toBeNull();
    expect(await screen.findByTestId("qc-music")).toHaveTextContent("Музыка9");
    expect(chip("sport")).toHaveClass("dim");
    expect(chip("other")).toHaveTextContent("Другое3");
    expect(chip("month")).toHaveAccessibleName("В этом месяце, 4 события");
    expect(chip("other")).toHaveAccessibleName("Другое, 3 события");
    expect(chip("online")).toHaveAccessibleName("Online, 2 события");
  });

  it("«Другое» → category=other; muted chips still work", async () => {
    const { lists } = setup({ facets: FACETS });
    await userEvent.click(await screen.findByTestId("qc-other"));
    await waitFor(() => expect(lists.at(-1)).toMatchObject({ category: "other" }));
    expect(await screen.findByText("Тур «1 день 6 локаций»")).toBeVisible();
    expect(chip("other")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(chip("onsale")); // dim, but tappable
    await waitFor(() => expect(lists.at(-1)).toMatchObject({ has_tickets: "true" }));
  });

  it("facets unavailable → plain chips without counters, no «Другое», the search works", async () => {
    const { lists } = setup({ facets: "down" });
    await waitFor(() => expect(lists.length).toBe(1));
    expect(await screen.findByTestId("qc-music")).toBeVisible();
    expect(screen.queryAllByTestId("qc-count")).toHaveLength(0);
    expect(document.querySelectorAll(".ct-qc.dim")).toHaveLength(0);
    expect(screen.queryByTestId("qc-other")).toBeNull();
    expect(chip("online")).toHaveAccessibleName("Online");
    expect(screen.getAllByTestId("event-card")).toHaveLength(2);
  });

  it("counters follow the filters: debounced, the outdated request is cancelled and its answer dropped", async () => {
    const { fcalls } = setup({ facets: "manual" });
    await waitFor(() => expect(fcalls).toHaveLength(1));
    expect(fcalls[0]!.q).toEqual({ month_from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), month_to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    await act(async () => fcalls[0]!.resolve(FACETS));
    await waitFor(() => expect(within(chip("online")).getByTestId("qc-count")).toHaveTextContent("2"));
    // two quick taps → one request for the final filters
    await userEvent.click(chip("online"));
    await userEvent.click(chip("month"));
    await waitFor(() => expect(fcalls).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 400));
    expect(fcalls).toHaveLength(2);
    expect(fcalls[1]!.q).toMatchObject({ online: "true", date_from: expect.any(String) });
    // a filter change while it loads → aborted; the late answer never lands
    await userEvent.click(chip("month"));
    await waitFor(() => expect(fcalls[1]!.signal?.aborted).toBe(true));
    await act(async () => fcalls[1]!.resolve({ ...FACETS, online: 77 }));
    await waitFor(() => expect(fcalls).toHaveLength(3));
    await act(async () => fcalls[2]!.resolve({ ...FACETS, online: 5 }));
    await waitFor(() => expect(within(chip("online")).getByTestId("qc-count")).toHaveTextContent("5"));
    // failure → counters disappear
    await userEvent.click(chip("online"));
    await waitFor(() => expect(fcalls).toHaveLength(4));
    await act(async () => fcalls[3]!.reject(new ApiError(503, "EVENTS_UNAVAILABLE", "down")));
    await waitFor(() => expect(screen.queryAllByTestId("qc-count")).toHaveLength(0));
  });
});

describe("Catalog: several countries with saving", () => {
  it("sheet: pick several, «Любая» clears; tags with ×; badge counts them; saved; next launch restores; «Сбросить» forgets", async () => {
    const cloud = new Map<string, string>();
    installTelegram("8.0", cloud);
    const { lists } = setup({ facets: FACETS });
    await waitFor(() => expect(lists).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: /^Фильтры/ }));
    const group = screen.getByRole("group", { name: "Выбор стран" });
    await userEvent.click(within(group).getByRole("button", { name: "Узбекистан" }));
    await userEvent.click(within(group).getByRole("button", { name: "Казахстан" }));
    expect(within(group).getByRole("button", { name: "Любая" })).toHaveAttribute("aria-pressed", "false");
    const tags = screen.getByTestId("f-countries");
    expect(within(tags).getAllByText(/./).map((x) => x.textContent)).toEqual(["Узбекистан", "Казахстан"]);
    await userEvent.click(within(group).getByRole("button", { name: "Любая" }));
    expect(screen.queryByTestId("f-countries")).toBeNull();
    await userEvent.click(within(group).getByRole("button", { name: "Узбекистан" }));
    await userEvent.click(within(group).getByRole("button", { name: "Кыргызстан" }));
    await userEvent.click(within(group).getByRole("button", { name: "Грузия" }));
    await userEvent.click(within(screen.getByTestId("f-countries")).getByRole("button", { name: "Удалить Кыргызстан" }));
    await userEvent.click(screen.getByTestId("f-apply"));
    await waitFor(() => expect(lists.at(-1)).toMatchObject({ country: "GE,UZ" }));
    expect(screen.getByTestId("ct-filter-count")).toHaveTextContent("2");
    expect(within(screen.getByTestId("ct-countries")).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Удалить Узбекистан", "Удалить Грузия"]);
    await waitFor(() => expect(JSON.parse(cloud.get(SAVED_FILTERS_KEY) ?? "{}")).toMatchObject({ countries: ["UZ", "GE"] }));
    expect(localStorage.getItem(LS_KEY)).toBeNull(); // CloudStorage, not localStorage

    // × under the toolbar removes a country at once
    await userEvent.click(screen.getByRole("button", { name: "Удалить Грузия" }));
    await waitFor(() => expect(lists.at(-1)).toMatchObject({ country: "UZ" }));
    expect(screen.getByTestId("ct-filter-count")).toHaveTextContent("1");
    await waitFor(() => expect(JSON.parse(cloud.get(SAVED_FILTERS_KEY)!).countries).toEqual(["UZ"]));

    // next launch: the first request already has the saved countries
    cleanup();
    resetCatalogMemory();
    resetSavedFiltersCache();
    const next = setup({ facets: FACETS });
    await waitFor(() => expect(next.lists.length).toBeGreaterThan(0));
    expect(next.lists[0]).toMatchObject({ country: "UZ" });
    expect(next.lists).toHaveLength(1);
    expect(screen.getByTestId("ct-filter-count")).toHaveTextContent("1");

    // «Сбросить» → «Применить» forgets the saved filters («Сбросить» alone only resets the draft)
    await userEvent.click(screen.getByRole("button", { name: /^Фильтры/ }));
    await userEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(cloud.has(SAVED_FILTERS_KEY)).toBe(true);
    await userEvent.click(screen.getByTestId("f-apply"));
    await waitFor(() => expect(next.lists.at(-1)!.country).toBeUndefined());
    expect(screen.queryByTestId("ct-filter-count")).toBeNull();
    expect(cloud.has(SAVED_FILTERS_KEY)).toBe(false);
  });

  it("«Сбросить» → close the sheet without «Применить»: the applied filters and the saved entry stay", async () => {
    const cloud = new Map<string, string>([[SAVED_FILTERS_KEY, JSON.stringify({ v: 1, countries: ["UZ", "KZ"], hasTickets: true })]]);
    installTelegram("8.0", cloud);
    const { lists } = setup({ facets: FACETS });
    await waitFor(() => expect(lists).toHaveLength(1));
    expect(lists[0]).toMatchObject({ country: "KZ,UZ", has_tickets: "true" });
    expect(screen.getByTestId("ct-filter-count")).toHaveTextContent("3");
    const saved = cloud.get(SAVED_FILTERS_KEY);

    await userEvent.click(screen.getByRole("button", { name: /^Фильтры/ }));
    await userEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(screen.queryByTestId("f-countries")).toBeNull(); // the draft is reset
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("f-apply")).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(cloud.get(SAVED_FILTERS_KEY)).toBe(saved);
    expect(screen.getByTestId("ct-filter-count")).toHaveTextContent("3");
    expect(lists).toHaveLength(1); // no new search: the applied filters did not change

    // the next launch still restores them
    cleanup();
    resetCatalogMemory();
    resetSavedFiltersCache();
    const next = setup({ facets: FACETS });
    await waitFor(() => expect(next.lists).toHaveLength(1));
    expect(next.lists[0]).toMatchObject({ country: "KZ,UZ", has_tickets: "true" });
  });

  it("localStorage: «Сбросить» alone keeps the entry, «Сбросить» → «Применить» removes it", async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, countries: ["KZ"] }));
    const { lists } = setup({ facets: FACETS });
    await waitFor(() => expect(lists).toHaveLength(1));
    expect(lists[0]).toMatchObject({ country: "KZ" });
    await userEvent.click(screen.getByRole("button", { name: /^Фильтры/ }));
    await userEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(localStorage.getItem(LS_KEY)).not.toBeNull();
    await userEvent.click(screen.getByTestId("f-apply"));
    await waitFor(() => expect(localStorage.getItem(LS_KEY)).toBeNull());
  });

  it("without CloudStorage the filters go to localStorage; a silent store does not block the search for long", async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, countries: ["KZ"], hasTickets: true }));
    const { lists } = setup({ facets: FACETS });
    await waitFor(() => expect(lists).toHaveLength(1));
    expect(lists[0]).toMatchObject({ country: "KZ", has_tickets: "true" });
    expect(screen.getByTestId("ct-filter-count")).toHaveTextContent("2");

    cleanup();
    resetCatalogMemory();
    resetSavedFiltersCache();
    installTelegram("8.0", "silent");
    const t0 = Date.now();
    const s = setup({ facets: FACETS });
    await waitFor(() => expect(s.lists).toHaveLength(1), { timeout: 3000 });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(s.lists[0]!.country).toBeUndefined();
  });

  it("at most 20 countries: the rest are disabled with a hint", async () => {
    const geos = Array.from({ length: 25 }, (_, i) => ({ level: "country" as const, code: `Q${String.fromCharCode(65 + i)}`, label: { ru: `Страна ${i}`, en: `Country ${i}` } }));
    const api = {
      events: { list: vi.fn(async () => ({ items: [], next_cursor: null })), get: vi.fn(), facets: vi.fn(async () => FACETS) },
      directory: { interests: async () => ({ items: [] }), geographies: async () => ({ items: geos }) },
    } as unknown as Api;
    render(
      <I18nProvider initial="ru">
        <AppContext.Provider value={{ api, navigate: vi.fn() } as unknown as AppCtx}>
          <Catalog />
        </AppContext.Provider>
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /^Фильтры/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Все страны/ }));
    const group = screen.getByRole("group", { name: "Выбор стран" });
    const buttons = within(group).getAllByRole("button").slice(1);
    for (const b of buttons.slice(0, 20)) await userEvent.click(b);
    expect(screen.getByText("Можно выбрать до 20 стран")).toBeVisible();
    expect(buttons.slice(20).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(buttons[0]).toBeEnabled(); // a picked one can still be removed
  });
});

// ---------------------------------------------------------------- texts

const detail = (status: EventDetailView["lifecycle"]["status"]): EventDetailView => ({
  ...ev(1, "Formula 1", []),
  venue: { name: "Yas", city: "Abu Dhabi", country_code: "AE", address: null, lat: null, lon: null, map_url: "https://maps.example.com/x" },
  official_url: "https://www.ticketmaster.com/event/abc",
  sources: [{ provider: "ticketmaster", name: "Ticketmaster", tier: "OFFICIAL_TICKET_PROVIDER", url: "https://www.ticketmaster.com/event/abc", fetched_at: "2026-10-10T03:42:00Z" }],
  lifecycle: { status, changed_at: "2026-10-10T03:42:00Z", basis: { fact: "provider_status", source_url: null, provider: "ticketmaster", observed_at: "2026-10-10T03:42:00Z" } },
  lifecycle_track: [],
  media_all: [],
  first_seen_at: "2026-10-01T00:00:00Z",
  recommendation: null,
  watch: null,
  reaction: null,
});

function renderDetail(d: EventDetailView, lang: "ru" | "en" = "ru") {
  const api = { events: { get: vi.fn(async () => d) }, directory: { interests: async () => ({ items: [] }) } } as unknown as Api;
  return render(
    <I18nProvider initial={lang}>
      <AppContext.Provider value={{ api, navigate: vi.fn() } as unknown as AppCtx}>
        <EventDetail id={d.event_id} />
      </AppContext.Provider>
    </I18nProvider>,
  );
}

describe("texts (fix 4.1)", () => {
  it.each([
    ["ON_SALE", "Купить билеты у источника", "Buy tickets from the source"],
    ["LOW_INVENTORY", "Купить билеты у источника", "Buy tickets from the source"],
    ["RESALE", "Купить билеты у источника", "Buy tickets from the source"],
    ["ANNOUNCED", "Подробнее у источника", "Details at the source"],
    ["SALES_SOON", "Подробнее у источника", "Details at the source"],
    ["SOLD_OUT", "Подробнее у источника", "Details at the source"],
    ["POSTPONED", "Подробнее у источника", "Details at the source"],
  ] as const)("detail CTA for %s", async (status, ru, en) => {
    renderDetail(detail(status));
    const b = await screen.findByTestId("dt-official");
    expect(b).toHaveTextContent(ru);
    expect(b).toHaveAccessibleName(`${ru} ticketmaster.com`);
    cleanup();
    renderDetail(detail(status), "en");
    expect(await screen.findByTestId("dt-official")).toHaveTextContent(en);
  });

  it("no price → «Цена — на сайте источника»; no category → «Другое»", async () => {
    renderDetail(detail("ON_SALE"));
    expect(await screen.findByTestId("dt-price")).toHaveTextContent("Цена — на сайте источника");
    expect(screen.getByTestId("event-detail")).toHaveTextContent("КатегорияДругое");
    expect(screen.getByTestId("event-detail")).not.toHaveTextContent("Событие");
    expect(translate("en", "ev.price.none")).toBe("Price on the source website");
    expect(translate("en", "cat.other")).toBe("Other");
  });
});

// ---------------------------------------------------------------- «В этом месяце»: counter window = chip window

/** Runs `fn` with the process time zone set to `tz` (Node re-reads TZ on change), then restores it. */
async function inTimeZone<T>(tz: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

const chipWindow = (q: EventsQuery) => [q.date_from, q.date_to];
const counterWindow = (q: EventsFacetsQuery) => [q.month_from, q.month_to];

describe("«В этом месяце»: facets month_from/month_to = the chip's date window", () => {
  it.each([
    // [time zone, local Y, M (0-based), D, h, m, expected local window, UTC date at that moment]
    ["America/New_York", 2026, 9, 31, 23, 30, ["2026-10-31", "2026-10-31"], "2026-11-01"], // 31st 23:30, UTC already next month
    ["Asia/Tashkent", 2026, 10, 1, 2, 0, ["2026-11-01", "2026-11-30"], "2026-10-31"], // 1st 02:00, UTC still last month
    ["Asia/Tashkent", 2026, 9, 31, 23, 30, ["2026-10-31", "2026-10-31"], "2026-10-31"],
    ["Pacific/Kiritimati", 2027, 1, 28, 23, 30, ["2027-02-28", "2027-02-28"], "2027-02-28"], // UTC+14, February
    ["UTC", 2028, 1, 29, 0, 0, ["2028-02-29", "2028-02-29"], "2028-02-29"], // leap day
  ] as const)("%s %i-%i-%i %i:%i local", async (tz, y, mo, d, h, mi, expected, utcDate) => {
    await inTimeZone(tz, () => {
      const now = new Date(y, mo, d, h, mi);
      expect(now.toISOString().slice(0, 10)).toBe(utcDate);
      expect(monthWindow(now)).toEqual(expected);
      const f = { ...DEFAULT_FILTERS, countries: ["UZ"], hasTickets: true };
      const facets = filtersToFacetsQuery(f, now);
      const search = filtersToQuery({ ...f, dates: "month" }, now);
      expect(counterWindow(facets)).toEqual(chipWindow(search));
      expect(counterWindow(facets)).toEqual(expected);
      // the other filters are the same in both requests
      const { month_from: _a, month_to: _b, ...facetFilters } = facets;
      const { sort: _s, limit: _l, date_from: _c, date_to: _d, ...searchFilters } = search;
      expect(facetFilters).toEqual(searchFilters);
    });
  });

  it("the window is sent whatever date filter is active (this_month ignores date_from/date_to)", () => {
    for (const dates of ["any", "month", "3", "12"] as const) {
      const q = filtersToFacetsQuery({ ...DEFAULT_FILTERS, dates }, today);
      expect(counterWindow(q)).toEqual(["2026-10-10", "2026-10-31"]);
    }
  });

  it("Catalog at 31st 23:30 local: the counter request and the search after tapping the chip use one window", async () => {
    await inTimeZone("America/New_York", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 31, 23, 30) });
      const { lists, facets } = setup({ facets: FACETS });
      await waitFor(() => expect(within(chip("month")).getByTestId("qc-count")).toHaveTextContent("4"));
      const counted = facets.mock.calls.at(-1)![0];
      expect(counterWindow(counted)).toEqual(["2026-10-31", "2026-10-31"]);
      await userEvent.click(chip("month"));
      await waitFor(() => expect(lists.at(-1)).toMatchObject({ date_from: "2026-10-31" }));
      expect(chipWindow(lists.at(-1)!)).toEqual(counterWindow(counted));
      // the search itself never carries the counter window
      expect(lists.every((q) => !("month_from" in q) && !("month_to" in q))).toBe(true);
      await waitFor(() => expect(facets.mock.calls.length).toBeGreaterThan(1));
      expect(counterWindow(facets.mock.calls.at(-1)![0])).toEqual(["2026-10-31", "2026-10-31"]);
    });
  });
});

// ---------------------------------------------------------------- logout clears the saved filters

describe("logout forgets the saved catalogue filters (another session on this device must not inherit them)", () => {
  const apiWith = (status: number) => {
    const fetchImpl = vi.fn(async () => new Response(status === 204 ? null : JSON.stringify({ code: "INTERNAL_ERROR", message: "x", trace_id: "t", details: {} }), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    return { api: createApi(new ApiClient({ baseUrl: "https://bff.test", fetchImpl, storage: null, lang: () => "ru" })), fetchImpl };
  };
  const saveSome = async () => {
    await loadSavedFilters();
    persistFilters({ ...DEFAULT_FILTERS, countries: ["UZ"], hasTickets: true });
  };

  it.each([
    ["successful logout (204)", 204],
    ["failed logout (500) — the .finally branch still forgets", 500],
    ["failed logout (401)", 401],
  ] as const)("localStorage: %s", async (_name, status) => {
    await saveSome();
    expect(localStorage.getItem(LS_KEY)).toContain('"UZ"');
    const { api, fetchImpl } = apiWith(status);
    const done = api.session.logout();
    if (status === 204) await done;
    else await expect(done).rejects.toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledWith("https://bff.test/v1/session/logout", expect.objectContaining({ method: "POST" }));
    expect(localStorage.getItem(LS_KEY)).toBeNull();
    // the in-memory copy is forgotten too: a catalogue opened in the same launch starts with the defaults
    expect(await loadSavedFilters()).toBeNull();
  });

  it.each([204, 503] as const)("Telegram CloudStorage: logout with %i removes the entry", async (status) => {
    const cloud = new Map<string, string>();
    installTelegram("8.0", cloud);
    await saveSome();
    await waitFor(() => expect(cloud.has(SAVED_FILTERS_KEY)).toBe(true));
    const { api } = apiWith(status);
    await api.session.logout().catch(() => undefined);
    await waitFor(() => expect(cloud.has(SAVED_FILTERS_KEY)).toBe(false));
  });
});
