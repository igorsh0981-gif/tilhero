/**
 * Sprint 5 fixture data of the mock admin-bff: the course dictionary (catalog glossary: course entries with an override
 * and a translation conflict, a methodist entry, AI translations pending / approved / rejected) and the memory of
 * learners (cards, the scheduling history, retention checks), the forgetting analytics with hidden small groups and
 * the overview stats. Shapes — packages/contracts/src/admin.ts «Память, словарь курса, чтение». No learner texts.
 */
import type { AdminCardDetail, ForgettingAnalytics, GlossaryDetail, ReviewLogRow, RetentionCheckRow } from "@tilhero/contracts/admin";
import type { Localized } from "@tilhero/contracts/content";
import { DAY, HOUR, ID, iso, LEARNER, MIN } from "./data";

const L = (ru: string, uz: string): Localized => ({ ru, uz });
export const SEED_ID = "00000000-0000-4000-a000-000000005eed";

export const GID = {
  coffeeShop: "61000000-0000-4000-8000-000000000001",
  queue: "61000000-0000-4000-8000-000000000002",
  hello: "61000000-0000-4000-8000-000000000003",
  byTheWay: "61000000-0000-4000-8000-000000000004",
  bakery: "61000000-0000-4000-8000-000000000005",
  tip: "61000000-0000-4000-8000-000000000006",
  window: "61000000-0000-4000-8000-000000000007",
  latte: "61000000-0000-4000-8000-000000000008",
  croissant: "61000000-0000-4000-8000-000000000009",
};

export type MockEntry = Omit<GlossaryDetail, "updated_by_name">;

const base = (p: Partial<MockEntry> & Pick<MockEntry, "entry_id" | "lemma" | "forms" | "gloss" | "source" | "review_status">): MockEntry => ({
  pair_id: "ru-en",
  part_of_speech: null,
  example_en: null,
  confidence: null,
  agent_version: null,
  refs: [],
  override: null,
  corrected: false,
  archived_at: null,
  updated_by: SEED_ID,
  updated_at: iso(-10 * DAY),
  refs_titles: [],
  history: [],
  conflicts: [],
  ...p,
});

