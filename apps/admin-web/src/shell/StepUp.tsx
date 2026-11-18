import { useState } from "react";
import { Auth } from "../api/endpoints";
import { ApiError } from "../api/errors";
import { useI18n } from "../i18n";
import { errText } from "../ui/errors";
import { Btn, FieldErr } from "../ui/kit";
import { Otp } from "../ui/Otp";
import { Modal } from "../ui/overlays";

/**
 * Step-up (403 STEP_UP_REQUIRED): a fresh TOTP code for privileged commands, valid 5 minutes on the server.
 * After success the API client repeats the refused request once (same Idempotency-Key).
 */
export function StepUpDialog({ onDone }: { onDone: (ok: boolean) => void }) {
  const i = useI18n();
  const { t } = i;
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const submit = async (c = code) => {
    if (busy) return;
    if (!/^\d{6}$/.test(c)) {
      setErr(t("login.err.len"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await Auth.stepUp(c);
      onDone(true);
    } catch (e) {
      setBusy(false);
      setCode("");
      setShake(true);
      setTimeout(() => setShake(false), 320);
      const left = e instanceof ApiError ? e.num("remaining") : null;
      setErr(e instanceof ApiError && e.code === "MFA_INVALID" ? (left != null ? t("stepup.errLeft", { n: left }) : t("login.err.code")) : errText(i, e));
    }
  };
  return (
    <Modal
      title={t("stepup.title")}
      text={t("stepup.text")}
      icon="smartphoneKey"
      tone="warn"
      onClose={() => !busy && onDone(false)}
      testId="stepup"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={() => onDone(false)} disabled={busy} />
          <Btn label={t("login.confirm")} kind="primary" busy={busy} onClick={() => void submit()} testId="stepup-ok" />
        </>
      }
    >
      <Otp value={code} onChange={(v) => { setCode(v); setErr(null); }} onComplete={(v) => void submit(v)} invalid={!!err} shake={shake} label={t("stepup.title")} compact idPrefix="stepup" disabled={busy} />
      <FieldErr msg={err} />
      <p className="xs muted">{t("stepup.hint")}</p>
    </Modal>
  );
}
