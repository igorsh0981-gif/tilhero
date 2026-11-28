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
  // релиз 6.1: игра, словарь, чтение
  "heroes", "shop", "badges", "game_history", "game_settings", "dictionary", "reading",
  // спринт 7: друзья (заявки, блокировки, санкции), лиги недели, дуэли, рефералы
  "friends", "leagues", "duels", "referrals",
] as const;
/**
 * Ключ иллюстрации заметки (релиз 6.1) — limits.illustration_pattern каталога release-notes.json. Список ключей
 * (`illustrations`) проверяет experience-config (422 VALIDATION_ERROR), здесь — формат.
 */
export const ILLUSTRATION_PATTERN = "^[a-z0-9][a-z0-9-]{0,31}$";
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
  illustration: nullable(str(1, 32, { pattern: ILLUSTRATION_PATTERN })),
};
/** illustration необязательна на входе (admin-web до 6.1): при создании нет — null, при правке — домен её не меняет. */
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

/** ContentKind (content.ts); спринт 5 — + reading (тексты для чтения, общий API контента). */
export const CONTENT_KINDS = [
  "course", "skill", "module", "lesson", "rubric", "scenario", "media_asset", "media_exercise", "reading",
] as const;
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
/** SessionKind (ai.ts); спринт 5 — + reading (сессия чтения в журнале «Контроля диалогов»); спринт 7 — + duel (задания
 *  дуэли, без ИИ). */
export const SESSION_KINDS = ["lesson", "scenario", "media", "review", "reading", "duel"] as const;
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
/** Правка модели и цен; спринт 5 — + `audio_usd_per_hour` для модели речи (azure-speech-pa; не передана — прежняя,
 *  у LLM — null; цена > 0 у azure_speech и «снижение — только с costs.manage» проверяет ai-gateway). */
export const MODEL_UPDATE = obj(
  {
    input_usd_per_mtok: USD(1000),
    output_usd_per_mtok: USD(1000),
    audio_usd_per_hour: nullable(USD(1000)),
    active: { type: "boolean" },
    reason: REASON,
  },
  ["input_usd_per_mtok", "output_usd_per_mtok", "active", "reason"],
);
/**
 * PUT budget: поля AiBudget & {reason}; ai_enabled — необязательно (аварийная остановка — своя команда), updated_at —
 * необязательно (защита ai-gateway от гонки правок → 409 BUDGET_CONFLICT {updated_at}). Спринт 5: подлимит речи
 * `speech_monthly_cap_usd` — обязателен, 0..monthly_cap_usd (сравнение полей — в маршруте, до домена). Спринт 7: потолок
 * коуча на парную комнату `room_cap_usd` — 0..monthly_cap_usd; необязателен на входе (admin-web до спринта 7 его не
 * шлёт — ai-gateway оставляет прежний).
 */
