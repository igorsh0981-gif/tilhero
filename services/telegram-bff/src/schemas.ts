/**
 * JSON Schema (TypeBox) публичного API. Типы — единственный источник packages/contracts/src/bff.ts:
 * каждая схема ниже проверяется на взаимную совместимость с типом контракта на этапе tsc
 * (assertSame) — рассинхронизация схемы и контракта ломает typecheck.
 *
 * Вход: additionalProperties: false везде (лишние поля → 422). Ответы сериализуются по схеме (fast-json-stringify):
 * в Mini App уходят только поля контракта.
 *
 * Исключение — код родителя (установка, смена, сброс) и биометрия: маршруты aievent, типов в bff.ts нет (SecurityState
 * описывает их состояние). Локальные типы — ниже (раздел «Код родителя»), см. README «Отклонения от контракта».
 */
import { Type, type Static, type TLiteral, type TSchema, type TSchemaOptions, type TUnion } from "@fastify/type-provider-typebox";
import type * as C from "@tilhero/contracts/bff";

// ---------- compile-time сверка с контрактом ----------
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertSame<T extends true>(_?: T): void {}

const strict = { additionalProperties: false } as const;
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const IsoTime = Type.String({ description: "ISO-8601 UTC" });
const Hhmm = Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$", description: "HH:MM" });
const LocalDate = Type.String({ description: "YYYY-MM-DD" });
const LabelRuUz = Type.Object({ ru: Type.String(), uz: Type.String() });

/** Перечисление строк → Union литералов (тип выводится из кортежа; явный тип результата обязателен — иначе TS
 *  раскрывает кортеж по ограничению и теряет литералы). */
type ToLiterals<T extends readonly string[]> = T extends readonly [infer H extends string, ...infer R extends readonly string[]]
  ? [TLiteral<H>, ...ToLiterals<R>]
  : [];
function Enum<const T extends readonly [string, ...string[]]>(values: T, opts: TSchemaOptions = {}): TUnion<ToLiterals<T>> {
  return Type.Union(values.map((v) => Type.Literal(v)), opts) as unknown as TUnion<ToLiterals<T>>;
}

export const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
export const UUID_RE = new RegExp(UUID_PATTERN);
const Uuid = Type.String({ pattern: UUID_PATTERN, description: "UUID" });

// ---------- Errors ----------
export const ErrorBodySchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  trace_id: Type.String(),
  details: Type.Record(Type.String(), Type.Unknown()),
});
assertSame<Same<Static<typeof ErrorBodySchema>, C.ErrorBody>>();

export const itemsOf = <T extends TSchema>(s: T) => Type.Object({ items: Type.Array(s) });
export const pageOf = <T extends TSchema>(s: T) => Type.Object({ items: Type.Array(s), next_cursor: Nullable(Type.String()) });

export const PageQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  strict,
);

// ---------- Session ----------
export const UI_LANGS = ["ru", "uz"] as const;
const UiLang = Enum(UI_LANGS);
assertSame<Same<Static<typeof UiLang>, C.UiLang>>();
export const AGE_BANDS = ["6-9", "10-13", "14-17", "18+"] as const;
const AgeBand = Enum(AGE_BANDS);
assertSame<Same<Static<typeof AgeBand>, C.AgeBand>>();
const GuardianConsent = Enum(["not_required", "pending", "granted", "declined"]);
assertSame<Same<Static<typeof GuardianConsent>, C.GuardianConsent>>();

export const UserSummarySchema = Type.Object({
  user_id: Type.String(),
  display_name: Type.String(),
  username: Nullable(Type.String()),
  locale: UiLang,
  status: Enum(["ACTIVE", "DISABLED", "DELETION_REQUESTED"]),
  is_new: Type.Boolean(),
  age_band: Nullable(AgeBand),
  guardian_consent: GuardianConsent,
});
assertSame<Same<Static<typeof UserSummarySchema>, C.UserSummary>>();

export const LearnerSummarySchema = Type.Object({
  learner_id: Type.String(),
  kind: Enum(["self", "child"]),
  display_name: Type.String(),
  age_band: Nullable(AgeBand),
  is_active: Type.Boolean(),
  onboarding_completed: Type.Boolean(),
});
assertSame<Same<Static<typeof LearnerSummarySchema>, C.LearnerSummary>>();

