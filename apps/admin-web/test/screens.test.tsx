import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminLearnerCard, Dashboard, Permission, StaffReleaseNote, TemplateInfo, TemplateVersion } from "@tilhero/contracts/admin";
import { api } from "../src/api/client";
import { I18nProvider, type Lang } from "../src/i18n";
import { SessionCtx, type Session } from "../src/state/session";
import { ToastProvider } from "../src/ui/toasts";
import { WhatsNewPreview, WhatsNewTab } from "../src/screens/news/WhatsNew";
import { TemplatesTab } from "../src/screens/news/Templates";
import { RevealTelegramId } from "../src/screens/learners/Learners";
import { Overview } from "../src/screens/overview/Overview";
import { emptyNote } from "../src/screens/news/catalog";
import { approvalLabel, issuesPassword, privilegedOf } from "../src/screens/roles/Roles";
import { translate } from "../src/i18n";
import { ErrorBoundary } from "../src/ui/ErrorBoundary";
import { tgHandle } from "../src/lib/tg";
import { useState } from "react";

/* Component tests of the TilHero screens against a fake admin-bff (fetch). */

type Handler = (method: string, path: string, body: unknown) => { status: number; body?: unknown } | undefined;
let handler: Handler = () => undefined;
const calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];

beforeEach(() => {
  calls.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const path = url.pathname.replace("/admin/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = handler(init?.method ?? "GET", path, body) ?? { status: 404, body: { code: "NOT_FOUND", message: "", trace_id: "", details: {} } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  });
  api.setCsrf("csrf-test");
  api.hooks = {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const session = (perms: Permission[]): Session => {
  const set = new Set(perms);
  return { me: null, can: (p) => set.has(p), canAny: (ps) => ps.some((p) => set.has(p)), refreshMe: async () => null, setMe: () => undefined, signOut: async () => undefined, reloadTheme: async () => undefined, themeVersion: null, adminLayout: null };
};
const ui = (node: ReactNode, perms: Permission[], lang: Lang = "ru") =>
  render(
    <I18nProvider initial={lang}>
      <SessionCtx.Provider value={session(perms)}>
        <ToastProvider>{node}</ToastProvider>
      </SessionCtx.Provider>
    </I18nProvider>,
  );

const note = (p: Partial<StaffReleaseNote> = {}): StaffReleaseNote => ({
  release_note_id: "d1000000-0000-4000-8000-000000000003",
  slug: "2026.11",
  status: "draft",
  version: 3,
  title: { ru: "Ноябрь: семья и график", uz: "Noyabr: oila va jadval" },
  items: [
    { title: { ru: "Семейный график", uz: "Oilaviy jadval" }, text: { ru: "Родитель видит график.", uz: "Ota-ona jadvalni koʻradi." }, link: "family", icon: "users" },
    { title: { ru: "Тихие часы", uz: "Tinch soatlar" }, text: { ru: "После 21:00 тихо.", uz: "21:00 dan keyin tinch." }, link: null, icon: "clock" },
  ],
  audience: "existing",
  segments: {},
  created_by: "s",
  created_by_name: "Дилноза",
  created_at: "2026-11-16T10:00:00Z",
  updated_by: "s",
  updated_at: "2026-11-18T10:00:00Z",
  published_by: null,
  published_by_name: null,
  published_at: null,
  archived_by: null,
  archived_at: null,
  views_total: 0,
  ...p,
});

describe("«Что нового» editor", () => {
  it("422 RELEASE_NOTE_TRANSLATION_MISSING from the server: the UZ tab opens and the reported field is invalid", async () => {
    handler = (m, p) => {
      if (m === "GET" && p === "/release-notes") return { status: 200, body: { items: [note()], next_cursor: null } };
      if (m === "PUT") return { status: 422, body: { code: "RELEASE_NOTE_TRANSLATION_MISSING", message: "", trace_id: "t", details: { missing: ["items[1].text.uz"] } } };
      return undefined;
    };
    ui(<WhatsNewTab openId={null} />, ["whatsnew.manage", "whatsnew.publish"]);
    const title = await screen.findByTestId("wn-title-ru");
    fireEvent.change(title, { target: { value: "Ноябрь: семья, график, тишина" } });
    fireEvent.click(screen.getByTestId("wn-save"));
    await waitFor(() => expect(screen.getByTestId("wn-lang-uz")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("wn-it-text-1-uz")).toHaveAttribute("aria-invalid", "true");
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ expected_version: 3, slug: "2026.11" });
    expect(put.headers["X-CSRF-Token"]).toBe("csrf-test");
  });

  it("without whatsnew.publish there is no publish button", async () => {
    handler = (m, p) => (m === "GET" && p === "/release-notes" ? { status: 200, body: { items: [note()], next_cursor: null } } : undefined);
    ui(<WhatsNewTab openId={null} />, ["whatsnew.manage"]);
    await screen.findByTestId("wn-editor");
    expect(screen.queryByTestId("wn-publish")).toBeNull();
    expect(screen.getByTestId("wn-no-publish")).toHaveTextContent("whatsnew.publish");
  });

  it("the phone preview renders the Mini App sheet in RU / UZ and marks empty translations", () => {
    const d = emptyNote("2026.12");
    d.title.ru = "Декабрь";
    d.items[0]!.title.ru = "Голос";
    d.items[0]!.text.ru = "Говорим вслух";
    d.items[0]!.link = "lessons";
    ui(<WhatsNewPreview d={d} />, ["whatsnew.manage"]);
    const phone = screen.getByTestId("wn-phone");
    expect(phone).toHaveTextContent("Что изменилось");
    expect(phone).toHaveTextContent("Подробнее");
    expect(phone).toHaveTextContent("Понятно");
    fireEvent.click(within(screen.getByTestId("pv-lang")).getByRole("button", { name: "UZ" }));
    expect(phone).toHaveTextContent("Nima oʻzgardi");
    expect(phone).toHaveTextContent("boʻsh");
    fireEvent.click(within(screen.getByTestId("pv-scheme")).getByRole("button", { name: "Тёмная" }));
    expect(phone).toHaveAttribute("data-scheme", "dark");
  });
});

const tplInfo: TemplateInfo = {
  key: "reminder.lesson",
  category: "reminders",
  kid: false,
  description: { ru: "Напоминание о занятии", en: "Lesson reminder" },
  placeholders: [
    { name: "learner_name", description: { ru: "Имя", en: "Name" }, sample: { ru: "Мадина", uz: "Madina" } },
    { name: "slot_time", description: { ru: "Время", en: "Time" }, sample: { ru: "19:30", uz: "19:30" } },
  ],
  default_texts: { ru: { title: "Пора, {learner_name}", body: "Урок в {slot_time}", button: "Начать" }, uz: { title: "{learner_name}, vaqt", body: "Dars {slot_time} da", button: "Boshlash" } },
  active_version: null,
  active_since: null,
  updated_at: null,
};

describe("notification template editor", () => {
  it("highlights an unknown placeholder live and inserts a known one; the save carries an Idempotency-Key", async () => {
    const created: TemplateVersion = { key: "reminder.lesson", version: 1, status: "draft", texts: tplInfo.default_texts, note: "n", created_by: "s", created_by_name: null, created_at: "2026-11-18T10:00:00Z", activated_by: null, activated_by_name: null, activated_at: null };
    handler = (m, p) => {
      if (p === "/notifications/templates" && m === "GET") return { status: 200, body: { items: [tplInfo] } };
      if (p === "/notifications/templates/reminder.lesson" && m === "GET") return { status: 200, body: { ...tplInfo, versions: [] } };
      if (p === "/notifications/test-recipients") return { status: 200, body: { items: [] } };
      if (p.endsWith("/versions") && m === "POST") return { status: 201, body: created };
      return undefined;
    };
    ui(<TemplatesTab openKey={null} />, ["notif.templates.manage"]);
    const body = await screen.findByTestId("tpl-body-ru");
    fireEvent.change(body, { target: { value: "Урок в {slot_time}. {bonus}" } });
    expect(body).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("{bonus}");
    fireEvent.change(body, { target: { value: "Урок в {slot_time}, " } });
    fireEvent.focus(body);
    fireEvent.click(screen.getByTestId("ph-learner_name"));
    await waitFor(() => expect(body).toHaveValue("Урок в {slot_time}, {learner_name}"));
    expect(screen.getByTestId("tg-preview")).toHaveTextContent("Урок в 19:30, Мадина");
    fireEvent.change(screen.getByTestId("tpl-note"), { target: { value: "Имя в конце" } });
    fireEvent.click(screen.getByTestId("tpl-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/versions"))).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body).toMatchObject({ note: "Имя в конце", texts: { ru: { body: "Урок в {slot_time}, {learner_name}" } } });
  });
});

describe("Telegram ID reveal", () => {
  const card = { user_id: "a1000000-0000-4000-8000-000000000001", kind: "account", telegram_id_masked: "••••••417", tickets: [] } as unknown as AdminLearnerCard;

  it("needs a reason, shows the value for 60 s and drops it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    handler = (m, p) => (m === "POST" && p.endsWith("/reveal") ? { status: 200, body: { field: "telegram_user_id", value: "5120934417", expires_in: 60 } } : undefined);
    ui(<RevealTelegramId card={card} />, ["users.read", "users.sensitive.read"]);
    fireEvent.click(screen.getByTestId("reveal-start"));
    fireEvent.change(screen.getByTestId("reveal-reason"), { target: { value: "abc" } });
    fireEvent.click(screen.getByTestId("reveal-confirm"));
    expect(screen.getByRole("alert")).toHaveTextContent("не короче 5");
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByTestId("reveal-reason"), { target: { value: "TCK-1042 — сверяем аккаунт" } });
    fireEvent.click(screen.getByTestId("reveal-confirm"));
    expect(await screen.findByTestId("reveal-value")).toHaveTextContent("5120934417");
    // no copy button: the OS clipboard would keep the ID longer than 60 s (review T2-8)
    expect(within(screen.getByTestId("reveal-box")).queryByRole("button", { name: /копир/i })).toBeNull();
    expect(calls[0]!.body).toMatchObject({ field: "telegram_user_id" });
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.queryByTestId("reveal-value")).toBeNull();
  });

  it("is not offered without users.sensitive.read; a child profile has nothing to reveal", () => {
    ui(<RevealTelegramId card={card} />, ["users.read"]);
    expect(screen.queryByTestId("reveal-start")).toBeNull();
    cleanup();
    ui(<RevealTelegramId card={{ ...card, kind: "child", telegram_id_masked: null }} />, ["users.read", "users.sensitive.read"]);
    expect(screen.getByText(/детский профиль/)).toBeInTheDocument();
  });
});

