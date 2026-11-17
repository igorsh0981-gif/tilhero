import type { NewsItem, NewsPreferences } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NewsFilter } from "@tilhero/contracts/bff";
import type { NewsTopic, NewsTopicsResponse } from "@tilhero/contracts/bff";
import { KNOWN_TOP } from "../../events/catalog";
import { useInterests } from "../../state/directory";
import { CAT_ICON } from "../../ui/EventCard";
import { QuickChip } from "../../ui/QuickChip";
import { relativeTime } from "../../events/format";
import { useOpenEvent } from "../../events/hooks";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { haptic, openExternal } from "../../tg";
import { Icon } from "../../ui/Icon";
import { Spinner, ToggleRow } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import { newsDomain, newsSourceUrl, plainText, showableNews } from "../../watch/logic";
import { PrefEditor } from "../profile/PrefEditor";

/**
 * News (prototype v9 SCREENS.news, TG-FR-033): chips Все / Из Watch / По интересам, cards with significance, the link
 * to a watched event or an interest, title and summary as plain text (feeds are untrusted), the source domain opening
 * the item's own https URL via Telegram openLink, the time and «К событию». No pictures from feeds (agency rights) —
 * the card is typographic. Settings: from Watch, by interests, significant only, digest.
 */
const SIG: Record<NewsItem["significance"], { key: MessageKey; tone: string }> = {
  high: { key: "n.sig.high", tone: "lime" },
  mid: { key: "n.sig.mid", tone: "info" },
  low: { key: "n.sig.low", tone: "" },
};
const FILTERS: ReadonlyArray<[NewsFilter, MessageKey]> = [
  ["all", "n.f.all"],
  ["watch", "n.f.watch"],
  ["interests", "n.f.int"],
];

export function newsBound(n: NewsItem, t: (k: MessageKey, v?: Record<string, string>) => string): string {
  if (!n.link) return n.kind === "event_update" ? t("n.update") : "";
  const e = plainText(n.link.label, 80);
  return n.link.type === "watch" ? t("n.bound.watch", { e }) : n.link.type === "interest" ? t("n.bound.interest", { e }) : t("n.bound.event", { e });
}

