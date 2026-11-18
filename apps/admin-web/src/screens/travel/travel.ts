import type { TravelProviderStatus } from "@tilhero/contracts/admin";
import { DICTS, type MessageKey } from "../../i18n";
import type { Tone } from "../../ui/kit";
import type { IconName } from "../../ui/Icon";

/* «Trip providers» (sprint 5, docs/sprint5/INTERNAL_API.md §1.6–1.7, §5): vocabulary and state of a provider card. */

export type TravelName = TravelProviderStatus["name"];
export const TRAVEL_PROVIDERS: readonly TravelName[] = ["aviasales", "liteapi", "osm", "cbu"];

export interface EnvVar {
  name: string;
  /** a secret: Railway «sealed» variable, never shown or logged */
  secret?: boolean;
  /** not needed for the provider to work (partner links) */
  optional?: boolean;
}

export interface ProviderMeta {
  icon: IconName;
  /** what to set in Railway on the provider-gateway service (§1.7) */
  vars: readonly EnvVar[];
  enableVar: string;
  quotaVar: string;
  /** the variable to check when the provider refuses the key (upstream_401/403) */
  keyVar: string;
}

export const PROVIDER_META: Record<TravelName, ProviderMeta> = {
  aviasales: {
    icon: "plane",
    vars: [{ name: "TRAVELPAYOUTS_TOKEN", secret: true }, { name: "TRAVELPAYOUTS_MARKER", optional: true }, { name: "TRAVELPAYOUTS_TRS", optional: true }],
    enableVar: "AVIASALES_ENABLED",
    quotaVar: "AVIASALES_DAILY_QUOTA",
    keyVar: "TRAVELPAYOUTS_TOKEN",
  },
  liteapi: {
    icon: "bed",
    vars: [{ name: "LITEAPI_KEY", secret: true }, { name: "LITEAPI_WHITELABEL_URL" }],
    enableVar: "LITEAPI_ENABLED",
    quotaVar: "LITEAPI_DAILY_QUOTA",
    keyVar: "LITEAPI_KEY",
  },
  osm: {
    icon: "mapPin",
    vars: [{ name: "OSM_CONTACT_EMAIL" }],
    enableVar: "OSM_ENABLED",
    quotaVar: "OSM_OVERPASS_DAILY_QUOTA",
    keyVar: "OSM_CONTACT_EMAIL",
  },
  // fix 5.1: official exchange rates of the Central Bank of Uzbekistan (public JSON, no key) — ticket prices → USD
  cbu: {
    icon: "coins",
    vars: [{ name: "CBU_FX_URL", optional: true }],
    enableVar: "CBU_ENABLED",
    quotaVar: "CBU_DAILY_QUOTA",
    keyVar: "CBU_FX_URL",
  },
};

/**
 * One state per card, the most important first: not configured → switched off → breaker open → half-open → quota
 * exhausted → the last call failed (error newer than the last success) → never called yet → working.
 */
export type ProviderState = "not_configured" | "disabled" | "breaker_open" | "breaker_half" | "quota_exhausted" | "failing" | "idle" | "ok";
export const PROVIDER_STATES: readonly ProviderState[] = ["not_configured", "disabled", "breaker_open", "breaker_half", "quota_exhausted", "failing", "idle", "ok"];
export const STATE_TONE: Record<ProviderState, Tone> = {
  not_configured: "warn",
  disabled: "neutral",
  breaker_open: "bad",
  breaker_half: "warn",
  quota_exhausted: "bad",
  failing: "warn",
  idle: "info",
  ok: "good",
};

const ts = (iso: string | null | undefined): number => {
  const v = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(v) ? -Infinity : v;
};

export function quotaExhausted(p: Pick<TravelProviderStatus, "quota">): boolean {
  return !!p.quota && p.quota.day_limit > 0 && p.quota.day_used >= p.quota.day_limit;
}

/** the last error is the latest news (no success after it); an error without a time counts when there is no success */
export function errorIsLatest(p: Pick<TravelProviderStatus, "last_error" | "last_success_at">): boolean {
  if (!p.last_error) return false;
  if (!p.last_success_at) return true;
  return ts(p.last_error.at) > ts(p.last_success_at);
}

export function providerState(p: TravelProviderStatus): ProviderState {
  if (!p.configured) return "not_configured";
  if (!p.enabled) return "disabled";
  if (p.breaker === "open") return "breaker_open";
  if (p.breaker === "half_open") return "breaker_half";
  if (quotaExhausted(p)) return "quota_exhausted";
  if (errorIsLatest(p)) return "failing";
  if (!p.last_success_at && !p.last_error) return "idle";
  return "ok";
}

/** quota meter level: ok < 80 % ≤ warn < 100 % ≤ bad */
export function quotaLevel(q: TravelProviderStatus["quota"]): "ok" | "warn" | "bad" {
  if (!q || q.day_limit <= 0) return "ok";
  const r = q.day_used / q.day_limit;
  return r >= 1 ? "bad" : r >= 0.8 ? "warn" : "ok";
}

/** error codes of provider-gateway (§1.1 «Ошибки», domain/errors.py) with a human label: trv.err.<CODE> */
export const TRAVEL_ERROR_CODES = [
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_QUOTA_EXHAUSTED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_BAD_RESPONSE",
  "PLACE_NOT_FOUND",
  "INTERNAL_ERROR",
] as const;

