import type { SessionResponse } from "@tilhero/contracts/bff";
import { useI18n } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { PinPad } from "./PinPad";

/** The session is limited until the parent code is entered (security.pin_required / 423 PIN_REQUIRED). */
export function LockScreen({ length, verify }: { length: number; verify: (pin: string) => Promise<SessionResponse> }) {
  const { t } = useI18n();
  return (
    <main className="state" data-testid="lock">
      <span className="nic" aria-hidden="true"><Icon name="lock" size={22} /></span>
      <h1 className="h2">{t("pin.title")}</h1>
      <p className="sub">{t("pin.text")}</p>
      <div className="lock-pad">
        <PinPad length={length} submit={async (pin) => void (await verify(pin))} />
      </div>
    </main>
  );
}
