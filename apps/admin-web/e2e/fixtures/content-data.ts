/**
 * Content fixtures of the mock admin-bff (sprint 3): a small RU→EN course in the shapes of packages/contracts content.ts —
 * versions in every state of the life cycle (published by the seed author, drafts with empty UZ texts, versions under
 * review by another methodist, an approved lesson), a scenario draft whose graph has problems, media with expiring /
 * expired / missing UZ rights, learners' requests, languages and pairs, diagnostic tests. Texts are authored samples.
 */
import type { AdminMediaRequest, DiagnosticStats, PairCard } from "@tilhero/contracts/admin";
import type {
  CoursePayload,
  Language,
  LessonPayload,
  Localized,
  MediaExercisePayload,
  MediaPayload,
  ModulePayload,
  RubricPayload,
  ScenarioNode,
  ScenarioPayload,
  SkillPayload,
} from "@tilhero/contracts/content";
import { DAY, HOUR, ID, iso } from "./data";

export const SEED = "00000000-0000-4000-a000-000000005eed";
export const L = (ru: string, uz: string): Localized => ({ ru, uz });
export const today = (offsetDays = 0) => new Date(Date.now() + offsetDays * DAY + 5 * HOUR).toISOString().slice(0, 10);

/* ---------------------------------------------------------------- course, modules, skills, rubrics */

export const course: CoursePayload = {
  course_id: "en-core",
  pair_id: "ru-en",
  title: L("Английский с нуля до A2", "Ingliz tili noldan A2 gacha"),
  description: L("Короткие уроки по 20 минут: разговорные ситуации и живые сценки.", "20 daqiqalik qisqa darslar: suhbat vaziyatlari va jonli sahnalar."),
  level_start: "A0",
  level_end: "A2",
  module_ids: ["m1-meet", "m2-cafe"],
};

export const modules: ModulePayload[] = [
  { module_id: "m1-meet", course_id: "en-core", title: L("Знакомство", "Tanishuv"), goal: L("Поздороваться и рассказать о себе", "Salomlashish va oʻzi haqida aytish"), theme: "small_talk", lesson_ids: ["l-01-greetings", "l-02-numbers"] },
  { module_id: "m2-cafe", course_id: "en-core", title: L("В кафе", "Kafeda"), goal: L("Заказать еду и напиток", "Ovqat va ichimlik buyurtma qilish"), theme: "food", lesson_ids: ["l-03-cafe"] },
];

const sk = (skill_id: string, area: SkillPayload["area"], level: SkillPayload["level"], ru: string, uz: string, prerequisites: string[] = [], tags: string[] = []): SkillPayload => ({
  skill_id,
  course_id: "en-core",
  area,
  title: L(ru, uz),
  description: L(`${ru}: базовые фразы`, `${uz}: asosiy iboralar`),
  level,
  prerequisites,
  rubric_id: null,
  diagnostic_tags: tags,
});
export const skills: SkillPayload[] = [
  sk("en.func.greet", "function", "A0", "Приветствие", "Salomlashish", [], ["greet"]),
  sk("en.gram.to-be", "grammar", "A0", "Глагол to be", "to be feʼli", [], ["to-be"]),
  sk("en.vocab.numbers", "vocabulary", "A0", "Числа", "Sonlar", [], ["numbers"]),
  sk("en.func.order", "function", "A1", "Заказ в кафе", "Kafeda buyurtma", ["en.func.greet", "en.vocab.numbers"], ["order"]),
  sk("en.func.ask-price", "function", "A1", "Спросить цену", "Narxni soʻrash", ["en.vocab.numbers"], ["price"]),
  sk("en.listen.cafe", "listening", "A1", "Понимание на слух в кафе", "Kafeda tinglab tushunish", ["en.func.order"], ["listen-cafe"]),
];

