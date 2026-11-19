"""Admin API «Модели и затраты» (admin.ts ADM-AGENT-05, ADM-MONEY-01/02): модели и цены (ai.read / правка
ai.publish; снижение цены — ещё costs.manage, цена модели anthropic > 0 — ревью R1-12), провайдер (ai.read — только
«ключ задан / не задан» и код последней ошибки), бюджет и аварийная остановка (costs.read / costs.manage), затраты
(costs.read; сводка — ещё dashboard.read для обзора; вызовы сессии — ещё qa.read для карточки «Контроля диалогов»).
Step-up правок проверяет admin-bff.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from tilhero_ai_gateway.api.common import (
    IdempotencyKey,
    deps_of,
    idempotent,
    now_of,
    require_any,
    settings_of,
    staff_auth,
)
from tilhero_ai_gateway.domain import costs
from tilhero_ai_gateway.domain.common import (
    AI_PUBLISH,
    AI_READ,
    COSTS_MANAGE,
    COSTS_READ,
    DASHBOARD_READ,
    QA_READ,
    decode_cursor,
    encode_cursor,
)
from tilhero_ai_gateway.schemas import BudgetIn, EmergencyStopIn, ModelUpdateIn
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unprocessable
from tilhero_common.internal_auth import Principal

router = APIRouter(prefix="/admin/v1/ai", tags=["staff"])


@router.get("/models")
async def list_models(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict:
    """{items: AiModel[]}."""
    principal.require_permission(AI_READ)
    async with rt.transaction() as session:
        return {"items": [costs.model_view(m) for m in await costs.list_models(session)]}


@router.put("/models/{model_id}", responses={403: {"description": "PERMISSION_DENIED {permission: costs.manage} — "
                                                                  "снижение цены без права на бюджет"},
                                             404: {"description": "MODEL_NOT_FOUND"},
                                             409: {"description": "MODEL_IN_USE {versions}"},
                                             422: {"description": "PRICE_REQUIRED {fields} — модель anthropic с "
                                                                  "нулевой ценой"}})
async def update_model(model_id: str, body: ModelUpdateIn, principal: Principal = Depends(staff_auth),
                       rt: Runtime = Depends(get_runtime),
                       idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(AI_PUBLISH)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            row = await costs.update_model(
                session, model_id[:64], input_usd=Decimal(str(body.input_usd_per_mtok)).quantize(Decimal("0.0001")),
                output_usd=Decimal(str(body.output_usd_per_mtok)).quantize(Decimal("0.0001")), active=body.active,
                reason=body.reason, actor=actor, now=now_of(rt))
            return 200, costs.model_view(row)

    return await idempotent(rt, scope=f"{actor.id}:ai:model:{model_id[:64]}", key=idempotency_key,
                            request=body.model_dump(), run=run)


@router.get("/provider")
async def provider_status(request: Request, principal: Principal = Depends(staff_auth),
                          rt: Runtime = Depends(get_runtime)) -> dict:
    """AiProviderStatus: ключ — только «задан / не задан», ошибка — только код и время; ai_enabled — для ролей без
    costs.read (баннер «ИИ выключен» в разделах агентов и контроля диалогов)."""
    principal.require_permission(AI_READ)
    deps = deps_of(request)
    async with rt.transaction() as session:
        budget = await costs.get_budget(session)
    return {"provider": deps.provider.name, "key_configured": bool(deps.settings.api_key),
            "last_error": await deps.status.last_error(), "ai_enabled": budget.ai_enabled}


@router.get("/budget")
async def get_budget(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict:
    principal.require_permission(COSTS_READ)
    async with rt.transaction() as session:
        return costs.budget_view(await costs.get_budget(session))


@router.put("/budget", responses={409: {"description": "BUDGET_CONFLICT {updated_at}"}})
async def update_budget(body: BudgetIn, principal: Principal = Depends(staff_auth),
                        rt: Runtime = Depends(get_runtime),
                        idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(COSTS_MANAGE)
    values: dict[str, Any] = {
        "monthly_cap_usd": Decimal(str(body.monthly_cap_usd)).quantize(Decimal("0.01")),
        "learner_daily_cap_usd": Decimal(str(body.learner_daily_cap_usd)).quantize(Decimal("0.0001")),
        "lesson_cap_usd": Decimal(str(body.lesson_cap_usd)).quantize(Decimal("0.0001")),
        "alert_percent": body.alert_percent,
    }
    if body.ai_enabled is not None:
        values["ai_enabled"] = body.ai_enabled

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            row = await costs.update_budget(session, values, body.updated_at, body.reason, actor, now_of(rt))
            return 200, costs.budget_view(row)

    return await idempotent(rt, scope=f"{actor.id}:ai:budget", key=idempotency_key, request=body.model_dump(),
                            run=run)


@router.post("/emergency-stop")
async def emergency_stop(body: EmergencyStopIn, principal: Principal = Depends(staff_auth),
                         rt: Runtime = Depends(get_runtime),
                         idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    """{enabled: true} — остановка включена: все вызовы unavailable (ai_disabled), уроки идут без ИИ."""
    actor = principal.require_permission(COSTS_MANAGE)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            row = await costs.update_budget(session, {"ai_enabled": not body.enabled}, None, body.reason, actor,
                                            now_of(rt))
            return 200, costs.budget_view(row)

    return await idempotent(rt, scope=f"{actor.id}:ai:emergency-stop", key=idempotency_key,
                            request=body.model_dump(), run=run)


@router.get("/usage/summary")
async def usage_summary(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                        period: Literal["day", "week", "month"] = Query(default="month")) -> dict:
    """AiUsageSummary (costs.read; обзор админки — dashboard.read)."""
    require_any(principal, COSTS_READ, DASHBOARD_READ)
    async with rt.transaction() as session:
        return await costs.summary(session, period, now_of(rt), settings_of(rt).timezone)


MAX_SESSIONS = 50


@router.get("/usage/by-session", responses={422: {"description": "TOO_MANY_SESSIONS | VALIDATION_ERROR"}})
async def usage_by_session(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                           session_id: list[uuid.UUID] = Query(..., min_length=1)) -> dict:
    """{items: [{session_id, models, cost_usd, p95_latency_ms}]} для журнала сессий (qa.read | costs.read), ≤ 50 id;
    сессии без вызовов — с нулями."""
    require_any(principal, QA_READ, COSTS_READ)
    if len(session_id) > MAX_SESSIONS:
        raise unprocessable("TOO_MANY_SESSIONS", f"Не больше {MAX_SESSIONS} сессий за запрос",
                            {"max": MAX_SESSIONS})
    async with rt.transaction() as session:
        return {"items": await costs.by_session(session, session_id)}


@router.get("/usage")
async def list_usage(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                     session_id: uuid.UUID | None = Query(default=None),
                     agent_id: str | None = Query(default=None, max_length=64),
                     limit: int = Query(default=20, ge=1, le=100),
                     cursor: str | None = Query(default=None, max_length=200)) -> dict:
    """Page<AiCall> — вызовы сессии (costs.read | qa.read) или агента (costs.read), новые первыми."""
    if session_id is not None:
        require_any(principal, COSTS_READ, QA_READ)
    else:
        principal.require_permission(COSTS_READ)
    after = decode_cursor(cursor, 1)
    async with rt.transaction() as session:
        rows, more = await costs.list_calls(session, session_id=session_id, agent_id=agent_id,
                                            before_seq=int(after[0]) if after else None, limit=limit)
    return {"items": [costs.call_view(u) for u in rows],
            "next_cursor": encode_cursor(rows[-1].seq) if more and rows else None}
