import type { PinResetRequestResponse } from "@tilhero/contracts/bff";
import { useState } from "react";
import { ApiError, errorText } from "../../api/errors";
import { useI18n } from "../../i18n";
import { useAction } from "../../state/hooks";
import { Btn, ErrorLine, Field, Seg, TextInput } from "../../ui/kit";
import { PinPad } from "./PinPad";

/**
 * A new parent code: the length (4 or 6 digits), the code and its repetition. `save` gets the confirmed code; when it
 * rejects, the error is shown and the entry starts again (nothing is kept between attempts).
 */
export function PinSetup({ save, testId = "pin-setup" }: { save: (pin: string) => Promise<void>; testId?: string }) {
  const { t, fmt } = useI18n();
  const [len, setLen] = useState<4 | 6>(4);
  const [first, setFirst] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="stack" data-testid={testId}>
      {!first ? (
        <Seg
          label={t("pc.len")}
          value={len}
          testId="pin-length"
          options={[
            { value: 4 as const, label: t("pc.len.4") },
            { value: 6 as const, label: t("pc.len.6") },
          ]}
          onChange={(v) => {
            setLen(v);
            setNote(null);
          }}
        />
      ) : null}
      <p className="h3 center" data-testid="pin-step">{first ? t("pc.repeat") : t("pc.new")}</p>
      <PinPad
        key={`${first ? "repeat" : "new"}-${len}`}
        length={len}
        note={note}
        submit={async (pin) => {
          if (!first) {
            setFirst(pin);
            setNote(null);
            return;
          }
          if (pin !== first) {
            setFirst(null);
            setNote(t("pc.mismatch"));
            return;
          }
          try {
            await save(pin);
          } catch (e) {
            setFirst(null);
            setNote(errorText(e, t, fmt.mmss));
          }
        }}
      />
    </div>
  );
}

/**
 * Reset of a forgotten parent code (bff.ts «Код родителя (PIN)»): the bot sends a 6-digit code to the chat → the code
 * here → a new parent code → a new session (the previous ones are revoked). Works in a session that still waits for the
 * code (the lock screen). `confirm` performs reset-confirm and accepts the new session.
 */
export function PinReset(props: {
  request: () => Promise<PinResetRequestResponse>;
  confirm: (code: string, newPin: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t, fmt } = useI18n();
  const [sent, setSent] = useState<PinResetRequestResponse | null>(null);
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"code" | "new">("code");
  const [codeError, setCodeError] = useState<string | null>(null);
  const send = useAction(async () => {
    setSent(await props.request());
    setCode("");
    setStep("code");
    setCodeError(null);
  });
  if (!sent) {
    return (
      <div className="stack" data-testid="pin-reset">
        <p className="sub">{t("pc.reset.text")}</p>
        <ErrorLine text={send.error} />
        <Btn busy={send.busy} onClick={() => void send.run()} data-testid="pin-reset-send">
          {t("pc.reset.send")}
        </Btn>
        {props.onCancel ? (
          <Btn variant="link" onClick={props.onCancel}>
            {t("c.cancel")}
          </Btn>
        ) : null}
      </div>
    );
  }
  if (step === "code") {
    const ok = /^\d{6}$/.test(code);
    return (
      <div className="stack" data-testid="pin-reset">
        <p className="sub ink">{t("pc.reset.sent", { n: Math.max(1, Math.round(sent.expires_in / 60)) })}</p>
        <Field label={t("pc.reset.code")} error={codeError}>
          {(id, d) => (
            <TextInput
              id={id}
              aria-describedby={d}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              invalid={!!codeError}
              onChange={(e) => {
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                setCodeError(null);
              }}
              data-testid="pin-reset-code"
            />
          )}
        </Field>
        <Btn disabled={!ok} onClick={() => setStep("new")} data-testid="pin-reset-next">
          {t("pc.reset.next")}
        </Btn>
        <ErrorLine text={send.error} />
        <Btn variant="link" busy={send.busy} onClick={() => void send.run()}>
          {t("pc.reset.again")}
        </Btn>
      </div>
    );
  }
  return (
    <PinSetup
      testId="pin-reset-new"
      save={async (pin) => {
        try {
          await props.confirm(code, pin);
        } catch (e) {
          // a wrong or expired code from the bot: back to the code, the new parent code is entered again after it
          if (e instanceof ApiError && (e.code === "RESET_CODE_INVALID" || e.code === "RESET_CODE_EXPIRED")) {
            setCodeError(errorText(e, t, fmt.mmss));
            setStep("code");
            return;
          }
          throw e;
        }
      }}
    />
  );
}
