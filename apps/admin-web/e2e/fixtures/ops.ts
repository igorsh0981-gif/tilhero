/**
 * Sprint 8 fixtures of the mock admin-bff: provider health, history, feeds, ops alerts, queues, outbox, DLQ (masked
 * envelopes), command history, the ops summary and the full dashboard (DashboardV2). Numbers are realistic and stable.
 */
import type {
  ConsumerInfo,
  DashboardBlock,
  DashboardV2,
  DlqAction,
  DlqDetail,
  DlqItem,
  NoFlightStats,
  OpsAlert,
  OpsSummary,
  OutboxInfo,
  ProblemFeeds,
  ProviderHealth,
  ProviderHistory,
  ServiceReady,
  StreamInfo,
  DeletionDetail,
  RateLimitHistory,
  RateLimitPolicy,
} from "@tilhero/contracts/admin";
import { ID, USER, iso } from "./data";
import * as F from "./data";
import * as A from "./ai";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const BY0 = { auth: 0, rate_limit: 0, quota: 0, timeout: 0, server: 0, network: 0, bad_response: 0, circuit_open: 0 };

export const ALERT = {
  aviasales: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a60",
  route: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a61",
  dlq: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a62",
  resolved: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a63",
};

function prov(p: Partial<ProviderHealth> & { provider: string; title: string }): ProviderHealth {
  return {
    status: "ok",
    status_since: iso(-3 * DAY),
    window: { minutes: 5, calls: 0, error_rate: 0, p50_ms: null, p95_ms: null, by_class: { ...BY0 }, route_unsupported: 0, route_top: [] },
    last_24h: { calls: 0, error_rate: 0, p95_ms: null, route_unsupported: 0 },
    breaker: "closed",
    quota: null,
    last_error: null,
    last_route_error: null,
    last_probe: null,
    open_alerts: [],
    stale_since: null,
    probe_supported: ["aviasales", "liteapi", "ticketmaster", "osm", "cbu"].includes(p.provider),
    ...p,
  };
}

export function providers(down = false): ProviderHealth[] {
  return [
    prov({
      provider: "aviasales",
      title: "Aviasales",
      status: down ? "down" : "degraded",
      status_since: iso(-42 * MIN),
      window: { minutes: 5, calls: 46, error_rate: down ? 0.61 : 0.152, p50_ms: 820, p95_ms: 4100, by_class: { ...BY0, server: down ? 22 : 5, timeout: down ? 6 : 2 }, route_unsupported: 4, route_top: [{ location: "FRU", count: 3 }, { location: "BSZ", count: 1 }] },
      last_24h: { calls: 2210, error_rate: 0.031, p95_ms: 3900, route_unsupported: 14 },
      breaker: down ? "open" : "half_open",
      quota: { used: 4520, limit: 5000, pct: 90.4 },
      last_error: { code: "PROVIDER_UNAVAILABLE", reason: "upstream_5xx", message: "Bad gateway", http_status: 502, at: iso(-3 * MIN) },
      last_route_error: { code: "ROUTE_NOT_SUPPORTED", location: "FRU", route: "TAS-FRU", at: iso(-18 * MIN) },
      last_probe: { ok: true, latency_ms: 640, code: null, at: iso(-2 * HOUR) },
      open_alerts: [
        { alert_id: ALERT.aviasales, kind: "status", severity: down ? "critical" : "warning" },
        { alert_id: ALERT.route, kind: "route_spike", severity: "warning" },
      ],
    }),
    prov({
      provider: "liteapi",
      title: "LiteAPI",
      window: { minutes: 5, calls: 21, error_rate: 0, p50_ms: 1300, p95_ms: 3200, by_class: { ...BY0 }, route_unsupported: 0, route_top: [] },
      last_24h: { calls: 980, error_rate: 0.004, p95_ms: 3400, route_unsupported: 0 },
      quota: { used: 980, limit: 10000, pct: 9.8 },
      last_probe: { ok: true, latency_ms: 910, code: null, at: iso(-5 * HOUR) },
    }),
    prov({
      provider: "ticketmaster",
      title: "Ticketmaster",
      status: "idle",
      status_since: iso(-6 * HOUR),
      last_24h: { calls: 12, error_rate: 0, p95_ms: 880, route_unsupported: 0 },
      quota: { used: 12, limit: 5000, pct: 0.2 },
      last_probe: { ok: true, latency_ms: 430, code: null, at: iso(-9 * MIN) },
    }),
    prov({
      provider: "osm",
      title: "OSM / Overpass",
      window: { minutes: 5, calls: 9, error_rate: 0, p50_ms: 640, p95_ms: 2100, by_class: { ...BY0 }, route_unsupported: 0, route_top: [] },
      last_24h: { calls: 410, error_rate: 0.012, p95_ms: 2600, route_unsupported: 0 },
      breaker: "closed",
    }),
    prov({ provider: "cbu", title: "ЦБ РУз", status: "idle", status_since: iso(-20 * HOUR), last_24h: { calls: 4, error_rate: 0, p95_ms: 310, route_unsupported: 0 }, last_probe: { ok: true, latency_ms: 220, code: null, at: iso(-11 * MIN) } }),
    prov({
      provider: "anthropic",
      title: "Anthropic",
      window: { minutes: 5, calls: 64, error_rate: 0.016, p50_ms: 3100, p95_ms: 9400, by_class: { ...BY0, rate_limit: 1 }, route_unsupported: 0, route_top: [] },
      last_24h: { calls: 3120, error_rate: 0.008, p95_ms: 9800, route_unsupported: 0 },
      breaker: "closed",
    }),
    prov({
      provider: "news_feeds",
      title: "Ленты новостей",
      window: { minutes: 5, calls: 14, error_rate: 0.071, p50_ms: 700, p95_ms: 5100, by_class: { ...BY0, bad_response: 1 }, route_unsupported: 0, route_top: [] },
      last_24h: { calls: 1610, error_rate: 0.044, p95_ms: 6200, route_unsupported: 0 },
      breaker: null,
    }),
  ];
}

