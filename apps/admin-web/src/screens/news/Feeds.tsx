import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { NewsSource, NewsSourceCheck } from "@tilhero/contracts/admin";
import { NewsApi, type NewsSourceFilters } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { DICTS, useI18n, type MessageKey } from "../../i18n";
import { uuid } from "../../lib/ids";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Select, Spinner, Switch } from "../../ui/kit";
import { ConfirmCommand, Drawer, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errMeta, errText } from "../../ui/errors";
import { categoryLabel, countryName, countryOptions, MORE_COUNTRIES, TAXONOMY } from "../catalog/common";
import {
  checkInputFromForm,
  checkSignature,
  checkUsable,
  DOMAIN_RE,
  DOMAINS_MAX,
  dropLabel,
  emptyFeedForm,
  ENTITIES_MAX,
  ENTITY_MAX,
  feedCodeLabel,
  formFromSource,
  HEALTH_TONE,
  healthState,
  inputFromForm,
  INTERESTS_MAX,
  NEWS_LANGS,
  patchFromForm,
  REASON_MIN,

  suggestDomain,
  validateFeed,
  type FeedErrors,
  type FeedForm,
  type HealthState,
} from "./news";
import { webHref } from "../../lib/url";

const fk = (code: string) => `feed.err.${code}` as MessageKey;

