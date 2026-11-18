import type { PinResetRequestResponse, SecurityState } from "@tilhero/contracts/bff";
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

/** Whole hours left until `iso` (at least 1): «через 24 часа» right after the reset. */
export function hoursUntil(iso: string, now: number = Date.now()): number {
  const ms = Date.parse(iso) - now;
  return Number.isFinite(ms) ? Math.max(1, Math.round(ms / 3_600_000)) : 24;
}

/**
 * After the reset is confirmed (review T-8): the new code takes effect only in 24 hours — the phone with Telegram may
 * be in a child's hands. Until then the old code works, and entering it cancels the reset.
 */
export function PinResetWaiting({ effectiveAt, onOk }: { effectiveAt: string | null; onOk: () => void }) {
  const { t, tp, fmt } = useI18n();
  const n = effectiveAt ? hoursUntil(effectiveAt) : 24;
  return (
    <div className="stack" data-testid="pin-reset-wait">
      <h2 className="h2" data-testid="pin-reset-wait-title">{t("pc.reset.waitTitle", { n, h: tp("pc.reset.hours", n) })}</h2>
      {effectiveAt ? (
        <p className="sub ink" data-testid="pin-reset-wait-when">{t("pc.reset.waitWhen", { when: fmt.dateTime(effectiveAt) })}</p>
      ) : null}
      <p className="sub">{t("pc.reset.waitText")}</p>
      <Btn onClick={onOk} data-testid="pin-reset-wait-ok">
        {t("pc.reset.waitOk")}
      </Btn>
    </div>
  );
}

/**
 * «Сброс кода запрошен, вступит в силу …» (review T-8): in the adult profile and on «Код родителя» with «Отменить
 * сброс» (the old code); on the lock screen — a hint that the old code cancels the reset.
 */
export function PinResetPending({ at, onCancel }: { at: string; onCancel?: () => void }) {
  const { t, fmt } = useI18n();
  return (
    <div className="card warn stack tight" role="status" data-testid="pin-reset-pending">
      <b className="h3">{t("pc.pending.title")}</b>
      <p className="sub ink" data-testid="pin-reset-pending-when">{t("pc.pending.text", { when: fmt.dateTime(at) })}</p>
      {onCancel ? (
        <Btn variant="secondary" onClick={onCancel} data-testid="pin-reset-cancel">
          {t("pc.pending.cancel")}
        </Btn>
      ) : (
        <p className="sub small">{t("pc.pending.lock")}</p>
      )}
    </div>
  );
}

/**
 * Reset of a forgotten parent code (bff.ts «Код родителя (PIN)»): the bot sends a 6-digit code to the chat → the code
 * here → a new parent code → «Новый код заработает через 24 часа» (review T-8: the reset waits, the session does not
 * change). Works in a session that still waits for the code (the lock screen). `confirm` performs reset-confirm and
 * stores the returned SecurityState; `onDone` — the user has read the waiting screen.
 */
export function PinReset(props: {
  request: () => Promise<PinResetRequestResponse>;
  confirm: (code: string, newPin: string) => Promise<SecurityState>;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { t, fmt } = useI18n();
  const [sent, setSent] = useState<PinResetRequestResponse | null>(null);
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"code" | "new">("code");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<SecurityState | null>(null);
  const send = useAction(async () => {
    setSent(await props.request());
    setCode("");
    setStep("code");
    setCodeError(null);
  });
  if (scheduled) return <PinResetWaiting effectiveAt={scheduled.pin_reset_effective_at} onOk={props.onDone} />;
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
          setScheduled(await props.confirm(code, pin));
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
