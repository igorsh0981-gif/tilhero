"""Admin API assessment (только admin-bff; права сотрудника из actor проверяются здесь — защита в глубину),
INTERNAL_API §3.4; формы — admin.ts «Контроль диалогов» (сотрудники — id, имена подставляет admin-bff):
qa.read — карточки и цепочки оценок, сводка по сессиям, апелляции, QA-флаг; qa.review — «взять» апелляцию,
переоценка и решение по апелляции (step-up — в admin-bff); dashboard.read или qa.read — статистика обзора."""

from __future__ import annotations

import uuid
from datetime import UTC, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse

from tilhero_assessment.api.common import clock_of, idempotency_key, key_reused, settings_of, staff_auth
from tilhero_assessment.domain import admin as svc
from tilhero_assessment.domain import appeals as appeals_svc
from tilhero_assessment.domain.common import DASHBOARD_READ, QA_READ, QA_REVIEW, IdempotencyReused
from tilhero_assessment.schemas import (
    AdminAppealListOut,
    AdminAppealOut,
    AppealDecisionIn,
    AssessmentStatsOut,
    EvaluationCardOut,
    EvaluationChainOut,
    FlagIn,
    ReevaluationIn,
    SessionSummaryListOut,
)
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import Actor, Principal

router = APIRouter(prefix="/admin/v1", tags=["staff"])

_EVAL_ERRORS: dict[int | str, dict[str, Any]] = {404: {"description": "EVALUATION_NOT_FOUND"}}
_APPEAL_ERRORS: dict[int | str, dict[str, Any]] = {404: {"description": "APPEAL_NOT_FOUND"}}


def _card(payload: dict[str, Any], *, created: bool | None = None) -> JSONResponse:
    body = EvaluationCardOut.model_validate(payload).model_dump(mode="json")
    if created is False:
        return JSONResponse(body, status_code=200, headers={"Idempotent-Replayed": "true"})
    return JSONResponse(body, status_code=201 if created else 200)


# ---------------------------------------------------------------- оценки