const bands = (ru: string, uz: string) => ([0, 1, 2, 3] as const).map((score) => ({ score, descriptor: L(`${ru}: уровень ${score}`, `${uz}: ${score}-daraja`) }));
export const rubrics: RubricPayload[] = [
  {
    rubric_id: "r-lesson-core",
    title: L("Урок: основная рубрика", "Dars: asosiy rubrika"),
    applies_to: ["lesson"],
    criteria: [
      { code: "task", title: L("Задача", "Vazifa"), weight: 0.4, bands: bands("Задача", "Vazifa") },
      { code: "vocabulary", title: L("Лексика", "Leksika"), weight: 0.3, bands: bands("Лексика", "Leksika") },
      { code: "grammar", title: L("Грамматика", "Grammatika"), weight: 0.3, bands: bands("Грамматика", "Grammatika") },
    ],
    pass_rule: { min_weighted: 1.5, min_per_criterion: 1 },
  },
  {
    rubric_id: "r-scenario",
    title: L("Сценарий: разговор", "Ssenariy: suhbat"),
    applies_to: ["scenario"],
    criteria: [
      { code: "task", title: L("Задача", "Vazifa"), weight: 0.5, bands: bands("Задача", "Vazifa") },
      { code: "independence", title: L("Самостоятельность", "Mustaqillik"), weight: 0.5, bands: bands("Самостоятельность", "Mustaqillik") },
    ],
    pass_rule: { min_weighted: 1.5, min_per_criterion: 1 },
  },
];
/** draft by the methodist: weights sum 0.9 */
export const rubricDraft: RubricPayload = {
  rubric_id: "r-media",
  title: L("Медиа: понимание", "Media: tushunish"),
  applies_to: ["media_exercise"],
  criteria: [
    { code: "comprehension", title: L("Понимание", "Tushunish"), weight: 0.6, bands: bands("Понимание", "Tushunish") },
    { code: "vocabulary", title: L("Лексика", "Leksika"), weight: 0.3, bands: bands("Лексика", "Leksika") },
  ],
  pass_rule: { min_weighted: 1.5, min_per_criterion: 1 },
};

/* ---------------------------------------------------------------- lessons */

const stages = (ru: string[], uz: string[]): LessonPayload["stages"] =>
  (["retrieval", "explanation", "roleplay", "assessment", "summary"] as const).map((type, i) => ({ type, minutes: [3, 5, 6, 4, 2][i]!, instructions: L(ru[i]!, uz[i]!) }));

export function lessonGreetings(): LessonPayload {
  return {
    lesson_id: "l-01-greetings",
    course_id: "en-core",
    module_id: "m1-meet",
    title: L("Привет! Как тебя зовут?", "Salom! Isming nima?"),
    goal: L("Поздороваться, представиться и спросить имя", "Salomlashish, oʻzini tanishtirish va ismini soʻrash"),
    level: "A0",
    kind: "core",
    audience: ["kids", "teens", "adults"],
    goals: ["daily", "travel"],
    topics: ["small_talk"],
    primary_skill_id: "en.func.greet",
    secondary_skill_ids: ["en.gram.to-be"],
    prerequisite_skill_ids: [],
    duration_min: 20,
    stages: stages(
      ["Вспомните, как здороваются на вашем языке", "Hello, Hi, Good morning и фраза My name is…", "Познакомьтесь с новым соседом", "Выполните три коротких задания", "Повторите главные фразы урока"],
      ["Oʻz tilingizda qanday salomlashishni eslang", "Hello, Hi, Good morning va My name is… iborasi", "Yangi qoʻshningiz bilan tanishing", "Uchta qisqa topshiriqni bajaring", "Darsning asosiy iboralarini takrorlang"],
    ),
    key_words: [
      { en: "hello", gloss: L("привет, здравствуйте", "salom"), example_en: "Hello, I'm Sam." },
      { en: "good morning", gloss: L("доброе утро", "xayrli tong"), example_en: "Good morning, Ms Lee!" },
      { en: "name", gloss: L("имя", "ism"), example_en: "My name is Anna." },
      { en: "nice to meet you", gloss: L("приятно познакомиться", "tanishganimdan xursandman"), example_en: "Nice to meet you, Tom." },
    ],
    examples: [
      { en: "Hi! I'm Leo. What's your name?", gloss: L("Привет! Я Лео. Как тебя зовут?", "Salom! Men Leoman. Isming nima?") },
      { en: "My name is Dina. Nice to meet you!", gloss: L("Меня зовут Дина. Приятно познакомиться!", "Mening ismim Dina. Tanishganimdan xursandman!") },
    ],
    scenario_id: null,
    rubric_id: "r-lesson-core",
    control_items: [
      { item_id: "ci-01", type: "single_choice", skill_id: "en.func.greet", instruction: L("Выберите приветствие для утра", "Ertalabki salomlashishni tanlang"), prompt_en: "It is 8 a.m. You say:", options: ["Good morning!", "Good night!", "Goodbye!"], answer: 0 },
      { item_id: "ci-02", type: "gap_fill", skill_id: "en.gram.to-be", instruction: L("Вставьте пропущенное слово", "Tushib qolgan soʻzni qoʻying"), prompt_en: "My name ___ Anna.", options: [], answer: ["is"] },
      { item_id: "ci-03", type: "order_words", skill_id: "en.func.greet", instruction: L("Соберите фразу из слов", "Soʻzlardan ibora tuzing"), prompt_en: "Put the words in order.", options: ["meet", "Nice", "you", "to"], answer: ["Nice", "to", "meet", "you"] },
    ],
    hints: [L("Hi — проще, чем Hello", "Hi — Hello dan soddaroq")],
  };
}

