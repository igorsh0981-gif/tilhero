/**
 * Catalogue filters saved between launches (fix 4.1): countries and the other filters of the catalogue (not the
 * search text) in Telegram CloudStorage when the client has it (Bot API 6.9+), otherwise in localStorage (src/tg/storage).
 *
 * - The first read happens once per launch (preloaded when the catalogue opens); its result is cached in memory.
 * - Writes mirror the applied filters: defaults remove the entry, the same value is not written twice.
 * - Applied defaults («Сбросить» → «Применить» in the filter sheet), logout and profile deletion clear the entry
 *   (forgetSavedFilters); «Сбросить» alone only resets the sheet draft.
 */
import { kvStore } from "../tg/storage";
import { parseSavedFilters, serializeFilters, type CatalogFilters, type SavedFilters } from "./catalog";

export const SAVED_FILTERS_KEY = "catalog_filters_v1";
/** The catalogue does not wait longer than this for the store (a silent CloudStorage must not block the search). */
export const SAVED_FILTERS_WAIT_MS = 1200;

let loaded: { value: SavedFilters | null } | null = null;
let pending: Promise<SavedFilters | null> | null = null;
/** last value written (or read) — "" = nothing saved; undefined = unknown yet */
let lastWritten: string | undefined;

/** Saved filters if already read in this launch (undefined = not read yet). */
export function peekSavedFilters(): SavedFilters | null | undefined {
  return loaded ? loaded.value : undefined;
}

/** Reads the saved filters once per launch; never rejects. */
export function loadSavedFilters(): Promise<SavedFilters | null> {
  if (loaded) return Promise.resolve(loaded.value);
  pending ??= kvStore()
    .get(SAVED_FILTERS_KEY)
    .then(
      (raw) => {
        const value = parseSavedFilters(raw);
        // a write that happened while reading wins (the user already changed the filters)
        if (!loaded) {
          loaded = { value };
          lastWritten ??= value ? (serializeFilters({ ...value, q: "" }) ?? "") : "";
        }
        return loaded.value;
      },
      () => {
        loaded ??= { value: null };
        return loaded.value;
      },
    )
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Saved filters, or null after SAVED_FILTERS_WAIT_MS (then the catalogue starts with the defaults). */
export function loadSavedFiltersWithin(ms = SAVED_FILTERS_WAIT_MS): Promise<SavedFilters | null> {
  return Promise.race([loadSavedFilters(), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** Saves the applied filters (defaults → entry removed). */
export function persistFilters(f: CatalogFilters): void {
  const value = serializeFilters(f);
  const next = value ?? "";
  // The store has not answered yet (slow CloudStorage, the catalogue started with the defaults after the wait):
  // defaults must not delete what was saved in an earlier launch. Only a real change by the user is written.
  if (lastWritten === undefined && !value) return;
  if (next === lastWritten) return;
  lastWritten = next;
  const parsed = value ? parseSavedFilters(value) : null;
  loaded = { value: parsed };
  const store = kvStore();
  void (value ? store.set(SAVED_FILTERS_KEY, value) : store.remove(SAVED_FILTERS_KEY));
}

/** Applied «Сбросить», logout, profile deletion: the saved entry is removed. */
export function forgetSavedFilters(): void {
  loaded = { value: null };
  lastWritten = "";
  void kvStore().remove(SAVED_FILTERS_KEY);
}

/** Tests: start a new «launch». */
export function resetSavedFiltersCache(): void {
  loaded = null;
  pending = null;
  lastWritten = undefined;
}
