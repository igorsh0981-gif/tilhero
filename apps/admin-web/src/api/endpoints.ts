import type {
  AdminExperience,
  AdminLearnerCard,
  AdminLearnerRow,
  AgeBand,
  Approval,
  ApprovalDecision,
  AuditRecord,
  Campaign,
  CampaignContent,
  CampaignEstimate,
  CampaignStatus,
  ChainVerification,
  ConfigActivation,
  ConfigApp,
  ConfigState,
  ConfigVersion,
  Dashboard,
  EscalationType,
  LearnerKind,
  LearnerStatus,
  LoginStep,
  Me,
  MfaEnrollStart,
  Page,
  Permission,
  ReleaseNoteContent,
  ReleaseNoteStats,
  ReleaseNoteStatus,
  ReplyTemplate,
  RevealResult,
  Role,
  RoleCode,
  SlaPolicies,
  SlaPolicy,
  Staff,
  StaffCreate,
  StaffCreated,
  StaffPatch,
  StaffPatchPending,
  StaffReleaseNote,
  StaffResetResponse,
  StaffTicket,
  StaffTicketSummary,
  StepUpResult,
  SupportStats,
  TemplateInfo,
  TemplatePreview,
  TemplateTexts,
  TemplateVersion,
  TestRecipient,
  TestSendResult,
  TicketPriority,
  TicketStatus,
  UiLang,
} from "@tilhero/contracts/admin";
import type { Ticket as ClientTicket } from "@tilhero/contracts/bff";
import { api } from "./client";

export type { SlaPolicies, SlaPolicy, SupportStats };
export type Period = Dashboard["period"];
const enc = encodeURIComponent;

export const Auth = {
  login: (email: string, password: string) => api.post<LoginStep>("/auth/login", { email, password }, { stepUp: false }),
  mfa: (challenge: string, code: string) => api.post<LoginStep>("/auth/mfa", { challenge, code }, { stepUp: false }),
  enrollStart: (challenge: string) => api.post<MfaEnrollStart>("/auth/mfa/enroll/start", { challenge }, { stepUp: false }),
  enrollConfirm: (challenge: string, code: string) => api.post<LoginStep>("/auth/mfa/enroll/confirm", { challenge, code }, { stepUp: false }),
  passwordStep: (challenge: string, new_password: string) => api.post<LoginStep>("/auth/password", { challenge, new_password }, { stepUp: false }),
  passwordChange: (current_password: string, new_password: string) =>
    api.post<LoginStep | undefined>("/auth/password", { current_password, new_password }, { stepUp: false }),
  stepUp: (code: string) => api.post<StepUpResult>("/auth/step-up", { code }, { stepUp: false }),
  logout: () => api.post<void>("/auth/logout", undefined, { stepUp: false }),
  me: () => api.get<Me>("/me"),
  impersonate: (role: RoleCode | null) => api.post<Me | undefined>("/dev/impersonate", { role }),
};

export const DashboardApi = {
  get: (period: Period, background = false) => api.get<Dashboard>("/dashboard", { query: { period }, background }),
};

/* ---------------------------------------------------------------- learners (user-admin + identity-consent) */

export interface LearnerFilters {
  q?: string;
  kind?: LearnerKind | "";
  age_band?: AgeBand | "";
  status?: LearnerStatus | "";
  locale?: UiLang | "";
  has_open_tickets?: boolean | null;
  cursor?: string | null;
  limit?: number;
}

export const Learners = {
  list: (f: LearnerFilters) =>
    api.get<Page<AdminLearnerRow>>("/learners", {
      query: { q: f.q, kind: f.kind, age_band: f.age_band, status: f.status, locale: f.locale, has_open_tickets: f.has_open_tickets ?? undefined, cursor: f.cursor, limit: f.limit ?? 50 },
    }),
  card: (id: string) => api.get<AdminLearnerCard>(`/learners/${enc(id)}`),
  reveal: (id: string, reason: string) => api.post<RevealResult>(`/learners/${enc(id)}/reveal`, { field: "telegram_user_id", reason }),
};

/* ---------------------------------------------------------------- support */

export interface TicketFilters {
  status?: string;
  category?: string;
  priority?: string;
  assignee?: string;
  sla?: string;
  user_id?: string;
  sort?: "created" | "sla";
  cursor?: string | null;
  limit?: number;
}

