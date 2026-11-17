"""Миграция identity-consent 0003 (сага удаления) под ролями как в prod: вверх поверх данных спринтов 1–8 (перенос ACK,
история, расписание), рантайм-роль работает с новыми таблицами без DDL, откат STUCK → REQUESTED и повторный подъём."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import asyncpg
from alembic import command
from alembic.config import Config
from conftest import SERVICE_DIR, make_settings

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus, messaging_metadata
from tilhero_common.testing import (
    create_service_roles,
    ddl_allowed_for,
    drop_service_roles,
    migrate,
    schema_drift,
    unique_schema,
)
from tilhero_identity.deletion.sweeper import sweep_once
from tilhero_identity.models import Base

NEW_TABLES = ("deletion_attempts", "deletion_domain_acks", "deletion_idempotency_keys")


def _downgrade(settings, revision: str) -> None:
    cfg = Config(f"{SERVICE_DIR}/alembic.ini")
    cfg.set_main_option("script_location", f"{SERVICE_DIR}/migrations")
    cfg.attributes["settings"] = settings
    command.downgrade(cfg, revision)


def _plain(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


async def test_migration_0003_up_down_under_roles() -> None:
    schema = unique_schema("id_del3")
    roles = await create_service_roles(schema)
    settings = make_settings(schema, database_url=roles.runtime_url, migration_database_url=roles.owner_url)
    owner = await asyncpg.connect(_plain(roles.owner_url), server_settings={"search_path": schema})
    runtime_conn = await asyncpg.connect(_plain(roles.runtime_url), server_settings={"search_path": schema})
    try:
        await migrate(SERVICE_DIR, settings, "0002")
        # данные до спринта 9: открытый запрос с двумя ACK (вчера), открытый свежий, завершённый
        now = datetime.now(UTC)
        users = [uuid.uuid4() for _ in range(3)]
        for u, status in zip(users, ("DELETION_REQUESTED", "DELETION_REQUESTED", "DELETED"), strict=True):
            await runtime_conn.execute("INSERT INTO users (user_id, status) VALUES ($1, $2)", u, status)
        old, fresh, done = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        rows = [
            (old, users[0], "REQUESTED", now - timedelta(hours=30), None, ["support", "news"], ["support", "news"]),
            (fresh, users[1], "REQUESTED", now - timedelta(minutes=5), None, ["support", "news"], []),
            (done, users[2], "COMPLETED", now - timedelta(days=3), now - timedelta(days=2), ["news"], ["news"]),
        ]
        for r in rows:
            await runtime_conn.execute(
                "INSERT INTO deletion_requests (request_id, user_id, status, requested_at, completed_at, "
                "expected_domains, acked_domains) VALUES ($1, $2, $3, $4, $5, $6, $7)", *r)
        await runtime_conn.execute("UPDATE deletion_requests SET acked_domains = '{support}' WHERE request_id = $1",
                                   old)

        await migrate(SERVICE_DIR, settings)
        assert await schema_drift(roles.runtime_url, schema, [Base.metadata, messaging_metadata]) == []
        for table in (*NEW_TABLES, "deletion_requests"):
            assert await ddl_allowed_for(roles.runtime_url, schema, table) == [], table
        got = {r["request_id"]: r for r in await runtime_conn.fetch(
            "SELECT request_id, status, attempts, last_sent_at, next_retry_at, requested_at, stuck_at "
            "FROM deletion_requests")}
        for rid in (old, fresh):
            r = got[rid]
            assert (r["status"], r["attempts"], r["stuck_at"]) == ("REQUESTED", 1, None)
            assert r["last_sent_at"] == r["requested_at"]
            assert r["next_retry_at"] == r["requested_at"] + timedelta(minutes=15)
        assert (got[done]["attempts"], got[done]["next_retry_at"]) == (1, None)
        acks = await runtime_conn.fetch("SELECT request_id, domain, acked_at, mode, event_id FROM deletion_domain_acks "
                                        "ORDER BY domain")
        assert [(a["request_id"], a["domain"]) for a in acks] == [(done, "news"), (old, "support")]
        assert all(a["acked_at"] is None and a["mode"] is None and a["event_id"] is None for a in acks)
        hist = await runtime_conn.fetch("SELECT request_id, attempt, sent_by, sent_at FROM deletion_attempts")
        assert sorted((h["request_id"], h["attempt"], h["sent_by"]) for h in hist) == sorted(
            (rid, 1, "user") for rid in (old, fresh, done))
        # частичный UNIQUE «открыт» включает STUCK
        await runtime_conn.execute("UPDATE deletion_requests SET status = 'STUCK', stuck_at = now() "
                                   "WHERE request_id = $1", old)
        try:
            await runtime_conn.execute(
                "INSERT INTO deletion_requests (request_id, user_id, status, requested_at, expected_domains, "
                "next_retry_at) VALUES ($1, $2, 'REQUESTED', now(), '{}', now())", uuid.uuid4(), users[0])
            raise AssertionError("second open request accepted")
        except asyncpg.UniqueViolationError:
            pass
        await runtime_conn.execute("UPDATE deletion_requests SET status = 'REQUESTED', stuck_at = NULL "
                                   "WHERE request_id = $1", old)

        # рантайм под ролью сервиса: таймер переводит вчерашний запрос в STUCK и повторяет оба открытых
        runtime = Runtime(settings, bus=InMemoryBus())
        await runtime.start()
        try:
            result = await sweep_once(runtime)
            assert (result.leader, result.retried, result.stuck) == (True, 1, 1)
            # свежему (5 мин) рано; вчерашнему — повтор и STUCK; ему же — новая точка через сутки
            await runtime_conn.execute("UPDATE deletion_requests SET next_retry_at = now() - interval '1 minute' "
                                       "WHERE request_id = $1", fresh)
            assert (await sweep_once(runtime)).retried == 1
            await runtime_conn.execute(
                "INSERT INTO deletion_idempotency_keys (actor_id, key, fingerprint) VALUES ('s', 'k', 'f')")
            await runtime_conn.execute("DELETE FROM deletion_idempotency_keys")
        finally:
            await runtime.stop()
        state = {r["request_id"]: (r["status"], r["attempts"]) for r in await runtime_conn.fetch(
            "SELECT request_id, status, attempts FROM deletion_requests")}
        assert state == {old: ("STUCK", 2), fresh: ("REQUESTED", 2), done: ("COMPLETED", 1)}

        # откат: STUCK → REQUESTED, новые таблицы и колонки уходят, данные запросов на месте
        await asyncio.to_thread(_downgrade, settings, "0002")
        tables = {r[0] for r in await owner.fetch(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1", schema)}
        assert not tables & set(NEW_TABLES)
        cols = {r[0] for r in await owner.fetch(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 "
            "AND table_name = 'deletion_requests'", schema)}
        assert not cols & {"attempts", "last_sent_at", "next_retry_at", "stuck_at", "last_retry_by"}
        assert {r["request_id"]: r["status"] for r in await owner.fetch(
            "SELECT request_id, status FROM deletion_requests")} == {old: "REQUESTED", fresh: "REQUESTED",
                                                                     done: "COMPLETED"}
        try:
            await owner.execute("UPDATE deletion_requests SET status = 'STUCK' WHERE request_id = $1", old)
            raise AssertionError("STUCK accepted by 0002 constraint")
        except asyncpg.CheckViolationError:
            pass

        # повторный подъём (идемпотентный перенос)
        await migrate(SERVICE_DIR, settings)
        assert await schema_drift(roles.runtime_url, schema, [Base.metadata, messaging_metadata]) == []
        assert await owner.fetchval("SELECT count(*) FROM deletion_attempts") == 3
        assert await owner.fetchval("SELECT count(*) FROM deletion_domain_acks") == 2
    finally:
        await owner.close()
        await runtime_conn.close()
        await drop_service_roles(roles)
