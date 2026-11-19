/**
 * Scenario graph (AT-28): the same graph checks as the catalog test run (services/catalog domain/scenario_test.py —
 * BFS from start, unreachable nodes, dead ends, traps, success reachability, recovery points) for the live «preliminary»
 * hints of the editor, and a deterministic layered layout for the SVG picture: column = BFS depth from the start node,
 * unreachable nodes in an extra column on the right, forward edges as curves to the right, back / same-column edges as
 * arcs below. Only the catalog's own test run (ScenarioTestRun) unlocks submission and publication.
 */
import type { ScenarioPayload, ScenarioTestRun } from "@tilhero/contracts/content";

export type GraphCode = ScenarioTestRun["issues"][number]["code"];
export interface GraphIssue {
  code: GraphCode;
  node_id: string | null;
}
export const MAX_NODES = 30;
export const RECOVERY_REQUIRED_ABOVE = 6;
const PATHS_CAP = 9999;

type Nodes = ScenarioPayload["nodes"];

function edgesOf(nodes: Nodes): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, n] of Object.entries(nodes)) out[id] = n.end ? [] : n.transitions.map((t) => t.to).filter((to) => to in nodes);
  return out;
}

function reach(edges: Record<string, string[]>, start: string): Map<string, number> {
  const depth = new Map<string, number>([[start, 0]]);
  const q = [start];
  while (q.length) {
    const cur = q.shift()!;
    for (const nxt of edges[cur] ?? []) {
      if (!depth.has(nxt)) {
        depth.set(nxt, depth.get(cur)! + 1);
        q.push(nxt);
      }
    }
  }
  return depth;
}

function canReach(edges: Record<string, string[]>, targets: Set<string>): Set<string> {
  const rev: Record<string, string[]> = {};
  for (const [src, ds] of Object.entries(edges)) for (const d of ds) (rev[d] ??= []).push(src);
  const seen = new Set(targets);
  const q = [...targets];
  while (q.length) {
    const cur = q.shift()!;
    for (const prev of rev[cur] ?? []) {
      if (!seen.has(prev)) {
        seen.add(prev);
        q.push(prev);
      }
    }
  }
  return seen;
}

function countPaths(edges: Record<string, string[]>, start: string, success: Set<string>): number {
  let count = 0;
  let steps = 0;
  const onPath = new Set<string>();
  const dfs = (n: string) => {
    if (++steps > 200_000 || count >= PATHS_CAP) return;
    if (success.has(n)) {
      count++;
      return;
    }
    onPath.add(n);
    for (const nxt of edges[n] ?? []) if (!onPath.has(nxt)) dfs(nxt);
    onPath.delete(n);
  };
  dfs(start);
  return Math.min(count, PATHS_CAP);
}

/** Test run without the server (same order of issues as the catalog). */
export function analyzeScenario(p: Pick<ScenarioPayload, "nodes" | "start_node" | "characters">): Omit<ScenarioTestRun, "checked_at" | "issues"> & { issues: GraphIssue[]; depth: Record<string, number> } {
  const nodes = p.nodes ?? {};
  const ids = Object.keys(nodes).sort();
  const speakers = new Set((p.characters ?? []).map((c) => c.id));
  const issues: GraphIssue[] = [];
  const add = (code: GraphCode, node_id: string | null) => issues.push({ code, node_id });
  if (ids.length > MAX_NODES) add("TOO_MANY_NODES", null);
  for (const id of ids) {
    const n = nodes[id]!;
    if (!speakers.has(n.speaker)) add("UNKNOWN_SPEAKER", id);
    if (!n.end) {
      n.transitions.forEach((t) => !(t.to in nodes) && add("UNKNOWN_NODE", id));
      if (!n.transitions.length) add("DEAD_END", id);
    }
  }
  const edges = edgesOf(nodes);
  const ends = new Map(ids.filter((id) => nodes[id]!.end).map((id) => [id, nodes[id]!.end!.outcome]));
  const success = new Set([...ends].filter(([, o]) => o === "success").map(([id]) => id));
  const endStats = { success: 0, alt_success: 0, fail: 0 };
  for (const o of ends.values()) endStats[o] += 1;
  const start = p.start_node;
  if (!(start in nodes)) {
    add("START_MISSING", null);
    return { ok: false, issues, stats: { nodes: ids.length, ends: endStats, max_depth: 0, paths_to_success: 0 }, depth: {} };
  }
  const depth = reach(edges, start);
  for (const id of ids) if (!depth.has(id)) add("UNREACHABLE_NODE", id);
  const anyEnd = canReach(edges, new Set(ends.keys()));
  for (const id of [...depth.keys()].sort()) {
    const n = nodes[id]!;
    if (!n.end && n.transitions.length && !anyEnd.has(id)) add("TRAP", id);
  }
  const toSuccess = canReach(edges, success);
  if (!success.size || !toSuccess.has(start)) add("NO_SUCCESS_END", null);
  const recovery = ids.filter((id) => nodes[id]!.recovery_point && id !== start);
  if (ids.length > RECOVERY_REQUIRED_ABOVE && !recovery.length) add("NO_RECOVERY_POINT", null);
  for (const id of [...(nodes[start]!.recovery_point ? [start] : []), ...recovery]) if (depth.has(id) && !toSuccess.has(id)) add("RECOVERY_CANNOT_FINISH", id);
  const maxDepth = depth.size ? Math.max(...depth.values()) : 0;
  return {
    ok: !issues.length,
    issues,
    stats: { nodes: ids.length, ends: endStats, max_depth: maxDepth, paths_to_success: success.size ? countPaths(edges, start, success) : 0 },
    depth: Object.fromEntries(depth),
  };
}

