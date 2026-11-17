"""Внутренние сервисные API preferences (не от имени пользователя).

GET /internal/v1/demand — агрегат спроса для discovery (спринт 3). Вызывающий — только discovery.
"""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_learning_plan.domain.demand import build_demand
from tilhero_learning_plan.schemas import DemandOut
from tilhero_learning_plan.settings import Settings

DEMAND_CALLERS = {"discovery"}

router = APIRouter(prefix="/internal/v1", tags=["internal"])
demand_auth = InternalAuth(DEMAND_CALLERS)


@router.get("/demand", response_model=DemandOut)
async def get_demand(_: Principal = Depends(demand_auth), rt: Runtime = Depends(get_runtime)) -> DemandOut:
    settings: Settings = rt.settings  # type: ignore[assignment]
    async with rt.transaction() as session:
        demand = await build_demand(session, min_group=settings.demand_min_group, top=settings.demand_top_n)
    return DemandOut.model_validate(asdict(demand))
