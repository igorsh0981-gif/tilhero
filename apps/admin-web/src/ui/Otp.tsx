import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { cx } from "./kit";

/**
 * Six one-digit cells for a TOTP code. Typing moves forward, Backspace moves back, a pasted code (or the
 * one-time-code autofill into the first cell) is spread over the cells. `onComplete` fires at 6 digits.
 */
export function Otp({ value, onChange, onComplete, invalid, shake, label, compact, idPrefix = "otp", disabled, autoFocus = true }: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  invalid?: boolean;
  shake?: boolean;
  label: string;
  compact?: boolean;
  idPrefix?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  // focus moves are applied after React re-renders the new value: moving focus synchronously would run the
  // «no holes» onFocus guard against the previous value and bounce the caret back (digits got lost)
  const pending = useRef<number | null>(null);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? "");
  useEffect(() => {
    if (pending.current == null) return;
    refs.current[pending.current]?.focus();
    pending.current = null;
  }, [value]);
  useEffect(() => {
    if (autoFocus) refs.current[Math.min(value.length, 5)]?.focus();
    // focus only on mount and after a reset
  }, [autoFocus, value === ""]);
  const setFrom = (start: number, raw: string) => {
    const add = raw.replace(/\D/g, "");
    if (!add) return;
    const v = add.length === 1 && start < value.length ? value.slice(0, start) + add + value.slice(start + 1) : (value.slice(0, start) + add).slice(0, 6);
    pending.current = Math.min(5, start + add.length);
    onChange(v);
    if (v.length === 6) onComplete?.(v);
  };
  return (
    <div className={cx("otp", compact && "compact", invalid && "is-invalid", shake && "shake")} role="group" aria-label={label}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={`${idPrefix}-${i}`}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={i === 0 ? 6 : 1}
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={t("otp.digit", { n: i + 1 })}
          aria-invalid={invalid || undefined}
          value={d}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value;
            if (!raw) {
              onChange(digits.slice(0, i).join(""));
              return;
            }
            setFrom(i, raw);
          }}
          onPaste={(e) => {
            e.preventDefault();
            setFrom(i, e.clipboardData.getData("text"));
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !d && i > 0) {
              e.preventDefault();
              pending.current = i - 1;
              onChange(digits.slice(0, i - 1).join(""));
            } else if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
            else if (e.key === "ArrowRight" && i < 5) refs.current[i + 1]?.focus();
          }}
          onFocus={(e) => {
            // never leave a hole: focus the first empty cell
            if (i > value.length) refs.current[value.length]?.focus();
            else e.target.select();
          }}
        />
      ))}
    </div>
  );
}
