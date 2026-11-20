/**
 * Публичный контракт telegram-bff ↔ telegram-miniapp TilHero (спринт 1). ЕДИНСТВЕННЫЙ источник типов для обеих сторон.
 * Ошибки: ErrorBody, клиент различает по `code`. Время — ISO-8601 UTC; локальные даты графика — "YYYY-MM-DD",
 * время — "HH:MM" в часовом поясе плана ученика.
 * Авторизация: Authorization: Bearer <access_token>, кроме /v1/session/telegram, /v1/session/refresh,
 * /v1/experience/config, /v1/legal/policy, GET /v1/guardian-consents/{token}.
 *
 * Аккаунт и ученик. В токене два субъекта: `sub` — аккаунт Telegram, `lrn` — активный ученик (сам аккаунт или
 * детский профиль 6–13 этого аккаунта). Учебные ресурсы (/v1/plan*, /v1/notifications*, /v1/whats-new, /v1/news)
 * относятся к активному ученику; аккаунтные (/v1/profile/age, /consent, /learners, /invites, /family, /delete-request)
 * — к аккаунту. Переключение ученика — POST /v1/session/learner (для детского профиля нужен код родителя, если задан).
 *
 * Заголовок X-Timezone: <IANA> (необязательный) — зона устройства; BFF передаёт её в learning-plan как ?tz= при
 * создании плана по умолчанию. У GET /v1/plan?tz= параметр запроса важнее заголовка.
 *
 * Общие коды ошибок BFF:
 *  - 401 UNAUTHORIZED | TOKEN_INVALID | TOKEN_EXPIRED (→ POST /v1/session/refresh; {reason: "learner_switched"} —
 *    ученик переключён в другой вкладке) | SESSION_REVOKED;
 *  - 403 ADULT_REQUIRED — действие недоступно в детском профиле или до выбора возраста 18+;
 *    403 INVITES_NOT_ALLOWED — приглашения в детском профиле; 403 CONSENT_REQUIRED {purpose} — нужна цель согласия;
 *  - 423 PIN_REQUIRED — сессия не подтверждена кодом родителя (security.pin_required=true);
 *  - 422 VALIDATION_ERROR {in, field, errors}; 400 INVALID_JSON; 404 NOT_FOUND;
 *  - 429 RATE_LIMITED {retry_after} + Retry-After; 503 UPSTREAM_UNAVAILABLE {service}; 500 INTERNAL_ERROR.
 * 4xx доменов передаются клиенту с их кодом и details.
 */

import type {
  AudienceSegment, Band, ControlItemType, GlossarySource, GoalCode, LanguagePair, LessonStageType, Localized,
  MediaRequestStatus, MediaType, MediaUse, PartOfSpeech, ReadingQuestionType, SkillArea, TopicCode,
} from "./content.js";
import type { ConfirmedError, PronunciationErrorType, RubricCriterionCode, SessionKind } from "./ai.js";

export interface ErrorBody {
  code: string;
  message: string;
  trace_id: string;
  details: Record<string, unknown>;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export type UiLang = "ru" | "uz";
export type AgeBand = "6-9" | "10-13" | "14-17" | "18+";
/** Согласие родителя для 14–17: до granted необязательные функции (запись голоса, социальное) выключены. */
export type GuardianConsent = "not_required" | "pending" | "granted" | "declined";

// ---------- Session ----------

export type UserStatus = "ACTIVE" | "DISABLED" | "DELETION_REQUESTED";

export interface UserSummary {
  user_id: string;
  display_name: string;
  username: string | null;
  locale: UiLang;
  status: UserStatus;
  is_new: boolean;
  /** null — возраст ещё не выбран (первый шаг онбординга) */
  age_band: AgeBand | null;
  guardian_consent: GuardianConsent;
}

export interface LearnerSummary {
  learner_id: string;
  /** self — сам аккаунт; child — детский профиль 6–13 */
  kind: "self" | "child";
  display_name: string;
  age_band: AgeBand | null;
  is_active: boolean;
  onboarding_completed: boolean;
  /** спринт 5: запись голоса (оценка произношения) разрешена — у аккаунта своё согласие с voice_recording
   *  (подросток — после согласия родителя), у детского профиля — согласие опекуна (PUT /v1/learners/{id}/voice-consent) */
  voice_consent: boolean;
}

export interface SecurityState {
  /** Код родителя (PIN 4/6 цифр). Нужен для перехода в детский профиль и обратно, покупок, удаления. */
  pin_enabled: boolean;
  pin_length: 4 | 6 | null;
  biometric_enabled: boolean;
  pin_required: boolean;
  locked_until: string | null;
  /** Сброс кода через бота ждёт 24 ч (ревью T-8: телефон может быть у ребёнка); до этого времени действует
   *  прежний код, любой верный ввод прежнего кода отменяет сброс. null — сброса нет. */
  pin_reset_effective_at: string | null;
}

export interface ConsentState {
  accepted: boolean;
  policy_version: string | null;
  current_policy_version: string;
  accepted_at: string | null;
  evidence_hash: string | null;
  /** принятые цели обработки, в т.ч. необязательные: voice_recording, social, product_news */
  purposes: string[];
}

export interface SessionResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  account: UserSummary;
  learner: LearnerSummary;
  learners: LearnerSummary[];
  security: SecurityState;
  consent: ConsentState;
  /** онбординг активного ученика завершён (план сохранён) */
  onboarding_completed: boolean;
  /** start_param из initData, если был: inv_<token> | invite_<invite_id> | gc_<token> | ticket_TCK-NNNN | route_<route> */
  start_param: string | null;
}

/** POST /v1/session/telegram → SessionResponse. 401 INIT_DATA_INVALID {reason} | INIT_DATA_EXPIRED | INIT_DATA_REPLAYED;
 *  410 USER_DELETED. Лимит 10/мин с IP. */
export interface TelegramSessionRequest {
  init_data: string;
}
/** POST /v1/session/refresh → SessionResponse. 401 REFRESH_INVALID. Refresh-токен одноразовый. */
export interface RefreshRequest {
  refresh_token: string;
}
/** POST /v1/session/pin/verify → SessionResponse. 401 PIN_INVALID {remaining}; 423 PIN_LOCKED {retry_after} */
export interface PinVerifyRequest {
  pin: string;
}
/** POST /v1/session/learner → SessionResponse (новые токены с lrn). 404 LEARNER_NOT_FOUND (чужой профиль неотличим);
 *  401 PIN_INVALID / 423 PIN_LOCKED — если код родителя задан и не передан/неверен при переходе ИЗ детского профиля */
export interface SwitchLearnerRequest {
  learner_id: string;
  pin?: string;
}
/** POST /v1/session/logout → 204 */

// ---------- Профиль, возраст, дети ----------

export interface NotificationCategories {
  /** напоминания о занятиях по графику */
  reminders: boolean;
  /** сообщения о пропущенных занятиях */
  missed: boolean;
  /** приглашения и ответы других пользователей */
  social: boolean;
  /** ответы поддержки (служебные, по умолчанию включены) */
  support: boolean;
  /** новости продукта и «Что нового» */
  product: boolean;
}

export interface NotificationSettings {
  /** общий выключатель сообщений в Telegram; центр уведомлений в приложении работает всегда */
  enabled: boolean;
  categories: NotificationCategories;
  quiet_hours: { start: string; end: string } | null; // "22:00"–"08:00", по умолчанию 22:00–08:00
  timezone: string; // IANA, по умолчанию Asia/Tashkent
}

export interface Profile {
  account: UserSummary;
  learner: LearnerSummary;
  learners: LearnerSummary[];
  security: SecurityState;
  consent: ConsentState;
  notifications: NotificationSettings;
}
/** GET /v1/profile → Profile */
/** PATCH /v1/profile/settings → Profile. Категории применяются к активному ученику; для детского профиля
 *  адресат сообщений — родитель. 422 QUIET_HOURS_INVALID */
