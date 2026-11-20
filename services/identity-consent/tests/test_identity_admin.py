"""Админ-контур (спринт 2, INTERNAL_API §3): снимки учеников для user-admin (маска Telegram ID, аккаунт и дети,
согласие, безопасность, уведомления, курсор по updated_at) и раскрытие Telegram ID с синхронным аудитом."""

from __future__ import annotations

import asyncio
import random
import uuid
from datetime import UTC, datetime, timedelta

import httpx
from admin_kit import (
    MASK6,
    NEWS,
    SENSITIVE,
    SUPPORT,
    bff,
    delete_child_completely,
    delete_completely,
    json_logs,
    news_reader,
    news_teen,
    set_categories,
    ua,
)
from conftest import REQUIRED, VALID_PIN
from sqlalchemy import select, update

from tilhero_common.internal_auth import Actor
from tilhero_common.testing import internal_headers
from tilhero_identity.models import PinCredential, User

USERS = "/admin/v1/users"
SNAPSHOT_KEYS = {
    "user_id", "kind", "guardian_user_id", "display_name", "username", "telegram_id_masked", "locale", "age_band",
    "guardian_consent", "status", "children_count", "created_at", "updated_at", "consent", "security",
    "notifications",
}
REASON = "Проверка обращения TCK-0042"


async def _updated_at(env, uid: str) -> datetime:
    async with env.runtime.transaction() as s:
        return (await s.execute(select(User.updated_at).where(User.user_id == uuid.UUID(uid)))).scalar_one()


async def _all(env, **params) -> list[dict]:
    r = await env.client.get(USERS, params={"limit": 500, **params}, headers=ua(env))
    assert r.status_code == 200, r.text
    assert r.json()["next_cursor"] is None
    return r.json()["items"]


async def _get(env, uid: str) -> dict:
    r = await env.client.get(f"{USERS}/{uid}", headers=ua(env))
    assert r.status_code == 200, r.text
    return r.json()


def _reveal_path(uid: str) -> str:
    return f"{USERS}/{uid}/reveal"


# ---------------------------------------------------------------- GET /admin/v1/users (user-admin)

async def test_snapshot_account_child_teen(env) -> None:
    tg = random.randint(10**8, 10**10)
    parent = await news_reader(env, telegram_user_id=tg, username="@ivan_test", first_name="Иван", last_name="Т")
    await env.set_pin(parent)
    child = (await env.child(parent, name="Мадина", age_band="10-13"))["learner_id"]
    teen = await news_teen(env, parent)
    fresh = await env.new_user()  # возраст не выбран, согласия нет

    r = await env.client.get(USERS, params={"limit": 500}, headers=ua(env))
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    assert str(tg) not in r.text  # полного Telegram ID нет нигде
    items = {i["user_id"]: i for i in r.json()["items"]}
    assert set(items) == {parent, child, teen, fresh}
    stamps = [(i["updated_at"], i["user_id"]) for i in r.json()["items"]]
    assert stamps == sorted(stamps)  # (updated_at, user_id) по возрастанию

    p = items[parent]
    assert set(p) == SNAPSHOT_KEYS
    assert p["kind"] == "account" and p["guardian_user_id"] is None and p["children_count"] == 1
    assert p["telegram_id_masked"] == MASK6 + str(tg)[-3:]
    assert p["username"] == "ivan_test" and p["display_name"] == "Иван Т" and p["locale"] == "ru"
    assert p["age_band"] == "18+" and p["guardian_consent"] == "not_required" and p["status"] == "ACTIVE"
    assert p["consent"]["basis"] == "self" and p["consent"]["purposes"] == NEWS
    assert p["consent"]["policy_version"] == "1.2" and p["consent"]["accepted_at"]
    assert p["consent"]["revoked_at"] is None
    assert p["security"] == {"pin_enabled": True, "pin_reset_pending": False}
    assert p["notifications"] == {"enabled": True, "categories": {
        "reminders": False, "missed": False, "social": False, "support": True, "product": True}}

    c = items[child]
    assert c["kind"] == "child" and c["guardian_user_id"] == parent and c["children_count"] == 0
    assert c["telegram_id_masked"] is None and c["username"] is None and c["display_name"] == "Мадина"
    assert c["age_band"] == "10-13" and c["guardian_consent"] == "granted"
    assert c["consent"]["basis"] == "guardian" and c["consent"]["purposes"] == REQUIRED
    assert c["security"] == {"pin_enabled": False, "pin_reset_pending": False}

    t = items[teen]
    assert t["age_band"] == "14-17" and t["guardian_consent"] == "granted" and t["consent"]["basis"] == "self"
    assert t["consent"]["purposes"] == NEWS

    f = items[fresh]
    assert f["age_band"] is None and f["consent"] == {
        "policy_version": None, "purposes": [], "accepted_at": None, "revoked_at": None, "basis": None}
    assert f["notifications"]["enabled"] is False


