import type { PinResetRequestResponse, SecurityState, SessionResponse } from "@tilhero/contracts/bff";
import { useState } from "react";
import { useI18n } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { Btn } from "../../ui/kit";
import { PinReset, PinResetPending } from "./PinFlows";
import { PinPad } from "./PinPad";

/**
 * The session is limited until the parent code is entered (security.pin_required / 423 PIN_REQUIRED). «Забыли код?» —
 * the reset through the bot (allowed in a session that still waits for the code): a 6-digit code from the chat and a
 * new parent code that takes effect only in 24 hours (review T-8: the phone may be in a child's hands). Until then the
 * lock screen still asks for the old code; entering it cancels the pending reset (`pendingAt` shows the hint).
 */
export function LockScreen({
  length,
  pendingAt,
  verify,
  reset,
}: {
  length: number;
  pendingAt?: string | null;
  verify: (pin: string) => Promise<SessionResponse>;
  reset?: { request: () => Promise<PinResetRequestResponse>; confirm: (code: string, newPin: string) => Promise<SecurityState> };
}) {
  const { t } = useI18n();
  const [resetting, setResetting] = useState(false);
  return (
    <main className="state" data-testid="lock">
      <span className="nic" aria-hidden="true"><Icon name="lock" size={22} /></span>
      <h1 className="h2">{resetting ? t("pc.reset.title") : t("pin.title")}</h1>
      {resetting && reset ? (
        <div className="lock-pad">
          <PinReset request={reset.request} confirm={reset.confirm} onDone={() => setResetting(false)} onCancel={() => setResetting(false)} />
        </div>
      ) : (
        <>
          <p className="sub">{t("pin.text")}</p>
          {pendingAt ? (
            <div className="lock-pad">
              <PinResetPending at={pendingAt} />
            </div>
          ) : null}
          <div className="lock-pad">
            <PinPad length={length} submit={async (pin) => void (await verify(pin))} />
          </div>
          {reset ? (
            <Btn variant="link" onClick={() => setResetting(true)} data-testid="lock-forgot">
              {t("pc.forgot")}
            </Btn>
          ) : null}
        </>
      )}
    </main>
  );
}
