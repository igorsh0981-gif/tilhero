"""Тестовый прогон сценария (AT-28, ADM-CONT-04): граф узлов без исполнения LLM.

Проверки (коды ScenarioTestRun.issues, content.ts):
- START_MISSING — start_node не среди узлов;
- UNKNOWN_NODE — переход ведёт в несуществующий узел;
- UNKNOWN_SPEAKER — реплику произносит не персонаж сценария;
- UNREACHABLE_NODE — узел недостижим из start (обход в ширину);
- DEAD_END — у неконечного узла нет переходов;
- TRAP — из достижимого неконечного узла не достичь ни одного конца (зацикливание без выхода);
- NO_SUCCESS_END — не достичь ни одного конца с исходом success;
- NO_RECOVERY_POINT — при > 6 узлах нет точки восстановления, кроме start;
- RECOVERY_CANNOT_FINISH — из точки восстановления не достичь success (продолжение после паузы, APP-LESS-08);
- TOO_MANY_NODES — больше 30 узлов.
Конечный узел (end ≠ null) — терминальный: его переходы не обходятся (их запрещает проверка при отправке).
"""

from __future__ import annotations

from collections import deque
from typing import Any, Final

MAX_NODES: Final = 30
RECOVERY_REQUIRED_ABOVE: Final = 6
PATHS_CAP: Final = 9999
_PATH_STEPS_CAP: Final = 200_000


def _edges(nodes: dict[str, Any]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for node_id, node in nodes.items():
        if node.get("end") is not None:
            out[node_id] = []
            continue
        out[node_id] = [str(t.get("to")) for t in node.get("transitions") or [] if str(t.get("to")) in nodes]
    return out


def _reach(edges: dict[str, list[str]], start: str) -> dict[str, int]:
    """Глубина BFS от start для достижимых узлов."""
    depth = {start: 0}
    queue = deque([start])
    while queue:
        cur = queue.popleft()
        for nxt in edges.get(cur, []):
            if nxt not in depth:
                depth[nxt] = depth[cur] + 1
                queue.append(nxt)
    return depth


def _can_reach(edges: dict[str, list[str]], targets: set[str]) -> set[str]:
    """Узлы, из которых достижим хотя бы один узел из targets (обратный обход)."""
    reverse: dict[str, list[str]] = {n: [] for n in edges}
    for src, dsts in edges.items():
        for dst in dsts:
            reverse.setdefault(dst, []).append(src)
    seen = set(targets)
    queue = deque(targets)
    while queue:
        cur = queue.popleft()
        for prev in reverse.get(cur, []):
            if prev not in seen:
                seen.add(prev)
                queue.append(prev)
    return seen


def _count_paths(edges: dict[str, list[str]], start: str, success: set[str]) -> int:
    """Число простых путей start → success (с потолком: граф ≤ 30 узлов, но ветвлений может быть много)."""
    count = 0
    steps = 0
    stack: list[tuple[str, int]] = [(start, 0)]
    on_path: list[str] = []
    in_path: set[str] = set()
    while stack:
        node, idx = stack.pop()
        steps += 1
        if steps > _PATH_STEPS_CAP or count >= PATHS_CAP:
            break
        if idx == 0:
            if node in success:
                count += 1
                continue
            on_path.append(node)
            in_path.add(node)
        nexts = edges.get(node, [])
        if idx < len(nexts):
            stack.append((node, idx + 1))
            nxt = nexts[idx]
            if nxt not in in_path:
                stack.append((nxt, 0))
        else:
            on_path.pop()
            in_path.discard(node)
    return min(count, PATHS_CAP)


def run_test(payload: dict[str, Any], checked_at: str) -> dict[str, Any]:
    """ScenarioTestRun (content.ts) по телу сценария. Тело уже прошло схему вида (ScenarioPayload)."""
    nodes: dict[str, Any] = payload.get("nodes") or {}
    start = str(payload.get("start_node") or "")
    speakers = {str(c.get("id")) for c in payload.get("characters") or []}
    issues: list[dict[str, Any]] = []

    def issue(code: str, node_id: str | None, detail: str) -> None:
        issues.append({"code": code, "node_id": node_id, "detail": detail})

    if len(nodes) > MAX_NODES:
        issue("TOO_MANY_NODES", None, f"Узлов {len(nodes)}, допустимо не больше {MAX_NODES}")
    for node_id in sorted(nodes):
        node = nodes[node_id]
        if str(node.get("speaker")) not in speakers:
            issue("UNKNOWN_SPEAKER", node_id, f"Реплику произносит «{node.get('speaker')}» — такого персонажа нет")
        if node.get("end") is None:
            for i, t in enumerate(node.get("transitions") or []):
                if str(t.get("to")) not in nodes:
                    issue("UNKNOWN_NODE", node_id, f"Переход {i} ведёт в несуществующий узел «{t.get('to')}»")
            if not node.get("transitions"):
                issue("DEAD_END", node_id, "У узла нет переходов, но он не конечный")

    edges = _edges(nodes)
    ends = {n: str(node["end"]["outcome"]) for n, node in nodes.items() if node.get("end") is not None}
    success = {n for n, outcome in ends.items() if outcome == "success"}
    ends_stats = {"success": 0, "alt_success": 0, "fail": 0}
    for outcome in ends.values():
        ends_stats[outcome] = ends_stats.get(outcome, 0) + 1

    if start not in nodes:
        issue("START_MISSING", None, f"Стартовый узел «{start}» не найден")
        return _result(issues, nodes, ends_stats, 0, 0, checked_at)

    depth = _reach(edges, start)
    for node_id in sorted(nodes):
        if node_id not in depth:
            issue("UNREACHABLE_NODE", node_id, "Узел недостижим из стартового")
    reach_any_end = _can_reach(edges, set(ends))
    for node_id in sorted(depth):
        node = nodes[node_id]
        if node.get("end") is None and node.get("transitions") and node_id not in reach_any_end:
            issue("TRAP", node_id, "Из узла нельзя дойти ни до одного конца разговора")
    reach_success = _can_reach(edges, success)
    if not success or start not in reach_success:
        issue("NO_SUCCESS_END", None, "Из стартового узла не достичь успешного завершения")

    recovery = [n for n in sorted(nodes) if nodes[n].get("recovery_point") and n != start]
    if len(nodes) > RECOVERY_REQUIRED_ABOVE and not recovery:
        issue("NO_RECOVERY_POINT", None,
              f"При {len(nodes)} узлах нужна точка восстановления после паузы (кроме стартового)")
    for node_id in ([start] if nodes[start].get("recovery_point") else []) + recovery:
        if node_id in depth and node_id not in reach_success:
            issue("RECOVERY_CANNOT_FINISH", node_id, "С точки восстановления не дойти до успешного завершения")

    max_depth = max(depth.values()) if depth else 0
    paths = _count_paths(edges, start, success) if success else 0
    return _result(issues, nodes, ends_stats, max_depth, paths, checked_at)


def _result(issues: list[dict[str, Any]], nodes: dict[str, Any], ends: dict[str, int], max_depth: int,
            paths: int, checked_at: str) -> dict[str, Any]:
    return {
        "ok": not issues,
        "checked_at": checked_at,
        "issues": issues,
        "stats": {"nodes": len(nodes), "ends": ends, "max_depth": max_depth, "paths_to_success": paths},
    }
