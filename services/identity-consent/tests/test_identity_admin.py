"""Админ-контур (спринт 2): снимки профилей для user-admin, reveal Telegram ID с синхронным аудитом,
updated_at двигается при входе и любых изменениях."""

from __future__ import annotations

import asyncio
import logging
import random
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from sqlalchemy import select

from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import make_envelope
from tilhero_common.testing import internal_headers
from tilhero_identity.models import User

SUPPORT = Actor(id=str(uuid.uuid4()), role="support", permissions=frozenset({"users.read"}))
SENSITIVE = Actor(id=str(uuid.uuid4()), role="super_admin",
                  permissions=frozenset({"users.read", "users.sensitive.read"}))
MASK6 = "•" * 6


def ua(env) -> dict[str, str]:
    return internal_headers(env.settings, issuer="user-admin")


def bff(env, actor: Actor | None = SENSITIVE) -> dict[str, str]:
    return internal_headers(env.settings, issuer="admin-bff", actor=actor)


async def _updated_at(env, uid: str) -> datetime:
    async with env.runtime.transaction() as s:
        return (await s.execute(select(User.updated_at).where(User.user_id == uuid.UUID(uid)))).scalar_one()


async def _delete_completely(env, uid: str) -> None:
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": "DELETE"})
    assert r.status_code == 202, r.text
    request_id = r.json()["request_id"]
    for domain in env.settings.deletion_domains:
        await env.bus.publish(make_envelope(
            "user.domain.deleted.v1", {"user_id": uid, "request_id": request_id, "domain": domain, "mode": "deleted"},
            producer=domain))


# ---------------------------------------------------------------- GET /admin/v1/users (user-admin)

async def test_admin_list_snapshot_masks_and_pagination(env) -> None:
    tg = random.randint(10**8, 10**10)
    uid = await env.new_user(telegram_user_id=tg, username="@ivan_test", first_name="Иван", last_name="Тестов")
    await env.consent(uid, ["personalization"])
    await env.set_pin(uid)
    others = [await env.new_user() for _ in range(3)]

    first = await env.client.get("/admin/v1/users?limit=2", headers=ua(env))
    assert first.status_code == 200, first.text
    page = first.json()
    assert len(page["items"]) == 2 and page["next_cursor"]
    seen = [i["user_id"] for i in page["items"]]
    while page["next_cursor"]:
        page = (await env.client.get(f"/admin/v1/users?limit=2&cursor={page['next_cursor']}", headers=ua(env))).json()
        seen += [i["user_id"] for i in page["items"]]
    assert sorted(seen) == sorted([uid, *others]) and len(seen) == len(set(seen))

    full = (await env.client.get("/admin/v1/users?limit=100", headers=ua(env)))
    assert str(tg) not in full.text  # полного Telegram ID нет нигде
    me = next(i for i in full.json()["items"] if i["user_id"] == uid)
    assert me["telegram_id_masked"] == MASK6 + str(tg)[-3:]
    assert me["username"] == "ivan_test" and me["display_name"] == "Иван Тестов"
    assert me["status"] == "ACTIVE" and me["locale"] == "ru" and me["last_seen_at"]
    assert me["consent"]["policy_version"] == "1.0" and me["consent"]["purposes"] == ["personalization"]
    assert me["consent"]["age_confirmed_18_plus"] is True and me["consent"]["revoked_at"] is None
    assert me["security"] == {"pin_enabled": True, "biometric_enabled": False}
    assert set(me) == {"user_id", "username", "display_name", "telegram_id_masked", "locale", "status", "created_at",
                       "updated_at", "last_seen_at", "consent", "security"}
    # порядок — по (updated_at, user_id) возрастанию
    stamps = [(i["updated_at"], i["user_id"]) for i in full.json()["items"]]
    assert stamps == sorted(stamps)


async def test_admin_list_updated_after_and_deleted_users(env) -> None:
    old = await env.new_user()
    mark = await _updated_at(env, old)
    await asyncio.sleep(0.01)
    fresh = await env.new_user()
    r = await env.client.get("/admin/v1/users", params={"updated_after": mark.isoformat()}, headers=ua(env))
    assert [i["user_id"] for i in r.json()["items"]] == [fresh]

    await _delete_completely(env, old)
    r = await env.client.get("/admin/v1/users", params={"updated_after": mark.isoformat()}, headers=ua(env))
    deleted = next(i for i in r.json()["items"] if i["user_id"] == old)  # удаление попадает в сверку
    assert deleted["status"] == "DELETED" and deleted["username"] is None and deleted["display_name"] is None
    assert deleted["telegram_id_masked"] == "•" * 9


