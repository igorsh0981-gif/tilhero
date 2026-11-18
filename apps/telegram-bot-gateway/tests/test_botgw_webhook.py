"""Webhook (INTERNAL_API §8): секрет, идемпотентность update_id, /start с payload из белого списка, одна подсказка на
прочие команды и текст (RU/UZ по language_code), блокировка бота → identity-consent, callback_query."""

from __future__ import annotations

import asyncio
import time
import uuid

import httpx
import pytest
from botgw_testkit import APP_LINK, MINIAPP, SECRET, make_settings
from pydantic import ValidationError

from tilhero_botgw.main import build_apps
from tilhero_botgw.settings import Settings
from tilhero_common.internal_auth import verify_token

HELLO_RU = "Всё обучение — в мини-приложении TilHero: занятия, график и напоминания. Откройте его кнопкой ниже."
HINT_RU = "Бот только открывает приложение и присылает напоминания. Всё остальное — в TilHero: нажмите кнопку ниже."
HINT_UZ = "Bot faqat ilovani ochadi va eslatmalar yuboradi. Qolgan hammasi TilHeroʼda — quyidagi tugmani bosing."
PLAIN_RU = {"text": "Открыть TilHero", "web_app": {"url": MINIAPP}}
INVITE = "inv_" + "Ab3_-x" * 5 + "Zz"  # 32 символа base64url (social)
GC = "gc_" + "Q" * 43  # 32 байта base64url (identity-consent)


def button(reply: dict) -> dict:
    [[only]] = reply["reply_markup"]["inline_keyboard"]
    return only


async def test_webhook_requires_secret(gw) -> None:
    update = gw.message("/start")
    for secret in (None, "", "wrong", SECRET + "x", SECRET[:-1]):
        r = await gw.webhook(update, secret=secret)
        assert r.status_code == 401 and r.json()["code"] == "WEBHOOK_UNAUTHORIZED"
    # Отклонённый запрос не «съедает» update_id: настоящий Telegram с тем же id всё равно обработан
    ok = await gw.webhook(update)
    assert ok.status_code == 200 and ok.json()["method"] == "sendMessage"


async def test_empty_secret_setting_fails_closed() -> None:
    app, _ = build_apps(make_settings("t_botgw_closed", telegram_webhook_secret=""))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://botgw") as c:
        r = await c.post("/telegram/webhook", json={"update_id": 1}, headers={"X-Telegram-Bot-Api-Secret-Token": ""})
        assert r.status_code == 401


async def test_start_greets_and_opens_mini_app(gw) -> None:
    t0 = time.perf_counter()
    r = await gw.webhook(gw.message("/start", first_name="Игорь <b>"))
    assert time.perf_counter() - t0 < 1.0  # ack ≤ 1 с
    reply = r.json()
    assert (reply["method"], reply["chat_id"], reply["parse_mode"]) == ("sendMessage", 918273645, "HTML")
    assert reply["text"] == f"Привет, Игорь &lt;b&gt;! {HELLO_RU}"
    assert reply["link_preview_options"] == {"is_disabled": True}
    assert button(reply) == PLAIN_RU
    assert gw.telegram.calls == []  # ответ — в теле webhook, без исходящих запросов с токеном
    anon = (await gw.webhook(gw.message("/start@TilHeroBot", first_name="  "))).json()
    assert anon["text"] == f"Привет! {HELLO_RU}"


@pytest.mark.parametrize(
    ("lang", "expected"),
    [
        ("uz", "uz"),
        ("uz-Latn", "uz"),
        ("UZ", "uz"),
        ("ru", "ru"),
        ("ru-RU", "ru"),
        ("en", "ru"),
        ("kk", "ru"),
        (None, "ru"),
    ],
)
async def test_language_ru_uz(gw, lang: str | None, expected: str) -> None:
    reply = (await gw.webhook(gw.message("/start", lang=lang, first_name="Alisher"))).json()
    if expected == "uz":
        assert reply["text"].startswith("Salom, Alisher! Butun taʼlim TilHero mini-ilovasida")
        assert button(reply)["text"] == "TilHeroʼni ochish"
    else:
        assert reply["text"] == f"Привет, Alisher! {HELLO_RU}" and button(reply)["text"] == "Открыть TilHero"
    hint = (await gw.webhook(gw.message("Привет", lang=lang))).json()
    assert hint["text"] == (HINT_UZ if expected == "uz" else HINT_RU)


@pytest.mark.parametrize(
    "payload",
    [
        INVITE,
        GC,
        "route_family",
        "route_home",
        f"invite_{uuid.UUID('3f2b8c1e-6a4d-4e0b-9c71-2d5e8f1a7b90')}",
        "ticket_TCK-3081",
        "inv_" + "a" * 60,  # ровно 64
    ],
)
async def test_start_payload_goes_to_direct_link(link_gw, payload: str) -> None:
    reply = (await link_gw.webhook(link_gw.message(f"/start {payload}"))).json()
    assert reply["text"] == f"Привет, Игорь! {HELLO_RU}"
    assert button(reply) == {"text": "Открыть TilHero", "url": f"{APP_LINK}?startapp={payload}"}


