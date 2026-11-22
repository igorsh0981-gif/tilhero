"""social: приглашения (семья, друг, реферал) по deep link, семья, дружба (спринт 1, INTERNAL_API §3); спринт 7 —
профиль сообщества, друзья и заявки, блокировки, жалобы и модерация, рефералы и кампании, связь учеников для
gamification и lessons (INTERNAL_API спринта 7 §1)."""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_social import consumers
from tilhero_social.api.admin import router as admin_router
from tilhero_social.api.export import router as export_router
from tilhero_social.api.internal import router as internal_router
from tilhero_social.api.invites import router as invites_router
from tilhero_social.api.learner import router as learner_router
from tilhero_social.api.scheduler import router as scheduler_router
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
        consumers.register(rt)

    app = create_app(settings, routers=[invites_router, learner_router, internal_router, export_router,
                                        admin_router, scheduler_router],
                     runtime=runtime, configure=configure, title="TilHero social-service")
    app.state.identity = IdentityGateway(runtime)
    return app


app = build_app()
