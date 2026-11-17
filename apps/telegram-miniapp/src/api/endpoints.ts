import type {
  AiActionRequest,
  AiConversation,
  AiCreateConversationRequest,
  AiMessageRequest,
  AiQuota,
  AiToolName,
  Airport,
  BiometricEnableResponse,
  ConsentRequest,
  ConsentState,
  CreateTicketRequest,
  CreateWatchRequest,
  DeletionRequest,
  DeletionResponse,
  EventCard,
  EventDetailView,
  EventFacets,
  EventSort,
  ExperienceConfig,
  GeoOption,
  HomeResponse,
  InterestCategory,
  NewsItem,
  NewsPreferences,
  OfferRecalculateRequest,
  OfferSetView,
  Page,
  PinResetConfirmRequest,
  PinResetRequestResponse,
  PinSetRequest,
  PolicyDocument,
  Preferences,
  PreferencesPatch,
  Profile,
  ReactionRequest,
  SecurityState,
  SettingsPatch,
  Ticket,
  TicketCategory,
  TicketSummary,
  Watch,
  WatchChange,
  NewsFilter,
  NewsTopic,
  NewsTopicsResponse,
  NewsPreferencesPatch,
  WatchPatchRequest,
  WhatsNewResponse,
  WhatsNewSeenResponse,
} from "@tilhero/contracts/bff";
import { resetCatalogMemory } from "../events/memory";
import { forgetSavedFilters } from "../events/saved";
import type { ApiClient } from "./client";

/** Filters of GET /v1/events and GET /v1/events/facets: country — ISO-2 list, comma-separated (≤ 20). */
export type EventsFilterQuery = {
  q?: string;
  category?: string;
  country?: string;
  city?: string;
  date_from?: string;
  date_to?: string;
  has_tickets?: "true";
  online?: "true" | "false";
};

/** Query of GET /v1/events/facets: the filters + the window of the «В этом месяце» chip (YYYY-MM-DD, viewer's
 *  calendar, both or neither) — this_month is counted over it. */
export type EventsFacetsQuery = EventsFilterQuery & {
  month_from?: string;
  month_to?: string;
};

/** Query of GET /v1/events (bff.ts: the filters + sort, cursor, limit). */
export type EventsQuery = EventsFilterQuery & {
  sort?: EventSort;
  cursor?: string;
  limit?: number;
};

export interface SupportCategory {
  code: TicketCategory;
  label: { ru: string; en: string };
  available: boolean;
}


/** GET /v1/watches page size: the BFF accepts limit ≤ 20 (review B2). */
export const WATCH_PAGE = 20;

