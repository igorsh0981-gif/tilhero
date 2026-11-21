"""Выгрузки для разовой загрузки проекций в других доменах (спринт 7, ревью 🔴3; docs/sprint7/INTERNAL_API.md §11).

`GET /internal/v1/export/levels?cursor=<opaque>&limit=1..500` (по умолчанию 500) → `{"items": [...], "next_cursor":
str | null}`. Элемент — ровно payload `diagnostics.completed.v1` (как в событии) последней ревизии последнего
результата каждой пары каждого неудалённого ученика (порядок — user_id, pair_id). Получатели пропускают элементы через
обработчик события. Вызывающие — gamification и lessons (внутренний JWT без ученика); ответы и задания не выгружаются —
только итог (уровень, области, рекомендованный урок).
"""

from __future__ import annotations

import base64
import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, tuple_
from sqlalchemy.dialects.postgresql import distinct_on

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import bad_request
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_diagnostics.domain.sessions import completed_payload
from tilhero_diagnostics.models import DeletedUser, Result

router = APIRouter(prefix="/internal/v1/export", tags=["export"])
export_auth = InternalAuth({"gamification", "lessons"})


def _encode(user_id: uuid.UUID, pair_id: str) -> str:
    raw = json.dumps([str(user_id), pair_id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode(cursor: str) -> tuple[uuid.UUID, str]:
    try:
        parts = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        if not isinstance(parts, list) or len(parts) != 2 or not isinstance(parts[1], str):
            raise ValueError("arity")
        return uuid.UUID(str(parts[0])), parts[1]
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


@router.get("/levels", responses={400: {"description": "INVALID_CURSOR"}, 401: {"description": "INTERNAL_TOKEN_*"},
                                  403: {"description": "CALLER_NOT_ALLOWED"}})
async def export_levels(cursor: str | None = Query(default=None, max_length=500),
                        limit: int = Query(default=500, ge=1, le=500),
                        _: Principal = Depends(export_auth), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Последний результат по каждой паре каждого неудалённого ученика — payload diagnostics.completed.v1."""
    stmt = (select(Result).ext(distinct_on(Result.user_id, Result.pair_id))
            .where(~select(DeletedUser.user_id).where(DeletedUser.user_id == Result.user_id).exists())
            .order_by(Result.user_id, Result.pair_id, Result.created_at.desc(), Result.revision.desc()))
    if cursor is not None:
        after = _decode(cursor)
        stmt = stmt.where(tuple_(Result.user_id, Result.pair_id) > tuple_(after[0], after[1]))
    async with rt.transaction() as db:
        rows = list((await db.execute(stmt.limit(limit + 1))).scalars().all())
    page = rows[:limit]
    nxt = _encode(page[-1].user_id, page[-1].pair_id) if len(rows) > limit else None
    return {"items": [completed_payload(r) for r in page], "next_cursor": nxt}