export const Support = {
  list: (f: TicketFilters, background = false) =>
    api.get<Page<StaffTicketSummary>>("/support/tickets", {
      query: { status: f.status, category: f.category, priority: f.priority, assignee: f.assignee, sla: f.sla, user_id: f.user_id, sort: f.sort, cursor: f.cursor, limit: f.limit ?? 50 },
      background,
    }),
  stats: (period: Period = "today", background = false) => api.get<SupportStats>("/support/stats", { query: { period }, background }),
  get: (id: string, background = false) => api.get<StaffTicket>(`/support/tickets/${enc(id)}`, { background }),
  clientView: (id: string) => api.get<ClientTicket>(`/support/tickets/${enc(id)}/client-view`),
  send: (id: string, text: string, visibility: "public" | "internal", idempotencyKey: string) =>
    api.post<StaffTicket>(`/support/tickets/${enc(id)}/messages`, { text, visibility }, { idempotencyKey }),
  patch: (id: string, patch: { status?: TicketStatus; priority?: TicketPriority; assignee_id?: string | null }) =>
    api.patch<StaffTicket>(`/support/tickets/${enc(id)}`, patch),
  take: (id: string) => api.post<StaffTicket>(`/support/tickets/${enc(id)}/take`),
  escalate: (id: string, type: EscalationType, note: string) => api.post<unknown>(`/support/tickets/${enc(id)}/escalations`, { type, note }, { idempotencyKey: true }),
  templates: () => api.get<{ items: ReplyTemplate[] }>("/support/templates"),
  slaPolicies: () => api.get<SlaPolicies>("/support/sla-policies"),
  putSlaPolicies: (items: SlaPolicy[], reason: string) =>
    api.put<SlaPolicies>(
      "/support/sla-policies",
      { items: items.map(({ category, priority, first_response_minutes, resolution_minutes }) => ({ category, priority, first_response_minutes, resolution_minutes })), reason },
    ),
};

/* ---------------------------------------------------------------- staff, roles, approvals */

export const StaffApi = {
  list: (f: { q?: string; role?: string; status?: string; cursor?: string | null }) =>
    api.get<Page<Staff>>("/staff", { query: { q: f.q, role: f.role, status: f.status, cursor: f.cursor, limit: 50 } }),
  create: (body: StaffCreate) => api.post<StaffCreated>("/staff", body, { idempotencyKey: true }),
  patch: (id: string, body: StaffPatch) => api.patch<Staff | StaffPatchPending>(`/staff/${enc(id)}`, body),
  resetPassword: (id: string, reason: string) => api.post<StaffResetResponse>(`/staff/${enc(id)}/reset-password`, { reason }),
  resetMfa: (id: string, reason: string) => api.post<Staff | { approval: Approval }>(`/staff/${enc(id)}/reset-mfa`, { reason }),
  roles: () => api.get<{ items: Role[] }>("/roles"),
  putRole: (code: RoleCode, permissions: Permission[], reason: string) => api.put<{ approval: Approval }>(`/roles/${enc(code)}`, { permissions, reason }),
  approvals: (status?: string, cursor?: string | null) => api.get<Page<Approval>>("/approvals", { query: { status, cursor } }),
  approve: (id: string, note: string) => api.post<ApprovalDecision>(`/approvals/${enc(id)}/approve`, { note }),
  reject: (id: string, note: string) => api.post<ApprovalDecision>(`/approvals/${enc(id)}/reject`, { note }),
};

/* ---------------------------------------------------------------- audit */

export interface AuditFilters {
  action?: string;
  actor_id?: string;
  object_type?: string;
  object_id?: string;
  from?: string;
  to?: string;
  cursor?: string | null;
}

export const Audit = {
  list: (f: AuditFilters) => api.get<Page<AuditRecord>>("/audit/records", { query: { ...f, limit: 50 } }),
  get: (id: string) => api.get<AuditRecord>(`/audit/records/${enc(id)}`),
  verify: () => api.get<ChainVerification>("/audit/verify"),
};

/* ---------------------------------------------------------------- experience config */

/** GET /admin/v1/experience/admin/current → admin.ts AdminExperience (review T2-6; admin-bff checks it strictly). */
export const Experience = {
  adminCurrent: () => api.get<AdminExperience>("/experience/admin/current"),
  state: (app: ConfigApp) => api.get<ConfigState>(`/experience/${app}/state`),
  versions: (app: ConfigApp, cursor?: string | null) => api.get<Page<ConfigVersion>>(`/experience/${app}/versions`, { query: { cursor } }),
  version: (app: ConfigApp, version: string) => api.get<ConfigVersion>(`/experience/${app}/versions/${enc(version)}`),
  activations: (app: ConfigApp) => api.get<Page<ConfigActivation>>(`/experience/${app}/activations`),
  create: (app: ConfigApp, version: string, payload: Record<string, unknown>, change_note: string) =>
    api.post<ConfigVersion>(`/experience/${app}/versions`, { version, payload, change_note }, { idempotencyKey: true }),
  activate: (app: ConfigApp, version: string, reason: string) =>
    api.post<ConfigActivation>(`/experience/${app}/activate`, { version, reason }, { idempotencyKey: true }),
  rollback: (app: ConfigApp, reason: string) => api.post<ConfigActivation>(`/experience/${app}/rollback`, { reason }, { idempotencyKey: true }),
};