async def test_admin_get_user(env) -> None:
    uid = await env.new_user()
    await env.consent(uid)
    await env.call("DELETE", "/internal/v1/me/consent", uid)
    r = await env.client.get(f"/admin/v1/users/{uid}", headers=ua(env))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user_id"] == uid and body["consent"]["revoked_at"] is not None
    assert body["consent"]["purposes"] == ["personalization", "notifications"]
    missing = await env.client.get(f"/admin/v1/users/{uuid.uuid4()}", headers=ua(env))
    assert missing.status_code == 404 and missing.json()["code"] == "USER_NOT_FOUND"
    bad = await env.client.get("/admin/v1/users/not-a-uuid", headers=ua(env))
    assert bad.status_code == 422


async def test_admin_snapshot_auth(env) -> None:
    uid = await env.new_user()
    for path in ("/admin/v1/users", f"/admin/v1/users/{uid}"):
        assert (await env.client.get(path)).status_code == 401
        assert (await env.client.get(path, headers={"x-internal-token": "garbage"})).status_code == 401
        for issuer in ("telegram-bff", "admin-bff", "support", "notifications"):
            r = await env.client.get(path, headers=internal_headers(env.settings, issuer=issuer))
            assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", (path, issuer)
        # admin-bff с actor тоже не допускается: сверка — только служебный вызов user-admin
        r = await env.client.get(path, headers=bff(env))
        assert r.status_code == 403
        # контекст пользователя в служебном вызове не допускается (изоляция)
        r = await env.client.get(path, headers=internal_headers(env.settings, issuer="user-admin", subject=uid))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_CONTEXT_NOT_ALLOWED"


async def test_admin_list_validation(env) -> None:
    for query in ("limit=0", "limit=101", "updated_after=yesterday", "updated_after=2026-10-09T10:00:00"):
        r = await env.client.get(f"/admin/v1/users?{query}", headers=ua(env))
        assert r.status_code == 422, query
    r = await env.client.get("/admin/v1/users?cursor=%%%", headers=ua(env))
    assert r.status_code == 400 and r.json()["code"] == "INVALID_CURSOR"


# ---------------------------------------------------------------- updated_at

async def test_updated_at_moves_on_login_and_every_change(env) -> None:
    tg = random.randint(10**8, 10**10)
    uid = await env.new_user(telegram_user_id=tg)
    stamps = [await _updated_at(env, uid)]

    async def step(coro) -> None:
        await asyncio.sleep(0.01)
        await coro
        stamps.append(await _updated_at(env, uid))
        assert stamps[-1] > stamps[-2], len(stamps)

    await step(env.login(telegram_user_id=tg))  # вход (last_seen)
    await step(env.consent(uid))  # согласие (другая таблица)
    await step(env.set_pin(uid))  # PIN (другая таблица)
    await step(env.call("PUT", "/internal/v1/me/biometric", uid))
    await step(env.call("DELETE", "/internal/v1/me/consent", uid))
    await step(env.call("POST", "/internal/v1/me/disable", uid))


async def test_migration_adds_updated_at_index(env) -> None:
    async with env.runtime.transaction() as s:
        from sqlalchemy import text

        rows = (await s.execute(text(
            "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'users'"
        ))).scalars().all()
    assert "ix_users_updated_at" in rows


