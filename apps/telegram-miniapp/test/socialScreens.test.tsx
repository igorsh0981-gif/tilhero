/**
 * Sprint 7 — social screens on a scripted BFF: a friend request lost on the way is re-sent with the same Idempotency-Key
 * (one request on the server); the pair room joins, long-polls with after_seq, re-sends a lost turn with the same key,
 * shows whose turn it is, and aborts the poll in flight when the screen goes away; a child gets choices only; a duel
 * challenge; the family league of a child without places.
 */
import type { LearningPlan, PairRoomState, PairRoomView, SessionResponse } from "@tilhero/contracts/bff";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createBff } from "../src/api/bff";
import { ApiClient } from "../src/api/client";
import { FALLBACK_CONFIG } from "../src/config/experience";
import { I18nProvider } from "../src/i18n";
import { FriendsScreen } from "../src/screens/social/Friends";
import { DuelScreen } from "../src/screens/social/Duels";
import { LeaguesScreen } from "../src/screens/social/Leagues";
import { SanctionsScreen } from "../src/screens/social/Moderation";
import { ReferralsScreen } from "../src/screens/social/Referrals";
import { PairRoomScreen } from "../src/screens/social/PairRoom";
import { NicknameSheet } from "../src/screens/social/parts";
import { AppProvider, type AppCtx } from "../src/state/app";
import { useNav } from "../src/state/nav";
import { PopupHost, ToastHost } from "../src/ui/overlays";

const ME = "6f1c2b3a-1111-4a2b-9c3d-000000000001";
const KID = "7a1c2b3a-2222-4a2b-9c3d-000000000001";
const ROOM = "a0000000-aaaa-4bbb-8ccc-000000000001";

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
    consent: { accepted: true, policy_version: "1.2", current_policy_version: "1.2", accepted_at: "2026-11-10T08:00:00Z", evidence_hash: "sha256:x", purposes: ["terms", "privacy", "learning", "social"] },
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

type Reply =
  | [number, unknown]
  | ((body: unknown, url: URL, signal: AbortSignal | undefined) => [number, unknown] | Promise<[number, unknown]>)
  | "network"
  | "hang";
interface Call {
  key: string;
  url: URL;
  body: unknown;
  headers: Record<string, string>;
  signal: AbortSignal | null | undefined;
}
const err = (status: number, code: string, details: Record<string, unknown> = {}): [number, unknown] => [status, { code, message: code, trace_id: "t", details }];

function fakeBff(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) && typeof v[0] !== "number" ? [...(v as Reply[])] : [v as Reply]]));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ key, url, body, headers: (init?.headers ?? {}) as Record<string, string>, signal: init?.signal });
    const q = queues.get(key);
    const r = q ? (q.length > 1 ? q.shift()! : q[0]!) : err(404, "NOT_FOUND");
    if (r === "network") throw new TypeError("Failed to fetch");
    if (r === "hang") {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    const [status, payload] = typeof r === "function" ? await r(body, url, init?.signal ?? undefined) : r;
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
        {nav.top ? <p data-testid="pushed">{JSON.stringify(nav.top)}</p> : null}
        {children}
        <PopupHost />
        <ToastHost />
      </div>
    </AppProvider>
  );
}

function mount(ui: ReactNode, routes: Record<string, Reply | Reply[]>, kid = false) {
  const f = fakeBff(routes);
  const r = render(
    <I18nProvider initial="ru">
      <Shell kid={kid} bff={f.bff}>
        {ui}
      </Shell>
    </I18nProvider>,
  );
  return { ...f, unmount: r.unmount };
}

const COMMUNITY = {
  member_id: "mb_me0000000000000000000",
  nickname: "Aziz_TH",
  friend_code: "TH-7QKD-M3PX",
  game_profile_hidden: false,
  restrictions: { social_ban: false, social_ban_until: null },
  nickname_change_available_at: null,
  friends_available: true,
  friends_unavailable_reason: null,
};
const EMPTY = { items: [], next_cursor: null };

describe("«Друзья»", () => {
  it("a lost answer of «Добавить» is re-sent with the same Idempotency-Key; the card becomes «Заявка отправлена»", async () => {
    const card = { member_id: "mb_dilnoza0000000000000", nickname: "Dilnoza", relation: "none", request_id: null };
    const sent = { request_id: "f2000000-aaaa-4bbb-8ccc-000000000009", direction: "out", member_id: card.member_id, nickname: "Dilnoza", status: "pending", created_at: "2026-11-21T10:00:00Z", decided_at: null };
    const f = mount(<FriendsScreen />, {
      "GET /v1/community": [200, COMMUNITY],
      "GET /v1/friends": [200, EMPTY],
      "GET /v1/friends/requests": [200, EMPTY],
      "GET /v1/friends/search": [200, { items: [card] }],
      "POST /v1/friends/requests": ["network", [201, sent]],
    });
    await userEvent.type(await screen.findByTestId("fr-search-input"), "TH-DLNZ-4567");
    await userEvent.click(screen.getByTestId("fr-search-go"));
    await userEvent.click(await screen.findByTestId("fr-add"));
    // the answer was lost: the error under the card, the button stays
    expect(await within(screen.getByTestId("fr-found")).findByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("fr-add"));
    await waitFor(() => expect(screen.getByTestId("fr-found")).toHaveAttribute("data-relation", "request_out"));
    const posts = f.of("POST /v1/friends/requests");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.headers["Idempotency-Key"]).toBe(posts[1]!.headers["Idempotency-Key"]);
    expect(posts[1]!.body).toEqual({ member_id: card.member_id });
    // privacy: nobody's name — the nickname only
    expect(document.body.textContent).not.toMatch(/Азиз/);
  });

  it("a child — «Моя семья» instead of friends: no requests to the friends API", async () => {
    const f = mount(<FriendsScreen />, {
      "GET /v1/family": [200, { family_id: "f", members: [{ user_id: "u1", member_id: "mb_parent00000000000000", display_name: "Азиз", role: "owner", is_me: false }, { user_id: KID, member_id: "mb_me0000000000000000000", display_name: "Мадина", role: "child", is_me: true }] }],
      "GET /v1/game/leagues": err(503, "GAME_UNAVAILABLE"),
    }, true);
    expect(await screen.findByTestId("kid-family")).toBeInTheDocument();
    expect(screen.getByTestId("kid-member")).toHaveTextContent("Участник семьи");
    expect(document.body.textContent).not.toMatch(/Азиз|Мадина/);
    expect(f.calls.some((c) => c.key.startsWith("GET /v1/friends") || c.key === "GET /v1/community")).toBe(false);
  });
});

