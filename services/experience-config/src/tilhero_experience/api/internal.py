"""Чтение текущей конфигурации сервисами (telegram-bff — для Mini App, admin-bff — для админки, спринт 2)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_experience.api.common import app_param, cache_of, dumps
from tilhero_experience.domain.service import config_not_found, current_config
from tilhero_experience.schemas import AdminExperienceConfig, MiniAppExperienceConfig

router = APIRouter(prefix="/internal/v1/experience", tags=["internal"])
readers = InternalAuth({"telegram-bff", "admin-bff"})


@router.get("/{app}/current", response_model=MiniAppExperienceConfig | AdminExperienceConfig,
            responses={404: {"description": "EXPERIENCE_CONFIG_NOT_FOUND | EXPERIENCE_APP_UNKNOWN"}})
async def get_current(_: Principal = Depends(readers), app: str = Depends(app_param),
                      rt: Runtime = Depends(get_runtime)) -> Response:
    cache = cache_of(rt)
    cached = await cache.get(app)
    if cached is not None:
        return Response(cached, media_type="application/json", headers={"x-cache": "hit"})
    async with rt.transaction() as session:
        state = await current_config(session, app)
    if state is None:
        raise config_not_found()
    seq, config = state
    body = dumps(config)
    await cache.put(app, seq, body)
    return Response(body, media_type="application/json", headers={"x-cache": "miss"})
