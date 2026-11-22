"""Админ-API лиг и дуэлей (INTERNAL_API спринта 7 §2.6, admin.ts «Лиги и дуэли», ADM-GAME-02; вызывающий — только
admin-bff с actor). Права — в домене: league.read — чтение; league.manage — переоценка группы и дуэли (step-up) и
снятие удержания призов. Каждая команда — аудит admin.audit.recorded.v1 (без текстов учеников). Итоги и результаты
неизменяемы: переоценка создаёт новую версию, прежняя сохраняется."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import Principal
from tilhero_gamification.api.common import now, require, require_any, settings_of, staff_auth
from tilhero_gamification.domain import duels, leagues
from tilhero_gamification.domain.common import DASHBOARD_READ, LEAGUE_MANAGE, LEAGUE_READ
from tilhero_gamification.schemas import DuelReevaluateIn, LeagueReevaluateIn, Reason500

router = APIRouter(prefix="/internal/v1/admin/game", tags=["staff-social"])

_AUTH: dict[int | str, dict[str, Any]] = {
    401: {"description": "INTERNAL_TOKEN_*"},
    403: {"description": "PERMISSION_DENIED | STAFF_CONTEXT_REQUIRED | CALLER_NOT_ALLOWED | STEP_UP_REQUIRED"}}


# ---------------------------------------------------------------- лиги


@router.get("/leagues", responses=_AUTH)
async def league_week(request: Request, week: date | None = Query(default=None),
                      principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                      ) -> dict[str, Any]:
    """AdminLeagueWeek (по умолчанию текущая неделя; любая дата — её неделя)."""
    require(principal, LEAGUE_READ)
    monday = week - timedelta(days=week.weekday()) if week is not None else None
    async with rt.transaction() as db:
        return await leagues.admin_week(db, settings_of(request), monday, now(request))


@router.get("/leagues/{group_id}", responses={**_AUTH, 404: {"description": "GROUP_NOT_FOUND"}})
async def league_group(group_id: uuid.UUID, request: Request, principal: Principal = Depends(staff_auth),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """AdminLeagueGroup: участники с XP, призами и аномалиями; все версии итогов."""
    require(principal, LEAGUE_READ)
    async with rt.transaction() as db:
        return await leagues.admin_group(db, settings_of(request), group_id, now(request))


@router.post("/leagues/{group_id}/reevaluate", responses={
    **_AUTH, 404: {"description": "GROUP_NOT_FOUND"},
    409: {"description": "RESULT_STATE {status} | BALANCE_NEGATIVE"}, 422: {"description": "VALIDATION_ERROR"}})
async def league_reevaluate(group_id: uuid.UUID, body: LeagueReevaluateIn, request: Request,
                            principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                            ) -> dict[str, Any]:
    """Переоценка закрытой группы (league.manage + step-up): версия + 1, разница призов — обратными записями."""
    actor = require(principal, LEAGUE_MANAGE, request, step_up=True)
    async with rt.transaction() as db:
        return await leagues.reevaluate(db, settings_of(request), actor, group_id, body.exclude_user_ids, body.reason,
                                        now(request))


@router.post("/leagues/{group_id}/release-prizes", responses={
    **_AUTH, 404: {"description": "GROUP_NOT_FOUND"}, 409: {"description": "RESULT_STATE {status}"}})
async def league_release(group_id: uuid.UUID, body: Reason500, request: Request,
                         principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                         ) -> dict[str, Any]:
    """Снятие удержания призов (league.manage; только held): версия + 1, призы выдаются."""
    actor = require(principal, LEAGUE_MANAGE)
    async with rt.transaction() as db:
        return await leagues.release_prizes(db, settings_of(request), actor, group_id, body.reason, now(request))


# ---------------------------------------------------------------- дуэли


@router.get("/duels/stats", responses=_AUTH)
async def duel_stats(request: Request, period: Literal["today", "7d", "30d"] = Query(default="7d"),
                     principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                     ) -> dict[str, Any]:
    """{period, duels_finished} — для Dashboard.social (league.read или dashboard.read; данные обезличены)."""
    require_any(principal, LEAGUE_READ, DASHBOARD_READ)
    async with rt.transaction() as db:
        return await duels.stats(db, settings_of(request), period, now(request))


@router.get("/duels", responses={**_AUTH, 400: {"description": "INVALID_CURSOR"}})
async def duel_list(status: Literal["challenged", "declined", "expired", "accepted", "finished", "cancelled"] | None
                    = Query(default=None), cursor: str | None = Query(default=None, max_length=300),
                    principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                    ) -> dict[str, Any]:
    """Page<AdminDuelRow>, новые сверху."""
    require(principal, LEAGUE_READ)
    async with rt.transaction() as db:
        return await duels.admin_list(db, status, cursor)


@router.get("/duels/{duel_id}", responses={**_AUTH, 404: {"description": "DUEL_NOT_FOUND"}})
async def duel_get(duel_id: uuid.UUID, principal: Principal = Depends(staff_auth),
                   rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """AdminDuel: счёт, набор, награды (в т. ч. обратные записи), история результатов."""
    require(principal, LEAGUE_READ)
    async with rt.transaction() as db:
        return await duels.admin_get(db, duel_id)


@router.post("/duels/{duel_id}/reevaluate", responses={
    **_AUTH, 404: {"description": "DUEL_NOT_FOUND"}, 409: {"description": "RESULT_STATE {status}"}})
async def duel_reevaluate(duel_id: uuid.UUID, body: DuelReevaluateIn, request: Request,
                          principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                          ) -> dict[str, Any]:
    """Спор (league.manage + step-up): result_version + 1, награды исправляются обратными записями."""
    actor = require(principal, LEAGUE_MANAGE, request, step_up=True)
    async with rt.transaction() as db:
        return await duels.reevaluate(db, settings_of(request), actor, duel_id, body.result, body.reason,
                                      now(request))