describe("leagues of a child", () => {
  it("only the family, no places, «вместе набрали»", async () => {
    const row = (id: string, nickname: string | null, xp: number, place: number, me = false) => ({ member_id: id, nickname, hero: null, xp, place, badges: [], me });
    mount(<LeaguesScreen />, {
      "GET /v1/game/leagues": [200, {
        week: "2026-11-16",
        ends_at: "2026-11-22T19:00:00Z",
        friends: null,
        family: { rows: [row("mb_a", "Aziz_TH", 180, 1), row("mb_me", null, 140, 2, true), row("mb_b", null, 60, 3)], me_row: null, participants: 3, total_xp: 380 },
        general: { opt_in: false, available: false, unavailable_reason: "kids", pair_id: null, level_band: null, group: null, prizes: [50, 30, 20] },
      }],
    }, true);
    expect(await screen.findByTestId("lg-table-family")).toBeInTheDocument();
    expect(screen.queryByTestId("lg-tabs")).toBeNull();
    expect(screen.getByTestId("lg-total")).toHaveTextContent("Вместе вы набрали 380 XP — так держать!");
    expect(document.querySelectorAll(".lg-place")).toHaveLength(0);
    expect(screen.getByTestId("lg-me")).toHaveAttribute("aria-label", "Ты: 140 XP");
    expect(screen.getByTestId("leagues").textContent).not.toMatch(/место|последн|Общая/);
  });
});

/* ---------------------------------------------------------------- the pair room */

const VIEW: PairRoomView = {
  room_id: ROOM,
  status: "in_progress",
  side: "inviter",
  partner: { member_id: "mb_malika0000000000000", nickname: "Malika_23", hero: null },
  pair_id: "ru-en",
  scenario: { scenario_id: "sc-cafe-order", title: { ru: "Заказ в кафе", uz: "Kafeda buyurtma" }, level: "A1" },
  mode: "free",
  start_at: "2026-11-21T10:00:00Z",
  respond_until: null,
  created_at: "2026-11-21T09:59:00Z",
  started_at: "2026-11-21T10:00:00Z",
  ended_at: null,
  end_reason: null,
  my_role: "A",
  can_accept: false,
  can_join: true,
  minutes: 0,
  report_available: false,
};
function st(over: Partial<PairRoomState> = {}): PairRoomState {
  return {
    room_id: ROOM,
    status: "in_progress",
    seq: 3,
    events: [
      { seq: 1, kind: "roles", role: null, text: null, at: "2026-11-21T10:00:00Z" },
      { seq: 2, kind: "coach", role: null, text: "Welcome, team!", at: "2026-11-21T10:00:01Z" },
      { seq: 3, kind: "coach", role: null, text: "Greet the waiter.", at: "2026-11-21T10:00:02Z" },
    ],
    mode: "free",
    my_role: "A",
    my_role_brief: "You are the guest.",
    team_goal: "Order two drinks.",
    team_goal_progress: 0,
    next_speaker: "A",
    prompt: "Greet the waiter.",
    prompt_gloss: "Поздоровайтесь.",
    options: null,
    participants: [
      { role: "A", me: true, network: "online" },
      { role: "B", me: false, network: "online" },
    ],
    ai_degraded: false,
    voice_available: false,
    my_speaking_seconds: 0,
    ...over,
  };
}

