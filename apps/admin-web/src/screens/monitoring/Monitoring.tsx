import { useCallback, useEffect, useState } from "react";
import type { ConsumerInfo, OpsAlert, ProviderHealth } from "@tilhero/contracts/admin";
import { OpsApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { LoadError } from "../../ui/LoadError";
import { Btn, Empty, TabPanel, Tabs } from "../../ui/kit";
import { Kpi } from "../ai/parts";
import { monRoute, parseMonRoute, providerCounts, type MonTab } from "./ops";
import { ProvidersTab } from "./Providers";
import { QueuesTab } from "./Queues";
import { DlqTab } from "./Dlq";
import { AlertsTab } from "./Alerts";
import { LimitsTab } from "./Limits";

/** background refresh of the monitoring data (does not extend the idle session) */
export const MON_POLL_MS = 60_000;

export interface MonShared {
  providers: ProviderHealth[] | null;
  consumers: ConsumerInfo[] | null;
  alerts: OpsAlert[] | null;
  errors: { providers: unknown; consumers: unknown; alerts: unknown };
  reload: (background?: boolean) => void;
}

/**
 * «Monitoring» (sprint 8, ops-monitor): health of the providers (status, p50/p95, errors by type, «route not
 * supported», quota, history 24 h / 7 d, «Check now»), queues (consumers, streams, outbox, readiness), DLQ (masked view,
 * replay and delete with a reason, a typed count and TOTP; history of commands) and alerts. Reading — dashboard.read;
 * DLQ — ops.queues.manage. The Telegram alert button opens #/monitoring/providers or #/monitoring/queues.
 */
export function MonitoringPage({ openId }: { openId: string | null }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { navigate } = useNav();
  const route = parseMonRoute(openId);
  const tab = route.tab;
  const [providers, setProviders] = useState<ProviderHealth[] | null>(null);
  const [consumers, setConsumers] = useState<ConsumerInfo[] | null>(null);
  const [alerts, setAlerts] = useState<OpsAlert[] | null>(null);
  const [errors, setErrors] = useState<MonShared["errors"]>({ providers: null, consumers: null, alerts: null });
  const [off, setOff] = useState<unknown>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    const [p, c, a] = await Promise.allSettled([OpsApi.providers(background), OpsApi.consumers(background), OpsApi.alerts({ state: "open" }, background)]);
    const notConnected = [p, c, a].find((r) => r.status === "rejected" && r.reason instanceof ApiError && r.reason.code === "FEATURE_UNAVAILABLE");
    setOff(notConnected ? (notConnected as PromiseRejectedResult).reason : null);
    // a failed refresh keeps the last known data (and says so in its tab)
    if (p.status === "fulfilled") setProviders(p.value.items);
    if (c.status === "fulfilled") setConsumers(c.value.items);
    if (a.status === "fulfilled") setAlerts(a.value.items);
    setErrors({
      providers: p.status === "rejected" ? p.reason : null,
      consumers: c.status === "rejected" ? c.reason : null,
      alerts: a.status === "rejected" ? a.reason : null,
    });
    setUpdatedAt(new Date().toISOString());
    if (!background) setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(true), MON_POLL_MS);
    return () => clearInterval(id);
  }, [reload]);

  const shared: MonShared = { providers, consumers, alerts, errors, reload: (b) => void reload(b) };
  const counts = providers ? providerCounts(providers) : null;
  const pending = consumers?.reduce((s, c) => s + c.num_pending, 0) ?? null;
  const lagging = consumers?.filter((c) => c.status !== "ok").length ?? 0;
  const dlq = consumers?.reduce((s, c) => s + c.dlq.count, 0) ?? null;
  const openAlerts = alerts?.filter((x) => !x.acked_at) ?? null;
  const critical = openAlerts?.filter((x) => x.severity === "critical").length ?? 0;
  const setTab = (v: MonTab) => navigate("monitoring", monRoute(v));

  if (off)
    return (
      <div data-testid="monitoring">
        <section className="panel">
          <Empty icon="server" title={t("mon.offT")} text={t("mon.offM")} testId="mon-off">
            <LoadError error={off} onRetry={() => void reload()} />
          </Empty>
        </section>
      </div>
    );

  return (
    <div data-testid="monitoring" aria-busy={loading}>
      <div className="page-head">
        <div className="lead">
          <p>{t("mon.lead")}</p>
        </div>
        <div className="acts">
          {updatedAt && (
            <span className="dash-updated" data-testid="mon-updated">
              {t("common.updated")} {fmt.time(updatedAt)}
            </span>
          )}
          <Btn kind="ghost" icon="refresh" label={t("common.refresh")} busy={loading && !!providers} onClick={() => void reload()} testId="mon-refresh" />
        </div>
      </div>

      <section className="panel mb-16" aria-label={t("mon.summary")} data-testid="mon-summary">
        <div className="statband mon-kpis">
          <Kpi
            label={t("mon.k.providers")}
            value={counts ? `${counts.ok + counts.idle} / ${providers!.length - counts.not_configured}` : "—"}
            sub={
              counts
                ? counts.down + counts.degraded
                  ? t("mon.k.providersBad", { down: counts.down, degraded: counts.degraded })
                  : t("mon.k.providersOk")
                : t("mon.noData")
            }
            tone={counts?.down ? "bad" : counts?.degraded ? "warn" : undefined}
            testId="mon-k-providers"
          />
          <Kpi
            label={t("mon.k.queues")}
            value={pending == null ? "—" : fmt.num(pending)}
            sub={consumers ? (lagging ? t("mon.k.queuesBad", { n: lagging }) : t("mon.k.queuesOk", { n: consumers.length })) : t("mon.noData")}
            tone={lagging ? "warn" : undefined}
            testId="mon-k-queues"
          />
          <Kpi label={t("mon.k.dlq")} value={dlq == null ? "—" : fmt.num(dlq)} sub={t("mon.k.dlqS")} tone={dlq ? "warn" : undefined} testId="mon-k-dlq" />
          <Kpi
            label={t("mon.k.alerts")}
            value={openAlerts == null ? "—" : fmt.num(openAlerts.length)}
            sub={openAlerts ? (critical ? t("mon.k.alertsCrit", { n: critical }) : t("mon.k.alertsS")) : t("mon.noData")}
            title={t("mon.k.alertsH")}
            tone={critical ? "bad" : openAlerts?.length ? "warn" : undefined}
            testId="mon-k-alerts"
          />
        </div>
      </section>

      <Tabs<MonTab>
        id="mon"
        label={t("page.monitoring")}
        value={tab}
        onChange={setTab}
        items={[
          { v: "providers", label: t("mon.tab.providers"), icon: "zap", cnt: counts ? counts.down + counts.degraded || null : null, bad: !!counts?.down, testId: "mon-tab-providers" },
          { v: "queues", label: t("mon.tab.queues"), icon: "layers", cnt: lagging || null, bad: lagging > 0, testId: "mon-tab-queues" },
          { v: "dlq", label: t("mon.tab.dlq"), icon: "inbox", cnt: dlq || null, bad: !!dlq, testId: "mon-tab-dlq" },
          { v: "limits", label: t("mon.tab.limits"), icon: "gauge", testId: "mon-tab-limits" },
          { v: "alerts", label: t("mon.tab.alerts"), icon: "bell", cnt: openAlerts?.length || null, bad: critical > 0, testId: "mon-tab-alerts" },
        ]}
      />
      <TabPanel id="mon" value={tab}>
        {tab === "providers" && <ProvidersTab shared={shared} provider={route.provider} onOpen={(p) => navigate("monitoring", monRoute("providers", p))} />}
        {tab === "queues" && <QueuesTab shared={shared} onDlq={(c) => navigate("monitoring", c ? `dlq/${c}` : "dlq")} />}
        {tab === "dlq" && <DlqTab shared={shared} initialConsumer={openId?.startsWith("dlq/") ? openId.slice(4) : null} />}
        {tab === "limits" && <LimitsTab shared={shared} policy={route.policy} onOpen={(p) => navigate("monitoring", p ? `limits/${p}` : "limits")} />}
        {tab === "alerts" && <AlertsTab shared={shared} />}
      </TabPanel>
    </div>
  );
}
