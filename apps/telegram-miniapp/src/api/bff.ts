import type {
  ActivityRequest,
  AgeRequest,
  ConsentRequest,
  ConsentState,
  CreateChildRequest,
  CreateTicketRequest,
  DeletionRequest,
  DeletionResponse,
  DirectoryItem,
  ExperienceConfig,
  Family,
  GuardianConsentGrant,
  GuardianConsentLink,
  GuardianConsentPreview,
  InboxItem,
  Invite,
  InviteAcceptResult,
  InviteKind,
  InvitePreview,
  LearnerSummary,
  LearningPlan,
  Page,
  PinResetRequestResponse,
  PlanPatch,
  PolicyDocument,
  Profile,
  SecurityState,
  SessionResponse,
  SettingsPatch,
  Ticket,
  TicketCategory,
  TicketSummary,
  TodayPlan,
  UiLang,
  WhatsNew,
  WhatsNewNote,
} from "@tilhero/contracts/bff";
import type { ApiClient } from "./client";

export interface SupportCategory {
  code: TicketCategory;
  label: { ru: string; uz: string };
  available: boolean;
}

const enc = encodeURIComponent;

/**
 * Typed telegram-bff routes (packages/contracts/src/bff.ts — the only source of shapes). Creating commands carry an
 * Idempotency-Key chosen by the caller (one per draft, reused on retries).
 */