/** history with a deterministic shape: a dip of errors 40 min ago, route errors in the last hour */
export function history(provider: string, range: "24h" | "7d", now = Date.now()): ProviderHistory {
  const step = range === "24h" ? 5 * MIN : HOUR;
  const n = range === "24h" ? 288 : 168;
  const end = Math.floor(now / step) * step;
  const points: ProviderHistory["points"] = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = end - i * step;
    const hour = new Date(t).getUTCHours();
    const busy = 0.35 + 0.65 * Math.max(0, Math.sin(((hour - 2) / 24) * Math.PI * 2) + 0.4);
    if (provider === "ticketmaster" && i % 7) continue;
    const calls = Math.round((range === "24h" ? 9 : 90) * busy) + (i % 5);
    if (!calls) continue;
    const recent = range === "24h" ? i < 9 : i < 1;
    const errors = provider === "aviasales" && recent ? Math.round(calls * 0.18) : i % 37 === 0 ? 1 : 0;
    const route = provider === "aviasales" && (range === "24h" ? i < 12 : i < 2) ? 1 + (i % 2) : 0;
    points.push({
      t: new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z"),
      calls,
      errors,
      by_class: { ...BY0, server: errors },
      route_unsupported: route,
      p50_ms: 700 + (i % 9) * 30,
      p95_ms: Math.round((recent ? 3900 : 2300) + 260 * Math.sin(i / 9)),
    });
  }
  return {
    provider,
    range,
    step: range === "24h" ? "5m" : "1h",
    points,
    transitions:
      provider === "aviasales"
        ? [
            { from: "ok", to: "degraded", at: iso(-42 * MIN) },
            { from: "degraded", to: "ok", at: iso(-5 * HOUR) },
            { from: "ok", to: "degraded", at: iso(-6 * HOUR) },
          ]
        : [],
    route_top: provider === "aviasales" ? [{ location: "FRU", count: 12 }, { location: "BSZ", count: 4 }, { location: "OSS", count: 1 }] : [],
  };
}

export function feeds(): ProblemFeeds {
  return {
    available: true,
    checked_at: iso(-6 * MIN),
    items: [
      { source_id: "17", slug: "gazeta-uz", name: "Газета.uz", domain: "gazeta.uz", last_ok_at: iso(-14 * HOUR), last_error: { code: "FEED_HTTP_403", at: iso(-12 * MIN) }, kind: "media", country_code: "UZ" },
      { source_id: "23", slug: "kultura-kz", name: "Kultura.kz", domain: "kultura.kz", last_ok_at: null, last_error: { code: "FEED_TIMEOUT", at: iso(-40 * MIN) }, kind: "official", country_code: "KZ" },
    ],
  };
}

