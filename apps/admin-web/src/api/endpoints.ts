import type {
  AdminCase,
  AdminCaseRow,
  AdminDuel,
  AdminDuelRow,
  AdminLeagueGroup,
  AdminLeagueWeek,
  AdminPairRoom,
  AdminPairRoomRow,
  AdminReferral,
  AdminReferralRow,
  AdminSanction,
  AdminSanctionAppeal,
  AdminSocialCard,
  CaseResolveRequest,
  CaseStatus,
  DuelReevaluateRequest,
  LeagueReevaluateRequest,
  ReferralCampaignDraft,
  ReferralCampaignStats,
  ReferralCampaignSummary,
  ReferralCampaignVersion,
  ReferralRejectRequest,
  SanctionAppealDecision,
  AdminGameEvent,
  AdminGameImage,
  AdminHero,
  AdminHeroFields,
  AdminLedgerOperation,
  AdminShopItem,
  AdminWallet,
  GameEventFields,
  GameEventStatus,
  GameOverview,
  RulesDraftRequest,
  RulesValidation,
  RulesVersion,
  RulesVersionSummary,
  ShopItemCreate,
  WalletAdjustment,
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
import type {
  AdjustmentRequest,
  AdjustmentStatus,
  Adjustment,
  AdminBillingAccount,
  AdminLedgerEntry,
  AdminOrderCard,
  AdminOrderRow,
  AdminRefund,
  AiDegradationUpdate,
  AiDegradationView,
  AiUnitCosts,
  BillingDailyRow,
  BillingProviderStatus,
  BillingSummary,
  CatalogDraftRequest,
  CatalogValidation,
  CatalogVersion,
  CatalogVersionSummary,
  FinanceOverview,
  FxRate,
  FxRateRequest,
  LearnerTier,
  ReconItem,
  ReconItemKind,
  ReconRun,
  RefundStatus,
  StarRate,
  StarRateRequest,
  TrialsGrantAllResult,
} from "@tilhero/contracts/admin";
import type { Band, ContentKind, GlossaryReviewStatus, GlossarySource, MediaRequestStatus, ScenarioTestRun, VersionStatus } from "@tilhero/contracts/content";
import type { SessionKind } from "@tilhero/contracts/ai";
import type { DuelStatus, GameCurrency, PairRoomStatus, ReferralStatus, SanctionAppealStatus } from "@tilhero/contracts/bff";
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
  /** sprint 8 (ADM-USR-01): the learner's tier — free | paid (projection of billing in user-admin) */
  tier?: LearnerTier | "";
  cursor?: string | null;
  limit?: number;
}

