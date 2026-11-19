"""Общие зависимости API learning-plan: ученик из токена, часы, Idempotency-Key, вход планировщика."""

from __future__ import annotations

import hmac
import logging
import re
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import cast

from fastapi import Depends, Request

from tilhero_common.errors import ApiError, unauthorized, unprocessable
from tilhero_common.internal_auth import HEADER, InternalAuth, Principal
from tilhero_learning_plan.settings import Settings

log = logging.getLogger("tilhero.learning_plan.api")

# Вызывающие клиентского API (INTERNAL_API §2): только telegram-bff; sub = ученик (lrn сессии BFF).
CLIENT_CALLERS = {"telegram-bff"}
client_auth = InternalAuth(CLIENT_CALLERS)
# Траектория (спринт 4, INTERNAL_API §0): ещё lessons — план и следующий урок для итогов урока (sub = ученик)
TRAJECTORY_CALLERS = {"telegram-bff", "lessons"}
trajectory_auth = InternalAuth(TRAJECTORY_CALLERS)
no_service = InternalAuth(set())  # внутренний JWT любого сервиса на входе планировщика → 403 CALLER_NOT_ALLOWED

_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,128}$")


def settings_of(request: Request) -> Settings:
    return cast(Settings, request.app.state.runtime.settings)


def clock_of(request: Request) -> Callable[[], datetime]:
    """Часы сервиса (UTC). Тесты подменяют app.state.clock, чтобы проверять слоты и полночь детерминированно."""
    return cast(Callable[[], datetime], getattr(request.app.state, "clock", None) or (lambda: datetime.now(UTC)))


def _subject(principal: Principal) -> uuid.UUID:
    try:
        return uuid.UUID(principal.user_id)
    except ValueError:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from None


def current_user(principal: Principal = Depends(client_auth)) -> uuid.UUID:
    """user_id — только из внутреннего токена (CONVENTIONS §2, защита от IDOR)."""
    return _subject(principal)


def trajectory_user(principal: Principal = Depends(trajectory_auth)) -> uuid.UUID:
    """Ученик траектории — только из `sub` токена telegram-bff или lessons."""
    return _subject(principal)


def idempotency_key(value: str | None) -> str:
    if value is None:
        raise ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key")
    if not _IDEMPOTENCY_RE.match(value):
        raise unprocessable("IDEMPOTENCY_KEY_INVALID",
                            "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)")
    return value


async def scheduler_only(request: Request) -> str:
    """`Authorization: Bearer <SCHEDULER_TOKEN>` (n8n): сравнение за постоянное время; пустой токен в настройках
    выключает вход. Внутренний JWT сервиса → 403 CALLER_NOT_ALLOWED (вызывающий — только планировщик).
    Токен не логируется."""
    expected = settings_of(request).scheduler_token.get_secret_value()
    scheme, _, presented = (request.headers.get("authorization") or "").partition(" ")
    presented = presented.strip()
    if (
        expected
        and presented
        and scheme.lower() == "bearer"
        and hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8"))
    ):
        return "scheduler"
    if request.headers.get(HEADER) is not None and not request.headers.get("authorization"):
        await no_service(request)
    log.warning("scheduler auth rejected",
                extra={"reason": "SCHEDULER_TOKEN_INVALID" if expected else "SCHEDULER_AUTH_DISABLED"})
    raise unauthorized("SCHEDULER_TOKEN_INVALID", "Неверный токен планировщика")
