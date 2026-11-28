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
  /** start_param из initData, если был: inv_<token> | invite_<invite_id> | gc_<token> | ticket_TCK-NNNN | route_<route>;
   *  спринт 7: duel_<duel_id> — карточка дуэли, room_<room_id> — парный урок */
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
  /** спринт 7: игра и лиги — значки, рост героя, спасённая серия, итоги лиги, дуэли (по умолчанию включена;
   *  выключена — уведомления остаются в центре без Telegram) */
  game: boolean;
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
 *     открыть и посмотреть приглашение можно после принятия terms и privacy; спринт 7 — также друзья, заявки, общая
 *     лига, дуэли и парные уроки (с членами семьи — тоже), жалобы;
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
  /** текущая неделя пн…вс. frozen (спринт 6) — день графика без занятия, закрытый заморозкой серии: missed остаётся
   *  true, серия не рвётся */
  week: Array<{ local_date: string; scheduled: boolean; done: boolean; missed: boolean; frozen: boolean }>;
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

/** game (спринт 7) — игра и лиги: значки, рост героя, спасённая серия, итоги лиги, дуэли */
export type NotificationCategory = "reminders" | "missed" | "social" | "support" | "product" | "service" | "game";

export interface InboxItem {
  notification_id: string;
  category: NotificationCategory;
  title: string; // на языке ученика
  body: string;
  /** куда ведёт: invite_<invite_id> | ticket_TCK-NNNN | route_<route> | duel_<duel_id> | room_<room_id> (спринт 7);
   *  null — никуда */
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

/** member_id (спринт 7) — тот же непрозрачный идентификатор, что в социальном API: по нему ученик семьи вызывает члена
 *  семьи на дуэль и приглашает в парный урок (детям 6–13 — только так: друзей у них нет). user_id остаётся для
 *  управления своей семьёй (спринт 1); в социальные маршруты передаётся только member_id. */
export interface Family {
  family_id: string;
  members: Array<{ user_id: string; member_id: MemberId; display_name: string; role: "owner" | "adult" | "teen" | "child";
                   is_me: boolean }>;
}
/** GET /v1/family → Family | 204 (семьи нет) */

// ---------- «Что нового» и новости (experience-config) ----------

export type ReleaseNoteRoute =
  | "home" | "lessons" | "review" | "progress" | "profile" | "schedule" | "notifications" | "family" | "support" | "news"
  // спринт 3 (release-notes.json)
  | "diagnostics" | "plan" | "skills" | "scenarios" | "media" | "media_requests" | "languages"
  // релиз 6.1: игра (спринт 6) — герои, магазин, значки, история, настройки; словарь и чтение (спринт 5)
  | "heroes" | "shop" | "badges" | "game_history" | "game_settings" | "dictionary" | "reading"
  // спринт 7: друзья (заявки, блокировки, санкции), лиги недели, дуэли, рефералы
  | "friends" | "leagues" | "duels" | "referrals"
  // спринт 8: «Подписка» (за Stars) и «Купить тилы» (за Stars; детскому профилю экран без цен)
  | "subscription" | "til_shop";
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
  /** релиз 6.1: ключ иллюстрации из каталога release-notes.json (`illustrations`, формат ^[a-z0-9][a-z0-9-]{0,31}$) —
   *  картинка 16:9 сверху первой карточки заметки, файл Mini App `/whatsnew/<key>.webp`; null — без картинки */
  illustration: string | null;
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
  /** спринт 8 (пэйвол, BILLING_ENFORCED): урок или сценарий 14+ идёт «вариантами» (ai_mode choices) не из-за сбоя ИИ, а
   *  по тарифу — плашка «Уроки с ИИ — в подписке»; null — ИИ не закрыт тарифом (или пэйвол выключен) */
  ai_locked: AiLock | null;
  /** спринт 8: ИИ-минут осталось у аккаунта после удержания на это занятие («ИИ: осталось N мин»); null — занятие без
   *  удержания (без ИИ, ребёнок 6–13, пэйвол выключен) */
  ai_minutes_left: number | null;
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
   *  listen_choice — speech_text (озвучить через /v1/speech; это и есть стимул задания на слух — принятое отклонение
   *  от «ключа нет до ответа»: текст виден только в инструментах разработчика), options (английские); typed — gloss, example_gap
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

// =====================================================================================================================
// Спринт 6 — игра и герои (APP-GAME-01…07, APP-PROG-01, APP-PROG-03)
// Всё игровое — gamification через telegram-bff (/v1/game/*), у активного ученика (lrn). Игра не меняет уровень языка,
// навыки, план и сроки повторения. XP и тилы начисляются сервером по событиям занятий — клиент их не задаёт.
// Тилы за деньги — спринт 8 (раздел «Спринт 8»): purchase_available — можно купить пакет тилов за Stars (продажи
// включены, право платить, есть пакет с ценой в Stars; детский профиль — false); иначе экран без кнопки покупки.
// Общие коды: 503 GAME_UNAVAILABLE (игровой блок скрыть, учёба работает); 404 HERO_NOT_FOUND | ITEM_NOT_FOUND;
// 409 HERO_NOT_AVAILABLE; 409 INSUFFICIENT_TILS {price, balance, missing, purchase_available: boolean} (спринт 8 —
// вычисляет telegram-bff, как GameSummary.purchase_available);
// 409 ALREADY_OWNED; 409 FREEZE_STOCK_FULL {max}; 410 ITEM_NOT_AVAILABLE; 409 NOT_OWNED;
// 422 IDEMPOTENCY_KEY_REUSED.
// =====================================================================================================================

export type GameCurrency = "xp" | "til" | "freeze";
/** спринт 7: duel — XP за дуэль; pair_lesson — XP за вклад в парный урок; league_prize — приз общей лиги (тилы);
 *  referral_bonus — награда пригласившему по реферальной кампании; referral_welcome — приглашённому */
export type GameReason =
  | "lesson" | "scenario" | "media" | "reading" | "review" | "skill_demonstrated" | "skill_retained"
  | "quest" | "quest_bonus" | "registration_bonus" | "referral_bonus" | "streak_freeze" | "shop" | "manual"
  | "reversal" | "purchase"
  | "duel" | "pair_lesson" | "league_prize" | "referral_welcome";
export type HeroLine = "robot" | "pet" | "human";
export type HeroStage = 1 | 2 | 3;
export type QuestKind =
  | "lesson_complete" | "review_cards" | "reading_complete" | "scenario_complete" | "media_complete" | "xp_earned"
  | "skill_confirmed";
export type GameAction = "lesson" | "scenario" | "media" | "reading" | "review" | "skill" | "quest";
export type ShopItemKind = "background" | "hero_frame" | "streak_freeze";

/** Картинка: url — GET /v1/game/assets/{asset_id}/{sha256} (без авторизации, неизменяемая; 304 по If-None-Match;
 *  404 ASSET_NOT_FOUND — нет картинки или sha не совпал) */
export interface GameImage {
  asset_id: string;
  url: string;
  width: number;
  height: number;
}

export interface GameSettings {
  /** тратить заморозку автоматически за пропущенный день графика */
  auto_freeze: boolean;
  /** не выпускать задания дня */
  quests_hidden: boolean;
  /** quiet — без анимаций и конфетти (детям по умолчанию) */
  celebrations: "full" | "quiet";
  /** уведомления о значках и росте героя (о спасённой серии приходят всегда) */
  game_notifications: boolean;
  /** спринт 7: участие в общей лиге недели (14+, только ник; по умолчанию false). Включение: 409 NICKNAME_REQUIRED
   *  (ник не задан); 403 SOCIAL_RESTRICTED {until}; 403 FRIENDS_NOT_ALLOWED {reason}; 403 CONSENT_REQUIRED
   *  {purpose: "social"}; детскому профилю — 403 KIDS_NOT_ALLOWED. Выключение — всегда, со следующей недели группа
   *  не назначается (текущая неделя доигрывается без строки ученика в рейтинге). */
  league_opt_in: boolean;
}

export interface HeroStageView {
  stage: HeroStage;
  name: Localized;
  image: GameImage;
  /** сколько подтверждённых навыков нужно для ступени */
  skills_required: number;
}

export interface HeroView {
  code: string; // "robot_0" … "human_2"
  line: HeroLine;
  name: Localized;
  tagline: Localized;
  stages: HeroStageView[];
}

/** Герой ученика: ступень общая для всех героев, растёт только за подтверждённые навыки */
export interface MyHero {
  code: string;
  name: Localized;
  stage: HeroStage;
  stage_name: Localized;
  image: GameImage;
  confirmed_skills: number;
  /** навыков до следующей ступени; null — последняя ступень */
  next_stage_at: number | null;
}

export interface Quest {
  slot: 1 | 2 | 3;
  code: string;
  kind: QuestKind;
  target: number;
  progress: number;
  status: "active" | "completed" | "expired";
  reward: { xp: number; til: number };
}

export interface DailyQuests {
  local_date: string;
  /** скрыты в настройках — items пусто */
  hidden: boolean;
  items: Quest[];
  all_done_bonus: { xp: number; til: number };
  bonus_received: boolean;
}

export interface ActiveGameEvent {
  event_id: string;
  title: Localized;
  description: Localized;
  ends_at: string;
  multipliers: Array<{ action: GameAction; currency: "xp" | "til"; factor: number }>;
}

/** GET /v1/game/summary → GameSummary (главная, профиль). Задания дня выпускаются при первом запросе дня. */
export interface GameSummary {
  level: number;
  xp_total: number;
  /** XP на начало текущего уровня и порог следующего (null — последний уровень) */
  xp_level_start: number;
  xp_next_level: number | null;
  til_balance: number;
  freeze_stock: number;
  freeze_max: number;
  freeze_price_til: number;
  /** null — герой ещё не выбран (показать выбор) */
  hero: MyHero | null;
  quests: DailyQuests;
  events: ActiveGameEvent[];
  equipment: { background: ShopItemRef | null; frame: ShopItemRef | null };
  settings: GameSettings;
  /** спринт 8: «Купить тилы» за Stars доступно — sales_enabled ∧ can_pay ∧ есть пакет тилов с ценой в Stars
   *  (вычисляет telegram-bff по каталогу billing; детский профиль — false; billing недоступен — false) */
  purchase_available: boolean;
}

export interface ShopItemRef {
  code: string;
  kind: ShopItemKind;
  title: Localized;
  image: GameImage | null;
  /** ключи токенов темы для фона/рамки (не CSS) */
  theme: { bg: string; accent: string } | null;
}

/** GET /v1/game/heroes → HeroesResponse (детям первыми — дракончики) */
export interface HeroesResponse {
  items: HeroView[];
  selected: string | null;
  stage: HeroStage;
}
/** PUT /v1/game/hero {hero_code} → GameSummary. Смена бесплатна, XP и ступень сохраняются. */
export interface SelectHeroRequest {
  hero_code: string;
}

/** GET /v1/game/quests → DailyQuests */

export interface BadgeView {
  code: string; // first_lesson, streak_7, skills_10, reviews_100, readings_10, skill_retained, first_freeze, together_1…
  title: Localized;
  description: Localized;
  image: GameImage | null;
  earned_at: string | null;
  /** основание (выдан) или прогресс (не выдан). together (спринт 7, значок together_1 «Вместе», APP-SOC-06) — парные
   *  уроки с достигнутой общей целью и вкладом каждого участника */
  basis: { metric: "lessons" | "streak" | "skills" | "skill_retained" | "reviews_cards" | "readings" | "freeze"
    | "together"; value: number; threshold: number };
}
/** GET /v1/game/badges → BadgesResponse (выданные первыми) */
export interface BadgesResponse {
  items: BadgeView[];
}

export interface ShopItemView extends ShopItemRef {
  description: Localized;
  price_til: number;
  owned: boolean;
  equipped: boolean;
  can_buy: boolean;
  /** почему нельзя купить: owned | freeze_full | not_enough_tils */
  reason_unavailable: "owned" | "freeze_full" | "not_enough_tils" | null;
  available_until: string | null;
}
/** GET /v1/game/shop → ShopResponse */
export interface ShopResponse {
  items: ShopItemView[];
  til_balance: number;
  freeze_stock: number;
  freeze_max: number;
}

/** POST /v1/game/shop/purchases (Idempotency-Key обязателен) → PurchaseResult. Повтор ключа — тот же ответ. */
export interface PurchaseRequest {
  item_code: string;
}
export interface PurchaseResult {
  purchase_id: string;
  item_code: string;
  price_til: number;
  til_balance: number;
  freeze_stock: number;
  purchased_at: string;
}

/** PUT /v1/game/equipment → GameSummary. null — снять. 409 NOT_OWNED */
export interface EquipmentRequest {
  background_code: string | null;
  frame_code: string | null;
}

export interface GameOperation {
  op_id: string;
  currency: GameCurrency;
  amount: number;
  reason: GameReason;
  /** урезано дневным лимитом */
  capped: boolean;
  /** множитель события недели (1 — без события) */
  multiplier: number;
  status: "confirmed" | "reversed";
  created_at: string;
}
/** GET /v1/game/history?currency=&cursor= → Page<GameOperation> (новые сверху, по 30). Ручные операции поддержки —
 *  reason "manual", без комментария сотрудника. */

/** GET /v1/game/rewards?source_session_id=<uuid> → SessionRewards. Награды начисляются по событиям асинхронно:
 *  pending — опрашивать каждые 1.5 с, до 8 раз; none — наград не было. */
export interface SessionRewards {
  status: "pending" | "ready" | "none";
  operations: GameOperation[];
  level_up: { from: number; to: number } | null;
  hero_stage_up: { from: HeroStage; to: HeroStage } | null;
  badges: BadgeView[];
  quests_completed: Quest[];
}

/** GET /v1/game/settings → GameSettings; PATCH /v1/game/settings (Partial<GameSettings>) → GameSettings */

// =====================================================================================================================
// Спринт 7 — социальное (APP-SOC-01…10, APP-REF-01…04)
// Где что: профиль сообщества, друзья, блокировки, жалобы, санкции, рефералы — social (/v1/community, /v1/friends/*,
// /v1/blocks, /v1/complaints, /v1/sanctions, /v1/referrals); лиги недели и дуэли — gamification (/v1/game/leagues*,
// /v1/game/duels*); задания дуэли и парные комнаты — lessons (/v1/duel-sessions*, /v1/pair-rooms/*). Всё — у активного
// ученика (lrn). Социальное не меняет учёбу: лиги и дуэли дают только игровые награды, учебное состояние меняет
// независимый оценщик по индивидуальным доказательствам каждого ученика.
// Приватность (APP-SOC-09): другой ученик виден только как member_id (непрозрачный стабильный идентификатор), ник,
// герой, XP недели, место и разрешённые значки. user_id, имени, Telegram, возраста, ответов, ошибок и покупок других
// учеников в API нет; чужой отчёт, реплики вне своей комнаты и ошибки не показываются.
// Аудитории: дети 6–13 — без друзей, заявок, жалоб, блокировок и общей лиги; лига, дуэль и парный урок — только с
// членами своей семьи, парный урок — только выбор реплик. Подросток 14–17 — социальное после согласия родителя.
// Общие коды: 403 FRIENDS_NOT_ALLOWED {reason: "kids" | "guardian_consent"}; 403 CONSENT_REQUIRED {purpose: "social"};
// 403 SOCIAL_RESTRICTED {until: string | null} — действует санкция social_ban (until null — бессрочно; уже идущие
// дуэль и комната доигрываются); 403 BLOCKED — блокировка между учениками в любую сторону (кто заблокировал, не
// раскрывается); 403 PARTNER_NOT_ALLOWED — не друг и не член семьи (детям — только семья); 403 KIDS_NOT_ALLOWED;
// 404 MEMBER_NOT_FOUND — участника нет или он недоступен (неотличимо); 503 UPSTREAM_UNAVAILABLE {service} — social,
// gamification или lessons недоступен (социальный блок скрыть, учёба работает); 503 GAME_UNAVAILABLE — как в спринте 6;
// 422 IDEMPOTENCY_KEY_REUSED.
// Ссылки (start_param, InboxItem.startapp): route_friends | route_leagues | route_duels | route_referrals;
// duel_<duel_id> — карточка дуэли; room_<room_id> — парный урок (приглашение, комната, отчёт).
// Лимиты (rate-limit-policies.json): tg.social.search 30/мин, tg.social.write 30/мин, tg.social.complaint 10/сутки,
// tg.duel.write 20/мин, tg.room.write 60/мин, tg.room.poll 240/мин, tg.room.audio 30/10 мин; чтение /v1/game/* —
// tg.game.read (спринт 6).
// =====================================================================================================================

/** Другой ученик в API ученика: `mb_` + 22 символа base64url (HMAC-SHA256 от user_id, INTERNAL_API §0). Стабилен,
 *  не расшифровывается клиентом и telegram-bff. */
export type MemberId = string;

// ---------- Профиль сообщества (APP-SOC-01/02) ----------

/** Почему друзья недоступны: kids — детский профиль 6–13 (только семья); guardian_consent — подросток без согласия
 *  родителя; consent — не принята цель согласия social */
export type FriendsUnavailableReason = "kids" | "guardian_consent" | "consent";

export interface SocialRestrictions {
  /** действует запрет социальных действий: заявки в друзья, вызовы на дуэль, приглашения в парный урок, общая лига */
  social_ban: boolean;
  /** конец запрета; null — запрета нет (social_ban=false) или он бессрочный (social_ban=true) */
  social_ban_until: string | null;
}

/** GET /v1/community → CommunityProfile (создаётся при первом обращении; ник — null, код друга — новый) */
export interface CommunityProfile {
  member_id: MemberId;
  /** null — ник не задан: дружить можно (по коду), в общую лигу нельзя */
  nickname: string | null;
  /** TH-XXXX-XXXX (алфавит без 0/O/1/I); виден только владельцу */
  friend_code: string;
  /** скрыт игровой профиль: ученика нет в лигах друзей и семьи (себе виден), в общей лиге не участвует */
  game_profile_hidden: boolean;
  restrictions: SocialRestrictions;
  /** когда можно сменить ник (раз в 7 дней; первый ник — сразу); null — можно сейчас */
  nickname_change_available_at: string | null;
  /** друзья и заявки доступны (детям — нет: лиги, дуэли и парные уроки только с семьёй) */
  friends_available: boolean;
  friends_unavailable_reason: FriendsUnavailableReason | null;
}

/** PUT /v1/community/nickname NicknameRequest → CommunityProfile. 409 NICKNAME_TAKEN (без учёта регистра);
 *  422 NICKNAME_INVALID {reason: "length" | "chars" | "forbidden"}; 429 NICKNAME_COOLDOWN {until}. Тот же ник — 200
 *  без смены. */
export interface NicknameRequest {
  nickname: string; // 3..20: буквы RU/UZ/EN, цифры, «_»
}
/** POST /v1/community/friend-code/rotate → CommunityProfile: новый код, прежний сразу перестаёт находиться.
 *  429 FRIEND_CODE_LIMIT {until} — не чаще 3 раз в сутки.
 *  PATCH /v1/community CommunityPatch → CommunityProfile. */
export interface CommunityPatch {
  game_profile_hidden?: boolean;
}

// ---------- Поиск, заявки, друзья, блокировки (APP-SOC-01/02) ----------

/** none — не друзья; request_out / request_in — есть pending-заявка от меня / ко мне; self — это я */
export type MemberRelation = "none" | "friend" | "request_out" | "request_in" | "self";

/** GET /v1/friends/search?q= → MemberSearchResult: 0 или 1 карточка. q — точный код друга (TH-…, без учёта дефисов и
 *  регистра) или точный ник (без учёта регистра), 3..20 знаков. Не находятся: заблокированные в любую сторону, дети
 *  6–13, ученики, которым друзья недоступны. Ничего не найдено — 200 {items: []}. Лимит tg.social.search. */
export interface MemberCard {
  member_id: MemberId;
  nickname: string | null;
  relation: MemberRelation;
  /** pending-заявка между нами (request_in / request_out) — принять или отозвать прямо из карточки; иначе null */
  request_id: string | null;
}
export interface MemberSearchResult {
  items: MemberCard[];
}

export type FriendRequestStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";

/** POST /v1/friends/requests FriendRequestCreate (Idempotency-Key обязателен) → FriendRequestView (201). Встречная
 *  pending-заявка — это принятие: 200, status accepted. 409 ALREADY_FRIENDS | REQUEST_EXISTS | FRIENDS_LIMIT
 *  {limit: 200}; 429 REQUESTS_LIMIT (20 заявок в сутки); 403 BLOCKED | SOCIAL_RESTRICTED | FRIENDS_NOT_ALLOWED;
 *  404 MEMBER_NOT_FOUND; себе — 422 VALIDATION_ERROR.
 *  GET /v1/friends/requests?direction=in|out&cursor= → Page<FriendRequestView> — только pending, новые сверху.
 *  POST /v1/friends/requests/{request_id}/accept | /decline (входящая) | /cancel (исходящая) → FriendRequestView;
 *  повтор с тем же исходом — 200; иначе 409 REQUEST_STATE {status}; принять при 200 друзьях — 409 FRIENDS_LIMIT;
 *  404 REQUEST_NOT_FOUND (чужая заявка неотличима). Заявка истекает через 30 дней (expired).
 *  Приглашение Telegram kind friend (спринт 1) по-прежнему создаёт дружбу сразу при принятии. */
export interface FriendRequestCreate {
  member_id: MemberId;
}
export interface FriendRequestView {
  request_id: string;
  direction: "in" | "out";
  member_id: MemberId;
  nickname: string | null;
  status: FriendRequestStatus;
  created_at: string;
  decided_at: string | null;
}

/** GET /v1/friends?cursor= → Page<FriendView> (по нику; без ника — в конце). Чужой код друга не показывается.
 *  DELETE /v1/friends/{member_id} → 204 (повтор — 204; второй стороне без уведомления). */
export interface FriendView {
  member_id: MemberId;
  /** null — ник не задан: показать «Друг» */
  nickname: string | null;
  since: string;
}

/** POST /v1/blocks BlockRequest → BlockView (201; повтор — 200). Блокировка односторонняя: удаляет дружбу, отменяет
 *  pending-заявки, вызовы на дуэль и приглашения в парный урок между учениками в обе стороны, скрывает учеников друг
 *  от друга в поиске и лигах друзей. Заблокированный не узнаёт о блокировке: его новые заявки, вызовы и приглашения —
 *  403 BLOCKED. DELETE /v1/blocks/{member_id} → 204 (дружба не возвращается). GET /v1/blocks → BlocksResponse.
 *  Детский профиль — 403 KIDS_NOT_ALLOWED. */
export interface BlockRequest {
  member_id: MemberId;
}
export interface BlockView {
  member_id: MemberId;
  nickname: string | null;
  created_at: string;
}
export interface BlocksResponse {
  items: BlockView[];
}

// ---------- Жалобы, санкции, обжалование (APP-SOC-10) ----------

export type ComplaintSubjectKind = "user" | "nickname" | "friend_request" | "invite" | "duel" | "pair_room";
export type ComplaintReason = "spam" | "abuse" | "inappropriate_nickname" | "cheating" | "other";

/** POST /v1/complaints ComplaintRequest (Idempotency-Key обязателен) → ComplaintResult (201). Повтор на ту же цель
 *  (member_id + subject_kind + subject_id) за 24 ч — 200 тот же case_id. 429 COMPLAINTS_LIMIT (10 в сутки; лимит
 *  tg.social.complaint); 404 MEMBER_NOT_FOUND; детский профиль — 403 KIDS_NOT_ALLOWED. subject_id обязателен для
 *  friend_request (request_id), invite (invite_id или room_id приглашения в парный урок), duel (duel_id), pair_room
 *  (room_id); для user и nickname — null (иначе 422 VALIDATION_ERROR). block=true — сразу блокировка (как
 *  POST /v1/blocks). Жалоба создаёт дело модерации: модератор видит только предмет жалобы, не переписку. Итог приходит
 *  уведомлением complaint_resolved без подробностей. */
export interface ComplaintRequest {
  member_id: MemberId;
  subject_kind: ComplaintSubjectKind;
  subject_id: string | null;
  reason: ComplaintReason;
  comment?: string; // ≤ 500
  block?: boolean;
}
export interface ComplaintResult {
  case_id: string;
  created_at: string;
  /** блокировка поставлена (block=true) */
  blocked: boolean;
}

/** warning — предупреждение; social_ban — запрет социальных действий на 1–30 дней или бессрочно; nickname_reset —
 *  ник сброшен модератором: сброшенный ник запрещён всем, новый можно задать через 7 дней */
export type SanctionKind = "warning" | "social_ban" | "nickname_reset";
export type SanctionAppealStatus = "open" | "upheld" | "overturned";

/** GET /v1/sanctions → SanctionsResponse: активные и прошлые санкции ученика (новые сверху).
 *  POST /v1/sanctions/{sanction_id}/appeal SanctionAppealRequest (Idempotency-Key обязателен) → SanctionView (201).
 *  Одно обжалование на санкцию: 409 APPEAL_EXISTS; снятая санкция — 409 SANCTION_STATE; 404 SANCTION_NOT_FOUND.
 *  Решение приходит уведомлением appeal_decided; overturned снимает санкцию. */
export interface SanctionView {
  sanction_id: string;
  kind: SanctionKind;
  /** основание решения модератора (≤ 500) — пишется для ученика; кто решал, не показывается */
  basis: string;
  decided_at: string;
  /** social_ban: конец запрета, null — бессрочно; warning и nickname_reset — null */
  until: string | null;
  active: boolean;
  /** снята (модератором или по обжалованию) */
  revoked_at: string | null;
  appeal: SanctionAppealView | null;
  can_appeal: boolean;
}
export interface SanctionAppealView {
  appeal_id: string;
  status: SanctionAppealStatus;
  text: string;
  created_at: string;
  decided_at: string | null;
  /** ответ модератора на обжалование (≤ 500) — пишется для ученика */
  decision_note: string | null;
}
export interface SanctionAppealRequest {
  text: string; // 10..1000
}
export interface SanctionsResponse {
  items: SanctionView[];
}

// ---------- Рефералы (APP-REF-01…04) ----------
// Реферальная ссылка — приглашение kind referral (POST /v1/invites, спринт 1). Засчитывается по активной кампании:
// диагностика, ≥ min_lessons зачётных уроков (kind lesson) не меньше чем в min_days разных дней за window_days от
// принятия. Подозрительное удерживается на проверке оператора. Правила антифрода ученику не раскрываются.

/** invited → diagnostic_done → learning → review (проверка оператора) → qualified → rewarded; rejected, expired,
 *  capped (лимит пригласившего в месяц) — без награды */
export type ReferralStatus =
  | "invited" | "diagnostic_done" | "learning" | "review" | "qualified" | "rewarded" | "rejected" | "expired"
  | "capped";
/** Публичные причины отказа (без правил антифрода): not_new_user — приглашённый уже занимался; family_member — член
 *  семьи; window_expired — условия не выполнены вовремя; review_rejected — не прошёл проверку; monthly_cap — лимит
 *  наград в месяц */
export type ReferralRejectCode = "not_new_user" | "family_member" | "window_expired" | "review_rejected" | "monthly_cap";

export interface ReferralReward {
  freeze: number;
  til: number;
}

/** Исход начисления (ack gamification): rewarded — награда кампании начислена; legacy — награда была выдана раньше по
 *  правилу спринта 6 (status rewarded, reward null — без повторного «вы получили»); inviter_capped — награда
 *  пригласившему не начислена из-за месячного лимита (status capped, reject_code monthly_cap — показывать как «лимит
 *  месяца») */
export type ReferralRewardOutcome = "rewarded" | "legacy" | "inviter_capped";

export interface ReferralView {
  referral_id: string;
  /** ник приглашённого; null — не задан или ученик удалён */
  invitee_nickname: string | null;
  status: ReferralStatus;
  progress: {
    diagnostic: boolean;
    diagnostic_required: boolean;
    lessons: number;
    lessons_required: number;
    /** различные местные дни с зачётным уроком */
    days: number;
    days_required: number;
    /** до какого момента нужно выполнить условия */
    window_ends_at: string;
  };
  /** награда пригласившему по кампании: начислена (rewarded) или начисляется (qualified); иначе null (в т. ч. награда
   *  по правилу спринта 6 — reward_outcome legacy) */
  reward: ReferralReward | null;
  /** исход начисления; null — gamification ещё не подтвердила (до rewarded / capped по её лимиту) */
  reward_outcome: ReferralRewardOutcome | null;
  /** причина отказа; у перенесённого из прежней программы и истёкшего (legacy, status expired) — null: показывать
   *  «Приглашение по прежней программе», а не «окно истекло» */
  reject_code: ReferralRejectCode | null;
  /** приглашение по прежней программе (принято до спринта 7, условия и сроки — переходные) */
  legacy: boolean;
  accepted_at: string;
}

/** Условия активной кампании, понятные ученику (пороги проверки не раскрываются) */
export interface ReferralTerms {
  campaign_version: number;
  require_diagnostic: boolean;
  min_lessons: number;
  min_days: number;
  window_days: number;
  inviter_reward: ReferralReward;
  invitee_reward: ReferralReward;
  monthly_cap: number;
}

/** GET /v1/referrals?cursor= → ReferralsResponse (мои приглашённые, новые сверху). month — квалифицированные в текущем
 *  календарном месяце (Asia/Tashkent) против лимита. Детский профиль — 403 KIDS_NOT_ALLOWED. */
export interface ReferralsResponse extends Page<ReferralView> {
  terms: ReferralTerms;
  month: { qualified: number; cap: number };
}

// ---------- Лиги недели (APP-SOC-08/09, APP-GAME-07) ----------
// Неделя — понедельник 00:00 … воскресенье 24:00 Asia/Tashkent. XP недели — XP за занятия, задания, дуэли и парные
// уроки; ручные операции, призы и бонусы не считаются. Лига друзей и семейная — без призов; общая (14+, по желанию,
// только ник) — группы 20–30 участников одной пары и полосы уровня, призы тилами за 1–3 места. Закрытие недели
// атомарно, призы — один раз.

/** Полоса уровня (по последней диагностике; без диагностики — A0-A1) */
export type LeagueLevelBand = "A0-A1" | "A2" | "B1+";

export interface MemberHero {
  code: string;
  stage: HeroStage;
  image: GameImage;
}

export interface StandingRow {
  member_id: MemberId;
  /** общая лига — всегда ник; друзья и семья — ник или null (показать «Друг» / «Участник семьи») */
  nickname: string | null;
  /** null — герой не выбран */
  hero: MemberHero | null;
  xp: number;
  place: number;
  /** коды разрешённых значков (не связанные с ошибками), ≤ 3 */
  badges: string[];
  me: boolean;
}

export interface Standings {
  /** ≤ 50 строк по месту (при равенстве XP — кто раньше набрал) */
  rows: StandingRow[];
  /** моя строка, если она не вошла в rows; иначе null */
  me_row: StandingRow | null;
  participants: number;
  /** XP недели всех участников вместе — детям вместо мест («вместе набрали») */
  total_xp: number;
}

/** Почему общая лига недоступна: kids — детский профиль; guardian_consent — подросток без согласия родителя; consent —
 *  нет цели social; nickname_required — ник не задан; restricted — санкция social_ban; hidden — скрыт игровой профиль */
export type GeneralLeagueUnavailableReason =
  | "kids" | "guardian_consent" | "consent" | "nickname_required" | "restricted" | "hidden";

export interface GeneralLeague {
  /** GameSettings.league_opt_in */
  opt_in: boolean;
  available: boolean;
  unavailable_reason: GeneralLeagueUnavailableReason | null;
  pair_id: string | null;
  level_band: LeagueLevelBand | null;
  /** моя группа недели; null — не участвую (выключено, недоступно или группа назначится по tick) */
  group: Standings | null;
  /** тилы за 1, 2, 3 места (rules.league.prizes) */
  prizes: number[];
}

/** GET /v1/game/leagues → LeaguesView. Скрытый игровой профиль: себя ученик видит, другие его — нет. */
export interface LeaguesView {
  week: string; // понедельник недели, YYYY-MM-DD
  ends_at: string;
  /** null — детскому профилю (друзей нет) */
  friends: Standings | null;
  /** null — семьи нет */
  family: Standings | null;
  general: GeneralLeague;
}

/** GET /v1/game/leagues/history?cursor= → Page<LeagueResult> — мои итоги общей лиги (новые сверху, по последней
 *  версии итогов группы) */
export interface LeagueResult {
  week: string;
  pair_id: string;
  level_band: LeagueLevelBand;
  place: number;
  participants: number;
  xp: number;
  prize_til: number;
  /** приз удержан до решения администратора (аномалия в группе) */
  prize_held: boolean;
  /** версия итогов (переоценка администратором — новая версия) */
  version: number;
  closed_at: string;
}

// ---------- Дуэли (APP-SOC-07) ----------
// Асинхронная: вызов → принятие (24 ч) → оба проходят один набор из 10 закрытых заданий своей пары и полосы уровня
// (48 ч после принятия) → результат по серверной оценке. Время ответа на результат не влияет. Ставок нет: XP за победу,
// ничью и участие (не больше 3 наградных дуэлей в день). Только друзья 14+; детям — только внутри семьи.

export type DuelStatus = "challenged" | "declined" | "expired" | "accepted" | "finished" | "cancelled";

export interface DuelScore {
  correct: number;
  total: number;
}

export interface DuelResultView {
  /** с моей стороны */
  outcome: "win" | "loss" | "draw";
  /** техническая: соперник не сыграл до дедлайна */
  technical: boolean;
  /** null — не сыграл */
  my_score: DuelScore | null;
  opponent_score: DuelScore | null;
  /** моя награда XP (0 — исчерпан дневной лимит наградных дуэлей) */
  xp: number;
  /** версия результата (переоценка администратором — новая версия) */
  version: number;
}

export interface DuelView {
  duel_id: string;
  status: DuelStatus;
  role: "challenger" | "opponent";
  opponent: { member_id: MemberId; nickname: string | null; hero: MemberHero | null };
  pair_id: string;
  level_band: LeagueLevelBand;
  created_at: string;
  accept_deadline: string;
  /** после принятия: срок прохождения */
  play_deadline: string | null;
  /** моя сессия заданий (kind duel); null — ещё не начинал */
  my_session: { session_id: string; status: SessionStatus } | null;
  my_played: boolean;
  /** соперник уже прошёл задания (без счёта) */
  opponent_played: boolean;
  /** я — соперник, status challenged */
  can_accept: boolean;
  /** status accepted, я не закончил, дедлайн не прошёл */
  can_play: boolean;
  /** только status finished: счёт обоих — только после завершения */
  result: DuelResultView | null;
  finished_at: string | null;
}

/** POST /v1/game/duels DuelChallengeRequest (Idempotency-Key обязателен) → DuelView (201). Проверки: друзья (14+) или
 *  одна семья (с детьми), нет блокировки и санкций. 409 DUELS_LIMIT (≤ 3 активных вызова от ученика); 409 DUEL_EXISTS
 *  {duel_id} (≤ 1 активной дуэли между парой учеников); 409 LEVELS_INCOMPATIBLE (полосы уровня различаются больше чем
 *  на одну; при разнице в одну набор — по нижней); 403 BLOCKED | SOCIAL_RESTRICTED | PARTNER_NOT_ALLOWED |
 *  FRIENDS_NOT_ALLOWED; 404 MEMBER_NOT_FOUND; себе — 422 VALIDATION_ERROR. pair_id по умолчанию — активная пара.
 *  GET /v1/game/duels?status=active|finished&cursor= → Page<DuelView> (active — challenged и accepted).
 *  GET /v1/game/duels/{duel_id} → DuelView; 404 DUEL_NOT_FOUND (чужая неотличима).
 *  POST /v1/game/duels/{duel_id}/accept → DuelView (набор заданий выдаёт lessons синхронно; 503 DUEL_SET_UNAVAILABLE —
 *  дуэль остаётся challenged, можно повторить); POST /v1/game/duels/{duel_id}/decline → DuelView. Повтор с тем же
 *  исходом — 200; иначе 409 DUEL_STATE {status}. */
export interface DuelChallengeRequest {
  opponent_member_id: MemberId;
  pair_id?: string;
}

/** POST /v1/duel-sessions DuelSessionRequest (Idempotency-Key обязателен) → LessonSession (201, kind "duel"; повтор —
 *  200 та же сессия: одна на участника). Только участник принятой дуэли до play_deadline: 409 DUEL_CLOSED;
 *  404 DUEL_NOT_FOUND. Дальше — общие маршруты сессий спринта 4: этапы assessment → summary; шаги — LessonStep type
 *  "item" (graded_later=true, hint_available=false, без ИИ); POST /v1/sessions/{id}/steps/{step_id} → StepResult
 *  (feedback=null; повтор того же шага — тот же результат); POST /v1/sessions/{id}/finish → LessonSummary (evaluation
 *  null, skills [], can_review false: счёт — в DuelView после завершения дуэли). pause/resume — до дедлайна; cancel —
 *  409 SESSION_STATE (незаконченная к дедлайну сессия закрывается, неотвеченные задания — неверные). Сессия дуэли не
 *  участвует в правиле одной активной сессии: 409 SESSION_ACTIVE не возникает, /v1/sessions/active её не возвращает,
 *  в истории GET /v1/sessions её нет. Учёбу не меняет: в независимую оценку не идёт. Детскому профилю — та же
 *  дуэль (только с членом семьи). */
export interface DuelSessionRequest {
  duel_id: string;
}
/** GET /v1/duel-sessions/{session_id}/review → DuelReview — разбор своих ответов только после завершения дуэли;
 *  раньше — 409 DUEL_NOT_FINISHED. Ответы соперника не показываются никогда. */
export interface DuelReview {
  session_id: string;
  duel_id: string;
  score: DuelScore;
  items: Array<{ item_id: string; prompt_en: string; your_answer: string | null; correct_answer: string;
                 correct: boolean }>;
}

// ---------- Парный урок (APP-SOC-03…06) ----------
// Два ученика и ИИ-коуч (cooperative_lesson_coach) в сценарии каталога: роли A/B, ходы по очереди, у каждого своё время
// речи, свои доказательства в независимую оценку и свой отчёт. 14+ — с другом; 6–13 — только с членом семьи и только
// выбор реплик. Без ИИ (бюджет, аварийная остановка, недоступность) комната идёт по сценарию с выбором реплик. Голос —
// по согласию на запись голоса. Минуты учитываются, но не списываются (спринт 8). Переподключение в течение 3 минут
// продолжает ту же комнату без новой сессии и повторного учёта.

export type PairRoomStatus =
  | "invited" | "declined" | "expired" | "cancelled" | "waiting" | "in_progress" | "paused" | "finished"
  | "abandoned" | "stopped";
export type PairRole = "A" | "B";
/** free — свободный текст или голос; choices — выбор реплик (дети, ИИ недоступен) */
export type PairRoomMode = "free" | "choices";
/** completed — сценарий завершён или вышло время комнаты (20 минут в in_progress; цель — по team.goal_reached);
 *  participant_left — участник вышел и не вернулся за 3 минуты (оставшийся доиграл
 *  или вышел); inactivity — 10 минут без активности; stopped — остановлена администратором */
export type PairEndReason = "completed" | "participant_left" | "inactivity" | "stopped";
export type PairRoomEventKind =
  | "joined" | "left" | "offline" | "online" | "paused" | "resumed" | "roles" | "coach" | "turn" | "mode_changed"
  | "finished" | "stopped";

/** POST /v1/pair-rooms PairRoomInvite (Idempotency-Key обязателен) → PairRoomView (201). Проверки: друзья (14+) или одна
 *  семья; блокировки и санкции; детям — только choices. Спринт 8 (BILLING_ENFORCED): урок вдвоём 14+ без ребёнка в
 *  комнате приглашает только подписчик с функцией pair_lessons — иначе 403 SUBSCRIPTION_REQUIRED {feature:
 *  "pair_lessons", reason: SubscriptionRequiredReason}; billing недоступен — 503 BILLING_UNAVAILABLE; минуты — у
 *  пригласившего один раз за комнату (по времени работы коуча); приглашённому подписка не нужна (В8); комната с
 *  ребёнком бесплатна (В9). 409 ROOM_LIMIT {room_id} (≤ 1 активной комнаты на ученика);
 *  403 BLOCKED | SOCIAL_RESTRICTED | PARTNER_NOT_ALLOWED | FRIENDS_NOT_ALLOWED; 404 MEMBER_NOT_FOUND;
 *  404 LESSON_NOT_AVAILABLE (сценарий не опубликован или не для аудитории); 409 PAIR_NOT_AVAILABLE; start в прошлом
 *  или дальше 7 дней — 422 VALIDATION_ERROR. Без ответа: start now — 15 мин, запланированный — до start_at + 15 мин →
 *  expired.
 *  GET /v1/pair-rooms?status=active|finished&cursor= → Page<PairRoomView> (active — invited, waiting, in_progress,
 *  paused: мои приглашения в обе стороны и комнаты). GET /v1/pair-rooms/{room_id} → PairRoomView; 404 ROOM_NOT_FOUND
 *  (чужая неотличима).
 *  POST /v1/pair-rooms/{room_id}/accept | /decline (приглашённый, invited) → PairRoomView;
 *  POST /v1/pair-rooms/{room_id}/cancel (любой участник, invited или waiting) → PairRoomView (cancelled).
 *  Повтор с тем же исходом — 200; иначе 409 ROOM_STATE {status}.
 *  POST /v1/pair-rooms/{room_id}/join → PairRoomState (оба вошли → in_progress, коуч раздаёт роли и цель;
 *  повторный вход и возврат ≤ 3 мин — та же комната); POST …/heartbeat → 204 (каждые 10 с; без него 30 с — offline,
 *  в свой ход — paused); POST …/leave → PairRoomView. Неактивная комната — 409 ROOM_NOT_ACTIVE {status}. */
export interface PairRoomInvite {
  partner_member_id: MemberId;
  pair_id: string;
  scenario_id: string;
  /** "now" или время ISO-8601 не дальше 7 дней вперёд */
  start: string;
}

export interface PairRoomView {
  room_id: string;
  status: PairRoomStatus;
  /** я пригласил или меня пригласили */
  side: "inviter" | "invitee";
  partner: { member_id: MemberId; nickname: string | null; hero: MemberHero | null };
  pair_id: string;
  scenario: { scenario_id: string; title: Localized; level: Band };
  mode: PairRoomMode;
  start_at: string;
  /** ответить на приглашение до (invited); иначе null */
  respond_until: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  end_reason: PairEndReason | null;
  my_role: PairRole | null;
  can_accept: boolean;
  can_join: boolean;
  /** мои минуты в комнате: учитываются, не списываются (спринт 8) */
  minutes: number;
  report_available: boolean;
}

export interface PairRoomEvent {
  seq: number;
  kind: PairRoomEventKind;
  /** чей вход, выход, ход; null — коуч и система */
  role: PairRole | null;
  /** текст реплики (turn — ученика, coach — коуча, английский); видят только участники комнаты; иначе null */
  text: string | null;
  at: string;
}

/** GET /v1/pair-rooms/{room_id}/state?after_seq=N → PairRoomState — long-poll до 25 с: ответ сразу, если в ленте есть
 *  события новее N или изменился статус; иначе по истечении ожидания с events []. Лимит tg.room.poll. */
export interface PairRoomState {
  room_id: string;
  status: PairRoomStatus;
  /** последний seq ленты — следующий запрос after_seq */
  seq: number;
  /** события после after_seq, ≤ 50 */
  events: PairRoomEvent[];
  mode: PairRoomMode;
  my_role: PairRole | null;
  /** моя роль в сцене от коуча (английский, ≤ 120) */
  my_role_brief: string | null;
  /** общая цель команды (английский, ≤ 200) */
  team_goal: string | null;
  team_goal_progress: number; // 0..1
  next_speaker: PairRole | "both" | null;
  /** подсказка коуча к текущему ходу (английский, ≤ 300) и её перевод на язык ученика */
  prompt: string | null;
  prompt_gloss: string | null;
  /** варианты реплик для моего хода (choices), ≤ 3; иначе null */
  options: Array<{ choice_id: string; text_en: string }> | null;
  participants: Array<{ role: PairRole | null; me: boolean; network: "online" | "offline" }>;
  /** ИИ недоступен — комната идёт по сценарию с выбором реплик */
  ai_degraded: boolean;
  /** можно ответить голосом (согласие на голос, распознавание доступно) */
  voice_available: boolean;
  my_speaking_seconds: number;
}

/** POST /v1/pair-rooms/{room_id}/turns PairTurnRequest (Idempotency-Key обязателен) → PairRoomState. Ровно одно поле:
 *  text (≤ 300; детский профиль — 403 KIDS_NOT_ALLOWED), choice_id (из options) или audio_id. 409 NOT_YOUR_TURN;
 *  409 ROOM_NOT_ACTIVE {status}; повтор ключа — тот же ответ, без второго хода. */
export interface PairTurnRequest {
  text?: string;
  choice_id?: string;
  audio_id?: string;
}

/** POST /v1/pair-rooms/{room_id}/audio — тело audio/wav (PCM 16 бит, моно, 16 000 Гц, 0,5..15 с, ≤ 600 000 байт —
 *  как запись произношения спринта 5 и предел распознавания tts) → PairAudio. Аудио не хранится: распознанный текст
 *  показывается для подтверждения, ход — POST …/turns {audio_id} (audio_id живёт 5 минут, один раз). Длительность
 *  записи идёт в speaking_seconds. 403 VOICE_CONSENT_REQUIRED {who: "self" | "guardian"}; детский профиль — 403
 *  KIDS_NOT_ALLOWED (только выбор реплик); 422 AUDIO_INVALID {reason: format | too_short | too_long | too_large};
 *  503 SPEECH_UNAVAILABLE (перейти на текст); 409 NOT_YOUR_TURN; 409 ROOM_NOT_ACTIVE {status}; лимит tg.room.audio. */
export interface PairAudio {
  audio_id: string;
  text: string;
  duration_ms: number;
  expires_at: string;
}

/** GET /v1/pair-rooms/{room_id}/report → PairRoomReport — только свой (после завершения комнаты; раньше — 409
 *  ROOM_STATE {status}). Чужие реплики, ошибки и оценка не показываются. */
export interface PairRoomReport {
  room_id: string;
  scenario: { scenario_id: string; title: Localized };
  status: PairRoomStatus;
  end_reason: PairEndReason | null;
  ended_at: string | null;
  team: {
    goal_reached: boolean;
    progress: number; // 0..1
    /** общая безопасная похвала команде */
    summary: Localized | null;
  };
  me: {
    role: PairRole | null;
    /** false — «не участвовал»: без оценки и наград */
    contributed: boolean;
    turns: number;
    speaking_seconds: number;
    minutes: number;
    /** мои реплики (английский) */
    lines: Array<{ text: string; at: string }>;
    skills: Array<{ skill_id: string; title: Localized }>;
    /** 1–3 подсказки на языке ученика */
    tips: Localized[];
    /** моя оценка независимым оценщиком (GET /v1/evaluations/{id}); null — без вклада или ещё не готова */
    evaluation_id: string | null;
  };
}

// =====================================================================================================================
// Спринт 8 — подписка и покупки за Telegram Stars в Mini App (APP-BILL-01…04, APP-LESS-01, APP-VOICE-06, APP-SOC-03/05,
// APP-REF-03). Домен — billing через telegram-bff /v1/billing/* (канал miniapp: claim `chn` внутреннего токена).
// В Mini App продаётся ТОЛЬКО за Telegram Stars (решение владельца В1): цены — целые звёзды (XTR), провайдер —
// только "telegram_stars". Анти-стиринг: ни один ответ /v1/* не содержит сумм в сумах (тийинов), названий других
// способов оплаты, адреса сайта оплаты или ссылок на него; покупки вне Mini App видны только как статус подписки и
// минуты (GET /v1/billing/orders — только заказы Stars). Деньги — целые числа (ADR-0001).
// Платит только владелец аккаунта в своём профиле (lrn = аккаунт): 18+ или 14–17 с согласием родителя. Детский
// профиль цен и кнопок оплаты не видит (products: [], payer_required: true); ребёнку тилы покупает родитель из своего
// профиля (beneficiary_id). Подписка и минуты — на аккаунт: пул общий у аккаунта и его детских профилей.
// Подписка открывает уроки с ИИ (lesson, scenario в режиме full) и уроки вдвоём в пределах месячного лимита минут;
// без подписки учёба работает (базовый курс, повторения, чтение, игра; урок — «варианты» с плашкой ai_locked).
// Общие коды: 503 BILLING_UNAVAILABLE (покупки недоступны — учёба работает); 403 PAYER_REQUIRED (детский профиль,
// возраст неизвестен) | GUARDIAN_CONSENT_REQUIRED (14–17 без согласия родителя) | BENEFICIARY_NOT_ALLOWED;
// 409 PAYMENTS_DISABLED | PROVIDER_NOT_AVAILABLE; 422 PROVIDER_NOT_ALLOWED; 404 PRODUCT_NOT_FOUND | ORDER_NOT_FOUND;
// 409 PRODUCT_NOT_AVAILABLE | OFFER_VERSION_MISMATCH {current} | FORFEIT_CONFIRMATION_REQUIRED {minutes_left,
// days_left} | ACTIVE_PERIOD_EXISTS {ends_at} | STARS_SUBSCRIPTION_EXISTS | ORDER_STATE {status} | TRIAL_USED |
// TRIAL_NOT_AVAILABLE; 404 STARS_SUBSCRIPTION_NOT_FOUND; 429 ORDERS_LIMIT; 503 STARS_UNAVAILABLE (ссылка на счёт
// не получена — заказ pending, повторить чтение). Лимиты: tg.billing.read (GET), tg.billing.order (POST).
// =====================================================================================================================

/** Функции подписки: уроки с ИИ (lesson, scenario — режим full) и уроки вдвоём 14+ (ИИ-коуч). */
export type BillingFeature = "ai_lessons" | "pair_lessons";
export type BillingProductKind = "subscription" | "til_pack";
/** subscription — нативная подписка Telegram Stars (30 дней, продлевает Telegram); one_time — разовый счёт Stars. */
export type StarsMode = "one_time" | "subscription";
/** Статус подписки аккаунта (вычисляется billing): none — не было; trial — пробный; active — оплаченный или выданный
 *  период; expired — последний период закончился. */
export type SubscriptionStatus = "none" | "trial" | "active" | "expired";
export type BillingOrderStatus = "pending" | "paid" | "fulfilled" | "expired" | "cancelled" | "refunded";
/** Подписка Stars: active — автопродление включено; canceled — выключено (пользователем в Telegram или кнопкой в Mini
 *  App; оплаченный период живёт до конца); failed — продление не удалось (не хватило Stars); refunded — возврат;
 *  ended — срок прошёл без продления. */
export type StarsSubscriptionStatus = "active" | "canceled" | "failed" | "refunded" | "ended";
/** Почему урок идёт без ИИ по тарифу: нет подписки; в тарифе нет функции; минуты кончились; billing недоступен. */
export type AiLockReason = "no_subscription" | "feature_not_in_plan" | "minutes_exhausted" | "billing_unavailable";
export interface AiLock {
  reason: AiLockReason;
}
/** 403 SUBSCRIPTION_REQUIRED {feature, reason} — приглашение в урок вдвоём без подписки (details). */
export type SubscriptionRequiredReason = "no_subscription" | "feature_not_in_plan" | "minutes_exhausted" | "kids";
export interface SubscriptionRequiredDetails {
  feature: BillingFeature;
  reason: SubscriptionRequiredReason;
}

/** Цена в Mini App — только Stars. */
export interface StarsPrice {
  stars: number; // целые звёзды, 1..100 000 (подписка — ≤ 10 000)
  mode: StarsMode;
}

/** Товар каталога для Mini App: показывается только товар с ценой в Stars. Что входит и срок — до оплаты. */
export interface BillingProduct {
  code: string; // ^[a-z0-9_]{2,40}$ — plus_30d, plus_90d, til_100, til_550, til_1200
  kind: BillingProductKind;
  title: Localized; // 1..60
  description: Localized | null; // ≤ 300
  /** подписка: дней периода, ИИ-минут на период, функции; пакет тилов — null / [] */
  days: number | null;
  minutes: number | null;
  features: BillingFeature[];
  /** пакет тилов: сколько тилов; подписка — null */
  til: number | null;
  price: StarsPrice;
}

/** GET /v1/billing/catalog → BillingCatalog (активная версия каталога, канал miniapp). Детский профиль — products: [],
 *  payer_required: true, can_pay: false, trial: null. */
export interface BillingCatalog {
  /** PAYMENTS_ENABLED ∧ STARS_ENABLED: false — покупки временно недоступны (каталог виден, кнопки оплаты нет) */
  sales_enabled: boolean;
  /** включённые способы оплаты канала: в Mini App — ["telegram_stars"] или [] */
  providers: Array<"telegram_stars">;
  /** оферта на домене Mini App (без ссылок на оплату); version передаётся в заказ (offer_version) */
  offer: { version: string; url: string };
  /** пробный период: один раз на аккаунт, без оплаты; null — детский профиль */
  trial: { available: boolean; days: number; minutes: number } | null;
  products: BillingProduct[];
  /** платить может только владелец аккаунта в своём профиле */
  payer_required: boolean;
  /** этот профиль может платить (18+ или 14–17 с согласием родителя) */
  can_pay: boolean;
  /** 14–17: нужно согласие родителя на оплату */
  consent_required: boolean;
}

export interface SubscriptionPeriodView {
  starts_at: string;
  ends_at: string;
  minutes_granted: number;
  minutes_spent: number;
  /** удержано на идущие занятия */
  minutes_held: number;
  /** доступно = выдано − потрачено − снято − удержано (≥ 0) */
  minutes_left: number;
  /** перерасход за счёт сервиса (ученику не выставляется) */
  overage: number;
}

/** GET /v1/billing/subscription → SubscriptionView (аккаунт; детскому профилю — статус семьи без цен: «Подписка семьи
 *  активна до …»). Источник периода (Stars, пробный, выдача поддержкой или покупка вне Mini App) на доступ не влияет и
 *  не показывается. */
export interface SubscriptionView {
  status: SubscriptionStatus;
  plan: { code: string; title: Localized } | null;
  period: SubscriptionPeriodView | null;
  /** запланированный следующий период (оплачен «после текущего»); даты — после активации */
  next_period: { days: number; minutes_granted: number; starts_at: string | null } | null;
  features: BillingFeature[];
  /** до конца ≤ 3 дней, следующего периода нет и нет подписки Stars с автопродлением */
  expiring: boolean;
  minutes_exhausted: boolean;
  payer_required: boolean;
  can_pay: boolean;
  trial_available: boolean;
  sales_enabled: boolean;
  /** нативная подписка Telegram Stars аккаунта (только у плательщика); null — нет */
  stars_subscription: StarsSubscriptionView | null;
}

export interface StarsSubscriptionView {
  status: StarsSubscriptionStatus;
  /** автопродление включено (status active) */
  auto_renew: boolean;
  /** дата следующего списания / конца оплаченного периода (subscription_expiration_date) */
  expires_at: string;
  amount_stars: number;
}

/** История минут: grant — начислено (оплата, пробный, поддержка); debit — списано за занятие; expire — сгорело в
 *  конце периода; revoke — отозвано (возврат); adjust — корректировка поддержкой (комментарий сотрудника не
 *  показывается). */
export type MinuteEntryKind = "grant" | "debit" | "expire" | "revoke" | "adjust";
export type MinuteRefKind =
  | "order" | "trial" | "grant" | "session" | "room" | "period" | "hold" | "refund" | "adjustment" | "deletion";
/** GET /v1/billing/minutes?cursor= → Page<MinuteEntry> (новые сверху) */
export interface MinuteEntry {
  at: string;
  kind: MinuteEntryKind;
  /** со знаком: + начислено, − списано / сгорело / отозвано */
  minutes: number;
  ref_kind: MinuteRefKind;
  /** чьё занятие: свой профиль или детский профиль аккаунта; null — не занятие (начисление, сгорание) */
  learner: "self" | "child" | null;
  period_id: string;
}

/** POST /v1/billing/trial (Idempotency-Key обязателен; плательщик) → SubscriptionView (201). 409 TRIAL_USED —
 *  пробный уже был у аккаунта; 409 TRIAL_NOT_AVAILABLE — есть оплаченный период; 403 PAYER_REQUIRED |
 *  GUARDIAN_CONSENT_REQUIRED. */

/** POST /v1/billing/orders (Idempotency-Key обязателен) BillingOrderRequest → StarsOrder (201; тот же незавершённый
 *  заказ — 200). Сумма — только из каталога на сервере. Подписка Stars (stars_mode subscription) начинается в момент
 *  оплаты: при живой подписке Stars — 409 STARS_SUBSCRIPTION_EXISTS, при активном оплаченном периоде — 409
 *  ACTIVE_PERIOD_EXISTS {ends_at}, пробный заменяется только с confirm_forfeit: true (иначе 409
 *  FORFEIT_CONFIRMATION_REQUIRED {minutes_left, days_left}); start_mode не используется. Разовые товары («Плюс 90
 *  дней»): start_mode обязателен; now при активном периоде — только с confirm_forfeit: true. Пакет тилов — себе или
 *  детскому профилю своего аккаунта (beneficiary_id = user_id профиля), иначе 403 BENEFICIARY_NOT_ALLOWED.
 *  Оплата: Telegram.WebApp.openInvoice(invoice_link) (только через src/tg/), после закрытия — опрос
 *  GET /v1/billing/orders/{order_no} до 60 с (источник истины — billing, не статус openInvoice). */
export interface BillingOrderRequest {
  product_code: string;
  provider: "telegram_stars";
  start_mode?: "after_current" | "now";
  confirm_forfeit?: boolean;
  beneficiary_id?: string;
  /** версия оферты из каталога, с которой согласился ученик; иначе 409 OFFER_VERSION_MISMATCH {current} */
  offer_version: string;
}

/** Заказ Stars в Mini App. GET /v1/billing/orders?cursor= → Page<StarsOrder> — только заказы Stars (покупка и
 *  продления подписки), заказов вне Mini App нет; GET /v1/billing/orders/{order_no} → StarsOrder (чужой или не Stars —
 *  404 ORDER_NOT_FOUND); POST /v1/billing/orders/{order_no}/cancel → StarsOrder (только pending без платежа; иначе 409
 *  ORDER_STATE {status}). */
export interface StarsOrder {
  order_no: number;
  status: BillingOrderStatus;
  /** renewal — автопродление подписки Stars (создан billing по платежу Telegram) */
  channel: "miniapp" | "renewal";
  product: { code: string; kind: BillingProductKind; title: Localized };
  currency: "XTR";
  amount_stars: number;
  provider: "telegram_stars";
  /** ссылка на счёт Stars (https://t.me/…) — пока заказ pending; null — ещё не получена (повторить чтение) или оплачен */
  invoice_link: string | null;
  expires_at: string;
  created_at: string;
  paid_at: string | null;
  refund: { status: "awaiting_provider" | "completed" | "failed" } | null;
}

/** POST /v1/billing/stars-subscription StarsSubscriptionRequest (плательщик) → SubscriptionView: auto_renew false —
 *  «Отключить автопродление» (оплаченный период живёт до конца), true — включить снова. Живой подписки Stars нет —
 *  404 STARS_SUBSCRIPTION_NOT_FOUND; 503 STARS_UNAVAILABLE. */
export interface StarsSubscriptionRequest {
  auto_renew: boolean;
}
