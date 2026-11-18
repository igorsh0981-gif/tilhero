"""Удаление ученика (AT-14, TG-FR-006): обезличивание обращений и ACK user.domain.deleted.v1."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

from sqlalchemy import text
from support_testkit import CONTEXT, READER

from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms


def deletion_event(user_id: uuid.UUID):
    return make_envelope(
        "user.deletion.requested.v1",
        {
            "user_id": str(user_id),
            "request_id": str(uuid.uuid4()),
            "requested_at": datetime.now(UTC).isoformat(),
        },
        producer="identity-consent",
    )


async def test_deletion_anonymizes_tickets(env) -> None:
    user, other = uuid.uuid4(), uuid.uuid4()
    open_t = await env.create(
        user,
        category="SCHEDULE_REMINDERS",
        subject="Мой телефон +998901234567",
        message="Позвоните мне, я Игорь",
        context=CONTEXT,
    )
    closed_t = await env.create(user, message="Второе обращение")
    await env.client.post(f"/internal/v1/me/tickets/{closed_t['ticket_id']}/close", headers=env.user(user))
    await env.reply(open_t["ticket_id"], "Здравствуйте! Проверяем")
    await env.reply(open_t["ticket_id"], "Заметка для коллег", visibility="internal")
    keep = await env.create(other)
    await env.flush()

    event = deletion_event(user)
    assert_event_conforms(event)
    await env.bus.publish(event)

    gone = await env.client.get("/internal/v1/me/tickets", headers=env.user(user))
    assert gone.status_code == 410 and gone.json()["code"] == "USER_DELETED"
    staff = (
        await env.client.get(f"/admin/v1/support/tickets/{open_t['ticket_id']}", headers=env.staff(READER))
    ).json()
    assert staff["user_id"] is None and staff["anonymized"] is True
    assert staff["subject"] == "[удалено по запросу пользователя]"
    assert staff["context"] is None and staff["correlation_id"] is None
    assert staff["status"] == "CLOSED" and staff["status_history"][-1]["changed_by"] == "system"
    texts = [(m["sender_type"], m["visibility"], m["text"]) for m in staff["messages"]]
    assert texts == [
        ("user", "public", "[удалено по запросу пользователя]"),
        ("operator", "public", "Здравствуйте! Проверяем"),
        ("operator", "internal", "Заметка для коллег"),
    ]
    assert "+998901234567" not in str(staff) and "Игорь" not in str(staff)
    closed = (
        await env.client.get(f"/admin/v1/support/tickets/{closed_t['ticket_id']}", headers=env.staff(READER))
    ).json()
    assert closed["user_id"] is None and closed["status_history"][-1]["changed_by"] == "user"
    # Ответить обезличенному клиенту нельзя — доставлять некому
    r = await env.client.post(
        f"/admin/v1/support/tickets/{open_t['ticket_id']}/messages",
        json={"text": "x", "visibility": "public"},
        headers=env.staff(),
    )
    assert r.status_code == 409 and r.json()["code"] == "SUPPORT_TICKET_CLOSED"
    # Чужие данные не тронуты
    kept = (
        await env.client.get(f"/internal/v1/me/tickets/{keep['ticket_id']}", headers=env.user(other))
    ).json()
    assert kept["subject"] == "Не приходят уведомления"

    await env.flush()
    acks = env.bus.of_type("user.domain.deleted.v1")
    assert len(acks) == 1
    assert acks[0].payload == {
        "user_id": str(user),
        "request_id": event.payload["request_id"],
        "domain": "support",
        "mode": "anonymized",
    }
    status = [
        e for e in env.bus.of_type("support.ticket.status.changed.v1") if e.payload["changed_by"] == "system"
    ]
    assert len(status) == 1 and status[0].payload["user_id"] is None
    for e in env.bus.published:
        assert_event_conforms(e)


async def test_deletion_is_deduplicated_and_acks_without_tickets(env) -> None:
    user = uuid.uuid4()
    event = deletion_event(user)
    spec = next(s for s in env.bus.specs if s.durable == "support.user_deleted")
    await spec.handler(event)
    await spec.handler(event)  # повторная доставка той же записи → inbox отбрасывает
    acks = await env.events("user.domain.deleted.v1")
    assert len(acks) == 1 and acks[0].payload["mode"] == "anonymized"


async def test_deletion_only_from_identity_consent(env) -> None:
    """Сагу удаления ведёт identity-consent: запрос от другого издателя игнорируется, данные и ACK не трогаются."""
    user = uuid.uuid4()
    t = await env.create(user)
    for producer in ("telegram-bff", "social", "notifications"):
        rogue = make_envelope("user.deletion.requested.v1",
                              {**deletion_event(user).payload, "request_id": str(uuid.uuid4())}, producer=producer)
        await env.bus.publish(rogue)
    own = await env.client.get(f"/internal/v1/me/tickets/{t['ticket_id']}", headers=env.user(user))
    assert own.status_code == 200 and own.json()["subject"] == "Не приходят уведомления"
    assert await env.events("user.domain.deleted.v1") == []


async def test_anonymized_ticket_cannot_be_reopened(env) -> None:
    user = uuid.uuid4()
    t = await env.create(user)
    await env.bus.publish(deletion_event(user))
    # Сотрудник переоткрыть закрытое системой обращение не может; заметки тоже запрещены в CLOSED
    r = await env.client.patch(
        f"/admin/v1/support/tickets/{t['ticket_id']}", json={"status": "IN_PROGRESS"}, headers=env.staff()
    )
    assert r.status_code == 409


async def test_after_deletion_client_commands_get_410(env) -> None:
    """Ревью P3: после ACK удаления данные пользователя больше не принимаются (deleted_users)."""
    user = uuid.uuid4()
    t = await env.create(user)
    await env.bus.publish(deletion_event(user))
    r = await env.client.post(
        "/internal/v1/me/tickets",
        json={"category": "OTHER", "subject": "Снова я", "message": "Мой телефон +998901234567"},
        headers=env.user(user, idem=uuid.uuid4().hex),
    )
    assert r.status_code == 410 and r.json()["code"] == "USER_DELETED"
    for method, path, body in (
        ("post", f"/internal/v1/me/tickets/{t['ticket_id']}/messages", {"text": "ещё"}),
        ("post", f"/internal/v1/me/tickets/{t['ticket_id']}/close", None),
        ("get", f"/internal/v1/me/tickets/{t['ticket_id']}", None),
        ("get", "/internal/v1/me/tickets", None),
    ):
        kw = {"json": body} if body is not None else {}
        resp = await getattr(env.client, method)(path, headers=env.user(user), **kw)
        assert resp.status_code == 410 and resp.json()["code"] == "USER_DELETED", (path, resp.text)
    # Повторный запрос удаления (новое событие той же саги) снова подтверждается, отметка одна
    again = deletion_event(user)
    await env.bus.publish(again)
    acks = await env.events("user.domain.deleted.v1")
    assert len(acks) == 2 and {a.payload["request_id"] for a in acks} >= {again.payload["request_id"]}
    async with env.runtime.transaction() as s:
        rows = (await s.execute(text("SELECT count(*) FROM deleted_users WHERE user_id = :u"), {"u": user})).scalar()
    assert rows == 1
    # Другие пользователи не затронуты
    assert (await env.create(uuid.uuid4()))["status"] == "NEW"


async def test_race_deletion_vs_new_ticket_leaves_no_personal_data(env) -> None:
    """Гонка «запрос удаления ↔ новое обращение»: при любом порядке обращения с user_id не остаётся."""
    outcomes = set()
    for _ in range(8):
        user = uuid.uuid4()
        await env.create(user)  # существующее обращение
        create = env.client.post(
            "/internal/v1/me/tickets",
            json={"category": "OTHER", "subject": "Параллельное", "message": "Телефон +998901112233"},
            headers=env.user(user, idem=uuid.uuid4().hex),
        )
        r, _ = await asyncio.gather(create, env.bus.publish(deletion_event(user)))
        assert r.status_code in (201, 410), r.text
        outcomes.add(r.status_code)
        async with env.runtime.transaction() as s:
            left = (
                await s.execute(text("SELECT count(*) FROM tickets WHERE user_id = :u"), {"u": user})
            ).scalar()
            leaked = (
                await s.execute(text("SELECT count(*) FROM messages WHERE text LIKE '%998901112233%'"))
            ).scalar()
        assert left == 0 and leaked == 0
    assert outcomes <= {201, 410}
