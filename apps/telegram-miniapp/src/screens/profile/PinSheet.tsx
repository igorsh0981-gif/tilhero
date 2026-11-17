import type { SecurityState } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useReducer, useState } from "react";
import { ApiError } from "../../api/errors";
import { PIN_POLICY, rateLimits, useRateWait } from "../../api/rateLimit";
import { useI18n } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { initialPinFlow, isWeakPin, pinFull, pinNeed, pinReducer, type PinLength } from "../../state/pin";
import { haptic } from "../../tg";
import { Keypad, PinDots, Seg, useKeypadKeys } from "../../ui/kit";
import { Sheet, showToast, useCountdown } from "../../ui/overlays";
import { TickingText } from "../../ui/TickingText";

export type PinSheetMode = "set" | "change" | "off" | "reset";

/**
 * One sheet for set / change (current PIN first) / turn off / reset by a one-time code
 * from the TilHero bot (decision 07.10.2026; FinAdvisor flow without its defects:
 * every change needs the current PIN or the bot code, attempts are limited server-side).
 */
export function PinSheet({ mode, onClose, onDone }: { mode: PinSheetMode; onClose: () => void; onDone?: (s: SecurityState, mode: PinSheetMode) => void }) {
  const { api, session, setSecurity, applySession } = useApp();
  const { t, fmt } = useI18n();
  const errText = useErrorText();
  const curLen = (session.security.pin_length ?? 4) as PinLength;
  const [s, dispatch] = useReducer(pinReducer, initialPinFlow(mode, curLen));
  const [lockedUntil, setLockedUntil] = useState<number | null>(() => (session.security.locked_until ? Date.parse(session.security.locked_until) : null));
  const wait = useCountdown(lockedUntil);
  // sprint 9: 429 of the PIN policy — the keypad waits with a countdown
  const rl = useRateWait([PIN_POLICY]);
  const limited = rl.left > 0;
  const [sending, setSending] = useState(false);

  const fail = useCallback(
    (msg: string) => {
      haptic.notify("error");
      dispatch({ type: "fail", err: msg });
      setTimeout(() => dispatch({ type: "settle" }), 480);
    },
    [dispatch],
  );

  const handleErr = useCallback(
    (e: unknown, stageOnInvalid: "cur" | "code" | "new") => {
      if (rateLimits.note(e, PIN_POLICY)) {
        dispatch({ type: "neutral" }); // the countdown explains it; the PIN was not wrong
        return;
      }
      if (e instanceof ApiError && e.code === "PIN_LOCKED") {
        setLockedUntil(Date.now() + (e.retryAfter ?? 300) * 1000);
        dispatch({ type: "advance", stage: "cur", patch: { err: null } });
        haptic.notify("error");
        return;
      }
      const msg = errText(e);
      if (e instanceof ApiError && (e.code === "PIN_INVALID" || e.code === "RESET_CODE_INVALID" || e.code === "RESET_CODE_EXPIRED" || e.code === "PIN_FORMAT")) {
        if (s.stage !== stageOnInvalid) {
          haptic.notify("error");
          dispatch({ type: "advance", stage: stageOnInvalid, patch: { err: msg, first: "" } });
          return;
        }
      }
      fail(msg);
    },
    [errText, fail, s.stage],
  );

  const sendCode = useCallback(
    async (again: boolean) => {
      setSending(true);
      dispatch({ type: "info", info: t("pin.rs.sending"), err: null });
      try {
        const r = await api.security.resetRequest();
        dispatch({ type: "advance", stage: "code", patch: { mode: "reset", info: again ? t("pin.rs.resent") : t("pin.rs.sent", { min: Math.max(1, Math.round(r.expires_in / 60)) }) } });
      } catch (e) {
        dispatch({ type: "advance", stage: "code", patch: { mode: "reset", err: errText(e) } });
      } finally {
        setSending(false);
      }
    },
    [api, errText, t],
  );

  useEffect(() => {
    if (mode === "reset") void sendCode(false);
    // request the code once when the sheet opens in reset mode
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // react to a full entry
  useEffect(() => {
    if (!pinFull(s) || s.busy || s.shake) return;
    const entry = s.entry;
    const step = async () => {
      if (s.stage === "cur") {
        dispatch({ type: "busy", on: true });
        try {
          if (s.mode === "off") {
            const st = await api.security.removePin(entry);
            setSecurity(st);
            haptic.notify("success");
            showToast(t("pin.off.ok"), "key");
            onDone?.(st, "off");
            onClose();
          } else {
            const sess = await api.session.verifyPin(entry);
            applySession(sess);
            dispatch({ type: "advance", stage: "new", patch: { current: entry } });
          }
        } catch (e) {
          handleErr(e, "cur");
        }
        return;
      }
      if (s.stage === "code") {
        // the code is verified together with the new PIN (reset-confirm)
        dispatch({ type: "advance", stage: "new", patch: { code: entry } });
        return;
      }
      if (s.stage === "new") {
        if (isWeakPin(entry)) return fail(t("pin.weak"));
        dispatch({ type: "advance", stage: "rep", patch: { first: entry } });
        return;
      }
      // rep
      if (entry !== s.first) {
        haptic.notify("error");
        dispatch({ type: "fail", err: t("pin.set.mis") });
        setTimeout(() => dispatch({ type: "advance", stage: "new", patch: { first: "", err: t("pin.set.mis") } }), 480);
        return;
      }
      dispatch({ type: "busy", on: true });
      try {
        let st: SecurityState;
        if (s.mode === "reset") {
          const sess = await api.security.resetConfirm({ code: s.code, new_pin: entry });
          applySession(sess);
          st = sess.security;
        } else if (s.mode === "change") {
          st = await api.security.setPin({ pin: entry, current_pin: s.current });
        } else {
          st = await api.security.setPin({ pin: entry });
        }
        setSecurity(st);
        haptic.notify("success");
        showToast(s.mode === "set" ? t("pin.set.ok") : s.mode === "change" ? t("pin.ch.ok") : t("pin.rs.ok"), "key");
        onDone?.(st, s.mode as PinSheetMode);
        onClose();
      } catch (e) {
        handleErr(e, s.mode === "reset" ? "code" : s.mode === "change" ? "cur" : "new");
      }
    };
    void step();
  }, [s, api, applySession, fail, handleErr, onClose, onDone, setSecurity, t]);

  useKeypadKeys((d) => dispatch({ type: "digit", d }), () => dispatch({ type: "erase" }), !(s.stage === "cur" && wait > 0) && !limited);

  const titles = { set: t("pin.set.t"), change: t("pin.ch.t"), off: t("pin.off.t"), reset: t("pin.rs.t"), unlock: t("pin.lock.h") } as const;
  const waiting = s.stage === "cur" && wait > 0;
  const hint = waiting
    ? t("pin.lock.wait", { time: fmt.mmss(wait) })
    : limited
      ? t("err.RATE_LIMITED.wait", { n: rl.left })
      : s.err ?? s.info ?? { cur: s.mode === "off" ? t("pin.off.cur") : t("pin.ch.cur"), code: t("pin.rs.code"), new: t("pin.set.p1"), rep: t("pin.set.p2") }[s.stage];

  return (
    <Sheet title={titles[s.mode]} onClose={onClose}>
      <div className="pin-sheet" data-testid="pin-sheet" data-stage={s.stage}>
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
        <p className={s.err || waiting || limited ? "hint bad" : s.info ? "hint ok" : "hint"} aria-live="polite" data-testid="pin-hint">
          <TickingText ticking={waiting || limited} text={hint} />
        </p>
        <PinDots filled={s.entry.length} total={pinNeed(s)} error={s.shake} />
        <Keypad
          onDigit={(d) => dispatch({ type: "digit", d })}
          onErase={() => dispatch({ type: "erase" })}
          disabled={waiting || limited || s.busy}
          eraseLabel={t("kp.del")}
        />
        {s.stage === "cur" && (
          <button className="pin-forgot sm" type="button" onClick={() => void sendCode(false)} disabled={sending}>
            {t("pin.lock.forgot")}
          </button>
        )}
        {s.stage === "code" && (
          <button className="pin-forgot sm" type="button" onClick={() => void sendCode(true)} disabled={sending}>
            {t("pin.rs.again")}
          </button>
        )}
      </div>
    </Sheet>
  );
}
