"""diagnostics: входная диагностика (адаптивный воспроизводимый подбор, профиль навыков с уверенностью и
not_assessed, повтор с ограничением частоты, история), карта навыков ученика по паре (INTERNAL_API §2); спринт 4 —
навыки по оценкам уроков (события assessment)."""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_diagnostics.api.admin import router as admin_router
from tilhero_diagnostics.api.client import router as client_router
from tilhero_diagnostics.catalog import CATALOG, CatalogGateway
from tilhero_diagnostics.consumers import (
    ASSESSMENT_COMPLETED,
    ASSESSMENT_REEVALUATED,
    DELETION_REQUESTED,
    PROFILE_CREATED,
    PROFILE_UPDATED,
    on_assessment,
    on_deletion_requested,
    on_profile_event,
)
from tilhero_diagnostics.settings import Settings, get_settings


def build_app(
    settings: Settings | None = None,
    runtime: Runtime | None = None,
    *,
    catalog_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)

    def configure(rt: Runtime) -> None:
        rt.register_client(CATALOG, settings.catalog_url, timeout=settings.catalog_timeout_seconds,
                           transport=catalog_transport)
        rt.add_consumer("diagnostics.user_deletion", [DELETION_REQUESTED], on_deletion_requested)
        rt.add_consumer("diagnostics.profiles", [PROFILE_CREATED, PROFILE_UPDATED], on_profile_event)
        # спринт 4: карта навыков по оценкам уроков (только от assessment)
        rt.add_consumer("diagnostics.assessment", [ASSESSMENT_COMPLETED, ASSESSMENT_REEVALUATED], on_assessment)

    app = create_app(settings, routers=[client_router, admin_router], runtime=runtime, configure=configure,
                     title="TilHero diagnostics-service")
    app.state.catalog = CatalogGateway(runtime)
    return app


app = build_app()
