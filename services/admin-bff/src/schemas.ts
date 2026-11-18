/**
 * JSON Schema входа admin-bff (Ajv Fastify, без приведения типов и без удаления лишних полей: лишнее поле → 422).
 * querystring и params — строки (числа разбираются вручную), тело — строгие типы.
 */
import { ALL_PERMISSIONS, ROLE_CODES } from "./rbac.js";

type Schema = Record<string, unknown>;

export const str = (minLength: number, maxLength: number, extra: Schema = {}): Schema => ({
  type: "string",
  minLength,
  maxLength,
  ...extra,
});

export const obj = (properties: Record<string, Schema>, required: string[] = [], extra: Schema = {}): Schema => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
  ...extra,
});

export const enumOf = (values: readonly string[]): Schema => ({ type: "string", enum: [...values] });
export const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: "null" }] });

export const UUID = str(36, 36, { pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" });
export const ROLE = enumOf(ROLE_CODES);
export const PERMISSION = enumOf(ALL_PERMISSIONS);
export const PERIOD = enumOf(["today", "7d", "30d"]);
export const LIMIT_Q = str(1, 3, { pattern: "^(?:[1-9]|[1-9][0-9]|100)$" });
export const CURSOR_Q = str(1, 512);
export const BOOL_Q = enumOf(["true", "false"]);
export const ISO_Q = str(10, 40, { pattern: "^\\d{4}-\\d{2}-\\d{2}" });
export const TOTP = str(6, 6, { pattern: "^\\d{6}$" });
export const CHALLENGE = str(16, 128, { pattern: "^[A-Za-z0-9_-]+$" });
export const REASON = str(3, 500);
export const TICKET_REF = str(1, 64, { pattern: "^[A-Za-z0-9-]+$" });

export const params = (props: Record<string, Schema>): Schema => obj(props, Object.keys(props));
export const query = (props: Record<string, Schema>): Schema => obj(props);

/** limit/cursor для доменов: строки querystring → числа и строки без пустых значений. */
export function pageQuery(q: { limit?: string; cursor?: string }): { limit?: number; cursor?: string } {
  return {
    ...(q.limit ? { limit: Number(q.limit) } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  };
}

export const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

// ---------- спринт 4: источники, очередь проверки, поиск событий (docs/sprint4/INTERNAL_API.md §2, §6, §7) ----------
// Правила здесь — первая линия (форма и границы); домены проверяют повторно и глубже (публичные суффиксы, хост
// страницы ∈ event_domains, коды таксономии, домен basis_url).

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
/** Домен источника: ASCII DNS-имя в нижнем регистре без схемы/пути/порта, ≥ 2 меток. */
export const SOURCE_DOMAIN = str(3, 253, { pattern: `^${LABEL}(\\.${LABEL})+$` });
/** Домен медиа: дополнительно `*.cdn.example`. */
export const MEDIA_DOMAIN = str(3, 255, { pattern: `^(\\*\\.)?${LABEL}(\\.${LABEL})+$` });
export const SOURCE_SLUG = str(2, 41, { pattern: "^[a-z0-9][a-z0-9-]{1,40}$" });
export const COUNTRY = str(2, 2, { pattern: "^[A-Z]{2}$" });
export const SOURCE_TIER = enumOf(["OFFICIAL_ORGANIZER", "OFFICIAL_TICKET_PROVIDER", "TRUSTED_STRUCTURED", "TRUSTED_MEDIA"]);
/** https-URL без пробелов и управляющих символов (хост проверяет домен). */
export const HTTPS_URL = str(9, 2048, { pattern: "^https://[^\\s/?#@]+(?:[/?#][^\\s]*)?$" });
export const TAXONOMY_CODE = str(1, 64, { pattern: "^[a-z0-9][a-z0-9_.-]*$" });
/** Город страницы афиши — как source-registry `CITY_MAX = 80`. */
export const LISTING_CITY_MAX = 80;
/** Исправление 9.3: путь к полю ответа JSON API — ключи и номера элементов через точку (как JsonApiMapping). */
const JSON_PATH = str(1, 519, { pattern: "^[A-Za-z0-9_\\-$@]{1,64}(\\.[A-Za-z0-9_\\-$@]{1,64}){0,7}$" });
const PARAM_NAME = str(1, 64, { pattern: "^[A-Za-z0-9_.\\-\\[\\]]{1,64}$" });
const JSON_API_FIELDS = obj(
  {
    id: JSON_PATH,
    title: JSON_PATH,
    start: JSON_PATH,
    ...Object.fromEntries(
      ["end", "venue", "hall", "city", "ticket_url", "image", "price_min", "price_max", "currency", "age", "status", "description"].map((k) => [k, nullable(JSON_PATH)]),
    ),
  },
  ["id", "title", "start"],
);
/**
 * Маппинг страницы «JSON API» (исправление 9.3): форма и границы; строгую проверку (https, домены источника,
 * плейсхолдеры дат, пояс) делает source-registry / provider-gateway той же моделью (tilhero_common.jsonapi_mapping).
 */
export const JSON_API_MAPPING = obj(
  {
    url: str(9, 1024, { pattern: "^https://[^\\s/?#@]+(?:[/?][^\\s#]*)?$" }),
    params: {
      type: "object",
      maxProperties: 20,
      propertyNames: { pattern: "^[A-Za-z0-9_.\\-\\[\\]]{1,64}$" },
      additionalProperties: { anyOf: [str(0, 200), { type: "integer" }, { type: "boolean" }] },
    },
    page_param: nullable(PARAM_NAME),
    per_page_param: nullable(PARAM_NAME),
    per_page: { type: "integer", minimum: 1, maximum: 200 },
    max_pages: { type: "integer", minimum: 1, maximum: 5 },
    first_page: { type: "integer", minimum: 0, maximum: 1 },
    items_path: { anyOf: [JSON_PATH, { type: "array", items: JSON_PATH, minItems: 1, maxItems: 3 }] },
    fields: JSON_API_FIELDS,
    url_template: str(12, 1024, { pattern: "^https://[^\\s#]*\\{id\\}[^\\s#]*$" }),
    image_base: nullable(HTTPS_URL),
    image_where: nullable({ type: "object", maxProperties: 3, additionalProperties: str(1, 100) }),
    status_exclude: { type: "array", items: str(1, 40), maxItems: 20 },
    locale_order: { type: "array", items: str(2, 10, { pattern: "^[a-z]{2,3}([-_][A-Za-z]{2,4})?$" }), minItems: 1, maxItems: 6 },
    start_tz: nullable(str(1, 64)),
  },
  ["url", "items_path", "fields", "url_template"],
);
export const LISTING_PAGE = obj(
  {
    url: HTTPS_URL,
    city: nullable(str(1, LISTING_CITY_MAX)),
    category: nullable(TAXONOMY_CODE),
    // исправление 9.1: тип страницы (сайт | Telegram-канал) и приоритет; не переданы — html / normal; 9.3 — JSON API
    kind: enumOf(["html", "telegram", "json_api"]),
    priority: enumOf(["normal", "low"]),
    json_api: nullable(JSON_API_MAPPING),
  },
  ["url", "city", "category"],
);
const domainList = (item: Record<string, unknown>, minItems: number) => ({
  type: "array",
  items: item,
  minItems,
  maxItems: 10,
  uniqueItems: true,
});
/** Поля SourceInput без slug (PATCH: все необязательны). */
export const SOURCE_FIELDS = {
  name: str(1, 120),
  country_code: COUNTRY,
  tier: SOURCE_TIER,
  event_domains: domainList(SOURCE_DOMAIN, 1),
  media_domains: domainList(MEDIA_DOMAIN, 0),
  listing_pages: { type: "array", items: LISTING_PAGE, maxItems: 10 },
  enabled: { type: "boolean" },
  js_only: nullable({ type: "boolean" }),
  notes: nullable(str(0, 1000)),
};
/** POST /admin/v1/sources/json-api/preview (9.3): страница «JSON API» из формы источника — до сохранения. */
export const JSON_API_PREVIEW_INPUT = obj(
  {
    // ревью 9.3: источник, чью страницу проверяют (нет — новый источник: нужен свежий step-up)
    source_id: UUID,
    country_code: COUNTRY,
    event_domains: domainList(SOURCE_DOMAIN, 1),
    media_domains: domainList(MEDIA_DOMAIN, 0),
    city: nullable(str(1, LISTING_CITY_MAX)),
    category: nullable(TAXONOMY_CODE),
    json_api: JSON_API_MAPPING,
  },
  ["country_code", "event_domains", "media_domains", "city", "category", "json_api"],
);
/** PATCH источника: изменение этих полей требует step-up (admin.ts). */
export const SOURCE_STEP_UP_FIELDS = ["event_domains", "media_domains", "enabled", "tier"] as const;

export const REVIEW_STATUS = enumOf(["OPEN", "SUPERSEDED", "DISMISSED", "ACCEPTED", "REJECTED", "CORRECTED", "EXPIRED"]);
export const REVIEW_REJECT_REASON = enumOf(["NOT_AN_EVENT", "DUPLICATE", "WRONG_FACTS", "SOURCE_UNRELIABLE", "OTHER"]);
/** Провайдер события: ticketmaster, fixture, aiweb.<slug>. */
export const PROVIDER_Q = str(2, 64, { pattern: "^[a-z0-9][a-z0-9_-]*(\\.[a-z0-9][a-z0-9-]{1,40})?$" });
export const DECISION_NOTE = str(3, 500);
/** Решение принимается только по OPEN (оптимистичная проверка, 409 REVIEW_ALREADY_DECIDED у домена). */
export const EXPECTED_OPEN = enumOf(["OPEN"]);
/** content_hash открытой карточки (SHA-256 hex): факты сменились → 409 REVIEW_CHANGED у домена. */
export const CONTENT_HASH = str(64, 64, { pattern: "^[0-9a-f]{64}$" });
/** Возврат в очередь — только из «Не подтверждено» (исправление 5.1). */
export const EXPECTED_EXPIRED = enumOf(["EXPIRED"]);
/** Массовые решения: не больше 100 строк за раз (events: items 1..100). */
export const REVIEW_BULK_MAX = 100;
const bulkItems = (item: Schema) => ({ type: "array", items: item, minItems: 1, maxItems: REVIEW_BULK_MAX });
export const REVIEW_BULK_REJECT = obj(
  {
    items: bulkItems(obj({ review_id: UUID, expected_content_hash: CONTENT_HASH }, ["review_id", "expected_content_hash"])),
    reason_code: REVIEW_REJECT_REASON,
    note: DECISION_NOTE,
  },
  ["items", "reason_code", "note"],
);
export const REVIEW_REOPEN = obj({ expected_status: EXPECTED_EXPIRED, note: DECISION_NOTE }, ["expected_status", "note"]);
export const REVIEW_BULK_REOPEN = obj({ items: bulkItems(obj({ review_id: UUID }, ["review_id"])), note: DECISION_NOTE }, ["items", "note"]);
const LOCAL_DATE = str(10, 10, { pattern: "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$" });
const LOCAL_TIME = str(5, 5, { pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" });
const LOCAL_START = obj({ local_date: LOCAL_DATE, local_time: nullable(LOCAL_TIME) }, ["local_date", "local_time"]);
/** Деньги — строка с 2 знаками, как у events (PriceChange: `^\d{1,10}\.\d{2}$`). */
const DECIMAL = str(4, 13, { pattern: "^\\d{1,10}\\.\\d{2}$" });
export const REVIEW_CORRECTION = obj(
  {
    title: str(1, 300),
    start: LOCAL_START,
    end: nullable(LOCAL_START),
    // длины — как у events (VenueChange): площадка 300, город 200, адрес 500
    venue: obj({ name: str(1, 300), city: str(1, 200), address: nullable(str(1, 500)) }, ["name", "city", "address"]),
    price_range: nullable(obj({ min: DECIMAL, max: DECIMAL, currency: str(3, 3, { pattern: "^[A-Z]{3}$" }) }, ["min", "max", "currency"])),
    online: { type: "boolean" },
  },
  [],
  { minProperties: 1 },
);
/** Ручной запуск поиска: бюджет вызовов провайдера (admin.ts: 1..200). */
export const MAX_MANUAL_PROVIDER_CALLS = 200;

// ---------- спринт 6: ленты и модерация новостей (docs/sprint6/INTERNAL_API.md §3.1, §8) ----------

export const NEWS_SOURCE_KIND = enumOf(["official", "media"]);
export const NEWS_SOURCE_MODE = enumOf(["rss", "html"]);
export const NEWS_SOURCE_DISPLAY = enumOf(["summary", "title_only"]);
export const NEWS_LANG = enumOf(["ru", "en", "uz"]);
/** Подстрока пути URL записи ("/culture/"): без пробелов, кавычек и управляющих символов. */
export const NEWS_CATEGORY_FILTER = str(1, 100, { pattern: "^[^\\s\"'<>\\\\]+$" });
export const NEWS_INTERESTS_MAX = 10;
export const NEWS_ENTITIES_MAX = 20;
/** Поля NewsSourceInput без slug (PATCH: все необязательны). */
export const NEWS_SOURCE_FIELDS = {
  name: str(1, 120),
  kind: NEWS_SOURCE_KIND,
  mode: NEWS_SOURCE_MODE,
  feed_url: nullable(HTTPS_URL),
  page_url: nullable(HTTPS_URL),
  site_domain: SOURCE_DOMAIN,
  extra_domains: domainList(SOURCE_DOMAIN, 0),
  interests: { type: "array", items: TAXONOMY_CODE, minItems: 1, maxItems: NEWS_INTERESTS_MAX, uniqueItems: true },
  entities: { type: "array", items: str(1, 80), maxItems: NEWS_ENTITIES_MAX, uniqueItems: true },
  country_code: nullable(COUNTRY),
  lang: NEWS_LANG,
  display: NEWS_SOURCE_DISPLAY,
  category_filter: nullable(NEWS_CATEGORY_FILTER),
  enabled: { type: "boolean" },
};
/** Поля проверки ленты (NewsSourceCheckInput). */
export const NEWS_CHECK_FIELDS = {
  mode: NEWS_SOURCE_MODE,
  feed_url: nullable(HTTPS_URL),
  page_url: nullable(HTTPS_URL),
  site_domain: SOURCE_DOMAIN,
  extra_domains: domainList(SOURCE_DOMAIN, 0),
  category_filter: nullable(NEWS_CATEGORY_FILTER),
};
export const NEWS_HIDE_REASON = str(3, 300);
export const EXPECTED_VERSION = { type: "integer", minimum: 1, maximum: 2_147_483_647 };

/** Фильтр стран (спринт 6, ревью): ISO 3166-1 alpha-2 через запятую, до 20; регистр не важен (BFF приводит к верхнему),
 *  принадлежность кодов списку ISO — в обработчике (countryList). */
export const COUNTRY_LIST_MAX = 20;
export const COUNTRY_LIST_Q = str(2, 3 * COUNTRY_LIST_MAX - 1, { pattern: "^[A-Za-z]{2}(,[A-Za-z]{2}){0,19}$" });
