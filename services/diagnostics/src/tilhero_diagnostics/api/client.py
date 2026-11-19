"""Клиентское API diagnostics (Mini App → telegram-bff → diagnostics), INTERNAL_API §2.5.

user_id — только из внутреннего токена (sub = активный ученик), никогда из пути или тела (IDOR): чужая сессия или
результат — 404. Ключи ответов наружу не уходят. Сегмент ученика — `?audience=` от telegram-bff (+ проекция
профиля identity-consent, см. domain/users.py).
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, Query, Request, Response
from fastapi.responses import JSONResponse

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unprocessable
from tilhero_diagnostics.api.common import (
    audience_param,
    catalog_of,
    clock_of,
    current_user,
    idempotency_key,
    pair_param,
    seed_factory_of,
    settings_of,
    skill_map_user,
)
from tilhero_diagnostics.domain import sessions as svc
from tilhero_diagnostics.domain import skills as skills_domain
from tilhero_diagnostics.domain.users import ensure_not_deleted
from tilhero_diagnostics.schemas import (
    AnswerIn,
    AnswerResultOut,
    DiagnosticItemOut,
    DiagnosticResultOut,
    DiagnosticSessionOut,
    DiagnosticStateOut,
    DoneOut,
    FollowupIn,
    ResultListOut,
    SessionCreateIn,
    SkillMapOut,
)

router = APIRouter(prefix="/internal/v1", tags=["client"])

_SESSION_ERRORS: dict[int | str, dict[str, Any]] = {
    404: {"description": "DIAGNOSTIC_SESSION_NOT_FOUND"},
    409: {"description": "DIAGNOSTIC_SESSION_EXPIRED | DIAGNOSTIC_SESSION_CLOSED {status}"},
    410: {"description": "USER_DELETED"},
}


async def _available_pair(request: Request, pair_id: str) -> tuple[bool, str]:
    """(пара опубликована, course_id) — по catalog с кешем; catalog недоступен — только пара по умолчанию."""
    info = await catalog_of(request).pair(pair_id)
    s = settings_of(request)
    course = (info.course_id if info else None) or (s.default_course_id if pair_id == s.default_pair_id else "")
    return (info is not None and info.available and bool(course)), course


async def _snapshot_for_pair(request: Request, pair_id: str) -> dict[str, Any] | None:
    _, course = await _available_pair(request, pair_id)
    return await catalog_of(request).snapshot(course) if course else None


@router.get("/diagnostics/state", response_model=DiagnosticStateOut,
            responses={409: {"description": "PAIR_NOT_AVAILABLE {pair_id}"}, 410: {"description": "USER_DELETED"}})
async def get_state(request: Request, pair_id: str = Depends(pair_param),
                    audience: str | None = Depends(audience_param), user_id: uuid.UUID = Depends(current_user),
                    rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    available, _ = await _available_pair(request, pair_id)
    if not available:
        raise svc.pair_not_available(pair_id)
    async with rt.transaction() as session:
        return await svc.state(session, user_id=user_id, pair_id=pair_id, hint=audience, now=clock_of(request)(),
                               retest_override=settings_of(request).diag_retest_days)


@router.post("/diagnostics/sessions", response_model=DiagnosticSessionOut, status_code=201,
             responses={200: {"description": "повтор с тем же Idempotency-Key"},
                        409: {"description": "DIAGNOSTIC_TOO_SOON {next_allowed_at} | PAIR_NOT_AVAILABLE {pair_id}"},
                        410: {"description": "USER_DELETED"},
                        422: {"description": "IDEMPOTENCY_KEY_REUSED | VALIDATION_ERROR"}})
async def create_session(request: Request, body: SessionCreateIn | None = Body(default=None),
                         audience: str | None = Depends(audience_param), user_id: uuid.UUID = Depends(current_user),
                         rt: Runtime = Depends(get_runtime),
                         key: str | None = Header(default=None, alias="Idempotency-Key")) -> JSONResponse:
    ikey = idempotency_key(key)
    pair_id = pair_param(request, body.pair_id if body else None)
    available, _ = await _available_pair(request, pair_id)
    try:
        async with rt.transaction() as session:
            out, replayed = await svc.create_session(
                session, user_id=user_id, pair_id=pair_id, pair_available=available, hint=audience, key=ikey,
                now=clock_of(request)(), retest_override=settings_of(request).diag_retest_days,
                seed_factory=seed_factory_of(request))
    except svc.IdempotencyReused:
        raise unprocessable("IDEMPOTENCY_KEY_REUSED",
                            "Ключ идемпотентности уже использован с другими данными") from None
    payload = DiagnosticSessionOut.model_validate(out).model_dump(mode="json")
    if replayed:
        return JSONResponse(payload, status_code=200, headers={"Idempotent-Replayed": "true"})
    return JSONResponse(payload, status_code=201)


@router.get("/diagnostics/sessions/{session_id}/next", response_model=DiagnosticItemOut | DoneOut,
            responses=_SESSION_ERRORS)
async def get_next(session_id: uuid.UUID, request: Request, user_id: uuid.UUID = Depends(current_user),
                   rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    async with rt.transaction() as session:
        item = await svc.next_item(session, user_id=user_id, session_id=session_id, now=clock_of(request)())
    return item if item is not None else {"done": True}


@router.post("/diagnostics/sessions/{session_id}/answers", response_model=AnswerResultOut,
             responses={**_SESSION_ERRORS,
                        409: {"description": "ITEM_NOT_CURRENT | DIAGNOSTIC_SESSION_EXPIRED | "
                                             "DIAGNOSTIC_SESSION_CLOSED"},
                        422: {"description": "ANSWER_INVALID {field} | VALIDATION_ERROR"}})
async def post_answer(session_id: uuid.UUID, body: AnswerIn, request: Request, response: Response,
                      user_id: uuid.UUID = Depends(current_user), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    async with rt.transaction() as session:
        out, replayed = await svc.submit_answer(
            session, user_id=user_id, session_id=session_id, item_id=body.item_id, answer=body.answer,
            dont_know=body.dont_know, time_ms=body.time_ms, now=clock_of(request)())
    if replayed:
        response.headers["Idempotent-Replayed"] = "true"
    return out


@router.post("/diagnostics/sessions/{session_id}/listening-unavailable", status_code=204,
             responses=_SESSION_ERRORS)
async def post_listening_unavailable(session_id: uuid.UUID, request: Request,
                                     user_id: uuid.UUID = Depends(current_user),
                                     rt: Runtime = Depends(get_runtime)) -> Response:
    async with rt.transaction() as session:
        await svc.listening_unavailable(session, user_id=user_id, session_id=session_id, now=clock_of(request)())
    return Response(status_code=204)


@router.post("/diagnostics/sessions/{session_id}/finish", response_model=DiagnosticResultOut,
             responses={**_SESSION_ERRORS,
                        409: {"description": "DIAGNOSTIC_SESSION_EXPIRED | DIAGNOSTIC_SESSION_CLOSED"},
                        422: {"description": "DIAGNOSTIC_EMPTY — нет ни одного ответа"}})
async def post_finish(session_id: uuid.UUID, request: Request, user_id: uuid.UUID = Depends(current_user),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    # снимок курса — до транзакции: блокировка ученика не держится на время запроса к catalog
    async with rt.transaction() as session:
        await ensure_not_deleted(session, user_id)
        pair_id = (await svc.own_session(session, user_id, session_id)).pair_id
    snapshot = await _snapshot_for_pair(request, pair_id)
    async with rt.transaction() as session:
        return await svc.finish(session, user_id=user_id, session_id=session_id, now=clock_of(request)(),
                                snapshot=snapshot)


@router.post("/diagnostics/results/{result_id}/followup", response_model=DiagnosticSessionOut, status_code=201,
             responses={200: {"description": "незавершённое уточнение той же области"},
                        404: {"description": "DIAGNOSTIC_RESULT_NOT_FOUND"},
                        409: {"description": "FOLLOWUP_NOT_AVAILABLE {area, reason: not_needed | window_closed | "
                                             "already_done | no_items}"},
                        410: {"description": "USER_DELETED"}})
async def post_followup(result_id: uuid.UUID, body: FollowupIn, request: Request,
                        user_id: uuid.UUID = Depends(current_user), rt: Runtime = Depends(get_runtime)) -> JSONResponse:
    async with rt.transaction() as session:
        out, existing = await svc.start_followup(session, user_id=user_id, result_id=result_id, area=body.area,
                                                 now=clock_of(request)())
    return JSONResponse(DiagnosticSessionOut.model_validate(out).model_dump(mode="json"),
                        status_code=200 if existing else 201)


@router.get("/diagnostics/results", response_model=ResultListOut, responses={410: {"description": "USER_DELETED"}})
async def list_results(request: Request, pair_id: str = Depends(pair_param),
                       limit: int = Query(default=50, ge=1, le=100), user_id: uuid.UUID = Depends(current_user),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    async with rt.transaction() as session:
        await ensure_not_deleted(session, user_id)
        rows = await svc.latest_results(session, user_id, pair_id, limit=limit)
    return {"items": [svc.result_out(r) for r in rows]}


@router.get("/diagnostics/results/{result_id}", response_model=DiagnosticResultOut,
            responses={404: {"description": "DIAGNOSTIC_RESULT_NOT_FOUND"}, 410: {"description": "USER_DELETED"}})
async def get_result(result_id: uuid.UUID, revision: int | None = Query(default=None, ge=1, le=100),
                     user_id: uuid.UUID = Depends(current_user), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    async with rt.transaction() as session:
        await ensure_not_deleted(session, user_id)
        return svc.result_out(await svc.result_revision(session, user_id, result_id, revision))


@router.get("/skills/map", response_model=SkillMapOut,
            responses={409: {"description": "PAIR_NOT_AVAILABLE {pair_id}"}, 410: {"description": "USER_DELETED"}})
async def get_skill_map(request: Request, pair_id: str = Depends(pair_param),
                        user_id: uuid.UUID = Depends(skill_map_user),
                        rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    available, course = await _available_pair(request, pair_id)
    if not available:
        raise svc.pair_not_available(pair_id)
    snapshot = await catalog_of(request).snapshot(course)
    async with rt.transaction() as session:
        await ensure_not_deleted(session, user_id)
        return await skills_domain.skill_map(session, user_id, pair_id, course, snapshot)
