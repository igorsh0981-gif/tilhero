/**
 * JSON Schema (TypeBox) публичного API. Типы — единственный источник packages/contracts/src/bff.ts:
 * каждая схема ниже проверяется на взаимную совместимость с типом контракта на этапе tsc
 * (assertSame) — рассинхронизация схемы и контракта ломает typecheck.
 *
 * Вход: additionalProperties: false везде (лишние поля → 422). Ответы сериализуются по схеме (fast-json-stringify):
 * в Mini App уходят только поля контракта.
 *
 * Исключение — биометрия (PUT/DELETE /v1/profile/security/biometric, POST /v1/session/biometric/verify): маршруты aievent,
 * типов в bff.ts нет. Локальные типы — ниже (раздел «Код родителя и биометрия»), см. README «Отклонения от контракта».
 */
import { Type, type Static, type TLiteral, type TSchema, type TSchemaOptions, type TUnion } from "@fastify/type-provider-typebox";
import type * as C from "@tilhero/contracts/bff";
import type * as K from "@tilhero/contracts/content";
import type * as AI from "@tilhero/contracts/ai";

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
  pin_reset_effective_at: Nullable(IsoTime),
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
export const TIMEZONE_PATTERN = "^[A-Za-z][A-Za-z0-9_+\\-]*(/[A-Za-z0-9_+\\-]+){0,2}$";
const Timezone = Type.String({ minLength: 1, maxLength: 64, pattern: TIMEZONE_PATTERN });
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

export const GUARDIAN_GRANT_STATUSES = ["granted", "declined"] as const;
export const GuardianConsentGrantSchema = Type.Object({
  teen_user_id: Type.String(),
  teen_display_name: Type.String(),
  status: Enum(GUARDIAN_GRANT_STATUSES),
  decided_at: IsoTime,
});
assertSame<Same<Static<typeof GuardianConsentGrantSchema>, C.GuardianConsentGrant>>();

/** Подросток, за которого решал родитель: неверный формат id — как чужой (404 GUARDIAN_CONSENT_NOT_FOUND). */
export const TeenParamsSchema = Type.Object({ teen_user_id: Uuid }, strict);

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

// ---------- Код родителя (PIN) — bff.ts; биометрия — маршруты aievent, локальные типы ----------
export const PinSetRequestSchema = Type.Object({ pin: PinString, current_pin: Type.Optional(PinString) }, strict);
assertSame<Same<Static<typeof PinSetRequestSchema>, C.PinSetRequest>>();
export const PinRemoveRequestSchema = Type.Object({ current_pin: PinString }, strict);
assertSame<Same<Static<typeof PinRemoveRequestSchema>, C.PinRemoveRequest>>();
export const PinResetRequestResponseSchema = Type.Object({ expires_in: Type.Integer() });
assertSame<Same<Static<typeof PinResetRequestResponseSchema>, C.PinResetRequestResponse>>();
export const PinResetConfirmRequestSchema = Type.Object(
  { code: Type.String({ pattern: "^[0-9]{6}$", description: "6-значный код из бота" }), new_pin: PinString },
  strict,
);
assertSame<Same<Static<typeof PinResetConfirmRequestSchema>, C.PinResetConfirmRequest>>();
export const PinResetCancelRequestSchema = Type.Object({ current_pin: PinString }, strict);
assertSame<Same<Static<typeof PinResetCancelRequestSchema>, C.PinResetCancelRequest>>();

/** POST /v1/session/biometric/verify → SessionResponse. */
export interface BiometricVerifyRequest {
  biometric_token: string;
}
/** PUT /v1/profile/security/biometric → BiometricEnableResponse (только при заданном коде). */
export interface BiometricEnableResponse {
  biometric_token: string;
  security: C.SecurityState;
}
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

/** GET /v1/plan?tz=<IANA> — зона клиента для плана по умолчанию (learning-plan: неизвестная зона → Asia/Tashkent). */
export const PlanQuerySchema = Type.Object({ tz: Type.Optional(Timezone) }, strict);

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
export const NOTE_ROUTES = [
  "home", "lessons", "review", "progress", "profile", "schedule", "notifications", "family", "support", "news",
  "diagnostics", "plan", "skills", "scenarios", "media", "media_requests", "languages",
] as const;
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

