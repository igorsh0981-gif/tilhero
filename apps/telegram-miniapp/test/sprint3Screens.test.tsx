/**
 * Sprint 3 screens on a fake BFF (fetch): the placement test (choice, «Не знаю», word order by taps, listening with the
 * device voice and without it), the result (CEFR disclaimer, not_assessed reasons, follow-up only within 24 h, retake
 * date), Home's learning card, the skill map (CATALOG_UNAVAILABLE), song / film requests (children — no calls),
 * the binary audio call of the client.
 */
import type { DiagnosticResult, LearningPlan, SessionResponse } from "@tilhero/contracts/bff";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBff } from "../src/api/bff";
import { ApiClient } from "../src/api/client";
import { FALLBACK_CONFIG } from "../src/config/experience";
import { I18nProvider } from "../src/i18n";
import { Diagnostics } from "../src/screens/diagnostics/Diagnostics";
import { ResultView } from "../src/screens/diagnostics/Result";
import { Home } from "../src/screens/home/Home";
import { tooSoonKey } from "../src/screens/diagnostics/Diagnostics";
import { MediaRequests } from "../src/screens/practice/MediaRequests";
import { MediaScreen } from "../src/screens/practice/MediaScreen";
import { SkillMap } from "../src/screens/skills/SkillMap";
import { AppProvider, type AppCtx } from "../src/state/app";
import { useNav, type Nav, type Pushed } from "../src/state/nav";
import { ToastHost } from "../src/ui/overlays";

const ME = "6f1c2b3a-1111-4a2b-9c3d-000000000001";
const L = (ru: string) => ({ ru, uz: `${ru} uz` });

const ITEMS = [
  { item_id: "v1", area: "vocabulary", type: "single_choice", instruction: L("Выберите перевод"), prompt_en: "a ticket", passage_en: null, audio_text_en: null, options: ["билет", "чек"], position: 1 },
  { item_id: "g1", area: "grammar", type: "order_words", instruction: L("Соберите фразу"), prompt_en: "Put the words in order", passage_en: null, audio_text_en: null, options: ["am", "I", "here"], position: 2 },
  { item_id: "l1", area: "listening", type: "listen_choice", instruction: L("Послушайте"), prompt_en: "What does she want?", passage_en: null, audio_text_en: "A cup of tea, please.", options: ["tea", "coffee"], position: 3 },
];

function result(over: Partial<DiagnosticResult> = {}): DiagnosticResult {
  return {
    result_id: "4e5a0000-aaaa-4bbb-8ccc-000000000001",
    revision: 1,
    pair_id: "ru-en",
    test_version: "dx-en-adult@1",
    provisional_level: "A1",
    areas: [
      { area: "vocabulary", status: "assessed", band: "A2", confidence: 0.8, reason: null, evidence: [{ band: "A2", answered: 3, correct: 1 }, { band: "A1", answered: 3, correct: 3 }], needs_followup: false },
      { area: "grammar", status: "assessed", band: "A1", confidence: 0.4, reason: null, evidence: [{ band: "A1", answered: 2, correct: 1 }], needs_followup: true },
      { area: "listening", status: "not_assessed", band: null, confidence: null, reason: "no_speech_voice", evidence: [], needs_followup: false },
      { area: "speaking", status: "not_assessed", band: null, confidence: null, reason: "not_in_test_yet", evidence: [], needs_followup: false },
    ],
    weak_areas: ["listening"],
    recommended_start: null,
    cefr_certificate: false,
    created_at: new Date().toISOString(),
    ...over,
  };
}

