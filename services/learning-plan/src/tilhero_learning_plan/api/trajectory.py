"""Траектория уроков (Mini App «Мой план» → telegram-bff → learning-plan), INTERNAL_API §3, bff.ts Trajectory;
спринт 4 — ещё lessons (следующий урок в итогах урока).

Ученик — только из внутреннего токена (`sub` = активный ученик `lrn`), никогда из запроса (IDOR).
"""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_learning_plan.api.common import clock_of, settings_of, trajectory_user
from tilhero_learning_plan.domain import trajectory
from tilhero_learning_plan.schemas import TrajectoryOut

router = APIRouter(prefix="/internal/v1/plan", tags=["client"])

PAIR_PATTERN = r"^[a-z]{2,8}-[a-z]{2,8}$"


@router.get(
    "/trajectory",
    response_model=TrajectoryOut,
    responses={
        409: {"description": "PAIR_NOT_AVAILABLE {pair_id} — пара не опубликована"},
        410: {"description": "USER_DELETED"},
        503: {"description": "CATALOG_UNAVAILABLE — catalog недоступен и снимка курса в кеше нет"},
    },
)
async def get_trajectory(
    request: Request,
    pair_id: str | None = Query(default=None, max_length=17, pattern=PAIR_PATTERN,
                                description="языковая пара; по умолчанию ru-en"),
    audience: Literal["kids", "teens", "adults"] | None = Query(
        default=None,
        description="сегмент активного ученика (как `audience=` у catalog): BFF знает возраст из профиля; "
                    "без параметра — проекция профиля identity-consent; детский сегмент не понижается",
    ),
    user_id: uuid.UUID = Depends(trajectory_user),
    rt: Runtime = Depends(get_runtime),
) -> TrajectoryOut:
    """→ Trajectory. Входы изменились (диагностика, освоенные навыки, цель/темы плана, сегмент, опубликованный
    курс, пройденные уроки) — новая ревизия + `learning.trajectory.updated.v1`; иначе — последняя ревизия."""
    settings = settings_of(request)
    body = await trajectory.get_trajectory(
        rt, user_id=user_id, pair_id=pair_id or settings.default_pair, audience_hint=audience,
        now=clock_of(request)(),
    )
    return TrajectoryOut.model_validate(body)