export interface SettingsPatch {
  locale?: UiLang;
  display_name?: string; // 1..40, только для детского профиля (имя ребёнка)
  notifications?: Partial<Omit<NotificationSettings, "categories">> & { categories?: Partial<NotificationCategories> };
}
/** PUT /v1/profile/age → Profile. Аккаунт может быть только 14-17 или 18+ (ребёнок 6–13 — детский профиль).
 *  14-17 → guardian_consent=pending. 409 AGE_ALREADY_SET (возраст меняется через поддержку) */
export interface AgeRequest {
  age_band: "14-17" | "18+";
}
/** POST /v1/learners → LearnerSummary (201). Только аккаунт 18+. 409 CHILDREN_LIMIT (5); 403 ADULT_REQUIRED */
export interface CreateChildRequest {
  display_name: string; // 1..40
  age_band: "6-9" | "10-13";
}
/** GET /v1/learners → {items: LearnerSummary[]} */

/** POST /v1/profile/guardian-consent → GuardianConsentLink (подросток 14–17 отправляет ссылку родителю).
 *  409 GUARDIAN_CONSENT_NOT_REQUIRED. Ссылка 7 дней, повторный запрос отзывает прежнюю. */
export interface GuardianConsentLink {
  link: string; // https://t.me/<bot>/<app>?startapp=gc_<token>
  expires_at: string;
}
/** GET /v1/guardian-consents/{token} → GuardianConsentPreview (родитель открыл ссылку; авторизация нужна для решения).
 *  POST /v1/guardian-consents/{token}/accept | /decline → GuardianConsentPreview.
 *  404 GUARDIAN_CONSENT_NOT_FOUND; 410 GUARDIAN_CONSENT_EXPIRED; 409 GUARDIAN_CONSENT_SELF (свой же аккаунт); 403 ADULT_REQUIRED */
export interface GuardianConsentPreview {
  teen_display_name: string;
  status: "pending" | "granted" | "declined" | "expired";
  expires_at: string;
}
/** Решение родителя по ссылке фиксируется как согласие подростка с основанием guardian (версия политики, хеш текста,
 *  evidence) и событием consent.accepted.v1 / consent.revoked.v1. Решать может только взрослый с действующим своим
 *  согласием (terms, privacy): иначе 403 CONSENT_REQUIRED {purpose: "terms"} — Mini App сначала показывает политику.
 *  GET /v1/family/guardian-consents → {items: GuardianConsentGrant[]} — подростки, за которых решал этот родитель.
 *  POST /v1/family/guardian-consents/{teen_user_id}/revoke → GuardianConsentGrant: согласие отзывается, у подростка
 *  guardian_consent=declined и сняты необязательные цели. 404 GUARDIAN_CONSENT_NOT_FOUND (не этот родитель). */
export interface GuardianConsentGrant {
  teen_user_id: string;
  teen_display_name: string;
  status: "granted" | "declined";
  decided_at: string;
}

// ---------- Код родителя (PIN) ----------
/** Код родителя защищает выход из детского профиля, удаление и смену кода. Задаётся в профиле взрослого; Mini App
 *  предлагает задать его при создании первого детского профиля.
 *  PUT /v1/profile/security/pin → SecurityState: задать (без current_pin) или сменить (с current_pin). 401 PIN_INVALID.
 *  DELETE /v1/profile/security/pin {current_pin} → SecurityState.
 *  POST /v1/profile/security/pin/reset-request → {expires_in}: бот присылает 6-значный код в чат.
 *  POST /v1/profile/security/pin/reset-confirm {code, new_pin} → SecurityState с pin_reset_effective_at = now + 24 ч:
 *    новый код начинает действовать только через 24 ч; бот сразу сообщает аккаунту о запрошенном сбросе.
 *    Когда срок наступил, новый код применяется при следующей проверке кода, прежние сессии отзываются.
 *  POST /v1/profile/security/pin/reset-cancel {current_pin} → SecurityState: отмена сброса (или любой верный ввод
 *    прежнего кода). 401 PIN_INVALID.
 *  В детском профиле все эти маршруты → 403 ADULT_REQUIRED. */
export interface PinSetRequest {
  pin: string; // 4 или 6 цифр
  current_pin?: string;
}
export interface PinRemoveRequest {
  current_pin: string;
}
export interface PinResetRequestResponse {
  expires_in: number;
}
export interface PinResetConfirmRequest {
  code: string;
  new_pin: string;
}
export interface PinResetCancelRequest {
  current_pin: string;
}

// ---------- Согласия ----------

export interface PolicyDocument {
  version: string;
  purposes: Array<{ code: string; required: boolean; title: string; description: string }>;
  text: string; // markdown на языке запроса (?lang=ru|uz)
}
/** GET /v1/legal/policy?lang=ru → PolicyDocument (публично) */
/** POST /v1/profile/consent → ConsentState. 409 POLICY_VERSION_OUTDATED; 422 CONSENT_REQUIRED_PURPOSES {missing};
 *  403 GUARDIAN_CONSENT_REQUIRED — подросток выбирает необязательные цели до согласия родителя */
export interface ConsentRequest {
  policy_version: string;
  purposes: string[]; // обязательные: terms, privacy, learning; необязательные: voice_recording, social, product_news
}
/** DELETE /v1/profile/consent → ConsentState (отзыв)
 *  Повторный POST /v1/profile/consent с другим набором необязательных целей — новая запись согласия (добавить или
 *  снять цель). Функции необязательных целей проверяются на сервере:
 *   - social — приглашения и семья (создать, принять приглашение): 403 CONSENT_REQUIRED {purpose: "social"};
 *     открыть и посмотреть приглашение можно после принятия terms и privacy;
 *   - product_news — сообщения категории product (новости в центре и в Telegram);
 *   - voice_recording — запись голоса: оценка произношения (спринт 5). Детскому профилю — только согласие опекуна
 *     (PUT /v1/learners/{id}/voice-consent), подростку — после согласия родителя.
 *  Категории уведомлений social и product без соответствующей цели в доставке не учитываются. */

// ---------- Учебный план и график (learning-plan) ----------

export type Goal = "work" | "career" | "travel" | "daily" | "study" | "exam";
export type LevelSelf = "zero" | "beginner" | "some" | "confident";
export type SchedulePreset = "daily" | "weekdays" | "three_per_week" | "custom";
export type DurationMin = 10 | 15 | 20 | 30;

export interface Schedule {
  preset: SchedulePreset;
  /** ISO-дни недели 1=пн … 7=вс, по возрастанию, без повторов, 1..7 дней.
   *  daily → [1..7]; weekdays → [1..5]; three_per_week → [1,3,5] (можно поменять дни — станет custom) */
  days: number[];
  /** время занятия, "HH:MM" местное; пресеты клиента: утро 08:00, день 13:00, вечер 19:00 */
  preferred_time: string;
  duration_min: DurationMin;
  /** явное согласие на напоминания о занятиях (APP-ONB-03: без opt-in не отправляются) */
  reminders_enabled: boolean;
  timezone: string; // IANA из Intl клиента
}

export interface LearningPlan {
  learner_id: string;
  goal: Goal | null;
  level_self: LevelSelf | null;
  topics: string[]; // коды из GET /v1/directory/topics, ≤ 5
  ui_lang: UiLang;
  explain_lang: UiLang;
  course_pair: "ru-en";
  schedule: Schedule;
  onboarding_completed_at: string | null;
  updated_at: string;
  version: number;
}
/** GET /v1/plan → LearningPlan (по умолчанию: goal null, daily, 19:00, 20 мин, reminders false, TZ клиента) */
/** PATCH /v1/plan → LearningPlan. Заголовок If-Match: <version> необязателен; при расхождении 409 PLAN_VERSION_CONFLICT
 *  {current_version}. 422 PLAN_INVALID {field, reason}: days пусто/вне 1..7, время не HH:MM, длительность не 10/15/20/30,
 *  неизвестная зона, тема не из справочника, >5 тем */
export interface PlanPatch {
  goal?: Goal;
  level_self?: LevelSelf;
  topics?: string[];
  ui_lang?: UiLang;
  explain_lang?: UiLang;
  schedule?: Partial<Schedule>;
}
/** POST /v1/plan/onboarding/complete → LearningPlan. 409 PLAN_INCOMPLETE {missing: ["goal", ...]} */

