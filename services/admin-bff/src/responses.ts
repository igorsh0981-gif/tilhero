/**
 * Схемы ответов admin-bff (Fastify response → fast-json-stringify): клиент получает ТОЛЬКО поля контракта admin.ts
 * (bff.ts для client-view), служебные поля доменов отбрасываются (решение ревью спринта 1, T2).
 *
 * Синхронизация с контрактом проверяется при `tsc`: `shape<T>()` требует ровно ключи типа T — поле, добавленное
 * в admin.ts или удалённое из него, ломает сборку, пока схема не обновлена. Обязательные поля контракта
 * записаны в `x-contract-required`: сериализатор их не требует (пропуск поля домена — не 500 в проде), а тесты
 * проверяют ответы строгим Ajv (`strictContractSchema`) — так ловится null вместо обязательного значения, который
 * fast-json-stringify молча превратил бы в ""/0/{}. Маршрут /admin/v1 без схемы ответа не регистрируется.
 */
import type {
  AdminUserAccessBrief,
  AdminUserCard,
  AiBudget,
  AiBudgetNews,
  AiLimits,
  AiLimitValues,
  ApprovalDecision,
  AdminUserRow,
  AiDraft,
  Approval,
  AuditRecord,
  ChainVerification,
  ConfigActivation,
  ConfigState,
  ConfigVersion,
  DiscoveryRun,
  ErrorBody,
  Escalation,
  LoginStep,
  Me,
  MfaEnrollStart,
  ReplyTemplate,
  RevealResult,
  ReviewDetail,
  ReviewItem,
  Role,
  SlaPolicies,
  SlaPolicy,
  Source,
  SourceChange,
  SourceCrawlStats,
  SourceCrawlStatsList,
  SourceDetail,
  SourceListingPage,
  Staff,
  StaffCreated,
  StaffSummary,
  StaffTicket,
  StaffTicketMessage,
  StaffTicketSummary,
  StepUpResult,
  SupportStats,
  OfferSnapshotAdmin,
  TravelProviderError,
  TravelProviderProbe,
  TravelProviderStatus,
  TravelProvidersStatus,
  TravelRouteError,
  ReviewBulkResult,
  NewsAdminItem,
  NewsSource,
  NewsSourceCheck,
  NewsSourceError,
  NewsSourceHealth,
  NewsProbeResult,
  SourceJsonApiPreview,
  SourceJsonApiPreviewEvent,
  WatchStats,
} from "@tilhero/contracts/admin";
import type { Ticket as ClientTicket, TicketContext, TicketMessage } from "@tilhero/contracts/bff";
import type { StaffReleaseNote } from "@tilhero/contracts/admin";

export type Schema = Record<string, unknown>;
type Props<T> = { [K in keyof Required<T>]: Schema };
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

/** Нестандартное ключевое слово: обязательные поля контракта (сериализатор его игнорирует). */
export const CONTRACT_REQUIRED = "x-contract-required";

/** Объект ровно с ключами T (проверка при компиляции); optional — необязательные (`?:`) поля контракта. */
export function shape<T>(props: Props<T>, ...optional: OptionalKeys<T>[]): Schema {
  const opt = new Set<string>(optional as string[]);
  return { type: "object", properties: props, [CONTRACT_REQUIRED]: Object.keys(props).filter((k) => !opt.has(k)) };
}

/** Строгая копия схемы для Ajv (тесты): x-contract-required → required. */
export function strictContractSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictContractSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === CONTRACT_REQUIRED) out.required = v;
    else out[k] = strictContractSchema(v);
  }
  return out;
}
const orNull = (s: Schema): Schema => ({ ...s, type: [s.type as string, "null"] });

