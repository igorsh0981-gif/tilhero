from __future__ import annotations

import uuid
from pathlib import Path

import httpx
import pytest

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    create_schema,
    drop_schema,
    internal_headers,
    migrate,
    unique_schema,
)
from tilhero_learning_plan.main import build_app
from tilhero_learning_plan.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime,
                 bus: InMemoryBus) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus

    def h(self, user: uuid.UUID | str | None = None, issuer: str = "telegram-bff") -> dict[str, str]:
        return internal_headers(self.settings, issuer=issuer, subject=str(user) if user else None)

    async def flush(self) -> None:
        """Публикует outbox в шину (relay в тесте не ждём)."""
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    def events(self, event_type: str):
        return self.bus.of_type(event_type)


@pytest.fixture
async def env():
    schema = unique_schema("pref")
    await create_schema(schema)
    settings = Settings(env="test", database_url=TEST_ADMIN_URL, db_schema=schema,
                        internal_jwt_secret="t" * 40)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    app = build_app(settings, runtime)
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://preferences")
        e = Env(settings, client, runtime, bus)
        await e.flush()  # прогрев пула: иначе остановка relay посреди connect() даёт шум в логе asyncpg
        yield e
        await client.aclose()
    await drop_schema(schema)


@pytest.fixture
def user() -> uuid.UUID:
    return uuid.uuid4()
