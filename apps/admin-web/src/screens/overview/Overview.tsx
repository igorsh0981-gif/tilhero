/**
 * «Обзор» (dashboard.read): the four independent blocks of GET /admin/v1/dashboard — learners (user-admin), support,
 * «Что нового» (experience-config) and campaigns (notifications). A block whose source is down answers
 * available=false and shows its own notice; the others keep working (admin.ts Dashboard, always 200).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Dashboard, DashboardBlock, DashboardCampaigns, DashboardLearners, DashboardWhatsNew, SupportStats } from "@tilhero/contracts/admin";
import { DashboardApi, type Period } from "../../api/endpoints";
import { useI18n } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon, type IconName } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Seg, Spinner } from "../../ui/kit";

const PERIODS: readonly Period[] = ["today", "7d", "30d"];
type BlockKey = "learners" | "support" | "whats_new" | "campaigns";

export function Overview() {
  const i = useI18n();
  const { t, fmt } = i;
  const [period, setPeriod] = useState<Period>("today");
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const req = useRef(0);

  const load = useCallback((p: Period, background = false) => {
    const id = ++req.current;
    if (!background) setLoading(true);
    DashboardApi.get(p, background)
      .then((d) => {
        if (id !== req.current) return;
        setData(d);
        setError(null);
      })
      .catch((e) => id === req.current && !background && setError(e))
      .finally(() => id === req.current && setLoading(false));
  }, []);
  useEffect(() => {
    load(period);
    const tm = setInterval(() => load(period, true), 60_000);
    return () => clearInterval(tm);
  }, [period, load]);

  const periodLabel = t(`dash.period.${period}`);
  return (
    <div className="stack" data-testid="overview">
      <div className="dash-head">
        <Seg<Period> label={t("dash.period")} value={period} onChange={setPeriod} testId="dash-period" items={PERIODS.map((v) => ({ v, label: t(`dash.period.${v}`) }))} />
        <span className="grow" />
        {data && (
          <span className="dash-updated" data-testid="dash-updated">
            <span className="live" aria-hidden="true" />
            {t("dash.updated", { t: fmt.time(data.generated_at) })}
          </span>
        )}
        <Btn size="sm" icon="refresh" label={t("common.refresh")} busy={loading && !!data} onClick={() => load(period)} testId="dash-refresh" />
      </div>
      {error && !data ? <LoadError error={error} onRetry={() => load(period)} /> : null}
      {!data && !error ? <Spinner label={t("common.loading")} /> : null}
      {data && (
        <>
          <Kpis d={data} period={periodLabel} />
          <Attention d={data} />
          <div className="grid2">
            <Block<DashboardLearners> k="learners" icon="users" block={data.learners} empty={(x) => x.total_accounts + x.total_children === 0}>
              {(x) => <LearnersBody x={x} period={periodLabel} />}
            </Block>
            <Block<SupportStats> k="support" icon="support" block={data.support} empty={(x) => x.open + x.in_progress + x.waiting_customer === 0 && x.avg_first_response_minutes == null}>
              {(x) => <SupportBody x={x} />}
            </Block>
            <Block<DashboardWhatsNew> k="whats_new" icon="sparkles" block={data.whats_new} empty={(x) => x.published + x.drafts === 0}>
              {(x) => <WhatsNewBody x={x} />}
            </Block>
            <Block<DashboardCampaigns> k="campaigns" icon="megaphone" block={data.campaigns} empty={(x) => x.scheduled + x.sending + x.sent_in_period + x.delivered_in_period === 0}>
              {(x) => <CampaignsBody x={x} period={periodLabel} />}
            </Block>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- KPI row (prototype .grid .card) */

function Kpis({ d, period }: { d: Dashboard; period: string }) {
  const { t, fmt } = useI18n();
  const l = d.learners.available ? d.learners.data : null;
  const s = d.support.available ? d.support.data : null;
  const w = d.whats_new.available ? d.whats_new.data : null;
  const c = d.campaigns.available ? d.campaigns.data : null;
  const dash = "—";
  return (
    <div className="kpis" data-testid="kpis">
      <Kpi label={t("kpi.active", { p: period })} value={l ? fmt.num(l.active_in_period) : dash} note={l ? t("kpi.activeN", { a: fmt.num(l.total_accounts), c: fmt.num(l.total_children) }) : t("dash.noData")} />
      <Kpi label={t("kpi.new", { p: period })} value={l ? fmt.num(l.new_in_period) : dash} note={l ? t("kpi.onboarded", { n: fmt.pct(l.onboarding_completed_pct) }) : t("dash.noData")} />
      <Kpi label={t("kpi.open")} value={s ? fmt.num(s.open) : dash} note={s ? (s.breached ? t("kpi.breached", { n: s.breached }) : t("kpi.slaOk")) : t("dash.noData")} bad={!!s?.breached} />
      <Kpi label={t("kpi.views")} value={w?.latest ? fmt.num(w.latest.views_total) : dash} note={w?.latest ? w.latest.title : w ? t("wn.none") : t("dash.noData")} />
      <Kpi label={t("kpi.delivered", { p: period })} value={c ? fmt.num(c.delivered_in_period) : dash} note={c ? t("kpi.sent", { n: fmt.num(c.sent_in_period) }) : t("dash.noData")} />
    </div>
  );
}

