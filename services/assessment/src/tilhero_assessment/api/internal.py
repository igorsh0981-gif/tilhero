"""Оценка сессии для lessons (INTERNAL_API §3.2): `POST /internal/v1/evaluations`, идемпотентно по session_id.

Вызывающий — только lessons; ученик — `sub` внутреннего токена (body.user_id, если передан, должен совпадать).
Ответ — EvaluationView + session_id, skill_outcomes, requires_human_review: 201 — новая оценка, 200 — повтор
(актуальная запись цепочки, заголовок Idempotent-Replayed, без новых событий и вызовов ИИ).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from tilhero_assessment.api.common import clock_of, content_of, evaluator_of, learner_of, lessons_auth, settings_of
from tilhero_assessment.domain import evaluate as svc
from tilhero_assessment.domain.users import ensure_not_deleted
from tilhero_assessment.evaluator import EvaluatorBusy
from tilhero_assessment.schemas import EvaluationRequestIn, EvaluationResultOut
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unavailable, unprocessable
from tilhero_common.internal_auth import Principal

router = APIRouter(prefix="/internal/v1", tags=["lessons"])


def _response(payload: dict, *, created: bool) -> JSONResponse:
    body = EvaluationResultOut.model_validate(payload).model_dump(mode="json")
    if created:
        return JSONResponse(body, status_code=201)
    return JSONResponse(body, status_code=200, headers={"Idempotent-Replayed": "true"})


@router.post("/evaluations", response_model=EvaluationResultOut, status_code=201,
             responses={200: {"description": "повтор по session_id — актуальная запись цепочки"},
                        409: {"description": "SESSION_CONFLICT — оценка сессии принадлежит другому ученику"},
                        410: {"description": "USER_DELETED"},
                        422: {"description": "USER_MISMATCH | CONTENT_REFS_INVALID {reason} | CONTENT_REF_INVALID "
                                             "{kind, key, version} | ANSWERS_INVALID {reason, item_id?} | "
                                             "TURNS_INVALID {reason} | OUTCOME_INVALID | VALIDATION_ERROR"},
                        503: {"description": "CATALOG_UNAVAILABLE | CATALOG_INVALID_RESPONSE — оценка невозможна; "
                                             "EVALUATION_IN_PROGRESS — оценщик этой сессии ещё работает в другом "
                                             "запросе (повторить позже, partial не записан)"}})
async def create_evaluation(body: EvaluationRequestIn, request: Request,
                            principal: Principal = Depends(lessons_auth),
                            rt: Runtime = Depends(get_runtime)) -> JSONResponse:
    user_id = learner_of(principal)
    if body.user_id is not None and body.user_id != user_id:
        raise unprocessable("USER_MISMATCH", "Ученик запроса не совпадает с учеником токена")
    async with rt.transaction() as session:
        await ensure_not_deleted(session, user_id)
        replay = await svc.existing_result(session, body.session_id, user_id)
    if replay is not None:
        return _response(replay, created=False)
    # внешние вызовы — вне транзакции: блокировки не держатся на время catalog и ИИ
    plan = await svc.resolve(content_of(request), body)
    svc.validate_request(body, plan)
    ai = None
    if svc.needs_evaluator(body):
        try:
            ai = await evaluator_of(request).evaluate(
                session_id=body.session_id, session_kind=body.kind, user_id=user_id, audience=body.audience,
                locale=body.locale, context=svc.evaluator_context(body, plan))
        except EvaluatorBusy:
            # тот же вызов оценщика ещё идёт (повтор finish / tick) — не записываем partial: 503, lessons повторит
            raise unavailable("EVALUATION_IN_PROGRESS", "Оценка этой сессии ещё выполняется — повторите позже",
                              {"service": "ai-gateway"}) from None
    computed = svc.compute(body, plan, ai, min_confidence=settings_of(request).evaluator_min_confidence)
    async with rt.transaction() as session:
        payload, created = await svc.persist(session, body, user_id, plan, computed, clock_of(request)())
    return _response(payload, created=created)
