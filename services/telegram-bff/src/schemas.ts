/**
 * JSON Schema (TypeBox) публичного API. Типы — единственный источник packages/contracts/src/bff.ts:
 * каждая схема ниже проверяется на взаимную совместимость с типом контракта на этапе tsc
 * (assertSame) — рассинхронизация схемы и контракта ломает typecheck.
 *
 * Вход: additionalProperties: false везде (лишние поля → 422). Ответы: схемы для OpenAPI.
 */
import { Type, type Static, type TLiteral, type TSchema } from "@fastify/type-provider-typebox";
import type * as C from "@tilhero/contracts/bff";
import { NOTE_ICONS, NOTE_ROUTES } from "./whatsNew.js";

// ---------- compile-time сверка с контрактом ----------
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertSame<T extends true>(_?: T): void {}

const strict = { additionalProperties: false } as const;
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const IsoTime = Type.String({ description: "ISO-8601 UTC" });
const Hhmm = Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" });
const Label = Type.Object({ ru: Type.String(), en: Type.String() });

// ---------- Errors ----------
export const ErrorBodySchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  trace_id: Type.String(),
  details: Type.Record(Type.String(), Type.Unknown()),
});
assertSame<Same<Static<typeof ErrorBodySchema>, C.ErrorBody>>();

// ---------- Session ----------
export const UserSummarySchema = Type.Object({
  user_id: Type.String(),
  display_name: Type.String(),
  username: Nullable(Type.String()),
  locale: Type.Union([Type.Literal("ru"), Type.Literal("en")]),
  status: Type.Union([Type.Literal("ACTIVE"), Type.Literal("DISABLED"), Type.Literal("DELETION_REQUESTED")]),
  is_new: Type.Boolean(),
});
assertSame<Same<Static<typeof UserSummarySchema>, C.UserSummary>>();

export const SecurityStateSchema = Type.Object({
  pin_enabled: Type.Boolean(),
  pin_length: Type.Union([Type.Literal(4), Type.Literal(6), Type.Null()]),
  biometric_enabled: Type.Boolean(),
  pin_required: Type.Boolean(),
  locked_until: Nullable(IsoTime),
});
assertSame<Same<Static<typeof SecurityStateSchema>, C.SecurityState>>();

export const ConsentStateSchema = Type.Object({
  accepted: Type.Boolean(),
  policy_version: Nullable(Type.String()),
  current_policy_version: Type.String(),
  accepted_at: Nullable(IsoTime),
  evidence_hash: Nullable(Type.String()),
  age_confirmed_18_plus: Type.Boolean(),
});
assertSame<Same<Static<typeof ConsentStateSchema>, C.ConsentState>>();

export const SessionResponseSchema = Type.Object({
  access_token: Type.String(),
  expires_in: Type.Integer(),
  refresh_token: Type.String(),
  user: UserSummarySchema,
  security: SecurityStateSchema,
  consent: ConsentStateSchema,
  onboarding_completed: Type.Boolean(),
});
assertSame<Same<Static<typeof SessionResponseSchema>, C.SessionResponse>>();

export const TelegramSessionRequestSchema = Type.Object(
  { init_data: Type.String({ minLength: 1, maxLength: 4096 }) },
  strict,
);
assertSame<Same<Static<typeof TelegramSessionRequestSchema>, C.TelegramSessionRequest>>();

export const RefreshRequestSchema = Type.Object({ refresh_token: Type.String({ minLength: 1, maxLength: 256 }) }, strict);
assertSame<Same<Static<typeof RefreshRequestSchema>, C.RefreshRequest>>();

/** PIN — ровно 4 или 6 цифр (контракт: 422 PIN_FORMAT); неформатный PIN не доходит до identity и не тратит попытку. */
const PinString = Type.String({ pattern: "^([0-9]{4}|[0-9]{6})$" });

export const PinVerifyRequestSchema = Type.Object({ pin: PinString }, strict);
assertSame<Same<Static<typeof PinVerifyRequestSchema>, C.PinVerifyRequest>>();

export const BiometricVerifyRequestSchema = Type.Object(
  { biometric_token: Type.String({ minLength: 1, maxLength: 256 }) },
  strict,
);
assertSame<Same<Static<typeof BiometricVerifyRequestSchema>, C.BiometricVerifyRequest>>();

// ---------- Preferences ----------
const BudgetPreset = Type.Union([
  Type.Literal("under_500"),
  Type.Literal("500_1000"),
  Type.Literal("1000_2000"),
  Type.Literal("2000_5000"),
  Type.Literal("custom"),
]);
const GeoLevel = Type.Union([Type.Literal("world"), Type.Literal("region"), Type.Literal("country"), Type.Literal("city")]);
const Usd = Type.Integer({ minimum: 0, maximum: 1_000_000, description: "USD, целые доллары" });

const GeographySchema = Type.Object({ level: GeoLevel, code: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) }, strict);
assertSame<Same<Static<typeof GeographySchema>, C.Geography>>();

const DepartureSchema = Type.Object({ airport_iata: Type.String(), city: Type.String(), country_code: Type.String() });
assertSame<Same<Static<typeof DepartureSchema>, C.Departure>>();

const prefFields = {
  interests: Type.Object(
    {
      categories: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 50 }),
      entities: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 20 }),
    },
    strict,
  ),
  geographies: Type.Array(GeographySchema, { maxItems: 30 }),
  strong_events_outside_geo: Type.Boolean(),
  event_formats: Type.Array(Type.Union([Type.Literal("offline"), Type.Literal("online")]), { maxItems: 2, uniqueItems: true }),
  budget: Type.Object(
    {
      currency: Type.Literal("USD"),
      preset: Nullable(BudgetPreset),
      min: Nullable(Usd),
      max: Nullable(Usd),
      custom_amount: Nullable(Usd),
    },
    strict,
  ),
  search_horizon_months: Type.Union([Type.Literal(3), Type.Literal(6), Type.Literal(12), Type.Literal(24)]),
  notification_points_months: Type.Array(
    Type.Union([Type.Literal(1), Type.Literal(3), Type.Literal(6), Type.Literal(12)]),
    { maxItems: 4, uniqueItems: true },
  ),
  flight_prefs: Type.Object(
    { direct: Type.Boolean(), connecting: Type.Boolean(), alternative_departure: Type.Boolean() },
    strict,
  ),
  // 6.3: настройки отеля; допустимые значения (чипы) проверяет preferences — 422 PREFERENCES_INVALID
  hotel_prefs: Type.Object(
    {
      rating_min: Nullable(Type.Number({ minimum: 0, maximum: 10, description: "0 — любая; null — по умолчанию (experience-config)" })),
      max_distance_km: Nullable(Type.Integer({ minimum: 1, maximum: 20, description: "км до площадки; null — 5 км" })),
      min_stars: Nullable(Type.Integer({ minimum: 0, maximum: 5, description: "null — любые (в PATCH 0 — любые)" })),
    },
    strict,
  ),
};

export const PreferencesSchema = Type.Object({
  ...prefFields,
  departures: Type.Array(DepartureSchema),
  onboarding_completed_at: Nullable(IsoTime),
  updated_at: IsoTime,
  version: Type.Integer(),
});
assertSame<Same<Static<typeof PreferencesSchema>, C.Preferences>>();

export const PreferencesPatchSchema = Type.Object(
  {
    interests: Type.Optional(prefFields.interests),
    geographies: Type.Optional(prefFields.geographies),
    strong_events_outside_geo: Type.Optional(prefFields.strong_events_outside_geo),
    event_formats: Type.Optional(prefFields.event_formats),
    budget: Type.Optional(prefFields.budget),
    search_horizon_months: Type.Optional(prefFields.search_horizon_months),
    notification_points_months: Type.Optional(prefFields.notification_points_months),
    flight_prefs: Type.Optional(prefFields.flight_prefs),
    hotel_prefs: Type.Optional(prefFields.hotel_prefs),
    version: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  strict,
);
assertSame<Same<Static<typeof PreferencesPatchSchema>, C.PreferencesPatch>>();

export const DeparturesRequestSchema = Type.Object(
  { airports: Type.Array(Type.String({ pattern: "^[A-Za-z]{3}$" }), { maxItems: 10 }) },
  strict,
);
assertSame<Same<Static<typeof DeparturesRequestSchema>, C.DeparturesRequest>>();

// ---------- Profile ----------
export const NotificationSettingsSchema = Type.Object({
  enabled: Type.Boolean(),
  quiet_hours: Nullable(Type.Object({ start: Type.String(), end: Type.String() })),
  digest_time: Type.String(),
  timezone: Type.String(),
});
assertSame<Same<Static<typeof NotificationSettingsSchema>, C.NotificationSettings>>();

export const ProfileSchema = Type.Object({
  user: UserSummarySchema,
  security: SecurityStateSchema,
  consent: ConsentStateSchema,
  preferences: PreferencesSchema,
  notifications: NotificationSettingsSchema,
});
assertSame<Same<Static<typeof ProfileSchema>, C.Profile>>();

export const SettingsPatchSchema = Type.Object(
  {
    locale: Type.Optional(Type.Union([Type.Literal("ru"), Type.Literal("en")])),
    notifications: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          quiet_hours: Type.Optional(Nullable(Type.Object({ start: Hhmm, end: Hhmm }, strict))),
          digest_time: Type.Optional(Hhmm),
          timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        },
        strict,
      ),
    ),
  },
  strict,
);
assertSame<Same<Static<typeof SettingsPatchSchema>, C.SettingsPatch>>();

// ---------- Security ----------
export const PinSetRequestSchema = Type.Object({ pin: PinString, current_pin: Type.Optional(PinString) }, strict);
assertSame<Same<Static<typeof PinSetRequestSchema>, C.PinSetRequest>>();

export const PinRemoveRequestSchema = Type.Object({ current_pin: PinString }, strict);
assertSame<Same<Static<typeof PinRemoveRequestSchema>, C.PinRemoveRequest>>();

export const PinResetRequestResponseSchema = Type.Object({ expires_in: Type.Integer() });
assertSame<Same<Static<typeof PinResetRequestResponseSchema>, C.PinResetRequestResponse>>();

export const PinResetConfirmRequestSchema = Type.Object(
  { code: Type.String({ pattern: "^[0-9]{6}$", description: "6-значный код из бота" }), new_pin: PinString },
  strict,
);
assertSame<Same<Static<typeof PinResetConfirmRequestSchema>, C.PinResetConfirmRequest>>();

export const BiometricEnableResponseSchema = Type.Object({ biometric_token: Type.String(), security: SecurityStateSchema });
assertSame<Same<Static<typeof BiometricEnableResponseSchema>, C.BiometricEnableResponse>>();

