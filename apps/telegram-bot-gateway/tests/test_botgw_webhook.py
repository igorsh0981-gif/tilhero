"""Webhook: секрет, идемпотентность update_id, команды RU/EN, deep link, my_chat_member, callback_query."""

from __future__ import annotations

import asyncio
import time

import httpx
import pytest
from botgw_testkit import MINIAPP, SECRET, make_settings

from tilhero_botgw.main import build_apps
from tilhero_common.internal_auth import verify_token


def button(reply: dict) -> dict:
    return reply["reply_markup"]["inline_keyboard"][0][0]


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
        r = await c.post(
            "/telegram/webhook", json={"update_id": 1}, headers={"X-Telegram-Bot-Api-Secret-Token": ""}
        )
        assert r.status_code == 401


async def test_start_greets_and_opens_mini_app(gw) -> None:
    t0 = time.perf_counter()
    r = await gw.webhook(gw.message("/start", first_name="Игорь <b>"))
    assert time.perf_counter() - t0 < 1.0  # ack ≤ 1 с
    reply = r.json()
    assert (
        reply["method"] == "sendMessage" and reply["chat_id"] == 918273645 and reply["parse_mode"] == "HTML"
    )
    assert reply["text"] == (
        "Привет, Игорь &lt;b&gt;! Всё работает внутри мини-приложения TilHero — откройте его кнопкой ниже."
    )
    assert button(reply) == {"text": "Открыть TilHero", "web_app": {"url": f"{MINIAPP}?startapp=home"}}
    assert gw.telegram.calls == []  # ответ — в теле webhook, без исходящих запросов с токеном


@pytest.mark.parametrize(
    ("command", "section", "ru_button", "en_button"),
    [
        ("/events", "catalog", "Открыть каталог", "Open catalogue"),
        ("/watch", "watch", "Открыть слежения", "Open watches"),
        ("/support", "support", "Открыть поддержку", "Open support"),
        ("/help", "home", "Открыть TilHero", "Open TilHero"),
        ("/start", "home", "Открыть TilHero", "Open TilHero"),
        ("/events@TilHeroBot", "catalog", "Открыть каталог", "Open catalogue"),
    ],
)
async def test_commands_ru_en(gw, command: str, section: str, ru_button: str, en_button: str) -> None:
    for lang, expected in (
        ("ru", ru_button),
        ("uz", ru_button),
        ("kk", ru_button),
        ("ru-RU", ru_button),
        ("en", en_button),
        ("de", en_button),
        (None, en_button),
    ):
        reply = (await gw.webhook(gw.message(command, lang=lang))).json()
        assert button(reply)["text"] == expected, (command, lang)
        assert button(reply)["web_app"]["url"] == f"{MINIAPP}?startapp={section}"
    help_ru = (await gw.webhook(gw.message("/help"))).json()["text"]
    assert "/support — поддержка" in help_ru and "Отдельного чат-бота нет" in help_ru


async def test_start_deep_link_param(gw) -> None:
    cases = {
        "/start evt_f1_auh_2026": "evt_f1_auh_2026",
        "/start ticket_TCK-3081": "ticket_TCK-3081",
        "/start " + "a" * 64: "a" * 64,
        "/start " + "a" * 65: "home",
        "/start ../../admin": "home",
        "/start evt_1 extra": "home",
        "/start <script>": "home",
        "/start%20x": "home",
    }
    for text, startapp in cases.items():
        reply = (await gw.webhook(gw.message(text))).json()
        assert button(reply)["web_app"]["url"] == f"{MINIAPP}?startapp={startapp}", text


async def test_duplicate_update_is_ignored(gw) -> None:
    update = gw.message("/start")
    first = await gw.webhook(update)
    second = await gw.webhook(update)
    assert first.json()["method"] == "sendMessage"
    assert second.status_code == 200 and second.json() == {"ok": True}
    parallel = gw.message("/watch")
    results = await asyncio.gather(*[gw.webhook(parallel) for _ in range(5)])
    assert sum(1 for r in results if r.json().get("method") == "sendMessage") == 1


async def test_other_messages_and_chats(gw) -> None:
    text = (await gw.webhook(gw.message("Привет, где билеты?", first_name=""))).json()
    assert text["text"].startswith("Привет! Всё работает") and button(text)["web_app"]["url"].endswith(
        "=home"
    )
    unknown = (await gw.webhook(gw.message("/unknown"))).json()
    assert unknown["method"] == "sendMessage"
    for update in (
        gw.message("/start", chat_type="group"),
        gw.message("/start", is_bot=True),
        {"update_id": gw.next_update_id(), "edited_message": {"text": "x"}},
        {"update_id": gw.next_update_id(), "message": "garbage"},
    ):
        r = await gw.webhook(update)
        assert r.status_code == 200 and r.json() == {"ok": True}


