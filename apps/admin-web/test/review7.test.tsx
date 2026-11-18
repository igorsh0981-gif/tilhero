import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessLevel, AiAgent, AiAgentRuntimeState, AiLimits, Me, Permission, SkillVersion } from "@tilhero/contracts/admin";
import { AiApi, SkillsApi } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { I18nProvider, type Lang } from "../src/i18n";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";
import { SessionCtx, type Session } from "../src/state/session";
import { ToastProvider } from "../src/ui/toasts";
import { AgentConfigDrawer, LevelDialog, warningText } from "../src/screens/ai/Budgets";
import { LimitsPanel } from "../src/screens/discovery/Limits";
import { ALL_FIELDS, agentLimitWarnings, availableLimits, changedLimits, formFromLimits, isDefault, missingLimits } from "../src/screens/discovery/limits";
import { agentForm, agentWarnings, levelErrors, levelWarnings, skillAbove, validateAgent, type SkillCost } from "../src/screens/ai/ai";

/* Review 7: M3 (agent / level checks and warnings), M4 (provider-gateway 6.1 without the agent budgets). */

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
const ui = (node: ReactNode, lang: Lang = "ru") =>
  render(
    <I18nProvider initial={lang}>
      <SessionCtx.Provider value={session(["dashboard.read", "ops.kill_switch"])}>
        <ToastProvider>{node}</ToastProvider>
      </SessionCtx.Provider>
    </I18nProvider>,
  );

const agent: AiAgent = {
  agent_id: "concierge",
  name: "AI-консьерж",
  kind: "interactive",
  code_managed: false,
  skills: [{ skill_id: "concierge.answer", code_managed: false, active_version: 3, pending: [{ version: 4, status: "DRAFT" }] }],
  degraded_mode: "fallback_model",
  degrade_at_pct: 90,
  per_request_max_usd: "0.050000",
  monthly_cap_usd: "30.000000",
  max_tool_calls: 3,
  model_fallback: "claude-haiku-4-5",
  tools_whitelist: ["reprice_offer"],
  config_version: 4,
  updated_by: null,
  updated_by_name: null,
  updated_at: null,
};
const costs: SkillCost[] = [
  { skill_id: "concierge.answer", version: 3, status: "PUBLISHED", max_cost_usd: "0.04" },
  { skill_id: "concierge.answer", version: 4, status: "DRAFT", max_cost_usd: "0.045" },
];
const state = {
  agent_id: "concierge",
  day: { spent_usd: "0.4", limit_usd: "1.00", pct: 40, source: "env" },
  month: { cost_usd: "12.400000", cap_usd: "30.00", pct: 41 },
} as unknown as AiAgentRuntimeState;
const level = (p: Partial<AccessLevel>): AccessLevel => ({
  code: "basic",
  name_ru: "Базовый",
  name_en: "Basic",
  concierge_messages_per_day: 10,
  is_default: true,
  sort: 10,
  version: 1,
  updated_by: null,
  updated_by_name: null,
  updated_at: null,
  ...p,
});
const LEVELS = [level({}), level({ code: "plus", name_ru: "Расширенный", name_en: "Plus", concierge_messages_per_day: 20, is_default: false, sort: 20 })];

