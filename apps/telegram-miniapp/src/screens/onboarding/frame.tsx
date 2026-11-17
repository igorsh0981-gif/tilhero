import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import { ErrorLine, Steps } from "../../ui/kit";
import { Bar } from "../../ui/shell";

/**
 * One onboarding step: bar «Шаг N из M» with back, progress, the body (must fit 390×844 without scrolling — AT-04)
 * and the pinned footer with the primary action.
 */
export function ObFrame(props: {
  id: string;
  n: number;
  m: number;
  onBack: (() => void) | null;
  children: ReactNode;
  foot: ReactNode;
  error?: string | null;
  tight?: boolean;
}) {
  const { t } = useI18n();
  const label = t("c.step", { n: props.n, m: props.m });
  return (
    <>
      <Bar title={label} onBack={props.onBack} plainTitle />
      <main className="ob" data-testid={`ob-step-${props.id}`}>
        <div className="ob-top">
          <Steps n={props.n} m={props.m} label={label} />
        </div>
        <div className={props.tight ? "ob-body tight" : "ob-body"}>{props.children}</div>
        <div className="ob-foot">
          <ErrorLine text={props.error ?? null} />
          {props.foot}
        </div>
      </main>
    </>
  );
}
