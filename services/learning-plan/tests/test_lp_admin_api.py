"""GET /admin/v1/plans — выгрузка планов для сверки read-модели админки (вызывающий только user-admin):
форма ответа, вызывающие, курсор (updated_at, user_id), updated_after, удалённые ученики, валидация."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

import pytest

from tilhero_common.internal_auth import Actor
from tilhero_common.testing import internal_headers

PATH = "/admin/v1/plans"
ITEM_KEYS = {"user_id", "goal", "level_self", "ui_lang", "schedule", "onboarding_completed_at", "updated_at"}


def ua(env) -> dict[str, str]:
    return internal_headers(env.settings, issuer="user-admin")


async def page(env, query: str = "") -> dict:
    r = await env.c.get(f"{PATH}?{query}", headers=ua(env))
    assert r.status_code == 200, r.text
    return r.json()


async def create_default(env, user: uuid.UUID) -> None:
    assert (await env.c.get("/internal/v1/me/plan", headers=env.h(user))).status_code == 200


async def test_happy_path_shape(env, user) -> None:
    onboarded = await env.onboard(user, at=datetime(2026, 11, 16, 6, 0, tzinfo=UTC), preset="three_per_week",
                                  time="07:30", reminders=True, duration=15)
    fresh = uuid.uuid4()
    await create_default(env, fresh)
    body = await page(env)
    assert body["next_cursor"] is None
    items = {i["user_id"]: i for i in body["items"]}
    assert set(items) == {str(user), str(fresh)}
    item = items[str(user)]
    assert set(item) == ITEM_KEYS  # без тем, языка объяснений, версии и PII
    assert item == {
        "user_id": str(user), "goal": "travel", "level_self": "beginner", "ui_lang": "ru",
        "schedule": {"preset": "three_per_week", "days": [1, 3, 5], "preferred_time": "07:30", "duration_min": 15,
                     "reminders_enabled": True, "timezone": "Asia/Tashkent"},
        "onboarding_completed_at": onboarded["onboarding_completed_at"],
        "updated_at": onboarded["updated_at"],
    }
    default = items[str(fresh)]  # план по умолчанию (без события) — тоже выгружается
    assert default["goal"] is None and default["onboarding_completed_at"] is None
    assert default["schedule"]["preset"] == "daily" and default["schedule"]["reminders_enabled"] is False


async def test_auth_and_callers(env) -> None:
    assert (await env.c.get(PATH)).status_code == 401
    assert (await env.c.get(PATH, headers={"x-internal-token": "garbage"})).status_code == 401
    wrong_aud = internal_headers(env.settings, issuer="user-admin", audience="identity-consent")
    assert (await env.c.get(PATH, headers=wrong_aud)).status_code == 401
    for issuer in ("telegram-bff", "admin-bff", "notifications", "identity-consent"):
        r = await env.c.get(PATH, headers=internal_headers(env.settings, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    staff = Actor(id=str(uuid.uuid4()), role="super_admin", permissions=frozenset({"users.read"}))
    via_bff = await env.c.get(PATH, headers=internal_headers(env.settings, issuer="admin-bff", actor=staff))
    assert via_bff.status_code == 403 and via_bff.json()["code"] == "CALLER_NOT_ALLOWED"
    # контекст сотрудника от user-admin не принимается (его выпускает только admin-bff)
    forged = await env.c.get(PATH, headers=internal_headers(env.settings, issuer="user-admin", actor=staff))
    assert forged.status_code == 403 and forged.json()["code"] == "ACTOR_NOT_ALLOWED"
    # планировщик сюда не ходит
    assert (await env.c.get(PATH, headers=env.sched)).status_code == 401


async def test_pagination_by_updated_at_and_user_id(env) -> None:
    """Курсор (updated_at, user_id): одинаковые updated_at (одни часы) упорядочены по user_id — без пропусков и
    дублей."""
    at = datetime(2026, 11, 16, 6, 0, tzinfo=UTC)
    users = [uuid.uuid4() for _ in range(5)]
    for n, u in enumerate(users):
        env.now = at + timedelta(minutes=n // 2)  # пары с одинаковым updated_at
        r = await env.c.patch("/internal/v1/me/plan", headers=env.h(u), json={"goal": "work"})
        assert r.status_code == 200, r.text
    expected = [str(u) for u in sorted(users, key=lambda u: (at + timedelta(minutes=users.index(u) // 2), str(u)))]
    seen: list[str] = []
    cursor = None
    pages = 0
    while True:
        body = await page(env, "limit=2" + (f"&cursor={cursor}" if cursor else ""))
        seen += [i["user_id"] for i in body["items"]]
        pages += 1
        cursor = body["next_cursor"]
        if not cursor:
            break
    assert seen == expected and pages == 3
    # изменение после выдачи страницы попадает в конец выдачи (updated_at растёт)
    env.now = at + timedelta(hours=1)
    await env.c.patch("/internal/v1/me/plan", headers=env.h(users[0]), json={"goal": "exam"})
    assert [i["user_id"] for i in (await page(env))["items"]][-1] == str(users[0])


async def test_updated_after_filter(env) -> None:
    at = datetime(2026, 11, 16, 6, 0, tzinfo=UTC)
    old, new = uuid.uuid4(), uuid.uuid4()
    for u, when in ((old, at), (new, at + timedelta(minutes=10))):
        env.now = when
        assert (await env.c.patch("/internal/v1/me/plan", headers=env.h(u), json={"goal": "daily"})).status_code == 200
    after = quote((at + timedelta(minutes=5)).isoformat())
    assert [i["user_id"] for i in (await page(env, f"updated_after={after}"))["items"]] == [str(new)]
    # строго позже: ровно updated_at не входит
    exact = quote((at + timedelta(minutes=10)).isoformat())
    assert (await page(env, f"updated_after={exact}"))["items"] == []
    # другая зона — тот же момент
    tashkent = quote((at + timedelta(minutes=5)).astimezone().isoformat())
    assert [i["user_id"] for i in (await page(env, f"updated_after={tashkent}"))["items"]] == [str(new)]
    assert len((await page(env, "updated_after=2000-01-01T00:00:00Z"))["items"]) == 2


async def test_deleted_learner_plan_not_exported(env, user) -> None:
    from tilhero_common.messaging import make_envelope

    await create_default(env, user)
    other = uuid.uuid4()
    await create_default(env, other)
    [spec] = [s for s in env.bus.specs if s.durable == "learning-plan.user_deletion"]
    await spec.handler(make_envelope("user.deletion.requested.v1", {
        "user_id": str(user), "request_id": str(uuid.uuid4()), "requested_at": "2026-11-16T08:00:00Z"},
        producer="identity-consent"))
    assert [i["user_id"] for i in (await page(env))["items"]] == [str(other)]


@pytest.mark.parametrize("query", ["limit=0", "limit=501", "updated_after=yesterday",
                                   "updated_after=2026-11-16T08:00:00", "cursor=" + "x" * 257])
async def test_validation(env, query) -> None:
    r = await env.c.get(f"{PATH}?{query}", headers=ua(env))
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", query


async def test_invalid_cursor(env) -> None:
    for cursor in ("bm9wZQ", "e30", "eyJ0IjoiMjAyNi0xMS0xNlQwODowMDowMCIsInUiOiJ4In0"):
        r = await env.c.get(f"{PATH}?cursor={cursor}", headers=ua(env))
        assert r.status_code == 400 and r.json()["code"] == "INVALID_CURSOR", cursor
    assert (await page(env, "limit=500"))["items"] == []