describe("M3 helpers", () => {
  it("agent: per request not below an active / open skill version; month ≥ day; only the changed fields", () => {
    const f = agentForm(agent);
    const ctx = { agent, skillCosts: costs, dayLimitUsd: "1.00", monthSpentUsd: "12.4" };
    expect(validateAgent(f, ctx)).toEqual({});
    expect(validateAgent({ ...f, per_request_max_usd: "0.044" }, ctx)).toEqual({ per_request_max_usd: "belowSkill" });
    expect(skillAbove("0.044", costs)).toMatchObject({ version: 4, status: "DRAFT" });
    expect(validateAgent({ ...f, per_request_max_usd: "0.045" }, ctx)).toEqual({});
    expect(validateAgent({ ...f, monthly_cap_usd: "0.99" }, ctx)).toEqual({ monthly_cap_usd: "monthBelowDay" });
    expect(validateAgent({ ...f, monthly_cap_usd: "1" }, ctx)).toEqual({});
    // unchanged fields are not re-checked (ai-control checks only the PATCH fields)
    expect(validateAgent(f, { ...ctx, skillCosts: [{ ...costs[0]!, max_cost_usd: "0.9" }], dayLimitUsd: "40" })).toEqual({});
    // without the costs (not loaded) the server is the check
    expect(validateAgent({ ...f, per_request_max_usd: "0.01" }, { agent })).toEqual({});
  });

  it("agent: confirmed warnings — monthly cap not above spent (auto-pause), daily budget below a request", () => {
    const f = agentForm(agent);
    const ctx = { agent, skillCosts: costs, dayLimitUsd: "1.00", monthSpentUsd: "12.4" };
    expect(agentWarnings(f, ctx)).toEqual([]);
    expect(agentWarnings({ ...f, monthly_cap_usd: "12.40" }, ctx)).toEqual([{ k: "monthBelowSpent", cap: "12.40", spent: "12.4" }]);
    expect(agentWarnings({ ...f, monthly_cap_usd: "12.41" }, ctx)).toEqual([]);
    expect(agentWarnings({ ...f, per_request_max_usd: "0.5" }, { ...ctx, dayLimitUsd: "0.30" })).toEqual([{ k: "dayBelowPerRequest", day: "0.30", per: "0.5" }]);
    // an error hides the warnings (fix the error first)
    expect(agentWarnings({ ...f, monthly_cap_usd: "0.5" }, ctx)).toEqual([]);
  });

  it("levels: the default > 0; plus below basic / a new default above others — warnings", () => {
    const f = { code: "plus", name_ru: "Расширенный", name_en: "Plus", messages: "20", is_default: false };
    expect(levelErrors(f)).toBeNull();
    expect(levelErrors({ ...f, code: "Plus" })).toBe("code");
    expect(levelErrors({ ...f, name_en: " " })).toBe("name");
    expect(levelErrors({ ...f, messages: "1001" })).toBe("messages");
    expect(levelErrors({ ...f, code: "basic", messages: "0", is_default: true })).toBe("defaultZero");
    expect(levelErrors({ ...f, messages: "0" })).toBeNull();
    expect(levelWarnings(f, LEVELS)).toEqual([]);
    expect(levelWarnings({ ...f, messages: "5" }, LEVELS)).toEqual([{ k: "belowDefault", level: LEVELS[0], n: 5 }]);
    expect(levelWarnings({ ...f, code: "basic", messages: "25", is_default: true }, LEVELS)).toEqual([{ k: "othersBelow", levels: [LEVELS[1]], n: 25 }]);
  });

  it("limits: concierge day below its per-request limit / above its monthly cap — warnings for the changed field", () => {
    const l = { ai_daily_usd: "1.00", news_daily_usd: "0.20", pages_daily: 300, concierge_daily_usd: "1.00", evaluation_daily_usd: "0.30" };
    const f = formFromLimits(l);
    const caps = { concierge: { per_request_max_usd: "0.050000", monthly_cap_usd: "30.00" } };
    expect(agentLimitWarnings({ ...f, concierge: "0.04" }, caps, ["concierge"])).toEqual([{ k: "dayBelowPerRequest", f: "concierge", v: "0.050000" }]);
    expect(agentLimitWarnings({ ...f, concierge: "31" }, caps, ["concierge"])).toEqual([{ k: "dayAboveMonth", f: "concierge", v: "30.00" }]);
    expect(agentLimitWarnings({ ...f, concierge: "0.04" }, caps, [])).toEqual([]);
  });

  it("server warnings: known codes from the dictionary, unknown — the ai-control text (RU) or the code (EN)", () => {
    const t = (d: Record<string, string>) => (k: string, v: Record<string, string | number> = {}) => d[k]!.replace(/\{(\w+)\}/g, (_, x: string) => String(v[x]));
    const w = { code: "MONTHLY_CAP_BELOW_SPENT", message: "x", details: { spent_usd: "12.400000", monthly_cap_usd: "10.00" } };
    expect(warningText({ t: t(ru) as never, lang: "ru" }, w)).toContain("$10.00");
    expect(warningText({ t: t(ru) as never, lang: "ru" }, w)).toContain("$12.40");
    expect(warningText({ t: t(en) as never, lang: "en" }, { code: "SOMETHING_NEW", message: "Текст", details: {} })).toBe("SOMETHING_NEW");
    expect(warningText({ t: t(ru) as never, lang: "ru" }, { code: "SOMETHING_NEW", message: "Текст", details: {} })).toBe("Текст");
  });
});

