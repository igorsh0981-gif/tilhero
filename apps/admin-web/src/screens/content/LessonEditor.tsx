/**
 * Lesson editor (LessonPayload, ADM-CONT-01/02): every field of the format — RU/UZ texts with the empty translations
 * highlighted, five stages with minutes and the sum against the lesson length, key words, examples, control items of
 * the four types with their answer key, links to the scenario and the rubric, audience, goals and topics — and the
 * learner preview (the lesson card of the Mini App in RU/UZ). The control items' keys are staff-only: the learner API
 * never returns `answer` (CourseSnapshot).
 */
import { useState } from "react";
import type { ControlItem, LessonPayload, Localized } from "@tilhero/contracts/content";
import type { UiLang } from "@tilhero/contracts/admin";
import { useI18n, type MessageKey } from "../../i18n";
import { lt } from "../../i18n/learner";
import { Btn, cx, Pill } from "../../ui/kit";
import { Maybe, Phone, PreviewControls } from "../news/parts";
import { CheckGroup, ItemHead, LocField, moveIn, NumField, PathIssues, RefList, removeAt, Sec, SelectField, setAt, TextField, useEd } from "./fields";
import { answerText, AUDIENCES, BANDS, CONTROL_TYPES, DURATIONS, GOALS, L, splitAnswers, splitWords, STAGE_ORDER, stagesSum, TOPICS } from "./model";
import { useRefs, withCurrent } from "./refs";
import type { EditorProps } from "./Workspace";

type P = LessonPayload;

