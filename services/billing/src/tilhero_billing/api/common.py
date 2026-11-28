"""Общие зависимости API billing: вызывающие (внутренний JWT), ученик и канал из токена, часы, Idempotency-Key,
права и step-up сотрудника, вход планировщика, доступ потоков B и G к порту платежей и адаптерам.

Для api/callbacks.py (поток B) и api/stars.py (поток G): `payments(request)` → PaymentService (PaymentPort +
record_call, recall/remember_pre_checkout), `adapter_for(request, code)` → адаптер провайдера, `stars_caller` —
только telegram-bot-gateway."""

from __future__ import annotations

import hmac
import logging
import re
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any, cast

from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.domain import adapters
from tilhero_billing.domain.common import AGE_BANDS, idempotency_reused, now_of, request_hash, step_up_required
from tilhero_billing.domain.learners import Caller
from tilhero_billing.domain.payments import PaymentService
from tilhero_billing.models import Idempotency
from tilhero_billing.providers.base import ProviderAdapter
from tilhero_billing.settings import Settings
from tilhero_common.errors import ApiError, forbidden, unauthorized, unprocessable
from tilhero_common.internal_auth import HEADER, Actor, InternalAuth, Principal

log = logging.getLogger("tilhero.billing.api")

# ученик и сайт — только telegram-bff (claim chn: miniapp | web)
client_auth = InternalAuth({"telegram-bff"})
# удержания и доступ — только lessons
lessons_auth = InternalAuth({"lessons"})
# платёжные обновления Telegram — только telegram-bot-gateway (поток G)
stars_caller = InternalAuth({"telegram-bot-gateway"})
# админка — только admin-bff с actor (права — в домене)
staff_auth = InternalAuth({"admin-bff"})
# вход планировщика: внутренний JWT любого сервиса → 403 CALLER_NOT_ALLOWED
no_service = InternalAuth(set())

_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,128}$")
STEP_UP_HEADER = "x-step-up"
CHANNELS = ("miniapp", "web")


def settings_of(request: Request) -> Settings:
    return cast(Settings, request.app.state.runtime.settings)


def now(request: Request) -> datetime:
    return now_of(request.app.state.runtime)


def payments(request: Request) -> PaymentService:
    return PaymentService(request.app.state.runtime)


def adapter_for(request: Request, code: str) -> ProviderAdapter:
    return adapters.of(request.app.state.runtime).get(code)


def _uuid_claim(value: object) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from None


def current_caller(principal: Principal = Depends(client_auth)) -> Caller:
    """sub — аккаунт, lrn — активный профиль (нет — аккаунт), age_band, chn — канал продаж (обязателен)."""
    account = _uuid_claim(principal.user_id)
    lrn = principal.claims.get("lrn")
    learner = _uuid_claim(lrn) if lrn not in (None, "") else account
    band = principal.claims.get("age_band")
    channel = principal.claims.get("chn")
    if channel not in CHANNELS:
        raise unauthorized("USER_CONTEXT_INVALID", "Нет канала продаж (chn) во внутреннем токене")
    return Caller(account_id=account, learner_id=learner, age_band=band if band in AGE_BANDS else None,
                  channel=str(channel))


def locale_of(request: Request) -> str:
    """Язык счёта и названий (Accept-Language от telegram-bff): uz — узбекский, иначе ru."""
    raw = (request.headers.get("accept-language") or "").strip().lower()
    return "uz" if raw.startswith("uz") else "ru"


def idempotency_key(value: str | None) -> str:
    if value is None:
        raise ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key")
    if not _IDEMPOTENCY_RE.match(value):
        raise unprocessable("IDEMPOTENCY_KEY_INVALID",
                            "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)")
    return value


def require(principal: Principal, permission: str, request: Request | None = None, *,
            step_up: bool = False) -> Actor:
    """Право сотрудника в домене; step-up — admin-bff проверил свежесть MFA и передал `X-Step-Up: ok` (или claim
    `step_up: true`)."""
    actor = principal.require_permission(permission)
    if step_up:
        header = (request.headers.get(STEP_UP_HEADER) if request is not None else None) or ""
        if header.strip().lower() != "ok" and principal.claims.get("step_up") is not True:
            raise step_up_required(permission)
    return actor


def require_any(principal: Principal, *permissions: str) -> Actor:
    actor = principal.actor
    if actor is None:
        raise forbidden("STAFF_CONTEXT_REQUIRED", "Команда доступна только сотрудникам")
    if not any(p in actor.permissions for p in permissions):
        raise forbidden("PERMISSION_DENIED", "Недостаточно прав", {"permission": permissions[0]})
    return actor


def require_staff(principal: Principal) -> Actor:
    if principal.actor is None:
        raise forbidden("STAFF_CONTEXT_REQUIRED", "Команда доступна только сотрудникам")
    return principal.actor


async def scheduler_only(request: Request) -> str:
    """`Authorization: Bearer <SCHEDULER_TOKEN>` (n8n): сравнение за постоянное время; пустой токен выключает вход.
    Внутренний JWT сервиса → 403 CALLER_NOT_ALLOWED."""
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


def page_limit(limit: int | None) -> int:
    return max(1, min(int(limit or 20), 100))


REPLAYED = {"Idempotent-Replayed": "true"}


async def recall(db: AsyncSession, actor: Actor, scope: str, key: str | None, body: Any) -> JSONResponse | None:
    """Повтор команды сотрудника с тем же Idempotency-Key — сохранённый ответ (тот же статус, заголовок
    Idempotent-Replayed); тот же ключ с другим телом — 422 IDEMPOTENCY_KEY_REUSED. Без ключа — None."""
    if key is None:
        return None
    k = idempotency_key(key)
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"bill:{scope}:{actor.id}:{k}"})
    prior = await db.get(Idempotency, (scope, actor.id[:80], k))
    if prior is None:
        return None
    if prior.request_hash != request_hash(body):
        raise idempotency_reused()
    return JSONResponse(prior.response, status_code=prior.status_code, headers=REPLAYED)


def remember(db: AsyncSession, actor: Actor, scope: str, key: str | None, body: Any, status: int,
             out: dict[str, Any], at: datetime) -> JSONResponse:
    if key is not None:
        db.add(Idempotency(scope=scope, actor=actor.id[:80], key=idempotency_key(key), request_hash=request_hash(body),
                           status_code=status, response=out, created_at=at))
    return JSONResponse(out, status_code=status)


async def staff_once(db: AsyncSession, actor: Actor, scope: str, key: str | None, body: Any,
                     run: Callable[[], Awaitable[dict[str, Any]]], at: datetime, status: int = 200) -> JSONResponse:
    """Команда сотрудника с необязательным Idempotency-Key (урок спринта 7: повтор после потерянного ответа — тот же
    ответ, а не 409/404). Ответ хранится в той же транзакции, что и изменение."""
    replay = await recall(db, actor, scope, key, body)
    if replay is not None:
        return replay
    return remember(db, actor, scope, key, body, status, await run(), at)
