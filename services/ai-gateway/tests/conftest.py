from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from gw_kit import SEED_DIR, T0, Env

from tilhero_ai_gateway.main import build_app
from tilhero_ai_gateway.providers import Provider
from tilhero_ai_gateway.settings import Settings
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

SERVICE_DIR = str(Path(__file__).resolve().parents[1])


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {"env": "test", "internal_jwt_secret": "t" * 40, "redis_url": TEST_REDIS_URL,
                            "cache_namespace": f"t:aigw:{uuid.uuid4().hex[:10]}", "seed_dir": str(SEED_DIR),
                            "ai_provider": "fake", "anthropic_api_key": None,
                            "ai_allow_fake_test_publish": True}
    base.update(kw)
    return Settings(**base)


async def make_env(provider: Provider | None = None, transport: httpx.AsyncBaseTransport | None = None,
                   **overrides: Any) -> AsyncIterator[Env]:
    schema = unique_schema("aigw")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema, **overrides)
    try:
        await migrate(SERVICE_DIR, settings)
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime, provider=provider, transport=transport)
        async with app.router.lifespan_context(app):
            client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://ai-gateway")
            env = Env(settings, client, runtime, bus, schema, app)
            env.set_now(T0)
            await env.flush()
            bus.published.clear()  # события сида миграции 0002 — отдельный тест
            yield env
            for task in list(getattr(app.state, "golden_tasks", set())):
                await task
            await client.aclose()
            assert runtime.redis is not None
            keys = [k async for k in runtime.redis.scan_iter(match=f"{settings.cache_namespace}*")]
            if keys:
                await runtime.redis.delete(*keys)
    finally:
        await drop_schema(schema)


@pytest.fixture
async def env() -> AsyncIterator[Env]:
    async for e in make_env():
        yield e