/** v2 draft of the methodist: new key word and stage text, UZ not written yet */
export function lessonGreetingsDraft(): LessonPayload {
  const p = lessonGreetings();
  p.title = L("Привет! Знакомимся", "");
  p.stages[1] = { ...p.stages[1]!, instructions: L("Hello, Hi, Good morning, Good evening и My name is…", "") };
  p.key_words = [...p.key_words, { en: "good evening", gloss: L("добрый вечер", ""), example_en: "Good evening, everyone!" }];
  return p;
}

export function lessonNumbers(): LessonPayload {
  const p = lessonGreetings();
  return {
    ...p,
    lesson_id: "l-02-numbers",
    title: L("Числа и телефон", "Sonlar va telefon"),
    goal: L("Назвать номер телефона и возраст", "Telefon raqami va yoshni aytish"),
    primary_skill_id: "en.vocab.numbers",
    secondary_skill_ids: [],
    key_words: [
      { en: "one", gloss: L("один", "bir"), example_en: "One coffee, please." },
      { en: "two", gloss: L("два", "ikki"), example_en: "Two tickets." },
      { en: "phone number", gloss: L("номер телефона", "telefon raqami"), example_en: "My phone number is 90 123 45 67." },
      { en: "how old", gloss: L("сколько лет", "necha yosh"), example_en: "How old are you?" },
    ],
    control_items: p.control_items.map((c) => ({ ...c, skill_id: "en.vocab.numbers" })),
  };
}

export function lessonCafe(): LessonPayload {
  const p = lessonGreetings();
  return {
    ...p,
    lesson_id: "l-03-cafe",
    module_id: "m2-cafe",
    title: L("В кафе: заказ напитка", "Kafeda: ichimlik buyurtma qilish"),
    goal: L("Заказать напиток и спросить цену", "Ichimlik buyurtma qilish va narxini soʻrash"),
    level: "A1",
    audience: ["teens", "adults"],
    topics: ["food"],
    primary_skill_id: "en.func.order",
    secondary_skill_ids: ["en.func.ask-price"],
    prerequisite_skill_ids: ["en.func.greet", "en.vocab.numbers"],
    scenario_id: "sc-cafe-order",
    control_items: p.control_items.map((c) => ({ ...c, skill_id: "en.func.order" })),
  };
}

/* ---------------------------------------------------------------- scenarios */

const nd = (speaker: string, line_en: string, ru: string, uz: string, to: Array<[string, string]>, extra: Partial<ScenarioNode> = {}): ScenarioNode => ({
  speaker,
  line_en,
  gloss: L(ru, uz),
  hint: null,
  recovery_point: false,
  event: null,
  transitions: to.map(([intent, target]) => ({ intent, description: L("Ответьте баристе", "Baristaga javob bering"), examples_en: ["Yes, please."], to: target })),
  end: null,
  ...extra,
});
const endNode = (speaker: string, line_en: string, outcome: "success" | "alt_success" | "fail"): ScenarioNode =>
  nd(speaker, line_en, "Спасибо, до свидания!", "Rahmat, xayr!", [], { end: { outcome, summary: L("Заказ сделан", "Buyurtma berildi") } });

