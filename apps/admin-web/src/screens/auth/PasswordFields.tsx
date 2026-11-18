import { useState, type FormEvent } from "react";
import { useI18n } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { Btn, cx } from "../../ui/kit";

/** Server rules (admin-identity): ≥ 12 chars, letters and digits, ≠ email, ≠ the previous password. */
export function passwordRules(p: string, email: string) {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return [
    { id: "len" as const, ok: p.length >= 12 },
    { id: "mix" as const, ok: /\p{L}/u.test(p) && /\d/.test(p) },
    { id: "email" as const, ok: !!p && p.toLowerCase() !== email.toLowerCase() && !(local.length >= 3 && p.toLowerCase().includes(local)) },
  ];
}

/** 0..4 strength score for the meter (length, letters+digits, mixed case, symbols/length ≥ 16). */
export function passwordScore(p: string): number {
  if (!p) return 0;
  let s = 0;
  if (p.length >= 12) s++;
  if (/\p{L}/u.test(p) && /\d/.test(p)) s++;
  if (/\p{Ll}/u.test(p) && /\p{Lu}/u.test(p)) s++;
  if (/[^\p{L}\d]/u.test(p) || p.length >= 16) s++;
  return p.length < 8 ? Math.min(s, 1) : s;
}

export function PasswordMeter({ value, email }: { value: string; email: string }) {
  const { t } = useI18n();
  const sc = passwordScore(value);
  const lvl = !value ? "none" : sc <= 1 ? "bad" : sc === 2 ? "warn" : "good";
  const label = value ? t(`pwd.score.${sc}` as "pwd.score.0") : t("pwd.score.empty");
  return (
    <>
      <div className="pwd-meter" data-lvl={lvl} data-testid="pwd-meter">
        <span className="segs" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <i key={i} className={i < sc ? "on" : ""} />
          ))}
        </span>
        <span className="pm-l" aria-live="polite">
          {label}
        </span>
      </div>
      <ul className="pwd-rules">
        {passwordRules(value, email).map((r) => (
          <li key={r.id} className={r.ok ? "ok" : ""}>
            <Icon name={r.ok ? "checkCircle" : "info"} />
            <span>{t(`pwd.rule.${r.id}`)}</span>
          </li>
        ))}
        <li>
          <Icon name="info" />
          <span>{t("pwd.rule.prev")}</span>
        </li>
      </ul>
    </>
  );
}

export function PasswordFields({ email, busy, onSubmit, submitLabel, withCurrent }: { email: string; busy: boolean; onSubmit: (pw: string, current: string) => Promise<string | null>; submitLabel: string; withCurrent?: boolean }) {
  const { t } = useI18n();
  const [cur, setCur] = useState("");
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (withCurrent && !cur) return setErr(t("pwd.err.current"));
    if (!passwordRules(p1, email).every((r) => r.ok)) return setErr(t("pwd.err.rules"));
    if (p1 !== p2) return setErr(t("pwd.err.mismatch"));
    setErr(null);
    const res = await onSubmit(p1, cur);
    if (res) setErr(res);
    else {
      setCur("");
      setP1("");
      setP2("");
    }
  };
  const field = (id: string, label: string, value: string, set: (v: string) => void, ac: string, invalid: boolean, autoFocus?: boolean) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="pwd-wrap">
        <input id={id} className={cx("input lg")} type={show ? "text" : "password"} autoComplete={ac} spellCheck={false} value={value} aria-invalid={invalid || undefined} onChange={(e) => set(e.target.value)} autoFocus={autoFocus} />
        <button type="button" className="pwd-eye" aria-pressed={show} aria-label={show ? t("pwd.hide") : t("pwd.show")} title={show ? t("pwd.hide") : t("pwd.show")} onClick={() => setShow(!show)}>
          <Icon name={show ? "eyeOff" : "eye"} />
        </button>
      </div>
    </div>
  );
  return (
    <form noValidate className="stack sm mt-16" onSubmit={submit} data-testid="pwd-form">
      {withCurrent && field("pwd-cur", t("pwd.current"), cur, setCur, "current-password", err === t("pwd.err.current"), true)}
      {field("pwd-new", t("pwd.new"), p1, setP1, "new-password", !!err && err !== t("pwd.err.mismatch") && err !== t("pwd.err.current"), !withCurrent)}
      <PasswordMeter value={p1} email={email} />
      {field("pwd-rep", t("pwd.repeat"), p2, setP2, "new-password", err === t("pwd.err.mismatch"))}
      {err && (
        <div className="lc-err" role="alert" data-testid="pwd-error">
          <Icon name="alertCircle" />
          <div>
            <b>{err}</b>
          </div>
        </div>
      )}
      <Btn type="submit" kind="primary" size="lg" block busy={busy} label={busy ? t("common.saving") : submitLabel} testId="pwd-submit" />
    </form>
  );
}
