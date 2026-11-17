/**
 * Catalogue memory for this launch: filters, loaded results and scroll survive opening an event and coming back.
 * Reset on logout, profile deletion and (re)onboarding — another session must not see these results.
 */
import type { EventCard } from "@tilhero/contracts/bff";
import type { EventsQuery } from "../api/endpoints";
import type { CatalogFilters } from "./catalog";

export interface CatalogMemory {
  f: CatalogFilters;
  view: "list" | "grid";
  items: EventCard[] | null;
  cursor: string | null;
  key: string;
  /** query of the first page (date window included): next pages reuse it with the cursor */
  query: EventsQuery | null;
  scroll: number;
}

let memory: CatalogMemory | null = null;

export const catalogMemory = {
  get: (): CatalogMemory | null => memory,
  set: (m: CatalogMemory): void => {
    memory = m;
  },
};

export function resetCatalogMemory(): void {
  memory = null;
}
