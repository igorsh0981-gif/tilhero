"""Админ-контур (спринт 2): снимки профилей для read-модели user-admin и раскрытие Telegram ID сотруднику.

- GET /admin/v1/users, GET /admin/v1/users/{id} — только user-admin, без контекста сотрудника. Полного Telegram ID
  в ответе нет (маска «••••••789»).
- POST /admin/v1/users/{id}/reveal — только admin-bff с actor и правом users.sensitive.read; синхронный аудит.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query, Response

from tilhero_common.errors import forbidden, unprocessable
from tilhero_common.internal_auth import Principal
from tilhero_identity.api.deps import admin_bff_only, get_service, user_admin_only
from tilhero_identity.schemas import AdminIdentityUser, AdminIdentityUserPage, RevealRequest, RevealResult
from tilhero_identity.service import IdentityService

router = APIRouter(prefix="/admin/v1/users", tags=["admin"])


def _service_only(principal: Principal) -> None:
    # user-admin не может нести actor (его принимают только от admin-bff), но и контекст пользователя здесь лишний
    if principal.actor is not None or principal.subject:
        raise forbidden("CALLER_CONTEXT_NOT_ALLOWED", "Вызов допускается только без контекста пользователя")


@router.get("", response_model=AdminIdentityUserPage)
async def list_users(
    principal: Principal = Depends(user_admin_only),
    svc: IdentityService = Depends(get_service),
    updated_after: datetime | None = Query(default=None),
    cursor: str | None = Query(default=None, max_length=256),
    limit: int = Query(default=20, ge=1, le=100),
) -> AdminIdentityUserPage:
    _service_only(principal)
    if updated_after is not None and updated_after.tzinfo is None:
        raise unprocessable("VALIDATION_ERROR", "updated_after — ISO-8601 с часовым поясом",
                            {"field": "updated_after"})
    return await svc.admin_list_users(updated_after=updated_after, cursor=cursor, limit=limit)


@router.get("/{user_id}", response_model=AdminIdentityUser)
async def get_user(
    user_id: uuid.UUID,
    principal: Principal = Depends(user_admin_only),
    svc: IdentityService = Depends(get_service),
) -> AdminIdentityUser:
    _service_only(principal)
    return await svc.admin_get_user(user_id)


@router.post("/{user_id}/reveal", response_model=RevealResult)
async def reveal(
    user_id: uuid.UUID,
    body: RevealRequest,
    response: Response,
    principal: Principal = Depends(admin_bff_only),
    svc: IdentityService = Depends(get_service),
) -> RevealResult:
    actor = principal.require_permission("users.sensitive.read")
    result = await svc.reveal(user_id, actor=actor, field=body.field, reason=body.reason)
    response.headers["Cache-Control"] = "no-store"  # значение не кэшируется ни прокси, ни браузером
    return result
