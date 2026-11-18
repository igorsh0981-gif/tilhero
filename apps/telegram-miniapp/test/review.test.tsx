/**
 * Sprint 1 review fixes (INTERNAL_API §11; review T-1, T-3, T-7; QA D-03, D-04): the parent code screen, the offer
 * after the first child profile, the teens a parent gave consent for, CONSENT_REQUIRED {social | terms}, the time window
 * of a child profile, X-Timezone and the texts of domain error codes.
 */
import type { LearningPlan, SessionResponse } from "@tilhero/contracts/bff";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createBff } from "../src/api/bff";
import { ApiClient } from "../src/api/client";
import { ApiError, BUSINESS_401, KNOWN_CODES, consentRequiredPurpose, errorText } from "../src/api/errors";
import { FALLBACK_CONFIG } from "../src/config/experience";
import { KID_WINDOW, inKidWindow, scheduleProblem, DEFAULT_SCHEDULE } from "../src/domain/schedule";
import { I18nProvider, makeI18n, pluralForm, translate, type Lang } from "../src/i18n";
import { ru } from "../src/i18n/ru";
import { uz } from "../src/i18n/uz";
import { GuardianSheet } from "../src/screens/deeplink/GuardianSheet";
import { InviteSheet } from "../src/screens/deeplink/InviteSheet";
import { Family } from "../src/screens/profile/Family";
import { LockScreen } from "../src/screens/lock/LockScreen";
import { PinResetPending, PinResetWaiting, hoursUntil } from "../src/screens/lock/PinFlows";
import { ParentCode } from "../src/screens/profile/ParentCode";
import { Profile } from "../src/screens/profile/Profile";
import { ScheduleScreen } from "../src/screens/profile/ScheduleScreen";
import { AppProvider, useApp, type AppCtx } from "../src/state/app";
import { useNav } from "../src/state/nav";
import { PopupHost, ToastHost } from "../src/ui/overlays";

const ME = "6f1c2b3a-1111-4a2b-9c3d-000000000001";
const pluralHours = (lang: Lang, n: number) => pluralForm(lang, n, translate(lang, "pc.reset.hours"));
const KID = "7a1c2b3a-2222-4a2b-9c3d-000000000001";
const TEEN = "8b1c2b3a-3333-4a2b-9c3d-000000000001";
const INVITE = "33333333-aaaa-4bbb-8ccc-0000000000aa";
const REQUIRED = ["terms", "privacy", "learning"];

function makeSession(o: { pin?: boolean; consent?: string[] | null; kid?: boolean; children?: boolean; age?: "18+" | null } = {}): SessionResponse {
  const self = { learner_id: ME, kind: "self" as const, display_name: "Азиз", age_band: o.age === undefined ? ("18+" as const) : o.age, is_active: !o.kid, onboarding_completed: true };
  const kid = { learner_id: KID, kind: "child" as const, display_name: "Мадина", age_band: "6-9" as const, is_active: !!o.kid, onboarding_completed: true };
  const consent = o.consent === undefined ? [...REQUIRED] : o.consent;
  return {
    access_token: "acc",
    expires_in: 900,
    refresh_token: "ref",
    account: { user_id: ME, display_name: "Азиз", username: null, locale: "ru", status: "ACTIVE", is_new: false, age_band: self.age_band, guardian_consent: "not_required" },
    learner: o.kid ? kid : self,
    learners: o.kid || o.children ? [self, kid] : [self],
    security: { pin_enabled: !!o.pin, pin_length: o.pin ? 4 : null, biometric_enabled: false, pin_required: false, locked_until: null, pin_reset_effective_at: null },
    consent: consent
      ? { accepted: true, policy_version: "1.2", current_policy_version: "1.2", accepted_at: "2026-11-10T08:00:00Z", evidence_hash: "sha256:x", purposes: consent }
      : { accepted: false, policy_version: null, current_policy_version: "1.2", accepted_at: null, evidence_hash: null, purposes: [] },
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
  schedule: { preset: "daily", days: [1, 2, 3, 4, 5, 6, 7], preferred_time: "19:00", duration_min: 20, reminders_enabled: true, timezone: "Asia/Tashkent" },
  onboarding_completed_at: "2026-11-10T08:00:00Z",
  updated_at: "2026-11-10T08:00:00Z",
  version: 3,
};

const POLICY = {
  version: "1.2",
  purposes: [
    { code: "terms", required: true, title: "Условия", description: "" },
    { code: "privacy", required: true, title: "Конфиденциальность", description: "" },
    { code: "learning", required: true, title: "Обучение", description: "" },
    { code: "social", required: false, title: "Приглашения, семья и друзья", description: "" },
  ],
  text: "# Политика",
};

type Reply = [number, unknown] | ((body: unknown) => [number, unknown]);
interface Call {
  key: string;
  body: unknown;
  headers: Record<string, string>;
}

const err = (status: number, code: string, details: Record<string, unknown> = {}): [number, unknown] => [status, { code, message: code, trace_id: "t", details }];

/** A BFF on a scripted fetch: "METHOD /path" → reply (a list of replies is used one by one, the last one repeats). */
function fakeBff(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) && typeof v[0] !== "number" ? [...(v as Reply[])] : [v as Reply]]));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ key, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const q = queues.get(key);
    const r = q ? (q.length > 1 ? q.shift()! : q[0]!) : err(404, "NOT_FOUND");
    const [status, payload] = typeof r === "function" ? r(body) : r;
    return new Response(status === 204 ? null : JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const client = new ApiClient({ baseUrl: "", fetchImpl, storage: null, timezone: () => "Asia/Almaty" });
  return { calls, client, bff: createBff(client), of: (key: string) => calls.filter((c) => c.key === key) };
}