// ---------- Consent / legal ----------
export const PolicyDocumentSchema = Type.Object({
  version: Type.String(),
  purposes: Type.Array(
    Type.Object({ code: Type.String(), required: Type.Boolean(), title: Type.String(), description: Type.String() }),
  ),
  text: Type.String(),
});
assertSame<Same<Static<typeof PolicyDocumentSchema>, C.PolicyDocument>>();

export const PolicyQuerySchema = Type.Object(
  { lang: Type.Optional(Type.Union([Type.Literal("ru"), Type.Literal("en")], { default: "ru" })) },
  strict,
);

export const ConsentRequestSchema = Type.Object(
  {
    policy_version: Type.String({ minLength: 1, maxLength: 32 }),
    purposes: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 20, uniqueItems: true }),
    age_confirmed_18_plus: Type.Literal(true),
  },
  strict,
);
assertSame<Same<Static<typeof ConsentRequestSchema>, C.ConsentRequest>>();

// ---------- Account ----------
export const DeletionRequestSchema = Type.Object(
  { pin: Type.Optional(PinString), confirm_word: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })) },
  strict,
);
assertSame<Same<Static<typeof DeletionRequestSchema>, C.DeletionRequest>>();

export const DeletionResponseSchema = Type.Object({
  request_id: Type.String(),
  status: Type.Literal("REQUESTED"),
  domains: Type.Array(Type.String()),
});
assertSame<Same<Static<typeof DeletionResponseSchema>, C.DeletionResponse>>();

// ---------- Directory ----------
export const AirportSchema = Type.Object({
  iata: Type.String(),
  city: Type.String(),
  country: Type.String(),
  country_code: Type.String(),
  name: Type.String(),
});
assertSame<Same<Static<typeof AirportSchema>, C.Airport>>();

export const InterestCategorySchema = Type.Object({
  code: Type.String(),
  parent: Nullable(Type.String()),
  label: Label,
  icon: Type.String(),
});
assertSame<Same<Static<typeof InterestCategorySchema>, C.InterestCategory>>();

export const GeoOptionSchema = Type.Object({ level: GeoLevel, code: Nullable(Type.String()), label: Label });
assertSame<Same<Static<typeof GeoOptionSchema>, C.GeoOption>>();

export const AirportsQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ maxLength: 64 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
  },
  strict,
);

export const itemsOf = <T extends TSchema>(s: T) => Type.Object({ items: Type.Array(s) });

// ---------- Experience / Home ----------
const HomeSectionType = Type.Union([
  Type.Literal("event_carousel"),
  Type.Literal("watch_changes"),
  Type.Literal("news_carousel"),
  Type.Literal("ai_summary"),
  Type.Literal("catalog_link"),
]);
const Variant = Type.Union([Type.Literal("large"), Type.Literal("compact")]);

export const ExperienceConfigSchema = Type.Object({
  app: Type.Literal("miniapp"),
  version: Type.String(),
  theme: Type.Object({
    id: Type.String(),
    version: Type.String(),
    // только CSS-переменные (белый список experience-config); прочие ключи сериализатор отбрасывает
    tokens: Type.Record(Type.String({ pattern: "^--[A-Za-z0-9-]+$" }), Type.String()),
  }),
  home: Type.Object({
    welcome_mode: Type.Union([Type.Literal("first_visit_only"), Type.Literal("always"), Type.Literal("never")]),
    sections: Type.Array(Type.Object({ type: HomeSectionType, key: Type.String(), variant: Variant, enabled: Type.Boolean() })),
  }),
  flags: Type.Record(Type.String(), Type.Boolean()),
  hotel_rating_min: Type.Number(),
});
assertSame<Same<Static<typeof ExperienceConfigSchema>, C.ExperienceConfig>>();

// ---------- Events (спринт 3) ----------
const LifecycleStatus = Type.Union([
  Type.Literal("DISCOVERED"),
  Type.Literal("VERIFIED"),
  Type.Literal("ANNOUNCED"),
  Type.Literal("SALES_SOON"),
  Type.Literal("ON_SALE"),
  Type.Literal("LOW_INVENTORY"),
  Type.Literal("SOLD_OUT"),
  Type.Literal("RESALE"),
  Type.Literal("COMPLETED"),
  Type.Literal("POSTPONED"),
  Type.Literal("CANCELLED"),
]);
assertSame<Same<Static<typeof LifecycleStatus>, C.EventLifecycleStatus>>();

const SourceTier = Type.Union([
  Type.Literal("OFFICIAL_ORGANIZER"),
  Type.Literal("OFFICIAL_TICKET_PROVIDER"),
  Type.Literal("TRUSTED_STRUCTURED"),
  Type.Literal("TRUSTED_MEDIA"),
  Type.Literal("DISCOVERY_PAGE"),
]);
assertSame<Same<Static<typeof SourceTier>, C.SourceTier>>();

/** Деньги — строка-десятичное с ≤ 2 знаками (контракт), не число. */
const DecimalString = Type.String({ pattern: "^[0-9]{1,12}(\\.[0-9]{1,2})?$", examples: ["120.00"] });
const HttpsUrl = Type.String({ description: "только https" });

export const EventWhenSchema = Type.Object({
  local_date: Type.String({ description: "YYYY-MM-DD — дата по месту события" }),
  local_time: Nullable(Type.String({ description: "HH:MM:SS по месту события" })),
  utc: Nullable(IsoTime),
  timezone: Nullable(Type.String({ description: "IANA, часовой пояс события" })),
});
assertSame<Same<Static<typeof EventWhenSchema>, C.EventWhen>>();

export const EventMediaSchema = Type.Object(
  {
    url: HttpsUrl,
    width: Nullable(Type.Integer()),
    height: Nullable(Type.Integer()),
    ratio: Nullable(Type.String()),
    provenance: Type.Object({
      provider: Type.String(),
      source_url: HttpsUrl,
      fetched_at: IsoTime,
      rights: Type.Union([Type.Literal("provider_api"), Type.Literal("official_organizer"), Type.Literal("official_site")], {
        description: "provider_api — API провайдера (Ticketmaster); official_site — официальный сайт AI-источника (aiweb.*)",
      }),
    }),
  },
  { description: "Медиа только из источника, с provenance; null → нейтральный fallback категории в UI" },
);
assertSame<Same<Static<typeof EventMediaSchema>, C.EventMedia>>();

export const EventPriceRangeSchema = Type.Object(
  {
    min: DecimalString,
    max: DecimalString,
    currency: Type.String({ pattern: "^[A-Z]{3}$" }),
    fetched_at: IsoTime,
    source: Type.Object({ provider: Type.String(), url: HttpsUrl }),
  },
  { description: "Диапазон цен билетов — факт провайдера (TG-FR-029), не стоимость поездки" },
);
assertSame<Same<Static<typeof EventPriceRangeSchema>, C.EventPriceRange>>();

const eventCommon = {
  event_id: Type.String({ description: "UUID" }),
  title: Type.String(),
  categories: Type.Array(Type.String()),
  start: EventWhenSchema,
  end: Nullable(EventWhenSchema),
  online: Type.Boolean(),
  quality_score: Type.Integer({ minimum: 0, maximum: 100 }),
  price_range: Nullable(EventPriceRangeSchema),
  media: Nullable(EventMediaSchema),
  updated_at: IsoTime,
  is_past: Type.Boolean({
    description:
      "5.1: событие прошло (coalesce(end, start).local_date < сегодня в часовом поясе события) — считает каталог. " +
      "UI: «Событие прошло» вместо статуса продаж, без кнопки покупки",
  }),
};

export const EventCardSchema = Type.Object({
  ...eventCommon,
  venue: Nullable(Type.Object({ name: Type.String(), city: Type.String(), country_code: Type.String() })),
  lifecycle: Type.Object({ status: LifecycleStatus, changed_at: IsoTime }),
});
assertSame<Same<Static<typeof EventCardSchema>, C.EventCard>>();

export const EventDetailViewSchema = Type.Object({
  ...eventCommon,
  venue: Nullable(
    Type.Object({
      name: Type.String(),
      city: Type.String(),
      country_code: Type.String(),
      address: Nullable(Type.String()),
      lat: Nullable(Type.String()),
      lon: Nullable(Type.String()),
      map_url: HttpsUrl,
    }),
  ),
  official_url: HttpsUrl,
  sources: Type.Array(
    Type.Object({
      provider: Type.String({ description: "ticketmaster | fixture | aiweb.<slug> (AI-поиск на официальном сайте)" }),
      name: Nullable(Type.String({ maxLength: 120, description: "имя источника из реестра (aiweb.*) или «Ticketmaster»" })),
      tier: SourceTier,
      url: HttpsUrl,
      fetched_at: IsoTime,
    }),
  ),
  lifecycle: Type.Object({
    status: LifecycleStatus,
    changed_at: IsoTime,
    basis: Type.Object({
      fact: Type.String(),
      source_url: Nullable(HttpsUrl),
      provider: Nullable(Type.String()),
      observed_at: IsoTime,
    }),
  }),
  lifecycle_track: Type.Array(Type.Object({ status: LifecycleStatus, reached: Type.Boolean(), current: Type.Boolean() })),
  media_all: Type.Array(EventMediaSchema),
  first_seen_at: IsoTime,
});
// деталь каталога; recommendation, watch и reaction добавляет маршрут (EventDetailPersonalSchema = полный C.EventDetailView)
assertSame<Same<Static<typeof EventDetailViewSchema>, Omit<C.EventDetailView, "recommendation" | "watch" | "reaction">>>();

export const EventPageSchema = Type.Object({ items: Type.Array(EventCardSchema), next_cursor: Nullable(Type.String()) });
assertSame<Same<Static<typeof EventPageSchema>, C.Page<C.EventCard>>>();

const ISO_DATE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";
const IsoDate = Type.String({ pattern: ISO_DATE, description: "YYYY-MM-DD (локальная дата события)" });
const EventSort = Type.Union([Type.Literal("soonest"), Type.Literal("newest"), Type.Literal("quality")]);
assertSame<Same<Static<typeof EventSort>, C.EventSort>>();

/** Код таксономии интересов: «sport», «sport.motorsport», «music.pop_rock» (как CATEGORY_PATTERN event-catalog). */
export const CATEGORY_CODE = "^[a-z][a-z_]{0,31}(\\.[a-z][a-z_]{0,31})?$";

/** Не больше стран в одном запросе каталога (как у event-catalog). */
export const MAX_COUNTRIES = 20;

