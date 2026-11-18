/**
 * Спринт 8 (docs/sprint8/INTERNAL_API.md §2–4, §7, §12): нормализация ответов ops-monitor и доменной статистики
 * дашборда (offers, news, user-admin, ai-control) — одно описание даёт проверку значения и схему ответа admin-bff.
 * Испорченный ответ → 503 UPSTREAM_UNAVAILABLE {service} (у дашборда — блок «нет данных»). Тексты — только очищенные
 * (сообщения поставщиков ≤ 200); payload DLQ приходит уже маскированным и проверяется на размер.
 */
import type {
  AiAgentDayBudget,
  AlertSeverity,
  BreakerState,
  ConsumerInfo,
  DashboardAiAgent,
  DashboardUsers,
  DlqAction,
  DlqCommandResult,
  DlqDetail,
  DlqItem,
  DlqPage,
  NewsStats,
  NoFlightPair,
  NoFlightStats,
  OpsAlert,
  OpsAlertParams,
  OpsDeletionsBrief,
  OpsSummary,
  OutboxInfo,
  ProblemFeed,
  ProblemFeeds,
  ProviderErrorClass,
  ProviderHealth,
  ProviderHealthStatus,
  ProviderHistory,
  ProviderHistoryPoint,
  ProviderLastError,
  ProviderLastRouteError,
  ProviderProbeBrief,
  ProviderProbeResult,
  ProviderWindow,
  RouteCount,
  ServiceReady,
  StreamInfo,
  TripsStats,
} from "@tilhero/contracts/admin";
import { BadValue, C, KEY_RE, type Codec } from "../codec.js";
import { cleanText } from "./travel.js";
import { DEFAULT_RUNBOOK_BASE_URL, runbookUrlAllowed } from "../runbook.js";

// ---------------------------------------------------------------- словари

export const PROVIDER_STATUSES: readonly ProviderHealthStatus[] = ["ok", "degraded", "down", "idle", "not_configured"];
export const ERROR_CLASSES: readonly ProviderErrorClass[] = ["auth", "rate_limit", "quota", "timeout", "server", "network", "bad_response", "circuit_open"];
export const SEVERITIES: readonly AlertSeverity[] = ["critical", "warning", "info"];
/** Пробы (§1.4): Anthropic не пробуется никогда (стоит денег), ленты — через news. */
export const PROBEABLE = new Set(["aviasales", "liteapi", "ticketmaster", "osm", "cbu"]);

const PROVIDER_ID = C.id(/^[a-z][a-z0-9_]{1,31}$/, 32);
const STATUS = C.oneOf(PROVIDER_STATUSES);
const SEVERITY = C.oneOf(SEVERITIES);
const N_TIME = C.nullable(C.time);
const N_INT = C.nullable(C.int());
const RATE = C.num(0, 1);
const IATA_OR_OTHER = C.id(/^([A-Z0-9]{2,4}|_other)$/, 8);
const CODE = C.id(/^[A-Za-z0-9_.:-]{1,64}$/, 64);
const N_CODE = C.nullable(CODE);
const DURABLE = C.id(/^[A-Za-z0-9_-]{1,120}$/, 120);
const SERVICE = C.id(/^[a-z][a-z0-9-]{1,63}$/, 64);
const EVENT_TYPE = C.id(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$/, 120);
const DLQ_ID = C.id(/^(dlq|legacy):[0-9]{1,19}$/, 30);

/** Число в объекте-счётчике: неотрицательное целое, иначе 0 (ops-monitor не отдаёт отрицательных). */
const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1e12 ? v : 0);

/** {класс ошибки: n} — восемь известных классов (прочие отбрасываются, отсутствующие — 0). */
const BY_CLASS = C.custom<Record<ProviderErrorClass, number>>(
  { type: "object", properties: Object.fromEntries(ERROR_CLASSES.map((k) => [k, { type: "integer" }])), "x-contract-required": [...ERROR_CLASSES] },
  (v) => {
    const src = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    return Object.fromEntries(ERROR_CLASSES.map((k) => [k, count(src[k])])) as Record<ProviderErrorClass, number>;
  },
);
const PARTIAL_BY_CLASS = C.custom<Partial<Record<ProviderErrorClass, number>>>({ type: "object", additionalProperties: { type: "integer" } }, (v) => {
  const src = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return Object.fromEntries(ERROR_CLASSES.filter((k) => src[k] !== undefined).map((k) => [k, count(src[k])]));
});
/** {строковый ключ: n} (причины без перелёта) — ключи UPPER_SNAKE, значения — счётчики. */
const COUNTS = C.custom<Record<string, number>>({ type: "object", additionalProperties: { type: "integer" } }, (v, p) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadValue(p);
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>).slice(0, 50)) if (/^[A-Z][A-Z0-9_]{1,63}$/.test(k)) out[k] = count(n);
  return out;
});