const STR: Schema = { type: "string" };
const N_STR: Schema = { type: ["string", "null"] };
const INT: Schema = { type: "integer" };
const N_INT: Schema = { type: ["integer", "null"] };
const NUM: Schema = { type: "number" };
const N_NUM: Schema = { type: ["number", "null"] };
const BOOL: Schema = { type: "boolean" };
/** Свободный объект (summary, before/after, payload, details) — передаётся целиком. */
const ANY_OBJ: Schema = { type: "object", additionalProperties: true };
const N_ANY_OBJ: Schema = { type: ["object", "null"], additionalProperties: true };
const STR_ARR: Schema = { type: "array", items: STR };
const arr = (items: Schema): Schema => ({ type: "array", items });
const page = (item: Schema): Schema => ({
  type: "object",
  properties: { items: arr(item), next_cursor: N_STR },
  [CONTRACT_REQUIRED]: ["items", "next_cursor"],
});
const RU_EN = shape<{ ru: string; en: string }>({ ru: STR, en: STR });

export const ERROR_BODY = shape<ErrorBody>({ code: STR, message: STR, trace_id: STR, details: ANY_OBJ });

// ---------- auth ----------
export const STAFF_SUMMARY = shape<StaffSummary>({ staff_id: STR, email: STR, display_name: STR, role: STR });
export const ME = shape<Me>({
  staff: STAFF_SUMMARY,
  permissions: STR_ARR,
  mfa_enabled: BOOL,
  must_change_password: BOOL,
  session: shape<Me["session"]>({ expires_at: STR, idle_timeout_seconds: INT, step_up_until: N_STR }),
  csrf_token: STR,
  env: STR,
  runbook_base_url: STR,
  impersonating: N_STR,
}, "runbook_base_url");
export const LOGIN_STEP = shape<LoginStep>({ next: STR, challenge: N_STR, me: orNull(ME) });
export const MFA_ENROLL_START = shape<MfaEnrollStart>({ secret: STR, otpauth_uri: STR, issuer: STR, account: STR });
export const STEP_UP_RESULT = shape<StepUpResult>({ step_up_until: STR });

// ---------- staff / roles / approvals ----------
export const STAFF = shape<Staff>({
  staff_id: STR,
  email: STR,
  display_name: STR,
  role: STR,
  status: STR,
  auth_provider: STR,
  mfa_enabled: BOOL,
  must_change_password: BOOL,
  last_login_at: N_STR,
  created_at: STR,
  created_by: N_STR,
});
export const APPROVAL = shape<Approval>({
  approval_id: STR,
  kind: STR,
  status: STR,
  summary: ANY_OBJ,
  reason: STR,
  requested_by: STAFF_SUMMARY,
  requested_at: STR,
  decided_by: orNull(STAFF_SUMMARY),
  decided_at: N_STR,
  decision_note: N_STR,
  waived: N_STR,
  expires_at: STR,
});
export const APPROVAL_ENVELOPE = shape<{ approval: Approval }>({ approval: APPROVAL });
export const STAFF_CREATED = shape<StaffCreated>({ staff: STAFF, temporary_password: N_STR, approval: orNull(APPROVAL) });
export const TEMPORARY_PASSWORD = shape<{ temporary_password: string }>({ temporary_password: STR });
const APPROVAL_PROPS = (APPROVAL as { properties: Props<Approval> }).properties;
/** approve/reject → ApprovalDecision: temporary_password — только approve заявки staff.privileged_reset (один раз). */
export const APPROVAL_DECISION = shape<ApprovalDecision>({ ...APPROVAL_PROPS, temporary_password: STR }, "temporary_password");
export const ROLE = shape<Role>({
  code: STR,
  name: RU_EN,
  permissions: STR_ARR,
  privileged: BOOL,
  staff_count: INT,
  updated_at: STR,
  updated_by: N_STR,
});
export const ROLES = shape<{ items: Role[]; permissions: string[] }>({ items: arr(ROLE), permissions: STR_ARR });
export const STAFF_PAGE = page(STAFF);
export const APPROVAL_PAGE = page(APPROVAL);

