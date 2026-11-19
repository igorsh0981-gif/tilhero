"""assessment: независимая оценка по рубрике (закрытые задания — правилами по ключам catalog, свободный текст —
независимым оценщиком через ai-gateway), исходы навыков, переоценка, апелляции, QA (INTERNAL_API §3)."""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tilhero_assessment.api.admin import router as admin_router
from tilhero_assessment.api.client import router as client_router
from tilhero_assessment.api.internal import router as internal_router
from tilhero_assessment.api.scheduler import router as scheduler_router
from tilhero_assessment.consumers import DELETION_REQUESTED, on_deletion_requested
from tilhero_assessment.content import CATALOG, ContentGateway
from tilhero_assessment.evaluator import AI_GATEWAY, EvaluatorGateway
from tilhero_assessment.settings import Settings, get_settings
from tilhero_common.app import Runtime, create_app


def build_app(
    settings: Settings | None = None,
    runtime: Runtime | None = None,
    *,
    catalog_transport: httpx.AsyncBaseTransport | None = None,
    ai_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)

    def configure(rt: Runtime) -> None:
        rt.register_client(CATALOG, settings.catalog_url, timeout=settings.catalog_timeout_seconds,
                           transport=catalog_transport)
        # ИИ: без повторов (идемпотентность — request_id у ai-gateway; дедлайн шлюзу — таймаут − 1 с)
        rt.register_client(AI_GATEWAY, settings.ai_gateway_url, timeout=settings.ai_gateway_timeout_seconds,
                           retries=0, transport=ai_transport)
        rt.add_consumer("assessment.user_deletion", [DELETION_REQUESTED], on_deletion_requested)

    app = create_app(settings, routers=[internal_router, client_router, admin_router, scheduler_router],
                     runtime=runtime, configure=configure, title="TilHero assessment-service")
    app.state.content = ContentGateway(runtime, max_entries=settings.content_cache_size)
    app.state.evaluator = EvaluatorGateway(runtime, timeout_seconds=settings.ai_gateway_timeout_seconds)
    return app


app = build_app()
