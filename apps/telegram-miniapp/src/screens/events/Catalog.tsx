import type { EventCard, EventFacets, GeoOption, InterestCategory } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../api/errors";
import {
  activeFilterCount,
  countryOptions,
  DEFAULT_FILTERS,
  filtersToFacetsQuery,
  filtersToQuery,
  isDefaultFilters,
  MAX_COUNTRIES,
  OTHER_CATEGORY,
  Q_MAX,
  queryKey,
  type CatalogFilters,
  type DateRange,
  type FormatFilter,
} from "../../events/catalog";
import type { EventsQuery } from "../../api/endpoints";
import { forgetSavedFilters, loadSavedFiltersWithin, peekSavedFilters, persistFilters } from "../../events/saved";
import { useOpenEvent, useTypeLabel } from "../../events/hooks";
import { catalogMemory, resetCatalogMemory, type CatalogMemory } from "../../events/memory";
import { useI18n } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { useGeographies, useInterests } from "../../state/directory";
import { haptic } from "../../tg";
import { WatchableCard } from "../watch/WatchableCard";
import { useWatchAction } from "../watch/WatchSheet";
import { Icon } from "../../ui/Icon";
import { countryName } from "../../ui/EventCard";
import { Chip, Note, Seg, Spinner, ToggleRow } from "../../ui/kit";
import { Sheet } from "../../ui/overlays";
import { QuickChip } from "../../ui/QuickChip";
import { RadioChips } from "../../ui/RadioChips";
import { openAiHome, useAiAvailable } from "../ai/entry";

/**
 * «События» — the searchable catalogue (AT-24: a search screen, not a carousel): debounced search, quick chips,
 * filter sheet with an active counter, «Найдено: N», infinite loading by cursor, list/grid, empty and error states.
 * State survives opening an event and coming back (module memory for this launch).
 * Fix 4.1: several countries (chips with ×, each counts in the «Фильтры» badge); the filters are saved between
 * launches (CloudStorage / localStorage, events/saved.ts); quick chips show the number of matching events from
 * GET /v1/events/facets (0 → muted, no badge; no facets → plain chips); «Другое» chip for events without a category.
 */
type View = CatalogMemory["view"];
let focusRequested = false;

/** Home search bar → open the catalogue with the search field focused. */
export function requestCatalogSearchFocus(): void {
  focusRequested = true;
}
let presetRequested: Partial<CatalogFilters> | null = null;
let presetNote: { n: number; since: string } | null = null;
/** Sprint 6: Home summary «N новых событий» → the catalogue sorted by «Новые» (default filters, not saved), with a
 *  note saying what the user is looking at (the catalogue has no «since» filter — the newest come first). */
export function requestCatalogPreset(p: Partial<CatalogFilters>, note: { n: number; since: string } | null = null): void {
  presetRequested = p;
  presetNote = note;
  resetCatalogMemory();
}
export { resetCatalogMemory };

const SEARCH_DEBOUNCE_MS = 350;
/** quick-chip counters follow the filters after this pause (rapid taps → one request) */
const FACETS_DEBOUNCE_MS = 250;
const COUNTRIES_COLLAPSED = 12;
/** «any» option of a radio chip group (no taxonomy code or ISO country can be empty). */
const ANY = "";

function dedupe(list: EventCard[]): EventCard[] {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.event_id) ? false : (seen.add(e.event_id), true)));
}

/** "Найдено: {n}" with the number in bold (dictionary string split around the placeholder). */
function Found({ text, n }: { text: string; n: string }) {
  const [before = "", after = ""] = text.split("{n}");
  return (
    <span className="found" data-testid="ct-found" aria-live="polite">
      {before}
      <b className="num">{n}</b>
      {after}
    </span>
  );
}

