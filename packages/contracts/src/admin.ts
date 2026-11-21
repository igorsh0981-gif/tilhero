/**
 * Публичный контракт admin-bff ↔ admin-web TilHero (спринт 2). ЕДИНСТВЕННЫЙ источник типов для обеих сторон.
 * Основа — admin.ts «Бот турист» (aievent, спринты 2–9), сокращённая до объёма TilHero; туристическое (события,
 * поездки, AI, источники, ленты новостей, мониторинг, биллинг) не переносится.
 *
 * Транспорт: admin-web (Caddy) проксирует `/admin/v1/*` на admin-bff по приватной сети Railway — один origin,
 * admin-bff публичного домена не имеет. Сессия — cookie `__Host-tilhero_admin` (Secure, HttpOnly, SameSite=Strict,
 * Path=/), непрозрачный id → Redis. В браузере нет токенов и секретов.
 * CSRF: все не-GET запросы обязаны нести заголовок `X-CSRF-Token` = `Me.csrf_token` (иначе 403 CSRF_INVALID);
 * дополнительно проверяется Origin. Тело — JSON, лишние поля отклоняются 422.
 * Фоновые опросы (очередь, счётчики) передают `X-Background: 1` — такой запрос не продлевает сессию по бездействию.
 * Успешный step-up выдаёт новую cookie сессии (id ротируется; старый id ещё 15 с работает без step-up).
 * 409 SESSION_ROTATED (без Set-Cookie) — step-up или смена пароля пришли со старым id, уже заменённым в другой
 * вкладке: повторить запрос один раз (cookie уже новая).
 *
 * Ответ об ошибке: ErrorBody. Общие коды admin-bff:
 *  - 401 UNAUTHORIZED — нет сессии; 401 SESSION_EXPIRED — истекла по бездействию (30 мин) или абсолютно (8 ч);
 *    401 SESSION_REVOKED — сотрудник заблокирован, сменил пароль или роль изменена → вход заново;
 *  - 403 PERMISSION_DENIED {permission} — нет права (проверяется в admin-bff И в домене);
 *  - 403 STEP_UP_REQUIRED {permission?} — нужна повторная проверка TOTP (POST /admin/v1/auth/step-up), окно 5 мин;
 *  - 403 CSRF_INVALID; 422 VALIDATION_ERROR {in, field, errors}; 404 NOT_FOUND;
 *  - 429 RATE_LIMITED {retry_after} + Retry-After; 503 UPSTREAM_UNAVAILABLE {service}; 500 INTERNAL_ERROR.
 * 4xx доменов (SUPPORT_INVALID_TRANSITION, RELEASE_NOTE_TRANSLATION_MISSING, TEMPLATE_INVALID, …) передаются
 * с их кодом и details.
 * Время — ISO-8601 UTC. Пагинация — курсорная: `?cursor=&limit=` → Page<T>.
 * Создающие команды (POST) принимают `Idempotency-Key` (8..128, [A-Za-z0-9_\-:.]); где сказано «обязателен» —
 * без него 422 IDEMPOTENCY_KEY_REQUIRED.
 *
 * Step-up (повторный TOTP ≤ 5 мин) требуют: публикация и снятие «Что нового»; активация и сброс шаблона
 * уведомления; расписание и остановка рассылки; активация и откат конфигурации; раскрытие Telegram ID; все команды
 * по сотрудникам, ролям и заявкам four-eyes. Спринт 3: публикация, снятие и откат версии контента; подтверждение прав
 * медиа; решение по заявке ученика на песню/фильм; правка языков и языковых пар; публикация версии теста диагностики.
 * Спринт 4: публикация, канарейка и откат версии агента; правка моделей и цен; бюджет и аварийная остановка ИИ;
 * переоценка; решение по апелляции. Спринт 5: ручная правка карточки памяти ученика. Спринт 6: активация и откат
 * правил игры, публикация героев, предметов и событий, ручные операции с кошельком. Спринт 7: санкция social_ban
 * больше 7 дней и бессрочная, активация реферальной кампании, переоценка лиги и дуэли, остановка парной комнаты.
 */

import type {
  ContentKind, GlossaryEntry, GlossaryRef, GlossaryReviewStatus, GlossarySource, Language, LanguagePair, LocaleCheck,
  MediaRequestStatus, PartOfSpeech, ScenarioTestRun, VersionStatus, Localized as ContentLocalized, Band,
} from "./content.js";
import type {
  GameAction, GameCurrency, GameReason, HeroLine, HeroStage, QuestKind, ShopItemKind,
  ComplaintReason, ComplaintSubjectKind, DuelScore, DuelStatus, FriendRequestStatus, LeagueLevelBand, PairEndReason,
  PairRole, PairRoomEventKind, PairRoomMode, PairRoomStatus, ReferralRejectCode, ReferralReward,
  ReferralRewardOutcome, ReferralStatus, SanctionAppealStatus, SanctionKind,
} from "./bff.js";
import type {
  Agent, AgentId, AgentRollout, AgentVersion, AiBudget, AiModel, AiProviderStatus, ConfirmedError, GoldenCase,
  RubricCriterionCode, SessionKind, TestRun, TestRunSummary,
} from "./ai.js";

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
/** Язык интерфейса админки (сотрудники). */
export type StaffLang = "ru" | "en";
export interface Localized {
  ru: string;
  uz: string;
}

// =====================================================================================================================
// RBAC
// =====================================================================================================================

/** Каталог прав. Источник истины матрицы ролей — admin-identity (миграция-сид), здесь — словарь для типов и UI. */
export type Permission =
  | "dashboard.read"
  | "users.read"
  | "users.sensitive.read" // раскрытие Telegram ID ученика (с причиной, аудит), привилегированное
  | "support.read"
  | "support.reply"
  | "support.manage" // SLA-политики
  | "audit.read"
  | "config.read" // тема и раскладка Mini App и админки
  | "config.edit"
  | "config.publish"
  | "whatsnew.manage" // «Что нового»: список, черновик, предпросмотр, статистика
  | "whatsnew.publish" // «Что нового»: публикация и снятие (step-up)
  | "notif.templates.manage" // шаблоны уведомлений: версии, предпросмотр, тест, активация (step-up), сброс
  | "notif.campaigns.manage" // рассылки: черновик, сегмент, оценка охвата, тест
  | "notif.campaigns.send" // рассылки: расписание и экстренная остановка (step-up)
  | "staff.manage"
  | "roles.manage"
  // спринт 3 — контент, медиа, языки
  | "content.read"
  | "content.edit" // черновики всех сущностей контента, тестовый прогон сценария, загрузка аудио
  | "content.review" // проверка методиста и локализаций (не своих черновиков)
  | "content.publish" // публикация, архив, откат контента и версий теста диагностики (step-up)
  | "media.rights" // права и лицензии медиа, решения по заявкам учеников (step-up)
  | "lang.manage" // языки и языковые пары (step-up)
  // спринт 4 — ИИ-агенты, контроль диалогов, затраты
  | "ai.read" // агенты, версии, золотые тесты, маршрутизация моделей — чтение
  | "ai.manage" // черновики версий, золотые тесты, запуск прогона
  | "ai.publish" // публикация, канарейка, откат версии агента; модели и цены (step-up)
  | "qa.read" // журнал сессий, карточки оценок, апелляции — без текста реплик
  | "qa.transcripts" // текст реплик и ответов ученика — с причиной, каждое открытие в аудите
  | "qa.review" // переоценка и решение по апелляции (step-up)
  | "costs.read" // затраты ИИ
  | "costs.manage" // лимиты ИИ и аварийная остановка (step-up)
  // спринт 5 — память, словарь курса
  | "memory.read" // очередь и история карточек ученика, проверки удержания, аналитика забывания
  | "memory.manage" // ручная правка карточки: перенос срока, сброс, заморозка (step-up, по одной, с причиной)
  | "glossary.manage" // словарь курса и модерация переводов ИИ
  // спринт 6 — игра и герои
  | "game.read" // правила, герои, магазин, события, кошельки учеников — чтение
  | "game.manage" // черновики правил, герои и картинки, предметы магазина, события недели
  | "game.publish" // активация и откат правил, публикация героев, предметов и событий (step-up)
  | "wallet.adjust" // ручное начисление и списание, обратная запись, возврат покупки (step-up, причина)
  // спринт 7 — социальное
  | "social.read" // профиль сообщества, друзья, заявки, блокировки, дела и санкции ученика — без переписки
  | "moderation.manage" // дела модерации, санкции (step-up: social_ban > 7 дней и бессрочный), обжалования
  | "referral.read" // реферальные кампании, очередь проверки, статистика
  | "referral.manage" // черновик и активация кампании (step-up), одобрение и отклонение реферала (причина)
  | "league.read" // лиги недели (группы, итоги, аномалии) и дуэли
  | "league.manage" // переоценка лиги и дуэли (step-up), снятие удержания призов
  | "room.read" // мониторинг парных комнат — без реплик и оценок
  | "room.manage"; // остановка парной комнаты (step-up, причина)

export const PERMISSIONS: readonly Permission[] = [
  "dashboard.read", "users.read", "users.sensitive.read", "support.read", "support.reply", "support.manage",
  "audit.read", "config.read", "config.edit", "config.publish", "whatsnew.manage", "whatsnew.publish",
  "notif.templates.manage", "notif.campaigns.manage", "notif.campaigns.send", "staff.manage", "roles.manage",
  "content.read", "content.edit", "content.review", "content.publish", "media.rights", "lang.manage",
  "ai.read", "ai.manage", "ai.publish", "qa.read", "qa.transcripts", "qa.review", "costs.read", "costs.manage",
  "memory.read", "memory.manage", "glossary.manage",
  "game.read", "game.manage", "game.publish", "wallet.adjust",
  "social.read", "moderation.manage", "referral.read", "referral.manage", "league.read", "league.manage", "room.read",
  "room.manage",
];

export type RoleCode =
  | "super_admin"
  | "operations" // конфигурация, поддержка, ученики (без раскрытия), аудит
  | "communications" // «Что нового», шаблоны уведомлений, рассылки
  | "support"
  | "methodist" // курс, уроки, сценарии, рубрики: правка, проверка, публикация
  | "content_manager" // медиа, права и лицензии, заявки учеников
  | "qa_analyst" // контроль диалогов: журнал, оценки, реплики с причиной (спринт 4)
  | "analyst"
  | "auditor"
  | "read_only";

/** Роли, для которых MFA (TOTP) обязательна; назначение такой роли — four-eyes. Базовый список спринта 2:
 * привилегированной также считается любая роль с правом, требующим step-up (спринт 3: methodist — content.publish,
 * content_manager — media.rights). Источник истины — `Role.privileged` из GET /admin/v1/roles; константа — запасной
 * вариант, пока роли не загружены. */
export const PRIVILEGED_ROLES: readonly RoleCode[] = ["super_admin", "operations", "communications"];

export interface Role {
  code: RoleCode;
  name: { ru: string; en: string };
  permissions: Permission[];
  privileged: boolean;
  staff_count: number;
  updated_at: string;
  updated_by: string | null;
}

// =====================================================================================================================
// Auth (admin-identity через admin-bff)
// =====================================================================================================================

export type LoginNext = "done" | "mfa" | "mfa_enroll" | "password_change";

/** POST /admin/v1/auth/login {email, password}. Ошибки: 401 INVALID_CREDENTIALS {remaining} (одинаково для
 * несуществующего email), 423 ACCOUNT_LOCKED {retry_after} (5 неудач → 15 мин), 403 ACCOUNT_DISABLED. */
export interface LoginRequest {
  email: string;
  password: string;
}
/** challenge — одноразовый, 5 мин, только для следующего шага. При next="done" ставится cookie и приходит me. */
export interface LoginStep {
  next: LoginNext;
  challenge: string | null;
  me: Me | null;
}
/** POST /admin/v1/auth/mfa {challenge, code} → LoginStep. 401 MFA_INVALID {remaining}; 401 CHALLENGE_INVALID. */
export interface MfaRequest {
  challenge: string;
  code: string;
}
/** POST /admin/v1/auth/mfa/enroll/start {challenge} → секрет показывается один раз (issuer «TilHero Admin»). */
export interface MfaEnrollStart {
  secret: string;
  otpauth_uri: string;
  issuer: string;
  account: string;
}
/** POST /admin/v1/auth/mfa/enroll/confirm {challenge, code} → LoginStep. */

/** POST /admin/v1/auth/password. С challenge — шаг входа (must_change_password); без него — смена своего пароля
 * в сессии (нужен current_password). Правила: ≥ 12 символов, буквы и цифры, не совпадает с email и прежним.
 * 422 PASSWORD_WEAK {rules: string[]}; 401 INVALID_CREDENTIALS. После смены все прочие сессии отзываются. */
export interface PasswordChangeRequest {
  challenge?: string;
  current_password?: string;
  new_password: string;
}

/** POST /admin/v1/auth/step-up {code} → {step_up_until}. 401 MFA_INVALID {remaining}. */
export interface StepUpRequest {
  code: string;
}
export interface StepUpResult {
  step_up_until: string;
}

/** POST /admin/v1/auth/logout → 204 (сессия удалена, cookie стирается); 503 SESSION_NOT_REVOKED {service:
 * "session-store"} — хранилище сессий недоступно: cookie стёрта, но сессия могла остаться до истечения (ревью T2-10). */

export interface StaffSummary {
  staff_id: string;
  email: string;
  display_name: string;
  role: RoleCode;
}

/** GET /admin/v1/me. */
export interface Me {
  staff: StaffSummary;
  permissions: Permission[];
  mfa_enabled: boolean;
  must_change_password: boolean;
  session: {
    expires_at: string;
    idle_timeout_seconds: number;
    step_up_until: string | null;
  };
  csrf_token: string;
  env: "dev" | "test" | "stage" | "prod";
  /** Только ENV=dev: эффективная роль для предпросмотра меню (имперсонация). В stage/prod всегда null. */
  impersonating: RoleCode | null;
}

// =====================================================================================================================
// Сотрудники и роли (staff.manage / roles.manage) — как aievent, без режима AD
// =====================================================================================================================

export type StaffStatus = "ACTIVE" | "LOCKED" | "DISABLED";

export interface Staff extends StaffSummary {
  status: StaffStatus;
  mfa_enabled: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
  created_by: string | null;
}

