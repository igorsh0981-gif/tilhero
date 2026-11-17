import { getWebApp, supports } from "./webapp";

/**
 * Small key-value store that survives Mini App launches: Telegram CloudStorage (Bot API 6.9+, per user and bot,
 * the same on every device) when available, otherwise the browser's localStorage. Never throws: localStorage may be
 * missing or throw (private mode, sandboxed webviews), CloudStorage may answer with an error or not at all (timeout).
 * Only small non-sensitive UI state goes here (catalogue filters) — never tokens or personal data.
 */
export interface KvStore {
  readonly kind: "cloud" | "local" | "none";
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** CloudStorage key rules; also used as the localStorage key (with a prefix). */
const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const KV_VALUE_MAX = 4096;
const LOCAL_PREFIX = "tilhero:";
const CLOUD_TIMEOUT_MS = 2500;

function localStore(): KvStore {
  let ls: Storage | null = null;
  try {
    ls = typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    ls = null;
  }
  if (!ls) return { kind: "none", get: async () => null, set: async () => undefined, remove: async () => undefined };
  const s = ls;
  return {
    kind: "local",
    get: async (key) => {
      try {
        return s.getItem(LOCAL_PREFIX + key);
      } catch {
        return null;
      }
    },
    set: async (key, value) => {
      try {
        s.setItem(LOCAL_PREFIX + key, value);
      } catch {
        /* quota / disabled storage: not saved */
      }
    },
    remove: async (key) => {
      try {
        s.removeItem(LOCAL_PREFIX + key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Resolves with the callback's value, or `fallback` on error, throw or timeout (some clients never call back). */
function cloudCall<T>(run: (done: (v: T) => void) => void, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(fallback), CLOUD_TIMEOUT_MS);
    try {
      run(finish);
    } catch {
      finish(fallback);
    }
  });
}

/** localStorage only (prefixed keys; "none" when storage is unavailable) — the fallback copy next to CloudStorage. */
export function localKvStore(): KvStore {
  return localStore();
}

export function kvStore(): KvStore {
  const cs = getWebApp()?.CloudStorage;
  if (!cs || !supports("6.9")) return localStore();
  return {
    kind: "cloud",
    get: (key) =>
      KEY_RE.test(key)
        ? cloudCall<string | null>((done) => cs.getItem(key, (err, v) => done(err ? null : typeof v === "string" && v !== "" ? v : null)), null)
        : Promise.resolve(null),
    set: (key, value) =>
      KEY_RE.test(key) && value.length <= KV_VALUE_MAX ? cloudCall<void>((done) => cs.setItem(key, value, () => done()), undefined) : Promise.resolve(),
    remove: (key) => (KEY_RE.test(key) ? cloudCall<void>((done) => cs.removeItem(key, () => done()), undefined) : Promise.resolve()),
  };
}
