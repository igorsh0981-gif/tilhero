"""Admin API парных комнат (только admin-bff с actor; INTERNAL_API §3.2, §9: admin-bff `/admin/v1/pair-rooms*` →
lessons `/internal/v1/admin/pair-rooms…`): room.read — список и карточка без реплик и оценок; room.manage + step-up
(`X-Step-Up: ok` от admin-bff) — остановка с причиной (аудит); обзор — dashboard.read или room.read."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, cast
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import forbidden
from tilhero_common.internal_auth import Actor, Principal
from tilhero_lessons.api.common import clock_of, settings_of, staff_auth
from tilhero_lessons.domain import pair, room_admin
from tilhero_lessons.domain.pair import RoomHub
from tilhero_lessons.schemas import PairRoomStopIn

router = APIRouter(prefix="/internal/v1/admin/pair-rooms", tags=["staff"])
STEP_UP_HEADER = "x-step-up"
Status = Literal["active", "ended", "invited", "declined", "expired", "cancelled", "waiting", "in_progress", "paused",
                 "finished", "abandoned", "stopped"]


def _step_up(principal: Principal, request: Request, permission: str) -> Actor:
    actor = principal.require_permission(permission)
    header = (request.headers.get(STEP_UP_HEADER) or "").strip().lower()
    if header != "ok" and principal.claims.get("step_up") is not True:
        raise forbidden("STEP_UP_REQUIRED", "Подтвердите действие кодом из приложения-аутентификатора",
                        {"permission": permission})
    return actor


@router.get("", responses={400: {"description": "INVALID_CURSOR"},
                           403: {"description": "PERMISSION_DENIED | STAFF_CONTEXT_REQUIRED"}})
async def list_rooms(request: Request, status: Status | None = Query(default=None),
                     date_from: datetime | None = Query(default=None, alias="from"),
                     date_to: datetime | None = Query(default=None, alias="to"),
                     cursor: str | None = Query(default=None, max_length=300),
                     limit: int = Query(default=20, ge=1, le=100),
                     principal: Principal = Depends(staff_auth),
                     rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Page<AdminPairRoomRow> (новые сверху): участники (user_id), сценарий, статус, длительность, секунды каждого,
    стоимость ИИ — без реплик и оценок. status — статус комнаты или группа active / ended."""
    principal.require_permission(room_admin.ROOM_READ)
    async with rt.transaction() as db:
        return await room_admin.list_rooms(db, status=status, date_from=_aware(date_from), date_to=_aware(date_to),
                                           cursor=cursor, limit=limit, now=clock_of(request)())


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


@router.get("/stats", responses={403: {"description": "PERMISSION_DENIED | STAFF_CONTEXT_REQUIRED"}})
async def stats(request: Request, period: Literal["today", "7d", "30d"] = Query(default="today"),
                principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """{period, pair_rooms_finished, by_status} — для SocialStats.pair_rooms_finished (admin-bff)."""
    actor = principal.actor
    if actor is None:
        raise forbidden("STAFF_CONTEXT_REQUIRED", "Команда доступна только сотрудникам")
    if room_admin.DASHBOARD_READ not in actor.permissions and room_admin.ROOM_READ not in actor.permissions:
        raise forbidden("PERMISSION_DENIED", "Недостаточно прав", {"permission": room_admin.DASHBOARD_READ})
    now = clock_of(request)()
    if period == "today":
        tz = ZoneInfo(settings_of(request).stats_timezone)
        since = now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    else:
        since = now - timedelta(days=7 if period == "7d" else 30)
    async with rt.transaction() as db:
        return {"period": period, **await pair.ended_count(db, since)}


@router.get("/{room_id}", responses={403: {"description": "PERMISSION_DENIED"},
                                     404: {"description": "ROOM_NOT_FOUND"}})
async def get_room(room_id: uuid.UUID, request: Request, principal: Principal = Depends(staff_auth),
                   rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """AdminPairRoom: + ход событий без текстов, кто и почему остановил."""
    principal.require_permission(room_admin.ROOM_READ)
    async with rt.transaction() as db:
        return await room_admin.card(db, room_id, clock_of(request)())


@router.post("/{room_id}/stop", responses={403: {"description": "PERMISSION_DENIED | STEP_UP_REQUIRED"},
                                           404: {"description": "ROOM_NOT_FOUND"},
                                           409: {"description": "ROOM_NOT_ACTIVE {status}"},
                                           422: {"description": "VALIDATION_ERROR (reason 10..500)"}})
async def stop(room_id: uuid.UUID, body: PairRoomStopIn, request: Request, principal: Principal = Depends(staff_auth),
               rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """→ stopped: событие в ленте и уведомление участникам (pair_stopped), отчёт по сделанному; аудит."""
    actor = _step_up(principal, request, room_admin.ROOM_MANAGE)
    now = clock_of(request)()
    hub = cast(RoomHub, request.app.state.room_hub)
    async with rt.transaction() as db:
        eff = await room_admin.stop(db, room_id, actor, body.reason, now, settings_of(request))
    hub.notify(room_id)
    for side in eff.evaluate:
        hub.spawn(pair.evaluate(rt, room_id, side, now))
    async with rt.transaction() as db:
        return await room_admin.card(db, room_id, now)
