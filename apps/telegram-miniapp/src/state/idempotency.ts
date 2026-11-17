import { newIdempotencyKey } from "../api/client";

/** Idempotency-Key bound to the exact content of a draft. */
export interface DraftKey {
  fingerprint: string;
  key: string;
}

/**
 * Same content → same key (a retry after a lost response never creates a duplicate); any edit → a new key
 * (otherwise the server would return the first version and the edit would be silently lost — review 🟡-10).
 */
export function keyForDraft(prev: DraftKey | null, content: unknown, make: () => string = newIdempotencyKey): DraftKey {
  const fingerprint = JSON.stringify(content);
  return prev && prev.fingerprint === fingerprint ? prev : { fingerprint, key: make() };
}
