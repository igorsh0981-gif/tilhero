"""tilhero_common.serve: сокет `::` принимает и IPv4, и IPv6 (healthcheck Railway приходит по IPv4)."""

from __future__ import annotations

import socket
import threading
import time
import urllib.request

import pytest
import uvicorn

from tilhero_common.serve import bind, make_config


async def _app(scope, receive, send):  # минимальное ASGI-приложение
    if scope["type"] == "lifespan":
        while True:
            msg = await receive()
            if msg["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif msg["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
    await send({"type": "http.response.body", "body": b"ok"})


def _ipv6_available() -> bool:
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as s:
            s.bind(("::1", 0))
        return True
    except OSError:
        return False


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_config_from_env(monkeypatch) -> None:
    monkeypatch.setenv("PORT", "8123")
    monkeypatch.delenv("HOST", raising=False)
    c = make_config("x:app")
    assert (c.host, c.port, c.access_log, c.proxy_headers) == ("::", 8123, False, True)


@pytest.mark.skipif(not _ipv6_available(), reason="IPv6 недоступен в этой среде")
def test_dual_stack_accepts_ipv4_and_ipv6(monkeypatch) -> None:
    port = _free_port()
    monkeypatch.setenv("PORT", str(port))
    monkeypatch.setenv("HOST", "::")
    config = make_config("x:app")
    config.app = _app
    config.lifespan = "on"
    sock = bind(config)
    assert sock.getsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY) == 0
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    t.start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        for host in ("127.0.0.1", "[::1]"):
            with urllib.request.urlopen(f"http://{host}:{port}/", timeout=3) as r:
                assert r.status == 200 and r.read() == b"ok"
    finally:
        server.should_exit = True
        t.join(5)


def test_ipv4_host_uses_uvicorn_bind(monkeypatch) -> None:
    port = _free_port()
    monkeypatch.setenv("PORT", str(port))
    monkeypatch.setenv("HOST", "127.0.0.1")
    sock = bind(make_config("x:app"))
    try:
        assert sock.family == socket.AF_INET and sock.getsockname() == ("127.0.0.1", port)
    finally:
        sock.close()
