import { useCallback, useEffect, useRef, useState } from "react";
import type { NewsAdminItem, NewsSource } from "@tilhero/contracts/admin";
import { NewsApi, type NewsItemFilters } from "../../api/endpoints";
import { useI18n } from "../../i18n";
import { shortId, uuid } from "../../lib/ids";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, cx, Empty, Pill, Seg, Select, Spinner } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { InterestTags } from "./Feeds";
import { countryName, countryOptions } from "../catalog/common";
import { HIDE_REASON_MAX, newsDomain, REASON_MIN, SIG_TONE, summaryFor } from "./news";
import { webHref } from "../../lib/url";

type Shown = "all" | "visible" | "hidden";
const HIDDEN_Q: Record<Shown, NewsItemFilters["hidden"]> = { all: undefined, visible: "false", hidden: "true" };

/** «News» (news.manage): the latest collected news with source, significance and links; hide / return with a reason. */
export function NewsPage() {
  const i = useI18n();
  const { t, lang } = i;
  const [source, setSource] = useState("");
  const [country, setCountry] = useState("");
  const [shown, setShown] = useState<Shown>("all");
  const [rows, setRows] = useState<NewsAdminItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [sources, setSources] = useState<NewsSource[]>([]);
  const [acting, setActing] = useState<{ item: NewsAdminItem; action: "hide" | "unhide" } | null>(null);
  const toast = useToast();
  const req = useRef(0);

  // source filter: the feed registry (dozens of feeds — one page); without it the filter offers «all» only
  useEffect(() => {
    NewsApi.sources({ limit: 100 })
      .then((p) => setSources(p.items))
      .catch(() => setSources([]));
  }, []);

  const filters: NewsItemFilters = { source: source || undefined, country: country || undefined, hidden: HIDDEN_Q[shown] };
  const filtered = !!(source || country || shown !== "all");
  const resetFilters = () => (setSource(""), setCountry(""), setShown("all"));
  // a country narrows the source list too: only feeds of that country (and the chosen one, if it is elsewhere)
  const feedOptions = sources.filter((s) => !country || s.country_code === country || s.source_id === source);
  const fKey = JSON.stringify(filters);
  const load = useCallback(async (f: NewsItemFilters, append: boolean) => {
    const id = ++req.current;
    setLoading(true);
    try {
      const p = await NewsApi.items(f);
      if (id !== req.current) return;
      setRows((xs) => (append ? [...xs, ...p.items] : p.items));
      setCursor(p.next_cursor);
      setError(null);
    } catch (e) {
      if (id === req.current) setError(e);
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(JSON.parse(fKey) as NewsItemFilters, false);
  }, [fKey, load]);

  const replace = (n: NewsAdminItem) =>
    setRows((xs) =>
      // the «visible» / «hidden» filter: an item that changed sides leaves the list
      xs.flatMap((x) => (x.news_id !== n.news_id ? [x] : (shown === "visible" && n.hidden) || (shown === "hidden" && !n.hidden) ? [] : [n])),
    );

  return (
    <div data-testid="news">
      <div className="page-head">
        <div className="lead">
          <p>{t("news.lead")}</p>
        </div>
        <div className="acts">
          <Btn kind="ghost" icon="refresh" label={t("common.refresh")} busy={loading && rows.length > 0} onClick={() => void load(filters, false)} testId="news-refresh" />
        </div>
      </div>
      <div className="toolbar">
        <Seg<Shown>
          label={t("news.f.shown")}
          value={shown}
          onChange={setShown}
          testId="news-shown"
          items={[
            { v: "all", label: t("news.f.all") },
            { v: "visible", label: t("news.f.visible") },
            { v: "hidden", label: t("news.f.hidden") },
          ]}
        />
        <Select
          id="news-source"
          label={t("news.f.source")}
          value={source}
          onChange={setSource}
          testId="news-source"
          options={[{ v: "", label: t("news.f.allSources") }, ...feedOptions.map((s) => ({ v: s.source_id, label: s.name }))]}
        />
        <Select
          id="news-country"
          label={t("rv.f.country")}
          value={country}
          onChange={setCountry}
          testId="news-country"
          options={[{ v: "", label: t("rv.f.allCountries") }, ...countryOptions(lang, sources.map((s) => s.country_code)).map((c) => ({ v: c, label: countryName(lang, c) }))]}
        />
        <Btn kind="ghost" size="sm" label={t("common.resetFilters")} onClick={resetFilters} disabled={!filtered} testId="news-reset" />
      </div>
      {error ? (
        <div className="mb-12">
          <LoadError error={error} onRetry={() => void load(filters, false)} testId="news-error" />
        </div>
      ) : null}
      <section className="panel news-list" aria-label={t("page.news")} aria-busy={loading}>
        {rows.map((n) => (
          <NewsRow key={n.news_id} n={n} onAct={(action) => setActing({ item: n, action })} />
        ))}
        {!loading && !rows.length && !error && (
          <div className="empty-cell">
            {source || country ? (
              <Empty icon="search" title={t("common.nothingFound")} text={country ? t("news.empty.countryM") : t("common.changeFilters")} testId="news-empty-filtered">
                <Btn size="sm" label={t("common.resetFilters")} onClick={resetFilters} testId="news-empty-reset" />
              </Empty>
            ) : shown === "hidden" ? (
              <Empty icon="eyeOff" title={t("news.empty.hiddenT")} text={t("news.empty.hiddenM")} />
            ) : (
              <Empty icon="newspaper" title={t("news.empty.t")} text={t("news.empty.m")} />
            )}
          </div>
        )}
        {loading && <Spinner label={t("common.loading")} />}
        <div className="pager">
          <span>{t("src.shown", { n: rows.length })}</span>
          {cursor && !loading && <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load({ ...filters, cursor }, true)} testId="news-more" />}
        </div>
      </section>
      <p className="xs muted foot-note">
        <Icon name="info" /> {t("news.foot")}
      </p>
      {acting && (
        <ConfirmCommand
          title={acting.action === "hide" ? t("news.hideT") : t("news.unhideT")}
          text={<span className="news-confirm-t">«{acting.item.title}»</span>}
          icon={acting.action === "hide" ? "eyeOff" : "eye"}
          tone={acting.action === "hide" ? "warn" : ""}
          ok={acting.action === "hide" ? t("news.hide") : t("news.unhide")}
          okKind={acting.action === "hide" ? "danger" : "primary"}
          minReason={REASON_MIN}
          reasonPlaceholder={acting.action === "hide" ? t("news.hidePh") : t("news.unhidePh")}
          extra={acting.action === "hide" ? <p className="small mb-12">{t("news.hideM")}</p> : <p className="small mb-12">{t("news.unhideM")}</p>}
          testId="news-confirm"
          onClose={() => setActing(null)}
          onConfirm={async (reason) => {
            if (reason.length > HIDE_REASON_MAX) return t("news.reasonLong", { n: HIDE_REASON_MAX });
            try {
              const fn = acting.action === "hide" ? NewsApi.hide : NewsApi.unhide;
              const n = await fn(acting.item.news_id, reason, uuid());
              replace(n);
              toast(acting.action === "hide" ? t("news.hidden") : t("news.unhidden"), "ok", "news.item.hidden");
              return null;
            } catch (x) {
              return errText(i, x);
            }
          }}
        />
      )}
    </div>
  );
}

