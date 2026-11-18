"""Админ-контур и аудитория рассылок (спринт 2, docs/sprint2/INTERNAL_API.md §3).

- GET /admin/v1/users, GET /admin/v1/users/{id} — только user-admin, без контекста ученика и сотрудника: снимки для
  read-модели (Telegram ID — только маска).
- POST /admin/v1/users/{id}/reveal — только admin-bff с actor и правом users.sensitive.read; синхронный аудит.
- GET /internal/v1/audience, /internal/v1/audience/count — только notifications, без контекста ученика.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query, Response

from tilhero_common.errors import unprocessable
from tilhero_common.internal_auth import Principal
from tilhero_identity.admin import SNAPSHOT_MAX_LIMIT, AdminDirectory
from tilhero_identity.api.deps import (
    admin_bff_only,
    get_admin,
    get_audience,
    no_user_context,
    notifications_service_call,
    user_admin_service_call,
)
from tilhero_identity.audience import AUDIENCE_MAX_LIMIT, Audience, Segment, parse_segment
from tilhero_identity.schemas import (
    AdminLearnerSnapshot,
    AdminLearnerSnapshotPage,
    AudienceCount,
    AudiencePage,
    RevealRequest,
    RevealResult,
)

router = APIRouter(prefix="/admin/v1/users", tags=["admin"])
audience_router = APIRouter(prefix="/internal/v1/audience", tags=["internal"])

NO_STORE = "no-store"


@router.get("", response_model=AdminLearnerSnapshotPage)
async def list_users(
    response: Response,
    _: Principal = Depends(user_admin_service_call),
    svc: AdminDirectory = Depends(get_admin),
    updated_after: datetime | None = Query(default=None),
    cursor: str | None = Query(default=None, max_length=256),
    limit: int = Query(default=100, ge=1, le=SNAPSHOT_MAX_LIMIT),
) -> AdminLearnerSnapshotPage:
    if updated_after is not None and updated_after.tzinfo is None:
        raise unprocessable("VALIDATION_ERROR", "updated_after — ISO-8601 с часовым поясом",
                            {"field": "updated_after"})
    response.headers["Cache-Control"] = NO_STORE
    return await svc.list_snapshots(updated_after=updated_after, cursor=cursor, limit=limit)


@router.get("/{user_id}", response_model=AdminLearnerSnapshot)
async def get_user(
    user_id: uuid.UUID,
    response: Response,
    _: Principal = Depends(user_admin_service_call),
    svc: AdminDirectory = Depends(get_admin),
) -> AdminLearnerSnapshot:
    response.headers["Cache-Control"] = NO_STORE
    return await svc.get_snapshot(user_id)


@router.post("/{user_id}/reveal", response_model=RevealResult)
async def reveal(
    user_id: uuid.UUID,
    body: RevealRequest,
    response: Response,
    principal: Principal = Depends(admin_bff_only),
    svc: AdminDirectory = Depends(get_admin),
) -> RevealResult:
    actor = principal.require_permission("users.sensitive.read")
    no_user_context(principal)  # ученик — только из пути, сотрудник — только из actor
    result = await svc.reveal(user_id, actor=actor, field=body.field, reason=body.reason)
    response.headers["Cache-Control"] = NO_STORE  # значение не кэшируется ни прокси, ни браузером
    return result


def segment_query(
    ui_lang: list[str] | None = Query(default=None, max_length=32),
    age: list[str] | None = Query(default=None, max_length=32),
    onboarded: str | None = Query(default=None, max_length=8),
    active_days: str | None = Query(default=None, max_length=8),
) -> Segment:
    """CampaignSegment в query: `ui_lang=ru,uz`, `age=teens,adults` (или повтор параметра), `onboarded=true|false`,
    `active_days=±N` (1..90). Пустое значение — фильтр не задан."""
    return parse_segment(ui_lang=ui_lang, age=age, onboarded=onboarded, active_days=active_days)


@audience_router.get("", response_model=AudiencePage)
async def audience_page(
    _: Principal = Depends(notifications_service_call),
    segment: Segment = Depends(segment_query),
    svc: Audience = Depends(get_audience),
    cursor: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=AUDIENCE_MAX_LIMIT, ge=1, le=AUDIENCE_MAX_LIMIT),
) -> AudiencePage:
    return await svc.page(segment, cursor=cursor, limit=limit)


@audience_router.get("/count", response_model=AudienceCount)
async def audience_count(
    _: Principal = Depends(notifications_service_call),
    segment: Segment = Depends(segment_query),
    svc: Audience = Depends(get_audience),
) -> AudienceCount:
    return await svc.count(segment)
