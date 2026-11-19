"""Золотые тесты (INTERNAL_API §1.1, §9; ai.ts GoldenCase/GoldenCheck/TestRun).

Прогон версии — асинхронно (фоновая задача процесса), каждый активный кейс агента проходит тот же конвейер, что и
вызов урока (тот же провайдер, бюджет месяца, схема, правила безопасности), но на **заданной** версии.

Пути проверок — dot-path от корня AgentInvokeResult: `status`, `reason`, `cost_usd`, `output`, `output.intent`,
`output.confirmed_errors.0.evidence` (элемент массива — индекс; `*` — все элементы, расширение для админки).
schema_valid — `output` не null и проходит JSON-схему версии; field_equals / field_in / max_length — путь не найден →
провал (с `*` — проверка на пустом множестве); field_absent — нет поля или null; text_not_contains — без учёта
регистра, путь не найден → пройдена; max_length — строка или массив (null — 0).

Провайдер fake (стенд, тесты) не отвечает по смыслу: выполняются только schema_valid и проверки путей вне `output.*`
(статус, причина, отказ детям), проверки содержимого `output.*` → `skipped` (не провал). Кейс с audience kids у агента
свободного текста засчитывается только при отказе `refused: kids_not_allowed`; schema_valid и `output.*` у него не
применяются (вывода нет). `passed_mandatory` — есть обязательный кейс и все обязательные прошли выполненные проверки.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_ai_gateway.contracts import validate_golden
from tilhero_ai_gateway.domain import jsonschema_lite
from tilhero_ai_gateway.domain.common import iso_z, sha256_hex, usd
from tilhero_ai_gateway.domain.invoke import Deps, InvokeRequest, invoke
from tilhero_ai_gateway.models import AgentRow, AgentVersion, GoldenCaseRow, TestRunRow

log = logging.getLogger("tilhero.ai_gateway.golden")
SHOW = 80


def _short(value: Any) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= SHOW else text[:SHOW] + "…"


def resolve(doc: Any, path: str) -> tuple[list[Any], bool]:
    """Значения по dot-path и признак `*` в пути (пустой результат с `*` — проверка выполняется на пустом множестве)."""
    parts = path.split(".")
    current = [doc]
    for part in parts:
        nxt: list[Any] = []
        for node in current:
            if part == "*":
                if isinstance(node, list):
                    nxt.extend(node)
                elif isinstance(node, dict):
                    nxt.extend(node.values())
            elif isinstance(node, dict):
                if part in node:
                    nxt.append(node[part])
            elif isinstance(node, list) and part.isdigit() and int(part) < len(node):
                nxt.append(node[int(part)])
        current = nxt
    return current, "*" in parts


def _measure(value: Any) -> int | None:
    if value is None:
        return 0
    if isinstance(value, str | list | dict):
        return len(value)
    return None


def is_output_content(check: dict[str, Any]) -> bool:
    """Проверка содержимого вывода модели: schema_valid и пути `output.*` (сам `output` — нет: отказ = null)."""
    return check["kind"] == "schema_valid" or str(check.get("path", "")).startswith("output.")


def check_label(check: dict[str, Any]) -> str:
    return check["kind"] if check["kind"] == "schema_valid" else f"{check['kind']} {check['path']}"


def evaluate_check(check: dict[str, Any], result: dict[str, Any], schema: dict[str, Any]) -> str | None:
    """Провал проверки по результату вызова — текст причины; None — проверка пройдена."""
    kind = check["kind"]
    if kind == "schema_valid":
        output = result.get("output")
        if output is None:
            return "schema_valid: нет вывода"
        errors = jsonschema_lite.validate(output, schema)
        return f"schema_valid: {errors[0]}" if errors else None
    path = str(check["path"])
    values, wildcard = resolve(result, path)
    if kind == "field_absent":
        present = [v for v in values if v is not None]
        return f"field_absent {path}: поле есть ({_short(present[0])})" if present else None
    if kind == "text_not_contains":
        for value in values:
            text = (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)).lower()
            for needle in check["values"]:
                if str(needle).lower() in text:
                    return f"text_not_contains {path}: найдено «{_short(needle)}»"
        return None
    if not values:
        return None if wildcard else f"{kind} {path}: поле не найдено"
    if kind == "field_equals":
        for value in values:
            if not jsonschema_lite.json_equal(value, check["value"]):
                return f"field_equals {path}: ожидалось {_short(check['value'])}, получено {_short(value)}"
        return None
    if kind == "field_in":
        for value in values:
            if not any(jsonschema_lite.json_equal(value, v) for v in check["values"]):
                return f"field_in {path}: {_short(value)} не из списка"
        return None
    if kind == "max_length":
        for value in values:
            size = _measure(value)
            if size is None:
                return f"max_length {path}: значение без длины"
            if size > int(check["n"]):
                return f"max_length {path}: длина {size} > {check['n']}"
        return None
    return f"{kind}: неизвестная проверка"


# ---------------------------------------------------------------- прогон


async def active_cases(session: AsyncSession, agent_id: str) -> list[GoldenCaseRow]:
    return list((await session.execute(
        select(GoldenCaseRow).where(GoldenCaseRow.agent_id == agent_id, GoldenCaseRow.archived_at.is_(None))
        .order_by(GoldenCaseRow.case_id))).scalars().all())


def cases_hash(cases: list[GoldenCaseRow]) -> str:
    """Отпечаток набора обязательных кейсов: добавили, изменили или убрали обязательный — прогон устарел."""
    return sha256_hex(sorted([[c.case_id, c.input, c.checks] for c in cases if c.mandatory], key=lambda x: x[0]))


def run_summary(run: TestRunRow) -> dict[str, Any]:
    """TestRunSummary (ai.ts)."""
    return {
        "run_id": str(run.run_id), "agent_id": run.agent_id, "version": run.version, "status": run.status,
        "provider": run.provider, "passed": run.passed, "failed": run.failed,
        "passed_mandatory": run.passed_mandatory, "cost_usd": usd(run.cost_usd),
        "started_at": iso_z(run.started_at), "finished_at": iso_z(run.finished_at),
    }


def run_view(run: TestRunRow) -> dict[str, Any]:
    return {**run_summary(run), "results": list(run.results)}


async def run_case(deps: Deps, agent: AgentRow, version: int, schema: dict[str, Any], case: GoldenCaseRow,
                   run_id: uuid.UUID) -> dict[str, Any]:
    started = time.perf_counter()
    base = {"case_id": case.case_id, "title": case.title, "mandatory": case.mandatory}
    norm_input, checks, errors = validate_golden(agent.agent_id, case.input, case.checks)
    if norm_input is None or checks is None:
        return {**base, "passed": False, "failures": [f"input_invalid: {e['path']}" for e in errors][:10],
                "skipped": [], "latency_ms": 0, "cost_usd": 0.0}
    context = norm_input["context"]
    locale = context.get("explain_locale") if isinstance(context.get("explain_locale"), str) else "ru"
    res = await invoke(deps, InvokeRequest(
        agent_id=agent.agent_id, request_id=uuid.uuid4(), session_id=run_id, session_kind="golden", user_id=None,
        audience=norm_input["audience"], locale=locale, context=context,
    ), caller="golden", version_override=version, learner_limits=False, emergency_stop_applies=False)
    failures: list[str] = []
    skipped: list[str] = []
    expect_refusal = agent.free_text and norm_input["audience"] == "kids"
    if expect_refusal and (res["status"], res["reason"]) != ("refused", "kids_not_allowed"):
        failures.append(f"ожидался отказ детям (refused: kids_not_allowed), получено {res['status']}")
    for check in checks:
        if expect_refusal and is_output_content(check):
            continue  # вывода у отказа нет — проверки содержимого не применяются
        if deps.provider.name == "fake" and is_output_content(check) and check["kind"] != "schema_valid":
            skipped.append(check_label(check))
            continue
        failure = evaluate_check(check, res, schema)
        if failure:
            failures.append(failure)
    return {**base, "passed": not failures, "failures": failures[:20], "skipped": skipped[:50],
            "latency_ms": max(0, int((time.perf_counter() - started) * 1000)), "cost_usd": res["cost_usd"]}


async def execute_run(deps: Deps, run_id: uuid.UUID) -> None:
    """Фоновый прогон: кейсы по очереди (стоимость под контролем бюджета), итог — в test_runs."""
    try:
        async with deps.rt.transaction() as s:
            run = await s.get(TestRunRow, run_id)
            if run is None or run.status != "running":
                return
            agent = await s.get(AgentRow, run.agent_id)
            version = (await s.execute(select(AgentVersion).where(
                AgentVersion.agent_id == run.agent_id, AgentVersion.version == run.version))).scalar_one()
            cases = await active_cases(s, run.agent_id)
            schema = dict(version.output_schema)
        assert agent is not None
        results = []
        for case in cases:
            results.append(await run_case(deps, agent, run.version, schema, case, run_id))
        passed = sum(1 for r in results if r["passed"])
        mandatory = [r for r in results if r["mandatory"]]
        total = sum((Decimal(str(r["cost_usd"])) for r in results), Decimal(0))
        async with deps.rt.transaction() as s:
            await s.execute(update(TestRunRow).where(TestRunRow.run_id == run_id, TestRunRow.status == "running")
                            .values(status="finished", results=results, passed=passed, failed=len(results) - passed,
                                    passed_mandatory=bool(mandatory) and all(r["passed"] for r in mandatory),
                                    cost_usd=total, finished_at=deps.clock())
                            .execution_options(synchronize_session=False))
        log.info("golden run finished", extra={"agent_id": agent.agent_id, "agent_version": run.version,
                                               "passed": passed, "failed": len(results) - passed})
    except Exception as exc:
        log.warning("golden run failed", extra={"error_type": type(exc).__name__})
        async with deps.rt.transaction() as s:
            await s.execute(update(TestRunRow).where(TestRunRow.run_id == run_id, TestRunRow.status == "running")
                            .values(status="failed", finished_at=deps.clock())
                            .execution_options(synchronize_session=False))
