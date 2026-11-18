import { useState, type ReactNode } from "react";
import { consentRequiredPurpose } from "../../api/errors";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction } from "../../state/hooks";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine } from "../../ui/kit";
import { Sheet } from "../../ui/overlays";

/** The optional policy purpose behind invitations and the family (bff.ts «Согласия»). */
export const SOCIAL = "social";

/**
 * 403 CONSENT_REQUIRED {purpose: "social"} on creating or accepting an invitation (INTERNAL_API §11): a sheet
 * «Разрешить приглашения и семью» explains the purpose; «Разрешить» repeats POST /v1/profile/consent with the purpose
 * added (the current policy version, the required purposes and the optional ones already given stay) and then
 * repeats the action. `intercept(e, again)` → true when the sheet took over the error.
 */
export function useSocialConsentGate(): { intercept: (e: unknown, again: () => void) => boolean; sheet: ReactNode } {
  const [again, setAgain] = useState<(() => void) | null>(null);
  const intercept = (e: unknown, retry: () => void): boolean => {
    if (consentRequiredPurpose(e) !== SOCIAL) return false;
    setAgain(() => retry);
    return true;
  };
  const sheet = again ? (
    <SocialConsentSheet
      onClose={() => setAgain(null)}
      onAllowed={() => {
        const retry = again;
        setAgain(null);
        retry();
      }}
    />
  ) : null;
  return { intercept, sheet };
}

function SocialConsentSheet({ onClose, onAllowed }: { onClose: () => void; onAllowed: () => void }) {
  const { bff, session, patchSession } = useApp();
  const { t, lang } = useI18n();
  const allow = useAction(async () => {
    // purposes are codes of the current policy: required ones + optional already given + social
    const pol = await bff.policy(lang);
    const known = new Set(pol.purposes.map((p) => p.code));
    const purposes = [
      ...new Set([...pol.purposes.filter((p) => p.required).map((p) => p.code), ...session.consent.purposes.filter((p) => known.has(p)), SOCIAL]),
    ];
    patchSession({ consent: await bff.acceptConsent({ policy_version: pol.version, purposes }) });
    onAllowed();
  });
  return (
    <Sheet title={t("sc.title")} onClose={onClose} testId="social-consent">
      <p className="sub ink">{t("sc.text")}</p>
      <ErrorLine text={allow.error} />
      <div className="duo">
        <Btn variant="secondary" onClick={onClose}>
          {t("c.cancel")}
        </Btn>
        <Btn busy={allow.busy} onClick={() => void allow.run()} data-testid="social-allow">
          <Icon name="check" size={18} />
          {t("sc.allow")}
        </Btn>
      </div>
    </Sheet>
  );
}