/** GET /admin/v1/staff?q=&role=&status=&cursor=&limit= → Page<Staff>; GET /admin/v1/staff/{id} → Staff.
 *  POST /admin/v1/staff {email, display_name, role} (Idempotency-Key обязателен) → StaffCreated. Временный пароль
 *  показывается ОДИН раз, действует 24 ч, must_change_password=true. Привилегированная роль → four-eyes: учётка
 *  создаётся в роли read_only, `temporary_password: null` автору (ревью P2-1), пароль получает РЕШАЮЩИЙ в ответе approve;
 *  при `waived: "single_super_admin"` — автор (он же единственный решающий). */
export interface StaffCreate {
  email: string;
  display_name: string;
  role: RoleCode;
}
export interface StaffCreated {
  staff: Staff;
  temporary_password: string | null;
  approval: Approval | null;
}
/** PATCH /admin/v1/staff/{id} {role?, status?, display_name?, reason}. Нельзя: снять или заблокировать последнего
 * активного super_admin (409 LAST_SUPER_ADMIN), заблокировать или понизить себя (409 SELF_ACTION).
 * Повышение до привилегированной роли → 202 + approval (four-eyes); при применении у цели сбрасываются пароль, MFA
 * и сессии, новый временный пароль — решающему (P2-1). Включение (DISABLED → ACTIVE) сотрудника с привилегированной
 * ролью → 202 + approval `staff.reactivate_privileged` с тем же сбросом (P2-2). Нужен step-up. */
export interface StaffPatch {
  role?: RoleCode;
  status?: "ACTIVE" | "DISABLED";
  display_name?: string;
  reason: string;
}
/** Ответ PATCH: 200 Staff — применено сразу; 202 StaffPatchPending — заявка four-eyes. Если заявка применилась
 * сразу (waived single_super_admin) и при этом выпущен временный пароль цели — он в temporary_password (один раз). */
export interface StaffPatchPending {
  approval: Approval;
  temporary_password?: string;
}
/** POST /admin/v1/staff/{id}/reset-password {reason} → StaffResetResponse; POST …/reset-mfa {reason} → Staff | {approval}.
 * Обе — step-up; сессии сотрудника отзываются. Цель — привилегированный сотрудник → 202 {approval}
 * (kind staff.privileged_reset); временный пароль получает РЕШАЮЩИЙ (ответ approve). */
export type StaffResetResponse = { temporary_password: string } | { approval: Approval };

/** GET /admin/v1/roles → {items: Role[]}; PUT /admin/v1/roles/{code} {permissions, reason} → 202 approval
 * (four-eyes, step-up). */
export interface RoleUpdate {
  permissions: Permission[];
  reason: string;
}

export type ApprovalKind =
  | "staff.role_grant"
  | "staff.create_privileged"
  | "role.permissions_change"
  | "staff.privileged_revoke"
  | "staff.privileged_reset"
  | "staff.reactivate_privileged";
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "APPLIED";

/** Four-eyes: исполняет второй super_admin (≠ автор) со step-up. Пока активный super_admin один — изменение
 * применяется сразу с пометкой `waived: "single_super_admin"` и записью в аудит. Срок заявки — 72 ч. */
export interface Approval {
  approval_id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  summary: Record<string, unknown>;
  reason: string;
  requested_by: StaffSummary;
  requested_at: string;
  decided_by: StaffSummary | null;
  decided_at: string | null;
  decision_note: string | null;
  waived: "single_super_admin" | null;
  expires_at: string;
}
/** GET /admin/v1/approvals?status= → Page<Approval>; POST /admin/v1/approvals/{id}/approve|reject {note} → ApprovalDecision.
 * temporary_password — только в ответе approve заявок staff.privileged_reset (action "password"),
 * staff.create_privileged, staff.role_grant и staff.reactivate_privileged; показывается решающему один раз. */
export type ApprovalDecision = Approval & { temporary_password?: string };

// =====================================================================================================================
// Ученики (users.read) — user-admin + identity-consent; PII маскирована всегда
// =====================================================================================================================

export type AgeBand = "6-9" | "10-13" | "14-17" | "18+";
/** Сегмент возраста для «Что нового» и рассылок: kids 6–13, teens 14–17, adults 18+. */
export type AgeSegment = "kids" | "teens" | "adults";
export type GuardianConsent = "not_required" | "pending" | "granted" | "declined";
/** account — аккаунт Telegram (сам ученик 14+ или опекун); child — детский профиль 6–13 под опекуном. */
export type LearnerKind = "account" | "child";
export type LearnerStatus = "ACTIVE" | "DISABLED" | "DELETION_REQUESTED" | "DELETED";
export type Goal = "work" | "career" | "travel" | "daily" | "study" | "exam";
export type LevelSelf = "zero" | "beginner" | "some" | "confident";
export type SchedulePreset = "daily" | "weekdays" | "three_per_week" | "custom";
/** game (спринт 7) — игра и лиги: значки, рост героя, спасённая серия, итоги лиги, дуэли */
export type NotificationCategory = "reminders" | "missed" | "social" | "support" | "product" | "service" | "game";
/** Цели согласия (identity-consent): обязательные и необязательные (social, product_news, voice_recording). */
export type ConsentPurpose = string;

/** Строка реестра. Telegram ID — только маска (полный — reveal); у детского профиля Telegram ID и username нет.
 *  username — без «@» (как в Telegram API); маска `ig•••81` (первые 2 и последние 2 символа; короче 5 — `•••`), полностью — только сотруднику с users.sensitive.read
 *  (маскирует домен user-admin по actor; ревью T2-3). display_name — отображаемое имя Telegram или имя профиля ребёнка,
 *  нужно поддержке для обращения к ученику. Поиск q=@username — точное совпадение по полному username. */
export interface AdminLearnerRow {
  user_id: string;
  kind: LearnerKind;
  /** для child — аккаунт опекуна */
  guardian_user_id: string | null;
  display_name: string | null;
  username: string | null;
  telegram_id_masked: string | null;
  locale: UiLang | null;
  age_band: AgeBand | null;
  guardian_consent: GuardianConsent;
  status: LearnerStatus;
  onboarding_completed: boolean;
  goal: Goal | null;
  reminders_enabled: boolean;
  /** для account — число детских профилей */
  children_count: number;
  open_tickets: number;
  tickets_total: number;
  created_at: string;
  last_activity_at: string | null;
}

/** GET /admin/v1/learners?q=&kind=&age_band=&status=&locale=&has_open_tickets=&cursor=&limit= → Page<AdminLearnerRow>.
 *  q: UUID ученика, @username, часть имени, TCK-номер обращения (→ его автор). */
export interface AdminLearnerPlan {
  goal: Goal | null;
  level_self: LevelSelf | null;
  ui_lang: UiLang | null;
  schedule: {
    preset: SchedulePreset;
    days: number[];
    preferred_time: string;
    duration_min: number;
    reminders_enabled: boolean;
    timezone: string;
  } | null;
  onboarding_completed_at: string | null;
  updated_at: string | null;
}

export interface AdminLearnerCard extends AdminLearnerRow {
  consent: {
    policy_version: string | null;
    purposes: ConsentPurpose[];
    accepted_at: string | null;
    revoked_at: string | null;
    /** кем дано согласие: сам ученик или опекун (дети, подростки) */
    basis: "self" | "guardian" | null;
  };
  security: { pin_enabled: boolean; pin_reset_pending: boolean };
  notifications: { enabled: boolean; categories: Record<Exclude<NotificationCategory, "service">, boolean> } | null;
  plan: AdminLearnerPlan | null;
  /** для account — его детские профили; для child — пусто */
  children: AdminLearnerRow[];
  /** для child — опекун; для account — null */
  guardian: AdminLearnerRow | null;
  /** последние 20 обращений (support); null — support недоступен */
  tickets: Array<{ ticket_id: string; number: string; status: TicketStatus; category: string; subject: string; created_at: string }> | null;
  /** момент, когда карточка перечитана из identity-consent */
  refreshed_at: string;
}
/** GET /admin/v1/learners/{id} → AdminLearnerCard; 404 LEARNER_NOT_FOUND. */

/** POST /admin/v1/learners/{id}/reveal {field, reason} (users.sensitive.read; reason 5..300; step-up).
 * Значение показывается 60 с; аудит `sensitive.view` пишется синхронно (audit недоступен → 503 без значения).
 * У детского профиля telegram_user_id нет → 409 FIELD_NOT_AVAILABLE. */
export interface RevealRequest {
  field: "telegram_user_id";
  reason: string;
}
export interface RevealResult {
  field: "telegram_user_id";
  value: string;
  expires_in: number;
}

// =====================================================================================================================
// Дашборд (dashboard.read)
// =====================================================================================================================

export type Period = "today" | "7d" | "30d";

/** Блок дашборда независим: источник недоступен → available=false, data=null; остальные блоки показываются. */
export interface DashboardBlock<T> {
  available: boolean;
  data: T | null;
  /** при available=false — сервис-источник */
  service?: string;
}

export interface DashboardLearners {
  total_accounts: number;
  total_children: number;
  new_in_period: number;
  active_in_period: number;
  onboarding_completed_pct: number;
  reminders_enabled_pct: number;
  by_age_band: Record<AgeBand | "unknown", number>;
  by_locale: Record<UiLang | "unknown", number>;
}

export interface DashboardWhatsNew {
  published: number;
  drafts: number;
  /** последняя опубликованная: показы */
  latest: { release_note_id: string; slug: string; title: string; views_total: number; published_at: string } | null;
}

export interface DashboardCampaigns {
  scheduled: number;
  sending: number;
  /** рассылок запущено за период (не сообщений) — подпись «Запущено рассылок» (QA D2-01) */
  sent_in_period: number;
  /** сообщений рассылок доставлено в Telegram за период — подпись «Доставлено сообщений» */
  delivered_in_period: number;
}

/** GET /admin/v1/dashboard?period=today|7d|30d → Dashboard (всегда 200). */
export interface Dashboard {
  period: Period;
  generated_at: string;
  learners: DashboardBlock<DashboardLearners>;
  support: DashboardBlock<SupportStats>;
  whats_new: DashboardBlock<DashboardWhatsNew>;
  campaigns: DashboardBlock<DashboardCampaigns>;
  /** спринт 3 */
  content: DashboardBlock<ContentSummary>;
  diagnostics: DashboardBlock<DiagnosticStats>;
  /** спринт 4 */
  lessons: DashboardBlock<LessonStats>;
  ai: DashboardBlock<AiUsageSummary>;
  /** спринт 5 */
  memory: DashboardBlock<MemoryStats>;
  /** спринт 6 */
  game: DashboardBlock<GameStats>;
  /** спринт 7: источник — social (дуэли — gamification, комнаты — lessons: при их недоступности поля null) */
  social: DashboardBlock<SocialStats>;
}

// =====================================================================================================================
// Поддержка (support.read / support.reply / support.manage) — формы support staff API; BFF добавляет имена операторов
// =====================================================================================================================

export type TicketStatus = "NEW" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "RESOLVED" | "CLOSED";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type SlaState = "breached" | "soon" | "ok";
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
export type EscalationType = "billing_review" | "assessment_review" | "content_review" | "tech_issue" | "security_privacy";

export interface StaffTicketSummary {
  ticket_id: string;
  number: string;
  user_id: string | null;
  channel: string;
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignee_id: string | null;
  assignee_name: string | null;
  has_context: boolean;
  anonymized: boolean;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  first_response_at: string | null;
  sla_first_response_at: string;
  sla_resolution_at: string;
  sla_target: "first_response" | "resolution" | null;
  sla_due_at: string | null;
  sla_state: SlaState;
  sla_paused: boolean;
}

export interface StaffTicketMessage {
  message_id: string;
  sender_type: "user" | "operator" | "system";
  /** internal — заметка оператора: ученику не видна никогда (ни в API ученика, ни в уведомлениях) */
  visibility: "public" | "internal";
  author_id: string | null;
  author_name: string | null;
  text: string;
  created_at: string;
}

export interface StaffTicket extends StaffTicketSummary {
  context: { deeplink: string | null; client_version: string } | null;
  correlation_id: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  user_unread_operator_replies: number;
  messages: StaffTicketMessage[];
  status_history: Array<{ from_status: string | null; status: string; at: string; changed_by: string; actor_id: string | null }>;
  escalations: Escalation[];
  /** безопасная сводка ученика (без PII, кроме маскированного ID) */
  learner: Pick<AdminLearnerRow, "user_id" | "kind" | "username" | "telegram_id_masked" | "locale" | "age_band" | "status"> | null;
}

/** GET /admin/v1/support/tickets?status=&category=&priority=&assignee=me|<id>|none&sla=&user_id=&sort=created|sla&cursor=&limit=
 *  GET /admin/v1/support/tickets/{id} → StaffTicket (id — UUID или TCK-номер)
 *  GET /admin/v1/support/tickets/{id}/client-view → то, что видит ученик (форма bff.ts Ticket; без internal)
 *  POST /admin/v1/support/tickets/{id}/messages StaffMessageCreate → StaffTicket (Idempotency-Key обязателен)
 *  PATCH /admin/v1/support/tickets/{id} {status?, priority?, assignee_id?} → StaffTicket
 *  POST /admin/v1/support/tickets/{id}/take → назначить на себя + IN_PROGRESS
 *  POST /admin/v1/support/tickets/{id}/escalations {type, note} → 201 Escalation
 *  GET /admin/v1/support/stats?period= → SupportStats (support.read или dashboard.read)
 *  GET /admin/v1/support/templates → {items: ReplyTemplate[]}
 *  GET|PUT /admin/v1/support/sla-policies (PUT — support.manage, тело {items, reason}) */
export interface Escalation {
  escalation_id: string;
  type: EscalationType;
  note: string;
  status: string;
  created_by: string;
  created_at: string;
}

export interface SupportStats {
  open: number;
  in_progress: number;
  waiting_customer: number;
  breached: number;
  avg_first_response_minutes: number | null;
  avg_resolution_minutes: number | null;
}

export interface SlaPolicy {
  category: TicketCategory | "*";
  priority: TicketPriority;
  first_response_minutes: number;
  resolution_minutes: number;
  updated_at?: string;
  updated_by?: string | null;
}
export interface SlaPolicies {
  items: SlaPolicy[];
  category_defaults?: Record<string, string>;
}

export interface StaffMessageCreate {
  text: string;
  visibility: "public" | "internal";
}
/** Шаблоны ответов оператора: тексты на языке ученика (RU/UZ). */
export interface ReplyTemplate {
  id: string;
  title: { ru: string; en: string };
  text: Localized;
  categories: TicketCategory[];
}

