/**
 * One 429 everywhere: telegram-bff answers 429 RATE_LIMITED {policy, retry_after} +
 * Retry-After; the Mini App says «Слишком много запросов — повторите через ⌈N⌉ с» and never repeats by itself. Where an
 * action would only hit the limit again (PIN, sending a support message) it is inactive until the time is up. The waits
 * live here by policy (tg.pin…; tg.user — every request of the user).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { ApiError } from "./errors";

/** the per-user limit: while it holds, every action waits */
export const USER_POLICY = "tg.user";
/** PIN checks (unlock, change, delete with PIN) */
export const PIN_POLICY = "tg.pin";

const until = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const l of listeners) l();
};

/** Seconds to wait from a 429 (details.retry_after, filled from Retry-After by the client); null — not a 429 / unknown. */
export function rateLimitWait(e: unknown): number | null {
  return e instanceof ApiError && e.code === "RATE_LIMITED" ? e.retryAfter : null;
}

/** Retry-After: delta-seconds or an HTTP date → seconds (≥ 1), null when absent or malformed. */
export function parseRetryAfter(h: string | null | undefined, now = Date.now()): number | null {
  if (!h) return null;
  const v = h.trim();
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return n > 0 ? n : null;
  }
  const at = Date.parse(v);
  if (!Number.isFinite(at)) return null;
  const s = (at - now) / 1000;
  return s > 0 ? s : null;
}

export const rateLimits = {
  /** Remember a 429 under its policy (or `fallback` — the screen's own scope when the server named none). */
  note(e: unknown, fallback?: string, now = Date.now()): boolean {
    const wait = rateLimitWait(e);
    if (wait == null) return false;
    const p = e instanceof ApiError && typeof e.details.policy === "string" && e.details.policy ? e.details.policy : fallback;
    if (!p) return true;
    const t = now + wait * 1000;
    if ((until.get(p) ?? 0) < t) {
      until.set(p, t);
      emit();
    }
    return true;
  },
  /** whole seconds left for these policies (and the per-user one), 0 — free */
  left(policies: readonly string[], now = Date.now()): number {
    let ms = 0;
    for (const p of [...policies, USER_POLICY]) ms = Math.max(ms, (until.get(p) ?? 0) - now);
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  reset(): void {
    until.clear();
    emit();
  },
};

/**
 * Seconds left for the screen's policies (ticks every second while > 0) and `note` for its own errors: a 429 without
 * a policy counts for policies[0].
 */
export function useRateWait(policies: readonly string[]): { left: number; note: (e: unknown) => boolean } {
  useSyncExternalStore(rateLimits.subscribe, () => version, () => version);
  const [, tick] = useState(0);
  const left = rateLimits.left(policies);
  useEffect(() => {
    if (left <= 0) return;
    const id = setTimeout(() => tick((x) => x + 1), 1000 - (Date.now() % 1000) + 5);
    return () => clearTimeout(id);
  });
  return { left, note: (e: unknown) => rateLimits.note(e, policies[0]) };
}
