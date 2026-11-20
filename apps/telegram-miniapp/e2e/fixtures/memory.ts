import type {
  AgeBand,
  CardKind,
  CardStatus,
  CardStrength,
  ContentRef,
  DictionaryCard,
  DictionaryCardDetail,
  ErrorJournalItem,
  GuardianConsent,
  MemoryOverview,
  PronunciationView,
  ReadingCard,
  ReadingView,
  ReviewAnswer,
  ReviewSession,
  ReviewSummary,
  ReviewTask,
  ReviewTaskResult,
  WordGloss,
} from "@tilhero/contracts/bff";
import type { GlossarySource, Localized } from "@tilhero/contracts/content";
import type { MockLessons, ReadingQuestionDef, Res } from "./lessons";

/**
 * Sprint 5 part of the mock telegram-bff (bff.ts «Спринт 5»): the dictionary (cards, filters, search, pages, «Знаю
 * это», removal, the error journal), «Повторение дня» (a fixed queue of every task type: the check block, intro,
 * recognition, typed / cloze / assemble / error fix, the answer compared by the rules of INTERNAL_API §1.6 — typo →
 * almost, a wrong card comes back once at the end; no key ever in a task), the summary, the translation by tap (course
 * dictionary, AI marked unreviewed, no translation), «В словарь», reading texts by audience, «Произнести» (the WAV header
 * is checked like the BFF does; consent self / guardian; unavailable), the parent's switch for a child profile. Children:
 * their own cards and texts, no error journal, assemble instead of typing. Pure TS (Playwright).
 */
export interface MemoryScenario {
  /** speech (Azure) connected: available (default) — the consent decides; unavailable — no «Произнести» */
  speech?: "available" | "unavailable";
  /** the result of an assessment: ok (default) | insufficient_evidence */
  pronResult?: "ok" | "insufficient_evidence";
  /** no cards at all (an empty dictionary, nothing to review) */
  empty?: boolean;
  /** the review of today is done (nothing due) */
  doneToday?: boolean;
}

export interface MemoryCtx {
  owner: string;
  kid: boolean;
  /** «ru» | «uz» from Accept-Language: the translations among the options */
  lang: "ru" | "uz";
  account: { age_band: AgeBand | null; guardian_consent: GuardianConsent };
  purposes: string[];
  childVoice: (id: string) => boolean | null;
  setChildVoice: (id: string, granted: boolean) => unknown | null;
  raw: Buffer | null;
}

const L = (ru: string, uz: string): Localized => ({ ru, uz });
const DAY = 24 * 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ok = (body: unknown, status = 200): Res => ({ status, body });
const fail = (status: number, code: string, details: Record<string, unknown> = {}): Res => ({ status, code, details });

interface CardRec {
  card_id: string;
  owner: string;
  kind: CardKind;
  text_en: string;
  gloss: Localized;
  gloss_source: GlossarySource;
  status: CardStatus;
  strength: CardStrength;
  due_at: string | null;
  last_reviewed_at: string | null;
  created_at: string;
  example_en: string | null;
  error: DictionaryCardDetail["error"];
  severity: ErrorJournalItem["severity"];
  sources: DictionaryCardDetail["sources"];
  history: DictionaryCardDetail["history"];
  last_pronunciation: DictionaryCardDetail["last_pronunciation"];
  archived?: boolean;
}

/** One task of the mock queue: what the learner sees + the key (kept here, never sent). */
interface TaskDef {
  type: ReviewTask["type"];
  card_id: string | null;
  prompt: Partial<ReviewTask["prompt"]>;
  options: string[] | ((lang: "ru" | "uz") => string[]);
  tiles: string[];
  answer_kind: ReviewTask["answer_kind"];
  hints: ReviewTask["hints"];
  /** choice index | accepted texts | the assembled string (order) */
  key: number | string[] | string;
  right: string;
  check?: { check_id: string; skill_title: Localized; position: number; of: number };
}

interface TaskRun extends TaskDef {
  task_id: string;
  result: ReviewTaskResult | null;
  hints_used: ReviewTask["hints_used"];
  requeue: boolean;
  answer: string | null;
  correct: boolean | null;
}

interface SessionRun {
  view: ReviewSession;
  owner: string;
  kid: boolean;
  tasks: TaskRun[];
  summary: ReviewSummary | null;
}

export const SKILL_CAFE = L("Вежливая просьба в кафе", "Kafeda xushmuomala iltimos");

/* ---------------------------------------------------------------- reading texts (mock catalog) */

interface ReadingDef {
  view: Omit<ReadingView, "glossary"> & { glossary: Array<Omit<ReadingView["glossary"][number], "in_dictionary">> };
  audience: "kids" | "adults";
  topics: ReadingCard["topics"];
  word_count: number;
  questions: ReadingQuestionDef[];
}