// =====================================================================================================================
// Аудит (audit.read)
// =====================================================================================================================

export interface AuditRecord {
  seq: number;
  record_id: string;
  occurred_at: string;
  recorded_at: string;
  source: string;
  actor_type: "staff" | "user" | "system" | "service";
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  ip: string | null;
  session_id: string | null;
  trace_id: string | null;
  prev_hash: string;
  hash: string;
}
/** GET /admin/v1/audit/records?action=&actor_id=&object_type=&object_id=&from=&to=&cursor=&limit= → Page<AuditRecord>
 *  GET /admin/v1/audit/records/{id}; GET /admin/v1/audit/verify → ChainVerification */
export interface ChainVerification {
  valid: boolean;
  checked: number;
  first_seq: number | null;
  last_seq: number | null;
  broken_at_seq: number | null;
}

// =====================================================================================================================
// Конфигурация интерфейса (config.read / config.edit / config.publish)
// =====================================================================================================================

export type ConfigApp = "miniapp" | "admin";

export interface ConfigVersion {
  version_id: string;
  app: ConfigApp;
  version: string;
  checksum: string;
  change_note: string;
  created_by: string;
  created_at: string;
  status: "current" | "previous" | null;
  payload?: Record<string, unknown>;
}
export interface ConfigActivation {
  activation_id: string;
  app: ConfigApp;
  version: string;
  previous_version: string | null;
  kind: "activate" | "rollback";
  reason: string;
  activated_by: string;
  activated_at: string;
}
/** GET /admin/v1/experience/admin/current → AdminExperience (тема и раскладка админки — любой вошедший сотрудник)
 *  GET /admin/v1/experience/miniapp/current → ExperienceConfig (config.read)
 *  GET /admin/v1/experience/{app}/state → ConfigState
 *  GET /admin/v1/experience/{app}/versions → Page<ConfigVersion>; GET …/versions/{version} → ConfigVersion с payload
 *  GET /admin/v1/experience/{app}/activations → Page<ConfigActivation>
 *  POST /admin/v1/experience/{app}/versions {version, payload, change_note} (config.edit)
 *  POST /admin/v1/experience/{app}/activate {version, reason}, POST …/rollback {reason} (config.publish, step-up)
 *  Откат применяется без сборки: Mini App и админка перечитывают конфигурацию при следующем открытии. */
export interface ConfigState {
  app: ConfigApp;
  current: ConfigActivation | null;
  previous_version: string | null;
}

/** GET /admin/v1/experience/admin/current — тема и раскладка админки (ревью T2-6). tokens — белый список CSS-переменных
 *  (admin-web применяет только известные); menu — порядок разделов и выключенные. */
export interface AdminExperience {
  app: "admin";
  version: string;
  theme: { id: string; version: string; tokens: Record<string, string> };
  layout: { density: "compact" | "comfortable"; menu: Array<{ id: string; enabled: boolean }> };
  flags: Record<string, boolean>;
}

// =====================================================================================================================
// «Что нового» (whatsnew.manage / whatsnew.publish) — experience-config; каталог packages/contracts/release-notes.json
// =====================================================================================================================

export type ReleaseNoteStatus = "draft" | "published" | "archived";
/** new — знакомство после первой регистрации; existing — новое для тех, кто уже занимался до публикации; all — всем. */
export type ReleaseNoteAudience = "new" | "existing" | "all";
export type ReleaseNoteRoute =
  | "home" | "lessons" | "review" | "progress" | "profile" | "schedule" | "notifications" | "family" | "support" | "news"
  // спринт 3
  | "diagnostics" | "plan" | "skills" | "scenarios" | "media" | "media_requests" | "languages"
  // релиз 6.1: игра — герои, магазин, значки, история, настройки; словарь и чтение
  | "heroes" | "shop" | "badges" | "game_history" | "game_settings" | "dictionary" | "reading"
  // спринт 7: друзья (заявки, блокировки, санкции), лиги недели, дуэли, рефералы (как bff.ts и release-notes.json)
  | "friends" | "leagues" | "duels" | "referrals";
export type ReleaseNoteIcon =
  | "spark" | "hero" | "calendar" | "clock" | "bell" | "book" | "chat" | "mic" | "star" | "flame" | "users" | "gift"
  | "shield" | "globe" | "trophy" | "news";

/** Сегменты: пусто — всем. */
export interface ReleaseNoteSegments {
  age?: AgeSegment[];
  ui_lang?: UiLang[];
}

/** Тексты RU и UZ обязательны оба (пустой перевод → 422 RELEASE_NOTE_TRANSLATION_MISSING {missing: string[]} —
 *  пути полей, например "items[1].text.uz"). Заголовок ≤ 80, пункт: заголовок ≤ 80, текст ≤ 200; пунктов 1..6;
 *  slug ^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$. Простой текст без управляющих символов.
 *  illustration (релиз 6.1) — ключ из списка `illustrations` каталога release-notes.json (картинка 16:9 сверху первой
 *  карточки в Mini App) или null; ключ не из каталога → 422 VALIDATION_ERROR. На входе необязателен (клиенты до 6.1):
 *  при создании нет — null, при правке черновика нет — не меняется. */
export interface ReleaseNoteContent {
  slug: string;
  title: Localized;
  items: Array<{
    title: Localized;
    text: Localized;
    link: ReleaseNoteRoute | null;
    icon: ReleaseNoteIcon | null;
  }>;
  audience: ReleaseNoteAudience;
  segments: ReleaseNoteSegments;
  illustration: string | null;
}

export interface StaffReleaseNote extends ReleaseNoteContent {
  release_note_id: string;
  status: ReleaseNoteStatus;
  /** оптимистическая блокировка черновика (expected_version) */
  version: number;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  updated_by: string;
  updated_at: string;
  published_by: string | null;
  published_by_name: string | null;
  published_at: string | null;
  archived_by: string | null;
  archived_at: string | null;
  /** показы (уникальные ученики), только у опубликованных и архивных; 0 у черновика */
  views_total: number;
}

export interface ReleaseNoteStats {
  release_note_id: string;
  views_total: number;
  views_by_lang: Record<UiLang, number>;
  views_by_age: Record<AgeSegment, number>;
  first_view_at: string | null;
  last_view_at: string | null;
}

/**
 *  GET  /admin/v1/release-notes?status=&cursor=&limit= (whatsnew.manage) → Page<StaffReleaseNote>, новые первыми
 *  GET  /admin/v1/release-notes/{id} (whatsnew.manage) → StaffReleaseNote; 404 RELEASE_NOTE_NOT_FOUND
 *  GET  /admin/v1/release-notes/{id}/stats (whatsnew.manage) → ReleaseNoteStats
 *  POST /admin/v1/release-notes ReleaseNoteContent (whatsnew.manage, Idempotency-Key) → 201 черновик;
 *       409 RELEASE_NOTE_SLUG_EXISTS; 422 RELEASE_NOTE_TRANSLATION_MISSING | VALIDATION_ERROR
 *  PUT  /admin/v1/release-notes/{id} ReleaseNoteContent + {expected_version} (whatsnew.manage) → черновик;
 *       409 RELEASE_NOTE_NOT_DRAFT | RELEASE_NOTE_VERSION_CONFLICT {current_version}
 *  POST /admin/v1/release-notes/{id}/publish ReleaseNotePublishInput (whatsnew.publish, step-up, Idempotency-Key)
 *       → 201; уже опубликована → 200; 409 RELEASE_NOTE_NOT_DRAFT | RELEASE_NOTE_VERSION_CONFLICT
 *  POST /admin/v1/release-notes/{id}/archive {reason} (whatsnew.publish, step-up, Idempotency-Key) → 201; в архиве → 200
 *  Аудит: release_note.create | update | publish | archive (object_type release_note).
 *  Публикация: ученики аудитории видят заметку при следующем входе в Mini App один раз (отметки на сервере);
 *  у учеников с согласием product_news и включённой категорией product — ещё и сообщение в Telegram
 *  (шаблон release_note.published, детским профилям — никогда).
 *  Заметка каждого релиза публикуется миграцией experience-config при выкладке (published_by "system:release");
 *  сотрудник может снять её с показа (archive).
 *  Предпросмотр — на клиенте (admin-web, рамка телефона, язык RU/UZ, светлая и тёмная тема Mini App).
 */
export interface ReleaseNotePublishInput {
  expected_version: number;
  reason: string;
}
export interface ReleaseNoteArchiveInput {
  reason: string;
}

export type ReleaseNoteErrorCode =
  | "RELEASE_NOTE_NOT_FOUND"
  | "RELEASE_NOTE_SLUG_EXISTS"
  | "RELEASE_NOTE_NOT_DRAFT"
  | "RELEASE_NOTE_VERSION_CONFLICT"
  | "RELEASE_NOTE_TRANSLATION_MISSING";

// =====================================================================================================================
// Шаблоны уведомлений (notif.templates.manage) — notifications
// =====================================================================================================================

/** Текст одного языка. title ≤ 80, body ≤ 1000, button ≤ 32 (null — кнопка по умолчанию шаблона). HTML Telegram не
 *  допускается: текст экранируется при отправке. Плейсхолдеры — `{name}` только из TemplateInfo.placeholders;
 *  `{{` и `}}` — буквальные скобки. */
export interface TemplateText {
  title: string;
  body: string;
  button: string | null;
}
export interface TemplateTexts {
  ru: TemplateText;
  uz: TemplateText;
}

export type TemplateVersionStatus = "draft" | "active" | "archived";

export interface TemplatePlaceholder {
  name: string; // learner_name, duration, slot_time, streak_days, days_missed, inviter_name, ticket_number, note_title …
  description: { ru: string; en: string };
  /** пример значения для предпросмотра (RU/UZ) */
  sample: Localized;
}

/** Ключи — из реестра notifications (templates.py). Служебные шаблоны (pin.*) не редактируются и не выводятся. */
export interface TemplateInfo {
  key: string;
  category: Exclude<NotificationCategory, "service">;
  /** детский вариант (адресат — опекун, имя ребёнка): проверка «без давления» при сохранении */
  kid: boolean;
  description: { ru: string; en: string };
  placeholders: TemplatePlaceholder[];
  /** тексты по умолчанию (из кода) с образцами значений — для сравнения и сброса */
  default_texts: TemplateTexts;
  active_version: number | null;
  active_since: string | null;
  updated_at: string | null;
}

export interface TemplateVersion {
  key: string;
  version: number;
  status: TemplateVersionStatus;
  texts: TemplateTexts;
  note: string;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  activated_by: string | null;
  activated_by_name: string | null;
  activated_at: string | null;
}

export interface TemplateVersionCreate {
  texts: TemplateTexts;
  note: string; // 3..300
}

export interface TemplatePreviewRequest {
  lang: UiLang;
  /** значения плейсхолдеров; нет — образцы из TemplatePlaceholder.sample */
  sample?: Record<string, string>;
}
export interface TemplatePreview {
  lang: UiLang;
  title: string;
  body: string;
  button: string | null;
  /** как увидит ученик в Telegram (простой текст) */
  telegram_text: string;
}

/** Тестовая отправка — только в чаты из ADMIN_TEST_CHAT_IDS notifications (выбор по индексу в списке, сами id
 *  в админку не отдаются полностью). */
export interface TestRecipient {
  index: number;
  label: string; // маска: «Тестовый чат 1 (••••4821)»
}
export interface TestSendRequest {
  lang: UiLang;
  recipient: number; // TestRecipient.index
}
export interface TestSendResult {
  sent: boolean;
  /** delivery_id для поиска в журнале; null — бот не принял сообщение */
  delivery_id: string | null;
  error: string | null;
}

/**
 *  GET  /admin/v1/notifications/templates → {items: TemplateInfo[]}
 *  GET  /admin/v1/notifications/templates/{key} → TemplateInfo & {versions: TemplateVersion[]} (новые первыми, ≤ 50)
 *  POST /admin/v1/notifications/templates/{key}/versions TemplateVersionCreate (Idempotency-Key) → 201 TemplateVersion
 *       (draft); 422 TEMPLATE_INVALID {fields: Array<{path, reason}>} — пустой язык, неизвестный плейсхолдер,
 *       слишком длинно, давление в детском шаблоне; 404 TEMPLATE_NOT_FOUND
 *  POST /admin/v1/notifications/templates/{key}/versions/{v}/preview TemplatePreviewRequest → TemplatePreview
 *  POST /admin/v1/notifications/templates/{key}/versions/{v}/activate {reason} (step-up) → TemplateVersion (active;
 *       прежняя активная → archived). Повтор — 200 без изменений.
 *  POST /admin/v1/notifications/templates/{key}/reset {reason} (step-up) → TemplateInfo (тексты по умолчанию; активная
 *       версия → archived)
 *  GET  /admin/v1/notifications/test-recipients → {items: TestRecipient[]} (пусто — тест недоступен)
 *  POST /admin/v1/notifications/templates/{key}/versions/{v}/test TestSendRequest → TestSendResult;
 *       422 TEST_RECIPIENT_NOT_ALLOWED; 429 RATE_LIMITED (≤ 10 тестов в минуту на сотрудника)
 *  Откат — активация любой прежней версии или reset. Аудит: template.version_created | activated | reset | test_sent.
 *  Новые напоминания отрисовываются активной версией сразу после активации (уже созданные записи — прежним текстом).
 */
export interface TemplateActivateInput {
  reason: string;
}

// =====================================================================================================================
// Рассылки (notif.campaigns.manage / notif.campaigns.send) — notifications; категория product
// =====================================================================================================================

export type CampaignStatus = "draft" | "scheduled" | "sending" | "done" | "stopped";

/** Кому: только ученики с действующим согласием product_news и включённой категорией product. Детские профили
 *  исключены всегда; подростки — только если age содержит "teens" (и есть согласие родителя). Пустой сегмент —
 *  все взрослые (age по умолчанию ["adults"]). */
export interface CampaignSegment {
  ui_lang?: UiLang[];
  age?: Array<Exclude<AgeSegment, "kids">>;
  /** true — только прошедшие онбординг; false — только не прошедшие; нет — все */
  onboarded?: boolean;
  /** активность: занимались за последние N дней (1..90); отрицательное — НЕ занимались N дней (возврат) */
  active_days?: number;
}