export function scenarioCafe(): ScenarioPayload {
  return {
    scenario_id: "sc-cafe-order",
    title: L("Кофе с собой", "Olib ketish uchun qahva"),
    task: L("Закажите напиток, уточните размер и оплатите", "Ichimlik buyurtma qiling, hajmini aniqlang va toʻlang"),
    goals: ["daily", "travel"],
    topics: ["food"],
    level: "A1",
    difficulty: 2,
    audience: ["teens", "adults"],
    access: "free",
    characters: [{ id: "barista", name: "Sam", role: L("Бариста", "Barista"), voice: "en-GB" }],
    start_node: "start",
    nodes: {
      start: nd("barista", "Hi! What can I get you?", "Привет! Что вам предложить?", "Salom! Sizga nima beray?", [["order", "n_size"], ["clarify", "n_menu"]], { recovery_point: true }),
      n_menu: nd("barista", "We have coffee, tea and juice.", "У нас кофе, чай и сок.", "Bizda qahva, choy va sharbat bor.", [["order", "n_size"]]),
      n_size: nd("barista", "Small or large?", "Маленький или большой?", "Kichikmi yoki kattami?", [["answer", "n_pay"], ["ask_price", "n_price"]], { recovery_point: true }),
      n_price: nd("barista", "Small is two dollars, large is three.", "Маленький — два доллара, большой — три.", "Kichigi ikki dollar, kattasi uch.", [["answer", "n_pay"]], { event: "price_changed" }),
      n_pay: nd("barista", "Cash or card?", "Наличными или картой?", "Naqdmi yoki kartadami?", [["pay", "end_ok"], ["decline", "end_fail"]], { recovery_point: true }),
      end_ok: endNode("barista", "Here you go. Have a nice day!", "success"),
      end_fail: endNode("barista", "No problem, maybe next time.", "fail"),
    },
    completion: { criteria: L("Напиток заказан и оплачен", "Ichimlik buyurtma qilindi va toʻlandi") },
    skill_ids: ["en.func.order", "en.func.ask-price"],
    rubric_id: "r-scenario",
  };
}

/** v2 draft: a «wait» node without transitions (dead end) and a «tip» node no one leads to (unreachable) */
export function scenarioCafeDraft(): ScenarioPayload {
  const p = scenarioCafe();
  p.nodes.n_menu = { ...p.nodes.n_menu!, transitions: [...p.nodes.n_menu!.transitions, { intent: "other", description: L("Попросите подождать", "Kutishni soʻrang"), examples_en: ["One moment, please."], to: "n_wait" }] };
  p.nodes.n_wait = nd("barista", "Sure, take your time.", "Конечно, не спешите.", "Albatta, shoshilmang.", []);
  p.nodes.n_tip = nd("barista", "Would you like to leave a tip?", "Оставите чаевые?", "Choychaqa qoldirasizmi?", [["answer", "end_ok"]]);
  return p;
}

export function scenarioHotel(): ScenarioPayload {
  const p = scenarioCafe();
  return { ...p, scenario_id: "sc-hotel-checkin", title: L("Заселение в отель", "Mehmonxonaga joylashish"), task: L("Заселитесь в номер по брони", "Bron boʻyicha xonaga joylashing"), topics: ["travel"] };
}

/* ---------------------------------------------------------------- media */

