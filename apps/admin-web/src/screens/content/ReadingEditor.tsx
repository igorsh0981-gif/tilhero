/**
 * Reading text editor (ReadingPayload, sprint 5, INTERNAL_API §2.1, AT-57/60): title RU/UZ, level, audience (a child
 * text is for kids only), topics, up to 3 skills, voice and minutes; paragraphs of sentences with their RU/UZ
 * translation (add, move, remove — s_id stays stable between versions); the glossary with the occurrence in the text
 * highlighted; comprehension questions of three types with their key. A live word counter and the rules of the catalog
 * (60–250 words, ≤ 30 words in a sentence, every glossary word in the text) are shown all the time; the catalog's own
 * codes (READING_WORDS, SENTENCE_TOO_LONG, GLOSSARY_NOT_IN_TEXT, TEXT_TOO_LONG, …) land at the fields by path. The
 * learner preview is the reading screen of the Mini App in RU/UZ (tap on a highlighted word → its translation).
 */
import { Fragment, useMemo, useState } from "react";
import type { AudienceSegment, Localized, ReadingPayload, ReadingQuestion } from "@tilhero/contracts/content";
import type { UiLang } from "@tilhero/contracts/admin";
import { useI18n, type MessageKey } from "../../i18n";
import { lt } from "../../i18n/learner";
import { Icon } from "../../ui/Icon";
import { Btn, cx, Pill } from "../../ui/kit";
import { Maybe, Phone, PreviewControls } from "../news/parts";
import { AddBtn, CountPill } from "./LessonEditor";
import { CheckGroup, ItemHead, LocField, moveIn, NumField, PathIssues, RefList, removeAt, Sec, SelectField, setAt, TextField, useEd } from "./fields";
import { answerText, AUDIENCES, BANDS, L, nextId, READING, READING_QUESTION_TYPES, splitAnswers, TOPICS, VOICES } from "./model";
import { useRefs } from "./refs";
import { highlight, occurrences, readingWords, wordCount } from "./text";
import type { EditorProps } from "./Workspace";

type P = ReadingPayload;
type Q = ReadingQuestion;

/** Audience of a reading text: choosing «kids» leaves kids only; choosing teens/adults drops kids (KIDS_CONTENT). */
export function nextAudience(prev: readonly AudienceSegment[], next: AudienceSegment[]): AudienceSegment[] {
  const addedKids = next.includes("kids") && !prev.includes("kids");
  if (addedKids) return ["kids"];
  if (next.includes("kids") && next.length > 1) return next.filter((a) => a !== "kids");
  return next;
}

/** Options and answer of a question when its type changes. */
export function retypeQuestion(q: Q, type: Q["type"]): Q {
  if (type === q.type) return q;
  if (type === "true_false") return { ...q, type, options: ["True", "False"], answer: 0 };
  if (type === "gap_fill") return { ...q, type, options: [], answer: [] };
  const opts = q.type === "single_choice" ? q.options : ["", "", ""];
  return { ...q, type, options: opts, answer: 0 };
}