/** title ≤ 80, body ≤ 1000, button ≤ 32; RU и UZ обязательны оба; плейсхолдер — только {learner_name}. */
export interface CampaignContent {
  title: string; // внутреннее название рассылки, ≤ 120
  texts: TemplateTexts;
  /** куда ведёт кнопка: маршрут Mini App; null — без кнопки */
  route: ReleaseNoteRoute | null;
  segment: CampaignSegment;
}

export interface CampaignStats {
  /** оценка аудитории на момент запуска */
  audience: number;
  created: number;
  sent: number;
  /** только центр уведомлений (Telegram выключен у ученика) */
  in_app_only: number;
  /** отложены до конца тихих часов ученика */
  deferred: number;
  /** пропущены: лимит частоты рассылок */
  skipped_frequency: number;
  failed: number;
}

export interface Campaign extends CampaignContent {
  campaign_id: string;
  status: CampaignStatus;
  version: number;
  send_at: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  scheduled_by: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  stopped_by: string | null;
  /** имена сотрудников (admin-bff через staff/lookup; ревью T2-6) */
  scheduled_by_name: string | null;
  stopped_by_name: string | null;
  stopped_at: string | null;
  stop_reason: string | null;
  stats: CampaignStats;
  /** шаг отправки не удаётся (например, identity-consent отклоняет сегмент): код последней ошибки, с какого момента
   *  и сколько попыток; null — всё в порядке. После 6 неудач подряд — аудит campaign.failed (ревью P2-7). */
  last_error: { code: string; since: string; attempts: number } | null;
}

export interface CampaignEstimate {
  audience: number;
  by_lang: Record<UiLang, number>;
  /** ученики, которым рассылка не уйдёт из-за лимита частоты (оценка) */
  frequency_capped: number;
  computed_at: string;
}

/**
 *  GET   /admin/v1/notifications/campaigns?status=&cursor=&limit= (notif.campaigns.manage) → Page<Campaign>
 *  GET   /admin/v1/notifications/campaigns/{id} → Campaign; 404 CAMPAIGN_NOT_FOUND
 *  POST  /admin/v1/notifications/campaigns CampaignContent (Idempotency-Key обязателен) → 201 Campaign (draft);
 *        422 CAMPAIGN_INVALID {fields}
 *  PATCH /admin/v1/notifications/campaigns/{id} Partial<CampaignContent> & {expected_version} → Campaign;
 *        409 CAMPAIGN_NOT_DRAFT | CAMPAIGN_VERSION_CONFLICT {current_version}
 *  POST  /admin/v1/notifications/campaigns/{id}/estimate → CampaignEstimate
 *  POST  /admin/v1/notifications/campaigns/{id}/preview TemplatePreviewRequest → TemplatePreview
 *  POST  /admin/v1/notifications/campaigns/{id}/test TestSendRequest → TestSendResult
 *  POST  /admin/v1/notifications/campaigns/{id}/schedule CampaignScheduleInput (notif.campaigns.send, step-up,
 *        Idempotency-Key) → Campaign; send_at=null — «Отправить сейчас»: старт сразу, ответ уже в статусе sending
 *        (первая пачка — в фоне; D2-03); send_at ближе 1 мин (в т. ч. до 5 мин в прошлом) — так же «как можно
 *        скорее» (совместимость); раньше now−5 мин → 422 CAMPAIGN_INVALID {send_at: in_past} (ревью T2-2); позже 30 дней → 422; 409 CAMPAIGN_NOT_DRAFT | CAMPAIGN_VERSION_CONFLICT; аудитория 0 → 422 CAMPAIGN_EMPTY_AUDIENCE
 *  POST  /admin/v1/notifications/campaigns/{id}/unschedule {reason} (notif.campaigns.send) → Campaign (draft) —
 *        только до начала отправки; 409 CAMPAIGN_ALREADY_SENDING
 *  POST  /admin/v1/notifications/campaigns/{id}/stop CampaignStopInput (notif.campaigns.send, step-up) → Campaign
 *        (stopped) — экстренная остановка: новые записи не создаются, неотправленные отменяются. Повтор — 200.
 *        Допустимо из scheduled | sending | done (у done отменяются отложенные тихими часами); draft → 409
 *        CAMPAIGN_NOT_ACTIVE (ревью P2-7).
 *  Отправка: в момент send_at; ученикам в тихих часах — после их окончания по местному времени ученика; не чаще 1 рассылки в 7 дней на ученика (CAMPAIGN_MIN_INTERVAL_DAYS).
 *  Аудит: campaign.created | updated | scheduled | unscheduled | stopped | finished | test_sent.
 */
export interface CampaignScheduleInput {
  expected_version: number;
  /** null — «Отправить сейчас» по часам сервера: рассылка запускается сразу при этой команде, без ожидания
   *  ближайшего notifications:dispatch (QA D2-03, ревью T2-11 — часы браузера не участвуют). */
  send_at: string | null;
  reason: string;
}
export interface CampaignStopInput {
  reason: string;
}

export type NotificationsErrorCode =
  | "TEMPLATE_NOT_FOUND"
  | "TEMPLATE_INVALID"
  | "TEMPLATE_VERSION_NOT_FOUND"
  | "TEST_RECIPIENT_NOT_ALLOWED"
  | "CAMPAIGN_NOT_FOUND"
  | "CAMPAIGN_INVALID"
  | "CAMPAIGN_NOT_DRAFT"
  | "CAMPAIGN_VERSION_CONFLICT"
  | "CAMPAIGN_EMPTY_AUDIENCE"
  | "CAMPAIGN_ALREADY_SENDING"
  | "CAMPAIGN_NOT_ACTIVE";

// =====================================================================================================================
// Dev
// =====================================================================================================================
/** POST /admin/v1/dev/impersonate {role: RoleCode | null} — только ENV=dev (иначе 404): права сужаются до роли
 * для предпросмотра меню; расширить права сверх своих нельзя (403 IMPERSONATION_NOT_ALLOWED {role}). */

// =====================================================================================================================
// Контент и диагностика (спринт 3) — catalog и diagnostics через admin-bff. Форматы тел — ./content.ts.
// Права: content.read — чтение; content.edit — черновики; content.review — проверка (не своих: 409 SELF_REVIEW);
// content.publish — публикация/архив/откат (step-up); media.rights — права медиа и заявки (step-up);
// lang.manage — языки и пары (step-up).
// =====================================================================================================================

export interface ContentValidationError {
  path: string; // "payload.title.uz", "payload.nodes.n4.transitions[0].to"
  code: string; // LOCALE_MISSING, UNKNOWN_REF, PREREQ_CYCLE, NO_CONTROL_ITEMS, RIGHTS_REQUIRED, …
  message: string;
}

/** Строка списка сущностей вида. */
export interface ContentRow {
  kind: ContentKind;
  key: string;
  title: ContentLocalized;
  published_version: number | null;
  latest_version: number;
  latest_status: VersionStatus;
  level: Band | null;
  updated_at: string;
  updated_by_name: string | null;
  /** media_asset: истекает ли лицензия в ≤ 14 дней / уже приостановлен */
  rights_warning: "expiring" | "expired" | null;
}

export interface ContentVersionMeta {
  version: number;
  status: VersionStatus;
  author_id: string;
  author_name: string | null;
  created_at: string;
  submitted_at: string | null;
  reviewer_id: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  locale_checks: { ru: LocaleCheck; uz: LocaleCheck };
  rights_approved_by: string | null;
  rights_approved_by_name: string | null;
  rights_approved_at: string | null;
  published_by: string | null;
  published_by_name: string | null;
  published_at: string | null;
  archived_at: string | null;
  suspended_at: string | null;
  suspend_reason: "rights_expired" | "rights_revoked" | null;
}

export interface ContentVersion<P = Record<string, unknown>> extends ContentVersionMeta {
  kind: ContentKind;
  key: string;
  payload: P;
  payload_hash: string;
  /** scenario: последний тестовый прогон этой версии (null — не было или устарел) */
  test_run: ScenarioTestRun | null;
}

/**
 *  GET  /admin/v1/content/{kind}?q=&status=&level=&cursor=&limit= (content.read) → Page<ContentRow>
 *  GET  /admin/v1/content/{kind}/{key} (content.read) → {row: ContentRow, versions: ContentVersionMeta[]}
 *  GET  /admin/v1/content/{kind}/{key}/versions/{v} (content.read) → ContentVersion
 *  POST /admin/v1/content/{kind} {payload} (content.edit, Idempotency-Key) → 201 ContentVersion (v1, draft);
 *       409 CONTENT_KEY_EXISTS; 422 CONTENT_INVALID {errors: ContentValidationError[]} (только схема)
 *  POST /admin/v1/content/{kind}/{key}/versions {from_version} (content.edit) → 201 черновик-копия;
 *       409 DRAFT_EXISTS {version} — у ключа уже есть черновик или версия на проверке
 *  PUT  /admin/v1/content/{kind}/{key}/versions/{v} {payload, expected_hash} (content.edit) → ContentVersion;
 *       409 VERSION_NOT_DRAFT | VERSION_CONFLICT {payload_hash}; ключ в payload менять нельзя (422)
 *  POST …/versions/{v}/validate (content.read) → {ok: boolean, errors: ContentValidationError[]} — сухая проверка
 *       в режиме публикации
 *  POST …/versions/{v}/submit (content.edit) → ContentVersion (in_review); 422 CONTENT_INVALID
 *  POST …/versions/{v}/review ContentReviewInput (content.review) → ContentVersion (approved | draft);
 *       409 SELF_REVIEW — автор не проверяет свою версию
 *  POST …/versions/{v}/publish {reason} (content.publish, step-up, Idempotency-Key) → ContentVersion (published);
 *       422 CONTENT_INVALID (целостность курса, локализации, права, тестовый прогон); 409 VERSION_NOT_APPROVED
 *  POST /admin/v1/content/{kind}/{key}/archive {reason} (content.publish, step-up) → {row}; 409 CONTENT_IN_USE {refs}
 *  POST /admin/v1/content/{kind}/{key}/rollback {to_version, reason} (content.publish, step-up) → ContentVersion
 *  POST /admin/v1/content/scenario/{key}/versions/{v}/test-run (content.edit) → ScenarioTestRun
 *  POST /admin/v1/content/media_asset/{key}/versions/{v}/rights-approve {note} (media.rights, step-up) → ContentVersion
 *  POST /admin/v1/content/blobs AudioUpload (content.edit; тело ≤ 4,5 МБ) → AudioBlob;
 *       422 AUDIO_INVALID (тип, размер > 3 МБ, сигнатура файла)
 *  GET  /admin/v1/content/blobs/{blob_id} (content.read) → аудио для предпросмотра
 *  GET  /admin/v1/content/review-queue?kind=&cursor= (content.review) → Page<ContentRow> — на проверке, не мои
 *  GET  /admin/v1/content/summary (dashboard.read | content.read) → ContentSummary
 *  Аудит: content.version_created | updated | submitted | reviewed | returned | published | archived | rolled_back |
 *  rights_approved | test_run, media.suspended (system).
 */
export interface ContentReviewInput {
  decision: "approve" | "return";
  note: string; // 3..1000
  /** при approve обе должны быть checked */
  locale_checks: { ru: LocaleCheck; uz: LocaleCheck };
}
export interface ContentPublishInput {
  reason: string;
}
export interface ContentRollbackInput {
  to_version: number;
  reason: string;
}
export interface AudioUpload {
  filename: string;
  content_type: "audio/mpeg" | "audio/ogg" | "audio/mp4";
  data_base64: string;
}
export interface AudioBlob {
  blob_id: string;
  content_type: string;
  size: number;
  sha256: string;
  created_at: string;
}

export interface ContentSummary {
  by_kind: Record<ContentKind, { published: number; drafts: number; in_review: number }>;
  in_review: number;
  /** медиа с лицензией, истекающей в ≤ 14 дней */
  rights_expiring: Array<{ asset_id: string; title: ContentLocalized; valid_to: string }>;
  suspended_media: number;
  new_media_requests: number;
}

// ---------- Заявки учеников на песни и фильмы (ADM-MEDIA-04) ----------
export interface AdminMediaRequest {
  request_id: string;
  /** null — ученик удалён (заявка анонимизирована) */
  user_id: string | null;
  kind: "song" | "movie" | "series" | "other";
  title: string;
  link: string | null;
  comment: string | null;
  ui_locale: "ru" | "uz";
  status: MediaRequestStatus;
  decision_note: string | null;
  linked_asset_id: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  created_at: string;
  /** сколько ещё заявок с похожим названием (нормализованным) */
  similar_count: number;
}
/** GET /admin/v1/content/media-requests?status=&q=&cursor= (media.rights — в заявке ссылка и свободный комментарий
 *  ученика, минимизация доступа к персональным данным) → Page<AdminMediaRequest>
 *  POST /admin/v1/content/media-requests/{id}/take (media.rights) → in_review
 *  POST /admin/v1/content/media-requests/{id}/decide MediaRequestDecision (media.rights, step-up) → AdminMediaRequest;
 *       уведомление ученику (шаблон media_request.decided). Ссылка ученика НЕ открывается и НЕ скачивается сервером. */
export interface MediaRequestDecision {
  status: "authored_alternative" | "licensed" | "rejected" | "duplicate";
  note: string; // 3..500, видна ученику
  linked_asset_id?: string; // опубликованный media_asset (для authored_alternative | licensed)
}

// ---------- Языки и пары (ADM-LANG-01/02) ----------
export interface PairCard extends LanguagePair {
  readiness: {
    skills: number;
    lessons_published: number;
    scenarios_published: number;
    rubrics_published: number;
    media_published: number;
    diagnostic_test: string | null; // "dx-en-adult@1"
    locales_checked_pct: number; // доля опубликованных сущностей курса с ru и uz = checked
  };
  learners: number; // учеников с активной парой (из diagnostics)
}
/** GET /admin/v1/languages (content.read) → {items: Language[]}; PUT /admin/v1/languages/{code} Language
 *  (lang.manage, step-up) → Language. GET /admin/v1/language-pairs (content.read) → {items: PairCard[]};
 *  PUT /admin/v1/language-pairs/{pair_id} LanguagePair & {reason} (lang.manage, step-up) → PairCard —
 *  перевод в published только при опубликованном курсе и тесте диагностики (422 PAIR_NOT_READY {missing}). */

