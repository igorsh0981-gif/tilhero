/**
 * Агенты ИИ TilHero (спринт 4): реестр, вызов через ai-gateway, контексты и выводы агентов спринта.
 * Единственный источник типов для ai-gateway, lessons, assessment и админки (admin.ts импортирует отсюда).
 * Скиллы — LinguaFlow 1.2 `skills/*.md`; контракт агента — `docs/04_Архитектура_и_агенты.md` §4.
 * Правило: ИИ необязателен — при status unavailable/refused вызывающий продолжает без ИИ.
 * Поля контекста с суффиксом `_en` (title_en, task_en, role_en, description_en, goal_en, completion_criteria_en,
 * descriptor_en) — описательные: английский текст, если он есть в контенте (реплики, примеры), иначе русская
 * локализация из catalog (заголовки, задачи, роли, описания переходов, цели, критерии, дескрипторы рубрик).
 * Модель отвечает по правилам версии независимо от языка описаний.
 */
import type { AudienceSegment, Band, Localized } from "./content.js";

/** 17 агентов LinguaFlow (agent_id постоянен, меняются только версии). */
export type AgentId =
  | "learning_orchestrator"
  | "diagnostic_assessor"
  | "curriculum_planner"
  | "teaching_coach"
  | "conversation_partner"
  | "independent_evaluator"
  | "error_analyst"
  | "spaced_repetition_coach"
  | "pronunciation_coach"
  | "evening_review_coach"
  | "safety_quality_gate"
  | "cooperative_lesson_coach"
  | "gameplay_director"
  | "duel_host"
  | "referral_integrity_reviewer"
  | "media_lesson_designer"
  | "language_pathway_advisor";

/** llm — инструкции и модель через ai-gateway; rules — детерминированные правила; code — логика сервиса. */
export type AgentImplementation = "llm" | "rules" | "code";

export interface Agent {
  agent_id: AgentId;
  title: Localized;
  purpose: Localized;
  owner_role: string; // «methodist», «platform»
  implementation: AgentImplementation;
  availability: "active" | "planned";
  planned_sprint: number | null; // для planned
  /** принимает свободный текст ученика (детям — нет) */
  free_text: boolean;
  /** где реализован, для code/rules: «lessons», «learning-plan», «diagnostics», «ai-gateway»; спринт 7 — duel_host
   *  «lessons», referral_integrity_reviewer «social» */
  implemented_in: string | null;
}

/** Вид сессии lessons (спринт 5: + reading — текст для чтения в практике; спринт 7: + duel — задания дуэли, без ИИ
 *  и без независимой оценки). */
export type SessionKind = "lesson" | "scenario" | "media" | "review" | "reading" | "duel";
/** Вид сессии вызова агента: занятие lessons или memory (перевод по тапу, произношение; session_id — дневной
 *  уникальный идентификатор memory: uuid5(«memory-gloss», user_id:local_date)); спринт 7: pair — парная комната
 *  (session_id = room_id; коуч cooperative_lesson_coach). */
export type AiSessionKind = SessionKind | "memory" | "pair";

// ---------------------------------------------------------------------------------------------------------------------
// Вызов агента: POST /internal/v1/agents/{agent_id}/invoke (вызывающие lessons, assessment; memory — только
// teaching_coach с gloss_word, а lessons и assessment gloss_word вызывать не могут — 403 CALLER_NOT_ALLOWED;
// спринт 7: cooperative_lesson_coach — только lessons)
// ---------------------------------------------------------------------------------------------------------------------

export interface AgentInvokeRequest<C = AgentContext> {
  request_id: string; // UUID; повтор с тем же request_id ≤ 24 ч → сохранённый результат
  session_id: string;
  session_kind: AiSessionKind;
  user_id: string; // активный ученик (lrn)
  audience: AudienceSegment;
  locale: "ru" | "uz";
  context: C;
  /** сколько вызывающий готов ждать с момента отправки, мс (1000..60000; нет — без дедлайна): шлюз не начинает
   *  попытку, если осталось < 1,5 с (→ unavailable: timeout), таймаут попытки = min(timeout_ms версии, остаток − 0,5 с);
   *  дубль request_id ждёт результат первого вызова не дольше дедлайна (и не дольше 25 с), иначе 409 */
  deadline_ms?: number;
}