// ---------- users ----------
const USER_ROW_PROPS: Props<AdminUserRow> = {
  user_id: STR,
  username: N_STR,
  display_name: N_STR,
  telegram_id_masked: STR,
  locale: N_STR,
  status: STR,
  onboarding_completed: BOOL,
  open_tickets: INT,
  tickets_total: INT,
  created_at: STR,
  last_seen_at: N_STR,
  plan: STR,
  // спринт 7: проекция уровня доступа (user-admin); у user-admin до спринта 7 поля нет
  access_level: orNull(shape<AdminUserAccessBrief>({ level: N_STR, source: STR, expires_at: N_STR })),
};
export const USER_ROW = shape<AdminUserRow>(USER_ROW_PROPS, "access_level");
export const USER_PAGE = page(USER_ROW);
/** Карточка: поля спринта 7 (ai_conversations, access_level, ai_usage_30d) — заглушки; строгие схемы подставляет
 *  routes/users.ts из описаний routes/aiCodecs.ts (без цикла модулей responses → aiCodecs → travel → responses). */
export const USER_CARD = shape<AdminUserCard>({
  ...USER_ROW_PROPS,
  consent: shape<AdminUserCard["consent"]>({
    policy_version: N_STR,
    purposes: STR_ARR,
    accepted_at: N_STR,
    age_confirmed_18_plus: BOOL,
    revoked_at: N_STR,
  }),
  security: shape<AdminUserCard["security"]>({ pin_enabled: BOOL, biometric_enabled: BOOL }),
  preferences: shape<AdminUserCard["preferences"]>({ onboarding_completed: BOOL, updated_at: N_STR, changed_fields: STR_ARR }),
  tickets: arr(
    shape<AdminUserCard["tickets"][number]>({ ticket_id: STR, number: STR, status: STR, subject: STR, created_at: STR }),
  ),
  ai_conversations: { type: ["array", "null"], items: ANY_OBJ },
  access_level: N_ANY_OBJ,
  ai_usage_30d: N_ANY_OBJ,
  refreshed_at: STR,
}, "access_level", "ai_usage_30d");
export const REVEAL_RESULT = shape<RevealResult>({ field: STR, value: STR, expires_in: INT });

// ---------- dashboard ----------
// Спринт 8: схема DashboardV2 — routes/dashboard.ts (DASHBOARD_V2_SCHEMA, из описаний блоков opsCodecs.ts).
const SUPPORT_STATS_PROPS: Props<SupportStats> = {
  open: INT,
  in_progress: INT,
  waiting_customer: INT,
  breached: INT,
  avg_first_response_minutes: N_NUM,
  avg_resolution_minutes: N_NUM,
};
export const SUPPORT_STATS = shape<SupportStats>(SUPPORT_STATS_PROPS);

