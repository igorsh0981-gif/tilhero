import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiAgentUsage, AiKpi, AiRequestRow, AiRequestStatus } from "@tilhero/contracts/admin";
import { UsageApi, type UsagePeriod } from "../../api/endpoints";
import { useI18n, type MessageKey } from "../../i18n";
import { shortId } from "../../lib/ids";
import { fmtUsd } from "../../lib/money";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Seg, Select, Spinner, TabPanel, Tabs } from "../../ui/kit";
import { fmtCompact, isUuid, parseRequestsRoute, pct100, REQ_TONE } from "./ai";
import { BudgetMeter, Kpi, Ms, QuotaMark, requestStatusText } from "./parts";
import { RequestDrawer } from "./RequestDrawer";
import { PriceCatalog } from "./PriceCatalog";

type Tab = "agents" | "log" | "pricing";
const STATUSES: readonly AiRequestStatus[] = ["SUCCESS", "PARTIAL", "FAILED", "ERROR"];

/**
 * «Requests and cost» (sprint 7, ai-control usage-metering / cost-accounting): KPI of the period, agents with their
 * daily budget (70 / 90 / 100 %), the log of AI requests with filters and a drill-down (cost by the price catalogue
 * version of the usage, tool timeline, content only with ai.content.read + reason + audit), the price catalogue.
 */