// =====================================================================================================================
// Спринт 3 — языки, диагностика, карта навыков, траектория, сценарии, медиатека, заявки (bff.ts «Спринт 3»,
// форматы контента — content.ts). Схемы ответов проверяются и на ответах доменов (src/check.ts): ответ не по контракту
// → 503, а не 500 сериализатора и не утечка лишнего.
// =====================================================================================================================
export const BANDS = ["A0", "A1", "A2", "B1", "B2"] as const;
const Band = Enum(BANDS);
assertSame<Same<Static<typeof Band>, K.Band>>();
const Localized = Type.Object({ ru: Type.String(), uz: Type.String() });
assertSame<Same<Static<typeof Localized>, K.Localized>>();
const GoalCode = Enum(["work", "career", "travel", "daily", "study", "exam"]);
assertSame<Same<Static<typeof GoalCode>, K.GoalCode>>();
export const TOPIC_CODES = [
  "small_talk", "travel", "food", "shopping", "work", "interview", "study", "health", "home", "hobbies", "movies", "tech",
] as const;
const ContentTopic = Enum(TOPIC_CODES);
assertSame<Same<Static<typeof ContentTopic>, K.TopicCode>>();
const SkillArea = Enum(["vocabulary", "grammar", "reading", "listening", "speaking", "writing", "function"]);
assertSame<Same<Static<typeof SkillArea>, K.SkillArea>>();
export const MEDIA_TYPES = ["song", "movie", "interview", "dialogue", "own_scene"] as const;
const MediaType = Enum(MEDIA_TYPES);
assertSame<Same<Static<typeof MediaType>, K.MediaType>>();
const MediaUse = Enum(["listen", "show_transcript", "exercises", "dictionary", "translation"]);
assertSame<Same<Static<typeof MediaUse>, K.MediaUse>>();
const MediaRequestStatus = Enum(["new", "in_review", "authored_alternative", "licensed", "rejected", "duplicate"]);
assertSame<Same<Static<typeof MediaRequestStatus>, K.MediaRequestStatus>>();
const PairStatus = Enum(["planned", "development", "review", "pilot", "published", "archived"]);
assertSame<Same<Static<typeof PairStatus>, K.PairStatus>>();
const LessonStageType = Enum(["retrieval", "explanation", "roleplay", "assessment", "summary"]);
assertSame<Same<Static<typeof LessonStageType>, K.LessonStageType>>();

/** Языковая пара ru-en; по умолчанию — ru-en (единственная опубликованная). */
export const PAIR_PATTERN = "^[a-z]{2,8}-[a-z]{2,8}$";
export const DEFAULT_PAIR = "ru-en";
const PairId = Type.String({ pattern: PAIR_PATTERN, maxLength: 17 });
/** Идентификаторы контента (content.ts): [a-z0-9][a-z0-9._-]{1,63}. */
export const CONTENT_ID_PATTERN = "^[a-z0-9][a-z0-9._-]{1,63}$";
const ContentId = Type.String({ pattern: CONTENT_ID_PATTERN });

// ---------- Языки ----------
export const LanguagePairDomainSchema = Type.Object({
  pair_id: Type.String(),
  source: Type.String(),
  target: Type.String(),
  title: Localized,
  status: PairStatus,
  course_id: Nullable(Type.String()),
});
export const MyLanguagesSchema = Type.Object({
  active_pair_id: Type.String(),
  pairs: Type.Array(
    Type.Object({ pair_id: Type.String(), source: Type.String(), target: Type.String(), title: Localized, status: PairStatus, available: Type.Boolean() }),
  ),
});
assertSame<Same<Static<typeof MyLanguagesSchema>, C.MyLanguages>>();

// ---------- Диагностика ----------
const DiagnosticArea = Enum(["vocabulary", "grammar", "reading", "listening", "speaking", "writing"]);
assertSame<Same<Static<typeof DiagnosticArea>, C.DiagnosticArea>>();
export const TEST_AREAS = ["vocabulary", "grammar", "reading", "listening"] as const;
const TestArea = Enum(TEST_AREAS);
assertSame<Same<Static<typeof TestArea>, C.DiagnosticItem["area"]>>();
const DiagnosticItemType = Enum(["single_choice", "gap_choice", "order_words", "read_choice", "listen_choice"]);
assertSame<Same<Static<typeof DiagnosticItemType>, C.DiagnosticItemType>>();

export const DiagnosticSessionSchema = Type.Object({
  session_id: Type.String(),
  pair_id: Type.String(),
  test_version: Type.String(),
  status: Enum(["in_progress", "finished", "abandoned"]),
  answered: Type.Integer({ minimum: 0 }),
  total_estimate: Type.Integer({ minimum: 0 }),
  started_at: IsoTime,
  expires_at: IsoTime,
  followup_area: Nullable(DiagnosticArea),
});
assertSame<Same<Static<typeof DiagnosticSessionSchema>, C.DiagnosticSession>>();

export const DiagnosticItemSchema = Type.Object({
  item_id: Type.String(),
  area: TestArea,
  type: DiagnosticItemType,
  instruction: Localized,
  prompt_en: Type.String(),
  passage_en: Nullable(Type.String()),
  audio_text_en: Nullable(Type.String()),
  options: Type.Array(Type.String()),
  position: Type.Integer({ minimum: 1 }),
});
assertSame<Same<Static<typeof DiagnosticItemSchema>, C.DiagnosticItem>>();