export const SecurityStateSchema = Type.Object({
  pin_enabled: Type.Boolean(),
  pin_length: Type.Union([Type.Literal(4), Type.Literal(6), Type.Null()]),
  biometric_enabled: Type.Boolean(),
  pin_required: Type.Boolean(),
  locked_until: Nullable(IsoTime),
});
assertSame<Same<Static<typeof SecurityStateSchema>, C.SecurityState>>();

export const ConsentStateSchema = Type.Object({
  accepted: Type.Boolean(),
  policy_version: Nullable(Type.String()),
  current_policy_version: Type.String(),
  accepted_at: Nullable(IsoTime),
  evidence_hash: Nullable(Type.String()),
  purposes: Type.Array(Type.String()),
});
assertSame<Same<Static<typeof ConsentStateSchema>, C.ConsentState>>();

export const SessionResponseSchema = Type.Object({
  access_token: Type.String(),
  expires_in: Type.Integer(),
  refresh_token: Type.String(),
  account: UserSummarySchema,
  learner: LearnerSummarySchema,
  learners: Type.Array(LearnerSummarySchema),
  security: SecurityStateSchema,
  consent: ConsentStateSchema,
  onboarding_completed: Type.Boolean(),
  start_param: Nullable(Type.String()),
});
assertSame<Same<Static<typeof SessionResponseSchema>, C.SessionResponse>>();

export const TelegramSessionRequestSchema = Type.Object({ init_data: Type.String({ minLength: 1, maxLength: 4096 }) }, strict);
assertSame<Same<Static<typeof TelegramSessionRequestSchema>, C.TelegramSessionRequest>>();

export const RefreshRequestSchema = Type.Object({ refresh_token: Type.String({ minLength: 1, maxLength: 256 }) }, strict);
assertSame<Same<Static<typeof RefreshRequestSchema>, C.RefreshRequest>>();

/** Код родителя — ровно 4 или 6 цифр (422 PIN_FORMAT); неформатный код не доходит до identity и не тратит попытку. */
const PinString = Type.String({ pattern: "^([0-9]{4}|[0-9]{6})$" });

export const PinVerifyRequestSchema = Type.Object({ pin: PinString }, strict);
assertSame<Same<Static<typeof PinVerifyRequestSchema>, C.PinVerifyRequest>>();

export const SwitchLearnerRequestSchema = Type.Object({ learner_id: Uuid, pin: Type.Optional(PinString) }, strict);
assertSame<Same<Static<typeof SwitchLearnerRequestSchema>, C.SwitchLearnerRequest>>();

// ---------- Профиль, возраст, дети ----------
export const NOTIFICATION_CATEGORY_KEYS = ["reminders", "missed", "social", "support", "product"] as const;

export const NotificationCategoriesSchema = Type.Object({
  reminders: Type.Boolean(),
  missed: Type.Boolean(),
  social: Type.Boolean(),
  support: Type.Boolean(),
  product: Type.Boolean(),
});
assertSame<Same<Static<typeof NotificationCategoriesSchema>, C.NotificationCategories>>();

export const NotificationSettingsSchema = Type.Object({
  enabled: Type.Boolean(),
  categories: NotificationCategoriesSchema,
  quiet_hours: Nullable(Type.Object({ start: Type.String(), end: Type.String() })),
  timezone: Type.String(),
});
assertSame<Same<Static<typeof NotificationSettingsSchema>, C.NotificationSettings>>();

export const ProfileSchema = Type.Object({
  account: UserSummarySchema,
  learner: LearnerSummarySchema,
  learners: Type.Array(LearnerSummarySchema),
  security: SecurityStateSchema,
  consent: ConsentStateSchema,
  notifications: NotificationSettingsSchema,
});
assertSame<Same<Static<typeof ProfileSchema>, C.Profile>>();

/** IANA-зона: проверку существования делает домен (identity-consent / learning-plan). */
const Timezone = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_+\\-]*(/[A-Za-z0-9_+\\-]+){0,2}$" });
const DisplayName = Type.String({ minLength: 1, maxLength: 40, pattern: "\\S" });