export function opsAlerts(down = false): OpsAlert[] {
  return [
    {
      alert_id: ALERT.aviasales,
      subject_type: "provider",
      subject: "aviasales",
      kind: "status",
      severity: down ? "critical" : "warning",
      state: "open",
      state_seq: 4,
      params: { status_from: "ok", status_to: down ? "down" : "degraded", error_rate: down ? 0.61 : 0.152, p95_ms: 4100, by_class: { server: 5, timeout: 2 } },
      opened_at: iso(-42 * MIN),
      resolved_at: null,
      last_notified_at: iso(-42 * MIN),
      acked_by: null,
      acked_by_name: null,
      acked_at: null,
      ack_comment: null,
      runbook_url: "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/provider-gateway.md#aviasales",
    },
    {
      alert_id: ALERT.route,
      subject_type: "provider",
      subject: "aviasales",
      kind: "route_spike",
      severity: "warning",
      state: "open",
      state_seq: 1,
      params: { route_top: [{ location: "FRU", count: 12 }, { location: "BSZ", count: 4 }], rl_60: 16, base: 1 },
      opened_at: iso(-25 * MIN),
      resolved_at: null,
      last_notified_at: iso(-25 * MIN),
      acked_by: null,
      acked_by_name: null,
      acked_at: null,
      ack_comment: null,
      runbook_url: "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/provider-gateway.md#route-spike",
    },
    {
      alert_id: ALERT.dlq,
      subject_type: "dlq",
      subject: "notifications_watch_changes",
      kind: "dlq_growth",
      severity: "warning",
      state: "open",
      state_seq: 1,
      params: { dlq_count: 3 },
      opened_at: iso(-3 * HOUR),
      resolved_at: null,
      last_notified_at: iso(-3 * HOUR),
      acked_by: ID.ops,
      acked_by_name: null,
      acked_at: iso(-2 * HOUR),
      ack_comment: "Разбираем обработчик",
      runbook_url: "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/nats.md#dlq-growth",
    },
  ];
}
export function resolvedAlerts(): OpsAlert[] {
  return [
    {
      alert_id: ALERT.resolved,
      subject_type: "provider",
      subject: "liteapi",
      kind: "status",
      severity: "critical",
      state: "resolved",
      state_seq: 2,
      params: { status_from: "ok", status_to: "down", error_rate: 0.72 },
      opened_at: iso(-30 * HOUR),
      resolved_at: iso(-29 * HOUR),
      last_notified_at: iso(-30 * HOUR),
      acked_by: ID.admin,
      acked_by_name: null,
      acked_at: iso(-30 * HOUR + 4 * MIN),
      ack_comment: "Ключ перевыпущен",
      runbook_url: null,
    },
  ];
}

export function streams(): StreamInfo[] {
  return [
    { name: "TILHERO", subjects: ["tilhero.>"], messages: 48210, bytes: 31_457_280, first_seq: 1_120_400, last_seq: 1_168_610, first_ts: iso(-7 * DAY), consumers: 18, max_age_s: 7 * 86400 },
    { name: "TILHERO_DLQ", subjects: ["tilherodlq.>"], messages: 4, bytes: 3_412, first_seq: 1, last_seq: 7, first_ts: iso(-2 * DAY), consumers: 0, max_age_s: 30 * 86400 },
  ];
}

export function consumers(lag = false): ConsumerInfo[] {
  const c = (durable: string, service: string, types: string[], p: Partial<ConsumerInfo> = {}): ConsumerInfo => ({
    durable,
    service,
    event_types: types,
    num_pending: 0,
    num_ack_pending: 0,
    num_redelivered: 0,
    oldest_pending_age_s: null,
    last_active_at: iso(-40_000),
    replay_enabled: true,
    dlq: { count: 0, last_at: null },
    status: "ok",
    ack_stuck_s: null,
    ...p,
  });
  return [
    c("notifications_watch_changes", "notifications", ["watch.change.detected.v1"], { num_redelivered: 12, dlq: { count: 3, last_at: iso(-3 * HOUR) } }),
    c("notifications_ops_alerts", "notifications", ["ops.alert.raised.v1"]),
    c("ai_control_usage", "ai-control", ["ai.request.completed.v1", "ai.request.failed.v1"], lag ? { num_pending: 1840, num_ack_pending: 40, oldest_pending_age_s: 1260, status: "lagging", ack_stuck_s: 25 } : { num_pending: 2 }),
    c("watch_offer_rebuilt", "watch", ["offer.rebuilt.v1"], { dlq: { count: 1, last_at: iso(-26 * HOUR) }, replay_enabled: false }),
    c("recommendations_events", "recommendations", ["event.published.v1", "event.updated.v1", "event.cancelled.v1"]),
    c("user_admin_users", "user-admin", ["user.registered.v1", "user.deleted.v1"], lag ? { num_pending: 3, num_ack_pending: 14, oldest_pending_age_s: 60, last_active_at: iso(-20_000), status: "stalled", ack_stuck_s: 23 * 60 } : {}),
  ];
}

export function outbox(): OutboxInfo[] {
  const o = (service: string, p: Partial<OutboxInfo> = {}): OutboxInfo => ({
    service,
    available: true,
    pending: 0,
    failing: 0,
    oldest_pending_at: null,
    max_attempts: 0,
    last_error_class: null,
    published_24h: 0,
    stale_consumers: [],
    checked_at: iso(-30_000),
    stale: null,
    ...p,
  });
  return [
    o("offers", { pending: 2, oldest_pending_at: iso(-20_000), published_24h: 412 }),
    o("ai-concierge", { published_24h: 1290 }),
    o("news", { pending: 6, failing: 6, oldest_pending_at: iso(-14 * MIN), max_attempts: 7, last_error_class: "nats.errors.TimeoutError", published_24h: 88 }),
    o("watch", { published_24h: 140, stale_consumers: ["watch_offer_rebuilt"], stale: true, checked_at: iso(-14 * MIN) }),
    o("provider-gateway", { available: false, pending: null, failing: null, max_attempts: null, published_24h: null }),
    o("telegram-bot-gateway", { available: false, pending: null, failing: null, max_attempts: null, published_24h: null }),
  ];
}

