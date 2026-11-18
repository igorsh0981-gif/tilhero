import type { PinResetRequestResponse, SessionResponse } from "@tilhero/contracts/bff";
import { useState } from "react";
import { useI18n } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { Btn } from "../../ui/kit";
import { PinReset } from "./PinFlows";
import { PinPad } from "./PinPad";

/**
 * The session is limited until the parent code is entered (security.pin_required / 423 PIN_REQUIRED). «Забыли код?» —
 * the reset through the bot (allowed in a session that still waits for the code): a 6-digit code from the chat and a
 * new parent code give a new session.
 */
export function LockScreen({
  length,
  verify,
  reset,
}: {
  length: number;
  verify: (pin: string) => Promise<SessionResponse>;
  reset?: { request: () => Promise<PinResetRequestResponse>; confirm: (code: string, newPin: string) => Promise<void> };
}) {
  const { t } = useI18n();
  const [resetting, setResetting] = useState(false);
  return (
    <main className="state" data-testid="lock">
      <span className="nic" aria-hidden="true"><Icon name="lock" size={22} /></span>
      <h1 className="h2">{resetting ? t("pc.reset.title") : t("pin.title")}</h1>
      {resetting && reset ? (
        <div className="lock-pad">
          <PinReset request={reset.request} confirm={reset.confirm} onCancel={() => setResetting(false)} />
        </div>
      ) : (
        <>
          <p className="sub">{t("pin.text")}</p>
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
