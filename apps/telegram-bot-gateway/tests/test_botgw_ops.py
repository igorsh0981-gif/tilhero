"""Спринт 8 (§6): POST /internal/v1/ops-messages — чат операторов из env, лимит, идемпотентность, ошибки Telegram;
my_chat_member в группе → INFO-лог `ops chat candidate chat_id=<id>`."""

from __future__ import annotations

import io
import json
import logging
import uuid
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from botgw_testkit import make_settings
from conftest import ADMIN_WEB, OPS_CHAT_ID

from tilhero_common.logging import JsonFormatter
from tilhero_common.testing import internal_headers

URL = "/internal/v1/ops-messages"
TEXT = "🔴 Поставщик travelpayouts: недоступен (было: работает).\nОшибок 62%, p95 4100 мс, вызовов 50."


def body(**kw) -> dict:
    base = {
        "text": TEXT,
        "button": {"text": "Открыть мониторинг", "url": f"{ADMIN_WEB}/monitoring?provider=travelpayouts"},
        "dedup_key": f"ops:{uuid.uuid4()}:open:1",
    }
    base.update(kw)
    return base


def auth(env, issuer: str = "notifications") -> dict:
    return internal_headers(env.settings, issuer=issuer)


@contextmanager
def captured_logs() -> Iterator[io.StringIO]:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter("telegram-bot-gateway"))
    root = logging.getLogger()
    root.addHandler(handler)
    old_level = root.level
    root.setLevel(logging.DEBUG)
    try:
        yield stream
    finally:
        root.removeHandler(handler)
        root.setLevel(old_level)


