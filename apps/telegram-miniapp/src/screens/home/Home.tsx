import type { EventCard, HomeResponse, HomeSection, HomeSectionType } from "@tilhero/contracts/bff";
import { useCallback, useEffect, useState } from "react";
import routesArt from "../../assets/art/routes.svg";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { Icon, type IconName } from "../../ui/Icon";
import { useOpenEvent, useTypeLabel } from "../../events/hooks";
import { Flap, Note } from "../../ui/kit";
import { Sheet, showToast } from "../../ui/overlays";
import { PrefEditor } from "../profile/PrefEditor";
import { Rail } from "../../ui/Rail";
import { clampScore } from "../../events/why";
import { boardTime, changeFlap, changeLine, criticalKeysOfRows, normalizeChangeRows, showableNews, type ChangeRow } from "../../watch/logic";
import { watchStore } from "../../watch/store";
import { requestCatalogPreset, requestCatalogSearchFocus } from "../events/Catalog";
import { NewsCompact } from "../news/News";
import { WatchableCard } from "../watch/WatchableCard";
import { useWatchAction } from "../watch/WatchSheet";
import { AiHomeEntry } from "../ai/entry";
import { HomeScreenCard } from "../homescreen/HomeScreen";
import { useAutoWhatsNew } from "../whatsnew/WhatsNew";

/** the welcome stays for the whole first launch until the user closes it */
const launch = { closed: false };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "");
  return s.toUpperCase() || "AI";
}

function greetingKey(d = new Date()): MessageKey {
  const h = d.getHours();
  if (h >= 5 && h < 12) return "home.greet.morning";
  if (h >= 12 && h < 17) return "home.greet.day";
  if (h >= 17 && h < 23) return "home.greet.eve";
  return "home.greet.night";
}

interface SectionMeta {
  title: MessageKey;
  sub?: MessageKey;
  pending: MessageKey;
  icon: IconName;
}
const BY_KEY: Record<string, SectionMeta> = {
  best_for_you: { title: "home.best", sub: "home.best.sub", pending: "home.pend.best", icon: "spark" },
  watch: { title: "home.chg", sub: "home.chg.sub", pending: "home.chg.empty", icon: "radar" },
  sales_soon: { title: "home.soon", sub: "home.soon.sub", pending: "home.pend.soon", icon: "ticket" },
  news: { title: "home.news", sub: "home.news.sub", pending: "home.pend.news", icon: "news" },
};
const BY_TYPE: Record<HomeSectionType, SectionMeta> = {
  event_carousel: { title: "home.best", pending: "home.pend.best", icon: "spark" },
  watch_changes: { title: "home.chg", sub: "home.chg.sub", pending: "home.chg.empty", icon: "radar" },
  news_carousel: { title: "home.news", pending: "home.pend.news", icon: "news" },
  ai_summary: { title: "home.summary", sub: "home.summary.sub", pending: "home.pend.summary", icon: "spark" },
  catalog_link: { title: "home.catalog", pending: "home.pend.best", icon: "ticket" },
};

/** Pending rail: two hatched placeholders, no invented events (BR: никаких фейковых событий). */
function PendingRail({ meta, compact, label }: { meta: SectionMeta; compact: boolean; label: string }) {
  const { t } = useI18n();
  return (
    <div className={compact ? "rail compact" : "rail"} role="group" aria-label={label} tabIndex={0}>
      <article className="pend">
        <div className="pend-m">
          <Icon name={meta.icon} size={compact ? 30 : 38} />
          <Flap tone="info">{t("flap.soon")}</Flap>
        </div>
        <div className="pend-b">
          <h3>{t("home.pend.h")}</h3>
          <p>{t(meta.pending)}</p>
        </div>
      </article>
      <article className="pend ghost" aria-hidden="true">
        <div className="pend-m">
          <Icon name={meta.icon} size={compact ? 26 : 32} />
        </div>
        <div className="pend-b">
          <div className="pend-lines">
            <i />
            <i />
            <i />
          </div>
        </div>
      </article>
    </div>
  );
}

