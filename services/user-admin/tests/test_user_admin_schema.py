"""Модели = миграции; миграции под ролью-владельцем, сервис — под своей ролью без DDL; проекция работает под ней;
CHECK схемы не пускает полный Telegram ID и PII удалённого ученика; миграция откатывается и накатывается снова."""

from __future__ import annotations

import asyncio
import importlib.util
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
from tilhero_user_admin.domain.projection import search_text
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


async def test_migration_0002_recomputes_search_text_without_username() -> None:
    """Ревью P2-9: строки, записанные до 35c3fd1 (search_text = lower(имя + username)), после 0002 ищутся только по
    имени — как пишет код (`projection.search_text`); пачки по user_id (> 1000 строк); удалённые не трогаются."""
    schema = unique_schema("ua_m2")
    await create_schema(schema)
    try:
        settings = Settings(env="test", internal_jwt_secret="t" * 40, reconcile_enabled=False,
                            database_url=TEST_ADMIN_URL, db_schema=schema)
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        await asyncio.to_thread(command.upgrade, cfg, "0001")
        named, nameless, child, deleted = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        conn = await asyncpg.connect(TEST_ADMIN_URL)
        try:
            await conn.execute(f'SET search_path = "{schema}"')
            insert = ("INSERT INTO admin_learner_summary (user_id, created_at, kind, status, display_name, username, "
                      "search_text) VALUES ($1, now(), $2, $3, $4, $5, $6)")
            await conn.execute(insert, named, "account", "ACTIVE", "  Игорь Ш. ", "igor_81", "игорь ш. igor_81")
            await conn.execute(insert, nameless, "account", "ACTIVE", None, "secret_user", "secret_user")
            await conn.execute(insert, child, "child", "ACTIVE", "Малика", None, "малика")
            await conn.execute(insert, deleted, "account", "DELETED", None, None, None)
            await conn.execute(
                "INSERT INTO admin_learner_summary (user_id, created_at, display_name, username, search_text) "
                "SELECT gen_random_uuid(), now(), 'Ученик ' || g, 'learner_' || g, 'ученик ' || g || ' learner_' || g "
                "FROM generate_series(1, 2500) AS g")
            await asyncio.to_thread(command.upgrade, cfg, "head")
            rows = await conn.fetch("SELECT user_id, display_name, username, search_text FROM admin_learner_summary")
        finally:
            await conn.close()
        by_id = {r["user_id"]: r for r in rows}
        assert len(rows) == 2504
        assert by_id[named]["search_text"] == "игорь ш." and by_id[named]["username"] == "igor_81"
        assert by_id[nameless]["search_text"] is None and by_id[nameless]["username"] == "secret_user"
        assert by_id[child]["search_text"] == "малика" and by_id[deleted]["search_text"] is None
        for r in rows:
            assert r["search_text"] == search_text(r["display_name"])  # как пишет код сервиса
            if r["username"]:
                assert r["username"] not in (r["search_text"] or "")
        await asyncio.to_thread(command.downgrade, cfg, "0001")  # откат данных не возвращает
        await asyncio.to_thread(command.upgrade, cfg, "head")
    finally:
        await drop_schema(schema)


def test_migration_0002_search_text_matches_code() -> None:
    """Функция миграции (без зависимости от кода сервиса) = projection.search_text."""
    spec = importlib.util.spec_from_file_location(
        "ua_m0002", Path(SERVICE_DIR) / "migrations" / "versions" / "0002_search_text_without_username.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for value in (None, "", "   ", " Алишер ", "ANNA", "Ölçü İ", "Шахзода ", "a\tb"):
        assert module.search_text(value) == search_text(value), value


async def test_migration_0003_game_category() -> None:
    """Спринт 7: категория уведомлений game в карточке (admin.ts) — 0003 включает её в спроецированных настройках (как
    identity-consent 0005 у источника), строки без настроек не трогает; откат убирает ключ."""
    schema = unique_schema("ua_m3")
    await create_schema(schema)
    try:
        settings = Settings(env="test", internal_jwt_secret="t" * 40, reconcile_enabled=False,
                            database_url=TEST_ADMIN_URL, db_schema=schema)
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        await asyncio.to_thread(command.upgrade, cfg, "0002")
        with_settings, without, already = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        conn = await asyncpg.connect(TEST_ADMIN_URL)
        try:
            await conn.execute(f'SET search_path = "{schema}"')
            insert = "INSERT INTO admin_learner_summary (user_id, created_at, notifications) VALUES ($1, now(), $2)"
            await conn.execute(insert, with_settings, '{"enabled": true, "categories": {"support": true, '
                                                      '"reminders": false}}')
            await conn.execute(insert, without, None)
            await conn.execute(insert, already, '{"enabled": false, "categories": {"support": true, "game": false}}')
            await asyncio.to_thread(command.upgrade, cfg, "head")
            rows = {r["user_id"]: r["n"] for r in await conn.fetch(
                "SELECT user_id, notifications::text AS n FROM admin_learner_summary")}
            assert '"game": true' in rows[with_settings] and rows[without] is None
            assert '"game": false' in rows[already]  # значение источника не перетирается
            await asyncio.to_thread(command.downgrade, cfg, "0002")
            rows = {r["user_id"]: r["n"] for r in await conn.fetch(
                "SELECT user_id, notifications::text AS n FROM admin_learner_summary")}
            assert all("game" not in (n or "") for n in rows.values())
            await asyncio.to_thread(command.upgrade, cfg, "head")
        finally:
            await conn.close()
    finally:
        await drop_schema(schema)


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