describe("M4: provider-gateway 6.1 without the agent budgets", () => {
  const old: AiLimits = {
    ai_daily_usd: "1.00",
    news_daily_usd: "0.20",
    pages_daily: 300,
    concierge_daily_usd: null,
    evaluation_daily_usd: null,
    source: "env",
    updated_by: null,
    updated_by_name: null,
    updated_at: null,
    reason: null,
    defaults: { ai_daily_usd: "1.00", news_daily_usd: "0.20", pages_daily: 300, concierge_daily_usd: null, evaluation_daily_usd: null },
  };

  it("helpers: the missing fields are not shown, compared or sent", () => {
    expect(missingLimits(old, ALL_FIELDS)).toEqual(["concierge", "evaluation"]);
    expect(availableLimits(old, ALL_FIELDS)).toEqual(["ai", "news", "pages"]);
    expect(changedLimits(old, { ...formFromLimits(old), concierge: "5" }, ALL_FIELDS)).toEqual([]);
    expect(isDefault(old)).toBe(true);
  });

  it("the block works with three fields and says the agent budgets come with the update", async () => {
    vi.spyOn(AiApi, "limits").mockResolvedValue(old);
    const set = vi.spyOn(AiApi, "setLimits").mockResolvedValue({ ...old, ai_daily_usd: "2.00", source: "admin" });
    ui(<LimitsPanel budget={null} fields={ALL_FIELDS} via="ai" onChanged={() => undefined} />);
    expect(await screen.findByTestId("lim-ai")).toHaveValue("1.00");
    expect(screen.queryByTestId("lim-concierge")).toBeNull();
    expect(screen.queryByTestId("lim-evaluation")).toBeNull();
    expect(screen.getByTestId("lim-missing")).toHaveTextContent("provider-gateway");
    fireEvent.change(screen.getByTestId("lim-ai"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("lim-save"));
    fireEvent.change(within(await screen.findByTestId("lim-confirm")).getByRole("textbox"), { target: { value: "Сезон" } });
    fireEvent.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ ai_daily_usd: "2", news_daily_usd: "0.20", pages_daily: 300 }, "Сезон"));
  });
});

