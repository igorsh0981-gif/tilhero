import { useCallback, useEffect, useState } from "react";
import type { AlertFeed, AlertFeedItem } from "@tilhero/contracts/admin";
import { AiApi, AlertsApi } from "../api/endpoints";
import { ApiError } from "../api/errors";
import { useI18n } from "../i18n";
import { Icon } from "../ui/Icon";
import { Btn, cx } from "../ui/kit";
import { MenuButton } from "../ui/overlays";
import { useToast } from "../ui/toasts";
import { ackErrText, RunbookLink } from "../screens/monitoring/Alerts";
import { SEV_ICON, SEV_TONE } from "../screens/monitoring/ops";
import { feedProblem, feedTarget, feedWhat, feedWho } from "./alertFeed";

/** background poll of the alert feed (does not extend the idle session) */
export const BELL_POLL_MS = 60_000;

/**
 * Topbar bell (sprint 7 → 8): one feed of the ops-monitor alerts (providers, queues, DLQ, outbox, feeds) and the AI
 * budget alerts — critical first. Acknowledge — ops.kill_switch. A source that is not connected or did not answer is
 * skipped (`partial`); hidden only when the role cannot read it.
 */
export function AlertsBell({ onOpen, allowed }: { onOpen: (page: string, id: string | null) => void; allowed: (page: string) => boolean }) {
  const i = useI18n();
  const { t, fmt } = i;
  const toast = useToast();
  const [feed, setFeed] = useState<AlertFeed | null>(null);
  const [off, setOff] = useState(false);
  const [names, setNames] = useState<Map<string, string> | null>(null);
  const [namesTried, setNamesTried] = useState(false);
  const load = useCallback(async () => {
    try {
      setFeed(await AlertsApi.feed(true));
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setOff(true);
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), BELL_POLL_MS);
    return () => clearInterval(id);
  }, [load]);
  const needNames = !!feed?.items.some((x) => x.source === "ai") && !namesTried;
  useEffect(() => {
    if (!needNames) return;
    setNamesTried(true);
    AiApi.agents(true)
      .then((a) => setNames(new Map(a.items.map((x) => [x.agent_id, x.name]))))
      .catch(() => undefined);
  }, [needNames]);
  if (off) return null;
  const items = (feed?.items ?? []).filter((x) => !x.acked);
  const n = items.length;
  const hot = (feed?.counts.critical ?? 0) > 0;
  const who = (x: AlertFeedItem) => feedWho(i, x, names);
  const what = (x: AlertFeedItem) => feedWhat(i, x);
  const open = (x: AlertFeedItem) => {
    const to = feedTarget(x);
    if (allowed(to.page)) onOpen(to.page, to.id);
  };
  const problem = feed ? feedProblem(feed) : null;
  const ack = async (x: AlertFeedItem) => {
    try {
      await AlertsApi.ack(x.source, x.id);
      setFeed((f) => (f ? { ...f, items: f.items.map((y) => (y.id === x.id ? { ...y, acked: true } : y)), counts: { ...f.counts, [x.severity]: Math.max(0, f.counts[x.severity] - 1) } } : f));
    } catch (e) {
      toast(ackErrText(i, e), "err");
    }
  };
  const label = n ? t("bell.label", { n }) : t("bell.none");
  return (
    <MenuButton
      label={label}
      title={label}
      className="icon-btn bell-btn"
      testId="bell"
      menuClass="bell-menu"
      render={(close) => (
        <>
          <div className="menu-h">
            {t("bell.title")} {n > 0 && <span className="menu-h-sub">· {n}</span>}
          </div>
          {problem && (
            <div className="menu-note xs" data-testid="bell-partial">
              <Icon name="alert" /> {t(problem === "both" ? "bell.partialBoth" : problem === "ops" ? "bell.partialOps" : "bell.partialAi")}
            </div>
          )}
          {n === 0 ? (
            <div className="menu-note" data-testid="bell-empty">
              <Icon name="checkCircle" /> {t("bell.empty")}
            </div>
          ) : (
            <ul className="ai-alerts is-compact bell-list" data-testid="bell-list">
              {items.slice(0, 12).map((x) => (
                <li key={`${x.source}:${x.id}`} className={cx("ai-alert", `is-${SEV_TONE[x.severity] === "bad" ? "bad" : SEV_TONE[x.severity] === "warn" ? "warn" : "info"}`)} data-testid="ai-alert" data-alert={x.id} data-source={x.source}>
                  <Icon name={SEV_ICON[x.severity]} />
                  <button
                    type="button"
                    className="grow bell-item"
                    onClick={() => {
                      close();
                      open(x);
                    }}
                  >
                    <span className="ai-alert-t">
                      <span className="sr-only">{t(`mon.sev.${x.severity}`)}: </span>
                      <b>{who(x)}</b> · {what(x)}
                    </span>
                    <span className="xs muted block">
                      {t(x.source === "ai" ? "bell.src.ai" : "bell.src.ops")} · <span title={fmt.dateTime(x.opened_at)}>{fmt.rel(x.opened_at)}</span>
                    </span>
                  </button>
                  <RunbookLink url={x.runbook_url} testId="bell-runbook" />
                  <Btn size="xs" icon="check" label={t("ai.alert.ack")} perm="ops.kill_switch" onClick={() => void ack(x)} testId="ai-alert-ack" />
                </li>
              ))}
            </ul>
          )}
          <div className="menu-sep" />
          <div className="bell-foot">
            {allowed("budgets") && (
            <Btn
              size="sm"
              kind="ghost"
              icon="gauge"
              label={t("bell.openBudgets")}
              onClick={() => {
                close();
                onOpen("budgets", null);
              }}
              testId="bell-open"
            />
            )}
            {allowed("monitoring") && (
            <Btn
              size="sm"
              kind="ghost"
              icon="server"
              label={t("bell.openMonitoring")}
              onClick={() => {
                close();
                onOpen("monitoring", "alerts");
              }}
              testId="bell-open-mon"
            />
            )}
          </div>
        </>
      )}
    >
      <Icon name="bell" />
      {n > 0 && (
        <span className={hot ? "badge-dot is-hot" : "badge-dot"} data-testid="bell-count">
          {n > 9 ? "9+" : n}
        </span>
      )}
    </MenuButton>
  );
}
