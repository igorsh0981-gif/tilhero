"""memory: личный словарь и журнал ошибок, интервальные повторения FSRS-5 («Повторение дня»), проверки удержания
7/30 дней, перевод по тапу, произношение через ai-gateway, вечернее напоминание, админка памяти
(docs/sprint5/INTERNAL_API.md §1)."""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_memory import consumers
from tilhero_memory.api.admin import router as admin_router
from tilhero_memory.api.client import router as client_router
from tilhero_memory.api.scheduler import router as scheduler_router
from tilhero_memory.audio import AUDIO_LIMIT, AudioBodyMiddleware
from tilhero_memory.clients import AI_GATEWAY, ASSESSMENT, CATALOG, IDENTITY, CatalogGateway
from tilhero_memory.settings import Settings, get_settings


def build_app(
    settings: Settings | None = None,
    runtime: Runtime | None = None,
    *,
    transports: dict[str, httpx.AsyncBaseTransport] | None = None,
) -> FastAPI:
    """transports — заглушки доменов в тестах (httpx.MockTransport) по имени: catalog, assessment, ai-gateway,
    identity-consent."""
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    tr = transports or {}
    catalog = CatalogGateway(runtime)

    def configure(rt: Runtime) -> None:
        rt.register_client(CATALOG, settings.catalog_url, timeout=settings.catalog_timeout_seconds,
                           transport=tr.get(CATALOG))
        rt.register_client(ASSESSMENT, settings.assessment_url, timeout=settings.assessment_timeout_seconds,
                           transport=tr.get(ASSESSMENT))
        # ИИ и речь: без повторов в клиенте (идемпотентность — request_id); общий таймаут клиента — самый длинный
        # (речь), у статуса и перевода — свои короче (asyncio.timeout в clients.py)
        rt.register_client(AI_GATEWAY, settings.ai_gateway_url, timeout=settings.speech_timeout_seconds + 1,
                           retries=0, transport=tr.get(AI_GATEWAY))
        rt.register_client(IDENTITY, settings.identity_consent_url, timeout=settings.identity_timeout_seconds,
                           transport=tr.get(IDENTITY))
        consumers.register(rt, catalog)

    app = create_app(settings, routers=[client_router, admin_router, scheduler_router], runtime=runtime,
                     configure=configure, title="TilHero memory-service")
    # внешний слой: сырое тело WAV до 600 000 байт только для POST /internal/v1/pronunciation (audio.py)
    app.add_middleware(AudioBodyMiddleware, limit=AUDIO_LIMIT)
    app.state.catalog = catalog
    return app


app = build_app()
