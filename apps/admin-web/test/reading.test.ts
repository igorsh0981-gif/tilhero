/**
 * Sprint 5 «Контент → Чтение»: the word counter and the rules of a reading text mirror the catalog (services/catalog
 * domain/text.py + validation.py «reading»): 60–250 words, ≤ 30 words in a sentence (a hyphenated word is one),
 * every glossary word in the text by word boundaries, 3–20 glossary items, 3–8 questions of three types, kids only
 * alone, and the editor helpers (audience, question type, stable ids, highlighting).
 */
import { describe, expect, it } from "vitest";
import type { ReadingPayload } from "@tilhero/contracts/content";
import { emptyPayload, KEY_FIELD, KINDS, nextId, validatePayload, validateReading } from "../src/screens/content/model";
import { contains, formKey, highlight, normalizeForm, occurrences, readingWords, spans, tokens, wordCount } from "../src/screens/content/text";
import { nextAudience, retypeQuestion } from "../src/screens/content/ReadingEditor";

const L = (ru: string, uz: string) => ({ ru, uz });
const S = (s_id: string, text_en: string) => ({ s_id, text_en, gloss: L("перевод", "tarjima") });

function valid(): ReadingPayload {
  return {
    reading_id: "r-a1-coffee-shop",
    title: L("В кофейне", "Qahvaxonada"),
    level: "A1",
    audience: ["teens", "adults"],
    topics: ["food"],
    skill_ids: ["en.func.greet"],
    paragraphs: [
      { p_id: "p1", sentences: [S("s1", "Every morning Lola goes to a small coffee shop near her office."), S("s2", "She orders a large latte with milk and a warm croissant."), S("s3", "The barista knows her name and always smiles.")] },
      { p_id: "p2", sentences: [S("s4", "Today the coffee shop is very busy, so Lola waits in a long queue."), S("s5", "She pays by card and finds a free table by the window."), S("s6", "The coffee is hot and the music is quiet.")] },
    ],
    glossary: [
      { en: "coffee shop", gloss: L("кофейня", "qahvaxona"), note: null },
      { en: "Queue", gloss: L("очередь", "navbat"), note: L("line — в американском", "line — amerikacha") },
      { en: "barista", gloss: L("бариста", "barista"), note: null },
    ],
    questions: [
      { question_id: "q1", type: "single_choice", instruction: L("Выберите", "Tanlang"), prompt_en: "Where does Lola go?", options: ["A bakery", "A coffee shop", "A market"], answer: 1 },
      { question_id: "q2", type: "true_false", instruction: L("Верно?", "Toʻgʻrimi?"), prompt_en: "The shop is quiet.", options: ["True", "False"], answer: 1 },
      { question_id: "q3", type: "gap_fill", instruction: L("Впишите", "Yozing"), prompt_en: "Lola waits in a long ___.", options: [], answer: ["queue", "line"] },
    ],
    voice: "en-GB",
    est_minutes: 5,
  };
}
const codes = (p: ReadingPayload) => validateReading(p).map((i) => `${i.code}@${i.path}`);