export const DiagnosticDoneSchema = Type.Object({ done: Type.Literal(true) });
export const DiagnosticNextSchema = Type.Union([DiagnosticItemSchema, DiagnosticDoneSchema]);

export const AnswerRequestSchema = Type.Object(
  {
    item_id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
    answer: Type.Union([
      Type.Integer({ minimum: 0, maximum: 50 }),
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 40 }),
      Type.Null(),
    ]),
    dont_know: Type.Boolean(),
    time_ms: Type.Integer({ minimum: 0, maximum: 3_600_000 }),
  },
  strict,
);
assertSame<Same<Static<typeof AnswerRequestSchema>, C.AnswerRequest>>();

export const AnswerResultSchema = Type.Object({ accepted: Type.Boolean(), next: Nullable(DiagnosticItemSchema), done: Type.Boolean() });
assertSame<Same<Static<typeof AnswerResultSchema>, C.AnswerResult>>();

export const AreaResultSchema = Type.Object({
  area: DiagnosticArea,
  status: Enum(["assessed", "not_assessed"]),
  band: Nullable(Band),
  confidence: Nullable(Type.Number({ minimum: 0, maximum: 1 })),
  reason: Nullable(Enum(["too_few_items", "no_speech_voice", "not_in_test_yet"])),
  /** основания по полосам: показано и верно (без заданий и без отметок по отдельным заданиям) */
  evidence: Type.Array(Type.Object({ band: Band, answered: Type.Integer({ minimum: 0 }), correct: Type.Integer({ minimum: 0 }) })),
  needs_followup: Type.Boolean(),
});
assertSame<Same<Static<typeof AreaResultSchema>, C.AreaResult>>();

export const DiagnosticResultSchema = Type.Object({
  result_id: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
  pair_id: Type.String(),
  test_version: Type.String(),
  provisional_level: Nullable(Band),
  areas: Type.Array(AreaResultSchema),
  weak_areas: Type.Array(DiagnosticArea),
  recommended_start: Nullable(Type.Object({ lesson_id: Type.String(), title: Localized, level: Band })),
  cefr_certificate: Type.Literal(false),
  created_at: IsoTime,
});
assertSame<Same<Static<typeof DiagnosticResultSchema>, C.DiagnosticResult>>();

export const DiagnosticStateSchema = Type.Object({
  pair_id: Type.String(),
  status: Enum(["none", "in_progress", "completed"]),
  session: Nullable(DiagnosticSessionSchema),
  last_result: Nullable(DiagnosticResultSchema),
  next_allowed_at: Nullable(IsoTime),
  audience: Enum(["adults", "kids"]),
});
assertSame<Same<Static<typeof DiagnosticStateSchema>, C.DiagnosticState>>();

export const DiagnosticResultsSchema = itemsOf(DiagnosticResultSchema);
export const PairQuerySchema = Type.Object({ pair_id: Type.Optional(PairId) }, strict);
export const SessionCreateSchema = Type.Object({ pair_id: Type.Optional(PairId) }, strict);
export const FollowupRequestSchema = Type.Object({ area: TestArea }, strict);
export const IdParamsSchema = Type.Object({ id: Uuid }, strict);
export const ContentIdParamsSchema = Type.Object({ id: ContentId }, strict);

// ---------- Карта навыков ----------
const SkillState = Enum(["not_started", "learning", "demonstrated", "retained"]);
assertSame<Same<Static<typeof SkillState>, C.SkillState>>();
const SkillHistory = Type.Object({ source: Enum(["diagnostic", "lesson", "retention"]), outcome: Enum(["positive", "negative"]), at: IsoTime });
const skillMapFields = {
  pair_id: Type.String(),
  course_id: Type.String(),
  counts: Type.Object({ not_started: Type.Integer(), learning: Type.Integer(), demonstrated: Type.Integer(), retained: Type.Integer() }),
};
export const SkillMapSchema = Type.Object({
  ...skillMapFields,
  skills: Type.Array(
    Type.Object({
      skill_id: Type.String(),
      area: SkillArea,
      title: Localized,
      level: Band,
      state: SkillState,
      confidence: Nullable(Type.Number({ minimum: 0, maximum: 1 })),
      prerequisites: Type.Array(Type.String()),
      updated_at: Nullable(IsoTime),
      history: Type.Array(SkillHistory),
    }),
  ),
});
assertSame<Same<Static<typeof SkillMapSchema>, C.SkillMap>>();
/** Ответ diagnostics: метаданные навыка (area, title, level) могут быть null — BFF дополняет из снимка курса. */
export const SkillMapDomainSchema = Type.Object({
  ...skillMapFields,
  skills: Type.Array(
    Type.Object({
      skill_id: Type.String(),
      area: Nullable(Type.String()),
      title: Nullable(Localized),
      level: Nullable(Type.String()),
      state: SkillState,
      confidence: Nullable(Type.Number({ minimum: 0, maximum: 1 })),
      prerequisites: Type.Array(Type.String()),
      updated_at: Nullable(IsoTime),
      history: Type.Array(SkillHistory),
    }),
  ),
});

