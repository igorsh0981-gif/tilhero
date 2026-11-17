import type { EventCard as EventCardData, EventLifecycleStatus, EventPriceRange } from "@tilhero/contracts/bff";
import { useEffect, useState, type ReactNode } from "react";
import { KNOWN_TOP, LIFECYCLE_TONE, localCountryName, topCategory } from "../events/catalog";
import { formatEventDates, formatFetched, formatMoney, provenanceChipKey, provenanceDomain, sourceLabel } from "../events/format";
import { useI18n, type Lang, type MessageKey } from "../i18n";
import { Icon, type IconName } from "./Icon";
import { Badge } from "./kit";

/**
 * EventCard (ТЗ §7, sprint 3): media from the source + provenance chip — or a neutral category fallback with
 * «Нет баннера у источника» (never an invented banner, AT-25); type · place · dates; title (2 lines);
 * lifecycle badge; ticket price range as a provider fact; «Подробнее». Sprint 6: the score badge («96% для вас»,
 * «Лучшее для вас» only) and the Watch icon (filled when watched).
 */
export type CardVariant = "large" | "compact" | "list" | "grid";

export const CAT_ICON: Record<string, IconName> = {
  music: "music",
  sport: "flag",
  business: "cpu",
  culture: "palette",
  education: "doc",
  festivals: "star",
  online: "monitor",
  other: "ticket",
};

export function fallbackKind(categories: readonly string[], online: boolean): string {
  if (online) return "online";
  const top = topCategory(categories);
  return (KNOWN_TOP as readonly string[]).includes(top) ? top : "other";
}