export const NotificationsPatchSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    quiet_hours: Type.Optional(Nullable(Type.Object({ start: Hhmm, end: Hhmm }, strict))),
    timezone: Type.Optional(Timezone),
    categories: Type.Optional(
      Type.Object(
        {
          reminders: Type.Optional(Type.Boolean()),
          missed: Type.Optional(Type.Boolean()),
          social: Type.Optional(Type.Boolean()),
          support: Type.Optional(Type.Boolean()),
          product: Type.Optional(Type.Boolean()),
        },
        strict,
      ),
    ),
  },
  strict,
);

export const SettingsPatchSchema = Type.Object(
  {
    locale: Type.Optional(UiLang),
    display_name: Type.Optional(DisplayName),
    notifications: Type.Optional(NotificationsPatchSchema),
  },
  strict,
);
assertSame<Same<Static<typeof SettingsPatchSchema>, C.SettingsPatch>>();

export const AgeRequestSchema = Type.Object({ age_band: Enum(["14-17", "18+"]) }, strict);
assertSame<Same<Static<typeof AgeRequestSchema>, C.AgeRequest>>();

export const CreateChildRequestSchema = Type.Object({ display_name: DisplayName, age_band: Enum(["6-9", "10-13"]) }, strict);
assertSame<Same<Static<typeof CreateChildRequestSchema>, C.CreateChildRequest>>();

export const GuardianConsentLinkSchema = Type.Object({ link: Type.String(), expires_at: IsoTime });
assertSame<Same<Static<typeof GuardianConsentLinkSchema>, C.GuardianConsentLink>>();

export const GuardianConsentPreviewSchema = Type.Object({
  teen_display_name: Type.String(),
  status: Enum(["pending", "granted", "declined", "expired"]),
  expires_at: IsoTime,
});
assertSame<Same<Static<typeof GuardianConsentPreviewSchema>, C.GuardianConsentPreview>>();

/** Токен согласия родителя (32 байта base64url) — из start_param без префикса gc_. */
export const GuardianTokenParamsSchema = Type.Object({ token: Type.String({ pattern: "^[A-Za-z0-9_-]{16,128}$" }) }, strict);

// ---------- Согласия ----------
export const PolicyDocumentSchema = Type.Object({
  version: Type.String(),
  purposes: Type.Array(Type.Object({ code: Type.String(), required: Type.Boolean(), title: Type.String(), description: Type.String() })),
  text: Type.String(),
});
assertSame<Same<Static<typeof PolicyDocumentSchema>, C.PolicyDocument>>();

export const PolicyQuerySchema = Type.Object({ lang: Type.Optional(Enum(UI_LANGS, { default: "ru" })) }, strict);

