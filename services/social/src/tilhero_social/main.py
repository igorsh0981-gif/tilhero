"""social: приглашения (семья, друг, реферал) по deep link, семья, дружба через приглашение, invites:tick
(INTERNAL_API §3)."""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_social.api.invites import router as invites_router
from tilhero_social.api.scheduler import router as scheduler_router
from tilhero_social.consumers import (
    DELETION_REQUESTED,
    PROFILE_CREATED,
    PROFILE_UPDATED,
    on_deletion_requested,
    on_profile_event,
)
from tilhero_social.identity import IDENTITY, IdentityGateway
from tilhero_social.settings import Settings, get_settings


def build_app(
    settings: Settings | None = None,
    runtime: Runtime | None = None,
    *,
    identity_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)

    def configure(rt: Runtime) -> None:
        rt.register_client(IDENTITY, settings.identity_consent_url, transport=identity_transport)
        rt.add_consumer("social.user_deletion", [DELETION_REQUESTED], on_deletion_requested)
        rt.add_consumer("social.profiles", [PROFILE_CREATED, PROFILE_UPDATED], on_profile_event)

    app = create_app(settings, routers=[invites_router, scheduler_router], runtime=runtime, configure=configure,
                     title="TilHero social-service")
    app.state.identity = IdentityGateway(runtime)
    return app


app = build_app()