export const ROUTE_COUNT = C.obj<RouteCount>({ location: IATA_OR_OTHER, count: C.int() });

const WINDOW = C.obj<ProviderWindow>({
  minutes: C.fallback(C.int(0, 1440), 5),
  calls: C.int(),
  error_rate: RATE,
  p50_ms: N_INT,
  p95_ms: N_INT,
  by_class: BY_CLASS,
  route_unsupported: C.fallback(C.int(), 0),
  route_top: C.fallback(C.arr(ROUTE_COUNT, 50), []),
});
const LAST_ERROR = C.obj<ProviderLastError>({
  code: N_CODE,
  reason: C.nullable(C.id(/^[A-Za-z0-9_.:-]{1,64}$/, 64)),
  message: C.custom<string | null>({ type: ["string", "null"] }, (v) => cleanText(v, 200)),
  http_status: C.nullable(C.int(100, 599)),
  at: N_TIME,
});
const LAST_ROUTE_ERROR = C.obj<ProviderLastRouteError>({
  code: N_CODE,
  location: C.nullable(C.id(/^[A-Z0-9]{2,4}$/, 4)),
  route: C.nullable(C.id(/^[A-Z0-9]{2,4}-[A-Z0-9]{2,4}$/, 9)),
  at: N_TIME,
});
const PROBE_BRIEF = C.obj<ProviderProbeBrief>({ ok: C.bool, latency_ms: N_INT, code: N_CODE, at: C.time });
// спринт 9 (§6.1): += service_down, deletion_stuck, rate_limit_spike, rate_limit_unavailable — без них новое оповещение
// ops-monitor сделало бы весь список «испорченным ответом» (503)
export const OPS_ALERT_KINDS = [
  "status",
  "unstable",
  "route_spike",
  "dlq_growth",
  "lag",
  "outbox_stuck",
  "feeds_problem",
  "service_down",
  "deletion_stuck",
  "rate_limit_spike",
  "rate_limit_unavailable",
] as const;
export const OPS_ALERT_SUBJECTS = ["provider", "consumer", "outbox", "dlq", "feeds", "service", "deletion", "ratelimit"] as const;
const OPS_KIND = C.oneOf(OPS_ALERT_KINDS);

const PROVIDER_HEALTH_RAW = C.obj<ProviderHealth>({
  provider: PROVIDER_ID,
  title: C.text(80),
  status: STATUS,
  status_since: N_TIME,
  window: WINDOW,
  last_24h: C.obj<ProviderHealth["last_24h"]>({ calls: C.int(), error_rate: RATE, p95_ms: N_INT, route_unsupported: C.fallback(C.int(), 0) }),
  breaker: C.nullable(C.oneOf<BreakerState>(["closed", "open", "half_open"])),
  quota: C.nullable(C.obj<NonNullable<ProviderHealth["quota"]>>({ used: C.int(), limit: C.int(), pct: C.num(0, 100_000) })),
  last_error: C.nullable(LAST_ERROR),
  last_route_error: C.nullable(LAST_ROUTE_ERROR),
  last_probe: C.nullable(PROBE_BRIEF),
  open_alerts: C.fallback(C.arrSkip(C.obj<ProviderHealth["open_alerts"][number]>({ alert_id: C.uuid, kind: OPS_KIND, severity: SEVERITY }), 50), []),
  stale_since: C.fallback(N_TIME, null),
  probe_supported: C.bool,
});
/** ProviderHealth + probe_supported (вычисляет admin-bff: Anthropic и ленты не пробуются). */
export const PROVIDER_HEALTH = C.custom<ProviderHealth>(PROVIDER_HEALTH_RAW.schema, (v, p) => {
  const src = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const name = typeof src.provider === "string" ? src.provider : "";
  return PROVIDER_HEALTH_RAW.parse({ ...src, probe_supported: PROBEABLE.has(name) }, p);
});
/** ops-monitor отдаёт список — admin-bff отдаёт {items}. */
export const listOf = <T>(item: Codec<T>, max = 500): Codec<{ items: T[] }> =>
  C.map(C.arr(item, max), { type: "object", properties: { items: { type: "array", items: item.schema } }, "x-contract-required": ["items"] }, (items) => ({ items }));

export const PROVIDER_HEALTH_LIST = listOf(PROVIDER_HEALTH, 50);