// ---------- Диагностика (тесты, статистика) ----------
export interface DiagnosticTestRow {
  test_id: string; // dx-en-adult
  pair_id: string;
  audience: "adults" | "kids";
  published_version: number | null;
  versions: Array<{ version: number; status: "draft" | "published" | "archived"; items: number; published_at: string | null }>;
}
export interface DiagnosticTestVersion {
  test_id: string;
  version: number;
  status: "draft" | "published" | "archived";
  config: Record<string, unknown>;
  /** с ключами ответов — только для content.read */
  items: Array<Record<string, unknown>>;
  coverage: Record<string, Record<Band, number>>; // area → band → число заданий
}
export interface DiagnosticStats {
  period: Period;
  started: number;
  finished: number;
  median_minutes: number | null;
  by_level: Record<Band | "none", number>;
  /** проценты 0–100, один знак после запятой */
  not_assessed_pct: Record<"vocabulary" | "grammar" | "reading" | "listening", number>;
  followups: number;
}
/** GET /admin/v1/diagnostics/tests (content.read) → {items: DiagnosticTestRow[]};
 *  GET /admin/v1/diagnostics/tests/{id}/versions/{v} (content.read) → DiagnosticTestVersion;
 *  POST /admin/v1/diagnostics/tests/{id}/versions/{v}/publish {reason} (content.publish, step-up) → DiagnosticTestRow;
 *  GET /admin/v1/diagnostics/stats?period= (dashboard.read) → DiagnosticStats */
export type { Language, LanguagePair };

// =====================================================================================================================
// ИИ, контроль диалогов, затраты (спринт 4) — ai-gateway, lessons, assessment через admin-bff. Типы агентов — ./ai.ts.
// Права: ai.read / ai.manage / ai.publish (step-up); qa.read / qa.transcripts (причина, аудит) / qa.review (step-up);
// costs.read / costs.manage (step-up). Ключ провайдера ИИ в админке не показывается и не вводится (переменная
// ai-gateway; в UI — только «задан / не задан»).
// =====================================================================================================================

// ---------- Агенты и скиллы (ADM-AGENT-01…05) ----------
export interface AgentRow extends Agent {
  rollout: AgentRollout | null; // только llm
  published: { version: number; model_id: string; published_at: string; published_by_name: string | null } | null;
  draft_version: number | null;
  last_test_run: TestRunSummary | null;
  calls_7d: number;
  unavailable_pct_7d: number | null; // 0–100
}
/** GET /admin/v1/ai/agents (ai.read) → {items: AgentRow[]}
 *  GET /admin/v1/ai/agents/{agent_id} (ai.read) → AgentRow & {versions: AgentVersionRow[]}
 *  GET /admin/v1/ai/agents/{agent_id}/versions/{v} (ai.read) → AgentVersion & names
 *  POST /admin/v1/ai/agents/{agent_id}/versions {from_version?} (ai.manage) → AgentVersion (черновик; 409 DRAFT_EXISTS)
 *  PATCH /admin/v1/ai/agents/{agent_id}/versions/{v} AgentVersionPatch (ai.manage; только draft — 409 VERSION_NOT_DRAFT;
 *    If-Match: updated_at → 409 VERSION_CONFLICT) → AgentVersion; DELETE …/versions/{v} (ai.manage, draft) → 204
 *  POST /admin/v1/ai/agents/{agent_id}/versions/{v}/test-runs (ai.manage) → TestRunSummary (202; опрос GET …/test-runs/{run_id} → TestRun)
 *  POST /admin/v1/ai/agents/{agent_id}/versions/{v}/publish {reason} (ai.publish, step-up) → AgentRow;
 *    422 TESTS_REQUIRED | TESTS_FAILED {case_ids}
 *  PUT /admin/v1/ai/agents/{agent_id}/canary {version, percent 1..50, reason} (ai.publish, step-up) → AgentRow;
 *  DELETE /admin/v1/ai/agents/{agent_id}/canary {reason} (ai.publish, step-up) → AgentRow
 *  POST /admin/v1/ai/agents/{agent_id}/rollback {reason} (ai.publish, step-up) → AgentRow (409 NO_PREVIOUS_VERSION)
 *  GET|POST /admin/v1/ai/agents/{agent_id}/golden-cases (ai.read | ai.manage) → {items: GoldenCase[]} | GoldenCase;
 *  PATCH|DELETE /admin/v1/ai/golden-cases/{case_id} (ai.manage) — удаление = архив */
/** GET /admin/v1/ai/agents/{agent_id} → AgentDetail; GET|POST|PATCH версии → AgentVersionView */
export interface AgentDetail extends AgentRow {
  versions: AgentVersionRow[];
}
export interface AgentVersionView extends AgentVersion {
  author_name: string | null;
  published_by_name: string | null;
}
export interface AgentVersionRow {
  version: number;
  status: AgentVersion["status"];
  model_id: string;
  author_name: string | null;
  created_at: string;
  published_at: string | null;
  published_by_name: string | null;
  last_test_run: TestRunSummary | null;
  canary: boolean;
}
export type AgentVersionPatch = Partial<Pick<AgentVersion,
  "instructions" | "rules" | "output_schema" | "schema_version" | "model_id" | "fallback_model_id" | "temperature" |
  "max_output_tokens" | "timeout_ms" | "max_cost_usd" | "notes">>;
export type GoldenCaseInput = Pick<GoldenCase, "title" | "input" | "checks" | "mandatory">;

// ---------- Модели и затраты (ADM-AGENT-05, ADM-MONEY-01/02) ----------
/** GET /admin/v1/ai/models (ai.read) → {items: AiModel[]}; PUT /admin/v1/ai/models/{model_id} {input_usd_per_mtok,
 *  output_usd_per_mtok, audio_usd_per_hour? (только модели речи, спринт 5), active, reason} (ai.publish, step-up) → AiModel.
 *  Цена не того вида (audio для LLM, токены для речи) → 422 PRICE_NOT_APPLICABLE. Модель whisper (свой сервер, релиз
 *  5.1) бесплатна: правится только active, ненулевая цена часа → 422 PRICE_NOT_APPLICABLE.
 *  GET /admin/v1/ai/provider (ai.read) → AiProviderStatus.
 *  GET /admin/v1/ai/budget (costs.read) → AiBudget; PUT /admin/v1/ai/budget AiBudget-поля & {reason, updated_at
 *  (прочитанного бюджета; иначе 409 BUDGET_CONFLICT {updated_at} — лимиты изменил другой сотрудник)} (costs.manage,
 *  step-up) → AiBudget; POST /admin/v1/ai/emergency-stop {enabled: boolean, reason} (costs.manage, step-up) → AiBudget:
 *  enabled=true — аварийная остановка включена (ИИ выключен, AiBudget.ai_enabled=false), false — снята.
 *  GET /admin/v1/ai/usage/summary?period=day|week|month (costs.read) → AiUsageSummary.
 *  GET /admin/v1/ai/usage?session_id=|agent_id=&cursor= (costs.read | qa.read для session_id) → Page<AiCall>. */
export interface AiUsageSummary {
  period: "day" | "week" | "month";
  spent_usd: number;
  monthly_cap_usd: number;
  /** доля потолка месяца, 0–100 */
  cap_used_pct: number;
  calls: number;
  unavailable: number;
  unavailable_pct: number | null; // 0–100
  p95_latency_ms: number | null;
  by_agent: Array<{ agent_id: AgentId; calls: number; spent_usd: number; unavailable: number }>;
  by_model: Array<{ model_id: string; calls: number; input_tokens: number; output_tokens: number; spent_usd: number }>;
  by_day: Array<{ date: string; spent_usd: number; calls: number }>;
  avg_cost_per_lesson_usd: number | null;
  ai_enabled: boolean;
  alert_percent: number; // порог предупреждения из AiBudget (1–100) — обзору не нужен отдельный GET /ai/budget
  /** спринт 5: оценка произношения (агент pronunciation_coach) — входит в spent_usd */
  speech: { calls: number; audio_minutes: number; spent_usd: number; speech_available: boolean;
            /** подлимит речи (AiBudget.speech_monthly_cap_usd) */ cap_usd: number };
}
export interface AiCall {
  call_id: string;
  agent_id: AgentId;
  version: number | null;
  model_id: string | null;
  status: "ok" | "unavailable" | "refused";
  /** у status ok бывает не null: речь insufficient_evidence (not_recognized | low_confidence | incomplete) */
  reason: string | null;
  /** речь (спринт 5): длительность аудио; LLM — 0 */
  audio_ms?: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  session_id: string | null;
  canary: boolean;
  created_at: string;
}

// ---------- Контроль диалогов (ADM-QA-01…04) ----------
export type SessionFlag = "ai_used" | "ai_unavailable" | "hints" | "human_review" | "appealed" | "flagged" | "failed";
export interface SessionRow {
  session_id: string;
  kind: SessionKind;
  title: ContentLocalized;
  lesson_id: string | null;
  scenario_id: string | null;
  asset_id: string | null;
  reading_id: string | null; // спринт 5: сессия чтения
  level: Band | null;
  status: "ready" | "in_progress" | "paused" | "completed" | "failed" | "cancelled";
  outcome: "success" | "alt_success" | "fail" | null;
  passed: boolean | null;
  minutes: number;
  audience: "kids" | "teens" | "adults";
  ai_mode: "full" | "choices";
  models: string[];
  /** null — ai-gateway недоступен (стоимость неизвестна, не 0) */
  cost_usd: number | null;
  p95_latency_ms: number | null;
  flags: SessionFlag[];
  started_at: string | null;
  finished_at: string | null;
}
/** GET /admin/v1/qa/sessions?from=&to=&kind=&status=&outcome=&flag=&lesson_id=&level=&cursor= (qa.read) → Page<SessionRow>
 *  GET /admin/v1/qa/sessions/{id} (qa.read) → SessionCard (блоки lessons / assessment / ai-gateway независимы)
 *  POST /admin/v1/qa/sessions/{id}/transcript {reason ≥ 10} (qa.transcripts) → Transcript (аудит qa.transcript_viewed)
 *  POST /admin/v1/qa/evaluations/{id}/flag {reason} (qa.read) → EvaluationCard
 *  POST /admin/v1/qa/evaluations/{id}/reevaluate Reevaluation (qa.review, step-up) → EvaluationCard
 *    409 EVALUATION_SUPERSEDED | SELF_REEVALUATION (не свою оценку как ученика — не применяется к сотрудникам)
 *  GET /admin/v1/qa/appeals?status=&cursor= (qa.read) → Page<AdminAppeal>
 *  POST /admin/v1/qa/appeals/{id}/take (qa.review) → AdminAppeal
 *  POST /admin/v1/qa/appeals/{id}/decide AppealDecision (qa.review, step-up) → AdminAppeal
 *  Постановка задачи (ADM-QA-04) — формирует admin-web из SessionCard (без запроса). */
export interface SessionCard {
  session: SessionRow & {
    user_ref: string; // псевдоним: 8 hex HMAC-SHA256(user_id, секрет lessons) — не user_id и не обратим без секрета
    content_versions: Record<string, number>; // lesson, scenario, rubric, media_asset; media_exercise:<id>, retrieval:<lesson_id>
    status_history: Array<{ from: string | null; to: string; reason: string; at: string }>;
    steps: Array<{ step_id: string; stage: string; type: string; result: "correct" | "incorrect" | "skipped" | null; hinted: boolean; answered_at: string | null }>;
    turns_meta: Array<{ turn_id: string; speaker: "learner" | "character"; mode: "choice" | "text"; intent: string | null; ai_call_id: string | null; redacted: boolean }>;
  } | null;
  evaluations: EvaluationCard[] | null; // цепочка: исходная и переоценки (новая — последней)
  ai_calls: AiCall[] | null;
  errors: Partial<Record<"lessons" | "assessment" | "ai-gateway", string>>; // блок недоступен — код
}
export interface Transcript {
  session_id: string;
  turns: Array<{ turn_id: string; speaker: "learner" | "character"; text: string | null; mode: "choice" | "text"; redacted: boolean }>;
  answers: Array<{ step_id: string; item_id: string; answer: string | null }>;
  open_answer: string | null;
}
export interface EvaluationCard {
  evaluation_id: string;
  session_id: string;
  status: "ok" | "partial" | "insufficient_evidence" | "pending_review";
  rubric: { rubric_id: string; version: number };
  scores: Array<{ code: RubricCriterionCode; score: 0 | 1 | 2 | 3 | null }>;
  weighted: number | null;
  passed: boolean | null;
  task_completed: boolean | null;
  confirmed_errors: ConfirmedError[];
  items: Array<{ item_id: string; skill_id: string; correct: boolean; hinted: boolean }>;
  skill_outcomes: Array<{ skill_id: string; outcome: "demonstrated" | "learning" | "not_assessed" }>;
  evaluator: { agent_id: AgentId; agent_version: number; prompt_version: string; model_id: string; schema_version: string; canary: boolean } | null;
  requires_human_review: boolean;
  practice_only: boolean;
  supersedes: string | null;
  created_by_name: string | null; // null — система
  reason: string | null; // основание переоценки
  flags: Array<{ reason: string; by_name: string | null; at: string }>;
  created_at: string;
}
export interface Reevaluation {
  scores: Partial<Record<RubricCriterionCode, 0 | 1 | 2 | 3 | null>>;
  skill_outcomes: Array<{ skill_id: string; outcome: "demonstrated" | "learning" | "not_assessed" }>;
  confirmed_errors: ConfirmedError[];
  reason: string; // ≥ 10
  appeal_id: string | null;
}
export interface AdminAppeal {
  appeal_id: string;
  evaluation_id: string;
  session_id: string;
  status: "new" | "in_review" | "upheld" | "corrected";
  reason: string | null; // текст ученика — сотрудникам с qa.read (без PII); null — стёрт по сроку хранения
  reason_redacted: boolean; // текст стёрт через 90 дней после решения (показывать «удалён по сроку хранения»)
  decision_note: string | null;
  taken_by_name: string | null;
  decided_by_name: string | null;
  new_evaluation_id: string | null;
  created_at: string;
  decided_at: string | null;
}
export interface AppealDecision {
  decision: "upheld" | "corrected";
  note: string; // 10..500, видна ученику
  new_evaluation_id: string | null; // для corrected — переоценка, сделанная по этой апелляции
}

// ---------- Обзор (спринт 4) ----------
export interface LessonStats {
  period: Period;
  started: number;
  completed: number;
  completion_pct: number | null; // 0–100
  median_minutes: number | null;
  by_kind: Record<SessionKind, number>;
  ai_degraded_pct: number | null; // доля сессий в упрощённом режиме, 0–100
  appeals_open: number;
  human_review_open: number;
}

