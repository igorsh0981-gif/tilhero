/**
 * Кодеки ответов доменов по admin.ts: проверка значений (испорченное → 503 UPSTREAM_UNAVAILABLE) и схема ответа
 * admin-bff (лишние поля доменов отбрасываются). `C.obj<T>` сверяет набор ключей с типом контракта при `tsc`.
 */
import type {
  AdminExperience,
  AdminLearnerCard,
  AdminLearnerPlan,
  AdminLearnerRow,
  AgeBand,
  AgeSegment,
  Approval,
  ApprovalDecision,
  ApprovalKind,
  ApprovalStatus,
  AuditRecord,
  Campaign,
  CampaignEstimate,
  CampaignSegment,
  CampaignStats,
  CampaignStatus,
  ChainVerification,
  ConfigActivation,
  ConfigState,
  ConfigVersion,
  DashboardCampaigns,
  DashboardLearners,
  DashboardWhatsNew,
  Escalation,
  EscalationType,
  GuardianConsent,
  Goal,
  LearnerKind,
  LearnerStatus,
  LevelSelf,
  Localized,
  MfaEnrollStart,
  Permission,
  ReleaseNoteAudience,
  ReleaseNoteContent,
  ReleaseNoteIcon,
  ReleaseNoteRoute,
  ReleaseNoteStats,
  ReleaseNoteStatus,
  ReplyTemplate,
  RevealResult,
  Role,
  RoleCode,
  SchedulePreset,
  SlaPolicies,
  SlaPolicy,
  SlaState,
  Staff,
  StaffCreated,
  StaffPatchPending,
  StaffSummary,
  StaffTicket,
  StaffTicketMessage,
  StaffTicketSummary,
  SupportStats,
  StaffReleaseNote,
  TemplateInfo,
  TemplatePlaceholder,
  TemplatePreview,
  TemplateText,
  TemplateTexts,
  TemplateVersion,
  TemplateVersionStatus,
  TestRecipient,
  TestSendResult,
  TicketCategory,
  TicketPriority,
  TicketStatus,
  UiLang,
} from "@tilhero/contracts/admin";
import type { Ticket as ClientTicket, TicketContext, TicketMessage } from "@tilhero/contracts/bff";
import { C, bad, itemsOf, pageOf, type Codec } from "./codec.js";

/**
 * Маска username для сотрудника без users.sensitive.read — как user-admin (`mask_username`, admin.ts AdminLearnerRow):
 * `ig•••81` — первые 2 и последние 2 символа; короче 5 — `•••`. Без «@» (username его не содержит).
 */
export function maskUsername(u: string): string {
  if (u.includes("•")) return u; // уже маска домена
  return u.length < 5 ? "•••" : `${u.slice(0, 2)}•••${u.slice(-2)}`;
}
import { ALL_PERMISSIONS, ROLE_CODES } from "./rbac.js";

// ---------------------------------------------------------------- общие

const ID64 = C.str(64, 1);
const N_ID64 = C.nullable(ID64);
const N_TIME = C.nullable(C.time);
const COUNT = C.int(0);
const RU_EN = C.obj<{ ru: string; en: string }>({ ru: C.str(500), en: C.str(500) });
const localized = (max: number): Codec<Localized> => C.obj<Localized>({ ru: C.str(max), uz: C.str(max) });

export const UI_LANGS: readonly UiLang[] = ["ru", "uz"];
export const AGE_BANDS: readonly AgeBand[] = ["6-9", "10-13", "14-17", "18+"];
export const AGE_SEGMENTS: readonly AgeSegment[] = ["kids", "teens", "adults"];
const TICKET_STATUSES: readonly TicketStatus[] = ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"];
const TICKET_CATEGORIES: readonly TicketCategory[] = [
  "LESSON", "ASSESSMENT", "SCHEDULE_REMINDERS", "CHILD_PROFILE", "ACCOUNT", "SUBSCRIPTION_PAYMENT", "PERSONAL_DATA", "BUG", "OTHER",
];
const PRIORITIES: readonly TicketPriority[] = ["low", "normal", "high", "urgent"];
const SLA_STATES: readonly SlaState[] = ["breached", "soon", "ok"];
const ESCALATION_TYPES: readonly EscalationType[] = ["billing_review", "assessment_review", "content_review", "tech_issue", "security_privacy"];
const NOTE_ROUTES: readonly ReleaseNoteRoute[] = [
  "home", "lessons", "review", "progress", "profile", "schedule", "notifications", "family", "support", "news",
];
const NOTE_ICONS: readonly ReleaseNoteIcon[] = [
  "spark", "hero", "calendar", "clock", "bell", "book", "chat", "mic", "star", "flame", "users", "gift", "shield", "globe", "trophy", "news",
];