/** Фильтры каталога — общие для GET /v1/events и GET /v1/events/facets. */
const eventFilters = {
  q: Type.Optional(Type.String({ maxLength: 100, description: "название, площадка, город" })),
  category: Type.Optional(
    Type.String({ pattern: CATEGORY_CODE, maxLength: 64, description: "код таксономии (с потомками); other — события без категории" }),
  ),
  // повторяющийся параметр (country=UZ&country=KZ) приходит массивом, одиночный приводится к массиву (coerceTypes "array");
  // элемент — ISO-2 или список через запятую (country=UZ,KZ). Всего стран после разбора ≤ MAX_COUNTRIES (проверка в маршруте).
  country: Type.Optional(
    Type.Array(Type.String({ pattern: "^[A-Za-z]{2}(,[A-Za-z]{2}){0,19}$", maxLength: 59 }), {
      maxItems: MAX_COUNTRIES,
      description: `ISO-3166 alpha-2; несколько стран — повтором параметра или через запятую, до ${MAX_COUNTRIES}`,
    }),
  ),
  city: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  date_from: Type.Optional(IsoDate),
  date_to: Type.Optional(IsoDate),
  has_tickets: Type.Optional(Type.Boolean({ description: "ON_SALE, LOW_INVENTORY, RESALE" })),
  online: Type.Optional(Type.Boolean()),
};

export const EventsQuerySchema = Type.Object(
  {
    ...eventFilters,
    sort: Type.Optional(EventSort),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  strict,
);

/** Окно чипа «В этом месяце» не длиннее (month_to − month_from, дней; как у event-catalog). */
export const MAX_MONTH_WINDOW_DAYS = 31;

export const EventFacetsQuerySchema = Type.Object(
  {
    ...eventFilters,
    // окно чипа «В этом месяце» в календаре пользователя (Mini App: сегодня .. последний день месяца) — this_month
    // считается по нему, а не по UTC; оба или ни одного, month_from ≤ month_to, ≤ 31 дня (проверка в маршруте)
    month_from: Type.Optional(Type.String({ pattern: ISO_DATE, description: "YYYY-MM-DD — начало окна this_month (вместе с month_to)" })),
    month_to: Type.Optional(Type.String({ pattern: ISO_DATE, description: "YYYY-MM-DD — конец окна this_month (вместе с month_from)" })),
  },
  strict,
);

const FacetCount = Type.Integer({ minimum: 0 });
export const EventFacetsSchema = Type.Object(
  {
    total: FacetCount,
    this_month: FacetCount,
    has_tickets: FacetCount,
    online: FacetCount,
    categories: Type.Record(Type.String(), FacetCount, { description: "корневой код таксономии → n; other — без категории" }),
    countries: Type.Record(Type.String(), FacetCount, { description: "ISO-2 → n" }),
  },
  { description: "Счётчики быстрых фильтров: каждый учитывает остальные активные фильтры, кроме своего измерения" },
);
assertSame<Same<Static<typeof EventFacetsSchema>, C.EventFacets>>();

export const EventParamsSchema = Type.Object(
  { eventId: Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", description: "UUID события" }) },
  strict,
);

// ---------- Support ----------
const TicketStatus = Type.Union([
  Type.Literal("NEW"),
  Type.Literal("IN_PROGRESS"),
  Type.Literal("WAITING_CUSTOMER"),
  Type.Literal("RESOLVED"),
  Type.Literal("CLOSED"),
]);
const TicketCategory = Type.Union([
  Type.Literal("EVENT_RECOMMENDATION"),
  Type.Literal("TICKET_SOURCE"),
  Type.Literal("FLIGHT"),
  Type.Literal("HOTEL"),
  Type.Literal("PRICE"),
  Type.Literal("SUBSCRIPTION_PAYMENT"),
  Type.Literal("ACCOUNT"),
  Type.Literal("PERSONAL_DATA"),
  Type.Literal("BUG"),
  Type.Literal("OTHER"),
]);
assertSame<Same<Static<typeof TicketCategory>, C.TicketCategory>>();

const TicketContextFields = {
  event_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  offer_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  provider_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  deeplink: Type.Optional(Type.String({ pattern: "^https://", maxLength: 2048, description: "только https" })),
  price_snapshot: Type.Optional(
    Type.Object(
      {
        // деньги — строка-десятичное с ≤ 2 знаками ("850.00"), как Decimal в support (ревью T3); JSON-число → 422
        amount: Type.String({ pattern: "^(0|[1-9][0-9]{0,9})(\\.[0-9]{1,2})?$", examples: ["850.00"] }),
        currency: Type.Literal("USD"),
        fetched_at: Type.String({ maxLength: 40 }),
      },
      strict,
    ),
  ),
  event_title: Type.Optional(Type.String({ maxLength: 300 })),
  client_version: Type.String({ minLength: 1, maxLength: 64 }),
};
export const TicketContextSchema = Type.Object(TicketContextFields, strict);
assertSame<Same<Static<typeof TicketContextSchema>, C.TicketContext>>();

export const TicketMessageSchema = Type.Object({
  message_id: Type.String(),
  sender_type: Type.Union([Type.Literal("user"), Type.Literal("operator"), Type.Literal("system")]),
  author_name: Nullable(Type.String()),
  text: Type.String(),
  created_at: IsoTime,
});
assertSame<Same<Static<typeof TicketMessageSchema>, C.TicketMessage>>();

const ticketSummaryFields = {
  ticket_id: Type.String(),
  number: Type.String(),
  category: TicketCategory,
  subject: Type.String(),
  status: TicketStatus,
  created_at: IsoTime,
  updated_at: IsoTime,
  last_message_at: IsoTime,
  unread_operator_replies: Type.Integer(),
};
export const TicketSummarySchema = Type.Object(ticketSummaryFields);
assertSame<Same<Static<typeof TicketSummarySchema>, C.TicketSummary>>();

export const TicketSchema = Type.Object({
  ...ticketSummaryFields,
  context: Nullable(Type.Object(TicketContextFields)),
  sla_first_response_at: Nullable(IsoTime),
  messages: Type.Array(TicketMessageSchema),
  status_history: Type.Array(Type.Object({ status: TicketStatus, at: IsoTime })),
});
assertSame<Same<Static<typeof TicketSchema>, C.Ticket>>();

export const CreateTicketRequestSchema = Type.Object(
  {
    category: TicketCategory,
    subject: Type.String({ minLength: 3, maxLength: 120 }),
    message: Type.String({ minLength: 1, maxLength: 4000 }),
    context: Type.Optional(TicketContextSchema),
  },
  strict,
);
assertSame<Same<Static<typeof CreateTicketRequestSchema>, C.CreateTicketRequest>>();

export const TicketMessageRequestSchema = Type.Object({ text: Type.String({ minLength: 1, maxLength: 4000 }) }, strict);
assertSame<Same<Static<typeof TicketMessageRequestSchema>, C.TicketMessageRequest>>();

export const TicketPageSchema = Type.Object({ items: Type.Array(TicketSummarySchema), next_cursor: Nullable(Type.String()) });
assertSame<Same<Static<typeof TicketPageSchema>, C.Page<C.TicketSummary>>>();

export const TicketListQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  strict,
);

/** Обращение адресуется UUID или номером «TCK-3081» (deep link бота startapp=ticket_TCK-3081). */
export const TicketParamsSchema = Type.Object(
  {
    ticket_id: Type.String({
      pattern: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|TCK-[0-9]{1,12})$",
      description: "UUID обращения или номер TCK-NNNN",
    }),
  },
  strict,
);

export const SupportCategorySchema = Type.Object({ code: TicketCategory, label: Label, available: Type.Boolean() });

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ---------- Offers (спринт 5) ----------
// Ответ offers — недоверенные данные: схема ниже — граница. Строки ограничены по длине, ссылки — только https
// (хост без userinfo, без пробелов/кавычек), деньги — строки-десятичные, коды — перечисления контракта.
// Проверка — TypeCompiler (src/offers.ts), лишние поля удаляются Value.Clean, наружу — сериализация по схеме.

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
/** https://host[:port][/?#…] — хост без userinfo («@» в хосте невозможен), без пробелов, кавычек, < > \. */
export const HTTPS_URL_PATTERN = "^https://[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})(?::[0-9]{1,5})?(?:[/?#][^\\s\"'<>\\\\]*)?$";
const OfferUrl = Type.String({ pattern: HTTPS_URL_PATTERN, maxLength: 2048, description: "только https" });
const OfferTime = Type.String({
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$",
  maxLength: 40,
  description: "ISO-8601 (UTC с Z или со смещением)",
});
const OfferDate = Type.String({ pattern: ISO_DATE, maxLength: 10, description: "YYYY-MM-DD по месту события" });
const MONEY_OPTS = { pattern: "^[0-9]{1,12}(\\.[0-9]{1,2})?$", maxLength: 15 } as const;
const Money = Type.String({ ...MONEY_OPTS, examples: ["844.00"] });
const Rating = Type.String({ pattern: "^(10|[0-9])(\\.[0-9]{1,2})?$", maxLength: 5, examples: ["8.9"] });
const Coord = Type.String({ pattern: "^-?[0-9]{1,3}(\\.[0-9]{1,10})?$", maxLength: 16 });
const Iata = Type.String({ pattern: "^[A-Z]{3}$" });
const Country = Type.String({ pattern: "^[A-Z]{2}$" });
const Text = (max: number) => Type.String({ minLength: 1, maxLength: max });
const NonNegInt = (max: number) => Type.Integer({ minimum: 0, maximum: max });

const OfferTierSchema = Type.Union([Type.Literal("economy"), Type.Literal("comfort"), Type.Literal("premium")]);
assertSame<Same<Static<typeof OfferTierSchema>, C.OfferTier>>();

export const MapLinksSchema = Type.Object({ yandex: OfferUrl, google: OfferUrl, osm: OfferUrl, dgis: OfferUrl });
assertSame<Same<Static<typeof MapLinksSchema>, C.MapLinks>>();

const UnavailableReason = Type.Union([
  Type.Literal("NO_PRICE"),
  Type.Literal("NO_DEPARTURE"),
  Type.Literal("NO_DIRECT"),
  Type.Literal("NO_HOTEL"),
  Type.Literal("NO_LOCATION"),
  Type.Literal("PROVIDER_UNAVAILABLE"),
  Type.Literal("NOT_CONFIGURED"),
  Type.Literal("ROUTE_NOT_SUPPORTED"), // 5.2: поставщик перелётов не знает код места маршрута
]);
assertSame<Same<Static<typeof UnavailableReason>, C.OfferComponentUnavailableReason>>();

