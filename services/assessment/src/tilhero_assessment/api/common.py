"""Общие зависимости API assessment: вызывающие, ученик из токена, часы, Idempotency-Key, шлюзы catalog и ИИ."""

from __future__ import annotations

import hmac
import logging
import re
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import cast

from fastapi import Depends, Request

from tilhero_assessment.content import ContentGateway
from tilhero_assessment.evaluator import EvaluatorGateway
from tilhero_assessment.settings import Settings
from tilhero_common.errors import ApiError, unauthorized, unprocessable
from tilhero_common.internal_auth import HEADER, InternalAuth, Principal

log = logging.getLogger("tilhero.assessment.api")

# Оценка — только lessons (sub = ученик `lrn`); оценки и апелляции ученика — только telegram-bff (sub = `lrn`);
# админка — только admin-bff с actor (права — в домене).
lessons_auth = InternalAuth({"lessons"})
client_auth = InternalAuth({"telegram-bff"})
staff_auth = InternalAuth({"admin-bff"})
# Вход планировщика (n8n): внутренний JWT любого сервиса → 403 CALLER_NOT_ALLOWED
no_service = InternalAuth(set())

_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,128}$")


def settings_of(request: Request) -> Settings:
    return cast(Settings, request.app.state.runtime.settings)


def clock_of(request: Request) -> Callable[[], datetime]:
    """Часы сервиса (UTC). Тесты подменяют app.state.clock (окно апелляции 14 дней)."""
    return cast(Callable[[], datetime], getattr(request.app.state, "clock", None) or (lambda: datetime.now(UTC)))


def content_of(request: Request) -> ContentGateway:
    return cast(ContentGateway, request.app.state.content)


def evaluator_of(request: Request) -> EvaluatorGateway:
    return cast(EvaluatorGateway, request.app.state.evaluator)


def learner_of(principal: Principal) -> uuid.UUID:
    """user_id — только из внутреннего токена (CONVENTIONS §2, защита от IDOR)."""
    try:
        return uuid.UUID(principal.user_id)
    except ValueError:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from None


def current_learner(principal: Principal = Depends(client_auth)) -> uuid.UUID:
    return learner_of(principal)


def idempotency_key(value: str | None, *, required: bool = True) -> str | None:
    if value is None:
        if required:
            raise ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key")
        return None
    if not _IDEMPOTENCY_RE.match(value):
        raise unprocessable("IDEMPOTENCY_KEY_INVALID",
                            "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)")
    return value


def key_reused() -> ApiError:
    return unprocessable("IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными")


async def scheduler_only(request: Request) -> str:
    """`Authorization: Bearer <SCHEDULER_TOKEN>` (n8n `assessment-tick`): сравнение за постоянное время; пустой токен в
    настройках выключает вход. Внутренний JWT сервиса → 403 CALLER_NOT_ALLOWED (вызывающий — только планировщик)."""
    expected = settings_of(request).scheduler_token.get_secret_value()
    scheme, _, presented = (request.headers.get("authorization") or "").partition(" ")
    presented = presented.strip()
    if expected and presented and scheme.lower() == "bearer" and hmac.compare_digest(
            presented.encode("utf-8"), expected.encode("utf-8")):
        return "scheduler"
    if request.headers.get(HEADER) is not None and not request.headers.get("authorization"):
        await no_service(request)
    log.warning("scheduler auth rejected",
                extra={"reason": "SCHEDULER_TOKEN_INVALID" if expected else "SCHEDULER_AUTH_DISABLED"})
    raise unauthorized("SCHEDULER_TOKEN_INVALID", "Неверный токен планировщика")
