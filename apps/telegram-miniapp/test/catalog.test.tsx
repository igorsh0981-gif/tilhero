import type { EventCard } from "@tilhero/contracts/bff";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, EventsQuery } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { resetCatalogMemory } from "../src/events/memory";
import { resetSavedFiltersCache } from "../src/events/saved";
import { I18nProvider } from "../src/i18n";
import { Catalog } from "../src/screens/events/Catalog";
import { AppContext, type AppCtx } from "../src/state/app";
import { resetDirectoryCache } from "../src/state/directory";

const ev = (n: number, title = `Event ${n}`): EventCard => ({
  event_id: `7d3c2b1a-0e9f-4a8b-8c7d-${String(n).padStart(12, "0")}`,
  title,
  categories: ["music.jazz", "music"],
  is_past: false,
  start: { local_date: "2026-11-01", local_time: null, utc: null, timezone: null },
  end: null,
  venue: { name: "Hall", city: "Baku", country_code: "AZ" },
  online: false,
  lifecycle: { status: "ON_SALE", changed_at: "2026-10-10T03:42:00Z" },
  quality_score: 50,
  price_range: null,
  media: null,
  updated_at: "2026-10-10T03:42:00Z",
});

interface Call {
  q: EventsQuery;
  resolve: (p: { items: EventCard[]; next_cursor: string | null }) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
}

function setup() {
  const calls: Call[] = [];
  const list = vi.fn(
    (q: EventsQuery, signal?: AbortSignal) =>
      new Promise<{ items: EventCard[]; next_cursor: string | null }>((resolve, reject) => {
        calls.push({ q, resolve, reject, signal });
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  const api = {
    // facets unavailable (old BFF): chips without counters
    events: { list, get: vi.fn(), facets: vi.fn(async () => Promise.reject(new ApiError(404, "NOT_FOUND", "x"))) },
    directory: { interests: async () => ({ items: [] }), geographies: async () => ({ items: [] }) },
  } as unknown as Api;
  const ctx = { api, navigate: vi.fn() } as unknown as AppCtx;
  render(
    <I18nProvider initial="ru">
      <AppContext.Provider value={ctx}>
        <Catalog />
      </AppContext.Provider>
    </I18nProvider>,
  );
  return { calls, list };
}

beforeEach(() => {
  resetCatalogMemory();
  resetSavedFiltersCache();
  localStorage.clear();
  resetDirectoryCache();
});
afterEach(cleanup);

describe("Catalog paging", () => {
  it("changing a filter while the next page loads: the old page is cancelled and dropped, «Показать ещё» works again", async () => {
    const { calls } = setup();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const first = calls.at(-1)!;
    await act(async () => first.resolve({ items: [ev(1), ev(2)], next_cursor: "c1" }));
    const more = await screen.findByTestId("ct-more");
    await userEvent.click(more);
    const pageCall = calls.at(-1)!;
    expect(pageCall.q).toEqual({ ...first.q, cursor: "c1" }); // the first page's query (incl. date window) + cursor
    expect(screen.getByTestId("ct-more")).toBeDisabled();

    // new filter during the page load
    await userEvent.click(screen.getByRole("button", { name: "Online" }));
    await waitFor(() => expect(pageCall.signal?.aborted).toBe(true));
    const second = calls.at(-1)!;
    expect(second.q).toMatchObject({ online: "true" });
    expect(second.q.cursor).toBeUndefined();
    await act(async () => second.resolve({ items: [ev(3, "Online one")], next_cursor: "c2" }));
    // the late answer of the cancelled page never lands
    await act(async () => pageCall.resolve({ items: [ev(9, "Stale page")] , next_cursor: null }));
    expect(screen.queryByText("Stale page")).toBeNull();

    const more2 = screen.getByTestId("ct-more");
    expect(more2).toBeEnabled();
    await userEvent.click(more2);
    expect(calls.at(-1)!.q).toEqual({ ...second.q, cursor: "c2" });
    await act(async () => calls.at(-1)!.resolve({ items: [ev(4, "Online two")], next_cursor: null }));
    expect(screen.getAllByTestId("event-card").map((e) => e.querySelector(".ec-t")!.textContent)).toEqual(["Online one", "Online two"]);
    expect(screen.getByTestId("ct-found")).toHaveTextContent("Найдено: 2");
  });

  it("«Найдено» is hidden while a new query loads; an invalid cursor restarts the first page", async () => {
    const { calls } = setup();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await act(async () => calls.at(-1)!.resolve({ items: [ev(1)], next_cursor: "c1" }));
    expect(screen.getByTestId("ct-found")).toHaveTextContent("Найдено: 1+");
    await userEvent.click(screen.getByTestId("ct-more"));
    const n = calls.length;
    await act(async () => calls.at(-1)!.reject(new ApiError(400, "INVALID_CURSOR", "bad cursor")));
    await waitFor(() => expect(calls.length).toBe(n + 1));
    expect(calls.at(-1)!.q.cursor).toBeUndefined();
    expect(screen.queryByTestId("ct-found")).toBeNull(); // no stale count while the restart loads
    await act(async () => calls.at(-1)!.resolve({ items: [ev(5), ev(6)], next_cursor: null }));
    expect(screen.getByTestId("ct-found")).toHaveTextContent("Найдено: 2");
    expect(screen.queryByText(/Не получилось/)).toBeNull();
  });

  it("a stable 4xx on the cursor restarts the first page only once, then shows the retry note", async () => {
    const { calls } = setup();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await act(async () => calls.at(-1)!.resolve({ items: [ev(1)], next_cursor: "c1" }));
    await userEvent.click(screen.getByTestId("ct-more"));
    await act(async () => calls.at(-1)!.reject(new ApiError(400, "INVALID_CURSOR", "bad")));
    await waitFor(() => expect(calls.at(-1)!.q.cursor).toBeUndefined()); // restart #1
    await act(async () => calls.at(-1)!.resolve({ items: [ev(1)], next_cursor: "c1" }));
    const n = calls.length;
    await userEvent.click(screen.getByTestId("ct-more"));
    await act(async () => calls.at(-1)!.reject(new ApiError(400, "INVALID_CURSOR", "bad")));
    expect(calls.length).toBe(n + 1); // no second restart
    expect(await screen.findByRole("button", { name: "Повторить" })).toBeVisible();
    expect(screen.getAllByTestId("event-card")).toHaveLength(1);
  });

  it("429 on the next page shows the retry note and never restarts the search", async () => {
    const { calls } = setup();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await act(async () => calls.at(-1)!.resolve({ items: [ev(1)], next_cursor: "c1" }));
    await userEvent.click(screen.getByTestId("ct-more"));
    const n = calls.length;
    await act(async () => calls.at(-1)!.reject(new ApiError(429, "RATE_LIMITED", "slow down", { retry_after: 5 })));
    expect(await screen.findByText(/Слишком много запросов/)).toBeVisible();
    expect(calls.length).toBe(n);
    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(calls.at(-1)!.q.cursor).toBe("c1");
  });
});
