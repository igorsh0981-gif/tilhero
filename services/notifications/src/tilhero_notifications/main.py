"""notifications: потребители событий и планировщик; HTTP — health, синхронная отправка транзакционных
сообщений для identity-consent (POST /internal/v1/notifications/transactional) и запуск дайджеста
(POST /internal/v1/notifications:digest, n8n по SCHEDULER_TOKEN)."""

from __future__ import annotations

import httpx
from fastapi import FastAPI

from tilhero_common.app import Runtime, create_app
from tilhero_notifications import api
from tilhero_notifications.consumers import build_handlers
from tilhero_notifications.digest import DigestRunner
from tilhero_notifications.dispatcher import Dispatcher
from tilhero_notifications.settings import Settings, get_settings


def build_app(
    settings: Settings | None = None,
    runtime: Runtime | None = None,
    *,
    identity_transport: httpx.AsyncBaseTransport | None = None,
    botgw_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    dispatcher = Dispatcher(runtime)
    enqueue, consumers = build_handlers(runtime, dispatcher)

    def configure(rt: Runtime) -> None:
        rt.register_client("identity-consent", settings.identity_consent_url, transport=identity_transport)
        # Повторы отправки делает планировщик (с backoff и учётом retry_after), не HTTP-клиент
        rt.register_client(
            "telegram-bot-gateway",
            settings.bot_gateway_url,
            retries=0,
            timeout=10.0,
            transport=botgw_transport,
        )
        for durable, (event_types, handler) in consumers.items():
            rt.add_consumer(durable, event_types, handler)

        async def start_dispatcher(r: Runtime) -> None:
            if settings.dispatcher_enabled:
                r.spawn(dispatcher.run_forever(), "notifications-dispatcher")

        rt.on_startup(start_dispatcher)

    app = create_app(
        settings,
        routers=[api.router, api.scheduler_router],
        runtime=runtime,
        configure=configure,
        title="TilHero notification-service",
    )
    app.state.dispatcher = dispatcher
    app.state.enqueue = enqueue
    app.state.digest = DigestRunner(runtime, dispatcher)
    return app


app = build_app()
