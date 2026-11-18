from __future__ import annotations

from typing import Any

import httpx
import pytest
from user_admin_testkit import SERVICE_DIR, FakeIdentity, UAEnv

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus
from tilhero_common.testing import TEST_ADMIN_URL, create_schema, drop_schema, migrate, unique_schema
from tilhero_user_admin.main import build_app
from tilhero_user_admin.settings import Settings

SECRET = "user-admin-test-secret-" + "x" * 24


def make_settings(schema: str, **kw: Any) -> Settings:
    base: dict[str, Any] = {
        "env": "test",
        "database_url": TEST_ADMIN_URL,
        "db_schema": schema,
        "internal_jwt_secret": SECRET,
        # фоновую сверку тесты запускают явно (sync.run_once); старт с фоновой задачей — отдельные тесты
        "sync_enabled": False,
        "sync_min_gap_seconds": 0,
    }
    base.update(kw)
    return Settings(**base)


@pytest.fixture
async def make_env():
    """Фабрика окружения: make_env(**settings_overrides) → UAEnv (временная схема, миграции, InMemoryBus)."""
    stack: list[tuple[Any, str, httpx.AsyncClient]] = []

    async def factory(identity: FakeIdentity | None = None, **kw: Any) -> UAEnv:
        schema = unique_schema("user_admin")
        await create_schema(schema)
        settings = make_settings(schema, **kw)
        await migrate(SERVICE_DIR, settings)
        identity = identity or FakeIdentity()
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime, identity_transport=httpx.MockTransport(identity.handler))
        ctx = app.router.lifespan_context(app)
        await ctx.__aenter__()
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://user-admin")
        stack.append((ctx, schema, client))
        return UAEnv(settings, client, runtime, bus, identity, app.state.identity_sync)

    yield factory
    for ctx, schema, client in reversed(stack):
        await client.aclose()
        await ctx.__aexit__(None, None, None)
        await drop_schema(schema)


@pytest.fixture
async def env(make_env) -> UAEnv:
    return await make_env()
