import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AiAgent, EvalCase, EvalRun, SkillCompare, SkillContent, SkillDetail, SkillVersion } from "@tilhero/contracts/admin";
import { AiApi, SkillsApi } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { fmtUsd } from "../../lib/money";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { LoadError } from "../../ui/LoadError";
import { Btn, Callout, cx, Empty, FieldErr, Pill, Select, Spinner, TabPanel, Tabs } from "../../ui/kit";
import { ConfirmCommand, Modal } from "../../ui/overlays";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { contentOf, editable, INSTRUCTION_MAX, initialVersion, LIFECYCLE, move, openVersion, skillActions, skillChanges, validateSkill, type SkillAction } from "./ai";
import { Ms, StatusPill, Who } from "./parts";

type Tab = "editor" | "test" | "compare" | "activations";
const SOURCES = ["official", "ticket_provider", "provider", "trusted_media"] as const;
const SAFETY = ["no_invented_prices", "source_required", "web_content_untrusted", "tool_before_claim"] as const;
export const RUN_POLL_MS = 1500;

/**
 * Skill screen: versions (left), the selected version with the lifecycle stepper and tabs — editor of every field of
 * ТЗ Admin §8 (read-only for PUBLISHED / DEPRECATED), Test Console, comparison of versions, activations. Buttons
 * follow the lifecycle and the permissions (skills.edit — draft, test, review request; skills.publish — approve,
 * publish with TOTP, deprecate; rollback — skills.publish or ops.kill_switch with TOTP, always a new activation).
 */
