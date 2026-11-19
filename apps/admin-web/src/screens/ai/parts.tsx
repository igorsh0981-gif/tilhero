/**
 * Shared pieces of the sprint 4 sections: the «AI is off» banner, money, the character counter of big text fields,
 * the budget bar (value + text + marker of the alert threshold — never colour alone), the progress bar of a test
 * run, the line diff view and a small accessible SVG bar chart (title, axis labels, focusable bars with a tooltip and
 * a table view).
 */
import { useId, useMemo, useState, type ReactNode } from "react";
import { useI18n, type MessageKey } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { Btn, Callout, cx } from "../../ui/kit";
import { useAiEnabled } from "./aiState";
import { budgetLevel, collapseDiff, diffStats, lineDiff, niceMax, usd, type DiffRow } from "./model";

/** dictionary key built at runtime: the key if the dictionary has it, else the raw value (unknown codes stay readable) */
export function useKeyed() {
  const { t } = useI18n();
  return (prefix: string, v: string | null | undefined, fallback = "—") => {
    if (v == null || v === "") return fallback;
    const k = `${prefix}.${v}` as MessageKey;
    const s = t(k);
    return s === k ? v : s;
  };
}

export function useUsd() {
  const { fmt } = useI18n();
  return (n: number | null | undefined) => usd(n, fmt.locale);
}

/** «ИИ выключен — уроки идут в упрощённом режиме» on «Агенты», «Контроль диалогов», «Затраты» (emergency stop). */
export function AiOffBanner() {
  const { t } = useI18n();
  const { can } = useSession();
  const { navigate, route } = useNav();
  const enabled = useAiEnabled();
  if (enabled !== false) return null;
  return (
    <Callout kind="bad" icon="power" testId="ai-off-banner">
      <b>{t("ai.off.t")}</b> {t("ai.off.m")}
      {can("costs.read") && route.page !== "costs" && (
        <span className="block mt-8">
          <Btn size="xs" icon="gauge" label={t("ai.off.open")} onClick={() => navigate("costs")} testId="ai-off-open" />
        </span>
      )}
    </Callout>
  );
}

/** Label + counter «1 234 / 20 000» (aria-live polite only near the limit) for the big text fields. */
export function CharCount({ id, n, max }: { id: string; n: number; max: number }) {
  const { fmt, t } = useI18n();
  const over = n > max;
  const near = n > max * 0.9;
  return (
    <span id={id} className={cx("char-count", near && "is-near", over && "is-over")} aria-live={near ? "polite" : "off"} data-testid={`${id}`}>
      {over && <Icon name="alertCircle" />}
      {t("ag.chars", { n: fmt.num(n), max: fmt.num(max) })}
    </span>
  );
}

/** Spent vs the monthly cap: bar + «$12.40 из $20.00 · 62 %» + marker of the alert threshold. */
export function BudgetBar({ spent, cap, pct, alert, testId, compact }: { spent: number; cap: number; pct: number; alert: number; testId?: string; compact?: boolean }) {
  const { t, fmt } = useI18n();
  const money = useUsd();
  const level = budgetLevel(pct, alert);
  const label = t("bud.barAria", { s: money(spent), c: money(cap), p: fmt.pct(pct), a: alert });
  return (
    <div className={cx("bud", `is-${level}`, compact && "is-compact")} data-testid={testId} data-level={level}>
      <div className="bud-line">
        <span className="bud-v">
          <b>{money(spent)}</b> <span className="muted">{t("bud.of", { c: money(cap) })}</span>
        </span>
        <span className={cx("pill", level === "ok" ? "good" : level === "warn" ? "warn" : "bad")} data-testid={testId ? `${testId}-pct` : undefined}>
          {level !== "ok" && <Icon name="alert" />}
          {fmt.pct(pct)}
        </span>
      </div>
      <div className="bud-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, pct)} aria-label={label}>
        <span className="bud-fill" style={{ width: `${Math.min(100, pct)}%` }} />
        <span className="bud-mark" style={{ left: `${Math.min(100, alert)}%` }} title={t("bud.alertAt", { a: alert })} />
      </div>
      {!compact && (
        <div className="bud-note small">
          {level === "over" ? (
            <span className="bad-ink b">{t("bud.over")}</span>
          ) : level === "warn" ? (
            <span className="warn-ink b">{t("bud.warn", { a: alert })}</span>
          ) : (
            <span className="muted">{t("bud.ok", { a: alert })}</span>
          )}
        </div>
      )}
    </div>
  );
}

