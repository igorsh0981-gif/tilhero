import { useEffect, useState } from "react";
import type { AlertFeedItem } from "@tilhero/contracts/admin";
import { AlertsApi } from "../../api/endpoints";
import { useI18n } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { feedTarget, feedWhat, feedWho } from "../../shell/alertFeed";
import { pageAllowed } from "../../state/nav";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { Btn } from "../../ui/kit";
import { RunbookLink } from "../monitoring/Alerts";

const HIDDEN_KEY = "dash.hiddenAlerts";
function readHidden(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(HIDDEN_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-50) : [];
  } catch {
    return [];
  }
}

/**
 * Prototype v2: the urgent (critical, not acknowledged) alerts above the dashboard — what, since when, «Open» to the
 * place to act; «Hide» only for this browser session (the alert stays in the bell and in «Monitoring»).
 */
export function CriticalAlerts({ reloadKey }: { reloadKey: number }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { navigate } = useNav();
  const { me } = useSession();
  const perms = new Set(me?.permissions ?? []);
  const [items, setItems] = useState<AlertFeedItem[]>([]);
  const [hidden, setHidden] = useState<string[]>(readHidden);
  useEffect(() => {
    let live = true;
    AlertsApi.feed(true)
      .then((f) => live && setItems(f.items.filter((x) => x.severity === "critical" && !x.acked)))
      .catch(() => undefined); // the bell says when the feed is unavailable; the dashboard stays quiet
    return () => {
      live = false;
    };
  }, [reloadKey]);
  const shown = items.filter((x) => !hidden.includes(`${x.source}:${x.id}`)).slice(0, 3);
  if (!shown.length) return null;
  const hide = (x: AlertFeedItem) => {
    const next = [...hidden, `${x.source}:${x.id}`];
    setHidden(next);
    try {
      sessionStorage.setItem(HIDDEN_KEY, JSON.stringify(next.slice(-50)));
    } catch {
      /* private mode: hidden until reload */
    }
  };
  return (
    <div className="alerts" role="region" aria-label={t("dash.crit.t")} data-testid="dash-crit">
      {shown.map((x) => {
        const to = feedTarget(x);
        return (
          <div key={`${x.source}:${x.id}`} className="alert-row bad" data-testid="dash-crit-row" data-alert={x.id}>
            <Icon name="alertCircle" />
            <div className="t">
              <span className="sr-only">{t("mon.sev.critical")}: </span>
              <b>{feedWho(i, x)}</b> · {feedWhat(i, x)}
              <span className="m" title={fmt.dateTime(x.opened_at)}>
                {t(x.source === "ai" ? "bell.src.ai" : "bell.src.ops")} · {fmt.rel(x.opened_at)}
              </span>
            </div>
            <div className="acts">
              <RunbookLink url={x.runbook_url} size="sm" testId="dash-crit-runbook" />
              {pageAllowed(to.page, perms) && <Btn size="sm" label={t("dash.open")} onClick={() => navigate(to.page, to.id)} testId="dash-crit-open" />}
              <Btn size="sm" kind="ghost" label={t("dash.crit.hide")} onClick={() => hide(x)} testId="dash-crit-hide" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
