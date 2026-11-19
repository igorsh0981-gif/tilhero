"""API ученика (Mini App → telegram-bff → assessment), INTERNAL_API §3.3; формы — bff.ts «Спринт 4».

user_id — только из внутреннего токена (sub = активный ученик `lrn`), никогда из пути или тела: чужая оценка — 404.
Верный ответ закрытого задания показывается только там, где ученик ошибся.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse

from tilhero_assessment.api.common import clock_of, current_learner, idempotency_key, key_reused, settings_of
from tilhero_assessment.domain import appeals as svc
from tilhero_assessment.domain.common import IdempotencyReused
from tilhero_assessment.schemas import AppealIn, AppealListOut, AppealOut, EvaluationViewOut
from tilhero_common.app import Runtime, get_runtime

router = APIRouter(prefix="/internal/v1", tags=["learner"])


@router.get("/evaluations/{evaluation_id}", response_model=EvaluationViewOut,
            responses={404: {"description": "EVALUATION_NOT_FOUND"}, 410: {"description": "USER_DELETED"}})
async def get_evaluation(evaluation_id: uuid.UUID, user_id: uuid.UUID = Depends(current_learner),
                         rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    async with rt.transaction() as session:
        return await svc.learner_view(session, user_id, evaluation_id)


@router.post("/evaluations/{evaluation_id}/appeal", response_model=AppealOut, status_code=201,
             responses={200: {"description": "повтор с тем же Idempotency-Key"},
                        400: {"description": "IDEMPOTENCY_KEY_REQUIRED"},
                        404: {"description": "EVALUATION_NOT_FOUND"},
                        409: {"description": "APPEAL_EXISTS {appeal_id} | APPEAL_WINDOW_CLOSED {closed_at} | "
                                             "APPEAL_NOT_ALLOWED (practice_only)"},
                        410: {"description": "USER_DELETED"},
                        422: {"description": "IDEMPOTENCY_KEY_INVALID | IDEMPOTENCY_KEY_REUSED | VALIDATION_ERROR"}})
async def create_appeal(evaluation_id: uuid.UUID, body: AppealIn, request: Request,
                        user_id: uuid.UUID = Depends(current_learner), rt: Runtime = Depends(get_runtime),
                        key: str | None = Header(default=None, alias="Idempotency-Key")) -> JSONResponse:
    ikey = idempotency_key(key)
    assert ikey is not None
    try:
        async with rt.transaction() as session:
            out, created = await svc.create_appeal(
                session, user_id=user_id, evaluation_id=evaluation_id, reason=body.reason, key=ikey,
                now=clock_of(request)(), window_days=settings_of(request).appeal_window_days)
    except IdempotencyReused:
        raise key_reused() from None
    payload = AppealOut.model_validate(out).model_dump(mode="json")
    if created:
        return JSONResponse(payload, status_code=201)
    return JSONResponse(payload, status_code=200, headers={"Idempotent-Replayed": "true"})


@router.get("/appeals", response_model=AppealListOut, responses={410: {"description": "USER_DELETED"}})
async def list_appeals(cursor: str | None = Query(default=None, max_length=300),
                       limit: int = Query(default=20, ge=1, le=100), user_id: uuid.UUID = Depends(current_learner),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    async with rt.transaction() as session:
        return await svc.learner_appeals(session, user_id=user_id, cursor=cursor, limit=limit)