// ---------- support ----------
const TICKET_SUMMARY_PROPS: Props<StaffTicketSummary> = {
  ticket_id: STR,
  number: STR,
  user_id: N_STR,
  channel: STR,
  category: STR,
  subject: STR,
  status: STR,
  priority: STR,
  assignee_id: N_STR,
  assignee_name: N_STR,
  has_event_context: BOOL,
  anonymized: BOOL,
  created_at: STR,
  updated_at: STR,
  last_message_at: STR,
  first_response_at: N_STR,
  sla_first_response_at: STR,
  sla_resolution_at: STR,
  sla_target: N_STR,
  sla_due_at: N_STR,
  sla_state: STR,
  sla_paused: BOOL,
};
export const TICKET_PAGE = page(shape<StaffTicketSummary>(TICKET_SUMMARY_PROPS));
type StaffContext = NonNullable<StaffTicket["context"]>;
export const ESCALATION = shape<Escalation>({ escalation_id: STR, type: STR, note: STR, status: STR, created_by: STR, created_at: STR });
export const STAFF_TICKET = shape<StaffTicket>({
  ...TICKET_SUMMARY_PROPS,
  context: orNull(
    shape<StaffContext>({
      event_id: N_STR,
      offer_id: N_STR,
      provider_id: N_STR,
      deeplink: N_STR,
      price_snapshot: orNull(shape<NonNullable<StaffContext["price_snapshot"]>>({ amount: STR, currency: STR })),
      fetched_at: N_STR,
      trace_id: N_STR,
      client_version: N_STR,
    }),
  ),
  correlation_id: N_STR,
  resolved_at: N_STR,
  closed_at: N_STR,
  user_unread_operator_replies: INT,
  messages: arr(
    shape<StaffTicketMessage>({
      message_id: STR,
      sender_type: STR,
      visibility: STR,
      author_id: N_STR,
      author_name: N_STR,
      text: STR,
      created_at: STR,
    }),
  ),
  status_history: arr(
    shape<StaffTicket["status_history"][number]>({ from_status: N_STR, status: STR, at: STR, changed_by: STR, actor_id: N_STR }),
  ),
  escalations: arr(ESCALATION),
  user: orNull(
    shape<NonNullable<StaffTicket["user"]>>({ user_id: STR, username: N_STR, telegram_id_masked: STR, locale: N_STR, status: STR }),
  ),
});
/** «Как видит клиент» — форма клиентского API (bff.ts Ticket): без internal, user_id, assignee и прочего. */
export const CLIENT_TICKET = shape<ClientTicket>({
  ticket_id: STR,
  number: STR,
  category: STR,
  subject: STR,
  status: STR,
  created_at: STR,
  updated_at: STR,
  last_message_at: STR,
  unread_operator_replies: INT,
  context: orNull(
    shape<TicketContext>({
      event_id: STR,
      offer_id: STR,
      provider_id: STR,
      deeplink: STR,
      price_snapshot: shape<NonNullable<TicketContext["price_snapshot"]>>({ amount: STR, currency: STR, fetched_at: STR }),
      event_title: STR,
      client_version: STR,
    }, "event_id", "offer_id", "provider_id", "deeplink", "price_snapshot", "event_title"),
  ),
  sla_first_response_at: N_STR,
  messages: arr(shape<TicketMessage>({ message_id: STR, sender_type: STR, author_name: N_STR, text: STR, created_at: STR })),
  status_history: arr(shape<ClientTicket["status_history"][number]>({ status: STR, at: STR })),
});
export const SLA_POLICIES = shape<SlaPolicies>(
  {
    items: arr(
      shape<SlaPolicy>(
        {
          category: STR,
          priority: STR,
          first_response_minutes: INT,
          resolution_minutes: INT,
          updated_at: STR,
          updated_by: N_STR,
        },
        "updated_at",
        "updated_by",
      ),
    ),
    category_defaults: { type: "object", additionalProperties: STR },
  },
  "category_defaults",
);
export const TEMPLATES = shape<{ items: ReplyTemplate[] }>({
  items: arr(shape<ReplyTemplate>({ id: STR, title: RU_EN, text: RU_EN, categories: STR_ARR })),
});
export const AI_DRAFT = shape<AiDraft>({ text: STR, stub: BOOL, source: STR });

// ---------- audit ----------
export const AUDIT_RECORD = shape<AuditRecord>({
  seq: INT,
  record_id: STR,
  occurred_at: STR,
  recorded_at: STR,
  source: STR,
  actor_type: STR,
  actor_id: N_STR,
  actor_role: N_STR,
  action: STR,
  object_type: N_STR,
  object_id: N_STR,
  before: N_ANY_OBJ,
  after: N_ANY_OBJ,
  reason: N_STR,
  ip: N_STR,
  session_id: N_STR,
  trace_id: N_STR,
  prev_hash: STR,
  hash: STR,
});
export const AUDIT_PAGE = page(AUDIT_RECORD);
export const CHAIN_VERIFICATION = shape<ChainVerification>({
  valid: BOOL,
  checked: INT,
  first_seq: N_INT,
  last_seq: N_INT,
  broken_at_seq: N_INT,
});