describe("text of the content (catalog text.py)", () => {
  it("counts words by boundaries: a hyphenated word and a contraction are one word, punctuation is not a word", () => {
    expect(wordCount("I'm a well-known check-in clerk, aren't I?")).toBe(7);
    expect(wordCount("  Hello,   world! … ")).toBe(2);
    expect(wordCount("")).toBe(0);
    expect(wordCount("It’s 5 o’clock")).toBe(3);
  });
  it("tokens split on a hyphen; the form key ignores case and punctuation", () => {
    expect(tokens("Check-in, please!")).toEqual(["check", "in", "please"]);
    expect(formKey("Excuse me, where…")).toBe(formKey("excuse me where"));
  });
  it("contains: a run of whole words, case-insensitive; part of a word is not an occurrence", () => {
    expect(contains("Nice to meet you, Tom.", "meet you")).toBe(true);
    expect(contains("Nice to meet you, Tom.", "eet")).toBe(false);
    expect(contains("Lola waits in a long QUEUE.", "queue")).toBe(true);
    expect(contains("check-in desk", "check")).toBe(true);
    expect(contains("a bakery", "")).toBe(false);
  });
  it("normalizes a dictionary form like the catalog: lower case, apostrophe, no placeholder «…», no trailing , ; :", () => {
    expect(normalizeForm("  My name is …  ")).toBe("my name is");
    expect(normalizeForm("“Don’t worry!”")).toBe("don't worry");
    expect(normalizeForm("excuse me,")).toBe("excuse me");
  });
  it("spans and highlight keep the original text; a longer phrase wins over a shorter one", () => {
    const text = "She is very kind and kind of funny.";
    expect(spans(text, "kind")).toEqual([[12, 16], [21, 25]]);
    const segs = highlight(text, ["kind", "very kind"]);
    expect(segs.map((s) => s.text).join("")).toBe(text);
    expect(segs.filter((s) => s.item != null).map((s) => [s.text, s.item])).toEqual([
      ["very kind", 1],
      ["kind", 0],
    ]);
    expect(highlight("No glossary here.", [])).toEqual([{ text: "No glossary here.", item: null }]);
  });
  it("counts the words of a reading text and finds the sentences of a glossary item", () => {
    const p = valid();
    expect(readingWords(p)).toBe(66);
    expect(occurrences(p, "coffee shop")).toEqual(["s1", "s4"]);
    expect(occurrences(p, "bakery")).toEqual([]);
  });
});

describe("validateReading (the rules shown at the fields before the catalog answers)", () => {
  it("a valid text has no issues; reading is a content kind with the key reading_id", () => {
    expect(validateReading(valid())).toEqual([]);
    expect(KINDS).toContain("reading");
    expect(KEY_FIELD.reading).toBe("reading_id");
    expect(validatePayload("reading", valid())).toEqual([]);
  });
  it("READING_WORDS: fewer than 60 or more than 250 words", () => {
    const p = valid();
    p.paragraphs = [p.paragraphs[0]!];
    expect(codes(p)).toContain("READING_WORDS@payload.paragraphs");
    const big = valid();
    big.paragraphs = Array.from({ length: 8 }, (_, i) => ({ p_id: `p${i + 1}`, sentences: Array.from({ length: 2 }, (_, j) => S(`s${i * 2 + j + 1}`, "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen")) }));
    expect(readingWords(big)).toBe(256);
    expect(codes(big)).toContain("READING_WORDS@payload.paragraphs");
  });
  it("SENTENCE_TOO_LONG: a sentence of 31 words; 30 is fine", () => {
    const p = valid();
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    p.paragraphs[0]!.sentences[0] = S("s1", `${words(30)}.`);
    expect(codes(p)).not.toContain("SENTENCE_TOO_LONG@payload.paragraphs[0].sentences[0].text_en");
    p.paragraphs[0]!.sentences[0] = S("s1", `${words(31)}.`);
    expect(codes(p)).toContain("SENTENCE_TOO_LONG@payload.paragraphs[0].sentences[0].text_en");
  });
  it("GLOSSARY_NOT_IN_TEXT, DUPLICATE_ID of a glossary form and TEXT_TOO_LONG of a translation and a note", () => {
    const p = valid();
    p.glossary.push({ en: "bakery", gloss: L("пекарня", "novvoyxona"), note: null });
    p.glossary.push({ en: "COFFEE  shop", gloss: L("кофейня", "qahvaxona"), note: null });
    p.glossary[0]!.gloss.ru = "к".repeat(81);
    p.glossary[1]!.note = L("п".repeat(161), "note");
    expect(codes(p)).toEqual(
      expect.arrayContaining([
        "GLOSSARY_NOT_IN_TEXT@payload.glossary[3].en",
        "DUPLICATE_ID@payload.glossary[4].en",
        "TEXT_TOO_LONG@payload.glossary[0].gloss.ru",
        "TEXT_TOO_LONG@payload.glossary[1].note.ru",
      ]),
    );
  });
  it("counts: glossary 3..20, questions 3..8, minutes 3..15, skills ≤ 3, paragraphs and sentences 1..8", () => {
    const p = valid();
    p.glossary = p.glossary.slice(0, 2);
    p.questions = p.questions.slice(0, 2);
    p.est_minutes = 20;
    p.skill_ids = ["a1", "a2", "a3", "a4"];
    p.paragraphs[1]!.sentences = [];
    expect(codes(p)).toEqual(
      expect.arrayContaining([
        "COUNT_OUT_OF_RANGE@payload.glossary",
        "COUNT_OUT_OF_RANGE@payload.questions",
        "COUNT_OUT_OF_RANGE@payload.est_minutes",
        "COUNT_OUT_OF_RANGE@payload.skill_ids",
        "COUNT_OUT_OF_RANGE@payload.paragraphs[1].sentences",
      ]),
    );
  });
  it("questions: 3–4 distinct options with an index, True/False, accepted answers of a gap", () => {
    const p = valid();
    p.questions[0] = { ...p.questions[0]!, options: ["A", "A"], answer: 3 };
    p.questions[1] = { ...p.questions[1]!, options: ["Yes", "No"], answer: 2 };
    p.questions[2] = { ...p.questions[2]!, answer: [] };
    expect(codes(p)).toEqual(
      expect.arrayContaining([
        "ANSWER_INVALID@payload.questions[0].options",
        "ANSWER_INVALID@payload.questions[0].answer",
        "ANSWER_INVALID@payload.questions[1].options",
        "ANSWER_INVALID@payload.questions[1].answer",
        "ANSWER_INVALID@payload.questions[2].answer",
      ]),
    );
  });
  it("ids: duplicate and malformed sentence ids; translations RU/UZ of every sentence", () => {
    const p = valid();
    p.paragraphs[1]!.sentences[0]!.s_id = "s1";
    p.paragraphs[1]!.sentences[1]!.s_id = "S-5";
    p.paragraphs[1]!.sentences[2]!.gloss = L("", "Cyrillic ѐ");
    expect(codes(p)).toEqual(
      expect.arrayContaining([
        "DUPLICATE_ID@payload.paragraphs[1].sentences[0].s_id",
        "SCHEMA_INVALID@payload.paragraphs[1].sentences[1].s_id",
        "LOCALE_MISSING@payload.paragraphs[1].sentences[2].gloss.ru",
        "LOCALE_SCRIPT@payload.paragraphs[1].sentences[2].gloss.uz",
      ]),
    );
  });
  it("KIDS_CONTENT: a child text is for the kids audience only", () => {
    const p = valid();
    p.audience = ["kids", "teens"];
    expect(codes(p)).toContain("KIDS_CONTENT@payload.audience");
    p.audience = ["kids"];
    expect(codes(p)).not.toContain("KIDS_CONTENT@payload.audience");
  });
  it("an empty new text: one paragraph with one empty sentence — words, glossary and questions are flagged", () => {
    const p = emptyPayload("reading", "r-new") as unknown as ReadingPayload;
    expect(p.reading_id).toBe("r-new");
    expect(codes(p)).toEqual(expect.arrayContaining(["READING_WORDS@payload.paragraphs", "VALUE_REQUIRED@payload.paragraphs[0].sentences[0].text_en", "COUNT_OUT_OF_RANGE@payload.glossary", "COUNT_OUT_OF_RANGE@payload.questions"]));
  });
});

