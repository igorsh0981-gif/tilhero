/**
 * Profile → «Цель и уровень» after onboarding (goal, level_self, up to 5 topics; PATCH /v1/plan with If-Match,
 * 409 → the current plan), the new rows of the Profile and «Начать занятие» on Home.
 */
import type { LearningPlan, SessionResponse } from "@tilhero/contracts/bff";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBff } from "../src/api/bff";
import { ApiClient } from "../src/api/client";
import { FALLBACK_CONFIG } from "../src/config/experience";
import { directionOf, directionPatch, MAX_TOPICS, toggleTopic } from "../src/domain/plan";
import { I18nProvider } from "../src/i18n";
import { resetHomeScreenForTests } from "../src/screens/homescreen/HomeScreen";
import { Home } from "../src/screens/home/Home";
import { GoalScreen } from "../src/screens/profile/GoalScreen";
import { Profile } from "../src/screens/profile/Profile";
import { Soon } from "../src/screens/soon/Soon";
import { AppProvider, type AppCtx } from "../src/state/app";
import { useNav, type Nav } from "../src/state/nav";
import { resetThemeForTests } from "../src/tg";
import { ToastHost } from "../src/ui/overlays";
import { installTg, uninstallTg } from "./tgFake";

const ME = "6f1c2b3a-1111-4a2b-9c3d-000000000001";

const GOALS = [
  { code: "work", label: { ru: "Работа", uz: "Ish" }, icon: "briefcase" },
  { code: "career", label: { ru: "Карьера и собеседования", uz: "Karyera va ish suhbatlari" }, icon: "trophy" },
  { code: "travel", label: { ru: "Путешествия", uz: "Sayohat" }, icon: "globe" },
  { code: "daily", label: { ru: "Общение и быт", uz: "Muloqot va kundalik hayot" }, icon: "chat" },
  { code: "study", label: { ru: "Учёба", uz: "Oʻqish" }, icon: "book" },
  { code: "exam", label: { ru: "Экзамены", uz: "Imtihonlar" }, icon: "star" },
];
const TOPICS = ["small_talk", "travel", "food", "shopping", "work", "interview", "study"].map((code, i) => ({
  code,
  label: { ru: ["Знакомство и разговор", "Поездки и транспорт", "Кафе и еда", "Покупки", "Работа и офис", "Собеседование", "Учёба"][i]!, uz: `uz ${code}` },
  icon: null,
}));

function session(kid = false): SessionResponse {
  const learner = { learner_id: ME, kind: kid ? ("child" as const) : ("self" as const), display_name: "Азиз", age_band: kid ? ("6-9" as const) : ("18+" as const), is_active: true, onboarding_completed: true, voice_consent: false };
  return {
    access_token: "acc",
    expires_in: 900,
    refresh_token: "ref",
    account: { user_id: ME, display_name: "Азиз", username: null, locale: "ru", status: "ACTIVE", is_new: false, age_band: "18+", guardian_consent: "not_required" },
    learner,
    learners: [learner],
    security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null, pin_reset_effective_at: null },
    consent: { accepted: true, policy_version: "1.2", current_policy_version: "1.2", accepted_at: "2026-11-10T08:00:00Z", evidence_hash: "x", purposes: ["terms", "privacy", "learning"] },
    onboarding_completed: true,
    start_param: null,
  };
}
const PLAN: LearningPlan = {
  learner_id: ME,
  goal: "travel",
  level_self: "beginner",
  topics: ["travel", "food"],
  ui_lang: "ru",
  explain_lang: "ru",
  course_pair: "ru-en",
  schedule: { preset: "three_per_week", days: [1, 3, 5], preferred_time: "19:00", duration_min: 20, reminders_enabled: true, timezone: "Asia/Tashkent" },
  onboarding_completed_at: "2026-11-10T08:00:00Z",
  updated_at: "2026-11-10T08:00:00Z",
  version: 4,
};

/** A stateful BFF on fetch: the plan with If-Match, directories, today, profile. */
function fakeServer(o: { conflictOnce?: boolean } = {}) {
  let plan = { ...PLAN };
  let conflict = !!o.conflictOnce;
  const calls: Array<{ key: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ key, body, headers });
    const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    switch (key) {
      case "GET /v1/plan":
        return ok(plan);
      case "PATCH /v1/plan": {
        if (conflict) {
          conflict = false;
          plan = { ...plan, goal: "exam", version: plan.version + 1 };
          return ok({ code: "PLAN_VERSION_CONFLICT", message: "x", trace_id: "t", details: { current_version: plan.version } }, 409);
        }
        if (headers["If-Match"] && Number(headers["If-Match"]) !== plan.version) return ok({ code: "PLAN_VERSION_CONFLICT", message: "x", trace_id: "t", details: {} }, 409);
        if (body.topics && body.topics.length > 5) return ok({ code: "PLAN_INVALID", message: "x", trace_id: "t", details: { field: "topics", reason: "too_many" } }, 422);
        plan = { ...plan, ...body, version: plan.version + 1 };
        return ok(plan);
      }
      case "GET /v1/directory/goals":
        return ok({ items: GOALS });
      case "GET /v1/directory/topics":
        return ok({ items: TOPICS });
      case "GET /v1/plan/today":
        return ok({ local_date: "2026-11-18", is_scheduled_today: true, slot_time: "19:00", duration_min: 20, minutes_today: 0, done_today: false, next_slot: null, streak_days: 0, week: [] });
      case "GET /v1/profile": {
        const s = session();
        return ok({ account: s.account, learner: s.learner, learners: s.learners, security: s.security, consent: s.consent, notifications: { enabled: true, categories: { reminders: true, missed: false, social: false, support: true, product: false }, quiet_hours: null, timezone: "Asia/Tashkent" } });
      }
      default:
        return ok({ code: "NOT_FOUND", message: "", trace_id: "t", details: {} }, 404);
    }
  }) as typeof fetch;
  const client = new ApiClient({ baseUrl: "", fetchImpl, storage: null, timezone: () => "Asia/Tashkent" });
  return { calls, bff: createBff(client), plan: () => plan };
}