@pytest.mark.parametrize(
    "text",
    [
        "/start evt_f1_auh_2026",  # туристические deep link'и — не TilHero
        "/start watch",
        "/start inv_short",
        "/start inv_" + "a" * 61,  # 65 символов
        "/start gc_" + "Q" * 62,
        "/start route_Family",
        "/start route_",
        "/start invite_not-a-uuid",
        "/start ticket_3081",
        "/start ../../admin",
        "/start inv_" + "a" * 32 + " extra",
        "/start <script>",
        "/start inv_" + "a" * 31 + "а",  # кириллическая «а»
    ],
)
async def test_start_payload_outside_whitelist_is_dropped(link_gw, text: str) -> None:
    reply = (await link_gw.webhook(link_gw.message(text))).json()
    assert reply["text"] == f"Привет, Игорь! {HELLO_RU}"
    assert button(reply) == PLAIN_RU  # приложение открывается, payload не передаётся


async def test_start_payload_without_direct_link_falls_back_to_web_app(gw) -> None:
    reply = (await gw.webhook(gw.message("/start route_family"))).json()
    assert button(reply) == {"text": "Открыть TilHero", "web_app": {"url": f"{MINIAPP}?startapp=route_family"}}


@pytest.mark.parametrize(
    "text", ["/help", "/events", "/watch", "/support", "/unknown", "Где мой урок?", "/start%20x", ""]
)
async def test_other_commands_and_text_get_one_hint(link_gw, text: str) -> None:
    reply = (await link_gw.webhook(link_gw.message(text))).json()
    assert reply["method"] == "sendMessage" and reply["text"] == HINT_RU
    assert button(reply) == PLAIN_RU


async def test_duplicate_update_is_ignored(gw) -> None:
    update = gw.message("/start")
    first = await gw.webhook(update)
    second = await gw.webhook(update)
    assert first.json()["method"] == "sendMessage"
    assert second.status_code == 200 and second.json() == {"ok": True}
    parallel = gw.message("Привет")
    results = await asyncio.gather(*[gw.webhook(parallel) for _ in range(5)])
    assert sum(1 for r in results if r.json().get("method") == "sendMessage") == 1


async def test_groups_bots_and_garbage_are_ignored(gw) -> None:
    for update in (
        gw.message("/start", chat_type="group"),
        gw.message("/start", chat_type="supergroup"),
        gw.message("/start", is_bot=True),
        {"update_id": gw.next_update_id(), "edited_message": {"text": "x"}},
        {"update_id": gw.next_update_id(), "message": "garbage"},
        {"update_id": gw.next_update_id(), "message": {"chat": {"id": "1", "type": "private"}, "text": "/start"}},
    ):
        r = await gw.webhook(update)
        assert r.status_code == 200 and r.json() == {"ok": True}


async def test_invalid_updates(gw) -> None:
    h = {"X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json"}
    assert (await gw.client.post("/telegram/webhook", content=b"{not json", headers=h)).status_code == 400
    for body in ({}, {"update_id": "1"}, [1, 2]):
        r = await gw.client.post("/telegram/webhook", json=body, headers={"X-Telegram-Bot-Api-Secret-Token": SECRET})
        assert r.status_code == 400 and r.json()["code"] == "WEBHOOK_INVALID"
    big = {"update_id": gw.next_update_id(), "message": {"text": "x" * 300_000}}
    assert (await gw.webhook(big)).status_code == 413


async def test_callback_query_is_just_acknowledged(gw) -> None:
    update = {
        "update_id": gw.next_update_id(),
        "callback_query": {"id": "cb-1", "from": {"id": 1, "is_bot": False, "first_name": "A"}, "data": "x"},
    }
    assert (await gw.webhook(update)).json() == {"method": "answerCallbackQuery", "callback_query_id": "cb-1"}
    bad = {"update_id": gw.next_update_id(), "callback_query": {"id": 5}}
    assert (await gw.webhook(bad)).json() == {"ok": True}


def member_update(gw, status: str, *, chat_type: str = "private", user_id: int = 918273645) -> dict:
    return {
        "update_id": gw.next_update_id(),
        "my_chat_member": {
            "chat": {"id": user_id if chat_type == "private" else -1001234567890, "type": chat_type, "title": "x"},
            "from": {"id": user_id, "is_bot": False, "first_name": "И"},
            "date": 1_760_000_000,
            "old_chat_member": {"status": "member", "user": {"id": 1, "is_bot": True}},
            "new_chat_member": {"status": status, "user": {"id": 1, "is_bot": True}},
        },
    }