export const READINGS: ReadingDef[] = [
  {
    audience: "adults",
    topics: ["food"] as ReadingCard["topics"],
    word_count: 42,
    view: {
      reading_id: "rd-cafe-morning",
      version: 2,
      title: L("Утро в кафе", "Kafedagi tong"),
      level: "A1",
      voice: "en-GB",
      paragraphs: [
        {
          p_id: "p1",
          sentences: [
            { s_id: "s1", text_en: "Aziz goes to a small café every morning.", gloss: L("Азиз каждое утро ходит в маленькое кафе.", "Aziz har kuni ertalab kichik kafega boradi.") },
            { s_id: "s2", text_en: "He orders a latte to go.", gloss: L("Он заказывает латте с собой.", "U olib ketish uchun latte buyurtma qiladi.") },
          ],
        },
        {
          p_id: "p2",
          sentences: [
            { s_id: "s3", text_en: "The barista smiles and says: “Have a nice day!”", gloss: L("Бариста улыбается и говорит: «Хорошего дня!»", "Barista jilmayib: «Kuningiz xayrli oʻtsin!» — deydi.") },
            { s_id: "s4", text_en: "Then Aziz asks for the bill.", gloss: L("Потом Азиз просит счёт.", "Keyin Aziz hisobni soʻraydi.") },
          ],
        },
      ],
      glossary: [
        { en: "latte", gloss: L("латте", "latte"), note: null },
        { en: "to go", gloss: L("с собой", "olib ketish uchun"), note: L("Так говорят о еде и напитках навынос.", "Olib ketiladigan ovqat va ichimliklar haqida shunday deyiladi.") },
        { en: "the bill", gloss: L("счёт", "hisob"), note: null },
      ],
      questions_count: 3,
      question_types: ["single_choice", "true_false", "gap_fill"],
      est_minutes: 3,
    },
    questions: [
      { item_id: "q-order", item_type: "single_choice", instruction: L("Выберите ответ", "Javobni tanlang"), prompt_en: "What does Aziz order?", options: ["a tea", "a latte to go", "a cake"], key: 1, right: "a latte to go" },
      { item_id: "q-tf", item_type: "single_choice", instruction: L("Верно или нет?", "Toʻgʻrimi yoki yoʻqmi?"), prompt_en: "Aziz goes to the café every evening.", options: ["True", "False"], key: 1, right: "False" },
      { item_id: "q-gap", item_type: "gap_fill", instruction: L("Впишите пропущенное слово", "Tushib qolgan soʻzni yozing"), prompt_en: "Then Aziz asks ___ the bill.", options: [], key: "for", right: "for" },
    ],
  },
  {
    audience: "adults",
    topics: ["travel"] as ReadingCard["topics"],
    word_count: 64,
    view: {
      reading_id: "rd-train",
      version: 1,
      title: L("Поезд в Самарканд", "Samarqandga poyezd"),
      level: "A2",
      voice: "en-US",
      paragraphs: [{ p_id: "p1", sentences: [{ s_id: "s1", text_en: "The train leaves at nine.", gloss: L("Поезд отправляется в девять.", "Poyezd soat toʻqqizda joʻnaydi.") }] }],
      glossary: [{ en: "leaves", gloss: L("отправляется", "joʻnaydi"), note: null }],
      questions_count: 0,
      question_types: [],
      est_minutes: 4,
    },
    questions: [],
  },
  {
    audience: "kids",
    topics: ["home"] as ReadingCard["topics"],
    word_count: 12,
    view: {
      reading_id: "rd-kids-cat",
      version: 1,
      title: L("Мой кот", "Mening mushugim"),
      level: "A0",
      voice: "en-GB",
      paragraphs: [
        {
          p_id: "p1",
          sentences: [
            { s_id: "s1", text_en: "I have a cat.", gloss: L("У меня есть кот.", "Mening mushugim bor.") },
            { s_id: "s2", text_en: "My cat is black.", gloss: L("Мой кот чёрный.", "Mushugim qora.") },
          ],
        },
      ],
      glossary: [
        { en: "cat", gloss: L("кот", "mushuk"), note: null },
        { en: "black", gloss: L("чёрный", "qora"), note: null },
      ],
      questions_count: 1,
      question_types: ["true_false"],
      est_minutes: 2,
    },
    questions: [{ item_id: "kq-tf", item_type: "single_choice", instruction: L("Правда или нет?", "Rostmi yoki yoʻqmi?"), prompt_en: "The cat is white.", options: ["True", "False"], key: 1, right: "False" }],
  },
];

/** The course dictionary and the AI cache of the mock (memory → catalog → teaching_coach). */
const COURSE: Record<string, { gloss: Localized; source: GlossarySource; lemma?: string; pos?: WordGloss["part_of_speech"]; note?: Localized; ai_unreviewed?: boolean }> = {
  latte: { gloss: L("латте", "latte"), source: "course", pos: "noun" },
  "to go": { gloss: L("с собой", "olib ketish uchun"), source: "course", pos: "phrase", note: L("Так говорят о еде и напитках навынос.", "Olib ketiladigan ovqat va ichimliklar haqida shunday deyiladi.") },
  "the bill": { gloss: L("счёт", "hisob"), source: "course", pos: "phrase" },
  orders: { gloss: L("заказывает", "buyurtma qiladi"), source: "course", lemma: "order", pos: "verb" },
  morning: { gloss: L("утро", "tong"), source: "methodist", pos: "noun" },
  "café": { gloss: L("кафе", "kafe"), source: "course", pos: "noun" },
  barista: { gloss: L("бариста", "barista"), source: "ai", pos: "noun", ai_unreviewed: true },
  cat: { gloss: L("кот", "mushuk"), source: "course", pos: "noun" },
  black: { gloss: L("чёрный", "qora"), source: "course", pos: "adjective" },
  leaves: { gloss: L("отправляется", "joʻnaydi"), source: "course", lemma: "leave", pos: "verb" },
};