async def test_migration_0002_concurrent_and_rerunnable(env) -> None:
    """Индекс строится CONCURRENTLY вне транзакции; downgrade/upgrade повторяемы, невалидный остаток пересоздаётся."""
    from alembic import command
    from alembic.config import Config
    from conftest import SERVICE_DIR
    from sqlalchemy import text

    from tilhero_common.testing import migrate

    async def state() -> list[tuple[str, bool]]:
        async with env.runtime.transaction() as s:
            return [tuple(r) for r in (await s.execute(text(
                "SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
                "WHERE c.relname = 'ix_users_updated_at' AND c.relnamespace = current_schema()::regnamespace"
            ))).all()]

    await env.new_user()
    cfg = Config(f"{SERVICE_DIR}/alembic.ini")
    cfg.set_main_option("script_location", f"{SERVICE_DIR}/migrations")
    cfg.attributes["settings"] = env.settings
    await asyncio.to_thread(command.downgrade, cfg, "0001")
    assert await state() == []
    await migrate(SERVICE_DIR, env.settings)
    assert await state() == [("ix_users_updated_at", True)]
    # прерванная сборка CONCURRENTLY оставляет невалидный индекс — повторная миграция его пересоздаёт
    # (спринт 9: поверх 0002 есть 0003 — сначала откат до 0002, затем «повтор» 0002 и снова head)
    await env.runtime.db.dispose()
    await asyncio.to_thread(command.downgrade, cfg, "0002")
    async with env.runtime.transaction() as s:
        await s.execute(text(
            "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'ix_users_updated_at'::regclass"))
        await s.execute(text("UPDATE alembic_version SET version_num = '0001'"))
    await migrate(SERVICE_DIR, env.settings, "0002")
    assert await state() == [("ix_users_updated_at", True)]
    await migrate(SERVICE_DIR, env.settings)
    # SQL миграции: CONCURRENTLY + IF NOT EXISTS
    source = (Path(SERVICE_DIR) / "migrations/versions/0002_users_updated_at_index.py").read_text()
    assert "postgresql_concurrently=True" in source and "if_not_exists=True" in source
    assert "autocommit_block" in source


# ---------------------------------------------------------------- reveal (admin-bff + users.sensitive.read)

async def test_reveal_returns_value_after_audit(env, caplog) -> None:
    tg = random.randint(10**8, 10**10)
    uid = await env.new_user(telegram_user_id=tg)
    reason = "Клиент просит проверить привязку, TCK-3001"
    with caplog.at_level(logging.DEBUG):
        r = await env.client.post(f"/admin/v1/users/{uid}/reveal",
                                  json={"field": "telegram_user_id", "reason": reason}, headers=bff(env))
    assert r.status_code == 200, r.text
    assert r.json() == {"field": "telegram_user_id", "value": str(tg), "expires_in": 60}
    assert r.headers["cache-control"] == "no-store"
    [record] = env.audit.calls
    assert env.audit.issuers == ["identity-consent"]
    assert record["action"] == "sensitive.view" and record["object_type"] == "user" and record["object_id"] == uid
    assert record["reason"] == reason and record["after"] == {"field": "telegram_user_id"}
    assert record["on_behalf_of"] == {"actor_id": SENSITIVE.id, "actor_role": "super_admin"}
    assert str(tg) not in repr(record)  # значение в журнал не попадает
    uuid.UUID(record["record_id"])
    assert datetime.fromisoformat(record["occurred_at"]) > datetime.now(UTC) - timedelta(minutes=1)
    # значение — ни в логах, ни в событиях
    assert str(tg) not in caplog.text
    await env.flush()
    assert str(tg) not in repr([e.payload for e in env.bus.published])


async def test_reveal_requires_permission_and_admin_bff(env) -> None:
    uid = await env.new_user()
    body = {"field": "telegram_user_id", "reason": "Проверка обращения"}
    path = f"/admin/v1/users/{uid}/reveal"
    assert (await env.client.post(path, json=body)).status_code == 401
    no_right = await env.client.post(path, json=body, headers=bff(env, SUPPORT))
    assert no_right.status_code == 403 and no_right.json()["details"]["permission"] == "users.sensitive.read"
    no_actor = await env.client.post(path, json=body, headers=bff(env, None))
    assert no_actor.status_code == 403 and no_actor.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    for issuer in ("user-admin", "telegram-bff", "support"):
        r = await env.client.post(path, json=body, headers=internal_headers(env.settings, issuer=issuer, subject=uid))
        assert r.status_code == 403, issuer
    # actor от сервиса, кроме admin-bff, не принимается вовсе
    forged = await env.client.post(path, json=body, headers=internal_headers(
        env.settings, issuer="user-admin", actor=SENSITIVE))
    assert forged.status_code == 403
    assert env.audit.calls == []  # отказ — без раскрытия и без записи