export type { Agent, AgentId, AgentRollout, AgentVersion, AiBudget, AiModel, AiProviderStatus, GoldenCase, TestRun, TestRunSummary };

// =====================================================================================================================
// =====================================================================================================================
// Память, словарь курса, чтение (спринт 5) — memory и catalog через admin-bff.
// Права: memory.read — очередь, история планирования, проверки, аналитика (без текста ученика: цитаты ошибок не
// показываются); memory.manage — ручная правка одной карточки (step-up, причина ≥ 10, аудит memory.card_adjusted);
// glossary.manage — словарь курса и модерация переводов ИИ (аудит glossary.*). Тексты для чтения — общий API контента
// (ContentKind "reading", права content.*). Аналитика — только агрегаты: группы меньше 5 учеников скрыты.
// =====================================================================================================================

// ---------- Словарь курса (catalog) ----------
/** GET /admin/v1/glossary?pair_id=&q=&source=&review_status=&cursor= (content.read) → Page<GlossaryRow>.
 *  Очередь переводов ИИ — review_status=pending (сортировка по числу мест в контенте).
 *  GET /admin/v1/glossary/{entry_id} (content.read) → GlossaryDetail.
 *  POST /admin/v1/glossary GlossaryCreate (glossary.manage) → GlossaryDetail (201); 409 FORM_TAKEN {entry_id}.
 *  PATCH /admin/v1/glossary/{entry_id} GlossaryPatch (glossary.manage; If-Match: updated_at → 428 IF_MATCH_REQUIRED /
 *    409 VERSION_CONFLICT) → GlossaryDetail. Статья course — только override (null — снять).
 *  POST /admin/v1/glossary/{entry_id}/review GlossaryReview (glossary.manage) → GlossaryDetail; 409 NOT_PENDING.
 *  DELETE /admin/v1/glossary/{entry_id} {reason} (glossary.manage; только methodist, иначе 409 ARCHIVE_NOT_ALLOWED) → 204.
 *  GET /admin/v1/glossary/stats?pair_id= (dashboard.read | content.read) → GlossaryStats.
 *  Коды: 404 GLOSSARY_ENTRY_NOT_FOUND; 409 ENTRY_ARCHIVED | OVERRIDE_COURSE_ONLY; 422 GLOSSARY_INVALID {errors} (в т. ч.
 *  COURSE_ENTRY_LOCKED — правка полей статьи course: у неё только override). Форму отклонённого перевода ИИ методист может занять своей
 *  статьёй (отклонённая архивируется). */
export interface GlossaryStats {
  pair_id: string | null;
  ai_glosses_pending: number;
  ai_approved: number;
  ai_rejected: number;
  entries: { course: number; methodist: number; ai: number };
  overridden: number;
}
export interface GlossaryRow {
  entry_id: string;
  pair_id: string;
  lemma: string;
  forms: string[];
  part_of_speech: PartOfSpeech | null;
  gloss: ContentLocalized;
  source: GlossarySource;
  review_status: GlossaryReviewStatus;
  confidence: number | null;
  refs_count: number;
  overridden: boolean;
  updated_at: string;
  updated_by: string | null; // staff_id
  updated_by_name: string | null;
}
export interface GlossaryDetail extends GlossaryEntry {
  updated_by_name: string | null;
  /** названия мест в контенте для ref (null — снято с публикации) */
  refs_titles: Array<GlossaryRef & { title: ContentLocalized | null }>;
  history: Array<{ at: string; by: string | null; by_name: string | null; action: "created" | "updated" | "reviewed" | "archived" | "overridden";
                   before: Partial<GlossaryEntry> | null; after: Partial<GlossaryEntry> | null; reason: string | null }>;
  /** статьи course: перевод в другом месте контента отличается от действующего — подсказка методисту */
  conflicts: Array<{ ref: GlossaryRef; gloss: ContentLocalized }>;
}
export interface GlossaryCreate {
  pair_id: string;
  lemma: string; // ≤ 60
  forms: string[]; // 1..8
  part_of_speech: PartOfSpeech | null;
  gloss: ContentLocalized; // ≤ 80
  example_en: string | null; // ≤ 200
  reason: string | null;
}
export interface GlossaryPatch {
  lemma?: string;
  forms?: string[];
  part_of_speech?: PartOfSpeech | null;
  gloss?: ContentLocalized;
  example_en?: string | null;
  /** только для source course: перевод и пример поверх контента; null — снять */
  override?: { gloss: ContentLocalized; example_en: string | null } | null;
  reason?: string | null;
}
export interface GlossaryReview {
  decision: "approve" | "correct" | "reject";
  gloss?: ContentLocalized; // для correct — обязателен
  note?: string | null; // ≤ 300
}

// ---------- Память ученика (memory) ----------
export type AdminCardStatus = "new" | "learning" | "review" | "known" | "frozen" | "archived";

/** GET /admin/v1/memory/learners/{user_id} (memory.read) → LearnerMemorySummary.
 *  Ученик — по user_id из карточки ученика (Ученики → карточка → «Память»). */
export interface LearnerMemorySummary {
  user_id: string;
  pair_id: string | null;
  cards_by_status: Record<AdminCardStatus, number>;
  due_now: number;
  overdue_7d: number; // просрочено больше 7 дней
  reviews_30d: number;
  last_review_at: string | null;
  checks: RetentionCheckRow[]; // последние 20
}
export interface RetentionCheckRow {
  check_id: string;
  skill_id: string;
  skill_title: ContentLocalized | null;
  stage: "d7" | "d30";
  status: "scheduled" | "in_session" | "passed" | "failed" | "cancelled";
  due_at: string;
  checked_at: string | null;
  result: { correct: number; total: number } | null;
  consecutive_failures: number;
}

/** GET /admin/v1/memory/learners/{user_id}/cards?status=&kind=&cursor= (memory.read) → Page<AdminCardRow> */
export interface AdminCardRow {
  card_id: string;
  kind: "word" | "phrase" | "error";
  /** null у карточек ошибок: исправление выведено из свободного текста ученика (может содержать его данные) — в
   *  админке показываются только error_code и его подпись (тексты ученика — только qa.transcripts в «Контроле диалогов») */
  text_en: string | null;
  gloss: ContentLocalized;
  status: AdminCardStatus;
  stability: number | null; // дни
  difficulty: number | null; // 1..10
  retrievability: number | null; // 0..1 на сейчас
  reps: number;
  lapses: number;
  due_at: string | null;
  last_review_at: string | null;
  error_code: string | null;
}

/** GET /admin/v1/memory/cards/{card_id} (memory.read) → AdminCardDetail. Цитата ошибки ученика не показывается. */
export interface AdminCardDetail extends AdminCardRow {
  user_id: string;
  example_en: string | null;
  sources: Array<{ kind: string; key: string | null; version: number | null; at: string }>;
  log: Page<ReviewLogRow>; // первая страница; дальше GET /admin/v1/memory/cards/{card_id}/log?cursor=
}
export interface FsrsSnapshot {
  state: "new" | "learning" | "review";
  stability: number | null;
  difficulty: number | null;
  due_at: string | null;
  status: AdminCardStatus;
}
/** Строка истории планирования (неизменяема) */
export interface ReviewLogRow {
  log_id: string;
  at: string;
  task_type: string; // meaning_choice, typed, …, manual
  answer_mode: "choice" | "typed" | "assemble" | "listen" | "manual";
  grade: "again" | "hard" | "good" | null;
  hinted: boolean;
  revealed: boolean;
  elapsed_days: number | null;
  before: FsrsSnapshot;
  after: FsrsSnapshot;
  algorithm: string; // fsrs-5
  params_version: string; // fsrs5-default-1
  actor: "learner" | "system" | "staff";
  actor_id: string | null; // staff_id (имя дополняет admin-bff через staff/lookup)
  actor_name: string | null; // staff
  reason: string | null;
}

/** POST /admin/v1/memory/cards/{card_id}/actions CardAction (memory.manage, step-up; Idempotency-Key — повтор с тем же
 *  ключом от того же сотрудника за 24 ч возвращает тот же ответ без новой строки истории и аудита) → AdminCardDetail.
 *  reschedule.due_at — выбранный день (клиент шлёт полдень местного дня); допуск ±1 сутки к границам 1..365 дней.
 *  409 CARD_STATE {status} (например, unfreeze не замороженной); 422 DUE_AT_RANGE (1..365 дней от сейчас). */
export type CardAction =
  | { action: "reschedule"; due_at: string; reason: string }
  | { action: "reset"; reason: string }
  | { action: "freeze"; reason: string }
  | { action: "unfreeze"; reason: string };

// ---------- Аналитика забывания (ADM-MEM-02) ----------
/** GET /admin/v1/memory/analytics?pair_id=&period=30d|90d (memory.read | dashboard.read) → ForgettingAnalytics */
export interface ForgettingAnalytics {
  period: "30d" | "90d";
  pair_id: string;
  generated_at: string;
  checks: {
    d7: CheckRate;
    d30: CheckRate;
  };
  by_skill: Array<{ skill_id: string; title: ContentLocalized | null; d7: CheckRate; d30: CheckRate }>;
  by_lesson: Array<{ lesson_id: string; title: ContentLocalized | null; cards: number; again_pct: number | null;
                     hidden: boolean }>;
  repeated_errors: Array<{ error_code: string; label: ContentLocalized; learners_with_repeats: number; cards: number;
                           hidden: boolean }>;
  /** ≤ 20, только карточки слов и фраз контента (не ошибок), при ≥ 20 ответах и ≥ 5 учениках */
  forgotten_words: Array<{ text_en: string; answers: number; again_pct: number }>;
}
export interface CheckRate {
  scheduled: number;
  passed: number;
  failed: number;
  pass_pct: number | null; // 0–100
  /** меньше 5 учеников — значения скрыты (null) */
  hidden: boolean;
}

// ---------- Обзор (спринт 5) ----------
/** GET /admin/v1/memory/stats?period= (dashboard.read) → MemoryStats */
export interface MemoryStats {
  period: Period;
  review_sessions: number;
  learners_reviewing: number;
  median_minutes: number | null;
  d30_pass_pct: number | null; // 0–100
  avg_due_per_learner: number | null;
  ai_glosses_pending: number | null; // очередь переводов ИИ (из catalog); null — catalog недоступен
}

// =====================================================================================================================
// Игра и герои (спринт 6): ADM-GAME-01 правила, ADM-GAME-03 герои, ADM-GAME-04 магазин и кошельки,
// ADM-GAME-05 события и сезоны. Источник — gamification через admin-bff (/admin/v1/game/*).
// Правила: черновик → проверка → активация (step-up, комментарий ≥ 10), история и откат новой версией.
// Проведённые операции задним числом не меняются: исправление — обратной записью.
// Коды: 422 RULES_INVALID {errors: [{path, code}]}; 409 RULES_NOT_VALIDATED; 409 DRAFT_CONFLICT; 409 HERO_IN_USE
// {learners}; 409 EVENT_OVERLAP {event_id}; 409 BALANCE_NEGATIVE; 409 ALREADY_REVERSED; 413 ASSET_TOO_LARGE;
// 422 ASSET_INVALID {reason}; 404 RULES_VERSION_NOT_FOUND | HERO_NOT_FOUND | ITEM_NOT_FOUND | EVENT_NOT_FOUND |
// WALLET_NOT_FOUND | ASSET_NOT_FOUND.
// =====================================================================================================================

export type GameAudience = "kids" | "teens" | "adults";

export interface GameAmount {
  xp: number;
  til: number;
}

export interface QuestTemplate {
  code: string;
  kind: QuestKind;
  target: number;
  reward: GameAmount;
  audiences: GameAudience[];
  weight: number; // 1..10
}

/** Правила игры — payload версии (INTERNAL_API спринта 6 §1.3) */
export interface GameRules {
  earn: {
    lesson: GameAmount;
    lesson_passed_bonus: GameAmount;
    lesson_practice: GameAmount;
    scenario: GameAmount;
    media: GameAmount;
    reading: GameAmount;
    review: { min_cards: number; xp_base: number; xp_per_correct_cap: number; til: number };
    skill_demonstrated: GameAmount;
    skill_retained: GameAmount;
    skill_max_per_event: number;
  };
  caps: { xp_per_day: number; til_per_day: number };
  /** пороги XP уровней по возрастанию, первый 0 */
  levels: number[];
  /** пороги подтверждённых навыков для ступеней 1–3, первый 0 */
  hero: { stage_thresholds: [number, number, number] };
  freeze: { price_til: number; max_stock: number };
  /** referral_freeze и referral_monthly_cap со спринта 7 не используются: награды за рефералов задаёт реферальная
   *  кампания social (ReferralCampaignPayload); поля остаются ради прежних версий */
  bonuses: { registration_freeze: number; referral_freeze: number; referral_monthly_cap: number };
  quests: { per_day: number; all_done_bonus: GameAmount; templates: QuestTemplate[] };
  badges: { streak: number[]; skills: number[]; reviews_cards: number[]; readings: number[] };
  /** спринт 7 (версия 3 миграцией) — обязательны в черновике (валидатор), в версиях 1–2 отсутствуют.
   *  league: призы тилами за 1–3 места (по умолчанию [50, 30, 20]), размер группы [20, 30], аномалия — XP недели
   *  больше median_factor × медиана группы и больше min_xp (5, 1500) */
  league?: { prizes: number[]; group_size: [number, number]; anomaly: { median_factor: number; min_xp: number } };
  /** XP за дуэль: победа 30, ничья 15, участие 10; не больше daily_cap (3) наградных дуэлей в день на ученика */
  duel?: { win: number; draw: number; participation: number; daily_cap: number };
  /** XP участнику урока вдвоём, доведённого до цели (`finished`), при ≥ min_turns своих ходов (25 XP, 1 ход);
   *  не больше daily_cap (3) награждаемых уроков в день на ученика — повторное ревью спринта 7, Н4 */
  pair_lesson?: { xp: number; min_turns: number; daily_cap: number };
}