// ---------- experience ----------
const VERSION_SUMMARY_PROPS: Props<Omit<ConfigVersion, "payload">> = {
  version_id: STR,
  app: STR,
  version: STR,
  checksum: STR,
  change_note: STR,
  created_by: STR,
  created_at: STR,
  status: N_STR,
};
export const CONFIG_VERSION = shape<ConfigVersion>({ ...VERSION_SUMMARY_PROPS, payload: ANY_OBJ }, "payload");
/** Список версий — без payload (как в experience-config VersionSummary). */
export const CONFIG_VERSION_PAGE = page(shape<Omit<ConfigVersion, "payload">>(VERSION_SUMMARY_PROPS));
export const CONFIG_ACTIVATION = shape<ConfigActivation>({
  activation_id: STR,
  app: STR,
  version: STR,
  previous_version: N_STR,
  kind: STR,
  reason: STR,
  activated_by: STR,
  activated_at: STR,
});
export const CONFIG_ACTIVATION_PAGE = page(CONFIG_ACTIVATION);
export const CONFIG_STATE = shape<ConfigState>({ app: STR, current: orNull(CONFIG_ACTIVATION), previous_version: N_STR });
/**
 * Действующая конфигурация (experience-config current, admin.ts — ExperienceConfig без описания полей): объект
 * передаётся целиком; источник — валидированный белым списком payload experience-config, без секретов.
 */
export const EXPERIENCE_CURRENT: Schema = ANY_OBJ;

// ---------- доработка 9.4: «Что нового» (заметки о релизах) ----------
const NOTE_ITEM = shape<StaffReleaseNote["items"][number]>({ title: RU_EN, text: RU_EN, link: N_STR, icon: N_STR });
export const RELEASE_NOTE = shape<StaffReleaseNote>({
  release_note_id: STR,
  slug: STR,
  title: RU_EN,
  items: arr(NOTE_ITEM),
  audience: STR,
  status: STR,
  version: INT,
  created_by: STR,
  created_at: STR,
  updated_by: STR,
  updated_at: STR,
  published_by: N_STR,
  published_at: N_STR,
  archived_by: N_STR,
  archived_at: N_STR,
});
export const RELEASE_NOTE_PAGE = page(RELEASE_NOTE);

// ---------- спринт 4: источники, очередь проверки, поиск событий ----------
const SOURCE_PROPS: Props<Source> = {
  source_id: STR,
  slug: STR,
  name: STR,
  country_code: STR,
  tier: STR,
  event_domains: STR_ARR,
  media_domains: STR_ARR,
  listing_pages: arr(shape<SourceListingPage>({ url: STR, city: N_STR, category: N_STR, kind: STR, priority: STR, json_api: N_ANY_OBJ }, "kind", "priority", "json_api")),
  enabled: BOOL,
  js_only: { type: ["boolean", "null"] },
  notes: N_STR,
  version: INT,
  created_at: STR,
  updated_at: STR,
  updated_by: N_STR,
  updated_by_name: N_STR,
  disabled_reason: N_STR, // 9.1
};
export const SOURCE = shape<Source>(SOURCE_PROPS, "disabled_reason");
export const SOURCE_PAGE = page(SOURCE);
export const SOURCE_DETAIL = shape<SourceDetail>(
  {
    ...SOURCE_PROPS,
    changes: arr(shape<SourceChange>({ version: INT, actor_id: N_STR, actor_name: N_STR, changed_fields: STR_ARR, reason: STR, at: STR })),
  },
  "disabled_reason",
);