export function Progress({ value, max, label, testId }: { value: number; max: number; label: string; testId?: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="prog" data-testid={testId}>
      <div className="prog-track" role="progressbar" aria-valuemin={0} aria-valuemax={max || 100} aria-valuenow={max ? value : undefined} aria-label={label}>
        <span className="prog-fill" style={{ width: `${max ? pct : 30}%` }} />
      </div>
      <span className="small muted">{label}</span>
    </div>
  );
}

/** Unified line diff: «−» removed, «+» added (sign, colour and text for screen readers), unchanged runs collapsed. */
export function DiffView({ before, after, testId, emptyText }: { before: string; after: string; testId?: string; emptyText?: ReactNode }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const d = useMemo(() => lineDiff(before, after), [before, after]);
  const st = diffStats(d);
  const rows: DiffRow[] = all ? d : collapseDiff(d, 2);
  if (!st.added && !st.removed)
    return (
      <p className="small muted" data-testid={testId ? `${testId}-same` : undefined}>
        {emptyText ?? t("ag.diff.same")}
      </p>
    );
  return (
    <div className="ldiff-wrap" data-testid={testId}>
      <div className="row between">
        <span className="small">
          <span className="ldiff-stat add">+{st.added}</span> <span className="ldiff-stat del">−{st.removed}</span>{" "}
          <span className="muted">{t("ag.diff.stat", { a: st.added, r: st.removed })}</span>
        </span>
        <Btn size="xs" kind="ghost" label={all ? t("ag.diff.changes") : t("ag.diff.all")} onClick={() => setAll(!all)} />
      </div>
      <div className="ldiff" role="table" aria-label={t("ag.diff.aria")}>
        {rows.map((r, i) =>
          r.op === "skip" ? (
            <div key={`s${i}`} className="ldiff-row skip" role="row">
              <span role="cell" className="ldiff-skip">
                {t("ag.diff.skip", { n: r.n })}
              </span>
            </div>
          ) : (
            <div key={i} className={cx("ldiff-row", r.op)} role="row" data-op={r.op}>
              <span role="cell" className="ldiff-n" aria-hidden="true">
                {r.a ?? ""}
              </span>
              <span role="cell" className="ldiff-n" aria-hidden="true">
                {r.b ?? ""}
              </span>
              <span role="cell" className="ldiff-sign">
                <span aria-hidden="true">{r.op === "add" ? "+" : r.op === "del" ? "−" : " "}</span>
                {r.op !== "eq" && <span className="sr-only">{t(r.op === "add" ? "ag.diff.added" : "ag.diff.removed")}</span>}
              </span>
              <span role="cell" className="ldiff-t">
                {r.text || " "}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * One-series bar chart (spend per day): thin bars rounded at the data end and anchored to the baseline, recessive
 * grid, axis labels, every bar focusable with a tooltip (hover and keyboard), the max value labelled directly and a
 * table view below. Colour carries no meaning on its own (one series, the title names it).
 */
export function BarChart({ data, title, valueLabel, format, testId }: { data: Array<{ key: string; label: string; value: number; sub?: string }>; title: string; valueLabel: string; format: (n: number) => string; testId?: string }) {
  const { t } = useI18n();
  const id = useId();
  const [hot, setHot] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  // ~1:1 with the card width on a desktop (text stays 11 px), the svg scrolls inside its box on narrow screens
  const W = 1040;
  const H = 230;
  const P = { l: 60, r: 12, t: 22, b: 30 };
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const iw = W - P.l - P.r;
  const ih = H - P.t - P.b;
  const step = data.length ? iw / data.length : iw;
  const bw = Math.max(3, Math.min(20, step * 0.6));
  const y = (v: number) => P.t + ih - (v / max) * ih;
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const top = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? -1) ? i : best), 0);
  const labelEvery = Math.max(1, Math.ceil(data.length / 10));
  const sum = data.reduce((a, d) => a + d.value, 0);
  const h = hot != null ? data[hot] : null;
  return (
    <figure className="chart" data-testid={testId} aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`} className="chart-t">
        {title}
        <span className="small muted"> · {t("chart.total", { v: format(sum), n: data.length })}</span>
      </figcaption>
      {data.length ? (
        <div className="chart-box">
          <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="group" aria-label={title}>
            {ticks.map((v) => (
              <g key={v}>
                <line className="chart-grid" x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} />
                <text className="chart-axis" x={P.l - 8} y={y(v) + 4} textAnchor="end">
                  {format(v)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = P.l + i * step + (step - bw) / 2;
              const yy = y(d.value);
              const hgt = Math.max(0, P.t + ih - yy);
              const r = Math.min(4, bw / 2, hgt);
              const path = hgt > 0 ? `M${x},${P.t + ih} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${P.t + ih} Z` : "";
              return (
                <g
                  key={d.key}
                  className={cx("chart-bar", hot === i && "is-hot")}
                  tabIndex={0}
                  role="img"
                  aria-label={`${d.label}: ${format(d.value)}${d.sub ? `, ${d.sub}` : ""}`}
                  onMouseEnter={() => setHot(i)}
                  onMouseLeave={() => setHot(null)}
                  onFocus={() => setHot(i)}
                  onBlur={() => setHot(null)}
                  data-testid={testId ? `${testId}-bar-${d.key}` : undefined}
                >
                  <rect className="chart-hit" x={P.l + i * step} y={P.t} width={step} height={ih} />
                  {path && <path className="chart-mark" d={path} />}
                  {i % labelEvery === 0 && (
                    <text className="chart-axis" x={x + bw / 2} y={H - P.b + 16} textAnchor="middle">
                      {d.label}
                    </text>
                  )}
                  {i === top && d.value > 0 && (
                    <text className="chart-val" x={x + bw / 2} y={yy - 5} textAnchor="middle">
                      {format(d.value)}
                    </text>
                  )}
                </g>
              );
            })}
            <line className="chart-base" x1={P.l} x2={W - P.r} y1={P.t + ih} y2={P.t + ih} />
          </svg>
          {h && hot != null && (
            <div className="chart-tip" role="status" style={{ left: `${((P.l + hot * step + step / 2) / W) * 100}%` }}>
              <b>{h.label}</b>
              <span>
                {valueLabel}: {format(h.value)}
              </span>
              {h.sub && <span className="muted">{h.sub}</span>}
            </div>
          )}
        </div>
      ) : (
        <p className="small muted">{t("dash.noData")}</p>
      )}
      {data.length > 0 && (
        <div>
          <Btn size="xs" kind="ghost" icon={table ? "eyeOff" : "layout"} label={table ? t("chart.hideTable") : t("chart.showTable")} onClick={() => setTable(!table)} testId={testId ? `${testId}-table-btn` : undefined} />
          {table && (
            <div className="table-wrap mt-8">
              <table className="tbl dense" data-testid={testId ? `${testId}-table` : undefined}>
                <caption className="sr-only">{title}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("chart.date")}</th>
                    <th scope="col" className="r">
                      {valueLabel}
                    </th>
                    <th scope="col">{t("chart.more")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((d) => (
                    <tr key={d.key}>
                      <th scope="row">{d.label}</th>
                      <td className="r num">{format(d.value)}</td>
                      <td className="small muted">{d.sub ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

/** Small «label: value» row used by the cards (prototype .kv) */
export function Kv({ k, v, testId }: { k: ReactNode; v: ReactNode; testId?: string }) {
  return (
    <div className="kv" data-testid={testId}>
      <span>{k}</span>
      <span className="num wrap-any">{v}</span>
    </div>
  );
}

/** «Нет данных: сервис X недоступен (code)» of an independent block */
export function BlockOff({ service, code, testId }: { service: string; code?: string | null; testId?: string }) {
  const { t } = useI18n();
  return (
    <Callout kind="warn" icon="alert" testId={testId}>
      <b>{t("dash.off.t")}</b> {t("dash.off.m", { s: service })}
      {code && <span className="xs muted block mono">{code}</span>}
    </Callout>
  );
}