/** «News feeds» (news.manage): RSS/Atom feeds and news pages of official sites and media, by interest. */
export function FeedsPage({ openId = null }: { openId?: string | null }) {
  const i = useI18n();
  const { t, lang } = i;
  const [q, setQ] = useState("");
  const [interest, setInterest] = useState("");
  const [country, setCountry] = useState("");
  const [enabled, setEnabled] = useState<"" | "true" | "false">("");
  const [rows, setRows] = useState<NewsSource[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(openId);
  const [countries, setCountries] = useState<string[]>([]);
  useEffect(() => setOpen(openId), [openId]);
  const req = useRef(0);

  const filters: NewsSourceFilters = { q: q.trim() || undefined, interest: interest || undefined, country: country || undefined, enabled: enabled || undefined };
  const fKey = JSON.stringify(filters);

  const load = useCallback(async (f: NewsSourceFilters, append: boolean) => {
    const id = ++req.current;
    setLoading(true);
    try {
      const p = await NewsApi.sources(f);
      if (id !== req.current) return;
      setRows((xs) => (append ? [...xs, ...p.items] : p.items));
      setCursor(p.next_cursor);
      setError(null);
      setCountries((cs) => [...new Set([...cs, ...p.items.map((s) => s.country_code).filter((c): c is string => !!c)])]);
    } catch (e) {
      if (id === req.current) setError(e);
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const tm = setTimeout(() => void load(JSON.parse(fKey) as NewsSourceFilters, false), q ? 300 : 0);
    return () => clearTimeout(tm);
  }, [fKey, load, q]);

  const filtered = !!(q || interest || country || enabled);
  const resetFilters = () => (setQ(""), setInterest(""), setCountry(""), setEnabled(""));
  const now = Date.now();
  const sum = useMemo(() => {
    const on = rows.filter((s) => s.enabled);
    const why = (r: string) => rows.filter((s) => !s.enabled && s.disabled_reason === r).length;
    return {
      on: on.length,
      total: rows.length,
      failing: on.filter((s) => healthState(s, now) === "error").length,
      items: on.reduce((a, s) => a + s.health.items_24h, 0),
      // fix 6.1: why the others are off
      waiting: why("unverified"),
      legal: why("legal"),
      terms: why("terms"),
      stale: why("stale"),
      blocked: why("blocked"),
    };
  }, [rows, now]);

  return (
    <div data-testid="feeds">
      <div className="page-head">
        <div className="lead">
          <p>{t("feed.lead")}</p>
        </div>
        <div className="acts">
          <Btn kind="primary" icon="plus" label={t("feed.add")} perm="news.manage" onClick={() => setOpen("new")} testId="feed-add" />
        </div>
      </div>
      <div className="toolbar">
        <div className="input-wrap">
          <Icon name="search" />
          <input className="input" type="search" placeholder={t("feed.searchPh")} aria-label={t("feed.searchPh")} value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} data-testid="feed-q" />
        </div>
        <Select
          id="feed-interest"
          label={t("feed.f.interest")}
          value={interest}
          onChange={setInterest}
          testId="feed-interest"
          options={[{ v: "", label: t("feed.f.allInterests") }, ...TAXONOMY.map((c) => ({ v: c, label: c.includes(".") ? `  ${categoryLabel(t, c)}` : categoryLabel(t, c) }))]}
        />
        <Select
          id="feed-country"
          label={t("rv.f.country")}
          value={country}
          onChange={setCountry}
          testId="feed-country"
          options={[{ v: "", label: t("rv.f.allCountries") }, ...countryOptions(lang, countries).map((c) => ({ v: c, label: countryName(lang, c) }))]}
        />
        <Select
          id="feed-enabled"
          label={t("src.f.status")}
          value={enabled}
          onChange={setEnabled}
          testId="feed-enabled"
          options={[
            { v: "", label: t("src.f.all") },
            { v: "true", label: t("src.on") },
            { v: "false", label: t("src.off") },
          ]}
        />
        <Btn kind="ghost" size="sm" label={t("common.resetFilters")} onClick={resetFilters} disabled={!filtered} testId="feeds-reset" />
      </div>
      {error ? (
        <div className="mb-12">
          <LoadError error={error} onRetry={() => void load(filters, false)} testId="feeds-error" />
        </div>
      ) : null}
      {!error && !loading && rows.length > 0 && (
        <div className="feed-sum" data-testid="feeds-summary">
          <span>
            <b>{t("feed.sum.on", { n: sum.on, total: sum.total })}</b>
          </span>
          {sum.waiting > 0 && <span data-sum="unverified">{t("feed.sum.waiting", { n: sum.waiting })}</span>}
          {sum.legal > 0 && (
            <span className="is-warn" data-sum="legal">
              {t("feed.sum.legal", { n: sum.legal })}
            </span>
          )}
          {sum.terms > 0 && (
            <span className="is-warn" data-sum="terms">
              {t("feed.sum.terms", { n: sum.terms })}
            </span>
          )}
          {sum.stale > 0 && <span data-sum="stale">{t("feed.sum.staleN", { n: sum.stale })}</span>}
          {sum.blocked > 0 && (
            <span className="is-warn" data-sum="blocked">
              {t("feed.sum.blocked", { n: sum.blocked })}
            </span>
          )}
          <span className={cx(sum.failing > 0 && "is-bad")}>
            <Icon name={sum.failing ? "alertCircle" : "checkCircle"} /> {sum.failing ? i.tp("feed.sum.failing", sum.failing) : t("feed.sum.noFailing")}
          </span>
          <span>{i.tp("feed.sum.items", sum.items)}</span>
          {filtered && <span className="xs muted">{t("feed.sum.filtered")}</span>}
        </div>
      )}
      <section className="panel" aria-label={t("page.feeds")} aria-busy={loading}>
        <div className="table-wrap">
          <table className="tbl" data-testid="feeds-table">
            <thead>
              <tr>
                <th>{t("feed.col.name")}</th>
                <th>{t("feed.col.interests")}</th>
                <th>{t("feed.col.country")}</th>
                <th>{t("feed.col.lang")}</th>
                <th>{t("feed.col.display")}</th>
                <th>{t("feed.col.state")}</th>
                <th>{t("feed.col.health")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const st = healthState(s, now);
                return (
                  <tr
                    key={s.source_id}
                    className={cx("is-click", st === "error" ? "sev-bad" : st === "late" ? "sev-warn" : s.enabled ? "sev-good" : "sev-none")}
                    tabIndex={0}
                    aria-label={t("common.openRow", { x: s.name })}
                    onClick={() => setOpen(s.source_id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(s.source_id))}
                    data-feed={s.slug}
                  >
                    <td>
                      <div className="cell-main feed-name">
                        <span>{s.name}</span>
                        <Pill tone={s.kind === "official" ? "good" : "outline"} dot={false}>
                          {t(`feed.kind.${s.kind}`)}
                        </Pill>
                      </div>
                      <div className="cell-sub mono">
                        {s.site_domain}
                        {s.mode === "html" && <span className="tag plain feed-mode">HTML</span>}
                      </div>
                    </td>
                    <td>
                      <InterestTags codes={s.interests} max={2} />
                    </td>
                    <td className="nowrap">{s.country_code ? countryName(lang, s.country_code) : <span className="muted">{t("feed.intl")}</span>}</td>
                    <td className="mono">{s.lang.toUpperCase()}</td>
                    <td>
                      <Pill tone={s.display === "summary" ? "info" : "neutral"} dot={false} title={t(`feed.display.${s.display}.h`)}>
                        {t(`feed.display.${s.display}`)}
                      </Pill>
                    </td>
                    <td className="feed-state" data-testid="feed-state-cell">
                      <StateCell s={s} />
                    </td>
                    <td className="nowrap" data-testid="feed-health-cell">
                      <HealthCell s={s} st={st} />
                    </td>
                  </tr>
                );
              })}
              {!loading && !rows.length && !error && (
                <tr>
                  <td colSpan={7} className="empty-cell">
                    {filtered ? (
                      <Empty icon="search" title={t("common.nothingFound")} text={country ? t("feed.empty.countryM") : t("common.changeFilters")} testId="feeds-empty-filtered">
                        <Btn size="sm" label={t("common.resetFilters")} onClick={resetFilters} testId="feeds-empty-reset" />
                      </Empty>
                    ) : (
                      <Empty icon="rss" title={t("feed.empty.t")} text={t("feed.empty.m")} />
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
          {cursor && !loading && <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load({ ...filters, cursor }, true)} testId="feed-more" />}
        </div>
      </section>
      <p className="xs muted foot-note">
        <Icon name="info" /> {t("feed.foot")}
      </p>
      {open && (
        <FeedDrawer
          id={open}
          onClose={() => setOpen(null)}
          onSaved={(s) => {
            setOpen(s ? s.source_id : null);
            void load(filters, false);
          }}
        />
      )}
    </div>
  );
}

export function InterestTags({ codes, max }: { codes: readonly string[]; max?: number }) {
  const { t } = useI18n();
  const shown = max ? codes.slice(0, max) : codes;
  const rest = codes.slice(shown.length);
  return (
    <span className="feed-tags">
      {shown.map((c) => (
        <span key={c} className="tag plain" title={c}>
          {categoryLabel(t, c)}
        </span>
      ))}
      {rest.length > 0 && (
        <span className="xs muted" title={rest.map((c) => categoryLabel(t, c)).join(", ")}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

function healthLabel(t: (k: MessageKey, v?: Record<string, string | number>) => string, tp: (k: MessageKey, n: number) => string, s: NewsSource, st: HealthState): string {
  switch (st) {
    case "ok":
    case "late":
      return tp("feed.h.items", s.health.items_24h);
    case "error":
      return s.health.last_error ? feedCodeLabel(t, s.health.last_error.code) : t("feed.h.error");
    case "never":
      return t("feed.h.never");
    default:
      return t("feed.h.off");
  }
}

/** «Health» column: badge (items in 24 h / the error) + when the feed was last fetched. */
function HealthCell({ s, st }: { s: NewsSource; st: HealthState }) {
  const { t, tp, fmt } = useI18n();
  const at = s.health.last_fetch_at ?? s.health.last_ok_at;
  return (
    <div className="crawl-cell" data-health={st}>
      <Pill tone={HEALTH_TONE[st]} title={s.health.last_error ? `${s.health.last_error.code}${s.health.last_error.message ? `: ${s.health.last_error.message}` : ""}` : undefined}>
        {healthLabel(t, tp, s, st)}
      </Pill>
      {at ? (
        <div className={cx("cell-sub", st === "late" && "feed-late")} title={fmt.dateTime(at)}>
          {st === "late" ? t("feed.h.late", { t: fmt.rel(at) }) : fmt.rel(at)}
        </div>
      ) : null}
    </div>
  );
}

/** Fix 6.1: auto-check result in words: «passed» or the reason code label */
export function probeLabel(t: (k: MessageKey) => string, code: string | null, ok: boolean): string {
  if (ok || !code) return t("feed.probe.ok");
  const key = `probe.code.${code}` as MessageKey;
  if (key in DICTS.ru) return t(key);
  const feedKey = `feed.code.${code}` as MessageKey; // fix 8.1: FEED_* reasons of the fetch
  return feedKey in DICTS.ru ? t(feedKey) : code;
}

/**
 * «State» column (fix 6.1): on / off + why it is off (publisher permission, stale, awaiting the auto-check, operator)
 * and the last auto-check with its result.
 */
function StateCell({ s }: { s: NewsSource }) {
  const { t, fmt } = useI18n();
  const p = s.last_probe_result;
  return (
    <div className="feed-state-c" data-reason={s.disabled_reason ?? undefined}>
      <span className="row nowrap" style={{ gap: 6 }}>
        <Pill tone={s.enabled ? "good" : s.disabled_reason === "legal" || s.disabled_reason === "terms" || s.disabled_reason === "blocked" ? "warn" : "neutral"}>{s.enabled ? t("src.on") : t("src.off")}</Pill>
      </span>
      {!s.enabled && s.disabled_reason && <span className={cx("xs feed-why", (s.disabled_reason === "legal" || s.disabled_reason === "terms" || s.disabled_reason === "blocked") && "is-legal")}>{t(`feed.reason.${s.disabled_reason}`)}</span>}
      {s.last_probe_at && (
        <span className={cx("xs feed-probe", p && !p.ok && "is-fail")} title={`${fmt.dateTime(s.last_probe_at)}${p?.code ? ` · ${p.code}` : ""}`} data-testid="feed-probe">
          {t("feed.probe.at", { t: fmt.rel(s.last_probe_at) })}
          {p && <>: {probeLabel(t, p.code, p.ok)}</>}
        </span>
      )}
    </div>
  );
}

/** Fix 6.1: last auto-check of the card — when, result, counts, the newest entry; for switched-off feeds. */
function ProbeBlock({ s }: { s: NewsSource }) {
  const { t, fmt } = useI18n();
  const p = s.last_probe_result;
  return (
    <div className={cx("feed-probe-b", p && (p.ok ? "is-ok" : "is-fail"))} data-testid="feed-probe-block">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <b className="small">{t("feed.probe.title")}</b>
        {s.last_probe_at ? (
          <>
            <span className="xs muted" title={fmt.dateTime(s.last_probe_at)}>{fmt.rel(s.last_probe_at)}</span>
            {p && (
              <Pill tone={p.ok ? "good" : "warn"} title={p.code ?? undefined}>
                {probeLabel(t, p.code, p.ok)}
              </Pill>
            )}
            {p?.code && <span className="act-code sec">{p.code}</span>}
          </>
        ) : (
          <span className="xs muted">{t("feed.probe.never")}</span>
        )}
      </div>
      {p && (
        <p className="xs muted feed-probe-m">
          {t("feed.probe.counts", { n: fmt.num(p.fetched), a: fmt.num(p.accepted) })}
          {p.newest_at && <> · {t("feed.probe.newest", { t: fmt.date(p.newest_at) })}</>}
          {p.enabled && <> · {t("feed.probe.enabled")}</>}
        </p>
      )}
      {!s.enabled && <p className="xs muted feed-probe-m">{t("feed.probe.hint")}</p>}
    </div>
  );
}

/** Health block of the card: last fetch, last success, error with its message, items in 24 h. */
function HealthBlock({ s }: { s: NewsSource }) {
  const { t, tp, fmt } = useI18n();
  const st = healthState(s);
  const e = s.health.last_error;
  return (
    <section className={cx("panel crawl", st === "error" && "is-error", st === "late" && "is-skipped")} aria-labelledby="feed-h" data-testid="feed-health" data-health={st}>
      <div className="panel-h">
        <h3 className="panel-t" id="feed-h">
          <Icon name="activity" />
          {t("feed.h.title")}
        </h3>
        <span className="grow" />
        <Pill tone={HEALTH_TONE[st]}>{healthLabel(t, tp, s, st)}</Pill>
      </div>
      {e && (
        <div className="crawl-status" data-testid="feed-last-error">
          <span className={cx("act-code", st === "error" ? "crit" : "sec")}>{e.code}</span>
          <span className="small">{feedCodeLabel(t, e.code)}</span>
          {e.message && <p className="small crawl-hint wrap-any">{e.message}</p>}
          {e.at && <span className="xs muted">{fmt.dateTime(e.at)}</span>}
        </div>
      )}
      <div className="statband feed-stats">
        <div className="stat">
          <div className="stat-l">{t("feed.h.lastFetch")}</div>
          <div className="stat-v small-v" title={fmt.dateTime(s.health.last_fetch_at)}>{s.health.last_fetch_at ? fmt.rel(s.health.last_fetch_at) : "—"}</div>
        </div>
        <div className="stat">
          <div className="stat-l">{t("feed.h.lastOk")}</div>
          <div className="stat-v small-v" title={fmt.dateTime(s.health.last_ok_at)}>{s.health.last_ok_at ? fmt.rel(s.health.last_ok_at) : "—"}</div>
        </div>
        <div className="stat">
          <div className="stat-l">{t("feed.h.items24")}</div>
          <div className="stat-v" data-testid="feed-items24">{fmt.num(s.health.items_24h)}</div>
        </div>
      </div>
      {(s.last_probe_at || !s.enabled) && <ProbeBlock s={s} />}
    </section>
  );
}

type CheckState = { state: "idle" } | { state: "busy" } | { state: "done"; sig: string; res: NewsSourceCheck } | { state: "error"; sig: string; error: unknown };

function FeedDrawer({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: (s: NewsSource | null) => void }) {
  const { t } = useI18n();
  const creating = id === "new";
  const [detail, setDetail] = useState<NewsSource | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  const { can } = useSession();

  const load = useCallback(async () => {
    if (creating) return;
    try {
      setDetail(await NewsApi.source(id));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [id, creating]);
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  return (
    <Drawer
      wide
      testId="feed-card"
      onClose={onClose}
      title={creating ? t("feed.newT") : detail ? detail.name : t("common.loading")}
      sub={
        detail ? (
          <>
            <span className="mono">{detail.slug}</span>
            <span>·</span>
            <span className="mono">v{detail.version}</span>
            <Pill tone={detail.enabled ? "good" : "neutral"}>{detail.enabled ? t("src.on") : t("src.off")}</Pill>
          </>
        ) : creating ? (
          <span>{t("feed.newSub")}</span>
        ) : undefined
      }
      footer={(creating || detail) && can("news.manage") ? <div className="src-footer" ref={setFooterEl} data-testid="feed-footer" /> : undefined}
    >
      {error ? <LoadError error={error} onRetry={() => void load()} /> : null}
      {!creating && !detail && !error && <Spinner label={t("common.loading")} />}
      {creating && <FeedFormView key="new" source={null} footerEl={footerEl} onCancel={onClose} onSaved={onSaved} onReload={() => undefined} />}
      {!creating && detail && (
        <>
          <div className="mb-12">
            <HealthBlock s={detail} />
          </div>
          <FeedFormView
            key={`${detail.source_id}:${detail.version}`}
            source={detail}
            footerEl={footerEl}
            onCancel={onClose}
            onSaved={(s) => {
              if (s) setReloadKey((k) => k + 1);
              onSaved(s);
            }}
            onReload={() => setReloadKey((k) => k + 1)}
          />
        </>
      )}
    </Drawer>
  );
}

function FeedFormView({
  source,
  footerEl,
  onCancel,
  onSaved,
  onReload,
}: {
  source: NewsSource | null;
  footerEl: HTMLElement | null;
  onCancel: () => void;
  /** saved (or null — deleted) */
  onSaved: (s: NewsSource | null) => void;
  onReload: () => void;
}) {
  const i = useI18n();
  const { t, lang } = i;
  const toast = useToast();
  const { can } = useSession();
  const creating = !source;
  const readOnly = !can("news.manage");
  const [f, setF] = useState<FeedForm>(() => (source ? formFromSource(source) : emptyFeedForm()));
  const [errors, setErrors] = useState<FeedErrors>({});
  const [server, setServer] = useState<{ text: string; meta?: string; kind: "bad" | "warn" } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<CheckState>({ state: "idle" });
  const [confirmUnchecked, setConfirmUnchecked] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // fix 6.1: the publisher's terms require written permission — switching such a feed on needs a confirmation
  // terms — the reprint terms were not checked yet: the same confirmation with its own wording
  const gate = source && !source.enabled && (source.disabled_reason === "legal" || source.disabled_reason === "terms") ? source.disabled_reason : null;
  const legal = gate !== null;
  const [legalAsk, setLegalAsk] = useState(false);
  const [legalAck, setLegalAck] = useState(false);
  const key = useRef(uuid());
  const formRef = useRef<HTMLFormElement>(null);
  const formId = source ? `feed-form-${source.source_id}` : "feed-form-new";

  const set = <K extends keyof FeedForm>(k: K, v: FeedForm[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setServer(null);
    setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
  };
  const patch = useMemo(() => (source ? patchFromForm(source, f) : null), [source, f]);
  const dirty = creating || !!patch?.changed.length;
  const sig = checkSignature(f);
  const feedChanged = creating || !!patch?.feedChanged;
  const checkedOk = check.state === "done" && check.sig === sig && check.res.ok;
  const checkStale = (check.state === "done" || check.state === "error") && check.sig !== sig;

  const runCheck = async () => {
    const e = validateFeed(f, creating, false);
    const feedErr = (["feed_url", "page_url", "site_domain", "category_filter"] as const).filter((k) => e[k]);
    if (feedErr.length) {
      setErrors((x) => ({ ...x, ...Object.fromEntries(feedErr.map((k) => [k, e[k]])) }));
      return;
    }
    setCheck({ state: "busy" });
    try {
      // saved feed unchanged → check what is saved; otherwise the fields of the form
      const res = await NewsApi.check(source?.source_id ?? null, source && !patch?.feedChanged ? undefined : checkInputFromForm(f));
      setCheck({ state: "done", sig, res });
    } catch (x) {
      setCheck({ state: "error", sig, error: x });
    }
  };

  const save = async (force = false) => {
    if (busy || readOnly) return;
    const e = validateFeed(f, creating);
    setErrors(e);
    if (Object.keys(e).length) {
      setTimeout(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(), 0);
      return;
    }
    if (!dirty) return;
    // the feed itself changed and was not checked successfully — ask once (the check can be unavailable)
    if (feedChanged && !checkedOk && !force) {
      setConfirmUnchecked(true);
      return;
    }
    setBusy(true);
    setServer(null);
    try {
      const saved = creating ? await NewsApi.create({ ...inputFromForm(f), reason: f.reason.trim() }, key.current) : await NewsApi.patch(source!.source_id, patch!.body, key.current);
      key.current = uuid();
      toast(creating ? t("feed.created", { n: saved.name }) : t("feed.saved", { n: saved.name, v: saved.version }), "ok", creating ? "news.source.created" : `v${saved.version}`);
      onSaved(saved);
    } catch (x) {
      setBusy(false);
      if (x instanceof ApiError && x.code === "NEWS_SOURCE_VERSION_CONFLICT") {
        setConflict(true);
        toast(t("feed.conflictT"), "err", "409 NEWS_SOURCE_VERSION_CONFLICT");
        return;
      }
      if (x instanceof ApiError && x.code === "NEWS_SOURCE_SLUG_TAKEN") setErrors((e2) => ({ ...e2, slug: "slugTaken" }));
      if (x instanceof ApiError && x.code === "VALIDATION_ERROR") {
        const field = x.str("field");
        if (field && field in f) setErrors((e2) => ({ ...e2, [field]: "server" }));
      }
      setServer({ text: errText(i, x), meta: errMeta(x), kind: "bad" });
    }
  };

  const err = (k: keyof FeedForm, vars?: Record<string, string | number>) => (errors[k] ? t(fk(errors[k]!), vars) : null);
  const inv = (k: keyof FeedForm) => (errors[k] ? true : undefined);
  const urlKey = f.mode === "rss" ? "feed_url" : "page_url";
  const domSuggest = !f.site_domain && suggestDomain(f[urlKey]);
  const countryList = countryOptions(lang, [...MORE_COUNTRIES, f.country_code]);

  return (
    <form
      ref={formRef}
      id={formId}
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      data-testid="feed-form"
    >
      {readOnly && <Callout icon="lock">{t("feed.ro")}</Callout>}
      {conflict && (
        <Callout kind="warn" icon="alert" testId="feed-conflict">
          <b>{t("feed.conflictT")}.</b> {t("feed.conflictM")}
          <div className="src-conflict-acts">
            <Btn kind="primary" size="sm" icon="refresh" label={t("feed.reload")} onClick={onReload} testId="feed-reload" />
          </div>
        </Callout>
      )}

      <fieldset className="src-sec" disabled={readOnly || busy}>
        <legend className="sec-h">{t("feed.sec.main")}</legend>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ff-name" className="req">
              {t("feed.f.name")}
            </label>
            <input id="ff-name" className="input" value={f.name} maxLength={120} onChange={(e) => set("name", e.target.value)} aria-invalid={inv("name")} data-autofocus="" data-testid="ff-name" />
            <FieldErr msg={err("name")} />
          </div>
          <div className="field">
            <label htmlFor="ff-slug" className={creating ? "req" : undefined}>
              {t("src.f.slug")}
            </label>
            <input
              id="ff-slug"
              className="input mono"
              value={f.slug}
              maxLength={41}
              disabled={!creating}
              onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              aria-invalid={inv("slug")}
              aria-describedby="ff-slug-hint"
              data-testid="ff-slug"
            />
            <span className="hint" id="ff-slug-hint">
              {creating ? t("feed.slugHint") : t("src.slugFixed")}
            </span>
            <FieldErr msg={err("slug")} />
          </div>
          <div className="field">
            <span className="field-label">{t("feed.f.kind")}</span>
            <div className="seg-mini feed-seg" role="radiogroup" aria-label={t("feed.f.kind")} data-testid="ff-kind">
              {(["official", "media"] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={f.kind === k} aria-pressed={f.kind === k} onClick={() => set("kind", k)}>
                  {t(`feed.kind.${k}`)}
                </button>
              ))}
            </div>
            <span className="hint">{t(`feed.kind.${f.kind}.h`)}</span>
          </div>
          <div className="field">
            <label htmlFor="ff-lang" className="req">
              {t("feed.f.lang")}
            </label>
            <select id="ff-lang" className="select" value={f.lang} onChange={(e) => set("lang", e.target.value as FeedForm["lang"])} data-testid="ff-lang">
              {NEWS_LANGS.map((l) => (
                <option key={l} value={l}>
                  {t(`feed.lang.${l}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ff-country">{t("feed.col.country")}</label>
            <select id="ff-country" className="select" value={f.country_code} onChange={(e) => set("country_code", e.target.value)} data-testid="ff-country">
              <option value="">{t("feed.intlLong")}</option>
              {countryList.map((c) => (
                <option key={c} value={c}>
                  {countryName(lang, c)} · {c}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      <fieldset className="src-sec" disabled={readOnly || busy}>
        <legend className="sec-h">{t("feed.sec.feed")}</legend>
        <div className="field">
          <span className="field-label">{t("feed.f.mode")}</span>
          <div className="seg-mini feed-seg" role="radiogroup" aria-label={t("feed.f.mode")} data-testid="ff-mode">
            {(["rss", "html"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={f.mode === m} aria-pressed={f.mode === m} onClick={() => set("mode", m)}>
                {t(`feed.mode.${m}`)}
              </button>
            ))}
          </div>
          <span className="hint">{t(`feed.mode.${f.mode}.h`)}</span>
        </div>
        <div className="field">
          <label htmlFor="ff-url" className="req">
            {f.mode === "rss" ? t("feed.f.feedUrl") : t("feed.f.pageUrl")}
          </label>
          <input
            id="ff-url"
            className="input mono"
            type="url"
            inputMode="url"
            placeholder={f.mode === "rss" ? "https://example.uz/rss" : "https://example.uz/news"}
            value={f[urlKey]}
            maxLength={2048}
            onChange={(e) => set(urlKey, e.target.value)}
            aria-invalid={inv(urlKey)}
            data-testid="ff-url"
          />
          <FieldErr msg={err(urlKey, { d: [f.site_domain, ...f.extra_domains].filter(Boolean).join(", ") || "—" })} />
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ff-domain" className="req">
              {t("feed.f.domain")}
            </label>
            <input
              id="ff-domain"
              className="input mono"
              value={f.site_domain}
              maxLength={253}
              autoCapitalize="none"
              spellCheck={false}
              placeholder="example.uz"
              onChange={(e) => set("site_domain", e.target.value.trim().toLowerCase())}
              aria-invalid={inv("site_domain")}
              aria-describedby="ff-domain-hint"
              data-testid="ff-domain"
            />
            <span className="hint" id="ff-domain-hint">
              {t("feed.domainHint")}
            </span>
            {domSuggest && (
              <button type="button" className="link-btn xs" onClick={() => set("site_domain", domSuggest)} data-testid="ff-domain-suggest">
                {t("feed.domainUse", { d: domSuggest })}
              </button>
            )}
            <FieldErr msg={err("site_domain")} />
          </div>
          <div className="field">
            <label htmlFor="ff-cat">{t("feed.f.category")}</label>
            <input id="ff-cat" className="input mono" value={f.category_filter} maxLength={100} placeholder="/culture/" onChange={(e) => set("category_filter", e.target.value)} aria-invalid={inv("category_filter")} aria-describedby="ff-cat-hint" data-testid="ff-cat" />
            <span className="hint" id="ff-cat-hint">
              {t("feed.categoryHint")}
            </span>
            <FieldErr msg={err("category_filter")} />
          </div>
        </div>
        <ChipsInput
          id="ff-extra"
          label={t("feed.f.extraDomains")}
          hint={t("feed.extraHint")}
          values={f.extra_domains}
          max={DOMAINS_MAX}
          mono
          normalize={(s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")}
          validate={(d) => (DOMAIN_RE.test(d) ? null : t("feed.err.domainItem", { d }))}
          onChange={(v) => set("extra_domains", v)}
          testId="ff-extra"
        />
        <CheckBlock check={check} stale={checkStale} feedChanged={feedChanged} onCheck={() => void runCheck()} disabled={readOnly || busy} />
      </fieldset>

      <fieldset className="src-sec" disabled={readOnly || busy}>
        <legend className="sec-h">{t("feed.sec.link")}</legend>
        <InterestPicker values={f.interests} onChange={(v) => set("interests", v)} error={err("interests")} />
        <ChipsInput
          id="ff-ent"
          label={t("feed.f.entities")}
          hint={t("feed.entitiesHint")}
          values={f.entities}
          max={ENTITIES_MAX}
          split={/[,;\n]+/}
          normalize={(s) => s.trim().replace(/\s+/g, " ").slice(0, ENTITY_MAX)}
          validate={() => null}
          onChange={(v) => set("entities", v)}
          testId="ff-ent"
        />
      </fieldset>

      <fieldset className="src-sec" disabled={readOnly || busy}>
        <legend className="sec-h">{t("feed.sec.show")}</legend>
        <div className="feed-display" role="radiogroup" aria-label={t("feed.f.display")} data-testid="ff-display">
          {(["summary", "title_only"] as const).map((d) => (
            <label key={d} className={cx("feed-opt", f.display === d && "is-on")}>
              <input type="radio" name={`${formId}-display`} checked={f.display === d} onChange={() => set("display", d)} />
              <span>
                <b>{t(`feed.display.${d}`)}</b>
                <span className="xs muted block">{t(`feed.display.${d}.h`)}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="field src-enabled">
          <span className="field-label">{t("feed.f.enabled")}</span>
          <Switch
            id="ff-enabled"
            checked={f.enabled}
            onChange={(v) => (v && legal && !source!.enabled ? setLegalAsk(true) : set("enabled", v))}
            label={f.enabled ? t("src.on") : t("src.off")}
            aria={t("feed.f.enabled")}
            disabled={readOnly || busy}
          />
          <span className="hint">{f.enabled ? t("feed.enabledOn") : t("feed.enabledOff")}</span>
          {legal && (
            <Callout kind="warn" icon="alert" testId="ff-legal-note">
              {gate === "terms" ? t("feed.termsNote") : t("feed.legalNote")}
            </Callout>
          )}
        </div>
      </fieldset>

      {!readOnly && (
        <div className="src-commit">
          <div className="field">
            <label htmlFor="ff-reason" className="req">
              {t("src.f.reason")}
            </label>
            <textarea
              id="ff-reason"
              className="textarea"
              rows={2}
              maxLength={500}
              placeholder={t("feed.reasonPh")}
              value={f.reason}
              onChange={(e) => set("reason", e.target.value)}
              aria-invalid={inv("reason")}
              disabled={busy}
              data-testid="ff-reason"
            />
            <span className="hint">{t("feed.reasonHint")}</span>
            <FieldErr msg={err("reason", { n: REASON_MIN })} />
          </div>
          {server && (
            <Callout kind={server.kind} icon="alertCircle" testId="ff-server-err">
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
            {!creating && <Btn kind="danger-ghost" icon="x" label={t("feed.delete")} onClick={() => setDeleting(true)} disabled={busy} testId="ff-delete" />}
            <Btn label={t("common.cancel")} onClick={onCancel} disabled={busy} testId="ff-cancel" />
            <span className="grow" />
            {!creating && (
              <span className="xs muted src-footer-note" data-testid="ff-changed">
                {dirty ? t("src.changed", { f: patch!.changed.map((c) => t(`feed.field.${c}` as MessageKey)).join(", ") }) : t("src.noChanges")}
              </span>
            )}
            <Btn type="submit" form={formId} kind="primary" icon={creating ? "plus" : "check"} label={creating ? t("feed.create") : t("src.save")} busy={busy} disabled={!dirty} perm="news.manage" testId="ff-submit" />
          </>,
          footerEl,
        )}

      {confirmUnchecked && (
        <Modal
          title={t("feed.uncheckedT")}
          text={check.state === "done" && check.sig === sig ? t("feed.uncheckedFailed") : t("feed.uncheckedM")}
          icon="alert"
          tone="warn"
          onClose={() => setConfirmUnchecked(false)}
          testId="ff-unchecked"
          footer={
            <>
              <Btn label={t("feed.checkFirst")} onClick={() => (setConfirmUnchecked(false), void runCheck())} testId="ff-unchecked-check" />
              <Btn label={t("feed.saveAnyway")} kind="primary" onClick={() => (setConfirmUnchecked(false), void save(true))} testId="ff-unchecked-ok" />
            </>
          }
        >
          {f.enabled && <p className="xs muted">{t("feed.uncheckedEnabled")}</p>}
        </Modal>
      )}
      {legalAsk && source && (
        <Modal
          title={t("feed.legalT", { n: source.name })}
          text={gate === "terms" ? t("feed.termsM") : t("feed.legalM")}
          icon="alert"
          tone="warn"
          onClose={() => (setLegalAsk(false), setLegalAck(false))}
          testId="ff-legal-confirm"
          footer={
            <>
              <Btn label={t("common.cancel")} onClick={() => (setLegalAsk(false), setLegalAck(false))} />
              <Btn
                label={t("feed.legalOk")}
                kind="primary"
                disabled={!legalAck}
                onClick={() => {
                  set("enabled", true);
                  setLegalAsk(false);
                  setLegalAck(false);
                }}
                testId="ff-legal-ok"
              />
            </>
          }
        >
          <label className="check-row" data-testid="ff-legal-ack">
            <input type="checkbox" checked={legalAck} onChange={(e) => setLegalAck(e.target.checked)} />
            <span>{gate === "terms" ? t("feed.termsAck") : t("feed.legalAck")}</span>
          </label>
        </Modal>
      )}
      {deleting && source && (
        <ConfirmCommand
          title={t("feed.deleteT", { n: source.name })}
          text={t("feed.deleteM")}
          icon="x"
          tone="bad"
          ok={t("feed.deleteOk")}
          okKind="danger"
          minReason={REASON_MIN}
          reasonPlaceholder={t("feed.deletePh")}
          testId="ff-delete-confirm"
          onClose={() => setDeleting(false)}
          onConfirm={async (reason) => {
            try {
              await NewsApi.remove(source.source_id, source.version, reason, uuid());
              toast(t("feed.deleted", { n: source.name }), "ok", "news.source.deleted");
              onSaved(null);
              return null;
            } catch (x) {
              if (x instanceof ApiError && x.code === "NEWS_SOURCE_VERSION_CONFLICT") {
                setDeleting(false);
                setConflict(true);
                return null;
              }
              return errText(i, x);
            }
          }}
        />
      )}
    </form>
  );
}

/** «Check the feed»: trial fetch without saving — first entries, what would be dropped and why, errors. */
function CheckBlock({ check, stale, feedChanged, onCheck, disabled }: { check: CheckState; stale: boolean; feedChanged: boolean; onCheck: () => void; disabled: boolean }) {
  const i = useI18n();
  const { t, tp, fmt } = i;
  let body: ReactNode = <p className="xs muted">{feedChanged ? t("feed.check.hintNew") : t("feed.check.hint")}</p>;
  if (check.state === "busy") body = <Spinner label={t("feed.check.busy")} />;
  if (check.state === "error") {
    const unavailable = check.error instanceof ApiError && check.error.code === "CHECK_UNAVAILABLE";
    body = (
      <Callout kind={unavailable ? "info" : "bad"} icon={unavailable ? "info" : "alertCircle"} testId="ff-check-error">
        <b>{unavailable ? t("feed.check.unavailable") : errText(i, check.error)}</b>
        {!unavailable && errMeta(check.error) && <span className="xs muted block mono">{errMeta(check.error)}</span>}
      </Callout>
    );
  }
  if (check.state === "done") {
    const r = check.res;
    const usable = checkUsable(r);
    body = (
      <div className="stack-8" data-testid="ff-check-result" data-ok={r.ok}>
        <Callout kind={r.ok ? "good" : "bad"} icon={r.ok ? "checkCircle" : "alertCircle"}>
          <b>{r.ok ? t("feed.check.ok", { n: usable, total: r.items_total }) : t("feed.check.fail")}</b>{" "}
          <span className="xs muted">{t("feed.check.at", { t: fmt.time(r.checked_at) })}</span>
          {r.errors.length > 0 && (
            <ul className="feed-errs">
              {r.errors.map((e) => (
                <li key={e.code}>
                  <span className="act-code crit">{e.code}</span> {feedCodeLabel(t, e.code)}
                  {e.message && <span className="xs muted block wrap-any">{e.message}</span>}
                </li>
              ))}
            </ul>
          )}
        </Callout>
        {r.items.length > 0 && (
          <ol className="feed-items" aria-label={t("feed.check.items")}>
            {r.items.map((x) => (
              <li key={x.url} className={cx(x.dropped && "is-dropped")}>
                {webHref(x.url) ? (
                  <a href={webHref(x.url)!} target="_blank" rel="noopener noreferrer nofollow" className="feed-item-t">
                    {x.title}
                    <Icon name="ext" />
                  </a>
                ) : (
                  <span className="feed-item-t">{x.title}</span>
                )}
                <span className="xs muted">
                  {x.published_at ? fmt.dateTime(x.published_at) : t("feed.check.noDate")}
                  {x.dropped && (
                    <>
                      {" · "}
                      <span className="feed-drop">{dropLabel(t, x.dropped)}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
        {r.items_total > r.items.length && <p className="xs muted">{tp("feed.check.more", r.items_total - r.items.length)}</p>}
      </div>
    );
  }
  return (
    <div className="feed-check" data-testid="ff-check">
      <div className="feed-check-h">
        <div className="grow">
          <b className="small">{t("feed.check.title")}</b>
          {stale && (
            <span className="xs feed-stale" data-testid="ff-check-stale">
              {" "}
              · {t("feed.check.stale")}
            </span>
          )}
        </div>
        <Btn size="sm" icon="scan" label={t("feed.check.run")} onClick={onCheck} busy={check.state === "busy"} disabled={disabled} testId="ff-check-btn" />
      </div>
      {body}
    </div>
  );
}

/** Interests (taxonomy codes): chosen chips + a select that adds one; 1..10. */
function InterestPicker({ values, onChange, error }: { values: string[]; onChange: (v: string[]) => void; error: string | null }) {
  const { t } = useI18n();
  const full = values.length >= INTERESTS_MAX;
  return (
    <div className="field">
      <label htmlFor="ff-int-add" className="req">
        {t("feed.f.interests")} <span className="muted xs">{values.length}/{INTERESTS_MAX}</span>
      </label>
      <div className={cx("chips", error && "is-invalid")} data-testid="ff-interests">
        {values.map((c) => (
          <span key={c} className="chip">
            <span>{categoryLabel(t, c)}</span>
            <button type="button" aria-label={t("src.chipRemove", { d: categoryLabel(t, c) })} onClick={() => onChange(values.filter((x) => x !== c))}>
              <Icon name="x" />
            </button>
          </span>
        ))}
        <select
          id="ff-int-add"
          className="chips-select"
          value=""
          disabled={full}
          aria-invalid={error ? true : undefined}
          onChange={(e) => e.target.value && onChange([...values, e.target.value])}
          data-testid="ff-int-add"
        >
          <option value="">{full ? t("feed.interestsFull") : t("feed.interestAdd")}</option>
          {TAXONOMY.filter((c) => !values.includes(c)).map((c) => (
            <option key={c} value={c}>
              {c.includes(".") ? `  ${categoryLabel(t, c)}` : categoryLabel(t, c)}
            </option>
          ))}
        </select>
      </div>
      <span className="hint">{t("feed.interestsHint")}</span>
      <FieldErr msg={error} />
    </div>
  );
}

/** Chips: Enter / comma / blur adds, Backspace on an empty field removes the last one. */
function ChipsInput({
  id,
  label,
  hint,
  values,
  max,
  mono,
  split = /[\s,;]+/,
  normalize,
  validate,
  onChange,
  testId,
}: {
  id: string;
  label: string;
  hint: string;
  values: string[];
  max: number;
  mono?: boolean;
  split?: RegExp;
  normalize: (s: string) => string;
  validate: (s: string) => string | null;
  onChange: (v: string[]) => void;
  testId?: string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const add = (raw: string) => {
    const parts = raw.split(split).map(normalize).filter(Boolean);
    const next = [...values];
    for (const p of parts) {
      const bad = validate(p);
      if (bad) return setMsg(bad);
      if (next.length >= max) return setMsg(t("feed.err.many", { n: max }));
      if (!next.includes(p)) next.push(p);
    }
    onChange(next);
    setDraft("");
    setMsg(null);
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={cx("chips", msg && "is-invalid")} data-testid={testId}>
        {values.map((d) => (
          <span key={d} className="chip">
            <span className={mono ? "mono" : undefined}>{d}</span>
            <button type="button" aria-label={t("src.chipRemove", { d })} onClick={() => onChange(values.filter((x) => x !== d))}>
              <Icon name="x" />
            </button>
          </span>
        ))}
        <input
          id={id}
          className={cx("chips-in", mono && "mono")}
          value={draft}
          maxLength={253}
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={msg ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(e) => (setDraft(e.target.value), setMsg(null))}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || e.key === ";") {
              e.preventDefault();
              if (draft.trim()) add(draft);
            } else if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
          }}
          onBlur={() => draft.trim() && add(draft)}
        />
      </div>
      <span className="hint" id={`${id}-hint`}>
        {hint}
      </span>
      <FieldErr msg={msg} />
    </div>
  );
}