/** Снимок курса (bff.ts CourseSnapshot) — для BFF нужны только навыки; остальное не проверяется и не отдаётся. */
export const CourseSnapshotSkillsSchema = Type.Object({
  course_id: Type.String(),
  snapshot_version: Type.String(),
  skills: Type.Array(Type.Object({ skill_id: Type.String(), area: SkillArea, title: Localized, level: Band, prerequisites: Type.Array(Type.String()) })),
});

// ---------- Траектория ----------
const ReasonCode = Enum(["start_after_diagnostic", "no_diagnostic", "prerequisite_missing", "weak_area", "goal_match", "topic_match", "next_in_course", "repeat"]);
assertSame<Same<Static<typeof ReasonCode>, C.ReasonCode>>();
const lessonCardFields = {
  lesson_id: Type.String(),
  module_id: Type.String(),
  title: Localized,
  goal: Localized,
  level: Band,
  kind: Enum(["core", "optional"]),
  duration_min: Type.Integer({ minimum: 1 }),
  primary_skill_id: Type.String(),
  scenario_id: Nullable(Type.String()),
  stages: Type.Array(Type.Object({ type: LessonStageType, minutes: Type.Integer({ minimum: 0 }) })),
};
export const LessonCardSchema = Type.Object(lessonCardFields);
assertSame<Same<Static<typeof LessonCardSchema>, C.LessonCard>>();
const PlannedLesson = Type.Object({ ...lessonCardFields, reason_codes: Type.Array(ReasonCode) });
/** спринт 4: пройденный урок — по последней завершённой сессии (зачтён ли, оценка, когда) */
const CompletedLesson = Type.Object({ ...lessonCardFields, passed: Nullable(Type.Boolean()), evaluation_id: Nullable(Type.String()), completed_at: IsoTime });
export const TrajectorySchema = Type.Object({
  pair_id: Type.String(),
  course_id: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
  basis: Type.Object({ diagnostic_result_id: Nullable(Type.String()), goal: Nullable(GoalCode), computed_at: IsoTime }),
  next: Nullable(Type.Object({ ...lessonCardFields, reason_codes: Type.Array(ReasonCode), explanation: Localized })),
  mandatory: Type.Array(PlannedLesson),
  optional: Type.Array(PlannedLesson),
  completed: Type.Array(CompletedLesson),
  lessons_available: Type.Boolean(),
});
assertSame<Same<Static<typeof TrajectorySchema>, C.Trajectory>>();

