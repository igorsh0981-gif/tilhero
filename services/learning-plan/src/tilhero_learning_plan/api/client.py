"""Клиентские команды learning-plan (Mini App → telegram-bff → learning-plan), INTERNAL_API §2.

user_id — только из внутреннего токена (sub = активный ученик), никогда из пути или тела (IDOR).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Coroutine
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unprocessable
from tilhero_common.internal_auth import Principal
from tilhero_learning_plan.api.common import client_auth, clock_of, current_user, idempotency_key, settings_of
from tilhero_learning_plan.directory import GOALS, TOPICS
from tilhero_learning_plan.domain import plans
from tilhero_learning_plan.domain.schedule import PlanInvalid
from tilhero_learning_plan.models import Plan
from tilhero_learning_plan.schemas import (
    ActivityIn,
    DirectoryOut,
    LearningPlanOut,
    PlanPatchIn,
    TodayPlanOut,
)

_REASONS = {"extra_forbidden": "unknown_field", "missing": "required"}


def _from_pydantic(errors: list[dict[str, Any]]) -> PlanInvalid:
    err = errors[0] if errors else {}
    loc = [str(p) for p in err.get("loc", ()) if not isinstance(p, int)]
    if loc and loc[0] == "body":
        loc = loc[1:]
    field = ".".join(loc) or "body"
    kind = str(err.get("type", "invalid"))
    return PlanInvalid(field[:80], _REASONS.get(kind, kind)[:40])


class PlanRoute(APIRoute):
    """Ошибки формы тела правки плана — тоже 422 PLAN_INVALID {field, reason}, а не общий VALIDATION_ERROR."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                return await original(request)
            except RequestValidationError as exc:
                raise plans.plan_invalid(_from_pydantic(list(exc.errors()))) from None

        return handler


router = APIRouter(prefix="/internal/v1/me", tags=["client"])
plan_router = APIRouter(prefix="/internal/v1/me", tags=["client"], route_class=PlanRoute)
directory_router = APIRouter(prefix="/internal/v1/directory", tags=["client"])


def _with_etag(response: Response, p: Plan) -> LearningPlanOut:
    response.headers["ETag"] = f'"{p.version}"'
    return plans.to_public(p)


@router.get("/plan", response_model=LearningPlanOut)
async def get_plan(
    request: Request,
    response: Response,
    tz: str | None = Query(default=None, max_length=64),
    user_id: uuid.UUID = Depends(current_user),
    rt: Runtime = Depends(get_runtime),
) -> LearningPlanOut:
    timezone = plans.resolve_timezone(tz, settings_of(request).default_timezone)
    async with rt.transaction() as session:
        return _with_etag(response, await plans.get_or_create(session, user_id, timezone))


@plan_router.patch("/plan", response_model=LearningPlanOut,
                   responses={409: {"description": "PLAN_VERSION_CONFLICT {current_version}"},
                              422: {"description": "PLAN_INVALID {field, reason}"}})
async def patch_plan(
    body: PlanPatchIn,
    request: Request,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match", max_length=32),
    user_id: uuid.UUID = Depends(current_user),
    rt: Runtime = Depends(get_runtime),
) -> LearningPlanOut:
    settings = settings_of(request)
    version = plans.parse_if_match(if_match)
    try:
        async with rt.transaction() as session:
            p = await plans.apply_patch(session, user_id, body, if_match=version,
                                        default_tz=plans.resolve_timezone(None, settings.default_timezone),
                                        now=clock_of(request)(), producer=settings.service_name)
            return _with_etag(response, p)
    except PlanInvalid as exc:
        raise plans.plan_invalid(exc) from None


@router.post("/plan/onboarding/complete", response_model=LearningPlanOut,
             responses={409: {"description": "PLAN_INCOMPLETE {missing}"}})
async def complete_onboarding(
    request: Request,
    response: Response,
    user_id: uuid.UUID = Depends(current_user),
    rt: Runtime = Depends(get_runtime),
) -> LearningPlanOut:
    settings = settings_of(request)
    async with rt.transaction() as session:
        p = await plans.complete_onboarding(session, user_id,
                                            default_tz=plans.resolve_timezone(None, settings.default_timezone),
                                            now=clock_of(request)(), producer=settings.service_name)
        return _with_etag(response, p)


@router.get("/plan/today", response_model=TodayPlanOut)
async def get_today(
    request: Request,
    user_id: uuid.UUID = Depends(current_user),
    rt: Runtime = Depends(get_runtime),
) -> TodayPlanOut:
    timezone = plans.resolve_timezone(None, settings_of(request).default_timezone)
    async with rt.transaction() as session:
        p = await plans.get_or_create(session, user_id, timezone)
        return TodayPlanOut.model_validate(await plans.today_for(session, p, clock_of(request)()))


@router.post("/activities", response_model=TodayPlanOut,
             responses={400: {"description": "IDEMPOTENCY_KEY_REQUIRED"},
                        422: {"description": "ACTIVITY_INVALID | IDEMPOTENCY_KEY_INVALID | IDEMPOTENCY_KEY_REUSED"}})
async def record_activity(
    body: ActivityIn,
    request: Request,
    response: Response,
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
    user_id: uuid.UUID = Depends(current_user),
    rt: Runtime = Depends(get_runtime),
) -> TodayPlanOut:
    key = idempotency_key(idem)
    settings = settings_of(request)
    now: datetime = clock_of(request)()
    try:
        async with rt.transaction() as session:
            p, replayed = await plans.record_activity(
                session, user_id, body, key=key,
                default_tz=plans.resolve_timezone(None, settings.default_timezone), now=now,
                max_age=timedelta(days=settings.activity_max_age_days),
                future_skew=timedelta(seconds=settings.activity_future_skew_seconds),
                producer=settings.service_name,
            )
            today = await plans.today_for(session, p, now)
    except plans.IdempotencyReused:
        raise unprocessable("IDEMPOTENCY_KEY_REUSED",
                            "Ключ идемпотентности уже использован с другими данными") from None
    if replayed:
        response.headers["Idempotent-Replayed"] = "true"
    return TodayPlanOut.model_validate(today)


@directory_router.get("/goals", response_model=DirectoryOut)
async def goals(_: Principal = Depends(client_auth)) -> DirectoryOut:
    return DirectoryOut.model_validate({"items": list(GOALS)})


@directory_router.get("/topics", response_model=DirectoryOut)
async def topics(_: Principal = Depends(client_auth)) -> DirectoryOut:
    return DirectoryOut.model_validate({"items": list(TOPICS)})
