import type {
  Appeal,
  EvaluationView,
  LessonCardDetail,
  LessonHistoryItem,
  LessonSession,
  LessonStep,
  LessonSummary,
  ReadingView,
  SessionStage,
  StepResult,
  Trajectory,
} from "@tilhero/contracts/bff";
import type { SessionKind } from "@tilhero/contracts/ai";
import type { Localized } from "@tilhero/contracts/content";

/**
 * Sprint 4 part of the mock telegram-bff (bff.ts «Спринт 4»): a small lesson engine with server-side state — the
 * session status machine, steps in order (409 STEP_NOT_CURRENT), the same answer to the same step answered the same way,
 * a roleplay graph (choices and free text by keywords, a clarification after an unclear answer, only choices after two,
 * outcomes success / alt_success / fail with one retry), the check without hints (no correctness until the summary),
 * the summary with an evaluation by rules, appeals and their decision, history. Children: kids content, choices only,
 * free text → 403 KIDS_NOT_ALLOWED. Pure TS — used by Playwright (mock-bff.ts) and by vitest (screens tests).
 */
export interface LessonsScenario {
  /** AI unavailable (budget, emergency stop): ai_degraded, choices only */
  aiDegraded?: boolean;
  /** an unfinished session exists at start */
  active?: "paused" | "in_progress";
  /** finish → evaluation null («оценка появится позже») */
  evaluationLater?: boolean;
  /** with evaluationLater: the evaluation is ready at this GET of the summary (1 — the first re-read) */
  evaluationAfterReads?: number;
  /** a completed lesson in the history, its appeal decided this way */
  decided?: "upheld" | "corrected";
  /** with decided: how long ago (default 2 days); more than 90 — the appeal text and the error fragments are erased
   *  (reason null, evidence and correction "") */
  decidedDaysAgo?: number;
  /** lessons answers 409 AI_BUSY this many times (the same answer is still processed) to a free text / «проще» */
  aiBusy?: number;
  /** a completed lesson in the history, evaluated this many days ago, no appeal (the 14-day appeal window) */
  evaluatedDaysAgo?: number;
  /** the AI goes away on the first free text of the roleplay (budget reached): «Let's choose an answer», choices only,
   *  the session becomes ai_degraded (lessons flow.py) */
  aiDropsOnText?: boolean;
  /** the listening step of a media session has the audio file (has_audio; the bytes — GET /v1/media/m-own-coffee/audio) */
  listenFile?: boolean;
  /** sprint 8 (paywall, BILLING_ENFORCED): a lesson / scenario of a learner 14+ goes with ready replies by the plan */
  aiLocked?: "no_subscription" | "feature_not_in_plan" | "minutes_exhausted" | "billing_unavailable";
  /** sprint 8: AI minutes left after the hold on a lesson / scenario with AI («ИИ: осталось N мин») */
  aiMinutesLeft?: number;
}

const L = (ru: string, uz: string): Localized => ({ ru, uz });
const DAY = 24 * 3600_000;
const STAGES5: Array<{ type: "retrieval" | "explanation" | "roleplay" | "assessment" | "summary"; minutes: number }> = [
  { type: "retrieval", minutes: 3 },
  { type: "explanation", minutes: 4 },
  { type: "roleplay", minutes: 8 },
  { type: "assessment", minutes: 3 },
  { type: "summary", minutes: 2 },
];

type Key = number | string | string[];
interface ItemDef {
  item_id: string;
  item_type: Extract<LessonStep, { type: "item" }>["item"]["item_type"];
  instruction: Localized;
  prompt_en: string;
  options: string[];
  key: Key;
  right: string;
  hint?: Localized;
}
interface Node {
  speaker: string;
  line: string;
  gloss: Localized;
  clarify: string;
  hint: Localized;
  /** choice → next node or end */
  to: Array<{ id: string; text: string; next: string; words: string[] }>;
}
interface Graph {
  scenario_id: string;
  character: { id: string; name: string; role: Localized; voice: "en-GB" | "en-US" };
  start: string;
  nodes: Record<string, Node>;
  ends: Record<string, { outcome: "success" | "alt_success" | "fail"; line: string; gloss: Localized; summary: Localized }>;
}
type Def =
  | { kind: "notice"; stage: SessionStage; text: Localized }
  | { kind: "explanation"; stage: SessionStage; instructions: Localized; examples: Array<{ en: string; gloss: Localized }>; key_words: Array<{ en: string; gloss: Localized; example_en: string }>; simpler: Array<{ en: string; gloss: Localized }> }
  | { kind: "item"; stage: SessionStage; item: ItemDef; graded: boolean }
  | { kind: "roleplay"; graph: Graph }
  | { kind: "roleplay_end" }
  | { kind: "listen"; stage: SessionStage }
  | { kind: "open_answer"; prompt: Localized }
  /** sprint 5: the text of a reading session (then the questions — items of the stage "questions", graded later) */
  | { kind: "reading"; reading: ReadingView }
  | { kind: "done" };

/** A question to a reading text (mock catalog): single_choice / true_false (as single_choice ["True","False"]) / gap_fill. */
export interface ReadingQuestionDef {
  item_id: string;
  item_type: "single_choice" | "gap_fill";
  instruction: Localized;
  prompt_en: string;
  options: string[];
  key: number | string;
  right: string;
}

/* ---------------------------------------------------------------- content */

const CAFE: Graph = {
  scenario_id: "sc-cafe-order",
  character: { id: "tom", name: "Tom", role: L("Официант", "Ofitsiant"), voice: "en-GB" },
  start: "n1",
  nodes: {
    n1: {
      speaker: "tom",
      line: "Hi! What can I get you?",
      gloss: L("Привет! Что вам принести?", "Salom! Sizga nima olib kelay?"),
      clarify: "Sorry, what would you like to drink?",
      hint: L("Попросите вежливо: I’d like a …, please.", "Xushmuomala soʻrang: I’d like a …, please."),
      to: [
        { id: "c1", text: "I’d like a latte, please.", next: "n2", words: ["like", "latte", "coffee", "tea", "could"] },
        { id: "c2", text: "Give me coffee. Now.", next: "end_fail", words: ["give me", "now"] },
      ],
    },
    n2: {
      speaker: "tom",
      line: "Sure! Anything else?",
      gloss: L("Конечно! Что-нибудь ещё?", "Albatta! Yana biror narsa?"),
      clarify: "Sorry? Would you like anything else?",
      hint: L("Попросите счёт: Could I have the bill?", "Hisobni soʻrang: Could I have the bill?"),
      to: [
        { id: "c3", text: "No, thanks. Could I have the bill?", next: "end_ok", words: ["bill", "check"] },
        { id: "c4", text: "That’s all, thank you.", next: "end_alt", words: ["all", "thank"] },
      ],
    },
  },
  ends: {
    end_ok: { outcome: "success", line: "Here is your bill. Have a nice day!", gloss: L("Вот ваш счёт. Хорошего дня!", "Mana hisobingiz. Kuningiz xayrli oʻtsin!"), summary: L("Вы заказали латте и вежливо попросили счёт.", "Latte buyurtma qildingiz va hisobni xushmuomala soʻradingiz.") },
    end_alt: { outcome: "alt_success", line: "Great, enjoy your latte!", gloss: L("Отлично, приятного латте!", "Ajoyib, latte yoqimli boʻlsin!"), summary: L("Заказ сделан, но счёт вы не попросили.", "Buyurtma qilindi, lekin hisobni soʻramadingiz.") },
    end_fail: { outcome: "fail", line: "Hmm… I’ll come back later.", gloss: L("Хм… Я подойду позже.", "Hmm… Keyinroq kelaman."), summary: L("Официант обиделся на резкую просьбу.", "Ofitsiant qoʻpol iltimosdan xafa boʻldi.") },
  },
};

