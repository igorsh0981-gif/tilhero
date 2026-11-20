/**
 * «Память и повторения» (sprint 5, ADM-MEM-01/02, AT-61). Tabs by permission: «Аналитика забывания» (memory.read |
 * dashboard.read — aggregates only, groups below 5 learners are hidden) and «Память ученика» (memory.read — opened from
 * the learner card in «Ученики» or by the learner's UUID). Routes: #/memory[/analytics] · #/memory/learners[/<user_id>
 * [/<card_id>]]. The learner's own texts (quotes of errors) are never shown — they are not in the contract.
 */
import { useState } from "react";
import { useI18n } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { Btn, Empty, FieldErr, TabPanel, Tabs } from "../../ui/kit";
import { AnalyticsTab } from "./Analytics";
import { LearnerMemory } from "./LearnerMemory";
import { isUuid, memoryTabs, parseMemoryRoute, type MemoryTab } from "./model";

export function MemoryPage({ routeId }: { routeId: string | null }) {
  const { t } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const r = parseMemoryRoute(routeId);
  const tabs = memoryTabs(can);
  const tab: MemoryTab = r.tab && tabs.includes(r.tab) ? r.tab : (tabs[0] ?? "analytics");
  return (
    <div className="stack" data-testid="memory">
      <Tabs<MemoryTab>
        id="mem"
        label={t("mem.tabs")}
        value={tab}
        onChange={(v) => navigate("memory", v)}
        items={tabs.map((v) => ({ v, label: t(`mem.tab.${v}`), icon: v === "analytics" ? "trendDown" : "user", testId: `mem-tab-${v}` }))}
      />
      <TabPanel id="mem" value={tab}>
        {tab === "analytics" ? <AnalyticsTab /> : r.user ? <LearnerMemory key={r.user} userId={r.user} cardId={r.card} /> : <LearnerLookup />}
      </TabPanel>
    </div>
  );
}

/** Without a learner: the UUID of the learner (staff without users.read come by a link from support or QA). */
function LearnerLookup() {
  const { t } = useI18n();
  const { can } = useSession();
  const { navigate } = useNav();
  const [id, setId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = () => {
    if (!isUuid(id)) {
      setErr(t("mem.lookupErr"));
      return;
    }
    navigate("memory", `learners/${id.trim().toLowerCase()}`);
  };
  return (
    <section className="card stack sm mem-lookup" aria-labelledby="mem-lk-h" data-testid="mem-lookup">
      <h2 className="h2" id="mem-lk-h">
        {t("mem.lookup")}
      </h2>
      <p className="small muted">{t("mem.lookupM")}</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <div className="field grow">
          <label htmlFor="mem-uid">{t("mem.uid")}</label>
          <input id="mem-uid" className="input mono" value={id} spellCheck={false} autoComplete="off" placeholder="a1000000-0000-4000-8000-000000000001" aria-invalid={!!err || undefined} aria-describedby={err ? "mem-uid-e" : undefined} onChange={(e) => (setId(e.target.value), setErr(null))} data-testid="mem-uid" />
          <FieldErr msg={err} id="mem-uid-e" />
        </div>
        <Btn type="submit" kind="primary" icon="search" label={t("mem.open")} testId="mem-uid-go" />
      </form>
      {can("users.read") ? (
        <Empty icon="users" title={t("mem.fromCard")} text={t("mem.fromCardM")}>
          <Btn size="sm" icon="users" label={t("mem.toLearners")} onClick={() => navigate("users")} />
        </Empty>
      ) : (
        <p className="xs muted row">
          <Icon name="info" /> {t("mem.noUsers")}
        </p>
      )}
    </section>
  );
}