export const ConsentRequestSchema = Type.Object(
  {
    policy_version: Type.String({ minLength: 1, maxLength: 32 }),
    purposes: Type.Array(Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" }), { maxItems: 20, uniqueItems: true }),
  },
  strict,
);
assertSame<Same<Static<typeof ConsentRequestSchema>, C.ConsentRequest>>();

// ---------- Код родителя (PIN) и биометрия — маршруты aievent, локальные типы ----------
/** PUT /v1/profile/security/pin — задать (без current_pin) или сменить (с current_pin) → SecurityState. */
export interface PinSetRequest {
  pin: string;
  current_pin?: string;
}
/** DELETE /v1/profile/security/pin → SecurityState. */
export interface PinRemoveRequest {
  current_pin: string;
}
/** POST /v1/profile/security/pin/reset-request → {expires_in}: бот присылает 6-значный код в чат. */
export interface PinResetRequestResponse {
  expires_in: number;
}
/** POST /v1/profile/security/pin/reset-confirm → SessionResponse (все прежние сессии отозваны). */
export interface PinResetConfirmRequest {
  code: string;
  new_pin: string;
}
/** POST /v1/session/biometric/verify → SessionResponse. */
export interface BiometricVerifyRequest {
  biometric_token: string;
}
/** PUT /v1/profile/security/biometric → BiometricEnableResponse (только при заданном коде). */
export interface BiometricEnableResponse {
  biometric_token: string;
  security: C.SecurityState;
}

export const PinSetRequestSchema = Type.Object({ pin: PinString, current_pin: Type.Optional(PinString) }, strict);
assertSame<Same<Static<typeof PinSetRequestSchema>, PinSetRequest>>();
export const PinRemoveRequestSchema = Type.Object({ current_pin: PinString }, strict);
assertSame<Same<Static<typeof PinRemoveRequestSchema>, PinRemoveRequest>>();
export const PinResetRequestResponseSchema = Type.Object({ expires_in: Type.Integer() });
assertSame<Same<Static<typeof PinResetRequestResponseSchema>, PinResetRequestResponse>>();
export const PinResetConfirmRequestSchema = Type.Object(
  { code: Type.String({ pattern: "^[0-9]{6}$", description: "6-значный код из бота" }), new_pin: PinString },
  strict,
);
assertSame<Same<Static<typeof PinResetConfirmRequestSchema>, PinResetConfirmRequest>>();
export const BiometricVerifyRequestSchema = Type.Object({ biometric_token: Type.String({ minLength: 1, maxLength: 256 }) }, strict);
assertSame<Same<Static<typeof BiometricVerifyRequestSchema>, BiometricVerifyRequest>>();
export const BiometricEnableResponseSchema = Type.Object({ biometric_token: Type.String(), security: SecurityStateSchema });
assertSame<Same<Static<typeof BiometricEnableResponseSchema>, BiometricEnableResponse>>();

// ---------- Учебный план и график ----------
const Goal = Enum(["work", "career", "travel", "daily", "study", "exam"]);
assertSame<Same<Static<typeof Goal>, C.Goal>>();
const LevelSelf = Enum(["zero", "beginner", "some", "confident"]);
assertSame<Same<Static<typeof LevelSelf>, C.LevelSelf>>();
const SchedulePreset = Enum(["daily", "weekdays", "three_per_week", "custom"]);
assertSame<Same<Static<typeof SchedulePreset>, C.SchedulePreset>>();
const DurationMin = Type.Union([Type.Literal(10), Type.Literal(15), Type.Literal(20), Type.Literal(30)]);
assertSame<Same<Static<typeof DurationMin>, C.DurationMin>>();

export const ScheduleSchema = Type.Object({
  preset: SchedulePreset,
  days: Type.Array(Type.Integer()),
  preferred_time: Type.String(),
  duration_min: DurationMin,
  reminders_enabled: Type.Boolean(),
  timezone: Type.String(),
});
assertSame<Same<Static<typeof ScheduleSchema>, C.Schedule>>();

export const LearningPlanSchema = Type.Object({
  learner_id: Type.String(),
  goal: Nullable(Goal),
  level_self: Nullable(LevelSelf),
  topics: Type.Array(Type.String()),
  ui_lang: UiLang,
  explain_lang: UiLang,
  course_pair: Type.Literal("ru-en"),
  schedule: ScheduleSchema,
  onboarding_completed_at: Nullable(IsoTime),
  updated_at: IsoTime,
  version: Type.Integer(),
});
assertSame<Same<Static<typeof LearningPlanSchema>, C.LearningPlan>>();

const TopicCode = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9_.-]*$" });

/** Структурные проверки (ошибка → 422 PLAN_INVALID {field, reason}); зона и темы из справочника — в learning-plan. */
export const PlanPatchSchema = Type.Object(
  {
    goal: Type.Optional(Goal),
    level_self: Type.Optional(LevelSelf),
    topics: Type.Optional(Type.Array(TopicCode, { maxItems: 5, uniqueItems: true })),
    ui_lang: Type.Optional(UiLang),
    explain_lang: Type.Optional(UiLang),
    schedule: Type.Optional(
      Type.Object(
        {
          preset: Type.Optional(SchedulePreset),
          days: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7, uniqueItems: true })),
          preferred_time: Type.Optional(Hhmm),
          duration_min: Type.Optional(DurationMin),
          reminders_enabled: Type.Optional(Type.Boolean()),
          timezone: Type.Optional(Timezone),
        },
        strict,
      ),
    ),
  },
  strict,
);
assertSame<Same<Static<typeof PlanPatchSchema>, C.PlanPatch>>();

export const PlanHeadersSchema = Type.Object({
  "if-match": Type.Optional(
    Type.String({ pattern: '^(W/)?"?[0-9]{1,9}"?$', description: "версия плана (LearningPlan.version); при расхождении 409 PLAN_VERSION_CONFLICT" }),
  ),
});