/** Исправление 9.3: предпросмотр страницы «JSON API» (provider-gateway json_api:preview, нормализован в BFF). */
export const SOURCE_JSON_API_PREVIEW = shape<SourceJsonApiPreview>({
  ok: BOOL,
  code: N_STR,
  reason: N_STR,
  request_url: STR,
  items_path: N_STR,
  items_total: INT,
  events: arr(
    shape<SourceJsonApiPreviewEvent>({
      id: STR,
      title: STR,
      local_date: STR,
      local_time: N_STR,
      timezone: N_STR,
      utc: N_STR,
      end_local_date: N_STR,
      end_local_time: N_STR,
      venue: N_STR,
      city: N_STR,
      url: STR,
      image: N_STR,
      price: orNull(shape<{ min: string; max: string; currency: string }>({ min: STR, max: STR, currency: STR })),
      category: N_STR,
      age: N_STR,
      status: N_STR,
      description: N_STR,
    }),
  ),
  rejected: arr(shape<{ index: number; id: string | null; reason: string }>({ index: INT, id: N_STR, reason: STR })),
  keys: arr(shape<{ path: string; sample: string }>({ path: STR, sample: STR })),
  keys_scope: N_STR,
  skipped: { type: "object", additionalProperties: INT },
  checked_at: STR,
});

/** Последний обход AI-источника (provider-gateway ai_web/sources). skipped — причина → число, notes — признак страницы → число. */
export const SOURCE_CRAWL_STATS = shape<SourceCrawlStatsList>({
  items: arr(
    shape<SourceCrawlStats>({
      slug: STR,
      last_crawl_at: N_STR,
      outcome: N_STR,
      code: N_STR,
      pages: INT,
      events_found: INT,
      skipped: { type: "object", additionalProperties: INT },
      notes: { type: "object", additionalProperties: INT },
      llm_calls: INT,
      cost_usd_last: STR,
      cost_usd_day: STR,
    }),
  ),
});

const LOCAL_START = shape<ReviewItem["start"]>({ local_date: STR, local_time: N_STR });
const REVIEW_ITEM_PROPS: Props<ReviewItem> = {
  review_id: STR,
  status: STR,
  provider: STR,
  source_name: N_STR,
  source_url: STR,
  tier: STR,
  confidence: NUM,
  reasons: STR_ARR,
  title: STR,
  start: LOCAL_START,
  city: N_STR,
  country_code: N_STR,
  received_at: STR,
  content_hash: STR,
  // исправление 5.1: срок авто-снятия (OPEN) / время авто-снятия (EXPIRED); старый events — без полей
  expires_at: N_STR,
  expired_at: N_STR,
};
const REVIEW_ITEM_OPTIONAL = ["expires_at", "expired_at"] as const;
export const REVIEW_PAGE = page(shape<ReviewItem>(REVIEW_ITEM_PROPS, ...REVIEW_ITEM_OPTIONAL));
type ReviewMedia = ReviewDetail["media"][number];
export const REVIEW_DETAIL = shape<ReviewDetail>({
  ...REVIEW_ITEM_PROPS,
  facts: ANY_OBJ,
  media: arr(
    shape<ReviewMedia>({
      url: STR,
      provenance: shape<ReviewMedia["provenance"]>({ provider: STR, source_url: STR, fetched_at: STR, rights: STR }),
    }),
  ),
  matched_event_id: N_STR,
  decided_by: N_STR,
  decided_by_name: N_STR,
  decided_at: N_STR,
  decision_note: N_STR,
  decision_reason: N_STR,
  event_id: N_STR,
}, ...REVIEW_ITEM_OPTIONAL);
/** accept/correct → {review, event_id}; reject → {review} (admin.ts, комментарий к ReviewCorrection). */
export const REVIEW_DECIDED = shape<{ review: ReviewDetail; event_id: string }>({ review: REVIEW_DETAIL, event_id: STR });
export const REVIEW_REJECTED = shape<{ review: ReviewDetail }>({ review: REVIEW_DETAIL });
/** исправление 5.1: bulk-reject / bulk-reopen */
export const REVIEW_BULK_RESULT = shape<ReviewBulkResult>({
  results: arr(shape<ReviewBulkResult["results"][number]>({ review_id: STR, status: STR, code: N_STR })),
});

