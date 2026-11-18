import type {
  AlertSeverity,
  ConsumerStatus,
  DlqItem,
  ProviderErrorClass,
  ProviderHealth,
  ProviderHealthStatus,
  ProviderHistoryPoint,
} from "@tilhero/contracts/admin";
import type { IconName } from "../../ui/Icon";
import type { Tone } from "../../ui/kit";

/* Sprint 8 — pure helpers of «Monitoring» (providers, queues, DLQ, alerts); no React, unit-tested. */

export type MonTab = "providers" | "queues" | "dlq" | "limits" | "alerts";
export const MON_TABS: readonly MonTab[] = ["providers", "queues", "dlq", "limits", "alerts"];
/** rate limit policy id (catalogue): tg.user, adm.login_ip, gw.llm.user … */
export const POLICY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * #/monitoring/<tab>[/<provider>|/<policy>] — the Telegram alert button opens #/monitoring/providers,
 * #/monitoring/queues or (sprint 9) #/monitoring/limits.
 */
export function parseMonRoute(id: string | null): { tab: MonTab; provider: string | null; policy: string | null } {
  const [head = "", rest = ""] = (id ?? "").split("/");
  const tab = (MON_TABS as readonly string[]).includes(head) ? (head as MonTab) : "providers";
  const provider = tab === "providers" && /^[a-z][a-z0-9_]{1,31}$/.test(rest) ? rest : null;
  const policy = tab === "limits" && POLICY_RE.test(rest) && rest.length <= 64 ? rest : null;
  return { tab, provider, policy };
}
export const monRoute = (tab: MonTab, provider?: string | null) => (provider ? `${tab}/${provider}` : tab);

// ---------------------------------------------------------------- status

/** colour + icon + text: the status is never told by colour alone */
export const STATUS_TONE: Record<ProviderHealthStatus, Tone> = { ok: "good", degraded: "warn", down: "bad", idle: "neutral", not_configured: "outline" };
export const STATUS_ICON: Record<ProviderHealthStatus, IconName> = { ok: "checkCircle", degraded: "alert", down: "alertCircle", idle: "clock", not_configured: "power" };
export const STATUS_RANK: Record<ProviderHealthStatus, number> = { down: 0, degraded: 1, ok: 2, idle: 3, not_configured: 4 };
export const SEV_TONE: Record<AlertSeverity, Tone> = { critical: "bad", warning: "warn", info: "info" };
export const SEV_ICON: Record<AlertSeverity, IconName> = { critical: "alertCircle", warning: "alert", info: "info" };
export const CONSUMER_TONE: Record<ConsumerStatus, Tone> = { ok: "good", lagging: "warn", stalled: "bad" };
/** OPS_STALLED_MINUTES (20): ack floor без движения дольше — «застрял» */
export const STALLED_S = 20 * 60;
/** снимок ops-monitor (outbox, готовность) старше — «данные устарели», когда ops-monitor сам признака не отдаёт */
export const SNAPSHOT_STALE_MS = 10 * 60_000;
export function snapshotStale(x: { stale?: boolean | null; checked_at: string | null }, now: number): boolean {
  if (x.stale != null) return x.stale;
  return !!x.checked_at && now - Date.parse(x.checked_at) > SNAPSHOT_STALE_MS;
}
export const ERROR_CLASSES: readonly ProviderErrorClass[] = ["auth", "rate_limit", "quota", "timeout", "server", "network", "bad_response", "circuit_open"];

/** row severity class of the providers table */
export const rowSev = (s: ProviderHealthStatus) => (s === "down" ? "sev-bad" : s === "degraded" ? "sev-warn" : "sev-none");

/** worst first, then by the catalogue order the server gave */
export function sortProviders(items: readonly ProviderHealth[]): ProviderHealth[] {
  return items.map((p, i) => ({ p, i })).sort((a, b) => STATUS_RANK[a.p.status] - STATUS_RANK[b.p.status] || a.i - b.i).map((x) => x.p);
}

