/**
 * Scenario editor (ScenarioPayload, ADM-CONT-04, AT-28): characters, nodes with the EN line and RU/UZ glosses,
 * transitions by the learner's intent, plot events, recovery points and ends with outcomes; the graph as an SVG of nodes
 * and arrows with the problems of the test run highlighted; «Тестовый прогон» (catalog ScenarioTestRun) whose issues
 * are clickable (→ node). Without a green run of THIS version (after the last edit) submission and publication are
 * closed — the reason is shown next to the buttons (KindSpec.gate).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ScenarioNode, ScenarioPayload, ScenarioTestRun, ScenarioTransition } from "@tilhero/contracts/content";
import { Content } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { useI18n, type MessageKey } from "../../i18n";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { Btn, Callout, cx, FieldErr, Pill } from "../../ui/kit";
import { useToast } from "../../ui/toasts";
import { errText } from "../../ui/errors";
import { AddBtn, CountPill } from "./LessonEditor";
import { CheckGroup, ItemHead, LocField, PathIssues, RefList, removeAt, Sec, SelectField, setAt, TextField, useEd } from "./fields";
import { analyzeScenario, layoutScenario, NODE_H, NODE_W, problemsByNode } from "./graph";
import { AUDIENCES, BANDS, GOALS, ID_RE, L, nodeOfPath, TOPICS } from "./model";
import { useRefs, withCurrent } from "./refs";
import type { EditorProps } from "./Workspace";

type P = ScenarioPayload;
const SG_END = { success: "sg.success", alt_success: "sg.alt", fail: "sg.fail" } as const;
const INTENTS = ["greet", "ask", "answer", "order", "ask_price", "pay", "confirm", "decline", "clarify", "thank", "goodbye", "other"];

export function ScenarioEditor({ payload: p, set, ver, isNew, dirty, focus, goTo, onVersion }: EditorProps<P>) {
  const { t, fmt } = useI18n();
  const refs = useRefs();
  const ids = Object.keys(p.nodes);
  const [sel, setSel] = useState<string | null>(() => (p.start_node in p.nodes ? p.start_node : (ids[0] ?? null)));
  const up = <K extends keyof P>(k: K, v: P[K]) => set((x) => ({ ...x, [k]: v }));
  const local = useMemo(() => analyzeScenario(p), [p]);
  const run: ScenarioTestRun | null = ver?.test_run ?? null;
  // the run belongs to the saved version: after an edit the picture falls back to the preliminary (local) check
  const shownIssues = run && !dirty ? run.issues : local.issues;
  const problems = useMemo(() => problemsByNode(shownIssues), [shownIssues]);

  useEffect(() => {
    if (!focus) return;
    const n = nodeOfPath(focus.path);
    if (n && n in p.nodes) setSel(n);
    // only on a new focus request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  useEffect(() => {
    if (sel && !(sel in p.nodes)) setSel(p.start_node in p.nodes ? p.start_node : (Object.keys(p.nodes)[0] ?? null));
  }, [p.nodes, p.start_node, sel]);

  const setNode = (id: string, fn: (n: ScenarioNode) => ScenarioNode) => set((x) => ({ ...x, nodes: { ...x.nodes, [id]: fn(x.nodes[id]!) } }));
  const addNode = () => {
    let k = ids.length + 1;
    while (`n${k}` in p.nodes) k++;
    const id = `n${k}`;
    set((x) => ({ ...x, nodes: { ...x.nodes, [id]: { speaker: x.characters[0]?.id ?? "", line_en: "", gloss: L(), hint: null, recovery_point: false, event: null, transitions: [], end: null } } }));
    setSel(id);
  };
  const removeNode = (id: string) =>
    set((x) => {
      const nodes = Object.fromEntries(
        Object.entries(x.nodes)
          .filter(([k]) => k !== id)
          .map(([k, n]) => [k, { ...n, transitions: n.transitions.filter((tr) => tr.to !== id) }]),
      );
      return { ...x, nodes };
    });
  const renameNode = (from: string, to: string) =>
    set((x) => {
      const nodes: P["nodes"] = {};
      for (const [k, n] of Object.entries(x.nodes)) nodes[k === from ? to : k] = { ...n, transitions: n.transitions.map((tr) => (tr.to === from ? { ...tr, to } : tr)) };
      return { ...x, nodes, start_node: x.start_node === from ? to : x.start_node };
    });

  return (
    <div className="ed" data-testid="scenario-editor">
      <Sec path="payload" title={t("se.basics")}>
        <div className="form-grid">
          <LocField path="payload.title" label={t("se.title")} value={p.title} max={120} onChange={(v) => up("title", v)} testId="se-title" />
          <LocField path="payload.task" label={t("se.task")} value={p.task} max={300} multiline onChange={(v) => up("task", v)} hint={t("se.taskHint")} />
          <SelectField path="payload.level" label={t("le.level")} value={p.level} options={BANDS.map((b) => ({ v: b, label: b }))} onChange={(v) => up("level", v)} />
          <SelectField path="payload.difficulty" label={t("se.difficulty")} value={String(p.difficulty)} options={[1, 2, 3, 4, 5].map((d) => ({ v: String(d), label: `${d} / 5` }))} onChange={(v) => up("difficulty", Number(v) as P["difficulty"])} />
          <CheckGroup path="payload.audience" label={t("ct.audience")} values={p.audience} options={AUDIENCES.map((a) => ({ v: a, label: t(`ageseg.${a}`) }))} onChange={(v) => up("audience", v)} required />
          <div className="field">
            <span className="field-label">{t("se.access")}</span>
            <span className="small">
              <Pill tone="good" dot={false}>
                {t("se.free")}
              </Pill>{" "}
              <span className="muted">{t("se.accessNote")}</span>
            </span>
          </div>
          <CheckGroup className="span-2" path="payload.goals" label={t("ct.goals")} values={p.goals} options={GOALS.map((g) => ({ v: g, label: t(`goal.${g}`) }))} onChange={(v) => up("goals", v)} />
          <CheckGroup className="span-2" path="payload.topics" label={t("ct.topics")} values={p.topics} options={TOPICS.map((x) => ({ v: x, label: t(`topic.${x}` as MessageKey) }))} onChange={(v) => up("topics", v)} />
          <LocField path="payload.completion.criteria" label={t("se.criteria")} value={p.completion.criteria} max={300} multiline onChange={(v) => up("completion", { criteria: v })} />
          <SelectField path="payload.rubric_id" label={t("le.rubric")} value={p.rubric_id} options={withCurrent(refs.options("rubric"), p.rubric_id, t("ct.choose"))} onChange={(v) => up("rubric_id", v)} required />
          <RefList path="payload.skill_ids" label={t("se.skills")} values={p.skill_ids} options={refs.options("skill")} onChange={(v) => up("skill_ids", v)} />
        </div>
      </Sec>

      <Sec path="payload.characters" title={t("se.characters")} aside={<CountPill n={p.characters.length} lo={1} hi={null} />}>
        {p.characters.map((c, i) => (
          <div key={i} className="item" data-path={`payload.characters[${i}]`}>
            <ItemHead n={i + 1} title={c.name || c.id} onRemove={p.characters.length > 1 ? () => up("characters", removeAt(p.characters, i)) : undefined} removeLabel={t("ct.removeN", { n: i + 1 })} />
            <div className="form-grid">
              <TextField path={`payload.characters[${i}].id`} label={t("se.charId")} value={c.id} mono max={64} onChange={(v) => up("characters", setAt(p.characters, i, { ...c, id: v }))} />
              <TextField path={`payload.characters[${i}].name`} label={t("se.charName")} value={c.name} max={60} required onChange={(v) => up("characters", setAt(p.characters, i, { ...c, name: v }))} />
              <LocField path={`payload.characters[${i}].role`} label={t("se.charRole")} value={c.role} max={120} onChange={(v) => up("characters", setAt(p.characters, i, { ...c, role: v }))} />
              <SelectField path={`payload.characters[${i}].voice`} label={t("se.voice")} value={c.voice} options={(["en-GB", "en-US"] as const).map((v) => ({ v, label: v }))} onChange={(v) => up("characters", setAt(p.characters, i, { ...c, voice: v }))} />
            </div>
          </div>
        ))}
        <AddBtn label={t("se.addChar")} onClick={() => up("characters", [...p.characters, { id: `c${p.characters.length + 1}`, name: "", role: L(), voice: "en-US" }])} />
      </Sec>

      <Sec path="payload.nodes" title={t("se.graph")} aside={<CountPill n={ids.length} lo={5} hi={30} />} testId="se-graph-sec">
        <div className="form-grid">
          <SelectField path="payload.start_node" label={t("se.start")} value={p.start_node} options={withCurrent(ids.map((id) => ({ v: id, label: id })), p.start_node)} onChange={(v) => up("start_node", v)} />
        </div>
        <TestRunPanel ver={ver} isNew={isNew} dirty={dirty} local={local} onRun={onVersion} onIssue={(code, node) => (node ? (setSel(node), goTo(`payload.nodes.${node}`)) : goTo(code === "START_MISSING" ? "payload.start_node" : "payload.nodes"))} />
        <ScenarioGraph payload={p} problems={problems} selected={sel} onSelect={setSel} preliminary={!run || dirty} />
        <div className="se-split">
          <NodeList p={p} problems={problems} sel={sel} onSelect={setSel} onAdd={addNode} />
          {sel && p.nodes[sel] ? (
            <NodeEditor key={sel} id={sel} p={p} node={p.nodes[sel]!} problems={problems.get(sel) ?? []} setNode={(fn) => setNode(sel, fn)} onRemove={() => removeNode(sel)} onRename={(to) => (renameNode(sel, to), setSel(to))} />
          ) : (
            <p className="small muted">{t("se.pickNode")}</p>
          )}
        </div>
        <p className="xs muted">{t("se.checkedNote", { t: run ? fmt.dateTime(run.checked_at) : "—" })}</p>
      </Sec>
    </div>
  );
}

/* ---------------------------------------------------------------- test run */