export const TodayPlanSchema = Type.Object({
  local_date: LocalDate,
  is_scheduled_today: Type.Boolean(),
  slot_time: Nullable(Type.String()),
  duration_min: DurationMin,
  minutes_today: Type.Integer(),
  done_today: Type.Boolean(),
  next_slot: Nullable(Type.Object({ local_date: LocalDate, time: Type.String() })),
  streak_days: Type.Integer(),
  week: Type.Array(Type.Object({ local_date: LocalDate, scheduled: Type.Boolean(), done: Type.Boolean(), missed: Type.Boolean() })),
});
assertSame<Same<Static<typeof TodayPlanSchema>, C.TodayPlan>>();

export const ActivityRequestSchema = Type.Object(
  { kind: Type.Literal("practice"), minutes: Type.Integer({ minimum: 1, maximum: 240 }) },
  strict,
);
assertSame<Same<Static<typeof ActivityRequestSchema>, C.ActivityRequest>>();

export const DirectoryItemSchema = Type.Object({ code: Type.String(), label: LabelRuUz, icon: Nullable(Type.String()) });
assertSame<Same<Static<typeof DirectoryItemSchema>, C.DirectoryItem>>();

// ---------- Центр уведомлений ----------
export const NOTIFICATION_CATEGORIES = ["reminders", "missed", "social", "support", "product", "service"] as const;
const NotificationCategory = Enum(NOTIFICATION_CATEGORIES);
assertSame<Same<Static<typeof NotificationCategory>, C.NotificationCategory>>();
export const INBOX_TELEGRAM = ["sent", "scheduled", "in_app_only", "failed"] as const;

export const InboxItemSchema = Type.Object({
  notification_id: Type.String(),
  category: NotificationCategory,
  title: Type.String(),
  body: Type.String(),
  startapp: Nullable(Type.String()),
  created_at: IsoTime,
  read_at: Nullable(IsoTime),
  telegram: Enum(INBOX_TELEGRAM),
});
assertSame<Same<Static<typeof InboxItemSchema>, C.InboxItem>>();

export const InboxPageSchema = pageOf(InboxItemSchema);
assertSame<Same<Static<typeof InboxPageSchema>, C.Page<C.InboxItem>>>();

export const UnreadSchema = Type.Object({ unread: Type.Integer() });

export const InboxReadRequestSchema = Type.Object(
  { ids: Type.Optional(Type.Array(Uuid, { minItems: 1, maxItems: 100, uniqueItems: true })), all: Type.Optional(Type.Literal(true)) },
  strict,
);
assertSame<Same<Static<typeof InboxReadRequestSchema>, C.InboxReadRequest>>();

// ---------- Приглашения и семья ----------
const InviteKind = Enum(["family", "friend", "referral"]);
assertSame<Same<Static<typeof InviteKind>, C.InviteKind>>();
const InviteStatus = Enum(["active", "accepted", "revoked", "expired"]);

export const InviteSchema = Type.Object({
  invite_id: Type.String(),
  kind: InviteKind,
  link: Type.String(),
  status: InviteStatus,
  expires_at: Nullable(IsoTime),
  created_at: IsoTime,
  accepted_count: Type.Integer(),
});
assertSame<Same<Static<typeof InviteSchema>, C.Invite>>();

export const InvitePageSchema = pageOf(InviteSchema);
assertSame<Same<Static<typeof InvitePageSchema>, C.Page<C.Invite>>>();

export const CreateInviteRequestSchema = Type.Object({ kind: InviteKind }, strict);
assertSame<Same<Static<typeof CreateInviteRequestSchema>, C.CreateInviteRequest>>();

export const INVITE_REASONS = ["self", "already_member", "already_friends", "already_used", "expired", "revoked", "not_allowed"] as const;
export const InvitePreviewSchema = Type.Object({
  invite_id: Type.String(),
  kind: InviteKind,
  inviter_display_name: Type.String(),
  status: InviteStatus,
  can_accept: Type.Boolean(),
  reason: Nullable(Enum(INVITE_REASONS)),
});
assertSame<Same<Static<typeof InvitePreviewSchema>, C.InvitePreview>>();

