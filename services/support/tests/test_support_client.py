"""Клиентский API support (через telegram-bff): AT-30, AT-31, TG-FR-040…043."""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta

from support_testkit import CONTEXT, READER

from tilhero_common.testing import assert_event_conforms, internal_headers


def ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


async def test_create_from_profile(env) -> None:
    """AT-30: обращение из профиля; номер TCK с 3000, SLA по политике normal (2 ч / 24 ч)."""
    user = uuid.uuid4()
    t = await env.create(user)
    assert t["number"] == "TCK-3000" and t["status"] == "NEW" and t["category"] == "OTHER"
    assert t["context"] is None and t["unread_operator_replies"] == 0
    assert [m["sender_type"] for m in t["messages"]] == ["user"]
    assert t["messages"][0]["author_name"] is None and t["messages"][0]["text"] == "Включил, но тишина"
    assert [h["status"] for h in t["status_history"]] == ["NEW"]
    assert t["created_at"].endswith("Z")
    assert ts(t["sla_first_response_at"]) - ts(t["created_at"]) == timedelta(minutes=120)
    second = await env.create(user)
    assert second["number"] == "TCK-3001"

    created = await env.events("support.ticket.created.v1")
    assert len(created) == 2
    p = created[0].payload
    assert p == {
        "ticket_id": t["ticket_id"],
        "number": "TCK-3000",
        "user_id": str(user),
        "category": "OTHER",
        "priority": "normal",
        "has_event_context": False,
        "sla_first_response_at": p["sla_first_response_at"],
    }
    assert created[0].producer == "support"
    for e in created:
        assert_event_conforms(e)


async def test_create_from_event_with_context(env) -> None:
    """AT-31 / TG-FR-041: event_id/offer_id/provider/deeplink/price snapshot сохраняются и видны клиенту."""
    user = uuid.uuid4()
    t = await env.create(
        user,
        category="TICKET_SOURCE",
        subject="Не открывается ссылка на билет",
        message="При переходе получаю ошибку",
        context=CONTEXT,
    )
    ctx = t["context"]
    assert ctx["event_id"] == "evt_f1_auh_2026" and ctx["offer_id"] == "off_987"
    assert ctx["provider_id"] == "ticket_provider_x" and ctx["deeplink"] == CONTEXT["deeplink"]
    # Деньги — строка-десятичное с 2 знаками (ревью T3): хранится Decimal, отдаётся строкой
    assert ctx["price_snapshot"] == {"amount": "850.00", "currency": "USD", "fetched_at": "2026-10-07T13:42:00Z"}
    whole = await env.create(
        user, context={**CONTEXT, "price_snapshot": {**CONTEXT["price_snapshot"], "amount": "1290.5"}}
    )
    assert whole["context"]["price_snapshot"]["amount"] == "1290.50"
    assert ctx["client_version"] == "telegram-miniapp-2.0"
    partial = await env.create(user, context={"event_id": "evt_1", "client_version": "telegram-miniapp-2.0"})
    assert partial["context"] == {
        "event_id": "evt_1",
        "client_version": "telegram-miniapp-2.0",
    }  # без null-полей
    created = (await env.events("support.ticket.created.v1"))[0]
    assert created.payload["has_event_context"] is True
    # Персональные данные (ACCOUNT/PERSONAL_DATA) — high: первый ответ за 60 минут
    acc = await env.create(user, category="PERSONAL_DATA")
    assert ts(acc["sla_first_response_at"]) - ts(acc["created_at"]) == timedelta(minutes=60)
    # Сотрудник видит контекст и correlation_id запроса BFF
    staff = (await env.client.get(f"/admin/v1/support/tickets/{t['ticket_id']}", headers=env.staff())).json()
    assert staff["context"]["offer_id"] == "off_987" and staff["correlation_id"]
    assert staff["channel"] == "telegram" and staff["priority"] == "normal"


