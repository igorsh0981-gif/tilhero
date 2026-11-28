"""Служебный API: адресация доставки (только notifications), публичный профиль (social, notifications; спринт 5 —
memory: согласие на запись голоса), статус бота (только telegram-bot-gateway), выгрузка профилей для начальной
загрузки проекции (спринт 7 — gamification, спринт 8 — billing) и связь Telegram ID ↔ аккаунт (спринт 8: Stars через
telegram-bot-gateway, вход на сайт оплаты через telegram-bff)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Path, Query, Response

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import Principal
from tilhero_identity.api.deps import (
    bot_gateway_only,
    bot_gateway_service_call,
    get_service,
    notifications_only,
    profile_export_service_call,
    public_profile_callers,
    telegram_account_service_call,
)
from tilhero_identity.export import EXPORT_DEFAULT_LIMIT, EXPORT_MAX_LIMIT, ProfileExport
from tilhero_identity.schemas import (
    AccountTelegramUser,
    BotStatusRequest,
    DeliveryInfo,
    ProfileExportPage,
    PublicProfile,
    TelegramUserAccount,
)
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


# Спринт 8 (INTERNAL_API §9). Telegram ID — в пути, но access-лог пишет шаблон маршрута; в ответе /account Telegram ID
# нет, в ответе /telegram-user он есть (тела ответов не логируются). Cache-Control: no-store — значение не кешируется.
@router.get("/telegram-users/{telegram_user_id}/account", response_model=TelegramUserAccount)
async def telegram_user_account(
    response: Response,
    telegram_user_id: int = Path(ge=1, le=2**63 - 1),
    _: Principal = Depends(telegram_account_service_call),
    svc: IdentityService = Depends(get_service),
) -> TelegramUserAccount:
    """Telegram ID → `{account_id, age_band, guardian_consent, status}` (telegram-bot-gateway, telegram-bff); детский
    профиль, обезличенный и неизвестный — 404 USER_NOT_FOUND."""
    response.headers["Cache-Control"] = "no-store"
    return await svc.account_by_telegram(telegram_user_id)


@router.get("/accounts/{account_id}/telegram-user", response_model=AccountTelegramUser)
async def account_telegram_user(
    account_id: uuid.UUID,
    response: Response,
    _: Principal = Depends(bot_gateway_service_call),
    svc: IdentityService = Depends(get_service),
) -> AccountTelegramUser:
    """Аккаунт → `{telegram_user_id}` (только telegram-bot-gateway); удаляемый — отдаётся (сага billing отменяет
    подписку Stars до ACK billing); детский профиль, обезличенный и неизвестный — 404 USER_NOT_FOUND."""
    response.headers["Cache-Control"] = "no-store"
    return await svc.telegram_of_account(account_id)


@router.get("/export/profiles", response_model=ProfileExportPage)
async def export_profiles(
    _: Principal = Depends(profile_export_service_call),
    rt: Runtime = Depends(get_runtime),
    cursor: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=EXPORT_DEFAULT_LIMIT, ge=1, le=EXPORT_MAX_LIMIT),
) -> ProfileExportPage:
    """Профили неудалённых учеников для начальной загрузки проекции (export.py): user_id, kind, age_band,
    guardian_consent, guardian_user_id, updated_at; курсор — по user_id, битый — 400 INVALID_CURSOR."""
    return await ProfileExport(rt).page(cursor=cursor, limit=limit)