/** Typed BFF API (packages/contracts/src/bff.ts is the only source of these types). */
export function createApi(c: ApiClient) {
  return {
    session: {
      verifyPin: (pin: string) => c.issueSession("POST", "/v1/session/pin/verify", { body: { pin } }),
      verifyBiometric: (biometric_token: string) =>
        c.issueSession("POST", "/v1/session/biometric/verify", { body: { biometric_token } }),
      logout: () =>
        c.request<void>("POST", "/v1/session/logout").finally(() => {
          resetCatalogMemory();
          forgetSavedFilters(); // another session on this device must not inherit the catalogue filters
        }),
    },
    /** 9.4: «Что нового» — заметки о релизах приложения */
    whatsNew: {
      // quiet: a background extra — its 503 must not show «Нет связи» on Home (review 9.4)
      get: () => c.request<WhatsNewResponse>("GET", "/v1/whats-new", { quiet: true }),
      seen: (release_note_id: string) => c.request<WhatsNewSeenResponse>("POST", "/v1/whats-new/seen", { body: { release_note_id }, quiet: true }),
    },
    experience: {
      config: (signal?: AbortSignal) => c.request<ExperienceConfig>("GET", "/v1/experience/config", { auth: false, signal }),
    },
    legal: {
      policy: (lang: "ru" | "en") => c.request<PolicyDocument>("GET", "/v1/legal/policy", { auth: false, query: { lang } }),
    },
    profile: {
      get: () => c.request<Profile>("GET", "/v1/profile"),
      settings: (patch: SettingsPatch) => c.request<Profile>("PATCH", "/v1/profile/settings", { body: patch }),
      preferences: (patch: PreferencesPatch) => c.request<Preferences>("PATCH", "/v1/profile/preferences", { body: patch }),
      departures: (airports: string[]) => c.request<Preferences>("PUT", "/v1/profile/departures", { body: { airports } }),
      completeOnboarding: () => c.request<Preferences>("POST", "/v1/profile/onboarding/complete"),
      acceptConsent: (req: ConsentRequest) => c.request<ConsentState>("POST", "/v1/profile/consent", { body: req }),
      revokeConsent: () => c.request<ConsentState>("DELETE", "/v1/profile/consent"),
      disable: () => c.request<Profile>("POST", "/v1/profile/disable"),
      enable: () => c.request<Profile>("POST", "/v1/profile/enable"),
      requestDeletion: (req: DeletionRequest) => c.request<DeletionResponse>("POST", "/v1/profile/delete-request", { body: req }),
    },
    security: {
      setPin: (req: PinSetRequest) => c.request<SecurityState>("PUT", "/v1/profile/security/pin", { body: req }),
      removePin: (current_pin: string) => c.request<SecurityState>("DELETE", "/v1/profile/security/pin", { body: { current_pin } }),
      resetRequest: () => c.request<PinResetRequestResponse>("POST", "/v1/profile/security/pin/reset-request"),
      resetConfirm: (req: PinResetConfirmRequest) =>
        c.issueSession("POST", "/v1/profile/security/pin/reset-confirm", { body: req }),
      enableBiometric: () => c.request<BiometricEnableResponse>("PUT", "/v1/profile/security/biometric"),
      disableBiometric: () => c.request<SecurityState>("DELETE", "/v1/profile/security/biometric"),
    },
    directory: {
      airports: (q: string, signal?: AbortSignal) =>
        c.request<{ items: Airport[] }>("GET", "/v1/directory/airports", { query: { q, limit: 20 }, signal }),
      interests: () => c.request<{ items: InterestCategory[] }>("GET", "/v1/directory/interests"),
      geographies: () => c.request<{ items: GeoOption[] }>("GET", "/v1/directory/geographies"),
    },
    home: {
      get: () => c.request<HomeResponse>("GET", "/v1/home"),
    },
    events: {
      /** GET /v1/events — query from state/catalog `filtersToQuery` (only contract parameters). */
      list: (query: EventsQuery, signal?: AbortSignal) => c.request<Page<EventCard>>("GET", "/v1/events", { query, signal }),
      get: (id: string, signal?: AbortSignal) => c.request<EventDetailView>("GET", `/v1/events/${encodeURIComponent(id)}`, { signal }),
      /** GET /v1/events/facets — counters of the quick chips (fix 4.1); failure → chips without counters. */
      facets: (query: EventsFacetsQuery, signal?: AbortSignal) => c.request<EventFacets>("GET", "/v1/events/facets", { query, signal }),
    },
    /** Sprint 5 — the trip under an event (INTERNAL_API §4): a separate request, its failure never breaks the detail. */
    offers: {
      get: (eventId: string, travellers: number, signal?: AbortSignal) =>
        c.request<OfferSetView>("GET", `/v1/events/${encodeURIComponent(eventId)}/offers`, { query: { travellers }, signal }),
      recalculate: (eventId: string, body: OfferRecalculateRequest, signal?: AbortSignal) =>
        c.request<OfferSetView>("POST", `/v1/events/${encodeURIComponent(eventId)}/offers/recalculate`, { body, signal }),
    },
    /** Sprint 6 — Watch (proxy to services/watch): one tap creates, the BFF adds the trip parameters itself. */
    watches: {
      /** pages of ≤ WATCH_PAGE (the BFF answers 422 above 20), next pages by cursor */
      list: (status?: Watch["status"], cursor?: string | null, signal?: AbortSignal) =>
        c.request<Page<Watch>>("GET", "/v1/watches", { query: { status, cursor: cursor ?? undefined, limit: WATCH_PAGE }, signal }),
      get: (id: string, signal?: AbortSignal) => c.request<Watch>("GET", `/v1/watches/${encodeURIComponent(id)}`, { signal }),
      create: (req: CreateWatchRequest, idempotencyKey: string) => c.request<Watch>("POST", "/v1/watches", { body: req, idempotencyKey }),
      patch: (id: string, patch: WatchPatchRequest) => c.request<Watch>("PATCH", `/v1/watches/${encodeURIComponent(id)}`, { body: patch }),
      remove: (id: string) => c.request<void>("DELETE", `/v1/watches/${encodeURIComponent(id)}`),
      changes: (id: string, cursor?: string | null, signal?: AbortSignal) =>
        c.request<Page<WatchChange>>("GET", `/v1/watches/${encodeURIComponent(id)}/changes`, { query: { cursor: cursor ?? undefined, limit: 20 }, signal }),
    },
    /** Sprint 6 — personal news (proxy to services/news with the user's profile). */
    news: {
      /** fix 6.1: `topic` — a root interest code (the catalogue category chips), none — every topic */
      list: (filter: NewsFilter, cursor?: string | null, signal?: AbortSignal, limit = 20, topic?: NewsTopic | null) =>
        c.request<Page<NewsItem>>("GET", "/v1/news", { query: { filter, topic: topic ?? undefined, cursor: cursor ?? undefined, limit }, signal }),
      /** fix 6.1: GET /v1/news/topics?filter= → non-empty topics (in the order of the catalogue chips) and the total */
      topics: (filter: NewsFilter, signal?: AbortSignal) => c.request<NewsTopicsResponse>("GET", "/v1/news/topics", { query: { filter }, signal }),
      preferences: (signal?: AbortSignal) => c.request<NewsPreferences>("GET", "/v1/news/preferences", { signal }),
      setPreferences: (patch: NewsPreferencesPatch) => c.request<NewsPreferences>("PATCH", "/v1/news/preferences", { body: patch }),
    },
    /** Sprint 6 — «Больше такого» / «Не интересно» (undo — remove the reaction). */
    recommendations: {
      react: (req: ReactionRequest) => c.request<void>("POST", "/v1/recommendations/reactions", { body: req }),
      /** DELETE /v1/recommendations/reactions/{event_id} → 204 (no reaction — also 204) */
      unreact: (eventId: string) => c.request<void>("DELETE", `/v1/recommendations/reactions/${encodeURIComponent(eventId)}`),
    },
    /** Sprint 7 — AI concierge (INTERNAL_API §5). Turns stream SSE (src/ai/sse.ts reads them). */
    ai: {
      quota: (signal?: AbortSignal) => c.request<AiQuota>("GET", "/v1/ai/quota", { signal }),
      create: (req: AiCreateConversationRequest, idempotencyKey: string) =>
        c.request<AiConversation>("POST", "/v1/ai/conversations", { body: req, idempotencyKey }),
      get: (id: string, signal?: AbortSignal) => c.request<AiConversation>("GET", `/v1/ai/conversations/${encodeURIComponent(id)}`, { signal }),
      remove: (id: string) => c.request<void>("DELETE", `/v1/ai/conversations/${encodeURIComponent(id)}`),
      /** a turn: text → …/messages, a quick action / retry → …/actions/{tool}; `accept` — the stream or the JSON fallback */
      turn: (id: string, body: AiMessageRequest | AiActionRequest, tool: AiToolName | null, accept: "text/event-stream" | "application/json", signal?: AbortSignal) =>
        c.open("POST", tool ? `/v1/ai/conversations/${encodeURIComponent(id)}/actions/${encodeURIComponent(tool)}` : `/v1/ai/conversations/${encodeURIComponent(id)}/messages`, {
          body,
          accept,
          signal,
        }),
    },
    support: {
      categories: () => c.request<{ items: SupportCategory[] }>("GET", "/v1/support/categories"),
      list: (cursor?: string | null, limit = 20) =>
        c.request<Page<TicketSummary>>("GET", "/v1/support/tickets", { query: { limit, cursor: cursor ?? undefined } }),
      get: (id: string) => c.request<Ticket>("GET", `/v1/support/tickets/${encodeURIComponent(id)}`),
      create: (req: CreateTicketRequest, idempotencyKey: string) =>
        c.request<Ticket>("POST", "/v1/support/tickets", { body: req, idempotencyKey }),
      reply: (id: string, text: string, idempotencyKey?: string) =>
        c.request<Ticket>("POST", `/v1/support/tickets/${encodeURIComponent(id)}/messages`, { body: { text }, idempotencyKey }),
      close: (id: string) => c.request<Ticket>("POST", `/v1/support/tickets/${encodeURIComponent(id)}/close`),
    },
  };
}

export type Api = ReturnType<typeof createApi>;

