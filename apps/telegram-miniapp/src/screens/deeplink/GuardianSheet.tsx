import type { GuardianConsentPreview } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { ApiError, consentRequiredPurpose, errorText } from "../../api/errors";
import { consentIsCurrent } from "../../domain/onboarding";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { Btn, Check, ErrorLine, Skeleton } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import { PolicySheet } from "../onboarding/Onboarding";

/**
 * A parent opens gc_<token> (AT-03): the teen's name, what the consent switches on, «Даю согласие» / «Не согласен».
 * Only an adult decides (403 ADULT_REQUIRED): a parent without a stated age confirms 18+ here first. The decision is
 * recorded as the teen's consent on the guardian basis, so the parent's own consent comes first (INTERNAL_API §11:
 * 403 CONSENT_REQUIRED {purpose: "terms"}): the required purposes of the policy are accepted here, then the decision.
 */
export function GuardianSheet({ token, onClose }: { token: string; onClose: () => void }) {
  const { bff, session, syncProfile, patchSession } = useApp();
  const { t, fmt, lang } = useI18n();
  const [preview, setPreview] = useState<GuardianConsentPreview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [adult, setAdult] = useState(false);
  const [needConsent, setNeedConsent] = useState(() => !consentIsCurrent(session.consent));
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [doc, setDoc] = useState(false);
  const policy = useLoad(() => (needConsent ? bff.policy(lang) : Promise.resolve(null)), [needConsent, lang]);
  const required = policy.data?.purposes.filter((p) => p.required) ?? [];
  const consentReady = !needConsent || (required.length > 0 && required.every((p) => checked[p.code]));
  const noAge = session.account.age_band == null;
  const teenSelf = session.account.age_band === "14-17";

  useEffect(() => {
    let alive = true;
    bff.guardianPreview(token).then(
      (p) => alive && setPreview(p),
      (e: unknown) => alive && setLoadErr(errorText(e, t, fmt.mmss)),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const decide = useAction(async (d: "accept" | "decline") => {
    if (noAge) {
      try {
        syncProfile(await bff.setAge({ age_band: "18+" }));
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "AGE_ALREADY_SET")) throw e;
        syncProfile(await bff.profile());
      }
    }
    let accepted = false;
    if (needConsent) {
      const pol = policy.data!;
      const known = new Set(pol.purposes.map((x) => x.code));
      const purposes = [...new Set([...required.map((x) => x.code), ...session.consent.purposes.filter((x) => known.has(x))])];
      patchSession({ consent: await bff.acceptConsent({ policy_version: pol.version, purposes }) });
      setNeedConsent(false);
      accepted = true;
    }
    let p: GuardianConsentPreview;
    try {
      p = await bff.guardianDecide(token, d);
    } catch (e) {
      // the server still needs the parent's consent: show the policy (once; a repeated refusal is an error)
      if (!accepted && consentRequiredPurpose(e) === "terms") {
        setNeedConsent(true);
        return;
      }
      throw e;
    }
    setPreview(p);
    showToast(d === "accept" ? t("gcd.granted") : t("gcd.declined"));
  });
  const blocked = (noAge && !adult) || !consentReady || (needConsent && !policy.data);

  return (
    <Sheet title={t("gcd.title")} onClose={onClose} testId="guardian-sheet">
      {!preview && !loadErr ? <Skeleton lines={2} /> : null}
      {loadErr ? <div className="card err"><p className="sub ink">{loadErr}</p></div> : null}
      {preview ? (
        preview.status === "pending" ? (
          <>
            <p className="sub ink">{t("gcd.text", { name: preview.teen_display_name })}</p>
            <div className="card"><p className="sub">{t("gcd.rules")}</p></div>
            <p className="sub small">{t("gcd.until", { date: fmt.date(preview.expires_at) })}</p>
            {teenSelf ? (
              <div className="card warn"><p className="sub ink">{t("err.ADULT_REQUIRED")}</p></div>
            ) : (
              <>
                {noAge ? (
                  <Check checked={adult} onChange={setAdult} testId="gc-adult">
                    {t("ob.child.adult")}
                  </Check>
                ) : null}
                {needConsent ? (
                  <div className="card stack tight" data-testid="gc-consent">
                    <p className="sub ink">{t("gcd.consentFirst")}</p>
                    {policy.data ? (
                      <>
                        {required.map((p) => (
                          <Check key={p.code} checked={!!checked[p.code]} onChange={(v) => setChecked((c) => ({ ...c, [p.code]: v }))} testId={`gc-consent-${p.code}`}>
                            {p.title} <span className="small">({t("ob.consent.version", { v: policy.data!.version })})</span>
                          </Check>
                        ))}
                        <Btn variant="link" onClick={() => setDoc(true)}>
                          {t("ob.consent.read")}
                        </Btn>
                      </>
                    ) : policy.error ? null : (
                      <Skeleton lines={1} />
                    )}
                    <ErrorLine text={policy.error} />
                  </div>
                ) : null}
                <ErrorLine text={decide.error} />
                <div className="duo">
                  <Btn variant="secondary" busy={decide.busy} disabled={blocked} onClick={() => void decide.run("decline")} data-testid="gc-decline">
                    {t("gcd.decline")}
                  </Btn>
                  <Btn busy={decide.busy} disabled={blocked} onClick={() => void decide.run("accept")} data-testid="gc-accept">
                    {t("gcd.accept")}
                  </Btn>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className={preview.status === "granted" ? "card ok" : "card warn"} data-testid="gc-status">
              <p className="sub ink">{t(`gcd.status.${preview.status}` as MessageKey, { name: preview.teen_display_name })}</p>
            </div>
            <Btn variant="secondary" onClick={onClose}>{t("c.close")}</Btn>
          </>
        )
      ) : null}
      {loadErr ? <Btn variant="secondary" onClick={onClose}>{t("c.close")}</Btn> : null}
      {doc && policy.data ? <PolicySheet doc={policy.data} onClose={() => setDoc(false)} /> : null}
    </Sheet>
  );
}