export function NewsCard({ n }: { n: NewsItem }) {
  const { t, lang } = useI18n();
  const openEvent = useOpenEvent();
  const url = newsSourceUrl(n);
  const domain = newsDomain(n);
  const sig = SIG[n.significance] ?? SIG.mid;
  const bound = newsBound(n, t);
  const summary = plainText(n.summary);
  const eventId = n.event_ids[0];
  return (
    <article className="nw" data-testid="news-card" data-news-id={n.news_id} data-sig={n.significance}>
      <div className="nw-top">
        <span className={`nw-sig ${sig.tone}`} data-testid="news-sig">
          {t(sig.key)}
        </span>
        {bound && (
          <small className="nw-rel" data-testid="news-bound">
            {bound}
          </small>
        )}
      </div>
      <div className="nw-b">
        <h3>{plainText(n.title, 240)}</h3>
        {summary && <p>{summary}</p>}
        <div className="nw-f">
          {url ? (
            <button className="nw-src" type="button" data-testid="news-src" aria-label={t("n.src.a11y", { d: domain })} onClick={() => openExternal(url)}>
              {domain}
              <Icon name="ext" size={12} />
            </button>
          ) : (
            <span>{domain}</span>
          )}
          <time dateTime={n.published_at}>{relativeTime(n.published_at, lang)}</time>
          <span className="sp" />
          {eventId && (
            <button className="lnk" type="button" data-testid="news-to-event" aria-label={t("n.toEventA11y", { e: n.link ? plainText(n.link.label, 80) : plainText(n.title, 120) })} onClick={() => openEvent(eventId)}>
              {t("n.toEvent")}
              <Icon name="chevR" size={14} />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

/** Compact card of the Home «Новости для вас» rail: tap opens the item at its source. */
export function NewsCompact({ n }: { n: NewsItem }) {
  const { t, lang } = useI18n();
  const url = newsSourceUrl(n);
  const sig = SIG[n.significance] ?? SIG.mid;
  return (
    <button className="nc" type="button" data-testid="news-compact" aria-label={`${plainText(n.title, 240)}. ${t("n.src.a11y", { d: newsDomain(n) })}`} onClick={() => url && openExternal(url)}>
      <div className="nc-top">
        <span className="nc-dom">
          {newsDomain(n)}
          <Icon name="ext" size={11} />
        </span>
        {n.significance === "high" && <span className={`nw-sig ${sig.tone}`}>{t("n.sig.short")}</span>}
      </div>
      <div className="nc-b">
        <b>{plainText(n.title, 240)}</b>
        <div className="nc-f">
          <span>{n.link ? plainText(n.link.label, 60) : t("n.update")}</span>
          <span>{relativeTime(n.published_at, lang)}</span>
        </div>
      </div>
    </button>
  );
}

function NewsSettings({ prefs, onChange, onSaved, onClose }: { prefs: NewsPreferences; onChange: (p: NewsPreferences) => void; onSaved: () => void; onClose: () => void }) {
  const { api, profile } = useApp();
  const { t } = useI18n();
  const errText = useErrorText();
  const [busy, setBusy] = useState<keyof NewsPreferences | null>(null);
  const set = async (k: keyof NewsPreferences, v: boolean) => {
    if (busy) return;
    const prev = prefs;
    onChange({ ...prefs, [k]: v });
    setBusy(k);
    try {
      onChange(await api.news.setPreferences({ [k]: v }));
      onSaved(); // the server's selection depends on the preferences
      showToast(t("n.saved"));
    } catch (e) {
      onChange(prev);
      showToast(errText(e), "alert");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet title={t("n.cfg")} onClose={onClose}>
      <div className="group" data-testid="news-settings">
        <ToggleRow id="nc-watch" icon="radar" title={t("n.c.watch")} sub={t("n.c.watchSub")} on={prefs.from_watch} busy={busy === "from_watch"} onChange={(v) => void set("from_watch", v)} />
        <ToggleRow id="nc-int" icon="heart" title={t("n.c.int")} sub={t("n.c.intSub")} on={prefs.by_interests} busy={busy === "by_interests"} onChange={(v) => void set("by_interests", v)} />
        <ToggleRow id="nc-sig" icon="filter" title={t("n.c.sig")} sub={t("n.c.sigSub")} on={prefs.only_significant} busy={busy === "only_significant"} onChange={(v) => void set("only_significant", v)} />
        <ToggleRow
          id="nc-dig"
          icon="bell"
          title={t("n.c.dig")}
          sub={profile?.notifications.digest_time ? t("n.c.digSub", { time: profile.notifications.digest_time }) : t("n.c.digSubNoTime")}
          on={prefs.digest}
          busy={busy === "digest"}
          onChange={(v) => void set("digest", v)}
        />
      </div>
      <p className="hint mt12 nw-note">
        <Icon name="info" size={14} />
        <span>{t("n.c.note")}</span>
      </p>
    </Sheet>
  );
}

/** The chosen topic lives for the session (survives leaving the tab and reopening the Mini App in this session). */
const TOPIC_KEY = "tilhero.news_topic";
let topicMemory: NewsTopic | null | undefined;
function readSessionTopic(): NewsTopic | null {
  if (topicMemory !== undefined) return topicMemory;
  try {
    const v = window.sessionStorage?.getItem(TOPIC_KEY) ?? null;
    topicMemory = v && (KNOWN_TOP as readonly string[]).includes(v) ? (v as NewsTopic) : null;
  } catch {
    topicMemory = null;
  }
  return topicMemory;
}
function writeSessionTopic(x: NewsTopic | null): void {
  topicMemory = x;
  try {
    if (x) window.sessionStorage?.setItem(TOPIC_KEY, x);
    else window.sessionStorage?.removeItem(TOPIC_KEY);
  } catch {
    /* private mode: the memory of this launch is enough */
  }
}
/** tests */
export function resetNewsTopicMemory(): void {
  topicMemory = undefined;
}

export function News() {
  const { api, navigate, profile, reloadProfile } = useApp();
  const { t, l } = useI18n();
  const errText = useErrorText();
  const [filter, setFilter] = useState<NewsFilter>("all");
  const [topic, setTopicState] = useState<NewsTopic | null>(readSessionTopic);
  /** null — loading; "off" — GET /v1/news/topics unavailable: no topic row, the list is not narrowed */
  const [topics, setTopics] = useState<NewsTopicsResponse | "off" | null>(null);
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [more, setMore] = useState(false);
  const [prefs, setPrefs] = useState<NewsPreferences | null>(null);
  const [cfg, setCfg] = useState(false);
  const [interests, setInterests] = useState(false);
  const [n, setN] = useState(0);
  /** user has watches (the «Из Watch» empty state says either «nothing yet» or «put an event on Watch») */
  const [watching, setWatching] = useState<boolean | null>(null);
  const req = useRef<AbortController | null>(null);
  const moreReq = useRef<AbortController | null>(null);
  /** generation of the list: a page answered for an older filter / reload is ignored (review: loadMore race) */
  const gen = useRef(0);

  useEffect(() => {
    // the digest time in the settings is the profile's (never an invented «09:00»)
    if (!profile) void reloadProfile();
    // once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    api.news.preferences(ac.signal).then(
      (p) => !ac.signal.aborted && setPrefs(p),
      () => undefined,
    );
    return () => ac.abort();
  }, [api]);

  const setTopic = (x: NewsTopic | null) => {
    setTopicState(x);
    writeSessionTopic(x);
  };
  const dir = useInterests(api);
  // the topics of the current selection (filter + preferences); a failure hides the row
  useEffect(() => {
    const ac = new AbortController();
    api.news.topics(filter, ac.signal).then(
      // news до 6.1 — {items: [], total: null}: ряда тем нет (bff.ts NewsTopicsResponse)
      (x) =>
        !ac.signal.aborted &&
        setTopics(x && Array.isArray(x.items) && x.total !== null ? { items: x.items.filter((i) => (KNOWN_TOP as readonly string[]).includes(i.topic)), total: Number(x.total) || 0 } : "off"),
      (e) => !ac.signal.aborted && !(e instanceof DOMException) && setTopics("off"),
    );
    return () => ac.abort();
  }, [api, filter, n]);
  const activeTopic = topics === "off" ? null : topic;
  // the chosen topic is always in sight in the scrolling row (restored from the session, or picked at the far end)
  const topicsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = topicsRef.current;
    const on = row?.querySelector<HTMLElement>("[aria-pressed='true']");
    if (!row || !on) return;
    const r = row.getBoundingClientRect();
    const c = on.getBoundingClientRect();
    if (c.left < r.left || c.right > r.right) row.scrollTo({ left: row.scrollLeft + c.left - r.left - 16 });
  }, [topic, topics]);

  useEffect(() => {
    req.current?.abort();
    moreReq.current?.abort();
    const ac = new AbortController();
    req.current = ac;
    const g = ++gen.current;
    setErr(null);
    setItems(null);
    setCursor(null);
    setMore(false);
    api.news.list(filter, null, ac.signal, undefined, activeTopic).then(
      (p) => {
        if (ac.signal.aborted || g !== gen.current) return;
        setItems(showableNews(p.items));
        setCursor(p.next_cursor);
      },
      (e) => !ac.signal.aborted && !(e instanceof DOMException) && setErr(e),
    );
    return () => ac.abort();
  }, [api, filter, n, activeTopic]);

  const loadMore = useCallback(async () => {
    if (!cursor || more) return;
    const g = gen.current;
    const ac = new AbortController();
    moreReq.current = ac;
    setMore(true);
    try {
      const p = await api.news.list(filter, cursor, ac.signal, undefined, activeTopic);
      if (g !== gen.current || ac.signal.aborted) return; // the filter changed meanwhile: not this list's page
      setItems((x) => {
        const seen = new Set((x ?? []).map((i) => i.news_id));
        return [...(x ?? []), ...showableNews(p.items).filter((i) => !seen.has(i.news_id))];
      });
      setCursor(p.next_cursor);
    } catch (e) {
      if (g === gen.current && !ac.signal.aborted && !(e instanceof DOMException)) showToast(errText(e), "alert");
    } finally {
      if (g === gen.current) setMore(false);
    }
  }, [api, cursor, errText, filter, more, activeTopic]);

  // «Из Watch» is empty: find out whether there is anything watched at all (one small request, once)
  useEffect(() => {
    if (filter !== "watch" || !items || items.length || watching !== null) return;
    const ac = new AbortController();
    api.watches.list("active", null, ac.signal).then(
      (p) => !ac.signal.aborted && setWatching(p.items.length > 0),
      () => !ac.signal.aborted && setWatching(false),
    );
    return () => ac.abort();
  }, [api, filter, items, watching]);

  const allOff = !!prefs && !prefs.from_watch && !prefs.by_interests;
  const topicLabel = (x: NewsTopic) => {
    const hit = dir.items?.find((c) => c.code === x && c.parent === null);
    return hit ? l(hit.label) : t(`cat.${x}` as MessageKey);
  };
  // «Все темы» + the non-empty topics in the order of the catalogue chips; a chosen topic that became empty stays
  // (muted, 0) so it can be switched off
  const topicRow =
    topics && topics !== "off"
      ? KNOWN_TOP.filter((x) => topics.items.some((i) => i.topic === x && i.count > 0) || x === topic).map((x) => ({
          topic: x,
          count: topics.items.find((i) => i.topic === x)?.count ?? 0,
        }))
      : [];
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = FILTERS.findIndex(([f]) => f === filter);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -2;
    if (next === -2) return;
    e.preventDefault();
    const [f] = FILTERS[(next + FILTERS.length) % FILTERS.length]!;
    setFilter(f);
    requestAnimationFrame(() => document.getElementById(`news-tab-${f}`)?.focus());
  };

  let body: React.ReactNode;
  if (err) {
    body = (
      <div className="empty" data-testid="news-error">
        <div className="empty-art">
          <Icon name="alert" size={46} />
        </div>
        <h3>{t("n.err.h")}</h3>
        <p>{errText(err)}</p>
        <div className="btns">
          <button className="btn btn-lime" type="button" onClick={() => setN((x) => x + 1)}>
            <Icon name="refresh" size={16} />
            {t("common.retry")}
          </button>
        </div>
      </div>
    );
  } else if (!items) {
    body = (
      <div className="nw-sk" aria-busy="true" data-testid="news-loading">
        <div className="sk" />
        <div className="sk" />
      </div>
    );
  } else if (!items.length && activeTopic) {
    body = (
      <div className="empty" data-testid="news-empty" data-reason="topic">
        <div className="empty-art">
          <Icon name={CAT_ICON[activeTopic] ?? "news"} size={46} />
        </div>
        <h3>{t("n.topic.empty.h", { x: topicLabel(activeTopic) })}</h3>
        <p>{t("n.topic.empty.p")}</p>
        <div className="btns">
          <button className="btn btn-lime" type="button" data-testid="news-topic-reset" onClick={() => setTopic(null)}>
            {t("n.topic.all")}
          </button>
        </div>
      </div>
    );
  } else if (!items.length) {
    body = allOff ? (
      <div className="empty" data-testid="news-empty" data-reason="off">
        <div className="empty-art">
          <Icon name="sliders" size={46} />
        </div>
        <h3>{t("n.off.h")}</h3>
        <p>{t("n.off.p")}</p>
        <div className="btns">
          <button className="btn btn-lime" type="button" onClick={() => setCfg(true)}>
            {t("n.off.btn")}
          </button>
        </div>
      </div>
    ) : (filter === "watch" && prefs && !prefs.from_watch) || (filter === "interests" && prefs && !prefs.by_interests) ? (
      <div className="empty" data-testid="news-empty" data-reason="filter-off">
        <div className="empty-art">
          <Icon name="sliders" size={46} />
        </div>
        <h3>{t(filter === "watch" ? "n.offW.h" : "n.offI.h")}</h3>
        <p>{t("n.offOne.p")}</p>
        <div className="btns">
          <button className="btn btn-lime" type="button" onClick={() => setCfg(true)}>
            {t("n.off.btn")}
          </button>
        </div>
      </div>
    ) : filter === "watch" ? (
      <div className="empty" data-testid="news-empty" data-reason={watching ? "watch-quiet" : "watch"}>
        <div className="empty-art">
          <Icon name="radar" size={46} />
        </div>
        <h3>{t("n.empty.h")}</h3>
        <p>{t(watching ? "n.empty.watching.p" : "n.empty.watch.p")}</p>
        <div className="btns">
          {watching ? (
            <button className="btn btn-soft" type="button" onClick={() => navigate({ type: "tab", tab: "watch" })}>
              <Icon name="radar" size={16} />
              {t("n.empty.watching.btn")}
            </button>
          ) : (
            <button className="btn btn-lime" type="button" onClick={() => navigate({ type: "tab", tab: "catalog" })}>
              <Icon name="ticket" size={16} />
              {t("n.empty.watch.btn")}
            </button>
          )}
        </div>
      </div>
    ) : (
      <div className="empty" data-testid="news-empty" data-reason="none">
        <div className="empty-art">
          <Icon name="news" size={46} />
        </div>
        <h3>{t("n.empty.h")}</h3>
        <p>{t("n.empty.p")}</p>
        <div className="btns">
          <button
            className="btn btn-lime"
            type="button"
            onClick={() => {
              if (!profile) void reloadProfile();
              setInterests(true);
            }}
          >
            <Icon name="flag" size={16} />
            {t("n.empty.btn")}
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="sec nw-list" data-testid="news-list">
        {items.map((x) => (
          <NewsCard key={x.news_id} n={x} />
        ))}
        {cursor && (
          <button className="btn btn-soft btn-block mt12" type="button" disabled={more} onClick={() => void loadMore()}>
            {more ? <Spinner small /> : null}
            {t("n.more")}
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <header className="pg-h">
        <h1>{t("n.h")}</h1>
        <button className="ib" type="button" aria-label={t("n.cfg")} data-testid="news-cfg" disabled={!prefs} onClick={() => setCfg(true)}>
          <Icon name="sliders" size={20} />
        </button>
      </header>
      <p className="pd hint wt-sub">{t("n.sub")}</p>
      {/* the filter switches what the list below shows: tabs (one selected), arrow keys move between them */}
      <div className="chips nw-chips" role="tablist" aria-label={t("n.filterA11y")} onKeyDown={onTabKey}>
        {FILTERS.map(([f, key]) => (
          <button
            key={f}
            className="chip"
            type="button"
            role="tab"
            id={`news-tab-${f}`}
            aria-selected={filter === f}
            aria-controls="news-panel"
            tabIndex={filter === f ? 0 : -1}
            data-testid={`news-f-${f}`}
            onClick={() => {
              if (filter === f) return;
              haptic.selection();
              setFilter(f);
            }}
          >
            {t(key)}
          </button>
        ))}
      </div>
      <div id="news-panel" role="tabpanel" aria-labelledby={`news-tab-${filter}`}>
        {topics === null && (
          <div className="chips nw-topics" aria-hidden="true" data-testid="news-topics-loading">
            <span className="chip sk" />
            <span className="chip sk" />
            <span className="chip sk" />
          </div>
        )}
        {topics && topics !== "off" && (
          <div className="chips nw-topics ct-chips" role="group" aria-label={t("n.topics")} data-testid="news-topics" ref={topicsRef}>
            <QuickChip id="all" testIdPrefix="nt" noun="n.topic.noun" pressed={topic === null} count={topics.total ?? undefined} label={t("n.topic.all")} onToggle={() => setTopic(null)} />
            {topicRow.map((x) => (
              <QuickChip
                key={x.topic}
                id={x.topic}
                testIdPrefix="nt"
                noun="n.topic.noun"
                icon={CAT_ICON[x.topic]}
                pressed={topic === x.topic}
                count={x.count}
                label={topicLabel(x.topic)}
                onToggle={() => setTopic(topic === x.topic ? null : x.topic)}
              />
            ))}
          </div>
        )}
        {body}
      </div>
      <div className="scr-end" />
      {cfg && prefs && <NewsSettings prefs={prefs} onChange={setPrefs} onSaved={() => setN((x) => x + 1)} onClose={() => setCfg(false)} />}
      {interests && profile && <PrefEditor kind="interests" onClose={() => setInterests(false)} />}
    </>
  );
}