describe("overview", () => {
  it("each block has its own «no data»: a source down vs an empty source", async () => {
    const d: Dashboard = {
      period: "today",
      generated_at: "2026-11-18T10:00:00Z",
      learners: { available: false, data: null, service: "user-admin" },
      support: { available: true, data: { open: 0, in_progress: 0, waiting_customer: 0, breached: 0, avg_first_response_minutes: null, avg_resolution_minutes: null } },
      whats_new: { available: true, data: { published: 1, drafts: 0, latest: { release_note_id: "x", slug: "2026.10", title: "Октябрь", views_total: 812, published_at: "2026-10-18T10:00:00Z" } } },
      campaigns: { available: true, data: { scheduled: 0, sending: 0, sent_in_period: 0, delivered_in_period: 0 } },
      content: { available: false, data: null, service: "catalog" },
      diagnostics: { available: false, data: null, service: "diagnostics" },
      lessons: { available: false, data: null, service: "lessons" },
      ai: { available: false, data: null, service: "ai-gateway" },
      memory: { available: false, data: null, service: "memory" },
      game: { available: false, data: null, service: "gamification" },
    };
    handler = (_m, p) => (p === "/dashboard" ? { status: 200, body: d } : undefined);
    ui(<Overview />, ["dashboard.read"]);
    expect(await screen.findByTestId("block-learners-off")).toHaveTextContent("user-admin");
    expect(screen.getByTestId("block-support-empty")).toHaveTextContent("Обращений нет");
    expect(screen.getByTestId("block-campaigns-empty")).toBeInTheDocument();
    expect(screen.getByTestId("dw-views")).toHaveTextContent("812");
  });

  it("campaigns: started campaigns and delivered messages are labelled with their units (QA D2-01), RU and EN", async () => {
    const d: Dashboard = {
      period: "today",
      generated_at: "2026-11-18T10:00:00Z",
      learners: { available: false, data: null, service: "user-admin" },
      support: { available: false, data: null, service: "support" },
      whats_new: { available: false, data: null, service: "experience-config" },
      campaigns: { available: true, data: { scheduled: 1, sending: 0, sent_in_period: 2, delivered_in_period: 5 } },
      content: { available: false, data: null, service: "catalog" },
      diagnostics: { available: false, data: null, service: "diagnostics" },
      lessons: { available: false, data: null, service: "lessons" },
      ai: { available: false, data: null, service: "ai-gateway" },
      memory: { available: false, data: null, service: "memory" },
      game: { available: false, data: null, service: "gamification" },
    };
    handler = (_m, p) => (p === "/dashboard" ? { status: 200, body: d } : undefined);
    ui(<Overview />, ["dashboard.read"]);
    expect(await screen.findByTestId("dc-sent")).toHaveTextContent(/^Запущено рассылок, сегодня\s*2$/);
    expect(screen.getByTestId("dc-delivered")).toHaveTextContent(/^Доставлено сообщений, сегодня\s*5$/);
    expect(screen.getByTestId("kpis")).toHaveTextContent("Доставлено сообщений рассылок, сегодня");
    expect(screen.getByTestId("kpis")).toHaveTextContent("запущено рассылок 2");
    cleanup();
    ui(<Overview />, ["dashboard.read"], "en");
    expect(await screen.findByTestId("dc-sent")).toHaveTextContent(/^Campaigns started, today\s*2$/);
    expect(screen.getByTestId("dc-delivered")).toHaveTextContent(/^Messages delivered, today\s*5$/);
  });
});