/** node_id → codes of a test run; codes without a node (NO_SUCCESS_END, …) under "". */
export function problemsByNode(issues: ReadonlyArray<{ code: string; node_id: string | null }>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const i of issues) {
    const k = i.node_id ?? "";
    const xs = m.get(k) ?? [];
    if (!xs.includes(i.code)) xs.push(i.code);
    m.set(k, xs);
  }
  return m;
}

/* ---------------------------------------------------------------- layout */

export const NODE_W = 150;
export const NODE_H = 58;
const COL_GAP = 70;
const ROW_GAP = 26;
const PAD = 18;
const ARC = 26;

export interface LaidNode {
  id: string;
  x: number;
  y: number;
  /** BFS depth from the start; null — unreachable */
  depth: number | null;
  start: boolean;
  end: "success" | "alt_success" | "fail" | null;
  recovery: boolean;
}
export interface LaidEdge {
  from: string;
  to: string;
  index: number;
  intent: string;
  /** SVG path d */
  d: string;
  /** label anchor */
  lx: number;
  ly: number;
  /** forward — to a later column; side — inside one column (arc on the right); back — to an earlier column (arc below) */
  kind: "forward" | "side" | "back" | "self";
}
export interface Layout {
  width: number;
  height: number;
  nodes: LaidNode[];
  edges: LaidEdge[];
  /** transitions to a node that does not exist (UNKNOWN_NODE): drawn as a stub with a cross */
  dangling: Array<{ from: string; index: number; to: string; x: number; y: number }>;
}

/**
 * Columns by BFS depth (unreachable nodes — one more column), rows in BFS discovery order inside a column (children in
 * transition order; unreachable ones by id). Deterministic: the same payload gives the same picture.
 */