export function services(): ServiceReady[] {
  const names = ["identity-consent", "preferences", "events", "offers", "watch", "news", "notifications", "ai-concierge", "ai-control", "provider-gateway", "telegram-bot-gateway", "ops-monitor"];
  // preferences: a snapshot of 16 min ago without the stale flag (older ops-monitor) — the UI still says «stale»
  // ops-monitor с ревью 8: устаревший снимок — ready «unknown» и прежнее значение в last_ready (ops-monitor стенда — так)
  return names.map((s) =>
    s === "ops-monitor"
      ? { service: s, ready: "unknown" as const, last_ready: "ok" as const, latency_ms: 9, checked_at: iso(-20 * MIN), stale: true }
      : { service: s, ready: s === "news" ? ("degraded" as const) : ("ok" as const), last_ready: null, latency_ms: s === "news" ? 1240 : 12 + s.length, checked_at: iso(s === "preferences" ? -16 * MIN : -30_000), stale: null },
  );
}

const EVENT = "5e2c1a7b-0f3d-4b8e-9c6a-7d1e2f3a4b5c";
export function dlqItems(): DlqItem[] {
  return [
    { dlq_id: "dlq:42", source: "dlq", consumer: "notifications_watch_changes", service: "notifications", event_type: "watch.change.detected.v1", event_id: EVENT, occurred_at: iso(-3 * HOUR - 2 * MIN), dead_at: iso(-3 * HOUR), deliveries: 5, reason_class: "handler_error:KeyError", replays: 0, size_bytes: 812, state: "present", replayed_at: null },
    { dlq_id: "dlq:41", source: "dlq", consumer: "notifications_watch_changes", service: "notifications", event_type: "watch.change.detected.v1", event_id: "6f3d2b8c-1a4e-4c9f-8d7b-8e2f3a4b5c6d", occurred_at: iso(-5 * HOUR), dead_at: iso(-5 * HOUR + MIN), deliveries: 5, reason_class: "handler_error:KeyError", replays: 1, size_bytes: 798, state: "present", replayed_at: null },
    { dlq_id: "dlq:40", source: "dlq", consumer: "notifications_watch_changes", service: "notifications", event_type: "watch.change.detected.v1", event_id: "7a4e3c9d-2b5f-4d0a-9e8c-9f3a4b5c6d7e", occurred_at: iso(-9 * HOUR), dead_at: iso(-9 * HOUR + MIN), deliveries: 5, reason_class: "transient_exhausted", replays: 3, size_bytes: 805, state: "present", replayed_at: null },
    { dlq_id: "legacy:31877", source: "legacy", consumer: "watch_offer_rebuilt", service: "watch", event_type: "offer.rebuilt.v1", event_id: "8b5f4d0e-3c6a-4e1b-8f9d-0a4b5c6d7e8f", occurred_at: iso(-26 * HOUR), dead_at: iso(-26 * HOUR + 2 * MIN), deliveries: 5, reason_class: "legacy", replays: 0, size_bytes: 1240, state: "present", replayed_at: null },
    // ревью 8: уже повторено (обработчик снова упал бы — сообщение осталось в DLQ с пометкой)
    { dlq_id: "dlq:39", source: "dlq", consumer: "recommendations_reactions", service: "recommendations", event_type: "event.reaction.changed.v1", event_id: "9d6a5e1f-4d7b-4f2c-9a0e-2c6d7e8f9a01", occurred_at: iso(-30 * HOUR), dead_at: iso(-30 * HOUR + MIN), deliveries: 5, reason_class: "handler_error:KeyError", replays: 1, size_bytes: 790, state: "replayed", replayed_at: iso(-2 * HOUR) },
  ];
}

export function dlqDetail(id: string): DlqDetail | null {
  const it = dlqItems().find((x) => x.dlq_id === id);
  if (!it) return null;
  if (id.startsWith("legacy:"))
    return { ...it, envelope_masked: null, masked_fields: [], envelope_readable: false };
  return {
    ...it,
    envelope_masked: {
      event_id: it.event_id,
      type: it.event_type,
      occurred_at: it.occurred_at,
      producer: "watch",
      payload: {
        watch_id: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
        user_id: USER.igor,
        chat_id: "***",
        username: "***",
        change: { type: "price_drop", old_price: "1470.00", new_price: "1320.00", currency: "USD" },
        message: "***",
        contact: { email: "***", phone: "***" },
      },
    },
    masked_fields: ["payload.chat_id", "payload.username", "payload.message", "payload.contact.email", "payload.contact.phone"],
    envelope_readable: true,
  };
}

