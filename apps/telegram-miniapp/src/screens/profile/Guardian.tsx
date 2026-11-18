import type { GuardianConsentLink } from "@tilhero/contracts/bff";
import { useState } from "react";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction } from "../../state/hooks";
import { shareToTelegram } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, ErrorLine, Pill } from "../../ui/kit";
import { Bar } from "../../ui/shell";
import { CopyLink } from "../onboarding/Onboarding";

/** Profile → «Согласие родителя» (14–17, AT-03): status and a link for the parent (a new link revokes the old one). */
export function Guardian() {
  const { bff, session, nav, syncProfile } = useApp();
  const { t, fmt } = useI18n();
  const [link, setLink] = useState<GuardianConsentLink | null>(null);
  const status = session.account.guardian_consent;
  const send = useAction(async () => {
    try {
      const l = await bff.requestGuardianConsent();
      setLink(l);
      shareToTelegram(l.link, t("ob.teen.shareText"));
    } catch (e) {
      if (e instanceof ApiError && e.code === "GUARDIAN_CONSENT_NOT_REQUIRED") {
        syncProfile(await bff.profile());
        return;
      }
      throw e;
    }
  });
  const refresh = useAction(async () => syncProfile(await bff.profile()));
  return (
    <>
      <Bar title={t("profile.guardian")} onBack={nav.back} />
      <main className="scroll" data-testid="guardian">
        <div className="pad stack">
          <div className={status === "granted" ? "card ok" : status === "declined" ? "card err" : "card warn"}>
            <div className="hrow between">
              <b className="h3">{t("gcs.status")}</b>
              <Pill tone={status === "granted" ? "ok" : status === "declined" ? "err" : "warn"}>{t(`gc.${status}` as MessageKey)}</Pill>
            </div>
            <p className="sub ink mt8">{t(`gcs.${status}` as MessageKey)}</p>
          </div>
          {status !== "granted" && status !== "not_required" ? (
            <>
              <Btn busy={send.busy} onClick={() => void send.run()} data-testid="gc-send">
                <Icon name="share" size={18} />
                {link ? t("gcs.resend") : t("ob.teen.send")}
              </Btn>
              <p className="sub small">{t("gcs.note")}</p>
              {link ? (
                <div className="card stack tight">
                  <p className="sub ink">{t("ob.teen.sent", { date: fmt.date(link.expires_at) })}</p>
                  <CopyLink link={link.link} />
                </div>
              ) : null}
              <Btn variant="link" busy={refresh.busy} onClick={() => void refresh.run()}>{t("gcs.check")}</Btn>
            </>
          ) : null}
          <ErrorLine text={send.error ?? refresh.error} />
        </div>
      </main>
    </>
  );
}