// ---------------------------------------------------------------- вход (admin-identity)

export const MFA_ENROLL: Codec<MfaEnrollStart> = C.obj<MfaEnrollStart>({
  secret: C.id(/^[A-Z2-7]+=*$/, 128),
  otpauth_uri: C.id(/^otpauth:\/\/totp\/\S+$/, 1024),
  issuer: C.text(64),
  account: C.str(254, 1),
});

// ---------------------------------------------------------------- сотрудники, роли, заявки (admin-identity)

const ROLE_C = C.oneOf<RoleCode>(ROLE_CODES);
export const STAFF_SUMMARY: Codec<StaffSummary> = C.obj<StaffSummary>({
  staff_id: C.uuid,
  email: C.str(254, 1),
  display_name: C.text(120),
  role: ROLE_C,
});
export const STAFF: Codec<Staff> = C.obj<Staff>({
  staff_id: C.uuid,
  email: C.str(254, 1),
  display_name: C.text(120),
  role: ROLE_C,
  status: C.oneOf(["ACTIVE", "LOCKED", "DISABLED"] as const),
  mfa_enabled: C.bool,
  must_change_password: C.bool,
  last_login_at: N_TIME,
  created_at: C.time,
  created_by: N_ID64,
});
export const STAFF_PAGE = pageOf(STAFF);

const APPROVAL_KINDS = [
  "staff.role_grant",
  "staff.create_privileged",
  "role.permissions_change",
  "staff.privileged_revoke",
  "staff.privileged_reset",
  "staff.reactivate_privileged",
] as const satisfies readonly ApprovalKind[];
type MissingApprovalKinds = Exclude<ApprovalKind, (typeof APPROVAL_KINDS)[number]>;
const _approvalKindsListed: [MissingApprovalKinds] extends [never] ? true : MissingApprovalKinds = true;
void _approvalKindsListed;
const APPROVAL_STATUSES: readonly ApprovalStatus[] = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "APPLIED"];
const APPROVAL_PROPS = {
  approval_id: C.uuid,
  kind: C.oneOf(APPROVAL_KINDS),
  status: C.oneOf(APPROVAL_STATUSES),
  summary: C.json(16_384),
  reason: C.str(1000),
  requested_by: STAFF_SUMMARY,
  requested_at: C.time,
  decided_by: C.nullable(STAFF_SUMMARY),
  decided_at: N_TIME,
  decision_note: C.nullable(C.str(1000)),
  waived: C.nullable(C.oneOf(["single_super_admin"] as const)),
  expires_at: C.time,
};
export const APPROVAL: Codec<Approval> = C.obj<Approval>(APPROVAL_PROPS);
export const APPROVAL_PAGE = pageOf(APPROVAL);
export const APPROVAL_ENVELOPE = C.obj<{ approval: Approval }>({ approval: APPROVAL });
/**
 * PATCH staff → 202 StaffPatchPending: temporary_password — только если заявка применилась сразу (waived
 * single_super_admin) и выпущен временный пароль цели; один раз, no-store, не в логах. null/нет → ключа нет.
 */
export const STAFF_PATCH_PENDING: Codec<StaffPatchPending> = C.obj<StaffPatchPending>(
  { approval: APPROVAL, temporary_password: C.str(256, 8) },
  "temporary_password",
);
/**
 * temporary_password — решающему, один раз (no-store, не в логах): у применённых заявок staff.privileged_reset,
 * staff.create_privileged, staff.role_grant и staff.reactivate_privileged; null домена → ключа нет.
 */
export const APPROVAL_DECISION: Codec<ApprovalDecision> = C.obj<ApprovalDecision>(
  { ...APPROVAL_PROPS, temporary_password: C.str(256, 8) },
  "temporary_password",
);
export const STAFF_CREATED: Codec<StaffCreated> = C.obj<StaffCreated>({
  staff: STAFF,
  temporary_password: C.nullable(C.str(256, 8)),
  approval: C.nullable(APPROVAL),
});
export const TEMPORARY_PASSWORD = C.obj<{ temporary_password: string }>({ temporary_password: C.str(256, 8) });