describe("overview · sprint 4 blocks", () => {
  const base: Dashboard = {
    period: "today",
    generated_at: "2026-11-19T10:00:00Z",
    learners: { available: false, data: null, service: "user-admin" },
    support: { available: false, data: null, service: "support" },
    whats_new: { available: false, data: null, service: "experience-config" },
    campaigns: { available: false, data: null, service: "notifications" },
    content: { available: false, data: null, service: "catalog" },
    diagnostics: { available: false, data: null, service: "diagnostics" },
    lessons: { available: true, data: { period: "today", started: 64, completed: 51, completion_pct: 79.7, median_minutes: 18, by_kind: { lesson: 40, scenario: 14, media: 8, review: 2, reading: 3 }, ai_degraded_pct: 6.3, appeals_open: 2, human_review_open: 1 } },
    ai: {
      available: true,
      data: {
        period: "month", spent_usd: 18.4, monthly_cap_usd: 20, cap_used_pct: 92, calls: 2400, unavailable: 110, unavailable_pct: 4.6, p95_latency_ms: 2380,
        by_agent: [], by_model: [], by_day: [], avg_cost_per_lesson_usd: 0.0118, ai_enabled: false, alert_percent: 80,
        speech: { calls: 120, audio_minutes: 18.5, spent_usd: 0.41, speech_available: false, cap_usd: 5 },
      },
    },
    memory: { available: true, data: { period: "today", review_sessions: 84, learners_reviewing: 61, median_minutes: 6, d30_pass_pct: 78.9, avg_due_per_learner: 11.4, ai_glosses_pending: 3 } },
    game: { available: true, data: { period: "today", earned_xp: 1240, earned_til: 310, freezes_used: 4, quests_completed: 57, active_event: { title: { ru: "Неделя чтения", uz: "Oʻqish haftaligi" }, ends_at: "2026-11-23T19:00:00Z" } } },
  };
  it("lessons and ai blocks with their own «no data»; attention: budget threshold, AI off, appeals, manual reviews", async () => {
    handler = (_m, p) => (p === "/dashboard" ? { status: 200, body: base } : undefined);
    ui(<Overview />, ["dashboard.read"]);
    expect(await screen.findByTestId("dls-completion")).toHaveTextContent("79,7");
    expect(screen.getByTestId("dai-off")).toHaveTextContent("ИИ выключен");
    expect(screen.getByTestId("dai-pct")).toHaveTextContent("порог предупреждения");
    const att = screen.getByTestId("attention");
    expect(att).toHaveTextContent("Расход ИИ достиг порога предупреждения 80 %");
    expect(att).toHaveTextContent("ИИ выключен (аварийная остановка)");
    // without qa.read / costs.read the counts are shown without links
    expect(screen.queryByTestId("att-appeals")).toBeNull();
    expect(screen.getByTestId("att-appeals-n")).toHaveTextContent("2");
    expect(screen.getByTestId("att-human-review-n")).toHaveTextContent("1");
    expect(screen.queryByTestId("dls-appeals-link")).toBeNull();
    cleanup();
    handler = (_m, p) => (p === "/dashboard" ? { status: 200, body: { ...base, lessons: { available: false, data: null, service: "lessons" } } } : undefined);
    ui(<Overview />, ["dashboard.read", "qa.read"]);
    expect(await screen.findByTestId("block-lessons-off")).toHaveTextContent("lessons");
    expect(screen.getByTestId("block-ai")).toHaveAttribute("data-available", "true");
  });
});