async def test_snapshot_pagination_and_updated_after(env) -> None:
    users = [await env.new_user() for _ in range(5)]
    first = await env.client.get(USERS, params={"limit": 2}, headers=ua(env))
    assert first.status_code == 200, first.text
    page = first.json()
    assert len(page["items"]) == 2 and page["next_cursor"]
    seen = [i["user_id"] for i in page["items"]]
    while page["next_cursor"]:
        r = await env.client.get(USERS, params={"limit": 2, "cursor": page["next_cursor"]}, headers=ua(env))
        assert r.status_code == 200, r.text
        page = r.json()
        seen += [i["user_id"] for i in page["items"]]
    assert sorted(seen) == sorted(users) and len(seen) == len(set(seen))

    mark = await _updated_at(env, users[-1])
    await asyncio.sleep(0.01)
    later = await env.new_user()
    assert [i["user_id"] for i in await _all(env, updated_after=mark.isoformat())] == [later]
    # любое изменение ученика двигает updated_at — он снова попадает в сверку
    await asyncio.sleep(0.01)
    await env.set_age(users[0], "18+")
    assert {i["user_id"] for i in await _all(env, updated_after=mark.isoformat())} == {later, users[0]}


async def test_snapshot_updated_at_moves_for_guardian_on_child_changes(env) -> None:
    """children_count аккаунта меняется при создании и обезличивании ребёнка — сверка должна это увидеть."""
    parent = await env.parent()
    before = await _updated_at(env, parent)
    await asyncio.sleep(0.01)
    child = (await env.child(parent))["learner_id"]
    after_create = await _updated_at(env, parent)
    assert after_create > before
    assert (await _get(env, parent))["children_count"] == 1

    await delete_completely(env, parent)
    await delete_child_completely(env, child)
    snap = await _get(env, child)
    assert snap["status"] == "DELETED" and snap["guardian_user_id"] is None and snap["display_name"] is None
    assert snap["age_band"] is None and snap["notifications"] is None and snap["telegram_id_masked"] is None
    assert snap["consent"]["revoked_at"] is not None and snap["consent"]["basis"] == "guardian"
    assert (await _get(env, parent))["children_count"] == 0
    assert await _updated_at(env, parent) > after_create


async def test_snapshot_get_user_and_deleted_account(env) -> None:
    tg = random.randint(10**8, 10**10)
    uid = await news_reader(env, telegram_user_id=tg)
    other = await env.new_user()
    r = await env.call("DELETE", "/internal/v1/me/consent", uid)
    assert r.status_code == 200, r.text
    body = await _get(env, uid)
    assert body["user_id"] == uid and set(body) == SNAPSHOT_KEYS  # изоляция: ровно запрошенный ученик
    assert body["consent"]["revoked_at"] is not None and body["consent"]["purposes"] == NEWS
    assert (await _get(env, other))["user_id"] == other

    missing = await env.client.get(f"{USERS}/{uuid.uuid4()}", headers=ua(env))
    assert missing.status_code == 404 and missing.json()["code"] == "LEARNER_NOT_FOUND"
    bad = await env.client.get(f"{USERS}/not-a-uuid", headers=ua(env))
    assert bad.status_code == 422

    await delete_completely(env, uid)
    gone = await _get(env, uid)  # обезличенный ученик отдаётся: read-модель узнаёт об удалении
    assert gone["status"] == "DELETED" and gone["telegram_id_masked"] is None and gone["username"] is None
    assert gone["display_name"] is None and gone["security"]["pin_enabled"] is False
    assert str(tg) not in repr(gone)