export function dlqActions(): DlqAction[] {
  return [
    { action_id: "1d8b2f3a-4c5e-4f6a-9b0c-2d3e4f5a6b71", kind: "replay", by: ID.ops, by_name: null, reason: "Исправлен обработчик в 1.4.2", selector: { ids: ["dlq:39", "dlq:38"] }, requested: 2, done: 2, skipped: [], at: iso(-20 * HOUR) },
    { action_id: "2e9c3a4b-5d6f-4a7b-8c1d-3e4f5a6b7c82", kind: "delete", by: ID.admin, by_name: null, reason: "Тестовые события стенда", selector: { filter: { consumer: "user_admin_users", event_type: "user.registered.v1" } }, requested: 5, done: 5, skipped: [], at: iso(-3 * DAY) },
  ];
}

export function summary(p: ProviderHealth[], c: ConsumerInfo[], o: OutboxInfo[], open: OpsAlert[], svc: ServiceReady[], deletions: OpsSummary["deletions"] = null): OpsSummary {
  const counts = { ok: 0, degraded: 0, down: 0, idle: 0, not_configured: 0 };
  for (const x of p) counts[x.status] += 1;
  // ревью 8: устаревший снимок — не «up» и не «down», а отдельным списком stale
  const stale = svc.filter((s) => s.stale === true).map((s) => s.service);
  const down = svc.filter((s) => s.stale !== true && s.ready !== "ok").map((s) => s.service);
  return {
    generated_at: iso(-20_000),
    providers: { ...counts, items: p.map((x) => ({ provider: x.provider, status: x.status, since: x.status_since })) },
    services: { up: svc.length - down.length - stale.length, total: svc.length, down, stale },
    queues: {
      total_pending: c.reduce((s, x) => s + x.num_pending, 0),
      lagging: c.filter((x) => x.status === "lagging").length,
      stalled: c.filter((x) => x.status === "stalled").length,
      dlq_messages: c.reduce((s, x) => s + x.dlq.count, 0),
      dlq_new_24h: 3,
      stale: false,
    },
    outbox: { pending: o.reduce((s, x) => s + (x.pending ?? 0), 0), failing: o.reduce((s, x) => s + (x.failing ?? 0), 0), stuck_services: o.filter((x) => (x.max_attempts ?? 0) >= 5).map((x) => x.service), stale_services: o.filter((x) => x.stale === true).map((x) => x.service) },
    alerts: { critical: open.filter((a) => a.severity === "critical").length, warning: open.filter((a) => a.severity === "warning").length, info: open.filter((a) => a.severity === "info").length },
    deletions,
  };
}

// ---------------------------------------------------------------- sprint 9: alerts of the new kinds, deletions, rate limits

export const ALERT9 = {
  serviceDown: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a70",
  deletion: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a71",
  spike: "0c7a1e2f-3b4d-4e5f-8a9b-1c2d3e4f5a72",
};
const RB = "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/";
export function sprint9Alerts(): OpsAlert[] {
  const base = { state: "open" as const, state_seq: 1, resolved_at: null, acked_by: null, acked_by_name: null, acked_at: null, ack_comment: null };
  return [
    { ...base, alert_id: ALERT9.serviceDown, subject_type: "service", subject: "news", kind: "service_down", severity: "critical", params: { down_s: 420 }, opened_at: iso(-7 * MIN), last_notified_at: iso(-7 * MIN), runbook_url: `${RB}news.md#service-down` },
    { ...base, alert_id: ALERT9.deletion, subject_type: "deletion", subject: "all", kind: "deletion_stuck", severity: "warning", params: { stuck: 1, open: 3, oldest_open_at: iso(-30 * HOUR), pending_by_domain: { watch: 1 } }, opened_at: iso(-6 * HOUR), last_notified_at: iso(-6 * HOUR), runbook_url: `${RB}identity-consent.md#deletion-stuck` },
    { ...base, alert_id: ALERT9.spike, subject_type: "ratelimit", subject: "tg.user", kind: "rate_limit_spike", severity: "warning", params: { policy: "tg.user", rejected: 184, share: 0.14, subjects: 9 }, opened_at: iso(-12 * MIN), last_notified_at: iso(-12 * MIN), runbook_url: `${RB}rate-limits.md#rate-limit-spike` },
  ];
}

