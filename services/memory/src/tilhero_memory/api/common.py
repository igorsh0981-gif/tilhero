"""Общие зависимости API memory: ученик из токена, контекст, часы, Idempotency-Key, планировщик, сотрудник."""

from __future__ import annotations

import hmac
import logging
import re
import uuid
from datetime import datetime
from typing import cast

from fastapi import Depends, Query, Request

from tilhero_common.errors import ApiError, forbidden, unauthorized, unprocessable
from tilhero_common.internal_auth import HEADER, Actor, InternalAuth, Principal
from tilhero_memory.clients import CatalogGateway
from tilhero_memory.domain.common import AGE_BANDS
from tilhero_memory.domain.context import Ctx, now_of
from tilhero_memory.domain.learners import Learner
from tilhero_memory.settings import Settings

log = logging.getLogger("tilhero.memory.api")

# Ученик (INTERNAL_API §1.10): только telegram-bff; sub = аккаунт, claim lrn = активный ученик, age_band
client_auth = InternalAuth({"telegram-bff"})
# Admin API: только admin-bff с actor (права — в домене)
staff_auth = InternalAuth({"admin-bff"})
# Вход планировщика: внутренний JWT любого сервиса → 403 CALLER_NOT_ALLOWED
no_service = InternalAuth(set())

_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,128}$")
PAIR_PATTERN = r"^[a-z]{2,8}-[a-z]{2,8}$"


def settings_of(request: Request) -> Settings:
    return cast(Settings, request.app.state.runtime.settings)


def now(request: Request) -> datetime:
    return now_of(request.app.state.runtime)


def catalog_of(request: Request) -> CatalogGateway:
    return cast(CatalogGateway, request.app.state.catalog)


def _uuid_claim(value: object) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from None


def audience_param(audience: str | None = Query(
        default=None, pattern="^(kids|teens|adults)$",
        description="сегмент активного ученика от telegram-bff; детский профиль не понижается")) -> str | None:
    return audience


def locale_param(locale: str | None = Query(default=None, pattern="^(ru|uz)$",
                                            description="язык интерфейса ученика")) -> str | None:
    return locale


def pair_param(pair_id: str | None = Query(default=None, max_length=17, pattern=PAIR_PATTERN)) -> str | None:
    return pair_id


def current_learner(principal: Principal = Depends(client_auth), audience: str | None = Depends(audience_param),
                    locale: str | None = Depends(locale_param)) -> Learner:
    """Ученик — `lrn`, аккаунт — `sub`; только из внутреннего токена (защита от IDOR). Без `lrn` ученик — аккаунт."""
    account = _uuid_claim(principal.user_id)
    lrn = principal.claims.get("lrn")
    learner = _uuid_claim(lrn) if lrn not in (None, "") else account
    band = principal.claims.get("age_band")
    return Learner(user_id=learner, account_id=account, age_band=band if band in AGE_BANDS else None,
                   audience_hint=audience, locale_hint=locale)


def learner_ctx(request: Request, learner: Learner = Depends(current_learner)) -> Ctx:
    return Ctx(rt=request.app.state.runtime, catalog=catalog_of(request), settings=settings_of(request),
               now=now(request), learner=learner)


def idempotency_key(value: str | None) -> str:
    if value is None:
        raise ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key")
    if not _IDEMPOTENCY_RE.match(value):
        raise unprocessable("IDEMPOTENCY_KEY_INVALID",
                            "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)")
    return value


def staff_with_any(principal: Principal, *permissions: str) -> Actor:
    actor = principal.actor
    if actor is None:
        raise forbidden("STAFF_CONTEXT_REQUIRED", "Команда доступна только сотрудникам")
    if not any(p in actor.permissions for p in permissions):
        raise forbidden("PERMISSION_DENIED", "Недостаточно прав", {"permission": permissions[0]})
    return actor


async def scheduler_only(request: Request) -> str:
    """`Authorization: Bearer <SCHEDULER_TOKEN>` (n8n): сравнение за постоянное время; пустой токен в настройках
    выключает вход. Внутренний JWT сервиса → 403 CALLER_NOT_ALLOWED (вызывающий — только планировщик)."""
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