// ---------- Сценарии ----------
const scenarioCardFields = {
  scenario_id: Type.String(),
  title: Localized,
  task: Localized,
  level: Band,
  difficulty: Type.Integer({ minimum: 1, maximum: 5 }),
  goals: Type.Array(GoalCode),
  topics: Type.Array(ContentTopic),
  characters: Type.Array(Type.Object({ name: Type.String(), role: Localized })),
  access: Type.Literal("free"),
};
export const ScenarioCardSchema = Type.Object(scenarioCardFields);
assertSame<Same<Static<typeof ScenarioCardSchema>, C.ScenarioCard>>();
export const ScenarioPageSchema = pageOf(ScenarioCardSchema);
assertSame<Same<Static<typeof ScenarioPageSchema>, C.Page<C.ScenarioCard>>>();
export const ScenarioDetailSchema = Type.Object({
  ...scenarioCardFields,
  completion: Localized,
  opening: Type.Object({
    speaker: Type.String(),
    line_en: Type.String(),
    gloss: Localized,
    replies: Type.Array(Type.Object({ description: Localized, example_en: Type.String() })),
  }),
  outcomes: Type.Array(Type.Object({ outcome: Enum(["success", "alt_success", "fail"]), summary: Localized })),
});
assertSame<Same<Static<typeof ScenarioDetailSchema>, C.ScenarioDetail>>();
export const ScenarioQuerySchema = Type.Object(
  {
    goal: Type.Optional(GoalCode),
    level: Type.Optional(Band),
    topic: Type.Optional(ContentTopic),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  strict,
);

// ---------- Медиатека ----------
const mediaCardFields = {
  asset_id: Type.String(),
  type: MediaType,
  title: Localized,
  level: Band,
  topics: Type.Array(ContentTopic),
  duration_s: Type.Number({ minimum: 0 }),
  source_label: Type.String(),
  allowed_uses: Type.Array(MediaUse),
  has_audio: Type.Boolean(),
};
export const MediaCardSchema = Type.Object(mediaCardFields);
assertSame<Same<Static<typeof MediaCardSchema>, C.MediaCard>>();
export const MediaPageSchema = pageOf(MediaCardSchema);
assertSame<Same<Static<typeof MediaPageSchema>, C.Page<C.MediaCard>>>();
export const MediaDetailSchema = Type.Object({
  ...mediaCardFields,
  attribution: Nullable(Type.String()),
  transcript: Nullable(
    Type.Array(Type.Object({ t_start_ms: Type.Integer(), t_end_ms: Type.Integer(), speaker: Type.String(), text_en: Type.String(), gloss: Nullable(Localized) })),
  ),
  phrases: Type.Array(Type.Object({ en: Type.String(), gloss: Localized })),
  voices: Type.Record(Type.String(), Enum(["en-GB", "en-US"])),
  exercises_available: Type.Boolean(),
});
assertSame<Same<Static<typeof MediaDetailSchema>, C.MediaDetail>>();
export const MediaQuerySchema = Type.Object(
  {
    type: Type.Optional(MediaType),
    level: Type.Optional(Band),
    topic: Type.Optional(ContentTopic),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  strict,
);
/** Аудио медиатеки: байты (audio/mpeg | audio/ogg | audio/mp4), не JSON — сериализатор не применяется. */
export const AudioBytesSchema = Type.Unsafe<Buffer>({ type: "string", format: "binary", description: "audio/mpeg | audio/ogg | audio/mp4, ≤ 3 МБ" });
export const AudioHeadersSchema = Type.Object({ "if-none-match": Type.Optional(Type.String({ maxLength: 200 })) });

// ---------- Заявки на песни и фильмы ----------
const MediaRequestKind = Enum(["song", "movie", "series", "other"]);
/** Видимый текст: без управляющих символов (кроме перевода строки в комментарии), не из одних пробелов. */
const PLAIN_TEXT = "^[^\\u0000-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f][^\\u0000-\\u001f\\u007f]*$";
const COMMENT_TEXT = "^[^\\u0000-\\u0009\\u000b-\\u001f\\u007f]*$";
export const MediaRequestCreateSchema = Type.Object(
  {
    kind: MediaRequestKind,
    title: Type.String({ minLength: 2, maxLength: 200, pattern: PLAIN_TEXT }),
    link: Type.Optional(Type.String({ maxLength: 500, pattern: "^https://[^\\s]+$", description: "только https; BFF и catalog ссылку не открывают" })),
    comment: Type.Optional(Type.String({ maxLength: 500, pattern: COMMENT_TEXT })),
  },
  strict,
);
assertSame<Same<Static<typeof MediaRequestCreateSchema>, C.MediaRequestCreate>>();
export const MediaRequestSchema = Type.Object({
  request_id: Type.String(),
  kind: MediaRequestKind,
  title: Type.String(),
  link: Nullable(Type.String()),
  comment: Nullable(Type.String()),
  status: MediaRequestStatus,
  decision_note: Nullable(Type.String()),
  linked_asset_id: Nullable(Type.String()),
  created_at: IsoTime,
  decided_at: Nullable(IsoTime),
});
assertSame<Same<Static<typeof MediaRequestSchema>, C.MediaRequest>>();
export const MediaRequestListSchema = itemsOf(MediaRequestSchema);

// =====================================================================================================================
// Спринт 4 — урок, практика сценариев и медиа, оценка, апелляции (bff.ts «Спринт 4»). Ответы lessons и assessment
// сверяются с этими схемами до сборки ответа Mini App (src/check.ts), шаг урока — по дискриминатору `type`
// (routes/lessons.ts); ответ Mini App собирается явно, поле за полем: ключей ответов в нём нет по построению.
// =====================================================================================================================

const SessionKind = Enum(["lesson", "scenario", "media", "review"]);
assertSame<Same<Static<typeof SessionKind>, AI.SessionKind>>();
export const SESSION_KINDS = ["lesson", "scenario", "media", "review"] as const;
const SessionStatus = Enum(["ready", "in_progress", "paused", "completed", "failed", "cancelled"]);
assertSame<Same<Static<typeof SessionStatus>, C.SessionStatus>>();
const SessionStage = Enum(["retrieval", "explanation", "roleplay", "assessment", "summary", "listen", "exercises"]);
assertSame<Same<Static<typeof SessionStage>, C.SessionStage>>();
const Outcome = Enum(["success", "alt_success", "fail"]);
const Voice = Enum(["en-GB", "en-US"]);
const RubricCriterionCode = Enum(["task", "vocabulary", "grammar", "independence", "pronunciation", "fluency", "comprehension"]);
assertSame<Same<Static<typeof RubricCriterionCode>, AI.RubricCriterionCode>>();

/** Номер шага урока: s1, s2, … */
export const STEP_ID_PATTERN = "^s[1-9][0-9]{0,3}$";
const StepId = Type.String({ pattern: STEP_ID_PATTERN });

// ---------- Карточка урока ----------
export const LessonCardDetailSchema = Type.Object({
  ...lessonCardFields,
  version: Type.Integer({ minimum: 1 }),
  primary_skill: Type.Object({ skill_id: Type.String(), title: Localized }),
  stages_detail: Type.Array(Type.Object({ type: LessonStageType, minutes: Type.Integer({ minimum: 0 }), instructions: Localized })),
  key_words_count: Type.Integer({ minimum: 0 }),
  roleplay_mode: Nullable(Enum(["full", "choices"])),
  available: Type.Boolean(),
  unavailable_reason: Nullable(Enum(["audience", "pair_not_available"])),
  active_session_id: Nullable(Uuid),
});
assertSame<Same<Static<typeof LessonCardDetailSchema>, C.LessonCardDetail>>();

// ---------- Сессия ----------
export const LessonSessionSchema = Type.Object({
  session_id: Uuid,
  kind: SessionKind,
  title: Localized,
  lesson_id: Nullable(Type.String()),
  scenario_id: Nullable(Type.String()),
  asset_id: Nullable(Type.String()),
  status: SessionStatus,
  stage: Nullable(SessionStage),
  stages: Type.Array(Type.Object({ type: SessionStage, status: Enum(["done", "current", "pending", "skipped"]) })),
  ai_mode: Enum(["full", "choices"]),
  ai_degraded: Type.Boolean(),
  started_at: Nullable(IsoTime),
  paused_at: Nullable(IsoTime),
  finished_at: Nullable(IsoTime),
  expires_at: Nullable(IsoTime),
  minutes: Type.Integer({ minimum: 0 }),
});
assertSame<Same<Static<typeof LessonSessionSchema>, C.LessonSession>>();
export const ActiveSessionSchema = Type.Object({ session: Nullable(LessonSessionSchema) });
assertSame<Same<Static<typeof ActiveSessionSchema>, { session: C.LessonSession | null }>>();

// ---------- Шаги ----------
const StepItemType = Enum([
  "single_choice", "gap_fill", "order_words", "translate_choice", "comprehension", "gap_fill_media", "order_lines", "phrase_meaning", "meaning_check",
]);
assertSame<Same<Static<typeof StepItemType>, C.StepItemType>>();
/** Задание шага: варианты или слова для порядка — ключа ответа нет (схема и явная сборка stepView). */
export const StepItemSchema = Type.Object({
  item_id: Type.String({ minLength: 1, maxLength: 128 }),
  item_type: StepItemType,
  instruction: Localized,
  prompt_en: Type.String(),
  options: Type.Array(Type.String()),
});
assertSame<Same<Static<typeof StepItemSchema>, C.StepItem>>();

const stepBase = {
  step_id: StepId,
  stage: SessionStage,
  position: Type.Integer({ minimum: 0 }),
  stage_total: Type.Integer({ minimum: 0 }),
};
export const NoticeStepSchema = Type.Object({ ...stepBase, type: Type.Literal("notice"), text: Localized });
export const ExplanationStepSchema = Type.Object({
  ...stepBase,
  type: Type.Literal("explanation"),
  instructions: Localized,
  examples: Type.Array(Type.Object({ en: Type.String(), gloss: Localized })),
  key_words: Type.Array(Type.Object({ en: Type.String(), gloss: Localized, example_en: Type.String() })),
  can_simplify: Type.Boolean(),
});
export const ItemStepSchema = Type.Object({
  ...stepBase,
  type: Type.Literal("item"),
  item: StepItemSchema,
  hint_available: Type.Boolean(),
  hints_used: Type.Integer({ minimum: 0 }),
  graded_later: Type.Boolean(),
});
export const RoleplayStepSchema = Type.Object({
  ...stepBase,
  type: Type.Literal("roleplay"),
  node_id: Type.String(),
  character: Type.Object({ id: Type.String(), name: Type.String(), role: Localized, voice: Voice }),
  line_en: Type.String(),
  gloss: Localized,
  choices: Type.Array(Type.Object({ choice_id: Type.String({ minLength: 1, maxLength: 64 }), text_en: Type.String() })),
  free_text_allowed: Type.Boolean(),
  hint_available: Type.Boolean(),
  hints_used: Type.Integer({ minimum: 0 }),
  history: Type.Array(
    Type.Object({ turn_id: Type.String(), speaker: Enum(["learner", "character"]), text_en: Type.String(), character_id: Nullable(Type.String()) }),
  ),
  unclear_attempts: Type.Integer({ minimum: 0 }),
});
export const RoleplayEndStepSchema = Type.Object({ ...stepBase, type: Type.Literal("roleplay_end"), outcome: Outcome, summary: Localized, can_retry: Type.Boolean() });
export const ListenStepSchema = Type.Object({
  ...stepBase,
  type: Type.Literal("listen"),
  asset_id: Type.String(),
  title: Localized,
  has_audio: Type.Boolean(),
  transcript: Nullable(Type.Array(Type.Object({ speaker: Type.String(), text_en: Type.String(), gloss: Nullable(Localized) }))),
  voices: Type.Record(Type.String(), Voice),
  can_listen: Type.Boolean(),
});
export const OpenAnswerStepSchema = Type.Object({ ...stepBase, type: Type.Literal("open_answer"), prompt: Localized, max_length: Type.Integer({ minimum: 1, maximum: 1000 }) });
export const DoneStepSchema = Type.Object({ ...stepBase, type: Type.Literal("done") });

/** Схема шага по дискриминатору `type` — проверка ответа lessons начинается с неё. */
export const STEP_SCHEMAS = {
  notice: NoticeStepSchema,
  explanation: ExplanationStepSchema,
  item: ItemStepSchema,
  roleplay: RoleplayStepSchema,
  roleplay_end: RoleplayEndStepSchema,
  listen: ListenStepSchema,
  open_answer: OpenAnswerStepSchema,
  done: DoneStepSchema,
} as const;
export const LessonStepSchema = Type.Union([
  NoticeStepSchema,
  ExplanationStepSchema,
  ItemStepSchema,
  RoleplayStepSchema,
  RoleplayEndStepSchema,
  ListenStepSchema,
  OpenAnswerStepSchema,
  DoneStepSchema,
]);
assertSame<Same<Static<typeof LessonStepSchema>, C.LessonStep>>();

/** Свободный текст ученика: без управляющих символов (кроме перевода строки), не из одних пробелов. */
const LEARNER_TEXT = "^[^\\u0000-\\u0009\\u000b-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f][^\\u0000-\\u0009\\u000b-\\u001f\\u007f]*$";
export const STEP_TEXT_MAX = 500;
export const StepAnswerSchema = Type.Object(
  {
    answer: Type.Optional(
      Type.Union([
        Type.Integer({ minimum: 0, maximum: 50 }),
        Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 40 }),
        Type.String({ minLength: 1, maxLength: 200, pattern: PLAIN_TEXT }),
        Type.Null(),
      ]),
    ),
    dont_know: Type.Optional(Type.Boolean()),
    choice_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" })),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: STEP_TEXT_MAX, pattern: LEARNER_TEXT })),
  },
  strict,
);
assertSame<Same<Static<typeof StepAnswerSchema>, C.StepAnswer>>();