/** AppCtx around a screen: the session lives in state (patchSession / applySession), the nav is real. */
function Shell({ initial, bff, children, spy }: { initial: SessionResponse; bff: ReturnType<typeof createBff>; children: ReactNode; spy?: { session?: SessionResponse; applied?: SessionResponse[] } }) {
  const [session, setSession] = useState(initial);
  const [plan, setPlan] = useState<LearningPlan>({ ...PLAN, learner_id: initial.learner.learner_id });
  const nav = useNav();
  const s = useRef(spy);
  if (s.current) s.current.session = session;
  const ctx: AppCtx = {
    bff,
    session,
    applySession: async (x) => {
      s.current?.applied?.push(x);
      setSession(x);
    },
    syncProfile: (p) => setSession((prev) => ({ ...prev, account: p.account, learner: p.learner, learners: p.learners, security: p.security, consent: p.consent })),
    patchSession: (patch) => setSession((prev) => ({ ...prev, ...patch })),
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
      {children}
      <PopupHost />
      <ToastHost />
    </AppProvider>
  );
}

function mount(ui: ReactNode, initial: SessionResponse, routes: Record<string, Reply | Reply[]>) {
  const f = fakeBff(routes);
  const spy: { session?: SessionResponse; applied: SessionResponse[] } = { applied: [] };
  render(
    <I18nProvider initial="ru">
      <Shell initial={initial} bff={f.bff} spy={spy}>
        {ui}
      </Shell>
    </I18nProvider>,
  );
  return { ...f, spy };
}

/** Types a code into the parent-code keypad (the hidden numeric field). */
async function typePin(pin: string) {
  const field = await screen.findByTestId("pin-field");
  await waitFor(() => expect(field).not.toBeDisabled());
  await userEvent.type(field, pin);
}

const security = (on: boolean, len: 4 | 6 | null = on ? 4 : null, resetAt: string | null = null) => ({
  pin_enabled: on,
  pin_length: len,
  biometric_enabled: false,
  pin_required: false,
  locked_until: null,
  pin_reset_effective_at: resetAt,
});

