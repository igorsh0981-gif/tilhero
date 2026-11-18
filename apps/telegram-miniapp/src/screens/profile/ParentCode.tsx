import type { SecurityState } from "@tilhero/contracts/bff";
import { useState } from "react";
import { ApiError, errorText } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { Icon } from "../../ui/Icon";
import { Btn, NavRow, Pill } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";
import { PinReset, PinSetup } from "../lock/PinFlows";
import { PinPad } from "../lock/PinPad";

type Mode =
  | { k: "menu" }
  | { k: "set" }
  | { k: "current"; then: "change" | "remove"; note?: string | null }
  | { k: "change"; current: string }
  | { k: "reset" };

/**
 * Profile → «Код родителя» (review T-1, bff.ts «Код родителя (PIN)»): set, change, switch off, reset through the bot.
 * The code locks the way out of a child profile, deletion and the code itself. Setting or changing it signs out the
 * other devices of the account; the reset gives a new session (the previous ones are revoked).
 */
export function ParentCode() {
  const { bff, session, nav, patchSession, applySession } = useApp();
  const { t, fmt } = useI18n();
  const sec = session.security;
  const [mode, setMode] = useState<Mode>({ k: "menu" });
  const menu = () => setMode({ k: "menu" });
  const done = (s: SecurityState, msg: MessageKey) => {
    patchSession({ security: s });
    setMode({ k: "menu" });
    showToast(t(msg));
  };

  return (
    <>
      <Bar title={t("pc.title")} onBack={mode.k === "menu" ? nav.back : menu} />
      <main className="scroll" data-testid="parent-code">
        <div className="pad stack">
          {mode.k === "menu" ? (
            <>
              <div className={sec.pin_enabled ? "card ok" : "card warn"}>
                <div className="hrow between">
                  <b className="h3">{t("pc.title")}</b>
                  <Pill tone={sec.pin_enabled ? "ok" : "warn"}>{sec.pin_enabled ? t("profile.pinOn") : t("profile.pinOff")}</Pill>
                </div>
                <p className="sub ink mt8" data-testid="pc-status">{sec.pin_enabled ? t("pc.on") : t("pc.off")}</p>
              </div>
              <p className="sub">{t("pc.text")}</p>
              {sec.pin_enabled ? (
                <div className="list">
                  <NavRow title={t("pc.change")} onClick={() => setMode({ k: "current", then: "change" })} testId="pc-change" />
                  <NavRow title={t("pc.remove")} onClick={() => setMode({ k: "current", then: "remove" })} testId="pc-remove" />
                  <NavRow title={t("pc.forgot")} onClick={() => setMode({ k: "reset" })} testId="pc-forgot" />
                </div>
              ) : (
                <Btn onClick={() => setMode({ k: "set" })} data-testid="pc-set">
                  <Icon name="lock" size={18} />
                  {t("pc.set")}
                </Btn>
              )}
            </>
          ) : null}

          {mode.k === "set" ? (
            <>
              <PinSetup save={async (pin) => done(await bff.setPin(pin), "pc.saved")} />
              <p className="sub small center">{t("pc.sessions")}</p>
            </>
          ) : null}

          {mode.k === "current" ? (
            <>
              <p className="h3 center" data-testid="pin-step">{t("pc.current")}</p>
              {mode.then === "remove" ? <p className="sub center">{t("pc.removeText")}</p> : null}
              <PinPad
                length={sec.pin_length ?? 4}
                note={mode.note}
                submit={async (pin) => {
                  if (mode.then === "change") setMode({ k: "change", current: pin });
                  else done(await bff.removePin(pin), "pc.removed");
                }}
              />
            </>
          ) : null}

          {mode.k === "change" ? (
            <>
              <PinSetup
                save={async (pin) => {
                  try {
                    done(await bff.setPin(pin, mode.current), "pc.changed");
                  } catch (e) {
                    // the current code is checked only now: a wrong one leads back to it
                    if (e instanceof ApiError && (e.code === "PIN_INVALID" || e.code === "PIN_LOCKED")) {
                      setMode({ k: "current", then: "change", note: errorText(e, t, fmt.mmss) });
                      return;
                    }
                    throw e;
                  }
                }}
              />
              <p className="sub small center">{t("pc.sessions")}</p>
            </>
          ) : null}

          {mode.k === "reset" ? (
            <>
              <h2 className="h2">{t("pc.reset.title")}</h2>
              <PinReset
                request={() => bff.pinResetRequest()}
                confirm={async (code, pin) => {
                  await applySession(await bff.pinResetConfirm(code, pin));
                  setMode({ k: "menu" });
                  showToast(t("pc.reset.done"));
                }}
                onCancel={menu}
              />
            </>
          ) : null}
        </div>
      </main>
    </>
  );
}

/**
 * The offer right after the first child profile is created (review T-1): set the parent code now or skip it. Shown
 * only in the parent's own profile (the PIN routes answer 403 ADULT_REQUIRED in a child profile).
 */
export function PinOffer({ onDone }: { onDone: (set: boolean) => void }) {
  const { bff, patchSession } = useApp();
  const { t } = useI18n();
  const skip = () => {
    showToast(t("pc.offer.later"));
    onDone(false);
  };
  return (
    <Sheet title={t("pc.offer.title")} onClose={skip} testId="pin-offer">
      <p className="sub ink">{t("pc.offer.text")}</p>
      <PinSetup
        testId="pin-offer-setup"
        save={async (pin) => {
          patchSession({ security: await bff.setPin(pin) });
          showToast(t("pc.saved"));
          onDone(true);
        }}
      />
      <Btn variant="secondary" onClick={skip} data-testid="pin-offer-skip">
        {t("pc.offer.skip")}
      </Btn>
    </Sheet>
  );
}