async def test_snapshot_pin_reset_pending(env) -> None:
    uid = await env.parent()
    await env.set_pin(uid, VALID_PIN)
    effective = datetime.now(UTC) + timedelta(hours=24)
    async with env.runtime.transaction() as s:
        cred = await s.get(PinCredential, uuid.UUID(uid))
        await s.execute(update(PinCredential).where(PinCredential.user_id == uuid.UUID(uid)).values(
            reset_pin_hash=cred.pin_hash, reset_pin_length=4, reset_requested_at=datetime.now(UTC),
            reset_effective_at=effective))
    assert (await _get(env, uid))["security"] == {"pin_enabled": True, "pin_reset_pending": True}
    env.set_clock(effective + timedelta(minutes=1))  # срок наступил — новый код уже действует
    try:
        assert (await _get(env, uid))["security"] == {"pin_enabled": True, "pin_reset_pending": False}
    finally:
        env.set_clock(None)


async def test_snapshot_teen_optional_purposes_hidden_without_guardian(env) -> None:
    """Цели в снимке — действующие: после отзыва согласия родителем необязательные цели подростка не показываются."""
    parent = await env.parent()
    teen = await news_teen(env, parent)
    r = await env.call("POST", f"/internal/v1/me/guardian-consents/{teen}:revoke", parent)
    assert r.status_code == 200, r.text
    snap = await _get(env, teen)
    assert snap["guardian_consent"] == "declined" and snap["consent"]["purposes"] == REQUIRED


async def test_snapshot_auth_and_isolation(env) -> None:
    uid = await env.new_user()
    for path in (USERS, f"{USERS}/{uid}"):
        assert (await env.client.get(path)).status_code == 401
        assert (await env.client.get(path, headers={"x-internal-token": "garbage"})).status_code == 401
        for issuer in ("telegram-bff", "admin-bff", "support", "notifications", "learning-plan"):
            r = await env.client.get(path, headers=internal_headers(env.settings, issuer=issuer))
            assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", (path, issuer)
        r = await env.client.get(path, headers=bff(env))  # admin-bff с actor тоже нет: сверка — только user-admin
        assert r.status_code == 403
        r = await env.client.get(path, headers=ua(env, actor=SENSITIVE))  # actor не от admin-bff
        assert r.status_code == 403 and r.json()["code"] == "ACTOR_NOT_ALLOWED"
        r = await env.client.get(path, headers=ua(env, subject=uid))  # контекст ученика в служебном вызове
        assert r.status_code == 403 and r.json()["code"] == "CALLER_CONTEXT_NOT_ALLOWED"


async def test_snapshot_validation(env) -> None:
    for query in ("limit=0", "limit=501", "updated_after=yesterday", "updated_after=2026-11-18T10:00:00"):
        r = await env.client.get(f"{USERS}?{query}", headers=ua(env))
        assert r.status_code == 422, query
    assert (await env.client.get(f"{USERS}?limit=500", headers=ua(env))).status_code == 200
    for cursor in ("%%%", "x" * 300, "eyJ0IjoxfQ"):
        r = await env.client.get(USERS, params={"cursor": cursor}, headers=ua(env))
        assert r.status_code in (400, 422), cursor
        if r.status_code == 400:
            assert r.json()["code"] == "INVALID_CURSOR"


# ---------------------------------------------------------------- reveal (admin-bff + users.sensitive.read)

async def test_reveal_returns_value_after_sync_audit(env) -> None:
    tg = random.randint(10**8, 10**10)
    uid = await env.new_user(telegram_user_id=tg)
    other_tg = random.randint(10**8, 10**10)
    await env.new_user(telegram_user_id=other_tg)
    with json_logs() as logs:
        r = await env.client.post(_reveal_path(uid), json={"field": "telegram_user_id", "reason": f"  {REASON} "},
                                  headers=bff(env))
    assert r.status_code == 200, r.text
    assert r.json() == {"field": "telegram_user_id", "value": str(tg), "expires_in": 60}
    assert str(other_tg) not in r.text  # изоляция: только запрошенный ученик
    assert r.headers["cache-control"] == "no-store"
    [record] = env.audit.calls
    assert env.audit.issuers == ["identity-consent"]
    assert record["action"] == "sensitive.view" and record["object_type"] == "learner" and record["object_id"] == uid
    assert record["reason"] == REASON and record["after"] == {"field": "telegram_user_id"}
    assert record["on_behalf_of"] == {"actor_id": SENSITIVE.id, "actor_role": "super_admin"}
    assert env.audit.headers[0]["idempotency-key"] == record["record_id"]
    uuid.UUID(record["record_id"])
    assert datetime.fromisoformat(record["occurred_at"]) > datetime.now(UTC) - timedelta(minutes=1)
    assert str(tg) not in repr(record)  # значение в журнал не попадает
    # ни значения, ни причины — в логах и событиях
    out = logs.getvalue()
    assert "sensitive field revealed" in out and SENSITIVE.id in out  # кто смотрел — в логе есть
    for secret in (str(tg), "TCK-0042", uid):
        assert secret not in out, secret
    await env.flush()
    published = repr([e.payload for e in env.bus.published])
    assert str(tg) not in published and "TCK-0042" not in published


