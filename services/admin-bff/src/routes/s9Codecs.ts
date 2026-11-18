/**
 * Спринт 9 (docs/sprint9/INTERNAL_API.md §1.4, §2.4, §12): нормализация ответов identity-consent (сага удаления) и
 * ops-monitor (лимиты запросов). Испорченный ответ → 503 UPSTREAM_UNAVAILABLE {service}. PII нет: user_id — псевдоним,
 * субъекты лимитов — псевдонимы (хеш IP / e-mail, user_id, staff_id), причины переопределения — очищенный текст.
 */
import type {
  DeletionDetail,
  DeletionDomain,
  DeletionHistoryItem,
  DeletionRow,
  RateLimitCounts,
  RateLimitHistory,
  RateLimitOverride,
  RateLimitPolicy,
} from "@tilhero/contracts/admin";
import { C, pageOf } from "../codec.js";
import { cleanText } from "./travel.js";

const N_TIME = C.nullable(C.time);
const DOMAIN = C.id(/^[a-z][a-z0-9_-]{1,40}$/, 41);

// ---------------------------------------------------------------- удаления

const DELETION_ROW_PROPS = {
  request_id: C.uuid,
  user_id: C.uuid,
  status: C.oneOf<DeletionRow["status"]>(["REQUESTED", "STUCK", "COMPLETED"]),
  requested_at: C.time,
  completed_at: N_TIME,
  stuck_at: N_TIME,
  attempts: C.int(0, 1_000_000),
  next_retry_at: N_TIME,
  acked: C.int(0, 100),
  expected: C.int(0, 100),
  pending_domains: C.fallback(C.arr(DOMAIN, 50), []),
};
export const DELETION_ROW = C.obj<DeletionRow>(DELETION_ROW_PROPS);
export const DELETION_PAGE = pageOf(DELETION_ROW, 100);
const DELETION_DOMAIN = C.obj<DeletionDomain>({
  domain: DOMAIN,
  acked_at: N_TIME,
  mode: C.custom<DeletionDomain["mode"]>({ type: ["string", "null"] }, (v) => (v === "deleted" || v === "anonymized" ? v : null)),
  // до §12 Q1 поля не было: acked выводится из времени ACK
  acked: C.custom<boolean>({ type: "boolean" }, (v) => v === true),
});
/** by: user | system | staff_id (UUID) — иное (испорченное) значение → «system» не подставляем: ответ испорчен. */
const HISTORY_BY = C.id(/^(user|system|[0-9a-fA-F-]{36})$/, 36);
const DELETION_HISTORY = C.obj<DeletionHistoryItem>({ attempt: C.int(1, 1_000_000), sent_at: C.time, by: HISTORY_BY, by_name: C.name });
export const DELETION_DETAIL = C.obj<DeletionDetail>({
  ...DELETION_ROW_PROPS,
  domains: C.arr(DELETION_DOMAIN, 50),
  history: C.fallback(C.arr(DELETION_HISTORY, 500), []),
});

// ---------------------------------------------------------------- лимиты

export const POLICY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const POLICY = C.id(POLICY_RE, 64);
const COUNT = C.custom<number>({ type: "integer" }, (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0));
export const RL_COUNTS_PROPS = { allowed: COUNT, rejected: COUNT, failopen: COUNT, failclosed: COUNT };
const RL_COUNTS = C.obj<RateLimitCounts>(RL_COUNTS_PROPS);
const ZERO: RateLimitCounts = { allowed: 0, rejected: 0, failopen: 0, failclosed: 0 };
const LIMIT = C.int(1, 1_000_000);
const WINDOW = C.int(1, 86_400 * 7);
const OVERRIDE = C.obj<RateLimitOverride>({
  limit: LIMIT,
  window_s: WINDOW,
  burst: C.nullable(LIMIT),
  by: C.id(/^[A-Za-z0-9_.:-]{1,64}$/, 64),
  by_name: C.name,
  at: C.time,
  reason: C.custom<string>({ type: "string" }, (v) => cleanText(v, 300) ?? "—"),
  expires_at: N_TIME,
});
export const RATE_LIMIT_POLICY = C.obj<RateLimitPolicy>({
  policy: POLICY,
  service: C.id(/^(\*|[a-z][a-z0-9-]{1,40})$/, 41),
  subject: C.oneOf<RateLimitPolicy["subject"]>(["user", "staff", "caller", "ip", "email"]),
  limit: LIMIT,
  window_s: WINDOW,
  burst: LIMIT,
  fail: C.oneOf<RateLimitPolicy["fail"]>(["open", "closed"]),
  env: C.fallback(C.nullable(C.id(/^[A-Z][A-Z0-9_]{1,63}$/, 64)), null),
  default: C.obj<RateLimitPolicy["default"]>({ limit: LIMIT, window_s: WINDOW, burst: LIMIT }),
  source: C.oneOf<RateLimitPolicy["source"]>(["default", "override"]),
  override: C.nullable(OVERRIDE),
  last_15m: C.fallback(RL_COUNTS, ZERO),
});
/** ops-monitor отдаёт список политик — admin-bff отдаёт {items}. */
export const RATE_LIMIT_POLICIES = C.custom<{ items: RateLimitPolicy[] }>(
  { type: "object", properties: { items: { type: "array", items: RATE_LIMIT_POLICY.schema } }, "x-contract-required": ["items"] },
  (v, p) => ({ items: C.arr(RATE_LIMIT_POLICY, 100).parse(v, p) }),
);
export const RATE_LIMIT_HISTORY = C.obj<RateLimitHistory>({
  policy: POLICY,
  range: C.oneOf<RateLimitHistory["range"]>(["24h", "7d"]),
  step: C.oneOf<RateLimitHistory["step"]>(["5m", "1h"]),
  points: C.arr(C.obj<RateLimitHistory["points"][number]>({ t: C.time, ...RL_COUNTS_PROPS }), 2100),
  top_subjects_15m: C.fallback(
    C.arr(C.obj<RateLimitHistory["top_subjects_15m"][number]>({ subject: C.id(/^[A-Za-z0-9_.:@-]{1,64}$/, 64), rejected: COUNT }), 50),
    [],
  ),
});