export function ReadingEditor({ payload: p, set, goTo }: EditorProps<P>) {
  const { t } = useI18n();
  const refs = useRefs();
  const up = <K extends keyof P>(k: K, v: P[K]) => set((x) => ({ ...x, [k]: v }));
  const sids = p.paragraphs.flatMap((x) => x.sentences.map((s) => s.s_id));
  const setPara = (i: number, sentences: P["paragraphs"][number]["sentences"]) => up("paragraphs", setAt(p.paragraphs, i, { ...p.paragraphs[i]!, sentences }));
  return (
    <div className="ed" data-testid="reading-editor">
      <Sec path="payload" title={t("rd.basics")}>
        <div className="form-grid">
          <LocField path="payload.title" label={t("rd.title")} value={p.title} max={120} onChange={(v) => up("title", v)} testId="rd-title" />
          <SelectField path="payload.level" label={t("le.level")} value={p.level} options={BANDS.map((b) => ({ v: b, label: b }))} onChange={(v) => up("level", v)} testId="rd-level" />
          <SelectField path="payload.voice" label={t("rd.voice")} value={p.voice} options={VOICES.map((v) => ({ v, label: t(`rd.voice.${v}` as MessageKey) }))} onChange={(v) => up("voice", v)} hint={t("rd.voiceHint")} />
          <NumField path="payload.est_minutes" label={t("rd.minutes")} value={p.est_minutes} min={READING.minutesMin} max={READING.minutesMax} suffix={t("rd.minutesSuffix")} onChange={(v) => up("est_minutes", v)} testId="rd-minutes" />
          <CheckGroup path="payload.audience" label={t("ct.audience")} values={p.audience} options={AUDIENCES.map((a) => ({ v: a, label: t(`ageseg.${a}`) }))} onChange={(v) => up("audience", nextAudience(p.audience, v))} required testId="rd-aud" />
          <CheckGroup className="span-2" path="payload.topics" label={t("ct.topics")} values={p.topics} options={TOPICS.map((x) => ({ v: x, label: t(`topic.${x}` as MessageKey) }))} onChange={(v) => up("topics", v)} />
          <RefList path="payload.skill_ids" label={t("rd.skills")} values={p.skill_ids} options={refs.options("skill")} max={READING.skillsMax} onChange={(v) => up("skill_ids", v)} hint={t("rd.skillsHint")} testId="rd-skills" />
        </div>
        <p className="xs muted row" data-testid="rd-kids-note">
          <Icon name="shield" /> {p.audience.includes("kids") ? t("rd.kidsOn") : t("rd.kidsRule")}
        </p>
      </Sec>

      <RulesPanel p={p} goTo={goTo} />

      <Sec
        path="payload.paragraphs"
        title={t("rd.text")}
        testId="rd-text"
        sub={t("rd.textHint")}
        aside={<WordsPill n={readingWords(p)} />}
      >
        {p.paragraphs.map((para, i) => (
          <div key={`${para.p_id}-${i}`} className="item rd-para" data-path={`payload.paragraphs[${i}]`} data-testid={`rd-para-${i}`}>
            <ItemHead
              n={i + 1}
              title={t("rd.paragraph", { id: para.p_id })}
              onUp={i > 0 ? () => up("paragraphs", moveIn(p.paragraphs, i, -1)) : undefined}
              onDown={i < p.paragraphs.length - 1 ? () => up("paragraphs", moveIn(p.paragraphs, i, 1)) : undefined}
              onRemove={p.paragraphs.length > 1 ? () => up("paragraphs", removeAt(p.paragraphs, i)) : undefined}
              removeLabel={t("rd.removeParagraph", { n: i + 1 })}
              testId={`rd-para-rm-${i}`}
            />
            <PathIssues path={`payload.paragraphs[${i}]`} />
            <PathIssues path={`payload.paragraphs[${i}].sentences`} />
            <ol className="rd-sentences">
              {para.sentences.map((s, j) => (
                <SentenceRow
                  key={`${s.s_id}-${j}`}
                  i={i}
                  j={j}
                  s={s}
                  n={para.sentences.length}
                  onChange={(v) => setPara(i, setAt(para.sentences, j, v))}
                  onMove={(d) => setPara(i, moveIn(para.sentences, j, d))}
                  onRemove={para.sentences.length > 1 ? () => setPara(i, removeAt(para.sentences, j)) : undefined}
                />
              ))}
            </ol>
            <AddBtn label={t("rd.addSentence")} disabled={para.sentences.length >= READING.sentencesMax} onClick={() => setPara(i, [...para.sentences, { s_id: nextId("s", sids), text_en: "", gloss: L() }])} testId={`rd-add-s-${i}`} />
          </div>
        ))}
        <AddBtn
          label={t("rd.addParagraph")}
          disabled={p.paragraphs.length >= READING.paragraphsMax}
          onClick={() => up("paragraphs", [...p.paragraphs, { p_id: nextId("p", p.paragraphs.map((x) => x.p_id)), sentences: [{ s_id: nextId("s", sids), text_en: "", gloss: L() }] }])}
          testId="rd-add-p"
        />
      </Sec>

      <GlossaryBlock p={p} set={up} />

      <Sec path="payload.questions" title={t("rd.questions")} aside={<CountPill n={p.questions.length} lo={READING.questionsMin} hi={READING.questionsMax} />} sub={t("rd.questionsHint")} testId="rd-questions">
        {p.questions.map((q, i) => (
          <QuestionEditor
            key={i}
            i={i}
            q={q}
            n={p.questions.length}
            onChange={(v) => up("questions", setAt(p.questions, i, v))}
            onRemove={() => up("questions", removeAt(p.questions, i))}
            onMove={(d) => up("questions", moveIn(p.questions, i, d))}
          />
        ))}
        <AddBtn
          label={t("rd.addQuestion")}
          disabled={p.questions.length >= READING.questionsMax}
          onClick={() => up("questions", [...p.questions, { question_id: nextId("q", p.questions.map((q) => q.question_id)), type: "single_choice", instruction: L(), prompt_en: "", options: ["", "", ""], answer: 0 }])}
          testId="rd-add-q"
        />
      </Sec>
    </div>
  );
}