@router.get("/evaluations/summary", response_model=SessionSummaryListOut)
async def session_summaries(session_id: list[uuid.UUID] = Query(min_length=1, max_length=svc.MAX_SUMMARY_SESSIONS),
                            principal: Principal = Depends(staff_auth),
                            rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Сводка по сессиям для журнала «Контроля диалогов»: актуальная оценка, зачёт, флаги."""
    principal.require_permission(QA_READ)
    async with rt.transaction() as session:
        return await svc.session_summaries(session, list(dict.fromkeys(session_id)))


@router.get("/evaluations", response_model=EvaluationChainOut)
async def evaluation_chain(session_id: uuid.UUID = Query(), principal: Principal = Depends(staff_auth),
                           rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Цепочка оценок сессии: исходная и переоценки (новая — последней); нет оценки — пустой список."""
    principal.require_permission(QA_READ)
    async with rt.transaction() as session:
        return await svc.session_chain(session, session_id)


@router.get("/evaluations/{evaluation_id}", response_model=EvaluationCardOut, responses=_EVAL_ERRORS)
async def evaluation_card(evaluation_id: uuid.UUID, principal: Principal = Depends(staff_auth),
                          rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    principal.require_permission(QA_READ)
    async with rt.transaction() as session:
        return await svc.get_card(session, evaluation_id)


@router.post("/evaluations/{evaluation_id}/flag", response_model=EvaluationCardOut, status_code=201,
             responses={**_EVAL_ERRORS, 422: {"description": "IDEMPOTENCY_KEY_REUSED | VALIDATION_ERROR"}})
async def flag_evaluation(evaluation_id: uuid.UUID, body: FlagIn, request: Request,
                          principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                          key: str | None = Header(default=None, alias="Idempotency-Key")) -> JSONResponse:
    actor = principal.require_permission(QA_READ)
    ikey = idempotency_key(key, required=False)
    try:
        async with rt.transaction() as session:
            out = await svc.flag(session, actor=actor, evaluation_id=evaluation_id, reason=body.reason, key=ikey,
                                 now=clock_of(request)())
    except IdempotencyReused:
        raise key_reused() from None
    return _card(out, created=True)


@router.post("/evaluations/{evaluation_id}/reevaluate", response_model=EvaluationCardOut, status_code=201,
             responses={200: {"description": "повтор с тем же Idempotency-Key"}, **_EVAL_ERRORS,
                        409: {"description": "EVALUATION_SUPERSEDED {superseded_by} | SELF_REEVALUATION | "
                                             "APPEAL_DECIDED {status}"},
                        422: {"description": "SCORES_INVALID | SKILL_OUTCOMES_INVALID | ERRORS_INVALID | "
                                             "APPEAL_MISMATCH | IDEMPOTENCY_KEY_REUSED | VALIDATION_ERROR"}})
async def reevaluate(evaluation_id: uuid.UUID, body: ReevaluationIn, request: Request,
                     principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                     key: str | None = Header(default=None, alias="Idempotency-Key")) -> JSONResponse:
    actor = principal.require_permission(QA_REVIEW)
    ikey = idempotency_key(key, required=False)
    try:
        async with rt.transaction() as session:
            out, created = await svc.reevaluate(session, actor=actor, evaluation_id=evaluation_id, body=body,
                                                key=ikey, now=clock_of(request)())
    except IdempotencyReused:
        raise key_reused() from None
    return _card(out, created=created)


# ---------------------------------------------------------------- апелляции


@router.get("/appeals", response_model=AdminAppealListOut)
async def list_appeals(status: Literal["new", "in_review", "upheld", "corrected"] | None = None,
                       cursor: str | None = Query(default=None, max_length=300),
                       limit: int = Query(default=20, ge=1, le=100), principal: Principal = Depends(staff_auth),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    principal.require_permission(QA_READ)
    async with rt.transaction() as session:
        return await appeals_svc.list_admin_appeals(session, status=status, cursor=cursor, limit=limit)


@router.get("/appeals/{appeal_id}", response_model=AdminAppealOut, responses=_APPEAL_ERRORS)
async def get_appeal(appeal_id: uuid.UUID, principal: Principal = Depends(staff_auth),
                     rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    principal.require_permission(QA_READ)
    async with rt.transaction() as session:
        return await appeals_svc.get_admin_appeal(session, appeal_id)


@router.post("/appeals/{appeal_id}/take", response_model=AdminAppealOut,
             responses={**_APPEAL_ERRORS, 409: {"description": "APPEAL_DECIDED {status} | APPEAL_ALREADY_TAKEN "
                                                               "{taken_by}"}})
async def take_appeal(appeal_id: uuid.UUID, request: Request, principal: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    actor = principal.require_permission(QA_REVIEW)
    async with rt.transaction() as session:
        return await appeals_svc.take(session, actor=actor, appeal_id=appeal_id, now=clock_of(request)())


@router.post("/appeals/{appeal_id}/decide", response_model=AdminAppealOut,
             responses={**_APPEAL_ERRORS,
                        409: {"description": "APPEAL_DECIDED {status} | APPEAL_HAS_REEVALUATION {new_evaluation_id}"},
                        422: {"description": "NEW_EVALUATION_REQUIRED | NEW_EVALUATION_INVALID | "
                                             "NEW_EVALUATION_NOT_ALLOWED | VALIDATION_ERROR"}})
async def decide_appeal(appeal_id: uuid.UUID, body: AppealDecisionIn, request: Request,
                        principal: Principal = Depends(staff_auth),
                        rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    actor = principal.require_permission(QA_REVIEW)
    async with rt.transaction() as session:
        return await appeals_svc.decide(session, actor=actor, appeal_id=appeal_id, decision=body.decision,
                                        note=body.note, new_evaluation_id=body.new_evaluation_id,
                                        now=clock_of(request)())


# ---------------------------------------------------------------- статистика


def _stats_actor(principal: Principal) -> Actor:
    """Блок обзора (dashboard.read) или QA-аналитик (qa.read)."""
    if principal.actor is not None and DASHBOARD_READ in principal.actor.permissions:
        return principal.actor
    return principal.require_permission(QA_READ)


@router.get("/assessment/stats", response_model=AssessmentStatsOut)
async def stats(request: Request, period: Literal["today", "7d", "30d"] = "today",
                principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    _stats_actor(principal)
    now = clock_of(request)()
    if period == "today":
        tz = ZoneInfo(settings_of(request).stats_timezone)
        since = now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    else:
        since = now - timedelta(days=7 if period == "7d" else 30)
    async with rt.transaction() as session:
        return await svc.stats(session, period=period, since=since)

