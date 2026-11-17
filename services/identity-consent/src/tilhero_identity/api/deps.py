"""Зависимости API: разрешённые вызывающие (явно, CONVENTIONS §2) и user_id только из токена."""

from __future__ import annotations

import uuid

from fastapi import Depends

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unauthorized
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_identity.service import IdentityService

telegram_bff = InternalAuth({"telegram-bff"})
notifications_only = InternalAuth({"notifications"})
bot_gateway_only = InternalAuth({"telegram-bot-gateway"})
# Админ-контур (спринт 2): read-модель user-admin сверяется без контекста сотрудника; раскрытие PII — только
# admin-bff с actor и правом users.sensitive.read.
user_admin_only = InternalAuth({"user-admin"})
admin_bff_only = InternalAuth({"admin-bff"})


def current_user_id(principal: Principal = Depends(telegram_bff)) -> uuid.UUID:
    """sub внутреннего токена — единственный источник user_id (защита от IDOR)."""
    try:
        return uuid.UUID(principal.user_id)
    except ValueError as exc:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from exc


def get_service(rt: Runtime = Depends(get_runtime)) -> IdentityService:
    return IdentityService(rt)
