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
  /** где реализован, для code/rules: «lessons», «learning-plan», «diagnostics», «ai-gateway» */
  implemented_in: string | null;
}

export type SessionKind = "lesson" | "scenario" | "media" | "review";

// ---------------------------------------------------------------------------------------------------------------------
// Вызов агента: POST /internal/v1/agents/{agent_id}/invoke (вызывающие lessons, assessment)
// ---------------------------------------------------------------------------------------------------------------------

export interface AgentInvokeRequest<C = AgentContext> {
  request_id: string; // UUID; повтор с тем же request_id ≤ 24 ч → сохранённый результат
  session_id: string;
  session_kind: SessionKind;
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
  | "budget_exceeded" // месячный потолок, лимит ученика за день или урока (и резервная модель не помещается)
  | "cost_limit" // max_cost_usd версии на вызов: следующая попытка (и резервная модель) не помещается
  | "provider_error"
  | "timeout" // таймаут провайдера или дедлайн вызывающего
  | "invalid_output"; // после повтора с ограничениями и резервной модели
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
export interface TeachingCoachOutput {
  explanation: string; // на explain_locale, ≤ 400
  example_en: string; // ≤ 160
  example_gloss: string; // на explain_locale, ≤ 200
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

export type AgentContext = ConversationPartnerContext | TeachingCoachContext | IndependentEvaluatorContext;
export type AgentOutput = ConversationPartnerOutput | TeachingCoachOutput | IndependentEvaluatorOutput;

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
  model_id: string; // claude-haiku-5-5
  provider: "anthropic" | "fake";
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  active: boolean;
  updated_at: string;
}

export interface AiBudget {
  ai_enabled: boolean; // false — аварийная остановка: все вызовы unavailable (ai_disabled)
  monthly_cap_usd: number; // по умолчанию 20
  learner_daily_cap_usd: number; // 0.05
  lesson_cap_usd: number; // 0.03
  alert_percent: number; // 80 — предупреждение на обзоре
  updated_at: string;
}

export interface AiProviderStatus {
  provider: "anthropic" | "fake";
  key_configured: boolean; // ключ задан в переменной ai-gateway (сам ключ не показывается никогда)
  last_error: { code: string; at: string } | null;
  ai_enabled: boolean; // false — аварийная остановка; для ролей без costs.read (баннер «ИИ выключен»)
}
