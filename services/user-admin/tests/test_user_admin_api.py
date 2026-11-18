"""Staff API user-admin: список (поиск, фильтры, курсор), карточка (перечитывание identity-consent), stats,
права и вызывающие, маска Telegram ID, PII не в логах."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from user_admin_testkit import ANALYST, MASK, OUTSIDER, VIEWER, FakeIdentity, now, snapshot

from tilhero_common.internal_auth import Actor
from tilhero_common.testing import internal_headers
from tilhero_user_admin.domain.queries import period_start

ID = "identity-consent"
ROW_KEYS = {"user_id", "username", "display_name", "telegram_id_masked", "locale", "status", "onboarding_completed",
            "open_tickets", "tickets_total", "created_at", "last_seen_at", "plan",
            "access_level",  # спринт 7: уровень доступа к AI (test_user_admin_access_level.py)
            "deletion_stuck_at"}  # спринт 9: «удаление зависло» (test_user_admin_deletion_stuck.py)


async def seed(env, n: int = 0, **kw) -> dict:
    snap = env.identity.put(snapshot(n=n, **kw))
    await env.sync.run_once()
    return snap


async def ticket(env, uid: str, number: int, status: str | None = None) -> None:
    tid = str(uuid.uuid4())
    await env.emit("support.ticket.created.v1", {"ticket_id": tid, "number": f"TCK-{number}", "user_id": uid,
                                                 "category": "OTHER", "priority": "normal"}, producer="support")
    if status:
        await env.emit("support.ticket.status.changed.v1", {"ticket_id": tid, "number": f"TCK-{number}",
                                                            "user_id": uid, "from_status": "NEW", "to_status": status,
                                                            "changed_by": "operator"}, producer="support")


async def ids(env, query: str = "", actor: Actor = VIEWER) -> list[str]:
    r = await env.get(f"/admin/v1/users?{query}", actor)
    assert r.status_code == 200, r.text
    return [i["user_id"] for i in r.json()["items"]]


# ---------------------------------------------------------------- список

async def test_list_rows_match_contract(env) -> None:
    a = await seed(env, 1, created_at=(now() - timedelta(days=3)).isoformat())
    await ticket(env, a["user_id"], 3001)
    await ticket(env, a["user_id"], 3002, "CLOSED")
    await env.emit("user.preferences.updated.v1", {"user_id": a["user_id"], "changed_fields": ["onboarding"],
                                                   "onboarding_completed": True}, producer="preferences")
    r = await env.get("/admin/v1/users")
    assert r.status_code == 200
    [item] = r.json()["items"]
    assert set(item) == ROW_KEYS
    assert item["user_id"] == a["user_id"] and item["username"] == "tester_1"
    assert item["telegram_id_masked"] == MASK * 6 + "001" and item["plan"] == "FREE"
    assert (item["open_tickets"], item["tickets_total"], item["onboarding_completed"]) == (1, 2, True)
    assert item["created_at"].endswith("Z") or item["created_at"].endswith("+00:00")


async def test_search_by_uuid_username_name_and_ticket(env) -> None:
    ivan = await seed(env, 1, username="ivan_petrov", display_name="Иван Петров")
    maria = await seed(env, 2, username="maria_s", display_name="Мария Сидорова")
    other = await seed(env, 3, username="ivanova_x", display_name="Ольга Иванова")
    await ticket(env, maria["user_id"], 3081)

    assert await ids(env, f"q={ivan['user_id']}") == [ivan["user_id"]]
    assert await ids(env, f"q={uuid.uuid4()}") == []
    assert sorted(await ids(env, "q=@ivan")) == sorted([ivan["user_id"], other["user_id"]])  # префикс username
    assert await ids(env, "q=@IVAN_P") == [ivan["user_id"]]
    assert await ids(env, "q=@bad name") == []
    assert set(await ids(env, "q=иван")) == {ivan["user_id"], other["user_id"]}  # часть имени без регистра
    assert await ids(env, "q=сидоров") == [maria["user_id"]]
    assert await ids(env, "q=TCK-3081") == [maria["user_id"]]
    assert await ids(env, "q=tck-3081") == [maria["user_id"]]
    assert await ids(env, "q=TCK-9999") == []
    # спецсимволы LIKE экранируются: «_» — литерал, а не «любой символ» («v_n» совпало бы с «ivan»)
    assert await ids(env, "q=%25") == []
    assert await ids(env, "q=v_n") == []
    assert await ids(env, "q=a_s") == [maria["user_id"]]


async def test_filters_and_pagination(env) -> None:
    base = now() - timedelta(days=10)
    users = [await seed(env, n, created_at=(base + timedelta(hours=n)).isoformat(),
                        locale="en" if n % 2 else "ru") for n in range(5)]
    await env.emit("user.status.changed.v1", {"user_id": users[0]["user_id"], "status": "DISABLED",
                                              "previous_status": "ACTIVE"}, producer=ID)
    await ticket(env, users[1]["user_id"], 3500)
    newest_first = [u["user_id"] for u in reversed(users)]
    assert await ids(env) == newest_first
    assert await ids(env, "status=DISABLED") == [users[0]["user_id"]]
    assert await ids(env, "status=active,disabled") == newest_first
    assert await ids(env, "locale=en") == [users[3]["user_id"], users[1]["user_id"]]
    assert await ids(env, "has_open_tickets=true") == [users[1]["user_id"]]
    assert len(await ids(env, "has_open_tickets=false")) == 4
    seen: list[str] = []
    cursor = None
    while True:
        r = (await env.get("/admin/v1/users?limit=2" + (f"&cursor={cursor}" if cursor else ""))).json()
        seen += [i["user_id"] for i in r["items"]]
        cursor = r["next_cursor"]
        if not cursor:
            break
    assert seen == newest_first


async def test_pagination_is_stable_while_projection_changes(env) -> None:
    """Ключ курсора (created_at, user_id) неизменен после подтверждения профиля: снимки и повторные
    profile.created с иным created_at, новые строки из событий других доменов не дают пропусков и дублей."""
    base = now() - timedelta(days=5)
    users = [await seed(env, n, created_at=(base + timedelta(minutes=n)).isoformat()) for n in range(6)]
    expected = [u["user_id"] for u in reversed(users)]
    first = (await env.get("/admin/v1/users?limit=2")).json()
    assert [i["user_id"] for i in first["items"]] == expected[:2]

    # между страницами: источник «сдвигает» created_at (усечение до мс, другой формат) у пользователей с обеих
    # сторон курсора, приходит дубль profile.created с другим created_at, появляется строка только из события
    for u, shift in ((users[5], -10), (users[0], +10), (users[3], +3)):
        moved = dict(u, created_at=(datetime.fromisoformat(u["created_at"]) + timedelta(days=shift)).isoformat(),
                     updated_at=now().isoformat())
        env.identity.put(moved)
    await env.sync.run_once()
    await env.emit("user.profile.created.v1", {"user_id": users[2]["user_id"], "locale": "ru",
                                               "created_at": now().isoformat()}, producer=ID)
    await env.emit("user.preferences.updated.v1", {"user_id": str(uuid.uuid4()), "changed_fields": ["interests"],
                                                   "onboarding_completed": True}, producer="preferences")
    seen = [i["user_id"] for i in first["items"]]
    cursor = first["next_cursor"]
    while cursor:
        page = (await env.get(f"/admin/v1/users?limit=2&cursor={cursor}")).json()
        seen += [i["user_id"] for i in page["items"]]
        cursor = page["next_cursor"]
    assert seen == expected  # без пропусков и дублей, порядок прежний
    card = (await env.get(f"/admin/v1/users/{users[5]['user_id']}")).json()
    assert card["created_at"].replace("Z", "+00:00") == datetime.fromisoformat(users[5]["created_at"]).isoformat()


async def test_list_validation(env) -> None:
    for query in ("limit=0", "limit=101", "status=GONE", "locale=r1", "locale=x", "has_open_tickets=maybe",
                  "q=" + "x" * 121):
        r = await env.get(f"/admin/v1/users?{query}")
        assert r.status_code == 422, query
    assert (await env.get("/admin/v1/users?status=GONE")).json()["code"] == "USER_FILTER_INVALID"
    assert await ids(env, "locale=uz") == [] and await ids(env, "q=" + "x" * 120) == []
    bad = await env.get("/admin/v1/users?cursor=bm9wZQ")
    assert bad.status_code == 400 and bad.json()["code"] == "INVALID_CURSOR"


@pytest.mark.parametrize("path", ["/admin/v1/users", "/admin/v1/users/stats",
                                  "/admin/v1/users/00000000-0000-4000-8000-000000000001"])
async def test_auth_and_callers(env, path) -> None:
    assert (await env.client.get(path)).status_code == 401
    assert (await env.client.get(path, headers={"x-internal-token": "garbage"})).status_code == 401
    wrong_aud = internal_headers(env.settings, issuer="admin-bff", actor=VIEWER, audience="support")
    assert (await env.client.get(path, headers=wrong_aud)).status_code == 401
    for issuer in ("telegram-bff", "support", "identity-consent"):
        r = await env.client.get(path, headers=internal_headers(env.settings, issuer=issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", issuer
    no_actor = await env.client.get(path, headers=env.staff(None))
    assert no_actor.status_code == 403 and no_actor.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    denied = await env.get(path, OUTSIDER)
    assert denied.status_code == 403 and denied.json()["code"] == "PERMISSION_DENIED"
    # actor от сервиса, кроме admin-bff, не принимается
    forged = await env.client.get(path, headers=internal_headers(env.settings, issuer="support", actor=VIEWER))
    assert forged.status_code == 403


async def test_permissions_per_endpoint(env) -> None:
    u = await seed(env, 1)
    # analyst: dashboard.read без users.read — только stats
    assert (await env.get("/admin/v1/users/stats", ANALYST)).status_code == 200
    r = await env.get("/admin/v1/users", ANALYST)
    assert r.status_code == 403 and r.json()["details"]["permission"] == "users.read"
    assert (await env.get(f"/admin/v1/users/{u['user_id']}", ANALYST)).status_code == 403
    reader = Actor(id="x", role="read_only", permissions=frozenset({"users.read"}))
    r = await env.get("/admin/v1/users/stats", reader)
    assert r.status_code == 403 and r.json()["details"]["permission"] == "dashboard.read"


# ---------------------------------------------------------------- карточка

async def test_card_refreshes_from_identity(env) -> None:
    t = now() - timedelta(seconds=30)
    snap = env.identity.put(snapshot(n=4, updated_at=t, security={"pin_enabled": True, "biometric_enabled": True}))
    uid = snap["user_id"]
    await env.emit("user.preferences.updated.v1", {"user_id": uid, "changed_fields": ["interests", "budget"],
                                                   "onboarding_completed": True}, producer="preferences")
    await ticket(env, uid, 3700)
    r = await env.get(f"/admin/v1/users/{uid}")  # строка есть только по событиям → перечитана из identity
    assert r.status_code == 200, r.text
    card = r.json()
    assert set(card) == ROW_KEYS | {"consent", "security", "preferences", "refreshed_at"}
    assert "tickets" not in card and "ai_conversations" not in card  # их добавляет admin-bff
    assert card["username"] == "tester_4" and card["telegram_id_masked"] == MASK * 6 + "004"
    assert card["security"] == {"pin_enabled": True, "biometric_enabled": True}
    assert card["consent"]["policy_version"] == "1.0" and card["consent"]["purposes"] == ["personalization"]
    assert card["preferences"]["onboarding_completed"] is True
    assert card["preferences"]["changed_fields"] == ["interests", "budget"] and card["preferences"]["updated_at"]
    assert (card["open_tickets"], card["tickets_total"]) == (1, 1)
    refreshed = datetime.fromisoformat(card["refreshed_at"].replace("Z", "+00:00"))
    assert now() - refreshed < timedelta(seconds=5)

    # свежие данные (< 60 с) — без повторного чтения
    calls = len(env.identity.calls)
    again = (await env.get(f"/admin/v1/users/{uid}")).json()
    assert len(env.identity.calls) == calls and again["refreshed_at"] == card["refreshed_at"]

    # данные старше 60 с — перечитываются
    env.identity.put(snapshot(uid, n=4, username="renamed_4", updated_at=now()))
    async with env.runtime.transaction() as s:
        await s.execute(text("UPDATE admin_user_summary SET refreshed_at = now() - interval '61 seconds'"))
    stale = (await env.get(f"/admin/v1/users/{uid}")).json()
    assert len(env.identity.calls) == calls + 1 and stale["username"] == "renamed_4"


async def test_card_serves_stale_data_when_identity_down(env) -> None:
    u = await seed(env, 5)
    async with env.runtime.transaction() as s:
        await s.execute(text("UPDATE admin_user_summary SET refreshed_at = now() - interval '10 minutes'"))
    env.identity.down = True
    r = await env.get(f"/admin/v1/users/{u['user_id']}")
    assert r.status_code == 200 and r.json()["username"] == "tester_5"
    refreshed = datetime.fromisoformat(r.json()["refreshed_at"].replace("Z", "+00:00"))
    assert now() - refreshed > timedelta(minutes=9)  # честный момент последнего чтения
    env.identity.status_on_down = 500
    assert (await env.get(f"/admin/v1/users/{u['user_id']}")).status_code == 200
    # неизвестный пользователь при недоступном источнике — 503, а не 404
    missing = await env.get(f"/admin/v1/users/{uuid.uuid4()}")
    assert missing.status_code == 503 and missing.json()["details"] == {"service": ID}


async def test_card_not_found_and_validation(env) -> None:
    r = await env.get(f"/admin/v1/users/{uuid.uuid4()}")
    assert r.status_code == 404 and r.json()["code"] == "USER_NOT_FOUND"
    assert (await env.get("/admin/v1/users/123")).status_code == 422
    assert (await env.get("/admin/v1/users/TCK-3001")).status_code == 422


async def test_card_of_deleted_user_has_no_pii(env) -> None:
    u = await seed(env, 6)
    await env.emit("user.domain.deleted.v1", {"user_id": u["user_id"], "request_id": str(uuid.uuid4()),
                                              "domain": ID, "mode": "anonymized"}, producer=ID)
    env.identity.put(snapshot(u["user_id"], n=6, status="DELETED", username=None, display_name=None,
                              telegram_id_masked=MASK * 9))
    async with env.runtime.transaction() as s:
        await s.execute(text("UPDATE admin_user_summary SET refreshed_at = now() - interval '2 minutes'"))
    card = (await env.get(f"/admin/v1/users/{u['user_id']}")).json()
    assert card["status"] == "DELETED" and card["username"] is None and card["display_name"] is None
    assert card["telegram_id_masked"] == MASK * 9
    assert await ids(env, "q=tester_6") == []


async def test_full_telegram_id_never_exposed(env) -> None:
    # даже если источник по ошибке вернёт лишнее поле, read-модель его не хранит и не отдаёт
    snap = snapshot(n=7)
    snap["telegram_user_id"] = 987654321012
    env.identity.put(snap)
    await env.sync.run_once()
    for path in ("/admin/v1/users", f"/admin/v1/users/{snap['user_id']}"):
        body = (await env.get(path)).text
        assert "987654321012" not in body and "telegram_user_id" not in body
    async with env.runtime.transaction() as s:
        dump = repr((await s.execute(text("SELECT * FROM admin_user_summary"))).all())
    assert "987654321012" not in dump


async def test_unmasked_value_from_source_is_masked(env) -> None:
    # источник по ошибке прислал полный ID вместо маски — в read-модель попадают только последние 3 цифры
    snap = env.identity.put(snapshot(n=8, telegram_id_masked="987654321012"))
    await env.sync.run_once()
    [item] = (await env.get("/admin/v1/users")).json()["items"]
    assert item["telegram_id_masked"] == MASK * 6 + "012"
    env.identity.put(snapshot(snap["user_id"], n=8, telegram_id_masked="garbage"))
    async with env.runtime.transaction() as s:
        await s.execute(text("UPDATE admin_user_summary SET refreshed_at = now() - interval '2 minutes'"))
    card = (await env.get(f"/admin/v1/users/{snap['user_id']}")).json()
    assert card["telegram_id_masked"] == MASK * 9


async def test_rows_known_only_from_other_domains_are_hidden(env) -> None:
    ghost = str(uuid.uuid4())
    await env.emit("user.preferences.updated.v1", {"user_id": ghost, "changed_fields": ["interests"],
                                                   "onboarding_completed": True}, producer="preferences")
    assert await ids(env) == []
    missing = await env.get(f"/admin/v1/users/{ghost}")  # источник о нём не знает
    assert missing.status_code == 404 and missing.json()["code"] == "USER_NOT_FOUND"
    stats = (await env.get("/admin/v1/users/stats?period=30d")).json()
    assert stats["total"] == 0 and stats["by_status"]["ACTIVE"] == 0
    # профиль подтверждён источником — строка видна с уже применёнными данными онбординга
    env.identity.put(snapshot(ghost, n=9))
    await env.sync.run_once()
    [item] = (await env.get("/admin/v1/users")).json()["items"]
    assert item["user_id"] == ghost and item["onboarding_completed"] is True


# ---------------------------------------------------------------- stats

async def test_stats(env) -> None:
    empty = (await env.get("/admin/v1/users/stats?period=today", ANALYST)).json()
    assert empty == {"total": 0, "new_in_period": 0, "onboarding_completed_pct": 0.0,
                     "by_status": {"ACTIVE": 0, "DISABLED": 0, "DELETION_REQUESTED": 0, "DELETED": 0},
                     "active_in_period": 0, "active_today": 0}
    old = now() - timedelta(days=20)
    # «недавние» — внутри сегодняшнего дня по Ташкенту, даже если тест идёт сразу после полуночи
    recent = max(now() - timedelta(minutes=5), period_start("today", now(), "Asia/Tashkent") + timedelta(seconds=1))
    users = [await seed(env, n, created_at=(old if n < 2 else recent).isoformat())
             for n in range(4)]
    await env.emit("user.status.changed.v1", {"user_id": users[1]["user_id"], "status": "DISABLED",
                                              "previous_status": "ACTIVE"}, producer=ID)
    await env.emit("user.domain.deleted.v1", {"user_id": users[3]["user_id"], "request_id": str(uuid.uuid4()),
                                              "domain": ID, "mode": "anonymized"}, producer=ID)
    for u in users[:2]:
        await env.emit("user.preferences.updated.v1", {"user_id": u["user_id"], "changed_fields": ["onboarding"],
                                                       "onboarding_completed": True}, producer="preferences")
    week = (await env.get("/admin/v1/users/stats?period=7d", ANALYST)).json()
    assert week["by_status"] == {"ACTIVE": 2, "DISABLED": 1, "DELETION_REQUESTED": 0, "DELETED": 1}
    assert week["total"] == 3 and week["new_in_period"] == 2
    assert week["onboarding_completed_pct"] == pytest.approx(66.7)
    month = (await env.get("/admin/v1/users/stats?period=30d", ANALYST)).json()
    assert month["new_in_period"] == 4
    default = (await env.get("/admin/v1/users/stats", ANALYST)).json()
    assert default["new_in_period"] == 2  # today по умолчанию
    assert (await env.get("/admin/v1/users/stats?period=1y", ANALYST)).status_code == 422


async def test_stats_active_in_period_and_today(env) -> None:
    """Спринт 8: активные — неудалённые с last_seen_at ≥ начала периода; «сегодня» — по Ташкенту."""
    today = period_start("today", now(), "Asia/Tashkent")
    seen = {
        "now": max(now() - timedelta(minutes=1), today + timedelta(seconds=1)),
        "yesterday": today - timedelta(hours=1),
        "week": now() - timedelta(days=5),
        "month": now() - timedelta(days=20),
        "never": None,
    }
    users = {k: await seed(env, n, last_seen_at=None if v is None else v.isoformat())
             for n, (k, v) in enumerate(seen.items())}
    deleted = await seed(env, 9, last_seen_at=seen["now"].isoformat())
    await env.emit("user.domain.deleted.v1", {"user_id": deleted["user_id"], "request_id": str(uuid.uuid4()),
                                              "domain": ID, "mode": "anonymized"}, producer=ID)
    assert len(users) == 5
    day = (await env.get("/admin/v1/users/stats?period=today", ANALYST)).json()
    week = (await env.get("/admin/v1/users/stats?period=7d", ANALYST)).json()
    month = (await env.get("/admin/v1/users/stats?period=30d", ANALYST)).json()
    assert (day["active_in_period"], day["active_today"]) == (1, 1)
    assert (week["active_in_period"], week["active_today"]) == (3, 1)  # удалённый не считается
    assert (month["active_in_period"], month["active_today"]) == (4, 1)


def test_period_start_today_uses_business_timezone() -> None:
    # 2026-10-09 20:30 UTC = 2026-10-10 01:30 в Ташкенте → «сегодня» начинается 2026-10-09 19:00 UTC
    at = datetime(2026, 10, 9, 20, 30, tzinfo=UTC)
    assert period_start("today", at, "Asia/Tashkent") == datetime(2026, 10, 9, 19, 0, tzinfo=UTC)
    assert period_start("7d", at, "Asia/Tashkent") == at - timedelta(days=7)


# ---------------------------------------------------------------- PII не в логах

async def test_pii_not_in_logs(make_env, caplog) -> None:
    identity = FakeIdentity()
    env = await make_env(identity)
    secret_name, secret_username = "Секретное Имяфамилия", "secret_login_42"
    snap = identity.put(snapshot(n=42, username=secret_username, display_name=secret_name))
    with caplog.at_level(logging.DEBUG):
        await env.sync.run_once()
        await env.get(f"/admin/v1/users?q={secret_username}")
        await env.get(f"/admin/v1/users?q=@{secret_username}")
        async with env.runtime.transaction() as s:
            await s.execute(text("UPDATE admin_user_summary SET refreshed_at = NULL"))
        await env.get(f"/admin/v1/users/{snap['user_id']}")
        identity.down = True
        async with env.runtime.transaction() as s:
            await s.execute(text("UPDATE admin_user_summary SET refreshed_at = now() - interval '1 hour'"))
        await env.get(f"/admin/v1/users/{snap['user_id']}")
        with pytest.raises(Exception):  # noqa: B017 - сбой источника
            await env.sync.run_once()
        await env.emit("user.status.changed.v1", {"user_id": "bad", "status": "DISABLED"}, producer=ID)
    assert caplog.records  # логи действительно писались
    assert secret_name not in caplog.text and secret_username not in caplog.text
    assert snap["user_id"] not in caplog.text  # user_id в логах — только псевдоним