function WordsPill({ n }: { n: number }) {
  const { t } = useI18n();
  const ok = n >= READING.wordsMin && n <= READING.wordsMax;
  return (
    <Pill tone={ok ? "good" : "bad"} testId="rd-words">
      {!ok && <Icon name="alert" />}
      {t("rd.wordsN", { n, lo: READING.wordsMin, hi: READING.wordsMax })}
    </Pill>
  );
}

/* ---------------------------------------------------------------- rules (always visible, text + icon, not colour alone) */

function RulesPanel({ p, goTo }: { p: P; goTo: (path: string) => void }) {
  const { t } = useI18n();
  const words = readingWords(p);
  const long: Array<{ path: string; id: string; n: number }> = [];
  p.paragraphs.forEach((para, i) =>
    para.sentences.forEach((s, j) => {
      const n = wordCount(s.text_en);
      if (n > READING.sentenceWordsMax) long.push({ path: `payload.paragraphs[${i}].sentences[${j}].text_en`, id: s.s_id, n });
    }),
  );
  const missing = p.glossary.map((g, i) => ({ g, i })).filter(({ g }) => g.en.trim() && !occurrences(p, g.en).length);
  const rows: Array<{ id: string; ok: boolean; text: string; go?: Array<{ path: string; label: string }> }> = [
    { id: "words", ok: words >= READING.wordsMin && words <= READING.wordsMax, text: words < READING.wordsMin ? t("rd.rule.wordsLow", { n: words, lo: READING.wordsMin }) : words > READING.wordsMax ? t("rd.rule.wordsHigh", { n: words, hi: READING.wordsMax }) : t("rd.rule.wordsOk", { n: words }) },
    { id: "sentences", ok: !long.length, text: long.length ? t("rd.rule.long", { n: long.length, max: READING.sentenceWordsMax }) : t("rd.rule.longOk", { max: READING.sentenceWordsMax }), go: long.map((x) => ({ path: x.path, label: t("rd.rule.sentence", { id: x.id, n: x.n }) })) },
    { id: "glossary", ok: !missing.length, text: missing.length ? t("rd.rule.notInText", { n: missing.length }) : t("rd.rule.inText"), go: missing.map(({ g, i }) => ({ path: `payload.glossary[${i}].en`, label: g.en })) },
    { id: "glossaryCount", ok: p.glossary.length >= READING.glossaryMin && p.glossary.length <= READING.glossaryMax, text: t("rd.rule.glossaryCount", { n: p.glossary.length, lo: READING.glossaryMin, hi: READING.glossaryMax }) },
    { id: "questions", ok: p.questions.length >= READING.questionsMin && p.questions.length <= READING.questionsMax, text: t("rd.rule.questions", { n: p.questions.length, lo: READING.questionsMin, hi: READING.questionsMax }) },
  ];
  return (
    <section className="rd-rules" aria-labelledby="rd-rules-h" data-testid="rd-rules">
      <h3 className="h3" id="rd-rules-h">
        {t("rd.rules")}
      </h3>
      <ul className="rd-rule-list">
        {rows.map((r) => (
          <li key={r.id} className={cx("rd-rule", r.ok ? "is-ok" : "is-bad")} data-testid={`rd-rule-${r.id}`} data-ok={String(r.ok)}>
            <Icon name={r.ok ? "checkCircle" : "alert"} />
            <span className="grow">
              <span className="sr-only">{r.ok ? t("rd.rule.okSr") : t("rd.rule.badSr")}</span>
              {r.text}
              {!!r.go?.length && (
                <span className="rd-rule-go">
                  {r.go.slice(0, 8).map((g) => (
                    <button key={g.path} type="button" className="chip-ref link-btn" onClick={() => goTo(g.path)} data-testid={`rd-go-${g.path}`}>
                      {g.label}
                    </button>
                  ))}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------------------------------------------------------- sentence */

function SentenceRow({ i, j, s, n, onChange, onMove, onRemove }: { i: number; j: number; s: P["paragraphs"][number]["sentences"][number]; n: number; onChange: (v: typeof s) => void; onMove: (d: number) => void; onRemove?: () => void }) {
  const { t } = useI18n();
  const { editable } = useEd();
  const path = `payload.paragraphs[${i}].sentences[${j}]`;
  const words = wordCount(s.text_en);
  const long = words > READING.sentenceWordsMax;
  return (
    <li className="rd-sentence" data-path={path} data-testid={`rd-s-${i}-${j}`}>
      <div className="item-h">
        <span className="mono xs rd-sid" title={t("rd.sid")}>
          {s.s_id}
        </span>
        <span className={cx("xs", long ? "bad-ink b" : "muted")} data-testid={`rd-s-words-${i}-${j}`}>
          {long && <Icon name="alert" />} {t("rd.sentenceWords", { n: words, max: READING.sentenceWordsMax })}
        </span>
        <span className="grow" />
        {editable && <Btn size="xs" kind="ghost" icon="up" aria={t("rd.sentenceUp", { id: s.s_id })} disabled={j === 0} onClick={() => onMove(-1)} />}
        {editable && <Btn size="xs" kind="ghost" icon="down" aria={t("rd.sentenceDown", { id: s.s_id })} disabled={j === n - 1} onClick={() => onMove(1)} />}
        {editable && onRemove && <Btn size="xs" kind="ghost" icon="x" aria={t("rd.removeSentence", { id: s.s_id })} onClick={onRemove} testId={`rd-s-rm-${i}-${j}`} />}
      </div>
      <PathIssues path={`${path}.s_id`} />
      <TextField path={`${path}.text_en`} label={t("rd.sentenceEn")} value={s.text_en} max={READING.sentenceMax} required multiline rows={2} onChange={(v) => onChange({ ...s, text_en: v })} testId={`rd-en-${i}-${j}`} />
      <LocField path={`${path}.gloss`} label={t("rd.sentenceGloss")} value={s.gloss} max={400} multiline rows={2} onChange={(v: Localized) => onChange({ ...s, gloss: v })} testId={`rd-gl-${i}-${j}`} />
    </li>
  );
}

/* ---------------------------------------------------------------- glossary with highlighting */

function GlossaryBlock({ p, set }: { p: P; set: <K extends keyof P>(k: K, v: P[K]) => void }) {
  const { t } = useI18n();
  const { editable } = useEd();
  const [hot, setHot] = useState<number | null>(null);
  const items = p.glossary.map((g) => g.en);
  const occ = useMemo(() => p.glossary.map((g) => (g.en.trim() ? occurrences(p, g.en) : [])), [p]);
  return (
    <Sec path="payload.glossary" title={t("rd.glossary")} aside={<CountPill n={p.glossary.length} lo={READING.glossaryMin} hi={READING.glossaryMax} />} sub={t("rd.glossaryHint")} testId="rd-glossary">
      <figure className="rd-hl" data-testid="rd-highlight">
        <figcaption className="field-label">{t("rd.hlTitle")}</figcaption>
        {p.paragraphs.map((para) => (
          <p key={para.p_id} className="rd-hl-p" lang="en">
            {para.sentences.map((s) => (
              <Fragment key={s.s_id}>
                {highlight(s.text_en, items).map((seg, k) =>
                  seg.item == null ? (
                    <Fragment key={k}>{seg.text}</Fragment>
                  ) : (
                    <mark key={k} className={cx("rd-mark", hot === seg.item && "is-hot")} title={p.glossary[seg.item]?.gloss.ru || undefined} data-item={seg.item}>
                      {seg.text}
                    </mark>
                  ),
                )}{" "}
              </Fragment>
            ))}
          </p>
        ))}
        <p className="xs muted">{t("rd.hlNote")}</p>
      </figure>
      {p.glossary.map((g, i) => {
        const path = `payload.glossary[${i}]`;
        const found = occ[i] ?? [];
        return (
          <div key={i} className="item" data-path={path} data-testid={`rd-gi-${i}`} onFocus={() => setHot(i)} onBlur={() => setHot(null)}>
            <ItemHead
              n={i + 1}
              title={g.en || t("rd.word")}
              onUp={i > 0 ? () => set("glossary", moveIn(p.glossary, i, -1)) : undefined}
              onDown={i < p.glossary.length - 1 ? () => set("glossary", moveIn(p.glossary, i, 1)) : undefined}
              onRemove={() => set("glossary", removeAt(p.glossary, i))}
              removeLabel={t("ct.removeN", { n: i + 1 })}
            />
            <div className="form-grid">
              <TextField
                path={`${path}.en`}
                label={t("rd.wordEn")}
                value={g.en}
                max={60}
                required
                onChange={(v) => set("glossary", setAt(p.glossary, i, { ...g, en: v }))}
                testId={`rd-gi-en-${i}`}
                hint={
                  !g.en.trim() ? undefined : found.length ? (
                    <span className="good-ink row nowrap-row" data-testid={`rd-gi-found-${i}`}>
                      <Icon name="checkCircle" /> {t("rd.foundIn", { ids: found.join(", ") })}
                    </span>
                  ) : (
                    <span className="bad-ink b row nowrap-row" data-testid={`rd-gi-missing-${i}`}>
                      <Icon name="alert" /> {t("rd.notFound")}
                    </span>
                  )
                }
              />
              <LocField path={`${path}.gloss`} label={t("rd.wordGloss")} value={g.gloss} max={READING.glossMax} onChange={(v) => set("glossary", setAt(p.glossary, i, { ...g, gloss: v }))} testId={`rd-gi-gl-${i}`} />
            </div>
            {g.note ? (
              <div className="stack sm">
                <LocField path={`${path}.note`} label={t("rd.note")} value={g.note} max={READING.noteMax} multiline onChange={(v) => set("glossary", setAt(p.glossary, i, { ...g, note: v }))} hint={t("rd.noteHint")} />
                {editable && <Btn size="xs" kind="ghost" icon="x" className="rd-self-start" label={t("rd.noteRemove")} onClick={() => set("glossary", setAt(p.glossary, i, { ...g, note: null }))} />}
              </div>
            ) : (
              editable && <Btn size="xs" icon="plus" className="rd-self-start" label={t("rd.noteAdd")} onClick={() => set("glossary", setAt(p.glossary, i, { ...g, note: L() }))} testId={`rd-gi-note-${i}`} />
            )}
          </div>
        );
      })}
      <AddBtn label={t("rd.addWord")} disabled={p.glossary.length >= READING.glossaryMax} onClick={() => set("glossary", [...p.glossary, { en: "", gloss: L(), note: null }])} testId="rd-add-word" />
    </Sec>
  );
}

/* ---------------------------------------------------------------- question */

function QuestionEditor({ i, q, n, onChange, onRemove, onMove }: { i: number; q: Q; n: number; onChange: (v: Q) => void; onRemove: () => void; onMove: (d: number) => void }) {
  const { t } = useI18n();
  const { editable } = useEd();
  const path = `payload.questions[${i}]`;
  return (
    <div className="item" data-path={path} data-testid={`rd-q-${i}`}>
      <ItemHead n={i + 1} title={`${q.question_id} · ${t(`rdq.${q.type}` as MessageKey)}`} onUp={i > 0 ? () => onMove(-1) : undefined} onDown={i < n - 1 ? () => onMove(1) : undefined} onRemove={onRemove} removeLabel={t("ct.removeN", { n: i + 1 })} />
      <div className="form-grid">
        <TextField path={`${path}.question_id`} label={t("rd.questionId")} value={q.question_id} mono max={64} onChange={(v) => onChange({ ...q, question_id: v })} />
        <SelectField path={`${path}.type`} label={t("rd.questionType")} value={q.type} options={READING_QUESTION_TYPES.map((x) => ({ v: x, label: t(`rdq.${x}` as MessageKey) }))} onChange={(v) => onChange(retypeQuestion(q, v))} testId={`rd-q-type-${i}`} />
        <LocField path={`${path}.instruction`} label={t("le.instruction")} value={q.instruction} max={200} onChange={(v) => onChange({ ...q, instruction: v })} testId={`rd-q-ins-${i}`} />
        <TextField path={`${path}.prompt_en`} label={t("rd.prompt")} value={q.prompt_en} max={200} required onChange={(v) => onChange({ ...q, prompt_en: v })} testId={`rd-q-prompt-${i}`} hint={q.type === "gap_fill" ? t("le.gapHint") : q.type === "true_false" ? t("rd.tfHint") : undefined} />
      </div>
      {q.type !== "gap_fill" && (
        <fieldset className="field fs" data-path={`${path}.options`}>
          <legend className="field-label">{q.type === "true_false" ? t("rd.tfAnswer") : t("le.options")}</legend>
          <ol className="opt-list">
            {q.options.map((o, j) => (
              <li key={j} className={cx("opt", q.answer === j && "is-key")}>
                <label className="check" title={t("le.correct")}>
                  <input type="radio" name={`rd-ans-${i}`} checked={q.answer === j} disabled={!editable} onChange={() => onChange({ ...q, answer: j })} aria-label={t("le.correctN", { x: q.type === "true_false" ? o : String.fromCharCode(65 + j) })} data-path={`${path}.answer`} data-testid={`rd-ans-${i}-${j}`} />
                  <span className="mono">{String.fromCharCode(65 + j)}</span>
                </label>
                {q.type === "true_false" ? (
                  <span className="mono small">{o}</span>
                ) : (
                  <input className="input" value={o} disabled={!editable} lang="en" aria-label={t("le.optionN", { x: String.fromCharCode(65 + j) })} onChange={(e) => onChange({ ...q, options: setAt(q.options, j, e.target.value) })} data-testid={`rd-opt-${i}-${j}`} />
                )}
                {editable && q.type === "single_choice" && q.options.length > 3 && (
                  <Btn size="xs" kind="ghost" icon="x" aria={t("le.removeOption", { x: String.fromCharCode(65 + j) })} onClick={() => onChange({ ...q, options: removeAt(q.options, j), answer: typeof q.answer === "number" ? (q.answer === j ? 0 : q.answer > j ? q.answer - 1 : q.answer) : 0 })} />
                )}
              </li>
            ))}
          </ol>
          {editable && q.type === "single_choice" && q.options.length < 4 && <Btn size="xs" icon="plus" label={t("le.addOption")} onClick={() => onChange({ ...q, options: [...q.options, ""] })} testId={`rd-add-opt-${i}`} />}
          <PathIssues path={`${path}.options`} />
          <PathIssues path={`${path}.answer`} />
        </fieldset>
      )}
      {q.type === "gap_fill" && (
        <TextField path={`${path}.answer`} label={t("le.accepted")} value={Array.isArray(q.answer) ? q.answer.join(", ") : ""} max={200} hint={t("le.acceptedHint")} onChange={(v) => onChange({ ...q, answer: splitAnswers(v) })} testId={`rd-gap-${i}`} />
      )}
      <p className="xs key-line" data-testid={`rd-key-${i}`}>
        <b>{t("le.key")}</b> <span className="mono">{answerText(q.type, q.options, q.answer)}</span>
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- learner preview (Mini App reading screen) */

export function ReadingPreview({ payload: p }: { payload: P }) {
  const { t } = useI18n();
  const [lang, setLang] = useState<UiLang>("ru");
  const [dark, setDark] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [word, setWord] = useState<number | null>(null);
  const items = p.glossary.map((g) => g.en);
  const g = word != null ? p.glossary[word] : null;
  return (
    <div className="stack sm lesson-pv" data-testid="reading-preview">
      <div className="row between">
        <span className="field-label">{t("rd.previewT")}</span>
        <PreviewControls lang={lang} setLang={setLang} dark={dark} setDark={setDark} />
      </div>
      <Phone dark={dark} label={t("rd.previewLabel", { l: lang.toUpperCase() })} testId="reading-phone">
        <div className="mx-lesson" lang={lang === "uz" ? "uz-Latn" : "ru"}>
          <div className="mx-cap">
            {lt(lang, "rd.reading")} · {lt(lang, "ls.level", { l: p.level })} · {lt(lang, "ls.min", { n: p.est_minutes })} · {lt(lang, "rd.words", { n: readingWords(p) })}
          </div>
          <Maybe text={p.title[lang]} lang={lang} className="mx-t" />
          <div className="mx-sub">{lt(lang, "rd.tap")}</div>
          {p.paragraphs.map((para) => (
            <div key={para.p_id} className="mx-card rd-pv-para">
              <p className="rd-pv-text" lang="en">
                {para.sentences.map((s) => (
                  <Fragment key={s.s_id}>
                    {highlight(s.text_en, items).map((seg, k) =>
                      seg.item == null ? (
                        <Fragment key={k}>{seg.text}</Fragment>
                      ) : (
                        <button key={k} type="button" className="rd-pv-word" aria-pressed={word === seg.item} onClick={() => setWord(seg.item)} data-testid={`rd-pv-word-${seg.item}`}>
                          {seg.text}
                        </button>
                      ),
                    )}{" "}
                  </Fragment>
                ))}
              </p>
              <button type="button" className="mx-pill rd-pv-tr" aria-expanded={!!open[para.p_id]} onClick={() => setOpen((o) => ({ ...o, [para.p_id]: !o[para.p_id] }))} data-testid={`rd-pv-tr-${para.p_id}`}>
                {open[para.p_id] ? lt(lang, "rd.hide") : lt(lang, "rd.translate")}
              </button>
              {open[para.p_id] && (
                <p className="mx-text">
                  {para.sentences.map((s) => (
                    <Fragment key={s.s_id}>
                      <Maybe text={s.gloss[lang]} lang={lang} />{" "}
                    </Fragment>
                  ))}
                </p>
              )}
            </div>
          ))}
          {g && (
            <div className="mx-sheet rd-pv-sheet" role="dialog" aria-label={g.en} data-testid="rd-pv-sheet">
              <b lang="en">{g.en}</b>
              <Maybe text={g.gloss[lang]} lang={lang} className="mx-text block" />
              {g.note && <Maybe text={g.note[lang]} lang={lang} className="mx-sub block" />}
              <span className="row">
                <span className="mx-pill">{lt(lang, "rd.addDict")}</span>
                <span className="mx-pill">{lt(lang, "rd.listen")}</span>
                <button type="button" className="mx-pill" onClick={() => setWord(null)}>
                  {lt(lang, "rd.close")}
                </button>
              </span>
            </div>
          )}
          <div className="mx-sub">{lt(lang, "rd.questions", { n: p.questions.length })}</div>
          <span className="mx-btn">{lt(lang, "rd.start")}</span>
        </div>
      </Phone>
      <p className="xs muted">{t("rd.previewNote")}</p>
    </div>
  );
}