export function LessonEditor({ payload: p, set }: EditorProps<P>) {
  const { t } = useI18n();
  const refs = useRefs();
  const up = <K extends keyof P>(k: K, v: P[K]) => set((x) => ({ ...x, [k]: v }));
  const sum = stagesSum(p.stages);
  const skillOpts = refs.options("skill");
  return (
    <div className="ed" data-testid="lesson-editor">
      <Sec path="payload" title={t("le.basics")}>
        <div className="form-grid">
          <SelectField path="payload.course_id" label={t("le.course")} value={p.course_id} options={withCurrent(refs.options("course"), p.course_id)} onChange={(v) => up("course_id", v)} required />
          <SelectField path="payload.module_id" label={t("le.module")} value={p.module_id} options={withCurrent(refs.options("module"), p.module_id, t("ct.choose"))} onChange={(v) => up("module_id", v)} required testId="le-module" />
          <LocField path="payload.title" label={t("le.title")} value={p.title} max={120} onChange={(v) => up("title", v)} testId="le-title" />
          <LocField path="payload.goal" label={t("le.goal")} value={p.goal} max={240} onChange={(v) => up("goal", v)} hint={t("le.goalHint")} testId="le-goal" />
          <SelectField path="payload.level" label={t("le.level")} value={p.level} options={BANDS.map((b) => ({ v: b, label: b }))} onChange={(v) => up("level", v)} />
          <SelectField path="payload.kind" label={t("le.kind")} value={p.kind} options={(["core", "optional"] as const).map((k) => ({ v: k, label: t(`le.kind.${k}`) }))} onChange={(v) => up("kind", v)} />
          <SelectField
            path="payload.duration_min"
            label={t("le.duration")}
            value={String(p.duration_min)}
            options={DURATIONS.map((d) => ({ v: String(d), label: t("le.min", { n: d }) }))}
            onChange={(v) => up("duration_min", Number(v) as P["duration_min"])}
            testId="le-duration"
          />
          <CheckGroup path="payload.audience" label={t("ct.audience")} values={p.audience} options={AUDIENCES.map((a) => ({ v: a, label: t(`ageseg.${a}`) }))} onChange={(v) => up("audience", v)} required testId="le-aud" />
          <CheckGroup className="span-2" path="payload.goals" label={t("ct.goals")} values={p.goals} options={GOALS.map((g) => ({ v: g, label: t(`goal.${g}`) }))} onChange={(v) => up("goals", v)} />
          <CheckGroup className="span-2" path="payload.topics" label={t("ct.topics")} values={p.topics} options={TOPICS.map((x) => ({ v: x, label: t(`topic.${x}` as MessageKey) }))} onChange={(v) => up("topics", v)} />
        </div>
      </Sec>

      <Sec path="payload.primary_skill_id" title={t("le.skills")}>
        <div className="form-grid">
          <SelectField className="span-2" path="payload.primary_skill_id" label={t("le.primary")} value={p.primary_skill_id} options={withCurrent(skillOpts, p.primary_skill_id, t("ct.choose"))} onChange={(v) => up("primary_skill_id", v)} required />
          <RefList path="payload.secondary_skill_ids" label={t("le.secondary")} values={p.secondary_skill_ids} options={skillOpts.filter((o) => o.v !== p.primary_skill_id)} max={3} onChange={(v) => up("secondary_skill_ids", v)} />
          <RefList path="payload.prerequisite_skill_ids" label={t("le.prereq")} values={p.prerequisite_skill_ids} options={skillOpts} onChange={(v) => up("prerequisite_skill_ids", v)} />
        </div>
      </Sec>

      <Sec
        path="payload.stages"
        title={t("le.stages")}
        testId="le-stages"
        aside={
          <Pill tone={sum === p.duration_min ? "good" : "bad"} testId="le-sum">
            {t("le.sum", { s: sum, d: p.duration_min })}
          </Pill>
        }
        sub={t("le.stagesHint")}
      >
        <ol className="stage-list">
          {p.stages.map((s, i) => (
            <li key={i} className="stage-row" data-path={`payload.stages[${i}]`}>
              <span className={cx("stage-badge", STAGE_ORDER[i] !== s.type && "is-bad")}>
                <span className="idx">{i + 1}</span>
                {t(`stage.${s.type}` as MessageKey)}
              </span>
              <NumField path={`payload.stages[${i}].minutes`} label={t("le.minutes")} value={s.minutes} min={1} max={10} onChange={(v) => up("stages", setAt(p.stages, i, { ...s, minutes: v }))} testId={`le-min-${i}`} />
              <LocField path={`payload.stages[${i}].instructions`} label={t("le.instructions")} value={s.instructions} max={300} multiline onChange={(v) => up("stages", setAt(p.stages, i, { ...s, instructions: v }))} testId={`le-stage-${i}`} />
            </li>
          ))}
        </ol>
      </Sec>

      <Sec path="payload.key_words" title={t("le.words")} aside={<CountPill n={p.key_words.length} lo={4} hi={12} />} testId="le-words">
        {p.key_words.map((k, i) => (
          <div key={i} className="item" data-path={`payload.key_words[${i}]`}>
            <ItemHead n={i + 1} title={k.en || t("le.word")} onUp={i > 0 ? () => up("key_words", moveIn(p.key_words, i, -1)) : undefined} onDown={i < p.key_words.length - 1 ? () => up("key_words", moveIn(p.key_words, i, 1)) : undefined} onRemove={() => up("key_words", removeAt(p.key_words, i))} removeLabel={t("ct.removeN", { n: i + 1 })} />
            <div className="form-grid">
              <TextField path={`payload.key_words[${i}].en`} label={t("le.wordEn")} value={k.en} max={60} required onChange={(v) => up("key_words", setAt(p.key_words, i, { ...k, en: v }))} />
              <LocField path={`payload.key_words[${i}].gloss`} label={t("le.gloss")} value={k.gloss} max={120} onChange={(v) => up("key_words", setAt(p.key_words, i, { ...k, gloss: v }))} />
              <TextField className="span-2" path={`payload.key_words[${i}].example_en`} label={t("le.exampleEn")} value={k.example_en} max={160} required onChange={(v) => up("key_words", setAt(p.key_words, i, { ...k, example_en: v }))} />
            </div>
          </div>
        ))}
        <AddBtn label={t("le.addWord")} disabled={p.key_words.length >= 12} onClick={() => up("key_words", [...p.key_words, { en: "", gloss: L(), example_en: "" }])} testId="le-add-word" />
      </Sec>

      <Sec path="payload.examples" title={t("le.examples")} aside={<CountPill n={p.examples.length} lo={2} hi={8} />}>
        {p.examples.map((x, i) => (
          <div key={i} className="item" data-path={`payload.examples[${i}]`}>
            <ItemHead n={i + 1} title={x.en || t("le.example")} onRemove={() => up("examples", removeAt(p.examples, i))} removeLabel={t("ct.removeN", { n: i + 1 })} />
            <div className="form-grid">
              <TextField path={`payload.examples[${i}].en`} label={t("le.exampleEn")} value={x.en} max={200} required onChange={(v) => up("examples", setAt(p.examples, i, { ...x, en: v }))} />
              <LocField path={`payload.examples[${i}].gloss`} label={t("le.gloss")} value={x.gloss} max={240} onChange={(v) => up("examples", setAt(p.examples, i, { ...x, gloss: v }))} />
            </div>
          </div>
        ))}
        <AddBtn label={t("le.addExample")} disabled={p.examples.length >= 8} onClick={() => up("examples", [...p.examples, { en: "", gloss: L() }])} />
      </Sec>

      <Sec path="payload.control_items" title={t("le.control")} aside={<CountPill n={p.control_items.length} lo={3} hi={null} />} sub={t("le.controlHint")} testId="le-control">
        {p.control_items.map((it, i) => (
          <ControlItemEditor key={i} i={i} it={it} n={p.control_items.length} skills={skillOpts} onChange={(v) => up("control_items", setAt(p.control_items, i, v))} onRemove={() => up("control_items", removeAt(p.control_items, i))} onMove={(d) => up("control_items", moveIn(p.control_items, i, d))} />
        ))}
        <AddBtn
          label={t("le.addItem")}
          onClick={() => up("control_items", [...p.control_items, { item_id: `ci-${String(p.control_items.length + 1).padStart(2, "0")}`, type: "single_choice", skill_id: p.primary_skill_id, instruction: L(), prompt_en: "", options: ["", ""], answer: 0 }])}
          testId="le-add-item"
        />
      </Sec>

      <Sec path="payload.rubric_id" title={t("le.links")}>
        <div className="form-grid">
          <SelectField path="payload.scenario_id" label={t("le.scenario")} value={p.scenario_id ?? ""} options={withCurrent(refs.options("scenario"), p.scenario_id, t("le.noScenario"))} onChange={(v) => up("scenario_id", v || null)} />
          <SelectField path="payload.rubric_id" label={t("le.rubric")} value={p.rubric_id} options={withCurrent(refs.options("rubric"), p.rubric_id, t("ct.choose"))} onChange={(v) => up("rubric_id", v)} required />
        </div>
      </Sec>

      <Sec path="payload.hints" title={t("le.hints")} aside={<CountPill n={p.hints.length} lo={0} hi={5} />}>
        {p.hints.map((h, i) => (
          <div key={i} className="item" data-path={`payload.hints[${i}]`}>
            <ItemHead n={i + 1} title={t("le.hint")} onRemove={() => up("hints", removeAt(p.hints, i))} removeLabel={t("ct.removeN", { n: i + 1 })} />
            <LocField path={`payload.hints[${i}]`} label={t("le.hint")} value={h} max={200} onChange={(v) => up("hints", setAt(p.hints, i, v))} />
          </div>
        ))}
        <AddBtn label={t("le.addHint")} disabled={p.hints.length >= 5} onClick={() => up("hints", [...p.hints, L()])} />
      </Sec>
    </div>
  );
}