export const DEL = {
  stuck: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  open: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e",
  done: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4f",
  legacy: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c50",
};
const DOMAINS = ["preferences", "support", "notifications", "offers", "recommendations", "watch", "news", "ai-concierge", "ai-control"];
export function deletionRows(): DeletionDetail[] {
  const det = (p: Partial<DeletionDetail> & { request_id: string; pending: string[]; before9?: string[] }): DeletionDetail => {
    const pending = p.pending;
    const domains = DOMAINS.map((d, n) =>
      pending.includes(d)
        ? { domain: d, acked_at: null, mode: null, acked: false }
        : p.before9?.includes(d)
          ? { domain: d, acked_at: null, mode: null, acked: true }
          : { domain: d, acked_at: iso(-30 * HOUR + (n + 1) * 7_000), mode: d === "support" || d === "ai-control" ? ("anonymized" as const) : ("deleted" as const), acked: true },
    );
    const { pending: _p, before9: _b, ...rest } = p;
    return {
      user_id: USER.igor,
      status: "REQUESTED",
      requested_at: iso(-30 * HOUR),
      completed_at: null,
      stuck_at: null,
      attempts: 1,
      next_retry_at: iso(15 * MIN),
      acked: DOMAINS.length - pending.length,
      expected: DOMAINS.length,
      pending_domains: pending,
      domains,
      history: [{ attempt: 1, sent_at: iso(-30 * HOUR), by: "user", by_name: null }],
      ...rest,
    };
  };
  return [
    det({
      request_id: DEL.stuck,
      user_id: "3c1d9a7e-5b2f-4e8a-9c0d-1e2f3a4b5c6d",
      status: "STUCK",
      stuck_at: iso(-6 * HOUR),
      attempts: 6,
      next_retry_at: iso(18 * HOUR),
      pending: ["watch"],
      history: [
        { attempt: 1, sent_at: iso(-30 * HOUR), by: "user", by_name: null },
        { attempt: 2, sent_at: iso(-30 * HOUR + 15 * MIN), by: "system", by_name: null },
        { attempt: 3, sent_at: iso(-29 * HOUR), by: "system", by_name: null },
        { attempt: 4, sent_at: iso(-26 * HOUR), by: "system", by_name: null },
        { attempt: 5, sent_at: iso(-18 * HOUR), by: "system", by_name: null },
        { attempt: 6, sent_at: iso(-6 * HOUR), by: "system", by_name: null },
      ],
    }),
    det({ request_id: DEL.open, user_id: "4d2e0b8f-6c3a-4f9b-8d1e-2f3a4b5c6d7e", requested_at: iso(-12 * MIN), next_retry_at: iso(3 * MIN), pending: ["news", "ai-concierge"], history: [{ attempt: 1, sent_at: iso(-12 * MIN), by: "user", by_name: null }] }),
    det({ request_id: DEL.legacy, user_id: "5e3f1c9a-7d4b-4a0c-9e2f-3a4b5c6d7e8f", requested_at: iso(-3 * HOUR), attempts: 3, next_retry_at: iso(57 * MIN), pending: ["offers"], before9: ["preferences", "support"], history: [{ attempt: 1, sent_at: iso(-3 * HOUR), by: "user", by_name: null }, { attempt: 2, sent_at: iso(-3 * HOUR + 15 * MIN), by: "system", by_name: null }, { attempt: 3, sent_at: iso(-2 * HOUR), by: "system", by_name: null }] }),
    det({ request_id: DEL.done, user_id: "6f4a2d0b-8e5c-4b1d-8f3a-4b5c6d7e8f90", status: "COMPLETED", requested_at: iso(-50 * HOUR), completed_at: iso(-50 * HOUR + 40_000), next_retry_at: null, pending: [] }),
  ];
}

