/**
 * JSON Schema входа admin-bff (Ajv Fastify, без приведения типов и без удаления лишних полей: лишнее поле → 422).
 * querystring и params — строки (числа разбираются вручную), тело — строгие типы. Это первая линия (форма и
 * границы из admin.ts); домены проверяют повторно и глубже (переводы, плейсхолдеры, переходы статусов).
 */
import { ALL_PERMISSIONS, ROLE_CODES } from "./rbac.js";

type Schema = Record<string, unknown>;

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

export const NOTE_ROUTES = ["home", "lessons", "review", "progress", "profile", "schedule", "notifications", "family", "support", "news"] as const;
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