const POINT = C.obj<ProviderHistoryPoint>({
  t: C.time,
  calls: C.int(),
  errors: C.int(),
  by_class: BY_CLASS,
  route_unsupported: C.fallback(C.int(), 0),
  p50_ms: N_INT,
  p95_ms: N_INT,
});
export const PROVIDER_HISTORY = C.obj<ProviderHistory>({
  provider: PROVIDER_ID,
  range: C.oneOf(["24h", "7d"]),
  step: C.oneOf(["5m", "1h"]),
  points: C.arr(POINT, 400),
  transitions: C.arr(C.obj<ProviderHistory["transitions"][number]>({ from: STATUS, to: STATUS, at: C.time }), 500),
  route_top: C.fallback(C.arr(ROUTE_COUNT, 50), []),
});
export const PROBE_RESULT = C.obj<ProviderProbeResult>({
  probe: C.obj<ProviderProbeResult["probe"]>({
    ok: C.bool,
    latency_ms: N_INT,
    code: N_CODE,
    reason: C.nullable(C.id(/^[A-Za-z0-9_.:-]{1,64}$/, 64)),
    message: C.custom<string | null>({ type: ["string", "null"] }, (v) => cleanText(v, 200)),
    http_status: C.nullable(C.int(100, 599)),
    checked_at: C.time,
  }),
  provider: PROVIDER_HEALTH,
});
const FEED = C.obj<ProblemFeed>({
  source_id: C.custom<string>({ type: "string" }, (v, p) => C.id(/^[A-Za-z0-9_-]{1,64}$/, 64).parse(typeof v === "number" ? String(v) : v, p)),
  slug: C.custom<string | null>({ type: ["string", "null"] }, (v) => cleanText(v, 120)),
  name: C.custom<string | null>({ type: ["string", "null"] }, (v) => cleanText(v, 120)),
  domain: C.custom<string | null>({ type: ["string", "null"] }, (v) => cleanText(v, 120)),
  last_ok_at: N_TIME,
  last_error: C.nullable(C.obj<NonNullable<ProblemFeed["last_error"]>>({ code: N_CODE, at: N_TIME })),
  kind: C.custom<string | null>({ type: ["string", "null"] }, (v) => cleanText(v, 40)),
  country_code: C.nullable(C.id(/^[A-Z]{2}$/, 2)),
});
export const PROBLEM_FEEDS = C.obj<ProblemFeeds>({ items: C.arr(FEED, 500), available: C.bool, checked_at: N_TIME });

// ---------------------------------------------------------------- оповещения

const PARAMS = C.custom<OpsAlertParams>({ type: "object", additionalProperties: true }, (v) => {
  const src = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: OpsAlertParams = {};
  const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const st = (x: unknown): ProviderHealthStatus | null => (typeof x === "string" && (PROVIDER_STATUSES as readonly string[]).includes(x) ? (x as ProviderHealthStatus) : null);
  if ("status_from" in src) out.status_from = st(src.status_from);
  if ("status_to" in src) out.status_to = st(src.status_to);
  for (const k of ["error_rate", "p95_ms", "pending", "dlq_count", "problem_feeds", "oldest_age_s", "failing", "rl_60", "base"] as const) if (k in src) out[k] = num(src[k]);
  // спринт 9: service_down, deletion_stuck, rate_limit_* — числа, время и имя политики (без id субъектов)
  for (const k of ["down_s", "stuck", "open", "rejected", "share", "subjects", "failclosed", "policies"] as const) if (k in src) out[k] = num(src[k]);
  if ("oldest_open_at" in src) out.oldest_open_at = typeof src.oldest_open_at === "string" ? C.nullable(C.time).parse(src.oldest_open_at, "$") : null;
  if ("policy" in src) out.policy = typeof src.policy === "string" && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(src.policy) ? src.policy : null;
  if (src.pending_by_domain && typeof src.pending_by_domain === "object" && !Array.isArray(src.pending_by_domain)) {
    const pbd: Record<string, number> = {};
    for (const [d, n] of Object.entries(src.pending_by_domain as Record<string, unknown>).slice(0, 30)) if (/^[a-z][a-z0-9_-]{1,40}$/.test(d)) pbd[d] = count(n);
    out.pending_by_domain = pbd;
  }
  if (src.by_class && typeof src.by_class === "object") out.by_class = PARTIAL_BY_CLASS.parse(src.by_class, "$");
  if (Array.isArray(src.route_top)) {
    out.route_top = src.route_top.slice(0, 10).flatMap((r) => {
      try {
        return [ROUTE_COUNT.parse(r, "$")];
      } catch {
        return [];
      }
    });
  }
  return out;
});
/** спринт 9 (§6.2, ревью): ссылка на runbook — только внутри раздела RUNBOOK_BASE_URL (хост и нормализованный путь,
 *  как у notifications и bot-gateway), иначе null: кнопку не показываем, ответ не ломаем. База — из конфигурации
 *  admin-bff (`setRunbookBase` при старте). */