function fakeServer(o: { diag?: "none" | "completed"; skillsDown?: boolean; nextAllowedAt?: string | null } = {}) {
  const calls: Array<{ key: string; body: any; headers: Record<string, string> }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let answered = 0;
  let listening = true;
  let res: DiagnosticResult | null = o.diag === "completed" ? result() : null;
  const requests: unknown[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ key, body, headers });
    const ok = (b: unknown, status = 200) => new Response(b === undefined ? null : JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    const err = (status: number, code: string, details: Record<string, unknown> = {}) => ok({ code, message: code, trace_id: "t", details }, status);
    const items = ITEMS.filter((i) => listening || i.area !== "listening");
    const session = { session_id: "d1a90000-aaaa-4bbb-8ccc-000000000001", pair_id: "ru-en", test_version: "dx-en-adult@1", status: "in_progress", answered, total_estimate: 3, started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), followup_area: null };
    switch (key) {
      case "GET /v1/diagnostics/state":
        return ok({ pair_id: "ru-en", status: res ? "completed" : "none", session: null, last_result: res, next_allowed_at: o.nextAllowedAt ?? null, audience: "adults" });
      case "POST /v1/diagnostics/sessions":
        return ok(session, 201);
      case `GET /v1/diagnostics/sessions/${session.session_id}/next`:
        return ok(items[answered] ? { ...items[answered], position: answered + 1 } : { done: true });
      case `POST /v1/diagnostics/sessions/${session.session_id}/answers`:
        answered += 1;
        return ok({ accepted: true, next: items[answered] ? { ...items[answered], position: answered + 1 } : null, done: !items[answered] });
      case `POST /v1/diagnostics/sessions/${session.session_id}/listening-unavailable`:
        listening = false;
        return new Response(null, { status: 204 });
      case `POST /v1/diagnostics/sessions/${session.session_id}/finish`:
        res = result({ areas: result().areas.map((a) => (a.area === "listening" ? { ...a, reason: listening ? "too_few_items" : "no_speech_voice" } : a)) });
        return ok(res);
      case "GET /v1/diagnostics/results":
        return ok({ items: res ? [res] : [] });
      case "GET /v1/plan/trajectory":
        return ok({
          pair_id: "ru-en", course_id: "en-core", revision: 1, basis: { diagnostic_result_id: res?.result_id ?? null, goal: "travel", computed_at: new Date().toISOString() },
          next: { lesson_id: "l1", module_id: "m1", title: L("В кафе"), goal: L("Заказать напиток"), level: "A1", kind: "core", duration_min: 20, primary_skill_id: "s", scenario_id: null, stages: [], reason_codes: ["weak_area"], explanation: L("Начнём с вежливых просьб") },
          mandatory: [], optional: [], completed: [], lessons_available: false,
        });
      case "GET /v1/skills/map":
        if (o.skillsDown) return err(503, "CATALOG_UNAVAILABLE", { service: "catalog" });
        return ok({ pair_id: "ru-en", course_id: "en-core", counts: { not_started: 1, learning: 1, demonstrated: 0, retained: 0 }, skills: [
          { skill_id: "en.a", area: "grammar", title: L("Глагол to be"), level: "A1", state: "learning", confidence: 0.4, prerequisites: [], updated_at: null, history: [{ source: "diagnostic", outcome: "negative", at: "2026-11-19T08:00:00Z" }] },
          { skill_id: "en.b", area: "vocabulary", title: L("Еда"), level: "A1", state: "not_started", confidence: null, prerequisites: ["en.a"], updated_at: null, history: [] },
        ] });
      case "GET /v1/media/requests":
        return ok({ items: requests });
      case "POST /v1/media/requests": {
        if (requests.length >= 1 && body.title === "limit") return err(429, "MEDIA_REQUEST_LIMIT", { retry_after: 3600 });
        const r = { request_id: `7e900000-aaaa-4bbb-8ccc-00000000000${requests.length}`, kind: body.kind, title: body.title, link: body.link ?? null, comment: body.comment ?? null, status: "new", decision_note: null, linked_asset_id: null, created_at: new Date().toISOString(), decided_at: null };
        requests.unshift(r);
        return ok(r, 201);
      }
      case "GET /v1/media/m-quotes":
        // the licence allows the transcript, not listening
        return ok({ asset_id: "m-quotes", type: "dialogue", title: L("Фразы"), level: "A2", topics: [], duration_s: 20, source_label: "TilHero", allowed_uses: ["show_transcript", "translation"], has_audio: false,
          attribution: null, transcript: [{ t_start_ms: 0, t_end_ms: 2000, speaker: "Host", text_en: "Hello there.", gloss: L("Привет.") }], phrases: [], voices: { Host: "en-GB" }, exercises_available: false });
      case "GET /v1/media/m-tts":
        return ok({ asset_id: "m-tts", type: "dialogue", title: L("Диалог"), level: "A1", topics: [], duration_s: 20, source_label: "TilHero", allowed_uses: ["listen", "show_transcript"], has_audio: false,
          attribution: null, transcript: [{ t_start_ms: 0, t_end_ms: 2000, speaker: "Host", text_en: "Hello there.", gloss: null }], phrases: [], voices: { Host: "en-GB" }, exercises_available: false });
      case "GET /v1/plan/today":
        return ok({ local_date: "2026-11-18", is_scheduled_today: true, slot_time: "19:00", duration_min: 20, minutes_today: 0, done_today: false, next_slot: null, streak_days: 0, week: [] });
      default:
        return err(404, "NOT_FOUND");
    }
  }) as typeof fetch;
  const client = new ApiClient({ baseUrl: "", fetchImpl, storage: null, timezone: () => "Asia/Tashkent" });
  return { calls, bff: createBff(client), client, callsTo: (k: string) => calls.filter((c) => c.key === k) };
}