export type RulesStatus = "draft" | "active" | "archived";
export interface RulesVersionSummary {
  version: number;
  status: RulesStatus;
  comment: string | null;
  based_on: number | null;
  created_by: StaffRef;
  created_at: string;
  validated_at: string | null;
  activated_by: StaffRef | null;
  activated_at: string | null;
}
export interface RulesVersion extends RulesVersionSummary {
  payload: GameRules;
  /** отличия от активной версии */
  diff: Array<{ path: string; from: unknown; to: unknown }>;
  updated_at: string;
}
/** GET /admin/v1/game/rules (game.read) → {items: RulesVersionSummary[]}
 *  GET /admin/v1/game/rules/{version} → RulesVersion
 *  PUT /admin/v1/game/rules/draft (game.manage; If-Match: <updated_at> черновика) → RulesVersion
 *  DELETE /admin/v1/game/rules/draft (game.manage) → 204
 *  POST /admin/v1/game/rules/draft/validate (game.manage) → RulesValidation
 *  POST /admin/v1/game/rules/draft/activate (game.publish, step-up) {comment} → RulesVersion
 *  POST /admin/v1/game/rules/{version}/rollback (game.publish, step-up) {comment} → RulesVersion */
export interface RulesDraftRequest {
  payload: GameRules;
  comment: string | null;
  based_on: number | null;
}
export interface RulesValidation {
  ok: boolean;
  errors: Array<{ path: string; code: string }>;
  warnings: Array<{ path: string; code: string }>;
}
export interface RulesActivateRequest {
  comment: string; // ≥ 10
}

export interface StaffRef {
  staff_id: string;
  name: string;
}

// ---------- Герои (ADM-GAME-03) ----------
export interface AdminGameImage {
  asset_id: string;
  sha256: string;
  url: string; // /admin/v1/game/assets/{asset_id}/content
  width: number;
  height: number;
  size: number;
}
export interface AdminHeroFields {
  name: ContentLocalized;
  tagline: ContentLocalized;
  audiences: GameAudience[];
  stages: Array<{ stage: HeroStage; name: ContentLocalized; asset_id: string }>;
}
export interface AdminHero extends AdminHeroFields {
  code: string;
  line: HeroLine;
  order: number;
  version: number;
  published_at: string | null;
  published_by: StaffRef | null;
  /** картинки ступеней живой версии */
  images: Array<{ stage: HeroStage; image: AdminGameImage }>;
  draft: (AdminHeroFields & { images: Array<{ stage: HeroStage; image: AdminGameImage }>; updated_at: string }) | null;
  /** учеников с этим героем */
  learners: number;
}
/** GET /admin/v1/game/heroes (game.read) → {items: AdminHero[]}
 *  PUT /admin/v1/game/heroes/{code}/draft (game.manage) AdminHeroFields → AdminHero
 *  POST /admin/v1/game/heroes/{code}/publish (game.publish, step-up) {comment} → AdminHero
 *  POST /admin/v1/game/assets?purpose=hero_stage|shop_item|badge (game.manage), тело — байты image/webp | image/png
 *    (≤ 300 КБ, ≤ 1024×1024) → AdminGameImage. Та же картинка — тот же asset_id.
 *  GET /admin/v1/game/assets/{asset_id}/content (game.read) → байты картинки */

// ---------- Магазин и кошельки (ADM-GAME-04) ----------
export type ShopItemStatus = "draft" | "published" | "retired";
export interface AdminShopItem {
  code: string;
  kind: ShopItemKind;
  title: ContentLocalized;
  description: ContentLocalized;
  image: AdminGameImage | null;
  theme: { bg: string; accent: string } | null;
  /** у streak_freeze — из правил (freeze.price_til), только чтение */
  price_til: number;
  audiences: GameAudience[];
  available_from: string | null;
  available_until: string | null;
  status: ShopItemStatus;
  order: number;
  owners: number;
  updated_at: string;
}
/** GET /admin/v1/game/shop/items (game.read) → {items: AdminShopItem[]}
 *  POST /admin/v1/game/shop/items (game.manage, Idempotency-Key) ShopItemCreate → AdminShopItem (draft)
 *  PATCH /admin/v1/game/shop/items/{code} (game.manage) Partial<ShopItemCreate> → AdminShopItem
 *    (у published — только available_until и order)
 *  POST /admin/v1/game/shop/items/{code}/publish | /retire (game.publish, step-up) {comment} → AdminShopItem */
export interface ShopItemCreate {
  code: string; // [a-z0-9_]{3,40}
  kind: Exclude<ShopItemKind, "streak_freeze">;
  title: ContentLocalized;
  description: ContentLocalized;
  asset_id: string | null;
  theme: { bg: string; accent: string } | null;
  price_til: number; // 1..10000
  audiences: GameAudience[];
  available_from: string | null;
  available_until: string | null;
  order: number;
}

export interface AdminWallet {
  user_id: string;
  audience: GameAudience;
  level: number;
  xp_total: number;
  til_balance: number;
  freeze_stock: number;
  hero: { code: string; stage: HeroStage } | null;
  confirmed_skills: number;
  owned_items: Array<{ code: string; kind: ShopItemKind; purchased_at: string; purchase_id: string }>;
  quests_today: Array<{ code: string; kind: QuestKind; target: number; progress: number; status: string }>;
  badges: Array<{ code: string; earned_at: string }>;
  referrals: { pending: number; rewarded: number; capped: number };
  settings: { auto_freeze: boolean; quests_hidden: boolean };
}
export interface AdminLedgerOperation {
  op_id: string;
  currency: GameCurrency;
  amount: number;
  reason: GameReason;
  source: { kind: "event" | "command" | "staff"; ref: string };
  rules_version: number | null;
  multiplier: number;
  capped: boolean;
  local_date: string;
  status: "confirmed" | "reversed";
  reversed_by: string | null;
  reversal_of: string | null;
  actor: string; // system | learner | staff:<id>
  comment: string | null;
  created_at: string;
}
/** GET /admin/v1/game/wallets/{user_id} (game.read) → AdminWallet
 *  GET /admin/v1/game/wallets/{user_id}/ledger?currency=&cursor= (game.read) → Page<AdminLedgerOperation>
 *  POST /admin/v1/game/wallets/{user_id}/adjustments (wallet.adjust, step-up, Idempotency-Key) WalletAdjustment
 *    → AdminLedgerOperation
 *  POST /admin/v1/game/wallets/{user_id}/ledger/{op_id}/reverse (wallet.adjust, step-up) {reason} → AdminLedgerOperation
 *  POST /admin/v1/game/wallets/{user_id}/purchases/{purchase_id}/refund (wallet.adjust, step-up) {reason}
 *    → {operations: AdminLedgerOperation[]} */
export interface WalletAdjustment {
  currency: GameCurrency;
  /** ±1..10000; xp ±1..100000; минус не ниже нуля */
  amount: number;
  reason: string; // ≥ 10
}

// ---------- События и сезоны (ADM-GAME-05) ----------
export type GameEventStatus = "draft" | "published" | "cancelled" | "finished";
export interface GameMultiplier {
  action: GameAction;
  currency: "xp" | "til";
  factor: 1.5 | 2 | 3;
}
export interface GameEventFields {
  code: string; // [a-z0-9_]{3,40}
  title: ContentLocalized;
  description: ContentLocalized;
  starts_at: string;
  ends_at: string; // ≤ 14 дней после starts_at
  audiences: GameAudience[];
  multipliers: GameMultiplier[]; // 1..5
}
export interface AdminGameEvent extends GameEventFields {
  event_id: string;
  status: GameEventStatus;
  created_by: StaffRef;
  published_by: StaffRef | null;
  updated_at: string;
}
/** GET /admin/v1/game/events?status= (game.read) → {items: AdminGameEvent[]}
 *  POST /admin/v1/game/events (game.manage, Idempotency-Key) GameEventFields → AdminGameEvent (draft)
 *  PATCH /admin/v1/game/events/{id} (game.manage, только draft) Partial<GameEventFields> → AdminGameEvent
 *  POST /admin/v1/game/events/{id}/publish | /cancel (game.publish, step-up) {comment} → AdminGameEvent */

// ---------- Обзор ----------
/** GET /admin/v1/game/overview?period=7d|30d (game.read) → GameOverview */
export interface GameOverview {
  period: "7d" | "30d";
  active_rules_version: number;
  earned: { xp: number; til: number };
  spent_til: number;
  freezes: { granted: number; bought: number; used: number };
  quests_completed: number;
  badges_earned: number;
  purchases: number;
  by_audience: Array<{ audience: GameAudience; earned_xp: number; earned_til: number; quests_completed: number }>;
  active_events: Array<{ event_id: string; title: ContentLocalized; ends_at: string }>;
}
/** Блок главной админки (dashboard.read) */
export interface GameStats {
  period: Period;
  earned_xp: number;
  earned_til: number;
  freezes_used: number;
  quests_completed: number;
  active_event: { title: ContentLocalized; ends_at: string } | null;
}

// =====================================================================================================================
// Социальное (спринт 7): ADM-SOC-01 друзья и жалобы, ADM-SOC-02 парные комнаты, ADM-SOC-03 модерация,
// ADM-REF-01 реферальные кампании, ADM-REF-02 реферальный антифрод, ADM-GAME-02 лиги и дуэли.
// Источники через admin-bff: social (/admin/v1/social/*, /admin/v1/moderation/*, /admin/v1/referrals/*),
// gamification (/admin/v1/game/leagues*, /admin/v1/game/duels*), lessons (/admin/v1/pair-rooms*).
// Права: social.read; moderation.manage (step-up — social_ban больше 7 дней и бессрочный); referral.read,
// referral.manage (активация кампании — step-up); league.read, league.manage (переоценка лиги и дуэли — step-up);
// room.read, room.manage (остановка комнаты — step-up). Каждая команда — аудит; причина, основание и комментарий —
// 10..500 символов. Модератор не видит переписку, реплики и ответы учеников: только предмет жалобы, статусы, даты и
// счётчики; личные оценки участников комнат изолированы. Итоги лиг и результаты дуэлей неизменяемы: переоценка создаёт
// новую версию, прежняя сохраняется.
// Меню (experience-config ADMIN_MENU): friends, moderation, referrals, leagues, pair_rooms.
// Коды: 404 SOCIAL_PROFILE_NOT_FOUND | CASE_NOT_FOUND | SANCTION_NOT_FOUND | APPEAL_NOT_FOUND | REFERRAL_NOT_FOUND |
// CAMPAIGN_VERSION_NOT_FOUND | GROUP_NOT_FOUND | DUEL_NOT_FOUND | ROOM_NOT_FOUND; 409 CASE_STATE {status};
// 409 SANCTION_STATE; 409 APPEAL_STATE {status}; 409 REFERRAL_STATE {status}; 409 RESULT_STATE {status} (группа не
// закрыта, призы не удержаны, дуэль не завершена); 422 CAMPAIGN_INVALID {errors: [{path, code}]};
// 409 CAMPAIGN_NOT_VALIDATED; 409 DRAFT_CONFLICT; 409 ROOM_NOT_ACTIVE {status}; 403 STEP_UP_REQUIRED.
// =====================================================================================================================

// ---------- Друзья и жалобы (ADM-SOC-01) ----------

/** GET /admin/v1/social/users/{user_id} (social.read) → AdminSocialCard. Ученика, который ни разу не открывал
 *  «Друзья», social тоже знает (member_id есть у всех): профиль без ника, нули. */
export interface AdminSocialCard {
  user_id: string;
  member_id: string;
  nickname: string | null;
  /** null — профиль сообщества ещё не создан. Решение по F7-20 (ревью спринта 7): код друга — ключ поиска ученика,
   *  поэтому сотруднику без `moderation.manage` admin-bff отдаёт маску `TH-••••-XXXX` (видны последние 4 символа),
   *  с `moderation.manage` — полностью. Маскирует сервер (admin-bff, по эффективным правам сессии), не UI; то же
   *  правило — для любого ответа admin-bff с кодом друга. */
  friend_code: string | null;
  game_profile_hidden: boolean;
  nickname_changed_at: string | null;
  friends: number;
  /** последние 50 заявок ученика: статусы и даты, без ника и id второй стороны */
  requests: Array<{ request_id: string; direction: "in" | "out"; status: FriendRequestStatus; created_at: string;
                    decided_at: string | null }>;
  blocks: { given: number; received: number };
  /** дела, где ученик — жалобщик или цель (последние 20) */
  cases: { as_reporter: number; as_target: number; open_as_target: number; recent: AdminCaseRow[] };
  sanctions: AdminSanction[];
  restrictions: { social_ban: boolean; social_ban_until: string | null };
}

// ---------- Модерация (ADM-SOC-03, moderation.manage) ----------

export type CaseStatus = "open" | "resolved" | "dismissed";
export type ModerationAction = "dismiss" | "warning" | "social_ban" | "nickname_reset";

export interface AdminCaseRow {
  case_id: string;
  status: CaseStatus;
  /** null — обезличено сагой удаления */
  reporter_user_id: string | null;
  target_user_id: string | null;
  /** текущий ник цели */
  target_nickname: string | null;
  subject_kind: ComplaintSubjectKind;
  subject_id: string | null;
  reason: ComplaintReason;
  /** жалоб на эту цель за 30 дней (все дела) */
  target_complaints_30d: number;
  created_at: string;
  resolved_at: string | null;
}

export interface AdminCase extends AdminCaseRow {
  /** комментарий жалобщика (≤ 500) — текст самой жалобы */
  comment: string | null;
  /** предмет жалобы без переписки: ник цели на момент жалобы; статус заявки, приглашения, дуэли или комнаты (если
   *  social его знает: заявка — своя; дуэль и комната — ссылка на карточку в «Лигах и дуэлях» и «Парных комнатах») */
  subject: { nickname_at_report: string | null; status: string | null };
  resolution: {
    action: ModerationAction;
    sanction_id: string | null;
    basis: string;
    resolved_by: StaffRef;
  } | null;
  /** история санкций цели */
  target_sanctions: AdminSanction[];
}

/** GET /admin/v1/moderation/cases?status=open|resolved|dismissed&cursor= → Page<AdminCaseRow> (open — старые сверху)
 *  GET /admin/v1/moderation/cases/{case_id} → AdminCase
 *  POST /admin/v1/moderation/cases/{case_id}/resolve CaseResolveRequest → AdminCase. Только open: иначе 409
 *  CASE_STATE. social_ban с days > 7 или null (бессрочно) — step-up. nickname_reset сбрасывает ник цели в null.
 *  Решение фиксирует основание, исполнителя и срок; цель получает уведомление sanction_applied, жалобщик —
 *  complaint_resolved (без подробностей). */
