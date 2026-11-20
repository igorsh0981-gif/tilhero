import type { LearningPlan, SessionResponse } from "@tilhero/contracts/bff";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { I18nProvider } from "../src/i18n";

const ME = "6f1c2b3a-1111-4a2b-9c3d-000000000001";
const INVITE = "33333333-aaaa-4bbb-8ccc-0000000000aa";

function session(onboarded: boolean, startParam: string | null = null): SessionResponse {
  const learner = { learner_id: ME, kind: "self" as const, display_name: "Азиз", age_band: onboarded ? ("18+" as const) : null, is_active: true, onboarding_completed: onboarded, voice_consent: false };
  return {
    access_token: "acc",
    expires_in: 900,
    refresh_token: "ref",
    account: { user_id: ME, display_name: "Азиз", username: null, locale: "ru", status: "ACTIVE", is_new: !onboarded, age_band: learner.age_band, guardian_consent: "not_required" },
    learner,
    learners: [learner],
    security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null, pin_reset_effective_at: null },
    consent: { accepted: onboarded, policy_version: onboarded ? "1.2" : null, current_policy_version: "1.2", accepted_at: null, evidence_hash: null, purposes: [] },
    onboarding_completed: onboarded,
    start_param: startParam,
  };
}
const plan = (onboarded: boolean): LearningPlan => ({
  learner_id: ME,
  goal: onboarded ? "travel" : null,
  level_self: onboarded ? "some" : null,
  topics: [],
  ui_lang: "ru",
  explain_lang: "ru",
  course_pair: "ru-en",
  schedule: { preset: "daily", days: [1, 2, 3, 4, 5, 6, 7], preferred_time: "19:00", duration_min: 20, reminders_enabled: true, timezone: "Asia/Tashkent" },
  onboarding_completed_at: onboarded ? "2026-11-10T08:00:00Z" : null,
  updated_at: "2026-11-10T08:00:00Z",
  version: 3,
});

function fakeBff(opts: { onboarded: boolean; startParam?: string | null }) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push(key);
    const ok = (b: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    switch (key) {
      case "POST /v1/session/telegram":
        return ok(session(opts.onboarded, opts.startParam ?? null));
      case "GET /v1/plan":
        return ok(plan(opts.onboarded));
      case "GET /v1/experience/config":
        return ok({}, 404);
      case "POST /v1/invites/open":
        return ok({ invite_id: INVITE, kind: "family", inviter_display_name: "Мама", status: "active", can_accept: true, reason: null });
      case `POST /v1/invites/${INVITE}/accept`:
        return ok({ invite_id: INVITE, kind: "family", family: { family_id: "f", members: [] } });
      case "GET /v1/whats-new":
        return ok({ mode: "none", notes: [] });
      case "GET /v1/notifications/unread-count":
        return ok({ unread: 0 });
      case "GET /v1/plan/today":
        return ok({ local_date: "2026-11-18", is_scheduled_today: true, slot_time: "19:00", duration_min: 20, minutes_today: 0, done_today: false, next_slot: null, streak_days: 0, week: [] });
      case "GET /v1/family":
        return ok(null, 204);
      case "GET /v1/invites":
        return ok({ items: [], next_cursor: null });
      default:
        return ok({ code: "NOT_FOUND", message: "", trace_id: "t", details: {} }, 404);
    }
  }) as typeof fetch;
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  return { calls, client: { fetchImpl, storage, baseUrl: "" } };
}

function renderApp(startParam: string | null, opts: { onboarded: boolean; serverStartParam?: string | null }) {
  const f = fakeBff({ onboarded: opts.onboarded, startParam: opts.serverStartParam });
  render(
    <I18nProvider initial="ru">
      <App boot={{ kind: "dev", initData: "hash=abc&user=%7B%7D", startParam, languageCode: "ru" }} client={f.client} />
    </I18nProvider>,
  );
  return f;
}

describe("App: deep links from start_param (AT-09)", () => {
  it("inv_<token> of an onboarded learner: preview over Home, accept leads to the family", async () => {
    const f = renderApp("inv_FamTok0123456789abcdefghijklmnop", { onboarded: true });
    const dialog = await screen.findByRole("dialog", { name: "Мама приглашает вас в семью" });
    expect(f.calls).toContain("POST /v1/invites/open");
    await userEvent.click(within(dialog).getByRole("button", { name: "Принять" }));
    await waitFor(() => expect(f.calls).toContain(`POST /v1/invites/${INVITE}/accept`));
    expect(await screen.findByRole("heading", { name: "Семья и приглашения" })).toBeInTheDocument();
  });
  it("the server's start_param wins over the URL one", async () => {
    const f = renderApp(null, { onboarded: true, serverStartParam: "inv_FamTok0123456789abcdefghijklmnop" });
    await screen.findByRole("dialog", { name: "Мама приглашает вас в семью" });
    expect(f.calls.filter((c) => c === "POST /v1/invites/open")).toHaveLength(1);
  });
  it("a new user: the invitation waits for the short setup (onboarding underneath), not opened before the consents", async () => {
    const f = renderApp("inv_FamTok0123456789abcdefghijklmnop", { onboarded: false });
    // §11: the server opens an invitation only after the policy is accepted — the client does not try before
    const dialog = await screen.findByRole("dialog", { name: "Приглашение" });
    expect(f.calls).not.toContain("POST /v1/invites/open");
    expect(within(dialog).getByText("Сначала короткая настройка — затем вернёмся к приглашению.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Принять" })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Продолжить настройку" }));
    expect(screen.getByRole("heading", { name: "Говорите по-английски с ИИ-коучем" })).toBeInTheDocument();
  });
  it("route_ before onboarding is kept, an invalid start_param is ignored", async () => {
    const f = renderApp("route_javascript", { onboarded: true });
    expect(await screen.findByTestId("home")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.calls.some((c) => c.includes("/v1/invites"))).toBe(false);
  });
  it("the experience config is down → the bundled fallback; Home still renders by the plan", async () => {
    renderApp(null, { onboarded: true });
    expect(await screen.findByTestId("today-card")).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("notebook");
  });
});