async def test_invalid_updates(gw) -> None:
    h = {"X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json"}
    assert (await gw.client.post("/telegram/webhook", content=b"{not json", headers=h)).status_code == 400
    for body in ({}, {"update_id": "1"}, [1, 2]):
        r = await gw.client.post(
            "/telegram/webhook", json=body, headers={"X-Telegram-Bot-Api-Secret-Token": SECRET}
        )
        assert r.status_code == 400 and r.json()["code"] == "WEBHOOK_INVALID"
    big = {"update_id": gw.next_update_id(), "message": {"text": "x" * 300_000}}
    assert (await gw.webhook(big)).status_code == 413


async def test_callback_query_answers_soon(gw) -> None:
    for lang, text in (("ru", "Скоро"), ("en", "Coming soon")):
        update = {
            "update_id": gw.next_update_id(),
            "callback_query": {
                "id": f"cb-{lang}",
                "from": {"id": 1, "is_bot": False, "first_name": "A", "language_code": lang},
                "data": "unwatch:evt_f1_auh_2026",
            },
        }
        reply = (await gw.webhook(update)).json()
        assert reply == {"method": "answerCallbackQuery", "callback_query_id": f"cb-{lang}", "text": text}


def member_update(gw, status: str, *, chat_type: str = "private") -> dict:
    return {
        "update_id": gw.next_update_id(),
        "my_chat_member": {
            "chat": {"id": 918273645, "type": chat_type},
            "from": {"id": 918273645, "is_bot": False, "first_name": "И"},
            "date": 1_760_000_000,
            "old_chat_member": {"status": "member", "user": {"id": 1, "is_bot": True}},
            "new_chat_member": {"status": status, "user": {"id": 1, "is_bot": True}},
        },
    }


async def test_my_chat_member_reports_bot_status(gw) -> None:
    r = await gw.webhook(member_update(gw, "kicked"))
    assert r.status_code == 200 and r.json() == {"ok": True}
    await gw.webhook(member_update(gw, "member"))
    await gw.webhook(member_update(gw, "left"))
    await gw.webhook(member_update(gw, "kicked", chat_type="group"))
    calls = gw.identity.calls
    assert [(path, body) for path, body, _ in calls] == [
        ("/internal/v1/telegram-users/918273645/bot-status", {"blocked": True}),
        ("/internal/v1/telegram-users/918273645/bot-status", {"blocked": False}),
    ]
    principal = verify_token(calls[0][2]["x-internal-token"], "t" * 40, audience="identity-consent")
    assert principal.issuer == "telegram-bot-gateway" and principal.subject is None


async def test_bot_status_retries_transient_errors(gw) -> None:
    gw.identity.statuses = [503, 503, 204]  # два сбоя identity-consent, третья попытка успешна
    await gw.webhook(member_update(gw, "kicked"))
    assert len(gw.identity.calls) == 3 and gw.identity.calls[-1][1] == {"blocked": True}
    gw.identity.calls.clear()
    gw.identity.statuses = [404]
    await gw.webhook(member_update(gw, "kicked"))
    assert len(gw.identity.calls) == 1  # 4xx — без повторов


async def test_chat_reply_rate_limit(gw) -> None:
    replies = [
        (await gw.webhook(gw.message("/start"))).json()
        for _ in range(gw.settings.chat_replies_per_minute + 2)
    ]
    assert sum(1 for r in replies if "method" in r) == gw.settings.chat_replies_per_minute
    other = (await gw.webhook(gw.message("/start", user_id=111))).json()
    assert other["method"] == "sendMessage"


async def test_health_without_database(gw) -> None:
    for client in (gw.client, gw.internal):
        r = await client.get("/health/ready")
        assert r.status_code == 200 and r.json()["checks"] == {"redis": "ok"}


async def test_internal_api_is_not_on_public_port(gw) -> None:
    """Ревью P1: публичный порт — только webhook и health; внутренний — только internal API и health."""
    from tilhero_common.testing import internal_headers

    h = internal_headers(gw.settings, issuer="notifications")
    msg = {"telegram_user_id": 1, "text": "x", "idempotency_key": "k" * 16}
    public = await gw.client.post("/internal/v1/messages", json=msg, headers=h)
    assert public.status_code == 404 and gw.telegram.calls == []
    assert (await gw.internal.post("/telegram/webhook", json=gw.message("/start"))).status_code == 404
    assert (await gw.client.get("/openapi.json")).status_code == 200  # env=test: схема доступна, но без internal
    assert all(not p.startswith("/internal") for p in (await gw.client.get("/openapi.json")).json()["paths"])


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
