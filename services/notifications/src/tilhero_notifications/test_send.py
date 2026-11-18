"""Тестовая отправка шаблона или рассылки (AT-21): только в чаты из ADMIN_TEST_CHAT_IDS, выбор по индексу —
ученикам никогда. Через bot-gateway, «[ТЕСТ] » в заголовке, без записи в центр уведомлений и без лимитов ученика;
≤ TEST_SENDS_PER_MINUTE (10) в минуту на сотрудника (Redis). Chat id не попадают ни в ответ (только маска), ни в
логи, ни в аудит (только индекс)."""

from __future__ import annotations

import logging
import uuid
from dataclasses import replace
from typing import Any, cast

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, too_many, unavailable, unprocessable
from tilhero_common.http_client import UpstreamError
from tilhero_common.redis_tools import rate_limit
from tilhero_notifications.settings import Settings
from tilhero_notifications.templates import Rendered

log = logging.getLogger("tilhero.notifications.test_send")
PREFIX = "[ТЕСТ] "


def _settings(rt: Runtime) -> Settings:
    return cast(Settings, rt.settings)


def mask(chat_id: int) -> str:
    digits = str(chat_id)
    return "••••" + (digits[-4:] if len(digits) > 6 else "")


def recipients(rt: Runtime) -> list[dict[str, Any]]:
    return [
        {"index": i, "label": f"Тестовый чат {i + 1} ({mask(chat)})"}
        for i, chat in enumerate(_settings(rt).test_chat_ids)
    ]


def chat_for(rt: Runtime, index: int) -> int:
    chats = _settings(rt).test_chat_ids
    if isinstance(index, bool) or not 0 <= index < len(chats):
        raise unprocessable("TEST_RECIPIENT_NOT_ALLOWED", "Тестовая отправка — только в тестовые чаты из настройки",
                            {"recipient": index})
    return chats[index]


async def enforce_rate(rt: Runtime, actor_id: str) -> None:
    s = _settings(rt)
    if rt.redis is None:
        raise unavailable("RATE_LIMIT_UNAVAILABLE", "Тестовая отправка временно недоступна")
    try:
        result = await rate_limit(rt.redis, f"{s.redis_key_prefix}:test-send:{actor_id}", s.test_sends_per_minute, 60)
    except Exception as exc:
        log.warning("test send rate limit unavailable", extra={"error_type": type(exc).__name__})
        raise unavailable("RATE_LIMIT_UNAVAILABLE", "Тестовая отправка временно недоступна") from None
    if not result.allowed:
        raise too_many("RATE_LIMITED", f"Не больше {s.test_sends_per_minute} тестов в минуту",
                       max(result.reset_seconds, 1))


async def send(rt: Runtime, chat_id: int, rendered: Rendered) -> dict[str, Any]:
    """→ TestSendResult {sent, delivery_id, error}. Ошибка бота — sent=false с кодом (без исключения)."""
    test = replace(rendered, title=PREFIX + rendered.title, html=None)
    delivery_id = str(uuid.uuid4())
    body = {
        "telegram_user_id": chat_id,
        "text": test.telegram_text(),
        "buttons": test.buttons() or None,
        "disable_notification": False,
        "idempotency_key": delivery_id,
    }
    try:
        await rt.client("telegram-bot-gateway").post("/internal/v1/messages", json=body, idempotency_key=delivery_id)
    except UpstreamError as exc:
        log.info("test send rejected", extra={"error_code": exc.code, "delivery_id": delivery_id})
        return {"sent": False, "delivery_id": None, "error": exc.code}
    except ApiError as exc:  # pragma: no cover - клиент сервисов бросает UpstreamError
        return {"sent": False, "delivery_id": None, "error": exc.code}
    except Exception as exc:
        log.warning("test send failed", extra={"error_type": type(exc).__name__, "delivery_id": delivery_id})
        return {"sent": False, "delivery_id": None, "error": "GATEWAY_UNAVAILABLE"}
    log.info("test send delivered", extra={"delivery_id": delivery_id})
    return {"sent": True, "delivery_id": delivery_id, "error": None}
