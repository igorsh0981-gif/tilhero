"""Модели = миграции; миграции под ролью-владельцем, сервис — под своей ролью без DDL; проекция работает под ней;
CHECK схемы не пускает полный Telegram ID и PII удалённого ученика; миграция откатывается и накатывается снова."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import asyncpg
import httpx
import pytest
from alembic import command
from alembic.config import Config
from user_admin_testkit import SERVICE_DIR, VIEWER, fake_identity, fake_plans, plan, snapshot

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus, make_envelope, messaging_metadata
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    create_schema,
    ddl_allowed_for,
    drop_schema,
    internal_headers,
    migrated_under_roles,
    schema_drift,
    unique_schema,
)
from tilhero_user_admin.main import build_app
from tilhero_user_admin.models import Base
from tilhero_user_admin.settings import Settings


async def test_models_match_migrations_and_runtime_role() -> None:
    def make(**kw):
        return Settings(env="test", internal_jwt_secret="t" * 40, reconcile_enabled=False, **kw)

    async with migrated_under_roles(SERVICE_DIR, make, "ua_roles") as (settings, roles):
        assert await schema_drift(roles.runtime_url, roles.schema, [Base.metadata, messaging_metadata]) == []
        for table in ("admin_learner_summary", "ticket_refs", "reconcile_state", "inbox"):
            assert await ddl_allowed_for(roles.runtime_url, roles.schema, table) == [], table
        identity, plans = fake_identity(), fake_plans()
        snap = identity.put(snapshot(n=11))
        plans.put(plan(snap["user_id"]))
        bus = InMemoryBus()
        runtime = Runtime(settings, bus=bus)
        app = build_app(settings, runtime, identity_transport=httpx.MockTransport(identity.handler),
                        plans_transport=httpx.MockTransport(plans.handler))
        async with app.router.lifespan_context(app):
            assert await app.state.reconciler.identity.run_once() == 1
            assert await app.state.reconciler.plans.run_once() == 1
            await bus.publish(make_envelope(
                "support.ticket.created.v1",
                {"ticket_id": str(uuid.uuid4()), "number": "TCK-4001", "user_id": snap["user_id"],
                 "category": "other", "priority": "normal"},
                producer="support",
            ))
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://ua") as c:
                h = internal_headers(settings, issuer="admin-bff", actor=VIEWER)
                r = await c.get("/admin/v1/learners", headers=h)
                assert r.status_code == 200, r.text
                [item] = r.json()["items"]
                assert item["user_id"] == snap["user_id"] and item["open_tickets"] == 1
                assert item["goal"] == "travel" and item["onboarding_completed"] is True
                card = await c.get(f"/admin/v1/learners/{snap['user_id']}", headers=h)
                assert card.status_code == 200, card.text


@pytest.mark.parametrize("bad_sql", [
    # полный Telegram ID и иной формат маски
    "INSERT INTO admin_learner_summary (user_id, created_at, telegram_id_masked) VALUES ($1, now(), '987654321')",
    "INSERT INTO admin_learner_summary (user_id, created_at, telegram_id_masked) VALUES ($1, now(), '•••••••••')",
    # у детского профиля нет Telegram; опекун только у ребёнка
    "INSERT INTO admin_learner_summary (user_id, created_at, kind, username) VALUES ($1, now(), 'child', 'x')",
    "INSERT INTO admin_learner_summary (user_id, created_at, guardian_user_id) VALUES ($1, now(), gen_random_uuid())",
    # у удалённого не остаётся имени и плана
    "INSERT INTO admin_learner_summary (user_id, created_at, status, display_name) VALUES ($1, now(), 'DELETED', 'x')",
    "INSERT INTO admin_learner_summary (user_id, created_at, status, plan) VALUES ($1, now(), 'DELETED', '{}')",
    "INSERT INTO admin_learner_summary (user_id, created_at, age_band) VALUES ($1, now(), '5-6')",
])
async def test_schema_checks(env, bad_sql: str) -> None:
    conn = await asyncpg.connect(TEST_ADMIN_URL)
    try:
        await conn.execute(f'SET search_path = "{env.settings.db_schema}"')
        with pytest.raises(asyncpg.CheckViolationError):
            await conn.execute(bad_sql, uuid.uuid4())
        ok = "INSERT INTO admin_learner_summary (user_id, created_at, telegram_id_masked) VALUES ($1, now(), $2)"
        await conn.execute(ok, uuid.uuid4(), "•" * 6 + "789")
    finally:
        await conn.close()


async def test_migration_downgrade_and_upgrade_again() -> None:
    schema = unique_schema("ua_mig")
    await create_schema(schema)
    try:
        settings = Settings(env="test", internal_jwt_secret="t" * 40, reconcile_enabled=False,
                            database_url=TEST_ADMIN_URL, db_schema=schema)
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        await asyncio.to_thread(command.upgrade, cfg, "head")
        await asyncio.to_thread(command.downgrade, cfg, "base")
        await asyncio.to_thread(command.upgrade, cfg, "head")
        conn = await asyncpg.connect(TEST_ADMIN_URL)
        try:
            tables = {r["tablename"] for r in await conn.fetch(
                "SELECT tablename FROM pg_tables WHERE schemaname = $1", schema)}
        finally:
            await conn.close()
        assert {"admin_learner_summary", "ticket_refs", "reconcile_state", "inbox", "outbox"} <= tables
    finally:
        await drop_schema(schema)