let runbookBase = DEFAULT_RUNBOOK_BASE_URL;
export function setRunbookBase(base: string): void {
  runbookBase = base;
}
export const RUNBOOK_URL = C.custom<string | null>({ type: ["string", "null"] }, (v) => (runbookUrlAllowed(v, runbookBase) ? (v as string) : null));
export const OPS_ALERT = C.obj<OpsAlert>({
  alert_id: C.uuid,
  subject_type: C.oneOf(OPS_ALERT_SUBJECTS),
  subject: C.id(/^[A-Za-z0-9_.:-]{1,120}$/, 120),
  kind: OPS_KIND,
  severity: SEVERITY,
  state: C.oneOf(["open", "resolved"]),
  state_seq: C.int(),
  params: C.fallback(PARAMS, {}),
  opened_at: C.time,
  resolved_at: N_TIME,
  last_notified_at: N_TIME,
  acked_by: C.nullable(C.id(/^[A-Za-z0-9_.:-]{1,64}$/, 64)),
  acked_by_name: C.name,
  acked_at: N_TIME,
  ack_comment: C.custom<string | null>({ type: ["string", "null"] }, (v) => cleanText(v, 300)),
  runbook_url: RUNBOOK_URL,
});
export const OPS_ALERT_PAGE = C.obj<{ items: OpsAlert[]; next_cursor: string | null }>({
  items: C.arrSkip(OPS_ALERT, 100), // неизвестный kind / subject_type — без этого оповещения, не 503 списка
  next_cursor: C.nullable(C.id(/^[A-Za-z0-9_=.:+/-]+$/, 512)),
});

// ---------------------------------------------------------------- очереди

export const STREAM = C.obj<StreamInfo>({
  name: C.id(/^[A-Za-z0-9_-]{1,64}$/, 64),
  subjects: C.arr(C.id(/^[A-Za-z0-9_.*>-]{1,200}$/, 200), 100),
  messages: C.int(),
  bytes: C.int(),
  first_seq: C.int(),
  last_seq: C.int(),
  first_ts: N_TIME,
  consumers: C.int(),
  max_age_s: C.int(),
});
export const CONSUMER = C.obj<ConsumerInfo>({
  durable: DURABLE,
  service: C.custom<string>({ type: "string" }, (v) => (typeof v === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(v) ? v : "—")),
  event_types: C.fallback(C.arr(C.id(/^[A-Za-z0-9_.*>-]{1,200}$/, 200), 100), []),
  num_pending: C.int(),
  num_ack_pending: C.int(),
  num_redelivered: C.int(),
  oldest_pending_age_s: C.nullable(C.num(0, 1e10)),
  last_active_at: N_TIME,
  replay_enabled: C.bool,
  dlq: C.obj<ConsumerInfo["dlq"]>({ count: C.int(), last_at: N_TIME }),
  status: C.oneOf(["ok", "lagging", "stalled"]),
  // P2b: сколько секунд ack floor не двигается при неподтверждённых (null — всё подтверждено); у прежнего ops-monitor нет
  ack_stuck_s: C.fallback(C.nullable(C.num(0, 1e10)), null),
});
export const OUTBOX = C.obj<OutboxInfo>({
  service: SERVICE,
  available: C.bool,
  pending: N_INT,
  failing: N_INT,
  oldest_pending_at: N_TIME,
  max_attempts: N_INT,
  last_error_class: C.nullable(C.id(/^[A-Za-z_.]{1,64}$/, 64)),
  published_24h: N_INT,
  stale_consumers: C.fallback(C.arr(DURABLE, 50), []),
  checked_at: N_TIME,
  // снимок ops-monitor устарел (опрос не прошёл); поля ещё может не быть — null, UI судит по checked_at
  stale: C.fallback(C.nullable(C.bool), null),
});
export const SERVICE_READY = C.obj<ServiceReady>({
  service: SERVICE,
  // ревью 8: снимок устарел → ready «unknown», прежнее значение — в last_ready
  ready: C.oneOf<ServiceReady["ready"]>(["ok", "degraded", "down", "unknown"]),
  last_ready: C.fallback(C.nullable(C.oneOf<NonNullable<ServiceReady["last_ready"]>>(["ok", "degraded", "down"])), null),
  latency_ms: N_INT,
  checked_at: N_TIME,
  stale: C.fallback(C.nullable(C.bool), null),
});

// ---------------------------------------------------------------- DLQ