export const ROLE: Codec<Role> = C.obj<Role>({
  code: ROLE_C,
  name: RU_EN,
  // право новее этого admin-bff не ломает экран ролей
  permissions: C.arrSkip(C.oneOf<Permission>(ALL_PERMISSIONS), 64),
  privileged: C.bool,
  staff_count: COUNT,
  updated_at: C.time,
  updated_by: N_ID64,
});
/** GET /admin/v1/roles → {items: Role[]} (каталог прав admin-identity в ответ не попадает — он в admin.ts). */
export const ROLES = itemsOf(ROLE, 50);

// ---------------------------------------------------------------- ученики (user-admin, identity-consent)

/** Маска Telegram ID (`••••••789`): всё, что не похоже на маску, в ответ не попадает (защита от утечки ID). */
const TG_MASK = C.custom<string | null>({ type: ["string", "null"] }, (v, p) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return bad(p);
  return /^[•*]{3,12}\d{0,4}$/.test(v) ? v : null;
});

const GOALS: readonly Goal[] = ["work", "career", "travel", "daily", "study", "exam"];
const LEARNER_ROW_PROPS = {
  user_id: C.uuid,
  kind: C.oneOf<LearnerKind>(["account", "child"]),
  guardian_user_id: C.nullable(C.uuid),
  display_name: C.optText(120),
  // полный username (без «@») — только сотруднику с users.sensitive.read; остальным домен отдаёт маску `ig•••81`
  // (короче 5 символов — `•••`), ревью T2-3
  username: C.nullable(C.id(/^(?:[A-Za-z0-9_]{1,64}|[A-Za-z0-9_]{2}•••[A-Za-z0-9_]{2}|•••)$/, 64)),
  telegram_id_masked: TG_MASK,
  locale: C.nullable(C.oneOf(UI_LANGS)),
  age_band: C.nullable(C.oneOf(AGE_BANDS)),
  guardian_consent: C.oneOf<GuardianConsent>(["not_required", "pending", "granted", "declined"]),
  status: C.oneOf<LearnerStatus>(["ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED"]),
  onboarding_completed: C.bool,
  goal: C.nullable(C.oneOf(GOALS)),
  reminders_enabled: C.bool,
  children_count: COUNT,
  open_tickets: COUNT,
  tickets_total: COUNT,
  created_at: C.time,
  last_activity_at: N_TIME,
};
export const LEARNER_ROW: Codec<AdminLearnerRow> = C.obj<AdminLearnerRow>(LEARNER_ROW_PROPS);
export const LEARNER_PAGE = pageOf(LEARNER_ROW, 100);

const PLAN: Codec<AdminLearnerPlan> = C.obj<AdminLearnerPlan>({
  goal: C.nullable(C.oneOf(GOALS)),
  level_self: C.nullable(C.oneOf<LevelSelf>(["zero", "beginner", "some", "confident"])),
  ui_lang: C.nullable(C.oneOf(UI_LANGS)),
  schedule: C.nullable(
    C.obj<NonNullable<AdminLearnerPlan["schedule"]>>({
      preset: C.oneOf<SchedulePreset>(["daily", "weekdays", "three_per_week", "custom"]),
      days: C.arr(C.int(0, 7), 7),
      preferred_time: C.id(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 8),
      duration_min: C.int(1, 600),
      reminders_enabled: C.bool,
      timezone: C.id(/^[A-Za-z0-9_+\-/]{1,64}$/, 64),
    }),
  ),
  onboarding_completed_at: N_TIME,
  updated_at: N_TIME,
});

type CardTicket = NonNullable<AdminLearnerCard["tickets"]>[number];
export const CARD_TICKET: Codec<CardTicket> = C.obj<CardTicket>({
  ticket_id: C.uuid,
  number: C.str(32, 1),
  status: C.oneOf(TICKET_STATUSES),
  category: C.str(40, 1),
  subject: C.str(300),
  created_at: C.time,
});

const CARD_PROPS = {
  ...LEARNER_ROW_PROPS,
  consent: C.obj<AdminLearnerCard["consent"]>({
    policy_version: C.nullable(C.str(32)),
    purposes: C.arr(C.id(/^[a-z][a-z0-9_]{0,63}$/, 64), 50),
    accepted_at: N_TIME,
    revoked_at: N_TIME,
    basis: C.nullable(C.oneOf(["self", "guardian"] as const)),
  }),
  security: C.obj<AdminLearnerCard["security"]>({ pin_enabled: C.bool, pin_reset_pending: C.bool }),
  notifications: C.nullable(
    C.obj<NonNullable<AdminLearnerCard["notifications"]>>({
      enabled: C.bool,
      categories: C.obj<NonNullable<AdminLearnerCard["notifications"]>["categories"]>({
        reminders: C.bool,
        missed: C.bool,
        social: C.bool,
        support: C.bool,
        product: C.bool,
      }),
    }),
  ),
  plan: C.nullable(PLAN),
  children: C.arr(LEARNER_ROW, 50),
  guardian: C.nullable(LEARNER_ROW),
  refreshed_at: C.time,
};
/** Карточка user-admin — без tickets (их добавляет admin-bff из support). */
export const LEARNER_CARD_DOMAIN: Codec<Omit<AdminLearnerCard, "tickets">> = C.obj<Omit<AdminLearnerCard, "tickets">>(CARD_PROPS);
/** Ответ admin-bff: карточка + последние 20 обращений (null — нет support.read или support недоступен). */
export const LEARNER_CARD: Codec<AdminLearnerCard> = C.obj<AdminLearnerCard>({
  ...CARD_PROPS,
  tickets: C.nullable(C.arr(CARD_TICKET, 20)),
});

