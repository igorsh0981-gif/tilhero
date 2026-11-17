from __future__ import annotations

from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_support.api import client, staff
from tilhero_support.consumers import CONSUMER_USER_DELETED, DELETION_REQUESTED, make_on_user_deleted
from tilhero_support.settings import Settings, get_settings


def build_app(settings: Settings | None = None, runtime: Runtime | None = None) -> FastAPI:
    settings = settings or get_settings()

    def configure(rt: Runtime) -> None:
        rt.add_consumer(
            CONSUMER_USER_DELETED, [DELETION_REQUESTED], make_on_user_deleted(settings.service_name)
        )

    return create_app(
        settings,
        routers=[client.router, staff.router],
        runtime=runtime or Runtime(settings),
        configure=configure,
        title="TilHero support-service",
    )


app = build_app()
