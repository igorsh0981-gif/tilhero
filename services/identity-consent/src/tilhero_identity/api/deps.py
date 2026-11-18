"""Зависимости API: разрешённые вызывающие (явно, CONVENTIONS §2, INTERNAL_API §1) и user_id только из токена."""

from __future__ import annotations

import re
import uuid

from fastapi import Depends, Header, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unauthorized, unprocessable
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_identity.service import IdentityService

telegram_bff = InternalAuth({"telegram-bff"})
notifications_only = InternalAuth({"notifications"})
bot_gateway_only = InternalAuth({"telegram-bot-gateway"})
social_or_notifications = InternalAuth({"social", "notifications"})

_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,128}$")


def current_user_id(principal: Principal = Depends(telegram_bff)) -> uuid.UUID:
    """sub внутреннего токена — единственный источник user_id (защита от IDOR). Для identity `sub` — аккаунт."""
    try:
        return uuid.UUID(principal.user_id)
    except ValueError as exc:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from exc


def idempotency_key(value: str | None = Header(default=None, alias="Idempotency-Key")) -> str | None:
    """Необязательный Idempotency-Key создающих команд: повтор с тем же ключом — тот же результат."""
    if value is None:
        return None
    if not _IDEMPOTENCY_RE.match(value):
        raise unprocessable("IDEMPOTENCY_KEY_INVALID",
                            "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)")
    return value


def get_service(request: Request, rt: Runtime = Depends(get_runtime)) -> IdentityService:
    """Часы сервиса (UTC): тесты подменяют `app.state.clock` (срок ожидающего сброса кода родителя)."""
    return IdentityService(rt, clock=getattr(request.app.state, "clock", None))
