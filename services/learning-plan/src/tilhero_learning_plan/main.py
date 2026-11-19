"""learning-plan: цель, уровень, языки, график занятий и длительность, учёт занятий, plan:tick → напоминания
и пропуски (INTERNAL_API §2); спринт 3 — траектория уроков (INTERNAL_API спринта 3 §3)."""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_learning_plan.api.admin import router as admin_router
from tilhero_learning_plan.api.client import directory_router, plan_router
from tilhero_learning_plan.api.client import router as client_router
from tilhero_learning_plan.api.scheduler import router as scheduler_router
from tilhero_learning_plan.api.trajectory import router as trajectory_router
from tilhero_learning_plan.consumers import CONSUMERS
from tilhero_learning_plan.domain.trajectory import CATALOG
from tilhero_learning_plan.settings import Settings, get_settings


def build_app(
    settings: Settings | None = None,
    runtime: Runtime | None = None,
    *,
    catalog_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    settings = settings or get_settings()

    def configure(runtime: Runtime) -> None:
        # Снимок курса: GET — повтор при сбое сети/5xx (1 раз), дальше — кеш или 503 (траектория не ждёт долго)
        runtime.register_client(CATALOG, settings.catalog_url, timeout=settings.catalog_timeout_seconds, retries=1,
                                transport=catalog_transport)
        for durable, (event_types, handler) in CONSUMERS.items():
            runtime.add_consumer(durable, event_types, handler)

    return create_app(settings, routers=[client_router, plan_router, directory_router, scheduler_router,
                                                admin_router, trajectory_router],
                      runtime=runtime or Runtime(settings), configure=configure,
                      title="TilHero learning-plan-service")


app = build_app()