async def test_context_is_strict(env) -> None:
    user = uuid.uuid4()
    bad_contexts = [
        {**CONTEXT, "user_name": "Игорь"},  # лишнее поле (TG-FR-044)
        {**CONTEXT, "deeplink": "http://example.com/t"},
        {**CONTEXT, "deeplink": "https://user:pw@example.com/t"},
        {**CONTEXT, "deeplink": "javascript:alert(1)"},
        {**CONTEXT, "deeplink": "https://example.com/" + "a" * 2048},
        {**CONTEXT, "provider_id": "p" * 65},
        {**CONTEXT, "event_id": "evt<script>"},
        {**CONTEXT, "event_title": "x" * 201},
        *(
            {**CONTEXT, "price_snapshot": {"amount": amount, "currency": "USD", "fetched_at": "2026-10-07T13:42:00Z"}}
            # float/число (T3), отрицательное, > 2 знаков, экспонента, пробелы, ведущие нули, пусто, слишком большое
            for amount in (850.0, 850, 10.5, "-1", "10.555", "1e3", " 10", "010", "", "12345678901.00", "NaN")
        ),
        {
            **CONTEXT,
            "price_snapshot": {"amount": "10.00", "currency": "EUR", "fetched_at": "2026-10-07T13:42:00Z"},
        },
        {**CONTEXT, "price_snapshot": {"amount": "10", "currency": "USD", "fetched_at": "2026-10-07T13:42:00"}},
        {**CONTEXT, "price_snapshot": {"amount": "10", "currency": "USD", "fetched_at": "x", "extra": 1}},
        {k: v for k, v in CONTEXT.items() if k != "client_version"},
    ]
    for ctx in bad_contexts:
        r = await env.client.post(
            "/internal/v1/me/tickets",
            json={"category": "OTHER", "subject": "Тема", "message": "Текст", "context": ctx},
            headers=env.user(user, idem=uuid.uuid4().hex),
        )
        assert r.status_code == 422, ctx
        assert r.json()["code"] == "VALIDATION_ERROR"
    for body in [
        {"category": "OTHER", "subject": "  ab ", "message": "Текст"},
        {"category": "OTHER", "subject": "Тема", "message": ""},
        {"category": "OTHER", "subject": "Тема", "message": "x" * 4001},
        {"category": "OTHER", "subject": "Тема\x00", "message": "Текст"},
        {"category": "OTHER", "subject": "Тема", "message": "Текст", "user_id": str(uuid.uuid4())},
    ]:
        r = await env.client.post(
            "/internal/v1/me/tickets", json=body, headers=env.user(user, idem=uuid.uuid4().hex)
        )
        assert r.status_code == 422, body
    assert await env.events("support.ticket.created.v1") == []


async def test_category_validation_and_catalog(env) -> None:
    user = uuid.uuid4()
    for cat in ("WATCH", "SUBSCRIPTION_PAYMENT"):
        body = await env.create(user, expect=422, category=cat)
        assert body["code"] == "SUPPORT_CATEGORY_INVALID"
    r = await env.client.get("/internal/v1/support/categories", headers=env.user(user))
    items = {i["code"]: i for i in r.json()["items"]}
    assert len(items) == 10 and items["SUBSCRIPTION_PAYMENT"]["available"] is False
    assert items["TICKET_SOURCE"]["label"] == {"ru": "Билет или источник", "en": "Ticket or source"}
    assert items["PERSONAL_DATA"]["default_priority"] == "high"
    admin = await env.client.get("/internal/v1/support/categories", headers=env.staff(READER))
    assert admin.status_code == 200
    assert (await env.client.get("/internal/v1/support/categories")).status_code == 401
    foreign = await env.client.get(
        "/internal/v1/support/categories", headers=internal_headers(env.settings, issuer="notifications")
    )
    assert foreign.status_code == 403


