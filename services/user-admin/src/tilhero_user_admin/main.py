from __future__ import annotations

import httpx
from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_user_admin.api.staff import router
from tilhero_user_admin.consumers import CONSUMER, EVENT_TYPES, make_handler
from tilhero_user_admin.domain.sync import IDENTITY_CLIENT, IdentitySync
from tilhero_user_admin.settings import Settings, get_settings


def build_app(
    settings: Settings | None = None,
    runtime: Runtime | None = None,
    *,
    identity_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    sync = IdentitySync(runtime)

    def configure(rt: Runtime) -> None:
        rt.register_client(IDENTITY_CLIENT, settings.identity_url, timeout=settings.identity_timeout_seconds,
                           retries=1, transport=identity_transport)
        rt.add_consumer(CONSUMER, EVENT_TYPES, make_handler(sync))

        async def start_sync(r: Runtime) -> None:
            if settings.sync_enabled:
                # Фоновая задача: старт сервиса не ждёт identity-consent и не падает при его сбое
                r.spawn(sync.run_forever(), "identity-sync")

        rt.on_startup(start_sync)

    app = create_app(settings, routers=[router], runtime=runtime, configure=configure,
                     title="TilHero user-admin")
    app.state.identity_sync = sync
    return app


app = build_app()
