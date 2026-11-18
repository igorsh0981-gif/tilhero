import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  AppUserStatus,
  DashboardAi,
  DashboardBlock,
  DashboardUsers,
  DashboardV2,
  NewsStats,
  NoFlightStats,
  OpsSummary,
  SupportStats,
  TripsStats,
  WatchStats,
} from "@tilhero/contracts/admin";
import { DashboardApi, type Period } from "../../api/endpoints";
import { useI18n, type I18n } from "../../i18n";
import { fmtUsd } from "../../lib/money";
import { useNav } from "../../shell/navctx";
import { pageAllowed } from "../../state/nav";
import { useSession } from "../../state/session";
import { Icon, type IconName } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, cx, Pill, Seg, Spinner } from "../../ui/kit";
import { BudgetMeter } from "../ai/parts";
import { tOr } from "../monitoring/Alerts";
import { STATUS_ICON, STATUS_TONE } from "../monitoring/ops";
import { CriticalAlerts } from "./CriticalAlerts";

/** admin-bff: refresh=true не чаще раза в 15 с на сотрудника */
export const DASH_REFRESH_COOLDOWN_MS = 15_000;
const BLOCK_KEYS = ["users", "trips", "no_flight", "watch", "news", "ai", "support", "system"] as const;
/** freshness of the whole dashboard: the oldest copy among the blocks with data, how many are stale / without data */
export function dashFreshness(d: DashboardV2): { asOf: string; stale: number; off: number } {
  let asOf = d.generated_at;
  let stale = 0;
  let off = 0;
  for (const k of BLOCK_KEYS) {
    const b = d[k] as DashboardBlock<unknown>;
    if (b.available && b.as_of) {
      if (Date.parse(b.as_of) < Date.parse(asOf)) asOf = b.as_of;
      if (b.stale) stale += 1;
    } else if (!b.available && (b.reason === "unavailable" || b.reason === "timeout")) off += 1;
  }
  return { asOf, stale, off };
}

const STATUS_ORDER: readonly AppUserStatus[] = [
  "ACTIVE",
  "DISABLED",
  "DELETION_REQUESTED",
  "DELETED",
];

/** Widget ids the admin config (experience-config, layout.dashboard_widgets) can order or hide (A46). */
export const WIDGETS = [
  "kpi_users",
  "kpi_ai",
  "kpi_support",
  "kpi_system",
  "kpi_commerce",
] as const;
export type WidgetId = (typeof WIDGETS)[number];
/** Sprint 8 groups: not in the config catalogue of experience-config yet — always shown at their default place. */
export const FIXED = [
  "kpi_trips",
  "kpi_no_flight",
  "kpi_watch",
  "kpi_news",
] as const;
export type DashWidget = WidgetId | (typeof FIXED)[number];
/** default order of the full dashboard (prototype v2: users · AI, trips · no flight, watch · news · support, system · commerce) */
export const DEFAULT_ORDER: readonly DashWidget[] = [
  "kpi_users",
  "kpi_ai",
  "kpi_trips",
  "kpi_no_flight",
  "kpi_watch",
  "kpi_news",
  "kpi_support",
  "kpi_system",
  "kpi_commerce",
];
/** width of a group in twelfths */
const SIZE: Record<DashWidget, number> = {
  kpi_users: 6,
  kpi_ai: 6,
  kpi_trips: 6,
  kpi_no_flight: 6,
  kpi_watch: 4,
  kpi_news: 4,
  kpi_support: 4,
  kpi_system: 8,
  kpi_commerce: 4,
};

/**
 * Order and visibility from the active admin config (A46: changed without a rebuild). Widgets the config does not
 * mention keep their default place at the end; ids of later sprints (budget, hourly, …) are ignored here.
 */
export function widgetOrder(
  layout: Array<{ id: string; enabled: boolean }> | null | undefined,
): WidgetId[] {
  if (!layout || !layout.length) return [...WIDGETS];
  const known = new Set<string>(WIDGETS);
  const listed = layout.filter((w) => known.has(w.id));
  const seen = new Set(listed.map((w) => w.id));
  return [
    ...listed.filter((w) => w.enabled).map((w) => w.id as WidgetId),
    ...WIDGETS.filter((w) => !seen.has(w)),
  ];
}

/** Configured widgets in their order + the fixed sprint 8 groups after their default predecessor. */
export function dashOrder(configured: readonly WidgetId[]): DashWidget[] {
  const out: DashWidget[] = [...configured];
  for (const f of FIXED) {
    const before = DEFAULT_ORDER.slice(0, DEFAULT_ORDER.indexOf(f)).filter(
      (x) => out.includes(x),
    );
    const anchor = before[before.length - 1];
    out.splice(anchor ? out.indexOf(anchor) + 1 : 0, 0, f);
  }
  return out;
}

/** Rows of twelve: greedy packing, the widths of a short row stretch (fr) — no gaps whatever the config hides. */
export function widgetRows(
  order: readonly DashWidget[],
): Array<Array<{ id: DashWidget; span: number }>> {
  const rows: Array<Array<{ id: DashWidget; span: number }>> = [];
  let row: Array<{ id: DashWidget; span: number }> = [];
  let used = 0;
  for (const id of order) {
    const span = SIZE[id];
    if (used + span > 12 && row.length) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push({ id, span });
    used += span;
  }
  if (row.length) rows.push(row);
  return rows;
}

