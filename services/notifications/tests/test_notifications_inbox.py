"""Центр уведомлений (AT-12): GET /internal/v1/me/inbox, /unread-count, POST /me/inbox:read — авторизация,
пагинация, изоляция учеников, идемпотентность отметки прочитанного, валидация, срок хранения."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from notif_testkit import at, local_day
from sqlalchemy import update

from tilhero_common.testing import internal_headers
from tilhero_notifications.models import Notification

PATHS = [
    ("GET", "/internal/v1/me/inbox", None),
    ("GET", "/internal/v1/me/inbox/unread-count", None),
    ("POST", "/internal/v1/me/inbox:read", {"all": True}),
]


async def seed(env, user: uuid.UUID, n: int) -> list[str]:
    """n видимых записей (ответы поддержки — категория support всегда включена)."""
    for i in range(n):
        await env.reply_event(user, f"TCK-{100 + i}")
    await env.dispatch(at(local_day(1), "12:00"))
    return [str(r.notification_id) for r in await env.rows(user)]


@pytest.mark.parametrize(("method", "path", "body"), PATHS)
async def test_auth(env, method: str, path: str, body: dict | None) -> None:
    user = env.add_user()

    async def call(headers: dict[str, str]):
        return await env.client.request(method, path, json=body, headers=headers)

    r = await call({})
    assert r.status_code == 401 and r.json()["code"] == "INTERNAL_TOKEN_MISSING"
    r = await call({"x-internal-token": "garbage"})
    assert r.status_code == 401 and r.json()["code"] == "INTERNAL_TOKEN_INVALID"
    for issuer in ("support", "identity-consent", "admin-bff"):
        r = await call(env.bff(user, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await call(env.bff(None))
    assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_REQUIRED"
    r = await call(env.bff("not-a-uuid"))
    assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_INVALID"
    other_aud = internal_headers(env.settings, issuer="telegram-bff", subject=str(user), audience="support")
    assert (await call(other_aud)).status_code == 401
    assert (await call(env.bff(user))).status_code == 200


async def test_pagination_newest_first(env) -> None:
    user = env.add_user()
    ids = await seed(env, user, 5)
    page1 = await env.inbox(user, limit=2)
    page2 = await env.inbox(user, limit=2, cursor=page1["next_cursor"])
    page3 = await env.inbox(user, limit=2, cursor=page2["next_cursor"])
    got = [i["notification_id"] for p in (page1, page2, page3) for i in p["items"]]
    assert got == list(reversed(ids)) and page3["next_cursor"] is None
    assert len(page1["items"]) == 2 and len(page3["items"]) == 1
    assert (await env.inbox(user))["next_cursor"] is None  # по умолчанию 20
    bad = await env.client.get("/internal/v1/me/inbox?cursor=%%%", headers=env.bff(user))
    assert bad.status_code == 400 and bad.json()["code"] == "INVALID_CURSOR"
    for limit in (0, 101, "x"):
        r = await env.client.get(f"/internal/v1/me/inbox?limit={limit}", headers=env.bff(user))
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"


async def test_read_is_idempotent_and_isolated(env) -> None:
    alice, bob = env.add_user(), env.add_user()
    a_ids, b_ids = await seed(env, alice, 3), await seed(env, bob, 2)
    assert await env.unread(alice) == 3 and await env.unread(bob) == 2
    # Чужие и неизвестные id не меняются и не раскрываются (ответ — счётчик своих)
    r = await env.read(bob, {"ids": [*a_ids, str(uuid.uuid4())]})
    assert r.status_code == 200 and r.json() == {"unread": 2}
    assert await env.unread(alice) == 3
    assert all(i["read_at"] is None for i in (await env.inbox(alice))["items"])
    assert [i["notification_id"] for i in (await env.inbox(bob))["items"]] == list(reversed(b_ids))
    r = await env.read(alice, {"ids": a_ids[:2]})
    assert r.json() == {"unread": 1}
    first = {i["notification_id"]: i["read_at"] for i in (await env.inbox(alice))["items"]}
    assert first[a_ids[0]] is not None and first[a_ids[2]] is None and first[a_ids[0]].endswith("Z")
    again = await env.read(alice, {"ids": a_ids[:2]})  # повтор — read_at не меняется
    assert again.json() == {"unread": 1}
    assert {i["notification_id"]: i["read_at"] for i in (await env.inbox(alice))["items"]} == first
    assert (await env.read(alice, {"all": True})).json() == {"unread": 0}
    assert await env.unread(bob) == 2


@pytest.mark.parametrize(
    "body",
    [{}, {"ids": []}, {"all": False}, {"ids": ["nope"]}, {"ids": [str(uuid.uuid4())] * 101}, {"all": True, "x": 1}],
)
async def test_read_validation(env, body: dict) -> None:
    r = await env.read(env.add_user(), body)
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"


async def test_hidden_rows_and_retention(env) -> None:
    """Не видны: skipped (категория выключена), ещё не отрисованные, код PIN; старше 90 дней — тоже."""
    user = env.add_user(categories=("support",))
    await env.reminder(user, local_day(1), "10:00")  # reminders выключены → skipped
    tx = await env.transactional(user)  # код PIN — не для центра
    assert tx.json()["status"] == "sent"
    await env.reply_event(user)  # ещё не обработано → title NULL
    assert (await env.inbox(user))["items"] == [] and await env.unread(user) == 0
    await env.dispatch(at(local_day(1), "10:00"))
    [item] = (await env.inbox(user))["items"]
    assert item["category"] == "support"
    async with env.runtime.transaction() as s:
        await s.execute(
            update(Notification).values(created_at=datetime.now(UTC) - timedelta(days=91))
        )
    assert (await env.inbox(user))["items"] == [] and await env.unread(user) == 0
    assert (await env.read(user, {"all": True})).json() == {"unread": 0}


async def test_child_center_is_separate_from_parent(env) -> None:
    parent = env.add_user()
    child = env.add_child(parent)
    day = local_day(1)
    await env.reminder(child, day, "10:00")
    await env.reminder(parent, day, "10:00")
    await env.dispatch(at(day, "10:00"))
    [c_item] = (await env.inbox(child))["items"]
    [p_item] = (await env.inbox(parent))["items"]
    assert c_item["title"] == "Мадина: время занятия" and p_item["title"] == "Время занятия"
    # родитель (sub = аккаунт) не может отметить записи ребёнка: ученик — только из токена
    assert (await env.read(parent, {"ids": [c_item["notification_id"]]})).json() == {"unread": 1}
    assert await env.unread(child) == 1