function Kpi({ label, value, note, bad }: { label: string; value: string; note: string; bad?: boolean }) {
  return (
    <div className={cx("card kpi", bad && "is-bad")}>
      <div className="kpi-l">{label}</div>
      <div className="kpi-v">{value}</div>
      <div className="kpi-n" title={note}>
        {note}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- «Требует внимания» (prototype) */

function Attention({ d }: { d: Dashboard }) {
  const { t } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const rows: Array<{ label: string; n: number; go: () => void; show: boolean; id: string }> = [];
  const s = d.support.available ? d.support.data : null;
  const w = d.whats_new.available ? d.whats_new.data : null;
  const c = d.campaigns.available ? d.campaigns.data : null;
  if (s) rows.push({ id: "breached", label: t("att.breached"), n: s.breached, go: () => navigate("support"), show: can("support.read") });
  if (s) rows.push({ id: "new", label: t("att.waiting"), n: s.open - s.in_progress - s.waiting_customer, go: () => navigate("support"), show: can("support.read") });
  if (w) rows.push({ id: "drafts", label: t("att.drafts"), n: w.drafts, go: () => navigate("news", "whatsnew"), show: can("whatsnew.manage") });
  if (c) rows.push({ id: "sending", label: t("att.sending"), n: c.sending + c.scheduled, go: () => navigate("news", "campaigns"), show: can("notif.campaigns.manage") });
  const live = rows.filter((r) => r.n > 0);
  if (!live.length) return null;
  return (
    <section className="card attention" aria-labelledby="att-h" data-testid="attention">
      <h2 className="h2" id="att-h">
        {t("att.title")}
      </h2>
      {live.map((r) => (
        <div className="kv" key={r.id}>
          <span>{r.label}</span>
          {r.show ? (
            <button type="button" className="tr" onClick={r.go} data-testid={`att-${r.id}`}>
              {t("att.open", { n: r.n })}
            </button>
          ) : (
            <span className="num">{r.n}</span>
          )}
        </div>
      ))}
    </section>
  );
}

/* ---------------------------------------------------------------- block frame */

function Block<T>({ k, icon, block, empty, children }: { k: BlockKey; icon: IconName; block: DashboardBlock<T>; empty: (x: T) => boolean; children: (x: T) => ReactNode }) {
  const { t } = useI18n();
  const off = !block.available || block.data == null;
  return (
    <section className={cx("card dash-block", off && "is-off")} aria-labelledby={`blk-${k}`} data-testid={`block-${k}`} data-available={String(!off)}>
      <div className="blk-h">
        <Icon name={icon} />
        <h2 className="h2" id={`blk-${k}`}>
          {t(`dash.b.${k}`)}
        </h2>
      </div>
      {off ? (
        <Callout kind="warn" icon="alert" testId={`block-${k}-off`}>
          <b>{t("dash.off.t")}</b> {t("dash.off.m", { s: block.service ?? t(`dash.svc.${k}`) })}
        </Callout>
      ) : empty(block.data as T) ? (
        <p className="sub blk-empty" data-testid={`block-${k}-empty`}>
          <Icon name="inbox" /> {t(`dash.empty.${k}`)}
        </p>
      ) : (
        children(block.data as T)
      )}
    </section>
  );
}

function Row({ k, v, testId }: { k: ReactNode; v: ReactNode; testId?: string }) {
  return (
    <div className="kv" data-testid={testId}>
      <span>{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}

function Split({ parts, label }: { parts: Array<{ k: string; n: number; label: string }>; label: string }) {
  const total = parts.reduce((a, p) => a + p.n, 0) || 1;
  return (
    <div className="split" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.n}`).join(", ")}`}>
      <div className="splitbar" aria-hidden="true">
        {parts.map((p, n) => (p.n ? <span key={p.k} className={`sw-${(n % 5) + 1}`} style={{ width: `${(p.n / total) * 100}%` }} /> : null))}
      </div>
      <div className="legend" aria-hidden="true">
        {parts.map((p, n) => (
          <span key={p.k}>
            <i className={`sw-${(n % 5) + 1}`} />
            {p.label} · {p.n}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- bodies */

function LearnersBody({ x, period }: { x: DashboardLearners; period: string }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const ages = (["6-9", "10-13", "14-17", "18+", "unknown"] as const).map((k) => ({ k, n: x.by_age_band[k] ?? 0, label: k === "unknown" ? t("dash.unknown") : k }));
  const langs = (["ru", "uz", "unknown"] as const).map((k) => ({ k, n: x.by_locale[k] ?? 0, label: k === "unknown" ? t("dash.unknown") : k.toUpperCase() }));
  return (
    <>
      <Row k={t("dl.accounts")} v={fmt.num(x.total_accounts)} testId="dl-accounts" />
      <Row k={t("dl.children")} v={fmt.num(x.total_children)} />
      <Row k={t("dl.new", { p: period })} v={fmt.num(x.new_in_period)} />
      <Row k={t("dl.active", { p: period })} v={fmt.num(x.active_in_period)} />
      <Row k={t("dl.onboarded")} v={fmt.pct(x.onboarding_completed_pct)} />
      <Row k={t("dl.reminders")} v={fmt.pct(x.reminders_enabled_pct)} />
      <div className="blk-sub">{t("dl.byAge")}</div>
      <Split parts={ages} label={t("dl.byAge")} />
      <div className="blk-sub">{t("dl.byLang")}</div>
      <Split parts={langs} label={t("dl.byLang")} />
      {can("users.read") && (
        <div className="acts">
          <Btn size="sm" icon="users" label={t("dl.open")} onClick={() => navigate("users")} />
        </div>
      )}
    </>
  );
}

function SupportBody({ x }: { x: SupportStats }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  return (
    <>
      <Row k={t("ds.open")} v={fmt.num(x.open)} testId="ds-open" />
      <Row k={t("ds.inProgress")} v={fmt.num(x.in_progress)} />
      <Row k={t("ds.waiting")} v={fmt.num(x.waiting_customer)} />
      <Row k={t("ds.breached")} v={<span className={x.breached ? "bad-ink b" : undefined}>{fmt.num(x.breached)}</span>} />
      <Row k={t("ds.first")} v={fmt.minutes(x.avg_first_response_minutes)} />
      <Row k={t("ds.resolution")} v={fmt.minutes(x.avg_resolution_minutes)} />
      {can("support.read") && (
        <div className="acts">
          <Btn size="sm" icon="support" label={t("ds.openQueue")} onClick={() => navigate("support")} />
        </div>
      )}
    </>
  );
}

function WhatsNewBody({ x }: { x: DashboardWhatsNew }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  return (
    <>
      <Row k={t("dw.published")} v={fmt.num(x.published)} />
      <Row k={t("dw.drafts")} v={fmt.num(x.drafts)} />
      {x.latest ? (
        <>
          <Row k={t("dw.latest")} v={<span className="wrap-any">{x.latest.title}</span>} />
          <Row k={t("dw.views")} v={fmt.num(x.latest.views_total)} testId="dw-views" />
          <Row k={t("dw.at")} v={fmt.dateTime(x.latest.published_at)} />
        </>
      ) : (
        <p className="sub">{t("wn.none")}</p>
      )}
      {can("whatsnew.manage") && (
        <div className="acts">
          <Btn size="sm" icon="sparkles" label={t("dw.open")} onClick={() => navigate("news", "whatsnew")} />
        </div>
      )}
    </>
  );
}

function CampaignsBody({ x, period }: { x: DashboardCampaigns; period: string }) {
  const { t, fmt } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  return (
    <>
      <Row k={t("dc.scheduled")} v={fmt.num(x.scheduled)} />
      <Row k={t("dc.sending")} v={fmt.num(x.sending)} />
      <Row k={t("dc.sent", { p: period })} v={fmt.num(x.sent_in_period)} />
      <Row k={t("dc.delivered", { p: period })} v={fmt.num(x.delivered_in_period)} />
      {can("notif.campaigns.manage") && (
        <div className="acts">
          <Btn size="sm" icon="megaphone" label={t("dc.open")} onClick={() => navigate("news", "campaigns")} />
        </div>
      )}
    </>
  );
}
