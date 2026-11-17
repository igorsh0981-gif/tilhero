"""Сквозной сценарий AT-32 / A-AT-41: клиент ↔ оператор → notifications → bot-gateway → Telegram.

Три сервиса со своими схемами/шинами; события переносятся между шинами как NATS (outbox → bus → inbox).
Telegram — httpx.MockTransport, identity-consent — фейк, bot-gateway — настоящее ASGI-приложение.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import httpx
import pytest
from notif_testkit import SERVICE_DIR, FakeIdentity

from tilhero_botgw.main import build_apps as build_botgw
from tilhero_botgw.settings import Settings as BotgwSettings
from tilhero_common.app import Runtime
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import Envelope, InMemoryBus
from tilhero_common.testing import (
    TEST_ADMIN_URL,
    TEST_REDIS_URL,
    assert_event_conforms,
    create_schema,
    drop_schema,
    internal_headers,
    migrate,
    unique_schema,
)
from tilhero_notifications.main import build_app as build_notifications
from tilhero_notifications.settings import Settings as NotifSettings
from tilhero_support.main import build_app as build_support
from tilhero_support.settings import Settings as SupportSettings

SUPPORT_DIR = str(Path(__file__).resolve().parents[2] / "support")
TOKEN = "123456789:AAH" + "e" * 32
MINIAPP = "https://app.tilhero.test/miniapp"
OPERATOR = Actor(
    id="support.01", role="support", permissions=frozenset({"support.read", "support.reply"}), name="Алина Петрова"
)


class TelegramStub:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.blocked: set[int] = set()

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/bot{TOKEN}/sendMessage"
        body = json.loads(request.content)
        if body["chat_id"] in self.blocked:
            return httpx.Response(
                403,
                json={
                    "ok": False,
                    "error_code": 403,
                    "description": "Forbidden: bot was blocked by the user",
                },
            )
        self.sent.append(body)
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 700 + len(self.sent)}})


@pytest.fixture
async def stack():
    s_schema, n_schema = unique_schema("e2e_sup"), unique_schema("e2e_ntf")
    prefix = "t_e2e_" + uuid.uuid4().hex[:10]
    for schema in (s_schema, n_schema):
        await create_schema(schema)
    secret = "t" * 40
    s_settings = SupportSettings(
        env="test", database_url=TEST_ADMIN_URL, db_schema=s_schema, internal_jwt_secret=secret
    )
    n_settings = NotifSettings(
        env="test",
        database_url=TEST_ADMIN_URL,
        db_schema=n_schema,
        redis_url=TEST_REDIS_URL,
        internal_jwt_secret=secret,
        redis_key_prefix=prefix,
        dispatcher_enabled=False,
        identity_consent_url="http://identity.test",
        bot_gateway_url="http://botgw.test",
    )
    b_settings = BotgwSettings(
        env="test",
        redis_url=TEST_REDIS_URL,
        internal_jwt_secret=secret,
        bot_token=TOKEN,
        telegram_webhook_secret="w" * 40,
        miniapp_url=MINIAPP,
        telegram_api_base="https://tg.test",
        redis_key_prefix=prefix,
    )
    await migrate(SUPPORT_DIR, s_settings)
    await migrate(SERVICE_DIR, n_settings)
    telegram, identity = TelegramStub(), FakeIdentity()
    s_bus, n_bus = InMemoryBus(), InMemoryBus()
    s_rt, n_rt, b_rt = Runtime(s_settings, bus=s_bus), Runtime(n_settings, bus=n_bus), Runtime(b_settings)
    # notifications ходит на ВНУТРЕННЕЕ приложение bot-gateway (INTERNAL_PORT), публичное — только webhook
    botgw, botgw_internal = build_botgw(b_settings, b_rt, telegram_transport=httpx.MockTransport(telegram.handler))
    support = build_support(s_settings, s_rt)
    notifications = build_notifications(
        n_settings,
        n_rt,
        identity_transport=httpx.MockTransport(identity.handler),
        botgw_transport=httpx.ASGITransport(app=botgw_internal),
    )
    async with (
        botgw.router.lifespan_context(botgw),
        support.router.lifespan_context(support),
        notifications.router.lifespan_context(notifications),
    ):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=support), base_url="http://support")
        yield {
            "client": client,
            "s_rt": s_rt,
            "n_rt": n_rt,
            "s_bus": s_bus,
            "n_bus": n_bus,
            "telegram": telegram,
            "identity": identity,
            "dispatcher": notifications.state.dispatcher,
            "secret": secret,
            "settings": s_settings,
        }
        await client.aclose()
        assert b_rt.redis is not None
        keys = [k async for k in b_rt.redis.scan_iter(match=f"*{prefix}*")]
        if keys:
            await b_rt.redis.delete(*keys)
    for schema in (s_schema, n_schema):
        await drop_schema(schema)


async def bridge(stack, *, redeliver: bool = False) -> list[Envelope]:
    """Outbox support → «NATS» → inbox notifications. redeliver=True — повторная доставка тех же сообщений
    мимо дедупликации шины (как JetStream после nak/таймаута ack): защищает только inbox потребителя."""
    await stack["s_rt"].relay.drain()
    moved = [e for e in stack["s_bus"].published if e.event_type.startswith("support.ticket.")]
    for env in moved:
        if redeliver:
            for spec in stack["n_bus"].specs:
                if env.event_type in spec.event_types:
                    await spec.handler(env)
        else:
            await stack["n_bus"].publish(env)
    return moved


async def test_operator_reply_reaches_client_in_telegram_and_mini_app(stack) -> None:
    c, settings = stack["client"], stack["settings"]
    user = uuid.uuid4()
    stack["identity"].users[str(user)] = {
        "telegram_user_id": 918273645,
        "locale": "ru",
        "notifications_enabled": True,
        "quiet_hours": None,
        "timezone": "Asia/Tashkent",
        "status": "ACTIVE",
    }
    user_h = internal_headers(settings, issuer="telegram-bff", subject=str(user))
    staff_h = internal_headers(settings, issuer="admin-bff", actor=OPERATOR)
    created = await c.post(
        "/internal/v1/me/tickets",
        headers={**user_h, "Idempotency-Key": uuid.uuid4().hex},
        json={
            "category": "TICKET_SOURCE",
            "subject": "Не открывается ссылка на билет",
            "message": "При переходе получаю ошибку",
            "context": {
                "event_id": "evt_f1_auh_2026",
                "offer_id": "off_987",
                "client_version": "telegram-miniapp-2.0",
            },
        },
    )
    ticket = created.json()
    number = ticket["number"]
    await c.post(
        f"/admin/v1/support/tickets/{number}/messages",
        headers=staff_h,
        json={"text": "ВНУТР: проверить провайдера", "visibility": "internal"},
    )
    await c.post(
        f"/admin/v1/support/tickets/{number}/messages",
        headers=staff_h,
        json={"text": "Ссылка исправлена, проверьте", "visibility": "public"},
    )
    await bridge(stack)
    assert await stack["dispatcher"].run_once() == 1

    [msg] = stack["telegram"].sent
    assert msg["chat_id"] == 918273645 and msg["parse_mode"] == "HTML"
    assert msg["text"] == f"Поддержка ответила на обращение {number}. Откройте, чтобы прочитать."
    assert msg["reply_markup"] == {
        "inline_keyboard": [
            [{"text": "Открыть обращение", "web_app": {"url": f"{MINIAPP}?startapp=ticket_{number}"}}]
        ]
    }
    assert "Ссылка исправлена" not in json.dumps(msg, ensure_ascii=False)
    assert "ВНУТР" not in json.dumps(msg, ensure_ascii=False)

    # Mini App открывает обращение по deep link ticket_TCK-… и видит ответ (AT-32)
    view = (await c.get(f"/internal/v1/me/tickets/{number}", headers=user_h)).json()
    assert [(m["sender_type"], m["author_name"]) for m in view["messages"]] == [
        ("user", None),
        ("operator", "Алина"),
    ]
    assert view["messages"][1]["text"] == "Ссылка исправлена, проверьте" and "ВНУТР" not in json.dumps(view)

    await c.patch(f"/admin/v1/support/tickets/{number}", headers=staff_h, json={"status": "RESOLVED"})
    await bridge(stack)
    await stack["dispatcher"].run_once()
    assert stack["telegram"].sent[-1]["text"].startswith(f"Обращение {number} решено.")
    # Повторная доставка тех же событий не даёт дублей уведомлений (inbox + dedup_key)
    await bridge(stack, redeliver=True)
    await stack["dispatcher"].run_once()
    assert len(stack["telegram"].sent) == 2

    await stack["n_rt"].relay.drain()
    delivered = stack["n_bus"].of_type("notification.delivered.v1")
    assert len(delivered) == 2
    for e in [*delivered, *stack["s_bus"].published]:
        assert_event_conforms(e)


async def test_blocked_bot_marks_delivery_failed(stack) -> None:
    c, settings = stack["client"], stack["settings"]
    user = uuid.uuid4()
    stack["identity"].users[str(user)] = {
        "telegram_user_id": 111222333,
        "locale": "en",
        "notifications_enabled": True,
        "quiet_hours": None,
        "timezone": None,
        "status": "ACTIVE",
    }
    stack["telegram"].blocked.add(111222333)
    user_h = internal_headers(settings, issuer="telegram-bff", subject=str(user))
    ticket = (
        await c.post(
            "/internal/v1/me/tickets",
            headers={**user_h, "Idempotency-Key": uuid.uuid4().hex},
            json={"category": "BUG", "subject": "Crash", "message": "App crashes"},
        )
    ).json()
    await c.post(
        f"/admin/v1/support/tickets/{ticket['ticket_id']}/messages",
        headers=internal_headers(settings, issuer="admin-bff", actor=OPERATOR),
        json={"text": "Fixed", "visibility": "public"},
    )
    await bridge(stack)
    await stack["dispatcher"].run_once()
    assert stack["telegram"].sent == []
    await stack["n_rt"].relay.drain()
    [failed] = stack["n_bus"].of_type("telegram.delivery.failed.v1")
    assert failed.payload["reason"] == "blocked" and failed.payload["user_id"] == str(user)
    assert_event_conforms(failed)
    # Клиент всё равно видит ответ в Mini App
    view = (await c.get(f"/internal/v1/me/tickets/{ticket['ticket_id']}", headers=user_h)).json()
    assert view["messages"][-1]["text"] == "Fixed"
