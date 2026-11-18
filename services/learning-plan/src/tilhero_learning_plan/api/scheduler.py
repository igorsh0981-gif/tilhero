"""Расписание n8n (каждые 5 мин): POST /internal/v1/plan:tick — вход только по SCHEDULER_TOKEN."""

from __future__ import annotations

import logging
from datetime import timedelta

from fastapi import APIRouter, Depends, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_learning_plan.api.common import clock_of, scheduler_only, settings_of
from tilhero_learning_plan.domain.tick import run_tick
from tilhero_learning_plan.schemas import TickOut

router = APIRouter(prefix="/internal/v1", tags=["scheduler"])
log = logging.getLogger("tilhero.learning_plan.tick")


@router.post("/plan:tick", response_model=TickOut)
async def plan_tick(request: Request, _: str = Depends(scheduler_only),
                    rt: Runtime = Depends(get_runtime)) -> TickOut:
    """Напоминания о слотах и пропуски за окно (last_tick_at, now]. Повтор безопасен: slot_marks.
    Пока идёт предыдущий tick — сразу 200 {skipped: true} (без ожидания блокировки)."""
    settings = settings_of(request)
    if rt.db is None:
        raise RuntimeError("DATABASE_URL is not configured")
    relay = rt.relay
    result = await run_tick(rt.db.engine, clock=clock_of(request), producer=settings.service_name,
                            schema=rt.db.schema,
                            max_lookback=timedelta(hours=settings.tick_max_lookback_hours),
                            batch_size=settings.tick_batch_size,
                            on_commit=relay.wake if relay is not None else None)
    if result.skipped:
        log.info("plan:tick skipped: previous tick is still running")
    return TickOut(plans_checked=result.plans_checked, reminders=result.reminders, missed=result.missed,
                   skipped=result.skipped)
