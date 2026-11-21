"""Расписание n8n `game-tick` (каждые 15 минут): POST /internal/v1/game:tick — вход только по SCHEDULER_TOKEN.
Задания дня → expired после полуночи ученика, события недели → finished; спринт 7 — закрытие недели лиг и группы
новой недели, истечение вызовов на дуэль и завершение дуэлей по дедлайну; раз в сутки сверка кошельков с реестром.
Повтор безопасен (§1.13; спринт 7 §2.2, §2.3)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_gamification.api.common import now, scheduler_only, settings_of
from tilhero_gamification.domain import bootstrap, tick

router = APIRouter(prefix="/internal/v1", tags=["scheduler"])


@router.post("/game:tick", responses={401: {"description": "SCHEDULER_TOKEN_INVALID"},
                                      403: {"description": "CALLER_NOT_ALLOWED"}})
async def game_tick(request: Request, _: str = Depends(scheduler_only),
                    rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Счётчики шагов; `skipped: true` — идёт предыдущий tick."""
    return await tick.run(rt, settings_of(request), now(request))


@router.post("/projections/bootstrap", responses={401: {"description": "SCHEDULER_TOKEN_INVALID"},
                                                 403: {"description": "CALLER_NOT_ALLOWED"}})
async def projections_bootstrap(request: Request, force: bool = Query(default=False),
                                _: str = Depends(scheduler_only), rt: Runtime = Depends(get_runtime)
                                ) -> dict[str, Any]:
    """Разовая загрузка проекций (семьи, дружбы, полосы уровня) из выгрузок social и diagnostics: незавершённые —
    с курсора; force — заново (безопасно: только вставка отсутствующих строк). → {name: {status, items}} или
    {skipped: true} (идёт другая загрузка)."""
    return await bootstrap.run(rt, now(request), force=force)
