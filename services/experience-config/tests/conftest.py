from __future__ import annotations

import copy
import uuid
from datetime import UTC, datetime
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
READY = "ready"  # onboarded_at по умолчанию: после миграций (и заметок релизов), до публикаций теста


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime,
                 bus: InMemoryBus) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus
        # события, которые опубликовали миграции (заметки релизов, их аудит): шина теста начинается без них
        self.migration_events: list[Any] = []
        self.ready_at = datetime.now(UTC)

    def h(self, actor: Actor | None = None, issuer: str = "admin-bff", **extra: str) -> dict[str, str]:
        return {**internal_headers(self.settings, issuer=issuer, actor=actor), **extra}

    def learner(self, user_id: uuid.UUID | str, issuer: str = "telegram-bff") -> dict[str, str]:
        """Внутренний токен telegram-bff с sub = активный ученик."""
        return internal_headers(self.settings, issuer=issuer, subject=str(user_id))

    def onboarded(self) -> str:
        """Ученик завершил онбординг после выкладки (миграций с заметками релизов), но до публикаций теста: в updates
        попадают только заметки, опубликованные тестом."""
        return iso(self.ready_at)

    async def for_me(self, user_id: uuid.UUID | str, onboarded_at: str | None = READY,
                     lang: str = "ru", age: str = "adults") -> httpx.Response:
        params = {"lang": lang, "age": age}
        if onboarded_at == READY:
            onboarded_at = self.onboarded()
        if onboarded_at is not None:
            params["onboarded_at"] = onboarded_at
        return await self.c.get("/internal/v1/release-notes/for-me", params=params, headers=self.learner(user_id))

    async def seen(self, user_id: uuid.UUID | str, ids: list[str]) -> httpx.Response:
        return await self.c.post("/internal/v1/release-notes/seen", json={"release_note_ids": ids},
                                 headers=self.learner(user_id))

    async def flush(self) -> None:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    def events(self, event_type: str):
        return self.bus.of_type(event_type)

    async def current(self, app: str = "miniapp", issuer: str = "telegram-bff") -> httpx.Response:
        return await self.c.get(f"/internal/v1/experience/{app}/current", headers=self.h(issuer=issuer))

    async def seed_payload(self, app: str = "miniapp", version: str = "1.0.0") -> dict[str, Any]:
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
        await e.flush()  # прогрев пула; outbox миграций уходит в шину
        e.migration_events = list(bus.published)
        bus.published.clear()
        e.ready_at = datetime.now(UTC)
        yield e
        await client.aclose()
        assert runtime.redis is not None
        keys = [k async for k in runtime.redis.scan_iter(match=f"{settings.cache_namespace}*")]
        if keys:
            await runtime.redis.delete(*keys)
    await drop_schema(schema)