describe("M3 forms", () => {
  const version = (v: number, max: string, status: SkillVersion["status"]) =>
    ({ skill_id: "concierge.answer", version: v, status, artifact: { limits: { max_cost_usd: max } } }) as unknown as SkillVersion;

  it("agent drawer: a per-request limit below a skill version is blocked; auto-pause is confirmed; warnings[] go up", async () => {
    vi.spyOn(SkillsApi, "version").mockImplementation(async (_id, v) => (v === 3 ? version(3, "0.04", "PUBLISHED") : version(4, "0.045", "DRAFT")));
    const patch = vi.spyOn(AiApi, "patchAgent").mockResolvedValue({
      ...agent,
      monthly_cap_usd: "12.000000",
      config_version: 5,
      warnings: [{ code: "MONTHLY_CAP_BELOW_SPENT", message: "x", details: { spent_usd: "12.4", monthly_cap_usd: "12.00" } }],
    });
    const saved = vi.fn();
    ui(<AgentConfigDrawer agent={agent} state={state} onClose={() => undefined} onSaved={saved} />);
    await waitFor(() => expect(SkillsApi.version).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByTestId("cfg-per_request_max_usd"), { target: { value: "0.044" } });
    expect(await screen.findByText(/concierge\.answer v4 \(DRAFT\)/)).toBeInTheDocument();
    expect(screen.getByTestId("cfg-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("cfg-per_request_max_usd"), { target: { value: "0.05" } });
    fireEvent.change(screen.getByTestId("cfg-monthly_cap_usd"), { target: { value: "0.5" } });
    expect(screen.getByTestId("cfg-drawer")).toHaveTextContent("Месячный лимит меньше дневного ($1.00 в сутки)");
    fireEvent.change(screen.getByTestId("cfg-monthly_cap_usd"), { target: { value: "12" } });
    expect(screen.getByTestId("cfg-warn")).toHaveTextContent("автопауза");
    expect(screen.getByTestId("cfg-save")).toBeDisabled();
    fireEvent.click(screen.getByTestId("cfg-warn-ok"));
    fireEvent.change(screen.getByTestId("cfg-reason"), { target: { value: "Экономим" } });
    fireEvent.click(screen.getByTestId("cfg-save"));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith("concierge", { monthly_cap_usd: "12", reason: "Экономим", expected_version: 4 });
    expect(saved.mock.calls[0]![1]).toEqual([{ code: "MONTHLY_CAP_BELOW_SPENT", message: "x", details: { spent_usd: "12.4", monthly_cap_usd: "12.00" } }]);
  });

  it("agent drawer: 409 AGENT_PER_REQUEST_BELOW_SKILL of fresher data lands on the field", async () => {
    vi.spyOn(SkillsApi, "version").mockRejectedValue(new ApiError(503, { code: "UPSTREAM_UNAVAILABLE", message: "x", trace_id: "t", details: {} }));
    vi.spyOn(AiApi, "patchAgent").mockRejectedValue(
      new ApiError(409, { code: "AGENT_PER_REQUEST_BELOW_SKILL", message: "x", trace_id: "t", details: { skills: [{ skill_id: "concierge.answer", version: 5, status: "REVIEW", max_cost_usd: "0.060000" }] } }),
    );
    ui(<AgentConfigDrawer agent={agent} state={state} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.change(screen.getByTestId("cfg-per_request_max_usd"), { target: { value: "0.055" } });
    fireEvent.change(screen.getByTestId("cfg-reason"), { target: { value: "Дороже" } });
    fireEvent.click(screen.getByTestId("cfg-save"));
    expect(await screen.findByText(/concierge\.answer v5 \(REVIEW\)/)).toBeInTheDocument();
    expect(screen.getByTestId("cfg-save")).toBeDisabled();
  });

  it("level dialog: the default level cannot be 0; plus below basic needs a confirmation; warnings[] go up", async () => {
    const put = vi.spyOn(AiApi, "putLevel").mockResolvedValue({
      ...LEVELS[1]!,
      concierge_messages_per_day: 5,
      warnings: [{ code: "LEVEL_BELOW_DEFAULT", message: "x", details: { level: "plus", concierge_messages_per_day: 5, default_level: "basic", default_messages_per_day: 10 } }],
    });
    const saved = vi.fn();
    const { unmount } = ui(<LevelDialog level={LEVELS[0]!} levels={LEVELS} onClose={() => undefined} onSaved={saved} />);
    fireEvent.change(screen.getByTestId("lvl-n"), { target: { value: "0" } });
    expect(screen.getByTestId("lvl-dialog")).toHaveTextContent(ru["lvl.err.defaultZero"]);
    unmount();
    ui(<LevelDialog level={LEVELS[1]!} levels={LEVELS} onClose={() => undefined} onSaved={saved} />);
    fireEvent.change(screen.getByTestId("lvl-n"), { target: { value: "5" } });
    expect(screen.getByTestId("lvl-warn")).toHaveTextContent("«Базовый» (10)");
    expect(screen.getByTestId("lvl-ok")).toBeDisabled();
    fireEvent.click(screen.getByTestId("lvl-warn-ok"));
    fireEvent.change(screen.getByTestId("lvl-reason"), { target: { value: "Пробный" } });
    fireEvent.click(screen.getByTestId("lvl-ok"));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(put).toHaveBeenCalledWith("plus", expect.objectContaining({ concierge_messages_per_day: 5, reason: "Пробный" }));
    expect(saved.mock.calls[0]![0][0]).toMatchObject({ code: "LEVEL_BELOW_DEFAULT" });
  });
});

describe("toasts and drawers", () => {
  it("a drawer opened while a toast is visible moves the toasts off its footer", async () => {
    const { useToast } = await import("../src/ui/toasts");
    let fire: (m: string) => void = () => undefined;
    const Probe = () => {
      const toast = useToast();
      fire = (m) => toast(m, "ok");
      return null;
    };
    ui(<Probe />);
    act(() => fire("Сохранено"));
    expect(screen.getByTestId("toasts").className.trim()).toBe("toasts");
    const dr = document.createElement("div");
    dr.className = "drawer";
    Object.defineProperty(dr, "offsetWidth", { value: 560 });
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    act(() => void document.body.appendChild(dr));
    await waitFor(() => expect(screen.getByTestId("toasts")).toHaveClass("at-left"));
    act(() => dr.remove());
    await waitFor(() => expect(screen.getByTestId("toasts").className.trim()).toBe("toasts"));
  });
});