export interface TodayPlan {
  local_date: string; // "2026-11-18"
  is_scheduled_today: boolean;
  slot_time: string | null; // "19:00"
  duration_min: DurationMin;
  minutes_today: number;
  done_today: boolean;
  /** ближайший слот графика, начиная с сегодняшнего несделанного */
  next_slot: { local_date: string; time: string } | null;
  /** дни подряд с занятием в дни графика (дни вне графика серию не рвут) */
  streak_days: number;
  /** текущая неделя пн…вс */
  week: Array<{ local_date: string; scheduled: boolean; done: boolean; missed: boolean }>;
}
/** GET /v1/plan/today → TodayPlan */
/** POST /v1/plan/activity → TodayPlan. Заголовок Idempotency-Key (UUID) обязателен. Спринт 1 — «практика» из
 *  Mini App; уроки и повторения начнут присылать свои события в спринтах 4–5. */
export interface ActivityRequest {
  kind: "practice";
  minutes: number; // 1..240
}

export interface DirectoryItem {
  code: string;
  label: { ru: string; uz: string };
  icon: string | null;
}
/** GET /v1/directory/goals → {items: DirectoryItem[]}; GET /v1/directory/topics → {items: DirectoryItem[]} */

// ---------- Центр уведомлений (notifications) ----------

export type NotificationCategory = "reminders" | "missed" | "social" | "support" | "product" | "service";

export interface InboxItem {
  notification_id: string;
  category: NotificationCategory;
  title: string; // на языке ученика
  body: string;
  /** куда ведёт: invite_<invite_id> | ticket_TCK-NNNN | route_<route>; null — никуда */
  startapp: string | null;
  created_at: string;
  read_at: string | null;
  /** sent — доставлено в Telegram; in_app_only — только здесь (выключено, тихие часы прошли, лимит, бот заблокирован) */
  telegram: "sent" | "scheduled" | "in_app_only" | "failed";
}
/** GET /v1/notifications?limit=20&cursor= → Page<InboxItem> (новые первыми, 90 дней) */
/** GET /v1/notifications/unread-count → {unread: number} */
/** POST /v1/notifications/read → {unread: number}. 422, если ни ids, ни all */
export interface InboxReadRequest {
  ids?: string[]; // ≤ 100
  all?: true;
}

// ---------- Приглашения и семья (social) ----------

export type InviteKind = "family" | "friend" | "referral";

export interface Invite {
  invite_id: string;
  kind: InviteKind;
  /** https://t.me/<bot>/<app>?startapp=inv_<token>; показывается только создателю */
  link: string;
  status: "active" | "accepted" | "revoked" | "expired";
  expires_at: string | null; // referral — без срока
  created_at: string;
  accepted_count: number;
}
/** POST /v1/invites (Idempotency-Key обязателен) → Invite (201). 403 ADULT_REQUIRED (family — только 18+);
 *  403 INVITES_NOT_ALLOWED (детский профиль, подросток без согласия родителя); 409 INVITES_LIMIT (≤ 10 активных) */
export interface CreateInviteRequest {
  kind: InviteKind;
}
/** GET /v1/invites?limit=&cursor= → Page<Invite> (мои); DELETE /v1/invites/{invite_id} → Invite (revoked) */

export interface InvitePreview {
  invite_id: string;
  kind: InviteKind;
  inviter_display_name: string; // имя, без username и Telegram ID
  status: "active" | "accepted" | "revoked" | "expired";
  /** false + reason — показать объяснение вместо кнопки «Принять» */
  can_accept: boolean;
  reason: "self" | "already_member" | "already_friends" | "already_used" | "expired" | "revoked" | "not_allowed" | null;
}
/** POST /v1/invites/open → InvitePreview (получатель открыл ссылку; повтор не создаёт дубль). 404 INVITE_NOT_FOUND.
 *  GET /v1/invites/{invite_id}/preview → InvitePreview (повторный показ из напоминания startapp=invite_<id>; только тому,
 *  кто уже открывал; иначе 404 INVITE_NOT_FOUND) */
export interface InviteOpenRequest {
  token: string; // из start_param без префикса inv_
}
/** POST /v1/invites/{invite_id}/accept → InviteAcceptResult. 409 INVITE_SELF | INVITE_ALREADY_USED | INVITE_EXPIRED |
 *  INVITE_REVOKED | FAMILY_ALREADY_MEMBER; 403 INVITES_NOT_ALLOWED. Повтор принятия тем же пользователем — 200 тот же результат.
 *  POST /v1/invites/{invite_id}/decline → InvitePreview */
export interface InviteAcceptResult {
  invite_id: string;
  kind: InviteKind;
  family: Family | null;
}

export interface Family {
  family_id: string;
  members: Array<{ user_id: string; display_name: string; role: "owner" | "adult" | "teen" | "child"; is_me: boolean }>;
}
/** GET /v1/family → Family | 204 (семьи нет) */

// ---------- «Что нового» и новости (experience-config) ----------

export type ReleaseNoteRoute =
  | "home" | "lessons" | "review" | "progress" | "profile" | "schedule" | "notifications" | "family" | "support" | "news"
  // спринт 3 (release-notes.json)
  | "diagnostics" | "plan" | "skills" | "scenarios" | "media" | "media_requests" | "languages";
export type ReleaseNoteIcon =
  | "spark" | "hero" | "calendar" | "clock" | "bell" | "book" | "chat" | "mic" | "star" | "flame" | "users" | "gift"
  | "shield" | "globe" | "trophy" | "news";

export interface ReleaseNoteItem {
  title: string; // на языке ученика, ≤ 80
  text: string; // ≤ 200
  link: ReleaseNoteRoute | null;
  icon: ReleaseNoteIcon | null;
}

export interface WhatsNewNote {
  release_note_id: string;
  slug: string;
  title: string;
  items: ReleaseNoteItem[];
  audience: "new" | "existing" | "all";
  published_at: string;
}

/** GET /v1/whats-new → WhatsNew. welcome — первый вход после онбординга (знакомство со всем приложением);
 *  updates — непросмотренные новинки при следующих входах; none — показывать нечего. Не больше 5 заметок. */
export interface WhatsNew {
  mode: "welcome" | "updates" | "none";
  notes: WhatsNewNote[];
}
/** POST /v1/whats-new/seen → 204. Отметки на сервере: заметка показывается ученику один раз. */
export interface WhatsNewSeenRequest {
  release_note_ids: string[]; // 1..20
}
/** GET /v1/news?limit=&cursor= → Page<WhatsNewNote> — лента опубликованных новостей, видимых ученику */

// ---------- Конфигурация интерфейса ----------

export type HomeSectionType = "today_plan" | "lesson_of_day" | "review" | "whats_new" | "family" | "news";

export interface ExperienceConfig {
  app: "miniapp";
  version: string;
  theme: { id: "notebook" | "notebook_dark"; version: string; tokens: Record<string, string> };
  home: {
    sections: Array<{ type: HomeSectionType; key: string; variant: "large" | "compact"; enabled: boolean }>;
  };
  flags: Record<string, boolean>;
}
/** GET /v1/experience/config → ExperienceConfig (публично, кэш 60 с; при сбое — bundled fallback) */

// ---------- Поддержка ----------

export type TicketStatus = "NEW" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "RESOLVED" | "CLOSED";
export type TicketCategory =
  | "LESSON"
  | "ASSESSMENT"
  | "SCHEDULE_REMINDERS"
  | "CHILD_PROFILE"
  | "ACCOUNT"
  | "SUBSCRIPTION_PAYMENT"
  | "PERSONAL_DATA"
  | "BUG"
  | "OTHER";

export interface TicketContext {
  deeplink?: string; // только https
  client_version: string; // "telegram-miniapp-1.0"
}

export interface TicketMessage {
  message_id: string;
  sender_type: "user" | "operator" | "system";
  author_name: string | null;
  text: string;
  created_at: string;
}

