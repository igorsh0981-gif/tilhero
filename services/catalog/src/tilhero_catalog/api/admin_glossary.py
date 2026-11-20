"""Admin API словаря курса (INTERNAL_API §2.5, admin.ts «Память, словарь курса, чтение»): только admin-bff с actor;
права — здесь, в домене: content.read — список, карточка; glossary.manage — создание, правка, решение по переводу
ИИ, архив (без step-up: правка действует сразу, каждая — в истории статьи и в аудите glossary.entry_*);
dashboard.read | content.read — счётчики (`/stats`: очередь переводов ИИ для обзора, MemoryStats.ai_glosses_pending).
Имена сотрудников (*_name) дополняет admin-bff по id (updated_by, history[].by).
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Header, Query, Response
from fastapi.responses import JSONResponse

from tilhero_catalog.api.common import IdempotencyKey, idempotent, now_of, require_any, staff_auth
from tilhero_catalog.content import GlossaryReviewStatus, GlossarySource
from tilhero_catalog.domain import glossary
from tilhero_catalog.domain.common import CONTENT_READ, DASHBOARD_READ, GLOSSARY_MANAGE
from tilhero_catalog.schemas import (
    PAIR_PATTERN,
    GlossaryArchiveIn,
    GlossaryCreateIn,
    GlossaryPatchIn,
    GlossaryReviewIn,
)
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import Principal

router = APIRouter(prefix="/admin/v1/glossary", tags=["staff"])


@router.get("")
async def list_entries(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                       pair_id: str | None = Query(default=None, pattern=PAIR_PATTERN),
                       q: str | None = Query(default=None, max_length=100),
                       source: GlossarySource | None = Query(default=None),
                       review_status: GlossaryReviewStatus | None = Query(default=None),
                       archived: bool = Query(default=False),
                       limit: int = Query(default=20, ge=1, le=100),
                       cursor: str | None = Query(default=None, max_length=300)) -> dict:
    """Page<GlossaryRow>. Очередь переводов ИИ — review_status=pending (по числу мест в контенте)."""
    principal.require_permission(CONTENT_READ)
    async with rt.transaction() as session:
        return await glossary.admin_list(session, pair_id=pair_id, q=(q or "").strip() or None, source=source,
                                         review_status=review_status, archived=archived, cursor=cursor, limit=limit)


@router.get("/stats")
async def glossary_stats(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                         pair_id: str | None = Query(default=None, pattern=PAIR_PATTERN)) -> dict:
    """{pair_id, ai_glosses_pending, ai_approved, ai_rejected, entries: {course, methodist, ai}, overridden}."""
    require_any(principal, DASHBOARD_READ, CONTENT_READ)
    async with rt.transaction() as session:
        return await glossary.stats(session, pair_id)


@router.post("", status_code=201, responses={409: {"description": "FORM_TAKEN {entry_id, form}"},
                                             422: {"description": "GLOSSARY_INVALID {errors}"}})
async def create_entry(body: GlossaryCreateIn, principal: Principal = Depends(staff_auth),
                       rt: Runtime = Depends(get_runtime),
                       idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    """Статья методиста → GlossaryDetail."""
    actor = principal.require_permission(GLOSSARY_MANAGE)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            row = await glossary.create(session, body, actor, now_of(rt))
            return 201, await glossary.detail_view(session, row)

    return await idempotent(rt, scope=f"{actor.id}:glossary:create", key=idempotency_key,
                            request=body.model_dump(mode="json"), run=run)


@router.get("/{entry_id}", responses={404: {"description": "GLOSSARY_ENTRY_NOT_FOUND"}})
async def get_entry(entry_id: uuid.UUID, principal: Principal = Depends(staff_auth),
                    rt: Runtime = Depends(get_runtime)) -> dict:
    """GlossaryDetail: статья, места в контенте, история, конфликты переводов."""
    principal.require_permission(CONTENT_READ)
    async with rt.transaction() as session:
        return await glossary.detail_view(session, await glossary.get_entry(session, entry_id))


@router.patch("/{entry_id}",
              responses={409: {"description": "VERSION_CONFLICT {updated_at} | FORM_TAKEN | ENTRY_ARCHIVED"},
                         422: {"description": "GLOSSARY_INVALID {errors}"},
                         428: {"description": "IF_MATCH_REQUIRED"}})
async def patch_entry(entry_id: uuid.UUID, body: GlossaryPatchIn, principal: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime),
                      if_match: str | None = Header(default=None, alias="If-Match", max_length=64)) -> dict:
    """methodist и ai — поля; course — только override (null — снять). If-Match = updated_at статьи."""
    actor = principal.require_permission(GLOSSARY_MANAGE)
    async with rt.transaction() as session:
        row = await glossary.patch(session, entry_id, body, if_match, actor, now_of(rt))
        return await glossary.detail_view(session, row)


@router.post("/{entry_id}/review", responses={409: {"description": "NOT_PENDING"},
                                              422: {"description": "GLOSSARY_INVALID"}})
async def review_entry(entry_id: uuid.UUID, body: GlossaryReviewIn, principal: Principal = Depends(staff_auth),
                       rt: Runtime = Depends(get_runtime),
                       idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    """Решение по переводу ИИ: approve | correct {gloss} | reject."""
    actor = principal.require_permission(GLOSSARY_MANAGE)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            row = await glossary.review(session, entry_id, body, actor, now_of(rt))
            return 200, await glossary.detail_view(session, row)

    return await idempotent(rt, scope=f"{actor.id}:glossary:review:{entry_id}", key=idempotency_key,
                            request=body.model_dump(mode="json"), run=run)


@router.delete("/{entry_id}", status_code=204, responses={409: {"description": "ARCHIVE_NOT_ALLOWED {source}"}})
async def archive_entry(entry_id: uuid.UUID, body: GlossaryArchiveIn, principal: Principal = Depends(staff_auth),
                        rt: Runtime = Depends(get_runtime)) -> Response:
    """Архив статьи методиста (формы освобождаются); повтор — 204 без изменений."""
    actor = principal.require_permission(GLOSSARY_MANAGE)
    async with rt.transaction() as session:
        await glossary.archive(session, entry_id, body.reason, actor, now_of(rt))
    return Response(status_code=204)