const ZOO: Graph = {
  scenario_id: "sc-kids-zoo",
  character: { id: "max", name: "Max", role: L("Смотритель зоопарка", "Hayvonot bogʻi xodimi"), voice: "en-GB" },
  start: "n1",
  nodes: {
    n1: {
      speaker: "max",
      line: "Look! What is this animal?",
      gloss: L("Смотри! Что это за животное?", "Qara! Bu qanday hayvon?"),
      clarify: "Is it a lion or a tiger?",
      hint: L("Это лев — a lion.", "Bu sher — a lion."),
      to: [
        { id: "c1", text: "It’s a lion!", next: "n2", words: ["lion"] },
        { id: "c2", text: "It’s a fish!", next: "n1b", words: ["fish"] },
      ],
    },
    n1b: {
      speaker: "max",
      line: "Hmm, look again. It has a big mane!",
      gloss: L("Посмотри ещё раз. У него большая грива!", "Yana qara. Uning katta yoli bor!"),
      clarify: "A lion or a fish?",
      hint: L("У льва есть грива.", "Sherning yoli bor."),
      to: [{ id: "c3", text: "Oh! It’s a lion!", next: "n2", words: ["lion"] }],
    },
    n2: {
      speaker: "max",
      line: "Yes! What colour is it?",
      gloss: L("Да! Какого он цвета?", "Ha! U qanday rangda?"),
      clarify: "Is it yellow?",
      hint: L("Жёлтый — yellow.", "Sariq — yellow."),
      to: [
        { id: "c4", text: "It’s yellow!", next: "end_ok", words: ["yellow"] },
        { id: "c5", text: "It’s blue!", next: "end_alt", words: ["blue"] },
      ],
    },
  },
  ends: {
    end_ok: { outcome: "success", line: "Great job! You know animals!", gloss: L("Молодец! Ты знаешь животных!", "Barakalla! Sen hayvonlarni bilasan!"), summary: L("Ты назвал животное и его цвет.", "Hayvonni va uning rangini aytding.") },
    end_alt: { outcome: "alt_success", line: "Ha-ha, a blue lion! Funny!", gloss: L("Ха-ха, синий лев! Смешно!", "Ha-ha, koʻk sher! Kulgili!"), summary: L("Ты назвал животное — цвет повторим.", "Hayvonni aytding — rangni takrorlaymiz.") },
    end_fail: { outcome: "fail", line: "Let’s try again later!", gloss: L("Попробуем позже!", "Keyinroq urinamiz!"), summary: L("Попробуем ещё раз.", "Yana urinib koʻramiz.") },
  },
};

const ITEMS = {
  bill: { item_id: "r-bill", item_type: "single_choice", instruction: L("Выберите перевод", "Tarjimani tanlang"), prompt_en: "the bill", options: ["счёт", "чек", "очередь"], key: 0, right: "счёт", hint: L("Его просят в конце ужина.", "Uni kechki ovqat oxirida soʻraydilar.") },
  order: { item_id: "r-order", item_type: "order_words", instruction: L("Соберите вопрос «Можно мне счёт?»", "«Hisobni bersangiz?» savolini tuzing"), prompt_en: "Put the words in order", options: ["the", "Could", "bill?", "I", "have"], key: ["Could", "I", "have", "the", "bill?"], right: "Could I have the bill?", hint: L("Начните с Could.", "Could bilan boshlang.") },
  meaning: { item_id: "m-like", item_type: "meaning_check", instruction: L("Проверим понимание", "Tushunishni tekshiramiz"), prompt_en: "What does «I’d like» mean?", options: ["я бы хотел", "мне нравится", "я люблю"], key: 0, right: "я бы хотел" },
  gap: { item_id: "a-gap", item_type: "gap_fill", instruction: L("Впишите пропущенное слово", "Tushib qolgan soʻzni yozing"), prompt_en: "I’d ___ a tea, please.", options: [], key: "like", right: "like" },
  trans: { item_id: "a-trans", item_type: "translate_choice", instruction: L("Выберите перевод фразы", "Ibora tarjimasini tanlang"), prompt_en: "Could I have some water?", options: ["Можно мне воды?", "Где вода?", "У меня есть вода."], key: 0, right: "Можно мне воды?" },
  kidColour: { item_id: "k-colour", item_type: "single_choice", instruction: L("Выбери перевод", "Tarjimani tanla"), prompt_en: "yellow", options: ["жёлтый", "синий", "красный"], key: 0, right: "жёлтый" },
  mxWhat: { item_id: "mx-what", item_type: "comprehension", instruction: L("Что заказал Азиз?", "Aziz nima buyurtma qildi?"), prompt_en: "What did Aziz order?", options: ["a tea", "a latte to go", "a cake"], key: 1, right: "a latte to go" },
  mxLines: { item_id: "mx-lines", item_type: "order_lines", instruction: L("Расставьте реплики по порядку", "Replikalarni tartib bilan joylashtiring"), prompt_en: "Put the lines in order", options: ["A latte to go, please.", "Hi! What would you like?"], key: ["Hi! What would you like?", "A latte to go, please."], right: "Hi! What would you like? / A latte to go, please." },
  mxGap: { item_id: "mx-gap", item_type: "gap_fill_media", instruction: L("Выберите пропущенное слово", "Tushib qolgan soʻzni tanlang"), prompt_en: "A latte ___ go, please.", options: ["to", "for", "at"], key: "to", right: "to" },
  mxPhrase: { item_id: "mx-phrase", item_type: "phrase_meaning", instruction: L("Что значит фраза?", "Ibora nimani anglatadi?"), prompt_en: "to go", options: ["с собой", "идти", "уйти"], key: 0, right: "с собой" },
} satisfies Record<string, ItemDef>;

const EXPLAIN: Extract<Def, { kind: "explanation" }> = {
  kind: "explanation",
  stage: "explanation",
  instructions: L(
    "«I want» в кафе звучит резко. Вежливо — I’d like (я бы хотел) или Could I have…? (можно мне…?).",
    "Kafeda «I want» qoʻpol eshitiladi. Xushmuomala — I’d like (men … xohlardim) yoki Could I have…? (menga … bersangiz?).",
  ),
  examples: [
    { en: "I’d like the soup, please.", gloss: L("Мне суп, пожалуйста.", "Menga shoʻrva, iltimos.") },
    { en: "Could I have some water?", gloss: L("Можно мне воды?", "Menga suv bersangiz?") },
    { en: "We’d like to order now.", gloss: L("Мы хотели бы заказать.", "Biz hozir buyurtma bermoqchimiz.") },
  ],
  key_words: [
    { en: "I’d like", gloss: L("я бы хотел", "men … xohlardim"), example_en: "I’d like a latte." },
    { en: "the bill", gloss: L("счёт", "hisob"), example_en: "Could I have the bill?" },
    { en: "to go", gloss: L("с собой", "olib ketish uchun"), example_en: "A coffee to go, please." },
  ],
  simpler: [
    { en: "I’d like a tea.", gloss: L("Мне чай.", "Menga choy.") },
    { en: "Could I have a cake?", gloss: L("Можно мне пирожное?", "Menga pirojniy bersangiz?") },
  ],
};

const KIDS_EXPLAIN: Extract<Def, { kind: "explanation" }> = {
  kind: "explanation",
  stage: "explanation",
  instructions: L("Животные по-английски: a lion — лев, a cat — кошка. Цвет говорим так: It’s yellow!", "Hayvonlar inglizcha: a lion — sher, a cat — mushuk. Rangni shunday aytamiz: It’s yellow!"),
  examples: [{ en: "It’s a lion!", gloss: L("Это лев!", "Bu sher!") }],
  key_words: [{ en: "yellow", gloss: L("жёлтый", "sariq"), example_en: "It’s yellow!" }],
  simpler: [{ en: "It’s a cat!", gloss: L("Это кошка!", "Bu mushuk!") }],
};