export function providerCounts(items: readonly ProviderHealth[]): Record<ProviderHealthStatus, number> {
  const out: Record<ProviderHealthStatus, number> = { ok: 0, degraded: 0, down: 0, idle: 0, not_configured: 0 };
  for (const p of items) out[p.status] += 1;
  return out;
}

/** non-zero error classes, largest first */
export function topClasses(by: Partial<Record<ProviderErrorClass, number>> | null | undefined, n = 3): Array<{ k: ProviderErrorClass; v: number }> {
  if (!by) return [];
  return ERROR_CLASSES.map((k) => ({ k, v: by[k] ?? 0 }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, n);
}

/** error rate 0..1 → percent number; tone by the ops-monitor thresholds (10 % degraded, 50 % down) */
export const ratePct = (r: number | null | undefined) => (r == null ? null : r * 100);
export const rateTone = (r: number | null | undefined, calls: number): Tone => (r == null || calls === 0 ? "neutral" : r >= 0.5 ? "bad" : r >= 0.1 ? "warn" : "good");

/** quota tone: ≥ 90 % — degraded by the ops-monitor rule */
export const quotaTone = (pct: number | null | undefined): "good" | "warn" | "bad" | "neutral" => (pct == null ? "neutral" : pct >= 100 ? "bad" : pct >= 90 ? "warn" : "good");

/** milliseconds → {v, unit} for «820 мс» / «4,1 с» */
export function msParts(ms: number | null | undefined): { v: number; unit: "ms" | "s" } | null {
  if (ms == null) return null;
  return ms < 1000 ? { v: Math.round(ms), unit: "ms" } : { v: Math.round(ms / 100) / 10, unit: "s" };
}

/** seconds → compact age parts («45 с», «12 мин», «3 ч», «2 дн») */
export function ageParts(s: number | null | undefined): { v: number; unit: "s" | "m" | "h" | "d" } | null {
  if (s == null || !Number.isFinite(s)) return null;
  if (s < 60) return { v: Math.round(s), unit: "s" };
  if (s < 3600) return { v: Math.round(s / 60), unit: "m" };
  if (s < 86_400) return { v: Math.round(s / 360) / 10, unit: "h" };
  return { v: Math.round(s / 8640) / 10, unit: "d" };
}

/** bytes → «812 Б» / «4,2 КБ» / «1,3 МБ» parts */
export function sizeParts(b: number | null | undefined): { v: number; unit: "b" | "kb" | "mb" } | null {
  if (b == null) return null;
  if (b < 1024) return { v: b, unit: "b" };
  if (b < 1024 * 1024) return { v: Math.round((b / 1024) * 10) / 10, unit: "kb" };
  return { v: Math.round((b / 1024 / 1024) * 10) / 10, unit: "mb" };
}

// ---------------------------------------------------------------- history chart

export interface ChartBar {
  t: string;
  x: number;
  w: number;
  ok: number; // px heights
  err: number;
  route: number;
  calls: number;
  errors: number;
  p95: number | null;
  p95y: number | null;
}
export interface ChartModel {
  bars: ChartBar[];
  maxCalls: number;
  maxP95: number;
  ticks: Array<{ x: number; t: string }>;
  /** p95 polyline points («x,y x,y») — gaps where a bucket has no calls */
  p95Paths: string[];
}

/**
 * Bars on a fixed time axis (empty buckets are blank, not interpolated): 24 h × 5 min or 7 d × 1 h ending at `now`.
 * Heights: calls split into errors / route unsupported / ok on the left scale; p95 on its own right scale.
 */
export function chartModel(points: readonly ProviderHistoryPoint[], range: "24h" | "7d", now: number, width: number, height: number): ChartModel {
  const step = range === "24h" ? 5 * 60_000 : 3_600_000;
  const n = range === "24h" ? 288 : 168;
  const end = Math.floor(now / step) * step + step;
  const start = end - n * step;
  const slot = width / n;
  const byIdx = new Map<number, ProviderHistoryPoint>();
  for (const p of points) {
    const i = Math.floor((Date.parse(p.t) - start) / step);
    if (i >= 0 && i < n) byIdx.set(i, p);
  }
  let maxCalls = 0;
  let maxP95 = 0;
  for (const p of byIdx.values()) {
    maxCalls = Math.max(maxCalls, p.calls + p.route_unsupported);
    if (p.p95_ms != null) maxP95 = Math.max(maxP95, p.p95_ms);
  }
  const yc = (v: number) => (maxCalls ? (v / maxCalls) * height : 0);
  const yp = (v: number) => height - (maxP95 ? (v / maxP95) * height : 0);
  const bars: ChartBar[] = [];
  const paths: string[] = [];
  let cur: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = byIdx.get(i);
    const x = i * slot;
    if (!p) {
      if (cur.length) paths.push(cur.join(" "));
      cur = [];
      continue;
    }
    const errors = Math.min(p.errors, p.calls);
    const p95y = p.p95_ms != null ? yp(p.p95_ms) : null;
    bars.push({
      t: p.t,
      x,
      w: Math.max(1, slot - (slot > 3 ? 1 : 0)),
      err: yc(errors),
      route: yc(p.route_unsupported),
      ok: yc(p.calls - errors),
      calls: p.calls,
      errors,
      p95: p.p95_ms,
      p95y,
    });
    if (p95y != null) cur.push(`${(x + slot / 2).toFixed(1)},${p95y.toFixed(1)}`);
    else if (cur.length) {
      paths.push(cur.join(" "));
      cur = [];
    }
  }
  if (cur.length) paths.push(cur.join(" "));
  const tickEvery = range === "24h" ? 6 * 3_600_000 : 86_400_000;
  const ticks: ChartModel["ticks"] = [];
  for (let t = Math.ceil(start / tickEvery) * tickEvery; t < end; t += tickEvery) ticks.push({ x: ((t - start) / step) * slot, t: new Date(t).toISOString() });
  return { bars, maxCalls, maxP95, ticks, p95Paths: paths };
}

