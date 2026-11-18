import type {
  DeletionDetail,
  DeletionFilter,
  DeletionPage,
  RateLimitHistory,
  RateLimitOverrideInput,
  RateLimitPolicy,
  AlertFeed,
  AlertFeedItem,
  ConsumerInfo,
  DlqActionPage,
  DlqCommand,
  DlqCommandResult,
  DlqDetail,
  DlqPage,
  OpsAlertPage,
  OpsList,
  OutboxInfo,
  ProblemFeeds,
  ProviderHealthList,
  ProviderHistory,
  ProviderProbeResult,
  ServiceReady,
  StreamInfo,
  AdminUserCard,
  AiBudget,
  AiLimits,
  AiLimitValues,
  DiscoveryRun,
  ReviewCorrection,
  ReviewDetail,
  ReviewItem,
  ReviewRejectReason,
  Source,
  SourceCrawlStatsList,
  SourceJsonApiPreview,
  SourceJsonApiPreviewInput,
  SourceDetail,
  SourceInput,
  AdminUserRow,
  AiDraft,
  Approval,
  ApprovalDecision,
  AuditRecord,
  ChainVerification,
  ConfigActivation,
  ConfigApp,
  ConfigState,
  ConfigVersion,
  Dashboard,
  EscalationType,
  LoginStep,
  Me,
  MfaEnrollStart,
  Page,
  Permission,
  ReplyTemplate,
  RevealResult,
  Role,
  RoleCode,
  Staff,
  StaffCreate,
  StaffCreated,
  StaffPatch,
  StaffResetResponse,
  StaffTicket,
  StaffTicketSummary,
  StepUpResult,
  SlaPolicies,
  SlaPolicy,
  SupportStats,
  TicketPriority,
  TicketStatus,
  OfferSnapshotAdmin,
  TravelProvidersStatus,
  TravelProviderName,
  TravelProviderProbe,
  ReviewBulkResult,
  NewsAdminItem,
  NewsSource,
  NewsSourceCheck,
  NewsSourceCheckInput,
  NewsSourceInput,
  WatchStats,
  AccessLevelInput,
  AccessLevelSaved,
  AccessLevelList,
  AiAgentSaved,
  AiAgentList,
  AiAgentPatch,
  AiAgentUsage,
  AiAlert,
  AiBudgetOverview,
  AiKillSwitchState,
  AiKpi,
  AiLimitsInput,
  AiRequestContent,
  AiRequestDetail,
  AiRequestRow,
  AiRequestStatus,
  EvalCaseList,
  EvalRun,
  EvalRunStarted,
  PriceCatalogItem,
  PriceCatalogList,
  PriceCatalogVersion,
  SkillCompare,
  SkillContent,
  SkillDetail,
  SkillList,
  SkillRollbackResult,
  SkillVersion,
  UserAccessLevel,
} from "@tilhero/contracts/admin";
import type { Ticket as ClientTicket } from "@tilhero/contracts/bff";
import type { ReleaseNoteContent, ReleaseNoteStatus, StaffReleaseNote } from "@tilhero/contracts/admin";
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
  /** refresh — «Обновить» мимо кэша admin-bff (не чаще раза в 15 с на сотрудника, чаще — из кэша) */
  get: (period: Period, refresh = false) => api.get<Dashboard>("/dashboard", { query: refresh ? { period, refresh: "true" } : { period } }),
};

export interface UserFilters {
  q?: string;
  status?: string;
  locale?: string;
  has_open_tickets?: boolean;
  cursor?: string | null;
  limit?: number;
}
export const Users = {
  list: (f: UserFilters) =>
    api.get<Page<AdminUserRow>>("/users", {
      query: { q: f.q, status: f.status, locale: f.locale, has_open_tickets: f.has_open_tickets ? "true" : undefined, cursor: f.cursor, limit: f.limit ?? 25 },
    }),
  card: (id: string) => api.get<AdminUserCard>(`/users/${enc(id)}`),
  reveal: (id: string, reason: string) => api.post<RevealResult>(`/users/${enc(id)}/reveal`, { field: "telegram_user_id", reason }),
};