export interface TicketSummary {
  ticket_id: string;
  number: string; // "TCK-3082"
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  unread_operator_replies: number;
}

export interface Ticket extends TicketSummary {
  context: TicketContext | null;
  sla_first_response_at: string | null;
  messages: TicketMessage[];
  status_history: Array<{ status: TicketStatus; at: string }>;
}
/** POST /v1/support/tickets (Idempotency-Key обязателен) → Ticket (201). 422 SUPPORT_CATEGORY_INVALID */
export interface CreateTicketRequest {
  category: TicketCategory;
  subject: string; // 3..120
  message: string; // 1..4000
  context?: TicketContext;
}
/** GET /v1/support/tickets?limit=&cursor= → Page<TicketSummary>; GET /v1/support/tickets/{id} → Ticket;
 *  POST /v1/support/tickets/{id}/messages → Ticket; POST /v1/support/tickets/{id}/close → Ticket;
 *  GET /v1/support/categories → {items: Array<{code: TicketCategory; label: {ru, uz}; available: boolean}>} */
export interface TicketMessageRequest {
  text: string;
}

// ---------- Удаление ----------
/** POST /v1/profile/delete-request → DeletionResponse (202). Если код родителя задан — нужен pin; иначе
 *  confirm_word = "УДАЛИТЬ" | "OʻCHIRISH". Удаляет аккаунт и все детские профили. После 202 сессии отозваны. */
export interface DeletionRequest {
  pin?: string;
  confirm_word?: string;
}
export interface DeletionResponse {
  request_id: string;
  status: "REQUESTED";
  domains: string[];
  learners: number; // сколько профилей удаляется (аккаунт + дети)
}

// =====================================================================================================================
// Спринт 3 — диагностика, карта навыков, план уроков, сценарии, медиатека, заявки, языки
// Форматы контента — ./content.ts. Пара по умолчанию — "ru-en" (единственная опубликованная, APP-LANG-02).
// Общие коды: 409 PAIR_NOT_AVAILABLE {pair_id} — пара не опубликована; 403 KIDS_NOT_ALLOWED — действие недоступно
// детскому профилю.
// =====================================================================================================================

// ---------- Языки (APP-LANG-01/02) ----------
/** GET /v1/languages → MyLanguages. Неопубликованные пары видны как «скоро», начать их нельзя. */
export interface MyLanguages {
  active_pair_id: string; // "ru-en"
  pairs: Array<Pick<LanguagePair, "pair_id" | "source" | "target" | "title" | "status"> & { available: boolean }>;
}

// ---------- Диагностика (APP-DIAG-01…04) ----------
export type DiagnosticArea = "vocabulary" | "grammar" | "reading" | "listening" | "speaking" | "writing";
export type DiagnosticItemType = "single_choice" | "gap_choice" | "order_words" | "read_choice" | "listen_choice";

/** GET /v1/diagnostics/state → DiagnosticState */
export interface DiagnosticState {
  pair_id: string;
  status: "none" | "in_progress" | "completed";
  session: DiagnosticSession | null; // незавершённая (in_progress, ≤ 24 ч)
  last_result: DiagnosticResult | null;
  /** когда можно пройти снова (null — можно сейчас) */
  next_allowed_at: string | null;
  audience: "adults" | "kids";
}

/** POST /v1/diagnostics/sessions {pair_id?} (Idempotency-Key) → DiagnosticSession (201).
 *  409 DIAGNOSTIC_TOO_SOON {next_allowed_at}. Новая сессия прерывает незавершённую. */
export interface DiagnosticSession {
  session_id: string;
  pair_id: string;
  test_version: string; // "dx-en-adult@1"
  status: "in_progress" | "finished" | "abandoned";
  answered: number;
  /** ориентир для прогресс-бара: всего заданий в тесте (без уточнений) */
  total_estimate: number;
  started_at: string;
  expires_at: string;
  followup_area: DiagnosticArea | null;
}

/** GET /v1/diagnostics/sessions/{id}/next → DiagnosticItem | {done: true}. Ключа ответа в задании нет. */
export interface DiagnosticItem {
  item_id: string;
  area: Exclude<DiagnosticArea, "speaking" | "writing">;
  type: DiagnosticItemType;
  instruction: Localized;
  prompt_en: string;
  passage_en: string | null;
  /** аудирование: текст для синтеза речи устройством (en-GB/en-US); скрывать до ответа */
  audio_text_en: string | null;
  options: string[];
  position: number; // 1-based
}

/** POST /v1/diagnostics/sessions/{id}/answers → AnswerResult. answer: индекс варианта | слова по порядку | null.
 *  dont_know=true — «Не знаю» (answer=null). 409 ITEM_NOT_CURRENT. Правильность ученику не показывается. */
export interface AnswerRequest {
  item_id: string;
  answer: number | string[] | null;
  dont_know: boolean;
  time_ms: number;
}
export interface AnswerResult {
  accepted: boolean;
  next: DiagnosticItem | null;
  done: boolean;
}
/** POST /v1/diagnostics/sessions/{id}/listening-unavailable → 204 (нет голоса en-* на устройстве).
 *  POST /v1/diagnostics/sessions/{id}/finish → DiagnosticResult. */

export interface AreaResult {
  area: DiagnosticArea;
  status: "assessed" | "not_assessed";
  band: Band | null;
  confidence: number | null; // 0..1
  reason: "too_few_items" | "no_speech_voice" | "not_in_test_yet" | null;
  /** основания по полосам (по возрастанию): сколько заданий полосы показано и сколько верно. Без заданий и без
   *  отметок верно/неверно по отдельным заданиям — иначе результат стал бы «оракулом» ключей банка. Для not_assessed — []. */
  evidence: Array<{ band: Band; answered: number; correct: number }>;
  needs_followup: boolean;
}

export interface DiagnosticResult {
  result_id: string;
  revision: number;
  pair_id: string;
  test_version: string;
  provisional_level: Band | null;
  areas: AreaResult[];
  weak_areas: DiagnosticArea[];
  recommended_start: { lesson_id: string; title: Localized; level: Band } | null;
  /** всегда false: это не сертификат CEFR */
  cefr_certificate: false;
  created_at: string;
}
/** POST /v1/diagnostics/results/{id}/followup {area} → DiagnosticSession (уточнение +3 задания; ≤ 24 ч после
 *  завершения; только needs_followup). GET /v1/diagnostics/results → {items: DiagnosticResult[]} (история). */

// ---------- Карта навыков (APP-PLAN-01) ----------
export type SkillState = "not_started" | "learning" | "demonstrated" | "retained";

/** GET /v1/skills/map → SkillMap */
export interface SkillMap {
  pair_id: string;
  course_id: string;
  counts: Record<SkillState, number>;
  skills: Array<{
    skill_id: string;
    area: SkillArea;
    title: Localized;
    level: Band;
    state: SkillState;
    confidence: number | null;
    prerequisites: string[];
    updated_at: string | null;
    history: Array<{ source: "diagnostic" | "lesson" | "retention"; outcome: "positive" | "negative"; at: string }>;
  }>;
}

// ---------- План уроков (APP-PLAN-02/03) ----------
export type ReasonCode =
  | "start_after_diagnostic" | "no_diagnostic" | "prerequisite_missing" | "weak_area" | "goal_match" | "topic_match"
  | "next_in_course"
  /** спринт 4: урок пройден без зачёта — мягкая пометка «повторить» (и детям — без давления) */
  | "repeat";

export interface LessonCard {
  lesson_id: string;
  module_id: string;
  title: Localized;
  goal: Localized;
  level: Band;
  kind: "core" | "optional";
  duration_min: number;
  primary_skill_id: string;
  scenario_id: string | null;
  stages: Array<{ type: LessonStageType; minutes: number }>;
}