function Stat({
  label,
  value,
  sub,
  tone,
  testId,
  wide,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "bad" | "warn";
  testId?: string;
  wide?: boolean;
}) {
  return (
    <div
      className={cx(
        "stat",
        tone === "bad" && "is-bad",
        tone === "warn" && "is-warn",
        wide && "is-wide",
      )}
      data-testid={testId}
    >
      <div className="stat-l">
        <span className="stat-ln">{label}</span>
      </div>
      <div className="stat-v">
        <ToneMark tone={tone} />
        {value}
      </div>
      {sub != null && <div className="stat-s">{sub}</div>}
    </div>
  );
}

/** a coloured value also gets an icon and words for screen readers — the state is never colour alone */
function ToneMark({ tone }: { tone?: "bad" | "warn" }) {
  const { t } = useI18n();
  if (!tone) return null;
  return (
    <>
      <Icon name={tone === "bad" ? "alertCircle" : "alert"} className="tone-ico" />
      <span className="sr-only">{t(tone === "bad" ? "dash.tone.bad" : "dash.tone.warn")}: </span>
    </>
  );
}

/** «Нет данных · обновлено ЧЧ:ММ»: a block without data says why, never shows zeros */
function NoData({
  b,
  icon,
  i,
}: {
  b: DashboardBlock<unknown>;
  icon: IconName;
  i: I18n;
}) {
  const reason = b.reason ?? "unavailable";
  return (
    <div className="dash-nodata" data-testid="dash-nodata" data-reason={reason}>
      <span className="dash-nodata-ico" aria-hidden="true">
        <Icon
          name={
            reason === "forbidden"
              ? "lock"
              : reason === "not_configured"
                ? "power"
                : icon
          }
        />
      </span>
      <div>
        <div className="t">{i.t(`dash.nd.${reason}`)}</div>
        <div className="m">{i.t(`dash.nd.${reason}.m`)}</div>
      </div>
    </div>
  );
}

function Group<T>({
  icon,
  title,
  sub,
  block,
  span,
  testId,
  action,
  children,
}: {
  icon: IconName;
  title: string;
  sub?: ReactNode;
  block: DashboardBlock<T> | null;
  span: number;
  testId: string;
  action?: ReactNode;
  children?: (d: T) => ReactNode;
}) {
  const i = useI18n();
  const { t, fmt } = i;
  const off = block && !block.available;
  return (
    <section
      className={cx(
        "panel kgroup dw",
        off && "is-muted",
        block?.stale && "is-stale",
      )}
      style={{ ["--span" as string]: span }}
      data-testid={testId}
      data-available={block ? String(block.available) : undefined}
    >
      <div className="panel-h">
        <h2 className="panel-t">
          <Icon name={icon} />
          {title}
        </h2>
        <span className="grow" />
        {sub && <span className="panel-sub">{sub}</span>}
        {!off && action}
      </div>
      {block?.stale && (
        <div className="dash-stale" role="note" data-testid="dash-stale">
          <Icon name="clock" />
          <b>{t("dash.stale", { t: fmt.time(block.as_of) })}</b>
          <span>{t("dash.staleH")}</span>
        </div>
      )}
      {block == null ? null : !block.available || block.data == null ? (
        <NoData b={block} icon={icon} i={i} />
      ) : (
        children?.(block.data)
      )}
    </section>
  );
}

const share = (v: number | null | undefined, fmt: I18n["fmt"]) =>
  v == null ? "—" : fmt.pct(v * 100, 0);

