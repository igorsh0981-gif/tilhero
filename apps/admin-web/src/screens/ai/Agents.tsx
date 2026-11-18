import { useCallback, useEffect, useState } from "react";
import type { AiAgent, SkillSummary } from "@tilhero/contracts/admin";
import { AiApi, SkillsApi } from "../../api/endpoints";
import { useI18n } from "../../i18n";
import { useNav } from "../../shell/navctx";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, Empty, Pill, Spinner } from "../../ui/kit";
import { StatusPill } from "./parts";
import { SkillScreen } from "./Skill";

/**
 * «Agents and skills» (sprint 7, agent-config + skill-registry): agents with their skills, the version active in
 * runtime and the open (DRAFT / TESTED / REVIEW) versions; a skill opens its own screen (#/agents/<skill_id>).
 * discovery / news are code-managed: their prompts live in provider-gateway — here only budget, kill switch, usage.
 */
export function AgentsPage({ openId }: { openId: string | null }) {
  const { navigate } = useNav();
  if (openId) return <SkillScreen skillId={openId} onBack={() => navigate("agents")} />;
  return <AgentsList onOpen={(id) => navigate("agents", id)} />;
}

function AgentsList({ onOpen }: { onOpen: (skillId: string) => void }) {
  const { t, fmt } = useI18n();
  const [agents, setAgents] = useState<AiAgent[] | null>(null);
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, s] = await Promise.all([AiApi.agents(), SkillsApi.list()]);
      setAgents(a.items);
      setSkills(s.items);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div data-testid="agents">
      <div className="page-head">
        <div className="lead">
          <p>{t("agt.lead")}</p>
        </div>
        <div className="acts">
          <Btn kind="ghost" icon="refresh" label={t("common.refresh")} busy={loading && !!agents} onClick={() => void load()} testId="agt-refresh" />
        </div>
      </div>
      <Callout kind="info" icon="branch" testId="agt-lifecycle">
        {t("agt.lifecycle")}
      </Callout>
      {error ? <LoadError error={error} onRetry={() => void load()} testId="agt-error" /> : null}
      {!agents && loading && !error && <Spinner label={t("common.loading")} />}
      {agents && skills && !agents.length && <Empty icon="cpu" title={t("agt.emptyT")} text={t("agt.emptyM")} />}
      {agents && skills && agents.length > 0 && (
        <section className="panel mt-12" data-testid="agt-list">
          <div className="table-wrap">
            <table className="tbl agt-tbl">
              <thead>
                <tr>
                  <th>{t("req.col.agent")}</th>
                  <th>{t("agt.col.skills")}</th>
                  <th>{t("agt.col.policy")}</th>
                  <th>{t("agt.col.config")}</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => {
                  const own = skills.filter((s) => s.agent_id === a.agent_id);
                  return (
                    <tr key={a.agent_id} data-agent={a.agent_id} data-testid="agt-row">
                      <td>
                        <b>{a.name}</b>
                        <span className="block xs muted mono">
                          {a.agent_id} · {t(`ai.kind.${a.kind}`)}
                        </span>
                        {a.code_managed && (
                          <span className="block">
                            <Pill tone="outline" dot={false}>
                              {t("ai.codeManaged")}
                            </Pill>
                          </span>
                        )}
                      </td>
                      <td>
                        {own.length === 0 && <span className="xs muted">{t("agt.noSkills")}</span>}
                        <ul className="agt-skills">
                          {own.map((s) => {
                            const pending = s.versions.filter((v) => v.status === "DRAFT" || v.status === "TESTED" || v.status === "REVIEW");
                            return (
                              <li key={s.skill_id} data-skill={s.skill_id}>
                                <span className="grow">
                                  <span className="mono">{s.skill_id}</span>
                                  {s.critical && (
                                    <span className="xs muted" title={t("agt.criticalH")}>
                                      {" "}
                                      · {t("agt.critical")}
                                    </span>
                                  )}
                                  <span className="block xs">
                                    {s.code_managed ? (
                                      <span className="muted">{t("agt.codeSkill")}</span>
                                    ) : s.active ? (
                                      <>
                                        <Pill tone="good" mono>
                                          PUBLISHED v{s.active.version}
                                        </Pill>{" "}
                                        <span className="muted">{t("agt.activeSince", { t: fmt.date(s.active.since) })}</span>
                                      </>
                                    ) : (
                                      <span className="muted">{t("agt.noActive")}</span>
                                    )}
                                    {pending.map((v) => (
                                      <span key={v.version}>
                                        {" "}
                                        <StatusPill status={v.status} />
                                        <span className="mono xs"> v{v.version}</span>
                                      </span>
                                    ))}
                                  </span>
                                </span>
                                {!s.code_managed && <Btn size="xs" icon="edit" label={t("agt.open")} onClick={() => onOpen(s.skill_id)} testId="agt-open" />}
                              </li>
                            );
                          })}
                        </ul>
                      </td>
                      <td className="xs">
                        {t(`bdg.mode.${a.degraded_mode}`)}
                        {a.model_fallback && <span className="block mono muted">fallback: {a.model_fallback}</span>}
                        <span className="block muted">{t("agt.tools", { n: a.max_tool_calls })}</span>
                      </td>
                      <td className="xs nowrap">
                        v{a.config_version}
                        {a.updated_at && <span className="block muted">{fmt.dateTime(a.updated_at)}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="panel-f ai-foot">
            <Icon name="info" /> {t("agt.foot")}
          </div>
        </section>
      )}
    </div>
  );
}
