"""Спринт 9 (ADR-009, INTERNAL_API §1.5): «удаление зависло» в read-модели — проекция `user.deletion.stuck.v1` от
identity-consent, колонка `deletion_stuck_at` в строке и карточке, стирание при DELETED; миграция 0004 под ролями."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from pathlib import Path

import asyncpg
from alembic import command
from alembic.config import Config
from user_admin_testkit import SERVICE_DIR, now, snapshot

from tilhero_common.messaging import make_envelope, messaging_metadata
from tilhero_common.testing import (
    assert_event_conforms,
    create_service_roles,
    drop_service_roles,
    migrate,
    schema_drift,
    unique_schema,
)
from tilhero_user_admin.models import Base, UserSummary
from tilhero_user_admin.settings import Settings

ID = "identity-consent"


def stuck_event(uid: str, request_id: str, producer: str = ID, at=None):
    at = at or now()
    ev = make_envelope("user.deletion.stuck.v1", {
        "request_id": request_id, "user_id": uid, "requested_at": (at - timedelta(hours=24)).isoformat(),
        "stuck_at": at.isoformat(), "pending_domains": ["watch", "news"], "attempts": 6}, producer=producer)
    assert_event_conforms(ev)
    return ev


async def seed(env, uid: str, **kw) -> None:
    """Профиль из снимка identity-consent (карточка требует authoritative-данных)."""
    env.identity.put(snapshot(uid, updated_at=now() - timedelta(hours=1), **kw))
    await env.sync.run_once()


async def summary(env, uid: str) -> UserSummary:
    async with env.runtime.transaction() as s:
        row = await s.get(UserSummary, uuid.UUID(uid))
        assert row is not None
        return row


async def test_stuck_flag_is_projected_and_cleared_on_deleted(env) -> None:
    uid, req = str(uuid.uuid4()), str(uuid.uuid4())
    await seed(env, uid, status="DELETION_REQUESTED")
    await env.emit("user.deletion.requested.v1", {"user_id": uid, "request_id": req,
                                                  "requested_at": now().isoformat(), "attempt": 1}, producer=ID)
    ev = stuck_event(uid, req)
    await env.deliver(ev, times=2)  # повторная доставка — inbox
    row = await summary(env, uid)
    assert row.status == "DELETION_REQUESTED" and row.deletion_stuck_at is not None
    assert row.deletion_stuck_at.isoformat() == ev.payload["stuck_at"]

    card = await env.get(f"/admin/v1/users/{uid}")
    assert card.status_code == 200 and card.json()["deletion_stuck_at"] is not None
    page = await env.get("/admin/v1/users", params={"status": "DELETION_REQUESTED"})
    [item] = page.json()["items"]
    assert item["user_id"] == uid and item["deletion_stuck_at"] == card.json()["deletion_stuck_at"]

    # удаление завершилось (после «Повторить запрос») — признак стирается вместе с PII
    await env.emit("user.domain.deleted.v1", {"user_id": uid, "request_id": req, "domain": ID,
                                              "mode": "anonymized"}, producer=ID)
    row = await summary(env, uid)
    assert row.status == "DELETED" and row.deletion_stuck_at is None
    # запоздавшее «зависло» после DELETED ничего не меняет
    await env.deliver(stuck_event(uid, req))
    row = await summary(env, uid)
    assert row.status == "DELETED" and row.deletion_stuck_at is None
    assert (await env.get(f"/admin/v1/users/{uid}")).json()["deletion_stuck_at"] is None


async def test_stuck_before_requested_and_foreign_producer(env) -> None:
    uid, req = str(uuid.uuid4()), str(uuid.uuid4())
    await env.deliver(stuck_event(uid, req, producer="ops-monitor"))  # чужой издатель — без данных
    async with env.runtime.transaction() as s:
        assert await s.get(UserSummary, uuid.UUID(uid)) is None
    # «зависло» пришло раньше запроса удаления (порядок не гарантирован)
    await env.deliver(stuck_event(uid, req))
    row = await summary(env, uid)
    assert row.status == "DELETION_REQUESTED" and row.deletion_stuck_at is not None
    await env.emit("user.deletion.requested.v1", {"user_id": uid, "request_id": req,
                                                  "requested_at": now().isoformat()}, producer=ID,
                   occurred_at=now() - timedelta(days=1))
    row = await summary(env, uid)
    assert row.status == "DELETION_REQUESTED" and row.deletion_stuck_at is not None


async def test_row_without_stuck_has_null(env) -> None:
    uid = str(uuid.uuid4())
    await seed(env, uid)
    assert (await env.get(f"/admin/v1/users/{uid}")).json()["deletion_stuck_at"] is None


async def test_migration_0004_under_roles_and_back() -> None:
    schema = unique_schema("ua_0004")
    roles = await create_service_roles(schema)
    settings = Settings(env="test", internal_jwt_secret="t" * 40, sync_enabled=False, database_url=roles.runtime_url,
                        migration_database_url=roles.owner_url, db_schema=schema)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = settings
    rt = await asyncpg.connect(roles.runtime_url.replace("postgresql+asyncpg://", "postgresql://"),
                               server_settings={"search_path": schema})
    try:
        await migrate(SERVICE_DIR, settings, "0003")
        uid = uuid.uuid4()
        await rt.execute("INSERT INTO admin_user_summary (user_id, status, created_at) "
                         "VALUES ($1, 'DELETION_REQUESTED', now())", uid)
        await migrate(SERVICE_DIR, settings)
        assert await schema_drift(roles.runtime_url, schema, [Base.metadata, messaging_metadata]) == []
        await rt.execute("UPDATE admin_user_summary SET deletion_stuck_at = now() WHERE user_id = $1", uid)
        try:
            await rt.execute("UPDATE admin_user_summary SET status = 'DELETED' WHERE user_id = $1", uid)
            raise AssertionError("DELETED with deletion_stuck_at accepted")
        except asyncpg.CheckViolationError:
            pass
        await asyncio.to_thread(command.downgrade, cfg, "0003")
        cols = {r[0] for r in await rt.fetch("SELECT column_name FROM information_schema.columns "
                                             "WHERE table_schema = $1 AND table_name = 'admin_user_summary'", schema)}
        assert "deletion_stuck_at" not in cols
        assert await rt.fetchval("SELECT status FROM admin_user_summary WHERE user_id = $1", uid) == \
            "DELETION_REQUESTED"
        await migrate(SERVICE_DIR, settings)
        assert await rt.fetchval("SELECT deletion_stuck_at FROM admin_user_summary WHERE user_id = $1", uid) is None
    finally:
        await rt.close()
        await drop_service_roles(roles)
