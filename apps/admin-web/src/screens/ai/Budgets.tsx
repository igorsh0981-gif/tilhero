import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccessLevel, AiAgent, AiAgentRuntimeState, AiAlert, AiBudgetOverview, AiCommandWarning } from "@tilhero/contracts/admin";
import { AiApi, SkillsApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type I18n, type MessageKey } from "../../i18n";
import { fmtUsd } from "../../lib/money";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Select, Spinner } from "../../ui/kit";
import { Drawer, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { LimitsPanel } from "../discovery/Limits";
import { ALL_FIELDS, type AgentCaps } from "../discovery/limits";
import {
  agentForm,
  agentPatch,
  agentWarnings,
  alertKind,
  cleanUsd,
  levelErrors,
  levelWarnings,
  skillAbove,
  trimZeros,
  unpricedModel,
  usdShort,
  validateAgent,
  type AgentCtx,
  type AgentErrors,
  type AgentForm,
  type SkillCost,
} from "./ai";
import { BudgetMeter, PauseNote, StatePill, Who } from "./parts";

/** what a kill switch target is, for the confirmation dialog */
export type KillTarget = { kind: "agent"; id: string; name: string; paused: boolean } | { kind: "provider"; id: "anthropic"; name: string; paused: boolean };

/**
 * «Budgets and limits» (sprint 7): AI limits (6.1 + the concierge $1 and Test Console $0.30 — their own budgets),
 * the state of every agent (day / month / per request, Normal · Degraded · Paused · Exhausted), the kill switch of an
 * agent and of the Claude provider (reason + typing the object name + TOTP), the agent configuration, budget alerts
 * 70 / 90 / 100 %, access levels (messages per day). Reading — dashboard.read; changes — ops.kill_switch.
 */
export function BudgetsPage() {
  const i = useI18n();
  const { t } = i;
  const [o, setO] = useState<AiBudgetOverview | null>(null);
  const [agents, setAgents] = useState<AiAgent[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [kill, setKill] = useState<KillTarget | null>(null);
  const [config, setConfig] = useState<AiAgent | null>(null);
  const [saved, setSaved] = useState<AiCommandWarning[]>([]);

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true);
    try {
      const ov = await AiApi.budgets(background);
      setO(ov);
      setError(null);
      if (ov.control === "ok") {
        AiApi.agents()
          .then((a) => setAgents(a.items))
          .catch(() => setAgents(null));
      } else setAgents(null);
    } catch (e) {
      setError(e);
    } finally {
      if (!background) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(true), 60_000);
    return () => clearInterval(id);
  }, [load]);

  const caps = useMemo<AgentCaps>(() => {
    const out: AgentCaps = {};
    for (const a of agents ?? []) if (a.agent_id === "concierge" || a.agent_id === "evaluation") out[a.agent_id] = { per_request_max_usd: a.per_request_max_usd, monthly_cap_usd: a.monthly_cap_usd };
    return out;
  }, [agents]);
  const spent = useMemo(() => {
    const day = (id: string) => o?.agents.find((a) => a.agent_id === id)?.day?.spent_usd;
    return { concierge: day("concierge"), evaluation: day("evaluation") };
  }, [o]);

  return (
    <div data-testid="budgets">
      <div className="page-head">
        <div className="lead">
          <p>{t("bdg.lead")}</p>
        </div>
        <div className="acts">
          <Btn kind="ghost" icon="refresh" label={t("common.refresh")} busy={loading && !!o} onClick={() => void load()} testId="bdg-refresh" />
        </div>
      </div>
      {error ? <LoadError error={error} onRetry={() => void load()} testId="bdg-error" /> : null}
      {!o && loading && !error && <Spinner label={t("common.loading")} />}
      {o && (
        <>
          {o.control === "unavailable" && (
            <Callout kind="warn" icon="alert" testId="bdg-control-down">
              {t("bdg.controlDown")}
            </Callout>
          )}
          {o.gateway === "unavailable" && (
            <Callout kind="warn" icon="alert" testId="bdg-gw-down">
              {t("bdg.gwDown")}
            </Callout>
          )}
          <ProviderPanel o={o} onKill={setKill} />
          <LimitsPanel budget={null} fields={ALL_FIELDS} via="ai" agentsSpent={{ ...(spent.concierge ? { concierge: spent.concierge } : {}), ...(spent.evaluation ? { evaluation: spent.evaluation } : {}) }} agentsCaps={caps} onChanged={() => void load(true)} />
          <SavedWarnings items={saved} onClose={() => setSaved([])} testId="cfg-saved-warn" />
          <AgentsPanel o={o} agents={agents} onKill={setKill} onConfig={setConfig} />
          <AlertsPanel o={o} onChanged={() => void load(true)} />
          <LevelsPanel />
        </>
      )}
      {kill && (
        <KillSwitchDialog
          target={kill}
          onClose={() => setKill(null)}
          onDone={() => {
            setKill(null);
            void load(true);
          }}
        />
      )}
      {config && (
        <AgentConfigDrawer
          agent={config}
          state={o?.agents.find((x) => x.agent_id === config.agent_id)}
          onClose={() => setConfig(null)}
          onSaved={(a, w) => {
            setAgents((xs) => (xs ? xs.map((x) => (x.agent_id === a.agent_id ? a : x)) : xs));
            setSaved(w);
            setConfig(null);
            void load(true);
          }}
        />
      )}
    </div>
  );
}

