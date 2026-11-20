/**
 * The parent's switch «Запись голоса» for child profiles: two children switched one right after the other — the answers
 * arrive later and in any order — both keep their value (the session is updated from its current state, not from the
 * render that started the request).
 */
import type { LearnerSummary, LearningPlan, SessionResponse } from "@tilhero/contracts/bff";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { Bff } from "../src/api/bff";
import { FALLBACK_CONFIG } from "../src/config/experience";
import { children } from "../src/domain/people";
import { I18nProvider } from "../src/i18n";
import { ChildVoiceToggle } from "../src/screens/profile/VoiceConsent";
import { AppProvider, type AppCtx } from "../src/state/app";
import { useNav } from "../src/state/nav";
import { ToastHost } from "../src/ui/overlays";

const ME = "6f1c2b3a-1111-4a2b-9c3d-000000000001";
const A = "7a1c2b3a-2222-4a2b-9c3d-0000000000a1";
const B = "7a1c2b3a-2222-4a2b-9c3d-0000000000b2";
const kid = (id: string, name: string): LearnerSummary => ({ learner_id: id, kind: "child", display_name: name, age_band: "6-9", is_active: false, onboarding_completed: true, voice_consent: false });
const self: LearnerSummary = { learner_id: ME, kind: "self", display_name: "Азиз", age_band: "18+", is_active: true, onboarding_completed: true, voice_consent: false };

const SESSION: SessionResponse = {
  access_token: "acc", expires_in: 900, refresh_token: "ref",
  account: { user_id: ME, display_name: "Азиз", username: null, locale: "ru", status: "ACTIVE", is_new: false, age_band: "18+", guardian_consent: "not_required" },
  learner: self, learners: [self, kid(A, "Мадина"), kid(B, "Тимур")],
  security: { pin_enabled: false, pin_length: null, biometric_enabled: false, pin_required: false, locked_until: null, pin_reset_effective_at: null },
  consent: { accepted: true, policy_version: "1.2", current_policy_version: "1.2", accepted_at: "2026-11-10T08:00:00Z", evidence_hash: "x", purposes: ["terms", "privacy", "learning"] },
  onboarding_completed: true, start_param: null,
};
const PLAN = { learner_id: ME } as LearningPlan;

/** The BFF answers each switch only when the test says so. */
function slowBff() {
  const waiting: Array<{ id: string; granted: boolean; resolve: () => void }> = [];
  const bff = {
    setChildVoiceConsent: (id: string, granted: boolean) =>
      new Promise<LearnerSummary>((res) => waiting.push({ id, granted, resolve: () => res({ ...SESSION.learners.find((l) => l.learner_id === id)!, voice_consent: granted }) })),
  } as unknown as Bff;
  return { bff, waiting };
}

function Harness({ bff }: { bff: Bff }) {
  const [session, setSession] = useState<SessionResponse>(SESSION);
  const nav = useNav();
  const ctx: AppCtx = {
    bff, session, applySession: async () => undefined, syncProfile: () => undefined,
    patchSession: (p) => setSession((prev) => ({ ...prev, ...(typeof p === "function" ? p(prev) : p) })),
    plan: PLAN, setPlan: () => undefined, reloadPlan: async () => PLAN, config: FALLBACK_CONFIG, nav, unread: 0, setUnread: () => undefined,
    refreshUnread: () => undefined, openLink: () => undefined, endSession: () => undefined, deviceTz: "Asia/Tashkent", online: true,
  };
  return (
    <AppProvider value={ctx}>
      <div className="list">
        {children(session).map((k) => (
          <ChildVoiceToggle key={k.learner_id} child={k} />
        ))}
      </div>
      <ToastHost />
    </AppProvider>
  );
}

describe("the parent's voice switch for children", () => {
  it("two children switched quickly both stay on, whatever order the answers come in", async () => {
    const { bff, waiting } = slowBff();
    render(
      <I18nProvider initial="ru">
        <Harness bff={bff} />
      </I18nProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`vc-child-${A}`));
    await user.click(screen.getByTestId(`vc-child-${B}`));
    expect(waiting.map((w) => [w.id, w.granted])).toEqual([[A, true], [B, true]]);
    // the second answer first, then the first one
    await act(async () => waiting[1]!.resolve());
    await act(async () => waiting[0]!.resolve());
    expect(screen.getByTestId(`vc-child-${A}`)).toBeChecked();
    expect(screen.getByTestId(`vc-child-${B}`)).toBeChecked();
  });
});
