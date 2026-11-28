"""Зависимости API: разрешённые вызывающие (явно, CONVENTIONS §2, INTERNAL_API §1 и спринта 2 §3) и user_id только из
токена."""

from __future__ import annotations

import re
import uuid

from fastapi import Depends, Header, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import forbidden, unauthorized, unprocessable
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_identity.admin import AdminDirectory
from tilhero_identity.audience import Audience
from tilhero_identity.service import IdentityService

telegram_bff = InternalAuth({"telegram-bff"})
notifications_only = InternalAuth({"notifications"})
bot_gateway_only = InternalAuth({"telegram-bot-gateway"})
# /public: social (семья, приглашения), notifications (имена), спринт 5 — memory (цель voice_recording),
# спринт 7 — lessons (согласие на голос в уроке вдвоём)
public_profile_callers = InternalAuth({"social", "notifications", "memory", "lessons"})
# Админ-контур (спринт 2): read-модель user-admin сверяется без контекста сотрудника; раскрытие Telegram ID — только
# admin-bff с actor и правом users.sensitive.read.
user_admin_only = InternalAuth({"user-admin"})
admin_bff_only = InternalAuth({"admin-bff"})
# Спринт 7 (Н1): выгрузка профилей для начальной загрузки проекции — gamification; спринт 8 — + billing (проекция
# learners с guardian_user_id)
profile_export_callers = InternalAuth({"gamification", "billing"})
# Спринт 8 (INTERNAL_API §9): Telegram ID → аккаунт — bot-gateway (Stars) и telegram-bff (вход на сайт оплаты);
# аккаунт → Telegram ID — только bot-gateway
telegram_account_callers = InternalAuth({"telegram-bot-gateway", "telegram-bff"})


def no_user_context(principal: Principal) -> Principal:
    """Служебный вызов без контекста ученика: `sub` здесь лишний (цель запроса — только путь или фильтры), а actor
    принимается только от admin-bff (internal_auth) — для остальных он не доходит сюда."""
    if principal.subject:
        raise forbidden("CALLER_CONTEXT_NOT_ALLOWED", "Вызов допускается только без контекста пользователя")
    return principal


def user_admin_service_call(principal: Principal = Depends(user_admin_only)) -> Principal:
    return no_user_context(principal)


def notifications_service_call(principal: Principal = Depends(notifications_only)) -> Principal:
    return no_user_context(principal)


def profile_export_service_call(principal: Principal = Depends(profile_export_callers)) -> Principal:
    return no_user_context(principal)


def telegram_account_service_call(principal: Principal = Depends(telegram_account_callers)) -> Principal:
    return no_user_context(principal)


def bot_gateway_service_call(principal: Principal = Depends(bot_gateway_only)) -> Principal:
    return no_user_context(principal)

_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,128}$")


def current_user_id(principal: Principal = Depends(telegram_bff)) -> uuid.UUID:
    """sub внутреннего токена — единственный источник user_id (защита от IDOR). Для identity `sub` — аккаунт."""
    try:
        return uuid.UUID(principal.user_id)
    except ValueError as exc:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from exc


def idempotency_key(value: str | None = Header(default=None, alias="Idempotency-Key")) -> str | None:
    """Необязательный Idempotency-Key создающих команд: повтор с тем же ключом — тот же результат."""
    if value is None:
        return None
    if not _IDEMPOTENCY_RE.match(value):
        raise unprocessable("IDEMPOTENCY_KEY_INVALID",
                            "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)")
    return value


def get_service(request: Request, rt: Runtime = Depends(get_runtime)) -> IdentityService:
    """Часы сервиса (UTC): тесты подменяют `app.state.clock` (срок ожидающего сброса кода родителя)."""
    return IdentityService(rt, clock=getattr(request.app.state, "clock", None))


def get_admin(request: Request, rt: Runtime = Depends(get_runtime)) -> AdminDirectory:
    return AdminDirectory(rt, clock=getattr(request.app.state, "clock", None))


def get_audience(request: Request, rt: Runtime = Depends(get_runtime)) -> Audience:
    return Audience(rt, clock=getattr(request.app.state, "clock", None))
