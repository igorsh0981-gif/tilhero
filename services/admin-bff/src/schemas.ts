/**
 * JSON Schema входа admin-bff (Ajv Fastify, без приведения типов и без удаления лишних полей: лишнее поле → 422).
 * querystring и params — строки (числа разбираются вручную), тело — строгие типы. Это первая линия (форма и
 * границы из admin.ts); домены проверяют повторно и глубже (переводы, плейсхолдеры, переходы статусов).
 */
import { ALL_PERMISSIONS, ROLE_CODES } from "./rbac.js";

export type Schema = Record<string, unknown>;

export const str = (minLength: number, maxLength: number, extra: Schema = {}): Schema => ({
  type: "string",
  minLength,
  maxLength,
  ...extra,
});

export const obj = (properties: Record<string, Schema>, required: string[] = [], extra: Schema = {}): Schema => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
  ...extra,
});

export const enumOf = (values: readonly string[]): Schema => ({ type: "string", enum: [...values] });
export const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: "null" }] });
export const arrayOf = (items: Schema, minItems: number, maxItems: number, extra: Schema = {}): Schema => ({
  type: "array",
  items,
  minItems,
  maxItems,
  ...extra,
});
export const integer = (minimum: number, maximum: number): Schema => ({ type: "integer", minimum, maximum });

