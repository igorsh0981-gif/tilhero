"""Общие зависимости API diagnostics: ученик из токена, часы, Idempotency-Key, пара, сегмент, catalog."""

from __future__ import annotations

import re
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import cast

from fastapi import Depends, Query, Request

from tilhero_common.errors import ApiError, unauthorized, unprocessable
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_diagnostics.catalog import CatalogGateway
from tilhero_diagnostics.domain.sessions import SeedFactory, default_seed
from tilhero_diagnostics.settings import Settings
from tilhero_diagnostics.testdef import PAIR_RE

# Вызывающие клиентского API (INTERNAL_API §2.5): только telegram-bff; sub = ученик (lrn сессии BFF)
client_auth = InternalAuth({"telegram-bff"})
# Admin API: только admin-bff с actor (права — в домене)
staff_auth = InternalAuth({"admin-bff"})

_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,128}$")


def settings_of(request: Request) -> Settings:
    return cast(Settings, request.app.state.runtime.settings)


def clock_of(request: Request) -> Callable[[], datetime]:
    """Часы сервиса (UTC). Тесты подменяют app.state.clock (окно 24 ч, повтор через 14 дней)."""
    return cast(Callable[[], datetime], getattr(request.app.state, "clock", None) or (lambda: datetime.now(UTC)))


def seed_factory_of(request: Request) -> SeedFactory:
    return cast(SeedFactory, getattr(request.app.state, "seed_factory", None) or default_seed)


def catalog_of(request: Request) -> CatalogGateway:
    return cast(CatalogGateway, request.app.state.catalog)


def current_user(principal: Principal = Depends(client_auth)) -> uuid.UUID:
    """user_id — только из внутреннего токена (CONVENTIONS §2, защита от IDOR)."""
    try:
        return uuid.UUID(principal.user_id)
    except ValueError:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from None


def pair_param(request: Request, pair_id: str | None = Query(default=None, max_length=16)) -> str:
    pair = pair_id or settings_of(request).default_pair_id
    if not PAIR_RE.match(pair):
        raise unprocessable("VALIDATION_ERROR", "Некорректная языковая пара",
                            {"errors": [{"loc": ["query", "pair_id"], "msg": "pair like ru-en", "type": "pattern"}]})
    return pair


def audience_param(audience: str | None = Query(
        default=None, pattern="^(kids|teens|adults)$",
        description="сегмент активного ученика от telegram-bff (kids 6–13, teens 14–17, adults 18+)")) -> str | None:
    return audience


def idempotency_key(value: str | None) -> str:
    if value is None:
        raise ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key")
    if not _IDEMPOTENCY_RE.match(value):
        raise unprocessable("IDEMPOTENCY_KEY_INVALID",
                            "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)")
    return value