export interface TicketFilters {
  status?: string;
  category?: string;
  priority?: string;
  assignee?: string;
  sla?: string;
  user_id?: string;
  cursor?: string | null;
  limit?: number;
}
export const Support = {
  list: (f: TicketFilters, background = false) =>
    api.get<Page<StaffTicketSummary>>("/support/tickets", {
      query: { status: f.status, category: f.category, priority: f.priority, assignee: f.assignee, sla: f.sla, user_id: f.user_id, cursor: f.cursor, limit: f.limit ?? 50 },
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
  aiDraft: (id: string) => api.post<AiDraft>(`/support/tickets/${enc(id)}/ai-draft`),
  templates: () => api.get<{ items: ReplyTemplate[] }>("/support/templates"),
  slaPolicies: () => api.get<SlaPolicies>("/support/sla-policies"),
  putSlaPolicies: (items: SlaPolicy[], reason: string) =>
    api.put<SlaPolicies>("/support/sla-policies", {
      items: items.map(({ category, priority, first_response_minutes, resolution_minutes }) => ({ category, priority, first_response_minutes, resolution_minutes })),
      reason,
    }),
};

export const StaffApi = {
  list: (f: { q?: string; role?: string; status?: string; cursor?: string | null }) =>
    api.get<Page<Staff>>("/staff", { query: { q: f.q, role: f.role, status: f.status, cursor: f.cursor, limit: 50 } }),
  create: (body: StaffCreate) => api.post<StaffCreated>("/staff", body, { idempotencyKey: true }),
  patch: (id: string, body: StaffPatch) => api.patch<Staff | { approval: Approval }>(`/staff/${enc(id)}`, body),
  /** privileged target → 202 {approval} (staff.privileged_reset): the password goes to the approver, not the author */
  resetPassword: (id: string, reason: string) => api.post<StaffResetResponse>(`/staff/${enc(id)}/reset-password`, { reason }),
  resetMfa: (id: string, reason: string) => api.post<Staff | { approval: Approval }>(`/staff/${enc(id)}/reset-mfa`, { reason }),
  roles: () => api.get<{ items: Role[]; permissions: Permission[] }>("/roles"),
  putRole: (code: RoleCode, permissions: Permission[], reason: string) => api.put<{ approval: Approval }>(`/roles/${enc(code)}`, { permissions, reason }),
  approvals: (status?: string, cursor?: string | null) => api.get<Page<Approval>>("/approvals", { query: { status, cursor } }),
  approve: (id: string, note: string) => api.post<ApprovalDecision>(`/approvals/${enc(id)}/approve`, { note }),
  reject: (id: string, note: string) => api.post<ApprovalDecision>(`/approvals/${enc(id)}/reject`, { note }),
};

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

/** Active admin config (theme tokens + layout) — any signed-in staff member (admin.ts, A46). */
export interface AdminExperience {
  app: "admin";
  version: string;
  theme: { id: string; version: string; tokens: Record<string, string> };
  layout: unknown;
  flags: Record<string, boolean>;
}

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

/* ---------- 9.4: «Что нового» — release notes of the Mini App (config.read / config.edit / config.publish) ---------- */
export const ReleaseNotes = {
  list: (status?: ReleaseNoteStatus | null, cursor?: string | null) =>
    api.get<Page<StaffReleaseNote>>("/release-notes", { query: { status: status ?? undefined, cursor, limit: 50 } }),
  get: (id: string) => api.get<StaffReleaseNote>(`/release-notes/${enc(id)}`),
  create: (body: ReleaseNoteContent) => api.post<StaffReleaseNote>("/release-notes", body, { idempotencyKey: true }),
  update: (id: string, expected_version: number, body: ReleaseNoteContent) =>
    api.put<StaffReleaseNote>(`/release-notes/${enc(id)}`, { ...body, expected_version }),
  publish: (id: string, expected_version: number, reason: string) =>
    api.post<StaffReleaseNote>(`/release-notes/${enc(id)}/publish`, { expected_version, reason }, { idempotencyKey: true }),
  archive: (id: string, reason: string) => api.post<StaffReleaseNote>(`/release-notes/${enc(id)}/archive`, { reason }, { idempotencyKey: true }),
};

/* ---------- sprint 4: event catalog (docs/sprint4/INTERNAL_API.md §7) ---------- */

export interface ReviewFilters {
  status?: string;
  country?: string;
  provider?: string;
  cursor?: string | null;
  limit?: number;
}
export interface ReviewDecision {
  review: ReviewDetail;
  event_id?: string | null;
}
/** Decisions carry `expected_status: "OPEN"` (409 REVIEW_ALREADY_DECIDED otherwise), the `content_hash` of the card the
 * operator looked at (409 REVIEW_CHANGED when a newer candidate replaced the facts) and one Idempotency-Key per dialog,
 * so a retry after a lost answer returns the same decision instead of a conflict. */
export const ReviewApi = {
  list: (f: ReviewFilters, background = false) =>
    api.get<Page<ReviewItem>>("/review", { query: { status: f.status, country: f.country, provider: f.provider, cursor: f.cursor, limit: f.limit ?? 50 }, background }),
  get: (id: string) => api.get<ReviewDetail>(`/review/${enc(id)}`),
  accept: (id: string, contentHash: string, note: string, idempotencyKey: string) =>
    api.post<ReviewDecision>(`/review/${enc(id)}/accept`, { expected_status: "OPEN", expected_content_hash: contentHash, note }, { idempotencyKey }),
  reject: (id: string, contentHash: string, reason_code: ReviewRejectReason, note: string, idempotencyKey: string) =>
    api.post<ReviewDecision>(`/review/${enc(id)}/reject`, { expected_status: "OPEN", expected_content_hash: contentHash, reason_code, note }, { idempotencyKey }),
  correct: (id: string, contentHash: string, changes: ReviewCorrection, basis_url: string, note: string, idempotencyKey: string) =>
    api.post<ReviewDecision>(`/review/${enc(id)}/correct`, { expected_status: "OPEN", expected_content_hash: contentHash, changes, basis_url, note }, { idempotencyKey }),
  /* fix 5.1: bulk reject, back to the queue from «Not confirmed» (EXPIRED). One Idempotency-Key per action (dialog). */
  bulkReject: (items: Array<{ review_id: string; expected_content_hash: string }>, reason_code: ReviewRejectReason, note: string, idempotencyKey: string) =>
    api.post<ReviewBulkResult>("/review/bulk-reject", { items, reason_code, note }, { idempotencyKey }),
  reopen: (id: string, note: string, idempotencyKey: string) =>
    api.post<{ review: ReviewDetail }>(`/review/${enc(id)}/reopen`, { expected_status: "EXPIRED", note }, { idempotencyKey }),
  bulkReopen: (ids: string[], note: string, idempotencyKey: string) =>
    api.post<ReviewBulkResult>("/review/bulk-reopen", { items: ids.map((review_id) => ({ review_id })), note }, { idempotencyKey }),
};

export interface SourceFilters {
  country?: string;
  enabled?: "true" | "false";
  q?: string;
  cursor?: string | null;
}
export const SourcesApi = {
  list: (f: SourceFilters) => api.get<Page<Source>>("/sources", { query: { country: f.country, enabled: f.enabled, q: f.q, cursor: f.cursor, limit: 50 } }),
  get: (id: string) => api.get<SourceDetail>(`/sources/${enc(id)}`),
  /** last crawl of every source (provider-gateway ai_web/sources): optional data — a background request, the screen
   *  works without it (503 FEATURE_UNAVAILABLE / UPSTREAM_UNAVAILABLE → «—») */
  crawlStats: () => api.get<SourceCrawlStatsList>("/sources/crawl-stats", { background: true }),
  /** sources.manage + step-up (the client asks for the TOTP code and repeats with the same key) */
  create: (body: SourceInput & { reason: string }, idempotencyKey: string) => api.post<Source>("/sources", body, { idempotencyKey }),
  /** step-up only when domains / enabled / tier change; 409 SOURCE_VERSION_CONFLICT on a stale expected_version */
  patch: (id: string, body: Record<string, unknown>) => api.patch<Source>(`/sources/${enc(id)}`, body),
  /** fix 9.3: «Check» a JSON API page from the form (not saved yet): first API page, no AI, nothing stored;
   *  sources.manage; 429 PREVIEW_RATE_LIMITED {retry_after} — more often than once per 5 s */
  previewJsonApi: (body: SourceJsonApiPreviewInput) => api.post<SourceJsonApiPreview>("/sources/json-api/preview", body),
};

export const DiscoveryApi = {
  runs: (cursor?: string | null, background = false) => api.get<Page<DiscoveryRun>>("/discovery/runs", { query: { cursor, limit: 20 }, background }),
  run: (id: string, background = false) => api.get<DiscoveryRun>(`/discovery/runs/${enc(id)}`, { background }),
  /** 202 DiscoveryRun (trigger=manual); 409 DISCOVERY_RUN_IN_PROGRESS {run_id} */
  start: (maxProviderCalls: number | null, idempotencyKey: string) =>
    api.post<DiscoveryRun>("/discovery/runs", maxProviderCalls ? { max_provider_calls: maxProviderCalls } : {}, { idempotencyKey }),
  budget: (background = false) => api.get<AiBudget>("/discovery/budget", { background }),
  /** ops.kill_switch + step-up; 503 AUDIT_UNAVAILABLE — not audited, the state did not change */
  pause: (paused: boolean, reason: string) => api.put<AiBudget>("/discovery/pause", { paused, reason }),
  /* fix 6.1: AI limits from the admin (GET — discovery.manage or ops.kill_switch; PUT/DELETE — ops.kill_switch + step-up;
     503 AUDIT_UNAVAILABLE — not audited, the limits did not change) */
  limits: (background = false) => api.get<AiLimits>("/discovery/limits", { background }),
  setLimits: (v: Omit<AiLimitsInput, "reason"> | AiLimitValues, reason: string) => api.put<AiLimits>("/discovery/limits", { ...v, reason }),
  resetLimits: (reason: string) => api.del<AiLimits>("/discovery/limits", { reason }),
};

/* ---------- sprint 5: trip offers (docs/sprint5/INTERNAL_API.md §5) ---------- */

export const TravelApi = {
  /** dashboard.read; 503 FEATURE_UNAVAILABLE without PROVIDER_GATEWAY_URL in admin-bff */
  providers: (background = false) => api.get<TravelProvidersStatus>("/travel/providers", { background }),
  /** fix 5.1: one test call of the provider without cache (dashboard.read); 429 PROBE_RATE_LIMITED {retry_after} —
   *  one probe per 30 s per provider; 503 PROBE_UNAVAILABLE — provider-gateway has no probe yet */
  probe: (name: TravelProviderName) => api.post<TravelProviderProbe>(`/travel/providers/${enc(name)}/probe`),
};

export const OffersApi = {
  /** support.read; 404 OFFER_NOT_FOUND (expired after 30 days or never existed); 503 FEATURE_UNAVAILABLE without OFFERS_URL.
   *  `offer` / `trip` are normalized by admin-bff (links — https or null), the screen re-checks them anyway. */
  snapshot: (offerId: string) => api.get<OfferSnapshotAdmin>(`/offers/${enc(offerId)}`),
};

/* ---------- sprint 6: news feeds, news moderation, Watch statistics (docs/sprint6/INTERNAL_API.md §3.1, §8) ---------- */

export interface NewsSourceFilters {
  interest?: string;
  country?: string;
  enabled?: "true" | "false";
  q?: string;
  cursor?: string | null;
  limit?: number;
}
export interface NewsItemFilters {
  source?: string;
  /** ISO 3166-1 alpha-2, several — comma-separated (≤ 20): the country of the news feed */
  country?: string;
  hidden?: "true" | "false";
  cursor?: string | null;
}
/** news.manage (no step-up). 503 FEATURE_UNAVAILABLE {service: "news"} until NEWS_URL is set in admin-bff. */
export const NewsApi = {
  sources: (f: NewsSourceFilters) =>
    api.get<Page<NewsSource>>("/news/sources", { query: { interest: f.interest, country: f.country, enabled: f.enabled, q: f.q, cursor: f.cursor, limit: f.limit ?? 50 } }),
  source: (id: string) => api.get<NewsSource>(`/news/sources/${enc(id)}`),
  /** Idempotency-Key is required (one key per form: a retry after a network error does not create a twin) */
  create: (body: NewsSourceInput & { reason: string }, idempotencyKey: string) => api.post<NewsSource>("/news/sources", body, { idempotencyKey }),
  /** 409 NEWS_SOURCE_VERSION_CONFLICT on a stale expected_version */
  patch: (id: string, body: Record<string, unknown>, idempotencyKey: string) => api.patch<NewsSource>(`/news/sources/${enc(id)}`, body, { idempotencyKey }),
  remove: (id: string, expectedVersion: number, reason: string, idempotencyKey: string) =>
    api.del<void>(`/news/sources/${enc(id)}`, { expected_version: expectedVersion, reason }, { idempotencyKey }),
  /** trial fetch without saving: the saved feed (no body) or the unsaved form fields; 503 CHECK_UNAVAILABLE — news has no check yet */
  check: (id: string | null, form?: NewsSourceCheckInput) =>
    id ? api.post<NewsSourceCheck>(`/news/sources/${enc(id)}/check`, form ?? {}) : api.post<NewsSourceCheck>("/news/sources/check", form),
  items: (f: NewsItemFilters) => api.get<Page<NewsAdminItem>>("/news/items", { query: { source: f.source, country: f.country, hidden: f.hidden, cursor: f.cursor, limit: 30 } }),
  hide: (id: string, reason: string, idempotencyKey: string) => api.post<NewsAdminItem>(`/news/items/${enc(id)}/hide`, { reason }, { idempotencyKey }),
  unhide: (id: string, reason: string, idempotencyKey: string) => api.post<NewsAdminItem>(`/news/items/${enc(id)}/unhide`, { reason }, { idempotencyKey }),
};

export const WatchApi = {
  /** dashboard.read; 503 FEATURE_UNAVAILABLE {service: "watch"} until WATCH_URL is set */
  stats: (background = false) => api.get<WatchStats>("/watches/stats", { background }),
};

// ---------- sprint 7: AI concierge — usage and cost, budgets and kill switch, agents and skills, access levels ----------
// (docs/sprint7/INTERNAL_API.md §6). Commands carry an Idempotency-Key (ai-control requires it); step-up is asked by
// the client on 403 STEP_UP_REQUIRED; 503 AUDIT_UNAVAILABLE — nothing changed.

export type UsagePeriod = "today" | "7d" | "30d";
export interface AiRequestFilters {
  period?: UsagePeriod;
  agent?: string;
  status?: AiRequestStatus | "";
  model?: string;
  user_id?: string;
  cursor?: string | null;
}

export const UsageApi = {
  kpi: (period: UsagePeriod, background = false) => api.get<AiKpi>("/usage/kpi", { query: { period }, background }),
  agents: (period: UsagePeriod, background = false) => api.get<AiAgentUsage>("/usage/agents", { query: { period }, background }),
  requests: (f: AiRequestFilters) =>
    api.get<Page<AiRequestRow>>("/usage/requests", { query: { period: f.period, agent: f.agent, status: f.status, model: f.model, user_id: f.user_id, cursor: f.cursor, limit: 50 } }),
  request: (id: string) => api.get<AiRequestDetail>(`/usage/requests/${enc(id)}`),
  /** ai.content.read + step-up + reason; ai-concierge audits ai.content.view before answering */
  reveal: (id: string, reason: string) => api.post<AiRequestContent>(`/usage/requests/${enc(id)}/content:reveal`, { reason }),
};

export const AiApi = {
  budgets: (background = false) => api.get<AiBudgetOverview>("/ai/budgets", { background }),
  limits: (background = false) => api.get<AiLimits>("/ai/limits", { background }),
  setLimits: (v: Omit<AiLimitsInput, "reason">, reason: string) => api.put<AiLimits>("/ai/limits", { ...v, reason }),
  resetLimits: (reason: string) => api.del<AiLimits>("/ai/limits", { reason }),
  pauseAgent: (agentId: string, paused: boolean, reason: string) => api.put<AiKillSwitchState>(`/ai/agents/${enc(agentId)}/pause`, { paused, reason }),
  pauseProvider: (paused: boolean, reason: string) => api.put<AiKillSwitchState>("/ai/providers/anthropic/pause", { paused, reason }),
  agents: (background = false) => api.get<AiAgentList>("/ai/agents", { background }),
  patchAgent: (agentId: string, body: AiAgentPatch) => api.patch<AiAgentSaved>(`/ai/agents/${enc(agentId)}`, body, { idempotencyKey: true }),
  alerts: (f: { unacked?: boolean; cursor?: string | null } = {}, background = false) =>
    api.get<Page<AiAlert>>("/ai/alerts", { query: { unacked: f.unacked ? "true" : undefined, cursor: f.cursor, limit: 20 }, background }),
  ack: (alertId: string) => api.post<AiAlert>(`/ai/alerts/${enc(alertId)}:ack`, undefined, { idempotencyKey: true }),
  priceVersions: () => api.get<PriceCatalogList>("/ai/pricing/versions"),
  priceVersion: (version: string) => api.get<PriceCatalogVersion>(`/ai/pricing/versions/${enc(version)}`),
  createPriceDraft: (based_on: string | null, note: string) =>
    api.post<PriceCatalogVersion>("/ai/pricing/versions", { ...(based_on ? { based_on } : {}), note }, { idempotencyKey: true }),
  patchPriceDraft: (version: string, items: PriceCatalogItem[], note: string, expected_version: number) =>
    api.patch<PriceCatalogVersion>(`/ai/pricing/versions/${enc(version)}`, { items, note, expected_version }, { idempotencyKey: true }),
  activatePrice: (version: string, reason: string, expected_version: number) =>
    api.post<PriceCatalogVersion>(`/ai/pricing/versions/${enc(version)}:activate`, { reason, expected_version }, { idempotencyKey: true }),
  levels: () => api.get<AccessLevelList>("/ai/access-levels"),
  putLevel: (code: string, body: AccessLevelInput) => api.put<AccessLevelSaved>(`/ai/access-levels/${enc(code)}`, body, { idempotencyKey: true }),
};

export const SkillsApi = {
  list: () => api.get<SkillList>("/skills"),
  get: (id: string) => api.get<SkillDetail>(`/skills/${enc(id)}`),
  version: (id: string, v: number) => api.get<SkillVersion>(`/skills/${enc(id)}/versions/${v}`),
  compare: (id: string, a: number, b: number) => api.get<SkillCompare>(`/skills/${enc(id)}/compare`, { query: { a, b } }),
  create: (id: string, fromVersion: number | null) =>
    api.post<SkillVersion>(`/skills/${enc(id)}/versions`, fromVersion ? { from_version: fromVersion } : {}, { idempotencyKey: true }),
  patch: (id: string, v: number, changes: Partial<SkillContent>, expected_version: number) =>
    api.patch<SkillVersion>(`/skills/${enc(id)}/versions/${v}`, { ...changes, expected_version }, { idempotencyKey: true }),
  test: (id: string, v: number, body: { case_ids?: string[]; compare_version?: number }) =>
    api.post<EvalRunStarted>(`/skills/${enc(id)}/versions/${v}/test`, body, { idempotencyKey: true }),
  review: (id: string, v: number, action: "request" | "approve" | "reject", comment?: string) =>
    api.post<SkillVersion>(`/skills/${enc(id)}/versions/${v}/review`, { action, ...(comment ? { comment } : {}) }, { idempotencyKey: true }),
  publish: (id: string, v: number, reason: string, effective_from?: string) =>
    api.post<SkillVersion>(`/skills/${enc(id)}/versions/${v}/publish`, { reason, ...(effective_from ? { effective_from } : {}) }, { idempotencyKey: true }),
  rollback: (id: string, to_version: number, reason: string) =>
    api.post<SkillRollbackResult>(`/skills/${enc(id)}/rollback`, { to_version, reason }, { idempotencyKey: true }),
  deprecate: (id: string, v: number, reason: string) => api.post<SkillVersion>(`/skills/${enc(id)}/versions/${v}/deprecate`, { reason }, { idempotencyKey: true }),
  run: (runId: string, background = false) => api.get<EvalRun>(`/evaluation/runs/${enc(runId)}`, { background }),
  cases: (skillId: string) => api.get<EvalCaseList>("/evaluation/cases", { query: { skill_id: skillId } }),
};

export const AccessApi = {
  get: (userId: string) => api.get<UserAccessLevel>(`/users/${enc(userId)}/access-level`),
  assign: (userId: string, level: string, reason: string, expires_at: string | null, expected_version: number) =>
    api.put<UserAccessLevel>(`/users/${enc(userId)}/access-level`, { level, reason, expires_at, expected_version }, { idempotencyKey: true }),
  reset: (userId: string, reason: string, expected_version: number) =>
    // the reason goes in the body, never in the URL (proxy / browser logs)
    api.del<UserAccessLevel>(`/users/${enc(userId)}/access-level`, { reason, ...{ expected_version } }, { idempotencyKey: true }),
};

// ---------- sprint 8: monitoring (ops-monitor), DLQ, alert feed (docs/sprint8/INTERNAL_API.md §7.5) ----------
// 503 FEATURE_UNAVAILABLE {service: "ops-monitor"} until OPS_MONITOR_URL is set; 503 NATS_UNAVAILABLE — the bus is down.
// DLQ commands: ops.queues.manage + step-up (asked by the client on 403 STEP_UP_REQUIRED) + Idempotency-Key + reason.

export interface DlqFilters {
  consumer?: string;
  event_type?: string;
  source?: "dlq" | "legacy" | "";
  /** ревью 8: present (по умолчанию) | replayed | all */
  state?: "present" | "replayed" | "all";
  dead_from?: string;
  dead_to?: string;
  cursor?: string | null;
}

export const OpsApi = {
  providers: (background = false) => api.get<ProviderHealthList>("/ops/providers", { background }),
  history: (provider: string, range: "24h" | "7d") => api.get<ProviderHistory>(`/ops/providers/${enc(provider)}/history`, { query: { range } }),
  probe: (provider: string) => api.post<ProviderProbeResult>(`/ops/providers/${enc(provider)}/probe`, {}),
  feeds: (background = false) => api.get<ProblemFeeds>("/ops/feeds", { background }),
  alerts: (f: { state?: "open" | "resolved"; subject_type?: string; cursor?: string | null } = {}, background = false) =>
    api.get<OpsAlertPage>("/ops/alerts", { query: { state: f.state, subject_type: f.subject_type, cursor: f.cursor, limit: 50 }, background }),
  streams: (background = false) => api.get<OpsList<StreamInfo>>("/ops/queues/streams", { background }),
  consumers: (background = false) => api.get<OpsList<ConsumerInfo>>("/ops/queues/consumers", { background }),
  outbox: (background = false) => api.get<OpsList<OutboxInfo>>("/ops/queues/outbox", { background }),
  services: (background = false) => api.get<OpsList<ServiceReady>>("/ops/queues/services", { background }),
  dlq: (f: DlqFilters, background = false) =>
    api.get<DlqPage>("/ops/dlq", {
      query: { consumer: f.consumer || undefined, event_type: f.event_type || undefined, source: f.source || undefined, state: f.state && f.state !== "present" ? f.state : undefined, dead_from: f.dead_from || undefined, dead_to: f.dead_to || undefined, cursor: f.cursor, limit: 50 },
      background,
    }),
  dlqMessage: (dlqId: string) => api.get<DlqDetail>(`/ops/dlq/${enc(dlqId)}`),
  dlqActions: (cursor: string | null = null) => api.get<DlqActionPage>("/ops/dlq/actions", { query: { cursor, limit: 20 } }),
  /** one Idempotency-Key per open confirmation dialog (a repeat after a network error or step-up is the same command) */
  dlqCommand: (kind: "replay" | "delete", body: DlqCommand, idempotencyKey: string) => api.post<DlqCommandResult>(`/ops/dlq/${kind}`, body, { idempotencyKey }),
};

export const AlertsApi = {
  feed: (background = false) => api.get<AlertFeed>("/alerts", { query: { state: "open" }, background }),
  ack: (source: "ops" | "ai", id: string, comment?: string) =>
    api.post<AlertFeedItem>(`/alerts/${source}/${enc(id)}/ack`, comment ? { comment } : {}, { idempotencyKey: true }),
};

// ---------- sprint 9: profile deletions (identity-consent saga) and rate limits (ops-monitor) ----------

export const DeletionsApi = {
  /** users.read; status: open (requested + stuck) | stuck | completed; without — all */
  list: (f: { status?: DeletionFilter; cursor?: string | null } = {}, background = false) =>
    api.get<DeletionPage>("/deletions", { query: { status: f.status, cursor: f.cursor ?? undefined, limit: 50 }, background }),
  get: (id: string) => api.get<DeletionDetail>(`/deletions/${enc(id)}`),
  /** ops.queues.manage + step-up; one Idempotency-Key per open dialog (a repeat → Idempotent-Replayed) */
  retry: (id: string, reason: string, idempotencyKey: string) => api.post<DeletionDetail>(`/deletions/${enc(id)}:retry`, { reason }, { idempotencyKey }),
};

export const RateLimitsApi = {
  policies: (background = false) => api.get<{ items: RateLimitPolicy[] }>("/ops/ratelimits", { background }),
  history: (policy: string, range: "24h" | "7d") => api.get<RateLimitHistory>(`/ops/ratelimits/${enc(policy)}/history`, { query: { range } }),
  /** ops.kill_switch + step-up; 422 RATE_LIMIT_TOO_STRICT; 503 RATE_LIMIT_UNAVAILABLE */
  override: (policy: string, body: RateLimitOverrideInput, idempotencyKey: string) =>
    api.put<RateLimitPolicy>(`/ops/ratelimits/${enc(policy)}/override`, body, { idempotencyKey }),
  reset: (policy: string, reason: string, idempotencyKey: string) => api.del<RateLimitPolicy>(`/ops/ratelimits/${enc(policy)}/override`, { reason }, { idempotencyKey }),
};
