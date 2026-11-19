"""Admin API «Агенты и скиллы» (admin.ts ADM-AGENT-01…05): вызывающий — только admin-bff с actor; права — здесь, в
домене (step-up публикации, канарейки и отката проверяет admin-bff). ai.read — чтение; ai.manage — черновики,
золотые тесты, прогоны; ai.publish — публикация, канарейка, откат. Имена сотрудников (*_name) дополняет admin-bff по
*_id / *_by — здесь только идентификаторы.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import JSONResponse

from tilhero_ai_gateway.api.common import IdempotencyKey, deps_of, idempotent, now_of, settings_of, staff_auth
from tilhero_ai_gateway.contracts import AgentVersionPatch
from tilhero_ai_gateway.domain import cases, golden, versions
from tilhero_ai_gateway.domain.common import AI_MANAGE, AI_PUBLISH, AI_READ, decode_cursor, encode_cursor
from tilhero_ai_gateway.schemas import CanaryIn, GoldenCaseIn, GoldenCasePatch, NewVersionIn, ReasonIn
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unprocessable
from tilhero_common.internal_auth import Principal

router = APIRouter(prefix="/admin/v1/ai", tags=["staff"])


def _tasks(request: Request) -> set[asyncio.Task[None]]:
    tasks = getattr(request.app.state, "golden_tasks", None)
    if tasks is None:
        tasks = set()
        request.app.state.golden_tasks = tasks
    return tasks


@router.get("/agents")
async def list_agents(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict:
    """{items: AgentRow[]} — реестр 17 агентов."""
    principal.require_permission(AI_READ)
    async with rt.transaction() as session:
        return {"items": await versions.agent_rows(session, now_of(rt))}


@router.get("/agents/{agent_id}", responses={404: {"description": "AGENT_NOT_FOUND"}})
async def get_agent(agent_id: str, principal: Principal = Depends(staff_auth),
                    rt: Runtime = Depends(get_runtime)) -> dict:
    """AgentRow & {versions: AgentVersionRow[]}."""
    principal.require_permission(AI_READ)
    async with rt.transaction() as session:
        return await versions.agent_detail(session, agent_id[:64], now_of(rt))


@router.get("/agents/{agent_id}/versions/{version}", responses={404: {"description": "VERSION_NOT_FOUND"}})
async def get_version(agent_id: str, version: int, principal: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime)) -> dict:
    """AgentVersion (+ updated_at для If-Match, canary)."""
    principal.require_permission(AI_READ)
    async with rt.transaction() as session:
        await versions.get_agent(session, agent_id[:64])
        row = await versions.get_version(session, agent_id, version)
        return await versions.version_detail(session, row)


@router.post("/agents/{agent_id}/versions", status_code=201,
             responses={409: {"description": "DRAFT_EXISTS {version} | AGENT_NOT_LLM"}})
async def create_version(agent_id: str, body: NewVersionIn | None = None, principal: Principal = Depends(staff_auth),
                         rt: Runtime = Depends(get_runtime),
                         idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    """Черновик из текущей опубликованной (или from_version)."""
    actor = principal.require_permission(AI_MANAGE)
    data = body or NewVersionIn()

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            row = await versions.create_draft(session, agent_id[:64], data.from_version, actor, now_of(rt))
            return 201, await versions.version_detail(session, row)

    return await idempotent(rt, scope=f"{actor.id}:ai:new-version:{agent_id[:64]}", key=idempotency_key,
                            request=data.model_dump(), run=run)


@router.patch("/agents/{agent_id}/versions/{version}",
              responses={409: {"description": "VERSION_NOT_DRAFT | VERSION_CONFLICT {updated_at} | VERSION_IN_CANARY"},
                         422: {"description": "VERSION_INVALID {errors}"},
                         428: {"description": "IF_MATCH_REQUIRED"}})
async def update_version(agent_id: str, version: int, body: AgentVersionPatch,
                         principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                         if_match: str | None = Header(default=None, alias="If-Match", max_length=64)) -> dict:
    actor = principal.require_permission(AI_MANAGE)
    async with rt.transaction() as session:
        row = await versions.update_draft(session, agent_id[:64], version, body, if_match, actor, now_of(rt))
        return await versions.version_detail(session, row)


@router.delete("/agents/{agent_id}/versions/{version}", status_code=204,
               responses={409: {"description": "VERSION_NOT_DRAFT | VERSION_IN_CANARY"}})
async def delete_version(agent_id: str, version: int, principal: Principal = Depends(staff_auth),
                         rt: Runtime = Depends(get_runtime)) -> Response:
    actor = principal.require_permission(AI_MANAGE)
    async with rt.transaction() as session:
        await versions.delete_draft(session, agent_id[:64], version, actor)
    return Response(status_code=204)


@router.post("/agents/{agent_id}/versions/{version}/test-runs", status_code=202,
             responses={409: {"description": "TEST_RUN_IN_PROGRESS"}, 422: {"description": "NO_GOLDEN_CASES"},
                        429: {"description": "TEST_RUNS_LIMIT {retry_after} — не больше 20 прогонов в сутки"}})
async def start_test_run(agent_id: str, version: int, request: Request, principal: Principal = Depends(staff_auth),
                         rt: Runtime = Depends(get_runtime),
                         idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    """Прогон золотых тестов версии — асинхронно; опрос GET …/test-runs/{run_id} → TestRun. Не больше
    GOLDEN_RUNS_DAILY_LIMIT (20) прогонов в сутки по Ташкенту на всех → 429 TEST_RUNS_LIMIT. Аварийная остановка
    прогон не блокирует (проверка перед включением ИИ), месячный потолок — учитывается."""
    actor = principal.require_permission(AI_MANAGE)
    deps = deps_of(request)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            test_run = await versions.start_test_run(session, agent_id[:64], version, actor, deps.provider.name,
                                                     now_of(rt), daily_limit=deps.settings.golden_runs_daily_limit,
                                                     tz=deps.settings.timezone)
            summary = golden.run_summary(test_run)
        task = asyncio.create_task(golden.execute_run(deps, test_run.run_id), name=f"golden-{test_run.run_id}")
        tasks = _tasks(request)
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return 202, summary

    return await idempotent(rt, scope=f"{actor.id}:ai:test-run:{agent_id[:64]}:{version}", key=idempotency_key,
                            request={}, run=run)


@router.get("/agents/{agent_id}/versions/{version}/test-runs/{run_id}",
            responses={404: {"description": "TEST_RUN_NOT_FOUND"}})
async def get_test_run(agent_id: str, version: int, run_id: uuid.UUID, principal: Principal = Depends(staff_auth),
                       rt: Runtime = Depends(get_runtime)) -> dict:
    principal.require_permission(AI_READ)
    async with rt.transaction() as session:
        return golden.run_view(await versions.get_run(session, agent_id[:64], version, run_id))


@router.post("/agents/{agent_id}/versions/{version}/publish",
             responses={200: {"description": "AgentRow (повтор — без изменений)"},
                        409: {"description": "VERSION_NOT_DRAFT"},
                        422: {"description": "TESTS_REQUIRED {reason: no_recent_run | version_changed | "
                                              "cases_changed | no_mandatory_cases | real_provider_required} | "
                                              "TESTS_FAILED {case_ids} | MODEL_INACTIVE"}})
async def publish_version(agent_id: str, version: int, body: ReasonIn, principal: Principal = Depends(staff_auth),
                          rt: Runtime = Depends(get_runtime),
                          idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(AI_PUBLISH)
    conf = settings_of(rt)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            await versions.publish(session, agent_id[:64], version, body.reason, actor, now_of(rt),
                                   conf.golden_run_max_age_days, conf.publish_providers)
            return 200, await versions.agent_row(session, agent_id[:64], now_of(rt))

    return await idempotent(rt, scope=f"{actor.id}:ai:publish:{agent_id[:64]}:{version}", key=idempotency_key,
                            request=body.model_dump(), run=run)


@router.put("/agents/{agent_id}/canary",
            responses={409: {"description": "VERSION_NOT_DRAFT | NO_PUBLISHED_VERSION"},
                       422: {"description": "TESTS_REQUIRED | TESTS_FAILED {case_ids} | MODEL_INACTIVE"}})
async def set_canary(agent_id: str, body: CanaryIn, principal: Principal = Depends(staff_auth),
                     rt: Runtime = Depends(get_runtime), idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(AI_PUBLISH)
    conf = settings_of(rt)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            await versions.set_canary(session, agent_id[:64], body.version, body.percent, body.reason, actor,
                                      now_of(rt), conf.golden_run_max_age_days, conf.publish_providers)
            return 200, await versions.agent_row(session, agent_id[:64], now_of(rt))

    return await idempotent(rt, scope=f"{actor.id}:ai:canary:{agent_id[:64]}", key=idempotency_key,
                            request=body.model_dump(), run=run)


@router.delete("/agents/{agent_id}/canary", responses={409: {"description": "NO_CANARY"}})
async def clear_canary(agent_id: str, body: ReasonIn, principal: Principal = Depends(staff_auth),
                       rt: Runtime = Depends(get_runtime),
                       idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(AI_PUBLISH)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            await versions.clear_canary(session, agent_id[:64], body.reason, actor, now_of(rt))
            return 200, await versions.agent_row(session, agent_id[:64], now_of(rt))

    return await idempotent(rt, scope=f"{actor.id}:ai:canary-clear:{agent_id[:64]}", key=idempotency_key,
                            request=body.model_dump(), run=run)


@router.post("/agents/{agent_id}/rollback", responses={409: {"description": "NO_PREVIOUS_VERSION"}})
async def rollback(agent_id: str, body: ReasonIn, principal: Principal = Depends(staff_auth),
                   rt: Runtime = Depends(get_runtime), idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(AI_PUBLISH)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            await versions.rollback(session, agent_id[:64], body.reason, actor, now_of(rt))
            return 200, await versions.agent_row(session, agent_id[:64], now_of(rt))

    return await idempotent(rt, scope=f"{actor.id}:ai:rollback:{agent_id[:64]}", key=idempotency_key,
                            request=body.model_dump(), run=run)


# ---------------------------------------------------------------- золотые тесты


@router.get("/agents/{agent_id}/golden-cases")
async def list_golden_cases(agent_id: str, principal: Principal = Depends(staff_auth),
                            rt: Runtime = Depends(get_runtime), include_archived: bool = Query(default=False),
                            limit: int = Query(default=200, ge=1, le=200),
                            cursor: str | None = Query(default=None, max_length=200)) -> dict:
    """{items: GoldenCase[], next_cursor} — по case_id."""
    principal.require_permission(AI_READ)
    after = decode_cursor(cursor, 1)
    async with rt.transaction() as session:
        rows, more = await cases.list_cases(session, agent_id[:64], include_archived=include_archived,
                                            after=str(after[0]) if after else None, limit=limit)
    return {"items": [cases.case_view(c) for c in rows],
            "next_cursor": encode_cursor(rows[-1].case_id) if more and rows else None}


@router.post("/agents/{agent_id}/golden-cases", status_code=201,
             responses={422: {"description": "GOLDEN_CASE_INVALID {errors}"}, 409: {"description": "AGENT_NOT_LLM"}})
async def create_golden_case(agent_id: str, body: GoldenCaseIn, principal: Principal = Depends(staff_auth),
                             rt: Runtime = Depends(get_runtime),
                             idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(AI_MANAGE)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            row = await cases.create_case(session, agent_id[:64], body.title, body.input, body.checks,
                                          body.mandatory, actor, now_of(rt))
            return 201, cases.case_view(row)

    return await idempotent(rt, scope=f"{actor.id}:ai:golden:{agent_id[:64]}", key=idempotency_key,
                            request=body.model_dump(mode="json"), run=run)


@router.patch("/golden-cases/{case_id}",
              responses={404: {"description": "GOLDEN_CASE_NOT_FOUND"}, 409: {"description": "GOLDEN_CASE_ARCHIVED"},
                         422: {"description": "GOLDEN_CASE_INVALID {errors}"}})
async def update_golden_case(case_id: str, body: GoldenCasePatch, principal: Principal = Depends(staff_auth),
                             rt: Runtime = Depends(get_runtime)) -> dict:
    actor = principal.require_permission(AI_MANAGE)
    changes = {k: getattr(body, k) for k in body.model_fields_set}
    if any(v is None for v in changes.values()):
        raise unprocessable("GOLDEN_CASE_INVALID", "Поля не могут быть пустыми",
                            {"errors": [{"path": k, "message": "пусто"} for k, v in changes.items() if v is None]})
    async with rt.transaction() as session:
        return cases.case_view(await cases.update_case(session, case_id[:64], changes, actor))


@router.delete("/golden-cases/{case_id}", status_code=204, responses={404: {"description": "GOLDEN_CASE_NOT_FOUND"}})
async def archive_golden_case(case_id: str, principal: Principal = Depends(staff_auth),
                              rt: Runtime = Depends(get_runtime)) -> Response:
    """Удаление = архив (повтор — без изменений)."""
    actor = principal.require_permission(AI_MANAGE)
    async with rt.transaction() as session:
        await cases.archive_case(session, case_id[:64], actor, now_of(rt))
    return Response(status_code=204)