const PLAN: LearningPlan = {
  learner_id: ME, goal: "travel", level_self: "beginner", topics: [], ui_lang: "ru", explain_lang: "ru", course_pair: "ru-en",
  schedule: { preset: "daily", days: [1, 2, 3, 4, 5, 6, 7], preferred_time: "19:00", duration_min: 20, reminders_enabled: true, timezone: "Asia/Tashkent" },
  onboarding_completed_at: "2026-11-10T08:00:00Z", updated_at: "2026-11-10T08:00:00Z", version: 1,
};
function session(kid: boolean): SessionResponse {
  const learner = { learner_id: ME, kind: kid ? ("child" as const) : ("self" as const), display_name: "Азиз", age_band: kid ? ("6-9" as const) : ("18+" as const), is_active: true, onboarding_completed: true };
  return {
    access_token: "acc", expires_in: 900, refresh_token: "ref",
    account: { user_id: ME, display_name: "Азиз", username: null, locale: "ru", status: "ACTIVE", is_new: false, age_band: "18+", guardian_consent: "not_required" },
    learner, learners: [learner],
    security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null, pin_reset_effective_at: null },
    consent: { accepted: true, policy_version: "1.2", current_policy_version: "1.2", accepted_at: "2026-11-10T08:00:00Z", evidence_hash: "x", purposes: ["terms", "privacy", "learning"] },
    onboarding_completed: true, start_param: null,
  };
}

let navRef: Nav | null = null;
function Shell({ server, kid, children, stack }: { server: ReturnType<typeof fakeServer>; kid?: boolean; children: ReactNode; stack?: Pushed[] }) {
  const [plan, setPlan] = useState<LearningPlan>(PLAN);
  const nav = useNav({ tab: "home", stack: stack ?? [] });
  navRef = nav;
  const ctx: AppCtx = {
    bff: server.bff, session: session(!!kid), applySession: async () => undefined, syncProfile: () => undefined, patchSession: () => undefined,
    plan, setPlan, reloadPlan: async () => plan, config: FALLBACK_CONFIG, nav, unread: 0, setUnread: () => undefined, refreshUnread: () => undefined,
    openLink: () => undefined, endSession: () => undefined, deviceTz: "Asia/Tashkent", online: true,
  };
  return (
    <AppProvider value={ctx}>
      {children}
      <ToastHost />
    </AppProvider>
  );
}
function mount(ui: ReactNode, o: Parameters<typeof fakeServer>[0] & { kid?: boolean; lang?: "ru" | "uz"; stack?: Pushed[] } = {}) {
  const server = fakeServer(o);
  render(
    <I18nProvider initial={o.lang ?? "ru"}>
      <Shell server={server} kid={o.kid} stack={o.stack}>{ui}</Shell>
    </I18nProvider>,
  );
  return server;
}