export function glossary(): MockEntry[] {
  const cafeRef = { kind: "reading" as const, key: "r-a1-coffee-shop", version: 1 };
  const mediaRef = { kind: "media_asset" as const, key: "m-own-coffee-order", version: 1 };
  const lessonRef = { kind: "lesson" as const, key: "l-03-cafe", version: 1 };
  return [
    base({
      entry_id: GID.coffeeShop,
      lemma: "coffee shop",
      forms: ["coffee shop"],
      part_of_speech: "noun",
      gloss: L("кофейня", "qahvaxona"),
      example_en: "Every morning Lola goes to a small coffee shop.",
      source: "course",
      review_status: "not_required",
      refs: [cafeRef, mediaRef],
      refs_titles: [
        { ...cafeRef, title: L("В кофейне", "Qahvaxonada") },
        { ...mediaRef, title: L("Заказ кофе", "Qahva buyurtmasi") },
      ],
      conflicts: [{ ref: mediaRef, gloss: L("кафе", "kafe") }],
      history: [{ at: iso(-10 * DAY), by: SEED_ID, by_name: "Сид (начальное наполнение)", action: "created", before: null, after: { lemma: "coffee shop", gloss: L("кофейня", "qahvaxona"), source: "course" }, reason: null }],
    }),
    base({
      entry_id: GID.queue,
      lemma: "queue",
      forms: ["queue", "queues"],
      part_of_speech: "noun",
      gloss: L("очередь", "navbat"),
      source: "course",
      review_status: "not_required",
      refs: [cafeRef],
      refs_titles: [{ ...cafeRef, title: L("В кофейне", "Qahvaxonada") }],
    }),
    base({
      entry_id: GID.hello,
      lemma: "hello",
      forms: ["hello"],
      part_of_speech: "interjection",
      gloss: L("здравствуйте; привет", "salom"),
      source: "course",
      review_status: "not_required",
      refs: [{ kind: "lesson", key: "l-01-greetings", version: 1 }],
      refs_titles: [{ kind: "lesson", key: "l-01-greetings", version: 1, title: L("Привет! Знакомимся", "Salom! Tanishamiz") }],
      override: { gloss: L("здравствуйте; привет", "salom"), example_en: "Hello, my name is Tom.", by: ID.methodist2, at: iso(-3 * DAY) },
      updated_by: ID.methodist2,
      updated_at: iso(-3 * DAY),
      history: [
        { at: iso(-3 * DAY), by: ID.methodist2, by_name: null, action: "overridden", before: { gloss: L("привет", "salom") }, after: { gloss: L("здравствуйте; привет", "salom") }, reason: "Вежливый вариант для взрослых" },
        { at: iso(-10 * DAY), by: SEED_ID, by_name: "Сид (начальное наполнение)", action: "created", before: null, after: { lemma: "hello", gloss: L("привет", "salom") }, reason: null },
      ],
    }),
    base({
      entry_id: GID.byTheWay,
      lemma: "by the way",
      forms: ["by the way", "btw"],
      part_of_speech: "phrase",
      gloss: L("кстати", "aytgancha"),
      example_en: "By the way, where is the bus stop?",
      source: "methodist",
      review_status: "not_required",
      updated_by: ID.methodist,
      updated_at: iso(-2 * DAY),
      history: [{ at: iso(-2 * DAY), by: ID.methodist, by_name: null, action: "created", before: null, after: { lemma: "by the way", gloss: L("кстати", "aytgancha"), source: "methodist" }, reason: "Нужно для диалогов" }],
    }),
    base({
      entry_id: GID.bakery,
      lemma: "bakery",
      forms: ["bakery"],
      part_of_speech: "noun",
      gloss: L("пекарня", "novvoyxona"),
      source: "ai",
      review_status: "pending",
      confidence: 0.86,
      agent_version: "teaching_coach@2",
      refs: [cafeRef, mediaRef, lessonRef],
      refs_titles: [
        { ...cafeRef, title: L("В кофейне", "Qahvaxonada") },
        { ...mediaRef, title: L("Заказ кофе", "Qahva buyurtmasi") },
        { ...lessonRef, title: L("В кафе", "Kafeda") },
      ],
      updated_by: null,
      updated_at: iso(-5 * HOUR),
      history: [{ at: iso(-5 * HOUR), by: null, by_name: null, action: "created", before: null, after: { lemma: "bakery", gloss: L("пекарня", "novvoyxona"), source: "ai" }, reason: "Перевод ИИ (gloss_word) для слова из контента" }],
    }),
    base({
      entry_id: GID.window,
      lemma: "window",
      forms: ["window"],
      part_of_speech: "noun",
      gloss: L("окно", "deraza"),
      source: "ai",
      review_status: "pending",
      confidence: 0.91,
      agent_version: "teaching_coach@2",
      refs: [cafeRef, mediaRef],
      refs_titles: [
        { ...cafeRef, title: L("В кофейне", "Qahvaxonada") },
        { ...mediaRef, title: L("Заказ кофе", "Qahva buyurtmasi") },
      ],
      updated_by: null,
      updated_at: iso(-4 * HOUR),
    }),
    base({
      entry_id: GID.tip,
      lemma: "tip",
      forms: ["tip"],
      part_of_speech: "noun",
      gloss: L("кончик", "uchi"),
      source: "ai",
      review_status: "pending",
      confidence: 0.42,
      agent_version: "teaching_coach@2",
      refs: [lessonRef],
      refs_titles: [{ ...lessonRef, title: L("В кафе", "Kafeda") }],
      updated_by: null,
      updated_at: iso(-3 * HOUR),
    }),
    base({
      entry_id: GID.latte,
      lemma: "latte",
      forms: ["latte"],
      part_of_speech: "noun",
      gloss: L("латте", "latte"),
      source: "ai",
      review_status: "approved",
      confidence: 0.95,
      agent_version: "teaching_coach@2",
      refs: [cafeRef],
      refs_titles: [{ ...cafeRef, title: L("В кофейне", "Qahvaxonada") }],
      updated_by: ID.methodist,
      updated_at: iso(-1 * DAY),
    }),
    base({
      entry_id: GID.croissant,
      lemma: "croissant",
      forms: ["croissant"],
      part_of_speech: "noun",
      gloss: L("рогалик сладкий", "shirin non"),
      source: "ai",
      review_status: "rejected",
      confidence: 0.61,
      agent_version: "teaching_coach@2",
      refs: [cafeRef],
      refs_titles: [{ ...cafeRef, title: L("В кофейне", "Qahvaxonada") }],
      updated_by: ID.methodist,
      updated_at: iso(-1 * DAY),
    }),
  ];
}

/* ---------------------------------------------------------------- memory */

export const CID = {
  c1: "c1000000-0000-4000-8000-000000000001",
  c2: "c1000000-0000-4000-8000-000000000002",
  c3: "c1000000-0000-4000-8000-000000000003",
  c4: "c1000000-0000-4000-8000-000000000004",
  c5: "c1000000-0000-4000-8000-000000000005",
  c6: "c1000000-0000-4000-8000-000000000006",
  k1: "c1000000-0000-4000-8000-000000000011",
};

export type MockCard = Omit<AdminCardDetail, "log"> & { log: ReviewLogRow[] };

const snap = (status: MockCard["status"], state: "new" | "learning" | "review", s: number | null, d: number | null, due: string | null) => ({ status, state, stability: s, difficulty: d, due_at: due });