describe("the pair room", () => {
  it("join → long-poll after the last seq; a lost turn goes again with the same key; leaving aborts the poll", async () => {
    const afterTurn = st({ seq: 4, events: [{ seq: 4, kind: "turn", role: "A", text: "Hello!", at: "2026-11-21T10:00:05Z" }], next_speaker: "B", prompt: null, prompt_gloss: null, my_speaking_seconds: 6 });
    const f = mount(<PairRoomScreen id={ROOM} />, {
      [`GET /v1/pair-rooms/${ROOM}`]: [200, VIEW],
      [`POST /v1/pair-rooms/${ROOM}/join`]: [200, st()],
      [`GET /v1/pair-rooms/${ROOM}/state`]: "hang",
      [`POST /v1/pair-rooms/${ROOM}/turns`]: ["network", [200, afterTurn]],
    });
    expect(await screen.findByTestId("room-turn")).toHaveTextContent("Ваш ход");
    // the feed is polled after everything seen (the first poll asks from 0: the whole feed after a reconnection)
    await waitFor(() => expect(f.of(`GET /v1/pair-rooms/${ROOM}/state`).length).toBeGreaterThan(0));
    expect(f.of(`GET /v1/pair-rooms/${ROOM}/state`)[0]!.url.searchParams.get("after_seq")).toMatch(/^(0|3)$/);
    await userEvent.type(screen.getByTestId("room-input"), "Hello!");
    await userEvent.click(screen.getByTestId("room-send"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // the text stays for the retry
    expect(screen.getByTestId("room-input")).toHaveValue("Hello!");
    await userEvent.click(screen.getByTestId("room-send"));
    await waitFor(() => expect(screen.getByTestId("room-turn")).toHaveTextContent("Ход партнёра: Malika_23"));
    const turns = f.of(`POST /v1/pair-rooms/${ROOM}/turns`);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.headers["Idempotency-Key"]).toBe(turns[1]!.headers["Idempotency-Key"]);
    expect(turns[1]!.body).toEqual({ text: "Hello!" });
    expect(screen.getByTestId("room-me")).toHaveTextContent("Hello!");
    expect(screen.getByTestId("room-seconds")).toHaveTextContent("Ваше время речи: 6 с");
    // leaving the screen: the poll in flight is aborted
    const inFlight = f.of(`GET /v1/pair-rooms/${ROOM}/state`).at(-1)!;
    expect(inFlight.signal?.aborted).toBe(false);
    act(() => f.unmount());
    expect(inFlight.signal?.aborted).toBe(true);
  });

  it("a child: choices only — no text field and no voice; the choice goes as {choice_id}", async () => {
    const opts = [{ choice_id: "c1", text_en: "Hello! A table, please." }, { choice_id: "c2", text_en: "Hi!" }];
    const f = mount(<PairRoomScreen id={ROOM} />, {
      [`GET /v1/pair-rooms/${ROOM}`]: [200, { ...VIEW, mode: "choices" }],
      [`POST /v1/pair-rooms/${ROOM}/join`]: [200, st({ mode: "choices", options: opts })],
      [`GET /v1/pair-rooms/${ROOM}/state`]: "hang",
      [`POST /v1/pair-rooms/${ROOM}/turns`]: [200, st({ seq: 4, mode: "choices", next_speaker: "B", options: null, events: [{ seq: 4, kind: "turn", role: "A", text: "Hi!", at: "2026-11-21T10:00:05Z" }] })],
    }, true);
    expect(await screen.findByTestId("room-turn")).toHaveTextContent("Твой ход");
    expect(screen.getByTestId("room-options")).toHaveTextContent("Выбери реплику");
    expect(screen.queryByTestId("room-input")).toBeNull();
    expect(screen.queryByTestId("room-voice")).toBeNull();
    await userEvent.click(screen.getByTestId("room-opt-c2"));
    await waitFor(() => expect(f.of(`POST /v1/pair-rooms/${ROOM}/turns`)).toHaveLength(1));
    expect(f.of(`POST /v1/pair-rooms/${ROOM}/turns`)[0]!.body).toEqual({ choice_id: "c2" });
    act(() => f.unmount());
  });

  it("the room is gone on join (ROOM_NOT_ACTIVE) — the screen shows how it ended, with the report", async () => {
    let view: PairRoomView = VIEW;
    mount(<PairRoomScreen id={ROOM} />, {
      [`GET /v1/pair-rooms/${ROOM}`]: () => [200, view],
      [`POST /v1/pair-rooms/${ROOM}/join`]: () => {
        view = { ...VIEW, status: "finished", end_reason: "completed", report_available: true, minutes: 7 };
        return err(409, "ROOM_NOT_ACTIVE", { status: "finished" });
      },
    });
    expect(await screen.findByTestId("pair-ended")).toBeInTheDocument();
    expect(screen.getByTestId("pair-end-reason")).toHaveTextContent("Сценарий завершён.");
    expect(screen.getByTestId("pair-ended")).toHaveTextContent("Минут: 7 — учтены, не списаны");
    await userEvent.click(screen.getByTestId("pair-to-report"));
    expect(screen.getByTestId("pushed")).toHaveTextContent('"pairReport"');
  });
});

/* ---------------------------------------------------------------- the pair room after the review (F7-1…F7-5) */

/** a request that waits until the screen aborts it (the long-poll in flight) */
const hang = (signal: AbortSignal | undefined) =>
  new Promise<[number, unknown]>((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
/** a request the test answers when it wants */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}
/** the app goes to the background / comes back (document visibility; Telegram deactivated / activated do the same) */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  document.dispatchEvent(new Event("visibilitychange"));
}
const settleAll = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

describe("the pair room after the review", () => {
  const STATE = `GET /v1/pair-rooms/${ROOM}/state`;
  const JOIN = `POST /v1/pair-rooms/${ROOM}/join`;

  it("F7-1: 409 ROOM_NOT_ACTIVE {waiting, start_at} on «Войти» — one join, then the lobby with the start time; no endless «подключаемся»", async () => {
    let early = false;
    const enter: PairRoomView = { ...VIEW, status: "waiting", started_at: null, my_role: null, start_at: "2026-11-22T10:00:00Z" };
    const f = mount(<PairRoomScreen id={ROOM} />, {
      [`GET /v1/pair-rooms/${ROOM}`]: () => [200, early ? { ...enter, can_join: false } : enter],
      [JOIN]: () => {
        early = true;
        return err(409, "ROOM_NOT_ACTIVE", { status: "waiting", start_at: "2026-11-22T10:00:00Z" });
      },
    });
    await userEvent.click(await screen.findByTestId("pair-enter"));
    await waitFor(() => expect(screen.getByTestId("pair-lobby")).toHaveAttribute("data-phase", "scheduled"));
    expect(screen.getByTestId("pair-scheduled")).toHaveTextContent("Урок начнётся");
    expect(screen.getByTestId("pair-scheduled")).toHaveTextContent("Войти можно за 5 минут до начала.");
    expect(screen.getByTestId("pair-cancel")).toBeInTheDocument();
    expect(screen.queryByTestId("pair-enter")).toBeNull();
    await settleAll();
    expect(f.of(JOIN)).toHaveLength(1);
    expect(f.of(STATE)).toHaveLength(0);
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    act(() => f.unmount());
  });

  it("F7-1/F7-2: the feed answers 409 ROOM_NOT_ACTIVE {abandoned} — the link ends at once and the lobby says I was away", async () => {
    let gone = false;
    const f = mount(<PairRoomScreen id={ROOM} />, {
      [`GET /v1/pair-rooms/${ROOM}`]: () => [200, gone ? { ...VIEW, can_join: false, minutes: 2 } : VIEW],
      [JOIN]: [200, st()],
      [STATE]: () => {
        gone = true;
        return err(409, "ROOM_NOT_ACTIVE", { status: "abandoned" });
      },
    });
    await waitFor(() => expect(screen.getByTestId("pair-lobby")).toHaveAttribute("data-phase", "away"));
    expect(screen.getByTestId("pair-away")).toHaveTextContent("Вы вышли из урока");
    expect(screen.getByTestId("pair-away")).toHaveTextContent("Вас не было больше 3 минут");
    expect(screen.queryByTestId("room-reconnect")).toBeNull();
    expect(screen.queryByTestId("pair-enter")).toBeNull();
    await settleAll();
    expect(f.of(STATE)).toHaveLength(1);
    expect(f.of(JOIN)).toHaveLength(1);
    act(() => f.unmount());
  });

  it("F7-3: the app hidden — the poll is aborted; visible again — join and the feed after the last seq", async () => {
    const back = st({ seq: 5, events: [{ seq: 4, kind: "turn", role: "B", text: "Hi there!", at: "2026-11-21T10:01:00Z" }, { seq: 5, kind: "coach", role: null, text: "Your turn.", at: "2026-11-21T10:01:01Z" }] });
    const f = mount(<PairRoomScreen id={ROOM} />, {
      [`GET /v1/pair-rooms/${ROOM}`]: [200, VIEW],
      [JOIN]: [[200, st()], [200, back]],
      [STATE]: (_b, _u, signal) => hang(signal),
    });
    expect(await screen.findByTestId("room-turn")).toHaveTextContent("Ваш ход");
    await waitFor(() => expect(f.of(STATE)).toHaveLength(1));
    const first = f.of(STATE)[0]!;
    expect(first.url.searchParams.get("after_seq")).toBe("3");
    try {
      act(() => setHidden(true));
      expect(first.signal?.aborted).toBe(true);
      await settleAll();
      expect(f.of(STATE)).toHaveLength(1);
      expect(f.of(JOIN)).toHaveLength(1);
      act(() => setHidden(false));
      await waitFor(() => expect(f.of(JOIN)).toHaveLength(2));
      await waitFor(() => expect(f.of(STATE)).toHaveLength(2));
      expect(f.of(STATE)[1]!.url.searchParams.get("after_seq")).toBe("5");
      expect(f.of(STATE)[1]!.signal?.aborted).toBe(false);
      expect(await screen.findByTestId("room-partner")).toHaveTextContent("Hi there!");
      act(() => f.unmount());
      expect(f.of(STATE)[1]!.signal?.aborted).toBe(true);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it("F7-4/F7-21: «Выйти» failed — no join by itself: the error, «Выйти ещё раз», «Вернуться в урок»; while leaving a return of the app does not join", async () => {
    const g = gate();
    const LEAVE = `POST /v1/pair-rooms/${ROOM}/leave`;
    const f = mount(<PairRoomScreen id={ROOM} />, {
      [`GET /v1/pair-rooms/${ROOM}`]: [200, VIEW],
      [JOIN]: [200, st()],
      [STATE]: (_b, _u, signal) => hang(signal),
      [LEAVE]: [
        "network",
        async () => {
          await g.opened;
          return err(503, "UPSTREAM_UNAVAILABLE", { service: "lessons" });
        },
      ],
    });
    expect(await screen.findByTestId("room-turn")).toHaveTextContent("Ваш ход");
    const leave = async () => {
      await userEvent.click(screen.getByTestId("room-leave"));
      await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Выйти" }));
    };
    try {
      // the first try is lost: the learner stays out of the lesson — the error and «Выйти ещё раз», no join
      await leave();
      expect(await screen.findByTestId("room-leave-failed")).toHaveTextContent("Не получилось выйти из урока.");
      expect(screen.getByTestId("room-leave-again")).toBeInTheDocument();
      expect(screen.queryByTestId("room-foot")).toBeNull();
      expect(f.of(STATE).every((c) => c.signal?.aborted)).toBe(true);
      // the app hidden and shown again — still no join
      act(() => setHidden(true));
      act(() => setHidden(false));
      await settleAll();
      expect(f.of(JOIN)).toHaveLength(1);
      // «Вернуться в урок» — only by the learner's choice
      await userEvent.click(screen.getByTestId("room-stay"));
      await waitFor(() => expect(f.of(JOIN)).toHaveLength(2));
      expect(await screen.findByTestId("room-foot")).toBeInTheDocument();

      // the second try hangs: hiding and showing the app while leaving does not join (F7-21)
      await leave();
      await waitFor(() => expect(f.of(LEAVE)).toHaveLength(2));
      expect(screen.getByTestId("room-exiting")).toHaveTextContent("Выходим из урока…");
      act(() => setHidden(true));
      act(() => setHidden(false));
      await settleAll();
      expect(f.of(JOIN)).toHaveLength(2);
      // «Назад» while it is in flight, then it fails: no join, no poll after the screen is gone (F7-4)
      const polls = f.of(STATE).length;
      act(() => f.unmount());
      g.open();
      await settleAll();
      expect(f.of(JOIN)).toHaveLength(2);
      expect(f.of(STATE)).toHaveLength(polls);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it("F7-21: «Пожаловаться и заблокировать» — the exit failed: the error and «Выйти ещё раз», never back into the lesson", async () => {
    const LEAVE = `POST /v1/pair-rooms/${ROOM}/leave`;
    const f = mount(<PairRoomScreen id={ROOM} />, {
      [`GET /v1/pair-rooms/${ROOM}`]: [200, VIEW],
      [JOIN]: [200, st()],
      [STATE]: (_b, _u, signal) => hang(signal),
      ["POST /v1/complaints"]: [201, { case_id: "c0000000-aaaa-4bbb-8ccc-000000000001", blocked: true }],
      [LEAVE]: ["network", [200, { ...VIEW, status: "in_progress" }]],
    });
    expect(await screen.findByTestId("room-turn")).toHaveTextContent("Ваш ход");
    await userEvent.click(screen.getByTestId("room-complain"));
    await userEvent.click(await screen.findByTestId("cmp-abuse"));
    await userEvent.click(screen.getByTestId("cmp-block"));
    await userEvent.click(screen.getByTestId("cmp-send"));
    expect(await screen.findByTestId("room-leave-failed")).toHaveTextContent("Не получилось выйти из урока.");
    // after a block there is no «Вернуться в урок»: only «Выйти ещё раз»
    expect(screen.queryByTestId("room-stay")).toBeNull();
    expect(screen.queryByTestId("room-complain")).toBeNull();
    await settleAll();
    expect(f.of(JOIN)).toHaveLength(1);
    await userEvent.click(screen.getByTestId("room-leave-again"));
    await waitFor(() => expect(f.of(LEAVE)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId("room-leave-failed")).toBeNull());
    expect(f.of(JOIN)).toHaveLength(1);
    expect(f.of("POST /v1/complaints")[0]!.body).toMatchObject({ subject_kind: "pair_room", subject_id: ROOM, block: true });
    act(() => f.unmount());
  });

  it("F7-5: a lost answer of a turn (taken by the server) — the next turn with the same choice c1 goes with a NEW key", async () => {
    const opts = [{ choice_id: "c1", text_en: "Hello! A table, please." }, { choice_id: "c2", text_en: "Hi!" }];
    const next = [{ choice_id: "c1", text_en: "Two teas, please." }, { choice_id: "c2", text_en: "A latte, please." }];
    const g = gate();
    let polls = 0;
    const fed = st({
      seq: 6,
      mode: "choices",
      options: next,
      prompt: "Order two drinks.",
      my_speaking_seconds: 5,
      events: [
        { seq: 4, kind: "turn", role: "A", text: "Hello! A table, please.", at: "2026-11-21T10:00:05Z" },
        { seq: 5, kind: "turn", role: "B", text: "Of course!", at: "2026-11-21T10:00:06Z" },
        { seq: 6, kind: "coach", role: null, text: "Order two drinks.", at: "2026-11-21T10:00:07Z" },
      ],
    });
    const f = mount(<PairRoomScreen id={ROOM} />, {
      [`GET /v1/pair-rooms/${ROOM}`]: [200, { ...VIEW, mode: "choices" }],
      [JOIN]: [200, st({ mode: "choices", options: opts })],
      [STATE]: async (_b, _u, signal) => {
        polls += 1;
        if (polls > 1) return hang(signal);
        await g.opened;
        return [200, fed];
      },
      [`POST /v1/pair-rooms/${ROOM}/turns`]: ["network", [200, st({ seq: 7, mode: "choices", next_speaker: "B", options: null, events: [{ seq: 7, kind: "turn", role: "A", text: "Two teas, please.", at: "2026-11-21T10:00:09Z" }] })]],
    }, true);
    expect(await screen.findByTestId("room-turn")).toHaveTextContent("Твой ход");
    await userEvent.click(screen.getByTestId("room-opt-c1"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // the feed brings the turn taken on the server, the partner's answer and my next turn
    g.open();
    await waitFor(() => expect(screen.getByTestId("room-opt-c1")).toHaveTextContent("Two teas, please."));
    expect(screen.getAllByTestId("room-me")).toHaveLength(1);
    await userEvent.click(screen.getByTestId("room-opt-c1"));
    await waitFor(() => expect(screen.getByTestId("room-turn")).toHaveTextContent("Ход партнёра"));
    const turns = f.of(`POST /v1/pair-rooms/${ROOM}/turns`);
    expect(turns).toHaveLength(2);
    expect(turns.map((c) => c.body)).toEqual([{ choice_id: "c1" }, { choice_id: "c1" }]);
    expect(turns[1]!.headers["Idempotency-Key"]).not.toBe(turns[0]!.headers["Idempotency-Key"]);
    expect(screen.getAllByTestId("room-me")).toHaveLength(2);
    act(() => f.unmount());
  });

  it("F7-12: lessons down on the pair screen — a neutral «эта часть недоступна», never «друзья, лиги и дуэли»", async () => {
    const f = mount(<PairRoomScreen id={ROOM} />, {
      [`GET /v1/pair-rooms/${ROOM}`]: err(503, "UPSTREAM_UNAVAILABLE", { service: "lessons" }),
    });
    expect(await screen.findByTestId("social-error")).toHaveTextContent("Эта часть сейчас недоступна — учёба работает как обычно.");
    expect(screen.getByTestId("social-error")).not.toHaveTextContent("Друзья, лиги и дуэли");
    act(() => f.unmount());
  });

  it("a room without the coach (budget, outage or the daily limit of coach rooms): a neutral note and choices, no error", async () => {
    const opts = [{ choice_id: "c1", text_en: "Hello! A table, please." }];
    const f = mount(<PairRoomScreen id={ROOM} />, {
      [`GET /v1/pair-rooms/${ROOM}`]: [200, VIEW],
      [JOIN]: [200, st({ mode: "choices", ai_degraded: true, options: opts, events: [...st().events, { seq: 4, kind: "mode_changed", role: null, text: null, at: "2026-11-21T10:00:03Z" }], seq: 4 })],
      [STATE]: (_b, _u, signal) => hang(signal),
    });
    expect(await screen.findByTestId("room-degraded")).toHaveTextContent("Этот урок идёт без ИИ-коуча — продолжаем по сценарию с выбором реплик.");
    expect(screen.getByTestId("room-opt-c1")).toBeInTheDocument();
    expect(screen.queryByTestId("room-input")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => f.unmount());
  });

  it("F7-6: «Пожаловаться» inside the room — the subject is the room; a child has no such button", async () => {
    const f = mount(<PairRoomScreen id={ROOM} />, {
      [`GET /v1/pair-rooms/${ROOM}`]: [200, VIEW],
      [JOIN]: [200, st()],
      [STATE]: (_b, _u, signal) => hang(signal),
      ["POST /v1/complaints"]: [201, { complaint_id: "c1", status: "received" }],
    });
    expect(await screen.findByTestId("room-turn")).toHaveTextContent("Ваш ход");
    await userEvent.click(screen.getByTestId("room-complain"));
    await userEvent.click(await screen.findByTestId("cmp-spam"));
    await userEvent.click(screen.getByTestId("cmp-send"));
    await waitFor(() => expect(f.of("POST /v1/complaints")).toHaveLength(1));
    expect(f.of("POST /v1/complaints")[0]!.body).toEqual({ member_id: VIEW.partner.member_id, subject_kind: "pair_room", subject_id: ROOM, reason: "spam" });
    // no block: the learner stays in the room
    expect(f.of(`POST /v1/pair-rooms/${ROOM}/leave`)).toHaveLength(0);
    act(() => f.unmount());

    const k = mount(<PairRoomScreen id={ROOM} />, {
      [`GET /v1/pair-rooms/${ROOM}`]: [200, { ...VIEW, mode: "choices" }],
      [JOIN]: [200, st({ mode: "choices", options: [{ choice_id: "c1", text_en: "Hi!" }] })],
      [STATE]: (_b, _u, signal) => hang(signal),
    }, true);
    expect(await screen.findByTestId("room-turn")).toHaveTextContent("Твой ход");
    expect(screen.queryByTestId("room-complain")).toBeNull();
    act(() => k.unmount());
  });
});

/* ---------------------------------------------------------------- the nickname after a reset by the moderator */

describe("the nickname sheet after a reset", () => {
  const later = () => new Date(Date.now() + 3 * 86_400_000).toISOString();

  it("429 NICKNAME_COOLDOWN {until} — the date, and no saving before it", async () => {
    const f = mount(<NicknameSheet current={null} availableAt={null} onSaved={() => undefined} onClose={() => undefined} />, {
      "PUT /v1/community/nickname": err(429, "NICKNAME_COOLDOWN", { until: later() }),
    });
    await userEvent.type(screen.getByTestId("nick-input"), "Aziz_New");
    await userEvent.click(screen.getByTestId("nick-save"));
    expect(await screen.findByTestId("nick-when")).toHaveTextContent(/^Задать новый ник можно \d/);
    expect(screen.getByTestId("nick-save")).toBeDisabled();
    expect(screen.getByTestId("nick-input")).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(f.of("PUT /v1/community/nickname")).toHaveLength(1);
    act(() => f.unmount());
  });

  it("opened from the general league (the screen does not know the date) — reads the profile and is locked at once", async () => {
    const f = mount(<NicknameSheet current={null} onSaved={() => undefined} onClose={() => undefined} />, {
      "GET /v1/community": [200, { ...COMMUNITY, nickname: null, nickname_change_available_at: later() }],
    });
    expect(await screen.findByTestId("nick-when")).toHaveTextContent("Задать новый ник можно");
    expect(screen.getByTestId("nick-save")).toBeDisabled();
    expect(f.of("PUT /v1/community/nickname")).toHaveLength(0);
    act(() => f.unmount());
  });

  it("the reset nickname (422 forbidden) and a taken one (409) — plain reasons; a nickname of my own changes «Сменить»", async () => {
    const f = mount(<NicknameSheet current={null} availableAt={null} onSaved={() => undefined} onClose={() => undefined} />, {
      "PUT /v1/community/nickname": [err(422, "NICKNAME_INVALID", { reason: "forbidden" }), err(409, "NICKNAME_TAKEN")],
    });
    const input = screen.getByTestId("nick-input");
    await userEvent.type(input, "Bad_Boy_TH");
    await userEvent.click(screen.getByTestId("nick-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Такой ник нельзя — выберите другой.");
    await userEvent.clear(input);
    await userEvent.type(input, "Malika_23");
    await userEvent.click(screen.getByTestId("nick-save"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Этот ник уже занят — выберите другой."));
    expect(screen.queryByTestId("nick-when")).toBeNull();
    act(() => f.unmount());

    const g = mount(<NicknameSheet current="Aziz_TH" availableAt={later()} onSaved={() => undefined} onClose={() => undefined} />, {});
    expect(screen.getByTestId("nick-when")).toHaveTextContent(/^Сменить ник можно \d/);
    act(() => g.unmount());
  });
});

/* ---------------------------------------------------------------- the second review: F7-14, F7-16, F7-22, F7-23 */

describe("the second review", () => {
  const later = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
  const row = (id: string, nickname: string | null, xp: number, place: number, badges: string[], me = false) => ({ member_id: id, nickname, hero: null, xp, place, badges, me });
  const leagues = (badges: string[]) => ({
    week: "2026-11-16",
    ends_at: "2026-11-22T19:00:00Z",
    friends: { rows: [row("mb_b", "Bek", 98, 1, badges), row("mb_me", "Aziz_TH", 40, 2, [], true)], me_row: null, participants: 2, total_xp: 138 },
    family: null,
    general: { opt_in: false, available: true, unavailable_reason: null, pair_id: "ru-en", level_band: "A2", group: null, prizes: [50, 30, 20] },
  });
  const badge = (code: string, ru: string) => ({ code, title: { ru, uz: ru }, description: { ru, uz: ru }, image: null, earned_at: null, basis: { metric: "streak", value: 0, threshold: 1 } });

  it("F7-14: badges outside the 9 named ones — the title from the game catalogue; nobody names it — «значок» once", async () => {
    const f = mount(<LeaguesScreen />, {
      "GET /v1/game/leagues": [200, leagues(["streak_100", "skills_50", "x_new"])],
      "GET /v1/game/badges": [200, { items: [badge("streak_100", "100 дней подряд"), badge("skills_50", "50 навыков")] }],
    });
    await waitFor(() => expect(screen.getAllByTestId("lg-row")[0]).toHaveAttribute("aria-label", "1 место: Bek, 98 XP, значки: 100 дней подряд, 50 навыков, значок"));
    expect(screen.getAllByTestId("lg-badges")[0]).toHaveAttribute("title", "100 дней подряд, 50 навыков, значок");
    act(() => f.unmount());

    // no catalogue: the known name stays, the others are «значок» — once
    const g = mount(<LeaguesScreen />, {
      "GET /v1/game/leagues": [200, leagues(["streak_7", "streak_100", "reviews_1000"])],
      "GET /v1/game/badges": err(503, "GAME_UNAVAILABLE"),
    });
    await waitFor(() => expect(g.of("GET /v1/game/badges")).toHaveLength(1));
    await settleAll();
    expect(screen.getAllByTestId("lg-row")[0]).toHaveAttribute("aria-label", "1 место: Bek, 98 XP, значки: Неделя подряд, значок");
    act(() => g.unmount());

    // only named badges — the catalogue is not asked for
    const h = mount(<LeaguesScreen />, { "GET /v1/game/leagues": [200, leagues(["streak_7", "first_lesson"])] });
    expect(await screen.findAllByTestId("lg-row")).toHaveLength(1);
    await settleAll();
    expect(h.of("GET /v1/game/badges")).toHaveLength(0);
    act(() => h.unmount());
  });

  it("F7-16: a child who did not play in time — never «Хорошая игра!» on the duel card", async () => {
    const duel = {
      duel_id: "d0000000-aaaa-4bbb-8ccc-000000000001",
      status: "finished",
      role: "challenger",
      opponent: { member_id: "mb_parent0000000000000", nickname: null, hero: null },
      pair_id: "ru-en",
      level_band: "A0-A1",
      created_at: "2026-11-19T10:00:00Z",
      accept_deadline: "2026-11-20T10:00:00Z",
      play_deadline: "2026-11-21T10:00:00Z",
      my_session: null,
      my_played: false,
      opponent_played: true,
      can_accept: false,
      can_play: false,
      result: { outcome: "loss", technical: true, my_score: null, opponent_score: { correct: 4, total: 5 }, xp: 0, version: 1 },
      finished_at: "2026-11-21T10:00:00Z",
    };
    const f = mount(<DuelScreen id={duel.duel_id} />, { [`GET /v1/game/duels/${duel.duel_id}`]: [200, duel] }, true);
    expect(await screen.findByTestId("duel-line")).toHaveTextContent("В этот раз сыграть не получилось");
    expect(screen.getByTestId("duel-outcome")).toHaveTextContent("В этот раз сыграть не получилось");
    expect(screen.getByTestId("duel").textContent).not.toMatch(/Хорошая игра/);
    act(() => f.unmount());

    // a child who played and lost — the soft line stays
    const g = mount(<DuelScreen id={duel.duel_id} />, { [`GET /v1/game/duels/${duel.duel_id}`]: [200, { ...duel, my_played: true, result: { ...duel.result, technical: false, my_score: { correct: 3, total: 5 } } }] }, true);
    expect(await screen.findByTestId("duel-line")).toHaveTextContent("Хорошая игра! В следующий раз получится.");
    act(() => g.unmount());
  });

  it("F7-22: the link «Когда можно задать ник» — by the server's date, not by 7 days counted here", async () => {
    const sanction = { sanction_id: "5a000000-aaaa-4bbb-8ccc-000000000003", kind: "nickname_reset", basis: "Ник нарушает правила сообщества.", decided_at: "2026-01-01T10:00:00Z", until: null, active: true, revoked_at: null, appeal: null, can_appeal: true };
    // decided long ago, but the server still gives a future date (a longer cooldown in the settings) — the link is there
    const f = mount(<SanctionsScreen />, {
      "GET /v1/sanctions": [200, { items: [sanction] }],
      "GET /v1/community": [200, { ...COMMUNITY, nickname: null, nickname_change_available_at: later() }],
    });
    expect(await screen.findByTestId("sanction-nick-note")).toHaveTextContent("Новый ник можно задать");
    expect(await screen.findByTestId("sanction-nick-when")).toHaveTextContent("Когда можно задать ник — в «Друзьях»");
    act(() => f.unmount());

    // decided just now, but the server says a nickname can be set already — no link
    const g = mount(<SanctionsScreen />, {
      "GET /v1/sanctions": [200, { items: [{ ...sanction, decided_at: new Date().toISOString() }] }],
      "GET /v1/community": [200, { ...COMMUNITY, nickname: null, nickname_change_available_at: null }],
    });
    expect(await screen.findByTestId("sanction-nick-note")).toBeInTheDocument();
    await waitFor(() => expect(g.of("GET /v1/community")).toHaveLength(1));
    await settleAll();
    expect(screen.queryByTestId("sanction-nick-when")).toBeNull();
    act(() => g.unmount());
  });

  it("F7-23 and legacy: a reward of the old rule — «Награда начислена ранее»; an expired invitation of the former programme — its own line, no reason", async () => {
    const prog = { diagnostic: true, diagnostic_required: true, lessons: 3, lessons_required: 3, days: 2, days_required: 2, window_ends_at: "2026-12-01T00:00:00Z" };
    const ref = (id: string, outcome: "rewarded" | "legacy", reward: { freeze: number; til: number } | null) => ({ referral_id: id, invitee_nickname: id === "r1" ? "Nodira" : "Bekzod", status: "rewarded", progress: prog, reward, reward_outcome: outcome, reject_code: null, legacy: outcome === "legacy", accepted_at: "2026-11-01T00:00:00Z" });
    const f = mount(<ReferralsScreen />, {
      "GET /v1/referrals": [200, {
        items: [
          ref("r1", "legacy", null),
          ref("r2", "rewarded", { freeze: 2, til: 0 }),
          { ...ref("r3", "rewarded", null), status: "expired", reward_outcome: null, legacy: true },
          { ...ref("r4", "rewarded", null), status: "expired", reward_outcome: null, reject_code: "window_expired" },
        ],
        next_cursor: null,
        terms: { campaign_version: 1, require_diagnostic: true, min_lessons: 3, min_days: 2, window_days: 30, inviter_reward: { freeze: 2, til: 0 }, invitee_reward: { freeze: 1, til: 0 }, monthly_cap: 5 },
        month: { qualified: 1, cap: 5 },
      }],
    });
    const rows = await screen.findAllByTestId("ref-row");
    expect(rows[0]).toHaveTextContent("Награда начислена ранее");
    expect(within(rows[0]!).queryByTestId("ref-row-reward")).toBeNull();
    expect(rows[1]).toHaveTextContent("Награда начислена");
    expect(rows[1]).not.toHaveTextContent("ранее");
    expect(within(rows[1]!).getByTestId("ref-row-reward")).toBeInTheDocument();
    // the former programme, expired: «Приглашение по прежней программе», no refusal reason
    expect(within(rows[2]!).getByTestId("ref-legacy")).toHaveTextContent("Приглашение по прежней программе");
    expect(within(rows[2]!).queryByTestId("ref-reason")).toBeNull();
    // an ordinary expired one keeps its reason and has no such line
    expect(within(rows[3]!).getByTestId("ref-reason")).toHaveTextContent("Причина: Условия не выполнены вовремя.");
    expect(within(rows[3]!).queryByTestId("ref-legacy")).toBeNull();
    act(() => f.unmount());
  });
});
