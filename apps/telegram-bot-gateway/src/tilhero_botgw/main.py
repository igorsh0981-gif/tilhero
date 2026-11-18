"""telegram-bot-gateway: два ASGI-приложения в одном процессе (ревью спринта 1, P1).

- публичное (`PORT`, домен Railway) — только `POST /telegram/webhook` и `/health/*`;
- внутреннее (`INTERNAL_PORT`, 8108, только приватная сеть) — `POST /internal/v1/messages` (только notifications)
  и `/health/*`.

Оба приложения разделяют один Runtime (Redis, клиенты): его жизненным циклом управляет публичное приложение.
Запуск обоих портов — `python -m tilhero_botgw` (tilhero_botgw.serve): один uvicorn-сервер на двух сокетах,
маршрутизация по локальному порту соединения (PortRouter). Внутренний API на публичном порту не существует.
"""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import FastAPI

from tilhero_botgw.api import internal, webhook
from tilhero_botgw.settings import Settings, get_settings
from tilhero_botgw.telegram import TelegramClient, silence_http_logging
from tilhero_common.app import Runtime, create_app


def build_apps(
    settings: Settings | None = None,
    runtime: Runtime | None = None,
    *,
    telegram_transport: httpx.AsyncBaseTransport | None = None,
    identity_transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[FastAPI, FastAPI]:
    """→ (публичное, внутреннее). Без БД (Runtime работает только с Redis). Транспорты — для тестов."""
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    telegram = TelegramClient(
        settings.bot_token.get_secret_value(),
        api_base=settings.telegram_api_base,
        timeout=settings.telegram_timeout_seconds,
        transport=telegram_transport,
    )

    def configure(rt: Runtime) -> None:
        rt.register_client("identity-consent", settings.identity_consent_url, transport=identity_transport)

        async def close_telegram(_: Runtime) -> None:
            await telegram.aclose()

        rt.on_shutdown(close_telegram)

    public = create_app(
        settings,
        routers=[webhook.router],
        runtime=runtime,
        configure=configure,
        title="TilHero telegram-bot-gateway",
    )
    private = create_app(
        settings,
        routers=[internal.router],
        runtime=runtime,
        manage_runtime=False,
        title="TilHero telegram-bot-gateway (internal)",
    )
    silence_http_logging()  # после configure_logging: URL запросов к Bot API содержит токен
    for app in (public, private):
        app.state.telegram = telegram
    return public, private


class PortRouter:
    """ASGI-диспетчер: соединения на INTERNAL_PORT → внутреннее приложение, остальные → публичное.
    lifespan уходит публичному приложению (оно управляет общим Runtime). Нет сведений о порте — публичное
    (fail closed: внутренний API недоступен)."""

    def __init__(self, public: Any, private: Any, internal_port: int) -> None:
        self.public = public
        self.private = private
        self.internal_port = internal_port

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] in ("http", "websocket"):
            server = scope.get("server")
            if server and len(server) >= 2 and server[1] == self.internal_port:
                await self.private(scope, receive, send)
                return
        await self.public(scope, receive, send)


_settings = get_settings()
app, internal_app = build_apps(_settings)  # app — публичное приложение
asgi = PortRouter(app, internal_app, _settings.internal_port)  # оба порта (serve.py)
