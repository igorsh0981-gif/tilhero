from __future__ import annotations

from fastapi import Request

from tilhero_admin_identity.domain.auth import Identity
from tilhero_common.errors import forbidden
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
