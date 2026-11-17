"""SLA: политика по категории/приоритету и вычисляемое состояние таймера.

Таймер идёт, пока обращение на стороне поддержки (NEW, IN_PROGRESS):
  - до первого ответа оператора — цель «first_response» (sla_first_response_at);
  - после — цель «resolution» (sla_resolution_at).
WAITING_CUSTOMER — пауза (мяч у клиента), RESOLVED/CLOSED — выполнено; для них sla_state = ok.
sla_state: breached — срок прошёл; soon — осталось меньше `soon_minutes` (30 мин); ok — иначе.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy import ColumnElement, and_, case, not_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_support.domain.constants import ANY_CATEGORY, SLA_RUNNING_STATUSES, WAITING_CUSTOMER
from tilhero_support.models import SlaPolicy, Ticket

# Запасные значения, если таблицу политик очистили вручную (минуты: первый ответ, решение)
FALLBACK_POLICY: dict[str, tuple[int, int]] = {
    "low": (480, 4320),
    "normal": (120, 1440),
    "high": (60, 480),
    "urgent": (30, 240),
}

SlaState = Literal["breached", "soon", "ok"]
SlaTarget = Literal["first_response", "resolution"]


async def resolve_policy(session: AsyncSession, category: str, priority: str) -> tuple[int, int]:
    """Точная пара (категория, приоритет) важнее общей ('*', приоритет)."""
    rows = (
        (
            await session.execute(
                select(SlaPolicy).where(
                    SlaPolicy.priority == priority, SlaPolicy.category.in_((category, ANY_CATEGORY))
                )
            )
        )
        .scalars()
        .all()
    )
    exact = next((r for r in rows if r.category == category), None)
    chosen = exact or next((r for r in rows if r.category == ANY_CATEGORY), None)
    if chosen is None:
        return FALLBACK_POLICY.get(priority, FALLBACK_POLICY["normal"])
    return chosen.first_response_minutes, chosen.resolution_minutes


def deadlines(created_at: datetime, policy: tuple[int, int]) -> tuple[datetime, datetime]:
    first, resolution = policy
    return created_at + timedelta(minutes=first), created_at + timedelta(minutes=resolution)


@dataclass(frozen=True)
class SlaView:
    target: SlaTarget | None
    due_at: datetime | None
    state: SlaState
    paused: bool


def sla_view(ticket: Ticket, now: datetime, soon_minutes: int = 30) -> SlaView:
    if ticket.status not in SLA_RUNNING_STATUSES:
        return SlaView(target=None, due_at=None, state="ok", paused=ticket.status == WAITING_CUSTOMER)
    if ticket.first_response_at is None:
        target, due = "first_response", ticket.sla_first_response_at
    else:
        target, due = "resolution", ticket.sla_resolution_at
    if due <= now:
        state: SlaState = "breached"
    elif due - now < timedelta(minutes=soon_minutes):
        state = "soon"
    else:
        state = "ok"
    return SlaView(target=target, due_at=due, state=state, paused=False)  # type: ignore[arg-type]


# ---- SQL-выражения тех же правил (фильтр и сортировка очереди) ----


def due_expr() -> ColumnElement:
    return case(
        (Ticket.first_response_at.is_(None), Ticket.sla_first_response_at),
        else_=Ticket.sla_resolution_at,
    )


def running_expr() -> ColumnElement:
    return Ticket.status.in_(SLA_RUNNING_STATUSES)


def rank_expr() -> ColumnElement:
    """0 — таймер идёт (наверх очереди), 1 — пауза/выполнено."""
    return case((running_expr(), 0), else_=1)


def sla_filter(state: SlaState, now: datetime, soon_minutes: int = 30) -> ColumnElement:
    soon_edge = now + timedelta(minutes=soon_minutes)
    if state == "breached":
        return and_(running_expr(), due_expr() <= now)
    if state == "soon":
        return and_(running_expr(), due_expr() > now, due_expr() < soon_edge)
    return not_(and_(running_expr(), due_expr() < soon_edge))
