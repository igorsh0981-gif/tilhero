"""Запуск bot-gateway на двух портах одним uvicorn-сервером: `python -m tilhero_botgw`.

PORT (публичный домен Railway) — webhook Telegram и health; INTERNAL_PORT (8108, приватная сеть) — внутренний
API для notifications. Сокеты создаёт uvicorn (bind_socket: для `::` — dual-stack IPv6/IPv4, как требует
приватная сеть Railway), запросы разводит PortRouter по локальному порту соединения.
"""

from __future__ import annotations

import socket
from typing import Any

import uvicorn

from tilhero_botgw.settings import Settings


def make_server(settings: Settings, asgi: Any) -> tuple[uvicorn.Server, list[socket.socket]]:
    common: dict[str, Any] = {
        "host": settings.host,
        "proxy_headers": True,
        "forwarded_allow_ips": "*",
        "access_log": False,  # access-лог пишет общий middleware (шаблон маршрута, без PII)
        "log_config": None,
    }
    public = uvicorn.Config(asgi, port=settings.port, lifespan="on", **common)
    internal = uvicorn.Config(asgi, port=settings.internal_port, **common)
    from tilhero_common.serve import bind

    return uvicorn.Server(public), [bind(public), bind(internal)]


def main() -> None:
    from tilhero_botgw.main import _settings, asgi

    if _settings.bot_auto_setup:
        from tilhero_botgw.setup import auto_setup

        auto_setup(_settings)
    server, sockets = make_server(_settings, asgi)
    server.run(sockets=sockets)


if __name__ == "__main__":
    main()
