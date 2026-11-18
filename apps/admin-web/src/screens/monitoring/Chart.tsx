import { useMemo, useState } from "react";
import type { ProviderHistory } from "@tilhero/contracts/admin";
import { useI18n } from "../../i18n";
import { chartModel, msParts } from "./ops";

const W = 640;
const H = 150;
const PAD_L = 40;
const PAD_R = 52;
const PAD_T = 8;
const PAD_B = 22;

/**
 * History of a provider (24 h × 5 min or 7 d × 1 h): stacked bars — ok / errors / route not supported — on the left
 * scale, p95 as a line on the right scale. Empty buckets stay blank (no calls — no data, not zero). SVG only; each bar
 * has a <title> (screen readers and hover), the figure has a text summary.
 */
export function HistoryChart({ h, now = Date.now() }: { h: ProviderHistory; now?: number }) {
  const { t, fmt } = useI18n();
  const iw = W - PAD_L - PAD_R;
  const ih = H - PAD_T - PAD_B;
  const m = useMemo(() => chartModel(h.points, h.range, now, iw, ih), [h, now, iw, ih]);
  const [hover, setHover] = useState<number | null>(null);
  const ms = (v: number | null) => {
    const p = msParts(v);
    return !p ? "—" : p.unit === "ms" ? t("ai.ms", { n: fmt.num(p.v) }) : t("ai.sec", { n: fmt.num(p.v, 1) });
  };
  const calls = h.points.reduce((s, p) => s + p.calls, 0);
  const errors = h.points.reduce((s, p) => s + p.errors, 0);
  const route = h.points.reduce((s, p) => s + p.route_unsupported, 0);
  const summary = t("mon.chart.summary", { calls: fmt.num(calls), errors: fmt.num(errors), route: fmt.num(route) });
  const hb = hover != null ? m.bars[hover] : null;
  const tickLabel = (iso: string) => (h.range === "24h" ? fmt.time(iso) : fmt.date(iso).slice(0, 5));
  return (
    <figure className="mon-chart" data-testid="mon-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} onMouseLeave={() => setHover(null)}>
        <g transform={`translate(${PAD_L},${PAD_T})`}>
          {[0, 0.5, 1].map((f) => (
            <line key={f} className="grid" x1={0} x2={iw} y1={ih - f * ih} y2={ih - f * ih} />
          ))}
          {m.bars.map((b, idx) => (
            <g key={b.t} onMouseEnter={() => setHover(idx)} className={hover === idx ? "is-hover" : undefined}>
              <title>{`${h.range === "24h" ? fmt.dateTime(b.t) : fmt.dateTime(b.t)} · ${t("mon.chart.calls", { n: fmt.num(b.calls) })} · ${t("mon.chart.errors", { n: fmt.num(b.errors) })} · p95 ${ms(b.p95)}`}</title>
              <rect className="b-ok" x={b.x} width={b.w} y={ih - b.ok} height={b.ok} />
              <rect className="b-err" x={b.x} width={b.w} y={ih - b.ok - b.err} height={b.err} />
              <rect className="b-route" x={b.x} width={b.w} y={ih - b.ok - b.err - b.route} height={b.route} />
              <rect className="hit" x={b.x} width={Math.max(b.w, 3)} y={0} height={ih} />
            </g>
          ))}
          {m.p95Paths.map((pts, idx) => (pts.includes(" ") ? <polyline key={idx} className="p95" points={pts} /> : <circle key={idx} className="p95-dot" cx={Number(pts.split(",")[0])} cy={Number(pts.split(",")[1])} r={2} />))}
          {m.ticks.map((tk) => (
            <text key={tk.t} className="tick" x={tk.x} y={ih + 15} textAnchor="middle">
              {tickLabel(tk.t)}
            </text>
          ))}
          {/* left axis — calls in a bucket; right axis — p95 (its own scale) */}
          <line className="axis-line" x1={0} x2={0} y1={0} y2={ih} />
          {[1, 0.5, 0].map((f) => (
            <text key={`l${f}`} className="axis" x={-6} y={ih - f * ih + 3} textAnchor="end">
              {fmt.num(Math.round(m.maxCalls * f))}
            </text>
          ))}
          {m.maxP95 > 0 && (
            <>
              <line className="axis-line p95-axis" x1={iw} x2={iw} y1={0} y2={ih} />
              {[1, 0.5, 0].map((f) => (
                <text key={`r${f}`} className="axis p95t" x={iw + 6} y={ih - f * ih + 3}>
                  {f === 0 ? "0" : ms(Math.round(m.maxP95 * f))}
                </text>
              ))}
            </>
          )}
        </g>
      </svg>
      <figcaption className="mon-chart-cap">
        <span className="lg">
          <i className="b-ok" />
          {t("mon.chart.ok")}
        </span>
        <span className="lg">
          <i className="b-err" />
          {t("mon.chart.err")}
        </span>
        <span className="lg">
          <i className="b-route" />
          {t("mon.chart.route")}
        </span>
        <span className="lg">
          <i className="p95" />
          {t("mon.chart.p95")}
        </span>
        <span className="grow" />
        <span className="xs muted" aria-live="polite">
          {hb ? `${fmt.dateTime(hb.t)} · ${t("mon.chart.calls", { n: fmt.num(hb.calls) })} · ${t("mon.chart.errors", { n: fmt.num(hb.errors) })} · p95 ${ms(hb.p95)}` : summary}
        </span>
      </figcaption>
    </figure>
  );
}
