/**
 * «Новости и „Что нового“» — the communications section of the prototype (group «Коммуникации», menu id `news`).
 * Everything the learner reads from TilHero besides support lives here, as tabs by right:
 *  - «Что нового» (whatsnew.manage / whatsnew.publish) — experience-config release notes;
 *  - «Шаблоны уведомлений» (notif.templates.manage) — notifications template versions;
 *  - «Рассылки» (notif.campaigns.manage / notif.campaigns.send) — product campaigns.
 * One section for one owner role (communications); «Конфигурация» stays the interface configuration (config.*).
 * Route: #/news/<tab>[/<id>].
 */
import type { Permission } from "@tilhero/contracts/admin";
import { useI18n } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Locked, TabPanel, Tabs } from "../../ui/kit";
import type { IconName } from "../../ui/Icon";
import { CampaignsTab } from "./Campaigns";
import { TemplatesTab } from "./Templates";
import { WhatsNewTab } from "./WhatsNew";

export type NewsTab = "whatsnew" | "templates" | "campaigns";
export const NEWS_TABS: ReadonlyArray<{ v: NewsTab; perm: Permission; icon: IconName }> = [
  { v: "whatsnew", perm: "whatsnew.manage", icon: "sparkles" },
  { v: "templates", perm: "notif.templates.manage", icon: "template" },
  { v: "campaigns", perm: "notif.campaigns.manage", icon: "megaphone" },
];

export function parseNewsRoute(routeId: string | null): { tab: NewsTab | null; id: string | null } {
  if (!routeId) return { tab: null, id: null };
  const [head, ...rest] = routeId.split("/");
  const tab = NEWS_TABS.find((x) => x.v === head)?.v ?? null;
  return { tab, id: tab && rest.length ? rest.join("/") : null };
}

export function NewsPage({ routeId }: { routeId: string | null }) {
  const { t } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const allowedTabs = NEWS_TABS.filter((x) => can(x.perm));
  const parsed = parseNewsRoute(routeId);
  const tab = parsed.tab && allowedTabs.some((x) => x.v === parsed.tab) ? parsed.tab : (allowedTabs[0]?.v ?? null);
  if (!tab) return <Locked title={t("err.denied.t")} text={t("err.denied.m")} />;
  return (
    <div className="stack" data-testid="news">
      <p className="sub page-lead">{t("news.lead")}</p>
      <Tabs<NewsTab>
        id="news"
        label={t("page.news")}
        value={tab}
        onChange={(v) => navigate("news", v)}
        items={allowedTabs.map((x) => ({ v: x.v, label: t(`news.tab.${x.v}`), icon: x.icon, testId: `news-tab-${x.v}` }))}
      />
      <TabPanel id="news" value={tab}>
        {tab === "whatsnew" ? <WhatsNewTab openId={parsed.tab === "whatsnew" ? parsed.id : null} /> : tab === "templates" ? <TemplatesTab openKey={parsed.tab === "templates" ? parsed.id : null} /> : <CampaignsTab openId={parsed.tab === "campaigns" ? parsed.id : null} />}
      </TabPanel>
    </div>
  );
}