async def test_reveal_deletion_requested_account_still_available(env) -> None:
    tg = random.randint(10**8, 10**10)
    uid = await env.new_user(telegram_user_id=tg)
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, {"confirm_word": "УДАЛИТЬ"})
    assert r.status_code == 202, r.text
    r = await env.client.post(_reveal_path(uid), json={"field": "telegram_user_id", "reason": REASON},
                              headers=bff(env))
    assert r.status_code == 200 and r.json()["value"] == str(tg)


async def test_reveal_auth(env) -> None:
    uid = await env.new_user()
    body = {"field": "telegram_user_id", "reason": REASON}
    path = _reveal_path(uid)
    assert (await env.client.post(path, json=body)).status_code == 401
    no_right = await env.client.post(path, json=body, headers=bff(env, SUPPORT))
    assert no_right.status_code == 403 and no_right.json()["code"] == "PERMISSION_DENIED"
    assert no_right.json()["details"]["permission"] == "users.sensitive.read"
    no_actor = await env.client.post(path, json=body, headers=bff(env, None))
    assert no_actor.status_code == 403 and no_actor.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    for issuer in ("user-admin", "telegram-bff", "support", "notifications"):
        r = await env.client.post(path, json=body, headers=internal_headers(env.settings, issuer=issuer, subject=uid))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    # actor от сервиса, кроме admin-bff, не принимается вовсе
    forged = await env.client.post(path, json=body, headers=ua(env, actor=SENSITIVE))
    assert forged.status_code == 403
    # контекст ученика в токене admin-bff не допускается (ученик — только из пути)
    with_sub = await env.client.post(path, json=body, headers=bff(env, subject=str(uuid.uuid4())))
    assert with_sub.status_code == 403 and with_sub.json()["code"] == "CALLER_CONTEXT_NOT_ALLOWED"
    assert env.audit.calls == []  # отказ — без раскрытия и без записи


async def test_reveal_not_found_child_and_validation(env) -> None:
    parent = await env.parent()
    child = (await env.child(parent))["learner_id"]
    ok = {"field": "telegram_user_id", "reason": REASON}
    missing = await env.client.post(_reveal_path(str(uuid.uuid4())), json=ok, headers=bff(env))
    assert missing.status_code == 404 and missing.json()["code"] == "LEARNER_NOT_FOUND"
    kid = await env.client.post(_reveal_path(child), json=ok, headers=bff(env))
    assert kid.status_code == 409 and kid.json()["code"] == "FIELD_NOT_AVAILABLE"
    assert kid.json()["details"] == {"field": "telegram_user_id"}
    for body in (
        {"field": "telegram_user_id", "reason": " abc "},  # < 5 после обрезки пробелов
        {"field": "telegram_user_id", "reason": "x" * 301},
        {"field": "telegram_user_id"},
        {"reason": REASON},
        {"field": "username", "reason": REASON},
        {**ok, "value": "1"},
        {**ok, "reason": "строка\x00с NUL"},
        {**ok, "reason": "скрытый‮текст"},
    ):
        r = await env.client.post(_reveal_path(parent), json=body, headers=bff(env))
        assert r.status_code == 422, body
    assert (await env.client.post(_reveal_path(parent), json={**ok, "reason": "x" * 300},
                                  headers=bff(env))).status_code == 200
    assert (await env.client.post(_reveal_path(parent), json={**ok, "reason": "abcde"},
                                  headers=bff(env))).status_code == 200
    bad_id = await env.client.post(f"{USERS}/123/reveal", json=ok, headers=bff(env))
    assert bad_id.status_code == 422
    env.audit.calls.clear()
    await delete_completely(env, parent)
    gone = await env.client.post(_reveal_path(parent), json=ok, headers=bff(env))
    assert gone.status_code == 404 and gone.json()["code"] == "LEARNER_NOT_FOUND"
    assert env.audit.calls == []