/** Токен приглашения — из start_param без префикса inv_ (social: base64url HMAC, 32 символа). */
export const InviteOpenRequestSchema = Type.Object({ token: Type.String({ pattern: "^[A-Za-z0-9_-]{16,64}$" }) }, strict);
assertSame<Same<Static<typeof InviteOpenRequestSchema>, C.InviteOpenRequest>>();

export const InviteParamsSchema = Type.Object({ invite_id: Uuid }, strict);

export const FamilySchema = Type.Object({
  family_id: Type.String(),
  members: Type.Array(
    Type.Object({
      user_id: Type.String(),
      display_name: Type.String(),
      role: Enum(["owner", "adult", "teen", "child"]),
      is_me: Type.Boolean(),
    }),
  ),
});
assertSame<Same<Static<typeof FamilySchema>, C.Family>>();

export const InviteAcceptResultSchema = Type.Object({ invite_id: Type.String(), kind: InviteKind, family: Nullable(FamilySchema) });
assertSame<Same<Static<typeof InviteAcceptResultSchema>, C.InviteAcceptResult>>();

// ---------- «Что нового» и новости ----------
/** Белые списки — packages/contracts/release-notes.json (сверка — test/whatsNew.test.ts). */
export const NOTE_ROUTES = ["home", "lessons", "review", "progress", "profile", "schedule", "notifications", "family", "support", "news"] as const;
export const NOTE_ICONS = [
  "spark", "hero", "calendar", "clock", "bell", "book", "chat", "mic", "star", "flame", "users", "gift", "shield", "globe", "trophy", "news",
] as const;
const ReleaseNoteRoute = Enum(NOTE_ROUTES);
assertSame<Same<Static<typeof ReleaseNoteRoute>, C.ReleaseNoteRoute>>();
const ReleaseNoteIcon = Enum(NOTE_ICONS);
assertSame<Same<Static<typeof ReleaseNoteIcon>, C.ReleaseNoteIcon>>();

export const ReleaseNoteItemSchema = Type.Object({
  title: Type.String(),
  text: Type.String(),
  link: Nullable(ReleaseNoteRoute),
  icon: Nullable(ReleaseNoteIcon),
});
assertSame<Same<Static<typeof ReleaseNoteItemSchema>, C.ReleaseNoteItem>>();

export const WhatsNewNoteSchema = Type.Object({
  release_note_id: Type.String(),
  slug: Type.String(),
  title: Type.String(),
  items: Type.Array(ReleaseNoteItemSchema),
  audience: Enum(["new", "existing", "all"]),
  published_at: IsoTime,
});
assertSame<Same<Static<typeof WhatsNewNoteSchema>, C.WhatsNewNote>>();

export const WhatsNewSchema = Type.Object({ mode: Enum(["welcome", "updates", "none"]), notes: Type.Array(WhatsNewNoteSchema) });
assertSame<Same<Static<typeof WhatsNewSchema>, C.WhatsNew>>();

export const WhatsNewSeenRequestSchema = Type.Object(
  { release_note_ids: Type.Array(Uuid, { minItems: 1, maxItems: 20, uniqueItems: true }) },
  strict,
);
assertSame<Same<Static<typeof WhatsNewSeenRequestSchema>, C.WhatsNewSeenRequest>>();

export const NewsPageSchema = pageOf(WhatsNewNoteSchema);
assertSame<Same<Static<typeof NewsPageSchema>, C.Page<C.WhatsNewNote>>>();

// ---------- Конфигурация интерфейса ----------
const HomeSectionType = Enum(["today_plan", "lesson_of_day", "review", "whats_new", "family", "news"]);
assertSame<Same<Static<typeof HomeSectionType>, C.HomeSectionType>>();

export const ExperienceConfigSchema = Type.Object({
  app: Type.Literal("miniapp"),
  version: Type.String(),
  theme: Type.Object({
    id: Enum(["notebook", "notebook_dark"]),
    version: Type.String(),
    // только CSS-переменные (белый список experience-config); прочие ключи сериализатор отбрасывает
    tokens: Type.Record(Type.String({ pattern: "^--[A-Za-z0-9-]+$" }), Type.String()),
  }),
  home: Type.Object({
    sections: Type.Array(
      Type.Object({ type: HomeSectionType, key: Type.String(), variant: Enum(["large", "compact"]), enabled: Type.Boolean() }),
    ),
  }),
  flags: Type.Record(Type.String(), Type.Boolean()),
});
assertSame<Same<Static<typeof ExperienceConfigSchema>, C.ExperienceConfig>>();

