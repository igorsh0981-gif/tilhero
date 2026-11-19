/**
 * Editors of the course structure (ADM-CONT-01/02): course (pair, levels, order of modules), module (theme, order of
 * lessons) and skill (area, level, prerequisites — no cycles, checked by the catalog at publication — rubric and the
 * diagnostic tags that count as evidence of the skill).
 */
import type { CoursePayload, ModulePayload, SkillPayload } from "@tilhero/contracts/content";
import { useI18n, type MessageKey } from "../../i18n";
import { LocField, RefList, Sec, SelectField, TagsField, TextField } from "./fields";
import { BANDS, SKILL_AREAS, TOPICS } from "./model";
import { useRefs, withCurrent } from "./refs";
import type { EditorProps } from "./Workspace";

export function CourseEditor({ payload: p, set }: EditorProps<CoursePayload>) {
  const { t } = useI18n();
  const refs = useRefs();
  const up = <K extends keyof CoursePayload>(k: K, v: CoursePayload[K]) => set((x) => ({ ...x, [k]: v }));
  return (
    <div className="ed" data-testid="course-editor">
      <Sec path="payload" title={t("co.basics")}>
        <div className="form-grid">
          <TextField path="payload.pair_id" label={t("co.pair")} value={p.pair_id} mono max={16} onChange={(v) => up("pair_id", v)} hint={t("co.pairHint")} />
          <span />
          <LocField path="payload.title" label={t("co.title")} value={p.title} max={120} onChange={(v) => up("title", v)} />
          <LocField path="payload.description" label={t("co.description")} value={p.description} max={600} multiline onChange={(v) => up("description", v)} />
          <SelectField path="payload.level_start" label={t("co.from")} value={p.level_start} options={BANDS.map((b) => ({ v: b, label: b }))} onChange={(v) => up("level_start", v)} />
          <SelectField path="payload.level_end" label={t("co.to")} value={p.level_end} options={BANDS.map((b) => ({ v: b, label: b }))} onChange={(v) => up("level_end", v)} />
        </div>
      </Sec>
      <Sec path="payload.module_ids" title={t("co.modules")}>
        <RefList path="payload.module_ids" label={t("co.modulesOrder")} values={p.module_ids} options={refs.options("module")} ordered onChange={(v) => up("module_ids", v)} required />
      </Sec>
    </div>
  );
}

export function ModuleEditor({ payload: p, set }: EditorProps<ModulePayload>) {
  const { t } = useI18n();
  const refs = useRefs();
  const up = <K extends keyof ModulePayload>(k: K, v: ModulePayload[K]) => set((x) => ({ ...x, [k]: v }));
  return (
    <div className="ed" data-testid="module-editor">
      <Sec path="payload" title={t("mo.basics")}>
        <div className="form-grid">
          <SelectField path="payload.course_id" label={t("le.course")} value={p.course_id} options={withCurrent(refs.options("course"), p.course_id)} onChange={(v) => up("course_id", v)} />
          <SelectField path="payload.theme" label={t("mo.theme")} value={p.theme} options={TOPICS.map((x) => ({ v: x, label: t(`topic.${x}` as MessageKey) }))} onChange={(v) => up("theme", v)} />
          <LocField path="payload.title" label={t("mo.title")} value={p.title} max={120} onChange={(v) => up("title", v)} />
          <LocField path="payload.goal" label={t("mo.goal")} value={p.goal} max={300} multiline onChange={(v) => up("goal", v)} />
        </div>
      </Sec>
      <Sec path="payload.lesson_ids" title={t("mo.lessons")}>
        <RefList path="payload.lesson_ids" label={t("mo.lessonsOrder")} values={p.lesson_ids} options={refs.options("lesson")} ordered onChange={(v) => up("lesson_ids", v)} required />
      </Sec>
    </div>
  );
}

export function SkillEditor({ payload: p, set }: EditorProps<SkillPayload>) {
  const { t } = useI18n();
  const refs = useRefs();
  const up = <K extends keyof SkillPayload>(k: K, v: SkillPayload[K]) => set((x) => ({ ...x, [k]: v }));
  return (
    <div className="ed" data-testid="skill-editor">
      <Sec path="payload" title={t("sk.basics")}>
        <div className="form-grid">
          <SelectField path="payload.course_id" label={t("le.course")} value={p.course_id} options={withCurrent(refs.options("course"), p.course_id)} onChange={(v) => up("course_id", v)} />
          <SelectField path="payload.area" label={t("sk.area")} value={p.area} options={SKILL_AREAS.map((x) => ({ v: x, label: t(`area.${x}` as MessageKey) }))} onChange={(v) => up("area", v)} />
          <LocField path="payload.title" label={t("sk.title")} value={p.title} max={120} onChange={(v) => up("title", v)} />
          <LocField path="payload.description" label={t("sk.description")} value={p.description} max={400} multiline onChange={(v) => up("description", v)} />
          <SelectField path="payload.level" label={t("le.level")} value={p.level} options={BANDS.map((b) => ({ v: b, label: b }))} onChange={(v) => up("level", v)} />
          <SelectField path="payload.rubric_id" label={t("le.rubric")} value={p.rubric_id ?? ""} options={withCurrent(refs.options("rubric"), p.rubric_id, t("mx.noRubric"))} onChange={(v) => up("rubric_id", v || null)} />
        </div>
      </Sec>
      <Sec path="payload.prerequisites" title={t("sk.prereq")} sub={t("sk.prereqHint")}>
        <RefList path="payload.prerequisites" label={t("sk.requires")} values={p.prerequisites} options={refs.options("skill").filter((o) => o.v !== p.skill_id)} onChange={(v) => up("prerequisites", v)} />
        <TagsField path="payload.diagnostic_tags" label={t("sk.tags")} values={p.diagnostic_tags} pattern={/^[a-z0-9][a-z0-9._-]*$/} onChange={(v) => up("diagnostic_tags", v)} hint={t("sk.tagsHint")} />
      </Sec>
    </div>
  );
}
