import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, type Lang } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { consentPurposes } from "../../state/consent";
import { budgetState, preferencesPatch, type PrefDraft, type PrefSection } from "../../state/prefs";
import { haptic, useMainButton } from "../../tg";
import { Icon, type IconName } from "../../ui/Icon";
import { Flap, Note, Spinner, Wordmark } from "../../ui/kit";

export interface OnboardingResult {
  draft: PrefDraft;
  notify: boolean;
  lang: Lang;
}

type Phase = "saving" | "queue" | "done" | "error";

function deviceTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(tz) ? tz : null;
  } catch {
    return null;
  }
}

const AGENT_STEPS = 4; // discovery, verification, flights & hotel, recommendations

/**
 * «Собираем подборку»: saves consent + preferences + departures + settings, completes onboarding,
 * then shows the agents as queued. No invented numbers — events arrive in sprints 3–5.
 */

export function FirstPick({ input }: { input: OnboardingResult }) {
  const { api, session, applySession, onboardingDone, setProfile } = useApp();
  const { t } = useI18n();
  const errText = useErrorText();
  const [phase, setPhase] = useState<Phase>("saving");
  const [queued, setQueued] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const run = useCallback(async () => {
    setPhase("saving");
    setError(null);
    try {
      // 1. consent with 18+ (required purposes + notifications if the user opted in)
      const consent = session.consent;
      if (!(consent.accepted && consent.policy_version === consent.current_policy_version)) {
        const policy = await api.legal.policy(input.lang).catch(() => null);
        const purposes = consentPurposes(policy, { notifications: input.notify });
        const st = await api.profile.acceptConsent({ policy_version: policy?.version ?? consent.current_policy_version, purposes, age_confirmed_18_plus: true });
        applySession({ ...session, consent: st });
      }
      // 2. preferences (only sections the user actually filled — «Настрою позже» keeps server defaults)
      const d = input.draft;
      const sections: PrefSection[] = ["horizon", "flights"];
      if (d.interests.length || d.entities.length) sections.push("interests");
      if (d.geo.length) sections.push("geo");
      if (budgetState(d) === "ok") sections.push("budget");
      // no optimistic version here: a retry after a partial save must not hit 409
      await api.profile.preferences(preferencesPatch(d, sections));
      // 3. departures (never pre-filled: only what the user picked)
      if (d.deps.length) await api.profile.departures(d.deps.map((x) => x.airport_iata));
      // 4. notifications + language + device time zone
      const tz = deviceTimezone();
      await api.profile.settings({ locale: input.lang, notifications: { enabled: input.notify, ...(tz ? { timezone: tz } : {}) } });
      // 5. done
      await api.profile.completeOnboarding();
      haptic.notify("success");
      setPhase("queue");
    } catch (e) {
      haptic.notify("error");
      setError(errText(e));
      setPhase("error");
    }
  }, [api, applySession, errText, input, session]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  // the agents are queued one after another (AGENT_STEPS rows after the profile row) — a single orchestrated motion moment
  useEffect(() => {
    if (phase !== "queue") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setQueued(AGENT_STEPS);
      setPhase("done");
      return;
    }
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setQueued(i);
      haptic.impact("light");
      if (i >= AGENT_STEPS) {
        clearInterval(id);
        setPhase("done");
      }
    }, 320);
    return () => clearInterval(id);
  }, [phase]);

  useMainButton(
    phase === "error"
      ? { text: t("common.retry"), onClick: () => void run() }
      : phase === "done"
        ? {
            text: t("fp.go"),
            onClick: () => {
              void api.profile.get().then(setProfile, () => undefined);
              onboardingDone();
            },
          }
        : { text: t("fp.working"), onClick: () => undefined, progress: true },
  );

  const saveState = phase === "saving" ? "run" : phase === "error" ? "err" : "done";
  const rows: Array<{ icon: IconName; title: string; sub: string; state: "run" | "done" | "err" | "queued" | "wait" }> = [
    { icon: "shield", title: t("fp.save"), sub: t("fp.saveSub"), state: saveState },
    { icon: "search", title: t("fp.a1"), sub: t("fp.a1s"), state: queued >= 1 ? "queued" : "wait" },
    { icon: "shield", title: t("fp.a2"), sub: t("fp.a2s"), state: queued >= 2 ? "queued" : "wait" },
    { icon: "plane", title: t("fp.a4"), sub: t("fp.a4s"), state: queued >= 3 ? "queued" : "wait" },
    { icon: "spark", title: t("fp.a3"), sub: t("fp.a3s"), state: queued >= 4 ? "queued" : "wait" },
  ];

  return (
    <div className="fp" data-testid="first-pick">
      <div className="ob-top">
        <Wordmark />
      </div>
      <h1 className="ob-h mt16">{t("fp.h")}</h1>
      <p className="ob-sub">{t("fp.sub")}</p>
      <ul className="board fp-board" aria-live="polite">
        {rows.map((r) => (
          <li key={r.title} className={`fp-row ${r.state === "wait" ? "" : r.state}`}>
            <span className="fp-ic">{r.state === "run" ? <Spinner small /> : <Icon name={r.state === "done" ? "check" : r.icon} size={17} />}</span>
            <div className="fp-t">
              <b>{r.title}</b>
              <small>{r.sub}</small>
            </div>
            <Flap tone={r.state === "done" ? "lime" : r.state === "err" ? "bad" : r.state === "queued" ? "info" : undefined} className="num">
              {r.state === "done" ? t("flap.ok") : r.state === "err" ? t("flap.err") : r.state === "queued" ? t("flap.queued") : t("flap.wait")}
            </Flap>
          </li>
        ))}
      </ul>
      <div className="fp-done">
        {phase === "done" && (
          <Note tone="lime" icon="check">
            {t("fp.done")}
            {input.draft.deps.length ? "" : ` ${t("fp.nodep")}`}
          </Note>
        )}
        {phase === "error" && error && (
          <Note tone="bad" icon="alert">
            {t("fp.err", { msg: error })}
          </Note>
        )}
      </div>
    </div>
  );
}
