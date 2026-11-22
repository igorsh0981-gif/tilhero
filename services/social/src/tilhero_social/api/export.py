"""Внутренние выгрузки (§1.6): `GET /internal/v1/export/{name}?cursor=&limit=` — только gamification и lessons."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import not_found
from tilhero_common.internal_auth import Principal
from tilhero_social.api.common import domain_auth
from tilhero_social.domain.exports import EXPORTS

router = APIRouter(prefix="/internal/v1", tags=["internal"])


@router.get("/export/{name}", responses={401: {"description": "INTERNAL_TOKEN_*"},
                                         403: {"description": "CALLER_NOT_ALLOWED"},
                                         404: {"description": "EXPORT_NOT_FOUND"},
                                         400: {"description": "INVALID_CURSOR"}})
async def export(name: str, cursor: str | None = Query(default=None, max_length=500),
                 limit: int = Query(default=500, ge=1, le=1000), _: Principal = Depends(domain_auth),
                 rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """{items: [payload события], next_cursor}: families (social.family.member_added.v1), friendships
    (social.friendship.changed.v1, status added)."""
    loader = EXPORTS.get(name)
    if loader is None:
        raise not_found("EXPORT_NOT_FOUND", "Выгрузка не найдена")
    async with rt.transaction() as session:
        items, next_cursor = await loader(session, cursor, limit)
    return {"items": items, "next_cursor": next_cursor}