export type AgentUnavailableReason =
  | "ai_disabled" // аварийная остановка или нет ключа провайдера
  | "not_configured" // речь: нет AZURE_SPEECH_KEY / AZURE_SPEECH_REGION (спринт 5)
  | "budget_exceeded" // месячный потолок, лимит ученика за день или урока (и резервная модель не помещается)
  | "cost_limit" // max_cost_usd версии на вызов: следующая попытка (и резервная модель) не помещается
  | "provider_error"
  | "timeout" // таймаут провайдера или дедлайн вызывающего
  | "invalid_output" // после повтора с ограничениями и резервной модели
  // спринт 8: уровень деградации paid_only — ученик без подписки (tier free) не обслуживается (до провайдера, $0)
  | "degraded";
export type AgentRefusedReason = "kids_not_allowed" | "agent_not_active";

export interface AgentInvokeResult<O = AgentOutput> {
  status: "ok" | "unavailable" | "refused";
  reason: AgentUnavailableReason | AgentRefusedReason | null;
  output: O | null; // проверен по JSON-схеме версии и правилам безопасности
  agent_id: AgentId;
  agent_version: number | null;
  prompt_version: string | null; // "{agent_id}@{version}"
  schema_version: string | null;
  model_id: string | null;
  canary: boolean;
  /** фактически оплаченная сумма (при unavailable после реальных попыток провайдера — не 0; refused — 0) */
  cost_usd: number;
  latency_ms: number;
  /** коды правил безопасности, сработавших и исправленных повтором: link_removed, too_long, … */
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------------------------------
// conversation_partner — реплика персонажа и распознанное намерение (переход делает lessons по графу сценария)
// ---------------------------------------------------------------------------------------------------------------------

export interface ConversationPartnerContext {
  scenario: { scenario_id: string; title_en: string; task_en: string; level: Band; characters: Array<{ id: string; name: string; role_en: string }> };
  node: {
    node_id: string;
    speaker: string;
    line_en: string;
    transitions: Array<{ intent: string; description_en: string; examples_en: string[] }>;
  };
  /** последние ≤ 6 реплик сцены */
  history: Array<{ speaker: "learner" | "character"; text: string }>;
  learner_turn: string; // ≤ 500
  attempts_on_node: number;
}
export interface ConversationPartnerOutput {
  /** один из node.transitions[].intent, либо unclear / off_topic */
  intent: string;
  reply_en: string; // ≤ 240 символов, ≤ 25 слов на A0–A2
  hint_offered: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// teaching_coach — «объясни проще» (взрослым и подросткам; без текста ученика)
// ---------------------------------------------------------------------------------------------------------------------

export interface TeachingCoachContext {
  lesson: { lesson_id: string; title_en: string; goal_en: string; level: Band; key_words: string[]; examples_en: string[] };
  request: "simpler_example" | "explain_again";
  explain_locale: "ru" | "uz";
  already_shown: string[]; // примеры, уже показанные ученику
}
/** teaching_coach v2 (спринт 5): перевод слова или выражения из опубликованного контента, которого нет в словаре курса.
 *  Вызывающий — memory (перевод по тапу). Текста ученика во входе нет — детям разрешено. Ответ кешируется в словаре
 *  курса (source ai, review_status pending) для всех учеников и проверяется методистом. */
export interface TeachingCoachGlossContext {
  request: "gloss_word";
  word: string; // ≤ 60, как в тексте
  sentence_en: string; // ≤ 300 — предложение, где встретилось слово (значение по контексту)
  level: Band;
  content_kind: "lesson" | "media_asset" | "reading" | "scenario";
}
export interface TeachingCoachOutput {
  explanation: string; // на explain_locale, ≤ 400
  example_en: string; // ≤ 160
  example_gloss: string; // на explain_locale, ≤ 200
}
export interface TeachingCoachGlossOutput {
  lemma: string; // ≤ 60, словарная форма («went» → «go»; выражение — как есть)
  part_of_speech: "noun" | "verb" | "adjective" | "adverb" | "pronoun" | "preposition" | "conjunction"
    | "interjection" | "determiner" | "phrase" | "other";
  /** значение в этом предложении; ru — кириллица, uz — латиница (oʻ, gʻ — U+02BB); без английских слов и ссылок */
  gloss: { ru: string; uz: string }; // ≤ 80 каждый
  forms: string[]; // ≤ 6 — словоформы лексемы (go, goes, went, gone, going)
  confidence: number; // 0..1; < 0.5 — ученику не выдаётся
}

// ---------------------------------------------------------------------------------------------------------------------
// independent_evaluator — оценка по рубрике (баллы 0..3 по критериям рубрики catalog)
// ---------------------------------------------------------------------------------------------------------------------

export type RubricCriterionCode =
  | "task" | "vocabulary" | "grammar" | "independence" | "pronunciation" | "fluency" | "comprehension";

export interface IndependentEvaluatorContext {
  rubric: {
    rubric_id: string;
    version: number;
    criteria: Array<{ code: RubricCriterionCode; weight: number; bands: Array<{ score: 0 | 1 | 2 | 3; descriptor_en: string }> }>;
    pass_rule: { min_weighted: number; min_per_criterion: 0 | 1 | 2 };
  };
  task: { goal_en: string; completion_criteria_en: string; outcome: "success" | "alt_success" | "fail" | null };
  /** реплики сцены и открытый ответ; оценивается только speaker=learner */
  turns: Array<{ turn_id: string; speaker: "learner" | "character" | "task"; text: string }>;
  hint_usage: { count: number; turn_ids: string[] };
  cefr_target: Band;
}
export interface ConfirmedError {
  turn_id: string; // T{n} реплики ученика или item_id задания
  evidence: string; // цитата из ответа ученика ≤ 120 — должна встречаться в нём дословно
  correction: string; // ≤ 200
  error_code: string; // missing_be, wrong_tense, article, word_order, vocabulary, …
  severity: "low" | "medium" | "high";
}
export interface IndependentEvaluatorOutput {
  status: "ok" | "insufficient_evidence";
  scores: Partial<Record<RubricCriterionCode, 0 | 1 | 2 | 3 | null>>;
  task_completed: boolean | null;
  confirmed_errors: ConfirmedError[]; // ≤ 5
  support_used: boolean;
  confidence: number; // 0..1
  pronunciation_score: null; // по тексту не оценивается
  cefr_certificate: false;
  requires_human_review: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// cooperative_lesson_coach (спринт 7, скилл 11) — ведущий парного урока: два ученика, роли A/B, ходы по очереди.
// Вызывающий — только lessons; session_kind "pair", session_id = room_id, user_id — участник, чей ход (или
// пригласивший при старте), audience — teens, если в комнате есть подросток, иначе adults; locale — язык этого
// участника (переводы коуч всё равно отдаёт на оба языка: у участников он может быть разным). Комнаты с ребёнком 6–13
// коуча не вызывают (сценарий с выбором реплик). Бюджет — AiBudget.room_cap_usd на комнату и месячный потолок;
// дневной лимит ученика к вызовам коуча не применяется. Агент не меняет кошелёк, не выдаёт уровень и не принимает
// приглашения; не раскрывает имя, контакты и реплики одного участника другому за пределами комнаты; не присваивает
// ответ одного участника другому (lessons проверяет: turn_id из individual_evidence принадлежит этой роли).
// Отличия от Output JSON скилла (решение спринта 7, INTERNAL_API §4): участники — только роли A/B (user_id, имён и
// ников во входе и выходе нет: next_speaker_user_id → next_speaker, individual_evidence[].user_id → role); статусы
// скилла pause/reconnect → paused (возврат участника — trigger partner_back → in_progress); waiting не используется —
// lessons вызывает коуча только после входа обоих (ожидание ведёт сама комната, status waiting).
// ---------------------------------------------------------------------------------------------------------------------

export type CoachRole = "A" | "B";

export interface CooperativeCoachContext {
  room_id: string;
  pair_id: string; // "ru-en"
  scenario: {
    scenario_id: string;
    title_en: string;
    task_en: string;
    level: Band;
    characters: Array<{ id: string; name: string; role_en: string }>;
    completion_criteria_en: string;
  };
  /** free — свободный текст или голос; choices — коуч даёт ≤ 3 варианта реплики для хода */
  mode: "free" | "choices";
  /** что произошло: start — оба вошли (раздать роли и цель); turn — пришла реплика; silence — участник молчит больше
   *  60 с в свой ход; partner_offline / partner_back — потеря и возврат связи; wrap_up — осталось ≤ 2 минут;
   *  end — комната завершается не по цели (участник ушёл, нет активности, остановлена администратором): нужен только
   *  итоговый отчёт (status finished, next_speaker null) */
  trigger: "start" | "turn" | "silence" | "partner_offline" | "partner_back" | "wrap_up" | "end";
  participants: Array<{
    role: CoachRole;
    turns: number;
    speaking_seconds: number;
    network: "online" | "offline";
    /** реплики голосом разрешены (согласие на голос) */
    voice: boolean;
  }>;
  /** роли, выданные при старте (null — ещё не выданы) */
  roles: { A: string; B: string } | null;
  team_goal_en: string | null;
  team_goal_progress: number; // 0..1, текущий
  /** последние ≤ 12 реплик комнаты; turn_id — T{n} */
  turns: Array<{ turn_id: string; speaker: CoachRole | "coach"; text: string; mode: "text" | "voice" | "choice" | null }>;
  remaining_minutes: number;
  /** сработавшие проверки безопасности по последней реплике (safety_quality_gate): abuse, personal_data, off_topic… */
  safety_flags: string[];
}

export interface CooperativeCoachOutput {
  /** эхо context.room_id (lessons отбрасывает ответ с чужим room_id как invalid_output) */
  room_id: string;
  /** in_progress — урок идёт; paused — ждём участника (offline); fallback_text — перейти на текст (голос недоступен);
   *  finished — цель достигнута, время вышло или trigger end */
  status: "in_progress" | "paused" | "fallback_text" | "finished";
  /** кто говорит следующим; both — общий ответ команды; null — никто (paused, finished) */
  next_speaker: CoachRole | "both" | null;
  /** реплика или вопрос коуча (английский, A1–B1, ≤ 300); при finished — короткое прощание */
  prompt: string;
  /** перевод подсказки на оба языка интерфейса (≤ 300 каждый; uz — латиница) или null; ученику BFF отдаёт его язык */
  prompt_gloss: { ru: string; uz: string } | null;
  /** только mode choices: ≤ 3 варианта реплики для next_speaker (английский, ≤ 160 каждый); иначе null */
  options: Array<{ choice_id: string; text_en: string }> | null;
  /** при trigger start — роли (английский, ≤ 120 каждая) и цель (≤ 200); иначе null */
  roles: { A: string; B: string } | null;
  team_goal_en: string | null;
  team_goal_progress: number; // 0..1, не убывает
  /** доказательства по ролям для независимого оценщика: только реплики этой роли из turns (роль без реплик — ни одного
   *  доказательства: молчавший не оценивается) */
  individual_evidence: Array<{ role: CoachRole; turn_id: string; skill_id: string | null; assist_used: boolean }>;
  /** safety — нарушение безопасности (lessons ставит паузу и предлагает жалобу); abuse — грубость участника */
  escalation: "safety" | "abuse" | null;
  /** только status finished (скилл 11, шаг 7): общая безопасная похвала команде (≤ 200 каждый язык) и приватные
   *  подсказки каждой роли (1–3, ≤ 160) — ошибки одной роли не упоминаются ни в похвале, ни в подсказках другой;
   *  роли без вклада подсказок нет. Иначе null. Без ИИ отчёт собирает lessons по шаблонам сценария. */
  report: {
    team_summary: { ru: string; uz: string };
    tips: Array<{ role: CoachRole; text: { ru: string; uz: string } }>;
  } | null;
}

export type AgentContext =
  | ConversationPartnerContext | TeachingCoachContext | TeachingCoachGlossContext | IndependentEvaluatorContext
  | CooperativeCoachContext;
export type AgentOutput =
  | ConversationPartnerOutput | TeachingCoachOutput | TeachingCoachGlossOutput | IndependentEvaluatorOutput
  | CooperativeCoachOutput;

// ---------------------------------------------------------------------------------------------------------------------
// duel_host (спринт 7, скилл 13) — implementation "code", implemented_in "lessons": детерминированный набор из 10
// закрытых заданий (sha256(duel_id)), сбалансированный по навыкам; ключи проверяет сервер; победителя определяет
// gamification. referral_integrity_reviewer (скилл 14) — implementation "rules", implemented_in "social": условия
// кампании и флаги риска → qualified | review | rejected; решение о награде — social и оператор. Входа и выхода через
// ai-gateway у них нет: в реестре агентов — только карточка (availability active).
// ---------------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------------
// pronunciation_coach (спринт 5) — оценка произношения по акустике + советы правилами. Релиз 5.1 (решение владельца
// 20.11.2026): по умолчанию свой сервер — сервис tts распознаёт запись (faster-whisper, модель в образе) и ai-gateway
// сравнивает распознанные слова с эталоном (разборчивость слов, без оценки отдельных звуков); Azure — запасной провайдер. POST /internal/v1/speech/pronunciation (вызывающий memory): тело audio/wav (PCM 16 бит, моно, 16 кГц,
// 0,5..15 с), заголовок X-Speech-Meta = base64url(JSON SpeechAssessMeta). Аудио не хранится нигде.
// ---------------------------------------------------------------------------------------------------------------------

export interface SpeechAssessMeta {
  request_id: string; // UUID; повтор ≤ 24 ч → сохранённый результат
  user_id: string; // lrn
  audience: AudienceSegment;
  locale: "ru" | "uz"; // язык советов
  reference_text: string; // 1..200, английский эталон (только из контента или карточки — подставляет memory)
  language: "en-US";
}

export type PronunciationErrorType = "none" | "omission" | "insertion" | "mispronunciation";

export interface PronunciationResult {
  status: "ok" | "insufficient_evidence" | "unavailable";
  /** unavailable: ai_disabled | not_configured | budget_exceeded | provider_error | timeout;
   *  insufficient_evidence: not_recognized | low_confidence | incomplete */
  reason: string | null;
  reference_text: string;
  /** 0..100 (HundredMark); null при insufficient_evidence/unavailable */
  scores: { accuracy: number; fluency: number; completeness: number; pron: number } | null;
  words: Array<{ word: string; accuracy: number | null; error_type: PronunciationErrorType }>; // ≤ 40
  /** разборчивость, не «акцент»: clear ≥ 80, mostly_clear 60..79, needs_practice < 60 */
  intelligibility: "clear" | "mostly_clear" | "needs_practice" | null;
  /** ≤ 2 совета на locale; только для слов mispronunciation (accuracy < 60) и omission */
  tips: Array<{ word: string; text: string }>;
  confidence: number | null; // NBest[0].Confidence
  audio_ms: number;
  /** whisper — свой сервер (релиз 5.1, сервис tts: распознавание faster-whisper и сравнение с эталоном по словам) */
  provider: "whisper" | "azure_speech" | "fake_speech" | null;
  cost_usd: number;
  latency_ms: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// speech:transcribe (спринт 7) — распознавание голосового хода парного урока. POST /internal/v1/speech:transcribe
// (вызывающий только lessons; иначе 403 CALLER_NOT_ALLOWED): тело audio/wav (PCM 16 бит, моно, 16 кГц, 0,5..15 с,
// ≤ 600 000 байт — пределы tts /internal/v1/recognize), заголовок X-Speech-Meta = base64url(JSON SpeechTranscribeMeta).
// Распознавание — tts (faster-whisper), расход $0 (провайдер whisper); Azure не используется. Аварийная остановка
// (ai_enabled=false) или speech_available=false → 503 SPEECH_UNAVAILABLE; tts недоступен или таймаут → 503
// SPEECH_UNAVAILABLE; 422 AUDIO_INVALID {reason: format | too_short | too_long | too_large}. Тишина — пустые text и
// words (не ошибка: lessons просит повторить или перейти на текст). Аудио и текст не хранятся и не пишутся в лог.
// ---------------------------------------------------------------------------------------------------------------------

export interface SpeechTranscribeMeta {
  request_id: string; // UUID; повтор ≤ 24 ч → сохранённый результат
  user_id: string; // участник, чей ход
  room_id: string;
  audience: AudienceSegment; // kids → 403 KIDS_NOT_ALLOWED (детям в комнате голос не разрешён)
  language: "en-US";
}

export interface SpeechTranscribeResult {
  text: string; // ≤ 600
  words: Array<{ word: string; start_ms: number; end_ms: number }>; // ≤ 120
  duration_ms: number;
  provider: "whisper" | "fake_speech";
  latency_ms: number;
}

/** GET /internal/v1/status (вызывающие lessons, assessment, memory) */
export interface AiStatus {
  ai_available: boolean; // нет аварийной остановки и провайдер LLM готов (лимиты не учитываются)
  speech_available: boolean; // нет аварийной остановки, ключ и регион Azure заданы, месячный потолок и подлимит речи не превышены
  /** спринт 8: действующий уровень деградации (аварийная остановка — off) */
  level: DegradationLevel;
  /** ИИ доступен ученику без подписки (tier free): level normal | economy */
  free_available: boolean;
  /** ИИ доступен подписчику (tier paid): level normal | economy | paid_only — lessons при старте урока с подпиской */
  paid_available: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Контроль ИИ (спринт 8, INTERNAL_API §7): бюджет по тарифу, уровни деградации, стоимость урока и минуты.
// Тариф ученика — проекция billing.access.changed.v1 (learner_tiers): paid — tier paid и paid_until null или > now;
// нет строки — free. Дневной лимит: free — AiBudget.learner_daily_cap_usd (0,05), paid — paid_learner_daily_cap_usd
// (0,30). Уровни: аварийная остановка → off; mode manual → заданный; mode auto → по доле расхода месяца (с резервами):
// < economy_at_percent — normal, < paid_only_at_percent — economy, < 100 % — paid_only, иначе off.
//  - economy — попытки сразу резервной моделью версии (fallback_model_id);
//  - paid_only — ученик free → unavailable: degraded до провайдера; paid — как economy;
//  - off — ai_disabled (аварийная остановка) / budget_exceeded.
// Золотые прогоны — только потолок месяца; произношение (Whisper, $0) — только off. Смена действующего уровня —
// degradation_events + событие ai.degradation.changed.v1; ручная — ещё аудит ai.degradation_updated.
// ---------------------------------------------------------------------------------------------------------------------

export type DegradationLevel = "normal" | "economy" | "paid_only" | "off";
export type DegradationMode = "auto" | "manual";
export type DegradationReason = "threshold" | "manual" | "emergency_stop" | "month_reset";

export interface DegradationEvent {
  seq: number;
  from: DegradationLevel;
  to: DegradationLevel;
  mode: DegradationMode;
  reason: DegradationReason;
  /** доля потолка месяца с резервами в момент смены, 0..1000 */
  spent_percent: number;
  /** staff_id сотрудника (manual); null — система */
  actor: string | null;
  at: string;
}

/** GET /admin/v1/ai/degradation (costs.read) → AiDegradation */
export interface AiDegradation {
  mode: DegradationMode;
  /** уровень, заданный вручную (mode manual); в auto — null */
  manual_level: DegradationLevel | null;
  /** действующий уровень сейчас */
  level: DegradationLevel;
  economy_at_percent: number; // 1..100, по умолчанию 80
  paid_only_at_percent: number; // economy_at_percent..100, по умолчанию 90
  /** доля потолка текущего месяца (UTC) с резервами */
  spent_percent: number;
  month: string; // YYYY-MM, UTC
  /** последние смены уровня (новые сверху, ≤ 20) */
  events: DegradationEvent[];
  updated_at: string;
}

/** PUT /admin/v1/ai/degradation (costs.manage, step-up) AiDegradationUpdate → AiDegradation; 1 ≤ economy_at_percent ≤
 *  paid_only_at_percent ≤ 100, manual_level обязателен при mode manual — иначе 422 DEGRADATION_INVALID. */
export interface AiDegradationUpdate {
  mode: DegradationMode;
  manual_level: DegradationLevel | null;
  economy_at_percent: number;
  paid_only_at_percent: number;
  reason: string; // 10..500
}

/** Стоимость занятий одного вида за период. USD — строки с 6 знаками после точки ("0.012345"). */
export interface AiUnitCostsKind {
  sessions: number;
  /** занятий, где ИИ работал (режим full, без деградации с начала) */
  ai_sessions: number;
  cost_usd: string;
  cost_per_ai_session_p50_usd: string | null;
  cost_per_ai_session_p95_usd: string | null;
  /** списано ИИ-минут (billable_minutes занятий) */
  billable_minutes: number;
  /** стоимость ИИ-минуты: cost_usd / billable_minutes; null — минут нет */
  cost_per_billable_minute_usd: string | null;
}

/** GET /admin/v1/ai/unit-costs?period=week|month (costs.read | dashboard.read) → AiUnitCosts. Источник — session_costs
 *  (lesson.session.completed.v1, lesson.pair.completed.v1) и учёт вызовов ai-gateway. */
export interface AiUnitCosts {
  period: "week" | "month";
  from: string;
  to: string;
  by_kind: { lesson: AiUnitCostsKind; scenario: AiUnitCostsKind; pair: AiUnitCostsKind };
  /** доля занятий, ушедших в упрощённый режим из-за деградации, 0..100; null — занятий нет */
  degraded_sessions_pct: number | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Версии, золотые тесты, модели, бюджет (формы admin API ai-gateway; admin.ts — маршруты и имена)
// ---------------------------------------------------------------------------------------------------------------------

export type AgentVersionStatus = "draft" | "published" | "archived";

export interface AgentVersion {
  agent_id: AgentId;
  version: number;
  status: AgentVersionStatus;
  instructions: string; // system, ≤ 20 000
  rules: string; // developer, ≤ 10 000
  output_schema: Record<string, unknown>; // JSON Schema вывода
  schema_version: string; // "conversation_partner.v1"
  model_id: string;
  fallback_model_id: string | null;
  temperature: number; // 0..1
  max_output_tokens: number; // ≤ 2000
  timeout_ms: number; // 2000..30000
  max_cost_usd: number; // на вызов
  notes: string | null;
  author_id: string;
  created_at: string;
  /** If-Match для PATCH черновика (иначе 428 IF_MATCH_REQUIRED / 409 VERSION_CONFLICT) */
  updated_at: string;
  /** версия сейчас на канарейке (заморожена) */
  canary: boolean;
  published_by: string | null;
  published_at: string | null;
  /** последний прогон золотых тестов этой версии */
  last_test_run: TestRunSummary | null;
}

/** Пути (dot-path, массивы — индекс) считаются от корня AgentInvokeResult: `status`, `reason`, `output.intent`,
 *  `output.confirmed_errors.0.evidence`. Прогон на провайдере fake проверяет только `schema_valid` и пути вне
 *  `output.*` (статус, отказ детям); проверки содержимого `output.*` помечаются skipped. Публикация в stage/prod —
 *  только по прогону на настоящем провайдере (anthropic); на dev-стенде допускается fake (флаг ai-gateway). */
export type GoldenCheck =
  | { kind: "schema_valid" }
  | { kind: "field_equals"; path: string; value: string | number | boolean | null }
  | { kind: "field_in"; path: string; values: Array<string | number | boolean | null> }
  | { kind: "field_absent"; path: string }
  | { kind: "text_not_contains"; path: string; values: string[] }
  | { kind: "max_length"; path: string; n: number };

export interface GoldenCase {
  case_id: string;
  agent_id: AgentId;
  title: string;
  /** вход агента: context (+ audience для проверки отказа детям) */
  input: { audience: AudienceSegment; context: AgentContext };
  checks: GoldenCheck[];
  mandatory: boolean;
  created_by: string;
  created_at: string;
  archived_at: string | null;
}

export interface TestRunSummary {
  run_id: string;
  agent_id: AgentId;
  version: number;
  status: "running" | "finished" | "failed";
  provider: "anthropic" | "fake";
  passed: number;
  failed: number;
  passed_mandatory: boolean;
  cost_usd: number;
  started_at: string;
  finished_at: string | null;
}
export interface TestRun extends TestRunSummary {
  results: Array<{ case_id: string; title: string; mandatory: boolean; passed: boolean; failures: string[];
                   /** проверки, не выполненные на этом провайдере (fake: содержимое output.*) */ skipped: string[];
                   latency_ms: number; cost_usd: number }>;
}

export interface AgentRollout {
  agent_id: AgentId;
  published_version: number | null;
  canary_version: number | null;
  canary_percent: number; // 0..50
  previous_version: number | null;
}

export interface AiModel {
  model_id: string; // claude-haiku-5-5; azure-speech-pa (спринт 5)
  provider: "anthropic" | "fake" | "whisper" | "azure_speech" | "fake_speech";
  input_usd_per_mtok: number; // речь — 0
  output_usd_per_mtok: number; // речь — 0
  /** речь: цена часа аудио (azure-speech-pa по умолчанию 1.32); LLM — null */
  audio_usd_per_hour: number | null;
  active: boolean;
  updated_at: string;
}

export interface AiBudget {
  ai_enabled: boolean; // false — аварийная остановка: все вызовы unavailable (ai_disabled)
  monthly_cap_usd: number; // по умолчанию 20
  learner_daily_cap_usd: number; // 0.05
  lesson_cap_usd: number; // 0.03
  /** спринт 5 (решение владельца 20.11.2026): подлимит оценки произношения внутри monthly_cap_usd, по умолчанию 5
   *  (≈ 3,8 ч аудио по $1,32/ч). Исчерпан — speech_available=false, «Произнести» скрыто; ИИ уроков и оценка не затронуты.
   *  0..monthly_cap_usd; повышение — costs.manage + step-up, как остальные лимиты. */
  speech_monthly_cap_usd: number;
  /** спринт 7 (INTERNAL_API §4, ai_room_cap_usd): потолок вызовов коуча на одну парную комнату, по умолчанию 0.10;
   *  0..monthly_cap_usd. Исчерпан — комната продолжается по сценарию с выбором реплик. */
  room_cap_usd: number;
  /** спринт 8 (В14): дневной лимит ученика с подпиской (tier paid), по умолчанию 0.30; у free — learner_daily_cap_usd.
   *  learner_daily_cap_usd ≤ paid_learner_daily_cap_usd ≤ monthly_cap_usd. */
  paid_learner_daily_cap_usd: number;
  alert_percent: number; // 80 — предупреждение на обзоре
  updated_at: string;
}

export interface AiProviderStatus {
  provider: "anthropic" | "fake";
  key_configured: boolean; // ключ задан в переменной ai-gateway (сам ключ не показывается никогда)
  last_error: { code: string; at: string } | null;
  ai_enabled: boolean; // false — аварийная остановка; для ролей без costs.read (баннер «ИИ выключен»)
  /** оценка произношения (спринт 5): ключ и регион Azure — общие переменные проекта, вводит владелец */
  speech: {
    /** whisper (релиз 5.1, по умолчанию) — свой сервер, ключ не нужен: key_configured = адрес сервиса распознавания
     *  задан, region = null */
    provider: "whisper" | "azure_speech" | "fake_speech";
    key_configured: boolean;
    region: string | null; // westeurope
    last_error: { code: string; at: string } | null;
  };
}