/** While /v1/home is loading: ghost cards only (no text, no invented events). */
function LoadingRail({ compact }: { compact: boolean }) {
  return (
    <div className={compact ? "rail compact" : "rail"} aria-hidden="true" data-testid="rail-loading">
      {[0, 1].map((i) => (
        <article key={i} className="pend ghost">
          <div className="pend-m" />
          <div className="pend-b">
            <div className="pend-lines">
              <i />
              <i />
              <i />
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

/** Rail of event cards (mounted only when there are cards — the interests directory is loaded for type labels then).
 *  Sprint 6: «Лучшее для вас» shows the recommendation score; every card has the Watch icon. */
function EventRail(props: { id: string; items: EventCard[]; compact: boolean; label: string; scores?: boolean; wa: ReturnType<typeof useWatchAction> }) {
  const { t } = useI18n();
  const typeLabel = useTypeLabel();
  const openEvent = useOpenEvent();
  return (
    <Rail id={props.id} compact={props.compact} label={props.label}>
      {props.items.map((e, i) => (
        <div key={e.event_id} className="rail-item" role="group" aria-label={t("a11y.slide", { n: i + 1, m: props.items.length })}>
          <WatchableCard
            event={e}
            variant={props.compact ? "compact" : "large"}
            typeLabel={typeLabel(e.categories)}
            onOpen={openEvent}
            score={props.scores ? clampScore(e.recommendation?.score) : null}
            wa={props.wa}
          />
        </div>
      ))}
    </Rail>
  );
}

/** «Что изменилось» (watch_changes): the departure board of the latest changes; a row opens the watch sheet. */
function ChangesBoard({ rows, onRow }: { rows: ChangeRow[]; onRow: (r: ChangeRow) => void }) {
  const { t, lang } = useI18n();
  return (
    <ul className="board home-chg" data-testid="home-changes">
      {rows.slice(0, 5).map((r) => {
        const bt = boardTime(r.change.detected_at, lang);
        const flap = changeFlap(r.change, lang);
        const line = changeLine(r.change, lang);
        const vars = line.vars.s ? { ...line.vars, s: t(`life.${line.vars.s}` as MessageKey) } : line.vars;
        return (
          <li key={r.change.change_id}>
            <button className="brow" type="button" data-testid="home-change" data-type={r.change.type} onClick={() => onRow(r)}>
              <time dateTime={r.change.detected_at}>{bt.kind === "yday" ? t("w.d.yday") : bt.text}</time>
              <span className="brow-t">
                <b>{r.event_title.toUpperCase()}</b>
                <small>{t(line.key as MessageKey, vars)}</small>
              </span>
              <span className={`flap ${flap.tone}`}>{flap.text || t(flap.key as MessageKey)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** «Что изменилось» while /v1/home loads: the board's shape without invented rows. */
function BoardSkeleton() {
  return (
    <div className="board wt-board-sk" aria-hidden="true" data-testid="home-changes-loading">
      {[0, 1, 2].map((i) => (
        <div className="brow" key={i}>
          <i className="sk" />
          <span className="brow-t">
            <i className="sk" />
            <i className="sk short" />
          </span>
          <i className="sk flap-sk" />
        </div>
      ))}
    </div>
  );
}

/** «Почему так?» (prototype v9 SHEETS.whyRank): how «Лучшее для вас» is ranked, and where to change it. */
function WhyRankSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { profile, reloadProfile } = useApp();
  const [edit, setEdit] = useState(false);
  const rows: ReadonlyArray<[IconName, MessageKey]> = [
    ["heart", "why.f.interests"],
    ["globe", "why.f.geography"],
    ["wallet", "why.f.budget"],
    ["star", "why.f.significance"],
    ["clock", "why.f.freshness"],
    ["plusc", "why.f.feedback"],
  ];
  return (
    <Sheet
      title={t("home.why.t")}
      onClose={onClose}
      foot={
        <button
          className="btn btn-soft"
          type="button"
          onClick={() => {
            if (!profile) void reloadProfile();
            setEdit(true);
          }}
        >
          <Icon name="flag" size={16} />
          {t("n.empty.btn")}
        </button>
      }
    >
      <div data-testid="why-rank">
        <p className="lead">{t("home.why.m")}</p>
        <ul className="why-rank">
          {rows.map(([icon, key]) => (
            <li key={key}>
              <span className="lrow-i">
                <Icon name={icon} size={16} />
              </span>
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
        <p className="hint mt12">{t("home.why.note")}</p>
      </div>
      {edit && profile && <PrefEditor kind="interests" onClose={() => setEdit(false)} />}
    </Sheet>
  );
}

/** Summary tile: a number, its plural word, an action (zero → muted, not tappable). */
function SumTile(props: { n: number; word: string; cls: string; onClick: () => void; testId: string }) {
  const { t } = useI18n();
  return (
    <button
      className={["sum-k", props.n ? props.cls : ""].filter(Boolean).join(" ")}
      type="button"
      disabled={!props.n}
      data-testid={props.testId}
      aria-label={props.n ? t("home.sum.go", { n: props.n, w: props.word }) : undefined}
      onClick={props.onClick}
    >
      <b className="num">{props.n}</b>
      <small>{props.word}</small>
    </button>
  );
}

const isEventCards = (s: HomeSection): s is HomeSection & { items: EventCard[] } => s.type === "event_carousel";

/** «с 28.09» — the previous visit in the viewer's calendar. */
function sinceLabel(iso: string | undefined, lang: "ru" | "en"): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-GB", { day: "2-digit", month: "2-digit" }).format(d);
}

export function Home() {
  const { api, session, config, navigate, profile, firstVisit } = useApp();
  const { t, tp, lang } = useI18n();
  const errText = useErrorText();
  const wa = useWatchAction();
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [whyRank, setWhyRank] = useState(false);
  const user = session.user;
  const mode = config.home.welcome_mode;
  // first visit → big welcome; returning visits → compact AI summary when the server sends one (ТЗ §6, AT-23)
  const [welcomeOpen, setWelcomeOpen] = useState(!launch.closed && (mode === "always" || (mode === "first_visit_only" && firstVisit)));

  useEffect(() => {
    let alive = true;
    api.home.get().then(
      (h) => {
        if (!alive) return;
        setHome(h);
        // the badge counts critical changes by their keys from «Что изменилось» (not summary.critical — another quantity)
        const board = h.sections.find((x) => x.type === "watch_changes" && (x.state === "ready" || x.state === "stale"));
        if (board) watchStore.setCritical(criticalKeysOfRows(normalizeChangeRows(board.items)));
      },
      () => alive && setLoadErr(true),
    );
    return () => {
      alive = false;
    };
  }, [api]);
  const reload = useCallback(() => {
    setLoadErr(false);
    api.home.get().then(setHome, (e) => {
      setLoadErr(true);
      showToast(errText(e), "alert");
    });
  }, [api, errText]);

  const status = profile?.user.status ?? user.status;
  // AT-23: a counter is null when its source is unavailable — the tile is hidden, not shown as «0»
  const sum = home?.summary ?? null;
  const since = sinceLabel(sum?.since, lang);
  const sumTiles: React.ReactElement[] = [];
  if (sum && typeof sum.new_events === "number") {
    const n = sum.new_events;
    sumTiles.push(
      <SumTile
        key="new"
        n={n}
        word={tp("home.sum.new", n)}
        cls="lime"
        testId="sum-new"
        onClick={() => {
          requestCatalogPreset({ sort: "newest" }, { n, since });
          navigate({ type: "tab", tab: "catalog" });
        }}
      />,
    );
  }
  if (sum && typeof sum.price_drops === "number")
    sumTiles.push(<SumTile key="cheaper" n={sum.price_drops} word={tp("home.sum.cheaper", sum.price_drops)} cls="good" testId="sum-cheaper" onClick={() => navigate({ type: "tab", tab: "watch" })} />);
  if (sum && typeof sum.sales_opened === "number")
    sumTiles.push(<SumTile key="opened" n={sum.sales_opened} word={tp("home.sum.opened", sum.sales_opened)} cls="info" testId="sum-opened" onClick={() => navigate({ type: "tab", tab: "watch" })} />);
  if (sum && typeof sum.critical === "number")
    sumTiles.push(
      <SumTile
        key="crit"
        n={sum.critical}
        word={sum.critical ? tp("home.sum.crit", sum.critical) : t("home.sum.critNone")}
        cls="bad"
        testId="sum-crit"
        onClick={() => navigate({ type: "tab", tab: "watch" })}
      />,
    );
  const consent = profile?.consent ?? session.consent;
  const sections = config.home.sections.filter((s) => s.enabled);
  const showWelcome = mode !== "never" && welcomeOpen;
  // AT-34: the catalogue is down, the BFF serves a saved copy of the picks
  const stale = !!home?.sections.some((x) => x.state === "stale");
  // 9.4: «Что нового» — после загрузки Главной (или её ошибки), раз за запуск
  // не поверх приветствия первого запуска: шторка — после того, как его закроют (ревью 9.4)
  const whatsNew = useAutoWhatsNew((!!home || loadErr) && !showWelcome);

  return (
    <>
      <header className="hm-h">
        <h1>
          <span>{t(greetingKey())},</span>
          {user.display_name}
        </h1>
        <button className="ava" type="button" aria-label={t("tab.profile")} onClick={() => navigate({ type: "tab", tab: "profile" })}>
          {initials(user.display_name)}
        </button>
      </header>
      <button
        className="searchbar"
        type="button"
        onClick={() => {
          requestCatalogSearchFocus();
          navigate({ type: "tab", tab: "catalog" });
        }}
      >
        <Icon name="search" size={18} />
        <span>{t("home.search")}</span>
      </button>
      <AiHomeEntry />

      {(status === "DISABLED" || !consent.accepted || (consent.accepted && consent.policy_version !== consent.current_policy_version) || loadErr || stale) && (
        <div className="hm-notes">
          {stale && (
            <Note icon="db" className="stale" tone="warn">
              <span data-testid="home-stale">{t("home.stale")}</span>
            </Note>
          )}
          {status === "DISABLED" && (
            <Note tone="warn" icon="power" action={{ label: t("home.app.on"), onClick: () => navigate({ type: "tab", tab: "profile" }) }}>
              {t("home.app.off")}
            </Note>
          )}
          {status !== "DISABLED" && !consent.accepted && (
            <Note tone="warn" icon="doc" action={{ label: t("home.pers.on"), onClick: () => navigate({ type: "tab", tab: "profile" }) }}>
              {t("home.pers.off")}
            </Note>
          )}
          {consent.accepted && consent.policy_version !== consent.current_policy_version && (
            <Note tone="warn" icon="doc" action={{ label: t("home.policy.btn"), onClick: () => navigate({ type: "tab", tab: "profile" }) }}>
              {t("home.policy.new", { v: consent.current_policy_version })}
            </Note>
          )}
          {loadErr && (
            <Note tone="warn" icon="alert" action={{ label: t("common.retry"), onClick: reload }}>
              {t("err.SERVICE_UNAVAILABLE")}
            </Note>
          )}
        </div>
      )}

      {showWelcome && (
        <section className="welcome" aria-label={t("home.w.h")} data-testid="home-welcome">
          <div className="media">
            <img className="art" src={routesArt} alt="" />
          </div>
          <button
            className="ib glass"
            type="button"
            aria-label={t("home.w.close")}
            onClick={() => {
              setWelcomeOpen(false);
              launch.closed = true;
            }}
          >
            <Icon name="x" size={18} />
          </button>
          <div className="welcome-c">
            <h2>{t("home.w.h")}</h2>
            <p>{t("home.w.p")}</p>
            <div className="gl">
              <span>
                <Icon name="globe" size={14} />
                {t("home.w.b1")}
              </span>
              <span>
                <Icon name="route" size={14} />
                {t("home.w.b2")}
              </span>
              <span>
                <Icon name="radar" size={14} />
                {t("home.w.b3")}
              </span>
            </div>
          </div>
        </section>
      )}

      {!showWelcome && sum && sumTiles.length > 0 && (
        <section className="sum" aria-label={t("home.sum.h")} data-testid="home-summary">
          <div className="sum-h">
            <Icon name="spark" size={18} />
            <b>{t("home.sum.h")}</b>
            {since && (
              <small className="sum-since" data-testid="home-summary-since">
                {t("home.sum.since", { d: since })}
              </small>
            )}
          </div>
          <div className={sumTiles.length % 2 ? "sum-g odd" : "sum-g"}>{sumTiles}</div>
        </section>
      )}

      {/* 9.4: предложение «на главный экран» — под сводкой «Пока вас не было», не перед ней (ревью) */}
      <HomeScreenCard />

      {sections.map((s) => {
        const meta = BY_KEY[s.key] ?? BY_TYPE[s.type];
        const data = home?.sections.find((x) => x.key === s.key);
        const title = t(meta.title);
        if (s.type === "catalog_link") {
          return (
            <button key={s.key} className="btn btn-soft all-btn" type="button" onClick={() => navigate({ type: "tab", tab: "catalog" })}>
              <Icon name="ticket" size={18} />
              {t("home.allEvents")}
            </button>
          );
        }
        let body;
        let action: { label: string; onClick: () => void; testId: string } | null = null;
        const ready = !!data && (data.state === "ready" || data.state === "stale");
        if (s.type === "watch_changes" && ready && data) {
          const rows = normalizeChangeRows(data.items);
          if (rows.length) {
            action = { label: t("home.chg.all"), onClick: () => navigate({ type: "tab", tab: "watch" }), testId: "home-chg-all" };
            body = <ChangesBoard rows={rows} onRow={(r) => (r.watch_id ? wa.openSheet(r.watch_id) : navigate({ type: "push", route: { name: "event", id: r.event_id } }))} />;
          }
        }
        if (s.type === "news_carousel" && ready && data) {
          const news = showableNews(data.items);
          action = { label: t("home.news.all"), onClick: () => navigate({ type: "tab", tab: "news" }), testId: "home-news-all" };
          body = news.length ? (
            <Rail id={s.key} compact label={t("home.rail.aria", { name: title })}>
              {news.map((n, i) => (
                <div key={n.news_id} className="rail-item" role="group" aria-label={t("a11y.slide", { n: i + 1, m: news.length })}>
                  <NewsCompact n={n} />
                </div>
              ))}
            </Rail>
          ) : (
            <p className="hint">{t("home.news.empty")}</p>
          );
        }
        if (s.key === "best_for_you" && ready && data && data.items.length > 0) {
          action = { label: t("home.why"), onClick: () => setWhyRank(true), testId: "home-why" };
        }
        if (body) {
          // sprint 6 renderers above
        } else if (!home && !loadErr && (s.type === "watch_changes" || s.type === "news_carousel")) {
          // still loading: a skeleton, not the empty «Начните следить» / «Новостей пока нет»
          body = s.type === "watch_changes" ? <BoardSkeleton /> : <LoadingRail compact />;
        } else if (s.type === "watch_changes" && (!data || data.state !== "unavailable")) {
          body = (
            <div className="chg-empty" data-testid="home-changes-empty">
              <Icon name="radar" size={22} />
              <p>{t("home.chg.empty")}</p>
              <button className="btn btn-sm btn-soft" type="button" onClick={() => navigate({ type: "tab", tab: "catalog" })}>
                {t("home.chg.btn")}
              </button>
            </div>
          );
        } else if (s.type === "event_carousel" && !home && !loadErr) {
          body = <LoadingRail compact={s.variant === "compact"} />;
        } else if (data && data.state === "unavailable") {
          body = (
            <Note tone="warn" icon="alert" action={{ label: t("common.retry"), onClick: reload }}>
              <span data-testid={`unavailable-${s.key}`}>{t("home.unavail")}</span>
            </Note>
          );
        } else if (data && (data.state === "ready" || data.state === "stale") && data.items.length === 0) {
          body = <p className="hint">{t("home.ready.empty")}</p>;
        } else if (data && isEventCards(data) && (data.state === "ready" || data.state === "stale")) {
          body = <EventRail id={s.key} items={data.items} compact={s.variant === "compact"} label={t("home.rail.aria", { name: title })} scores={s.key === "best_for_you"} wa={wa} />;
        } else {
          // pending_data (sprint 1) or a renderer that arrives in sprints 3–5
          body = <PendingRail meta={meta} compact={s.variant === "compact"} label={t("home.pend.aria", { name: title })} />;
        }
        return (
          <section className="sec" key={s.key} data-section={s.key} data-state={data?.state ?? (home ? "pending_data" : "loading")}>
            <div className="sec-h">
              <h2>
                {title}
                {meta.sub && <small>{t(meta.sub)}</small>}
              </h2>
              {action && (
                <button className="lnk" type="button" data-testid={action.testId} onClick={action.onClick}>
                  {action.label}
                  <Icon name="chevR" size={14} />
                </button>
              )}
            </div>
            {body}
          </section>
        );
      })}
      {!sections.some((s) => s.type === "catalog_link") && (
        <button className="btn btn-soft all-btn" type="button" onClick={() => navigate({ type: "tab", tab: "catalog" })}>
          <Icon name="ticket" size={18} />
          {t("home.allEvents")}
        </button>
      )}
      <div className="scr-end" />
      {wa.sheet}
      {whyRank && <WhyRankSheet onClose={() => setWhyRank(false)} />}
      {whatsNew}
    </>
  );
}