function ProviderPanel({ o, onKill }: { o: AiBudgetOverview; onKill: (k: KillTarget) => void }) {
  const { t } = useI18n();
  const p = o.provider.anthropic.paused;
  return (
    <section className={cx("panel mb-16 bdg-provider", p && "sev-bad")} data-testid="bdg-provider" aria-labelledby="bdg-provider-h">
      <div className="panel-h">
        <h2 className="panel-t" id="bdg-provider-h">
          <Icon name="power" />
          {t("bdg.provider.t")}
        </h2>
        <span className="panel-sub">{t("bdg.needKill")}</span>
      </div>
      <div className="panel-b bdg-provider-b">
        <div className="grow">
          <b>Anthropic Claude API</b> <span className="mono xs muted">anthropic</span>
          <span className="block xs muted">{t("bdg.provider.what")}</span>
          {p && <PauseNote p={p} />}
        </div>
        {p ? <Pill tone="bad">{t("ai.state.paused")}</Pill> : <Pill tone="good">{t("ai.state.normal")}</Pill>}
        <Btn
          kind={p ? "primary" : "danger-ghost"}
          size="sm"
          icon={p ? "play" : "power"}
          label={p ? t("bdg.resume") : t("bdg.kill")}
          perm="ops.kill_switch"
          disabled={o.gateway === "unavailable"}
          onClick={() => onKill({ kind: "provider", id: "anthropic", name: "Anthropic Claude API", paused: !!p })}
          testId="bdg-provider-kill"
        />
      </div>
    </section>
  );
}

