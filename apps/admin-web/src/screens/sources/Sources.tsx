import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Source, SourceCrawlStats, SourceDetail } from "@tilhero/contracts/admin";
import { SourcesApi, type SourceFilters } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { DICTS, useI18n, type MessageKey } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, IconBtn, Pill, Reveal, Select, Spinner, Switch, TabPanel, Tabs } from "../../ui/kit";
import { Drawer, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errMeta, errText } from "../../ui/errors";
import { fmtUsd } from "../../lib/money";
import {
  categoryLabel,
  countryName,
  countryOptions,
  CRAWL_TONE,
  crawlCodeHint,
  crawlCodeLabel,
  crawlNoteLabel,
  crawlState,
  MORE_COUNTRIES,
  skipReasonLabel,
  sortedSkips,
  TAXONOMY,
  TIER_TONE,
  TIERS,
  type CrawlState,
} from "../catalog/common";
import { JsonApiEditor } from "./JsonApi";
import { CITY_MAX, cleanDomain, domainProblem, emptyForm, emptyPage, formFromSource, inputFromForm, patchFromForm, rebaseSourceForm, SLUG_RE, validateSource, type FormPage, type SourceErrors, type SourceForm } from "./validate";

const ek = (code: string) => `src.err.${code}` as MessageKey;

/** human names of Source fields (step-up note, «changed» line, change log); unknown fields stay as they are */
export function fieldLabel(t: (k: MessageKey) => string, field: string): string {
  const key = `src.field.${field}` as MessageKey;
  return key in DICTS.ru ? t(key) : field;
}

/**
 * Last crawl of every source (fix 4.1). Optional data from a separate request: the list never waits for it, and when
 * it fails (provider-gateway down, FEATURE_UNAVAILABLE, an older gateway) the column shows «—».
 */
export type CrawlData = { state: "loading" } | { state: "error" } | { state: "ready"; bySlug: ReadonlyMap<string, SourceCrawlStats> };