function lessonPlan(kids: boolean, full: boolean): Def[] {
  if (kids) {
    return [
      { kind: "notice", stage: "retrieval", text: L("Повторять пока нечего — сразу к новому.", "Hozircha takrorlash yoʻq — yangisiga oʻtamiz.") },
      KIDS_EXPLAIN,
      { kind: "roleplay", graph: ZOO },
      { kind: "roleplay_end" },
      { kind: "item", stage: "assessment", item: ITEMS.kidColour, graded: true },
      { kind: "done" },
    ];
  }
  return [
    { kind: "item", stage: "retrieval", item: ITEMS.bill, graded: false },
    { kind: "item", stage: "retrieval", item: ITEMS.order, graded: false },
    EXPLAIN,
    { kind: "item", stage: "explanation", item: ITEMS.meaning, graded: false },
    { kind: "roleplay", graph: CAFE },
    { kind: "roleplay_end" },
    { kind: "item", stage: "assessment", item: ITEMS.gap, graded: true },
    { kind: "item", stage: "assessment", item: ITEMS.trans, graded: true },
    ...(full ? [{ kind: "open_answer" as const, prompt: L("Напишите, как вы закажете кофе с собой и попросите счёт.", "Olib ketish uchun qahva buyurtma qilishni va hisobni soʻrashni yozing.") }] : []),
    { kind: "done" },
  ];
}

const MEDIA_PLAN: Def[] = [
  { kind: "listen", stage: "listen" },
  { kind: "item", stage: "exercises", item: ITEMS.mxWhat, graded: true },
  { kind: "item", stage: "exercises", item: ITEMS.mxLines, graded: true },
  { kind: "item", stage: "exercises", item: ITEMS.mxGap, graded: true },
  { kind: "item", stage: "exercises", item: ITEMS.mxPhrase, graded: true },
  { kind: "done" },
];

/* ---------------------------------------------------------------- engine */

/** assessment rules.py closed_error_code: the error type of a wrong closed item */
const closedErrorCode = (t: string): string => (t === "gap_fill" ? "gap_fill" : t === "order_words" ? "word_order" : t === "order_lines" ? "line_order" : "wrong_choice");

/** lessons flow.py: the reply when the AI is unavailable on a free text */
const LETS_CHOOSE = { en: "Let's choose an answer.", gloss: L("Давайте выберем ответ", "Keling, javobni tanlaymiz") };

interface Turn {
  turn_id: string;
  speaker: "learner" | "character";
  text_en: string;
  character_id: string | null;
}

interface Run {
  view: LessonSession;
  owner: string;
  kids: boolean;
  plan: Def[];
  pi: number;
  emitted: LessonStep[];
  results: Map<string, StepResult>;
  answers: Map<string, { item: ItemDef; value: unknown; hinted: boolean; correct: boolean; stage: SessionStage }>;
  rp: { graph: Graph; node: string; unclear: number; hints: number; turns: Turn[]; outcome: "success" | "alt_success" | "fail" | null; retried: boolean; texts: string[] } | null;
  hinted: Set<string>;
  simplerAt: number;
  openText: string | null;
  summary: LessonSummary | null;
  sourceSession?: string;
  /** the AI went away during this session (aiDropsOnText) */
  aiOff?: boolean;
  /** GETs of the summary while the evaluation is not there (evaluationAfterReads) */
  summaryReads?: number;
}

const isOpenSt = (s: LessonSession["status"]) => s === "ready" || s === "in_progress" || s === "paused";

export type Res = { status: number; body?: unknown; code?: string; details?: Record<string, unknown> };
const ok = (body: unknown, status = 200): Res => ({ status, body });
const fail = (status: number, code: string, details: Record<string, unknown> = {}): Res => ({ status, code, details });

export class MockLessons {
  readonly sc: LessonsScenario;
  runs = new Map<string, Run>();
  evaluations = new Map<string, EvaluationView & { owner: string; session_id: string }>();
  appeals = new Map<string, Appeal & { owner: string }>();
  idem = new Map<string, unknown>();
  private seq = 1;
  /** AI_BUSY answers left (LessonsScenario.aiBusy) */
  busyLeft = 0;

  constructor(sc: LessonsScenario = {}, owners: { self: string; kid?: string } = { self: "self" }) {
    this.sc = sc;
    this.busyLeft = sc.aiBusy ?? 0;
    if (sc.active) {
      const r = this.newRun(owners.self, false, "lesson", { lesson_id: "l-a1-03-cafe" });
      r.view.status = sc.active;
      r.view.started_at = new Date(Date.now() - 3600_000).toISOString();
      if (sc.active === "paused") {
        r.view.paused_at = new Date(Date.now() - 1800_000).toISOString();
        r.view.expires_at = new Date(Date.now() + 2 * DAY).toISOString();
      }
      // already answered the first step of the retrieval
      this.emit(r);
      this.answer(r, r.emitted[0]!.step_id, { answer: 0 });
    }
    if (sc.decided) this.seedDecided(owners.self, sc.decided, sc.decidedDaysAgo);
    if (sc.evaluatedDaysAgo !== undefined) this.seedCompleted(owners.self, sc.evaluatedDaysAgo);
  }

  private id(prefix = "5e550000"): string {
    return `${prefix}-aaaa-4bbb-8ccc-${String(this.seq++).padStart(12, "0")}`;
  }

  /* ---------- cards ---------- */
  card(id: string, kids: boolean, owner: string): LessonCardDetail | null {
    const meta = id === "l-a1-03-cafe" && !kids
      ? { title: L("В кафе: заказ напитков", "Kafeda: ichimlik buyurtma qilish"), goal: L("Заказать напиток и попросить счёт", "Ichimlik buyurtma qilish va hisobni soʻrash"), level: "A1" as const, skill: L("Вежливая просьба в кафе", "Kafeda xushmuomala iltimos"), skill_id: "en.func.order", scenario_id: "sc-cafe-order" }
      : id === "l-k-01-animals" && kids
        ? { title: L("Животные в зоопарке", "Hayvonot bogʻidagi hayvonlar"), goal: L("Назвать животное и его цвет", "Hayvon va uning rangini aytish"), level: "A0" as const, skill: L("Животные и цвета", "Hayvonlar va ranglar"), skill_id: "en.vocab.animals", scenario_id: "sc-kids-zoo" }
        : ["l-a1-04-shop", "l-a1-05-way", "l-opt-small-talk", "l-opt-airport"].includes(id) && !kids
          ? { title: L(`Урок ${id}`, `Dars ${id}`), goal: L("Цель урока", "Dars maqsadi"), level: "A1" as const, skill: L("Навык", "Koʻnikma"), skill_id: "en.x", scenario_id: null }
          : null;
    if (!meta) return null;
    const active = [...this.runs.values()].find((r) => r.owner === owner && isOpenSt(r.view.status) && r.view.lesson_id === id);
    return {
      lesson_id: id,
      module_id: "m-a1-02",
      title: meta.title,
      goal: meta.goal,
      level: meta.level,
      kind: "core",
      duration_min: 20,
      primary_skill_id: meta.skill_id,
      scenario_id: meta.scenario_id,
      stages: STAGES5,
      version: 3,
      primary_skill: { skill_id: meta.skill_id, title: meta.skill },
      stages_detail: STAGES5.map((s) => ({
        ...s,
        instructions:
          s.type === "retrieval"
            ? L("2 фразы из прошлых уроков", "Oʻtgan darslardan 2 ibora")
            : s.type === "explanation"
              ? L("I’d like и Could I…?", "I’d like va Could I…?")
              : s.type === "roleplay"
                ? L("Вы — гость в кафе, Том — официант", "Siz kafedagi mehmonsiz, Tom — ofitsiant")
                : s.type === "assessment"
                  ? L("Новая похожая ситуация — без подсказок", "Oʻxshash yangi vaziyat — yordamsiz")
                  : L("Ошибки, слова и следующее повторение", "Xatolar, soʻzlar va keyingi takrorlash"),
      })),
      key_words_count: 6,
      // as lessons: choices for a child and when the AI is off (emergency stop, budget)
      roleplay_mode: meta.scenario_id ? (kids || this.sc.aiDegraded ? "choices" : "full") : null,
      available: true,
      unavailable_reason: null,
      active_session_id: active?.view.session_id ?? null,
    };
  }

