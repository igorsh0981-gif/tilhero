import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiAgent, AiAlert, AiLimits, Me, Permission, SkillVersion } from "@tilhero/contracts/admin";
import { AiApi, UsageApi } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { I18nProvider, type Lang } from "../src/i18n";
import { ru } from "../src/i18n/ru";
import { SessionCtx, type Session } from "../src/state/session";
import { ToastProvider } from "../src/ui/toasts";
import { KillSwitchDialog } from "../src/screens/ai/Budgets";
import { LimitsPanel } from "../src/screens/discovery/Limits";
import { ALL_FIELDS, changedLimits, formFromLimits, validateLimits, valuesFromForm } from "../src/screens/discovery/limits";
import { RequestDrawer } from "../src/screens/ai/RequestDrawer";
import {
  agentForm,
  agentPatch,
  alertKind,
  initialVersion,
  micro,
  moneyIn,
  parseRequestsRoute,
  pctTone,
  rateIn,
  skillActions,
  skillChanges,
  contentOf,
  validateAgent,
  validateSkill,
} from "../src/screens/ai/ai";

/* Sprint 7: helpers of the AI screens, the five AI limits, kill switch confirmation, request content reveal. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const session = (perms: Permission[], staffId = "0b6c3e1a-7d2f-4f0e-9a51-1c2d3e4f5a01"): Session => {
  const set = new Set(perms);
  return {
    me: { staff: { staff_id: staffId, email: "a@x", display_name: "A", role: "super_admin" }, permissions: perms } as unknown as Me,
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
const ui = (node: ReactNode, perms: Permission[] = ["dashboard.read", "ops.kill_switch", "ai.content.read"], lang: Lang = "ru") =>
  render(
    <I18nProvider initial={lang}>
      <SessionCtx.Provider value={session(perms)}>
        <ToastProvider>{node}</ToastProvider>
      </SessionCtx.Provider>
    </I18nProvider>,
  );

const agent: AiAgent = {
  agent_id: "concierge",
  name: "AI-консьерж",
  kind: "interactive",
  code_managed: false,
  skills: [],
  degraded_mode: "fallback_model",
  degrade_at_pct: 90,
  per_request_max_usd: "0.050000",
  monthly_cap_usd: "30.000000",
  max_tool_calls: 3,
  model_fallback: "claude-haiku-4-5",
  tools_whitelist: ["set_direct_only", "reprice_offer"],
  config_version: 4,
  updated_by: null,
  updated_by_name: null,
  updated_at: null,
};

describe("helpers", () => {
  it("budget thresholds 70 / 90; money without floats", () => {
    expect([pctTone(null), pctTone(10), pctTone(70), pctTone(89.9), pctTone(90), pctTone(140)]).toEqual(["neutral", "good", "warn", "warn", "bad", "bad"]);
    expect(micro("0.050000")).toBe(50_000n);
    expect(micro("1")).toBe(1_000_000n);
    expect(micro("0.1e1")).toBeNull();
    expect(moneyIn(" 0,05 ", 6, 1)).toBe("0.05");
    expect(moneyIn("0.0000001", 6, 1)).toBeNull();
    expect([rateIn(""), rateIn("3"), rateIn("1000.000001"), rateIn("abc")]).toEqual([null, "3", false, false]);
  });

  it("agent config: bounds and PATCH of the changed fields only (money by amount, cap → null)", () => {
    const f = agentForm(agent);
    expect(f).toMatchObject({ per_request_max_usd: "0.05", monthly_cap_usd: "30", degrade_at_pct: "90" });
    expect(validateAgent(f)).toEqual({});
    expect(agentPatch(agent, f)).toEqual({});
    expect(validateAgent({ ...f, degrade_at_pct: "49", per_request_max_usd: "1.5", monthly_cap_usd: "1001", max_tool_calls: "6", model_fallback: "Bad model" })).toEqual({
      degrade_at_pct: "pct",
      per_request_max_usd: "perRequest",
      monthly_cap_usd: "cap",
      max_tool_calls: "tools",
      model_fallback: "model",
    });
    expect(agentPatch(agent, { ...f, per_request_max_usd: "0.050", monthly_cap_usd: "", model_fallback: "" })).toEqual({ monthly_cap_usd: null, model_fallback: null });
    expect(agentPatch(agent, { ...f, per_request_max_usd: "0,04" })).toEqual({ per_request_max_usd: "0.04" });
  });

  it("skill lifecycle buttons, first version, routes", () => {
    const v = (status: SkillVersion["status"], version = 3, review: SkillVersion["review"] = null) => ({ status, version, review });
    expect(skillActions(v("DRAFT"), 2)).toEqual(["save"]);
    expect(skillActions(v("TESTED"), 2)).toEqual(["save", "requestReview"]);
    expect(skillActions(v("REVIEW"), 2)).toEqual(["approve", "reject"]);
    expect(skillActions(v("REVIEW", 3, { decision: "approved", comment: null, at: null }), 2)).toEqual(["publish", "reject"]);
    expect(skillActions(v("PUBLISHED", 2), 2)).toEqual([]);
    expect(skillActions(v("PUBLISHED", 1), 2)).toEqual(["rollback", "deprecate"]);
    expect(skillActions(v("DEPRECATED", 1), 2)).toEqual([]);
    expect(initialVersion([{ version: 1, status: "PUBLISHED" }, { version: 2, status: "TESTED" }], 1)).toBe(2);
    expect(initialVersion([{ version: 1, status: "PUBLISHED" }, { version: 2, status: "PUBLISHED" }], 1)).toBe(1);
    expect(parseRequestsRoute("user:0F8FAD5B-D9CB-469F-A165-70867728950E")).toEqual({ request: null, user: "0f8fad5b-d9cb-469f-a165-70867728950e" });
    expect(parseRequestsRoute("junk")).toEqual({ request: null, user: null });
    const alert = (p: Partial<AiAlert>) => ({ kind: "budget", auto_paused: false, period: "day", ...p }) as AiAlert;
    expect([alertKind(alert({})), alertKind(alert({ period: "month" })), alertKind(alert({ auto_paused: true })), alertKind(alert({ kind: "unpriced" }))]).toEqual(["day", "month", "autoPause", "unpriced"]);
  });

  it("skill form: tools outside the whitelist, cost above the agent limit; changes by amount", () => {
    const ver = {
      artifact: {
        system_instruction: "x",
        output_schema: "concierge-answer-v1",
        allowed_tools: ["set_direct_only"],
        source_priority: ["official"],
        model_policy: { primary: "claude-haiku-4-5", fallback: null },
        limits: { max_tokens: 1200, max_cost_usd: "0.050000", timeout_ms: 30000, retries: 1 },
        confidence: { min: 0.6 },
        safety_policy: { no_invented_prices: true, source_required: true, web_content_untrusted: true, tool_before_claim: true },
        change_note: null,
      },
    } as unknown as SkillVersion;
    const base = contentOf(ver);
    expect(base.limits.max_cost_usd).toBe("0.05");
    expect(validateSkill(base, agent.tools_whitelist, agent.per_request_max_usd)).toEqual({});
    const bad = { ...base, allowed_tools: ["web_search"], limits: { ...base.limits, max_cost_usd: "0.06" }, confidence: { min: 0.123 } };
    expect(validateSkill(bad, agent.tools_whitelist, agent.per_request_max_usd)).toEqual({ allowed_tools: "notAllowed", max_cost_usd: "aboveAgent", confidence: "range" });
    expect(skillChanges(base, { ...base, limits: { ...base.limits, max_cost_usd: "0.050" } })).toEqual({});
    expect(skillChanges(base, { ...base, limits: { ...base.limits, max_cost_usd: "0,04" }, change_note: "  " })).toEqual({ limits: { ...base.limits, max_cost_usd: "0.04" } });
  });

  it("limits: the concierge and Test Console budgets — 0–50 each, sent only by the sprint 7 block", () => {
    const l = { ai_daily_usd: "1.00", news_daily_usd: "0.20", pages_daily: 300, concierge_daily_usd: "1.00", evaluation_daily_usd: "0.30" };
    const f = formFromLimits(l);
    expect(validateLimits({ ...f, concierge: "50.01", evaluation: "x" })).toEqual({ concierge: "agentMax", evaluation: "money" });
    expect(changedLimits(l, { ...f, concierge: "1.5" })).toEqual([]);
    expect(changedLimits(l, { ...f, concierge: "1.5" }, ALL_FIELDS)).toEqual(["concierge"]);
    expect(valuesFromForm({ ...f, concierge: "1,5" })).toEqual({ ai_daily_usd: "1.00", news_daily_usd: "0.20", pages_daily: 300 });
    expect(valuesFromForm({ ...f, concierge: "1,5" }, ALL_FIELDS)).toEqual({ ai_daily_usd: "1.00", news_daily_usd: "0.20", pages_daily: 300, concierge_daily_usd: "1.5", evaluation_daily_usd: "0.30" });
  });
});

describe("components", () => {
  const lim = (p: Partial<AiLimits> = {}): AiLimits => {
    const d = { ai_daily_usd: "1.00", news_daily_usd: "0.20", pages_daily: 300, concierge_daily_usd: "1.00", evaluation_daily_usd: "0.30" };
    return { ...d, source: "env", updated_by: null, updated_by_name: null, updated_at: null, reason: null, defaults: d, ...p };
  };

  it("«AI limits» of sprint 7: five fields via /ai/limits; spent today of the concierge warns below", async () => {
    vi.spyOn(AiApi, "limits").mockResolvedValue(lim());
    const set = vi.spyOn(AiApi, "setLimits").mockResolvedValue(lim({ concierge_daily_usd: "0.50", source: "admin" }));
    ui(<LimitsPanel budget={null} fields={ALL_FIELDS} via="ai" agentsSpent={{ concierge: "0.912400" }} onChanged={() => undefined} />);
    expect(await screen.findByTestId("lim-concierge")).toHaveValue("1.00");
    expect(screen.getByTestId("lim-evaluation")).toHaveValue("0.30");
    expect(screen.getByTestId("dsc-limits")).toHaveTextContent("сегодня $0.9124");
    fireEvent.change(screen.getByTestId("lim-concierge"), { target: { value: "0.5" } });
    expect(screen.getByTestId("lim-below")).toHaveTextContent(ru["lim.short.concierge"]);
    fireEvent.click(screen.getByTestId("lim-save"));
    const dlg = await screen.findByTestId("lim-confirm");
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Экономим" } });
    fireEvent.click(within(dlg).getByTestId("confirm-ok"));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith({ ai_daily_usd: "1.00", news_daily_usd: "0.20", pages_daily: 300, concierge_daily_usd: "0.5", evaluation_daily_usd: "0.30" }, "Экономим"),
    );
  });

  it("kill switch: the button waits for the typed id; audit down keeps the state and explains", async () => {
    const pause = vi.spyOn(AiApi, "pauseAgent").mockRejectedValue(new ApiError(503, { code: "AUDIT_UNAVAILABLE", message: "x", trace_id: "t", details: { service: "audit" } }));
    const done = vi.fn();
    ui(<KillSwitchDialog target={{ kind: "agent", id: "concierge", name: "AI-консьерж", paused: false }} onClose={() => undefined} onDone={done} />);
    fireEvent.change(screen.getByTestId("kill-reason"), { target: { value: "Инцидент" } });
    expect(screen.getByTestId("kill-ok")).toBeDisabled();
    fireEvent.change(screen.getByTestId("kill-type"), { target: { value: "concierge" } });
    expect(screen.getByTestId("kill-ok")).toBeEnabled();
    fireEvent.click(screen.getByTestId("kill-ok"));
    await waitFor(() => expect(screen.getByTestId("kill-dialog")).toHaveTextContent(ru["bdg.kill.auditDown"]));
    expect(pause).toHaveBeenCalledWith("concierge", true, "Инцидент");
    expect(done).not.toHaveBeenCalled();
  });

  it("request drill-down: content only with ai.content.read, after a reason; never without the permission", async () => {
    const detail = {
      request_id: "3c1a7d52-6f0e-4b8a-9d21-7e5f4a3b2c10",
      occurred_at: new Date().toISOString(),
      agent_id: "concierge",
      skill_id: "concierge.event",
      skill_version: "2",
      user_id: null,
      model_used: "claude-haiku-4-5",
      fallback_used: false,
      tokens_in: 10,
      tokens_out: 5,
      tool_calls: 0,
      service_calls: 0,
      cost_usd: "0.000100",
      latency_ms: 900,
      status: "SUCCESS" as const,
      error_code: null,
      calls: [],
      timeline: [],
      source_count: 0,
      safety_violations: 0,
      first_event_ms: 400,
      mode: "home",
      kind: "text",
      conversation_id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
      price_catalog_versions: ["2026-10-12"],
      trace_id: null,
      content: { available: true, requires: "ai.content.read" as const },
    };
    vi.spyOn(UsageApi, "request").mockResolvedValue(detail);
    const reveal = vi.spyOn(UsageApi, "reveal").mockResolvedValue({ request_id: detail.request_id, user_text: "Сколько стоит?", segments: [{ kind: "fact", text: "Цена $412", sources: [] }], tool_calls: [] });
    ui(<RequestDrawer id={detail.request_id} nameOf={(x) => x} onClose={() => undefined} lang="ru" />, ["dashboard.read"]);
    expect(await screen.findByTestId("rq-content-locked")).toHaveTextContent("ai.content.read");
    expect(reveal).not.toHaveBeenCalled();
    cleanup();
    ui(<RequestDrawer id={detail.request_id} nameOf={(x) => x} onClose={() => undefined} lang="ru" />, ["dashboard.read", "ai.content.read"]);
    fireEvent.click(await screen.findByTestId("rq-reveal"));
    const dlg = await screen.findByTestId("rq-reveal-confirm");
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Жалоба TCK-1" } });
    fireEvent.click(within(dlg).getByTestId("confirm-ok"));
    expect(await screen.findByTestId("rq-user-text")).toHaveTextContent("Сколько стоит?");
    expect(reveal).toHaveBeenCalledWith(detail.request_id, "Жалоба TCK-1");
  });
});
