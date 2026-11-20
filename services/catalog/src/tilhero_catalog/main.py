from __future__ import annotations

from fastapi import FastAPI

from tilhero_catalog.api.admin_content import router as content_router
from tilhero_catalog.api.admin_glossary import router as glossary_router
from tilhero_catalog.api.admin_languages import router as languages_router
from tilhero_catalog.api.internal import router as internal_router
from tilhero_catalog.api.scheduler import router as scheduler_router
from tilhero_catalog.api.upload import UploadBodyMiddleware
from tilhero_catalog.consumers import CONSUMER_USER_DELETED, DELETION_REQUESTED, on_user_deleted
from tilhero_catalog.settings import Settings, get_settings
from tilhero_common.app import Runtime, create_app


def configure(runtime: Runtime) -> None:
    runtime.add_consumer(CONSUMER_USER_DELETED, [DELETION_REQUESTED], on_user_deleted)


def build_app(settings: Settings | None = None, runtime: Runtime | None = None) -> FastAPI:
    settings = settings or get_settings()
    routers = [scheduler_router, internal_router, content_router, glossary_router, languages_router]
    app = create_app(settings, routers=routers, runtime=runtime or Runtime(settings), configure=configure,
                     title="TilHero catalog-service")
    # внешний слой: тело ≤ 4,5 МБ только у загрузки аудио (общий лимит 256 КБ остаётся для остальных маршрутов)
    app.add_middleware(UploadBodyMiddleware)
    return app


app = build_app()
