/**
 * Sprint 6 — the game screens on a scripted BFF: Home with and without the game (GAME_UNAVAILABLE hides the block, the
 * week keeps the frozen day), the rewards of a session (quiet / full, nothing on `none` and on GAME_UNAVAILABLE), the
 * shop (the shortage from a 409, the same Idempotency-Key after a lost answer), the hero picker for a child (dragons
 * first, PUT), the motivation settings (PATCH, a failure puts the switch back), the history (a staff operation without
 * its comment).
 */
import type { GameSettings, GameSummary, LearningPlan, SessionResponse, ShopItemView, TodayPlan } from "@tilhero/contracts/bff";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBff } from "../src/api/bff";
import { ApiClient } from "../src/api/client";
import { FALLBACK_CONFIG } from "../src/config/experience";
import { I18nProvider } from "../src/i18n";
import { BadgesScreen } from "../src/screens/game/Badges";
import { GameHistoryScreen } from "../src/screens/game/History";
import { GameSettingsScreen } from "../src/screens/game/GameSettings";
import { HeroPicker } from "../src/screens/game/HeroPicker";
import { HeroImg } from "../src/screens/game/parts";
import { ReviewSummaryScreen } from "../src/screens/memory/ReviewSummary";
import { SessionRewardsCard } from "../src/screens/game/Rewards";
import { ShopScreen } from "../src/screens/game/Shop";
import { Home } from "../src/screens/home/Home";
import { AppProvider, type AppCtx } from "../src/state/app";
import { useNav } from "../src/state/nav";
import { LessonSummaryScreen } from "../src/screens/lessons/Summary";
import { confirmPopup, showPopup } from "../src/tg";
import { PopupHost, ToastHost } from "../src/ui/overlays";
import { installTg, uninstallTg } from "./tgFake";

const ME = "6f1c2b3a-1111-4a2b-9c3d-000000000001";
const KID = "7a1c2b3a-2222-4a2b-9c3d-000000000001";
const SESSION_ID = "5e550000-aaaa-4bbb-8ccc-000000000001";

function makeSession(kid = false): SessionResponse {
  const self = { learner_id: ME, kind: "self" as const, display_name: "Азиз", age_band: "18+" as const, is_active: !kid, onboarding_completed: true, voice_consent: false };
  const child = { learner_id: KID, kind: "child" as const, display_name: "Мадина", age_band: "6-9" as const, is_active: kid, onboarding_completed: true, voice_consent: false };
  return {
    access_token: "acc",
    expires_in: 900,
    refresh_token: "ref",
    account: { user_id: ME, display_name: "Азиз", username: null, locale: "ru", status: "ACTIVE", is_new: false, age_band: "18+", guardian_consent: "not_required" },
    learner: kid ? child : self,
    learners: [self, child],
    security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null, pin_reset_effective_at: null },
    consent: { accepted: true, policy_version: "1.2", current_policy_version: "1.2", accepted_at: "2026-11-10T08:00:00Z", evidence_hash: "sha256:x", purposes: ["terms", "privacy", "learning"] },
    onboarding_completed: true,
    start_param: null,
  };
}

const PLAN: LearningPlan = {
  learner_id: ME,
  goal: "travel",
  level_self: "some",
  topics: [],
  ui_lang: "ru",
  explain_lang: "ru",
  course_pair: "ru-en",
  schedule: { preset: "three_per_week", days: [1, 3, 5], preferred_time: "19:00", duration_min: 20, reminders_enabled: true, timezone: "Asia/Tashkent" },
  onboarding_completed_at: "2026-11-10T08:00:00Z",
  updated_at: "2026-11-10T08:00:00Z",
  version: 3,
};

const TODAY: TodayPlan = {
  local_date: "2026-11-20",
  is_scheduled_today: true,
  slot_time: "19:00",
  duration_min: 20,
  minutes_today: 0,
  done_today: false,
  next_slot: { local_date: "2026-11-20", time: "19:00" },
  streak_days: 3,
  week: [
    { local_date: "2026-11-16", scheduled: true, done: true, missed: false, frozen: false },
    { local_date: "2026-11-17", scheduled: false, done: false, missed: false, frozen: false },
    { local_date: "2026-11-18", scheduled: true, done: false, missed: true, frozen: true },
    { local_date: "2026-11-19", scheduled: false, done: false, missed: false, frozen: false },
    { local_date: "2026-11-20", scheduled: true, done: false, missed: false, frozen: false },
    { local_date: "2026-11-21", scheduled: false, done: false, missed: false, frozen: false },
    { local_date: "2026-11-22", scheduled: false, done: false, missed: false, frozen: false },
  ],
};

const SETTINGS: GameSettings = { auto_freeze: true, quests_hidden: false, celebrations: "full", game_notifications: true };
const SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const img = (id: string) => ({ asset_id: id, url: `/v1/game/assets/${id}/${SHA}`, width: 300, height: 460 });

afterEach(() => uninstallTg());

