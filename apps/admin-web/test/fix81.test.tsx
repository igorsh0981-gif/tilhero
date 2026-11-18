import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewsSource, Permission, ProblemFeeds } from "@tilhero/contracts/admin";
import { NewsApi, OpsApi } from "../src/api/endpoints";
import { I18nProvider, type Lang } from "../src/i18n";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";
import { SessionCtx, type Session } from "../src/state/session";
import { ToastProvider } from "../src/ui/toasts";
import { FeedsPanel } from "../src/screens/monitoring/Providers";
import { FeedsPage, probeLabel } from "../src/screens/news/Feeds";
import { FEED_CODES, feedCodeLabel } from "../src/screens/news/news";

/* Fix 8.1: the exact reason of a failed feed collection reaches «Problem feeds»; feeds blocked by the site. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const session = (perms: Permission[]): Session => {
  const set = new Set(perms);
  return { me: null, can: (p) => set.has(p), canAny: (ps) => ps.some((p) => set.has(p)), refreshMe: async () => null, setMe: () => undefined, signOut: async () => undefined, reloadTheme: async () => undefined, themeVersion: null, adminLayout: null };
};
const ui = (node: ReactNode, lang: Lang = "ru") =>
  render(
    <I18nProvider initial={lang}>
      <SessionCtx.Provider value={session(["dashboard.read", "news.manage"])}>
        <ToastProvider>{node}</ToastProvider>
      </SessionCtx.Provider>
    </I18nProvider>,
  );

describe("feed error codes", () => {
  it("every known code has RU and EN labels", () => {
    for (const c of FEED_CODES) {
      expect(ru).toHaveProperty(`feed.code.${c}`);
      expect(en).toHaveProperty(`feed.code.${c}`);
    }
  });
  it("labels: known code → text, unknown → the code; probe falls back to feed codes", () => {
    const tRu = (k: keyof typeof ru) => ru[k];
    expect(feedCodeLabel(tRu as never, "FEED_HTTP_403")).toBe("Доступ запрещён сайтом (403, бот-защита)");
    expect(feedCodeLabel(tRu as never, "SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(probeLabel(tRu as never, "FEED_ROBOTS_DISALLOWED", false)).toBe("Запрещено robots.txt");
    expect(feedCodeLabel(tRu as never, "FEED_NO_HTTPS_LINKS")).toBe("Нет https-ссылок на домене источника");
  });
});

describe("problem feeds panel", () => {
  const feeds: ProblemFeeds = {
    available: true, checked_at: new Date().toISOString(), total: 2,
    items: [
      { source_id: "s1", slug: "finextra-headlines", name: "Finextra — Headlines", domain: "finextra.com", last_ok_at: null, last_error: { code: "FEED_HTTP_403", at: new Date().toISOString() }, kind: "media", country_code: null },
      { source_id: "s2", slug: "uefa-inside", name: "UEFA.com — Inside UEFA — News", domain: "uefa.com", last_ok_at: null, last_error: { code: "FEED_TIMEOUT", at: new Date().toISOString() }, kind: "official", country_code: null },
    ],
  } as ProblemFeeds;

  it("shows the reason text and code (RU)", async () => {
    vi.spyOn(OpsApi, "feeds").mockResolvedValue(feeds);
    ui(<FeedsPanel />);
    const rows = await screen.findAllByTestId("mon-feed-row");
    expect(rows[0]).toHaveTextContent("Доступ запрещён сайтом (403, бот-защита)");
    expect(rows[0]).toHaveTextContent("FEED_HTTP_403");
    expect(rows[0]).toHaveTextContent("finextra.com");
    expect(rows[1]).toHaveTextContent(ru["feed.code.FEED_TIMEOUT"]);
  });
  it("EN", async () => {
    vi.spyOn(OpsApi, "feeds").mockResolvedValue(feeds);
    ui(<FeedsPanel />, "en");
    const rows = await screen.findAllByTestId("mon-feed-row");
    expect(rows[0]).toHaveTextContent("Access denied by the site (403, bot protection)");
  });
});

describe("feeds page: blocked by the site", () => {
  it("state cell and summary show «the site blocks fetching»", async () => {
    const blocked: NewsSource = {
      source_id: "a6000000-0000-4000-8000-000000000009", slug: "uefa-inside", name: "UEFA.com — Inside UEFA — News", kind: "official", mode: "rss",
      feed_url: "https://www.uefa.com/rss/insideuefa/rss.xml", page_url: null, site_domain: "uefa.com", extra_domains: [], interests: ["sport.football"], entities: [],
      country_code: null, lang: "en", display: "summary", category_filter: null, enabled: false,
      health: { last_fetch_at: new Date().toISOString(), last_ok_at: null, last_error: { code: "FEED_ROBOTS_DISALLOWED", message: null, at: new Date().toISOString() }, items_24h: 0 },
      disabled_reason: "blocked", last_probe_at: null, last_probe_result: null, version: 3, updated_at: null,
    };
    vi.spyOn(NewsApi, "sources").mockResolvedValue({ items: [blocked], next_cursor: null });
    vi.spyOn(NewsApi, "source").mockResolvedValue(blocked);
    ui(<FeedsPage />);
    expect(await screen.findByTestId("feeds-summary")).toHaveTextContent("запрещено сайтом 1");
    expect(screen.getByTestId("feed-state-cell")).toHaveTextContent(ru["feed.reason.blocked"]);
  });
});
