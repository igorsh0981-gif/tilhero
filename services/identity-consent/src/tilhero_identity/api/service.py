"""Служебный API: адресация доставки (только notifications), публичный профиль (social, notifications; спринт 5 —
memory: согласие на запись голоса), статус бота (только telegram-bot-gateway) и выгрузка профилей для начальной
загрузки проекции (спринт 7, только gamification)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Path, Query, Response

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import Principal
from tilhero_identity.api.deps import (
    bot_gateway_only,
    gamification_service_call,
    get_service,
    notifications_only,
    public_profile_callers,
)
from tilhero_identity.export import EXPORT_DEFAULT_LIMIT, EXPORT_MAX_LIMIT, ProfileExport
from tilhero_identity.schemas import BotStatusRequest, DeliveryInfo, ProfileExportPage, PublicProfile
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
    _: Principal = Depends(public_profile_callers),
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


@router.get("/export/profiles", response_model=ProfileExportPage)
async def export_profiles(
    _: Principal = Depends(gamification_service_call),
    rt: Runtime = Depends(get_runtime),
    cursor: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=EXPORT_DEFAULT_LIMIT, ge=1, le=EXPORT_MAX_LIMIT),
) -> ProfileExportPage:
    """Профили неудалённых учеников для начальной загрузки проекции (export.py): user_id, kind, age_band,
    guardian_consent, updated_at; курсор — по user_id, битый — 400 INVALID_CURSOR."""
    return await ProfileExport(rt).page(cursor=cursor, limit=limit)