export const StepResultSchema = Type.Object({
  accepted: Type.Boolean(),
  feedback: Nullable(Type.Object({ correct: Type.Boolean(), correct_answer: Nullable(Type.String()) })),
  reply: Nullable(Type.Object({ character_id: Type.String(), text_en: Type.String(), gloss: Nullable(Localized), clarification: Type.Boolean() })),
  next: LessonStepSchema,
});
assertSame<Same<Static<typeof StepResultSchema>, C.StepResult>>();
/** Ответ домена: next проверяется отдельно, по дискриминатору (checkStep). */
export const StepResultDomainSchema = Type.Object({
  accepted: Type.Boolean(),
  feedback: StepResultSchema.properties.feedback,
  reply: StepResultSchema.properties.reply,
  next: Type.Object({ type: Type.String() }),
});

export const HintSchema = Type.Object({ hint: Localized });
export const SimplerExplanationSchema = Type.Object({
  explanation: Nullable(Localized),
  example_en: Type.String(),
  example_gloss: Localized,
  source: Enum(["ai", "lesson"]),
});
assertSame<Same<Static<typeof SimplerExplanationSchema>, C.SimplerExplanation>>();

// ---------- Оценка, апелляции, итоги ----------
export const ConfirmedErrorSchema = Type.Object({
  turn_id: Type.String(),
  evidence: Type.String(),
  correction: Type.String(),
  error_code: Type.String(),
  severity: Enum(["low", "medium", "high"]),
});
assertSame<Same<Static<typeof ConfirmedErrorSchema>, AI.ConfirmedError>>();