describe("error boundary (review T2-9)", () => {
  function Boom({ when }: { when: boolean }): JSX.Element {
    if (when) throw new Error("render failed: learner Мадина");
    return <p>ok</p>;
  }
  function Harness() {
    const [bad, setBad] = useState(true);
    return (
      <>
        <button onClick={() => setBad(false)}>fix</button>
        <ErrorBoundary scope="section">
          <Boom when={bad} />
        </ErrorBoundary>
      </>
    );
  }
  it("a render error shows «Раздел не открылся» with a retry instead of a blank page; nothing of the error is shown", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ui(<Harness />, ["dashboard.read"]);
    const box = screen.getByTestId("section-crash");
    expect(box).toHaveTextContent("Раздел не открылся");
    expect(box).not.toHaveTextContent("Мадина");
    fireEvent.click(screen.getByText("fix"));
    fireEvent.click(screen.getByTestId("crash-retry"));
    expect(screen.getByText("ok")).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe("staff four-eyes and usernames", () => {
  const a = (kind: string, summary: Record<string, unknown> = {}) => ({ kind, summary }) as Parameters<typeof issuesPassword>[0];
  it("the approver gets a temporary password for create / role grant / re-enable / password reset (P2-1, P2-2)", () => {
    expect(issuesPassword(a("staff.create_privileged"))).toBe(true);
    expect(issuesPassword(a("staff.role_grant"))).toBe(true);
    expect(issuesPassword(a("staff.reactivate_privileged"))).toBe(true);
    expect(issuesPassword(a("staff.privileged_reset", { action: "password" }))).toBe(true);
    expect(issuesPassword(a("staff.privileged_reset", { action: "mfa" }))).toBe(false);
    expect(issuesPassword(a("staff.privileged_revoke"))).toBe(false);
    expect(issuesPassword(a("role.permissions_change"))).toBe(false);
  });
  it("the re-enable request reads «Доступ отозван → Активен · role» with the admin-identity summary", () => {
    const tr = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate("ru", k, v);
    const ap = (summary: Record<string, unknown>) => ({ kind: "staff.reactivate_privileged", summary }) as Parameters<typeof approvalLabel>[0];
    const staff = { staff_id: "x", email: "former@tilhero.local", display_name: "Бахром" };
    expect(approvalLabel(ap({ staff, role: "communications", to_role: null, from_status: "DISABLED" }), (r) => r, tr)).toBe("Бахром: Доступ отозван → Активен · communications");
    expect(approvalLabel(ap({ staff, role: "communications", to_role: "operations", from_status: "DISABLED" }), (r) => r, tr)).toBe("Бахром: Доступ отозван → Активен · communications → operations");
  });
  it("privileged role — Role.privileged of GET /roles, not the static list (review T2-7)", () => {
    const roles = [
      { code: "support" as const, privileged: true }, // a step-up right was added to support → privileged by the server
      { code: "communications" as const, privileged: false },
    ];
    const priv = privilegedOf(roles);
    expect(priv("support")).toBe(true);
    expect(priv("communications")).toBe(false);
    // a role /roles did not list, or /roles not loaded yet — the contract's default list
    expect(priv("super_admin")).toBe(true);
    expect(priv("analyst")).toBe(false);
    expect(privilegedOf(null)("operations")).toBe(true);
    expect(privilegedOf(null)("support")).toBe(false);
  });
  it("username: shown as received with one «@» (the mask too)", () => {
    expect(tgHandle("ig•••81")).toBe("@ig•••81");
    expect(tgHandle("•••")).toBe("@•••");
    expect(tgHandle("madina_k")).toBe("@madina_k");
    expect(tgHandle("@madina_k")).toBe("@madina_k");
  });
});
