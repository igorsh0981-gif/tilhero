/**
 * Reference lists of the content section (rows of courses, modules, skills, lessons, rubrics, scenarios, media): the
 * selects of the editors (primary skill, rubric, scenario, linked asset) and the course tree. Loaded once per visit of
 * the section, refreshed after a command; a failed kind just leaves its select with the ids already in the payload.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ContentRow } from "@tilhero/contracts/admin";
import type { ContentKind } from "@tilhero/contracts/content";
import { Content } from "../../api/endpoints";

export const REF_KINDS: readonly ContentKind[] = ["course", "module", "skill", "lesson", "rubric", "scenario", "media_asset", "media_exercise"];

export interface Refs {
  rows: Partial<Record<ContentKind, ContentRow[]>>;
  loaded: boolean;
  reload(kind?: ContentKind): Promise<void>;
  options(kind: ContentKind, opts?: { publishedOnly?: boolean }): Array<{ v: string; label: string }>;
  title(kind: ContentKind, key: string | null | undefined): string;
}

const RefsCtx = createContext<Refs>({ rows: {}, loaded: false, reload: async () => undefined, options: () => [], title: (_k, key) => key ?? "" });
export const useRefs = () => useContext(RefsCtx);

async function allRows(kind: ContentKind): Promise<ContentRow[]> {
  const out: ContentRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const r = await Content.list(kind, { cursor, limit: 100 });
    out.push(...r.items);
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  return out;
}

export function RefsProvider({ children }: { children: React.ReactNode }) {
  const [rows, setRows] = useState<Partial<Record<ContentKind, ContentRow[]>>>({});
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async (kind?: ContentKind) => {
    const kinds = kind ? [kind] : REF_KINDS;
    const res = await Promise.allSettled(kinds.map((k) => allRows(k)));
    setRows((prev) => {
      const next = { ...prev };
      kinds.forEach((k, i) => {
        const r = res[i]!;
        if (r.status === "fulfilled") next[k] = r.value;
      });
      return next;
    });
    setLoaded(true);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const value = useMemo<Refs>(
    () => ({
      rows,
      loaded,
      reload,
      options: (kind, opts) =>
        (rows[kind] ?? [])
          .filter((r) => !opts?.publishedOnly || r.published_version != null)
          .map((r) => ({ v: r.key, label: `${r.title.ru || r.key} · ${r.key}` })),
      title: (kind, key) => {
        if (!key) return "";
        const r = (rows[kind] ?? []).find((x) => x.key === key);
        return r?.title.ru || key;
      },
    }),
    [rows, loaded, reload],
  );
  return <RefsCtx.Provider value={value}>{children}</RefsCtx.Provider>;
}

/** Options of a ref select with the current value kept even when it is not in the list (unknown / not loaded). */
export function withCurrent(options: Array<{ v: string; label: string }>, current: string | null | undefined, empty?: string): Array<{ v: string; label: string }> {
  const out = [...options];
  if (current && !out.some((o) => o.v === current)) out.unshift({ v: current, label: current });
  if (empty != null) out.unshift({ v: "", label: empty });
  return out;
}