const SUMMARY: GameSummary = {
  level: 2,
  xp_total: 120,
  xp_level_start: 100,
  xp_next_level: 250,
  til_balance: 85,
  freeze_stock: 2,
  freeze_max: 5,
  freeze_price_til: 40,
  hero: { code: "robot_0", name: { ru: "Робот Вольт", uz: "Robot Volt" }, stage: 1, stage_name: { ru: "Сборка", uz: "Yigʻilish" }, image: img("a1"), confirmed_skills: 3, next_stage_at: 2 },
  quests: {
    local_date: "2026-11-20",
    hidden: false,
    items: [
      { slot: 1, code: "lesson_1", kind: "lesson_complete", target: 1, progress: 0, status: "active", reward: { xp: 10, til: 5 } },
      { slot: 2, code: "review_10", kind: "review_cards", target: 10, progress: 4, status: "active", reward: { xp: 10, til: 5 } },
      { slot: 3, code: "reading_1", kind: "reading_complete", target: 1, progress: 1, status: "completed", reward: { xp: 10, til: 5 } },
    ],
    all_done_bonus: { xp: 10, til: 10 },
    bonus_received: false,
  },
  events: [],
  equipment: { background: null, frame: null },
  settings: SETTINGS,
  purchase_available: false,
};

type Reply = [number, unknown] | ((body: unknown) => [number, unknown]) | "network" | "hang";
interface Call {
  key: string;
  url: URL;
  body: unknown;
  headers: Record<string, string>;
}
const err = (status: number, code: string, details: Record<string, unknown> = {}): [number, unknown] => [status, { code, message: code, trace_id: "t", details }];

/** "METHOD /path": a reply, or a list used one by one (the last repeats); "network" — the fetch fails; "hang" — never
 *  answers. */
function fakeBff(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) && typeof v[0] !== "number" ? [...(v as Reply[])] : [v as Reply]]));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ key, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const q = queues.get(key);
    const r = q ? (q.length > 1 ? q.shift()! : q[0]!) : err(404, "NOT_FOUND");
    if (r === "network") throw new TypeError("Failed to fetch");
    if (r === "hang") return new Promise<Response>(() => undefined);
    const [status, payload] = typeof r === "function" ? r(body) : r;
    return new Response(status === 204 ? null : JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new ApiClient({ baseUrl: "", fetchImpl, storage: null, timezone: () => "Asia/Tashkent" });
  return { calls, bff: createBff(client), of: (key: string) => calls.filter((c) => c.key === key) };
}

function Shell({ kid, bff, children }: { kid: boolean; bff: ReturnType<typeof createBff>; children: ReactNode }) {
  const [session] = useState(() => makeSession(kid));
  const [plan, setPlan] = useState<LearningPlan>({ ...PLAN, learner_id: session.learner.learner_id });
  const nav = useNav();
  const ctx: AppCtx = {
    bff,
    session,
    applySession: async () => undefined,
    syncProfile: () => undefined,
    patchSession: () => undefined,
    plan,
    setPlan,
    reloadPlan: async () => plan,
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
      <div className="app" data-learner={session.learner.kind}>
        {nav.top ? <p data-testid="pushed">{nav.top.name}</p> : null}
        {children}
        <PopupHost />
        <ToastHost />
      </div>
    </AppProvider>
  );
}

function mount(ui: ReactNode, routes: Record<string, Reply | Reply[]>, kid = false) {
  const f = fakeBff(routes);
  render(
    <I18nProvider initial="ru">
      <Shell kid={kid} bff={f.bff}>
        {ui}
      </Shell>
    </I18nProvider>,
  );
  return f;
}

const HOME_ROUTES = (summary: Reply): Record<string, Reply> => ({
  "GET /v1/plan/today": [200, TODAY],
  "GET /v1/sessions/active": [200, { session: null }],
  "GET /v1/game/summary": summary,
});

