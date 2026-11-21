"""Бюджеты ИИ (INTERNAL_API §1.1, §1.2; решение владельца 19.11.2026): потолок месяца (календарный месяц UTC), лимит
ученика в день (день — Asia/Tashkent), лимит урока (сумма по session_id) и стоимость вызова по таблице моделей.

Проверка — **до** вызова провайдера по оценке: вход ≈ символы/3 токенов, выход = max_output_tokens версии.
Резерв: вызов записывает в свою строку usage `reserved_usd` (оценка следующей попытки) под транзакционной
advisory-блокировкой бюджета — параллельные вызовы видят резервы друг друга и не перескакивают потолок.
Фактическая стоимость — по usage ответа провайдера (общая формула tilhero_common.ai_pricing, Decimal).
Оценка произношения (спринт 5) — ещё подлимит речи `speech_monthly_cap_usd` (календарный месяц UTC, расход агента
`pronunciation_coach`); вызовы агентов его не проверяют, но речь входит в общий потолок месяца.
Парная комната (спринт 7, INTERNAL_API §4): вызовы коуча `cooperative_lesson_coach` (`session_kind pair`,
`session_id = room_id`) — потолок комнаты `room_cap_usd` (сумма по session_id) и месячный потолок; дневной лимит
ученика и лимит урока к ним не применяются (коуча зовут за обоих участников).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import ROUND_CEILING, Decimal
from typing import Final

from sqlalchemy import ColumnElement, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_ai_gateway.domain.common import local_day_start, month_start
from tilhero_ai_gateway.models import BudgetRow, ModelRow, UsageRow
from tilhero_common.ai_pricing import UsageIn, cost, env_catalog

BUDGET_LOCK: Final = 811_401
SPEECH_AGENT: Final = "pronunciation_coach"
MTOK: Final = Decimal(1_000_000)
Q6: Final = Decimal("0.000001")
STALE_PENDING: Final = timedelta(minutes=10)
CHARS_PER_TOKEN: Final = 3


def estimate_cost(model: ModelRow, *, input_chars: int, max_output_tokens: int) -> Decimal:
    """Оценка худшего случая до вызова: ceil(символы/3) входных токенов + max_output_tokens выходных."""
    tokens_in = -(-max(input_chars, 0) // CHARS_PER_TOKEN)
    usd = (Decimal(tokens_in) * model.input_usd_per_mtok
           + Decimal(max_output_tokens) * model.output_usd_per_mtok) / MTOK
    return usd.quantize(Q6, rounding=ROUND_CEILING)


def actual_cost(model: ModelRow, input_tokens: int, output_tokens: int) -> Decimal:
    """Стоимость по usage ответа провайдера (ai_pricing: части HALF_UP до 0.000001)."""
    catalog = env_catalog(model.model_id, Decimal(model.input_usd_per_mtok), Decimal(model.output_usd_per_mtok))
    total = cost(UsageIn(model=model.model_id, tokens_in=max(input_tokens, 0), tokens_out=max(output_tokens, 0),
                         model_provider=model.provider), catalog).total_cost_usd
    return total if total is not None else Decimal(0)


@dataclass(frozen=True)
class Scope:
    """Чьи лимиты проверять: ученик и сессия (вызов урока) или только месяц (золотые тесты)."""

    call_id: uuid.UUID
    user_id: uuid.UUID | None
    session_id: uuid.UUID | None
    learner_limits: bool
    speech: bool = False  # оценка произношения: + подлимит речи в месяц
    room: bool = False  # коуч парной комнаты: потолок комнаты по session_id вместо лимитов ученика и урока


async def lock(session: AsyncSession) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, 0)"), {"c": BUDGET_LOCK})


async def expire_stale(session: AsyncSession, now: datetime) -> None:
    """Вызов, «зависший» в pending (рестарт процесса), снимает резерв: unavailable / provider_error."""
    await session.execute(
        update(UsageRow).where(UsageRow.status == "pending", UsageRow.created_at < now - STALE_PENDING)
        .values(status="unavailable", reason="provider_error", reserved_usd=0, finished_at=now)
        .execution_options(synchronize_session=False))


async def _spent(session: AsyncSession, *conditions: ColumnElement[bool]) -> Decimal:
    value = await session.scalar(select(func.coalesce(func.sum(UsageRow.cost_usd + UsageRow.reserved_usd), 0))
                                 .where(*conditions))
    return Decimal(value or 0)


async def try_reserve(session: AsyncSession, budget: BudgetRow, scope: Scope, *, actual: Decimal, estimate: Decimal,
                      now: datetime, tz: str) -> bool:
    """Хватает ли бюджета на следующую попытку (уже потрачено этим вызовом + оценка). Да — резерв записан."""
    await lock(session)
    await expire_stale(session, now)
    need = actual + estimate
    others = UsageRow.call_id != scope.call_id
    if await _spent(session, others, UsageRow.created_at >= month_start(now)) + need > budget.monthly_cap_usd:
        return False
    if scope.speech and await _spent(session, others, UsageRow.agent_id == SPEECH_AGENT,
                                     UsageRow.created_at >= month_start(now)) + need > budget.speech_monthly_cap_usd:
        return False
    if scope.room:
        if scope.session_id is not None and await _spent(
                session, others, UsageRow.session_id == scope.session_id) + need > budget.room_cap_usd:
            return False
    elif scope.learner_limits:
        if scope.user_id is not None and await _spent(
                session, others, UsageRow.user_id == scope.user_id,
                UsageRow.created_at >= local_day_start(now, tz)) + need > budget.learner_daily_cap_usd:
            return False
        if scope.session_id is not None and await _spent(
                session, others, UsageRow.session_id == scope.session_id) + need > budget.lesson_cap_usd:
            return False
    await session.execute(update(UsageRow).where(UsageRow.call_id == scope.call_id)
                          .values(cost_usd=actual, reserved_usd=estimate)
                          .execution_options(synchronize_session=False))
    return True


async def month_spent(session: AsyncSession, now: datetime) -> Decimal:
    return await _spent(session, UsageRow.created_at >= month_start(now))


async def speech_month_spent(session: AsyncSession, now: datetime) -> Decimal:
    """Расход оценки произношения за календарный месяц UTC (с резервами идущих вызовов)."""
    return await _spent(session, UsageRow.agent_id == SPEECH_AGENT, UsageRow.created_at >= month_start(now))
