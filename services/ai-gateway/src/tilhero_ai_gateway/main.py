from __future__ import annotations

import logging

import httpx
from fastapi import FastAPI

from tilhero_ai_gateway.api.admin_agents import router as agents_router
from tilhero_ai_gateway.api.admin_costs import router as costs_router
from tilhero_ai_gateway.api.common import now_of
from tilhero_ai_gateway.api.internal import router as internal_router
from tilhero_ai_gateway.consumers import CONSUMER_USER_DELETED, DELETION_REQUESTED, deletion_handler
from tilhero_ai_gateway.domain.versions import fail_stale_runs
from tilhero_ai_gateway.providers import Provider, make_provider
from tilhero_ai_gateway.settings import Settings, get_settings
from tilhero_common.app import Runtime, create_app

log = logging.getLogger("tilhero.ai_gateway")


def build_app(settings: Settings | None = None, runtime: Runtime | None = None, *, provider: Provider | None = None,
              transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    """provider / transport — для тестов (подмена провайдера или транспорта httpx Anthropic)."""
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    ai = provider or make_provider(settings, transport)

    def configure(rt: Runtime) -> None:
        rt.add_consumer(CONSUMER_USER_DELETED, [DELETION_REQUESTED], deletion_handler(rt))

        async def on_start(rt: Runtime) -> None:
            if rt.db is None:
                return
            async with rt.transaction() as session:
                stale = await fail_stale_runs(session, now_of(rt), settings.golden_run_stale_minutes)
            if stale:
                log.warning("stale golden runs marked failed", extra={"runs": stale})

        async def on_stop(_: Runtime) -> None:
            await ai.aclose()

        rt.on_startup(on_start)
        rt.on_shutdown(on_stop)

    app = create_app(settings, routers=[internal_router, agents_router, costs_router], runtime=runtime,
                     configure=configure, title="TilHero ai-gateway")
    app.state.provider = ai
    return app


app = build_app()
