import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LoginStep, Me, MfaEnrollStart } from "@tilhero/contracts/admin";
import { Auth } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { fmtCountdown, useI18n, type MessageKey } from "../../i18n";
import { useUiPrefs } from "../../App";
import { Icon } from "../../ui/Icon";
import { Btn, Callout, CopyBtn, cx } from "../../ui/kit";
import { Otp } from "../../ui/Otp";
import { Qr } from "../../ui/Qr";
import { errText } from "../../ui/errors";
import { ThemeMenu } from "../../shell/ThemeMenu";
import { PasswordFields } from "./PasswordFields";
import { LOGIN_SCOPE, RateScope, useRateWait } from "../../lib/rateLimit";
import { RateWaitNotice } from "../../ui/RateWait";
import { Wordmark } from "../../ui/Wordmark";

export interface LoginNotice {
  kind: "info" | "warn" | "good";
  key: MessageKey;
}

type Step =
  | { s: "creds" }
  | { s: "locked"; until: number }
  | { s: "mfa"; challenge: string }
  | { s: "enroll"; challenge: string; data: MfaEnrollStart | null }
  | { s: "password"; challenge: string };

/** Notebook page behind the card: squared paper and the red margin line of the TilHero notebook theme. */
function LoginArt() {
  return <div className="login-bg" aria-hidden="true" />;
}

/**
 * Staff sign-in: email/password → [new password] → [MFA enrolment]
 * → [TOTP] → session cookie. Every step carries the one-time `challenge` of the previous answer; the
 * password and codes live only in this component's state and are cleared after use.
 */
