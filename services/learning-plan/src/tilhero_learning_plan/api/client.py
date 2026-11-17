"""Клиентские команды (Mini App → telegram-bff → preferences).

user_id — только из внутреннего токена (sub), никогда из пути или тела (IDOR).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import ApiError, unauthorized, unprocessable
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_learning_plan.domain import profiles
from tilhero_learning_plan.domain.validation import PreferencesInvalid, UnknownAirport, from_pydantic
from tilhero_learning_plan.schemas import DeparturesIn, PreferencesOut, PreferencesPatchIn

# Вызывающие клиентского API. admin-bff (спринт 2) получит отдельный staff-роутер с правами,
# а не доступ к /me.
CLIENT_CALLERS = {"telegram-bff"}


def invalid(exc: PreferencesInvalid) -> ApiError:
    return unprocessable("PREFERENCES_INVALID", "Некорректные предпочтения",
                         {"field": exc.field, "reason": exc.reason, **exc.extra})


class PreferencesRoute(APIRoute):
    """Ошибки формы тела — тоже 422 PREFERENCES_INVALID {field, reason}, а не общий VALIDATION_ERROR."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                return await original(request)
            except RequestValidationError as exc:
                raise invalid(from_pydantic(list(exc.errors()))) from None

        return handler


router = APIRouter(prefix="/internal/v1/me", tags=["client"], route_class=PreferencesRoute)
auth = InternalAuth(CLIENT_CALLERS)


def current_user(principal: Principal = Depends(auth)) -> uuid.UUID:
    try:
        return uuid.UUID(principal.user_id)
    except ValueError:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from None


@router.get("/preferences", response_model=PreferencesOut)
async def get_preferences(user_id: uuid.UUID = Depends(current_user),
                          rt: Runtime = Depends(get_runtime)) -> PreferencesOut:
    async with rt.transaction() as session:
        return profiles.to_public(await profiles.get_or_create(session, user_id))


@router.patch("/preferences", response_model=PreferencesOut,
              responses={409: {"description": "PREFERENCES_VERSION_CONFLICT"},
                         422: {"description": "PREFERENCES_INVALID {field, reason}"}})
async def patch_preferences(body: PreferencesPatchIn, user_id: uuid.UUID = Depends(current_user),
                            rt: Runtime = Depends(get_runtime)) -> PreferencesOut:
    try:
        async with rt.transaction() as session:
            return profiles.to_public(await profiles.apply_patch(session, user_id, body))
    except PreferencesInvalid as exc:
        raise invalid(exc) from None


@router.put("/departures", response_model=PreferencesOut,
            responses={422: {"description": "AIRPORT_UNKNOWN {iata} | PREFERENCES_INVALID {field, reason}"}})
async def put_departures(body: DeparturesIn, user_id: uuid.UUID = Depends(current_user),
                         rt: Runtime = Depends(get_runtime)) -> PreferencesOut:
    try:
        async with rt.transaction() as session:
            return profiles.to_public(await profiles.set_departures(session, user_id, body.airports))
    except UnknownAirport as exc:
        raise unprocessable("AIRPORT_UNKNOWN", "Аэропорт не найден в справочнике",
                            {"iata": exc.iata}) from None
    except PreferencesInvalid as exc:
        raise invalid(exc) from None


@router.post("/onboarding/complete", response_model=PreferencesOut)
async def complete_onboarding(user_id: uuid.UUID = Depends(current_user),
                              rt: Runtime = Depends(get_runtime)) -> PreferencesOut:
    async with rt.transaction() as session:
        return profiles.to_public(await profiles.complete_onboarding(session, user_id))
