import { useI18n } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { TabPanel, Tabs } from "../../ui/kit";
import { parseDelRoute } from "../monitoring/ops";
import { DeletionsPage } from "./Deletions";
import { Users } from "./Users";

type UsersTab = "list" | "deletions";

/** «Users»: the list with cards (#/users[/<user_id>]) and, sprint 9, the deletion saga (#/users/deletions[/…]). */
export function UsersSection({ openId }: { openId: string | null }) {
  const { t } = useI18n();
  const { navigate } = useNav();
  const del = parseDelRoute(openId);
  const tab: UsersTab = del.deletions ? "deletions" : "list";
  return (
    <>
      <Tabs<UsersTab>
        id="users"
        label={t("page.users")}
        value={tab}
        onChange={(v) => navigate("users", v === "deletions" ? "deletions" : null)}
        items={[
          { v: "list", label: t("users.tab.list"), icon: "users", testId: "users-tab-list" },
          { v: "deletions", label: t("users.tab.deletions"), icon: "userCheck", testId: "users-tab-deletions" },
        ]}
      />
      <TabPanel id="users" value={tab}>
        {del.deletions ? <DeletionsPage filter={del.filter} openId={del.open} /> : <Users openId={openId} />}
      </TabPanel>
    </>
  );
}
