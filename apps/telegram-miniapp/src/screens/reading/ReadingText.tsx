import type { DictionaryCard, ReadingView, WordGloss } from "@tilhero/contracts/bff";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, errorText } from "../../api/errors";
import { readingRef, sentencePieces, sentenceTarget, type Piece, type PronunciationAccess } from "../../domain/memory";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp } from "../../state/app";
import { useAction } from "../../state/hooks";
import { keyForDraft, type DraftKey } from "../../state/idempotency";
import { haptic } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Btn, cx, ErrorLine, Skeleton } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import { GlossSourceNote, SpeakButton } from "../memory/parts";
import { PronounceBlock, PronounceSheet } from "../memory/Pronounce";

type Sentence = ReadingView["paragraphs"][number]["sentences"][number];
type Picked = { sentence: Sentence; text: string; term: number | null };

/**
 * A reading text (AT-57): sentences, glossary words highlighted (a marker AND a dotted underline — not colour alone),
 * every word of the text can be tapped → a bottom sheet with the translation (POST /v1/memory/translate with the
 * ContentRef of the sentence: the course dictionary, or an AI translation marked «проверяется методистом»; none — the
 * translation of the sentence), «В словарь», the sound; a button after each sentence — its sound, its translation and
 * «Произнести». Only words of the published text are ever sent: there is no free input here.
 */
export function ReadingText({ reading, access, onCardsChanged }: { reading: ReadingView; access: PronunciationAccess; onCardsChanged?: () => void }) {
  const { session } = useApp();
  const { t } = useI18n();
  const kid = session.learner.kind === "child";
  const [picked, setPicked] = useState<Picked | null>(null);
  const [sentence, setSentence] = useState<Sentence | null>(null);
  const [pron, setPron] = useState<Sentence | null>(null);
  const [added, setAdded] = useState<Record<string, string>>({});
  const pieces = useMemo(
    () => new Map(reading.paragraphs.flatMap((p) => p.sentences.map((s) => [s.s_id, sentencePieces(s.text_en, reading.glossary)] as const))),
    [reading],
  );
  let n = 0;
  return (
    <>
      <div className={cx("rd-text", kid && "kid")} lang="en" data-testid="rd-text">
        {reading.paragraphs.map((p) => (
          <p key={p.p_id} className="rd-p">
            {p.sentences.map((s) => {
              n += 1;
              const no = n;
              return (
                <span key={s.s_id} className="rd-s" data-testid={`rd-s-${s.s_id}`}>
                  {glue(pieces.get(s.s_id) ?? []).map((g, i) => {
                    const word = g.word;
                    const button = word ? (
                      <button
                        type="button"
                        className={cx("rw", word.term !== null && "hl term")}
                        onClick={() => {
                          haptic.selection();
                          setPicked({ sentence: s, text: word.text, term: word.term });
                        }}
                        data-testid={`rw-${s.s_id}-${word.text.toLowerCase().replace(/[^a-z]+/g, "_")}`}
                      >
                        {word.text}
                      </button>
                    ) : null;
                    const act = g.last ? (
                      <button type="button" className="s-act" onClick={() => setSentence(s)} aria-label={t("rd.sentenceAria", { n: no })} data-testid={`rd-s-act-${s.s_id}`} lang="ru">
                        <Icon name="volume" size={16} />
                      </button>
                    ) : null;
                    // a word, the punctuation right after it (and the sentence button at the end) never break apart
                    const lead = /\S*$/.exec(g.before)![0];
                    return (
                      <span key={i}>
                        {g.before.slice(0, g.before.length - lead.length)}
                        <span className="nw">
                          {lead}
                          {button}
                          {g.punct}
                          {act}
                        </span>
                        {g.after}
                      </span>
                    );
                  })}{" "}
                </span>
              );
            })}
          </p>
        ))}
      </div>
      {picked ? (
        <WordSheet
          reading={reading}
          picked={picked}
          access={access}
          known={added}
          onAdded={(text, card) => {
            setAdded((a) => ({ ...a, [text.toLowerCase()]: card.card_id }));
            onCardsChanged?.();
          }}
          onClose={() => setPicked(null)}
        />
      ) : null}
      {sentence ? (
        <SentenceSheet
          reading={reading}
          sentence={sentence}
          access={access}
          onClose={() => setSentence(null)}
          onRecord={() => {
            setSentence(null);
            setPron(sentence);
          }}
        />
      ) : null}
      {pron ? (
        <PronounceSheet target={sentenceTarget(readingRef(reading, pron.s_id))} text={pron.text_en} voice={reading.voice} kid={kid} onClose={() => setPron(null)} />
      ) : null}
    </>
  );
}