export const OfferComponentUnavailableSchema = Type.Object({
  status: Type.Literal("unavailable"),
  reason: UnavailableReason,
  // 5.2: у перелёта с ROUTE_NOT_SUPPORTED — поиск Aviasales с маршрутом и датами
  search_url: Type.Optional(OfferUrl),
});
assertSame<Same<Static<typeof OfferComponentUnavailableSchema>, C.OfferComponentUnavailable>>();

export const OfferTicketSchema = Type.Object({
  status: Type.Literal("ok"),
  price_per_person: Money,
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
  in_total: Type.Boolean(),
  provider: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" }),
  deeplink: OfferUrl,
  fetched_at: OfferTime,
  fx: Nullable(
    Type.Object(
      {
        price_per_person_usd: Money,
        rate: Type.String({
          // gateway отдаёт до 12 знаков после запятой (KGS "0.011435318", UZS "0.000078912345")
          pattern: "^(?=[0-9.]*[1-9])[0-9]{1,8}(\\.[0-9]{1,12})?$",
          maxLength: 24,
          description: "курс ЦБ: положительная десятичная строка, ≤ 8 цифр до и ≤ 12 после запятой",
        }),
        date: OfferDate,
        source: Type.Literal("cbu.uz"),
      },
      { description: "5.1: цена не в USD пересчитана по курсу ЦБ (in_total = true); null — цена в USD или курса нет" },
    ),
  ),
});
assertSame<Same<Static<typeof OfferTicketSchema>, C.OfferTicket>>();

export const OfferFlightSchema = Type.Object({
  status: Type.Literal("ok"),
  provider: Type.Literal("aviasales"),
  origin: Iata,
  destination: Iata,
  depart_at: OfferTime,
  return_at: Nullable(OfferTime),
  airline: Nullable(Type.String({ pattern: "^[A-Z0-9]{2,3}$" })),
  flight_number: Nullable(Type.String({ pattern: "^[A-Za-z0-9]{1,8}$" })),
  transfers: NonNegInt(10),
  return_transfers: Nullable(NonNegInt(10)),
  duration_minutes: Nullable(NonNegInt(10_000)),
  duration_back_minutes: Nullable(NonNegInt(10_000)),
  price_per_person: Money,
  total: Money,
  deeplink: OfferUrl,
  fetched_at: OfferTime,
  dates_shifted: Type.Boolean(),
});
assertSame<Same<Static<typeof OfferFlightSchema>, C.OfferFlight>>();

const hotelCommon = {
  provider: Type.Literal("liteapi"),
  hotel_id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
  name: Text(300),
  stars: Nullable(Type.Integer({ minimum: 0, maximum: 5 })),
  rating: Rating,
  review_count: Nullable(NonNegInt(10_000_000)),
  distance_m: NonNegInt(1_000_000),
  lat: Coord,
  lon: Coord,
  photo_url: Nullable(OfferUrl),
  refundable: Nullable(Type.Boolean()),
  board: Nullable(Text(300)),
  deeplink: OfferUrl,
  map: MapLinksSchema,
  fetched_at: OfferTime,
};

export const OfferHotelSchema = Type.Object({
  status: Type.Literal("ok"),
  ...hotelCommon,
  nights: Type.Integer({ minimum: 1, maximum: 60 }),
  rooms: Type.Integer({ minimum: 1, maximum: 10 }),
  total: Money,
});
assertSame<Same<Static<typeof OfferHotelSchema>, C.OfferHotel>>();

const Missing = Type.Union([Type.Literal("ticket"), Type.Literal("flight"), Type.Literal("hotel")]);

// ---------- Исправление 5.1: бюджет пользователя (FEEDBACK_5_1 §B) ----------
const BudgetFitSchema = Type.Union([Type.Literal("within"), Type.Literal("over"), Type.Literal("unknown")], {
  description: "within — укладывается в budget.max; over — превышает (over_by); unknown — нет бюджета или сумма неполная",
});
assertSame<Same<Static<typeof BudgetFitSchema>, C.BudgetFit>>();

export const TripBudgetSchema = Type.Object(
  { min: Nullable(Money), max: Nullable(Money) },
  { description: "Бюджет на 1 человека за поездку, USD (из профиля)" },
);
assertSame<Same<Static<typeof TripBudgetSchema>, C.TripBudget>>();

const OverBy = Nullable(Type.String({ ...MONEY_OPTS, description: "на человека сверх budget.max; только при budget_fit = over" }));
const BudgetExcludes = Type.Array(Missing, {
  maxItems: 3,
  uniqueItems: true,
  description: "6.1: что не учтено в сравнении с бюджетом (нет цены) — «в бюджете (без учёта билета)»; [] — сумма полная или unknown",
});
const budgetInfo = { budget_fit: BudgetFitSchema, over_by: OverBy, budget_excludes: BudgetExcludes };

export const OfferSchema = Type.Object({
  offer_id: Type.String({ pattern: UUID_PATTERN }),
  tier: OfferTierSchema,
  status: Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("unavailable")]),
  ticket: Type.Union([OfferTicketSchema, OfferComponentUnavailableSchema]),
  flight: Type.Union([OfferFlightSchema, OfferComponentUnavailableSchema]),
  hotel: Type.Union([OfferHotelSchema, OfferComponentUnavailableSchema]),
  totals: Type.Object({
    total: Money,
    per_person: Money,
    currency: Type.Literal("USD"),
    missing: Type.Array(Missing, { maxItems: 3, uniqueItems: true }),
  }),
  expires_at: OfferTime,
  ...budgetInfo,
});
assertSame<Same<Static<typeof OfferSchema>, C.Offer>>();

export const NearbyHotelSchema = Type.Object({
  ...hotelCommon,
  price_total: Money,
  per_person_share: Type.String({ ...MONEY_OPTS, description: "price_total / travellers" }),
  ...budgetInfo,
});
assertSame<Same<Static<typeof NearbyHotelSchema>, C.NearbyHotel>>();

export const NearbyPoiSchema = Type.Object({
  provider: Type.Literal("osm"),
  osm_type: Type.Union([Type.Literal("node"), Type.Literal("way"), Type.Literal("relation")]),
  osm_id: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  name: Text(300),
  kind: Type.String({ pattern: "^[a-z][a-z_]{0,31}$" }),
  lat: Coord,
  lon: Coord,
  distance_m: NonNegInt(1_000_000),
  url: OfferUrl,
  website: Nullable(OfferUrl),
  map: MapLinksSchema,
});
assertSame<Same<Static<typeof NearbyPoiSchema>, C.NearbyPoi>>();

export const OFFER_NOTES = [
  "FLIGHT_DATES_SHIFTED",
  "TICKET_NOT_USD",
  "TICKET_FX_CONVERTED",
  "LOCATION_APPROX",
  "HOTEL_PRICES_PARTIAL",
  "HOTEL_SEARCH_WIDENED",
  "HOTEL_ALTERNATIVES_NONE",
  "HOTEL_SEARCH_INCOMPLETE",
  "BUDGET_NONE_WITHIN",
  "HOTEL_PREFS_NONE",
  "HOTEL_PREFS_PENDING",
] as const;
const OfferNoteSchema = Type.Union([
  Type.Literal("FLIGHT_DATES_SHIFTED"),
  Type.Literal("TICKET_NOT_USD"),
  Type.Literal("TICKET_FX_CONVERTED"),
  Type.Literal("LOCATION_APPROX"),
  Type.Literal("HOTEL_PRICES_PARTIAL"),
  Type.Literal("HOTEL_SEARCH_WIDENED"),
  Type.Literal("HOTEL_ALTERNATIVES_NONE"),
  Type.Literal("HOTEL_SEARCH_INCOMPLETE"),
  Type.Literal("BUDGET_NONE_WITHIN"),
  Type.Literal("HOTEL_PREFS_NONE"),
  Type.Literal("HOTEL_PREFS_PENDING"),
]);

// 6.1: ступень поиска отелей (рядом с площадкой мало отелей — радиус и порог оценки расширены)
export const HotelSearchSchema = Type.Object({
  radius_m: NonNegInt(20_000),
  rating_min: Rating,
  base_radius_m: NonNegInt(20_000),
  base_rating_min: Rating,
  widened: Type.Boolean(),
  found: NonNegInt(1000),
  // 6.3: звёзды ступени и базы; база — из настроек пользователя
  min_stars: Nullable(NonNegInt(5)),
  base_min_stars: Nullable(NonNegInt(5)),
  from_prefs: Type.Boolean(),
});
assertSame<Same<Static<typeof HotelSearchSchema>, C.HotelSearchInfo>>();
assertSame<Same<Static<typeof OfferNoteSchema>, C.OfferNote>>();

export const MAX_HOTELS_NEARBY = 8;
export const MAX_POI = 10;

export const OfferSetViewSchema = Type.Object({
  event_id: Type.String({ pattern: UUID_PATTERN }),
  generated_at: OfferTime,
  expires_at: OfferTime,
  trip: Type.Object({
    kind: Type.Union([Type.Literal("trip"), Type.Literal("ticket_only"), Type.Literal("not_available")]),
    reason: Type.Union([
      Type.Null(),
      Type.Literal("ONLINE_EVENT"),
      Type.Literal("SAME_CITY"),
      Type.Literal("EVENT_POSTPONED"),
      Type.Literal("EVENT_CANCELLED"),
      Type.Literal("EVENT_PAST"),
      Type.Literal("NO_DESTINATION"),
    ]),
    destination: Nullable(
      Type.Object({
        city: Text(200),
        country_code: Country,
        iata: Nullable(Iata),
        venue: Nullable(
          Type.Object({
            name: Text(300),
            lat: Coord,
            lon: Coord,
            precision: Type.Union([Type.Literal("venue"), Type.Literal("city")]),
            map: MapLinksSchema,
          }),
        ),
      }),
    ),
    out_date: Nullable(OfferDate),
    back_date: Nullable(OfferDate),
    nights: Nullable(Type.Integer({ minimum: 0, maximum: 60 })),
  }),
  travellers: Type.Integer({ minimum: 1, maximum: 6 }),
  rooms: Type.Integer({ minimum: 0, maximum: 10 }),
  departure: Nullable(
    Type.Object({ iata: Iata, city: Text(200), chosen_by: Type.Union([Type.Literal("cheapest"), Type.Literal("user")]) }),
  ),
  tiers: Nullable(Type.Object({ economy: OfferSchema, comfort: OfferSchema, premium: OfferSchema })),
  alternative: Nullable(Type.Object({ iata: Iata, city: Text(200), tier: OfferTierSchema, saving_per_person: Money })),
  hotels_nearby: Type.Array(NearbyHotelSchema, { maxItems: MAX_HOTELS_NEARBY }),
  poi: Type.Array(NearbyPoiSchema, { maxItems: MAX_POI }),
  rating_min: Rating,
  notes: Type.Array(OfferNoteSchema, { maxItems: OFFER_NOTES.length, uniqueItems: true }),
  budget: Nullable(TripBudgetSchema),
  recommended_tier: Nullable(OfferTierSchema),
  hotel_chosen_by: Type.Union([Type.Literal("rules"), Type.Literal("user")]),
  hotel_search: Nullable(HotelSearchSchema),
});
assertSame<Same<Static<typeof OfferSetViewSchema>, C.OfferSetView>>();