/** GET /v1/plan/trajectory → Trajectory. Смена цели (PATCH /v1/plan) пересчитывает траекторию. */
export interface Trajectory {
  pair_id: string;
  course_id: string;
  revision: number;
  basis: { diagnostic_result_id: string | null; goal: GoalCode | null; computed_at: string };
  next: (LessonCard & { reason_codes: ReasonCode[]; explanation: Localized }) | null;
  mandatory: Array<LessonCard & { reason_codes: ReasonCode[] }>;
  optional: Array<LessonCard & { reason_codes: ReasonCode[] }>;
  /** пройденные уроки (спринт 4): по последней завершённой сессии урока */
  completed: Array<LessonCard & { passed: boolean | null; evaluation_id: string | null; completed_at: string }>;
  /** спринт 4: true — уроки проходятся в Mini App; false — только при отключении уроков флагом */
  lessons_available: boolean;
}

// ---------- Сценарии (APP-PLAN-04) ----------
export interface ScenarioCard {
  scenario_id: string;
  title: Localized;
  task: Localized;
  level: Band;
  difficulty: number;
  goals: GoalCode[];
  topics: TopicCode[];
  characters: Array<{ name: string; role: Localized }>;
  access: "free";
}
/** GET /v1/scenarios?goal=&level=&topic=&cursor= → Page<ScenarioCard> (детям — только audience kids);
 *  GET /v1/scenarios/{id} → ScenarioDetail */
export interface ScenarioDetail extends ScenarioCard {
  completion: Localized;
  /** первая реплика и варианты ответа ученика — превью; полный граф — в уроке (спринт 4) */
  opening: { speaker: string; line_en: string; gloss: Localized; replies: Array<{ description: Localized; example_en: string }> };
  outcomes: Array<{ outcome: "success" | "alt_success" | "fail"; summary: Localized }>;
}

// ---------- Медиатека (APP-MEDIA-01) ----------
export interface MediaCard {
  asset_id: string;
  type: MediaType;
  title: Localized;
  level: Band;
  topics: TopicCode[];
  duration_s: number;
  /** источник для ученика: «TilHero», «Общественное достояние», правообладатель */
  source_label: string;
  allowed_uses: MediaUse[];
  has_audio: boolean;
}
/** GET /v1/media?type=&level=&topic=&cursor= → Page<MediaCard>; GET /v1/media/{id} → MediaDetail;
 *  GET /v1/media/{id}/audio → аудио (прокси с кешем); 404 MEDIA_NOT_AVAILABLE — снят с публикации или права истекли. */
export interface MediaDetail extends MediaCard {
  attribution: string | null;
  /** null — транскрипт не разрешён лицензией; gloss = null — перевод реплик не разрешён (allowed_uses ∌ translation) */
  transcript: Array<{ t_start_ms: number; t_end_ms: number; speaker: string; text_en: string; gloss: Localized | null }> | null;
  phrases: Array<{ en: string; gloss: Localized }>;
  /** для синтеза речи устройством, если нет аудиофайла */
  voices: Record<string, "en-GB" | "en-US">;
  /** упражнения к медиа выполняются в уроке (спринт 4) */
  exercises_available: boolean;
}

// ---------- Заявки на песни и фильмы (APP-MEDIA-04) ----------
/** POST /v1/media/requests (Idempotency-Key) → MediaRequest (201). Детский профиль → 403 KIDS_NOT_ALLOWED;
 *  > 5 в сутки → 429 MEDIA_REQUEST_LIMIT (Retry-After). GET /v1/media/requests → {items: MediaRequest[]}. Это заявка контент-менеджеру:
 *  ничего не скачивается и не расшифровывается автоматически. */
export interface MediaRequestCreate {
  kind: "song" | "movie" | "series" | "other";
  title: string; // 2..200
  link?: string; // https://…, ≤ 500
  comment?: string; // ≤ 500
}
export interface MediaRequest extends Required<Omit<MediaRequestCreate, "link" | "comment">> {
  request_id: string;
  link: string | null;
  comment: string | null;
  status: MediaRequestStatus;
  decision_note: string | null;
  linked_asset_id: string | null;
  created_at: string;
  decided_at: string | null;
}

// ---------- Снимок курса (для сервисов; ученику — через карточки выше) ----------
export interface CourseSnapshot {
  course_id: string;
  pair_id: string;
  snapshot_version: string;
  title: Localized;
  level_start: Band;
  level_end: Band;
  modules: Array<{ module_id: string; title: Localized; goal: Localized; theme: TopicCode; lesson_ids: string[] }>;
  skills: Array<{ skill_id: string; area: SkillArea; title: Localized; level: Band; prerequisites: string[]; diagnostic_tags: string[] }>;
  lessons: Array<LessonCard & {
    audience: AudienceSegment[];
    goals: GoalCode[];
    topics: TopicCode[];
    secondary_skill_ids: string[];
    prerequisite_skill_ids: string[];
    control_item_types: ControlItemType[];
  }>;
}

// =====================================================================================================================
// Спринт 4 — урок 20 минут, практика сценариев и медиа, независимая оценка, апелляции
// Сессии ведёт lessons (машина состояний на сервере), оценки — assessment. ИИ необязателен: при выключенном ИИ,
// исчерпанном бюджете и для детей ролевая ситуация идёт выбором реплик (ai_mode "choices").
// Общие коды: 404 LESSON_NOT_AVAILABLE | SESSION_NOT_FOUND; 409 SESSION_ACTIVE {session_id, kind, title} — есть
// незавершённая сессия (продолжить или отменить); 409 SESSION_STATE {status} — действие недопустимо в этом статусе;
// 409 STEP_NOT_CURRENT {current_step_id}; 409 HINTS_NOT_ALLOWED — подсказки на проверке без подсказок;
// 409 PAIR_NOT_AVAILABLE; 403 KIDS_NOT_ALLOWED (свободный текст ребёнку).
// =====================================================================================================================

export type SessionStatus = "ready" | "in_progress" | "paused" | "completed" | "failed" | "cancelled";
/** media-сессия: listen → exercises → summary; scenario: roleplay → summary; review: assessment → summary;
 *  reading (спринт 5): reading → questions → summary */
export type SessionStage = LessonStageType | "listen" | "exercises" | "reading" | "questions";

// ---------- Карточка урока (APP-LESS-01) ----------
/** GET /v1/lessons/{lesson_id} → LessonCardDetail. Награды — спринт 6 (не показываются). */
export interface LessonCardDetail extends LessonCard {
  version: number;
  primary_skill: { skill_id: string; title: Localized };
  stages_detail: Array<{ type: LessonStageType; minutes: number; instructions: Localized }>;
  key_words_count: number;
  /** формат ролевой ситуации для этого ученика: свободный текст или выбор реплик */
  roleplay_mode: "full" | "choices" | null;
  available: boolean;
  unavailable_reason: "audience" | "pair_not_available" | null;
  /** незавершённая сессия этого урока, если есть */
  active_session_id: string | null;
}

// ---------- Сессия ----------
/** POST /v1/lessons/{lesson_id}/sessions | /v1/scenarios/{id}/sessions | /v1/media/{asset_id}/sessions
 *  (Idempotency-Key) → LessonSession (201). 409 SESSION_ACTIVE, 404 LESSON_NOT_AVAILABLE / NO_EXERCISES.
 *  GET /v1/sessions/active → {session: LessonSession | null}; GET /v1/sessions/{id} → LessonSession.
 *  POST /v1/sessions/{id}/pause | resume | cancel → LessonSession. */
export interface LessonSession {
  session_id: string;
  kind: SessionKind;
  title: Localized;
  lesson_id: string | null;
  scenario_id: string | null;
  asset_id: string | null;
  status: SessionStatus;
  stage: SessionStage | null;
  stages: Array<{ type: SessionStage; status: "done" | "current" | "pending" | "skipped" }>;
  ai_mode: "full" | "choices";
  /** «сейчас занятие идёт в упрощённом режиме» — ИИ недоступен (выключен или исчерпан бюджет) */
  ai_degraded: boolean;
  started_at: string | null;
  paused_at: string | null;
  finished_at: string | null;
  /** когда пауза истечёт (72 ч) и сессия будет отменена */
  expires_at: string | null;
  minutes: number;
}

// ---------- Шаги (GET /v1/sessions/{id}/current → LessonStep; авто-продолжение после паузы) ----------
/** Вопросы к тексту для чтения (спринт 5): single_choice и true_false приходят как single_choice (true_false — варианты
 *  ["True", "False"]), gap_fill — как gap_fill. */
