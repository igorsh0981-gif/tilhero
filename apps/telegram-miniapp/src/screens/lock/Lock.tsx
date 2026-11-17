import type { SessionResponse } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useReducer, useState } from "react";
import { ApiError } from "../../api/errors";
import { PIN_POLICY, rateLimits, useRateWait } from "../../api/rateLimit";
import { useI18n } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { initialPinFlow, isWeakPin, pinFull, pinNeed, pinReducer, type PinLength } from "../../state/pin";
import { biometricAuthenticate, biometricInit, haptic } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Keypad, PinDots, Seg, useKeypadKeys, Wordmark } from "../../ui/kit";
import { useCountdown } from "../../ui/overlays";
import { TickingText } from "../../ui/TickingText";

/**
 * Lock screen — the server decides (SessionResponse.security.pin_required / 423 PIN_REQUIRED);
 * nothing else is loaded until the PIN or biometrics are confirmed (FinAdvisor defect S7 avoided).
 * 5 attempts → 5 min block (server), reset by a one-time code from the bot. Biometrics only on tap.
 */
export function Lock({ onUnlocked }: { onUnlocked: (s: SessionResponse, message?: string) => void }) {
  const { api, session } = useApp();
  const { t, fmt } = useI18n();
  const errText = useErrorText();
  const sec = session.security;
  const [s, dispatch] = useReducer(pinReducer, initialPinFlow("unlock", (sec.pin_length ?? 4) as PinLength));
  const [lockedUntil, setLockedUntil] = useState<number | null>(() => {
    const v = sec.locked_until ? Date.parse(sec.locked_until) : NaN;
    return Number.isFinite(v) && v > Date.now() ? v : null;
  });
  const wait = useCountdown(lockedUntil);
  // sprint 9: 429 of the PIN policy — the keypad waits, the text counts down (no automatic repeat)
  const rl = useRateWait([PIN_POLICY]);
  const limited = rl.left > 0;
  const [bioReady, setBioReady] = useState(false);

  useEffect(() => {
    if (!sec.biometric_enabled) return;
    void biometricInit().then((b) => setBioReady(!!b && b.available && b.accessGranted && b.tokenSaved));
  }, [sec.biometric_enabled]);

  const fail = useCallback((msg: string) => {
    haptic.notify("error");
    dispatch({ type: "fail", err: msg });
    setTimeout(() => dispatch({ type: "settle" }), 450);
  }, []);

  const onErr = useCallback(
    (e: unknown) => {
      if (rateLimits.note(e, PIN_POLICY)) {
        dispatch({ type: "neutral" }); // the countdown explains it; the PIN was not wrong
        return;
      }
      if (e instanceof ApiError && e.code === "PIN_LOCKED") {
        setLockedUntil(Date.now() + (e.retryAfter ?? 300) * 1000);
        haptic.notify("error");
        dispatch({ type: "advance", stage: "cur" });
        return;
      }
      if (e instanceof ApiError && (e.code === "RESET_CODE_INVALID" || e.code === "RESET_CODE_EXPIRED")) {
        haptic.notify("error");
        dispatch({ type: "advance", stage: "code", patch: { err: errText(e) } });
        return;
      }
      fail(errText(e));
    },
    [errText, fail],
  );

  const sendCode = async (again: boolean) => {
    dispatch({ type: "info", info: t("pin.rs.sending"), err: null });
    try {
      const r = await api.security.resetRequest();
      dispatch({ type: "advance", stage: "code", patch: { mode: "reset", info: again ? t("pin.rs.resent") : t("pin.rs.sent", { min: Math.max(1, Math.round(r.expires_in / 60)) }) } });
    } catch (e) {
      dispatch({ type: "advance", stage: "code", patch: { mode: "reset", err: errText(e) } });
    }
  };

  useEffect(() => {
    if (!pinFull(s) || s.busy || s.shake) return;
    const entry = s.entry;
    void (async () => {
      if (s.stage === "cur") {
        dispatch({ type: "busy", on: true });
        try {
          onUnlocked(await api.session.verifyPin(entry));
        } catch (e) {
          onErr(e);
        }
      } else if (s.stage === "code") {
        dispatch({ type: "advance", stage: "new", patch: { code: entry } });
      } else if (s.stage === "new") {
        if (isWeakPin(entry)) fail(t("pin.weak"));
        else dispatch({ type: "advance", stage: "rep", patch: { first: entry } });
      } else if (entry !== s.first) {
        haptic.notify("error");
        dispatch({ type: "fail", err: t("pin.set.mis") });
        setTimeout(() => dispatch({ type: "advance", stage: "new", patch: { first: "", err: t("pin.set.mis") } }), 450);
      } else {
        dispatch({ type: "busy", on: true });
        try {
          const sess = await api.security.resetConfirm({ code: s.code, new_pin: entry });
          setLockedUntil(null);
          onUnlocked(sess, t("pin.rs.ok"));
        } catch (e) {
          onErr(e);
        }
      }
    })();
  }, [s, api, fail, onErr, onUnlocked, t]);

  const bio = async () => {
    const r = await biometricAuthenticate(t("pin.bio.reason"));
    if (!r.ok || !r.token) return fail(t("err.BIOMETRIC_INVALID"));
    try {
      onUnlocked(await api.session.verifyBiometric(r.token));
    } catch (e) {
      onErr(e);
    }
  };

  const waiting = s.stage === "cur" && wait > 0;
  useKeypadKeys((d) => dispatch({ type: "digit", d }), () => dispatch({ type: "erase" }), !waiting && !limited);
  const stageCls = s.stage === "cur" ? "pin-pin" : `pin-${s.stage}`;
  const heading = s.stage === "cur" ? t("pin.lock.h") : s.stage === "code" ? t("pin.lock.codeH") : s.stage === "new" ? t("pin.lock.newH") : t("pin.lock.repH");
  let msg: string;
  if (waiting) msg = t("pin.lock.wait", { time: fmt.mmss(wait) });
  else if (limited) msg = t("err.RATE_LIMITED.wait", { n: rl.left });
  else if (s.err) msg = s.err;
  else if (s.info) msg = s.info;
  else msg = s.stage === "code" ? t("pin.rs.code") : s.stage === "new" ? t("pin.set.p1") : " ";

  return (
    <div className={`pin ${stageCls}`} data-testid="lock-screen" data-stage={s.stage}>
      {s.stage === "cur" ? (
        <Wordmark large />
      ) : (
        <span className="pin-badge">
          <Icon name={s.stage === "code" ? "tgp" : "key"} size={26} />
        </span>
      )}
      <h1>{heading}</h1>
      <p className={waiting || limited || s.err ? "bad" : s.info ? "ok" : undefined} aria-live="polite" data-testid="lock-msg">
        {waiting || limited ? (
          <span className="pin-lock">
            <Icon name="clock" size={16} />
            <TickingText ticking text={msg} />
          </span>
        ) : (
          msg
        )}
      </p>
      {s.stage === "new" && (
        <Seg
          className="pin-len"
          value={s.len}
          options={[
            { value: 4 as PinLength, label: t("pin.len4") },
            { value: 6 as PinLength, label: t("pin.len6") },
          ]}
          onChange={(len) => dispatch({ type: "len", len })}
          label={t("pin.len")}
        />
      )}
      <PinDots filled={s.entry.length} total={pinNeed(s)} error={s.shake} />
      <Keypad
        onDigit={(d) => dispatch({ type: "digit", d })}
        onErase={() => dispatch({ type: "erase" })}
        disabled={waiting || limited || s.busy}
        eraseLabel={t("kp.del")}
        bio={s.stage === "cur" && bioReady ? { label: t("pin.lock.bio"), onClick: () => void bio() } : null}
      />
      {s.stage === "cur" ? (
        <button className="pin-forgot" type="button" onClick={() => void sendCode(false)}>
          {t("pin.lock.forgot")}
        </button>
      ) : (
        <div className="pin-links">
          {s.stage === "code" && (
            <button className="pin-forgot" type="button" onClick={() => void sendCode(true)}>
              {t("pin.rs.again")}
            </button>
          )}
          <button className="pin-forgot muted" type="button" onClick={() => dispatch({ type: "advance", stage: "cur", patch: { mode: "unlock" } })}>
            {t("pin.lock.remember")}
          </button>
        </div>
      )}
    </div>
  );
}
