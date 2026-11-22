"""Внутренний API для доменов (спринт 7): `POST /internal/v1/duel-sets` — набор заданий дуэли (только gamification,
INTERNAL_API §3.1). Ответ — без заданий и ключей."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_lessons.api.common import catalog_of, clock_of, settings_of
from tilhero_lessons.domain import duels
from tilhero_lessons.schemas import DuelSetIn

router = APIRouter(prefix="/internal/v1", tags=["internal"])
gamification_only = InternalAuth({"gamification"})


@router.post("/duel-sets", status_code=201, responses={
    200: {"description": "повтор на ту же дуэль — тот же набор"},
    403: {"description": "CALLER_NOT_ALLOWED"},
    409: {"description": "DUEL_SET_CONFLICT (набор выдан другим участникам)"},
    410: {"description": "USER_DELETED"},
    422: {"description": "VALIDATION_ERROR"},
    503: {"description": "DUEL_SET_UNAVAILABLE (catalog недоступен или мало заданий)"}})
async def create_duel_set(body: DuelSetIn, request: Request,
                          _: Principal = Depends(gamification_only)) -> JSONResponse:
    """{set_id, duel_id, pair_id, level_band, items_total, play_deadline} — 10 закрытых заданий пары и полосы."""
    settings = settings_of(request)
    ds, replayed = await duels.create_set(
        request.app.state.runtime, catalog_of(request), settings, clock_of(request)(), duel_id=body.duel_id,
        pair_id=body.pair_id, level_band=body.level_band, user_ids=list(body.user_ids),
        play_deadline=body.play_deadline)
    view: dict[str, Any] = duels.set_view(ds)
    return JSONResponse(view, status_code=200 if replayed else 201,
                        headers={"Idempotent-Replayed": "true"} if replayed else None)
