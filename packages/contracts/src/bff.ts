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
}

export interface SecurityState {
  /** Код родителя (PIN 4/6 цифр). Нужен для перехода в детский профиль и обратно, покупок, удаления. */
  pin_enabled: boolean;
  pin_length: 4 | 6 | null;
  biometric_enabled: boolean;
  pin_required: boolean;
  locked_until: string | null;
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
 *  POST /v1/profile/security/pin/reset-confirm {code, new_pin} → SessionResponse (прежние сессии отозваны).
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
 *   - voice_recording — запись голоса (уроки, спринт 4).
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
  | "home" | "lessons" | "review" | "progress" | "profile" | "schedule" | "notifications" | "family" | "support" | "news";
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