  /* ---------- sessions ---------- */
  private newRun(owner: string, kids: boolean, kind: SessionKind, ref: { lesson_id?: string; scenario_id?: string; asset_id?: string; title?: Localized }, plan?: Def[]): Run {
    const paywalled = !kids && (kind === "lesson" || kind === "scenario");
    const locked = paywalled ? (this.sc.aiLocked ?? null) : null;
    const full = !kids && !this.sc.aiDegraded && !locked;
    const p = plan ?? (kind === "lesson" ? lessonPlan(kids, full) : kind === "scenario" ? [{ kind: "roleplay" as const, graph: kids ? ZOO : CAFE }, { kind: "roleplay_end" as const }, { kind: "done" as const }] : MEDIA_PLAN);
    const stageTypes: SessionStage[] =
      kind === "lesson"
        ? STAGES5.map((s) => s.type)
        : kind === "scenario"
          ? ["roleplay", "summary"]
          : kind === "media"
            ? ["listen", "exercises", "summary"]
            : kind === "reading"
              ? ["reading", "questions", "summary"]
              : ["assessment", "summary"];
    const title = ref.title ?? (
      kind === "lesson"
        ? kids
          ? L("Животные в зоопарке", "Hayvonot bogʻidagi hayvonlar")
          : L("В кафе: заказ напитков", "Kafeda: ichimlik buyurtma qilish")
        : kind === "scenario"
          ? kids
            ? L("В зоопарке", "Hayvonot bogʻida")
            : L("Заказ в кафе", "Kafeda buyurtma")
          : kind === "media"
            ? L("Кофе с собой", "Olib ketish uchun qahva")
            : L("Повторение: В кафе", "Takrorlash: Kafeda"));
    const view: LessonSession = {
      session_id: this.id(),
      kind,
      title,
      lesson_id: ref.lesson_id ?? null,
      scenario_id: ref.scenario_id ?? null,
      asset_id: ref.asset_id ?? null,
      status: "ready",
      stage: stageTypes[0]!,
      stages: stageTypes.map((t, i) => ({ type: t, status: i === 0 ? "current" : "pending" })),
      ai_mode: full ? "full" : "choices",
      ai_degraded: !!this.sc.aiDegraded,
      started_at: null,
      paused_at: null,
      finished_at: null,
      expires_at: null,
      minutes: 0,
      // спринт 8: пэйвол — урок «вариантами» по тарифу или остаток ИИ-минут после удержания
      ai_locked: locked ? { reason: locked } : null,
      ai_minutes_left: paywalled && !locked && full && this.sc.aiMinutesLeft != null ? this.sc.aiMinutesLeft : null,
    };
    const r: Run = { view, owner, kids, plan: p, pi: 0, emitted: [], results: new Map(), answers: new Map(), rp: null, hinted: new Set(), simplerAt: 0, openText: null, summary: null };
    this.runs.set(view.session_id, r);
    return r;
  }

  private stageOf(d: Def): SessionStage {
    if (d.kind === "reading") return "reading";
    if (d.kind === "roleplay" || d.kind === "roleplay_end") return "roleplay";
    if (d.kind === "open_answer") return "assessment";
    if (d.kind === "done") return "summary";
    return d.stage;
  }

  /** The step for plan position pi (emitted once; the roleplay emits a step per node and per clarification). */
  private emit(r: Run): LessonStep {
    const d = r.plan[Math.min(r.pi, r.plan.length - 1)]!;
    const stage = this.stageOf(d);
    const same = r.plan.filter((x) => this.stageOf(x) === stage && x.kind !== "roleplay_end");
    const position = Math.max(1, same.indexOf(d) + 1);
    const base = { step_id: `s${r.emitted.length + 1}`, stage, position: d.kind === "roleplay" || d.kind === "roleplay_end" ? 1 : position, stage_total: d.kind === "roleplay" || d.kind === "roleplay_end" ? 1 : Math.max(1, same.length) };
    let step: LessonStep;
    switch (d.kind) {
      case "notice":
        step = { ...base, type: "notice", text: d.text };
        break;
      case "explanation":
        step = { ...base, type: "explanation", instructions: d.instructions, examples: d.examples, key_words: d.key_words, can_simplify: true };
        break;
      case "item":
        step = {
          ...base,
          type: "item",
          item: { item_id: d.item.item_id, item_type: d.item.item_type, instruction: d.item.instruction, prompt_en: d.item.prompt_en, options: [...d.item.options] },
          hint_available: !d.graded && !!d.item.hint,
          hints_used: r.hinted.has(d.item.item_id) ? 1 : 0,
          graded_later: d.graded,
        };
        break;
      case "roleplay": {
        r.rp ??= { graph: d.graph, node: d.graph.start, unclear: 0, hints: 0, turns: [], outcome: null, retried: false, texts: [] };
        const g = r.rp.graph;
        const n = g.nodes[r.rp.node]!;
        const last = r.rp.turns[r.rp.turns.length - 1];
        if (!last || last.speaker === "learner" || (last.text_en !== n.line && last.text_en !== n.clarify)) {
          r.rp.turns.push({ turn_id: `T${r.rp.turns.length + 1}`, speaker: "character", text_en: n.line, character_id: g.character.id });
        }
        const free = !r.kids && !this.sc.aiDegraded && !r.aiOff && r.view.ai_mode === "full";
        step = {
          ...base,
          type: "roleplay",
          node_id: r.rp.node,
          character: g.character,
          line_en: n.line,
          gloss: n.gloss,
          choices: n.to.map((c) => ({ choice_id: c.id, text_en: c.text })),
          free_text_allowed: free && r.rp.unclear < 2,
          hint_available: true,
          hints_used: r.rp.hints,
          history: r.rp.turns.slice(-6),
          unclear_attempts: r.rp.unclear,
        };
        break;
      }
      case "roleplay_end": {
        const g = r.rp!.graph;
        const end = Object.values(g.ends).find((e) => e.outcome === r.rp!.outcome)!;
        step = { ...base, type: "roleplay_end", outcome: r.rp!.outcome!, summary: end.summary, can_retry: r.rp!.outcome === "fail" && !r.rp!.retried };
        break;
      }
      case "listen":
        step = {
          ...base,
          type: "listen",
          asset_id: "m-own-coffee",
          title: L("Кофе с собой", "Olib ketish uchun qahva"),
          has_audio: !!this.sc.listenFile,
          transcript: [
            { speaker: "Barista", text_en: "Hi! What would you like?", gloss: L("Привет! Что будете?", "Salom! Nima olasiz?") },
            { speaker: "Aziz", text_en: "A latte to go, please.", gloss: L("Латте с собой, пожалуйста.", "Olib ketish uchun latte, iltimos.") },
          ],
          voices: { Barista: "en-GB", Aziz: "en-US" },
          can_listen: true,
        };
        break;
      case "open_answer":
        step = { ...base, type: "open_answer", prompt: d.prompt, max_length: 300 };
        break;
      case "reading":
        step = { ...base, type: "reading", reading: d.reading };
        break;
      case "done":
        step = { ...base, type: "done" };
        break;
    }
    r.emitted.push(step);
    r.view.stage = stage;
    const at = r.view.stages.findIndex((s) => s.type === stage);
    r.view.stages = r.view.stages.map((s, i) => ({ type: s.type, status: s.status === "skipped" ? "skipped" : i < at ? "done" : i === at ? "current" : "pending" }));
    return step;
  }

  current(r: Run): LessonStep {
    const last = r.emitted[r.emitted.length - 1];
    if (last && !r.results.has(last.step_id)) return last;
    return this.emit(r);
  }

  private check(item: ItemDef, value: unknown): boolean {
    if (Array.isArray(item.key)) return Array.isArray(value) && value.join(" ") === item.key.join(" ");
    if (typeof item.key === "string") return typeof value === "string" && value.trim().toLowerCase().replace(/[.!?]+$/, "") === item.key.toLowerCase();
    return value === item.key || (typeof value === "string" && value === item.options[item.key]);
  }