async def test_reveal_not_found_and_validation(env) -> None:
    uid = await env.new_user()
    ok = {"field": "telegram_user_id", "reason": "Проверка обращения"}
    missing = await env.client.post(f"/admin/v1/users/{uuid.uuid4()}/reveal", json=ok, headers=bff(env))
    assert missing.status_code == 404 and missing.json()["code"] == "USER_NOT_FOUND"
    for body in (
        {"field": "telegram_user_id", "reason": "abc "},  # < 5 после обрезки пробелов
        {"field": "telegram_user_id"},
        {"field": "username", "reason": "Проверка обращения"},
        {**ok, "value": "1"},
        {**ok, "reason": "x" * 501},
        {**ok, "reason": "строка\x00с NUL"},
    ):
        r = await env.client.post(f"/admin/v1/users/{uid}/reveal", json=body, headers=bff(env))
        assert r.status_code == 422, body
    bad_id = await env.client.post("/admin/v1/users/123/reveal", json=ok, headers=bff(env))
    assert bad_id.status_code == 422
    await _delete_completely(env, uid)
    gone = await env.client.post(f"/admin/v1/users/{uid}/reveal", json=ok, headers=bff(env))
    assert gone.status_code == 404
    assert env.audit.calls == []


async def test_reveal_withheld_when_audit_unavailable(env) -> None:
    tg = random.randint(10**8, 10**10)
    uid = await env.new_user(telegram_user_id=tg)
    body = {"field": "telegram_user_id", "reason": "Проверка обращения"}
    path = f"/admin/v1/users/{uid}/reveal"
    for failure in ([httpx.ConnectError("down"), httpx.ConnectError("down")], [503, 503], [422]):
        env.audit.responses[:] = failure
        r = await env.client.post(path, json=body, headers=bff(env))
        assert r.status_code == 503, (failure, r.text)
        assert r.json()["code"] == "UPSTREAM_UNAVAILABLE" and r.json()["details"] == {"service": "audit"}
        assert str(tg) not in r.text
    assert env.audit.calls == []


async def test_reveal_quota_per_staff(env) -> None:
    """Защита от массовой выгрузки: 20 раскрытий в час на сотрудника, затем 429 + запись аудита."""
    tg = random.randint(10**8, 10**10)
    uid = await env.new_user(telegram_user_id=tg)
    body = {"field": "telegram_user_id", "reason": "Проверка обращения"}
    path = f"/admin/v1/users/{uid}/reveal"
    greedy = Actor(id=str(uuid.uuid4()), role="super_admin", permissions=frozenset({"users.sensitive.read"}))
    other = Actor(id=str(uuid.uuid4()), role="super_admin", permissions=frozenset({"users.sensitive.read"}))
    try:
        limit = env.settings.reveal_limit_per_window
        assert limit == 20 and env.settings.reveal_window_seconds == 3600
        for _ in range(limit):
            assert (await env.client.post(path, json=body, headers=bff(env, greedy))).status_code == 200
        before = len(env.audit.calls)
        r = await env.client.post(path, json=body, headers=bff(env, greedy))
        assert r.status_code == 429 and r.json()["code"] == "RATE_LIMITED", r.text
        assert 0 < r.json()["details"]["retry_after"] <= 3600 and int(r.headers["retry-after"]) > 0
        assert str(tg) not in r.text
        [limited] = env.audit.calls[before:]
        assert limited["action"] == "sensitive.view_rate_limited" and limited["object_id"] == uid
        assert limited["on_behalf_of"] == {"actor_id": greedy.id, "actor_role": "super_admin"}
        assert limited["after"] == {"field": "telegram_user_id", "limit": 20, "window_seconds": 3600}
        # audit недоступен — всё равно 429 (значение не выдаётся)
        env.audit.responses[:] = [httpx.ConnectError("down"), httpx.ConnectError("down")]
        r = await env.client.post(path, json=body, headers=bff(env, greedy))
        assert r.status_code == 429 and str(tg) not in r.text
        env.audit.responses.clear()
        # квота — на сотрудника, другого не касается
        ok = await env.client.post(path, json=body, headers=bff(env, other))
        assert ok.status_code == 200 and ok.json()["value"] == str(tg)
    finally:
        await env.redis.delete(f"rl:identity:reveal:{greedy.id}", f"rl:identity:reveal:{other.id}")
