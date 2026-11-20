"""API для memory (спринт 5, INTERNAL_API §5): подтверждённые ошибки текста ученика из оценки — источник карточек и
журнала ошибок. Вызывающий — только memory; ученик — `sub` внутреннего токена (user_id из события assessment):
чужая или несуществующая оценка — 404."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request

from tilhero_assessment.api.common import clock_of, learner_of, memory_auth, settings_of
from tilhero_assessment.domain import feed as svc
from tilhero_assessment.schemas import MemoryFeedOut
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import Principal

router = APIRouter(prefix="/internal/v1", tags=["memory"])


@router.get("/evaluations/{evaluation_id}/memory-feed", response_model=MemoryFeedOut,
            responses={401: {"description": "INTERNAL_TOKEN_MISSING | USER_CONTEXT_REQUIRED"},
                       403: {"description": "CALLER_NOT_ALLOWED — вызывающий не memory"},
                       404: {"description": "EVALUATION_NOT_FOUND — нет такой или чужая"},
                       410: {"description": "USER_DELETED"}})
async def memory_feed(evaluation_id: uuid.UUID, request: Request, principal: Principal = Depends(memory_auth),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Актуальная запись цепочки: версии контента, practice_only, superseded_by и ошибки текста ученика
    (`T{n}` / `OA1`; закрытые задания не входят; evidence — null после срока хранения)."""
    user_id = learner_of(principal)
    async with rt.transaction() as session:
        return await svc.memory_feed(session, user_id=user_id, evaluation_id=evaluation_id, now=clock_of(request)(),
                                     evidence_days=settings_of(request).memory_evidence_retention_days)
