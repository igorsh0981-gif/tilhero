/**
 * «Диагностика» (diagnostics via admin-bff, AT-32…34): tests and their versions — coverage cells area × band, the
 * items with their answer keys (staff only), publication of a version (content.publish, step-up) — and the statistics
 * of the period (started / finished, median time, distribution of levels, share of not_assessed per area).
 */
import { useCallback, useEffect, useState } from "react";
import type { DiagnosticStats, DiagnosticTestRow, DiagnosticTestVersion } from "@tilhero/contracts/admin";
import type { Band } from "@tilhero/contracts/content";
import { Diagnostics, type Period } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, Pill, Seg, Spinner } from "../../ui/kit";
import { ConfirmCommand } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { answerText, BANDS } from "./model";

export const DX_AREAS = ["vocabulary", "grammar", "reading", "listening"] as const;
type Area = (typeof DX_AREAS)[number];

/** Coverage cell tone: no items — bad, one — warn (the ladder needs two per band to judge it). */
export const coverageTone = (n: number): "bad" | "warn" | "good" => (n <= 0 ? "bad" : n < 2 ? "warn" : "good");

export function DiagnosticsTab({ route }: { route: string | null }) {
  const { t } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const [rows, setRows] = useState<DiagnosticTestRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [testId, v] = (route ?? "").split("/");
  const load = useCallback(async () => {
    try {
      setRows((await Diagnostics.tests()).items);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const sel = rows?.find((r) => r.test_id === testId) ?? rows?.[0] ?? null;
  const ver = sel ? (v && Number(v) > 0 ? Number(v) : (sel.published_version ?? sel.versions[0]?.version ?? null)) : null;
  return (
    <div className="stack" data-testid="dx">
      <section className="panel" aria-labelledby="dx-h">
        <div className="panel-h">
          <h2 className="panel-t grow" id="dx-h">
            <Icon name="gauge" /> {t("dx.tests")}
          </h2>
        </div>
        {error && !rows ? (
          <div className="panel-b">
            <LoadError error={error} onRetry={() => void load()} />
          </div>
        ) : !rows ? (
          <Spinner label={t("common.loading")} />
        ) : rows.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t("dx.col.test")}</th>
                  <th scope="col">{t("dx.col.pair")}</th>
                  <th scope="col">{t("ct.audience")}</th>
                  <th scope="col">{t("dx.col.published")}</th>
                  <th scope="col">{t("dx.col.versions")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.test_id} className={sel?.test_id === r.test_id ? "is-sel" : undefined} data-testid={`dx-row-${r.test_id}`}>
                    <td className="mono">{r.test_id}</td>
                    <td className="mono">{r.pair_id}</td>
                    <td className="small">{t(r.audience === "kids" ? "ageseg.kids" : "dx.adults")}</td>
                    <td>{r.published_version != null ? <Pill tone="good">v{r.published_version}</Pill> : <Pill tone="warn">{t("dx.notPublished")}</Pill>}</td>
                    <td>
                      <span className="row">
                        {r.versions.map((x) => (
                          <button
                            key={x.version}
                            type="button"
                            className={cx("chip", sel?.test_id === r.test_id && ver === x.version && "is-on")}
                            aria-pressed={sel?.test_id === r.test_id && ver === x.version}
                            onClick={() => navigate("content", `diagnostics/${r.test_id}/${x.version}`)}
                            data-testid={`dx-v-${r.test_id}-${x.version}`}
                          >
                            v{x.version} · {t(`dxs.${x.status}` as MessageKey)} · {t("dx.itemsN", { n: x.items })}
                          </button>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="gauge" title={t("dx.empty")} />
        )}
      </section>
      {sel && ver != null && <TestVersion key={`${sel.test_id}/${ver}`} row={sel} version={ver} onPublished={(r) => setRows((xs) => (xs ? xs.map((x) => (x.test_id === r.test_id ? r : x)) : xs))} />}
      {can("dashboard.read") && <DxStats />}
    </div>
  );
}

function TestVersion({ row, version, onPublished }: { row: DiagnosticTestRow; version: number; onPublished: (r: DiagnosticTestRow) => void }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { can } = useSession();
  const toast = useToast();
  const [d, setD] = useState<DiagnosticTestVersion | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [area, setArea] = useState<Area | "all">("all");
  const [band, setBand] = useState<Band | "all">("all");
  const [ask, setAsk] = useState(false);
  const load = useCallback(async () => {
    try {
      setD(await Diagnostics.version(row.test_id, version));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [row.test_id, version]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error && !d) return <LoadError error={error} onRetry={() => void load()} />;
  if (!d) return <Spinner label={t("common.loading")} />;
  const items = d.items.filter((it) => (area === "all" || it.area === area) && (band === "all" || it.band === band));
  const meta = row.versions.find((x) => x.version === version);
  return (
    <section className="card stack" aria-labelledby="dxv-h" data-testid="dx-version">
      <div className="row between">
        <h2 className="h2" id="dxv-h">
          {row.test_id} · v{version}{" "}
          <Pill tone={d.status === "published" ? "good" : d.status === "draft" ? "warn" : "neutral"}>{t(`dxs.${d.status}` as MessageKey)}</Pill>
        </h2>
        {d.status === "draft" && can("content.publish") && <Btn kind="primary" icon="send" label={t("dx.publish")} onClick={() => setAsk(true)} testId="dx-publish" />}
      </div>
      {meta?.published_at && <p className="xs muted">{t("dx.publishedAt", { t: fmt.dateTime(meta.published_at) })}</p>}
      <div>
        <h3 className="h3">{t("dx.coverage")}</h3>
        <p className="xs muted">{t("dx.coverageHint")}</p>
        <div className="table-wrap">
          <table className="tbl compact cov" data-testid="dx-coverage">
            <thead>
              <tr>
                <th scope="col">{t("dx.area")}</th>
                {BANDS.map((b) => (
                  <th key={b} scope="col" className="c">
                    {b}
                  </th>
                ))}
                <th scope="col" className="c">
                  {t("dx.total")}
                </th>
              </tr>
            </thead>
            <tbody>
              {DX_AREAS.map((a) => {
                const cells = d.coverage[a] ?? ({} as Record<Band, number>);
                const total = BANDS.reduce((s, b) => s + (cells[b] ?? 0), 0);
                return (
                  <tr key={a}>
                    <th scope="row">{t(`area.${a}` as MessageKey)}</th>
                    {BANDS.map((b) => {
                      const n = cells[b] ?? 0;
                      return (
                        <td key={b} className={cx("c cov-cell", `is-${coverageTone(n)}`)} data-testid={`cov-${a}-${b}`}>
                          <button type="button" className="cov-btn" aria-label={t("dx.cell", { a: t(`area.${a}` as MessageKey), b, n })} onClick={() => (setArea(a), setBand(b))}>
                            {n}
                          </button>
                        </td>
                      );
                    })}
                    <td className="c num">{total}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="stack sm">
        <div className="row">
          <h3 className="h3 grow">{t("dx.items", { n: items.length })}</h3>
          <Seg<Area | "all"> label={t("dx.area")} value={area} onChange={setArea} items={[{ v: "all", label: t("cr.f.all") }, ...DX_AREAS.map((a) => ({ v: a, label: t(`area.${a}` as MessageKey) }))]} />
          <Seg<Band | "all"> label={t("le.level")} value={band} onChange={setBand} items={[{ v: "all", label: t("cr.f.all") }, ...BANDS.map((b) => ({ v: b, label: b }))]} />
        </div>
        <Callout icon="lock">{t("dx.keysNote")}</Callout>
        <div className="table-wrap">
          <table className="tbl dense" data-testid="dx-items">
            <thead>
              <tr>
                <th scope="col">{t("dx.col.item")}</th>
                <th scope="col">{t("dx.area")}</th>
                <th scope="col">{t("dx.col.task")}</th>
                <th scope="col">{t("dx.col.key")}</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 200).map((it) => {
                const opts = Array.isArray(it.options) ? (it.options as string[]) : [];
                return (
                  <tr key={String(it.item_id)} data-testid={`dx-item-${String(it.item_id)}`}>
                    <td className="mono xs">
                      {String(it.item_id)}
                      <div className="cell-sub">{String(it.type ?? "")}</div>
                    </td>
                    <td className="small">
                      {t(`area.${String(it.area)}` as MessageKey)} · <span className="tag">{String(it.band)}</span>
                    </td>
                    <td className="small wrap-any" lang="en">
                      {String(it.prompt_en ?? "")}
                      {it.passage_en ? <div className="cell-sub">{String(it.passage_en).slice(0, 140)}</div> : null}
                      {it.audio_text_en ? (
                        <div className="cell-sub">
                          <Icon name="play" /> {String(it.audio_text_en).slice(0, 140)}
                        </div>
                      ) : null}
                      {opts.length > 0 && <div className="cell-sub">{opts.map((o, n) => `${String.fromCharCode(65 + n)}) ${o}`).join("  ")}</div>}
                    </td>
                    <td className="small mono key-cell">{answerText(String(it.type ?? ""), opts, it.answer)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {ask && (
        <ConfirmCommand
          title={t("dx.publishT", { id: row.test_id, v: version })}
          text={t("dx.publishM")}
          icon="send"
          ok={t("dx.publish")}
          extra={
            <Callout kind="info" icon="smartphoneKey">
              {t("ct.stepUpNote")}
            </Callout>
          }
          testId="dx-confirm"
          onClose={() => setAsk(false)}
          onConfirm={async (reason) => {
            try {
              const r = await Diagnostics.publish(row.test_id, version, reason);
              onPublished(r);
              toast(t("dx.published", { id: row.test_id, v: version }), "ok", "diagnostics.test_published");
              void load();
              return null;
            } catch (e) {
              return (e as ApiError)?.cancelled ? t("stepup.cancelled") : errText(i18n, e);
            }
          }}
        />
      )}
    </section>
  );
}

export function DxStats() {
  const { t } = useI18n();
  const [period, setPeriod] = useState<Period>("7d");
  const [s, setS] = useState<DiagnosticStats | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    setS(null);
    Diagnostics.stats(period)
      .then((x) => alive && (setS(x), setError(null)))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [period]);
  return (
    <section className="card stack sm" aria-labelledby="dxs-h" data-testid="dx-stats">
      <div className="row between">
        <h2 className="h2" id="dxs-h">
          {t("dx.stats")}
        </h2>
        <Seg<Period> label={t("dash.period")} value={period} onChange={setPeriod} items={(["today", "7d", "30d"] as const).map((v) => ({ v, label: t(`dash.period.${v}`) }))} />
      </div>
      {error ? <LoadError error={error} /> : !s ? <Spinner label={t("common.loading")} /> : <DxStatsBody s={s} />}
      {s && <p className="xs muted">{t("dx.notCert")}</p>}
    </section>
  );
}

export function DxStatsBody({ s }: { s: DiagnosticStats }) {
  const { t, fmt } = useI18n();
  const total = BANDS.reduce((a, b) => a + (s.by_level[b] ?? 0), 0) + (s.by_level.none ?? 0);
  return (
    <div className="grid2 tight">
      <div>
        <div className="kv">
          <span>{t("dx.started")}</span>
          <span className="num">{fmt.num(s.started)}</span>
        </div>
        <div className="kv">
          <span>{t("dx.finished")}</span>
          <span className="num" data-testid="dx-finished">
            {fmt.num(s.finished)}
          </span>
        </div>
        <div className="kv">
          <span>{t("dx.median")}</span>
          <span className="num">{fmt.minutes(s.median_minutes)}</span>
        </div>
        <div className="kv">
          <span>{t("dx.followups")}</span>
          <span className="num">{fmt.num(s.followups)}</span>
        </div>
        <div className="blk-sub">{t("dx.byLevel")}</div>
        <div className="split" role="img" aria-label={`${t("dx.byLevel")}: ${[...BANDS, "none" as const].map((b) => `${b === "none" ? t("dx.none") : b} ${s.by_level[b] ?? 0}`).join(", ")}`}>
          <div className="splitbar" aria-hidden="true">
            {[...BANDS, "none" as const].map((b, n) => ((s.by_level[b] ?? 0) ? <span key={b} className={`sw-${(n % 6) + 1}`} style={{ width: `${((s.by_level[b] ?? 0) / (total || 1)) * 100}%` }} /> : null))}
          </div>
          <div className="legend" aria-hidden="true">
            {[...BANDS, "none" as const].map((b, n) => (
              <span key={b}>
                <i className={`sw-${(n % 6) + 1}`} />
                {b === "none" ? t("dx.none") : b} · {s.by_level[b] ?? 0}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div>
        <div className="blk-sub">{t("dx.notAssessed")}</div>
        {DX_AREAS.map((a) => (
          <div className="kv" key={a} data-testid={`dx-na-${a}`}>
            <span>{t(`area.${a}` as MessageKey)}</span>
            <span className="row nowrap-row">
              <span className="barbg" aria-hidden="true">
                <span className={cx("barfg", (s.not_assessed_pct[a] ?? 0) > 30 && "is-warn")} style={{ width: `${Math.min(100, s.not_assessed_pct[a] ?? 0)}%` }} />
              </span>
              <span className="num">{fmt.pct(s.not_assessed_pct[a] ?? 0)}</span>
            </span>
          </div>
        ))}
        <p className="xs muted mt-8">{t("dx.naHint")}</p>
      </div>
    </div>
  );
}