const transcript = (): MediaPayload["transcript"] => [
  { t_start_ms: 0, t_end_ms: 2600, speaker: "Sam", text_en: "Hi! What can I get you?", gloss: L("Привет! Что вам предложить?", "Salom! Sizga nima beray?") },
  { t_start_ms: 2800, t_end_ms: 5200, speaker: "Ana", text_en: "A small latte, please.", gloss: L("Маленький латте, пожалуйста.", "Kichik latte, iltimos.") },
  { t_start_ms: 5400, t_end_ms: 8000, speaker: "Sam", text_en: "That's two dollars.", gloss: L("Это два доллара.", "Bu ikki dollar.") },
];
const media = (asset_id: string, ru: string, uz: string, valid_to: string | null, extra: Partial<MediaPayload> = {}): MediaPayload => ({
  asset_id,
  type: "own_scene",
  origin: "own_recording",
  title: L(ru, uz),
  original_title: null,
  language: "en",
  level: "A1",
  topics: ["food"],
  skill_ids: ["en.listen.cafe"],
  audience: ["teens", "adults"],
  duration_s: 20,
  transcript: transcript(),
  phrases: [{ en: "a small latte", gloss: L("маленький латте", "kichik latte"), t_ms: 3000 }],
  audio_blob_id: null,
  embed: null,
  rights: { owner: "TilHero", license_type: "own", license_ref: "TH-REC-2026-11", attribution: null, territories: ["UZ"], valid_from: "2026-11-01", valid_to, allowed_uses: ["listen", "show_transcript", "exercises"] },
  ...extra,
});
export const mediaCoffee = () => media("m-own-coffee-order", "Сценка: заказ кофе", "Sahna: qahva buyurtmasi", null, { audio_blob_id: "b0000000-0000-4000-8000-00000000c0ff" });
export const mediaBus = () => media("m-own-bus-stop", "Сценка: на остановке", "Sahna: bekatda", today(10), { topics: ["travel"] });
export const mediaMarket = () => media("m-own-old-market", "Сценка: на рынке", "Sahna: bozorda", today(-3), { topics: ["shopping"] });
/** draft of the content manager: territories without UZ */
export const mediaTrain = () => media("m-own-train", "Сценка: на вокзале", "Sahna: vokzalda", today(365), { topics: ["travel"], rights: { owner: "TilHero", license_type: "own", license_ref: "TH-REC-2026-12", attribution: null, territories: ["KZ"], valid_from: "2026-11-01", valid_to: today(365), allowed_uses: ["listen", "show_transcript"] } });

export const exerciseCoffee = (): MediaExercisePayload => ({
  exercise_id: "mx-coffee-1",
  asset_id: "m-own-coffee-order",
  type: "comprehension",
  skill_id: "en.listen.cafe",
  level: "A1",
  instruction: L("Послушайте и ответьте", "Tinglang va javob bering"),
  prompt_en: "What does Ana order?",
  options: ["A large tea", "A small latte", "Orange juice"],
  answer: 1,
  line_index: null,
  rubric_id: null,
});

/* ---------------------------------------------------------------- requests */

export const REQ = { song: "c1000000-0000-4000-8000-000000000001", song2: "c1000000-0000-4000-8000-000000000002", film: "c1000000-0000-4000-8000-000000000003", old: "c1000000-0000-4000-8000-000000000004" };
export function mediaRequests(): AdminMediaRequest[] {
  const base = { decision_note: null, linked_asset_id: null, decided_by: null, decided_by_name: null, decided_at: null };
  return [
    { ...base, request_id: REQ.song, user_id: "a1000000-0000-4000-8000-000000000001", kind: "song", title: "Shape of You — Ed Sheeran", link: "https://example.com/watch?v=shape-of-you", comment: "Хочу понимать слова припева", ui_locale: "ru", status: "new", created_at: iso(-2 * HOUR), similar_count: 1 },
    { ...base, request_id: REQ.song2, user_id: "a1000000-0000-4000-8000-000000000004", kind: "song", title: "shape of you", link: null, comment: null, ui_locale: "uz", status: "new", created_at: iso(-30 * 60_000), similar_count: 1 },
    { ...base, request_id: REQ.film, user_id: "a1000000-0000-4000-8000-000000000002", kind: "movie", title: "Frozen", link: null, comment: "Сцена в магазине", ui_locale: "ru", status: "in_review", created_at: iso(-1 * DAY), similar_count: 0 },
    { ...base, request_id: REQ.old, user_id: null, kind: "series", title: "Friends", link: null, comment: null, ui_locale: "ru", status: "rejected", decision_note: "Пока не можем — сериал под лицензией.", decided_by: ID.admin, decided_by_name: "Игорь Ш.", decided_at: iso(-3 * DAY), created_at: iso(-5 * DAY), similar_count: 0 },
  ];
}

/* ---------------------------------------------------------------- languages, pairs */