function AgentsPanel({ o, agents, onKill, onConfig }: { o: AiBudgetOverview; agents: AiAgent[] | null; onKill: (k: KillTarget) => void; onConfig: (a: AiAgent) => void }) {
  const { t, fmt } = useI18n();
  const byId = new Map((agents ?? []).map((a) => [a.agent_id, a]));
  const providerPaused = !!o.provider.anthropic.paused;
  return (
    <section className="panel mt-16" data-testid="bdg-agents" aria-labelledby="bdg-agents-h">
      <div className="panel-h">
        <h2 className="panel-t" id="bdg-agents-h">
          <Icon name="cpu" />
          {t("bdg.agents.t")}
        </h2>
        <span className="panel-sub">{t("bdg.agents.sub")}</span>
      </div>
      <div className="table-wrap">
        <table className="tbl bdg-agents-tbl">
          <thead>
            <tr>
              <th>{t("req.col.agent")}</th>
              <th>{t("bdg.col.day")}</th>
              <th>{t("bdg.col.month")}</th>
              <th className="num">{t("bdg.col.perRequest")}</th>
              <th>{t("bdg.col.degrade")}</th>
              <th>{t("col.status")}</th>
              <th className="act" aria-label={t("common.actions")} />
            </tr>
          </thead>
          <tbody>
            {o.agents.map((a) => {
              const cfg = byId.get(a.agent_id);
              return (
                <tr key={a.agent_id} className={cx(a.state === "paused" && "is-paused", (a.state === "exhausted" || (a.day?.pct ?? 0) >= 90) && "is-hot")} data-agent={a.agent_id} data-testid="bdg-agent-row">
                  <td>
                    <b>{a.name}</b>
                    <span className="block xs muted mono">
                      {a.agent_id} · {t(`ai.kind.${a.kind}`)}
                    </span>
                    {a.code_managed && <span className="block xs muted">{t("ai.codeManaged")}</span>}
                  </td>
                  <td className="bdg-day">
                    {a.day ? (
                      <>
                        <BudgetMeter pct={a.day.pct} testId="bdg-day-meter" />
                        <span className="xs muted block nowrap">
                          {fmtUsd(a.day.spent_usd, 4)} / {fmtUsd(a.day.limit_usd, 2)}
                          {a.day.source === "admin" && <> · {t("lim.src.admin").toLowerCase()}</>}
                        </span>
                      </>
                    ) : (
                      <span className="xs muted">{t("bdg.noDay")}</span>
                    )}
                  </td>
                  <td className="nowrap">
                    {a.month ? (
                      <>
                        {fmtUsd(a.month.cost_usd, 2)}
                        <span className="xs muted"> / {a.month.cap_usd ? fmtUsd(a.month.cap_usd, 2) : t("bdg.noCap")}</span>
                        {a.month.pct != null && <span className="block xs muted">{fmt.pct(a.month.pct, 0)}</span>}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="num mono">{cfg ? fmtUsd(cfg.per_request_max_usd, 4) : "—"}</td>
                  <td className="xs">
                    {a.degraded_mode ? (
                      a.degraded_mode === "none" ? (
                        <span className="muted">{t("bdg.mode.none")}</span>
                      ) : (
                        <>
                          {t(`bdg.mode.${a.degraded_mode}`)}
                          <span className="muted"> · {t("bdg.fromPct", { n: a.degrade_at_pct ?? 0 })}</span>
                        </>
                      )
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <StatePill state={a.state} testId="bdg-state" />
                    {a.paused && <PauseNote p={a.paused} />}
                    {!a.paused && providerPaused && <span className="block xs muted">{t("bdg.byProvider")}</span>}
                  </td>
                  <td className="act nowrap">
                    {cfg && !a.code_managed && (
                      <Btn size="xs" icon="edit" aria={t("bdg.config")} title={t("bdg.config")} onClick={() => onConfig(cfg)} testId="bdg-config" />
                    )}
                    <Btn
                      size="xs"
                      kind={a.paused ? "primary" : "danger-ghost"}
                      icon={a.paused ? "play" : "power"}
                      label={a.paused ? t("bdg.resume") : t("bdg.kill")}
                      perm="ops.kill_switch"
                      disabled={o.gateway === "unavailable"}
                      onClick={() => onKill({ kind: "agent", id: a.agent_id, name: a.name, paused: !!a.paused })}
                      testId="bdg-kill"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="panel-f ai-foot">
        <Icon name="info" /> {t("bdg.agents.foot")}
      </div>
    </section>
  );
}

/** Kill switch confirmation: reason (3–300), typing the object id to stop it, TOTP (asked by the client). */
export function KillSwitchDialog({ target, onClose, onDone }: { target: KillTarget; onClose: () => void; onDone: () => void }) {
  const i = useI18n();
  const { t } = i;
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stop = !target.paused;
  const typedOk = !stop || typed.trim() === target.id;
  const submit = async () => {
    if (busy) return;
    if (reason.trim().length < 3) return setErr(t("cmd.errReason", { n: 3 }));
    if (reason.trim().length > 300) return setErr(t("dsc.reasonLong"));
    if (!typedOk) return setErr(t("bdg.kill.typeErr", { id: target.id }));
    setBusy(true);
    setErr(null);
    try {
      if (target.kind === "provider") await AiApi.pauseProvider(stop, reason.trim());
      else await AiApi.pauseAgent(target.id, stop, reason.trim());
      toast(stop ? t("bdg.kill.done", { n: target.name }) : t("bdg.kill.resumed", { n: target.name }), stop ? "info" : "ok", stop ? `ai.${target.kind}.pause` : `ai.${target.kind}.resume`);
      onDone();
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.cancelled) return setErr(t("stepup.cancelled"));
      if (e instanceof ApiError && e.code === "AUDIT_UNAVAILABLE") return setErr(t("bdg.kill.auditDown"));
      setErr(errText(i, e));
    }
  };
  return (
    <Modal
      title={stop ? t("bdg.kill.t", { n: target.name }) : t("bdg.kill.resumeT", { n: target.name })}
      text={stop ? t(target.kind === "provider" ? "bdg.kill.providerM" : "bdg.kill.agentM") : t("bdg.kill.resumeM")}
      icon="power"
      tone={stop ? "bad" : "warn"}
      onClose={() => !busy && onClose()}
      testId="kill-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn label={stop ? t("bdg.kill.ok") : t("bdg.kill.resumeOk")} kind={stop ? "danger" : "primary"} onClick={() => void submit()} busy={busy} disabled={!typedOk} testId="kill-ok" />
        </>
      }
    >
      <div className="field">
        <label htmlFor="kill-reason" className="req">
          {t("cmd.reason")}
        </label>
        <textarea
          id="kill-reason"
          className="textarea"
          rows={3}
          data-autofocus=""
          maxLength={300}
          placeholder={t("bdg.kill.reasonPh")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="kill-reason"
        />
      </div>
      {stop && (
        <div className="field mt-8">
          <label htmlFor="kill-type" className="req">
            {t("bdg.kill.type")} <b className="mono">{target.id}</b>
          </label>
          <input
            id="kill-type"
            className={cx("input mono", typed && !typedOk && "is-invalid")}
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={target.id}
            data-testid="kill-type"
          />
        </div>
      )}
      <FieldErr msg={err} />
      <p className="xs muted row mt-8">
        <Icon name="smartphoneKey" /> {t("dsc.stepUpNote")}
      </p>
      <p className="xs muted row">
        <Icon name="audit" /> {t("cmd.auditNote")}
      </p>
    </Modal>
  );
}

const ERR_KEY: Record<NonNullable<AgentErrors[keyof AgentErrors]>, MessageKey> = {
  pct: "bdg.cfg.err.pct",
  perRequest: "bdg.cfg.err.perRequest",
  cap: "bdg.cfg.err.cap",
  tools: "bdg.cfg.err.tools",
  model: "bdg.cfg.err.model",
  belowSkill: "bdg.cfg.err.belowSkill",
  monthBelowDay: "lim.err.month",
};

/** max_cost_usd of the active and open versions of the agent's skills (null — could not load: ai-control still checks) */
async function loadSkillCosts(agent: AiAgent): Promise<SkillCost[] | null> {
  const wanted = agent.skills
    .filter((s) => !s.code_managed)
    .flatMap((s) => [...(s.active_version != null ? [s.active_version] : []), ...s.pending.map((p) => p.version)].map((v) => ({ id: s.skill_id, v })));
  // what loaded is a lower bound of the check (ai-control re-checks everything); nothing loaded → no client check
  const got = await Promise.allSettled(wanted.map((w) => SkillsApi.version(w.id, w.v)));
  const vs = got.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (wanted.length && !vs.length) return null;
  return vs.map((v) => ({ skill_id: v.skill_id, version: v.version, status: v.status, max_cost_usd: v.artifact.limits.max_cost_usd }));
}

/** skills named in 409 AGENT_PER_REQUEST_BELOW_SKILL */
function costsOf(e: ApiError): SkillCost[] | null {
  const xs = e.details.skills;
  if (!Array.isArray(xs)) return null;
  const out: SkillCost[] = [];
  for (const x of xs) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    if (typeof r.skill_id === "string" && typeof r.version === "number" && typeof r.max_cost_usd === "string")
      out.push({ skill_id: r.skill_id, version: r.version, status: (typeof r.status === "string" ? r.status : "PUBLISHED") as SkillCost["status"], max_cost_usd: r.max_cost_usd });
  }
  return out;
}

export function AgentConfigDrawer({
  agent,
  state,
  onClose,
  onSaved,
}: {
  agent: AiAgent;
  /** budgets of the agent from the overview: the daily limit and the month spent (checks and warnings) */
  state: AiAgentRuntimeState | undefined;
  onClose: () => void;
  onSaved: (a: AiAgent, warnings: AiCommandWarning[]) => void;
}) {
  const i = useI18n();
  const { t, fmt } = i;
  const { can } = useSession();
  const toast = useToast();
  const [f, setF] = useState<AgentForm>(() => agentForm(agent));
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [skillCosts, setSkillCosts] = useState<SkillCost[] | null>(null);
  const [dayLimit, setDayLimit] = useState<string | null>(state?.day?.limit_usd ?? null);
  const [warnOk, setWarnOk] = useState(false);
  useEffect(() => {
    let live = true;
    // a late answer never replaces what ai-control already reported (409 details)
    void loadSkillCosts(agent).then((c) => live && setSkillCosts((cur) => cur ?? c));
    return () => {
      live = false;
    };
  }, [agent]);
  const ctx: AgentCtx = { agent, skillCosts, dayLimitUsd: dayLimit, monthSpentUsd: state?.month?.cost_usd ?? null };
  const errors = validateAgent(f, ctx);
  const warnings = agentWarnings(f, ctx);
  const warnKey = warnings.map((w) => w.k).join(",");
  useEffect(() => setWarnOk(false), [warnKey]);
  const patch = agentPatch(agent, f);
  const changed = Object.keys(patch).length > 0;
  const canEdit = can("ops.kill_switch");
  const top = errors.per_request_max_usd === "belowSkill" ? skillAbove(cleanUsd(f.per_request_max_usd), skillCosts) : null;
  const errMsg = (k: keyof AgentForm) => {
    const e = errors[k];
    if (!e) return null;
    if (e === "belowSkill" && top) return t("bdg.cfg.err.belowSkill", { v: usdShort(top.max_cost_usd), s: top.skill_id, n: top.version, st: top.status });
    if (e === "monthBelowDay") return t("lim.err.month", { v: fmtUsd(dayLimit, 2) });
    return t(ERR_KEY[e]);
  };
  const field = (k: keyof AgentForm, label: MessageKey, hint: MessageKey, props: { inputMode?: "decimal" | "numeric"; prefix?: string; suffix?: string; ph?: string } = {}) => (
    <div className="field" data-field={k}>
      <label htmlFor={`cfg-${k}`}>{t(label)}</label>
      <div className={cx("input-affix", errors[k] && "is-invalid")}>
        {props.prefix && <span className="affix">{props.prefix}</span>}
        <input
          id={`cfg-${k}`}
          className="input mono"
          inputMode={props.inputMode}
          value={f[k]}
          placeholder={props.ph}
          disabled={!canEdit}
          onChange={(e) => setF({ ...f, [k]: e.target.value })}
          aria-invalid={errors[k] ? true : undefined}
          data-testid={`cfg-${k}`}
        />
        {props.suffix && <span className="affix">{props.suffix}</span>}
      </div>
      <span className="hint">{t(hint)}</span>
      <FieldErr msg={errMsg(k)} />
    </div>
  );
  const blocked = !changed || Object.keys(errors).length > 0 || (warnings.length > 0 && !warnOk);
  const save = async () => {
    if (blocked) return;
    if (reason.trim().length < 3) return setErr(t("cmd.errReason", { n: 3 }));
    setBusy(true);
    setErr(null);
    try {
      const { warnings: after, ...a } = await AiApi.patchAgent(agent.agent_id, { ...patch, reason: reason.trim(), expected_version: agent.config_version });
      toast(t("bdg.cfg.saved", { n: a.name }), "ok", "ai.agent.config.update");
      onSaved(a, after ?? []);
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.cancelled) return setErr(t("stepup.cancelled"));
      if (e instanceof ApiError && e.code === "AUDIT_UNAVAILABLE") return setErr(t("ai.auditDown"));
      // ai-control checked against fresher data: show it on the field, not as a bare code
      if (e instanceof ApiError && e.code === "AGENT_PER_REQUEST_BELOW_SKILL") {
        const c = costsOf(e);
        if (c?.length) {
          setSkillCosts(c);
          return setErr(null);
        }
      }
      if (e instanceof ApiError && e.code === "AGENT_MONTHLY_BELOW_DAILY" && typeof e.details.daily_limit_usd === "string") {
        setDayLimit(e.details.daily_limit_usd);
        return setErr(null);
      }
      setErr(errText(i, e));
    }
  };
  return (
    <Drawer
      title={t("bdg.cfg.t", { n: agent.name })}
      sub={
        <>
          <span className="mono">{agent.agent_id}</span>
          <span>
            · {t("bdg.cfg.version", { n: agent.config_version })} · <Who id={agent.updated_by} name={agent.updated_by_name} /> {agent.updated_at && `· ${fmt.dateTime(agent.updated_at)}`}
          </span>
        </>
      }
      onClose={onClose}
      testId="cfg-drawer"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <span className="grow" />
          <Btn kind="primary" icon="check" label={t(warnings.length ? "bdg.cfg.saveAnyway" : "bdg.cfg.save")} perm="ops.kill_switch" disabled={blocked} busy={busy} onClick={() => void save()} testId="cfg-save" />
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label htmlFor="cfg-mode">{t("bdg.cfg.mode")}</label>
          <Select<AgentForm["degraded_mode"]>
            id="cfg-mode"
            label={t("bdg.cfg.mode")}
            value={f.degraded_mode}
            disabled={!canEdit}
            onChange={(v) => setF({ ...f, degraded_mode: v })}
            testId="cfg-mode"
            options={(["fallback_model", "refuse", "none"] as const).map((v) => ({ v, label: t(`bdg.mode.${v}`) }))}
          />
          <span className="hint">{t(`bdg.mode.${f.degraded_mode}.h`)}</span>
        </div>
        <div className="grid-2">
          {field("degrade_at_pct", "bdg.cfg.pct", "bdg.cfg.pctH", { inputMode: "numeric", suffix: "%" })}
          {field("model_fallback", "bdg.cfg.fallback", "bdg.cfg.fallbackH", { ph: "claude-haiku-4-5" })}
          {field("per_request_max_usd", "bdg.cfg.perRequest", "bdg.cfg.perRequestH", { inputMode: "decimal", prefix: "$" })}
          {field("monthly_cap_usd", "bdg.cfg.cap", "bdg.cfg.capH", { inputMode: "decimal", prefix: "$", ph: t("bdg.noCap") })}
          {field("max_tool_calls", "bdg.cfg.tools", "bdg.cfg.toolsH", { inputMode: "numeric" })}
        </div>
        <Callout icon="info">
          {t("bdg.cfg.dayNote")}
          {dayLimit != null && <> {t("bdg.cfg.dayNow", { v: fmtUsd(dayLimit, 2) })}</>}
        </Callout>
        {changed && (
          <ul className="lim-diff" data-testid="cfg-diff">
            {Object.entries(patch).map(([k, v]) => (
              <li key={k}>
                <span className="mono">{k}</span>
                <span className="mono">
                  {String((agent as unknown as Record<string, unknown>)[k] == null ? "—" : trimZeros(String((agent as unknown as Record<string, unknown>)[k])))} <Icon name="right" />{" "}
                  <b>{v == null ? "—" : String(v)}</b>
                </span>
              </li>
            ))}
          </ul>
        )}
        {warnings.length > 0 && (
          <WarnConfirm
            items={warnings.map((w) =>
              w.k === "monthBelowSpent"
                ? t("bdg.cfg.warn.monthBelowSpent", { cap: fmtUsd(w.cap, 2), spent: fmtUsd(w.spent, 2) })
                : t("bdg.cfg.warn.dayBelowPerRequest", { day: fmtUsd(w.day, 2), per: usdShort(w.per) }),
            )}
            ok={warnOk}
            onOk={setWarnOk}
            testId="cfg-warn"
          />
        )}
        <div className="field">
          <label htmlFor="cfg-reason" className="req">
            {t("cmd.reason")}
          </label>
          <textarea id="cfg-reason" className="textarea" rows={2} maxLength={300} value={reason} disabled={!canEdit} onChange={(e) => setReason(e.target.value)} placeholder={t("bdg.cfg.reasonPh")} data-testid="cfg-reason" />
        </div>
        <FieldErr msg={err} />
        <p className="xs muted row">
          <Icon name="smartphoneKey" /> {t("dsc.stepUpNote")}
        </p>
        <p className="xs muted row">
          <Icon name="audit" /> {t("cmd.auditNote")}
        </p>
      </div>
    </Drawer>
  );
}

/** consequences of a change the operator acknowledges before saving (review 7, M3) */
export function WarnConfirm({ items, ok, onOk, testId }: { items: string[]; ok: boolean; onOk: (v: boolean) => void; testId: string }) {
  const { t } = useI18n();
  return (
    <Callout kind="warn" icon="alert" testId={testId}>
      <ul className="ai-warn-list">
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <label className="check ai-warn-ok">
        <input type="checkbox" checked={ok} onChange={(e) => onOk(e.target.checked)} data-testid={`${testId}-ok`} />
        <span>{t("ai.warn.ok")}</span>
      </label>
    </Callout>
  );
}

/** warnings[] of an ai-control command: a known code → dictionary text, else the server text */
export function warningText(i: Pick<I18n, "t" | "lang">, w: AiCommandWarning, levelName: (code: string) => string = (c) => c): string {
  const d = w.details;
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  const num = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
  switch (w.code) {
    case "MONTHLY_CAP_BELOW_SPENT":
      return i.t("ai.warn.MONTHLY_CAP_BELOW_SPENT", { cap: fmtUsd(str("monthly_cap_usd"), 2), spent: fmtUsd(str("spent_usd"), 2) });
    case "DAILY_LIMIT_UNKNOWN":
      return i.t("ai.warn.DAILY_LIMIT_UNKNOWN");
    case "LEVEL_BELOW_DEFAULT":
      return i.t("ai.warn.LEVEL_BELOW_DEFAULT", {
        l: levelName(str("level") ?? "—"),
        n: num("concierge_messages_per_day") ?? "—",
        d: levelName(str("default_level") ?? "—"),
        dn: num("default_messages_per_day") ?? "—",
      });
    default:
      return i.lang === "ru" ? w.message : w.code;
  }
}

/** after a saved command: what ai-control warned about (stays until dismissed) */
export function SavedWarnings({ items, onClose, testId, levelName }: { items: AiCommandWarning[]; onClose: () => void; testId: string; levelName?: (code: string) => string }) {
  const i = useI18n();
  if (!items.length) return null;
  return (
    <Callout kind="warn" icon="alert" testId={testId}>
      <div className="ai-warn-head">
        <b>{i.t("ai.warn.savedT")}</b>
        <span className="grow" />
        <button type="button" className="icon-btn sm" aria-label={i.t("common.close")} onClick={onClose} data-testid={`${testId}-close`}>
          <Icon name="x" />
        </button>
      </div>
      <ul className="ai-warn-list">
        {items.map((w, n) => (
          <li key={n} data-code={w.code}>
            {warningText(i, w, levelName)}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function AlertsPanel({ o, onChanged }: { o: AiBudgetOverview; onChanged: () => void }) {
  const i = useI18n();
  const { t } = i;
  const toast = useToast();
  const [items, setItems] = useState<AiAlert[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const load = useCallback(async (more: string | null = null) => {
    try {
      const p = await AiApi.alerts({ cursor: more });
      setItems((xs) => (more && xs ? [...xs, ...p.items] : p.items));
      setCursor(p.next_cursor);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, o.at]);
  const names = new Map(o.agents.map((a) => [a.agent_id, a.name]));
  const ack = async (a: AiAlert) => {
    try {
      const x = await AiApi.ack(a.alert_id);
      setItems((xs) => xs?.map((y) => (y.alert_id === x.alert_id ? x : y)) ?? null);
      onChanged();
    } catch (e) {
      toast(errText(i, e), "err");
    }
  };
  return (
    <section className="panel mt-16" data-testid="bdg-alerts" aria-labelledby="bdg-alerts-h">
      <div className="panel-h">
        <h2 className="panel-t" id="bdg-alerts-h">
          <Icon name="bell" />
          {t("bdg.alerts.t")}
        </h2>
        <span className="panel-sub">{t("bdg.alerts.sub")}</span>
      </div>
      {error ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !items ? (
        <Spinner label={t("common.loading")} />
      ) : !items.length ? (
        <Empty icon="bell" title={t("bdg.alerts.emptyT")} text={t("bdg.alerts.emptyM")} testId="bdg-alerts-empty" />
      ) : (
        <ul className="ai-alerts">
          {items.map((a) => (
            <AlertRow key={a.alert_id} a={a} agentName={names.get(a.agent_id) ?? a.agent_id} onAck={() => void ack(a)} />
          ))}
        </ul>
      )}
      {cursor && (
        <div className="pager">
          <span />
          <Btn size="sm" icon="down" label={t("common.loadMore")} onClick={() => void load(cursor)} />
        </div>
      )}
    </section>
  );
}

export function AlertRow({ a, agentName, onAck, compact }: { a: AiAlert; agentName: string; onAck?: () => void; compact?: boolean }) {
  const { t, fmt } = useI18n();
  const kind = alertKind(a);
  const tone = kind === "unpriced" || a.threshold >= 90 ? "bad" : "warn";
  return (
    <li className={cx("ai-alert", `is-${tone}`, a.acked_at && "is-acked")} data-testid="ai-alert" data-alert={a.alert_id}>
      <Icon name={kind === "unpriced" ? "coins" : kind === "autoPause" ? "power" : "alert"} />
      <div className="grow">
        <div className="ai-alert-t">
          <b>{agentName}</b> · {kind === "unpriced" ? t("ai.alert.unpriced", { m: unpricedModel(a) }) : t(`ai.alert.${kind}`, { n: a.threshold })}
        </div>
        <div className="xs muted">
          {a.spent_usd && a.limit_usd && kind !== "unpriced" && (
            <>
              {fmtUsd(a.spent_usd, 4)} / {fmtUsd(a.limit_usd, 2)} ·{" "}
            </>
          )}
          <span title={fmt.dateTime(a.created_at)}>{fmt.rel(a.created_at)}</span>
          {a.acked_at && !compact && (
            <>
              {" "}
              · {t("ai.alert.acked")} <Who id={a.acked_by} name={a.acked_by_name} />
            </>
          )}
        </div>
      </div>
      {!a.acked_at && onAck && <Btn size="xs" icon="check" label={t("ai.alert.ack")} perm="ops.kill_switch" onClick={onAck} testId="ai-alert-ack" />}
    </li>
  );
}

function LevelsPanel() {
  const { t, fmt, lang } = useI18n();
  const [levels, setLevels] = useState<AccessLevel[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [edit, setEdit] = useState<AccessLevel | "new" | null>(null);
  const [saved, setSaved] = useState<AiCommandWarning[]>([]);
  const load = useCallback(async () => {
    try {
      setLevels((await AiApi.levels()).items);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="panel mt-16" data-testid="bdg-levels" aria-labelledby="bdg-levels-h">
      <div className="panel-h">
        <h2 className="panel-t" id="bdg-levels-h">
          <Icon name="layers" />
          {t("lvl.t")}
        </h2>
        <span className="panel-sub">{t("lvl.sub")}</span>
        <span className="grow" />
        {levels && <Btn size="sm" icon="plus" label={t("lvl.new")} perm="ops.kill_switch" onClick={() => setEdit("new")} testId="lvl-new" />}
      </div>
      {error ? (
        <div className="panel-b">
          <LoadError error={error} onRetry={() => void load()} />
        </div>
      ) : !levels ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="table-wrap">
          {saved.length > 0 && (
            <div className="panel-b lvl-saved">
              <SavedWarnings
                items={saved}
                onClose={() => setSaved([])}
                testId="lvl-saved-warn"
                levelName={(c) => {
                  const l = levels.find((x) => x.code === c);
                  return l ? `«${lang === "ru" ? l.name_ru : l.name_en}»` : c;
                }}
              />
            </div>
          )}
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("lvl.col.level")}</th>
                <th className="num">{t("lvl.col.messages")}</th>
                <th>{t("lvl.col.changed")}</th>
                <th className="act" aria-label={t("common.actions")} />
              </tr>
            </thead>
            <tbody>
              {levels.map((l) => (
                <tr key={l.code} data-level={l.code} data-testid="lvl-row">
                  <td>
                    <b>{lang === "ru" ? l.name_ru : l.name_en}</b> <span className="mono xs muted">{l.code}</span>
                    {l.is_default && (
                      <>
                        {" "}
                        <Pill tone="info" dot={false}>
                          {t("lvl.default")}
                        </Pill>
                      </>
                    )}
                  </td>
                  <td className="num">
                    <b data-testid="lvl-messages">{fmt.num(l.concierge_messages_per_day)}</b> <span className="xs muted">{t("lvl.perDay")}</span>
                  </td>
                  <td className="xs">
                    <Who id={l.updated_by} name={l.updated_by_name} /> {l.updated_at && <span className="muted">· {fmt.dateTime(l.updated_at)}</span>}
                  </td>
                  <td className="act">
                    <Btn size="xs" icon="edit" label={t("common.edit")} perm="ops.kill_switch" onClick={() => setEdit(l)} testId="lvl-edit" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel-f ai-foot">
        <Icon name="info" /> {t("lvl.foot")}
      </div>
      {edit && (
        <LevelDialog
          level={edit === "new" ? null : edit}
          levels={levels ?? []}
          onClose={() => setEdit(null)}
          onSaved={(w) => {
            setEdit(null);
            setSaved(w);
            void load();
          }}
        />
      )}
    </section>
  );
}

const LEVEL_ERR: Record<NonNullable<ReturnType<typeof levelErrors>>, MessageKey> = {
  code: "lvl.err.code",
  name: "lvl.err.name",
  messages: "lvl.err.messages",
  defaultZero: "lvl.err.defaultZero",
};

export function LevelDialog({ level, levels, onClose, onSaved }: { level: AccessLevel | null; levels: AccessLevel[]; onClose: () => void; onSaved: (w: AiCommandWarning[]) => void }) {
  const i = useI18n();
  const { t, lang } = i;
  const toast = useToast();
  const [code, setCode] = useState(level?.code ?? "");
  const [ru, setRu] = useState(level?.name_ru ?? "");
  const [en, setEn] = useState(level?.name_en ?? "");
  const [n, setN] = useState(level ? String(level.concierge_messages_per_day) : "10");
  const [def, setDef] = useState(level?.is_default ?? false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [warnOk, setWarnOk] = useState(false);
  const codeOk = /^[a-z][a-z0-9_]{1,31}$/.test(code);
  const form = { code, name_ru: ru, name_en: en, messages: n, is_default: def };
  const fe = levelErrors(form);
  const nOk = fe !== "messages" && fe !== "defaultZero";
  const warnings = levelWarnings(form, levels);
  const warnKey = warnings.map((w) => `${w.k}:${w.n}`).join(",");
  useEffect(() => setWarnOk(false), [warnKey]);
  const nameOf = (l: AccessLevel) => (lang === "ru" ? l.name_ru : l.name_en);
  const submit = async () => {
    if (fe) return setErr(t(LEVEL_ERR[fe]));
    if (warnings.length && !warnOk) return setErr(t("ai.warn.confirm"));
    if (reason.trim().length < 3) return setErr(t("cmd.errReason", { n: 3 }));
    setBusy(true);
    setErr(null);
    try {
      const res = await AiApi.putLevel(code, {
        name_ru: ru.trim(),
        name_en: en.trim(),
        concierge_messages_per_day: Number(n),
        ...(def !== (level?.is_default ?? false) ? { is_default: def } : {}),
        reason: reason.trim(),
        expected_version: level?.version ?? 0,
      });
      toast(t("lvl.saved"), "ok", "ai.access_level.update");
      onSaved(res.warnings ?? []);
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.cancelled) return setErr(t("stepup.cancelled"));
      if (e instanceof ApiError && e.code === "AUDIT_UNAVAILABLE") return setErr(t("ai.auditDown"));
      setErr(errText(i, e));
    }
  };
  return (
    <Modal
      title={level ? t("lvl.editT", { n: level.code }) : t("lvl.newT")}
      text={t("lvl.editM")}
      icon="layers"
      onClose={() => !busy && onClose()}
      testId="lvl-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn label={t(warnings.length ? "bdg.cfg.saveAnyway" : "common.save")} kind="primary" onClick={() => void submit()} disabled={warnings.length > 0 && !warnOk} busy={busy} testId="lvl-ok" />
        </>
      }
    >
      <div className="stack sm">
        {!level && (
          <div className="field">
            <label htmlFor="lvl-code" className="req">
              {t("lvl.f.code")}
            </label>
            <input id="lvl-code" className={cx("input mono", code && !codeOk && "is-invalid")} value={code} maxLength={32} onChange={(e) => setCode(e.target.value.trim())} data-testid="lvl-code" />
            <span className="hint">{t("lvl.f.codeH")}</span>
          </div>
        )}
        <div className="grid-2">
          <div className="field">
            <label htmlFor="lvl-ru" className="req">
              {t("lvl.f.nameRu")}
            </label>
            <input id="lvl-ru" className="input" value={ru} maxLength={60} onChange={(e) => setRu(e.target.value)} data-testid="lvl-ru" />
          </div>
          <div className="field">
            <label htmlFor="lvl-en" className="req">
              {t("lvl.f.nameEn")}
            </label>
            <input id="lvl-en" className="input" value={en} maxLength={60} onChange={(e) => setEn(e.target.value)} data-testid="lvl-en" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="lvl-n" className="req">
            {t("lvl.f.messages")}
          </label>
          <div className={cx("input-affix", !nOk && "is-invalid")}>
            <input id="lvl-n" className="input mono" inputMode="numeric" value={n} maxLength={4} onChange={(e) => setN(e.target.value)} data-autofocus="" data-testid="lvl-n" />
            <span className="affix">{t("lvl.perDay")}</span>
          </div>
          <span className="hint">{t("lvl.f.messagesH")}</span>
          <FieldErr msg={fe === "defaultZero" ? t("lvl.err.defaultZero") : null} />
        </div>
        <label className="check">
          <input type="checkbox" checked={def} onChange={(e) => setDef(e.target.checked)} disabled={level?.is_default} data-testid="lvl-default" />
          <span>{t("lvl.f.default")}</span>
        </label>
        {warnings.length > 0 && (
          <WarnConfirm
            items={warnings.map((w) =>
              w.k === "belowDefault"
                ? t("lvl.warn.belowDefault", { n: w.n, d: nameOf(w.level), dn: w.level.concierge_messages_per_day })
                : t("lvl.warn.othersBelow", { n: w.n, l: w.levels.map((l) => `${nameOf(l)} (${l.concierge_messages_per_day})`).join(", ") }),
            )}
            ok={warnOk}
            onOk={setWarnOk}
            testId="lvl-warn"
          />
        )}
        <div className="field">
          <label htmlFor="lvl-reason" className="req">
            {t("cmd.reason")}
          </label>
          <textarea id="lvl-reason" className="textarea" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("lvl.reasonPh")} data-testid="lvl-reason" />
        </div>
        <FieldErr msg={err} />
        <p className="xs muted row">
          <Icon name="smartphoneKey" /> {t("dsc.stepUpNote")}
        </p>
        <p className="xs muted row">
          <Icon name="audit" /> {t("cmd.auditNote")}
        </p>
      </div>
    </Modal>
  );
}

export type { AiAgentRuntimeState };
