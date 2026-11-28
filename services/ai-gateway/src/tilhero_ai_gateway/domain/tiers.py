"""Тариф ученика (спринт 8, INTERNAL_API §7): проекция `billing.access.changed.v1` (только издатель billing) в
`learner_tiers`. `paid` — tier paid и `paid_until` NULL или позже «сейчас»; нет строки — `free` (поведение до
спринта 8: бесплатный дневной лимит).

- Поздние события не откатывают тариф: строка обновляется, только если `changed_at` события не раньше записанного.
- Ученик, удалённый сагой (`deleted_users`), строки не получает.
- Тариф влияет на дневной лимит ученика (free — `learner_daily_cap_usd`, paid — `paid_learner_daily_cap_usd`) и на
  уровень `paid_only` (ученик free — `unavailable: degraded`).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Final

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_ai_gateway.models import BudgetRow, DeletedUser, LearnerTier

EVENT: Final = "billing.access.changed.v1"
PRODUCERS: Final = frozenset({"billing"})
PAID: Final = "paid"
FREE: Final = "free"


def _ts(value: Any) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


async def apply_access(session: AsyncSession, payload: dict[str, Any], now: datetime) -> bool:
    """billing.access.changed.v1 → learner_tiers (upsert по user_id, только более новое). → True — применено."""
    user_id = uuid.UUID(str(payload["user_id"]))
    if await session.get(DeletedUser, user_id) is not None:
        return False
    tier = PAID if payload.get("tier") == PAID else FREE
    paid_until = _ts(payload["paid_until"]) if payload.get("paid_until") else None
    changed_at = _ts(payload["changed_at"])
    ins = insert(LearnerTier).values(user_id=user_id, tier=tier, paid_until=paid_until, changed_at=changed_at,
                                     updated_at=now)
    upsert = ins.on_conflict_do_update(
        index_elements=[LearnerTier.user_id],
        set_={"tier": ins.excluded.tier, "paid_until": ins.excluded.paid_until,
              "changed_at": ins.excluded.changed_at, "updated_at": ins.excluded.updated_at},
        where=LearnerTier.changed_at <= ins.excluded.changed_at,
    ).returning(LearnerTier.user_id)
    return (await session.execute(upsert)).first() is not None


def is_paid_row(row: LearnerTier | None, now: datetime) -> bool:
    return row is not None and row.tier == PAID and (row.paid_until is None or row.paid_until > now)


async def is_paid(session: AsyncSession, user_id: uuid.UUID | None, now: datetime) -> bool:
    if user_id is None:
        return False
    row = (await session.execute(select(LearnerTier).where(LearnerTier.user_id == user_id))).scalar_one_or_none()
    return is_paid_row(row, now)


def daily_cap(budget: BudgetRow, paid: bool) -> Decimal:
    """Дневной лимит ученика по тарифу (В14): подписчик — paid_learner_daily_cap_usd, иначе learner_daily_cap_usd."""
    return Decimal(budget.paid_learner_daily_cap_usd if paid else budget.learner_daily_cap_usd)
