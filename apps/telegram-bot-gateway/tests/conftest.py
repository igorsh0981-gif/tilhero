from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

import httpx
import pytest
from botgw_testkit import APP_LINK, FakeIdentity, FakeTelegram, GatewayEnv, make_settings

from tilhero_botgw.main import build_apps
from tilhero_common.app import Runtime


@pytest.fixture
async def gw():
    async with _gateway() as env:
        yield env


@pytest.fixture
async def link_gw():
    """Прямая ссылка Mini App настроена (TELEGRAM_APP_LINK): payload /start — в startapp ссылки t.me."""
    async with _gateway(telegram_app_link=APP_LINK) as env:
        yield env


@asynccontextmanager
async def _gateway(**overrides):
    # Уникальный префикс ключей: Redis db 15 общий для всех тестов стенда, FLUSHDB запрещён
    prefix = "t_botgw_" + uuid.uuid4().hex[:10]
    settings = make_settings(prefix, **overrides)
    telegram, identity = FakeTelegram(), FakeIdentity()
    runtime = Runtime(settings)
    app, internal_app = build_apps(
        settings,
        runtime,
        telegram_transport=httpx.MockTransport(telegram.handler),
        identity_transport=httpx.MockTransport(identity.handler),
    )
    async with app.router.lifespan_context(app):
        # client — публичный порт (webhook), internal — INTERNAL_PORT (только приватная сеть)
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://botgw")
        internal = httpx.AsyncClient(transport=httpx.ASGITransport(app=internal_app), base_url="http://botgw:8108")
        yield GatewayEnv(settings, client, runtime, telegram, identity, internal)
        await client.aclose()
        await internal.aclose()
        assert runtime.redis is not None
        keys = [k async for k in runtime.redis.scan_iter(match=f"*{prefix}*")]
        if keys:
            await runtime.redis.delete(*keys)