  answer(r: Run, stepId: string, b: Record<string, unknown>): Res {
    const done = r.results.get(stepId);
    if (done) return ok(done);
    const step = this.current(r);
    if (step.step_id !== stepId) return fail(409, "STEP_NOT_CURRENT", { current_step_id: step.step_id });
    const d = r.plan[r.pi]!;
    let feedback: StepResult["feedback"] = null;
    let reply: StepResult["reply"] = null;
    if (d.kind === "item") {
      const value = b.dont_know ? null : b.answer;
      const correct = value !== null && value !== undefined && this.check(d.item, value);
      r.answers.set(d.item.item_id, { item: d.item, value, hinted: r.hinted.has(d.item.item_id), correct, stage: d.stage });
      if (!d.graded) feedback = { correct, correct_answer: correct ? null : d.item.right };
      r.pi += 1;
    } else if (d.kind === "roleplay") {
      const rp = r.rp!;
      const n = rp.graph.nodes[rp.node]!;
      let to = typeof b.choice_id === "string" ? n.to.find((c) => c.id === b.choice_id) : undefined;
      if (typeof b.choice_id === "string" && !to) return fail(422, "ANSWER_INVALID", { field: "choice_id" });
      let said = to?.text ?? "";
      if (typeof b.text === "string") {
        if (r.kids) return fail(403, "KIDS_NOT_ALLOWED");
        if (!(step.type === "roleplay" && step.free_text_allowed)) return fail(409, "FREE_TEXT_NOT_ALLOWED");
        said = b.text.trim();
        rp.texts.push(said);
        const low = said.toLowerCase();
        to = n.to.find((c) => c.words.some((w) => low.includes(w)));
      }
      rp.turns.push({ turn_id: `T${rp.turns.length + 1}`, speaker: "learner", text_en: said, character_id: null });
      if (typeof b.text === "string" && this.sc.aiDropsOnText && !r.aiOff) {
        // the AI is unavailable: the learner does not see an error — the same node by choices, the session degraded
        r.aiOff = true;
        r.view.ai_degraded = true;
        rp.turns.push({ turn_id: `T${rp.turns.length + 1}`, speaker: "character", text_en: LETS_CHOOSE.en, character_id: rp.graph.character.id });
        reply = { character_id: rp.graph.character.id, text_en: LETS_CHOOSE.en, gloss: LETS_CHOOSE.gloss, clarification: true };
      } else if (!to) {
        rp.unclear += 1;
        rp.turns.push({ turn_id: `T${rp.turns.length + 1}`, speaker: "character", text_en: n.clarify, character_id: rp.graph.character.id });
        reply = { character_id: rp.graph.character.id, text_en: n.clarify, gloss: null, clarification: true };
      } else if (rp.graph.ends[to.next]) {
        const end = rp.graph.ends[to.next]!;
        rp.outcome = end.outcome;
        rp.turns.push({ turn_id: `T${rp.turns.length + 1}`, speaker: "character", text_en: end.line, character_id: rp.graph.character.id });
        reply = { character_id: rp.graph.character.id, text_en: end.line, gloss: end.gloss, clarification: false };
        r.pi += 1;
      } else {
        rp.node = to.next;
        rp.unclear = 0;
        const nn = rp.graph.nodes[to.next]!;
        reply = { character_id: rp.graph.character.id, text_en: nn.line, gloss: nn.gloss, clarification: false };
      }
    } else if (d.kind === "open_answer") {
      if (typeof b.text !== "string" || !b.text.trim()) {
        if (!b.dont_know) return fail(422, "ANSWER_INVALID", { field: "text" });
      } else {
        if (r.kids) return fail(403, "KIDS_NOT_ALLOWED");
        r.openText = b.text.trim();
      }
      r.pi += 1;
    } else if (d.kind === "done") {
      return fail(409, "SESSION_STATE", { status: r.view.status });
    } else {
      r.pi += 1;
    }
    r.view.minutes = Math.min(40, r.view.minutes + 1);
    // the step is answered first: the next one is a new step (a clarification stays on the node with a new step)
    const result: StepResult = { accepted: true, feedback, reply, next: step };
    r.results.set(stepId, result);
    result.next = this.current(r);
    return ok(result);
  }

  /* ---------- summary ---------- */
  private finish(r: Run, evaluated = !this.sc.evaluationLater): LessonSummary {
    const graded = [...r.answers.values()].filter((a) => a.stage === "assessment" || a.stage === "exercises" || a.stage === "questions");
    const rp = r.rp;
    const reading = r.view.kind === "reading";
    const practice = r.view.kind === "review" || reading;
    const right = graded.filter((a) => a.correct).length;
    const ratio = graded.length ? right / graded.length : 1;
    const task = rp?.outcome === "success" ? 3 : rp?.outcome === "alt_success" ? 2 : rp?.outcome === "fail" ? 1 : null;
    const usedText = !!rp?.texts.length || !!r.openText;
    const hints = (rp?.hints ?? 0) + [...r.answers.values()].filter((a) => a.hinted).length;
    const errors: EvaluationView["key_errors"] = [];
    for (const t of rp?.texts ?? []) {
      if (/\bi want\b/i.test(t)) errors.push({ turn_id: "T2", evidence: t.slice(0, 120), correction: t.replace(/\bI want\b/i, "I’d like"), error_code: "vocabulary", severity: "high" });
    }
    if (r.openText && /\bwant\b/i.test(r.openText)) errors.push({ turn_id: "open", evidence: r.openText.slice(0, 120), correction: r.openText.replace(/\bI want\b/i, "I’d like"), error_code: "vocabulary", severity: "medium" });
    for (const a of graded.filter((x) => !x.correct)) {
      errors.push({ turn_id: a.item.item_id, evidence: a.value === null || a.value === undefined ? "—" : Array.isArray(a.value) ? a.value.join(" ") : typeof a.value === "number" ? a.item.options[a.value] ?? String(a.value) : String(a.value), correction: a.item.right, error_code: closedErrorCode(a.item.item_type), severity: "medium" });
    }
    const scores: EvaluationView["scores"] = [];
    if (reading) {
      // assessment kind reading: only the comprehension criterion, practice only, no skill outcomes
      scores.push({ code: "comprehension", title: L("Понимание", "Tushunish"), score: graded.length ? (Math.round(ratio * 3) as 0 | 1 | 2 | 3) : null });
    } else if (r.view.kind !== "media") scores.push({ code: "task", title: L("Задача разговора", "Suhbat vazifasi"), score: task === null ? null : (task as 1 | 2 | 3) });
    if (!reading) {
      scores.push({ code: "vocabulary", title: L("Словарь", "Lugʻat"), score: usedText ? 2 : null });
      scores.push({ code: "grammar", title: L("Грамматика", "Grammatika"), score: usedText ? (errors.length ? 1 : 3) : null });
      if (r.view.kind !== "media") scores.push({ code: "independence", title: L("Самостоятельность", "Mustaqillik"), score: hints === 0 ? 3 : hints === 1 ? 2 : hints === 2 ? 1 : 0 });
      scores.push({ code: "comprehension", title: L("Понимание", "Tushunish"), score: graded.length ? (Math.round(ratio * 3) as 0 | 1 | 2 | 3) : null });
      scores.push({ code: "pronunciation", title: L("Произношение", "Talaffuz"), score: null });
    }
    const passed = practice ? null : (task === null || task >= 2) && ratio >= 2 / 3;
    const evaluation: EvaluationView | null = !evaluated
      ? null
      : {
          evaluation_id: this.id("e7a10000"),
          status: "ok",
          passed,
          task_completed: task === null ? null : task >= 2,
          scores,
          key_errors: errors.slice(0, 3),
          items: graded.map((a) => ({
            item_id: a.item.item_id,
            prompt_en: a.item.prompt_en,
            your_answer: a.value === null || a.value === undefined ? null : Array.isArray(a.value) ? a.value.join(" ") : typeof a.value === "number" ? a.item.options[a.value] ?? String(a.value) : String(a.value),
            correct: a.correct,
            hinted: a.hinted,
            correct_answer: a.correct ? null : a.item.right,
          })),
          practice_only: practice,
          rubric_version: reading ? "r-reading@1" : r.view.kind === "media" ? "r-media-a1@1" : "r-a1@2",
          evaluator: usedText ? { model_id: "fake", prompt_version: "independent_evaluator@1" } : null,
          superseded_by: null,
          appeal: null,
          created_at: new Date().toISOString(),
        };
    if (evaluation) this.evaluations.set(evaluation.evaluation_id, { ...evaluation, owner: r.owner, session_id: r.view.session_id });
    const skillTo = passed ? "demonstrated" : "learning";
    return {
      session_id: r.view.session_id,
      kind: r.view.kind,
      title: r.view.title,
      status: "completed",
      outcome: rp?.outcome ?? null,
      minutes: Math.max(1, r.view.minutes),
      evaluation,
      skills: practice || !evaluation ? [] : r.kids ? [{ skill_id: "en.vocab.animals", title: L("Животные и цвета", "Hayvonlar va ranglar"), from: "not_started", to: skillTo }] : [{ skill_id: "en.func.order", title: L("Вежливая просьба в кафе", "Kafeda xushmuomala iltimos"), from: "learning", to: skillTo }],
      key_words: reading ? [] : r.kids ? [{ en: "lion", gloss: L("лев", "sher") }, { en: "yellow", gloss: L("жёлтый", "sariq") }] : [{ en: "I’d like", gloss: L("я бы хотел", "men … xohlardim") }, { en: "the bill", gloss: L("счёт", "hisob") }, { en: "to go", gloss: L("с собой", "olib ketish uchun") }],
      next_lesson: r.view.kind === "lesson" && !r.kids ? { lesson_id: "l-a1-04-shop", module_id: "m-a1-02", title: L("В магазине: цены и размеры", "Doʻkonda: narx va oʻlchamlar"), goal: L("Спросить цену и размер", "Narx va oʻlchamni soʻrash"), level: "A1", kind: "core", duration_min: 20, primary_skill_id: "en.func.shop", scenario_id: null, stages: STAGES5 } : null,
      can_review: !practice && graded.some((a) => !a.correct),
    };
  }

