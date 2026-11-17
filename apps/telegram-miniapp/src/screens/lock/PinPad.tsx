import { useEffect, useState } from "react";
import { ApiError, errorText } from "../../api/errors";
import { useI18n } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { cx } from "../../ui/kit";

/**
 * Parent code entry (4 or 6 digits) with an on-screen keypad and a hidden numeric field for hardware keyboards and
 * screen readers. `submit` gets the full code; a rejected promise shows the error (PIN_INVALID {remaining},
 * PIN_LOCKED {retry_after}) and clears the dots.
 */
export function PinPad({ length, submit }: { length: number; submit: (pin: string) => Promise<void> }) {
  const { t, fmt } = useI18n();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [lockedFor, setLockedFor] = useState(0);

  useEffect(() => {
    if (lockedFor <= 0) return;
    const id = setTimeout(() => setLockedFor((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [lockedFor]);

  useEffect(() => {
    if (pin.length !== length || busy) return;
    setBusy(true);
    submit(pin)
      .catch((e: unknown) => {
        setError(errorText(e, t, fmt.mmss));
        if (e instanceof ApiError && e.code === "PIN_LOCKED") setLockedFor(Math.ceil(e.retryAfter ?? 300));
        setShake(true);
        setTimeout(() => setShake(false), 450);
      })
      .finally(() => {
        setBusy(false);
        setPin("");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  const disabled = busy || lockedFor > 0;
  const press = (d: string) => {
    if (disabled) return;
    setError(null);
    setPin((p) => (p.length < length ? p + d : p));
  };
  return (
    <div className="stack">
      <label className="sr" htmlFor="pin-field">{t("pin.field")}</label>
      <input
        id="pin-field"
        className="sr"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={length}
        value={pin}
        disabled={disabled}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, length))}
        data-testid="pin-field"
      />
      <div className={cx("pdots", shake && "shake")} aria-hidden="true">
        {Array.from({ length }, (_, i) => (
          <i key={i} className={i < pin.length ? "on" : ""} />
        ))}
      </div>
      <p className="sub center" aria-live="polite">
        {lockedFor > 0 ? t("err.PIN_LOCKED", { time: fmt.mmss(lockedFor) }) : error ?? t("pin.digits", { n: length })}
      </p>
      <div className="kp">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" onClick={() => press(d)} disabled={disabled}>
            {d}
          </button>
        ))}
        <span />
        <button type="button" onClick={() => press("0")} disabled={disabled}>
          0
        </button>
        <button type="button" aria-label={t("pin.erase")} onClick={() => setPin((p) => p.slice(0, -1))} disabled={disabled || !pin}>
          <Icon name="back" size={22} />
        </button>
      </div>
    </div>
  );
}