describe("«Код родителя» (T-1)", () => {
  it("set: length, the code twice (a mismatch starts again) → PUT {pin}; the status and the toast", async () => {
    const f = mount(<ParentCode />, makeSession(), { "PUT /v1/profile/security/pin": [200, security(true, 6)] });
    expect(screen.getByTestId("pc-status")).toHaveTextContent("Код не задан");
    await userEvent.click(screen.getByTestId("pc-set"));
    await userEvent.click(within(screen.getByTestId("pin-length")).getByRole("button", { name: "6 цифр" }));
    await typePin("135790");
    expect(await screen.findByText("Повторите код")).toBeInTheDocument();
    await typePin("135791");
    expect(await screen.findByText("Коды не совпадают — придумайте код ещё раз.")).toBeInTheDocument();
    await typePin("135790");
    await typePin("135790");
    await waitFor(() => expect(f.of("PUT /v1/profile/security/pin")).toHaveLength(1));
    expect(f.of("PUT /v1/profile/security/pin")[0]!.body).toEqual({ pin: "135790" });
    expect(await screen.findByTestId("toast")).toHaveTextContent("Код родителя задан");
    expect(screen.getByTestId("pc-status")).toHaveTextContent("Код задан");
    expect(f.spy.session!.security.pin_enabled).toBe(true);
  });

  it("change: a wrong current code (checked on save) leads back to it with the server's text; then PUT {pin, current_pin}", async () => {
    const f = mount(<ParentCode />, makeSession({ pin: true }), {
      "PUT /v1/profile/security/pin": [err(401, "PIN_INVALID", { remaining: 3 }), [200, security(true)]],
    });
    await userEvent.click(screen.getByTestId("pc-change"));
    expect(screen.getByTestId("pin-step")).toHaveTextContent("Введите текущий код");
    await typePin("0000");
    await typePin("2468");
    await typePin("2468");
    expect(await screen.findByText("Неверный код. Осталось попыток: 3.")).toBeInTheDocument();
    expect(screen.getByTestId("pin-step")).toHaveTextContent("Введите текущий код");
    await typePin("1357");
    await typePin("2468");
    await typePin("2468");
    await waitFor(() => expect(f.of("PUT /v1/profile/security/pin")).toHaveLength(2));
    expect(f.of("PUT /v1/profile/security/pin")[1]!.body).toEqual({ pin: "2468", current_pin: "1357" });
    expect(await screen.findByTestId("toast")).toHaveTextContent("Код родителя изменён");
  });

  it("switch off: the current code → DELETE {current_pin}", async () => {
    const f = mount(<ParentCode />, makeSession({ pin: true }), { "DELETE /v1/profile/security/pin": [200, security(false)] });
    await userEvent.click(screen.getByTestId("pc-remove"));
    expect(screen.getByText("Без кода ребёнок сможет выйти из детского профиля одним нажатием.")).toBeInTheDocument();
    await typePin("1357");
    await waitFor(() => expect(f.of("DELETE /v1/profile/security/pin")[0]?.body).toEqual({ current_pin: "1357" }));
    expect(await screen.findByTestId("pc-status")).toHaveTextContent("Код не задан");
  });

  it("reset through the bot: request → the code from Telegram → a new code; a wrong code leads back to it; the reset waits 24 h (T-8)", async () => {
    const at = new Date(Date.now() + 24 * 3600_000).toISOString();
    const f = mount(<ParentCode />, makeSession({ pin: true }), {
      "POST /v1/profile/security/pin/reset-request": [200, { expires_in: 600 }],
      "POST /v1/profile/security/pin/reset-confirm": [err(401, "RESET_CODE_INVALID", { remaining: 4 }), [200, security(true, 4, at)]],
    });
    await userEvent.click(screen.getByTestId("pc-forgot"));
    await userEvent.click(screen.getByTestId("pin-reset-send"));
    expect(await screen.findByText("Код отправлен в чат с ботом. Он действует 10 мин.")).toBeInTheDocument();
    const next1 = screen.getByTestId("pin-reset-next");
    expect(next1).toBeDisabled();
    await userEvent.type(screen.getByTestId("pin-reset-code"), "11a1111");
    expect(screen.getByTestId("pin-reset-code")).toHaveValue("111111");
    await userEvent.click(next1);
    await typePin("2468");
    await typePin("2468");
    // the wrong bot code: back to it with the error (no refresh of the session — a business 401)
    expect(await screen.findByText("Неверный код из Telegram. Осталось попыток: 4.")).toBeInTheDocument();
    await userEvent.clear(screen.getByTestId("pin-reset-code"));
    await userEvent.type(screen.getByTestId("pin-reset-code"), "246810");
    await userEvent.click(screen.getByTestId("pin-reset-next"));
    await typePin("2468");
    await typePin("2468");
    await waitFor(() => expect(f.of("POST /v1/profile/security/pin/reset-confirm")).toHaveLength(2));
    expect(f.of("POST /v1/profile/security/pin/reset-confirm")[1]!.body).toEqual({ code: "246810", new_pin: "2468" });
    // review T-8: no new session — «Новый код заработает через 24 часа» with the date and time
    expect(await screen.findByTestId("pin-reset-wait-title")).toHaveTextContent("Новый код заработает через 24 часа");
    expect(screen.getByTestId("pin-reset-wait-when")).toHaveTextContent(`Он начнёт действовать ${makeI18n("ru").fmt.dateTime(at)}.`);
    expect(screen.getByTestId("pin-reset-wait")).toHaveTextContent("Если сброс запросили не вы, введите прежний код — сброс отменится.");
    expect(f.spy.applied).toHaveLength(0);
    expect(f.spy.session!.security).toMatchObject({ pin_length: 4, pin_reset_effective_at: at });
    await userEvent.click(screen.getByTestId("pin-reset-wait-ok"));
    // back to the menu: the pending reset with the date and «Отменить сброс»
    expect(await screen.findByTestId("pin-reset-pending")).toHaveTextContent("Сброс кода запрошен");
    expect(screen.getByTestId("pin-reset-pending-when")).toHaveTextContent(`Вступит в силу ${makeI18n("ru").fmt.dateTime(at)}. До этого действует прежний код.`);
    expect(screen.getByTestId("pin-reset-cancel")).toHaveTextContent("Отменить сброс");
    expect(f.calls.some((c) => c.key.includes("/session/"))).toBe(false);
  });

  it("the profile row: adults only; a dot while there are children and no code", async () => {
    mount(<Profile />, makeSession({ children: true }), { "GET /v1/profile": [503, { code: "UPSTREAM_UNAVAILABLE", message: "", trace_id: "t", details: {} }] });
    const row = screen.getByTestId("row-pin");
    expect(row).toHaveTextContent("Код родителя");
    expect(row).toHaveTextContent("не задан");
    expect(row.querySelector(".unread-dot")).not.toBeNull();
  });

  it("the row is not shown in a child profile", async () => {
    mount(<Profile />, makeSession({ kid: true }), { "GET /v1/profile": [503, { code: "UPSTREAM_UNAVAILABLE", message: "", trace_id: "t", details: {} }] });
    expect(screen.queryByTestId("row-pin")).toBeNull();
  });
});

