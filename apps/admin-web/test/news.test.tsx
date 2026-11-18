import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewsAdminItem, NewsSource, NewsSourceCheck, Permission, WatchStats } from "@tilhero/contracts/admin";
import { NewsApi, WatchApi } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { I18nProvider, translate, type Lang } from "../src/i18n";
import { SessionCtx, type Session } from "../src/state/session";
import { ToastProvider } from "../src/ui/toasts";
import { FeedsPage } from "../src/screens/news/Feeds";
import { NewsPage } from "../src/screens/news/News";
import { WatchesPage } from "../src/screens/news/Watches";
import {
  checkInputFromForm,
  emptyFeedForm,
  formFromSource,
  healthState,
  inputFromForm,
  patchFromForm,
  suggestDomain,
  summaryFor,
  validateFeed,
  watchTotals,
} from "../src/screens/news/news";

/* Sprint 6: «News feeds», «News», «Watches» — helpers, rendering in RU/EN, commands with mocked admin-bff calls. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CYR = /[Ѐ-ӿ]/;
const apiErr = (status: number, code: string, details: Record<string, unknown> = {}) => new ApiError(status, { code, message: "x", trace_id: "t", details });
function session(perms: Permission[]): Session {
  const set = new Set(perms);
  return {
    me: null,
    can: (p) => set.has(p),
    canAny: (ps) => ps.some((p) => set.has(p)),
    refreshMe: async () => null,
    setMe: () => undefined,
    signOut: async () => undefined,
    reloadTheme: async () => undefined,
    themeVersion: null,
    adminLayout: null,
  };
}
const ui = (node: ReactNode, lang: Lang = "ru", perms: Permission[] = ["news.manage", "dashboard.read"]) =>
  render(
    <I18nProvider initial={lang}>
      <SessionCtx.Provider value={session(perms)}>
        <ToastProvider>{node}</ToastProvider>
      </SessionCtx.Provider>
    </I18nProvider>,
  );

const NOW = Date.parse("2026-10-11T10:00:00Z");
const src = (p: Partial<NewsSource> = {}): NewsSource => ({
  source_id: "a6000000-0000-4000-8000-000000000001",
  slug: "formula1-latest",
  name: "Formula 1 — Latest News",
  kind: "official",
  mode: "rss",
  feed_url: "https://www.formula1.com/en/latest/all.xml",
  page_url: null,
  site_domain: "formula1.com",
  extra_domains: [],
  interests: ["sport.motorsport"],
  entities: ["Formula 1"],
  country_code: null,
  lang: "en",
  display: "summary",
  category_filter: null,
  enabled: true,
  // relative to the real clock: a fixed time would turn the feed «late» (> 5 h without a fetch) later in the day
  health: { last_fetch_at: new Date(Date.now() - 40 * 60_000).toISOString(), last_ok_at: new Date(Date.now() - 40 * 60_000).toISOString(), last_error: null, items_24h: 7 },
  disabled_reason: null,
  last_probe_at: null,
  last_probe_result: null,
  version: 3,
  updated_at: "2026-10-11T07:00:00Z",
  ...p,
});
const item = (p: Partial<NewsAdminItem> = {}): NewsAdminItem => ({
  news_id: "b6000000-0000-4000-8000-000000000001",
  kind: "article",
  title: "Гран-при Абу-Даби: продажи открыты",
  summary_ru: "Организаторы открыли продажу билетов.",
  summary_en: "Tickets are on sale.",
  url: "https://www.formula1.com/en/latest/article/x.html",
  source: { source_id: "a6000000-0000-4000-8000-000000000001", name: "Formula 1", domain: "formula1.com" },
  published_at: "2026-10-11T06:00:00Z",
  collected_at: "2026-10-11T08:00:00Z",
  significance: 0.82,
  significance_level: "high",
  interests: ["sport.motorsport"],
  entities: ["Formula 1"],
  event_ids: ["e6000000-0000-4000-8000-000000000042"],
  hidden: false,
  hidden_reason: null,
  hidden_at: null,
  hidden_by: null,
  hidden_by_name: null,
  below_threshold: false,
  ...p,
});
const stats = (p: Partial<WatchStats> = {}): WatchStats => ({
  active: 128,
  paused: 9,
  ended_24h: 3,
  rechecks_24h: 412,
  changes_24h: { price_drop: 6, price_rise: 4, lifecycle: 2, tickets: 1, flight: 0, hotel: 0 },
  notifications_24h: { immediate: 2, digest: 6, suppressed: 1 },
  errors_24h: 5,
  next_batch_at: "2026-10-11T12:00:00Z",
  ...p,
});
const check = (p: Partial<NewsSourceCheck> = {}): NewsSourceCheck => ({
  ok: true,
  items: [
    { url: "https://www.formula1.com/a", title: "Новость A", published_at: "2026-10-11T06:00:00Z", dropped: null },
    { url: "https://www.formula1.com/b", title: "Новость B", published_at: null, dropped: "category_filter" },
  ],
  items_total: 10,
  errors: [],
  checked_at: "2026-10-11T09:00:00Z",
  ...p,
});

describe("helpers", () => {
  it("healthState: off, never, error newer than success, late (> 5 h), ok", () => {
    expect(healthState(src({ enabled: false }), NOW)).toBe("off");
    expect(healthState(src({ health: { last_fetch_at: null, last_ok_at: null, last_error: null, items_24h: 0 } }), NOW)).toBe("never");
    expect(healthState(src({ health: { last_fetch_at: "2026-10-11T09:00:00Z", last_ok_at: "2026-10-11T07:00:00Z", last_error: { code: "FEED_INVALID", message: null, at: "2026-10-11T09:00:00Z" }, items_24h: 0 } }), NOW)).toBe("error");
    // an older error followed by a success is history, not the state
    expect(healthState(src({ health: { last_fetch_at: "2026-10-11T09:00:00Z", last_ok_at: "2026-10-11T09:00:00Z", last_error: { code: "FEED_INVALID", message: null, at: "2026-10-11T05:00:00Z" }, items_24h: 3 } }), NOW)).toBe("ok");
    expect(healthState(src({ health: { last_fetch_at: "2026-10-11T03:00:00Z", last_ok_at: "2026-10-11T03:00:00Z", last_error: null, items_24h: 1 } }), NOW)).toBe("late");
    expect(healthState(src(), NOW)).toBe("ok");
  });

  it("validateFeed: slug, https, URL on the source domain or extra domains, interests, reason", () => {
    const f = { ...emptyFeedForm(), slug: "kun-uz", name: "Kun.uz", site_domain: "kun.uz", feed_url: "https://kun.uz/news/rss", interests: ["culture"], reason: "Лента" };
    expect(validateFeed(f, true)).toEqual({});
    expect(validateFeed({ ...f, slug: "Kun" }, true).slug).toBe("slug");
    expect(validateFeed({ ...f, feed_url: "http://kun.uz/rss" }, true).feed_url).toBe("https");
    expect(validateFeed({ ...f, feed_url: "https://kun.uz.evil.com/rss" }, true).feed_url).toBe("urlDomain");
    expect(validateFeed({ ...f, feed_url: "https://cdn.other.uz/rss", extra_domains: ["other.uz"] }, true)).toEqual({});
    expect(validateFeed({ ...f, mode: "html" }, true).page_url).toBe("pageUrl");
    expect(validateFeed({ ...f, interests: [] }, true).interests).toBe("interests");
    expect(validateFeed({ ...f, category_filter: "/a b/" }, true).category_filter).toBe("category");
    expect(validateFeed({ ...f, reason: "ab" }, true).reason).toBe("reason");
    expect(validateFeed({ ...f, reason: "" }, true, false)).toEqual({});
  });

  it("inputFromForm sends only the URL of the chosen mode; patchFromForm — only changed fields", () => {
    const f = { ...formFromSource(src()), page_url: "https://formula1.com/news" };
    expect(inputFromForm(f)).toMatchObject({ feed_url: "https://www.formula1.com/en/latest/all.xml", page_url: null, country_code: null, category_filter: null });
    expect(checkInputFromForm({ ...f, mode: "html" })).toMatchObject({ mode: "html", feed_url: null, page_url: "https://formula1.com/news" });
    const p = patchFromForm(src(), { ...formFromSource(src()), display: "title_only", interests: ["sport.motorsport", "sport.other"], reason: " права " });
    expect(p.body).toEqual({ expected_version: 3, interests: ["sport.motorsport", "sport.other"], display: "title_only", reason: "права" });
    expect(p.changed).toEqual(["interests", "display"]);
    expect(p.feedChanged).toBe(false);
    expect(patchFromForm(src(), { ...formFromSource(src()), category_filter: "/latest/" }).feedChanged).toBe(true);
    expect(patchFromForm(src(), formFromSource(src())).changed).toEqual([]);
  });

  it("suggestDomain, summaryFor, watchTotals", () => {
    expect(suggestDomain("https://www.uefa.com/rss/insideuefa/rss.xml")).toBe("uefa.com");
    expect(suggestDomain("https://feeds.bbci.co.uk/news/rss.xml")).toBe("bbci.co.uk");
    expect(suggestDomain("ftp://x")).toBeNull();
    expect(summaryFor(item(), "ru")).toBe("Организаторы открыли продажу билетов.");
    expect(summaryFor(item({ summary_en: null }), "en")).toBe("Организаторы открыли продажу билетов.");
    expect(summaryFor(item({ summary_ru: null, summary_en: null }), "ru")).toBeNull();
    expect(watchTotals(stats())).toEqual({ changes: 13, notified: 8, errorRate: 5 / 412 });
    expect(watchTotals(stats({ rechecks_24h: 0 })).errorRate).toBeNull();
  });
});

describe("«News feeds»", () => {
  it("table: kind, interests, international, display, health; interest filter goes to admin-bff", async () => {
    const list = vi.spyOn(NewsApi, "sources").mockResolvedValue({
      items: [
        src(),
        src({ source_id: "a6000000-0000-4000-8000-000000000002", slug: "kun-uz", name: "Kun.uz — Культура", kind: "media", country_code: "UZ", lang: "uz", display: "title_only", interests: ["culture", "culture.theatre", "festivals.city"], health: { last_fetch_at: "2026-10-11T09:00:00Z", last_ok_at: "2026-10-10T09:00:00Z", last_error: { code: "FEED_INVALID", message: "not xml", at: "2026-10-11T09:00:00Z" }, items_24h: 0 } }),
        src({ source_id: "a6000000-0000-4000-8000-000000000003", slug: "afisha-off", name: "Afisha", enabled: false }),
      ],
      next_cursor: null,
    });
    ui(<FeedsPage />);
    const table = await screen.findByTestId("feeds-table");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(4), { timeout: 3000 });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Официальный");
    expect(rows[0]).toHaveTextContent("Международный");
    expect(rows[0]).toHaveTextContent("Резюме");
    expect(rows[1]).toHaveTextContent("СМИ");
    expect(rows[1]).toHaveTextContent("Только заголовок");
    expect(rows[1]).toHaveTextContent("+1");
    expect(within(rows[1]!).getByTestId("feed-health-cell").firstElementChild).toHaveAttribute("data-health", "error");
    expect(rows[1]).toHaveTextContent("Не RSS / Atom");
    expect(within(rows[2]!).getByTestId("feed-health-cell").firstElementChild).toHaveAttribute("data-health", "off");
    expect(screen.getByTestId("feeds-summary")).toHaveTextContent("Включено 2 из 3");
    expect(screen.getByTestId("feeds-summary")).toHaveTextContent("1 лента с ошибкой");
    fireEvent.change(screen.getByTestId("feed-interest"), { target: { value: "culture.theatre" } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ interest: "culture.theatre" })), { timeout: 3000 });
  });

  it("new feed: «Check» before saving sends the form; saving an unchecked feed asks first; create carries the reason and a key", async () => {
    vi.spyOn(NewsApi, "sources").mockResolvedValue({ items: [], next_cursor: null });
    const chk = vi.spyOn(NewsApi, "check").mockResolvedValue(check());
    const create = vi.spyOn(NewsApi, "create").mockImplementation(async (b) => src({ ...b, source_id: "a6000000-0000-4000-8000-000000000009", version: 1 }));
    ui(<FeedsPage openId="new" />);
    await screen.findByTestId("feed-form");
    fireEvent.change(screen.getByTestId("ff-name"), { target: { value: "UEFA — Inside" } });
    fireEvent.change(screen.getByTestId("ff-slug"), { target: { value: "uefa-inside" } });
    fireEvent.change(screen.getByTestId("ff-url"), { target: { value: "https://www.uefa.com/rss/insideuefa/rss.xml" } });
    fireEvent.click(screen.getByTestId("ff-domain-suggest"));
    expect(screen.getByTestId("ff-domain")).toHaveValue("uefa.com");
    fireEvent.change(screen.getByTestId("ff-int-add"), { target: { value: "sport.football" } });
    fireEvent.change(screen.getByTestId("ff-reason"), { target: { value: "Официальная лента UEFA" } });

    fireEvent.click(screen.getByTestId("ff-submit"));
    expect(await screen.findByTestId("ff-unchecked")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ff-unchecked-check"));
    const res = await screen.findByTestId("ff-check-result");
    expect(chk).toHaveBeenCalledWith(null, { mode: "rss", feed_url: "https://www.uefa.com/rss/insideuefa/rss.xml", page_url: null, site_domain: "uefa.com", extra_domains: [], category_filter: null });
    expect(res).toHaveAttribute("data-ok", "true");
    expect(res).toHaveTextContent("подходят 1 из 10");
    expect(res).toHaveTextContent("не подходит под фильтр рубрики");

    fireEvent.click(screen.getByTestId("ff-submit"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [body, key] = create.mock.calls[0]!;
    expect(body).toMatchObject({ slug: "uefa-inside", site_domain: "uefa.com", interests: ["sport.football"], enabled: false, reason: "Официальная лента UEFA" });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("check: changing the feed after a check marks it stale; CHECK_UNAVAILABLE is a calm notice", async () => {
    vi.spyOn(NewsApi, "sources").mockResolvedValue({ items: [src()], next_cursor: null });
    vi.spyOn(NewsApi, "source").mockResolvedValue(src());
    const chk = vi.spyOn(NewsApi, "check").mockResolvedValueOnce(check()).mockRejectedValueOnce(apiErr(503, "CHECK_UNAVAILABLE", { service: "news" }));
    ui(<FeedsPage openId="a6000000-0000-4000-8000-000000000001" />);
    expect(await screen.findByTestId("feed-health")).toHaveAttribute("data-health", "ok");
    expect(screen.getByTestId("feed-items24")).toHaveTextContent("7");
    fireEvent.click(screen.getByTestId("ff-check-btn"));
    await screen.findByTestId("ff-check-result");
    expect(chk).toHaveBeenLastCalledWith("a6000000-0000-4000-8000-000000000001", undefined); // saved feed, unchanged
    fireEvent.change(screen.getByTestId("ff-cat"), { target: { value: "/latest/" } });
    expect(screen.getByTestId("ff-check-stale")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ff-check-btn"));
    expect(await screen.findByTestId("ff-check-error")).toHaveTextContent("Проверка ленты пока недоступна");
    expect(chk.mock.calls[1]![1]).toMatchObject({ category_filter: "/latest/" });
  });

  it("409 NEWS_SOURCE_VERSION_CONFLICT → conflict notice with «Reload»; read-only without news.manage", async () => {
    vi.spyOn(NewsApi, "sources").mockResolvedValue({ items: [src()], next_cursor: null });
    vi.spyOn(NewsApi, "source").mockResolvedValue(src());
    vi.spyOn(NewsApi, "patch").mockRejectedValue(apiErr(409, "NEWS_SOURCE_VERSION_CONFLICT", { current_version: 4 }));
    ui(<FeedsPage openId="a6000000-0000-4000-8000-000000000001" />);
    await screen.findByTestId("feed-form");
    fireEvent.click(screen.getByText("Только заголовок", { selector: "b" }));
    fireEvent.change(screen.getByTestId("ff-reason"), { target: { value: "Права издания" } });
    fireEvent.click(screen.getByTestId("ff-submit"));
    expect(await screen.findByTestId("feed-conflict")).toHaveTextContent("Ленту изменил другой сотрудник");
    cleanup();
    vi.spyOn(NewsApi, "source").mockResolvedValue(src());
    ui(<FeedsPage openId="a6000000-0000-4000-8000-000000000001" />, "ru", ["dashboard.read"]);
    await screen.findByTestId("feed-form");
    expect(screen.getByTestId("feed-form")).toHaveTextContent("Только просмотр");
    expect(screen.queryByTestId("ff-submit")).toBeNull();
  });

  it("FEATURE_UNAVAILABLE {service: news} names the missing service (RU and EN)", async () => {
    vi.spyOn(NewsApi, "sources").mockRejectedValue(apiErr(503, "FEATURE_UNAVAILABLE", { service: "news" }));
    ui(<FeedsPage />);
    expect(await screen.findByTestId("feeds-error")).toHaveTextContent("Новости ещё не подключены к админке");
    cleanup();
    ui(<FeedsPage />, "en");
    expect(await screen.findByTestId("feeds-error")).toHaveTextContent("News is not connected to the admin yet");
  });
});

describe("«News»", () => {
  it("rows: significance, kind, source, summary in the UI language, links; hide with a reason replaces the row", async () => {
    vi.spyOn(NewsApi, "sources").mockResolvedValue({ items: [src()], next_cursor: null });
    vi.spyOn(NewsApi, "items").mockResolvedValue({ items: [item(), item({ news_id: "b6000000-0000-4000-8000-000000000002", kind: "event_update", significance: 0.2, significance_level: "low", below_threshold: true, summary_ru: null, summary_en: null })], next_cursor: null });
    const hide = vi.spyOn(NewsApi, "hide").mockImplementation(async (id, reason) => item({ news_id: id, hidden: true, hidden_reason: reason, hidden_at: "2026-10-11T09:30:00Z", hidden_by: "7d0c2f43-58b5-4d0e-9f7e-2a8c7c1b9e11", hidden_by_name: "Тимур" }));
    ui(<NewsPage />);
    const rows = await screen.findAllByTestId("news-row");
    expect(rows[0]).toHaveTextContent("Важная");
    expect(rows[0]).toHaveTextContent("Formula 1 · formula1.com");
    expect(rows[0]).toHaveTextContent("Организаторы открыли продажу билетов.");
    expect(rows[0]).toHaveTextContent("Событий: 1");
    expect(within(rows[0]!).getByTestId("news-link")).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(rows[1]).toHaveTextContent("Изменение события");
    expect(rows[1]).toHaveTextContent("Ниже порога");
    expect(rows[1]).toHaveTextContent("Без резюме");

    fireEvent.click(within(rows[0]!).getByTestId("news-hide"));
    const dlg = await screen.findByTestId("news-confirm");
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "ab" } });
    fireEvent.click(within(dlg).getByTestId("confirm-ok"));
    expect(hide).not.toHaveBeenCalled(); // reason ≥ 3
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Реклама, а не новость" } });
    fireEvent.click(within(dlg).getByTestId("confirm-ok"));
    await waitFor(() => expect(hide).toHaveBeenCalledWith("b6000000-0000-4000-8000-000000000001", "Реклама, а не новость", expect.any(String)));
    const hidden = await screen.findByTestId("news-hidden");
    expect(hidden).toHaveTextContent("Скрыта: Тимур");
    expect(hidden).toHaveTextContent("Реклама, а не новость");
    expect(screen.getByTestId("news-unhide")).toBeInTheDocument();
  });

  it("«Hidden» filter asks admin-bff for hidden=true; EN shows no Russian interface text", async () => {
    vi.spyOn(NewsApi, "sources").mockResolvedValue({ items: [], next_cursor: null });
    const items = vi.spyOn(NewsApi, "items").mockResolvedValue({ items: [item({ title: "Abu Dhabi GP tickets", summary_ru: null })], next_cursor: null });
    ui(<NewsPage />, "en");
    await screen.findAllByTestId("news-row");
    fireEvent.click(screen.getByRole("button", { name: /Hidden/ }));
    await waitFor(() => expect(items).toHaveBeenLastCalledWith(expect.objectContaining({ hidden: "true" })));
    await screen.findAllByTestId("news-row");
    expect(CYR.test(screen.getByTestId("news").textContent ?? "")).toBe(false);
  });
});

describe("country filter", () => {
  it("«News»: country goes to admin-bff; filtered empty state resets every filter", async () => {
    vi.spyOn(NewsApi, "sources").mockResolvedValue({ items: [src(), src({ source_id: "a6000000-0000-4000-8000-000000000002", name: "Kun.uz", country_code: "UZ" })], next_cursor: null });
    const items = vi.spyOn(NewsApi, "items").mockImplementation(async (f) => ({ items: f.country ? [] : [item()], next_cursor: null }));
    ui(<NewsPage />);
    await screen.findAllByTestId("news-row");
    expect(screen.getByTestId("news-reset")).toBeDisabled();
    fireEvent.change(screen.getByTestId("news-country"), { target: { value: "UZ" } });
    await waitFor(() => expect(items).toHaveBeenLastCalledWith(expect.objectContaining({ country: "UZ" })), { timeout: 3000 });
    expect(await screen.findByTestId("news-empty-filtered")).toHaveTextContent("Нет новостей из лент этой страны");
    expect(within(screen.getByTestId("news-source")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Все источники", "Kun.uz"]);
    fireEvent.click(screen.getByTestId("news-empty-reset"));
    await waitFor(() => expect(items).toHaveBeenCalledTimes(3));
    expect(items.mock.calls.at(-1)![0]).toMatchObject({});
    for (const k of ["country", "source", "hidden"] as const) expect(items.mock.calls.at(-1)![0][k]).toBeUndefined();
    expect(await screen.findByTestId("news-row")).toBeInTheDocument();
    expect(screen.getByTestId("news-country")).toHaveValue("");
  });

  it("«News feeds»: country with no feeds → filtered empty state; reset clears it", async () => {
    const list = vi.spyOn(NewsApi, "sources").mockImplementation(async (f) => ({ items: f.country ? [] : [src()], next_cursor: null }));
    ui(<FeedsPage />);
    await screen.findByTestId("feeds-summary");
    fireEvent.change(screen.getByTestId("feed-country"), { target: { value: "KG" } });
    expect(await screen.findByTestId("feeds-empty-filtered")).toHaveTextContent("Нет лент этой страны");
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ country: "KG" }));
    fireEvent.click(screen.getByTestId("feeds-empty-reset"));
    await waitFor(() => expect(list.mock.calls.at(-1)![0].country).toBeUndefined());
    expect(await screen.findByTestId("feeds-summary")).toBeInTheDocument();
  });
});

describe("«Watches»", () => {
  it("KPI cards and breakdowns; error share tone", async () => {
    vi.spyOn(WatchApi, "stats").mockResolvedValue(stats({ errors_24h: 60 }));
    ui(<WatchesPage />);
    expect(await screen.findByTestId("wch-active")).toHaveTextContent("128");
    expect(screen.getByTestId("wch-active")).toHaveTextContent("на паузе: 9");
    expect(screen.getByTestId("wch-changes")).toHaveTextContent("13");
    expect(screen.getByTestId("wch-errors")).toHaveClass("is-bad"); // 60 / 412 ≥ 10 %
    const ch = screen.getByTestId("wch-changes-panel");
    expect(ch.querySelector('[data-change="price_drop"]')).toHaveTextContent("Снижение цены");
    expect(ch.querySelector('[data-change="flight"]')).toHaveClass("is-zero");
    expect(screen.getByTestId("wch-notify-panel").querySelector('[data-notify="digest"]')).toHaveTextContent("6");
  });

  it("FEATURE_UNAVAILABLE {service: watch} → the watch-specific notice; EN without Cyrillic", async () => {
    vi.spyOn(WatchApi, "stats").mockRejectedValue(apiErr(503, "FEATURE_UNAVAILABLE", { service: "watch" }));
    ui(<WatchesPage />);
    expect(await screen.findByTestId("wch-error")).toHaveTextContent(translate("ru", "err.FEATURE_UNAVAILABLE.watch"));
    cleanup();
    vi.spyOn(WatchApi, "stats").mockResolvedValue(stats());
    ui(<WatchesPage />, "en");
    await screen.findByTestId("wch-active");
    expect(CYR.test(screen.getByTestId("watches").textContent ?? "")).toBe(false);
  });
});
