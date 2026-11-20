import type {
  AdminCardDetail,
  AdminCardRow,
  CardAction,
  ForgettingAnalytics,
  GlossaryCreate,
  GlossaryDetail,
  GlossaryPatch,
  GlossaryReview,
  GlossaryRow,
  GlossaryStats,
  LearnerMemorySummary,
  MemoryStats,
  ReviewLogRow,
  AdminAppeal,
  AdminExperience,
  AgentId,
  AgentRow,
  AgentDetail,
  AgentVersionPatch,
  AgentVersionView,
  AiBudget,
  AiCall,
  AiModel,
  AiProviderStatus,
  AiUsageSummary,
  AppealDecision,
  EvaluationCard,
  GoldenCase,
  GoldenCaseInput,
  Reevaluation,
  SessionCard,
  SessionFlag,
  SessionRow,
  TestRun,
  TestRunSummary,
  Transcript,
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
import type { Band, ContentKind, GlossaryReviewStatus, GlossarySource, MediaRequestStatus, ScenarioTestRun, VersionStatus } from "@tilhero/contracts/content";
import type { SessionKind } from "@tilhero/contracts/ai";
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

/* ---------------------------------------------------------------- AI agents, models, budget (ai-gateway, sprint 4) */

/** admin.ts AgentDetail (row + versions) and AgentVersionView (version + names; `updated_at` — the If-Match of PATCH) */
export type { AgentDetail, AgentVersionView };
export type AgentCardView = AgentDetail;
export type BudgetInput = Pick<AiBudget, "monthly_cap_usd" | "learner_daily_cap_usd" | "lesson_cap_usd" | "alert_percent">;

export const Ai = {
  agents: (background = false) => api.get<{ items: AgentRow[] }>("/ai/agents", { background }),
  agent: (id: AgentId) => api.get<AgentCardView>(`/ai/agents/${enc(id)}`),
  version: (id: AgentId, v: number) => api.get<AgentVersionView>(`/ai/agents/${enc(id)}/versions/${v}`),
  newDraft: (id: AgentId, from_version: number | null, idempotencyKey: string) =>
    api.post<AgentVersionView>(`/ai/agents/${enc(id)}/versions`, from_version != null ? { from_version } : {}, { idempotencyKey }),
  /** If-Match: updated_at of the version that was read (409 VERSION_CONFLICT when someone saved in between) */
  saveDraft: (id: AgentId, v: number, patch: AgentVersionPatch, ifMatch: string) =>
    api.patch<AgentVersionView>(`/ai/agents/${enc(id)}/versions/${v}`, patch, { headers: { "If-Match": ifMatch } }),
  deleteDraft: (id: AgentId, v: number) => api.del<void>(`/ai/agents/${enc(id)}/versions/${v}`),
  runTests: (id: AgentId, v: number, idempotencyKey: string) => api.post<TestRunSummary>(`/ai/agents/${enc(id)}/versions/${v}/test-runs`, undefined, { idempotencyKey }),
  /** progress poll (admin.ts: GET …/test-runs/{run_id} → TestRun) — background: it never extends the idle session */
  testRun: (id: AgentId, v: number, runId: string) => api.get<TestRun>(`/ai/agents/${enc(id)}/versions/${v}/test-runs/${enc(runId)}`, { background: true }),
  publish: (id: AgentId, v: number, reason: string, idempotencyKey: string) => api.post<AgentRow>(`/ai/agents/${enc(id)}/versions/${v}/publish`, { reason }, { idempotencyKey }),
  setCanary: (id: AgentId, version: number, percent: number, reason: string) => api.put<AgentRow>(`/ai/agents/${enc(id)}/canary`, { version, percent, reason }),
  clearCanary: (id: AgentId, reason: string) => api.del<AgentRow>(`/ai/agents/${enc(id)}/canary`, { reason }),
  rollback: (id: AgentId, reason: string) => api.post<AgentRow>(`/ai/agents/${enc(id)}/rollback`, { reason }, { idempotencyKey: true }),
  cases: (id: AgentId) => api.get<{ items: GoldenCase[] }>(`/ai/agents/${enc(id)}/golden-cases`),
  createCase: (id: AgentId, body: GoldenCaseInput, idempotencyKey: string) => api.post<GoldenCase>(`/ai/agents/${enc(id)}/golden-cases`, body, { idempotencyKey }),
  updateCase: (caseId: string, body: GoldenCaseInput) => api.patch<GoldenCase>(`/ai/golden-cases/${enc(caseId)}`, body),
  archiveCase: (caseId: string) => api.del<void>(`/ai/golden-cases/${enc(caseId)}`),
  models: () => api.get<{ items: AiModel[] }>("/ai/models"),
  /** sprint 5: a speech model (azure_speech / fake_speech) also carries the price of an audio hour; an LLM never sends it
   *  (ai-gateway answers 422 PRICE_NOT_APPLICABLE) */
  putModel: (m: Pick<AiModel, "model_id" | "input_usd_per_mtok" | "output_usd_per_mtok" | "active"> & { audio_usd_per_hour?: number | null }, reason: string) =>
    api.put<AiModel>(`/ai/models/${enc(m.model_id)}`, {
      input_usd_per_mtok: m.input_usd_per_mtok,
      output_usd_per_mtok: m.output_usd_per_mtok,
      ...(m.audio_usd_per_hour != null ? { audio_usd_per_hour: m.audio_usd_per_hour } : {}),
      active: m.active,
      reason,
    }),
  provider: (background = false) => api.get<AiProviderStatus>("/ai/provider", { background }),
  budget: (background = false) => api.get<AiBudget>("/ai/budget", { background }),
  /** updatedAt — `updated_at` of the budget that was read: ai-gateway answers 409 BUDGET_CONFLICT {updated_at} when
   *  someone changed the limits in between (review R2-07) */
  putBudget: (b: BudgetInput, updatedAt: string, reason: string) => api.put<AiBudget>("/ai/budget", { ...b, updated_at: updatedAt, reason }),
  /** stop=true — the emergency stop is engaged (every call answers unavailable: ai_disabled); false — AI back on */
  emergencyStop: (stop: boolean, reason: string) => api.post<AiBudget>("/ai/emergency-stop", { enabled: stop, reason }),
  usageSummary: (period: AiUsageSummary["period"], background = false) => api.get<AiUsageSummary>("/ai/usage/summary", { query: { period }, background }),
  usage: (f: { session_id?: string; agent_id?: AgentId; cursor?: string | null }) => api.get<Page<AiCall>>("/ai/usage", { query: { ...f, limit: 50 } }),
};

/* ---------------------------------------------------------------- dialogue QA (lessons + assessment, sprint 4) */

export interface SessionFilters {
  from?: string;
  to?: string;
  kind?: SessionKind | "";
  status?: SessionRow["status"] | "";
  outcome?: NonNullable<SessionRow["outcome"]> | "";
  flag?: SessionFlag | "";
  lesson_id?: string;
  level?: Band | "";
  cursor?: string | null;
}

export const Qa = {
  sessions: (f: SessionFilters) =>
    api.get<Page<SessionRow>>("/qa/sessions", { query: { from: f.from, to: f.to, kind: f.kind, status: f.status, outcome: f.outcome, flag: f.flag, lesson_id: f.lesson_id, level: f.level, cursor: f.cursor, limit: 50 } }),
  session: (id: string) => api.get<SessionCard>(`/qa/sessions/${enc(id)}`),
  transcript: (id: string, reason: string) => api.post<Transcript>(`/qa/sessions/${enc(id)}/transcript`, { reason }),
  flag: (evaluationId: string, reason: string) => api.post<EvaluationCard>(`/qa/evaluations/${enc(evaluationId)}/flag`, { reason }),
  reevaluate: (evaluationId: string, body: Reevaluation, idempotencyKey: string) => api.post<EvaluationCard>(`/qa/evaluations/${enc(evaluationId)}/reevaluate`, body, { idempotencyKey }),
  appeals: (status: AdminAppeal["status"] | "", cursor?: string | null, background = false) => api.get<Page<AdminAppeal>>("/qa/appeals", { query: { status, cursor, limit: 50 }, background }),
  take: (id: string) => api.post<AdminAppeal>(`/qa/appeals/${enc(id)}/take`),
  decide: (id: string, body: AppealDecision) => api.post<AdminAppeal>(`/qa/appeals/${enc(id)}/decide`, body),
};

/* ---------------------------------------------------------------- course dictionary (catalog via admin-bff, sprint 5) */

export interface GlossaryFilters {
  pair_id?: string;
  q?: string;
  source?: GlossarySource | "";
  review_status?: GlossaryReviewStatus | "";
  cursor?: string | null;
  limit?: number;
}

export const Glossary = {
  /** review_status=pending — the queue of AI translations (the catalog sorts it by the places in the content) */
  list: (f: GlossaryFilters) =>
    api.get<Page<GlossaryRow>>("/glossary", { query: { pair_id: f.pair_id, q: f.q, source: f.source, review_status: f.review_status, cursor: f.cursor, limit: f.limit ?? 50 } }),
  stats: (pairId?: string, background = false) => api.get<GlossaryStats>("/glossary/stats", { query: { pair_id: pairId }, background }),
  get: (id: string) => api.get<GlossaryDetail>(`/glossary/${enc(id)}`),
  create: (body: GlossaryCreate, idempotencyKey: string) => api.post<GlossaryDetail>("/glossary", body, { idempotencyKey }),
  /** If-Match: `updated_at` of the entry that was read (missing → 428 IF_MATCH_REQUIRED, stale → 409 VERSION_CONFLICT) */
  patch: (id: string, body: GlossaryPatch, ifMatch: string) => api.patch<GlossaryDetail>(`/glossary/${enc(id)}`, body, { headers: { "If-Match": ifMatch } }),
  review: (id: string, body: GlossaryReview, idempotencyKey: string) => api.post<GlossaryDetail>(`/glossary/${enc(id)}/review`, body, { idempotencyKey }),
  /** only a methodist entry (course / ai → 409 ARCHIVE_NOT_ALLOWED) */
  archive: (id: string, reason: string) => api.del<void>(`/glossary/${enc(id)}`, { reason }),
};

/* ---------------------------------------------------------------- learner memory and forgetting analytics (memory, sprint 5) */

export interface CardFilters {
  status?: AdminCardDetail["status"] | "";
  kind?: AdminCardDetail["kind"] | "";
  cursor?: string | null;
  limit?: number;
}

export const Memory = {
  learner: (userId: string) => api.get<LearnerMemorySummary>(`/memory/learners/${enc(userId)}`),
  cards: (userId: string, f: CardFilters) => api.get<Page<AdminCardRow>>(`/memory/learners/${enc(userId)}/cards`, { query: { status: f.status, kind: f.kind, cursor: f.cursor, limit: f.limit ?? 50 } }),
  card: (cardId: string) => api.get<AdminCardDetail>(`/memory/cards/${enc(cardId)}`),
  log: (cardId: string, cursor: string) => api.get<Page<ReviewLogRow>>(`/memory/cards/${enc(cardId)}/log`, { query: { cursor } }),
  /** one card at a time (memory.manage, step-up; reason ≥ 10) — there are no bulk actions */
  act: (cardId: string, action: CardAction, idempotencyKey: string) => api.post<AdminCardDetail>(`/memory/cards/${enc(cardId)}/actions`, action, { idempotencyKey }),
  analytics: (period: ForgettingAnalytics["period"], pairId?: string) => api.get<ForgettingAnalytics>("/memory/analytics", { query: { period, pair_id: pairId } }),
  stats: (period: Period) => api.get<MemoryStats>("/memory/stats", { query: { period } }),
};
