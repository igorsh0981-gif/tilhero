import type { GeoOption, InterestCategory } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import type { Api } from "../api/endpoints";
import type { SupportCategory } from "../api/endpoints";

/** Session-wide cache of the directories (interests, geographies, support categories). */
const cache: {
  interests?: Promise<InterestCategory[]>;
  geo?: Promise<GeoOption[]>;
  supportCats?: Promise<SupportCategory[]>;
} = {};

export function resetDirectoryCache(): void {
  delete cache.interests;
  delete cache.geo;
  delete cache.supportCats;
}

function load<T>(key: keyof typeof cache, fn: () => Promise<T[]>): Promise<T[]> {
  const existing = cache[key] as Promise<T[]> | undefined;
  if (existing) return existing;
  const p = fn().catch((e) => {
    delete cache[key];
    throw e;
  });
  (cache as Record<string, Promise<unknown>>)[key] = p;
  return p;
}

/**
 * Leaf interest categories for the chip grid (the prototype shows 12 leaves such as
 * «Автоспорт», «AI»). Parents that have children are not selectable chips.
 */
export function leafInterests(items: InterestCategory[]): InterestCategory[] {
  const parents = new Set(items.map((i) => i.parent).filter((p): p is string => !!p));
  return items.filter((i) => !parents.has(i.code));
}

/**
 * The 12 chips of the approved prototype (proto 20-data.js INTERESTS) as taxonomy codes, in prototype
 * order — the same mapping as PROTOTYPE_INTEREST_CHIPS in the preferences service. «Фестивали» and
 * «Образование» are whole parent categories there.
 */
export const PROTOTYPE_INTEREST_CODES: readonly string[] = [
  "music.concerts", "sport.motorsport", "sport.football", "sport.tennis", "business.ai", "business.fintech",
  "business.conferences", "culture.theatre", "culture.exhibitions", "festivals", "education", "sport.other",
];

/**
 * Chip grid order: the prototype chips the directory knows, then every other leaf category
 * (children of a chip-parent stay available for finer choice). Unknown codes are skipped.
 */
export function interestChips(items: InterestCategory[]): InterestCategory[] {
  const byCode = new Map(items.map((i) => [i.code, i]));
  const head = PROTOTYPE_INTEREST_CODES.map((c) => byCode.get(c)).filter((i): i is InterestCategory => !!i);
  const seen = new Set(head.map((i) => i.code));
  return [...head, ...leafInterests(items).filter((i) => !seen.has(i.code))];
}

export interface DirState<T> {
  items: T[] | null;
  error: unknown;
  retry(): void;
}

function useDir<T>(key: keyof typeof cache, fn: () => Promise<T[]>): DirState<T> {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    load(key, fn).then(
      (v) => alive && setItems(v),
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, n]);
  return { items, error, retry: () => setN((x) => x + 1) };
}

export const useInterests = (api: Api) => useDir("interests", () => api.directory.interests().then((r) => r.items));
export const useGeographies = (api: Api) => useDir("geo", () => api.directory.geographies().then((r) => r.items));
export const useSupportCategories = (api: Api) => useDir("supportCats", () => api.support.categories().then((r) => r.items));

/**
 * Type label of an event for cards: the directory label of its main category (first code), then of its
 * top-level parent, then the bundled top-level name. `fallback(top)` returns the dictionary name.
 */
export function categoryLabel(
  items: InterestCategory[] | null,
  categories: readonly string[],
  lang: "ru" | "en",
  fallback: (top: string) => string,
): string {
  const first = categories[0] ?? "";
  const top = first.split(".")[0] ?? "";
  for (const code of [first, top]) {
    const hit = code ? items?.find((i) => i.code === code) : undefined;
    if (hit) return hit.label[lang] || hit.label.ru || hit.label.en;
  }
  return fallback(top);
}
