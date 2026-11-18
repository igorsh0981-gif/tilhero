import type { Goal, LearningPlan, LevelSelf, PlanPatch } from "@tilhero/contracts/bff";

/** Topics of the plan: codes of GET /v1/directory/topics, at most 5 (bff.ts LearningPlan.topics, 422 PLAN_INVALID). */
export const MAX_TOPICS = 5;

/** Profile → «Цель и уровень»: the draft of the direction of learning. */
export interface DirectionDraft {
  goal: Goal | null;
  level_self: LevelSelf | null;
  topics: string[];
}

export function directionOf(plan: Pick<LearningPlan, "goal" | "level_self" | "topics">): DirectionDraft {
  return { goal: plan.goal, level_self: plan.level_self, topics: [...(plan.topics ?? [])] };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/**
 * Only the changed fields (PATCH /v1/plan with If-Match). A goal or a level is never cleared (the server has no
 * «no goal» after onboarding); topics are compared as a set. `known` — topic codes of the directory: codes the
 * directory no longer has are dropped when topics are sent.
 */
export function directionPatch(plan: DirectionDraft, draft: DirectionDraft, known?: ReadonlySet<string>): PlanPatch {
  const out: PlanPatch = {};
  if (draft.goal && draft.goal !== plan.goal) out.goal = draft.goal;
  if (draft.level_self && draft.level_self !== plan.level_self) out.level_self = draft.level_self;
  const keep = (list: readonly string[]) => (known ? list.filter((t) => known.has(t)) : [...list]);
  const topics = keep(draft.topics);
  if (!sameSet(keep(plan.topics), topics)) out.topics = topics.slice(0, MAX_TOPICS);
  return out;
}

/** Tap on a topic chip: off → on while fewer than 5 are chosen; on → off. Order of choice is kept. */
export function toggleTopic(list: readonly string[], code: string, max = MAX_TOPICS): string[] {
  if (list.includes(code)) return list.filter((c) => c !== code);
  return list.length >= max ? [...list] : [...list, code];
}
