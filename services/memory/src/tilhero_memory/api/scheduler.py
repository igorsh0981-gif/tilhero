"""Расписание n8n `memory-tick` (каждые 15 минут): POST /internal/v1/memory:tick — вход только по SCHEDULER_TOKEN.
Истечение сессий, вечерние напоминания, перенос проверок без активности, сроки хранения. Повтор безопасен."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_memory.api.common import now, scheduler_only, settings_of
from tilhero_memory.domain import tick

router = APIRouter(prefix="/internal/v1", tags=["scheduler"])


@router.post("/memory:tick", responses={401: {"description": "SCHEDULER_TOKEN_INVALID"},
                                        403: {"description": "CALLER_NOT_ALLOWED"}})
async def memory_tick(request: Request, _: str = Depends(scheduler_only),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Счётчики шагов; `skipped: true` — идёт предыдущий tick."""
    return await tick.run(rt, settings_of(request), now(request))
