from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

import httpx
import pytest
from botgw_testkit import APP_LINK, FakeBilling, FakeIdentity, FakeTelegram, GatewayEnv, make_settings

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


@pytest.fixture
async def fast_gw():
    """Таймауты Stars уменьшены (те же пропорции): проверки бюджета времени без долгих ожиданий."""
    async with _gateway(stars_identity_timeout_seconds=0.2, stars_pre_checkout_timeout_seconds=0.3,
                        stars_billing_timeout_seconds=0.3, stars_update_deadline_seconds=0.5) as env:
        yield env


@asynccontextmanager
async def _gateway(**overrides):
    # Уникальный префикс ключей: Redis db 15 общий для всех тестов стенда, FLUSHDB запрещён
    prefix = "t_botgw_" + uuid.uuid4().hex[:10]
    settings = make_settings(prefix, **overrides)
    telegram, identity, billing = FakeTelegram(), FakeIdentity(), FakeBilling()
    runtime = Runtime(settings)
    app, internal_app = build_apps(
        settings,
        runtime,
        telegram_transport=httpx.MockTransport(telegram.handler),
        identity_transport=httpx.MockTransport(identity.handler),
        billing_transport=httpx.MockTransport(billing.handler),
    )
    async with app.router.lifespan_context(app):
        # client — публичный порт (webhook), internal — INTERNAL_PORT (только приватная сеть)
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://botgw")
        internal = httpx.AsyncClient(transport=httpx.ASGITransport(app=internal_app), base_url="http://botgw:8108")
        yield GatewayEnv(settings, client, runtime, telegram, identity, internal, billing)
        await client.aclose()
        await internal.aclose()
        assert runtime.redis is not None
        keys = [k async for k in runtime.redis.scan_iter(match=f"*{prefix}*")]
        if keys:
            await runtime.redis.delete(*keys)