export type StepItemType = ControlItemType | "comprehension" | "gap_fill_media" | "order_lines" | "phrase_meaning" | "meaning_check";

export interface StepItem {
  item_id: string;
  item_type: StepItemType;
  instruction: Localized;
  prompt_en: string;
  /** варианты (choice) или слова/реплики для порядка; ключа ответа нет */
  options: string[];
}

interface StepBase {
  step_id: string; // s{n}
  stage: SessionStage;
  position: number; // 1-based внутри этапа
  stage_total: number;
}

export type LessonStep =
  | (StepBase & { type: "notice"; text: Localized })
  | (StepBase & { type: "explanation"; instructions: Localized; examples: Array<{ en: string; gloss: Localized }>;
      key_words: Array<{ en: string; gloss: Localized; example_en: string }>; can_simplify: boolean })
  | (StepBase & { type: "item"; item: StepItem; hint_available: boolean; hints_used: number;
      /** проверка без подсказок — правильность не показывается до итогов */
      graded_later: boolean })
  | (StepBase & { type: "roleplay"; node_id: string;
      character: { id: string; name: string; role: Localized; voice: "en-GB" | "en-US" };
      line_en: string; gloss: Localized;
      choices: Array<{ choice_id: string; text_en: string }>;
      free_text_allowed: boolean; hint_available: boolean; hints_used: number;
      /** последние реплики сцены для чата */
      history: Array<{ turn_id: string; speaker: "learner" | "character"; text_en: string; character_id: string | null }>;
      /** сколько непонятных ответов подряд на этом узле (после 2 — только варианты) */
      unclear_attempts: number })
  | (StepBase & { type: "roleplay_end"; outcome: "success" | "alt_success" | "fail"; summary: Localized; can_retry: boolean })
  | (StepBase & { type: "listen"; asset_id: string; title: Localized; has_audio: boolean;
      transcript: Array<{ speaker: string; text_en: string; gloss: Localized | null }> | null;
      voices: Record<string, "en-GB" | "en-US">; can_listen: boolean })
  | (StepBase & { type: "open_answer"; prompt: Localized; max_length: number })
  /** спринт 5: текст для чтения (перевод по тапу — POST /v1/memory/translate, ContentRef kind reading) */
  | (StepBase & { type: "reading"; reading: ReadingView })
  | (StepBase & { type: "done" }); // все шаги пройдены — POST /finish

/** POST /v1/sessions/{id}/steps/{step_id} StepAnswer → StepResult. Повтор того же ответа → тот же результат.
 *  roleplay: choice_id ИЛИ text (только при free_text_allowed). item: answer (индекс | слова/реплики по порядку |
 *  строка для пропуска) или dont_know. open_answer: text (≤ max_length). explanation/notice/listen/roleplay_end: {} —
 *  «Дальше». Детский профиль: text → 403 KIDS_NOT_ALLOWED (BFF, до домена). */
export interface StepAnswer {
  answer?: number | string[] | string | null;
  dont_know?: boolean;
  choice_id?: string;
  text?: string; // ≤ 500
}
export interface StepResult {
  accepted: boolean;
  /** только повторение и проверка понимания; на проверке без подсказок — null */
  feedback: { correct: boolean; correct_answer: string | null } | null;
  /** ролевая ситуация: ответ персонажа (ИИ или реплика следующего узла графа) */
  reply: { character_id: string; text_en: string; gloss: Localized | null; clarification: boolean } | null;
  next: LessonStep;
}

/** POST /v1/sessions/{id}/steps/{step_id}/hint → {hint: Localized} (отмечается; в проверке без подсказок — 409).
 *  POST /v1/sessions/{id}/simpler?locale=ru|uz → SimplerExplanation (позиция урока не меняется; locale по умолчанию —
 *  Accept-Language).
 *  POST /v1/sessions/{id}/roleplay/retry → LessonStep (один раз после исхода fail, с точки восстановления). */
export interface SimplerExplanation {
  explanation: Localized | null; // ИИ на языке ученика или null (следующий пример урока)
  example_en: string;
  example_gloss: Localized;
  source: "ai" | "lesson";
}

// ---------- Итоги и оценка (APP-LESS-07, APP-COACH-02/04/05) ----------
/** POST /v1/sessions/{id}/finish → LessonSummary (повтор — тот же итог). GET /v1/sessions/{id}/summary. */
export interface LessonSummary {
  session_id: string;
  kind: SessionKind;
  title: Localized;
  status: "completed" | "failed" | "cancelled";
  outcome: "success" | "alt_success" | "fail" | null;
  minutes: number;
  evaluation: EvaluationView | null;
  skills: Array<{ skill_id: string; title: Localized; from: SkillState; to: SkillState }>;
  key_words: Array<{ en: string; gloss: Localized }>;
  next_lesson: LessonCard | null;
  /** есть задания с ошибкой — можно повторить (без влияния на освоение): POST /v1/sessions/{id}/review
   *  (Idempotency-Key) → LessonSession (201, kind review); 409 NOTHING_TO_REVIEW */
  can_review: boolean;
}

export interface EvaluationView {
  evaluation_id: string;
  status: "ok" | "partial" | "insufficient_evidence" | "pending_review";
  passed: boolean | null;
  task_completed: boolean | null;
  scores: Array<{ code: RubricCriterionCode; title: Localized; score: 0 | 1 | 2 | 3 | null }>;
  /** 1–3 ключевые ошибки с фрагментом ответа и исправлением */
  key_errors: ConfirmedError[];
  items: Array<{ item_id: string; prompt_en: string; your_answer: string | null; correct: boolean; hinted: boolean;
                 /** только если ответ неверен */ correct_answer: string | null }>;
  practice_only: boolean;
  /** версии для прозрачности: рубрика и модель оценщика (null — оценено правилами) */
  rubric_version: string; // "r-a1@2"
  evaluator: { model_id: string; prompt_version: string } | null;
  /** заменена переоценкой (по апелляции или QA) — показывается актуальная */
  superseded_by: string | null;
  appeal: Appeal | null;
  created_at: string;
}

// ---------- Апелляции (UC-ADM-03) ----------
/** GET /v1/evaluations/{id} → EvaluationView (BFF → assessment с sub = lrn). «Оценка появится позже»
 *  (LessonSummary.evaluation = null, id оценки ещё нет) — опрос GET /v1/sessions/{id}/summary.
 *  POST /v1/evaluations/{id}/appeal {reason} (Idempotency-Key) → Appeal (201). 409 APPEAL_EXISTS,
 *  409 APPEAL_WINDOW_CLOSED (> 14 дней). GET /v1/appeals → {items: Appeal[]}. */
export interface Appeal {
  appeal_id: string;
  evaluation_id: string;
  status: "new" | "in_review" | "upheld" | "corrected";
  reason: string | null; // ≤ 500; null — стёрт по сроку хранения (90 дней после решения)
  decision_note: string | null; // ≤ 500
  new_evaluation_id: string | null;
  created_at: string;
  decided_at: string | null;
}

// ---------- История (APP-PROG-03, частично) ----------
/** GET /v1/sessions?kind=&cursor= → Page<LessonHistoryItem> */
export interface LessonHistoryItem {
  session_id: string;
  kind: SessionKind;
  title: Localized;
  status: SessionStatus;
  outcome: "success" | "alt_success" | "fail" | null;
  passed: boolean | null;
  minutes: number;
  evaluation_id: string | null;
  finished_at: string | null;
  started_at: string | null;
}


// ---------- Озвучка (release 4.1: серверный синтез речи вместо синтеза устройства) ----------
/** POST /v1/speech SpeechRequest → 200 `audio/mpeg` (MP3, моно; Cache-Control: private, max-age=86400).
 *  Озвучка английских фраз контента: аудирование теста на уровень, «Прослушать» в разговоре, медиа без файла.
 *  Синтез речи устройства (Web Speech) во встроенном браузере Telegram на Android отсутствует, на iOS тихий —
 *  поэтому звук приходит файлом и играет через `HTMLAudioElement`. Ошибки: 422 TEXT_INVALID (пусто, > 400 знаков,
 *  нет латиницы); 429 RATE_LIMITED; 503 SPEECH_UNAVAILABLE — клиент откатывается на синтез устройства, если он есть.
 *  BFF → tts `POST /internal/v1/speech` (то же тело; вызывающий — только telegram-bff). Кеш озвучки — у tts. */