let navRef: Nav | null = null;
function Shell({ server, kid, children }: { server: ReturnType<typeof fakeServer>; kid?: boolean; children: ReactNode }) {
  const [plan, setPlan] = useState<LearningPlan>(PLAN);
  const nav = useNav({ tab: "profile", stack: [{ name: "goal" }] });
  navRef = nav;
  const ctx: AppCtx = {
    bff: server.bff,
    session: session(kid),
    applySession: async () => undefined,
    syncProfile: () => undefined,
    patchSession: () => undefined,
    plan,
    setPlan,
    reloadPlan: async () => {
      const p = await server.bff.plan("Asia/Tashkent");
      setPlan(p);
      return p;
    },
    config: FALLBACK_CONFIG,
    nav,
    unread: 0,
    setUnread: () => undefined,
    refreshUnread: () => undefined,
    openLink: () => undefined,
    endSession: () => undefined,
    deviceTz: "Asia/Tashkent",
    online: true,
  };
  return (
    <AppProvider value={ctx}>
      {children}
      <ToastHost />
    </AppProvider>
  );
}

function mount(ui: ReactNode, o: { conflictOnce?: boolean; kid?: boolean; lang?: "ru" | "uz" } = {}) {
  const server = fakeServer(o);
  render(
    <I18nProvider initial={o.lang ?? "ru"}>
      <Shell server={server} kid={o.kid}>
        {ui}
      </Shell>
    </I18nProvider>,
  );
  return server;
}

beforeEach(() => {
  resetHomeScreenForTests();
  resetThemeForTests();
});
afterEach(() => uninstallTg());