export const DISCOVERY_RUN = shape<DiscoveryRun>({
  run_id: STR,
  trigger: STR,
  status: STR,
  started_at: STR,
  finished_at: N_STR,
  scopes_total: INT,
  scopes_done: INT,
  provider_calls: INT,
  candidates_seen: INT,
  candidates_emitted: INT,
  ai: shape<DiscoveryRun["ai"]>({ llm_calls: INT, pages_fetched: INT, input_tokens: INT, output_tokens: INT, cost_usd: STR }),
  errors: arr(shape<DiscoveryRun["errors"][number]>({ scope: STR, code: STR })),
});
export const DISCOVERY_RUN_PAGE = page(DISCOVERY_RUN);
// спринт 7: бюджеты агентов — null, пока provider-gateway не обновлён (6.1 их не отдаёт); admin-bff отдаёт поле всегда
const AI_LIMIT_VALUES_PROPS = { ai_daily_usd: STR, news_daily_usd: STR, pages_daily: INT, concierge_daily_usd: N_STR, evaluation_daily_usd: N_STR };
/** Исправление 6.1: лимиты AI (routes/limits.ts нормализует ответ provider-gateway). */
export const AI_LIMITS = shape<AiLimits>({
  ...AI_LIMIT_VALUES_PROPS,
  source: STR,
  updated_by: N_STR,
  updated_by_name: N_STR,
  updated_at: N_STR,
  reason: N_STR,
  defaults: shape<AiLimitValues>(AI_LIMIT_VALUES_PROPS, "concierge_daily_usd", "evaluation_daily_usd"),
}, "concierge_daily_usd", "evaluation_daily_usd");
export const AI_BUDGET = shape<AiBudget>({
  day: STR,
  spent_usd: STR,
  reserved_usd: STR,
  budget_usd: STR,
  pages_used: INT,
  pages_limit: INT,
  paused: orNull(shape<NonNullable<AiBudget["paused"]>>({ paused: BOOL, reason: STR, by: STR, by_name: N_STR, at: STR })),
  model: STR,
  // спринт 6: бюджет AI новостей (provider-gateway до спринта 6 поля не отдаёт)
  news: orNull(shape<AiBudgetNews>({ spent_usd: STR, budget_usd: STR })),
  limits: orNull(AI_LIMITS),
}, "news", "limits");

// ---------- спринт 5: поставщики поездок, снимок предложения (docs/sprint5/INTERNAL_API.md §5)
export const TRAVEL_PROVIDERS = shape<TravelProvidersStatus>({
  items: arr(
    shape<TravelProviderStatus>({
      name: STR,
      configured: BOOL,
      enabled: BOOL,
      quota: orNull(shape<NonNullable<TravelProviderStatus["quota"]>>({ day_used: INT, day_limit: INT })),
      breaker: STR,
      // at: null — gateway отдал код без времени (provider-gateway спринта 4 хранил время только в Redis);
      // reason / message / http_status — исправление 5.1, null у старого gateway
      last_error: orNull(shape<TravelProviderError>({ code: STR, reason: N_STR, message: N_STR, at: N_STR, http_status: N_INT })),
      last_success_at: N_STR,
      // 5.2: ошибка маршрута (поставщик не знает код места) — отдельно от last_error, на здоровье не влияет
      last_route_error: orNull(shape<TravelRouteError>({ code: STR, location: N_STR, route: N_STR, at: N_STR })),
    }),
  ),
});
export const TRAVEL_PROBE = shape<TravelProviderProbe>({
  name: STR,
  ok: BOOL,
  latency_ms: N_INT,
  code: N_STR,
  reason: N_STR,
  message: N_STR,
  http_status: N_INT,
  checked_at: STR,
});
/** offer / trip в admin.ts — unknown (= bff.Offer / OfferSetView["trip"]): BFF собирает их сам (routes/travel.ts). */
export const OFFER_SNAPSHOT = shape<OfferSnapshotAdmin>({
  offer_id: STR,
  user_id: STR,
  event_id: STR,
  tier: STR,
  travellers: INT,
  created_at: STR,
  expires_at: STR,
  offer: ANY_OBJ,
  trip: N_ANY_OBJ,
  departure: orNull(shape<NonNullable<OfferSnapshotAdmin["departure"]>>({ iata: STR, city: STR, chosen_by: STR })),
  notes: STR_ARR,
});

