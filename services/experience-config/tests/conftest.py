from __future__ import annotations

import copy
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
from exp_actors import READER

from tilhero_common.app import Runtime
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import InMemoryBus
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    TEST_REDIS_URL,
    create_schema,
    drop_schema,
    internal_headers,
    migrate,
    unique_schema,
)
from tilhero_experience.main import build_app
from tilhero_experience.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])



class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime,
                 bus: InMemoryBus) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus

    def h(self, actor: Actor | None = None, issuer: str = "admin-bff", **extra: str) -> dict[str, str]:
        return {**internal_headers(self.settings, issuer=issuer, actor=actor), **extra}

    async def flush(self) -> None:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    def events(self, event_type: str):
        return self.bus.of_type(event_type)

    async def current(self, app: str = "miniapp", issuer: str = "telegram-bff") -> httpx.Response:
        return await self.c.get(f"/internal/v1/experience/{app}/current", headers=self.h(issuer=issuer))

    async def seed_payload(self, app: str = "miniapp", version: str = "2.0.3") -> dict[str, Any]:
        r = await self.c.get(f"/admin/v1/experience/{app}/versions/{version}", headers=self.h(READER))
        assert r.status_code == 200, r.text
        return copy.deepcopy(r.json()["payload"])


@pytest.fixture
async def env():
    schema = unique_schema("expcfg")
    await create_schema(schema)
    settings = Settings(env="test", database_url=TEST_ADMIN_URL, db_schema=schema,
                        internal_jwt_secret="t" * 40, redis_url=TEST_REDIS_URL,
                        cache_namespace=f"t:expcfg:{uuid.uuid4().hex[:10]}")
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    app = build_app(settings, runtime)
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://experience-config")
        e = Env(settings, client, runtime, bus)
        await e.flush()  # прогрев пула (см. tests preferences)
        yield e
        await client.aclose()
        assert runtime.redis is not None
        keys = [k async for k in runtime.redis.scan_iter(match=f"{settings.cache_namespace}*")]
        if keys:
            await runtime.redis.delete(*keys)
    await drop_schema(schema)
