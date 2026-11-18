"""Модели = миграции; миграции под ролью-владельцем, сервис — под своей ролью без DDL; проекция работает под ней."""

from __future__ import annotations

import uuid

import httpx
from user_admin_testkit import SERVICE_DIR, VIEWER, FakeIdentity, snapshot

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus, make_envelope, messaging_metadata
from tilhero_common.testing import ddl_allowed_for, internal_headers, migrated_under_roles, schema_drift
from tilhero_user_admin.main import build_app
from tilhero_user_admin.models import Base
from tilhero_user_admin.settings import Settings


async def test_models_match_migrations_and_runtime_role() -> None:
    def make(**kw):
        return Settings(env="test", internal_jwt_secret="t" * 40, sync_enabled=False, **kw)

    async with migrated_under_roles(SERVICE_DIR, make, "ua_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in ("admin_user_summary", "ticket_refs", "sync_state", "inbox"):
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        identity = FakeIdentity()
        snap = identity.put(snapshot(n=11))
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime, identity_transport=httpx.MockTransport(identity.handler))
        async with app.router.lifespan_context(app):
            assert await app.state.identity_sync.run_once() == 1
            await bus.publish(make_envelope(
                "support.ticket.created.v1",
                {"ticket_id": str(uuid.uuid4()), "number": "TCK-4001", "user_id": snap["user_id"],
                 "category": "OTHER", "priority": "normal"},
                producer="support",
            ))
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://ua") as c:
                h = internal_headers(settings, issuer="admin-bff", actor=VIEWER)
                r = await c.get("/admin/v1/users", headers=h)
                assert r.status_code == 200, r.text
                [item] = r.json()["items"]
                assert item["user_id"] == snap["user_id"] and item["open_tickets"] == 1


async def test_migration_0003_over_existing_data_and_back() -> None:
    """Спринт 8: 0003 (индекс last_seen_at) поверх 0002 с данными; откат и повтор."""
    import asyncio
    from pathlib import Path

    import asyncpg
    from alembic import command
    from alembic.config import Config

    from tilhero_common.testing import TEST_ADMIN_URL, create_schema, drop_schema, unique_schema

    schema = unique_schema("ua_0003")
    await create_schema(schema)
    try:
        settings = Settings(env="test", internal_jwt_secret="t" * 40, sync_enabled=False,
                            database_url=TEST_ADMIN_URL, db_schema=schema)
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        await asyncio.to_thread(command.upgrade, cfg, "0002")
        conn = await asyncpg.connect(TEST_ADMIN_URL)
        try:
            await conn.execute(f'SET search_path = "{schema}"')
            await conn.execute("INSERT INTO admin_user_summary (user_id, status, created_at, last_seen_at) "
                               "VALUES (gen_random_uuid(), 'ACTIVE', now(), now())")
            await asyncio.to_thread(command.upgrade, cfg, "head")
            assert await conn.fetchval("SELECT count(*) FROM admin_user_summary") == 1
            idx = await conn.fetchval("SELECT count(*) FROM pg_indexes WHERE schemaname = $1 "
                                      "AND indexname = 'ix_summary_last_seen'", schema)
            assert idx == 1
            await asyncio.to_thread(command.downgrade, cfg, "0002")
            await asyncio.to_thread(command.upgrade, cfg, "head")
            assert await conn.fetchval("SELECT count(*) FROM admin_user_summary") == 1
        finally:
            await conn.close()
    finally:
        await drop_schema(schema)
