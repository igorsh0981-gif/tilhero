from __future__ import annotations

from tilhero_common.app import Runtime, create_app
from tilhero_learning_plan.api.client import router as client_router
from tilhero_learning_plan.api.directory import router as directory_router
from tilhero_learning_plan.api.internal import router as internal_router
from tilhero_learning_plan.api.release_notes import router as release_notes_router
from tilhero_learning_plan.consumers import DELETION_REQUESTED, on_deletion_requested
from tilhero_learning_plan.settings import Settings, get_settings


def configure(runtime: Runtime) -> None:
    runtime.add_consumer("preferences.user_deletion", [DELETION_REQUESTED], on_deletion_requested)


def build_app(settings: Settings | None = None, runtime: Runtime | None = None):
    settings = settings or get_settings()
    return create_app(settings, routers=[client_router, directory_router, internal_router, release_notes_router],
                      runtime=runtime or Runtime(settings), configure=configure,
                      title="TilHero learning-plan-service")


app = build_app()
