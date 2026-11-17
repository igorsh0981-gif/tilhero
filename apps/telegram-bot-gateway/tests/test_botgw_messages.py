"""POST /internal/v1/messages: доставка, идемпотентность, ошибки Telegram, токен бота вне логов."""

from __future__ import annotations

import asyncio
import io
import logging
import uuid

import httpx
from botgw_testkit import MINIAPP, TOKEN

from tilhero_botgw.telegram import TelegramClient
from tilhero_common.logging import JsonFormatter
from tilhero_common.testing import internal_headers


def body(**kw) -> dict:
    base = {
        "telegram_user_id": 918273645,
        "text": "Поддержка ответила на обращение <b>TCK-3081</b>. Откройте, чтобы прочитать.",
        "buttons": [
            [{"text": "Открыть обращение", "startapp": "ticket_TCK-3081"}],
            [{"text": "Справка", "url": "https://tilhero.uz/help/notifications"}],
        ],
        "disable_notification": True,
        "idempotency_key": str(uuid.uuid4()),
    }
    base.update(kw)
    return base


def auth(gw, issuer: str = "notifications") -> dict:
    return internal_headers(gw.settings, issuer=issuer)


async def test_send_message_with_buttons(gw) -> None:
    r = await gw.internal.post("/internal/v1/messages", json=body(), headers=auth(gw))
    assert r.status_code == 200 and r.json() == {"message_id": 501}
    [sent] = gw.telegram.sent()
    assert (
        sent["chat_id"] == 918273645 and sent["parse_mode"] == "HTML" and sent["disable_notification"] is True
    )
    assert sent["link_preview_options"] == {"is_disabled": True}
    assert sent["reply_markup"] == {
        "inline_keyboard": [
            [{"text": "Открыть обращение", "web_app": {"url": f"{MINIAPP}?startapp=ticket_TCK-3081"}}],
            [{"text": "Справка", "url": "https://tilhero.uz/help/notifications"}],
        ]
    }
    assert gw.telegram.tokens_seen == {TOKEN}
    plain = await gw.internal.post(
        "/internal/v1/messages", json=body(buttons=None, disable_notification=False), headers=auth(gw)
    )
    assert plain.status_code == 200 and "reply_markup" not in gw.telegram.sent()[-1]


async def test_idempotency_key(gw) -> None:
    b = body()
    first = await gw.internal.post("/internal/v1/messages", json=b, headers=auth(gw))
    again = await gw.internal.post("/internal/v1/messages", json=b, headers=auth(gw))
    assert first.json() == again.json() and again.headers["Idempotent-Replayed"] == "true"
    assert len(gw.telegram.sent()) == 1
    changed = await gw.internal.post("/internal/v1/messages", json={**b, "text": "другой"}, headers=auth(gw))
    assert changed.status_code == 422 and changed.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    b2 = body()
    results = await asyncio.gather(
        *[gw.internal.post("/internal/v1/messages", json=b2, headers=auth(gw)) for _ in range(4)]
    )
    assert len(gw.telegram.sent()) == 2  # параллельные дубли не отправляют второе сообщение
    assert {r.status_code for r in results} <= {200, 409}
    assert len({r.json()["message_id"] for r in results if r.status_code == 200}) == 1


async def test_auth(gw) -> None:
    assert (await gw.internal.post("/internal/v1/messages", json=body())).status_code == 401
    for issuer in ("support", "telegram-bff", "admin-bff"):
        r = await gw.internal.post("/internal/v1/messages", json=body(), headers=auth(gw, issuer))
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    wrong_aud = internal_headers(gw.settings, issuer="notifications", audience="support")
    assert (await gw.internal.post("/internal/v1/messages", json=body(), headers=wrong_aud)).status_code == 401
    assert gw.telegram.calls == []


async def test_validation(gw) -> None:
    bad = [
        body(buttons=[[{"text": "x", "url": "http://example.com"}]]),
        body(buttons=[[{"text": "x", "url": "https://u:p@example.com"}]]),
        body(buttons=[[{"text": "x", "url": "javascript:alert(1)"}]]),
        body(buttons=[[{"text": "x", "startapp": "a", "url": "https://example.com"}]]),
        body(buttons=[[{"text": "x"}]]),
        body(buttons=[[{"text": "x", "startapp": "../admin"}]]),
        body(buttons=[[]]),
        body(buttons=[[{"text": "x", "startapp": "a"}]] * 9),
        body(text=""),
        body(text="x" * 4097),
        body(telegram_user_id=0),
        body(idempotency_key="short"),
        {**body(), "parse_mode": "Markdown"},
    ]
    for payload in bad:
        r = await gw.internal.post("/internal/v1/messages", json=payload, headers=auth(gw))
        assert r.status_code == 422, payload
    assert gw.telegram.calls == []


