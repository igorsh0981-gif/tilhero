import { useRef } from "react";
import { useI18n } from "../i18n";
import { useRateWait } from "../lib/rateLimit";
import { Icon } from "./Icon";

/**
 * Sprint 9 review: the live 429 countdown «Слишком много запросов — повторите через N с» of a scope (a dialog, the
 * sign-in form, the shell). Screen readers hear it once — the visible seconds are aria-hidden, a visually hidden copy
 * keeps the first text — instead of every second.
 */
export function RateWaitNotice({ scope, testId = "rate-wait" }: { scope: readonly string[]; testId?: string }) {
  const { t } = useI18n();
  const left = useRateWait(scope);
  const first = useRef<string | null>(null);
  if (left <= 0) {
    first.current = null;
    return null;
  }
  const text = t("err.RATE_LIMITED.wait", { n: left });
  if (first.current == null) first.current = text;
  return (
    <div className="callout warn" role="status" data-testid={testId}>
      <Icon name="clock" />
      <div className="grow">
        <span aria-hidden="true" data-testid={`${testId}-visible`}>
          {text}
        </span>
        <span className="sr-only">{first.current}</span>
      </div>
    </div>
  );
}