const card = (p: Partial<MockCard> & Pick<MockCard, "card_id" | "user_id" | "kind" | "text_en" | "gloss" | "status">): MockCard => ({
  stability: null,
  difficulty: null,
  retrievability: null,
  reps: 0,
  lapses: 0,
  due_at: null,
  last_review_at: null,
  error_code: null,
  example_en: null,
  sources: [],
  log: [],
  ...p,
});

const log = (id: number, p: Partial<ReviewLogRow> & Pick<ReviewLogRow, "at" | "before" | "after">): ReviewLogRow => ({
  log_id: `1a000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  task_type: "meaning_choice",
  answer_mode: "choice",
  grade: "good",
  hinted: false,
  revealed: false,
  elapsed_days: null,
  algorithm: "fsrs-5",
  params_version: "fsrs5-default-1",
  actor: "learner",
  actor_id: null,
  actor_name: null,
  reason: null,
  ...p,
});

export function cards(): MockCard[] {
  const m = LEARNER.madina;
  return [
    card({
      card_id: CID.c1,
      user_id: m,
      kind: "phrase",
      text_en: "coffee shop",
      gloss: L("кофейня", "qahvaxona"),
      status: "review",
      stability: 12.4,
      difficulty: 4.8,
      retrievability: 0.93,
      reps: 5,
      lapses: 1,
      due_at: iso(5 * DAY),
      last_review_at: iso(-2 * DAY),
      example_en: "Every morning Lola goes to a small coffee shop.",
      sources: [
        { kind: "reading", key: "r-a1-coffee-shop", version: 1, at: iso(-20 * DAY) },
        { kind: "media", key: "m-own-coffee-order", version: 1, at: iso(-12 * DAY) },
      ],
      log: [
        log(5, { at: iso(-2 * DAY), task_type: "typed", answer_mode: "typed", grade: "good", elapsed_days: 4.1, before: snap("review", "review", 5.2, 5.0, iso(-1 * DAY)), after: snap("review", "review", 12.4, 4.8, iso(5 * DAY)) }),
        log(4, { at: iso(-6 * DAY), task_type: "manual", answer_mode: "manual", grade: null, actor: "staff", actor_id: ID.ops, actor_name: "Тимур", reason: "Ученик сообщил о сбое: перенос на завтра", before: snap("review", "review", 5.2, 5.0, iso(-6 * DAY)), after: snap("review", "review", 5.2, 5.0, iso(-5 * DAY)) }),
        log(3, { at: iso(-11 * DAY), task_type: "cloze", answer_mode: "typed", grade: "again", revealed: true, elapsed_days: 3.0, before: snap("review", "review", 8.0, 4.4, iso(-10 * DAY)), after: snap("learning", "learning", 5.2, 5.0, iso(-10 * DAY)) }),
        log(2, { at: iso(-14 * DAY), task_type: "typed", answer_mode: "typed", grade: "good", hinted: false, elapsed_days: 3.2, before: snap("learning", "learning", 3.17, 5.28, iso(-14 * DAY)), after: snap("review", "review", 8.0, 4.4, iso(-6 * DAY)) }),
        log(1, { at: iso(-17 * DAY), task_type: "meaning_choice", answer_mode: "choice", grade: "hard", before: snap("new", "new", null, null, iso(-17 * DAY)), after: snap("learning", "learning", 3.17, 5.28, iso(-14 * DAY)) }),
      ],
    }),
    card({ card_id: CID.c2, user_id: m, kind: "phrase", text_en: "Nice to meet you", gloss: L("Приятно познакомиться", "Tanishganimdan xursandman"), status: "learning", stability: 1.2, difficulty: 6.1, retrievability: 0.71, reps: 2, lapses: 1, due_at: iso(-2 * HOUR), last_review_at: iso(-1 * DAY), sources: [{ kind: "lesson", key: "l-01-greetings", version: 1, at: iso(-9 * DAY) }] }),
    card({ card_id: CID.c3, user_id: m, kind: "word", text_en: "queue", gloss: L("очередь", "navbat"), status: "new", due_at: iso(-10 * MIN), sources: [{ kind: "manual", key: "r-a1-coffee-shop", version: 1, at: iso(-1 * HOUR) }] }),
    // an error card: no text — the correction was derived from the learner's own answer; the gloss is the label of the code
    card({ card_id: CID.c4, user_id: m, kind: "error", text_en: null, gloss: L("Порядок слов", "So'z tartibi"), status: "learning", stability: 0.6, difficulty: 7.2, retrievability: 0.42, reps: 3, lapses: 2, due_at: iso(-9 * DAY), last_review_at: iso(-12 * DAY), error_code: "word_order", sources: [{ kind: "evaluation", key: null, version: null, at: iso(-15 * DAY) }] }),
    card({ card_id: CID.c5, user_id: m, kind: "word", text_en: "barista", gloss: L("бариста", "barista"), status: "frozen", stability: 4.0, difficulty: 5.0, retrievability: 0.8, reps: 2, due_at: iso(3 * DAY), last_review_at: iso(-3 * DAY), sources: [{ kind: "reading", key: "r-a1-coffee-shop", version: 1, at: iso(-20 * DAY) }] }),
    card({ card_id: CID.c6, user_id: m, kind: "word", text_en: "croissant", gloss: L("круассан", "kruassan"), status: "known", reps: 1, sources: [{ kind: "reading", key: "r-a1-coffee-shop", version: 1, at: iso(-20 * DAY) }] }),
    // a child (6–9): words only — no error cards, no free text
    card({ card_id: CID.k1, user_id: LEARNER.lola, kind: "word", text_en: "cat", gloss: L("кошка", "mushuk"), status: "review", stability: 6, difficulty: 4, retrievability: 0.9, reps: 3, due_at: iso(2 * DAY), last_review_at: iso(-3 * DAY), sources: [{ kind: "lesson", key: "l-02-numbers", version: 1, at: iso(-8 * DAY) }] }),
  ];
}

export function checks(user: string): RetentionCheckRow[] {
  if (user !== LEARNER.madina) return [];
  return [
    { check_id: "ce000000-0000-4000-8000-000000000001", skill_id: "en.func.greet", skill_title: L("Приветствие и знакомство", "Salomlashish va tanishish"), stage: "d30", status: "scheduled", due_at: iso(18 * DAY), checked_at: null, result: null, consecutive_failures: 0 },
    { check_id: "ce000000-0000-4000-8000-000000000002", skill_id: "en.func.greet", skill_title: L("Приветствие и знакомство", "Salomlashish va tanishish"), stage: "d7", status: "passed", due_at: iso(-5 * DAY), checked_at: iso(-5 * DAY), result: { correct: 3, total: 3 }, consecutive_failures: 0 },
    { check_id: "ce000000-0000-4000-8000-000000000003", skill_id: "en.gram.numbers", skill_title: L("Числа 1–100", "1–100 sonlari"), stage: "d7", status: "failed", due_at: iso(-1 * DAY), checked_at: iso(-1 * DAY), result: { correct: 1, total: 3 }, consecutive_failures: 1 },
  ];
}

export function analytics(period: "30d" | "90d"): ForgettingAnalytics {
  const hidden = { scheduled: 0, passed: 0, failed: 0, pass_pct: null, hidden: true };
  const long = period === "90d";
  return {
    period,
    pair_id: "ru-en",
    generated_at: iso(-2 * MIN),
    checks: {
      d7: long ? { scheduled: 140, passed: 104, failed: 28, pass_pct: 78.8, hidden: false } : { scheduled: 48, passed: 36, failed: 9, pass_pct: 80.0, hidden: false },
      d30: long ? { scheduled: 21, passed: 15, failed: 4, pass_pct: 78.9, hidden: false } : hidden,
    },
    by_skill: [
      { skill_id: "en.func.greet", title: L("Приветствие и знакомство", "Salomlashish va tanishish"), d7: { scheduled: 21, passed: 18, failed: 3, pass_pct: 85.7, hidden: false }, d30: long ? { scheduled: 9, passed: 8, failed: 1, pass_pct: 88.9, hidden: false } : hidden },
      { skill_id: "en.gram.numbers", title: L("Числа 1–100", "1–100 sonlari"), d7: { scheduled: 25, passed: 13, failed: 12, pass_pct: 52.0, hidden: false }, d30: hidden },
      { skill_id: "en.func.order", title: L("Заказ в кафе", "Kafeda buyurtma"), d7: hidden, d30: hidden },
    ],
    by_lesson: [
      { lesson_id: "l-01-greetings", title: L("Привет! Знакомимся", "Salom! Tanishamiz"), cards: 312, again_pct: 18.2, hidden: false },
      { lesson_id: "l-02-numbers", title: L("Цвета и числа", "Ranglar va sonlar"), cards: 205, again_pct: 41.5, hidden: false },
      { lesson_id: "l-03-cafe", title: L("В кафе", "Kafeda"), cards: 0, again_pct: null, hidden: true },
    ],
    repeated_errors: [
      { error_code: "word_order", label: L("Порядок слов", "Soʻz tartibi"), learners_with_repeats: 12, cards: 37, hidden: false },
      { error_code: "article", label: L("Артикль a / the", "a / the artikli"), learners_with_repeats: 0, cards: 0, hidden: true },
    ],
    forgotten_words: [
      { text_en: "queue", answers: 64, again_pct: 46.9 },
      { text_en: "croissant", answers: 31, again_pct: 38.7 },
      { text_en: "Nice to meet you", answers: 120, again_pct: 21.7 },
    ],
  };
}
