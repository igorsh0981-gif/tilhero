"""Справочники для онбординга и профиля: аэропорты, интересы, география. Контекст пользователя не нужен."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_learning_plan.api.client import CLIENT_CALLERS
from tilhero_learning_plan.directory import airports
from tilhero_learning_plan.directory.geo import geo_options
from tilhero_learning_plan.directory.taxonomy import interest_items
from tilhero_learning_plan.schemas import AirportList, AirportOut, GeoOptionList, InterestList

router = APIRouter(prefix="/internal/v1/directory", tags=["directory"])
auth = InternalAuth(CLIENT_CALLERS)


@router.get("/airports", response_model=AirportList)
async def search_airports(
    _: Principal = Depends(auth),
    q: str | None = Query(default=None, max_length=60, description="город, IATA, страна или название; RU/EN"),
    limit: int = Query(default=20, ge=1, le=50),
) -> AirportList:
    return AirportList(items=[AirportOut(**a.public()) for a in airports.search(q, limit)])


@router.get("/interests", response_model=InterestList)
async def list_interests(_: Principal = Depends(auth)) -> InterestList:
    return InterestList.model_validate({"items": interest_items()})


@router.get("/geographies", response_model=GeoOptionList)
async def list_geographies(_: Principal = Depends(auth)) -> GeoOptionList:
    return GeoOptionList.model_validate({"items": geo_options()})
