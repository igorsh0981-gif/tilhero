"""Расписание n8n (каждые 5 мин): POST /internal/v1/plan:tick — вход только по SCHEDULER_TOKEN."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_learning_plan.api.common import clock_of, scheduler_only, settings_of
from tilhero_learning_plan.domain.tick import run_tick
from tilhero_learning_plan.schemas import TickOut

router = APIRouter(prefix="/internal/v1", tags=["scheduler"])


@router.post("/plan:tick", response_model=TickOut)
async def plan_tick(request: Request, _: str = Depends(scheduler_only),
                    rt: Runtime = Depends(get_runtime)) -> TickOut:
    """Напоминания о слотах и пропуски за окно (last_tick_at, now]. Повтор безопасен: slot_marks."""
    settings = settings_of(request)
    async with rt.transaction() as session:
        result = await run_tick(session, clock=clock_of(request), producer=settings.service_name,
                                max_lookback=timedelta(hours=settings.tick_max_lookback_hours),
                                batch_size=settings.tick_batch_size)
    return TickOut(plans_checked=result.plans_checked, reminders=result.reminders, missed=result.missed)