export function CountPill({ n, lo, hi }: { n: number; lo: number; hi: number | null }) {
  const { t } = useI18n();
  const ok = n >= lo && (hi == null || n <= hi);
  return <Pill tone={ok ? "good" : "bad"}>{hi == null ? t("ct.countMin", { n, lo }) : t("ct.countRange", { n, lo, hi })}</Pill>;
}

export function AddBtn({ label, onClick, disabled, testId }: { label: string; onClick: () => void; disabled?: boolean; testId?: string }) {
  const { editable } = useEd();
  if (!editable) return null;
  return <Btn size="sm" icon="plus" label={label} disabled={disabled} onClick={onClick} testId={testId} />;
}

/* ---------------------------------------------------------------- control item */

function ControlItemEditor({ i, it, n, skills, onChange, onRemove, onMove }: { i: number; it: ControlItem; n: number; skills: Array<{ v: string; label: string }>; onChange: (v: ControlItem) => void; onRemove: () => void; onMove: (d: number) => void }) {
  const { t } = useI18n();
  const { editable } = useEd();
  const path = `payload.control_items[${i}]`;
  const choice = it.type === "single_choice" || it.type === "translate_choice";
  const setType = (type: ControlItem["type"]) => {
    const next: ControlItem = { ...it, type };
    if (type === "single_choice" || type === "translate_choice") Object.assign(next, { options: it.options.length >= 2 && !choice ? it.options : choice ? it.options : ["", ""], answer: typeof it.answer === "number" ? it.answer : 0 });
    else if (type === "gap_fill") Object.assign(next, { options: [], answer: Array.isArray(it.answer) ? it.answer : [] });
    else Object.assign(next, { options: [], answer: [] });
    onChange(next);
  };
  return (
    <div className="item" data-path={path} data-testid={`le-item-${i}`}>
      <ItemHead n={i + 1} title={`${it.item_id} · ${t(`cit.${it.type}` as MessageKey)}`} onUp={i > 0 ? () => onMove(-1) : undefined} onDown={i < n - 1 ? () => onMove(1) : undefined} onRemove={onRemove} removeLabel={t("ct.removeN", { n: i + 1 })} />
      <div className="form-grid">
        <TextField path={`${path}.item_id`} label={t("le.itemId")} value={it.item_id} mono max={64} onChange={(v) => onChange({ ...it, item_id: v })} />
        <SelectField path={`${path}.type`} label={t("le.itemType")} value={it.type} options={CONTROL_TYPES.map((x) => ({ v: x, label: t(`cit.${x}` as MessageKey) }))} onChange={setType} testId={`le-item-type-${i}`} />
        <SelectField className="span-2" path={`${path}.skill_id`} label={t("le.itemSkill")} value={it.skill_id} options={withCurrent(skills, it.skill_id, t("ct.choose"))} onChange={(v) => onChange({ ...it, skill_id: v })} required />
        <LocField path={`${path}.instruction`} label={t("le.instruction")} value={it.instruction} max={200} onChange={(v: Localized) => onChange({ ...it, instruction: v })} testId={`le-item-ins-${i}`} />
        <TextField path={`${path}.prompt_en`} label={t("le.prompt")} value={it.prompt_en} max={240} required onChange={(v) => onChange({ ...it, prompt_en: v })} testId={`le-item-prompt-${i}`} hint={it.type === "gap_fill" ? t("le.gapHint") : undefined} />
      </div>
      {choice && (
        <fieldset className="field fs" data-path={`${path}.options`}>
          <legend className="field-label">{t("le.options")}</legend>
          <ol className="opt-list">
            {it.options.map((o, j) => (
              <li key={j} className={cx("opt", it.answer === j && "is-key")}>
                <label className="check" title={t("le.correct")}>
                  <input type="radio" name={`ans-${i}`} checked={it.answer === j} disabled={!editable} onChange={() => onChange({ ...it, answer: j })} aria-label={t("le.correctN", { x: String.fromCharCode(65 + j) })} data-path={`${path}.answer`} data-testid={`le-ans-${i}-${j}`} />
                  <span className="mono">{String.fromCharCode(65 + j)}</span>
                </label>
                <input className="input" value={o} disabled={!editable} lang="en" aria-label={t("le.optionN", { x: String.fromCharCode(65 + j) })} onChange={(e) => onChange({ ...it, options: setAt(it.options, j, e.target.value) })} data-testid={`le-opt-${i}-${j}`} />
                {editable && it.options.length > 2 && (
                  <Btn size="xs" kind="ghost" icon="x" aria={t("le.removeOption", { x: String.fromCharCode(65 + j) })} onClick={() => onChange({ ...it, options: removeAt(it.options, j), answer: typeof it.answer === "number" ? (it.answer === j ? 0 : it.answer > j ? it.answer - 1 : it.answer) : 0 })} />
                )}
              </li>
            ))}
          </ol>
          {editable && it.options.length < 6 && <Btn size="xs" icon="plus" label={t("le.addOption")} onClick={() => onChange({ ...it, options: [...it.options, ""] })} />}
          <PathIssues path={`${path}.options`} />
          <PathIssues path={`${path}.answer`} />
        </fieldset>
      )}
      {it.type === "gap_fill" && (
        <TextField path={`${path}.answer`} label={t("le.accepted")} value={Array.isArray(it.answer) ? it.answer.join(", ") : ""} max={200} hint={t("le.acceptedHint")} onChange={(v) => onChange({ ...it, answer: splitAnswers(v) })} testId={`le-gap-${i}`} />
      )}
      {it.type === "order_words" && (
        <div className="form-grid">
          <TextField path={`${path}.options`} label={t("le.shuffled")} value={it.options.join(" ")} max={200} hint={t("le.wordsHint")} onChange={(v) => onChange({ ...it, options: splitWords(v) })} />
          <TextField path={`${path}.answer`} label={t("le.order")} value={Array.isArray(it.answer) ? it.answer.join(" ") : ""} max={200} hint={t("le.wordsHint")} onChange={(v) => onChange({ ...it, answer: splitWords(v) })} />
        </div>
      )}
      <p className="xs key-line" data-testid={`le-key-${i}`}>
        <b>{t("le.key")}</b> <span className="mono">{answerText(it.type, it.options, it.answer)}</span>
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- learner preview */

export function LessonPreview({ payload: p }: { payload: P }) {
  const { t } = useI18n();
  const [lang, setLang] = useState<UiLang>("ru");
  const [dark, setDark] = useState(false);
  const total = stagesSum(p.stages);
  return (
    <div className="stack sm lesson-pv" data-testid="lesson-preview">
      <div className="row between">
        <span className="field-label">{t("le.previewT")}</span>
        <PreviewControls lang={lang} setLang={setLang} dark={dark} setDark={setDark} />
      </div>
      <Phone dark={dark} label={t("le.previewLabel", { l: lang.toUpperCase() })} testId="lesson-phone">
        <div className="mx-lesson" lang={lang === "uz" ? "uz-Latn" : "ru"}>
          <div className="mx-cap">
            {lt(lang, "ls.lesson")} · {lt(lang, "ls.level", { l: p.level })} · {lt(lang, "ls.min", { n: p.duration_min })}
          </div>
          <div className="mx-card" data-testid="lesson-pv-card">
            <span className="mx-pill">{lt(lang, p.kind === "core" ? "ls.core" : "ls.optional")}</span>
            <Maybe text={p.title[lang]} lang={lang} className="mx-t" />
            <div className="mx-sub">{lt(lang, "ls.goal")}</div>
            <Maybe text={p.goal[lang]} lang={lang} className="mx-text" />
          </div>
          <div className="mx-sec-h">{lt(lang, "ls.stages")}</div>
          <ol className="mx-stages">
            {p.stages.map((s, i) => (
              <li key={i}>
                <span className="mx-dot" aria-hidden="true" />
                <span className="grow">
                  <b>{lt(lang, `ls.st.${s.type}`)}</b>
                  <Maybe text={s.instructions[lang]} lang={lang} className="mx-text block" />
                </span>
                <span className="mx-sub">{lt(lang, "ls.min", { n: s.minutes })}</span>
              </li>
            ))}
          </ol>
          {total !== p.duration_min && <div className="pv-empty">{t("le.sum", { s: total, d: p.duration_min })}</div>}
          {p.key_words.length > 0 && (
            <>
              <div className="mx-sec-h">{lt(lang, "ls.words")}</div>
              <div className="mx-words">
                {p.key_words.map((k, i) => (
                  <span key={i} className="mx-word">
                    <b lang="en">{k.en}</b> <Maybe text={k.gloss[lang]} lang={lang} />
                  </span>
                ))}
              </div>
            </>
          )}
          {p.examples.length > 0 && (
            <>
              <div className="mx-sec-h">{lt(lang, "ls.examples")}</div>
              {p.examples.slice(0, 3).map((x, i) => (
                <div key={i} className="mx-ex">
                  <b lang="en">{x.en}</b>
                  <Maybe text={x.gloss[lang]} lang={lang} className="mx-text block" />
                </div>
              ))}
            </>
          )}
          <span className="mx-btn">{lt(lang, "ls.start")}</span>
        </div>
      </Phone>
      <p className="xs muted">{t("le.previewNote")}</p>
    </div>
  );
}