async def test_my_chat_member_reports_bot_status(gw, caplog) -> None:
    r = await gw.webhook(member_update(gw, "kicked"))
    assert r.status_code == 200 and r.json() == {"ok": True}
    await gw.webhook(member_update(gw, "member"))
    await gw.webhook(member_update(gw, "left"))
    await gw.webhook(member_update(gw, "kicked", chat_type="group"))
    await gw.webhook(member_update(gw, "member", chat_type="supergroup"))  # операторского чата нет
    await gw.webhook(member_update(gw, "kicked", user_id=0))
    calls = gw.identity.calls
    assert [(path, body) for path, body, _ in calls] == [
        ("/internal/v1/telegram-users/918273645/bot-status", {"blocked": True}),
        ("/internal/v1/telegram-users/918273645/bot-status", {"blocked": False}),
    ]
    principal = verify_token(calls[0][2]["x-internal-token"], "t" * 40, audience="identity-consent")
    assert principal.issuer == "telegram-bot-gateway" and principal.subject is None
    assert "-1001234567890" not in caplog.text and "918273645" not in caplog.text


async def test_bot_status_retries_transient_errors(gw) -> None:
    gw.identity.statuses = [503, 503, 204]  # два сбоя identity-consent, третья попытка успешна
    await gw.webhook(member_update(gw, "kicked"))
    assert len(gw.identity.calls) == 3 and gw.identity.calls[-1][1] == {"blocked": True}
    gw.identity.calls.clear()
    gw.identity.statuses = [404]
    await gw.webhook(member_update(gw, "kicked"))
    assert len(gw.identity.calls) == 1  # 4xx — без повторов


async def test_chat_reply_rate_limit(gw) -> None:
    replies = [(await gw.webhook(gw.message("/start"))).json() for _ in range(gw.settings.chat_replies_per_minute + 2)]
    assert sum(1 for r in replies if "method" in r) == gw.settings.chat_replies_per_minute
    other = (await gw.webhook(gw.message("/start", user_id=111))).json()
    assert other["method"] == "sendMessage"


async def test_health_without_database(gw) -> None:
    for client in (gw.client, gw.internal):
        r = await client.get("/health/ready")
        assert r.status_code == 200 and r.json()["checks"] == {"redis": "ok"}


async def test_internal_api_is_not_on_public_port(gw) -> None:
    """Публичный порт — только webhook и health; внутренний — только internal API и health; ops-сообщений нет."""
    from tilhero_common.testing import internal_headers

    h = internal_headers(gw.settings, issuer="notifications")
    msg = {"telegram_user_id": 1, "text": "x", "idempotency_key": "k" * 16}
    public = await gw.client.post("/internal/v1/messages", json=msg, headers=h)
    assert public.status_code == 404 and gw.telegram.calls == []
    assert (await gw.internal.post("/telegram/webhook", json=gw.message("/start"))).status_code == 404
    ops = await gw.internal.post("/internal/v1/ops-messages", json={"text": "x", "dedup_key": "k" * 16}, headers=h)
    assert ops.status_code == 404
    paths = (await gw.client.get("/openapi.json")).json()["paths"]
    assert all(not p.startswith("/internal") for p in paths)
    assert set((await gw.internal.get("/openapi.json")).json()["paths"]) >= {"/internal/v1/messages"}


async def test_port_router_dispatches_by_local_port() -> None:
    from tilhero_botgw.main import PortRouter

    seen: list[str] = []

    def app(name: str):
        async def _app(scope, receive, send) -> None:
            seen.append(name)

        return _app

    router = PortRouter(app("public"), app("internal"), internal_port=8108)
    for scope in (
        {"type": "http", "server": ("::", 8107)},
        {"type": "http", "server": ("10.0.0.5", 8108)},
        {"type": "http", "server": None},  # нет сведений о порте → публичное (fail closed)
        {"type": "lifespan"},
    ):
        await router(scope, None, None)
    assert seen == ["public", "internal", "public", "public"]


@pytest.mark.parametrize(
    "link",
    [
        "http://t.me/TilHeroBot/app",
        "https://evil.example/TilHeroBot/app",
        "https://t.me/TilHeroBot/app?startapp=x",
        "https://t.me/TilHeroBot",
        "https://t.me/TilHeroBot/app/extra",
        "https://user@t.me/TilHeroBot/app",
    ],
)
def test_app_link_validation(link: str) -> None:
    with pytest.raises(ValidationError):
        Settings(env="test", telegram_app_link=link)


def test_app_link_normalized() -> None:
    assert Settings(env="test", telegram_app_link=" https://t.me/TilHeroBot/app/ ").telegram_app_link == APP_LINK
    assert Settings(env="test", telegram_app_link="").telegram_app_link is None
