import type { EventDetailView, EventLifecycleStatus, SourceTier } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { ApiError } from "../../api/errors";
import { env } from "../../env";
import { formatEventDates, formatEventTime, formatFetched, formatMoney, hostOf, lifecycleBasis, provenanceDomain, relativeTime, sourceLabel, sourceLine } from "../../events/format";
import { useTypeLabel } from "../../events/hooks";
import { useI18n, type MessageKey } from "../../i18n";
import { useApp, useErrorText } from "../../state/app";
import { eventStartLink, haptic, openExternal, shareToTelegram } from "../../tg";
import { countryName, EventMediaView, LifecycleBadge } from "../../ui/EventCard";
import { Icon } from "../../ui/Icon";
import { Empty, Spinner } from "../../ui/kit";
import { useWatchRef } from "../../watch/store";
import { useWatchAction } from "../watch/WatchSheet";
import { TripBlock, TripBoundary } from "./Trip";
import { NotInterested, useReaction, WhyBlock } from "./Why";
import { useAskAiButton } from "../ai/entry";

/**
 * Event detail (sprint 3): cover with media provenance or the neutral fallback (AT-25); title, venue · dates ·
 * format; sources with tier and exact links (official deeplink BR-TG-008, venue on the map TG-FR-028); lifecycle
 * track with its basis (TG-FR-022); ticket price range as a dated provider fact (TG-FR-029) + disclaimer
 * (BR-TG-009); share as a Mini App deep link; support with the event context (TG-FR-041).
 * Sprint 4: an AI-found event (provider aiweb.<slug>) shows its source as the event page's domain, the photo chip
 * «Фото: iticket.uz» (rights official_site), and every source row opens its page via Telegram openLink.
 * Review fixes: one primary CTA to the source (official_url) + the per-source links — no third «Официальный источник»
 * button; the lifecycle basis names the fact (staff_reviewed / listed_on_official_site).
 * Fix 4.1: the CTA says what the exact link opens — «Купить билеты у источника» while tickets are sold
 * (ON_SALE / LOW_INVENTORY / RESALE: e.g. a Ticketmaster deeplink lands on seat selection), otherwise «Подробнее у
 * источника»; no price from the source → «Цена — на сайте источника» (not «no prices»).
 * Sprint 5: the «Поездка» block (./Trip.tsx) right after «when / where» — the boarding pass with the total is the
 * main answer of the screen; it loads by its own request and its failure never breaks the detail.
 * Fix 5.1: a past event (is_past) — «Событие прошло» instead of the sales status, no buy CTA, the trip is not priced.
 * Sprint 6: «Следить» one tap next to the CTA (a watched event — «Следите», the tap opens the watch sheet); «Почему
 * вам» (score ring, reasons, factors, reactions) right after the actions when the BFF sent a recommendation.
 */
const SIDE: ReadonlySet<EventLifecycleStatus> = new Set(["POSTPONED", "CANCELLED"]);
/** Statuses with tickets on sale (the same set as the catalogue filter has_tickets). */
export const SELLING: ReadonlySet<EventLifecycleStatus> = new Set(["ON_SALE", "LOW_INVENTORY", "RESALE"]);

export function EventDetail({ id }: { id: string }) {
  const { api } = useApp();
  const { t } = useI18n();
  const errText = useErrorText();
  const [ev, setEv] = useState<EventDetailView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    api.events.get(id, ac.signal).then(
      (d) => !ac.signal.aborted && setEv(d),
      (e) => {
        if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setError(e);
      },
    );
    return () => ac.abort();
  }, [api, id, n]);

  if (error) {
    const notFound = error instanceof ApiError && (error.status === 404 || error.code === "EVENT_NOT_FOUND");
    return <DetailProblem notFound={notFound} text={notFound ? t("dt.notfound.p") : errText(error)} onRetry={() => setN((x) => x + 1)} />;
  }
  if (!ev) {
    return (
      <div data-testid="event-loading" aria-busy="true">
        <div className="media fb dt-cover dt-sk" />
        <div className="empty">
          <Spinner />
        </div>
      </div>
    );
  }
  return <DetailBody ev={ev} />;
}

function DetailProblem({ notFound, text, onRetry }: { notFound: boolean; text: string; onRetry: () => void }) {
  const { t } = useI18n();
  const { navigate } = useApp();
  return (
    <div data-testid={notFound ? "event-notfound" : "event-error"}>
      <Empty icon={notFound ? "search" : "alert"} title={notFound ? t("dt.notfound.h") : t("ct.err.h")} text={text}>
        {!notFound && (
          <button className="btn btn-lime" type="button" onClick={onRetry}>
            <Icon name="refresh" size={16} />
            {t("common.retry")}
          </button>
        )}
        <button className="btn btn-soft" type="button" onClick={() => navigate({ type: "tab", tab: "catalog" })}>
          {t("dt.toCatalog")}
        </button>
      </Empty>
    </div>
  );
}

/** Statuses that cannot be watched any more (nothing will change). */
const UNWATCHABLE: ReadonlySet<EventLifecycleStatus> = new Set(["CANCELLED", "COMPLETED"]);