export const OFFER_TRAVELLERS_MAX = 6;
const Travellers = Type.Integer({ minimum: 1, maximum: OFFER_TRAVELLERS_MAX, description: "путешественников 1..6" });

export const OffersQuerySchema = Type.Object(
  {
    travellers: Type.Optional(
      Type.Integer({ minimum: 1, maximum: OFFER_TRAVELLERS_MAX, default: 1, description: "путешественников 1..6 (1)" }),
    ),
  },
  strict,
);

const KeepHotelId = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" });

/** 6.3: настройки отеля для одной поездки (поверх профиля); значения — как у чипов профиля. */
export const HotelFiltersSchema = Type.Object(
  {
    rating_min: Type.Optional(Nullable(Type.Union([0, 7, 7.5, 8, 8.5, 9].map((n) => Type.Literal(n)) as [TLiteral<number>, ...TLiteral<number>[]]))),
    max_distance_km: Type.Optional(Nullable(Type.Union([1, 3, 5, 10, 15].map((n) => Type.Literal(n)) as [TLiteral<number>, ...TLiteral<number>[]]))),
    min_stars: Type.Optional(Nullable(Type.Union([0, 3, 4, 5].map((n) => Type.Literal(n)) as [TLiteral<number>, ...TLiteral<number>[]]))),
  },
  { ...strict, description: "6.3: оценка гостей (0 — любая), расстояние до площадки, км, звёзды (0 — любые); null — как в профиле" },
);
assertSame<Same<Static<typeof HotelFiltersSchema>, C.OfferHotelFilters>>();

export const OfferRecalculateRequestSchema = Type.Object(
  {
    travellers: Travellers,
    departure_iata: Type.Optional(Nullable(Type.String({ pattern: "^[A-Z]{3}$", description: "IATA города вылета" }))),
    direct_only: Type.Optional(Type.Boolean()),
    near_venue: Type.Optional(Type.Boolean({ description: "отель не дальше 1 км от площадки" })),
    extra_nights: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
    hotel_id: Type.Optional(
      Nullable(
        Type.String({
          minLength: 1,
          maxLength: 64,
          pattern: "^[A-Za-z0-9_-]+$",
          description: "5.1: отель из hotels_nearby — для всех тарифов; null — подбор по правилам",
        }),
      ),
    ),
    keep_hotels: Type.Optional(
      Nullable(
        Type.Object(
          { economy: Type.Optional(KeepHotelId), comfort: Type.Optional(KeepHotelId), premium: Type.Optional(KeepHotelId) },
          { ...strict, description: "5.2: отели тарифов прошлого расчёта (смена числа путешественников) — тариф остаётся на своём отеле" },
        ),
      ),
    ),
    hotel_filters: Type.Optional(Nullable(HotelFiltersSchema)),
  },
  strict,
);
assertSame<Same<Static<typeof OfferRecalculateRequestSchema>, C.OfferRecalculateRequest>>();

// ======================================================================================================
// Спринт 6 — персонализация, Watch, новости (docs/sprint6/INTERNAL_API.md §6; типы bff.ts «Спринт 6»)
// ======================================================================================================
// Ответы recommendations / watch / news — недоверенные данные: схемы ниже — граница (строгие длины, шаблоны,
// перечисления, ссылки только https). Проверка — Ajv в src/personal.ts, наружу — проекция и сериализация по схеме.

const Uuid = Type.String({ pattern: UUID_PATTERN, maxLength: 36 });
const SignedMoney = Type.String({ pattern: "^-?[0-9]{1,12}(\\.[0-9]{1,2})?$", maxLength: 16 });
const SignedPct = Type.String({ pattern: "^-?[0-9]{1,6}(\\.[0-9]{1,4})?$", maxLength: 12 });

export const REASON_CODES = [
  "INTEREST_MATCH",
  "ENTITY_MATCH",
  "IN_GEOGRAPHY",
  "FITS_BUDGET",
  "OVER_BUDGET",
  "HIGH_SIGNIFICANCE",
  "SALES_OPEN",
  "NEW",
  "MORE_LIKE_THIS",
] as const;
const ReasonCodeSchema = Type.Union([
  Type.Literal("INTEREST_MATCH"),
  Type.Literal("ENTITY_MATCH"),
  Type.Literal("IN_GEOGRAPHY"),
  Type.Literal("FITS_BUDGET"),
  Type.Literal("OVER_BUDGET"),
  Type.Literal("HIGH_SIGNIFICANCE"),
  Type.Literal("SALES_OPEN"),
  Type.Literal("NEW"),
  Type.Literal("MORE_LIKE_THIS"),
]);
assertSame<Same<Static<typeof ReasonCodeSchema>, C.ReasonCode>>();

/** Ключ параметра причины (тексты строит UI по коду): латиница, ≤ 32. Проверяется в src/personal.ts. */
export const REASON_PARAM_KEY = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_REASON_PARAMS = 8;
export const MAX_REASONS = 5;

export const RecommendationReasonSchema = Type.Object({
  code: ReasonCodeSchema,
  params: Type.Record(Type.String(), Type.Union([Type.String({ maxLength: 120 }), Type.Number()]), {
    description: "параметры текста причины (категория, сущность, страна, сумма); ключи ^[a-z][a-z0-9_]{0,31}$, ≤ 8",
  }),
  kind: Type.Union([Type.Literal("fact"), Type.Literal("estimate"), Type.Literal("recommendation")]),
});
assertSame<Same<Static<typeof RecommendationReasonSchema>, C.RecommendationReason>>();

const Score = Type.Number({ minimum: 0, maximum: 100 });
export const RecommendationFactorsSchema = Type.Object({
  interests: Score,
  geography: Score,
  budget: Nullable(Score),
  significance: Score,
  freshness: Score,
  // штраф «Не интересно» может уводить фактор обратной связи в минус
  feedback: Type.Number({ minimum: -100, maximum: 100 }),
});

export const RecommendationSchema = Type.Object({
  score: Score,
  reasons: Type.Array(RecommendationReasonSchema, { maxItems: MAX_REASONS }),
  factors: Type.Optional(RecommendationFactorsSchema),
});
assertSame<Same<Static<typeof RecommendationSchema>, C.Recommendation>>();

const WatchStatus = Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("ended")]);

/** Кнопка Watch на карточке/детали: событие на слежении (null — нет или сервис watch недоступен). */
export const WatchRefSchema = Type.Object({ watch_id: Uuid, status: WatchStatus });
export type WatchRef = C.WatchRef;
assertSame<Same<Static<typeof WatchRefSchema>, C.WatchRef>>();

/** Карточка рельса Home: best_for_you += recommendation; обе рельсы += watch. */
export const HomeEventCardSchema = Type.Object({
  ...EventCardSchema.properties,
  recommendation: Type.Optional(Nullable(RecommendationSchema)),
  watch: Type.Optional(Nullable(WatchRefSchema)),
});
export type HomeEventCard = C.EventCard; // recommendation?/watch? — в контракте EventCard (спринт 6)
assertSame<Same<Static<typeof HomeEventCardSchema>, HomeEventCard>>();

/** GET /v1/events: карточки += watch (watches:by-events; watch недоступен — поля нет). */
export const EventCardPageSchema = Type.Object({ items: Type.Array(HomeEventCardSchema), next_cursor: Nullable(Type.String()) });
assertSame<Same<Static<typeof EventCardPageSchema>, C.Page<C.EventCard>>>();

export const EventReactionSchema = Type.Union([Type.Literal("more_like_this"), Type.Literal("not_interested")]);
assertSame<Same<Static<typeof EventReactionSchema>, C.EventReaction>>();

/** GET /v1/events/{id}: += recommendation {score, reasons, factors} | null, watch {watch_id, status} | null, reaction. */
export const EventDetailPersonalSchema = Type.Object({
  ...EventDetailViewSchema.properties,
  recommendation: Nullable(RecommendationSchema),
  watch: Nullable(WatchRefSchema),
  reaction: Nullable(EventReactionSchema),
});
export type EventDetailPersonal = C.EventDetailView;
assertSame<Same<Static<typeof EventDetailPersonalSchema>, EventDetailPersonal>>();

export const ReactionRequestSchema = Type.Object(
  {
    event_id: Type.String({ pattern: UUID_PATTERN, description: "UUID события" }),
    reaction: Type.Union([Type.Literal("more"), Type.Literal("less")], { description: "more — «Больше такого», less — «Не интересно»" }),
    undo: Type.Optional(Type.Boolean({ description: "true — снять реакцию" })),
  },
  strict,
);
assertSame<Same<Static<typeof ReactionRequestSchema>, C.ReactionRequest>>();

// ---------- Watch ----------
export const WatchDimensionsSchema = Type.Object({
  tickets: Type.Boolean(),
  price: Type.Boolean(),
  flight: Type.Boolean(),
  hotel: Type.Boolean(),
  status: Type.Boolean(),
  news: Type.Boolean(),
});
assertSame<Same<Static<typeof WatchDimensionsSchema>, C.WatchDimensions>>();

export const WatchSnapshotSchema = Type.Object({
  taken_at: OfferTime,
  lifecycle_status: LifecycleStatus,
  per_person_usd: Nullable(Money),
  total_usd: Nullable(Money),
  flight_usd: Nullable(Money),
  hotel_usd: Nullable(Money),
  ticket_status: Type.Union([
    Type.Literal("on_sale"),
    Type.Literal("low_inventory"),
    Type.Literal("sold_out"),
    Type.Literal("resale"),
    Type.Literal("not_on_sale"),
    Type.Literal("unknown"),
  ]),
  offer_id: Nullable(Uuid),
});
assertSame<Same<Static<typeof WatchSnapshotSchema>, C.WatchSnapshot>>();

