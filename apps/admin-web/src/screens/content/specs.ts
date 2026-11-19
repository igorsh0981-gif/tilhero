/** Editors of every content kind for the shared Workspace (life cycle, versions, issues). */
import type { ContentKind } from "@tilhero/contracts/content";
import { LessonEditor, LessonPreview } from "./LessonEditor";
import { ExerciseEditor, MediaEditor, mediaGate } from "./MediaEditor";
import { RubricEditor } from "./RubricEditor";
import { ScenarioEditor, scenarioGate } from "./ScenarioEditor";
import { CourseEditor, ModuleEditor, SkillEditor } from "./StructureEditors";
import type { KindSpec } from "./Workspace";

export const SPECS: Readonly<Record<ContentKind, KindSpec>> = {
  course: { kind: "course", Editor: CourseEditor },
  module: { kind: "module", Editor: ModuleEditor },
  skill: { kind: "skill", Editor: SkillEditor },
  lesson: { kind: "lesson", Editor: LessonEditor, Preview: LessonPreview },
  rubric: { kind: "rubric", Editor: RubricEditor },
  scenario: { kind: "scenario", Editor: ScenarioEditor, gate: scenarioGate },
  media_asset: { kind: "media_asset", Editor: MediaEditor, gate: mediaGate },
  media_exercise: { kind: "media_exercise", Editor: ExerciseEditor },
};