export function Login({ notice, onDone }: { notice: LoginNotice | null; onDone: (me: Me) => void }) {
  const i = useI18n();
  const loginWait = useRateWait(LOGIN_SCOPE); // 429 of a sign-in step: the code field waits like the buttons
  const { t, lang, setLang } = i;
  const { theme, setTheme } = useUiPrefs();
  const [step, setStep] = useState<Step>({ s: "creds" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [err, setErr] = useState<{ text: string; sub?: string } | null>(null);
  const [info, setInfo] = useState<LoginNotice | null>(notice);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [shake, setShake] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pwdRef = useRef<HTMLInputElement>(null);

  useEffect(() => setInfo(notice), [notice]);
  useEffect(() => {
    if (step.s !== "locked") return;
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= step.until) setStep({ s: "creds" });
    }, 1000);
    return () => clearInterval(id);
  }, [step]);

  const reset = (keepEmail = true) => {
    setStep({ s: "creds" });
    setPassword("");
    setCode("");
    setErr(null);
    setHelpOpen(false);
    if (!keepEmail) setEmail("");
  };

  /** Applies the next sign-in step returned by admin-bff. */
  const advance = async (r: LoginStep) => {
    setErr(null);
    setCode("");
    if (r.next === "done") {
      setPassword("");
      const me = r.me ?? (await Auth.me());
      onDone(me);
      return;
    }
    if (!r.challenge) throw new ApiError(401, { code: "CHALLENGE_INVALID", message: "", trace_id: "", details: {} });
    if (r.next === "mfa") setStep({ s: "mfa", challenge: r.challenge });
    else if (r.next === "password_change") setStep({ s: "password", challenge: r.challenge });
    else if (r.next === "mfa_enroll") {
      setStep({ s: "enroll", challenge: r.challenge, data: null });
      const data = await Auth.enrollStart(r.challenge);
      setStep({ s: "enroll", challenge: r.challenge, data });
    }
  };

  const failStep = (e: unknown) => {
    if (e instanceof ApiError && e.code === "CHALLENGE_INVALID") {
      reset();
      setErr({ text: t("login.err.challenge") });
      return true;
    }
    return false;
  };

  const onLogin = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    setInfo(null);
    if (!email.trim() || !password) {
      setErr({ text: t("login.err.empty") });
      return;
    }
    setBusy(true);
    try {
      const r = await Auth.login(email.trim(), password);
      setPassword("");
      await advance(r);
    } catch (e) {
      setPassword("");
      if (e instanceof ApiError && e.code === "ACCOUNT_LOCKED") {
        setStep({ s: "locked", until: Date.now() + (e.num("retry_after") ?? 900) * 1000 });
        setNow(Date.now());
        setErr(null);
      } else if (e instanceof ApiError && e.code === "INVALID_CREDENTIALS") {
        const left = e.num("remaining");
        setErr({ text: t("login.err.creds"), sub: left != null ? t("login.attempts", { n: left }) : undefined });
        pwdRef.current?.focus();
      } else setErr({ text: errText(i, e) });
    } finally {
      setBusy(false);
    }
  };

  const onMfa = async (c = code) => {
    if (step.s !== "mfa" || busy) return;
    if (!/^\d{6}$/.test(c)) {
      setErr({ text: t("login.err.len") });
      return;
    }
    setBusy(true);
    try {
      await advance(await Auth.mfa(step.challenge, c));
    } catch (e) {
      if (!failStep(e)) {
        const left = e instanceof ApiError ? e.num("remaining") : null;
        setErr({ text: e instanceof ApiError && e.code === "MFA_INVALID" ? t("login.err.code") : errText(i, e), sub: left != null ? t("login.attempts", { n: left }) : undefined });
        setCode("");
        setShake(true);
        setTimeout(() => setShake(false), 320);
      }
    } finally {
      setBusy(false);
    }
  };

  const onEnroll = async (c = code) => {
    if (step.s !== "enroll" || busy) return;
    if (!/^\d{6}$/.test(c)) {
      setErr({ text: t("login.err.len") });
      return;
    }
    setBusy(true);
    try {
      await advance(await Auth.enrollConfirm(step.challenge, c));
    } catch (e) {
      if (!failStep(e)) {
        const left = e instanceof ApiError ? e.num("remaining") : null;
        setErr({ text: e instanceof ApiError && e.code === "MFA_INVALID" ? t("enroll.err") : errText(i, e), sub: left != null ? t("login.attempts", { n: left }) : undefined });
        setCode("");
      }
    } finally {
      setBusy(false);
    }
  };

  const onPassword = async (pw: string) => {
    if (step.s !== "password" || busy) return null;
    setBusy(true);
    try {
      const r = await Auth.passwordStep(step.challenge, pw);
      setInfo({ kind: "good", key: "pwd.changed" });
      await advance(r);
      return null;
    } catch (e) {
      if (failStep(e)) return null;
      if (e instanceof ApiError && e.code === "PASSWORD_WEAK") return t("pwd.err.weak");
      return errText(i, e);
    } finally {
      setBusy(false);
    }
  };

  const errBox = err && (
    <div className="lc-err" role="alert" data-testid="login-error">
      <Icon name="alertCircle" />
      <div>
        <b>{err.text}</b>
        {err.sub && <span>{err.sub}</span>}
      </div>
    </div>
  );

  const who = (note: string) => (
    <div className="lc-who">
      <span className="avatar">{(email.trim()[0] ?? "?").toUpperCase()}</span>
      <div className="grow">
        <div className="b wrap-any">{email.trim()}</div>
        <div className="xs muted">{note}</div>
      </div>
      <Icon name="checkCircle" className="ok-ico" />
    </div>
  );

  let card;
  if (step.s === "locked") {
    card = (
      <div data-testid="login-locked">
        <div className="lc-lock">
          <Icon name="lock" />
        </div>
        <h1 className="lc-h">{t("login.locked.t")}</h1>
        <p className="lc-sub">
          <span className="mono wrap-any">{email.trim()}</span>
        </p>
        <p className="lc-sub">
          {t("login.locked.m")}{" "}
          <b className="mono" data-testid="lock-countdown">
            {fmtCountdown(Math.max(0, step.until - now))}
          </b>
          .
        </p>
        <div className="mt-16">
          <Callout icon="shield">{t("login.locked.note")}</Callout>
        </div>
        <Btn label={t("login.other")} block className="mt-12" onClick={() => reset(false)} />
      </div>
    );
  } else if (step.s === "mfa") {
    card = (
      <div data-testid="login-mfa">
        {who(t("login.pwdOk"))}
        <h1 className="lc-h mt-16">{t("login.mfa.t")}</h1>
        <p className="lc-sub">{t("login.mfa.sub")}</p>
        <form noValidate onSubmit={(e) => { e.preventDefault(); void onMfa(); }}>
          <Otp value={code} onChange={(v) => { setCode(v); setErr(null); }} onComplete={(v) => void onMfa(v)} invalid={!!err} shake={shake} label={t("login.mfa.t")} disabled={busy || loginWait > 0} />
          <div className="mt-12">{errBox}</div>
          <div className="login-meta">
            <button type="button" className="link-btn" aria-expanded={helpOpen} onClick={() => setHelpOpen(!helpOpen)}>
              {t("login.nocode")}
            </button>
          </div>
          {helpOpen && (
            <div className="mt-8">
              <Callout kind="info" icon="smartphoneKey">{t("login.help")}</Callout>
            </div>
          )}
          <Btn type="submit" kind="primary" size="lg" block className="mt-16" busy={busy} label={busy ? t("login.checking") : t("login.confirm")} testId="mfa-submit" />
        </form>
        <Btn kind="ghost" block className="mt-8" label={t("login.other")} onClick={() => reset(false)} />
      </div>
    );
  } else if (step.s === "enroll") {
    const d = step.data;
    card = (
      <div data-testid="login-enroll">
        {who(t("enroll.pwdOk"))}
        <h1 className="lc-h mt-16">{t("enroll.t")}</h1>
        <p className="lc-sub">{t("enroll.sub")}</p>
        {!d ? (
          <div className="row muted small mt-16" role="status">
            <span className="spinner" aria-hidden="true" />
            {t("common.loading")}
          </div>
        ) : (
          <ol className="enr-steps">
            <li>
              <span className="n">1</span>
              <div className="grow">
                <div className="b">{t("enroll.s1")}</div>
                <div className="enr-qr">
                  <Qr data={d.otpauth_uri} label={t("enroll.qr")} />
                  <span className="xs muted">{t("enroll.qrNote")}</span>
                </div>
              </div>
            </li>
            <li>
              <span className="n">2</span>
              <div className="grow">
                <div className="b">{t("enroll.s2")}</div>
                <div className="enr-secret-row">
                  <code className="code-chip enr-secret" data-testid="mfa-secret">
                    {(d.secret.match(/.{1,4}/g) ?? [d.secret]).join(" ")}
                  </code>
                  <CopyBtn value={d.secret} label={t("enroll.secret")} testId="mfa-secret-copy" />
                </div>
                <div className="xs muted mt-8 wrap-any">
                  TOTP · SHA-1 · 6 · 30 s · {d.issuer} ({d.account})
                </div>
              </div>
            </li>
            <li>
              <span className="n">3</span>
              <div className="grow">
                <div className="b">{t("enroll.s3")}</div>
                <form noValidate onSubmit={(e) => { e.preventDefault(); void onEnroll(); }}>
                  <Otp value={code} onChange={(v) => { setCode(v); setErr(null); }} onComplete={(v) => void onEnroll(v)} invalid={!!err} label={t("enroll.s3")} compact idPrefix="enr" disabled={busy} autoFocus={false} />
                  <div className="mt-8">{errBox}</div>
                  <Btn type="submit" kind="primary" block className="mt-12" busy={busy} label={t("login.confirm")} testId="enroll-submit" />
                </form>
              </div>
            </li>
          </ol>
        )}
        <Btn kind="ghost" block className="mt-8" label={t("login.other")} onClick={() => reset(false)} />
      </div>
    );
  } else if (step.s === "password") {
    card = (
      <div data-testid="login-password">
        {who(t("login.tempPwd"))}
        <h1 className="lc-h mt-16">{t("pwd.t")}</h1>
        <p className="lc-sub">{t("pwd.sub")}</p>
        <PasswordFields email={email.trim()} busy={busy} onSubmit={onPassword} submitLabel={t("pwd.save")} />
        <Btn kind="ghost" block className="mt-8" label={t("pwd.cancel")} onClick={() => reset()} />
      </div>
    );
  } else {
    card = (
      <div data-testid="login-creds">
        <div className="lc-head">
          <Wordmark className="on-card" />
          <p className="lc-sub">{t("login.title")}</p>
        </div>
        {info && (
          <div className="mb-12">
            <Callout kind={info.kind} icon={info.kind === "good" ? "checkCircle" : "info"} testId="login-notice">
              {t(info.key)}
            </Callout>
          </div>
        )}
        {errBox && <div className="mb-12">{errBox}</div>}
        <form noValidate className="stack sm" onSubmit={onLogin}>
          <div className="field">
            <label htmlFor="login-email">{t("login.email")}</label>
            <input
              id="login-email"
              className="input lg"
              type="email"
              autoComplete="username"
              spellCheck={false}
              autoCapitalize="off"
              placeholder="name@tilhero.local"
              value={email}
              aria-invalid={!!err || undefined}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-pass">{t("login.password")}</label>
            <div className="pwd-wrap">
              <input
                ref={pwdRef}
                id="login-pass"
                className="input lg"
                type={showPwd ? "text" : "password"}
                autoComplete="current-password"
                spellCheck={false}
                value={password}
                aria-invalid={!!err || undefined}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button type="button" className="pwd-eye" aria-pressed={showPwd} aria-label={showPwd ? t("pwd.hide") : t("pwd.show")} title={showPwd ? t("pwd.hide") : t("pwd.show")} onClick={() => setShowPwd(!showPwd)}>
                <Icon name={showPwd ? "eyeOff" : "eye"} />
              </button>
            </div>
          </div>
          <Btn type="submit" kind="primary" size="lg" block busy={busy} label={busy ? t("login.progress") : t("login.btn")} testId="login-submit" />
        </form>
        <p className="lc-note">{t("login.forgot")}</p>
        <div className="lc-foot">
          <Icon name="shield" />
          <span>{t("login.foot")}</span>
        </div>
      </div>
    );
  }

  return (
    <section className="login" aria-label={t("login.title")}>
      <LoginArt />
      <div className="login-col">
        <RateScope.Provider value={LOGIN_SCOPE}>
          <div className={cx("login-card")}>
            <RateWaitNotice scope={LOGIN_SCOPE} testId="login-rate-wait" />
            {card}
          </div>
        </RateScope.Provider>
        <div className="login-under">
          <div className="seg-mini" role="group" aria-label={t("common.language")}>
            <button type="button" aria-pressed={lang === "ru"} onClick={() => setLang("ru")}>
              RU
            </button>
            <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")}>
              EN
            </button>
          </div>
          <ThemeMenu theme={theme} setTheme={setTheme} />
        </div>
      </div>
    </section>
  );
}