export function rateLimitPolicies(): RateLimitPolicy[] {
  const z = { allowed: 0, rejected: 0, failopen: 0, failclosed: 0 };
  const p = (policy: string, service: string, subject: RateLimitPolicy["subject"], limit: number, window_s: number, fail: "open" | "closed", env: string | null, last: Partial<RateLimitPolicy["last_15m"]> = {}, more: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
    policy,
    service,
    subject,
    limit,
    window_s,
    burst: limit,
    fail,
    env,
    default: { limit, window_s, burst: limit },
    source: "default",
    override: null,
    last_15m: { ...z, ...last },
    ...more,
  });
  // все 18 политик каталога (packages/contracts/rate-limit-policies.json; ревью спринта 9 — было 12)
  return [
    p("tg.user", "telegram-bff", "user", 120, 60, "open", "RATE_LIMIT_USER_PER_MIN", { allowed: 1310, rejected: 184 }),
    p("tg.session_ip", "telegram-bff", "ip", 10, 60, "closed", "RATE_LIMIT_SESSION_IP_PER_MIN", { allowed: 212, rejected: 3 }),
    p("tg.pin", "telegram-bff", "user", 5, 60, "closed", "RATE_LIMIT_PIN_PER_MIN", { allowed: 40 }),
    p("tg.public_ip", "telegram-bff", "ip", 120, 60, "open", "RATE_LIMIT_PUBLIC_IP_PER_MIN", { allowed: 520 }),
    p("tg.offers", "telegram-bff", "user", 20, 60, "open", "RATE_LIMIT_OFFERS_PER_MIN", { allowed: 380 }),
    p("tg.reactions", "telegram-bff", "user", 60, 60, "open", "RATE_LIMIT_REACTIONS_PER_MIN", { allowed: 140 }),
    p("tg.watch", "telegram-bff", "user", 30, 60, "open", "RATE_LIMIT_WATCH_PER_MIN", { allowed: 61 }),
    p("tg.ai", "telegram-bff", "user", 6, 60, "open", "AI_RATE_PER_MINUTE", { allowed: 96, rejected: 2 }),
    p("tg.support_create", "telegram-bff", "user", 10, 3600, "open", null, { allowed: 4 }),
    p("adm.login_ip", "admin-bff", "ip", 20, 60, "closed", "RATE_LIMIT_LOGIN_IP_PER_MIN", { allowed: 12 }, {
      default: { limit: 10, window_s: 60, burst: 10 },
      source: "override",
      // ослабление политики входа — только со сроком ≤ 24 ч (ревью спринта 9, RATE_LIMIT_TOO_LOOSE)
      override: { limit: 20, window_s: 60, burst: null, by: ID.admin, by_name: "Admin Operator", at: iso(-5 * HOUR), reason: "Офис за одним NAT, обучение операторов", expires_at: iso(19 * HOUR) },
    }),
    p("adm.login_email", "admin-bff", "email", 5, 60, "closed", "RATE_LIMIT_LOGIN_EMAIL_PER_MIN", { allowed: 12 }),
    p("adm.auth_step_ip", "admin-bff", "ip", 30, 60, "closed", "RATE_LIMIT_AUTH_STEP_IP_PER_MIN", { allowed: 18 }),
    p("adm.mfa", "admin-bff", "staff", 5, 60, "closed", "RATE_LIMIT_MFA_PER_MIN", { allowed: 9 }),
    p("adm.staff", "admin-bff", "staff", 300, 60, "open", "RATE_LIMIT_STAFF_PER_MIN", { allowed: 2210 }),
    p("adm.command", "admin-bff", "staff", 60, 60, "closed", null, { allowed: 41 }),
    p("adm.dlq", "admin-bff", "staff", 10, 60, "closed", null, { allowed: 2 }),
    p("int.caller", "*", "caller", 10000, 60, "open", null, { allowed: 18_400 }),
    p("gw.llm.user", "provider-gateway", "user", 40, 60, "open", null, { allowed: 96 }),
  ];
}

