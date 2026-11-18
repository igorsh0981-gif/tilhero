/**
 * Sprint 9 review (FRONT 🟡): one 429 like in the Mini App. admin-bff answers 429 RATE_LIMITED {policy, retry_after};
 * the client notes the wait under its policy, screens show a live countdown («повторите через N с») and keep the
 * action that would only hit the limit again inactive until the time is up. Nothing is repeated automatically.
 * `adm.staff` (every request of the staff member) holds every scope, like `tg.user` in the Mini App.
 */
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { ApiError } from "../api/errors";

export const STAFF_POLICY = "adm.staff";
/** commands of the admin (step-up dialogs): adm.command */
export const COMMAND_SCOPE: readonly string[] = ["adm.command"];
/** sign-in: password, e-mail, MFA steps */
export const LOGIN_SCOPE: readonly string[] = ["adm.login_ip", "adm.login_email", "adm.auth_step_ip", "adm.mfa"];

const until = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const l of listeners) l();
};

/** the policy a 429 without `details.policy` belongs to, by the request */
export function fallbackPolicy(method: string, path: string): string {
  if (path.startsWith("/auth/")) return "adm.login_ip";
  return method === "GET" ? STAFF_POLICY : "adm.command";
}

export const rateLimits = {
  note(e: unknown, fallback: string, now = Date.now()): boolean {
    if (!(e instanceof ApiError) || e.code !== "RATE_LIMITED") return false;
    const ra = e.num("retry_after");
    if (ra == null || ra <= 0) return true;
    const p = e.str("policy") || fallback;
    const t = now + ra * 1000;
    if ((until.get(p) ?? 0) < t) {
      until.set(p, t);
      emit();
    }
    return true;
  },
  left(policies: readonly string[], now = Date.now()): number {
    let ms = 0;
    for (const p of [...policies, STAFF_POLICY]) ms = Math.max(ms, (until.get(p) ?? 0) - now);
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

/** whole seconds left for the scope (ticks every second while > 0) */
export function useRateWait(policies: readonly string[] | null): number {
  useSyncExternalStore(rateLimits.subscribe, () => version, () => version);
  const [, tick] = useState(0);
  const left = policies ? rateLimits.left(policies) : 0;
  useEffect(() => {
    if (left <= 0) return;
    const id = setTimeout(() => tick((x) => x + 1), 1000 - (Date.now() % 1000) + 5);
    return () => clearTimeout(id);
  });
  return left;
}

/** the policies of the surrounding surface (a command dialog, the sign-in form): primary buttons inside wait */
export const RateScope = createContext<readonly string[] | null>(null);
export const useRateScope = () => useContext(RateScope);