export const UUID = str(36, 36, { pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" });
export const ROLE = enumOf(ROLE_CODES);
export const PERMISSION = enumOf(ALL_PERMISSIONS);
export const PERIOD = enumOf(["today", "7d", "30d"]);
export const LIMIT_Q = str(1, 3, { pattern: "^(?:[1-9]|[1-9][0-9]|100)$" });
export const CURSOR_Q = str(1, 512, { pattern: "^[A-Za-z0-9_=.:+/-]+$" });
export const BOOL_Q = enumOf(["true", "false"]);
export const ISO_Q = str(10, 40, { pattern: "^\\d{4}-\\d{2}-\\d{2}" });
export const TOTP = str(6, 6, { pattern: "^\\d{6}$" });
export const CHALLENGE = str(16, 128, { pattern: "^[A-Za-z0-9_-]+$" });
/** Причина привилегированного действия (аудит). */
export const REASON = str(3, 500);
/** Обращение: UUID или TCK-номер. */
export const TICKET_REF = str(1, 64, { pattern: "^[A-Za-z0-9-]+$" });
export const EXPECTED_VERSION = integer(1, 2_147_483_647);
/** Время ISO-8601 с зоной (send_at рассылки). */
export const DATETIME = str(20, 40, { pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:\\d{2})$" });

export const params = (props: Record<string, Schema>): Schema => obj(props, Object.keys(props));
export const query = (props: Record<string, Schema>): Schema => obj(props);

/** limit/cursor для доменов: строки querystring → числа и строки без пустых значений. */
export function pageQuery(q: { limit?: string; cursor?: string }): { limit?: number; cursor?: string } {
  return {
    ...(q.limit ? { limit: Number(q.limit) } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  };
}

export const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

// ---------------------------------------------------------------- ученики

export const UI_LANG = enumOf(["ru", "uz"]);
export const AGE_BAND = enumOf(["6-9", "10-13", "14-17", "18+"]);
export const LEARNER_KIND = enumOf(["account", "child"]);
export const LEARNER_STATUS = enumOf(["ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED"]);

// ---------------------------------------------------------------- поддержка

export const TICKET_STATUS = enumOf(["NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"]);
export const TICKET_PRIORITY = enumOf(["low", "normal", "high", "urgent"]);
export const TICKET_CATEGORY = enumOf([
  "LESSON",
  "ASSESSMENT",
  "SCHEDULE_REMINDERS",
  "CHILD_PROFILE",
  "ACCOUNT",
  "SUBSCRIPTION_PAYMENT",
  "PERSONAL_DATA",
  "BUG",
  "OTHER",
]);
export const ESCALATION_TYPE = enumOf(["billing_review", "assessment_review", "content_review", "tech_issue", "security_privacy"]);

// ---------------------------------------------------------------- «Что нового» (admin.ts ReleaseNoteContent)

export const NOTE_ROUTES = [
  "home", "lessons", "review", "progress", "profile", "schedule", "notifications", "family", "support", "news",
  // спринт 3
  "diagnostics", "plan", "skills", "scenarios", "media", "media_requests", "languages",
] as const;
export const NOTE_ICONS = [
  "spark", "hero", "calendar", "clock", "bell", "book", "chat", "mic", "star", "flame", "users", "gift", "shield", "globe", "trophy", "news",
] as const;
/**
 * Тексты RU/UZ: пустая строка допустима на входе — пустой перевод отклоняет домен кодом
 * RELEASE_NOTE_TRANSLATION_MISSING {missing: ["items[1].text.uz"]} (admin-web подсвечивает поле).
 */
const localized = (max: number): Schema => obj({ ru: str(0, max), uz: str(0, max) }, ["ru", "uz"]);
const NOTE_ITEM = obj(
  { title: localized(80), text: localized(200), link: nullable(enumOf(NOTE_ROUTES)), icon: nullable(enumOf(NOTE_ICONS)) },
  ["title", "text", "link", "icon"],
);
const SEGMENTS = obj({
  age: arrayOf(enumOf(["kids", "teens", "adults"]), 0, 3, { uniqueItems: true }),
  ui_lang: arrayOf(UI_LANG, 0, 2, { uniqueItems: true }),
});
export const NOTE_PROPS = {
  slug: str(1, 32, { pattern: "^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$" }),
  title: localized(80),
  items: arrayOf(NOTE_ITEM, 1, 6),
  audience: enumOf(["new", "existing", "all"]),
  segments: SEGMENTS,
};
const NOTE_REQUIRED = ["slug", "title", "items", "audience", "segments"];
export const NOTE_BODY = obj(NOTE_PROPS, NOTE_REQUIRED);
export const NOTE_UPDATE_BODY = obj({ ...NOTE_PROPS, expected_version: EXPECTED_VERSION }, [...NOTE_REQUIRED, "expected_version"]);

// ---------------------------------------------------------------- шаблоны уведомлений и рассылки

/** Ключ шаблона из реестра notifications (lesson.reminder, lesson.reminder.kid, release_note.published, …). */
export const TEMPLATE_KEY = str(1, 64, { pattern: "^[a-z][a-z0-9_]*(\\.[a-z0-9_]+){0,5}$" });
/** Номер версии шаблона в пути. */
export const VERSION_NO = str(1, 9, { pattern: "^[1-9][0-9]{0,8}$" });
/**
 * Текст одного языка: title ≤ 80, body ≤ 1000, button ≤ 32 (null — кнопка по умолчанию). Пустые title/body
 * отклоняет домен (TEMPLATE_INVALID {fields: [{path, reason}]}) — чтобы admin-web подсветил поле.
 */
const TEMPLATE_TEXT = obj({ title: str(0, 80), body: str(0, 1000), button: nullable(str(0, 32)) }, ["title", "body", "button"]);
export const TEMPLATE_TEXTS = obj({ ru: TEMPLATE_TEXT, uz: TEMPLATE_TEXT }, ["ru", "uz"]);
export const TEMPLATE_VERSION_CREATE = obj({ texts: TEMPLATE_TEXTS, note: str(3, 300) }, ["texts", "note"]);
export const PREVIEW_REQUEST = obj(
  {
    lang: UI_LANG,
    sample: { type: "object", maxProperties: 20, propertyNames: { pattern: "^[a-z][a-z0-9_]{0,39}$" }, additionalProperties: str(0, 200) },
  },
  ["lang"],
);
export const TEST_SEND_REQUEST = obj({ lang: UI_LANG, recipient: integer(0, 99) }, ["lang", "recipient"]);
export const CAMPAIGN_STATUS = enumOf(["draft", "scheduled", "sending", "done", "stopped"]);
const CAMPAIGN_SEGMENT = obj({
  ui_lang: arrayOf(UI_LANG, 0, 2, { uniqueItems: true }),
  // детские профили не адресуются рассылками никогда: kids в сегменте → 422 у BFF и у домена
  age: arrayOf(enumOf(["teens", "adults"]), 0, 2, { uniqueItems: true }),
  onboarded: { type: "boolean" },
  active_days: { type: "integer", minimum: -90, maximum: 90, not: { const: 0 } },
});
export const CAMPAIGN_PROPS = {
  title: str(1, 120),
  texts: TEMPLATE_TEXTS,
  route: nullable(enumOf(NOTE_ROUTES)),
  segment: CAMPAIGN_SEGMENT,
};
export const CAMPAIGN_CREATE = obj(CAMPAIGN_PROPS, ["title", "texts", "route", "segment"]);
export const CAMPAIGN_PATCH = obj({ ...CAMPAIGN_PROPS, expected_version: EXPECTED_VERSION }, ["expected_version"], { minProperties: 2 });
/** send_at: null — «Отправить сейчас» по часам сервера (admin.ts CampaignScheduleInput; QA D2-03, ревью T2-11). */
export const CAMPAIGN_SCHEDULE = obj(
  { expected_version: EXPECTED_VERSION, send_at: nullable(DATETIME), reason: REASON },
  ["expected_version", "send_at", "reason"],
);

// ---------------------------------------------------------------- контент и диагностика (спринт 3, admin.ts)

export const CONTENT_KINDS = ["course", "skill", "module", "lesson", "rubric", "scenario", "media_asset", "media_exercise"] as const;
export const VERSION_STATUSES = ["draft", "in_review", "approved", "published", "suspended", "archived"] as const;
export const BANDS = ["A0", "A1", "A2", "B1", "B2"] as const;
export const LOCALE_CHECKS = ["missing", "draft", "checked"] as const;
export const MEDIA_REQUEST_STATUSES = ["new", "in_review", "authored_alternative", "licensed", "rejected", "duplicate"] as const;
export const AUDIO_TYPES = ["audio/mpeg", "audio/ogg", "audio/mp4"] as const;
/** Аудио ≤ 3 МБ (catalog MAX_AUDIO_BYTES): в base64 — ≤ 4 194 304 символа; домен проверяет размер и сигнатуру. */
export const AUDIO_MAX_BYTES = 3 * 1024 * 1024;
/** Лимит тела POST /admin/v1/content/blobs — «4,5 МБ», как UPLOAD_MAX_BYTES catalog (остальные маршруты — 64 КБ). */
export const UPLOAD_BODY_LIMIT = 4_500_000;
/** Тело версии контента (сценарий до 30 узлов с RU/UZ) — до лимита тела домена (tilhero_common, 256 КБ). */
export const CONTENT_BODY_LIMIT = 256 * 1024;

export const CONTENT_KIND = enumOf(CONTENT_KINDS);
/** Идентификатор сущности контента (content.ts): [a-z0-9][a-z0-9._-]{1,63}. */
export const CONTENT_KEY = str(2, 64, { pattern: "^[a-z0-9][a-z0-9._-]{1,63}$" });
export const VERSION_STATUS = enumOf(VERSION_STATUSES);
export const BAND = enumOf(BANDS);
export const LOCALE_CHECK = enumOf(LOCALE_CHECKS);
/** Тело версии — JSON-объект; схему вида проверяет catalog (422 CONTENT_INVALID {errors: [{path, code, message}]}). */
export const CONTENT_PAYLOAD: Schema = { type: "object" };
export const CONTENT_CREATE = obj({ payload: CONTENT_PAYLOAD }, ["payload"]);
export const CONTENT_NEW_VERSION = obj({ from_version: integer(1, 2_147_483_647) }, ["from_version"]);
export const CONTENT_UPDATE = obj(
  { payload: CONTENT_PAYLOAD, expected_hash: str(64, 64, { pattern: "^[0-9a-f]{64}$" }) },
  ["payload", "expected_hash"],
);
/** ContentReviewInput: note 3..1000; при approve обе отметки должны быть checked — проверяет домен. */
export const CONTENT_REVIEW = obj(
  {
    decision: enumOf(["approve", "return"]),
    note: str(3, 1000),
    locale_checks: obj({ ru: LOCALE_CHECK, uz: LOCALE_CHECK }, ["ru", "uz"]),
  },
  ["decision", "note", "locale_checks"],
);
export const CONTENT_ROLLBACK = obj({ to_version: integer(1, 2_147_483_647), reason: REASON }, ["to_version", "reason"]);
/** Подтверждение прав медиа: note 3..1000 (catalog RightsApproveIn). */
export const RIGHTS_APPROVE = obj({ note: str(3, 1000) }, ["note"]);
/** AudioUpload: base64 без пробелов; размер (> 3 МБ), тип и сигнатуру проверяет домен — 422 AUDIO_INVALID {reason}. */
export const AUDIO_UPLOAD = obj(
  {
    filename: str(1, 200),
    content_type: enumOf(AUDIO_TYPES),
    data_base64: str(4, 4_400_000, { pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
  },
  ["filename", "content_type", "data_base64"],
);
export const MEDIA_REQUEST_STATUS = enumOf(MEDIA_REQUEST_STATUSES);
/** MediaRequestDecision: linked_asset_id — для authored_alternative | licensed (обязательность проверяет домен). */
export const MEDIA_REQUEST_DECISION = obj(
  {
    status: enumOf(["authored_alternative", "licensed", "rejected", "duplicate"]),
    note: str(3, 500),
    linked_asset_id: CONTENT_KEY,
  },
  ["status", "note"],
);

const LANG_CODE_PATTERN = "^[a-z]{2,3}(-[A-Z]{2})?$";
export const LANG_CODE = str(2, 6, { pattern: LANG_CODE_PATTERN });
export const PAIR_ID = str(5, 7, { pattern: "^[a-z]{2,3}-[a-z]{2,3}$" });
const SHORT_TEXT = (max: number) => str(1, max);
/** Language (content.ts) — тело PUT /admin/v1/languages/{code}. */
export const LANGUAGE_BODY = obj(
  {
    code: LANG_CODE,
    name: obj({ ru: SHORT_TEXT(80), uz: SHORT_TEXT(80), en: SHORT_TEXT(80) }, ["ru", "uz", "en"]),
    script: enumOf(["Latn", "Cyrl"]),
    variants: arrayOf(LANG_CODE, 0, 20, { uniqueItems: true }),
    asr: nullable(obj({ provider: SHORT_TEXT(60), model: SHORT_TEXT(120) }, ["provider", "model"])),
    tts: nullable(obj({ provider: SHORT_TEXT(60), voices: arrayOf(SHORT_TEXT(60), 0, 50) }, ["provider", "voices"])),
    limitations: nullable(str(0, 1000)),
    status: enumOf(["active", "planned"]),
  },
  ["code", "name", "script", "variants", "asr", "tts", "limitations", "status"],
);
export const PAIR_STATUSES = ["planned", "development", "review", "pilot", "published", "archived"] as const;
/** LanguagePair & {reason} — тело PUT /admin/v1/language-pairs/{pair_id}. Тексты RU/UZ пустыми проверяет домен. */
export const PAIR_BODY = obj(
  {
    pair_id: PAIR_ID,
    source: LANG_CODE,
    target: LANG_CODE,
    explanation_locales: arrayOf(LANG_CODE, 1, 5, { uniqueItems: true }),
    ui_locales: arrayOf(UI_LANG, 1, 2, { uniqueItems: true }),
    title: obj({ ru: str(0, 1000), uz: str(0, 1000) }, ["ru", "uz"]),
    status: enumOf(PAIR_STATUSES),
    release_at: nullable(str(10, 40, { pattern: "^\\d{4}-\\d{2}-\\d{2}" })),
    course_id: nullable(CONTENT_KEY),
    reason: REASON,
  },
  ["pair_id", "source", "target", "explanation_locales", "ui_locales", "title", "status", "release_at", "course_id", "reason"],
);
/** Идентификатор теста диагностики (dx-en-adult). */
export const TEST_ID = CONTENT_KEY;

// ---------------------------------------------------------------- ИИ, контроль диалогов, затраты (спринт 4, admin.ts, ai.ts)

/** 17 агентов LinguaFlow (ai.ts AgentId) — порядок как в контракте. */
export const AGENT_IDS = [
  "learning_orchestrator", "diagnostic_assessor", "curriculum_planner", "teaching_coach", "conversation_partner",
  "independent_evaluator", "error_analyst", "spaced_repetition_coach", "pronunciation_coach", "evening_review_coach",
  "safety_quality_gate", "cooperative_lesson_coach", "gameplay_director", "duel_host", "referral_integrity_reviewer",
  "media_lesson_designer", "language_pathway_advisor",
] as const;
export const AUDIENCE_SEGMENTS = ["kids", "teens", "adults"] as const;
export const RUBRIC_CRITERIA = ["task", "vocabulary", "grammar", "independence", "pronunciation", "fluency", "comprehension"] as const;
export const SESSION_KINDS = ["lesson", "scenario", "media", "review"] as const;
export const SESSION_STATUSES = ["ready", "in_progress", "paused", "completed", "failed", "cancelled"] as const;
export const SESSION_OUTCOMES = ["success", "alt_success", "fail"] as const;
export const SESSION_FLAGS = ["ai_used", "ai_unavailable", "hints", "human_review", "appealed", "flagged", "failed"] as const;
export const APPEAL_STATUSES = ["new", "in_review", "upheld", "corrected"] as const;
export const SKILL_OUTCOMES = ["demonstrated", "learning", "not_assessed"] as const;
export const ERROR_SEVERITIES = ["low", "medium", "high"] as const;
export const USAGE_PERIODS = ["day", "week", "month"] as const;

export const AGENT_ID = enumOf(AGENT_IDS);
/** Модель маршрутизации: claude-haiku-5-5, claude-sonnet-5-5, fake. */
export const MODEL_ID_PATTERN = "^[a-z0-9][a-z0-9._-]{1,63}$";
export const MODEL_ID = str(2, 64, { pattern: MODEL_ID_PATTERN });
/** Идентификатор золотого теста: UUID или код сида (cp-01-correct). */
export const CASE_ID = str(1, 64, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$" });
/** Навык (skill_id каталога): как ключ контента. */
export const SKILL_ID = CONTENT_KEY;
/** Причина просмотра реплик, переоценки (≥ 10, admin.ts). */
export const QA_REASON = str(10, 500);
/** If-Match черновика версии агента (updated_at версии) — передаётся в ai-gateway как есть. */
export const IF_MATCH_RE = /^"?[0-9A-Za-z:.+_-]{1,62}"?$/;
/**
 * Лимит тела маршрутов версий агента: инструкции ≤ 20 000 и правила ≤ 10 000 символов (до 30 000 вместе; кириллица в
 * UTF-8 — 2 байта, плюс экранирование JSON и JSON Schema вывода) — 128 КБ; остальные маршруты ИИ — 64 КБ.
 */
export const AGENT_VERSION_BODY_LIMIT = 128 * 1024;

/** POST …/versions {from_version?} — черновик из опубликованной (по умолчанию) или указанной версии. */
export const AGENT_VERSION_CREATE = obj({ from_version: integer(1, 2_147_483_647) });
/** AgentVersionPatch (admin.ts): хотя бы одно поле; JSON Schema вывода — объект как есть (проверяет ai-gateway). */
export const AGENT_VERSION_PATCH = obj(
  {
    instructions: str(0, 20_000),
    rules: str(0, 10_000),
    output_schema: { type: "object" },
    schema_version: str(1, 64, { pattern: "^[a-z][a-z0-9_.-]{0,63}$" }),
    model_id: MODEL_ID,
    fallback_model_id: nullable(MODEL_ID),
    temperature: { type: "number", minimum: 0, maximum: 1 },
    max_output_tokens: integer(1, 2000),
    timeout_ms: integer(2000, 30_000),
    max_cost_usd: { type: "number", minimum: 0, maximum: 10 },
    notes: nullable(str(0, 2000)),
  },
  [],
  { minProperties: 1 },
);
export const AGENT_CANARY_SET = obj(
  { version: integer(1, 2_147_483_647), percent: integer(1, 50), reason: REASON },
  ["version", "percent", "reason"],
);
export const REASON_ONLY = obj({ reason: REASON }, ["reason"]);

const PATH_S = str(1, 200, { pattern: "^[A-Za-z0-9_$.\\[\\]-]+$" });
const SCALAR: Schema = { anyOf: [str(0, 1000), { type: "number" }, { type: "boolean" }, { type: "null" }] };
/** GoldenCheck (ai.ts) — по виду проверки ровно её поля. */
export const GOLDEN_CHECK: Schema = {
  oneOf: [
    obj({ kind: { const: "schema_valid" } }, ["kind"]),
    obj({ kind: { const: "field_equals" }, path: PATH_S, value: SCALAR }, ["kind", "path", "value"]),
    obj({ kind: { const: "field_in" }, path: PATH_S, values: arrayOf(SCALAR, 1, 50) }, ["kind", "path", "values"]),
    obj({ kind: { const: "field_absent" }, path: PATH_S }, ["kind", "path"]),
    obj({ kind: { const: "text_not_contains" }, path: PATH_S, values: arrayOf(str(1, 200), 1, 50) }, ["kind", "path", "values"]),
    obj({ kind: { const: "max_length" }, path: PATH_S, n: integer(1, 100_000) }, ["kind", "path", "n"]),
  ],
};
const GOLDEN_PROPS = {
  title: str(1, 200),
  /** вход агента: аудитория (проверка отказа детям) и контекст — JSON-объект как есть (проверяет ai-gateway) */
  input: obj({ audience: enumOf(AUDIENCE_SEGMENTS), context: { type: "object" } }, ["audience", "context"]),
  checks: arrayOf(GOLDEN_CHECK, 1, 50),
  mandatory: { type: "boolean" },
};
export const GOLDEN_CASE_CREATE = obj(GOLDEN_PROPS, ["title", "input", "checks", "mandatory"]);
export const GOLDEN_CASE_PATCH = obj(GOLDEN_PROPS, [], { minProperties: 1 });

const USD = (max: number): Schema => ({ type: "number", minimum: 0, maximum: max });
export const MODEL_UPDATE = obj(
  { input_usd_per_mtok: USD(1000), output_usd_per_mtok: USD(1000), active: { type: "boolean" }, reason: REASON },
  ["input_usd_per_mtok", "output_usd_per_mtok", "active", "reason"],
);
/**
 * PUT budget: поля AiBudget & {reason}; ai_enabled — необязательно (аварийная остановка — своя команда), updated_at —
 * необязательно (защита ai-gateway от гонки правок → 409 BUDGET_CONFLICT {updated_at}).
 */
export const BUDGET_UPDATE = obj(
  {
    ai_enabled: { type: "boolean" },
    updated_at: DATETIME,
    monthly_cap_usd: USD(100_000),
    learner_daily_cap_usd: USD(1000),
    lesson_cap_usd: USD(1000),
    alert_percent: integer(1, 100),
    reason: REASON,
  },
  ["monthly_cap_usd", "learner_daily_cap_usd", "lesson_cap_usd", "alert_percent", "reason"],
);
export const EMERGENCY_STOP = obj({ enabled: { type: "boolean" }, reason: REASON }, ["enabled", "reason"]);

/** Страница журнала сессий: ≤ 50 строк (затраты строки — отдельный вызов ai-gateway, не больше 50 параллельно). */
export const QA_LIMIT_Q = str(1, 2, { pattern: "^(?:[1-9]|[1-4][0-9]|50)$" });
export const TRANSCRIPT_REQUEST = obj({ reason: QA_REASON }, ["reason"]);
export const FLAG_REQUEST = obj({ reason: str(3, 500) }, ["reason"]);
const SCORE = { anyOf: [integer(0, 3), { type: "null" }] };
export const CONFIRMED_ERROR = obj(
  {
    turn_id: str(1, 64, { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$" }),
    evidence: str(1, 120),
    correction: str(1, 200),
    error_code: str(1, 64, { pattern: "^[a-z][a-z0-9_]{0,63}$" }),
    severity: enumOf(ERROR_SEVERITIES),
  },
  ["turn_id", "evidence", "correction", "error_code", "severity"],
);
export const REEVALUATION = obj(
  {
    scores: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(RUBRIC_CRITERIA.map((c) => [c, SCORE])),
    },
    skill_outcomes: arrayOf(obj({ skill_id: SKILL_ID, outcome: enumOf(SKILL_OUTCOMES) }, ["skill_id", "outcome"]), 0, 100),
    confirmed_errors: arrayOf(CONFIRMED_ERROR, 0, 5),
    reason: QA_REASON,
    appeal_id: nullable(UUID),
  },
  ["scores", "skill_outcomes", "confirmed_errors", "reason"],
);
export const APPEAL_DECISION = obj(
  { decision: enumOf(["upheld", "corrected"]), note: str(10, 500), new_evaluation_id: nullable(UUID) },
  ["decision", "note"],
);