function NewsRow({ n, onAct }: { n: NewsAdminItem; onAct: (a: "hide" | "unhide") => void }) {
  const { t, fmt, lang } = useI18n();
  const summary = summaryFor(n, lang);
  const lvl = n.significance_level;
  return (
    <article className={cx("news-row", n.hidden && "is-hidden", lvl && `sig-${lvl}`)} data-news={n.news_id} data-testid="news-row">
      <div className="news-meta">
        {lvl && (
          <Pill tone={SIG_TONE[lvl] ?? "neutral"} title={n.significance != null ? t("news.sigScore", { n: fmt.num(n.significance, 2) }) : undefined}>
            {t(`news.sig.${lvl}`)}
          </Pill>
        )}
        <span className="tag plain">{t(`news.kind.${n.kind}`)}</span>
        <span className="news-src" title={n.source.source_id ?? undefined}>
          <b>{n.source.name}</b> · <span className="mono">{newsDomain(n)}</span>
        </span>
        <span className="grow" />
        <span className="xs muted nowrap" title={fmt.dateTime(n.published_at ?? n.collected_at)}>
          {n.published_at ? fmt.rel(n.published_at) : n.collected_at ? t("news.collected", { t: fmt.rel(n.collected_at) }) : "—"}
        </span>
      </div>
      <h3 className="news-title">
        {webHref(n.url) ? (
          <a href={webHref(n.url)!} target="_blank" rel="noopener noreferrer nofollow" data-testid="news-link">
            {n.title}
            <Icon name="ext" />
          </a>
        ) : (
          <span data-testid="news-link">{n.title}</span>
        )}
      </h3>
      {summary ? <p className="news-sum small">{summary}</p> : <p className="news-sum xs muted">{t("news.noSummary")}</p>}
      <div className="news-foot">
        <InterestTags codes={n.interests} />
        {n.event_ids.length > 0 && (
          <span className="news-events xs" title={n.event_ids.join("\n")}>
            <Icon name="link" /> {t("news.events", { n: n.event_ids.length })}
            <span className="mono muted">{n.event_ids.map((e) => shortId(e, 4, 4)).join(", ")}</span>
          </span>
        )}
        {n.below_threshold && !n.hidden && (
          <span className="xs muted news-low" title={t("news.belowH")}>
            <Icon name="down" /> {t("news.below")}
          </span>
        )}
        <span className="grow" />
        {n.hidden ? (
          <Btn size="sm" icon="eye" label={t("news.unhide")} perm="news.manage" onClick={() => onAct("unhide")} testId="news-unhide" />
        ) : (
          <Btn size="sm" kind="danger-ghost" icon="eyeOff" label={t("news.hide")} perm="news.manage" onClick={() => onAct("hide")} testId="news-hide" />
        )}
      </div>
      {n.hidden && (
        <div className="news-hidden" data-testid="news-hidden">
          <Icon name="eyeOff" />
          <span>
            <b>{t("news.hiddenBy", { who: n.hidden_by_name ?? (n.hidden_by ? shortId(n.hidden_by, 8, 4) : t("news.system")) })}</b>
            {n.hidden_at && <span className="muted"> · {fmt.dateTime(n.hidden_at)}</span>}
            {n.hidden_reason && <span className="block wrap-any">{n.hidden_reason}</span>}
          </span>
        </div>
      )}
    </article>
  );
}