export function Catalog() {
  const { api } = useApp();
  const { t, l, lang } = useI18n();
  const errText = useErrorText();
  const typeLabel = useTypeLabel();
  const openEvent = useOpenEvent();
  const wa = useWatchAction();
  const aiOn = useAiAvailable();
  const interests = useInterests(api);
  const geos = useGeographies(api);

  // a preset from Home (sprint 6) wins over the memory and the saved filters, and is not saved itself
  const [preset] = useState<CatalogFilters | null>(() => (presetRequested ? { ...DEFAULT_FILTERS, ...presetRequested } : null));
  const [note, setNote] = useState(() => (presetRequested ? presetNote : null));
  useEffect(() => {
    presetRequested = null;
    presetNote = null;
  }, []);
  const restored = useRef(preset ? null : catalogMemory.get());
  // filters: this launch's memory, else the saved ones (read once per launch), else the defaults
  const [f, setF] = useState<CatalogFilters>(() => {
    if (preset) return preset;
    if (restored.current) return restored.current.f;
    const saved = peekSavedFilters();
    return saved ? { ...DEFAULT_FILTERS, ...saved } : DEFAULT_FILTERS;
  });
  /** saved filters applied (or none) — no search before that, so the first page is the saved query */
  const [ready, setReady] = useState(() => !!preset || !!restored.current || peekSavedFilters() !== undefined);
  /** the user changed a filter before the store answered — the late saved filters must not override it */
  const touched = useRef(!!preset);
  const [facets, setFacets] = useState<EventFacets | null>(null);
  const [qInput, setQInput] = useState(restored.current?.f.q ?? "");
  const [view, setView] = useState<View>(restored.current?.view ?? "list");
  const [items, setItems] = useState<EventCard[] | null>(restored.current?.items ?? null);
  const [cursor, setCursor] = useState<string | null>(restored.current?.cursor ?? null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [sheet, setSheet] = useState(false);
  const [retry, setRetry] = useState(0);
  const keyRef = useRef(restored.current?.key ?? "");
  const firstReq = useRef<AbortController | null>(null);
  const moreReq = useRef<AbortController | null>(null);
  /** query key for which an invalid cursor already restarted the first page (at most once per query) */
  const cursorRestartedFor = useRef<string | null>(null);
  // query of the loaded first page: next pages keep ITS date window, only the cursor changes
  const pageQuery = useRef<EventsQuery | null>(restored.current?.query ?? null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  // debounced search text → filters
  useEffect(() => {
    const h = setTimeout(() => setF((x) => (x.q === qInput ? x : { ...x, q: qInput })), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [qInput]);

  /* ---------- saved filters: read once per launch, then every applied change is saved ---------- */
  useEffect(() => {
    if (ready) return;
    let alive = true;
    void loadSavedFiltersWithin().then((saved) => {
      if (!alive) return;
      if (saved && !touched.current) setF((x) => ({ ...x, ...saved }));
      setReady(true);
    });
    return () => {
      alive = false;
    };
    // once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (ready && f !== preset) persistFilters(f);
  }, [f, ready, preset]);

  // one «today» for the search and the counters: the «В этом месяце» window is the same in both
  const [query, facetsQuery] = useMemo(() => {
    const today = new Date();
    return [filtersToQuery(f, today), filtersToFacetsQuery(f, today)] as const;
  }, [f]);
  const key = queryKey(query);
  const facetsKey = queryKey(facetsQuery);

  /* ---------- quick-chip counters: debounced, an outdated request is cancelled; failure → no counters ---------- */
  useEffect(() => {
    if (!ready) return;
    const ac = new AbortController();
    const h = setTimeout(() => {
      api.events.facets(facetsQuery, ac.signal).then(
        (x) => !ac.signal.aborted && setFacets(x),
        (e) => {
          if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
          setFacets(null);
        },
      );
    }, FACETS_DEBOUNCE_MS);
    return () => {
      clearTimeout(h);
      ac.abort();
    };
    // facetsQuery is identified by facetsKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, facetsKey, ready]);

  /* ---------- first page (new query or retry) ---------- */
  useEffect(() => {
    if (!ready) return;
    if (key === keyRef.current && items && retry === 0) return; // restored from memory
    firstReq.current?.abort();
    // a page of the previous query must not land in (or block) the new one
    moreReq.current?.abort();
    moreReq.current = null;
    setLoadingMore(false);
    const ac = new AbortController();
    firstReq.current = ac;
    keyRef.current = key;
    pageQuery.current = query;
    setLoading(true);
    setError(null);
    setMoreError(null);
    api.events.list(query, ac.signal).then(
      (page) => {
        if (ac.signal.aborted) return;
        setItems(page.items);
        setCursor(page.next_cursor);
        setLoading(false);
      },
      (e) => {
        if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setError(e);
        setItems(null);
        setCursor(null);
        setLoading(false);
      },
    );
    return () => ac.abort();
    // items/retry are read only as guards
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, retry, ready]);

  /* ---------- next pages ---------- */
  const loadMore = useCallback(() => {
    if (!cursor || loadingMore || loading || !pageQuery.current) return;
    const k = keyRef.current;
    const ac = new AbortController();
    moreReq.current = ac;
    setLoadingMore(true);
    setMoreError(null);
    const discard = () => {
      if (moreReq.current === ac) {
        moreReq.current = null;
        setLoadingMore(false);
      }
    };
    api.events.list({ ...pageQuery.current, cursor }, ac.signal).then(
      (page) => {
        if (ac.signal.aborted || keyRef.current !== k) return discard();
        moreReq.current = null;
        setItems((prev) => dedupe([...(prev ?? []), ...page.items]));
        setCursor(page.next_cursor);
        setLoadingMore(false);
      },
      (e) => {
        if (ac.signal.aborted || keyRef.current !== k || (e instanceof DOMException && e.name === "AbortError")) return discard();
        moreReq.current = null;
        setLoadingMore(false);
        // the cursor is no longer valid (catalogue changed / expired) — start the search over, but only ONCE per
        // query: a stable 4xx would otherwise loop. 429 (rate limit) and a repeated 4xx show the retry note instead.
        const cursorRejected = e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 423, 429].includes(e.status);
        if (cursorRejected && cursorRestartedFor.current !== k) {
          cursorRestartedFor.current = k;
          setRetry((x) => x + 1);
          return;
        }
        setMoreError(e);
      },
    );
  }, [api, cursor, loading, loadingMore]);
  useEffect(() => () => moreReq.current?.abort(), []);

  // infinite loading: the sentinel near the end of the list asks for the next page
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined" || !cursor || moreError) return;
    const io = new IntersectionObserver((entries) => entries.some((x) => x.isIntersecting) && loadMore(), {
      root: document.getElementById("main"),
      rootMargin: "0px 0px 600px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore, moreError]);

  /* ---------- memory: filters, results and scroll survive the detail screen ---------- */
  useEffect(() => {
    catalogMemory.set({ f, view, items, cursor, key: keyRef.current, query: pageQuery.current, scroll: catalogMemory.get()?.scroll ?? 0 });
  }, [f, view, items, cursor]);
  useLayoutEffect(() => {
    const vp = document.getElementById("main");
    if (!vp) return;
    const onScroll = () => {
      const m = catalogMemory.get();
      if (m) m.scroll = vp.scrollTop;
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const y = restored.current?.scroll ?? 0;
    if (y > 0 && restored.current?.items) requestAnimationFrame(() => document.getElementById("main")?.scrollTo({ top: y }));
    if (focusRequested) {
      focusRequested = false;
      inputRef.current?.focus();
    }
  }, []);

  const n = activeFilterCount(f);
  const set = (patch: Partial<CatalogFilters>) => {
    touched.current = true;
    setF((x) => ({ ...x, ...patch }));
  };
  const resetAll = () => {
    touched.current = true;
    setQInput("");
    setF(DEFAULT_FILTERS);
  };
  const topCats = (interests.items ?? []).filter((c) => c.parent === null);
  const otherCount = facets?.categories[OTHER_CATEGORY] ?? 0;
  const countryLabel = (code: string) => countryName(code, lang);
  const unavailable = error instanceof ApiError && (error.code === "EVENTS_UNAVAILABLE" || error.code === "NETWORK" || error.status >= 500);

  let body: React.ReactNode;
  if (error) {
    body = (
      <div className="empty" data-testid="ct-error">
        <div className="empty-art">
          <Icon name="alert" size={44} />
        </div>
        <h3>{t("ct.err.h")}</h3>
        <p>{unavailable ? t("ct.err.p") : errText(error)}</p>
        <div className="btns">
          <button className="btn btn-lime" type="button" onClick={() => setRetry((x) => x + 1)}>
            <Icon name="refresh" size={16} />
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  } else if (!items) {
    body = (
      <div className="ct-list" aria-busy="true" aria-label={t("ct.loading")} data-testid="ct-loading">
        {[0, 1, 2].map((i) => (
          <div key={i} className="ct-sk sk" />
        ))}
      </div>
    );
  } else if (!items.length) {
    body = (
      <div className="empty" data-testid="ct-empty">
        <div className="empty-art">
          <Icon name="search" size={44} />
        </div>
        <h3>{t("ct.empty.h")}</h3>
        <p>{t(aiOn ? "ct.empty.pAi" : "ct.empty.p")}</p>
        {(!isDefaultFilters({ ...f, q: qInput }) || aiOn) && (
          <div className="btns">
            {!isDefaultFilters({ ...f, q: qInput }) && (
              <button className="btn btn-soft" type="button" onClick={resetAll}>
                <Icon name="refresh" size={16} />
                {t("ct.reset")}
              </button>
            )}
            {aiOn && (
              // sprint 7: the concierge in home mode with the search text — the search runs at once
              <button className="btn btn-lime" type="button" data-testid="ct-ask-ai" onClick={() => openAiHome(qInput.trim() || null, qInput.trim() ? `«${qInput.trim().slice(0, 60)}»` : null)}>
                <Icon name="spark" size={16} />
                {t("ct.askAi")}
              </button>
            )}
          </div>
        )}
      </div>
    );
  } else {
    body = (
      <>
        <div className={view === "grid" ? "ct-list grid" : "ct-list"} data-testid="ct-list" aria-busy={loading || undefined}>
          {items.map((e) => (
            <WatchableCard key={e.event_id} event={e} variant={view} typeLabel={typeLabel(e.categories)} onOpen={openEvent} wa={wa} />
          ))}
        </div>
        <div className="ct-foot">
          {moreError ? (
            <Note tone="bad" icon="alert" action={{ label: t("common.retry"), onClick: loadMore }}>
              {errText(moreError)}
            </Note>
          ) : cursor ? (
            <>
              <div ref={sentinel} aria-hidden="true" />
              <button className="btn btn-soft btn-block" type="button" onClick={loadMore} disabled={loadingMore} data-testid="ct-more">
                {loadingMore ? <Spinner small /> : <Icon name="chevD" size={16} />}
                {t("ct.more")}
              </button>
            </>
          ) : (
            <p className="hint">{t("ct.end")}</p>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <header className="pg-h">
        <h1>{t("ct.h")}</h1>
        <div className="seg ct-view" role="group" aria-label={t("ct.view")}>
          {(["list", "grid"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} aria-label={t(v === "list" ? "ct.view.list" : "ct.view.grid")} onClick={() => setView(v)}>
              <Icon name={v} size={18} />
            </button>
          ))}
        </div>
      </header>
      <div className="field ct-search">
        <Icon name="search" size={18} />
        <input
          ref={inputRef}
          id="ctSearch"
          type="search"
          autoComplete="off"
          enterKeyHint="search"
          maxLength={Q_MAX}
          placeholder={t("ct.search")}
          aria-label={t("ct.search")}
          value={qInput}
          onChange={(e) => setQInput(e.target.value.slice(0, Q_MAX))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setF((x) => ({ ...x, q: qInput }));
              e.currentTarget.blur();
            }
          }}
        />
        {qInput && (
          <button className="ct-clear" type="button" aria-label={t("ct.search.clear")} onClick={() => setQInput("")}>
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
      <div className="chips ct-chips" role="group" aria-label={t("ct.quick")} data-facets={facets ? "on" : "off"}>
        <QuickChip id="month" pressed={f.dates === "month"} count={facets?.this_month} label={t("ct.q.month")} onToggle={() => set({ dates: f.dates === "month" ? "any" : "month" })} />
        <QuickChip id="onsale" pressed={f.hasTickets} count={facets?.has_tickets} label={t("ct.q.onsale")} onToggle={() => set({ hasTickets: !f.hasTickets })} />
        <QuickChip id="online" pressed={f.format === "online"} count={facets?.online} label={t("ct.q.online")} onToggle={() => set({ format: f.format === "online" ? "any" : "online" })} />
        {topCats.map((c) => {
          const on = f.category === c.code || !!f.category?.startsWith(`${c.code}.`);
          return (
            <QuickChip key={c.code} id={c.code} pressed={on} count={facets ? (facets.categories[c.code] ?? 0) : undefined} label={l(c.label)} onToggle={() => set({ category: on ? null : c.code })} />
          );
        })}
        {(otherCount > 0 || f.category === OTHER_CATEGORY) && (
          <QuickChip
            id={OTHER_CATEGORY}
            pressed={f.category === OTHER_CATEGORY}
            count={facets ? otherCount : undefined}
            label={t("cat.other")}
            onToggle={() => set({ category: f.category === OTHER_CATEGORY ? null : OTHER_CATEGORY })}
          />
        )}
      </div>
      <div className="ct-bar">
        {items && !error && !loading ? <Found text={t(cursor ? "ct.foundMore" : "ct.found")} n={String(items.length)} /> : <span className="found">{loading ? t("ct.loading") : ""}</span>}
        <button className="btn btn-sm btn-soft ct-flt" type="button" onClick={() => setSheet(true)} aria-label={n ? t("ct.filters.n", { n }) : t("ct.filters")}>
          <Icon name="sliders" size={16} />
          {t("ct.filters")}
          {n > 0 && (
            <span className="cnt" data-testid="ct-filter-count">
              {n}
            </span>
          )}
        </button>
      </div>
      {note && f.sort === "newest" && (
        <div className="pd ct-note">
          <Note icon="spark" tone="lime" action={{ label: t("ct.newNote.hide"), onClick: () => setNote(null) }}>
            <span data-testid="ct-new-note">{note.since ? t("ct.newNote", { n: note.n, d: note.since }) : t("ct.newNote.noDate", { n: note.n })}</span>
          </Note>
        </div>
      )}
      {f.countries.length > 0 && (
        <div className="tags ct-tags" data-testid="ct-countries" role="group" aria-label={t("f.country")}>
          {f.countries.map((code) => (
            <span className="tag" key={code} data-country={code}>
              <span>{countryLabel(code)}</span>
              <button
                className="x"
                type="button"
                aria-label={t("a11y.remove", { name: countryLabel(code) })}
                onClick={() => {
                  haptic.selection();
                  set({ countries: f.countries.filter((c) => c !== code) });
                }}
              >
                <Icon name="x" size={14} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="ct-res">{body}</div>
      <div className="scr-end" />
      {sheet && (
        <FiltersSheet
          value={f}
          categories={interests.items ?? []}
          geos={geos.items ?? []}
          hasOther={otherCount > 0}
          onClose={() => setSheet(false)}
          onApply={(next) => {
            touched.current = true;
            setSheet(false);
            // applied defaults («Сбросить» → «Применить») forget the saved entry, even if the store has not
            // answered yet (persistFilters keeps an unread entry on defaults); otherwise the usual save effect
            if (isDefaultFilters({ ...next, q: "" })) forgetSavedFilters();
            setF({ ...next, q: qInput });
          }}
        />
      )}
      {wa.sheet}
    </>
  );
}

/* ---------- filter sheet ---------- */
function FiltersSheet(props: {
  value: CatalogFilters;
  categories: InterestCategory[];
  geos: GeoOption[];
  /** facets have events without a category → «Другое» option */
  hasOther: boolean;
  onClose: () => void;
  onApply: (f: CatalogFilters) => void;
}) {
  const { t, l, lang } = useI18n();
  const [d, setD] = useState<CatalogFilters>(props.value);
  const [allCountries, setAllCountries] = useState(false);
  const set = (patch: Partial<CatalogFilters>) => setD((x) => ({ ...x, ...patch }));
  const tops = props.categories.filter((c) => c.parent === null);
  const selectedTop = d.category?.split(".")[0] ?? null;
  const subs = selectedTop ? props.categories.filter((c) => c.parent === selectedTop) : [];
  // preferences directory + CIS countries of the AI sources (sprint 4) with local RU/EN names if the directory lacks them
  const countries = countryOptions(props.geos);
  // the directory has dozens of countries: the first ones + the selected one, the rest on demand
  const shownCountries = allCountries ? countries : countries.filter((g, i) => i < COUNTRIES_COLLAPSED || d.countries.includes(g.code));
  const labelOf = (code: string) => {
    const o = countries.find((g) => g.code === code);
    return o ? l(o.label) : countryName(code, lang);
  };
  const full = d.countries.length >= MAX_COUNTRIES;
  const toggleCountry = (code: string) =>
    setD((x) => ({ ...x, countries: x.countries.includes(code) ? x.countries.filter((c) => c !== code) : x.countries.length >= MAX_COUNTRIES ? x.countries : [...x.countries, code] }));
  const catOptions = [
    { value: ANY, label: t("f.cat.any") },
    ...tops.map((c) => ({ value: c.code, label: l(c.label) })),
    ...(props.hasOther || d.category === OTHER_CATEGORY ? [{ value: OTHER_CATEGORY, label: t("cat.other") }] : []),
  ];
  const dates: DateRange[] = ["any", "month", "3", "6", "12"];
  const formats: FormatFilter[] = ["any", "offline", "online"];
  return (
    <Sheet
      title={t("f.title")}
      onClose={props.onClose}
      className="flt-sheet"
      foot={
        <>
          <button
            className="btn btn-soft flt-reset"
            type="button"
            // only the draft: closing the sheet without «Применить» keeps the applied (and saved) filters
            onClick={() => setD({ ...DEFAULT_FILTERS, q: d.q })}
          >
            {t("f.reset")}
          </button>
          <button className="btn btn-lime grow" type="button" data-testid="f-apply" onClick={() => props.onApply(d)}>
            {t("f.show")}
          </button>
        </>
      }
    >
      <div className="flt-g">
        <h3 className="lbl">{t("f.dates")}</h3>
        <RadioChips
          label={t("f.dates")}
          value={d.dates}
          onChange={(v) => set({ dates: v })}
          options={dates.map((v) => ({ value: v, label: t(v === "any" ? "f.d.any" : v === "month" ? "f.d.month" : v === "3" ? "f.d.3" : v === "6" ? "f.d.6" : "f.d.12") }))}
        />
      </div>
      <div className="flt-g">
        <h3 className="lbl">{t("f.cat")}</h3>
        <RadioChips
          label={t("f.cat")}
          value={selectedTop ?? ANY}
          onChange={(v) => set({ category: v === ANY ? null : v })}
          options={catOptions}
        />
        {subs.length > 0 && selectedTop && (
          <RadioChips
            className="sub"
            label={l(tops.find((c) => c.code === selectedTop)?.label)}
            value={d.category === selectedTop ? null : d.category}
            onChange={(v) => set({ category: v })}
            options={subs.map((c) => ({ value: c.code, label: l(c.label) }))}
          />
        )}
      </div>
      <div className="flt-g">
        <h3 className="lbl">{t("f.country")}</h3>
        {d.countries.length > 0 && (
          <div className="tags" data-testid="f-countries">
            {d.countries.map((code) => (
              <span className="tag" key={code} data-country={code}>
                <span>{labelOf(code)}</span>
                <button className="x" type="button" aria-label={t("a11y.remove", { name: labelOf(code) })} onClick={() => toggleCountry(code)}>
                  <Icon name="x" size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="wrap" role="group" aria-label={t("f.country.pick")}>
          <Chip pressed={d.countries.length === 0} onToggle={() => set({ countries: [] })}>
            {t("f.any")}
          </Chip>
          {shownCountries.map((g) => {
            const on = d.countries.includes(g.code);
            return (
              <Chip key={g.code} pressed={on} disabled={!on && full} onToggle={() => toggleCountry(g.code)}>
                {l(g.label)}
              </Chip>
            );
          })}
        </div>
        {full && <p className="hint">{t("f.country.max", { n: MAX_COUNTRIES })}</p>}
        {!allCountries && countries.length > shownCountries.length && (
          <button className="lnk" type="button" onClick={() => setAllCountries(true)}>
            {t("f.country.all", { n: countries.length })}
            <Icon name="chevD" size={14} />
          </button>
        )}
      </div>
      <div className="flt-g">
        <h3 className="lbl">{t("f.format")}</h3>
        <Seg
          value={d.format}
          label={t("f.format")}
          onChange={(v) => set({ format: v })}
          options={formats.map((v) => ({ value: v, label: t(v === "any" ? "f.fmt.any" : v === "online" ? "ev.online" : "ev.offline") }))}
        />
        <ToggleRow title={t("f.onsale")} sub={t("f.onsale.sub")} on={d.hasTickets} onChange={(v) => set({ hasTickets: v })} />
      </div>
      <div className="flt-g">
        <h3 className="lbl">{t("f.sort")}</h3>
        <Seg
          value={d.sort}
          label={t("f.sort")}
          onChange={(v) => set({ sort: v })}
          options={[
            { value: "soonest" as const, label: t("f.s.soonest") },
            { value: "newest" as const, label: t("f.s.newest") },
            { value: "quality" as const, label: t("f.s.quality") },
          ]}
        />
      </div>
    </Sheet>
  );
}