const DLQ_ITEM_PROPS = {
  dlq_id: DLQ_ID,
  source: C.oneOf<"dlq" | "legacy">(["dlq", "legacy"]),
  consumer: DURABLE,
  service: C.custom<string | null>({ type: ["string", "null"] }, (v) => (typeof v === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(v) ? v : null)),
  event_type: C.custom<string | null>({ type: ["string", "null"] }, (v) => {
    try {
      return v == null ? null : EVENT_TYPE.parse(v, "$");
    } catch {
      return null;
    }
  }),
  event_id: C.nullable(C.id(/^[A-Za-z0-9-]{1,64}$/, 64)),
  occurred_at: N_TIME,
  dead_at: C.time,
  deliveries: N_INT,
  reason_class: C.nullable(C.id(/^[A-Za-z0-9_.:]{1,120}$/, 120)),
  replays: C.fallback(C.int(), 0),
  size_bytes: N_INT,
  // ревью 8: повторённое сообщение остаётся в DLQ (state replayed, replayed_at); старый ops-monitor поля не отдаёт
  state: C.fallback(C.oneOf<DlqItem["state"]>(["present", "replayed"]), "present"),
  replayed_at: C.fallback(N_TIME, null),
};
export const DLQ_ITEM = C.obj<DlqItem>(DLQ_ITEM_PROPS);
export const DLQ_PAGE = C.obj<DlqPage>({ items: C.arr(DLQ_ITEM, 100), next_cursor: C.nullable(C.id(/^[A-Za-z0-9_=.:+/-]+$/, 512)), total: C.int() });
/** Маскированный конверт: ≤ 64 КБ (больше — не показываем, повтор и удаление доступны). */
const ENVELOPE = C.custom<Record<string, unknown> | null>({ type: ["object", "null"], additionalProperties: true }, (v, p) => {
  if (v === null || v === undefined) return null;
  return C.json(65_536).parse(v, p);
});

// ---------------------------------------------------------------- второй слой маскирования DLQ (ревью 8)
/*
 * Те же правила, что у ops-monitor (services/ops-monitor/.../queues/masking.py, перепроверка 8), — второй слой на
 * случай расхождения настроек OPS_PII_KEYS / версий. Порядок правил по ключу (null и true/false не маскируются):
 *  1. whitelist SAFE_KEYS (служебные поля конверта) — ключом не маскируется (значение проверяется по шаблонам);
 *  2. ключ из PII_KEYS (OPS_PII_KEYS по умолчанию, точное совпадение);
 *  3. служебный суффикс (*_id, *_type, *_at, *_count, *_tokens …) — не маскируется (ссылки, счётчики, признаки);
 *  4. имена людей (`name`, `*_name`, `nickname`) — да; имена сущностей (provider_name, city_name, venue_name …) — нет;
 *  5. часть ключа из PII_PARTS (phone, email, text, note, subject, query, title, comment, message, address, username,
 *     token, secret, password, api_key, apikey, authorization, cookie);
 *  - числовые id людей и чатов любой длины: ключ со словом user / chat / from / recipient / tg / telegram и `id`
 *    внутри такого объекта (`{"from": {"id": 7}}`);
 *  - строки с e-mail, телефоном, ≥ 9 цифр, ключом sk-ant-, JWT; числа с ≥ 9 цифрами; UUID остаются (псевдонимные).
 */

export const MASK = "***";
const PII_KEYS = ["telegram_user_id", "telegram_id", "chat_id", "username", "display_name", "first_name", "last_name", "phone", "email", "text", "message", "body", "comment", "reason_text", "initdata", "pin", "code", "token"];
const PII_PARTS = ["phone", "email", "text", "note", "subject", "query", "title", "comment", "message", "address", "username", "token", "secret", "password", "api_key", "apikey", "authorization", "cookie"];
const SAFE_KEYS = new Set(["event_id", "event_type", "occurred_at", "producer", "correlation_id", "causation_id", "schema_version", "trace_id", "request_id", "dedup_key", "idempotency_key", "template"]);
const SAFE_SUFFIXES = new Set(["id", "ids", "type", "kind", "at", "count", "total", "verified", "length", "len", "enabled", "status", "lang", "language", "format", "version", "tokens", "ms"]);
const NON_PERSON_NAME = new Set(
  ("provider city venue country region district airport airline hotel event file source feed service consumer durable stream template category place " +
    "location station host path domain model agent skill field table schema app queue brand product company org organization currency plan level tier " +
    "interest tag genre operation op class metric sport league team artist performer bot attr attribute param parameter property key column index job " +
    "task step route").split(" "),
);
/** владельцы числовых id людей и чатов — как у ops-monitor (ID_OWNER_PARTS / ID_OWNER_TOKENS в masking.py) */
const ID_OWNER_PARTS = ["user", "chat", "recipient", "telegram"];
const ID_OWNER_TOKENS = new Set(["from", "tg"]);
/** Списки правил — для сверки с ops-monitor по packages/contracts/dlq-masking.json (тесты обеих сторон). */
export const DLQ_MASKING_RULES = {
  pii_keys: PII_KEYS,
  pii_key_parts: PII_PARTS,
  safe_keys: [...SAFE_KEYS],
  safe_suffixes: [...SAFE_SUFFIXES],
  non_person_name: [...NON_PERSON_NAME],
  id_owner_parts: ID_OWNER_PARTS,
  id_owner_tokens: [...ID_OWNER_TOKENS],
};
const UUID_V = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENSITIVE_V = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // e-mail
  /\d{9,}/, // длинное число (Telegram ID, карта)
  /sk-ant-[A-Za-z0-9_-]+/, // ключ Anthropic
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/, // JWT
];
const PHONE_V = /(?<![\w])\+?\d[\d\s\-().]{7,}\d(?![\w])/g;

