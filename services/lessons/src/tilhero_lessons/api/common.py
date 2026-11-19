"""Общие зависимости API lessons: ученик и аккаунт из токена, часы, catalog, Idempotency-Key, планировщик."""

from __future__ import annotations

import hmac
import logging
import re
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import cast

from fastapi import Depends, Query, Request

from tilhero_common.errors import ApiError, unauthorized, unprocessable
from tilhero_common.internal_auth import HEADER, InternalAuth, Principal
from tilhero_lessons.catalog import CatalogGateway
from tilhero_lessons.domain.sessions import Ctx, SeedFactory, default_seed
from tilhero_lessons.domain.users import AGE_BANDS, Learner
from tilhero_lessons.settings import Settings

log = logging.getLogger("tilhero.lessons.api")

# Ученик (INTERNAL_API §2.4): только telegram-bff; sub = аккаунт, claim lrn = активный ученик, age_band
client_auth = InternalAuth({"telegram-bff"})
# Admin API: только admin-bff с actor (права — в домене)
staff_auth = InternalAuth({"admin-bff"})
# Вход планировщика: внутренний JWT любого сервиса → 403 CALLER_NOT_ALLOWED
no_service = InternalAuth(set())

_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,128}$")
PAIR_PATTERN = r"^[a-z]{2,8}-[a-z]{2,8}$"
CONTENT_ID = r"^[a-z0-9][a-z0-9._-]{1,63}$"


def settings_of(request: Request) -> Settings:
    return cast(Settings, request.app.state.runtime.settings)


def clock_of(request: Request) -> Callable[[], datetime]:
    """Часы сервиса (UTC). Тесты подменяют app.state.clock (бездействие, 72 ч, 90 дней)."""
    return cast(Callable[[], datetime], getattr(request.app.state, "clock", None) or (lambda: datetime.now(UTC)))


def catalog_of(request: Request) -> CatalogGateway:
    return cast(CatalogGateway, request.app.state.catalog)


def _uuid_claim(value: object) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from None


def current_learner(principal: Principal = Depends(client_auth)) -> Learner:
    """Ученик — `lrn` (активный ученик), аккаунт — `sub`; только из внутреннего токена (защита от IDOR).
    Без `lrn` ученик — сам аккаунт."""
    account = _uuid_claim(principal.user_id)
    lrn = principal.claims.get("lrn")
    learner = _uuid_claim(lrn) if lrn not in (None, "") else account
    band = principal.claims.get("age_band")
    return Learner(user_id=learner, account_id=account, age_band=band if band in AGE_BANDS else None)


def make_ctx(request: Request, learner: Learner) -> Ctx:
    seed = cast(SeedFactory, getattr(request.app.state, "seed_factory", None) or default_seed)
    return Ctx(rt=request.app.state.runtime, catalog=catalog_of(request), settings=settings_of(request),
               now=clock_of(request)(), learner=learner, seed_factory=seed)


def learner_ctx(request: Request, learner: Learner = Depends(current_learner)) -> Ctx:
    return make_ctx(request, learner)


def pair_param(request: Request, pair_id: str | None = Query(default=None, max_length=17,
                                                            pattern=PAIR_PATTERN)) -> str:
    return pair_id or settings_of(request).default_pair_id


def audience_param(audience: str | None = Query(
        default=None, pattern="^(kids|teens|adults)$",
        description="сегмент активного ученика от telegram-bff; детский профиль не понижается")) -> str | None:
    return audience


def locale_param(locale: str = Query(default="ru", pattern="^(ru|uz)$",
                                     description="язык объяснений и вариантов проверки понимания")) -> str:
    return locale


def idempotency_key(value: str | None) -> str:
    if value is None:
        raise ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key")
    if not _IDEMPOTENCY_RE.match(value):
        raise unprocessable("IDEMPOTENCY_KEY_INVALID",
                            "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)")
    return value


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