export const WatchChangeSchema = Type.Object({
  change_id: Uuid,
  type: Type.Union([
    Type.Literal("price_drop"),
    Type.Literal("price_rise"),
    Type.Literal("lifecycle"),
    Type.Literal("tickets"),
    Type.Literal("flight"),
    Type.Literal("hotel"),
  ]),
  severity: Type.Union([Type.Literal("critical"), Type.Literal("normal")]),
  before: Nullable(Type.String({ maxLength: 32, pattern: "^[A-Za-z0-9_.-]*$", description: "цена \"844.00\" или статус" })),
  after: Nullable(Type.String({ maxLength: 32, pattern: "^[A-Za-z0-9_.-]*$" })),
  delta_usd: Nullable(SignedMoney),
  delta_pct: Nullable(SignedPct),
  source: Type.Object({
    provider: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" }),
    url: Nullable(OfferUrl),
    observed_at: OfferTime,
  }),
  detected_at: OfferTime,
  notified: Type.Union([Type.Literal("immediate"), Type.Literal("digest"), Type.Literal("suppressed"), Type.Literal("none")]),
});
assertSame<Same<Static<typeof WatchChangeSchema>, C.WatchChange>>();

const Threshold = Type.Union([Type.Literal(5), Type.Literal(10), Type.Literal(15)]);
const watchCommon = {
  watch_id: Uuid,
  event_id: Uuid,
  event_title: Type.String({ maxLength: 300 }),
  status: WatchStatus,
  ended_reason: Type.Union([
    Type.Null(),
    Type.Literal("EVENT_PAST"),
    Type.Literal("EVENT_CANCELLED"),
    Type.Literal("EVENT_REMOVED"),
    Type.Literal("USER"),
  ]),
  dimensions: WatchDimensionsSchema,
  threshold_pct: Threshold,
  last_snapshot: Nullable(WatchSnapshotSchema),
  last_change: Nullable(WatchChangeSchema),
  next_check_at: Nullable(OfferTime),
  created_at: OfferTime,
  version: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
};

export const WatchSchema = Type.Object({
  ...watchCommon,
  event: Nullable(EventCardSchema),
  tier: OfferTierSchema,
  travellers: Type.Integer({ minimum: 1, maximum: OFFER_TRAVELLERS_MAX }),
});
assertSame<Same<Static<typeof WatchSchema>, C.Watch>>();

/** Watch сервиса watch (INTERNAL_API §2.1): вместо tier/travellers — offer_params (проверяются нужные BFF поля). */
export const InternalWatchSchema = Type.Object({
  ...watchCommon,
  offer_params: Type.Object({ tier: OfferTierSchema, travellers: Type.Integer({ minimum: 1, maximum: OFFER_TRAVELLERS_MAX }) }),
});

export const WatchPageSchema = Type.Object({ items: Type.Array(WatchSchema), next_cursor: Nullable(Type.String()) });
assertSame<Same<Static<typeof WatchPageSchema>, C.Page<C.Watch>>>();
export const WatchChangePageSchema = Type.Object({ items: Type.Array(WatchChangeSchema), next_cursor: Nullable(Type.String()) });
assertSame<Same<Static<typeof WatchChangePageSchema>, C.Page<C.WatchChange>>>();

export const CreateWatchRequestSchema = Type.Object(
  {
    event_id: Type.String({ pattern: UUID_PATTERN, description: "UUID события" }),
    dimensions: Type.Optional(
      Type.Object(
        {
          tickets: Type.Optional(Type.Boolean()),
          price: Type.Optional(Type.Boolean()),
          flight: Type.Optional(Type.Boolean()),
          hotel: Type.Optional(Type.Boolean()),
          status: Type.Optional(Type.Boolean()),
          news: Type.Optional(Type.Boolean()),
        },
        strict,
      ),
    ),
    threshold_pct: Type.Optional(Threshold),
    tier: Type.Optional(OfferTierSchema),
    travellers: Type.Optional(Type.Integer({ minimum: 1, maximum: OFFER_TRAVELLERS_MAX })),
    offer_id: Type.Optional(Type.String({ pattern: UUID_PATTERN, description: "снимок offers, который видел пользователь (база цены)" })),
  },
  strict,
);
assertSame<Same<Static<typeof CreateWatchRequestSchema>, C.CreateWatchRequest>>();

export const WatchPatchRequestSchema = Type.Object(
  {
    dimensions: CreateWatchRequestSchema.properties.dimensions,
    threshold_pct: Type.Optional(Threshold),
    status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("paused")])),
    expected_version: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  },
  strict,
);

export const WatchParamsSchema = Type.Object({ watchId: Type.String({ pattern: UUID_PATTERN, description: "UUID слежения" }) }, strict);

const PageCursor = Type.Optional(Type.String({ minLength: 1, maxLength: 512 }));
export const WatchListQuerySchema = Type.Object(
  {
    status: Type.Optional(WatchStatus),
    cursor: PageCursor,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 20 })),
  },
  strict,
);
export const WatchChangesQuerySchema = Type.Object(
  { cursor: PageCursor, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })) },
  strict,
);

/** Элемент секции Home watch_changes (табло «Что изменилось»): последнее изменение слежения. */
export const HomeWatchChangeSchema = Type.Object({
  watch_id: Uuid,
  event_id: Uuid,
  event_title: Type.String({ maxLength: 300 }),
  status: WatchStatus,
  change: WatchChangeSchema,
});
export type HomeWatchChange = C.HomeWatchChange;
assertSame<Same<Static<typeof HomeWatchChangeSchema>, C.HomeWatchChange>>();

// ---------- News ----------
/** Домен источника: имя хоста в нижнем регистре (без порта, схемы, пути). */
export const DOMAIN_PATTERN = "^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$";

export const NewsItemSchema = Type.Object({
  news_id: Uuid,
  kind: Type.Union([Type.Literal("event_update"), Type.Literal("article")]),
  title: Text(300),
  summary: Nullable(Type.String({ maxLength: 1000 })),
  source: Type.Object({ name: Text(120), domain: Type.String({ pattern: DOMAIN_PATTERN }), url: OfferUrl }),
  published_at: OfferTime,
  significance: Type.Union([Type.Literal("high"), Type.Literal("mid"), Type.Literal("low")]),
  interests: Type.Array(Type.String({ pattern: CATEGORY_CODE, maxLength: 64 }), { maxItems: 20 }),
  event_ids: Type.Array(Uuid, { maxItems: 5 }),
  link: Nullable(
    Type.Object({ type: Type.Union([Type.Literal("watch"), Type.Literal("interest"), Type.Literal("event")]), label: Type.String({ maxLength: 200 }) }),
  ),
  // 6.1: news передаёт момент, с которого событие прошло (UTC); news до 6.1 поля не отдаёт
  event_ends_at: Type.Optional(Nullable(OfferTime)),
});
assertSame<Same<Static<typeof NewsItemSchema>, C.NewsItem>>();

export const NewsPageSchema = Type.Object({ items: Type.Array(NewsItemSchema), next_cursor: Nullable(Type.String()) });
assertSame<Same<Static<typeof NewsPageSchema>, C.Page<C.NewsItem>>>();

/** 6.1: тема новостей — корневой код интереса (чипы категорий каталога). */
export const NEWS_TOPICS = ["music", "sport", "business", "culture", "education", "festivals"] as const;
export const NewsTopicSchema = Type.Union([
  Type.Literal("music"),
  Type.Literal("sport"),
  Type.Literal("business"),
  Type.Literal("culture"),
  Type.Literal("education"),
  Type.Literal("festivals"),
]);
assertSame<Same<Static<typeof NewsTopicSchema>, C.NewsTopic>>();

const NewsFilterSchema = Type.Union([Type.Literal("all"), Type.Literal("watch"), Type.Literal("interests")], { default: "all" });

export const NewsQuerySchema = Type.Object(
  {
    filter: Type.Optional(NewsFilterSchema),
    topic: Type.Optional(NewsTopicSchema),
    cursor: PageCursor,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
  },
  strict,
);

export const NewsTopicsQuerySchema = Type.Object({ filter: Type.Optional(NewsFilterSchema) }, strict);

/** GET /v1/news/topics и проверка ответа news:topics (счётчики — целые ≥ 0). */
export const NewsTopicsResponseSchema = Type.Object({
  items: Type.Array(Type.Object({ topic: NewsTopicSchema, count: Type.Integer({ minimum: 0, maximum: 1_000_000 }) }), { maxItems: NEWS_TOPICS.length }),
  total: Nullable(Type.Integer({ minimum: 0, maximum: 10_000_000 })),
});
assertSame<Same<Static<typeof NewsTopicsResponseSchema>, C.NewsTopicsResponse>>();
/** Ответ news:topics как есть: элементы проверяются по одному (неизвестная тема — без неё). */
export const DomainTopicsSchema = Type.Object({
  items: Type.Array(Type.Unknown(), { maxItems: 50 }),
  total: Type.Integer({ minimum: 0, maximum: 10_000_000 }),
});

export const NewsPreferencesSchema = Type.Object({
  from_watch: Type.Boolean(),
  by_interests: Type.Boolean(),
  only_significant: Type.Boolean(),
  digest: Type.Boolean(),
});
assertSame<Same<Static<typeof NewsPreferencesSchema>, C.NewsPreferences>>();

export const NewsPreferencesPatchSchema = Type.Object(
  {
    from_watch: Type.Optional(Type.Boolean()),
    by_interests: Type.Optional(Type.Boolean()),
    only_significant: Type.Optional(Type.Boolean()),
    digest: Type.Optional(Type.Boolean()),
  },
  { ...strict, minProperties: 1 },
);

// ---------- ответы доменов (внутренние контракты §1–3), только проверка ----------
export const RankItemSchema = Type.Object({
  event_id: Uuid,
  score: Score,
  bucket: Type.String({ maxLength: 64 }),
  reasons: Type.Array(Type.Unknown(), { maxItems: 20 }), // каждая причина проверяется отдельно (неизвестный код — без неё)
  factors: RecommendationFactorsSchema,
});
export const RankResponseSchema = Type.Object({ items: Type.Array(Type.Unknown(), { maxItems: 100 }) });

/** recommendations GET /internal/v1/reactions/{event_id} (реакции нет — reaction: null). */
export const ReactionStateSchema = Type.Object({
  event_id: Uuid,
  reaction: Nullable(EventReactionSchema),
  created_at: Nullable(Type.String({ maxLength: 40 })),
});