export function rateLimitHistory(policy: string, range: "24h" | "7d", now = Date.now()): RateLimitHistory {
  const step = range === "24h" ? 5 * MIN : HOUR;
  const n = range === "24h" ? 288 : 168;
  const end = Math.floor(now / step) * step;
  const points = Array.from({ length: n }, (_, k) => {
    const t = end - (n - 1 - k) * step;
    const hour = new Date(t + 5 * HOUR).getUTCHours();
    const base = Math.round((hour >= 9 && hour <= 23 ? 420 : 90) * (range === "7d" ? 12 : 1) * (1 + 0.25 * Math.sin(k / 7)));
    const spike = policy === "tg.user" && k > n - 4 ? Math.round(base * 0.16) : k % 37 === 0 ? 2 : 0;
    return { t: new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z"), allowed: base, rejected: spike, failopen: 0, failclosed: 0 };
  });
  return {
    policy,
    range,
    step: range === "24h" ? "5m" : "1h",
    points,
    top_subjects_15m: policy === "tg.user" ? [{ subject: USER.igor, rejected: 62 }, { subject: "4d2e0b8f-6c3a-4f9b-8d1e-2f3a4b5c6d7e", rejected: 41 }, { subject: "9b1c2d3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e", rejected: 18 }] : [],
  };
}

// ---------------------------------------------------------------- dashboard v2

export type BlockName = "users" | "trips" | "no_flight" | "watch" | "news" | "ai" | "support" | "system";
export interface DashOpts {
  off?: Partial<Record<BlockName, "unavailable" | "timeout" | "not_configured" | "forbidden">>;
  stale?: BlockName[];
  /** A45: n8n is down — the Watch schedule and the news collection are late (shown with their age, not as errors) */
  n8nDown?: boolean;
  noFlightEmpty?: boolean;
  system?: OpsSummary;
}

export function dashboard(period: DashboardV2["period"], o: DashOpts = {}): DashboardV2 {
  const k = period === "today" ? 1 : period === "7d" ? 7 : 30;
  const on = <T>(name: BlockName, data: T): DashboardBlock<T> => {
    const r = o.off?.[name];
    if (r) return { available: false, reason: r, stale: false, as_of: null, data: null };
    const stale = o.stale?.includes(name) ?? false;
    return { available: true, reason: null, stale, as_of: iso(stale ? -38 * MIN : -20_000), data };
  };
  const old = F.dashboardLegacy(period);
  const kpi = A.kpi(period);
  const rt = A.runtime();
  return {
    period,
    generated_at: iso(0),
    users: on("users", { ...old.users, active_in_period: k === 1 ? 2184 : k === 7 ? 5310 : 8760, active_today: 2184 }),
    trips: on("trips", {
      builds: 410 * k,
      by_caller: { "telegram-bff": 318 * k, watch: 61 * k, "ai-concierge": 31 * k },
      reused_share: 0.21,
      by_trip_kind: { trip: 276 * k, ticket_only: 104 * k, not_available: 30 * k },
      complete_share: 0.82,
      budget: { with_budget: 96 * k, within: 61 * k, over: 31 * k, unknown: 4 * k },
      by_recommended_tier: { economy: 190 * k, comfort: 140 * k, premium: 50 * k },
      no_flight_total: o.noFlightEmpty ? 0 : 38 * k,
    }),
    no_flight: on<NoFlightStats>(
      "no_flight",
      o.noFlightEmpty
        ? { total: 0, by_reason: {}, bands: { lt600: 0, ge600: 0, unknown: 0 }, pairs: [] }
        : {
            total: 38 * k,
            by_reason: { ROUTE_NOT_SUPPORTED: 14 * k, NO_FLIGHTS: 11 * k, NO_DIRECT: 7 * k, NO_DEPARTURE: 4 * k, PROVIDER_UNAVAILABLE: 2 * k },
            bands: { lt600: 24 * k, ge600: 11 * k, unknown: 3 * k },
            pairs: [
              { origin_city: "Ташкент", origin_iata: "TAS", origin_country: "UZ", dest_city: "Бишкек", dest_iata: "FRU", dest_country: "KG", distance_km: 470, band: "lt600", count: 14 * k, by_reason: { ROUTE_NOT_SUPPORTED: 14 * k } },
              { origin_city: "Ташкент", origin_iata: "TAS", origin_country: "UZ", dest_city: "Самарканд", dest_iata: "SKD", dest_country: "UZ", distance_km: 260, band: "lt600", count: 7 * k, by_reason: { NO_FLIGHTS: 7 * k } },
              { origin_city: "Ташкент", origin_iata: "TAS", origin_country: "UZ", dest_city: "Алматы", dest_iata: "ALA", dest_country: "KZ", distance_km: 680, band: "ge600", count: 6 * k, by_reason: { NO_DIRECT: 6 * k } },
              { origin_city: "Самарканд", origin_iata: "SKD", origin_country: "UZ", dest_city: "Бухара", dest_iata: "BHK", dest_country: "UZ", distance_km: 230, band: "lt600", count: 3 * k, by_reason: { NO_FLIGHTS: 3 * k } },
              { origin_city: "Ташкент", origin_iata: "TAS", origin_country: "UZ", dest_city: "Шымкент", dest_iata: "CIT", dest_country: "KZ", distance_km: 120, band: "lt600", count: 2 * k, by_reason: { NO_DEPARTURE: 2 * k } },
              { origin_city: null, origin_iata: "NMA", origin_country: "UZ", dest_city: "Душанбе", dest_iata: "DYU", dest_country: "TJ", distance_km: null, band: "unknown", count: k, by_reason: { PROVIDER_UNAVAILABLE: k } },
            ],
          },
    ),
    watch: on("watch", {
      active: 5902,
      paused: 214,
      ended_24h: 38,
      rechecks_24h: 11840,
      changes_24h: { price_drop: 212, price_rise: 160, lifecycle: 9, tickets: 41, flight: 17, hotel: 22 },
      notifications_24h: { immediate: 186, digest: 240, suppressed: 35 },
      errors_24h: o.n8nDown ? 0 : 4,
      next_batch_at: o.n8nDown ? iso(-2 * HOUR - 10 * MIN) : iso(12 * MIN),
    }),
    news: on("news", { items: { article: 64 * k, event_update: 18 * k }, hidden: 3 * k, sources: { enabled: 18, disabled: 3, problem: 2 }, last_collect_at: o.n8nDown ? iso(-7 * HOUR) : iso(-24 * MIN) }),
    ai: on("ai", {
      kpi,
      budgets: {
        provider_paused: false,
        agents: rt.map((a) => ({ agent_id: a.agent_id, name: a.name, state: a.state, day: a.day, month_cost_usd: a.month?.cost_usd ?? null, paused: a.paused !== null })),
      },
    }),
    support: on("support", { open: 27, in_progress: 11, waiting_customer: 7, breached: 3, avg_first_response_minutes: 11 + k, avg_resolution_minutes: 220 }),
    system: on("system", o.system ?? summary(providers(), consumers(), outbox(), opsAlerts(), services())),
    commercial: { available: false, reason: "postponed" },
  };
}
