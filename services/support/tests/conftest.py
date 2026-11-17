from __future__ import annotations

import httpx
import pytest
from support_testkit import SERVICE_DIR, SupportEnv

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus
from tilhero_common.testing import TEST_ADMIN_URL, create_schema, drop_schema, migrate, unique_schema
from tilhero_support.main import build_app
from tilhero_support.settings import Settings


@pytest.fixture
async def env():
    schema = unique_schema("support")
    await create_schema(schema)
    settings = Settings(
        env="test", database_url=TEST_ADMIN_URL, db_schema=schema, internal_jwt_secret="t" * 40
    )
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    app = build_app(settings, runtime)
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://support")
        yield SupportEnv(settings, client, runtime, bus)
        await client.aclose()
    await drop_schema(schema)