export interface CaseResolveRequest {
  action: ModerationAction;
  /** social_ban: 1..30 дней или null — бессрочно; для остальных действий — null */
  days: number | null;
  /** основание: 10..500; ученик видит его в своих санкциях */
  basis: string;
}

export interface AdminSanction {
  sanction_id: string;
  user_id: string;
  kind: SanctionKind;
  /** social_ban: конец запрета, null — бессрочно */
  until: string | null;
  active: boolean;
  basis: string;
  case_id: string | null;
  decided_by: StaffRef;
  decided_at: string;
  revoked_at: string | null;
  revoked_by: StaffRef | null;
  revoke_reason: string | null;
  appeal: { appeal_id: string; status: SanctionAppealStatus } | null;
}
/** GET /admin/v1/moderation/sanctions?user_id=&active=true|false&cursor= → Page<AdminSanction>
 *  POST /admin/v1/moderation/sanctions/{sanction_id}/revoke SanctionRevokeRequest → AdminSanction. Уже снята — 409
 *  SANCTION_STATE. */
export interface SanctionRevokeRequest {
  reason: string; // 10..500
}

export interface AdminSanctionAppeal {
  appeal_id: string;
  sanction: AdminSanction;
  /** текст ученика (≤ 1000) */
  text: string;
  status: SanctionAppealStatus;
  created_at: string;
  decided_by: StaffRef | null;
  decided_at: string | null;
  decision_note: string | null;
}
/** GET /admin/v1/moderation/appeals?status=open|upheld|overturned&cursor= → Page<AdminSanctionAppeal> (open — старые
 *  сверху)
 *  POST /admin/v1/moderation/appeals/{appeal_id}/decide SanctionAppealDecision → AdminSanctionAppeal. overturned
 *  снимает санкцию; уже решено — 409 APPEAL_STATE. Ученик получает appeal_decided (note видит). */
export interface SanctionAppealDecision {
  decision: "upheld" | "overturned";
  note: string; // 10..500
}

// ---------- Реферальные кампании (ADM-REF-01) ----------

/** Payload версии кампании. Ограничения валидатора: min_lessons 1..10; min_days 1..min_lessons; window_days 7..90;
 *  награды freeze 0..5, til 0..1000; monthly_cap 1..100; velocity_per_day 1..50; min_lesson_minutes 1..20. */
export interface ReferralCampaignPayload {
  require_diagnostic: boolean;
  min_lessons: number;
  min_days: number;
  window_days: number;
  inviter_reward: ReferralReward;
  invitee_reward: ReferralReward;
  /** квалификаций пригласившего за календарный месяц (Asia/Tashkent); сверх — capped без награды */
  monthly_cap: number;
  /** пороги проверки (ученику не показываются): больше velocity_per_day квалификаций пригласившего за сутки; больше
   *  половины уроков короче min_lesson_minutes → review */
  review: { velocity_per_day: number; min_lesson_minutes: number };
}

export type ReferralCampaignStatus = "draft" | "active" | "archived";
export interface ReferralCampaignSummary {
  version: number;
  status: ReferralCampaignStatus;
  comment: string | null;
  based_on: number | null;
  created_by: StaffRef | null; // null — версия 1 из миграции
  created_at: string;
  validated_at: string | null;
  activated_by: StaffRef | null;
  activated_at: string | null;
}
export interface ReferralCampaignVersion extends ReferralCampaignSummary {
  payload: ReferralCampaignPayload;
  /** отличия от активной версии */
  diff: Array<{ path: string; from: unknown; to: unknown }>;
  updated_at: string;
}
/** GET /admin/v1/referrals/campaigns (referral.read) → {items: ReferralCampaignSummary[]} (новые сверху)
 *  GET /admin/v1/referrals/campaigns/{version} → ReferralCampaignVersion
 *  PUT /admin/v1/referrals/campaigns/draft (referral.manage; If-Match: <updated_at> черновика) ReferralCampaignDraft
 *    → ReferralCampaignVersion; 409 DRAFT_CONFLICT
 *  DELETE /admin/v1/referrals/campaigns/draft (referral.manage) → 204
 *  POST /admin/v1/referrals/campaigns/draft/validate (referral.manage) → RulesValidation
 *  POST /admin/v1/referrals/campaigns/draft/activate (referral.manage, step-up) {comment} → ReferralCampaignVersion;
 *    409 CAMPAIGN_NOT_VALIDATED. Активная одна; прежняя → archived. Рефералы остаются на версии, по которой приняты.
 *  GET /admin/v1/referrals/campaigns/stats (referral.read) → {items: ReferralCampaignStats[]} */
export interface ReferralCampaignDraft {
  payload: ReferralCampaignPayload;
  comment: string | null;
  based_on: number | null;
}
export interface ReferralCampaignStats {
  version: number;
  invited: number;
  in_progress: number; // invited, diagnostic_done, learning
  in_review: number;
  qualified: number; // qualified + rewarded
  rejected: number;
  expired: number;
  capped: number;
  rewards: { inviter: ReferralReward; invitee: ReferralReward }; // выдано суммарно
}

// ---------- Очередь проверки рефералов (ADM-REF-02) ----------

/** velocity — пригласивший получил больше velocity_per_day квалификаций за сутки; short_lessons — больше половины
 *  уроков короче min_lesson_minutes; activity_before_accept — занятия приглашённого раньше принятия приглашения;
 *  family_member — приглашённый в семье пригласившего */
export type ReferralRiskFlag = "velocity" | "short_lessons" | "activity_before_accept" | "family_member";

export interface AdminReferralRow {
  referral_id: string;
  /** null — обезличено сагой удаления */
  inviter_user_id: string | null;
  invitee_user_id: string | null;
  campaign_version: number;
  status: ReferralStatus;
  accepted_at: string;
  diagnostic_at: string | null;
  lessons: number;
  days: number;
  minutes_total: number;
  risk_flags: ReferralRiskFlag[];
  reject_code: ReferralRejectCode | null;
  /** исход ack gamification: rewarded — награда кампании; legacy — выдана раньше по правилу спринта 6;
   *  inviter_capped — пригласивший упёрся в месячный лимит gamification (status capped); null — подтверждения нет */
  reward_outcome: ReferralRewardOutcome | null;
  qualified_at: string | null;
  decided_by: StaffRef | null;
  decided_at: string | null;
}
export interface AdminReferral extends AdminReferralRow {
  /** зачётные уроки приглашённого (без содержания) */
  lessons_log: Array<{ local_date: string; minutes: number }>;
  /** квалификации пригласившего в месяце принятия против лимита кампании */
  inviter_month: { qualified: number; cap: number };
  /** решения операторов: при пересмотре прежнее сохраняется */
  decision_history: Array<{ decision: "approved" | "rejected"; reject_code: ReferralRejectCode | null; note: string;
                            by: StaffRef; at: string }>;
  /** можно пересмотреть (rejected → одобрить один раз) */
  can_redecide: boolean;
}
/** GET /admin/v1/referrals?status=&cursor= (referral.read) → Page<AdminReferralRow> (review — старые сверху)
 *  GET /admin/v1/referrals/{referral_id} → AdminReferral
 *  POST /admin/v1/referrals/{referral_id}/approve (referral.manage) ReferralApproveRequest → AdminReferral: review или
 *    rejected (пересмотр, один раз) → qualified → проверка лимита месяца → capped или награда; иначе 409 REFERRAL_STATE
 *  POST /admin/v1/referrals/{referral_id}/reject (referral.manage) ReferralRejectRequest → AdminReferral: только review.
 *    Выданную награду отменяет обратная запись в кошельке (wallet.adjust), не отклонение реферала. */
export interface ReferralApproveRequest {
  note: string; // 10..500
}
export interface ReferralRejectRequest {
  reject_code: Exclude<ReferralRejectCode, "window_expired" | "monthly_cap">;
  note: string; // 10..500
}

// ---------- Лиги и дуэли (ADM-GAME-02) ----------

/** open — неделя идёт; closed — итоги закрыты, призы начислены; held — закрыты, призы удержаны (аномалия) */
export type LeagueGroupStatus = "open" | "closed" | "held";

export interface AdminLeagueGroupRow {
  group_id: string;
  week: string; // понедельник, YYYY-MM-DD
  pair_id: string;
  level_band: LeagueLevelBand;
  group_no: number;
  size: number;
  status: LeagueGroupStatus;
  /** последняя версия итогов; null — не закрыта */
  version: number | null;
  anomalies: number;
  closed_at: string | null;
}
export interface AdminLeagueWeek {
  week: string;
  starts_at: string;
  ends_at: string;
  status: "open" | "closed";
  participants: number;
  /** призов начислено за неделю (тилы) */
  prizes_til: number;
  groups: AdminLeagueGroupRow[];
}
export interface AdminLeagueMember {
  user_id: string;
  member_id: string;
  nickname: string | null;
  xp: number;
  /** null — исключён переоценкой */
  place: number | null;
  prize_til: number;
  anomaly: boolean;
  excluded: boolean;
  joined_at: string;
}
export interface AdminLeagueResult {
  version: number;
  standings: Array<{ user_id: string | null; place: number; xp: number; prize_til: number }>;
  prizes_held: boolean;
  excluded_user_ids: string[];
  closed_at: string;
  /** null — система (tick закрытия недели) */
  closed_by: StaffRef | null;
  reason: string | null;
}
export interface AdminLeagueGroup extends AdminLeagueGroupRow {
  members: AdminLeagueMember[];
  /** все версии итогов, новые сверху */
  results: AdminLeagueResult[];
}
/** GET /admin/v1/game/leagues?week=YYYY-MM-DD (league.read; понедельник, по умолчанию текущая) → AdminLeagueWeek
 *  GET /admin/v1/game/leagues/{group_id} → AdminLeagueGroup
 *  POST /admin/v1/game/leagues/{group_id}/reevaluate (league.manage, step-up) LeagueReevaluateRequest →
 *    AdminLeagueGroup: только закрытая группа (иначе 409 RESULT_STATE); версия + 1, прежняя хранится; разница призов —
 *    обратными записями и новыми операциями; событие game.league.closed.v1 с новой версией
 *  POST /admin/v1/game/leagues/{group_id}/release-prizes (league.manage) {reason} → AdminLeagueGroup: только held */
export interface LeagueReevaluateRequest {
  exclude_user_ids: string[]; // ≤ 30
  reason: string; // 10..500
}
export interface LeagueReleaseRequest {
  reason: string; // 10..500
}

/** challenger | opponent — победитель; draw — ничья; none — никто не сыграл (cancelled) */
export type DuelResult = "challenger" | "opponent" | "draw" | "none";

export interface AdminDuelRow {
  duel_id: string;
  status: DuelStatus;
  /** null — обезличено сагой удаления */
  challenger_user_id: string | null;
  opponent_user_id: string | null;
  pair_id: string;
  level_band: LeagueLevelBand;
  scores: { challenger: DuelScore | null; opponent: DuelScore | null };
  result: DuelResult | null;
  /** техническая победа: один не сыграл до дедлайна */
  technical: boolean;
  result_version: number;
  created_at: string;
  finished_at: string | null;
}
export interface AdminDuel extends AdminDuelRow {
  set_id: string | null;
  accept_deadline: string;
  play_deadline: string | null;
  /** операции XP по дуэли (в т. ч. обратные записи переоценки) */
  rewards: Array<{ user_id: string | null; op_id: string; amount: number; status: "confirmed" | "reversed";
                   result_version: number }>;
  /** прежние результаты (переоценка сохраняет предыдущий) */
  history: Array<{ version: number; result: DuelResult; reason: string | null; by: StaffRef | null; at: string }>;
}
/** GET /admin/v1/game/duels?status=&cursor= (league.read) → Page<AdminDuelRow>
 *  GET /admin/v1/game/duels/{duel_id} → AdminDuel
 *  POST /admin/v1/game/duels/{duel_id}/reevaluate (league.manage, step-up) DuelReevaluateRequest → AdminDuel: только
 *    finished (иначе 409 RESULT_STATE); result_version + 1; награды исправляются обратными записями; событие
 *    game.duel.finished.v1 с новой версией */
export interface DuelReevaluateRequest {
  result: Exclude<DuelResult, "none">;
  reason: string; // 10..500
}

// ---------- Парные комнаты (ADM-SOC-02) ----------

export interface AdminPairRoomParticipant {
  /** null — обезличено сагой удаления */
  user_id: string | null;
  side: "inviter" | "invitee";
  role: PairRole | null;
  turns: number;
  speaking_seconds: number;
  /** учтённые минуты (не списываются до спринта 8) */
  minutes: number;
  contributed: boolean;
  network: "online" | "offline" | null;
  joined_at: string | null;
}
export interface AdminPairRoomRow {
  room_id: string;
  status: PairRoomStatus;
  pair_id: string;
  scenario_id: string;
  scenario_title: Localized;
  mode: PairRoomMode;
  participants: AdminPairRoomParticipant[];
  created_at: string;
  start_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number;
  end_reason: PairEndReason | null;
  ai_cost_usd: number;
}
export interface AdminPairRoom extends AdminPairRoomRow {
  /** ход событий без текстов реплик и без оценок */
  timeline: Array<{ seq: number; kind: PairRoomEventKind; role: PairRole | null; at: string }>;
  stopped_by: StaffRef | null;
  stop_reason: string | null;
}
/** GET /admin/v1/pair-rooms?status=&from=&to=&cursor= (room.read) → Page<AdminPairRoomRow> (новые сверху)
 *  GET /admin/v1/pair-rooms/{room_id} → AdminPairRoom
 *  POST /admin/v1/pair-rooms/{room_id}/stop (room.manage, step-up) PairRoomStopRequest → AdminPairRoom: → stopped,
 *    участникам — событие в ленте и уведомление pair_stopped, отчёт по сделанному; уже завершена — 409
 *    ROOM_NOT_ACTIVE */
export interface PairRoomStopRequest {
  reason: string; // 10..500
}

// ---------- Обзор ----------
/** Блок главной админки (dashboard.read): счётчики за период и текущие очереди */
export interface SocialStats {
  period: Period;
  friend_requests: number;
  friendships_added: number;
  /** дуэлей завершено (gamification); null — источник недоступен */
  duels_finished: number | null;
  /** парных уроков завершено (lessons); null — источник недоступен */
  pair_rooms_finished: number | null;
  /** рефералы на проверке оператора сейчас */
  referrals_in_review: number;
  /** дел модерации открыто за период */
  cases_opened: number;
  /** открытых дел сейчас */
  cases_open: number;
}
