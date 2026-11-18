from __future__ import annotations

import re

from fastapi import Request

from tilhero_admin_identity.domain.auth import Identity
from tilhero_common.errors import forbidden, unprocessable
from tilhero_common.internal_auth import Actor, InternalAuth, Principal

# /internal/v1/* и /admin/v1/* вызывает только admin-bff; actor в токене принимается только от него (py-common)
bff_only = InternalAuth({"admin-bff"})

NO_STORE = {"Cache-Control": "no-store"}


def get_identity(request: Request) -> Identity:
    return request.app.state.identity


def require_actor(principal: Principal) -> Actor:
    if principal.actor is None:
        raise forbidden("STAFF_CONTEXT_REQUIRED", "Команда доступна только сотрудникам")
    return principal.actor


_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9_\-:.]{8,128}$")


def required_idempotency_key(value: str | None) -> str:
    """admin.ts: создающие команды принимают Idempotency-Key (8..128, [A-Za-z0-9_\\-:.]); где он обязателен —
    без него 422 IDEMPOTENCY_KEY_REQUIRED."""
    if value is None:
        raise unprocessable("IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key")
    if not _IDEMPOTENCY_RE.match(value):
        raise unprocessable("IDEMPOTENCY_KEY_INVALID",
                            "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)")
    return value