/** Device voices for the listening item (jsdom has no speechSynthesis). */
function installVoices(voices: Array<{ lang: string; name: string }>) {
  const spoken: string[] = [];
  class U {
    text: string;
    lang = "";
    voice: unknown = null;
    rate = 1;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(t: string) {
      this.text = t;
    }
  }
  Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, writable: true, value: U });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: { getVoices: () => voices, speak: (u: U) => (spoken.push(u.text), setTimeout(() => u.onend?.(), 5)), cancel: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined },
  });
  return spoken;
}

beforeEach(() => {
  navRef = null;
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).speechSynthesis;
  vi.useRealTimers();
});

describe("placement test", () => {
  it("intro → choice → word order by taps → listening (≤ 2 plays, text hidden) → result; no correctness shown", async () => {
    const spoken = installVoices([{ lang: "en-GB", name: "UK" }]);
    const server = mount(<Diagnostics />);
    expect(await screen.findByTestId("dx-intro")).toHaveTextContent("не экзамен и не сертификат");
    await userEvent.click(screen.getByTestId("dx-start"));
    expect(server.callsTo("POST /v1/diagnostics/sessions")[0]!.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);

    await screen.findByTestId("dx-item-single_choice");
    expect(screen.getByTestId("dx-answer")).toBeDisabled();
    await userEvent.click(screen.getByTestId("dx-opt-0"));
    await userEvent.click(screen.getByTestId("dx-answer"));
    expect(server.callsTo("POST /v1/diagnostics/sessions/d1a90000-aaaa-4bbb-8ccc-000000000001/answers")[0]!.body).toMatchObject({ item_id: "v1", answer: 0, dont_know: false });

    await screen.findByTestId("dx-item-order_words");
    await userEvent.click(screen.getByTestId("ow-word-1")); // I
    await userEvent.click(screen.getByTestId("ow-word-2")); // here (wrong) → tap it back
    await userEvent.click(screen.getByTestId("ow-line-1"));
    await userEvent.click(screen.getByTestId("ow-word-0")); // am
    expect(screen.getByTestId("dx-answer")).toBeDisabled(); // not every word used yet
    await userEvent.click(screen.getByTestId("ow-word-2"));
    await userEvent.click(screen.getByTestId("dx-answer"));
    expect(server.callsTo("POST /v1/diagnostics/sessions/d1a90000-aaaa-4bbb-8ccc-000000000001/answers")[1]!.body).toMatchObject({ item_id: "g1", answer: ["I", "am", "here"] });

    await screen.findByTestId("dx-item-listen_choice");
    expect(screen.getByTestId("dx-item-listen_choice")).not.toHaveTextContent("A cup of tea");
    const play = screen.getByTestId("dx-listen-play");
    await userEvent.click(play);
    await waitFor(() => expect(play).not.toBeDisabled());
    await userEvent.click(play);
    await waitFor(() => expect(screen.getByTestId("dx-listen-left")).toHaveTextContent("Прослушивания закончились"));
    expect(play).toBeDisabled();
    expect(spoken).toEqual(["A cup of tea, please.", "A cup of tea, please."]);
    expect(screen.queryByText(/верно|неверно/)).toBeNull(); // no correctness during the test
    await userEvent.click(screen.getByTestId("dx-dont-know"));
    expect(server.callsTo("POST /v1/diagnostics/sessions/d1a90000-aaaa-4bbb-8ccc-000000000001/answers")[2]!.body).toMatchObject({ item_id: "l1", answer: null, dont_know: true });

    expect(await screen.findByTestId("dx-result")).toBeInTheDocument();
    expect(screen.getByTestId("not-cefr")).toHaveTextContent("Это не сертификат CEFR");
    // the evidence (correct / wrong) only inside the closed «почему так»
    expect(screen.getByTestId("why-grammar")).not.toHaveAttribute("open");
  });

  it("no English voice on the device → listening-unavailable once, the learner is told, the test goes on", async () => {
    installVoices([{ lang: "ru-RU", name: "RU" }]);
    const server = mount(<Diagnostics />);
    await userEvent.click(await screen.findByTestId("dx-start"));
    await userEvent.click(await screen.findByTestId("dx-dont-know"));
    await screen.findByTestId("dx-item-order_words");
    await userEvent.click(screen.getByTestId("dx-dont-know"));
    // the listening item is skipped: reported, then the server says done → result
    expect(await screen.findByTestId("dx-result", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(server.callsTo("POST /v1/diagnostics/sessions/d1a90000-aaaa-4bbb-8ccc-000000000001/listening-unavailable")).toHaveLength(1);
    expect(within(screen.getByTestId("area-listening")).getByTestId("reason-listening")).toHaveTextContent("не нашлось английского голоса");
  });
});

describe("result", () => {
  it("not_assessed with the reason, follow-up only for needs_followup within 24 h, retake date, start of the course without a lesson", async () => {
    const onFollowup = vi.fn();
    mount(<ResultView result={result()} nextAllowedAt="2026-12-03T08:00:00Z" actions onFollowup={onFollowup} onRetake={() => undefined} />);
    expect(screen.getByTestId("dx-level")).toHaveTextContent("Предварительный уровень: A1");
    expect(screen.getByTestId("reason-speaking")).toHaveTextContent("Говорение — после появления голосовых уроков");
    expect(screen.queryByTestId("followup-vocabulary")).toBeNull();
    await userEvent.click(screen.getByTestId("followup-grammar"));
    expect(onFollowup).toHaveBeenCalledWith("grammar");
    expect(screen.getByTestId("conf-grammar")).toHaveAttribute("aria-label", "уверенность низкая: 1 из 3");
    expect(screen.getByTestId("retake")).toBeDisabled();
    expect(screen.getByTestId("retake-note")).toHaveTextContent("Пройти снова можно с 3 декабря");
    expect(screen.getByTestId("dx-start-lesson")).toHaveTextContent("Начнём с первого урока курса");
  });

  it("«почему так» — по полосам, без заданий; пояснение, как получилась полоса; детям — проще", async () => {
    mount(<ResultView result={result()} nextAllowedAt={null} actions={false} />);
    const why = screen.getByTestId("why-vocabulary");
    await userEvent.click(within(why).getByText("Почему так"));
    expect(within(why).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["A1 — 3 из 3 верно", "A2 — 1 из 3 верно"]);
    expect(screen.getByTestId("why-how-vocabulary")).toHaveTextContent("не по одному удачному ответу");
    expect(screen.queryByTestId("why-listening")).toBeNull(); // not_assessed: no evidence
  });

  it("детям — простое пояснение «почему так»", () => {
    mount(<ResultView result={result()} nextAllowedAt={null} actions={false} />, { kid: true });
    expect(screen.getByTestId("why-how-grammar")).toHaveTextContent("Смотрим, на каком уровне у тебя получилось больше всего ответов.");
  });

  it("три результата без оценённой области: повтор недоступен — «слишком много незаконченных проверок»", () => {
    const empty = result({ provisional_level: null, areas: result().areas.map((a) => ({ ...a, status: "not_assessed" as const, band: null, confidence: null, reason: "too_few_items" as const, evidence: [], needs_followup: false })) });
    mount(<ResultView result={empty} nextAllowedAt="2026-12-03T08:00:00Z" actions onRetake={() => undefined} />);
    expect(screen.getByTestId("retake")).toBeDisabled();
    expect(screen.getByTestId("retake-note")).toHaveTextContent("Слишком много незаконченных проверок — следующая будет доступна 3 декабря");
  });

  it("an old result: no follow-up after 24 h; «недостаточно данных» without a level; UZ", () => {
    mount(<ResultView result={result({ provisional_level: null, created_at: "2026-11-01T08:00:00Z" })} nextAllowedAt={null} actions onFollowup={() => undefined} />, { lang: "uz" });
    expect(screen.queryByTestId("followup-grammar")).toBeNull();
    expect(screen.getByTestId("dx-level")).toHaveTextContent("Umumiy daraja uchun maʼlumot yetarli emas");
    expect(screen.getByTestId("not-cefr")).toHaveTextContent("CEFR sertifikati emas");
    expect(screen.getByTestId("retake")).not.toBeDisabled();
  });
});

describe("Home — learning card", () => {
  it("no placement test → «Узнаем ваш уровень · 10–15 минут» → the test", async () => {
    mount(<Home />);
    const card = await screen.findByTestId("home-diag-card");
    expect(card).toHaveTextContent("Узнаем ваш уровень · 10–15 минут");
    await userEvent.click(within(card).getByTestId("home-diag-start"));
    expect(navRef!.top).toEqual({ name: "diagnostics" });
  });
  it("done → the next lesson with «почему», «Начать урок» → the honest «скоро» of the lessons tab, plan and skills links", async () => {
    mount(<Home />, { diag: "completed" });
    expect(await screen.findByTestId("home-next-why")).toHaveTextContent("Начнём с вежливых просьб");
    await userEvent.click(screen.getByTestId("home-plan-link"));
    expect(navRef!.top).toEqual({ name: "plan" });
    await userEvent.click(screen.getByTestId("home-start-lesson"));
    expect(navRef!.tab).toBe("lessons");
  });
});

describe("skill map", () => {
  it("states by glyph and word, history on tap", async () => {
    mount(<SkillMap />, { diag: "completed" });
    const row = await screen.findByTestId("skill-en.a");
    expect(row).toHaveTextContent("изучается");
    expect(row.querySelector("[data-state=learning] .g")?.textContent).toBe("◐");
    await userEvent.click(within(row).getByRole("button"));
    expect(within(row).getByTestId("skill-history")).toHaveTextContent("Проверка уровня");
    expect(screen.getByTestId("skill-en.b")).toHaveTextContent("Основа: Глагол to be");
  });
  it("503 CATALOG_UNAVAILABLE → «карта навыков временно недоступна»", async () => {
    mount(<SkillMap />, { skillsDown: true });
    expect(await screen.findByTestId("sk-unavailable")).toHaveTextContent("Карта навыков временно недоступна");
  });
});

describe("song / film requests", () => {
  it("child profile: the explanation «попросите родителя», no calls to the BFF", async () => {
    const server = mount(<MediaRequests />, { kid: true });
    expect(await screen.findByTestId("mr-kids")).toHaveTextContent("Попроси родителя");
    expect(server.calls.filter((c) => c.key.includes("/media/requests"))).toHaveLength(0);
  });
  it("honest text; https only; one Idempotency-Key per draft; the new request on top of «Мои заявки»", async () => {
    const server = mount(<MediaRequests />);
    expect(await screen.findByTestId("mr-honest")).toHaveTextContent("мы не скачиваем и не загружаем материалы по ссылке");
    await userEvent.type(screen.getByTestId("mr-title"), "Yesterday");
    await userEvent.type(screen.getByTestId("mr-link"), "http://example.com");
    expect(screen.getByText("Ссылка должна начинаться с https://")).toBeInTheDocument();
    expect(screen.getByTestId("mr-send")).toBeDisabled();
    await userEvent.clear(screen.getByTestId("mr-link"));
    await userEvent.type(screen.getByTestId("mr-link"), "https://example.com/song");
    await userEvent.click(screen.getByTestId("mr-send"));
    const call = server.callsTo("POST /v1/media/requests")[0]!;
    expect(call.body).toEqual({ kind: "song", title: "Yesterday", link: "https://example.com/song" });
    expect(call.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByTestId("toast")).toHaveTextContent("Заявка отправлена");
    expect(within(screen.getByTestId("mr-list")).getByText("Yesterday")).toBeInTheDocument();
    expect(within(screen.getByTestId("mr-list")).getByText("новая")).toBeInTheDocument();
  });
  it("> 5 a day → the limit text", async () => {
    mount(<MediaRequests />);
    await userEvent.type(await screen.findByTestId("mr-title"), "first");
    await userEvent.click(screen.getByTestId("mr-send"));
    await screen.findByText("first");
    await userEvent.type(screen.getByTestId("mr-title"), "limit");
    await userEvent.click(screen.getByTestId("mr-send"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Не больше 5 заявок в сутки");
  });
});

describe("media — listening only with the licence", () => {
  it("без `listen`: ни файла, ни синтеза речи по транскрипту — кнопки нет, объяснение; транскрипт есть", async () => {
    const spoken = installVoices([{ lang: "en-GB", name: "UK" }]);
    mount(<MediaScreen id="m-quotes" />);
    expect(await screen.findByTestId("md-no-listen")).toHaveTextContent("Прослушивание недоступно по условиям лицензии.");
    expect(screen.queryByTestId("md-play")).toBeNull();
    expect(screen.queryByTestId("md-tts")).toBeNull();
    expect(screen.getByTestId("md-transcript")).toHaveTextContent("Hello there.");
    expect(spoken).toEqual([]);
  });
  it("с `listen` и без файла — синтез речи с пометкой; перевод не разрешён (gloss null) — реплики не раскрываются", async () => {
    const spoken = installVoices([{ lang: "en-GB", name: "UK" }]);
    mount(<MediaScreen id="m-tts" />);
    expect(await screen.findByTestId("md-tts")).toHaveTextContent("синтез речи");
    await userEvent.click(screen.getByTestId("md-play"));
    await waitFor(() => expect(spoken).toEqual(["Hello there."]));
    expect(screen.queryByTestId("md-line-0")).toBeNull();
  });
});

describe("409 DIAGNOSTIC_TOO_SOON — две причины", () => {
  it("после настоящего результата — дата повтора; после результатов без оценённой области — «слишком много незаконченных»", () => {
    const st = (r: DiagnosticResult | null) => ({ pair_id: "ru-en", status: "completed" as const, session: null, last_result: r, next_allowed_at: "2026-12-03T08:00:00Z", audience: "adults" as const });
    expect(tooSoonKey(st(result()))).toBe("dxr.retakeAt");
    expect(tooSoonKey(st(result({ areas: [] })))).toBe("dx.tooManyUnfinished");
    expect(tooSoonKey(null)).toBe("dx.tooManyUnfinished");
  });
});

describe("api client — audio bytes", () => {
  it("GET /v1/media/{id}/audio with the bearer token, a Blob back; 503 CATALOG_UNAVAILABLE keeps the connection banner off", async () => {
    const seen: Array<Record<string, string>> = [];
    const online: boolean[] = [];
    const client = new ApiClient({
      baseUrl: "",
      storage: null,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string>);
        if (String(input).includes("audio")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
        return new Response(JSON.stringify({ code: "CATALOG_UNAVAILABLE", message: "x", trace_id: "t", details: {} }), { status: 503 });
      }) as typeof fetch,
      hooks: { onConnectivity: (v) => online.push(v) },
    });
    client.acceptSession(session(false));
    const bff = createBff(client);
    const blob = await bff.mediaAudio("m-own-coffee");
    expect(blob.size).toBe(3);
    expect(seen[0]!.Authorization).toBe("Bearer acc");
    await expect(bff.skillMap()).rejects.toMatchObject({ code: "CATALOG_UNAVAILABLE" });
    expect(online).toEqual([true, true]);
  });
});
