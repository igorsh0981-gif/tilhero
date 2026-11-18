import { useEffect, useState } from "react";

/** Shared 1-second clock: every SLA timer on screen re-renders from one interval. */
const subs = new Set<(n: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

export function useNow(enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    subs.add(setNow);
    if (!timer) timer = setInterval(() => {
      const n = Date.now();
      subs.forEach((f) => f(n));
    }, 1000);
    return () => {
      subs.delete(setNow);
      if (!subs.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [enabled]);
  return now;
}
