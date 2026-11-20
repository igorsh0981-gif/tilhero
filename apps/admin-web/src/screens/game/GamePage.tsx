/**
 * «Геймификация» (sprint 6): tabs «Обзор» (the totals of the game for 7 / 30 days from the anonymous daily statistics,
 * by audience, the active rules version and events), «Правила», «Магазин», «Кошельки». Every tab needs game.read (the
 * section is not in the menu without it); commands need game.manage / game.publish / wallet.adjust — their buttons
 * are not shown without the right, and the server answers a direct request with 403 PERMISSION_DENIED.
 * Routes: #/game[/overview] · #/game/rules[/<version>] · #/game/shop[/new|/<code>] · #/game/wallets[/<user_id>].
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { GameOverview } from "@tilhero/contracts/admin";
import { Game } from "../../api/endpoints";
import { useI18n, type MessageKey } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, Seg, Spinner, TabPanel, Tabs } from "../../ui/kit";
import { Kpi } from "./parts";
import { RulesTab } from "./RulesTab";
import { ShopTab } from "./ShopTab";
import { WalletTab } from "./WalletTab";
import { AUDIENCES, GAME_TABS, OVERVIEW_PERIODS, parseGameRoute, zoneDateTime, type GameTab } from "./model";
import type { IconName } from "../../ui/Icon";

const TAB_ICON: Record<GameTab, IconName> = { overview: "dashboard", rules: "sliders", shop: "coins", wallets: "user" };

export function GamePage({ routeId }: { routeId: string | null }) {
  const { t } = useI18n();
  const { navigate } = useNav();
  const r = parseGameRoute(routeId);
  const tab: GameTab = r.tab ?? "overview";
  return (
    <div className="stack" data-testid="game">
      <Tabs<GameTab> id="gm" label={t("gm.tabs")} value={tab} onChange={(v) => navigate("game", v)} items={GAME_TABS.map((v) => ({ v, label: t(`gtab.${v}` as MessageKey), icon: TAB_ICON[v], testId: `gm-tab-${v}` }))} />
      <TabPanel id="gm" value={tab}>
        {tab === "overview" ? <GameOverviewTab /> : tab === "rules" ? <RulesTab openVersion={r.id ? Number(r.id) : null} /> : tab === "shop" ? <ShopTab openId={r.id} /> : <WalletTab userId={r.id} />}
      </TabPanel>
    </div>
  );
}

function GameOverviewTab() {
  const { t, fmt } = useI18n();
  const { navigate } = useNav();
  const [period, setPeriod] = useState<GameOverview["period"]>("7d");
  const [o, setO] = useState<GameOverview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const req = useRef(0);
  const load = useCallback((p: GameOverview["period"]) => {
    const id = ++req.current;
    Game.overview(p)
      .then((x) => id === req.current && (setO(x), setError(null)))
      .catch((e) => id === req.current && setError(e));
  }, []);
  useEffect(() => load(period), [period, load]);
  const shown = o && o.period === period ? o : null;
  return (
    <div className="stack" data-testid="go">
      <div className="dash-head">
        <Seg<GameOverview["period"]> label={t("dash.period")} value={period} onChange={setPeriod} items={OVERVIEW_PERIODS.map((v) => ({ v, label: t(`dash.period.${v}`) }))} testId="go-period" />
        <span className="grow" />
        <Btn size="sm" icon="refresh" label={t("common.refresh")} onClick={() => load(period)} testId="go-refresh" />
      </div>
      {error && !shown ? (
        <LoadError error={error} onRetry={() => load(period)} />
      ) : !shown ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <>
          <div className="kpis" data-testid="go-kpis">
            <Kpi label={t("go.earnedXp")} value={fmt.num(shown.earned.xp)} note={t(`dash.period.${shown.period}`)} testId="go-xp" />
            <Kpi label={t("go.earnedTil")} value={fmt.num(shown.earned.til)} note={t("go.spentTil", { n: fmt.num(shown.spent_til) })} testId="go-til" />
            <Kpi label={t("go.freezes")} value={fmt.num(shown.freezes.used)} note={t("go.freezesNote", { g: fmt.num(shown.freezes.granted), b: fmt.num(shown.freezes.bought) })} testId="go-freezes" />
            <Kpi label={t("go.quests")} value={fmt.num(shown.quests_completed)} note={t("go.badges", { n: fmt.num(shown.badges_earned) })} testId="go-quests" />
            <Kpi label={t("go.purchases")} value={fmt.num(shown.purchases)} note={t("go.purchasesNote")} />
          </div>
          <div className="grid2">
            <section className="panel" aria-labelledby="go-aud-h" data-testid="go-audiences">
              <div className="panel-h">
                <h2 className="panel-t grow" id="go-aud-h">
                  <Icon name="users" /> {t("go.byAudience")}
                </h2>
              </div>
              <div className="table-wrap">
                <table className="tbl dense">
                  <caption className="sr-only">{t("go.byAudience")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("gm.audience")}</th>
                      <th scope="col" className="r">
                        XP
                      </th>
                      <th scope="col" className="r">
                        {t("gm.cur.til")}
                      </th>
                      <th scope="col" className="r">
                        {t("go.questsShort")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {AUDIENCES.map((a) => {
                      const x = shown.by_audience.find((y) => y.audience === a);
                      return (
                        <tr key={a}>
                          <th scope="row">{t(`ageseg.${a}` as MessageKey)}</th>
                          <td className="r num">{fmt.num(x?.earned_xp ?? 0)}</td>
                          <td className="r num">{fmt.num(x?.earned_til ?? 0)}</td>
                          <td className="r num">{fmt.num(x?.quests_completed ?? 0)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="panel-f">
                <Icon name="shield" /> {t("go.anonNote")}
              </div>
            </section>
            <section className="card stack sm" aria-labelledby="go-now-h" data-testid="go-now">
              <h2 className="h3" id="go-now-h">
                {t("go.now")}
              </h2>
              <div className="kv">
                <span>{t("go.rulesV")}</span>
                <button type="button" className="tr" onClick={() => navigate("game", "rules")} data-testid="go-rules">
                  v{shown.active_rules_version}
                </button>
              </div>
              <div className="blk-sub">{t("go.events")}</div>
              {shown.active_events.length ? (
                <ul className="plain-list">
                  {shown.active_events.map((e) => (
                    <li key={e.event_id} className="row between">
                      <button type="button" className="tr" lang="ru" onClick={() => navigate("events", e.event_id)} data-testid={`go-ev-${e.event_id}`}>
                        {e.title.ru}
                      </button>
                      <span className="xs muted">{t("go.until", { t: zoneDateTime(fmt.locale, e.ends_at) })}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">{t("go.noEvents")}</p>
              )}
              <Callout icon="info">{t("go.separate")}</Callout>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
