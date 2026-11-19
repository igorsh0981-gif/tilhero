"""Расписание n8n `assessment-tick` (раз в сутки достаточно): POST /internal/v1/assessment:tick — вход только по
SCHEDULER_TOKEN. Стирание текстов апелляций через 90 дней после решения (ревью R1-14). Повтор безопасен.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from tilhero_assessment.api.common import clock_of, scheduler_only, settings_of
from tilhero_assessment.domain import retention
from tilhero_assessment.schemas import TickOut
from tilhero_common.app import Runtime, get_runtime

router = APIRouter(prefix="/internal/v1", tags=["scheduler"])


@router.post("/assessment:tick", response_model=TickOut,
             responses={401: {"description": "SCHEDULER_TOKEN_INVALID"}, 403: {"description": "CALLER_NOT_ALLOWED"}})
async def assessment_tick(request: Request, _: str = Depends(scheduler_only),
                          rt: Runtime = Depends(get_runtime)) -> TickOut:
    settings = settings_of(request)
    async with rt.transaction() as session:
        count = await retention.redact_appeal_reasons(session, clock_of(request)(),
                                                      days=settings.appeal_reason_retention_days,
                                                      batch=settings.tick_batch_size)
    return TickOut(redacted_appeal_reasons=count)
