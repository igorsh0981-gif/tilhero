"""Адресация и имена — identity-consent (кэш Redis 5 мин, сброс событиями — consumers.py):

- `GET /internal/v1/users/{id}/delivery` → DeliveryInfo (INTERNAL_API §1): для детского профиля адресат — опекун
  (его Telegram ID и его блокировка бота), язык, категории, тихие часы, часовой пояс, возраст;
- `GET /internal/v1/users/{id}/public` → имя пригласившего / принявшего / нового участника семьи.

Telegram ID и имена — PII: живут только в кэше Redis (TTL), в логи не попадают; в журнал (центр) попадает только
отрисованный текст, которому имена разрешены §4.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict

from tilhero_common.app import Runtime
from tilhero_common.http_client import UpstreamError
from tilhero_notifications.domain.policy import KID_BANDS, Recipient

log = logging.getLogger("tilhero.notifications.delivery")


class QuietHours(BaseModel):
    model_config = ConfigDict(extra="ignore")
    start: str
    end: str


class DeliveryInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    user_id: uuid.UUID | None = None
    kind: Literal["account", "child"] = "account"
    recipient_telegram_user_id: int | None
    recipient_is_guardian: bool = False
    learner_display_name: str | None = None
    locale: str
    age_band: str | None = None
    is_minor: bool = False
    notifications_enabled: bool
    categories: list[str]
    quiet_hours: QuietHours | None = None
    timezone: str | None = None
    status: str

    @property
    def is_kid(self) -> bool:
        """Дети 6–13 (детский профиль у родителя): адресат — опекун, окно 08:00–20:00, мягкие тексты."""
        return self.kind == "child" or (self.is_minor and self.age_band in KID_BANDS)

    def recipient(self) -> Recipient:
        return Recipient(
            status=self.status,
            categories=frozenset(self.categories),
            notifications_enabled=self.notifications_enabled,
            quiet_hours=(self.quiet_hours.start, self.quiet_hours.end) if self.quiet_hours else None,
            timezone=self.timezone,
            is_kid=self.is_kid,
            has_address=bool(self.recipient_telegram_user_id and self.recipient_telegram_user_id > 0),
        )


class PublicUser(BaseModel):
    model_config = ConfigDict(extra="ignore")

    user_id: uuid.UUID | None = None
    display_name: str | None = None
    kind: str | None = None
    status: str = "ACTIVE"


def cache_key(prefix: str, kind: str, user_id: uuid.UUID | str) -> str:
    return f"{prefix}:{kind}:{user_id}"


async def _cached_get(
    rt: Runtime, *, prefix: str, ttl: int, kind: str, user_id: uuid.UUID, path: str
) -> dict[str, object] | None:
    """None — пользователь удалён/не найден (404). Прочие ошибки identity-consent пробрасываются (повтор позже).
    Сбой Redis не мешает доставке: идём в identity-consent напрямую."""
    key = cache_key(prefix, kind, user_id)
    if rt.redis is not None:
        try:
            cached = await rt.redis.get(key)
            if cached:
                data = json.loads(cached)
                return data if isinstance(data, dict) else None
        except Exception as exc:
            log.warning("cache read failed", extra={"cache": kind, "error_type": type(exc).__name__})
    try:
        data = await rt.client("identity-consent").get(path)
    except UpstreamError as exc:
        if exc.status == 404:
            return None
        raise
    if not isinstance(data, dict):
        raise ValueError("unexpected identity-consent response")
    if rt.redis is not None:
        try:
            await rt.redis.set(key, json.dumps(data), ex=ttl)
        except Exception as exc:
            log.warning("cache write failed", extra={"cache": kind, "error_type": type(exc).__name__})
    return data


async def get_delivery(rt: Runtime, *, prefix: str, ttl: int, user_id: uuid.UUID) -> DeliveryInfo | None:
    data = await _cached_get(
        rt, prefix=prefix, ttl=ttl, kind="delivery", user_id=user_id, path=f"/internal/v1/users/{user_id}/delivery"
    )
    return DeliveryInfo.model_validate(data) if data is not None else None


async def get_public(rt: Runtime, *, prefix: str, ttl: int, user_id: uuid.UUID) -> PublicUser | None:
    data = await _cached_get(
        rt, prefix=prefix, ttl=ttl, kind="public", user_id=user_id, path=f"/internal/v1/users/{user_id}/public"
    )
    return PublicUser.model_validate(data) if data is not None else None


async def forget(rt: Runtime, *, prefix: str, user_id: uuid.UUID | str) -> None:
    if rt.redis is None:
        return
    try:
        await rt.redis.delete(cache_key(prefix, "delivery", user_id), cache_key(prefix, "public", user_id))
    except Exception as exc:
        log.warning("cache delete failed", extra={"error_type": type(exc).__name__})