function DetailBody({ ev }: { ev: EventDetailView }) {
  const { navigate } = useApp();
  const ref = useWatchRef(ev.event_id, ev.watch);
  const watching = ref && ref.status !== "ended" ? ref : null;
  const wa = useWatchAction();
  const reaction = useReaction(ev.event_id, ev.reaction);
  useAskAiButton(ev);
  const canWatch = !!watching || (ev.is_past !== true && !UNWATCHABLE.has(ev.lifecycle.status));
  const { t, lang } = useI18n();
  const typeLabel = useTypeLabel();
  const dates = formatEventDates(ev.start, ev.end, lang);
  const time = formatEventTime(ev.start, lang);
  const when = [dates, time].filter(Boolean).join(", ");
  const format = ev.online ? t("ev.online") : t("ev.offline");
  const place = ev.venue ? ev.venue.name : t("ev.online");
  const official = /^https:\/\//i.test(ev.official_url) ? ev.official_url : "";
  const officialDomain = hostOf(official);
  // fix 5.1: a past event sells nothing, whatever the source's status says — no «Купить билеты»
  const selling = SELLING.has(ev.lifecycle.status) && ev.is_past !== true;
  const basis = lifecycleBasis(ev.lifecycle.basis);
  const m = ev.media;
  const provider = ev.sources[0]?.provider ?? m?.provenance.provider ?? ev.price_range?.source.provider;
  const pr = ev.price_range;
  const min = pr ? formatMoney(pr.min, pr.currency, lang) : "";
  const max = pr ? formatMoney(pr.max, pr.currency, lang) : "";

  const share = () => {
    haptic.impact("light");
    shareToTelegram(eventStartLink(env.botUsername, env.miniAppShortName, ev.event_id), t("dt.share.text", { t: ev.title }));
  };
  const support = () =>
    navigate({
      type: "push",
      route: {
        name: "supportNew",
        ctx: {
          event_id: ev.event_id,
          ...(provider ? { provider_id: provider.slice(0, 128) } : {}),
          ...(official ? { deeplink: official } : {}),
          event_title: ev.title.slice(0, 300),
        },
      },
    });

  return (
    <div className="dt" data-testid="event-detail">
      <EventMediaView event={ev} className="dt-cover" chip="none" big>
        {(fallback) => (
          <>
            <div className="dt-provline">
              {fallback || !m ? (
                <span className="prov fb" data-testid="prov-chip" title={t("media.fbHint")}>
                  {t("media.fb")}
                </span>
              ) : (
                <span className="prov" data-testid="prov-chip" data-rights={m.provenance.rights}>
                  {m.provenance.rights === "official_site"
                    ? t("dt.banner.site", { d: provenanceDomain(m.provenance), at: formatFetched(m.provenance.fetched_at, lang) })
                    : t("dt.banner", { d: provenanceDomain(m.provenance), p: sourceLabel(m.provenance.provider, m.provenance.source_url), at: formatFetched(m.provenance.fetched_at, lang) })}
                </span>
              )}
            </div>
            <div className="dt-in">
              <LifecycleBadge status={ev.lifecycle.status} past={ev.is_past === true} />
              <h1>{ev.title}</h1>
              <span className="meta">{[place, dates, format].filter(Boolean).join(" · ")}</span>
            </div>
          </>
        )}
      </EventMediaView>

      <div className={[official ? "dt-actions has-cta" : "dt-actions", canWatch ? "has-watch" : ""].filter(Boolean).join(" ")}>
        {official && (
          <button
            className="btn btn-lime dt-cta"
            type="button"
            data-testid="dt-official"
            data-kind={selling ? "buy" : "more"}
            aria-label={officialDomain ? t(selling ? "dt.cta.buy.a11y" : "dt.cta.more.a11y", { d: officialDomain }) : undefined}
            title={officialDomain || undefined}
            onClick={() => openExternal(official)}
          >
            <span>{t(selling ? "dt.cta.buy" : "dt.cta.more")}</span>
            <Icon name="ext" size={18} />
          </button>
        )}
        {canWatch && (
          <button
            className={[official ? "btn dt-watch" : "dt-act dt-watch", watching ? "on" : ""].filter(Boolean).join(" ")}
            type="button"
            data-testid="dt-watch"
            data-state={watching ? watching.status : "none"}
            aria-label={t(watching ? "w.btn.a11yOpen" : "w.btn.a11yOn", { e: ev.title })}
            aria-busy={wa.busy === ev.event_id || undefined}
            onClick={() => void wa.act(ev.event_id, watching)}
          >
            {wa.busy === ev.event_id ? <Spinner small /> : <Icon name={watching ? "check" : "radar"} size={18} />}
            <span>{watching ? (watching.status === "paused" ? t("w.btn.paused") : t("w.btn.watching")) : t("w.btn.watch")}</span>
          </button>
        )}
        <button className={official ? "dt-act ico" : "dt-act"} type="button" onClick={share} aria-label={official ? t("dt.share") : undefined} title={official ? t("dt.share") : undefined}>
          <Icon name="share" size={20} />
          {!official && t("dt.share")}
        </button>
      </div>

      {reaction.rx === "less" ? <NotInterested r={reaction} /> : ev.recommendation && <WhyBlock rec={ev.recommendation} reaction={reaction} />}

      <section className="sec">
        <div className="panel">
          <dl className="kv dt-kv">
            <dt>{t("dt.when")}</dt>
            <dd>
              {when}
              {time && ev.start.timezone && <small className="hint"> · {t("dt.timeLocal", { tz: ev.start.timezone })}</small>}
            </dd>
            <dt>{t("dt.where")}</dt>
            <dd>
              {ev.venue
                ? [ev.venue.name, ev.venue.address, ev.venue.city, ev.venue.country_code ? countryName(ev.venue.country_code, lang) : ""].filter(Boolean).join(", ")
                : t("ev.online")}
            </dd>
            <dt>{t("f.cat")}</dt>
            <dd>{typeLabel(ev.categories)}</dd>
          </dl>
        </div>
      </section>

      <TripBoundary key={ev.event_id}>
        <TripBlock ev={ev} />
      </TripBoundary>

      <section className="sec" data-testid="dt-sources">
        <div className="sec-h">
          <h2>{t("dt.src")}</h2>
        </div>
        <div className="panel">
          <div className="src">
            {ev.sources.map((s) => (
              <div className="src-r" key={`${s.provider}-${s.url}`} data-testid="dt-src" data-provider={s.provider}>
                <span className="ok">
                  <Icon name="check" size={14} />
                </span>
                <div>
                  <b>{t(`dt.tier.${s.tier satisfies SourceTier}` as MessageKey)}</b>
                  <small data-testid="dt-src-meta">{t("dt.src.meta", { p: sourceLine(s), at: formatFetched(s.fetched_at, lang) })}</small>
                </div>
                {/^https:\/\//i.test(s.url) && (
                  <button className="src-go" type="button" data-testid="dt-src-link" aria-label={t("dt.src.open", { d: hostOf(s.url) || sourceLabel(s.provider, s.url, s.name) })} onClick={() => openExternal(s.url)}>
                    <Icon name="ext" size={16} />
                  </button>
                )}
              </div>
            ))}
            <div className="src-r">
              <span className="ok q">
                <Icon name="star" size={14} />
              </span>
              <div>
                <b>{t("dt.src.q", { n: ev.quality_score })}</b>
                <small>{t("dt.src.qSub")}</small>
              </div>
            </div>
          </div>
          <div className="src-a">
            {ev.venue && (
              <button className="ext" type="button" onClick={() => openExternal(ev.venue!.map_url)} data-testid="dt-map">
                <Icon name="pin" size={14} />
                {t("dt.src.map")}
                <Icon name="ext" size={14} />
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="sec" data-testid="dt-life">
        <div className="sec-h">
          <h2>{t("dt.life")}</h2>
        </div>
        <ol className="life">
          {ev.lifecycle_track.map((s) => {
            const cls = s.current ? (SIDE.has(s.status) ? "lf cur side" : "lf cur") : s.reached ? "lf done" : "lf";
            return (
              <li key={s.status} className={cls} aria-current={s.current ? "step" : undefined}>
                <i>{s.reached && !s.current && <Icon name="check" size={11} />}</i>
                <span>{t(`life.${s.status}` as MessageKey)}</span>
              </li>
            );
          })}
        </ol>
        <p className="life-basis" data-testid="life-basis" title={ev.lifecycle.basis.source_url ?? undefined}>
          <Icon name="shield" size={14} />
          {t(basis.key, { p: basis.p || t("dt.life.system"), t: relativeTime(ev.lifecycle.basis.observed_at, lang) })}
        </p>
        {ev.is_past === true && SELLING.has(ev.lifecycle.status) && (
          // the source still sells a past event (its status lags): say so next to its status, not instead of it
          <p className="life-basis" data-testid="life-past">
            <Icon name="info" size={14} />
            {t("dt.life.past")}
          </p>
        )}
      </section>

      <section className="sec" data-testid="dt-price">
        <div className="sec-h">
          <h2>{t("dt.price")}</h2>
        </div>
        <div className="panel dt-price">
          {pr && min ? (
            <>
              <div className="dt-price-v">
                <b className="num">{pr.min === pr.max ? min : t("dt.price.range", { min, max })}</b>
                <span className="kind k-fact">{t("dt.fact")}</span>
              </div>
              <p className="hint">{t("dt.price.meta", { s: sourceLabel(pr.source.provider, pr.source.url), t: relativeTime(pr.fetched_at, lang) })}</p>
            </>
          ) : (
            <p className="hint">{t("dt.price.none")}</p>
          )}
        </div>
        <p className="disc dt-disc">{t("dt.disc")}</p>
        <button className="dt-sup" type="button" onClick={support} data-testid="dt-support">
          <Icon name="help" size={18} />
          <span>{t("dt.sup")}</span>
          <Icon name="chevR" size={16} />
        </button>
      </section>
      <div className="scr-end" />
      {wa.sheet}
    </div>
  );
}