async def test_create_is_idempotent(env) -> None:
    user = uuid.uuid4()
    key = "key-" + uuid.uuid4().hex
    first = await env.create(user, idem=key)
    again = await env.client.post(
        "/internal/v1/me/tickets",
        json={"category": "OTHER", "subject": "Не приходят уведомления", "message": "Включил, но тишина"},
        headers=env.user(user, idem=key),
    )
    assert again.status_code == 201 and again.json()["ticket_id"] == first["ticket_id"]
    assert again.headers["Idempotent-Replayed"] == "true"
    other_body = await env.client.post(
        "/internal/v1/me/tickets",
        json={"category": "BUG", "subject": "Другая тема", "message": "x"},
        headers=env.user(user, idem=key),
    )
    assert other_body.status_code == 422 and other_body.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    # Тот же ключ у другого пользователя — независимое обращение
    foreign = await env.create(uuid.uuid4(), idem=key)
    assert foreign["ticket_id"] != first["ticket_id"]
    # Параллельные дубли создают ровно одно обращение
    key2 = "key-" + uuid.uuid4().hex
    body = {"category": "BUG", "subject": "Дубль", "message": "Параллельно"}
    results = await asyncio.gather(
        *[
            env.client.post("/internal/v1/me/tickets", json=body, headers=env.user(user, idem=key2))
            for _ in range(4)
        ]
    )
    assert {r.status_code for r in results} == {201}
    assert len({r.json()["ticket_id"] for r in results}) == 1
    assert len(await env.events("support.ticket.created.v1")) == 3
    missing = await env.client.post("/internal/v1/me/tickets", json=body, headers=env.user(user))
    assert missing.status_code == 400 and missing.json()["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    bad = await env.client.post("/internal/v1/me/tickets", json=body, headers=env.user(user, idem="short"))
    assert bad.status_code == 422 and bad.json()["code"] == "IDEMPOTENCY_KEY_INVALID"


async def test_auth_on_client_endpoints(env) -> None:
    user = uuid.uuid4()
    t = await env.create(user)
    paths = [
        ("GET", "/internal/v1/me/tickets"),
        ("GET", f"/internal/v1/me/tickets/{t['ticket_id']}"),
        ("POST", f"/internal/v1/me/tickets/{t['ticket_id']}/close"),
    ]
    for method, path in paths:
        assert (await env.client.request(method, path)).status_code == 401
        forged = internal_headers(env.settings, subject=str(user))
        forged["x-internal-token"] = forged["x-internal-token"][:-3] + "abc"
        assert (await env.client.request(method, path, headers=forged)).status_code == 401
        wrong_caller = await env.client.request(method, path, headers=env.user(user, issuer="admin-bff"))
        assert wrong_caller.status_code == 403 and wrong_caller.json()["code"] == "CALLER_NOT_ALLOWED"
        no_user = await env.client.request(method, path, headers=internal_headers(env.settings))
        assert no_user.status_code == 401 and no_user.json()["code"] == "USER_CONTEXT_REQUIRED"
    not_uuid = await env.client.get("/internal/v1/me/tickets", headers=env.user("tg-12345"))
    assert not_uuid.status_code == 401


async def test_user_isolation(env) -> None:
    alice, bob = uuid.uuid4(), uuid.uuid4()
    t = await env.create(alice)
    for ref in (t["ticket_id"], t["number"]):
        own = await env.client.get(f"/internal/v1/me/tickets/{ref}", headers=env.user(alice))
        assert own.status_code == 200 and own.json()["ticket_id"] == t["ticket_id"]
        r = await env.client.get(f"/internal/v1/me/tickets/{ref}", headers=env.user(bob))
        assert r.status_code == 404 and r.json()["code"] == "SUPPORT_TICKET_NOT_FOUND"
        r = await env.client.post(
            f"/internal/v1/me/tickets/{ref}/messages", json={"text": "чужое"}, headers=env.user(bob)
        )
        assert r.status_code == 404
        r = await env.client.post(f"/internal/v1/me/tickets/{ref}/close", headers=env.user(bob))
        assert r.status_code == 404
    assert (await env.client.get("/internal/v1/me/tickets", headers=env.user(bob))).json()["items"] == []
    for ref in (str(uuid.uuid4()), "TCK-999999", "garbage", "TCK-"):
        assert (
            await env.client.get(f"/internal/v1/me/tickets/{ref}", headers=env.user(alice))
        ).status_code == 404
    still = await env.client.get(f"/internal/v1/me/tickets/{t['ticket_id']}", headers=env.user(alice))
    assert still.json()["status"] == "NEW" and len(still.json()["messages"]) == 1


async def test_list_pagination(env) -> None:
    user = uuid.uuid4()
    numbers = [(await env.create(user))["number"] for _ in range(3)]
    p1 = (await env.client.get("/internal/v1/me/tickets?limit=2", headers=env.user(user))).json()
    assert [i["number"] for i in p1["items"]] == numbers[::-1][:2] and p1["next_cursor"]
    assert set(p1["items"][0]) == {
        "ticket_id",
        "number",
        "category",
        "subject",
        "status",
        "created_at",
        "updated_at",
        "last_message_at",
        "unread_operator_replies",
    }
    p2 = (
        await env.client.get(
            f"/internal/v1/me/tickets?limit=2&cursor={p1['next_cursor']}", headers=env.user(user)
        )
    ).json()
    assert [i["number"] for i in p2["items"]] == [numbers[0]] and p2["next_cursor"] is None
    bad = await env.client.get("/internal/v1/me/tickets?cursor=%%%", headers=env.user(user))
    assert bad.status_code == 400 and bad.json()["code"] == "INVALID_CURSOR"
    assert (
        await env.client.get("/internal/v1/me/tickets?limit=101", headers=env.user(user))
    ).status_code == 422


async def test_close_and_closed_ticket(env) -> None:
    user = uuid.uuid4()
    t = await env.create(user)
    closed = await env.client.post(f"/internal/v1/me/tickets/{t['ticket_id']}/close", headers=env.user(user))
    assert closed.status_code == 200 and closed.json()["status"] == "CLOSED"
    assert [h["status"] for h in closed.json()["status_history"]] == ["NEW", "CLOSED"]
    again = await env.client.post(f"/internal/v1/me/tickets/{t['ticket_id']}/close", headers=env.user(user))
    assert again.status_code == 200
    r = await env.client.post(
        f"/internal/v1/me/tickets/{t['ticket_id']}/messages", json={"text": "ещё"}, headers=env.user(user)
    )
    assert r.status_code == 409 and r.json()["code"] == "SUPPORT_TICKET_CLOSED"
    changed = await env.events("support.ticket.status.changed.v1")
    assert len(changed) == 1
    assert changed[0].payload == {
        "ticket_id": t["ticket_id"],
        "number": t["number"],
        "user_id": str(user),
        "from_status": "NEW",
        "to_status": "CLOSED",
        "changed_by": "user",
    }
    assert_event_conforms(changed[0])


async def test_limits(env) -> None:
    user = uuid.uuid4()
    tickets = [await env.create(user) for _ in range(10)]
    too_many = await env.create(user, expect=429)
    assert too_many["code"] == "SUPPORT_TOO_MANY_OPEN"
    await env.client.post(f"/internal/v1/me/tickets/{tickets[0]['ticket_id']}/close", headers=env.user(user))
    await env.create(user)  # закрытое не считается
    # 11 сообщений уже есть (11 созданий); добиваем до 30 в час
    target = tickets[1]["ticket_id"]
    for i in range(19):
        r = await env.client.post(
            f"/internal/v1/me/tickets/{target}/messages", json={"text": f"m{i}"}, headers=env.user(user)
        )
        assert r.status_code == 200, r.text
    limited = await env.client.post(
        f"/internal/v1/me/tickets/{target}/messages", json={"text": "ещё"}, headers=env.user(user)
    )
    assert limited.status_code == 429 and limited.json()["code"] == "SUPPORT_RATE_LIMITED"
    assert 0 < limited.json()["details"]["retry_after"] <= 3601 and limited.headers["Retry-After"]
    # Лимит персональный: другой пользователь пишет свободно
    await env.create(uuid.uuid4())


async def test_client_message_flow_and_idempotency(env) -> None:
    user = uuid.uuid4()
    t = await env.create(user)
    h = env.user(user, idem="msg-" + uuid.uuid4().hex)
    r1 = await env.client.post(
        f"/internal/v1/me/tickets/{t['number']}/messages", json={"text": "Скриншот"}, headers=h
    )
    r2 = await env.client.post(
        f"/internal/v1/me/tickets/{t['number']}/messages", json={"text": "Скриншот"}, headers=h
    )
    assert r1.status_code == r2.status_code == 200
    assert [m["text"] for m in r2.json()["messages"]] == ["Включил, но тишина", "Скриншот"]
    assert r2.json()["status"] == "NEW"  # NEW остаётся NEW
    assert (
        await env.client.post(
            f"/internal/v1/me/tickets/{t['number']}/messages", json={"text": "  "}, headers=env.user(user)
        )
    ).status_code == 422
