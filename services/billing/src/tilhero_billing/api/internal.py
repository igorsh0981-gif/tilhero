"""Внутренний API для lessons (INTERNAL_API §1.11): удержание минут при старте занятия с ИИ и доступ к функции
подписки (приглашение в урок вдвоём). `user_id` — только свой (= sub токена), иначе 403 USER_CONTEXT_MISMATCH.
Не зависит от флагов продаж; billing недоступен — lessons ведёт занятие без ИИ."""

from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query

from tilhero_billing.api.common import lessons_auth
from tilhero_billing.domain import account
from tilhero_billing.schemas import HoldBody
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import forbidden
from tilhero_common.internal_auth import Principal

router = APIRouter(prefix="/internal/v1", tags=["internal"])


def _same_user(principal: Principal, user_id: uuid.UUID) -> None:
    if principal.subject != str(user_id):
        raise forbidden("USER_CONTEXT_MISMATCH", "user_id не совпадает с контекстом вызова")


@router.post("/holds")
async def create_hold(body: HoldBody, principal: Principal = Depends(lessons_auth),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """→ {allowed: true, hold_id, minutes_held, minutes_left, period_ends_at} | {allowed: false, reason:
    no_subscription | feature_not_in_plan | minutes_exhausted | kids}. Повтор (ref_kind, ref_id) — тот же ответ."""
    _same_user(principal, body.user_id)
    return await account.hold(rt, body.user_id, body.feature, body.ref_kind, body.ref_id, body.minutes_planned)


@router.get("/access/{user_id}")
async def get_access(user_id: uuid.UUID, principal: Principal = Depends(lessons_auth),
                     rt: Runtime = Depends(get_runtime),
                     feature: Literal["ai_lessons", "pair_lessons"] = Query(default="pair_lessons")
                     ) -> dict[str, Any]:
    _same_user(principal, user_id)
    return await account.access(rt, user_id, feature)