export const WatchSummarySchema = Type.Object({
  active: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  critical: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  price_drops_since: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  next_check_at: Nullable(OfferTime),
});
export const ByEventsSchema = Type.Object({
  items: Type.Array(Type.Object({ event_id: Uuid, watch_id: Uuid, status: WatchStatus }), { maxItems: 100 }),
});
/** Страница домена: элементы проверяются по одному (битый — отбрасывается), курсор — непрозрачная строка. */
export const DomainPageSchema = Type.Object({
  items: Type.Array(Type.Unknown(), { maxItems: 100 }),
  next_cursor: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 512 }))),
});

// ---------- Home (спринт 3; спринт 6: recommendation/watch в карточках, watch_changes, news_carousel, summary) ----------
const HomeSectionState = Type.Union([Type.Literal("ready"), Type.Literal("pending_data"), Type.Literal("stale"), Type.Literal("unavailable")]);
assertSame<Same<Static<typeof HomeSectionState>, C.HomeSectionState>>();

export const HomeSectionSchema = Type.Object({
  type: HomeSectionType,
  key: Type.String(),
  variant: Variant,
  state: HomeSectionState,
  // event_carousel → карточки (сериализуются только поля контракта); watch_changes → HomeWatchChange[];
  // news_carousel → NewsItem[]; прочие — []
  items: Type.Union([
    Type.Array(HomeEventCardSchema),
    Type.Array(HomeWatchChangeSchema),
    Type.Array(NewsItemSchema),
    Type.Array(Type.Unknown(), { maxItems: 0 }),
  ]),
});
assertSame<Same<Static<typeof HomeSectionSchema>, C.HomeSection>>();

/** Счётчик сводки: null — источник недоступен или не подключён (не «0»). */
const SummaryCount = Nullable(Type.Integer({ minimum: 0 }));
export const HomeSummarySchema = Type.Object({
  new_events: SummaryCount,
  price_drops: SummaryCount,
  sales_opened: SummaryCount,
  critical: SummaryCount,
  since: Type.Optional(IsoTime),
});

export const HomeResponseSchema = Type.Object({
  summary: Nullable(HomeSummarySchema),
  sections: Type.Array(HomeSectionSchema),
  generated_at: IsoTime,
});
assertSame<Same<Static<typeof HomeResponseSchema>, C.HomeResponse>>();

// ======================================================================================================
// Спринт 7 — AI-консьерж (docs/sprint7/INTERNAL_API.md §1.2–1.3, §5; типы bff.ts «Спринт 7»)
// ======================================================================================================
// Ответы и события ai-concierge — недоверенные данные (испорченный upstream не должен уронить Mini App): каждая
// сущность и каждое событие SSE проверяются этими схемами (Ajv в src/ai.ts), строки ≤ 2000, наружу — проекция.

export const AI_TOOLS = [
  "reprice_offer",
  "set_direct_only",
  "change_departure",
  "set_hotel_distance",
  "extend_trip_days",
  "find_similar_event",
] as const;
export const AiToolNameSchema = Type.Union([
  Type.Literal("reprice_offer"),
  Type.Literal("set_direct_only"),
  Type.Literal("change_departure"),
  Type.Literal("set_hotel_distance"),
  Type.Literal("extend_trip_days"),
  Type.Literal("find_similar_event"),
]);
assertSame<Same<Static<typeof AiToolNameSchema>, C.AiToolName>>();

const AiMode = Type.Union([Type.Literal("event"), Type.Literal("home")]);
assertSame<Same<Static<typeof AiMode>, C.AiMode>>();

/** Ключ i18n (ai.*): латиница, цифры, точки, подчёркивания. */
const I18nKey = Type.String({ pattern: "^ai\\.[A-Za-z0-9_.]{1,60}$" });
const Str = (max: number) => Type.String({ maxLength: max });
const NStr = (max: number) => Nullable(Type.String({ maxLength: max }));
const AiTime = Type.String({
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$",
  maxLength: 40,
});
const AiMoney = Type.String({ pattern: "^[0-9]{1,12}(\\.[0-9]{1,6})?$", maxLength: 20 });
const ErrCode = Type.String({ pattern: "^[A-Z][A-Z0-9_]{1,63}$" });
const Component = Type.Union([Type.Literal("ticket"), Type.Literal("flight"), Type.Literal("hotel")]);
const TierOrNull = Nullable(OfferTierSchema);

/** AiTripParams = тело recalculate + selected_tier (тариф, открытый в Mini App; в offers не уходит). */
export const AiTripParamsSchema = Type.Object(
  { ...OfferRecalculateRequestSchema.properties, selected_tier: Type.Optional(OfferTierSchema) },
  strict,
);
assertSame<Same<Static<typeof AiTripParamsSchema>, C.AiTripParams>>();

/** Аргументы инструмента: ≤ 8 ключей (латиница), значения — строка ≤ 80, число, флаг или список строк ≤ 12. */
export const AI_ARG_KEY = /^[a-z][a-z0-9_]{0,31}$/;
export const AiToolArgsSchema = Type.Record(
  Type.String(),
  Type.Union([Type.String({ maxLength: 80 }), Type.Number(), Type.Boolean(), Type.Array(Type.String({ maxLength: 40 }), { maxItems: 12 })]),
  { maxProperties: 8 },
);
assertSame<Same<Static<typeof AiToolArgsSchema>, C.AiToolArgs>>();

export const AiQuotaSchema = Type.Object({
  used: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  limit: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  remaining: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  level: Type.String({ pattern: "^[a-z0-9_]{1,32}$" }),
  level_name: Str(64),
  resets_at: AiTime,
});
assertSame<Same<Static<typeof AiQuotaSchema>, C.AiQuota>>();

// ключи — слова (city_name, iata): additionalProperties: false, иначе шаблон ключа в patternProperties не ограничивает
const AiScalarParams = Type.Record(Type.String({ pattern: "^[a-z_]{1,32}$" }),
  Type.Union([Type.String({ maxLength: 200 }), Type.Number(), Type.Null()]), { maxProperties: 8, additionalProperties: false });

export const AiQuickActionSchema = Type.Object({
  id: Type.String({ pattern: "^(cheaper|direct|near|plus1|plus2|dep_[A-Z]{3}|similar|interests)$" }),
  tool: AiToolNameSchema,
  args: AiToolArgsSchema,
  label_key: I18nKey,
  params: Type.Optional(AiScalarParams),
});
assertSame<Same<Static<typeof AiQuickActionSchema>, C.AiQuickAction>>();

export const AiSourceSchema = Type.Object({
  ref: Type.String({ pattern: "^[SONT][0-9]{1,2}$" }),
  title: Str(300),
  domain: Str(253),
  url: Nullable(OfferUrl),
  fetched_at: NStr(40),
});
assertSame<Same<Static<typeof AiSourceSchema>, C.AiSource>>();

const AiSegmentKind = Type.Union([Type.Literal("fact"), Type.Literal("estimate"), Type.Literal("recommendation")]);
const Sources = Type.Array(AiSourceSchema, { maxItems: 20 });

export const AiSegmentSchema = Type.Object({ kind: AiSegmentKind, text: Str(2000), sources: Sources });
assertSame<Same<Static<typeof AiSegmentSchema>, C.AiSegment>>();

export const AiOfferBriefSchema = Type.Object({
  offer_ids: Type.Object({ economy: Nullable(Uuid), comfort: Nullable(Uuid), premium: Nullable(Uuid) }),
  tier: OfferTierSchema,
  status: Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("unavailable")]),
  per_person: Nullable(AiMoney),
  total: Nullable(AiMoney),
  missing: Type.Array(Component, { maxItems: 3 }),
  flight: Nullable(
    Type.Object({
      origin: Nullable(Iata),
      destination: Nullable(Iata),
      transfers: Nullable(Type.Integer({ minimum: 0, maximum: 10 })),
      price_per_person: Nullable(AiMoney),
      provider: NStr(40),
      fetched_at: NStr(40),
    }),
  ),
  hotel: Nullable(
    Type.Object({
      name: NStr(300),
      distance_km: Nullable(Type.Number({ minimum: 0, maximum: 1000 })),
      rating: NStr(8),
      price_total: Nullable(AiMoney),
      provider: NStr(40),
      fetched_at: NStr(40),
    }),
  ),
  budget_fit: BudgetFitSchema,
  budget_excludes: Type.Array(Component, { maxItems: 3 }),
});
assertSame<Same<Static<typeof AiOfferBriefSchema>, C.AiOfferBrief>>();