describe("Home: the game block", () => {
  it("with the game: the hero, the level, tils, freezes on top, quests; the frozen day of the week", async () => {
    const f = mount(<Home />, HOME_ROUTES([200, SUMMARY]));
    const card = await screen.findByTestId("game-card");
    expect(within(card).getByTestId("game-hero-name")).toHaveTextContent("Робот Вольт · «Сборка»");
    expect(within(card).getByTestId("game-xp-text")).toHaveTextContent("20 из 150 XP · до уровня 3 — 130 XP");
    expect(screen.getByTestId("home-freezes")).toHaveAccessibleName("Заморозки серии: 2 из 5");
    expect(screen.getByTestId("game-quests")).toHaveTextContent("Повторить 10 карточек");
    const frozen = document.querySelector('.week li[data-state="frozen"]')!;
    expect(frozen).toHaveAttribute("aria-label", "среда: пропуск закрыт заморозкой, серия сохранена");
    expect(screen.getByTestId("frozen-legend")).toBeInTheDocument();
    // the art of the stage from the catalogue, on the BFF origin
    expect(within(card).getByRole("img", { name: "Робот Вольт, ступень «Сборка»" })).toHaveAttribute("src", `/v1/game/assets/a1/${SHA}`);
    expect(f.of("GET /v1/game/summary").length).toBeGreaterThan(0);
  });

  it("GAME_UNAVAILABLE: no block and no freezes chip; the plan and the week stay", async () => {
    mount(<Home />, HOME_ROUTES(err(503, "GAME_UNAVAILABLE", { service: "gamification" })));
    expect(await screen.findByTestId("today-card")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.week li[data-state="frozen"]')).not.toBeNull());
    await act(async () => undefined);
    expect(screen.queryByTestId("game-card")).toBeNull();
    expect(screen.queryByTestId("home-freezes")).toBeNull();
  });

  it("no hero yet: the invitation leads to the picker; hidden quests are not shown", async () => {
    mount(<Home />, HOME_ROUTES([200, { ...SUMMARY, hero: null, quests: { ...SUMMARY.quests, hidden: true, items: [] } }]));
    const invite = await screen.findByTestId("game-invite");
    expect(invite).toHaveTextContent("Выберите героя");
    expect(screen.queryByTestId("game-quests")).toBeNull();
    await userEvent.click(screen.getByTestId("game-choose-hero"));
    expect(screen.getByTestId("pushed")).toHaveTextContent("heroes");
  });

  it("a child: «Выбери героя», quests on «ты»", async () => {
    mount(<Home />, HOME_ROUTES([200, { ...SUMMARY, hero: null }]), true);
    expect(await screen.findByTestId("game-invite")).toHaveTextContent("Выбери героя");
    expect(screen.getByTestId("game-quests")).toHaveTextContent("Пройди урок");
    expect(screen.getByTestId("game-quests")).toHaveTextContent("Не успеешь — ничего страшного");
  });
});

const READY = {
  status: "ready",
  operations: [
    { op_id: "o1", currency: "xp", amount: 30, reason: "lesson", capped: false, multiplier: 1, status: "confirmed", created_at: "2026-11-20T10:00:00Z" },
    { op_id: "o2", currency: "til", amount: 5, reason: "lesson", capped: false, multiplier: 1, status: "confirmed", created_at: "2026-11-20T10:00:00Z" },
  ],
  level_up: { from: 2, to: 3 },
  hero_stage_up: null,
  badges: [],
  quests_completed: [],
};

describe("the rewards of a session", () => {
  it("ready at once: XP, tils, a new level; full celebrations (from the summary) — animated; no settings request", async () => {
    const f = mount(<SessionRewardsCard sessionId={SESSION_ID} />, { "GET /v1/game/rewards": [200, READY], "GET /v1/game/summary": [200, SUMMARY] });
    const card = await screen.findByTestId("rw-card");
    expect(screen.getByTestId("rw-xp")).toHaveTextContent("+30 XP");
    expect(screen.getByTestId("rw-til")).toHaveTextContent("+5 тилов");
    expect(screen.getByTestId("rw-level")).toHaveTextContent("Новый уровень: 3!");
    expect(card).toHaveAttribute("data-celebration", "full");
    expect(card).toHaveClass("celebrate");
    expect(f.of("GET /v1/game/rewards")[0]!.url.searchParams.get("source_session_id")).toBe(SESSION_ID);
    expect(f.of("GET /v1/game/settings")).toHaveLength(0);
    expect(f.of("GET /v1/game/summary")).toHaveLength(1);
  });
  it("quiet celebrations: no animation, no confetti", async () => {
    mount(<SessionRewardsCard sessionId={SESSION_ID} />, { "GET /v1/game/rewards": [200, READY], "GET /v1/game/summary": [200, { ...SUMMARY, settings: { ...SETTINGS, celebrations: "quiet" } }] });
    const card = await screen.findByTestId("rw-card");
    expect(card).toHaveAttribute("data-celebration", "quiet");
    expect(card).not.toHaveClass("celebrate");
    expect(card.querySelector(".rw-confetti")).toBeNull();
  });
  it("a child without settings (the game answered only the rewards): quiet by default, «Твои награды»", async () => {
    mount(<SessionRewardsCard sessionId={SESSION_ID} />, { "GET /v1/game/rewards": [200, READY] }, true);
    const card = await screen.findByTestId("rw-card");
    expect(card).toHaveAttribute("data-celebration", "quiet");
    expect(card).toHaveTextContent("Твои награды");
  });
  it("none or GAME_UNAVAILABLE — nothing is rendered and nothing else is asked (no settings, no summary)", async () => {
    const a = mount(<SessionRewardsCard sessionId={SESSION_ID} />, { "GET /v1/game/rewards": [200, { ...READY, status: "none", operations: [], level_up: null }] });
    await waitFor(() => expect(screen.queryByTestId("rw")).toBeNull());
    const b = mount(<SessionRewardsCard sessionId={SESSION_ID} />, { "GET /v1/game/rewards": err(503, "GAME_UNAVAILABLE") });
    await waitFor(() => expect(screen.queryByTestId("rw")).toBeNull());
    // «ready» with nothing to show is the same
    const c = mount(<SessionRewardsCard sessionId={SESSION_ID} />, { "GET /v1/game/rewards": [200, { ...READY, operations: [], level_up: null }] });
    await waitFor(() => expect(c.of("GET /v1/game/rewards").length).toBeGreaterThan(0));
    await act(async () => undefined);
    for (const f of [a, b, c]) expect(f.calls.map((x) => x.key).filter((k) => k !== "GET /v1/game/rewards")).toEqual([]);
  });
  it("the summary hangs: the rewards come after 1.5 s anyway (a child — quietly), never a wait without end", async () => {
    mount(<SessionRewardsCard sessionId={SESSION_ID} />, { "GET /v1/game/rewards": [200, READY], "GET /v1/game/summary": "hang" }, true);
    expect(screen.queryByTestId("rw-card")).toBeNull();
    const card = await screen.findByTestId("rw-card", {}, { timeout: 3000 });
    expect(card).toHaveAttribute("data-celebration", "quiet");
  });
});

const ITEM = (o: Partial<ShopItemView>): ShopItemView => ({
  code: "streak_freeze",
  kind: "streak_freeze",
  title: { ru: "Заморозка серии", uz: "Seriyani muzlatish" },
  image: null,
  theme: null,
  description: { ru: "Сохранит серию", uz: "Seriyani saqlaydi" },
  price_til: 40,
  owned: false,
  equipped: false,
  can_buy: true,
  reason_unavailable: null,
  available_until: null,
  ...o,
});

describe("the rewards on the summaries: only right after the player (fresh)", () => {
  const LESSON = {
    session_id: SESSION_ID,
    kind: "scenario" as const,
    title: { ru: "Заказ в кафе", uz: "Kafeda buyurtma" },
    status: "completed" as const,
    outcome: "success" as const,
    minutes: 6,
    evaluation: null,
    skills: [],
    key_words: [],
    next_lesson: null,
    can_review: false,
  };
  it("a lesson / scenario / media / reading just finished: the rewards are polled and shown", async () => {
    const f = mount(<LessonSummaryScreen sessionId={SESSION_ID} initial={LESSON} fresh />, { "GET /v1/game/rewards": [200, READY], "GET /v1/game/summary": [200, SUMMARY] });
    expect(await screen.findByTestId("rw-card")).toBeInTheDocument();
    expect(f.of("GET /v1/game/rewards")[0]!.url.searchParams.get("source_session_id")).toBe(SESSION_ID);
  });
  it("a past session opened from the history: no rewards card and no /rewards request", async () => {
    const f = mount(<LessonSummaryScreen sessionId={SESSION_ID} initial={LESSON} />, { "GET /v1/game/rewards": [200, READY], "GET /v1/game/summary": [200, SUMMARY] });
    expect(await screen.findByTestId("summary")).toBeInTheDocument();
    await act(async () => undefined);
    expect(screen.queryByTestId("rw")).toBeNull();
    expect(f.of("GET /v1/game/rewards")).toHaveLength(0);
    expect(f.of("GET /v1/game/summary")).toHaveLength(0);
  });
  it("«Повторение дня» just finished: the review's session id is asked; the rewards are shown above the checks", async () => {
    const summary = { session_id: SESSION_ID, status: "completed" as const, minutes: 6, reviewed: 6, correct: 5, again: 1, new_learned: 1, checks: [], next_due_at: null, due_tomorrow: 0 };
    const f = mount(<ReviewSummaryScreen summary={summary} fresh />, { "GET /v1/game/rewards": [200, { ...READY, level_up: null, quests_completed: [{ slot: 2, code: "review_10", kind: "review_cards", target: 10, progress: 10, status: "completed", reward: { xp: 10, til: 5 } }] }], "GET /v1/game/summary": [200, SUMMARY] });
    expect(await screen.findByTestId("rw-card")).toBeInTheDocument();
    expect(screen.getByTestId("rw-quests")).toHaveTextContent("Задание дня выполнено: Повторить 10 карточек");
    expect(f.of("GET /v1/game/rewards")[0]!.url.searchParams.get("source_session_id")).toBe(SESSION_ID);
  });
  it("an unfinished review (expired) or a summary not from the player asks nothing", async () => {
    const expired = { session_id: SESSION_ID, status: "expired" as const, minutes: 2, reviewed: 1, correct: 1, again: 0, new_learned: 0, checks: [], next_due_at: null, due_tomorrow: 0 };
    const a = mount(<ReviewSummaryScreen summary={expired} fresh />, {});
    const b = mount(<ReviewSummaryScreen summary={{ ...expired, status: "completed" }} />, {});
    expect((await screen.findAllByTestId("rv-summary")).length).toBe(2);
    await act(async () => undefined);
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
  });
});

describe("the art of a hero", () => {
  it("the catalogue image; when it cannot be loaded — the bundled public/heroes", async () => {
    mount(<HeroImg image={img("a9")} code="pet_2" stage={2} alt="Дракончик Сирень, ступень «Малыш»" />, {});
    const el = screen.getByRole("img", { name: "Дракончик Сирень, ступень «Малыш»" });
    expect(el).toHaveAttribute("src", `/v1/game/assets/a9/${SHA}`);
    expect(el).toHaveAttribute("data-src-kind", "catalogue");
    fireEvent.error(el);
    expect(el).toHaveAttribute("src", "/heroes/pet_0_3.webp");
    expect(el).toHaveAttribute("data-src-kind", "static");
  });
  it("a URL that is not this image of the game is never used", () => {
    mount(<HeroImg image={{ asset_id: "x", url: "javascript:alert(1)", width: 1, height: 1 }} code="robot_1" stage={1} alt="Робот Искра" />, {});
    expect(screen.getByRole("img", { name: "Робот Искра" })).toHaveAttribute("src", "/heroes/robot_0_1.webp");
    mount(<HeroImg image={{ asset_id: "x", url: `/v1/game/assets/y/${SHA}`, width: 1, height: 1 }} code="pet_0" stage={1} alt="Дракончик Мятик" />, {});
    expect(screen.getByRole("img", { name: "Дракончик Мятик" })).toHaveAttribute("src", "/heroes/pet_0_1.webp");
  });
  it("the shop and badges: a picture that cannot be loaded gives way to the icon", async () => {
    const shop = { items: [ITEM({ image: img("i1") }), ITEM({ code: "bg_x", kind: "background", title: { ru: "Фон", uz: "Fon" }, image: img("i2") })], til_balance: 85, freeze_stock: 2, freeze_max: 5 };
    mount(<ShopScreen />, { "GET /v1/game/shop": [200, shop] });
    const pic = await screen.findByTestId("shop-img-streak_freeze");
    expect(pic).toHaveAttribute("src", `/v1/game/assets/i1/${SHA}`);
    fireEvent.error(pic);
    expect(screen.queryByTestId("shop-img-streak_freeze")).toBeNull();
    expect(screen.getByTestId("shop-streak_freeze").querySelector(".shop-vis svg")).not.toBeNull();
    mount(<BadgesScreen />, {
      "GET /v1/game/badges": [200, { items: [{ code: "first_lesson", title: { ru: "Первый урок", uz: "x" }, description: { ru: "", uz: "" }, image: img("b1"), earned_at: "2026-11-12T15:20:00Z", basis: { metric: "lessons", value: 1, threshold: 1 } }] }],
    });
    const badgePic = await screen.findByTestId("badge-first_lesson-img");
    fireEvent.error(badgePic);
    expect(screen.queryByTestId("badge-first_lesson-img")).toBeNull();
    expect(screen.getByTestId("badge-first_lesson").querySelector(".badge-ic svg")).not.toBeNull();
  });
});

describe("the shop", () => {
  it("a double tap on «Купить»: one confirmation, one POST, the buttons are locked while it is open", async () => {
    const shop = { items: [ITEM({}), ITEM({ code: "bg_mint", kind: "background", title: { ru: "Мятный фон", uz: "Yalpiz foni" }, price_til: 60 })], til_balance: 85, freeze_stock: 2, freeze_max: 5 };
    const f = mount(<ShopScreen />, {
      "GET /v1/game/shop": [200, shop],
      "POST /v1/game/shop/purchases": [200, { purchase_id: "p1", item_code: "streak_freeze", price_til: 40, til_balance: 45, freeze_stock: 3, purchased_at: "2026-11-20T10:00:00Z" }],
    });
    const buy = await screen.findByTestId("shop-buy-streak_freeze");
    // two taps before React re-renders
    act(() => {
      fireEvent.click(buy);
      fireEvent.click(buy);
    });
    const dialogs = await screen.findAllByRole("alertdialog");
    expect(dialogs).toHaveLength(1);
    expect(screen.getByTestId("shop-buy-streak_freeze")).toBeDisabled();
    expect(screen.getByTestId("shop-buy-bg_mint")).toBeDisabled();
    const ok = within(dialogs[0]!).getByRole("button", { name: "Купить" });
    act(() => {
      fireEvent.click(ok);
      fireEvent.click(ok);
    });
    expect(await screen.findByTestId("toast")).toHaveTextContent("Заморозка куплена. Запас: 3 из 5");
    await act(async () => undefined);
    expect(f.of("POST /v1/game/shop/purchases")).toHaveLength(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  it("the key is made at the first tap; a cancelled confirmation sends nothing and keeps the key", async () => {
    const shop = { items: [ITEM({})], til_balance: 85, freeze_stock: 2, freeze_max: 5 };
    const f = mount(<ShopScreen />, { "GET /v1/game/shop": [200, shop], "POST /v1/game/shop/purchases": [200, { purchase_id: "p1", item_code: "streak_freeze", price_til: 40, til_balance: 45, freeze_stock: 3, purchased_at: "2026-11-20T10:00:00Z" }] });
    await userEvent.click(await screen.findByTestId("shop-buy-streak_freeze"));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Отмена" }));
    expect(f.of("POST /v1/game/shop/purchases")).toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId("shop-buy-streak_freeze")).toBeEnabled());
  });
  it("an unknown outcome (5xx): the shelf and the balance are re-read, the retry carries the same key", async () => {
    const shop = { items: [ITEM({})], til_balance: 85, freeze_stock: 2, freeze_max: 5 };
    const after = { items: [ITEM({})], til_balance: 45, freeze_stock: 3, freeze_max: 5 };
    const f = mount(<ShopScreen />, {
      "GET /v1/game/shop": [[200, shop], [200, after]],
      "POST /v1/game/shop/purchases": [err(503, "GAME_UNAVAILABLE"), [200, { purchase_id: "p1", item_code: "streak_freeze", price_til: 40, til_balance: 45, freeze_stock: 3, purchased_at: "2026-11-20T10:00:00Z" }]],
    });
    const buy = async () => {
      await userEvent.click(await screen.findByTestId("shop-buy-streak_freeze"));
      await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Купить" }));
    };
    await buy();
    expect(await within(screen.getByTestId("shop-streak_freeze")).findByRole("alert")).toHaveTextContent("Игра временно недоступна");
    // the purchase may have gone through: the balance as it is now
    await waitFor(() => expect(screen.getByTestId("shop-balance")).toHaveTextContent("У вас 45 тилов"));
    expect(f.of("GET /v1/game/shop")).toHaveLength(2);
    await buy();
    await waitFor(() => expect(f.of("POST /v1/game/shop/purchases")).toHaveLength(2));
    const keys = f.of("POST /v1/game/shop/purchases").map((c) => c.headers["Idempotency-Key"]);
    expect(keys[1]).toBe(keys[0]);
  });
  it("a theme with a dark background (--ink) is ignored: the default look", async () => {
    const shop = {
      items: [
        ITEM({ code: "bg_dark", kind: "background", title: { ru: "Тёмный фон", uz: "x" }, price_til: 60, theme: { bg: "ink", accent: "pen" } }),
        ITEM({ code: "bg_ok", kind: "background", title: { ru: "Мятный фон", uz: "x" }, price_til: 60, theme: { bg: "ok-soft", accent: "ok" } }),
      ],
      til_balance: 85,
      freeze_stock: 2,
      freeze_max: 5,
    };
    mount(<ShopScreen />, { "GET /v1/game/shop": [200, shop] });
    const dark = (await screen.findByTestId("shop-bg_dark")).querySelector<HTMLElement>(".shop-vis")!;
    expect(dark.style.getPropertyValue("--game-bg")).toBe("");
    expect(dark.style.getPropertyValue("--game-accent")).toBe("");
    const ok = screen.getByTestId("shop-bg_ok").querySelector<HTMLElement>(".shop-vis")!;
    expect(ok.style.getPropertyValue("--game-bg")).toBe("var(--ok-soft)");
  });
  it("409 INSUFFICIENT_TILS: «Не хватает N тилов… покупка тилов скоро», no payment", async () => {
    const shop = { items: [ITEM({})], til_balance: 85, freeze_stock: 2, freeze_max: 5 };
    const after = { items: [ITEM({ can_buy: false, reason_unavailable: "not_enough_tils" })], til_balance: 10, freeze_stock: 2, freeze_max: 5 };
    mount(<ShopScreen />, {
      "GET /v1/game/shop": [[200, shop], [200, after]],
      "POST /v1/game/shop/purchases": err(409, "INSUFFICIENT_TILS", { price: 40, balance: 10, missing: 30, purchase_available: false }),
    });
    await userEvent.click(await screen.findByTestId("shop-buy-streak_freeze"));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Купить" }));
    expect(await screen.findByTestId("shop-why-streak_freeze")).toHaveTextContent("Не хватает 30 тилов. Заработайте в уроках — покупка тилов скоро");
    await waitFor(() => expect(screen.getByTestId("shop-buy-streak_freeze")).toBeDisabled());
    expect(document.body.textContent).not.toMatch(/Payme|оплат/i);
  });
  it("a lost answer: the retry carries the same Idempotency-Key; the next purchase — a new one", async () => {
    const shop = { items: [ITEM({})], til_balance: 85, freeze_stock: 2, freeze_max: 5 };
    const result = (stock: number, bal: number) => [200, { purchase_id: "p1", item_code: "streak_freeze", price_til: 40, til_balance: bal, freeze_stock: stock, purchased_at: "2026-11-20T10:00:00Z" }] as Reply;
    const f = mount(<ShopScreen />, { "GET /v1/game/shop": [200, shop], "POST /v1/game/shop/purchases": ["network", result(3, 45), result(4, 5)] });
    const buy = async () => {
      await userEvent.click(await screen.findByTestId("shop-buy-streak_freeze"));
      await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Купить" }));
    };
    await buy();
    expect(await within(screen.getByTestId("shop-streak_freeze")).findByRole("alert")).toBeInTheDocument();
    await buy();
    expect(await screen.findByTestId("toast")).toHaveTextContent("Заморозка куплена. Запас: 3 из 5");
    await buy();
    await waitFor(() => expect(f.of("POST /v1/game/shop/purchases")).toHaveLength(3));
    const keys = f.of("POST /v1/game/shop/purchases").map((c) => c.headers["Idempotency-Key"]);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(f.of("POST /v1/game/shop/purchases")[0]!.body).toEqual({ item_code: "streak_freeze" });
  });
  it("a full stock of freezes and an owned frame: the reasons in words, «Надеть» keeps the other slot", async () => {
    const shop = {
      items: [
        ITEM({ can_buy: false, reason_unavailable: "freeze_full" }),
        ITEM({ code: "bg_mint", kind: "background", title: { ru: "Мятный фон", uz: "Yalpiz foni" }, price_til: 60, owned: true, equipped: true, can_buy: false, reason_unavailable: "owned", theme: { bg: "ok-soft", accent: "ok" } }),
        ITEM({ code: "frame_gold", kind: "hero_frame", title: { ru: "Золотая рамка", uz: "Oltin ramka" }, price_til: 50, owned: true, can_buy: false, reason_unavailable: "owned" }),
      ],
      til_balance: 85,
      freeze_stock: 5,
      freeze_max: 5,
    };
    const f = mount(<ShopScreen />, { "GET /v1/game/shop": [200, shop], "PUT /v1/game/equipment": [200, SUMMARY] });
    expect(await screen.findByTestId("shop-why-streak_freeze")).toHaveTextContent("Запас полный: 5 из 5");
    expect(screen.getByTestId("shop-bg_mint")).toHaveTextContent("Надето");
    expect(screen.getByTestId("shop-bg_mint").querySelector(".shop-vis")).toHaveStyle({ "--game-bg": "var(--ok-soft)" });
    await userEvent.click(screen.getByTestId("shop-equip-frame_gold"));
    await waitFor(() => expect(f.of("PUT /v1/game/equipment")).toHaveLength(1));
    expect(f.of("PUT /v1/game/equipment")[0]!.body).toEqual({ background_code: "bg_mint", frame_code: "frame_gold" });
  });
});

describe("the hero picker", () => {
  const H = (code: string, line: "robot" | "pet" | "human", name: string) => ({
    code,
    line,
    name: { ru: name, uz: name },
    tagline: { ru: "", uz: "" },
    stages: [1, 2, 3].map((s) => ({ stage: s, name: { ru: `Ступень ${s}`, uz: `${s}` }, image: img(`${code}-${s}`), skills_required: [0, 5, 15][s - 1] })),
  });
  const HEROES = { items: [H("robot_0", "robot", "Робот Вольт"), H("pet_0", "pet", "Дракончик Мятик"), H("human_0", "human", "Ученица Нилу")], selected: null, stage: 1 };
  it("a child: dragons first, the first dragon focused; PUT with the code; onDone with the summary", async () => {
    let done: string | null = null;
    const f = mount(<HeroPicker layout="screen" onDone={(_s, h) => (done = h.code)} />, { "GET /v1/game/heroes": [200, HEROES], "PUT /v1/game/hero": [200, SUMMARY] }, true);
    const tiles = await screen.findAllByRole("button", { pressed: false });
    expect(screen.getByTestId("hero-pet_0")).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelectorAll(".hero-tile")[0]).toHaveAttribute("data-testid", "hero-pet_0");
    expect(tiles.length).toBeGreaterThan(0);
    expect(screen.getByTestId("hero-detail-name")).toHaveTextContent("Дракончик Мятик");
    expect(screen.getByTestId("hero-stage-2")).toHaveTextContent("от 5 навыков");
    await userEvent.click(screen.getByTestId("hero-choose"));
    await waitFor(() => expect(done).toBe("pet_0"));
    expect(f.of("PUT /v1/game/hero")[0]!.body).toEqual({ hero_code: "pet_0" });
    expect(await screen.findByTestId("toast")).toHaveTextContent("Твой герой — Дракончик Мятик");
  });
  it("onboarding: «Пропустить» and no network calls before the choice", async () => {
    let skipped = false;
    const f = mount(<HeroPicker layout="onboarding" initial={HEROES as never} onDone={() => undefined} onSkip={() => (skipped = true)} />, {});
    expect(await screen.findByTestId("ob-step-hero")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("hero-skip"));
    expect(skipped).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
});

describe("the motivation settings", () => {
  it("a child: the news of badges come to the notifications of the profile (no push, no digest)", async () => {
    mount(<GameSettingsScreen />, { "GET /v1/game/settings": [200, { ...SETTINGS, celebrations: "quiet" }] }, true);
    const row = (await screen.findByTestId("gs-notif")).closest("label")!;
    expect(row).toHaveTextContent("Новости о значках приходят в уведомления твоего профиля.");
    expect(row).not.toHaveTextContent(/сводк|push/i);
    expect(screen.getByTestId("gs-quiet")).toBeChecked();
  });
  it("each switch is saved at once; a failure puts it back with the error text", async () => {
    const f = mount(<GameSettingsScreen />, {
      "GET /v1/game/settings": [200, SETTINGS],
      "PATCH /v1/game/settings": [(b) => [200, { ...SETTINGS, ...(b as object) }], err(503, "GAME_UNAVAILABLE")],
    });
    const quiet = await screen.findByTestId("gs-quiet");
    await userEvent.click(quiet);
    await waitFor(() => expect(f.of("PATCH /v1/game/settings")).toHaveLength(1));
    expect(f.of("PATCH /v1/game/settings")[0]!.body).toEqual({ celebrations: "quiet" });
    await waitFor(() => expect(quiet).toBeChecked());
    await waitFor(() => expect(screen.getByTestId("gs-auto-freeze")).toBeEnabled());
    await userEvent.click(screen.getByTestId("gs-auto-freeze"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Игра временно недоступна — учёба работает как обычно.");
    expect(screen.getByTestId("gs-auto-freeze")).toBeChecked();
    expect(screen.getByTestId("gs-learning")).toHaveTextContent("Игра не меняет учёбу");
  });
});

describe("the history and badges", () => {
  it("a staff operation reads «Корректировка поддержки»; the filter goes to the query", async () => {
    const page = {
      items: [
        { op_id: "o1", currency: "til", amount: 15, reason: "manual", capped: false, multiplier: 1, status: "confirmed", created_at: "2026-11-16T17:00:00Z", comment: "внутренний комментарий" },
        { op_id: "o2", currency: "til", amount: -40, reason: "shop", capped: false, multiplier: 1, status: "confirmed", created_at: "2026-11-16T16:00:00Z" },
      ],
      next_cursor: null,
    };
    const f = mount(<GameHistoryScreen />, { "GET /v1/game/history": [200, page], "GET /v1/game/summary": [200, SUMMARY] });
    expect(await screen.findByTestId("hist-o1")).toHaveTextContent("Корректировка поддержки");
    expect(screen.getByTestId("hist-o1")).toHaveTextContent("+15 тилов");
    expect(document.body.textContent).not.toContain("внутренний комментарий");
    expect(screen.getByTestId("hist-amt-o2")).toHaveTextContent("−40 тилов");
    await userEvent.click(within(screen.getByTestId("hist-filter")).getByRole("button", { name: "Тилы" }));
    await waitFor(() => expect(f.of("GET /v1/game/history").at(-1)!.url.searchParams.get("currency")).toBe("til"));
  });
  it("badges: the basis opens on request; the open one has the progress", async () => {
    mount(<BadgesScreen />, {
      "GET /v1/game/badges": [
        200,
        {
          items: [
            { code: "streak_7", title: { ru: "Неделя подряд", uz: "x" }, description: { ru: "7 дней", uz: "x" }, image: null, earned_at: null, basis: { metric: "streak", value: 4, threshold: 7 } },
            { code: "first_lesson", title: { ru: "Первый урок", uz: "x" }, description: { ru: "Пройден урок", uz: "x" }, image: null, earned_at: "2026-11-12T15:20:00Z", basis: { metric: "lessons", value: 1, threshold: 1 } },
          ],
        },
      ],
    });
    const btn = await screen.findByTestId("badge-first_lesson-basis-btn");
    expect(screen.queryByTestId("badge-first_lesson-basis")).toBeNull();
    await userEvent.click(btn);
    expect(screen.getByTestId("badge-first_lesson-basis")).toHaveTextContent("Пройдено уроков: 1 (нужно 1).");
    expect(screen.getByTestId("badge-streak_7-progress")).toHaveTextContent("4 из 7");
    // earned first
    expect(screen.getByTestId("badges-earned")).toContainElement(screen.getByTestId("badge-first_lesson"));
  });
});

describe("Telegram popups: one at a time", () => {
  it("a second showPopup while the native one is open resolves null at once — no second dialog", async () => {
    const tg = installTg({ version: "8.0" });
    let close: ((id: string) => void) | null = null;
    const native = vi.fn((_p: unknown, cb: (id: string) => void) => {
      close = cb;
    });
    tg.wa.showPopup = native;
    const first = confirmPopup({ title: "Купить?", message: "Спишем 40 тилов.", ok: "Купить", cancel: "Отмена" });
    const second = await showPopup({ title: "Купить?", message: "x", buttons: [{ id: "ok", text: "Купить" }] });
    expect(second).toBeNull();
    expect(native).toHaveBeenCalledTimes(1);
    close!("ok");
    expect(await first).toBe(true);
    // closed — the next one is shown again
    const third = showPopup({ title: "t", message: "m", buttons: [{ id: "ok", text: "OK" }] });
    expect(native).toHaveBeenCalledTimes(2);
    close!("");
    expect(await third).toBeNull();
  });
  it("Telegram answers WebAppPopupOpened (another popup of the client): dropped, not drawn in the app", async () => {
    const tg = installTg({ version: "8.0" });
    tg.wa.showPopup = () => {
      throw new Error("WebAppPopupOpened");
    };
    expect(await showPopup({ title: "t", message: "m", buttons: [{ id: "ok", text: "OK" }] })).toBeNull();
  });
});