/** Pieces regrouped for line breaking: text before a word, the word, the punctuation glued to it, the rest. */
function glue(pieces: Piece[]): Array<{ before: string; word: Extract<Piece, { kind: "word" }> | null; punct: string; after: string; last: boolean }> {
  const out: Array<{ before: string; word: Extract<Piece, { kind: "word" }> | null; punct: string; after: string; last: boolean }> = [];
  let before = "";
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (p.kind === "text") {
      before += p.text;
      continue;
    }
    const next = pieces[i + 1];
    let punct = "";
    let after = "";
    if (next?.kind === "text") {
      const m = /^\S*/.exec(next.text)!;
      punct = m[0];
      after = next.text.slice(punct.length);
      i += 1;
    }
    out.push({ before, word: p, punct, after: "", last: false });
    before = after;
  }
  if (out.length) {
    const lastG = out[out.length - 1]!;
    lastG.after = before;
    lastG.last = true;
  } else out.push({ before, word: null, punct: "", after: "", last: true });
  return out;
}

/** The word: its translation (course dictionary → AI), «В словарь», and the sentence it stands in. */
function WordSheet(props: { reading: ReadingView; picked: Picked; access: PronunciationAccess; known: Record<string, string>; onAdded: (text: string, c: DictionaryCard) => void; onClose: () => void }) {
  const { bff, nav, session } = useApp();
  const { t, l, fmt } = useI18n();
  const kid = session.learner.kind === "child";
  const { reading, picked } = props;
  const term = picked.term !== null ? reading.glossary[picked.term] ?? null : null;
  const [gloss, setGloss] = useState<WordGloss | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [showSentence, setShowSentence] = useState(false);
  const key = useRef<DraftKey | null>(null);
  const ref = readingRef(reading, picked.sentence.s_id);
  const load = async () => {
    setLoading(true);
    setFailed(null);
    try {
      setGloss(await bff.translate({ text: picked.text.slice(0, 60), content: ref }));
    } catch (e) {
      setFailed(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const inDict = gloss?.in_dictionary ?? props.known[picked.text.toLowerCase()] ?? (term?.in_dictionary || null);
  const add = useAction(async () => {
    key.current = keyForDraft(key.current, { s: picked.sentence.s_id, w: picked.text });
    const card = await bff.addCard({ text_en: picked.text.slice(0, 120), source: ref }, key.current.key);
    props.onAdded(picked.text, card);
    setGloss((g) => (g ? { ...g, in_dictionary: card.card_id } : g));
    haptic.notify("success");
    showToast(t("rd.added"));
  });
  // shown at once from the glossary of the text while the server answers
  const shownGloss = gloss ? gloss.gloss : term ? term.gloss : null;
  const noGloss = !!gloss && gloss.gloss === null;
  const notInContent = failed instanceof ApiError && failed.code === "WORD_NOT_IN_CONTENT";

  return (
    <Sheet title={picked.text} cap={t("rd.word")} hideTitle onClose={props.onClose} testId="rd-word-sheet">
      <div className="stack">
        <div className="stack tight">
          <div className="hrow between">
            <p className="rd-word" lang="en" data-testid="rd-word">{picked.text}</p>
            <SpeakButton text={picked.text} voice={reading.voice} kid={kid} testId="rd-word-listen" />
          </div>
          {gloss?.lemma || gloss?.part_of_speech ? (
            <p className="sub small" data-testid="rd-lemma">
              {[gloss.lemma && gloss.lemma.toLowerCase() !== picked.text.toLowerCase() ? gloss.lemma : null, gloss.part_of_speech ? t(`rd.pos.${gloss.part_of_speech}` as MessageKey) : null].filter(Boolean).join(" · ")}
            </p>
          ) : null}
          {loading && !shownGloss ? <Skeleton lines={1} /> : null}
          {shownGloss ? <p className="rd-gloss" data-testid="rd-gloss">{l(shownGloss)}</p> : null}
          {gloss && gloss.gloss ? <GlossSourceNote source={gloss.source} unreviewed={gloss.ai_unreviewed} /> : !gloss && term ? <GlossSourceNote source="course" /> : null}
          {gloss?.note ? <p className="sub small" data-testid="rd-note">{l(gloss.note)}</p> : !gloss && term?.note ? <p className="sub small">{l(term.note)}</p> : null}
          {noGloss ? (
            <div className="card warn stack tight" data-testid="rd-no-gloss" role="status">
              <p className="sub ink">{t("rd.noGloss")}</p>
              <p className="sub ink" data-testid="rd-sentence-gloss">{l(picked.sentence.gloss)}</p>
            </div>
          ) : null}
          {failed && !gloss ? (
            notInContent ? (
              <p className="sub" data-testid="rd-not-in-content">{t("err.WORD_NOT_IN_CONTENT")}</p>
            ) : (
              <div className="stack tight" data-testid="rd-gloss-error">
                <ErrorLine text={errorText(failed, t, fmt.mmss)} />
                <Btn variant="secondary" onClick={() => void load()}>{t("c.retry")}</Btn>
              </div>
            )
          ) : null}
        </div>

        {shownGloss && !noGloss ? (
          inDict ? (
            <div className="hrow between" data-testid="rd-in-dict">
              <span className="sub ink hrow"><Icon name="check" size={18} />{t("rd.inDict")}</span>
              <Btn
                variant="link"
                onClick={() => {
                  props.onClose();
                  nav.push({ name: "card", id: inDict });
                }}
                data-testid="rd-open-card"
              >
                {t("rd.openCard")}
              </Btn>
            </div>
          ) : (
            <>
              <ErrorLine text={add.error} />
              <Btn busy={add.busy} disabled={loading} onClick={() => void add.run()} data-testid="rd-add">
                <Icon name="plus" size={18} />
                {t("rd.add")}
              </Btn>
            </>
          )
        ) : null}

        <section className="card stack tight" aria-labelledby="rd-ws-s">
          <h3 className="sec" id="rd-ws-s">{t("rd.sentence")}</h3>
          <p className="line-en" lang="en">{picked.sentence.text_en}</p>
          <div className="rd-acts">
            <SpeakButton text={picked.sentence.text_en} voice={reading.voice} kid={kid} label={t("rd.listenSentence")} testId="rd-ws-listen" />
            {!noGloss ? (
              <Btn variant="link" aria-expanded={showSentence} onClick={() => setShowSentence(!showSentence)} data-testid="rd-ws-translate">
                {showSentence ? t("rd.hideTranslation") : t("rd.translateSentence")}
              </Btn>
            ) : null}
          </div>
          {showSentence ? <p className="sub ink" data-testid="rd-ws-gloss">{l(picked.sentence.gloss)}</p> : null}
        </section>
      </div>
    </Sheet>
  );
}

/** The sentence: its sound, its translation, «Произнести». */
function SentenceSheet({ reading, sentence, access, onClose, onRecord }: { reading: ReadingView; sentence: Sentence; access: PronunciationAccess; onClose: () => void; onRecord: () => void }) {
  const { session } = useApp();
  const { t, l } = useI18n();
  const kid = session.learner.kind === "child";
  const [show, setShow] = useState(false);
  return (
    <Sheet title={t("rd.sentence")} onClose={onClose} testId="rd-sentence-sheet">
      <div className="stack">
        <p className="rd-sentence" lang="en" data-testid="rd-sentence">{sentence.text_en}</p>
        <div className="rd-acts">
          <SpeakButton text={sentence.text_en} voice={reading.voice} kid={kid} label={t("rd.listenSentence")} testId="rd-s-listen" />
          <Btn variant="link" aria-expanded={show} onClick={() => setShow(!show)} data-testid="rd-s-translate">
            {show ? t("rd.hideTranslation") : t("rd.translateSentence")}
          </Btn>
        </div>
        {show ? <p className="sub ink" data-testid="rd-s-gloss">{l(sentence.gloss)}</p> : null}
        <PronounceBlock access={access} target={sentenceTarget(readingRef(reading, sentence.s_id))} text={sentence.text_en} voice={reading.voice} testId="rd-pron" onRecord={onRecord} />
      </div>
    </Sheet>
  );
}
