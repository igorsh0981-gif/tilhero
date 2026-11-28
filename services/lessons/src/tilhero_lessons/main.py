"""lessons: оркестратор урока 20 минут (INTERNAL_API §2) — сессии урока, сценария, медиа и повтора, машина
состояний, этапы и шаги, пауза и восстановление, ролевая ситуация по графу сценария, итоги с независимой оценкой;
спринт 7 — задания дуэли и парные комнаты с ИИ-коучем (INTERNAL_API спринта 7 §3); спринт 8 — удержание и
списание ИИ-минут по подписке (billing, INTERNAL_API спринта 8 §5)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_common.messaging import Envelope
from tilhero_lessons.api.admin import router as admin_router
from tilhero_lessons.api.client import router as client_router
from tilhero_lessons.api.internal import router as internal_router
from tilhero_lessons.api.rooms_admin import router as rooms_admin_router
from tilhero_lessons.api.scheduler import router as scheduler_router
from tilhero_lessons.api.social import router as social_router
from tilhero_lessons.audio import AUDIO_LIMIT, AudioBodyMiddleware
from tilhero_lessons.catalog import CATALOG, CatalogGateway
from tilhero_lessons.clients import AI_GATEWAY, ASSESSMENT, BILLING, DIAGNOSTICS, IDENTITY, LEARNING_PLAN, SOCIAL
from tilhero_lessons.consumers import (
    DELETION_REQUESTED,
    DUEL_FINISHED,
    PROFILE_CREATED,
    PROFILE_UPDATED,
    SOCIAL_BLOCK_CHANGED,
    SOCIAL_PROFILE_UPDATED,
    SOCIAL_SANCTION_CHANGED,
    duel_handler,
    on_deletion_requested,
    on_profile_event,
    social_handler,
)
from tilhero_lessons.domain.pair import RoomHub
from tilhero_lessons.settings import Settings, get_settings


def build_app(
    settings: Settings | None = None,
    runtime: Runtime | None = None,
    *,
    transports: dict[str, httpx.AsyncBaseTransport] | None = None,
) -> FastAPI:
    """transports — заглушки доменов в тестах (httpx.MockTransport) по имени: catalog, ai-gateway, assessment,
    learning-plan, diagnostics, social, identity-consent, billing."""
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    tr = transports or {}
    hub = RoomHub()
    holder: dict[str, Any] = {}

    def clock() -> datetime:
        app_ = holder.get("app")
        custom = getattr(app_.state, "clock", None) if app_ is not None else None
        return custom() if custom is not None else datetime.now(UTC)

    async def deletion(session: Any, env: Envelope) -> None:
        await on_deletion_requested(session, env, now=clock(), settings=settings)

    async def stop_jobs(_: Runtime) -> None:  # оценка участников комнат — фоном; недоделанное повторит tick
        if hub.jobs:
            _done, pending = await asyncio.wait(list(hub.jobs), timeout=5)
            for task in pending:
                task.cancel()

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
        # спринт 7: social — связь учеников, member_id → user_id; identity-consent — согласие на голос
        rt.register_client(SOCIAL, settings.social_url, timeout=settings.social_timeout_seconds, retries=1,
                           transport=tr.get(SOCIAL))
        rt.register_client(IDENTITY, settings.identity_consent_url, timeout=settings.identity_timeout_seconds,
                           retries=1, transport=tr.get(IDENTITY))
        # спринт 8: billing — удержания и доступ; без повторов в клиенте (общий срок 2 с — clients._billing_call)
        rt.register_client(BILLING, settings.billing_url, timeout=settings.billing_timeout_seconds, retries=0,
                           transport=tr.get(BILLING))
        rt.add_consumer("lessons.user_deletion", [DELETION_REQUESTED], deletion)
        rt.add_consumer("lessons.profiles", [PROFILE_CREATED, PROFILE_UPDATED], on_profile_event)
        rt.add_consumer("lessons.social", [SOCIAL_PROFILE_UPDATED, SOCIAL_BLOCK_CHANGED, SOCIAL_SANCTION_CHANGED],
                        social_handler(clock))
        rt.add_consumer("lessons.duels", [DUEL_FINISHED], duel_handler(clock, settings))
        rt.on_shutdown(stop_jobs)

    app = create_app(settings, routers=[client_router, social_router, internal_router, admin_router,
                                        rooms_admin_router, scheduler_router], runtime=runtime,
                     configure=configure, title="TilHero lessons-service")
    # внешний слой: сырое тело WAV до 600 000 байт только для POST /internal/v1/me/pair-rooms/{id}/audio (audio.py)
    app.add_middleware(AudioBodyMiddleware, limit=AUDIO_LIMIT)
    app.state.catalog = CatalogGateway(runtime)
    app.state.room_hub = hub
    holder["app"] = app
    return app


app = build_app()