export function layoutScenario(p: Pick<ScenarioPayload, "nodes" | "start_node">): Layout {
  const nodes = p.nodes ?? {};
  const ids = Object.keys(nodes);
  const edges = edgesOf(nodes);
  const order: string[] = [];
  const depth = new Map<string, number>();
  if (p.start_node in nodes) {
    depth.set(p.start_node, 0);
    const q = [p.start_node];
    while (q.length) {
      const cur = q.shift()!;
      order.push(cur);
      for (const nxt of edges[cur] ?? []) {
        if (!depth.has(nxt)) {
          depth.set(nxt, depth.get(cur)! + 1);
          q.push(nxt);
        }
      }
    }
  }
  const unreachable = ids.filter((id) => !depth.has(id)).sort();
  const maxDepth = depth.size ? Math.max(...depth.values()) : -1;
  const cols: string[][] = [];
  for (const id of order) (cols[depth.get(id)!] ??= []).push(id);
  if (unreachable.length) cols[maxDepth + 1] = unreachable;
  const rows = Math.max(1, ...cols.map((c) => c?.length ?? 0));
  const pos = new Map<string, { x: number; y: number }>();
  const colH = (n: number) => n * NODE_H + (n - 1) * ROW_GAP;
  const fullH = colH(rows);
  cols.forEach((col, ci) => {
    if (!col) return;
    const top = PAD + (fullH - colH(col.length)) / 2;
    col.forEach((id, ri) => pos.set(id, { x: PAD + ci * (NODE_W + COL_GAP), y: top + ri * (NODE_H + ROW_GAP) }));
  });
  const laid: LaidNode[] = ids
    .filter((id) => pos.has(id))
    .map((id) => ({ id, ...pos.get(id)!, depth: depth.get(id) ?? null, start: id === p.start_node, end: nodes[id]!.end?.outcome ?? null, recovery: !!nodes[id]!.recovery_point }));
  const out: LaidEdge[] = [];
  const dangling: Layout["dangling"] = [];
  let backN = 0;
  let sideN = 0;
  for (const id of ids) {
    const n = nodes[id]!;
    const a = pos.get(id);
    if (!a || n.end) continue;
    n.transitions.forEach((t, index) => {
      const b = pos.get(t.to);
      if (!b) {
        dangling.push({ from: id, index, to: t.to, x: a.x + NODE_W + 22, y: a.y + NODE_H / 2 + index * 8 });
        return;
      }
      if (t.to === id) {
        const x = a.x + NODE_W - 18;
        const y = a.y;
        out.push({ from: id, to: t.to, index, intent: t.intent, kind: "self", d: `M ${x} ${y} C ${x - 6} ${y - 30}, ${x + 30} ${y - 30}, ${x + 18} ${y + 4}`, lx: x + 8, ly: y - 22 });
        return;
      }
      if (b.x === a.x) {
        // same column: an arc on the right side of the column, clear of the nodes in between
        const x1 = a.x + NODE_W;
        const y1 = a.y + NODE_H / 2 + 6;
        const x2 = b.x + NODE_W;
        const y2 = b.y + NODE_H / 2 - 6;
        const cx = a.x + NODE_W + 34 + (sideN++ % 2) * 10;
        out.push({ from: id, to: t.to, index, intent: t.intent, kind: "side", d: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2 + 2} ${y2}`, lx: cx - 4, ly: (y1 + y2) / 2 + 4 });
        return;
      }
      if (b.x > a.x) {
        const x1 = a.x + NODE_W;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x;
        const y2 = b.y + NODE_H / 2;
        const mx = (x1 + x2) / 2;
        out.push({ from: id, to: t.to, index, intent: t.intent, kind: "forward", d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 2} ${y2}`, lx: mx, ly: (y1 + y2) / 2 - 4 });
      } else {
        // back edge / same column: from the bottom of the source, an arc under both nodes, into the bottom of the target
        const x1 = a.x + NODE_W / 2 + 10;
        const y1 = a.y + NODE_H;
        const x2 = b.x + NODE_W / 2 - 10;
        const y2 = b.y + NODE_H;
        const low = Math.max(y1, y2) + ARC + (backN++ % 3) * 10;
        out.push({ from: id, to: t.to, index, intent: t.intent, kind: "back", d: `M ${x1} ${y1} C ${x1} ${low}, ${x2} ${low}, ${x2} ${y2 + 2}`, lx: (x1 + x2) / 2, ly: low - 6 });
      }
    });
  }
  const width = PAD * 2 + Math.max(1, cols.length) * NODE_W + Math.max(0, cols.length - 1) * COL_GAP + (dangling.length ? 60 : 0);
  const height = PAD * 2 + fullH + (out.some((e) => e.kind === "back") ? ARC + 30 : 0) + (out.some((e) => e.kind === "self") ? 24 : 0);
  // self loops go above the node: shift everything down when one is in the top row
  if (out.some((e) => e.kind === "self")) {
    const dy = 24;
    for (const n of laid) n.y += dy;
    for (const e of out) {
      e.d = e.d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_m, x: string, y: string) => `${x} ${Number(y) + dy}`);
      e.ly += dy;
    }
    for (const d of dangling) d.y += dy;
  }
  return { width, height, nodes: laid, edges: out, dangling };
}