const norm = (s: string) =>
  s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?…]+$/, "")
    .replace(/^["“”]+|["“”]+$/g, "");

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** INTERNAL_API §1.6: exact (normalised, I'd = I would…) → correct; one word ≥ 5 letters one edit away → almost. */
export function compareTyped(text: string, accepted: readonly string[]): "correct" | "almost" | "incorrect" {
  const exp = (s: string) => norm(s).replace(/\bi'd\b/g, "i would").replace(/\bi'm\b/g, "i am").replace(/\bdon't\b/g, "do not").replace(/[,]/g, "");
  const got = exp(text);
  if (accepted.some((a) => exp(a) === got)) return "correct";
  for (const a of accepted) {
    const w1 = exp(a).split(" ");
    const w2 = got.split(" ");
    if (w1.length !== w2.length) continue;
    const diff = w1.map((w, i) => [w, w2[i]!] as const).filter(([x, y]) => x !== y);
    if (diff.length === 1 && diff[0]![0].length >= 5 && lev(diff[0]![0], diff[0]![1]) === 1) return "almost";
  }
  return "incorrect";
}

export class MockMemory {
  readonly sc: MemoryScenario;
  cards = new Map<string, CardRec>();
  sessions = new Map<string, SessionRun>();
  idem = new Map<string, unknown>();
  /** the last WAV the mock received: its header (the audio itself is not kept) */
  lastWav: { bytes: number; rate: number; channels: number; bits: number; durationMs: number } | null = null;
  pronCalls = 0;
  private seq = 1;
  private doneFor = new Set<string>();
  private readonly lessons: MockLessons;

  constructor(sc: MemoryScenario, lessons: MockLessons, owners: { self: string; kid?: string }) {
    this.sc = sc;
    this.lessons = lessons;
    if (!sc.empty) {
      this.seedAdult(owners.self);
      if (owners.kid) this.seedKid(owners.kid);
    }
    if (sc.doneToday) {
      this.doneFor.add(owners.self);
      if (owners.kid) this.doneFor.add(owners.kid);
    }
  }

  private id(prefix = "c0ffee00"): string {
    return `${prefix}-aaaa-4bbb-8ccc-${String(this.seq++).padStart(12, "0")}`;
  }

  private add(owner: string, c: Partial<CardRec> & Pick<CardRec, "kind" | "text_en" | "gloss">, id?: string): CardRec {
    const now = Date.now();
    const rec: CardRec = {
      card_id: id ?? this.id(),
      owner,
      gloss_source: "course",
      status: "review",
      strength: "ok",
      due_at: iso(now - 3600_000),
      last_reviewed_at: iso(now - 3 * DAY),
      created_at: iso(now - 10 * DAY),
      example_en: null,
      error: null,
      severity: "medium",
      sources: [{ kind: "lesson", title: L("В кафе: заказ напитков", "Kafeda: ichimlik buyurtma qilish"), at: iso(now - 10 * DAY) }],
      history: [{ at: iso(now - 3 * DAY), grade: "good", mode: "typed" }, { at: iso(now - 6 * DAY), grade: "hard", mode: "choice" }],
      last_pronunciation: null,
      ...c,
    };
    this.cards.set(rec.card_id, rec);
    return rec;
  }

  static readonly IDS = {
    bill: "c0ffee00-aaaa-4bbb-8ccc-0000000000b1",
    togo: "c0ffee00-aaaa-4bbb-8ccc-0000000000b2",
    menu: "c0ffee00-aaaa-4bbb-8ccc-0000000000b3",
    table: "c0ffee00-aaaa-4bbb-8ccc-0000000000b4",
    receipt: "c0ffee00-aaaa-4bbb-8ccc-0000000000b5",
    latte: "c0ffee00-aaaa-4bbb-8ccc-0000000000b6",
    like: "c0ffee00-aaaa-4bbb-8ccc-0000000000e1",
    be: "c0ffee00-aaaa-4bbb-8ccc-0000000000e2",
    hello: "c0ffee00-aaaa-4bbb-8ccc-0000000000b7",
    cat: "c0ffee00-aaaa-4bbb-8ccc-0000000000k1",
    lion: "c0ffee00-aaaa-4bbb-8ccc-0000000000k2",
    yellow: "c0ffee00-aaaa-4bbb-8ccc-0000000000k3",
    apple: "c0ffee00-aaaa-4bbb-8ccc-0000000000k4",
  } as const;

  private seedAdult(o: string): void {
    const I = MockMemory.IDS;
    const now = Date.now();
    this.add(o, { kind: "phrase", text_en: "the bill", gloss: L("счёт", "hisob"), example_en: "Could I have the bill, please?", strength: "ok", due_at: iso(now + 5 * DAY) }, I.bill);
    this.add(o, { kind: "phrase", text_en: "to go", gloss: L("с собой", "olib ketish uchun"), example_en: "A latte to go, please.", strength: "weak" }, I.togo);
    this.add(o, { kind: "word", text_en: "menu", gloss: L("меню", "menyu"), example_en: "Can I see the menu, please?", gloss_source: "methodist" }, I.menu);
    this.add(o, { kind: "word", text_en: "table", gloss: L("стол", "stol"), example_en: "A table for two, please." }, I.table);
    this.add(o, { kind: "word", text_en: "receipt", gloss: L("чек", "chek"), example_en: "Can I get a receipt?", status: "new", strength: "new", due_at: iso(now), last_reviewed_at: null, history: [] }, I.receipt);
    this.add(o, { kind: "word", text_en: "latte", gloss: L("латте", "latte"), status: "learning", strength: "weak", sources: [{ kind: "reading", title: L("Утро в кафе", "Kafedagi tong"), at: iso(now - 2 * DAY) }] }, I.latte);
    this.add(
      o,
      {
        kind: "error",
        text_en: "I’d like a latte, please.",
        gloss: L("Мне латте, пожалуйста.", "Menga latte, iltimos."),
        status: "learning",
        strength: "weak",
        severity: "high",
        error: { correction: "I’d like a latte, please.", evidence: "I want latte", error_code: "vocabulary", explanation: L("Вежливая просьба: I’d like вместо I want", "Xushmuomala iltimos: I want oʻrniga I’d like") },
        sources: [{ kind: "evaluation", title: L("В кафе: заказ напитков", "Kafeda: ichimlik buyurtma qilish"), at: iso(now - 4 * DAY) }],
      },
      I.like,
    );
    this.add(
      o,
      {
        kind: "error",
        text_en: "She is a teacher.",
        gloss: L("Она учитель.", "U oʻqituvchi."),
        strength: "ok",
        severity: "medium",
        due_at: iso(now + 4 * DAY),
        error: { correction: "She is a teacher.", evidence: null, error_code: "missing_be", explanation: L("Пропущен глагол be", "be feʼli tushib qolgan") },
        created_at: iso(now - 95 * DAY),
      },
      I.be,
    );
    this.add(o, { kind: "word", text_en: "hello", gloss: L("привет", "salom"), status: "known", strength: "strong", due_at: null }, I.hello);
    const fillers: Array<[string, string, string]> = [
      ["coffee", "кофе", "qahva"], ["tea", "чай", "choy"], ["water", "вода", "suv"], ["cake", "пирожное", "pirojniy"], ["soup", "суп", "shoʻrva"],
      ["bread", "хлеб", "non"], ["juice", "сок", "sharbat"], ["sugar", "сахар", "shakar"], ["milk", "молоко", "sut"], ["cup", "чашка", "piyola"],
      ["spoon", "ложка", "qoshiq"], ["fork", "вилка", "vilka"], ["knife", "нож", "pichoq"], ["plate", "тарелка", "likopcha"], ["glass", "стакан", "stakan"],
      ["salt", "соль", "tuz"],
    ];
    fillers.forEach(([en, ru, uz], i) =>
      this.add(o, { kind: "word", text_en: en, gloss: L(ru, uz), strength: i % 3 === 0 ? "strong" : "ok", due_at: iso(now + (i + 2) * DAY), created_at: iso(now - (30 + i) * DAY) }),
    );
  }

  private seedKid(o: string): void {
    const I = MockMemory.IDS;
    const now = Date.now();
    const zoo = [{ kind: "lesson" as const, title: L("Животные в зоопарке", "Hayvonot bogʻidagi hayvonlar"), at: iso(now - 3 * DAY) }];
    this.add(o, { kind: "word", text_en: "cat", gloss: L("кот", "mushuk"), status: "new", strength: "new", history: [], last_reviewed_at: null, sources: zoo }, I.cat);
    this.add(o, { kind: "word", text_en: "lion", gloss: L("лев", "sher"), status: "learning", strength: "weak", sources: zoo }, I.lion);
    this.add(o, { kind: "word", text_en: "yellow", gloss: L("жёлтый", "sariq"), example_en: "It’s yellow!", sources: zoo }, I.yellow);
    this.add(o, { kind: "phrase", text_en: "red apple", gloss: L("красное яблоко", "qizil olma"), sources: zoo }, I.apple);
  }

  /* ---------------------------------------------------------------- views */

  private card(c: CardRec): DictionaryCard {
    return { card_id: c.card_id, kind: c.kind, text_en: c.text_en, gloss: c.gloss, gloss_source: c.gloss_source, status: c.status, strength: c.strength, due_at: c.due_at, last_reviewed_at: c.last_reviewed_at, created_at: c.created_at };
  }
  private detail(c: CardRec): DictionaryCardDetail {
    const days = c.due_at && (c.status === "learning" || c.status === "review") ? Math.max(0, Math.ceil((Date.parse(c.due_at) - Date.now()) / DAY)) : null;
    return { ...this.card(c), example_en: c.example_en, error: c.error, sources: c.sources, history: c.history.slice(0, 10), next_review_in_days: days, last_pronunciation: c.last_pronunciation };
  }
  private own(owner: string): CardRec[] {
    return [...this.cards.values()].filter((c) => c.owner === owner && !c.archived);
  }
  private active(owner: string): SessionRun | null {
    return [...this.sessions.values()].find((s) => s.owner === owner && s.view.status === "active") ?? null;
  }

  pronunciation(ctx: MemoryCtx): MemoryOverview["pronunciation"] {
    if (this.sc.speech === "unavailable") return "unavailable";
    if (ctx.kid) return ctx.childVoice(ctx.owner) ? "available" : "consent_guardian";
    if (ctx.account.age_band === "14-17" && ctx.account.guardian_consent !== "granted") return "consent_guardian";
    return ctx.purposes.includes("voice_recording") ? "available" : "consent_self";
  }

  private overview(ctx: MemoryCtx): MemoryOverview {
    const mine = this.own(ctx.owner);
    const act = this.active(ctx.owner);
    const done = this.doneFor.has(ctx.owner);
    const due = done ? 0 : mine.filter((c) => (c.status === "learning" || c.status === "review") && c.due_at && Date.parse(c.due_at) <= Date.now() + 3600_000).length;
    const fresh = done ? 0 : Math.min(ctx.kid ? 3 : 5, mine.filter((c) => c.status === "new").length);
    const checks = done || ctx.kid || this.sc.empty ? 0 : 1;
    const next = mine.filter((c) => c.due_at && Date.parse(c.due_at) > Date.now()).map((c) => Date.parse(c.due_at!)).sort((a, b) => a - b)[0];
    return {
      due_count: due,
      new_available: fresh,
      retention_due: checks,
      done_today: done,
      active_session_id: act?.view.session_id ?? null,
      next_due_at: due + fresh + checks === 0 && next ? iso(next) : null,
      total_cards: mine.length,
      pronunciation: this.pronunciation(ctx),
    };
  }

  /* ---------------------------------------------------------------- the review queue */

  private plan(ctx: MemoryCtx): TaskDef[] {
    const I = MockMemory.IDS;
    const opts = (ru: string[], uz: string[]) => (lang: "ru" | "uz") => (lang === "uz" ? uz : ru);
    if (ctx.kid) {
      return [
        { type: "intro", card_id: I.cat, prompt: { text_en: "cat", gloss: L("кот", "mushuk"), example_en: "I have a cat." }, options: [], tiles: [], answer_kind: "none", hints: [], key: "", right: "" },
        { type: "meaning_choice", card_id: I.cat, prompt: { text_en: "cat" }, options: opts(["кот", "собака", "лев", "рыба"], ["mushuk", "it", "sher", "baliq"]), tiles: [], answer_kind: "choice", hints: ["reveal"], key: 0, right: "кот" },
        { type: "listen_choice", card_id: I.lion, prompt: { speech_text: "lion" }, options: ["lion", "line", "light", "like"], tiles: [], answer_kind: "choice", hints: ["reveal"], key: 0, right: "lion" },
        { type: "assemble", card_id: I.yellow, prompt: { gloss: L("жёлтый", "sariq") }, options: [], tiles: ["l", "e", "w", "y", "l", "o"], answer_kind: "order", hints: ["reveal"], key: "yellow", right: "yellow" },
        { type: "assemble", card_id: I.apple, prompt: { gloss: L("красное яблоко", "qizil olma") }, options: [], tiles: ["apple", "red"], answer_kind: "order", hints: ["reveal"], key: "red apple", right: "red apple" },
      ];
    }
    const check = (position: number) => ({ check_id: "chk-cafe-d30", skill_title: SKILL_CAFE, position, of: 3 });
    return [
      { type: "check_item", card_id: null, check: check(1), prompt: { instruction: L("Выберите вежливую просьбу", "Xushmuomala iltimosni tanlang"), prompt_en: "Choose the polite request" }, options: ["Give me the bill.", "Could I have the bill, please?", "Bill!"], tiles: [], answer_kind: "choice", hints: [], key: 1, right: "Could I have the bill, please?" },
      { type: "check_item", card_id: null, check: check(2), prompt: { instruction: L("Впишите пропущенное слово", "Tushib qolgan soʻzni yozing"), prompt_en: "I’d ___ a latte, please." }, options: [], tiles: [], answer_kind: "text", hints: [], key: ["like"], right: "like" },
      { type: "check_item", card_id: null, check: check(3), prompt: { instruction: L("Соберите вопрос", "Savolni tuzing"), prompt_en: "Put the words in order" }, options: ["have", "Could", "the bill?", "I"], tiles: [], answer_kind: "order", hints: [], key: "Could I have the bill?", right: "Could I have the bill?" },
      { type: "intro", card_id: I.receipt, prompt: { text_en: "receipt", gloss: L("чек", "chek"), example_en: "Can I get a receipt?" }, options: [], tiles: [], answer_kind: "none", hints: [], key: "", right: "" },
      { type: "meaning_choice", card_id: I.receipt, prompt: { text_en: "receipt" }, options: opts(["чек", "счёт", "меню", "стол"], ["chek", "hisob", "menyu", "stol"]), tiles: [], answer_kind: "choice", hints: ["reveal"], key: 0, right: "чек" },
      { type: "listen_choice", card_id: I.latte, prompt: { speech_text: "latte" }, options: ["latte", "later", "letter", "lady"], tiles: [], answer_kind: "choice", hints: ["reveal"], key: 0, right: "latte" },
      { type: "typed", card_id: I.togo, prompt: { gloss: L("с собой", "olib ketish uchun"), example_gap: "A latte ___, please." }, options: [], tiles: [], answer_kind: "text", hints: ["first_letter", "reveal"], key: ["to go"], right: "to go" },
      { type: "cloze", card_id: I.menu, prompt: { example_gap: "Can I see the ___, please?", gloss: L("меню", "menyu") }, options: [], tiles: [], answer_kind: "text", hints: ["first_letter", "reveal"], key: ["menu"], right: "menu" },
      { type: "assemble", card_id: I.table, prompt: { gloss: L("стол", "stol") }, options: [], tiles: ["b", "t", "e", "a", "l"], answer_kind: "order", hints: ["reveal"], key: "table", right: "table" },
      {
        type: "error_fix",
        card_id: I.like,
        prompt: { explanation: L("Вежливая просьба: I’d like вместо I want", "Xushmuomala iltimos: I want oʻrniga I’d like"), evidence: "I want latte" },
        options: [],
        tiles: [],
        answer_kind: "text",
        hints: ["first_letter", "reveal"],
        key: ["I’d like a latte, please.", "I would like a latte, please."],
        right: "I’d like a latte, please.",
      },
    ];
  }

  private run(t: TaskDef): TaskRun {
    return { ...t, task_id: this.id("7a5k0000"), result: null, hints_used: [], requeue: false, answer: null, correct: null };
  }

  private taskView(s: SessionRun, t: TaskRun, lang: "ru" | "uz"): ReviewTask {
    const blank: ReviewTask["prompt"] = { text_en: null, gloss: null, example_en: null, example_gap: null, speech_text: null, explanation: null, evidence: null, instruction: null, prompt_en: null };
    return {
      task_id: t.task_id,
      index: s.tasks.indexOf(t) + 1,
      total: s.tasks.length,
      type: t.type,
      card_id: t.card_id,
      check: t.check ?? null,
      prompt: { ...blank, ...t.prompt },
      options: typeof t.options === "function" ? t.options(lang) : [...t.options],
      tiles: [...t.tiles],
      answer_kind: t.answer_kind,
      hints: [...t.hints],
      hints_used: [...t.hints_used],
      voice: "en-GB",
    };
  }

  private current(s: SessionRun): TaskRun | null {
    return s.tasks.find((t) => !t.result) ?? null;
  }

  private answer(s: SessionRun, t: TaskRun, b: ReviewAnswer, lang: "ru" | "uz"): ReviewTaskResult {
    const options = typeof t.options === "function" ? t.options(lang) : t.options;
    const tiles = t.tiles.length ? t.tiles : options;
    let res: "correct" | "almost" | "incorrect" | null = null;
    let known = false;
    if (t.answer_kind === "none") {
      known = !!b.known;
      if (known && t.card_id) {
        const c = this.cards.get(t.card_id)!;
        c.status = "known";
        c.due_at = null;
        // the next task of a known card is dropped
        s.tasks = s.tasks.filter((x) => x === t || x.result || x.card_id !== t.card_id);
      }
      t.answer = known ? "known" : "got";
    } else if (t.answer_kind === "choice") {
      const i = typeof b.choice === "number" ? b.choice : -1;
      res = i === t.key ? "correct" : "incorrect";
      t.answer = options[i] ?? null;
    } else if (t.answer_kind === "text") {
      t.answer = (b.text ?? "").slice(0, 200);
      res = compareTyped(t.answer, t.key as string[]);
      if (t.type === "check_item" && res === "almost") res = "incorrect";
    } else {
      const order = Array.isArray(b.order) ? b.order : [];
      const letters = tiles.every((x) => x.length === 1);
      t.answer = order.map((i) => tiles[i] ?? "").join(letters ? "" : " ");
      res = t.answer === t.key ? "correct" : "incorrect";
    }
    t.correct = res === null ? null : res !== "incorrect";
    const revealed = t.hints_used.includes("reveal");
    const again = res === "incorrect" || revealed;
    const requeued = !!t.card_id && t.type !== "check_item" && again && !t.requeue;
    // a card answered wrong comes back once at the end of this session
    if (requeued) s.tasks.push({ ...this.run(t), requeue: true });
    if (t.card_id && res !== null) {
      const c = this.cards.get(t.card_id)!;
      const grade: "again" | "hard" | "good" = again ? "again" : t.answer_kind === "choice" || res === "almost" || t.hints_used.length ? "hard" : "good";
      c.history.unshift({ at: iso(Date.now()), grade, mode: t.type === "assemble" ? "assemble" : t.type === "listen_choice" ? "listen" : t.answer_kind === "choice" ? "choice" : "typed" });
      c.last_reviewed_at = iso(Date.now());
      if (c.status === "new") c.status = "learning";
      c.due_at = iso(Date.now() + (again ? 1 : grade === "hard" ? 2 : 4) * DAY);
    }
    let check_result: ReviewTaskResult["check_result"] = null;
    if (t.type === "check_item" && t.check && t.check.position === t.check.of) {
      const block = s.tasks.filter((x) => x.check?.check_id === t.check!.check_id);
      const correct = block.filter((x) => (x === t ? res !== "incorrect" : x.correct)).length;
      check_result = {
        passed: correct >= 2,
        correct,
        total: block.length,
        items: block.map((x) => ({ prompt_en: x.prompt.prompt_en ?? "", your_answer: x === t ? t.answer : x.answer, correct_answer: x.right, correct: x === t ? res !== "incorrect" : !!x.correct })),
      };
    }
    const isCheck = t.type === "check_item";
    const result: ReviewTaskResult = {
      result: isCheck ? null : res,
      correct_answer: isCheck || res === null || res === "correct" ? null : t.right,
      next_review_in_days: isCheck || res === null ? null : again ? 1 : t.answer_kind === "choice" || res === "almost" ? 2 : 4,
      requeued,
      check_result,
      next: null,
    };
    t.result = result;
    s.view.done_tasks = s.tasks.filter((x) => x.result).length;
    s.view.total_tasks = s.tasks.length;
    s.view.minutes = Math.min(60, Math.ceil(s.view.done_tasks / 3));
    const nxt = this.current(s);
    result.next = nxt ? this.taskView(s, nxt, lang) : null;
    return result;
  }

  private summary(s: SessionRun): ReviewSummary {
    const graded = s.tasks.filter((t) => t.card_id && t.answer_kind !== "none" && t.result);
    const firsts = new Map<string, TaskRun>();
    for (const t of graded) if (!firsts.has(t.card_id!)) firsts.set(t.card_id!, t);
    const checks = s.tasks.filter((t) => t.check && t.check.position === t.check.of && t.result?.check_result);
    return {
      session_id: s.view.session_id,
      status: "completed",
      minutes: Math.max(1, s.view.minutes),
      reviewed: firsts.size,
      correct: [...firsts.values()].filter((t) => t.correct && !t.hints_used.includes("reveal")).length,
      again: [...firsts.values()].filter((t) => !t.correct || t.hints_used.includes("reveal")).length,
      new_learned: s.tasks.filter((t) => t.type === "intro" && t.answer === "got").length,
      checks: checks.map((t) => ({ skill_title: t.check!.skill_title, stage: "d30" as const, passed: !!t.result!.check_result!.passed, skill_retained: !!t.result!.check_result!.passed })),
      next_due_at: iso(Date.now() + DAY),
      due_tomorrow: s.kid ? 2 : 6,
    };
  }

  /* ---------------------------------------------------------------- the router */

  handle(method: string, path: string, q: URLSearchParams, b: Record<string, unknown>, headers: Record<string, string>, ctx: MemoryCtx): Res | null {
    const key = `${method} ${path}`;
    const owner = ctx.owner;
    if (key === "GET /v1/memory/overview") return ok(this.overview(ctx));

    // ---- dictionary ----
    if (key === "GET /v1/memory/cards") {
      const kind = q.get("kind");
      const status = q.get("status");
      const text = norm(q.get("q") ?? "");
      if (text.length > 60) return fail(422, "VALIDATION_ERROR", { in: "query", field: "q" });
      const all = this.own(owner)
        .filter((c) => (!kind || c.kind === kind) && (!status || c.status === status))
        .filter((c) => !text || norm(c.text_en).includes(text) || norm(c.gloss.ru).includes(text) || norm(c.gloss.uz).includes(text))
        .sort((a, z) => (a.created_at < z.created_at ? 1 : -1));
      const at = Number(q.get("cursor") ?? 0) || 0;
      const limit = Math.min(100, Number(q.get("limit") ?? 20) || 20);
      const page = all.slice(at, at + limit);
      return ok({ items: page.map((c) => this.card(c)), next_cursor: at + limit < all.length ? String(at + limit) : null });
    }
    if (key === "GET /v1/memory/errors") {
      if (ctx.kid) return ok({ items: [], next_cursor: null });
      const items: ErrorJournalItem[] = this.own(owner)
        .filter((c) => c.kind === "error" && c.error)
        .map((c) => ({ card_id: c.card_id, correction: c.error!.correction, error_code: c.error!.error_code, explanation: c.error!.explanation, severity: c.severity, strength: c.strength, lesson_title: c.sources[0]?.title ?? null, created_at: c.created_at }));
      return ok({ items, next_cursor: null });
    }
    if (key === "POST /v1/memory/cards") {
      const idem = headers["idempotency-key"];
      if (!idem) return fail(422, "IDEMPOTENCY_KEY_REQUIRED");
      const ik = `${owner}:card:${idem}`;
      if (this.idem.has(ik)) return ok(this.card(this.cards.get(this.idem.get(ik) as string)!), 200);
      const text = String(b.text_en ?? "");
      const src = (b.source ?? {}) as ContentRef;
      const found = this.findInContent(src, text, ctx);
      if (found.code) return fail(found.status, found.code);
      const g = COURSE[norm(text)];
      if (!g) return fail(422, "GLOSS_UNAVAILABLE");
      const same = this.own(owner).find((c) => norm(c.text_en) === norm(text));
      if (same) {
        this.idem.set(ik, same.card_id);
        return ok(this.card(same), 200);
      }
      const c = this.add(owner, {
        kind: text.trim().includes(" ") ? "phrase" : "word",
        text_en: text.trim(),
        gloss: g.gloss,
        gloss_source: g.source,
        status: "new",
        strength: "new",
        due_at: iso(Date.now()),
        last_reviewed_at: null,
        created_at: iso(Date.now()),
        example_en: found.sentence ?? null,
        history: [],
        sources: [{ kind: "reading", title: found.title ?? null, at: iso(Date.now()) }],
      });
      this.idem.set(ik, c.card_id);
      return ok(this.card(c), 201);
    }
    let m = /^\/v1\/memory\/cards\/([0-9a-z-]{36})(\/known)?$/.exec(path);
    if (m) {
      const c = this.cards.get(m[1]!);
      if (!c || c.owner !== owner || c.archived) return fail(404, "CARD_NOT_FOUND");
      if (!m[2] && method === "GET") return ok(this.detail(c));
      if (!m[2] && method === "DELETE") {
        c.archived = true;
        return ok(undefined, 204);
      }
      if (m[2] && method === "POST") {
        if (c.status === "frozen") return fail(409, "CARD_STATE", { status: c.status });
        c.status = "known";
        c.due_at = null;
        c.history.unshift({ at: iso(Date.now()), grade: null, mode: "manual" });
        return ok(this.card(c));
      }
      if (m[2] && method === "DELETE") {
        if (c.status !== "known") return fail(409, "CARD_STATE", { status: c.status });
        c.status = "review";
        c.due_at = iso(Date.now());
        return ok(this.card(c));
      }
    }

    // ---- «Повторение дня» ----
    if (key === "POST /v1/memory/review-sessions") {
      const idem = headers["idempotency-key"];
      if (!idem) return fail(422, "IDEMPOTENCY_KEY_REQUIRED");
      const act = this.active(owner);
      if (act) return ok(act.view, 200);
      const ov = this.overview(ctx);
      if (ov.due_count + ov.new_available + ov.retention_due === 0) return fail(409, "NOTHING_TO_REVIEW", { next_due_at: ov.next_due_at });
      const tasks = this.plan(ctx).map((t) => this.run(t));
      const s: SessionRun = {
        owner,
        kid: ctx.kid,
        tasks,
        summary: null,
        view: { session_id: this.id("5e5510e0"), status: "active", total_tasks: tasks.length, done_tasks: 0, cards: ov.due_count + ov.new_available, new_cards: ov.new_available, checks: ov.retention_due, started_at: iso(Date.now()), finished_at: null, minutes: 0 },
      };
      this.sessions.set(s.view.session_id, s);
      return ok(s.view, 201);
    }
    if (key === "GET /v1/memory/review-sessions/active") return ok({ session: this.active(owner)?.view ?? null });
    m = /^\/v1\/memory\/review-sessions\/([0-9a-z-]{36})(?:\/(.+))?$/.exec(path);
    if (m) {
      const s = this.sessions.get(m[1]!);
      if (!s || s.owner !== owner) return fail(404, "REVIEW_SESSION_NOT_FOUND");
      const action = m[2] ?? "";
      const lang = ctx.lang;
      if (action === "" && method === "GET") return ok(s.view);
      if (action === "current" && method === "GET") {
        if (s.view.status !== "active") return fail(409, "REVIEW_SESSION_STATE", { status: s.view.status });
        const cur = this.current(s);
        return cur ? ok(this.taskView(s, cur, lang)) : fail(409, "TASK_NOT_CURRENT", { current_task_id: null });
      }
      if (action === "cancel" && method === "POST") {
        if (s.view.status === "active") s.view.status = "cancelled";
        return ok(s.view);
      }
      if (action === "finish" && method === "POST") {
        if (s.summary) return ok(s.summary);
        if (s.view.status !== "active") return fail(409, "REVIEW_SESSION_STATE", { status: s.view.status });
        const cur = this.current(s);
        if (cur) return fail(409, "TASK_NOT_CURRENT", { current_task_id: cur.task_id });
        s.view.status = "completed";
        s.view.finished_at = iso(Date.now());
        s.summary = this.summary(s);
        this.doneFor.add(owner);
        return ok(s.summary);
      }
      const tm = /^tasks\/([0-9a-z-]{36})(\/hint)?$/.exec(action);
      if (tm && method === "POST") {
        const t = s.tasks.find((x) => x.task_id === tm[1]);
        if (!t) return fail(404, "TASK_NOT_FOUND");
        if (!tm[2] && t.result) return ok(t.result);
        if (s.view.status !== "active") return fail(409, "REVIEW_SESSION_STATE", { status: s.view.status });
        const cur = this.current(s);
        if (cur !== t) return fail(409, "TASK_NOT_CURRENT", { current_task_id: cur?.task_id ?? null });
        if (tm[2]) {
          const kind = b.kind === "first_letter" || b.kind === "reveal" ? b.kind : null;
          if (t.type === "check_item") return fail(409, "HINTS_NOT_ALLOWED");
          if (!kind || !t.hints.includes(kind)) return fail(422, "VALIDATION_ERROR", { field: "kind" });
          if (!t.hints_used.includes(kind)) t.hints_used.push(kind);
          const right = t.answer_kind === "choice" ? (typeof t.options === "function" ? t.options(lang) : t.options)[t.key as number] ?? t.right : t.right;
          return ok({ kind, text: kind === "first_letter" ? `${t.right.replace(/^[^A-Za-z]+/, "").slice(0, 1)}…` : right });
        }
        if (typeof b.text === "string" && b.text.length > 200) return fail(422, "ANSWER_INVALID", { field: "text" });
        return ok(this.answer(s, t, b as ReviewAnswer, lang));
      }
      return fail(404, "NOT_FOUND");
    }

    // ---- translation by tap ----
    if (key === "POST /v1/memory/translate") {
      const text = String(b.text ?? "");
      const src = (b.content ?? {}) as ContentRef;
      if (!text.trim() || text.length > 60) return fail(422, "VALIDATION_ERROR", { field: "text" });
      const found = this.findInContent(src, text, ctx);
      if (found.code) return fail(found.status, found.code);
      const g = COURSE[norm(text)];
      const card = this.own(owner).find((c) => norm(c.text_en) === norm(text));
      const out: WordGloss = g
        ? { text, lemma: g.lemma ?? null, part_of_speech: g.pos ?? null, gloss: g.gloss, source: g.source, ai_unreviewed: !!g.ai_unreviewed, note: g.note ?? null, in_dictionary: card?.card_id ?? null, reason: null }
        : { text, lemma: null, part_of_speech: null, gloss: null, source: null, ai_unreviewed: false, note: null, in_dictionary: card?.card_id ?? null, reason: "not_available" };
      return ok(out);
    }

    // ---- reading ----
    if (key === "GET /v1/practice/readings") {
      const level = q.get("level");
      const items: ReadingCard[] = READINGS.filter((r) => r.audience === (ctx.kid ? "kids" : "adults") && (!level || r.view.level === level)).map((r) => ({
        reading_id: r.view.reading_id,
        title: r.view.title,
        level: r.view.level,
        topics: r.topics,
        est_minutes: r.view.est_minutes,
        word_count: r.word_count,
        last_result: this.lessons.readingResult(owner, r.view.reading_id),
      }));
      return ok({ items, next_cursor: null });
    }
    m = /^\/v1\/practice\/readings\/([a-z0-9-]+)(\/sessions)?$/.exec(path);
    if (m) {
      const r = READINGS.find((x) => x.view.reading_id === m![1] && x.audience === (ctx.kid ? "kids" : "adults"));
      if (!r) return fail(404, "READING_NOT_AVAILABLE");
      const view = this.readingView(r, owner);
      if (!m[2] && method === "GET") return ok(view);
      if (m[2] && method === "POST") return this.lessons.startReading(owner, ctx.kid, view, r.questions, headers["idempotency-key"]);
    }

    // ---- pronunciation ----
    if (key === "POST /v1/memory/pronunciation") return this.pronounce(q, headers, ctx);

    // ---- the parent's switch for a child profile ----
    m = /^\/v1\/learners\/([0-9a-z-]{36})\/voice-consent$/.exec(path);
    if (m && method === "PUT") {
      if (ctx.kid || ctx.account.age_band !== "18+") return fail(403, "ADULT_REQUIRED");
      const l = ctx.setChildVoice(m[1]!, b.granted === true);
      return l ? ok(l) : fail(404, "LEARNER_NOT_FOUND");
    }
    return null;
  }

  private readingView(r: ReadingDef, owner: string): ReadingView {
    const mine = this.own(owner);
    return { ...r.view, glossary: r.view.glossary.map((g) => ({ ...g, in_dictionary: mine.find((c) => norm(c.text_en) === norm(g.en))?.card_id ?? null })) };
  }

  /** memory → catalog glossary/lookup: the version is published and the text occurs in that sentence. */
  private findInContent(src: ContentRef, text: string, ctx: MemoryCtx): { status: number; code?: string; sentence?: string; title?: Localized } {
    if (src.kind !== "reading") return { status: 404, code: "CONTENT_NOT_FOUND" };
    const r = READINGS.find((x) => x.view.reading_id === src.key && x.view.version === src.version && x.audience === (ctx.kid ? "kids" : "adults"));
    if (!r) return { status: 404, code: "CONTENT_NOT_FOUND" };
    const s = r.view.paragraphs.flatMap((p) => p.sentences).find((x) => x.s_id === src.locator);
    if (!s) return { status: 404, code: "CONTENT_NOT_FOUND" };
    const hay = ` ${norm(s.text_en).replace(/[^a-z' é-]+/g, " ")} `;
    if (!text.trim() || !hay.includes(` ${norm(text)} `)) return { status: 422, code: "WORD_NOT_IN_CONTENT" };
    return { status: 200, sentence: s.text_en, title: r.view.title };
  }

  private pronounce(q: URLSearchParams, headers: Record<string, string>, ctx: MemoryCtx): Res {
    this.pronCalls += 1;
    const target = q.get("target") ?? "";
    const raw = ctx.raw;
    if ((headers["content-type"] ?? "").split(";")[0] !== "audio/wav" || !raw) return fail(422, "AUDIO_INVALID", { reason: "format" });
    if (raw.length > 600_000) return fail(422, "AUDIO_INVALID", { reason: "too_large" });
    // the BFF checks the RIFF header before anything is sent further (INTERNAL_API §8)
    if (raw.length < 44 || raw.toString("ascii", 0, 4) !== "RIFF" || raw.toString("ascii", 8, 12) !== "WAVE" || raw.toString("ascii", 36, 40) !== "data") return fail(422, "AUDIO_INVALID", { reason: "format" });
    const channels = raw.readUInt16LE(22);
    const rate = raw.readUInt32LE(24);
    const bits = raw.readUInt16LE(34);
    const dataBytes = raw.readUInt32LE(40);
    if (raw.readUInt16LE(20) !== 1 || channels !== 1 || rate !== 16000 || bits !== 16) return fail(422, "AUDIO_INVALID", { reason: "format" });
    const durationMs = Math.round((dataBytes / 2 / 16000) * 1000);
    this.lastWav = { bytes: raw.length, rate, channels, bits, durationMs };
    if (durationMs < 500) return fail(422, "AUDIO_INVALID", { reason: "too_short" });
    if (durationMs > 15_000) return fail(422, "AUDIO_INVALID", { reason: "too_long" });
    const p = this.pronunciation(ctx);
    if (p === "consent_self") return fail(403, "VOICE_CONSENT_REQUIRED", { who: "self" });
    if (p === "consent_guardian") return fail(403, "VOICE_CONSENT_REQUIRED", { who: "guardian" });
    if (p === "unavailable") return fail(503, "SPEECH_UNAVAILABLE", { service: "memory" });
    let reference = "";
    const card = /^card:([0-9a-z-]{36})$/.exec(target);
    const sent = /^sentence:reading:([a-z0-9-]+):(\d+):([a-z0-9]+)$/.exec(target);
    if (card) {
      const c = this.cards.get(card[1]!);
      if (!c || c.owner !== ctx.owner || c.archived) return fail(404, "CARD_NOT_FOUND");
      reference = c.error ? c.error.correction : c.text_en;
      c.last_pronunciation = { at: iso(Date.now()), intelligibility: this.sc.pronResult === "insufficient_evidence" ? null : "mostly_clear" };
    } else if (sent) {
      const r = READINGS.find((x) => x.view.reading_id === sent[1] && x.view.version === Number(sent[2]));
      const s = r?.view.paragraphs.flatMap((pp) => pp.sentences).find((x) => x.s_id === sent[3]);
      if (!s) return fail(404, "CONTENT_NOT_FOUND");
      reference = s.text_en;
    } else return fail(422, "VALIDATION_ERROR", { in: "query", field: "target" });
    if (this.sc.pronResult === "insufficient_evidence") {
      const v: PronunciationView = {
        attempt_id: this.id("a77e0000"),
        status: "insufficient_evidence",
        reference_text: reference,
        intelligibility: null,
        score: null,
        words: [],
        tips: [],
        message: L("Не удалось оценить — говорите ближе к микрофону", "Baholab boʻlmadi — mikrofonga yaqinroq gapiring"),
      };
      return ok(v);
    }
    const words = reference.split(/\s+/).map((w) => w.replace(/[^A-Za-z’'-]/g, "")).filter(Boolean);
    const view: PronunciationView = {
      attempt_id: this.id("a77e0000"),
      status: "ok",
      reference_text: reference,
      intelligibility: "mostly_clear",
      score: 78,
      words: words.map((w, i) => ({ word: w, accuracy: i === 1 ? 48 : i === words.length - 1 && words.length > 2 ? null : 92, error_type: i === 1 ? ("mispronunciation" as const) : i === words.length - 1 && words.length > 2 ? ("omission" as const) : ("none" as const) })),
      tips: words[1] ? [{ word: words[1], text: ctx.lang === "uz" ? "Unli tovushni choʻzib ayting." : "Протяните гласный звук чуть дольше." }] : [],
      message: null,
    };
    return ok(view);
  }
}
