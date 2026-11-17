import type { Airport, GeoOption, InterestCategory } from "@tilhero/contracts/bff";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Api } from "../api/endpoints";
import { useI18n, type Lang } from "../i18n";
import {
  addDeparture,
  addEntity,
  BUDGET_CHIPS,
  budgetState,
  DEFAULT_HOTEL_DISTANCE_KM,
  geoOptionKey,
  HORIZONS,
  HOTEL_DISTANCES_KM,
  HOTEL_RATINGS,
  HOTEL_STARS,
  pickHotel,
  MAX_DEPARTURES,
  REMIND_POINTS,
  removeDeparture,
  sanitizeAmountInput,
  setHorizon,
  toggleBudget,
  toggleGeo,
  toggleRemind,
  type FormatChoice,
  type PrefDraft,
} from "../state/prefs";
import { haptic } from "../tg";
import { Icon } from "./Icon";
import { Chip, Seg, ToggleRow } from "./kit";

/**
 * Preference controls shared by onboarding steps and profile editors (TG-FR-018):
 * the same component, the same validation, the same copy.
 */
type Setter = (fn: (d: PrefDraft) => PrefDraft) => void;
interface Ctl {
  d: PrefDraft;
  set: Setter;
}

/** Keeps tags to two rows and shows "+N" for the rest (prototype m-12). */
function useFitTags(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || !box.closest(".ob")) return;
    const kids = Array.from(box.querySelectorAll<HTMLElement>(".tag:not(.tag-more)"));
    box.querySelector(".tag-more")?.remove();
    kids.forEach((k) => (k.hidden = false));
    if (kids.length < 2) return;
    const tops = [...new Set(kids.map((k) => k.offsetTop))].sort((a, b) => a - b);
    if (tops.length <= 2) return;
    const limit = tops[1]!;
    const more = document.createElement("span");
    more.className = "tag tag-more";
    more.setAttribute("aria-hidden", "true");
    const hide = () => kids.filter((k) => k.offsetTop > limit && !k.hidden).forEach((k) => (k.hidden = true));
    hide();
    box.appendChild(more);
    const vis = kids.filter((k) => !k.hidden);
    const upd = () => (more.textContent = `+${kids.filter((k) => k.hidden).length}`);
    upd();
    while (more.offsetTop > limit && vis.length) {
      vis.pop()!.hidden = true;
      upd();
    }
  }, [dep]);
  return ref;
}

/* ---------- interests ---------- */
export function InterestsControl({ d, set, items, max, onMore }: Ctl & { items: InterestCategory[] | null; max?: number; onMore?: () => void }) {
  const { t, l } = useI18n();
  if (!items) {
    return (
      <div className="ob-grid" aria-busy="true">
        {Array.from({ length: max ?? 12 }, (_, i) => (
          <span key={i} className="chip sk" />
        ))}
      </div>
    );
  }
  const shown = max && items.length > max ? items.slice(0, max - 1) : items;
  const hidden = items.length - shown.length;
  return (
    <div className="ob-grid" role="group" aria-label={t("pref.interests")}>
      {shown.map((c) => (
        <Chip
          key={c.code}
          pressed={d.interests.includes(c.code)}
          onToggle={() => set((x) => ({ ...x, interests: x.interests.includes(c.code) ? x.interests.filter((k) => k !== c.code) : [...x.interests, c.code] }))}
        >
          {l(c.label)}
        </Chip>
      ))}
      {hidden > 0 && (
        <button className="chip" type="button" onClick={onMore} aria-pressed={items.slice(shown.length).some((c) => d.interests.includes(c.code))}>
          {t("ob.more", { n: hidden })}
        </button>
      )}
    </div>
  );
}

const ENTITY_SUGGEST = ["Formula 1", "Coldplay", "Web Summit", "Real Madrid", "Art Basel", "Wimbledon", "Money20/20"];

