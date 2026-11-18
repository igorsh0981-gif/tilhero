"""Выгрузка планов для read-модели админки: GET /admin/v1/plans (INTERNAL_API §3).

Вызывающий — только user-admin по внутреннему JWT без контекста сотрудника (actor принимается только от admin-bff,
от user-admin отклоняется общей проверкой токена — ACTOR_NOT_ALLOWED; права сотрудника проверяет user-admin).
Ответ без PII: user_id — псевдоним ученика.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import AwareDatetime

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_learning_plan.domain.admin import list_plans
from tilhero_learning_plan.schemas import AdminPlanPage

router = APIRouter(prefix="/admin/v1", tags=["admin"])
user_admin_only = InternalAuth({"user-admin"})


@router.get("/plans", response_model=AdminPlanPage,
            responses={400: {"description": "INVALID_CURSOR"}, 403: {"description": "CALLER_NOT_ALLOWED"}})
async def admin_plans(
    principal: Principal = Depends(user_admin_only),
    rt: Runtime = Depends(get_runtime),
    updated_after: AwareDatetime | None = Query(default=None, description="ISO-8601 с часовым поясом; строго позже"),
    cursor: str | None = Query(default=None, max_length=256),
    limit: int = Query(default=100, ge=1, le=500),
) -> AdminPlanPage:
    after: datetime | None = updated_after
    async with rt.transaction() as session:
        return await list_plans(session, updated_after=after, cursor=cursor, limit=limit)
