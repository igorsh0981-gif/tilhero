/**
 * Watch state shared by the screens: which events the user watches (overrides what cards and the detail got from the
 * BFF after a tap here), and the critical changes behind the tab bar badge.
 *
 * Badge (re-review): one quantity everywhere — the set of keys of critical changes (`criticalKey`: watch + change).
 * Home reports the keys it sees on «Что изменилось» (HomeWatchChange), the Watch tab reports the keys of its critical
 * watches and acknowledges them (it shows them). The badge counts keys not acknowledged yet; acknowledged keys are
 * remembered between launches (CloudStorage / localStorage, ≤ 60), so a change seen yesterday does not light it again.
 */
import { useSyncExternalStore } from "react";
import type { WatchRef } from "@tilhero/contracts/bff";
import { kvStore } from "../tg/storage";

const refs = new Map<string, WatchRef | null>();
/** keys of critical changes currently known (Home board / Watch list) */
let critical = new Set<string>();
/** keys acknowledged by opening the Watch tab */
let acked = new Set<string>();
/** the remembered acknowledgements were read (no badge before that — no flash for already seen changes) */
let ackLoaded = false;
let ackLoading: Promise<void> | null = null;
export const CRIT_SEEN_KEY = "watch_crit_seen_v1";
// ≤ 60 keys of ~45 chars stay under the CloudStorage value limit (4096)
const ACK_MAX = 60;
let badge = 0;
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version += 1;
  for (const l of listeners) l();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export const watchStore = {
  /** undefined — nothing known locally (use the server value) */
  get: (eventId: string): WatchRef | null | undefined => (refs.has(eventId) ? refs.get(eventId) : undefined),
  set: (eventId: string, ref: WatchRef | null): void => {
    refs.set(eventId, ref);
    emit();
  },
  /** keys of the critical changes known now (replaces the previous set) */
  setCritical: (keys: Iterable<string>): void => {
    critical = new Set(keys);
    loadAck();
    recount();
  },
  /** the Watch tab shows these critical changes: they stop lighting the badge (remembered between launches) */
  ack: (keys: Iterable<string>): void => {
    let changed = false;
    for (const k of keys) if (!acked.has(k)) (acked.add(k), (changed = true));
    if (!changed) return;
    const list = [...acked].slice(-ACK_MAX);
    acked = new Set(list);
    void kvStore().set(CRIT_SEEN_KEY, JSON.stringify(list)).catch(() => undefined);
    recount();
  },
  badge: (): number => badge,
  /** logout / deletion / tests */
  reset: (): void => {
    refs.clear();
    critical = new Set();
    acked = new Set();
    ackLoaded = false;
    ackLoading = null;
    badge = 0;
    emit();
  },
};

function recount(): void {
  const n = ackLoaded ? [...critical].filter((k) => !acked.has(k)).length : 0;
  if (n !== badge) {
    badge = n;
    emit();
  }
}

function loadAck(): void {
  if (ackLoaded || ackLoading) return;
  ackLoading = kvStore()
    .get(CRIT_SEEN_KEY)
    .then(
      (raw) => {
        try {
          const v: unknown = raw ? JSON.parse(raw) : [];
          if (Array.isArray(v)) for (const k of v) if (typeof k === "string" && k.length <= 200) acked.add(k);
        } catch {
          /* a broken entry is ignored */
        }
      },
      () => undefined,
    )
    .finally(() => {
      ackLoaded = true;
      recount();
    });
}

/** The watch of an event: a local change in this launch wins over the value the BFF sent with the card / detail. */
export function useWatchRef(eventId: string, server: WatchRef | null | undefined): WatchRef | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  const local = watchStore.get(eventId);
  return local !== undefined ? local : (server ?? null);
}

/** Tab bar badge: critical changes not seen on the Watch tab yet (0 — no badge). */
export function useCriticalCount(): number {
  return useSyncExternalStore(subscribe, () => badge, () => 0);
}