  /* ---------- sprint 5: reading sessions (POST /v1/practice/readings/{id}/sessions, routed by MockMemory) ---------- */
  startReading(owner: string, kids: boolean, reading: ReadingView, questions: ReadingQuestionDef[], idemKey: string | undefined): Res {
    if (!idemKey) return fail(422, "IDEMPOTENCY_KEY_REQUIRED");
    const ik = `${owner}:${idemKey}`;
    if (this.idem.has(ik)) return ok(this.runs.get(this.idem.get(ik) as string)!.view, 201);
    const open = [...this.runs.values()].find((r) => r.owner === owner && isOpenSt(r.view.status) && r.view.kind !== "duel");
    if (open) return fail(409, "SESSION_ACTIVE", { session_id: open.view.session_id, kind: open.view.kind, title: open.view.title });
    const plan: Def[] = [
      { kind: "reading", reading },
      ...questions.map((q): Def => ({ kind: "item", stage: "questions", graded: true, item: { item_id: q.item_id, item_type: q.item_type, instruction: q.instruction, prompt_en: q.prompt_en, options: [...q.options], key: q.key, right: q.right } })),
      { kind: "done" },
    ];
    const r = this.newRun(owner, kids, "reading", { title: reading.title }, plan);
    this.readingOf.set(r.view.session_id, reading.reading_id);
    this.idem.set(ik, r.view.session_id);
    return ok(r.view, 201);
  }

  readingOf = new Map<string, string>();

  /* ---------- sprint 7: the tasks of a duel (POST /v1/duel-sessions, routed by MockSocial) ---------- */
  /** duel_id of a duel session */
  duelOf = new Map<string, string>();
  /** called once when a duel session is finished: the score goes to the duel (lesson.session.completed.v1 kind duel) */
  onDuelFinished: ((duelId: string, owner: string, score: { correct: number; total: number }) => void) | null = null;

  /** One session per participant of a duel: a repeat (any key) returns the same session. */
  startDuel(owner: string, kids: boolean, duelId: string, items: ReadingQuestionDef[]): { res: Res; created: boolean } {
    const mine = [...this.runs.values()].find((r) => r.owner === owner && r.view.kind === "duel" && this.duelOf.get(r.view.session_id) === duelId);
    if (mine) return { res: ok(mine.view, 200), created: false };
    const plan: Def[] = [
      ...items.map((q): Def => ({ kind: "item", stage: "assessment", graded: true, item: { item_id: q.item_id, item_type: q.item_type, instruction: q.instruction, prompt_en: q.prompt_en, options: [...q.options], key: q.key, right: q.right } })),
      { kind: "done" },
    ];
    const r = this.newRun(owner, kids, "duel", { title: L("Дуэль", "Duel") }, plan);
    r.view.ai_mode = "choices";
    r.view.ai_degraded = false;
    this.duelOf.set(r.view.session_id, duelId);
    return { res: ok(r.view, 201), created: true };
  }

  private finishDuel(r: Run): LessonSummary {
    const answers = [...r.answers.values()];
    const total = r.plan.filter((d) => d.kind === "item").length;
    const score = { correct: answers.filter((a) => a.correct).length, total };
    const duelId = this.duelOf.get(r.view.session_id);
    if (duelId) this.onDuelFinished?.(duelId, r.owner, score);
    return { session_id: r.view.session_id, kind: "duel", title: r.view.title, status: "completed", outcome: null, minutes: Math.max(1, r.view.minutes), evaluation: null, skills: [], key_words: [], next_lesson: null, can_review: false };
  }

  /** The session of a duel: my answers with the keys (only after the end of the duel — checked by the caller). */
  duelSession(owner: string, sessionId: string): { duelId: string; status: LessonSession["status"]; items: Array<{ item_id: string; prompt_en: string; your_answer: string | null; correct_answer: string; correct: boolean }>; score: { correct: number; total: number } } | null {
    const r = this.runs.get(sessionId);
    if (!r || r.owner !== owner || r.view.kind !== "duel") return null;
    const items = r.plan.flatMap((d) => (d.kind === "item" ? [d.item] : []));
    const out = items.map((it) => {
      const a = r.answers.get(it.item_id);
      const v = a?.value;
      const your = v === null || v === undefined ? null : Array.isArray(v) ? v.join(" ") : typeof v === "number" ? it.options[v] ?? String(v) : String(v);
      return { item_id: it.item_id, prompt_en: it.prompt_en, your_answer: your, correct_answer: it.right, correct: !!a?.correct };
    });
    return { duelId: this.duelOf.get(sessionId) ?? "", status: r.view.status, items: out, score: { correct: out.filter((x) => x.correct).length, total: out.length } };
  }

  /** ReadingCard.last_result: the last completed reading session of the learner per text. */
  readingResult(owner: string, readingId: string): { correct: number; total: number; finished_at: string } | null {
    let out: { correct: number; total: number; finished_at: string } | null = null;
    for (const r of this.runs.values()) {
      if (r.owner !== owner || r.view.kind !== "reading" || r.view.status !== "completed" || this.readingOf.get(r.view.session_id) !== readingId) continue;
      const items = r.summary?.evaluation?.items ?? [];
      out = { correct: items.filter((i) => i.correct).length, total: items.length, finished_at: r.view.finished_at ?? new Date().toISOString() };
    }
    return out;
  }

