from __future__ import annotations

import uuid

import httpx
import pytest
from notif_testkit import SCHEDULER_TOKEN, SERVICE_DIR, FakeGateway, FakeIdentity, NotifEnv

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    TEST_REDIS_URL,
    create_schema,
    drop_schema,
    migrate,
    unique_schema,
)
from tilhero_notifications.main import build_app
from tilhero_notifications.settings import Settings


@pytest.fixture
async def env():
    schema = unique_schema("notif")
    prefix = "t_notif_" + uuid.uuid4().hex[:10]  # Redis db 15 общий: свои ключи, без FLUSHDB
    await create_schema(schema)
    settings = Settings(
        env="test",
        database_url=TEST_ADMIN_URL,
        db_schema=schema,
        redis_url=TEST_REDIS_URL,
        internal_jwt_secret="t" * 40,
        redis_key_prefix=prefix,
        dispatcher_enabled=False,
        identity_consent_url="http://identity-consent.test",
        bot_gateway_url="http://botgw.test",
        scheduler_token=SCHEDULER_TOKEN,
    )
    await migrate(SERVICE_DIR, settings)
    bus, identity, gateway = InMemoryBus(), FakeIdentity(), FakeGateway()
    runtime = Runtime(settings, bus=bus)
    app = build_app(
        settings,
        runtime,
        identity_transport=httpx.MockTransport(identity.handler),
        botgw_transport=httpx.MockTransport(gateway.handler),
    )
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://notifications")
        yield NotifEnv(settings, client, runtime, bus, identity, gateway, app.state.dispatcher, app.state.accept)
        await client.aclose()
        assert runtime.redis is not None
        keys = [k async for k in runtime.redis.scan_iter(match=f"{prefix}:*")]
        if keys:
            await runtime.redis.delete(*keys)
    await drop_schema(schema)
