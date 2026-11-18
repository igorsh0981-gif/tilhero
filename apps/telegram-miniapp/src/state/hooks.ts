import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../api/errors";
import { useI18n } from "../i18n";

/** A user action with busy state and a localised error (by business code). */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const { t, fmt } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorObj, setErrorObj] = useState<unknown>(null);
  const latest = useRef(fn);
  latest.current = fn;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async (...a: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      setErrorObj(null);
      try {
        return await latest.current(...a);
      } catch (e) {
        if (mounted.current) {
          setError(errorText(e, t, fmt.mmss));
          setErrorObj(e);
        }
        return undefined;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [t, fmt],
  );
  return { run, busy, error, errorObj, setError };
}

/** Load data on mount / when deps change; `reload` repeats, `setData` applies a mutation result. */
export function useLoad<T>(loader: () => Promise<T>, deps: readonly unknown[]) {
  const { t, fmt } = useI18n();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(loader);
  latest.current = loader;
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const v = await latest.current();
      if (my === seq.current) setData(v);
    } catch (e) {
      if (my === seq.current) setError(errorText(e, t, fmt.mmss));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [t, fmt]);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload: load, setData };
}