/** human label of a provider error code; an unknown code is shown as the code itself (never hidden) */
export function travelErrorLabel(t: (k: MessageKey) => string, code: string): string {
  const key = `trv.err.${code}` as MessageKey;
  return key in DICTS.ru ? t(key) : code;
}

/** how many providers work (ok / not called yet) and how many need attention — the line above the cards */
export function summary(items: readonly TravelProviderStatus[]): { working: number; total: number; attention: number } {
  const states = items.map(providerState);
  return {
    working: states.filter((s) => s === "ok" || s === "idle").length,
    total: items.length,
    attention: states.filter((s) => s !== "ok" && s !== "idle").length,
  };
}

/* ---------------------------------------------------------------- diagnosis (fix 5.1, FEEDBACK_5_1 §E) */

/**
 * What went wrong, in human terms: one kind per machine `reason` of provider-gateway (upstream_400, success_false,
 * shape, timeout, …). Each kind has a title `trv.why.<kind>` and a «what to do» text `trv.fix.<kind>`.
 */
export const DIAG_KINDS = [
  "rejected",
  "key",
  "not_found",
  "rate_limited",
  "server",
  "provider_error",
  "format",
  "too_large",
  "timeout",
  "network",
  "circuit",
  "quota",
  "not_configured",
  "state_store",
  "negative_cache",
  "overpass",
  "internal",
  "local",
  "unknown",
] as const;
export type DiagKind = (typeof DIAG_KINDS)[number];

const REASON_KIND: Record<string, DiagKind> = {
  upstream_401: "key",
  upstream_403: "key",
  upstream_404: "not_found",
  upstream_429: "rate_limited",
  rate_limited: "rate_limited",
  upstream_overloaded: "rate_limited",
  upstream_5xx: "server",
  success_false: "provider_error",
  provider_error: "provider_error",
  shape: "format",
  invalid_json: "format",
  id_mismatch: "format",
  too_large: "too_large",
  timeout: "timeout",
  network: "network",
  circuit_open: "circuit",
  quota: "quota",
  quota_exhausted: "quota",
  not_configured: "not_configured",
  disabled: "not_configured",
  state_store: "state_store",
  // fix 5.1 review: every reason provider-gateway writes (travel/*.py, domain/*.py, aiweb/*.py)
  negative_cache: "negative_cache",
  overpass_runtime_error: "overpass",
  internal: "internal",
  local: "local",
  fixture_invalid: "format",
  fixture_too_large: "too_large",
  tool_input: "format",
  unusable_event: "format",
  max_tokens: "format",
  budget: "quota",
};
/** an old provider-gateway sends only the code: some codes speak for themselves */
const CODE_KIND: Record<string, DiagKind> = {
  PROVIDER_RATE_LIMITED: "rate_limited",
  PROVIDER_QUOTA_EXHAUSTED: "quota",
  PROVIDER_NOT_CONFIGURED: "not_configured",
};

/**
 * Kind of a provider error by its machine reason (and the code when the reason is missing). null — nothing to explain
 * beyond the code (an old gateway without `reason`, e.g. PROVIDER_UNAVAILABLE): the card shows the code label only.
 */
export function diagKind(reason: string | null | undefined, code?: string | null): DiagKind | null {
  if (reason) {
    const k = REASON_KIND[reason];
    if (k) return k;
    if (/^upstream_5\d\d$/.test(reason)) return "server";
    if (/^upstream_4\d\d$/.test(reason)) return "rejected";
    return "unknown";
  }
  return code ? (CODE_KIND[code] ?? null) : null;
}

/** tone of the diagnosis: something to fix on our side (key, format, config, gateway itself) is «bad», a temporary
 *  state of the provider is «warn», a reason the admin does not know yet is «neutral» (no alarm without a reason) */
export function diagTone(kind: DiagKind): "bad" | "warn" | "neutral" {
  if (kind === "unknown") return "neutral";
  return kind === "key" || kind === "format" || kind === "not_configured" || kind === "not_found" || kind === "state_store" || kind === "internal" ? "bad" : "warn";
}

/** the provider's own message (success_false) is shown only as text, trimmed — admin-bff already cleaned it */
export function providerMsg(m: string | null | undefined): string | null {
  const s = (m ?? "").replace(/\s+/g, " ").trim();
  return s ? (s.length > 200 ? `${s.slice(0, 199)}…` : s) : null;
}

/** Probe lock: provider-gateway allows one probe per 30 s per provider (429 retry_after otherwise). */
export const PROBE_COOLDOWN_S = 30;
/** seconds left of a lock that ends at `until` (ms epoch); 0 — unlocked */
export function lockLeft(until: number | null, now: number): number {
  return until && until > now ? Math.ceil((until - now) / 1000) : 0;
}

/* ---------------------------------------------------------------- route errors (fix 5.2) */

/** «Поставщик не знает код FRU · маршрут TAS → FRU»: the supplier did not know a code of the route (not a failure). */
export function routeErrorTitle(t: (k: MessageKey, v?: Record<string, string | number>) => string, e: NonNullable<TravelProviderStatus["last_route_error"]>): string {
  const route = e.route ? e.route.replace("-", " → ") : null;
  if (e.location && route) return t("trv.routeError.locRoute", { loc: e.location, route });
  if (e.location) return t("trv.routeError.loc", { loc: e.location });
  return t("trv.routeError.any");
}