function TestRunPanel({ ver, isNew, dirty, local, onRun, onIssue }: { ver: EditorProps<P>["ver"]; isNew: boolean; dirty: boolean; local: ReturnType<typeof analyzeScenario>; onRun: (v: NonNullable<EditorProps<P>["ver"]>) => void; onIssue: (code: string, node: string | null) => void }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = ver?.test_run ?? null;
  const canRun = !!ver && !isNew && ver.status === "draft" && can("content.edit");
  const go = async () => {
    if (!ver || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await Content.testRun(ver.key, ver.version);
      onRun({ ...ver, test_run: r });
      toast(t(r.ok ? "se.runOk" : "se.runBad", { n: r.issues.length }), r.ok ? "ok" : "err", "content.test_run");
    } catch (e) {
      setErr((e as ApiError)?.cancelled ? null : errText(i18n, e));
    } finally {
      setBusy(false);
    }
  };
  const issues = run && !dirty ? run.issues : null;
  return (
    <div className="testrun" data-path="test_run" data-testid="se-testrun">
      <div className="row">
        {canRun && <Btn kind={run?.ok && !dirty ? "" : "primary"} icon="flask" label={t("se.testRun")} busy={busy} disabled={dirty} title={dirty ? t("ct.gate.saveFirst") : undefined} onClick={() => void go()} testId="se-run" />}
        {run && !dirty ? (
          <Pill tone={run.ok ? "good" : "bad"} testId="se-run-state">
            {run.ok ? t("se.green") : t("se.red", { n: run.issues.length })}
          </Pill>
        ) : (
          <Pill tone="warn" testId="se-run-state">
            {dirty ? t("se.staleDirty") : t("se.noRun")}
          </Pill>
        )}
        {run && !dirty && <span className="xs muted">{t("se.runAt", { t: fmt.dateTime(run.checked_at) })}</span>}
        {dirty && canRun && <span className="xs muted">{t("ct.gate.saveFirst")}</span>}
      </div>
      <FieldErr msg={err} />
      {run && !dirty && (
        <p className="small" data-testid="se-run-stats">
          {t("se.stats", { n: run.stats.nodes, d: run.stats.max_depth, p: run.stats.paths_to_success, s: run.stats.ends.success, a: run.stats.ends.alt_success, f: run.stats.ends.fail })}
        </p>
      )}
      {issues && issues.length > 0 && (
        <ul className="issue-list" aria-label={t("se.runIssues")} data-testid="se-run-issues">
          {issues.map((x, n) => (
            <li key={n} data-testid={`run-issue-${x.code}-${x.node_id ?? "all"}`}>
              <span className="grow">
                <span className="b">{t(`ci.${x.code}` as MessageKey)}</span>
                {x.node_id && <span className="mono xs muted block">{t("se.node", { id: x.node_id })}</span>}
              </span>
              <Btn size="xs" icon="right" label={x.node_id ? t("se.toNode") : t("ct.toField")} onClick={() => onIssue(x.code, x.node_id)} testId={`run-go-${x.node_id ?? x.code}`} />
            </li>
          ))}
        </ul>
      )}
      {(!run || dirty) && local.issues.length > 0 && (
        <p className="xs muted row" data-testid="se-local">
          <Icon name="info" /> {t("se.local", { n: local.issues.length })}
        </p>
      )}
      {run?.ok && !dirty && (
        <Callout kind="good" icon="checkCircle" testId="se-run-green">
          {t("se.greenM")}
        </Callout>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- graph (SVG) */

export function ScenarioGraph({ payload, problems, selected, onSelect, preliminary }: { payload: Pick<P, "nodes" | "start_node" | "characters">; problems: Map<string, string[]>; selected: string | null; onSelect: (id: string) => void; preliminary?: boolean }) {
  const { t } = useI18n();
  const lay = useMemo(() => layoutScenario(payload), [payload]);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const wrap = useRef<HTMLDivElement>(null);
  // the selected node (from the list or an issue of the run) is scrolled into the visible part of the graph
  useEffect(() => {
    const box = wrap.current;
    const n = selected ? lay.nodes.find((x) => x.id === selected) : null;
    if (!box || !n) return;
    const left = n.x - box.clientWidth / 2 + NODE_W / 2;
    const top = n.y - box.clientHeight / 2 + NODE_H / 2;
    box.scrollTo?.({ left: Math.max(0, left), top: Math.max(0, top), behavior: "smooth" });
  }, [selected, lay]);
  const badEdge = (from: string) => (problems.get(from) ?? []).some((c) => c === "UNKNOWN_NODE" || c === "TRAP");
  const global = problems.get("") ?? [];
  const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const onKey = (e: React.KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(id);
    }
  };
  return (
    <figure className="sg-fig" data-testid="sg">
      <div className="sg-legend xs muted" aria-hidden="true">
        <span>
          <i className="lg start" /> {t("sg.start")}
        </span>
        <span>
          <i className="lg ok" /> {t("sg.success")}
        </span>
        <span>
          <i className="lg alt" /> {t("sg.alt")}
        </span>
        <span>
          <i className="lg fail" /> {t("sg.fail")}
        </span>
        <span>
          <i className="lg bad" /> {preliminary ? t("sg.badLocal") : t("sg.bad")}
        </span>
        <span>⟲ {t("sg.recovery")}</span>
      </div>
      {global.length > 0 && (
        <p className="err small" data-testid="sg-global">
          <Icon name="alertCircle" /> {global.map((c) => t(`ci.${c}` as MessageKey)).join("; ")}
        </p>
      )}
      <div className="sg-wrap" ref={wrap}>
        <svg className="sg" width={lay.width} height={lay.height} viewBox={`0 0 ${lay.width} ${lay.height}`} role="group" aria-label={t("sg.label", { n: lay.nodes.length })}>
          <defs>
            <marker id={`sga-${uid}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="sg-arrow" />
            </marker>
            <marker id={`sgb-${uid}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="sg-arrow bad" />
            </marker>
          </defs>
          {lay.edges.map((e) => (
            <g key={`${e.from}-${e.index}`} className={cx("sg-e", e.kind === "back" && "is-back", e.kind === "side" && "is-side", (selected === e.from || selected === e.to) && "is-hot")} data-testid={`sg-edge-${e.from}-${e.to}`}>
              <path d={e.d} className="sg-edge" markerEnd={`url(#${badEdge(e.from) ? "sgb" : "sga"}-${uid})`} />
              <text x={e.lx} y={e.ly} className="sg-intent" textAnchor="middle">
                {short(e.intent, 14)}
              </text>
            </g>
          ))}
          {lay.dangling.map((d) => (
            <g key={`${d.from}-x-${d.index}`} className="sg-dangling" data-testid={`sg-dangling-${d.from}`}>
              <line x1={d.x - 22} y1={d.y} x2={d.x} y2={d.y} className="sg-edge bad" />
              <text x={d.x + 4} y={d.y + 4} className="sg-x">
                ✕ {short(d.to, 10)}
              </text>
            </g>
          ))}
          {lay.nodes.map((n) => {
            const node = payload.nodes[n.id]!;
            const bad = problems.get(n.id) ?? [];
            const label = [
              t("se.node", { id: n.id }),
              n.start ? t("sg.start") : "",
              n.end ? t(SG_END[n.end]) : "",
              n.recovery ? t("sg.recovery") : "",
              n.depth == null ? t("ci.UNREACHABLE_NODE") : "",
              bad.length ? `${t("sg.problems")}: ${bad.map((c) => t(`ci.${c}` as MessageKey)).join(", ")}` : "",
            ]
              .filter(Boolean)
              .join(". ");
            return (
              <g
                key={n.id}
                transform={`translate(${n.x} ${n.y})`}
                className={cx("sg-node", n.start && "is-start", n.end && `end-${n.end}`, bad.length > 0 && "is-bad", selected === n.id && "is-sel", n.depth == null && "is-orphan")}
                role="button"
                tabIndex={0}
                aria-label={label}
                aria-pressed={selected === n.id}
                onClick={() => onSelect(n.id)}
                onKeyDown={(e) => onKey(e, n.id)}
                data-testid={`sg-node-${n.id}`}
                data-bad={bad.length ? bad.join(" ") : undefined}
              >
                <rect width={NODE_W} height={NODE_H} rx={10} className="sg-box" />
                <text x={10} y={17} className="sg-id">
                  {n.start ? "▶ " : ""}
                  {short(n.id, 14)}
                  {n.recovery ? " ⟲" : ""}
                </text>
                <text x={NODE_W - 10} y={17} className="sg-sp" textAnchor="end">
                  {short(node.speaker, 9)}
                </text>
                <text x={10} y={36} className="sg-line">
                  {short(node.line_en || "…", 21)}
                </text>
                <text x={10} y={50} className="sg-meta">
                  {n.end ? (n.end === "success" ? "✓ " : n.end === "alt_success" ? "≈ " : "✕ ") : `→ ${node.transitions.length} `}
                  {node.event ? `⚡${short(node.event, 12)}` : ""}
                </text>
                {bad.length > 0 && (
                  <g transform={`translate(${NODE_W - 9} ${NODE_H - 9})`} aria-hidden="true">
                    <circle r={8} className="sg-badge" />
                    <text y={4} textAnchor="middle" className="sg-badge-t">
                      !
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="xs muted">{t("sg.caption")}</figcaption>
    </figure>
  );
}

/* ---------------------------------------------------------------- nodes */

function NodeList({ p, problems, sel, onSelect, onAdd }: { p: P; problems: Map<string, string[]>; sel: string | null; onSelect: (id: string) => void; onAdd: () => void }) {
  const { t } = useI18n();
  const { editable } = useEd();
  return (
    <nav className="node-list" aria-label={t("se.nodes")}>
      <ul>
        {Object.entries(p.nodes).map(([id, n]) => (
          <li key={id}>
            <button type="button" className={cx("node-li", (problems.get(id)?.length ?? 0) > 0 && "is-bad")} aria-current={sel === id ? "true" : undefined} onClick={() => onSelect(id)} data-testid={`se-node-${id}`}>
              <span className="mono">{id}</span>
              {id === p.start_node && <span className="tag">{t("sg.start")}</span>}
              {n.end && <span className="tag">{t(`out.${n.end.outcome}` as MessageKey)}</span>}
              {(problems.get(id)?.length ?? 0) > 0 && <Icon name="alertCircle" className="bad-ink" title={t("sg.problems")} />}
            </button>
          </li>
        ))}
      </ul>
      {editable && <Btn size="sm" icon="plus" label={t("se.addNode")} onClick={onAdd} disabled={Object.keys(p.nodes).length >= 30} testId="se-add-node" />}
    </nav>
  );
}

function NodeEditor({ id, p, node, problems, setNode, onRemove, onRename }: { id: string; p: P; node: ScenarioNode; problems: string[]; setNode: (fn: (n: ScenarioNode) => ScenarioNode) => void; onRemove: () => void; onRename: (to: string) => void }) {
  const { t } = useI18n();
  const { editable } = useEd();
  const [newId, setNewId] = useState(id);
  const dl = useId();
  const path = `payload.nodes.${id}`;
  const ids = Object.keys(p.nodes);
  const renameOk = ID_RE.test(newId) && (newId === id || !(newId in p.nodes));
  const setTr = (i: number, tr: ScenarioTransition) => setNode((n) => ({ ...n, transitions: setAt(n.transitions, i, tr) }));
  return (
    <div className="node-ed" data-path={path} data-testid={`se-node-ed-${id}`}>
      <div className="row between">
        <h4 className="h3">
          {t("se.node", { id })} {id === p.start_node && <span className="tag">{t("sg.start")}</span>}
        </h4>
        {editable && <Btn size="xs" kind="danger-ghost" icon="x" label={t("se.removeNode")} onClick={onRemove} testId="se-remove-node" />}
      </div>
      {problems.length > 0 && (
        <p className="err small" data-testid="se-node-problems">
          <Icon name="alertCircle" /> {problems.map((c) => t(`ci.${c}` as MessageKey)).join("; ")}
        </p>
      )}
      <PathIssues path={path} />
      {editable && (
        <div className="row nowrap-row rename-row">
          <label className="sr-only" htmlFor={`rn-${dl}`}>
            {t("se.nodeId")}
          </label>
          <input id={`rn-${dl}`} className={cx("input mono", !renameOk && "is-invalid")} value={newId} maxLength={64} onChange={(e) => setNewId(e.target.value.toLowerCase())} />
          <Btn size="sm" label={t("se.rename")} disabled={!renameOk || newId === id} onClick={() => onRename(newId)} />
        </div>
      )}
      <div className="form-grid">
        <SelectField path={`${path}.speaker`} label={t("se.speaker")} value={node.speaker} options={withCurrent(p.characters.map((c) => ({ v: c.id, label: `${c.name || c.id} · ${c.id}` })), node.speaker)} onChange={(v) => setNode((n) => ({ ...n, speaker: v }))} />
        <TextField path={`${path}.event`} label={t("se.event")} value={node.event ?? ""} mono max={40} placeholder="price_changed" onChange={(v) => setNode((n) => ({ ...n, event: v.trim() ? v : null }))} hint={t("se.eventHint")} />
        <TextField className="span-2" path={`${path}.line_en`} label={t("se.line")} value={node.line_en} max={240} required multiline onChange={(v) => setNode((n) => ({ ...n, line_en: v }))} testId="se-line" />
        <LocField path={`${path}.gloss`} label={t("se.gloss")} value={node.gloss} max={300} multiline onChange={(v) => setNode((n) => ({ ...n, gloss: v }))} testId="se-gloss" />
        <div className="field">
          <label className="check">
            <input type="checkbox" checked={node.hint != null} disabled={!editable} onChange={(e) => setNode((n) => ({ ...n, hint: e.target.checked ? L() : null }))} />
            <span>{t("se.hasHint")}</span>
          </label>
          {node.hint && <LocField path={`${path}.hint`} label={t("se.hint")} value={node.hint} max={200} onChange={(v) => setNode((n) => ({ ...n, hint: v }))} />}
        </div>
        <div className="field" data-path={`${path}.recovery_point`}>
          <label className="check">
            <input type="checkbox" checked={node.recovery_point} disabled={!editable} onChange={(e) => setNode((n) => ({ ...n, recovery_point: e.target.checked }))} data-testid="se-recovery" />
            <span>{t("se.recovery")}</span>
          </label>
          <span className="hint">{t("se.recoveryHint")}</span>
        </div>
        <SelectField
          path={`${path}.end`}
          label={t("se.end")}
          value={node.end?.outcome ?? ""}
          options={[{ v: "", label: t("se.notEnd") }, ...(["success", "alt_success", "fail"] as const).map((o) => ({ v: o, label: t(`out.${o}` as MessageKey) }))]}
          onChange={(v) => setNode((n) => ({ ...n, end: v ? { outcome: v as "success", summary: n.end?.summary ?? L() } : null, transitions: v ? [] : n.transitions }))}
          testId="se-end"
        />
        {node.end && <LocField path={`${path}.end.summary`} label={t("se.summary")} value={node.end.summary} max={300} multiline onChange={(v) => setNode((n) => ({ ...n, end: n.end ? { ...n.end, summary: v } : n.end }))} />}
      </div>
      {!node.end && (
        <div className="stack sm" data-path={`${path}.transitions`}>
          <span className="field-label">{t("se.transitions")}</span>
          <PathIssues path={`${path}.transitions`} />
          <datalist id={`intents-${dl}`}>
            {INTENTS.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
          {node.transitions.map((tr, i) => {
            const tp = `${path}.transitions[${i}]`;
            return (
              <div key={i} className="item" data-path={tp} data-testid={`se-tr-${i}`}>
                <ItemHead n={i + 1} title={`${tr.intent || "?"} → ${tr.to || "?"}`} onRemove={() => setNode((n) => ({ ...n, transitions: removeAt(n.transitions, i) }))} removeLabel={t("se.removeTr", { n: i + 1 })} />
                <div className="form-grid">
                  <div className="field" data-path={`${tp}.intent`}>
                    <label htmlFor={`int-${dl}-${i}`}>{t("se.intent")}</label>
                    <input id={`int-${dl}-${i}`} className="input mono" list={`intents-${dl}`} value={tr.intent} disabled={!editable} maxLength={40} data-path={`${tp}.intent`} onChange={(e) => setTr(i, { ...tr, intent: e.target.value.toLowerCase() })} data-testid={`se-tr-intent-${i}`} />
                    <PathIssues path={`${tp}.intent`} />
                  </div>
                  <SelectField path={`${tp}.to`} label={t("se.to")} value={tr.to} options={withCurrent(ids.map((x) => ({ v: x, label: x })), tr.to, t("ct.choose"))} onChange={(v) => setTr(i, { ...tr, to: v })} testId={`se-tr-to-${i}`} />
                  <LocField path={`${tp}.description`} label={t("se.trDesc")} value={tr.description} max={200} onChange={(v) => setTr(i, { ...tr, description: v })} />
                  <TextField
                    path={`${tp}.examples_en`}
                    label={t("se.examples")}
                    value={tr.examples_en.join("\n")}
                    max={600}
                    multiline
                    rows={2}
                    hint={t("se.examplesHint")}
                    onChange={(v) => setTr(i, { ...tr, examples_en: v.split("\n").map((x) => x.trimStart()).filter((x, j, a) => x || j === a.length - 1).slice(0, 4) })}
                    testId={`se-tr-ex-${i}`}
                  />
                </div>
              </div>
            );
          })}
          {editable && (
            <Btn size="sm" icon="plus" label={t("se.addTr")} onClick={() => setNode((n) => ({ ...n, transitions: [...n.transitions, { intent: "other", description: L(), examples_en: [""], to: "" }] }))} testId="se-add-tr" />
          )}
        </div>
      )}
    </div>
  );
}

export function scenarioGate(ver: { test_run: ScenarioTestRun | null }, dirty: boolean): { submit: MessageKey | null; publish: MessageKey | null } {
  const ok = !!ver.test_run?.ok && !dirty;
  return { submit: ok ? null : "se.gate", publish: ok ? null : "se.gate" };
}