export function EntitiesControl({ d, set }: Ctl) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const tagsRef = useFitTags(d.entities.join("|"));
  const ql = q.trim().toLowerCase();
  const sug = ENTITY_SUGGEST.filter((s) => !d.entities.includes(s) && (!ql || s.toLowerCase().includes(ql)));
  const custom = q.trim() && !ENTITY_SUGGEST.some((s) => s.toLowerCase() === ql) && !d.entities.some((e) => e.toLowerCase() === ql) ? q.trim() : null;
  const add = (v: string) => {
    haptic.selection();
    set((x) => addEntity(x, v));
    setQ("");
  };
  return (
    <>
      <div className="ent">
        <label className="field-l" htmlFor="entIn">
          {t("pref.ent.label")}
        </label>
        <div className="field">
          <Icon name="search" size={18} />
          <input
            id="entIn"
            autoComplete="off"
            maxLength={40}
            placeholder={t("pref.ent.ph")}
            value={q}
            onChange={(e) => setQ(e.target.value.slice(0, 40))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && q.trim()) {
                e.preventDefault();
                add(q);
              }
            }}
          />
        </div>
        <div className="ent-sug">
          {custom && (
            <button type="button" onClick={() => add(custom)}>
              <Icon name="plus" size={14} />
              {t("pref.ent.add", { q: custom })}
            </button>
          )}
          {sug.map((s) => (
            <button key={s} type="button" onClick={() => add(s)}>
              <Icon name="plus" size={14} />
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="tags" ref={tagsRef}>
        {d.entities.length ? (
          d.entities.map((e) => (
            <span className="tag" key={e}>
              <span>{e}</span>
              <button className="x" type="button" aria-label={t("a11y.remove", { name: e })} onClick={() => set((x) => ({ ...x, entities: x.entities.filter((v) => v !== e) }))}>
                <Icon name="x" size={14} />
              </button>
            </span>
          ))
        ) : (
          <span className="tags-empty">{t("pref.ent.none")}</span>
        )}
      </div>
    </>
  );
}

/* ---------- geography + format ---------- */
/** Compact geography chips: world and regions, then selected countries, then popular ones — at most max
 * (the last slot is "More N"). Everything else lives in the searchable all-countries sheet (onMore). */
export function compactGeo(items: GeoOption[], selected: string[], max: number): { shown: GeoOption[]; hidden: number } {
  if (items.length <= max) return { shown: items, hidden: 0 };
  const isBase = (g: GeoOption) => g.level === "world" || g.level === "region";
  const picked = items.filter((g) => !isBase(g) && selected.includes(geoOptionKey(g)));
  const rest = items.filter((g) => !isBase(g) && !selected.includes(geoOptionKey(g)));
  const shown = [...items.filter(isBase), ...picked, ...rest].slice(0, Math.max(max - 1, items.filter(isBase).length + picked.length));
  return { shown, hidden: items.length - shown.length };
}

export function GeoControl({ d, set, items, max, onMore }: Ctl & { items: GeoOption[] | null; max?: number; onMore?: () => void }) {
  const { t, l } = useI18n();
  const { shown, hidden } = items && max ? compactGeo(items, d.geo, max) : { shown: items ?? [], hidden: 0 };
  return (
    <>
      {items ? (
        <div className="ob-grid" role="group" aria-label={t("pref.geo")}>
          {shown.map((g) => {
            const key = geoOptionKey(g);
            return (
              <Chip key={key} pressed={d.geo.includes(key)} onToggle={() => set((x) => toggleGeo(x, key))}>
                {l(g.label)}
              </Chip>
            );
          })}
          {hidden > 0 && (
            <button className="chip" type="button" onClick={onMore} data-testid="geo-more">
              {t("ob.more", { n: hidden })}
            </button>
          )}
        </div>
      ) : (
        <div className="ob-grid" aria-busy="true">
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} className="chip sk" />
          ))}
        </div>
      )}
      <div className="ob-tg">
        <ToggleRow title={t("pref.geo.strong")} sub={t("pref.geo.strongSub")} on={d.strong} onChange={(v) => set((x) => ({ ...x, strong: v }))} />
      </div>
    </>
  );
}

export function FormatControl({ d, set }: Ctl) {
  const { t } = useI18n();
  const opts: Array<{ value: FormatChoice; label: string }> = [
    { value: "offline", label: t("pref.fmt.offline") },
    { value: "online", label: t("pref.fmt.online") },
    { value: "both", label: t("pref.fmt.both") },
  ];
  return (
    <div>
      <div className="ob-lbl mb6">{t("pref.format")}</div>
      <Seg value={d.format} options={opts} onChange={(v) => set((x) => ({ ...x, format: v }))} label={t("pref.format")} />
    </div>
  );
}

