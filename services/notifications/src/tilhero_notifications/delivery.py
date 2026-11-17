"""Адрес и язык доставки — identity-consent GET /internal/v1/users/{id}/delivery (кэш Redis 5 мин).

Telegram ID — PII: хранится только в кэше Redis (TTL), в логи и журнал уведомлений не попадает.
"""

from __future__ import annotations

import json
import logging
import uuid

from pydantic import BaseModel, ConfigDict

from tilhero_common.app import Runtime
from tilhero_common.http_client import UpstreamError

log = logging.getLogger("tilhero.notifications.delivery")


class QuietHours(BaseModel):
    model_config = ConfigDict(extra="ignore")
    start: str
    end: str


class DeliveryInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    telegram_user_id: int
    locale: str = "ru"
    notifications_enabled: bool = True
    quiet_hours: QuietHours | None = None
    digest_time: str | None = None  # "HH:MM" локальное (спринт 6); нет/некорректно → DIGEST_DEFAULT_TIME
    timezone: str | None = None
    status: str = "ACTIVE"


def cache_key(prefix: str, user_id: uuid.UUID | str) -> str:
    return f"{prefix}:delivery:{user_id}"


async def get_delivery(rt: Runtime, *, prefix: str, ttl: int, user_id: uuid.UUID) -> DeliveryInfo | None:
    """None — пользователь удалён (404). Прочие ошибки identity-consent пробрасываются (повтор позже).
    Сбой Redis не мешает доставке: идём в identity-consent напрямую."""
    key = cache_key(prefix, user_id)
    if rt.redis is not None:
        try:
            cached = await rt.redis.get(key)
            if cached:
                return DeliveryInfo.model_validate_json(cached)
        except Exception as exc:
            log.warning("delivery cache read failed", extra={"error_type": type(exc).__name__})
    try:
        data = await rt.client("identity-consent").get(f"/internal/v1/users/{user_id}/delivery")
    except UpstreamError as exc:
        if exc.status == 404:
            return None
        raise
    info = DeliveryInfo.model_validate(data)
    if rt.redis is not None:
        try:
            await rt.redis.set(key, json.dumps(info.model_dump(mode="json")), ex=ttl)
        except Exception as exc:
            log.warning("delivery cache write failed", extra={"error_type": type(exc).__name__})
    return info


async def forget_delivery(rt: Runtime, *, prefix: str, user_id: uuid.UUID | str) -> None:
    if rt.redis is None:
        return
    try:
        await rt.redis.delete(cache_key(prefix, user_id))
    except Exception as exc:
        log.warning("delivery cache delete failed", extra={"error_type": type(exc).__name__})
