from __future__ import annotations

import re
import uuid
from typing import cast

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, unauthorized, unprocessable
from tilhero_common.internal_auth import Principal
from tilhero_support.settings import Settings

_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,128}$")

# Канал обращения определяется вызывающим BFF (ТЗ: «BFF сам добавляет … Telegram channel context»)
CHANNEL_BY_ISSUER = {"telegram-bff": "telegram"}


def user_uuid(principal: Principal) -> uuid.UUID:
    """user_id — только из внутреннего токена (CONVENTIONS §2, защита от IDOR)."""
    try:
        return uuid.UUID(principal.user_id)
    except ValueError as exc:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from exc


def idempotency_key(value: str | None, *, required: bool) -> str | None:
    if value is None:
        if required:
            raise ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key")
        return None
    if not _IDEMPOTENCY_RE.match(value):
        raise unprocessable(
            "IDEMPOTENCY_KEY_INVALID", "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)"
        )
    return value


def cfg(rt: Runtime) -> Settings:
    return cast(Settings, rt.settings)