/** The current pushed screen of the real nav (the Shell renders only the screen under test). */
function NavTop() {
  const { nav } = useApp();
  return <pre data-testid="nav-top">{JSON.stringify(nav.top)}</pre>;
}

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const withPending = (at: string | null, o: Parameters<typeof makeSession>[0] = { pin: true }): SessionResponse => {
  const s = makeSession(o);
  return { ...s, security: { ...s.security, pin_reset_effective_at: at } };
};

describe("сброс кода родителя через бота ждёт 24 часа (T-8)", () => {
  it("«Код родителя»: the banner with the date → «Отменить сброс» → the old code; a wrong one shows the server's text", async () => {
    const at = inHours(23);
    const f = mount(<ParentCode />, withPending(at), {
      "POST /v1/profile/security/pin/reset-cancel": [err(401, "PIN_INVALID", { remaining: 4 }), [200, security(true)]],
    });
    expect(screen.getByTestId("pin-reset-pending-when")).toHaveTextContent(`Вступит в силу ${makeI18n("ru").fmt.dateTime(at)}.`);
    await userEvent.click(screen.getByTestId("pin-reset-cancel"));
    expect(screen.getByTestId("pin-step")).toHaveTextContent("Введите прежний код");
    expect(screen.getByText("Сброс отменится, новый код не заработает.")).toBeInTheDocument();
    await typePin("0000");
    expect(await screen.findByText("Неверный код. Осталось попыток: 4.")).toBeInTheDocument();
    await typePin("1357");
    await waitFor(() => expect(f.of("POST /v1/profile/security/pin/reset-cancel")).toHaveLength(2));
    expect(f.of("POST /v1/profile/security/pin/reset-cancel").map((c) => c.body)).toEqual([{ current_pin: "0000" }, { current_pin: "1357" }]);
    expect(await screen.findByTestId("toast")).toHaveTextContent("Сброс кода отменён");
    expect(screen.queryByTestId("pin-reset-pending")).toBeNull();
    expect(f.spy.session!.security.pin_reset_effective_at).toBeNull();
  });

  it("the deadline passed while the screen was open: nothing to cancel, the new code already works", async () => {
    mount(<ParentCode />, withPending(inHours(-0.01)), { "POST /v1/profile/security/pin/reset-cancel": [200, security(true, 6)] });
    await userEvent.click(screen.getByTestId("pin-reset-cancel"));
    await typePin("1357");
    expect(await screen.findByTestId("toast")).toHaveTextContent("Срок прошёл — новый код уже действует.");
  });

  it("opened from the profile banner (cancel): straight to the old code; without a pending reset — the menu", async () => {
    mount(<ParentCode cancel />, withPending(inHours(10)), {});
    expect(screen.getByTestId("pin-reset-cancel-step")).toBeInTheDocument();
  });

  it("the adult profile shows the pending reset; «Отменить сброс» opens «Код родителя» on the old code; a child profile does not", async () => {
    const at = inHours(5);
    const down = { "GET /v1/profile": [503, { code: "UPSTREAM_UNAVAILABLE", message: "", trace_id: "t", details: {} }] as Reply };
    mount(<><Profile /><NavTop /></>, withPending(at), down);
    expect(screen.getByTestId("pin-reset-pending-when")).toHaveTextContent(makeI18n("ru").fmt.dateTime(at));
    await userEvent.click(screen.getByTestId("pin-reset-cancel"));
    expect(screen.getByTestId("nav-top")).toHaveTextContent(JSON.stringify({ name: "parentCode", cancel: true }));
  });

  it("no banner in a child profile or without a pending reset", () => {
    const down = { "GET /v1/profile": [503, { code: "UPSTREAM_UNAVAILABLE", message: "", trace_id: "t", details: {} }] as Reply };
    mount(<Profile />, withPending(inHours(5), { pin: true, kid: true }), down);
    expect(screen.queryByTestId("pin-reset-pending")).toBeNull();
  });

  it("no banner without a pending reset", () => {
    const down = { "GET /v1/profile": [503, { code: "UPSTREAM_UNAVAILABLE", message: "", trace_id: "t", details: {} }] as Reply };
    mount(<Profile />, withPending(null), down);
    expect(screen.queryByTestId("pin-reset-pending")).toBeNull();
  });

  it("the lock screen: the reset stays (waiting screen, the lock remains), then the hint that the old code cancels it", async () => {
    const at = inHours(24);
    const verify = vi.fn(async () => makeSession({ pin: true }));
    const confirm = vi.fn(async (_code: string, _pin: string) => security(true, 4, at));
    function Lock() {
      const [pending, setPending] = useState<string | null>(null);
      return (
        <LockScreen
          length={4}
          pendingAt={pending}
          verify={verify}
          reset={{
            request: async () => ({ expires_in: 600 }),
            confirm: async (code, pin) => {
              const s = await confirm(code, pin);
              setPending(s.pin_reset_effective_at);
              return s;
            },
          }}
        />
      );
    }
    render(
      <I18nProvider initial="ru">
        <Lock />
      </I18nProvider>,
    );
    expect(screen.queryByTestId("pin-reset-pending")).toBeNull();
    await userEvent.click(screen.getByTestId("lock-forgot"));
    await userEvent.click(screen.getByTestId("pin-reset-send"));
    await userEvent.type(await screen.findByTestId("pin-reset-code"), "246810");
    await userEvent.click(screen.getByTestId("pin-reset-next"));
    await typePin("2468");
    await typePin("2468");
    expect(await screen.findByTestId("pin-reset-wait-title")).toHaveTextContent("Новый код заработает через 24 часа");
    expect(confirm).toHaveBeenCalledWith("246810", "2468");
    await userEvent.click(screen.getByTestId("pin-reset-wait-ok"));
    const banner = await screen.findByTestId("pin-reset-pending");
    expect(banner).toHaveTextContent("Введите прежний код — сброс отменится.");
    expect(within(banner).queryByTestId("pin-reset-cancel")).toBeNull();
    expect(screen.getByTestId("pin-field")).toBeInTheDocument(); // still locked: the old code is asked
    expect(verify).not.toHaveBeenCalled();
  });

  it("Uzbek texts of the waiting screen and the banner", async () => {
    const at = inHours(24);
    render(
      <I18nProvider initial="uz">
        <PinResetWaiting effectiveAt={at} onOk={() => undefined} />
        <PinResetPending at={at} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("pin-reset-wait-title")).toHaveTextContent("Yangi kod 24 soatdan keyin ishlay boshlaydi");
    expect(screen.getByTestId("pin-reset-wait-when")).toHaveTextContent(`U ${makeI18n("uz").fmt.dateTime(at)} dan boshlab amal qiladi.`);
    expect(screen.getByTestId("pin-reset-pending")).toHaveTextContent("Kodni tiklash soʻralgan");
  });

  it("hours until the deadline: rounded, at least 1, 24 for a broken date", () => {
    const now = Date.parse("2026-11-18T17:30:00Z");
    expect(hoursUntil("2026-11-19T17:30:00Z", now)).toBe(24);
    expect(hoursUntil("2026-11-19T17:10:00Z", now)).toBe(24);
    expect(hoursUntil("2026-11-18T17:40:00Z", now)).toBe(1);
    expect(hoursUntil("2026-11-18T17:00:00Z", now)).toBe(1);
    expect(hoursUntil("bad", now)).toBe(24);
    expect(pluralHours("ru", 24)).toBe("часа");
    expect(pluralHours("ru", 1)).toBe("час");
    expect(pluralHours("ru", 5)).toBe("часов");
  });
});