export const REVEAL_RESULT: Codec<RevealResult> = C.obj<RevealResult>({
  field: C.oneOf(["telegram_user_id"] as const),
  value: C.id(/^\d{1,20}$/, 20),
  expires_in: C.int(1, 600),
});

// ---------------------------------------------------------------- дашборд

const pct = C.num(0, 100);
export const DASHBOARD_LEARNERS: Codec<DashboardLearners> = C.obj<DashboardLearners>({
  total_accounts: COUNT,
  total_children: COUNT,
  new_in_period: COUNT,
  active_in_period: COUNT,
  onboarding_completed_pct: pct,
  reminders_enabled_pct: pct,
  by_age_band: C.obj<DashboardLearners["by_age_band"]>({ "6-9": COUNT, "10-13": COUNT, "14-17": COUNT, "18+": COUNT, unknown: COUNT }),
  by_locale: C.obj<DashboardLearners["by_locale"]>({ ru: COUNT, uz: COUNT, unknown: COUNT }),
});
export const SUPPORT_STATS: Codec<SupportStats> = C.obj<SupportStats>({
  open: COUNT,
  in_progress: COUNT,
  waiting_customer: COUNT,
  breached: COUNT,
  avg_first_response_minutes: C.nullable(C.num(0, 1e9)),
  avg_resolution_minutes: C.nullable(C.num(0, 1e9)),
});
export const DASHBOARD_WHATS_NEW: Codec<DashboardWhatsNew> = C.obj<DashboardWhatsNew>({
  published: COUNT,
  drafts: COUNT,
  latest: C.nullable(
    C.obj<NonNullable<DashboardWhatsNew["latest"]>>({
      release_note_id: C.uuid,
      slug: C.str(32, 1),
      title: C.str(200),
      views_total: COUNT,
      published_at: C.time,
    }),
  ),
});
export const DASHBOARD_CAMPAIGNS: Codec<DashboardCampaigns> = C.obj<DashboardCampaigns>({
  scheduled: COUNT,
  sending: COUNT,
  sent_in_period: COUNT,
  delivered_in_period: COUNT,
});

// ---------------------------------------------------------------- поддержка (support)

const TICKET_SUMMARY_PROPS = {
  ticket_id: C.uuid,
  number: C.str(32, 1),
  user_id: C.nullable(C.uuid),
  channel: C.str(32, 1),
  category: C.oneOf(TICKET_CATEGORIES),
  subject: C.str(300),
  status: C.oneOf(TICKET_STATUSES),
  priority: C.oneOf(PRIORITIES),
  assignee_id: N_ID64,
  assignee_name: C.name,
  has_context: C.bool,
  anonymized: C.bool,
  created_at: C.time,
  updated_at: C.time,
  last_message_at: C.time,
  first_response_at: N_TIME,
  sla_first_response_at: C.time,
  sla_resolution_at: C.time,
  sla_target: C.nullable(C.oneOf(["first_response", "resolution"] as const)),
  sla_due_at: N_TIME,
  sla_state: C.oneOf(SLA_STATES),
  sla_paused: C.bool,
};
export const TICKET_SUMMARY: Codec<StaffTicketSummary> = C.obj<StaffTicketSummary>(TICKET_SUMMARY_PROPS);
export const TICKET_PAGE = pageOf(TICKET_SUMMARY, 100);