/** `firstName` / `First-Name` / `FIRST_NAME` / `userID` → `first_name` / … / `user_id` (как norm_key ops-monitor). */
export function normKey(k: string): string {
  return k
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}
const tokensOf = (norm: string) => norm.split("_").filter(Boolean);
const PII_KEY_SET = new Set([...PII_KEYS.map(normKey), ...PII_KEYS.map((k) => normKey(k).replace(/_/g, ""))]);
const PII_PART_LIST = PII_PARTS.map((p) => normKey(p).replace(/_/g, ""));

function personName(tokens: string[]): boolean | null {
  const last = tokens.at(-1) ?? "";
  if (last === "name" || last === "names") return !(tokens.length >= 2 && NON_PERSON_NAME.has(tokens.at(-2)!));
  if (last.endsWith("name") && last.length > 4) return !NON_PERSON_NAME.has(last.slice(0, -4));
  if (tokens.some((t) => t.includes("name"))) return true;
  return null;
}

/** Ключ, значение которого маскируется целиком. */
export function piiKey(key: string): boolean {
  const norm = normKey(key);
  const compact = norm.replace(/_/g, "");
  if (SAFE_KEYS.has(norm)) return false;
  if (PII_KEY_SET.has(norm) || PII_KEY_SET.has(compact)) return true;
  const tokens = tokensOf(norm);
  if (tokens.length >= 2 && SAFE_SUFFIXES.has(tokens.at(-1)!)) return false;
  const person = personName(tokens);
  if (person !== null) return person;
  return PII_PART_LIST.some((p) => norm.includes(p) || compact.includes(p));
}
/** Ключ про человека / чат / получателя: числовые id под ним — PII любой длины. */
export function idOwner(key: string): boolean {
  const norm = normKey(key);
  const compact = norm.replace(/_/g, "");
  return ID_OWNER_PARTS.some((p) => compact.includes(p)) || tokensOf(norm).some((t) => ID_OWNER_TOKENS.has(t));
}
const idKey = (norm: string) => {
  const t = tokensOf(norm);
  return t.length > 0 && (t.at(-1) === "id" || t.at(-1) === "ids");
};
const numeric = (v: unknown) => (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^-?\d+$/.test(v.trim()));
function sensitiveString(v: string): boolean {
  if (UUID_V.test(v)) return false;
  if (SENSITIVE_V.some((re) => re.test(v))) return true;
  return [...v.matchAll(PHONE_V)].some((m) => (m[0].match(/\d/g) ?? []).length >= 9);
}

/**
 * Повторное маскирование конверта DLQ в admin-bff (второй слой поверх ops-monitor). Уже замаскированное («***»)
 * не трогается. → копия и пути, замаскированные здесь впервые.
 */
export function remaskEnvelope(env: Record<string, unknown>): { envelope: Record<string, unknown>; paths: string[] } {
  const paths: string[] = [];
  const walk = (v: unknown, path: string, depth: number, idCtx: boolean, numericId: boolean): unknown => {
    if (v === MASK) return v;
    if (depth > 20) {
      paths.push(path);
      return MASK;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, depth + 1, idCtx, numericId));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const child = path ? `${path}.${k}` : k;
        if (x !== null && x !== undefined && typeof x !== "boolean" && x !== MASK && piiKey(k)) {
          paths.push(child);
          out[k] = MASK;
          continue;
        }
        const owner = idOwner(k);
        out[k] = walk(x, child, depth + 1, idCtx || owner, owner || (idCtx && idKey(normKey(k))));
      }
      return out;
    }
    if (numericId && numeric(v)) {
      paths.push(path);
      return MASK;
    }
    if (typeof v === "string" && sensitiveString(v)) {
      paths.push(path);
      return MASK;
    }
    if (typeof v === "number" && Number.isInteger(v) && String(Math.abs(v)).length >= 9) {
      paths.push(path);
      return MASK;
    }
    return v;
  };
  return { envelope: walk(env, "", 0, false, false) as Record<string, unknown>, paths };
}