export function RequestsPage({ openId }: { openId: string | null }) {
  const i = useI18n();
  const { t, fmt, lang } = i;
  const { navigate } = useNav();
  const route = parseRequestsRoute(openId);
  const [period, setPeriod] = useState<UsagePeriod>("7d");
  const [tab, setTab] = useState<Tab>(route.user ? "log" : "agents");
  const [kpi, setKpi] = useState<AiKpi | null>(null);
  const [usage, setUsage] = useState<AiAgentUsage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [agentFilter, setAgentFilter] = useState("");
  const [userFilter, setUserFilter] = useState(route.user ?? "");

  useEffect(() => {
    if (route.user) {
      setUserFilter(route.user);
      setTab("log");
    }
  }, [route.user]);

  const load = useCallback(async (p: UsagePeriod) => {
    setLoading(true);
    try {
      const [k, u] = await Promise.all([UsageApi.kpi(p), UsageApi.agents(p)]);
      setKpi(k);
      setUsage(u);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(period);
  }, [period, load]);

  const agents = usage?.items ?? [];
  const nameOf = useCallback((id: string) => agents.find((a) => a.agent_id === id)?.name ?? id, [agents]);

  return (
    <div data-testid="requests">
      <div className="page-head">
        <div className="lead">
          <p>{t("req.lead")}</p>
        </div>
        <div className="acts">
          <Btn kind="ghost" icon="refresh" label={t("common.refresh")} busy={loading && !!kpi} onClick={() => void load(period)} testId="req-refresh" />
        </div>
      </div>
      <div className="toolbar">
        <Seg<UsagePeriod>
          label={t("req.period")}
          value={period}
          onChange={setPeriod}
          testId="req-period"
          items={(["today", "7d", "30d"] as const).map((v) => ({ v, label: t(`dash.period.${v}`) }))}
        />
        {kpi && (
          <span className="xs muted" data-testid="req-range">
            {fmt.date(kpi.from)} — {fmt.date(new Date(Date.parse(kpi.to) - 1).toISOString())} · UTC
          </span>
        )}
      </div>
      {error ? (
        <div className="mb-12">
          <LoadError error={error} onRetry={() => void load(period)} testId="req-error" />
        </div>
      ) : null}
      {kpi && (
        <section className="panel mb-16" aria-label={t("req.kpi")} data-testid="req-kpi">
          <div className="statband ai-kpis">
            <Kpi
              label={t("req.k.requests")}
              value={fmt.num(kpi.requests)}
              sub={
                kpi.success_rate != null
                  ? t("req.k.requestsS", { ok: fmt.pct(pct100(kpi.success_rate)!), retry: fmt.pct(pct100(kpi.retry_rate) ?? 0) })
                  : t("req.k.noData")
              }
              testId="kpi-requests"
            />
            <Kpi
              label={t("req.k.cost")}
              value={fmtUsd(kpi.total_cost_usd, 2)}
              sub={t("req.k.costS", { llm: fmtUsd(kpi.llm_cost_usd, 2), ext: fmtUsd(kpi.external_cost_usd, 2) })}
              testId="kpi-cost"
            />
            <Kpi
              label={t("req.k.avg")}
              value={fmtUsd(kpi.avg_cost_per_request, 4)}
              sub={kpi.cost_per_active_user ? t("req.k.avgS", { v: fmtUsd(kpi.cost_per_active_user, 4), n: fmt.num(kpi.active_users) }) : t("req.k.noUsers")}
              testId="kpi-avg"
            />
            <Kpi
              label={t("req.k.tokens")}
              value={
                <>
                  {fmtCompact(kpi.tokens_in, fmt.locale)}
                  <span className="slash">/</span>
                  {fmtCompact(kpi.tokens_out, fmt.locale)}
                </>
              }
              sub={t("req.k.tokensS", { r: fmtCompact(kpi.cache_read, fmt.locale), w: fmtCompact(kpi.cache_write, fmt.locale) })}
              testId="kpi-tokens"
            />
            <Kpi
              label={t("req.k.latency")}
              value={
                <>
                  <Ms ms={kpi.p50_ms} />
                  <span className="slash">/</span>
                  <Ms ms={kpi.p95_ms} />
                </>
              }
              sub={t("req.k.latencyS")}
              testId="kpi-latency"
            />
            {kpi.unpriced_calls > 0 && (
              <Kpi label={t("req.k.unpriced")} value={fmt.num(kpi.unpriced_calls)} sub={t("req.k.unpricedS")} tone="bad" testId="kpi-unpriced" />
            )}
          </div>
        </section>
      )}
      {!kpi && loading && !error && <Spinner label={t("common.loading")} />}

      <Tabs<Tab>
        id="req"
        label={t("page.requests")}
        value={tab}
        onChange={setTab}
        items={[
          { v: "agents", label: t("req.tab.agents"), icon: "cpu", testId: "req-tab-agents" },
          { v: "log", label: t("req.tab.log"), icon: "activity", testId: "req-tab-log" },
          { v: "pricing", label: t("req.tab.pricing"), icon: "coins", testId: "req-tab-pricing" },
        ]}
      />
      <TabPanel id="req" value={tab}>
        {tab === "agents" && (
          <AgentsUsage
            usage={usage}
            onOpen={(id) => {
              setAgentFilter(id);
              setTab("log");
            }}
          />
        )}
        {tab === "log" && (
          <RequestLog
            period={period}
            agents={agents.map((a) => ({ id: a.agent_id, name: a.name }))}
            agent={agentFilter}
            setAgent={setAgentFilter}
            user={userFilter}
            setUser={setUserFilter}
            nameOf={nameOf}
            onOpen={(id) => navigate("requests", id)}
          />
        )}
        {tab === "pricing" && <PriceCatalog />}
      </TabPanel>
      {route.request && <RequestDrawer id={route.request} nameOf={nameOf} onClose={() => navigate("requests")} lang={lang} />}
    </div>
  );
}

function AgentsUsage({ usage, onOpen }: { usage: AiAgentUsage | null; onOpen: (agentId: string) => void }) {
  const { t, fmt } = useI18n();
  if (!usage) return null;
  if (!usage.items.length) return <Empty icon="cpu" title={t("req.agents.emptyT")} text={t("req.agents.emptyM")} />;
  return (
    <section className="panel" data-testid="req-agents">
      {usage.gateway === "unavailable" && (
        <div className="panel-b">
          <Callout kind="warn" icon="alert" testId="req-gw-down">
            {t("req.gwDown")}
          </Callout>
        </div>
      )}
      <div className="table-wrap">
        <table className="tbl ai-usage-tbl">
          <thead>
            <tr>
              <th>{t("req.col.agent")}</th>
              <th className="num">{t("req.col.requests")}</th>
              <th className="num">{t("req.col.success")}</th>
              <th className="num">{t("req.col.cost")}</th>
              <th className="num">{t("req.col.avg")}</th>
              <th className="num">p50 / p95</th>
              <th className="num">{t("req.col.cache")}</th>
              <th className="num">{t("req.col.ext")}</th>
              <th>{t("req.col.budget")}</th>
            </tr>
          </thead>
          <tbody>
            {usage.items.map((a) => (
              <tr key={a.agent_id} className="is-click" tabIndex={0} onClick={() => onOpen(a.agent_id)} onKeyDown={(e) => e.key === "Enter" && onOpen(a.agent_id)} data-testid="req-agent-row" data-agent={a.agent_id}>
                <td>
                  <b>{a.name}</b>
                  <span className="block xs muted mono">
                    {a.agent_id} · {t(`ai.kind.${a.kind}`)}
                    {a.code_managed && ` · ${t("ai.codeManaged")}`}
                  </span>
                </td>
                <td className="num">
                  {fmt.num(a.requests)}
                  <span className="block xs muted">{t("req.calls", { n: fmt.num(a.calls) })}</span>
                </td>
                <td className="num">{a.success_rate == null ? "—" : fmt.pct(pct100(a.success_rate)!)}</td>
                <td className="num">
                  <b>{fmtUsd(a.total_cost_usd, 2)}</b>
                </td>
                <td className="num">{fmtUsd(a.avg_cost_usd, 4)}</td>
                <td className="num nowrap">
                  <Ms ms={a.p50_ms} /> / <Ms ms={a.p95_ms} />
                </td>
                <td className="num">{fmtCompact(a.cache_read, fmt.locale)}</td>
                <td className="num">{a.external_api_share == null ? "—" : fmt.pct(pct100(a.external_api_share)!)}</td>
                <td className="ai-budget-cell">
                  {a.budget_today ? (
                    <>
                      <BudgetMeter pct={a.budget_today.pct} testId="req-agent-meter" />
                      <span className="xs muted block">
                        {fmtUsd(a.budget_today.spent_usd, 4)} / {fmtUsd(a.budget_today.limit_usd, 2)}
                      </span>
                    </>
                  ) : (
                    <span className="xs muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel-f ai-foot">
        <Icon name="info" /> {t("req.agents.foot")}
      </div>
    </section>
  );
}

function RequestLog(p: {
  period: UsagePeriod;
  agents: Array<{ id: string; name: string }>;
  agent: string;
  setAgent: (v: string) => void;
  user: string;
  setUser: (v: string) => void;
  nameOf: (id: string) => string;
  onOpen: (id: string) => void;
}) {
  const i = useI18n();
  const { t, fmt } = i;
  const { navigate } = useNav();
  const { can } = useSession();
  const [status, setStatus] = useState<AiRequestStatus | "">("");
  const [model, setModel] = useState("");
  const [userInput, setUserInput] = useState(p.user);
  const [rows, setRows] = useState<AiRequestRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const req = useRef(0);
  useEffect(() => setUserInput(p.user), [p.user]);

  const userBad = !!userInput.trim() && !isUuid(userInput);
  const modelBad = !!model.trim() && !/^[a-z0-9][a-z0-9.\-_]{2,63}$/.test(model.trim());
  const f = useMemo(
    () => ({ period: p.period, agent: p.agent || undefined, status, model: modelBad ? undefined : model.trim() || undefined, user_id: p.user || undefined }),
    [p.period, p.agent, status, model, modelBad, p.user],
  );
  const fKey = JSON.stringify(f);
  const load = useCallback(async (filters: typeof f, more: string | null) => {
    const id = ++req.current;
    setLoading(true);
    try {
      const page = await UsageApi.requests({ ...filters, cursor: more });
      if (id !== req.current) return;
      setRows((xs) => (more ? [...xs, ...page.items] : page.items));
      setCursor(page.next_cursor);
      setError(null);
    } catch (e) {
      if (id === req.current) setError(e);
    } finally {
      if (id === req.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(JSON.parse(fKey) as typeof f, null);
  }, [fKey, load]);

  const filtered = !!(p.agent || status || model || p.user);
  const reset = () => {
    p.setAgent("");
    setStatus("");
    setModel("");
    p.setUser("");
    setUserInput("");
  };

  return (
    <div data-testid="req-log">
      <div className="toolbar">
        <Select
          id="req-agent"
          label={t("req.col.agent")}
          value={p.agent}
          onChange={p.setAgent}
          testId="req-f-agent"
          options={[{ v: "", label: t("req.f.allAgents") }, ...p.agents.map((a) => ({ v: a.id, label: a.name }))]}
        />
        <Select<AiRequestStatus | "">
          id="req-status"
          label={t("col.status")}
          value={status}
          onChange={setStatus}
          testId="req-f-status"
          options={[{ v: "", label: t("req.f.allStatuses") }, ...STATUSES.map((s) => ({ v: s, label: t(`req.st.${s}`) }))]}
        />
        <div className="field inline-field">
          <input
            className={cx("input mono", modelBad && "is-invalid")}
            placeholder={t("req.f.model")}
            aria-label={t("req.f.model")}
            value={model}
            maxLength={64}
            onChange={(e) => setModel(e.target.value)}
            data-testid="req-f-model"
          />
        </div>
        <div className="field inline-field">
          <input
            className={cx("input mono", userBad && "is-invalid")}
            placeholder={t("req.f.user")}
            aria-label={t("req.f.user")}
            value={userInput}
            maxLength={40}
            onChange={(e) => {
              setUserInput(e.target.value);
              const v = e.target.value.trim();
              if (!v) p.setUser("");
              else if (isUuid(v)) p.setUser(v.toLowerCase());
            }}
            data-testid="req-f-user"
          />
        </div>
        <Btn kind="ghost" size="sm" label={t("common.resetFilters")} onClick={reset} disabled={!filtered} testId="req-reset" />
      </div>
      {(userBad || modelBad) && <FieldErr msg={userBad ? t("req.f.userBad") : t("req.f.modelBad")} />}
      {error ? (
        <div className="mb-12">
          <LoadError error={error} onRetry={() => void load(f, null)} testId="req-log-error" />
        </div>
      ) : null}
      <section className="panel" aria-busy={loading}>
        <div className="table-wrap">
          <table className="tbl ai-log-tbl" data-testid="req-table">
            <thead>
              <tr>
                <th>{t("req.col.request")}</th>
                <th>{t("req.col.time")}</th>
                <th>{t("req.col.agent")}</th>
                <th>{t("req.col.user")}</th>
                <th>{t("req.col.model")}</th>
                <th className="num">{t("req.col.tokens")}</th>
                <th className="num">{t("req.col.tools")}</th>
                <th className="num">{t("req.col.cost")}</th>
                <th className="num">{t("req.col.duration")}</th>
                <th>{t("col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.request_id}
                  className="is-click"
                  tabIndex={0}
                  onClick={() => p.onOpen(r.request_id)}
                  onKeyDown={(e) => e.key === "Enter" && p.onOpen(r.request_id)}
                  data-testid="req-row"
                  data-request={r.request_id}
                >
                  <td className="mono nowrap">{shortId(r.request_id, 8, 4)}</td>
                  <td className="nowrap" title={fmt.dateTime(r.occurred_at)}>
                    {p.period === "today" ? fmt.time(r.occurred_at) : fmt.dateTime(r.occurred_at)}
                  </td>
                  <td className="nowrap">
                    {p.nameOf(r.agent_id)}
                    {r.skill_version && <span className="xs muted mono"> v{r.skill_version}</span>}
                  </td>
                  <td className="mono">
                    {r.user_id ? (
                      can("users.read") ? (
                        <button
                          type="button"
                          className="link-btn mono"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate("users", r.user_id);
                          }}
                        >
                          {shortId(r.user_id, 8, 4)}
                        </button>
                      ) : (
                        shortId(r.user_id, 8, 4)
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="mono xs nowrap">
                    {r.model_used ?? "—"}
                    {r.fallback_used && (
                      <span className="block">
                        <Pill tone="warn" dot={false}>
                          {t("req.fallback")}
                        </Pill>
                      </span>
                    )}
                  </td>
                  <td className="num nowrap">
                    {fmt.num(r.tokens_in)} / {fmt.num(r.tokens_out)}
                  </td>
                  <td className="num">{fmt.num(r.tool_calls)}</td>
                  <td className="num">{fmtUsd(r.cost_usd, 4)}</td>
                  <td className="num nowrap">
                    <Ms ms={r.latency_ms} />
                  </td>
                  <td className="req-st-cell" title={requestStatusText((k) => t(k as MessageKey), r)} data-testid="req-status">
                    <Pill tone={REQ_TONE[r.status]}>{t(`req.st.${r.status}`)}</Pill>
                    {r.error_code && <span className="block xs muted mono wrap-any">{r.error_code}</span>}
                    <QuotaMark row={r} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && !rows.length && !error && (
          <div className="empty-cell">
            {filtered ? (
              <Empty icon="search" title={t("common.nothingFound")} text={t("common.changeFilters")} testId="req-empty-filtered">
                <Btn size="sm" label={t("common.resetFilters")} onClick={reset} />
              </Empty>
            ) : (
              <Empty icon="activity" title={t("req.empty.t")} text={t("req.empty.m")} testId="req-empty" />
            )}
          </div>
        )}
        {loading && <Spinner label={t("common.loading")} />}
        <div className="pager">
          <span>{t("src.shown", { n: rows.length })}</span>
          {cursor && !loading && <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(f, cursor)} testId="req-more" />}
        </div>
      </section>
      <p className="xs muted foot-note">
        <Icon name="lock" /> {t("req.log.foot")}
      </p>
    </div>
  );
}

