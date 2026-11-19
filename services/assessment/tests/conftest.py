from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from as_testkit import FakeAi, FakeCatalog
from sqlalchemy import text

from tilhero_assessment.main import build_app
from tilhero_assessment.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.internal_auth import Actor
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

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
T0 = datetime(2026, 11, 19, 7, 0, tzinfo=UTC)
ALL_STAFF = ("qa.read", "qa.review", "qa.transcripts", "dashboard.read")
SCHEDULER_TOKEN = "sched-" + "s" * 34


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {"env": "test", "internal_jwt_secret": "t" * 40, "scheduler_token": SCHEDULER_TOKEN}
    base.update(kw)
    return Settings(**base)


class Env:
    def __init__(self, settings: Settings, client: httpx.AsyncClient, runtime: Runtime, bus: InMemoryBus, app: Any,
                 catalog: FakeCatalog, ai: FakeAi) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus
        self.app = app
        self.catalog = catalog
        self.ai = ai
        self.now = T0
        app.state.clock = lambda: self.now

    # ---------- заголовки
    def lessons(self, user: uuid.UUID | str | None, issuer: str = "lessons") -> dict[str, str]:
        return internal_headers(self.settings, issuer=issuer, subject=str(user) if user else None)

    def learner(self, user: uuid.UUID | str | None, issuer: str = "telegram-bff") -> dict[str, str]:
        return internal_headers(self.settings, issuer=issuer, subject=str(user) if user else None)

    def staff(self, *perms: str, staff_id: str | None = None, issuer: str = "admin-bff",
              actor: bool = True) -> dict[str, str]:
        a = Actor(id=staff_id or str(uuid.uuid4()), role="methodist", permissions=frozenset(perms), name="Метод")
        return internal_headers(self.settings, issuer=issuer, actor=a if actor else None)

    # ---------- данные
    async def flush(self) -> None:
        assert self.runtime.relay is not None
        await self.runtime.relay.drain()

    async def events(self, event_type: str, user: uuid.UUID | None = None) -> list[Envelope]:
        await self.flush()
        found = [e for e in self.bus.of_type(event_type)
                 if user is None or e.payload.get("user_id") == str(user)]
        for e in found:
            assert_event_conforms(e)
            assert e.producer == "assessment"
        return found

    async def sql(self, stmt: str, **params: Any) -> Any:
        async with self.runtime.transaction() as s:
            result = await s.execute(text(stmt), params)
            return result.all() if result.returns_rows else None

    # ---------- сценарии
    async def evaluate(self, user: uuid.UUID, body: dict[str, Any], expect: int = 201) -> dict[str, Any]:
        r = await self.c.post("/internal/v1/evaluations", json=body, headers=self.lessons(user))
        assert r.status_code == expect, r.text
        return r.json()

    async def view(self, user: uuid.UUID, evaluation_id: str, expect: int = 200) -> dict[str, Any]:
        r = await self.c.get(f"/internal/v1/evaluations/{evaluation_id}", headers=self.learner(user))
        assert r.status_code == expect, r.text
        return r.json()

    async def appeal(self, user: uuid.UUID, evaluation_id: str, reason: str = "Я ответил правильно, проверьте",
                     key: str | None = None, expect: int = 201) -> dict[str, Any]:
        r = await self.c.post(f"/internal/v1/evaluations/{evaluation_id}/appeal", json={"reason": reason},
                              headers={**self.learner(user), "Idempotency-Key": key or f"ap-{uuid.uuid4()}"})
        assert r.status_code == expect, r.text
        return r.json()


@pytest.fixture
async def env():
    schema = unique_schema("as")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    catalog, ai = FakeCatalog(), FakeAi()
    app = build_app(settings, runtime, catalog_transport=httpx.MockTransport(catalog.handler),
                    ai_transport=httpx.MockTransport(ai.handler))
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://assessment")
        e = Env(settings, client, runtime, bus, app, catalog, ai)
        yield e
        await client.aclose()
    await drop_schema(schema)


@pytest.fixture
def user() -> uuid.UUID:
    return uuid.uuid4()
