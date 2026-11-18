import type { InviteAcceptResult, InvitePreview } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { consentRequiredPurpose, errorText } from "../../api/errors";
import { consentIsCurrent } from "../../domain/onboarding";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction } from "../../state/hooks";
import { haptic } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, HERO, Hero, Skeleton } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import { useSocialConsentGate } from "../profile/SocialConsent";

export type InviteTarget = { token: string } | { inviteId: string };

/**
 * Invitation by deep link (AT-09): inv_<token> → POST /v1/invites/open (a repeated open creates no duplicate),
 * invite_<id> → GET /v1/invites/{id}/preview. The card shows who invites (name only); acceptance is two-sided on the
 * server. The server opens an invitation only after the policy is accepted (INTERNAL_API §11: 403 CONSENT_REQUIRED
 * {terms}), so before the consents the link waits for the short setup (onDefer) without being opened; accepting needs
 * the purpose «social» (403 CONSENT_REQUIRED {social} → the consent sheet, then the acceptance is repeated).
 */
export function InviteSheet(props: { target: InviteTarget; onClose: () => void; onAccepted: (r: InviteAcceptResult) => void; onDefer: (target: InviteTarget) => void }) {
  const { bff, session, nav } = useApp();
  const { t, fmt } = useI18n();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [needTerms, setNeedTerms] = useState(false);
  const consentOk = consentIsCurrent(session.consent);
  const ready = session.account.age_band != null && consentOk;
  const target = props.target;
  const gate = useSocialConsentGate();

  useEffect(() => {
    if (!consentOk) return;
    let alive = true;
    const p = "token" in target ? bff.openInvite(target.token) : bff.invitePreview(target.inviteId);
    p.then(
      (v) => alive && setPreview(v),
      (e: unknown) => {
        if (!alive) return;
        if (consentRequiredPurpose(e) === "terms") setNeedTerms(true);
        else setLoadErr(errorText(e, t, fmt.mmss));
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accept = useAction(async () => {
    let r: InviteAcceptResult;
    try {
      r = await bff.acceptInvite(preview!.invite_id);
    } catch (e) {
      if (gate.intercept(e, () => void accept.run())) return;
      throw e;
    }
    haptic.notify("success");
    showToast(t("ivs.accepted"));
    props.onAccepted(r);
  });
  const decline = useAction(async () => {
    setPreview(await bff.declineInvite(preview!.invite_id));
    showToast(t("ivs.declined"));
    props.onClose();
  });

  const title = preview ? t(`ivs.title.${preview.kind}` as MessageKey, { name: preview.inviter_display_name }) : t("ivs.title");
  // before the consents (a new user) the invitation is not opened yet: the setup first, then the link comes back
  const waitSetup = !consentOk || needTerms;
  return (
    <Sheet title={title} cap={t("ivs.cap")} onClose={props.onClose} testId="invite-sheet">
      {waitSetup ? (
        <>
          <div className="card warn"><p className="sub ink">{session.onboarding_completed ? t("ivs.needTerms") : t("ivs.later")}</p></div>
          <Btn
            onClick={() => {
              props.onDefer(target);
              if (session.onboarding_completed) nav.push({ name: "privacy" });
            }}
            data-testid="invite-defer"
          >
            {session.onboarding_completed ? t("ivs.toPrivacy") : t("ivs.continue")}
          </Btn>
        </>
      ) : null}
      {!waitSetup && !preview && !loadErr ? <Skeleton lines={2} /> : null}
      {loadErr ? (
        <>
          <div className="card err"><p className="sub ink">{loadErr}</p></div>
          <Btn variant="secondary" onClick={props.onClose}>{t("c.close")}</Btn>
        </>
      ) : null}
      {preview ? (
        <>
          <div className="hrow">
            <Hero src={preview.kind === "family" ? HERO.myatik : HERO.nilu} alt="" className="inv-hero" />
            <p className="sub ink">{t(`ivs.text.${preview.kind}` as MessageKey)}</p>
          </div>
          {preview.can_accept && !ready ? (
            <>
              <div className="card warn"><p className="sub ink">{t("ivs.later")}</p></div>
              <Btn onClick={() => props.onDefer({ inviteId: preview.invite_id })} data-testid="invite-defer">
                {t("ivs.continue")}
              </Btn>
            </>
          ) : preview.can_accept ? (
            <>
              <ErrorLine text={accept.error ?? decline.error} />
              <div className="duo">
                <Btn variant="secondary" busy={decline.busy} disabled={accept.busy} onClick={() => void decline.run()} data-testid="invite-decline">
                  {t("ivs.decline")}
                </Btn>
                <Btn busy={accept.busy} disabled={decline.busy} onClick={() => void accept.run()} data-testid="invite-accept">
                  <Icon name="check" size={18} />
                  {t("ivs.accept")}
                </Btn>
              </div>
            </>
          ) : (
            <>
              <div className="card warn" data-testid="invite-reason">
                <p className="sub ink">{t(`ivs.reason.${preview.reason ?? preview.status}` as MessageKey)}</p>
              </div>
              <Btn variant="secondary" onClick={props.onClose}>{t("c.close")}</Btn>
            </>
          )}
        </>
      ) : null}
      {gate.sheet}
    </Sheet>
  );
}