const familyRoutes = (extra: Record<string, Reply | Reply[]> = {}): Record<string, Reply | Reply[]> => ({
  "GET /v1/family": [204, null],
  "GET /v1/invites": [200, { items: [], next_cursor: null }],
  "GET /v1/family/guardian-consents": [200, { items: [] }],
  "POST /v1/learners": (b) => [201, { learner_id: KID, kind: "child", display_name: (b as { display_name: string }).display_name, age_band: "6-9", is_active: false, onboarding_completed: false }],
  "PUT /v1/profile/security/pin": [200, security(true)],
  ...extra,
});

async function addChild(name: string) {
  await userEvent.click(screen.getByTestId("add-child"));
  await userEvent.type(screen.getByLabelText("Как обращаться к ребёнку"), name);
  await userEvent.click(screen.getByRole("button", { name: "от 6 до 9 лет" }));
  await userEvent.click(screen.getByTestId("add-child-save"));
}

describe("the parent code offer after the first child profile (T-1)", () => {
  it("first child, no code → «Задайте код родителя»: the code is set right there (PUT {pin})", async () => {
    const f = mount(<Family />, makeSession(), familyRoutes());
    await addChild("Мадина");
    const offer = await screen.findByTestId("pin-offer");
    expect(within(offer).getByRole("heading", { name: "Задайте код родителя" })).toBeInTheDocument();
    await typePin("2580");
    await typePin("2580");
    await waitFor(() => expect(f.of("PUT /v1/profile/security/pin")[0]?.body).toEqual({ pin: "2580" }));
    await waitFor(() => expect(screen.queryByTestId("pin-offer")).toBeNull());
    expect(f.spy.session!.security.pin_enabled).toBe(true);
  });

  it("«Не сейчас» closes the offer with a hint; a second child or a set code — no offer", async () => {
    const f = mount(<Family />, makeSession(), familyRoutes());
    await addChild("Мадина");
    await userEvent.click(await screen.findByTestId("pin-offer-skip"));
    expect(screen.queryByTestId("pin-offer")).toBeNull();
    expect(screen.getByTestId("toast")).toHaveTextContent("Задать код можно позже: Профиль → Код родителя.");
    await addChild("Тимур");
    await waitFor(() => expect(f.of("POST /v1/learners")).toHaveLength(2));
    expect(screen.queryByTestId("pin-offer")).toBeNull();
    expect(f.of("PUT /v1/profile/security/pin")).toHaveLength(0);
  });

  it("the code is already set → no offer", async () => {
    const f = mount(<Family />, makeSession({ pin: true }), familyRoutes());
    await addChild("Мадина");
    await waitFor(() => expect(f.of("POST /v1/learners")).toHaveLength(1));
    expect(screen.queryByTestId("pin-offer")).toBeNull();
  });
});