export const APPEAL_REASON_MAX = 500;
export const AppealSchema = Type.Object({
  appeal_id: Uuid,
  evaluation_id: Uuid,
  status: Enum(["new", "in_review", "upheld", "corrected"]),
  /** null — текст стёрт по сроку хранения (90 дней после решения) */
  reason: Nullable(Type.String()),
  decision_note: Nullable(Type.String()),
  new_evaluation_id: Nullable(Uuid),
  created_at: IsoTime,
  decided_at: Nullable(IsoTime),
});
assertSame<Same<Static<typeof AppealSchema>, C.Appeal>>();
export const AppealListSchema = itemsOf(AppealSchema);
export const AppealRequestSchema = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: APPEAL_REASON_MAX, pattern: LEARNER_TEXT }) },
  strict,
);

const Score = Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Null()]);
export const EvaluationViewSchema = Type.Object({
  evaluation_id: Uuid,
  status: Enum(["ok", "partial", "insufficient_evidence", "pending_review"]),
  passed: Nullable(Type.Boolean()),
  task_completed: Nullable(Type.Boolean()),
  scores: Type.Array(Type.Object({ code: RubricCriterionCode, title: Localized, score: Score })),
  key_errors: Type.Array(ConfirmedErrorSchema),
  items: Type.Array(
    Type.Object({
      item_id: Type.String(),
      prompt_en: Type.String(),
      your_answer: Nullable(Type.String()),
      correct: Type.Boolean(),
      hinted: Type.Boolean(),
      correct_answer: Nullable(Type.String()),
    }),
  ),
  practice_only: Type.Boolean(),
  rubric_version: Type.String(),
  evaluator: Nullable(Type.Object({ model_id: Type.String(), prompt_version: Type.String() })),
  superseded_by: Nullable(Uuid),
  appeal: Nullable(AppealSchema),
  created_at: IsoTime,
});
assertSame<Same<Static<typeof EvaluationViewSchema>, C.EvaluationView>>();

