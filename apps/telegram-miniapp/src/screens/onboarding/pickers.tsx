import type { DirectoryItem, Goal, LevelSelf } from "@tilhero/contracts/bff";
import { useMemo } from "react";
import { MAX_TOPICS, toggleTopic } from "../../domain/plan";
import { useI18n, type MessageKey } from "../../i18n";
import { Chip, Opt } from "../../ui/kit";

/* Choices of the direction of learning, shared by onboarding (goal and level steps) and Profile → «Цель и уровень»:
 * the same options, labels and test ids in both places. */

export const GOALS: readonly Goal[] = ["work", "career", "travel", "daily", "study", "exam"];
export const LEVELS: readonly LevelSelf[] = ["zero", "beginner", "some", "confident"];

/** Goals of GET /v1/directory/goals (labels RU/UZ of the server); the bundled labels while it loads or fails. */
export function useGoalItems(items: DirectoryItem[] | null | undefined): Array<{ code: Goal; label: string }> {
  const { t, l } = useI18n();
  return useMemo(() => {
    const fromServer = (items ?? []).filter((i) => (GOALS as readonly string[]).includes(i.code));
    if (fromServer.length) return fromServer.map((i) => ({ code: i.code as Goal, label: l(i.label) }));
    return GOALS.map((g) => ({ code: g, label: t(`goal.${g}` as MessageKey) }));
  }, [items, l, t]);
}

export function GoalPicker(props: { items: Array<{ code: Goal; label: string }>; value: Goal | null; onChange: (g: Goal) => void; label: string; labelledBy?: string }) {
  return (
    <div className="chips" role="group" aria-label={props.labelledBy ? undefined : props.label} aria-labelledby={props.labelledBy} data-testid="goal-picker">
      {props.items.map((g) => (
        <Chip key={g.code} on={props.value === g.code} label={g.label} onClick={() => props.onChange(g.code)} />
      ))}
    </div>
  );
}

export function LevelPicker(props: { value: LevelSelf | null; onChange: (l: LevelSelf) => void; label?: string; labelledBy?: string }) {
  const { t } = useI18n();
  return (
    <div className="opts" role="group" aria-label={props.labelledBy ? undefined : props.label} aria-labelledby={props.labelledBy}>
      {LEVELS.map((lv) => (
        <Opt key={lv} on={props.value === lv} title={t(`level.${lv}` as MessageKey)} note={t(`level.${lv}.note` as MessageKey)} onClick={() => props.onChange(lv)} testId={`level-${lv}`} />
      ))}
    </div>
  );
}

/** Topics of GET /v1/directory/topics, up to 5: once five are chosen the others wait until one is taken off. */
export function TopicsPicker(props: { items: DirectoryItem[]; value: string[]; onChange: (v: string[]) => void; labelledBy?: string; label?: string }) {
  const { l } = useI18n();
  const full = props.value.length >= MAX_TOPICS;
  return (
    <div className="chips" role="group" aria-label={props.labelledBy ? undefined : props.label} aria-labelledby={props.labelledBy} data-testid="topics-picker">
      {props.items.map((i) => {
        const on = props.value.includes(i.code);
        return <Chip key={i.code} on={on} disabled={!on && full} label={l(i.label)} onClick={() => props.onChange(toggleTopic(props.value, i.code))} />;
      })}
    </div>
  );
}
