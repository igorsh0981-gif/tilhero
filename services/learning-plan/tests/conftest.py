from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from lp_course import FakeCatalog, areas
from sqlalchemy import text

from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope, InMemoryBus, make_envelope
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
                 app: Any, catalog: FakeCatalog | None = None) -> None:
        self.settings = settings
        self.c = client
        self.runtime = runtime
        self.bus = bus
        self.app = app
        self.catalog = catalog or FakeCatalog()
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
        body = r.json()
        assert body.pop("skipped") is False, body  # последовательные вызовы теста не пересекаются
        return body

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


    # ---------------------------------------------------------------- спринт 3: траектория

    async def trajectory(self, user: uuid.UUID, expect: int = 200, **params: Any) -> dict[str, Any]:
        r = await self.c.get("/internal/v1/plan/trajectory", params=params, headers=self.h(user))
        assert r.status_code == expect, r.text
        return r.json()

    async def publish(self, event_type: str, payload: dict[str, Any], producer: str,
                      occurred_at: datetime | None = None) -> Envelope:
        ev = make_envelope(event_type, payload, producer=producer)
        if occurred_at is not None:
            ev = ev.model_copy(update={"occurred_at": occurred_at})
        assert_event_conforms(ev)
        await self.bus.publish(ev)
        return ev

    async def diagnostic(self, user: uuid.UUID, *, start: str | None = "l-present", revision: int = 1,
                         result_id: uuid.UUID | None = None, level: str | None = "A1",
                         completed_at: str = "2026-11-16T07:00:00Z", producer: str = "diagnostics",
                         **bands: str | None) -> uuid.UUID:
        rid = result_id or uuid.uuid4()
        await self.publish("diagnostics.completed.v1", {
            "user_id": str(user), "pair_id": "ru-en", "result_id": str(rid), "revision": revision,
            "test_id": "dx-en-adult", "test_version": 1, "provisional_level": level, "areas": areas(**bands),
            "recommended_start_lesson_id": start, "completed_at": completed_at,
        }, producer=producer)
        return rid

    async def skills(self, user: uuid.UUID, changes: dict[str, str], *, occurred_at: str = "2026-11-16T07:01:00Z",
                     producer: str = "diagnostics") -> Envelope:
        return await self.publish("skills.state.changed.v1", {
            "user_id": str(user), "pair_id": "ru-en",
            "changes": [{"skill_id": k, "from": "not_started", "to": v, "source": "diagnostic",
                         "evidence_id": str(uuid.uuid4())} for k, v in changes.items()],
            "occurred_at": occurred_at,
        }, producer=producer)

    async def profile(self, user: uuid.UUID, *, kind: str = "account", age_band: str | None = "18+",
                      created_at: str = "2026-11-16T06:00:00.000Z") -> Envelope:
        return await self.publish("user.profile.created.v1", {
            "user_id": str(user), "kind": kind, "locale": "ru", "age_band": age_band,
            "guardian_user_id": str(uuid.uuid4()) if kind == "child" else None, "created_at": created_at,
        }, producer="identity-consent")

    async def catalog_published(self, kind: str = "lesson", key: str = "l-travel", course_id: str | None = "en-core",
                                producer: str = "catalog", action: str = "published") -> Envelope:
        return await self.publish("catalog.version.published.v1", {
            "kind": kind, "key": key, "version": 2, "previous_version": 1, "action": action,
            "course_id": course_id, "published_by": str(uuid.uuid4()), "published_at": "2026-11-16T07:30:00Z",
        }, producer=producer)

    async def revisions(self, user: uuid.UUID) -> list[Any]:
        return await self.sql("SELECT revision, next_lesson_id, basis FROM trajectories WHERE user_id = :u "
                              "ORDER BY revision", u=user)

    async def expire_snapshot(self) -> None:
        await self.sql("UPDATE course_snapshots SET checked_at = checked_at - interval '1 day'")


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "slow: нагрузочные проверки (секунды); исключить: -m 'not slow'")


@pytest.fixture
async def env():
    schema = unique_schema("lp")
    await create_schema(schema)
    settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema)
    await migrate(SERVICE_DIR, settings)
    bus = InMemoryBus()
    runtime = Runtime(settings, bus=bus)
    catalog = FakeCatalog()
    app = build_app(settings, runtime, catalog_transport=httpx.MockTransport(catalog.handler))
    async with app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://learning-plan")
        e = Env(settings, client, runtime, bus, app, catalog)
        await e.flush()  # прогрев пула: иначе остановка relay посреди connect() даёт шум в логе asyncpg
        yield e
        await client.aclose()
    await drop_schema(schema)


@pytest.fixture
def user() -> uuid.UUID:
    return uuid.uuid4()