describe("direction of learning — rules", () => {
  it("only the changed fields; topics compared as a set; unknown codes neither sent nor counted as a change", () => {
    const base = directionOf(PLAN);
    expect(directionPatch(base, base)).toEqual({});
    expect(directionPatch(base, { ...base, goal: "work" })).toEqual({ goal: "work" });
    expect(directionPatch(base, { ...base, level_self: "some" })).toEqual({ level_self: "some" });
    expect(directionPatch(base, { ...base, topics: ["food", "travel"] })).toEqual({});
    expect(directionPatch(base, { ...base, topics: ["food"] })).toEqual({ topics: ["food"] });
    expect(directionPatch(base, { ...base, goal: null })).toEqual({});
    const known = new Set(["food", "work"]);
    expect(directionPatch(base, { ...base, topics: ["travel", "food"] }, known)).toEqual({});
    expect(directionPatch(base, { ...base, topics: ["travel", "food", "work"] }, known)).toEqual({ topics: ["food", "work"] });
  });
  it("toggle: up to 5, the order of choice kept", () => {
    expect(toggleTopic(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleTopic(["a", "b"], "a")).toEqual(["b"]);
    const five = ["a", "b", "c", "d", "e"];
    expect(toggleTopic(five, "f")).toEqual(five);
    expect(toggleTopic(five, "c")).toEqual(["a", "b", "d", "e"]);
    expect(MAX_TOPICS).toBe(5);
  });
});

describe("Profile → «Цель и уровень»", () => {
  it("the same goals as in onboarding (directory labels), level and topics; save sends only the changes with If-Match", async () => {
    const server = mount(<GoalScreen />);
    expect(screen.getByRole("heading", { name: "Цель и уровень" })).toBeInTheDocument();
    const goals = within(screen.getByTestId("goal-picker"));
    expect(await goals.findByRole("button", { name: "Карьера и собеседования" })).toBeInTheDocument();
    expect(goals.getByRole("button", { name: "Путешествия" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("level-beginner")).toHaveAttribute("aria-pressed", "true");
    const topics = within(await screen.findByTestId("topics-picker"));
    expect(topics.getByRole("button", { name: "Кафе и еда" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("topics-count")).toHaveTextContent("Выбрано 2 из 5");
    const save = screen.getByTestId("goal-save");
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent("Изменений нет");

    await userEvent.click(goals.getByRole("button", { name: "Работа" }));
    await userEvent.click(screen.getByTestId("level-some"));
    await userEvent.click(topics.getByRole("button", { name: "Кафе и еда" }));
    await userEvent.click(topics.getByRole("button", { name: "Собеседование" }));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(await screen.findByTestId("toast")).toHaveTextContent("Цель и уровень сохранены");
    const patch = server.calls.filter((c) => c.key === "PATCH /v1/plan");
    expect(patch).toHaveLength(1);
    expect(patch[0]!.headers["If-Match"]).toBe("4");
    expect(patch[0]!.body).toEqual({ goal: "work", level_self: "some", topics: ["travel", "interview"] });
    await waitFor(() => expect(save).toBeDisabled());
  });

  it("five topics: the others wait until one is taken off", async () => {
    mount(<GoalScreen />);
    const topics = within(await screen.findByTestId("topics-picker"));
    for (const n of ["Знакомство и разговор", "Покупки", "Учёба"]) await userEvent.click(topics.getByRole("button", { name: n }));
    expect(screen.getByTestId("topics-count")).toHaveTextContent("Выбрано 5 из 5");
    expect(screen.getByText(/чтобы выбрать другую тему, снимите одну из выбранных/)).toBeInTheDocument();
    expect(topics.getByRole("button", { name: "Работа и офис" })).toBeDisabled();
    await userEvent.click(topics.getByRole("button", { name: "Покупки" }));
    expect(topics.getByRole("button", { name: "Работа и офис" })).toBeEnabled();
  });

  it("409 PLAN_VERSION_CONFLICT → the current plan from the server is shown", async () => {
    const server = mount(<GoalScreen />, { conflictOnce: true });
    const goals = within(screen.getByTestId("goal-picker"));
    await userEvent.click(await goals.findByRole("button", { name: "Работа" }));
    await userEvent.click(screen.getByTestId("goal-save"));
    expect(await screen.findByTestId("goal-conflict")).toHaveTextContent("План изменился на другом устройстве — показываем актуальный.");
    await waitFor(() => expect(goals.getByRole("button", { name: "Экзамены" })).toHaveAttribute("aria-pressed", "true"));
    expect(goals.getByRole("button", { name: "Работа" })).toHaveAttribute("aria-pressed", "false");
    expect(server.calls.some((c) => c.key === "GET /v1/plan")).toBe(true);
    // the next save goes with the new version
    await userEvent.click(goals.getByRole("button", { name: "Учёба" }));
    await userEvent.click(screen.getByTestId("goal-save"));
    await screen.findByTestId("toast");
    expect(server.calls.filter((c) => c.key === "PATCH /v1/plan").at(-1)!.headers["If-Match"]).toBe("5");
  });

  it("UZ: labels of the directory and of the level", async () => {
    mount(<GoalScreen />, { lang: "uz" });
    expect(screen.getByRole("heading", { name: "Maqsad va daraja" })).toBeInTheDocument();
    expect(await within(screen.getByTestId("goal-picker")).findByRole("button", { name: "Sayohat" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("level-beginner")).toHaveTextContent("Biroz bilaman");
  });
});

describe("Profile: new rows", () => {
  it("«Цель и уровень» in «Мой курс», «Тема», and «На главный экран» on Telegram 8.0", async () => {
    installTg({ status: "missed" });
    mount(<Profile />);
    const goal = screen.getByTestId("row-goal");
    expect(goal).toHaveTextContent("Цель и уровень");
    expect(goal).toHaveTextContent("Путешествия · Немного знаю");
    expect(screen.getByTestId("row-theme")).toHaveTextContent("Тема");
    expect(screen.getByTestId("row-theme")).toHaveTextContent("Как в Telegram");
    expect(await screen.findByTestId("hs-row")).toHaveTextContent("На главный экран");
    await userEvent.click(goal);
    expect(navRef!.top).toEqual({ name: "goal" });
    await userEvent.click(screen.getByTestId("row-theme"));
    expect(navRef!.top).toEqual({ name: "theme" });
  });

  it("outside Telegram there is no «На главный экран»", async () => {
    mount(<Profile />);
    await screen.findByTestId("row-theme");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("hs-row")).toBeNull();
    expect(screen.queryByTestId("hs-row-added")).toBeNull();
  });
});

describe("Home: «Начать занятие»", () => {
  it("sprint 4: the only action leads to the lesson (no plan here → the «Уроки» tab); no manual «Отметить занятие»", async () => {
    mount(
      <>
        <Home />
        <Soon what="review" />
      </>,
    );
    const start = await screen.findByTestId("start-lesson");
    expect(start).toHaveTextContent("Начать занятие");
    expect(start).toHaveClass("btn");
    expect(screen.queryByTestId("mark-activity")).toBeNull();
    expect(screen.getByTestId("today-card")).toHaveTextContent("Занятие засчитается в график, когда вы пройдёте урок.");
    await userEvent.click(start);
    await waitFor(() => expect(navRef!.tab).toBe("lessons"));
    expect(navRef!.stack).toEqual([]);
  });

  it("UZ: «Mashgʻulotni boshlash»", async () => {
    mount(<Home />, { lang: "uz" });
    expect(await screen.findByTestId("start-lesson")).toHaveTextContent("Mashgʻulotni boshlash");
  });
});