export const TilHeroRefSchema = Type.Object({
  event_id: Uuid,
  title: Str(300),
  start_date: Nullable(Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" })),
  city: NStr(200),
  country_code: Nullable(Country),
  categories: Type.Array(Type.String({ pattern: CATEGORY_CODE, maxLength: 64 }), { maxItems: 10 }),
  ticket_from: Nullable(
    Type.Object({ amount: AiMoney, currency: Type.String({ pattern: "^[A-Z]{3}$" }), fetched_at: NStr(40), source_url: Nullable(OfferUrl) }),
  ),
  score: Nullable(Type.Number({ minimum: 0, maximum: 100 })),
});
assertSame<Same<Static<typeof TilHeroRefSchema>, C.TilHeroRef>>();

const CallId = Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" });
const ToolStatus = Type.Union([Type.Literal("ok"), Type.Literal("no_change"), Type.Literal("failed"), Type.Literal("rejected")]);

export const AiToolCallSchema = Type.Object({ turn_id: Uuid, call_id: CallId, tool: AiToolNameSchema, args: AiToolArgsSchema, label_key: I18nKey });
assertSame<Same<Static<typeof AiToolCallSchema>, C.AiToolCall>>();

export const AiToolResultSchema = Type.Object({
  turn_id: Uuid,
  call_id: CallId,
  tool: AiToolNameSchema,
  status: ToolStatus,
  code: Nullable(ErrCode),
  changed: Type.Boolean(),
  trip_params: Nullable(AiTripParamsSchema),
  offer: Nullable(AiOfferBriefSchema),
  events: Nullable(Type.Array(TilHeroRefSchema, { maxItems: 10 })),
  providers: Type.Array(Type.Object({ provider: Str(40), fetched_at: NStr(40) }), { maxItems: 10 }),
  duration_ms: Type.Integer({ minimum: 0, maximum: 3_600_000 }),
  label_key: I18nKey,
});
assertSame<Same<Static<typeof AiToolResultSchema>, C.AiToolResult>>();

const SegmentNo = Type.Integer({ minimum: 0, maximum: 200 });
export const AiFactSchema = Type.Object({ turn_id: Uuid, segment: SegmentNo, kind: AiSegmentKind, sources: Sources });
assertSame<Same<Static<typeof AiFactSchema>, C.AiFact>>();
export const AiDeltaSchema = Type.Object({ turn_id: Uuid, segment: SegmentNo, text: Str(2000) });
assertSame<Same<Static<typeof AiDeltaSchema>, C.AiDelta>>();

/** https://[поддомены.]aviasales.(com|ru|kz) | tp.media | aviasales.tp.st [:443] [/?#…] — домены link-domains.json, как
 *  isFlightSearchUrl (src/offers.ts); хост в любом регистре и с точкой в конце (7.2: gateway отдаёт его в нижнем и без
 *  точки). Цель редиректа (tp.media/r?u=…) шаблон не проверяет — это делает `flightLink` при разборе done/истории. */
export const FLIGHT_SEARCH_URL_PATTERN =
  "^https://(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)*(?:[Aa][Vv][Ii][Aa][Ss][Aa][Ll][Ee][Ss]\\.(?:[Cc][Oo][Mm]|[Rr][Uu]|[Kk][Zz]|[Tt][Pp]\\.[Ss][Tt])|[Tt][Pp]\\.[Mm][Ee][Dd][Ii][Aa])\\.?(?::443)?(?:[/?#][^\\s\"'<>\\\\]*)?$";
const FlightSearchUrl = Type.String({ pattern: FLIGHT_SEARCH_URL_PATTERN, maxLength: 2048 });

export const AiDoneActionSchema = Type.Union([
  Type.Object({ type: Type.Literal("retry"), tool: AiToolNameSchema, args: AiToolArgsSchema }),
  Type.Object({ type: Type.Literal("watch_price"), event_id: Uuid }),
  Type.Object({ type: Type.Literal("open_event"), event_id: Uuid }),
  // 7.1: ссылка на поиск Aviasales — только https на тех же доменах, что FLIGHT_LINK_DOMAINS (aviasales.com/.ru/.kz,
  // tp.media, с поддоменами), порт 443 или без порта
  Type.Object({ type: Type.Literal("flight_search"), url: FlightSearchUrl, provider: Type.Literal("aviasales") }),
]);
assertSame<Same<Static<typeof AiDoneActionSchema>, C.AiDoneAction>>();

export const AiAppliedChangeSchema = Type.Object({ tool: AiToolNameSchema, trip_params: AiTripParamsSchema, note_key: I18nKey });
assertSame<Same<Static<typeof AiAppliedChangeSchema>, C.AiAppliedChange>>();

/** Спринт 8: известные ключи подписи квоты (неизвестный ключ BFF заменяет на null — done не роняется). */
export const AI_QUOTA_NOTE_KEYS = ["ai.quota.free_no_change"] as const;
export const AiQuotaNoteKeySchema = Type.Literal("ai.quota.free_no_change");
assertSame<Same<Static<typeof AiQuotaNoteKeySchema>, C.AiQuotaNoteKey>>();

export const AiDoneSchema = Type.Object({
  turn_id: Uuid,
  message_id: Uuid,
  status: Type.Union([Type.Literal("completed"), Type.Literal("partial")]),
  applied_change: Nullable(AiAppliedChangeSchema),
  actions: Type.Array(AiDoneActionSchema, { maxItems: 10 }),
  quota: AiQuotaSchema,
  model: Type.Union([Type.Literal("primary"), Type.Literal("fallback")]),
  quick_actions: Type.Optional(Type.Array(AiQuickActionSchema, { maxItems: 12 })),
  // спринт 8 (правило NC): необязательные — старый ai-concierge их не шлёт
  quota_charged: Type.Optional(Type.Boolean()),
  quota_note_key: Type.Optional(Nullable(AiQuotaNoteKeySchema)),
});
assertSame<Same<Static<typeof AiDoneSchema>, C.AiDone>>();

export const AiErrorSchema = Type.Object({
  turn_id: Nullable(Uuid),
  code: ErrCode,
  message: Str(2000),
  retryable: Type.Boolean(),
  quota_refunded: Type.Boolean(),
});
assertSame<Same<Static<typeof AiErrorSchema>, C.AiError>>();

/** Схема data для каждого типа события SSE. */
export const AI_SSE_SCHEMAS = {
  tool_call: AiToolCallSchema,
  tool_result: AiToolResultSchema,
  fact: AiFactSchema,
  delta: AiDeltaSchema,
  done: AiDoneSchema,
  error: AiErrorSchema,
} as const;

/** Сообщение пользователя — ход быстрого действия (text null): подпись нажатой кнопки. */
export const AiMessageActionSchema = Type.Object({
  tool: AiToolNameSchema,
  args: AiToolArgsSchema,
  label_key: I18nKey,
  params: Type.Optional(AiScalarParams),
});
assertSame<Same<Static<typeof AiMessageActionSchema>, C.AiMessageAction>>();

export const AiMessageSchema = Type.Object({
  message_id: Uuid,
  turn_id: Uuid,
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  text: NStr(2000),
  segments: Nullable(Type.Array(AiSegmentSchema, { maxItems: 50 })),
  created_at: AiTime,
  status: Type.Optional(Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("partial"), Type.Literal("error")])),
  code: Type.Optional(Nullable(ErrCode)),
  applied_change: Type.Optional(Nullable(AiAppliedChangeSchema)),
  actions: Type.Optional(Type.Array(AiDoneActionSchema, { maxItems: 10 })),
  tool_results: Type.Optional(Type.Array(AiToolResultSchema, { maxItems: 10 })),
  action: Type.Optional(AiMessageActionSchema),
  label_key: Type.Optional(I18nKey),
  // спринт 8 (ревью): поля квоты и в истории — необязательные
  quota_charged: Type.Optional(Type.Boolean()),
  quota_note_key: Type.Optional(Nullable(AiQuotaNoteKeySchema)),
});
assertSame<Same<Static<typeof AiMessageSchema>, C.AiMessage>>();

export const AiConversationSchema = Type.Object({
  conversation_id: Uuid,
  mode: AiMode,
  event_id: Nullable(Uuid),
  status: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  context: Type.Object({
    chips: Type.Array(Type.String({ pattern: "^[a-z_]{1,20}$" }), { maxItems: 10 }),
    sources_count: Type.Integer({ minimum: 0, maximum: 1000 }),
    trip_kind: Type.Union([Type.Literal("trip"), Type.Literal("ticket_only"), Type.Literal("not_available"), Type.Null()]),
    tier: TierOrNull,
    allowed_departures: Type.Array(Iata, { maxItems: 12 }),
  }),
  greeting: Type.Object({
    key: I18nKey,
    params: Type.Record(Type.String(), Type.Union([Type.String({ maxLength: 200 }), Type.Number(), Type.Null()]), { maxProperties: 8 }),
  }),
  quick_actions: Type.Array(AiQuickActionSchema, { maxItems: 12 }),
  quota: AiQuotaSchema,
  created_at: AiTime,
  last_activity_at: AiTime,
  messages: Type.Optional(Type.Array(AiMessageSchema, { maxItems: 50 })),
});
assertSame<Same<Static<typeof AiConversationSchema>, C.AiConversation>>();

export const AiTurnResultSchema = Type.Object({
  turn_id: Uuid,
  segments: Type.Array(Type.Object({ ...AiSegmentSchema.properties, segment: SegmentNo }), { maxItems: 50 }),
  tool_results: Type.Array(AiToolResultSchema, { maxItems: 10 }),
  done: Nullable(AiDoneSchema),
  error: Nullable(AiErrorSchema),
});
assertSame<Same<Static<typeof AiTurnResultSchema>, C.AiTurnResult>>();

// ---------- вход Mini App ----------
export const AiCreateConversationSchema = Type.Object(
  {
    mode: AiMode,
    event_id: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    trip_params: Type.Optional(AiTripParamsSchema),
  },
  strict,
);
assertSame<Same<Static<typeof AiCreateConversationSchema>, C.AiCreateConversationRequest>>();

export const AiMessageRequestSchema = Type.Object(
  {
    client_msg_id: Type.String({ pattern: UUID_PATTERN }),
    text: Type.String({ minLength: 1, maxLength: 500 }),
    trip_params: Type.Optional(AiTripParamsSchema),
  },
  strict,
);
assertSame<Same<Static<typeof AiMessageRequestSchema>, C.AiMessageRequest>>();

export const AiActionRequestSchema = Type.Object(
  {
    client_msg_id: Type.String({ pattern: UUID_PATTERN }),
    args: AiToolArgsSchema,
    trip_params: Type.Optional(AiTripParamsSchema),
  },
  strict,
);
assertSame<Same<Static<typeof AiActionRequestSchema>, C.AiActionRequest>>();

export const AiConversationParamsSchema = Type.Object(
  { conversationId: Type.String({ pattern: UUID_PATTERN, description: "UUID переписки" }) },
  strict,
);
export const AiActionParamsSchema = Type.Object(
  { conversationId: Type.String({ pattern: UUID_PATTERN }), tool: Type.String({ minLength: 1, maxLength: 64 }) },
  strict,
);

// ---------- Доработка 9.4: «Что нового» ----------
// списки — в whatsNew.ts (контракты у BFF только типы); сверка с packages/contracts/release-notes.json — test/whatsnew94
const ReleaseNoteRouteSchema = Type.Union(NOTE_ROUTES.map((r) => Type.Literal(r)) as unknown as [TLiteral<C.ReleaseNoteRoute>]);
const ReleaseNoteIconSchema = Type.Union(NOTE_ICONS.map((r) => Type.Literal(r)) as unknown as [TLiteral<C.ReleaseNoteIcon>]);

export const ReleaseNoteSchema = Type.Object({
  release_note_id: Type.String(),
  slug: Type.String(),
  title: Label,
  items: Type.Array(
    Type.Object({
      title: Label,
      text: Label,
      link: Nullable(ReleaseNoteRouteSchema),
      icon: Nullable(ReleaseNoteIconSchema),
    }),
  ),
  published_at: IsoTime,
});
assertSame<Same<Static<typeof ReleaseNoteSchema>, C.ReleaseNote>>();

export const WhatsNewResponseSchema = Type.Object({
  items: Type.Array(ReleaseNoteSchema),
  latest: Nullable(ReleaseNoteSchema),
});
assertSame<Same<Static<typeof WhatsNewResponseSchema>, C.WhatsNewResponse>>();

export const WhatsNewSeenRequestSchema = Type.Object({ release_note_id: Type.String({ pattern: UUID_PATTERN }) }, strict);
assertSame<Same<Static<typeof WhatsNewSeenRequestSchema>, C.WhatsNewSeenRequest>>();

export const WhatsNewSeenResponseSchema = Type.Object({ last_seen_release_note_id: Nullable(Type.String()) });
assertSame<Same<Static<typeof WhatsNewSeenResponseSchema>, C.WhatsNewSeenResponse>>();