export const BUDGET_UPDATE = obj(
  {
    ai_enabled: { type: "boolean" },
    updated_at: DATETIME,
    monthly_cap_usd: USD(100_000),
    learner_daily_cap_usd: USD(1000),
    lesson_cap_usd: USD(1000),
    speech_monthly_cap_usd: USD(100_000),
    room_cap_usd: USD(1000),
    // спринт 8 (В14): дневной лимит подписчика (tier paid); необязателен на входе (admin-web до спринта 8 его не шлёт —
    // ai-gateway оставляет прежний); learner_daily_cap_usd ≤ paid_learner_daily_cap_usd ≤ monthly_cap_usd — в маршруте
    paid_learner_daily_cap_usd: USD(1000),
    alert_percent: integer(1, 100),
    reason: REASON,
  },
  ["monthly_cap_usd", "learner_daily_cap_usd", "lesson_cap_usd", "speech_monthly_cap_usd", "alert_percent", "reason"],
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

// ---------------------------------------------------------------- память, словарь курса (спринт 5, admin.ts)

export const PART_OF_SPEECH_VALUES = [
  "noun", "verb", "adjective", "adverb", "pronoun", "preposition", "conjunction", "interjection", "determiner", "phrase", "other",
] as const;
export const GLOSSARY_SOURCES = ["course", "methodist", "ai"] as const;
export const GLOSSARY_REVIEW_STATUSES = ["not_required", "pending", "approved", "rejected"] as const;
export const GLOSSARY_REF_KINDS = ["lesson", "media_asset", "reading", "scenario"] as const;
export const GLOSSARY_ACTIONS = ["created", "updated", "reviewed", "archived", "overridden"] as const;
export const CARD_STATUSES = ["new", "learning", "review", "known", "frozen", "archived"] as const;
export const CARD_KINDS = ["word", "phrase", "error"] as const;
export const CHECK_STAGES = ["d7", "d30"] as const;
export const CHECK_STATUSES = ["scheduled", "in_session", "passed", "failed", "cancelled"] as const;
export const FSRS_STATES = ["new", "learning", "review"] as const;
export const ANSWER_MODES = ["choice", "typed", "assemble", "listen", "manual"] as const;
export const GRADES = ["again", "hard", "good"] as const;
export const LOG_ACTORS = ["learner", "system", "staff"] as const;
export const ANALYTICS_PERIODS = ["30d", "90d"] as const;
export const CARD_ACTIONS = ["reschedule", "reset", "freeze", "unfreeze"] as const;

const PART_OF_SPEECH = nullable(enumOf(PART_OF_SPEECH_VALUES));
/** Перевод статьи RU/UZ ≤ 80 (catalog GlossIn: оба непустые). */
const GLOSS = obj({ ru: str(1, 80), uz: str(1, 80) }, ["ru", "uz"]);
/** Лемма ≤ 60; формы 1..8 по ≤ 120 (catalog FormText; нормализует домен); пример ≤ 200. */
const LEMMA = str(1, 60);
const FORMS = arrayOf(str(1, 120), 1, 8);
const EXAMPLE_EN = nullable(str(1, 200));
const GLOSSARY_REASON = nullable(str(0, 500));

/** GlossaryCreate (admin.ts) — все ключи обязательны (nullable — null). */
export const GLOSSARY_CREATE = obj(
  { pair_id: PAIR_ID, lemma: LEMMA, forms: FORMS, part_of_speech: PART_OF_SPEECH, gloss: GLOSS, example_en: EXAMPLE_EN, reason: GLOSSARY_REASON },
  ["pair_id", "lemma", "forms", "part_of_speech", "gloss", "example_en", "reason"],
);
/** GlossaryPatch (admin.ts): хотя бы одно поле; override — только статьи course (null — снять; решает домен). */
export const GLOSSARY_PATCH = obj(
  {
    lemma: LEMMA,
    forms: FORMS,
    part_of_speech: PART_OF_SPEECH,
    gloss: GLOSS,
    example_en: EXAMPLE_EN,
    override: nullable(obj({ gloss: GLOSS, example_en: EXAMPLE_EN }, ["gloss", "example_en"])),
    reason: GLOSSARY_REASON,
  },
  [],
  { minProperties: 1 },
);
/** GlossaryReview (admin.ts): correct — с новым переводом (gloss обязателен); note ≤ 300. */
export const GLOSSARY_REVIEW = obj(
  { decision: enumOf(["approve", "correct", "reject"]), gloss: GLOSS, note: nullable(str(0, 300)) },
  ["decision"],
  { if: { properties: { decision: { const: "correct" } } }, then: { required: ["gloss"] } },
);
export const GLOSSARY_SOURCE = enumOf(GLOSSARY_SOURCES);
export const GLOSSARY_REVIEW_STATUS = enumOf(GLOSSARY_REVIEW_STATUSES);

/** Причина ручной правки карточки памяти: ≥ 10 (admin.ts), ≤ 300 (memory review_log.reason). */
export const MEMORY_REASON = str(10, 300);
/**
 * CardAction (admin.ts): reschedule — с due_at (ISO-8601 с зоной; 1..365 дней от сейчас проверяет memory → 422
 * DUE_AT_RANGE), остальные — без due_at. Плоская схема с условием — ошибка указывает на поле, а не на ветку oneOf.
 */
export const CARD_ACTION = obj(
  { action: enumOf(CARD_ACTIONS), due_at: DATETIME, reason: MEMORY_REASON },
  ["action", "reason"],
  {
    if: { properties: { action: { const: "reschedule" } } },
    then: { required: ["due_at"] },
    else: { not: { required: ["due_at"] } },
  },
);
export const CARD_STATUS = enumOf(CARD_STATUSES);
export const CARD_KIND = enumOf(CARD_KINDS);
export const ANALYTICS_PERIOD = enumOf(ANALYTICS_PERIODS);

// ---------------------------------------------------------------- игра и герои (спринт 6, admin.ts «Игра и герои»)

export const GAME_AUDIENCES = ["kids", "teens", "adults"] as const;
export const GAME_CURRENCIES = ["xp", "til", "freeze"] as const;
export const GAME_REASONS = [
  "lesson", "scenario", "media", "reading", "review", "skill_demonstrated", "skill_retained", "quest", "quest_bonus",
  "registration_bonus", "referral_bonus", "streak_freeze", "shop", "manual", "reversal", "purchase",
  // спринт 7: XP за дуэль и вклад в парный урок, приз общей лиги, награда приглашённому по реферальной кампании
  "duel", "pair_lesson", "league_prize", "referral_welcome",
] as const;
export const HERO_LINES = ["robot", "pet", "human"] as const;
export const HERO_STAGES = [1, 2, 3] as const;
export const QUEST_KINDS = [
  "lesson_complete", "review_cards", "reading_complete", "scenario_complete", "media_complete", "xp_earned", "skill_confirmed",
] as const;
export const GAME_ACTIONS = ["lesson", "scenario", "media", "reading", "review", "skill", "quest"] as const;
export const SHOP_ITEM_KINDS = ["background", "hero_frame", "streak_freeze"] as const;
export const SHOP_ITEM_STATUSES = ["draft", "published", "retired"] as const;
export const RULES_STATUSES = ["draft", "active", "archived"] as const;
export const GAME_EVENT_STATUSES = ["draft", "published", "cancelled", "finished"] as const;
export const LEDGER_STATUSES = ["confirmed", "reversed"] as const;
export const LEDGER_SOURCE_KINDS = ["event", "command", "staff"] as const;
export const ASSET_PURPOSES = ["hero_stage", "shop_item", "badge"] as const;
export const ASSET_TYPES = ["image/webp", "image/png"] as const;
export const OVERVIEW_PERIODS = ["7d", "30d"] as const;
export const EVENT_FACTORS = [1.5, 2, 3] as const;
/** Картинка игры ≤ 300 КБ (gamification assets), ≤ 1024×1024 px. */
export const ASSET_MAX_BYTES = 300 * 1024;
export const ASSET_MAX_SIDE = 1024;

/** Код героя: robot_0 … human_2 (новые — тем же видом). */
export const HERO_CODE = str(2, 40, { pattern: "^[a-z][a-z0-9_]{1,39}$" });
/** Код предмета магазина и события недели: [a-z0-9_]{3,40} (admin.ts). */
export const GAME_ITEM_CODE = str(3, 40, { pattern: "^[a-z0-9_]{3,40}$" });
/** Номер версии правил в пути. */
export const RULES_VERSION_NO = str(1, 9, { pattern: "^[1-9][0-9]{0,8}$" });
/** Ключ токена темы (не CSS): `pen`, `--pen-soft`, `bg.surface` — никаких значений цвета, url() и `;`. */
export const THEME_TOKEN = str(1, 64, { pattern: "^(?:--)?[a-z][a-z0-9_.-]{0,61}$" });

const gameLocalized = (max: number): Schema => obj({ ru: str(1, max), uz: str(1, max) }, ["ru", "uz"]);
const AUDIENCES = (min: number) => arrayOf(enumOf(GAME_AUDIENCES), min, 3, { uniqueItems: true });
/** Комментарий команды публикации / снятия / отмены (аудит). Активация и откат правил — ≥ 10 (admin.ts). */
export const GAME_COMMENT = obj({ comment: str(3, 300) }, ["comment"]);
export const RULES_COMMENT = obj({ comment: str(10, 300) }, ["comment"]);
/** Причина операции с кошельком: ≥ 10 (PLAN спринта 6 «wallet.adjust»), ≤ 300 (ledger.comment). */
export const WALLET_REASON = obj({ reason: str(10, 300) }, ["reason"]);

/**
 * RulesDraftRequest: `payload` — JSON-объект как есть; схему и смысл правил (лишние ключи, пороги, лимиты) проверяет
 * gamification — 422 RULES_INVALID {errors: [{path, code}]} с путями полей для формы admin-web.
 */
export const RULES_DRAFT = obj(
  { payload: { type: "object" }, comment: nullable(str(0, 300)), based_on: nullable(integer(1, 2_147_483_647)) },
  ["payload", "comment", "based_on"],
);

/** AdminHeroFields: аудитории можно опустошить (скрыть из выбора), ступеней ровно три. */
export const HERO_FIELDS = obj(
  {
    name: gameLocalized(80),
    tagline: gameLocalized(80),
    audiences: AUDIENCES(0),
    stages: arrayOf(
      obj({ stage: { type: "integer", enum: [...HERO_STAGES] }, name: gameLocalized(80), asset_id: UUID }, ["stage", "name", "asset_id"]),
      3,
      3,
    ),
  },
  ["name", "tagline", "audiences", "stages"],
);

const SHOP_PROPS = {
  code: GAME_ITEM_CODE,
  kind: enumOf(["background", "hero_frame"]),
  title: gameLocalized(80),
  description: gameLocalized(200),
  asset_id: nullable(UUID),
  theme: nullable(obj({ bg: THEME_TOKEN, accent: THEME_TOKEN }, ["bg", "accent"])),
  price_til: integer(1, 10_000),
  audiences: AUDIENCES(0),
  available_from: nullable(DATETIME),
  available_until: nullable(DATETIME),
  order: integer(0, 100_000),
};
/** ShopItemCreate (admin.ts) — все ключи обязательны; заморозку (streak_freeze) создать нельзя. */
export const SHOP_ITEM_CREATE = obj(SHOP_PROPS, Object.keys(SHOP_PROPS));
/** Partial<ShopItemCreate>: хотя бы одно поле; что можно менять у published — решает gamification. */
export const SHOP_ITEM_PATCH = obj(SHOP_PROPS, [], { minProperties: 1 });

const EVENT_PROPS = {
  code: GAME_ITEM_CODE,
  title: gameLocalized(120),
  description: gameLocalized(300),
  starts_at: DATETIME,
  ends_at: DATETIME,
  audiences: AUDIENCES(1),
  multipliers: arrayOf(
    obj(
      { action: enumOf(GAME_ACTIONS), currency: enumOf(["xp", "til"]), factor: { type: "number", enum: [...EVENT_FACTORS] } },
      ["action", "currency", "factor"],
    ),
    1,
    5,
  ),
};
/** GameEventFields (admin.ts); период ≤ 14 дней, starts_at не в прошлом, пересечения — проверяет gamification. */
export const GAME_EVENT_CREATE = obj(EVENT_PROPS, Object.keys(EVENT_PROPS));
export const GAME_EVENT_PATCH = obj(EVENT_PROPS, [], { minProperties: 1 });

/**
 * WalletAdjustment (admin.ts): amount ≠ 0, тилы и заморозки ±1..10000, XP ±1..100000; причина ≥ 10.
 * «Не ниже нуля» (409 BALANCE_NEGATIVE) — в gamification под блокировкой кошелька.
 */
export const WALLET_ADJUSTMENT = obj(
  {
    currency: enumOf(GAME_CURRENCIES),
    amount: { type: "integer", minimum: -100_000, maximum: 100_000, not: { const: 0 } },
    reason: str(10, 300),
  },
  ["currency", "amount", "reason"],
  {
    if: { properties: { currency: { enum: ["til", "freeze"] } } },
    then: { properties: { amount: { type: "integer", minimum: -10_000, maximum: 10_000 } } },
  },
);

export const OVERVIEW_PERIOD = enumOf(OVERVIEW_PERIODS);
export const GAME_EVENT_STATUS = enumOf(GAME_EVENT_STATUSES);
export const GAME_CURRENCY = enumOf(GAME_CURRENCIES);
export const ASSET_PURPOSE = enumOf(ASSET_PURPOSES);

// ---------------------------------------------------------------- социальное (спринт 7, admin.ts «Социальное»)

/** Перечисления bff.ts / admin.ts — сверка с типами при компиляции (contractSocial.ts). */
export const CASE_STATUSES = ["open", "resolved", "dismissed"] as const;
export const MODERATION_ACTIONS = ["dismiss", "warning", "social_ban", "nickname_reset"] as const;
export const COMPLAINT_SUBJECT_KINDS = ["user", "nickname", "friend_request", "invite", "duel", "pair_room"] as const;
export const COMPLAINT_REASONS = ["spam", "abuse", "inappropriate_nickname", "cheating", "other"] as const;
export const SANCTION_KINDS = ["warning", "social_ban", "nickname_reset"] as const;
export const SANCTION_APPEAL_STATUSES = ["open", "upheld", "overturned"] as const;
export const FRIEND_REQUEST_STATUSES = ["pending", "accepted", "declined", "cancelled", "expired"] as const;
export const REFERRAL_STATUSES = [
  "invited", "diagnostic_done", "learning", "review", "qualified", "rewarded", "rejected", "expired", "capped",
] as const;
export const REFERRAL_REJECT_CODES = ["not_new_user", "family_member", "window_expired", "review_rejected", "monthly_cap"] as const;
/** Причины отклонения оператором (ReferralRejectRequest): без window_expired и monthly_cap — их ставит система. */
export const REFERRAL_STAFF_REJECT_CODES = ["not_new_user", "family_member", "review_rejected"] as const;
export const REFERRAL_RISK_FLAGS = ["velocity", "short_lessons", "activity_before_accept", "family_member"] as const;
/** Исход начисления (ack gamification, ReferralRewardOutcome): награда кампании, выдана по правилу спринта 6, лимит
 *  пригласившего в gamification. */
export const REFERRAL_REWARD_OUTCOMES = ["rewarded", "legacy", "inviter_capped"] as const;
export const REFERRAL_CAMPAIGN_STATUSES = ["draft", "active", "archived"] as const;
export const LEAGUE_LEVEL_BANDS = ["A0-A1", "A2", "B1+"] as const;
export const LEAGUE_GROUP_STATUSES = ["open", "closed", "held"] as const;
export const DUEL_STATUSES = ["challenged", "declined", "expired", "accepted", "finished", "cancelled"] as const;
export const DUEL_RESULTS = ["challenger", "opponent", "draw", "none"] as const;
/** Результат переоценки дуэли (DuelReevaluateRequest): без none. */
export const DUEL_STAFF_RESULTS = ["challenger", "opponent", "draw"] as const;
export const PAIR_ROOM_STATUSES = [
  "invited", "declined", "expired", "cancelled", "waiting", "in_progress", "paused", "finished", "abandoned", "stopped",
] as const;
export const PAIR_ROOM_MODES = ["free", "choices"] as const;
export const PAIR_END_REASONS = ["completed", "participant_left", "inactivity", "stopped"] as const;
export const PAIR_ROOM_EVENT_KINDS = [
  "joined", "left", "offline", "online", "paused", "resumed", "roles", "coach", "turn", "mode_changed", "finished", "stopped",
] as const;
export const PAIR_ROLES = ["A", "B"] as const;
/** Санкция social_ban дольше этого срока (и бессрочная) требует step-up (admin.ts, INTERNAL_API спринта 7 §1.3). */
export const SOCIAL_BAN_STEP_UP_DAYS = 7;

/** Причина, основание, комментарий и заметка команд «Социального» — 10..500 (admin.ts, раздел «Социальное»). */
export const SOCIAL_REASON = str(10, 500);
/** Неделя лиги — понедельник YYYY-MM-DD (понедельник ли — проверяет маршрут до домена). */
export const WEEK_Q = str(10, 10, { pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
/** Номер версии реферальной кампании в пути. */
export const CAMPAIGN_VERSION_NO = str(1, 9, { pattern: "^[1-9][0-9]{0,8}$" });

/**
 * CaseResolveRequest: days — только у social_ban (1..30 или null — бессрочно), у остальных действий — null; основание
 * 10..500. Step-up (social_ban больше 7 дней и бессрочный) проверяет маршрут по телу — до домена.
 */
export const CASE_RESOLVE = obj(
  { action: enumOf(MODERATION_ACTIONS), days: nullable(integer(1, 30)), basis: SOCIAL_REASON },
  ["action", "days", "basis"],
  {
    if: { properties: { action: { const: "social_ban" } } },
    then: {},
    else: { properties: { days: { type: "null" } } },
  },
);
export const SANCTION_REVOKE = obj({ reason: SOCIAL_REASON }, ["reason"]);
export const SANCTION_APPEAL_DECISION = obj({ decision: enumOf(["upheld", "overturned"]), note: SOCIAL_REASON }, ["decision", "note"]);

/**
 * ReferralCampaignDraft: `payload` — JSON-объект как есть (как черновик правил игры): границы и связи полей проверяет
 * social — 422 CAMPAIGN_INVALID {errors: [{path, code}]} с путями для формы admin-web.
 */
export const REFERRAL_CAMPAIGN_DRAFT = obj(
  { payload: { type: "object", maxProperties: 50 }, comment: nullable(str(0, 500)), based_on: nullable(integer(1, 2_147_483_647)) },
  ["payload", "comment", "based_on"],
);
export const REFERRAL_CAMPAIGN_ACTIVATE = obj({ comment: SOCIAL_REASON }, ["comment"]);
export const REFERRAL_APPROVE = obj({ note: SOCIAL_REASON }, ["note"]);
export const REFERRAL_REJECT = obj({ reject_code: enumOf(REFERRAL_STAFF_REJECT_CODES), note: SOCIAL_REASON }, ["reject_code", "note"]);

/** LeagueReevaluateRequest: исключить до 30 участников (пусто — пересчитать) с причиной. */
export const LEAGUE_REEVALUATE = obj(
  { exclude_user_ids: arrayOf(UUID, 0, 30, { uniqueItems: true }), reason: SOCIAL_REASON },
  ["exclude_user_ids", "reason"],
);
export const LEAGUE_RELEASE = obj({ reason: SOCIAL_REASON }, ["reason"]);
export const DUEL_REEVALUATE = obj({ result: enumOf(DUEL_STAFF_RESULTS), reason: SOCIAL_REASON }, ["result", "reason"]);
export const PAIR_ROOM_STOP = obj({ reason: SOCIAL_REASON }, ["reason"]);

// ---------------------------------------------------------------- деньги (спринт 8, admin.ts «Деньги»)

/** Перечисления admin.ts / bff.ts / web.ts — сверка с типами при компиляции (contractBilling.ts). */
export const BILLING_PROVIDERS = ["telegram_stars", "payme", "click", "uzum"] as const;
export const WEB_PROVIDERS = ["payme", "click", "uzum"] as const;
export const BILLING_CHANNELS = ["miniapp", "web", "renewal"] as const;
export const BILLING_CURRENCIES = ["UZS", "XTR"] as const;
export const BILLING_AUDIENCES = ["kids", "teens", "adults"] as const;
export const BILLING_FEATURES = ["ai_lessons", "pair_lessons"] as const;
export const PRODUCT_KINDS = ["subscription", "til_pack"] as const;
export const STARS_MODES = ["one_time", "subscription"] as const;
export const ORDER_STATUSES = ["pending", "paid", "fulfilled", "expired", "cancelled", "refunded"] as const;
export const STARS_SUBSCRIPTION_STATUSES = ["active", "canceled", "failed", "refunded", "ended"] as const;
export const SUBSCRIPTION_STATUSES = ["none", "trial", "active", "expired"] as const;
export const MINUTE_ENTRY_KINDS = ["grant", "debit", "expire", "revoke", "adjust"] as const;
export const MINUTE_REF_KINDS = ["order", "trial", "grant", "session", "room", "period", "hold", "refund", "adjustment", "deletion"] as const;
export const CATALOG_STATUSES = ["draft", "active", "archived"] as const;
export const TXN_STATES = ["created", "performed", "cancelled", "refunded"] as const;
export const REFUND_STATUSES = ["awaiting_provider", "completed", "failed"] as const;
export const PERIOD_STATUSES = ["scheduled", "active", "ended", "superseded", "revoked"] as const;
export const ADJUSTMENT_KINDS = ["minutes", "grant_period", "revoke_period"] as const;
export const ADJUSTMENT_STATUSES = ["pending", "applied", "rejected", "expired", "cancelled"] as const;
export const RECON_ITEM_KINDS = [
  "paid_not_fulfilled", "stale_created", "provider_mismatch", "duplicate_payment", "refund_without_request", "refund_stuck",
  "fiscal_missing", "tils_spent_on_refund", "paid_after_deletion", "payer_mismatch", "stars_unmatched",
  "stars_subscription_desync", "hold_expired", "balance_drift", "unmatched_settlement",
] as const;
export const RECON_STATUSES = ["open", "resolved", "ignored"] as const;
export const LEARNER_TIERS = ["free", "paid"] as const;
export const REPORT_PERIODS = ["day", "week", "month"] as const;
/** Отчёт по дням — не больше 92 дней (admin.ts BillingDailyRow). */
export const DAILY_MAX_DAYS = 92;

/** Причина, комментарий, заметка команд «Денег» — 10..500 (admin.ts). */
export const MONEY_REASON = str(10, 500);
/** Номер версии каталога в пути. */
export const CATALOG_VERSION_NO = str(1, 9, { pattern: "^[1-9][0-9]{0,8}$" });
/** Номер заказа в фильтре: целое ≥ 1. */
export const ORDER_NO_Q = str(1, 12, { pattern: "^[1-9][0-9]{0,11}$" });
/** Идентификатор транзакции провайдера в фильтре — без пробелов и управляющих символов. */
export const PROVIDER_TXN_Q = str(1, 128, { pattern: "^[A-Za-z0-9._:-]+$" });
export const DATE_Q = str(10, 10, { pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
/**
 * Тело черновика каталога (admin.ts CatalogDraftRequest): `payload` — JSON-объект как есть (как черновик правил игры);
 * границы, связи полей и фискальные реквизиты проверяет billing — 422 CATALOG_INVALID {errors: [{path, code}]}.
 */
export const CATALOG_DRAFT = obj({ payload: { type: "object", maxProperties: 20 }, comment: nullable(str(0, 500)) }, ["payload", "comment"]);
/** Каталог до 200 товаров с RU/UZ текстами и фискальными реквизитами — 256 КБ (остальные маршруты — 64 КБ). */
export const CATALOG_BODY_LIMIT = 256 * 1024;
export const CATALOG_COMMENT = obj({ comment: MONEY_REASON }, ["comment"]);
/** RefundRequest: причина 10..500; force — вернуть деньги, даже если купленные тилы уже потрачены. */
export const REFUND_REQUEST = obj({ reason: MONEY_REASON, force: { type: "boolean" } }, ["reason"]);
export const REFUND_FAIL = obj({ note: MONEY_REASON }, ["note"]);
/**
 * AdjustmentRequest по виду (admin.ts): minutes — ±1..10 000 к периоду period_id; grant_period — days 1..90 и minutes
 * > 0; revoke_period — period_id. Поля другого вида — 422 (плоская схема с условиями: ошибка указывает на поле).
 */
export const ADJUSTMENT_REQUEST = obj(
  {
    kind: enumOf(ADJUSTMENT_KINDS),
    minutes: { type: "integer", minimum: -10_000, maximum: 10_000, not: { const: 0 } },
    days: integer(1, 90),
    period_id: UUID,
    reason: MONEY_REASON,
  },
  ["kind", "reason"],
  {
    allOf: [
      {
        if: { properties: { kind: { const: "minutes" } } },
        then: { required: ["minutes", "period_id"], not: { required: ["days"] } },
      },
      {
        if: { properties: { kind: { const: "grant_period" } } },
        then: { required: ["days", "minutes"], properties: { minutes: { type: "integer", minimum: 1 } }, not: { required: ["period_id"] } },
      },
      {
        if: { properties: { kind: { const: "revoke_period" } } },
        then: { required: ["period_id"], allOf: [{ not: { required: ["minutes"] } }, { not: { required: ["days"] } }] },
      },
    ],
  },
);
/** Подтверждение — заметка по желанию (≤ 500); отклонение — обязательна, 10..500. */
export const ADJUSTMENT_APPROVE = obj({ note: str(1, 500) });
export const ADJUSTMENT_REJECT = obj({ note: MONEY_REASON }, ["note"]);
export const RECON_RESOLVE = obj({ status: enumOf(["resolved", "ignored"]), note: MONEY_REASON }, ["status", "note"]);
/** Курс USD: тийинов за 1 USD, 100 000..100 000 000 (admin.ts FxRateRequest). */
export const FX_REQUEST = obj({ usd_in_tiyin: integer(100_000, 100_000_000), valid_from: DATE_Q, reason: MONEY_REASON }, ["usd_in_tiyin", "valid_from", "reason"]);
/** Оценка вознаграждения за 1 Star, тийинов: 1..10 000 000 (admin.ts StarRateRequest). */
export const STAR_RATE_REQUEST = obj({ star_in_tiyin: integer(1, 10_000_000), valid_from: DATE_Q, reason: MONEY_REASON }, ["star_in_tiyin", "valid_from", "reason"]);
export const TRIALS_GRANT_ALL = obj({ reason: MONEY_REASON }, ["reason"]);

// ---------------------------------------------------------------- контроль ИИ (спринт 8, ai.ts, INTERNAL_API §7)

export const DEGRADATION_LEVELS = ["normal", "economy", "paid_only", "off"] as const;
export const DEGRADATION_MODES = ["auto", "manual"] as const;
export const DEGRADATION_REASONS = ["threshold", "manual", "emergency_stop", "month_reset"] as const;
export const UNIT_COST_PERIODS = ["week", "month"] as const;
/**
 * AiDegradationUpdate: manual_level — уровень при mode manual (обязателен), null в auto; 1 ≤ economy_at_percent ≤
 * paid_only_at_percent ≤ 100 (сравнение и связь режима с уровнем — в маршруте, до домена; ai-gateway — 422
 * DEGRADATION_INVALID); причина 10..500 (аудит ai.degradation_updated).
 */
export const DEGRADATION_UPDATE = obj(
  {
    mode: enumOf(DEGRADATION_MODES),
    manual_level: nullable(enumOf(DEGRADATION_LEVELS)),
    economy_at_percent: integer(1, 100),
    paid_only_at_percent: integer(1, 100),
    reason: MONEY_REASON,
  },
  ["mode", "manual_level", "economy_at_percent", "paid_only_at_percent", "reason"],
);
