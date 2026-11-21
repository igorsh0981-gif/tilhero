"""Расписание n8n `lessons-tick` (каждые 15 минут): POST /internal/v1/lessons:tick — вход только по SCHEDULER_TOKEN.
Брошенные сессии → cancelled, стирание текстов по сроку хранения, повторная отправка в assessment; спринт 7 — наборы
дуэлей и парные комнаты (domain/tick.py). Повтор безопасен.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_lessons.api.common import catalog_of, clock_of, scheduler_only, settings_of
from tilhero_lessons.domain import tick

router = APIRouter(prefix="/internal/v1", tags=["scheduler"])


@router.post("/lessons:tick", responses={401: {"description": "SCHEDULER_TOKEN_INVALID"},
                                         403: {"description": "CALLER_NOT_ALLOWED"}})
async def lessons_tick(request: Request, _: str = Depends(scheduler_only),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    return await tick.run(rt, catalog_of(request), settings_of(request), clock_of(request)(),
                          getattr(request.app.state, "room_hub", None))
