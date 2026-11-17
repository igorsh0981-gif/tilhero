from __future__ import annotations

import httpx

from tilhero_common.app import Runtime, create_app
from tilhero_identity.api.admin import router as admin_router
from tilhero_identity.api.client import router as client_router
from tilhero_identity.api.service import router as service_router
from tilhero_identity.consumers import configure as configure_consumers
from tilhero_identity.deletion.api import admin_router as deletion_admin_router
from tilhero_identity.deletion.api import internal_router as deletion_internal_router
from tilhero_identity.deletion.sweeper import sweep_loop
from tilhero_identity.settings import Settings, get_settings


def build_app(
    settings: Settings | None = None,
    runtime: Runtime | None = None,
    *,
    notifications_transport: httpx.AsyncBaseTransport | None = None,
    audit_transport: httpx.AsyncBaseTransport | None = None,
):
    settings = settings or get_settings()

    def configure(rt: Runtime) -> None:
        configure_consumers(rt)
        # Код сброса PIN уходит синхронно, мимо outbox/шины (ревью P2). Повтор безопасен: Idempotency-Key =
        # notification_id, notifications дедуплицирует по нему и по dedup_key.
        rt.register_client(
            "notifications",
            settings.notifications_url,
            timeout=settings.notifications_timeout_seconds,
            retries=1,
            transport=notifications_transport,
        )
        # Просмотр Telegram ID сотрудником (reveal) пишется в аудит синхронно: audit недоступен → 503, значения нет.
        rt.register_client(
            "audit",
            settings.audit_url,
            timeout=settings.audit_timeout_seconds,
            retries=1,
            transport=audit_transport,
        )

        # Сага удаления (спринт 9, ADR-009): таймер повторов и «зависло». Тик выполняет одна реплика (advisory lock).
        async def start_sweeper(r: Runtime) -> None:
            if r.db is not None and settings.deletion_sweep_seconds > 0:
                r.spawn(sweep_loop(r, settings.deletion_sweep_seconds), "deletion-sweeper")

        rt.on_startup(start_sweeper)

    return create_app(
        settings,
        routers=[client_router, service_router, admin_router, deletion_admin_router, deletion_internal_router],
        runtime=runtime or Runtime(settings),
        configure=configure,
        title="TilHero identity-consent",
    )


app = build_app()
