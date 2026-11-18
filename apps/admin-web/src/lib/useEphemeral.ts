import { useCallback, useEffect, useRef, useState } from "react";

export const SECRET_TTL_MS = 60_000;

/**
 * A one-time secret on screen (temporary staff password): kept only in component state and dropped from the DOM
 * and memory after `ttlMs`, when the browser tab is hidden or the page is left (pagehide), and on unmount (the
 * drawer is closed / the operator switched the section tab). Returns [value, set, msLeft].
 */
export function useEphemeral<T>(ttlMs = SECRET_TTL_MS): [T | null, (v: T | null) => void, number] {
  const [state, setState] = useState<{ v: T; until: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef(state);
  ref.current = state;
  const set = useCallback(
    (v: T | null) => {
      setNow(Date.now());
      setState(v == null ? null : { v, until: Date.now() + ttlMs });
    },
    [ttlMs],
  );
  useEffect(() => {
    if (!state) return;
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= state.until) setState(null);
    }, 1000);
    return () => clearInterval(id);
  }, [state]);
  useEffect(() => {
    const drop = () => {
      if (document.visibilityState === "hidden" && ref.current) setState(null);
    };
    const leave = () => setState(null);
    document.addEventListener("visibilitychange", drop);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", drop);
      window.removeEventListener("pagehide", leave);
    };
  }, []);
  return [state?.v ?? null, set, state ? Math.max(0, state.until - now) : 0];
}
