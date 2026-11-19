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
 * по сотрудникам, ролям и заявкам four-eyes.
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
  | "roles.manage";

export const PERMISSIONS: readonly Permission[] = [
  "dashboard.read", "users.read", "users.sensitive.read", "support.read", "support.reply", "support.manage",
  "audit.read", "config.read", "config.edit", "config.publish", "whatsnew.manage", "whatsnew.publish",
  "notif.templates.manage", "notif.campaigns.manage", "notif.campaigns.send", "staff.manage", "roles.manage",
];

export type RoleCode =
  | "super_admin"
  | "operations" // конфигурация, поддержка, ученики (без раскрытия), аудит
  | "communications" // «Что нового», шаблоны уведомлений, рассылки
  | "support"
  | "methodist" // контент и сценарии — спринт 3; пока только чтение
  | "analyst"
  | "auditor"
  | "read_only";

/** Роли, для которых MFA (TOTP) обязательна; назначение такой роли — four-eyes. */
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
export type NotificationCategory = "reminders" | "missed" | "social" | "support" | "product" | "service";
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
  | "home" | "lessons" | "review" | "progress" | "profile" | "schedule" | "notifications" | "family" | "support" | "news";
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
 *  slug ^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$. Простой текст без управляющих символов. */
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