describe("editor helpers", () => {
  it("audience: choosing kids leaves kids only; choosing teens or adults drops kids", () => {
    expect(nextAudience(["teens", "adults"], ["teens", "adults", "kids"])).toEqual(["kids"]);
    expect(nextAudience(["kids"], ["kids", "adults"])).toEqual(["adults"]);
    expect(nextAudience(["teens"], ["teens", "adults"])).toEqual(["teens", "adults"]);
  });
  it("question type: options and answer follow the type", () => {
    const q = valid().questions[0]!;
    expect(retypeQuestion(q, "true_false")).toMatchObject({ type: "true_false", options: ["True", "False"], answer: 0 });
    expect(retypeQuestion(q, "gap_fill")).toMatchObject({ type: "gap_fill", options: [], answer: [] });
    expect(retypeQuestion({ ...q, type: "gap_fill", options: [], answer: ["x"] }, "single_choice")).toMatchObject({ options: ["", "", ""], answer: 0 });
    expect(retypeQuestion(q, "single_choice")).toBe(q);
  });
  it("new ids continue the numbering and never reuse a removed one", () => {
    expect(nextId("s", ["s1", "s2", "s7"])).toBe("s8");
    expect(nextId("p", [])).toBe("p1");
    expect(nextId("q", ["q2", "qx", "q10"])).toBe("q11");
  });
});
