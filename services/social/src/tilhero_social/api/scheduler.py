"""Расписание n8n (каждый час): POST /internal/v1/invites:tick — вход только по SCHEDULER_TOKEN."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_social.api.common import clock_of, scheduler_only, settings_of
from tilhero_social.domain.tick import run_tick
from tilhero_social.schemas import TickOut

router = APIRouter(prefix="/internal/v1", tags=["scheduler"])


@router.post("/invites:tick", response_model=TickOut)
async def invites_tick(request: Request, _: str = Depends(scheduler_only),
                       rt: Runtime = Depends(get_runtime)) -> TickOut:
    """Истёкшие → expired; открытые ≥ 24 ч без ответа → одно напоминание получателю. Повтор безопасен."""
    settings = settings_of(request)
    async with rt.transaction() as session:
        result = await run_tick(session, clock=clock_of(request), producer=settings.service_name,
                                remind_after=timedelta(hours=settings.invite_reminder_after_hours),
                                max_age=timedelta(days=settings.invite_reminder_max_age_days),
                                batch_size=settings.tick_batch_size)
    return TickOut(reminders=result.reminders, expired=result.expired)
