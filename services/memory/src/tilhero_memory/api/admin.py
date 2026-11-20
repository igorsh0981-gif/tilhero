"""Admin API memory (только admin-bff; права сотрудника из actor проверяются здесь — защита в глубину; step-up для
memory.manage — в admin-bff), INTERNAL_API §1.11, формы admin.ts «Память, словарь курса, чтение».

memory.read — сводка ученика, карточки, история планирования, аналитика; memory.manage — ручная правка одной
карточки (причина ≥ 10, аудит memory.card_adjusted); dashboard.read — блок обзора и аналитика. Цитата ошибки
ученика не показывается; в аналитике user_id нет, группы меньше 5 учеников скрыты.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Query, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import Principal
from tilhero_memory.api.common import (
    PAIR_PATTERN,
    catalog_of,
    idempotency_key,
    now,
    settings_of,
    staff_auth,
    staff_with_any,
)
from tilhero_memory.domain import admin as svc
from tilhero_memory.domain import analytics
from tilhero_memory.domain.common import DASHBOARD_READ, MEMORY_MANAGE, MEMORY_READ
from tilhero_memory.schemas import CardActionIn

router = APIRouter(prefix="/admin/v1/memory", tags=["staff"])

_AUTH: dict[int | str, dict[str, Any]] = {401: {"description": "INTERNAL_TOKEN_*"},
                                          403: {"description": "PERMISSION_DENIED | STAFF_CONTEXT_REQUIRED | "
                                                               "CALLER_NOT_ALLOWED"}}


@router.get("/learners/{user_id}", responses={**_AUTH, 404: {"description": "MEMORY_LEARNER_NOT_FOUND"}})
async def learner_summary(user_id: uuid.UUID, request: Request, principal: Principal = Depends(staff_auth),
                          rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """LearnerMemorySummary."""
    principal.require_permission(MEMORY_READ)
    async with rt.transaction() as db:
        return await svc.learner_summary(db, catalog_of(request), user_id, now(request))


@router.get("/learners/{user_id}/cards", responses={**_AUTH, 400: {"description": "INVALID_CURSOR"}})
async def learner_cards(user_id: uuid.UUID, request: Request,
                        status: Literal["new", "learning", "review", "known", "frozen", "archived"] | None = Query(
                            default=None),
                        kind: Literal["word", "phrase", "error"] | None = Query(default=None),
                        cursor: str | None = Query(default=None, max_length=300),
                        limit: int = Query(default=20, ge=1, le=100),
                        principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                        ) -> dict[str, Any]:
    """Page<AdminCardRow> — без цитаты ошибки."""
    principal.require_permission(MEMORY_READ)
    async with rt.transaction() as db:
        return await svc.learner_cards(db, user_id, status=status, kind=kind, cursor=cursor, limit=limit,
                                       now=now(request))


@router.get("/cards/{card_id}", responses={**_AUTH, 404: {"description": "CARD_NOT_FOUND"}})
async def card_detail(card_id: uuid.UUID, request: Request, principal: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """AdminCardDetail: карточка + первая страница истории планирования."""
    principal.require_permission(MEMORY_READ)
    async with rt.transaction() as db:
        return await svc.card_detail(db, card_id, now(request))


@router.get("/cards/{card_id}/log", responses={**_AUTH, 400: {"description": "INVALID_CURSOR"},
                                              404: {"description": "CARD_NOT_FOUND"}})
async def card_log(card_id: uuid.UUID, cursor: str | None = Query(default=None, max_length=300),
                   limit: int = Query(default=20, ge=1, le=100), principal: Principal = Depends(staff_auth),
                   rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Page<ReviewLogRow>: было/стало, алгоритм и версия, кто."""
    principal.require_permission(MEMORY_READ)
    async with rt.transaction() as db:
        return await svc.card_log(db, card_id, cursor=cursor, limit=limit)


@router.post("/cards/{card_id}/actions", responses={
    **_AUTH, 404: {"description": "CARD_NOT_FOUND"}, 409: {"description": "CARD_STATE {status}"},
    422: {"description": "DUE_AT_RANGE | VALIDATION_ERROR (reason ≥ 10) | IDEMPOTENCY_KEY_REUSED"}})
async def card_action(card_id: uuid.UUID, body: CardActionIn, request: Request,
                      key: str | None = Header(default=None, alias="Idempotency-Key"),
                      principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                      ) -> dict[str, Any]:
    """AdminCardDetail после правки: reschedule | reset | freeze | unfreeze (review_log + аудит). Idempotency-Key —
    повтор того же сотрудника за 24 ч возвращает тот же ответ без новой строки истории и аудита."""
    actor = principal.require_permission(MEMORY_MANAGE)
    k = idempotency_key(key) if key is not None else None
    async with rt.transaction() as db:
        return await svc.card_action(db, actor, card_id, body.action, body.due_at, body.reason, now(request), k)


@router.get("/analytics", responses=_AUTH)
async def forgetting_analytics(request: Request,
                               pair_id: str = Query(default="ru-en", max_length=17, pattern=PAIR_PATTERN),
                               period: Literal["30d", "90d"] = Query(default="30d"),
                               principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                               ) -> dict[str, Any]:
    """ForgettingAnalytics — агрегаты без данных учеников (k-анонимность 5)."""
    staff_with_any(principal, MEMORY_READ, DASHBOARD_READ)
    async with rt.transaction() as db:
        return await analytics.forgetting(db, catalog_of(request), pair_id, period, now(request))


@router.get("/stats", responses=_AUTH)
async def memory_stats(request: Request, period: Literal["today", "7d", "30d"] = Query(default="7d"),
                       principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                       ) -> dict[str, Any]:
    """MemoryStats — блок обзора (dashboard.read)."""
    principal.require_permission(DASHBOARD_READ)
    async with rt.transaction() as db:
        return await analytics.stats(db, period, now(request), settings_of(request).stats_timezone)
