"""Общие зависимости API social: аккаунт из токена, часы, Idempotency-Key, вход планировщика."""

from __future__ import annotations

import hmac
import logging
import re
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import cast

from fastapi import Depends, Request

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, unauthorized, unprocessable
from tilhero_common.internal_auth import HEADER, Actor, InternalAuth, Principal
from tilhero_social.domain import invites as inv
from tilhero_social.domain.access import Me
from tilhero_social.domain.common import AGE_BANDS, step_up_required
from tilhero_social.identity import IdentityGateway, Person
from tilhero_social.settings import Settings

log = logging.getLogger("tilhero.social.api")

# Вызывающие (INTERNAL_API §3): только telegram-bff; sub = аккаунт (не детский профиль).
CLIENT_CALLERS = {"telegram-bff"}
client_auth = InternalAuth(CLIENT_CALLERS)
no_service = InternalAuth(set())  # внутренний JWT любого сервиса на входе планировщика → 403 CALLER_NOT_ALLOWED
# спринт 7: связь учеников и member_id → user_id — только домены лиг/дуэлей и парных уроков (§1.2)
domain_auth = InternalAuth({"gamification", "lessons"})
# админ-API — только admin-bff с actor (права — в домене)
staff_auth = InternalAuth({"admin-bff"})
STEP_UP_HEADER = "x-step-up"

_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,128}$")


def settings_of(request: Request) -> Settings:
    return cast(Settings, request.app.state.runtime.settings)


def clock_of(request: Request) -> Callable[[], datetime]:
    """Часы сервиса (UTC). Тесты подменяют app.state.clock (сроки приглашений, напоминание через 24 ч)."""
    return cast(Callable[[], datetime], getattr(request.app.state, "clock", None) or (lambda: datetime.now(UTC)))


def gateway_of(request: Request) -> IdentityGateway:
    return cast(IdentityGateway, request.app.state.identity)


def current_user(principal: Principal = Depends(client_auth)) -> uuid.UUID:
    """user_id — только из внутреннего токена (CONVENTIONS §2, защита от IDOR)."""
    try:
        return uuid.UUID(principal.user_id)
    except ValueError:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from None


def _uuid_claim(value: object) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from None


def current_learner(principal: Principal = Depends(client_auth)) -> Me:
    """Спринт 7: социальное — у активного ученика (claim `lrn`, без него — `sub`); `age_band` — его полоса. Только из
    внутреннего токена (защита от IDOR)."""
    account = _uuid_claim(principal.user_id)
    lrn = principal.claims.get("lrn")
    learner = _uuid_claim(lrn) if lrn not in (None, "") else account
    band = principal.claims.get("age_band")
    return Me(user_id=learner, account_id=account, age_band=band if band in AGE_BANDS else None)


async def person_of(rt: Runtime, gateway: IdentityGateway, user_id: uuid.UUID) -> Person | None:
    """Профиль identity-consent (вне транзакций БД) + согласие родителя из проекции. None — не найден."""
    pub = await gateway.public(user_id)
    async with rt.transaction() as session:
        return await inv.person_for(session, user_id, pub)


def require_staff(principal: Principal, permission: str, request: Request | None = None, *,
                  step_up: bool = False) -> Actor:
    """Право сотрудника в домене (защита в глубину); step-up — admin-bff проверил свежесть MFA и передал
    `X-Step-Up: ok` (или claim `step_up: true`)."""
    actor = principal.require_permission(permission)
    if step_up:
        header = (request.headers.get(STEP_UP_HEADER) if request is not None else None) or ""
        if header.strip().lower() != "ok" and principal.claims.get("step_up") is not True:
            raise step_up_required(permission)
    return actor


def idempotency_key(value: str | None) -> str:
    if value is None:
        raise ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key")
    if not _IDEMPOTENCY_RE.match(value):
        raise unprocessable("IDEMPOTENCY_KEY_INVALID",
                            "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)")
    return value


async def scheduler_only(request: Request) -> str:
    """`Authorization: Bearer <SCHEDULER_TOKEN>` (n8n): сравнение за постоянное время; пустой токен в настройках
    выключает вход. Внутренний JWT сервиса → 403 CALLER_NOT_ALLOWED. Токен не логируется."""
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