export const Learners = {
  list: (f: LearnerFilters) =>
    api.get<Page<AdminLearnerRow>>("/learners", {
      query: { q: f.q, kind: f.kind, age_band: f.age_band, status: f.status, locale: f.locale, has_open_tickets: f.has_open_tickets ?? undefined, tier: f.tier, cursor: f.cursor, limit: f.limit ?? 50 },
    }),
  /** sprint 8: the «Тариф» tab (billing.read) — the subscription of the learner's account (a child — the guardian's) */
  billing: (id: string) => api.get<AdminBillingAccount>(`/learners/${enc(id)}/billing`),
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
export type BudgetInput = Pick<AiBudget, "monthly_cap_usd" | "learner_daily_cap_usd" | "lesson_cap_usd" | "speech_monthly_cap_usd" | "room_cap_usd" | "paid_learner_daily_cap_usd" | "alert_percent">;

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
  /** sprint 8: levels of degradation (costs.read; change — costs.manage + step-up) and the cost of activities */
  degradation: () => api.get<AiDegradationView>("/ai/degradation"),
  /** ai-gateway: costs.manage + step-up (admin-bff sends X-Step-Up), the Idempotency-Key — a repeat after a lost answer */
  putDegradation: (body: AiDegradationUpdate, idempotencyKey?: string) => api.put<AiDegradationView>("/ai/degradation", body, idempotencyKey ? { idempotencyKey } : {}),
  unitCosts: (period: AiUnitCosts["period"]) => api.get<AiUnitCosts>("/ai/unit-costs", { query: { period } }),
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

/* ---------------------------------------------------------------- game and heroes (gamification via admin-bff, sprint 6) */

export type AssetPurpose = "hero_stage" | "shop_item" | "badge";

/**
 * «Герои», «Геймификация», «События и сезоны» (admin.ts «Игра и герои»). Reads — game.read; drafts, pictures, shop
 * items and events — game.manage; activation / rollback of the rules, publication of heroes, items and events —
 * game.publish + step-up; manual wallet operations, reversals and refunds — wallet.adjust + step-up. The client never
 * sends an amount or a reason of an automatic award: only staff commands with their own reason.
 */
export const Game = {
  overview: (period: GameOverview["period"]) => api.get<GameOverview>("/game/overview", { query: { period } }),
  /* rules: draft → validate → activate (step-up, comment ≥ 10); rollback = a new version from an archived one */
  rules: () => api.get<{ items: RulesVersionSummary[] }>("/game/rules"),
  rulesVersion: (v: number) => api.get<RulesVersion>(`/game/rules/${v}`),
  /** If-Match: `updated_at` of the draft that was read (409 DRAFT_CONFLICT when someone saved in between); none for a new draft */
  saveDraft: (body: RulesDraftRequest, ifMatch: string | null) => api.put<RulesVersion>("/game/rules/draft", body, ifMatch ? { headers: { "If-Match": ifMatch } } : {}),
  deleteDraft: () => api.del<void>("/game/rules/draft"),
  validate: () => api.post<RulesValidation>("/game/rules/draft/validate"),
  activate: (comment: string, idempotencyKey: string) => api.post<RulesVersion>("/game/rules/draft/activate", { comment }, { idempotencyKey }),
  rollback: (version: number, comment: string, idempotencyKey: string) => api.post<RulesVersion>(`/game/rules/${version}/rollback`, { comment }, { idempotencyKey }),
  /* heroes and pictures */
  heroes: () => api.get<{ items: AdminHero[] }>("/game/heroes"),
  saveHero: (code: string, body: AdminHeroFields) => api.put<AdminHero>(`/game/heroes/${enc(code)}/draft`, body),
  publishHero: (code: string, comment: string, idempotencyKey: string) => api.post<AdminHero>(`/game/heroes/${enc(code)}/publish`, { comment }, { idempotencyKey }),
  /** raw bytes ≤ 300 KB, ≤ 1024×1024 (413 ASSET_TOO_LARGE, 422 ASSET_INVALID); the same picture → the same asset_id */
  upload: (data: Uint8Array, type: "image/webp" | "image/png", purpose: AssetPurpose) => api.upload<AdminGameImage>(`/game/assets?purpose=${enc(purpose)}`, data, type),
  /* shop */
  items: () => api.get<{ items: AdminShopItem[] }>("/game/shop/items"),
  createItem: (body: ShopItemCreate, idempotencyKey: string) => api.post<AdminShopItem>("/game/shop/items", body, { idempotencyKey }),
  patchItem: (code: string, body: Partial<ShopItemCreate>) => api.patch<AdminShopItem>(`/game/shop/items/${enc(code)}`, body),
  publishItem: (code: string, comment: string, idempotencyKey: string) => api.post<AdminShopItem>(`/game/shop/items/${enc(code)}/publish`, { comment }, { idempotencyKey }),
  retireItem: (code: string, comment: string, idempotencyKey: string) => api.post<AdminShopItem>(`/game/shop/items/${enc(code)}/retire`, { comment }, { idempotencyKey }),
  /* events of the week */
  events: (status?: GameEventStatus | "") => api.get<{ items: AdminGameEvent[] }>("/game/events", { query: { status } }),
  createEvent: (body: GameEventFields, idempotencyKey: string) => api.post<AdminGameEvent>("/game/events", body, { idempotencyKey }),
  patchEvent: (id: string, body: Partial<GameEventFields>) => api.patch<AdminGameEvent>(`/game/events/${enc(id)}`, body),
  publishEvent: (id: string, comment: string, idempotencyKey: string) => api.post<AdminGameEvent>(`/game/events/${enc(id)}/publish`, { comment }, { idempotencyKey }),
  cancelEvent: (id: string, comment: string, idempotencyKey: string) => api.post<AdminGameEvent>(`/game/events/${enc(id)}/cancel`, { comment }, { idempotencyKey }),
  /* wallets of learners */
  wallet: (userId: string) => api.get<AdminWallet>(`/game/wallets/${enc(userId)}`),
  ledger: (userId: string, currency: GameCurrency | "", cursor?: string | null) =>
    api.get<Page<AdminLedgerOperation>>(`/game/wallets/${enc(userId)}/ledger`, { query: { currency, cursor, limit: 50 } }),
  adjust: (userId: string, body: WalletAdjustment, idempotencyKey: string) => api.post<AdminLedgerOperation>(`/game/wallets/${enc(userId)}/adjustments`, body, { idempotencyKey }),
  reverse: (userId: string, opId: string, reason: string, idempotencyKey: string) =>
    api.post<AdminLedgerOperation>(`/game/wallets/${enc(userId)}/ledger/${enc(opId)}/reverse`, { reason }, { idempotencyKey }),
  refund: (userId: string, purchaseId: string, reason: string, idempotencyKey: string) =>
    api.post<{ operations: AdminLedgerOperation[] }>(`/game/wallets/${enc(userId)}/purchases/${enc(purchaseId)}/refund`, { reason }, { idempotencyKey }),
};

/* ---------------------------------------------------------------- sprint 7: «Сообщество» (admin.ts «Социальное») */

/**
 * «Друзья и жалобы» (social.read): the social card of a learner — profile, counters, request statuses, cases and
 * sanctions; never correspondence, answers or the other side of a request.
 */
export const Social = {
  card: (userId: string) => api.get<AdminSocialCard>(`/social/users/${enc(userId)}`),
};

/**
 * «Модерация» (moderation.manage): the queue of cases (the subject of the complaint, no correspondence), the decision
 * (a ban > 7 days or for ever — step-up), sanctions and their revocation, appeals. Every command — audit and a basis /
 * reason / note of 10..500 characters; the same Idempotency-Key is kept for the step-up repeat.
 */
export const Moderation = {
  cases: (status: CaseStatus, cursor?: string | null) => api.get<Page<AdminCaseRow>>("/moderation/cases", { query: { status, cursor, limit: 50 } }),
  caseOf: (id: string) => api.get<AdminCase>(`/moderation/cases/${enc(id)}`),
  resolve: (id: string, body: CaseResolveRequest, idempotencyKey: string) => api.post<AdminCase>(`/moderation/cases/${enc(id)}/resolve`, body, { idempotencyKey }),
  sanctions: (f: { user_id?: string; active?: boolean | null; cursor?: string | null }) =>
    api.get<Page<AdminSanction>>("/moderation/sanctions", { query: { user_id: f.user_id, active: f.active == null ? undefined : String(f.active), cursor: f.cursor, limit: 50 } }),
  revoke: (id: string, reason: string, idempotencyKey: string) => api.post<AdminSanction>(`/moderation/sanctions/${enc(id)}/revoke`, { reason }, { idempotencyKey }),
  appeals: (status: SanctionAppealStatus, cursor?: string | null) => api.get<Page<AdminSanctionAppeal>>("/moderation/appeals", { query: { status, cursor, limit: 50 } }),
  decideAppeal: (id: string, body: SanctionAppealDecision, idempotencyKey: string) => api.post<AdminSanctionAppeal>(`/moderation/appeals/${enc(id)}/decide`, body, { idempotencyKey }),
};

/**
 * «Реферальные кампании» (referral.read; commands — referral.manage): campaign versions (draft → validate → activate
 * with step-up and a comment), the review queue (approve / reject with a note, one re-decision), statistics.
 */
export const Referrals = {
  campaigns: () => api.get<{ items: ReferralCampaignSummary[] }>("/referrals/campaigns"),
  campaign: (v: number) => api.get<ReferralCampaignVersion>(`/referrals/campaigns/${v}`),
  /** If-Match: `updated_at` of the draft that was read (409 DRAFT_CONFLICT when someone saved in between) */
  saveDraft: (body: ReferralCampaignDraft, ifMatch: string | null) => api.put<ReferralCampaignVersion>("/referrals/campaigns/draft", body, ifMatch ? { headers: { "If-Match": ifMatch } } : {}),
  deleteDraft: () => api.del<void>("/referrals/campaigns/draft"),
  validate: () => api.post<RulesValidation>("/referrals/campaigns/draft/validate"),
  activate: (comment: string, idempotencyKey: string) => api.post<ReferralCampaignVersion>("/referrals/campaigns/draft/activate", { comment }, { idempotencyKey }),
  stats: () => api.get<{ items: ReferralCampaignStats[] }>("/referrals/campaigns/stats"),
  list: (status: ReferralStatus | "", cursor?: string | null) => api.get<Page<AdminReferralRow>>("/referrals", { query: { status, cursor, limit: 50 } }),
  get: (id: string) => api.get<AdminReferral>(`/referrals/${enc(id)}`),
  approve: (id: string, note: string, idempotencyKey: string) => api.post<AdminReferral>(`/referrals/${enc(id)}/approve`, { note }, { idempotencyKey }),
  reject: (id: string, body: ReferralRejectRequest, idempotencyKey: string) => api.post<AdminReferral>(`/referrals/${enc(id)}/reject`, body, { idempotencyKey }),
};

/**
 * «Лиги и дуэли» (league.read; commands — league.manage): weeks and groups, members, results as versions, anomalies,
 * the release of held prizes, the re-evaluation of a group or a duel (step-up; the previous record is kept).
 */
export const Leagues = {
  week: (week?: string | null) => api.get<AdminLeagueWeek>("/game/leagues", { query: { week } }),
  group: (id: string) => api.get<AdminLeagueGroup>(`/game/leagues/${enc(id)}`),
  reevaluate: (id: string, body: LeagueReevaluateRequest, idempotencyKey: string) => api.post<AdminLeagueGroup>(`/game/leagues/${enc(id)}/reevaluate`, body, { idempotencyKey }),
  release: (id: string, reason: string, idempotencyKey: string) => api.post<AdminLeagueGroup>(`/game/leagues/${enc(id)}/release-prizes`, { reason }, { idempotencyKey }),
  duels: (status: DuelStatus | "", cursor?: string | null) => api.get<Page<AdminDuelRow>>("/game/duels", { query: { status, cursor, limit: 50 } }),
  duel: (id: string) => api.get<AdminDuel>(`/game/duels/${enc(id)}`),
  reevaluateDuel: (id: string, body: DuelReevaluateRequest, idempotencyKey: string) => api.post<AdminDuel>(`/game/duels/${enc(id)}/reevaluate`, body, { idempotencyKey }),
};

/**
 * «Парные комнаты» (room.read; stop — room.manage + step-up): rooms with participants, durations, the speaking seconds
 * of each and the AI cost; the course of events without the texts of the replies and without assessments.
 */
export const PairRooms = {
  list: (f: { status?: PairRoomStatus | ""; from?: string; to?: string; cursor?: string | null }) => api.get<Page<AdminPairRoomRow>>("/pair-rooms", { query: { status: f.status, from: f.from, to: f.to, cursor: f.cursor, limit: 50 } }),
  get: (id: string) => api.get<AdminPairRoom>(`/pair-rooms/${enc(id)}`),
  stop: (id: string, reason: string, idempotencyKey: string) => api.post<AdminPairRoom>(`/pair-rooms/${enc(id)}/stop`, { reason }, { idempotencyKey }),
};

/* ---------------------------------------------------------------- money (sprint 8, billing) */

export interface OrderQuery {
  status?: string;
  channel?: string;
  provider?: string;
  product_kind?: string;
  order_no?: string;
  provider_txn_id?: string;
  account_id?: string;
  from?: string;
  to?: string;
  cursor?: string | null;
}

/**
 * «Деньги» (billing.read; commands — billing.manage / billing.publish / billing.refund / billing.approve /
 * subscriptions.override, step-up as INTERNAL_API §12). Every command carries an Idempotency-Key built by the screen
 * from the command itself (CommandKey) — never from a version that changes after a lost answer.
 */
export const Billing = {
  catalog: () => api.get<{ items: CatalogVersionSummary[] }>("/billing/catalog"),
  catalogVersion: (v: number) => api.get<CatalogVersion>(`/billing/catalog/${v}`),
  /** If-Match: `updated_at` of the draft that was read (409 DRAFT_CONFLICT when someone saved in between) */
  saveDraft: (body: CatalogDraftRequest, ifMatch: string | null) => api.put<CatalogVersion>("/billing/catalog/draft", body, ifMatch ? { headers: { "If-Match": ifMatch } } : {}),
  deleteDraft: () => api.del<void>("/billing/catalog/draft"),
  validate: () => api.post<CatalogValidation>("/billing/catalog/draft/validate"),
  activate: (comment: string, idempotencyKey: string) => api.post<CatalogVersion>("/billing/catalog/draft/activate", { comment }, { idempotencyKey }),
  rollback: (version: number, comment: string, idempotencyKey: string) => api.post<CatalogVersion>(`/billing/catalog/${version}/rollback`, { comment }, { idempotencyKey }),
  grantTrials: (reason: string, idempotencyKey: string) => api.post<TrialsGrantAllResult>("/billing/trials:grant-all", { reason }, { idempotencyKey }),
  orders: (q: OrderQuery) => api.get<Page<AdminOrderRow>>("/billing/orders", { query: { ...q, limit: 50 } }),
  order: (id: string) => api.get<AdminOrderCard>(`/billing/orders/${enc(id)}`),
  refund: (orderId: string, reason: string, force: boolean, idempotencyKey: string) =>
    api.post<AdminRefund>(`/billing/orders/${enc(orderId)}/refunds`, force ? { reason, force } : { reason }, { idempotencyKey }),
  refunds: (status: RefundStatus | "", cursor?: string | null) => api.get<Page<AdminRefund>>("/billing/refunds", { query: { status, cursor, limit: 50 } }),
  failRefund: (id: string, note: string, idempotencyKey: string) => api.post<AdminRefund>(`/billing/refunds/${enc(id)}/fail`, { note }, { idempotencyKey }),
  account: (id: string) => api.get<AdminBillingAccount>(`/billing/accounts/${enc(id)}`),
  ledger: (id: string, cursor?: string | null) => api.get<Page<AdminLedgerEntry>>(`/billing/accounts/${enc(id)}/ledger`, { query: { cursor, limit: 50 } }),
  requestAdjustment: (accountId: string, body: AdjustmentRequest, idempotencyKey: string) => api.post<Adjustment>(`/billing/accounts/${enc(accountId)}/adjustments`, body, { idempotencyKey }),
  adjustments: (status: AdjustmentStatus | "", cursor?: string | null, accountId?: string | null) =>
    api.get<Page<Adjustment>>("/billing/adjustments", { query: { status, cursor, account_id: accountId ?? undefined, limit: 50 } }),
  approve: (id: string, note: string | null, idempotencyKey: string) => api.post<Adjustment>(`/billing/adjustments/${enc(id)}/approve`, note ? { note } : {}, { idempotencyKey }),
  reject: (id: string, note: string, idempotencyKey: string) => api.post<Adjustment>(`/billing/adjustments/${enc(id)}/reject`, { note }, { idempotencyKey }),
  cancelAdjustment: (id: string, idempotencyKey: string) => api.post<Adjustment>(`/billing/adjustments/${enc(id)}/cancel`, undefined, { idempotencyKey }),
  recon: (f: { status?: string; kind?: ReconItemKind | ""; cursor?: string | null }) => api.get<Page<ReconItem>>("/billing/reconciliation/items", { query: { ...f, limit: 50 } }),
  reconRun: (idempotencyKey: string) => api.post<ReconRun>("/billing/reconciliation/runs", undefined, { idempotencyKey }),
  resolve: (id: string, status: "resolved" | "ignored", note: string, idempotencyKey: string) => api.post<ReconItem>(`/billing/reconciliation/items/${enc(id)}/resolve`, { status, note }, { idempotencyKey }),
  summary: (period: BillingSummary["period"]) => api.get<BillingSummary>("/billing/reports/summary", { query: { period } }),
  daily: (from: string, to: string) => api.get<{ items: BillingDailyRow[] }>("/billing/reports/daily", { query: { from, to } }),
  fx: () => api.get<{ items: FxRate[] }>("/billing/fx"),
  putFx: (body: FxRateRequest) => api.put<FxRate>("/billing/fx", body),
  starRate: () => api.get<{ items: StarRate[] }>("/billing/star-rate"),
  putStarRate: (body: StarRateRequest) => api.put<StarRate>("/billing/star-rate", body),
  providers: () => api.get<{ items: BillingProviderStatus[] }>("/billing/providers"),
};

export const Finance = {
  overview: (period: FinanceOverview["period"]) => api.get<FinanceOverview>("/finance/overview", { query: { period } }),
};
