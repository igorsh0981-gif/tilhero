import type {
  AdminExperience,
  AdminMediaRequest,
  AudioBlob,
  AudioUpload,
  ContentPublishInput,
  ContentReviewInput,
  ContentRollbackInput,
  ContentRow,
  ContentSummary,
  ContentValidationError,
  ContentVersion,
  ContentVersionMeta,
  DiagnosticStats,
  DiagnosticTestRow,
  DiagnosticTestVersion,
  Language,
  LanguagePair,
  MediaRequestDecision,
  PairCard,
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
import type { Band, ContentKind, MediaRequestStatus, ScenarioTestRun, VersionStatus } from "@tilhero/contracts/content";
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

/* ---------------------------------------------------------------- content (catalog via admin-bff, sprint 3) */

export interface ContentFilters {
  q?: string;
  status?: VersionStatus | "";
  level?: Band | "";
  cursor?: string | null;
  limit?: number;
}

export const Content = {
  list: (kind: ContentKind, f: ContentFilters = {}, background = false) =>
    api.get<Page<ContentRow>>(`/content/${kind}`, { query: { q: f.q, status: f.status, level: f.level, cursor: f.cursor, limit: f.limit ?? 100 }, background }),
  entity: (kind: ContentKind, key: string) => api.get<{ row: ContentRow; versions: ContentVersionMeta[] }>(`/content/${kind}/${enc(key)}`),
  version: <P = Record<string, unknown>>(kind: ContentKind, key: string, v: number) => api.get<ContentVersion<P>>(`/content/${kind}/${enc(key)}/versions/${v}`),
  create: (kind: ContentKind, payload: unknown, idempotencyKey: string) => api.post<ContentVersion>(`/content/${kind}`, { payload }, { idempotencyKey }),
  newDraft: (kind: ContentKind, key: string, from_version: number, idempotencyKey: string) =>
    api.post<ContentVersion>(`/content/${kind}/${enc(key)}/versions`, { from_version }, { idempotencyKey }),
  save: (kind: ContentKind, key: string, v: number, payload: unknown, expected_hash: string) =>
    api.put<ContentVersion>(`/content/${kind}/${enc(key)}/versions/${v}`, { payload, expected_hash }),
  validate: (kind: ContentKind, key: string, v: number) => api.post<{ ok: boolean; errors: ContentValidationError[] }>(`/content/${kind}/${enc(key)}/versions/${v}/validate`),
  submit: (kind: ContentKind, key: string, v: number) => api.post<ContentVersion>(`/content/${kind}/${enc(key)}/versions/${v}/submit`),
  review: (kind: ContentKind, key: string, v: number, body: ContentReviewInput) => api.post<ContentVersion>(`/content/${kind}/${enc(key)}/versions/${v}/review`, body),
  publish: (kind: ContentKind, key: string, v: number, reason: string, idempotencyKey: string) =>
    api.post<ContentVersion>(`/content/${kind}/${enc(key)}/versions/${v}/publish`, { reason } satisfies ContentPublishInput, { idempotencyKey }),
  archive: (kind: ContentKind, key: string, reason: string) => api.post<{ row: ContentRow }>(`/content/${kind}/${enc(key)}/archive`, { reason }),
  rollback: (kind: ContentKind, key: string, to_version: number, reason: string) =>
    api.post<ContentVersion>(`/content/${kind}/${enc(key)}/rollback`, { to_version, reason } satisfies ContentRollbackInput),
  testRun: (key: string, v: number) => api.post<ScenarioTestRun>(`/content/scenario/${enc(key)}/versions/${v}/test-run`),
  rightsApprove: (key: string, v: number, note: string) => api.post<ContentVersion>(`/content/media_asset/${enc(key)}/versions/${v}/rights-approve`, { note }),
  upload: (body: AudioUpload, idempotencyKey: string) => api.post<AudioBlob>("/content/blobs", body, { idempotencyKey }),
  /** same-origin URL of an uploaded audio file for the preview player (content.read; CSP media-src 'self') */
  blobUrl: (blobId: string) => api.url(`/content/blobs/${enc(blobId)}`),
  reviewQueue: (kind?: ContentKind | "", cursor?: string | null) => api.get<Page<ContentRow>>("/content/review-queue", { query: { kind, cursor } }),
  summary: () => api.get<ContentSummary>("/content/summary"),
};

export const MediaRequests = {
  list: (f: { status?: MediaRequestStatus | ""; q?: string; cursor?: string | null }) =>
    api.get<Page<AdminMediaRequest>>("/content/media-requests", { query: { status: f.status, q: f.q, cursor: f.cursor } }),
  take: (id: string) => api.post<AdminMediaRequest>(`/content/media-requests/${enc(id)}/take`),
  decide: (id: string, body: MediaRequestDecision) => api.post<AdminMediaRequest>(`/content/media-requests/${enc(id)}/decide`, body),
};

/* ---------------------------------------------------------------- languages and pairs (catalog, lang.manage) */

export const Languages = {
  list: () => api.get<{ items: Language[] }>("/languages"),
  put: (lang: Language) => api.put<Language>(`/languages/${enc(lang.code)}`, lang),
  pairs: () => api.get<{ items: PairCard[] }>("/language-pairs"),
  putPair: (pair: LanguagePair, reason: string) => api.put<PairCard>(`/language-pairs/${enc(pair.pair_id)}`, { ...pair, reason }),
};

/* ---------------------------------------------------------------- diagnostics (tests and statistics) */

export const Diagnostics = {
  tests: () => api.get<{ items: DiagnosticTestRow[] }>("/diagnostics/tests"),
  version: (testId: string, v: number) => api.get<DiagnosticTestVersion>(`/diagnostics/tests/${enc(testId)}/versions/${v}`),
  publish: (testId: string, v: number, reason: string) => api.post<DiagnosticTestRow>(`/diagnostics/tests/${enc(testId)}/versions/${v}/publish`, { reason }),
  stats: (period: Period) => api.get<DiagnosticStats>("/diagnostics/stats", { query: { period } }),
};
