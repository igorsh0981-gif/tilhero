import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiBudget, AiLimits, NewsSource, Permission } from "@tilhero/contracts/admin";
import { DiscoveryApi, NewsApi } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { I18nProvider, type Lang } from "../src/i18n";
import { ru } from "../src/i18n/ru";
import { SessionCtx, type Session } from "../src/state/session";
import { ToastProvider } from "../src/ui/toasts";
import { LimitsPanel } from "../src/screens/discovery/Limits";
import { belowUsed, changedLimits, cents, cleanMoney, formFromLimits, isDefault, validateLimits, valuesFromForm } from "../src/screens/discovery/limits";
import { FeedsPage, probeLabel } from "../src/screens/news/Feeds";

/* Fix 6.1: AI limits block and the auto-check of news feeds. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const session = (perms: Permission[]): Session => {
  const set = new Set(perms);
  return { me: null, can: (p) => set.has(p), canAny: (ps) => ps.some((p) => set.has(p)), refreshMe: async () => null, setMe: () => undefined, signOut: async () => undefined, reloadTheme: async () => undefined, themeVersion: null, adminLayout: null };
};
const ui = (node: ReactNode, perms: Permission[] = ["discovery.manage", "ops.kill_switch", "news.manage"], lang: Lang = "ru") =>
  render(
    <I18nProvider initial={lang}>
      <SessionCtx.Provider value={session(perms)}>
        <ToastProvider>{node}</ToastProvider>
      </SessionCtx.Provider>
    </I18nProvider>,
  );
const tRu = (k: keyof typeof ru) => ru[k];

const defaults = { ai_daily_usd: "1.00", news_daily_usd: "0.20", pages_daily: 300, concierge_daily_usd: "1.00", evaluation_daily_usd: "0.30" };
const lim = (p: Partial<AiLimits> = {}): AiLimits => ({ ...defaults, source: "env", updated_by: null, updated_by_name: null, updated_at: null, reason: null, defaults, ...p });
const budget: AiBudget = { day: "2026-10-12", spent_usd: "0.4213", reserved_usd: "0.0100", budget_usd: "1.00", pages_used: 71, pages_limit: 300, paused: null, model: "claude-haiku-4-5", news: { spent_usd: "0.0312", budget_usd: "0.20" } };

describe("limits helpers", () => {
  it("money input: comma, cents, bounds, news ≤ ai, pages", () => {
    expect(cleanMoney(" 2,5 ")).toBe("2.5");
    expect([cents("2"), cents("2.5"), cents("2,50"), cents("0.05"), cents("2.555"), cents("1e1"), cents("-1")]).toEqual([200, 250, 250, 5, null, null, null]);
    const f = formFromLimits(defaults);
    expect(validateLimits(f)).toEqual({});
    expect(validateLimits({ ...f, ai: "50" })).toEqual({});
    expect(validateLimits({ ...f, ai: "50.01" }).ai).toBe("aiMax");
    expect(validateLimits({ ...f, ai: "abc" }).ai).toBe("money");
    expect(validateLimits({ ...f, news: "1.01" }).news).toBe("newsMax");
    expect(validateLimits({ ...f, pages: "5001" }).pages).toBe("pages");
    expect(validateLimits({ ...f, pages: "1.5" }).pages).toBe("pages");
    expect(validateLimits({ ...f, pages: "0" })).toEqual({});
  });

  it("changed fields by amount, PUT body, below spent, isDefault", () => {
    const f = formFromLimits(defaults);
    expect(changedLimits(defaults, { ...f, ai: "1" })).toEqual([]);
    expect(changedLimits(defaults, { ...f, ai: "2,5", pages: "500" })).toEqual(["ai", "pages"]);
    expect(valuesFromForm({ ...f, ai: "2,5", news: "0.4", pages: " 500 " })).toEqual({ ai_daily_usd: "2.5", news_daily_usd: "0.4", pages_daily: 500 });
    expect(belowUsed({ ...f, ai: "0.42", news: "0.03", pages: "70" }, budget)).toEqual(["ai", "news", "pages"]);
    expect(belowUsed({ ...f, ai: "0.43", news: "0.04", pages: "71" }, budget)).toEqual([]);
    expect(belowUsed({ ...f, ai: "0.10", news: "0.01", pages: "1" }, null)).toEqual([]);
    expect(isDefault(lim({ ai_daily_usd: "1.00", source: "admin" }))).toBe(true);
    expect(isDefault(lim({ ai_daily_usd: "2.00" }))).toBe(false);
  });
});

describe("«Limits» block", () => {
  it("env source, hints, below-spent warning, confirm → setLimits with reason; then the admin source", async () => {
    vi.spyOn(DiscoveryApi, "limits").mockResolvedValue(lim());
    const set = vi.spyOn(DiscoveryApi, "setLimits").mockImplementation(async (v, reason) =>
      lim({ ai_daily_usd: "0.30", news_daily_usd: "0.10", pages_daily: v.pages_daily, source: "admin", updated_by: "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a01", updated_by_name: "Admin Operator", updated_at: new Date().toISOString(), reason }),
    );
    const changed = vi.fn();
    ui(<LimitsPanel budget={budget} onChanged={changed} />);
    expect(await screen.findByTestId("lim-source")).toHaveTextContent(tRu("lim.src.env"));
    expect(screen.getByTestId("lim-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("lim-ai"), { target: { value: "0,30" } });
    fireEvent.change(screen.getByTestId("lim-news"), { target: { value: "0.10" } });
    expect(screen.getByTestId("lim-below")).toHaveTextContent("общий AI");
    fireEvent.click(screen.getByTestId("lim-save"));
    const dlg = await screen.findByTestId("lim-confirm");
    expect(within(dlg).getByTestId("lim-diff")).toHaveTextContent("$1.00");
    expect(within(dlg).getByTestId("lim-diff")).toHaveTextContent("$0.30");
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Экономим до конца месяца" } });
    fireEvent.click(within(dlg).getByTestId("confirm-ok"));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ ai_daily_usd: "0.30", news_daily_usd: "0.10", pages_daily: 300 }, "Экономим до конца месяца"));
    expect(await screen.findByText(tRu("lim.src.admin"))).toBeInTheDocument();
    expect(screen.getByTestId("lim-source")).toHaveTextContent("Admin Operator");
    expect(changed).toHaveBeenCalled();
    expect(screen.getByTestId("lim-reset")).toBeInTheDocument();
  });

  it("errors block saving; AUDIT_UNAVAILABLE keeps the dialog open with the reason; read-only without ops.kill_switch", async () => {
    vi.spyOn(DiscoveryApi, "limits").mockResolvedValue(lim({ source: "admin", ai_daily_usd: "2.50", updated_by_name: "Тимур", updated_at: new Date().toISOString(), reason: "Сезон" }));
    vi.spyOn(DiscoveryApi, "resetLimits").mockRejectedValue(new ApiError(503, { code: "AUDIT_UNAVAILABLE", message: "x", trace_id: "t", details: { service: "audit" } }));
    ui(<LimitsPanel budget={budget} onChanged={() => undefined} />);
    await screen.findByTestId("lim-source");
    fireEvent.change(screen.getByTestId("lim-news"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("lim-save"));
    expect(screen.queryByTestId("lim-confirm")).toBeNull();
    expect(screen.getByTestId("dsc-limits")).toHaveTextContent(tRu("lim.err.newsMax"));
    fireEvent.click(screen.getByTestId("lim-reset"));
    const dlg = await screen.findByTestId("lim-confirm");
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Сезон закончился" } });
    fireEvent.click(within(dlg).getByTestId("confirm-ok"));
    await waitFor(() => expect(dlg).toHaveTextContent(ru["lim.auditDown"]));
    cleanup();
    vi.spyOn(DiscoveryApi, "limits").mockResolvedValue(lim());
    ui(<LimitsPanel budget={budget} onChanged={() => undefined} />, ["discovery.manage"]);
    expect(await screen.findByTestId("lim-ro")).toHaveTextContent("ops.kill_switch");
    expect(screen.getByTestId("lim-ai")).toBeDisabled();
    expect(screen.queryByTestId("lim-save")).toBeNull();
  });
});

const src = (p: Partial<NewsSource> = {}): NewsSource => ({
  source_id: "a6000000-0000-4000-8000-000000000001", slug: "techcrunch", name: "TechCrunch", kind: "media", mode: "rss", feed_url: "https://techcrunch.com/feed/", page_url: null,
  site_domain: "techcrunch.com", extra_domains: [], interests: ["business.ai"], entities: [], country_code: null, lang: "en", display: "summary", category_filter: null, enabled: true,
  health: { last_fetch_at: new Date().toISOString(), last_ok_at: new Date().toISOString(), last_error: null, items_24h: 3 }, disabled_reason: null, last_probe_at: null, last_probe_result: null, version: 1, updated_at: null, ...p,
});

describe("feeds: reasons and auto-check", () => {
  it("terms: «State» text, summary, «read the reprint terms» confirmation with «Terms checked»", async () => {
    const terms = src({ enabled: false, disabled_reason: "terms", last_probe_at: new Date().toISOString(), last_probe_result: { ok: true, code: null, fetched: 40, accepted: 38, newest_at: null, enabled: false } });
    vi.spyOn(NewsApi, "sources").mockResolvedValue({ items: [terms], next_cursor: null });
    vi.spyOn(NewsApi, "source").mockResolvedValue(terms);
    ui(<FeedsPage />);
    expect(await screen.findByTestId("feeds-summary")).toHaveTextContent("условия не проверены 1");
    expect(screen.getByTestId("feed-state-cell")).toHaveTextContent("Выключен");
    expect(screen.getByTestId("feed-state-cell")).toHaveTextContent(ru["feed.reason.terms"]);
    fireEvent.click(screen.getByText("TechCrunch"));
    expect(await screen.findByTestId("ff-legal-note")).toHaveTextContent(ru["feed.termsNote"]);
    fireEvent.click(screen.getByLabelText(ru["feed.f.enabled"]));
    const dlg = await screen.findByTestId("ff-legal-confirm");
    expect(dlg).toHaveTextContent(ru["feed.termsM"]);
    expect(dlg).toHaveTextContent(ru["feed.termsAck"]);
    expect(within(dlg).getByTestId("ff-legal-ok")).toBeDisabled();
    fireEvent.click(within(dlg).getByRole("checkbox"));
    fireEvent.click(within(dlg).getByTestId("ff-legal-ok"));
    expect(screen.getByLabelText(ru["feed.f.enabled"])).toBeChecked();
  });

  it("probeLabel: passed / known code / unknown code", () => {
    const t = (k: keyof typeof ru) => ru[k];
    expect(probeLabel(t, null, true)).toBe(ru["feed.probe.ok"]);
    expect(probeLabel(t, "STALE", false)).toBe(ru["probe.code.STALE"]);
    expect(probeLabel(t, "WHATEVER_NEW", false)).toBe("WHATEVER_NEW");
  });

  it("summary and «State» column; switching on a legal feed needs the acknowledgement", async () => {
    const legal = src({ enabled: false, disabled_reason: "legal" });
    vi.spyOn(NewsApi, "sources").mockResolvedValue({
      items: [
        src({ source_id: "a6000000-0000-4000-8000-000000000002", slug: "f1", name: "F1" }),
        legal,
        src({ source_id: "a6000000-0000-4000-8000-000000000003", slug: "kun-en", name: "Kun EN", enabled: false, disabled_reason: "stale", last_probe_at: new Date().toISOString(), last_probe_result: { ok: false, code: "STALE", fetched: 20, accepted: 20, newest_at: null, enabled: false } }),
        src({ source_id: "a6000000-0000-4000-8000-000000000004", slug: "wait", name: "Wait", enabled: false, disabled_reason: "unverified" }),
      ],
      next_cursor: null,
    });
    vi.spyOn(NewsApi, "source").mockResolvedValue(legal);
    ui(<FeedsPage />);
    const sum = await screen.findByTestId("feeds-summary");
    expect(sum).toHaveTextContent("Включено 1 из 4");
    expect(sum).toHaveTextContent("ждут проверки 1");
    expect(sum).toHaveTextContent("нужно разрешение 1");
    expect(sum).toHaveTextContent("устарели 1");
    const cells = screen.getAllByTestId("feed-state-cell");
    expect(cells[1]).toHaveTextContent(ru["feed.reason.legal"]);
    expect(cells[2]).toHaveTextContent(ru["probe.code.STALE"]);
    fireEvent.click(screen.getByText("TechCrunch"));
    expect(await screen.findByTestId("ff-legal-note")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(ru["feed.f.enabled"]));
    const dlg = await screen.findByTestId("ff-legal-confirm");
    expect(within(dlg).getByTestId("ff-legal-ok")).toBeDisabled();
    fireEvent.click(within(dlg).getByRole("checkbox"));
    fireEvent.click(within(dlg).getByTestId("ff-legal-ok"));
    expect(screen.getByLabelText(ru["feed.f.enabled"])).toBeChecked();
  });
});
