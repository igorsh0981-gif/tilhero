"""Общие зависимости API gamification: ученик из токена, ход, часы, Idempotency-Key, step-up, планировщик."""

from __future__ import annotations

import hmac
import logging
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast

from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, forbidden, unauthorized, unprocessable
from tilhero_common.internal_auth import HEADER, Actor, InternalAuth, Principal
from tilhero_gamification.domain.common import (
    AGE_BANDS,
    idempotency_reused,
    request_hash,
    step_up_required,
    user_deleted,
)
from tilhero_gamification.domain.engine import Turn, open_turn
from tilhero_gamification.domain.rules import active_rules
from tilhero_gamification.models import Idempotency, Learner, Quest, Wallet
from tilhero_gamification.settings import Settings

log = logging.getLogger("tilhero.gamification.api")

# Ученик (§0): только telegram-bff; sub = аккаунт, claim lrn = активный ученик, age_band — его полоса
client_auth = InternalAuth({"telegram-bff"})
# Админ-API: только admin-bff с actor (права — в домене)
staff_auth = InternalAuth({"admin-bff"})
# Вход планировщика: внутренний JWT любого сервиса → 403 CALLER_NOT_ALLOWED
no_service = InternalAuth(set())

_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,128}$")
STEP_UP_HEADER = "x-step-up"


def settings_of(request: Request) -> Settings:
    return cast(Settings, request.app.state.runtime.settings)


def now(request: Request) -> datetime:
    """Часы сервиса (UTC): тесты подменяют `runtime.clock`."""
    clock = getattr(request.app.state.runtime, "clock", None)
    return clock() if callable(clock) else datetime.now(UTC)


def _uuid_claim(value: object) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from None


@dataclass(frozen=True)
class LearnerRef:
    user_id: uuid.UUID  # lrn — активный ученик (кошелёк, герой, задания и значки — у него)
    account_id: uuid.UUID  # sub — аккаунт Telegram
    age_band: str | None

    @property
    def child_profile(self) -> bool:
        return self.user_id != self.account_id


def current_learner(principal: Principal = Depends(client_auth)) -> LearnerRef:
    """Ученик — только из внутреннего токена (защита от IDOR). Без `lrn` ученик — аккаунт."""
    account = _uuid_claim(principal.user_id)
    lrn = principal.claims.get("lrn")
    learner = _uuid_claim(lrn) if lrn not in (None, "") else account
    band = principal.claims.get("age_band")
    return LearnerRef(user_id=learner, account_id=account, age_band=band if band in AGE_BANDS else None)


async def learner_turn(db: AsyncSession, request: Request, ref: LearnerRef) -> Turn:
    """Ход ученика: проекция возраста из claims (детский профиль — kids), блокировка, кошелёк, правила."""
    turn = await open_turn(db, settings_of(request), now(request), ref.user_id,
                           account_id=ref.account_id,
                           kind="child" if ref.child_profile else None, age_band=ref.age_band)
    if turn is None:
        raise user_deleted()
    return turn


def _projection_stale(learner: Learner, ref: LearnerRef) -> bool:
    """Claims токена расходятся с проекцией ученика — нужен пишущий ход (обновить возраст и вид профиля)."""
    return ((ref.age_band is not None and learner.age_band != ref.age_band)
            or (ref.child_profile and learner.kind != "child") or learner.account_id is None)


async def learner_read(db: AsyncSession, request: Request, ref: LearnerRef, *, quests: bool = False) -> Turn:
    """Ход только для чтения: без блокировки ученика, без FOR UPDATE кошелька и без записи learners. Пишущий ход
    (learner_turn) — только когда нужно создать ученика, выдать бонус регистрации, обновить проекцию из claims или
    выпустить задания дня (quests=True: ещё нет заданий на сегодня и они не скрыты)."""
    learner = await db.get(Learner, ref.user_id)
    if learner is None or _projection_stale(learner, ref) or learner.registration_bonus_at is None:
        return await learner_turn(db, request, ref)
    wallet = await db.get(Wallet, ref.user_id)
    if wallet is None:  # кошелька ещё нет — нули (не добавляется в сессию: чтение ничего не пишет)
        wallet = Wallet(user_id=ref.user_id, xp_total=0, til_balance=0, freeze_stock=0, level=1,
                        updated_at=now(request))
    turn = Turn(session=db, settings=settings_of(request), now=now(request), learner=learner, wallet=wallet,
                rules=await active_rules(db))
    if quests and not learner.quests_hidden:
        issued = await db.scalar(select(func.count()).select_from(Quest).where(
            Quest.user_id == ref.user_id, Quest.local_date == turn.today, Quest.slot >= 1))
        if not issued:
            return await learner_turn(db, request, ref)
    return turn


def idempotency_key(value: str | None) -> str:
    if value is None:
        raise ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key")
    if not _IDEMPOTENCY_RE.match(value):
        raise unprocessable("IDEMPOTENCY_KEY_INVALID",
                            "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)")
    return value


def require(principal: Principal, permission: str, request: Request | None = None, *,
            step_up: bool = False) -> Actor:
    """Право сотрудника в домене (защита в глубину); step-up — admin-bff проверил свежесть MFA и передал
    `X-Step-Up: ok` (или claim `step_up: true` во внутреннем токене)."""
    actor = principal.require_permission(permission)
    if step_up:
        header = (request.headers.get(STEP_UP_HEADER) if request is not None else None) or ""
        if header.strip().lower() != "ok" and principal.claims.get("step_up") is not True:
            raise step_up_required(permission)
    return actor


def require_any(principal: Principal, *permissions: str) -> Actor:
    """Любое из прав (обзор: game.read или dashboard.read — данные обезличены)."""
    actor = principal.actor
    if actor is None:
        raise forbidden("STAFF_CONTEXT_REQUIRED", "Команда доступна только сотрудникам")
    if not any(p in actor.permissions for p in permissions):
        raise forbidden("PERMISSION_DENIED", "Недостаточно прав", {"permission": permissions[0]})
    return actor


async def staff_idempotent(db: AsyncSession, actor: Actor, scope: str, key: str, body: Any,
                           run: Callable[[], Awaitable[tuple[int, dict[str, Any]]]]) -> JSONResponse:
    """Idempotency-Key команды сотрудника: повтор того же сотрудника с тем же ключом — тот же ответ без новой
    записи и аудита; тот же ключ с другим телом — 422 IDEMPOTENCY_KEY_REUSED."""
    h = request_hash(body)
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"gam:{scope}:{actor.id}:{key}"})
    prior = await db.get(Idempotency, (scope, actor.id[:80], key))
    if prior is not None:
        if prior.request_hash != h:
            raise idempotency_reused()
        return JSONResponse(prior.response, status_code=200)
    status, out = await run()
    db.add(Idempotency(scope=scope, actor=actor.id[:80], key=key, request_hash=h, status_code=status, response=out,
                       created_at=await db.scalar(select(func.now()))))
    return JSONResponse(out, status_code=status)


async def scheduler_only(request: Request) -> str:
    """`Authorization: Bearer <SCHEDULER_TOKEN>` (n8n): сравнение за постоянное время; пустой токен выключает
    вход. Внутренний JWT сервиса → 403 CALLER_NOT_ALLOWED (вызывающий — только планировщик)."""
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
