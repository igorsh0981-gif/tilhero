from __future__ import annotations

from tilhero_common.app import Runtime, create_app
from tilhero_experience.api.internal import router as internal_router
from tilhero_experience.api.release_notes import internal_router as notes_internal_router
from tilhero_experience.api.release_notes import staff_router as notes_staff_router
from tilhero_experience.api.staff import router as staff_router
from tilhero_experience.settings import Settings, get_settings


def build_app(settings: Settings | None = None, runtime: Runtime | None = None):
    settings = settings or get_settings()
    routers = [internal_router, staff_router, notes_internal_router, notes_staff_router]
    return create_app(settings, routers=routers, runtime=runtime or Runtime(settings),
                      title="TilHero experience-config-service")


app = build_app()