// ---------------------------------------------------------------- DLQ

export const DLQ_BATCH_MAX = 100;
export const DLQ_FILTER_MAX = 500;

/** «handler_error:KeyError» → {kind: "handler_error", detail: "KeyError"} */
export function reasonParts(r: string | null | undefined): { kind: string; detail: string | null } {
  if (!r) return { kind: "unknown", detail: null };
  const [kind = "", ...rest] = r.split(":");
  return { kind, detail: rest.length ? rest.join(":") : null };
}

/** destructive and bulk commands are confirmed by typing the number of messages */
export const countConfirmed = (typed: string, n: number) => typed.trim() !== "" && typed.trim() === String(n);

/** replay is possible only for consumers that have the replay subject; the rest are skipped by the server */
export function replayBlocked(items: readonly DlqItem[], replayable: ReadonlyMap<string, boolean>): string[] {
  return [...new Set(items.filter((x) => replayable.get(x.consumer) === false).map((x) => x.consumer))];
}

/** replay limit of one event (ops-monitor): such messages can only be deleted */
export const REPLAY_MAX = 3;
export const atReplayLimit = (x: { replays: number }) => x.replays >= REPLAY_MAX;

/**
 * «15.10.2026 09:30» (ru) / «10/15/2026 09:30» (en) — the format of fmt.dateTime, placeholder «mon.dlq.f.dtFormat»;
 * local time → ISO UTC. Time may be omitted: the start of the day,
 * or — for the end of a period — the start of the next day (the whole day is included). "" → undefined, invalid → null.
 */