describe("teens the parent gave consent for (§11)", () => {
  const grant = (status: "granted" | "declined") => ({ teen_user_id: TEEN, teen_display_name: "Тимур", status, decided_at: "2026-11-18T11:00:00Z" });

  it("the list and «Отозвать согласие» with a confirmation → POST …/revoke; the row becomes «согласия нет»", async () => {
    const f = mount(<Family />, makeSession(), familyRoutes({
      "GET /v1/family/guardian-consents": [200, { items: [grant("granted")] }],
      [`POST /v1/family/guardian-consents/${TEEN}/revoke`]: [200, grant("declined")],
    }));
    const section = await screen.findByTestId("teen-consents");
    expect(within(section).getByText("Тимур")).toBeInTheDocument();
    expect(within(section).getByText("согласие дано")).toBeInTheDocument();
    await userEvent.click(within(section).getByTestId("teen-consent-revoke"));
    const pop = await screen.findByRole("alertdialog", { name: "Отозвать согласие?" });
    expect(pop).toHaveTextContent("У Тимур выключатся запись голоса, приглашения и семья.");
    await userEvent.click(within(pop).getByRole("button", { name: "Отозвать согласие" }));
    await waitFor(() => expect(f.of(`POST /v1/family/guardian-consents/${TEEN}/revoke`)).toHaveLength(1));
    expect(await within(section).findByText("согласия нет")).toBeInTheDocument();
    expect(within(section).queryByTestId("teen-consent-revoke")).toBeNull();
    expect(screen.getByTestId("toast")).toHaveTextContent("Согласие отозвано");
  });

  it("cancel in the confirmation — nothing is sent; no teens — no section", async () => {
    const f = mount(<Family />, makeSession(), familyRoutes({ "GET /v1/family/guardian-consents": [200, { items: [grant("granted")] }] }));
    await userEvent.click(await screen.findByTestId("teen-consent-revoke"));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Отмена" }));
    expect(f.calls.filter((c) => c.key.endsWith("/revoke"))).toHaveLength(0);
  });

  it("no teens → the section is hidden", async () => {
    const f = mount(<Family />, makeSession(), familyRoutes());
    await waitFor(() => expect(f.of("GET /v1/family/guardian-consents")).toHaveLength(1));
    expect(screen.queryByTestId("teen-consents")).toBeNull();
  });
});