export const ESCALATION: Codec<Escalation> = C.obj<Escalation>({
  escalation_id: C.uuid,
  type: C.oneOf(ESCALATION_TYPES),
  note: C.multiline(2000),
  status: C.str(32, 1),
  created_by: ID64,
  created_at: C.time,
});
const STAFF_MESSAGE: Codec<StaffTicketMessage> = C.obj<StaffTicketMessage>({
  message_id: C.uuid,
  sender_type: C.oneOf(["user", "operator", "system"] as const),
  visibility: C.oneOf(["public", "internal"] as const),
  author_id: N_ID64,
  // имя оператора подставляет admin-bff (lookup); у ученика и системы — значение support
  author_name: C.optText(120),
  text: C.multiline(8000, true),
  created_at: C.time,
});
type Learner = NonNullable<StaffTicket["learner"]>;
export const TICKET_LEARNER: Codec<Learner> = C.obj<Learner>({
  user_id: LEARNER_ROW_PROPS.user_id,
  kind: LEARNER_ROW_PROPS.kind,
  username: LEARNER_ROW_PROPS.username,
  telegram_id_masked: LEARNER_ROW_PROPS.telegram_id_masked,
  locale: LEARNER_ROW_PROPS.locale,
  age_band: LEARNER_ROW_PROPS.age_band,
  status: LEARNER_ROW_PROPS.status,
});
const TICKET_DETAIL_PROPS = {
  ...TICKET_SUMMARY_PROPS,
  context: C.nullable(
    C.obj<NonNullable<StaffTicket["context"]>>({ deeplink: C.https, client_version: C.str(64) }),
  ),
  correlation_id: C.nullable(C.str(128)),
  resolved_at: N_TIME,
  closed_at: N_TIME,
  user_unread_operator_replies: COUNT,
  messages: C.arr(STAFF_MESSAGE, 2000),
  status_history: C.arr(
    C.obj<StaffTicket["status_history"][number]>({
      from_status: C.nullable(C.str(32)),
      status: C.str(32, 1),
      at: C.time,
      changed_by: C.str(32, 1),
      actor_id: N_ID64,
    }),
    1000,
  ),
  escalations: C.arr(ESCALATION, 200),
};
/** Тикет support (learner добавляет admin-bff). */
export const TICKET_DOMAIN: Codec<Omit<StaffTicket, "learner">> = C.obj<Omit<StaffTicket, "learner">>(TICKET_DETAIL_PROPS);
export const STAFF_TICKET: Codec<StaffTicket> = C.obj<StaffTicket>({ ...TICKET_DETAIL_PROPS, learner: C.nullable(TICKET_LEARNER) });

/** «Как видит ученик» — форма bff.ts Ticket: без internal, user_id, оператора. */
export const CLIENT_TICKET: Codec<ClientTicket> = C.obj<ClientTicket>({
  ticket_id: C.uuid,
  number: C.str(32, 1),
  category: C.oneOf(TICKET_CATEGORIES),
  subject: C.str(300),
  status: C.oneOf(TICKET_STATUSES),
  created_at: C.time,
  updated_at: C.time,
  last_message_at: C.time,
  unread_operator_replies: COUNT,
  context: C.nullable(
    C.obj<TicketContext>(
      // не https → ключа нет (необязательное поле bff.ts)
      { deeplink: C.https as Codec<string>, client_version: C.str(64) },
      "deeplink",
    ),
  ),
  sla_first_response_at: N_TIME,
  messages: C.arr(
    C.obj<TicketMessage>({
      message_id: C.uuid,
      sender_type: C.oneOf(["user", "operator", "system"] as const),
      author_name: C.optText(120),
      text: C.multiline(8000, true),
      created_at: C.time,
    }),
    2000,
  ),
  status_history: C.arr(C.obj<ClientTicket["status_history"][number]>({ status: C.oneOf(TICKET_STATUSES), at: C.time }), 1000),
});

export const ESCALATION_CREATED = ESCALATION;

const SLA_POLICY: Codec<SlaPolicy> = C.obj<SlaPolicy>(
  {
    category: C.custom<SlaPolicy["category"]>({ type: "string" }, (v, p) =>
      C.oneOf<SlaPolicy["category"]>([...TICKET_CATEGORIES, "*"]).parse(v, p),
    ),
    priority: C.oneOf(PRIORITIES),
    first_response_minutes: C.int(1, 1_000_000),
    resolution_minutes: C.int(1, 1_000_000),
    updated_at: C.time,
    updated_by: ID64,
  },
  "updated_at",
  "updated_by",
);
export const SLA_POLICIES: Codec<SlaPolicies> = C.obj<SlaPolicies>(
  {
    items: C.arr(SLA_POLICY, 200),
    category_defaults: C.dict(/^[A-Z_*]{1,32}$/, C.str(32), 50),
  },
  "category_defaults",
);