export function SkillScreen({ skillId, onBack }: { skillId: string; onBack: () => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const toast = useToast();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [agent, setAgent] = useState<AiAgent | null>(null);
  const [selV, setSelV] = useState<number | null>(null);
  const [ver, setVer] = useState<SkillVersion | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>("editor");
  const [busy, setBusy] = useState(false);

  const loadDetail = useCallback(
    async (select?: number) => {
      try {
        const d = await SkillsApi.get(skillId);
        setDetail(d);
        setError(null);
        setSelV((cur) => select ?? cur ?? initialVersion(d.versions, d.active?.version ?? null));
        return d;
      } catch (e) {
        setError(e);
        return null;
      }
    },
    [skillId],
  );
  useEffect(() => {
    setDetail(null);
    setVer(null);
    setSelV(null);
    void loadDetail();
    AiApi.agents()
      .then((a) => setAgent(a.items.find((x) => x.agent_id === skillId.split(".")[0]) ?? null))
      .catch(() => setAgent(null));
  }, [skillId, loadDetail]);
  useEffect(() => {
    if (!detail || !detail.agent_id || !agent) return;
    if (agent.agent_id !== detail.agent_id) setAgent(null);
  }, [detail, agent]);

  const loadVersion = useCallback(
    async (v: number) => {
      try {
        setVer(await SkillsApi.version(skillId, v));
      } catch (e) {
        setError(e);
      }
    },
    [skillId],
  );
  useEffect(() => {
    if (selV != null) void loadVersion(selV);
  }, [selV, loadVersion]);

  const refresh = async (v?: number) => {
    const d = await loadDetail(v);
    if (d && (v ?? selV) != null) await loadVersion(v ?? selV!);
  };

  const active = detail?.active?.version ?? null;
  const open = detail ? openVersion(detail.versions) : null;
  const newDraft = async () => {
    setBusy(true);
    try {
      const from = ver && ver.status === "PUBLISHED" ? ver.version : active;
      const v = await SkillsApi.create(skillId, from);
      toast(t("sk.created", { v: v.version }), "ok", "skill.version.created");
      setTab("editor");
      await refresh(v.version);
    } catch (e) {
      toast(errText(i, e), "err");
    } finally {
      setBusy(false);
    }
  };

  if (error && !detail)
    return (
      <div data-testid="skill">
        <Btn kind="ghost" icon="chevL" label={t("sk.back")} onClick={onBack} testId="sk-back" />
        <div className="mt-12">
          <LoadError error={error} onRetry={() => void loadDetail()} testId="sk-error" />
        </div>
      </div>
    );
  if (!detail) return <Spinner label={t("common.loading")} />;

  return (
    <div data-testid="skill" data-skill={skillId}>
      <div className="panel sk-top">
        <span className={cx("health-dot", !active && "warn")} />
        <span>
          {active ? t("sk.runtime", { v: active }) : t("sk.noRuntime")}
          {detail.active && <span className="xs muted"> · {t("sk.since", { t: fmt.dateTime(detail.active.since) })}</span>}
        </span>
        <span className="mono xs muted">{detail.agent_id}</span>
        {detail.critical && (
          <Pill tone="warn" dot={false} title={t("agt.criticalH")}>
            {t("sk.fourEyes")}
          </Pill>
        )}
        <span className="grow" />
        <Btn kind="ghost" size="sm" icon="chevL" label={t("sk.back")} onClick={onBack} testId="sk-back" />
      </div>
      <div className="sk-layout">
        <aside className="sk-versions" aria-label={t("sk.versions")} data-testid="sk-versions">
          {detail.versions_full
            .slice()
            .sort((a, b) => b.version - a.version)
            .map((v) => (
              <button key={v.version} type="button" className={cx("sk-ver", selV === v.version && "is-sel")} aria-pressed={selV === v.version} onClick={() => setSelV(v.version)} data-version={v.version}>
                <span className="sk-ver-h">
                  <b>v{v.version}</b>
                  <StatusPill status={v.status} />
                </span>
                <span className="xs muted">
                  {v.version === active && <b className="good-ink">{t("sk.activeRuntime")} · </b>}
                  <Who id={v.author} name={v.author_name} /> · {fmt.date(v.created_at)}
                </span>
                {v.change_note && <span className="xs sk-ver-note">{v.change_note}</span>}
              </button>
            ))}
          <Btn
            kind="ghost"
            icon="plus"
            label={t("sk.newDraft")}
            perm="skills.edit"
            disabled={!!open}
            title={open ? t("sk.draftExists", { v: open.version }) : undefined}
            busy={busy}
            onClick={() => void newDraft()}
            block
            testId="sk-new-draft"
          />
        </aside>
        <section className="panel sk-main">
          {!ver ? (
            <Spinner label={t("common.loading")} />
          ) : (
            <>
              <div className="sk-head">
                <div>
                  <h2 className="sk-title">
                    <span className="mono">{skillId}</span> · v{ver.version}
                  </h2>
                  <span className="xs muted">
                    {agent?.name ?? detail.agent_id} · {t("sk.author")} <Who id={ver.author} name={ver.author_name} />
                    {ver.reviewer && (
                      <>
                        {" "}
                        · {t("sk.reviewer")} <Who id={ver.reviewer} name={ver.reviewer_name} />
                      </>
                    )}
                  </span>
                </div>
                <Stepper v={ver} />
              </div>
              <Tabs<Tab>
                id="sk"
                label={t("sk.tabs")}
                value={tab}
                onChange={setTab}
                className="sk-tabs"
                items={[
                  { v: "editor", label: t("sk.tab.editor"), icon: "edit", testId: "sk-tab-editor" },
                  { v: "test", label: "Test Console", icon: "flask", testId: "sk-tab-test" },
                  { v: "compare", label: t("sk.tab.compare"), icon: "diff", testId: "sk-tab-compare" },
                  { v: "activations", label: t("sk.tab.activations"), icon: "branch", cnt: detail.activations.length, testId: "sk-tab-activations" },
                ]}
              />
              <TabPanel id="sk" value={tab}>
                {tab === "editor" && <Editor key={`${ver.version}:${ver.version_row}`} detail={detail} ver={ver} agent={agent} active={active} onChanged={(v) => void refresh(v)} />}
                {tab === "test" && <TestConsole key={ver.version} skillId={skillId} ver={ver} detail={detail} onTested={() => void refresh()} />}
                {tab === "compare" && <ComparePane skillId={skillId} detail={detail} ver={ver} active={active} />}
                {tab === "activations" && <Activations detail={detail} />}
              </TabPanel>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Stepper({ v }: { v: SkillVersion }) {
  const { t } = useI18n();
  const cur = LIFECYCLE.indexOf(v.status);
  return (
    <ol className="sk-stepper" aria-label={t("sk.lifecycle")} data-testid="sk-stepper">
      {LIFECYCLE.map((s, idx) => (
        <li key={s} className={cx(idx < cur && "is-done", idx === cur && "is-cur")} aria-current={idx === cur ? "step" : undefined}>
          <span className="mono">{s}</span>
          {s === "REVIEW" && idx === cur && v.review?.decision === "approved" && <span className="xs">{t("sk.approved")}</span>}
        </li>
      ))}
    </ol>
  );
}

const ERR: Record<string, MessageKey> = {
  "system_instruction:empty": "sk.err.instructionEmpty",
  "system_instruction:long": "sk.err.instructionLong",
  "allowed_tools:notAllowed": "sk.err.tools",
  "primary:model": "sk.err.model",
  "fallback:model": "sk.err.model",
  "max_tokens:range": "sk.err.maxTokens",
  "max_cost_usd:money": "sk.err.maxCost",
  "max_cost_usd:aboveAgent": "sk.err.aboveAgent",
  "timeout_ms:range": "sk.err.timeout",
  "retries:range": "sk.err.retries",
  "confidence:range": "sk.err.confidence",
  "change_note:long": "sk.err.note",
  "source_priority:empty": "sk.err.sources",
};

function Editor({ detail, ver, agent, active, onChanged }: { detail: SkillDetail; ver: SkillVersion; agent: AiAgent | null; active: number | null; onChanged: (v?: number) => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { can, me } = useSession();
  const toast = useToast();
  const base = useMemo(() => contentOf(ver), [ver]);
  const [f, setF] = useState<SkillContent>(base);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [act, setAct] = useState<SkillAction | null>(null);
  const ro = !editable(ver.status) || !can("skills.edit");
  const whitelist = agent?.tools_whitelist ?? null;
  const errors = validateSkill(f, whitelist, agent?.per_request_max_usd ?? null);
  const changes = skillChanges(base, f);
  const dirty = Object.keys(changes).length > 0;
  const actions = skillActions(ver, active);
  const mine = !!me && ver.author === me.staff.staff_id;
  const e = (k: keyof typeof errors) => (errors[k] ? t(ERR[`${k}:${errors[k]}`] ?? "sk.err.generic") : null);
  const tools = [...new Set([...(whitelist ?? []), ...f.allowed_tools])];
  const lines = f.system_instruction.split("\n").length;

  const save = async () => {
    if (Object.keys(errors).length) return setErr(t("sk.err.fix"));
    setBusy(true);
    setErr(null);
    try {
      const v = await SkillsApi.patch(detail.skill_id, ver.version, changes, ver.version_row);
      toast(t("sk.saved", { v: v.version }), "ok", "skill.version.updated");
      onChanged(v.version);
    } catch (x) {
      setBusy(false);
      if (x instanceof ApiError && x.code === "VERSION_CONFLICT") {
        setErr(t("sk.conflict"));
        onChanged(ver.version);
        return;
      }
      setErr(errText(i, x));
    }
  };
  const simple = async (fn: () => Promise<unknown>, okKey: MessageKey, meta: string) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      toast(t(okKey, { v: ver.version }), "ok", meta);
      onChanged(ver.version);
    } catch (x) {
      setErr(errText(i, x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sk-editor" data-testid="sk-editor">
      {!editable(ver.status) && (
        <Callout kind="info" icon="lock" testId="sk-readonly">
          <b>{t("sk.ro.t")}</b> {ver.status === "PUBLISHED" ? t("sk.ro.published") : t("sk.ro.deprecated")}
        </Callout>
      )}
      {editable(ver.status) && ver.status !== "DRAFT" && (
        <Callout kind="warn" icon="alert" testId="sk-reset-note">
          {t("sk.editResets", { s: ver.status })}
        </Callout>
      )}
      {ver.last_run && (
        <p className="xs muted row" data-testid="sk-last-run">
          <Icon name="flask" /> {t("sk.lastRun", { t: ver.last_run.at ? fmt.dateTime(ver.last_run.at) : "—" })}{" "}
          {ver.last_run.passed === true ? <Pill tone="good">{t("tc.passed")}</Pill> : ver.last_run.passed === false ? <Pill tone="bad">{t("tc.failed")}</Pill> : <Pill>{t("tc.running")}</Pill>}
          {!ver.last_run.current && <span className="warn-ink"> · {t("sk.runStale")}</span>}
        </p>
      )}
      {ver.review && (
        <Callout kind={ver.review.decision === "approved" ? "good" : "bad"} icon={ver.review.decision === "approved" ? "checkCircle" : "alertCircle"} testId="sk-review">
          <b>{t(ver.review.decision === "approved" ? "sk.review.approved" : "sk.review.rejected")}</b> <Who id={ver.reviewer} name={ver.reviewer_name} />
          {ver.review.comment && <span className="block">«{ver.review.comment}»</span>}
        </Callout>
      )}
      <div className="grid-2">
        <Ro label="skill_id" value={detail.skill_id} />
        <Ro label="agent_id" value={detail.agent_id} />
        <Ro label="version" value={String(ver.version)} />
        <Ro label="effective_from" value={ver.artifact.effective_from ? fmt.dateTime(ver.artifact.effective_from) : t("sk.onPublish")} />
      </div>
      <div className="field">
        <label htmlFor="sk-instr">System instruction</label>
        <textarea
          id="sk-instr"
          className={cx("textarea mono-area sk-instr", errors.system_instruction && "is-invalid")}
          rows={12}
          spellCheck={false}
          readOnly={ro}
          value={f.system_instruction}
          maxLength={INSTRUCTION_MAX + 100}
          onChange={(x) => setF({ ...f, system_instruction: x.target.value })}
          data-testid="sk-instruction"
        />
        <span className="hint">{t("sk.instrStat", { l: fmt.num(lines), c: fmt.num(f.system_instruction.length), max: fmt.num(INSTRUCTION_MAX) })}</span>
        <FieldErr msg={e("system_instruction")} />
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="sk-schema">Expected output schema</label>
          <Select id="sk-schema" label="Expected output schema" value={f.output_schema} disabled={ro} onChange={(v) => setF({ ...f, output_schema: v })} options={[{ v: "concierge-answer-v1", label: "concierge-answer-v1" }]} />
          <span className="hint">{t("sk.schemaH")}</span>
        </div>
        <div className="field">
          <span className="field-label">Allowed tools</span>
          <div className="sk-chips" role="group" aria-label="Allowed tools" data-testid="sk-tools">
            {tools.map((x) => {
              const on = f.allowed_tools.includes(x);
              const outside = !!whitelist && !whitelist.includes(x);
              return (
                <button
                  key={x}
                  type="button"
                  className={cx("sk-chip", on && "is-on", outside && "is-bad")}
                  aria-pressed={on}
                  disabled={ro}
                  onClick={() => setF({ ...f, allowed_tools: on ? f.allowed_tools.filter((y) => y !== x) : [...f.allowed_tools, x] })}
                  data-tool={x}
                >
                  <Icon name={on ? "check" : "plus"} />
                  <span className="mono">{x}</span>
                </button>
              );
            })}
          </div>
          <span className="hint">{whitelist ? t("sk.toolsH") : t("sk.toolsNoAgent")}</span>
          <FieldErr msg={e("allowed_tools")} />
        </div>
      </div>
      <div className="field">
        <span className="field-label">Source priorities</span>
        <ol className="sk-prio" data-testid="sk-sources">
          {f.source_priority.map((s, idx) => (
            <li key={s}>
              <span className="mono xs muted">{idx + 1}</span>
              <span className="mono grow">{s}</span>
              {!ro && (
                <>
                  <button type="button" className="icon-btn" aria-label={t("sk.up", { s })} disabled={idx === 0} onClick={() => setF({ ...f, source_priority: move(f.source_priority, idx, -1) })}>
                    <Icon name="up" />
                  </button>
                  <button type="button" className="icon-btn" aria-label={t("sk.down", { s })} disabled={idx === f.source_priority.length - 1} onClick={() => setF({ ...f, source_priority: move(f.source_priority, idx, 1) })}>
                    <Icon name="down" />
                  </button>
                  <button type="button" className="icon-btn" aria-label={t("sk.remove", { s })} onClick={() => setF({ ...f, source_priority: f.source_priority.filter((x) => x !== s) })}>
                    <Icon name="x" />
                  </button>
                </>
              )}
            </li>
          ))}
          {!ro &&
            SOURCES.filter((s) => !f.source_priority.includes(s)).map((s) => (
              <li key={s} className="is-off">
                <span className="mono xs muted">—</span>
                <span className="mono grow muted">{s}</span>
                <button type="button" className="icon-btn" aria-label={t("sk.add", { s })} onClick={() => setF({ ...f, source_priority: [...f.source_priority, s] })}>
                  <Icon name="plus" />
                </button>
              </li>
            ))}
        </ol>
        <FieldErr msg={e("source_priority")} />
      </div>
      <div className="grid-2">
        <TextField id="sk-primary" label="Model policy · primary" value={f.model_policy.primary} ro={ro} mono err={e("primary")} onChange={(v) => setF({ ...f, model_policy: { ...f.model_policy, primary: v.trim() } })} hint={t("sk.modelH")} />
        <TextField id="sk-fallback" label="Model policy · fallback" value={f.model_policy.fallback ?? ""} ro={ro} mono err={e("fallback")} placeholder="—" onChange={(v) => setF({ ...f, model_policy: { ...f.model_policy, fallback: v.trim() || null } })} />
        <TextField id="sk-maxtok" label="max_tokens" value={String(f.limits.max_tokens)} ro={ro} mono err={e("max_tokens")} numeric onChange={(v) => setF({ ...f, limits: { ...f.limits, max_tokens: Number(v) || 0 } })} hint="64–4096" />
        <TextField
          id="sk-maxcost"
          label="max_cost_usd"
          value={f.limits.max_cost_usd}
          ro={ro}
          mono
          err={e("max_cost_usd")}
          prefix="$"
          onChange={(v) => setF({ ...f, limits: { ...f.limits, max_cost_usd: v } })}
          hint={agent ? t("sk.maxCostH", { v: fmtUsd(agent.per_request_max_usd, 4) }) : undefined}
        />
        <TextField id="sk-timeout" label="timeout_ms" value={String(f.limits.timeout_ms)} ro={ro} mono err={e("timeout_ms")} numeric onChange={(v) => setF({ ...f, limits: { ...f.limits, timeout_ms: Number(v) || 0 } })} hint="1000–120000" />
        <TextField id="sk-retries" label="retries" value={String(f.limits.retries)} ro={ro} mono err={e("retries")} numeric onChange={(v) => setF({ ...f, limits: { ...f.limits, retries: Number(v) || 0 } })} hint="0–3" />
      </div>
      <div className="field">
        <label htmlFor="sk-conf">
          Confidence threshold · <b className="mono">{fmt.num(f.confidence.min, 2)}</b>
        </label>
        <input
          id="sk-conf"
          type="range"
          min={0}
          max={1}
          step={0.05}
          disabled={ro}
          value={f.confidence.min}
          onChange={(x) => setF({ ...f, confidence: { min: Math.round(Number(x.target.value) * 100) / 100 } })}
          className="sk-range"
          data-testid="sk-confidence"
        />
        <span className="hint">{t("sk.confH")}</span>
        <FieldErr msg={e("confidence")} />
      </div>
      <div className="field">
        <span className="field-label">Safety policy</span>
        <div className="sk-safety" data-testid="sk-safety">
          {SAFETY.map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={f.safety_policy[k]} disabled={ro} onChange={(x) => setF({ ...f, safety_policy: { ...f.safety_policy, [k]: x.target.checked } })} />
              <span>{t(`sk.safety.${k}`)}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="grid-2">
        <Ro label={t("sk.author")} value={<Who id={ver.author} name={ver.author_name} />} />
        <Ro label={t("sk.reviewer")} value={<Who id={ver.reviewer} name={ver.reviewer_name} />} />
      </div>
      <div className="field">
        <label htmlFor="sk-note">Change note</label>
        <textarea id="sk-note" className="textarea" rows={2} readOnly={ro} maxLength={1000} value={f.change_note ?? ""} onChange={(x) => setF({ ...f, change_note: x.target.value })} data-testid="sk-note" />
        <FieldErr msg={e("change_note")} />
      </div>
      <Ro label="Rollback target" value={ver.artifact.rollback_target ? `v${ver.artifact.rollback_target}` : "—"} />

      <div className="sk-actbar" data-testid="sk-actions">
        <span className="xs muted grow">{t(`sk.hint.${ver.status}`)}</span>
        <FieldErr msg={err} />
        {actions.includes("save") && <Btn label={t("sk.save")} icon="check" perm="skills.edit" disabled={!dirty || ro} busy={busy} onClick={() => void save()} testId="sk-save" />}
        {actions.includes("requestReview") && (
          <Btn
            kind="primary"
            label={t("sk.requestReview")}
            icon="send"
            perm="skills.edit"
            disabled={dirty}
            busy={busy}
            onClick={() => void simple(() => SkillsApi.review(detail.skill_id, ver.version, "request"), "sk.reviewRequested", "skill.review.requested")}
            testId="sk-request-review"
          />
        )}
        {actions.includes("reject") && <Btn kind="danger-ghost" label={t("sk.reject")} icon="x" perm="skills.publish" onClick={() => setAct("reject")} testId="sk-reject" />}
        {actions.includes("approve") && (
          <Btn
            kind="primary"
            label={t("sk.approve")}
            icon="checkCircle"
            perm="skills.publish"
            disabled={detail.critical && mine}
            title={detail.critical && mine ? t("sk.fourEyesH") : undefined}
            onClick={() => setAct("approve")}
            testId="sk-approve"
          />
        )}
        {actions.includes("publish") && <Btn kind="primary" label={t("sk.publish")} icon="power" perm="skills.publish" onClick={() => setAct("publish")} testId="sk-publish" />}
        {actions.includes("deprecate") && <Btn kind="danger-ghost" label={t("sk.deprecate")} icon="ban" perm="skills.publish" onClick={() => setAct("deprecate")} testId="sk-deprecate" />}
        {actions.includes("rollback") && (
          <Btn kind="primary" label={t("sk.rollbackTo", { v: ver.version })} icon="rollback" perm={["skills.publish", "ops.kill_switch"]} onClick={() => setAct("rollback")} testId="sk-rollback" />
        )}
      </div>
      {detail.critical && mine && actions.includes("approve") && (
        <p className="xs muted row" data-testid="sk-four-eyes">
          <Icon name="userCheck" /> {t("sk.fourEyesH")}
        </p>
      )}
      {(act === "approve" || act === "reject") && (
        <ReviewDialog
          approve={act === "approve"}
          onClose={() => setAct(null)}
          onConfirm={async (comment) => {
            try {
              await SkillsApi.review(detail.skill_id, ver.version, act, comment || undefined);
              toast(t(act === "approve" ? "sk.approvedToast" : "sk.rejectedToast", { v: ver.version }), "ok", "skill.review.decided");
              onChanged(ver.version);
              return null;
            } catch (x) {
              return errText(i, x);
            }
          }}
        />
      )}
      {act === "publish" && <PublishDialog skillId={detail.skill_id} ver={ver} onClose={() => setAct(null)} onDone={() => (setAct(null), onChanged(ver.version))} />}
      {(act === "rollback" || act === "deprecate") && (
        <ConfirmCommand
          title={act === "rollback" ? t("sk.rollbackT", { v: ver.version }) : t("sk.deprecateT", { v: ver.version })}
          text={act === "rollback" ? t("sk.rollbackM", { from: active ?? "—", v: ver.version }) : t("sk.deprecateM")}
          icon={act === "rollback" ? "rollback" : "ban"}
          tone={act === "rollback" ? "warn" : "bad"}
          ok={act === "rollback" ? t("sk.rollbackOk") : t("sk.deprecateOk")}
          okKind={act === "rollback" ? "primary" : "danger"}
          minReason={3}
          extra={
            act === "rollback" ? (
              <p className="xs muted row mb-12">
                <Icon name="smartphoneKey" /> {t("dsc.stepUpNote")}
              </p>
            ) : undefined
          }
          testId="sk-confirm"
          onClose={() => setAct(null)}
          onConfirm={async (reason) => {
            if (reason.length > 300) return t("dsc.reasonLong");
            try {
              let cancelled: number[] = [];
              if (act === "rollback") cancelled = ((await SkillsApi.rollback(detail.skill_id, ver.version, reason)).cancelled_activations ?? []).map((a) => a.version);
              else await SkillsApi.deprecate(detail.skill_id, ver.version, reason);
              // ревью 7: откат отменяет отложенные публикации — оператор должен это увидеть
              const done = cancelled.length
                ? t("sk.rolledBackCancelled", { v: ver.version, list: cancelled.map((x) => `v${x}`).join(", ") })
                : t(act === "rollback" ? "sk.rolledBack" : "sk.deprecated", { v: ver.version });
              toast(done, "ok", act === "rollback" ? "skill.rolled_back" : "skill.deprecated");
              onChanged(ver.version);
              return null;
            } catch (x) {
              if (x instanceof ApiError && x.cancelled) return t("stepup.cancelled");
              if (x instanceof ApiError && x.code === "AUDIT_UNAVAILABLE") return t("ai.auditDown");
              return errText(i, x);
            }
          }}
        />
      )}
    </div>
  );
}

function Ro({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="input ro mono">{value}</div>
    </div>
  );
}

function TextField(p: { id: string; label: string; value: string; ro: boolean; onChange: (v: string) => void; err?: string | null; hint?: string; mono?: boolean; numeric?: boolean; prefix?: string; placeholder?: string }) {
  const input = (
    <input
      id={p.id}
      className={cx("input", p.mono && "mono", !p.prefix && p.err && "is-invalid")}
      inputMode={p.numeric ? "numeric" : undefined}
      readOnly={p.ro}
      value={p.value}
      placeholder={p.placeholder}
      onChange={(e) => p.onChange(e.target.value)}
      data-testid={p.id}
    />
  );
  return (
    <div className="field">
      <label htmlFor={p.id}>{p.label}</label>
      {p.prefix ? (
        <div className={cx("input-affix", p.err && "is-invalid")}>
          <span className="affix">{p.prefix}</span>
          {input}
        </div>
      ) : (
        input
      )}
      {p.hint && <span className="hint">{p.hint}</span>}
      <FieldErr msg={p.err} />
    </div>
  );
}

function ReviewDialog({ approve, onClose, onConfirm }: { approve: boolean; onClose: () => void; onConfirm: (comment: string) => Promise<string | null> }) {
  const { t } = useI18n();
  const [comment, setComment] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!approve && comment.trim().length < 3) return setErr(t("sk.rejectNeedComment"));
    setBusy(true);
    const r = await onConfirm(comment.trim());
    setBusy(false);
    if (r) setErr(r);
    else onClose();
  };
  return (
    <Modal
      title={approve ? t("sk.approveT") : t("sk.rejectT")}
      text={approve ? t("sk.approveM") : t("sk.rejectM")}
      icon={approve ? "checkCircle" : "x"}
      tone={approve ? "" : "warn"}
      onClose={() => !busy && onClose()}
      testId="sk-review-dialog"
      footer={
        <>
          <Btn label={t("common.cancel")} onClick={onClose} disabled={busy} />
          <Btn label={approve ? t("sk.approve") : t("sk.reject")} kind={approve ? "primary" : "danger"} busy={busy} onClick={() => void submit()} testId="sk-review-ok" />
        </>
      }
    >
      <div className="field">
        <label htmlFor="sk-review-comment" className={approve ? undefined : "req"}>
          {t("sk.comment")}
        </label>
        <textarea id="sk-review-comment" className="textarea" rows={3} maxLength={1000} data-autofocus="" value={comment} onChange={(e) => setComment(e.target.value)} data-testid="sk-review-comment" />
      </div>
      <FieldErr msg={err} />
      <p className="xs muted row">
        <Icon name="audit" /> {t("cmd.auditNote")}
      </p>
    </Modal>
  );
}

function PublishDialog({ skillId, ver, onClose, onDone }: { skillId: string; ver: SkillVersion; onClose: () => void; onDone: () => void }) {
  const i = useI18n();
  const { t } = i;
  const toast = useToast();
  const [when, setWhen] = useState("");
  return (
    <ConfirmCommand
      title={t("sk.publishT", { v: ver.version })}
      text={t("sk.publishM")}
      icon="power"
      ok={t("sk.publishOk")}
      minReason={3}
      testId="sk-publish-confirm"
      extra={
        <>
          <div className="field mb-12">
            <label htmlFor="sk-when">{t("sk.effectiveFrom")}</label>
            <input id="sk-when" type="datetime-local" className="input" value={when} onChange={(e) => setWhen(e.target.value)} data-testid="sk-when" />
            <span className="hint">{t("sk.effectiveFromH")}</span>
          </div>
          <p className="xs muted row mb-12">
            <Icon name="smartphoneKey" /> {t("dsc.stepUpNote")}
          </p>
        </>
      }
      onClose={onClose}
      onConfirm={async (reason) => {
        if (reason.length > 300) return t("dsc.reasonLong");
        const at = when ? new Date(when) : null;
        if (at && (Number.isNaN(at.getTime()) || at.getTime() < Date.now() - 60_000)) return t("sk.err.when");
        try {
          await SkillsApi.publish(skillId, ver.version, reason, at ? at.toISOString() : undefined);
          toast(t("sk.published", { v: ver.version }), "ok", "skill.published");
          onDone();
          return null;
        } catch (x) {
          if (x instanceof ApiError && x.cancelled) return t("stepup.cancelled");
          if (x instanceof ApiError && x.code === "AUDIT_UNAVAILABLE") return t("ai.auditDown");
          return errText(i, x);
        }
      }}
    />
  );
}

// ---------------------------------------------------------------- Test Console

function TestConsole({ skillId, ver, detail, onTested }: { skillId: string; ver: SkillVersion; detail: SkillDetail; onTested: () => void }) {
  const i = useI18n();
  const { t, fmt } = i;
  const [cases, setCases] = useState<EvalCase[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [cmp, setCmp] = useState<string>(() => (detail.active && detail.active.version !== ver.version ? String(detail.active.version) : ""));
  const [run, setRun] = useState<EvalRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // one polling chain at a time (review 7): a new run stops the previous chain, late answers of an old run are dropped
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const following = useRef<string | null>(null);
  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(
    () => () => {
      following.current = null;
      stop();
    },
    [stop],
  );

  useEffect(() => {
    SkillsApi.cases(skillId)
      .then((c) => {
        setCases(c.items);
        setSel(new Set(c.items.filter((x) => x.enabled).map((x) => x.case_id)));
      })
      .catch(setError);
  }, [skillId]);

  const poll = useCallback(
    async (runId: string, background: boolean) => {
      try {
        const r = await SkillsApi.run(runId, background);
        if (following.current !== runId) return;
        setRun(r);
        stop();
        if (r.status === "queued" || r.status === "running") timer.current = setTimeout(() => void poll(runId, true), RUN_POLL_MS);
        else if (background) onTested();
      } catch (e) {
        if (following.current === runId) setError(e);
      }
    },
    [onTested, stop],
  );
  const follow = useCallback(
    (runId: string, background: boolean) => {
      stop();
      following.current = runId;
      void poll(runId, background);
    },
    [poll, stop],
  );
  useEffect(() => {
    if (ver.last_run) follow(ver.last_run.run_id, false);
  }, [ver.last_run, follow]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const all = cases ? cases.filter((c) => c.enabled).every((c) => sel.has(c.case_id)) && sel.size === cases.filter((c) => c.enabled).length : true;
      const r = await SkillsApi.test(skillId, ver.version, { ...(all ? {} : { case_ids: [...sel] }), ...(cmp ? { compare_version: Number(cmp) } : {}) });
      setRun(null);
      follow(r.run_id, true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const running = run?.status === "queued" || run?.status === "running";
  const cand = run?.results.filter((r) => r.side === "candidate") ?? [];
  const cmpBy = new Map((run?.results.filter((r) => r.side === "compare") ?? []).map((r) => [r.case_id, r]));
  const diffBy = new Map((run?.comparison ?? []).map((c) => [c.case_id, c]));
  const others = detail.versions.filter((v) => v.version !== ver.version && v.status !== "DEPRECATED");

  return (
    <div className="tc" data-testid="tc">
      <div className="tc-setup">
        <div className="field">
          <span className="field-label">{t("tc.cases")}</span>
          {!cases && !error && <Spinner label={t("common.loading")} />}
          {cases && !cases.length && <span className="xs muted">{t("tc.noCases")}</span>}
          {cases && cases.length > 0 && (
            <ul className="tc-cases" data-testid="tc-cases">
              {cases.map((c) => (
                <li key={c.case_id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={sel.has(c.case_id)}
                      disabled={!c.enabled}
                      onChange={(e) => {
                        const s = new Set(sel);
                        if (e.target.checked) s.add(c.case_id);
                        else s.delete(c.case_id);
                        setSel(s);
                      }}
                    />
                    <span className="mono">{c.name}</span>
                  </label>
                  {c.required && (
                    <Pill tone="warn" dot={false}>
                      required
                    </Pill>
                  )}
                  {!c.enabled && <span className="xs muted">{t("tc.disabled")}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="tc-side">
          <div className="field">
            <label htmlFor="tc-cand">{t("tc.candidate")}</label>
            <div className="input ro mono" id="tc-cand">
              v{ver.version} · {ver.status}
            </div>
          </div>
          <div className="field">
            <label htmlFor="tc-cmp">{t("tc.compare")}</label>
            <Select
              id="tc-cmp"
              label={t("tc.compare")}
              value={cmp}
              onChange={setCmp}
              testId="tc-cmp"
              options={[{ v: "", label: t("tc.noCompare") }, ...others.map((v) => ({ v: String(v.version), label: `v${v.version} · ${v.status}` }))]}
            />
          </div>
          <Btn kind="primary" icon="play" label={running ? t("tc.running") : t("tc.run")} perm="skills.edit" busy={busy || running} disabled={!sel.size} onClick={() => void start()} testId="tc-run" />
          <span className="xs muted">{t("tc.budget")}</span>
        </div>
      </div>
      {error ? <LoadError error={error} testId="tc-error" /> : null}
      {run && (
        <section className="panel mt-12" data-testid="tc-result" data-status={run.status}>
          <div className="panel-h">
            <h3 className="panel-t">
              <Icon name="flask" />
              {t("tc.result", { v: run.version })}
              {run.compare_version && <span className="muted"> {t("tc.vs", { v: run.compare_version })}</span>}
            </h3>
            <span className="grow" />
            <span className="xs muted">
              {t("tc.startedBy")} <Who id={run.started_by} name={run.started_by_name} /> · {fmt.dateTime(run.created_at)}
            </span>
          </div>
          {running && (
            <div className="panel-b">
              <Spinner label={t("tc.runningM")} />
            </div>
          )}
          {run.status === "failed" && (
            <div className="panel-b">
              <Callout kind="bad" icon="alertCircle">
                {t("tc.runFailed", { c: run.error_code ?? "—" })}
              </Callout>
            </div>
          )}
          {run.totals && (
            <div className="statband tc-totals">
              <div className="stat">
                <div className="stat-l">{t("tc.t.cases")}</div>
                <div className="stat-v">{run.totals.cases}</div>
              </div>
              <div className={cx("stat", run.totals.failed > 0 && "is-bad")}>
                <div className="stat-l">{t("tc.t.passed")}</div>
                <div className="stat-v">
                  {run.totals.passed}
                  <span className="slash">/</span>
                  {run.totals.cases}
                </div>
              </div>
              <div className={cx("stat", run.totals.required_failed > 0 && "is-bad")}>
                <div className="stat-l">{t("tc.t.required")}</div>
                <div className="stat-v">{run.totals.required_failed}</div>
              </div>
              <div className="stat">
                <div className="stat-l">{t("tc.t.cost")}</div>
                <div className="stat-v">{fmtUsd(run.totals.cost_usd, 4)}</div>
              </div>
              <div className="stat">
                <div className="stat-l">{t("tc.t.latency")}</div>
                <div className="stat-v">
                  <Ms ms={run.totals.latency_ms_avg} />
                </div>
              </div>
            </div>
          )}
          {run.status === "done" && run.totals && (
            <div className="panel-b">
              {run.totals.required_failed === 0 && run.artifact_hash === ver.artifact_hash ? (
                <Callout kind="good" icon="checkCircle" testId="tc-verdict">
                  {ver.status === "DRAFT" || ver.status === "TESTED" ? t("tc.verdictOk") : t("tc.verdictOkOther")}
                </Callout>
              ) : run.totals.required_failed > 0 ? (
                <Callout kind="bad" icon="alertCircle" testId="tc-verdict">
                  {t("tc.verdictBad", { n: run.totals.required_failed })}
                </Callout>
              ) : (
                <Callout kind="warn" icon="alert" testId="tc-verdict">
                  {t("tc.verdictStale")}
                </Callout>
              )}
            </div>
          )}
          {cand.length > 0 && (
            <div className="table-wrap">
              <table className="tbl compact tc-tbl" data-testid="tc-table">
                <thead>
                  <tr>
                    <th>{t("tc.col.case")}</th>
                    <th>{t("tc.col.result")}</th>
                    <th>{t("tc.col.checks")}</th>
                    <th>{t("tc.col.tools")}</th>
                    <th>{t("tc.col.kinds")}</th>
                    <th className="num">{t("tc.col.costLat")}</th>
                    {run.compare_version && <th>{t("tc.col.compare", { v: run.compare_version })}</th>}
                  </tr>
                </thead>
                <tbody>
                  {cand.map((r) => {
                    const failed = r.checks.filter((c) => !c.passed);
                    const other = cmpBy.get(r.case_id);
                    const diff = diffBy.get(r.case_id);
                    return (
                      <tr key={r.case_id} className={r.passed ? undefined : "sev-bad"} data-case={r.case_name}>
                        <td>
                          <span className="mono">{r.case_name}</span>
                          {r.required && <span className="block xs muted">required</span>}
                        </td>
                        <td>{r.passed ? <Pill tone="good">{t("tc.passed")}</Pill> : <Pill tone="bad">{t("tc.failed")}</Pill>}</td>
                        <td className="xs tc-checks">
                          {failed.length === 0 ? (
                            <span className="muted nowrap">{t("tc.allChecks", { n: r.checks.length })}</span>
                          ) : (
                            failed.map((c) => (
                              <span key={c.check} className="block mono bad-ink">
                                ✕ {c.check}
                                {c.detail && <span className="muted"> ({c.detail})</span>}
                              </span>
                            ))
                          )}
                          {r.violations.length > 0 && <span className="block bad-ink">{t("tc.violations", { g: r.violations.join(", ") })}</span>}
                        </td>
                        <td className="mono xs">{r.tools.join(", ") || "—"}</td>
                        <td>
                          <span className="tc-kinds">
                            {r.kinds.length
                              ? r.kinds.map((k) => (
                                  <span key={k} className="tag plain">
                                    {t(`rq.seg.${k === "fact" || k === "estimate" || k === "recommendation" ? k : "other"}`)}
                                  </span>
                                ))
                              : "—"}
                          </span>
                        </td>
                        <td className="num xs nowrap">
                          <span className="mono">{fmtUsd(r.cost_usd, 4)}</span>
                          <span className="block muted">
                            <Ms ms={r.latency_ms} />
                          </span>
                        </td>
                        {run.compare_version && (
                          <td className="xs">
                            {other ? other.passed ? <Pill tone="good">{t("tc.passed")}</Pill> : <Pill tone="bad">{t("tc.failed")}</Pill> : "—"}
                            {other?.checks
                              .filter((c) => !c.passed)
                              .map((c) => (
                                <span key={c.check} className="block mono muted">
                                  ✕ {c.check}
                                </span>
                              ))}
                            {diff && diff.changed.length > 0 && <span className="block warn-ink">{t("tc.changed", { f: diff.changed.map((x) => t(x === "tools" ? "tc.col.tools" : "tc.col.kinds")).join(", ") })}</span>}
                            {diff?.cost_delta_usd && (
                              <span className="block mono muted">
                                Δ {diff.cost_delta_usd.startsWith("-") ? "−" : "+"}
                                {fmtUsd(diff.cost_delta_usd.replace(/^-/, ""), 4)}
                              </span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="panel-f ai-foot">
            <Icon name="lock" /> {t("tc.foot")}
          </div>
        </section>
      )}
      {!run && !error && (
        <Empty icon="flask" title={t("tc.emptyT")} text={t("tc.emptyM")} testId="tc-empty" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- compare

function ComparePane({ skillId, detail, ver, active }: { skillId: string; detail: SkillDetail; ver: SkillVersion; active: number | null }) {
  const i = useI18n();
  const { t } = i;
  const versions = detail.versions.map((v) => v.version).sort((a, b) => b - a);
  const [a, setA] = useState(() => String(active && active !== ver.version ? active : (versions.find((x) => x !== ver.version) ?? ver.version)));
  const [b, setB] = useState(String(ver.version));
  const [cmp, setCmp] = useState<SkillCompare | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (a === b) {
      setCmp(null);
      return;
    }
    let alive = true;
    SkillsApi.compare(skillId, Number(a), Number(b))
      .then((c) => alive && (setCmp(c), setError(null)))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [skillId, a, b]);
  const opts = detail.versions.map((v) => ({ v: String(v.version), label: `v${v.version} · ${v.status}` }));
  if (versions.length < 2)
    return (
      <div className="sk-pane">
        <Empty icon="diff" title={t("cmp.oneT")} text={t("cmp.oneM")} />
      </div>
    );
  const changedLines = cmp ? cmp.instruction_diff.filter((l) => l.op !== "equal").length : 0;
  return (
    <div className="sk-pane" data-testid="cmp">
      <div className="toolbar">
        <Select id="cmp-a" label="A" value={a} onChange={setA} options={opts} testId="cmp-a" />
        <Icon name="right" />
        <Select id="cmp-b" label="B" value={b} onChange={setB} options={opts} testId="cmp-b" />
      </div>
      {a === b && <Callout icon="info">{t("cmp.same")}</Callout>}
      {error ? <LoadError error={error} testId="cmp-error" /> : null}
      {cmp && (
        <div className="stack">
          <section className="panel" data-testid="cmp-diff">
            <div className="panel-h">
              <h3 className="panel-t">System instruction</h3>
              <span className="panel-sub">{changedLines ? t("cmp.lines", { n: changedLines }) : t("cmp.noLines")}</span>
            </div>
            <pre className="cmp-diff">
              {cmp.instruction_diff.map((l, idx) => (
                <div key={idx} className={cx("cmp-line", `is-${l.op}`)}>
                  <span className="cmp-n">{l.a ?? ""}</span>
                  <span className="cmp-n">{l.b ?? ""}</span>
                  <span className="cmp-op">{l.op === "insert" ? "+" : l.op === "delete" ? "−" : " "}</span>
                  <span className="cmp-t">{l.text}</span>
                </div>
              ))}
            </pre>
          </section>
          <section className="panel" data-testid="cmp-fields">
            <div className="panel-h">
              <h3 className="panel-t">{t("cmp.fields")}</h3>
            </div>
            {cmp.fields.length ? (
              <div className="table-wrap">
                <table className="tbl compact">
                  <thead>
                    <tr>
                      <th>{t("cmp.field")}</th>
                      <th>v{cmp.a.version}</th>
                      <th>v{cmp.b.version}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cmp.fields.map((x) => (
                      <tr key={x.field}>
                        <td className="mono">{x.field}</td>
                        <td className="mono xs wrap-any del-ink">{x.a ?? "—"}</td>
                        <td className="mono xs wrap-any good-ink">{x.b ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="panel-b xs muted">{t("cmp.noFields")}</div>
            )}
          </section>
          <section className="panel" data-testid="cmp-runs">
            <div className="panel-h">
              <h3 className="panel-t">{t("cmp.runs")}</h3>
            </div>
            <div className="panel-b xs">
              {[cmp.a, cmp.b].map((s) => (
                <span key={s.version} className="block">
                  v{s.version}:{" "}
                  {s.last_run?.totals ? t("cmp.runLine", { p: s.last_run.totals.passed, c: s.last_run.totals.cases, f: s.last_run.totals.required_failed }) : t("cmp.noRun")}
                </span>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Activations({ detail }: { detail: SkillDetail }) {
  const { t, fmt } = useI18n();
  const cur = detail.active?.activation_id;
  const rows = detail.activations.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    <div className="sk-pane" data-testid="sk-activations">
      <Callout icon="branch">{t("act.lead")}</Callout>
      <div className="table-wrap panel">
        <table className="tbl compact">
          <thead>
            <tr>
              <th>{t("act.col.when")}</th>
              <th>{t("act.col.version")}</th>
              <th>{t("act.col.kind")}</th>
              <th>{t("act.col.by")}</th>
              <th>{t("cmd.reason")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.activation_id} className={a.activation_id === cur ? "sev-good" : undefined} data-testid="act-row">
                <td className="nowrap">
                  {fmt.dateTime(a.effective_from)}
                  {a.activation_id === cur && (
                    <span className="block">
                      <Pill tone="good">{t("act.current")}</Pill>
                    </span>
                  )}
                </td>
                <td className="mono">
                  v{a.version}
                  {a.previous_version && <span className="xs muted"> ← v{a.previous_version}</span>}
                </td>
                <td>
                  <Pill tone={a.kind === "rollback" ? "warn" : a.kind === "publish" ? "info" : "neutral"} dot={false}>
                    {t(`act.kind.${a.kind}`)}
                  </Pill>
                  {a.cancelled && (
                    <span className="block">
                      <Pill tone="neutral" dot={false}>
                        {t("act.cancelled")}
                      </Pill>
                    </span>
                  )}
                </td>
                <td>
                  <Who id={a.by} name={a.by_name} />
                </td>
                <td className="xs wrap-any">{a.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