export interface SpeechRequest {
  text: string; // 1–400 знаков, английский текст контента
  variant: "en-GB" | "en-US"; // голос: en-US — мужской (ryan), en-GB — женский (southern english female)
  speed?: "normal" | "slow"; // slow — для детей 6–13 и повторного прослушивания; по умолчанию normal
}

// =====================================================================================================================
// Спринт 5 — память и повторения (APP-MEM-01…05), чтение, перевод по тапу, произношение (APP-ADV-01)
// Словарь, «Повторение дня», журнал ошибок, проверки удержания, перевод, произношение — memory; чтение — lessons
// (сессия kind "reading") и catalog (тексты). Срок следующего повторения считает только FSRS в memory.
// Общие коды: 404 CARD_NOT_FOUND | REVIEW_SESSION_NOT_FOUND | READING_NOT_AVAILABLE | CONTENT_NOT_FOUND;
// 409 NOTHING_TO_REVIEW {next_due_at}; 409 TASK_NOT_CURRENT {current_task_id}; 409 REVIEW_SESSION_STATE {status};
// 409 HINTS_NOT_ALLOWED (проверка удержания); 422 CARDS_LIMIT {limit: 2000}; 422 WORD_NOT_IN_CONTENT;
// 422 GLOSS_UNAVAILABLE; 403 VOICE_CONSENT_REQUIRED {who: "self" | "guardian"}; 422 AUDIO_INVALID {reason};
// 503 SPEECH_UNAVAILABLE.
// =====================================================================================================================

/** Ссылка на место в опубликованном контенте (слово для перевода, источник карточки, эталон произношения).
 *  locator: reading — s_id предложения; media_asset — индекс реплики транскрипта (строкой); lesson — "ex:<i>" пример
 *  или "kw:<i>" ключевое слово; scenario — node_id. */
export interface ContentRef {
  kind: "lesson" | "media_asset" | "reading" | "scenario";
  key: string;
  version: number;
  locator?: string;
}

// ---------- Обзор (главная, вкладка «Словарь») ----------
/** GET /v1/memory/overview → MemoryOverview */
export interface MemoryOverview {
  /** карточек к сроку до конца местного дня (без новых) */
  due_count: number;
  /** новых, которые войдут в сегодняшнее повторение (с учётом дневного лимита: 5, детям 3) */
  new_available: number;
  /** проверок удержания со сроком */
  retention_due: number;
  /** повторение сегодня уже было (completed) */
  done_today: boolean;
  /** незавершённая сессия повторения */
  active_session_id: string | null;
  /** ближайший срок, если сегодня повторять нечего */
  next_due_at: string | null;
  total_cards: number;
  /** оценка произношения: available — можно записывать; consent_self — нужно своё согласие (настройки);
   *  consent_guardian — нужно согласие родителя (подросток — ссылка родителю, ребёнок — родитель в карточке ребёнка);
   *  unavailable — функция выключена (нет ключа Azure, остановка, бюджет) — кнопку не показывать */
  pronunciation: "available" | "consent_self" | "consent_guardian" | "unavailable";
}

// ---------- Словарь (APP-MEM-02, APP-PROG-04 частично) ----------
export type CardKind = "word" | "phrase" | "error";
export type CardStatus = "new" | "learning" | "review" | "known" | "frozen";
/** сила запоминания для ученика: new — ещё не повторялась; weak — R < 0.7 или lapses ≥ 2; ok — S < 21 дня; strong */
export type CardStrength = "new" | "weak" | "ok" | "strong";

export interface DictionaryCard {
  card_id: string;
  kind: CardKind;
  text_en: string;
  gloss: Localized;
  gloss_source: GlossarySource;
  status: CardStatus;
  strength: CardStrength;
  due_at: string | null; // null — known/frozen
  last_reviewed_at: string | null;
  created_at: string;
}
/** GET /v1/memory/cards?kind=&status=&q=&cursor=&limit= → Page<DictionaryCard> (q — по английскому и переводу, ≤ 60;
 *  limit необязателен, как у остальных списков; так же /v1/memory/errors и /v1/practice/readings). */

export interface CardSource {
  kind: "lesson" | "media" | "reading" | "scenario" | "evaluation" | "manual";
  title: Localized | null; // название урока/текста/медиа; null — источник снят с публикации
  at: string;
}

/** GET /v1/memory/cards/{id} → DictionaryCardDetail */
export interface DictionaryCardDetail extends DictionaryCard {
  example_en: string | null;
  /** ошибка (kind error): что исправить; evidence — ваш фрагмент (стирается через 90 дней — null) */
  error: { correction: string; evidence: string | null; error_code: string; explanation: Localized } | null;
  sources: CardSource[];
  /** последние 10 повторений */
  history: Array<{ at: string; grade: "again" | "hard" | "good" | null; mode: "choice" | "typed" | "assemble" | "listen" | "manual" }>;
  next_review_in_days: number | null;
  last_pronunciation: { at: string; intelligibility: "clear" | "mostly_clear" | "needs_practice" | null } | null;
}

/** POST /v1/memory/cards (Idempotency-Key) AddCardRequest → DictionaryCard (201 новая; 200 — уже была, источник добавлен).
 *  Только слово или фраза опубликованного контента (проверяется на сервере); свой текст ученика — нельзя.
 *  422 WORD_NOT_IN_CONTENT, 422 GLOSS_UNAVAILABLE, 422 CARDS_LIMIT.
 *  POST /v1/memory/cards/{id}/known → DictionaryCard (status known — «Знаю это», в повторение не попадает);
 *  DELETE /v1/memory/cards/{id}/known → DictionaryCard (вернуть в повторение; срок — сейчас).
 *  DELETE /v1/memory/cards/{id} → 204 (убрать из словаря). */
export interface AddCardRequest {
  /** форма как в тексте (сервер проверяет, что она есть в версии контента; лемму и формы берёт из словаря курса) */
  text_en: string; // ≤ 120
  source: ContentRef;
}

// ---------- Журнал ошибок (APP-MEM-01) ----------
/** GET /v1/memory/errors?cursor= → Page<ErrorJournalItem>: подтверждённые ошибки из оценок уроков и сценариев
 *  (только свободный текст; у детей журнала нет). Карточка ошибки живёт 90 дней. */
export interface ErrorJournalItem {
  card_id: string;
  correction: string;
  error_code: string;
  explanation: Localized; // «Пропущен глагол be», «Порядок слов»
  severity: "low" | "medium" | "high";
  strength: CardStrength;
  lesson_title: Localized | null;
  created_at: string;
}

// ---------- «Повторение дня» (APP-MEM-03/04) ----------
export type ReviewSessionStatus = "active" | "completed" | "expired" | "cancelled";
export type ReviewTaskType =
  | "intro" | "meaning_choice" | "listen_choice" | "typed" | "cloze" | "assemble" | "error_fix" | "check_item";

/** POST /v1/memory/review-sessions (Idempotency-Key) → ReviewSession (201; есть активная — 200 она же).
 *  409 NOTHING_TO_REVIEW {next_due_at}. GET /v1/memory/review-sessions/active → {session: ReviewSession | null}.
 *  GET /v1/memory/review-sessions/{id} → ReviewSession. POST …/{id}/cancel → ReviewSession. */
export interface ReviewSession {
  session_id: string;
  status: ReviewSessionStatus;
  total_tasks: number; // может вырасти на повторы карточек с ошибкой (каждая — один раз)
  done_tasks: number;
  cards: number;
  new_cards: number;
  checks: number; // блоки проверки удержания
  started_at: string;
  finished_at: string | null;
  minutes: number;
}