/** Localised country name from ISO-2: CIS countries of the AI sources from the dictionaries, the rest via Intl. */
export function countryName(code: string, lang: Lang): string {
  const local = localCountryName(code, lang);
  if (local) return local;
  try {
    return new Intl.DisplayNames([lang === "ru" ? "ru-RU" : "en-GB"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** Card place: «Online», the city, or the country when the source gave no city (full address — on the detail). */
export function placeOf(e: Pick<EventCardData, "online" | "venue">, lang: Lang, onlineLabel: string): string {
  if (e.online || !e.venue) return onlineLabel;
  return e.venue.city || (e.venue.country_code ? countryName(e.venue.country_code, lang) : "");
}

/**
 * Lifecycle status of an event. Fix 5.1: a past event (is_past — its last day is behind in the event's own time zone)
 * says «Событие прошло» in a neutral tone instead of a sales status that the source has not closed yet.
 */
export function LifecycleBadge({ status, past = false }: { status: EventLifecycleStatus; past?: boolean }) {
  const { t } = useI18n();
  if (past) {
    return (
      <Badge>
        <span data-testid="lifecycle" data-past="true">
          {t("ev.past")}
        </span>
      </Badge>
    );
  }
  return (
    <Badge tone={LIFECYCLE_TONE[status]}>
      <span data-testid="lifecycle">{t(`life.${status}` as MessageKey)}</span>
    </Badge>
  );
}

/**
 * Media of an event: the source image with its provenance, or the neutral fallback when the source gave no banner
 * (media=null) or the image failed to load. `chip`: full «Медиа: domain» (provider media) / «Фото: domain» (photo
 * from an official site, rights official_site — sprint 4), short «domain», none (detail cover).
 */
export function EventMediaView(props: {
  event: Pick<EventCardData, "media" | "categories" | "online">;
  className?: string;
  chip?: "full" | "short" | "none";
  big?: boolean;
  /** overlay content; a function gets `fallback` (true when the neutral fallback is shown) */
  children?: ReactNode | ((fallback: boolean) => ReactNode);
}) {
  const { event, className = "", chip = "full", big } = props;
  const overlay = (fb: boolean) => (typeof props.children === "function" ? props.children(fb) : props.children);
  const { t, lang } = useI18n();
  const m = event.media;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [m?.url]);

  if (!m || failed) {
    const kind = fallbackKind(event.categories, event.online);
    return (
      <div className={`media fb ${className}`.trim()} data-cat={kind} data-testid="media-fallback" title={t("media.fbHint")}>
        <span className="fb-pat" aria-hidden="true" />
        <span className="fb-ic">
          <Icon name={CAT_ICON[kind] ?? "ticket"} size={big ? 56 : 40} />
        </span>
        {overlay(true)}
        {chip !== "none" && (
          <div className="ec-prov">
            <span className="prov fb" data-testid="prov-chip" title={t("media.fb")}>
              {chip === "short" ? t("media.fbShort") : t("media.fb")}
            </span>
          </div>
        )}
      </div>
    );
  }
  const domain = provenanceDomain(m.provenance);
  const fetched = formatFetched(m.provenance.fetched_at, lang);
  const hint =
    m.provenance.rights === "official_site"
      ? t("media.siteHint", { d: domain, at: fetched })
      : t("media.srcHint", { p: sourceLabel(m.provenance.provider, m.provenance.source_url), at: fetched });
  return (
    <div className={`media ${className}`.trim()} data-testid="media-source">
      <img
        className="art"
        src={m.url}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        width={m.width ?? undefined}
        height={m.height ?? undefined}
        onError={() => setFailed(true)}
      />
      {overlay(false)}
      {chip !== "none" && (
        <div className="ec-prov">
          <span className="prov" data-testid="prov-chip" data-rights={m.provenance.rights} title={hint}>
            {chip === "short" ? domain : t(provenanceChipKey(m.provenance.rights), { d: domain })}
          </span>
        </div>
      )}
    </div>
  );
}

/** «Билеты от 120 USD» + provider mark (a fact, TG-FR-029), or «Цена — на сайте источника» when the source gave none (fix 4.1). */
export function PriceLine({ price }: { price: EventPriceRange | null }) {
  const { t, lang } = useI18n();
  const p = price ? formatMoney(price.min, price.currency, lang) : "";
  const src = price ? sourceLabel(price.source.provider, price.source.url) : "";
  if (!price || !p) {
    return (
      <div className="ec-pr" data-testid="price">
        <small>{t("ev.price.none")}</small>
      </div>
    );
  }
  return (
    <div className="ec-pr" data-testid="price">
      <small>{t("ev.price.label")}</small>{" "}
      <b className="num">{t("ev.price.from", { p })}</b>{" "}
      <span className="kind k-fact" data-testid="price-src" title={t("ev.price.src", { s: src, at: formatFetched(price.fetched_at, lang) })}>
        {src}
      </span>
    </div>
  );
}

/** Sprint 6: the Watch icon on a card — outlined, filled when the event is watched (tap → create / open the sheet). */
export interface CardWatch {
  on: boolean;
  paused?: boolean;
  busy?: boolean;
  onTap: () => void;
}

export function EventCardView(props: {
  event: EventCardData;
  variant: CardVariant;
  typeLabel: string;
  onOpen: (id: string) => void;
  /** «Лучшее для вас»: recommendation score 0..100 as «96% для вас» */
  score?: number | null;
  watch?: CardWatch | null;
}) {
  const { event: e, variant, typeLabel, onOpen, score, watch } = props;
  const { t, lang } = useI18n();
  const cls = { large: "ec", compact: "ec cmp", list: "ec row", grid: "ec mini" }[variant];
  const place = placeOf(e, lang, t("ev.online"));
  const dates = formatEventDates(e.start, e.end, lang);
  const open = () => onOpen(e.event_id);
  return (
    <article
      className={cls}
      data-testid="event-card"
      data-event-id={e.event_id}
      // the whole card is a tap target on touch; keyboard and screen readers use the «Подробнее» button
      onClick={(ev) => {
        if ((ev.target as HTMLElement).closest("button, a")) return;
        open();
      }}
    >
      <EventMediaView event={e} className="ec-m" chip={variant === "list" || variant === "grid" ? "short" : "full"}>
        {(score != null || watch) && (
          <div className="ec-top">
            {score != null ? (
              <span className="match" data-testid="card-score">
                {t("home.score", { n: score })}
              </span>
            ) : (
              <span />
            )}
            {watch && (
              <button
                className={watch.on ? "ec-watch on" : "ec-watch"}
                type="button"
                data-testid="card-watch"
                data-on={watch.on}
                aria-pressed={watch.on}
                aria-busy={watch.busy || undefined}
                aria-label={t(watch.on ? "w.btn.a11yOpen" : "w.btn.a11yOn", { e: e.title })}
                onClick={(ev) => {
                  ev.stopPropagation();
                  watch.onTap();
                }}
              >
                <Icon name={watch.on ? (watch.paused ? "pause" : "radar") : "radar"} size={18} />
              </button>
            )}
          </div>
        )}
      </EventMediaView>
      <div className="ec-b">
        <div className="ec-meta">
          <span>
            {typeLabel} · {place}
          </span>
          {dates && <span className="d">{dates}</span>}
        </div>
        <h3 className="ec-t">{e.title}</h3>
        <div className="ec-life">
          <LifecycleBadge status={e.lifecycle.status} past={e.is_past === true} />
        </div>
        <PriceLine price={e.price_range} />
        <div className="ec-act one">
          <button className={variant === "large" || variant === "list" ? "btn btn-sm btn-ink" : "btn btn-sm btn-soft"} type="button" onClick={open} aria-label={t("ev.open", { t: e.title })}>
            {t("ev.more")}
          </button>
        </div>
      </div>
    </article>
  );
}
