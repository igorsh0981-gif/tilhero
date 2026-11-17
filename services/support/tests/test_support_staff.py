"""Staff API support (через admin-bff): очередь, SLA, ответы, заметки, статусы, эскалации, политика SLA.

AT-32 (ответ оператора виден клиенту), A-AT-41, A-AT-42 (заметка не видна клиенту), A-AT-44 (аудит).
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from support_testkit import MANAGER, OPERATOR, OPERATOR_2, OUTSIDER, READER

from tilhero_common.testing import assert_event_conforms, internal_headers


def ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


async def test_full_ticket_cycle_client_and_operator(env) -> None:
    user = uuid.uuid4()
    t = await env.create(
        user,
        category="TICKET_SOURCE",
        subject="Не открывается ссылка на билет",
        message="При переходе получаю ошибку",
    )
    ref = t["ticket_id"]
    queue = (await env.client.get("/admin/v1/support/tickets?status=open", headers=env.staff(READER))).json()
    item = queue["items"][0]
    assert item["number"] == t["number"] and item["user_id"] == str(user) and item["status"] == "NEW"
    assert (
        item["sla_state"] == "ok" and item["sla_target"] == "first_response" and item["assignee_id"] is None
    )

    taken = await env.client.patch(
        f"/admin/v1/support/tickets/{ref}",
        json={"status": "IN_PROGRESS", "assignee_id": OPERATOR.id},
        headers=env.staff(),
    )
    assert taken.status_code == 200 and taken.json()["status"] == "IN_PROGRESS"
    assert taken.json()["assignee_id"] == OPERATOR.id

    note = await env.reply(ref, "Проверить у провайдера, ссылка с редиректом", visibility="internal")
    assert note.status_code == 200
    reply = await env.reply(ref, "Ссылка исправлена: провайдер обновил адрес. Проверьте, пожалуйста")
    assert reply.status_code == 200
    staff_view = reply.json()
    assert staff_view["status"] == "WAITING_CUSTOMER" and staff_view["first_response_at"]
    assert staff_view["sla_paused"] is True and staff_view["sla_state"] == "ok"
    assert [m["visibility"] for m in staff_view["messages"]] == ["public", "internal", "public"]
    assert staff_view["messages"][2]["author_id"] == OPERATOR.id

    summary = (await env.client.get("/internal/v1/me/tickets", headers=env.user(user))).json()["items"][0]
    assert summary["unread_operator_replies"] == 1 and summary["status"] == "WAITING_CUSTOMER"
    view = (await env.client.get(f"/internal/v1/me/tickets/{t['number']}", headers=env.user(user))).json()
    assert [m["sender_type"] for m in view["messages"]] == ["user", "operator"]
    op = view["messages"][1]
    assert op["author_name"] == "Алина" and op["text"].startswith("Ссылка исправлена")  # имя без фамилии
    assert set(op) == {"message_id", "sender_type", "author_name", "text", "created_at"}  # без author_id
    assert view["unread_operator_replies"] == 0
    assert (await env.client.get("/internal/v1/me/tickets", headers=env.user(user))).json()["items"][0][
        "unread_operator_replies"
    ] == 0

    back = await env.client.post(
        f"/internal/v1/me/tickets/{ref}/messages", json={"text": "Да, открывается"}, headers=env.user(user)
    )
    assert back.json()["status"] == "IN_PROGRESS"
    resolved = await env.client.patch(
        f"/admin/v1/support/tickets/{ref}", json={"status": "RESOLVED"}, headers=env.staff()
    )
    assert resolved.json()["status"] == "RESOLVED" and resolved.json()["resolved_at"]
    closed = await env.client.post(f"/internal/v1/me/tickets/{ref}/close", headers=env.user(user))
    assert [h["status"] for h in closed.json()["status_history"]] == [
        "NEW",
        "IN_PROGRESS",
        "WAITING_CUSTOMER",
        "IN_PROGRESS",
        "RESOLVED",
        "CLOSED",
    ]

    await env.flush()
    published = env.bus.published
    replied = env.bus.of_type("support.ticket.replied.v1")
    assert len(replied) == 1  # заметка события не порождает
    assert replied[0].payload["message_id"] == staff_view["messages"][2]["message_id"]
    assert replied[0].payload["sender_type"] == "operator" and replied[0].payload["user_id"] == str(user)
    transitions = [
        (e.payload["from_status"], e.payload["to_status"], e.payload["changed_by"])
        for e in env.bus.of_type("support.ticket.status.changed.v1")
    ]
    assert transitions == [
        ("NEW", "IN_PROGRESS", "operator"),
        ("IN_PROGRESS", "WAITING_CUSTOMER", "operator"),
        ("WAITING_CUSTOMER", "IN_PROGRESS", "user"),
        ("IN_PROGRESS", "RESOLVED", "operator"),
        ("RESOLVED", "CLOSED", "user"),
    ]
    actions = [e.payload["action"] for e in env.bus.of_type("admin.audit.recorded.v1")]
    # status + assign — одна транзакция (одинаковый created_at в outbox): порядок между ними не гарантирован
    assert sorted(actions[:2]) == ["ticket.assign", "ticket.status"]
    assert actions[2:] == ["ticket.note", "ticket.reply", "ticket.status"]
    for e in published:
        assert_event_conforms(e)
        assert "Ссылка исправлена" not in json.dumps(
            e.payload, ensure_ascii=False
        )  # текст не уходит в события


async def test_internal_note_never_visible_to_client(env) -> None:
    """A-AT-42 / TG-FR-044: заметка не видна клиенту, не меняет его метаданные и не порождает события."""
    user = uuid.uuid4()
    t = await env.create(user)
    before = (
        await env.client.get(f"/internal/v1/me/tickets/{t['ticket_id']}", headers=env.user(user))
    ).json()
    await env.flush()
    published_before = len(env.bus.published)
    marker = "СЕКРЕТНАЯ-ЗАМЕТКА-" + uuid.uuid4().hex
    note = await env.reply(t["ticket_id"], marker, visibility="internal")
    assert note.status_code == 200 and note.json()["status"] == "NEW"
    after = await env.client.get(f"/internal/v1/me/tickets/{t['ticket_id']}", headers=env.user(user))
    listing = await env.client.get("/internal/v1/me/tickets", headers=env.user(user))
    assert marker not in after.text and marker not in listing.text
    a = after.json()
    assert a["messages"] == before["messages"] and a["unread_operator_replies"] == 0
    assert a["updated_at"] == before["updated_at"] and a["last_message_at"] == before["last_message_at"]
    await env.flush()
    new_events = env.bus.published[published_before:]
    assert [e.event_type for e in new_events] == ["admin.audit.recorded.v1"]
    assert new_events[0].payload["action"] == "ticket.note"
    assert marker not in json.dumps([e.payload for e in env.bus.published], ensure_ascii=False)
    staff = (
        await env.client.get(f"/admin/v1/support/tickets/{t['ticket_id']}", headers=env.staff(READER))
    ).json()
    assert staff["messages"][-1]["text"] == marker and staff["messages"][-1]["visibility"] == "internal"


async def test_status_machine(env) -> None:
    user = uuid.uuid4()
    t = await env.create(user)
    ref = t["ticket_id"]
    bad = await env.client.patch(
        f"/admin/v1/support/tickets/{ref}", json={"status": "RESOLVED"}, headers=env.staff()
    )
    assert bad.status_code == 409 and bad.json()["code"] == "SUPPORT_INVALID_TRANSITION"
    assert bad.json()["details"] == {"from": "NEW", "to": "RESOLVED", "allowed": ["IN_PROGRESS"]}
    same = await env.client.patch(
        f"/admin/v1/support/tickets/{ref}", json={"status": "NEW"}, headers=env.staff()
    )
    assert same.status_code == 200  # тот же статус — без изменений
    await env.client.patch(
        f"/admin/v1/support/tickets/{ref}", json={"status": "IN_PROGRESS"}, headers=env.staff()
    )
    await env.client.patch(
        f"/admin/v1/support/tickets/{ref}", json={"status": "RESOLVED"}, headers=env.staff()
    )
    # Ответ клиента в RESOLVED переоткрывает обращение
    reopened = await env.client.post(
        f"/internal/v1/me/tickets/{ref}/messages", json={"text": "Снова не работает"}, headers=env.user(user)
    )
    assert reopened.json()["status"] == "IN_PROGRESS"
    await env.client.patch(
        f"/admin/v1/support/tickets/{ref}", json={"status": "RESOLVED"}, headers=env.staff()
    )
    closed = await env.client.patch(
        f"/admin/v1/support/tickets/{ref}", json={"status": "CLOSED"}, headers=env.staff()
    )
    assert closed.json()["status"] == "CLOSED" and closed.json()["closed_at"]
    for status in ("IN_PROGRESS", "RESOLVED", "NEW"):
        r = await env.client.patch(
            f"/admin/v1/support/tickets/{ref}", json={"status": status}, headers=env.staff()
        )
        assert r.status_code == 409 and r.json()["code"] == "SUPPORT_INVALID_TRANSITION"
    for visibility in ("public", "internal"):
        r = await env.reply(ref, visibility=visibility)
        assert r.status_code == 409 and r.json()["code"] == "SUPPORT_TICKET_CLOSED"


async def test_staff_auth_and_permissions(env) -> None:
    t = await env.create(uuid.uuid4())
    ref = t["ticket_id"]
    calls = [
        ("GET", "/admin/v1/support/tickets", None, "support.read"),
        ("GET", f"/admin/v1/support/tickets/{ref}", None, "support.read"),
        (
            "POST",
            f"/admin/v1/support/tickets/{ref}/messages",
            {"text": "x", "visibility": "public"},
            "support.reply",
        ),
        ("PATCH", f"/admin/v1/support/tickets/{ref}", {"priority": "high"}, "support.reply"),
        (
            "POST",
            f"/admin/v1/support/tickets/{ref}/escalations",
            {"type": "billing_review", "note": "Проверить"},
            "support.reply",
        ),
        ("GET", "/admin/v1/support/sla-policies", None, "support.manage"),
        (
            "PUT",
            "/admin/v1/support/sla-policies",
            {
                "items": [
                    {"category": "*", "priority": "low", "first_response_minutes": 1, "resolution_minutes": 2}
                ],
                "reason": "Тест прав",
            },
            "support.manage",
        ),
    ]
    for method, path, body, perm in calls:
        assert (await env.client.request(method, path, json=body)).status_code == 401
        denied = await env.client.request(method, path, json=body, headers=env.staff(OUTSIDER))
        assert denied.status_code == 403 and denied.json()["details"]["permission"] == perm, path
        no_actor = await env.client.request(method, path, json=body, headers=env.staff(None))
        assert no_actor.status_code == 403 and no_actor.json()["code"] == "STAFF_CONTEXT_REQUIRED"
        foreign = await env.client.request(
            method, path, json=body, headers=env.staff(MANAGER, issuer="telegram-bff")
        )
        assert foreign.status_code == 403 and foreign.json()["code"] == "CALLER_NOT_ALLOWED"
        aud = internal_headers(env.settings, issuer="admin-bff", actor=MANAGER, audience="notifications")
        assert (await env.client.request(method, path, json=body, headers=aud)).status_code == 401
    # Только чтение: ответить нельзя
    ro = await env.reply(ref, actor=READER)
    assert ro.status_code == 403 and ro.json()["details"]["permission"] == "support.reply"
    assert (
        await env.client.get("/admin/v1/support/sla-policies", headers=env.staff(OPERATOR))
    ).status_code == 403
    await env.flush()
    assert env.bus.of_type("support.ticket.replied.v1") == []


async def test_staff_not_found_and_validation(env) -> None:
    t = await env.create(uuid.uuid4())
    ref = t["ticket_id"]
    for path in (f"/admin/v1/support/tickets/{uuid.uuid4()}", "/admin/v1/support/tickets/TCK-1"):
        r = await env.client.get(path, headers=env.staff())
        assert r.status_code == 404 and r.json()["code"] == "SUPPORT_TICKET_NOT_FOUND"
    assert (await env.reply(str(uuid.uuid4()))).status_code == 404
    invalid = [
        ("POST", f"/admin/v1/support/tickets/{ref}/messages", {"text": "x", "visibility": "secret"}),
        ("POST", f"/admin/v1/support/tickets/{ref}/messages", {"text": "", "visibility": "public"}),
        (
            "POST",
            f"/admin/v1/support/tickets/{ref}/messages",
            {"text": "x", "visibility": "public", "sender": "u"},
        ),
        ("PATCH", f"/admin/v1/support/tickets/{ref}", {}),
        ("PATCH", f"/admin/v1/support/tickets/{ref}", {"status": None}),
        ("PATCH", f"/admin/v1/support/tickets/{ref}", {"status": "DONE"}),
        ("PATCH", f"/admin/v1/support/tickets/{ref}", {"assignee_id": "bad id with spaces"}),
        (
            "POST",
            f"/admin/v1/support/tickets/{ref}/escalations",
            {"type": "refund", "note": "Вернуть деньги"},
        ),
        ("POST", f"/admin/v1/support/tickets/{ref}/escalations", {"type": "billing_review", "note": ""}),
    ]
    for method, path, body in invalid:
        r = await env.client.request(method, path, json=body, headers=env.staff(MANAGER))
        assert r.status_code == 422, (path, body, r.text)
    for query in (
        "status=DONE",
        "category=WATCH",
        "priority=max",
        "sla=late",
        "sort=random",
        "assignee=a%20b",
    ):
        r = await env.client.get(f"/admin/v1/support/tickets?{query}", headers=env.staff())
        assert r.status_code == 422, query
    r = await env.client.get("/admin/v1/support/tickets?cursor=bm9wZQ", headers=env.staff())
    assert r.status_code == 400 and r.json()["code"] == "INVALID_CURSOR"


async def test_queue_filters_and_pagination(env) -> None:
    users = [uuid.uuid4() for _ in range(3)]
    a = await env.create(users[0], category="PRICE")
    b = await env.create(users[1], category="ACCOUNT")
    c = await env.create(users[2], category="BUG")
    await env.client.patch(
        f"/admin/v1/support/tickets/{b['ticket_id']}",
        json={"status": "IN_PROGRESS", "assignee_id": OPERATOR_2.id},
        headers=env.staff(),
    )
    await env.client.post(f"/internal/v1/me/tickets/{c['ticket_id']}/close", headers=env.user(users[2]))

    async def numbers(query: str, actor=OPERATOR) -> list[str]:
        r = await env.client.get(f"/admin/v1/support/tickets?{query}", headers=env.staff(actor))
        assert r.status_code == 200, r.text
        return [i["number"] for i in r.json()["items"]]

    assert await numbers("") == [c["number"], b["number"], a["number"]]
    assert await numbers("status=open") == [b["number"], a["number"]]
    assert await numbers("status=CLOSED") == [c["number"]]
    assert await numbers("status=NEW,CLOSED") == [c["number"], a["number"]]
    assert await numbers("category=ACCOUNT") == [b["number"]]
    assert await numbers("priority=high") == [b["number"]]
    assert await numbers(f"assignee={OPERATOR_2.id}") == [b["number"]]
    assert await numbers("assignee=_me", actor=OPERATOR_2) == [b["number"]]
    assert await numbers("assignee=_none") == [c["number"], a["number"]]
    assert await numbers(f"user_id={users[1]}") == [b["number"]]
    page1 = (await env.client.get("/admin/v1/support/tickets?limit=2", headers=env.staff())).json()
    page2 = (
        await env.client.get(
            f"/admin/v1/support/tickets?limit=2&cursor={page1['next_cursor']}", headers=env.staff()
        )
    ).json()
    assert [i["number"] for i in page1["items"] + page2["items"]] == [c["number"], b["number"], a["number"]]
    assert page2["next_cursor"] is None


async def test_sla_states_filter_and_queue_order(env) -> None:
    now = datetime.now(UTC)
    tickets = [await env.create(uuid.uuid4()) for _ in range(4)]
    due = {  # первый ответ: просрочен / через 10 мин / через 2 ч / просрочен, но ждём клиента
        tickets[0]["ticket_id"]: now - timedelta(minutes=5),
        tickets[1]["ticket_id"]: now + timedelta(minutes=10),
        tickets[2]["ticket_id"]: now + timedelta(hours=2),
        tickets[3]["ticket_id"]: now - timedelta(hours=1),
    }
    async with env.runtime.transaction() as s:
        for tid, value in due.items():
            await s.execute(
                text("UPDATE tickets SET sla_first_response_at = :d WHERE ticket_id = :t"),
                {"d": value, "t": uuid.UUID(tid)},
            )
    await env.client.patch(
        f"/admin/v1/support/tickets/{tickets[3]['ticket_id']}",
        json={"status": "IN_PROGRESS"},
        headers=env.staff(),
    )
    await env.reply(tickets[3]["ticket_id"])  # → WAITING_CUSTOMER: таймер на паузе

    items = {
        i["ticket_id"]: i
        for i in (await env.client.get("/admin/v1/support/tickets", headers=env.staff())).json()["items"]
    }
    assert items[tickets[0]["ticket_id"]]["sla_state"] == "breached"
    assert items[tickets[1]["ticket_id"]]["sla_state"] == "soon"
    assert items[tickets[2]["ticket_id"]]["sla_state"] == "ok"
    paused = items[tickets[3]["ticket_id"]]
    assert paused["sla_state"] == "ok" and paused["sla_paused"] is True and paused["sla_due_at"] is None

    async def ids(query: str) -> list[str]:
        return [
            i["ticket_id"]
            for i in (await env.client.get(f"/admin/v1/support/tickets?{query}", headers=env.staff())).json()[
                "items"
            ]
        ]

    assert await ids("sla=breached") == [tickets[0]["ticket_id"]]
    assert await ids("sla=soon") == [tickets[1]["ticket_id"]]
    assert set(await ids("sla=ok")) == {tickets[2]["ticket_id"], tickets[3]["ticket_id"]}
    order = [
        tickets[0]["ticket_id"],
        tickets[1]["ticket_id"],
        tickets[2]["ticket_id"],
        tickets[3]["ticket_id"],
    ]
    assert await ids("sort=sla") == order
    collected, cursor = [], None
    while True:
        q = "sort=sla&limit=1" + (f"&cursor={cursor}" if cursor else "")
        page = (await env.client.get(f"/admin/v1/support/tickets?{q}", headers=env.staff())).json()
        collected += [i["ticket_id"] for i in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert collected == order


async def test_priority_change_recomputes_sla_and_audits(env) -> None:
    t = await env.create(uuid.uuid4(), category="BUG")
    r = await env.client.patch(
        f"/admin/v1/support/tickets/{t['ticket_id']}", json={"priority": "urgent"}, headers=env.staff()
    )
    body = r.json()
    assert body["priority"] == "urgent"
    assert ts(body["sla_first_response_at"]) - ts(body["created_at"]) == timedelta(minutes=30)
    assert ts(body["sla_resolution_at"]) - ts(body["created_at"]) == timedelta(minutes=240)
    unassign = await env.client.patch(
        f"/admin/v1/support/tickets/{t['ticket_id']}", json={"assignee_id": OPERATOR.id}, headers=env.staff()
    )
    assert unassign.json()["assignee_id"] == OPERATOR.id
    unassign = await env.client.patch(
        f"/admin/v1/support/tickets/{t['ticket_id']}", json={"assignee_id": None}, headers=env.staff()
    )
    assert unassign.json()["assignee_id"] is None
    audits = await env.events("admin.audit.recorded.v1")
    assert [a.payload["action"] for a in audits] == ["ticket.priority", "ticket.assign", "ticket.assign"]
    first = audits[0].payload
    assert (
        first["actor_type"] == "staff"
        and first["actor_id"] == OPERATOR.id
        and first["actor_role"] == "support"
    )
    assert first["object_type"] == "support_ticket" and first["object_id"] == t["ticket_id"]
    assert first["before"]["priority"] == "normal" and first["after"]["priority"] == "urgent"
    for a in audits:
        assert_event_conforms(a)


async def test_escalation_only_creates_related_request(env) -> None:
    """BR-TG-011: support не меняет оплату/подписку — только эскалация в другую команду."""
    user = uuid.uuid4()
    t = await env.create(user, category="ACCOUNT")
    key = "esc-" + uuid.uuid4().hex
    body = {"type": "billing_review", "note": "Клиент просит проверить списание"}
    r1 = await env.client.post(
        f"/admin/v1/support/tickets/{t['ticket_id']}/escalations", json=body, headers=env.staff(idem=key)
    )
    r2 = await env.client.post(
        f"/admin/v1/support/tickets/{t['ticket_id']}/escalations", json=body, headers=env.staff(idem=key)
    )
    assert r1.status_code == r2.status_code == 201
    assert (
        r1.json()["escalation_id"] == r2.json()["escalation_id"]
        and r2.headers["Idempotent-Replayed"] == "true"
    )
    assert r1.json()["status"] == "OPEN" and r1.json()["created_by"] == OPERATOR.id
    reused = await env.client.post(
        f"/admin/v1/support/tickets/{t['ticket_id']}/escalations",
        json={**body, "type": "provider_issue"},
        headers=env.staff(idem=key),
    )
    assert reused.status_code == 422
    staff = (await env.client.get(f"/admin/v1/support/tickets/{t['ticket_id']}", headers=env.staff())).json()
    assert [e["type"] for e in staff["escalations"]] == ["billing_review"] and staff["status"] == "NEW"
    client = await env.client.get(f"/internal/v1/me/tickets/{t['ticket_id']}", headers=env.user(user))
    assert "списание" not in client.text
    await env.flush()
    assert [e.event_type for e in env.bus.published] == [
        "support.ticket.created.v1",
        "admin.audit.recorded.v1",
    ]
    audit = env.bus.published[1].payload
    assert audit["action"] == "ticket.escalate" and audit["after"]["type"] == "billing_review"
    assert "списание" not in json.dumps(audit, ensure_ascii=False)


async def test_sla_policies(env) -> None:
    current = (await env.client.get("/admin/v1/support/sla-policies", headers=env.staff(MANAGER))).json()
    seeded = {
        (i["category"], i["priority"]): (i["first_response_minutes"], i["resolution_minutes"])
        for i in current["items"]
    }
    assert seeded == {
        ("*", "low"): (480, 4320),
        ("*", "normal"): (120, 1440),
        ("*", "high"): (60, 480),
        ("*", "urgent"): (30, 240),
    }
    assert (
        current["category_defaults"]["ACCOUNT"] == "high"
        and current["category_defaults"]["PRICE"] == "normal"
    )
    put = await env.client.put(
        "/admin/v1/support/sla-policies",
        headers=env.staff(MANAGER),
        json={
            "items": [
                {
                    "category": "PRICE",
                    "priority": "normal",
                    "first_response_minutes": 30,
                    "resolution_minutes": 600,
                },
                {
                    "category": "*",
                    "priority": "low",
                    "first_response_minutes": 240,
                    "resolution_minutes": 2880,
                },
            ],
            "reason": "Цены — чувствительная тема",
        },
    )
    assert put.status_code == 200, put.text
    assert len(put.json()["items"]) == 5
    price = await env.create(uuid.uuid4(), category="PRICE")
    assert ts(price["sla_first_response_at"]) - ts(price["created_at"]) == timedelta(minutes=30)
    other = await env.create(uuid.uuid4(), category="HOTEL")
    assert ts(other["sla_first_response_at"]) - ts(other["created_at"]) == timedelta(minutes=120)
    for bad in (
        {
            "items": [
                {
                    "category": "PRICE",
                    "priority": "normal",
                    "first_response_minutes": 60,
                    "resolution_minutes": 60,
                }
            ],
            "reason": "Неверно",
        },
        {
            "items": [
                {
                    "category": "WATCH",
                    "priority": "normal",
                    "first_response_minutes": 1,
                    "resolution_minutes": 2,
                }
            ],
            "reason": "Неверно",
        },
        {
            "items": [
                {
                    "category": "PRICE",
                    "priority": "normal",
                    "first_response_minutes": 1,
                    "resolution_minutes": 2,
                }
            ],
            "reason": "",
        },
        {"items": [], "reason": "Пусто совсем"},
    ):
        assert (
            await env.client.put("/admin/v1/support/sla-policies", json=bad, headers=env.staff(MANAGER))
        ).status_code == 422
    audit = [a for a in await env.events("admin.audit.recorded.v1") if a.payload["action"] == "sla.change"]
    assert len(audit) == 1 and audit[0].payload["reason"] == "Цены — чувствительная тема"
    assert audit[0].payload["before"] == {"*/low": [480, 4320]}
    assert_event_conforms(audit[0])


async def test_operator_message_idempotency(env) -> None:
    user = uuid.uuid4()
    t = await env.create(user)
    h = env.staff(idem="reply-" + uuid.uuid4().hex)
    body = {"text": "Ответ", "visibility": "public"}
    for _ in range(2):
        r = await env.client.post(
            f"/admin/v1/support/tickets/{t['ticket_id']}/messages", json=body, headers=h
        )
        assert r.status_code == 200
    assert len([m for m in r.json()["messages"] if m["sender_type"] == "operator"]) == 1
    assert len(await env.events("support.ticket.replied.v1")) == 1
    no_name = await env.reply(t["ticket_id"], "Без имени", actor=OPERATOR_2)  # в токене нет actor.name
    view = (await env.client.get(f"/internal/v1/me/tickets/{t['ticket_id']}", headers=env.user(user))).json()
    assert view["messages"][-1]["author_name"] is None and no_name.status_code == 200


async def test_operator_name_only_from_token(env) -> None:
    """Ревью P5: имя оператора берётся из actor.name токена admin-bff; author_name в теле → 422."""
    user = uuid.uuid4()
    t = await env.create(user)
    spoof = await env.client.post(
        f"/admin/v1/support/tickets/{t['ticket_id']}/messages",
        json={"text": "Ответ", "visibility": "public", "author_name": "Директор"},
        headers=env.staff(),
    )
    assert spoof.status_code == 422
    ok = await env.reply(t["ticket_id"], "Ответ от Алины")
    assert ok.status_code == 200 and ok.json()["messages"][-1]["author_name"] == "Алина"
    view = (await env.client.get(f"/internal/v1/me/tickets/{t['ticket_id']}", headers=env.user(user))).json()
    assert view["messages"][-1]["author_name"] == "Алина"
