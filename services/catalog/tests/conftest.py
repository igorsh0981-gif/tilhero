from __future__ import annotations

import uuid
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pytest
from catalog_kit import SEED_DIR, Env

from tilhero_catalog.main import build_app
from tilhero_catalog.settings import Settings
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
SCHEDULER_TOKEN = "s" * 40
TODAY = date(2026, 11, 19)


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {"env": "test", "internal_jwt_secret": "t" * 40, "redis_url": TEST_REDIS_URL,
                            "scheduler_token": SCHEDULER_TOKEN, "cache_namespace": f"t:catalog:{uuid.uuid4().hex[:10]}",
                            "seed_dir": str(SEED_DIR)}
    base.update(kw)
    return Settings(**base)


async def _env(**overrides: Any):
    schema = unique_schema("catalog")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema, **overrides)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    app = build_app(settings, runtime)
    try:
        async with app.router.lifespan_context(app):
            client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://catalog")
            e = Env(settings, client, runtime, bus, schema)
            e.set_today(TODAY)
            await e.flush()
            bus.published.clear()  # события сида миграции 0003 — отдельный тест
            yield e
            await client.aclose()
            assert runtime.redis is not None
            keys = [k async for k in runtime.redis.scan_iter(match=f"{settings.cache_namespace}*")]
            if keys:
                await runtime.redis.delete(*keys)
    finally:
        await drop_schema(schema)


@pytest.fixture
async def env():
    async for e in _env():
        yield e


@pytest.fixture
async def env_external():
    """Флаг media.external_sources включён (лицензированные материалы и встраивание разрешены)."""
    async for e in _env(media_external_sources=True):
        yield e