export const REPLY_TEMPLATES = itemsOf(
  C.obj<ReplyTemplate>({
    id: C.id(/^[A-Za-z0-9_.:-]{1,64}$/, 64),
    title: RU_EN,
    text: localized(4000),
    categories: C.arrSkip(C.oneOf(TICKET_CATEGORIES), 20),
  }),
  200,
);

// ---------------------------------------------------------------- аудит (audit)

export const AUDIT_RECORD: Codec<AuditRecord> = C.obj<AuditRecord>({
  seq: C.int(0),
  record_id: C.uuid,
  occurred_at: C.time,
  recorded_at: C.time,
  source: C.str(64, 1),
  actor_type: C.oneOf(["staff", "user", "system", "service"] as const),
  actor_id: C.nullable(C.str(128)),
  actor_role: C.nullable(C.str(64)),
  action: C.str(128, 1),
  object_type: C.nullable(C.str(64)),
  object_id: C.nullable(C.str(128)),
  before: C.nullable(C.json(65_536)),
  after: C.nullable(C.json(65_536)),
  reason: C.nullable(C.str(2000)),
  ip: C.nullable(C.str(64)),
  session_id: C.nullable(C.str(128)),
  trace_id: C.nullable(C.str(128)),
  prev_hash: C.id(/^[0-9a-f]{64}$/, 64),
  hash: C.id(/^[0-9a-f]{64}$/, 64),
});
export const AUDIT_PAGE = pageOf(AUDIT_RECORD);
export const CHAIN_VERIFICATION: Codec<ChainVerification> = C.obj<ChainVerification>({
  valid: C.bool,
  checked: COUNT,
  first_seq: C.nullable(C.int(0)),
  last_seq: C.nullable(C.int(0)),
  broken_at_seq: C.nullable(C.int(0)),
});

// ---------------------------------------------------------------- конфигурация (experience-config)

const CONFIG_APP = C.oneOf(["miniapp", "admin"] as const);
const VERSION_STR = C.id(/^[0-9A-Za-z.+-]{1,32}$/, 32);
const VERSION_SUMMARY_PROPS = {
  version_id: C.uuid,
  app: CONFIG_APP,
  version: VERSION_STR,
  checksum: C.str(128, 1),
  change_note: C.str(1000),
  created_by: ID64,
  created_at: C.time,
  status: C.nullable(C.oneOf(["current", "previous"] as const)),
};
export const CONFIG_VERSION: Codec<ConfigVersion> = C.obj<ConfigVersion>(
  { ...VERSION_SUMMARY_PROPS, payload: C.json(262_144) },
  "payload",
);
/** Список версий — без payload (как experience-config VersionSummary). */
export const CONFIG_VERSION_PAGE = pageOf(C.obj<Omit<ConfigVersion, "payload">>(VERSION_SUMMARY_PROPS));
export const CONFIG_ACTIVATION: Codec<ConfigActivation> = C.obj<ConfigActivation>({
  activation_id: C.uuid,
  app: CONFIG_APP,
  version: VERSION_STR,
  previous_version: C.nullable(VERSION_STR),
  kind: C.oneOf(["activate", "rollback"] as const),
  reason: C.str(1000),
  activated_by: ID64,
  activated_at: C.time,
});
export const CONFIG_ACTIVATION_PAGE = pageOf(CONFIG_ACTIVATION);
export const CONFIG_STATE: Codec<ConfigState> = C.obj<ConfigState>({
  app: CONFIG_APP,
  current: C.nullable(CONFIG_ACTIVATION),
  previous_version: C.nullable(VERSION_STR),
});
/**
 * Тема и раскладка админки — admin.ts `AdminExperience` (ревью T2-6; experience-config AdminExperienceConfig).
 * Значения токенов белым списком проверяет experience-config, admin-web применяет только известные имена; здесь —
 * форма, имена CSS-переменных и отсутствие конструкций, которыми из значения можно выйти за пределы свойства.
 */
