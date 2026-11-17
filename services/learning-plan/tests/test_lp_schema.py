"""Модели = миграции (schema_drift); миграции под ролью-владельцем, сервис — под своей ролью без DDL; откат/подъём."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from conftest import SCHEDULER_TOKEN, SERVICE_DIR, make_settings

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus, make_envelope, messaging_metadata
from tilhero_common.testing import ddl_allowed_for, internal_headers, migrated_under_roles, schema_drift
from tilhero_learning_plan.main import build_app
from tilhero_learning_plan.models import Base


async def test_models_match_migrations_and_runtime_role() -> None:
    async with migrated_under_roles(SERVICE_DIR, make_settings, "lp_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in ("plans", "activities", "slot_marks", "tick_state", "deleted_users", "outbox"):
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime)
        user = uuid.uuid4()
        now = datetime(2026, 11, 16, 3, 0, tzinfo=UTC)
        app.state.clock = lambda: now
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://lp") as c:
                h = internal_headers(settings, subject=str(user))
                assert (await c.get("/internal/v1/me/plan", headers=h)).status_code == 200
                r = await c.patch("/internal/v1/me/plan", headers=h, json={
                    "goal": "exam", "level_self": "zero", "topics": ["study"],
                    "schedule": {"preset": "weekdays", "preferred_time": "08:00", "reminders_enabled": True}})
                assert r.status_code == 200, r.text
                assert (await c.post("/internal/v1/me/plan/onboarding/complete", headers=h)).status_code == 200
                act = await c.post("/internal/v1/me/activities", json={"kind": "practice", "minutes": 5},
                                   headers={**h, "Idempotency-Key": str(uuid.uuid4())})
                assert act.status_code == 200, act.text
                sched = {"authorization": f"Bearer {SCHEDULER_TOKEN}"}
                now = datetime.now(UTC) + timedelta(minutes=5)  # окно после отметки миграции (last_tick_at)
                tick = await c.post("/internal/v1/plan:tick", headers=sched)
                assert tick.status_code == 200 and tick.json()["plans_checked"] == 1, tick.text
                await bus.publish(make_envelope(
                    "user.deletion.requested.v1",
                    {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-11-18T10:00:00Z"},
                    producer="identity-consent",
                ))
                assert (await c.get("/health/ready")).status_code == 200
            assert runtime.relay is not None
            await runtime.relay.drain()
            assert [e.payload["domain"] for e in bus.of_type("user.domain.deleted.v1")] == ["learning-plan"]
            assert bus.dlq == []


async def test_migration_down_up_under_roles() -> None:
    from alembic import command
    from alembic.config import Config

    async with migrated_under_roles(SERVICE_DIR, make_settings, "lp_rb") as (settings, _roles):
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        await asyncio.to_thread(command.downgrade, cfg, "base")
        await asyncio.to_thread(command.upgrade, cfg, "head")
