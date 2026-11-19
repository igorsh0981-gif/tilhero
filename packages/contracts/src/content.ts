/**
 * Форматы учебного контента TilHero (спринт 3). ЕДИНСТВЕННЫЙ источник для catalog (pydantic-модели повторяют эти
 * интерфейсы 1:1, контрактный тест сверяет поля), сида контента (`services/catalog/seed/*.json`), admin-web и
 * telegram-bff. Тело каждой версии сущности контента — один из `*Payload` ниже.
 *
 * Общие правила:
 *  - Тексты для ученика — Localized {ru, uz}: оба непустые, без управляющих символов, UZ — латиница (oʻ, gʻ — U+02BB).
 *  - Учебный язык (EN) — поля `*_en`, без перевода.
 *  - Идентификаторы: [a-z0-9][a-z0-9._-]{1,63} (нижний регистр), стабильны между версиями.
 *  - Уровни — CEFR-подобные полосы A0 (нулевой), A1, A2, B1, B2. Это внутренняя шкала курса, не сертификат CEFR.
 *  - Аудитория — `audience`: kids (6–13), teens (14–17), adults (18+); пусто запрещено.
 */

export interface Localized {
  ru: string;
  uz: string;
}

export type Band = "A0" | "A1" | "A2" | "B1" | "B2";
export const BANDS: readonly Band[] = ["A0", "A1", "A2", "B1", "B2"];
export type AudienceSegment = "kids" | "teens" | "adults";
/** Цели онбординга (learning-plan, bff.ts Goal). */
export type GoalCode = "work" | "career" | "travel" | "daily" | "study" | "exam";
/** Темы онбординга (learning-plan directory TOPICS). */
export type TopicCode =
  | "small_talk" | "travel" | "food" | "shopping" | "work" | "interview" | "study" | "health" | "home" | "hobbies"
  | "movies" | "tech";

export type ContentKind =
  | "course" | "skill" | "module" | "lesson" | "rubric" | "scenario" | "media_asset" | "media_exercise";

/** Статус версии. suspended — только media_asset (права истекли/отозваны). */
export type VersionStatus = "draft" | "in_review" | "approved" | "published" | "suspended" | "archived";
/** Проверка локализации по языку интерфейса. */
export type LocaleCheck = "missing" | "draft" | "checked";

// ---------------------------------------------------------------------------------------------------------------------
// Языки и пары (ADM-LANG-01/02, APP-LANG-01/02) — не версии контента, отдельный справочник catalog (lang.manage)
// ---------------------------------------------------------------------------------------------------------------------

export interface Language {
  code: string; // BCP 47: en, ru, uz, kk
  name: { ru: string; uz: string; en: string };
  script: "Latn" | "Cyrl";
  variants: string[]; // en-GB, en-US
  asr: { provider: string; model: string } | null;
  tts: { provider: string; voices: string[] } | null;
  limitations: string | null;
  status: "active" | "planned";
}

export type PairStatus = "planned" | "development" | "review" | "pilot" | "published" | "archived";

