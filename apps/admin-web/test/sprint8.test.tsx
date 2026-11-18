import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DlqItem, Me, Permission, ProviderHealth } from "@tilhero/contracts/admin";
import { DashboardApi, OpsApi } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { I18nProvider, pluralForm, type Lang } from "../src/i18n";
import { ru } from "../src/i18n/ru";
import { en } from "../src/i18n/en";
import { routeHash, parseHash } from "../src/state/route";
import { SessionCtx, type Session } from "../src/state/session";
import { ToastProvider } from "../src/ui/toasts";
import { Dashboard } from "../src/screens/dashboard/Dashboard";
import { QuotaMark } from "../src/screens/ai/parts";
import { MaskedJson } from "../src/screens/monitoring/Dlq";
import { ackErrText, alertTarget, alertText, subjectText, tOr } from "../src/screens/monitoring/Alerts";
import {
  ageParts,
  chartModel,
  countConfirmed,
  atReplayLimit,
  parseLocalDateTime,
  monRoute,
  msParts,
  parseMonRoute,
  providerCounts,
  quotaTone,
  rateTone,
  reasonParts,
  replayBlocked,
  sortProviders,
  topClasses,
} from "../src/screens/monitoring/ops";
import * as O from "../e2e/fixtures/ops";

/* Sprint 8 (P6): monitoring helpers, alert texts, masked envelope, «quota not charged», dashboard blocks without data. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const session = (perms: Permission[]): Session => {
  const set = new Set(perms);
  return {
    me: { staff: { staff_id: "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a01", email: "a@x", display_name: "A", role: "super_admin" }, permissions: perms } as unknown as Me,
    can: (p) => set.has(p),
    canAny: (ps) => ps.some((p) => set.has(p)),
    refreshMe: async () => null,
    setMe: () => undefined,
    signOut: async () => undefined,
    reloadTheme: async () => undefined,
    themeVersion: null,
    adminLayout: null,
  };
};
const ui = (node: ReactNode, perms: Permission[] = ["dashboard.read", "users.read", "support.read", "ops.kill_switch"], lang: Lang = "ru") =>
  render(
    <I18nProvider initial={lang}>
      <SessionCtx.Provider value={session(perms)}>
        <ToastProvider>{node}</ToastProvider>
      </SessionCtx.Provider>
    </I18nProvider>,
  );
const i18n = (lang: "ru" | "en" = "ru") => {
  const d = (lang === "ru" ? ru : en) as Record<string, string>;
  return {
    t: (k: string, v?: Record<string, string | number>) => (d[k] ?? k).replace(/\{(\w+)\}/g, (_, n: string) => String(v?.[n] ?? `{${n}}`)),
    tp: (k: string, n: number) => pluralForm(lang, n, d[k] ?? k),
    fmt: { pct: (x: number) => `${x.toFixed(1)} %` },
  } as unknown as Parameters<typeof alertText>[0];
};

describe("routes", () => {
  it("monitoring tabs and the provider drawer keep a readable hash (Telegram alert button)", () => {
    expect(parseMonRoute(null)).toEqual({ tab: "providers", provider: null, policy: null });
    expect(parseMonRoute("queues")).toEqual({ tab: "queues", provider: null, policy: null });
    expect(parseMonRoute("providers/aviasales")).toEqual({ tab: "providers", provider: "aviasales", policy: null });
    expect(parseMonRoute("dlq/notifications_watch_changes").tab).toBe("dlq");
    expect(parseMonRoute("nonsense").tab).toBe("providers");
    expect(routeHash("monitoring", monRoute("providers", "aviasales"))).toBe("#/monitoring/providers/aviasales");
    expect(parseHash("#/monitoring/providers/aviasales")).toEqual({ page: "monitoring", id: "providers/aviasales" });
    expect(routeHash("support", "TCK 1")).toBe("#/support/TCK%201");
  });
});

describe("provider helpers", () => {
  const items = O.providers(true);
  it("sorts the worst first and counts statuses", () => {
    expect(sortProviders(items)[0]!.provider).toBe("aviasales");
    const c = providerCounts(items);
    expect(c.down).toBe(1);
    expect(c.ok + c.idle + c.degraded + c.down + c.not_configured).toBe(items.length);
  });
  it("top error classes skip zeros and keep the order by count", () => {
    expect(topClasses({ server: 22, timeout: 6, auth: 0 })).toEqual([
      { k: "server", v: 22 },
      { k: "timeout", v: 6 },
    ]);
    expect(topClasses(null)).toEqual([]);
  });
  it("tones follow the ops-monitor thresholds; no calls is neutral, not «good»", () => {
    expect(rateTone(0.61, 46)).toBe("bad");
    expect(rateTone(0.152, 46)).toBe("warn");
    expect(rateTone(0.01, 46)).toBe("good");
    expect(rateTone(0, 0)).toBe("neutral");
    expect(quotaTone(90.4)).toBe("warn");
    expect(quotaTone(100)).toBe("bad");
    expect(quotaTone(null)).toBe("neutral");
  });
  it("units", () => {
    expect(msParts(820)).toEqual({ v: 820, unit: "ms" });
    expect(msParts(4100)).toEqual({ v: 4.1, unit: "s" });
    expect(msParts(null)).toBeNull();
    expect(ageParts(1260)).toEqual({ v: 21, unit: "m" });
    expect(ageParts(7200)).toEqual({ v: 2, unit: "h" });
  });
  it("history chart: fixed time axis, empty buckets blank, p95 line broken at gaps", () => {
    const now = Date.parse("2026-10-15T03:00:00Z");
    const h = O.history("aviasales", "24h", now);
    const m = chartModel(h.points, "24h", now, 576, 120);
    expect(m.bars.length).toBeLessThanOrEqual(288);
    expect(m.bars.length).toBeGreaterThan(200);
    expect(Math.max(...m.bars.map((b) => b.ok + b.err + b.route))).toBeCloseTo(120, 5);
    expect(m.ticks.length).toBe(4);
    const gap = chartModel(
      [
        { t: "2026-10-15T01:00:00Z", calls: 10, errors: 1, route_unsupported: 0, p95_ms: 900, by_class: {} },
        { t: "2026-10-15T02:00:00Z", calls: 10, errors: 12, route_unsupported: 2, p95_ms: 1200, by_class: {} },
      ] as never,
      "24h",
      now,
      576,
      120,
    );
    expect(gap.bars).toHaveLength(2);
    expect(gap.bars[1]!.errors).toBe(10); // errors never exceed calls
    expect(gap.p95Paths).toHaveLength(2);
    expect(chartModel(h.points, "7d", now, 576, 120).bars.length).toBeLessThanOrEqual(168);
  });
});

describe("DLQ helpers", () => {
  it("reason class, typed count, replay-less consumers, local dates", () => {
    expect(reasonParts("handler_error:KeyError")).toEqual({ kind: "handler_error", detail: "KeyError" });
    expect(reasonParts(null)).toEqual({ kind: "unknown", detail: null });
    expect(countConfirmed(" 3 ", 3)).toBe(true);
    expect(countConfirmed("", 0)).toBe(false);
    expect(countConfirmed("03", 3)).toBe(false);
    const items = O.dlqItems() as DlqItem[];
    expect(replayBlocked(items, new Map([["watch_offer_rebuilt", false]]))).toEqual(["watch_offer_rebuilt"]);
    expect(atReplayLimit({ replays: 3 })).toBe(true);
    expect(atReplayLimit({ replays: 2 })).toBe(false);
  });
  it("period fields in the locale format: ru ДД.ММ.ГГГГ ЧЧ:ММ, en MM/DD/YYYY; a date alone — the whole day", () => {
    const local = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString().replace(/\.\d{3}Z$/, "Z");
    expect(parseLocalDateTime("", "ru")).toBeUndefined();
    expect(parseLocalDateTime("15.10.2026 09:30", "ru")).toBe(local(2026, 10, 15, 9, 30));
    expect(parseLocalDateTime("5.1.2026", "ru")).toBe(local(2026, 1, 5));
    expect(parseLocalDateTime("15.10.2026", "ru", true)).toBe(local(2026, 10, 16));
    expect(parseLocalDateTime("10/15/2026 09:30", "en")).toBe(local(2026, 10, 15, 9, 30));
    expect(parseLocalDateTime("31.02.2026", "ru")).toBeNull();
    expect(parseLocalDateTime("15.10.2026 25:00", "ru")).toBeNull();
    expect(parseLocalDateTime("2026-10-15T10:00", "ru")).toBeNull();
    expect(parseLocalDateTime("15.10.2026", "en")).toBeNull();
  });
  it("the masked envelope marks every «***» (not only by colour)", () => {
    const d = O.dlqDetail("dlq:42")!;
    const { container } = render(<MaskedJson value={d.envelope_masked} />);
    expect(container.querySelectorAll("mark.mon-mask")).toHaveLength(d.masked_fields.length);
    expect(container.textContent).toContain('"old_price": "1470.00"');
  });
});

describe("alert texts", () => {
  it("status / route spike / DLQ growth in words; unknown kinds fall back to the code", () => {
    const i = i18n();
    const [status, route, dlq] = O.opsAlerts(true);
    expect(alertText(i, status!)).toContain("Сбой");
    expect(alertText(i, route!)).toContain("FRU ×12");
    expect(alertText(i, dlq!)).toContain("3");
    expect(alertText(i, { ...dlq!, kind: "brand_new" as never })).toBe("brand_new");
    expect(subjectText(i, "provider", "aviasales")).toBe("Aviasales");
    expect(subjectText(i, "provider", "newcomer")).toBe("newcomer");
    expect(tOr(i, "mon.ak.nope", "raw")).toBe("raw");
    expect(alertTarget("provider", "liteapi")).toEqual({ page: "monitoring", id: "providers/liteapi" });
    expect(alertTarget("dlq", "watch_offer_rebuilt")).toEqual({ page: "monitoring", id: "dlq/watch_offer_rebuilt" });
    expect(alertTarget("outbox", "news")).toEqual({ page: "monitoring", id: "queues" });
  });
  it("an acknowledgement with the audit down says nothing changed (not the AI search text)", () => {
    const i = i18n();
    expect(ackErrText(i, new ApiError(503, { code: "AUDIT_UNAVAILABLE", details: { service: "audit" } }))).toBe(ru["mon.dlq.auditDown"]);
    expect(ackErrText(i, new ApiError(404, { code: "ALERT_NOT_FOUND" }))).toBe(ru["err.ALERT_NOT_FOUND"]);
  });
});

describe("quota not charged", () => {
  it("shows only when quota_charged is false, with the reason", () => {
    const { rerender } = ui(<QuotaMark row={{ quota_charged: false, quota_refund_reason: "no_change" }} />);
    expect(screen.getByTestId("req-quota-free")).toHaveAttribute("data-reason", "no_change");
    expect(screen.getByTestId("req-quota-free").textContent).toContain("квота не списана");
    rerender(
      <I18nProvider initial="ru">
        <QuotaMark row={{ quota_charged: true }} />
      </I18nProvider>,
    );
    expect(screen.queryByTestId("req-quota-free")).toBeNull();
    rerender(
      <I18nProvider initial="ru">
        <QuotaMark row={{}} />
      </I18nProvider>,
    );
    expect(screen.queryByTestId("req-quota-free")).toBeNull();
  });
});

describe("dashboard blocks", () => {
  it("each block renders on its own: no data / not connected / forbidden / stale — never zeros", async () => {
    const d = O.dashboard("today", { off: { ai: "timeout", system: "not_configured", users: "forbidden" }, stale: ["support"] });
    vi.spyOn(DashboardApi, "get").mockResolvedValue(d);
    ui(<Dashboard />);
    await waitFor(() => expect(screen.getByTestId("dash-trips")).toBeInTheDocument());
    expect(within(screen.getByTestId("dash-ai")).getByTestId("dash-nodata")).toHaveAttribute("data-reason", "timeout");
    expect(within(screen.getByTestId("dash-system")).getByTestId("dash-nodata")).toHaveAttribute("data-reason", "not_configured");
    expect(within(screen.getByTestId("dash-users")).getByTestId("dash-nodata")).toHaveAttribute("data-reason", "forbidden");
    expect(screen.getByTestId("dash-users").textContent).not.toContain("12 846");
    expect(within(screen.getByTestId("dash-support")).getByTestId("dash-stale")).toBeInTheDocument();
    expect(screen.getByTestId("dash-trips")).toHaveAttribute("data-available", "true");
    expect(screen.getByTestId("dash-no-flight").textContent).toContain("Бишкек");
  });
  it("the whole request failing shows one error with a retry", async () => {
    const spy = vi.spyOn(DashboardApi, "get").mockRejectedValueOnce(new ApiError(503, { code: "UPSTREAM_UNAVAILABLE" }));
    spy.mockResolvedValueOnce(O.dashboard("today"));
    ui(<Dashboard />);
    await waitFor(() => expect(screen.getByTestId("dash-error")).toBeInTheDocument());
    fireEvent.click(within(screen.getByTestId("dash-error")).getByRole("button"));
    await waitFor(() => expect(screen.getByTestId("dash-system")).toHaveAttribute("data-available", "true"));
  });
});

describe("api", () => {
  it("DLQ commands carry an idempotency key; the message id is encoded", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ action_id: "x", requested: 1, done: 1, skipped: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    await OpsApi.dlqCommand("replay", { ids: ["dlq:42"], reason: "fix" }, "dlq-replay-test-key-1");
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toContain("/admin/v1/ops/dlq/replay");
    expect(new Headers(init!.headers).get("idempotency-key")).toBe("dlq-replay-test-key-1");
    f.mockImplementation(async () => new Response(JSON.stringify(O.dlqDetail("dlq:42")), { status: 200, headers: { "content-type": "application/json" } }));
    await OpsApi.dlqMessage("dlq:42");
    expect(String(f.mock.calls[1]![0])).toContain("/ops/dlq/dlq%3A42");
  });
  it("providers fixture shape: probe_supported is false for Anthropic and news feeds", () => {
    const p = O.providers() as ProviderHealth[];
    expect(p.filter((x) => !x.probe_supported).map((x) => x.provider).sort()).toEqual(["anthropic", "news_feeds"]);
  });
});
