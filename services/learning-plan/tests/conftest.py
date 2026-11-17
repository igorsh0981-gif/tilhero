from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import text

from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope, InMemoryBus
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    assert_event_conforms,
    create_schema,
    drop_schema,
    internal_headers,
    migrate,
    unique_schema,
)
from tilhero_learning_plan.main import build_app
from tilhero_learning_plan.settings import Settings

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
SCHEDULER_TOKEN = "s" * 43


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {"env": "test", "internal_jwt_secret": "t" * 40, "scheduler_token": SCHEDULER_TOKEN}
    base.update(kw)
    return Settings(**base)


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime, bus: InMemoryBus,
                 app: Any) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus
        self.app = app
        self.now = datetime(2026, 11, 16, 8, 0, tzinfo=UTC)  # пн, 13:00 в Ташкенте
        app.state.clock = lambda: self.now

    def h(self, user: uuid.UUID | str | None = None, issuer: str = "telegram-bff") -> dict[str, str]:
        return internal_headers(self.settings, issuer=issuer, subject=str(user) if user else None)

    @property
    def sched(self) -> dict[str, str]:
        return {"authorization": f"Bearer {SCHEDULER_TOKEN}"}

    async def flush(self) -> None:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    async def events(self, event_type: str, user: uuid.UUID | None = None) -> list[Envelope]:
        await self.flush()
        found = [e for e in self.bus.of_type(event_type)
                 if user is None or e.payload.get("user_id") == str(user)]
        for e in found:
            assert_event_conforms(e)
            assert e.producer == "learning-plan"
        return found

    async def sql(self, stmt: str, **params: Any) -> Any:
        async with self.runtime.transaction() as s:
            result = await s.execute(text(stmt), params)
            return result.all() if result.returns_rows else None

    async def set_last_tick(self, at: datetime) -> None:
        async with self.runtime.transaction() as s:
            await s.execute(text("UPDATE tick_state SET last_tick_at = :t WHERE id = 1"), {"t": at})

    async def tick(self, at: datetime, since: datetime | None = None) -> dict[str, int]:
        if since is not None:
            await self.set_last_tick(since)
        self.now = at
        r = await self.c.post("/internal/v1/plan:tick", headers=self.sched)
        assert r.status_code == 200, r.text
        return r.json()

    async def onboard(self, user: uuid.UUID, *, at: datetime, preset: str = "daily", days: list[int] | None = None,
                      time: str = "19:00", tz: str = "Asia/Tashkent", reminders: bool = True,
                      duration: int = 20) -> dict[str, Any]:
        self.now = at
        schedule: dict[str, Any] = {"preset": preset, "preferred_time": time, "timezone": tz,
                                    "reminders_enabled": reminders, "duration_min": duration}
        if days is not None:
            schedule["days"] = days
        r = await self.c.patch("/internal/v1/me/plan", headers=self.h(user),
                               json={"goal": "travel", "level_self": "beginner", "schedule": schedule})
        assert r.status_code == 200, r.text
        r = await self.c.post("/internal/v1/me/plan/onboarding/complete", headers=self.h(user))
        assert r.status_code == 200, r.text
        return r.json()

    async def practice(self, user: uuid.UUID, *, at: datetime, minutes: int = 10,
                       key: str | None = None) -> httpx.Response:
        self.now = at
        return await self.c.post("/internal/v1/me/activities", headers={
            **self.h(user), "Idempotency-Key": key or str(uuid.uuid4())}, json={"kind": "practice", "minutes": minutes})


@pytest.fixture
async def env():
    schema = unique_schema("lp")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    app = build_app(settings, runtime)
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://learning-plan")
        e = Env(settings, client, runtime, bus, app)
        await e.flush()  # прогрев пула: иначе остановка relay посреди connect() даёт шум в логе asyncpg
        yield e
        await client.aclose()
    await drop_schema(schema)


@pytest.fixture
def user() -> uuid.UUID:
    return uuid.uuid4()
