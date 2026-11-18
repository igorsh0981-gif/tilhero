"""user-admin: read-модель учеников для админки (INTERNAL_API §2)."""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_user_admin.api.internal import router as internal_router
from tilhero_user_admin.api.staff import router as staff_router
from tilhero_user_admin.consumers import CONSUMER, EVENT_TYPES, make_handler
from tilhero_user_admin.domain.sync import IDENTITY_CLIENT, PLANS_CLIENT, Reconciler
from tilhero_user_admin.settings import Settings, get_settings


def build_app(
    settings: Settings | None = None,
    runtime: Runtime | None = None,
    *,
    identity_transport: httpx.AsyncBaseTransport | None = None,
    plans_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    reconciler = Reconciler(runtime)

    def configure(rt: Runtime) -> None:
        rt.register_client(IDENTITY_CLIENT, settings.identity_consent_url, timeout=settings.upstream_timeout_seconds,
                           retries=1, transport=identity_transport)
        rt.register_client(PLANS_CLIENT, settings.learning_plan_url, timeout=settings.upstream_timeout_seconds,
                           retries=1, transport=plans_transport)
        rt.add_consumer(CONSUMER, EVENT_TYPES, make_handler(reconciler))

        async def start_reconcile(r: Runtime) -> None:
            if settings.reconcile_enabled:
                # Фоновые задачи: старт сервиса не ждёт источники и не падает при их сбое
                reconciler.start(r)

        rt.on_startup(start_reconcile)

    app = create_app(settings, routers=[staff_router, internal_router], runtime=runtime, configure=configure,
                     title="TilHero user-admin")
    app.state.reconciler = reconciler
    return app


app = build_app()