  /** A completed lesson of the history, evaluated `daysAgo` days ago (no appeal yet). */
  private seedCompleted(owner: string, daysAgo: number): Run {
    const r = this.newRun(owner, false, "lesson", { lesson_id: "l-a1-03-cafe" });
    r.rp = { graph: CAFE, node: "n2", unclear: 0, hints: 0, turns: [], outcome: "alt_success", retried: false, texts: ["I want a latte"] };
    r.answers.set("a-gap", { item: ITEMS.gap, value: "likes", hinted: false, correct: false, stage: "assessment" });
    r.answers.set("a-trans", { item: ITEMS.trans, value: 0, hinted: false, correct: true, stage: "assessment" });
    r.view.status = "completed";
    r.view.started_at = new Date(Date.now() - daysAgo * DAY - 1200_000).toISOString();
    r.view.finished_at = new Date(Date.now() - daysAgo * DAY).toISOString();
    r.view.minutes = 19;
    r.summary = this.finish(r, true);
    const created = r.view.finished_at;
    const stored = this.evaluations.get(r.summary.evaluation!.evaluation_id)!;
    r.summary.evaluation!.created_at = created;
    stored.created_at = created;
    if (daysAgo > 90) {
      // assessment: the copy older than 90 days keeps only the type of each error
      const erase = (e: EvaluationView["key_errors"][number]) => ({ ...e, evidence: "", correction: "" });
      stored.key_errors = stored.key_errors.map(erase);
      r.summary.evaluation!.key_errors = r.summary.evaluation!.key_errors.map(erase);
    }
    return r;
  }

  private seedDecided(owner: string, decision: "upheld" | "corrected", daysAgo = 2): void {
    const r = this.seedCompleted(owner, daysAgo);
    const ev = r.summary!.evaluation!;
    const appeal = this.fileAppeal(owner, ev.evaluation_id, "Я написал «I’d like», а не «I want».");
    this.decide(appeal.appeal_id, decision, decision === "corrected" ? "Ошибка засчитана неверно — исправили оценку." : "Оценка верна: в реплике было «I want».");
    if (daysAgo > 90) {
      // 90 days after the decision the learner's text is erased everywhere
      this.appeals.get(appeal.appeal_id)!.reason = null;
      for (const e of this.evaluations.values()) if (e.appeal?.appeal_id === appeal.appeal_id) e.appeal = { ...e.appeal, reason: null };
    }
  }

  fileAppeal(owner: string, evaluationId: string, reason: string): Appeal {
    const a: Appeal & { owner: string } = {
      appeal_id: this.id("a9900000"),
      evaluation_id: evaluationId,
      status: "new",
      reason,
      decision_note: null,
      new_evaluation_id: null,
      created_at: new Date().toISOString(),
      decided_at: null,
      owner,
    };
    this.appeals.set(a.appeal_id, a);
    const ev = this.evaluations.get(evaluationId)!;
    const { owner: _o, ...view } = a;
    ev.appeal = view;
    return view;
  }

  /** The methodologist's decision (admin side): upheld — the same evaluation; corrected — a new one replaces it. */
  decide(appealId: string, decision: "upheld" | "corrected", note: string): void {
    const a = this.appeals.get(appealId)!;
    const ev = this.evaluations.get(a.evaluation_id)!;
    a.status = decision;
    a.decision_note = note;
    a.decided_at = new Date().toISOString();
    if (decision === "corrected") {
      const nid = this.id("e7a10000");
      const fixed = {
        ...ev,
        evaluation_id: nid,
        passed: true,
        key_errors: ev.key_errors.filter((e) => e.error_code !== "vocabulary"),
        scores: ev.scores.map((s) => (s.code === "grammar" ? { ...s, score: 3 as const } : s)),
        superseded_by: null,
        created_at: new Date().toISOString(),
      };
      a.new_evaluation_id = nid;
      ev.superseded_by = nid;
      this.evaluations.set(nid, fixed);
    }
    const { owner: _o, ...view } = a;
    ev.appeal = view;
    const latest = ev.superseded_by ? this.evaluations.get(ev.superseded_by) : null;
    if (latest) latest.appeal = view;
  }

  /** Lessons of the plan passed (trajectory.completed). */
  completed(owner: string): Trajectory["completed"] {
    const out: Trajectory["completed"] = [];
    for (const r of this.runs.values()) {
      if (r.owner !== owner || r.view.kind !== "lesson" || r.view.status !== "completed" || !r.view.lesson_id) continue;
      const card = this.card(r.view.lesson_id, r.kids, owner);
      if (!card) continue;
      const ev = r.summary?.evaluation ? this.evaluations.get(r.summary.evaluation.evaluation_id) : null;
      const actual = ev?.superseded_by ? this.evaluations.get(ev.superseded_by) ?? ev : ev;
      const { version: _v, primary_skill: _p, stages_detail: _s, key_words_count: _k, roleplay_mode: _r, available: _a, unavailable_reason: _u, active_session_id: _x, ...c } = card;
      out.unshift({ ...c, passed: actual?.passed ?? null, evaluation_id: ev?.evaluation_id ?? null, completed_at: r.view.finished_at ?? new Date().toISOString() });
    }
    return out.filter((c, i, all) => all.findIndex((x) => x.lesson_id === c.lesson_id) === i);
  }