export function parseLocalDateTime(text: string, lang: "ru" | "en", end = false): string | undefined | null {
  const v = text.trim();
  if (!v) return undefined;
  const m = lang === "ru" ? /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[\s,]+(\d{1,2}):(\d{2}))?$/.exec(v) : /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\s,]+(\d{1,2}):(\d{2}))?$/.exec(v);
  if (!m) return null;
  const [day, month] = lang === "ru" ? [Number(m[1]), Number(m[2])] : [Number(m[2]), Number(m[1])];
  const year = Number(m[3]);
  const hasTime = m[4] !== undefined;
  const h = hasTime ? Number(m[4]) : 0;
  const min = hasTime ? Number(m[5]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || h > 23 || min > 59) return null;
  const d = new Date(year, month - 1, day, h, min, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null; // 31.02
  if (end && !hasTime) d.setDate(d.getDate() + 1);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------- sprint 9: rate limits

/** limit per window → requests per minute (the unit the operator compares) */
export const perMinute = (limit: number, windowS: number) => (limit * 60) / windowS;
/** the protective minimum of fail: closed policies (ops-monitor 422 RATE_LIMIT_TOO_STRICT): ≥ 1 request per minute */
export const tooStrict = (fail: "open" | "closed", limit: number, windowS: number) => fail === "closed" && perMinute(limit, windowS) < 1;
/** fail: closed policies (sign-in, MFA, PIN, sessions, commands) may be loosened at most ×10 of the default and only
 *  for ≤ 24 h (ops-monitor 422 RATE_LIMIT_TOO_LOOSE; review of sprint 9). Rates compared in integers, like ops-monitor. */
export const CLOSED_MAX_FACTOR = 10;
export const CLOSED_LOOSE_MAX_HOURS = 24;
type Lim = { limit: number; window_s: number; burst: number };
const effBurst = (limit: number, burst: number | null) => burst ?? limit;
/** the override lets through more than the default (by rate or by burst) */
export const loosens = (d: Lim, limit: number, windowS: number, burst: number | null) =>
  limit * d.window_s > d.limit * windowS || effBurst(limit, burst) > d.burst;
export const tooLoose = (fail: "open" | "closed", d: Lim, limit: number, windowS: number, burst: number | null) =>
  fail === "closed" && (limit * d.window_s > CLOSED_MAX_FACTOR * d.limit * windowS || effBurst(limit, burst) > CLOSED_MAX_FACTOR * d.burst);
/** share of rejected requests 0..1 (null — no traffic) */
export function rejectShare(c: { allowed: number; rejected: number }): number | null {
  const total = c.allowed + c.rejected;
  return total ? c.rejected / total : null;
}
/** tone of a policy row: failclosed → bad (the lock is in effect), rejected ≥ 10 % → warn (spike threshold of ops-monitor) */
export function limitTone(c: { allowed: number; rejected: number; failclosed: number }): "bad" | "warn" | "neutral" {
  if (c.failclosed > 0) return "bad";
  const s = rejectShare(c);
  return s != null && s >= 0.1 && c.rejected > 0 ? "warn" : "neutral";
}
/** a window in words: 60 → minute, 3600 → hour, 86400 → day, else seconds */
export function windowUnit(windowS: number): { unit: "s" | "min" | "h" | "d"; n: number } {
  if (windowS % 86_400 === 0) return { unit: "d", n: windowS / 86_400 };
  if (windowS % 3600 === 0) return { unit: "h", n: windowS / 3600 };
  if (windowS % 60 === 0) return { unit: "min", n: windowS / 60 };
  return { unit: "s", n: windowS };
}
/** expiry presets of an override (hours; null — until reset) */
export const OVERRIDE_TTL_HOURS: ReadonlyArray<number | null> = [1, 24, 168, null];
export function expiresAt(now: number, hours: number | null): string | undefined {
  return hours == null ? undefined : new Date(now + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------- sprint 9: profile deletions

export type DelFilter = "open" | "stuck" | "completed" | "all";
export const DEL_FILTERS: readonly DelFilter[] = ["open", "stuck", "completed", "all"];
const UUID_V = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** #/users/deletions[/<filter>|/<request_id>] */
export function parseDelRoute(id: string | null): { deletions: boolean; filter: DelFilter; open: string | null } {
  const [head = "", rest = ""] = (id ?? "").split("/");
  if (head !== "deletions") return { deletions: false, filter: "open", open: null };
  if ((DEL_FILTERS as readonly string[]).includes(rest)) return { deletions: true, filter: rest as DelFilter, open: null };
  return { deletions: true, filter: "open", open: UUID_V.test(rest) ? rest.toLowerCase() : null };
}
/** the progress of a deletion: acked / expected domains, 0..1 */
export const ackShare = (r: { acked: number; expected: number }) => (r.expected ? Math.min(1, r.acked / r.expected) : 1);
