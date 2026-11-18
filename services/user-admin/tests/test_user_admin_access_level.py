"""Спринт 7 (INTERNAL_API §2.7, §4, §7): уровень доступа к AI в read-модели — потребитель
`user.access_level.changed.v1` (ai-control), отображение в списке и карточке, фильтр, порядок по версии, очистка при
удалении, миграция 0002 (откат и повтор), чужие издатели и вызывающие."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from sqlalchemy import text
from user_admin_testkit import ANALYST, SERVICE_DIR, VIEWER, now, snapshot

from tilhero_common.messaging import make_envelope
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    assert_event_conforms,
    create_schema,
    drop_schema,
    internal_headers,
    migrate,
    unique_schema,
)
from tilhero_user_admin.models import UserSummary

AI = "ai-control"
EV = "user.access_level.changed.v1"
ID = "identity-consent"
CONTRACT = Path(SERVICE_DIR).parents[1] / "packages" / "contracts" / "events" / f"{EV}.schema.json"
# Зеркало §7 INTERNAL_API до генерации схемы интегратором (infra/scripts/gen_event_schemas.py)
PAYLOAD_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["user_id", "level", "source", "expires_at", "version"],
    "properties": {
        "user_id": {"type": "string", "format": "uuid"},
        "level": {"type": "string", "pattern": "^[a-z][a-z0-9_]{1,31}$"},
        "source": {"type": "string", "enum": ["default", "manual"]},
        "expires_at": {"type": ["string", "null"], "format": "date-time"},
        "version": {"type": "integer", "minimum": 1},
    },
}


def payload(uid: str, level: str = "plus", source: str = "manual", version: int = 1,
            expires_at: str | None = None) -> dict[str, Any]:
    return {"user_id": uid, "level": level, "source": source, "expires_at": expires_at, "version": version}


async def seed(env, n: int = 0, **kw) -> str:
    snap = env.identity.put(snapshot(n=n, **kw))
    await env.sync.run_once()
    return snap["user_id"]


async def level_event(env, uid: str, *, producer: str = AI, **kw) -> None:
    await env.emit(EV, payload(uid, **kw), producer=producer)


async def summary(env, uid: str) -> UserSummary:
    async with env.runtime.transaction() as s:
        r = await s.get(UserSummary, uuid.UUID(uid))
        assert r is not None
        return r


async def listed(env, query: str = "") -> dict[str, dict]:
    r = await env.get(f"/admin/v1/users?{query}")
    assert r.status_code == 200, r.text
    return {i["user_id"]: i["access_level"] for i in r.json()["items"]}


# ---------------------------------------------------------------- контракт события

def test_event_payload_matches_contract() -> None:
    uid = str(uuid.uuid4())
    samples = [payload(uid), payload(uid, expires_at="2026-11-12T00:00:00Z", version=2),
               payload(uid, level="basic", source="default", version=3)]
    for p in samples:
        env = make_envelope(EV, p, producer=AI)
        if CONTRACT.exists():
            assert_event_conforms(env)
        else:
            jsonschema.validate(p, PAYLOAD_SCHEMA, format_checker=jsonschema.FormatChecker())
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({**samples[0], "reason": "текст"}, PAYLOAD_SCHEMA)  # без причины и PII в событии


# ---------------------------------------------------------------- проекция

async def test_manual_assignment_shown_in_list_and_card(env) -> None:
    uid = await seed(env, 1)
    other = await seed(env, 2)
    assert (await listed(env))[uid] == {"level": None, "source": "default", "expires_at": None}  # событий не было
    until = (now() + timedelta(days=30)).replace(microsecond=0)
    await level_event(env, uid, expires_at=until.isoformat().replace("+00:00", "Z"))
    rows = await listed(env)
    assert rows[uid]["level"] == "plus" and rows[uid]["source"] == "manual"
    assert rows[uid]["expires_at"].startswith(until.strftime("%Y-%m-%dT%H:%M:%S"))
    assert rows[other] == {"level": None, "source": "default", "expires_at": None}
    card = await env.get(f"/admin/v1/users/{uid}")
    assert card.status_code == 200 and card.json()["access_level"] == rows[uid]
    r = await summary(env, uid)
    assert (r.access_level, r.access_level_source, r.access_level_version) == ("plus", "manual", 1)


async def test_reset_to_default_and_version_order(env) -> None:
    uid = await seed(env, 3)
    await level_event(env, uid, version=2)
    await level_event(env, uid, level="basic", source="default", version=3)
    assert (await listed(env))[uid] == {"level": "basic", "source": "default", "expires_at": None}
    # запоздавшее событие (версия 2) и повтор той же версии ничего не меняют
    await level_event(env, uid, level="vip", version=2)
    await level_event(env, uid, level="vip", version=3)
    assert (await summary(env, uid)).access_level == "basic"
    # новое назначение после сброса
    await level_event(env, uid, level="vip", version=4)
    assert (await listed(env))[uid] == {"level": "vip", "source": "manual", "expires_at": None}


async def test_duplicate_delivery_is_idempotent(env) -> None:
    uid = await seed(env, 4)
    ev = make_envelope(EV, payload(uid, version=1), producer=AI)
    await env.deliver(ev, times=3)
    await asyncio.gather(*[env.deliver(make_envelope(EV, payload(uid, level=f"l{v}x", version=v), producer=AI))
                           for v in range(2, 7)])
    r = await summary(env, uid)
    assert (r.access_level, r.access_level_version) == ("l6x", 6)  # победила старшая версия независимо от порядка


async def test_expired_manual_assignment_is_default(env) -> None:
    uid = await seed(env, 5)
    past = (now() - timedelta(minutes=1)).isoformat()
    await level_event(env, uid, expires_at=past)
    assert (await listed(env))[uid] == {"level": None, "source": "default", "expires_at": None}
    assert uid not in await listed(env, "access_level=plus")
    assert uid in await listed(env, "access_level_source=default")
    assert uid not in await listed(env, "access_level_source=manual")


async def test_list_filters(env) -> None:
    plus = await seed(env, 6)
    vip = await seed(env, 7)
    reset = await seed(env, 8)
    plain = await seed(env, 9)
    await level_event(env, plus)
    await level_event(env, vip, level="vip")
    await level_event(env, reset, version=1)
    await level_event(env, reset, level="basic", source="default", version=2)
    assert set(await listed(env, "access_level=plus")) == {plus}
    assert set(await listed(env, "access_level=plus,vip")) == {plus, vip}
    assert set(await listed(env, "access_level=basic")) == set()  # уровень по умолчанию — через source=default
    assert set(await listed(env, "access_level_source=manual")) == {plus, vip}
    assert set(await listed(env, "access_level_source=default")) == {reset, plain}
    assert set(await listed(env, "access_level=vip&access_level_source=manual")) == {vip}
    assert set(await listed(env, "access_level=vip&q=tester_6")) == set()  # фильтры складываются
    # курсор вместе с фильтром
    r = await env.get("/admin/v1/users?access_level_source=default&limit=1")
    first = r.json()
    assert len(first["items"]) == 1 and first["next_cursor"]
    nxt = await env.get(f"/admin/v1/users?access_level_source=default&limit=1&cursor={first['next_cursor']}")
    assert {first["items"][0]["user_id"], nxt.json()["items"][0]["user_id"]} == {reset, plain}


@pytest.mark.parametrize("query", ["access_level=Plus", "access_level=p", "access_level=plus;drop",
                                   "access_level=" + ",".join(f"l{i}x" for i in range(11))])
async def test_invalid_access_level_filter(env, query: str) -> None:
    r = await env.get(f"/admin/v1/users?{query}")
    assert r.status_code == 422 and r.json()["code"] == "USER_FILTER_INVALID", r.text


async def test_invalid_access_level_source(env) -> None:
    r = await env.get("/admin/v1/users?access_level_source=subscription")
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize("bad", [
    {"level": "Plus"}, {"level": None}, {"source": "subscription"}, {"version": 0}, {"version": "2"},
    {"version": True}, {"expires_at": "2026-11-12T00:00:00"}, {"expires_at": "завтра"},
    {"source": "default", "level": "basic", "expires_at": "2027-01-01T00:00:00Z"},
])
async def test_invalid_payload_ignored(env, bad: dict[str, Any]) -> None:
    uid = await seed(env, 10)
    await env.emit(EV, {**payload(uid), **bad}, producer=AI)
    r = await summary(env, uid)
    assert (r.access_level, r.access_level_source, r.access_level_version) == (None, None, None)


async def test_foreign_producer_ignored(env) -> None:
    uid = await seed(env, 11)
    for producer in ("ai-concierge", "admin-bff", "user-admin", ID):
        await level_event(env, uid, producer=producer, level="vip", version=9)
    assert (await summary(env, uid)).access_level is None


async def test_event_before_profile_kept_until_profile_known(env) -> None:
    uid = str(uuid.uuid4())
    await level_event(env, uid)
    assert uid not in await listed(env)  # строка только по событию другого домена — не в списке
    env.identity.put(snapshot(uid, n=12))
    await env.sync.run_once()
    assert (await listed(env))[uid]["level"] == "plus"


async def test_deleted_user_access_level_cleared(env) -> None:
    uid = await seed(env, 13)
    await level_event(env, uid)
    req = str(uuid.uuid4())
    await env.emit("user.domain.deleted.v1", {"user_id": uid, "request_id": req, "domain": ID, "mode": "anonymized"},
                   producer=ID)
    r = await summary(env, uid)
    assert r.status == "DELETED"
    assert (r.access_level, r.access_level_source, r.access_level_expires_at, r.access_level_version) == (
        None, None, None, None)
    # позднее событие после удаления ничего не возвращает
    await level_event(env, uid, version=5)
    assert (await summary(env, uid)).access_level is None
    # DB-инвариант: у DELETED уровня нет
    with pytest.raises(Exception, match="ck_summary_deleted_access_level"):
        async with env.runtime.transaction() as s:
            await s.execute(text("UPDATE admin_user_summary SET access_level = 'plus', access_level_source = "
                                 "'manual', access_level_version = 1 WHERE user_id = :u"), {"u": uuid.UUID(uid)})


# ---------------------------------------------------------------- доступ

async def test_list_with_filter_requires_admin_bff_and_users_read(env) -> None:
    uid = await seed(env, 14)
    await level_event(env, uid)
    q = "/admin/v1/users?access_level=plus"
    assert (await env.client.get(q)).status_code == 401
    r = await env.client.get(q, headers={"x-internal-token": "garbage"})
    assert r.status_code == 401
    for issuer in ("ai-control", "ai-concierge", "telegram-bff"):
        r = await env.client.get(q, headers=internal_headers(env.settings, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    r = await env.get(q, ANALYST)
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    r = await env.client.get(q, headers=internal_headers(env.settings, issuer="admin-bff"))
    assert r.status_code == 403 and r.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    assert (await env.get(q, VIEWER)).status_code == 200


# ---------------------------------------------------------------- миграция 0002: откат и повтор

async def test_migration_0002_downgrade_and_reapply() -> None:
    import asyncpg
    from alembic import command
    from alembic.config import Config

    from tilhero_user_admin.settings import Settings

    schema = unique_schema("ua_mig")
    await create_schema(schema)
    settings = Settings(env="test", internal_jwt_secret="t" * 40, sync_enabled=False, database_url=TEST_ADMIN_URL,
                        db_schema=schema)
    conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})

    async def columns() -> set[str]:
        rows = await conn.fetch("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 "
                                "AND table_name = 'admin_user_summary'", schema)
        return {r[0] for r in rows}

    def downgrade(rev: str) -> None:
        cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
        cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
        cfg.attributes["settings"] = settings
        command.downgrade(cfg, rev)

    new = {"access_level", "access_level_source", "access_level_expires_at", "access_level_version"}
    try:
        await migrate(SERVICE_DIR, settings, "0001")
        uid = uuid.uuid4()
        await conn.execute("INSERT INTO admin_user_summary (user_id, created_at, profile_known) VALUES ($1, now(), "
                           "true)", uid)
        await migrate(SERVICE_DIR, settings)
        assert new <= await columns()
        row = await conn.fetchrow("SELECT access_level, access_level_source FROM admin_user_summary "
                                  "WHERE user_id = $1", uid)
        assert tuple(row) == (None, None)  # существующие строки — уровень по умолчанию
        await conn.execute("UPDATE admin_user_summary SET access_level = 'plus', access_level_source = 'manual', "
                           "access_level_version = 1 WHERE user_id = $1", uid)
        for bad in ("access_level_source = 'subscription'", "access_level = 'Plus'",
                    "access_level_source = 'default', access_level_expires_at = now()",
                    "access_level_version = NULL"):
            with pytest.raises(asyncpg.CheckViolationError):
                await conn.execute(f"UPDATE admin_user_summary SET {bad} WHERE user_id = $1", uid)  # noqa: S608
        await asyncio.to_thread(downgrade, "0001")
        assert not (new & await columns())
        assert await conn.fetchval("SELECT count(*) FROM admin_user_summary") == 1
        await migrate(SERVICE_DIR, settings)
        await migrate(SERVICE_DIR, settings)
        assert new <= await columns()
        assert json.dumps(sorted(new & await columns())) == json.dumps(sorted(new))
    finally:
        await conn.close()
        await drop_schema(schema)