/** GET /v1/memory/review-sessions/{id}/current → ReviewTask. Ключа ответа нет. Все задания пройдены →
 *  409 TASK_NOT_CURRENT {current_task_id: null} — вызвать POST …/finish. */
export interface ReviewTask {
  task_id: string;
  index: number; // 1-based
  total: number;
  type: ReviewTaskType;
  card_id: string | null;
  /** проверка удержания: без подсказок, верный ответ — в конце блока */
  check: { check_id: string; skill_title: Localized; position: number; of: number } | null;
  /** что показать (по типу):
   *  intro — text_en, gloss, example_en; meaning_choice — text_en, options (переводы на языке интерфейса);
   *  listen_choice — speech_text (озвучить через /v1/speech), options (английские); typed — gloss, example_gap
   *  (пример с ___ или null); cloze — example_gap, gloss; assemble — gloss, tiles (буквы или слова, перемешаны);
   *  error_fix — explanation, evidence (ваш фрагмент) или null, gloss null; check_item — instruction, prompt_en, options */
  prompt: {
    text_en: string | null;
    gloss: Localized | null;
    example_en: string | null;
    example_gap: string | null;
    speech_text: string | null;
    explanation: Localized | null;
    evidence: string | null;
    instruction: Localized | null;
    prompt_en: string | null;
  };
  options: string[];
  tiles: string[];
  /** вид ответа: none — только «Понятно»/«Знаю это» (intro); choice — индекс; text — ввод (≤ 200); order — порядок tiles/options */
  answer_kind: "none" | "choice" | "text" | "order";
  hints: Array<"first_letter" | "reveal">; // check_item — []
  hints_used: Array<"first_letter" | "reveal">;
  voice: "en-GB" | "en-US";
}

/** POST /v1/memory/review-sessions/{id}/tasks/{task_id} ReviewAnswer → ReviewTaskResult. Повтор — тот же результат.
 *  intro: {} («Понятно») или {known: true} («Знаю это»). */
export interface ReviewAnswer {
  choice?: number;
  text?: string; // ≤ 200
  order?: number[];
  known?: boolean;
}
/** POST …/tasks/{task_id}/hint {kind: "first_letter" | "reveal"} → ReviewHint. reveal = «Не помню» (ответ показан,
 *  оценка again). check_item → 409 HINTS_NOT_ALLOWED. */
export interface ReviewHint {
  kind: "first_letter" | "reveal";
  text: string; // первая буква («r…») или ответ
}
export interface ReviewTaskResult {
  /** check_item — null до конца блока проверки */
  result: "correct" | "almost" | "incorrect" | null;
  correct_answer: string | null; // кроме check_item
  /** когда эта карточка вернётся (дни); null — проверка, intro или known */
  next_review_in_days: number | null;
  /** карточка с ошибкой вернётся в конце этой сессии */
  requeued: boolean;
  /** конец блока проверки: итог по каждому заданию */
  check_result: { passed: boolean; correct: number; total: number;
                  items: Array<{ prompt_en: string; your_answer: string | null; correct_answer: string; correct: boolean }> } | null;
  next: ReviewTask | null; // null — все задания пройдены, POST …/finish
}

/** POST /v1/memory/review-sessions/{id}/finish → ReviewSummary (повтор — тот же итог). */
export interface ReviewSummary {
  session_id: string;
  status: "completed" | "expired" | "cancelled";
  minutes: number;
  reviewed: number; // карточек с оценкой
  correct: number; // с первого раза верно (good/hard)
  again: number;
  new_learned: number;
  checks: Array<{ skill_title: Localized; stage: "d7" | "d30"; passed: boolean;
                  /** d30 пройдена — навык «закреплён» */ skill_retained: boolean }>;
  next_due_at: string | null;
  due_tomorrow: number;
}

// ---------- Перевод по тапу ----------
/** POST /v1/memory/translate TranslateRequest → WordGloss. Только слово/выражение из этого опубликованного текста
 *  (422 WORD_NOT_IN_CONTENT); свободный ввод не переводится. Источник: словарь курса → перевод ИИ (помечен). */
export interface TranslateRequest {
  text: string; // ≤ 60
  content: ContentRef;
}
export interface WordGloss {
  text: string;
  lemma: string | null;
  part_of_speech: PartOfSpeech | null;
  /** null — перевода нет (ИИ недоступен или перевод отклонён методистом): показать перевод предложения */
  gloss: Localized | null;
  source: GlossarySource | null;
  /** «Перевод сделан ИИ и проверяется методистом» (source ai, ещё не проверен) */
  ai_unreviewed: boolean;
  note: Localized | null;
  in_dictionary: string | null; // card_id
  reason: "not_available" | null;
}

// ---------- Произношение (APP-ADV-01; APP-VOICE-04 — микрофон по потребности) ----------
/** POST /v1/memory/pronunciation?target=<card:<card_id> | sentence:<kind>:<key>:<version>:<locator>>
 *  Тело — audio/wav (PCM 16 бит, моно, 16 000 Гц, 0,5..15 с, ≤ 600 000 байт) → PronunciationView.
 *  Эталонный текст подставляет сервер (карточка или предложение контента). Аудио не сохраняется.
 *  403 VOICE_CONSENT_REQUIRED {who}; 422 AUDIO_INVALID {reason: format | too_short | too_long | too_large};
 *  503 SPEECH_UNAVAILABLE; 429 RATE_LIMITED (20 за 10 минут). */
export interface PronunciationView {
  attempt_id: string | null; // null — unavailable
  status: "ok" | "insufficient_evidence" | "unavailable";
  reference_text: string;
  /** разборчивость, не «акцент» */
  intelligibility: "clear" | "mostly_clear" | "needs_practice" | null;
  score: number | null; // 0..100 (общий балл произношения), null — не оценено
  words: Array<{ word: string; accuracy: number | null; error_type: PronunciationErrorType }>;
  tips: Array<{ word: string; text: string }>; // ≤ 2, на языке интерфейса
  /** insufficient_evidence: «Не удалось оценить — говорите ближе к микрофону»; unavailable — «Сейчас недоступно» */
  message: Localized | null;
}

// ---------- Согласие на запись голоса для детского профиля ----------
/** PUT /v1/learners/{learner_id}/voice-consent VoiceConsentRequest → LearnerSummary. Только аккаунт 18+ (опекун
 *  ребёнка, из своего профиля), со своим действующим согласием. 403 ADULT_REQUIRED; 404 LEARNER_NOT_FOUND (чужой).
 *  Своё согласие (аккаунт) — POST /v1/profile/consent с целью voice_recording. */
export interface VoiceConsentRequest {
  granted: boolean;
}

// ---------- Чтение (практика) ----------
/** GET /v1/practice/readings?level=&cursor= → Page<ReadingCard> (по аудитории активного ученика, пара курса) */
export interface ReadingCard {
  reading_id: string;
  title: Localized;
  level: Band;
  topics: TopicCode[];
  est_minutes: number;
  word_count: number;
  /** последняя сессия чтения: доля верных ответов */
  last_result: { correct: number; total: number; finished_at: string } | null;
}

/** GET /v1/practice/readings/{id} → ReadingView (без ответов на вопросы).
 *  POST /v1/practice/readings/{id}/sessions (Idempotency-Key) → LessonSession (201, kind "reading"); дальше — общие
 *  маршруты сессий спринта 4: шаг "reading" (StepReading), затем вопросы (LessonStep type "item", graded_later), "done",
 *  POST /finish → LessonSummary (practice_only; навыки не меняются). */
export interface ReadingView {
  reading_id: string;
  version: number;
  title: Localized;
  level: Band;
  voice: "en-GB" | "en-US";
  paragraphs: Array<{ p_id: string; sentences: Array<{ s_id: string; text_en: string; gloss: Localized }> }>;
  /** подсвеченные слова: перевод по тапу берётся из словаря курса (POST /v1/memory/translate) */
  glossary: Array<{ en: string; gloss: Localized; note: Localized | null; in_dictionary: string | null }>;
  questions_count: number;
  question_types: ReadingQuestionType[];
  est_minutes: number;
}