export const LessonSummarySchema = Type.Object({
  session_id: Uuid,
  kind: SessionKind,
  title: Localized,
  status: Enum(["completed", "failed", "cancelled"]),
  outcome: Nullable(Outcome),
  minutes: Type.Integer({ minimum: 0 }),
  evaluation: Nullable(EvaluationViewSchema),
  skills: Type.Array(Type.Object({ skill_id: Type.String(), title: Localized, from: SkillState, to: SkillState })),
  key_words: Type.Array(Type.Object({ en: Type.String(), gloss: Localized })),
  next_lesson: Nullable(LessonCardSchema),
  can_review: Type.Boolean(),
});
assertSame<Same<Static<typeof LessonSummarySchema>, C.LessonSummary>>();

export const LessonHistoryItemSchema = Type.Object({
  session_id: Uuid,
  kind: SessionKind,
  title: Localized,
  status: SessionStatus,
  outcome: Nullable(Outcome),
  passed: Nullable(Type.Boolean()),
  minutes: Type.Integer({ minimum: 0 }),
  evaluation_id: Nullable(Uuid),
  finished_at: Nullable(IsoTime),
  started_at: Nullable(IsoTime),
});
assertSame<Same<Static<typeof LessonHistoryItemSchema>, C.LessonHistoryItem>>();
export const LessonHistoryPageSchema = pageOf(LessonHistoryItemSchema);
assertSame<Same<Static<typeof LessonHistoryPageSchema>, C.Page<C.LessonHistoryItem>>>();
export const HistoryQuerySchema = Type.Object(
  {
    kind: Type.Optional(SessionKind),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  strict,
);

/** Язык ученика для вариантов проверки понимания и объяснения ИИ («проще»); иначе — Accept-Language, иначе ru. */
export const LocaleQuerySchema = Type.Object({ locale: Type.Optional(UiLang) }, strict);

// ---------- Параметры путей ----------
export const LessonParamsSchema = Type.Object({ lesson_id: ContentId }, strict);
export const StepParamsSchema = Type.Object({ id: Uuid, step_id: StepId }, strict);

// ---------- Озвучка (release 4.1) ----------
/** Тело POST /v1/speech. Длина и состав текста (1–400 знаков после нормализации пробелов, без управляющих символов,
 *  хотя бы одна латинская буква) проверяются в маршруте (routes/speech.ts); здесь — только верхняя граница сырого
 *  текста. Любая ошибка схемы → 422 TEXT_INVALID. */
export const SpeechRequestSchema = Type.Object(
  {
    text: Type.String({ maxLength: 2000 }),
    variant: Enum(["en-GB", "en-US"]),
    speed: Type.Optional(Enum(["normal", "slow"])),
  },
  strict,
);
assertSame<Same<Static<typeof SpeechRequestSchema>, C.SpeechRequest>>();
export const SpeechBytesSchema = Type.Unsafe<Buffer>({ type: "string", format: "binary", description: "audio/mpeg (MP3, моно)" });
