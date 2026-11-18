"""learning-plan: цель, уровень, языки, график занятий и длительность, учёт занятий, plan:tick → напоминания
и пропуски (INTERNAL_API §2)."""

from __future__ import annotations

from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_learning_plan.api.admin import router as admin_router
from tilhero_learning_plan.api.client import directory_router, plan_router
from tilhero_learning_plan.api.client import router as client_router
from tilhero_learning_plan.api.scheduler import router as scheduler_router
from tilhero_learning_plan.consumers import DELETION_REQUESTED, on_deletion_requested
from tilhero_learning_plan.settings import Settings, get_settings


def configure(runtime: Runtime) -> None:
    runtime.add_consumer("learning-plan.user_deletion", [DELETION_REQUESTED], on_deletion_requested)


def build_app(settings: Settings | None = None, runtime: Runtime | None = None) -> FastAPI:
    settings = settings or get_settings()
    return create_app(settings, routers=[client_router, plan_router, directory_router, scheduler_router,
                                                admin_router],
                      runtime=runtime or Runtime(settings), configure=configure,
                      title="TilHero learning-plan-service")


app = build_app()
