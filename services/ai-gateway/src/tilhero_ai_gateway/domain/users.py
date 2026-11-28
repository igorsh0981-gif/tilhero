"""Сага удаления ученика (INTERNAL_API §5): в ai-gateway только метаданные вызовов — usage.user_id обезличивается
(NULL), ACK `user.domain.deleted.v1 {domain: "ai-gateway", mode: "anonymized"}`. Кеш результатов вызовов ученика
(Redis, ≤ 24 ч, идемпотентность request_id) удаляется по индексу ключей ученика — после фиксации транзакции.
Спринт 8 (INTERNAL_API §7): тариф ученика (`learner_tiers`) удаляется, `session_costs.user_id` → NULL (стоимость
занятий остаётся обезличенной)."""

from __future__ import annotations

import uuid

from sqlalchemy import delete, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_ai_gateway.domain.common import DOMAIN_DELETED, PRODUCER
from tilhero_ai_gateway.models import DeletedUser, LearnerTier, SessionCost, UsageRow
from tilhero_common.messaging import emit


async def anonymize_user(session: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID,
                         causation_id: str | None) -> int:
    result = await session.execute(update(UsageRow).where(UsageRow.user_id == user_id).values(user_id=None)
                                   .execution_options(synchronize_session=False))
    await session.execute(delete(LearnerTier).where(LearnerTier.user_id == user_id))
    await session.execute(update(SessionCost).where(SessionCost.user_id == user_id).values(user_id=None)
                          .execution_options(synchronize_session=False))
    await session.execute(insert(DeletedUser).values(user_id=user_id, request_id=request_id)
                          .on_conflict_do_nothing(index_elements=["user_id"]))
    await emit(session, DOMAIN_DELETED, {"user_id": str(user_id), "request_id": str(request_id),
                                         "domain": "ai-gateway", "mode": "anonymized"},
               producer=PRODUCER, causation_id=causation_id)
    return int(getattr(result, "rowcount", 0) or 0)
