"""Сквозной сценарий notifications → telegram-bot-gateway (настоящее внутреннее ASGI-приложение) → Telegram (мок):
напоминание ребёнку уходит опекуну, ответ поддержки — с кнопкой web_app на обращение, повтор доставки не дублирует
сообщение, блокировка бота оставляет запись в центре (AT-07, AT-12, AT-15)."""

from __future__ import annotations

import json
import uuid

import httpx
import pytest
from notif_testkit import SERVICE_DIR, FakeIdentity, NotifEnv, at, local_day

from tilhero_botgw.main import build_apps as build_botgw
from tilhero_botgw.settings import Settings as BotgwSettings
from tilhero_common.app import Runtime
from tilhero_common.messaging import InMemoryBus
from tilhero_common.testing import TEST_ADMIN_URL, TEST_REDIS_URL, create_schema, drop_schema, migrate, unique_schema
from tilhero_notifications.main import build_app as build_notifications
from tilhero_notifications.settings import Settings as NotifSettings

TOKEN = "123456789:AAH" + "e" * 32
MINIAPP = "https://app.tilhero.test/miniapp"


class TelegramStub:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.blocked: set[int] = set()

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/bot{TOKEN}/sendMessage"
        body = json.loads(request.content)
        if body["chat_id"] in self.blocked:
            return httpx.Response(
                403, json={"ok": False, "error_code": 403, "description": "Forbidden: bot was blocked by the user"}
            )
        self.sent.append(body)
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 700 + len(self.sent)}})


class GatewayProxy:
    """Пропускает вызовы notifications во внутреннее приложение bot-gateway и запоминает их (для NotifEnv)."""

    def __init__(self, app) -> None:
        self.inner = httpx.ASGITransport(app=app)
        self.calls: list[dict] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(json.loads(request.content))
        return await self.inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self.inner.aclose()


@pytest.fixture
async def stack():
    schema, prefix, secret = unique_schema("e2e_ntf"), "t_e2e_" + uuid.uuid4().hex[:10], "t" * 40
    await create_schema(schema)
    n_settings = NotifSettings(
        env="test", database_url=TEST_ADMIN_URL, db_schema=schema, redis_url=TEST_REDIS_URL,
        internal_jwt_secret=secret, redis_key_prefix=prefix, dispatcher_enabled=False,
        identity_consent_url="http://identity.test", bot_gateway_url="http://botgw.test",
    )
    b_settings = BotgwSettings(
        env="test", redis_url=TEST_REDIS_URL, internal_jwt_secret=secret, bot_token=TOKEN,
        telegram_webhook_secret="w" * 40, miniapp_url=MINIAPP, telegram_api_base="https://tg.test",
        redis_key_prefix=prefix + "_gw",
    )
    await migrate(SERVICE_DIR, n_settings)
    telegram, identity = TelegramStub(), FakeIdentity()
    n_bus, n_rt, b_rt = InMemoryBus(), None, Runtime(b_settings)
    botgw, botgw_internal = build_botgw(b_settings, b_rt, telegram_transport=httpx.MockTransport(telegram.handler))
    proxy = GatewayProxy(botgw_internal)  # notifications ходит на ВНУТРЕННЕЕ приложение (INTERNAL_PORT)
    n_rt = Runtime(n_settings, bus=n_bus)
    app = build_notifications(
        n_settings, n_rt, identity_transport=httpx.MockTransport(identity.handler), botgw_transport=proxy
    )
    async with botgw.router.lifespan_context(botgw), app.router.lifespan_context(app):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://notifications")
        env = NotifEnv(n_settings, client, n_rt, n_bus, identity, proxy, app.state.dispatcher)  # type: ignore[arg-type]
        yield env, telegram
        await client.aclose()
        for rt in (n_rt, b_rt):
            assert rt.redis is not None
            keys = [k async for k in rt.redis.scan_iter(match=f"{prefix}*")]
            if keys:
                await rt.redis.delete(*keys)
    await drop_schema(schema)


async def test_reminder_to_guardian_and_support_reply_end_to_end(stack) -> None:
    env, telegram = stack
    parent = env.add_user(name="Нигора")
    child = env.add_child(parent, name="Мадина")
    day = local_day(1)
    await env.reminder(child, day, "18:00", duration=20)
    await env.reply_event(parent, "TCK-3081")
    assert await env.dispatch(at(day, "18:00")) == 2
    by_text = {m["text"].split("\n")[0]: m for m in telegram.sent}
    kid = by_text["<b>Мадина: время занятия</b>"]
    assert kid["chat_id"] == env.telegram_id(parent) and kid["parse_mode"] == "HTML"
    assert kid["reply_markup"] == {
        "inline_keyboard": [[{"text": "Начать занятие", "web_app": {"url": f"{MINIAPP}?startapp=route_home"}}]]
    }
    support = by_text["<b>Ответ поддержки</b>"]
    assert support["reply_markup"]["inline_keyboard"][0][0]["web_app"]["url"] == f"{MINIAPP}?startapp=ticket_TCK-3081"
    rows = {r.user_id: r for r in await env.rows()}
    assert rows[child].telegram_message_id in (701, 702) and rows[child].telegram_status == "sent"
    # Повторная отправка того же notification_id (истекла аренда после сбоя) — bot-gateway вернёт тот же message_id
    env.gateway.calls.clear()
    replay = await env.runtime.client("telegram-bot-gateway").post(
        "/internal/v1/messages",
        json={"telegram_user_id": env.telegram_id(parent), "text": kid["text"],
              "buttons": [[{"text": "Начать занятие", "startapp": "route_home"}]], "disable_notification": False,
              "idempotency_key": str(rows[child].notification_id)},
        idempotency_key=str(rows[child].notification_id),
    )
    assert replay["message_id"] == rows[child].telegram_message_id and len(telegram.sent) == 2


async def test_blocked_bot_keeps_center_item_end_to_end(stack) -> None:
    env, telegram = stack
    user = env.add_user(locale="uz")
    telegram.blocked.add(env.telegram_id(user))
    await env.invite("reminder_due", env.add_user(name="Rustam"), user)
    await env.dispatch(at(local_day(1), "12:00"))
    assert telegram.sent == []
    [item] = (await env.inbox(user))["items"]
    assert item["telegram"] == "in_app_only" and item["title"] == "Sizni taklif kutmoqda"
    [failed] = await env.events("telegram.delivery.failed.v1")
    assert failed.payload["reason"] == "blocked"
