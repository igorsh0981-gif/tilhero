"""Рабочее место оператора: «Как видит клиент», «Взять в работу», статистика для Dashboard, фильтр по ученику."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

from sqlalchemy import text
from support_testkit import CONTEXT, OPERATOR, OPERATOR_2, OUTSIDER, READER

from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms, internal_headers

DASHBOARD = Actor(id="analyst.01", role="analyst", permissions=frozenset({"dashboard.read", "users.read"}))
STAFF_ONLY_KEYS = {"user_id", "assignee_id", "visibility", "author_id", "priority", "escalations", "correlation_id",
                   "sla_state", "channel", "anonymized"}


def _keys(obj) -> set[str]:
    found: set[str] = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            found.add(k)
            found |= _keys(v)
    elif isinstance(obj, list):
        for v in obj:
            found |= _keys(v)
    return found


# ---------------------------------------------------------------- client-view

async def test_client_view_equals_client_api_without_internal_notes(env) -> None:
    user = uuid.uuid4()
    t = await env.create(user, category="LESSON", context=CONTEXT)
    ref = t["ticket_id"]
    marker = "ВНУТРЕННЯЯ-ЗАМЕТКА-" + uuid.uuid4().hex
    assert (await env.reply(ref, marker, visibility="internal")).status_code == 200
    assert (await env.reply(ref, "Напоминание перенастроили, проверьте")).status_code == 200

    client = await env.client.get(f"/internal/v1/me/tickets/{ref}", headers=env.user(user))
    view = await env.client.get(f"/admin/v1/support/tickets/{ref}/client-view", headers=env.staff(READER))
    assert view.status_code == 200, view.text
    assert view.json() == client.json()  # ровно то, что видит владелец
    assert marker not in view.text
    assert not (_keys(view.json()) & STAFF_ONLY_KEYS), _keys(view.json()) & STAFF_ONLY_KEYS
    assert [m["sender_type"] for m in view.json()["messages"]] == ["user", "operator"]
    assert view.json()["messages"][1]["author_name"] == "Алина"  # без фамилии, как у клиента
    # по номеру тоже
    by_number = await env.client.get(f"/admin/v1/support/tickets/{t['number']}/client-view", headers=env.staff())
    assert by_number.json() == view.json()
    # staff-представление при этом содержит заметку
    staff = await env.client.get(f"/admin/v1/support/tickets/{ref}", headers=env.staff(READER))
    assert marker in staff.text


async def test_client_view_is_read_only(env) -> None:
    user = uuid.uuid4()
    t = await env.create(user)
    await env.reply(t["ticket_id"])
    for _ in range(2):
        view = await env.client.get(f"/admin/v1/support/tickets/{t['ticket_id']}/client-view",
                                    headers=env.staff())
        assert view.json()["unread_operator_replies"] == 1
    listing = (await env.client.get("/internal/v1/me/tickets", headers=env.user(user))).json()
    assert listing["items"][0]["unread_operator_replies"] == 1  # просмотр сотрудником не «прочитал» за клиента


async def test_client_view_auth_and_not_found(env) -> None:
    t = await env.create(uuid.uuid4())
    path = f"/admin/v1/support/tickets/{t['ticket_id']}/client-view"
    assert (await env.client.get(path)).status_code == 401
    denied = await env.client.get(path, headers=env.staff(OUTSIDER))
    assert denied.status_code == 403 and denied.json()["details"]["permission"] == "support.read"
    assert (await env.client.get(path, headers=env.staff(DASHBOARD))).status_code == 403
    no_actor = await env.client.get(path, headers=env.staff(None))
    assert no_actor.status_code == 403 and no_actor.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    foreign = await env.client.get(path, headers=env.staff(READER, issuer="telegram-bff"))
    assert foreign.status_code == 403 and foreign.json()["code"] == "CALLER_NOT_ALLOWED"
    for ref in (str(uuid.uuid4()), "TCK-1", "garbage"):
        r = await env.client.get(f"/admin/v1/support/tickets/{ref}/client-view", headers=env.staff())
        assert r.status_code == 404 and r.json()["code"] == "SUPPORT_TICKET_NOT_FOUND"


async def test_client_view_of_anonymized_ticket(env) -> None:
    user = uuid.uuid4()
    t = await env.create(user, subject="Личная тема обращения", message="Мой телефон +998 90 000 00 00")
    await env.bus.publish(make_envelope("user.deletion.requested.v1",
                                        {"user_id": str(user), "request_id": str(uuid.uuid4()),
                                         "requested_at": datetime.now(UTC).isoformat()},
                                        producer="identity-consent"))
    view = await env.client.get(f"/admin/v1/support/tickets/{t['ticket_id']}/client-view", headers=env.staff())
    assert view.status_code == 200
    assert "+998" not in view.text and "Личная тема" not in view.text
    assert view.json()["status"] == "CLOSED"


# ---------------------------------------------------------------- take

async def test_take_assigns_and_starts_work(env) -> None:
    t = await env.create(uuid.uuid4())
    ref = t["ticket_id"]
    await env.flush()
    published = len(env.bus.published)
    r = await env.client.post(f"/admin/v1/support/tickets/{ref}/take", headers=env.staff(OPERATOR))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "IN_PROGRESS" and r.json()["assignee_id"] == OPERATOR.id
    assert r.json()["status_history"][-1]["actor_id"] == OPERATOR.id
    await env.flush()
    new = env.bus.published[published:]
    for e in new:
        assert_event_conforms(e)
    # события одной транзакции имеют одинаковый created_at в outbox — порядок между ними не гарантирован
    assert sorted(e.event_type for e in new) == ["admin.audit.recorded.v1", "support.ticket.status.changed.v1"]
    [audit] = [e.payload for e in new if e.event_type == "admin.audit.recorded.v1"]
    assert audit["action"] == "ticket.take" and audit["actor_id"] == OPERATOR.id
    assert audit["before"]["status"] == "NEW" and audit["before"]["assignee_id"] is None
    assert audit["after"] == {**audit["before"], "status": "IN_PROGRESS", "assignee_id": OPERATOR.id}

    # повтор тем же оператором — без изменений и без новых записей
    again = await env.client.post(f"/admin/v1/support/tickets/{ref}/take", headers=env.staff(OPERATOR))
    assert again.status_code == 200 and again.json()["assignee_id"] == OPERATOR.id
    await env.flush()
    assert len(env.bus.published) == published + 2

    # другой оператор забирает себе; статус не меняется
    other = await env.client.post(f"/admin/v1/support/tickets/{t['number']}/take", headers=env.staff(OPERATOR_2))
    assert other.json()["assignee_id"] == OPERATOR_2.id and other.json()["status"] == "IN_PROGRESS"
    await env.flush()
    assert [e.payload["action"] for e in env.bus.of_type("admin.audit.recorded.v1")][-1] == "ticket.take"
    assert len(env.bus.of_type("support.ticket.status.changed.v1")) == 1


async def test_take_keeps_waiting_status_and_rejects_closed(env) -> None:
    user = uuid.uuid4()
    t = await env.create(user)
    await env.reply(t["ticket_id"], actor=OPERATOR_2)  # → WAITING_CUSTOMER, назначено на OPERATOR_2
    r = await env.client.post(f"/admin/v1/support/tickets/{t['ticket_id']}/take", headers=env.staff())
    assert r.json()["status"] == "WAITING_CUSTOMER" and r.json()["assignee_id"] == OPERATOR.id
    await env.client.post(f"/internal/v1/me/tickets/{t['ticket_id']}/close", headers=env.user(user))
    closed = await env.client.post(f"/admin/v1/support/tickets/{t['ticket_id']}/take", headers=env.staff())
    assert closed.status_code == 409 and closed.json()["code"] == "SUPPORT_TICKET_CLOSED"


async def test_take_auth_and_not_found(env) -> None:
    t = await env.create(uuid.uuid4())
    path = f"/admin/v1/support/tickets/{t['ticket_id']}/take"
    assert (await env.client.post(path)).status_code == 401
    ro = await env.client.post(path, headers=env.staff(READER))
    assert ro.status_code == 403 and ro.json()["details"]["permission"] == "support.reply"
    no_actor = await env.client.post(path, headers=env.staff(None))
    assert no_actor.status_code == 403 and no_actor.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    foreign = await env.client.post(path, headers=env.staff(OPERATOR, issuer="telegram-bff"))
    assert foreign.status_code == 403
    missing = await env.client.post(f"/admin/v1/support/tickets/{uuid.uuid4()}/take", headers=env.staff())
    assert missing.status_code == 404 and missing.json()["code"] == "SUPPORT_TICKET_NOT_FOUND"
    # тело не принимается (assignee — только actor из токена)
    body = await env.client.post(path, json={"assignee_id": "someone"}, headers=env.staff())
    assert body.status_code == 200 and body.json()["assignee_id"] == OPERATOR.id
    view = (await env.client.get(path.removesuffix("/take"), headers=env.staff())).json()
    assert view["assignee_id"] == OPERATOR.id


# ---------------------------------------------------------------- stats

async def _shift(env, ticket_id: str, minutes: int) -> None:
    """Сдвигает создание (и SLA-сроки) обращения в прошлое, чтобы средние были детерминированы."""
    async with env.runtime.transaction() as s:
        await s.execute(text(
            "UPDATE tickets SET created_at = created_at - make_interval(mins => :m), "
            "sla_first_response_at = sla_first_response_at - make_interval(mins => :m), "
            "sla_resolution_at = sla_resolution_at - make_interval(mins => :m) WHERE ticket_id = :t"
        ), {"m": minutes, "t": ticket_id})


async def test_stats_counts_and_averages(env) -> None:
    empty = await env.client.get("/admin/v1/support/stats?period=today", headers=env.staff(DASHBOARD))
    assert empty.status_code == 200, empty.text
    assert empty.json() == {"open": 0, "in_progress": 0, "waiting_customer": 0, "breached": 0,
                            "avg_first_response_minutes": None, "avg_resolution_minutes": None}
    users = [uuid.uuid4() for _ in range(4)]
    new = await env.create(users[0])
    in_progress = await env.create(users[1])
    waiting = await env.create(users[2])
    resolved = await env.create(users[3])
    await _shift(env, new["ticket_id"], 600)  # NEW, первый ответ просрочен (2 ч по умолчанию)
    await _shift(env, waiting["ticket_id"], 30)
    await _shift(env, resolved["ticket_id"], 90)
    await env.client.post(f"/admin/v1/support/tickets/{in_progress['ticket_id']}/take", headers=env.staff())
    await env.reply(waiting["ticket_id"])  # первый ответ через ~30 мин
    await env.reply(resolved["ticket_id"])  # первый ответ через ~90 мин
    await env.client.patch(f"/admin/v1/support/tickets/{resolved['ticket_id']}", json={"status": "RESOLVED"},
                           headers=env.staff())

    for actor in (DASHBOARD, READER):
        r = await env.client.get("/admin/v1/support/stats?period=7d", headers=env.staff(actor))
        assert r.status_code == 200, r.text
        s = r.json()
        assert (s["open"], s["in_progress"], s["waiting_customer"], s["breached"]) == (3, 1, 1, 1)
        assert 59 <= s["avg_first_response_minutes"] <= 61  # (30 + 90) / 2
        assert 89 <= s["avg_resolution_minutes"] <= 91
    default = (await env.client.get("/admin/v1/support/stats", headers=env.staff(DASHBOARD))).json()
    assert default["open"] == 3  # period=today по умолчанию


async def test_stats_period_bounds(env) -> None:
    t = await env.create(uuid.uuid4())
    await env.reply(t["ticket_id"])
    async with env.runtime.transaction() as s:  # ответ был 10 дней назад
        await s.execute(text("UPDATE tickets SET created_at = now() - interval '10 days 1 hour', "
                             "first_response_at = now() - interval '10 days' WHERE ticket_id = :t"),
                        {"t": t["ticket_id"]})
    week = (await env.client.get("/admin/v1/support/stats?period=7d", headers=env.staff())).json()
    month = (await env.client.get("/admin/v1/support/stats?period=30d", headers=env.staff())).json()
    assert week["avg_first_response_minutes"] is None
    assert month["avg_first_response_minutes"] == 60.0


async def test_stats_auth_and_validation(env) -> None:
    path = "/admin/v1/support/stats?period=7d"
    assert (await env.client.get(path)).status_code == 401
    denied = await env.client.get(path, headers=env.staff(OUTSIDER))
    assert denied.status_code == 403 and denied.json()["code"] == "PERMISSION_DENIED"
    no_actor = await env.client.get(path, headers=env.staff(None))
    assert no_actor.status_code == 403 and no_actor.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    foreign = await env.client.get(path, headers=internal_headers(env.settings, issuer="user-admin"))
    assert foreign.status_code == 403 and foreign.json()["code"] == "CALLER_NOT_ALLOWED"
    for period in ("1y", "week", ""):
        r = await env.client.get(f"/admin/v1/support/stats?period={period}", headers=env.staff())
        assert r.status_code == 422, period


async def test_user_id_filter_validation_and_isolation(env) -> None:
    mine, other = uuid.uuid4(), uuid.uuid4()
    await env.create(mine)
    await env.create(other)
    r = await env.client.get(f"/admin/v1/support/tickets?user_id={mine}", headers=env.staff())
    assert {i["user_id"] for i in r.json()["items"]} == {str(mine)}
    none = await env.client.get(f"/admin/v1/support/tickets?user_id={uuid.uuid4()}", headers=env.staff())
    assert none.json() == {"items": [], "next_cursor": None}
    bad = await env.client.get("/admin/v1/support/tickets?user_id=42", headers=env.staff())
    assert bad.status_code == 422
    assert json.dumps(r.json()).count(str(other)) == 0