// ---------- Поддержка ----------
const TicketStatus = Enum(["NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"]);
assertSame<Same<Static<typeof TicketStatus>, C.TicketStatus>>();
const TicketCategory = Enum([
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
assertSame<Same<Static<typeof TicketCategory>, C.TicketCategory>>();

const TicketContextFields = {
  deeplink: Type.Optional(Type.String({ pattern: "^https://[^\\s]+$", maxLength: 2048, description: "только https" })),
  client_version: Type.String({ minLength: 1, maxLength: 64 }),
};
export const TicketContextSchema = Type.Object(TicketContextFields, strict);
assertSame<Same<Static<typeof TicketContextSchema>, C.TicketContext>>();

export const TicketMessageSchema = Type.Object({
  message_id: Type.String(),
  sender_type: Enum(["user", "operator", "system"]),
  author_name: Nullable(Type.String()),
  text: Type.String(),
  created_at: IsoTime,
});
assertSame<Same<Static<typeof TicketMessageSchema>, C.TicketMessage>>();

const ticketSummaryFields = {
  ticket_id: Type.String(),
  number: Type.String(),
  category: TicketCategory,
  subject: Type.String(),
  status: TicketStatus,
  created_at: IsoTime,
  updated_at: IsoTime,
  last_message_at: IsoTime,
  unread_operator_replies: Type.Integer(),
};
export const TicketSummarySchema = Type.Object(ticketSummaryFields);
assertSame<Same<Static<typeof TicketSummarySchema>, C.TicketSummary>>();

export const TicketSchema = Type.Object({
  ...ticketSummaryFields,
  context: Nullable(Type.Object(TicketContextFields)),
  sla_first_response_at: Nullable(IsoTime),
  messages: Type.Array(TicketMessageSchema),
  status_history: Type.Array(Type.Object({ status: TicketStatus, at: IsoTime })),
});
assertSame<Same<Static<typeof TicketSchema>, C.Ticket>>();

export const CreateTicketRequestSchema = Type.Object(
  {
    category: TicketCategory,
    subject: Type.String({ minLength: 3, maxLength: 120 }),
    message: Type.String({ minLength: 1, maxLength: 4000 }),
    context: Type.Optional(TicketContextSchema),
  },
  strict,
);
assertSame<Same<Static<typeof CreateTicketRequestSchema>, C.CreateTicketRequest>>();

export const TicketMessageRequestSchema = Type.Object({ text: Type.String({ minLength: 1, maxLength: 4000 }) }, strict);
assertSame<Same<Static<typeof TicketMessageRequestSchema>, C.TicketMessageRequest>>();

export const TicketPageSchema = pageOf(TicketSummarySchema);
assertSame<Same<Static<typeof TicketPageSchema>, C.Page<C.TicketSummary>>>();

/** Обращение адресуется UUID или номером «TCK-3081» (deep link startapp=ticket_TCK-3081). */
export const TicketParamsSchema = Type.Object(
  {
    ticket_id: Type.String({
      pattern: `^(${UUID_PATTERN.slice(1, -1)}|TCK-[0-9]{1,12})$`,
      description: "UUID обращения или номер TCK-NNNN",
    }),
  },
  strict,
);

export const SupportCategorySchema = Type.Object({ code: TicketCategory, label: LabelRuUz, available: Type.Boolean() });

// ---------- Удаление ----------
export const DeletionRequestSchema = Type.Object(
  { pin: Type.Optional(PinString), confirm_word: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })) },
  strict,
);
assertSame<Same<Static<typeof DeletionRequestSchema>, C.DeletionRequest>>();

export const DeletionResponseSchema = Type.Object({
  request_id: Type.String(),
  status: Type.Literal("REQUESTED"),
  domains: Type.Array(Type.String()),
  learners: Type.Integer(),
});
assertSame<Same<Static<typeof DeletionResponseSchema>, C.DeletionResponse>>();

// ---------- Заголовки ----------
export const IdempotencyHeadersSchema = Type.Object({
  "idempotency-key": Type.Optional(Type.String({ description: "UUID; повтор с тем же ключом возвращает тот же результат" })),
});