const DLQ_DETAIL_RAW = C.obj<DlqDetail>({
  ...DLQ_ITEM_PROPS,
  envelope_masked: ENVELOPE,
  masked_fields: C.fallback(C.arr(C.id(/^[A-Za-z0-9_.[\]$-]{1,200}$/, 200), 500), []),
  envelope_readable: C.bool,
});
/** Сообщение DLQ: конверт ops-monitor + второй слой маскирования здесь (пути добавляются к masked_fields). */
export const DLQ_DETAIL = C.map(DLQ_DETAIL_RAW, DLQ_DETAIL_RAW.schema, (d) => {
  if (!d.envelope_masked) return d;
  const { envelope, paths } = remaskEnvelope(d.envelope_masked);
  const fields = [...d.masked_fields];
  for (const x of paths) if (!fields.includes(x) && /^[A-Za-z0-9_.[\]$-]{1,200}$/.test(x) && fields.length < 500) fields.push(x);
  return { ...d, envelope_masked: envelope, masked_fields: fields };
});
const SKIPPED = C.arr(C.obj<{ dlq_id: string; reason: string }>({ dlq_id: DLQ_ID, reason: C.id(/^[A-Z][A-Z0-9_]{1,63}$/, 64) }), 500);
export const DLQ_RESULT = C.obj<DlqCommandResult>({ action_id: C.uuid, requested: C.int(), done: C.int(), skipped: SKIPPED });
const SELECTOR = C.custom<DlqAction["selector"]>({ type: "object", additionalProperties: true }, (v) => {
  const src = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: DlqAction["selector"] = {};
  if (Array.isArray(src.ids)) out.ids = src.ids.filter((x): x is string => typeof x === "string" && /^(dlq|legacy):[0-9]{1,19}$/.test(x)).slice(0, 100);
  const f = src.filter;
  if (f && typeof f === "object" && !Array.isArray(f)) {
    const ff = f as Record<string, unknown>;
    if (typeof ff.consumer === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(ff.consumer)) {
      out.filter = { consumer: ff.consumer };
      if (typeof ff.event_type === "string" && KEY_RE.test(ff.event_type)) out.filter.event_type = ff.event_type;
      if (ff.source === "dlq" || ff.source === "legacy") out.filter.source = ff.source;
      if (ff.state === "present" || ff.state === "replayed" || ff.state === "all") out.filter.state = ff.state;
      for (const k of ["dead_from", "dead_to"] as const) {
        const t = typeof ff[k] === "string" ? C.nullable(C.time).parse(ff[k], "$") : null;
        if (t) out.filter[k] = t;
      }
    }
  }
  return out;
});
export const DLQ_ACTION = C.obj<DlqAction>({
  action_id: C.uuid,
  kind: C.oneOf(["replay", "delete"]),
  by: C.id(/^[A-Za-z0-9_.:-]{1,64}$/, 64),
  by_name: C.name,
  reason: C.custom<string>({ type: "string" }, (v) => cleanText(v, 300) ?? "—"),
  selector: SELECTOR,
  requested: C.int(),
  done: C.int(),
  skipped: C.fallback(SKIPPED, []),
  at: C.time,
});
export const DLQ_ACTION_PAGE = C.obj<{ items: DlqAction[]; next_cursor: string | null }>({
  items: C.arr(DLQ_ACTION, 100),
  next_cursor: C.nullable(C.id(/^[A-Za-z0-9_=.:+/-]+$/, 512)),
});

// ---------------------------------------------------------------- сводка и статистика дашборда

const STATUS_COUNTS = Object.fromEntries(PROVIDER_STATUSES.map((k) => [k, C.fallback(C.int(), 0)])) as Record<ProviderHealthStatus, Codec<number>>;
export const OPS_SUMMARY = C.obj<OpsSummary>({
  generated_at: C.time,
  providers: C.nullable(
    C.obj<NonNullable<OpsSummary["providers"]>>({
      ...STATUS_COUNTS,
      items: C.arr(C.obj<NonNullable<OpsSummary["providers"]>["items"][number]>({ provider: PROVIDER_ID, status: STATUS, since: N_TIME }), 50),
    }),
  ),
  // ревью 8: устаревшие снимки — сервисы со «stale» не входят в up/down, очереди и outbox помечаются
  services: C.nullable(
    C.obj<NonNullable<OpsSummary["services"]>>({ up: C.int(), total: C.int(), down: C.arr(SERVICE, 100), stale: C.fallback(C.arr(SERVICE, 100), []) }),
  ),
  queues: C.nullable(
    C.obj<NonNullable<OpsSummary["queues"]>>({
      total_pending: C.int(),
      lagging: C.int(),
      stalled: C.int(),
      dlq_messages: C.int(),
      dlq_new_24h: C.int(),
      stale: C.fallback(C.bool, false),
    }),
  ),
  outbox: C.nullable(
    C.obj<NonNullable<OpsSummary["outbox"]>>({ pending: C.int(), failing: C.int(), stuck_services: C.arr(SERVICE, 100), stale_services: C.fallback(C.arr(SERVICE, 100), []) }),
  ),
  alerts: C.obj<OpsSummary["alerts"]>({ critical: C.fallback(C.int(), 0), warning: C.fallback(C.int(), 0), info: C.fallback(C.int(), 0) }),
  // спринт 9: снимок саги удаления (ops-monitor до спринта 9 — блока нет → null)
  deletions: C.fallback(
    C.nullable(C.obj<OpsDeletionsBrief>({ open: N_INT, stuck: N_INT, available: C.bool, checked_at: N_TIME })),
    null,
  ),
});

