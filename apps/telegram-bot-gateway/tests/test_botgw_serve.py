"""Ревью P1: один процесс, два порта — публичный (webhook + health) и внутренний (internal API + health)."""

from __future__ import annotations

import asyncio
import socket
import uuid

import httpx
from botgw_testkit import SECRET, FakeTelegram, make_settings

from tilhero_botgw.main import PortRouter, build_apps
from tilhero_botgw.serve import make_server
from tilhero_common.app import Runtime
from tilhero_common.testing import internal_headers


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


async def test_two_ports_one_process() -> None:
    port, internal_port = free_port(), free_port()
    settings = make_settings(
        "t_botgw_serve_" + uuid.uuid4().hex[:8], host="127.0.0.1", port=port, internal_port=internal_port
    )
    telegram = FakeTelegram()
    runtime = Runtime(settings)
    public, private = build_apps(settings, runtime, telegram_transport=httpx.MockTransport(telegram.handler))
    server, sockets = make_server(settings, PortRouter(public, private, internal_port))
    task = asyncio.create_task(server.serve(sockets=sockets))
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.05)
        assert server.started
        msg = {"telegram_user_id": 918273645, "text": "x", "idempotency_key": uuid.uuid4().hex}
        auth = internal_headers(settings, issuer="notifications")
        async with httpx.AsyncClient() as c:
            pub, intl = f"http://127.0.0.1:{port}", f"http://127.0.0.1:{internal_port}"
            assert (await c.post(f"{pub}/internal/v1/messages", json=msg, headers=auth)).status_code == 404
            assert (await c.post(f"{pub}/telegram/webhook", json={"update_id": 1})).status_code == 401
            assert (await c.get(f"{pub}/health/ready")).status_code == 200
            sent = await c.post(f"{intl}/internal/v1/messages", json=msg, headers=auth)
            assert sent.status_code == 200 and sent.json() == {"message_id": 501}
            hook = await c.post(
                f"{intl}/telegram/webhook", json={"update_id": 2}, headers={"X-Telegram-Bot-Api-Secret-Token": SECRET}
            )
            assert hook.status_code == 404
            assert (await c.get(f"{intl}/health/ready")).status_code == 200
        assert len(telegram.sent()) == 1
        assert runtime.redis is not None
        keys = [k async for k in runtime.redis.scan_iter(match=f"{settings.redis_key_prefix}*")]
        if keys:
            await runtime.redis.delete(*keys)
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 10)
