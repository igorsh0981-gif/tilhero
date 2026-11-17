import { useState, type ReactNode } from "react";
import { selfLearner } from "../../domain/people";
import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction } from "../../state/hooks";
import { Sheet } from "../../ui/overlays";
import { PinPad } from "../lock/PinPad";

/** Back from a child profile to the parent: the parent code is asked when it is set (bff.ts SwitchLearnerRequest). */
export function useSwitchToParent(): { run: () => Promise<void>; busy: boolean; error: string | null; sheet: ReactNode } {
  const { bff, session, applySession, nav } = useApp();
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const self = selfLearner(session);
  const act = useAction(async () => {
    if (!self) return;
    if (session.security.pin_enabled) {
      setAsking(true);
      return;
    }
    await applySession(await bff.switchLearner(self.learner_id));
    nav.reset();
  });
  const sheet =
    asking && self ? (
      <Sheet title={t("pin.switchTitle")} onClose={() => setAsking(false)} testId="pin-sheet">
        <p className="sub">{t("pin.switchText")}</p>
        <PinPad
          length={session.security.pin_length ?? 4}
          submit={async (pin) => {
            const s = await bff.switchLearner(self.learner_id, pin);
            setAsking(false);
            await applySession(s);
            nav.reset();
          }}
        />
      </Sheet>
    ) : null;
  return { run: async () => void (await act.run()), busy: act.busy, error: act.error, sheet };
}

/** Into a child profile of this account: new tokens with lrn = child; the shell shows onboarding if the child has none. */
export function useSwitchToChild() {
  const { bff, applySession, nav } = useApp();
  return useAction(async (learnerId: string) => {
    await applySession(await bff.switchLearner(learnerId));
    nav.reset();
  });
}
