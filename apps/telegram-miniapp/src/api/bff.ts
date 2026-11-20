import type {
  AddCardRequest,
  CardKind,
  CardStatus,
  DictionaryCard,
  DictionaryCardDetail,
  ErrorJournalItem,
  MemoryOverview,
  PronunciationView,
  ReadingCard,
  ReadingView,
  ReviewAnswer,
  ReviewHint,
  ReviewSession,
  ReviewSummary,
  ReviewTask,
  ReviewTaskResult,
  TranslateRequest,
  WordGloss,
  Appeal,
  EvaluationView,
  LessonCardDetail,
  LessonHistoryItem,
  LessonSession,
  LessonStep,
  LessonSummary,
  SimplerExplanation,
  StepAnswer,
  StepResult,
  AnswerRequest,
  AnswerResult,
  DiagnosticArea,
  DiagnosticItem,
  DiagnosticResult,
  DiagnosticSession,
  DiagnosticState,
  MediaCard,
  MediaDetail,
  MediaRequest,
  MediaRequestCreate,
  MyLanguages,
  ScenarioCard,
  ScenarioDetail,
  SkillMap,
  SpeechRequest,
  Trajectory,
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
import type { SessionKind } from "@tilhero/contracts/ai";
import type { Band, Localized } from "@tilhero/contracts/content";
import type { ApiClient } from "./client";

export interface ScenarioFilters {
  goal?: string | null;
  level?: string | null;
  topic?: string | null;
}
export interface MediaFilters {
  type?: string | null;
  level?: string | null;
  topic?: string | null;
}

/** «Словарь»: filters of GET /v1/memory/cards (q — by the English text and the translation, ≤ 60). */
export interface CardFilters {
  kind?: CardKind | null;
  status?: CardStatus | null;
  q?: string | null;
}

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
    goals: () => get<{ items: DirectoryItem[] }>("/v1/directory/goals"),
    topics: () => get<{ items: DirectoryItem[] }>("/v1/directory/topics"),

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

    // ---- sprint 3: languages, diagnostics, skills, trajectory, scenarios, media, requests ----
    languages: () => get<MyLanguages>("/v1/languages"),
    diagnosticsState: (quiet = false) => get<DiagnosticState>("/v1/diagnostics/state", undefined, quiet),
    /** one key per «Начать проверку» tap; a retry after a lost answer reuses it (the same session) */
    startDiagnostic: (key: string) => client.request<DiagnosticSession>("POST", "/v1/diagnostics/sessions", { body: { pair_id: "ru-en" }, idempotencyKey: key }),
    diagnosticNext: (id: string) => get<DiagnosticItem | { done: true }>(`/v1/diagnostics/sessions/${enc(id)}/next`),
    diagnosticAnswer: (id: string, body: AnswerRequest) => client.request<AnswerResult>("POST", `/v1/diagnostics/sessions/${enc(id)}/answers`, { body }),
    listeningUnavailable: (id: string) => client.request<void>("POST", `/v1/diagnostics/sessions/${enc(id)}/listening-unavailable`),
    finishDiagnostic: (id: string) => client.request<DiagnosticResult>("POST", `/v1/diagnostics/sessions/${enc(id)}/finish`),
    followup: (resultId: string, area: DiagnosticArea) =>
      client.request<DiagnosticSession>("POST", `/v1/diagnostics/results/${enc(resultId)}/followup`, { body: { area } }),
    diagnosticResults: () => get<{ items: DiagnosticResult[] }>("/v1/diagnostics/results"),
    skillMap: () => get<SkillMap>("/v1/skills/map"),
    trajectory: (quiet = false) => get<Trajectory>("/v1/plan/trajectory", undefined, quiet),
    scenarios: (f: ScenarioFilters, cursor: string | null) => get<Page<ScenarioCard>>("/v1/scenarios", { ...f, cursor, limit: 20 }),
    scenario: (id: string) => get<ScenarioDetail>(`/v1/scenarios/${enc(id)}`),
    media: (f: MediaFilters, cursor: string | null) => get<Page<MediaCard>>("/v1/media", { ...f, cursor, limit: 20 }),
    mediaItem: (id: string) => get<MediaDetail>(`/v1/media/${enc(id)}`),
    mediaAudio: (id: string) => client.blob(`/v1/media/${enc(id)}/audio`),
    /** release 4.1: the phrase as MP3 (tts via the BFF); `quiet` — prefetch, never toggles «Нет связи» */
    speech: (body: SpeechRequest, opts: { quiet?: boolean } = {}) => client.blob("/v1/speech", { body, quiet: opts.quiet }, "POST"),
    mediaRequests: () => get<{ items: MediaRequest[] }>("/v1/media/requests"),
    createMediaRequest: (body: MediaRequestCreate, key: string) => client.request<MediaRequest>("POST", "/v1/media/requests", { body, idempotencyKey: key }),

    // ---- sprint 4: lessons, practice sessions, summary, evaluation, appeals ----
    lessonCard: (id: string) => get<LessonCardDetail>(`/v1/lessons/${enc(id)}`),
    /** one key per «Начать» tap; a retry after a lost answer reuses it (the same session) */
    startLesson: (id: string, key: string) => client.request<LessonSession>("POST", `/v1/lessons/${enc(id)}/sessions`, { idempotencyKey: key }),
    startScenario: (id: string, key: string) => client.request<LessonSession>("POST", `/v1/scenarios/${enc(id)}/sessions`, { idempotencyKey: key }),
    startMedia: (id: string, key: string) => client.request<LessonSession>("POST", `/v1/media/${enc(id)}/sessions`, { idempotencyKey: key }),
    activeSession: (quiet = false) => get<{ session: LessonSession | null }>("/v1/sessions/active", undefined, quiet),
    lessonSession: (id: string) => get<LessonSession>(`/v1/sessions/${enc(id)}`),
    pauseSession: (id: string) => client.request<LessonSession>("POST", `/v1/sessions/${enc(id)}/pause`),
    resumeSession: (id: string) => client.request<LessonSession>("POST", `/v1/sessions/${enc(id)}/resume`),
    cancelSession: (id: string) => client.request<LessonSession>("POST", `/v1/sessions/${enc(id)}/cancel`),
    currentStep: (id: string) => get<LessonStep>(`/v1/sessions/${enc(id)}/current`),
    /** the same answer to the same step is answered the same way (idempotent by step) — safe to re-send */
    answerStep: (id: string, stepId: string, body: StepAnswer) => client.request<StepResult>("POST", `/v1/sessions/${enc(id)}/steps/${enc(stepId)}`, { body }),
    stepHint: (id: string, stepId: string) => client.request<{ hint: Localized }>("POST", `/v1/sessions/${enc(id)}/steps/${enc(stepId)}/hint`),
    /** locale — the learner's language of the explanation (the AI answers in it) */
    simpler: (id: string, locale: UiLang) => client.request<SimplerExplanation>("POST", `/v1/sessions/${enc(id)}/simpler`, { query: { locale } }),
    retryRoleplay: (id: string) => client.request<LessonStep>("POST", `/v1/sessions/${enc(id)}/roleplay/retry`),
    finishSession: (id: string) => client.request<LessonSummary>("POST", `/v1/sessions/${enc(id)}/finish`),
    sessionSummary: (id: string) => get<LessonSummary>(`/v1/sessions/${enc(id)}/summary`),
    startReview: (id: string, key: string) => client.request<LessonSession>("POST", `/v1/sessions/${enc(id)}/review`, { idempotencyKey: key }),
    sessions: (kind: SessionKind | null, cursor: string | null) => get<Page<LessonHistoryItem>>("/v1/sessions", { kind, cursor, limit: 20 }),
    evaluation: (id: string) => get<EvaluationView>(`/v1/evaluations/${enc(id)}`),
    appeal: (id: string, reason: string, key: string) => client.request<Appeal>("POST", `/v1/evaluations/${enc(id)}/appeal`, { body: { reason }, idempotencyKey: key }),
    appeals: () => get<{ items: Appeal[] }>("/v1/appeals"),

    // ---- sprint 5: memory (dictionary, «Повторение дня», error journal, translation by tap, pronunciation), reading ----
    /** `quiet` — Home and the dictionary card: a failure only hides the card (never «Нет связи») */
    memoryOverview: (quiet = false) => get<MemoryOverview>("/v1/memory/overview", undefined, quiet),
    memoryCards: (f: CardFilters, cursor: string | null) => get<Page<DictionaryCard>>("/v1/memory/cards", { kind: f.kind, status: f.status, q: f.q?.trim() || undefined, cursor, limit: 20 }),
    memoryCard: (id: string) => get<DictionaryCardDetail>(`/v1/memory/cards/${enc(id)}`),
    /** 201 — a new card, 200 — it was already there (the source is added); one key per «В словарь» tap */
    addCard: (body: AddCardRequest, key: string) => client.request<DictionaryCard>("POST", "/v1/memory/cards", { body, idempotencyKey: key }),
    markKnown: (id: string) => client.request<DictionaryCard>("POST", `/v1/memory/cards/${enc(id)}/known`),
    unmarkKnown: (id: string) => client.request<DictionaryCard>("DELETE", `/v1/memory/cards/${enc(id)}/known`),
    removeCard: (id: string) => client.request<void>("DELETE", `/v1/memory/cards/${enc(id)}`),
    memoryErrors: (cursor: string | null) => get<Page<ErrorJournalItem>>("/v1/memory/errors", { cursor, limit: 20 }),
    /** 201 — a new session, 200 — the active one; 409 NOTHING_TO_REVIEW {next_due_at} */
    startReviewSession: (key: string) => client.request<ReviewSession>("POST", "/v1/memory/review-sessions", { idempotencyKey: key }),
    activeReviewSession: (quiet = false) => get<{ session: ReviewSession | null }>("/v1/memory/review-sessions/active", undefined, quiet),
    reviewSession: (id: string) => get<ReviewSession>(`/v1/memory/review-sessions/${enc(id)}`),
    reviewTask: (id: string) => get<ReviewTask>(`/v1/memory/review-sessions/${enc(id)}/current`),
    /** the same answer to the same task is answered the same way — safe to re-send */
    answerReviewTask: (id: string, taskId: string, body: ReviewAnswer) =>
      client.request<ReviewTaskResult>("POST", `/v1/memory/review-sessions/${enc(id)}/tasks/${enc(taskId)}`, { body }),
    reviewHint: (id: string, taskId: string, kind: ReviewHint["kind"]) =>
      client.request<ReviewHint>("POST", `/v1/memory/review-sessions/${enc(id)}/tasks/${enc(taskId)}/hint`, { body: { kind } }),
    finishReview: (id: string) => client.request<ReviewSummary>("POST", `/v1/memory/review-sessions/${enc(id)}/finish`),
    cancelReview: (id: string) => client.request<ReviewSession>("POST", `/v1/memory/review-sessions/${enc(id)}/cancel`),
    /** only a word of this published text (422 WORD_NOT_IN_CONTENT): the learner's own text is never sent */
    translate: (body: TranslateRequest) => client.request<WordGloss>("POST", "/v1/memory/translate", { body }),
    /** the WAV (PCM 16 bit, mono, 16 kHz) goes as the body; the server puts the reference text by `target` */
    pronounce: (target: string, wav: Blob) =>
      client.request<PronunciationView>("POST", "/v1/memory/pronunciation", { query: { target }, raw: { body: wav, contentType: "audio/wav" } }),
    /** a parent (18+) switches the voice recording of a child profile on or off */
    setChildVoiceConsent: (learnerId: string, granted: boolean) =>
      client.request<LearnerSummary>("PUT", `/v1/learners/${enc(learnerId)}/voice-consent`, { body: { granted } }),
    readings: (level: Band | null, cursor: string | null) => get<Page<ReadingCard>>("/v1/practice/readings", { level, cursor, limit: 20 }),
    reading: (id: string) => get<ReadingView>(`/v1/practice/readings/${enc(id)}`),
    startReading: (id: string, key: string) => client.request<LessonSession>("POST", `/v1/practice/readings/${enc(id)}/sessions`, { idempotencyKey: key }),

    // ---- deletion ----
    requestDeletion: (body: DeletionRequest) => client.request<DeletionResponse>("POST", "/v1/profile/delete-request", { body }),
  };
}

export type Bff = ReturnType<typeof createBff>;
export type { SessionResponse };
