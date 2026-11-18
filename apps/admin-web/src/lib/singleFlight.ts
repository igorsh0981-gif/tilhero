/**
 * Coalesces concurrent calls into one in-flight promise: while the first call is pending every further call gets the
 * SAME promise; after it settles the next call starts a new one. Used for the step-up dialog — two commands that hit
 * 403 STEP_UP_REQUIRED at the same time share one TOTP prompt, and neither of them hangs.
 */
export function singleFlight<T>(start: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = start().finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}
