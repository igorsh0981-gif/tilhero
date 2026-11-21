"""Staff API user-admin: список (поиск, фильтры, курсор), карточка (перечитывание identity-consent, дети и опекун),
статистика дашборда, права и вызывающие, маска Telegram ID, PII не в логах."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from user_admin_testkit import (
    ANALYST,
    ID,
    LP,
    MASK,
    METHODIST,
    OPERATIONS,
    OUTSIDER,
    SUPER,
    VIEWER,
    fake_identity,
    iso,
    now,
    plan,
    snapshot,
)

from tilhero_common.internal_auth import Actor
from tilhero_common.testing import internal_headers
from tilhero_user_admin.domain.queries import period_start

ROW_KEYS = {"user_id", "kind", "guardian_user_id", "display_name", "username", "telegram_id_masked", "locale",
            "age_band", "guardian_consent", "status", "onboarding_completed", "goal", "reminders_enabled",
            "children_count", "open_tickets", "tickets_total", "created_at", "last_activity_at"}
CARD_KEYS = ROW_KEYS | {"consent", "security", "notifications", "plan", "children", "guardian", "refreshed_at"}


async def ticket(env, uid: str, number: int, status: str | None = None) -> None:
    tid = str(uuid.uuid4())
    await env.emit("support.ticket.created.v1", {"ticket_id": tid, "number": f"TCK-{number}", "user_id": uid,
                                                 "category": "other", "priority": "normal"}, producer="support")
    if status:
        await env.emit("support.ticket.status.changed.v1", {"ticket_id": tid, "number": f"TCK-{number}",
                                                            "user_id": uid, "from_status": "NEW", "to_status": status,
                                                            "changed_by": "operator"}, producer="support")


async def ids(env, query: str = "", actor: Actor = VIEWER) -> list[str]:
    r = await env.get(f"/admin/v1/learners?{query}", actor)
    assert r.status_code == 200, r.text
    return [i["user_id"] for i in r.json()["items"]]


async def family(env) -> tuple[dict, dict, dict]:
    """Аккаунт родителя с двумя детскими профилями (второй удалён)."""
    parent = await env.seed(1, display_name="Родитель Тестовый")
    kid = env.identity.put(snapshot(n=2, kind="child", guardian=parent["user_id"], display_name="Малыш Тестовый"))
    gone = env.identity.put(snapshot(n=3, kind="child", guardian=parent["user_id"]))
    await env.reconciler.identity.run_once()
    await env.emit("user.domain.deleted.v1", {"user_id": gone["user_id"], "request_id": str(uuid.uuid4()),
                                              "domain": ID, "mode": "anonymized"}, producer=ID)
    return parent, kid, gone


async def stale(env) -> None:
    async with env.runtime.transaction() as s:
        await s.execute(text("UPDATE admin_learner_summary SET refreshed_at = now() - interval '10 minutes'"))


# ---------------------------------------------------------------- список

async def test_list_rows_match_contract(env) -> None:
    a = await env.seed(1, created_at=iso(now() - timedelta(days=3)))
    await ticket(env, a["user_id"], 3001)
    await ticket(env, a["user_id"], 3002, "CLOSED")
    env.plans.put(plan(a["user_id"]))
    await env.reconciler.plans.run_once()
    await env.emit("learning.activity.recorded.v1", {"user_id": a["user_id"], "activity_id": str(uuid.uuid4()),
                                                     "local_date": "2026-11-18", "kind": "lesson", "minutes": 10,
                                                     "recorded_at": iso(now())}, producer=LP)
    r = await env.get("/admin/v1/learners")
    assert r.status_code == 200
    [item] = r.json()["items"]
    assert set(item) == ROW_KEYS
    assert item["user_id"] == a["user_id"] and item["username"] == "te•••_1" and item["kind"] == "account"
    assert item["telegram_id_masked"] == MASK * 6 + "001" and item["guardian_user_id"] is None
    assert (item["locale"], item["age_band"], item["guardian_consent"]) == ("ru", "18+", "not_required")
    assert (item["open_tickets"], item["tickets_total"], item["children_count"]) == (1, 2, 0)  # не из снимка (99)
    assert (item["goal"], item["reminders_enabled"], item["onboarding_completed"]) == ("travel", True, True)
    assert item["last_activity_at"] and item["created_at"].endswith(("Z", "+00:00"))


async def test_account_and_children_in_list(env) -> None:
    parent, kid, gone = await family(env)
    rows = {i["user_id"]: i for i in (await env.get("/admin/v1/learners")).json()["items"]}
    assert rows[parent["user_id"]]["children_count"] == 1  # удалённый ребёнок не считается
    child = rows[kid["user_id"]]
    assert child["kind"] == "child" and child["guardian_user_id"] == parent["user_id"]
    assert child["username"] is None and child["telegram_id_masked"] is None and child["age_band"] == "6-9"
    assert rows[gone["user_id"]]["status"] == "DELETED" and rows[gone["user_id"]]["guardian_user_id"] is None
    assert await ids(env, "kind=account") == [parent["user_id"]]
    assert set(await ids(env, "kind=child")) == {kid["user_id"], gone["user_id"]}
    assert await ids(env, "kind=child&status=ACTIVE") == [kid["user_id"]]


async def test_search_by_uuid_username_name_and_ticket(env) -> None:
    ivan = await env.seed(1, username="ivan_petrov", display_name="Иван Петров")
    maria = await env.seed(2, username="maria_s", display_name="Мария Сидорова")
    other = await env.seed(3, username="ivanova_x", display_name="Ольга Иванова (o_k)")
    await ticket(env, maria["user_id"], 3081)

    assert await ids(env, f"q={ivan['user_id']}") == [ivan["user_id"]]
    assert await ids(env, f"q={uuid.uuid4()}") == []
    # @username — только точное совпадение полного username (без регистра): префикс не раскрывает его по буквам
    assert await ids(env, "q=@ivan_petrov") == [ivan["user_id"]]
    assert await ids(env, "q=@IVAN_PETROV") == [ivan["user_id"]]
    assert await ids(env, "q=@ivan") == [] and await ids(env, "q=@ivan_p") == []
    assert await ids(env, "q=@bad name") == []
    assert set(await ids(env, "q=иван")) == {ivan["user_id"], other["user_id"]}  # часть имени без регистра
    assert await ids(env, "q=СИДОРОВ") == [maria["user_id"]]
    assert await ids(env, "q=maria_s") == [] and await ids(env, "q=petrov") == []  # username не в search_text
    assert await ids(env, "q=TCK-3081") == [maria["user_id"]]
    assert await ids(env, "q=tck-3081") == [maria["user_id"]]
    assert await ids(env, "q=TCK-9999") == []
    # спецсимволы LIKE экранируются: «_» — литерал, а не «любой символ» (иначе совпало бы с «ольга иванова»)
    assert await ids(env, "q=%25") == []
    assert await ids(env, "q=ольга_иванова") == []
    assert await ids(env, "q=o_k") == [other["user_id"]]
    assert await ids(env, "q=%5C") == []  # обратная косая — тоже литерал


async def test_username_masked_unless_sensitive_read(env) -> None:
    """username — маска `ig•••81` без «@» (короче 5 — `•••`) в списке, карточке, детях и опекуне; полностью — только с
    users.sensitive.read (ревью T2-3). Поиск q=@username — точный по полному username и с маской."""
    parent = await env.seed(1, username="igor_tester_81", display_name="Родитель Тестовый")
    short = await env.seed(2, username="abcd")
    five = await env.seed(3, username="abcde")
    kid = env.identity.put(snapshot(n=4, kind="child", guardian=parent["user_id"], display_name="Ребёнок Тестовый"))
    await env.reconciler.identity.run_once()
    masked = {parent["user_id"]: "ig•••81", short["user_id"]: "•••", five["user_id"]: "ab•••de",
              kid["user_id"]: None}
    full = {parent["user_id"]: "igor_tester_81", short["user_id"]: "abcd", five["user_id"]: "abcde",
            kid["user_id"]: None}
    for actor, expected in ((VIEWER, masked), (METHODIST, masked), (OPERATIONS, masked), (SUPER, full)):
        listing = await env.get("/admin/v1/learners", actor)
        assert {i["user_id"]: i["username"] for i in listing.json()["items"]} == expected, actor.role
        names = {i["user_id"]: i["display_name"] for i in listing.json()["items"]}
        assert names[parent["user_id"]] == "Родитель Тестовый"  # отображаемое имя — для обращения поддержки
        card = (await env.get(f"/admin/v1/learners/{parent['user_id']}", actor)).json()
        assert card["username"] == expected[parent["user_id"]]
        assert [c["username"] for c in card["children"]] == [None]
        child = (await env.get(f"/admin/v1/learners/{kid['user_id']}", actor)).json()
        assert child["guardian"]["username"] == expected[parent["user_id"]]
        assert await ids(env, "q=@igor_tester_81", actor) == [parent["user_id"]]
        assert await ids(env, "q=@igor", actor) == [] and await ids(env, "q=tester_81", actor) == []
        if actor is not SUPER:
            for body in (listing.text, json.dumps(card), json.dumps(child)):
                assert "igor_tester_81" not in body and "abcde" not in body


async def test_ticket_search_requires_support_read(env) -> None:
    """Без support.read поиск по номеру обращения не выполняется (методист видит учеников, но не поддержку)."""
    maria = await env.seed(2, username="maria_s")
    await ticket(env, maria["user_id"], 4242)
    assert await ids(env, "q=TCK-4242", VIEWER) == [maria["user_id"]]
    assert await ids(env, "q=TCK-4242", METHODIST) == []
    assert await ids(env, "q=@maria_s", METHODIST) == [maria["user_id"]]  # маска поиску не мешает


async def test_filters_and_pagination(env) -> None:
    base = now() - timedelta(days=10)
    users = [await env.seed(n, created_at=iso(base + timedelta(hours=n)), locale="uz" if n % 2 else "ru",
                            age_band="14-17" if n == 2 else ("18+" if n != 4 else None))
             for n in range(5)]
    await env.emit("user.status.changed.v1", {"user_id": users[0]["user_id"], "status": "DISABLED",
                                              "previous_status": "ACTIVE"}, producer=ID)
    await ticket(env, users[1]["user_id"], 3500)
    newest_first = [u["user_id"] for u in reversed(users)]
    assert await ids(env) == newest_first
    assert await ids(env, "status=DISABLED") == [users[0]["user_id"]]
    assert await ids(env, "status=active,disabled") == newest_first
    assert await ids(env, "locale=uz") == [users[3]["user_id"], users[1]["user_id"]]
    assert await ids(env, "has_open_tickets=true") == [users[1]["user_id"]]
    assert len(await ids(env, "has_open_tickets=false")) == 4
    assert await ids(env, "age_band=14-17") == [users[2]["user_id"]]
    assert await ids(env, "age_band=unknown") == [users[4]["user_id"]]
    assert await ids(env, "age_band=14-17,unknown") == [users[4]["user_id"], users[2]["user_id"]]
    adults = [users[3]["user_id"], users[1]["user_id"], users[0]["user_id"]]
    assert await ids(env, "age_band=18%2B") == adults
    assert await ids(env, "age_band=18+") == adults  # «+» без кодирования приходит пробелом
    seen: list[str] = []
    cursor = None
    while True:
        r = (await env.get("/admin/v1/learners?limit=2" + (f"&cursor={cursor}" if cursor else ""))).json()
        seen += [i["user_id"] for i in r["items"]]
        cursor = r["next_cursor"]
        if not cursor:
            break
    assert seen == newest_first


async def test_pagination_is_stable_while_projection_changes(env) -> None:
    """Ключ курсора (created_at, user_id) неизменен после подтверждения профиля: снимки и повторные
    profile.created с иным created_at, новые строки из событий других доменов не дают пропусков и дублей."""
    base = now() - timedelta(days=5)
    users = [await env.seed(n, created_at=iso(base + timedelta(minutes=n))) for n in range(6)]
    expected = [u["user_id"] for u in reversed(users)]
    first = (await env.get("/admin/v1/learners?limit=2")).json()
    assert [i["user_id"] for i in first["items"]] == expected[:2]
    for u, shift in ((users[5], -10), (users[0], +10), (users[3], +3)):
        moved = dict(u, created_at=iso(datetime.fromisoformat(u["created_at"]) + timedelta(days=shift)),
                     updated_at=iso(now()))
        env.identity.put(moved)
    await env.reconciler.identity.run_once()
    await env.emit("user.profile.created.v1", {"user_id": users[2]["user_id"], "kind": "account", "locale": "ru",
                                               "created_at": iso(now())}, producer=ID)
    await env.emit("learning.activity.recorded.v1", {"user_id": str(uuid.uuid4()), "activity_id": str(uuid.uuid4()),
                                                     "local_date": "2026-11-18", "kind": "lesson", "minutes": 1,
                                                     "recorded_at": iso(now())}, producer=LP)
    seen = [i["user_id"] for i in first["items"]]
    cursor = first["next_cursor"]
    while cursor:
        page = (await env.get(f"/admin/v1/learners?limit=2&cursor={cursor}")).json()
        seen += [i["user_id"] for i in page["items"]]
        cursor = page["next_cursor"]
    assert seen == expected  # без пропусков и дублей, порядок прежний


async def test_list_validation(env) -> None:
    for query in ("limit=0", "limit=101", "status=GONE", "locale=en", "locale=x", "kind=parent",
                  "age_band=5-6", "has_open_tickets=maybe", "q=" + "x" * 121, "cursor=" + "x" * 257):
        r = await env.get(f"/admin/v1/learners?{query}")
        assert r.status_code == 422, query
    for query in ("status=GONE", "age_band=5-6"):
        assert (await env.get(f"/admin/v1/learners?{query}")).json()["code"] == "LEARNER_FILTER_INVALID"
    assert await ids(env, "q=" + "x" * 120) == []
    bad = await env.get("/admin/v1/learners?cursor=bm9wZQ")
    assert bad.status_code == 400 and bad.json()["code"] == "INVALID_CURSOR"


@pytest.mark.parametrize("path", ["/admin/v1/learners", "/admin/v1/learners/stats",
                                  "/admin/v1/learners/00000000-0000-4000-8000-000000000001"])
async def test_auth_and_callers(env, path) -> None:
    assert (await env.client.get(path)).status_code == 401
    assert (await env.client.get(path, headers={"x-internal-token": "garbage"})).status_code == 401
    wrong_aud = internal_headers(env.settings, issuer="admin-bff", actor=VIEWER, audience="support")
    assert (await env.client.get(path, headers=wrong_aud)).status_code == 401
    for issuer in ("telegram-bff", "support", ID, LP, "notifications"):
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
    u = await env.seed(1)
    # dashboard.read без users.read — только stats
    assert (await env.get("/admin/v1/learners/stats", ANALYST)).status_code == 200
    r = await env.get("/admin/v1/learners", ANALYST)
    assert r.status_code == 403 and r.json()["details"]["permission"] == "users.read"
    r = await env.get(f"/admin/v1/learners/{u['user_id']}", ANALYST)
    assert r.status_code == 403 and r.json()["details"]["permission"] == "users.read"
    reader = Actor(id="x", role="custom", permissions=frozenset({"users.read"}))
    r = await env.get("/admin/v1/learners/stats", reader)
    assert r.status_code == 403 and r.json()["details"]["permission"] == "dashboard.read"


# ---------------------------------------------------------------- карточка

async def test_card_refreshes_from_identity(env) -> None:
    snap = env.identity.put(snapshot(n=4, security={"pin_enabled": True, "pin_reset_pending": True},
                                     guardian_consent="granted", age_band="14-17"))
    uid = snap["user_id"]
    env.plans.put(plan(uid, goal="exam", level_self="some"))
    await env.reconciler.plans.run_once()  # строка есть только по плану → в карточку — после чтения identity
    await ticket(env, uid, 3700)
    r = await env.get(f"/admin/v1/learners/{uid}")
    assert r.status_code == 200, r.text
    card = r.json()
    assert set(card) == CARD_KEYS and "tickets" not in card  # обращения добавляет admin-bff
    assert card["username"] == "te•••_4" and card["telegram_id_masked"] == MASK * 6 + "004"
    assert (card["age_band"], card["guardian_consent"]) == ("14-17", "granted")
    assert card["security"] == {"pin_enabled": True, "pin_reset_pending": True}
    assert card["consent"] == {"policy_version": "1.0", "purposes": ["terms", "privacy"],
                               "accepted_at": snap["consent"]["accepted_at"], "revoked_at": None, "basis": "self"}
    assert card["notifications"] == snap["notifications"]
    assert set(card["notifications"]["categories"]) == {"reminders", "missed", "social", "support", "product", "game"}
    assert card["plan"]["goal"] == "exam" and card["plan"]["level_self"] == "some"
    assert card["plan"]["schedule"]["preset"] == "weekdays" and card["plan"]["onboarding_completed_at"]
    assert (card["goal"], card["onboarding_completed"]) == ("exam", True)
    assert (card["open_tickets"], card["tickets_total"]) == (1, 1)
    assert card["children"] == [] and card["guardian"] is None
    refreshed = datetime.fromisoformat(card["refreshed_at"].replace("Z", "+00:00"))
    assert now() - refreshed < timedelta(seconds=5)

    # каждое открытие карточки перечитывает identity-consent
    env.identity.put(snapshot(uid, n=4, username="renamed_4"))
    calls = len(env.identity.calls)
    again = (await env.get(f"/admin/v1/learners/{uid}")).json()
    assert len(env.identity.calls) == calls + 1 and again["username"] == "re•••_4"


async def test_card_children_and_guardian(env) -> None:
    parent, kid, _gone = await family(env)
    card = (await env.get(f"/admin/v1/learners/{parent['user_id']}")).json()
    assert card["children_count"] == 1 and [c["user_id"] for c in card["children"]] == [kid["user_id"]]
    assert set(card["children"][0]) == ROW_KEYS and card["children"][0]["kind"] == "child"
    assert card["guardian"] is None
    child = (await env.get(f"/admin/v1/learners/{kid['user_id']}")).json()
    assert child["kind"] == "child" and child["children"] == [] and child["children_count"] == 0
    assert child["guardian"]["user_id"] == parent["user_id"] and child["guardian"]["children_count"] == 1
    assert child["telegram_id_masked"] is None and child["username"] is None
    assert child["consent"]["basis"] == "guardian"


async def test_card_serves_projection_when_identity_down(env) -> None:
    u = await env.seed(5)
    await stale(env)
    env.identity.down = True
    r = await env.get(f"/admin/v1/learners/{u['user_id']}")
    assert r.status_code == 200 and r.json()["display_name"] == "Тестовый Ученик 5"
    refreshed = datetime.fromisoformat(r.json()["refreshed_at"].replace("Z", "+00:00"))
    assert now() - refreshed > timedelta(minutes=9)  # честный момент последнего чтения
    env.identity.status_on_down = 500
    assert (await env.get(f"/admin/v1/learners/{u['user_id']}")).status_code == 200
    # неизвестный ученик при недоступном источнике — 503, а не 404
    missing = await env.get(f"/admin/v1/learners/{uuid.uuid4()}")
    assert missing.status_code == 503 and missing.json()["details"] == {"service": ID}


async def test_card_from_events_only_when_identity_down(env) -> None:
    """Профиль известен только по событию (сверки ещё не было): refreshed_at — время проекции."""
    uid = str(uuid.uuid4())
    await env.emit("user.profile.created.v1", {"user_id": uid, "kind": "account", "locale": "uz",
                                               "created_at": iso(now())}, producer=ID)
    env.identity.down = True
    r = await env.get(f"/admin/v1/learners/{uid}")
    assert r.status_code == 200, r.text
    assert r.json()["locale"] == "uz" and r.json()["username"] is None and r.json()["refreshed_at"]


async def test_card_not_found_and_validation(env) -> None:
    r = await env.get(f"/admin/v1/learners/{uuid.uuid4()}")
    assert r.status_code == 404 and r.json()["code"] == "LEARNER_NOT_FOUND"
    assert (await env.get("/admin/v1/learners/123")).status_code == 422
    assert (await env.get("/admin/v1/learners/TCK-3001")).status_code == 422


async def test_card_rejects_snapshot_of_another_learner(env) -> None:
    """Защита в глубину: ответ источника о другом ученике не применяется к карточке."""
    u = await env.seed(6)
    other = snapshot(n=7)
    env.identity.items[u["user_id"]] = other  # источник по ошибке вернул чужой снимок
    card = (await env.get(f"/admin/v1/learners/{u['user_id']}")).json()
    assert card["user_id"] == u["user_id"] and card["display_name"] == "Тестовый Ученик 6"
    assert await ids(env, f"q={other['user_id']}") == []


async def test_card_of_deleted_learner_has_no_pii(env) -> None:
    u = await env.seed(6)
    await env.emit("user.domain.deleted.v1", {"user_id": u["user_id"], "request_id": str(uuid.uuid4()),
                                              "domain": ID, "mode": "anonymized"}, producer=ID)
    env.identity.items.pop(u["user_id"])  # identity-consent не отдаёт обезличенного ученика
    r = await env.get(f"/admin/v1/learners/{u['user_id']}")
    assert r.status_code == 200, r.text
    card = r.json()
    assert card["status"] == "DELETED" and card["username"] is None and card["display_name"] is None
    assert card["telegram_id_masked"] is None and card["plan"] is None and card["notifications"] is None
    assert await ids(env, "q=@tester_6", SUPER) == [] and await ids(env, "q=Тестовый", SUPER) == []


async def test_full_telegram_id_never_exposed(env) -> None:
    # даже если источник по ошибке вернёт лишнее поле, read-модель его не хранит и не отдаёт
    snap = snapshot(n=7)
    snap["telegram_user_id"] = 987654321012
    env.identity.put(snap)
    await env.reconciler.identity.run_once()
    for path in ("/admin/v1/learners", f"/admin/v1/learners/{snap['user_id']}"):
        body = (await env.get(path)).text
        assert "987654321012" not in body and "telegram_user_id" not in body
    async with env.runtime.transaction() as s:
        dump = repr((await s.execute(text("SELECT * FROM admin_learner_summary"))).all())
    assert "987654321012" not in dump


async def test_unmasked_value_from_source_is_masked(env) -> None:
    # источник по ошибке прислал полный ID вместо маски — в read-модель попадают только последние 3 цифры
    snap = env.identity.put(snapshot(n=8, telegram_id_masked="987654321012"))
    await env.reconciler.identity.run_once()
    [item] = (await env.get("/admin/v1/learners")).json()["items"]
    assert item["telegram_id_masked"] == MASK * 6 + "012"
    env.identity.put(snapshot(snap["user_id"], n=8, telegram_id_masked="garbage"))
    card = (await env.get(f"/admin/v1/learners/{snap['user_id']}")).json()
    assert card["telegram_id_masked"] is None
    # у детского профиля Telegram нет, даже если источник прислал маску и username
    kid = env.identity.put(snapshot(n=9, kind="child", guardian=snap["user_id"], username="kid_login",
                                    telegram_id_masked=MASK * 6 + "321"))
    card = (await env.get(f"/admin/v1/learners/{kid['user_id']}")).json()
    assert card["telegram_id_masked"] is None and card["username"] is None


async def test_rows_known_only_from_other_domains_are_hidden(env) -> None:
    ghost = str(uuid.uuid4())
    await env.emit("learning.plan.updated.v1", {"user_id": ghost, "changed_fields": ["onboarding_completed_at"],
                                                "goal": "work", "days": [1], "preferred_time": "10:00",
                                                "duration_min": 10, "reminders_enabled": True,
                                                "timezone": "Asia/Tashkent", "onboarding_completed": True},
                   producer=LP)
    assert await ids(env) == []
    missing = await env.get(f"/admin/v1/learners/{ghost}")  # источник о нём не знает
    assert missing.status_code == 404 and missing.json()["code"] == "LEARNER_NOT_FOUND"
    stats = (await env.get("/admin/v1/learners/stats?period=30d")).json()
    assert stats["total_accounts"] == 0 and stats["new_in_period"] == 0
    # профиль подтверждён источником — строка видна с уже применёнными данными плана
    env.identity.put(snapshot(ghost, n=9))
    await env.reconciler.identity.run_once()
    [item] = (await env.get("/admin/v1/learners")).json()["items"]
    assert item["user_id"] == ghost and item["onboarding_completed"] is True and item["goal"] == "work"


# ---------------------------------------------------------------- stats

async def test_stats(env) -> None:
    empty = (await env.get("/admin/v1/learners/stats?period=today", ANALYST)).json()
    assert empty == {"total_accounts": 0, "total_children": 0, "new_in_period": 0, "active_in_period": 0,
                     "onboarding_completed_pct": 0.0, "reminders_enabled_pct": 0.0,
                     "by_age_band": {"6-9": 0, "10-13": 0, "14-17": 0, "18+": 0, "unknown": 0},
                     "by_locale": {"ru": 0, "uz": 0, "unknown": 0}}
    old = now() - timedelta(days=20)
    # «недавние» — внутри сегодняшнего дня по Ташкенту, даже если тест идёт сразу после полуночи
    recent = max(now() - timedelta(minutes=5), period_start("today", now(), "Asia/Tashkent") + timedelta(seconds=1))
    a0 = await env.seed(0, created_at=iso(old), locale="uz")
    a1 = await env.seed(1, created_at=iso(old), age_band="14-17")
    k2 = env.identity.put(snapshot(n=2, kind="child", guardian=a0["user_id"], created_at=iso(recent), age_band="10-13"))
    d3 = await env.seed(3, created_at=iso(recent), age_band=None)
    await env.emit("user.domain.deleted.v1", {"user_id": d3["user_id"], "request_id": str(uuid.uuid4()),
                                              "domain": ID, "mode": "anonymized"}, producer=ID)
    for uid, reminders in ((a0["user_id"], True), (k2["user_id"], False)):
        env.plans.put(plan(uid, schedule={"preset": "daily", "days": [1, 2, 3, 4, 5, 6, 7], "preferred_time": "18:00",
                                          "duration_min": 10, "reminders_enabled": reminders,
                                          "timezone": "Asia/Tashkent"}))
    await env.reconciler.plans.run_once()
    for uid, at in ((a0["user_id"], now() - timedelta(days=3)), (a1["user_id"], now() - timedelta(days=10)),
                    (d3["user_id"], now())):
        await env.emit("learning.activity.recorded.v1", {"user_id": uid, "activity_id": str(uuid.uuid4()),
                                                         "local_date": "2026-11-18", "kind": "lesson", "minutes": 5,
                                                         "recorded_at": iso(at)}, producer=LP)
    week = (await env.get("/admin/v1/learners/stats?period=7d", ANALYST)).json()
    assert (week["total_accounts"], week["total_children"]) == (2, 1)
    assert week["new_in_period"] == 2  # ребёнок и удалённый — созданы недавно
    assert week["active_in_period"] == 1  # a0; удалённый не считается
    assert week["onboarding_completed_pct"] == pytest.approx(66.7)
    assert week["reminders_enabled_pct"] == pytest.approx(33.3)
    assert week["by_age_band"] == {"6-9": 0, "10-13": 1, "14-17": 1, "18+": 1, "unknown": 0}
    assert week["by_locale"] == {"ru": 2, "uz": 1, "unknown": 0}
    month = (await env.get("/admin/v1/learners/stats?period=30d", ANALYST)).json()
    assert month["new_in_period"] == 4 and month["active_in_period"] == 2
    default = (await env.get("/admin/v1/learners/stats", ANALYST)).json()
    assert default["new_in_period"] == 2  # today по умолчанию
    assert (await env.get("/admin/v1/learners/stats?period=1y", ANALYST)).status_code == 422


def test_period_start_today_uses_business_timezone() -> None:
    # 2026-10-09 20:30 UTC = 2026-10-10 01:30 в Ташкенте → «сегодня» начинается 2026-10-09 19:00 UTC
    at = datetime(2026, 10, 9, 20, 30, tzinfo=UTC)
    assert period_start("today", at, "Asia/Tashkent") == datetime(2026, 10, 9, 19, 0, tzinfo=UTC)
    assert period_start("7d", at, "Asia/Tashkent") == at - timedelta(days=7)


# ---------------------------------------------------------------- PII не в логах

async def test_pii_not_in_logs(make_env, caplog) -> None:
    identity = fake_identity()
    env = await make_env(identity)
    secret_name, secret_username = "Секретное Имяфамилия", "secret_login_42"
    snap = identity.put(snapshot(n=42, username=secret_username, display_name=secret_name))
    with caplog.at_level(logging.DEBUG):
        await env.reconciler.identity.run_once()
        await env.get(f"/admin/v1/learners?q={secret_username}")
        await env.get(f"/admin/v1/learners?q=@{secret_username}")
        await env.get(f"/admin/v1/learners/{snap['user_id']}")
        identity.down = True
        await env.get(f"/admin/v1/learners/{snap['user_id']}")
        with pytest.raises(Exception):  # noqa: B017 - сбой источника
            await env.reconciler.identity.run_once()
        await env.reconciler.identity.run_safe()
        await env.emit("user.status.changed.v1", {"user_id": "bad", "status": "DISABLED"}, producer=ID)
    assert caplog.records  # логи действительно писались
    assert secret_name not in caplog.text and secret_username not in caplog.text
    assert snap["user_id"] not in caplog.text  # user_id в логах — только псевдоним
