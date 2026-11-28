"""Внутренний API для billing (INTERNAL_API спринта 8 §6, §0.3): пред-проверка возврата пакета тилов. Вызывающий —
только billing (иначе 403 CALLER_NOT_ALLOWED)."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_gamification.domain import til_packs

router = APIRouter(prefix="/internal/v1/game", tags=["billing"])

billing_only = InternalAuth({"billing"})


@router.get("/purchases/by-order/{order_id}", responses={
    401: {"description": "INTERNAL_TOKEN_*"}, 403: {"description": "CALLER_NOT_ALLOWED"},
    404: {"description": "PURCHASE_NOT_FOUND"}})
async def purchase_by_order(order_id: uuid.UUID, _: Principal = Depends(billing_only),
                            rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """{order_id, credited, til, til_balance, status: credited | reversed | tils_spent}: сколько тилов куплено по
    заказу и сколько сейчас на балансе получателя (billing решает, можно ли вернуть деньги без пункта сверки)."""
    async with rt.transaction() as db:
        return await til_packs.by_order(db, order_id)
