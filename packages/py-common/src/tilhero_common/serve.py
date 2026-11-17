"""Запуск ASGI-сервиса: `python -m tilhero_common.serve <module:app>`.

Почему не `uvicorn --host ::`: uvicorn передаёт host в asyncio `loop.create_server`, а тот для IPv6 ставит
IPV6_V6ONLY=1 — сервис слушает только IPv6, и healthcheck Railway (IPv4) получает «service unavailable».
Здесь сокет создаётся с IPV6_V6ONLY=0: один сокет `::` принимает и IPv6, и IPv4
(dual-stack, как приватная сеть Railway). PORT и HOST — из окружения.
"""

from __future__ import annotations

import os
import socket
import sys

import uvicorn


def make_config(app: str) -> uvicorn.Config:
    return uvicorn.Config(
        app,
        host=os.environ.get("HOST", "::"),
        port=int(os.environ.get("PORT", "8000")),
        proxy_headers=True,
        forwarded_allow_ips="*",
        access_log=False,  # access-лог пишет RequestContextMiddleware (шаблон маршрута, без PII)
    )


def bind(config: uvicorn.Config) -> socket.socket:
    """Слушающий сокет. Для IPv6-адреса (`::`) — IPV6_V6ONLY=0 ДО bind (после bind ядро отвечает EINVAL):
    один сокет принимает и IPv6, и IPv4. Прочие адреса — как в uvicorn."""
    if ":" not in config.host:
        return config.bind_socket()
    sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        sock.bind((config.host, config.port))
    except OSError:
        sock.close()
        raise
    sock.set_inheritable(True)
    return sock


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        raise SystemExit("usage: python -m tilhero_common.serve <module:app>")
    config = make_config(args[0])
    server = uvicorn.Server(config)
    server.run(sockets=[bind(config)])


if __name__ == "__main__":
    main()