async def test_telegram_error_mapping(gw) -> None:
    b = body()
    gw.telegram.queue.append(
        (
            429,
            {
                "ok": False,
                "error_code": 429,
                "description": "Too Many Requests: retry after 7",
                "parameters": {"retry_after": 7},
            },
        )
    )
    r = await gw.internal.post("/internal/v1/messages", json=b, headers=auth(gw))
    assert r.status_code == 429 and r.json()["code"] == "TELEGRAM_RATE_LIMITED"
    assert r.json()["details"]["retry_after"] == 7 and r.headers["Retry-After"] == "7"
    retry = await gw.internal.post("/internal/v1/messages", json=b, headers=auth(gw))  # ключ освобождён
    assert retry.status_code == 200

    gw.telegram.queue.append(
        (403, {"ok": False, "error_code": 403, "description": "Forbidden: bot was blocked by the user"})
    )
    r = await gw.internal.post("/internal/v1/messages", json=body(), headers=auth(gw))
    assert r.status_code == 409 and r.json()["code"] == "TELEGRAM_BLOCKED"

    gw.telegram.queue.append(
        (400, {"ok": False, "error_code": 400, "description": "Bad Request: chat not found"})
    )
    r = await gw.internal.post("/internal/v1/messages", json=body(), headers=auth(gw))
    assert r.status_code == 502 and r.json()["code"] == "TELEGRAM_ERROR"
    assert r.json()["details"] == {"telegram_status": 400, "reason": "chat_not_found", "permanent": True}

    for item in (
        (500, {"ok": False, "error_code": 500, "description": "Internal"}),
        httpx.ConnectError("boom"),
        httpx.ReadTimeout("slow"),
        (200, {"ok": True, "result": {}}),
    ):
        gw.telegram.queue.append(item)
        r = await gw.internal.post("/internal/v1/messages", json=body(), headers=auth(gw))
        assert r.status_code == 502 and r.json()["details"]["permanent"] is False, item


async def test_token_never_leaks_to_logs_or_responses(gw) -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter("telegram-bot-gateway"))
    root = logging.getLogger()
    root.addHandler(handler)
    old_level = root.level
    root.setLevel(logging.DEBUG)
    try:
        gw.telegram.queue.append(
            (400, {"ok": False, "error_code": 400, "description": f"Bad Request: token {TOKEN} is weird"})
        )
        r = await gw.internal.post("/internal/v1/messages", json=body(), headers=auth(gw))
        gw.telegram.queue.append(
            httpx.ConnectError(f"cannot connect to https://tg.test/bot{TOKEN}/sendMessage")
        )
        r2 = await gw.internal.post("/internal/v1/messages", json=body(), headers=auth(gw))
        ok = await gw.internal.post("/internal/v1/messages", json=body(), headers=auth(gw))
        assert ok.status_code == 200
    finally:
        root.removeHandler(handler)
        root.setLevel(old_level)
    logs = stream.getvalue()
    assert logs, "ожидались записи журнала"
    assert TOKEN not in logs and TOKEN.split(":")[1] not in logs
    assert TOKEN not in r.text and TOKEN not in r2.text
    assert "Поддержка ответила" not in logs  # текст сообщения не логируется
    assert logging.getLogger("httpx").disabled and logging.getLogger("httpcore").disabled


async def test_client_scrubs_token_from_descriptions() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401, json={"ok": False, "error_code": 401, "description": f"Unauthorized {TOKEN}"}
        )

    client = TelegramClient(TOKEN, api_base="https://tg.test", transport=httpx.MockTransport(handler))
    try:
        await client.call("getMe")
    except Exception as exc:
        assert TOKEN not in str(exc) and TOKEN not in getattr(exc, "description", "")
        assert getattr(exc, "status", None) == 401
    else:
        raise AssertionError("ожидалась ошибка")
    finally:
        await client.aclose()
    empty = TelegramClient("", api_base="https://tg.test", transport=httpx.MockTransport(handler))
    try:
        await empty.call("getMe")
    except Exception as exc:
        assert getattr(exc, "status", None) == 401
    finally:
        await empty.aclose()
