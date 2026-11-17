"""Ревью P6/P7: модели = миграции; миграции под ролью-владельцем, сервис — под своей ролью без DDL."""

from __future__ import annotations

import uuid

import httpx
from conftest import SERVICE_DIR

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus, make_envelope, messaging_metadata
from tilhero_common.testing import ddl_allowed_for, internal_headers, migrated_under_roles, schema_drift
from tilhero_learning_plan.main import build_app
from tilhero_learning_plan.models import Base
from tilhero_learning_plan.settings import Settings


async def test_models_match_migrations_and_runtime_role() -> None:
    def make(**kw):
        return Settings(env="test", internal_jwt_secret="t" * 40, **kw)

    async with migrated_under_roles(SERVICE_DIR, make, "pref_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in ("preference_profiles", "deleted_users", "outbox"):
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime)
        user = uuid.uuid4()
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://pref") as c:
                h = internal_headers(settings, subject=str(user))
                assert (await c.get("/internal/v1/me/preferences", headers=h)).status_code == 200
                # 6.3: новая колонка hotel_prefs (0002) пишется под ролью сервиса
                patch = {"search_horizon_months": 6, "hotel_prefs": {"rating_min": 9.0, "max_distance_km": 1},
                         "version": 1}
                r = await c.patch("/internal/v1/me/preferences", json=patch, headers=h)
                assert r.status_code == 200, r.text
                assert r.json()["hotel_prefs"] == {"rating_min": 9.0, "max_distance_km": 1, "min_stars": None}
                # 9.4: отметка «Что нового» (0003) пишется под ролью сервиса
                seen = await c.put("/internal/v1/me/release-notes/seen", headers=h,
                                   json={"release_note_id": str(uuid.uuid4()), "published_at": "2026-11-10T06:00:00Z"})
                assert seen.status_code == 200, seen.text
                await bus.publish(make_envelope(
                    "user.deletion.requested.v1",
                    {"user_id": str(user), "request_id": str(uuid.uuid4()),
                     "requested_at": "2026-10-08T10:00:00Z"},
                    producer="identity-consent",
                ))
            assert runtime.relay is not None
            await runtime.relay.drain()
            assert [e.payload["domain"] for e in bus.of_type("user.domain.deleted.v1")] == ["preferences"]


async def test_release_seen_migration_down_up_under_roles() -> None:
    """Ревью 9.4 (roles_rollback.py): отметка записана ролью сервиса → откат 0003 и подъём под владельцем."""
    import asyncio
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    def make(**kw):
        return Settings(env="test", internal_jwt_secret="t" * 40, **kw)

    async with migrated_under_roles(SERVICE_DIR, make, "pref_rb") as (settings, _roles):
        runtime = Runtime(settings, bus=InMemoryBus())
        app = build_app(settings, runtime)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://pref") as c:
                h = internal_headers(settings, subject=str(uuid.uuid4()))
                r = await c.put("/internal/v1/me/release-notes/seen", headers=h,
                                json={"release_note_id": str(uuid.uuid4()), "published_at": "2026-11-10T06:00:00Z"})
                assert r.status_code == 200, r.text
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        await asyncio.to_thread(command.downgrade, cfg, "0002")
        await asyncio.to_thread(command.upgrade, cfg, "head")