  /* ---------- router ---------- */
  /**
   * A sprint 4 call → its answer, or null when the path is not a sprint 4 route. `owner` — the active learner,
   * `kids` — the child profile.
   */
  handle(method: string, path: string, q: URLSearchParams, b: Record<string, unknown>, headers: Record<string, string>, ctx: { owner: string; kids: boolean }): Res | null {
    const key = `${method} ${path}`;
    const { owner, kids } = ctx;
    const idemKey = headers["idempotency-key"];
    let m = /^\/v1\/lessons\/([a-z0-9._-]+)$/.exec(path);
    if (m && method === "GET") {
      const c = this.card(m[1]!, kids, owner);
      return c ? ok(c) : fail(404, "LESSON_NOT_AVAILABLE");
    }
    m = /^\/v1\/(lessons|scenarios|media)\/([a-z0-9._-]+)\/sessions$/.exec(path);
    if (m && method === "POST") {
      if (!idemKey) return fail(422, "IDEMPOTENCY_KEY_REQUIRED");
      const ik = `${owner}:${idemKey}`;
      if (this.idem.has(ik)) return ok(this.runs.get(this.idem.get(ik) as string)!.view, 201);
      const kind: SessionKind = m[1] === "lessons" ? "lesson" : m[1] === "scenarios" ? "scenario" : "media";
      if (kind === "lesson" && !this.card(m[2]!, kids, owner)) return fail(404, "LESSON_NOT_AVAILABLE");
      if (kind === "scenario" && (kids ? m[2] !== "sc-kids-zoo" : m[2] === "sc-kids-zoo")) return fail(404, "SCENARIO_NOT_FOUND");
      if (kind === "media" && m[2] !== "m-own-coffee") return fail(404, "NO_EXERCISES");
      const open = [...this.runs.values()].find((r) => r.owner === owner && isOpenSt(r.view.status) && r.view.kind !== "duel");
      if (open) return fail(409, "SESSION_ACTIVE", { session_id: open.view.session_id, kind: open.view.kind, title: open.view.title });
      const r = this.newRun(owner, kids, kind, kind === "lesson" ? { lesson_id: m[2]! } : kind === "scenario" ? { scenario_id: m[2]! } : { asset_id: m[2]! });
      this.idem.set(ik, r.view.session_id);
      return ok(r.view, 201);
    }
    if (key === "GET /v1/sessions/active") {
      const open = [...this.runs.values()].find((r) => r.owner === owner && isOpenSt(r.view.status) && r.view.kind !== "duel");
      return ok({ session: open ? open.view : null });
    }
    if (key === "GET /v1/sessions") {
      const kind = q.get("kind");
      const items: LessonHistoryItem[] = [...this.runs.values()]
        .filter((r) => r.owner === owner && r.view.kind !== "duel" && (!kind || r.view.kind === kind))
        .reverse()
        .map((r) => ({
          session_id: r.view.session_id,
          kind: r.view.kind,
          title: r.view.title,
          status: r.view.status,
          outcome: r.summary?.outcome ?? null,
          passed: r.summary?.evaluation?.passed ?? null,
          minutes: r.view.minutes,
          evaluation_id: r.summary?.evaluation?.evaluation_id ?? null,
          finished_at: r.view.finished_at,
          started_at: r.view.started_at,
        }));
      return ok({ items, next_cursor: null });
    }
    if (key === "GET /v1/appeals") return ok({ items: [...this.appeals.values()].filter((a) => a.owner === owner).map(({ owner: _o, ...a }) => a) });
    m = /^\/v1\/evaluations\/([0-9a-f-]{36})(\/appeal)?$/.exec(path);
    if (m) {
      const ev = this.evaluations.get(m[1]!);
      if (!ev || ev.owner !== owner) return fail(404, "EVALUATION_NOT_FOUND");
      if (!m[2] && method === "GET") {
        const { owner: _o, session_id: _s, ...view } = ev;
        return ok(view);
      }
      if (m[2] && method === "POST") {
        if (!idemKey) return fail(422, "IDEMPOTENCY_KEY_REQUIRED");
        const ik = `ap:${owner}:${idemKey}`;
        if (this.idem.has(ik)) return ok(this.idem.get(ik), 201);
        if (ev.practice_only) return fail(409, "APPEAL_NOT_ALLOWED");
        if (ev.appeal) return fail(409, "APPEAL_EXISTS", { appeal_id: ev.appeal.appeal_id });
        const a = this.fileAppeal(owner, ev.evaluation_id, String(b.reason ?? ""));
        this.idem.set(ik, a);
        return ok(a, 201);
      }
    }
    m = /^\/v1\/sessions\/([0-9a-f-]{36})(?:\/(.+))?$/.exec(path);
    if (!m) return null;
    const r = this.runs.get(m[1]!);
    if (!r || r.owner !== owner) return fail(404, "SESSION_NOT_FOUND");
    const action = m[2] ?? "";
    const st = r.view.status;
    const open = isOpenSt(st);
    const touch = () => {
      if (r.view.status === "ready" || r.view.status === "paused") {
        r.view.status = "in_progress";
        r.view.paused_at = null;
        r.view.expires_at = null;
        r.view.started_at ??= new Date().toISOString();
      }
    };
    if (action === "" && method === "GET") return ok(r.view);
    if (action === "current" && method === "GET") {
      if (!open) return fail(409, "SESSION_STATE", { status: st });
      touch();
      return ok(this.current(r));
    }
    if (action === "pause" && method === "POST") {
      if (st !== "in_progress" && st !== "ready") return fail(409, "SESSION_STATE", { status: st });
      r.view.status = "paused";
      r.view.paused_at = new Date().toISOString();
      r.view.expires_at = new Date(Date.now() + 3 * DAY).toISOString();
      return ok(r.view);
    }
    if (action === "resume" && method === "POST") {
      if (st !== "paused") return fail(409, "SESSION_STATE", { status: st });
      touch();
      return ok(r.view);
    }
    if (action === "cancel" && method === "POST") {
      if (!open || r.view.kind === "duel") return fail(409, "SESSION_STATE", { status: st });
      r.view.status = "cancelled";
      r.view.finished_at = new Date().toISOString();
      return ok(r.view);
    }
    // the AI is still thinking about the same answer: 409 AI_BUSY, the same request later gets the result
    const busy = () => (this.busyLeft > 0 ? (this.busyLeft--, fail(409, "AI_BUSY")) : null);
    m = /^steps\/(s\d+)(\/hint)?$/.exec(action);
    if (m && method === "POST") {
      if (!open && !r.results.has(m[1]!)) return fail(409, "SESSION_STATE", { status: st });
      if (!m[2] && typeof b.text === "string") {
        const wait = busy();
        if (wait) return wait;
      }
      touch();
      if (m[2]) {
        const step = this.current(r);
        if (step.step_id !== m[1]) return fail(409, "STEP_NOT_CURRENT", { current_step_id: step.step_id });
        const d = r.plan[r.pi]!;
        if (d.kind === "item") {
          if (d.graded) return fail(409, "HINTS_NOT_ALLOWED");
          r.hinted.add(d.item.item_id);
          return ok({ hint: d.item.hint ?? L("Подумайте о правиле урока.", "Dars qoidasi haqida oʻylang.") });
        }
        if (d.kind === "roleplay" && r.rp) {
          r.rp.hints += 1;
          return ok({ hint: r.rp.graph.nodes[r.rp.node]!.hint });
        }
        return fail(409, "HINTS_NOT_ALLOWED");
      }
      return this.answer(r, m[1]!, b);
    }
    if (action === "simpler" && method === "POST") {
      const wait = busy();
      if (wait) return wait;
      const d = r.plan.find((x): x is Extract<Def, { kind: "explanation" }> => x.kind === "explanation");
      if (!d || this.current(r).stage !== "explanation") return fail(409, "SIMPLER_NOT_AVAILABLE");
      const ex = d.simpler[r.simplerAt % d.simpler.length]!;
      r.simplerAt += 1;
      const ai = r.view.ai_mode === "full" && !this.sc.aiDegraded;
      return ok({
        explanation: ai ? L("Проще: «I’d like» — это как «мне, пожалуйста». Начинайте просьбу с него.", "Soddaroq: «I’d like» — «menga, iltimos» degani. Iltimosni shu bilan boshlang.") : null,
        example_en: ex.en,
        example_gloss: ex.gloss,
        source: ai ? "ai" : "lesson",
      });
    }
    if (action === "roleplay/retry" && method === "POST") {
      const step = this.current(r);
      if (step.type !== "roleplay_end" || !step.can_retry || !r.rp) return fail(409, "RETRY_NOT_AVAILABLE");
      r.rp.retried = true;
      r.rp.node = r.rp.graph.start;
      r.rp.unclear = 0;
      r.rp.outcome = null;
      r.rp.turns = [];
      r.pi = r.plan.findIndex((x) => x.kind === "roleplay");
      // the roleplay_end step is replaced by a fresh node step
      r.results.set(step.step_id, { accepted: true, feedback: null, reply: null, next: step });
      return ok(this.emit(r));
    }
    if (action === "finish" && method === "POST") {
      if (r.summary) return ok(r.summary);
      if (!open) return fail(409, "SESSION_STATE", { status: st });
      if (this.current(r).type !== "done") return fail(409, "STEP_NOT_CURRENT", { current_step_id: this.current(r).step_id });
      r.view.status = "completed";
      r.view.stage = "summary";
      r.view.finished_at = new Date().toISOString();
      if (r.view.kind === "duel") {
        r.summary = this.finishDuel(r);
        return ok(r.summary);
      }
      r.summary = this.finish(r);
      return ok(r.summary);
    }
    if (action === "summary" && method === "GET") {
      if (!r.summary) return fail(409, "SESSION_STATE", { status: st });
      // «оценка появится позже»: the evaluation is ready at the N-th re-read
      if (!r.summary.evaluation && this.sc.evaluationAfterReads !== undefined) {
        r.summaryReads = (r.summaryReads ?? 0) + 1;
        if (r.summaryReads >= this.sc.evaluationAfterReads) r.summary = this.finish(r, true);
      }
      return ok(r.summary);
    }
    if (action === "review" && method === "POST") {
      if (!idemKey) return fail(422, "IDEMPOTENCY_KEY_REQUIRED");
      const ik = `${owner}:${idemKey}`;
      if (this.idem.has(ik)) return ok(this.runs.get(this.idem.get(ik) as string)!.view, 201);
      if (!r.summary?.can_review) return fail(409, "NOTHING_TO_REVIEW");
      const openRun = [...this.runs.values()].find((x) => x.owner === owner && isOpenSt(x.view.status));
      if (openRun) return fail(409, "SESSION_ACTIVE", { session_id: openRun.view.session_id, kind: openRun.view.kind, title: openRun.view.title });
      const wrong = [...r.answers.values()].filter((a) => (a.stage === "assessment" || a.stage === "exercises") && !a.correct);
      const plan: Def[] = [...wrong.map((a) => ({ kind: "item" as const, stage: "assessment" as const, item: a.item, graded: false })), { kind: "done" }];
      const rv = this.newRun(owner, kids, "review", { lesson_id: r.view.lesson_id ?? undefined }, plan);
      rv.sourceSession = r.view.session_id;
      this.idem.set(ik, rv.view.session_id);
      return ok(rv.view, 201);
    }
    return fail(404, "NOT_FOUND");
  }
}