// ---------- спринт 6: новости и Watch (routes/news.ts, routes/watch.ts — ответы доменов нормализуются там) ----------
export const NEWS_SOURCE = shape<NewsSource>({
  source_id: STR,
  slug: STR,
  name: STR,
  kind: STR,
  mode: STR,
  feed_url: N_STR,
  page_url: N_STR,
  site_domain: STR,
  extra_domains: STR_ARR,
  interests: STR_ARR,
  entities: STR_ARR,
  country_code: N_STR,
  lang: STR,
  display: STR,
  category_filter: N_STR,
  enabled: BOOL,
  health: shape<NewsSourceHealth>({
    last_fetch_at: N_STR,
    last_ok_at: N_STR,
    last_error: orNull(shape<NewsSourceError>({ code: STR, message: N_STR, at: N_STR })),
    items_24h: INT,
  }),
  disabled_reason: N_STR,
  last_probe_at: N_STR,
  last_probe_result: orNull(shape<NewsProbeResult>({ ok: BOOL, code: N_STR, fetched: INT, accepted: INT, newest_at: N_STR, enabled: BOOL })),
  version: INT,
  updated_at: N_STR,
});
export const NEWS_SOURCE_PAGE = page(NEWS_SOURCE);
export const NEWS_SOURCE_CHECK = shape<NewsSourceCheck>({
  ok: BOOL,
  items: arr(shape<NewsSourceCheck["items"][number]>({ url: STR, title: STR, published_at: N_STR, dropped: N_STR })),
  items_total: INT,
  errors: arr(shape<NewsSourceCheck["errors"][number]>({ code: STR, message: N_STR })),
  checked_at: STR,
});
export const NEWS_ITEM = shape<NewsAdminItem>({
  news_id: STR,
  kind: STR,
  title: STR,
  summary_ru: N_STR,
  summary_en: N_STR,
  url: STR,
  source: shape<NewsAdminItem["source"]>({ source_id: N_STR, name: STR, domain: STR }),
  published_at: N_STR,
  collected_at: N_STR,
  significance: N_NUM,
  significance_level: N_STR,
  interests: STR_ARR,
  entities: STR_ARR,
  event_ids: STR_ARR,
  hidden: BOOL,
  hidden_reason: N_STR,
  hidden_at: N_STR,
  hidden_by: N_STR,
  hidden_by_name: N_STR,
  below_threshold: BOOL,
});
export const NEWS_ITEM_PAGE = page(NEWS_ITEM);
export const WATCH_STATS = shape<WatchStats>({
  active: INT,
  paused: INT,
  ended_24h: INT,
  rechecks_24h: INT,
  changes_24h: shape<WatchStats["changes_24h"]>({ price_drop: INT, price_rise: INT, lifecycle: INT, tickets: INT, flight: INT, hotel: INT }),
  notifications_24h: shape<WatchStats["notifications_24h"]>({ immediate: INT, digest: INT, suppressed: INT }),
  errors_24h: INT,
  next_batch_at: N_STR,
});

/** Ответ 2xx маршрута (любой код 2xx домена фильтруется той же схемой). */
export const ok = (s: Schema) => ({ "2xx": s });
export const NO_CONTENT = { 204: { type: "null" } };