export function languages(): Language[] {
  return [
    { code: "en", name: { ru: "Английский", uz: "Ingliz tili", en: "English" }, script: "Latn", variants: ["en-GB", "en-US"], asr: { provider: "whisper", model: "large-v3" }, tts: { provider: "device", voices: ["en-GB", "en-US"] }, limitations: null, status: "active" },
    { code: "ru", name: { ru: "Русский", uz: "Rus tili", en: "Russian" }, script: "Cyrl", variants: [], asr: null, tts: null, limitations: "Только язык объяснений", status: "active" },
    { code: "uz", name: { ru: "Узбекский", uz: "Oʻzbek tili", en: "Uzbek" }, script: "Latn", variants: [], asr: null, tts: null, limitations: "Интерфейс и объяснения; изучение — после пилота", status: "active" },
    { code: "kk", name: { ru: "Казахский", uz: "Qozoq tili", en: "Kazakh" }, script: "Cyrl", variants: [], asr: null, tts: null, limitations: null, status: "planned" },
  ];
}

const empty = { skills: 0, lessons_published: 0, scenarios_published: 0, rubrics_published: 0, media_published: 0, diagnostic_test: null, locales_checked_pct: 0 };
export function pairs(): PairCard[] {
  const pair = (pair_id: string, source: string, target: string, ru: string, uz: string): PairCard => ({ pair_id, source, target, explanation_locales: [source], ui_locales: ["ru", "uz"], title: L(ru, uz), status: "planned", release_at: null, course_id: null, readiness: { ...empty }, learners: 0 });
  return [
    { ...pair("ru-en", "ru", "en", "Английский (объяснения на русском)", "Ingliz tili (rus tilida tushuntirish)"), status: "published", course_id: "en-core", readiness: { skills: 6, lessons_published: 1, scenarios_published: 1, rubrics_published: 2, media_published: 2, diagnostic_test: "dx-en-adult@1", locales_checked_pct: 100 }, learners: 1284 },
    { ...pair("ru-uz", "ru", "uz", "Узбекский (объяснения на русском)", "Oʻzbek tili (rus tilida tushuntirish)"), release_at: "2027-03" },
    pair("ru-kk", "ru", "kk", "Казахский (объяснения на русском)", "Qozoq tili (rus tilida tushuntirish)"),
    pair("en-uz", "en", "uz", "Узбекский (объяснения на английском)", "Oʻzbek tili (ingliz tilida tushuntirish)"),
    pair("en-kk", "en", "kk", "Казахский (объяснения на английском)", "Qozoq tili (ingliz tilida tushuntirish)"),
  ];
}

/* ---------------------------------------------------------------- diagnostics */

const AREAS = ["vocabulary", "grammar", "reading", "listening"] as const;
const BANDS = ["A0", "A1", "A2", "B1", "B2"] as const;
/** items per area×band; B2 listening is empty, B1 reading has one (shown red / yellow) */
export function dxItems(v: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const area of AREAS)
    BANDS.forEach((band, bi) => {
      const n = area === "listening" && band === "B2" ? 0 : area === "reading" && band === "B1" ? 1 : bi < 3 ? 3 : 2;
      for (let k = 1; k <= n + (v > 1 && band === "B2" && area === "listening" ? 2 : 0); k++) {
        const id = `${area.slice(0, 3)}-${band.toLowerCase()}-${k}`;
        out.push({
          item_id: id,
          area,
          band,
          tags: [area],
          skill_ids: [],
          type: area === "reading" ? "read_choice" : area === "listening" ? "listen_choice" : "single_choice",
          instruction: L("Выберите ответ", "Javobni tanlang"),
          prompt_en: `${band} ${area} item ${k}: choose the best answer.`,
          passage_en: area === "reading" ? "Tom works in a café. He starts at eight." : null,
          audio_text_en: area === "listening" ? "The bus leaves at nine." : null,
          options: ["at seven", "at eight", "at nine"],
          answer: (k + bi) % 3,
        });
      }
    });
  return out;
}
export const dxStats = (period: string): DiagnosticStats => ({
  period: period as DiagnosticStats["period"],
  started: period === "today" ? 46 : 318,
  finished: period === "today" ? 39 : 271,
  median_minutes: 12.5,
  by_level: { A0: 31, A1: 112, A2: 84, B1: 32, B2: 4, none: 8 },
  not_assessed_pct: { vocabulary: 0, grammar: 0, reading: 2.2, listening: 18.4 },
  followups: 23,
});