const N_SHARE = C.nullable(RATE);
export const TRIPS_STATS = C.obj<TripsStats>({
  builds: C.int(),
  by_caller: C.obj<TripsStats["by_caller"]>({ "telegram-bff": C.fallback(C.int(), 0), watch: C.fallback(C.int(), 0), "ai-concierge": C.fallback(C.int(), 0) }),
  reused_share: N_SHARE,
  by_trip_kind: C.obj<TripsStats["by_trip_kind"]>({ trip: C.int(), ticket_only: C.int(), not_available: C.int() }),
  complete_share: N_SHARE,
  budget: C.obj<TripsStats["budget"]>({ with_budget: C.int(), within: C.int(), over: C.int(), unknown: C.int() }),
  by_recommended_tier: C.obj<TripsStats["by_recommended_tier"]>({ economy: C.int(), comfort: C.int(), premium: C.int() }),
  no_flight_total: C.int(),
});
const CITY = C.custom<string | null>({ type: ["string", "null"] }, (v) => cleanText(v, 80));
const IATA = C.custom<string | null>({ type: ["string", "null"] }, (v) => (typeof v === "string" && /^[A-Z0-9]{3}$/.test(v) ? v : null));
const COUNTRY = C.custom<string | null>({ type: ["string", "null"] }, (v) => (typeof v === "string" && /^[A-Z]{2}$/.test(v) ? v : null));
const BAND = C.oneOf<NoFlightPair["band"]>(["lt600", "ge600", "unknown"]);
export const NO_FLIGHT_STATS = C.obj<NoFlightStats>({
  total: C.int(),
  by_reason: COUNTS,
  bands: C.obj<NoFlightStats["bands"]>({ lt600: C.int(), ge600: C.int(), unknown: C.int() }),
  pairs: C.arr(
    C.obj<NoFlightPair>({
      origin_city: CITY,
      origin_iata: IATA,
      origin_country: COUNTRY,
      dest_city: CITY,
      dest_iata: IATA,
      dest_country: COUNTRY,
      distance_km: C.nullable(C.int(0, 40_000)),
      band: BAND,
      count: C.int(),
      by_reason: C.fallback(COUNTS, {}),
    }),
    50,
  ),
});
export const NEWS_STATS = C.obj<NewsStats>({
  items: C.obj<NewsStats["items"]>({ article: C.int(), event_update: C.int() }),
  hidden: C.int(),
  sources: C.obj<NewsStats["sources"]>({ enabled: C.int(), disabled: C.int(), problem: C.int() }),
  last_collect_at: N_TIME,
});
const USER_STATUSES = ["ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED"] as const;
export const USERS_STATS = C.obj<DashboardUsers>({
  total: C.int(),
  new_in_period: C.int(),
  onboarding_completed_pct: C.num(0, 100),
  by_status: C.obj<DashboardUsers["by_status"]>(Object.fromEntries(USER_STATUSES.map((k) => [k, C.fallback(C.int(), 0)])) as never),
  // user-admin до спринта 8 их не отдаёт: нет поля → ответ испорчен (блок «нет данных»), нулей не подставляем
  active_in_period: C.int(),
  active_today: C.int(),
});
export const SUPPORT_STATS = C.obj<{
  open: number;
  in_progress: number;
  waiting_customer: number;
  breached: number;
  avg_first_response_minutes: number | null;
  avg_resolution_minutes: number | null;
}>({
  open: C.int(),
  in_progress: C.int(),
  waiting_customer: C.int(),
  breached: C.int(),
  avg_first_response_minutes: C.nullable(C.num(0, 1e9)),
  avg_resolution_minutes: C.nullable(C.num(0, 1e9)),
});
const DAY_BUDGET = C.obj<AiAgentDayBudget>({
  spent_usd: C.usd,
  limit_usd: C.usd,
  pct: C.nullable(C.num(0, 1e6)),
  source: C.nullable(C.oneOf(["admin", "env"])),
});
export const DASHBOARD_AI_AGENT = C.obj<DashboardAiAgent>({
  agent_id: C.id(/^[a-z][a-z0-9_-]{1,31}$/, 32),
  name: C.text(120),
  state: C.oneOf(["normal", "degraded", "paused", "exhausted"]),
  day: C.nullable(DAY_BUDGET),
  month_cost_usd: C.nullable(C.usd),
  paused: C.bool,
});