/* ---------- budget: $ is a fixed prefix, the field accepts digits only ---------- */
export function BudgetControl({ d, set }: Ctl) {
  const { t } = useI18n();
  const custom = d.budget.includes("custom");
  const st = budgetState(d);
  const inputRef = useRef<HTMLInputElement>(null);
  const bad = custom && (st === "need" || st === "min" || st === "max");
  useEffect(() => {
    if (custom && !d.custom) inputRef.current?.focus({ preventScroll: true });
    // focus only when «Свой» is switched on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custom]);
  return (
    <div>
      <div className="ob-lbl mb6">{t("pref.budget")}</div>
      <div className="ob-grid" role="group" aria-label={t("pref.budget")}>
        {BUDGET_CHIPS.map((c) => (
          <Chip key={c} pressed={d.budget.includes(c)} onToggle={() => set((x) => toggleBudget(x, c))}>
            {t(`pref.b.${c}`)}
          </Chip>
        ))}
        <Chip pressed={custom} onToggle={() => set((x) => toggleBudget(x, "custom"))}>
          {t("pref.b.custom")}
        </Chip>
      </div>
      {custom && (
        <>
          <div className={bad ? "field money mt8 bad" : "field money mt8"}>
            <span className="money-pfx" aria-hidden="true">
              $
            </span>
            <input
              ref={inputRef}
              id="budgetCustom"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoComplete="off"
              aria-label={t("pref.budget.ph")}
              aria-describedby="budgetHint"
              aria-invalid={bad || undefined}
              placeholder={t("pref.budget.ph")}
              value={d.custom}
              onChange={(e) => {
                const v = sanitizeAmountInput(e.target.value);
                set((x) => ({ ...x, custom: v }));
              }}
            />
          </div>
          <div className={bad ? "hint bad mt4" : "hint mt4"} id="budgetHint" aria-live="polite">
            {st === "need" ? t("pref.budget.need") : st === "min" ? t("pref.budget.min") : st === "max" ? t("pref.budget.max") : t("pref.budget.hint")}
          </div>
        </>
      )}
    </div>
  );
}

export function HorizonControl({ d, set }: Ctl) {
  const { t } = useI18n();
  return (
    <div>
      <div className="ob-lbl mb6">{t("pref.horizon")}</div>
      <Seg value={d.horizon} options={HORIZONS.map((n) => ({ value: n, label: t("pref.h.n", { n }) }))} onChange={(v) => set((x) => setHorizon(x, v))} label={t("pref.horizon")} />
    </div>
  );
}

export function RemindControl({ d, set }: Ctl) {
  const { t } = useI18n();
  return (
    <div>
      <div className="ob-lbl mb6">
        <span>{t("pref.remind")}</span>
        <small>{t("pref.remind.sub")}</small>
      </div>
      <div className="ob-grid c4" role="group" aria-label={t("pref.remind")}>
        {REMIND_POINTS.map((n) => (
          <Chip key={n} pressed={d.remind.includes(n)} disabled={n > d.horizon} title={n > d.horizon ? t("pref.remind.over") : undefined} onToggle={() => set((x) => toggleRemind(x, n))}>
            {t("pref.r.n", { n })}
          </Chip>
        ))}
      </div>
    </div>
  );
}

/* ---------- departures: starts empty (BR-TG-004), local scroll only inside the directory ----------
   Onboarding (no-scroll step): the list takes what is left of the step. Profile sheet (fix 5.1): chosen cities and
   the search are pinned on top, the list takes the rest of a fixed-height sheet and scrolls inside. */
export function DeparturesControl({ d, set, api, sheet }: Ctl & { api: Api; sheet?: boolean }) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Airport[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const tagsRef = useFitTags(d.deps.map((x) => x.airport_iata).join("|"));

  useEffect(() => {
    const ctrl = new AbortController();
    const query = q.trim();
    const timer = setTimeout(
      () => {
        setLoading(true);
        setFailed(false);
        api.directory
          .airports(query, ctrl.signal)
          .then((r) => {
            setItems(r.items);
            if (listRef.current) listRef.current.scrollTop = 0;
          })
          .catch((e) => {
            if (!(e instanceof DOMException)) setFailed(true);
          })
          .finally(() => setLoading(false));
      },
      query ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, api, tick]);

  const full = d.deps.length >= MAX_DEPARTURES;
  let list: ReactNode;
  if (failed) {
    list = (
      <li className="dir-empty">
        {t("ob.dirErr")}{" "}
        <button className="lnk" type="button" onClick={() => setTick((n) => n + 1)}>
          {t("common.retry")}
        </button>
      </li>
    );
  } else if (!items) {
    list = <li className="dir-empty">{t("pref.dep.searching")}</li>;
  } else if (!items.length) {
    list = <li className="dir-empty">{t("pref.dep.none", { q: q.trim() })}</li>;
  } else {
    list = items.map((a) => {
      const on = d.deps.some((x) => x.airport_iata === a.iata);
      return (
        <li key={a.iata}>
          <button
            className="dir-r"
            type="button"
            aria-pressed={on}
            disabled={!on && full}
            aria-label={on ? t("pref.dep.del", { c: a.city }) : t("pref.dep.add", { c: a.city })}
            onClick={() => {
              haptic.selection();
              set((x) => (on ? removeDeparture(x, a.iata) : addDeparture(x, { airport_iata: a.iata, city: a.city, country_code: a.country_code })));
            }}
          >
            <span className="mono">{a.iata}</span>
            <span className="nm">
              {a.city}
              <small>{a.country}</small>
            </span>
            <i className="add">
              <Icon name={on ? "check" : "plus"} size={16} />
            </i>
          </button>
        </li>
      );
    });
  }

  return (
    <>
      <div>
        <div className="ob-lbl mb6">
          {/* in the sheet the title already says «Города вылета» */}
          <span>{t(sheet ? "pref.dep.yours" : "pref.dep.selected")}</span>
          <small id="depCnt">{full ? t("pref.dep.max") : d.deps.length ? t("ob.picked", { n: d.deps.length }) : ""}</small>
        </div>
        {/* in the sheet: one row that scrolls sideways (every chosen city stays reachable, the list keeps the height) */}
        <div className={sheet ? "tags tags-row" : "tags"} ref={tagsRef} id="depTags">
          {d.deps.length ? (
            d.deps.map((x) => (
              <span className="tag" key={x.airport_iata}>
                <span>
                  {x.city} <span className="mono">{x.airport_iata}</span>
                </span>
                <button className="x" type="button" aria-label={t("pref.dep.del", { c: x.city })} onClick={() => set((v) => removeDeparture(v, x.airport_iata))}>
                  <Icon name="x" size={14} />
                </button>
              </span>
            ))
          ) : (
            <span className="tags-empty">{t("pref.dep.empty")}</span>
          )}
        </div>
      </div>
      <div className="field">
        <Icon name="search" size={18} />
        <input
          id="depIn"
          autoComplete="off"
          maxLength={30}
          placeholder={t("pref.dep.search")}
          aria-label={t("pref.dep.search")}
          aria-controls="dirList"
          value={q}
          onChange={(e) => setQ(e.target.value.slice(0, 30))}
        />
        {loading && <span className="spin sm" aria-hidden="true" />}
      </div>
      <ul className={sheet ? "dir dir-sheet" : "dir"} id="dirList" ref={listRef} aria-label={t("pref.dep.search")} data-testid="airport-list">
        {list}
      </ul>
    </>
  );
}

export function FlightsControl({ d, set }: Ctl) {
  const { t } = useI18n();
  return (
    <div className="ob-tg">
      <ToggleRow title={t("pref.fl.direct")} sub={t("pref.fl.directSub")} on={d.direct} onChange={(v) => set((x) => ({ ...x, direct: v }))} />
      <ToggleRow title={t("pref.fl.conn")} sub={t("pref.fl.connSub")} on={d.connecting} onChange={(v) => set((x) => ({ ...x, connecting: v }))} />
      <ToggleRow title={t("pref.fl.alt")} sub={t("pref.fl.altSub")} on={d.alt} onChange={(v) => set((x) => ({ ...x, alt: v }))} />
    </div>
  );
}

/* ---------- fix 6.3: hotel settings — guest rating (segments), distance to the venue (chips), stars (chips) ----------
   One picker for the profile («Поездки → Отель») and the trip («Настроить расчёт»): the values shown are the
   effective ones (a null setting shows the default chip as chosen). */

/** 8.5 → «8,5» / «8.5»; 0 → «Любая» / «Any». */
export function hotelRatingLabel(v: number, lang: Lang, any: string): string {
  if (!v) return any;
  return new Intl.NumberFormat(lang === "ru" ? "ru-RU" : "en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);
}

export function HotelPicker(props: {
  rating: number;
  distance: number;
  stars: number;
  defaultRating: number;
  onRating: (v: number) => void;
  onDistance: (v: number) => void;
  onStars: (v: number) => void;
  /** «как в профиле» / «изменено» per control (the trip settings); undefined — the profile editor */
  marks?: Record<"rating" | "distance" | "stars", { text: string; changed: boolean }>;
  idPrefix: string;
}) {
  const { t, lang } = useI18n();
  const { rating, distance, stars, defaultRating, marks, idPrefix } = props;
  const lbl = (key: "rating" | "distance" | "stars", title: string, sub: string) => (
    <div className="ob-lbl mb6" id={`${idPrefix}-${key}`}>
      <span>{title}</span>
      <small data-changed={marks ? marks[key].changed : undefined} data-testid={marks ? `hotel-mark-${key}` : undefined}>
        {marks ? marks[key].text : sub}
      </small>
    </div>
  );
  return (
    <div className="hotel-pick" data-testid="hotel-pick">
      <div>
        {lbl("rating", t("pref.ht.rating"), t("pref.ht.ratingSub"))}
        <Seg
          className="hotel-seg"
          value={rating}
          label={t("pref.ht.rating")}
          options={HOTEL_RATINGS.map((v) => ({ value: v, label: hotelRatingLabel(v, lang, t("pref.ht.any")) }))}
          onChange={props.onRating}
        />
        <p className="hint mt4" data-testid="hotel-rating-hint">
          {rating ? t("pref.ht.ratingHint", { r: hotelRatingLabel(rating, lang, "") }) : t("pref.ht.ratingAny")}
          {rating === defaultRating ? ` ${t("pref.ht.byDefault")}` : ""}
        </p>
      </div>
      <div className="mt16">
        {lbl("distance", t("pref.ht.dist"), t("pref.ht.distSub"))}
        <div className="ob-grid c5" role="radiogroup" aria-labelledby={`${idPrefix}-distance`}>
          {HOTEL_DISTANCES_KM.map((v) => (
            <Chip key={v} role="radio" pressed={distance === v} onToggle={() => distance !== v && props.onDistance(v)} testId={`hotel-dist-${v}`}>
              {t("tr.dist.km", { n: v })}
            </Chip>
          ))}
        </div>
        <p className="hint mt4">
          {t("pref.ht.distHint", { km: t("tr.dist.km", { n: distance }) })}
          {distance === DEFAULT_HOTEL_DISTANCE_KM ? ` ${t("pref.ht.byDefault")}` : ""}
        </p>
      </div>
      <div className="mt16">
        {lbl("stars", t("pref.ht.stars"), t("pref.ht.starsSub"))}
        <div className="ob-grid c4" role="radiogroup" aria-labelledby={`${idPrefix}-stars`}>
          {HOTEL_STARS.map((v) => (
            <Chip key={v} role="radio" pressed={stars === v} onToggle={() => stars !== v && props.onStars(v)} testId={`hotel-stars-${v}`}>
              {v ? t("pref.ht.starsN", { n: v }) : t("pref.ht.anyStars")}
            </Chip>
          ))}
        </div>
      </div>
      <div className="note mt16">
        <Icon name="info" size={16} />
        <span>{t("pref.ht.widen")}</span>
      </div>
    </div>
  );
}

export function HotelControl({ d, set, defaultRating }: Ctl & { defaultRating: number }) {
  return (
    <HotelPicker
      idPrefix="pref-hotel"
      rating={d.hotelRating ?? defaultRating}
      distance={d.hotelDistance ?? DEFAULT_HOTEL_DISTANCE_KM}
      stars={d.hotelStars ?? 0}
      defaultRating={defaultRating}
      onRating={(v) => set((x) => pickHotel(x, "rating", v, defaultRating))}
      onDistance={(v) => set((x) => pickHotel(x, "distance", v, defaultRating))}
      onStars={(v) => set((x) => pickHotel(x, "stars", v, defaultRating))}
    />
  );
}