const CSS_UNSAFE_RE = /[;{}<>\\\u0000-\u001f\u007f]|\/\*|url\s*\(|expression\s*\(|javascript\s*:|@import/i;
const CSS_TOKEN_VALUE: Codec<string> = C.custom({ type: "string" }, (v, p) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 200 && !CSS_UNSAFE_RE.test(v) ? v : bad(p),
);
export const ADMIN_EXPERIENCE: Codec<AdminExperience> = C.obj<AdminExperience>({
  app: C.oneOf(["admin"] as const),
  version: VERSION_STR,
  theme: C.obj<AdminExperience["theme"]>({
    id: C.id(/^[a-z][a-z0-9_]{0,31}$/, 32),
    version: VERSION_STR,
    tokens: C.dict(/^--[a-z][a-z0-9-]{0,62}$/, CSS_TOKEN_VALUE, 60),
  }),
  layout: C.obj<AdminExperience["layout"]>({
    density: C.oneOf(["compact", "comfortable"] as const),
    menu: C.arr(C.obj<AdminExperience["layout"]["menu"][number]>({ id: C.id(/^[a-z][a-z0-9_]{0,31}$/, 32), enabled: C.bool }), 50),
  }),
  flags: C.dict(/^[a-z][a-z0-9_]{0,63}$/, C.bool, 50),
});

/**
 * Действующая конфигурация Mini App (experience-config `/internal/v1/experience/miniapp/current`): объект проверен
 * белым списком на стороне experience-config (MiniAppExperienceConfig = bff.ts ExperienceConfig), без секретов —
 * передаётся целиком; здесь — только то, что это объект нужного приложения.
 */
export const experienceCurrent = (app: "miniapp" | "admin"): Codec<Record<string, unknown>> =>
  C.custom({ type: "object", additionalProperties: true }, (v, p) => {
    const o = C.json(262_144).parse(v, p);
    if (o.app !== app) return bad(`${p}.app`);
    if (typeof o.version !== "string") return bad(`${p}.version`);
    return o;
  });

// ---------------------------------------------------------------- «Что нового» (experience-config)

const NOTE_ITEM = C.obj<ReleaseNoteContent["items"][number]>({
  title: localized(80),
  text: localized(200),
  link: C.nullable(C.oneOf(NOTE_ROUTES)),
  icon: C.nullable(C.oneOf(NOTE_ICONS)),
});
export const RELEASE_NOTE: Codec<StaffReleaseNote> = C.obj<StaffReleaseNote>({
  release_note_id: C.uuid,
  slug: C.str(32, 1),
  title: localized(80),
  items: C.arr(NOTE_ITEM, 6),
  audience: C.oneOf<ReleaseNoteAudience>(["new", "existing", "all"]),
  segments: C.obj<ReleaseNoteContent["segments"]>(
    { age: C.arr(C.oneOf(AGE_SEGMENTS), 3), ui_lang: C.arr(C.oneOf(UI_LANGS), 2) },
    "age",
    "ui_lang",
  ),
  status: C.oneOf<ReleaseNoteStatus>(["draft", "published", "archived"]),
  version: C.int(1),
  created_by: ID64,
  created_by_name: C.name,
  created_at: C.time,
  updated_by: ID64,
  updated_at: C.time,
  published_by: N_ID64,
  published_by_name: C.name,
  published_at: N_TIME,
  archived_by: N_ID64,
  archived_at: N_TIME,
  views_total: COUNT,
});
export const RELEASE_NOTE_PAGE = pageOf(RELEASE_NOTE, 100);
export const RELEASE_NOTE_STATS: Codec<ReleaseNoteStats> = C.obj<ReleaseNoteStats>({
  release_note_id: C.uuid,
  views_total: COUNT,
  views_by_lang: C.obj<ReleaseNoteStats["views_by_lang"]>({ ru: COUNT, uz: COUNT }),
  views_by_age: C.obj<ReleaseNoteStats["views_by_age"]>({ kids: COUNT, teens: COUNT, adults: COUNT }),
  first_view_at: N_TIME,
  last_view_at: N_TIME,
});

// ---------------------------------------------------------------- шаблоны уведомлений (notifications)

const TEMPLATE_TEXT: Codec<TemplateText> = C.obj<TemplateText>({ title: C.str(80), body: C.str(1000), button: C.nullable(C.str(32)) });
export const TEMPLATE_TEXTS: Codec<TemplateTexts> = C.obj<TemplateTexts>({ ru: TEMPLATE_TEXT, uz: TEMPLATE_TEXT });
const NOTIF_CATEGORY = C.oneOf(["reminders", "missed", "social", "support", "product"] as const);
const PLACEHOLDER: Codec<TemplatePlaceholder> = C.obj<TemplatePlaceholder>({
  name: C.id(/^[a-z][a-z0-9_]{0,39}$/, 40),
  description: RU_EN,
  sample: localized(200),
});
const TEMPLATE_INFO_PROPS = {
  key: C.id(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,5}$/, 64),
  category: NOTIF_CATEGORY,
  kid: C.bool,
  description: RU_EN,
  placeholders: C.arr(PLACEHOLDER, 50),
  default_texts: TEMPLATE_TEXTS,
  active_version: C.nullable(C.int(1)),
  active_since: N_TIME,
  updated_at: N_TIME,
};
export const TEMPLATE_INFO: Codec<TemplateInfo> = C.obj<TemplateInfo>(TEMPLATE_INFO_PROPS);
export const TEMPLATE_LIST = itemsOf(TEMPLATE_INFO, 200);
export const TEMPLATE_VERSION: Codec<TemplateVersion> = C.obj<TemplateVersion>({
  key: TEMPLATE_INFO_PROPS.key,
  version: C.int(1),
  status: C.oneOf<TemplateVersionStatus>(["draft", "active", "archived"]),
  texts: TEMPLATE_TEXTS,
  note: C.str(300),
  created_by: ID64,
  created_by_name: C.name,
  created_at: C.time,
  activated_by: N_ID64,
  activated_by_name: C.name,
  activated_at: N_TIME,
});
export type TemplateDetail = TemplateInfo & { versions: TemplateVersion[] };
export const TEMPLATE_DETAIL: Codec<TemplateDetail> = C.obj<TemplateDetail>({ ...TEMPLATE_INFO_PROPS, versions: C.arr(TEMPLATE_VERSION, 50) });
export const TEMPLATE_PREVIEW: Codec<TemplatePreview> = C.obj<TemplatePreview>({
  lang: C.oneOf(UI_LANGS),
  title: C.str(200),
  body: C.str(4000),
  button: C.nullable(C.str(64)),
  telegram_text: C.str(4096),
});
export const TEST_RECIPIENTS = itemsOf(
  C.obj<TestRecipient>({
    index: C.int(0, 99),
    // только маска: полный chat id в админку не отдаётся (не больше 4 цифр подряд в подписи)
    label: C.map(C.text(80), { type: "string" }, (s, p) => (/\d{5,}/.test(s.replace(/\s/g, "")) ? bad(p) : s)),
  }),
  100,
);
export const TEST_SEND_RESULT: Codec<TestSendResult> = C.obj<TestSendResult>({
  sent: C.bool,
  delivery_id: C.nullable(C.str(128)),
  error: C.nullable(C.text(300)),
});

// ---------------------------------------------------------------- рассылки (notifications)

const SEGMENT: Codec<CampaignSegment> = C.obj<CampaignSegment>(
  {
    ui_lang: C.arr(C.oneOf(UI_LANGS), 2),
    age: C.arr(C.oneOf(["teens", "adults"] as const), 2),
    onboarded: C.bool,
    active_days: C.int(-90, 90),
  },
  "ui_lang",
  "age",
  "onboarded",
  "active_days",
);
const CAMPAIGN_STATS: Codec<CampaignStats> = C.obj<CampaignStats>({
  audience: COUNT,
  created: COUNT,
  sent: COUNT,
  in_app_only: COUNT,
  deferred: COUNT,
  skipped_frequency: COUNT,
  failed: COUNT,
});
export const CAMPAIGN: Codec<Campaign> = C.obj<Campaign>({
  campaign_id: C.uuid,
  title: C.str(120),
  texts: TEMPLATE_TEXTS,
  route: C.nullable(C.oneOf(NOTE_ROUTES)),
  segment: SEGMENT,
  status: C.oneOf<CampaignStatus>(["draft", "scheduled", "sending", "done", "stopped"]),
  version: C.int(1),
  send_at: N_TIME,
  created_by: ID64,
  created_by_name: C.name,
  created_at: C.time,
  updated_at: C.time,
  scheduled_by: N_ID64,
  scheduled_at: N_TIME,
  started_at: N_TIME,
  finished_at: N_TIME,
  stopped_by: N_ID64,
  // имена — staff/lookup (`withNames`, ревью T2-6); от домена не берутся
  scheduled_by_name: C.name,
  stopped_by_name: C.name,
  stopped_at: N_TIME,
  stop_reason: C.nullable(C.str(500)),
  stats: CAMPAIGN_STATS,
  // ревью P2-7; домен прошлой версии поля не отдаёт → null
  last_error: C.fallback(
    C.nullable(C.obj<NonNullable<Campaign["last_error"]>>({ code: C.id(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/, 64), since: C.time, attempts: C.int(0) })),
    null,
  ),
});
export const CAMPAIGN_PAGE = pageOf(CAMPAIGN, 100);
export const CAMPAIGN_ESTIMATE: Codec<CampaignEstimate> = C.obj<CampaignEstimate>({
  audience: COUNT,
  by_lang: C.obj<CampaignEstimate["by_lang"]>({ ru: COUNT, uz: COUNT }),
  frequency_capped: COUNT,
  computed_at: C.time,
});
