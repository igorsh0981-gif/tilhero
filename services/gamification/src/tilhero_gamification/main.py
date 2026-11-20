"""gamification: реестр XP, тилов и заморозок, уровни, герои и ступени, задания дня, значки, магазин, события недели,
правила игры с версиями (docs/sprint6/INTERNAL_API.md §1). Сам никого синхронно не вызывает: начисления — по
событиям; единственное обратное влияние на учёбу — game.streak.frozen.v1 → learning-plan."""

from __future__ import annotations

from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_gamification import consumers
from tilhero_gamification.api.admin import router as admin_router
from tilhero_gamification.api.client import router as client_router
from tilhero_gamification.api.scheduler import router as scheduler_router
from tilhero_gamification.api.upload import AssetBodyMiddleware
from tilhero_gamification.settings import Settings, get_settings


def build_app(settings: Settings | None = None, runtime: Runtime | None = None) -> FastAPI:
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)

    def configure(rt: Runtime) -> None:
        consumers.register(rt)

    app = create_app(settings, routers=[client_router, admin_router, scheduler_router], runtime=runtime,
                     configure=configure, title="TilHero gamification-service")
    # внешний слой: сырое тело картинки до ASSET_MAX_BYTES только для POST /internal/v1/admin/game/assets
    app.add_middleware(AssetBodyMiddleware, limit=settings.asset_max_bytes)
    return app


app = build_app()
