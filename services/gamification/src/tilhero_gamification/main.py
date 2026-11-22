"""gamification: реестр XP, тилов и заморозок, уровни, герои и ступени, задания дня, значки, магазин, события недели,
правила игры с версиями (docs/sprint6/INTERNAL_API.md §1); спринт 7 — лиги недели, дуэли, реферальные награды по
кампании, совместные достижения парных уроков (docs/sprint7/INTERNAL_API.md §2). Начисления — по событиям;
синхронно вызывает только social (связь учеников) и lessons (набор заданий дуэли) в командах дуэли; social и
diagnostics — ещё выгрузки для разовой загрузки проекций."""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_gamification import consumers
from tilhero_gamification.api.admin import router as admin_router
from tilhero_gamification.api.admin_social import router as admin_social_router
from tilhero_gamification.api.client import router as client_router
from tilhero_gamification.api.scheduler import router as scheduler_router
from tilhero_gamification.api.social import router as social_router
from tilhero_gamification.api.upload import AssetBodyMiddleware
from tilhero_gamification.clients import DIAGNOSTICS, IDENTITY, LESSONS, SOCIAL
from tilhero_gamification.domain import bootstrap
from tilhero_gamification.settings import Settings, get_settings


def build_app(settings: Settings | None = None, runtime: Runtime | None = None, *,
              transports: dict[str, httpx.AsyncBaseTransport] | None = None) -> FastAPI:
    """transports — заглушки доменов в тестах (httpx.MockTransport) по имени: social, lessons, diagnostics."""
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    tr = transports or {}

    def configure(rt: Runtime) -> None:
        rt.register_client(SOCIAL, settings.social_url, timeout=settings.social_timeout_seconds, retries=1,
                           transport=tr.get(SOCIAL))
        # набор заданий: повтор безопасен (один набор на дуэль) — с Idempotency-Key клиент повторяет сбой сети
        rt.register_client(LESSONS, settings.lessons_url, timeout=settings.lessons_timeout_seconds, retries=1,
                           transport=tr.get(LESSONS))
        # выгрузки для разовой загрузки проекций (полосы уровня); повтор — в самой загрузке (следующий tick)
        rt.register_client(DIAGNOSTICS, settings.diagnostics_url, timeout=settings.diagnostics_timeout_seconds,
                           retries=1, transport=tr.get(DIAGNOSTICS))
        # возраст и согласие родителя для общей лиги (повторное ревью, Н1): social возраст не хранит
        rt.register_client(IDENTITY, settings.identity_consent_url, timeout=settings.identity_consent_timeout_seconds,
                           retries=1, transport=tr.get(IDENTITY))
        consumers.register(rt)
        if settings.projection_bootstrap_on_start:
            rt.on_startup(bootstrap.on_start)

    # маршруты лиг и дуэлей — раньше общих: /duels/stats не должен совпасть с /duels/{duel_id}
    app = create_app(settings, routers=[social_router, admin_social_router, client_router, admin_router,
                                        scheduler_router], runtime=runtime, configure=configure,
                     title="TilHero gamification-service")
    # внешний слой: сырое тело картинки до ASSET_MAX_BYTES только для POST /internal/v1/admin/game/assets
    app.add_middleware(AssetBodyMiddleware, limit=settings.asset_max_bytes)
    return app


app = build_app()
