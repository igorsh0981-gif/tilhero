import type { LessonCard, SkillMap, SkillState } from "@tilhero/contracts/bff";
import type { SkillArea } from "@tilhero/contracts/content";

/** Pure helpers of the content screens: skill groups, state glyphs, lesson stages. */
export const SKILL_STATES: readonly SkillState[] = ["not_started", "learning", "demonstrated", "retained"];
/** A state is shown by a glyph and a word, never by colour alone. */
export const STATE_GLYPH: Record<SkillState, string> = { not_started: "○", learning: "◐", demonstrated: "●", retained: "★" };
export const SKILL_AREA_ORDER: readonly SkillArea[] = ["function", "vocabulary", "grammar", "reading", "listening", "speaking", "writing"];

export type MapSkill = SkillMap["skills"][number];

/** Skills grouped by area in a fixed order (unknown areas last), the order of the course inside a group. */
export function groupSkills(skills: readonly MapSkill[]): Array<{ area: SkillArea; skills: MapSkill[] }> {
  const groups = new Map<SkillArea, MapSkill[]>();
  for (const s of skills) groups.set(s.area, [...(groups.get(s.area) ?? []), s]);
  const rank = (a: SkillArea) => {
    const i = SKILL_AREA_ORDER.indexOf(a);
    return i < 0 ? SKILL_AREA_ORDER.length : i;
  };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([area, list]) => ({ area, skills: list }));
}

/** Stages of a lesson with their share of the duration (for the stage bar). */
export function stageShares(card: Pick<LessonCard, "stages" | "duration_min">): Array<{ type: LessonCard["stages"][number]["type"]; minutes: number; pct: number }> {
  const total = card.stages.reduce((s, x) => s + Math.max(0, x.minutes), 0) || card.duration_min || 1;
  return card.stages.map((s) => ({ type: s.type, minutes: s.minutes, pct: (Math.max(0, s.minutes) / total) * 100 }));
}

/** https link of a request: optional, https only (the BFF and catalog never open it). */
export const HTTPS_LINK = /^https:\/\/[^\s]+$/;