export interface LanguagePair {
  pair_id: string; // ru-en
  source: string; // язык объяснений и методики
  target: string; // изучаемый
  explanation_locales: string[]; // ["ru"]
  ui_locales: string[]; // ["ru", "uz"]
  title: Localized; // «Английский (объяснения на русском)»
  status: PairStatus;
  release_at: string | null;
  course_id: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Курс, навыки, модули, уроки (ADM-CONT-01/02, APP-PLAN-01/02)
// ---------------------------------------------------------------------------------------------------------------------

export interface CoursePayload {
  course_id: string; // en-core
  pair_id: string; // ru-en
  title: Localized;
  description: Localized;
  level_start: Band;
  level_end: Band;
  /** порядок модулей */
  module_ids: string[];
}

export type SkillArea = "vocabulary" | "grammar" | "reading" | "listening" | "speaking" | "writing" | "function";

export interface SkillPayload {
  skill_id: string; // en.func.greet, en.gram.present-simple
  course_id: string;
  area: SkillArea;
  title: Localized;
  description: Localized;
  level: Band;
  /** предпосылки — skill_id этого курса; без циклов (проверка при публикации) */
  prerequisites: string[];
  rubric_id: string | null;
  /** теги заданий диагностики, которые свидетельствуют об этом навыке (diagnostics items[].tags) */
  diagnostic_tags: string[];
}

export interface ModulePayload {
  module_id: string;
  course_id: string;
  title: Localized;
  goal: Localized;
  theme: TopicCode;
  /** порядок уроков модуля */
  lesson_ids: string[];
}

export type LessonStageType = "retrieval" | "explanation" | "roleplay" | "assessment" | "summary";

export interface LessonStage {
  type: LessonStageType;
  minutes: number; // 1..10; сумма = duration_min
  instructions: Localized;
}

export interface KeyWord {
  en: string; // слово или фраза ≤ 60
  gloss: Localized;
  example_en: string; // ≤ 160
}

export interface Example {
  en: string; // ≤ 200
  gloss: Localized;
}

export type ControlItemType = "single_choice" | "gap_fill" | "order_words" | "translate_choice";

/** Контрольное задание урока (без подсказок). answer: single_choice/translate_choice — индекс в options;
 *  gap_fill — допустимые ответы (сравнение без регистра и концевой пунктуации); order_words — правильный порядок слов. */
export interface ControlItem {
  item_id: string;
  type: ControlItemType;
  skill_id: string;
  instruction: Localized;
  prompt_en: string;
  options: string[]; // для gap_fill/order_words — пусто или слова для порядка
  answer: number | string[];
}

export interface LessonPayload {
  lesson_id: string; // l-a1-01-greetings
  course_id: string;
  module_id: string;
  title: Localized;
  /** коммуникативная задача урока («Представиться и спросить имя») */
  goal: Localized;
  level: Band;
  kind: "core" | "optional";
  audience: AudienceSegment[];
  goals: GoalCode[];
  topics: TopicCode[];
  primary_skill_id: string;
  secondary_skill_ids: string[]; // ≤ 3
  prerequisite_skill_ids: string[];
  duration_min: 10 | 15 | 20 | 30;
  stages: LessonStage[]; // все 5 типов по одному, в порядке retrieval → summary
  key_words: KeyWord[]; // 4..12
  examples: Example[]; // 2..8
  scenario_id: string | null;
  rubric_id: string;
  control_items: ControlItem[]; // ≥ 3 — без них публикация запрещена (ADM-CONT-01)
  hints: Localized[]; // ≤ 5
}

// ---------------------------------------------------------------------------------------------------------------------
// Рубрики (ADM-CONT-03)
// ---------------------------------------------------------------------------------------------------------------------

export interface RubricCriterion {
  code: "task" | "vocabulary" | "grammar" | "independence" | "pronunciation" | "fluency" | "comprehension";
  title: Localized;
  weight: number; // 0 < w ≤ 1, сумма весов = 1
  /** баллы 0..3 по возрастанию, все четыре */
  bands: Array<{ score: 0 | 1 | 2 | 3; descriptor: Localized }>;
}

export interface RubricPayload {
  rubric_id: string;
  title: Localized;
  applies_to: Array<"lesson" | "scenario" | "media_exercise">;
  criteria: RubricCriterion[]; // ≥ 2
  pass_rule: { min_weighted: number; min_per_criterion: 0 | 1 | 2 }; // min_weighted 0..3
}

// ---------------------------------------------------------------------------------------------------------------------
// Сценарии разговоров (ADM-CONT-04, APP-PLAN-04)
// ---------------------------------------------------------------------------------------------------------------------

export interface ScenarioCharacter {
  id: string;
  name: string; // имя персонажа (EN)
  role: Localized; // «Администратор гостиницы»
  voice: "en-GB" | "en-US";
}

export interface ScenarioTransition {
  /** код намерения ученика: greet, ask_price, confirm, decline, clarify, other… */
  intent: string;
  description: Localized; // что должен сделать ученик
  examples_en: string[]; // 1..4 образца реплик ученика
  to: string; // node_id
}

export interface ScenarioNode {
  speaker: string; // characters[].id
  line_en: string; // реплика персонажа ≤ 240
  gloss: Localized;
  hint: Localized | null;
  /** с этого узла урок можно продолжить после паузы (APP-LESS-08) */
  recovery_point: boolean;
  event: string | null; // сюжетное событие (`price_changed`, `room_unavailable`)
  transitions: ScenarioTransition[]; // пусто только у конечного узла
  end: { outcome: "success" | "alt_success" | "fail"; summary: Localized } | null;
}

export interface ScenarioPayload {
  scenario_id: string; // sc-travel-hotel-checkin
  title: Localized;
  /** задача ученика в сценарии */
  task: Localized;
  goals: GoalCode[];
  topics: TopicCode[];
  level: Band;
  difficulty: 1 | 2 | 3 | 4 | 5;
  audience: AudienceSegment[];
  access: "free"; // premium — спринт 8
  characters: ScenarioCharacter[]; // ≥ 1
  start_node: string;
  nodes: Record<string, ScenarioNode>; // 5..30 узлов
  completion: { criteria: Localized };
  skill_ids: string[];
  rubric_id: string;
}

/** Результат тестового прогона сценария (catalog, AT-28). Публикация — только при ok=true. */
export interface ScenarioTestRun {
  ok: boolean;
  checked_at: string;
  issues: Array<{
    code:
      | "START_MISSING" | "UNKNOWN_NODE" | "UNREACHABLE_NODE" | "DEAD_END" | "NO_SUCCESS_END" | "TRAP"
      | "UNKNOWN_SPEAKER" | "NO_RECOVERY_POINT" | "RECOVERY_CANNOT_FINISH" | "TOO_MANY_NODES";
    node_id: string | null;
    detail: string;
  }>;
  stats: { nodes: number; ends: { success: number; alt_success: number; fail: number }; max_depth: number; paths_to_success: number };
}

// ---------------------------------------------------------------------------------------------------------------------
// Медиа с правами (ADM-MEDIA-01…03, APP-MEDIA-01)
// ---------------------------------------------------------------------------------------------------------------------

export type MediaType = "song" | "movie" | "interview" | "dialogue" | "own_scene";
/** platform_embed и licensed закрыты флагом media.external_sources (до решения владельца и юриста). */
export type MediaOrigin = "own_recording" | "public_domain" | "open_license" | "licensed" | "platform_embed";
export type MediaUse = "listen" | "show_transcript" | "exercises" | "dictionary" | "translation";

export interface MediaRights {
  owner: string; // правообладатель («TilHero» для своих)
  license_type: "own" | "cc0" | "cc_by" | "cc_by_sa" | "public_domain" | "contract";
  license_ref: string | null; // ссылка или номер договора
  attribution: string | null; // обязательна для cc_by*, отображается ученику
  territories: string[]; // ISO 3166-1 alpha-2, должна быть UZ
  valid_from: string; // YYYY-MM-DD
  valid_to: string | null; // null — бессрочно
  allowed_uses: MediaUse[];
}

export interface TranscriptLine {
  t_start_ms: number;
  t_end_ms: number;
  speaker: string;
  text_en: string; // ≤ 240
  gloss: Localized;
}

export interface MediaPayload {
  asset_id: string; // m-own-coffee-order
  type: MediaType;
  origin: MediaOrigin;
  title: Localized;
  original_title: string | null;
  language: string; // en
  level: Band;
  topics: TopicCode[];
  skill_ids: string[];
  audience: AudienceSegment[];
  duration_s: number; // 5..90
  transcript: TranscriptLine[]; // ≥ 1, по возрастанию времени, без перекрытий, в пределах duration
  phrases: Array<{ en: string; gloss: Localized; t_ms: number }>; // для словаря (спринт 5)
  /** id файла аудио в catalog (загрузка в админке); null — озвучка синтезом речи устройства */
  audio_blob_id: string | null;
  embed: { provider: "youtube"; video_id: string; start_s: number; end_s: number } | null;
  rights: MediaRights;
}

export type MediaExerciseType = "comprehension" | "gap_fill" | "order_lines" | "phrase_meaning" | "shadowing" | "roleplay";

export interface MediaExercisePayload {
  exercise_id: string;
  asset_id: string;
  type: MediaExerciseType;
  skill_id: string;
  level: Band;
  instruction: Localized;
  /** comprehension/phrase_meaning: вопрос и варианты (answer — индекс); gap_fill: строка с ___ и допустимые ответы;
   *  order_lines: реплики из транскрипта (answer — правильный порядок индексов); shadowing: line_index;
   *  roleplay: цель на Localized в instruction, answer — null */
  prompt_en: string | null;
  options: string[];
  answer: number | number[] | string[] | null;
  line_index: number | null;
  rubric_id: string | null;
}

/** Заявка ученика на песню или фильм (APP-MEDIA-04, ADM-MEDIA-04). Ничего не скачивается автоматически. */
export type MediaRequestStatus = "new" | "in_review" | "authored_alternative" | "licensed" | "rejected" | "duplicate";
