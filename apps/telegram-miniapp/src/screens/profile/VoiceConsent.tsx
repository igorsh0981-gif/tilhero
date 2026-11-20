import type { LearnerSummary } from "@tilhero/contracts/bff";
import { ApiError } from "../../api/errors";
import { consentIsCurrent } from "../../domain/onboarding";
import { children, teenWithoutConsent } from "../../domain/people";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Skeleton, ToggleRow } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";

/** The optional purpose of the policy behind «Произнести» (bff.ts «Согласия»). */
export const VOICE = "voice_recording";

/**
 * Profile → «Запись голоса» (PLAN «Решения владельца», AT-58): the account's own consent to record the voice for the
 * pronunciation score — POST /v1/profile/consent with or without voice_recording on the current policy version (the
 * required purposes and the other optional ones given stay). A teen 14–17 — only after the parent's consent (the switch is
 * off, the way to «Согласие родителя»). A parent switches it for each child profile here and in «Семья»
 * (PUT /v1/learners/{id}/voice-consent). From a child profile it cannot be changed.
 */
export function VoiceConsent() {
  const { bff, session, nav, patchSession, syncProfile } = useApp();
  const { t, lang } = useI18n();
  const kid = session.learner.kind === "child";
  const policy = useLoad(() => bff.policy(lang), [lang]);
  const c = session.consent;
  const on = c.purposes.includes(VOICE);
  const teenLocked = teenWithoutConsent(session);
  const current = consentIsCurrent(c);
  const kids = session.account.age_band === "18+" ? children(session) : [];

  const set = useAction(async (enable: boolean) => {
    const pol = policy.data ?? (await bff.policy(lang));
    const known = new Set(pol.purposes.map((p) => p.code));
    const purposes = new Set([...pol.purposes.filter((p) => p.required).map((p) => p.code), ...c.purposes.filter((p) => known.has(p))]);
    if (enable) purposes.add(VOICE);
    else purposes.delete(VOICE);
    try {
      patchSession({ consent: await bff.acceptConsent({ policy_version: pol.version, purposes: [...purposes] }) });
    } catch (e) {
      if (e instanceof ApiError && e.code === "POLICY_VERSION_OUTDATED") void policy.reload();
      throw e;
    }
    // learner.voice_consent follows from the server
    void bff.profile().then(syncProfile, () => undefined);
    showToast(enable ? t("vc.onDone") : t("vc.offDone"));
  });

  return (
    <>
      <Bar title={t("vc.title")} onBack={nav.back} />
      <main className="scroll" data-testid="voice-consent">
        <div className="pad stack">
          <div className="card stack tight">
            <p className="sub ink notice"><Icon name="mic" size={20} />{t("vc.what")}</p>
            <p className="sub">{t("vc.noAudio")}</p>
          </div>
          {kid ? (
            <div className="card warn" data-testid="vc-kid">
              <p className="sub ink">{t("vc.kid")}</p>
            </div>
          ) : (
            <>
              {policy.loading && !policy.data ? <Skeleton lines={1} /> : null}
              <div className="list">
                <ToggleRow
                  title={t("vc.toggle")}
                  note={teenLocked ? t("vc.teenLocked") : on ? t("vc.onNote") : t("vc.offNote")}
                  checked={on}
                  disabled={teenLocked || set.busy || !current || (!policy.data && policy.loading)}
                  onChange={(v) => void set.run(v)}
                  testId="vc-self"
                />
              </div>
              {teenLocked ? (
                <Btn variant="link" onClick={() => nav.push({ name: "guardian" })} data-testid="vc-to-guardian">
                  {t("profile.guardian")}
                </Btn>
              ) : null}
              {!current ? (
                <Btn variant="link" onClick={() => nav.push({ name: "privacy" })}>{t("vc.policyFirst")}</Btn>
              ) : null}
              <ErrorLine text={set.error ?? policy.error} />
              {kids.length ? (
                <section className="stack tight" aria-labelledby="vc-kids">
                  <h2 className="sec" id="vc-kids">{t("vc.children")}</h2>
                  <div className="list" data-testid="vc-children">
                    {kids.map((k) => (
                      <ChildVoiceToggle key={k.learner_id} child={k} />
                    ))}
                  </div>
                  <p className="sub small">{t("vc.childrenNote")}</p>
                </section>
              ) : null}
            </>
          )}
        </div>
      </main>
    </>
  );
}

/** A parent's switch for one child profile: «Запись голоса» (the child cannot change it). */
export function ChildVoiceToggle({ child }: { child: LearnerSummary }) {
  const { bff, patchSession } = useApp();
  const { t } = useI18n();
  const set = useAction(async (granted: boolean) => {
    const l = await bff.setChildVoiceConsent(child.learner_id, granted);
    // from the current session, not this render's: two children switched quickly both keep their answer
    patchSession((prev) => ({ learners: prev.learners.map((x) => (x.learner_id === l.learner_id ? { ...x, voice_consent: l.voice_consent } : x)) }));
    showToast(l.voice_consent ? t("vc.childOn", { name: child.display_name }) : t("vc.childOff", { name: child.display_name }));
  });
  return (
    <>
      <ToggleRow
        title={t("vc.childToggle", { name: child.display_name })}
        note={child.voice_consent ? t("vc.childOnNote") : t("vc.childOffNote")}
        checked={child.voice_consent}
        disabled={set.busy}
        onChange={(v) => void set.run(v)}
        testId={`vc-child-${child.learner_id}`}
      />
      {set.error ? <div className="pad"><ErrorLine text={set.error} /></div> : null}
    </>
  );
}
