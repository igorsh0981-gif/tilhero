"""Служебный API: адресация доставки (только notifications), публичный профиль (social, notifications) и статус бота
(только telegram-bot-gateway)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Path, Response

from tilhero_common.internal_auth import Principal
from tilhero_identity.api.deps import bot_gateway_only, get_service, notifications_only, social_or_notifications
from tilhero_identity.schemas import BotStatusRequest, DeliveryInfo, PublicProfile
from tilhero_identity.service import IdentityService

router = APIRouter(prefix="/internal/v1", tags=["internal"])


@router.get("/users/{user_id}/delivery", response_model=DeliveryInfo)
async def delivery(
    user_id: uuid.UUID,
    _: Principal = Depends(notifications_only),
    svc: IdentityService = Depends(get_service),
) -> DeliveryInfo:
    return await svc.delivery(user_id)


@router.get("/users/{user_id}/public", response_model=PublicProfile)
async def public_profile(
    user_id: uuid.UUID,
    _: Principal = Depends(social_or_notifications),
    svc: IdentityService = Depends(get_service),
) -> PublicProfile:
    return await svc.public_profile(user_id)


# Access-лог общего middleware пишет шаблон маршрута, а не путь: Telegram ID из пути в лог не попадает.
@router.post("/telegram-users/{telegram_user_id}/bot-status", status_code=204, response_class=Response)
async def bot_status(
    body: BotStatusRequest,
    telegram_user_id: int = Path(ge=1, le=2**63 - 1),
    _: Principal = Depends(bot_gateway_only),
    svc: IdentityService = Depends(get_service),
) -> Response:
    await svc.set_bot_status(telegram_user_id, body.blocked)
    return Response(status_code=204)
