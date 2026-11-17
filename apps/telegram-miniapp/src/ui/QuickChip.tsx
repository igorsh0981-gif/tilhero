import { useI18n, type MessageKey } from "../i18n";
import { Icon, type IconName } from "./Icon";
import { Chip } from "./kit";

/** Badge text of a counter: compact for big numbers. */
export const badgeNum = (n: number): string => (n > 999 ? "999+" : String(n));

/**
 * Quick chip with a counter (catalogue categories, fix 4.1; news topics, fix 6.1): a small badge like the «Фильтры»
 * counter; 0 → muted without a badge (still clickable); count undefined (counters unavailable) → a plain chip.
 * `icon` — the category icon of the catalogue (news topics); `noun` — the plural word of the counter for screen readers.
 */
export function QuickChip(props: {
  pressed: boolean;
  onToggle: () => void;
  label: string;
  count: number | undefined;
  id: string;
  icon?: IconName;
  testIdPrefix?: string;
  noun?: MessageKey;
}) {
  const { tp } = useI18n();
  const { pressed, count } = props;
  const zero = count === 0 && !pressed;
  const shown = count !== undefined && count > 0;
  return (
    <Chip
      pressed={pressed}
      onToggle={props.onToggle}
      className={zero ? "ct-qc dim" : "ct-qc"}
      testId={`${props.testIdPrefix ?? "qc"}-${props.id}`}
      ariaLabel={shown ? `${props.label}, ${count} ${tp(props.noun ?? "ct.q.events", count)}` : undefined}
    >
      {props.icon && <Icon name={props.icon} size={15} />}
      {props.label}
      {shown && (
        <span className="qc-n" aria-hidden="true" data-testid="qc-count">
          {badgeNum(count)}
        </span>
      )}
    </Chip>
  );
}
