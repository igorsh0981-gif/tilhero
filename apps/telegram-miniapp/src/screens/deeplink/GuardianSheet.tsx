import type { GuardianConsentPreview } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { ApiError, errorText } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction } from "../../state/hooks";
import { Btn, Check, ErrorLine, Skeleton } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";

/**
 * A parent opens gc_<token> (AT-03): the teen's name, what the consent switches on, «Даю согласие» / «Не согласен».
 * Only an adult decides (403 ADULT_REQUIRED): a parent without a stated age confirms 18+ here first.
 */
export function GuardianSheet({ token, onClose }: { token: string; onClose: () => void }) {
  const { bff, session, syncProfile } = useApp();
  const { t, fmt } = useI18n();
  const [preview, setPreview] = useState<GuardianConsentPreview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [adult, setAdult] = useState(false);
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
    const p = await bff.guardianDecide(token, d);
    setPreview(p);
    showToast(d === "accept" ? t("gcd.granted") : t("gcd.declined"));
  });

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
                <ErrorLine text={decide.error} />
                <div className="duo">
                  <Btn variant="secondary" busy={decide.busy} disabled={noAge && !adult} onClick={() => void decide.run("decline")} data-testid="gc-decline">
                    {t("gcd.decline")}
                  </Btn>
                  <Btn busy={decide.busy} disabled={noAge && !adult} onClick={() => void decide.run("accept")} data-testid="gc-accept">
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
    </Sheet>
  );
}