/* ---------------------------------------------------------------- «Что нового» (experience-config) */

export const ReleaseNotes = {
  list: (status?: ReleaseNoteStatus | null, cursor?: string | null) =>
    api.get<Page<StaffReleaseNote>>("/release-notes", { query: { status: status ?? undefined, cursor, limit: 50 } }),
  get: (id: string) => api.get<StaffReleaseNote>(`/release-notes/${enc(id)}`),
  stats: (id: string) => api.get<ReleaseNoteStats>(`/release-notes/${enc(id)}/stats`),
  create: (body: ReleaseNoteContent, idempotencyKey: string) => api.post<StaffReleaseNote>("/release-notes", body, { idempotencyKey }),
  update: (id: string, expected_version: number, body: ReleaseNoteContent) =>
    api.put<StaffReleaseNote>(`/release-notes/${enc(id)}`, { ...body, expected_version }),
  publish: (id: string, expected_version: number, reason: string, idempotencyKey: string) =>
    api.post<StaffReleaseNote>(`/release-notes/${enc(id)}/publish`, { expected_version, reason }, { idempotencyKey }),
  archive: (id: string, reason: string, idempotencyKey: string) =>
    api.post<StaffReleaseNote>(`/release-notes/${enc(id)}/archive`, { reason }, { idempotencyKey }),
};

/* ---------------------------------------------------------------- notification templates (notifications) */

export const Templates = {
  list: () => api.get<{ items: TemplateInfo[] }>("/notifications/templates"),
  get: (key: string) => api.get<TemplateInfo & { versions: TemplateVersion[] }>(`/notifications/templates/${enc(key)}`),
  createVersion: (key: string, texts: TemplateTexts, note: string, idempotencyKey: string) =>
    api.post<TemplateVersion>(`/notifications/templates/${enc(key)}/versions`, { texts, note }, { idempotencyKey }),
  preview: (key: string, v: number, lang: UiLang, sample?: Record<string, string>) =>
    api.post<TemplatePreview>(`/notifications/templates/${enc(key)}/versions/${v}/preview`, sample ? { lang, sample } : { lang }),
  activate: (key: string, v: number, reason: string) => api.post<TemplateVersion>(`/notifications/templates/${enc(key)}/versions/${v}/activate`, { reason }),
  reset: (key: string, reason: string) => api.post<TemplateInfo>(`/notifications/templates/${enc(key)}/reset`, { reason }),
  testRecipients: () => api.get<{ items: TestRecipient[] }>("/notifications/test-recipients"),
  test: (key: string, v: number, lang: UiLang, recipient: number) =>
    api.post<TestSendResult>(`/notifications/templates/${enc(key)}/versions/${v}/test`, { lang, recipient }),
};

/* ---------------------------------------------------------------- campaigns (notifications) */

export const Campaigns = {
  list: (status?: CampaignStatus | null, cursor?: string | null, background = false) =>
    api.get<Page<Campaign>>("/notifications/campaigns", { query: { status: status ?? undefined, cursor, limit: 50 }, background }),
  get: (id: string, background = false) => api.get<Campaign>(`/notifications/campaigns/${enc(id)}`, { background }),
  create: (body: CampaignContent, idempotencyKey: string) => api.post<Campaign>("/notifications/campaigns", body, { idempotencyKey }),
  patch: (id: string, expected_version: number, body: Partial<CampaignContent>) =>
    api.patch<Campaign>(`/notifications/campaigns/${enc(id)}`, { ...body, expected_version }),
  estimate: (id: string) => api.post<CampaignEstimate>(`/notifications/campaigns/${enc(id)}/estimate`),
  preview: (id: string, lang: UiLang) => api.post<TemplatePreview>(`/notifications/campaigns/${enc(id)}/preview`, { lang }),
  test: (id: string, lang: UiLang, recipient: number) => api.post<TestSendResult>(`/notifications/campaigns/${enc(id)}/test`, { lang, recipient }),
  /** send_at: null — «Отправить сейчас» by the server clock (QA D2-03, review T2-11); the answer is already sending. */
  schedule: (id: string, expected_version: number, send_at: string | null, reason: string, idempotencyKey: string) =>
    api.post<Campaign>(`/notifications/campaigns/${enc(id)}/schedule`, { expected_version, send_at, reason }, { idempotencyKey }),
  unschedule: (id: string, reason: string) => api.post<Campaign>(`/notifications/campaigns/${enc(id)}/unschedule`, { reason }),
  stop: (id: string, reason: string) => api.post<Campaign>(`/notifications/campaigns/${enc(id)}/stop`, { reason }),
};