export function Dashboard() {
  const i = useI18n();
  const { t } = i;
  const { adminLayout, me } = useSession();
  const { navigate } = useNav();
  const perms = new Set(me?.permissions ?? []);
  const [period, setPeriod] = useState<Period>("today");
  const [data, setData] = useState<DashboardV2 | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  // «Обновить» мимо кэша — раз в 15 с (как admin-bff): кнопка на это время неактивна с подсказкой
  const [coolUntil, setCoolUntil] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (coolUntil <= Date.now()) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [coolUntil]);
  const coolLeft = Math.max(0, Math.ceil((coolUntil - nowTick) / 1000));

  const load = useCallback((p: Period, refresh = false) => {
    setLoading(true);
    if (refresh) setReloadKey((k) => k + 1);
    DashboardApi.get(p, refresh)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => load(period), [period, load]);

  const periodLabel = t(`dash.period.${period}`);
  const go = (page: string, id?: string) =>
    pageAllowed(page, perms) ? () => navigate(page, id ?? null) : undefined;
  const link = (page: string, label: string, id?: string, testId?: string) => {
    const f = go(page, id);
    return f ? (
      <Btn
        size="xs"
        kind="ghost"
        icon="right"
        label={label}
        onClick={f}
        testId={testId}
      />
    ) : undefined;
  };
  const rows = widgetRows(dashOrder(widgetOrder(adminLayout?.widgets)));

  const render = (id: DashWidget, span: number): ReactNode => {
    const d = data!;
    switch (id) {
      case "kpi_users":
        return (
          <Group<DashboardUsers>
            key={id}
            icon="users"
            title={t("dash.users")}
            sub={periodLabel}
            block={d.users}
            span={span}
            testId="dash-users"
            action={link("users", t("dash.users.open"))}
          >
            {(u) => <UsersBody u={u} period={periodLabel} />}
          </Group>
        );
      case "kpi_ai":
        return (
          <Group<DashboardAi>
            key={id}
            icon="sparkles"
            title={t("dash.ai")}
            sub={periodLabel}
            block={d.ai}
            span={span}
            testId="dash-ai"
            action={link(
              "requests",
              t("dash.ai.open"),
              undefined,
              "dash-ai-open",
            )}
          >
            {(a) => <AiBody a={a} />}
          </Group>
        );
      case "kpi_trips":
        return (
          <Group<TripsStats>
            key={id}
            icon="luggage"
            title={t("dash.trips")}
            sub={periodLabel}
            block={d.trips}
            span={span}
            testId="dash-trips"
          >
            {(x) => <TripsBody x={x} />}
          </Group>
        );
      case "kpi_no_flight":
        return (
          <Group<NoFlightStats>
            key={id}
            icon="plane"
            title={t("dash.nf")}
            sub={periodLabel}
            block={d.no_flight}
            span={span}
            testId="dash-no-flight"
          >
            {(x) => <NoFlightBody x={x} />}
          </Group>
        );
      case "kpi_watch":
        return (
          <Group<WatchStats>
            key={id}
            icon="radar"
            title={t("dash.watch")}
            sub={t("dash.h24")}
            block={d.watch}
            span={span}
            testId="dash-watch"
            action={link("watches", t("dash.open"))}
          >
            {(x) => <WatchBody x={x} />}
          </Group>
        );
      case "kpi_news":
        return (
          <Group<NewsStats>
            key={id}
            icon="newspaper"
            title={t("dash.news")}
            sub={periodLabel}
            block={d.news}
            span={span}
            testId="dash-news"
            action={link("news", t("dash.open"))}
          >
            {(x) => <NewsBody x={x} />}
          </Group>
        );
      case "kpi_support":
        return (
          <Group<SupportStats>
            key={id}
            icon="support"
            title={t("dash.support")}
            sub={t("dash.support.sub")}
            block={d.support}
            span={span}
            testId="dash-support"
            action={link("support", t("dash.support.open"))}
          >
            {(s) => <SupportBody s={s} period={periodLabel} />}
          </Group>
        );
      case "kpi_system":
        return (
          <Group<OpsSummary>
            key={id}
            icon="server"
            title={t("dash.system")}
            sub={t("dash.now")}
            block={d.system}
            span={span}
            testId="dash-system"
            action={link(
              "monitoring",
              t("dash.system.open"),
              "providers",
              "dash-system-open",
            )}
          >
            {(s) => <SystemBody s={s} go={(id2) => go("monitoring", id2)} goDeletions={go("users", s.deletions?.stuck ? "deletions/stuck" : "deletions")} />}
          </Group>
        );
      default:
        return (
          <section
            key={id}
            className="panel kgroup dw is-muted"
            style={{ ["--span" as string]: span }}
            data-testid="dash-commerce"
          >
            <div className="panel-h">
              <h2 className="panel-t">
                <Icon name="star" />
                {t("dash.commerce")}
              </h2>
              <span className="grow" />
              <Pill tone="outline" dot={false}>
                {t("dash.postponed")}
              </Pill>
            </div>
            <div className="dash-nodata">
              <span className="dash-nodata-ico" aria-hidden="true">
                <Icon name="card" />
              </span>
              <div>
                <div className="t">{t("dash.commerce.t")}</div>
                <div className="m">{t("dash.commerce.text")}</div>
              </div>
            </div>
          </section>
        );
    }
  };

  return (
    <div data-testid="dashboard">
      <div className="dash-head">
        <Seg
          label={t("dash.period")}
          value={period}
          onChange={setPeriod}
          testId="dash-period"
          items={(["today", "7d", "30d"] as const).map((v) => ({
            v,
            label: t(`dash.period.${v}`),
          }))}
        />
        {period === "today" && (
          <span className="dash-tz" title={t("dash.tzH")}>
            {t("dash.tz")}
          </span>
        )}
        {data && <Freshness d={data} />}
        <span className="grow" />
        {coolLeft > 0 && !loading && (
          <span className="xs muted" aria-live="polite" data-testid="dash-refresh-recent">
            {t("dash.refreshedNow")}
          </span>
        )}
        <Btn
          icon="refresh"
          size="sm"
          label={t("common.refresh")}
          title={coolLeft ? t("dash.refreshRecent", { n: coolLeft }) : t("dash.refreshH")}
          disabled={coolLeft > 0}
          onClick={() => {
            setCoolUntil(Date.now() + DASH_REFRESH_COOLDOWN_MS);
            setNowTick(Date.now());
            load(period, true);
          }}
          busy={loading && !!data}
          testId="dash-refresh"
        />
      </div>
      <CriticalAlerts reloadKey={reloadKey} />
      {error && !data ? (
        <LoadError
          error={error}
          onRetry={() => load(period)}
          testId="dash-error"
        />
      ) : null}
      {!data && loading && !error && <Spinner label={t("common.loading")} />}
      {data && (
        <div className="dash2" aria-busy={loading}>
          {rows.map((r, n) => (
            <div
              key={n}
              className="dash-row"
              style={{
                gridTemplateColumns: r
                  .map((x) => `minmax(0,${x.span}fr)`)
                  .join(" "),
              }}
            >
              {r.map((x) => render(x.id, x.span))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** «данные на 03:42»: the oldest block copy; amber with a clock when some blocks are stale, red when some have no data */
function Freshness({ d }: { d: DashboardV2 }) {
  const i = useI18n();
  const { t, fmt } = i;
  const f = dashFreshness(d);
  const tone = f.off ? "bad" : f.stale ? "warn" : "good";
  const parts = [f.stale ? i.tp("dash.fresh.stale", f.stale) : null, f.off ? i.tp("dash.fresh.off", f.off) : null].filter(Boolean);
  return (
    <span className={cx("dash-updated", `is-${tone}`)} data-testid="dash-fresh" data-tone={tone} title={t("dash.fresh.h")}>
      {tone === "good" ? <span className="live" aria-hidden="true" /> : <Icon name={tone === "bad" ? "alertCircle" : "clock"} />}
      <span>
        {t("dash.fresh.asOf", { t: fmt.time(f.asOf) })}
        {parts.length > 0 && <b> · {parts.join(" · ")}</b>}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- blocks

function UsersBody({ u, period }: { u: DashboardUsers; period: string }) {
  const { t, fmt } = useI18n();
  const total = Math.max(
    1,
    STATUS_ORDER.reduce((a, k) => a + (u.by_status[k] ?? 0), 0),
  );
  return (
    <div className="statband dash-band-3">
      <Stat
        label={t("dash.users.total")}
        value={fmt.num(u.total)}
        sub={<span className="scope">{t("dash.now")}</span>}
        testId="kpi-users-total"
      />
      <Stat
        label={t("dash.users.new")}
        value={fmt.num(u.new_in_period)}
        sub={period}
        testId="kpi-users-new"
      />
      <Stat
        label={t("dash.users.active")}
        value={fmt.num(u.active_in_period)}
        sub={t("dash.users.today", { n: fmt.num(u.active_today) })}
        testId="kpi-users-active"
      />
      <Stat
        wide
        label={t("dash.users.byStatus")}
        value={
          <>
            {STATUS_ORDER.map((k, idx) => (
              <span key={k}>
                {idx > 0 && <span className="slash">/</span>}
                {fmt.num(u.by_status[k] ?? 0)}
              </span>
            ))}
            <span className="dash-onb">
              {t("dash.users.onb", {
                v: fmt.num(u.onboarding_completed_pct, 0),
              })}
            </span>
          </>
        }
        sub={
          <span className="stack sm" style={{ width: "100%", gap: 4 }}>
            <span className="splitbar" aria-hidden="true">
              {STATUS_ORDER.map((k, idx) =>
                (u.by_status[k] ?? 0) > 0 ? (
                  <span
                    key={k}
                    className={`sw-${idx + 1}`}
                    style={{
                      width: `${((u.by_status[k] ?? 0) / total) * 100}%`,
                    }}
                  />
                ) : null,
              )}
            </span>
            <span className="legend">
              {STATUS_ORDER.map((k, idx) => (
                <span key={k}>
                  <i className={`sw-${idx + 1}`} />
                  {t(`ustatus.${k}`)}
                </span>
              ))}
            </span>
          </span>
        }
      />
    </div>
  );
}

function AiBody({ a }: { a: DashboardAi }) {
  const { t, fmt } = useI18n();
  const k = a.kpi;
  return (
    <>
      <div className="statband dash-band-3">
        <Stat
          label={t("dash.ai.cost")}
          value={fmtUsd(k.total_cost_usd, 2)}
          sub={t("dash.ai.costS", {
            llm: fmtUsd(k.llm_cost_usd, 2),
            ext: fmtUsd(k.external_cost_usd, 2),
          })}
          testId="dash-ai-cost"
        />
        <Stat
          label={t("dash.ai.requests")}
          value={fmt.num(k.requests)}
          sub={
            k.success_rate != null
              ? t("dash.ai.success", { v: fmt.pct(k.success_rate * 100) })
              : undefined
          }
          testId="dash-ai-requests"
        />
        <Stat
          label="p95"
          value={
            k.p95_ms != null
              ? t("ai.sec", { n: fmt.num(Math.round(k.p95_ms / 100) / 10, 1) })
              : "—"
          }
          sub={
            k.unpriced_calls ? (
              <span className="txt-warn ico-inline">
                <Icon name="alert" /> {t("dash.ai.unpriced", { n: k.unpriced_calls })}
              </span>
            ) : (
              t("dash.ai.users", { n: fmt.num(k.active_users) })
            )
          }
          testId="dash-ai-p95"
        />
      </div>
      {a.budgets ? (
        <ul className="dash-budgets" data-testid="dash-ai-budgets">
          {a.budgets.provider_paused && (
            <li className="is-bad">
              <Icon name="power" /> {t("dash.ai.providerPaused")}
            </li>
          )}
          {a.budgets.agents.slice(0, 4).map((x) => (
            <li key={x.agent_id}>
              <span className="grow">
                {/* the agent name comes from ai-control (data, not translated) */}
                <span className="wrap-any">{x.name}</span>
                {x.paused && (
                  <span className="xs txt-bad"> · {t("ai.state.paused")}</span>
                )}
              </span>
              <span className="dash-budget-m">
                <BudgetMeter pct={x.day?.pct ?? null} compact />
              </span>
              <span className="xs muted mono nowrap">
                {x.day
                  ? `${fmtUsd(x.day.spent_usd, 2)} / ${fmtUsd(x.day.limit_usd, 2)}`
                  : "—"}
              </span>
            </li>
          ))}
          <li className="dash-budgets-note xs muted" data-testid="dash-ai-utc">
            <Icon name="clock" /> {t("dash.ai.utc")}
          </li>
        </ul>
      ) : (
        <p className="xs muted dash-pad">{t("dash.ai.noBudgets")}</p>
      )}
    </>
  );
}

function Bars({
  items,
  testId,
}: {
  items: Array<{ k: string; label: string; v: number; tone?: string }>;
  testId?: string;
}) {
  const { fmt } = useI18n();
  const max = Math.max(1, ...items.map((x) => x.v));
  return (
    <ul className="dash-bars" data-testid={testId}>
      {items.map((x) => (
        <li key={x.k}>
          <span className="lbl">{x.label}</span>
          <span className="bar" aria-hidden="true">
            <i className={x.tone} style={{ width: `${(x.v / max) * 100}%` }} />
          </span>
          <b className="mono">{fmt.num(x.v)}</b>
        </li>
      ))}
    </ul>
  );
}

function TripsBody({ x }: { x: TripsStats }) {
  const { t, fmt } = useI18n();
  const budgetTotal = x.budget.within + x.budget.over;
  const tierTotal = Math.max(
    1,
    x.by_recommended_tier.economy +
      x.by_recommended_tier.comfort +
      x.by_recommended_tier.premium,
  );
  return (
    <>
      <div className="statband dash-band-3">
        <Stat
          label={t("dash.trips.builds")}
          value={fmt.num(x.builds)}
          sub={t("dash.trips.reused", { v: share(x.reused_share, fmt) })}
          testId="dash-trips-builds"
        />
        <Stat
          label={t("dash.trips.complete")}
          value={share(x.complete_share, fmt)}
          sub={t("dash.trips.completeS", { n: fmt.num(x.by_trip_kind.trip) })}
        />
        <Stat
          label={t("dash.trips.budget")}
          value={
            <>
              {fmt.num(x.budget.within)}
              <span className="slash">/</span>
              {fmt.num(x.budget.over)}
            </>
          }
          tone={
            budgetTotal && x.budget.over / budgetTotal > 0.5
              ? "warn"
              : undefined
          }
          sub={t("dash.trips.budgetS", { n: fmt.num(x.budget.with_budget) })}
        />
      </div>
      <div className="grid-2 dash-pad dash-trips-split">
        <div>
          <div className="dash-sub-h">{t("dash.trips.channels")}</div>
          <Bars
            testId="dash-trips-channels"
            items={[
              {
                k: "tg",
                label: t("dash.trips.ch.telegram-bff"),
                v: x.by_caller["telegram-bff"],
              },
              {
                k: "watch",
                label: t("dash.trips.ch.watch"),
                v: x.by_caller.watch,
              },
              {
                k: "ai",
                label: t("dash.trips.ch.ai-concierge"),
                v: x.by_caller["ai-concierge"],
              },
            ]}
          />
        </div>
        <div>
          <div className="dash-sub-h">{t("dash.trips.kinds")}</div>
          <Bars
            items={[
              {
                k: "trip",
                label: t("dash.trips.k.trip"),
                v: x.by_trip_kind.trip,
              },
              {
                k: "ticket",
                label: t("dash.trips.k.ticket_only"),
                v: x.by_trip_kind.ticket_only,
              },
              {
                k: "na",
                label: t("dash.trips.k.not_available"),
                v: x.by_trip_kind.not_available,
                tone: "muted",
              },
              {
                k: "nf",
                label: t("dash.trips.k.no_flight"),
                v: x.no_flight_total,
                tone: "warn",
              },
            ]}
          />
        </div>
        <div className="dash-trips-tiers">
          <div className="dash-sub-h">{t("dash.trips.tiers")}</div>
          <span
            className="splitbar"
            role="img"
            aria-label={`${t("dash.trips.t.economy")} ${x.by_recommended_tier.economy}, ${t("dash.trips.t.comfort")} ${x.by_recommended_tier.comfort}, ${t("dash.trips.t.premium")} ${x.by_recommended_tier.premium}`}
          >
            {(["economy", "comfort", "premium"] as const).map((k, idx) =>
              x.by_recommended_tier[k] > 0 ? (
                <span
                  key={k}
                  className={`sw-${idx + 1}`}
                  style={{
                    width: `${(x.by_recommended_tier[k] / tierTotal) * 100}%`,
                  }}
                />
              ) : null,
            )}
          </span>
          <span className="legend">
            {(["economy", "comfort", "premium"] as const).map((k, idx) => (
              <span key={k}>
                <i className={`sw-${idx + 1}`} />
                {t(`dash.trips.t.${k}`)}{" "}
                <b>{fmt.num(x.by_recommended_tier[k])}</b>
              </span>
            ))}
          </span>
        </div>
      </div>
    </>
  );
}

function NoFlightBody({ x }: { x: NoFlightStats }) {
  const i = useI18n();
  const { t, fmt } = i;
  const bandTotal = Math.max(
    1,
    x.bands.lt600 + x.bands.ge600 + x.bands.unknown,
  );
  const reasons = Object.entries(x.by_reason).sort((a, b) => b[1] - a[1]);
  if (!x.total)
    return (
      <div className="dash-nodata is-ok" data-testid="dash-nf-none">
        <span className="dash-nodata-ico" aria-hidden="true">
          <Icon name="checkCircle" />
        </span>
        <div>
          <div className="t">{t("dash.nf.noneT")}</div>
          <div className="m">{t("dash.nf.noneM")}</div>
        </div>
      </div>
    );
  return (
    <div className="dash-pad stack sm" data-testid="dash-nf">
      <div className="dash-nf-head">
        <div>
          <div className="stat-ln">{t("dash.nf.total")}</div>
          <div className="stat-v">{fmt.num(x.total)}</div>
        </div>
        <div className="grow">
          <span
            className="splitbar dash-bands"
            role="img"
            aria-label={t("dash.nf.bandsA", {
              lt: x.bands.lt600,
              ge: x.bands.ge600,
              un: x.bands.unknown,
            })}
          >
            {x.bands.lt600 > 0 && (
              <span
                className="b-lt"
                style={{ width: `${(x.bands.lt600 / bandTotal) * 100}%` }}
              />
            )}
            {x.bands.ge600 > 0 && (
              <span
                className="b-ge"
                style={{ width: `${(x.bands.ge600 / bandTotal) * 100}%` }}
              />
            )}
            {x.bands.unknown > 0 && (
              <span
                className="b-un"
                style={{ width: `${(x.bands.unknown / bandTotal) * 100}%` }}
              />
            )}
          </span>
          <span className="legend">
            <span>
              <i className="b-lt" />
              {t("dash.nf.lt600")} <b>{fmt.num(x.bands.lt600)}</b>
            </span>
            <span>
              <i className="b-ge" />
              {t("dash.nf.ge600")} <b>{fmt.num(x.bands.ge600)}</b>
            </span>
            <span>
              <i className="b-un" />
              {t("dash.nf.unknown")} <b>{fmt.num(x.bands.unknown)}</b>
            </span>
          </span>
        </div>
      </div>
      <div className="dash-chips" aria-label={t("dash.nf.reasons")}>
        {reasons.map(([k, v]) => (
          <span key={k} className="tag" title={tOr(i, `dash.nf.r.${k}.h`, k)}>
            {tOr(i, `dash.nf.r.${k}`, k)} <b>{fmt.num(v)}</b>
          </span>
        ))}
      </div>
      <table className="tbl compact dash-pairs" data-testid="dash-nf-pairs">
        <caption className="sr-only">{t("dash.nf.pairs")}</caption>
        <thead>
          <tr>
            <th>{t("dash.nf.col.route")}</th>
            <th className="num">{t("dash.nf.col.km")}</th>
            <th className="num">{t("dash.nf.col.n")}</th>
          </tr>
        </thead>
        <tbody>
          {x.pairs.slice(0, 6).map((p) => (
            <tr
              key={`${p.origin_iata}-${p.dest_city}-${p.dest_country}`}
              data-testid="dash-nf-pair"
            >
              <td>
                <span className="nowrap">
                  {p.origin_city ?? p.origin_iata ?? "—"} <Icon name="right" />{" "}
                  {p.dest_city ?? p.dest_iata ?? "—"}
                </span>
                <span className="block xs muted mono">
                  {p.origin_iata ?? "—"}–{p.dest_iata ?? "—"}
                  {p.dest_country && p.dest_country !== p.origin_country
                    ? ` · ${p.dest_country}`
                    : ""}
                  {Object.keys(p.by_reason).length > 0 &&
                    ` · ${Object.keys(p.by_reason)
                      .map((r) => tOr(i, `dash.nf.r.${r}`, r))
                      .join(", ")}`}
                </span>
              </td>
              <td className="num nowrap">
                {p.distance_km == null
                  ? "—"
                  : t("dash.nf.km", { n: fmt.num(p.distance_km) })}
                <span
                  className={cx(
                    "block xs",
                    p.band === "lt600" ? "txt-good" : "muted",
                  )}
                >
                  {t(`dash.nf.band.${p.band}`)}
                </span>
              </td>
              <td className="num">
                <b>{fmt.num(p.count)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="xs muted">{t("dash.nf.note")}</p>
    </div>
  );
}

/** A45: the schedule of Watch re-checks (n8n): a past next run is shown as «late», not as an error */
function WatchBody({ x }: { x: WatchStats }) {
  const { t, fmt } = useI18n();
  const changes = Object.values(x.changes_24h).reduce((a, b) => a + b, 0);
  const late = x.next_batch_at
    ? Date.now() - Date.parse(x.next_batch_at) > 15 * 60_000
    : false;
  return (
    <div className="statband dash-band-2">
      <Stat
        label={t("dash.watch.active")}
        value={fmt.num(x.active)}
        sub={t("dash.watch.paused", { n: fmt.num(x.paused) })}
        testId="dash-watch-active"
      />
      <Stat
        label={t("dash.watch.changes")}
        value={fmt.num(changes)}
        sub={t("dash.watch.notif", {
          n: fmt.num(
            x.notifications_24h.immediate + x.notifications_24h.digest,
          ),
        })}
      />
      <Stat
        label={t("dash.watch.rechecks")}
        value={fmt.num(x.rechecks_24h)}
        sub={
          x.errors_24h ? (
            <span className="txt-warn">
              {t("dash.watch.errors", { n: x.errors_24h })}
            </span>
          ) : (
            t("dash.watch.noErrors")
          )
        }
      />
      <Stat
        label={t("dash.watch.next")}
        value={x.next_batch_at ? fmt.time(x.next_batch_at) : "—"}
        tone={late ? "warn" : undefined}
        sub={
          x.next_batch_at
            ? late
              ? t("dash.watch.late", { t: fmt.rel(x.next_batch_at) })
              : fmt.rel(x.next_batch_at)
            : t("dash.watch.noSchedule")
        }
        testId="dash-watch-next"
      />
    </div>
  );
}

function NewsBody({ x }: { x: NewsStats }) {
  const { t, fmt } = useI18n();
  const old = x.last_collect_at
    ? Date.now() - Date.parse(x.last_collect_at) > 3 * 3_600_000
    : false;
  return (
    <div className="statband dash-band-2">
      <Stat
        label={t("dash.news.items")}
        value={fmt.num(x.items.article + x.items.event_update)}
        sub={t("dash.news.itemsS", {
          a: fmt.num(x.items.article),
          u: fmt.num(x.items.event_update),
        })}
        testId="dash-news-items"
      />
      <Stat
        label={t("dash.news.hidden")}
        value={fmt.num(x.hidden)}
        sub={t("dash.news.hiddenS")}
      />
      <Stat
        label={t("dash.news.sources")}
        value={fmt.num(x.sources.enabled)}
        sub={
          x.sources.problem ? (
            <span className="txt-warn">
              {t("dash.news.problem", { n: x.sources.problem })}
            </span>
          ) : (
            t("dash.news.disabled", { n: x.sources.disabled })
          )
        }
      />
      <Stat
        label={t("dash.news.last")}
        value={x.last_collect_at ? fmt.time(x.last_collect_at) : "—"}
        sub={
          x.last_collect_at
            ? old
              ? t("dash.news.old", { t: fmt.rel(x.last_collect_at) })
              : fmt.rel(x.last_collect_at)
            : t("dash.news.never")
        }
        tone={old ? "warn" : undefined}
        testId="dash-news-last"
      />
    </div>
  );
}

function SupportBody({ s, period }: { s: SupportStats; period: string }) {
  const { t, fmt } = useI18n();
  return (
    <div className="statband dash-band-2">
      <Stat
        label={t("dash.support.openN")}
        value={fmt.num(s.open)}
        sub={t("dash.support.inWork", {
          n: fmt.num(s.in_progress),
          w: fmt.num(s.waiting_customer),
        })}
        testId="kpi-support-open"
      />
      <Stat
        label={t("dash.support.breached")}
        value={fmt.num(s.breached)}
        tone={s.breached > 0 ? "bad" : undefined}
        sub={
          s.breached > 0 ? (
            <span className="pill bad">{t("dash.support.needReply")}</span>
          ) : (
            t("dash.support.noBreach")
          )
        }
        testId="kpi-support-breached"
      />
      <Stat
        label={t("dash.support.first")}
        value={fmt.minutes(s.avg_first_response_minutes)}
        sub={t("dash.avgFor", { p: period })}
      />
      <Stat
        label={t("dash.support.resolution")}
        value={fmt.minutes(s.avg_resolution_minutes)}
        sub={t("dash.avgFor", { p: period })}
      />
    </div>
  );
}

function SystemBody({
  s,
  go,
  goDeletions,
}: {
  s: OpsSummary;
  go: (id: string) => (() => void) | undefined;
  /** sprint 9: «Users → Deletions» (users.read), undefined — no right */
  goDeletions?: () => void;
}) {
  const i = useI18n();
  const { t, fmt } = i;
  const tile = (
    testId: string,
    label: string,
    value: ReactNode,
    sub: ReactNode,
    tone: "bad" | "warn" | undefined,
    target: string,
  ) => {
    const f = go(target);
    const body = (
      <>
        <span className="stat-ln">{label}</span>
        <span className="stat-v">
          <ToneMark tone={tone} />
          {value}
        </span>
        <span className="stat-s">{sub}</span>
      </>
    );
    return f ? (
      <button
        type="button"
        className={cx("dash-sys-tile", tone && `is-${tone}`)}
        onClick={f}
        data-testid={testId}
      >
        {body}
      </button>
    ) : (
      <div
        className={cx("dash-sys-tile", tone && `is-${tone}`)}
        data-testid={testId}
      >
        {body}
      </div>
    );
  };
  const p = s.providers;
  return (
    <>
      <div className="dash-sys">
        {tile(
          "dash-sys-providers",
          t("dash.sys.providers"),
          p ? `${p.ok + p.idle} / ${p.ok + p.idle + p.degraded + p.down}` : "—",
          p
            ? p.down || p.degraded
              ? t("dash.sys.providersBad", { down: p.down, deg: p.degraded })
              : t("dash.sys.ok")
            : t("dash.sys.noSnap"),
          p?.down ? "bad" : p?.degraded ? "warn" : undefined,
          "providers",
        )}
        {tile(
          "dash-sys-services",
          t("dash.sys.services"),
          s.services ? `${s.services.up} / ${s.services.total}` : "—",
          s.services
            ? s.services.down.length || s.services.stale?.length
              ? [
                  s.services.down.slice(0, 3).join(", "),
                  s.services.stale?.length ? t("dash.sys.staleSvc", { s: s.services.stale.slice(0, 3).join(", ") }) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : t("dash.sys.ok")
            : t("dash.sys.noSnap"),
          s.services?.down.length || s.services?.stale?.length ? "warn" : undefined,
          "queues",
        )}
        {tile(
          "dash-sys-queues",
          t("dash.sys.queues"),
          s.queues ? fmt.num(s.queues.total_pending) : "—",
          s.queues
            ? s.queues.lagging + s.queues.stalled
              ? t("dash.sys.lagging", {
                  n: s.queues.lagging + s.queues.stalled,
                })
              : t("dash.sys.noLag")
            : t("dash.sys.noSnap"),
          s.queues?.stalled ? "bad" : s.queues?.lagging ? "warn" : undefined,
          "queues",
        )}
        {tile(
          "dash-sys-dlq",
          "DLQ",
          s.queues ? fmt.num(s.queues.dlq_messages) : "—",
          s.queues
            ? t("dash.sys.dlqNew", { n: s.queues.dlq_new_24h })
            : t("dash.sys.noSnap"),
          s.queues?.dlq_messages ? "warn" : undefined,
          "dlq",
        )}
        {tile(
          "dash-sys-outbox",
          "Outbox",
          s.outbox ? fmt.num(s.outbox.pending) : "—",
          s.outbox
            ? s.outbox.stuck_services.length
              ? t("dash.sys.stuck", { s: s.outbox.stuck_services.join(", ") })
              : s.outbox.failing
                ? t("dash.sys.failing", { n: s.outbox.failing })
                : t("dash.sys.ok")
            : t("dash.sys.noSnap"),
          s.outbox?.stuck_services.length ? "warn" : undefined,
          "queues",
        )}
        {tile(
          "dash-sys-alerts",
          t("dash.sys.alerts"),
          fmt.num(s.alerts.critical + s.alerts.warning + s.alerts.info),
          t("dash.sys.alertsS", { c: s.alerts.critical, w: s.alerts.warning }),
          s.alerts.critical ? "bad" : s.alerts.warning ? "warn" : undefined,
          "alerts",
        )}
      </div>
      {p && p.items.length > 0 && (
        <ul className="dash-prov" data-testid="dash-sys-prov">
          {p.items.map((x) => (
            <li key={x.provider}>
              <span
                className={cx(
                  "pill",
                  STATUS_TONE[x.status] !== "neutral" && STATUS_TONE[x.status],
                  "mon-status",
                )}
                data-status={x.status}
              >
                <Icon name={STATUS_ICON[x.status]} />
                {tOr(i, `mon.prov.${x.provider}`, x.provider)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {s.deletions && (
        <div className={cx("dash-sys-del", s.deletions.stuck ? "is-bad" : "")} data-testid="dash-sys-deletions">
          <Icon name={s.deletions.stuck ? "alertCircle" : "userCheck"} />
          <span className="grow">
            <b>{t("dash.sys.deletions")}</b>{" "}
            {!s.deletions.available && s.deletions.open == null
              ? t("dash.sys.noSnap")
              : s.deletions.stuck
                ? t("dash.sys.deletionsStuck", { s: s.deletions.stuck, o: s.deletions.open ?? "—" })
                : t("dash.sys.deletionsOk", { o: s.deletions.open ?? 0 })}
            {!s.deletions.available && s.deletions.open != null && <span className="xs muted"> · {t("dash.sys.deletionsOld")}</span>}
          </span>
          {goDeletions && <Btn size="xs" kind="ghost" icon="right" label={t("dash.open")} onClick={goDeletions} testId="dash-sys-deletions-open" />}
        </div>
      )}
    </>
  );
}