function useCrawlStats(): [CrawlData, () => void] {
  const [data, setData] = useState<CrawlData>({ state: "loading" });
  const req = useRef(0);
  const load = useCallback(async () => {
    const id = ++req.current;
    setData((d) => (d.state === "ready" ? d : { state: "loading" }));
    try {
      const res = await SourcesApi.crawlStats();
      if (id !== req.current) return;
      const items = Array.isArray(res?.items) ? res.items : [];
      setData({ state: "ready", bySlug: new Map(items.map((c) => [c.slug, c])) });
    } catch {
      if (id === req.current) setData({ state: "error" });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return [data, () => void load()];
}

/** «Sources» (sources.manage): the allowlist of official sites the AI search may read. */
export function SourcesPage({ openId = null }: { openId?: string | null }) {
  const i = useI18n();
  const { t, fmt, lang } = i;
  const [q, setQ] = useState("");
  const [country, setCountry] = useState("");
  const [enabled, setEnabled] = useState<"" | "true" | "false">("");
  const [rows, setRows] = useState<Source[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(openId);
  const [countries, setCountries] = useState<string[]>([]);
  const [crawl, reloadCrawl] = useCrawlStats();
  useEffect(() => setOpen(openId), [openId]);
  const req = useRef(0);

  const filters: SourceFilters = { q: q.trim() || undefined, country: country || undefined, enabled: enabled || undefined };
  const fKey = JSON.stringify(filters);

  const load = useCallback(async (f: SourceFilters, append: boolean) => {
    const id = ++req.current;
    setLoading(true);
    try {
      const p = await SourcesApi.list(f);
      if (id !== req.current) return;
      setRows((xs) => (append ? [...xs, ...p.items] : p.items));
      setCursor(p.next_cursor);
      setError(null);
      setCountries((cs) => [...new Set([...cs, ...p.items.map((s) => s.country_code)])]);
    } catch (e) {
      if (id === req.current) setError(e);
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const tm = setTimeout(() => void load(JSON.parse(fKey) as SourceFilters, false), q ? 300 : 0);
    return () => clearTimeout(tm);
  }, [fKey, load, q]);

  return (
    <div data-testid="sources">
      <div className="page-head">
        <div className="lead">
          <p>{t("src.lead")}</p>
        </div>
        <div className="acts">
          <Btn kind="primary" icon="plus" label={t("src.add")} perm="sources.manage" onClick={() => setOpen("new")} testId="src-add" />
        </div>
      </div>
      <div className="toolbar">
        <div className="input-wrap">
          <Icon name="search" />
          <input className="input" type="search" placeholder={t("src.searchPh")} aria-label={t("src.searchPh")} value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} data-testid="src-q" />
        </div>
        <Select
          id="src-country"
          label={t("rv.f.country")}
          value={country}
          onChange={setCountry}
          testId="src-country"
          options={[{ v: "", label: t("rv.f.allCountries") }, ...countryOptions(lang, countries).map((c) => ({ v: c, label: countryName(lang, c) }))]}
        />
        <Select
          id="src-enabled"
          label={t("src.f.status")}
          value={enabled}
          onChange={setEnabled}
          testId="src-enabled"
          options={[
            { v: "", label: t("src.f.all") },
            { v: "true", label: t("src.on") },
            { v: "false", label: t("src.off") },
          ]}
        />
        <Btn kind="ghost" size="sm" label={t("common.resetFilters")} onClick={() => (setQ(""), setCountry(""), setEnabled(""))} />
      </div>
      {error ? (
        <div className="mb-12">
          <LoadError error={error} onRetry={() => void load(filters, false)} />
        </div>
      ) : null}
      <section className="panel" aria-label={t("page.sources")} aria-busy={loading}>
        <div className="table-wrap">
          <table className="tbl" data-testid="sources-table">
            <thead>
              <tr>
                <th>{t("src.col.name")}</th>
                <th>{t("src.col.country")}</th>
                <th>{t("src.col.tier")}</th>
                <th>{t("src.col.domains")}</th>
                <th className="r">{t("src.col.pages")}</th>
                <th>{t("src.col.state")}</th>
                <th>{t("src.col.crawl")}</th>
                <th className="r">{t("src.col.version")}</th>
                <th>{t("src.col.updated")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr
                  key={s.source_id}
                  className={cx("is-click", s.enabled ? "sev-good" : "sev-none")}
                  tabIndex={0}
                  aria-label={t("common.openRow", { x: s.name })}
                  onClick={() => setOpen(s.source_id)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(s.source_id))}
                  data-source={s.slug}
                >
                  <td>
                    <div className="cell-main">
                      {s.name}
                      {s.listing_pages.some((p) => p.kind === "telegram") && (
                        <span className="tag plain src-tg" title={t("src.kind.telegram")} data-testid="src-tg-tag">
                          Telegram
                        </span>
                      )}
                      {s.listing_pages.some((p) => p.kind === "json_api") && (
                        <span className="tag plain src-tg" title={t("src.kind.json_api.h")} data-testid="src-api-tag">
                          JSON API
                        </span>
                      )}
                    </div>
                    <div className="cell-sub mono">{s.slug}</div>
                  </td>
                  <td className="nowrap">{countryName(lang, s.country_code)}</td>
                  <td>
                    <Pill tone={TIER_TONE[s.tier] ?? "neutral"} dot={false} title={s.tier}>
                      {t(`tier.${s.tier}` as MessageKey)}
                    </Pill>
                  </td>
                  <td>
                    <span className="src-doms">
                      {s.event_domains.slice(0, 2).map((d) => (
                        <span key={d} className="tag">
                          {d}
                        </span>
                      ))}
                      {s.event_domains.length > 2 && (
                        <span className="xs muted" title={s.event_domains.slice(2).join(", ")}>
                          +{s.event_domains.length - 2}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="r mono">{s.listing_pages.length}</td>
                  <td className="nowrap">
                    <Pill tone={s.enabled ? "good" : s.disabled_reason ? "warn" : "neutral"} title={!s.enabled && s.disabled_reason === "robots" ? t("src.autoDisabled.robots") : undefined}>
                      {s.enabled ? t("src.on") : s.disabled_reason === "robots" ? t("src.offRobots") : t("src.off")}
                    </Pill>
                    {s.js_only && (
                      <span className="tag plain src-js" title={t("src.jsOnlyHint")}>
                        JS
                      </span>
                    )}
                  </td>
                  <td className="nowrap" data-testid="src-crawl-cell">
                    <CrawlCell crawl={crawl} slug={s.slug} />
                  </td>
                  <td className="r mono">v{s.version}</td>
                  <td className="nowrap" title={fmt.dateTime(s.updated_at)}>
                    <div className="cell-main">{fmt.rel(s.updated_at)}</div>
                    <div className="cell-sub">
                      <StaffName id={s.updated_by} name={s.updated_by_name} />
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && !rows.length && !error && (
                <tr>
                  <td colSpan={9} className="empty-cell">
                    {q || country || enabled ? (
                      <Empty icon="search" title={t("common.nothingFound")} text={t("common.changeFilters")} />
                    ) : (
                      <Empty icon="globe" title={t("src.empty.t")} text={t("src.empty.m")} />
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && <Spinner label={t("common.loading")} />}
        <div className="pager">
          <span>{t("src.shown", { n: rows.length })}</span>
          {cursor && !loading && <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load({ ...filters, cursor }, true)} testId="src-more" />}
        </div>
      </section>
      <p className="xs muted foot-note">
        <Icon name="info" /> {t("src.foot")}
      </p>
      {open && (
        <SourceDrawer
          id={open}
          crawl={crawl}
          onRetryCrawl={reloadCrawl}
          onClose={() => setOpen(null)}
          onSaved={(s) => {
            setOpen(s.source_id);
            void load(filters, false);
          }}
        />
      )}
    </div>
  );
}

type Tab = "form" | "log";

/** staff name from admin-bff (staff lookup); without it a short id; no id — the research seed */
function StaffName({ id, name }: { id: string | null; name: string | null | undefined }) {
  const { t } = useI18n();
  if (!id) return <>{t("src.bySeed")}</>;
  if (name) return <span title={id}>{name}</span>;
  return <span className="mono" title={id}>{shortId(id, 8, 4)}</span>;
}

/** Status of a crawl in words: events found, the reason it was skipped or failed; the code stays in the tooltip. */
function crawlLabel(t: (k: MessageKey) => string, tp: (k: MessageKey, n: number) => string, c: SourceCrawlStats, st: CrawlState): string {
  switch (st) {
    case "ok":
      return tp("crawl.found", c.events_found);
    case "empty":
      return t("crawl.none");
    case "skipped":
      return c.code ? crawlCodeLabel(t, c.code) : t("crawl.skipped");
    case "error":
      return c.code ? crawlCodeLabel(t, c.code) : t("crawl.error");
    default:
      return t("crawl.never");
  }
}

function CrawlBadge({ c, st, testId }: { c: SourceCrawlStats; st: CrawlState; testId?: string }) {
  const { t, tp } = useI18n();
  const outcome = c.outcome ? t(`crawl.outcome.${c.outcome}` as MessageKey) : "";
  return (
    <Pill tone={CRAWL_TONE[st]} title={c.code ? `${outcome}: ${c.code}` : outcome} testId={testId}>
      {crawlLabel(t, tp, c, st)}
    </Pill>
  );
}

/** «Last crawl» column: badge + when; never crawled — a quiet note; stats unavailable — «—». */
export function CrawlCell({ crawl, slug }: { crawl: CrawlData; slug: string }) {
  const { t, fmt } = useI18n();
  if (crawl.state === "loading")
    return (
      <span className="muted crawl-wait" aria-label={t("crawl.loading")} data-crawl="loading">
        …
      </span>
    );
  if (crawl.state === "error")
    return (
      <span className="muted" title={t("crawl.unavailable")} data-crawl="na">
        —
      </span>
    );
  const c = crawl.bySlug.get(slug);
  const st = crawlState(c);
  if (!c || st === "never")
    return (
      <span className="xs muted" data-crawl="never">
        {t("crawl.never")}
      </span>
    );
  return (
    <div className="crawl-cell" data-crawl={st}>
      <CrawlBadge c={c} st={st} />
      <div className="cell-sub" title={fmt.dateTime(c.last_crawl_at)}>
        {fmt.rel(c.last_crawl_at)}
      </div>
    </div>
  );
}

/**
 * «Last crawl» block of the source card: outcome, what to do about it, counters, cost, page warnings (notes: the page
 * wasn't read in full, some events may be missing) and why events were discarded.
 */
export function CrawlBlock({ crawl, slug, onRetry }: { crawl: CrawlData; slug: string; onRetry: () => void }) {
  const { t, tp, fmt } = useI18n();
  const head = (aside?: ReactNode) => (
    <div className="panel-h">
      <h3 className="panel-t" id="crawl-h">
        <Icon name="scan" />
        {t("crawl.title")}
      </h3>
      <span className="grow" />
      {aside && <div className="crawl-head-aside">{aside}</div>}
    </div>
  );
  if (crawl.state !== "ready") {
    return (
      <section className="panel crawl" aria-labelledby="crawl-h" aria-busy={crawl.state === "loading"} data-testid="src-crawl" data-crawl={crawl.state === "error" ? "na" : "loading"}>
        {head()}
        <div className="crawl-note">
          {crawl.state === "loading" ? (
            <Spinner label={t("crawl.loading")} />
          ) : (
            <>
              <div className="grow">
                <b className="small">{t("crawl.unavailable")}</b>
                <p className="xs muted">{t("crawl.unavailableM")}</p>
              </div>
              <Btn size="sm" icon="refresh" label={t("common.retry")} onClick={onRetry} testId="src-crawl-retry" />
            </>
          )}
        </div>
      </section>
    );
  }
  const c = crawl.bySlug.get(slug);
  const st = crawlState(c);
  if (!c || st === "never") {
    return (
      <section className="panel crawl" aria-labelledby="crawl-h" data-testid="src-crawl" data-crawl="never">
        {head()}
        <p className="crawl-note small muted">{t("crawl.neverM")}</p>
      </section>
    );
  }
  const skips = sortedSkips(c.skipped);
  const notes = sortedSkips(c.notes).items; // older admin-bff: no notes
  const seen = c.events_found + skips.total;
  const hint = st === "skipped" || st === "error" ? crawlCodeHint(t, c.code) : undefined;
  return (
    <section className={cx("panel crawl", `is-${st}`)} aria-labelledby="crawl-h" data-testid="src-crawl" data-crawl={st}>
      {head(
        <>
          <CrawlBadge c={c} st={st} testId="src-crawl-badge" />
          <span className="xs muted crawl-at" title={fmt.rel(c.last_crawl_at)} data-testid="src-crawl-at">
            {t("crawl.at", { t: fmt.dateTime(c.last_crawl_at) })}
          </span>
        </>,
      )}
      {(c.code || hint) && (
        <div className="crawl-status">
          {c.code && <span className={cx("act-code", st === "error" ? "crit" : "sec")}>{c.code}</span>}
          {hint && <p className="small crawl-hint">{hint}</p>}
        </div>
      )}
      <div className="statband crawl-stats">
        <div className="stat">
          <div className="stat-l">{t("crawl.pages")}</div>
          <div className="stat-v" data-testid="crawl-pages">{fmt.num(c.pages)}</div>
        </div>
        <div className="stat">
          <div className="stat-l">{t("crawl.events")}</div>
          <div className="stat-v" data-testid="crawl-events">{fmt.num(c.events_found)}</div>
        </div>
        <div className="stat">
          <div className="stat-l">{t("crawl.dropped")}</div>
          <div className="stat-v" data-testid="crawl-dropped">{fmt.num(skips.total)}</div>
        </div>
        <div className="stat">
          <div className="stat-l">{t("crawl.llm")}</div>
          <div className="stat-v" data-testid="crawl-llm">{fmt.num(c.llm_calls)}</div>
        </div>
        <div className="stat">
          <div className="stat-l">{t("crawl.costLast")}</div>
          <div className="stat-v" data-testid="crawl-cost">{fmtUsd(c.cost_usd_last, 4)}</div>
        </div>
        <div className="stat">
          <div className="stat-l" title={t("crawl.costDayH")}>{t("crawl.costDay")}</div>
          <div className="stat-v" data-testid="crawl-cost-day">{fmtUsd(c.cost_usd_day, 4)}</div>
        </div>
      </div>
      {notes.length > 0 && (
        <div className="crawl-notes" role="group" aria-labelledby="crawl-notes-h">
          <h4 className="crawl-why-h small" id="crawl-notes-h">
            {t("crawl.notesT")}
          </h4>
          <ul data-testid="crawl-notes">
            {notes.map((x) => (
              <li key={x.reason} data-note={x.reason}>
                <Icon name="alert" />
                <span className="small crawl-why-l" title={x.reason}>
                  {crawlNoteLabel(t, x.reason)}
                </span>
                <span className="xs muted crawl-why-n">{tp("crawl.noteTimes", x.n)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {skips.total > 0 ? (
        <div className="crawl-why">
          <h4 className="crawl-why-h small">{t("crawl.droppedT")}</h4>
          <ul data-testid="crawl-skips">
            {skips.items.map((x) => (
              <li key={x.reason} data-reason={x.reason}>
                <span className="small crawl-why-l" title={x.reason}>
                  {skipReasonLabel(t, x.reason)}
                </span>
                <span className="crawl-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(4, Math.round((x.n / Math.max(seen, 1)) * 100))}%` }} />
                </span>
                <span className="xs muted crawl-why-n">{t("crawl.droppedShare", { n: fmt.num(x.n), total: fmt.num(seen) })}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        (st === "ok" || st === "empty") && <p className="crawl-note xs muted">{t("crawl.droppedNone")}</p>
      )}
    </section>
  );
}

/** the operator's unsaved edit that hit 409 SOURCE_VERSION_CONFLICT: the form and the version it was based on */
interface Draft {
  form: SourceForm;
  base: Source;
}
/** the draft carried over to the newer version: the form and the fields to highlight */
interface Rebased {
  form: SourceForm;
  fields: string[];
  version: number;
}

function SourceDrawer({
  id,
  crawl,
  onRetryCrawl,
  onClose,
  onSaved,
}: {
  id: string;
  crawl: CrawlData;
  onRetryCrawl: () => void;
  onClose: () => void;
  onSaved: (s: Source) => void;
}) {
  const i = useI18n();
  const { t } = i;
  const creating = id === "new";
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>("form");
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rebased, setRebased] = useState<Rebased | null>(null);
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  const { can } = useSession();
  const canManage = can("sources.manage");

  const load = useCallback(async () => {
    if (creating) return;
    try {
      setDetail(await SourcesApi.get(id));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [id, creating]);
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const title = creating ? t("src.newT") : detail ? detail.name : t("common.loading");
  // a newer version arrived after the conflict → offer to carry the draft over
  const conflict = draft && detail && detail.version !== draft.base.version ? rebaseSourceForm(draft.form, draft.base, detail) : null;
  const showForm = creating || (!!detail && tab === "form");
  return (
    <Drawer
      wide
      testId="source-card"
      onClose={onClose}
      title={title}
      sub={
        detail ? (
          <>
            <span className="mono">{detail.slug}</span>
            <span>·</span>
            <span className="mono">v{detail.version}</span>
            <Pill tone={detail.enabled ? "good" : "neutral"}>{detail.enabled ? t("src.on") : t("src.off")}</Pill>
          </>
        ) : creating ? (
          <span>{t("src.newSub")}</span>
        ) : undefined
      }
      tabs={
        !creating && detail ? (
          <Tabs<Tab>
            id="src"
            label={t("page.sources")}
            value={tab}
            onChange={setTab}
            className="drawer-tabs"
            items={[
              { v: "form", label: t("src.tab.form"), icon: "sliders", testId: "src-tab-form" },
              { v: "log", label: t("src.tab.log"), icon: "audit", cnt: detail.changes.length, testId: "src-tab-log" },
            ]}
          />
        ) : undefined
      }
      footer={showForm && canManage ? <div className="src-footer" ref={setFooterEl} data-testid="src-footer" /> : undefined}
    >
      {error ? <LoadError error={error} onRetry={() => void load()} /> : null}
      {!creating && !detail && !error && <Spinner label={t("common.loading")} />}
      {creating && <SourceFormView key="new" source={null} footerEl={footerEl} onCancel={onClose} onSaved={onSaved} onConflict={() => undefined} />}
      {!creating && detail && (
        <TabPanel id="src" value={tab}>
          {tab === "form" ? (
            <>
              <div className="mb-12">
                <CrawlBlock crawl={crawl} slug={detail.slug} onRetry={onRetryCrawl} />
              </div>
              {draft && conflict && (
                <div className="mb-12">
                  <Reveal dep={detail.version}>
                    <Callout kind="warn" icon="alert" testId="sf-conflict">
                      <b>{t("src.conflictT")}.</b> {t("src.conflictM", { v: detail.version })}
                      {conflict.both.length > 0 && <span className="block mt-8">{t("src.conflictBoth", { f: conflict.both.map((c) => fieldLabel(t, c)).join(", ") })}</span>}
                      <div className="src-conflict-acts">
                        <Btn
                          kind="primary"
                          size="sm"
                          icon="refresh"
                          label={t("src.applyMine")}
                          onClick={() => {
                            setRebased({ form: conflict.form, fields: conflict.mine, version: detail.version });
                            setDraft(null);
                          }}
                          testId="sf-apply-mine"
                        />
                        <Btn size="sm" kind="ghost" label={t("src.discardMine")} onClick={() => setDraft(null)} testId="sf-discard-mine" />
                      </div>
                    </Callout>
                  </Reveal>
                </div>
              )}
              <SourceFormView
                key={`${detail.source_id}:${detail.version}:${rebased && rebased.version === detail.version ? "rebased" : "plain"}`}
                source={detail}
                initial={rebased && rebased.version === detail.version ? rebased.form : undefined}
                highlight={rebased && rebased.version === detail.version ? rebased.fields : undefined}
                footerEl={footerEl}
                onCancel={onClose}
                onSaved={(s) => {
                  setRebased(null);
                  setReloadKey((k) => k + 1);
                  onSaved(s);
                }}
                onConflict={(form) => {
                  setDraft({ form, base: detail });
                  setRebased(null);
                  setReloadKey((k) => k + 1);
                }}
              />
            </>
          ) : (
            <ChangeLog detail={detail} />
          )}
        </TabPanel>
      )}
    </Drawer>
  );
}

function ChangeLog({ detail }: { detail: SourceDetail }) {
  const { t, fmt } = useI18n();
  if (!detail.changes.length) return <Empty icon="audit" title={t("src.log.empty")} />;
  return (
    <ol className="src-log" data-testid="src-log">
      {detail.changes.map((c) => (
        <li key={c.version}>
          <span className="src-log-v mono">v{c.version}</span>
          <div className="grow">
            <div className="row" style={{ gap: 6 }}>
              {c.changed_fields.length ? (
                c.changed_fields.map((f) => (
                  <span key={f} className="tag plain" title={f}>
                    {fieldLabel(t, f)}
                  </span>
                ))
              ) : (
                <span className="tag">—</span>
              )}
            </div>
            <div className="small mt-8 wrap-any">{c.reason}</div>
            <div className="xs muted mt-8">
              {fmt.dateTime(c.at)} · <StaffName id={c.actor_id} name={c.actor_name} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function SourceFormView({
  source,
  initial,
  highlight,
  footerEl,
  onCancel,
  onSaved,
  onConflict,
}: {
  source: Source | null;
  /** the operator's draft carried over to this version (409 SOURCE_VERSION_CONFLICT → «Apply my changes») */
  initial?: SourceForm;
  /** fields of the carried-over draft, highlighted until saved */
  highlight?: string[];
  /** drawer footer: Save / Cancel stay visible below a long form */
  footerEl: HTMLElement | null;
  onCancel: () => void;
  onSaved: (s: Source) => void;
  onConflict: (draft: SourceForm) => void;
}) {
  const i = useI18n();
  const { t, lang } = i;
  const toast = useToast();
  const { can } = useSession();
  const creating = !source;
  const [f, setF] = useState<SourceForm>(() => initial ?? (source ? formFromSource(source) : emptyForm()));
  const [errors, setErrors] = useState<SourceErrors>({});
  const [server, setServer] = useState<{ text: string; meta?: string; kind: "bad" | "warn" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEnable, setConfirmEnable] = useState<boolean | null>(null);
  const key = useRef(uuid());
  const formRef = useRef<HTMLFormElement>(null);
  const readOnly = !can("sources.manage");
  const formId = source ? `src-form-${source.source_id}` : "src-form-new";
  /** field of the carried-over draft: info bar until saved */
  const hl = (...ks: string[]) => (highlight && ks.some((k) => highlight.includes(k)) ? "is-edited" : undefined);

  const set = <K extends keyof SourceForm>(k: K, v: SourceForm[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setServer(null);
  };
  const patch = useMemo(() => (source ? patchFromForm(source, f) : null), [source, f]);
  const dirty = creating ? true : !!patch?.changed.length;
  const needsStepUp = creating || !!patch?.stepUp;

  const submit = async () => {
    if (busy || readOnly) return;
    const e = validateSource(f, creating);
    setErrors(e);
    if (Object.keys(e).length) {
      setTimeout(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(), 0);
      return;
    }
    if (!creating && !patch?.changed.length) return;
    setBusy(true);
    setServer(null);
    try {
      const saved = creating ? await SourcesApi.create({ ...inputFromForm(f), reason: f.reason.trim() }, key.current) : await SourcesApi.patch(source!.source_id, patch!.body);
      toast(creating ? t("src.created", { n: saved.name }) : t("src.saved", { n: saved.name, v: saved.version }), "ok", creating ? "source.created" : `v${saved.version}`);
      onSaved(saved);
    } catch (x) {
      setBusy(false);
      if (x instanceof ApiError && x.cancelled) return setServer({ text: t("stepup.cancelled"), kind: "warn" });
      if (x instanceof ApiError && x.code === "SOURCE_VERSION_CONFLICT") {
        toast(t("src.conflictT"), "err", "409 SOURCE_VERSION_CONFLICT");
        onConflict(f); // the draft (with the reason) is kept and can be carried over to the new version
        return;
      }
      if (x instanceof ApiError && x.code === "SOURCE_SLUG_TAKEN") setErrors((e2) => ({ ...e2, slug: "slugTaken" }));
      setServer({ text: errText(i, x), meta: errMeta(x), kind: "bad" });
    }
  };

  const err = (k: string) => (errors[k] ? t(ek(errors[k]!)) : null);
  const inv = (k: string) => (errors[k] ? true : undefined);
  const countryList = countryOptions(lang, [...MORE_COUNTRIES, f.country_code]);

  return (
    <form
      ref={formRef}
      id={formId}
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      data-testid="src-form"
    >
      {readOnly && <Callout icon="lock">{t("src.ro")}</Callout>}
      {source?.disabled_reason === "robots" && !source.enabled && (
        <Callout kind="warn" icon="alert" testId="sf-auto-disabled">
          {t("src.autoDisabled.robots")}
        </Callout>
      )}
      {highlight && highlight.length > 0 && source && (
        <Reveal dep={source.version}>
          <Callout kind="info" icon="info" testId="sf-rebased">
            {t("src.rebased", { v: source.version })}
          </Callout>
        </Reveal>
      )}
      <fieldset className="src-sec" disabled={readOnly || busy}>
        <legend className="sec-h">{t("src.sec.main")}</legend>
        <div className="form-grid">
          <div className={cx("field", hl("name"))}>
            <label htmlFor="sf-name" className="req">
              {t("src.f.name")}
            </label>
            <input id="sf-name" className="input" value={f.name} maxLength={120} onChange={(e) => set("name", e.target.value)} aria-invalid={inv("name")} aria-describedby={errors.name ? "sf-name-err" : undefined} data-autofocus="" data-testid="sf-name" />
            <FieldErr msg={err("name")} id="sf-name-err" />
          </div>
          <div className="field">
            <label htmlFor="sf-slug" className={creating ? "req" : undefined}>
              {t("src.f.slug")}
            </label>
            <input
              id="sf-slug"
              className="input mono"
              value={f.slug}
              maxLength={41}
              disabled={!creating}
              onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              aria-invalid={inv("slug")}
              aria-describedby={`sf-slug-hint${errors.slug ? " sf-slug-err" : ""}`}
              data-testid="sf-slug"
            />
            <span className="hint" id="sf-slug-hint">
              {creating ? t("src.slugHint", { p: `aiweb.${SLUG_RE.test(f.slug) ? f.slug : "…"}` }) : t("src.slugFixed")}
            </span>
            <FieldErr msg={err("slug")} id="sf-slug-err" />
          </div>
          <div className={cx("field", hl("country_code"))}>
            <label htmlFor="sf-country" className="req">
              {t("src.col.country")}
            </label>
            <select id="sf-country" className="select" value={f.country_code} onChange={(e) => set("country_code", e.target.value)} aria-invalid={inv("country_code")}>
              {countryList.map((c) => (
                <option key={c} value={c}>
                  {countryName(lang, c)} · {c}
                </option>
              ))}
            </select>
          </div>
          <div className={cx("field", hl("tier"))}>
            <label htmlFor="sf-tier" className="req">
              {t("src.col.tier")}
            </label>
            <select id="sf-tier" className="select" value={f.tier} onChange={(e) => set("tier", e.target.value as SourceForm["tier"])} aria-describedby="sf-tier-hint" data-testid="sf-tier">
              {TIERS.map((x) => (
                <option key={x} value={x}>
                  {t(`tier.${x}` as MessageKey)}
                </option>
              ))}
            </select>
            <span className="hint" id="sf-tier-hint">
              {t(`tier.${f.tier}.h` as MessageKey)}
            </span>
          </div>
        </div>
      </fieldset>

      <fieldset className="src-sec" disabled={readOnly || busy}>
        <legend className="sec-h">{t("src.sec.domains")}</legend>
        <DomainChips id="sf-ev" label={t("src.f.eventDomains")} hint={t("src.eventDomainsHint")} values={f.event_domains} onChange={(v) => set("event_domains", v)} allowWildcard={false} required error={err("event_domains")} testId="sf-ev" className={hl("event_domains")} />
        <DomainChips id="sf-media" label={t("src.f.mediaDomains")} hint={t("src.mediaDomainsHint")} values={f.media_domains} onChange={(v) => set("media_domains", v)} allowWildcard error={err("media_domains")} testId="sf-media" className={hl("media_domains")} />
      </fieldset>

      <fieldset className={cx("src-sec", hl("listing_pages"))} disabled={readOnly || busy}>
        <legend className="sec-h">
          {t("src.sec.pages")} <span className="muted xs">{f.listing_pages.length}/10</span>
        </legend>
        <p className="xs muted">{t("src.pagesHint")}</p>
        {f.listing_pages.length > 0 && (
          <ul className="src-pages" data-testid="sf-pages">
            {f.listing_pages.map((p, idx) => {
              const pe = errors[`page.${idx}`];
              const setPage = (patch: Partial<SourceForm["listing_pages"][number]>) => set("listing_pages", f.listing_pages.map((x, j) => (j === idx ? { ...x, ...patch } : x)));
              return (
                <li key={idx} className={cx(pe && "is-invalid", p.kind === "json_api" && "is-api")}>
                  <input
                    className="input mono"
                    type="url"
                    inputMode="url"
                    placeholder={p.kind === "telegram" ? "https://t.me/s/channel_name" : `https://${f.event_domains[0] ?? "example.uz"}/afisha`}
                    aria-label={t("src.page.url", { n: idx + 1 })}
                    value={p.url}
                    maxLength={2048}
                    onChange={(e) => setPage({ url: e.target.value })}
                    aria-invalid={pe ? true : undefined}
                    aria-describedby={[pe && `sf-page-${idx}-err`, p.kind === "json_api" && `sf-page-${idx}-hint`].filter(Boolean).join(" ") || undefined}
                    data-testid={`sf-page-url-${idx}`}
                  />
                  {p.kind === "json_api" && (
                    <span className="hint src-page-hint" id={`sf-page-${idx}-hint`} data-testid={`sf-page-hint-${idx}`}>
                      {t("src.api.pageUrlHint")}
                    </span>
                  )}
                  <select className="select" aria-label={t("src.page.kind", { n: idx + 1 })} value={p.kind} onChange={(e) => setPage({ kind: e.target.value as FormPage["kind"] })} data-testid={`sf-page-kind-${idx}`}>
                    <option value="html">{t("src.kind.html")}</option>
                    <option value="telegram">{t("src.kind.telegram")}</option>
                    <option value="json_api">{t("src.kind.json_api")}</option>
                  </select>
                  <input className="input" placeholder={t("src.page.cityPh")} aria-label={t("src.page.city", { n: idx + 1 })} value={p.city} maxLength={CITY_MAX} onChange={(e) => setPage({ city: e.target.value })} data-testid={`sf-page-city-${idx}`} />
                  <select className="select" aria-label={t("src.page.category", { n: idx + 1 })} value={p.category} onChange={(e) => setPage({ category: e.target.value })} data-testid={`sf-page-cat-${idx}`}>
                    <option value="">{t("src.page.anyCategory")}</option>
                    {TAXONOMY.map((c) => (
                      <option key={c} value={c}>
                        {c.includes(".") ? ` ${categoryLabel(t, c)}` : categoryLabel(t, c)}
                      </option>
                    ))}
                  </select>
                  <select className="select" aria-label={t("src.page.priority", { n: idx + 1 })} value={p.priority} onChange={(e) => setPage({ priority: e.target.value as FormPage["priority"] })} data-testid={`sf-page-prio-${idx}`}>
                    <option value="normal">{t("src.prio.normal")}</option>
                    <option value="low">{t("src.prio.low")}</option>
                  </select>
                  <IconBtn icon="x" label={t("src.page.remove", { n: idx + 1 })} onClick={() => set("listing_pages", f.listing_pages.filter((_, j) => j !== idx))} />
                  {pe && (
                    <div className="src-page-err">
                      <FieldErr msg={t(ek(pe), { d: f.event_domains.join(", ") || "—" })} id={`sf-page-${idx}-err`} />
                    </div>
                  )}
                  {p.kind === "json_api" && (
                    <JsonApiEditor
                      idx={idx}
                      value={p.json ?? ""}
                      onChange={(json) => {
                        setPage({ json });
                        // ошибка маппинга — до следующей проверки формы, правка её снимает
                        setErrors(({ [`api.${idx}`]: _, ...rest }) => rest);
                      }}
                      error={errors[`api.${idx}`] ? t(ek(errors[`api.${idx}`]!), { d: f.event_domains.join(", ") || "—" }) : null}
                      ctx={{ sourceId: source?.source_id, country: f.country_code, eventDomains: f.event_domains, mediaDomains: f.media_domains, city: p.city, category: p.category }}
                      readOnly={readOnly}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div>
          <Btn
            size="sm"
            icon="plus"
            label={t("src.page.add")}
            disabled={f.listing_pages.length >= 10 || readOnly}
            onClick={() => set("listing_pages", [...f.listing_pages, emptyPage()])}
            testId="sf-page-add"
          />
        </div>
        <FieldErr msg={err("listing_pages")} />
      </fieldset>

      <fieldset className="src-sec" disabled={readOnly || busy}>
        <legend className="sec-h">{t("src.sec.fetch")}</legend>
        <div className="form-grid">
          <div className={cx("field", hl("js_only"))}>
            <label htmlFor="sf-js">{t("src.f.jsOnly")}</label>
            <select id="sf-js" className="select" value={f.js_only} onChange={(e) => set("js_only", e.target.value as SourceForm["js_only"])} aria-describedby="sf-js-hint">
              <option value="">{t("src.js.unknown")}</option>
              <option value="no">{t("src.js.no")}</option>
              <option value="yes">{t("src.js.yes")}</option>
            </select>
            <span className="hint" id="sf-js-hint">
              {t("src.jsOnlyHint")}
            </span>
          </div>
          <div className={cx("field src-enabled", hl("enabled"))}>
            <span className="field-label">{t("src.f.enabled")}</span>
            <Switch id="sf-enabled" checked={f.enabled} onChange={(v) => setConfirmEnable(v)} label={f.enabled ? t("src.on") : t("src.off")} aria={t("src.f.enabled")} disabled={readOnly || busy} />
            <span className="hint">{f.enabled ? t("src.enabledHintOn") : t("src.enabledHintOff")}</span>
          </div>
          <div className={cx("field span-2", hl("notes"))}>
            <label htmlFor="sf-notes">{t("src.f.notes")}</label>
            <textarea id="sf-notes" className="textarea" rows={2} maxLength={1000} value={f.notes} onChange={(e) => set("notes", e.target.value)} aria-invalid={inv("notes")} />
            <FieldErr msg={err("notes")} />
          </div>
        </div>
      </fieldset>

      {!readOnly && (
        <div className="src-commit">
          <div className="field">
            <label htmlFor="sf-reason" className="req">
              {t("src.f.reason")}
            </label>
            <textarea
              id="sf-reason"
              className="textarea"
              rows={2}
              maxLength={500}
              placeholder={t("src.reasonPh")}
              value={f.reason}
              onChange={(e) => set("reason", e.target.value)}
              aria-invalid={inv("reason")}
              aria-describedby={`sf-reason-hint${errors.reason ? " sf-reason-err" : ""}`}
              disabled={busy}
              data-testid="sf-reason"
            />
            <span className="hint" id="sf-reason-hint">
              {t("src.reasonHint")}
            </span>
            <FieldErr msg={err("reason")} id="sf-reason-err" />
          </div>
          {needsStepUp && dirty && (
            <Callout kind="warn" icon="smartphoneKey" testId="sf-stepup-note">
              {creating ? t("src.stepUpCreate") : t("src.stepUpEdit", { f: patch!.changed.filter((c) => ["event_domains", "media_domains", "enabled", "tier"].includes(c)).map((c) => fieldLabel(t, c)).join(", ") })}
            </Callout>
          )}
          {server && (
            <Callout kind={server.kind} icon="alertCircle" testId="sf-server-err">
              <b>{server.text}</b>
              {server.meta && <span className="xs muted block mono">{server.meta}</span>}
            </Callout>
          )}
        </div>
      )}
      {!readOnly &&
        footerEl &&
        createPortal(
          <>
            <Btn label={t("common.cancel")} onClick={onCancel} disabled={busy} testId="sf-cancel" />
            <span className="grow" />
            {!creating && (
              <span className="xs muted src-footer-note" data-testid="sf-changed">
                {dirty ? t("src.changed", { f: patch!.changed.map((c) => fieldLabel(t, c)).join(", ") }) : t("src.noChanges")}
              </span>
            )}
            <Btn type="submit" form={formId} kind="primary" icon={creating ? "plus" : "check"} label={creating ? t("src.create") : t("src.save")} busy={busy} disabled={!dirty} perm="sources.manage" testId="sf-submit" />
          </>,
          footerEl,
        )}

      {confirmEnable !== null && (
        <Modal
          title={confirmEnable ? t("src.enableT", { n: f.name || f.slug || "—" }) : t("src.disableT", { n: f.name || f.slug || "—" })}
          text={confirmEnable ? t("src.enableM") : t("src.disableM")}
          icon="power"
          tone={confirmEnable ? "warn" : "bad"}
          onClose={() => setConfirmEnable(null)}
          testId="sf-enable-confirm"
          footer={
            <>
              <Btn label={t("common.cancel")} onClick={() => setConfirmEnable(null)} />
              <Btn
                label={confirmEnable ? t("src.enableOk") : t("src.disableOk")}
                kind={confirmEnable ? "primary" : "danger"}
                onClick={() => {
                  set("enabled", confirmEnable);
                  setConfirmEnable(null);
                }}
                testId="sf-enable-ok"
              />
            </>
          }
        >
          <p className="xs muted">{t("src.enableAfterSave")}</p>
        </Modal>
      )}
    </form>
  );
}

/** Domain chips: Enter / comma / blur adds, Backspace on an empty field removes the last one. */
function DomainChips({
  id,
  label,
  hint,
  values,
  onChange,
  allowWildcard,
  required,
  error,
  testId,
  className,
}: {
  id: string;
  label: string;
  hint: string;
  values: string[];
  onChange: (v: string[]) => void;
  allowWildcard: boolean;
  required?: boolean;
  error: string | null;
  testId?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const add = (raw: string) => {
    const parts = raw.split(/[\s,;]+/).map(cleanDomain).filter(Boolean);
    if (!parts.length) return true;
    const next = [...values];
    for (const d of parts) {
      const p = domainProblem(d, allowWildcard);
      if (p) {
        setLocal(t(`src.dom.${p}` as MessageKey, { d }));
        return false;
      }
      if (next.length >= 10) {
        setLocal(t("src.err.domainsMany"));
        return false;
      }
      if (!next.includes(d)) next.push(d);
    }
    onChange(next);
    setDraft("");
    setLocal(null);
    return true;
  };
  const msg = local ?? error;
  return (
    <div className={cx("field", className)}>
      <label htmlFor={id} className={required ? "req" : undefined}>
        {label}
      </label>
      <div className={cx("chips", msg && "is-invalid")} onClick={() => input.current?.focus()} data-testid={testId}>
        {values.map((d) => (
          <span key={d} className="chip">
            <span className="mono">{d}</span>
            <button
              type="button"
              aria-label={t("src.chipRemove", { d })}
              onClick={(e) => {
                e.stopPropagation();
                onChange(values.filter((x) => x !== d));
              }}
            >
              <Icon name="x" />
            </button>
          </span>
        ))}
        <input
          ref={input}
          id={id}
          className="chips-in mono"
          value={draft}
          placeholder={values.length ? "" : allowWildcard ? "cdn.example.uz, *.cdn.example.uz" : "example.uz"}
          maxLength={253}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={msg ? true : undefined}
          aria-describedby={`${id}-hint${msg ? ` ${id}-err` : ""}`}
          onChange={(e) => {
            setDraft(e.target.value);
            setLocal(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || (e.key === " " && draft.trim())) {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={() => draft.trim() && add(draft)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (/[\s,;]/.test(text.trim())) {
              e.preventDefault();
              add(text);
            }
          }}
        />
      </div>
      <span className="hint" id={`${id}-hint`}>
        {hint}
      </span>
      <FieldErr msg={msg} id={`${id}-err`} />
    </div>
  );
}
