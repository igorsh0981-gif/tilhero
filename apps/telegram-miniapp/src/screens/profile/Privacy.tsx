import { useState } from "react";
import { ApiError } from "../../api/errors";
import { consentIsCurrent, optionalAllowed } from "../../domain/onboarding";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction, useLoad } from "../../state/hooks";
import { Btn, ErrorLine, Pill, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { PolicySheet } from "../onboarding/Onboarding";

/**
 * Profile → «Данные и согласия» (AT-02, AT-14): accepted version and date of the consents; optional purposes can be
 * switched on or withdrawn at any time (the server records version, date and basis); deletion of the account.
 */
export function Privacy() {
  const { bff, session, nav, patchSession } = useApp();
  const { t, lang, fmt } = useI18n();
  const policy = useLoad(() => bff.policy(lang), [lang]);
  const [doc, setDoc] = useState(false);
  const c = session.consent;
  const current = consentIsCurrent(c);
  const optionalOk = optionalAllowed(session.account.age_band, session.account.guardian_consent);

  const update = useAction(async (purposes: string[]) => {
    const pol = policy.data!;
    try {
      patchSession({ consent: await bff.acceptConsent({ policy_version: pol.version, purposes }) });
    } catch (e) {
      if (e instanceof ApiError && e.code === "POLICY_VERSION_OUTDATED") void policy.reload();
      throw e;
    }
    showToast(t("priv.saved"));
  });
  const purposes = policy.data?.purposes ?? [];
  const requiredCodes = purposes.filter((p) => p.required).map((p) => p.code);
  const toggle = (code: string, on: boolean) => {
    const set = new Set(c.purposes.filter((p) => purposes.some((x) => x.code === p)));
    for (const r of requiredCodes) set.add(r);
    if (on) set.add(code);
    else set.delete(code);
    void update.run([...set]);
  };

  return (
    <>
      <Bar title={t("priv.title")} onBack={nav.back} />
      <main className="scroll" data-testid="privacy">
        <div className="pad stack">
          {!current && policy.data ? (
            <div className="card warn stack tight">
              <p className="sub ink">{t("priv.outdated", { v: policy.data.version })}</p>
              <Btn busy={update.busy} onClick={() => void update.run([...new Set([...requiredCodes, ...c.purposes.filter((p) => purposes.some((x) => x.code === p && !x.required))])])}>
                {t("priv.acceptNew")}
              </Btn>
            </div>
          ) : null}
          <p className="sec">{t("priv.consents")}</p>
          {policy.loading && !policy.data ? <Skeleton lines={2} /> : null}
          {policy.data ? (
            <div className="list">
              {purposes.map((p) =>
                p.required ? (
                  <div key={p.code} className="row">
                    <span className="t">
                      <b>{p.title}</b>
                      <span>{c.accepted_at ? t("priv.acceptedAt", { v: c.policy_version ?? "", date: fmt.date(c.accepted_at) }) : t("priv.notAccepted")}</span>
                    </span>
                    <Pill tone="mute">{t("priv.required")}</Pill>
                  </div>
                ) : (
                  <label key={p.code} className="row">
                    <span className="t">
                      <b>{p.title}</b>
                      <span>{optionalOk ? p.description : t("ob.consent.teenLocked")}</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={c.purposes.includes(p.code)}
                      disabled={!optionalOk || update.busy || !current}
                      onChange={(e) => toggle(p.code, e.target.checked)}
                      data-testid={`priv-${p.code}`}
                    />
                  </label>
                ),
              )}
            </div>
          ) : null}
          {c.evidence_hash ? <p className="sub small">{t("priv.evidence", { h: c.evidence_hash.slice(0, 12) })}</p> : null}
          <ErrorLine text={update.error ?? policy.error} />
          {policy.data ? (
            <Btn variant="link" onClick={() => setDoc(true)}>
              {t("ob.consent.read")}
            </Btn>
          ) : null}
          <p className="sec">{t("priv.data")}</p>
          <Btn variant="dangerOutline" onClick={() => nav.push({ name: "delete" })} data-testid="to-delete">
            {t("priv.delete")}
          </Btn>
        </div>
      </main>
      {doc && policy.data ? <PolicySheet doc={policy.data} onClose={() => setDoc(false)} /> : null}
    </>
  );
}