describe("CONSENT_REQUIRED {purpose} (§11)", () => {
  const preview = { invite_id: INVITE, kind: "family", inviter_display_name: "Мама", status: "active", can_accept: true, reason: null };
  const accepted = { invite_id: INVITE, kind: "family", family: null };

  it("accepting without «social» → the sheet → POST /v1/profile/consent with social → the acceptance is repeated", async () => {
    const onAccepted = vi.fn();
    const f = mount(<InviteSheet target={{ token: "FamTok0123456789abcdefghijklmnop" }} onClose={() => undefined} onAccepted={onAccepted} onDefer={() => undefined} />, makeSession({ consent: [...REQUIRED, "product_news"] }), {
      "POST /v1/invites/open": [200, preview],
      [`POST /v1/invites/${INVITE}/accept`]: [err(403, "CONSENT_REQUIRED", { purpose: "social" }), [200, accepted]],
      "GET /v1/legal/policy": [200, POLICY],
      "POST /v1/profile/consent": (b) => [200, { accepted: true, policy_version: "1.2", current_policy_version: "1.2", accepted_at: "x", evidence_hash: "h", purposes: (b as { purposes: string[] }).purposes }],
    });
    await userEvent.click(await screen.findByTestId("invite-accept"));
    const sheet = await screen.findByTestId("social-consent");
    expect(within(sheet).getByRole("heading", { name: "Разрешить приглашения и семью" })).toBeInTheDocument();
    expect(onAccepted).not.toHaveBeenCalled();
    await userEvent.click(within(sheet).getByTestId("social-allow"));
    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith(accepted));
    // the optional purpose that is not in the policy (product_news here) is dropped; required ones and social are sent
    expect(f.of("POST /v1/profile/consent")[0]!.body).toEqual({ policy_version: "1.2", purposes: [...REQUIRED, "social"] });
    expect(f.of(`POST /v1/invites/${INVITE}/accept`)).toHaveLength(2);
    expect(f.spy.session!.consent.purposes).toContain("social");
  });

  it("«Отмена» in the sheet: no consent, the invitation stays", async () => {
    const onAccepted = vi.fn();
    const f = mount(<InviteSheet target={{ token: "FamTok0123456789abcdefghijklmnop" }} onClose={() => undefined} onAccepted={onAccepted} onDefer={() => undefined} />, makeSession(), {
      "POST /v1/invites/open": [200, preview],
      [`POST /v1/invites/${INVITE}/accept`]: [err(403, "CONSENT_REQUIRED", { purpose: "social" })],
    });
    await userEvent.click(await screen.findByTestId("invite-accept"));
    await userEvent.click(within(await screen.findByTestId("social-consent")).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByTestId("social-consent")).toBeNull();
    expect(screen.getByTestId("invite-accept")).toBeInTheDocument();
    expect(f.of("POST /v1/profile/consent")).toHaveLength(0);
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("before the consents the invitation is not opened: the setup first, the token waits (onDefer)", async () => {
    const onDefer = vi.fn();
    const f = mount(<InviteSheet target={{ token: "FamTok0123456789abcdefghijklmnop" }} onClose={() => undefined} onAccepted={() => undefined} onDefer={onDefer} />, { ...makeSession({ consent: null }), onboarding_completed: false }, {});
    await userEvent.click(await screen.findByTestId("invite-defer"));
    expect(onDefer).toHaveBeenCalledWith({ token: "FamTok0123456789abcdefghijklmnop" });
    expect(f.calls).toHaveLength(0);
  });

  it("creating an invitation without «social» → the same sheet, then the invitation is created", async () => {
    const f = mount(<Family />, makeSession(), familyRoutes({
      "POST /v1/invites": [err(403, "CONSENT_REQUIRED", { purpose: "social" }), [201, { invite_id: INVITE, kind: "friend", link: "https://t.me/b/app?startapp=inv_x", status: "active", expires_at: null, created_at: "2026-11-18T08:00:00Z", accepted_count: 0 }]],
      "GET /v1/legal/policy": [200, POLICY],
      "POST /v1/profile/consent": (b) => [200, { accepted: true, policy_version: "1.2", current_policy_version: "1.2", accepted_at: "x", evidence_hash: "h", purposes: (b as { purposes: string[] }).purposes }],
    }));
    vi.spyOn(window, "open").mockReturnValue(null);
    await userEvent.click(await screen.findByTestId("invite-friend"));
    await userEvent.click(within(await screen.findByTestId("social-consent")).getByTestId("social-allow"));
    await waitFor(() => expect(f.of("POST /v1/invites")).toHaveLength(2));
    // the same draft → the same Idempotency-Key on the repeat
    expect(f.of("POST /v1/invites")[1]!.headers["Idempotency-Key"]).toBe(f.of("POST /v1/invites")[0]!.headers["Idempotency-Key"]);
    expect(await screen.findByTestId("invite-row")).toBeInTheDocument();
  });

  it("gc_ without the parent's own consent: the required purposes first, then the decision", async () => {
    const f = mount(<GuardianSheet token="GcTok0123456789abcdefghijklmnopqrstuvwxyzAB" onClose={() => undefined} />, makeSession({ consent: null }), {
      "GET /v1/guardian-consents/GcTok0123456789abcdefghijklmnopqrstuvwxyzAB": [200, { teen_display_name: "Тимур", status: "pending", expires_at: "2026-11-25T08:00:00Z" }],
      "GET /v1/legal/policy": [200, POLICY],
      "POST /v1/profile/consent": (b) => [200, { accepted: true, policy_version: "1.2", current_policy_version: "1.2", accepted_at: "x", evidence_hash: "h", purposes: (b as { purposes: string[] }).purposes }],
      "POST /v1/guardian-consents/GcTok0123456789abcdefghijklmnopqrstuvwxyzAB/accept": [200, { teen_display_name: "Тимур", status: "granted", expires_at: "2026-11-25T08:00:00Z" }],
    });
    const block = await screen.findByTestId("gc-consent");
    const accept = screen.getByTestId("gc-accept");
    expect(accept).toBeDisabled();
    for (const c of REQUIRED) await userEvent.click(within(block).getByTestId(`gc-consent-${c}`));
    expect(accept).toBeEnabled();
    await userEvent.click(accept);
    expect(await screen.findByTestId("gc-status")).toHaveTextContent("Согласие для Тимур дано.");
    expect(f.calls.map((c) => c.key).filter((k) => k.startsWith("POST"))).toEqual([
      "POST /v1/profile/consent",
      "POST /v1/guardian-consents/GcTok0123456789abcdefghijklmnopqrstuvwxyzAB/accept",
    ]);
    expect(f.of("POST /v1/profile/consent")[0]!.body).toEqual({ policy_version: "1.2", purposes: REQUIRED });
  });

  it("gc_: the server still answers CONSENT_REQUIRED {terms} → the policy block appears instead of an error", async () => {
    mount(<GuardianSheet token="GcTok0123456789abcdefghijklmnopqrstuvwxyzAB" onClose={() => undefined} />, makeSession(), {
      "GET /v1/guardian-consents/GcTok0123456789abcdefghijklmnopqrstuvwxyzAB": [200, { teen_display_name: "Тимур", status: "pending", expires_at: "2026-11-25T08:00:00Z" }],
      "GET /v1/legal/policy": [200, POLICY],
      "POST /v1/guardian-consents/GcTok0123456789abcdefghijklmnopqrstuvwxyzAB/accept": [err(403, "CONSENT_REQUIRED", { purpose: "terms" })],
    });
    expect(screen.queryByTestId("gc-consent")).toBeNull();
    await userEvent.click(await screen.findByTestId("gc-accept"));
    expect(await screen.findByTestId("gc-consent")).toHaveTextContent("Сначала примите политику обработки данных");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the time of a child profile (D-04)", () => {
  it("domain: 08:00–19:30 only for children", () => {
    expect(KID_WINDOW).toEqual({ from: "08:00", to: "19:30" });
    expect(["08:00", "13:00", "19:00", "19:30"].every(inKidWindow)).toBe(true);
    expect(["07:59", "19:31", "20:00", "23:30", "bad"].some(inKidWindow)).toBe(false);
    const late = { ...DEFAULT_SCHEDULE, preferred_time: "20:30" };
    expect(scheduleProblem(late)).toBeNull();
    expect(scheduleProblem(late, { kid: true })).toBe("preferred_time");
  });

  it("child profile: the window note, a later time is an error and cannot be saved", async () => {
    mount(<ScheduleScreen />, makeSession({ kid: true }), {});
    expect(screen.getByTestId("kid-window")).toHaveTextContent("Детям сообщения приходят только с 08:00 до 20:00, поэтому занятие — с 08:00 до 19:30.");
    const input = screen.getByTestId("time-input");
    expect(input).toHaveAttribute("min", "08:00");
    expect(input).toHaveAttribute("max", "19:30");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "20:30");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(await screen.findByText("Для детского профиля выберите время с 08:00 до 19:30")).toBeInTheDocument();
    expect(screen.getByTestId("schedule-save")).toBeDisabled();
  });

  it("adult profile: no window", () => {
    mount(<ScheduleScreen />, makeSession(), {});
    expect(screen.queryByTestId("kid-window")).toBeNull();
    expect(screen.getByTestId("time-input")).not.toHaveAttribute("max");
  });
});

describe("client and error texts (D-03, T-3, T-7)", () => {
  it("signed-in and session calls carry X-Timezone of the device; public GETs do not (no CORS preflight)", async () => {
    const f = fakeBff({ "GET /v1/family/guardian-consents": [200, { items: [] }], "GET /v1/legal/policy": [200, POLICY], "POST /v1/session/telegram": [503, {}] });
    await f.bff.guardianGrants();
    await f.bff.policy("ru");
    await f.client.startSession("hash=a").catch(() => undefined);
    expect(f.calls.map((c) => [c.key, c.headers["X-Timezone"]])).toEqual([
      ["GET /v1/family/guardian-consents", "Asia/Almaty"],
      ["GET /v1/legal/policy", undefined],
      ["POST /v1/session/telegram", "Asia/Almaty"],
    ]);
  });

  it("business 401 of the parent code do not refresh the session", () => {
    for (const c of ["PIN_INVALID", "RESET_CODE_INVALID", "BIOMETRIC_INVALID"]) expect(BUSINESS_401.has(c)).toBe(true);
  });

  it("CONSENT_REQUIRED purpose", () => {
    expect(consentRequiredPurpose(new ApiError(403, "CONSENT_REQUIRED", "x", { purpose: "social" }))).toBe("social");
    expect(consentRequiredPurpose(new ApiError(403, "CONSENT_REQUIRED", "x"))).toBe("terms");
    expect(consentRequiredPurpose(new ApiError(403, "ADULT_REQUIRED", "x"))).toBeNull();
  });

  it("domain codes that reach the screens have texts in RU and UZ (no «Что-то пошло не так»)", () => {
    const { t, fmt } = makeI18n("ru");
    const u = makeI18n("uz");
    const codes = [
      "FAMILY_FULL", "ALREADY_FRIENDS", "DELETION_CONFIRMATION_REQUIRED", "PIN_FORMAT", "USER_DELETION_REQUESTED", "IDEMPOTENCY_KEY_REUSED",
      "CONSENT_REQUIRED", "RESET_CODE_EXPIRED", "PIN_RESET_TOO_OFTEN", "ACTIVITY_INVALID", "SUPPORT_TOO_MANY_OPEN",
    ];
    for (const c of codes) {
      expect(KNOWN_CODES as readonly string[]).toContain(c);
      const e = new ApiError(409, c, "server text");
      expect(errorText(e, t, fmt.mmss), c).not.toBe(ru["err.UNKNOWN"]);
      expect(errorText(e, u.t, u.fmt.mmss), c).not.toBe(uz["err.UNKNOWN"]);
    }
    expect(errorText(new ApiError(422, "IDEMPOTENCY_KEY_INVALID", "x"), t, fmt.mmss)).toBe(ru["err.IDEMPOTENCY_KEY_REUSED"]);
    expect(errorText(new ApiError(401, "PIN_INVALID", "x", { reason: "missing" }), t, fmt.mmss)).toBe("Неверный код.");
    expect(errorText(new ApiError(401, "RESET_CODE_INVALID", "x", { remaining: 2 }), u.t, u.fmt.mmss)).toBe("Telegramdagi kod notoʻgʻri. Qolgan urinishlar: 2.");
  });

  it("already_member: neutral text (the person may be in another family)", () => {
    expect(ru["ivs.reason.already_member"]).toBe("Вы уже состоите в семье TilHero.");
    expect(uz["ivs.reason.already_member"]).not.toMatch(/shu oila/);
  });
});
