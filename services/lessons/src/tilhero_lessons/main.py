"""lessons: оркестратор урока 20 минут (INTERNAL_API §2) — сессии урока, сценария, медиа и повтора, машина
состояний, этапы и шаги, пауза и восстановление, ролевая ситуация по графу сценария, итоги с независимой оценкой."""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_lessons.api.admin import router as admin_router
from tilhero_lessons.api.client import router as client_router
from tilhero_lessons.api.scheduler import router as scheduler_router
from tilhero_lessons.catalog import CATALOG, CatalogGateway
from tilhero_lessons.clients import AI_GATEWAY, ASSESSMENT, DIAGNOSTICS, LEARNING_PLAN
from tilhero_lessons.consumers import (
    DELETION_REQUESTED,
    PROFILE_CREATED,
    PROFILE_UPDATED,
    on_deletion_requested,
    on_profile_event,
)
from tilhero_lessons.settings import Settings, get_settings


def build_app(
    settings: Settings | None = None,
    runtime: Runtime | None = None,
    *,
    transports: dict[str, httpx.AsyncBaseTransport] | None = None,
) -> FastAPI:
    """transports — заглушки доменов в тестах (httpx.MockTransport) по имени: catalog, ai-gateway, assessment,
    learning-plan, diagnostics."""
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    tr = transports or {}

    def configure(rt: Runtime) -> None:
        rt.register_client(CATALOG, settings.catalog_url, timeout=settings.catalog_timeout_seconds,
                           transport=tr.get(CATALOG))
        # ИИ и оценка: без повторов в клиенте (идемпотентность — request_id / session_id; повтор — tick)
        rt.register_client(AI_GATEWAY, settings.ai_gateway_url, timeout=settings.ai_timeout_seconds, retries=0,
                           transport=tr.get(AI_GATEWAY))
        rt.register_client(ASSESSMENT, settings.assessment_url, timeout=settings.assessment_timeout_seconds,
                           retries=0, transport=tr.get(ASSESSMENT))
        rt.register_client(LEARNING_PLAN, settings.learning_plan_url, timeout=settings.aux_timeout_seconds,
                           retries=0, transport=tr.get(LEARNING_PLAN))
        rt.register_client(DIAGNOSTICS, settings.diagnostics_url, timeout=settings.aux_timeout_seconds, retries=0,
                           transport=tr.get(DIAGNOSTICS))
        rt.add_consumer("lessons.user_deletion", [DELETION_REQUESTED], on_deletion_requested)
        rt.add_consumer("lessons.profiles", [PROFILE_CREATED, PROFILE_UPDATED], on_profile_event)

    app = create_app(settings, routers=[client_router, admin_router, scheduler_router], runtime=runtime,
                     configure=configure, title="TilHero lessons-service")
    app.state.catalog = CatalogGateway(runtime)
    return app


app = build_app()