export function createBff(client: ApiClient) {
  const get = <T>(path: string, query?: Record<string, string | number | undefined | null>, quiet = false) =>
    client.request<T>("GET", path, { query, quiet });
  return {
    client,
    // ---- session ----
    verifyPin: (pin: string) => client.issueSession("POST", "/v1/session/pin/verify", { body: { pin } }),
    switchLearner: (learner_id: string, pin?: string) =>
      client.issueSession("POST", "/v1/session/learner", { body: pin ? { learner_id, pin } : { learner_id } }),
    logout: () => client.request<void>("POST", "/v1/session/logout"),

    // ---- profile, age, children ----
    profile: () => get<Profile>("/v1/profile"),
    patchSettings: (patch: SettingsPatch) => client.request<Profile>("PATCH", "/v1/profile/settings", { body: patch }),
    setAge: (body: AgeRequest) => client.request<Profile>("PUT", "/v1/profile/age", { body }),
    learners: () => get<{ items: LearnerSummary[] }>("/v1/learners"),
    createChild: (body: CreateChildRequest, key: string) => client.request<LearnerSummary>("POST", "/v1/learners", { body, idempotencyKey: key }),
    requestGuardianConsent: () => client.request<GuardianConsentLink>("POST", "/v1/profile/guardian-consent"),
    guardianPreview: (token: string) => client.request<GuardianConsentPreview>("GET", `/v1/guardian-consents/${enc(token)}`, { auth: false }),
    guardianDecide: (token: string, decision: "accept" | "decline") =>
      client.request<GuardianConsentPreview>("POST", `/v1/guardian-consents/${enc(token)}/${decision}`),
    /** teens 14–17 this parent decided for; revoke → declined, the teen's optional purposes are withdrawn */
    guardianGrants: () => get<{ items: GuardianConsentGrant[] }>("/v1/family/guardian-consents"),
    revokeGuardianGrant: (teenId: string) => client.request<GuardianConsentGrant>("POST", `/v1/family/guardian-consents/${enc(teenId)}/revoke`),

    // ---- parent code (PIN) ----
    /** set (no current_pin) or change (with current_pin); other sessions of the account are revoked */
    setPin: (pin: string, currentPin?: string) =>
      client.request<SecurityState>("PUT", "/v1/profile/security/pin", { body: currentPin ? { pin, current_pin: currentPin } : { pin } }),
    removePin: (currentPin: string) => client.request<SecurityState>("DELETE", "/v1/profile/security/pin", { body: { current_pin: currentPin } }),
    /** the bot sends a 6-digit code to the chat */
    pinResetRequest: () => client.request<PinResetRequestResponse>("POST", "/v1/profile/security/pin/reset-request"),
    /** review T-8: the new code takes effect in 24 h (security.pin_reset_effective_at); the session does not change */
    pinResetConfirm: (code: string, newPin: string) =>
      client.request<SecurityState>("POST", "/v1/profile/security/pin/reset-confirm", { body: { code, new_pin: newPin } }),
    /** cancel the pending reset with the current (old) code */
    pinResetCancel: (currentPin: string) =>
      client.request<SecurityState>("POST", "/v1/profile/security/pin/reset-cancel", { body: { current_pin: currentPin } }),

    // ---- consents ----
    policy: (lang: UiLang) => client.request<PolicyDocument>("GET", "/v1/legal/policy", { query: { lang }, auth: false }),
    acceptConsent: (body: ConsentRequest) => client.request<ConsentState>("POST", "/v1/profile/consent", { body }),

    // ---- learning plan & schedule ----
    plan: (tz: string) => get<LearningPlan>("/v1/plan", { tz }),
    patchPlan: (patch: PlanPatch, version?: number) =>
      client.request<LearningPlan>("PATCH", "/v1/plan", { body: patch, headers: version != null ? { "If-Match": String(version) } : undefined }),
    completeOnboarding: () => client.request<LearningPlan>("POST", "/v1/plan/onboarding/complete"),
    today: () => get<TodayPlan>("/v1/plan/today"),
    recordActivity: (body: ActivityRequest, key: string) => client.request<TodayPlan>("POST", "/v1/plan/activity", { body, idempotencyKey: key }),
    goals: () => get<{ items: DirectoryItem[] }>("/v1/directory/goals"),

    // ---- notification center ----
    inbox: (cursor: string | null, limit = 20) => get<Page<InboxItem>>("/v1/notifications", { limit, cursor }),
    unreadCount: () => get<{ unread: number }>("/v1/notifications/unread-count", undefined, true),
    markRead: (body: { ids: string[] } | { all: true }) => client.request<{ unread: number }>("POST", "/v1/notifications/read", { body }),

    // ---- invites & family ----
    createInvite: (kind: InviteKind, key: string) => client.request<Invite>("POST", "/v1/invites", { body: { kind }, idempotencyKey: key }),
    invites: (cursor: string | null) => get<Page<Invite>>("/v1/invites", { limit: 20, cursor }),
    revokeInvite: (id: string) => client.request<Invite>("DELETE", `/v1/invites/${enc(id)}`),
    openInvite: (token: string) => client.request<InvitePreview>("POST", "/v1/invites/open", { body: { token } }),
    invitePreview: (id: string) => get<InvitePreview>(`/v1/invites/${enc(id)}/preview`),
    acceptInvite: (id: string) => client.request<InviteAcceptResult>("POST", `/v1/invites/${enc(id)}/accept`),
    declineInvite: (id: string) => client.request<InvitePreview>("POST", `/v1/invites/${enc(id)}/decline`),
    /** 204 → null (no family yet) */
    family: async () => (await get<Family | undefined>("/v1/family")) ?? null,

    // ---- «Что нового», news, interface config ----
    whatsNew: () => get<WhatsNew>("/v1/whats-new", undefined, true),
    whatsNewSeen: (ids: string[]) => client.request<void>("POST", "/v1/whats-new/seen", { body: { release_note_ids: ids }, quiet: true }),
    news: (cursor: string | null) => get<Page<WhatsNewNote>>("/v1/news", { limit: 20, cursor }),
    experience: (signal: AbortSignal) => client.request<ExperienceConfig>("GET", "/v1/experience/config", { auth: false, signal, quiet: true }),

    // ---- support ----
    supportCategories: () => get<{ items: SupportCategory[] }>("/v1/support/categories"),
    tickets: (cursor: string | null) => get<Page<TicketSummary>>("/v1/support/tickets", { limit: 20, cursor }),
    ticket: (id: string) => get<Ticket>(`/v1/support/tickets/${enc(id)}`),
    createTicket: (body: CreateTicketRequest, key: string) => client.request<Ticket>("POST", "/v1/support/tickets", { body, idempotencyKey: key }),
    replyTicket: (id: string, text: string) => client.request<Ticket>("POST", `/v1/support/tickets/${enc(id)}/messages`, { body: { text } }),
    closeTicket: (id: string) => client.request<Ticket>("POST", `/v1/support/tickets/${enc(id)}/close`),

    // ---- deletion ----
    requestDeletion: (body: DeletionRequest) => client.request<DeletionResponse>("POST", "/v1/profile/delete-request", { body }),
  };
}

export type Bff = ReturnType<typeof createBff>;
export type { SessionResponse };