def records(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


async def test_ops_message_sent_to_env_chat_as_plain_text(ops_gw) -> None:
    html = body(text="<b>не разметка</b> & <i>текст</i>", button=None)
    r = await ops_gw.internal.post(URL, json=html, headers=auth(ops_gw))
    assert r.status_code == 200 and r.json() == {"message_id": 501}
    [sent] = ops_gw.telegram.sent()
    assert sent == {
        "chat_id": OPS_CHAT_ID,
        "text": "<b>не разметка</b> & <i>текст</i>",
        "link_preview_options": {"is_disabled": True},
    }  # без parse_mode: Telegram показывает текст как есть
    r = await ops_gw.internal.post(URL, json=body(), headers=auth(ops_gw))
    assert r.status_code == 200
    assert ops_gw.telegram.sent()[-1]["reply_markup"] == {
        "inline_keyboard": [[{"text": "Открыть мониторинг", "url": f"{ADMIN_WEB}/monitoring?provider=travelpayouts"}]]
    }


async def test_ops_message_idempotent_by_dedup_key(ops_gw) -> None:
    b = body()
    first = await ops_gw.internal.post(URL, json=b, headers=auth(ops_gw))
    again = await ops_gw.internal.post(URL, json=b, headers=auth(ops_gw))
    assert first.json() == again.json() and again.headers.get("Idempotent-Replayed") == "true"
    assert len(ops_gw.telegram.sent()) == 1
    reused = await ops_gw.internal.post(URL, json={**b, "text": "другое"}, headers=auth(ops_gw))
    assert reused.status_code == 422 and reused.json()["code"] == "IDEMPOTENCY_KEY_REUSED"


async def test_ops_chat_not_configured(gw) -> None:
    r = await gw.internal.post(URL, json=body(), headers=auth(gw))
    assert r.status_code == 409 and r.json()["code"] == "OPS_CHAT_NOT_CONFIGURED"
    assert gw.telegram.calls == []


async def test_ops_messages_caller_and_validation(ops_gw) -> None:
    r = await ops_gw.internal.post(URL, json=body(), headers=auth(ops_gw, issuer="admin-bff"))
    assert r.status_code == 403
    r = await ops_gw.internal.post(URL, json=body(), headers={})
    assert r.status_code == 401
    bad = [
        body(text=""),
        body(text="x" * 3501),
        body(dedup_key="short"),
        body(button={"text": "x" * 41, "url": f"{ADMIN_WEB}/monitoring"}),
        body(button={"text": "Открыть", "url": "http://admin.tilhero.test/monitoring"}),
        body(button={"text": "Открыть", "url": "https://evil.test/monitoring"}),
        body(button={"text": "Открыть", "url": "https://admin.tilhero.test.evil.test/x"}),
        {**body(), "chat_id": 1},  # чат выбирает только env
    ]
    for b in bad:
        r = await ops_gw.internal.post(URL, json=b, headers=auth(ops_gw))
        assert r.status_code == 422, b
    assert ops_gw.telegram.calls == []
    ok = await ops_gw.internal.post(URL, json=body(text="x" * 3500), headers=auth(ops_gw))
    assert ok.status_code == 200
    # публичный порт этого маршрута не знает
    public = await ops_gw.client.post(URL, json=body(), headers=auth(ops_gw))
    assert public.status_code == 404


async def test_ops_rate_limit(ops_gw) -> None:
    keys = [body() for _ in range(3)]
    for b in keys:
        assert (await ops_gw.internal.post(URL, json=b, headers=auth(ops_gw))).status_code == 200
    over = body()
    r = await ops_gw.internal.post(URL, json=over, headers=auth(ops_gw))
    assert r.status_code == 429 and r.json()["code"] == "RATE_LIMITED"
    assert 1 <= int(r.headers["Retry-After"]) <= 60
    # повтор уже отправленного не считается и не упирается в лимит; ключ отклонённого свободен
    replay = await ops_gw.internal.post(URL, json=keys[0], headers=auth(ops_gw))
    assert replay.status_code == 200 and replay.headers.get("Idempotent-Replayed") == "true"
    assert len(ops_gw.telegram.sent()) == 3
    r = await ops_gw.internal.post(URL, json=over, headers=auth(ops_gw))
    assert r.status_code == 429 and r.json()["code"] == "RATE_LIMITED"


@pytest.mark.parametrize(
    ("status", "description"),
    [
        (403, "Forbidden: bot was kicked from the supergroup chat"),
        (403, "Forbidden: bot is not a member of the group chat"),
        (400, "Bad Request: chat not found"),
        (400, "Bad Request: group chat was upgraded to a supergroup chat"),
    ],
)
async def test_ops_chat_unavailable(ops_gw, status: int, description: str) -> None:
    ops_gw.telegram.queue.append((status, {"ok": False, "error_code": status, "description": description}))
    b = body()
    with captured_logs() as stream:
        r = await ops_gw.internal.post(URL, json=b, headers=auth(ops_gw))
    assert r.status_code == 409 and r.json()["code"] == "OPS_CHAT_UNAVAILABLE"
    [warn] = [rec for rec in records(stream) if rec["level"] == "warning"]
    assert warn["msg"].startswith("ops chat unavailable") and warn["telegram_status"] == status
    assert str(OPS_CHAT_ID) not in stream.getvalue() and TEXT[:20] not in stream.getvalue()
    # ключ освобождён: после исправления чата повтор отправит заново
    assert (await ops_gw.internal.post(URL, json=b, headers=auth(ops_gw))).status_code == 200


async def test_ops_telegram_errors(ops_gw) -> None:
    ops_gw.telegram.queue.append(
        (429, {"ok": False, "error_code": 429, "description": "Too Many Requests", "parameters": {"retry_after": 9}})
    )
    r = await ops_gw.internal.post(URL, json=body(), headers=auth(ops_gw))
    assert r.status_code == 429 and r.json()["code"] == "TELEGRAM_RATE_LIMITED"
    assert r.headers["Retry-After"] == "9" and r.json()["details"]["retry_after"] == 9
    ops_gw.telegram.queue.append((400, {"ok": False, "error_code": 400, "description": "Bad Request: x"}))
    r = await ops_gw.internal.post(URL, json=body(), headers=auth(ops_gw))
    assert r.status_code == 502 and r.json()["details"]["permanent"] is True
    ops_gw.telegram.queue.append((500, {"ok": False, "error_code": 500, "description": "Internal"}))
    r = await ops_gw.internal.post(URL, json=body(), headers=auth(ops_gw))
    assert r.status_code == 502 and r.json()["details"]["permanent"] is False


async def test_ops_button_dropped_without_admin_web_url(ops_gw) -> None:
    ops_gw.settings.admin_web_url = None
    with captured_logs() as stream:
        r = await ops_gw.internal.post(URL, json=body(), headers=auth(ops_gw))
    assert r.status_code == 200 and "reply_markup" not in ops_gw.telegram.sent()[-1]
    assert any(rec["msg"].startswith("ops button dropped") for rec in records(stream))


def test_ops_settings() -> None:
    s = make_settings("x", ops_alert_chat_id="", admin_web_url="")
    assert s.ops_alert_chat_id is None and s.admin_web_url is None and s.admin_web_host is None
    s = make_settings("x", ops_alert_chat_id=" -100777 ", admin_web_url="https://Admin.Example.test/")
    assert s.ops_alert_chat_id == -100777 and s.admin_web_host == "admin.example.test"
    assert s.ops_messages_per_minute == 20
    assert make_settings("x", admin_web_url="http://localhost:5174").admin_web_host is None
    with pytest.raises(ValueError, match="OPS_ALERT_CHAT_ID"):
        make_settings("x", ops_alert_chat_id="0")
    with pytest.raises(ValueError):
        make_settings("x", ops_alert_chat_id="ops-chat")


def member_update(env, chat_type: str, status: str, chat_id: int = OPS_CHAT_ID) -> dict:
    return {
        "update_id": env.next_update_id(),
        "my_chat_member": {
            "chat": {"id": chat_id, "type": chat_type, "title": "TilHero ops"},
            "from": {"id": 918273645, "is_bot": False, "first_name": "И"},
            "date": 1_760_000_000,
            "old_chat_member": {"status": "left", "user": {"id": 1, "is_bot": True}},
            "new_chat_member": {"status": status, "user": {"id": 1, "is_bot": True}},
        },
    }


async def test_bot_added_to_group_logs_ops_chat_candidate(gw) -> None:
    with captured_logs() as stream:
        for chat_type, status in [
            ("supergroup", "administrator"),
            ("group", "member"),
            ("group", "left"),
            ("supergroup", "kicked"),
        ]:
            r = await gw.webhook(member_update(gw, chat_type, status))
            assert r.status_code == 200 and r.json() == {"ok": True}
    candidates = [rec for rec in records(stream) if rec["msg"].startswith("ops chat candidate")]
    assert [rec["msg"] for rec in candidates] == [f"ops chat candidate chat_id={OPS_CHAT_ID} title='TilHero ops'"] * 2
    assert all(rec["level"] == "info" for rec in candidates)
    assert "918273645" not in stream.getvalue()  # id добавившего пользователя не пишется
    assert gw.identity.calls == []  # статус бота в identity-consent — только для личных чатов


# ---------------------------------------------------------------- спринт 9: кнопка «Runbook»

RUNBOOKS = "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/"


async def test_ops_message_with_runbook_button(ops_gw) -> None:
    rb = {"text": "Runbook", "url": RUNBOOKS + "offers.md#service-down"}
    r = await ops_gw.internal.post(URL, json=body(runbook_button=rb), headers=auth(ops_gw))
    assert r.status_code == 200, r.text
    assert ops_gw.telegram.sent()[-1]["reply_markup"] == {"inline_keyboard": [[
        {"text": "Открыть мониторинг", "url": f"{ADMIN_WEB}/monitoring?provider=travelpayouts"}, rb]]}
    # только Runbook (ADMIN_WEB_URL-кнопки нет)
    r = await ops_gw.internal.post(URL, json=body(button=None, runbook_button=rb), headers=auth(ops_gw))
    assert r.status_code == 200 and ops_gw.telegram.sent()[-1]["reply_markup"] == {"inline_keyboard": [[rb]]}
    # чужой адрес — 422, ничего не отправлено
    sent = len(ops_gw.telegram.sent())
    for url in ("https://evil.example/docs/runbooks/x.md", "https://github.com/other/tilhero/blob/main/docs/runbooks/x.md"):
        bad = body(runbook_button={"text": "Runbook", "url": url})
        r = await ops_gw.internal.post(URL, json=bad, headers=auth(ops_gw))
        assert r.status_code == 422, url
    assert len(ops_gw.telegram.sent()) == sent


# ---------------------------------------------------------------- Q10: без Redis — память процесса

@pytest.mark.parametrize("outage", ["none", "unreachable"])
async def test_ops_messages_without_redis_dedup_and_limit_in_process(ops_gw, outage: str) -> None:
    """Redis недоступен: оповещение операторам уходит (не 503), повтор того же dedup_key — тот же ответ без второго
    сообщения, другое тело — 422, лимит в минуту считается в памяти; после возврата Redis отправленное в простое не
    дублируется."""
    from redis.asyncio import Redis

    real = ops_gw.runtime.redis
    broken = Redis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.2)
    ops_gw.runtime.redis = None if outage == "none" else broken
    try:
        first = body()
        r = await ops_gw.internal.post(URL, json=first, headers=auth(ops_gw))
        assert r.status_code == 200 and r.json() == {"message_id": 501}
        again = await ops_gw.internal.post(URL, json=first, headers=auth(ops_gw))
        assert again.json() == r.json() and again.headers.get("Idempotent-Replayed") == "true"
        reused = await ops_gw.internal.post(URL, json={**first, "text": "другое"}, headers=auth(ops_gw))
        assert reused.status_code == 422 and reused.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
        for _ in range(2):
            assert (await ops_gw.internal.post(URL, json=body(), headers=auth(ops_gw))).status_code == 200
        over = await ops_gw.internal.post(URL, json=body(), headers=auth(ops_gw))
        assert over.status_code == 429 and over.json()["code"] == "RATE_LIMITED"
        assert len(ops_gw.telegram.sent()) == 3
    finally:
        ops_gw.runtime.redis = real
        await broken.aclose()
    # Redis вернулся: повтор оповещения, отправленного в простое, — из памяти, без второго сообщения
    back = await ops_gw.internal.post(URL, json=first, headers=auth(ops_gw))
    assert back.status_code == 200 and back.headers.get("Idempotent-Replayed") == "true"
    assert len(ops_gw.telegram.sent()) == 3
