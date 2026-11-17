"""Совместимость: код `main` (спринт 8) на схеме head (миграция 0003) — ревью спринта 9, БЭК-1.

Во время раскатки миграция 0003 применяется до смены кода (Pre-deploy), а при откате кода схема остаётся head. Старый
код создаёт запрос удаления без `next_retry_at` / `last_sent_at` и завершает его, не обнуляя `next_retry_at`.
SQL ниже повторяет ORM `main` (`services/identity-consent/src/tilhero_identity/service.py`: `request_deletion`,
`_anonymize`; модель `DeletionRequest` спринта 8 — только эти колонки). Новый код таких строк не ломается: таймер
достраивает расписание, чтение не показывает `next_retry_at` у завершённого.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import asyncpg
from conftest import SERVICE_DIR, make_settings

from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus
from tilhero_common.testing import create_service_roles, drop_service_roles, migrate, unique_schema
from tilhero_identity.deletion import store
from tilhero_identity.deletion.models import DeletionRequest
from tilhero_identity.deletion.sweeper import sweep_once

# INSERT, который выполняет SQLAlchemy для DeletionRequest(request_id, user_id, status, requested_at,
# expected_domains, acked_domains) модели main
MAIN_INSERT = ("INSERT INTO deletion_requests (request_id, user_id, status, requested_at, expected_domains, "
               "acked_domains) VALUES ($1, $2, 'REQUESTED', $3, $4, '{}')")
# _anonymize main: req.status = 'COMPLETED'; req.completed_at = now (+ acked_domains из on_domain_deleted)
MAIN_COMPLETE = ("UPDATE deletion_requests SET acked_domains = expected_domains, status = 'COMPLETED', "
                 "completed_at = $2 WHERE request_id = $1")
# request_deletion main при повторе: открытый запрос ищется только как REQUESTED
MAIN_FIND_OPEN = "SELECT request_id FROM deletion_requests WHERE user_id = $1 AND status = 'REQUESTED'"


def _plain(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


async def test_main_code_inserts_and_completes_on_head_schema_and_new_code_copes() -> None:
    schema = unique_schema("id_compat")
    roles = await create_service_roles(schema)
    settings = make_settings(schema, database_url=roles.runtime_url, migration_database_url=roles.owner_url)
    await migrate(SERVICE_DIR, settings)
    conn = await asyncpg.connect(_plain(roles.runtime_url), server_settings={"search_path": schema})
    runtime = Runtime(settings, bus=InMemoryBus())
    try:
        now = datetime.now(UTC)
        u_old, u_new = uuid.uuid4(), uuid.uuid4()
        for u in (u_old, u_new):
            await conn.execute("INSERT INTO users (user_id, status) VALUES ($1, 'DELETION_REQUESTED')", u)

        # 1. старый код создаёт запрос (раскатка: новый identity-consent ещё не поднят) — схема принимает
        old_rid = uuid.uuid4()
        await conn.execute(MAIN_INSERT, old_rid, u_old, now - timedelta(minutes=20), ["news", "support"])
        assert await conn.fetchval(MAIN_FIND_OPEN, u_old) == old_rid

        # 2. запрос нового кода (с расписанием) завершает старый код (откат кода) — схема принимает
        new_rid = uuid.uuid4()
        await conn.execute(
            "INSERT INTO deletion_requests (request_id, user_id, status, requested_at, expected_domains, "
            "acked_domains, attempts, last_sent_at, next_retry_at) VALUES ($1, $2, 'REQUESTED', $3, '{news}', '{}', "
            "1, $3, $4)", new_rid, u_new, now - timedelta(minutes=5), now + timedelta(minutes=10))
        await conn.execute(MAIN_COMPLETE, new_rid, now)
        row = await conn.fetchrow("SELECT status, completed_at, next_retry_at FROM deletion_requests "
                                  "WHERE request_id = $1", new_rid)
        assert row["status"] == "COMPLETED" and row["completed_at"] is not None
        assert row["next_retry_at"] is not None  # старый код его не обнуляет

        # 3. новый код: таймер достраивает расписание запросу старого кода (20 мин > первой точки 15 мин → повтор),
        #    завершённый с next_retry_at не трогает
        await runtime.start()
        result = await sweep_once(runtime, now=now)
        assert (result.leader, result.retried, result.stuck) == (True, 1, 0)
        got = await conn.fetchrow("SELECT status, attempts, last_sent_at, next_retry_at FROM deletion_requests "
                                  "WHERE request_id = $1", old_rid)
        assert got["status"] == "REQUESTED" and got["attempts"] == 2
        assert got["last_sent_at"] == now and got["next_retry_at"] > now
        assert (await conn.fetchval("SELECT attempts FROM deletion_requests WHERE request_id = $1", new_rid)) == 1

        # 4. чтение нового кода: у завершённого старым кодом next_retry_at наружу не выходит
        async with runtime.transaction() as session:
            done = await session.get(DeletionRequest, new_rid)
            assert done is not None
            assert store.row_view(done).next_retry_at is None
            assert (await store.detail_view(session, done)).next_retry_at is None

        # 5. старый код завершает запрос, который новый код уже повторял — тоже без ошибок схемы
        await conn.execute(MAIN_COMPLETE, old_rid, now + timedelta(minutes=1))
        assert (await sweep_once(runtime, now=now + timedelta(days=2))).retried == 0
    finally:
        await runtime.stop()
        await conn.close()
        await drop_service_roles(roles)