async def test_reveal_withheld_when_audit_unavailable(env) -> None:
    tg = random.randint(10**8, 10**10)
    uid = await env.new_user(telegram_user_id=tg)
    body = {"field": "telegram_user_id", "reason": REASON}
    failures = ([httpx.ConnectError("down"), httpx.ConnectError("down")], [503, 503], [403], [422])
    with json_logs() as logs:
        for failure in failures:
            env.audit.responses[:] = failure
            r = await env.client.post(_reveal_path(uid), json=body, headers=bff(env))
            assert r.status_code == 503, (failure, r.text)
            assert r.json()["code"] == "AUDIT_UNAVAILABLE" and r.json()["details"] == {"service": "audit"}
            assert str(tg) not in r.text
    assert env.audit.calls == []
    out = logs.getvalue()
    assert "sensitive view not audited, value withheld" in out
    assert str(tg) not in out and "TCK-0042" not in out
    env.audit.responses.clear()
    ok = await env.client.post(_reveal_path(uid), json=body, headers=bff(env))
    assert ok.status_code == 200 and ok.json()["value"] == str(tg)


async def test_reveal_quota_per_staff(env) -> None:
    """Защита от массовой выгрузки: 20 раскрытий в час на сотрудника, затем 429 + запись аудита."""
    tg = random.randint(10**8, 10**10)
    uid = await env.new_user(telegram_user_id=tg)
    body = {"field": "telegram_user_id", "reason": REASON}
    greedy = Actor(id=str(uuid.uuid4()), role="super_admin", permissions=frozenset({"users.sensitive.read"}))
    other = Actor(id=str(uuid.uuid4()), role="super_admin", permissions=frozenset({"users.sensitive.read"}))
    try:
        limit = env.settings.reveal_limit_per_window
        assert limit == 20 and env.settings.reveal_window_seconds == 3600
        for _ in range(limit):
            assert (await env.client.post(_reveal_path(uid), json=body, headers=bff(env, greedy))).status_code == 200
        before = len(env.audit.calls)
        r = await env.client.post(_reveal_path(uid), json=body, headers=bff(env, greedy))
        assert r.status_code == 429 and r.json()["code"] == "RATE_LIMITED", r.text
        assert 0 < r.json()["details"]["retry_after"] <= 3600 and int(r.headers["retry-after"]) > 0
        assert str(tg) not in r.text
        [limited] = env.audit.calls[before:]
        assert limited["action"] == "sensitive.view_rate_limited" and limited["object_id"] == uid
        assert limited["on_behalf_of"] == {"actor_id": greedy.id, "actor_role": "super_admin"}
        assert limited["after"] == {"field": "telegram_user_id", "limit": 20, "window_seconds": 3600}
        # audit недоступен — всё равно 429 (значение не выдаётся)
        env.audit.responses[:] = [httpx.ConnectError("down"), httpx.ConnectError("down")]
        r = await env.client.post(_reveal_path(uid), json=body, headers=bff(env, greedy))
        assert r.status_code == 429 and str(tg) not in r.text
        env.audit.responses.clear()
        # квота — на сотрудника, другого не касается
        ok = await env.client.post(_reveal_path(uid), json=body, headers=bff(env, other))
        assert ok.status_code == 200 and ok.json()["value"] == str(tg)
    finally:
        await env.redis.delete(f"rl:identity:reveal:{greedy.id}", f"rl:identity:reveal:{other.id}")


async def test_reveal_fails_closed_without_quota_store(env) -> None:
    uid = await env.new_user()
    body = {"field": "telegram_user_id", "reason": REASON}
    redis, env.runtime.redis = env.runtime.redis, None
    try:
        r = await env.client.post(_reveal_path(uid), json=body, headers=bff(env))
    finally:
        env.runtime.redis = redis
    assert r.status_code == 503 and r.json()["code"] == "RATE_LIMIT_UNAVAILABLE"
    assert env.audit.calls == []


async def test_snapshot_categories_are_learner_choice(env) -> None:
    """Уведомления в снимке — выбор ученика (без фильтра целей): категория product без цели product_news видна."""
    uid = await env.parent()
    await set_categories(env, uid, product=True, reminders=True)
    snap = await _get(env, uid)
    assert snap["notifications"]["categories"]["product"] is True
    assert snap["notifications"]["categories"]["reminders"] is True
