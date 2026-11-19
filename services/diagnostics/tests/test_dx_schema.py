"""Модели = миграции (schema_drift); миграции под ролью-владельцем, сервис — под своей ролью без DDL и без права
снять триггеры неизменяемости; откат/подъём; сид — опубликованные v1 с записью аудита; сквозной прогон под ролями."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import httpx
from conftest import SERVICE_DIR, make_settings
from dx_testkit import FakeCatalog

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus, make_envelope, messaging_metadata
from tilhero_common.testing import (
    assert_event_conforms,
    ddl_allowed_for,
    internal_headers,
    migrated_under_roles,
    schema_drift,
)
from tilhero_diagnostics.main import build_app
from tilhero_diagnostics.models import Base

TABLES = ("tests", "sessions", "answers", "results", "skill_states", "skill_evidence", "learner_profiles",
          "deleted_users", "outbox", "inbox")


async def test_models_match_migrations_and_runtime_role() -> None:
    async with migrated_under_roles(SERVICE_DIR, make_settings, "dx_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in TABLES:
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        catalog = FakeCatalog()
        app = build_app(settings, runtime, catalog_transport=httpx.MockTransport(catalog.handler))
        user = uuid.uuid4()
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://dx") as c:
                h = internal_headers(settings, subject=str(user))
                r = await c.post("/internal/v1/diagnostics/sessions", headers={**h, "Idempotency-Key": "k-roles-1"})
                assert r.status_code == 201, r.text
                sid = r.json()["session_id"]
                item = (await c.get(f"/internal/v1/diagnostics/sessions/{sid}/next", headers=h)).json()
                r = await c.post(f"/internal/v1/diagnostics/sessions/{sid}/answers", headers=h,
                                 json={"item_id": item["item_id"], "answer": None, "dont_know": True, "time_ms": 1})
                assert r.status_code == 200, r.text
                r = await c.post(f"/internal/v1/diagnostics/sessions/{sid}/finish", headers=h)
                assert r.status_code == 200, r.text
                await bus.publish(make_envelope(
                    "user.deletion.requested.v1",
                    {"user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-11-19T10:00:00Z"},
                    producer="identity-consent"))
                assert (await c.get("/health/ready")).status_code == 200
            assert runtime.relay is not None
            await runtime.relay.drain()
        assert [e.payload["domain"] for e in bus.of_type("user.domain.deleted.v1")] == ["diagnostics"]
        assert len(bus.of_type("diagnostics.completed.v1")) == 1
        # сид: две опубликованные версии и запись аудита на каждую (actor seed)
        seeded = [e for e in bus.of_type("admin.audit.recorded.v1") if e.payload["actor_id"] == "seed"]
        assert sorted(e.payload["object_id"] for e in seeded) == ["dx-en-adult@1", "dx-en-kids@1"]
        for e in seeded:
            assert_event_conforms(e)
            assert e.producer == "diagnostics" and e.payload["action"] == "diagnostics.test_published"
        assert bus.dlq == []


async def test_migration_down_up_under_roles() -> None:
    from alembic import command
    from alembic.config import Config

    async with migrated_under_roles(SERVICE_DIR, make_settings, "dx_rb") as (settings, _roles):
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        await asyncio.to_thread(command.downgrade, cfg, "0001")
        await asyncio.to_thread(command.downgrade, cfg, "base")
        await asyncio.to_thread(command.upgrade, cfg, "head")
